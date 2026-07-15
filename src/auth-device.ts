import { type AsMetadata, DEVICE_GRANT, type TokenResponse, postToken } from './oauth';

/**
 * Device authorization grant (RFC 8628) — the FALLBACK for boxes with no browser to
 * open: a runner on an SSH-only server, a container, a CI host. The daemon prints a
 * short code; the human types it at the verification URL on any other device.
 */

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

/** Ask the server to start a device authorization (RFC 8628 §3.1). */
export async function requestDeviceCode(
  meta: AsMetadata,
  clientId: string,
  scope = 'mcp',
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceCodeResponse> {
  if (!meta.device_authorization_endpoint) {
    throw new Error('this Noriq server does not support the device flow — re-run without --device');
  }
  const res = await fetchImpl(meta.device_authorization_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: clientId, scope }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.device_code !== 'string') {
    throw new Error(
      `device authorization failed (${res.status}): ${String(body.error_description ?? body.error ?? 'unknown')}`,
    );
  }
  return body as unknown as DeviceCodeResponse;
}

export interface DeviceAuthorizeOptions {
  meta: AsMetadata;
  clientId: string;
  scope?: string;
  fetchImpl?: typeof fetch;
  /** Show the user_code + verification URL. Called once, before polling starts. */
  onPrompt: (info: DeviceCodeResponse) => void;
  /** Injectable clock/sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Drive the full device flow: request a code pair, prompt, then poll until a human
 * approves or the code lapses. Honours the server's `interval` and backs off on
 * slow_down, as RFC 8628 §3.5 requires — Noriq paces this per device_code, and a
 * client that ignores it gets throttled rather than authorized.
 */
export async function deviceAuthorize(o: DeviceAuthorizeOptions): Promise<TokenResponse> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? defaultSleep;
  const now = o.now ?? Date.now;

  const dev = await requestDeviceCode(o.meta, o.clientId, o.scope ?? 'mcp', fetchImpl);
  o.onPrompt(dev);

  let interval = (dev.interval ?? 5) * 1000;
  const deadline = now() + dev.expires_in * 1000;

  while (now() < deadline) {
    await sleep(interval);
    const out = await postToken(
      o.meta,
      { grant_type: DEVICE_GRANT, device_code: dev.device_code, client_id: o.clientId },
      fetchImpl,
    );
    if (out.ok) return out.token;

    switch (out.error.error) {
      case 'authorization_pending':
        break; // the human hasn't finished yet — keep waiting
      case 'slow_down':
        // The server tells us the new floor; trust it over a local guess.
        interval = (out.error.interval ? out.error.interval : interval / 1000 + 5) * 1000;
        break;
      case 'access_denied':
        throw new Error('authorization denied — nobody approved this device');
      case 'expired_token':
        throw new Error('the code expired before it was approved — run `noriq-runner auth` again');
      default:
        throw new Error(
          `device authorization failed: ${out.error.error}${out.error.error_description ? ` — ${out.error.error_description}` : ''}`,
        );
    }
  }
  throw new Error('the code expired before it was approved — run `noriq-runner auth` again');
}
