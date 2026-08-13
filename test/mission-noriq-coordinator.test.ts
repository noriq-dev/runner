import { appendFile, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  CommissionedExecutionProfile,
  MissionLeaseRef,
  MissionTaskAck,
  MissionTaskBeginReport,
  MissionTaskSettleReport,
} from '@noriq-dev/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MissionHarnessStop } from '../src/mission/harness';
import { type MissionState, initialMissionState } from '../src/mission/model';
import {
  type NoriqMissionCommission,
  NoriqMissionCoordinator,
  type NoriqMissionCoordinatorTransport,
  type NoriqMissionRuntime,
  computeNoriqMissionCommissionDigest,
  validateNoriqMissionCommission,
} from '../src/mission/noriq-coordinator';
import {
  JsonlNoriqCoordinatorStore,
  NoriqCoordinatorConflictError,
  type NoriqMissionTaskSnapshot,
} from '../src/mission/noriq-coordinator-store';
import type { MissionBudget, MissionUsage } from '../src/mission/protocol';
import type { MissionCreateRequest } from '../src/mission/service';

const PROFILE: CommissionedExecutionProfile = Object.freeze({
  id: 'default',
  declarationFingerprint: 'declaration-v1',
  effectiveFingerprint: 'effective-v1',
  generation: 1,
  attestationCapable: true,
});
const LEASE: MissionLeaseRef = Object.freeze({ sitting: 2, executionId: 'exe-root', epoch: 3 });
const CATALOG_FINGERPRINT = 'a'.repeat(64);
const TOTAL_BUDGET: MissionBudget = Object.freeze({ tokens: 1_000, usd: null, activeSeconds: 100 });
const TASKS: readonly NoriqMissionTaskSnapshot[] = Object.freeze([
  Object.freeze({ taskId: 'task-a', childKey: 'child-a', brief: 'Build A.', dependencyIds: [] }),
  Object.freeze({
    taskId: 'task-b',
    childKey: 'child-b',
    brief: 'Build B.',
    dependencyIds: ['task-a'],
  }),
]);

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function stateDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noriq-coordinator-test-'));
  temporaryRoots.push(root);
  return root;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function commission(
  overrides: Partial<Omit<NoriqMissionCommission, 'commissionDigest'>> = {},
): NoriqMissionCommission {
  const body: Omit<NoriqMissionCommission, 'commissionDigest'> = {
    schemaVersion: 1,
    rootRunId: 'run-root',
    lease: LEASE,
    executionProfile: PROFILE,
    repositoryKey: 'repo-key',
    baseRevision: 'rev-base',
    serverCommissionDigest: 'b'.repeat(64),
    publishHandoff: false,
    tasks: TASKS,
    budget: TOTAL_BUDGET,
    catalogFingerprint: CATALOG_FINGERPRINT,
    resources: {},
    ...overrides,
  };
  return { ...body, commissionDigest: computeNoriqMissionCommissionDigest(body) };
}

function acceptedBegin(report: MissionTaskBeginReport): MissionTaskAck {
  return {
    reportId: report.reportId,
    attemptId: report.attemptId,
    phase: 'begin',
    accepted: true,
    taskId: report.taskId,
    claimId: `claim-${report.taskId}`,
    executionId: `execution-${report.taskId}`,
    taskStatus: 'in_progress',
    error: null,
  };
}

function acceptedSettle(
  report: MissionTaskSettleReport,
  taskId: string,
  executionId: string,
): MissionTaskAck {
  return {
    reportId: report.reportId,
    attemptId: report.attemptId,
    phase: 'settle',
    accepted: true,
    taskId,
    claimId: report.claimId,
    executionId,
    taskStatus: report.outcome === 'done' || report.outcome === 'gated' ? 'review' : 'todo',
    error: null,
  };
}

function terminalMissionState(
  request: MissionCreateRequest,
  outcome: 'succeeded' | 'failed' | 'cancelled',
  usage: MissionUsage,
  revisionId = `revision-${request.missionId}`,
): MissionState {
  const initial = initialMissionState(request.missionId);
  return {
    ...initial,
    status: outcome,
    objective: request.objective ? { ...request.objective } : null,
    budget: { ...request.budget },
    resources: { ...request.resources },
    completion: request.completion ? { ...request.completion } : initial.completion,
    usage,
    terminal: {
      outcome,
      reason: `${outcome} local mission`,
      checkpointId: outcome === 'succeeded' ? `checkpoint-${request.missionId}` : null,
    },
    acceptedRevisionHandoff:
      outcome === 'succeeded'
        ? {
            backend: 'git',
            repositoryKey: 'repo-key',
            checkpointId: `checkpoint-${request.missionId}`,
            revisionId,
            reference: `refs/noriq/${request.missionId}`,
            status: 'preserved',
          }
        : null,
  };
}

function questionStop(request: MissionCreateRequest, questionId = 'question-1'): MissionHarnessStop {
  const question = {
    questionId,
    prompt: 'Which safe option should I use?',
    answer: null,
    status: 'pending' as const,
  };
  const state: MissionState = {
    ...initialMissionState(request.missionId),
    status: 'active',
    objective: request.objective ? { ...request.objective } : null,
    budget: { ...request.budget },
    resources: { ...request.resources },
    completion: request.completion
      ? { ...request.completion }
      : initialMissionState(request.missionId).completion,
    usage: { tokens: 20, usd: null, activeSeconds: 2 },
    questions: { [questionId]: question },
    questionOrder: [questionId],
  };
  return { reason: 'human-question', state, guideTurns: 1, question };
}

interface FakeRuntimeOptions {
  control?: (missionId: string, request: MissionCreateRequest) => Promise<MissionHarnessStop>;
  answer?: (
    missionId: string,
    questionId: string,
    answer: string,
    request: MissionCreateRequest,
  ) => Promise<MissionHarnessStop>;
  cancel?: (missionId: string, reason: string, request: MissionCreateRequest) => Promise<MissionHarnessStop>;
  beforeCreate?: (request: MissionCreateRequest) => Promise<void>;
  quiesce?: (missionId: string, reason: string, request: MissionCreateRequest) => Promise<void>;
  resume?: (missionId: string, request: MissionCreateRequest) => void;
}

function fakeRuntime(options: FakeRuntimeOptions = {}): {
  runtime: NoriqMissionRuntime;
  creates: ReturnType<typeof vi.fn>;
  controls: ReturnType<typeof vi.fn>;
  answers: ReturnType<typeof vi.fn>;
  cancellations: ReturnType<typeof vi.fn>;
  quiesces: ReturnType<typeof vi.fn>;
  resumes: ReturnType<typeof vi.fn>;
  requests: Map<string, MissionCreateRequest>;
} {
  const requests = new Map<string, MissionCreateRequest>();
  const creates = vi.fn(async (request: MissionCreateRequest) => {
    await options.beforeCreate?.(request);
    requests.set(request.missionId, request);
    const initial = initialMissionState(request.missionId);
    return {
      accepted: true,
      replayed: requests.has(request.missionId),
      state: {
        ...initial,
        status: 'active' as const,
        objective: request.objective ? { ...request.objective } : null,
        budget: { ...request.budget },
        resources: { ...request.resources },
        completion: request.completion ? { ...request.completion } : initial.completion,
      },
    };
  });
  const controls = vi.fn(async (missionId: string) => {
    const request = requests.get(missionId);
    if (!request) throw new Error('control before create');
    return (
      options.control?.(missionId, request) ??
      Promise.resolve({
        reason: 'terminal' as const,
        state: terminalMissionState(
          request,
          'succeeded',
          { tokens: 100, usd: null, activeSeconds: 10 },
          `revision-${request.objective?.taskId}`,
        ),
        guideTurns: 1,
      })
    );
  });
  const answers = vi.fn(async (missionId: string, questionId: string, answer: string) => {
    const request = requests.get(missionId);
    if (!request) throw new Error('answer before create');
    return (
      options.answer?.(missionId, questionId, answer, request) ??
      Promise.resolve({
        reason: 'terminal' as const,
        state: terminalMissionState(
          request,
          'succeeded',
          { tokens: 40, usd: null, activeSeconds: 4 },
          `revision-${request.objective?.taskId}`,
        ),
        guideTurns: 2,
      })
    );
  });
  const cancellations = vi.fn(async (missionId: string, reason: string) => {
    const request = requests.get(missionId);
    if (!request) throw new Error('cancel before create');
    return (
      options.cancel?.(missionId, reason, request) ??
      Promise.resolve({
        reason: 'terminal' as const,
        state: terminalMissionState(request, 'cancelled', {
          tokens: 25,
          usd: null,
          activeSeconds: 3,
        }),
        guideTurns: 1,
      })
    );
  });
  const quiesces = vi.fn(async (missionId: string, reason: string) => {
    const request = requests.get(missionId);
    if (!request) throw new Error('quiesce before create');
    await options.quiesce?.(missionId, reason, request);
  });
  const resumes = vi.fn((missionId: string) => {
    const request = requests.get(missionId);
    if (!request) throw new Error('resume before create');
    options.resume?.(missionId, request);
  });
  const runtime = {
    catalog: { fingerprint: CATALOG_FINGERPRINT },
    resources: {},
    create: creates,
    inspect: vi.fn(),
    control: controls,
    answerAndContinue: answers,
    cancel: cancellations,
    quiesceMission: quiesces,
    resumeMission: resumes,
  } as unknown as NoriqMissionRuntime;
  return { runtime, creates, controls, answers, cancellations, quiesces, resumes, requests };
}

function transport(overrides: Partial<NoriqMissionCoordinatorTransport> = {}): {
  value: NoriqMissionCoordinatorTransport;
  begins: ReturnType<typeof vi.fn>;
  settles: ReturnType<typeof vi.fn>;
} {
  const begins = vi.fn(async (_runId: string, _lease: MissionLeaseRef, report: MissionTaskBeginReport) =>
    acceptedBegin(report),
  );
  const settles = vi.fn(async (_runId: string, _lease: MissionLeaseRef, report: MissionTaskSettleReport) => {
    const taskId = report.claimId.slice('claim-'.length);
    return acceptedSettle(report, taskId, `execution-${taskId}`);
  });
  return {
    value: { begin: overrides.begin ?? begins, settle: overrides.settle ?? settles },
    begins,
    settles,
  };
}

function coordinator(
  store: JsonlNoriqCoordinatorStore,
  runtime: NoriqMissionRuntime,
  wire: NoriqMissionCoordinatorTransport,
): NoriqMissionCoordinator {
  return new NoriqMissionCoordinator({
    store,
    transport: wire,
    resolveRuntime: async ({ executionProfile, repositoryKey }) => ({
      executionProfile,
      repositoryKey,
      missionBudget: TOTAL_BUDGET,
      runtime,
    }),
    now: (() => {
      let second = 0;
      return () => new Date(Date.UTC(2026, 7, 13, 12, 0, second++));
    })(),
  });
}

describe('NoriqMissionCoordinator durable authority', () => {
  it('replays the exact durable begin after an accepted acknowledgement is lost, before model work', async () => {
    const directory = await stateDirectory();
    const store = new JsonlNoriqCoordinatorStore(directory);
    let durableServerAck: MissionTaskAck | null = null;
    const beginReports: MissionTaskBeginReport[] = [];
    const wire = transport({
      async begin(_rootRunId, _lease, report) {
        beginReports.push(structuredClone(report));
        durableServerAck ??= acceptedBegin(report);
        if (beginReports.length === 1) throw new Error('socket dropped after server commit');
        return durableServerAck;
      },
    });
    const restarted: { current: NoriqMissionCoordinator | null } = { current: null };
    const local = fakeRuntime({
      async beforeCreate() {
        const inspected = await restarted.current?.inspect('run-root');
        expect(inspected?.tasks[0]?.beginAck?.accepted).toBe(true);
      },
    });
    const first = coordinator(store, local.runtime, wire.value);
    await first.commission(commission({ tasks: [TASKS[0]!] }));
    await expect(first.control('run-root')).resolves.toMatchObject({ reason: 'transport-error' });
    expect(local.creates).not.toHaveBeenCalled();

    restarted.current = coordinator(new JsonlNoriqCoordinatorStore(directory), local.runtime, wire.value);
    await expect(restarted.current.control('run-root')).resolves.toMatchObject({
      reason: 'quarantined',
    });
    await restarted.current.adopt({
      runId: 'run-root',
      decision: 'adopt',
      lease: { ...LEASE, epoch: LEASE.epoch + 1 },
      reason: null,
    });
    await expect(restarted.current.control('run-root')).resolves.toMatchObject({ reason: 'completed' });
    expect(beginReports).toHaveLength(2);
    expect(beginReports[1]).toEqual(beginReports[0]);
    expect(local.creates).toHaveBeenCalledTimes(1);
    expect(local.controls).toHaveBeenCalledTimes(1);
  });

  it('quarantines an unknown adoption result without cancelling or releasing valid local work', async () => {
    const directory = await stateDirectory();
    const wire = transport();
    const local = fakeRuntime();
    await coordinator(new JsonlNoriqCoordinatorStore(directory), local.runtime, wire.value).commission(
      commission({ tasks: [TASKS[0]!] }),
    );

    const release = vi.fn();
    const restarted = new NoriqMissionCoordinator({
      store: new JsonlNoriqCoordinatorStore(directory),
      transport: wire.value,
      resolveRuntime: async ({ executionProfile, repositoryKey }) => ({
        executionProfile,
        repositoryKey,
        missionBudget: TOTAL_BUDGET,
        runtime: local.runtime,
        release,
      }),
    });
    const uncertain = await restarted.adopt({
      runId: 'run-root',
      decision: 'unknown',
      lease: null,
      reason: 'runner lookup was inconclusive',
    });
    expect(uncertain.serverDisposition).toBeNull();
    expect(await restarted.reservedRootRunIds()).toEqual(['run-root']);
    expect(local.cancellations).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    await expect(restarted.control('run-root')).resolves.toMatchObject({ reason: 'quarantined' });

    await restarted.adopt({
      runId: 'run-root',
      decision: 'adopt',
      lease: { ...LEASE, epoch: LEASE.epoch + 1 },
      reason: null,
    });
    await expect(restarted.control('run-root')).resolves.toMatchObject({ reason: 'completed' });
    expect(local.cancellations).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('quiesces active model authority on transport loss and resumes only after next-epoch adoption', async () => {
    const directory = await stateDirectory();
    const firstControl = deferred<MissionHarnessStop>();
    let controlCalls = 0;
    const local = fakeRuntime({
      async control(_missionId, request) {
        controlCalls += 1;
        if (controlCalls === 1) return firstControl.promise;
        return {
          reason: 'terminal',
          state: terminalMissionState(
            request,
            'succeeded',
            { tokens: 50, usd: null, activeSeconds: 5 },
            `revision-${request.objective?.taskId}`,
          ),
          guideTurns: 1,
        };
      },
      async quiesce(missionId) {
        firstControl.resolve({
          reason: 'runtime-error',
          state: { ...initialMissionState(missionId), status: 'active' },
          guideTurns: 0,
          error: 'transport generation quiesced',
        });
      },
    });
    const value = coordinator(new JsonlNoriqCoordinatorStore(directory), local.runtime, transport().value);
    await value.commission(commission({ tasks: [TASKS[0]!] }));
    const running = value.control('run-root');
    await vi.waitFor(() => expect(local.controls).toHaveBeenCalledTimes(1));

    await value.quarantineAll('socket generation ended');
    await expect(running).resolves.toMatchObject({ reason: 'quarantined' });
    expect(local.quiesces).toHaveBeenCalledWith(expect.any(String), 'socket generation ended');
    expect(await value.reservedRootRunIds()).toEqual(['run-root']);

    await value.adopt({
      runId: 'run-root',
      decision: 'adopt',
      lease: { ...LEASE, epoch: LEASE.epoch + 1 },
      reason: null,
    });
    expect(local.resumes).toHaveBeenCalledTimes(1);
    await expect(value.control('run-root')).resolves.toMatchObject({ reason: 'completed' });
  });

  it('revokes control authority before process shutdown and joins nonterminal quiescence', async () => {
    const directory = await stateDirectory();
    const activeControl = deferred<MissionHarnessStop>();
    const local = fakeRuntime({
      control: () => activeControl.promise,
      async quiesce(missionId) {
        activeControl.resolve({
          reason: 'runtime-error',
          state: { ...initialMissionState(missionId), status: 'active' },
          guideTurns: 0,
          error: 'process shutdown quiesced',
        });
      },
    });
    const value = coordinator(new JsonlNoriqCoordinatorStore(directory), local.runtime, transport().value);
    await value.commission(commission({ tasks: [TASKS[0]!] }));
    const running = value.control('run-root');
    await vi.waitFor(() => expect(local.controls).toHaveBeenCalledOnce());

    await value.quiesce();
    await expect(running).resolves.toMatchObject({ reason: 'quarantined' });
    expect(local.quiesces).toHaveBeenCalledWith(expect.any(String), 'Runner daemon is shutting down');
    expect(local.cancellations).not.toHaveBeenCalled();
    await expect(value.control('run-root')).resolves.toMatchObject({ reason: 'quarantined' });
  });

  it('persists the exact settle report before send and replays it without rerunning the model', async () => {
    const directory = await stateDirectory();
    const store = new JsonlNoriqCoordinatorStore(directory);
    const settleReports: MissionTaskSettleReport[] = [];
    const local = fakeRuntime();
    const wire = transport({
      async settle(_rootRunId, _lease, report) {
        settleReports.push(structuredClone(report));
        const ack = acceptedSettle(report, 'task-a', 'execution-task-a');
        if (settleReports.length === 1) throw new Error('socket dropped after settle commit');
        return ack;
      },
    });
    const first = coordinator(store, local.runtime, wire.value);
    await first.commission(commission({ tasks: [TASKS[0]!] }));
    await expect(first.control('run-root')).resolves.toMatchObject({ reason: 'transport-error' });
    expect(local.controls).toHaveBeenCalledTimes(1);
    const beforeRestart = await first.inspect('run-root');
    expect(beforeRestart.tasks[0]?.settleReport).toEqual(settleReports[0]);
    expect(beforeRestart.tasks[0]?.settleAck).toBeNull();

    const restarted = coordinator(new JsonlNoriqCoordinatorStore(directory), local.runtime, wire.value);
    await restarted.adopt({
      runId: 'run-root',
      decision: 'adopt',
      lease: { ...LEASE, epoch: LEASE.epoch + 1 },
      reason: null,
    });
    const resumed = await restarted.control('run-root');
    expect(resumed.reason, resumed.reason === 'runtime-error' ? resumed.error : '').toBe('completed');
    expect(settleReports[1]).toEqual(settleReports[0]);
    expect(local.controls).toHaveBeenCalledTimes(1);
  });

  it('keeps restart inspection and inventory model-free', async () => {
    const directory = await stateDirectory();
    const store = new JsonlNoriqCoordinatorStore(directory);
    const local = fakeRuntime();
    const wire = transport({
      async settle() {
        throw new Error('offline');
      },
    });
    const first = coordinator(store, local.runtime, wire.value);
    await first.commission(commission({ tasks: [TASKS[0]!] }));
    await first.control('run-root');
    const resolver = vi.fn(
      async ({
        executionProfile,
        repositoryKey,
      }: {
        executionProfile: CommissionedExecutionProfile;
        repositoryKey: string;
      }) => ({
        executionProfile,
        repositoryKey,
        missionBudget: TOTAL_BUDGET,
        runtime: local.runtime,
      }),
    );
    const restarted = new NoriqMissionCoordinator({
      store: new JsonlNoriqCoordinatorStore(directory),
      transport: wire.value,
      resolveRuntime: resolver,
    });
    const inspected = await restarted.inspect('run-root');
    const inventory = await restarted.inventory('run-root');
    expect(inspected.tasks[0]?.beginAck?.accepted).toBe(true);
    expect(inventory).toMatchObject({
      runId: 'run-root',
      lease: LEASE,
      attempts: [{ executionId: 'execution-task-a', epoch: LEASE.epoch }],
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('distinguishes empty inventory from a corrupt WAL instead of silently omitting a root', async () => {
    const emptyDirectory = await stateDirectory();
    const local = fakeRuntime();
    const empty = coordinator(
      new JsonlNoriqCoordinatorStore(emptyDirectory),
      local.runtime,
      transport().value,
    );
    await expect(empty.inventoryAll()).resolves.toEqual([]);

    const directory = await stateDirectory();
    const store = new JsonlNoriqCoordinatorStore(directory);
    const value = coordinator(store, local.runtime, transport().value);
    await value.commission(commission({ tasks: [TASKS[0]!] }));
    await expect(store.listRootRunIds()).resolves.toEqual(['run-root']);
    await expect(value.inventoryAll()).resolves.toMatchObject([{ runId: 'run-root', attempts: [] }]);
    const wal = (await readdir(directory)).find((name) => name.endsWith('.jsonl'));
    expect(wal).toBeDefined();
    await appendFile(path.join(directory, wal!), '{"broken":true}\n', 'utf8');
    await expect(store.listRootRunIds()).rejects.toThrow(/corrupt/);
    await expect(value.inventoryAll()).rejects.toThrow(/corrupt/);
  });

  it('rejects a symlinked coordinator state directory', async () => {
    const parent = await stateDirectory();
    const target = path.join(parent, 'real-state');
    const linked = path.join(parent, 'linked-state');
    const targetStore = new JsonlNoriqCoordinatorStore(target);
    await targetStore.verifyPrivateState();
    await symlink(target, linked, 'dir');
    const linkedStore = new JsonlNoriqCoordinatorStore(linked);
    await expect(linkedStore.verifyPrivateState()).rejects.toThrow(/real directory/);
  });

  it('adopts only the exact next root epoch and updates every live inventory epoch atomically', async () => {
    const directory = await stateDirectory();
    const store = new JsonlNoriqCoordinatorStore(directory);
    const local = fakeRuntime();
    const wire = transport({
      async settle() {
        throw new Error('offline');
      },
    });
    const value = coordinator(store, local.runtime, wire.value);
    await value.commission(commission({ tasks: [TASKS[0]!] }));
    await value.control('run-root');

    await expect(
      value.adopt({ runId: 'run-root', decision: 'adopt', lease: LEASE, reason: null }),
    ).rejects.toThrow(/first server adoption must advance/);
    await expect(
      value.adopt({
        runId: 'run-root',
        decision: 'adopt',
        lease: { ...LEASE, epoch: LEASE.epoch + 2 },
        reason: null,
      }),
    ).rejects.toThrow(/exact next/);
    expect((await value.inventory('run-root')).lease).toEqual(LEASE);

    const next = { ...LEASE, epoch: LEASE.epoch + 1 };
    await value.adopt({ runId: 'run-root', decision: 'adopt', lease: next, reason: null });
    expect(await value.inventory('run-root')).toMatchObject({
      lease: next,
      attempts: [{ epoch: next.epoch }],
    });
    await expect(
      value.adopt({ runId: 'other-root', decision: 'adopt', lease: next, reason: null }),
    ).rejects.toThrow(/not commissioned/);
  });

  it('durably retires non-adopted roots, cleans up locally, and never reports under stale authority', async () => {
    const directory = await stateDirectory();
    const store = new JsonlNoriqCoordinatorStore(directory);
    const local = fakeRuntime({
      async control(_missionId, request) {
        return questionStop(request);
      },
    });
    const wire = transport();
    const release = vi.fn();
    const value = new NoriqMissionCoordinator({
      store,
      transport: wire.value,
      resolveRuntime: async ({ executionProfile, repositoryKey }) => ({
        executionProfile,
        repositoryKey,
        missionBudget: TOTAL_BUDGET,
        runtime: local.runtime,
        release,
      }),
    });
    await value.commission(commission({ tasks: [TASKS[0]!] }));
    await expect(value.control('run-root')).resolves.toMatchObject({ reason: 'human-question' });
    expect(wire.begins).toHaveBeenCalledTimes(1);
    expect(wire.settles).not.toHaveBeenCalled();

    const retired = await value.adopt({
      runId: 'run-root',
      decision: 'cancel',
      lease: null,
      reason: 'server inventory did not match',
    });
    expect(retired.serverDisposition).toEqual({
      decision: 'cancel',
      reason: 'server inventory did not match',
    });
    expect(local.cancellations).toHaveBeenCalledTimes(1);
    expect(wire.begins).toHaveBeenCalledTimes(1);
    expect(wire.settles).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);

    await expect(value.control('run-root')).resolves.toMatchObject({ reason: 'cancelled' });
    expect(local.cancellations).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    await expect(
      value.adopt({
        runId: 'run-root',
        decision: 'already_terminal',
        lease: null,
        reason: 'done',
      }),
    ).rejects.toBeInstanceOf(NoriqCoordinatorConflictError);
  });

  it('clamps each task to remaining root budget and chains the accepted VCS revision', async () => {
    const directory = await stateDirectory();
    const local = fakeRuntime();
    const wire = transport();
    const value = coordinator(new JsonlNoriqCoordinatorStore(directory), local.runtime, wire.value);
    await value.commission(commission());
    await expect(value.control('run-root')).resolves.toMatchObject({
      reason: 'completed',
      revisionId: 'revision-task-b',
    });
    const requests = [...local.requests.values()];
    expect(requests).toHaveLength(2);
    expect(requests[0]?.objective?.baseRevision).toBe('rev-base');
    expect(requests[0]?.budget).toEqual({ tokens: 1_000, usd: null, activeSeconds: 100 });
    expect(requests[1]?.objective?.baseRevision).toBe('revision-task-a');
    expect(requests[1]?.budget).toEqual({ tokens: 900, usd: null, activeSeconds: 90 });
    expect(wire.begins).toHaveBeenCalledTimes(2);
    expect(wire.settles).toHaveBeenCalledTimes(2);
  });

  it('refuses a server commission above the local execution-profile budget ceiling', async () => {
    const directory = await stateDirectory();
    const local = fakeRuntime();
    const release = vi.fn();
    const value = new NoriqMissionCoordinator({
      store: new JsonlNoriqCoordinatorStore(directory),
      transport: transport().value,
      resolveRuntime: async ({ executionProfile, repositoryKey }) => ({
        executionProfile,
        repositoryKey,
        missionBudget: { tokens: 500, usd: null, activeSeconds: 50 },
        runtime: local.runtime,
        release,
      }),
    });
    await value.commission(commission({ tasks: [TASKS[0]!] }));

    await expect(value.control('run-root')).resolves.toMatchObject({
      reason: 'runtime-error',
      error: expect.stringMatching(/local execution-profile ceiling/),
    });
    expect(local.creates).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('keeps workspace and profile authority reserved after a rejected settlement', async () => {
    const directory = await stateDirectory();
    const local = fakeRuntime();
    const release = vi.fn();
    const wire = transport({
      async settle(_rootRunId, _lease, report) {
        return {
          reportId: report.reportId,
          attemptId: report.attemptId,
          phase: 'settle',
          accepted: false,
          taskId: null,
          claimId: null,
          executionId: null,
          taskStatus: null,
          error: 'claim authority could not be established',
        };
      },
    });
    const value = new NoriqMissionCoordinator({
      store: new JsonlNoriqCoordinatorStore(directory),
      transport: wire.value,
      resolveRuntime: async ({ executionProfile, repositoryKey }) => ({
        executionProfile,
        repositoryKey,
        missionBudget: TOTAL_BUDGET,
        runtime: local.runtime,
        release,
      }),
    });
    await value.commission(commission({ tasks: [TASKS[0]!] }));

    await expect(value.control('run-root')).resolves.toMatchObject({ reason: 'authority-conflict' });
    expect(await value.reservedRootRunIds()).toEqual(['run-root']);
    expect(await value.inventoryAll()).toHaveLength(1);
    expect(release).not.toHaveBeenCalled();

    await value.adopt({
      runId: 'run-root',
      decision: 'cancel',
      lease: null,
      reason: 'server retired the disputed claim',
    });
    expect(await value.reservedRootRunIds()).toEqual([]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases a resolved execution profile exactly once after normal root completion', async () => {
    const directory = await stateDirectory();
    const local = fakeRuntime();
    const wire = transport();
    const release = vi.fn();
    const value = new NoriqMissionCoordinator({
      store: new JsonlNoriqCoordinatorStore(directory),
      transport: wire.value,
      resolveRuntime: async ({ executionProfile, repositoryKey }) => ({
        executionProfile,
        repositoryKey,
        missionBudget: TOTAL_BUDGET,
        runtime: local.runtime,
        release,
      }),
    });
    await value.commission(commission({ tasks: [TASKS[0]!] }));
    await expect(value.control('run-root')).resolves.toMatchObject({ reason: 'completed' });
    await expect(value.control('run-root')).resolves.toMatchObject({ reason: 'completed' });
    expect(release).toHaveBeenCalledTimes(1);
    expect(await value.inspectAll()).toHaveLength(1);
    expect(await value.reservedRootRunIds()).toEqual([]);
    expect(await value.inventoryAll()).toEqual([]);
    await value.adopt({
      runId: 'run-root',
      decision: 'already_terminal',
      lease: null,
      reason: 'server already settled the root',
    });
    await expect(value.control('run-root')).resolves.toMatchObject({ reason: 'completed' });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('keeps a completed plan root in reconciliation inventory until its handoff ack is durable', async () => {
    const directory = await stateDirectory();
    const local = fakeRuntime();
    const wire = transport();
    const value = coordinator(new JsonlNoriqCoordinatorStore(directory), local.runtime, wire.value);
    await value.commission(commission({ tasks: [TASKS[0]!], publishHandoff: true }));

    await expect(value.control('run-root')).resolves.toMatchObject({ reason: 'completed' });
    expect(await value.reservedRootRunIds()).toEqual(['run-root']);
    expect(await value.inventoryAll()).toEqual([
      expect.objectContaining({ runId: 'run-root', commissionDigest: 'b'.repeat(64) }),
    ]);

    await value.recordHandoffPublication('run-root', 'report-handoff', 'handoff-root');
    expect(await value.reservedRootRunIds()).toEqual([]);
    await expect(
      value.recordHandoffPublication('run-root', 'different-report', 'handoff-root'),
    ).rejects.toThrow(/different handoff publication/);
  });

  it('refuses a runtime resolver that answers for the wrong repository', async () => {
    const directory = await stateDirectory();
    const local = fakeRuntime();
    const wire = transport();
    const release = vi.fn();
    const value = new NoriqMissionCoordinator({
      store: new JsonlNoriqCoordinatorStore(directory),
      transport: wire.value,
      resolveRuntime: async ({ executionProfile }) => ({
        executionProfile,
        repositoryKey: 'another-repository',
        missionBudget: TOTAL_BUDGET,
        runtime: local.runtime,
        release,
      }),
    });
    await value.commission(commission({ tasks: [TASKS[0]!] }));
    await expect(value.control('run-root')).resolves.toMatchObject({
      reason: 'runtime-error',
      error: expect.stringMatching(/repository key/),
    });
    expect(local.creates).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('refuses a local runtime result cross-wired from another commissioned mission', async () => {
    const directory = await stateDirectory();
    const local = fakeRuntime({
      async control(_missionId, request) {
        return {
          reason: 'terminal',
          state: terminalMissionState({ ...request, missionId: 'another-local-mission' }, 'succeeded', {
            tokens: 10,
            usd: null,
            activeSeconds: 1,
          }),
          guideTurns: 1,
        };
      },
    });
    const wire = transport();
    const value = coordinator(new JsonlNoriqCoordinatorStore(directory), local.runtime, wire.value);
    await value.commission(commission({ tasks: [TASKS[0]!] }));

    await expect(value.control('run-root')).resolves.toMatchObject({
      reason: 'runtime-error',
      error: expect.stringMatching(/different mission/),
    });
    expect(wire.settles).not.toHaveBeenCalled();
  });

  it('refuses a local runtime question whose durable mission authority differs from the task', async () => {
    const directory = await stateDirectory();
    const local = fakeRuntime({
      async control(_missionId, request) {
        return questionStop({
          ...request,
          objective: request.objective ? { ...request.objective, taskId: 'another-task' } : undefined,
        });
      },
    });
    const wire = transport();
    const value = coordinator(new JsonlNoriqCoordinatorStore(directory), local.runtime, wire.value);
    await value.commission(commission({ tasks: [TASKS[0]!] }));

    await expect(value.control('run-root')).resolves.toMatchObject({
      reason: 'runtime-error',
      error: expect.stringMatching(/objective/),
    });
    expect(wire.settles).not.toHaveBeenCalled();
  });

  it('surfaces a reservation release failure without invoking opaque release twice', async () => {
    const directory = await stateDirectory();
    const local = fakeRuntime();
    const release = vi.fn(async () => {
      throw new Error('capacity broker unavailable');
    });
    const value = new NoriqMissionCoordinator({
      store: new JsonlNoriqCoordinatorStore(directory),
      transport: transport().value,
      resolveRuntime: async ({ executionProfile, repositoryKey }) => ({
        executionProfile,
        repositoryKey,
        missionBudget: TOTAL_BUDGET,
        runtime: local.runtime,
        release,
      }),
    });
    await value.commission(commission({ tasks: [TASKS[0]!] }));
    await expect(value.control('run-root')).resolves.toMatchObject({
      reason: 'runtime-error',
      error: expect.stringMatching(/reservation release failed/),
    });
    await expect(value.control('run-root')).resolves.toMatchObject({ reason: 'runtime-error' });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('fails closed on unknown finite usage and never begins the next task', async () => {
    const directory = await stateDirectory();
    const local = fakeRuntime({
      async control(_missionId, request) {
        return {
          reason: 'terminal',
          state: terminalMissionState(
            request,
            'succeeded',
            { tokens: null, usd: null, activeSeconds: 5 },
            `revision-${request.objective?.taskId}`,
          ),
          guideTurns: 1,
        };
      },
    });
    const wire = transport();
    const value = coordinator(new JsonlNoriqCoordinatorStore(directory), local.runtime, wire.value);
    await value.commission(commission());
    await expect(value.control('run-root')).resolves.toMatchObject({ reason: 'failed' });
    expect(wire.begins).toHaveBeenCalledTimes(1);
    expect(wire.settles).toHaveBeenCalledTimes(1);
    expect(wire.settles.mock.calls[0]?.[2]).toMatchObject({
      outcome: 'failed',
      reason: expect.stringMatching(/tokens usage is unknown/),
    });
  });

  it('durably stops for a human question and resumes only through the exact persisted answer', async () => {
    const directory = await stateDirectory();
    const local = fakeRuntime({
      async control(_missionId, request) {
        return questionStop(request);
      },
    });
    const wire = transport();
    const value = coordinator(new JsonlNoriqCoordinatorStore(directory), local.runtime, wire.value);
    await value.commission(commission({ tasks: [TASKS[0]!] }));
    await expect(value.control('run-root')).resolves.toMatchObject({
      reason: 'human-question',
      questionId: 'question-1',
    });
    await expect(
      value.answer('run-root', 'question-1', 'Use the migration-safe option.'),
    ).resolves.toMatchObject({
      reason: 'completed',
    });
    expect(local.answers).toHaveBeenCalledWith(
      expect.any(String),
      'question-1',
      'Use the migration-safe option.',
    );
    await expect(value.answer('run-root', 'question-1', 'A different answer.')).rejects.toThrow();
  });

  it('durably records an accepted question publication across lease adoption', async () => {
    const directory = await stateDirectory();
    const local = fakeRuntime({
      async control(_missionId, request) {
        return questionStop(request);
      },
    });
    const wire = transport();
    const value = coordinator(new JsonlNoriqCoordinatorStore(directory), local.runtime, wire.value);
    await value.commission(commission({ tasks: [TASKS[0]!] }));
    await value.control('run-root');

    await value.recordQuestionPublication('run-root', 'question-1', 'report-question-1', 'signal-question-1');
    await value.adopt({
      runId: 'run-root',
      decision: 'adopt',
      lease: { ...LEASE, epoch: LEASE.epoch + 1 },
      reason: null,
    });

    await expect(value.inspect('run-root')).resolves.toMatchObject({
      tasks: [
        {
          questionPublication: {
            questionId: 'question-1',
            reportId: 'report-question-1',
            signalId: 'signal-question-1',
          },
        },
      ],
    });
    await expect(
      value.recordQuestionPublication('run-root', 'question-1', 'replayed-report-id', 'signal-question-1'),
    ).resolves.toBeDefined();
  });

  it('cancels the admitted local mission before settling the Noriq attempt as cancelled', async () => {
    const directory = await stateDirectory();
    const local = fakeRuntime({
      async control(_missionId, request) {
        return questionStop(request);
      },
    });
    const wire = transport();
    const value = coordinator(new JsonlNoriqCoordinatorStore(directory), local.runtime, wire.value);
    await value.commission(commission({ tasks: [TASKS[0]!] }));
    await value.control('run-root');
    await expect(value.cancel('run-root', 'operator cancelled')).resolves.toMatchObject({
      reason: 'cancelled',
    });
    expect(local.cancellations).toHaveBeenCalledWith(expect.any(String), 'operator cancelled');
    expect(wire.settles.mock.calls[0]?.[2]).toMatchObject({
      outcome: 'cancelled',
      reason: 'operator cancelled',
    });
  });

  it('interrupts an in-flight local control without waiting for the long-lived controller lease', async () => {
    const directory = await stateDirectory();
    const pendingControl = new Promise<MissionHarnessStop>(() => undefined);
    const local = fakeRuntime({
      async control() {
        return pendingControl;
      },
      async cancel(_missionId, _reason, request) {
        const stop: MissionHarnessStop = {
          reason: 'terminal',
          state: terminalMissionState(request, 'cancelled', {
            tokens: 12,
            usd: null,
            activeSeconds: 2,
          }),
          guideTurns: 1,
        };
        return stop;
      },
    });
    const wire = transport();
    const value = coordinator(new JsonlNoriqCoordinatorStore(directory), local.runtime, wire.value);
    await value.commission(commission({ tasks: [TASKS[0]!] }));
    const running = value.control('run-root');
    await vi.waitFor(() => expect(local.controls).toHaveBeenCalledTimes(1));
    const cancellation = value.cancel('run-root', 'server requested prompt cancellation');
    await expect(cancellation).resolves.toMatchObject({ reason: 'cancelled' });
    await expect(running).resolves.toMatchObject({ reason: 'cancelled' });
    expect(local.cancellations).toHaveBeenCalledTimes(1);
    expect(wire.settles.mock.calls[0]?.[2]).toMatchObject({ outcome: 'cancelled' });
  });

  it('replays an uncertain begin before cancellation so a lost ack cannot strand a server claim', async () => {
    const directory = await stateDirectory();
    let acknowledged: MissionTaskAck | null = null;
    const reports: MissionTaskBeginReport[] = [];
    const wire = transport({
      async begin(_rootRunId, _lease, report) {
        reports.push(structuredClone(report));
        acknowledged ??= acceptedBegin(report);
        if (reports.length === 1) throw new Error('accepted ack was lost');
        return acknowledged;
      },
    });
    const local = fakeRuntime();
    const value = coordinator(new JsonlNoriqCoordinatorStore(directory), local.runtime, wire.value);
    await value.commission(commission({ tasks: [TASKS[0]!] }));
    await expect(value.control('run-root')).resolves.toMatchObject({ reason: 'transport-error' });
    await expect(value.cancel('run-root', 'operator cancelled after uncertainty')).resolves.toMatchObject({
      reason: 'cancelled',
    });
    expect(reports).toHaveLength(2);
    expect(reports[1]).toEqual(reports[0]);
    expect(local.cancellations).toHaveBeenCalledTimes(1);
    expect(wire.settles.mock.calls[0]?.[2]).toMatchObject({ outcome: 'cancelled' });
  });

  it('rejects malformed, duplicate, cyclic/order-invalid, and digest-conflicting commissions', async () => {
    expect(() =>
      validateNoriqMissionCommission({
        ...commission(),
        tasks: [TASKS[0], { ...TASKS[1], taskId: 'task-a' }],
      }),
    ).toThrow(/duplicate commissioned task|commissionDigest mismatch/);
    expect(() =>
      commission({
        tasks: [
          { taskId: 'task-a', childKey: 'a', brief: 'A', dependencyIds: ['task-b'] },
          { taskId: 'task-b', childKey: 'b', brief: 'B', dependencyIds: [] },
        ],
      }),
    ).not.toThrow();
    const outOfOrder = commission({
      tasks: [
        { taskId: 'task-a', childKey: 'a', brief: 'A', dependencyIds: ['task-b'] },
        { taskId: 'task-b', childKey: 'b', brief: 'B', dependencyIds: [] },
      ],
    });
    expect(() => validateNoriqMissionCommission(outOfOrder)).toThrow(/absent or not earlier/);
    expect(() =>
      validateNoriqMissionCommission({ ...commission(), commissionDigest: '0'.repeat(64) }),
    ).toThrow(/commissionDigest mismatch/);

    const directory = await stateDirectory();
    const local = fakeRuntime();
    const value = coordinator(new JsonlNoriqCoordinatorStore(directory), local.runtime, transport().value);
    await value.commission(commission());
    expect(commission({ rootRunId: 'another-root' }).commissionDigest).not.toBe(
      commission().commissionDigest,
    );
    await expect(value.commission(commission({ baseRevision: 'another-base' }))).rejects.toBeInstanceOf(
      NoriqCoordinatorConflictError,
    );
  });
});
