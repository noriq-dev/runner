import type { IndexCoordinator, IndexTarget } from './index-coordinator';
import type { ResolvedIndexConfig } from './index-policy';
import { logger as defaultLogger } from './logger';
import type { VcsBackend } from './vcs/types';

/**
 * The trigger layer (RUN-222) — turns "something happened" (the daemon started, a run landed, a
 * poll tick fired, a human asked) into a coalesced, debounced call to `IndexCoordinator.trigger`.
 * This module owns WHEN; `index-coordinator.ts` owns lifecycle, and `index-work.ts` owns the real
 * work step's content — the three-way split THREAT-MODEL.md's `[index]` section now names as what
 * actually invokes the scanner, when, and what bounds it.
 *
 * **This is not a second coalescing layer** (locked decision 9). `IndexCoordinator.trigger`
 * already collapses concurrent triggers for one job key into one active job plus at most one
 * pending re-run — what it does NOT do is WAIT, so three landings ten seconds apart start a job on
 * the first and re-run once. Debounce is a short QUIET WINDOW before the first call to `trigger`
 * even happens, built entirely on top of the coordinator (a `setTimeout` per job key, reset on
 * every new request) — never inside it.
 *
 * **A repository's own `currentBaseId` is computed HERE, cheaply, via `VcsBackend.currentBase`**
 * (never by leasing or scanning — locked decision 10) — this is the one fact `IndexCoordinator`
 * itself cannot obtain without a caller (its own module doc: "This checkout's current base is a
 * CALLER-SUPPLIED fact, not something this module derives"). Every entry point below checks
 * `resolveConfig` FIRST, before ever asking the VCS seam anything: a repository with indexing off
 * costs neither a `currentBase` call nor a cursor fetch nor a poll tick's own bookkeeping — it is
 * invisible to this whole module past that one cheap check.
 */

/** One repository this daemon may index — resolved once at daemon construction (repo discovery,
 *  and registration's server-resolved `projectId`, do not change over the daemon's lifetime the
 *  way a committed manifest can) and handed to the hub as a plain array. */
export interface IndexTriggerRepo {
  repoRoot: string;
  repositoryKey: string;
  /** `RunnerRepo.id` — `IndexTarget.checkoutId`'s exact contract. */
  checkoutId: string;
  /** Server-resolved at registration; null until this checkout has one (`IndexTarget.projectId`'s
   *  own contract — a null here is a precondition failure the coordinator already handles). */
  projectId: string | null;
  /** The committed project key (`.noriq/project.toml`'s `key`) — `IndexTarget.projectKey`. */
  projectKey: string;
  /**
   * This repo's own indexed scope, in the backend's own branch naming — the operator's committed
   * `defaultBranch` when set (`ProjectManifest.defaultBranch`), else the auto-detected one
   * (`DiscoveredRepo.defaultBranch`, git-only, so always null for a Diversion/Perforce repo unless
   * the operator set it explicitly). Null means this daemon has no LOCAL branch name to hand the
   * seam, never that indexing stops: git still answers (`currentBase` defaults to `HEAD`),
   * Perforce ignores the question entirely (no branches), and Diversion resolves its own default
   * branch itself, via the same `GET /repos` call `leaseIndexSnapshot` already makes — so a
   * Diversion repo with no configured `defaultBranch` still indexes; it costs that backend one
   * extra API round trip per trigger rather than none, never a silently-skipped repo.
   */
  defaultBranch: string | null;
}

export type IndexTriggerReason = 'startup' | 'poll' | 'landed' | 'manual';

/** What this hub can say about one repository's own trigger activity — an in-memory, queryable
 *  structure only (discretion: RUN-223 owns the CLI surface and any wire-protocol widening; this
 *  is deliberately neither). */
export interface IndexTriggerStatus {
  repositoryKey: string;
  /** The last time ANY entry point asked this repo to be reconsidered — startup, a poll tick, a
   *  landing, or a manual request — whether or not it ended up debounced, skipped (indexing off,
   *  an unknown current base), or actually handed to the coordinator. */
  lastRequestedAt: number | null;
  lastRequestedReason: IndexTriggerReason | null;
  /** The last time this hub actually called `IndexCoordinator.trigger` for this repo — i.e. the
   *  debounce window elapsed (or a manual request skipped it). `reconcile` may still have decided
   *  `unchanged` inside that call; this hub has no visibility past the call itself. */
  lastTriggeredAt: number | null;
  /** When the shared poll ticker will next consider this repo, or null before it has ever been
   *  scheduled (before the first startup reconcile, or when polling was never started). */
  nextPollAt: number | null;
}

/** A short quiet window before the FIRST job starts (discretion 1): landings arrive in bursts of
 *  seconds, and a few seconds to a minute is defensible either way. 15s clears an ordinary landing
 *  burst (three fast-forwards, a push, a merge-request open) without making an isolated landing
 *  wait for a minute to see its own index start. */
export const DEFAULT_DEBOUNCE_MS = 15_000;

/**
 * The shared ticker's own granularity (discretion 2) — ONE process-wide timer, not one per repo:
 * a fleet of N repos, however configured, costs exactly one `setInterval` and O(N) cheap
 * comparisons per tick, never N independent timers that could all fire in the same instant. 60s is
 * fine-grained enough to honour a repo configured at the schema's own minimum
 * (`pollIntervalMinutes` must be a positive integer, so 1 minute is the shortest legal cadence)
 * without the tick itself becoming a busy loop for a fleet mostly configured at the 60-minute
 * default.
 */
export const DEFAULT_POLL_TICK_MS = 60_000;

export interface IndexTriggerHubDeps {
  server: string;
  coordinator: Pick<IndexCoordinator, 'trigger'>;
  vcsFor: (repoRoot: string) => Pick<VcsBackend, 'currentBase'>;
  /** The identical function `IndexCoordinatorDeps.resolveConfig` uses (`loadIndexConfig`) — ONE
   *  enabled/off gate, never a second one re-derived here (locked decision 10's "avoid defeating
   *  the gate, don't re-implement it," one layer up: this is the layer that decides whether to
   *  even ask the VCS seam anything, which the coordinator itself has no way to skip). */
  resolveConfig: (repoRoot: string) => Promise<ResolvedIndexConfig | null>;
  repos: ReadonlyArray<IndexTriggerRepo>;
  now?: () => number;
  debounceMs?: number;
  pollTickMs?: number;
  logger?: typeof defaultLogger;
}

interface PendingDebounce {
  timer: ReturnType<typeof setTimeout>;
  target: IndexTarget;
}

export class IndexTriggerHub {
  private readonly debounced = new Map<string, PendingDebounce>();
  private readonly statuses = new Map<string, IndexTriggerStatus>();
  private readonly pollDue = new Map<string, number>();
  private pollTimer?: ReturnType<typeof setInterval>;
  private readonly log: typeof defaultLogger;
  private readonly now: () => number;

  constructor(private readonly deps: IndexTriggerHubDeps) {
    this.log = deps.logger ?? defaultLogger;
    this.now = deps.now ?? Date.now;
  }

  private repoByRoot(repoRoot: string): IndexTriggerRepo | undefined {
    return this.deps.repos.find((r) => r.repoRoot === repoRoot);
  }

  private statusFor(repositoryKey: string): IndexTriggerStatus {
    let s = this.statuses.get(repositoryKey);
    if (!s) {
      s = {
        repositoryKey,
        lastRequestedAt: null,
        lastRequestedReason: null,
        lastTriggeredAt: null,
        nextPollAt: null,
      };
      this.statuses.set(repositoryKey, s);
    }
    return s;
  }

  /** Every repository this hub knows about, and what it last did for it — a snapshot, not a live
   *  view (RUN-223's future accessor copies this rather than reaching in). */
  allStatuses(): IndexTriggerStatus[] {
    return [...this.statuses.values()];
  }

  statusOf(repositoryKey: string): IndexTriggerStatus | undefined {
    return this.statuses.get(repositoryKey);
  }

  /**
   * Reconcile every repository once, at daemon startup (acceptance: "every repo with
   * `[index].enabled = true` is reconciled once, and a repo whose base has not moved costs a
   * cursor/base check with no lease and no scan"). Also seeds this repo's own poll due-time, so
   * the shared ticker's first real attempt is a full interval after this reconcile, not
   * immediately on the ticker's first tick.
   */
  async reconcileOnStartup(): Promise<void> {
    for (const repo of this.deps.repos) {
      const config = await this.deps.resolveConfig(repo.repoRoot).catch(() => null);
      if (!config) continue; // off — no currentBase call, no cursor fetch, nothing
      this.pollDue.set(repo.repositoryKey, this.now() + config.pollIntervalMinutes * 60_000);
      await this.requestFromCurrentBase(repo, 'startup');
    }
  }

  /** Start the ONE shared poll ticker (idempotent — a second call is a no-op). `unref`'d, the same
   *  posture every other daemon.ts timer takes: polling must never be why the daemon won't exit. */
  startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.pollTick(), this.deps.pollTickMs ?? DEFAULT_POLL_TICK_MS);
    this.pollTimer.unref?.();
  }

  stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  /** Cancel every PENDING debounce timer without firing it — daemon shutdown. A job already handed
   *  to the coordinator is the coordinator's own `cancelAll`'s job to stop and join; this only
   *  stops a trigger that has not happened yet from happening after the daemon has committed to
   *  going away (`IndexCoordinator.trigger`'s own `stopping` guard, one layer up). */
  stop(): void {
    this.stopPolling();
    for (const pending of this.debounced.values()) clearTimeout(pending.timer);
    this.debounced.clear();
  }

  private async pollTick(): Promise<void> {
    const nowMs = this.now();
    for (const repo of this.deps.repos) {
      const due = this.pollDue.get(repo.repositoryKey);
      if (due !== undefined && nowMs < due) continue;
      const config = await this.deps.resolveConfig(repo.repoRoot).catch(() => null);
      if (!config) {
        // Off repos are never polled at all — no due-time bookkeeping, no currentBase call.
        this.pollDue.delete(repo.repositoryKey);
        continue;
      }
      this.pollDue.set(repo.repositoryKey, nowMs + config.pollIntervalMinutes * 60_000);
      const s = this.statusFor(repo.repositoryKey);
      s.nextPollAt = this.pollDue.get(repo.repositoryKey) ?? null;
      await this.requestFromCurrentBase(repo, 'poll');
    }
  }

  /**
   * The landing/publish trigger site (RUN-222). `sha` is `land.ts`'s own `LandOutcome.sha` — the
   * branch's new head, computed by the landing flow for free. Used DIRECTLY only when
   * `landedBranch` is this repo's own configured `defaultBranch` — the same scope indexing tracks
   * (discretion: "did you take that" — yes, on the path that matters most, the ordinary
   * single-branch repo landing onto its own main line). A landing onto anything else (a per-plan
   * working branch) is real work, but not necessarily this repo's indexed line moving — so this
   * asks the cheap seam for the ACTUAL current base instead of assuming a plan branch's sha
   * describes it.
   *
   * NEVER awaited by the landing path that calls this (locked decision 11) — `stages/integrate.ts`
   * fires this and moves on; every failure here is caught internally and logged, never thrown back.
   */
  async onLanded(repoRoot: string, landedBranch: string, sha: string): Promise<void> {
    try {
      const repo = this.repoByRoot(repoRoot);
      if (!repo) return;
      const config = await this.deps.resolveConfig(repoRoot).catch(() => null);
      if (!config) return;
      if (repo.defaultBranch && landedBranch === repo.defaultBranch) {
        this.recordRequest(repo.repositoryKey, 'landed');
        this.schedule(repo, sha, false);
        return;
      }
      await this.requestFromCurrentBase(repo, 'landed');
    } catch (err) {
      this.log.warn('index trigger (landed) failed', { repoRoot, err: String(err) });
    }
  }

  /**
   * The explicit manual request (discretion: RUN-223's hook — no CLI calls this yet). Bypasses the
   * debounce window: a human who asked to reindex now should not wait out a quiet period meant for
   * coalescing automatic triggers.
   */
  async requestManualReindex(repoRoot: string): Promise<void> {
    const repo = this.repoByRoot(repoRoot);
    if (!repo) return;
    const config = await this.deps.resolveConfig(repoRoot).catch(() => null);
    if (!config) return;
    const current = await this.deps.vcsFor(repoRoot).currentBase(repoRoot, repo.defaultBranch ?? undefined);
    if (!current.ok) {
      this.log.warn('manual reindex request could not resolve a current base', {
        repoRoot,
        detail: current.detail,
      });
      return;
    }
    this.recordRequest(repo.repositoryKey, 'manual');
    this.schedule(repo, current.baseId, true);
  }

  /** Shared by startup/poll/onLanded's non-default-branch path — the caller has ALREADY checked
   *  `resolveConfig` (this method takes no config, deliberately: it never re-derives the
   *  enabled/off gate, it only ever runs once the caller already cleared it). */
  private async requestFromCurrentBase(repo: IndexTriggerRepo, reason: IndexTriggerReason): Promise<void> {
    this.recordRequest(repo.repositoryKey, reason);
    const current = await this.deps
      .vcsFor(repo.repoRoot)
      .currentBase(repo.repoRoot, repo.defaultBranch ?? undefined);
    if (!current.ok) {
      // Locked decision 2: an unknown base fires NO trigger, ever — never a fabricated one.
      this.log.debug('index trigger skipped — current base unknown', {
        repositoryKey: repo.repositoryKey,
        reason,
        detail: current.detail,
      });
      return;
    }
    this.schedule(repo, current.baseId, false);
  }

  private recordRequest(repositoryKey: string, reason: IndexTriggerReason): void {
    const s = this.statusFor(repositoryKey);
    s.lastRequestedAt = this.now();
    s.lastRequestedReason = reason;
  }

  private buildTarget(repo: IndexTriggerRepo, currentBaseId: string): IndexTarget {
    return {
      server: this.deps.server,
      projectId: repo.projectId,
      repositoryKey: repo.repositoryKey,
      checkoutId: repo.checkoutId,
      repoRoot: repo.repoRoot,
      currentBaseId,
      projectKey: repo.projectKey,
    };
  }

  /** Debounce (locked decision 9): a fresh request for this job key REPLACES whatever timer was
   *  already waiting — a true quiet-window debounce, not a throttle, so it always fires against
   *  the LATEST base a burst of requests supplied. `immediate` skips the timer outright (the
   *  manual request path). */
  private schedule(repo: IndexTriggerRepo, currentBaseId: string, immediate: boolean): void {
    const target = this.buildTarget(repo, currentBaseId);
    const existing = this.debounced.get(repo.repositoryKey);
    if (existing) clearTimeout(existing.timer);
    if (immediate) {
      this.debounced.delete(repo.repositoryKey);
      this.fire(repo.repositoryKey, target);
      return;
    }
    const timer = setTimeout(() => {
      this.debounced.delete(repo.repositoryKey);
      this.fire(repo.repositoryKey, target);
    }, this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    timer.unref?.();
    this.debounced.set(repo.repositoryKey, { timer, target });
  }

  private fire(repositoryKey: string, target: IndexTarget): void {
    const s = this.statusFor(repositoryKey);
    s.lastTriggeredAt = this.now();
    // `trigger` never throws for an ordinary failure (index-coordinator.ts's own doc — every
    // outcome is logged internally); this catch is only for a genuinely unexpected rejection, so a
    // background subsystem's surprise never becomes an unhandled rejection.
    void this.deps.coordinator
      .trigger(target)
      .catch((err) => this.log.warn('index trigger failed', { repositoryKey, err: String(err) }));
  }
}
