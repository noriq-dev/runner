import { describe, expect, it } from 'vitest';
import { NoriqClient, NoriqHttpError } from '../src/client';

interface Captured {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

/** RUN-234: capture what a `getIndexCursor`/`getContextPack` failure logs — never a real logger,
 *  and never `console` (the `logger.ts` default) so a test can assert on structured fields. */
interface LoggedLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  fields?: Record<string, unknown>;
}
function captureLogger(): {
  lines: LoggedLine[];
  logger: import('../src/client').NoriqClientOptions['logger'];
} {
  const lines: LoggedLine[] = [];
  const make = (level: LoggedLine['level']) => (msg: string, fields?: Record<string, unknown>) =>
    lines.push({ level, msg, fields });
  return {
    lines,
    logger: { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') },
  };
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
        {
          id: 'repo_a',
          projectKey: 'AAA',
          board: null,
          name: 'a',
          defaultBranch: 'main',
          repositoryKey: null,
          workflows: [],
        },
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

  // RUN-220: a bare Error string forced every caller to regex .message for the status. The
  // ingest client needs to tell a 503 (permanent) apart from a 404/403 (re-mint or give up) —
  // NoriqHttpError carries the real status/body alongside the pre-existing message format.
  it('a non-2xx response is a NoriqHttpError carrying the real status and body', async () => {
    const client = new NoriqClient({
      server: 'https://a.b',
      token: 't',
      fetchImpl: fakeFetch(503, { error: 'ingest capabilities are not enabled' }, []),
    });
    let caught: unknown;
    try {
      await client.heartbeat('rnr_x', { freeSlots: 0 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NoriqHttpError);
    const err = caught as NoriqHttpError;
    expect(err.status).toBe(503);
    expect(err.body).toContain('ingest capabilities are not enabled');
  });
});

// RUN-220: minting under the daemon's own OAuth identity, via this same authenticated client
// (locked decision 7) — the ONLY thing this client does with an ingest capability. The five
// token-authorized upload calls themselves live in ingest-client.ts and are exercised there.
describe('mintIngestCapability (RUN-220)', () => {
  const INPUT = {
    projectId: 'prj_1',
    repositoryKey: 'my-repo',
    purpose: 'index' as const,
    scopeId: 'gen_1',
    runnerId: 'rnr_1',
  };

  it('POSTs with a bearer token and unwraps the grant', async () => {
    const captured: Captured[] = [];
    const grant = { token: 'ing_abc', maxBytes: 8 * 1024 * 1024, expiresAt: '2026-08-08T00:15:00.000Z' };
    const client = new NoriqClient({
      server: 'https://noriq.example',
      token: 'tok123',
      fetchImpl: fakeFetch(200, grant, captured),
    });
    expect(await client.mintIngestCapability(INPUT)).toEqual(grant);
    expect(captured[0]).toMatchObject({
      url: 'https://noriq.example/api/runner-ingest/capability',
      method: 'POST',
      auth: 'Bearer tok123',
      body: INPUT,
    });
  });

  it('a 503 (ingest not enabled on this server) surfaces as a distinguishable status', async () => {
    const client = new NoriqClient({
      server: 'https://a.b',
      token: 't',
      fetchImpl: fakeFetch(503, { error: 'ingest capabilities are not enabled' }, []),
    });
    let caught: unknown;
    try {
      await client.mintIngestCapability(INPUT);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NoriqHttpError);
    expect((caught as NoriqHttpError).status).toBe(503);
  });

  it('a 404 (unresolvable repository key) is distinguishable from the 503 above', async () => {
    const client = new NoriqClient({
      server: 'https://a.b',
      token: 't',
      fetchImpl: fakeFetch(404, { error: 'no repository registered for key "my-repo" in this project' }, []),
    });
    let caught: unknown;
    try {
      await client.mintIngestCapability(INPUT);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NoriqHttpError);
    expect((caught as NoriqHttpError).status).toBe(404);
  });
});

describe('MCP session lifecycle (RUN-73)', () => {
  // The live failure: the server refuses sessionless tool calls ("not attributable"), so
  // the daemon's get_task 400'd — anchor prompts degraded to bare ids — and every gate
  // comment silently never posted. These drive a stateful fake server: sessions are minted
  // by initialize, required for tools/call, and can be forgotten at any time (isolates
  // recycle), which is why the retry-once matters.
  type Frame = { method?: string; sid: string | null; toolName?: string };

  function fakeMcpServer(opts: { forgetAfterMint?: number; task?: unknown } = {}) {
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
              {
                type: 'text',
                text: JSON.stringify({ task: opts.task ?? { key: 'K-1', title: 'T', body: null } }),
              },
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
    expect(await client.getTask('task_1')).toEqual({
      key: 'K-1',
      title: 'T',
      body: null,
      executionSpec: null,
      executionSpecUnreadable: false,
    });
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
    expect(await client.getTask('task_1')).toEqual({
      key: 'K-1',
      title: 'T',
      body: null,
      executionSpec: null,
      executionSpecUnreadable: false,
    });
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

// RUN-188: the task-pointer check reads a spun-off task's provenance through getTask. The read is
// LENIENT where the spec read beside it is strict, because the stakes invert: a spec that
// misparses could be overwritten, while provenance only ever sharpens an existence check — so a
// malformed field must not fail the lookup that carries the rest.
describe('getTask spin-off provenance (RUN-188)', () => {
  const mcp = (task: unknown) =>
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
          result: { content: [{ type: 'text', text: JSON.stringify({ task }) }] },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

  it('reads provenance when the server sends it', async () => {
    const client = new NoriqClient({
      server: 'https://a.b',
      token: 't',
      fetchImpl: mcp({
        key: 'RUN-201',
        title: 'Harden the guard floor',
        spinOff: { sourceTaskId: 'task_9', sourceRunId: 'run_1', finding: 'the guard is missing' },
      }),
    });
    const t = await client.getTask('RUN-201');
    expect(t?.spinOff).toEqual({
      sourceTaskId: 'task_9',
      sourceRunId: 'run_1',
      finding: 'the guard is missing',
    });
  });

  it('a task without the field carries NO provenance — every pre-RUN-188 server', async () => {
    const client = new NoriqClient({
      server: 'https://a.b',
      token: 't',
      fetchImpl: mcp({ key: 'K-1', title: 'T' }),
    });
    const t = await client.getTask('K-1');
    expect(t).not.toBeNull();
    expect(t && 'spinOff' in t).toBe(false);
  });

  it('malformed provenance degrades field by field — the task itself still resolves', async () => {
    const client = new NoriqClient({
      server: 'https://a.b',
      token: 't',
      fetchImpl: mcp({ key: 'K-1', title: 'T', spinOff: { sourceRunId: 42, finding: '' } }),
    });
    const t = await client.getTask('K-1');
    expect(t?.key).toBe('K-1');
    expect(t?.spinOff).toEqual({ sourceTaskId: null, sourceRunId: null, finding: null });
  });

  // The boundary is TYPE-checked, not truthiness-checked: a truthy non-string key/title crossing
  // it throws in whatever string-shaped code touches it next — on the adjudication path, that
  // aborted a fold. A malformed task is the same answer as none.
  it('a truthy non-string key/title reads as no task at all', async () => {
    const client = new NoriqClient({
      server: 'https://a.b',
      token: 't',
      fetchImpl: mcp({ key: 'K-1', title: 42 }),
    });
    expect(await client.getTask('K-1')).toBeNull();
  });
});

// RUN-213: PLNR-306's agentAuth route, reached over the plain REST rail (not MCP) — the daemon's
// only way to see the server's index cursor at all, since the human-facing read lives under
// /api/projects/:pid/* (userAuth-gated, unreachable for a Bearer-only daemon).
describe('getIndexCursor (RUN-213)', () => {
  const VALID_CURSOR = {
    repositoryKey: 'my-repo',
    defaultBranch: 'main',
    latestObservedBase: 'base-1',
    activeGeneration: {
      id: 'gen_1',
      branch: 'main',
      baseId: 'base-1',
      indexerVersion: '1',
      status: 'active',
      batchCount: 1,
      fileCount: 10,
      sealedAt: '2026-08-01T00:00:00.000Z',
      validationProblems: [],
      createdAt: '2026-08-01T00:00:00.000Z',
      activatedAt: '2026-08-01T00:00:00.000Z',
    },
    stagedGenerations: [],
    stale: false,
    failedIngest: false,
    failedIngestProblems: [],
    association: { state: 'associated', projectRepositoryId: 'prjrepo_1' },
  };

  it('POSTs the four fields to the runner-memory route and parses a valid cursor', async () => {
    const captured: Captured[] = [];
    const client = new NoriqClient({
      server: 'https://a.b',
      token: 't',
      fetchImpl: fakeFetch(200, VALID_CURSOR, captured),
    });
    const cursor = await client.getIndexCursor('rnr_1', {
      projectId: 'prj_1',
      repositoryKey: 'my-repo',
      checkoutId: 'repo_abc',
    });
    expect(cursor).toEqual(VALID_CURSOR);
    expect(captured[0]).toMatchObject({
      url: 'https://a.b/api/runner-memory/index-cursor',
      method: 'POST',
      body: { projectId: 'prj_1', repositoryKey: 'my-repo', runnerId: 'rnr_1', checkoutId: 'repo_abc' },
    });
  });

  it('an unresolved project (projectId null) is refused before any request is attempted', async () => {
    const captured: Captured[] = [];
    const client = new NoriqClient({
      server: 'https://a.b',
      token: 't',
      fetchImpl: fakeFetch(200, VALID_CURSOR, captured),
    });
    const cursor = await client.getIndexCursor('rnr_1', {
      projectId: null,
      repositoryKey: 'my-repo',
      checkoutId: 'repo_abc',
    });
    expect(cursor).toBeNull();
    expect(captured).toHaveLength(0); // no I/O attempted at all
  });

  it('a non-2xx response is a null cursor, never a thrown error', async () => {
    const client = new NoriqClient({
      server: 'https://a.b',
      token: 't',
      fetchImpl: fakeFetch(404, { error: 'no repository registered' }, []),
    });
    const cursor = await client.getIndexCursor('rnr_1', {
      projectId: 'prj_1',
      repositoryKey: 'my-repo',
      checkoutId: 'repo_abc',
    });
    expect(cursor).toBeNull();
  });

  it('a body that does not parse as RunnerIndexCursor is a null cursor, not a hand-read partial', async () => {
    const client = new NoriqClient({
      server: 'https://a.b',
      token: 't',
      // missing every required field
      fetchImpl: fakeFetch(200, { ok: true }, []),
    });
    const cursor = await client.getIndexCursor('rnr_1', {
      projectId: 'prj_1',
      repositoryKey: 'my-repo',
      checkoutId: 'repo_abc',
    });
    expect(cursor).toBeNull();
  });

  it('a network error is a null cursor', async () => {
    const client = new NoriqClient({
      server: 'https://a.b',
      token: 't',
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
    });
    const cursor = await client.getIndexCursor('rnr_1', {
      projectId: 'prj_1',
      repositoryKey: 'my-repo',
      checkoutId: 'repo_abc',
    });
    expect(cursor).toBeNull();
  });

  // RUN-234: the same four null-collapsing branches above, now asserting WHAT they log — the
  // return value is unchanged (still `null` on every branch, still asserted above); this is the
  // added visibility, never a second answer to what the caller receives.
  describe('logs the distinction a null return value erases (RUN-234)', () => {
    it('an unresolved project logs a precondition, not a fetch failure — at debug, not warn', async () => {
      const { lines, logger } = captureLogger();
      const client = new NoriqClient({
        server: 'https://a.b',
        token: 't',
        fetchImpl: fakeFetch(200, {}, []),
        logger,
      });
      await client.getIndexCursor('rnr_1', { projectId: null, repositoryKey: 'my-repo', checkoutId: 'c' });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ level: 'debug', fields: { repositoryKey: 'my-repo' } });
    });

    it('a non-2xx logs the status code, category "http" — never the response body', async () => {
      const { lines, logger } = captureLogger();
      const client = new NoriqClient({
        server: 'https://a.b',
        token: 't',
        fetchImpl: fakeFetch(503, { error: 'a secret-looking detail nobody should see logged' }, []),
        logger,
      });
      await client.getIndexCursor('rnr_1', { projectId: 'prj_1', repositoryKey: 'my-repo', checkoutId: 'c' });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ level: 'warn', fields: { category: 'http', status: 503 } });
      expect(JSON.stringify(lines[0])).not.toContain('secret-looking detail');
    });

    it('a schema-invalid 200 logs category "schema" — distinct from an http failure', async () => {
      const { lines, logger } = captureLogger();
      const client = new NoriqClient({
        server: 'https://a.b',
        token: 't',
        fetchImpl: fakeFetch(200, { ok: true }, []),
        logger,
      });
      await client.getIndexCursor('rnr_1', { projectId: 'prj_1', repositoryKey: 'my-repo', checkoutId: 'c' });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ level: 'warn', fields: { category: 'schema' } });
      expect(lines[0]?.fields?.status).toBeUndefined();
    });

    it('a transport error logs category "transport" with a bounded message — never the request URL or token', async () => {
      const { lines, logger } = captureLogger();
      const client = new NoriqClient({
        server: 'https://a.b',
        token: 'super-secret-token',
        fetchImpl: (async () => {
          throw new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:443');
        }) as typeof fetch,
        logger,
      });
      await client.getIndexCursor('rnr_1', { projectId: 'prj_1', repositoryKey: 'my-repo', checkoutId: 'c' });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ level: 'warn', fields: { category: 'transport' } });
      expect(JSON.stringify(lines[0])).not.toContain('super-secret-token');
    });
  });
});

describe('getContextPack (RUN-228)', () => {
  const VALID_PACK = {
    taskId: 'task_1',
    projectId: 'prj_1',
    generatedAt: '2026-08-09T00:00:00.000Z',
    charBudget: 4000,
    charsUsed: 100,
    taskFacts: {
      taskId: 'task_1',
      key: 'RUN-1',
      title: 't',
      body: null,
      status: 'todo',
      priority: 2,
      claimedBy: null,
      claimExpiresAt: null,
      openComments: [],
      executionSpec: null,
      executionSpecUnreadable: false,
    },
    sections: [],
  };

  // Same shape as `getIndexCursor`'s own precedent above (locked decision this task cites): ONE
  // parser, every failure collapsing to `null` rather than three call sites the caller has to
  // keep in sync with a server that can fail in new ways this daemon has never seen.

  it('POSTs the identity fields to the runner-memory route and parses a valid pack', async () => {
    const captured: Captured[] = [];
    const client = new NoriqClient({
      server: 'https://a.b',
      token: 't',
      fetchImpl: fakeFetch(200, VALID_PACK, captured),
    });
    const pack = await client.getContextPack('rnr_1', {
      projectId: 'prj_1',
      taskId: 'task_1',
      repositoryKey: 'my-repo',
      baseId: 'sha123',
      branch: 'main',
      role: 'build',
    });
    // `toMatchObject`, not `toEqual`: the schema fills in defaults (role, mode, the various
    // empty-array fields) that a minimal wire payload never sends — the point of this assertion
    // is that the fields VALID_PACK DOES carry survived the parse, not that no default fired.
    expect(pack).toMatchObject(VALID_PACK);
    expect(captured[0]).toMatchObject({
      url: 'https://a.b/api/runner-memory/context',
      method: 'POST',
      body: {
        projectId: 'prj_1',
        runnerId: 'rnr_1',
        taskId: 'task_1',
        repositoryKey: 'my-repo',
        baseId: 'sha123',
        branch: 'main',
        role: 'build',
      },
    });
  });

  it('a route absent on an old server (404) is a null pack, never a thrown error', async () => {
    const client = new NoriqClient({
      server: 'https://a.b',
      token: 't',
      fetchImpl: fakeFetch(404, { error: 'not found' }, []),
    });
    const pack = await client.getContextPack('rnr_1', {
      projectId: 'prj_1',
      taskId: 'task_1',
      repositoryKey: 'my-repo',
    });
    expect(pack).toBeNull();
  });

  it('a body that does not parse as ContextPack is a null pack, not a hand-read partial', async () => {
    const client = new NoriqClient({
      server: 'https://a.b',
      token: 't',
      // missing every required field
      fetchImpl: fakeFetch(200, { ok: true }, []),
    });
    const pack = await client.getContextPack('rnr_1', {
      projectId: 'prj_1',
      taskId: 'task_1',
      repositoryKey: 'my-repo',
    });
    expect(pack).toBeNull();
  });

  it('a network error is a null pack', async () => {
    const client = new NoriqClient({
      server: 'https://a.b',
      token: 't',
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
    });
    const pack = await client.getContextPack('rnr_1', {
      projectId: 'prj_1',
      taskId: 'task_1',
      repositoryKey: 'my-repo',
    });
    expect(pack).toBeNull();
  });

  it('optional fields absent from the caller are absent from the wire body, never sent as null', async () => {
    const captured: Captured[] = [];
    const client = new NoriqClient({
      server: 'https://a.b',
      token: 't',
      fetchImpl: fakeFetch(200, VALID_PACK, captured),
    });
    await client.getContextPack('rnr_1', { projectId: 'prj_1', taskId: 'task_1' });
    expect(captured[0]?.body).toEqual({ projectId: 'prj_1', runnerId: 'rnr_1', taskId: 'task_1' });
  });

  // RUN-234: same three failure-category assertions as `getIndexCursor`'s own block above — this
  // method has no precondition branch of its own (`repositoryKey`/`taskId` are checked one layer
  // up, in `context-pack.ts`, never here).
  describe('logs the distinction a null return value erases (RUN-234)', () => {
    it('a non-2xx logs the status code, category "http"', async () => {
      const { lines, logger } = captureLogger();
      const client = new NoriqClient({
        server: 'https://a.b',
        token: 't',
        fetchImpl: fakeFetch(404, {}, []),
        logger,
      });
      await client.getContextPack('rnr_1', { projectId: 'prj_1', taskId: 'task_1' });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        level: 'warn',
        fields: { category: 'http', status: 404, taskId: 'task_1' },
      });
    });

    it('a schema-invalid 200 logs category "schema"', async () => {
      const { lines, logger } = captureLogger();
      const client = new NoriqClient({
        server: 'https://a.b',
        token: 't',
        fetchImpl: fakeFetch(200, { ok: true }, []),
        logger,
      });
      await client.getContextPack('rnr_1', { projectId: 'prj_1', taskId: 'task_1' });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ level: 'warn', fields: { category: 'schema', taskId: 'task_1' } });
    });

    it('a transport error logs category "transport" with a bounded message', async () => {
      const { lines, logger } = captureLogger();
      const client = new NoriqClient({
        server: 'https://a.b',
        token: 't',
        fetchImpl: (async () => {
          throw new Error('ECONNREFUSED');
        }) as typeof fetch,
        logger,
      });
      await client.getContextPack('rnr_1', { projectId: 'prj_1', taskId: 'task_1' });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ level: 'warn', fields: { category: 'transport' } });
    });
  });
});
