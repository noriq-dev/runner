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

import { type LedgerEntry, renderLedger } from './adjudication';
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
  /** Findings already raised and answered in earlier rounds (RUN-79). Empty/absent on the
   *  first look — a fresh reviewer with no history yet. Rendered into the PRIOR ADJUDICATIONS
   *  section so a settled finding is verified, not relitigated. */
  ledger?: LedgerEntry[];
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
 *  violation, and every round re-raising the same out-of-scope finding.
 *
 *  RUN-78 adds the workspace-boundary rule: a requirement whose implementation lives in another
 *  repo/service/deployment cannot be satisfied from this tree, so it is follow-up for the human,
 *  not a verdict-driving finding — but a contract this change PARTICIPATES in (a wire frame it
 *  emits, an interface it calls) stays in scope. This repo is standalone by design (see
 *  CLAUDE.md), so cross-repo intent is common; without the rule fresh reviewers split on it
 *  (RUN-59 dogfood: rounds 1/3 failed a run over server-repo surfaces the diff could never carry,
 *  round 2 reasoned the boundary out unprompted).
 *
 *  RUN-79 adds cross-round memory: prior findings + the builder's structured rebuttal ride in the
 *  PRIOR ADJUDICATIONS section (adjudication.ts). The reviewer stays fresh on the DIFF but is no
 *  longer amnesiac about what was already settled — it verifies each pointer rather than trusting
 *  it, so a real finding still lands and a rebutted one is not relitigated. Empty ledger → the
 *  section renders nothing, so the first look is unchanged.
 *
 *  Two rules earned by the RUN-66/RUN-88 dogfood, where both runs died in the TERMINAL review —
 *  the one with no fix budget behind it — on findings raised for the first time there:
 *
 *  The revert test makes the scope rule mechanical rather than a matter of taste. RUN-76 already
 *  said "not this author's to answer for"; RUN-88 shows that stating it is not enough. Asked to
 *  delete a security-shaped field that never did anything, the reviewer failed the run because
 *  manifests still carrying the dead key get no migration warning — true, and equally true before
 *  the diff, which neither created the false assurance nor worsened it. A reviewer whose subject
 *  IS a false assurance will find one and charge it to whoever touched the file last. "Would a
 *  revert fix it?" is checkable in a way "is this pre-existing?" is not. It settles SCOPE only, and
 *  says so in both directions: it never licenses dismissing a defect the diff does own, which is
 *  the failure mode of every rule that makes flagging harder.
 *
 *  Collapsing a CLASS into one numbered finding is what makes a bounded round budget survivable.
 *  RUN-66 spent all three rounds on one root cause — a wizard that re-derived committed values
 *  through lossy transforms — and the reviewer reported a fresh sample of it each round (values
 *  withheld from the fallback, then transforms run over the answer, then a sibling's truthiness
 *  gating the read). Every finding was correct and none was a repeat, so the ledger above had
 *  nothing to catch: the builder patched the cited lines, the class survived, and the run failed on
 *  instance nine of it. The NUMBER is the mechanism, not the prose: the builder answers this report
 *  number by number and fixes what each number cites, so a class named in a preamble above four
 *  instance lines still buys four patched lines. It has to occupy a number to be answered as one.
 *  Instance-reporting is also what the "concrete failure at a file/line" bar quietly incentivises,
 *  so the rule has to be stated against it — measured on this template, a reviewer handed the four
 *  RUN-66 round-1 defects as raw notes now returns one finding naming the cause and citing the
 *  other three as evidence, where the pre-rule wording returned four. That converges the fix in one
 *  round, or proves the work is bigger than the rounds left — either beats learning it last round,
 *  which is the RUN-66 outcome this exists to stop. */
export function assembleReviewerPrompt(ctx: ReviewerPromptContext): string {
  return renderPrompt('reviewer', {
    diffCmd: ctx.diffCmd ?? null,
    verifyCmd: ctx.verifyCmd ?? null,
    intent: ctx.intent,
    priorAdjudications: ctx.ledger?.length ? renderLedger(ctx.ledger) : null,
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
