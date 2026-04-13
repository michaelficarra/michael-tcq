# Deploying TCQ

> **Status:** Firestore persistence is implemented. Cloud Run deployment (Dockerfile, deploy commands) is not yet configured.

TCQ is deployed as a single Docker container on Google Cloud Run, with Firestore for persistent storage. See [ARCHITECTURE.md](ARCHITECTURE.md) for the rationale behind these choices.

## Prerequisites

- A [Google Cloud](https://cloud.google.com/) account
- The [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) (`gcloud`) installed
- [Docker](https://docs.docker.com/get-docker/) installed locally

## Google Cloud Project Setup

These steps only need to be done once.

### 1. Create a GCP Project

1. Go to [Create a project](https://console.cloud.google.com/projectcreate).
2. Enter a project name (e.g. `tcq`) and click **Create**.
3. Note the **Project ID** (e.g. `tcq-123456`).

### 2. Authenticate the CLI

```sh
gcloud auth login
gcloud config set project <your-project-id>
```

### 3. Enable Required APIs

```sh
gcloud services enable firestore.googleapis.com run.googleapis.com artifactregistry.googleapis.com
```

## Firestore Database

TCQ uses Firestore in Native mode for meeting state persistence and session storage.

### Create the Database

1. Go to [Firestore](https://console.cloud.google.com/firestore) in the Cloud Console.
2. Choose **Native mode** (not Datastore mode).
3. Select a free-tier eligible region: `us-east1`, `us-central1`, or `us-west1`.
4. Click **Create Database**.

### Service Account for Local Development

To test Firestore locally (with `STORE=firestore`), you need a service account key:

1. Go to [Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts).
2. Click **Create Service Account**.
3. Name: `tcq-dev`. Click **Create and Continue**.
4. Grant the role **Cloud Datastore User** (covers Firestore Native mode). Click **Continue**, then **Done**.
5. Click the new service account, go to the **Keys** tab.
6. Click **Add Key > Create new key**, select **JSON**, click **Create**.
7. Save the downloaded file as `service-account.json` in the project root (already in `.gitignore`).
8. Add to your `.env`:
   ```
   STORE=firestore
   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
   ```

> **Note:** In production on Cloud Run, the default service account has Firestore access automatically — no key file needed.

## GitHub OAuth App

TCQ uses GitHub OAuth for authentication. You need a separate OAuth App for each environment.

### Development OAuth App

Optional — without it, the server runs in mock auth mode. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

### Production OAuth App

1. Go to [GitHub Developer Settings > OAuth Apps](https://github.com/settings/developers).
2. Click **New OAuth App**.
3. Fill in:
   - **Application name:** `TCQ`
   - **Homepage URL:** `https://<your-production-url>`
   - **Authorization callback URL:** `https://<your-production-url>/auth/github/callback`
4. Click **Register application**.
5. Note the **Client ID** and generate a **Client Secret**.

> **Note:** After your first Cloud Run deployment, you'll know the service URL. Come back and update the URLs to match.

## Cloud Run Deployment

*Coming in Step 13.*
