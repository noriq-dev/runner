import type {
  AgentTool,
  ExecutedConfigurationEvidence,
  ExecutionSpec,
  ProjectManifest,
  Run,
  RunKind,
  RunModelUsage,
  RunnerConfig,
} from '@noriq-dev/shared';
import { NoriqClient, type OwedMerge } from './client';
import { type ContinuableRun, ContinuableStore } from './continuable';
import { discoverRepos, loadIndexConfig } from './discovery';
import { totalTokens } from './drivers/budget';
import { ClaudeDriver } from './drivers/claude';
import { CodexDriver } from './drivers/codex';
import { EpisodePendingStore, filePendingEpisodeStore } from './episode-pending';
import { type EpisodeDeliveryDeps, deliverEpisode, drainPendingEpisodes } from './episode-upload';
import { IndexControlServer } from './index-control';
import { IndexCoordinator } from './index-coordinator';
import { IndexJournal, fileJournalStore } from './index-journal';
import { fileStagingStore, sweepOrphanedStaging } from './index-stage';
import { IndexStatusStore, fileIndexStatusPersist } from './index-status';
import { IndexTriggerHub, type IndexTriggerRepo } from './index-triggers';
import { createIndexWorkStep } from './index-work';
import { resolveLandBranch } from './land';
import { LockClient } from './lock-client';
import { logger as defaultLogger } from './logger';
import { ManifestStore } from './manifest-store';
import { ParkedStore } from './parked';
import { buildRegistration, repoReport } from './registration';
import { RepoIntel, fileIntelStore } from './repo-intel';
import { loadState, saveState } from './state';
import { SteeringBridge } from './steering';
import { owningRunId } from './steps';
import { type RunReport, RunSupervisor, type RunSupervisorDeps } from './supervisor';
import { detectTools } from './tools';
import { checkForUpdate, updateAdvice } from './update';
import { detectVcs } from './vcs/detect';
import { DiversionBackend } from './vcs/diversion';
import { GitBackend } from './vcs/git';
import { PerforceBackend } from './vcs/perforce';
import type { VcsBackend } from './vcs/types';
import { VerificationPendingStore, filePendingVerificationStore } from './verification-pending';
import {
  type VerificationReportDeliveryDeps,
  deliverVerificationReport,
  drainPendingVerificationReports,
} from './verification-report';
import { type WorkflowCatalog, WorkflowStore } from './workflow-store';
import { DEFAULT_WORKTREES_DIR, WorktreeManager } from './worktree';
import { WsClient, type WsFactory } from './ws-client';

/** How long shutdown waits for stopped runs to report a terminal status. */
const SHUTDOWN_DRAIN_MS = 5_000;

/**
 * How often the daemon re-runs the orphan sweep (RUN-153).
 *
 * Long on purpose. This reclaims disk, never work: a leaked workspace holds either nothing or a
 * copy of something already durable, so the cost of waiting is a directory sitting around. The
 * sweep shells out to git per repo, and doing that every minute to catch a leak that happens on a
 * lock refusal would spend far more than it saves.
 */
const ORPHAN_SWEEP_INTERVAL_MS = 30 * 60_000;

/**
 * Is this report worth a `run.status` frame? Status transitions are the point, but a report
 * that carries NEW FACTS must go too even when the status is unchanged.
 *
 * Extracted and exported purely so it can be tested. A change-only test has now silently
 * dropped a frame twice: once for terminal `finishedAt`, and again for `agentId` — the
 * supervisor reports `running` with the worktree, then `running` again once the agent is
 * created, so a naive `changed` check would discard the identity and leave run.status.agentId
 * null forever. That is the very bug RUN-43 exists to fix, reintroduced one layer down.
 */
export function shouldForwardRunStatus(
  previous: string | undefined,
  rep: Pick<RunReport, 'status' | 'worktreePath' | 'agentId' | 'exit'>,
): boolean {
  return previous !== rep.status || rep.worktreePath != null || rep.exit != null || rep.agentId != null;
}

/**
 * The telemetry frame's spend fields for a report (RUN-22/59). Extracted and exported for the same
 * reason shouldForwardRunStatus is: the null-vs-clear semantics of `modelUsage` are exactly the kind
 * of subtlety that ships wrong and silently.
 *
 * `modelUsage` is a TRI-STATE, and deliberately NOT plain null-means-no-news like the others:
 *   - a mix object   → the authoritative per-model breakdown; it sums to the totals on this frame.
 *   - `{}`           → telemetry IS present but cannot be attributed by model (a codex session, the
 *                      claude usage-fallback, or a run whose sessions no longer all report a mix). An
 *                      EXPLICIT clear the server must STORE — because a stale mix from an earlier,
 *                      then-complete frame must not outlive the spend it no longer sums to. `null`
 *                      cannot express this: the server COALESCEs null as "keep", which would pin the
 *                      stale mix beside a climbing total forever (the exact bug this exists to remove).
 *   - `null`         → no news — a phase-only tick with no telemetry at all; COALESCE keeps what is
 *                      stored, so a "verifying" tick never wipes the spend or the mix.
 *
 * The key invariant: every frame that carries telemetry carries the mix's CURRENT truth (object or
 * `{}`), so the stored mix always reflects the last spend-bearing frame — never a retraction that
 * `null` silently swallowed.
 */
export function telemetryFrame(rep: Pick<RunReport, 'telemetry'>): {
  tokensUsed: number | null;
  usdSpent: number | null;
  modelUsage: RunModelUsage | null;
} {
  if (!rep.telemetry) return { tokensUsed: null, usdSpent: null, modelUsage: null };
  return {
    tokensUsed: totalTokens(rep.telemetry),
    usdSpent: rep.telemetry.costUsd,
    // `?? {}`, never `?? null`: an unattributable telemetry frame CLEARS a stored mix rather than
    // leaving it stale under COALESCE. Only the no-telemetry branch above sends null (no news).
    modelUsage: rep.telemetry.modelUsage ?? {},
  };
}

export interface DaemonHandle {
  runnerId: string;
  /** Stop live agents, let them report, then close the socket. Await it before exiting. */
  stop(): Promise<void>;
}

/**
 * Build the dispatch-time repo resolver from read-at-use stores (RUN-192).
 *
 * Extracted because this composition is the property: both reads happen for every dispatch, and
 * the returned manifest/catalog pair is then pinned together for that run. Keeping it behind
 * injectable functions proves that wiring without making a test walk a real repo or invoke git.
 */
export function workflowRepoResolver(deps: {
  repos: ReadonlyArray<{ id: string; root: string }>;
  manifestFor: (root: string) => Promise<ProjectManifest | null>;
  workflowsFor: (root: string, manifest: ProjectManifest) => Promise<WorkflowCatalog>;
  vcsFor?: (root: string) => VcsBackend | undefined;
}): RunSupervisorDeps['resolveRepo'] {
  const reposById = new Map(deps.repos.map((repo) => [repo.id, repo]));
  return async (repoRef) => {
    const repo = reposById.get(repoRef);
    if (!repo) return null;
    const manifest = await deps.manifestFor(repo.root);
    if (!manifest) return null;
    const workflowCatalog = await deps.workflowsFor(repo.root, manifest);
    return {
      root: repo.root,
      manifest,
      workflowCatalog,
      ...(deps.vcsFor ? { vcs: deps.vcsFor(repo.root) } : {}),
    };
  };
}

/**
 * The slice of the supervisor the daemon actually drives (RUN-173). Injected so a test can capture
 * the wired-up `report` callback — the closure that owes the executed-spec record and must hold it
 * until a frame carrying it actually leaves the socket — and exercise delivery/retention without a
 * real run and its whole pipeline. `RunSupervisor` satisfies it; the return types widen to
 * `Promise<unknown>` because the daemon fires these and never reads their result.
 */
export interface SupervisorLike {
  supervise(run: Run): Promise<unknown>;
  resume(runId: string, answer: string): Promise<unknown>;
  /** Deliver an answer to a stage holding in-process (RUN-190). True = delivered, no restore. */
  deliverStageAnswer(runId: string, answer: string): boolean;
  expireStaleParks(): Promise<number>;
}

/**
 * The predictive lock layer's scope source (RUN-130), extracted so it is TESTED rather than
 * living as an untested lambda in the wiring below — the same reasoning that put
 * `shouldForwardRunStatus` up here, and for the same reason: this whole layer was silently dead
 * for want of one line.
 *
 * A continuation is the case that can honestly declare a write scope today. Its failed sitting
 * recorded the paths it changed, and the run resuming that work will almost certainly touch them
 * again — so taking them before it respawns is precisely the race RUN-103 was built to prevent.
 * Anything else (a first sitting, a lost record, a backend with no `changedPaths`) yields null,
 * and the layer no-ops exactly as it did while nothing was bound.
 */
export const continuationLockScope =
  (store: { get(runId: string): Promise<ContinuableRun | null> }) =>
  async (run: Run, spec: ExecutionSpec | null): Promise<string[] | null> => {
    // The DECLARED scope first (RUN-142). Until now the predictive layer only ever had a
    // continuation's `changedPaths` — what a previous sitting touched — which by definition does
    // not exist the first time a task is attempted, so the layer has never held a lock on a first
    // dispatch. A spec's `anticipatedFiles` is the first thing that says, before any work, which
    // files this run intends to touch.
    //
    // UNION, not preference: a continued run's scope is what it declared PLUS what it already
    // touched, because the previous sitting's edits are exactly what a second run must not land
    // on top of, and a spec written before that sitting cannot know about them.
    const prior = await store.get(run.id).catch(() => null);
    const declared = spec?.anticipatedFiles.map((f) => f.path) ?? [];
    const scope = [...new Set([...declared, ...(prior?.changedPaths ?? [])])];
    return scope.length ? scope : null;
  };

/**
 * The orphan sweep (RUN-153), run at start AND on a timer — extracted here for the same reason
 * `continuationLockScope` is: this file's wiring is where a whole layer once sat dead and silent,
 * and a sweep that never fires (or one that reaps a live run) fails exactly as quietly.
 *
 * What it removes: a workspace nothing will ever come back for. A lock refusal that deliberately
 * KEEPS one holding work (RUN-130), and one kept because its `hasWork` probe merely errored
 * (RUN-152) — the latter has no continuation record, so no later dispatch adopts it. Left alone
 * those accumulate for the daemon's lifetime, which is the whole reason this runs on a timer.
 *
 * What it must never remove is the harder half, and it takes BOTH inputs. A live run's workspace
 * is indistinguishable from a leaked one by inspection, and can be legitimately EMPTY (an agent
 * that has not written a file yet) — so the reap's own work-bearing check cannot spare it, and
 * `isActive` must. A parked or continuable run is worse: nothing is supervising it at all, so it
 * is not active by definition, and it too can be pristine. Only `reserved` knows. "Every prior
 * process is gone" makes a workspace unsupervised, not unwanted — which is why the startup sweep
 * needs `reserved` just as much as the periodic one does, and gets it.
 */
export function orphanSweep(deps: {
  repos: ReadonlyArray<{ root: string }>;
  vcsFor: (root: string) => Pick<VcsBackend, 'reapOrphans'>;
  /** Runs supervising RIGHT NOW. Live, not a snapshot — a resume can start mid-sweep. */
  isActive: (runId: string) => boolean;
  /**
   * Runs nothing is supervising but something is HOLDING a workspace for: parked runs waiting on
   * a human (RUN-30) and continuable failures a later dispatch adopts (RUN-91). These are the
   * cases `active` cannot see and the reap's work-bearing check cannot save — a park can be
   * pristine (a scope run that asked before writing), and a continuation kept after an uncertain
   * probe may hold no diff at all. Both would otherwise be swept as leaks, and the resume that
   * came back for them would find nothing there.
   */
  reserved: () => Promise<string[]>;
  logger?: typeof defaultLogger;
}): (periodic: boolean) => Promise<{ reaped: number; kept: string[] }> {
  const log = deps.logger ?? defaultLogger;
  return async (periodic) => {
    let reaped = 0;
    const kept: string[] = [];
    // Resolved fresh per sweep, and FAIL CLOSED: a store we could not read is not a store with
    // nothing in it. Sweeping on that assumption is how the reaper deletes the one worktree a
    // parked run is waiting to come home to.
    let held: Set<string>;
    try {
      held = new Set(await deps.reserved());
    } catch (err) {
      log.warn('skipping the orphan sweep — could not read what is being held', { err: String(err) });
      return { reaped: 0, kept: [] };
    }
    // A wave child's workspace rides its parent run's identity (RUN-170): its id embeds the
    // parent's, and it is exactly as owned as that run is — live mid-wave, or held by a park or
    // continuation. Without the fold the periodic sweep reads a live child as a leak and deletes
    // the checkout its step is working in.
    const isOwned = (runId: string) => {
      if (deps.isActive(runId) || held.has(runId)) return true;
      const owner = owningRunId(runId);
      return owner !== runId && (deps.isActive(owner) || held.has(owner));
    };
    for (const r of deps.repos) {
      reaped += await deps
        .vcsFor(r.root)
        .reapOrphans(r.root, { onSkip: (p) => kept.push(p), isOwned })
        .catch((err) => {
          // One repo's git failing must not skip the rest, and must never take the daemon down.
          log.warn('orphan sweep failed for a repo', { repo: r.root, err: String(err) });
          return 0;
        });
    }
    if (reaped) {
      log.info(
        periodic
          ? `swept ${reaped} leaked worktree(s) no run will come back for`
          : `reaped ${reaped} orphaned worktree(s) from a prior run`,
      );
    }
    // Never silently discard an agent's output: a worktree with unsaved work outlives the reap,
    // and the human is told where it is rather than left to find out later. Startup only — a
    // legitimately kept workspace repeated every half hour is a warning operators learn to
    // scroll past, which costs more than it buys.
    if (kept.length && !periodic) {
      log.warn(`kept ${kept.length} orphaned worktree(s) holding unsaved work — review or delete by hand`, {
        worktrees: kept,
      });
    }
    return { reaped, kept };
  };
}

/**
 * The daemon's session-capacity ledger (RUN-170), extracted for the same reason its neighbours
 * are: this wiring is where whole layers have shipped silently dead, and a capacity computation
 * that quietly over-grants fails just as quietly — as four sessions on a three-slot machine.
 *
 * `waveLimit` is a RESERVATION, not a sample. The pure subtraction it replaces had a window: two
 * chains could each ask "what is spare?" before either had spawned a child, each see only the
 * other's single seat, and together start more sessions than the machine allows. The grant closes
 * it — the answer is RECORDED synchronously inside the ask, so the second chain's ask (the
 * process is single-threaded; asks serialize on the event loop) sees the first's claim, whatever
 * either has actually spawned yet. A run's claim on capacity is the busiest of three honest
 * measures: its most recent grant (what it may be about to spawn), its live sessions (what it
 * actually runs — a wave is several processes where the run count reads one), and the one seat
 * any active run holds. Grants are replaced on each ask (the chain re-asks per wave) and released
 * when the run settles; a stale grant between a run's last wave and its end over-reserves, which
 * is the conservative direction — a slower schedule, never a broken bound. What remains out of
 * scope, per RUN-170's own deferral: fairness/reservation ACROSS daemons — this ledger is one
 * process's, which is also where the lease pool and the active set live.
 *
 * `admit` is the ADMISSION half of the same bound. The advertisement narrows the window a
 * dispatch can race into (a grant pushes the shrunken freeSlots at once), but a frame already in
 * the air cannot be recalled — so an assignment that lands on a saturated machine WAITS for a
 * seat instead of becoming an extra session. The daemon still never REFUSES an assignment; it
 * holds it, the same boundary a saturated wave already accepts for its own steps. A queued run
 * claims no seat (counting it would deadlock two waiters against each other), and waiters are
 * re-checked in arrival order whenever a claim moves — a grant replaced or released — and on
 * every freeSlots read, which the heartbeat performs each beat, so a seat freed by a finished
 * session is noticed within one beat even when no ledger state moved.
 */
export function waveCapacity(deps: {
  concurrency: number;
  /** Runs supervising right now — live, not a snapshot (Daemon.active). */
  active: () => Iterable<string>;
  /** Live sessions of ONE run (SteeringBridge.liveSessionsOf). */
  sessionsOf: (runId: string) => number;
  /** Live sessions machine-wide, minus one run's own (SteeringBridge.liveSessionCount) — the
   *  backstop for a session whose run has already left the active set mid-teardown. */
  liveSessions: (excludeRunId?: string) => number;
}): {
  waveLimit: (runId: string) => number;
  freeSlots: () => number;
  release: (runId: string) => void;
  admit: (runId: string) => Promise<void>;
} {
  const grants = new Map<string, number>();
  /** Assignments waiting for a seat, in arrival order. `waiting` mirrors it for claimed()'s
   *  benefit: a queued run holds no seat yet — it is exactly what admission is holding OUT of
   *  the machine, so giving it the one-seat floor would deadlock waiters against each other. */
  const waiters: Array<{ runId: string; resolve: () => void }> = [];
  const waiting = new Set<string>();
  const claimed = (excludeRunId?: string): number => {
    let n = 0;
    let ofActive = 0; // live sessions already represented in n, run by run
    for (const id of deps.active()) {
      if (id === excludeRunId) continue;
      const live = deps.sessionsOf(id);
      n += Math.max(waiting.has(id) ? 0 : 1, grants.get(id) ?? 0, live);
      ofActive += live;
    }
    // Sessions whose run has already LEFT the active set (mid-teardown) hold real seats the walk
    // above cannot see. They ADD to the active runs' claims — a stray session and a
    // granted-but-unspawned wave occupy DIFFERENT seats, and folding them with a max let the
    // stray hide behind the grant: concurrency 3, one run granted two seats it had not spawned
    // yet, one teardown session elsewhere → claimed read 2 and a fourth session was admitted.
    // Subtracting `ofActive` keeps every active run's sessions counted exactly once (inside its
    // own per-run max), so the remainder is precisely the strays; clamped because the two reads
    // are of the same live registry and must not go negative on a transient disagreement.
    return n + Math.max(0, deps.liveSessions(excludeRunId) - ofActive);
  };
  /** Room for one more of this run's sessions under the ceiling. */
  const fits = (runId: string): boolean => claimed(runId) + 1 <= deps.concurrency;
  /** Re-check waiters in order. Admitting one takes its floor seat back (waiting.delete), so the
   *  next waiter is judged against it — seats hand over one at a time, FIFO. */
  const poke = (): void => {
    for (let i = 0; i < waiters.length; ) {
      const w = waiters[i]!;
      if (!fits(w.runId)) {
        i += 1;
        continue;
      }
      waiters.splice(i, 1);
      waiting.delete(w.runId);
      w.resolve();
    }
  };
  return {
    waveLimit: (runId) => {
      const limit = Math.max(1, deps.concurrency - claimed(runId));
      // The reservation itself: recorded before returning, so a simultaneous ask from another
      // chain subtracts this one's claim instead of double-spending the same spare slots.
      grants.set(runId, limit);
      // A replaced grant can SHRINK (the chain de-overlapped): what it freed may admit a waiter.
      poke();
      return limit;
    },
    // The heartbeat's advertisement counts grants too: a wave the daemon just promised breadth to
    // is capacity even before its children register, or the server dispatches into the gap. The
    // read doubles as the waiters' liveness tick (see the doc): a session ending moves no ledger
    // state of its own, and the beat rides this every interval.
    freeSlots: () => {
      poke();
      return Math.max(0, deps.concurrency - claimed());
    },
    release: (runId) => {
      grants.delete(runId);
      poke();
    },
    admit: (runId) => {
      if (fits(runId)) return Promise.resolve();
      waiting.add(runId);
      return new Promise<void>((resolve) => {
        waiters.push({ runId, resolve });
      });
    },
  };
}

/**
 * The owed-merge reconcile (RUN-28), extracted for the same reason its neighbours are: it lived
 * as an untested closure in start()'s wiring, which is where whole layers have shipped silently
 * dead — and its failure mode is exactly that shape (a plan quietly never gets its review).
 *
 * Since RUN-85 it reaches review-opening only through the repo's DETECTED backend — the same
 * `vcsFor` routing `share` already took, never a manifest field (a committed lie would travel,
 * RUN-60). Git shells the operator's `gh` behind the seam; a server-backed VCS answers that it
 * cannot open one and where review actually happens, and that answer is WARNED and REPORTED —
 * a hand-written `[land].mergeTarget` on a Diversion/Perforce repo used to reach `gh` or
 * nothing, silently, at the one moment the plan claimed to be done.
 */
export function owedMergeReconciler(deps: {
  owed: () => Promise<OwedMerge[]>;
  /** Repos this runner still has; an owed plan whose repo is gone is skipped, not failed. */
  repoFor: (repoRef: string) => { root: string } | undefined;
  /** Re-read per plan (ManifestStore.current): editing the marker takes effect without a restart. */
  manifestFor: (root: string) => Promise<ProjectManifest | null>;
  vcsFor: (root: string) => Pick<VcsBackend, 'kind' | 'share' | 'openReview'>;
  report: (outcome: { planId: string; url?: string | null; failed?: string | null }) => Promise<void>;
  logger?: typeof defaultLogger;
}): () => Promise<void> {
  const log = deps.logger ?? defaultLogger;
  return async () => {
    const owed = await deps.owed().catch((err) => {
      log.debug('could not ask for owed merge requests', { err: String(err) });
      return [];
    });
    for (const plan of owed) {
      const repo = plan.repoRef ? deps.repoFor(plan.repoRef) : undefined;
      if (!repo) continue; // a plan whose repo this runner no longer has
      const manifest = await deps.manifestFor(repo.root);
      const target = manifest?.land?.mergeTarget ?? null;
      if (!manifest?.land || !target) continue; // the repo never asked for merge requests

      const backend = deps.vcsFor(repo.root);
      const branch = resolveLandBranch(manifest.land.branch, plan.planKey);
      // Push again before opening: landing pushed each run as it went, but this is the moment
      // the branch is claimed to be complete, and a PR against a stale remote is worse than none.
      // Unbranched on purpose: a server-backed share is a documented no-op {ok:true}.
      const push = await backend.share(repo.root, branch);
      if (!push.ok) {
        await deps.report({ planId: plan.planId, failed: `push failed: ${push.detail}` }).catch(() => {});
        continue;
      }
      const mr = await backend.openReview(repo.root, {
        head: branch,
        base: target,
        planTitle: plan.planTitle,
        planKey: plan.planKey ?? plan.planId,
      });
      if (mr.ok) {
        log.info('opened a merge request for a completed plan', {
          planId: plan.planId,
          plan: plan.planTitle,
          branch,
          target,
          url: mr.url,
        });
      } else {
        // The one log a hand-written mergeTarget on a server-backed repo gets — it names the
        // backend and (via the backend's detail) where review actually happens. `command` is
        // git's hand-runnable `gh pr create`; a backend with none carries the answer in detail.
        log.warn('could not open the merge request — a human takes it from here', {
          planId: plan.planId,
          backend: backend.kind,
          detail: mr.detail,
          command: mr.command,
        });
      }
      // Reported either way. Recording only successes leaves a failure invisible and the plan
      // owed forever, so every reconnect retries the same broken thing and nobody learns why.
      await deps
        .report({
          planId: plan.planId,
          url: mr.url ?? null,
          failed: mr.ok ? null : (mr.detail ?? 'failed'),
        })
        .catch((err) => log.warn('could not report the merge result', { err: String(err) }));
    }
  };
}

/**
 * The coordinator surface `daemon.ts` itself depends on, widened past `cancelAll`/`trigger` with
 * an OPTIONAL `cancelRepo` (RUN-223) — optional so every existing test double that supplies a
 * fake coordinator without it keeps compiling; production's real `IndexCoordinator` always has
 * one, and the control server (`index-control.ts`) reads its absence as "cancel not supported"
 * rather than crashing on a missing method.
 */
type IndexCoordinatorLike = Pick<IndexCoordinator, 'cancelAll' | 'trigger'> & {
  cancelRepo?: IndexCoordinator['cancelRepo'];
};

/** Same widening, one layer up (RUN-223): `requestManualReindex` is RUN-222's hook that had no
 *  caller until this task, and `allStatuses` feeds the control server's `/status` — both optional
 *  here for the identical reason `cancelRepo` is above. */
type IndexTriggerHubLike = Pick<
  IndexTriggerHub,
  'reconcileOnStartup' | 'startPolling' | 'stop' | 'onLanded'
> & {
  requestManualReindex?: IndexTriggerHub['requestManualReindex'];
  allStatuses?: IndexTriggerHub['allStatuses'];
};

/**
 * Ties the pieces together: register over REST (RUN-9), then hold the long-lived
 * WS connection (RUN-10) that receives dispatches and makes idle-agent steering
 * possible. Actually spawning/supervising agent processes on run.assigned lands
 * in Phase 4 (RUN-12+); here we register the assignment and track capacity.
 */
export class Daemon {
  private readonly active = new Set<string>();
  private readonly log: typeof defaultLogger;
  private readonly getToken: () => Promise<string>;
  private readonly refreshToken?: () => Promise<string>;
  /** Injected seams (RUN-173) — real defaults in production, fakes in a `daemon.start()` harness.
   *  Every one of these is how start() is driven end to end without a socket, HTTP, or ~/.noriq. */
  private readonly connect?: WsFactory;
  private readonly fetchImpl?: typeof fetch;
  private readonly createSupervisor: (deps: RunSupervisorDeps) => SupervisorLike;
  private readonly parkedStore?: ParkedStore;
  private readonly continuableStore?: ContinuableStore;
  private readonly stateFile?: string;
  private readonly workflowStore?: WorkflowStore;
  private readonly indexCoordinatorOverride?: IndexCoordinatorLike;
  private readonly indexTriggersOverride?: IndexTriggerHubLike;
  private readonly indexJournalPath?: string;
  private readonly indexStagingRoot?: string;
  private readonly indexStatusPath?: string;
  private readonly indexControlInfoPath?: string;
  private readonly indexControlOverride?: Pick<IndexControlServer, 'start' | 'stop'>;
  /** Where RUN-227's undelivered-episode queue lives — defaults to
   *  `~/.noriq/episode-pending.json`; same `indexJournalPath` reasoning: a test points this at a
   *  temp file so a fully-driven `start()` never touches the operator's own home directory. */
  private readonly episodePendingPath?: string;
  /** Where RUN-230's undelivered-verification-report queue lives — defaults to
   *  `~/.noriq/verification-pending.json`; same `episodePendingPath` reasoning. */
  private readonly verificationPendingPath?: string;

  constructor(
    private readonly config: RunnerConfig,
    /** A literal token, or a TokenSource-shaped provider that keeps itself fresh. */
    token: string | { get(): Promise<string>; refresh(): Promise<string> },
    deps: {
      logger?: typeof defaultLogger;
      /** WS socket factory — the real `ws` by default, a fake that never dials in tests. */
      connect?: WsFactory;
      /** fetch for the REST client — global `fetch` by default, a fake in tests so start()
       *  registers and reconciles without a real HTTP request. */
      fetchImpl?: typeof fetch;
      /** How the supervisor is built — `new RunSupervisor` by default. A test supplies a factory
       *  that captures the wired-up `report` callback (the executed-spec retention closure). */
      createSupervisor?: (deps: RunSupervisorDeps) => SupervisorLike;
      /** On-disk stores and state file — default to ~/.noriq; a test points them at a temp dir so
       *  a fully-driven start() writes nothing to the operator's home. */
      parked?: ParkedStore;
      continuable?: ContinuableStore;
      stateFile?: string;
      /** Workflow filesystem seam — a fake can prove registration and dispatch re-read without
       *  touching the operator's ~/.noriq directory. */
      workflows?: WorkflowStore;
      /** RUN-214's index job coordinator — real production wiring by default; a test substitutes
       *  a fake with a spy `cancelAll`/`trigger` to prove `stop()` joins it, and the trigger layer
       *  (RUN-222) reaches it, without driving an actual index job. */
      indexCoordinator?: IndexCoordinatorLike;
      /** RUN-222's trigger layer — real production wiring by default; a test substitutes a fake to
       *  prove the daemon calls `reconcileOnStartup`/`startPolling`/`stop` without a real VCS or
       *  clock. */
      indexTriggers?: IndexTriggerHubLike;
      /** Where RUN-214's upload journal lives — defaults to `~/.noriq/index-journal.json`; a test
       *  points this at a temp file, the same `parked`/`continuable`/`stateFile` reasoning: the
       *  journal is read (`sweepOrphanedStaging`'s `journal.list()`, locked decision 8) on EVERY
       *  `start()`, real production wiring or not, so an un-pointed test would read the operator's
       *  own machine on every daemon test in this suite. */
      indexJournalPath?: string;
      /** Where RUN-221's staging directories live — defaults to `~/.noriq/index-staging`; same
       *  reasoning as `indexJournalPath`, and the same root the real work step (`index-work.ts`)
       *  stages batches under, so the sweep and the work step always agree on where "here" is. */
      indexStagingRoot?: string;
      /** Where RUN-223's disposable status snapshot lives — defaults to
       *  `~/.noriq/index-status.json`; same `indexJournalPath` reasoning, and written on every
       *  observable transition regardless of whether anything is enabled to observe. */
      indexStatusPath?: string;
      /** Where RUN-223's control-server discovery file lives — defaults to
       *  `~/.noriq/index-control.json`; same reasoning again, so a fully-driven test `start()`
       *  never writes the operator's own home directory or binds a port a real daemon on the same
       *  box would also try to discover. */
      indexControlInfoPath?: string;
      /** RUN-223's loopback control server — real production wiring (a real bound socket) by
       *  default; a test substitutes a fake with a spy `start`/`stop` to prove the daemon starts
       *  and stops it in the right place without binding a real port. */
      indexControl?: Pick<IndexControlServer, 'start' | 'stop'>;
      /** Where RUN-227's undelivered-episode queue lives — defaults to
       *  `~/.noriq/episode-pending.json`; same `indexJournalPath` reasoning. */
      episodePendingPath?: string;
      /** Where RUN-230's undelivered-verification-report queue lives — defaults to
       *  `~/.noriq/verification-pending.json`; same `episodePendingPath` reasoning. */
      verificationPendingPath?: string;
    } = {},
  ) {
    this.log = deps.logger ?? defaultLogger;
    this.getToken = typeof token === 'string' ? async () => token : () => token.get();
    this.refreshToken = typeof token === 'string' ? undefined : () => token.refresh();
    this.connect = deps.connect;
    this.fetchImpl = deps.fetchImpl;
    this.createSupervisor = deps.createSupervisor ?? ((d) => new RunSupervisor(d));
    this.parkedStore = deps.parked;
    this.continuableStore = deps.continuable;
    this.stateFile = deps.stateFile;
    this.workflowStore = deps.workflows;
    this.indexCoordinatorOverride = deps.indexCoordinator;
    this.indexTriggersOverride = deps.indexTriggers;
    this.indexJournalPath = deps.indexJournalPath;
    this.indexStagingRoot = deps.indexStagingRoot;
    this.indexStatusPath = deps.indexStatusPath;
    this.indexControlInfoPath = deps.indexControlInfoPath;
    this.indexControlOverride = deps.indexControl;
    this.episodePendingPath = deps.episodePendingPath;
    this.verificationPendingPath = deps.verificationPendingPath;
  }

  async start(): Promise<DaemonHandle> {
    const client = new NoriqClient({
      server: this.config.server,
      token: () => this.getToken(),
      onUnauthorized: this.refreshToken,
      fetchImpl: this.fetchImpl,
    });
    const repos = await discoverRepos(this.config.scanRoots);
    this.log.info(`discovered ${repos.length} repo(s)`, {
      repos: repos.map((r) => `${r.name}:${r.projectKey}`),
    });

    // The daemon speaks to source control only through the VCS seam (RUN-49), and routes each
    // repo to its backend by DETECTION (RUN-60) — git by `.git` at the root, Diversion by the
    // dv registry, never a manifest field (a committed lie would travel). Git remains the
    // machine default; a repo the detector cannot place falls back to it, loudly.
    // The Noriq lock view (RUN-98), shared across every backend: git delegates to it outright,
    // Perforce/Diversion mirror their native locks into it. One instance — it holds a per-token
    // MCP session cache — authenticating each call as the RUN's agent, not the daemon (RUN-97 §2).
    const locks = new LockClient({ server: this.config.server });
    const vcs = new GitBackend(new WorktreeManager({ baseDir: DEFAULT_WORKTREES_DIR }), locks);
    const detections = await detectVcs(repos.map((r) => r.root));
    const backendFor = new Map<string, GitBackend | DiversionBackend | PerforceBackend>();
    for (const r of repos) {
      const d = detections.get(r.root);
      if (d?.kind === 'diversion' && d.repoId) {
        // One instance PER REPO, constructed once: it carries the repo id and the pool-of-1
        // lease queue — a per-run instance would silently disable the lease. One daemon per
        // machine is the operating assumption on this backend (the lease is in-process).
        backendFor.set(r.root, new DiversionBackend({ repoId: d.repoId, locks }));
      } else if (d?.kind === 'perforce') {
        // Same per-repo, once-only rule: the pool-of-1 lease lives in the instance (RUN-52).
        backendFor.set(r.root, new PerforceBackend({ locks }));
      } else {
        backendFor.set(r.root, vcs);
      }
      this.log.info(`repo ${r.name} → ${d?.kind ?? 'git'}`, { root: r.root, why: d?.reason });
    }

    // Runs parked on a human (RUN-30). On disk, because that is the point: the answer may come
    // tomorrow, and a daemon that forgot across a restart would strand both the run and the
    // worktree holding its work.
    const parked = this.parkedStore ?? new ParkedStore();
    // Continuation state for a "continue a failed run" (RUN-91/92): a failed build's spend and
    // adjudication ledger, kept on disk beside the worktree it belongs to so a re-dispatch of the
    // same run id re-seeds instead of resetting. Same rationale as `parked` — survive a restart.
    const continuable = this.continuableStore ?? new ContinuableStore();

    // Both stores are constructed HERE, before the first sweep, and not down beside the rest of
    // the supervisor's deps where they used to live: the sweep must know what they are holding
    // before it deletes anything. "Every prior process is gone" makes a workspace unsupervised,
    // not unwanted — a persisted park or continuation is precisely a workspace whose owner is
    // coming back, and it survives the restart on purpose.
    const sweepOrphans = orphanSweep({
      repos,
      vcsFor: (root) => backendFor.get(root) ?? vcs,
      // `this.active` is exact for a LIVE run: added before `supervise`, removed in its `finally`.
      isActive: (runId) => this.active.has(runId),
      reserved: async () => [...(await parked.list()).map((p) => p.run.id), ...(await continuable.runIds())],
      logger: this.log,
    });
    await sweepOrphans(false);

    const state = await loadState(this.stateFile);
    const tools = this.config.tools ?? detectTools();
    const workflows = this.workflowStore ?? new WorkflowStore({ logger: this.log });
    const registrationCatalogs = new Map(
      await Promise.all(
        repos.map(async (repo) => [repo.root, await workflows.current(repo.root, repo.manifest)] as const),
      ),
    );
    const registration = buildRegistration(
      { label: this.config.label, concurrency: this.config.concurrency, tools, runnerId: state.runnerId },
      repos,
      registrationCatalogs,
    );
    const runner = await client.registerRunner(registration);
    await saveState({ runnerId: runner.id }, this.stateFile);
    this.log.info('registered with Noriq', {
      runnerId: runner.id,
      status: runner.status,
      repos: runner.repos.map((r) => `${r.projectKey}→${r.projectId ?? 'unresolved'}`),
    });

    // RUN-227's undelivered-episode queue, and the delivery deps every enqueue/retry site below
    // shares. Built here, once `runner.id` exists — `EpisodeDeliveryDeps.runnerId` is captured into
    // every `PendingEpisode.mint` at enqueue time (locked decision 8's identity half), and this is
    // the daemon's own registration id, stable across a restart (`saveState` above persists it).
    const episodePending = new EpisodePendingStore(filePendingEpisodeStore(this.episodePendingPath));
    const episodeDeliveryDeps: EpisodeDeliveryDeps = {
      client,
      runnerId: runner.id,
      pending: episodePending,
      logger: this.log,
    };
    // Retry whatever a prior process left pending, once, at startup — mirrors the orphaned-staging
    // sweep just below: a daemon that crashed or was simply off holds episodes nothing has retried
    // since, and "the box just came up" is exactly the moment worth spending one drain pass on.
    void drainPendingEpisodes(episodeDeliveryDeps)
      .then(({ delivered }) => {
        if (delivered) this.log.info(`delivered ${delivered} previously pending episode(s)`);
      })
      .catch((err) => this.log.warn('startup episode delivery retry failed', { err: String(err) }));

    // RUN-230's undelivered-verification-report queue, and its own delivery deps — a SEPARATE
    // store from the episode one above (`verification-pending.ts`'s own doc on why: no shared
    // `mint`-style identity, and a retry here can go permanently dead in a way an episode retry
    // never does).
    const verificationPending = new VerificationPendingStore(
      filePendingVerificationStore(this.verificationPendingPath),
    );
    const verificationReportDeliveryDeps: VerificationReportDeliveryDeps = {
      client,
      pending: verificationPending,
      logger: this.log,
    };
    // Same startup-drain reasoning as episodes just above: a daemon that crashed or was simply off
    // holds reports nothing has retried since.
    void drainPendingVerificationReports(verificationReportDeliveryDeps)
      .then(({ delivered, dropped }) => {
        if (delivered) this.log.info(`delivered ${delivered} previously pending verification report(s)`);
        if (dropped)
          this.log.warn(`dropped ${dropped} undeliverable verification report(s) (run agent token revoked)`);
      })
      .catch((err) =>
        this.log.warn('startup verification report delivery retry failed', { err: String(err) }),
      );

    // RUN-214's index job coordinator, now with the real work step (RUN-222 locked decision 5):
    // the leased snapshot's source → runIndexer → uploadGeneration, wired in `index-work.ts` so
    // this file stays wiring-only. `resolveIndexConfigForRoot` is the ONE enabled/off gate both
    // the coordinator and the trigger layer below consult — never two copies of it. Built here,
    // before the supervisor, because the landing/publish trigger site (RUN-222) is a supervisor
    // dep (`onLanded`) that needs the trigger hub to already exist.
    const resolveIndexConfigForRoot = (root: string) => loadIndexConfig(root, this.log);
    const indexJournal = new IndexJournal(fileJournalStore(this.indexJournalPath));
    // RUN-223's operator-status recorder — built before the coordinator so its `onStatus` dep can
    // close over it. Persists to disk on every mutation (best-effort; a write failure costs the
    // next CLI read staleness, never an index attempt) — the CLI's offline fallback when no live
    // daemon answers the control server's `/status` below.
    const indexStatus = new IndexStatusStore({
      persist: fileIndexStatusPersist(this.indexStatusPath),
      logger: this.log,
    });
    // Locked decision 8: the orphaned-staging sweep runs EXACTLY here — startup only, before the
    // coordinator's first trigger, never on a timer. `sweepOrphanedStaging`'s own doc: a snapshot
    // mid-write or mid-upload looks identical, by inspection, to one a crashed process left behind,
    // and only "nothing survived the last exit" (true right here, true nowhere later) makes every
    // directory with no live journal entry unreachable BY CONSTRUCTION rather than unlucky timing.
    await sweepOrphanedStaging(indexJournal, this.indexStagingRoot)
      .then(({ removed }) => {
        if (removed.length) this.log.info(`swept ${removed.length} orphaned index-staging dir(s)`);
      })
      .catch((err) => this.log.warn('index staging sweep failed', { err: String(err) }));
    const indexCoordinator: IndexCoordinatorLike =
      this.indexCoordinatorOverride ??
      new IndexCoordinator({
        vcsFor: (root) => backendFor.get(root) ?? vcs,
        resolveConfig: resolveIndexConfigForRoot,
        getCursor: (target) =>
          client.getIndexCursor(runner.id, {
            projectId: target.projectId,
            repositoryKey: target.repositoryKey,
            checkoutId: target.checkoutId,
          }),
        runWork: createIndexWorkStep({
          client,
          runnerId: runner.id,
          vcsFor: (root) => backendFor.get(root) ?? vcs,
          staging: fileStagingStore(this.indexStagingRoot),
          logger: this.log,
        }),
        journal: indexJournal,
        // "Busy with runs" reads the same live set the capacity ledger and the orphan sweep read
        // (`this.active`) — one honest definition of busy, not a second one invented here.
        isRunBusy: () => this.active.size > 0,
        // RUN-223: every reconcile/phase/success/failure this coordinator decides also lands in
        // the status recorder above — the ONLY feed `IndexStatusStore` has, so the CLI surface can
        // never show a state this coordinator did not itself observe.
        onStatus: (event) => indexStatus.record(event),
        logger: this.log,
      });

    // RUN-222's trigger layer: turns startup, a landing, and a periodic poll into debounced calls
    // to the coordinator above. `projectIdFor` closes over the registration response — the server
    // resolves a repo's projectId at registration, and re-deriving it per trigger would be a
    // second source of truth for a fact that does not change over this daemon's lifetime.
    const projectIdFor = new Map(runner.repos.map((r) => [r.id, r.projectId] as const));
    const indexTriggerRepos: IndexTriggerRepo[] = repos
      .filter((r): r is typeof r & { repositoryKey: string } => r.repositoryKey !== null)
      .map((r) => ({
        repoRoot: r.root,
        repositoryKey: r.repositoryKey,
        checkoutId: r.id,
        projectId: projectIdFor.get(r.id) ?? null,
        projectKey: r.manifest.key,
        defaultBranch: r.manifest.defaultBranch ?? r.defaultBranch,
      }));
    const indexTriggers: IndexTriggerHubLike =
      this.indexTriggersOverride ??
      new IndexTriggerHub({
        server: this.config.server,
        coordinator: indexCoordinator,
        vcsFor: (root) => backendFor.get(root) ?? vcs,
        resolveConfig: resolveIndexConfigForRoot,
        repos: indexTriggerRepos,
        logger: this.log,
      });

    // RUN-223's operator control surface — a loopback HTTP server (see index-control.ts's own doc
    // for why this shape over a status file the daemon merely writes) so a live CLI command can
    // read `/status`, or ask for a manual reindex/retry/cancel, without minting anything or
    // touching `[index].enabled` itself: every route here is a thin ask onto the coordinator and
    // trigger hub above, which already enforce their own gates. Started unconditionally — there is
    // no config knob, the same posture the leak sweep and update check already take — because the
    // one thing worse than a control surface nobody asked for is indexing running unattended with
    // no way to see it at all, which is exactly the gap this task exists to close.
    const indexControl: Pick<IndexControlServer, 'start' | 'stop'> =
      this.indexControlOverride ??
      new IndexControlServer({
        statusStore: indexStatus,
        triggerStatuses: () => indexTriggers.allStatuses?.() ?? [],
        repoRootFor: (repositoryKey) =>
          indexTriggerRepos.find((r) => r.repositoryKey === repositoryKey)?.repoRoot,
        requestManualReindex: (repoRoot) =>
          indexTriggers.requestManualReindex?.(repoRoot) ?? Promise.resolve(),
        cancelRepo: (repositoryKey) => {
          // Only a repo THIS daemon actually knows about may be cancelled — an unrecognized
          // repositoryKey never reaches the coordinator's own job-key map at all.
          if (!indexTriggerRepos.some((r) => r.repositoryKey === repositoryKey)) return false;
          return indexCoordinator.cancelRepo?.({ server: this.config.server, repositoryKey }) ?? false;
        },
        controlInfoPath: this.indexControlInfoPath,
        logger: this.log,
      });
    await indexControl
      .start()
      .catch((err) => this.log.warn('index control server failed to start', { err: String(err) }));

    // Supervisor composes worktree + driver + budget per dispatched Run. The `held`
    // holder breaks the ws↔supervisor reference cycle (supervisor reports via ws;
    // ws's onAssigned drives the supervisor). Each Run's agent identity is created by the
    // runner up front (RUN-43) and reached with a token bound to it alone.
    const reposById = new Map(repos.map((repo) => [repo.id, repo]));
    // The committed marker is re-read per Run, so editing .noriq/project.toml takes
    // effect on the next dispatch instead of waiting for someone to restart the daemon.
    const manifests = new ManifestStore({ logger: this.log });
    for (const r of repos) manifests.seed(r.root, r.manifest);
    const resolveRepo = workflowRepoResolver({
      repos,
      manifestFor: (root) => manifests.current(root),
      workflowsFor: (root, manifest) => workflows.current(root, manifest),
      vcsFor: (root) => backendFor.get(root),
    });
    const held: { ws?: WsClient } = {};
    // Dedup run.status: the supervisor re-reports status:'running' on every telemetry
    // tick, but the DO only wants genuine transitions. Telemetry rides its own frame.
    const lastRunStatus = new Map<string, string>();
    /** The executed-spec record still owed to the server (RUN-172), per run — see the send below
     *  for why a single fire-and-forget send was not enough. Cleared when a frame carrying it
     *  actually goes out, and when the run ends, so a daemon does not hold one per run for its
     *  whole life. */
    const pendingSpec = new Map<string, ExecutionSpec>();
    /** RUN-241: the same owed-until-delivered posture as `pendingSpec`, for the resolved
     *  coordinate a run actually executes under (see `RunReport.executedConfiguration`'s doc). */
    const pendingConfiguration = new Map<string, ExecutedConfigurationEvidence>();
    const steering = new SteeringBridge({ logger: this.log });
    // The session-capacity ledger (RUN-170): waveLimit RESERVES what it answers, so simultaneous
    // chains cannot double-spend the same spare slots, and freeSlots sees a granted wave as
    // occupied capacity. See waveCapacity's doc for the bound it holds and the deferral it keeps.
    const capacity = waveCapacity({
      concurrency: this.config.concurrency,
      active: () => this.active,
      sessionsOf: (runId) => steering.liveSessionsOf(runId),
      liveSessions: (excludeRunId) => steering.liveSessionCount(excludeRunId),
    });
    const supervisor = this.createSupervisor({
      drivers: {
        claude: new ClaudeDriver({ logger: this.log }),
        codex: new CodexDriver({ logger: this.log }),
      },
      vcs,
      resolveRepo,
      // Transcript segments (RUN-74) ride their own frame, same best-effort posture as
      // telemetry: a batch the socket misses is gone, and that must never gate a run.
      reportLog: (runId, segments) => {
        held.ws?.sendRunLog(runId, segments);
      },
      report: (runId, rep) => {
        // Spend, log tail, and phase stream on their own frame (RUN-22/31) — no transition
        // minted. Phase belongs here and NOT on run.status for a concrete reason: the DO's
        // transition map has no running → running edge, so a phase report sent as a status
        // would be rejected as an illegal transition and silently dropped.
        //
        // Each field is null-means-no-news (the server COALESCEs), so a phase-only tick can
        // say "verifying" without claiming the spend is zero.
        // The executed-spec record is sent ONCE by the supervisor, when the spec resolves — and
        // telemetry is fire-and-forget, so a socket that happens to be down at that moment would
        // lose it permanently, with nothing to correct it the way a later tick corrects a dropped
        // spend (RUN-172). Held until a frame actually goes out on a live socket. Re-sending is
        // free: the server appends only when the spec differs from the last one it holds.
        if (rep.executedSpec) pendingSpec.set(runId, rep.executedSpec);
        const spec = pendingSpec.get(runId) ?? null;
        // RUN-241: same owed-until-delivered handling as `spec`, one frame field over — see the
        // pendingConfiguration declaration and RunReport.executedConfiguration's doc.
        if (rep.executedConfiguration) pendingConfiguration.set(runId, rep.executedConfiguration);
        const configuration = pendingConfiguration.get(runId) ?? null;
        if (rep.telemetry || rep.phase || spec || configuration) {
          // telemetryFrame decides the mix's tri-state (mix / {} = clear / null = no news) so a
          // stale mix can't outlive the spend it no longer sums to (RUN-59). See its doc.
          if (held.ws) {
            const left = held.ws.sendTelemetry(runId, {
              ...telemetryFrame(rep),
              logTail: rep.logTail ?? null,
              phase: rep.phase ?? null,
              // Rides THIS frame because recording what a run was briefed with is not a lifecycle
              // transition — run.status has no running → running edge, so it would be rejected
              // there and silently dropped.
              executedSpec: spec,
              executedConfiguration: configuration,
            });
            // Clear the pending record ONLY once the frame actually LEFT the socket — that is what
            // sendTelemetry's boolean reports. A down socket still sets `held.ws`, so keying the
            // clear on its presence counted a dropped frame as a delivery and lost the record with
            // nothing to correct it; retaining it lets the next live frame re-send (RUN-172/173).
            if (spec && left) pendingSpec.delete(runId);
            if (configuration && left) pendingConfiguration.delete(runId);
          }
        }
        if (rep.status === 'done' || rep.status === 'failed') {
          pendingSpec.delete(runId);
          pendingConfiguration.delete(runId);
        }
        if (shouldForwardRunStatus(lastRunStatus.get(runId), rep)) {
          lastRunStatus.set(runId, rep.status);
          // agentId finally has a value to carry: the daemon created the identity, so it no
          // longer has to hope the child announces itself (RUN-43).
          held.ws?.sendRunStatus(runId, rep.status, {
            worktreePath: rep.worktreePath,
            agentId: rep.agentId,
            exit: rep.exit,
          });
        }
        if (rep.status === 'done' || rep.status === 'failed') lastRunStatus.delete(runId);
      },
      postComment: (projectId, taskId, body) => {
        void client
          .postComment(projectId, taskId, body)
          .catch((err) => this.log.warn('verify comment post failed', { err: String(err) }));
      },
      server: this.config.server,
      // runner.toml's `[budget]` — the machine's own ceilings for dispatches that
      // arrive without one. Otherwise such a Run would burn unbounded.
      defaultBudget: this.config.budget,
      // The runner creates each Run's Noriq agent and receives a token bound to it, which
      // is injected into that agent's MCP transport (RUN-43). This replaces two things:
      // `parentAgentId: runner.id`, which passed a RUNNER id into a field documented as an
      // agent id and only ever surfaced as prompt text asking the model to register itself;
      // and `getToken`, which handed every spawned process the DAEMON's own credential —
      // the one that can register runners and reach every project this human can.
      createRunAgent: (runId, opts) => client.createRunAgent(runId, opts),
      resolveTask: (taskId) => client.getTask(taskId),
      // The mechanical check behind a CONTESTED task pointer (RUN-188): the judging reviewer holds
      // no credential (RUN-43), so the daemon looks the task up and enters the result as ledger
      // data. Bound here for the same reason resolveLockScope is: a dep only tests supply is a
      // feature that has never run.
      resolveSpinOff: (ref) => client.getTask(ref),
      // Phase-gate backstop (RUN-81): don't spawn an agent on a task the server offered but whose
      // plan phase isn't unlocked. Read-only probe; a null answer fails open (see checkClaimable).
      checkClaimable: (taskId) => client.checkClaimable(taskId),
      // Parking (RUN-30). The server is the authority on whether a run asked a human something —
      // the agent calls request_input over its own MCP transport, straight past the daemon — so
      // the daemon asks the row rather than trying to observe the call.
      getParkState: (runId) => client.getParkState(runId),
      // When a run holding an open blocked question terminates without parking (a breach, a crash),
      // tell the server the question died with the run so no signal is left standing (RUN-199).
      abandonSignal: (runId, signalId) => client.abandonBlockedSignal(runId, signalId),
      parked,
      continuable,
      // The line whose absence made RUN-103's predictive layer dead code in production: the dep
      // existed, the supervisor consumed it, and only tests ever supplied one. See its doc above.
      resolveLockScope: continuationLockScope(continuable),
      // A planned spec is written BACK to the task (RUN-140) — that is what makes planning an
      // artifact a human can correct and a retry can reuse, rather than a thought inside one run's
      // prompt. Bound here for the same reason `resolveLockScope` is: a dep only tests supply is a
      // feature that has never run.
      saveExecutionSpec: (projectId, taskId, spec) => client.setExecutionSpec(projectId, taskId, spec),
      // RUN-228's task context pack fetch — bound with this daemon's own registration id, the same
      // closure shape `getCursor` above already uses for `getIndexCursor`. `context-pack.ts` is
      // what adds the timeout and decides what an omission means; this is the thin wire binding.
      getContextPack: (input) => client.getContextPack(runner.id, input),
      // Background indexing's landing/publish trigger site (RUN-222). Fire-and-forget: `onLanded`
      // itself never throws (it catches everything internally) and this daemon never awaits it.
      onLanded: (repoRoot, branch, sha) => {
        void indexTriggers.onLanded?.(repoRoot, branch, sha);
      },
      // RUN-227's delivery sink. Fire-and-forget, same shape as `onLanded` above: `deliverEpisode`
      // enqueues durably before it ever touches the network (its own doc), so this dep can stay
      // synchronous and return before any I/O settles — `settle` never awaits it.
      recordEpisode: (episode) => {
        void deliverEpisode(episode, episodeDeliveryDeps).catch((err) =>
          this.log.warn('episode delivery failed unexpectedly', { runId: episode.runId, err: String(err) }),
        );
      },
      // RUN-230's delivery sink. Fire-and-forget for the identical reason `recordEpisode` above is:
      // `deliverVerificationReport` enqueues durably before it ever touches the network, so this
      // dep stays synchronous and returns before any I/O settles — `prepareRun` never awaits it.
      reportVerification: (runId, agentToken, report) => {
        void deliverVerificationReport(runId, agentToken, report, verificationReportDeliveryDeps).catch(
          (err) =>
            this.log.warn('verification report delivery failed unexpectedly', { runId, err: String(err) }),
        );
      },
      // What one run works out about a repo, kept for the next (RUN-143/144). Bound here for the
      // third time the same lesson has been learned: a dep only tests supply is a feature that has
      // never run.
      repoIntel: new RepoIntel(fileIntelStore(), this.config.server),
      // How many of a run's wave steps may overlap (RUN-170): a RESERVING ask on the capacity
      // ledger — the grant is recorded synchronously inside the call, which is what closes the
      // window where two chains sample the same spare slots before either spawns (see
      // waveCapacity). Re-asked by the chain before each wave; the floor of 1 means a saturated
      // machine degrades a wave to sequential rather than refusing the run. Bound HERE, not only
      // in tests: a dep only tests supply is a feature that has never run.
      waveLimit: (runId) => {
        const limit = capacity.waveLimit(runId);
        // The grant just claimed slots the server's last-heard advertisement still calls free,
        // and the server is the admission authority — this daemon has never refused an
        // assignment, so the only enforcement that reaches dispatch is the advertisement.
        // Pushing it NOW shrinks the stale window from a heartbeat interval to one frame's
        // flight; a dispatch already in the air is the residual the ledger absorbs — the run
        // lands in `active` synchronously on arrival, and every ask after that subtracts its
        // seat.
        held.ws?.advertiseCapacity();
        return limit;
      },
      steering,
      logger: this.log,
    });

    const ws = new WsClient({
      server: this.config.server,
      runnerId: runner.id,
      token: () => this.getToken(),
      identity: {
        label: this.config.label,
        tools: runner.capabilities.tools as AgentTool[],
        kinds: runner.capabilities.kinds as RunKind[],
        maxConcurrency: this.config.concurrency,
        repos: registration.repos,
      },
      // Recomputed per (re)connect (RUN-195): the same read-at-use stores dispatch resolution
      // uses — ManifestStore falls back to the last good manifest on a broken read, and the
      // WsClient absorbs a thrown refresh by advertising its last good set — so a workflow-file
      // edit is visible on the next hello, and a broken one can never keep the daemon offline.
      // Advertise-only either way: dispatch still re-reads and pins its own catalog per run.
      refreshRepos: () =>
        Promise.all(
          repos.map(async (r) => {
            const manifest = (await manifests.current(r.root)) ?? r.manifest;
            return repoReport(r, manifest, await workflows.current(r.root, manifest));
          }),
        ),
      connect: this.connect,
      // The capacity ledger's view, not a run count (RUN-170): one run's wave is several live
      // processes — and a wave the daemon just granted breadth to is occupied capacity even
      // before its children register. A heartbeat that counted runs would advertise free slots
      // on a machine a single decomposed run has saturated, inviting dispatches its own wave
      // limit exists to make room for.
      freeSlots: () => capacity.freeSlots(),
      handlers: {
        onRegistered: (m) => this.log.debug('ws registered', m),
        onAssigned: (run) => {
          // The seat is claimed SYNCHRONOUSLY — the ledger and the heartbeat see this run before
          // anything yields — but supervision waits for ADMISSION (RUN-170): the advertisement
          // cannot recall a dispatch already in the air, so an assignment that lands on a machine
          // a wave has saturated is HELD until a seat exists rather than becoming an extra
          // session. Never refused: a cancel arriving while it waits is still honored — the
          // cancelled fact persists (RUN-165) and supervision settles at its first stage check.
          this.active.add(run.id);
          void capacity
            .admit(run.id)
            .then(() => supervisor.supervise(run))
            .finally(() => {
              this.active.delete(run.id);
              // The run's wave grant dies with it (RUN-170) — a lingering grant would keep
              // reserving capacity for a run that can never spawn again.
              capacity.release(run.id);
            });
        },
        onCancel: (m) => {
          // Hard interrupt + SIGTERM + worktree teardown (the supervisor's finally
          // removes the worktree and clears the active slot).
          this.log.info('run cancel received', { runId: m.runId, reason: m.reason });
          void steering.cancelRun(m.runId);
        },
        onSteer: (steer) => {
          // Inject the steer into the live process, then ack so Noriq's notices
          // fallback doesn't double-deliver (dedup guard).
          void steering.applySteer(steer).then((result) => held.ws?.sendSteerAck(result));
        },
        onPlanCompleted: (m) => {
          // A nudge, not the payload: go ask the server what is owed. The frame carries no repo,
          // and making it carry one would be a second source of truth to keep in sync.
          this.log.info('a plan completed', { planId: m.planId, plan: m.planTitle });
          void reconcileOwedMerges().catch((err) =>
            this.log.warn('merge request failed', { err: String(err) }),
          );
        },
        onResume: (m) => {
          // A human answered the question a run parked on (RUN-30). The fast path — the same
          // answer is durable in `signals`, and reconcileParked() below re-asks on every
          // reconnect, so this frame arriving is a bonus and never the thing correctness rests on.
          this.log.info('a parked run was answered', { runId: m.runId });
          void resumeRun(m.runId, m.answer);
        },
        onReconnect: () => {
          this.log.info('ws reconnected — reconciling live runs');
          // The durable half (RUN-28): a plan can complete while this box is off or the socket is
          // down, and the frame above would simply never arrive. Ask.
          void reconcileOwedMerges();
          // Same shape for parked runs (RUN-30): a human answering while the box is off is the
          // normal case, not the edge one, and nothing else would ever bring that run back.
          void reconcileParked();
          // Same shape again for RUN-227's pending episodes: a reconnect is precisely "the server
          // might be reachable now when it was not a moment ago" — the one signal this daemon has
          // for "worth trying delivery again" short of a fixed-interval timer (discretion 3).
          void drainPendingEpisodes(episodeDeliveryDeps).catch((err) =>
            this.log.warn('episode delivery retry on reconnect failed', { err: String(err) }),
          );
          // Same shape again for RUN-230's pending verification reports — a reconnect is precisely
          // "the server might be reachable now when it was not a moment ago", the identical signal
          // episodes already use it for.
          void drainPendingVerificationReports(verificationReportDeliveryDeps).catch((err) =>
            this.log.warn('verification report delivery retry on reconnect failed', { err: String(err) }),
          );
        },
      },
      logger: this.log,
    });
    held.ws = ws;
    ws.start();

    // Say when this box is behind (RUN-37). A check, never a self-replace: the daemon holds the
    // operator's token, spawns agents at a permission floor it chooses, and with [land] writes
    // branches — so replacing its own executable is a supply-chain decision that needs
    // provenance, not a config key. It reads the runner's own public repo; Noriq is not in the
    // path. See src/update.ts and THREAT-MODEL.md.
    //
    // unref'd on purpose: a version check must never be the reason a daemon won't exit.
    let updateTimer: ReturnType<typeof setInterval> | undefined;
    if (this.config.update.check) {
      const runCheck = async () => {
        const check = await checkForUpdate();
        if (check.behind)
          this.log.info(updateAdvice(check), { current: check.current, latest: check.latest });
      };
      void runCheck();
      updateTimer = setInterval(() => void runCheck(), this.config.update.checkIntervalHours * 3600_000);
      updateTimer.unref();
    }

    // The leak sweep (RUN-153). No config knob: the interval only decides how long a leaked
    // directory sits on disk, and a default that holds beats a dial nobody tunes. `unref`'d for
    // the same reason the update check is — disk tidying must never be why a daemon won't exit —
    // and self-chained rather than `setInterval` so a slow sweep can never overlap itself.
    let sweepTimer: ReturnType<typeof setTimeout> | undefined;
    let stopping = false;
    // The sweep currently running, so shutdown can JOIN it. `clearTimeout` cancels the next one;
    // it cannot cancel git subprocesses already in flight, and returning from `stop()` while a
    // reaper is mid-`worktree remove` is how a shutdown races its own cleanup.
    let sweepInFlight: Promise<unknown> = Promise.resolve();
    const scheduleSweep = () => {
      sweepTimer = setTimeout(() => {
        if (stopping) return;
        sweepInFlight = sweepOrphans(true)
          .catch((err) => this.log.warn('orphan sweep failed', { err: String(err) }))
          .then(() => {
            if (!stopping) scheduleSweep();
          });
      }, ORPHAN_SWEEP_INTERVAL_MS);
      sweepTimer.unref();
    };
    scheduleSweep();

    // RUN-222 acceptance: every enabled repo is reconciled once at startup, and the shared poll
    // ticker starts right after — one cheap current-base check per enabled repo, never a lease, so
    // there is nothing here worth racing the rest of startup over. Awaited so a startup that races
    // the very first heartbeat still has this done, but never allowed to fail startup itself.
    await indexTriggers
      .reconcileOnStartup()
      .catch((err) => this.log.warn('index startup reconcile failed', { err: String(err) }));
    indexTriggers.startPolling();

    /**
     * Open a merge request for every plan that finished and still owes one (RUN-28).
     *
     * Driven entirely off the server's record, never off the WS frame's payload. `plan.completed`
     * is a NUDGE — "go ask" — and reconnect asks the same question. One code path, and the
     * durable store is the only truth: a plan can complete while this box is off, while the
     * runner is offboarded, or mid-reconnect, and a frame-shaped fast path would drop the merge
     * request silently and forever. This project has shipped that exact bug twice.
     *
     * NO REBASE, deliberately. The working branch is already PUSHED — autoPush is a hard
     * prerequisite — so rebasing it locally would rewrite published history and need `--force`,
     * which pushBranch categorically refuses (RUN-27). If main moved under the plan, that is a
     * conflict the forge should show in the PR, where a human resolves it with full context. The
     * daemon does not rewrite shared history to make its own PR openable.
     */
    /**
     * Bring one parked run back (RUN-30). Takes a slot, like any other run — a resumed agent is a
     * live process, and pretending otherwise would let parked runs quietly exceed the concurrency
     * the operator set.
     *
     * Concurrency-safe against itself: the supervisor's resume() unparks before it does anything
     * else, so if the WS frame and the reconnect sweep both fire for one answer, the second finds
     * nothing and no-ops rather than starting a rival process in the same worktree.
     */
    const resumeRun = async (runId: string, answer: string): Promise<void> => {
      // A STAGE park's run is still ACTIVE (RUN-190): its supervise stack is holding, in this
      // process, waiting for exactly this answer — so the active-guard below must not eat it.
      // Delivery is in-process and takes no slot; the stack it wakes already holds one.
      if (supervisor.deliverStageAnswer(runId, answer)) return;
      if (this.active.has(runId)) return; // already coming back
      this.active.add(runId);
      try {
        await supervisor.resume(runId, answer);
      } catch (err) {
        this.log.error('resuming a parked run threw', { runId, err: String(err) });
      } finally {
        this.active.delete(runId);
        capacity.release(runId); // same rule as onAssigned: a settled run holds no wave grant
      }
    };

    /**
     * Ask about every run this box has parked (RUN-30) — the durable half.
     *
     * The `run.resume` frame is fire-and-forget: a human answering a question at 9am, while the
     * laptop that parked it was closed at 5pm, would hit a socket that does not exist. Without
     * this sweep that run waits forever, and so does the worktree holding its work.
     */
    const reconcileParked = async (): Promise<void> => {
      for (const p of await parked.list()) {
        const state = await client.getParkState(p.run.id).catch((err) => {
          this.log.debug('could not check a parked run', { runId: p.run.id, err: String(err) });
          return null;
        });
        if (!state) continue;
        if (state.answer) {
          await resumeRun(p.run.id, state.answer);
        } else if (!state.blocked) {
          // The server no longer thinks it is parked — cancelled, or failed while we were away.
          // Drop the entry: resuming into a run the server considers finished would report work
          // against a lifecycle that already closed.
          this.log.info('a parked run is no longer blocked server-side — forgetting it', {
            runId: p.run.id,
            status: state.status,
          });
          await parked.unpark(p.run.id);
        }
      }
    };

    // Owed merge requests (RUN-28), routed through the detected backend since RUN-85 —
    // `vcsFor` is the same `backendFor.get(root) ?? vcs` the share step always took, now
    // carrying openReview too, so gh is git's business and a server-backed repo's
    // mergeTarget yields an honest warn+report instead of a gh call that means nothing there.
    const reconcileOwedMerges = owedMergeReconciler({
      owed: () => client.owedMerges(runner.id),
      repoFor: (repoRef) => reposById.get(repoRef),
      manifestFor: (root) => manifests.current(root),
      vcsFor: (root) => backendFor.get(root) ?? vcs,
      report: (outcome) => client.reportMerge(runner.id, outcome),
      logger: this.log,
    });

    // Ask once at startup, not only on reconnect (RUN-28): the likeliest way to miss a
    // plan.completed frame is for the box to have been OFF when it fired — and a daemon that
    // only reconciles on RE-connect never reconciles its own first connect.
    void reconcileOwedMerges();

    // Same reasoning for parked runs (RUN-30), plus one of its own: a park pins a worktree and a
    // branch while the base moves under it, and its agent's token expires at 7 days — so give up
    // on the ones nobody answered, before asking about the rest.
    void supervisor
      .expireStaleParks()
      .then((n) => n && this.log.warn(`${n} parked run(s) expired unanswered`))
      .then(() => reconcileParked())
      .catch((err) => this.log.warn('could not reconcile parked runs', { err: String(err) }));

    const stop = async (): Promise<void> => {
      // FIRST, before anything that takes time: the drain below is seconds long, and a sweep that
      // starts inside it would be reaping on behalf of a daemon that is already leaving.
      stopping = true;
      if (sweepTimer) clearTimeout(sweepTimer);
      // SIGTERM live agents BEFORE the socket closes. A spawned claude/codex isn't in the
      // daemon's teardown path, so exiting first orphans it: still editing the worktree,
      // still spending, with its only ceiling (the budget enforcer) dead.
      const stopped = await steering.stopAll();
      if (stopped.length) this.log.info(`stopped ${stopped.length} live run(s)`, { runs: stopped });
      // Give the supervisors a beat to report terminal statuses while the socket is still
      // open — otherwise the server strands those Runs 'running' until the next reconcile.
      const deadline = Date.now() + SHUTDOWN_DRAIN_MS;
      while (this.active.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (this.active.size > 0) {
        this.log.warn('shutting down with runs still settling — the server will reconcile them', {
          runs: [...this.active],
        });
      }
      // Say goodbye (RUN-35). Without a final beat, stopping on purpose and crashing look
      // identical from the dashboard — both simply stop heartbeating and go stale — so an
      // operator cannot tell a tidy shutdown from a box that fell over. Best-effort by
      // definition: we are on our way out, and failing to announce it is not worth delaying
      // or failing the shutdown over. The server still reconciles a runner that never says it.
      if (updateTimer) clearInterval(updateTimer);
      // Join a sweep that was already running when stop() was called — `clearTimeout` cancels the
      // NEXT one, never git commands already in flight.
      await sweepInFlight.catch(() => {});
      // Stop the trigger layer FIRST (RUN-222) — clears its poll ticker and every PENDING debounce
      // timer so no new job is handed to the coordinator after this point. A job already in flight
      // is the coordinator's own `cancelAll`'s job, right below.
      indexTriggers.stop();
      // Same race, one subsystem over (RUN-214, locked decision 11): cancel and JOIN any in-flight
      // index work before this method returns, not merely signal it — returning while a snapshot
      // is still being read is how a shutdown races its own cleanup, exactly the orphan-sweep join
      // above. Placed beside it on purpose: both are background maintenance holding a workspace
      // resource that must be released before the daemon actually exits.
      await indexCoordinator
        .cancelAll()
        .catch((err) => this.log.warn('index coordinator shutdown failed', { err: String(err) }));
      // RUN-223: stop taking control requests only once nothing is left to act on — `cancelAll`
      // sets the coordinator's own `stopping` flag SYNCHRONOUSLY at entry, so a request that
      // sneaks in during the drain above already finds a coordinator refusing new work; this just
      // closes the door once the drain is done. Removes the discovery file too, so a CLI call
      // racing this shutdown reads "no daemon" rather than a port nothing answers on for longer
      // than it has to.
      await indexControl
        .stop()
        .catch((err) => this.log.warn('index control shutdown failed', { err: String(err) }));
      await client
        .heartbeat(runner.id, { freeSlots: 0, status: 'offline' })
        .catch((err) =>
          this.log.debug('goodbye heartbeat failed (shutting down anyway)', { err: String(err) }),
        );
      ws.stop();
    };
    return { runnerId: runner.id, stop };
  }
}
