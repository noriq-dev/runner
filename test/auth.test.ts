import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authorize, resolveMode } from '../src/auth';
import { loadCredentials, saveCredentials } from '../src/credentials';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'noriq-auth-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SERVER = 'https://noriq.example';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A fake Noriq AS covering discovery, DCR, the device endpoint, and token. */
function fakeNoriq() {
  const registrations: Array<Record<string, unknown>> = [];
  const tokenCalls: Array<Record<string, string>> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('.well-known')) {
      return json({
        issuer: SERVER,
        authorization_endpoint: `${SERVER}/oauth/authorize`,
        token_endpoint: `${SERVER}/oauth/token`,
        registration_endpoint: `${SERVER}/oauth/register`,
        device_authorization_endpoint: `${SERVER}/oauth/device/code`,
        grant_types_supported: ['authorization_code', 'refresh_token', DEVICE_GRANT],
      });
    }
    if (u.endsWith('/oauth/register')) {
      registrations.push(JSON.parse(String(init?.body)));
      return json({ client_id: 'client_fresh' }, 201);
    }
    if (u.endsWith('/device/code')) {
      return json({
        device_code: 'plnrd_dev',
        user_code: 'BCDF-GHJK',
        verification_uri: `${SERVER}/oauth/device`,
        verification_uri_complete: `${SERVER}/oauth/device?user_code=BCDF-GHJK`,
        expires_in: 600,
        interval: 5,
      });
    }
    tokenCalls.push(Object.fromEntries(new URLSearchParams(String(init?.body))));
    return json({
      access_token: 'plnrt_ok',
      token_type: 'Bearer',
      expires_in: 604800,
      refresh_token: 'plnrr_ok',
      scope: 'mcp',
    });
  }) as unknown as typeof fetch;
  return { registrations, tokenCalls, fetchImpl };
}

const deviceRun = (over: Partial<Parameters<typeof authorize>[0]> = {}) => ({
  server: SERVER,
  mode: 'device' as const,
  sleep: async () => {},
  env: {} as NodeJS.ProcessEnv,
  ...over,
});

describe('resolveMode', () => {
  it('picks the browser when there is one — the good path stays the default', () => {
    expect(resolveMode('auto', { DISPLAY: ':0' }, 'linux')).toBe('browser');
    expect(resolveMode('auto', {}, 'darwin')).toBe('browser');
  });

  it('falls back to device only when no browser is reachable', () => {
    expect(resolveMode('auto', {}, 'linux')).toBe('device');
    expect(resolveMode('auto', { SSH_CONNECTION: 'x' }, 'linux')).toBe('device');
  });

  it('honours an explicit choice over detection', () => {
    expect(resolveMode('device', { DISPLAY: ':0' }, 'linux')).toBe('device');
    expect(resolveMode('browser', {}, 'linux')).toBe('browser');
  });
});

describe('authorize', () => {
  it('registers for both grants so the same install can fall back later', async () => {
    const { registrations, fetchImpl } = fakeNoriq();
    const credentialsPath = path.join(dir, 'both', 'credentials.json');
    await authorize(deviceRun({ credentialsPath, fetchImpl, out: () => {} }));

    expect(registrations[0]).toMatchObject({
      grant_types: ['authorization_code', DEVICE_GRANT],
      redirect_uris: ['http://127.0.0.1/callback'],
      client_name: expect.stringContaining('noriq-runner'),
    });
  });

  it('stores a refreshable credential for the server it authorized', async () => {
    const { fetchImpl } = fakeNoriq();
    const credentialsPath = path.join(dir, 'store', 'credentials.json');
    const creds = await authorize(deviceRun({ credentialsPath, fetchImpl, out: () => {} }));

    expect(creds).toMatchObject({
      server: SERVER,
      clientId: 'client_fresh',
      accessToken: 'plnrt_ok',
      refreshToken: 'plnrr_ok',
      scope: 'mcp',
    });
    expect(Date.parse(creds.expiresAt as string)).toBeGreaterThan(Date.now());
    expect(await loadCredentials(credentialsPath)).toEqual(creds);
  });

  it('shows the user their code and where to type it', async () => {
    const { fetchImpl } = fakeNoriq();
    const lines: string[] = [];
    await authorize(
      deviceRun({
        credentialsPath: path.join(dir, 'prompt', 'credentials.json'),
        fetchImpl,
        out: (l) => lines.push(l),
      }),
    );
    const printed = lines.join('\n');
    expect(printed).toContain('BCDF-GHJK');
    expect(printed).toContain(`${SERVER}/oauth/device?user_code=BCDF-GHJK`);
  });

  it('reuses the client_id when re-authing the same server', async () => {
    const credentialsPath = path.join(dir, 'reuse', 'credentials.json');
    await saveCredentials(
      {
        server: SERVER,
        clientId: 'client_existing',
        accessToken: 'plnrt_stale',
        refreshToken: 'plnrr_stale',
      },
      credentialsPath,
    );
    const { registrations, fetchImpl } = fakeNoriq();
    const creds = await authorize(deviceRun({ credentialsPath, fetchImpl, out: () => {} }));

    // Re-authing shouldn't litter the server with a new client row every time.
    expect(registrations).toHaveLength(0);
    expect(creds.clientId).toBe('client_existing');
    expect(creds.accessToken).toBe('plnrt_ok');
  });

  it('registers afresh when the stored credential is for another server', async () => {
    const credentialsPath = path.join(dir, 'switch', 'credentials.json');
    await saveCredentials(
      { server: 'https://someone-else.example', clientId: 'client_elsewhere', accessToken: 'plnrt_x' },
      credentialsPath,
    );
    const { registrations, fetchImpl } = fakeNoriq();
    const creds = await authorize(deviceRun({ credentialsPath, fetchImpl, out: () => {} }));

    // A client_id from another instance is meaningless here.
    expect(registrations).toHaveLength(1);
    expect(creds.clientId).toBe('client_fresh');
    expect(creds.server).toBe(SERVER);
  });

  it('runs the browser flow when told to', async () => {
    const { tokenCalls, fetchImpl } = fakeNoriq();
    const credentialsPath = path.join(dir, 'browser', 'credentials.json');
    const creds = await authorize({
      server: SERVER,
      mode: 'browser',
      credentialsPath,
      fetchImpl,
      env: {},
      out: () => {},
      // Stand in for the human's browser approving at the AS.
      open: (url) => {
        const cb = new URL(new URL(url).searchParams.get('redirect_uri') as string);
        cb.searchParams.set('code', 'the-code');
        cb.searchParams.set('state', new URL(url).searchParams.get('state') as string);
        void fetch(cb).catch(() => {});
      },
    });

    expect(creds.accessToken).toBe('plnrt_ok');
    expect(tokenCalls[0]).toMatchObject({
      grant_type: 'authorization_code',
      code: 'the-code',
      code_verifier: expect.stringMatching(/.+/),
    });
  });

  it('normalizes a server URL with a trailing slash', async () => {
    const { fetchImpl } = fakeNoriq();
    const creds = await authorize(
      deviceRun({
        server: `${SERVER}/`,
        credentialsPath: path.join(dir, 'slash', 'credentials.json'),
        fetchImpl,
        out: () => {},
      }),
    );
    // Must match what TokenSource compares against, or the daemon ignores its own token.
    expect(creds.server).toBe(SERVER);
  });
});
