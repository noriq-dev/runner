/**
 * The `review` stage (RUN-131): a FRESH adversarial actor judges whether the diff satisfies the
 * INTENT — the question the deterministic command cannot ask.
 *
 * Before integration, deliberately. A rebase changes whether the combination still builds — the
 * command's question, asked post-rebase inside the repo lock — never what the diff MEANS. And an
 * agent review held inside that lock would serialize every other run on the repo behind a judgment
 * that cannot change.
 */

import { acceptanceNeedsAttention, acceptanceSummary, renderAcceptanceReport } from '../acceptance';
import { renderRequirementOutcomes, requirementOutcomes } from '../adjudication';
import { reviewerNoVerdictComment, reviewerRejectionComment } from '../verify-reviewer';
import type { RunPipeline, StageHost } from './types';

export const reviewStage = async (host: StageHost, ctx: RunPipeline): Promise<void> => {
  const { run, repo, worktree } = ctx;
  if (!(ctx.driverSucceeded && ctx.exit.outcome === 'done' && repo.manifest.verify?.agent)) return;
  const comment = (body: string) => {
    if (run.anchor?.type === 'task') host.postComment(run.projectId, run.anchor.taskId, body);
  };

  host.report(run.id, { status: 'running', phase: 'verifying' });
  const review = await host.reviewWithFeedback({
    run,
    repo,
    worktree,
    driver: ctx.driver,
    session: ctx.session,
    task: ctx.task,
    tally: ctx.tally,
    getSessionText: ctx.getSessionText,
    budget: host.runBudget(run),
    priorLedger: ctx.continued?.ledger,
    acceptance: ctx.acceptance,
    acceptanceOverflow: ctx.acceptanceOverflow,
    requirements: ctx.requirements,
    // The deterministic floor runs HERE only when this run is not landing; a landing run verifies
    // the REBASED result instead, after this review (RUN-19, `stages/verify.ts`). Telling the
    // reviewer a command "already passed" when it has not yet run is a false premise handed to a
    // gate — and it is told not to re-run it, so it cannot discover otherwise (RUN-177).
    verifyRan: !ctx.landPolicy,
  });
  ctx.ledger = review.ledger; // the freshest adjudication state, for the continuable record

  // The per-criterion record (RUN-145) is posted whatever the verdict, and that is the point of
  // it: on a FAIL it is the most legible part of the report, and on a PASS it is the ONLY place a
  // criterion nobody could evidence is visible at all — a passing run is exactly where such a gap
  // would otherwise disappear. Only when there were criteria to answer; a run with no spec gets
  // no empty scorecard.
  if (review.acceptance?.entries.length) {
    host.log.info('acceptance criteria', { runId: run.id, summary: acceptanceSummary(review.acceptance) });
    host.transcript(run.id).milestone(`acceptance: ${acceptanceSummary(review.acceptance)}`);
    // Anything that is not `verified` is worth a human's eyes, including `human-needed` — that
    // outcome's whole content is "a person has to do something", so a passing run that never says
    // so has lost the request entirely.
    if (!review.passed || acceptanceNeedsAttention(review.acceptance)) {
      comment(renderAcceptanceReport(review.acceptance));
    }
  }

  // What the review found PER REQUIREMENT (RUN-147). Posted whatever the verdict, because "which
  // requirements came through clear" is the run's answer, not a consolation prize for a failure —
  // and a passing run is where it is least likely to be asked and most useful to have.
  if (ctx.requirements.length) {
    // `passed` decides what "standing" means. On a PASS the gate read every prior finding and its
    // rebuttal and cleared the work anyway — that IS the adjudication, and going on to report a
    // contested finding as an open defect would contradict the verdict of the run printing it.
    const req = requirementOutcomes(ctx.requirements, review.ledger, { passed: review.passed });
    const open = req.outcomes.filter((o) => o.standing.length).length;
    host
      .transcript(run.id)
      .milestone(`requirements: ${open} of ${req.outcomes.length} with a finding still standing`);
    comment(renderRequirementOutcomes(req));
  }

  if (review.passed) {
    host.log.info('inline reviewer PASS', { runId: run.id, rounds: review.rounds });
    return;
  }
  if (review.verdict === 'fail') {
    host.log.warn('inline reviewer refused the work — run gated (not done)', {
      runId: run.id,
      verdict: review.verdict,
      rounds: review.rounds,
    });
    comment(reviewerRejectionComment(review.findings, review.rounds));
    ctx.exit = { ...ctx.exit, outcome: 'failed', isError: true, reason: 'review' };
    return;
  }
  // 'unknown' = the gate never rendered a judgment (reviewer killed, crashed, budget breach,
  // missing driver, no VERDICT line). NOT a refusal — saying "the reviewer found problems" about a
  // reviewer somebody killed is a lie in both directions: it maligns the diff and it hides the
  // infrastructure failure. The run still cannot pass — silence must not read as a gate that isn't
  // there — but the reason and the comment say what actually happened, and no fix rounds were
  // burned on a non-report.
  host.log.warn('inline reviewer rendered NO verdict — run gated, not judged', {
    runId: run.id,
    rounds: review.rounds,
  });
  comment(reviewerNoVerdictComment(review.findings));
  ctx.exit = { ...ctx.exit, outcome: 'failed', isError: true, reason: 'review:no-verdict' };
};
