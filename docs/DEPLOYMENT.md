# Deploying TCQ

TCQ is deployed as a single Docker container on Google Cloud Run, with Firestore for persistent storage. See [ARCHITECTURE.md](ARCHITECTURE.md) for the rationale behind these choices.

Deployment is driven by `scripts/deploy.sh`. The script is self-bootstrapping: on first run it walks you through GCP setup interactively (installing `gcloud` if needed, creating the project, linking billing, provisioning Firestore and a service account and an Artifact Registry repo, writing `.env.production`). On subsequent runs it just builds and deploys.

## Environment Files

TCQ uses environment-specific `.env` files:

| File               | Purpose                                 | Committed to git? |
| ------------------ | --------------------------------------- | ----------------- |
| `.env.development` | Local development defaults (no secrets) | Yes               |
| `.env.production`  | Production config and secrets           | No (gitignored)   |

The server loads `.env.development` or `.env.production` based on `NODE_ENV`. In development (`npm run dev`), `NODE_ENV` is unset so `.env.development` is used. In production (`NODE_ENV=production`), `.env.production` is used.

`.env.production` is written by `scripts/deploy.sh` on the recommended path below — you don't need to hand-author it unless you're following the manual path.

## Prerequisites

- A [Google Cloud](https://cloud.google.com/) account
- [Docker](https://docs.docker.com/get-docker/) installed locally
- The [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) (`gcloud`) — the deploy script offers to install it if it's missing
- A clean git working tree — the deploy script refuses to run with uncommitted or untracked changes, since the deployed image is always tagged `:latest` and a dirty deploy leaves no record of what actually shipped. Commit or stash before running.

## First-Time Setup (Recommended)

1. Run `gcloud auth login` (the deploy script will tell you to do this if you haven't).
2. Run `./scripts/deploy.sh`.

The script will:

- Offer to install `gcloud` via Homebrew (if available) or the official tarball, when it isn't already on your PATH.
- Prompt for the values it needs — GCP project ID, region, Cloud Run service name, admin GitHub usernames.
- Let you pick a billing account from a menu of those attached to your gcloud account.
- Create the GCP project (if new), link billing, enable the required APIs, create the Firestore database, the Cloud Run service account (with the right IAM bindings), and the Artifact Registry repository.
- Generate `SESSION_SECRET` and write everything collected so far to `.env.production`.
- Build the Docker image, push it, and deploy to Cloud Run.
- Once the first deploy finishes, print a pre-filled GitHub OAuth App registration URL. Click it, hit **Register application**, copy the Client ID and Client Secret back into the prompt, and the script redeploys with real GitHub auth enabled.

Every step is idempotent. Re-running the script with a fully populated `.env.production` skips every prompt and behaves as a plain build + push + deploy.

## First-Time Setup (Manual)

If you'd rather provision by hand — for learning purposes, or because you want finer control than the script offers — follow these steps. Each one explains _why_ it exists so you can skip or vary it sensibly.

### 1. Create a GCP project

_Why:_ every GCP resource (Firestore, Cloud Run, Artifact Registry) lives inside a project. This also becomes the active context for the rest of the `gcloud` calls below.

```sh
gcloud projects create <your-project-id> --name="TCQ"
gcloud config set project <your-project-id>
```

### 2. Link a billing account

_Why:_ Cloud Run and Artifact Registry require a billing account attached, even though TCQ fits comfortably inside the always-free tier. The script does this for you via a menu; manually, list open billing accounts and link one:

```sh
gcloud billing accounts list --filter=open=true
gcloud billing projects link <your-project-id> --billing-account=<account-id>
```

### 3. Enable required APIs

_Why:_ Firestore, Cloud Run, and Artifact Registry are disabled by default on new projects; using them before they're enabled returns a 403.

```sh
gcloud services enable firestore.googleapis.com run.googleapis.com artifactregistry.googleapis.com
```

### 4. Create a Firestore database

_Why:_ Firestore holds persistent meeting state. Use a free-tier eligible region: `us-east1`, `us-central1`, or `us-west1`.

```sh
gcloud firestore databases create --location=us-central1
```

Or with a custom database ID:

```sh
gcloud firestore databases create --location=us-central1 --database=<your-database-id>
```

### 5. Create a service account for Cloud Run

_Why:_ Cloud Run needs an identity that can read and write Firestore without shipping a key file. The first IAM binding grants the service account access to Firestore; the second grants the deploying user the right to attach this service account to a Cloud Run revision.

```sh
gcloud iam service-accounts create tcq-cloudrun --display-name="TCQ Cloud Run"

gcloud projects add-iam-policy-binding <your-project-id> \
  --member="serviceAccount:tcq-cloudrun@<your-project-id>.iam.gserviceaccount.com" \
  --role="roles/datastore.user"

gcloud projects add-iam-policy-binding <your-project-id> \
  --member="user:$(gcloud config get account)" \
  --role="roles/iam.serviceAccountUser"
```

### 6. Create an Artifact Registry repository

_Why:_ Cloud Run pulls the TCQ image from somewhere; Artifact Registry is Google's first-party Docker registry. The second command registers a Docker credential helper so `docker push` can authenticate.

```sh
gcloud artifacts repositories create tcq --repository-format=docker --location=us-central1
gcloud auth configure-docker us-central1-docker.pkg.dev
```

### 7. Write `.env.production`

_Why:_ `scripts/deploy.sh` reads every value it needs from this file. The `GITHUB_*` fields come later — they depend on the Cloud Run URL, which doesn't exist until after the first deploy.

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
GCP_SERVICE_ACCOUNT=tcq-cloudrun@<your-project-id>.iam.gserviceaccount.com
CLOUD_RUN_SERVICE=tcq
```

Generate a random session secret with:

```sh
head -c 32 /dev/urandom | base64 | tr -d '=/+' | head -c 40
```

### 8. First deploy (without OAuth)

_Why:_ GitHub OAuth needs the Cloud Run URL, and you don't know it until the service exists. Deploy once with mock auth to get the URL.

```sh
./scripts/deploy.sh
```

The script warns that GitHub OAuth isn't configured — the server will run in mock auth mode. Note the **service URL** it prints at the end.

### 9. Register a GitHub OAuth App

_Why:_ this is the one step that can't be automated — GitHub's API doesn't expose OAuth App creation.

Open a pre-filled registration form (substitute your Cloud Run URL):

```
https://github.com/settings/applications/new?oauth_application%5Bname%5D=TCQ&oauth_application%5Burl%5D=https%3A%2F%2F<your-cloud-run-url>&oauth_application%5Bcallback_url%5D=https%3A%2F%2F<your-cloud-run-url>%2Fauth%2Fgithub%2Fcallback
```

Click **Register application**, then generate a **Client Secret**. Note the **Client ID** and **Client Secret**.

If the pre-fill link doesn't work for you, register manually at [GitHub Developer Settings > OAuth Apps](https://github.com/settings/developers) with:

- **Application name:** `TCQ`
- **Homepage URL:** `https://<your-cloud-run-url>`
- **Authorization callback URL:** `https://<your-cloud-run-url>/auth/github/callback`

### 10. Redeploy with OAuth

_Why:_ the server reads GitHub credentials at boot, so they have to be baked into a fresh Cloud Run revision.

Add to `.env.production`:

```
# GitHub OAuth
GITHUB_CLIENT_ID=<client-id>
GITHUB_CLIENT_SECRET=<client-secret>
GITHUB_CALLBACK_URL=https://<your-cloud-run-url>/auth/github/callback
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

The script reads all configuration from `.env.production`, builds the image, pushes it, and deploys.

## Configuration Notes

- **`--timeout 3600`** — Maximum 60-minute timeout for WebSocket connections. Socket.IO reconnects transparently when the timeout is reached.
- **`--session-affinity`** — Routes reconnecting clients to the same instance.
- **Firestore credentials** — Cloud Run's service account has Firestore access via the IAM role granted in step 5. No key file needed in production.
- **`GIT_SHA`** — `scripts/deploy.sh` sets this to `git rev-parse HEAD` on every deploy and passes it to Cloud Run via `--set-env-vars`. The server exposes it at `GET /api/version` (plain text, public) so monitoring tools can identify which commit is running. In development the variable is unset and the endpoint returns 204.

## Checking Deployment Status

```sh
# View the service URL
gcloud run services describe tcq --region=us-central1 --format='value(status.url)'

# View recent logs
gcloud run services logs read tcq --region=us-central1 --limit=50

# List revisions
gcloud run revisions list --service=tcq --region=us-central1
```

## Local Firestore Testing

To test Firestore locally (optional — the file store works for most development):

```sh
# Create a service account key
gcloud iam service-accounts keys create service-account.json \
  --iam-account=tcq-cloudrun@<your-project-id>.iam.gserviceaccount.com
```

The key file is saved as `service-account.json` (already in `.gitignore`). Add to `.env.development` or `.env`:

```
STORE=firestore
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
FIRESTORE_DATABASE_ID=<your-database-id>
```

## Development OAuth App

Optional — without it, the server runs in mock auth mode with a fake user. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.
