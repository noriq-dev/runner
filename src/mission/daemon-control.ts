import { createHash } from 'node:crypto';
import {
  MissionAdoptionResult as MissionAdoptionResultSchema,
  MissionHandoffAck as MissionHandoffAckSchema,
  MissionHandoffConsumed as MissionHandoffConsumedSchema,
  MissionInventoryItem as MissionInventoryItemSchema,
  MissionQuestionAck as MissionQuestionAckSchema,
  MissionQuestionAnswer as MissionQuestionAnswerSchema,
  MissionTaskAck as MissionTaskAckSchema,
} from '@noriq-dev/shared';
import type {
  MissionAdoptionResult,
  MissionHandoffAck,
  MissionHandoffConsumed,
  MissionInventoryItem,
  MissionQuestionAck,
  MissionQuestionAnswer,
  MissionTaskAck,
} from '@noriq-dev/shared';
import { z } from 'zod';
import type { logger as Logger } from '../logger';
import type { NoriqMissionCommission } from './noriq-coordinator-store';
import type { WsMissionCoordinatorTransport } from './noriq-transport';

export const MAX_DAEMON_MISSION_RECONCILIATION_ROOTS = 128;

/** Process-local identity for one exact, negotiated WebSocket connection. */
export type MissionTransportGeneration = number;

const RETRYABLE_CONTROL_STOPS = new Set([
  'runtime-error',
  'transport-error',
  // The disputed task remains durably reserved; a fresh socket is how Noriq re-inventories it and
  // returns an authoritative adopt/cancel/already-terminal disposition instead of stranding it.
  'authority-conflict',
]);
const MissionReconciliationDeadlineSchema = z.string().datetime();

type MissionDaemonLogger = Pick<typeof Logger, 'debug' | 'info' | 'warn' | 'error'>;

export interface MissionReconciliationRequest {
  readonly deadline: string;
  readonly items: readonly MissionInventoryItem[];
}

/**
 * Deliberately structural: daemon wiring does not need authority over coordinator construction or
 * its model/runtime internals. Every method used during startup and reconciliation is model-free
 * except the explicitly backgrounded `control` call after exact server adoption.
 */
export interface DaemonMissionCoordinatorLike {
  commission?(commission: NoriqMissionCommission): Promise<unknown>;
  inventoryAll(): Promise<readonly MissionInventoryItem[]>;
  reservedRootRunIds(): Promise<readonly string[]>;
  adopt(result: MissionAdoptionResult): Promise<unknown>;
  control(rootRunId: string): Promise<unknown>;
  answer?(rootRunId: string, questionId: string, answer: string): Promise<unknown>;
  inspect?(rootRunId: string): Promise<unknown>;
  recordQuestionPublication?(
    rootRunId: string,
    questionId: string,
    reportId: string,
    signalId: string,
  ): Promise<unknown>;
  recordHandoffPublication?(rootRunId: string, reportId: string, handoffId: string): Promise<unknown>;
  cancel(rootRunId: string, reason: string): Promise<unknown>;
  /** Optional graceful process/runtime quiescence. It must not terminal-cancel the mission. */
  quiesce?(): void | Promise<void>;
  /** Revoke the current socket generation and stop active model/tool trees nonterminally. */
  quarantineAll?(reason: string): void | Promise<void>;
}

export type DaemonMissionAckTransport = Pick<WsMissionCoordinatorTransport, 'acknowledge' | 'stop'> &
  Partial<
    Pick<WsMissionCoordinatorTransport, 'acknowledgeQuestion' | 'acknowledgeHandoff' | 'question' | 'handoff'>
  >;

export type MissionDaemonFatalCode =
  | 'MISSION_RECONCILIATION_INVALID'
  | 'MISSION_RECONCILIATION_EXPIRED'
  | 'MISSION_INVENTORY_INVALID'
  | 'MISSION_INVENTORY_READ_FAILED'
  | 'MISSION_RECONCILIATION_SEND_FAILED'
  | 'MISSION_ADOPTION_FAILED'
  | 'MISSION_CONTROL_REJECTED'
  | 'MISSION_QUIESCE_FAILED';

export class MissionDaemonControlFatalError extends Error {
  constructor(readonly code: MissionDaemonFatalCode) {
    super(code);
    this.name = 'MissionDaemonControlFatalError';
  }
}

export interface MissionDaemonControlOptions {
  coordinator: DaemonMissionCoordinatorLike;
  transport: DaemonMissionAckTransport;
  /** Exact WsClient `sendMissionReconciliation` surface. */
  sendReconciliation(
    inventory: readonly MissionInventoryItem[],
    generation: MissionTransportGeneration,
  ): boolean;
  /** Abandon the current control-plane generation. Called at most once. */
  fatal(error: MissionDaemonControlFatalError): void | Promise<void>;
  /** Abandon the socket so Noriq must reconcile and advance root lease epochs again. */
  restartTransportGeneration?(reason: string, generation: MissionTransportGeneration): void;
  logger?: MissionDaemonLogger;
  now?: () => Date;
}

const quietLogger: MissionDaemonLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function adoptionFingerprint(result: MissionAdoptionResult): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        runId: result.runId,
        decision: result.decision,
        lease: result.lease,
        reason: result.reason,
      }),
      'utf8',
    )
    .digest('hex');
}

function uniqueRunIds(items: readonly unknown[]): boolean {
  const found = new Set<string>();
  for (const item of items) {
    if (
      item === null ||
      typeof item !== 'object' ||
      !('runId' in item) ||
      typeof item.runId !== 'string' ||
      item.runId.length === 0 ||
      found.has(item.runId)
    ) {
      return false;
    }
    found.add(item.runId);
  }
  return true;
}

function normalizeInventory(items: readonly MissionInventoryItem[]): readonly MissionInventoryItem[] | null {
  if (!Array.isArray(items)) return null;
  if (items.length > MAX_DAEMON_MISSION_RECONCILIATION_ROOTS || !uniqueRunIds(items)) return null;
  const normalized: MissionInventoryItem[] = [];
  for (const item of items) {
    const parsed = MissionInventoryItemSchema.safeParse(item);
    if (!parsed.success) return null;
    const attemptIds = parsed.data.attempts.map((attempt) => attempt.attemptId);
    if (new Set(attemptIds).size !== attemptIds.length) return null;
    // Zod's wire object is intentionally forward-compatible and strips unknown keys. Always use
    // the detached parsed value across the daemon/Noriq authority boundary; validating and then
    // forwarding the caller's original object would leak coordinator-private fields.
    normalized.push(structuredClone(parsed.data));
  }
  return normalized;
}

function normalizeResults(
  results: readonly MissionAdoptionResult[],
): readonly MissionAdoptionResult[] | null {
  if (!Array.isArray(results)) return null;
  if (results.length > MAX_DAEMON_MISSION_RECONCILIATION_ROOTS || !uniqueRunIds(results)) return null;
  const normalized: MissionAdoptionResult[] = [];
  for (const result of results) {
    const parsed = MissionAdoptionResultSchema.safeParse(result);
    if (!parsed.success) return null;
    normalized.push(structuredClone(parsed.data));
  }
  return normalized;
}

type ControlStopView = {
  reason: string;
  state: {
    rootRunId: string;
    lease: { sitting: number; executionId: string; epoch: number } | null;
    commission: NoriqMissionCommission | null;
    tasks: ReadonlyArray<{
      task: { taskId: string };
      attemptId: string | null;
      questionPublication?: null | {
        questionId: string;
        reportId: string;
        signalId: string;
      };
      observation: null | {
        kind: string;
        questionId?: string;
        prompt?: string;
        handoff?: null | {
          backend: string;
          repositoryKey: string;
          checkpointId: string;
          revisionId: string;
          reference: string;
          status: 'preserved';
        };
      };
    }>;
  };
  taskId?: string;
  questionId?: string;
  prompt?: string;
};

function controlStop(value: unknown): ControlStopView | null {
  if (!value || typeof value !== 'object') return null;
  const stop = value as Partial<ControlStopView>;
  if (typeof stop.reason !== 'string' || !stop.state || typeof stop.state.rootRunId !== 'string') return null;
  return stop as ControlStopView;
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex').slice(0, 56)}`;
}

/**
 * Bounded daemon-facing mission control plane.
 *
 * This class never commissions a mission, resolves a runtime, or invokes a model while producing
 * reconciliation inventory. It only starts coordinator control after Noriq has returned an exact
 * `adopt` result for a root that is durably local.
 */
export class MissionDaemonControl {
  private readonly coordinator: DaemonMissionCoordinatorLike;
  private readonly transport: DaemonMissionAckTransport;
  private readonly sendReconciliation: MissionDaemonControlOptions['sendReconciliation'];
  private readonly fatalCallback: MissionDaemonControlOptions['fatal'];
  private readonly restartTransportGeneration?: MissionDaemonControlOptions['restartTransportGeneration'];
  private readonly log: MissionDaemonLogger;
  private readonly now: () => Date;
  private readonly latestAppliedResult = new Map<string, string>();
  private readonly activeControls = new Map<string, Promise<void>>();
  /** Root authority is granted only by an adopt result on this exact live generation. */
  private readonly authorizedControlGenerations = new Map<string, MissionTransportGeneration>();
  private requestTail: Promise<void> = Promise.resolve();
  private resultTail: Promise<void> = Promise.resolve();
  private cancelTail: Promise<void> = Promise.resolve();
  private generationTail: Promise<void> = Promise.resolve();
  private activeTransportGeneration: MissionTransportGeneration | null = null;
  private highestTransportGeneration = 0;
  private fatalPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(options: MissionDaemonControlOptions) {
    this.coordinator = options.coordinator;
    this.transport = options.transport;
    this.sendReconciliation = options.sendReconciliation;
    this.fatalCallback = options.fatal;
    this.restartTransportGeneration = options.restartTransportGeneration;
    this.log = options.logger ?? quietLogger;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Publish one newly registered transport generation. Generations are strictly monotonic and a
   * repeated registration frame for the current socket is idempotent. Any replacement waits
   * behind nonterminal quarantine of the superseded generation before it may reconcile.
   */
  activateTransportGeneration(generation: MissionTransportGeneration): boolean {
    if (this.stopped || this.fatalPromise || !Number.isSafeInteger(generation) || generation < 1) {
      return false;
    }
    if (this.activeTransportGeneration === generation) return true;
    if (generation <= this.highestTransportGeneration) return false;
    if (this.activeTransportGeneration !== null) {
      this.revokeTransportGeneration(
        this.activeTransportGeneration,
        'transport generation superseded before disconnect completed',
      );
    }
    this.highestTransportGeneration = generation;
    this.activeTransportGeneration = generation;
    return true;
  }

  isCurrentTransportGeneration(generation: MissionTransportGeneration): boolean {
    return !this.stopped && !this.fatalPromise && this.activeTransportGeneration === generation;
  }

  /** Return the generation authorized to emit reports for this adopted root, if still live. */
  authorizedTransportGeneration(rootRunId: string): MissionTransportGeneration | null {
    const generation = this.authorizedControlGenerations.get(rootRunId) ?? null;
    return generation !== null && this.isCurrentTransportGeneration(generation) ? generation : null;
  }

  /** Read an already-durable fresh commission so duplicate assignment delivery never re-pins HEAD. */
  async existingCommission(rootRunId: string): Promise<NoriqMissionCommission | null> {
    if (!this.coordinator.inspect) return null;
    const state = controlStop({ reason: 'state', state: await this.coordinator.inspect(rootRunId) })?.state;
    return state?.commission ?? null;
  }

  /** Deliver only a schema-valid, exact report/attempt/phase acknowledgement. */
  acknowledgeTask(ack: MissionTaskAck, generation: MissionTransportGeneration): boolean {
    if (!this.isCurrentTransportGeneration(generation)) return false;
    const parsed = MissionTaskAckSchema.safeParse(ack);
    if (!parsed.success) {
      this.log.warn('mission task acknowledgement rejected', { code: 'invalid-frame' });
      return false;
    }
    return this.transport.acknowledge(parsed.data);
  }

  acknowledgeQuestion(
    runId: string,
    lease: MissionQuestionAnswer['lease'],
    ack: MissionQuestionAck,
    generation: MissionTransportGeneration,
  ): boolean {
    if (!this.isCurrentTransportGeneration(generation)) return false;
    const parsed = MissionQuestionAckSchema.safeParse(ack);
    if (!parsed.success || this.authorizedControlGenerations.get(runId) !== generation) return false;
    const authorized = this.authorizedControlGenerations.get(runId) === generation;
    return (
      authorized &&
      lease.epoch > 0 &&
      (this.transport.acknowledgeQuestion?.(runId, lease, parsed.data) ?? false)
    );
  }

  /** Durably consume Noriq's replayed question acknowledgement after lease adoption. */
  async reconcileQuestionAck(
    runId: string,
    lease: MissionQuestionAnswer['lease'],
    ack: MissionQuestionAck,
    generation: MissionTransportGeneration,
  ): Promise<boolean> {
    if (!this.isCurrentTransportGeneration(generation)) return false;
    const parsed = MissionQuestionAckSchema.safeParse(ack);
    if (
      !parsed.success ||
      !parsed.data.accepted ||
      !parsed.data.signalId ||
      (parsed.data.state !== 'open' && parsed.data.state !== 'answered') ||
      this.authorizedControlGenerations.get(runId) !== generation ||
      !this.coordinator.inspect ||
      !this.coordinator.recordQuestionPublication
    ) {
      return false;
    }
    const state = controlStop({ reason: 'state', state: await this.coordinator.inspect(runId) })?.state;
    if (!state?.lease || JSON.stringify(state.lease) !== JSON.stringify(lease)) return false;
    const task = state.tasks.find(
      (candidate) =>
        candidate.attemptId === parsed.data.attemptId &&
        candidate.observation?.kind === 'human-question' &&
        candidate.observation.questionId === parsed.data.questionId,
    );
    if (!task) return false;
    await this.coordinator.recordQuestionPublication(
      runId,
      parsed.data.questionId,
      parsed.data.reportId,
      parsed.data.signalId,
    );
    return true;
  }

  acknowledgeHandoff(ack: MissionHandoffAck, generation: MissionTransportGeneration): boolean {
    if (!this.isCurrentTransportGeneration(generation)) return false;
    const parsed = MissionHandoffAckSchema.safeParse(ack);
    return parsed.success && (this.transport.acknowledgeHandoff?.(parsed.data) ?? false);
  }

  /** Durably admit a fresh exact commission on the socket generation that delivered it. */
  commissionFresh(
    commission: NoriqMissionCommission,
    generation: MissionTransportGeneration,
  ): Promise<boolean> {
    if (!this.isCurrentTransportGeneration(generation)) return Promise.resolve(false);
    let accepted = false;
    const operation = this.resultTail.then(async () => {
      await this.generationTail;
      if (!this.isCurrentTransportGeneration(generation)) return;
      if (!this.coordinator.commission) throw new Error('fresh mission commissioning is unavailable');
      await this.coordinator.commission(commission);
      if (!this.isCurrentTransportGeneration(generation)) return;
      const authority = `fresh:${commission.commissionDigest}`;
      this.latestAppliedResult.set(commission.rootRunId, authority);
      this.authorizedControlGenerations.set(commission.rootRunId, generation);
      this.startControl(commission.rootRunId, authority, generation);
      accepted = true;
    });
    this.resultTail = operation.catch(() => undefined);
    return operation.then(() => accepted);
  }

  answerQuestion(answer: MissionQuestionAnswer, generation: MissionTransportGeneration): Promise<boolean> {
    const parsed = MissionQuestionAnswerSchema.safeParse(answer);
    if (!parsed.success || !this.isCurrentTransportGeneration(generation)) return Promise.resolve(false);
    let accepted = false;
    const operation = this.resultTail.then(async () => {
      if (
        !this.isCurrentTransportGeneration(generation) ||
        this.authorizedControlGenerations.get(parsed.data.runId) !== generation
      )
        return;
      if (!this.coordinator.inspect || !this.coordinator.answer) return;
      const state = controlStop({
        reason: 'state',
        state: await this.coordinator.inspect(parsed.data.runId),
      })?.state;
      if (!state?.lease || JSON.stringify(state.lease) !== JSON.stringify(parsed.data.lease)) return;
      const questionTask = state.tasks.find(
        (task) =>
          task.observation?.kind === 'human-question' &&
          task.observation.questionId === parsed.data.questionId,
      );
      if (!questionTask || questionTask.attemptId !== parsed.data.attemptId) return;
      const authority = this.latestAppliedResult.get(parsed.data.runId);
      if (!authority) return;
      const control = Promise.resolve(
        this.coordinator.answer(parsed.data.runId, parsed.data.questionId, parsed.data.answer),
      )
        .then(
          (stop) => this.handleControlStop(stop, parsed.data.runId, authority, generation),
          () => {
            if (
              this.isCurrentTransportGeneration(generation) &&
              this.authorizedControlGenerations.get(parsed.data.runId) === generation
            ) {
              this.abandonControlGeneration(
                parsed.data.runId,
                generation,
                'mission answer control rejected before durable settlement',
              );
            }
            this.log.warn('mission answer control rejected', { code: 'answer-control-rejected' });
            return null;
          },
        )
        .then(() => undefined);
      this.activeControls.set(parsed.data.runId, control);
      void control.finally(() => {
        if (this.activeControls.get(parsed.data.runId) === control)
          this.activeControls.delete(parsed.data.runId);
      });
      accepted = true;
    });
    this.resultTail = operation.catch(() => undefined);
    return operation.then(() => accepted);
  }

  async observeHandoffConsumption(
    consumed: MissionHandoffConsumed,
    generation: MissionTransportGeneration,
  ): Promise<boolean> {
    const parsed = MissionHandoffConsumedSchema.safeParse(consumed);
    if (!parsed.success || !this.isCurrentTransportGeneration(generation)) return false;
    try {
      if (!this.coordinator.inspect) return false;
      const state = controlStop({
        reason: 'state',
        state: await this.coordinator.inspect(parsed.data.runId),
      })?.state;
      const local = state?.tasks.at(-1)?.observation?.handoff;
      return Boolean(
        local &&
          local.backend === parsed.data.handoff.backend &&
          local.repositoryKey === parsed.data.handoff.repositoryKey &&
          local.checkpointId === parsed.data.handoff.checkpoint &&
          local.revisionId === parsed.data.handoff.revision &&
          local.reference === parsed.data.handoff.reference,
      );
    } catch {
      return false;
    }
  }

  /**
   * Synchronously revoke in-memory transport waiters, then prove all model/tool work has reached a
   * nonterminal quiescent boundary. Reconciliation results wait behind this barrier.
   */
  transportGenerationLost(generation: MissionTransportGeneration, reason: string): Promise<void> {
    if (!this.isCurrentTransportGeneration(generation)) return Promise.resolve();
    this.revokeTransportGeneration(generation, reason);
    return this.generationTail;
  }

  /**
   * Serialize reconciliation requests. Exact duplicate request frames are valid retransmissions
   * and each receives a fresh read-only inventory response while its own deadline remains live.
   */
  reconcile(request: MissionReconciliationRequest, generation: MissionTransportGeneration): Promise<boolean> {
    if (!this.isCurrentTransportGeneration(generation)) return Promise.resolve(false);
    let result = false;
    const operation = this.requestTail.then(async () => {
      result = await this.reconcileOnce(request, generation);
    });
    this.requestTail = operation.catch(() => undefined);
    return operation.then(() => result);
  }

  /** Apply one result frame in arrival order. Exact duplicate frames are idempotent. */
  applyResults(
    results: readonly MissionAdoptionResult[],
    generation: MissionTransportGeneration,
  ): Promise<boolean> {
    if (!this.isCurrentTransportGeneration(generation)) return Promise.resolve(false);
    let result = false;
    const operation = this.resultTail.then(async () => {
      result = await this.applyResultsOnce(results, generation);
    });
    this.resultTail = operation.catch(() => undefined);
    return operation.then(() => result);
  }

  /** Read every nonterminal durable root for orphan-workspace reservation. */
  async reservedRootRunIds(): Promise<readonly string[]> {
    const roots = [...(await this.coordinator.reservedRootRunIds())];
    if (
      roots.some((rootRunId) => typeof rootRunId !== 'string' || rootRunId.length === 0) ||
      new Set(roots).size !== roots.length
    ) {
      throw new MissionDaemonControlFatalError('MISSION_INVENTORY_INVALID');
    }
    return Object.freeze(roots);
  }

  /** Route a run cancellation only under the exact live socket generation that delivered it. */
  cancelKnownRoot(
    rootRunId: string,
    reason: string,
    generation: MissionTransportGeneration,
  ): Promise<boolean> {
    if (!this.isCurrentTransportGeneration(generation)) return Promise.resolve(false);
    if (typeof rootRunId !== 'string' || rootRunId.length === 0) return Promise.resolve(false);
    if (typeof reason !== 'string' || reason.length === 0) return Promise.resolve(false);

    let result = false;
    const generationBarrier = this.generationTail;
    const operation = this.cancelTail.then(async () => {
      // A newer generation cannot operate until the previous generation's quarantine barrier has
      // settled. Conversely, a queued callback from that previous generation is rejected here.
      await generationBarrier;
      if (!this.isCurrentTransportGeneration(generation)) return;
      let known: Set<string>;
      try {
        known = new Set(await this.reservedRootRunIds());
      } catch {
        if (!this.isCurrentTransportGeneration(generation)) return;
        await this.failClosed('MISSION_INVENTORY_READ_FAILED');
        return;
      }
      // Inventory reads are asynchronous. Re-check before crossing into durable cancellation so an
      // old socket cannot act on a root that a newer socket has since adopted.
      if (!this.isCurrentTransportGeneration(generation) || !known.has(rootRunId)) return;
      await this.coordinator.cancel(rootRunId, reason);
      result = this.isCurrentTransportGeneration(generation);
    });
    this.cancelTail = operation.catch(() => undefined);
    return operation.then(() => result);
  }

  /**
   * Stop accepting frames, reject transport acknowledgement waiters, optionally quiesce safely,
   * and settle every control already launched. Daemon shutdown is not a mission cancellation.
   */
  stop(reason = 'mission daemon control stopped'): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.activeTransportGeneration = null;
    this.latestAppliedResult.clear();
    this.authorizedControlGenerations.clear();
    this.transport.stop(reason);
    // Begin process/tool quiescence synchronously. Waiting for reconciliation tails first leaves a
    // shutdown window in which an already adopted controller can launch another child.
    let quiescence: Promise<void> = Promise.resolve();
    if (this.coordinator.quiesce) {
      try {
        quiescence = Promise.resolve(this.coordinator.quiesce());
      } catch (error) {
        quiescence = Promise.reject(error);
      }
    }
    this.stopPromise = (async () => {
      const settled = await Promise.allSettled([
        this.requestTail,
        this.resultTail,
        this.cancelTail,
        this.generationTail,
        quiescence,
      ]);
      while (this.activeControls.size > 0) {
        await Promise.allSettled([...this.activeControls.values()]);
      }
      const quiescenceResult = settled.at(-1);
      if (quiescenceResult?.status === 'rejected') {
        this.log.error('mission coordinator quiesce failed', { code: 'quiesce-failed' });
        throw quiescenceResult.reason;
      }
      if (this.fatalPromise) await this.fatalPromise;
    })();
    return this.stopPromise;
  }

  private async reconcileOnce(
    request: MissionReconciliationRequest,
    generation: MissionTransportGeneration,
  ): Promise<boolean> {
    if (!this.isCurrentTransportGeneration(generation)) return false;
    await this.generationTail;
    if (!this.isCurrentTransportGeneration(generation)) return false;
    const normalizedRequest = this.normalizeRequest(request);
    if (!normalizedRequest) {
      return this.failClosed('MISSION_RECONCILIATION_INVALID');
    }
    const deadline = Date.parse(normalizedRequest.deadline);
    if (deadline <= this.now().getTime()) {
      return this.failClosed('MISSION_RECONCILIATION_EXPIRED');
    }

    let local: readonly MissionInventoryItem[];
    try {
      local = await this.coordinator.inventoryAll();
    } catch {
      if (!this.isCurrentTransportGeneration(generation)) return false;
      return this.failClosed('MISSION_INVENTORY_READ_FAILED');
    }
    if (!this.isCurrentTransportGeneration(generation)) return false;
    const normalizedLocal = normalizeInventory(local);
    if (!normalizedLocal) return this.failClosed('MISSION_INVENTORY_INVALID');
    if (!this.isCurrentTransportGeneration(generation)) return false;
    if (deadline <= this.now().getTime()) {
      return this.failClosed('MISSION_RECONCILIATION_EXPIRED');
    }

    const serverRoots = new Set(normalizedRequest.items.map((item) => item.runId));
    // Forward the parsed local fact. In particular, do not replace a mismatched local lease or
    // attempt list with the server's copy: the mismatch is the evidence Noriq needs to cancel.
    const reply = normalizedLocal.filter((item) => serverRoots.has(item.runId));
    let sent = false;
    try {
      sent = this.sendReconciliation(reply, generation);
    } catch {
      // A throwing sender is the same authority failure as a false disconnected-socket result.
    }
    if (!this.isCurrentTransportGeneration(generation)) return false;
    if (!sent) return this.failClosed('MISSION_RECONCILIATION_SEND_FAILED');
    this.log.debug('mission reconciliation inventory sent', {
      localRoots: local.length,
      requestedRoots: normalizedRequest.items.length,
      repliedRoots: reply.length,
    });
    return true;
  }

  private normalizeRequest(request: MissionReconciliationRequest): MissionReconciliationRequest | null {
    if (request === null || typeof request !== 'object') return null;
    if (!MissionReconciliationDeadlineSchema.safeParse(request.deadline).success) {
      return null;
    }
    const items = normalizeInventory(request.items);
    return items ? { deadline: request.deadline, items } : null;
  }

  private async applyResultsOnce(
    results: readonly MissionAdoptionResult[],
    generation: MissionTransportGeneration,
  ): Promise<boolean> {
    if (!this.isCurrentTransportGeneration(generation)) return false;
    await this.generationTail;
    if (!this.isCurrentTransportGeneration(generation)) return false;
    const normalizedResults = normalizeResults(results);
    if (!normalizedResults) return this.failClosed('MISSION_RECONCILIATION_INVALID');

    let known: Set<string>;
    try {
      known = new Set(await this.reservedRootRunIds());
    } catch {
      if (!this.isCurrentTransportGeneration(generation)) return false;
      return this.failClosed('MISSION_INVENTORY_READ_FAILED');
    }
    if (!this.isCurrentTransportGeneration(generation)) return false;
    for (const rootRunId of this.latestAppliedResult.keys()) {
      if (!known.has(rootRunId)) this.latestAppliedResult.delete(rootRunId);
    }

    for (const result of normalizedResults) {
      if (!known.has(result.runId)) continue;
      const fingerprint = adoptionFingerprint(result);
      if (this.latestAppliedResult.get(result.runId) === fingerprint) continue;
      try {
        await this.coordinator.adopt(result);
      } catch {
        if (!this.isCurrentTransportGeneration(generation)) return false;
        return this.failClosed('MISSION_ADOPTION_FAILED');
      }
      // Disconnect may have landed while the durable adoption was applying. Generation loss waits
      // for this result tail and quarantines it; never publish stale control authority meanwhile.
      if (!this.isCurrentTransportGeneration(generation)) return false;
      this.latestAppliedResult.set(result.runId, fingerprint);
      if (result.decision === 'adopt') {
        this.authorizedControlGenerations.set(result.runId, generation);
        this.startControl(result.runId, fingerprint, generation);
      } else {
        this.authorizedControlGenerations.delete(result.runId);
      }
    }
    return true;
  }

  private startControl(rootRunId: string, adoption: string, generation: MissionTransportGeneration): void {
    if (
      !this.isCurrentTransportGeneration(generation) ||
      this.authorizedControlGenerations.get(rootRunId) !== generation
    ) {
      return;
    }
    const existing = this.activeControls.get(rootRunId);
    if (existing) {
      void existing.then(() => {
        if (
          this.isCurrentTransportGeneration(generation) &&
          this.authorizedControlGenerations.get(rootRunId) === generation &&
          this.latestAppliedResult.get(rootRunId) === adoption
        ) {
          this.startControl(rootRunId, adoption, generation);
        }
      });
      return;
    }
    const control = Promise.resolve()
      .then(() => this.coordinator.control(rootRunId))
      .then((stop) => this.handleControlStop(stop, rootRunId, adoption, generation))
      .then(
        (reason) => {
          if (
            RETRYABLE_CONTROL_STOPS.has(reason ?? '') &&
            this.isCurrentTransportGeneration(generation) &&
            this.authorizedControlGenerations.get(rootRunId) === generation &&
            this.latestAppliedResult.get(rootRunId) === adoption
          ) {
            this.abandonControlGeneration(
              rootRunId,
              generation,
              'mission control stopped before durable transport settlement',
            );
          }
        },
        () => {
          if (
            this.isCurrentTransportGeneration(generation) &&
            this.authorizedControlGenerations.get(rootRunId) === generation &&
            this.latestAppliedResult.get(rootRunId) === adoption
          ) {
            this.abandonControlGeneration(
              rootRunId,
              generation,
              'mission coordinator control rejected before durable settlement',
            );
          }
          this.log.warn('mission coordinator control rejected', { code: 'control-rejected' });
        },
      )
      .then(() => undefined);
    this.activeControls.set(rootRunId, control);
    void control.then(() => {
      if (this.activeControls.get(rootRunId) === control) this.activeControls.delete(rootRunId);
    });
  }

  private async handleControlStop(
    value: unknown,
    rootRunId: string,
    authority: string,
    generation: MissionTransportGeneration,
  ): Promise<string | null> {
    const stop = controlStop(value);
    if (!stop) {
      return value &&
        typeof value === 'object' &&
        'reason' in value &&
        typeof (value as { reason?: unknown }).reason === 'string'
        ? (value as { reason: string }).reason
        : 'runtime-error';
    }
    if (stop.state.rootRunId !== rootRunId) return 'runtime-error';
    if (
      !this.isCurrentTransportGeneration(generation) ||
      this.authorizedControlGenerations.get(rootRunId) !== generation ||
      this.latestAppliedResult.get(rootRunId) !== authority
    )
      return stop.reason;

    if (stop.reason === 'human-question') {
      const task = stop.state.tasks.find((candidate) => candidate.task.taskId === stop.taskId);
      if (!task?.attemptId || !stop.questionId || !stop.prompt || !stop.state.lease) return 'runtime-error';
      if (task.questionPublication?.questionId === stop.questionId) return stop.reason;
      const reportId = stableId('nmq', {
        rootRunId,
        attemptId: task.attemptId,
        questionId: stop.questionId,
        lease: stop.state.lease,
      });
      try {
        if (!this.transport.question) return 'transport-error';
        const ack = await this.transport.question(rootRunId, stop.state.lease, {
          reportId,
          questionId: stop.questionId,
          attemptId: task.attemptId,
          prompt: stop.prompt,
          observedAt: this.now().toISOString(),
        });
        if (!ack.accepted || (ack.state !== 'open' && ack.state !== 'answered')) {
          return 'authority-conflict';
        }
        if (!ack.signalId || !this.coordinator.recordQuestionPublication) return 'runtime-error';
        await this.coordinator.recordQuestionPublication(
          rootRunId,
          stop.questionId,
          ack.reportId,
          ack.signalId,
        );
      } catch {
        return 'transport-error';
      }
      return stop.reason;
    }

    if (stop.reason === 'completed' && stop.state.commission?.publishHandoff) {
      const handoff = stop.state.tasks.at(-1)?.observation?.handoff;
      if (!handoff || !stop.state.lease) return 'runtime-error';
      const handoffId = stableId('mho', {
        rootRunId,
        commissionDigest: stop.state.commission.commissionDigest,
        handoff,
      });
      const publication = {
        reportId: stableId('mhp', { rootRunId, handoffId }),
        handoff: {
          schemaVersion: 1 as const,
          handoffId,
          backend: handoff.backend,
          repositoryKey: handoff.repositoryKey,
          checkpoint: handoff.checkpointId,
          revision: handoff.revisionId,
          reference: handoff.reference,
        },
      };
      try {
        if (!this.transport.handoff) return 'transport-error';
        const ack = await this.transport.handoff(rootRunId, stop.state.lease, publication);
        if (!ack.accepted) return 'authority-conflict';
        if (!this.coordinator.recordHandoffPublication) return 'runtime-error';
        await this.coordinator.recordHandoffPublication(rootRunId, publication.reportId, handoffId);
      } catch {
        return 'transport-error';
      }
    }
    return stop.reason;
  }

  private abandonControlGeneration(
    rootRunId: string,
    generation: MissionTransportGeneration,
    reason: string,
  ): void {
    this.latestAppliedResult.delete(rootRunId);
    this.authorizedControlGenerations.delete(rootRunId);
    if (this.restartTransportGeneration) {
      this.restartTransportGeneration(reason, generation);
    } else {
      void this.failClosed('MISSION_CONTROL_REJECTED');
    }
  }

  /**
   * Revoke authority synchronously, then quarantine only after every already-entered adoption
   * result has returned. This ordering prevents quarantine from racing an adoption that was
   * durably applying when the socket died.
   */
  private revokeTransportGeneration(generation: MissionTransportGeneration, reason: string): void {
    if (this.activeTransportGeneration === generation) this.activeTransportGeneration = null;
    this.transport.stop(reason);
    this.latestAppliedResult.clear();
    this.authorizedControlGenerations.clear();
    const enteredResults = this.resultTail;
    const enteredCancellations = this.cancelTail;
    const operation = this.generationTail.then(async () => {
      await Promise.allSettled([enteredResults, enteredCancellations]);
      if (this.coordinator.quarantineAll) await this.coordinator.quarantineAll(reason);
    });
    this.generationTail = operation.catch(async () => {
      await this.failClosed('MISSION_QUIESCE_FAILED');
    });
  }

  private failClosed(code: MissionDaemonFatalCode): Promise<false> {
    if (!this.fatalPromise) {
      const error = new MissionDaemonControlFatalError(code);
      this.log.error('mission control plane failed closed', { code });
      this.activeTransportGeneration = null;
      this.latestAppliedResult.clear();
      this.authorizedControlGenerations.clear();
      this.transport.stop('mission control plane failed closed');
      this.fatalPromise = Promise.resolve()
        .then(() => this.fatalCallback(error))
        .then(
          () => undefined,
          () => {
            this.log.error('mission fatal callback rejected', { code: 'fatal-callback-rejected' });
          },
        );
    }
    return this.fatalPromise.then(() => false);
  }
}
