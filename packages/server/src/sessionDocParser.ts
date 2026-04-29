/**
 * Custom doc parser for the firestore-store session store.
 *
 * The upstream default parser writes only `{ session: "<JSON>" }`, with no
 * top-level Timestamp field, so a Firestore TTL policy cannot be applied to
 * it (TTL requires a queryable top-level Timestamp). We extend the doc with
 * an `expireAt` Timestamp so that a TTL policy on `sessions.expireAt` can
 * automatically delete expired session documents.
 *
 * The parser interface is the one declared by firestore-store:
 *   { read(doc): session, save(session): doc }
 * See node_modules/firestore-store/lib/firestore-store.js.
 */

import { Timestamp } from '@google-cloud/firestore';

/**
 * `expireAt` is intentionally set 24 hours later than the express-session
 * cookie expiry. The buffer guards against the race where express-session
 * is still willing to accept a cookie but Firestore has already deleted the
 * backing document. Firestore TTL deletion is best-effort and may run up to
 * ~24h after the timestamp passes, so the explicit buffer is layered on top
 * of that to give plenty of headroom.
 */
export const TTL_BUFFER_MS = 24 * 60 * 60 * 1000;

interface SessionDoc {
  session: string;
  expireAt: Timestamp;
}

/**
 * Coerce a value that should be a `Date` (but might be an ISO string after a
 * JSON round-trip) to a `Date`. Returns null for missing or unparseable input.
 */
function asDate(raw: unknown): Date | null {
  if (raw == null) return null;
  const d = raw instanceof Date ? raw : typeof raw === 'string' ? new Date(raw) : null;
  return d !== null && !Number.isNaN(d.getTime()) ? d : null;
}

/**
 * Best-effort cookie-expiry derivation. Falls back to `originalMaxAge` if
 * `cookie.expires` is missing — this can happen for sessions written before
 * express-session has fully populated the cookie (rare, but worth handling).
 */
function deriveExpiry(session: unknown): Date {
  const cookie = (session as { cookie?: unknown }).cookie as
    | { expires?: unknown; originalMaxAge?: unknown }
    | undefined;
  const explicit = asDate(cookie?.expires);
  if (explicit !== null) return explicit;
  const maxAge = cookie?.originalMaxAge;
  return new Date(Date.now() + (typeof maxAge === 'number' ? maxAge : 0));
}

export const sessionDocParser = {
  read(doc: unknown): unknown {
    // Mirror the upstream parser: only the JSON-stringified session payload
    // is meaningful to express-session. `expireAt` is metadata for TTL.
    return JSON.parse((doc as SessionDoc).session);
  },

  save(session: unknown): SessionDoc {
    const expiry = new Date(deriveExpiry(session).getTime() + TTL_BUFFER_MS);
    return {
      session: JSON.stringify(session),
      expireAt: Timestamp.fromDate(expiry),
    };
  },
};
