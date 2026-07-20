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
      agents: [],
      kinds: ['build'],
      maxConcurrency: 1,
      repos: [
        { id: 'repo_a', projectKey: 'AAA', board: null, name: 'a', defaultBranch: 'main', workflows: [] },
      ],
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

describe('MCP session lifecycle (RUN-73)', () => {
  // The live failure: the server refuses sessionless tool calls ("not attributable"), so
  // the daemon's get_task 400'd — anchor prompts degraded to bare ids — and every gate
  // comment silently never posted. These drive a stateful fake server: sessions are minted
  // by initialize, required for tools/call, and can be forgotten at any time (isolates
  // recycle), which is why the retry-once matters.
  type Frame = { method?: string; sid: string | null; toolName?: string };

  function fakeMcpServer(opts: { forgetAfterMint?: number } = {}) {
    const frames: Frame[] = [];
    const sessions = new Set<string>();
    let minted = 0;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        method?: string;
        params?: { name?: string };
      };
      const sid = new Headers(init?.headers).get('mcp-session-id');
      frames.push({ method: body.method, sid, toolName: body.params?.name });
      if (body.method === 'initialize') {
        minted += 1;
        const id = `sess_${minted}`;
        sessions.add(id);
        // Simulate an isolate recycling right after the handshake: the first N minted
        // sessions are forgotten before the first tool call arrives.
        if (opts.forgetAfterMint && minted <= opts.forgetAfterMint) sessions.delete(id);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 0, result: {} }), {
          status: 200,
          headers: { 'mcp-session-id': id },
        });
      }
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (!sid || !sessions.has(sid)) {
        return new Response(JSON.stringify({ error: 'no MCP session — call initialize first' }), {
          status: 400,
        });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [
              { type: 'text', text: JSON.stringify({ task: { key: 'K-1', title: 'T', body: null } }) },
            ],
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    return { fetchImpl, frames, mintedCount: () => minted };
  }

  it('initializes once, sends the session header on every tool call, and reuses the session', async () => {
    const srv = fakeMcpServer();
    const client = new NoriqClient({ server: 'https://a.b', token: 't', fetchImpl: srv.fetchImpl });
    expect(await client.getTask('task_1')).toEqual({ key: 'K-1', title: 'T', body: null });
    await client.getTask('task_2');
    expect(srv.mintedCount()).toBe(1); // ONE handshake, N calls
    const calls = srv.frames.filter((f) => f.method === 'tools/call');
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.sid).toBe('sess_1');
    // The spec's follow-up rode the new session too.
    expect(srv.frames.some((f) => f.method === 'notifications/initialized' && f.sid === 'sess_1')).toBe(true);
  });

  it('identifies itself in the handshake — attributability is the point', async () => {
    const srv = fakeMcpServer();
    const client = new NoriqClient({ server: 'https://a.b', token: 't', fetchImpl: srv.fetchImpl });
    await client.getTask('task_1');
    // Re-parse the captured initialize frame from the raw body we recorded via frames? The
    // fake keeps only method/sid, so capture again with a probe: one more client, one frame.
    let init: { params?: { clientInfo?: { name?: string; version?: string } } } | null = null;
    const probe = (async (_u: string | URL, i?: RequestInit) => {
      const b = JSON.parse(String(i?.body));
      if (b.method === 'initialize') init = b;
      return srv.fetchImpl(_u, i);
    }) as typeof fetch;
    const client2 = new NoriqClient({ server: 'https://a.b', token: 't', fetchImpl: probe });
    await client2.getTask('task_1');
    expect(init!.params?.clientInfo?.name).toBe('noriq-runner');
    expect(init!.params?.clientInfo?.version).toBeTruthy();
  });

  it('a session the server forgot → ONE fresh handshake and a retry, not an error', async () => {
    // Worker isolates recycle sessions at will; the daemon may hold a session id the server
    // no longer knows. That must cost one retry, not an anchor prompt or a lost comment.
    const srv = fakeMcpServer({ forgetAfterMint: 1 });
    const client = new NoriqClient({ server: 'https://a.b', token: 't', fetchImpl: srv.fetchImpl });
    expect(await client.getTask('task_1')).toEqual({ key: 'K-1', title: 'T', body: null });
    expect(srv.mintedCount()).toBe(2); // the forgotten one + the retry's
  });

  it('postComment rides the same session machinery (the gate-comment surface)', async () => {
    const srv = fakeMcpServer();
    const client = new NoriqClient({ server: 'https://a.b', token: 't', fetchImpl: srv.fetchImpl });
    await client.postComment('prj_1', 'task_1', 'verify failed: …');
    const call = srv.frames.find((f) => f.method === 'tools/call');
    expect(call?.toolName).toBe('add_comment');
    expect(call?.sid).toBe('sess_1');
  });
});

describe('checkClaimable phase-gate probe (RUN-81)', () => {
  // A minimal MCP server: handshake, then one can_claim tool result (or an error status).
  const mcp = (toolResult: unknown, toolStatus = 200) =>
    (async (_url: string | URL, init?: RequestInit) => {
      const method = (JSON.parse(String(init?.body)) as { method?: string }).method;
      if (method === 'initialize')
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 0, result: {} }), {
          status: 200,
          headers: { 'mcp-session-id': 'sess_1' },
        });
      if (method === 'notifications/initialized') return new Response(null, { status: 202 });
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: JSON.stringify(toolResult) }] },
        }),
        { status: toolStatus },
      );
    }) as typeof fetch;

  it('returns the gate verdict, reason and all, when the server answers', async () => {
    const client = new NoriqClient({
      server: 'https://a.b',
      token: 't',
      fetchImpl: mcp({ claimable: false, reason: 'phase 1 not complete' }),
    });
    expect(await client.checkClaimable('task_1')).toEqual({
      claimable: false,
      reason: 'phase 1 not complete',
    });
  });

  it('calls the can_claim tool with the task id', async () => {
    const frames: string[] = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method?: string; params?: { name?: string } };
      if (body.method === 'tools/call') frames.push(body.params?.name ?? '');
      if (body.method === 'initialize')
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 0, result: {} }), {
          status: 200,
          headers: { 'mcp-session-id': 'sess_1' },
        });
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: '{"claimable":true}' }] },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const client = new NoriqClient({ server: 'https://a.b', token: 't', fetchImpl });
    await client.checkClaimable('task_9');
    expect(frames).toEqual(['can_claim']);
  });

  it('fails OPEN (null) when the probe errors — e.g. an older server without the tool', async () => {
    const client = new NoriqClient({
      server: 'https://a.b',
      token: 't',
      fetchImpl: mcp({ error: 'unknown tool can_claim' }, 500),
    });
    expect(await client.checkClaimable('task_1')).toBeNull();
  });

  it('fails OPEN (null) when the answer is malformed (no boolean `claimable`)', async () => {
    const client = new NoriqClient({
      server: 'https://a.b',
      token: 't',
      fetchImpl: mcp({ gated: 'yes' }),
    });
    expect(await client.checkClaimable('task_1')).toBeNull();
  });
});
