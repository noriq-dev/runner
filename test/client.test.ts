import { describe, expect, it } from 'vitest';
import { NoriqClient } from '../src/client';

interface Captured {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

function fakeFetch(status: number, payload: unknown, captured: Captured[]): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    captured.push({
      url: String(url),
      method: init?.method ?? 'GET',
      auth: new Headers(init?.headers).get('Authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(payload), { status });
  }) as typeof fetch;
}

const RUNNER = {
  id: 'rnr_1',
  projectId: null,
  label: 'l',
  status: 'online',
  capabilities: { tools: ['claude'], kinds: ['build'], maxConcurrency: 1 },
  repos: [{ id: 'repo_a', projectKey: 'AAA', projectId: 'prj_aaa', name: 'a', defaultBranch: 'main' }],
  freeSlots: 1,
  lastHeartbeatAt: null,
  createdAt: '2026-07-14T00:00:00.000Z',
};

describe('NoriqClient', () => {
  it('POSTs registration with a bearer token and unwraps the runner', async () => {
    const captured: Captured[] = [];
    const client = new NoriqClient({
      server: 'https://noriq.example/',
      token: 'tok123',
      fetchImpl: fakeFetch(200, { runner: RUNNER }, captured),
    });
    const runner = await client.registerRunner({
      label: 'l',
      version: '1.2.3',
      tools: ['claude'],
      kinds: ['build'],
      maxConcurrency: 1,
      repos: [{ id: 'repo_a', projectKey: 'AAA', name: 'a', defaultBranch: 'main' }],
    });
    expect(runner.id).toBe('rnr_1');
    expect(runner.repos[0]?.projectId).toBe('prj_aaa');
    expect(captured[0]).toMatchObject({
      url: 'https://noriq.example/api/runners', // trailing slash trimmed
      method: 'POST',
      auth: 'Bearer tok123',
    });
    expect((captured[0]?.body as { label: string }).label).toBe('l');
  });

  it('heartbeat hits the runner-scoped path', async () => {
    const captured: Captured[] = [];
    const client = new NoriqClient({
      server: 'https://a.b',
      token: 't',
      fetchImpl: fakeFetch(200, { ok: true }, captured),
    });
    await client.heartbeat('rnr_9', { freeSlots: 2 });
    expect(captured[0]?.url).toBe('https://a.b/api/runners/rnr_9/heartbeat');
    expect(captured[0]?.body).toEqual({ freeSlots: 2 });
  });

  it('throws with status + body on a non-2xx response', async () => {
    const client = new NoriqClient({
      server: 'https://a.b',
      token: 't',
      fetchImpl: fakeFetch(404, { error: 'runner not found' }, []),
    });
    await expect(client.heartbeat('rnr_x', { freeSlots: 0 })).rejects.toThrow(/404.*runner not found/);
  });
});
