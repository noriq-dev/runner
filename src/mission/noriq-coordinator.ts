import { createHash } from 'node:crypto';
import {
  MissionAdoptionResult as MissionAdoptionResultSchema,
  MissionTaskAck as MissionTaskAckSchema,
} from '@noriq-dev/shared';
import type {
  CommissionedExecutionProfile,
  MissionAdoptionResult,
  MissionInventoryItem,
  MissionLeaseRef,
  MissionTaskAck,
  MissionTaskBeginReport,
  MissionTaskSettleReport,
} from '@noriq-dev/shared';
import type { MissionHarnessStop } from './harness';
import type { LocalMissionRuntime } from './local-runtime';
import type { MissionAcceptedRevisionHandoffState, MissionState } from './model';
import {
  type JsonlNoriqCoordinatorStore,
  type NoriqCoordinatorAction,
  NoriqCoordinatorActionSchema,
  NoriqCoordinatorConflictError,
  type NoriqCoordinatorControlObservation,
  NoriqCoordinatorCorruptionError,
  type NoriqCoordinatorHistory,
  type NoriqMissionCommission,
  type NoriqMissionTaskSnapshot,
  computeNoriqMissionCommissionDigest,
  validateNoriqMissionCommission,
} from './noriq-coordinator-store';
import type { MissionBudget, MissionUsage } from './protocol';
import type { MissionCreateRequest } from './service';
import { canonicalMissionJson } from './store';

const MAX_REASON_CHARS = 2_000;
const MAX_ANSWER_CHARS = 64_000;
export const MAX_NORIQ_RECONCILIATION_ROOTS = 128;

export type NoriqMissionRuntime = Pick<
  LocalMissionRuntime,
  'catalog' | 'resources' | 'create' | 'inspect' | 'control' | 'answerAndContinue' | 'cancel'
> &
  Partial<Pick<LocalMissionRuntime, 'quiesce' | 'quiesceMission' | 'resumeMission'>>;

export interface ResolvedNoriqMissionRuntime {
  /** Echo of the exact immutable server commission used for this resolution. */
  executionProfile: CommissionedExecutionProfile;
  repositoryKey: string;
  /** Local execution-profile ceiling; a remote commission may only narrow it. */
  missionBudget: MissionBudget;
  runtime: NoriqMissionRuntime;
  /** Release the execution-profile capacity reservation. Called exactly once at root retirement. */
  release?(): void | Promise<void>;
}

export type NoriqMissionRuntimeResolver = (
  request: Readonly<{
    executionProfile: CommissionedExecutionProfile;
    repositoryKey: string;
  }>,
) => Promise<ResolvedNoriqMissionRuntime>;

export interface NoriqMissionCoordinatorTransport {
  begin(rootRunId: string, lease: MissionLeaseRef, report: MissionTaskBeginReport): Promise<MissionTaskAck>;
  settle(rootRunId: string, lease: MissionLeaseRef, report: MissionTaskSettleReport): Promise<MissionTaskAck>;
}

export interface NoriqMissionCoordinatorOptions {
  store: JsonlNoriqCoordinatorStore;
  transport: NoriqMissionCoordinatorTransport;
  resolveRuntime: NoriqMissionRuntimeResolver;
  now?: () => Date;
}

export interface NoriqCoordinatorTaskState {
  readonly index: number;
  readonly task: NoriqMissionTaskSnapshot;
  readonly missionId: string | null;
  readonly attemptId: string | null;
  readonly baseRevision: string | null;
  readonly budget: MissionBudget | null;
  readonly beginReport: MissionTaskBeginReport | null;
  readonly beginAck: MissionTaskAck | null;
  readonly missionCreated: boolean;
  readonly observation: NoriqCoordinatorControlObservation | null;
  readonly preparedAnswers: Readonly<Record<string, string>>;
  readonly settleReport: MissionTaskSettleReport | null;
  readonly settleAck: MissionTaskAck | null;
}

export interface NoriqMissionCoordinatorState {
  readonly rootRunId: string;
  readonly revision: number;
  readonly commission: NoriqMissionCommission | null;
  readonly lease: MissionLeaseRef | null;
  readonly tasks: readonly NoriqCoordinatorTaskState[];
  readonly cumulativeUsage: MissionUsage;
  readonly adoptionCount: number;
  readonly cancelReason: string | null;
  readonly failureReason: string | null;
  readonly serverDisposition: {
    readonly decision: 'already_terminal' | 'cancel' | 'unknown';
    readonly reason: string | null;
  } | null;
}

export type NoriqMissionCoordinatorStop =
  | {
      reason: 'completed';
      state: NoriqMissionCoordinatorState;
      revisionId: string;
    }
  | {
      reason: 'cancelled';
      state: NoriqMissionCoordinatorState;
      detail: string;
    }
  | {
      reason: 'failed';
      state: NoriqMissionCoordinatorState;
      error: string;
    }
  | {
      reason: 'human-question';
      state: NoriqMissionCoordinatorState;
      taskId: string;
      questionId: string;
      prompt: string;
    }
  | {
      reason: 'transport-error' | 'runtime-error';
      state: NoriqMissionCoordinatorState;
      error: string;
    }
  | {
      reason: 'quarantined' | 'authority-conflict';
      state: NoriqMissionCoordinatorState;
      error: string;
    };

const ZERO_USAGE: MissionUsage = Object.freeze({ tokens: 0, usd: 0, activeSeconds: 0 });

function bounded(value: string, max = MAX_REASON_CHARS): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function errorText(error: unknown): string {
  return bounded(error instanceof Error ? error.message : String(error));
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalMissionJson(value), 'utf8').digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalMissionJson(left) === canonicalMissionJson(right);
}

function initialCoordinatorState(rootRunId: string): NoriqMissionCoordinatorState {
  return {
    rootRunId,
    revision: 0,
    commission: null,
    lease: null,
    tasks: [],
    cumulativeUsage: ZERO_USAGE,
    adoptionCount: 0,
    cancelReason: null,
    failureReason: null,
    serverDisposition: null,
  };
}

function corrupt(rootRunId: string, revision: number, message: string): never {
  throw new NoriqCoordinatorCorruptionError(rootRunId, revision, message);
}

function requireTask(
  state: NoriqMissionCoordinatorState,
  taskIndex: number,
  revision: number,
): NoriqCoordinatorTaskState {
  const task = state.tasks[taskIndex];
  if (!task) corrupt(state.rootRunId, revision, `unknown task index ${taskIndex}`);
  return task;
}

function replaceTask(
  state: NoriqMissionCoordinatorState,
  taskIndex: number,
  task: NoriqCoordinatorTaskState,
  revision: number,
): NoriqMissionCoordinatorState {
  const tasks = [...state.tasks];
  tasks[taskIndex] = task;
  return { ...state, revision, tasks };
}

function liveAttemptIds(state: NoriqMissionCoordinatorState): readonly string[] {
  return state.tasks.flatMap((task) =>
    task.beginAck?.accepted === true && task.settleAck?.accepted !== true && task.attemptId
      ? [task.attemptId]
      : [],
  );
}

function reduceCoordinatorAction(
  state: NoriqMissionCoordinatorState,
  action: NoriqCoordinatorAction,
  revision: number,
): NoriqMissionCoordinatorState {
  if (action.type === 'commissioned') {
    if (state.commission !== null) corrupt(state.rootRunId, revision, 'commission was recorded twice');
    const commission = validateNoriqMissionCommission(action.commission);
    if (commission.rootRunId !== state.rootRunId) {
      corrupt(state.rootRunId, revision, 'commission rootRunId does not match WAL identity');
    }
    return {
      ...state,
      revision,
      commission,
      lease: commission.lease,
      tasks: commission.tasks.map((task, index) => ({
        index,
        task,
        missionId: null,
        attemptId: null,
        baseRevision: null,
        budget: null,
        beginReport: null,
        beginAck: null,
        missionCreated: false,
        observation: null,
        preparedAnswers: {},
        settleReport: null,
        settleAck: null,
      })),
    };
  }
  if (!state.commission || !state.lease) {
    corrupt(state.rootRunId, revision, `${action.type} preceded the immutable commission`);
  }

  if (action.type === 'task-prepared') {
    const task = requireTask(state, action.taskIndex, revision);
    if (task.beginReport !== null) corrupt(state.rootRunId, revision, 'task was prepared twice');
    if (state.tasks.slice(0, action.taskIndex).some((candidate) => candidate.settleAck?.accepted !== true)) {
      corrupt(state.rootRunId, revision, 'task was prepared before an earlier settle was accepted');
    }
    if (state.tasks.slice(action.taskIndex + 1).some((candidate) => candidate.beginReport !== null)) {
      corrupt(state.rootRunId, revision, 'task preparation order moved backwards');
    }
    if (
      action.beginReport.attemptId !== action.attemptId ||
      action.beginReport.taskId !== task.task.taskId ||
      action.beginReport.childKey !== task.task.childKey
    ) {
      corrupt(state.rootRunId, revision, 'prepared begin identity is inconsistent');
    }
    return replaceTask(
      state,
      action.taskIndex,
      {
        ...task,
        missionId: action.missionId,
        attemptId: action.attemptId,
        baseRevision: action.baseRevision,
        budget: action.budget,
        beginReport: action.beginReport,
      },
      revision,
    );
  }

  if (action.type === 'task-begin-acknowledged') {
    const task = requireTask(state, action.taskIndex, revision);
    if (!task.beginReport || !task.attemptId) {
      corrupt(state.rootRunId, revision, 'begin acknowledgement preceded its durable report');
    }
    if (task.beginAck !== null)
      corrupt(state.rootRunId, revision, 'begin acknowledgement was recorded twice');
    if (
      action.ack.phase !== 'begin' ||
      action.ack.reportId !== task.beginReport.reportId ||
      action.ack.attemptId !== task.attemptId
    ) {
      corrupt(state.rootRunId, revision, 'begin acknowledgement identity is inconsistent');
    }
    if (
      action.ack.accepted &&
      (action.ack.taskId !== task.task.taskId || !action.ack.claimId || !action.ack.executionId)
    ) {
      corrupt(state.rootRunId, revision, 'accepted begin acknowledgement is incomplete');
    }
    return replaceTask(state, action.taskIndex, { ...task, beginAck: action.ack }, revision);
  }

  if (action.type === 'task-mission-created') {
    const task = requireTask(state, action.taskIndex, revision);
    if (task.beginAck?.accepted !== true) {
      corrupt(state.rootRunId, revision, 'local mission creation preceded accepted begin authority');
    }
    if (task.missionCreated) corrupt(state.rootRunId, revision, 'local mission creation was recorded twice');
    return replaceTask(state, action.taskIndex, { ...task, missionCreated: true }, revision);
  }

  if (action.type === 'task-control-observed') {
    const task = requireTask(state, action.taskIndex, revision);
    if (!task.missionCreated)
      corrupt(state.rootRunId, revision, 'control observation preceded mission creation');
    if (task.observation?.kind === 'terminal') {
      corrupt(state.rootRunId, revision, 'terminal local observation was replaced');
    }
    let cumulativeUsage = state.cumulativeUsage;
    if (action.observation.kind === 'terminal') cumulativeUsage = action.observation.cumulativeUsage;
    return replaceTask(
      { ...state, cumulativeUsage },
      action.taskIndex,
      { ...task, observation: action.observation },
      revision,
    );
  }

  if (action.type === 'task-answer-prepared') {
    const task = requireTask(state, action.taskIndex, revision);
    if (task.observation?.kind !== 'human-question') {
      corrupt(state.rootRunId, revision, 'answer preceded a durable human question');
    }
    if (task.observation.questionId !== action.questionId) {
      corrupt(state.rootRunId, revision, 'answer questionId does not match the current question');
    }
    const previous = task.preparedAnswers[action.questionId];
    if (previous !== undefined) corrupt(state.rootRunId, revision, 'question answer was prepared twice');
    return replaceTask(
      state,
      action.taskIndex,
      {
        ...task,
        preparedAnswers: { ...task.preparedAnswers, [action.questionId]: action.answer },
      },
      revision,
    );
  }

  if (action.type === 'task-settle-prepared') {
    const task = requireTask(state, action.taskIndex, revision);
    if (task.observation?.kind !== 'terminal' || task.beginAck?.accepted !== true || !task.attemptId) {
      corrupt(state.rootRunId, revision, 'settlement preceded terminal local state and accepted begin');
    }
    if (task.settleReport !== null) corrupt(state.rootRunId, revision, 'settlement was prepared twice');
    if (
      action.report.attemptId !== task.attemptId ||
      action.report.claimId !== task.beginAck.claimId ||
      action.report.outcome !== task.observation.settlementOutcome
    ) {
      corrupt(state.rootRunId, revision, 'settlement report is inconsistent with durable authority');
    }
    return replaceTask(state, action.taskIndex, { ...task, settleReport: action.report }, revision);
  }

  if (action.type === 'task-settle-acknowledged') {
    const task = requireTask(state, action.taskIndex, revision);
    if (!task.settleReport || !task.attemptId || !task.beginAck) {
      corrupt(state.rootRunId, revision, 'settle acknowledgement preceded its durable report');
    }
    if (task.settleAck !== null)
      corrupt(state.rootRunId, revision, 'settle acknowledgement was recorded twice');
    if (
      action.ack.phase !== 'settle' ||
      action.ack.reportId !== task.settleReport.reportId ||
      action.ack.attemptId !== task.attemptId
    ) {
      corrupt(state.rootRunId, revision, 'settle acknowledgement identity is inconsistent');
    }
    if (
      action.ack.accepted &&
      (action.ack.taskId !== task.task.taskId ||
        action.ack.claimId !== task.beginAck.claimId ||
        action.ack.executionId !== task.beginAck.executionId)
    ) {
      corrupt(state.rootRunId, revision, 'accepted settle acknowledgement is incomplete');
    }
    return replaceTask(state, action.taskIndex, { ...task, settleAck: action.ack }, revision);
  }

  if (action.type === 'lease-adopted') {
    if (!same(action.previousLease, state.lease)) {
      corrupt(state.rootRunId, revision, 'adoption previous lease does not match current authority');
    }
    if (!same(action.liveAttemptIds, liveAttemptIds(state))) {
      corrupt(state.rootRunId, revision, 'adoption live attempt inventory does not match WAL state');
    }
    if (
      action.lease.sitting !== state.lease.sitting ||
      action.lease.executionId !== state.lease.executionId ||
      action.lease.epoch !== state.lease.epoch + 1
    ) {
      corrupt(state.rootRunId, revision, 'adoption lease is not the exact next epoch');
    }
    return { ...state, revision, lease: action.lease, adoptionCount: state.adoptionCount + 1 };
  }

  if (action.type === 'server-disposition-recorded') {
    if (state.serverDisposition !== null) {
      corrupt(state.rootRunId, revision, 'server disposition was recorded twice');
    }
    return {
      ...state,
      revision,
      serverDisposition: { decision: action.decision, reason: action.reason },
    };
  }

  if (action.type === 'cancel-requested') {
    if (state.cancelReason !== null) corrupt(state.rootRunId, revision, 'cancellation was recorded twice');
    return { ...state, revision, cancelReason: action.reason };
  }

  if (action.type === 'coordinator-failed') {
    if (state.failureReason !== null)
      corrupt(state.rootRunId, revision, 'coordinator failure was recorded twice');
    return { ...state, revision, failureReason: action.reason };
  }

  return action satisfies never;
}

function stateFromHistory(history: NoriqCoordinatorHistory): NoriqMissionCoordinatorState {
  let state = initialCoordinatorState(history.rootRunId);
  for (const record of history.records) {
    state = reduceCoordinatorAction(state, record.action, record.revision);
  }
  if (state.revision !== history.revision) {
    corrupt(history.rootRunId, history.revision, 'derived revision does not match WAL head');
  }
  return deepFreeze(state);
}

function successfulSettles(state: NoriqMissionCoordinatorState): number {
  let count = 0;
  for (const task of state.tasks) {
    if (task.settleAck?.accepted !== true || task.settleReport?.outcome !== 'done') break;
    count += 1;
  }
  return count;
}

function finalAcceptedRevision(state: NoriqMissionCoordinatorState): string | null {
  if (state.tasks.length === 0 || successfulSettles(state) !== state.tasks.length) return null;
  const last = state.tasks[state.tasks.length - 1];
  return last?.observation?.kind === 'terminal' ? (last.observation.handoff?.revisionId ?? null) : null;
}

function coordinatorTerminalStop(state: NoriqMissionCoordinatorState): NoriqMissionCoordinatorStop | null {
  if (state.failureReason) return { reason: 'failed', state, error: state.failureReason };
  if (state.serverDisposition) {
    const detail = state.serverDisposition.reason ?? state.serverDisposition.decision;
    const completedRevision = finalAcceptedRevision(state);
    if (state.serverDisposition.decision === 'already_terminal' && completedRevision) {
      return { reason: 'completed', state, revisionId: completedRevision };
    }
    if (state.serverDisposition.decision === 'cancel') {
      return { reason: 'cancelled', state, detail };
    }
    return { reason: 'failed', state, error: `server retired mission: ${detail}` };
  }
  const rejectedSettle = state.tasks.find((task) => task.settleAck?.accepted === false);
  if (rejectedSettle) {
    return {
      reason: 'authority-conflict',
      state,
      error: bounded(
        rejectedSettle.settleAck?.error ??
          `Noriq refused settlement for task '${rejectedSettle.task.taskId}'`,
      ),
    };
  }
  const rejectedBegin = state.tasks.find((task) => task.beginAck?.accepted === false);
  if (rejectedBegin) {
    return {
      reason: 'failed',
      state,
      error: bounded(
        rejectedBegin.beginAck?.error ?? `Noriq refused task '${rejectedBegin.task.taskId}' authority`,
      ),
    };
  }
  const settledFailure = state.tasks.find(
    (task) => task.settleAck?.accepted === true && task.settleReport?.outcome !== 'done',
  );
  if (settledFailure) {
    if (settledFailure.settleReport?.outcome === 'cancelled') {
      return {
        reason: 'cancelled',
        state,
        detail: settledFailure.settleReport.reason ?? state.cancelReason ?? 'mission cancelled',
      };
    }
    return {
      reason: 'failed',
      state,
      error: settledFailure.settleReport?.reason ?? 'local mission failed',
    };
  }
  const revisionId = finalAcceptedRevision(state);
  if (revisionId) return { reason: 'completed', state, revisionId };
  // A prepared begin with a lost acknowledgement may already own a server claim. Cancellation
  // must replay that exact report before declaring the root locally cancelled; otherwise a
  // response-loss window would strand the server attempt until its lease expired.
  if (
    state.cancelReason &&
    state.tasks.every((task) => task.beginReport === null || task.settleAck?.accepted === true)
  ) {
    return { reason: 'cancelled', state, detail: state.cancelReason };
  }
  return null;
}

/** Pure durable terminal predicate used by daemon reservation/reconciliation code. */
export function isNoriqMissionCoordinatorTerminal(state: NoriqMissionCoordinatorState): boolean {
  const stop = coordinatorTerminalStop(state);
  return stop?.reason === 'completed' || stop?.reason === 'cancelled' || stop?.reason === 'failed';
}

interface ActiveNoriqRootControl {
  promise: Promise<NoriqMissionCoordinatorStop>;
  pendingCancel: string | null;
  interrupt: ((reason: string) => Promise<MissionHarnessStop>) | null;
  interruptResult: Promise<MissionHarnessStop> | null;
  interruptOutcome: Promise<MissionHarnessStop>;
  resolveInterrupt(stop: MissionHarnessStop): void;
  rejectInterrupt(error: unknown): void;
  pendingSuspend: string | null;
  suspend: ((reason: string) => Promise<void>) | null;
  suspendResult: Promise<void> | null;
  suspendOutcome: Promise<void>;
  resolveSuspend(): void;
  rejectSuspend(error: unknown): void;
}

function deterministicTaskIdentity(
  commission: NoriqMissionCommission,
  taskIndex: number,
): {
  attemptId: string;
  missionId: string;
} {
  const task = commission.tasks[taskIndex];
  if (!task) throw new Error(`unknown commissioned task index ${taskIndex}`);
  const identity = digest({
    kind: 'noriq-mission-task-v1',
    rootRunId: commission.rootRunId,
    commissionDigest: commission.commissionDigest,
    taskIndex,
    taskId: task.taskId,
    childKey: task.childKey,
  });
  return {
    attemptId: `nma_${identity.slice(0, 56)}`,
    missionId: `noriq-${identity}`,
  };
}

type UsageAxis = keyof MissionUsage;

function remainingBudget(
  total: MissionBudget,
  usage: MissionUsage,
): { budget: MissionBudget | null; error: string | null } {
  const result: MissionBudget = { tokens: null, usd: null, activeSeconds: null };
  for (const axis of ['tokens', 'usd', 'activeSeconds'] as const satisfies readonly UsageAxis[]) {
    const limit = total[axis];
    if (limit === null) {
      result[axis] = null;
      continue;
    }
    const observed = usage[axis];
    if (observed === null) return { budget: null, error: `${axis} usage is unknown` };
    const remaining = limit - observed;
    if (remaining < 0) return { budget: null, error: `${axis} usage exceeded root budget` };
    if ((axis === 'tokens' || axis === 'activeSeconds') && remaining <= 0) {
      return { budget: null, error: `${axis} root budget is exhausted` };
    }
    result[axis] = remaining;
  }
  return { budget: result, error: null };
}

function commissionFitsLocalBudget(commission: MissionBudget, local: MissionBudget): string | null {
  for (const axis of ['tokens', 'usd', 'activeSeconds'] as const) {
    const ceiling = local[axis];
    const requested = commission[axis];
    if (ceiling === null) {
      if (axis !== 'usd') return `local execution-profile ${axis} ceiling is unavailable`;
      continue;
    }
    if (requested === null || requested > ceiling) {
      return `commissioned ${axis} budget exceeds the local execution-profile ceiling`;
    }
  }
  return null;
}

function addTerminalUsage(
  previous: MissionUsage,
  taskBudget: MissionBudget,
  taskUsage: MissionUsage,
  total: MissionBudget,
): { cumulative: MissionUsage; error: string | null } {
  const cumulative: MissionUsage = { tokens: null, usd: null, activeSeconds: null };
  let error: string | null = null;
  for (const axis of ['tokens', 'usd', 'activeSeconds'] as const satisfies readonly UsageAxis[]) {
    const before = previous[axis];
    const current = taskUsage[axis];
    const allocation = taskBudget[axis];
    const limit = total[axis];
    if (current === null) {
      cumulative[axis] = null;
      if (limit !== null && error === null) error = `${axis} usage is unknown`;
      continue;
    }
    if (!Number.isFinite(current) || current < 0 || (axis === 'tokens' && !Number.isSafeInteger(current))) {
      cumulative[axis] = null;
      if (error === null) error = `${axis} usage is invalid`;
      continue;
    }
    if (allocation !== null && current > allocation && error === null) {
      error = `${axis} usage ${current} exceeded task allocation ${allocation}`;
    }
    if (before === null) {
      cumulative[axis] = null;
      if (limit !== null && error === null) error = `${axis} cumulative usage is unknown`;
      continue;
    }
    const sum = before + current;
    if (!Number.isFinite(sum) || sum > Number.MAX_SAFE_INTEGER) {
      cumulative[axis] = null;
      if (error === null) error = `${axis} cumulative usage overflowed`;
      continue;
    }
    cumulative[axis] = sum;
    if (limit !== null && sum > limit && error === null) {
      error = `${axis} cumulative usage ${sum} exceeded root budget ${limit}`;
    }
  }
  return { cumulative, error };
}

function currentBaseRevision(state: NoriqMissionCoordinatorState, taskIndex: number): string {
  if (!state.commission) throw new Error('coordinator is not commissioned');
  if (taskIndex === 0) return state.commission.baseRevision;
  const previous = state.tasks[taskIndex - 1];
  if (previous?.observation?.kind !== 'terminal' || previous.observation.handoff === null) {
    throw new Error(`task ${taskIndex} has no accepted predecessor revision handoff`);
  }
  return previous.observation.handoff.revisionId;
}

function createRequest(
  commission: NoriqMissionCommission,
  task: NoriqCoordinatorTaskState,
): MissionCreateRequest {
  if (!task.missionId || !task.budget || !task.baseRevision) {
    throw new Error(`task '${task.task.taskId}' lacks durable local mission preparation`);
  }
  return {
    missionId: task.missionId,
    actionId: `noriq-create-${digest({
      missionId: task.missionId,
      commissionDigest: commission.commissionDigest,
      budget: task.budget,
      baseRevision: task.baseRevision,
    })}`,
    catalogFingerprint: commission.catalogFingerprint,
    objective: {
      brief: task.task.brief,
      taskId: task.task.taskId,
      runId: commission.rootRunId,
      repositoryKey: commission.repositoryKey,
      baseRevision: task.baseRevision,
    },
    budget: task.budget,
    resources: commission.resources,
    completion: { requireCheckpoint: true, requireReview: true },
  };
}

/**
 * Re-bind every local-runtime result to the exact durable commission before it can become Noriq
 * evidence. The runtime is a trusted component, but a stale cache or wiring bug must not let one
 * mission's usage, question, or accepted revision settle another task.
 */
function assertLocalMissionAuthority(
  coordinator: NoriqMissionCoordinatorState,
  task: NoriqCoordinatorTaskState,
  localState: MissionState,
): void {
  if (!coordinator.commission) throw new Error('local mission authority requires a commission');
  const expected = createRequest(coordinator.commission, task);
  if (localState.missionId !== expected.missionId) {
    throw new Error('local runtime returned state for a different mission');
  }
  if (!same(localState.objective, expected.objective ?? null)) {
    throw new Error('local runtime mission objective does not match the commissioned task');
  }
  if (!same(localState.budget, expected.budget)) {
    throw new Error('local runtime mission budget does not match the commissioned task');
  }
  if (!same(localState.resources, expected.resources)) {
    throw new Error('local runtime mission resources do not match the commission');
  }
  if (!same(localState.completion, expected.completion ?? { requireCheckpoint: true, requireReview: true })) {
    throw new Error('local runtime completion policy does not match the commission');
  }
}

function terminalObservation(
  state: NoriqMissionCoordinatorState,
  task: NoriqCoordinatorTaskState,
  localState: MissionState,
): NoriqCoordinatorControlObservation {
  if (!state.commission || !task.budget || !localState.terminal) {
    throw new Error('terminal observation requires commission, budget, and terminal local state');
  }
  const usage = localState.usage;
  const accounted = addTerminalUsage(state.cumulativeUsage, task.budget, usage, state.commission.budget);
  const handoff = localState.acceptedRevisionHandoff;
  let settlementOutcome: 'done' | 'failed' | 'cancelled';
  let settlementReason: string | null;
  if (localState.terminal.outcome === 'cancelled') {
    settlementOutcome = 'cancelled';
    settlementReason = bounded(state.cancelReason ?? localState.terminal.reason);
  } else if (localState.terminal.outcome === 'failed') {
    settlementOutcome = 'failed';
    settlementReason = bounded(localState.terminal.reason);
  } else if (accounted.error) {
    settlementOutcome = 'failed';
    settlementReason = bounded(`mission budget accounting failed closed: ${accounted.error}`);
  } else if (!handoff) {
    settlementOutcome = 'failed';
    settlementReason = 'successful local mission lacks a durable accepted revision handoff';
  } else if (handoff.repositoryKey !== state.commission.repositoryKey) {
    settlementOutcome = 'failed';
    settlementReason = 'accepted revision handoff repository does not match the commission';
  } else {
    settlementOutcome = 'done';
    settlementReason = null;
  }
  return {
    kind: 'terminal',
    usage,
    localOutcome: localState.terminal.outcome,
    reason: bounded(localState.terminal.reason),
    handoff,
    settlementOutcome,
    settlementReason,
    cumulativeUsage: accounted.cumulative,
  };
}

function observationFromStop(
  state: NoriqMissionCoordinatorState,
  task: NoriqCoordinatorTaskState,
  stop: MissionHarnessStop,
): NoriqCoordinatorControlObservation {
  assertLocalMissionAuthority(state, task, stop.state);
  if (stop.state.terminal) return terminalObservation(state, task, stop.state);
  if (stop.reason === 'human-question') {
    const durableQuestion = stop.state.questions[stop.question.questionId];
    if (!durableQuestion || durableQuestion.status !== 'pending' || !same(durableQuestion, stop.question)) {
      throw new Error('local runtime question does not match the exact durable mission question');
    }
    return {
      kind: 'human-question',
      usage: stop.state.usage,
      questionId: stop.question.questionId,
      prompt: stop.question.prompt,
    };
  }
  if (stop.reason === 'runtime-error') {
    return { kind: 'runtime-error', usage: stop.state.usage, error: bounded(stop.error) };
  }
  throw new Error('terminal harness stop did not carry terminal mission state');
}

function validateBeginAck(task: NoriqCoordinatorTaskState, value: MissionTaskAck): MissionTaskAck {
  if (!task.beginReport || !task.attemptId) throw new Error('begin report is not durable');
  const ack = MissionTaskAckSchema.parse(value);
  if (
    ack.phase !== 'begin' ||
    ack.reportId !== task.beginReport.reportId ||
    ack.attemptId !== task.attemptId
  ) {
    throw new Error('Noriq begin acknowledgement does not match the exact durable report');
  }
  if (ack.accepted && (ack.taskId !== task.task.taskId || !ack.claimId || !ack.executionId)) {
    throw new Error('Noriq accepted begin acknowledgement is incomplete or mismatched');
  }
  return ack;
}

function validateSettleAck(task: NoriqCoordinatorTaskState, value: MissionTaskAck): MissionTaskAck {
  if (!task.settleReport || !task.beginAck || !task.attemptId) {
    throw new Error('settle report is not durable');
  }
  const ack = MissionTaskAckSchema.parse(value);
  if (
    ack.phase !== 'settle' ||
    ack.reportId !== task.settleReport.reportId ||
    ack.attemptId !== task.attemptId
  ) {
    throw new Error('Noriq settle acknowledgement does not match the exact durable report');
  }
  if (
    ack.accepted &&
    (ack.taskId !== task.task.taskId ||
      ack.claimId !== task.beginAck.claimId ||
      ack.executionId !== task.beginAck.executionId)
  ) {
    throw new Error('Noriq accepted settle acknowledgement is incomplete or mismatched');
  }
  return ack;
}

/**
 * Deterministic authority coordinator above LocalMissionRuntime.
 *
 * Noriq sees one admitted attempt per commissioned task. The local guide, planner, builders,
 * reviewers and repair children remain private implementation details of that one task mission.
 */
export class NoriqMissionCoordinator {
  private readonly store: JsonlNoriqCoordinatorStore;
  private readonly transport: NoriqMissionCoordinatorTransport;
  private readonly resolveRuntime: NoriqMissionRuntimeResolver;
  private readonly now: () => Date;
  private readonly runtimeCache = new Map<string, Promise<ResolvedNoriqMissionRuntime>>();
  private readonly releasePromises = new Map<string, Promise<void>>();
  private readonly authorizedRoots = new Set<string>();
  private readonly activeControls = new Map<string, ActiveNoriqRootControl>();

  constructor(options: NoriqMissionCoordinatorOptions) {
    this.store = options.store;
    this.transport = options.transport;
    this.resolveRuntime = options.resolveRuntime;
    this.now = options.now ?? (() => new Date());
  }

  private async load(rootRunId: string): Promise<NoriqMissionCoordinatorState> {
    return stateFromHistory(await this.store.load(rootRunId));
  }

  private startInterrupt(active: ActiveNoriqRootControl, reason: string): void {
    if (!active.interrupt || active.interruptResult) return;
    const result = active.interrupt(reason);
    active.interruptResult = result;
    void result.then(active.resolveInterrupt, active.rejectInterrupt);
  }

  private startSuspend(active: ActiveNoriqRootControl, reason: string): void {
    if (!active.suspend || active.suspendResult) return;
    const result = active.suspend(reason);
    active.suspendResult = result;
    void result.then(active.resolveSuspend, active.rejectSuspend);
  }

  /**
   * Revoke one transport-generation grant and stop its in-process model/tool tree without writing
   * cancellation or releasing VCS/profile authority. The active controller yields before return.
   */
  async quarantine(rootRunId: string, reason: string): Promise<void> {
    const safeReason = bounded(reason);
    this.authorizedRoots.delete(rootRunId);
    const active = this.activeControls.get(rootRunId);
    if (active) {
      active.pendingSuspend = safeReason;
      this.startSuspend(active, safeReason);
      const stop = await active.promise;
      if (stop.reason === 'runtime-error') {
        throw new Error(`mission transport quiesce failed: ${stop.error}`);
      }
      return;
    }
    const state = await this.load(rootRunId);
    const task = state.tasks.find(
      (candidate) => candidate.missionCreated && candidate.observation?.kind !== 'terminal',
    );
    const pending = state.commission ? this.runtimeCache.get(state.commission.commissionDigest) : undefined;
    if (task?.missionId && pending) {
      const runtime = (await pending).runtime;
      await runtime.quiesceMission?.(task.missionId, safeReason);
    }
  }

  /** Revoke every nonterminal root owned by this process. Used synchronously on socket loss. */
  async quarantineAll(reason: string): Promise<void> {
    const roots = await this.reservedRootRunIds();
    const results = await Promise.allSettled(roots.map((rootRunId) => this.quarantine(rootRunId, reason)));
    const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
    if (failures.length > 0) {
      throw new AggregateError(failures, 'one or more active missions could not be quiesced');
    }
  }

  private requireCurrentAuthority(rootRunId: string): void {
    if (!this.authorizedRoots.has(rootRunId)) {
      throw new Error(
        `recovered mission '${rootRunId}' is quarantined until an exact next-epoch server adoption`,
      );
    }
  }

  private async append(
    state: NoriqMissionCoordinatorState,
    actionId: string,
    action: NoriqCoordinatorAction,
  ): Promise<NoriqMissionCoordinatorState> {
    try {
      const result = await this.store.append(state.rootRunId, state.revision, actionId, action);
      return stateFromHistory(result.history);
    } catch (error) {
      if (!(error instanceof NoriqCoordinatorConflictError) || error.kind !== 'revision') throw error;
      const current = await this.load(state.rootRunId);
      const result = await this.store.append(current.rootRunId, current.revision, actionId, action);
      return stateFromHistory(result.history);
    }
  }

  private async fail(
    state: NoriqMissionCoordinatorState,
    reason: string,
  ): Promise<NoriqMissionCoordinatorState> {
    if (state.failureReason) return state;
    const boundedReason = bounded(reason);
    return this.append(state, `coordinator-failed:${digest(boundedReason)}`, {
      type: 'coordinator-failed',
      reason: boundedReason,
    });
  }

  async commission(input: NoriqMissionCommission): Promise<NoriqMissionCoordinatorState> {
    const commission = validateNoriqMissionCommission(input);
    const controller = await this.store.acquireController(commission.rootRunId);
    try {
      const state = await this.load(commission.rootRunId);
      if (state.commission) {
        if (!same(state.commission, commission)) {
          throw new NoriqCoordinatorConflictError(
            'action',
            `root run '${commission.rootRunId}' already has a different immutable commission`,
          );
        }
        return state;
      }
      const created = await this.append(
        state,
        'commission',
        NoriqCoordinatorActionSchema.parse({ type: 'commissioned', commission }),
      );
      this.authorizedRoots.add(commission.rootRunId);
      return created;
    } finally {
      await controller.release();
    }
  }

  /** Read-only durable inspection. This method never resolves a runtime or launches a model. */
  inspect(rootRunId: string): Promise<NoriqMissionCoordinatorState> {
    return this.load(rootRunId);
  }

  /** Read-only complete coordinator state; any corrupt WAL fails the whole result. */
  async inspectAll(): Promise<readonly NoriqMissionCoordinatorState[]> {
    const states: NoriqMissionCoordinatorState[] = [];
    for (const rootRunId of await this.store.listRootRunIds()) states.push(await this.load(rootRunId));
    return deepFreeze(states);
  }

  /** Read-only roots whose durable coordinator state still reserves daemon/runtime authority. */
  async reservedRootRunIds(): Promise<readonly string[]> {
    const states = await this.inspectAll();
    return Object.freeze(
      states.filter((state) => !isNoriqMissionCoordinatorTerminal(state)).map((state) => state.rootRunId),
    );
  }

  /**
   * Process shutdown only. Quiesce each runtime already resolved by this coordinator, then wait
   * for its controller to yield; never resolve a new profile and never write cancellation.
   * Authority is revoked synchronously before the first await. Active controls receive the same
   * per-root suspend barrier used on transport loss, which closes the race where a control passed
   * its authorization check but had not yet populated `runtimeCache` when shutdown began.
   */
  async quiesce(): Promise<void> {
    const reason = 'Runner daemon is shutting down';
    this.authorizedRoots.clear();
    const active = [...this.activeControls.values()];
    for (const control of active) {
      control.pendingSuspend = reason;
      this.startSuspend(control, reason);
    }
    const resolved = [...this.runtimeCache.values()];
    const results = await Promise.allSettled(
      resolved.map(async (pending) => {
        const runtime = (await pending).runtime;
        await runtime.quiesce?.(reason);
      }),
    );
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    const controlResults = await Promise.allSettled(active.map((control) => control.promise));
    const controlRejected = controlResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (controlRejected) throw controlRejected.reason;
  }

  /** Read-only reconciliation inventory built solely from accepted begin acknowledgements. */
  async inventory(rootRunId: string): Promise<MissionInventoryItem> {
    const state = await this.load(rootRunId);
    if (!state.commission || !state.lease) throw new Error(`root run '${rootRunId}' is not commissioned`);
    return deepFreeze({
      runId: rootRunId,
      lease: state.lease,
      attempts: state.tasks.flatMap((task) =>
        task.beginAck?.accepted === true &&
        task.settleAck?.accepted !== true &&
        task.attemptId &&
        task.beginAck.executionId
          ? [
              {
                attemptId: task.attemptId,
                executionId: task.beginAck.executionId,
                epoch: state.lease?.epoch ?? 0,
              },
            ]
          : [],
      ),
    });
  }

  /** Read-only complete inventory for startup/reconciliation; never resolves or launches runtime. */
  async inventoryAll(): Promise<readonly MissionInventoryItem[]> {
    const rootRunIds = await this.reservedRootRunIds();
    if (rootRunIds.length > MAX_NORIQ_RECONCILIATION_ROOTS) {
      throw new Error(
        `active mission inventory exceeds the ${MAX_NORIQ_RECONCILIATION_ROOTS}-root wire bound`,
      );
    }
    const inventory: MissionInventoryItem[] = [];
    for (const rootRunId of rootRunIds) inventory.push(await this.inventory(rootRunId));
    return deepFreeze(inventory);
  }

  /**
   * Apply server reconciliation without waiting behind the old transport generation's controller.
   * The per-root WAL writer is the CAS/fencing boundary. A non-adopt result first quiesces this
   * process; an adopt result must advance exactly one epoch before model authority is restored.
   */
  async adopt(resultInput: MissionAdoptionResult): Promise<NoriqMissionCoordinatorState> {
    const result = MissionAdoptionResultSchema.parse(resultInput);
    let state = await this.load(result.runId);
    if (!state.commission || !state.lease) throw new Error(`root run '${result.runId}' is not commissioned`);
    if (result.decision === 'unknown') {
      // Unknown is absence of authority, never authority to destroy. Preserve the WAL/workspace,
      // and prove current in-process model/tool work has stopped before returning.
      await this.quarantine(result.runId, result.reason ?? 'server could not establish mission authority');
      return this.load(result.runId);
    }
    if (result.decision !== 'adopt') {
      await this.quarantine(
        result.runId,
        result.reason ?? `server reconciliation decided ${result.decision}`,
      );
      state = await this.load(result.runId);
      if (state.serverDisposition) {
        if (
          state.serverDisposition.decision !== result.decision ||
          state.serverDisposition.reason !== result.reason
        ) {
          throw new NoriqCoordinatorConflictError(
            'action',
            `server disposition for '${result.runId}' conflicts with durable retirement`,
          );
        }
        await this.releaseRuntime(state);
        return state;
      }
      const task = state.tasks.find(
        (candidate) => candidate.missionCreated && candidate.observation?.kind !== 'terminal',
      );
      if (task?.missionId) {
        const commission = state.commission;
        if (!commission) throw new Error('coordinator commission disappeared during retirement');
        const runtime = await this.runtimeFor(commission);
        runtime.resumeMission?.(task.missionId);
        await runtime.cancel(
          task.missionId,
          bounded(result.reason ?? `server reconciliation decided ${result.decision}`),
        );
      }
      state = await this.append(state, `server-disposition:${result.decision}`, {
        type: 'server-disposition-recorded',
        decision: result.decision,
        reason: result.reason,
      });
      await this.releaseRuntime(state);
      return state;
    }
    if (!result.lease) throw new Error(`server adoption for '${result.runId}' omitted its lease`);
    if (same(result.lease, state.lease)) {
      if (state.adoptionCount === 0)
        throw new Error('first server adoption must advance the root lease epoch');
      if (!this.authorizedRoots.has(result.runId)) {
        throw new Error('recovered mission requires a fresh next-epoch server adoption');
      }
      return state;
    }
    if (
      result.lease.sitting !== state.lease.sitting ||
      result.lease.executionId !== state.lease.executionId ||
      result.lease.epoch !== state.lease.epoch + 1
    ) {
      throw new Error('server adoption does not name the exact next root lease epoch');
    }
    const attempts = liveAttemptIds(state);
    state = await this.append(state, `adopt:${state.lease.epoch}:${result.lease.epoch}`, {
      type: 'lease-adopted',
      previousLease: state.lease,
      lease: result.lease,
      liveAttemptIds: [...attempts],
    });
    const task = state.tasks.find(
      (candidate) => candidate.missionCreated && candidate.observation?.kind !== 'terminal',
    );
    if (task?.missionId && state.commission) {
      const pending = this.runtimeCache.get(state.commission.commissionDigest);
      if (pending) (await pending).runtime.resumeMission?.(task.missionId);
    }
    this.authorizedRoots.add(result.runId);
    return state;
  }

  private async resolvedRuntimeFor(commission: NoriqMissionCommission): Promise<ResolvedNoriqMissionRuntime> {
    let pending = this.runtimeCache.get(commission.commissionDigest);
    if (!pending) {
      pending = this.resolveRuntime({
        executionProfile: commission.executionProfile,
        repositoryKey: commission.repositoryKey,
      }).then(async (resolved) => {
        try {
          if (!same(resolved.executionProfile, commission.executionProfile)) {
            throw new Error('runtime resolver did not echo the exact commissioned execution profile');
          }
          if (resolved.repositoryKey !== commission.repositoryKey) {
            throw new Error('runtime resolver did not echo the exact commissioned repository key');
          }
          if (resolved.runtime.catalog.fingerprint !== commission.catalogFingerprint) {
            throw new Error('resolved runtime catalog fingerprint does not match the commission');
          }
          if (!same(resolved.runtime.resources, commission.resources)) {
            throw new Error('resolved runtime resources do not match the commission');
          }
          const budgetError = commissionFitsLocalBudget(commission.budget, resolved.missionBudget);
          if (budgetError) throw new Error(budgetError);
          return resolved;
        } catch (validationError) {
          try {
            await resolved.release?.();
          } catch (releaseError) {
            throw new Error(
              `${errorText(validationError)}; invalid runtime reservation release failed: ${errorText(releaseError)}`,
            );
          }
          throw validationError;
        }
      });
      this.runtimeCache.set(commission.commissionDigest, pending);
      pending.catch(() => this.runtimeCache.delete(commission.commissionDigest));
    }
    return pending;
  }

  private async runtimeFor(commission: NoriqMissionCommission): Promise<NoriqMissionRuntime> {
    return (await this.resolvedRuntimeFor(commission)).runtime;
  }

  private async releaseRuntime(state: NoriqMissionCoordinatorState): Promise<void> {
    if (!state.commission) return;
    const existing = this.releasePromises.get(state.rootRunId);
    if (existing) return existing;
    const pending = this.runtimeCache.get(state.commission.commissionDigest);
    if (!pending) {
      this.releasePromises.set(state.rootRunId, Promise.resolve());
      return;
    }
    const release = pending.then(async (resolved) => {
      await resolved.release?.();
      this.runtimeCache.delete(state.commission?.commissionDigest ?? '');
    });
    // Retain even a rejected promise. Re-invoking an opaque release callback after it threw could
    // double-release capacity; later callers observe the same failure and operator intervention is
    // required instead of silently claiming cleanup succeeded.
    this.releasePromises.set(state.rootRunId, release);
    return release;
  }

  private async finalizeStop(stop: NoriqMissionCoordinatorStop): Promise<NoriqMissionCoordinatorStop> {
    if (stop.reason === 'completed' || stop.reason === 'cancelled' || stop.reason === 'failed') {
      try {
        await this.releaseRuntime(stop.state);
      } catch (error) {
        return {
          reason: 'runtime-error',
          state: stop.state,
          error: `execution-profile reservation release failed: ${errorText(error)}`,
        };
      }
    }
    return stop;
  }

  private async prepareTask(
    state: NoriqMissionCoordinatorState,
    taskIndex: number,
  ): Promise<NoriqMissionCoordinatorState> {
    if (!state.commission) throw new Error('coordinator is not commissioned');
    const task = state.tasks[taskIndex];
    if (!task) throw new Error(`unknown task index ${taskIndex}`);
    if (task.beginReport) return state;
    const remaining = remainingBudget(state.commission.budget, state.cumulativeUsage);
    if (!remaining.budget)
      return this.fail(state, `cannot start task '${task.task.taskId}': ${remaining.error}`);
    const identity = deterministicTaskIdentity(state.commission, taskIndex);
    const report: MissionTaskBeginReport = {
      reportId: `nmb_${digest({ attemptId: identity.attemptId, phase: 'begin' }).slice(0, 56)}`,
      attemptId: identity.attemptId,
      taskId: task.task.taskId,
      childKey: task.task.childKey,
      observedAt: this.now().toISOString(),
    };
    return this.append(state, `prepare:${identity.attemptId}`, {
      type: 'task-prepared',
      taskIndex,
      missionId: identity.missionId,
      attemptId: identity.attemptId,
      baseRevision: currentBaseRevision(state, taskIndex),
      budget: {
        tokens: remaining.budget.tokens as number,
        usd: remaining.budget.usd,
        activeSeconds: remaining.budget.activeSeconds as number,
      },
      beginReport: report,
    });
  }

  private async ensureBegin(
    state: NoriqMissionCoordinatorState,
    taskIndex: number,
  ): Promise<{ state: NoriqMissionCoordinatorState; error: string | null }> {
    const task = state.tasks[taskIndex];
    if (!task?.beginReport || !task.attemptId || !state.lease) throw new Error('task is not prepared');
    if (task.beginAck) return { state, error: null };
    let ack: MissionTaskAck;
    try {
      ack = validateBeginAck(
        task,
        await this.transport.begin(state.rootRunId, state.lease, task.beginReport),
      );
    } catch (error) {
      return { state, error: errorText(error) };
    }
    const acknowledged = await this.append(state, `begin-ack:${task.attemptId}`, {
      type: 'task-begin-acknowledged',
      taskIndex,
      ack,
    });
    return { state: acknowledged, error: null };
  }

  private async ensureLocalMission(
    state: NoriqMissionCoordinatorState,
    taskIndex: number,
    runtime: NoriqMissionRuntime,
  ): Promise<NoriqMissionCoordinatorState> {
    const task = state.tasks[taskIndex];
    if (!task || !state.commission) throw new Error('task is unavailable');
    if (task.missionCreated) return state;
    const request = createRequest(state.commission, task);
    const created = await runtime.create(request);
    if (!created.accepted) throw new Error(`local mission creation was refused: ${created.reason}`);
    assertLocalMissionAuthority(state, task, created.state);
    return this.append(state, `mission-created:${task.missionId}`, {
      type: 'task-mission-created',
      taskIndex,
    });
  }

  private async observeControl(
    state: NoriqMissionCoordinatorState,
    taskIndex: number,
    stop: MissionHarnessStop,
  ): Promise<NoriqMissionCoordinatorState> {
    const task = state.tasks[taskIndex];
    if (!task) throw new Error('task is unavailable');
    const observation = observationFromStop(state, task, stop);
    return this.append(state, `observe:${taskIndex}:${digest(observation)}`, {
      type: 'task-control-observed',
      taskIndex,
      observation,
    });
  }

  private async driveRuntime(
    state: NoriqMissionCoordinatorState,
    taskIndex: number,
    runtime: NoriqMissionRuntime,
  ): Promise<{ state: NoriqMissionCoordinatorState; error: string | null }> {
    const task = state.tasks[taskIndex];
    if (!task?.missionId) throw new Error('task local mission identity is unavailable');
    if (task.observation?.kind === 'terminal') return { state, error: null };
    let stop: MissionHarnessStop;
    try {
      if (task.observation?.kind === 'human-question') {
        const answer = task.preparedAnswers[task.observation.questionId];
        if (answer === undefined) return { state, error: null };
        stop = await runtime.answerAndContinue(task.missionId, task.observation.questionId, answer);
      } else {
        stop = await runtime.control(task.missionId);
      }
    } catch (error) {
      return { state, error: errorText(error) };
    }
    return { state: await this.observeControl(state, taskIndex, stop), error: null };
  }

  private async prepareSettle(
    state: NoriqMissionCoordinatorState,
    taskIndex: number,
  ): Promise<NoriqMissionCoordinatorState> {
    const task = state.tasks[taskIndex];
    if (
      !task?.attemptId ||
      !task.beginAck?.accepted ||
      !task.beginAck.claimId ||
      task.observation?.kind !== 'terminal'
    ) {
      throw new Error('task is not ready to settle');
    }
    if (task.settleReport) return state;
    const report: MissionTaskSettleReport = {
      reportId: `nms_${digest({ attemptId: task.attemptId, phase: 'settle' }).slice(0, 56)}`,
      attemptId: task.attemptId,
      claimId: task.beginAck.claimId,
      outcome: task.observation.settlementOutcome,
      reason: task.observation.settlementReason,
      observedAt: this.now().toISOString(),
    };
    return this.append(state, `settle-prepare:${task.attemptId}`, {
      type: 'task-settle-prepared',
      taskIndex,
      report,
    });
  }

  private async ensureSettle(
    state: NoriqMissionCoordinatorState,
    taskIndex: number,
  ): Promise<{ state: NoriqMissionCoordinatorState; error: string | null }> {
    const task = state.tasks[taskIndex];
    if (!task?.settleReport || !task.attemptId || !state.lease) throw new Error('settlement is not prepared');
    if (task.settleAck) return { state, error: null };
    let ack: MissionTaskAck;
    try {
      ack = validateSettleAck(
        task,
        await this.transport.settle(state.rootRunId, state.lease, task.settleReport),
      );
    } catch (error) {
      return { state, error: errorText(error) };
    }
    const acknowledged = await this.append(state, `settle-ack:${task.attemptId}`, {
      type: 'task-settle-acknowledged',
      taskIndex,
      ack,
    });
    return { state: acknowledged, error: null };
  }

  private async driveLocked(
    rootRunId: string,
    active?: ActiveNoriqRootControl,
  ): Promise<NoriqMissionCoordinatorStop> {
    let state = await this.load(rootRunId);
    if (!state.commission || !state.lease) throw new Error(`root run '${rootRunId}' is not commissioned`);
    while (true) {
      const terminal = coordinatorTerminalStop(state);
      if (terminal) return terminal;
      if (!this.authorizedRoots.has(rootRunId) || active?.pendingSuspend) {
        if (active?.suspendResult) await active.suspendOutcome;
        return {
          reason: 'quarantined',
          state: await this.load(rootRunId),
          error: active?.pendingSuspend ?? 'mission transport generation is not authorized',
        };
      }
      const taskIndex = successfulSettles(state);
      const existingTask = state.tasks[taskIndex];
      if (!existingTask) {
        state = await this.fail(state, 'all tasks settled but no accepted revision handoff is available');
        return { reason: 'failed', state, error: state.failureReason ?? 'coordinator failed' };
      }
      state = await this.prepareTask(state, taskIndex);
      if (state.failureReason) return { reason: 'failed', state, error: state.failureReason };

      const begun = await this.ensureBegin(state, taskIndex);
      state = begun.state;
      if (begun.error) return { reason: 'transport-error', state, error: begun.error };
      const begunTask = state.tasks[taskIndex];
      if (begunTask?.beginAck?.accepted !== true) {
        return (
          coordinatorTerminalStop(state) ?? {
            reason: 'failed',
            state,
            error: begunTask?.beginAck?.error ?? 'Noriq refused task begin',
          }
        );
      }
      if (!this.authorizedRoots.has(rootRunId) || active?.pendingSuspend) {
        return {
          reason: 'quarantined',
          state: await this.load(rootRunId),
          error: active?.pendingSuspend ?? 'mission transport generation ended after task admission',
        };
      }

      let runtime: NoriqMissionRuntime;
      try {
        if (!state.commission) throw new Error('coordinator commission disappeared');
        runtime = await this.runtimeFor(state.commission);
        state = await this.ensureLocalMission(state, taskIndex, runtime);
        // Cancellation may commit through the independent coordinator writer while this root
        // holds its long-lived controller lease. Refresh before crossing into model control.
        state = await this.load(rootRunId);
      } catch (error) {
        return { reason: 'runtime-error', state, error: errorText(error) };
      }

      const taskBeforeControl = state.tasks[taskIndex];
      if (!taskBeforeControl) throw new Error('task disappeared');
      if (!taskBeforeControl.missionId) throw new Error('task mission identity is unavailable');
      if (taskBeforeControl.observation?.kind !== 'terminal') {
        if (active) {
          active.interrupt = (reason) => runtime.cancel(taskBeforeControl.missionId as string, reason);
          active.suspend = async (reason) => {
            if (!runtime.quiesceMission) {
              throw new Error('resolved mission runtime cannot quiesce one transport-owned mission');
            }
            await runtime.quiesceMission(taskBeforeControl.missionId as string, reason);
          };
          if (active.pendingCancel && !active.interruptResult) {
            this.startInterrupt(active, active.pendingCancel);
          }
          if (active.pendingSuspend && !active.suspendResult) {
            this.startSuspend(active, active.pendingSuspend);
          }
        }
        try {
          if (!this.authorizedRoots.has(rootRunId) || active?.pendingSuspend) {
            if (active?.suspendResult) await active.suspendOutcome;
            return {
              reason: 'quarantined',
              state: await this.load(rootRunId),
              error: active?.pendingSuspend ?? 'mission transport generation ended before model control',
            };
          }
          if (state.cancelReason) {
            const cancelStop =
              active?.interruptResult ?? runtime.cancel(taskBeforeControl.missionId, state.cancelReason);
            state = await this.observeControl(state, taskIndex, await cancelStop);
          } else if (active) {
            const controlStop = runtime.control(taskBeforeControl.missionId);
            let stop = await Promise.race([controlStop, active.interruptOutcome]);
            if (active.pendingSuspend || !this.authorizedRoots.has(rootRunId)) {
              this.startSuspend(
                active,
                active.pendingSuspend ?? 'mission transport generation ended during model control',
              );
              await active.suspendOutcome;
              return {
                reason: 'quarantined',
                state: await this.load(rootRunId),
                error: active.pendingSuspend ?? 'mission transport generation ended during model control',
              };
            }
            // Close the small race where normal control settled while cancellation was committing:
            // a durable cancel fact wins even if its runtime.cancel promise was attached just after
            // the race selected controlStop.
            const refreshed = await this.load(rootRunId);
            if (refreshed.cancelReason) {
              this.startInterrupt(active, refreshed.cancelReason);
              stop = await active.interruptOutcome;
              state = refreshed;
            }
            state = await this.observeControl(state, taskIndex, stop);
          } else {
            const driven = await this.driveRuntime(state, taskIndex, runtime);
            state = driven.state;
            if (driven.error) return { reason: 'runtime-error', state, error: driven.error };
          }
        } catch (error) {
          return { reason: 'runtime-error', state, error: errorText(error) };
        } finally {
          if (active) {
            active.interrupt = null;
            active.suspend = null;
          }
        }
      }

      const observedTask = state.tasks[taskIndex];
      if (observedTask?.observation?.kind === 'human-question') {
        const answer = observedTask.preparedAnswers[observedTask.observation.questionId];
        if (answer !== undefined) continue;
        return {
          reason: 'human-question',
          state,
          taskId: observedTask.task.taskId,
          questionId: observedTask.observation.questionId,
          prompt: observedTask.observation.prompt,
        };
      }
      if (observedTask?.observation?.kind === 'runtime-error') {
        return { reason: 'runtime-error', state, error: observedTask.observation.error };
      }
      if (observedTask?.observation?.kind !== 'terminal') {
        return { reason: 'runtime-error', state, error: 'local mission produced no durable stop' };
      }

      state = await this.prepareSettle(state, taskIndex);
      const settled = await this.ensureSettle(state, taskIndex);
      state = settled.state;
      if (settled.error) return { reason: 'transport-error', state, error: settled.error };
      const afterSettle = coordinatorTerminalStop(state);
      if (afterSettle) return afterSettle;
      const accepted = state.tasks[taskIndex]?.settleAck;
      if (accepted?.accepted !== true) {
        return { reason: 'failed', state, error: accepted?.error ?? 'Noriq refused task settlement' };
      }
    }
  }

  /** Run the exact commissioned sequence while holding the one local root controller lease. */
  control(rootRunId: string): Promise<NoriqMissionCoordinatorStop> {
    const existing = this.activeControls.get(rootRunId);
    if (existing) return existing.promise;
    const active: ActiveNoriqRootControl = {
      promise: Promise.resolve(null as never),
      pendingCancel: null,
      interrupt: null,
      interruptResult: null,
      interruptOutcome: Promise.resolve(null as never),
      resolveInterrupt: () => undefined,
      rejectInterrupt: () => undefined,
      pendingSuspend: null,
      suspend: null,
      suspendResult: null,
      suspendOutcome: Promise.resolve(),
      resolveSuspend: () => undefined,
      rejectSuspend: () => undefined,
    };
    active.interruptOutcome = new Promise<MissionHarnessStop>((resolve, reject) => {
      active.resolveInterrupt = resolve;
      active.rejectInterrupt = reject;
    });
    active.suspendOutcome = new Promise<void>((resolve, reject) => {
      active.resolveSuspend = resolve;
      active.rejectSuspend = reject;
    });
    const promise = Promise.resolve().then(async () => {
      const controller = await this.store.acquireController(rootRunId);
      try {
        const durable = await this.load(rootRunId);
        const terminal = coordinatorTerminalStop(durable);
        if (terminal) return await this.finalizeStop(terminal);
        if (!this.authorizedRoots.has(rootRunId)) {
          return {
            reason: 'quarantined' as const,
            state: durable,
            error: 'mission transport generation is not authorized',
          };
        }
        return await this.finalizeStop(await this.driveLocked(rootRunId, active));
      } finally {
        await controller.release();
      }
    });
    active.promise = promise;
    this.activeControls.set(rootRunId, active);
    void promise.then(
      () => {
        if (this.activeControls.get(rootRunId) === active) this.activeControls.delete(rootRunId);
      },
      () => {
        if (this.activeControls.get(rootRunId) === active) this.activeControls.delete(rootRunId);
      },
    );
    return promise;
  }

  /** Persist an exact answer before allowing the local mission to consume it and resume. */
  async answer(rootRunId: string, questionId: string, answer: string): Promise<NoriqMissionCoordinatorStop> {
    if (typeof answer !== 'string' || answer.length === 0 || answer.length > MAX_ANSWER_CHARS) {
      throw new TypeError(`answer must contain 1..${MAX_ANSWER_CHARS} characters`);
    }
    const controller = await this.store.acquireController(rootRunId);
    try {
      let state = await this.load(rootRunId);
      this.requireCurrentAuthority(rootRunId);
      const taskIndex = successfulSettles(state);
      const task = state.tasks[taskIndex];
      if (task?.observation?.kind !== 'human-question' || task.observation.questionId !== questionId) {
        throw new Error(`question '${questionId}' is not the current durable mission question`);
      }
      const previous = task.preparedAnswers[questionId];
      if (previous !== undefined && previous !== answer) {
        throw new NoriqCoordinatorConflictError(
          'action',
          `question '${questionId}' already has another answer`,
        );
      }
      if (previous === undefined) {
        state = await this.append(state, `answer:${taskIndex}:${questionId}`, {
          type: 'task-answer-prepared',
          taskIndex,
          questionId,
          answer,
        });
      }
      return await this.finalizeStop(await this.driveLocked(state.rootRunId));
    } finally {
      await controller.release();
    }
  }

  /** Persist cancellation, cancel the admitted local mission, then settle the server attempt. */
  async cancel(rootRunId: string, reason: string): Promise<NoriqMissionCoordinatorStop> {
    if (typeof reason !== 'string' || reason.length === 0) throw new TypeError('cancel reason is required');
    const safeReason = bounded(reason);
    const active = this.activeControls.get(rootRunId);
    if (active) {
      let state = await this.load(rootRunId);
      const terminal = coordinatorTerminalStop(state);
      if (terminal) return this.finalizeStop(terminal);
      this.requireCurrentAuthority(rootRunId);
      if (state.cancelReason && state.cancelReason !== safeReason) {
        throw new NoriqCoordinatorConflictError('action', 'mission already has another cancel reason');
      }
      if (!state.cancelReason) {
        state = await this.append(state, 'cancel', { type: 'cancel-requested', reason: safeReason });
      }
      active.pendingCancel = state.cancelReason ?? safeReason;
      if (active.interrupt && !active.interruptResult) {
        this.startInterrupt(active, active.pendingCancel);
      }
      return active.promise;
    }
    const controller = await this.store.acquireController(rootRunId);
    try {
      let state = await this.load(rootRunId);
      const terminal = coordinatorTerminalStop(state);
      if (terminal) return terminal;
      this.requireCurrentAuthority(rootRunId);
      if (state.cancelReason && state.cancelReason !== safeReason) {
        throw new NoriqCoordinatorConflictError('action', 'mission already has another cancel reason');
      }
      if (!state.cancelReason) {
        state = await this.append(state, 'cancel', { type: 'cancel-requested', reason: safeReason });
      }
      return await this.finalizeStop(await this.driveLocked(state.rootRunId));
    } finally {
      await controller.release();
    }
  }
}

export { computeNoriqMissionCommissionDigest, validateNoriqMissionCommission };
export type { NoriqMissionCommission, NoriqMissionTaskSnapshot, MissionAcceptedRevisionHandoffState };
