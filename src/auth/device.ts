import {
  type AuthorizationMetadata,
  DEVICE_GRANT,
  postToken,
  type TokenResponse,
} from "./oauth.js";

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

export async function requestDeviceCode(
  metadata: AuthorizationMetadata,
  clientId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceCode> {
  if (!metadata.device_authorization_endpoint)
    throw new Error("this Noriq server does not support device authorization");
  const response = await fetchImpl(metadata.device_authorization_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ client_id: clientId, scope: "mcp" }).toString(),
  });
  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok || typeof body.device_code !== "string")
    throw new Error(
      `device authorization failed (${response.status}): ${String(body.error_description ?? body.error ?? "unknown")}`,
    );
  return body as unknown as DeviceCode;
}

export async function deviceAuthorize(options: {
  metadata: AuthorizationMetadata;
  clientId: string;
  fetchImpl?: typeof fetch;
  onPrompt: (code: DeviceCode) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}): Promise<TokenResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const device = await requestDeviceCode(
    options.metadata,
    options.clientId,
    fetchImpl,
  );
  options.onPrompt(device);
  let interval = (device.interval ?? 5) * 1_000;
  const deadline = now() + device.expires_in * 1_000;
  while (now() < deadline) {
    await sleep(interval);
    const result = await postToken(
      options.metadata,
      {
        grant_type: DEVICE_GRANT,
        device_code: device.device_code,
        client_id: options.clientId,
      },
      fetchImpl,
    );
    if (result.ok) return result.token;
    if (result.error.error === "authorization_pending") continue;
    if (result.error.error === "slow_down") {
      interval = (result.error.interval ?? interval / 1_000 + 5) * 1_000;
      continue;
    }
    if (result.error.error === "access_denied")
      throw new Error("Noriq device authorization was denied");
    if (result.error.error === "expired_token") break;
    throw new Error(`device authorization failed: ${result.error.error}`);
  }
  throw new Error("the Noriq device code expired before it was approved");
}
