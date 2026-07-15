import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type StoredCredentials,
  expiryFrom,
  loadCredentials,
  sameServer,
  saveCredentials,
} from '../src/credentials';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'noriq-creds-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const creds = (over: Partial<StoredCredentials> = {}): StoredCredentials => ({
  server: 'https://noriq.example',
  clientId: 'client_abc',
  accessToken: 'plnrt_access',
  refreshToken: 'plnrr_refresh',
  expiresAt: '2026-07-21T00:00:00.000Z',
  scope: 'mcp',
  ...over,
});

describe('credentials', () => {
  it('round-trips through the file', async () => {
    const p = path.join(dir, 'rt', 'credentials.json');
    await saveCredentials(creds(), p);
    expect(await loadCredentials(p)).toEqual(creds());
  });

  it('writes the secret 0600 under a 0700 dir', async () => {
    const p = path.join(dir, 'perms', 'credentials.json');
    await saveCredentials(creds(), p);
    // This file is a live credential — group/other must not be able to read it.
    expect((await stat(p)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(p))).mode & 0o777).toBe(0o700);
  });

  it('returns null when absent, corrupt, or missing required fields', async () => {
    expect(await loadCredentials(path.join(dir, 'nope.json'))).toBeNull();

    const bad = path.join(dir, 'bad.json');
    await writeFile(bad, '{ truncated');
    expect(await loadCredentials(bad)).toBeNull();

    const partial = path.join(dir, 'partial.json');
    await writeFile(partial, JSON.stringify({ server: 'https://x' }));
    expect(await loadCredentials(partial)).toBeNull();
  });

  it('overwrites cleanly on re-auth (no stale trailing bytes)', async () => {
    const p = path.join(dir, 'over', 'credentials.json');
    await saveCredentials(creds({ accessToken: 'plnrt_aaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), p);
    await saveCredentials(creds({ accessToken: 'plnrt_b' }), p);
    const raw = await readFile(p, 'utf8');
    expect(raw).not.toContain('aaaa');
    expect((await loadCredentials(p))?.accessToken).toBe('plnrt_b');
  });

  it('compares servers ignoring trailing slash and case', () => {
    expect(sameServer('https://noriq.example', 'https://noriq.example/')).toBe(true);
    expect(sameServer('https://NORIQ.example', 'https://noriq.example')).toBe(true);
    expect(sameServer('https://noriq.example', 'https://other.example')).toBe(false);
  });

  it('turns expires_in into an absolute expiry', () => {
    expect(expiryFrom(3600, Date.parse('2026-07-14T00:00:00.000Z'))).toBe('2026-07-14T01:00:00.000Z');
  });
});
