import type { RequestHandler } from 'express';

// Returns the SHA1 of the deployed commit, injected via GIT_SHA by
// scripts/deploy.sh. When absent (local dev, tests, any non-deployed run),
// respond 204 to signal "no deployed commit applies here".
//
// JSON responses also include `revision`, the Cloud Run revision name from
// the K_REVISION env var that Cloud Run injects automatically. The client
// polls this to detect that it's still connected (via WebSocket) to a
// running-but-not-yet-killed old revision after a redeploy. `revision`
// changes on every deploy even when the commit doesn't (e.g. an env-var
// or scaling change with the same image), which `sha` would miss.
export const versionHandler: RequestHandler = (req, res) => {
  const sha = process.env.GIT_SHA;
  if (sha == null || sha === '') {
    res.status(204).send();
    return;
  }
  // Plain text is the default; upgrade to JSON only when the client's Accept
  // header ranks application/json above text/plain. req.accepts returns the
  // first type from the list when the client has no preference (e.g. */* or
  // missing Accept), so text/plain wins by default.
  if (req.accepts(['text/plain', 'application/json']) === 'application/json') {
    const revision = process.env.K_REVISION ?? null;
    res.json({ sha, revision });
    return;
  }
  res.type('text/plain').send(sha);
};
