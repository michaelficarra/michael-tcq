import type { RequestHandler } from 'express';

// Returns the SHA1 of the deployed commit, injected via GIT_SHA by
// scripts/deploy.sh. When absent (local dev, tests, any non-deployed run),
// respond 204 to signal "no deployed commit applies here".
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
    res.json({ sha });
    return;
  }
  res.type('text/plain').send(sha);
};
