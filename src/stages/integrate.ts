/**
 * The `integrate` stage (RUN-131): rebase onto the integration branch, verify THERE, fast-forward
 * in — serialized per repo.
 *
 * Verify runs after the rebase on purpose: two runs can each be green at their own fork point and
 * broken together, and a gate that never sees the combination cannot catch it. The repo lock is
 * what makes that true — rebase→verify→fast-forward is a read-modify-write of one branch, and two
 * runs interleaving would land untested combinations.
 *
 * Sharing (`[land].autoPush`) is the tail of a successful landing rather than a stage of its own:
 * it happens only for the branch that just landed and has no gate to fail, so promoting it would
 * invent a boundary the threat model does not have. It lives inside `landRun`.
 */

import { landFailureComment } from '../land';
import type { LandOutcome } from '../land';
import type { RunPipeline, StageHost } from './types';

export const integrateStage = async (host: StageHost, ctx: RunPipeline): Promise<void> => {
  const { run, repo, worktree } = ctx;
  // The snapshot `verify` took, not a fresh read of the manifest — see `RunPipeline.landPolicy`.
  const policy = ctx.landPolicy;
  if (!(policy && ctx.exit.outcome === 'done')) return;

  // The agent process is gone and the spend stops moving here, so without this the dashboard shows
  // "running" through a rebase → verify → fast-forward that can take a minute — and a queue behind
  // the repo lock makes it longer (RUN-31).
  host.report(run.id, { status: 'running', phase: 'landing' });
  const outcome = await host
    .withRepoLock(repo.root, () =>
      host.landRun({
        run,
        repo,
        worktree,
        policy,
        session: ctx.session,
        task: ctx.task,
        driver: ctx.driver,
        permission: ctx.permission,
        noriqMcp: ctx.noriqMcp,
        tally: ctx.tally,
        budget: host.runBudget(run),
      }),
    )
    .catch(
      (err): LandOutcome => ({
        landed: false,
        branch: policy.branch,
        reason: 'error',
        detail: String(err),
      }),
    );

  if (outcome.landed) {
    host.log.info('landed', {
      runId: run.id,
      branch: outcome.branch,
      sha: outcome.sha,
      resolvedByAgent: outcome.resolvedByAgent,
    });
  } else {
    host.log.warn('could not land — the diff stays on its branch', {
      runId: run.id,
      branch: outcome.branch,
      reason: outcome.reason,
    });
    if (run.anchor?.type === 'task') {
      host.postComment(run.projectId, run.anchor.taskId, landFailureComment(outcome, run.id));
    }
    // The gate rejecting the COMBINATION is a real failure, same as rejecting the change alone —
    // the run does not reach done either way. Deliberately does NOT clear `driverSucceeded`: that
    // flag decides whether the workspace survives, and an unlanded diff is exactly what a human
    // still needs.
    ctx.exit = { ...ctx.exit, outcome: 'failed', isError: true, reason: `land:${outcome.reason}` };
  }
  ctx.landed = outcome.landed;
};
