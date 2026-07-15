import { createHash, randomBytes } from 'node:crypto';

/** The RFC 8628 grant URN — the fallback path for boxes with no browser. */
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** The subset of RFC 8414 AS metadata the runner actually uses. */
export interface AsMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  device_authorization_endpoint?: string;
  grant_types_supported?: string[];
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export interface OAuthError {
  error: string;
  error_description?: string;
  interval?: number;
}

const b64url = (b: Buffer) => b.toString('base64url');

/** A PKCE verifier/challenge pair (S256 — the only method Noriq accepts). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export const randomState = (): string => b64url(randomBytes(16));

/** Fetch the authorization-server metadata (RFC 8414). */
export async function discover(server: string, fetchImpl: typeof fetch = fetch): Promise<AsMetadata> {
  const base = server.replace(/\/+$/, '');
  const res = await fetchImpl(`${base}/.well-known/oauth-authorization-server`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`${base} is not a Noriq server (discovery → ${res.status})`);
  const meta = (await res.json()) as AsMetadata;
  if (!meta.token_endpoint) throw new Error(`${base} returned no token_endpoint`);
  return meta;
}

export interface RegisterOptions {
  clientName: string;
  redirectUris?: string[];
  grantTypes?: string[];
}

/** Dynamic client registration (RFC 7591). Returns the client_id. */
export async function registerClient(
  meta: AsMetadata,
  opts: RegisterOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!meta.registration_endpoint) throw new Error('server does not support dynamic client registration');
  const res = await fetchImpl(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: opts.clientName,
      ...(opts.redirectUris?.length ? { redirect_uris: opts.redirectUris } : {}),
      ...(opts.grantTypes?.length ? { grant_types: opts.grantTypes } : {}),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    client_id?: string;
    error_description?: string;
    error?: string;
  };
  if (!res.ok || !body.client_id) {
    throw new Error(
      `client registration failed (${res.status}): ${body.error_description ?? body.error ?? 'unknown'}`,
    );
  }
  return body.client_id;
}

/** POST the token endpoint. Resolves the token on 2xx; returns the OAuth error otherwise
 *  (device polling needs to read `authorization_pending`/`slow_down`, not throw). */
export async function postToken(
  meta: AsMetadata,
  params: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; token: TokenResponse } | { ok: false; error: OAuthError; status: number }> {
  const res = await fetchImpl(meta.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok && typeof body.access_token === 'string')
    return { ok: true, token: body as unknown as TokenResponse };
  return {
    ok: false,
    status: res.status,
    error: {
      error: String(body.error ?? `http_${res.status}`),
      error_description: body.error_description ? String(body.error_description) : undefined,
      interval: typeof body.interval === 'number' ? body.interval : undefined,
    },
  };
}

/** Exchange a refresh token for a fresh pair. Noriq ROTATES: the old refresh token is
 *  revoked, so the caller must persist the new one or lock itself out. */
export async function refreshToken(
  meta: AsMetadata,
  clientId: string,
  refresh: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const out = await postToken(
    meta,
    { grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId },
    fetchImpl,
  );
  if (!out.ok)
    throw new Error(
      `token refresh failed: ${out.error.error}${out.error.error_description ? ` — ${out.error.error_description}` : ''}`,
    );
  return out.token;
}
