# Deploying TCQ

TCQ is deployed as a single Docker container on Google Cloud Run, with Firestore for persistent storage. See [ARCHITECTURE.md](ARCHITECTURE.md) for the rationale behind these choices.

Deployment is done via the `scripts/deploy.sh` script, which reads configuration from `.env.production`.

## Environment Files

TCQ uses environment-specific `.env` files:

| File | Purpose | Committed to git? |
|------|---------|-------------------|
| `.env.development` | Local development defaults (no secrets) | Yes |
| `.env.production` | Production config and secrets | No (gitignored) |

The server loads `.env.development` or `.env.production` based on `NODE_ENV`. In development (`npm run dev`), `NODE_ENV` is unset so `.env.development` is used. In production (`NODE_ENV=production`), `.env.production` is used.

## Prerequisites

- A [Google Cloud](https://cloud.google.com/) account
- The [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) (`gcloud`) installed
- [Docker](https://docs.docker.com/get-docker/) installed locally

## First-Time Setup

### 1. Create a GCP Project

```sh
gcloud projects create <your-project-id> --name="TCQ"
gcloud config set project <your-project-id>
```

You may need to [link a billing account](https://console.cloud.google.com/billing) to the project. Firestore and Cloud Run have Always Free tiers.

### 2. Enable Required APIs

```sh
gcloud services enable firestore.googleapis.com run.googleapis.com artifactregistry.googleapis.com
```

### 3. Create a Firestore Database

```sh
gcloud firestore databases create --location=us-central1
```

Or with a custom database ID:

```sh
gcloud firestore databases create --location=us-central1 --database=<your-database-id>
```

Use a free-tier eligible region: `us-east1`, `us-central1`, or `us-west1`.

### 4. Create a Service Account for Cloud Run

```sh
gcloud iam service-accounts create tcq-cloudrun --display-name="TCQ Cloud Run"

gcloud projects add-iam-policy-binding <your-project-id> \
  --member="serviceAccount:tcq-cloudrun@<your-project-id>.iam.gserviceaccount.com" \
  --role="roles/datastore.user"

gcloud projects add-iam-policy-binding <your-project-id> \
  --member="user:$(gcloud config get account)" \
  --role="roles/iam.serviceAccountUser"
```

### 5. Create an Artifact Registry Repository

```sh
gcloud artifacts repositories create tcq --repository-format=docker --location=us-central1
gcloud auth configure-docker us-central1-docker.pkg.dev
```

### 6. Create `.env.production`

Create `.env.production` in the project root with the deployment fields:

```
# Production environment
ADMIN_USERNAMES=your-github-username

# Persistence
STORE=firestore
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
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

Leave the `GITHUB_*` fields out for now — they require the Cloud Run URL, which you won't have until after the first deploy.

### 7. First Deploy (Without OAuth)

```sh
./scripts/deploy.sh
```

This builds the Docker image, pushes it to Artifact Registry, and deploys to Cloud Run. The script will warn that GitHub OAuth is not configured — the server will run in mock auth mode.

Note the **service URL** printed at the end of the deploy.

### 8. Create a Production GitHub OAuth App

Now that you have the Cloud Run URL, register an OAuth App:

1. Go to [GitHub Developer Settings > OAuth Apps](https://github.com/settings/developers).
2. Click **New OAuth App**.
3. Fill in:
   - **Application name:** `TCQ`
   - **Homepage URL:** `https://<your-cloud-run-url>`
   - **Authorization callback URL:** `https://<your-cloud-run-url>/auth/github/callback`
4. Click **Register application**.
5. Note the **Client ID** and generate a **Client Secret**.

### 9. Redeploy with OAuth

Add the GitHub OAuth credentials to `.env.production`:

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
- **Firestore credentials** — Cloud Run's service account has Firestore access via the IAM role granted in step 4. No key file needed in production.

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
