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

import { acceptanceNeedsAttention, acceptanceSummary, renderAcceptanceReport } from '../acceptance';
import { totalTokens } from '../drivers/budget';
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
  if (wf.verifyActor && ctx.driverSucceeded) {
    // Verdict AND per-criterion evidence together (RUN-145): a report that marks a criterion
    // FAILED and then signs off PASS is taken as the FAIL it contains, rather than as whichever
    // half the parser happened to read last.
    const v = judgeWithAcceptance(ctx.sessionText, ctx.acceptance);
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
  host.report(run.id, {
    status: ctx.exit.outcome,
    agentId: ctx.runAgent.agentId,
    telemetry: ctx.exit.telemetry,
    logTail: ctx.tail,
    exit: { outcome: ctx.exit.outcome, reason: ctx.exit.reason },
  });

  await recordContinuation(host, ctx);

  // Keep only what a human still has to act on: a build whose diff did NOT land. Once it is on the
  // integration branch the worktree and its throwaway branch are dead weight — reaping them here is
  // what keeps ~/.noriq/worktrees from growing one directory per run forever.
  //
  // EXCEPT on a backend whose dispose preserves the work itself (RUN-52): there, skipping dispose is
  // not "keep the work", it is "hold the pool-of-1 lease forever" — the next run on this repo would
  // wait on a workspace nobody will ever hand back. Such a backend keeps the work server-side inside
  // dispose, so disposing IS keeping.
  if (!(wf.produces && ctx.driverSucceeded && !ctx.landed) || vcs.disposePreservesWork) {
    await vcs
      .dispose(worktree)
      .catch((err) => host.log.warn('worktree cleanup failed', { err: String(err) }));
  }
  // The run is terminal, so its cancellation record has nothing left to protect (RUN-165) —
  // without this a long-lived daemon keeps one entry per cancelled run for its whole life.
  host.forgetCancellation?.(run.id);
  host.log.info('run finished', { runId: run.id, outcome: ctx.exit.outcome, reason: ctx.exit.reason });
  host.endTranscript(run.id, `${ctx.exit.outcome}${ctx.exit.reason ? ` — ${ctx.exit.reason}` : ''}`);
};

/**
 * Continue a failed run (RUN-92): a gate-failed build keeps its work — the same condition the
 * dispose above skips on — so record what a continue must inherit that git cannot carry.
 *
 * The CUMULATIVE spend (the tally already folds any prior sitting, so re-seeding the next continue
 * from it never double-counts: `put` replaces, never adds) and the reviewer's final ledger. Any
 * OTHER terminal — done, landed, a driver failure, a non-build — leaves nothing to continue, so a
 * record a prior failed sitting left is dropped: this continuation resolved it.
 */
async function recordContinuation(host: StageHost, ctx: RunPipeline): Promise<void> {
  const store = host.continuable;
  if (!store) return;
  const { run, repo, worktree, workflow: wf } = ctx;
  if (!(wf.produces && ctx.exit.outcome === 'failed' && ctx.driverSucceeded && !ctx.landed)) {
    await store.remove(run.id).catch(() => {});
    return;
  }
  const spent = ctx.exit.telemetry;
  // What this sitting touched becomes the continuation's declared lock scope (RUN-130).
  // Best-effort: a backend without `changedPaths`, or a query that errors, simply records none —
  // the predictive layer then no-ops exactly as it did while nothing was bound.
  const changedPaths = await (host.vcsFor(repo).changedPaths?.(worktree) ?? Promise.resolve([]))
    .then((p) => p)
    .catch(() => [] as string[]);
  await store
    .put({
      runId: run.id,
      spent: {
        tokens: totalTokens(spent),
        usd: spent.costUsd,
        ...(spent.modelUsage ? { modelUsage: spent.modelUsage } : {}),
      },
      ledger: ctx.ledger,
      // The wall-clock axis carries over too (RUN-133), or a continue would restart the duration
      // ceiling it just spent — the same loophole tokens had.
      activeSeconds: ctx.tally.activeSeconds(),
      ...(changedPaths.length ? { changedPaths } : {}),
      failedAt: new Date().toISOString(),
    })
    .catch((err) =>
      host.log.warn('could not persist continuation state', { runId: run.id, err: String(err) }),
    );
}
