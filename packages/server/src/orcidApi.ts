/**
 * Thin client for ORCID's **public** API (`pub.orcid.org`), used by the ORCID
 * provider to (a) look up a researcher's public record by iD — for the
 * display name, public email (→ Gravatar), and current employer — and (b)
 * search the registry by name/affiliation for the user-selector dropdown.
 *
 * The public API requires a bearer token obtained via the client-credentials
 * grant with the `/read-public` scope. ORCID's read-public tokens are
 * effectively non-expiring, but we cache with the returned `expires_in` and
 * transparently re-fetch on a 401, so a revoked/rotated token self-heals.
 *
 * Everything here is best-effort: a network/parse failure returns empty data
 * (login still succeeds with the iD + name from the OAuth token response, and
 * search degrades to no results) rather than throwing.
 */

import { warning, info, serialiseError } from './logger.js';

// -- Endpoints -----------------------------------------------------------

/** OAuth/login host, e.g. `https://orcid.org` (prod) or
 *  `https://sandbox.orcid.org`. Overridable via `ORCID_BASE_URL` for sandbox. */
export function orcidBase(): string {
  return (process.env.ORCID_BASE_URL ?? 'https://orcid.org').replace(/\/+$/, '');
}

/** Public-API base derived from the OAuth host (`orcid.org` → `pub.orcid.org`). */
export function orcidPubBase(): string {
  return `${orcidBase().replace('://', '://pub.')}/v3.0`;
}

// -- Test seam -----------------------------------------------------------

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (input, init) => fetch(input, init);

/** Replace the fetch implementation (tests). Returns a restorer. */
export function setOrcidFetchForTesting(impl: FetchLike): () => void {
  const previous = fetchImpl;
  fetchImpl = impl;
  return () => {
    fetchImpl = previous;
  };
}

/** Clear the cached read-public token (tests). */
export function resetOrcidApiForTesting(): void {
  cachedToken = null;
}

// -- read-public client-credentials token --------------------------------

interface CachedToken {
  token: string;
  expiresAt: number;
}
let cachedToken: CachedToken | null = null;
let inflightToken: Promise<string | null> | null = null;

async function fetchReadPublicToken(): Promise<string | null> {
  const body = new URLSearchParams({
    client_id: process.env.ORCID_CLIENT_ID ?? '',
    client_secret: process.env.ORCID_CLIENT_SECRET ?? '',
    grant_type: 'client_credentials',
    scope: '/read-public',
  });
  let res: Response;
  try {
    res = await fetchImpl(`${orcidBase()}/oauth/token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    warning('orcid_token_fetch_failed', { error: serialiseError(err) });
    return null;
  }
  if (!res.ok) {
    warning('orcid_token_fetch_failed', { status: res.status });
    return null;
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) return null;
  // Refresh a minute before the stated expiry; default to 1h if unstated.
  const ttlMs = (data.expires_in ?? 3600) * 1000;
  cachedToken = { token: data.access_token, expiresAt: Date.now() + ttlMs - 60_000 };
  return data.access_token;
}

/** Get a valid read-public token, coalescing concurrent fetches. */
async function getReadPublicToken(forceRefresh = false): Promise<string | null> {
  if (!forceRefresh && cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;
  if (inflightToken) return inflightToken;
  if (forceRefresh) cachedToken = null;
  inflightToken = fetchReadPublicToken().finally(() => {
    inflightToken = null;
  });
  return inflightToken;
}

/** Warm the cached read-public token (fire-and-forget at ORCID login). */
export async function primeOrcidToken(): Promise<void> {
  await getReadPublicToken();
}

/** GET a public-API path returning parsed JSON, or null. Retries once after a
 *  forced token refresh on a 401 (revoked/rotated credential). */
async function pubGet<T>(path: string): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getReadPublicToken(attempt === 1);
    if (!token) return null;
    let res: Response;
    try {
      res = await fetchImpl(`${orcidPubBase()}${path}`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      warning('orcid_pub_fetch_failed', { path, error: serialiseError(err) });
      return null;
    }
    if (res.status === 401 && attempt === 0) {
      info('orcid_token_rejected_retrying', {});
      continue;
    }
    if (!res.ok) {
      warning('orcid_pub_fetch_failed', { path, status: res.status });
      return null;
    }
    return (await res.json()) as T;
  }
  return null;
}

// -- Public-record lookup ------------------------------------------------

export interface OrcidPublicProfile {
  name?: string;
  email?: string;
  organisation?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- ORCID v3.0 JSON is deeply
   nested and weakly typed; we drill defensively with optional chaining. */

/** Compose a display name from an ORCID `person.name` block. */
function composeName(name: any): string | undefined {
  const credit = name?.['credit-name']?.value;
  if (typeof credit === 'string' && credit.trim()) return credit;
  const given = name?.['given-names']?.value ?? '';
  const family = name?.['family-name']?.value ?? '';
  const full = `${given} ${family}`.trim();
  return full || undefined;
}

/** Fetch a researcher's public record: display name, first public email, and
 *  most-recently-listed employer. Any missing field is simply omitted. */
export async function fetchOrcidPublic(id: string): Promise<OrcidPublicProfile> {
  const record = await pubGet<any>(`/${encodeURIComponent(id)}/record`);
  if (!record) return {};
  const out: OrcidPublicProfile = {};
  const name = composeName(record.person?.name);
  if (name) out.name = name;
  // The public API only returns emails the researcher set to public.
  const email = record.person?.emails?.email?.[0]?.email;
  if (typeof email === 'string' && email.trim()) out.email = email;
  // First listed employment's organisation (best-effort; not strictly recency-sorted).
  const org =
    record['activities-summary']?.employments?.['affiliation-group']?.[0]?.summaries?.[0]?.['employment-summary']
      ?.organization?.name;
  if (typeof org === 'string' && org.trim()) out.organisation = org;
  return out;
}

// -- Registry search -----------------------------------------------------

export interface OrcidSearchResult {
  id: string;
  name: string;
  organisation: string;
}

/** Search the ORCID registry by name/affiliation via `expanded-search`. */
export async function orcidExpandedSearch(query: string, limit: number): Promise<OrcidSearchResult[]> {
  const q = query.trim();
  if (q.length === 0) return [];
  const params = new URLSearchParams({ q, rows: String(limit) });
  const data = await pubGet<any>(`/expanded-search/?${params}`);
  const results: any[] = data?.['expanded-result'] ?? [];
  return results.map((r) => {
    const credit = typeof r['credit-name'] === 'string' ? r['credit-name'].trim() : '';
    const full = `${r['given-names'] ?? ''} ${r['family-names'] ?? ''}`.trim();
    const id = String(r['orcid-id'] ?? '');
    return {
      id,
      name: credit || full || id,
      organisation: (r['institution-name']?.[0] ?? '').toString(),
    };
  });
}

/* eslint-enable @typescript-eslint/no-explicit-any */
