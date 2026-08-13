import { MISSION_CAPABILITY, RUNNER_PROTOCOL_CAPABILITIES, RunnerClientMessage } from '@noriq-dev/shared';
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
  /** Optional, like the interface: a test that cares assigns one; the rest exercise the
   *  close() fallback (RUN-176). */
  terminate?: () => void;
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
  // The full report shape (RUN-195) — the hello advertises the same object registration sent.
  repos: [
    {
      id: 'repo_a',
      projectKey: 'AAA',
      board: null,
      name: 'a',
      defaultBranch: 'main',
      repositoryKey: null,
      workflows: [
        { name: 'build', base: 'build' },
        { name: 'scope', base: 'scope' },
        { name: 'verify', base: 'verify' },
      ],
    },
  ],
};

const RUN = {
  id: 'run_1',
  projectId: 'prj_a',
  runnerId: 'rnr_1',
  agentId: null,
  executionProfile: null,
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
const FIRST_GENERATION = 1;
const NEXT_GENERATION = 2;

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
    expect(hello.protocolCapabilities).toEqual(RUNNER_PROTOCOL_CAPABILITIES);
    expect(RunnerClientMessage.safeParse(hello).success).toBe(true);
    client.stop();
  });

  it('heartbeats free capacity on the interval, with a liveness ping alongside (RUN-176)', () => {
    let slots = 2;
    const client = makeClient({ freeSlots: () => slots });
    client.start();
    const s = sockets[0]!;
    s.emit('open');
    vi.advanceTimersByTime(1000);
    expect(s.msgs().at(-2)).toEqual({ type: 'heartbeat', freeSlots: 2 });
    // The probe the liveness deadline depends on: the server answers ping with pong, so a healthy
    // idle connection hears something every beat. The heartbeat alone cannot serve — the server
    // records it and deliberately says nothing back.
    expect(s.msgs().at(-1)).toEqual({ type: 'ping' });
    slots = 0;
    vi.advanceTimersByTime(1000);
    expect(s.msgs().at(-2)).toEqual({ type: 'heartbeat', freeSlots: 0 });
    client.stop();
  });

  // RUN-170. The server is the admission authority and dispatches against the last freeSlots it
  // HEARD — so a capacity change that waits out the beat interval is a window it can dispatch
  // into (a wave grant claims several slots the previous beat still called free). The grant's
  // owner pushes the advertisement itself instead of waiting.
  it('advertiseCapacity pushes the current freeSlots at once — no beat, no ping (RUN-170)', () => {
    let slots = 3;
    const client = makeClient({ freeSlots: () => slots });
    client.start();
    const s = sockets[0]!;
    s.emit('open');
    const before = s.sent.length;
    slots = 0; // a wave grant just claimed the machine
    client.advertiseCapacity();
    // Exactly one frame, and no ping alongside: an advertisement, not a liveness probe.
    expect(s.msgs().slice(before)).toEqual([{ type: 'heartbeat', freeSlots: 0 }]);
    client.stop();
  });

  // RUN-176. The daemon survived suspend/resume as a live process on a dead socket: writes into a
  // half-open socket succeed into the kernel buffer, no FIN ever arrives, `close` never fires, and
  // the reconnect ladder — correct on every real close — was simply never entered. 14 hours
  // "online" with the server long gone.
  describe('the half-open socket is detected and torn down (RUN-176)', () => {
    it('terminates and reconnects after the silent-beat deadline', () => {
      const client = makeClient();
      client.start();
      const s = sockets[0]!;
      s.emit('open');
      // Teardown lands on the third consecutive silent tick — ~90s at the real 30s beat —
      // and not a beat sooner: a pong that is merely slow must not cost a healthy connection.
      vi.advanceTimersByTime(2000);
      expect(s.closed).toBe(false); // two silent beats: still within the deadline
      vi.advanceTimersByTime(1000);
      expect(s.closed).toBe(true); // torn down (fallback path: no terminate on the fake)
      // …and the ordinary ladder took over: a fresh socket was dialled.
      vi.advanceTimersByTime(1000); // reconnectBaseMs
      expect(sockets.length).toBe(2);
      client.stop();
    });

    it('reconnects even when terminate THROWS or close never emits — the transition is guaranteed', () => {
      // The re-created hang a review caught: a destroyed socket's terminate() throws, or a
      // transport's close() neither completes nor emits 'close' — either way the deadline must
      // still reach the reconnect ladder, or we are wedged exactly as before, one layer up.
      const client = makeClient({
        connect: (url, headers) => {
          const s = new FakeSocket(url, headers);
          s.terminate = () => {
            throw new Error('already destroyed');
          };
          s.close = () => {}; // and close never emits either
          sockets.push(s);
          return s;
        },
      });
      client.start();
      sockets[0]!.emit('open');
      vi.advanceTimersByTime(3000);
      vi.advanceTimersByTime(1000); // reconnectBaseMs
      expect(sockets.length).toBe(2); // reconnected regardless
      client.stop();
    });

    it('a token rejection landing AFTER stop() does not keep dialling', async () => {
      // The shutdown race: stop() lands while openAsync is awaiting the token provider, the
      // provider then rejects, and the catch used to reschedule — a shut-down daemon dialling and
      // warning forever. `stopped` is re-checked inside scheduleReconnect now.
      let rejectToken!: (e: Error) => void;
      const client = makeClient({
        token: () =>
          new Promise((_, rej) => {
            rejectToken = rej;
          }),
      });
      client.start();
      client.stop();
      rejectToken(new Error('refresh failed'));
      await Promise.resolve(); // let the catch run
      await Promise.resolve();
      vi.advanceTimersByTime(60_000);
      expect(sockets.length).toBe(0); // never dialled, never rescheduled
    });

    it('a dead socket’s LATE close cannot disturb its replacement', () => {
      // Handlers are socket-scoped: a terminated socket may still emit 'close' afterwards, and an
      // unscoped handler would stop the new socket's heartbeat and stack a second reconnect.
      const client = makeClient();
      client.start();
      const first = sockets[0]!;
      first.emit('open');
      vi.advanceTimersByTime(3000); // deadline → torn down, transition ran
      vi.advanceTimersByTime(1000); // reconnect dialled
      expect(sockets.length).toBe(2);
      const second = sockets[1]!;
      second.emit('open');
      first.emit('close'); // the echo from the dead socket's actual close
      vi.advanceTimersByTime(1000);
      // The new socket's heartbeat is still running (it sent this beat) and no third dial happened.
      expect(second.msgs().some((m) => m.type === 'heartbeat')).toBe(true);
      expect(sockets.length).toBe(2);
      client.stop();
    });

    it('prefers terminate() over close() — a half-open socket never completes the handshake', () => {
      let terminated = 0;
      const client = makeClient({
        connect: (url, headers) => {
          const s = new FakeSocket(url, headers);
          s.terminate = () => {
            terminated += 1;
            s.close(); // ws's terminate destroys and emits close; the fake models that
          };
          sockets.push(s);
          return s;
        },
      });
      client.start();
      sockets[0]!.emit('open');
      vi.advanceTimersByTime(4000);
      expect(terminated).toBe(1);
      client.stop();
    });

    it('any inbound frame is proof of life — pongs reset the deadline', () => {
      const client = makeClient();
      client.start();
      const s = sockets[0]!;
      s.emit('open');
      // Healthy idle connection: the server answers each beat's ping.
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(1000);
        s.emit('message', JSON.stringify({ type: 'pong' }));
      }
      expect(s.closed).toBe(false);
      expect(sockets.length).toBe(1); // never reconnected
      client.stop();
    });

    it('run traffic counts as life even when pongs go missing', () => {
      // Requiring the pong specifically would tear down a healthy connection that is busy — a
      // frame is a frame, whatever its type, and liveness is a transport question.
      const client = makeClient();
      client.start();
      const s = sockets[0]!;
      s.emit('open');
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(1000);
        s.emit('message', JSON.stringify({ type: 'run.assigned', run: RUN }));
      }
      expect(s.closed).toBe(false);
      expect(sockets.length).toBe(1);
      client.stop();
    });
  });

  it('routes registered / run.assigned / run.cancel to handlers', () => {
    const onRegistered = vi.fn();
    const onAssigned = vi.fn();
    const onCancel = vi.fn();
    const client = makeClient({
      handlers: { onRegistered, onAssigned, onCancel },
    });
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
        acceptedCapabilities: ['orchestration.v1'],
      }),
    );
    s.emit('message', JSON.stringify({ type: 'run.assigned', run: RUN }));
    s.emit(
      'message',
      JSON.stringify({
        type: 'run.cancel',
        runId: 'run_1',
        hard: true,
        reason: 'stop',
      }),
    );
    expect(onRegistered).toHaveBeenCalledWith(
      {
        runnerId: 'rnr_1',
        protocol: 1,
        acceptedCapabilities: ['orchestration.v1'],
      },
      FIRST_GENERATION,
    );
    expect(onAssigned).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run_1', kind: 'build' }),
      null,
      FIRST_GENERATION,
    );
    expect(onCancel).toHaveBeenCalledWith(
      {
        runId: 'run_1',
        hard: true,
        reason: 'stop',
      },
      FIRST_GENERATION,
    );
    expect(client.hasAcceptedCapability('orchestration.v1')).toBe(true);
    expect(client.hasAcceptedCapability('mission.v2')).toBe(false);
    client.stop();
  });

  it('clears negotiated capabilities when the owning socket closes', () => {
    const client = makeClient();
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
        acceptedCapabilities: ['mission.v2'],
      }),
    );
    expect(client.hasAcceptedCapability('mission.v2')).toBe(true);
    s.emit('close');
    expect(client.hasAcceptedCapability('mission.v2')).toBe(false);
    client.stop();
  });

  it('routes mission leases, task acknowledgements, and reconciliation frames', () => {
    const onAssigned = vi.fn();
    const onMissionTaskAck = vi.fn();
    const onMissionReconcileRequest = vi.fn();
    const onMissionReconcileResult = vi.fn();
    const client = makeClient({
      handlers: {
        onAssigned,
        onMissionTaskAck,
        onMissionReconcileRequest,
        onMissionReconcileResult,
      },
    });
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
        acceptedCapabilities: [MISSION_CAPABILITY],
      }),
    );
    const lease = { sitting: 2, executionId: 'exe_root', epoch: 3 };
    s.emit('message', JSON.stringify({ type: 'run.assigned', run: RUN, missionLease: lease }));
    s.emit(
      'message',
      JSON.stringify({
        type: 'mission.task.ack',
        ack: {
          reportId: 'begin:1',
          attemptId: 'attempt:1',
          phase: 'begin',
          accepted: true,
          taskId: 'task_1',
          claimId: 'claim_1',
          executionId: 'exe_child',
          taskStatus: 'in_progress',
          error: null,
        },
      }),
    );
    const inventory = [{ runId: 'run_1', lease, attempts: [] }];
    s.emit(
      'message',
      JSON.stringify({
        type: 'mission.reconcile.request',
        deadline: '2026-07-14T00:00:30.000Z',
        items: inventory,
      }),
    );
    s.emit(
      'message',
      JSON.stringify({
        type: 'mission.reconcile.result',
        results: [{ runId: 'run_1', decision: 'adopt', lease, reason: null }],
      }),
    );

    expect(onAssigned).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run_1' }),
      lease,
      FIRST_GENERATION,
    );
    expect(onMissionTaskAck).toHaveBeenCalledWith(
      expect.objectContaining({ reportId: 'begin:1', accepted: true }),
      FIRST_GENERATION,
    );
    expect(onMissionReconcileRequest).toHaveBeenCalledWith(
      {
        deadline: '2026-07-14T00:00:30.000Z',
        items: inventory,
      },
      FIRST_GENERATION,
    );
    expect(onMissionReconcileResult).toHaveBeenCalledWith(
      [expect.objectContaining({ runId: 'run_1', decision: 'adopt', lease })],
      FIRST_GENERATION,
    );
    client.stop();
  });

  it('refuses outbound mission frames until mission.v2 is accepted on the current socket', () => {
    const client = makeClient();
    const lease = { sitting: 2, executionId: 'exe_root', epoch: 3 };
    const begin = {
      reportId: 'begin:1',
      attemptId: 'attempt:1',
      taskId: 'task_1',
      childKey: 'step_1',
      observedAt: '2026-07-14T00:00:00.000Z',
    };
    const settle = {
      reportId: 'settle:1',
      attemptId: 'attempt:1',
      claimId: 'claim_1',
      outcome: 'done' as const,
      reason: null,
      observedAt: '2026-07-14T00:00:01.000Z',
    };
    client.start();
    const first = sockets[0]!;
    first.emit('open');

    expect(client.sendMissionTaskBegin('run_1', lease, begin, FIRST_GENERATION)).toBe(false);
    first.emit(
      'message',
      JSON.stringify({
        type: 'registered',
        runnerId: 'rnr_1',
        protocol: 1,
        serverTime: '2026-07-14T00:00:00.000Z',
        acceptedCapabilities: ['orchestration.v1'],
      }),
    );
    expect(client.sendMissionTaskSettle('run_1', lease, settle, FIRST_GENERATION)).toBe(false);
    expect(
      client.sendMissionReconciliation([{ runId: 'run_1', lease, attempts: [] }], FIRST_GENERATION),
    ).toBe(false);
    expect(first.msgs().filter((message) => String(message.type).startsWith('mission.'))).toEqual([]);

    first.emit(
      'message',
      JSON.stringify({
        type: 'registered',
        runnerId: 'rnr_1',
        protocol: 1,
        serverTime: '2026-07-14T00:00:01.000Z',
        acceptedCapabilities: [MISSION_CAPABILITY],
      }),
    );
    expect(client.sendMissionTaskBegin('run_1', lease, begin, FIRST_GENERATION)).toBe(true);
    expect(client.sendMissionTaskSettle('run_1', lease, settle, FIRST_GENERATION)).toBe(true);
    expect(
      client.sendMissionReconciliation([{ runId: 'run_1', lease, attempts: [] }], FIRST_GENERATION),
    ).toBe(true);

    first.emit('close');
    vi.advanceTimersByTime(1000);
    const second = sockets[1]!;
    second.emit('open');
    expect(client.sendMissionTaskBegin('run_1', lease, begin, FIRST_GENERATION)).toBe(false);
    expect(second.msgs().filter((message) => String(message.type).startsWith('mission.'))).toEqual([]);
    second.emit(
      'message',
      JSON.stringify({
        type: 'registered',
        runnerId: 'rnr_1',
        protocol: 1,
        serverTime: '2026-07-14T00:00:02.000Z',
        acceptedCapabilities: [MISSION_CAPABILITY],
      }),
    );
    expect(client.sendMissionTaskBegin('run_1', lease, begin, FIRST_GENERATION)).toBe(false);
    expect(client.sendMissionTaskBegin('run_1', lease, begin, NEXT_GENERATION)).toBe(true);
    client.stop();
  });

  it.each([
    ['before registration', null],
    ['when registration omitted mission.v2', ['orchestration.v1']],
  ] as const)(
    'rejects every inbound mission frame %s and restarts that connection generation',
    (_case, acceptedCapabilities) => {
      const frames = [
        {
          type: 'mission.task.ack',
          ack: {
            reportId: 'begin:1',
            attemptId: 'attempt:1',
            phase: 'begin',
            accepted: true,
            taskId: 'task_1',
            claimId: 'claim_1',
            executionId: 'exe_child',
            taskStatus: 'in_progress',
            error: null,
          },
        },
        {
          type: 'mission.reconcile.request',
          deadline: '2026-07-14T00:00:30.000Z',
          items: [],
        },
        { type: 'mission.reconcile.result', results: [] },
      ];

      for (const frame of frames) {
        const onMissionTaskAck = vi.fn();
        const onMissionReconcileRequest = vi.fn();
        const onMissionReconcileResult = vi.fn();
        const client = makeClient({
          handlers: {
            onMissionTaskAck,
            onMissionReconcileRequest,
            onMissionReconcileResult,
          },
        });
        client.start();
        const socket = sockets.at(-1)!;
        socket.emit('open');
        if (acceptedCapabilities) {
          socket.emit(
            'message',
            JSON.stringify({
              type: 'registered',
              runnerId: 'rnr_1',
              protocol: 1,
              serverTime: '2026-07-14T00:00:00.000Z',
              acceptedCapabilities,
            }),
          );
        }

        socket.emit('message', JSON.stringify(frame));

        expect(onMissionTaskAck).not.toHaveBeenCalled();
        expect(onMissionReconcileRequest).not.toHaveBeenCalled();
        expect(onMissionReconcileResult).not.toHaveBeenCalled();
        expect(socket.closed).toBe(true);
        client.stop();
      }
    },
  );

  it('rejects a leased assignment without mission.v2 and abandons that socket generation', () => {
    const onAssigned = vi.fn();
    const onDisconnect = vi.fn();
    const client = makeClient({ handlers: { onAssigned, onDisconnect } });
    client.start();
    const socket = sockets[0]!;
    socket.emit('open');
    socket.emit(
      'message',
      JSON.stringify({
        type: 'registered',
        runnerId: 'rnr_1',
        protocol: 1,
        serverTime: '2026-07-14T00:00:00.000Z',
        acceptedCapabilities: ['orchestration.v1'],
      }),
    );

    socket.emit(
      'message',
      JSON.stringify({
        type: 'run.assigned',
        run: RUN,
        missionLease: { sitting: 2, executionId: 'exe_root', epoch: 3 },
      }),
    );

    expect(onAssigned).not.toHaveBeenCalled();
    expect(onDisconnect).toHaveBeenCalledWith(
      'received run.assigned without accepted mission.v2',
      FIRST_GENERATION,
    );
    expect(socket.closed).toBe(true);
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
    client.sendSteerAck({
      runId: 'run_1',
      steerId: 's1',
      delivered: true,
      via: 'runtime',
      noticeCursor: 42,
    });
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
    client.sendTelemetry('run_1', {
      tokensUsed: 4200,
      usdSpent: 0.19,
      logTail: 'compiling...',
    });
    const tel = s0.msgs().find((m) => m.type === 'run.telemetry');
    expect(tel).toMatchObject({
      runId: 'run_1',
      tokensUsed: 4200,
      usdSpent: 0.19,
      logTail: 'compiling...',
    });
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
    expect(onReconnect).toHaveBeenCalledWith(NEXT_GENERATION);
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

  it('does not re-assert a gated run because gated is terminal', () => {
    const client = makeClient();
    client.start();
    const s0 = sockets[0]!;
    s0.emit('open');
    client.sendRunStatus('run_1', 'running');
    client.sendRunStatus('run_1', 'gated', { exit: { outcome: 'gated' } });
    s0.emit('close');
    vi.advanceTimersByTime(1000);
    const s1 = sockets[1]!;
    s1.emit('open');
    expect(s1.msgs().some((message) => message.type === 'run.status')).toBe(false);
    client.stop();
  });

  it('never re-asserts a leased mission status before adoption', () => {
    const client = makeClient();
    client.start();
    const s0 = sockets[0]!;
    s0.emit('open');
    const lease = { sitting: 1, executionId: 'exe_root', epoch: 1 };
    expect(
      client.sendRunStatus('run_1', 'running', {
        missionLease: lease,
        connectionGeneration: FIRST_GENERATION,
      }),
    ).toBe(false);
    expect(client.sendTelemetry('run_1', { tokensUsed: 1, missionLease: lease })).toBe(false);
    s0.emit(
      'message',
      JSON.stringify({
        type: 'registered',
        runnerId: 'rnr_1',
        protocol: 1,
        serverTime: '2026-07-14T00:00:00.000Z',
        acceptedCapabilities: [MISSION_CAPABILITY],
      }),
    );
    expect(
      client.sendRunStatus('run_1', 'running', {
        missionLease: lease,
        connectionGeneration: FIRST_GENERATION,
      }),
    ).toBe(true);
    s0.emit('close');
    vi.advanceTimersByTime(1000);
    const s1 = sockets[1]!;
    s1.emit('open');
    expect(s1.msgs().some((message) => message.type === 'run.status')).toBe(false);
    client.stop();
  });

  // RUN-195/mission.v2. Registration provides the initial current snapshot; later filesystem and
  // attestation refreshes must update it without delaying the control socket or adoption window.
  describe('repo reports are refreshed behind the live control channel', () => {
    const flush = async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    };
    const reportWith = (workflows: WsIdentity['repos'][number]['workflows']) => [
      {
        id: 'repo_a',
        projectKey: 'AAA',
        board: null,
        name: 'a',
        defaultBranch: 'main',
        repositoryKey: null,
        workflows,
      },
    ];

    it('the initial hello is immediate, then a successful refresh publishes the new snapshot', async () => {
      const fresh = reportWith([
        { name: 'build', base: 'build' },
        { name: 'docs', base: 'scope', description: 'survey the repo' },
        { name: 'scope', base: 'scope' },
        { name: 'verify', base: 'verify' },
      ]);
      const client = makeClient({ refreshRepos: async () => fresh });
      client.start();
      const s = sockets[0]!;
      s.emit('open');
      const hello = s.msgs()[0]!;
      expect(hello.type).toBe('hello');
      expect(hello.repos).toEqual(IDENTITY.repos);
      // The object workflow entries must satisfy the refreshed vendored contract — an off-contract
      // hello is dropped server-side without a word back.
      expect(RunnerClientMessage.safeParse(hello).success).toBe(true);
      await flush();
      expect(s.msgs().find((message) => message.type === 'heartbeat' && message.repos)?.repos).toEqual(fresh);
      client.stop();
    });

    it('a reconnect re-resolves — a changed catalog is advertised without a restart', async () => {
      let calls = 0;
      const client = makeClient({
        refreshRepos: async () => {
          calls += 1;
          return reportWith([{ name: 'docs', base: 'scope', description: `v${calls}` }]);
        },
      });
      client.start();
      const s0 = sockets[0]!;
      s0.emit('open');
      await flush();
      expect(calls).toBe(1);

      s0.emit('close'); // the files changed while the socket was down
      vi.advanceTimersByTime(1000);
      expect(sockets).toHaveLength(2);
      const s1 = sockets[1]!;
      s1.emit('open');
      // The reconnect hello carries the last successful snapshot without waiting for the next
      // observation; the immediate follow-up publishes v2 once it resolves.
      expect((s1.msgs()[0]!.repos as Array<{ workflows: unknown }>)[0]!.workflows).toEqual([
        { name: 'docs', base: 'scope', description: 'v1' },
      ]);
      await flush();
      expect(calls).toBe(2);
      const refreshed = s1.msgs().find((message) => message.type === 'heartbeat' && message.repos);
      expect((refreshed!.repos as Array<{ workflows: unknown }>)[0]!.workflows).toEqual([
        { name: 'docs', base: 'scope', description: 'v2' },
      ]);
      client.stop();
    });

    it('a failed refresh advertises the last good set and still connects — never gates', async () => {
      let fail = false;
      const fresh = reportWith([{ name: 'docs', base: 'scope' }]);
      const client = makeClient({
        refreshRepos: async () => {
          if (fail) throw new Error('EACCES: ~/.noriq/workflows');
          return fresh;
        },
      });
      client.start();
      sockets[0]!.emit('open');
      await flush();
      expect(
        sockets[0]!.msgs().find((message) => message.type === 'heartbeat' && message.repos)?.repos,
      ).toEqual(fresh);

      fail = true;
      sockets[0]!.emit('close');
      vi.advanceTimersByTime(1000);
      expect(sockets).toHaveLength(2); // the broken refresh did not keep the daemon offline
      sockets[1]!.emit('open');
      const hello = sockets[1]!.msgs()[0]!;
      expect(hello.type).toBe('hello');
      expect(hello.repos).toEqual(fresh); // the last good set, not [] and not a crash
      await flush();
      client.stop();
    });

    it('without a provider the hello advertises the identity snapshot, synchronously', () => {
      // The pre-RUN-195 shape must hold byte-for-byte: no provider, no await before the dial.
      const client = makeClient();
      client.start();
      const s = sockets[0]!; // available immediately — the sync path did not gain an await
      s.emit('open');
      expect(s.msgs()[0]!.repos).toEqual(IDENTITY.repos);
      client.stop();
    });

    it('stop() landing during a pending refresh never publishes the late result', async () => {
      let resolveRepos!: (r: WsIdentity['repos']) => void;
      const client = makeClient({
        refreshRepos: () =>
          new Promise((res) => {
            resolveRepos = res;
          }),
      });
      client.start();
      expect(sockets).toHaveLength(1);
      sockets[0]!.emit('open');
      client.stop();
      resolveRepos([]);
      await flush();
      vi.advanceTimersByTime(60_000);
      expect(sockets).toHaveLength(1);
      expect(
        sockets[0]!.msgs().some((message) => message.repos !== undefined && message.type === 'heartbeat'),
      ).toBe(false);
    });

    it('re-attests repo/profile offers on heartbeats without overlapping refreshes', async () => {
      let calls = 0;
      let resolveHeartbeat!: (reports: WsIdentity['repos']) => void;
      const fresh = reportWith([{ name: 'build', base: 'build' }]);
      const client = makeClient({
        refreshRepos: async () => {
          calls += 1;
          if (calls === 1)
            return new Promise((resolve) => {
              resolveHeartbeat = resolve;
            });
          return new Promise((resolve) => {
            resolveHeartbeat = resolve;
          });
        },
      });
      client.start();
      const s = sockets[0]!;
      s.emit('open');
      expect(calls).toBe(1);
      s.emit('message', JSON.stringify({ type: 'pong' }));
      vi.advanceTimersByTime(1000);
      expect(calls).toBe(1); // the still-pending attestation was not duplicated

      resolveHeartbeat(fresh);
      await flush();
      expect(s.msgs().some((message) => message.type === 'heartbeat' && message.repos !== undefined)).toBe(
        true,
      );
      client.stop();
    });
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
    s.emit(
      'message',
      JSON.stringify({
        type: 'registered',
        runnerId: 'rnr_1',
        protocol: 1,
        serverTime: '2026-07-14T00:00:00.000Z',
        acceptedCapabilities: [MISSION_CAPABILITY],
      }),
    );
    return () => s.msgs();
  };

  it('accepts a terminal run.status carrying an exit (the regression)', () => {
    const c = makeClient();
    const frames = framesFrom(c);
    // Exactly what the supervisor reports on a gated build: outcome + reason, no clock.
    c.sendRunStatus('run_1', 'failed', {
      exit: { outcome: 'failed', reason: 'verify' },
    });

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
      exit: {
        outcome: 'done',
        reason: null,
        finishedAt: '2026-07-14T00:00:00.000Z',
      },
    });
    const status = frames().find((f) => f.type === 'run.status')!;
    expect((status?.exit as Record<string, unknown>).finishedAt).toBe('2026-07-14T00:00:00.000Z');
  });

  it('validates hello, telemetry, run.status and steer.ack against the contract', () => {
    const c = makeClient();
    const frames = framesFrom(c);
    c.sendRunStatus('run_1', 'running', { worktreePath: '/wt/run_1' });
    c.sendRunStatus('run_1', 'done', {
      exit: { outcome: 'done', reason: null },
    });
    c.sendTelemetry('run_1', { tokensUsed: 10, usdSpent: 0.01, logTail: 'x' });
    c.sendSteerAck({
      runId: 'run_1',
      steerId: 's1',
      delivered: true,
      via: 'runtime',
    });

    for (const f of frames()) {
      const parsed = RunnerClientMessage.safeParse(f);
      expect(parsed.success, `frame ${String(f.type)} violates the contract`).toBe(true);
    }
  });

  it('sends contract-valid mission lifecycle, task, and reconciliation frames with the exact lease', () => {
    const c = makeClient();
    const frames = framesFrom(c);
    const lease = { sitting: 1, executionId: 'exe_root', epoch: 4 };
    c.sendRunStatus('run_1', 'running', {
      missionLease: lease,
      connectionGeneration: FIRST_GENERATION,
    });
    c.sendTelemetry('run_1', {
      tokensUsed: 10,
      missionLease: lease,
      connectionGeneration: FIRST_GENERATION,
    });
    c.sendMissionTaskBegin(
      'run_1',
      lease,
      {
        reportId: 'begin:attempt_1',
        attemptId: 'attempt_1',
        taskId: 'task_1',
        childKey: 'step_1',
        observedAt: '2026-07-14T00:00:00.000Z',
      },
      FIRST_GENERATION,
    );
    c.sendMissionTaskSettle(
      'run_1',
      lease,
      {
        reportId: 'settle:attempt_1',
        attemptId: 'attempt_1',
        claimId: 'claim_1',
        outcome: 'done',
        reason: null,
        observedAt: '2026-07-14T00:00:01.000Z',
      },
      FIRST_GENERATION,
    );
    c.sendMissionReconciliation([{ runId: 'run_1', lease, attempts: [] }], FIRST_GENERATION);

    const missionFrames = frames().filter((frame) =>
      [
        'run.status',
        'run.telemetry',
        'mission.task.begin',
        'mission.task.settle',
        'mission.reconcile',
      ].includes(String(frame.type)),
    );
    expect(missionFrames).toHaveLength(5);
    for (const frame of missionFrames) {
      expect(RunnerClientMessage.safeParse(frame).success, String(frame.type)).toBe(true);
    }
    expect(missionFrames.find((frame) => frame.type === 'run.status')?.missionLease).toEqual(lease);
    expect(missionFrames.find((frame) => frame.type === 'run.telemetry')?.missionLease).toEqual(lease);
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
