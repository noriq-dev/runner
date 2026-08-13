import type {
  MissionAdoptionResult,
  MissionInventoryItem,
  MissionLeaseRef,
  MissionTaskAck,
  Run,
} from '@noriq-dev/shared';
import { describe, expect, it, vi } from 'vitest';
import type { WsHandlers } from '../src/ws-client';
import {
  BufferedWsHandlers,
  WsHandlerBufferOverflowError,
  type WsStartupHandlers,
} from '../src/ws-handler-buffer';

const RUN = {
  id: 'run_1',
  projectId: 'prj_1',
  runnerId: 'rnr_1',
  agentId: null,
  executionProfile: null,
  kind: 'build',
  anchor: null,
  brief: 'build it',
  repoRef: 'repo_1',
  agentTool: 'codex',
  budget: {},
  status: 'dispatched',
  exit: null,
  createdBy: 'usr_1',
  createdAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
} as Run;

const LEASE: MissionLeaseRef = {
  sitting: 1,
  executionId: 'sit_1',
  epoch: 2,
};
const GENERATION = 1;

const TASK_ACK: MissionTaskAck = {
  reportId: 'report_1',
  attemptId: 'attempt_1',
  phase: 'begin',
  accepted: true,
  taskId: 'task_1',
  claimId: 'claim_1',
  executionId: 'execution_1',
  taskStatus: 'in_progress',
  error: null,
};

const INVENTORY: MissionInventoryItem[] = [
  {
    runId: 'run_1',
    lease: LEASE,
    attempts: [],
  },
];

const ADOPTION_RESULTS: MissionAdoptionResult[] = [
  {
    runId: 'run_1',
    decision: 'adopt',
    lease: { ...LEASE, epoch: 3 },
    reason: null,
  },
];

function startupHandlers(): WsStartupHandlers {
  return {
    onRegistered: vi.fn(),
    onDisconnect: vi.fn(),
    onMissionTaskAck: vi.fn(),
    onMissionReconcileRequest: vi.fn(),
    onMissionReconcileResult: vi.fn(),
  };
}

function makeBuffer(overrides: Partial<{ maxBufferedFrames: number; maxBufferedBytes: number }> = {}) {
  const startup = startupHandlers();
  const onOverflow = vi.fn();
  const buffer = new BufferedWsHandlers({
    maxBufferedFrames: overrides.maxBufferedFrames ?? 16,
    maxBufferedBytes: overrides.maxBufferedBytes ?? 64 * 1024,
    startupHandlers: startup,
    onOverflow,
  });
  return { buffer, startup, onOverflow };
}

describe('BufferedWsHandlers', () => {
  it('drains ordinary frames once in exact FIFO order without coalescing cancellations', async () => {
    const { buffer } = makeBuffer();
    const calls: Array<{ name: string; args: unknown[] }> = [];
    const cancelOne = { runId: 'run_1', hard: false, reason: 'first' };
    const cancelTwo = { runId: 'run_1', hard: true, reason: 'second' };
    const handlers: WsHandlers = {
      onAssigned: (...args) => calls.push({ name: 'assigned', args }),
      onCancel: (...args) => calls.push({ name: 'cancel', args }),
      onReconnect: (...args) => calls.push({ name: 'reconnect', args }),
    };

    buffer.onAssigned(RUN, LEASE, GENERATION);
    buffer.onCancel(cancelOne, GENERATION);
    buffer.onCancel(cancelTwo, GENERATION);
    buffer.onReconnect(GENERATION);

    const activation = buffer.activate(handlers);
    expect(buffer.activate(handlers)).toBe(activation);
    await activation;

    expect(calls).toEqual([
      { name: 'assigned', args: [RUN, LEASE, GENERATION] },
      { name: 'cancel', args: [cancelOne, GENERATION] },
      { name: 'cancel', args: [cancelTwo, GENERATION] },
      { name: 'reconnect', args: [GENERATION] },
    ]);
    expect(buffer.bufferedFrames).toBe(0);
    expect(buffer.bufferedBytes).toBe(0);
  });

  it('routes startup control frames immediately and never invokes both startup and active handlers', async () => {
    const { buffer, startup } = makeBuffer();
    const registered = {
      runnerId: 'rnr_1',
      protocol: 2,
      acceptedCapabilities: ['mission.v2'],
    };
    const reconciliation = {
      deadline: '2026-08-13T00:00:30.000Z',
      items: INVENTORY,
    };

    buffer.onRegistered(registered, GENERATION);
    buffer.onDisconnect('socket closed', GENERATION);
    buffer.onMissionTaskAck(TASK_ACK, GENERATION);
    buffer.onMissionReconcileRequest(reconciliation, GENERATION);
    buffer.onMissionReconcileResult(ADOPTION_RESULTS, GENERATION);

    expect(startup.onRegistered).toHaveBeenCalledWith(registered, GENERATION);
    expect(startup.onDisconnect).toHaveBeenCalledWith('socket closed', GENERATION);
    expect(startup.onMissionTaskAck).toHaveBeenCalledWith(TASK_ACK, GENERATION);
    expect(startup.onMissionReconcileRequest).toHaveBeenCalledWith(reconciliation, GENERATION);
    expect(startup.onMissionReconcileResult).toHaveBeenCalledWith(ADOPTION_RESULTS, GENERATION);

    const activeRegistered = vi.fn();
    const activeDisconnect = vi.fn();
    const activeTaskAck = vi.fn();
    await buffer.activate({
      onRegistered: activeRegistered,
      onDisconnect: activeDisconnect,
      onMissionTaskAck: activeTaskAck,
    });
    buffer.onRegistered(registered, GENERATION);
    buffer.onDisconnect('liveness deadline', GENERATION);
    buffer.onMissionTaskAck(TASK_ACK, GENERATION);
    // Missing active reconciliation handlers intentionally fall back to the always-ready startup
    // handlers, but each frame still has exactly one recipient.
    buffer.onMissionReconcileRequest(reconciliation, GENERATION);

    expect(activeRegistered).toHaveBeenCalledTimes(1);
    expect(activeDisconnect).toHaveBeenCalledWith('liveness deadline', GENERATION);
    expect(activeTaskAck).toHaveBeenCalledTimes(1);
    expect(startup.onRegistered).toHaveBeenCalledTimes(1);
    expect(startup.onDisconnect).toHaveBeenCalledTimes(1);
    expect(startup.onMissionTaskAck).toHaveBeenCalledTimes(1);
    expect(startup.onMissionReconcileRequest).toHaveBeenCalledTimes(2);
  });

  it('adds frames arriving during an async drain to the same ordered FIFO', async () => {
    const { buffer, startup } = makeBuffer();
    const calls: string[] = [];
    let releaseAssigned!: () => void;
    const assignedGate = new Promise<void>((resolve) => {
      releaseAssigned = resolve;
    });
    const handlers: WsHandlers = {
      onAssigned: async () => {
        calls.push('assigned:start');
        await assignedGate;
        calls.push('assigned:end');
      },
      onCancel: (message) => calls.push(`cancel:${message.reason}`),
      onResume: (message) => calls.push(`resume:${message.signalId}`),
      onSteer: (message) => calls.push(`steer:${message.steerId}`),
    };

    buffer.onAssigned(RUN, LEASE, GENERATION);
    const activation = buffer.activate(handlers);
    await vi.waitFor(() => expect(calls).toEqual(['assigned:start']));

    buffer.onCancel({ runId: RUN.id, hard: false, reason: 'during-drain' }, GENERATION);
    buffer.onResume({
      runId: RUN.id,
      signalId: 'signal_1',
      question: null,
      answer: 'continue',
    });
    const reconciliation = {
      deadline: '2026-08-13T00:00:30.000Z',
      items: INVENTORY,
    };
    buffer.onMissionReconcileRequest(reconciliation, GENERATION);
    expect(startup.onMissionReconcileRequest).toHaveBeenCalledWith(reconciliation, GENERATION);
    releaseAssigned();
    await activation;

    expect(calls).toEqual(['assigned:start', 'assigned:end', 'cancel:during-drain', 'resume:signal_1']);

    buffer.onSteer({
      runId: RUN.id,
      steerId: 'steer_1',
      mode: 'soft',
      body: 'one more check',
      sourceCommentId: null,
      sourceMessageId: null,
      noticeCursor: null,
    });
    expect(calls.at(-1)).toBe('steer:steer_1');
  });

  it('fails closed on overflow and does not drain a partial queue', async () => {
    const { buffer, onOverflow } = makeBuffer({ maxBufferedFrames: 2 });
    const onAssigned = vi.fn();
    const first = { runId: RUN.id, hard: false, reason: 'one' };
    const second = { runId: RUN.id, hard: false, reason: 'two' };

    buffer.onAssigned(RUN, LEASE, GENERATION);
    buffer.onCancel(first, GENERATION);
    buffer.onCancel(second, GENERATION);

    expect(onOverflow).toHaveBeenCalledTimes(1);
    const error = onOverflow.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(WsHandlerBufferOverflowError);
    expect(error).toMatchObject({
      code: 'WS_HANDLER_BUFFER_OVERFLOW',
      maxBufferedFrames: 2,
      bufferedFrames: 2,
      incomingHandler: 'onCancel',
      maxBufferedBytes: 64 * 1024,
    });
    await expect(buffer.activate({ onAssigned })).rejects.toBe(error);
    expect(onAssigned).not.toHaveBeenCalled();
    expect(buffer.bufferedFrames).toBe(0);
    expect(buffer.bufferedBytes).toBe(0);
  });

  it('fails closed on aggregate bytes even below the frame limit', async () => {
    const first = { runId: RUN.id, hard: false, reason: 'one' };
    const bytes = Buffer.byteLength(
      JSON.stringify({ handler: 'onCancel', args: [first, GENERATION] }),
      'utf8',
    );
    const { buffer, onOverflow } = makeBuffer({ maxBufferedBytes: bytes });

    buffer.onCancel(first, GENERATION);
    expect(buffer.bufferedBytes).toBe(bytes);
    buffer.onCancel({ ...first, reason: 'two' }, GENERATION);

    expect(onOverflow).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'WS_HANDLER_BUFFER_OVERFLOW',
        maxBufferedBytes: bytes,
        bufferedBytes: bytes,
      }),
    );
    await expect(buffer.activate({})).rejects.toBeInstanceOf(WsHandlerBufferOverflowError);
    expect(buffer.bufferedBytes).toBe(0);
  });

  it('rejects replacement activation without replaying any callback', async () => {
    const { buffer } = makeBuffer();
    const first = vi.fn();
    const second = vi.fn();
    const handlers = { onAssigned: first };

    buffer.onAssigned(RUN, LEASE, GENERATION);
    await buffer.activate(handlers);
    await expect(buffer.activate({ onAssigned: second })).rejects.toThrow(/already been activated/);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });
});
