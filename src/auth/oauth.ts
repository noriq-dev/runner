import { createHash, randomBytes } from "node:crypto";

export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface AuthorizationMetadata {
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

function normalizeServer(server: string): URL {
  const value = new URL(server);
  value.pathname = value.pathname.replace(/\/+$/, "");
  value.search = "";
  value.hash = "";
  const local =
    value.hostname === "localhost" ||
    value.hostname === "127.0.0.1" ||
    value.hostname === "::1";
  if (value.protocol !== "https:" && !(local && value.protocol === "http:"))
    throw new Error(
      "Noriq OAuth requires HTTPS, except for loopback development servers",
    );
  return value;
}

function trustedEndpoint(server: URL, raw: string, name: string): string {
  const endpoint = new URL(raw);
  if (endpoint.origin !== server.origin)
    throw new Error(`${name} must use the configured Noriq server origin`);
  if (endpoint.protocol !== "https:" && server.protocol !== "http:")
    throw new Error(`${name} must use HTTPS`);
  return endpoint.toString();
}

export function canonicalServer(server: string): string {
  return normalizeServer(server).toString().replace(/\/$/, "");
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

export function randomState(): string {
  return randomBytes(16).toString("base64url");
}

export async function discover(
  server: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AuthorizationMetadata> {
  const base = normalizeServer(server);
  const response = await fetchImpl(
    new URL("/.well-known/oauth-authorization-server", base),
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok)
    throw new Error(
      `${base.origin} is not a Noriq server (OAuth discovery returned ${response.status})`,
    );
  const value = (await response.json()) as Partial<AuthorizationMetadata>;
  if (!value.issuer || !value.authorization_endpoint || !value.token_endpoint)
    throw new Error("Noriq OAuth metadata is incomplete");
  const issuer = new URL(value.issuer);
  if (issuer.origin !== base.origin)
    throw new Error("OAuth issuer must use the configured Noriq server origin");
  return {
    issuer: value.issuer,
    authorization_endpoint: trustedEndpoint(
      base,
      value.authorization_endpoint,
      "authorization_endpoint",
    ),
    token_endpoint: trustedEndpoint(
      base,
      value.token_endpoint,
      "token_endpoint",
    ),
    ...(value.registration_endpoint
      ? {
          registration_endpoint: trustedEndpoint(
            base,
            value.registration_endpoint,
            "registration_endpoint",
          ),
        }
      : {}),
    ...(value.device_authorization_endpoint
      ? {
          device_authorization_endpoint: trustedEndpoint(
            base,
            value.device_authorization_endpoint,
            "device_authorization_endpoint",
          ),
        }
      : {}),
    ...(value.grant_types_supported
      ? { grant_types_supported: value.grant_types_supported }
      : {}),
  };
}

export async function registerClient(
  metadata: AuthorizationMetadata,
  input: { clientName: string; redirectUris: string[]; grantTypes: string[] },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!metadata.registration_endpoint)
    throw new Error(
      "this Noriq server does not support dynamic client registration",
    );
  const response = await fetchImpl(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: input.clientName,
      redirect_uris: input.redirectUris,
      grant_types: input.grantTypes,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok || typeof body.client_id !== "string")
    throw new Error(
      `client registration failed (${response.status}): ${String(body.error_description ?? body.error ?? "unknown")}`,
    );
  return body.client_id;
}

export async function postToken(
  metadata: AuthorizationMetadata,
  parameters: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<
  | { ok: true; token: TokenResponse }
  | { ok: false; error: OAuthError; status: number }
> {
  const response = await fetchImpl(metadata.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(parameters).toString(),
  });
  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (response.ok && typeof body.access_token === "string")
    return { ok: true, token: body as unknown as TokenResponse };
  return {
    ok: false,
    status: response.status,
    error: {
      error: String(body.error ?? `http_${response.status}`),
      ...(body.error_description
        ? { error_description: String(body.error_description) }
        : {}),
      ...(typeof body.interval === "number" ? { interval: body.interval } : {}),
    },
  };
}

export async function refreshToken(
  metadata: AuthorizationMetadata,
  clientId: string,
  refresh: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const result = await postToken(
    metadata,
    {
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
    },
    fetchImpl,
  );
  if (!result.ok) {
    const error = new Error(
      `token refresh failed: ${result.error.error}${result.error.error_description ? ` — ${result.error.error_description}` : ""}`,
    );
    Object.assign(error, { oauthCode: result.error.error });
    throw error;
  }
  return result.token;
}
