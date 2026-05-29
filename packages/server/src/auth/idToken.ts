/**
 * Minimal OpenID Connect `id_token` decoding, shared by the OIDC providers
 * (`./google.ts`, `./microsoft.ts`).
 *
 * Both decode the JWT payload but deliberately do **not** verify its signature:
 * for the authorization-code flow, the id_token is received directly from the
 * provider's token endpoint over TLS, which authenticates the provider — per
 * Google's and Microsoft's own guidance. Each provider validates the claims it
 * cares about (notably a non-empty `sub`) after decoding.
 */

/**
 * Decode (without verifying) the payload of an OIDC id_token. A JWT is
 * `header.payload.signature`; the middle segment is base64url-encoded JSON.
 * Returns the claims object, or `null` on any structural problem (wrong
 * segment count, bad base64, or non-object JSON).
 */
export function decodeIdTokenPayload(jwt: string): Record<string, unknown> | null {
  const segments = jwt.split('.');
  if (segments.length !== 3) return null;
  try {
    const json = Buffer.from(segments[1], 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
