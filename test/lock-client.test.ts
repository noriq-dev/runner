import { describe, expect, it } from 'vitest';
import { LockClient } from '../src/lock-client';

interface Call {
  method: string;
  auth: string | null;
  session: string | null;
  body: { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
}

/** A fake Noriq MCP endpoint: answers `initialize` with a session header, swallows
 *  `notifications/initialized`, and hands each `tools/call` to `respond(name, args)`. */
function fakeMcp(
  respond: (
    name: string,
    args: Record<string, unknown>,
  ) => { body?: unknown; isError?: boolean; text?: string },
  opts: { calls?: Call[]; sessionId?: string; expireOnce?: boolean } = {},
): typeof fetch {
  let expired = opts.expireOnce ?? false;
  const sid = opts.sessionId ?? 'sess_1';
  return (async (_url: string | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const headers = new Headers(init?.headers);
    opts.calls?.push({
      method: body.method,
      auth: headers.get('Authorization'),
      session: headers.get('mcp-session-id'),
      body,
    });
    if (body.method === 'initialize') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 0, result: {} }), {
        status: 200,
        headers: { 'mcp-session-id': sid },
      });
    }
    if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
    // tools/call — simulate a recycled session ONCE (the daemon must re-initialize + retry).
    if (expired) {
      expired = false;
      return new Response('session gone', { status: 404 });
    }
    const r = respond(body.params.name, body.params.arguments ?? {});
    const text = r.text ?? JSON.stringify(r.body ?? {});
    const envelope = {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text }], isError: r.isError ?? false },
    };
    return new Response(JSON.stringify(envelope), { status: 200 });
  }) as typeof fetch;
}

const client = (fetchImpl: typeof fetch) => new LockClient({ server: 'https://noriq.example/', fetchImpl });

describe('LockClient', () => {
  it('acquires as the RUN token (not the daemon), scoping to the branch and linking the task', async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeMcp(
      (_name, _args) => ({ body: { ok: true, locks: [{ id: 'lk_1', path: 'src/a.ts' }], expiresAt: 'T' } }),
      { calls },
    );
    const res = await client(fetchImpl).acquire('run-token', {
      projectId: 'prj_x',
      paths: ['src/a.ts'],
      branch: 'main',
      taskId: 'task_9',
    });

    expect(res).toEqual({
      ok: true,
      enabled: true,
      locks: [{ id: 'lk_1', path: 'src/a.ts' }],
      expiresAt: 'T',
    });
    const call = calls.find((c) => c.body.params?.name === 'acquire_lock')!;
    // The holder identity is the RUN's token — the whole point of a token-per-call client.
    expect(call.auth).toBe('Bearer run-token');
    expect(call.body.params?.arguments).toEqual({
      projectId: 'prj_x',
      paths: ['src/a.ts'],
      branch: 'main',
      taskId: 'task_9',
    });
  });

  it('scopes to all branches when no branch is given (matches the server fallback, made explicit)', async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeMcp(() => ({ body: { ok: true, locks: [] } }), { calls });
    await client(fetchImpl).acquire('t', { projectId: 'prj_x', paths: ['a'] });
    const args = calls.find((c) => c.body.params?.name === 'acquire_lock')!.body.params!.arguments!;
    expect(args.allBranches).toBe(true);
    expect(args.branch).toBeUndefined();
  });

  it('shapes a conflict from the server view (all-or-nothing, names who to coordinate with)', async () => {
    const fetchImpl = fakeMcp(() => ({
      body: {
        ok: false,
        conflicts: [
          {
            requestedPath: 'src/a.ts',
            lockId: 'lk_2',
            path: 'src/',
            holderAgentId: 'agt_other',
            holderName: 'peer',
            taskKey: 'RUN-1',
            branch: 'main',
            expiresAt: '2026-07-20T00:00:00Z',
          },
        ],
      },
    }));
    const res = await client(fetchImpl).acquire('t', {
      projectId: 'prj_x',
      paths: ['src/a.ts'],
      branch: 'main',
    });
    expect(res).toEqual({
      ok: false,
      conflicts: [
        {
          path: 'src/a.ts',
          holder: 'agt_other',
          holderName: 'peer',
          taskKey: 'RUN-1',
          branch: 'main',
          expiresAt: '2026-07-20T00:00:00Z',
        },
      ],
    });
  });

  it('treats a locking-disabled project as a no-op grant, not a failure', async () => {
    const fetchImpl = fakeMcp(() => ({
      isError: true,
      text: 'file locking is not enabled for this project',
    }));
    const res = await client(fetchImpl).acquire('t', { projectId: 'prj_x', paths: ['a'], branch: 'main' });
    expect(res).toEqual({ ok: true, enabled: false, locks: [] });
  });

  it('throws on a real tool error (not the disabled sentinel)', async () => {
    const fetchImpl = fakeMcp(() => ({ isError: true, text: 'too many locks for this holder' }));
    await expect(client(fetchImpl).acquire('t', { projectId: 'prj_x', paths: ['a'] })).rejects.toThrow(
      /too many locks/,
    );
  });

  it('releases by ids and returns what the server dropped', async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeMcp(() => ({ body: { ok: true, released: ['lk_1', 'lk_2'] } }), { calls });
    const res = await client(fetchImpl).release('t', 'prj_x', { lockIds: ['lk_1', 'lk_2'] });
    expect(res.released).toEqual(['lk_1', 'lk_2']);
    const args = calls.find((c) => c.body.params?.name === 'release_lock')!.body.params!.arguments!;
    expect(args).toEqual({ projectId: 'prj_x', lockIds: ['lk_1', 'lk_2'] });
  });

  it('check maps conflicts and separates the caller’s own held locks (yours → mine)', async () => {
    const fetchImpl = fakeMcp(() => ({
      body: {
        enabled: true,
        conflicts: [{ requestedPath: 'a', path: 'a', holderAgentId: 'agt_other', expiresAt: 'T' }],
        yours: [{ lockId: 'lk_mine', path: 'b' }],
      },
    }));
    const res = await client(fetchImpl).check('t', { projectId: 'prj_x', paths: ['a', 'b'], branch: 'main' });
    expect(res.enabled).toBe(true);
    expect(res.conflicts).toEqual([
      { path: 'a', holder: 'agt_other', holderName: null, taskKey: null, branch: null, expiresAt: 'T' },
    ]);
    expect(res.mine).toEqual([{ id: 'lk_mine', path: 'b' }]);
  });

  it('releaseAllMine lists the holder’s own locks then releases those ids (RUN-104)', async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeMcp(
      (name) => {
        if (name === 'list_locks')
          return { body: { enabled: true, locks: [{ id: 'lk_1' }, { id: 'lk_2' }] } };
        return { body: { ok: true, released: ['lk_1', 'lk_2'] } };
      },
      { calls },
    );
    const res = await client(fetchImpl).releaseAllMine('run-token', 'prj_x');
    expect(res.released).toEqual(['lk_1', 'lk_2']);
    const list = calls.find((c) => c.body.params?.name === 'list_locks')!;
    expect(list.body.params?.arguments).toEqual({ projectId: 'prj_x', mine: true });
    const rel = calls.find((c) => c.body.params?.name === 'release_lock')!;
    expect(rel.body.params?.arguments).toEqual({ projectId: 'prj_x', lockIds: ['lk_1', 'lk_2'] });
  });

  it('releaseAllMine is a no-op when the holder has nothing (no release call)', async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeMcp(() => ({ body: { enabled: true, locks: [] } }), { calls });
    const res = await client(fetchImpl).releaseAllMine('t', 'prj_x');
    expect(res.released).toEqual([]);
    expect(calls.some((c) => c.body.params?.name === 'release_lock')).toBe(false);
  });

  it('re-initializes and retries once when the MCP session was recycled', async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeMcp(() => ({ body: { ok: true, locks: [] } }), { calls, expireOnce: true });
    const res = await client(fetchImpl).acquire('t', { projectId: 'prj_x', paths: ['a'] });
    expect(res.ok).toBe(true);
    // Two initialize handshakes (first session, then the re-init after the 404), and the tool
    // call ultimately succeeds — the retry is load-bearing, not polish.
    expect(calls.filter((c) => c.method === 'initialize')).toHaveLength(2);
  });

  it('reuses one session across calls with the same token', async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeMcp(() => ({ body: { ok: true, locks: [] } }), { calls });
    const c = client(fetchImpl);
    await c.acquire('t', { projectId: 'prj_x', paths: ['a'] });
    await c.acquire('t', { projectId: 'prj_x', paths: ['b'] });
    expect(calls.filter((x) => x.method === 'initialize')).toHaveLength(1); // handshake once
  });
});
