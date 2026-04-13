#!/usr/bin/env bash
#
# Build, push, and deploy TCQ to Google Cloud Run.
#
# Reads configuration from .env in the project root. Required fields:
#
#   GCP_PROJECT_ID          — GCP project ID (e.g. mtcq-493203)
#   GCP_REGION              — GCP region (e.g. us-central1)
#   GCP_SERVICE_ACCOUNT     — Cloud Run service account email
#   CLOUD_RUN_SERVICE       — Cloud Run service name (e.g. tcq)
#   FIRESTORE_DATABASE_ID   — Firestore database ID (omit for default)
#   PROD_SESSION_SECRET     — Session secret for production
#   PROD_GITHUB_CLIENT_ID   — GitHub OAuth client ID (production)
#   PROD_GITHUB_CLIENT_SECRET — GitHub OAuth client secret (production)
#   PROD_GITHUB_CALLBACK_URL  — GitHub OAuth callback URL (production)
#
# Usage:
#   ./scripts/deploy.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"

# --- Load .env ---
if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env file not found at $ENV_FILE" >&2
  echo "Copy .env.example to .env and fill in the deployment fields." >&2
  exit 1
fi

# Source .env, ignoring comments and empty lines
set -a
while IFS= read -r line; do
  # Skip comments and blank lines
  [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
  eval "$line"
done < "$ENV_FILE"
set +a

# --- Validate required fields ---
missing=()
[ -z "${GCP_PROJECT_ID:-}" ] && missing+=(GCP_PROJECT_ID)
[ -z "${GCP_REGION:-}" ] && missing+=(GCP_REGION)
[ -z "${GCP_SERVICE_ACCOUNT:-}" ] && missing+=(GCP_SERVICE_ACCOUNT)
[ -z "${CLOUD_RUN_SERVICE:-}" ] && missing+=(CLOUD_RUN_SERVICE)
[ -z "${PROD_SESSION_SECRET:-}" ] && missing+=(PROD_SESSION_SECRET)

if [ ${#missing[@]} -gt 0 ]; then
  echo "Error: missing required fields in .env:" >&2
  printf '  %s\n' "${missing[@]}" >&2
  exit 1
fi

# GitHub OAuth fields are optional for the first deploy. Without them,
# the server runs in mock auth mode. Once you have the Cloud Run URL,
# create a GitHub OAuth App, fill in the PROD_GITHUB_* fields, and
# redeploy.
if [ -z "${PROD_GITHUB_CLIENT_ID:-}" ]; then
  echo "Warning: PROD_GITHUB_CLIENT_ID is not set — deploying with mock auth."
  echo "         After deploy, note the service URL, create a GitHub OAuth App,"
  echo "         fill in PROD_GITHUB_* fields in .env, and redeploy."
  echo ""
fi

# --- Derived values ---
REGISTRY="${GCP_REGION}-docker.pkg.dev"
IMAGE="${REGISTRY}/${GCP_PROJECT_ID}/tcq/${CLOUD_RUN_SERVICE}:latest"

# Build the env vars string for Cloud Run
ENV_VARS="STORE=firestore"
ENV_VARS+=",SESSION_SECRET=${PROD_SESSION_SECRET}"
if [ -n "${PROD_GITHUB_CLIENT_ID:-}" ]; then
  ENV_VARS+=",GITHUB_CLIENT_ID=${PROD_GITHUB_CLIENT_ID}"
fi
if [ -n "${PROD_GITHUB_CLIENT_SECRET:-}" ]; then
  ENV_VARS+=",GITHUB_CLIENT_SECRET=${PROD_GITHUB_CLIENT_SECRET}"
fi
if [ -n "${PROD_GITHUB_CALLBACK_URL:-}" ]; then
  ENV_VARS+=",GITHUB_CALLBACK_URL=${PROD_GITHUB_CALLBACK_URL}"
fi
if [ -n "${FIRESTORE_DATABASE_ID:-}" ]; then
  ENV_VARS+=",FIRESTORE_DATABASE_ID=${FIRESTORE_DATABASE_ID}"
fi

# --- Build ---
echo "Building Docker image for linux/amd64..."
docker build --platform linux/amd64 -t "$IMAGE" "$PROJECT_ROOT"

# --- Push ---
echo ""
echo "Pushing image to $REGISTRY..."
docker push "$IMAGE"

# --- Deploy ---
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

echo ""
echo "Deploy complete!"
echo ""
echo "Service URL:"
gcloud run services describe "$CLOUD_RUN_SERVICE" \
  --project="$GCP_PROJECT_ID" \
  --region="$GCP_REGION" \
  --format='value(status.url)'
