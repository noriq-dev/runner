import { describe, expect, it, vi } from 'vitest';
import { deviceAuthorize, requestDeviceCode } from '../src/auth-device';
import type { AsMetadata } from '../src/oauth';

const meta: AsMetadata = {
  issuer: 'https://noriq.example',
  authorization_endpoint: 'https://noriq.example/oauth/authorize',
  token_endpoint: 'https://noriq.example/oauth/token',
  device_authorization_endpoint: 'https://noriq.example/oauth/device/code',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const DEVICE = {
  device_code: 'plnrd_dev',
  user_code: 'BCDF-GHJK',
  verification_uri: 'https://noriq.example/oauth/device',
  verification_uri_complete: 'https://noriq.example/oauth/device?user_code=BCDF-GHJK',
  expires_in: 600,
  interval: 5,
};

const TOKEN = {
  access_token: 'plnrt_ok',
  token_type: 'Bearer',
  expires_in: 604800,
  refresh_token: 'plnrr_ok',
  scope: 'mcp',
};

/** Fake AS: hands out DEVICE, then replays `pollResponses` one per poll. */
function fakeServer(pollResponses: Array<{ body: unknown; status: number }>) {
  const polls: Record<string, string>[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (String(url).endsWith('/device/code')) return json(DEVICE);
    polls.push(Object.fromEntries(new URLSearchParams(String(init.body))));
    const next = pollResponses.shift() ?? { body: TOKEN, status: 200 };
    return json(next.body, next.status);
  }) as unknown as typeof fetch;
  return { polls, fetchImpl };
}

const pending = { body: { error: 'authorization_pending' }, status: 400 };
const ok = { body: TOKEN, status: 200 };

describe('device authorization (the headless fallback)', () => {
  it('requests a code pair and prompts the human', async () => {
    const { fetchImpl } = fakeServer([ok]);
    const onPrompt = vi.fn();
    const token = await deviceAuthorize({ meta, clientId: 'c', fetchImpl, sleep: async () => {}, onPrompt });

    expect(token.access_token).toBe('plnrt_ok');
    // The human can't approve what they were never shown.
    expect(onPrompt).toHaveBeenCalledWith(expect.objectContaining({ user_code: 'BCDF-GHJK' }));
  });

  it('polls until a human approves', async () => {
    const { polls, fetchImpl } = fakeServer([pending, pending, ok]);
    const token = await deviceAuthorize({
      meta,
      clientId: 'c',
      fetchImpl,
      sleep: async () => {},
      onPrompt: () => {},
    });

    expect(token.access_token).toBe('plnrt_ok');
    expect(polls).toHaveLength(3);
    expect(polls[0]).toMatchObject({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'plnrd_dev',
      client_id: 'c',
    });
  });

  it('waits the advertised interval between polls', async () => {
    const { fetchImpl } = fakeServer([pending, ok]);
    const slept: number[] = [];
    await deviceAuthorize({
      meta,
      clientId: 'c',
      fetchImpl,
      sleep: async (ms) => {
        slept.push(ms);
      },
      onPrompt: () => {},
    });
    expect(slept).toEqual([5000, 5000]);
  });

  it('backs off to the interval the server dictates on slow_down', async () => {
    const { fetchImpl } = fakeServer([{ body: { error: 'slow_down', interval: 10 }, status: 400 }, ok]);
    const slept: number[] = [];
    await deviceAuthorize({
      meta,
      clientId: 'c',
      fetchImpl,
      sleep: async (ms) => {
        slept.push(ms);
      },
      onPrompt: () => {},
    });
    // Trust the server's number over a local guess — it's the one enforcing it.
    expect(slept).toEqual([5000, 10000]);
  });

  it('bumps the interval itself when slow_down carries no number', async () => {
    const { fetchImpl } = fakeServer([{ body: { error: 'slow_down' }, status: 400 }, ok]);
    const slept: number[] = [];
    await deviceAuthorize({
      meta,
      clientId: 'c',
      fetchImpl,
      sleep: async (ms) => {
        slept.push(ms);
      },
      onPrompt: () => {},
    });
    expect(slept).toEqual([5000, 10000]);
  });

  it('stops on denial', async () => {
    const { fetchImpl } = fakeServer([{ body: { error: 'access_denied' }, status: 400 }]);
    await expect(
      deviceAuthorize({ meta, clientId: 'c', fetchImpl, sleep: async () => {}, onPrompt: () => {} }),
    ).rejects.toThrow(/denied/);
  });

  it('stops on an expired code with a re-run hint', async () => {
    const { fetchImpl } = fakeServer([{ body: { error: 'expired_token' }, status: 400 }]);
    await expect(
      deviceAuthorize({ meta, clientId: 'c', fetchImpl, sleep: async () => {}, onPrompt: () => {} }),
    ).rejects.toThrow(/noriq-runner auth/);
  });

  it('gives up once the code lapses rather than polling forever', async () => {
    // Always pending, and the clock runs past expires_in.
    const { polls, fetchImpl } = fakeServer(Array.from({ length: 500 }, () => pending));
    let clock = 0;
    await expect(
      deviceAuthorize({
        meta,
        clientId: 'c',
        fetchImpl,
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
        onPrompt: () => {},
      }),
    ).rejects.toThrow(/expired/);
    // 600s at 5s intervals — bounded, not runaway.
    expect(polls.length).toBeLessThanOrEqual(120);
  });

  it('surfaces an unexpected OAuth error instead of looping on it', async () => {
    const { fetchImpl } = fakeServer([{ body: { error: 'invalid_client' }, status: 400 }]);
    await expect(
      deviceAuthorize({ meta, clientId: 'c', fetchImpl, sleep: async () => {}, onPrompt: () => {} }),
    ).rejects.toThrow(/invalid_client/);
  });

  it('explains itself when the server has no device endpoint', async () => {
    const noDevice: AsMetadata = { ...meta, device_authorization_endpoint: undefined };
    const fetchImpl = (async () => json({}, 404)) as unknown as typeof fetch;
    await expect(requestDeviceCode(noDevice, 'c', 'mcp', fetchImpl)).rejects.toThrow(
      /does not support the device flow/,
    );
  });
});
