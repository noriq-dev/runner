// The independent adversarial verify agent (RUN-20, run kind=verify). A FRESH
// agent — never the one that wrote the code — is given only the phase's task specs
// + the accumulated diff and prompted to find why the work does NOT satisfy the
// intent. This catches what a passing test suite can't: a weakened/deleted test, a
// spec quietly unmet, a missing edge case. Its verdict gates the phase.

export type Verdict = 'pass' | 'fail' | 'unknown';

export interface VerifyVerdict {
  verdict: Verdict;
  passed: boolean;
  findings: string;
}

export interface VerifyPromptContext {
  /** The identity the daemon created for this Run — the agent is told it, not asked to
   *  invent one (RUN-43). Authorship separation is the point of this gate, so WHICH actor
   *  filed the verdict has to be a fact the daemon knows, not a claim the model makes. */
  agent: { agentId: string; label: string };
  server: string;
  /** How the agent inspects the accumulated diff (default: the worktree changes). */
  diffCmd?: string;
}

/** Build the adversarial verify prompt from the phase specs. */
export function assembleVerifyPrompt(specs: string, ctx: VerifyPromptContext): string {
  const diffCmd = ctx.diffCmd ?? 'git diff';
  // The verify kind assembles its own prompt, so RUN-32's invitation has to be repeated here —
  // it does not inherit assemblePrompt's identity block. A verifier that finds something
  // alarming but out of scope for its verdict has nowhere else to put it: its output is parsed
  // for PASS/FAIL, so prose around the verdict is read by nobody.
  return `You are ${ctx.agent.label} (${ctx.agent.agentId}), a Noriq Runner VERIFY agent — an INDEPENDENT, adversarial reviewer. You did NOT write this code; assume nothing about the author's intent beyond the specs below.
Your Noriq identity is already set up: the MCP server at ${ctx.server} authenticates you as this agent — do NOT call set_agent_identity.
If you find something alarming beyond this diff's verdict, call raise_alert — it does not block you, and your verdict is not the place for it. If you cannot judge the diff without a human decision, call request_input rather than guessing a verdict.

MODE: VERIFY (read-only). Do NOT modify any files.
Inspect the accumulated diff with \`${diffCmd}\` and read the changed files. Your job is to find why this diff does NOT satisfy the intent — be skeptical. Look especially for:
  - tests weakened, skipped, or deleted to make the suite pass,
  - specs that are only partially met or silently unmet,
  - missing edge cases and error handling a green test run would miss.
You MAY use the repo's /verify skill to drive the check — don't just re-run the tests, exercise the behavior.

End your response with EXACTLY one line, on its own:
  VERDICT: PASS   — the diff fully and honestly satisfies the intent
  VERDICT: FAIL   — it does not (then list the specific findings)

Task specs / intent to verify against:
${specs}`;
}

const VERDICT_RE = /VERDICT:\s*(PASS|FAIL)/i;

/** Parse the agent's pass/fail verdict from its output. An absent/ambiguous
 *  verdict is 'unknown' → treated as a FAIL (adversarial default: don't advance a
 *  phase the verifier didn't clearly clear). */
export function parseVerdict(output: string): VerifyVerdict {
  const matches = [...output.matchAll(new RegExp(VERDICT_RE, 'gi'))];
  const last = matches.at(-1); // the final verdict line wins
  const verdict: Verdict = last ? (last[1]!.toUpperCase() === 'PASS' ? 'pass' : 'fail') : 'unknown';
  return { verdict, passed: verdict === 'pass', findings: output.trim() };
}

/** Format a failed verify verdict for a task comment (the phase-gate surface). */
export function verifyAgentComment(v: VerifyVerdict): string {
  const why =
    v.verdict === 'unknown'
      ? 'returned no clear verdict (treated as FAIL)'
      : 'found the diff does NOT satisfy the intent';
  return `🔍 Independent verify agent ${why} — this phase cannot advance.\n\n${v.findings.slice(-6000)}`;
}
