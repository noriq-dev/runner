// The INLINE reviewer half of the verify stage (RUN-61). Distinct from verify-agent.ts on
// purpose: that is the separately DISPATCHED verify run kind (RUN-20, the server's phase gate);
// this is a fresh session the daemon spawns inside a build run's own supervision, so a repo can
// choose adversarial review per run without a second dispatch. They share the verdict protocol
// (parseVerdict) — the difference is where the report goes: a verify run's verdict gates a
// phase, the reviewer's report is handed BACK to the live builder to fix (RUN-29's shape).
//
// The reviewer holds NO Noriq credential, and that is a design fact, not a gap: one run gets
// one non-reissuable identity (RUN-43), so a second inline identity cannot exist — and does not
// need to. Its entire output IS the report; the daemon parses the verdict and posts the
// findings itself. This also makes authorship separation absolute: the reviewer cannot claim,
// move, or comment as anyone, only judge.

import { renderPrompt } from './prompts';

export interface ReviewerPromptContext {
  /** What the diff is supposed to achieve — the anchor task's text, or the run brief. */
  intent: string;
  /** How to inspect the accumulated diff. Absent on a non-git backend — the prompt then
   *  points at the working tree instead of a command it can't run. */
  diffCmd?: string;
  /** The deterministic floor's command, when one is configured — the reviewer is told it
   *  already passed so it spends its turns on what the command CANNOT check. */
  verifyCmd?: string | null;
}

/** The prompt for one fresh reviewer session (prompts/reviewer.md). Read-only, no identity,
 *  no MCP. The verifyCmd sentence exists so the reviewer spends its turns on what the
 *  deterministic floor CANNOT check instead of re-running a suite that already passed.
 *
 *  The template scopes the review to the CHANGE, not the file, and treats the intent as a
 *  floor the diff must meet rather than a ceiling it may not exceed (RUN-76). Each fresh
 *  reviewer is stateless, so without that discipline it re-reads whole changed files against
 *  a possibly-superseded brief and re-reports pre-existing code — the loop this gate saw fail
 *  three ways: pre-existing code flagged as the author's, later-approved evolution read as a
 *  violation, and every round re-raising the same out-of-scope finding. Cross-round memory
 *  (the builder's rebuttal to a settled finding) is a separate, heavier fix and NOT here. */
export function assembleReviewerPrompt(ctx: ReviewerPromptContext): string {
  return renderPrompt('reviewer', {
    diffCmd: ctx.diffCmd ?? null,
    verifyCmd: ctx.verifyCmd ?? null,
    intent: ctx.intent,
  });
}

/**
 * What the live builder is told when the reviewer refuses its work — same shape as RUN-29's
 * verify feedback: the report, in context, to the session that can act on it. The findings
 * cap mirrors the comment surface (a report longer than this has stopped being actionable).
 */
export function reviewerFeedbackPrompt(findings: string, round: number, maxRounds: number): string {
  return renderPrompt('reviewer-feedback', {
    findings: findings.slice(-6000),
    last: round >= maxRounds,
  });
}

/** Format a final reviewer rejection for a task comment (the gate surface). */
export function reviewerRejectionComment(findings: string, rounds: number): string {
  const tried = rounds > 0 ? ` after ${rounds} fix round${rounds === 1 ? '' : 's'}` : '';
  return `🔍 The inline reviewer found the work does not satisfy the intent${tried} — this run did not pass the gate and cannot reach done.\n\n${findings.slice(-6000)}`;
}

/** The gate never rendered a judgment (reviewer killed, crashed, budget breach, missing
 *  driver, no VERDICT line) — categorically different from a rejection (RUN-72): a rejection
 *  maligns the DIFF, this reports the GATE. The run still fails — silence must not read as a
 *  gate that isn't there — but the human reads "fix the reviewer setup / re-dispatch", never
 *  "the work was found wanting". */
export function reviewerNoVerdictComment(detail: string): string {
  return `🔍 The inline reviewer rendered NO verdict — it was stopped, crashed, or produced no report, so this run was gated without being judged. The diff stays on its branch; fix the reviewer (or re-dispatch) rather than the work.${detail.trim() ? `\n\n${detail.slice(-6000)}` : ''}`;
}
