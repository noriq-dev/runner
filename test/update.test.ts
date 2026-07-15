// RUN-37: knowing whether this runner is behind. Deliberately NOT self-replacement — see
// src/update.ts for why that is blocked on something real (nothing is published) rather than on
// taste, and why an inert `apply` config key would repeat RUN-38's mistake.
import { describe, expect, it } from 'vitest';
import { checkForUpdate, compareVersions, updateAdvice } from '../src/update';

const fakeFetch = (status: number, body: unknown): typeof fetch =>
  (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;

describe('compareVersions', () => {
  it('orders by number, not by string', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0); // '0.9' > '0.10' lexically
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });
  it('sorts a pre-release before its release', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
  });
});

describe('checkForUpdate', () => {
  it('reports behind when the server is ahead', async () => {
    const c = await checkForUpdate('https://n.example', {
      current: '0.1.0',
      fetchImpl: fakeFetch(200, { version: '0.2.0', minimum: null }),
    });
    expect(c).toMatchObject({ current: '0.1.0', latest: '0.2.0', behind: true, belowMinimum: false });
  });

  it('reports current when it matches', async () => {
    const c = await checkForUpdate('https://n.example', {
      current: '0.2.0',
      fetchImpl: fakeFetch(200, { version: '0.2.0', minimum: null }),
    });
    expect(c.behind).toBe(false);
    expect(updateAdvice(c)).toContain('is current');
  });

  it('flags a runner below the server’s floor', async () => {
    const c = await checkForUpdate('https://n.example', {
      current: '0.1.0',
      fetchImpl: fakeFetch(200, { version: '0.9.0', minimum: '0.5.0' }),
    });
    expect(c.belowMinimum).toBe(true);
    expect(updateAdvice(c)).toContain('BELOW the minimum');
  });

  it('being unable to check is NOT being out of date', async () => {
    // A runner must not fall over — or claim to be stale — because a version endpoint had a bad
    // day. Treating "don't know" as "behind" would be worse than not checking at all.
    const down = await checkForUpdate('https://n.example', {
      current: '0.1.0',
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    expect(down).toMatchObject({ latest: null, behind: false, belowMinimum: false });
    expect(updateAdvice(down)).toContain('could not reach');

    const notFound = await checkForUpdate('https://n.example', {
      current: '0.1.0',
      fetchImpl: fakeFetch(404, {}),
    });
    expect(notFound.behind).toBe(false);
  });

  it('survives a version endpoint that answers rubbish', async () => {
    const c = await checkForUpdate('https://n.example', {
      current: '0.1.0',
      fetchImpl: fakeFetch(200, { version: 42 }),
    });
    expect(c.latest).toBeNull();
    expect(c.behind).toBe(false);
  });

  it('names the command instead of running it', async () => {
    // The daemon does not replace its own executable. It tells a human what to do, and they
    // decide — that is the supply-chain boundary, not a missing feature.
    const c = await checkForUpdate('https://n.example', {
      current: '0.1.0',
      fetchImpl: fakeFetch(200, { version: '0.2.0' }),
    });
    expect(updateAdvice(c)).toContain('npm i -g @noriq-dev/runner@latest');
  });
});
