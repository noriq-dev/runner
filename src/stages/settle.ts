/**
 * The `settle` stage (RUN-131): the run's fate is decided; make it durable and let go of what the
 * run was holding.
 *
 * The only stage that runs no matter how the run got here. It carries exactly one gate — the verify
 * actor's own verdict, which can only be read once the session that wrote it is closed — and then
 * reports the outcome honestly, records what a continuation would need, releases the locks, and
 * decides the workspace's fate.
 *
 * The order inside is load-bearing:
 *   - close the session FIRST, because every gate that could hand work back has now run;
 *   - the verify actor's verdict SECOND, for the same reason: it grades that closed session;
 *   - report the run's TRUE spend, summed across every session that billed to it;
 *   - locks release UNCONDITIONALLY, even when the workspace is kept;
 *   - the workspace goes last, because everything above may still have needed it.
 */

import {
  type AcceptanceReport,
  acceptanceNeedsAttention,
  acceptanceSummary,
  renderAcceptanceReport,
} from '../acceptance';
import { totalTokens } from '../drivers/budget';
import { buildEpisode } from '../episode';
import { requestSelfSummary } from '../episode-summary';
import { type BuildUploadedIntelligenceInput, buildUploadedIntelligence } from '../intelligence-payload';
import { clearSetupMarker } from '../setup';
import type { ChangeStatsResult } from '../vcs/types';
import { judgeWithAcceptance, verifyAgentComment } from '../verify-agent';
import type { RunPipeline, StageHost } from './types';

/**
 * How long settling will wait for the lock release before going on without it.
 *
 * The release has to be ATTEMPTED before the terminal report (RUN-177), which puts a call to the
 * lock service on the path to settling a run — and settling must never be blockable by it. The
 * asymmetry decides the length: a release that never answers costs PROMPTNESS (the server also
 * auto-releases on task settle, and TTL covers the rest), while a settle that never completes
 * costs CORRECTNESS — the run stays non-terminal server-side, its agent is never retired, its
 * continuation is never recorded, and the runner slot is held for the life of the daemon.
 *
 * Generous enough that a slow-but-working service still releases promptly; short enough that a
 * dead one cannot wedge a run.
 */
export const LOCK_RELEASE_TIMEOUT_MS = 10_000;

/**
 * Race `p` against a timer, and carry on either way.
 *
 * The loser is ABANDONED rather than cancelled, deliberately: threading an AbortSignal through
 * `VcsBackend.releaseRunLocks` into the MCP client would widen the seam for a request whose whole
 * posture is best-effort, and an in-flight release that outlives this call harms nothing — it
 * either succeeds late (which is the desired outcome anyway) or fails into a caught rejection.
 */
export async function withTimeout(p: Promise<unknown>, ms: number, onTimeout: () => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
  });
  const winner = await Promise.race([p.then(() => 'done' as const), timeout]);
  if (timer) clearTimeout(timer);
  if (winner === 'timeout') onTimeout();
}

export const settleStage = async (host: StageHost, ctx: RunPipeline): Promise<void> => {
  const { run, repo, worktree, workflow: wf } = ctx;

  // The optional agent self-summary (RUN-226) — requested FIRST, ahead of everything else in this
  // stage, because `continueWith` is the only mechanism the acceptance permits (no out-of-band
  // model call) and it is only reachable while the session below is still open. Asked without
  // knowing the final outcome — the verify-actor gate a few lines down can still flip `done` to
  // `failed` — so the prompt (`prompts/self-summary.md`) asks for an account of the agent's OWN
  // WORK, never the verdict, and this cannot itself become one: nothing below reads its result for
  // anything but `buildEpisode`'s `selfSummary`. Enrichment only — the try/catch mirrors
  // `buildEpisode`'s own below, so a throw here costs the summary, never the run.
  const selfSummary = await requestSelfSummary({
    session: ctx.session,
    ...(ctx.getSessionText ? { getSessionText: ctx.getSessionText } : {}),
    tally: ctx.tally,
    milestone: (text) => host.transcript(run.id).milestone(text),
    warn: (message, details) => host.log.warn(message, { runId: run.id, ...details }),
  }).catch((err) => {
    host.log.warn('self-summary request failed — settling without one', {
      runId: run.id,
      err: String(err),
    });
    return null;
  });

  // Every gate that could hand work back has now run, so the session has no more work to do. It
  // MUST be closed explicitly: a multiTurn run deliberately does not self-close on its first result
  // (that is the whole point — RUN-29), so nothing else ever shuts the SDK query down, and an open
  // one keeps the daemon's event loop alive forever. Best-effort: a session that is already gone is
  // the normal case for every single-turn run.
  await ctx.stopSession().catch(() => {});

  // Independent verify agent (RUN-20): the run's own output IS the verdict. A FAIL — or an
  // ambiguous/absent one — gates the phase and the findings are surfaced.
  //
  // The one gate that lives in `settle`, and it belongs here rather than in `verify` for a reason
  // worth stating: it judges the text this run's own session produced, so it is only final once
  // that session is closed. Reading it earlier would mean grading a transcript still being written.
  //
  // Captured for the episode assembler below (RUN-224) rather than left to fall out of scope: this
  // is the only per-criterion evidence `settle` itself computes (the inline reviewer's own copy, on
  // a `build` run, lives and dies inside `stages/review.ts` — see `EpisodeExtra`'s doc comment).
  let acceptanceEvidence: AcceptanceReport | undefined;
  if (wf.verifyActor && ctx.driverSucceeded) {
    // Verdict AND per-criterion evidence together (RUN-145): a report that marks a criterion
    // FAILED and then signs off PASS is taken as the FAIL it contains, rather than as whichever
    // half the parser happened to read last.
    const v = judgeWithAcceptance(ctx.sessionText, ctx.acceptance);
    acceptanceEvidence = v.acceptance;
    if (v.acceptance?.entries.length) {
      host.transcript(run.id).milestone(`acceptance: ${acceptanceSummary(v.acceptance)}`);
      // Posted on a PASS as well, whenever anything is short of verified: a passing run is the one
      // place a criterion nobody could evidence — or one explicitly needing a human — would
      // otherwise vanish entirely.
      if (!v.passed || acceptanceNeedsAttention(v.acceptance)) {
        if (run.anchor?.type === 'task') {
          host.postComment(run.projectId, run.anchor.taskId, renderAcceptanceReport(v.acceptance));
        }
      }
    }
    if (v.passed) {
      host.log.info('verify agent PASS', { runId: run.id });
    } else {
      host.log.warn('verify agent gate — phase not cleared', { runId: run.id, verdict: v.verdict });
      if (run.anchor?.type === 'task') {
        host.postComment(run.projectId, run.anchor.taskId, verifyAgentComment(v));
      }
      ctx.exit = { ...ctx.exit, outcome: 'failed', isError: true, reason: 'verify_agent' };
    }
  }

  // The run's true spend + mix, summed across every session that billed (RUN-59): the primary (with
  // its fix turns), every reviewer round, the conflict resolver, and any prior park. This supersedes
  // the primary session's own first-result snapshot, which missed both the sub-sessions and the fix
  // turns.
  const vcs = host.vcsFor(repo);
  // Release the run's locks on terminal (RUN-104), UNCONDITIONALLY — a kept-work build skips
  // dispose (below), but its locks must still free so a peer waiting on those files unblocks.
  //
  // Bounded on BOTH sides, and the window is narrow. It must come AFTER landing (RUN-105): the
  // locks are HELD THROUGH the rebase→verify→fast-forward, so a second run in another worktree on
  // this repo cannot grab a file mid-merge and race it — locks live server-side, so runs across
  // worktrees see each other's holds — and they release only once the work is actually on the
  // integration branch. It must come BEFORE `report` (RUN-177): reporting a terminal status is what
  // makes the server retire this run's agent, and the release authenticates as that agent. Below
  // the report it was a 401 by construction — masked only because the floor was failing before it
  // acquired anything, and a real lock leak the moment that was fixed.
  //
  // Best-effort either way: the server also auto-releases on task settle and via TTL, so a miss
  // here (a crash before this line, a transient error) costs promptness, never correctness — the
  // same reason a daemon RESTART needs no lock reconcile of its own.
  if (vcs.releaseRunLocks) {
    await withTimeout(
      vcs
        .releaseRunLocks(worktree, {
          projectId: run.projectId,
          token: ctx.runAgent.token,
          branch: host.lockScopeBranch(repo, run),
          taskId: run.anchor?.type === 'task' ? run.anchor.taskId : null,
        })
        .catch((err) =>
          host.log.warn('lock release on terminal failed', { runId: run.id, err: String(err) }),
        ),
      LOCK_RELEASE_TIMEOUT_MS,
      () =>
        host.log.warn('lock release on terminal did not answer — settling anyway', {
          runId: run.id,
          waitedMs: LOCK_RELEASE_TIMEOUT_MS,
        }),
    );
  }

  ctx.exit = { ...ctx.exit, telemetry: ctx.tally.total() };

  // Close the transcript and persist the continuation BEFORE the terminal status goes out, and
  // before the workspace is disposed. The ordering carries three separate constraints:
  //
  //  - the record must EXIST by the time the server learns this run failed, because that is what
  //    makes it re-dispatchable; a continuation that arrives first would find no record and start
  //    over with none of this sitting's spend, ledger, lock scope or transcript position;
  //  - `changedPaths` has to be read from a workspace that still exists, and `dispose` below is
  //    permitted to reap it (a backend that both implements changedPaths and disposes would
  //    otherwise read a workspace that was just released);
  //  - the transcript's own numbering is only final once it is CLOSED, since closing flushes what
  //    was buffered and then appends the terminal milestone (RUN-183).
  // Whether the workspace still holds work a human (or a continuation) could need. Asked ONCE and
  // shared by the continuation record and the dispose decision below, so the two cannot disagree
  // about what exists. `driverSucceeded` alone was the wrong proxy and destroyed real work: a
  // CANCELLED continuation reads driverSucceeded=false, but its workspace carried three sittings'
  // committed diffs on a branch nothing else referenced. A probe that cannot answer errs toward
  // "work exists" — a kept empty worktree costs a warning at the next startup sweep, a disposed
  // full one costs the work.
  const hasRemainingWork =
    wf.produces && !ctx.landed && (ctx.driverSucceeded || (await vcs.hasWork(worktree).catch(() => true)));

  // This sitting's declared write scope, straight from the backend (RUN-130) — read ONCE, while
  // the workspace still exists, and shared by the continuation record below AND the episode
  // assembler after `report` (RUN-224): reading it twice could disagree with itself about what
  // this sitting touched. Best-effort: a backend without `changedPaths`, or a query that errors,
  // records none — both readers then see empty, exactly as before either existed.
  const changedPaths = await (vcs.changedPaths?.(worktree) ?? Promise.resolve([]))
    .then((p) => p)
    .catch(() => [] as string[]);

  // RUN-245: this sitting's change-stat measurement, read ONCE while the workspace still exists —
  // the same discipline `changedPaths` above follows, for the same reason (`dispose` below may reap
  // it). A non-producing workflow (scope/verify — `wf.produces` false) never asks the backend: it
  // changed nothing BY CONSTRUCTION (the write floor forces it), so a measured zero would assert
  // something was measured and an omission would read as "we did not look" — `not_applicable` is
  // the only honest answer, built directly rather than by asking and overriding (RUN-244's own
  // deferred note: "the CALLER at settle, with knowledge of the workflow, not the backend").
  //
  // A throw from the backend is absorbed into an `unavailable` result HERE, not inside the
  // `buildUploadedIntelligence` try below — a bug in one backend's analytics probe must cost only
  // this one metric, never the stage facts and verify-duration clocks the same episode carries.
  const vcsKind = vcs.kind ?? 'git';
  const changes: BuildUploadedIntelligenceInput['changes'] = wf.produces
    ? {
        kind: 'measured',
        backend: vcsKind,
        result: await vcs.changeStats(worktree).catch(
          (err): ChangeStatsResult => ({
            ok: false,
            reason: 'unavailable',
            detail: `changeStats threw: ${err instanceof Error ? err.message : String(err)}`,
          }),
        ),
      }
    : {
        kind: 'not_applicable',
        backend: vcsKind,
        reason: `this run's workflow ('${wf.id}') does not produce changes`,
      };

  const nextLogSeq = host.endTranscript(
    run.id,
    `${ctx.exit.outcome}${ctx.exit.reason ? ` — ${ctx.exit.reason}` : ''}`,
  );
  await recordContinuation(host, ctx, nextLogSeq, hasRemainingWork, changedPaths);

  host.report(run.id, {
    status: ctx.exit.outcome,
    agentId: ctx.runAgent.agentId,
    telemetry: ctx.exit.telemetry,
    logTail: ctx.tail,
    exit: { outcome: ctx.exit.outcome, reason: ctx.exit.reason },
  });

  // Keep only what a human still has to act on: a build whose diff did NOT land. Once it is on the
  // integration branch the worktree and its throwaway branch are dead weight — reaping them here is
  // what keeps ~/.noriq/worktrees from growing one directory per run forever.
  //
  // EXCEPT on a backend whose dispose preserves the work itself (RUN-52): there, skipping dispose is
  // not "keep the work", it is "hold the pool-of-1 lease forever" — the next run on this repo would
  // wait on a workspace nobody will ever hand back. Such a backend keeps the work server-side inside
  // dispose, so disposing IS keeping.
  //
  // Non-producing workflows never own work (a verify leases the BUILD's branch, which must not be
  // kept alive on its behalf) — `hasRemainingWork` already folds that in, so they dispose exactly
  // as before.
  const keptForHuman = hasRemainingWork && !vcs.disposePreservesWork;

  // Effort episode assembly (RUN-224) — the deterministic skeleton doc_msgy182g253w1r02596q §8
  // names. Placed HERE deliberately, between the two calls that bound it on opposite sides:
  //
  //   - AFTER `report` above: the server's own episode ingest (RUN-227, once it lands) skips any
  //     row whose run has no terminal exit yet, and `report` is what sets one. Assembling earlier
  //     would build a payload undeliverable by construction the moment delivery exists.
  //   - BEFORE `dispose` below: `filesTouched` was read from a workspace that must still exist,
  //     and `dispose` is what reaps it.
  //
  // Wrapped so a thrown error, a rejected promise, or a missing `host.recordEpisode` sink costs
  // only this sitting's episode — never the run's own outcome, which is already fully decided by
  // this point (see the module doc's completeness argument for why the payload matters, and
  // settle's own doc for why nothing here may become a second gate).
  try {
    const episode = buildEpisode(ctx, {
      filesTouched: changedPaths,
      hasRemainingWork,
      acceptanceEvidence,
      // Drained once, here — the daemon's own steer-delivery record (RUN-225), not the server's
      // independent view. `steeringHistory` is optional on `StageHost`; a host with none wired
      // (a test, steering off machine-wide) reads the same as a bridge that observed nothing.
      steeringHistory: host.steeringHistory?.(run.id) ?? [],
      selfSummary,
    });
    // The narrow Project Intelligence payload (RUN-284) — assembled from facts the run's own
    // tally already accumulated (RUN-243's `stageFacts()`, RUN-242's verify durations, actually
    // KEPT since this task). Wrapped in the SAME try as `buildEpisode` above: a throw here must
    // cost only the intelligence half of this sitting's episode, never the run's own outcome,
    // exactly like the episode assembly it rides alongside.
    // `stages` and the run-wide `total` come off ONE call (RUN-248) — the same addition
    // (`RunTally.stageFacts()`'s own doc: "structural, not asserted to agree"), so `observedModelUsage`
    // and the per-stage breakdown can never read two different tallies of the same run.
    const { stages, total: runTotal } = ctx.tally.stageFacts();
    const intelligence = buildUploadedIntelligence({
      stages,
      verifyDurations: ctx.tally.verifyDurations(),
      changes,
      runTotal,
      // RUN-247: captured at the render point (`stages/brief.ts`), carried onto the pipeline
      // unchanged — absent whenever this sitting made no assertion (`RunPipeline.contextConsumption`
      // 's own doc), in which case the metric is simply omitted from the upload.
      ...(ctx.contextConsumption ? { contextConsumption: ctx.contextConsumption } : {}),
    });
    host.recordEpisode?.(episode, intelligence);
  } catch (err) {
    host.log.warn('episode assembly failed — settling anyway', { runId: run.id, err: String(err) });
  }

  if (!keptForHuman) {
    await vcs
      .dispose(worktree)
      .catch((err) => host.log.warn('worktree cleanup failed', { err: String(err) }));
    // The bootstrap marker is keyed by workspace PATH and lives outside the tree (RUN-202), so a
    // disposed workspace must forget it: a backend that later leases the same directory would
    // otherwise skip installing into a tree that no longer holds what the last run installed. A
    // KEPT workspace deliberately keeps its marker — that is the continuation case the marker is
    // for. Best-effort, like the dispose above.
    await clearSetupMarker(worktree.localPath);
  }
  // A run reaching settle has NOT parked (a successful park returns before this stage), so if the
  // server still calls it blocked its agent asked a question that never parked — a wave child that
  // asked, a park write that failed, a decline branch. Abandon that orphaned signal so no `blocked`
  // row is left standing on a terminal run (RUN-199). The ONE terminal boundary every such path
  // flows through, which is why it lives here rather than bolted onto each refusal.
  await host.abandonOrphanedSignal(run.id);

  // The run is terminal, so its cancellation record has nothing left to protect (RUN-165) —
  // without this a long-lived daemon keeps one entry per cancelled run for its whole life.
  host.forgetCancellation?.(run.id);
  host.log.info('run finished', { runId: run.id, outcome: ctx.exit.outcome, reason: ctx.exit.reason });
};

/**
 * Continue a failed run (RUN-92): a gate-failed build keeps its work — the same condition the
 * dispose above skips on — so record what a continue must inherit that git cannot carry.
 *
 * The CUMULATIVE spend (the tally already folds any prior sitting, so re-seeding the next continue
 * from it never double-counts: `put` replaces, never adds) and the reviewer's final ledger.
 *
 * A record is REMOVED only by the outcome that resolves it: `done`. Every OTHER terminal on a
 * workspace that still holds work — a gate-fail, but equally a cancel, a crashed driver, a kill
 * mid-sitting — REFRESHES the record with this sitting's cumulative tally, transcript position and
 * changed paths. Two wrong versions preceded this one, each losing a different thing:
 *
 *   - the blanket remove threw the record away on a kill, so the next continue started blind with
 *     three sittings of spend, ledger and transcript position gone;
 *   - "leave it untouched" kept a STALE record, which is worse than it sounds: its spend
 *     undercounts the killed sitting (the next ceiling comes out WIDER, not tighter), its
 *     lastLogSeq predates the terminal milestone (the next sitting collides and its first
 *     segments vanish), and its changedPaths miss what the killed sitting touched (the predictive
 *     lock layer under-declares).
 *
 * The tally makes the refresh safe on every axis: it was seeded from the prior record, so its
 * totals are cumulative whether or not this sitting got far enough to add anything. The ledger
 * falls back to the seed for a sitting killed before its review — the prior adjudications are
 * still the freshest that exist.
 */
async function recordContinuation(
  host: StageHost,
  ctx: RunPipeline,
  /** The seq the NEXT sitting must number from (RUN-183) — one past everything this one wrote,
   *  terminal milestone included. */
  lastLogSeq: number,
  /** Whether the workspace still holds unlanded work — settle's own dispose answer, shared so the
   *  record and the workspace cannot disagree about what exists. */
  hasRemainingWork: boolean,
  /** What this sitting touched, per the backend (RUN-130) — read ONCE by the caller (RUN-224) and
   *  passed in, rather than queried again here, so this record and the episode assembler cannot
   *  read the workspace at two different moments and disagree. */
  changedPaths: string[],
): Promise<void> {
  const store = host.continuable;
  if (!store) return;
  const { run } = ctx;
  if (ctx.exit.outcome === 'done') {
    await store.remove(run.id).catch(() => {});
    return;
  }
  // Nothing to continue: a non-producing run, a landed one, or a workspace with nothing in it.
  // No record is written and none is removed — a state with no work has nothing to describe.
  if (!hasRemainingWork) return;
  const spent = ctx.exit.telemetry;
  await store
    .put({
      runId: run.id,
      spent: {
        tokens: totalTokens(spent),
        usd: spent.costUsd,
        ...(spent.modelUsage ? { modelUsage: spent.modelUsage } : {}),
      },
      // Safe for a sitting killed before its review: the pipeline initializes this from the
      // continuation seed (supervisor.ts), so the prior adjudications survive the refresh.
      ledger: ctx.ledger,
      // The wall-clock axis carries over too (RUN-133), or a continue would restart the duration
      // ceiling it just spent — the same loophole tokens had.
      activeSeconds: ctx.tally.activeSeconds(),
      ...(changedPaths.length ? { changedPaths } : {}),
      // Where the transcript got to, so the next sitting numbers ABOVE it rather than colliding
      // with what this one wrote and vanishing into the server's (runId, seq) dedupe (RUN-183).
      lastLogSeq,
      failedAt: new Date().toISOString(),
    })
    .catch((err) =>
      host.log.warn('could not persist continuation state', { runId: run.id, err: String(err) }),
    );
}
