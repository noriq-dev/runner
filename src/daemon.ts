import type {
  AgentTool,
  ExecutionSpec,
  ProjectManifest,
  Run,
  RunKind,
  RunModelUsage,
  RunnerConfig,
} from '@noriq-dev/shared';
import { NoriqClient, type OwedMerge } from './client';
import { type ContinuableRun, ContinuableStore } from './continuable';
import { discoverRepos } from './discovery';
import { totalTokens } from './drivers/budget';
import { ClaudeDriver } from './drivers/claude';
import { CodexDriver } from './drivers/codex';
import { resolveLandBranch } from './land';
import { LockClient } from './lock-client';
import { logger as defaultLogger } from './logger';
import { ManifestStore } from './manifest-store';
import { ParkedStore } from './parked';
import { buildRegistration } from './registration';
import { RepoIntel, fileIntelStore } from './repo-intel';
import { loadState, saveState } from './state';
import { SteeringBridge } from './steering';
import { type RunReport, RunSupervisor, type RunSupervisorDeps } from './supervisor';
import { detectTools } from './tools';
import { checkForUpdate, updateAdvice } from './update';
import { detectVcs } from './vcs/detect';
import { DiversionBackend } from './vcs/diversion';
import { GitBackend } from './vcs/git';
import { PerforceBackend } from './vcs/perforce';
import type { VcsBackend } from './vcs/types';
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
 * The slice of the supervisor the daemon actually drives (RUN-173). Injected so a test can capture
 * the wired-up `report` callback — the closure that owes the executed-spec record and must hold it
 * until a frame carrying it actually leaves the socket — and exercise delivery/retention without a
 * real run and its whole pipeline. `RunSupervisor` satisfies it; the return types widen to
 * `Promise<unknown>` because the daemon fires these and never reads their result.
 */
export interface SupervisorLike {
  supervise(run: Run): Promise<unknown>;
  resume(runId: string, answer: string): Promise<unknown>;
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
    const isOwned = (runId: string) => deps.isActive(runId) || held.has(runId);
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
    const registration = buildRegistration(
      { label: this.config.label, concurrency: this.config.concurrency, tools, runnerId: state.runnerId },
      repos,
    );
    const runner = await client.registerRunner(registration);
    await saveState({ runnerId: runner.id }, this.stateFile);
    this.log.info('registered with Noriq', {
      runnerId: runner.id,
      status: runner.status,
      repos: runner.repos.map((r) => `${r.projectKey}→${r.projectId ?? 'unresolved'}`),
    });

    // Supervisor composes worktree + driver + budget per dispatched Run. The `held`
    // holder breaks the ws↔supervisor reference cycle (supervisor reports via ws;
    // ws's onAssigned drives the supervisor). Each Run's agent identity is created by the
    // runner up front (RUN-43) and reached with a token bound to it alone.
    const reposById = new Map(repos.map((r) => [r.id, r]));
    // The committed marker is re-read per Run, so editing .noriq/project.toml takes
    // effect on the next dispatch instead of waiting for someone to restart the daemon.
    const manifests = new ManifestStore({ logger: this.log });
    for (const r of repos) manifests.seed(r.root, r.manifest);
    const held: { ws?: WsClient } = {};
    // Dedup run.status: the supervisor re-reports status:'running' on every telemetry
    // tick, but the DO only wants genuine transitions. Telemetry rides its own frame.
    const lastRunStatus = new Map<string, string>();
    /** The executed-spec record still owed to the server (RUN-172), per run — see the send below
     *  for why a single fire-and-forget send was not enough. Cleared when a frame carrying it
     *  actually goes out, and when the run ends, so a daemon does not hold one per run for its
     *  whole life. */
    const pendingSpec = new Map<string, ExecutionSpec>();
    const steering = new SteeringBridge({ logger: this.log });
    const supervisor = this.createSupervisor({
      drivers: {
        claude: new ClaudeDriver({ logger: this.log }),
        codex: new CodexDriver({ logger: this.log }),
      },
      vcs,
      resolveRepo: async (repoRef) => {
        const r = reposById.get(repoRef);
        if (!r) return null;
        const manifest = await manifests.current(r.root);
        // The repo's detected backend rides along (RUN-60); omitted = the git default.
        return manifest ? { root: r.root, manifest, vcs: backendFor.get(r.root) } : null;
      },
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
        if (rep.telemetry || rep.phase || spec) {
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
            });
            // Clear the pending record ONLY once the frame actually LEFT the socket — that is what
            // sendTelemetry's boolean reports. A down socket still sets `held.ws`, so keying the
            // clear on its presence counted a dropped frame as a delivery and lost the record with
            // nothing to correct it; retaining it lets the next live frame re-send (RUN-172/173).
            if (spec && left) pendingSpec.delete(runId);
          }
        }
        if (rep.status === 'done' || rep.status === 'failed') pendingSpec.delete(runId);
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
      // What one run works out about a repo, kept for the next (RUN-143/144). Bound here for the
      // third time the same lesson has been learned: a dep only tests supply is a feature that has
      // never run.
      repoIntel: new RepoIntel(fileIntelStore(), this.config.server),
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
      connect: this.connect,
      freeSlots: () => Math.max(0, this.config.concurrency - this.active.size),
      handlers: {
        onRegistered: (m) => this.log.debug('ws registered', m),
        onAssigned: (run) => {
          this.active.add(run.id);
          void supervisor.supervise(run).finally(() => this.active.delete(run.id));
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
      if (this.active.has(runId)) return; // already coming back
      this.active.add(runId);
      try {
        await supervisor.resume(runId, answer);
      } catch (err) {
        this.log.error('resuming a parked run threw', { runId, err: String(err) });
      } finally {
        this.active.delete(runId);
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
