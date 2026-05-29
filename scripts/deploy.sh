#!/usr/bin/env bash
#
# Build, push, and deploy TCQ to a Compute Engine VM running
# Container-Optimized OS (COS).
#
# Why this shape:
#
#   - **COS** is Google's container-optimised Linux distribution. It
#     auto-updates the OS and the Docker runtime on a managed schedule,
#     has no package manager surface area, and ships with the Cloud
#     Logging integration enabled by default. Closest thing GCP has to
#     a maintenance-free VM.
#   - **Caddy** runs as a Docker container in front of TCQ and handles
#     HTTPS automatically — Let's Encrypt issuance, renewal, and
#     redirection from HTTP to HTTPS. Zero TLS config beyond the domain
#     name.
#   - **systemd** units (one per container) provide crash recovery via
#     `Restart=always`. If TCQ panics, systemd starts it back up; if
#     COS reboots for an OS update, both containers come back on boot.
#   - **Cloud Logging** picks up container stdout/stderr via the
#     `google-logging-enabled=true` instance metadata flag. No agent
#     install needed; the structured JSON logs the server already emits
#     show up as queryable LogEntry records the same way they did on
#     Cloud Run.
#
# On first run, or any time a required field is missing from
# .env.production, the script walks the user through setup interactively:
#
#   - installs gcloud (via Homebrew or the official tarball) if missing,
#   - prompts for GCP project ID, region/zone, VM name, custom domain,
#     admin usernames, etc.,
#   - creates the project, links a billing account (chosen from a menu),
#   - enables APIs, creates the Firestore database, service account,
#     Artifact Registry repo, static external IP, and firewall rules
#     (all idempotent — safe to re-run),
#   - generates SESSION_SECRET and writes .env.production,
#   - provisions the VM with cloud-init that installs both systemd
#     units on first boot,
#   - builds and pushes the Docker image, then SSHes in to pull it and
#     restart the TCQ unit,
#   - prints a pre-filled GitHub OAuth App registration URL and, once
#     the user pastes in the Client ID and Client Secret, redeploys
#     with real GitHub auth enabled.
#
# Re-runs with a fully populated .env.production skip every prompt and
# behave as a straight build + push + restart.
#
# Fields read from .env.production:
#
#   Required (prompted if missing):
#     GCP_PROJECT_ID, GCP_REGION, GCP_ZONE, GCP_SERVICE_ACCOUNT, VM_NAME,
#     SESSION_SECRET, STORE, ADMIN_USERNAMES, CUSTOM_DOMAIN
#
#   Optional:
#     FIRESTORE_DATABASE_ID, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET,
#     ORCID_CLIENT_ID, ORCID_CLIENT_SECRET, ORCID_BASE_URL,
#     GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
#     MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT,
#     OAUTH_CALLBACK_BASE_URL
#
# Usage:
#   ./scripts/deploy.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env.production"

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

# Update an existing KEY=VALUE line in .env.production, or append it if the
# key isn't present. Preserves line ordering and surrounding comments.
upsert_env() {
  local key="$1" val="$2"
  [ -f "$ENV_FILE" ] || touch "$ENV_FILE"
  if grep -q "^${key}=" "$ENV_FILE"; then
    local tmp
    tmp="$(mktemp)"
    awk -v k="$key" -v v="$val" '
      $0 ~ "^" k "=" { print k "=" v; next }
      { print }
    ' "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

# Prompt with an optional default. With a default, Enter accepts it.
# Without a default, re-prompts until a non-empty answer is given.
prompt_with_default() {
  local prompt="$1" default="${2:-}" reply
  if [ -n "$default" ]; then
    read -r -p "$prompt [$default]: " reply
    echo "${reply:-$default}"
  else
    while [ -z "${reply:-}" ]; do
      read -r -p "$prompt: " reply
    done
    echo "$reply"
  fi
}

# Percent-encode a string for safe use in a URL query component.
url_encode() {
  local s="$1" i c out=""
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) out+="$(printf '%%%02X' "'$c")" ;;
    esac
  done
  printf '%s' "$out"
}

# Yes/no prompt. Second arg is the default (y or n).
confirm() {
  local prompt="$1" default="${2:-n}" reply suffix
  if [ "$default" = "y" ]; then suffix="[Y/n]"; else suffix="[y/N]"; fi
  read -r -p "$prompt $suffix " reply
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy]$ ]]
}

# Source .env.production if it exists, ignoring comments and blank lines.
load_env_file() {
  [ -f "$ENV_FILE" ] || return 0
  set -a
  while IFS= read -r line; do
    [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
    eval "$line"
  done < "$ENV_FILE"
  set +a
}

# ---------------------------------------------------------------------------
# Install / auth: gcloud
# ---------------------------------------------------------------------------

install_gcloud_tarball() {
  local os arch url dir archive
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin)
      case "$arch" in
        arm64)  url="https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-darwin-arm.tar.gz" ;;
        x86_64) url="https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-darwin-x86_64.tar.gz" ;;
        *) echo "Unsupported macOS architecture: $arch" >&2; return 1 ;;
      esac
      ;;
    Linux)
      case "$arch" in
        x86_64|amd64)  url="https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz" ;;
        aarch64|arm64) url="https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-arm.tar.gz" ;;
        *) echo "Unsupported Linux architecture: $arch" >&2; return 1 ;;
      esac
      ;;
    *)
      echo "Unsupported OS: $os" >&2
      echo "Install gcloud manually: https://cloud.google.com/sdk/docs/install" >&2
      return 1
      ;;
  esac

  dir="$HOME/google-cloud-sdk"
  archive="$(mktemp -t gcloud.XXXXXX).tar.gz"
  echo "Downloading Google Cloud SDK..."
  curl -fsSL "$url" -o "$archive"
  echo "Extracting to $HOME..."
  tar -xzf "$archive" -C "$HOME"
  rm -f "$archive"

  echo "Running installer..."
  "$dir/install.sh" --quiet --path-update=true --command-completion=true

  export PATH="$dir/bin:$PATH"
  echo ""
  echo "Google Cloud SDK installed at $dir."
  echo "The installer added gcloud to your shell config; open a new shell"
  echo "for the PATH change to stick. This run will use $dir/bin directly."
}

install_gcloud_via_brew() {
  command -v brew >/dev/null 2>&1 || return 1
  echo "Installing Google Cloud SDK via Homebrew..."
  brew install --cask google-cloud-sdk || return 1
  local prefix candidate
  prefix="$(brew --prefix)"
  for candidate in \
    "$prefix/share/google-cloud-sdk/bin" \
    "$prefix/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin"; do
    if [ -d "$candidate" ]; then
      export PATH="$candidate:$PATH"
      return 0
    fi
  done
  return 1
}

ensure_gcloud() {
  if command -v gcloud >/dev/null 2>&1; then
    return 0
  fi
  echo "gcloud (Google Cloud SDK) is not installed."
  echo "It's required to provision GCP resources and SSH to the VM."
  if ! confirm "Install gcloud now?" y; then
    echo "Install it manually and re-run: https://cloud.google.com/sdk/docs/install" >&2
    exit 1
  fi
  install_gcloud_via_brew || install_gcloud_tarball || exit 1
  if ! command -v gcloud >/dev/null 2>&1; then
    echo "gcloud was installed but isn't on PATH in this shell." >&2
    echo "Restart your shell and re-run ./scripts/deploy.sh." >&2
    exit 1
  fi
}

# Refuse to deploy from a dirty tree: the image is always tagged :latest,
# so a dirty deploy leaves no record of what actually shipped.
ensure_clean_working_tree() {
  if ! git -C "$PROJECT_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Not inside a git working tree — refusing to deploy." >&2
    exit 1
  fi
  local dirty
  dirty="$(git -C "$PROJECT_ROOT" status --porcelain)"
  if [ -n "$dirty" ]; then
    echo "Working tree is dirty — refusing to deploy:" >&2
    echo "$dirty" >&2
    echo "" >&2
    echo "Commit, stash, or discard your changes and re-run." >&2
    exit 1
  fi
}

ensure_auth() {
  ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null || true)"
  if [ -z "$ACTIVE_ACCOUNT" ]; then
    echo "No active gcloud credentials found." >&2
    echo "Run this and then re-invoke ./scripts/deploy.sh:" >&2
    echo "  gcloud auth login" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Config collection: prompt for anything missing from .env.production
# ---------------------------------------------------------------------------

ensure_project_id() {
  if [ -z "${GCP_PROJECT_ID:-}" ]; then
    echo ""
    echo "GCP project setup"
    echo "-----------------"
    GCP_PROJECT_ID="$(prompt_with_default "GCP project ID (globally unique, lowercase letters/digits/hyphens)")"
    upsert_env GCP_PROJECT_ID "$GCP_PROJECT_ID"
  fi
}

ensure_region() {
  if [ -z "${GCP_REGION:-}" ]; then
    # us-east1, us-central1, and us-west1 are free-tier eligible for
    # Firestore *and* Compute Engine's e2-micro Always-Free instance.
    GCP_REGION="$(prompt_with_default "GCP region" "us-central1")"
    upsert_env GCP_REGION "$GCP_REGION"
  fi
}

ensure_zone() {
  if [ -z "${GCP_ZONE:-}" ]; then
    # Default to zone -a in the region; users can override if quota dictates.
    GCP_ZONE="$(prompt_with_default "GCP zone" "${GCP_REGION}-a")"
    upsert_env GCP_ZONE "$GCP_ZONE"
  fi
}

ensure_vm_name() {
  if [ -z "${VM_NAME:-}" ]; then
    VM_NAME="$(prompt_with_default "VM name" "tcq")"
    upsert_env VM_NAME "$VM_NAME"
  fi
}

ensure_service_account_email() {
  if [ -z "${GCP_SERVICE_ACCOUNT:-}" ]; then
    GCP_SERVICE_ACCOUNT="tcq-vm@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
    upsert_env GCP_SERVICE_ACCOUNT "$GCP_SERVICE_ACCOUNT"
  fi
}

ensure_session_secret() {
  if [ -z "${SESSION_SECRET:-}" ]; then
    SESSION_SECRET="$(head -c 32 /dev/urandom | base64 | tr -d '=/+' | head -c 40)"
    upsert_env SESSION_SECRET "$SESSION_SECRET"
  fi
}

ensure_store() {
  if [ -z "${STORE:-}" ]; then
    STORE=firestore
    upsert_env STORE firestore
  fi
}

ensure_admin_usernames() {
  if [ -z "${ADMIN_USERNAMES:-}" ]; then
    read -r -p "GitHub usernames to grant admin access (comma-separated, blank to skip): " ADMIN_USERNAMES
    if [ -n "$ADMIN_USERNAMES" ]; then
      upsert_env ADMIN_USERNAMES "$ADMIN_USERNAMES"
    fi
  fi
}

# Domain is required for Caddy to issue a Let's Encrypt cert. Without
# one, the VM only serves plaintext HTTP, which browsers refuse to use
# for cookie-bearing sessions. Refusing to proceed without a domain
# avoids a half-deployed, broken-auth state.
ensure_custom_domain() {
  if [ -z "${CUSTOM_DOMAIN:-}" ]; then
    echo ""
    echo "Custom domain is required."
    echo "Caddy uses it to obtain a Let's Encrypt TLS certificate; the"
    echo "deploy can't complete without one. After this script provisions"
    echo "the VM and prints its external IP, point an A record at that IP"
    echo "and let DNS propagate before Caddy will be able to issue."
    echo ""
    CUSTOM_DOMAIN="$(prompt_with_default "Domain (e.g. tcq.example.org)")"
    upsert_env CUSTOM_DOMAIN "$CUSTOM_DOMAIN"
  fi
}

# ---------------------------------------------------------------------------
# GCP provisioning (idempotent)
# ---------------------------------------------------------------------------

ensure_project_exists() {
  if ! gcloud projects describe "$GCP_PROJECT_ID" >/dev/null 2>&1; then
    echo "Creating GCP project $GCP_PROJECT_ID..."
    gcloud projects create "$GCP_PROJECT_ID" --name=TCQ
  fi
  gcloud config set project "$GCP_PROJECT_ID" >/dev/null
}

ensure_billing_linked() {
  local status
  status="$(gcloud billing projects describe "$GCP_PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null || echo "")"
  if [ "$status" = "True" ]; then
    return 0
  fi

  echo ""
  echo "Project $GCP_PROJECT_ID is not linked to a billing account."
  echo "Compute Engine, Artifact Registry, and Firestore all require one,"
  echo "even though TCQ on an e2-micro fits comfortably inside the"
  echo "always-free tier (744 hours/month per region)."
  echo ""

  local accounts
  accounts="$(gcloud billing accounts list --filter=open=true --format='value(name,displayName)' 2>/dev/null || true)"
  if [ -z "$accounts" ]; then
    echo "No open billing accounts found on your gcloud account." >&2
    echo "Create one at https://console.cloud.google.com/billing, then re-run." >&2
    exit 1
  fi

  local ids=() displays=() i=1
  while IFS=$'\t' read -r id display; do
    [ -z "$id" ] && continue
    ids+=("$id")
    displays+=("$display")
    echo "  $i) $display ($id)"
    i=$((i + 1))
  done <<<"$accounts"

  local choice idx
  while :; do
    read -r -p "Select billing account [1-${#ids[@]}]: " choice
    if [[ "$choice" =~ ^[0-9]+$ ]]; then
      idx=$((choice - 1))
      if [ "$idx" -ge 0 ] && [ "$idx" -lt "${#ids[@]}" ]; then
        break
      fi
    fi
    echo "  not a valid selection; try again"
  done

  echo "Linking billing account ${ids[$idx]}..."
  gcloud billing projects link "$GCP_PROJECT_ID" --billing-account="${ids[$idx]}"
}

ensure_apis() {
  # `compute` for the VM, `firestore` for state, `artifactregistry` for the
  # image, `logging` and `monitoring` for the COS-built-in agents to write
  # logs and metrics to Cloud Logging / Monitoring without manual install.
  local needed=(
    compute.googleapis.com
    firestore.googleapis.com
    artifactregistry.googleapis.com
    logging.googleapis.com
    monitoring.googleapis.com
  )
  local enabled
  enabled="$(gcloud services list --enabled --project="$GCP_PROJECT_ID" --format='value(config.name)' 2>/dev/null || true)"
  local to_enable=() api
  for api in "${needed[@]}"; do
    if ! grep -qx "$api" <<<"$enabled"; then
      to_enable+=("$api")
    fi
  done
  if [ ${#to_enable[@]} -gt 0 ]; then
    echo "Enabling APIs: ${to_enable[*]}..."
    gcloud services enable --project="$GCP_PROJECT_ID" "${to_enable[@]}"
  fi
}

ensure_firestore() {
  local db_id="${FIRESTORE_DATABASE_ID:-(default)}"
  if gcloud firestore databases describe \
       --database="$db_id" \
       --project="$GCP_PROJECT_ID" \
       >/dev/null 2>&1; then
    return 0
  fi
  echo "Creating Firestore database '$db_id' in $GCP_REGION..."
  if [ "$db_id" = "(default)" ]; then
    gcloud firestore databases create \
      --location="$GCP_REGION" \
      --project="$GCP_PROJECT_ID"
  else
    gcloud firestore databases create \
      --location="$GCP_REGION" \
      --database="$db_id" \
      --project="$GCP_PROJECT_ID"
  fi
}

ensure_session_ttl_policy() {
  local db_id="${FIRESTORE_DATABASE_ID:-(default)}"
  echo "Ensuring Firestore TTL policy on sessions.expireAt..."
  gcloud firestore fields ttls update expireAt \
    --collection-group=sessions \
    --database="$db_id" \
    --project="$GCP_PROJECT_ID" \
    --enable-ttl --quiet >/dev/null
}

ensure_service_account() {
  if ! gcloud iam service-accounts describe "$GCP_SERVICE_ACCOUNT" \
         --project="$GCP_PROJECT_ID" >/dev/null 2>&1; then
    echo "Creating service account tcq-vm..."
    gcloud iam service-accounts create tcq-vm \
      --display-name="TCQ VM" \
      --project="$GCP_PROJECT_ID"
  fi
  # Roles the VM's service account needs:
  #   - datastore.user            → Firestore reads/writes
  #   - artifactregistry.reader   → docker pull from AR
  #   - logging.logWriter         → COS forwarding container stdout to Cloud Logging
  #   - monitoring.metricWriter   → COS forwarding metrics to Cloud Monitoring
  # All idempotent — re-applying a present binding is a no-op.
  local role
  for role in \
      roles/datastore.user \
      roles/artifactregistry.reader \
      roles/logging.logWriter \
      roles/monitoring.metricWriter; do
    gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
      --member="serviceAccount:$GCP_SERVICE_ACCOUNT" \
      --role="$role" \
      --condition=None \
      >/dev/null
  done
  # The deploying user needs to be able to attach the service account
  # to a VM (the 'iam.serviceAccountUser' role on the project).
  gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
    --member="user:$ACTIVE_ACCOUNT" \
    --role="roles/iam.serviceAccountUser" \
    --condition=None \
    >/dev/null
}

ensure_artifact_registry() {
  if ! gcloud artifacts repositories describe tcq \
         --location="$GCP_REGION" \
         --project="$GCP_PROJECT_ID" \
         >/dev/null 2>&1; then
    echo "Creating Artifact Registry repository 'tcq' in $GCP_REGION..."
    gcloud artifacts repositories create tcq \
      --repository-format=docker \
      --location="$GCP_REGION" \
      --project="$GCP_PROJECT_ID"
  fi
  gcloud auth configure-docker "${GCP_REGION}-docker.pkg.dev" --quiet >/dev/null
}

# A static external IP keeps the VM's address stable across stops/starts —
# important because the user's DNS A record points at it. The IP is free
# while attached to a running VM.
ensure_static_ip() {
  STATIC_IP_NAME="${VM_NAME}-ip"
  if ! gcloud compute addresses describe "$STATIC_IP_NAME" \
         --region="$GCP_REGION" \
         --project="$GCP_PROJECT_ID" \
         >/dev/null 2>&1; then
    echo "Reserving static external IP $STATIC_IP_NAME..."
    gcloud compute addresses create "$STATIC_IP_NAME" \
      --region="$GCP_REGION" \
      --project="$GCP_PROJECT_ID" \
      >/dev/null
  fi
  STATIC_IP="$(gcloud compute addresses describe "$STATIC_IP_NAME" \
    --region="$GCP_REGION" \
    --project="$GCP_PROJECT_ID" \
    --format='value(address)')"
}

# Open 80 (Let's Encrypt HTTP-01 validation + redirect) and 443 (HTTPS)
# only on VMs tagged `tcq-server`. The VM is created with that tag below.
ensure_firewall_rules() {
  local rule="tcq-allow-http-https"
  if ! gcloud compute firewall-rules describe "$rule" \
         --project="$GCP_PROJECT_ID" >/dev/null 2>&1; then
    echo "Creating firewall rule $rule..."
    gcloud compute firewall-rules create "$rule" \
      --project="$GCP_PROJECT_ID" \
      --direction=INGRESS \
      --action=ALLOW \
      --rules=tcp:80,tcp:443 \
      --source-ranges=0.0.0.0/0 \
      --target-tags=tcq-server \
      >/dev/null
  fi
}

# ---------------------------------------------------------------------------
# Cloud-init: write the systemd units, Caddyfile, and env file on first boot
# ---------------------------------------------------------------------------
#
# COS supports cloud-init's `write_files` and `runcmd` directives. The
# generated user-data:
#
#   1. Writes /etc/systemd/system/tcq.service      — runs the TCQ container
#   2. Writes /etc/systemd/system/caddy.service    — runs Caddy in front
#   3. Writes /etc/systemd/system/tcq-firewall.service — opens 80/443 on the
#      COS host firewall each boot (the VPC rule alone isn't enough)
#   4. Writes /etc/caddy/Caddyfile                  — domain → 127.0.0.1:3000
#   5. Writes /etc/tcq/env                          — server env vars
#   6. Writes /etc/systemd/system/tcq-redeploy.service — receives `docker
#      pull && systemctl restart tcq` from the deploy script via SSH
#   7. Enables and starts the units on boot
#
# `Restart=always` on each service handles crash recovery; both units
# come back automatically on COS auto-update reboots.
generate_cloud_init() {
  local image_url="$1"

  cat <<EOF
#cloud-config

# COS forwards stdout/stderr from containers it manages to Cloud Logging
# automatically when the instance has logging enabled in metadata, which
# we set on \`gcloud compute instances create\` below. Both systemd units
# below run their containers in the foreground (\`docker run --rm\`),
# which is what triggers that capture path.

write_files:
- path: /etc/systemd/system/tcq.service
  permissions: 0644
  owner: root
  content: |
    [Unit]
    Description=TCQ application container
    Wants=gcr-online.target docker.socket network-online.target
    After=gcr-online.target docker.socket network-online.target
    StartLimitIntervalSec=0

    [Service]
    Environment=HOME=/var/lib/tcq
    # Authenticate Docker to Artifact Registry on every start so a
    # rotated host key or token doesn't wedge the container forever.
    ExecStartPre=/usr/bin/docker-credential-gcr configure-docker --registries=${GCP_REGION}-docker.pkg.dev
    ExecStartPre=-/usr/bin/docker stop tcq
    ExecStartPre=-/usr/bin/docker rm tcq
    ExecStart=/usr/bin/docker run --rm --name=tcq \\
      --network=host \\
      --env-file=/etc/tcq/env \\
      ${image_url}
    Restart=always
    RestartSec=5
    TimeoutStartSec=300

    [Install]
    WantedBy=multi-user.target

- path: /etc/systemd/system/caddy.service
  permissions: 0644
  owner: root
  content: |
    [Unit]
    Description=Caddy reverse proxy with automatic HTTPS
    Wants=gcr-online.target docker.socket network-online.target tcq.service
    After=gcr-online.target docker.socket network-online.target tcq.service
    StartLimitIntervalSec=0

    [Service]
    ExecStartPre=-/usr/bin/docker stop caddy
    ExecStartPre=-/usr/bin/docker rm caddy
    ExecStart=/usr/bin/docker run --rm --name=caddy \\
      --network=host \\
      -v /var/lib/caddy/data:/data \\
      -v /var/lib/caddy/config:/config \\
      -v /etc/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \\
      caddy:2-alpine
    Restart=always
    RestartSec=5

    [Install]
    WantedBy=multi-user.target

# COS ships a locked-down host firewall (iptables INPUT defaults to deny,
# permitting only SSH/ICMP/established) on top of the VPC firewall rule. The
# VPC rule alone isn't enough — without this the host drops inbound 80/443 and
# Caddy can never complete the ACME challenge. Re-applied on every boot because
# runtime iptables rules don't survive COS auto-update reboots.
- path: /etc/systemd/system/tcq-firewall.service
  permissions: 0644
  owner: root
  content: |
    [Unit]
    Description=Open host firewall for HTTP/HTTPS (COS defaults to deny)
    After=network-online.target
    Wants=network-online.target
    Before=caddy.service

    [Service]
    Type=oneshot
    RemainAfterExit=yes
    # -C checks for an existing rule so re-runs within a boot stay idempotent.
    ExecStart=/bin/sh -c 'iptables -C INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp -m multiport --dports 80,443 -j ACCEPT'

    [Install]
    WantedBy=multi-user.target

- path: /etc/caddy/Caddyfile
  permissions: 0644
  owner: root
  content: |
    # Caddy auto-issues and renews a Let's Encrypt cert for this name as
    # long as DNS resolves to this VM and ports 80/443 are reachable.
    ${CUSTOM_DOMAIN} {
      reverse_proxy 127.0.0.1:3000
    }

- path: /etc/tcq/env
  permissions: 0600
  owner: root
  content: |
    NODE_ENV=production
    PORT=3000
    STORE=${STORE:-firestore}
    SESSION_SECRET=${SESSION_SECRET}
$([ -n "${FIRESTORE_DATABASE_ID:-}" ] && echo "    FIRESTORE_DATABASE_ID=${FIRESTORE_DATABASE_ID}")
$([ -n "${ADMIN_USERNAMES:-}" ] && echo "    ADMIN_USERNAMES=${ADMIN_USERNAMES}")
$([ -n "${GITHUB_CLIENT_ID:-}" ] && echo "    GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID}")
$([ -n "${GITHUB_CLIENT_SECRET:-}" ] && echo "    GITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET}")
$([ -n "${ORCID_CLIENT_ID:-}" ] && echo "    ORCID_CLIENT_ID=${ORCID_CLIENT_ID}")
$([ -n "${ORCID_CLIENT_SECRET:-}" ] && echo "    ORCID_CLIENT_SECRET=${ORCID_CLIENT_SECRET}")
$([ -n "${ORCID_BASE_URL:-}" ] && echo "    ORCID_BASE_URL=${ORCID_BASE_URL}")
$([ -n "${GOOGLE_CLIENT_ID:-}" ] && echo "    GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}")
$([ -n "${GOOGLE_CLIENT_SECRET:-}" ] && echo "    GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}")
$([ -n "${MICROSOFT_CLIENT_ID:-}" ] && echo "    MICROSOFT_CLIENT_ID=${MICROSOFT_CLIENT_ID}")
$([ -n "${MICROSOFT_CLIENT_SECRET:-}" ] && echo "    MICROSOFT_CLIENT_SECRET=${MICROSOFT_CLIENT_SECRET}")
$([ -n "${MICROSOFT_TENANT:-}" ] && echo "    MICROSOFT_TENANT=${MICROSOFT_TENANT}")
$([ -n "${OAUTH_CALLBACK_BASE_URL:-}" ] && echo "    OAUTH_CALLBACK_BASE_URL=${OAUTH_CALLBACK_BASE_URL}")

runcmd:
- mkdir -p /var/lib/tcq /var/lib/caddy/data /var/lib/caddy/config
- systemctl daemon-reload
- systemctl enable --now tcq-firewall.service
- systemctl enable --now tcq.service
- systemctl enable --now caddy.service
EOF
}

# Provision the VM if it doesn't exist. e2-micro is the always-free tier
# instance type (744 hours/month per region). Container-Optimized OS
# (\`cos-stable\`) auto-updates the OS and Docker on a managed schedule.
ensure_vm() {
  if gcloud compute instances describe "$VM_NAME" \
       --zone="$GCP_ZONE" \
       --project="$GCP_PROJECT_ID" \
       >/dev/null 2>&1; then
    echo "VM $VM_NAME already exists in $GCP_ZONE — skipping provisioning."
    return 0
  fi

  echo ""
  echo "Provisioning VM $VM_NAME in $GCP_ZONE (this takes a minute or two)..."
  local cloud_init_file
  cloud_init_file="$(mktemp -t tcq-cloud-init.XXXXXX.yaml)"
  generate_cloud_init "$IMAGE" > "$cloud_init_file"

  # `cos-stable` is the auto-updating Container-Optimized OS image
  # family. Setting `google-logging-enabled=true` and
  # `google-monitoring-enabled=true` activates the COS-built-in
  # forwarding of container stdout/stderr to Cloud Logging and metrics
  # to Cloud Monitoring without an Ops Agent install.
  gcloud compute instances create "$VM_NAME" \
    --project="$GCP_PROJECT_ID" \
    --zone="$GCP_ZONE" \
    --machine-type=e2-micro \
    --image-family=cos-stable \
    --image-project=cos-cloud \
    --boot-disk-size=30GB \
    --boot-disk-type=pd-standard \
    --service-account="$GCP_SERVICE_ACCOUNT" \
    --scopes=cloud-platform \
    --address="$STATIC_IP" \
    --tags=tcq-server \
    --metadata=google-logging-enabled=true,google-monitoring-enabled=true \
    --metadata-from-file=user-data="$cloud_init_file" \
    >/dev/null

  rm -f "$cloud_init_file"

  echo ""
  echo "VM provisioned with external IP $STATIC_IP."
  echo ""
  echo "Before TLS will work, point an A record at this address:"
  echo "  $CUSTOM_DOMAIN  →  $STATIC_IP"
  echo ""
  echo "Caddy retries Let's Encrypt issuance until DNS resolves, so the"
  echo "VM can be created and DNS configured in either order; HTTPS will"
  echo "start working once both are in place."
}

# ---------------------------------------------------------------------------
# Build, push, deploy
# ---------------------------------------------------------------------------

build_and_push() {
  echo ""
  echo "Building Docker image for linux/amd64..."
  docker build --platform linux/amd64 -t "$IMAGE" "$PROJECT_ROOT"
  echo ""
  echo "Pushing image to $REGISTRY..."
  docker push "$IMAGE"
}

# On first boot the VM's tcq.service hasn't yet pulled the latest image
# (cloud-init wrote the systemd units but the image only just got pushed
# from this machine). Pulling and restarting from here covers both the
# first-deploy case and every subsequent redeploy.
deploy_to_vm() {
  echo ""
  echo "Deploying to VM $VM_NAME..."

  # The env file on the VM is only written by cloud-init at boot time,
  # so subsequent env changes (a new SESSION_SECRET, OAuth credentials
  # added later, etc.) need to be pushed along with the image. We
  # re-render and copy the file every deploy.
  local env_tmp git_sha
  env_tmp="$(mktemp -t tcq-env.XXXXXX)"
  git_sha=$(git -C "$PROJECT_ROOT" rev-parse HEAD)
  # K_REVISION is the per-deploy identifier the server reports via
  # /api/version and `server:revision` so meeting tabs can detect a
  # redeploy and refresh themselves. On Cloud Run this was auto-injected;
  # here we generate `<sha>-<unix-epoch>` so the value also changes on
  # no-code redeploys (e.g. an env-only redeploy after adding OAuth creds).
  cat > "$env_tmp" <<EOF
NODE_ENV=production
PORT=3000
STORE=${STORE:-firestore}
SESSION_SECRET=${SESSION_SECRET}
GIT_SHA=${git_sha}
K_REVISION=${git_sha}-$(date +%s)
EOF
  [ -n "${FIRESTORE_DATABASE_ID:-}" ] && echo "FIRESTORE_DATABASE_ID=${FIRESTORE_DATABASE_ID}" >> "$env_tmp"
  [ -n "${ADMIN_USERNAMES:-}" ]       && echo "ADMIN_USERNAMES=${ADMIN_USERNAMES}"           >> "$env_tmp"
  [ -n "${GITHUB_CLIENT_ID:-}" ]      && echo "GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID}"         >> "$env_tmp"
  [ -n "${GITHUB_CLIENT_SECRET:-}" ]  && echo "GITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET}" >> "$env_tmp"
  [ -n "${ORCID_CLIENT_ID:-}" ]       && echo "ORCID_CLIENT_ID=${ORCID_CLIENT_ID}"           >> "$env_tmp"
  [ -n "${ORCID_CLIENT_SECRET:-}" ]   && echo "ORCID_CLIENT_SECRET=${ORCID_CLIENT_SECRET}"   >> "$env_tmp"
  [ -n "${ORCID_BASE_URL:-}" ]        && echo "ORCID_BASE_URL=${ORCID_BASE_URL}"             >> "$env_tmp"
  [ -n "${GOOGLE_CLIENT_ID:-}" ]      && echo "GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}"         >> "$env_tmp"
  [ -n "${GOOGLE_CLIENT_SECRET:-}" ]  && echo "GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}" >> "$env_tmp"
  [ -n "${MICROSOFT_CLIENT_ID:-}" ]     && echo "MICROSOFT_CLIENT_ID=${MICROSOFT_CLIENT_ID}"         >> "$env_tmp"
  [ -n "${MICROSOFT_CLIENT_SECRET:-}" ] && echo "MICROSOFT_CLIENT_SECRET=${MICROSOFT_CLIENT_SECRET}" >> "$env_tmp"
  [ -n "${MICROSOFT_TENANT:-}" ]        && echo "MICROSOFT_TENANT=${MICROSOFT_TENANT}"               >> "$env_tmp"
  [ -n "${OAUTH_CALLBACK_BASE_URL:-}" ] && echo "OAUTH_CALLBACK_BASE_URL=${OAUTH_CALLBACK_BASE_URL}" >> "$env_tmp"

  # Wait briefly for SSH to come up on a fresh VM before the first
  # `gcloud compute scp` — fresh COS instances take ~30 s to settle.
  echo "Waiting for SSH to be reachable (up to 60s)..."
  local i
  for i in {1..12}; do
    if gcloud compute ssh "$VM_NAME" \
         --zone="$GCP_ZONE" \
         --project="$GCP_PROJECT_ID" \
         --command='true' >/dev/null 2>&1; then
      break
    fi
    sleep 5
  done

  # SSH binds well before cloud-init's `write_files` stage runs, so on a
  # freshly provisioned VM the `install` below would race against
  # /etc/tcq/ being created. Block until cloud-init is actually done.
  # On re-deploys against an existing VM this returns immediately.
  #
  # Exit codes from `cloud-init status --wait`:
  #   0  done, no errors
  #   1  fatal error — bail
  #   2  done, but with recoverable errors (extended_status: degraded done).
  #      On COS this fires routinely because cloud-init's network-activator
  #      probe runs before the network stack is fully up; write_files and
  #      runcmd still execute correctly, so treat as success.
  echo "Waiting for cloud-init to finish..."
  local cloud_init_rc=0
  gcloud compute ssh "$VM_NAME" \
    --zone="$GCP_ZONE" \
    --project="$GCP_PROJECT_ID" \
    --command='sudo cloud-init status --wait' >/dev/null || cloud_init_rc=$?
  if [ "$cloud_init_rc" -eq 1 ]; then
    echo "Error: cloud-init reported a fatal error on $VM_NAME." >&2
    echo "Inspect with: gcloud compute ssh $VM_NAME --zone=$GCP_ZONE --command='sudo cloud-init status --long'" >&2
    exit 1
  fi

  echo "Copying updated env to VM..."
  gcloud compute scp "$env_tmp" "$VM_NAME:/tmp/tcq.env" \
    --zone="$GCP_ZONE" \
    --project="$GCP_PROJECT_ID" \
    >/dev/null
  rm -f "$env_tmp"

  echo "Pulling image and restarting tcq.service..."
  # `sudo` is implicit on COS for the default ssh user (`google-sudoers`
  # group). Move the env file into place, pull the new image, and
  # restart — Caddy doesn't need restarting because the Caddyfile
  # didn't change.
  #
  # COS's root filesystem (including /root) is read-only, so
  # `docker-credential-gcr configure-docker` and `docker pull` cannot
  # use /root/.docker/. Override HOME to /var/lib/tcq (writable, and
  # the same dir tcq.service uses via Environment=HOME=/var/lib/tcq)
  # so the docker config lands in /var/lib/tcq/.docker/config.json and
  # the subsequent pull picks it up.
  gcloud compute ssh "$VM_NAME" \
    --zone="$GCP_ZONE" \
    --project="$GCP_PROJECT_ID" \
    --command="
      set -e
      sudo install -m 0600 /tmp/tcq.env /etc/tcq/env
      rm -f /tmp/tcq.env
      sudo env HOME=/var/lib/tcq docker-credential-gcr configure-docker --registries=${GCP_REGION}-docker.pkg.dev >/dev/null
      sudo env HOME=/var/lib/tcq docker pull '$IMAGE'
      sudo systemctl restart tcq.service
    " >/dev/null
}

get_service_url() {
  echo "https://${CUSTOM_DOMAIN}"
}

# ---------------------------------------------------------------------------
# Post-deploy: prompt for GitHub OAuth App credentials if missing.
# ---------------------------------------------------------------------------

ensure_github_oauth() {
  if [ -n "${GITHUB_CLIENT_ID:-}" ] && [ -n "${GITHUB_CLIENT_SECRET:-}" ]; then
    return 0
  fi

  local url callback
  url="https://${CUSTOM_DOMAIN}"
  callback="$url/auth/github/callback"

  echo ""
  echo "GitHub OAuth is not configured — the server is running in mock auth mode."
  echo ""
  echo "To enable real GitHub sign-in, register a new OAuth App. The link below"
  echo "pre-fills the form; just click Register application:"
  echo ""
  local enc_name enc_url enc_callback
  enc_name="$(url_encode TCQ)"
  enc_url="$(url_encode "$url")"
  enc_callback="$(url_encode "$callback")"
  echo "  https://github.com/settings/applications/new?oauth_application%5Bname%5D=${enc_name}&oauth_application%5Burl%5D=${enc_url}&oauth_application%5Bcallback_url%5D=${enc_callback}"
  echo ""
  echo "If any field doesn't pre-fill, use these values:"
  echo "  Application name            TCQ"
  echo "  Homepage URL                $url"
  echo "  Authorization callback URL  $callback"
  echo ""

  if ! confirm "Register the app now and paste in its credentials?" y; then
    echo ""
    echo "Skipped. To enable OAuth later, add GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET,"
    echo "and OAUTH_CALLBACK_BASE_URL to $ENV_FILE and re-run ./scripts/deploy.sh."
    return 0
  fi

  GITHUB_CLIENT_ID="$(prompt_with_default "Client ID")"
  local secret
  read -r -s -p "Client Secret: " secret
  echo ""
  GITHUB_CLIENT_SECRET="$secret"
  # Persist the provider-agnostic callback base; the server derives GitHub's
  # callback ($url/auth/github/callback) — the URL registered above — from it.
  OAUTH_CALLBACK_BASE_URL="$url/auth"
  upsert_env GITHUB_CLIENT_ID "$GITHUB_CLIENT_ID"
  upsert_env GITHUB_CLIENT_SECRET "$GITHUB_CLIENT_SECRET"
  upsert_env OAUTH_CALLBACK_BASE_URL "$OAUTH_CALLBACK_BASE_URL"

  echo ""
  echo "Pushing updated env to VM and restarting tcq.service..."
  deploy_to_vm
}

# Mirrors ensure_github_oauth for ORCID. ORCID has no pre-fillable
# registration form (and no API to create a client), so instead of a deep
# link we print the developer-tools URL plus the exact redirect URI to
# register by hand. Independent of GitHub: enabling ORCID alone still writes
# the shared OAUTH_CALLBACK_BASE_URL the server needs to build callback URLs.
ensure_orcid_oauth() {
  if [ -n "${ORCID_CLIENT_ID:-}" ] && [ -n "${ORCID_CLIENT_SECRET:-}" ]; then
    return 0
  fi

  local url callback
  url="https://${CUSTOM_DOMAIN}"
  callback="$url/auth/orcid/callback"

  echo ""
  echo "ORCID OAuth is not configured — \"Log in with ORCID\" is disabled."
  echo ""
  echo "To enable ORCID sign-in, register a public-API client in your ORCID"
  echo "account (the account needs a verified email, or Developer tools stays"
  echo "locked). ORCID has no pre-fillable form, so register it manually:"
  echo ""
  echo "  1. Sign in at https://orcid.org, then open https://orcid.org/developer-tools"
  echo "  2. Register for the public API and add this Redirect URI exactly:"
  echo "       $callback"
  echo "  3. Note the Client ID (APP-XXXXXXXXXXXXXXXX) and Client Secret."
  echo ""
  echo "(To test against the sandbox instead, register at https://sandbox.orcid.org"
  echo "and add ORCID_BASE_URL=https://sandbox.orcid.org to $ENV_FILE.)"
  echo ""

  if ! confirm "Register the client now and paste in its credentials?" y; then
    echo ""
    echo "Skipped. To enable ORCID later, add ORCID_CLIENT_ID, ORCID_CLIENT_SECRET,"
    echo "and OAUTH_CALLBACK_BASE_URL to $ENV_FILE and re-run ./scripts/deploy.sh."
    return 0
  fi

  ORCID_CLIENT_ID="$(prompt_with_default "Client ID")"
  local secret
  read -r -s -p "Client Secret: " secret
  echo ""
  ORCID_CLIENT_SECRET="$secret"
  # Persist the provider-agnostic callback base; the server derives ORCID's
  # callback ($url/auth/orcid/callback) — the URI registered above — from it.
  # Harmless to re-set if ensure_github_oauth already wrote the same value.
  OAUTH_CALLBACK_BASE_URL="$url/auth"
  upsert_env ORCID_CLIENT_ID "$ORCID_CLIENT_ID"
  upsert_env ORCID_CLIENT_SECRET "$ORCID_CLIENT_SECRET"
  upsert_env OAUTH_CALLBACK_BASE_URL "$OAUTH_CALLBACK_BASE_URL"

  echo ""
  echo "Pushing updated env to VM and restarting tcq.service..."
  deploy_to_vm
}

# Mirrors ensure_orcid_oauth for Google. Google's Cloud Console has no
# pre-fillable form (and the client must be created in a GCP project), so we
# print the credentials-page URL plus the exact redirect URI to register by
# hand. Independent of GitHub/ORCID: enabling Google alone still writes the
# shared OAUTH_CALLBACK_BASE_URL the server needs to build callback URLs.
ensure_google_oauth() {
  if [ -n "${GOOGLE_CLIENT_ID:-}" ] && [ -n "${GOOGLE_CLIENT_SECRET:-}" ]; then
    return 0
  fi

  local url callback
  url="https://${CUSTOM_DOMAIN}"
  callback="$url/auth/google/callback"

  echo ""
  echo "Google OAuth is not configured — \"Sign in with Google\" is disabled."
  echo ""
  echo "To enable Google sign-in, create an OAuth 2.0 client. Google has no"
  echo "pre-fillable form, so create it manually:"
  echo ""
  echo "  1. Open https://console.cloud.google.com/apis/credentials"
  echo "     (configure the OAuth consent screen first if prompted)."
  echo "  2. Create Credentials → OAuth client ID → Application type: Web application."
  echo "  3. Under \"Authorised redirect URIs\" add this URI exactly:"
  echo "       $callback"
  echo "  4. Note the Client ID and Client Secret."
  echo ""

  if ! confirm "Create the client now and paste in its credentials?" y; then
    echo ""
    echo "Skipped. To enable Google later, add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,"
    echo "and OAUTH_CALLBACK_BASE_URL to $ENV_FILE and re-run ./scripts/deploy.sh."
    return 0
  fi

  GOOGLE_CLIENT_ID="$(prompt_with_default "Client ID")"
  local secret
  read -r -s -p "Client Secret: " secret
  echo ""
  GOOGLE_CLIENT_SECRET="$secret"
  # Persist the provider-agnostic callback base; the server derives Google's
  # callback ($url/auth/google/callback) — the URI registered above — from it.
  # Harmless to re-set if ensure_github_oauth/ensure_orcid_oauth wrote the same.
  OAUTH_CALLBACK_BASE_URL="$url/auth"
  upsert_env GOOGLE_CLIENT_ID "$GOOGLE_CLIENT_ID"
  upsert_env GOOGLE_CLIENT_SECRET "$GOOGLE_CLIENT_SECRET"
  upsert_env OAUTH_CALLBACK_BASE_URL "$OAUTH_CALLBACK_BASE_URL"

  echo ""
  echo "Pushing updated env to VM and restarting tcq.service..."
  deploy_to_vm
}

# Mirrors ensure_google_oauth for Microsoft (Entra ID). Azure has no
# pre-fillable form, so we print the App-registrations URL plus the exact
# redirect URI to register by hand. Independent of the other providers:
# enabling Microsoft alone still writes the shared OAUTH_CALLBACK_BASE_URL the
# server needs to build callback URLs.
ensure_microsoft_oauth() {
  if [ -n "${MICROSOFT_CLIENT_ID:-}" ] && [ -n "${MICROSOFT_CLIENT_SECRET:-}" ]; then
    return 0
  fi

  local url callback
  url="https://${CUSTOM_DOMAIN}"
  callback="$url/auth/microsoft/callback"

  echo ""
  echo "Microsoft OAuth is not configured — \"Sign in with Microsoft\" is disabled."
  echo ""
  echo "To enable Microsoft sign-in, register an app. Microsoft has no"
  echo "pre-fillable form, so register it manually:"
  echo ""
  echo "  1. Open https://entra.microsoft.com → Identity → Applications →"
  echo "     App registrations → New registration."
  echo "  2. Supported account types: \"Accounts in any organizational directory"
  echo "     and personal Microsoft accounts\" (matches the default 'common' tenant)."
  echo "  3. Add a platform → Web → Redirect URI, exactly:"
  echo "       $callback"
  echo "  4. Under Certificates & secrets, add a client secret."
  echo "  5. Note the Application (client) ID and the secret VALUE."
  echo ""
  echo "(To restrict sign-in to one tenant, set MICROSOFT_TENANT in $ENV_FILE to"
  echo "your tenant id and pick the matching account type above.)"
  echo ""

  if ! confirm "Register the app now and paste in its credentials?" y; then
    echo ""
    echo "Skipped. To enable Microsoft later, add MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET,"
    echo "and OAUTH_CALLBACK_BASE_URL to $ENV_FILE and re-run ./scripts/deploy.sh."
    return 0
  fi

  MICROSOFT_CLIENT_ID="$(prompt_with_default "Application (client) ID")"
  local secret
  read -r -s -p "Client Secret: " secret
  echo ""
  MICROSOFT_CLIENT_SECRET="$secret"
  # Persist the provider-agnostic callback base; the server derives Microsoft's
  # callback ($url/auth/microsoft/callback) — the URI registered above — from it.
  # Harmless to re-set if an earlier ensure_*_oauth wrote the same value.
  OAUTH_CALLBACK_BASE_URL="$url/auth"
  upsert_env MICROSOFT_CLIENT_ID "$MICROSOFT_CLIENT_ID"
  upsert_env MICROSOFT_CLIENT_SECRET "$MICROSOFT_CLIENT_SECRET"
  upsert_env OAUTH_CALLBACK_BASE_URL "$OAUTH_CALLBACK_BASE_URL"

  echo ""
  echo "Pushing updated env to VM and restarting tcq.service..."
  deploy_to_vm
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  ensure_clean_working_tree
  ensure_gcloud
  ensure_auth

  if [ ! -f "$ENV_FILE" ]; then
    cat > "$ENV_FILE" <<'EOF'
# TCQ production environment — written and maintained by scripts/deploy.sh.
# Safe to edit by hand; the script only adds or updates keys it needs.
EOF
  fi

  load_env_file

  ensure_project_id
  ensure_region
  ensure_zone
  ensure_vm_name
  ensure_service_account_email
  ensure_session_secret
  ensure_store
  ensure_admin_usernames
  ensure_custom_domain

  ensure_project_exists
  ensure_billing_linked
  ensure_apis
  ensure_firestore
  ensure_session_ttl_policy
  ensure_service_account
  ensure_artifact_registry
  ensure_static_ip
  ensure_firewall_rules

  REGISTRY="${GCP_REGION}-docker.pkg.dev"
  IMAGE="${REGISTRY}/${GCP_PROJECT_ID}/tcq/${VM_NAME}:latest"

  build_and_push
  ensure_vm
  deploy_to_vm

  ensure_github_oauth
  ensure_orcid_oauth
  ensure_google_oauth
  ensure_microsoft_oauth

  echo ""
  echo "Deploy complete!"
  echo ""
  echo "Service URL:"
  get_service_url
}

main "$@"
