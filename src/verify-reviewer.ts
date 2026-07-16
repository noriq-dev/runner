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

/** The prompt for one fresh reviewer session. Read-only, no identity, no MCP. */
export function assembleReviewerPrompt(ctx: ReviewerPromptContext): string {
  const inspect = ctx.diffCmd
    ? `Inspect the accumulated diff with \`${ctx.diffCmd}\` and read the changed files.`
    : 'Inspect the modified files in this working tree and read them in full.';
  const floor = ctx.verifyCmd
    ? `\nThe deterministic check (\`${ctx.verifyCmd}\`) already passed — do not re-run it to grade the work. Spend your turns on what a green suite cannot prove.`
    : '';
  return `You are an INDEPENDENT, adversarial code reviewer. You did NOT write this code; assume nothing about the author's intent beyond the intent below. You have no project-management access — your entire output is your report, and it is read by the daemon and by the agent that wrote the code.

MODE: REVIEW (read-only). Do NOT modify any files.
${inspect} Your job is to find why this work does NOT satisfy the intent — be skeptical. Look especially for:
  - tests weakened, skipped, or deleted to make the suite pass,
  - intent that is only partially met or silently unmet,
  - missing edge cases and error handling a green test run would miss.${floor}

End your response with EXACTLY one line, on its own:
  VERDICT: PASS   — the work fully and honestly satisfies the intent
  VERDICT: FAIL   — it does not (then your report above must list the specific, actionable findings)

Intent to review against:
${ctx.intent}`;
}

/**
 * What the live builder is told when the reviewer refuses its work — same shape as RUN-29's
 * verify feedback: the report, in context, to the session that can act on it. The findings
 * cap mirrors the comment surface (a report longer than this has stopped being actionable).
 */
export function reviewerFeedbackPrompt(findings: string, round: number, maxRounds: number): string {
  return [
    'An independent reviewer examined your work and does not consider it finished.',
    '',
    'Its report:',
    '```',
    findings.slice(-6000),
    '```',
    '',
    'Address the specific findings — do not argue with the report in prose, fix the work.',
    round >= maxRounds
      ? 'This is the last attempt: a fresh reviewer looks once more after this, and if it still fails the run stops and a human picks it up.'
      : 'When you stop, a fresh reviewer will look again.',
  ].join('\n');
}

/** Format a final reviewer rejection for a task comment (the gate surface). */
export function reviewerRejectionComment(findings: string, rounds: number): string {
  const tried = rounds > 0 ? ` after ${rounds} fix round${rounds === 1 ? '' : 's'}` : '';
  return `🔍 The inline reviewer found the work does not satisfy the intent${tried} — this run did not pass the gate and cannot reach done.\n\n${findings.slice(-6000)}`;
}
