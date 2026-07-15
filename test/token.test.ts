import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type StoredCredentials, loadCredentials, saveCredentials } from '../src/credentials';
import { TokenSource, loadToken } from '../src/token';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'noriq-token-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SERVER = 'https://noriq.example';

const creds = (over: Partial<StoredCredentials> = {}): StoredCredentials => ({
  server: SERVER,
  clientId: 'client_abc',
  accessToken: 'plnrt_old',
  refreshToken: 'plnrr_old',
  expiresAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
  scope: 'mcp',
  ...over,
});

/** Fake AS: discovery + a rotating refresh endpoint. */
function fakeServer(over: { refresh?: { body: unknown; status: number } } = {}) {
  const calls: Record<string, string>[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).includes('.well-known')) {
      return new Response(
        JSON.stringify({
          issuer: SERVER,
          authorization_endpoint: `${SERVER}/oauth/authorize`,
          token_endpoint: `${SERVER}/oauth/token`,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    calls.push(Object.fromEntries(new URLSearchParams(String(init?.body))));
    const r = over.refresh ?? {
      body: {
        access_token: 'plnrt_new',
        token_type: 'Bearer',
        expires_in: 604800,
        refresh_token: 'plnrr_new',
        scope: 'mcp',
      },
      status: 200,
    };
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('loadToken', () => {
  it('prefers NORIQ_TOKEN from the env', async () => {
    const token = await loadToken({
      env: { NORIQ_TOKEN: '  env-tok  ' },
      tokenPath: '/no/such',
      credentialsPath: '/no/such.json',
    });
    expect(token).toBe('env-tok'); // trimmed
  });

  it('falls back to the token file', async () => {
    const p = path.join(dir, 'token');
    await writeFile(p, 'file-tok\n');
    const token = await loadToken({ env: {}, tokenPath: p, credentialsPath: '/no/such.json' });
    expect(token).toBe('file-tok');
  });

  it('prefers credentials.json over the legacy bare-token file', async () => {
    const p = path.join(dir, 'pref', 'credentials.json');
    await saveCredentials(creds({ accessToken: 'plnrt_from_creds' }), p);
    const tokenPath = path.join(dir, 'token');
    await writeFile(tokenPath, 'file-tok\n');
    expect(await loadToken({ env: {}, tokenPath, credentialsPath: p, server: SERVER })).toBe(
      'plnrt_from_creds',
    );
  });

  it('ignores credentials minted for a different server', async () => {
    const p = path.join(dir, 'other', 'credentials.json');
    await saveCredentials(creds({ server: 'https://someone-else.example' }), p);
    const tokenPath = path.join(dir, 'token');
    await writeFile(tokenPath, 'file-tok\n');
    // Sending another instance's token here would just 401 — fall through instead.
    expect(await loadToken({ env: {}, tokenPath, credentialsPath: p, server: SERVER })).toBe('file-tok');
  });

  it('throws with guidance when nothing is present', async () => {
    await expect(
      loadToken({
        env: {},
        tokenPath: path.join(dir, 'missing'),
        credentialsPath: path.join(dir, 'missing.json'),
      }),
    ).rejects.toThrow(/noriq-runner auth/);
  });
});

describe('TokenSource', () => {
  const base = { server: SERVER, tokenPath: '/no/such', env: {} as NodeJS.ProcessEnv };

  it('returns a live token without refreshing', async () => {
    const p = path.join(dir, 'live', 'credentials.json');
    await saveCredentials(creds(), p);
    const { calls, fetchImpl } = fakeServer();
    const src = new TokenSource({ ...base, credentialsPath: p, fetchImpl });

    expect(await src.get()).toBe('plnrt_old');
    expect(calls).toHaveLength(0); // nothing to do — don't burn a rotation
  });

  it('refreshes ahead of expiry and persists the rotated pair', async () => {
    const p = path.join(dir, 'refresh', 'credentials.json');
    // Inside the default 5-min skew.
    await saveCredentials(creds({ expiresAt: new Date(Date.now() + 60_000).toISOString() }), p);
    const { calls, fetchImpl } = fakeServer();
    const src = new TokenSource({ ...base, credentialsPath: p, fetchImpl });

    expect(await src.get()).toBe('plnrt_new');
    expect(calls[0]).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'plnrr_old',
      client_id: 'client_abc',
    });

    // Noriq REVOKES the old refresh token on use — failing to persist the new one
    // would lock this runner out at the next refresh.
    const saved = await loadCredentials(p);
    expect(saved?.accessToken).toBe('plnrt_new');
    expect(saved?.refreshToken).toBe('plnrr_new');
    expect(Date.parse(saved?.expiresAt as string)).toBeGreaterThan(Date.now());
  });

  it('refreshes an already-expired token', async () => {
    const p = path.join(dir, 'expired', 'credentials.json');
    await saveCredentials(creds({ expiresAt: new Date(Date.now() - 3600_000).toISOString() }), p);
    const { fetchImpl } = fakeServer();
    const src = new TokenSource({ ...base, credentialsPath: p, fetchImpl });
    expect(await src.get()).toBe('plnrt_new');
  });

  it('coalesces concurrent refreshes into one rotation', async () => {
    const p = path.join(dir, 'race', 'credentials.json');
    await saveCredentials(creds({ expiresAt: new Date(Date.now() + 60_000).toISOString() }), p);
    const { calls, fetchImpl } = fakeServer();
    const src = new TokenSource({ ...base, credentialsPath: p, fetchImpl });

    // The REST client and the WS client can both notice expiry at the same moment; a
    // second rotation would revoke the first's brand-new pair.
    const [a, b, c] = await Promise.all([src.get(), src.get(), src.refresh()]);
    expect([a, b, c]).toEqual(['plnrt_new', 'plnrt_new', 'plnrt_new']);
    expect(calls).toHaveLength(1);
  });

  it('explains how to recover when the refresh token is dead', async () => {
    const p = path.join(dir, 'dead', 'credentials.json');
    await saveCredentials(creds({ expiresAt: new Date(Date.now() - 1000).toISOString() }), p);
    const { fetchImpl } = fakeServer({ refresh: { body: { error: 'invalid_grant' }, status: 400 } });
    const src = new TokenSource({ ...base, credentialsPath: p, fetchImpl });

    // 90 days elapsed, or the human revoked the connection — only re-auth fixes it.
    await expect(src.get()).rejects.toThrow(/noriq-runner auth/);
  });

  it('treats NORIQ_TOKEN as static and never refreshes it', async () => {
    const { calls, fetchImpl } = fakeServer();
    const src = new TokenSource({
      ...base,
      env: { NORIQ_TOKEN: 'env-tok' },
      credentialsPath: '/no/such.json',
      fetchImpl,
    });

    expect(await src.get()).toBe('env-tok');
    expect(await src.refresh()).toBe('env-tok'); // a 401 retry must not throw here
    expect(await src.canRefresh()).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('reports refreshability so callers know a 401 is recoverable', async () => {
    const p = path.join(dir, 'canrefresh', 'credentials.json');
    await saveCredentials(creds(), p);
    expect(
      await new TokenSource({ ...base, credentialsPath: p, fetchImpl: fakeServer().fetchImpl }).canRefresh(),
    ).toBe(true);
  });

  it('throws with guidance when there is nothing stored', async () => {
    const src = new TokenSource({ ...base, credentialsPath: path.join(dir, 'none.json') });
    await expect(src.get()).rejects.toThrow(/noriq-runner auth/);
  });
});
