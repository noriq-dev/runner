import { PassThrough } from 'node:stream';
import type { PermissionProfile, RunEffort, RunKind } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import { AsyncQueue } from '../src/async-queue';
import { noriqToolsFor } from '../src/drivers/claude';
import {
  CodexDriver,
  type CodexEvent,
  type CodexTransport,
  type SpawnCodex,
  defaultSpawnCodex,
  mapEffort,
  mapSandbox,
  normalizeNotification,
} from '../src/drivers/codex';
import type { DriverStartOptions, DriverTelemetry } from '../src/drivers/types';

class FakeTransport implements CodexTransport {
  readonly events = new AsyncQueue<CodexEvent>();
  turns: string[] = [];
  steers: string[] = [];
  interrupted = 0;
  closed = false;
  sandbox = '';
  sendUserTurn(text: string): void {
    this.turns.push(text);
  }
  /** Mirrors the real transport: nothing to steer once the session is closed. */
  steer(text: string): boolean {
    if (this.closed) return false;
    this.steers.push(text);
    return true;
  }
  interrupt(): void {
    this.interrupted += 1;
  }
  close(): void {
    this.closed = true;
    this.events.close();
  }
  push(ev: CodexEvent): void {
    this.events.push(ev);
  }
}

const profile = (over: Partial<PermissionProfile> = {}): PermissionProfile => ({
  write: false,
  network: 'restricted',
  allow: [],
  deny: [],
  auto: false,
  ...over,
});

function harness(startOver: Partial<DriverStartOptions> = {}) {
  let fake!: FakeTransport;
  const spawnCodex: SpawnCodex = (opts) => {
    fake = new FakeTransport();
    fake.sandbox = opts.sandbox;
    return fake;
  };
  const telemetry: DriverTelemetry[] = [];
  const texts: string[] = [];
  const driver = new CodexDriver({ spawnCodex });
  const session = driver.start({
    runId: 'run_1',
    kind: 'build',
    cwd: '/wt',
    prompt: 'do the thing',
    permission: profile({ write: true }),
    handlers: { onText: (t) => texts.push(t), onTelemetry: (t) => telemetry.push(t) },
    ...startOver,
  });
  return { session, telemetry, texts, getFake: () => fake };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('mapSandbox', () => {
  it('maps write→workspace-write, read-only otherwise', () => {
    expect(mapSandbox(profile({ write: false }))).toBe('read-only');
    expect(mapSandbox(profile({ write: true }))).toBe('workspace-write');
  });
});

describe('driver capabilities (RUN-110)', () => {
  it('codex declares NO in-process hooks, no resume, no per-model telemetry', () => {
    const driver = new CodexDriver({ spawnCodex: (() => ({})) as never });
    expect(driver.tool).toBe('codex');
    expect(driver.capabilities).toEqual({
      toolHooks: false,
      steer: true,
      interrupt: true,
      resumableSession: false,
      perModelTelemetry: false,
    });
  });
});

describe('normalizeNotification (real app-server shapes)', () => {
  it('maps agentMessageDelta / tokenUsage / turn.completed / error', () => {
    expect(normalizeNotification('thread/agentMessageDelta', { delta: 'hi' })).toEqual({
      type: 'text',
      text: 'hi',
    });
    expect(
      normalizeNotification('thread/tokenUsageUpdated', {
        tokenUsage: { total: { inputTokens: 30, outputTokens: 12, cachedInputTokens: 4 } },
      }),
    ).toEqual({ type: 'usage', inputTokens: 30, outputTokens: 12, cacheReadTokens: 4 });
    expect(normalizeNotification('turn/completed', {})).toEqual({ type: 'turn_complete' });
    expect(normalizeNotification('thread/error', { error: { message: 'boom' } })).toEqual({
      type: 'error',
      message: 'boom',
    });
    expect(normalizeNotification('thread/unknown', {})).toBeNull();
  });

  it('accepts the 0.144.x names too — every notification was RENAMED between minors (RUN-72)', () => {
    // Verified live against codex-cli 0.144.5. The daemon cannot pick which codex a machine
    // has installed, so each concept answers to every name it has ever had.
    expect(normalizeNotification('item/agentMessage/delta', { delta: 'OK' })).toEqual({
      type: 'text',
      text: 'OK',
    });
    expect(
      normalizeNotification('thread/tokenUsage/updated', {
        tokenUsage: { total: { inputTokens: 12851, outputTokens: 12, cachedInputTokens: 0 } },
      }),
    ).toEqual({ type: 'usage', inputTokens: 12851, outputTokens: 12, cacheReadTokens: 0 });
    expect(normalizeNotification('error', { error: { message: 'invalid_request_error' } })).toEqual({
      type: 'error',
      message: 'invalid_request_error',
    });
  });

  it('a FAILED turn/completed is an error, not success — 0.144.x reports API failures there (RUN-72)', () => {
    // An API-level failure arrives as turn/completed{status:'failed'}; reading it as success
    // marked runs `done` whose agent never answered.
    expect(
      normalizeNotification('turn/completed', {
        turn: { status: 'failed', error: { message: 'model not supported' } },
      }),
    ).toEqual({ type: 'error', message: 'model not supported' });
    expect(normalizeNotification('turn/completed', { turn: { status: 'completed' } })).toEqual({
      type: 'turn_complete',
    });
    // 0.142.x sends no status at all — that generation's failures came as thread/error.
    expect(normalizeNotification('turn/completed', {})).toEqual({ type: 'turn_complete' });
  });
});

describe('CodexDriver', () => {
  it('starts a turn, streams text, sets cumulative telemetry, completes on turn_complete', async () => {
    const h = harness();
    const fake = h.getFake();
    expect(fake.sandbox).toBe('workspace-write'); // build → workspace-write
    expect(fake.turns).toEqual(['do the thing']); // initial prompt submitted as a turn
    fake.push({ type: 'text', text: 'patching…' });
    fake.push({ type: 'usage', inputTokens: 200, outputTokens: 50, cacheReadTokens: 10 });
    fake.push({ type: 'turn_complete' });
    const exit = await h.session.done();
    expect(exit.outcome).toBe('done');
    expect(exit.telemetry).toMatchObject({
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: 10,
      numTurns: 1,
    });
    expect(h.texts).toContain('patching…');
    expect(fake.closed).toBe(true);
  });

  it('streams agentMessageDelta text byte-faithfully, newlines intact (RUN-77 parity)', async () => {
    // Codex's only text source is the raw agentMessageDelta stream (no assembled-message
    // path), so concatenated deltas reproduce the model's bytes exactly — the newlines the
    // claude driver used to drop. Deltas split mid-word AND at the newline itself.
    const h = harness();
    const fake = h.getFake();
    for (const text of [
      'I’ll review the diff.',
      '\n',
      'The changed wizard now.',
      '\n- High — VCS detec',
      'tion.',
    ]) {
      fake.push({ type: 'text', text });
    }
    fake.push({ type: 'turn_complete' });
    await h.session.done();
    const joined = h.texts.join('');
    expect(joined).toBe('I’ll review the diff.\nThe changed wizard now.\n- High — VCS detection.');
    expect(joined).not.toContain('diff.The');
  });

  it('separates distinct agentMessage items with a paragraph break; id-less deltas never do (RUN-80)', async () => {
    const h = harness();
    const fake = h.getFake();
    fake.push({ type: 'text', text: 'First message.', itemId: 'item_a' });
    fake.push({ type: 'text', text: ' Continued.', itemId: 'item_a' });
    fake.push({ type: 'text', text: 'Second message.', itemId: 'item_b' });
    // 0.142.x sends no item id — the break-on-change must never fire on absence.
    fake.push({ type: 'text', text: ' trailing id-less delta' });
    fake.push({ type: 'turn_complete' });
    await h.session.done();
    expect(h.texts.join('')).toBe('First message. Continued.\n\nSecond message. trailing id-less delta');

    // normalizeNotification surfaces the id from either 0.144.x shape.
    expect(normalizeNotification('item/agentMessage/delta', { delta: 'x', itemId: 'i1' })).toEqual({
      type: 'text',
      text: 'x',
      itemId: 'i1',
    });
    expect(normalizeNotification('item/agentMessage/delta', { delta: 'x', item: { id: 'i2' } })).toEqual({
      type: 'text',
      text: 'x',
      itemId: 'i2',
    });
    expect(normalizeNotification('thread/agentMessageDelta', { delta: 'x' })).toEqual({
      type: 'text',
      text: 'x',
    });
  });

  it('maps an error event to a failed outcome', async () => {
    const h = harness();
    h.getFake().push({ type: 'error', message: 'sandbox denied write' });
    const exit = await h.session.done();
    expect(exit).toMatchObject({ outcome: 'failed', reason: 'sandbox denied write' });
  });

  it('pushInput steers the active turn', async () => {
    const h = harness();
    const fake = h.getFake();
    h.session.pushInput('also fix the tests');
    expect(fake.steers).toEqual(['also fix the tests']);
    fake.push({ type: 'turn_complete' });
    await h.session.done();
  });

  it('interrupt() interrupts the transport', async () => {
    const h = harness();
    const fake = h.getFake();
    await h.session.interrupt();
    expect(fake.interrupted).toBe(1);
    fake.push({ type: 'turn_complete' });
    await h.session.done();
  });

  it('stop() ends the run as failed(stopped)', async () => {
    const h = harness();
    await h.session.stop();
    expect(await h.session.done()).toMatchObject({ outcome: 'failed', reason: 'stopped' });
  });

  it('sets cumulative usage (not accumulated) from repeated usage events', async () => {
    const h = harness();
    const fake = h.getFake();
    fake.push({ type: 'usage', inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 });
    fake.push({ type: 'usage', inputTokens: 25, outputTokens: 9, cacheReadTokens: 3 }); // cumulative, replaces
    await tick();
    expect(h.telemetry.at(-1)).toMatchObject({ inputTokens: 25, outputTokens: 9, cacheReadTokens: 3 });
    fake.push({ type: 'turn_complete' });
    await h.session.done();
  });

  it('a stream that ends without completing a turn fails', async () => {
    const h = harness();
    h.getFake().events.close();
    expect(await h.session.done()).toMatchObject({
      outcome: 'failed',
      reason: 'codex stream ended without completing a turn',
    });
  });
});

/** A stand-in for the spawned `codex app-server` child: real streams (createInterface
 *  needs one), a recording stdin, and hand-fired lifecycle events. */
function makeFakeChild(writes: string[]) {
  const stdout = new PassThrough();
  const handlers = new Map<string, (a: unknown) => void>();
  return {
    pid: 4242,
    stdout,
    stderr: new PassThrough(),
    stdin: {
      write: (chunk: string) => {
        writes.push(chunk.trim());
        return true;
      },
      end: () => {},
    },
    on(event: string, cb: (a: unknown) => void) {
      handlers.set(event, cb);
      return this;
    },
    kill: () => true,
    emitLine(line: string) {
      stdout.write(`${line}\n`);
    },
    emitError(err: Error) {
      handlers.get('error')?.(err);
    },
  };
}

describe('defaultSpawnCodex protocol handshake (regressions)', () => {
  // These cover the REAL transport, which every other codex test replaces with a fake —
  // which is exactly why both bugs below shipped.
  it('buffers the first turn until thread/start answers, instead of sending threadId: null', async () => {
    const { defaultSpawnCodex } = await import('../src/drivers/codex');
    const writes: string[] = [];
    const fakeChild = makeFakeChild(writes);
    const t = defaultSpawnCodex(
      { cwd: '/wt', sandbox: 'workspace-write', approvalPolicy: 'never', kind: 'build' },
      () => fakeChild as never,
    );

    // The driver calls this immediately, before any stdout has been read.
    t.sendUserTurn('do the work');
    const beforeThread = writes.filter((w) => w.includes('turn/start'));
    expect(beforeThread).toEqual([]); // must NOT have posted a null-threadId turn

    // thread/start's response finally arrives.
    fakeChild.emitLine(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { threadId: 'th_1' } }));
    await new Promise((r) => setImmediate(r));

    const turn = writes.find((w) => w.includes('turn/start'));
    expect(turn).toBeTruthy();
    expect(JSON.parse(turn as string).params.threadId).toBe('th_1'); // the real id
  });

  it('sends a VERSIONED clientInfo — codex 0.144.x rejects initialize without one (RUN-72)', async () => {
    const { defaultSpawnCodex } = await import('../src/drivers/codex');
    const { VERSION } = await import('../src/version');
    const writes: string[] = [];
    defaultSpawnCodex(
      { cwd: '/wt', sandbox: 'read-only', approvalPolicy: 'never', kind: 'verify' },
      () => makeFakeChild(writes) as never,
    );
    const init = JSON.parse(writes.find((w) => w.includes('"initialize"')) as string);
    expect(init.params.clientInfo.version).toBe(VERSION);
    expect(init.params.clientInfo.name).toBe('noriq-runner');
  });

  it('a JSON-RPC error RESPONSE fails the run instead of hanging it forever (RUN-72)', async () => {
    // The live failure: 0.144.5 rejected our initialize, thread/start then answered "Not
    // initialized" — and both rejections vanished, because an error response has neither
    // `result` nor `method`. threadId stayed null, the buffered turn never flushed, and the
    // reviewer sat at zero CPU for fifteen minutes while its run hung in `verifying`.
    const { defaultSpawnCodex } = await import('../src/drivers/codex');
    const fakeChild = makeFakeChild([]);
    const t = defaultSpawnCodex(
      { cwd: '/wt', sandbox: 'read-only', approvalPolicy: 'never', kind: 'verify' },
      () => fakeChild as never,
    );
    t.sendUserTurn('review the diff');
    fakeChild.emitLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32600, message: 'Invalid request: missing field `version`' },
      }),
    );
    for await (const ev of t.events) {
      expect(ev).toEqual({
        type: 'error',
        message: 'codex rejected a request: Invalid request: missing field `version`',
      });
      break;
    }
  });

  it('captures the 0.144.x thread/start shape ({thread:{id}}) and flushes the buffered turn (RUN-72)', async () => {
    const { defaultSpawnCodex } = await import('../src/drivers/codex');
    const writes: string[] = [];
    const fakeChild = makeFakeChild(writes);
    const t = defaultSpawnCodex(
      { cwd: '/wt', sandbox: 'workspace-write', approvalPolicy: 'never', kind: 'build' },
      () => fakeChild as never,
    );
    t.sendUserTurn('do the work');
    fakeChild.emitLine(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { thread: { id: 'th_144' } } }));
    await new Promise((r) => setImmediate(r));
    const turn = writes.find((w) => w.includes('turn/start'));
    expect(turn).toBeTruthy();
    expect(JSON.parse(turn as string).params.threadId).toBe('th_144');
  });

  it('a rejected STEER is a shrug, not a verdict — the run keeps going (RUN-72)', async () => {
    // Steering has its own fallback (the notices channel re-delivers), so a steer the
    // app-server refuses must not fail the whole run the way a rejected handshake does.
    const { defaultSpawnCodex } = await import('../src/drivers/codex');
    const writes: string[] = [];
    const fakeChild = makeFakeChild(writes);
    const t = defaultSpawnCodex(
      { cwd: '/wt', sandbox: 'workspace-write', approvalPolicy: 'never', kind: 'build' },
      () => fakeChild as never,
    );
    fakeChild.emitLine(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { thread: { id: 'th_1' } } }));
    await new Promise((r) => setImmediate(r));
    expect(t.steer('also do X')).toBe(true);
    const steerId = JSON.parse(writes.find((w) => w.includes('turn/steer')) as string).id;
    fakeChild.emitLine(JSON.stringify({ jsonrpc: '2.0', id: steerId, error: { message: 'no active turn' } }));
    fakeChild.emitLine(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: {} }));
    for await (const ev of t.events) {
      expect(ev).toEqual({ type: 'turn_complete' }); // the steer rejection produced no event
      break;
    }
  });

  it('turns a missing codex binary into a run failure, not a daemon crash', async () => {
    const { defaultSpawnCodex } = await import('../src/drivers/codex');
    const fakeChild = makeFakeChild([]);
    const t = defaultSpawnCodex(
      { cwd: '/wt', sandbox: 'read-only', approvalPolicy: 'never', kind: 'verify' },
      () => fakeChild as never,
    );
    // spawn('codex') → ENOENT emits 'error'. With no listener Node rethrows it and the
    // WHOLE daemon dies, taking every concurrent Claude run with it.
    fakeChild.emitError(new Error('spawn codex ENOENT'));

    const seen: string[] = [];
    for await (const ev of t.events) if (ev.type === 'error') seen.push(ev.message);
    expect(seen[0]).toContain('ENOENT');
  });
});

describe('codex Noriq MCP wiring (RUN-43)', () => {
  // The bug this covers was invisible: the driver spawned codex with NO mcp config while the
  // prompt ordered it to register against a server it had no connection to. So every codex
  // agent was anonymous and un-attributable, and nothing errored. Every other codex test
  // swaps in a fake transport, which is exactly why it survived — so assert the real spawn.
  const spawnArgs = (
    noriqMcp?: { url: string; token: string },
    extra: { model?: string; effort?: RunEffort; kind?: RunKind } = {},
  ) => {
    let seen!: { cmd: string; args: string[]; opts: { env: NodeJS.ProcessEnv } };
    const spy = ((cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      seen = { cmd, args, opts };
      return makeFakeChild([]) as never;
    }) as never;
    defaultSpawnCodex(
      {
        cwd: '/wt',
        sandbox: 'workspace-write',
        approvalPolicy: 'never',
        kind: extra.kind ?? 'build',
        noriqMcp,
        ...extra,
      },
      spy,
    );
    return seen;
  };

  it('passes the MCP server as per-spawn -c overrides, never touching the user\u2019s config', () => {
    const { cmd, args } = spawnArgs({ url: 'https://noriq.example/mcp', token: 'plnrt_run_bound' });
    expect(cmd).toBe('codex');
    expect(args[0]).toBe('app-server');
    expect(args).toContain('mcp_servers.noriq.url=https://noriq.example/mcp');
    expect(args).toContain('mcp_servers.noriq.bearer_token_env_var=NORIQ_MCP_TOKEN');
    // `codex mcp add` writes into the human's own ~/.codex/config.toml — the daemon must not
    // reconfigure their codex behind their back, so the wiring stays per-spawn.
    expect(args.join(' ')).not.toContain('mcp add');
  });

  it('gives codex its bearer token in the env, because codex offers no header option', () => {
    const { opts } = spawnArgs({ url: 'https://noriq.example/mcp', token: 'plnrt_run_bound' });
    expect(opts.env.NORIQ_MCP_TOKEN).toBe('plnrt_run_bound');
    // Still the hardened env: the DAEMON's own token and git creds stay out regardless. The
    // token here is per-run and dies with the run, which is what makes this trade payable.
    expect(opts.env.NORIQ_TOKEN).toBeUndefined();
    expect(opts.env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('leaks no Noriq token into the env when there is no MCP to wire', () => {
    const { args, opts } = spawnArgs(undefined);
    expect(args).toEqual(['app-server']);
    expect(opts.env.NORIQ_MCP_TOKEN).toBeUndefined();
  });

  it('passes model + effort as per-spawn -c overrides too (RUN-33)', () => {
    const { args } = spawnArgs(undefined, { model: 'gpt-5.3-codex', effort: 'low' });
    expect(args).toContain('model=gpt-5.3-codex');
    expect(args).toContain('model_reasoning_effort=low');
    // Same reason as the MCP wiring above: writing these to ~/.codex/config.toml would
    // reconfigure the human's own codex behind their back.
    expect(args[0]).toBe('app-server');
  });

  it('says nothing when nobody chose — codex keeps its own default (RUN-33)', () => {
    // The pre-RUN-33 behaviour, and the assertion that keeps it: an unset run must not be
    // silently pinned to whatever we would have guessed.
    const { args } = spawnArgs(undefined, {});
    expect(args.join(' ')).not.toContain('model=');
    expect(args.join(' ')).not.toContain('model_reasoning_effort');
  });

  it('clamps an effort codex cannot do, rather than passing it through (RUN-33)', () => {
    // codex-cli 0.142.4 accepts ANY value for this key at parse time — a bogus one does not
    // fail the spawn. So passing 'xhigh' through would not error here; it would surface as an
    // API failure mid-run, after the tokens were spent.
    const { args } = spawnArgs(undefined, { effort: 'xhigh' });
    expect(args).toContain('model_reasoning_effort=high');
    expect(args.join(' ')).not.toContain('xhigh');
  });
});

describe('mapEffort: intent → codex\u2019s own scale (RUN-33)', () => {
  it('passes through what codex shares with the SDK', () => {
    expect(mapEffort('low')).toBe('low');
    expect(mapEffort('medium')).toBe('medium');
    expect(mapEffort('high')).toBe('high');
  });

  it('clamps the two levels above codex\u2019s ceiling', () => {
    // "Think as hard as you can" is the honest reading of xhigh/max on a backend whose top is
    // high — and it is what the Claude SDK itself does for a model that cannot go that far.
    expect(mapEffort('xhigh')).toBe('high');
    expect(mapEffort('max')).toBe('high');
  });
});

describe('the per-kind Noriq tool floor reaches codex (RUN-46)', () => {
  // Before this, noriqToolsFor lived in drivers/claude.ts and NOTHING else read it — the
  // per-kind floor was quietly a property of one driver. A codex VERIFY agent had every tool
  // the server advertises, claim_task included: the reviewer could move the work it judges.
  const spawnFor = (kind: RunKind) => {
    let seen!: { args: string[] };
    const spy = ((_cmd: string, args: string[]) => {
      seen = { args };
      return makeFakeChild([]) as never;
    }) as never;
    defaultSpawnCodex(
      {
        cwd: '/wt',
        sandbox: 'read-only',
        approvalPolicy: 'never',
        kind,
        noriqMcp: { url: 'https://noriq.example/mcp', token: 't' },
      },
      spy,
    );
    return seen.args;
  };

  const enabledTools = (args: string[]): string[] => {
    const arg = args.find((a) => a.startsWith('mcp_servers.noriq.enabled_tools='));
    expect(arg).toBeTruthy();
    return JSON.parse((arg as string).slice('mcp_servers.noriq.enabled_tools='.length));
  };

  it('mirrors the claude floor exactly, per kind — one policy, two enforcements', () => {
    for (const kind of ['scope', 'build', 'verify'] as const) {
      // noriqToolsFor is claude-prefixed; strip the prefix to compare the POLICY.
      const claudeFloor = noriqToolsFor(kind).map((t) => t.replace(/^mcp__noriq__/, ''));
      expect(enabledTools(spawnFor(kind)).sort()).toEqual([...claudeFloor].sort());
    }
  });

  it('a verify agent cannot claim, release, or update — the gate it exists to hold', () => {
    const tools = enabledTools(spawnFor('verify'));
    for (const denied of ['claim_task', 'release_task', 'update_task', 'create_plan']) {
      expect(tools).not.toContain(denied);
    }
    // But it CAN reach a human (RUN-32) — rationing that pushes agents toward guessing.
    expect(tools).toContain('raise_alert');
    expect(tools).toContain('request_input');
  });

  it('no MCP config → no enabled_tools either (nothing to filter)', () => {
    let seen!: { args: string[] };
    const spy = ((_cmd: string, args: string[]) => {
      seen = { args };
      return makeFakeChild([]) as never;
    }) as never;
    defaultSpawnCodex({ cwd: '/wt', sandbox: 'read-only', approvalPolicy: 'never', kind: 'scope' }, spy);
    expect(seen.args.some((a) => a.includes('enabled_tools'))).toBe(false);
  });
});
