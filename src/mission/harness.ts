import { createHash, randomUUID } from 'node:crypto';
import { renderPrompt } from '../prompts';
import { unresolvedActiveMissionPlan } from './decide';
import {
  type MissionExternalResourceCoordinator,
  isExternalMissionResourceKey,
} from './global-resource-coordinator';
import {
  MISSION_GUIDE_ACTION_SCHEMA,
  parseMissionGuideEnvelope,
  translateMissionGuideAction,
} from './guide-protocol';
import { type MissionDispatchResult, MissionKernel } from './kernel';
import {
  type MissionCheckpointState,
  type MissionChildState,
  type MissionQuestionState,
  type MissionState,
  childIsTerminal,
  governingReviewForCheckpoint,
  latestCheckpoint,
  missionChildrenInOrder,
  ownMissionValue,
  unreconciledTerminalWriteChild,
  workspaceReconciliationForChild,
} from './model';
import { missionPlanChildId, missionPlanStepKey } from './plan-identity';
import { type MissionGuideProjection, projectMissionForGuide } from './projection';
import type {
  BeginValidationAction,
  MissionAction,
  MissionActionEnvelope,
  MissionChildArtifact,
  MissionGuideProfile,
  MissionGuideProposal,
  MissionUsage,
  MissionValidationPolicy,
  RecordAcceptedRevisionHandoffAction,
  RecordCheckpointAction,
  RecordReviewAction,
  RecordValidationAction,
  RecordWorkspaceReconciledAction,
} from './protocol';
import { MAX_MISSION_PLAN_REPAIR_ROUNDS, MAX_MISSION_VALIDATION_OUTPUT_BYTES } from './protocol';
import {
  MissionControllerBusyError,
  MissionJournalLimitError,
  type MissionStore,
  MissionStoreConflictError,
  canonicalMissionJson,
} from './store';

const MAX_GUIDE_OUTPUT_CHARS = 60_000;
const MAX_RESULT_SUMMARY_CHARS = 64_000;
const DEFAULT_CANCEL_GRACE_MS = 30_000;
const DEFAULT_DURABLE_POLL_MS = 250;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_CANCEL_COMMIT_ATTEMPTS = 8;
const MAX_CONSECUTIVE_GUIDE_REPAIR_TURNS = 3;

export interface MissionGuideRequest {
  projection: MissionGuideProjection;
  /** Durable authority snapshot; adapters validate it locally and never render it to the model. */
  profile: MissionGuideProfile;
  actionSchema: string;
  prompt: string;
  signal: AbortSignal;
}

export interface MissionGuideResult {
  /** Exactly one JSON envelope on success. */
  output: string;
  /** Total usage for this invocation, not a delta from a retained vendor session. */
  usage: MissionUsage;
}

export interface MissionGuide {
  next(request: MissionGuideRequest): Promise<MissionGuideResult>;
}

export interface MissionChildResult {
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'lost';
  summary: string;
  /** Absolute cumulative high-water usage for this deterministic attempt. */
  usage: MissionUsage;
  /** Present only after strict machine validation of an authorized child's structured result. */
  artifact?: MissionChildArtifact;
}

export type MissionUsageDisposition = 'continue' | 'cancel';
export type MissionUsageObserver = (usage: MissionUsage) => Promise<MissionUsageDisposition>;

export interface MissionChildExecution {
  /** Must match the attempt id passed to `startOrAttach`. */
  attemptId: string;
  sessionId?: string | null;
  /**
   * Registry-trusted cumulative usage for this attempt at attach time, including time before
   * reattach. Required whenever a finite axis is resumed after process/controller restart.
   */
  usageAtAttach?: MissionUsage | null;
  /**
   * Deferred fresh-launch edge. Registry implementations publish this dormant handle durably
   * before the harness invokes it. Omitted only by already-active/replayed executor adapters.
   */
  activate?(): Promise<void>;
  cancel(reason: string): Promise<void>;
  /**
   * Resolves once, after all awaited usage callbacks settle and the complete managed agent,
   * tool, and project-MCP process tree is proven dead.
   */
  done(): Promise<MissionChildResult>;
}

export interface MissionChildStartRequest {
  state: MissionState;
  child: MissionChildState;
  /** Already durable before this method is called. */
  attemptId: string;
  onUsage: MissionUsageObserver;
}

export interface MissionChildExecutor {
  /**
   * Idempotently start or reattach to the exact attempt id after a Runner restart. This is a
   * registry-owned transaction with a finite transport deadline. A timed-out pre-launch
   * transaction may finish only as a dormant durable reservation: it must never activate a model
   * behind the harness. Recovery classifies that reservation before a later activation attempt.
   */
  startOrAttach(request: MissionChildStartRequest): Promise<MissionChildExecution>;
}

/**
 * An executor may use this only when it can prove the durable attempt cannot exist. Unclassified
 * attach failures are treated as ambiguous and remain recoverable on the next reconciliation.
 */
export class MissionChildAttemptError extends Error {
  override readonly name = 'MissionChildAttemptError';

  constructor(
    message: string,
    readonly definitive: boolean,
  ) {
    super(message);
  }
}

/** Trusted guide adapters use this only when they can prove no model process/session launched. */
export class MissionGuidePreflightError extends Error {
  override readonly name = 'MissionGuidePreflightError';
}

export type MissionEvidenceAction =
  | RecordCheckpointAction
  | RecordReviewAction
  | RecordWorkspaceReconciledAction;

export interface MissionEvidenceRecorder {
  /**
   * Observe VCS/reviewer/workspace truth after a child. Implementations must be idempotent and
   * return exactly one role-appropriate action. A successful write child is checkpointed first;
   * its dirty checkpoint then requires a workspace-reconciled proof. Failed, cancelled, and lost
   * write children require workspace reconciliation directly. A review must assert the read-only
   * child saw an unchanged exact checkpoint.
   */
  recordAfterChild(state: MissionState, child: MissionChildState): Promise<readonly MissionEvidenceAction[]>;
}

export interface MissionCleanupExecutor {
  /**
   * Idempotently fulfill one durable cleanup obligation. This promise must not settle until the
   * side effect has settled. The executor owns its timeout and cancellation acknowledgement:
   * abandoning a live promise would allow a later reconciliation to overlap the same cleanup.
   */
  execute(state: MissionState, cleanupId: string): Promise<void>;
}

export interface MissionValidationExecutor {
  /**
   * Deterministically validate one exact clean checkpoint under its immutable mission policy.
   * Implementations own command timeout/process settlement and return only the observation action;
   * the harness journals it through the kernel before any guide sees the result.
   */
  validate(
    state: MissionState,
    checkpoint: MissionCheckpointState,
    policy: Extract<MissionValidationPolicy, { kind: 'command' }>,
    signal: AbortSignal,
  ): Promise<RecordValidationAction>;
  /** Settle a durably started attempt without re-running its command (terminal cancellation). */
  recover(
    state: MissionState,
    checkpoint: MissionCheckpointState,
    policy: Extract<MissionValidationPolicy, { kind: 'command' }>,
  ): Promise<RecordValidationAction>;
}

export interface MissionAcceptedRevisionHandoffRecorder {
  /**
   * After successful terminal cleanup, prove the accepted revision remains named by a durable
   * backend reference. Null means no valid handoff could be produced and leaves reconciliation
   * incomplete; failed and cancelled missions never call this boundary.
   */
  record(state: MissionState): Promise<RecordAcceptedRevisionHandoffAction | null>;
}

export type MissionGuideSource = MissionGuide | ((guideEpoch: number) => MissionGuide);

/**
 * Trusted lifecycle proof supplied by the guide runtime, not inferred from a missing in-memory
 * attempt. Set this only when containment guarantees the complete guide process tree terminates
 * with its Runner owner. It permits restart reconciliation to classify an unattached durable
 * guide turn as stopped, while keeping its unreported usage unknown.
 */
export interface MissionGuideOwnerDeathProof {
  ownerDeathTerminatesProcessTree: true;
}

export interface MissionHarnessOptions {
  store: MissionStore;
  guide: MissionGuideSource;
  /** Omit for guide implementations whose attempts may outlive the owning Runner process. */
  guideOwnerDeathProof?: MissionGuideOwnerDeathProof;
  children: MissionChildExecutor;
  evidence?: MissionEvidenceRecorder;
  validation?: MissionValidationExecutor;
  cleanup?: MissionCleanupExecutor;
  acceptedRevisionHandoff?: MissionAcceptedRevisionHandoffRecorder;
  /** Same durable coordinator used by the child executor before launch. */
  resources?: MissionExternalResourceCoordinator;
  /** Used only to allocate a turn id before its begin action is durable. */
  newTurnId?: () => string;
  /** Must be safe to call repeatedly for the same question id after restart. */
  onQuestion?: (question: MissionQuestionState, state: MissionState) => Promise<void>;
  cancelGraceMs?: number;
  /** Bounded fallback for observing terminal/cancel facts written by another Runner process. */
  durablePollMs?: number;
}

export type MissionHarnessStop =
  | { reason: 'terminal'; state: MissionState; guideTurns: number }
  | {
      reason: 'human-question';
      state: MissionState;
      guideTurns: number;
      question: MissionQuestionState;
    }
  | { reason: 'runtime-error'; state: MissionState; guideTurns: number; error: string };

export class MissionHarnessAlreadyRunningError extends Error {
  override readonly name = 'MissionHarnessAlreadyRunningError';
}

type ChildRunResult = { state: MissionState } | { state: MissionState; error: string; recoverable?: boolean };
type GuideRunResult = { state: MissionState } | { state: MissionState; error: string; recoverable?: boolean };
type PlanRunResult = { state: MissionState } | { state: MissionState; error: string };

interface ActiveGuideAttempt {
  missionId: string;
  turnId: string;
  stateAtStart: MissionState;
  abort: AbortController;
  startedAt: number;
  timedOut: boolean;
  settlement: Promise<PromiseSettledResult<MissionGuideResult>>;
}

interface RegisteredChildExecution {
  execution: MissionChildExecution;
  settlement: Promise<PromiseSettledResult<MissionChildResult>>;
  beginSettlement: () => void;
  attachUsageJournaled: boolean;
  activeBaseline: MissionUsage | null;
  /** Monotonic clock at attach transaction settlement; excludes attach latency. */
  activeStartedAt: number;
  /** Monotonic clock when `done` settled, so harness bookkeeping is never billed as process time. */
  settledAt: number | null;
}

export function renderMissionGuidePrompt(projection: MissionGuideProjection): string {
  return renderPrompt('mission-guide', {
    actionSchema: MISSION_GUIDE_ACTION_SCHEMA,
    // The projection already carries its own aggregate ceiling. Compact serialization preserves
    // that bound; pretty-print expansion could turn an admitted frame into a paid preflight loop.
    projection: JSON.stringify(projection),
  });
}

const bounded = (value: string, limit: number): string => {
  const normalized = value.trim();
  if (normalized.length === 0) return 'No summary was reported.';
  return normalized.slice(0, limit);
};

const utf8Tail = (value: string, maxBytes: number): string => {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength <= maxBytes) return value;
  let start = encoded.byteLength - maxBytes;
  while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) start += 1;
  return encoded.subarray(start).toString('utf8');
};

const finiteNonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0;

function validUsage(value: MissionUsage): boolean {
  return (
    (value.tokens === null || (Number.isSafeInteger(value.tokens) && value.tokens >= 0)) &&
    (value.usd === null || finiteNonNegative(value.usd)) &&
    (value.activeSeconds === null || finiteNonNegative(value.activeSeconds))
  );
}

function observedUsage(
  reported: MissionUsage | undefined,
  elapsedSeconds: number,
  previous: MissionUsage = { tokens: 0, usd: 0, activeSeconds: 0 },
  activeBaseline: number | null = previous.activeSeconds,
): MissionUsage {
  if (!reported || !validUsage(reported)) {
    return {
      tokens: null,
      usd: null,
      activeSeconds:
        previous.activeSeconds === null || activeBaseline === null
          ? null
          : Math.max(previous.activeSeconds, activeBaseline + elapsedSeconds),
    };
  }
  return {
    tokens:
      previous.tokens === null || reported.tokens === null
        ? null
        : Math.max(previous.tokens, reported.tokens),
    usd: previous.usd === null || reported.usd === null ? null : Math.max(previous.usd, reported.usd),
    activeSeconds:
      previous.activeSeconds === null || reported.activeSeconds === null || activeBaseline === null
        ? null
        : Math.max(previous.activeSeconds, reported.activeSeconds, activeBaseline + elapsedSeconds),
  };
}

function effectId(kind: string, ...values: unknown[]): string {
  const digest = createHash('sha256').update(canonicalMissionJson(values), 'utf8').digest('hex');
  return `${kind}:${digest.slice(0, 48)}`;
}

function attemptId(missionId: string, childId: string): string {
  return effectId('attempt', missionId, childId);
}

function withTrustedPlanStep(action: MissionGuideProposal, planStepId: string): MissionGuideProposal {
  return action.type === 'spawn-child' ? { ...action, planStepId } : action;
}

function positiveDuration(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_MS) {
    throw new Error('mission harness timeout must be a positive safe timer duration');
  }
  return value;
}

class MissionOperationTimeoutError extends Error {
  override readonly name = 'MissionOperationTimeoutError';
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number | null,
  onTimeout?: () => void,
): Promise<T> {
  if (timeoutMs === null) return operation;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => {
        onTimeout?.();
        reject(new MissionOperationTimeoutError(`operation exceeded its ${timeoutMs}ms active-time bound`));
      },
      Math.min(MAX_TIMER_MS, Math.max(1, timeoutMs)),
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Agent-led mission control with a model-free journal boundary. The guide proposes only profile
 * ids and bounded intent; every authority resolution, state transition, side effect, and result is
 * owned by this harness and the deterministic kernel.
 */
export class MissionHarness {
  private readonly kernel: MissionKernel;
  private readonly newTurnId: () => string;
  private readonly cancelGraceMs: number;
  private readonly durablePollMs: number;
  private readonly activeMissions = new Map<string, Promise<MissionHarnessStop>>();
  private readonly activeGuideAborts = new Map<string, AbortController>();
  private readonly activeGuideAttempts = new Map<string, ActiveGuideAttempt>();
  private readonly activeExecutions = new Map<string, RegisteredChildExecution>();
  private readonly activeValidationAborts = new Map<string, AbortController>();
  private readonly cancellationPromises = new Map<string, Promise<void>>();
  private readonly evidenceAttempted = new Set<string>();
  private readonly usageQueues = new Map<string, Promise<MissionUsageDisposition>>();
  private readonly pausedMissions = new Map<string, string>();
  private quiescingReason: string | null = null;

  constructor(private readonly options: MissionHarnessOptions) {
    this.kernel = new MissionKernel(options.store);
    this.newTurnId = options.newTurnId ?? randomUUID;
    this.cancelGraceMs = positiveDuration(options.cancelGraceMs, DEFAULT_CANCEL_GRACE_MS);
    this.durablePollMs = positiveDuration(options.durablePollMs, DEFAULT_DURABLE_POLL_MS);
  }

  load(missionId: string): Promise<MissionState> {
    return this.kernel.inspect(missionId);
  }

  async answerQuestion(missionId: string, questionId: string, answer: string): Promise<MissionState> {
    const state = await this.load(missionId);
    const result = await this.commit(state, effectId('answer-question', missionId, questionId, answer), {
      type: 'answer-question',
      questionId,
      answer,
    });
    if (!result.accepted) throw new Error(`question answer was refused: ${result.reason}`);
    return result.state;
  }

  async cancelMission(missionId: string, reason: string): Promise<MissionHarnessStop> {
    const boundedReason = bounded(reason, MAX_RESULT_SUMMARY_CHARS);
    let state = await this.load(missionId);
    let durableCancelled = state.terminal?.outcome === 'cancelled';
    for (let attempt = 0; !state.terminal && attempt < MAX_CANCEL_COMMIT_ATTEMPTS; attempt += 1) {
      const observedRevision = state.revision;
      const result = await this.commit(
        state,
        effectId('cancel-mission', missionId, state.guideEpoch, boundedReason),
        {
          type: 'complete-mission',
          guideEpoch: state.guideEpoch,
          outcome: 'cancelled',
          reason: boundedReason,
        },
      );
      state = result.state;
      if (result.accepted || state.terminal?.outcome === 'cancelled') {
        durableCancelled = true;
        break;
      }
      // Usage, evidence, or another safe writer may win the first CAS. Reload/retry against the
      // authoritative revision so an operator cancellation is not lost to an incidental update.
      if (!state.terminal && state.revision > observedRevision) continue;
      if (!result.accepted) {
        return this.runtimeError(result.state, `mission cancellation was refused: ${result.reason}`);
      }
    }
    if (!state.terminal) {
      return this.runtimeError(
        state,
        `mission cancellation could not win a durable revision after ${MAX_CANCEL_COMMIT_ATTEMPTS} attempts`,
      );
    }
    if (durableCancelled) {
      this.activeGuideAborts.get(missionId)?.abort();
      this.activeValidationAborts.get(missionId)?.abort();
      const registered = this.activeExecutions.get(missionId);
      if (registered) {
        // Cancellation acknowledgement is not process settlement and may itself hang. The active
        // controller races the registered `done` settlement against cancelGraceMs.
        void this.cancelExecutionOnce(
          registered.execution,
          `mission cancelled: ${boundedReason.slice(0, 16_384)}`,
        ).catch(() => undefined);
      }
    }
    const active = this.activeMissions.get(missionId);
    if (active) return active;
    try {
      return await this.run(missionId);
    } catch (error) {
      if (error instanceof MissionControllerBusyError) {
        const fresh = await this.load(missionId);
        return this.runtimeError(
          fresh,
          'mission cancellation is durable; another live controller owns terminal reconciliation',
        );
      }
      throw error;
    }
  }

  run(missionId: string): Promise<MissionHarnessStop> {
    if (this.quiescingReason) {
      return Promise.reject(new Error(`mission harness is quiescing: ${this.quiescingReason}`));
    }
    const paused = this.pausedMissions.get(missionId);
    if (paused) {
      return Promise.reject(new Error(`mission '${missionId}' is quiesced: ${paused}`));
    }
    if (this.activeMissions.has(missionId)) {
      return Promise.reject(
        new MissionHarnessAlreadyRunningError(`mission '${missionId}' is already controlled locally`),
      );
    }
    const operation = (async () => {
      const lease = await this.options.store.acquireController(missionId);
      try {
        return await this.controlMission(missionId);
      } finally {
        await lease.release();
      }
    })().finally(() => {
      if (this.activeMissions.get(missionId) === operation) this.activeMissions.delete(missionId);
    });
    this.activeMissions.set(missionId, operation);
    return operation;
  }

  /**
   * Stop every in-process model/tool tree without terminalizing its mission. Durable attempt facts
   * remain available for owner-death recovery, and this harness instance permanently refuses new
   * control after the shutdown barrier begins.
   */
  async quiesce(reason = 'Runner daemon is shutting down'): Promise<void> {
    this.quiescingReason = bounded(reason, MAX_RESULT_SUMMARY_CHARS);
    await this.awaitQuiescence(this.quiescingReason, null);
  }

  /** Stop one mission's model/tool tree without writing a terminal outcome. */
  async quiesceMission(missionId: string, reason: string): Promise<void> {
    const boundedReason = bounded(reason, MAX_RESULT_SUMMARY_CHARS);
    this.pausedMissions.set(missionId, boundedReason);
    await this.awaitQuiescence(boundedReason, missionId);
  }

  /**
   * Join process-tree settlement, not merely an abort/cancel acknowledgement. A controller may
   * cross its last admission check while this barrier is being raised, so sweep until both the
   * controller and every attempt it could have published are settled. `done()` is the child
   * executor's process-tree boundary; guide settlement is the equivalent driver boundary.
   */
  private async awaitQuiescence(reason: string, missionId: string | null): Promise<void> {
    const provedGuides = new Set<ActiveGuideAttempt>();
    const inScope = (candidate: string): boolean => missionId === null || candidate === missionId;

    for (;;) {
      for (const [candidate, abort] of this.activeGuideAborts) {
        if (inScope(candidate)) abort.abort();
      }
      for (const [candidate, abort] of this.activeValidationAborts) {
        if (inScope(candidate)) abort.abort();
      }

      const guides = [...this.activeGuideAttempts.values()].filter(
        (attempt) => inScope(attempt.missionId) && !provedGuides.has(attempt),
      );
      const children = [...this.activeExecutions.entries()].filter(([candidate]) => inScope(candidate));
      for (const [, registered] of children) {
        registered.beginSettlement();
        // Cancellation acknowledgement is not settlement and may itself reject or hang. Start it,
        // but let the registry-owned `done` promise below remain the shutdown authority.
        void this.cancelExecutionOnce(registered.execution, reason).catch(() => undefined);
      }

      if (guides.length > 0 || children.length > 0) {
        await Promise.all([
          ...guides.map(async (attempt) => {
            await attempt.settlement;
            provedGuides.add(attempt);
          }),
          ...children.map(async ([candidate, registered]) => {
            await registered.settlement;
            if (this.activeExecutions.get(candidate) === registered) {
              this.activeExecutions.delete(candidate);
            }
            this.cancellationPromises.delete(registered.execution.attemptId);
          }),
        ]);
        continue;
      }

      const controllers = [...this.activeMissions.entries()]
        .filter(([candidate]) => inScope(candidate))
        .map(([, operation]) => operation);
      if (controllers.length === 0) return;

      // Do not await only the current controller snapshot: it may be between its admission check
      // and publishing an attempt. Yield once, sweep again, and cancel any newly visible tree.
      await Promise.race([
        Promise.allSettled(controllers).then(() => undefined),
        new Promise<void>((resolve) => setImmediate(resolve)),
      ]);
    }
  }

  /** Fresh external lease adoption only; re-enable one nonterminal mission. */
  resumeMission(missionId: string): void {
    if (this.activeMissions.has(missionId) || this.activeExecutions.has(missionId)) {
      throw new Error(`mission '${missionId}' cannot resume while quiesced work is still settling`);
    }
    this.pausedMissions.delete(missionId);
  }

  /**
   * Re-enable this retained runtime after its external transport lease was freshly adopted.
   * The durable mission remains nonterminal; only the in-memory controller barrier is reset.
   */
  resumeAfterQuiesce(): void {
    if (this.activeMissions.size > 0 || this.activeExecutions.size > 0) {
      throw new Error('mission harness cannot resume while quiesced controllers are still settling');
    }
    this.quiescingReason = null;
  }

  /** Wait for an in-process controller to yield, then continue from the latest durable state. */
  async runAfterLocalController(missionId: string): Promise<MissionHarnessStop> {
    const active = this.activeMissions.get(missionId);
    if (active) await active;
    return this.run(missionId);
  }

  private async controlMission(missionId: string): Promise<MissionHarnessStop> {
    try {
      let state = await this.load(missionId);
      if (state.status === 'uninitialized') return this.runtimeError(state, 'mission has not been created');

      for (;;) {
        if (state.terminal) {
          const reconciled = await this.reconcileTerminal(state);
          state = reconciled.state;
          if (reconciled.error) return this.runtimeError(state, reconciled.error);
          return { reason: 'terminal', state, guideTurns: state.guideTurnOrder.length };
        }

        if (this.quiescingReason) {
          return this.runtimeError(state, `mission control quiesced: ${this.quiescingReason}`);
        }
        const paused = this.pausedMissions.get(missionId);
        if (paused) return this.runtimeError(state, `mission control quiesced: ${paused}`);

        const pendingQuestion = Object.values(state.questions).find(
          (question) => question.status === 'pending',
        );
        if (pendingQuestion) {
          try {
            await this.options.onQuestion?.(pendingQuestion, state);
          } catch (error) {
            return this.runtimeError(state, `question notification failed: ${String(error)}`);
          }
          return {
            reason: 'human-question',
            state,
            guideTurns: state.guideTurnOrder.length,
            question: pendingQuestion,
          };
        }

        // A child may have been reserved by an older/external controller before a write attempt
        // terminalized. Reconcile that residue before allowing the reserved child to launch.
        if (unreconciledTerminalWriteChild(state)) {
          const evidence = await this.reconcileEvidence(state);
          if ('error' in evidence) {
            state = await this.failMission(evidence.state, evidence.error);
          } else {
            state = evidence.state;
          }
          continue;
        }

        const activeChild = missionChildrenInOrder(state).find((child) => !childIsTerminal(child.status));
        if (activeChild) {
          const childResult = await this.runChild(state, activeChild);
          if ('error' in childResult) {
            if (childResult.recoverable) return this.runtimeError(childResult.state, childResult.error);
            state = await this.failMission(childResult.state, childResult.error);
          } else {
            state = childResult.state;
          }
          continue;
        }

        const evidence = await this.reconcileEvidence(state);
        if ('error' in evidence) {
          state = await this.failMission(evidence.state, evidence.error);
          continue;
        }
        if (evidence.state.revision !== state.revision) {
          state = evidence.state;
          continue;
        }
        state = evidence.state;

        const resourceError = await this.releaseSettledResources(state);
        if (resourceError) {
          state = await this.failMission(state, resourceError);
          continue;
        }

        const planned = await this.reconcileActivePlan(state);
        if ('error' in planned) {
          state = await this.failMission(planned.state, planned.error);
          continue;
        }
        if (planned.state.revision !== state.revision) {
          state = planned.state;
          continue;
        }
        state = planned.state;

        const validated = await this.reconcileValidation(state);
        if ('error' in validated) {
          if (validated.state.terminal) {
            state = validated.state;
            continue;
          }
          return this.runtimeError(validated.state, validated.error);
        }
        if (validated.state.revision !== state.revision) {
          state = validated.state;
          continue;
        }
        state = validated.state;

        const latestTurnId = state.guideTurnOrder.at(-1);
        const latestTurn = latestTurnId ? state.guideTurns[latestTurnId] : undefined;
        if (latestTurn && latestTurn.guideEpoch === state.guideEpoch) {
          if (latestTurn.status === 'running') {
            const resumed = await this.reconcileRunningGuideTurn(state, latestTurn.turnId);
            if ('error' in resumed) return this.runtimeError(resumed.state, resumed.error);
            state = resumed.state;
            continue;
          }
          if (latestTurn.status === 'proposed') {
            const applied = await this.applyDurableProposal(state, latestTurn.turnId);
            state = applied.state;
            if (applied.stop) return applied.stop;
            continue;
          }
          state = await this.replaceGuide(
            state,
            latestTurn.turnId,
            `guide turn ${latestTurn.status}; a fresh guide projection is required`,
          );
          continue;
        }

        if (Object.keys(state.budgetConstraints).length > 0) {
          state = await this.failMission(state, 'A durable budget constraint prevents further mission work.');
          continue;
        }
        if (!state.guide) return this.runtimeError(state, 'mission has no durable guide profile');
        if (state.consecutiveGuideRepairs >= MAX_CONSECUTIVE_GUIDE_REPAIR_TURNS) {
          state = await this.failMission(
            state,
            `Guide protocol repair limit ${MAX_CONSECUTIVE_GUIDE_REPAIR_TURNS} was exhausted after consecutive malformed or refused proposals.`,
          );
          continue;
        }
        if (state.guideTurnOrder.length >= state.guide.turnLimit) {
          state = await this.failMission(
            state,
            `Guide turn limit ${state.guide.turnLimit} was exhausted before completion.`,
          );
          continue;
        }

        const invoked = await this.invokeGuide(state);
        if ('error' in invoked) {
          if (invoked.recoverable) return this.runtimeError(invoked.state, invoked.error);
          state = await this.failMission(invoked.state, invoked.error);
        } else {
          state = invoked.state;
        }
      }
    } catch (error) {
      if (!(error instanceof MissionJournalLimitError)) throw error;
      // Ordinary admission is deliberately stopped before the reserved settlement tail. Convert
      // that bounded exhaustion into one durable terminal fact instead of returning an active
      // mission that will hit the same limit after every restart.
      let state = await this.load(missionId);
      if (!state.terminal) {
        state = await this.failMission(
          state,
          `Mission journal ${error.dimension} capacity was exhausted before more work could be authorized.`,
        );
      }
      if (!state.terminal) {
        return this.runtimeError(
          state,
          `mission journal exhaustion could not be terminalized: ${error.message}`,
        );
      }
      const reconciled = await this.reconcileTerminal(state);
      if (reconciled.error) return this.runtimeError(reconciled.state, reconciled.error);
      return {
        reason: 'terminal',
        state: reconciled.state,
        guideTurns: reconciled.state.guideTurnOrder.length,
      };
    } finally {
      if (!this.activeGuideAttempts.has(missionId)) this.activeGuideAborts.delete(missionId);
      // A recoverable runtime stop may deliberately retain a live registered child. It is removed
      // only after `done` settles, never merely because this controller invocation is returning.
    }
  }

  private async commit(
    state: MissionState,
    actionId: string,
    action: MissionAction,
  ): Promise<MissionDispatchResult> {
    const envelope: MissionActionEnvelope = {
      missionId: state.missionId,
      expectedRevision: state.revision,
      actionId,
      action,
    };
    try {
      return await this.kernel.dispatch(envelope);
    } catch (error) {
      if (!(error instanceof MissionStoreConflictError)) throw error;
      const fresh = await this.load(state.missionId);
      return {
        accepted: false,
        code: 'invalid-state',
        reason: `concurrent mission update: ${error.message}`,
        state: fresh,
      };
    }
  }

  private runtimeError(state: MissionState, error: string): MissionHarnessStop {
    return {
      reason: 'runtime-error',
      state,
      guideTurns: state.guideTurnOrder.length,
      error: bounded(error, MAX_RESULT_SUMMARY_CHARS),
    };
  }

  private async invokeGuide(state: MissionState): Promise<GuideRunResult> {
    const turnId = this.newTurnId();
    const begun = await this.commit(state, effectId('begin-guide-turn', state.missionId, turnId), {
      type: 'begin-guide-turn',
      guideEpoch: state.guideEpoch,
      turnId,
    });
    if (!begun.accepted) {
      return { state: begun.state, error: `guide turn admission was refused: ${begun.reason}` };
    }
    const currentState = begun.state;
    let projection: MissionGuideProjection;
    try {
      projection = projectMissionForGuide(currentState);
    } catch (error) {
      const summary = `guide projection preflight failed before model launch: ${String(error)}`;
      const completed = await this.commit(
        currentState,
        effectId('complete-guide-turn', currentState.missionId, turnId),
        {
          type: 'complete-guide-turn',
          turnId,
          outcome: 'failed',
          summary: bounded(summary, MAX_RESULT_SUMMARY_CHARS),
          usage: { tokens: 0, usd: 0, activeSeconds: 0 },
          proposal: null,
        },
      );
      return {
        state: completed.state,
        error: completed.accepted
          ? summary
          : `guide projection failure could not be journaled: ${completed.reason}`,
      };
    }
    const guide =
      typeof this.options.guide === 'function'
        ? this.options.guide(projection.guideEpoch)
        : this.options.guide;
    const abort = new AbortController();
    this.activeGuideAborts.set(currentState.missionId, abort);
    const operation = Promise.resolve().then(() =>
      guide.next({
        projection,
        profile: currentState.guide!,
        actionSchema: MISSION_GUIDE_ACTION_SCHEMA,
        prompt: renderMissionGuidePrompt(projection),
        signal: abort.signal,
      }),
    );
    const attempt: ActiveGuideAttempt = {
      missionId: currentState.missionId,
      turnId,
      stateAtStart: currentState,
      abort,
      startedAt: performance.now(),
      timedOut: false,
      settlement: operation.then(
        (value) => ({ status: 'fulfilled', value }),
        (reason: unknown) => ({ status: 'rejected', reason }),
      ),
    };
    this.activeGuideAttempts.set(currentState.missionId, attempt);
    let settlement: PromiseSettledResult<MissionGuideResult> | null = null;
    let removeAbortWake: () => void = () => undefined;
    const abortWake = new Promise<null>((resolve) => {
      const wake = () => resolve(null);
      removeAbortWake = () => abort.signal.removeEventListener('abort', wake);
      if (abort.signal.aborted) resolve(null);
      else abort.signal.addEventListener('abort', wake, { once: true });
    });
    try {
      const turnBudget = currentState.guideTurns[turnId]?.budget.activeSeconds ?? null;
      settlement = await withTimeout(
        Promise.race([attempt.settlement, abortWake]),
        turnBudget === null ? null : turnBudget * 1_000,
        () => {
          attempt.timedOut = true;
          abort.abort();
        },
      );
      if (!settlement) {
        settlement = await this.waitForGuideSettlement(attempt);
        if (!settlement) {
          return {
            state: currentState,
            recoverable: true,
            error: `guide did not acknowledge cancellation within ${this.cancelGraceMs}ms; its live attempt remains registered and the durable turn cannot be replaced`,
          };
        }
      }
    } catch (error) {
      if (error instanceof MissionOperationTimeoutError) {
        attempt.timedOut = true;
        abort.abort();
        settlement = await this.waitForGuideSettlement(attempt);
        if (!settlement) {
          return {
            state: currentState,
            recoverable: true,
            error: `guide exceeded its active-time budget and did not acknowledge cancellation within ${this.cancelGraceMs}ms; its live attempt remains registered and the durable turn cannot be replaced`,
          };
        }
      } else {
        return {
          state: currentState,
          recoverable: true,
          error: `guide settlement wait failed while its durable turn remains running: ${String(error)}`,
        };
      }
    } finally {
      removeAbortWake();
    }
    return this.completeGuideAttempt(attempt, settlement);
  }

  private async waitForGuideSettlement(
    attempt: ActiveGuideAttempt,
  ): Promise<PromiseSettledResult<MissionGuideResult> | null> {
    try {
      return await withTimeout(attempt.settlement, this.cancelGraceMs);
    } catch (error) {
      if (error instanceof MissionOperationTimeoutError) return null;
      throw error;
    }
  }

  private async reconcileRunningGuideTurn(state: MissionState, turnId: string): Promise<GuideRunResult> {
    const attempt = this.activeGuideAttempts.get(state.missionId);
    if (!attempt || attempt.turnId !== turnId) {
      if (!this.options.guideOwnerDeathProof?.ownerDeathTerminatesProcessTree) {
        return {
          state,
          recoverable: true,
          error: `guide attempt '${turnId}' has no local attachment and may still be live; restart reconciliation requires an external attempt registry or owner-death process-tree proof`,
        };
      }
      return { state: await this.loseRunningGuideTurn(state, turnId) };
    }
    const settlement = await this.waitForGuideSettlement(attempt);
    if (!settlement) {
      return {
        state,
        recoverable: true,
        error: `guide attempt '${turnId}' is still live after cancellation; retry reconciliation after it acknowledges abort`,
      };
    }
    return this.completeGuideAttempt(attempt, settlement);
  }

  private async completeGuideAttempt(
    attempt: ActiveGuideAttempt,
    settlement: PromiseSettledResult<MissionGuideResult>,
  ): Promise<GuideRunResult> {
    const elapsed = Math.max(0, (performance.now() - attempt.startedAt) / 1_000);
    const provedPreflightFailure =
      settlement.status === 'rejected' && settlement.reason instanceof MissionGuidePreflightError;
    let usage = provedPreflightFailure
      ? { tokens: 0, usd: 0, activeSeconds: 0 }
      : observedUsage(settlement.status === 'fulfilled' ? settlement.value.usage : undefined, elapsed);
    let proposal: MissionGuideProposal | null = null;
    let outcome: 'proposed' | 'failed' | 'cancelled' | 'lost';
    let summary: string;
    if (attempt.timedOut || attempt.abort.signal.aborted) {
      outcome = 'cancelled';
      summary = attempt.timedOut
        ? 'guide exceeded its active-time budget and acknowledged cancellation'
        : 'guide acknowledged durable mission cancellation';
    } else if (settlement.status === 'rejected') {
      outcome = 'failed';
      summary = `guide invocation failed: ${String(settlement.reason)}`;
    } else if (settlement.value.output.length > MAX_GUIDE_OUTPUT_CHARS) {
      outcome = 'failed';
      summary = `guide output exceeded ${MAX_GUIDE_OUTPUT_CHARS} characters`;
    } else {
      const parsed = parseMissionGuideEnvelope(settlement.value.output);
      const freshness = parsed.ok
        ? this.checkTurnEnvelope(attempt.stateAtStart, attempt.turnId, parsed.envelope)
        : null;
      if (!parsed.ok) {
        outcome = 'failed';
        summary = parsed.reason;
      } else if (freshness) {
        outcome = 'failed';
        summary = freshness;
      } else {
        const translated = translateMissionGuideAction(
          attempt.stateAtStart,
          parsed.envelope.actionId,
          parsed.envelope.guideEpoch,
          parsed.envelope.action,
        );
        if (!translated.ok) {
          outcome = 'failed';
          summary = translated.reason;
        } else {
          outcome = 'proposed';
          proposal = translated.action;
          summary = `guide proposed ${parsed.envelope.action.type}`;
        }
      }
    }
    // Keep unknown telemetry unknown. Only the elapsed active-time axis is synthesized.
    if (!validUsage(usage)) usage = observedUsage(undefined, elapsed);
    let currentState = await this.load(attempt.missionId);
    for (let retry = 0; retry < MAX_CANCEL_COMMIT_ATTEMPTS; retry += 1) {
      const turn = ownMissionValue(currentState.guideTurns, attempt.turnId);
      if (!turn || turn.status !== 'running') {
        this.releaseGuideAttempt(attempt);
        return { state: currentState };
      }
      const completed = await this.commit(
        currentState,
        effectId('complete-guide-turn', currentState.missionId, attempt.turnId),
        {
          type: 'complete-guide-turn',
          turnId: attempt.turnId,
          outcome,
          summary: bounded(summary, MAX_RESULT_SUMMARY_CHARS),
          usage,
          proposal,
        },
      );
      currentState = completed.state;
      if (completed.accepted) {
        this.releaseGuideAttempt(attempt);
        if (provedPreflightFailure) {
          return {
            state: currentState,
            recoverable: true,
            error: `guide preflight is incompatible with the durable execution profile: ${bounded(
              summary,
              16_384,
            )}`,
          };
        }
        if (outcome === 'proposed' || currentState.terminal) return { state: currentState };
        return {
          state: await this.replaceGuide(currentState, attempt.turnId, bounded(summary, 16_384)),
        };
      }
      if (!completed.reason.startsWith('concurrent mission update:')) {
        this.releaseGuideAttempt(attempt);
        return { state: currentState, error: `guide result could not be journaled: ${completed.reason}` };
      }
    }
    return {
      state: currentState,
      recoverable: true,
      error: `guide result for '${attempt.turnId}' could not win a durable revision; the settled attempt remains registered`,
    };
  }

  private releaseGuideAttempt(attempt: ActiveGuideAttempt): void {
    if (this.activeGuideAttempts.get(attempt.missionId) === attempt) {
      this.activeGuideAttempts.delete(attempt.missionId);
    }
    if (this.activeGuideAborts.get(attempt.missionId) === attempt.abort) {
      this.activeGuideAborts.delete(attempt.missionId);
    }
  }

  private checkTurnEnvelope(
    state: MissionState,
    turnId: string,
    envelope: { missionId: string; guideEpoch: number; expectedRevision: number },
  ): string | null {
    const turn = state.guideTurns[turnId];
    if (!turn) return 'guide turn is not durable';
    if (envelope.missionId !== state.missionId) return 'guide named another mission';
    if (envelope.guideEpoch !== turn.guideEpoch) return 'guide copied the wrong epoch';
    if (envelope.expectedRevision !== turn.startedRevision) return 'guide copied the wrong revision';
    return null;
  }

  private async applyDurableProposal(
    state: MissionState,
    turnId: string,
  ): Promise<{ state: MissionState; stop?: MissionHarnessStop }> {
    const turn = state.guideTurns[turnId];
    if (!turn?.proposal) {
      return { state: await this.replaceGuide(state, turnId, 'durable guide proposal is missing') };
    }
    const proposal = turn.proposal;
    let result: MissionDispatchResult;
    try {
      result = await this.commit(state, effectId('guide-proposal', state.missionId, turnId), {
        type: 'apply-guide-proposal',
        turnId,
      });
    } catch (error) {
      if (!(error instanceof MissionJournalLimitError)) throw error;
      // Applying may authorize a child whose complete settlement no longer fits even though the
      // already-metered proposal itself did. The proposal-state reserve always keeps one slot to
      // invalidate that turn; doing so lets the outer loop terminalize bounded exhaustion rather
      // than wedging forever on the same unapplied proposal.
      return {
        state: await this.replaceGuide(
          state,
          turnId,
          `guide proposal could not be applied within the remaining journal ${error.dimension} capacity`,
        ),
      };
    }
    if (!result.accepted) {
      return {
        state: await this.replaceGuide(
          result.state,
          turnId,
          `guide proposal was refused (${result.code}): ${result.reason}`,
        ),
      };
    }
    const currentState = result.state;
    if (proposal.type === 'raise-question') {
      const question = currentState.questions[proposal.questionId];
      if (!question) return { state: currentState };
      try {
        await this.options.onQuestion?.(question, currentState);
      } catch (error) {
        return {
          state: currentState,
          stop: this.runtimeError(currentState, `question notification failed: ${String(error)}`),
        };
      }
      return {
        state: currentState,
        stop: {
          reason: 'human-question',
          state: currentState,
          guideTurns: currentState.guideTurnOrder.length,
          question,
        },
      };
    }
    return { state: currentState };
  }

  private async loseRunningGuideTurn(state: MissionState, turnId: string): Promise<MissionState> {
    const completed = await this.commit(state, effectId('lose-guide-turn', state.missionId, turnId), {
      type: 'complete-guide-turn',
      turnId,
      outcome: 'lost',
      summary:
        'Runner owner exited before the guide result became durable; containment terminated the old process tree, but its usage could not be recovered.',
      // The process may have spent tokens before Runner died. A lost response proves neither
      // tokens nor cost; recording zero here would silently reopen a finite mission budget.
      usage: { tokens: null, usd: null, activeSeconds: null },
      proposal: null,
    });
    if (!completed.accepted) return completed.state;
    return this.failMission(
      completed.state,
      'An in-flight guide attempt was lost after Runner owner death; its usage cannot be recovered.',
    );
  }

  private async replaceGuide(state: MissionState, turnId: string, reason: string): Promise<MissionState> {
    if (state.terminal) return state;
    const replaced = await this.commit(state, effectId('replace-guide', state.missionId, turnId), {
      type: 'replace-guide',
      guideEpoch: state.guideEpoch,
      reason: bounded(reason, 16_384),
    });
    return replaced.state;
  }

  private async cancelExecutionOnce(execution: MissionChildExecution, reason: string): Promise<void> {
    const existing = this.cancellationPromises.get(execution.attemptId);
    if (existing) return existing;
    let cancellation: Promise<void>;
    try {
      // Invoke immediately, but do not await acknowledgement before observing `done` settlement.
      cancellation = execution.cancel(reason);
    } catch (error) {
      cancellation = Promise.reject(error);
    }
    this.cancellationPromises.set(execution.attemptId, cancellation);
    try {
      await cancellation;
    } catch (error) {
      if (this.cancellationPromises.get(execution.attemptId) === cancellation) {
        this.cancellationPromises.delete(execution.attemptId);
      }
      throw error;
    }
  }

  private watchDurableChildControl(
    missionId: string,
    childId: string,
    execution: MissionChildExecution,
    signal: AbortSignal,
  ): Promise<string | null> {
    return (async () => {
      while (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', finish);
            resolve();
          };
          const timer = setTimeout(finish, this.durablePollMs);
          timer.unref?.();
          signal.addEventListener('abort', finish, { once: true });
        });
        if (signal.aborted) return null;
        let latest: MissionState;
        try {
          latest = await this.load(missionId);
        } catch {
          continue;
        }
        const child = ownMissionValue(latest.children, childId);
        if (latest.terminal || !child || child.status === 'cancelling' || childIsTerminal(child.status)) {
          const reason = latest.terminal
            ? `mission ${latest.terminal.outcome}: ${latest.terminal.reason}`
            : (child?.cancelReason ?? 'durable child cancellation or completion observed');
          void this.cancelExecutionOnce(execution, reason).catch(() => undefined);
          return reason;
        }
      }
      return null;
    })();
  }

  private registerExecution(execution: MissionChildExecution): RegisteredChildExecution {
    let beginSettlement!: () => void;
    const settlementGate = new Promise<void>((resolve) => {
      beginSettlement = resolve;
    });
    const registered: RegisteredChildExecution = {
      execution,
      settlement: Promise.resolve({ status: 'rejected', reason: 'uninitialized settlement' }),
      beginSettlement,
      attachUsageJournaled: false,
      activeBaseline: null,
      activeStartedAt: performance.now(),
      settledAt: null,
    };
    // Invoke done once. All timeout and cancellation paths observe this same registry-owned
    // settlement promise, so no wait can accidentally launch a second completion transaction.
    registered.settlement = settlementGate
      .then(() => execution.done())
      .then(
        (value) => ({ status: 'fulfilled', value }) as const,
        (reason: unknown) => ({ status: 'rejected', reason }) as const,
      )
      .then((settlement) => {
        registered.settledAt = performance.now();
        return settlement;
      });
    return registered;
  }

  private async waitForChildSettlement(
    registered: RegisteredChildExecution,
    timeoutMs: number,
  ): Promise<PromiseSettledResult<MissionChildResult> | null> {
    registered.beginSettlement();
    try {
      return await withTimeout(registered.settlement, timeoutMs);
    } catch (error) {
      if (error instanceof MissionOperationTimeoutError) return null;
      throw error;
    }
  }

  private async runChild(state: MissionState, selected: MissionChildState): Promise<ChildRunResult> {
    let currentState = state;
    let child = currentState.children[selected.childId];
    if (!child) return { state, error: `child '${selected.childId}' disappeared` };
    if (child.status === 'reserved') {
      const plannedAttempt = attemptId(currentState.missionId, child.childId);
      const started = await this.commit(
        currentState,
        effectId('start-child', currentState.missionId, child.childId),
        {
          type: 'start-child',
          childId: child.childId,
          attemptId: plannedAttempt,
        },
      );
      if (!started.accepted) {
        return { state: started.state, error: `child attempt could not be journaled: ${started.reason}` };
      }
      currentState = started.state;
      child = currentState.children[selected.childId];
      if (!child)
        return { state: currentState, error: `child '${selected.childId}' disappeared after start` };
    }
    if (!child.attemptId) return { state, error: `child '${child.childId}' has no durable attempt id` };

    let registered = this.activeExecutions.get(currentState.missionId);
    if (registered && registered.execution.attemptId !== child.attemptId) {
      const wrongAttempt = registered.execution.attemptId;
      void this.cancelExecutionOnce(
        registered.execution,
        `wrong attempt identity: expected '${child.attemptId}', received '${wrongAttempt}'`,
      ).catch(() => undefined);
      const settled = await this.waitForChildSettlement(registered, this.cancelGraceMs);
      if (!settled) {
        return {
          state: await this.load(currentState.missionId),
          recoverable: true,
          error: `executor attempt '${wrongAttempt}' has not settled after cancellation; its live registry entry blocks another start or attach`,
        };
      }
      if (this.activeExecutions.get(currentState.missionId) === registered) {
        this.activeExecutions.delete(currentState.missionId);
      }
      this.cancellationPromises.delete(wrongAttempt);
      return {
        state: await this.load(currentState.missionId),
        recoverable: true,
        error: `executor returned attempt '${wrongAttempt}', expected '${child.attemptId}'; it settled after cancellation, but the durable attempt remains ambiguous`,
      };
    }

    if (!registered) {
      let execution: MissionChildExecution;
      try {
        // `startOrAttach` is one registry-owned transaction. Its implementation owns a bounded
        // transport deadline and a durable ambiguity classification; the harness cannot safely
        // abandon the promise and later issue an overlapping transaction for the same attempt.
        execution = await this.options.children.startOrAttach({
          state: currentState,
          child,
          attemptId: child.attemptId,
          onUsage: (usage) => this.queueChildUsage(currentState.missionId, child!.childId, usage),
        });
      } catch (error) {
        if (!(error instanceof MissionChildAttemptError) || !error.definitive) {
          return {
            state: await this.load(currentState.missionId),
            recoverable: true,
            error: `child start/attach is ambiguous and will be retried through the registry: ${String(error)}`,
          };
        }
        return this.completeChildAsLost(currentState, child, `child start/attach failed: ${String(error)}`);
      }
      registered = this.registerExecution(execution);
      this.activeExecutions.set(currentState.missionId, registered);
      if (currentState.terminal || child.status === 'cancelling') {
        void this.cancelExecutionOnce(
          execution,
          child.cancelReason ??
            (currentState.terminal
              ? `mission ${currentState.terminal.outcome}: ${currentState.terminal.reason}`
              : 'cancellation requested'),
        ).catch(() => undefined);
      }
      if (execution.attemptId !== child.attemptId) {
        void this.cancelExecutionOnce(
          execution,
          `wrong attempt identity: expected '${child.attemptId}', received '${execution.attemptId}'`,
        ).catch(() => undefined);
        const settled = await this.waitForChildSettlement(registered, this.cancelGraceMs);
        if (!settled) {
          return {
            state: await this.load(currentState.missionId),
            recoverable: true,
            error: `executor returned attempt '${execution.attemptId}', expected '${child.attemptId}'; it has not settled after cancellation and remains registered`,
          };
        }
        if (this.activeExecutions.get(currentState.missionId) === registered) {
          this.activeExecutions.delete(currentState.missionId);
        }
        this.cancellationPromises.delete(execution.attemptId);
        return {
          state: await this.load(currentState.missionId),
          recoverable: true,
          error: `executor returned attempt '${execution.attemptId}', expected '${child.attemptId}'; it settled after cancellation, but the durable attempt remains ambiguous`,
        };
      }
    }

    const execution = registered.execution;
    const durableWatchAbort = new AbortController();
    const durableWatch = this.watchDurableChildControl(
      currentState.missionId,
      child.childId,
      execution,
      durableWatchAbort.signal,
    );
    let attachedState = await this.load(currentState.missionId);
    let attachedChild = attachedState.children[child.childId];
    let cancellationReason: string | null = null;

    if (!registered.attachUsageJournaled) {
      const snapshot = execution.usageAtAttach;
      const resumedAttempt = selected.status !== 'reserved';
      const axes = ['tokens', 'usd', 'activeSeconds'] as const;
      const requiredAxes = resumedAttempt
        ? axes.filter((axis) => child!.budget[axis] !== null || attachedState.budget[axis] !== null)
        : [];
      let snapshotError: string | null = null;
      if (snapshot !== undefined && snapshot !== null) {
        if (!validUsage(snapshot)) {
          snapshotError = 'child executor returned an invalid cumulative usage-at-attach snapshot';
        } else if (
          axes.some(
            (axis) =>
              attachedChild?.usage[axis] !== null &&
              (snapshot[axis] === null || snapshot[axis]! < attachedChild!.usage[axis]!),
          )
        ) {
          snapshotError = 'child executor returned a non-monotonic cumulative usage-at-attach snapshot';
        } else if (requiredAxes.some((axis) => snapshot[axis] === null)) {
          const unknownAxes = requiredAxes.filter((axis) => snapshot[axis] === null);
          snapshotError =
            unknownAxes.length === 1 && unknownAxes[0] === 'activeSeconds'
              ? 'child executor cannot prove cumulative active time for this reattached attempt'
              : `child executor cannot prove cumulative ${unknownAxes.join(
                  ', ',
                )} usage for this reattached attempt`;
        } else {
          const disposition = await this.queueChildUsage(currentState.missionId, child.childId, snapshot);
          attachedState = await this.load(currentState.missionId);
          attachedChild = attachedState.children[child.childId];
          registered.attachUsageJournaled = true;
          if (disposition === 'cancel') {
            cancellationReason =
              attachedChild?.cancelReason ?? 'usage-at-attach observation required cancellation';
          }
        }
      } else if (requiredAxes.length > 0) {
        snapshotError = `child executor did not provide cumulative ${requiredAxes.join(
          ', ',
        )} usage for this reattached attempt`;
      } else {
        registered.attachUsageJournaled = true;
      }

      if (snapshotError) {
        cancellationReason = snapshotError;
        if (
          attachedChild &&
          !childIsTerminal(attachedChild.status) &&
          attachedChild.status !== 'cancelling'
        ) {
          attachedState = await this.requestChildCancellation(attachedState, attachedChild, snapshotError);
          attachedChild = attachedState.children[child.childId];
        }
      }
      if (!registered.activeBaseline) {
        registered.activeBaseline = { ...(attachedChild?.usage ?? child.usage) };
      }
    }

    const baseline = registered.activeBaseline ?? { ...child.usage };
    let activeStartedAt = registered.activeStartedAt;
    const activeLimit = child.budget.activeSeconds;
    let activeTimeoutMs: number | null = null;
    if (activeLimit !== null) {
      if (baseline.activeSeconds === null) {
        cancellationReason ??=
          'child active-time usage is unknown; remaining budget cannot be proven after attach';
      } else {
        const alreadyObserved = Math.max(
          baseline.activeSeconds,
          attachedChild?.usage.activeSeconds ?? baseline.activeSeconds,
          baseline.activeSeconds +
            Math.max(0, ((registered.settledAt ?? performance.now()) - activeStartedAt) / 1_000),
        );
        const remaining = activeLimit - alreadyObserved;
        if (remaining <= 0) {
          cancellationReason ??= 'child active-time budget was exhausted at attach';
        } else {
          activeTimeoutMs = remaining * 1_000;
        }
      }
    }
    if (attachedState.terminal || attachedChild?.status === 'cancelling') {
      cancellationReason ??=
        attachedChild?.cancelReason ??
        (attachedState.terminal
          ? `mission ${attachedState.terminal.outcome}: ${attachedState.terminal.reason}`
          : 'cancellation requested');
    }

    if (!cancellationReason && execution.activate) {
      try {
        await execution.activate();
        // Publication/attachment is control-plane latency, not child active time. The deferred
        // execution starts charging only after its launch-edge re-attestation has completed.
        activeStartedAt = performance.now();
        registered.activeStartedAt = activeStartedAt;
        if (activeLimit !== null && baseline.activeSeconds !== null) {
          const observed = Math.max(
            baseline.activeSeconds,
            attachedChild?.usage.activeSeconds ?? baseline.activeSeconds,
          );
          activeTimeoutMs = Math.max(0, activeLimit - observed) * 1_000;
        }
        // A cancellation may have become durable while activation was re-attesting authority.
        attachedState = await this.load(currentState.missionId);
        attachedChild = attachedState.children[child.childId];
        if (attachedState.terminal || attachedChild?.status === 'cancelling') {
          cancellationReason =
            attachedChild?.cancelReason ??
            (attachedState.terminal
              ? `mission ${attachedState.terminal.outcome}: ${attachedState.terminal.reason}`
              : 'cancellation requested');
        }
      } catch (error) {
        // A synchronous driver-start failure may have crossed an opaque vendor spawn boundary.
        // Keep the execution registered and the durable reservation ambiguous; owner-death or
        // exact registry reconciliation is the only authority for a future replacement.
        void this.cancelExecutionOnce(execution, `child activation is ambiguous: ${String(error)}`).catch(
          () => undefined,
        );
        durableWatchAbort.abort();
        await durableWatch;
        return {
          state: await this.load(currentState.missionId),
          recoverable: true,
          error: `child activation is ambiguous and remains registered: ${String(error)}`,
        };
      }
    }

    if (cancellationReason) {
      if (attachedChild && !childIsTerminal(attachedChild.status) && attachedChild.status !== 'cancelling') {
        attachedState = await this.requestChildCancellation(attachedState, attachedChild, cancellationReason);
        attachedChild = attachedState.children[child.childId];
      }
      cancellationReason = attachedChild?.cancelReason ?? cancellationReason;
      void this.cancelExecutionOnce(execution, cancellationReason).catch(() => undefined);
    }

    let settlement: PromiseSettledResult<MissionChildResult> | null = null;
    let unsettledReason: string | null = null;
    registered.beginSettlement();
    try {
      if (cancellationReason) {
        settlement = await this.waitForChildSettlement(registered, this.cancelGraceMs);
        unsettledReason = `child did not settle within ${this.cancelGraceMs}ms after cancellation`;
      } else {
        const first = await withTimeout(
          Promise.race([
            registered.settlement.then((value) => ({ kind: 'settled' as const, value })),
            durableWatch.then((reason) => ({ kind: 'durable-control' as const, reason })),
          ]),
          activeTimeoutMs,
        );
        if (first.kind === 'settled') {
          settlement = first.value;
        } else if (first.reason) {
          cancellationReason = first.reason;
          settlement = await this.waitForChildSettlement(registered, this.cancelGraceMs);
          unsettledReason = `child did not settle within ${this.cancelGraceMs}ms after durable cancellation`;
        }
      }
    } catch (error) {
      if (!(error instanceof MissionOperationTimeoutError)) {
        unsettledReason = `child settlement observation failed: ${String(error)}`;
      } else {
        let latest = await this.load(state.missionId);
        const current = latest.children[child.childId];
        cancellationReason = 'child execution timed out at its remaining active-time budget';
        if (current && !childIsTerminal(current.status) && current.status !== 'cancelling') {
          latest = await this.requestChildCancellation(latest, current, cancellationReason);
          cancellationReason = latest.children[child.childId]?.cancelReason ?? cancellationReason;
        }
        void this.cancelExecutionOnce(execution, cancellationReason).catch(() => undefined);
        settlement = await this.waitForChildSettlement(registered, this.cancelGraceMs);
        unsettledReason = `child did not settle within ${this.cancelGraceMs}ms after active-time cancellation`;
      }
    } finally {
      durableWatchAbort.abort();
      await durableWatch;
    }

    if (!settlement) {
      return {
        state: await this.load(state.missionId),
        recoverable: true,
        error: `${unsettledReason ?? 'child cancellation settlement is ambiguous'}; attempt '${execution.attemptId}' remains registered and no replacement may launch`,
      };
    }

    const elapsedActive = Math.max(
      0,
      ((registered.settledAt ?? performance.now()) - activeStartedAt) / 1_000,
    );
    const settledResult: MissionChildResult =
      settlement.status === 'fulfilled'
        ? settlement.value
        : {
            outcome: 'lost',
            summary: `child registry reported a settled execution failure: ${String(settlement.reason)}`,
            usage: observedUsage(undefined, elapsedActive, baseline, baseline.activeSeconds),
          };
    const fresh = await this.load(state.missionId);
    const current = fresh.children[child.childId];
    if (!current || childIsTerminal(current.status)) {
      if (this.activeExecutions.get(currentState.missionId) === registered) {
        this.activeExecutions.delete(currentState.missionId);
      }
      this.cancellationPromises.delete(execution.attemptId);
      return { state: fresh };
    }
    const finalCancellationReason =
      cancellationReason ??
      (current.status === 'cancelling' ? current.cancelReason : null) ??
      (fresh.terminal ? `mission ${fresh.terminal.outcome}: ${fresh.terminal.reason}` : null);
    const result: MissionChildResult =
      finalCancellationReason && settledResult.outcome === 'succeeded'
        ? {
            outcome: 'cancelled',
            summary: `child settled successfully only after cancellation was requested: ${bounded(
              finalCancellationReason,
              16_384,
            )}`,
            usage: settledResult.usage,
          }
        : settledResult;
    const finalUsage = observedUsage(result.usage, elapsedActive, current.usage, baseline.activeSeconds);
    const completed = await this.commit(
      fresh,
      effectId('complete-child', fresh.missionId, child.childId, child.attemptId),
      {
        type: 'complete-child',
        childId: child.childId,
        outcome: result.outcome,
        summary: bounded(result.summary, MAX_RESULT_SUMMARY_CHARS),
        usage: finalUsage,
        ...(result.artifact ? { artifact: result.artifact } : {}),
      },
    );
    if (!completed.accepted) {
      return { state: completed.state, error: `child result could not be journaled: ${completed.reason}` };
    }
    if (this.activeExecutions.get(currentState.missionId) === registered) {
      this.activeExecutions.delete(currentState.missionId);
    }
    this.cancellationPromises.delete(execution.attemptId);
    return { state: completed.state };
  }

  private async completeChildAsLost(
    state: MissionState,
    child: MissionChildState,
    reason: string,
  ): Promise<ChildRunResult> {
    const fresh = await this.load(state.missionId);
    const current = fresh.children[child.childId];
    if (!current || childIsTerminal(current.status)) return { state: fresh };
    const completed = await this.commit(
      fresh,
      effectId('complete-child', fresh.missionId, child.childId, child.attemptId ?? 'unstarted'),
      {
        type: 'complete-child',
        childId: child.childId,
        outcome: 'lost',
        summary: bounded(reason, MAX_RESULT_SUMMARY_CHARS),
        // A definitive attach error promises the external attempt never existed, so no unknown
        // model spend was incurred. Ambiguous errors never reach this path and remain retryable.
        usage: current.usage,
      },
    );
    return completed.accepted
      ? { state: completed.state }
      : { state: completed.state, error: `lost child could not be journaled: ${completed.reason}` };
  }

  private async observeChildUsage(
    missionId: string,
    childId: string,
    usage: MissionUsage,
  ): Promise<MissionUsageDisposition> {
    let state = await this.load(missionId);
    for (let retry = 0; retry < MAX_CANCEL_COMMIT_ATTEMPTS; retry += 1) {
      const child = state.children[childId];
      if (!child || childIsTerminal(child.status)) return 'cancel';
      const observed = await this.commit(state, effectId('child-usage', missionId, childId, usage), {
        type: 'observe-child-usage',
        childId,
        usage,
      });
      state = observed.state;
      if (!observed.accepted) {
        if (observed.reason.startsWith('concurrent mission update:')) continue;
        const current = state.children[childId];
        if (current && !childIsTerminal(current.status) && current.status !== 'cancelling') {
          await this.requestChildCancellation(
            state,
            current,
            `child usage observation was refused: ${bounded(observed.reason, 8_192)}`,
          );
        }
        return 'cancel';
      }
      const constrained = Object.values(state.budgetConstraints).some(
        (constraint) =>
          constraint.scope === 'mission' || (constraint.scope === 'child' && constraint.childId === childId),
      );
      if (!constrained) return 'continue';
      const current = state.children[childId];
      if (current && !childIsTerminal(current.status) && current.status !== 'cancelling') {
        await this.requestChildCancellation(state, current, 'durable budget constraint triggered');
      }
      return 'cancel';
    }
    const current = state.children[childId];
    if (current && !childIsTerminal(current.status) && current.status !== 'cancelling') {
      await this.requestChildCancellation(
        state,
        current,
        'child usage observation could not win a durable revision',
      );
    }
    return 'cancel';
  }

  /** Driver callbacks may arrive back-to-back; serialize them so cumulative high-water writes do
   * not race each other and turn a real over-budget observation into a recoverable CAS conflict. */
  private queueChildUsage(
    missionId: string,
    childId: string,
    usage: MissionUsage,
  ): Promise<MissionUsageDisposition> {
    const key = `${missionId}:${childId}`;
    const previous = this.usageQueues.get(key) ?? Promise.resolve<MissionUsageDisposition>('continue');
    const next = previous.then(
      () => this.observeChildUsage(missionId, childId, usage),
      () => 'cancel' as const,
    );
    this.usageQueues.set(key, next);
    void next.then(
      () => {
        if (this.usageQueues.get(key) === next) this.usageQueues.delete(key);
      },
      () => {
        if (this.usageQueues.get(key) === next) this.usageQueues.delete(key);
      },
    );
    return next;
  }

  private async requestChildCancellation(
    state: MissionState,
    child: MissionChildState,
    reason: string,
  ): Promise<MissionState> {
    let currentState = state;
    for (let retry = 0; retry < MAX_CANCEL_COMMIT_ATTEMPTS; retry += 1) {
      const currentChild = currentState.children[child.childId];
      if (!currentChild || childIsTerminal(currentChild.status) || currentChild.status === 'cancelling') {
        return currentState;
      }
      const cancelled = await this.commit(
        currentState,
        effectId('request-child-cancel', currentState.missionId, child.childId, reason),
        {
          type: 'request-child-cancel',
          guideEpoch: currentState.guideEpoch,
          childId: child.childId,
          reason: bounded(reason, 16_384),
        },
      );
      currentState = cancelled.state;
      if (cancelled.accepted) return currentState;
      if (!cancelled.reason.startsWith('concurrent mission update:')) return currentState;
    }
    return currentState;
  }

  private async reconcileEvidence(
    state: MissionState,
  ): Promise<{ state: MissionState } | { state: MissionState; error: string }> {
    let currentState = state;
    const child = missionChildrenInOrder(currentState).find((candidate) => {
      if (candidate.permission === 'write') {
        return (
          childIsTerminal(candidate.status) &&
          workspaceReconciliationForChild(currentState, candidate) === null
        );
      }
      if (candidate.status === 'succeeded' && candidate.subjectCheckpointId) {
        return !Object.values(currentState.reviews).some(
          (review) =>
            review.reviewerChildId === candidate.childId &&
            review.checkpointId === candidate.subjectCheckpointId,
        );
      }
      return false;
    });
    if (!child) return { state: currentState };
    if (!this.options.evidence) {
      return child.permission === 'write'
        ? {
            state: currentState,
            error: `evidence adapter is unavailable while terminal write child '${child.childId}' requires workspace reconciliation`,
          }
        : { state: currentState };
    }
    const authoredCheckpoint = Object.values(currentState.checkpoints).find(
      (checkpoint) => checkpoint.authorChildId === child.childId,
    );
    const writeNeedsCheckpoint =
      child.permission === 'write' && child.status === 'succeeded' && !authoredCheckpoint;
    if (child.permission === 'read' && child.subjectCheckpointId) {
      const artifact = child.artifact?.type === 'review' ? child.artifact : null;
      const checkpoint = currentState.checkpoints[child.subjectCheckpointId];
      if (!artifact || !checkpoint) {
        return {
          state: currentState,
          error: `review child '${child.childId}' produced no machine-validated review artifact`,
        };
      }
      if (
        artifact.checkpointId !== child.subjectCheckpointId ||
        artifact.revisionId !== checkpoint.revisionId
      ) {
        return {
          state: currentState,
          error: `review artifact for '${child.childId}' does not match its exact durable subject`,
        };
      }
    }
    const attemptKey = `${currentState.missionId}:${child.childId}:${currentState.revision}`;
    if (this.evidenceAttempted.has(attemptKey)) return { state: currentState };
    this.evidenceAttempted.add(attemptKey);
    let actions: readonly MissionEvidenceAction[];
    try {
      actions = await this.options.evidence.recordAfterChild(currentState, child);
    } catch (error) {
      this.evidenceAttempted.delete(attemptKey);
      return {
        state: currentState,
        error: `evidence recording failed for '${child.childId}': ${String(error)}`,
      };
    }
    if (actions.length !== 1) {
      return {
        state: currentState,
        error: `evidence recorder returned ${actions.length} actions for '${child.childId}'; exactly one is required`,
      };
    }
    for (const action of actions) {
      if (
        writeNeedsCheckpoint &&
        (action.type !== 'record-checkpoint' || action.authorChildId !== child.childId)
      ) {
        return {
          state: currentState,
          error: `write child '${child.childId}' requires exactly one checkpoint attributed to itself`,
        };
      }
      if (
        child.permission === 'write' &&
        !writeNeedsCheckpoint &&
        (action.type !== 'record-workspace-reconciled' || action.childId !== child.childId)
      ) {
        return {
          state: currentState,
          error: `terminal write child '${child.childId}' requires exactly one trusted workspace reconciliation action`,
        };
      }
      if (child.permission === 'read' && action.type !== 'record-review') {
        return {
          state: currentState,
          error: `review child '${child.childId}' requires exactly one review attributed to itself`,
        };
      }
      if (action.type === 'record-review') {
        const artifact = child.artifact?.type === 'review' ? child.artifact : null;
        if (
          !artifact ||
          action.reviewerChildId !== child.childId ||
          action.checkpointId !== artifact.checkpointId ||
          action.revisionId !== artifact.revisionId ||
          action.verdict !== artifact.verdict ||
          action.highestSeverity !== artifact.highestSeverity ||
          action.summary !== artifact.summary
        ) {
          return {
            state: currentState,
            error: `evidence recorder review does not exactly match '${child.childId}' artifact`,
          };
        }
      }
      const committed = await this.commit(
        currentState,
        effectId('record-evidence', currentState.missionId, child.childId, action),
        action,
      );
      if (!committed.accepted) {
        this.evidenceAttempted.delete(attemptKey);
        return { state: committed.state, error: `evidence was refused: ${committed.reason}` };
      }
      currentState = committed.state;
    }
    return { state: currentState };
  }

  /**
   * Release external capacities only after the process attempt is terminal. Writers additionally
   * need durable clean-workspace evidence, so another mission cannot acquire the same editor or
   * checkout while failed residue still owns its state. The coordinator is idempotent and this
   * scan intentionally repeats after restart.
   */
  private async releaseSettledResources(state: MissionState): Promise<string | null> {
    for (const child of missionChildrenInOrder(state)) {
      if (
        !childIsTerminal(child.status) ||
        child.attemptId === null ||
        !Object.keys(child.resources).some(isExternalMissionResourceKey)
      ) {
        continue;
      }
      if (child.permission === 'write' && workspaceReconciliationForChild(state, child) === null) {
        continue;
      }
      if (!this.options.resources) {
        return `resource-bearing child '${child.childId}' has no durable cross-mission resource coordinator`;
      }
      try {
        await this.options.resources.release(state, child);
      } catch (error) {
        return `global resource release failed for '${child.childId}': ${String(error)}`;
      }
    }
    return null;
  }

  /**
   * Validation is an evidence phase, not a guide action. Run it only when the latest checkpoint is
   * clean and deterministic plan scheduling has no unresolved work. A durable result for the same
   * checkpoint/revision/policy is never executed again after restart. A durable attempt found
   * without this controller's in-memory ownership is restored and settled failed without rerunning
   * the command. Failed validation remains visible to the next guide so it can choose repair,
   * replan, or an honest terminal disposition.
   */
  private async reconcileValidation(
    state: MissionState,
  ): Promise<{ state: MissionState } | { state: MissionState; error: string }> {
    const checkpoint = latestCheckpoint(state);
    if (checkpoint && !checkpoint.clean) return { state };
    if (unresolvedActiveMissionPlan(state)) return { state };
    const policy = state.validationPolicy;
    if (!policy) return { state, error: 'mission has no durable deterministic validation policy' };
    if (!checkpoint && policy.kind === 'command') return { state };
    const alreadyRecorded = state.validationOrder
      .map((validationId) => ownMissionValue(state.validations, validationId))
      .some(
        (validation) =>
          validation !== undefined &&
          validation.checkpointId === (checkpoint?.checkpointId ?? null) &&
          validation.revisionId === (checkpoint?.revisionId ?? null) &&
          validation.policyId === policy.policyId,
      );
    if (alreadyRecorded) return { state };
    let action: RecordValidationAction;
    let commitState = state;
    if (policy.kind === 'none') {
      action = {
        type: 'record-validation',
        validationId: effectId(
          'validation',
          state.missionId,
          checkpoint?.checkpointId ?? null,
          checkpoint?.revisionId ?? null,
          policy.policyId,
        ),
        checkpointId: checkpoint?.checkpointId ?? null,
        revisionId: checkpoint?.revisionId ?? null,
        policyId: policy.policyId,
        disposition: 'not-applicable',
        exitCode: null,
        timedOut: false,
        workspaceChanged: false,
        outputTail: utf8Tail(policy.reason, MAX_MISSION_VALIDATION_OUTPUT_BYTES),
      };
    } else {
      if (!this.options.validation) {
        return { state, error: 'deterministic validation executor is unavailable for the clean checkpoint' };
      }
      const validationId = effectId(
        'validation',
        state.missionId,
        checkpoint!.checkpointId,
        checkpoint!.revisionId,
        policy.policyId,
      );
      let currentState = state;
      let startedByThisController = false;
      if (currentState.activeValidation === null) {
        const beginAction: BeginValidationAction = {
          type: 'begin-validation',
          validationId,
          checkpointId: checkpoint!.checkpointId,
          revisionId: checkpoint!.revisionId,
          policyId: policy.policyId,
        };
        const begun = await this.commit(
          currentState,
          effectId('begin-validation', currentState.missionId, validationId),
          beginAction,
        );
        if (!begun.accepted) {
          return {
            state: begun.state,
            error: `deterministic validation attempt was refused: ${begun.reason}`,
          };
        }
        currentState = begun.state;
        startedByThisController = true;
      } else if (
        currentState.activeValidation.validationId !== validationId ||
        currentState.activeValidation.checkpointId !== checkpoint!.checkpointId ||
        currentState.activeValidation.revisionId !== checkpoint!.revisionId ||
        currentState.activeValidation.policyId !== policy.policyId
      ) {
        return { state: currentState, error: 'durable validation attempt does not match current authority' };
      }
      if (!startedByThisController) {
        try {
          action = await this.options.validation.recover(currentState, checkpoint!, policy);
        } catch (error) {
          return {
            state: currentState,
            error: `interrupted deterministic validation recovery failed: ${String(error)}`,
          };
        }
      } else {
        const abort = new AbortController();
        this.activeValidationAborts.set(currentState.missionId, abort);
        try {
          action = await this.options.validation.validate(currentState, checkpoint!, policy, abort.signal);
        } catch (validationError) {
          // Cancellation or another writer may have terminalized the mission while the contained
          // validator was settling. Reload authority before reporting anything, then conservatively
          // restore and record this durably-started attempt as failed without another command run.
          const fresh = await this.load(currentState.missionId);
          if (fresh.activeValidation === null) return { state: fresh };
          if (
            fresh.activeValidation.validationId !== validationId ||
            fresh.activeValidation.checkpointId !== checkpoint!.checkpointId ||
            fresh.activeValidation.revisionId !== checkpoint!.revisionId ||
            fresh.activeValidation.policyId !== policy.policyId
          ) {
            return {
              state: fresh,
              error: `deterministic validation failed under changed durable authority: ${String(validationError)}`,
            };
          }
          try {
            action = await this.options.validation.recover(fresh, checkpoint!, policy);
            currentState = fresh;
          } catch (recoveryError) {
            return {
              state: fresh,
              error: `deterministic validation failed to settle (${String(validationError)}); recovery also failed: ${String(recoveryError)}`,
            };
          }
        } finally {
          if (this.activeValidationAborts.get(currentState.missionId) === abort) {
            this.activeValidationAborts.delete(currentState.missionId);
          }
        }
      }
      commitState = currentState;
    }
    const committed = await this.commit(
      commitState,
      effectId(
        'record-validation',
        commitState.missionId,
        checkpoint?.checkpointId ?? null,
        checkpoint?.revisionId ?? null,
        policy.policyId,
        action,
      ),
      action,
    );
    return committed.accepted
      ? { state: committed.state }
      : { state: committed.state, error: `deterministic validation was refused: ${committed.reason}` };
  }

  /**
   * Execute an adopted plan in deterministic sequence. The guide is consulted only when a step
   * fails, a high/critical review or exhausted bounded repairs requires replanning, or every
   * adopted step has reached accepted evidence.
   */
  private async reconcileActivePlan(state: MissionState): Promise<PlanRunResult> {
    const activePlan = state.activePlan;
    if (!activePlan) return { state };
    for (const step of activePlan.plan.steps) {
      const stepKey = missionPlanStepKey(state.missionId, activePlan.plannerChildId, step.id);
      const workers = missionChildrenInOrder(state).filter(
        (child) => child.planStepId === stepKey && child.subjectCheckpointId === null,
      );
      if (workers.length > MAX_MISSION_PLAN_REPAIR_ROUNDS + 1) {
        return {
          state,
          error: `adopted plan step '${step.id}' exceeded its bounded repair lineage`,
        };
      }
      const round = Math.max(0, workers.length - 1);
      const workId = missionPlanChildId(state.missionId, activePlan.plannerChildId, step.id, 'work', round);
      const worker = workers.at(-1);
      if (!worker) {
        const translated = translateMissionGuideAction(
          state,
          effectId('plan-dispatch', state.missionId, activePlan.plannerChildId, step.id),
          state.guideEpoch,
          {
            type: 'dispatch_child',
            childId: workId,
            profileId: step.profileId,
            instruction: [
              `Adopted execution-plan step: ${step.id}`,
              `Title: ${step.title}`,
              step.instruction,
              'Acceptance criteria:',
              ...step.acceptance.map((criterion, index) => `${index + 1}. ${criterion}`),
            ].join('\n'),
          },
        );
        if (!translated.ok) {
          return {
            state,
            error: `adopted plan step '${step.id}' is no longer dispatchable: ${translated.reason}`,
          };
        }
        const spawned = await this.commit(
          state,
          effectId('plan-spawn-work', state.missionId, activePlan.plannerChildId, step.id),
          withTrustedPlanStep(translated.action, stepKey),
        );
        return spawned.accepted
          ? { state: spawned.state }
          : { state: spawned.state, error: `adopted plan work was refused: ${spawned.reason}` };
      }
      if (!childIsTerminal(worker.status)) return { state };
      if (worker.status !== 'succeeded') return { state };

      const checkpoint = Object.values(state.checkpoints).find(
        (candidate) => candidate.authorChildId === worker.childId,
      );
      // A dirty checkpoint is durable evidence that the step is not reviewable or complete. Stop
      // deterministic scheduling and return control to the guide; never advance to review/later
      // work while uncommitted mutations may still share the workspace.
      if (worker.permission === 'write' && (!checkpoint || !checkpoint.clean)) return { state };
      if (!step.reviewProfileId) continue;
      if (!checkpoint) return { state };
      const reviewId = missionPlanChildId(
        state.missionId,
        activePlan.plannerChildId,
        step.id,
        'review',
        round,
      );
      const reviewer = ownMissionValue(state.children, reviewId);
      if (!reviewer) {
        const translated = translateMissionGuideAction(
          state,
          effectId(
            'plan-review-dispatch',
            state.missionId,
            activePlan.plannerChildId,
            step.id,
            ...(round === 0 ? [] : [round]),
          ),
          state.guideEpoch,
          {
            type: 'dispatch_child',
            childId: reviewId,
            profileId: step.reviewProfileId,
            subjectCheckpointId: checkpoint.checkpointId,
            instruction: [
              `Review adopted execution-plan step: ${step.id}`,
              `Title: ${step.title}`,
              'Acceptance criteria:',
              ...step.acceptance.map((criterion, index) => `${index + 1}. ${criterion}`),
            ].join('\n'),
          },
        );
        if (!translated.ok) {
          return {
            state,
            error: `adopted plan review '${step.id}' is no longer dispatchable: ${translated.reason}`,
          };
        }
        const spawned = await this.commit(
          state,
          effectId(
            'plan-spawn-review',
            state.missionId,
            activePlan.plannerChildId,
            step.id,
            ...(round === 0 ? [] : [round]),
          ),
          withTrustedPlanStep(translated.action, stepKey),
        );
        return spawned.accepted
          ? { state: spawned.state }
          : { state: spawned.state, error: `adopted plan review was refused: ${spawned.reason}` };
      }
      if (!childIsTerminal(reviewer.status)) return { state };
      if (reviewer.status !== 'succeeded') return { state };
      const review = governingReviewForCheckpoint(state, checkpoint.checkpointId);
      if (!review || review.reviewerChildId !== reviewer.childId) {
        return { state };
      }
      if (review.verdict === 'passed' && review.highestSeverity === 'none') continue;
      if (
        review.verdict === 'changes-requested' &&
        ['low', 'medium'].includes(review.highestSeverity) &&
        round < MAX_MISSION_PLAN_REPAIR_ROUNDS
      ) {
        const repairRound = round + 1;
        const repairId = missionPlanChildId(
          state.missionId,
          activePlan.plannerChildId,
          step.id,
          'work',
          repairRound,
        );
        const translated = translateMissionGuideAction(
          state,
          effectId('plan-repair-dispatch', state.missionId, activePlan.plannerChildId, step.id, repairRound),
          state.guideEpoch,
          {
            type: 'dispatch_child',
            childId: repairId,
            profileId: step.profileId,
            instruction: [
              `Repair adopted execution-plan step: ${step.id}`,
              `Repair round: ${repairRound} of ${MAX_MISSION_PLAN_REPAIR_ROUNDS}`,
              `Title: ${step.title}`,
              `The exact prior checkpoint ${checkpoint.checkpointId} at revision ${checkpoint.revisionId} received a ${review.highestSeverity} changes-requested review.`,
              'Review findings to repair:',
              review.summary,
              'Original step instruction:',
              step.instruction,
              'Acceptance criteria:',
              ...step.acceptance.map((criterion, index) => `${index + 1}. ${criterion}`),
              'Make only the bounded repair. Leave one new clean immutable checkpoint for exact re-review.',
            ].join('\n'),
          },
        );
        if (!translated.ok) {
          return {
            state,
            error: `adopted plan repair '${step.id}' is no longer dispatchable: ${translated.reason}`,
          };
        }
        const spawned = await this.commit(
          state,
          effectId('plan-spawn-repair', state.missionId, activePlan.plannerChildId, step.id, repairRound),
          withTrustedPlanStep(translated.action, stepKey),
        );
        return spawned.accepted
          ? { state: spawned.state }
          : { state: spawned.state, error: `adopted plan repair was refused: ${spawned.reason}` };
      }
      // High/critical findings, exhausted low/medium repairs, and any inconsistent verdict return
      // unchanged durable state to the guide for a replacement plan or final disposition.
      return { state };
    }
    return { state };
  }

  private async failMission(state: MissionState, reason: string): Promise<MissionState> {
    if (state.terminal) return state;
    const completed = await this.commit(
      state,
      effectId('fail-mission', state.missionId, state.guideEpoch, reason),
      {
        type: 'complete-mission',
        guideEpoch: state.guideEpoch,
        outcome: 'failed',
        reason: bounded(reason, MAX_RESULT_SUMMARY_CHARS),
      },
    );
    return completed.state;
  }

  private async reconcileTerminal(state: MissionState): Promise<{ state: MissionState; error?: string }> {
    let currentState = state;
    const runningTurn = Object.values(currentState.guideTurns).find((turn) => turn.status === 'running');
    if (runningTurn) {
      const attempt = this.activeGuideAttempts.get(currentState.missionId);
      if (!attempt || attempt.turnId !== runningTurn.turnId) {
        if (!this.options.guideOwnerDeathProof?.ownerDeathTerminatesProcessTree) {
          return {
            state: currentState,
            error: `terminal mission still has unclassified guide attempt '${runningTurn.turnId}'; restart reconciliation requires an external attempt registry or owner-death process-tree proof`,
          };
        }
        currentState = await this.loseRunningGuideTurn(currentState, runningTurn.turnId);
        if (currentState.guideTurns[runningTurn.turnId]?.status === 'running') {
          return {
            state: currentState,
            error: `terminal guide attempt '${runningTurn.turnId}' could not be finalized as lost`,
          };
        }
      } else {
        attempt.abort.abort();
        const settlement = await this.waitForGuideSettlement(attempt);
        if (!settlement) {
          return {
            state: currentState,
            error: `terminal mission is waiting for guide attempt '${runningTurn.turnId}' to acknowledge cancellation`,
          };
        }
        const completed = await this.completeGuideAttempt(attempt, settlement);
        currentState = completed.state;
        if ('error' in completed) return { state: currentState, error: completed.error };
      }
    }
    for (;;) {
      const active = missionChildrenInOrder(currentState).find((child) => !childIsTerminal(child.status));
      if (!active) break;
      if (!active.attemptId) {
        const completed = await this.commit(
          currentState,
          effectId('terminal-child', currentState.missionId, active.childId),
          {
            type: 'complete-child',
            childId: active.childId,
            outcome: 'cancelled',
            summary: 'Mission terminalized before the child attempt started.',
            usage: active.usage,
          },
        );
        currentState = completed.state;
        if (!completed.accepted) break;
        continue;
      }
      const result = await this.runChild(currentState, active);
      currentState = result.state;
      if ('error' in result) return { state: currentState, error: result.error };
    }

    if (currentState.activeValidation) {
      const checkpoint = ownMissionValue(
        currentState.checkpoints,
        currentState.activeValidation.checkpointId,
      );
      const policy = currentState.validationPolicy;
      if (!checkpoint || !policy || policy.kind !== 'command' || !this.options.validation) {
        return {
          state: currentState,
          error: 'terminal mission has an active validation attempt without recoverable authority',
        };
      }
      let action: RecordValidationAction;
      try {
        action = await this.options.validation.recover(currentState, checkpoint, policy);
      } catch (error) {
        return { state: currentState, error: `terminal validation recovery failed: ${String(error)}` };
      }
      const recorded = await this.commit(
        currentState,
        effectId(
          'record-validation',
          currentState.missionId,
          checkpoint.checkpointId,
          checkpoint.revisionId,
          policy.policyId,
          action,
        ),
        action,
      );
      currentState = recorded.state;
      if (!recorded.accepted) {
        return {
          state: currentState,
          error: `terminal validation recovery was refused: ${recorded.reason}`,
        };
      }
    }

    // Logical terminalization does not make a contaminated shared workspace safe. Settle every
    // terminal write child's checkpoint/reconciliation proof before cleanup can release or reuse
    // that workspace. Transient evidence failures leave the durable obligation discoverable for
    // the next reconciliation run.
    for (;;) {
      const contaminatedBy = unreconciledTerminalWriteChild(currentState);
      if (!contaminatedBy) break;
      const reconciled = await this.reconcileEvidence(currentState);
      currentState = reconciled.state;
      if ('error' in reconciled) return { state: currentState, error: reconciled.error };
      if (unreconciledTerminalWriteChild(currentState)?.childId === contaminatedBy.childId) {
        return {
          state: currentState,
          error: `terminal write child '${contaminatedBy.childId}' remains unreconciled after evidence recording`,
        };
      }
    }

    const resourceError = await this.releaseSettledResources(currentState);
    if (resourceError) return { state: currentState, error: resourceError };

    if (!this.options.cleanup) {
      const pending = currentState.cleanupPlan.filter(
        (cleanupId) => currentState.cleanup[cleanupId]?.status !== 'completed',
      );
      if (pending.length > 0) {
        return {
          state: currentState,
          error: `cleanup executor is unavailable for durable obligations: ${pending.join(', ')}`,
        };
      }
    } else {
      for (const cleanupId of currentState.cleanupPlan) {
        const obligation = currentState.cleanup[cleanupId];
        if (!obligation || obligation.status === 'completed') continue;
        try {
          // Do not abandon a cleanup promise and then release the controller lease: a timed-out
          // operation could still mutate external state while the next controller retries it.
          await this.options.cleanup.execute(currentState, cleanupId);
          const completed = await this.commit(
            currentState,
            effectId('complete-cleanup', currentState.missionId, cleanupId),
            {
              type: 'complete-cleanup',
              cleanupId,
            },
          );
          currentState = completed.state;
        } catch (error) {
          const failed = await this.commit(
            currentState,
            effectId('fail-cleanup', currentState.missionId, cleanupId, String(error)),
            {
              type: 'fail-cleanup',
              cleanupId,
              error: bounded(String(error), 16_384),
            },
          );
          currentState = failed.state;
        }
      }
    }
    const unfinished = currentState.cleanupPlan.filter(
      (cleanupId) => currentState.cleanup[cleanupId]?.status !== 'completed',
    );
    if (unfinished.length > 0) {
      return {
        state: currentState,
        error: `durable cleanup obligations remain incomplete: ${unfinished.join(', ')}`,
      };
    }

    if (
      currentState.terminal?.outcome === 'succeeded' &&
      currentState.terminal.checkpointId !== null &&
      currentState.acceptedRevisionHandoff === null
    ) {
      if (!this.options.acceptedRevisionHandoff) {
        return {
          state: currentState,
          error: 'accepted-revision handoff recorder is unavailable after successful cleanup',
        };
      }
      let action: RecordAcceptedRevisionHandoffAction | null;
      try {
        action = await this.options.acceptedRevisionHandoff.record(currentState);
      } catch (error) {
        return { state: currentState, error: `accepted-revision handoff failed: ${String(error)}` };
      }
      if (!action) {
        return {
          state: currentState,
          error: 'accepted-revision handoff recorder produced no preserved reference',
        };
      }
      const recorded = await this.commit(
        currentState,
        effectId(
          'record-accepted-revision-handoff',
          currentState.missionId,
          currentState.terminal.checkpointId,
          action,
        ),
        action,
      );
      currentState = recorded.state;
      if (!recorded.accepted) {
        return {
          state: currentState,
          error: `accepted-revision handoff was refused: ${recorded.reason}`,
        };
      }
    }

    return { state: currentState };
  }
}

export function isMissionConcurrencyConflict(error: unknown): error is MissionStoreConflictError {
  return error instanceof MissionStoreConflictError && error.kind === 'revision';
}
