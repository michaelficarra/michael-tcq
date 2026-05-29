# Deploying TCQ

TCQ is deployed as Docker containers on a Google Compute Engine VM running Container-Optimized OS (COS), with Caddy in front of it for automatic HTTPS and Firestore for persistent storage. See [ARCHITECTURE.md](ARCHITECTURE.md) for the rationale behind these choices.

The architecture is chosen to be as hands-off as a self-hosted setup gets:

- **COS** auto-updates the OS and Docker on a managed schedule. No package manager, no SSH-driven OS patches.
- **Caddy** runs as a Docker container in front of TCQ and obtains a Let's Encrypt certificate for the configured domain automatically. Renewals happen on its own; nothing to remember.
- **systemd** units (one per container) restart automatically on crash and on boot — including after COS auto-update reboots — so the only manual recovery scenario is a VM-wide failure.
- **Cloud Logging** picks up container stdout/stderr via the COS-built-in fluent-bit forwarding, activated by the `google-logging-enabled=true` instance metadata flag. The structured JSON logs the server already emits show up as queryable LogEntry records — same operator experience as on Cloud Run.
- **Cloud Monitoring** picks up VM metrics the same way via `google-monitoring-enabled=true`.

Deployment is driven by `scripts/deploy.sh`. The script is self-bootstrapping: on first run it walks you through GCP setup interactively (installing `gcloud` if needed, creating the project, linking billing, provisioning Firestore, the service account, the Artifact Registry repo, the static IP, the firewall rule, and the VM, writing `.env.production`). On subsequent runs it builds the image, pushes it to Artifact Registry, copies a fresh env file to the VM via `gcloud compute scp`, and restarts the `tcq` systemd unit.

## Environment Files

TCQ uses environment-specific `.env` files:

| File               | Purpose                                 | Committed to git? |
| ------------------ | --------------------------------------- | ----------------- |
| `.env.development` | Local development defaults (no secrets) | Yes               |
| `.env.production`  | Production config and secrets           | No (gitignored)   |

The server loads `.env.development` or `.env.production` based on `NODE_ENV`. In development (`npm run dev`), `NODE_ENV` is unset so `.env.development` is used. On the VM, the systemd unit passes `NODE_ENV=production` and the rest of the server config via `--env-file=/etc/tcq/env`, which `scripts/deploy.sh` writes (and rewrites on every deploy).

`.env.production` on your local machine is written by `scripts/deploy.sh` on the recommended path below — you don't need to hand-author it unless you're following the manual path.

## Prerequisites

- A [Google Cloud](https://cloud.google.com/) account.
- A domain name you can point at the VM via an A record. **Required** — Caddy uses it to obtain a TLS certificate; the deploy can't complete without one. The script asks for it up front and will let you set up DNS while it provisions; HTTPS starts working once both DNS and the VM are in place.
- [Docker](https://docs.docker.com/get-docker/) installed locally.
- The [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) (`gcloud`) — the deploy script offers to install it if it's missing.
- A clean git working tree — the deploy script refuses to run with uncommitted or untracked changes, since the deployed image is always tagged `:latest` and a dirty deploy leaves no record of what actually shipped. Commit or stash before running.

## First-Time Setup (Recommended)

1. Run `gcloud auth login` (the deploy script will tell you to do this if you haven't).
2. Run `./scripts/deploy.sh`.

The script will:

- Offer to install `gcloud` via Homebrew (if available) or the official tarball, when it isn't already on your PATH.
- Prompt for the values it needs — GCP project ID, region/zone, VM name, custom domain, admin GitHub usernames.
- Let you pick a billing account from a menu of those attached to your gcloud account.
- Create the GCP project (if new), link billing, enable the required APIs, create the Firestore database, the VM service account (with the right IAM bindings), and the Artifact Registry repository.
- Reserve a static external IP, create a firewall rule for tcp:80 and tcp:443.
- Generate `SESSION_SECRET` and write everything collected so far to `.env.production`.
- Build the Docker image, push it, provision the VM with cloud-init that installs both systemd units (`tcq` and `caddy`) on first boot, copy a fresh env file to the VM via `gcloud compute scp`, and restart the `tcq` unit.
- Print the static IP so you can configure your DNS A record.
- Once the first deploy finishes, print a pre-filled GitHub OAuth App registration URL. Click it, hit **Register application**, copy the Client ID and Client Secret back into the prompt, and the script copies the new env to the VM and restarts.
- Then offer the same for **ORCID**, **Google**, and **Microsoft**: none has a pre-fillable form, so the script prints the registration URL (ORCID developer tools / Google Cloud credentials page / Microsoft Entra app registrations) and the exact redirect URI to register, then accepts the Client ID and Client Secret at the prompt. Skipping any provider just leaves it disabled, and the script records the choice by writing that provider's `CLIENT_ID`/`CLIENT_SECRET` to `.env.production` as empty lines — so later runs won't re-prompt for it. (Delete those empty lines to be asked again.) All prompts are skipped on later runs once a provider's keys are either populated or present-but-empty in `.env.production`.

Every step is idempotent. Re-running the script with a fully populated `.env.production` skips every prompt and behaves as a plain build + push + redeploy.

## First-Time Setup (Manual)

If you'd rather provision by hand — for learning purposes, or because you want finer control than the script offers — follow these steps. Each one explains _why_ it exists so you can skip or vary it sensibly.

### 1. Create a GCP project

_Why:_ every GCP resource (Firestore, Compute Engine, Artifact Registry) lives inside a project. This also becomes the active context for the rest of the `gcloud` calls below.

```sh
gcloud projects create <your-project-id> --name="TCQ"
gcloud config set project <your-project-id>
```

### 2. Link a billing account

_Why:_ Compute Engine, Artifact Registry, and Firestore all require a billing account attached, even though TCQ on an `e2-micro` fits comfortably inside the always-free tier (744 hours/month per region in `us-east1`, `us-central1`, or `us-west1`).

```sh
gcloud billing accounts list --filter=open=true
gcloud billing projects link <your-project-id> --billing-account=<account-id>
```

### 3. Enable required APIs

_Why:_ each of these is disabled by default on new projects; using them before they're enabled returns a 403.

```sh
gcloud services enable \
  compute.googleapis.com \
  firestore.googleapis.com \
  artifactregistry.googleapis.com \
  logging.googleapis.com \
  monitoring.googleapis.com
```

### 4. Create a Firestore database

_Why:_ Firestore holds persistent meeting state. Use a free-tier eligible region: `us-east1`, `us-central1`, or `us-west1`. Keep the VM in the same region for low-latency reads and to avoid cross-region egress charges.

```sh
gcloud firestore databases create --location=us-central1
```

Or with a custom database ID:

```sh
gcloud firestore databases create --location=us-central1 --database=<your-database-id>
```

### 5. Enable a TTL policy on the `sessions` collection

_Why:_ The session store writes one document per login. Without TTL, the `sessions` collection grows unboundedly. The server populates a top-level `expireAt` `Timestamp` (cookie expiry + 24h) on every session write; this policy tells Firestore to delete documents whose `expireAt` is in the past.

```sh
gcloud firestore fields ttls update expireAt \
  --collection-group=sessions \
  --enable-ttl
```

If you used a custom database ID in step 4, add `--database=<your-database-id>`.

### 6. Create a service account for the VM

_Why:_ the VM needs an identity that can read Firestore, pull container images from Artifact Registry, and write to Cloud Logging and Monitoring without shipping a key file. The first four bindings grant those; the last grants the deploying user the right to attach this service account to the VM.

```sh
gcloud iam service-accounts create tcq-vm --display-name="TCQ VM"

for role in \
    roles/datastore.user \
    roles/artifactregistry.reader \
    roles/logging.logWriter \
    roles/monitoring.metricWriter; do
  gcloud projects add-iam-policy-binding <your-project-id> \
    --member="serviceAccount:tcq-vm@<your-project-id>.iam.gserviceaccount.com" \
    --role="$role"
done

gcloud projects add-iam-policy-binding <your-project-id> \
  --member="user:$(gcloud config get account)" \
  --role="roles/iam.serviceAccountUser"
```

### 7. Create an Artifact Registry repository

_Why:_ the VM pulls the TCQ image from somewhere; Artifact Registry is Google's first-party Docker registry. The second command registers a Docker credential helper so `docker push` from your local machine can authenticate.

```sh
gcloud artifacts repositories create tcq --repository-format=docker --location=us-central1
gcloud auth configure-docker us-central1-docker.pkg.dev
```

### 8. Reserve a static external IP

_Why:_ a static IP keeps the VM's address stable across stop/start cycles and reboots — important because your DNS A record points at it. The IP is free while attached to a running VM.

```sh
gcloud compute addresses create tcq-ip --region=us-central1
gcloud compute addresses describe tcq-ip --region=us-central1 --format='value(address)'
```

Note the address — it's what your DNS A record will point at.

### 9. Create a firewall rule

_Why:_ Compute Engine VMs have an implicit-deny firewall by default. The rule below opens tcp:80 (Let's Encrypt HTTP-01 validation, plus the redirect Caddy serves) and tcp:443 (HTTPS) only on VMs tagged `tcq-server`.

```sh
gcloud compute firewall-rules create tcq-allow-http-https \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=tcp:80,tcp:443 \
  --source-ranges=0.0.0.0/0 \
  --target-tags=tcq-server
```

This VPC rule alone is **not** sufficient: Container-Optimized OS also runs a host-level firewall (`iptables` with a default-deny INPUT chain that permits only SSH, ICMP, and established connections), so the VM itself drops inbound 80/443 even after the VPC rule allows them. The cloud-init in the next step installs a `tcq-firewall` systemd unit that opens those ports at the host on every boot — see step 11 and the "Configuration Notes" below.

### 10. Write `.env.production`

_Why:_ `scripts/deploy.sh` reads every value it needs from this file. The `GITHUB_*` fields come later — they depend on the domain URL, which has to resolve before Caddy can issue a certificate.

Create `.env.production` in the project root:

```
# Production environment
ADMIN_USERNAMES=your-github-username

# Persistence
STORE=firestore
FIRESTORE_DATABASE_ID=<your-database-id>    # omit if using (default)

# Session
SESSION_SECRET=<random-secret>

# Deployment
GCP_PROJECT_ID=<your-project-id>
GCP_REGION=us-central1
GCP_ZONE=us-central1-a
GCP_SERVICE_ACCOUNT=tcq-vm@<your-project-id>.iam.gserviceaccount.com
VM_NAME=tcq
CUSTOM_DOMAIN=<your-domain>
```

> **Premium tier** is no longer configured via an environment variable. Admins manage the premium-user list from the **Premium Users** section of the home-page Admin tab once the service is running; the list is persisted in Firestore (`app-settings/singleton`) and survives restarts. On a fresh deploy the list starts empty — an admin must repopulate it via the Admin tab.

Generate a random session secret with:

```sh
head -c 32 /dev/urandom | base64 | tr -d '=/+' | head -c 40
```

### 11. Provision the VM

_Why:_ this creates the e2-micro VM running Container-Optimized OS, attaches the static IP, applies the `tcq-server` tag (so the firewall rule lets traffic through), and runs cloud-init on first boot to install three systemd units (`tcq`, `caddy`, and `tcq-firewall`) and the Caddyfile. The `tcq-firewall` unit opens 80/443 on the COS host firewall on every boot (the VPC rule from step 9 only gets traffic to the VM; without this unit the host drops it). The `google-logging-enabled` and `google-monitoring-enabled` metadata flags wire up Cloud Logging and Cloud Monitoring with no agent install.

The simplest path is to let `scripts/deploy.sh` do this — it generates the cloud-init from your `.env.production` and runs the right `gcloud compute instances create` invocation. The manual equivalent is to copy that command out of the script after a first run.

### 12. Configure DNS

_Why:_ Caddy needs DNS to resolve before it can complete the Let's Encrypt HTTP-01 challenge. The VM's `caddy` container retries until both ports are open and DNS is correct, so the order of "create VM" / "set up DNS" doesn't matter.

In your DNS provider, add an A record:

```
<your-domain>  →  <static-ip-from-step-8>
```

If you also want the apex domain or a different subdomain to work, add an A record for each.

### 13. First deploy (without OAuth)

_Why:_ GitHub OAuth needs the domain URL, which doesn't really work until the certificate is issued. Deploy once to confirm the TLS/reverse-proxy plumbing before wiring up auth.

```sh
./scripts/deploy.sh
```

The script warns that no OAuth provider is configured. Note that **mock auth does not run in production** — it's gated on a non-production environment so a misconfigured production deploy fails closed instead of auto-logging everyone in as an admin. The container sets `NODE_ENV=production`, so with no provider configured the login page will simply offer no way in. That's expected at this stage: visit `https://<your-domain>` to confirm Caddy has a valid cert and the TCQ login page renders. You'll be able to actually log in once you complete the OAuth steps below.

### 14. Register a GitHub OAuth App

_Why:_ this is the one step that can't be automated — GitHub's API doesn't expose OAuth App creation.

Open a pre-filled registration form (substitute your domain):

```
https://github.com/settings/applications/new?oauth_application%5Bname%5D=TCQ&oauth_application%5Burl%5D=https%3A%2F%2F<your-domain>&oauth_application%5Bcallback_url%5D=https%3A%2F%2F<your-domain>%2Fauth%2Fgithub%2Fcallback
```

Click **Register application**, then generate a **Client Secret**. Note the **Client ID** and **Client Secret**.

If the pre-fill link doesn't work for you, register manually at [GitHub Developer Settings > OAuth Apps](https://github.com/settings/developers) with:

- **Application name:** `TCQ`
- **Homepage URL:** `https://<your-domain>`
- **Authorization callback URL:** `https://<your-domain>/auth/github/callback`

### 14b. (Optional) Register an ORCID public-API client

_Why:_ enables "Sign in with ORCID". In your ORCID account → **Developer tools**, register a
**public API** client (free; requires a verified email). Set the redirect URI to
`https://<your-domain>/auth/orcid/callback`. Note the **Client ID** and **Client Secret**.
For testing, register a separate client on the [ORCID Sandbox](https://sandbox.orcid.org) and
set `ORCID_BASE_URL=https://sandbox.orcid.org`.

### 14c. (Optional) Register a Discord OAuth application

_Why:_ enables "Sign in with Discord". Open the
[Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
In the **OAuth2** section, note the **Client ID** and copy the **Client Secret**, then under
**OAuth2 → Redirects** add `https://<your-domain>/auth/discord/callback` exactly. Only the
`identify` scope is used (the email is not requested).

### 14d. (Optional) Register a Google OAuth client

_Why:_ enables "Sign in with Google". Open
[Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
(configure the OAuth consent screen first if prompted), then **Create Credentials → OAuth
client ID → Application type: Web application**. Under **Authorised redirect URIs** add
`https://<your-domain>/auth/google/callback` exactly. Note the **Client ID** and **Client
Secret**. Only the OpenID Connect `openid email profile` scopes are used — no extra APIs to
enable.

### 14e. (Optional) Register a Microsoft (Entra ID) OAuth client

_Why:_ enables "Sign in with Microsoft". Open the
[Microsoft Entra admin centre](https://entra.microsoft.com) → **Identity → Applications →
App registrations → New registration**. For supported account types choose **"Accounts in any
organizational directory and personal Microsoft accounts"** (matches the default `common`
tenant). Add a **Web** platform with redirect URI `https://<your-domain>/auth/microsoft/callback`
exactly, then under **Certificates & secrets** add a client secret. Note the **Application
(client) ID** and the secret **value**. Only the OpenID Connect `openid email profile` scopes
are used. To restrict sign-in to a single tenant, set `MICROSOFT_TENANT` to your tenant id and
pick the matching account type.

### 15. Redeploy with OAuth

_Why:_ the server reads provider credentials at boot, so they have to be in the env file the systemd unit passes to the container. The deploy script rewrites `/etc/tcq/env` and restarts the unit on every run.

Add to `.env.production` (omit a provider's block, or leave both its keys empty, to keep it disabled — the deploy script writes the keys empty for any provider you decline at the prompt, and treats empty keys as "deliberately disabled, don't ask again"; delete those empty lines to be re-prompted):

```
# GitHub OAuth
GITHUB_CLIENT_ID=<client-id>
GITHUB_CLIENT_SECRET=<client-secret>

# ORCID OAuth (optional)
ORCID_CLIENT_ID=<client-id>
ORCID_CLIENT_SECRET=<client-secret>
# ORCID_BASE_URL defaults to https://orcid.org; set to the sandbox for testing.

# Discord OAuth (optional)
DISCORD_CLIENT_ID=<client-id>
DISCORD_CLIENT_SECRET=<client-secret>

# Google OAuth (optional)
GOOGLE_CLIENT_ID=<client-id>
GOOGLE_CLIENT_SECRET=<client-secret>

# Microsoft OAuth (optional)
MICROSOFT_CLIENT_ID=<client-id>
MICROSOFT_CLIENT_SECRET=<client-secret>
# MICROSOFT_TENANT defaults to "common"; set a tenant id to restrict sign-in.

# OAuth callback base — each provider's callback is ${base}/<provider>/callback,
# so GitHub's is https://<your-domain>/auth/github/callback, ORCID's is
# https://<your-domain>/auth/orcid/callback, Discord's is
# https://<your-domain>/auth/discord/callback, Google's is
# https://<your-domain>/auth/google/callback, and Microsoft's is
# https://<your-domain>/auth/microsoft/callback (register those with each provider).
# Defaults to http://localhost:3000/auth in dev.
OAUTH_CALLBACK_BASE_URL=https://<your-domain>/auth
```

Then redeploy:

```sh
./scripts/deploy.sh
```

The server will now use real GitHub authentication.

## Subsequent Deploys

After the initial setup, deploying is a single command:

```sh
./scripts/deploy.sh
```

The script reads all configuration from `.env.production`, builds the image, pushes it, copies a fresh env file to the VM, and restarts the `tcq` unit. Caddy doesn't need touching unless you change the domain — its config is in the cloud-init that ran at VM creation.

## Deploying from a Different Machine

The deploy script is self-contained, but a few pieces of state live outside the repo. Once an initial deploy has been done from one machine, here's what a second machine needs to take over.

### 1. Transfer `.env.production`

_Why:_ it's gitignored (it contains `SESSION_SECRET` and `GITHUB_CLIENT_SECRET`), so it never reaches the new machine via `git clone`. Without it, `deploy.sh` would re-prompt for everything and generate a fresh `SESSION_SECRET` — invalidating every existing user session on the next deploy.

Copy it across with `scp` or any secure channel (avoid pasting into a chat client). If a secret leaks in transit, rotate it: regenerate the GitHub OAuth Client Secret in GitHub's developer settings, and let `deploy.sh` write a new `SESSION_SECRET` by deleting the line from `.env.production` before re-running.

### 2. Install Docker

_Why:_ the script builds the image locally and pushes it to Artifact Registry; it doesn't shell out to a remote builder. The script doesn't install Docker for you.

Follow [Docker's install instructions](https://docs.docker.com/get-docker/) for your platform and confirm the daemon is running (`docker info`).

### 3. Install and authenticate gcloud

_Why:_ the script offers to install gcloud (via Homebrew or the official tarball) but won't run `gcloud auth login` for you, since that opens a browser and handles poorly when driven by a non-interactive parent.

```sh
gcloud auth login
gcloud config set project <your-project-id>
```

### 4. Confirm your gcloud account has the right IAM roles

_Why:_ deploying touches several services, each with its own permission. If any are missing, the relevant step fails with a 403 partway through. Owners and editors already have all of these; for a least-privilege deployer, grant:

| Role                                                     | Why                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `roles/compute.instanceAdmin.v1`                         | Create the VM, reserve the IP, create firewall rules, SSH to the VM via gcloud. |
| `roles/artifactregistry.writer`                          | Push the Docker image to the `tcq` Artifact Registry repository.                |
| `roles/iam.serviceAccountUser` on `$GCP_SERVICE_ACCOUNT` | Attach the VM service account to the instance.                                  |

Grant with:

```sh
gcloud projects add-iam-policy-binding <your-project-id> \
  --member="user:<deployer-email>" \
  --role="roles/compute.instanceAdmin.v1"
# ...repeat for the other two roles.
```

### 5. Clone the repo at the commit you want to ship

_Why:_ the image is tagged `:latest` and `GIT_SHA` is read from `git rev-parse HEAD` at deploy time. The script also refuses to deploy from a dirty tree, so a fresh clone (or a clean checkout of an existing one) is the simplest starting state.

```sh
git clone <repo-url>
cd <repo>
# Drop .env.production into the project root, then:
./scripts/deploy.sh
```

What you do **not** need on the new machine: `service-account.json` (only used by local code that talks to Firestore directly; the VM gets its credentials from its attached service account).

## SSH Access

For inspecting logs, debugging, or one-off operations:

```sh
gcloud compute ssh <VM_NAME> --zone=<GCP_ZONE>
```

Useful commands once on the VM:

```sh
# Container logs (live tail)
sudo journalctl -u tcq.service -f
sudo journalctl -u caddy.service -f

# Restart a container manually
sudo systemctl restart tcq.service

# Confirm both containers are running
sudo docker ps
```

The same logs are also available in Cloud Logging — search for `resource.type="gce_instance"` and `resource.labels.instance_id="<your-vm-id>"`.

## Configuration Notes

- **Container-Optimized OS** — auto-updates the OS and Docker. The default channel (`cos-stable`) takes update reboots on a managed schedule; the systemd units are configured with `Restart=always` so both containers come back automatically. No manual patching.
- **Caddyfile** — written by cloud-init at VM creation. Changing the Caddyfile (e.g. adding a second hostname) requires SSH-ing in and editing `/etc/caddy/Caddyfile`, then `sudo systemctl restart caddy.service`. If you change `CUSTOM_DOMAIN` in `.env.production`, the simplest reset is to delete the VM and re-run the script — cloud-init will re-render the Caddyfile from the new value.
- **Static IP** — `${VM_NAME}-ip` is reserved as a regional external address. Keep it attached to the VM; if you delete the VM without releasing the address, GCP charges a small idle-IP fee.
- **Firewall** — only ports 80 and 443 are open externally (and only to VMs tagged `tcq-server`). Port 3000 is bound to `127.0.0.1` inside the VM and never reachable from the public internet; Caddy is the only thing talking to it. There are **two** firewall layers: the GCP VPC rule (`tcq-allow-http-https`) and the COS host firewall. COS defaults its host `iptables` INPUT chain to deny (only SSH, ICMP, and established connections), so the VPC rule alone leaves 80/443 dropped at the VM. The `tcq-firewall` systemd unit (installed by cloud-init) inserts the host `iptables` ACCEPT rule for 80/443 on every boot — re-applied each boot because runtime iptables changes don't survive COS auto-update reboots. If HTTPS is unreachable but `gcloud compute instances list` shows the VM running with the right IP and tag, check this unit (`sudo systemctl status tcq-firewall` and `sudo iptables -L INPUT -nv`) before suspecting DNS or Caddy.
- **Firestore credentials** — the VM's attached service account has Firestore access via `roles/datastore.user`. No key file needed in production.
- **`GIT_SHA`** — `scripts/deploy.sh` sets this to `git rev-parse HEAD` on every deploy and writes it to `/etc/tcq/env`. The server exposes it at `GET /api/version` (plain text, public) so monitoring tools can identify which commit is running. In development the variable is unset and the endpoint returns 204.
- **`K_REVISION`** — `scripts/deploy.sh` sets this to `${GIT_SHA}-<deploy-timestamp>` and writes it to `/etc/tcq/env` on every deploy. Unlike `GIT_SHA`, this changes on every deploy even when the same commit is redeployed (e.g. an env-only redeploy after adding `GITHUB_CLIENT_SECRET`). The server publishes it two ways: as `revision` in the JSON response from `GET /api/version` (`Accept: application/json`), and once per socket via the `server:revision` WebSocket event on join. The meeting-page client takes the WebSocket-reported revision as its baseline, polls `/api/version` every 30 seconds, and reloads when the polled revision diverges — that's how clients automatically pick up a redeploy without manual refresh. The name `K_REVISION` is borrowed from Cloud Run (where the variable was auto-injected); on Compute Engine we generate it in the deploy script instead.
- **Pre-existing session documents** — Session docs written before TTL was enabled have no `expireAt` field, so the policy will not delete them. They are stale (the cookies themselves expired long ago) and can be deleted in one shot via the Firestore console, or left in place to be overwritten on next login under the same session ID.
- **Resource sizing** — `e2-micro` provides 2 shared vCPUs and 1 GB RAM. TCQ at 50–60 concurrent users uses well under both — Socket.IO message routing and the in-memory `MeetingState` are light. If you find yourself wanting more headroom (or more meetings concurrently), `e2-small` or `e2-medium` are drop-in replacements; change `--machine-type` in `ensure_vm` and re-run. Note that anything bigger than `e2-micro` falls outside the always-free tier.
- **Single instance, no autoscaling** — there's exactly one VM. Meeting state lives in process memory, so a second instance would split clients across two divergent views of the queue, agenda, and log; with only one instance there is no "other" instance for any client to be routed to. If TCQ outgrows a single VM, the migration is to a load balancer + multiple VMs in a managed instance group, which requires moving the meeting store out of memory and is no longer free-tier.

## Checking Deployment Status

```sh
# View the VM's external IP (should match your DNS A record)
gcloud compute instances describe <VM_NAME> --zone=<GCP_ZONE> \
  --format='value(networkInterfaces[0].accessConfigs[0].natIP)'

# Tail TCQ logs from your local machine
gcloud compute ssh <VM_NAME> --zone=<GCP_ZONE> --command='sudo journalctl -u tcq.service -n 100 --no-pager'

# Or the same via Cloud Logging
gcloud logging read 'resource.type="gce_instance" AND severity>=INFO' --limit=50 --format=json
```

## Local Firestore Testing

To test Firestore locally (optional — the file store works for most development):

```sh
# Create a service account key
gcloud iam service-accounts keys create service-account.json \
  --iam-account=tcq-vm@<your-project-id>.iam.gserviceaccount.com
```

The key file is saved as `service-account.json` (already in `.gitignore`). Add to `.env.development` or `.env`:

```
STORE=firestore
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
FIRESTORE_DATABASE_ID=<your-database-id>
```

## Development OAuth App

Optional — without it, the server runs in mock auth mode with a fake user. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.
