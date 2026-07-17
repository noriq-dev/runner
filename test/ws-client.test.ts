import { RunnerClientMessage } from '@noriq-dev/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WsClient,
  type WsClientOptions,
  type WsFactory,
  type WsIdentity,
  type WsSocket,
} from '../src/ws-client';

class FakeSocket implements WsSocket {
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}
  on(event: string, listener: (...a: unknown[]) => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.emit('close');
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }
  msgs(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s));
  }
}

const IDENTITY: WsIdentity = {
  label: 'laptop',
  tools: ['claude'],
  kinds: ['build'],
  maxConcurrency: 2,
  repos: [{ id: 'repo_a', projectKey: 'AAA', name: 'a', defaultBranch: 'main' }],
};

const RUN = {
  id: 'run_1',
  projectId: 'prj_a',
  runnerId: 'rnr_1',
  agentId: null,
  kind: 'build',
  anchor: null,
  brief: 'go',
  repoRef: 'repo_a',
  agentTool: 'claude',
  budget: {},
  status: 'dispatched',
  exit: null,
  createdBy: 'usr_1',
  createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
};

let sockets: FakeSocket[];
let factory: WsFactory;

function makeClient(over: Partial<WsClientOptions> = {}) {
  return new WsClient({
    server: 'https://noriq.example',
    runnerId: 'rnr_1',
    token: 'tok',
    identity: IDENTITY,
    freeSlots: () => 2,
    heartbeatMs: 1000,
    reconnectBaseMs: 1000,
    connect: factory,
    ...over,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  factory = (url, headers) => {
    const s = new FakeSocket(url, headers);
    sockets.push(s);
    return s;
  };
});
afterEach(() => vi.useRealTimers());

describe('WsClient', () => {
  it('connects to the wss runner url with a bearer header and sends hello', () => {
    const client = makeClient();
    client.start();
    const s = sockets[0]!;
    expect(s.url).toBe('wss://noriq.example/ws/runner/rnr_1');
    expect(s.headers.Authorization).toBe('Bearer tok');
    s.emit('open');
    const hello = s.msgs()[0]!;
    expect(hello.type).toBe('hello');
    expect(hello.runnerId).toBe('rnr_1');
    expect(hello.label).toBe('laptop');
    client.stop();
  });

  it('heartbeats free capacity on the interval', () => {
    let slots = 2;
    const client = makeClient({ freeSlots: () => slots });
    client.start();
    const s = sockets[0]!;
    s.emit('open');
    vi.advanceTimersByTime(1000);
    expect(s.msgs().at(-1)).toEqual({ type: 'heartbeat', freeSlots: 2 });
    slots = 0;
    vi.advanceTimersByTime(1000);
    expect(s.msgs().at(-1)).toEqual({ type: 'heartbeat', freeSlots: 0 });
    client.stop();
  });

  it('routes registered / run.assigned / run.cancel to handlers', () => {
    const onRegistered = vi.fn();
    const onAssigned = vi.fn();
    const onCancel = vi.fn();
    const client = makeClient({ handlers: { onRegistered, onAssigned, onCancel } });
    client.start();
    const s = sockets[0]!;
    s.emit('open');
    s.emit(
      'message',
      JSON.stringify({
        type: 'registered',
        runnerId: 'rnr_1',
        protocol: 1,
        serverTime: '2026-07-14T00:00:00.000Z',
      }),
    );
    s.emit('message', JSON.stringify({ type: 'run.assigned', run: RUN }));
    s.emit('message', JSON.stringify({ type: 'run.cancel', runId: 'run_1', hard: true, reason: 'stop' }));
    expect(onRegistered).toHaveBeenCalledWith({ runnerId: 'rnr_1', protocol: 1 });
    expect(onAssigned).toHaveBeenCalledWith(expect.objectContaining({ id: 'run_1', kind: 'build' }));
    expect(onCancel).toHaveBeenCalledWith({ runId: 'run_1', hard: true, reason: 'stop' });
    client.stop();
  });

  it('routes a steer to onSteer and acks it back', () => {
    const onSteer = vi.fn();
    const client = makeClient({ handlers: { onSteer } });
    client.start();
    const s = sockets[0]!;
    s.emit('open');
    s.emit(
      'message',
      JSON.stringify({
        type: 'steer',
        runId: 'run_1',
        steerId: 's1',
        mode: 'hard',
        body: 're-scope',
        sourceCommentId: 'cmt_1',
        sourceMessageId: null,
        noticeCursor: 42,
        issuedAt: '2026-07-14T00:00:00.000Z',
      }),
    );
    expect(onSteer).toHaveBeenCalledWith({
      runId: 'run_1',
      steerId: 's1',
      mode: 'hard',
      body: 're-scope',
      sourceCommentId: 'cmt_1',
      sourceMessageId: null,
      noticeCursor: 42,
    });
    client.sendSteerAck({ runId: 'run_1', steerId: 's1', delivered: true, via: 'runtime', noticeCursor: 42 });
    const ack = s.msgs().find((m) => m.type === 'steer.ack');
    expect(ack).toMatchObject({
      runId: 'run_1',
      steerId: 's1',
      delivered: true,
      via: 'runtime',
      noticeCursor: 42,
    });
    client.stop();
  });

  it('sends a run.telemetry frame with spend + a log tail, and never re-asserts it (RUN-22)', () => {
    const client = makeClient();
    client.start();
    const s0 = sockets[0]!;
    s0.emit('open');
    client.sendTelemetry('run_1', { tokensUsed: 4200, usdSpent: 0.19, logTail: 'compiling...' });
    const tel = s0.msgs().find((m) => m.type === 'run.telemetry');
    expect(tel).toMatchObject({ runId: 'run_1', tokensUsed: 4200, usdSpent: 0.19, logTail: 'compiling...' });
    expect(typeof tel!.at).toBe('string');
    // A tick that doesn't know the mix sends null, not a wiped field (RUN-59): the server COALESCEs.
    expect(tel!.modelUsage).toBeNull();

    // Telemetry is ephemeral: dropping + reconnecting must not re-assert it (only
    // live run.status is re-asserted). Otherwise stale spend would resurrect.
    s0.emit('close');
    vi.advanceTimersByTime(1000);
    const s1 = sockets[1]!;
    s1.emit('open');
    expect(s1.msgs().some((m) => m.type === 'run.telemetry')).toBe(false);
    client.stop();
  });

  it('ignores malformed and unknown-shape messages', () => {
    const onAssigned = vi.fn();
    const client = makeClient({ handlers: { onAssigned } });
    client.start();
    const s = sockets[0]!;
    s.emit('open');
    s.emit('message', 'not json');
    s.emit('message', JSON.stringify({ type: 'bogus' }));
    s.emit('message', JSON.stringify({ type: 'run.assigned', run: { id: 'x' } })); // invalid Run
    expect(onAssigned).not.toHaveBeenCalled();
    client.stop();
  });

  it('reconnects with backoff and re-asserts live runs on reconnect', () => {
    const onReconnect = vi.fn();
    const client = makeClient({ handlers: { onReconnect } });
    client.start();
    const s0 = sockets[0]!;
    s0.emit('open');
    client.sendRunStatus('run_1', 'running', { agentId: 'agt_1' });
    expect(s0.msgs().some((m) => m.type === 'run.status' && m.status === 'running')).toBe(true);

    s0.emit('close'); // socket dropped → reconnect scheduled at base 1000ms
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2); // reconnected
    const s1 = sockets[1]!;
    s1.emit('open');
    expect(onReconnect).toHaveBeenCalledOnce();
    const msgs = s1.msgs();
    expect(msgs[0]!.type).toBe('hello'); // re-hello first
    const reassert = msgs.find((m) => m.type === 'run.status' && m.runId === 'run_1');
    expect(reassert?.status).toBe('running'); // live run re-asserted
    client.stop();
  });

  it('does not re-assert a run that reached a terminal status', () => {
    const client = makeClient();
    client.start();
    const s0 = sockets[0]!;
    s0.emit('open');
    client.sendRunStatus('run_1', 'running');
    client.sendRunStatus('run_1', 'done', { exit: { outcome: 'done' } });
    s0.emit('close');
    vi.advanceTimersByTime(1000);
    const s1 = sockets[1]!;
    s1.emit('open');
    expect(s1.msgs().some((m) => m.type === 'run.status')).toBe(false); // nothing live to re-assert
    client.stop();
  });

  it('stop() closes the socket and prevents reconnect', () => {
    const client = makeClient();
    client.start();
    const s0 = sockets[0]!;
    s0.emit('open');
    client.stop();
    expect(s0.closed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1); // no reconnect after stop
  });
});

describe('every frame the daemon sends must satisfy the wire contract', () => {
  // The server does `safeParse(...); if (!parsed.success) return;` — it drops an
  // off-contract frame without a word. A terminal run.status that fails validation
  // therefore looks EXACTLY like a healthy daemon whose Runs never finish: the
  // dashboard strands the Run 'running' forever and a human has to hit kill.
  const framesFrom = (c: ReturnType<typeof makeClient>) => {
    c.start();
    const s = sockets[0]!;
    s.emit('open');
    return () => s.msgs();
  };

  it('accepts a terminal run.status carrying an exit (the regression)', () => {
    const c = makeClient();
    const frames = framesFrom(c);
    // Exactly what the supervisor reports on a gated build: outcome + reason, no clock.
    c.sendRunStatus('run_1', 'failed', { exit: { outcome: 'failed', reason: 'verify' } });

    const status = frames().find((f) => f.type === 'run.status')!;
    const parsed = RunnerClientMessage.safeParse(status);
    expect(parsed.success).toBe(true);
    // RunExit.finishedAt is required and has no default — the wire boundary stamps it.
    expect((status?.exit as Record<string, unknown>).finishedAt).toEqual(expect.any(String));
  });

  it('preserves a finishedAt the caller supplied', () => {
    const c = makeClient();
    const frames = framesFrom(c);
    c.sendRunStatus('run_1', 'done', {
      exit: { outcome: 'done', reason: null, finishedAt: '2026-07-14T00:00:00.000Z' },
    });
    const status = frames().find((f) => f.type === 'run.status')!;
    expect((status?.exit as Record<string, unknown>).finishedAt).toBe('2026-07-14T00:00:00.000Z');
  });

  it('validates hello, telemetry, run.status and steer.ack against the contract', () => {
    const c = makeClient();
    const frames = framesFrom(c);
    c.sendRunStatus('run_1', 'running', { worktreePath: '/wt/run_1' });
    c.sendRunStatus('run_1', 'done', { exit: { outcome: 'done', reason: null } });
    c.sendTelemetry('run_1', { tokensUsed: 10, usdSpent: 0.01, logTail: 'x' });
    c.sendSteerAck({ runId: 'run_1', steerId: 's1', delivered: true, via: 'runtime' });

    for (const f of frames()) {
      const parsed = RunnerClientMessage.safeParse(f);
      expect(parsed.success, `frame ${String(f.type)} violates the contract`).toBe(true);
    }
  });

  it('carries a real per-model mix on the telemetry frame, contract-valid (RUN-59)', () => {
    const c = makeClient();
    const frames = framesFrom(c);
    c.sendTelemetry('run_1', {
      tokensUsed: 633,
      usdSpent: 0.0762,
      modelUsage: {
        'claude-opus-4-8[1m]': {
          inputTokens: 4,
          outputTokens: 79,
          cacheReadInputTokens: 40554,
          cacheCreationInputTokens: 5332,
          costUSD: 0.075617,
        },
        'claude-haiku-4-5-20251001': {
          inputTokens: 536,
          outputTokens: 14,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.000581,
        },
      },
    });
    const tel = frames().find((f) => f.type === 'run.telemetry')!;
    const parsed = RunnerClientMessage.safeParse(tel);
    expect(parsed.success).toBe(true);
    expect(Object.keys(tel.modelUsage as Record<string, unknown>)).toContain('claude-opus-4-8[1m]');
  });
});
