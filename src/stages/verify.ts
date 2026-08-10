/**
 * The `verify` stage (RUN-131): everything between "the agent stopped talking" and "someone should
 * look at this", that needs no judgment to decide.
 *
 * Four things, in an order that is load-bearing rather than incidental:
 *
 *   1. Was anything produced at all — a no-op run must not reach the gate.
 *   2. Make the diff DURABLE, before anything else can touch the workspace.
 *   3. The hard lock floor, AFTER the checkpoint so a gated diff is still on its branch.
 *   4. The deterministic floor: a zero-token command, run before the reviewer because it is cheap
 *      and definite (the same reason CI runs the linter before the humans arrive).
 *
 * A workflow that IS the verify actor is judged on its own output instead, and that verdict lives
 * in `settle` — it can only be read once the session it came from is closed.
 */

import { lockFloorComment } from '../lock-hooks';
import { cmdVerify, runCommitMessage } from '../supervisor';
import { verifyFailureComment, verifyNotApplicable } from '../verify';
import type { RunPipeline, StageHost } from './types';

export const verifyStage = async (host: StageHost, ctx: RunPipeline): Promise<void> => {
  const { run, repo, worktree, workflow: wf } = ctx;
  const vcs = host.vcsFor(repo);
  const comment = (body: string) => {
    if (run.anchor?.type === 'task') host.postComment(run.projectId, run.anchor.taskId, body);
  };

  // A build that changed NOTHING is not a success. An agent that bailed (blocked, refused, or ran
  // out of road) exits clean with a pristine worktree; verifying that burns the full suite to
  // re-test untouched HEAD, and a PASS would land the Run in review as "done" with an empty diff.
  if (wf.produces && ctx.driverSucceeded) {
    // Can't tell → assume it worked and let verify decide. Declaring `no_changes` reaps the
    // worktree, so guessing "empty" on a broken probe destroys the diff; guessing "full" at worst
    // spends a verify run on a tree a human can still open (RUN-152).
    const changed = await vcs.hasWork(worktree).catch((err) => {
      host.log.warn('could not tell whether the build produced changes — assuming it did', {
        runId: run.id,
        err: String(err),
      });
      return true;
    });
    if (!changed) {
      host.log.warn('build produced no changes — skipping verify, not a success', { runId: run.id });
      ctx.exit = { ...ctx.exit, outcome: 'failed', isError: true, reason: 'no_changes' };
      ctx.driverSucceeded = false;
    }
  }

  // Make the diff durable BEFORE anything else can touch the worktree. The agent may not have (or
  // use) git permissions, and loose files are destroyed by the next `worktree remove --force` —
  // including the crash-safe reap on the daemon's next start. Committing here is what makes "a
  // review diff on the branch" true.
  if (wf.produces && ctx.driverSucceeded) {
    const label = ctx.task ? `${ctx.task.key} ${ctx.task.title}` : (run.brief || run.id).slice(0, 60);
    await vcs
      .checkpoint(worktree, runCommitMessage(run.id, label))
      .then((committed) => {
        if (committed) {
          host.log.info('committed the run diff to its branch', {
            runId: run.id,
            workRef: worktree.workRef,
          });
        }
      })
      .catch((err) =>
        host.log.error('could not commit the run diff — it stays uncommitted', {
          runId: run.id,
          err: String(err),
        }),
      );

    // The hard floor (RUN-102), AFTER the checkpoint so the diff is preserved on the branch for a
    // human even when gated: acquire locks over everything this build changed. A conflict means it
    // touched a path a peer holds (the reactive hook missed it, or this is Codex) — gate it, do not
    // land it. Marking exit `failed{lock}` while KEEPING driverSucceeded makes every later stage
    // skip (they key off `exit.outcome === 'done'`) while the diff and its worktree survive for a
    // human, exactly like a verify failure.
    const floor = await host.enforceLockFloor(repo, run, worktree, ctx.runAgent.token);
    if (floor.conflicts.length) {
      host.log.warn('hard lock floor gated the build — it changed paths a peer holds', {
        runId: run.id,
        holders: floor.conflicts.map((c) => c.holderName ?? c.holder),
      });
      host
        .transcript(run.id)
        .milestone(
          `🔒 hard lock floor gated this build — it changed ${floor.conflicts
            .map((c) => c.path)
            .join(', ')}, held by ${floor.conflicts.map((c) => c.holderName ?? c.holder).join(', ')}`,
        );
      comment(lockFloorComment(floor.conflicts));
      ctx.exit = { ...ctx.exit, outcome: 'failed', isError: true, reason: 'lock' };
    } else if (floor.unchecked) {
      // The floor did not COMPLETE — so it locked nothing, and for a driver with no in-process hook
      // on a first sitting that was this run's only acquisition (RUN-156). Gate: the alternative is
      // landing over a path a peer may hold with no line anywhere saying the check was skipped.
      // Bounded cost — the workspace is kept below and the run is recorded continuable.
      host.log.warn('hard lock floor did not complete — gating rather than landing unchecked', {
        runId: run.id,
        why: floor.unchecked,
      });
      host
        .transcript(run.id)
        .milestone(
          '🔒 the hard lock floor could not complete, so nothing was checked against what other runs hold — gated rather than landed unchecked',
        );
      comment(
        `🔒 The lock floor could not check this run's files against what other runs hold, so the run is gated rather than landed unchecked.\n\nNothing is lost: the workspace is kept and this run can be continued. Re-dispatch once the cause below is cleared.\n\n\`\`\`\n${floor.unchecked}\n\`\`\``,
      );
      ctx.exit = { ...ctx.exit, outcome: 'failed', isError: true, reason: 'lock:unchecked' };
    }
  }

  // Whether this run lands, decided HERE and once — after the no-changes gate that can clear
  // `driverSucceeded`, before the two stages that ask. `integrate` reads this snapshot rather than
  // the manifest, so the pipeline's shape cannot change underneath it mid-run.
  ctx.landPolicy = wf.produces && ctx.driverSucceeded ? (repo.manifest.land ?? null) : null;

  // The deterministic floor (RUN-19), when NOT landing — the landing pipeline verifies the REBASED
  // result instead, which is strictly the better question.
  const floorCmd = cmdVerify(repo.manifest.verify);
  if (wf.produces && ctx.driverSucceeded && ctx.exit.outcome === 'done' && !ctx.landPolicy) {
    if (!floorCmd) {
      // The stage reaches this point but has nothing to run (RUN-242): no `[verify].cmd` committed
      // for this repo. Logged as `not_applicable`, never silently skipped — a duration of "0ms"
      // would read as "ran instantly", which is a different fact than "did not run at all".
      host.log.info('deterministic verify: not applicable', {
        runId: run.id,
        durationMs: verifyNotApplicable('no [verify].cmd configured for this repo'),
      });
    } else {
      // Same silence as landing, and the longer of the two in practice: the full suite with no
      // token burn to show for it (RUN-31). verifyWithFeedback can also hand work BACK to the agent
      // on a failure, which flips the phase to 'agent' again.
      host.report(run.id, { status: 'running', phase: 'verifying' });
      const result = await host.verifyWithFeedback({
        run,
        spec: floorCmd,
        cwd: worktree.localPath,
        session: ctx.session,
        tally: ctx.tally,
        phase: 'verifying',
      });
      // A real command the daemon watched exit (RUN-225) — recorded whatever the outcome, so the
      // episode shows this sitting reached the floor even on the FAIL path below.
      ctx.commandObservations.push({
        site: 'verify',
        cmd: floorCmd.cmd,
        passed: result.passed,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        attempts: result.attempts,
      });
      if (result.passed) {
        host.log.info('deterministic verify passed', { runId: run.id });
      } else {
        host.log.warn('deterministic verify FAILED — run gated (not done)', {
          runId: run.id,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
        });
        comment(verifyFailureComment(floorCmd, result));
        ctx.exit = { ...ctx.exit, outcome: 'failed', isError: true, reason: 'verify' };
      }
    }
  }
};
