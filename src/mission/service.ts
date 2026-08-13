import { MissionHarness, type MissionHarnessOptions, type MissionHarnessStop } from './harness';
import { type MissionDispatchResult, MissionKernel } from './kernel';
import type { MissionState } from './model';
import {
  type MissionProfileCatalogSnapshot,
  missionProfileCatalogCreateFields,
  missionProfileCatalogResourceCapacities,
  validateMissionProfileCatalogSnapshot,
} from './profile-catalog';
import type { MissionBudget, MissionCompletionPolicy, MissionObjective } from './protocol';
import { canonicalMissionJson } from './store';

export interface MissionCreateRequest {
  missionId: string;
  /** Stable across caller retries. */
  actionId: string;
  /** Fingerprint of authority pre-registered from trusted local Runner configuration. */
  catalogFingerprint: string;
  objective?: MissionObjective;
  budget: MissionBudget;
  resources: Readonly<Record<string, number>>;
  completion?: MissionCompletionPolicy;
  cleanup?: readonly string[];
}

export type MissionReconciliationResult =
  | { missionId: string; ok: true; stop: MissionHarnessStop }
  | { missionId: string; ok: false; error: string };

/** Read-only startup inventory. Constructing it never invokes a guide, child, validator, or cleanup. */
export type MissionInspectionResult =
  | { missionId: string; ok: true; state: MissionState }
  | { missionId: string; ok: false; error: string };

function missionActivationBudgetError(budget: MissionBudget): string | null {
  if (!Number.isSafeInteger(budget.tokens) || (budget.tokens ?? 0) <= 0) {
    return 'mission token budget must be a finite positive safe integer';
  }
  if (
    typeof budget.activeSeconds !== 'number' ||
    !Number.isFinite(budget.activeSeconds) ||
    budget.activeSeconds <= 0 ||
    budget.activeSeconds > Number.MAX_SAFE_INTEGER
  ) {
    return 'mission activeSeconds budget must be finite and positive';
  }
  if (
    budget.usd !== null &&
    (typeof budget.usd !== 'number' ||
      !Number.isFinite(budget.usd) ||
      budget.usd < 0 ||
      budget.usd > Number.MAX_SAFE_INTEGER)
  ) {
    return 'mission USD budget must be null or finite and non-negative';
  }
  return null;
}

function writableMissionAuthorityError(
  objective: MissionObjective | undefined,
  catalog: MissionProfileCatalogSnapshot,
): string | null {
  if (!catalog.profiles.some((profile) => profile.permission === 'write')) return null;
  if (!objective?.repositoryKey) {
    return 'missions with writable profiles must pin a durable repositoryKey';
  }
  if (!objective.baseRevision) {
    return 'missions with writable profiles must pin an immutable baseRevision';
  }
  return null;
}

/**
 * Public composition boundary for daemon integration. It keeps mission creation, operator
 * controls, and startup reconciliation on the same deterministic kernel/harness/store stack.
 * Startup first drains every already-terminal journal's cleanup, then reconciles active missions
 * sequentially so stale resources are released before any new inference and model concurrency can
 * never multiply silently.
 */
export class MissionService {
  private readonly kernel: MissionKernel;
  private readonly harness: MissionHarness;
  private readonly catalogs: ReadonlyMap<string, MissionProfileCatalogSnapshot>;

  constructor(
    private readonly options: MissionHarnessOptions,
    catalogs: readonly MissionProfileCatalogSnapshot[],
  ) {
    const trusted = new Map<string, MissionProfileCatalogSnapshot>();
    for (const candidate of catalogs) {
      const catalog = validateMissionProfileCatalogSnapshot(candidate);
      if (trusted.has(catalog.fingerprint)) {
        throw new Error(`duplicate mission profile catalog '${catalog.fingerprint}'`);
      }
      trusted.set(catalog.fingerprint, catalog);
    }
    if (trusted.size === 0)
      throw new Error('MissionService requires at least one trusted local profile catalog');
    this.catalogs = trusted;
    this.kernel = new MissionKernel(options.store);
    this.harness = new MissionHarness(options);
  }

  create(request: MissionCreateRequest): Promise<MissionDispatchResult> {
    const catalog = this.catalogs.get(request.catalogFingerprint);
    if (!catalog) {
      return Promise.reject(
        new Error(`mission profile catalog '${request.catalogFingerprint}' is not registered locally`),
      );
    }
    const budgetError = missionActivationBudgetError(request.budget);
    if (budgetError) return Promise.reject(new Error(budgetError));
    const authorityError = writableMissionAuthorityError(request.objective, catalog);
    if (authorityError) return Promise.reject(new Error(authorityError));
    const trustedResources = missionProfileCatalogResourceCapacities(catalog);
    if (canonicalMissionJson(request.resources) !== canonicalMissionJson(trustedResources)) {
      return Promise.reject(
        new Error('mission resource capacities must exactly match the trusted local profile catalog'),
      );
    }
    return this.kernel.dispatch({
      missionId: request.missionId,
      expectedRevision: 0,
      actionId: request.actionId,
      action: {
        type: 'create-mission',
        ...missionProfileCatalogCreateFields(catalog),
        ...(request.objective ? { objective: request.objective } : {}),
        budget: request.budget,
        resources: trustedResources,
        ...(request.completion ? { completion: request.completion } : {}),
        ...(request.cleanup ? { cleanup: request.cleanup } : {}),
      },
    });
  }

  inspect(missionId: string): Promise<MissionState> {
    return this.kernel.inspect(missionId);
  }

  /**
   * Enumerate durable mission journals without advancing any controller. This is the only safe
   * input to Noriq adoption: `reconcileAll()` below may launch models and is therefore reserved
   * for missions whose external lease has already been adopted.
   */
  async inspectAll(): Promise<readonly MissionInspectionResult[]> {
    const entries = await this.options.store.listMissionEntries();
    return Promise.all(
      entries.map(async (entry): Promise<MissionInspectionResult> => {
        if (entry.error !== undefined) {
          return { missionId: entry.missionId, ok: false, error: entry.error };
        }
        try {
          return {
            missionId: entry.missionId,
            ok: true,
            state: await this.kernel.inspect(entry.missionId),
          };
        } catch (error) {
          return { missionId: entry.missionId, ok: false, error: String(error) };
        }
      }),
    );
  }

  control(missionId: string): Promise<MissionHarnessStop> {
    return this.harness.run(missionId);
  }

  async answerAndContinue(
    missionId: string,
    questionId: string,
    answer: string,
  ): Promise<MissionHarnessStop> {
    await this.harness.answerQuestion(missionId, questionId, answer);
    return this.harness.runAfterLocalController(missionId);
  }

  cancel(missionId: string, reason: string): Promise<MissionHarnessStop> {
    return this.harness.cancelMission(missionId, reason);
  }

  /** Stop local model/tool processes without writing a terminal mission outcome. */
  quiesce(reason?: string): Promise<void> {
    return this.harness.quiesce(reason);
  }

  quiesceMission(missionId: string, reason: string): Promise<void> {
    return this.harness.quiesceMission(missionId, reason);
  }

  resumeMission(missionId: string): void {
    this.harness.resumeMission(missionId);
  }

  /** Fresh external lease adoption only; never callable from task/model input. */
  resumeAfterQuiesce(): void {
    this.harness.resumeAfterQuiesce();
  }

  async reconcileAll(): Promise<readonly MissionReconciliationResult[]> {
    const entries = await this.options.store.listMissionEntries();
    const results = new Map<string, MissionReconciliationResult>();
    const candidates: Array<{ missionId: string; terminal: boolean }> = [];
    for (const entry of entries) {
      const { missionId } = entry;
      if (entry.error !== undefined) {
        results.set(missionId, { missionId, ok: false, error: entry.error });
        continue;
      }
      try {
        const state = await this.kernel.inspect(missionId);
        candidates.push({ missionId, terminal: state.terminal !== null });
      } catch (error) {
        results.set(missionId, { missionId, ok: false, error: String(error) });
      }
    }
    candidates.sort((left, right) => Number(right.terminal) - Number(left.terminal));
    for (const { missionId } of candidates) {
      try {
        const stop = await this.harness.run(missionId);
        if (stop.reason === 'runtime-error') {
          results.set(missionId, { missionId, ok: false, error: stop.error });
        } else {
          results.set(missionId, { missionId, ok: true, stop });
        }
      } catch (error) {
        results.set(missionId, { missionId, ok: false, error: String(error) });
      }
    }
    return entries.map(
      ({ missionId }) =>
        results.get(missionId) ?? {
          missionId,
          ok: false as const,
          error: 'mission reconciliation produced no result',
        },
    );
  }
}
