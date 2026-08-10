import type { IndexJournal } from './index-journal';
import type { ResolvedIndexConfig } from './index-policy';
import { INDEXER_VERSION, type IndexReconcileOutcome, associationNotice, reconcile } from './index-reconcile';
import type { IndexJobPhase, IndexStatusEvent } from './index-status';
import { logger as defaultLogger } from './logger';
import type { RunnerIndexCursor } from './memory-contract';
import type { ChangesBetweenResult, IndexSnapshot, VcsBackend } from './vcs/types';

/**
 * The deterministic index job coordinator (RUN-214) — lifecycle only. It sequences snapshot lease,
 * manifest resolution, reconciliation, and release around a single injected work step; it owns
 * none of that step's content.
 *
 * **The coordinator owns LIFECYCLE, not content** (locked decision 1). Parsers, batching, and the
 * upload client do not exist yet (Phases 3/4), so the middle of a job — turning a leased snapshot
 * plus a reconcile outcome into indexed, uploaded batches — is `IndexWorkStep`, an INJECTED
 * function this module never implements. Every acceptance line RUN-214 carries is about lifecycle
 * (coalescing, the single-job guard, release, cancellation, priority) and every one of them is
 * provable with a no-op work step — which is the intended test double, not a shortcut around one.
 * What must never happen is a fake parser or an inline placeholder INSIDE this file that Phase 3
 * has to go find and delete; the seam itself is the deliverable.
 *
 * **The job key is (server, CANONICAL repositoryKey)** — never a local repo root, never
 * `RunnerRepo.id` (locked decision 2). Two checkouts of the same canonical repository on one
 * machine must not both index it: they would produce two generations for the same (project,
 * repository, branch, baseId, indexerVersion) and race the server's activation. A trigger that
 * arrives for a different LOCAL checkout of the same canonical repository coalesces exactly like a
 * second trigger for the same checkout would.
 *
 * **Duplicate triggers coalesce into at most one active job plus at most ONE pending re-run flag**
 * (locked decision 3) — never a queue. The triggers this exists for (startup, after landing, after
 * publishing, a version bump, a periodic poll — RUN-222's, not built here) can all fire within
 * seconds of each other, and a queue of N identical full-index jobs would be N full monorepo scans
 * for one answer. The flag keeps the only thing a queue would buy — "something changed while we
 * worked, look again" — at O(1), and a fresh trigger simply replaces whatever was pending: the
 * latest fact about what changed is the only one worth re-checking.
 *
 * **The guard is IN-PROCESS ONLY** — a plain in-memory map, never a lockfile or directory lock
 * (locked decision 4). The acceptance this exists to satisfy is "a daemon crash cannot leave an
 * unreleasable local index lock", and the only guarantee strong enough for that is a lock that
 * cannot outlive the process holding it. A crashed daemon's leftover SNAPSHOTS are the STARTUP reap
 * sweep's job (RUN-211's follow-up made snapshot pruning startup-only for exactly this reason: a
 * periodic sweep must never delete a live one).
 *
 * **This checkout's current base is a CALLER-SUPPLIED fact, not something this module derives.**
 * Reconciling requires it before a snapshot may be leased (see `IndexTarget.currentBaseId`'s doc)
 * — deliberately: obtaining it by leasing would defeat locked decision 6 for every outcome that
 * must never touch the lease pool at all.
 */

/**
 * One request to (re)index a canonical repository. `currentBaseId` is supplied by the caller — the
 * trigger mechanism (RUN-222, not built here) is the one place that can cheaply learn "what is
 * current" for its own backend (a landing event's own sha, a periodic `rev-parse HEAD`) without
 * paying for a lease just to ask. Deriving it INSIDE this coordinator would mean leasing a snapshot
 * before `reconcile` has run — exactly what locked decision 6 forbids for `unchanged`,
 * `unavailable`, `incompatible-version`, and `association-conflict`, none of which may ever touch
 * the lease pool.
 */
export interface IndexTarget {
  /** Which Noriq this checkout reports to — part of the job key and the journal key alike. */
  server: string;
  /** This daemon's resolved Noriq project for the repo, or null when unresolved — threaded to
   *  `getCursor` verbatim; `client.ts`'s `getIndexCursor` already treats a null project as a
   *  precondition failure (`unavailable`), never a fetch attempt. */
  projectId: string | null;
  /** The canonical, project-local repository key (Project Memory §6) — the job key's other half. */
  repositoryKey: string;
  /** The committed project KEY (`.noriq/project.toml`'s `key`) — distinct from `repositoryKey`
   *  above, and from `projectId`: `IndexRunTarget.projectKey` (`indexer.ts`'s `UriScope`) needs it
   *  to mint entity URIs, and nothing else on this daemon derives a project's key from its id or
   *  its repository key. Threaded here (RUN-222) rather than looked up inside the work step —
   *  the trigger layer already holds the repo's manifest when it builds this target, and a second
   *  lookup inside the work step would be a second answer to "what identifies this project." */
  projectKey: string;
  /** This runner-local checkout's own id (`RunnerRepo.id`/`repoId()`) — `client.ts`'s
   *  `checkoutId`, distinct from the job key: many checkouts may share one `repositoryKey`. */
  checkoutId: string;
  /** Where this checkout lives on disk — leased, scanned, and manifest-resolved from here. */
  repoRoot: string;
  /** This checkout's current base, in the backend's own id-space (`Workspace.baseId`'s exact
   *  contract) — see this interface's module doc for why it is caller-supplied. */
  currentBaseId: string;
  /** Defaults to `INDEXER_VERSION` — threaded so a test can vary skew without faking the module's
   *  own export, `ReconcileInput`'s exact reasoning. */
  indexerVersion?: string;
}

/** The two reconcile outcomes that may ever start work (locked decision 6). */
export type IndexWorkOutcome = Extract<IndexReconcileOutcome, { outcome: 'incremental' | 'full' }>;

/** What the injected work step receives — the snapshot and the outcome (discretion), plus the
 *  resolved manifest config it needs to scan and the journal it may record progress into, and the
 *  signal it must honour for cancellation to be prompt (decision 8/11: the coordinator can only
 *  ask; a step that never checks `signal` is simply awaited to its own completion). */
export interface IndexWorkContext {
  target: IndexTarget;
  snapshot: IndexSnapshot;
  outcome: IndexWorkOutcome;
  config: ResolvedIndexConfig;
  journal: IndexJournal;
  signal: AbortSignal;
  /** RUN-238: the SAME predicate `attempt()` checks once before leasing, re-exposed here so a work
   *  step can re-check it at its own yield points during a long parse — a run assigned mid-pass
   *  used to share a starved loop for the whole remainder, because `isRunBusy()` was consulted
   *  exactly once, at the top of this class's own `attempt()`. This is a straight pass-through of
   *  `IndexCoordinatorDeps.isRunBusy`, never a second predicate: one daemon-owned notion of "busy",
   *  read from two places. */
  isRunBusy: () => boolean;
  /** RUN-223 locked decision 4: the work step is the ONLY code that knows when parsing ends and
   *  uploading begins, or when the server starts validating `complete()` — a phase inferred from
   *  elapsed time or a journal side effect would be a guess dressed as a status. Optional so a
   *  work step (including every existing test double) stays usable with no listener at all;
   *  absent in production only when `IndexCoordinatorDeps.onStatus` itself was never supplied. */
  onProgress?: (phase: IndexJobPhase, detail?: string) => void;
}

/** What a successful attempt reports back for `IndexStatusStore`'s `'success'` event (RUN-223) —
 *  optional so a no-op test work step may keep returning `void`, and the coordinator falls back
 *  to what it can derive itself (the leased snapshot's own base) when a step reports nothing. */
export interface IndexWorkResult {
  generationId: string;
  baseId: string;
  batchesReceived: number;
  /** Server-confirmed atomic activation from complete(); absent for older servers/test doubles. */
  activated?: string;
}

export type IndexWorkStep = (ctx: IndexWorkContext) => Promise<IndexWorkResult> | Promise<void>;

export interface IndexCoordinatorDeps {
  /** The backend this checkout's `repoRoot` speaks through — the same `backendFor.get(root) ??
   *  vcs` routing every other VCS-seam caller in daemon.ts uses. */
  vcsFor: (
    repoRoot: string,
  ) => Pick<VcsBackend, 'leaseIndexSnapshot' | 'releaseIndexSnapshot' | 'changesBetween'>;
  /** The resolved `[index]` execution policy, re-read fresh (`loadIndexConfig`'s exact contract) —
   *  null means indexing is off or the committed policy is invalid, and this coordinator treats
   *  that as "nothing to do" before it ever asks the server for a cursor. */
  resolveConfig: (repoRoot: string) => Promise<ResolvedIndexConfig | null>;
  /** RUN-213's index cursor fetch (`client.ts`'s `getIndexCursor`) — null on every failure mode,
   *  `reconcile`'s own contract. */
  getCursor: (target: IndexTarget) => Promise<RunnerIndexCursor | null>;
  /** The injected middle (locked decision 1). */
  runWork: IndexWorkStep;
  /** The disposable upload journal (RUN-214, locked decision 5) — handed to the work step, never
   *  read or interpreted by this coordinator. */
  journal: IndexJournal;
  /** True while the daemon should not start (or continue backing off) background indexing because
   *  it is busy with runs (locked decision 10) — an injected predicate so the daemon's own notion
   *  of "busy" stays in the daemon, not here. Checked before every attempt, including a coalesced
   *  re-run. */
  isRunBusy: () => boolean;
  /** RUN-223's operator-status hook — optional, and this coordinator's own lifecycle contract is
   *  byte-identical with or without one. Called at every observable transition of an attempt
   *  (reconcile decided, a work-step phase, success, failure) so `IndexStatusStore` can build the
   *  CLI-facing surface without this file taking on a second opinion about what "done" or "failed"
   *  means — it only reports the same decisions this class already makes. A throwing listener is
   *  swallowed (logged), the same posture every other best-effort observer in this file takes. */
  onStatus?: (event: IndexStatusEvent) => void;
  logger?: typeof defaultLogger;
}

/** One in-process job key: server + CANONICAL repositoryKey, joined with a separator that cannot
 *  appear in either half (neither is ever a NUL-containing string in practice, but `\u0000` makes
 *  the join unambiguous rather than merely unlikely to collide). */
function jobKey(target: Pick<IndexTarget, 'server' | 'repositoryKey'>): string {
  return `${target.server}\u0000${target.repositoryKey}`;
}

interface ActiveJob {
  abort: AbortController;
  /** Resolves once the attempt (and its snapshot release) has fully settled — what `cancelAll`
   *  joins (locked decision 11). Never rejects: `attempt` catches its own work-step failure so a
   *  background subsystem's error never surfaces as an unhandled rejection to whoever triggered it. */
  done: Promise<void>;
}

export class IndexCoordinator {
  private readonly active = new Map<string, ActiveJob>();
  /** At most one pending re-run per job key (locked decision 3) — a `Map.set` on an existing key
   *  overwrites rather than queues, which is the whole mechanism: the LATEST trigger's facts are
   *  the only ones worth re-checking once the active job finishes. */
  private readonly pending = new Map<string, IndexTarget>();
  private stopping = false;
  private readonly log: typeof defaultLogger;

  constructor(private readonly deps: IndexCoordinatorDeps) {
    this.log = deps.logger ?? defaultLogger;
  }

  /** Is a job active for this target's canonical repository right now? Exposed for the
   *  crash-recovery acceptance: a freshly constructed coordinator has nothing here at all, which
   *  is the whole point of an in-process-only guard (locked decision 4) — there is no lock to
   *  clear because there is nowhere for one to have survived to. */
  hasActiveJob(target: Pick<IndexTarget, 'server' | 'repositoryKey'>): boolean {
    return this.active.has(jobKey(target));
  }

  /**
   * RUN-223's per-repo cancel — a narrower sibling of `cancelAll`, added for the operator control
   * surface. Locked decision 10: the guard this reaches into stays IN-PROCESS ONLY — this method
   * aborts the same `AbortController` `cancelAll` already aborts, and adds no lockfile, no
   * persisted "cancel requested" record, and no new way for a crashed daemon to leave something
   * behind. Returns `false` (no-op) when nothing is active for this job key — including the
   * ordinary case where the request raced the job's own completion — never throws. Also drops any
   * PENDING re-run for this key, the same reasoning `cancelAll` states for its own shutdown: an
   * operator who asked to cancel a job must not have it resurrected moments later by a re-run flag
   * a trigger set just before the cancel arrived.
   */
  cancelRepo(target: Pick<IndexTarget, 'server' | 'repositoryKey'>): boolean {
    const key = jobKey(target);
    this.pending.delete(key);
    const job = this.active.get(key);
    if (!job) return false;
    job.abort.abort();
    return true;
  }

  /**
   * Ask this canonical repository to be (re)indexed. Coalesces with whatever is already running
   * for the same job key (locked decision 3): a trigger arriving while a job is active replaces
   * the one pending re-run flag and returns immediately, never starting a second job and never
   * queuing a third.
   */
  async trigger(target: IndexTarget): Promise<void> {
    // Shutting down: never start new work, and never let a coalesced re-run resurrect after
    // `cancelAll` has already begun tearing down (see its own doc).
    if (this.stopping) return;
    const key = jobKey(target);
    if (this.active.has(key)) {
      this.pending.set(key, target);
      return;
    }
    await this.run(target);
  }

  private async run(target: IndexTarget): Promise<void> {
    const key = jobKey(target);
    const abort = new AbortController();
    const done = this.attempt(target, abort.signal).finally(() => {
      this.active.delete(key);
      const next = this.pending.get(key);
      if (next) {
        this.pending.delete(key);
        // Re-triggering (rather than re-running the same attempt inline) re-checks EVERYTHING
        // from the top — the busy predicate, the manifest, the cursor — because a pending re-run
        // exists precisely because the world may have moved again while the finished job ran.
        if (!this.stopping) void this.trigger(next);
      }
    });
    this.active.set(key, { abort, done });
    await done;
  }

  /** RUN-223: forward one status event to `deps.onStatus`, if any — never lets a throwing listener
   *  reach into this class's own control flow (see the dep's own doc). */
  private emitStatus(event: IndexStatusEvent): void {
    if (!this.deps.onStatus) return;
    try {
      this.deps.onStatus(event);
    } catch (err) {
      this.log.warn('index status listener threw', { err: String(err) });
    }
  }

  /** One job attempt end to end: priority defer, manifest gate, reconcile, lease, work, release. */
  private async attempt(target: IndexTarget, signal: AbortSignal): Promise<void> {
    const rk = target.repositoryKey;

    // Locked decision 10: run execution outranks background indexing outright, checked first and
    // cheaply — no cursor fetch, no lease. The contention indexing yields to is CPU/IO, not a pool
    // slot, so asking costs nothing and buys the one thing that matters: indexing must never
    // block, delay, or queue ahead of a run.
    if (this.deps.isRunBusy()) {
      this.log.debug('index trigger deferred — the daemon is busy with runs', { repositoryKey: rk });
      return;
    }

    // Manifest resolution, re-read fresh (RUN-208's "no restart needed" contract, re-asserted here
    // the same way `scanIndexSource` re-asserts `[index].enabled`): a repo whose indexing is off
    // or misconfigured gets no cursor fetch and no lease, ever.
    const config = await this.deps.resolveConfig(target.repoRoot);
    if (!config) {
      this.log.debug('index trigger skipped — indexing is off or misconfigured for this repo', {
        repositoryKey: rk,
      });
      return;
    }

    const cursor = await this.deps.getCursor(target);
    if (cursor) {
      const notice = associationNotice(cursor.association);
      if (notice) this.log[notice.level](notice.message, { repositoryKey: rk });
    }

    const vcs = this.deps.vcsFor(target.repoRoot);
    // `changesBetween` is only ever asked when the base actually moved — `reconcile` treats an
    // absent result exactly like `{ok:false}` (RUN-212's contract), so there is nothing to gain
    // from asking when the active generation's own base already matches.
    let changesBetween: ChangesBetweenResult | undefined;
    if (cursor?.activeGeneration && cursor.activeGeneration.baseId !== target.currentBaseId) {
      changesBetween = await vcs
        .changesBetween(target.repoRoot, cursor.activeGeneration.baseId, target.currentBaseId)
        .catch(
          (err): ChangesBetweenResult => ({
            ok: false,
            reason: 'full-index-required',
            detail: err instanceof Error ? err.message : String(err),
          }),
        );
    }

    const outcome = reconcile({
      cursor,
      currentBaseId: target.currentBaseId,
      indexerVersion: target.indexerVersion ?? INDEXER_VERSION,
      changesBetween,
    });
    // RUN-223: every reconcile outcome is reported, before the switch below decides whether to
    // proceed — `reconcileOperatorState` (index-status.ts) is the one place that folds all six
    // into the operator vocabulary, exhaustively, so this call site owes it nothing but the raw
    // outcome. RUN-260: `activeGenerationId` rides along too — the cursor's own
    // `activeGeneration.id`, straight from the fetch above, no second call. It is the ONLY
    // evidence `index-status.ts` may ever promote a record to `'active'` from; this coordinator
    // does not decide what it means, only that it is real.
    this.emitStatus({
      type: 'reconcile',
      repositoryKey: rk,
      outcome,
      activeGenerationId: cursor?.activeGeneration?.id ?? null,
    });

    // Locked decision 6: only `incremental` and `full` may ever lease a snapshot. Every other
    // outcome logs at its own level and returns here — RUN-213 already decided all six outcomes
    // and each has its own reason not to proceed; re-deciding any of them here would be a second,
    // weaker copy.
    switch (outcome.outcome) {
      case 'unchanged':
        this.log.debug('index unchanged — nothing to do', { repositoryKey: rk });
        return;
      case 'unavailable':
        this.log.warn('index cursor unavailable — deferring to the next trigger', {
          repositoryKey: rk,
          reason: outcome.reason,
        });
        return;
      case 'incompatible-version':
        this.log.error('active index generation is newer than this daemon can produce — refusing', {
          repositoryKey: rk,
          activeIndexerVersion: outcome.activeIndexerVersion,
          ourIndexerVersion: outcome.ourIndexerVersion,
        });
        return;
      case 'association-conflict':
        this.log.error('repository association conflict — indexing refused for this checkout', {
          repositoryKey: rk,
          projectRepositoryId: outcome.projectRepositoryId,
          reason: outcome.reason,
        });
        return;
      case 'incremental':
      case 'full':
        break; // the only two outcomes that may lease — fall through.
    }

    if (signal.aborted) {
      // Cancelled between the decision above and the lease below — without this the status
      // surface would be left showing `queued` forever for a job that will never now start.
      this.emitStatus({ type: 'failure', repositoryKey: rk, detail: 'cancelled before the job could start' });
      return;
    }

    const lease = await vcs.leaseIndexSnapshot(target.repoRoot);
    if (!lease.ok) {
      if (lease.reason === 'busy') {
        // Locked decision 9: routine by construction, never an error log, and never treated as
        // having consumed a pending re-run flag — there was none to consume here (a `busy` lease
        // simply means the NEXT trigger, whenever it comes, tries again from scratch).
        this.log.debug('index snapshot lease busy — indexing yields to a run', { repositoryKey: rk });
      } else {
        this.log.warn('this backend cannot produce an index snapshot', {
          repositoryKey: rk,
          detail: lease.detail,
        });
      }
      return;
    }

    const snapshot = lease.snapshot;
    try {
      if (signal.aborted) {
        // Cancelled while the lease call was in flight — same reasoning as the abort check above.
        this.emitStatus({
          type: 'failure',
          repositoryKey: rk,
          detail: 'cancelled while acquiring the snapshot',
        });
        return;
      }
      const onProgress = this.deps.onStatus
        ? (phase: IndexJobPhase, detail?: string) =>
            this.emitStatus({ type: 'phase', repositoryKey: rk, phase, detail })
        : undefined;
      const result = await this.deps.runWork({
        target,
        snapshot,
        outcome,
        config,
        journal: this.deps.journal,
        signal,
        isRunBusy: this.deps.isRunBusy,
        onProgress,
      });
      // Current servers return their own atomic activation result from complete(); older servers
      // do not. Report exactly that evidence rather than assuming either state from HTTP success.
      this.log.info(
        result?.activated
          ? 'index generation uploaded, validated, and activated'
          : 'index generation uploaded and validated — server did not confirm activation',
        {
          repositoryKey: rk,
          kind: outcome.outcome,
          generationId: result?.generationId ?? 'unknown',
          batchesReceived: result?.batchesReceived ?? 0,
          activated: result?.activated ?? null,
        },
      );
      // RUN-223: a work step that reports nothing (every existing no-op test double) still gets an
      // honest success transition without claiming activation — the snapshot's own base is the
      // best this class can
      // derive on its own, and `generationId: 'unknown'` names exactly what it does not know
      // rather than fabricating one. See index-status.ts for why bare success remains staged.
      this.emitStatus({
        type: 'success',
        repositoryKey: rk,
        generationId: result?.generationId ?? 'unknown',
        baseId: result?.baseId ?? snapshot.baseId,
        batchesReceived: result?.batchesReceived ?? 0,
        ...(result?.activated ? { activated: result.activated } : {}),
      });
    } catch (err) {
      // A background subsystem's failure is logged, never thrown at whoever called `trigger` —
      // the same posture `orphanSweep`/`owedMergeReconciler` take on their own per-item work.
      this.log.error('index work step failed', { repositoryKey: rk, err: String(err) });
      this.emitStatus({
        type: 'failure',
        repositoryKey: rk,
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // Locked decision 7: EVERY exit path releases — success, no-work, a thrown step, or
      // cancellation, all reach this `finally`. `releaseIndexSnapshot` is idempotent and refuses a
      // foreign object, so this is free even from a path above that returned before a lease was
      // ever taken. Locked decision 8: cancellation releases the snapshot and stops HERE — no call
      // anywhere in this class touches server-side staging, so an interrupted upload's staged
      // generation is left exactly as RUN-213 surfaces it: a resume candidate for the next attempt.
      await vcs
        .releaseIndexSnapshot(snapshot)
        .catch((err) =>
          this.log.warn('failed to release an index snapshot', { repositoryKey: rk, err: String(err) }),
        );
    }
  }

  /**
   * Shutdown (locked decision 11): cancel every in-flight job and JOIN it — never merely signal
   * and return, which is the exact race the orphan-sweep join in `daemon.ts`'s `stop()` already
   * guards against, one layer over: returning while a snapshot is still being read is how a
   * shutdown races its own cleanup. Idempotent, and safe with nothing running.
   *
   * Clears the pending map too: a re-run flag set moments before shutdown must not resurrect a job
   * after `cancelAll` has already returned — that would be starting new work during a shutdown
   * this daemon has committed to, the same rule `stopping` enforces in `trigger`/`run` above.
   */
  async cancelAll(): Promise<void> {
    this.stopping = true;
    this.pending.clear();
    const jobs = [...this.active.values()];
    for (const job of jobs) job.abort.abort();
    await Promise.allSettled(jobs.map((j) => j.done));
  }
}
