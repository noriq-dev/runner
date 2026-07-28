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
  opts: { calls?: Call[]; sessionId?: string; expireOnce?: boolean; bound?: boolean } = {},
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
      // `bound` answers the way the real server answers a run-agent token: a 200 with a valid
      // result and deliberately NO session header, because the identity is the token itself.
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 0, result: {} }), {
        status: 200,
        ...(opts.bound ? {} : { headers: { 'mcp-session-id': sid } }),
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

// The lock floor authenticates as the RUN's agent, whose token is BOUND server-side — and the
// server issues no session id for one, on purpose: the identity is the token, and "no session id
// can move it". Requiring the header made every lock call from a run agent throw, which failed two
// finished builds on their first live dispatch (RUN-177).
describe('LockClient under a bound run-agent token (RUN-177)', () => {
  it('proceeds when initialize returns 200 with no session id, instead of treating it as a failure', async () => {
    const fetchImpl = fakeMcp(() => ({ body: { ok: true, locks: [{ id: 'lk_1', path: 'a' }] } }), {
      bound: true,
    });
    const res = await client(fetchImpl).acquire('run-token', { projectId: 'prj_x', paths: ['a'] });
    expect(res.ok).toBe(true);
  });

  it('does NOT re-handshake on a 404 — with no session, that is the server’s real answer', async () => {
    // The stale-session retry exists because a worker isolate can recycle a session out from under
    // us. A bound token has none, so retrying cannot help, and a failing second handshake would
    // replace the tool's own error with a misleading one.
    const calls: Call[] = [];
    const fetchImpl = fakeMcp(() => ({ body: { ok: true, locks: [] } }), {
      calls,
      bound: true,
      expireOnce: true,
    });
    await expect(
      client(fetchImpl).acquire('run-token', { projectId: 'prj_x', paths: ['a'] }),
    ).rejects.toThrow(/acquire_lock → 404/);
    expect(calls.filter((c) => c.method === 'initialize')).toHaveLength(1);
  });

  it('omits the mcp-session-id header on the tool call — there is no session to name', async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeMcp(() => ({ body: { ok: true, locks: [] } }), { calls, bound: true });
    await client(fetchImpl).acquire('run-token', { projectId: 'prj_x', paths: ['a'] });
    const call = calls.find((c) => c.body.params?.name === 'acquire_lock');
    expect(call?.session).toBeNull();
    expect(call?.auth).toBe('Bearer run-token');
  });

  it('handshakes ONCE — a null session is an answer, not a missing value to retry for', async () => {
    // The regression this guards: caching `null` under a `??` lookup reads as "not initialized",
    // so every call re-handshakes. Cheap to miss, and only visible as call volume.
    const calls: Call[] = [];
    const fetchImpl = fakeMcp(() => ({ body: { ok: true, locks: [] } }), { calls, bound: true });
    const c = client(fetchImpl);
    await c.acquire('run-token', { projectId: 'prj_x', paths: ['a'] });
    await c.acquire('run-token', { projectId: 'prj_x', paths: ['b'] });
    expect(calls.filter((x) => x.method === 'initialize')).toHaveLength(1);
  });

  it('still treats a non-2xx initialize as fatal — only the MISSING HEADER stopped being an error', async () => {
    const fetchImpl = (async () =>
      new Response('{"error":"invalid, expired, or revoked token"}', { status: 401 })) as typeof fetch;
    await expect(
      client(fetchImpl).acquire('dead-token', { projectId: 'prj_x', paths: ['a'] }),
    ).rejects.toThrow(/lock mcp initialize → 401/);
  });

  it('releases nothing, quietly — no kind is granted the release tools, so this is the NORMAL path', async () => {
    // Not an edge case: `release_lock`/`list_locks` are deliberately on no kind's floor, because
    // the agent shares the run's identity and would otherwise be able to drop the hard floor's own
    // locks. The server releases on run settle, so the daemon's release is pure promptness — and
    // warning on every single run would train people to ignore the log.
    const fetchImpl = fakeMcp(
      () => ({ isError: true, text: 'MCP error -32602: Tool list_locks not found' }),
      { bound: true },
    );
    await expect(client(fetchImpl).releaseAllMine('run-token', 'prj_x')).resolves.toEqual({ released: [] });
  });

  it('the same holds for a direct release by id', async () => {
    const fetchImpl = fakeMcp(
      () => ({ isError: true, text: 'MCP error -32602: Tool release_lock not found' }),
      { bound: true },
    );
    await expect(client(fetchImpl).release('run-token', 'prj_x', { lockIds: ['lk_1'] })).resolves.toEqual({
      released: [],
    });
  });

  it('matches the tool it CALLED, not any "not found" prose the server echoes back', async () => {
    // `reply.text` can contain server prose about a path, and a lock path is attacker-adjacent
    // input — an agent controls what it asks to lock. A loose /tool \w+ not found/ would let a
    // path like `tool foo not found` turn a genuine release failure into a silent success.
    const fetchImpl = fakeMcp(
      () => ({
        isError: true,
        text: 'cannot release lock on path "tool foo not found[" — malformed pattern',
      }),
      { bound: true },
    );
    await expect(client(fetchImpl).release('run-token', 'prj_x', { lockIds: ['lk_1'] })).rejects.toThrow(
      /release_lock/,
    );
  });

  it('but a MISSING acquire tool still gates — a floor that cannot run must never read as "no locks needed"', async () => {
    // The asymmetry is the point. On release, an ungranted tool means nothing is held. On
    // acquire, it means the check did not happen — and treating that as success would fail open
    // over exactly the paths the floor exists to guard.
    const fetchImpl = fakeMcp(
      () => ({ isError: true, text: 'MCP error -32602: Tool acquire_lock not found' }),
      { bound: true },
    );
    await expect(
      client(fetchImpl).acquire('run-token', { projectId: 'prj_x', paths: ['a'] }),
    ).rejects.toThrow(/acquire_lock/);
  });

  it('lets a locking-disabled project answer for itself: enabled=false, no conflicts, no gate', async () => {
    // The end-to-end shape of the live failure. prj_run has file locking OFF, so the floor had
    // nothing to check — but initialize threw before the project could say so, and two finished
    // builds were gated on the silence.
    const fetchImpl = fakeMcp(
      () => ({ isError: true, text: 'file locking is not enabled for this project' }),
      {
        bound: true,
      },
    );
    const res = await client(fetchImpl).acquire('run-token', { projectId: 'prj_run', paths: ['a'] });
    expect(res).toEqual({ ok: true, enabled: false, locks: [] });
  });
});
