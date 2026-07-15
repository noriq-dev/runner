import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type AsMetadata, type TokenResponse, pkcePair, postToken, randomState } from './oauth';

/**
 * Loopback authorization-code + PKCE (RFC 8252) — the DEFAULT path. On any machine with
 * a browser this is the whole flow: one click, no codes to copy. The daemon binds an
 * ephemeral port on 127.0.0.1 and Noriq matches the registered redirect ignoring the
 * port, so no re-registration is needed per run.
 */

/**
 * Registered redirect: port-less on purpose — RFC 8252 §7.3 requires the AS to allow any
 * port for loopback IP redirects, so one registration covers every ephemeral port.
 *
 * The IP literal rather than `localhost` is deliberate (RFC 8252 §8.3 calls `localhost`
 * NOT RECOMMENDED): `localhost` can resolve via /etc/hosts or to ::1, which risks binding
 * the callback on an interface other than loopback. Noriq matches loopback redirects on
 * hostname, so the registered literal and the bound host must agree — change both or
 * neither.
 */
export const LOOPBACK_REDIRECT = 'http://127.0.0.1/callback';
const LOOPBACK_HOST = '127.0.0.1';

/**
 * Whether this box can plausibly pop a browser. Wrong-way-safe: when in doubt we say no
 * and fall back to the device flow, which works everywhere — guessing yes on a headless
 * box strands the user staring at a spinner with no code to type.
 */
export function hasBrowser(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): boolean {
  if (env.NORIQ_NO_BROWSER) return false;
  // An SSH session's DISPLAY points at the *other* end of the connection; opening a
  // browser there is worse than useless — it's invisible to whoever ran the command.
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return false;
  if (platform === 'darwin' || platform === 'win32') return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/** Best-effort browser launch; failures are non-fatal (the URL is always printed too). */
export function openBrowser(url: string, platform: string = process.platform): void {
  const [cmd, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args as string[], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* no launcher — the printed URL is the fallback */
  }
}

const page = (title: string, msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>Noriq</title><body style="background:#0a0b0d;color:#e6e8ec;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="font-size:18px">${title}</h1><p style="color:#8a8f98;font-size:13px">${msg}</p></div></body>`;

export interface LoopbackOptions {
  meta: AsMetadata;
  clientId: string;
  scope?: string;
  fetchImpl?: typeof fetch;
  /** Injected in tests; defaults to the real launcher. */
  open?: (url: string) => void;
  /** Called with the authorize URL — printed so the user can open it by hand. */
  onUrl?: (url: string) => void;
  /** Give up if nobody finishes the browser flow. Default 5 min. */
  timeoutMs?: number;
}

/** Run the loopback flow and return the token. Resolves only after a successful exchange. */
export async function loopbackAuthorize(o: LoopbackOptions): Promise<TokenResponse> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const { verifier, challenge } = pkcePair();
  const state = randomState();

  const server = createServer();
  const codePromise = new Promise<string>((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const gotState = url.searchParams.get('state');
      const done = (status: number, title: string, msg: string) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(title, msg));
      };
      if (err) {
        done(400, 'Authorization denied', 'Nothing was connected. You can close this tab.');
        reject(new Error(`authorization denied: ${err}`));
        return;
      }
      // A mismatched state means this callback isn't the one we started — the CSRF
      // check RFC 6749 §10.12 exists for. Never exchange it.
      if (!gotState || gotState !== state) {
        done(400, 'Mismatched request', 'This callback did not match the request we started.');
        reject(new Error('state mismatch — ignoring the callback'));
        return;
      }
      if (!code) {
        done(400, 'No code', 'The server returned no authorization code.');
        reject(new Error('no authorization code in the callback'));
        return;
      }
      done(200, '✓ Connected', 'Your runner has its token — return to your terminal.');
      resolve(code);
    });
    server.on('error', reject);
  });

  await new Promise<void>((resolve) => server.listen(0, LOOPBACK_HOST, resolve));
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://${LOOPBACK_HOST}:${port}/callback`;

  const authUrl = new URL(o.meta.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: 'code',
    client_id: o.clientId,
    redirect_uri: redirectUri,
    scope: o.scope ?? 'mcp',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })) {
    authUrl.searchParams.set(k, v);
  }

  const timeoutMs = o.timeoutMs ?? 300_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    o.onUrl?.(authUrl.toString());
    (o.open ?? openBrowser)(authUrl.toString());

    const code = await Promise.race([
      codePromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('timed out waiting for the browser — re-run with --device')),
          timeoutMs,
        );
      }),
    ]);

    const out = await postToken(
      o.meta,
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: o.clientId,
        code_verifier: verifier,
      },
      fetchImpl,
    );
    if (!out.ok) {
      throw new Error(
        `token exchange failed: ${out.error.error}${out.error.error_description ? ` — ${out.error.error_description}` : ''}`,
      );
    }
    return out.token;
  } finally {
    if (timer) clearTimeout(timer);
    server.close();
  }
}
