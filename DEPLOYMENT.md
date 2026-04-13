# Deploying TCQ

> **Status:** Cloud Run and Firestore deployment are not yet configured. GitHub OAuth setup is documented below.

TCQ will be deployed as a single Docker container on Google Cloud Run, with Firestore for persistent storage. See [ARCHITECTURE.md](ARCHITECTURE.md) for the rationale behind these choices.

## GitHub OAuth App

TCQ uses GitHub OAuth for authentication. You need to register a GitHub OAuth App for each environment (development, production).

### Development OAuth App

This is optional — without it, the server runs in mock auth mode with a fake user. Configure it when you want to test real GitHub login locally.

1. Go to [GitHub Developer Settings > OAuth Apps](https://github.com/settings/developers).
2. Click **New OAuth App**.
3. Fill in:
   - **Application name:** `TCQ (Development)`
   - **Homepage URL:** `http://localhost:5173`
   - **Authorization callback URL:** `http://localhost:3000/auth/github/callback`
4. Click **Register application**.
5. On the app's settings page, note the **Client ID**.
6. Click **Generate a new client secret** and copy it immediately — it is shown only once.
7. Add both values to your `.env` file:
   ```
   GITHUB_CLIENT_ID=<your client id>
   GITHUB_CLIENT_SECRET=<your client secret>
   ```

### Production OAuth App

Register a separate OAuth App for your production deployment.

1. Go to [GitHub Developer Settings > OAuth Apps](https://github.com/settings/developers).
2. Click **New OAuth App**.
3. Fill in:
   - **Application name:** `TCQ`
   - **Homepage URL:** `https://<your-production-url>`
   - **Authorization callback URL:** `https://<your-production-url>/auth/github/callback`
4. Click **Register application**.
5. Note the **Client ID** and generate a **Client Secret**.
6. These values will be set as environment variables when deploying to Cloud Run (see below).

> **Note:** After your first Cloud Run deployment, you'll know the service URL. Come back and update the Homepage URL and callback URL to match.
