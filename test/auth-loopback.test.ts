import { describe, expect, it } from 'vitest';
import { LOOPBACK_REDIRECT, hasBrowser, loopbackAuthorize } from '../src/auth-loopback';
import type { AsMetadata } from '../src/oauth';

const meta: AsMetadata = {
  issuer: 'https://noriq.example',
  authorization_endpoint: 'https://noriq.example/oauth/authorize',
  token_endpoint: 'https://noriq.example/oauth/token',
};

/** A fake AS token endpoint that records what the client sent. */
function fakeTokenEndpoint() {
  const seen: Record<string, string>[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    seen.push(Object.fromEntries(new URLSearchParams(String(init.body))));
    return new Response(
      JSON.stringify({
        access_token: 'plnrt_ok',
        token_type: 'Bearer',
        expires_in: 604800,
        refresh_token: 'plnrr_ok',
        scope: 'mcp',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

/** Stand in for the human's browser: follow the authorize URL straight back to the
 *  loopback callback, the way the real AS redirects after consent. */
const browserThatApproves =
  (over: { code?: string; state?: string } = {}) =>
  (url: string) => {
    const u = new URL(url);
    const cb = new URL(u.searchParams.get('redirect_uri') as string);
    cb.searchParams.set('code', over.code ?? 'the-code');
    cb.searchParams.set('state', over.state ?? (u.searchParams.get('state') as string));
    void fetch(cb).catch(() => {});
  };

describe('loopback authorization (the default path)', () => {
  it('registers a port-less loopback IP literal, not localhost', () => {
    // RFC 8252 §8.3: the IP literal avoids binding a non-loopback interface when
    // localhost resolves oddly. §7.3 makes the port-less form match any port.
    expect(LOOPBACK_REDIRECT).toBe('http://127.0.0.1/callback');
  });

  it('runs the full flow and returns the token', async () => {
    const { seen, fetchImpl } = fakeTokenEndpoint();
    const token = await loopbackAuthorize({
      meta,
      clientId: 'client_abc',
      fetchImpl,
      open: browserThatApproves(),
    });

    expect(token.access_token).toBe('plnrt_ok');
    expect(token.refresh_token).toBe('plnrr_ok');

    // PKCE: the verifier must accompany the exchange, and the redirect the code was
    // bound to must be echoed back, on the loopback literal.
    expect(seen[0]).toMatchObject({
      grant_type: 'authorization_code',
      code: 'the-code',
      client_id: 'client_abc',
      code_verifier: expect.stringMatching(/.+/),
      redirect_uri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/),
    });
  });

  it('sends S256 PKCE and a state on the authorize URL', async () => {
    const { fetchImpl } = fakeTokenEndpoint();
    let authUrl = '';
    await loopbackAuthorize({
      meta,
      clientId: 'client_abc',
      fetchImpl,
      open: (url) => {
        authUrl = url;
        browserThatApproves()(url);
      },
    });
    const q = new URL(authUrl).searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toBeTruthy();
    expect(q.get('state')).toBeTruthy();
    expect(q.get('scope')).toBe('mcp');
  });

  it('refuses a callback whose state does not match', async () => {
    const { seen, fetchImpl } = fakeTokenEndpoint();
    await expect(
      loopbackAuthorize({
        meta,
        clientId: 'client_abc',
        fetchImpl,
        open: browserThatApproves({ state: 'forged' }),
      }),
    ).rejects.toThrow(/state mismatch/);
    // The CSRF check is only worth anything if it stops the exchange.
    expect(seen).toHaveLength(0);
  });

  it('surfaces a denial from the authorization server', async () => {
    const { fetchImpl } = fakeTokenEndpoint();
    await expect(
      loopbackAuthorize({
        meta,
        clientId: 'client_abc',
        fetchImpl,
        open: (url) => {
          const cb = new URL(new URL(url).searchParams.get('redirect_uri') as string);
          cb.searchParams.set('error', 'access_denied');
          void fetch(cb).catch(() => {});
        },
      }),
    ).rejects.toThrow(/denied/);
  });

  it('gives up rather than hang when nobody finishes the flow', async () => {
    const { fetchImpl } = fakeTokenEndpoint();
    await expect(
      loopbackAuthorize({ meta, clientId: 'client_abc', fetchImpl, open: () => {}, timeoutMs: 50 }),
    ).rejects.toThrow(/--device/); // the error must point at the headless escape hatch
  });
});

describe('hasBrowser', () => {
  it('assumes a browser on desktop platforms', () => {
    expect(hasBrowser({}, 'darwin')).toBe(true);
    expect(hasBrowser({}, 'win32')).toBe(true);
  });

  it('needs a display on linux', () => {
    expect(hasBrowser({ DISPLAY: ':0' }, 'linux')).toBe(true);
    expect(hasBrowser({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBe(true);
    expect(hasBrowser({}, 'linux')).toBe(false);
  });

  it('says no over SSH even with a forwarded DISPLAY', () => {
    // X11 forwarding would open the browser on the wrong end of the connection —
    // invisible to whoever typed the command.
    expect(hasBrowser({ DISPLAY: ':0', SSH_CONNECTION: '10.0.0.1 1 10.0.0.2 22' }, 'linux')).toBe(false);
    expect(hasBrowser({ SSH_TTY: '/dev/pts/0' }, 'darwin')).toBe(false);
  });

  it('honours NORIQ_NO_BROWSER as a manual override', () => {
    expect(hasBrowser({ NORIQ_NO_BROWSER: '1', DISPLAY: ':0' }, 'linux')).toBe(false);
  });
});
