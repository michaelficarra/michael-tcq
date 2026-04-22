#!/usr/bin/env bash
#
# Build, push, and deploy TCQ to Google Cloud Run.
#
# On first run, or any time a required field is missing from .env.production,
# the script walks the user through setup interactively:
#
#   - installs gcloud (via Homebrew or the official tarball) if missing,
#   - prompts for GCP project ID, region, admin usernames, etc.,
#   - creates the project, links a billing account (chosen from a menu),
#   - enables APIs, creates the Firestore database, service account, and
#     Artifact Registry repo (all idempotent — safe to re-run),
#   - generates SESSION_SECRET and writes .env.production,
#   - builds and deploys,
#   - prints a pre-filled GitHub OAuth App registration URL and, once the
#     user pastes in the Client ID and Client Secret, redeploys with real
#     GitHub auth enabled.
#
# Re-runs with a fully populated .env.production skip every prompt and
# behave as a straight build + push + deploy.
#
# Fields read from .env.production:
#
#   Required (prompted if missing):
#     GCP_PROJECT_ID, GCP_REGION, GCP_SERVICE_ACCOUNT, CLOUD_RUN_SERVICE,
#     SESSION_SECRET, STORE, ADMIN_USERNAMES
#
#   Optional:
#     FIRESTORE_DATABASE_ID, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET,
#     GITHUB_CALLBACK_URL
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
# Leaves RFC 3986 unreserved characters (A-Z a-z 0-9 - . _ ~) as-is; every
# other byte is emitted as %HH.
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

# Download and install the Google Cloud SDK tarball into $HOME.
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

# If Homebrew is available, install the cask and locate the bin directory.
# Returns 0 on success, non-zero if brew isn't present or the bin can't be
# located (caller should fall back to the tarball installer).
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
  echo "It's required to provision GCP resources and deploy to Cloud Run."
  if ! confirm "Install gcloud now?" y; then
    echo "Install it manually and re-run: https://cloud.google.com/sdk/docs/install" >&2
    exit 1
  fi
  # Prefer Homebrew on systems that have it; fall back to the official tarball.
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

# Fail fast if the user hasn't run `gcloud auth login`. We don't invoke
# `gcloud auth login` from inside the script because it opens a browser
# and handles poorly when the script itself is driving an interactive flow.
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
    # us-east1, us-central1, and us-west1 are free-tier-eligible for Firestore.
    GCP_REGION="$(prompt_with_default "GCP region" "us-central1")"
    upsert_env GCP_REGION "$GCP_REGION"
  fi
}

ensure_service_name() {
  if [ -z "${CLOUD_RUN_SERVICE:-}" ]; then
    CLOUD_RUN_SERVICE="$(prompt_with_default "Cloud Run service name" "tcq")"
    upsert_env CLOUD_RUN_SERVICE "$CLOUD_RUN_SERVICE"
  fi
}

# SA email is derived — no prompt needed.
ensure_service_account_email() {
  if [ -z "${GCP_SERVICE_ACCOUNT:-}" ]; then
    GCP_SERVICE_ACCOUNT="tcq-cloudrun@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
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

# Admin usernames are optional server-side, but without any entry nobody gets
# admin access — so prompt, but let the user skip with a blank answer.
ensure_admin_usernames() {
  if [ -z "${ADMIN_USERNAMES:-}" ]; then
    read -r -p "GitHub usernames to grant admin access (comma-separated, blank to skip): " ADMIN_USERNAMES
    if [ -n "$ADMIN_USERNAMES" ]; then
      upsert_env ADMIN_USERNAMES "$ADMIN_USERNAMES"
    fi
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
  echo "Cloud Run and Artifact Registry require one, even though TCQ fits"
  echo "comfortably inside the always-free tier."
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
  local needed=(firestore.googleapis.com run.googleapis.com artifactregistry.googleapis.com)
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

ensure_service_account() {
  if ! gcloud iam service-accounts describe "$GCP_SERVICE_ACCOUNT" \
         --project="$GCP_PROJECT_ID" >/dev/null 2>&1; then
    echo "Creating service account tcq-cloudrun..."
    gcloud iam service-accounts create tcq-cloudrun \
      --display-name="TCQ Cloud Run" \
      --project="$GCP_PROJECT_ID"
  fi
  # Both bindings are idempotent — re-applying a present binding is a no-op.
  gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
    --member="serviceAccount:$GCP_SERVICE_ACCOUNT" \
    --role="roles/datastore.user" \
    --condition=None \
    >/dev/null
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
  # Registers a Docker credential helper for this registry host. Idempotent.
  gcloud auth configure-docker "${GCP_REGION}-docker.pkg.dev" --quiet >/dev/null
}

# ---------------------------------------------------------------------------
# Build, push, deploy
# ---------------------------------------------------------------------------

compute_env_vars() {
  ENV_VARS="STORE=${STORE:-firestore}"
  ENV_VARS+=",SESSION_SECRET=${SESSION_SECRET}"
  [ -n "${GITHUB_CLIENT_ID:-}" ]       && ENV_VARS+=",GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID}"
  [ -n "${GITHUB_CLIENT_SECRET:-}" ]   && ENV_VARS+=",GITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET}"
  [ -n "${GITHUB_CALLBACK_URL:-}" ]    && ENV_VARS+=",GITHUB_CALLBACK_URL=${GITHUB_CALLBACK_URL}"
  [ -n "${FIRESTORE_DATABASE_ID:-}" ]  && ENV_VARS+=",FIRESTORE_DATABASE_ID=${FIRESTORE_DATABASE_ID}"
  [ -n "${ADMIN_USERNAMES:-}" ]        && ENV_VARS+=",ADMIN_USERNAMES=${ADMIN_USERNAMES}"
}

build_and_push() {
  echo ""
  echo "Building Docker image for linux/amd64..."
  docker build --platform linux/amd64 -t "$IMAGE" "$PROJECT_ROOT"
  echo ""
  echo "Pushing image to $REGISTRY..."
  docker push "$IMAGE"
}

deploy_service() {
  compute_env_vars
  echo ""
  echo "Deploying to Cloud Run..."
  gcloud run deploy "$CLOUD_RUN_SERVICE" \
    --project="$GCP_PROJECT_ID" \
    --image="$IMAGE" \
    --region="$GCP_REGION" \
    --service-account="$GCP_SERVICE_ACCOUNT" \
    --allow-unauthenticated \
    --set-env-vars "$ENV_VARS" \
    --timeout 3600 \
    --session-affinity
}

get_service_url() {
  gcloud run services describe "$CLOUD_RUN_SERVICE" \
    --project="$GCP_PROJECT_ID" \
    --region="$GCP_REGION" \
    --format='value(status.url)'
}

# ---------------------------------------------------------------------------
# Post-deploy: prompt for GitHub OAuth App credentials if missing.
# ---------------------------------------------------------------------------
# Creating an OAuth App is the only remaining web-UI step — GitHub's API
# doesn't expose OAuth App registration, and the `gh` CLI has no command
# for it. We drive the user there with a pre-filled URL, collect the
# credentials they paste back, write them to .env.production, and redeploy.

ensure_github_oauth() {
  if [ -n "${GITHUB_CLIENT_ID:-}" ] && [ -n "${GITHUB_CLIENT_SECRET:-}" ]; then
    return 0
  fi

  local url callback
  url="$(get_service_url)"
  if [ -z "$url" ]; then
    echo "Couldn't determine service URL; skipping OAuth setup." >&2
    return 0
  fi
  callback="$url/auth/github/callback"

  echo ""
  echo "GitHub OAuth is not configured — the server is running in mock auth mode."
  echo ""
  echo "To enable real GitHub sign-in, register a new OAuth App. The link below"
  echo "pre-fills the form; just click Register application:"
  echo ""
  # The key names contain [ and ], which are reserved in RFC 3986 and must
  # be encoded; the URL values also get encoded so : and / in them are safe
  # inside a query component.
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
    echo "and GITHUB_CALLBACK_URL to $ENV_FILE and re-run ./scripts/deploy.sh."
    return 0
  fi

  GITHUB_CLIENT_ID="$(prompt_with_default "Client ID")"
  local secret
  read -r -s -p "Client Secret: " secret
  echo ""
  GITHUB_CLIENT_SECRET="$secret"
  GITHUB_CALLBACK_URL="$callback"
  upsert_env GITHUB_CLIENT_ID "$GITHUB_CLIENT_ID"
  upsert_env GITHUB_CLIENT_SECRET "$GITHUB_CLIENT_SECRET"
  upsert_env GITHUB_CALLBACK_URL "$GITHUB_CALLBACK_URL"

  echo ""
  echo "Redeploying with GitHub OAuth enabled..."
  deploy_service
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  ensure_clean_working_tree
  ensure_gcloud
  ensure_auth

  # Seed an empty .env.production with a header the first time through.
  if [ ! -f "$ENV_FILE" ]; then
    cat > "$ENV_FILE" <<'EOF'
# TCQ production environment — written and maintained by scripts/deploy.sh.
# Safe to edit by hand; the script only adds or updates keys it needs.
EOF
  fi

  load_env_file

  # Collect (or confirm) every required field, writing back to the env file
  # as we go so partial progress survives Ctrl-C.
  ensure_project_id
  ensure_region
  ensure_service_name
  ensure_service_account_email
  ensure_session_secret
  ensure_store
  ensure_admin_usernames

  # Idempotent provisioning — each step checks whether the resource exists
  # before creating it.
  ensure_project_exists
  ensure_billing_linked
  ensure_apis
  ensure_firestore
  ensure_service_account
  ensure_artifact_registry

  REGISTRY="${GCP_REGION}-docker.pkg.dev"
  IMAGE="${REGISTRY}/${GCP_PROJECT_ID}/tcq/${CLOUD_RUN_SERVICE}:latest"

  build_and_push
  deploy_service

  ensure_github_oauth

  echo ""
  echo "Deploy complete!"
  echo ""
  echo "Service URL:"
  get_service_url
}

main "$@"
