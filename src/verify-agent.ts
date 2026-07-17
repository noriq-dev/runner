// The independent adversarial verify agent (RUN-20, run kind=verify). A FRESH
// agent — never the one that wrote the code — is given only the phase's task specs
// + the accumulated diff and prompted to find why the work does NOT satisfy the
// intent. This catches what a passing test suite can't: a weakened/deleted test, a
// spec quietly unmet, a missing edge case. Its verdict gates the phase.

import { renderPrompt } from './prompts';

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
  /** How the agent inspects the accumulated diff, in the backend's own terms (git: a `git diff`
   *  range). Absent on a backend that has no such command — the prompt then points at the
   *  workspace's modified files instead, so this stays VCS-neutral. */
  diffCmd?: string;
}

/** Build the adversarial verify prompt (prompts/verify-agent.md) from the phase specs.
 *  The verify kind assembles its own prompt, so RUN-32's invitation (raise_alert /
 *  request_input) is repeated in the template — it does not inherit assemblePrompt's identity
 *  block. A verifier that finds something alarming but out of scope for its verdict has
 *  nowhere else to put it: its output is parsed for PASS/FAIL, so prose around the verdict is
 *  read by nobody. */
export function assembleVerifyPrompt(specs: string, ctx: VerifyPromptContext): string {
  return renderPrompt('verify-agent', {
    label: ctx.agent.label,
    agentId: ctx.agent.agentId,
    server: ctx.server,
    diffCmd: ctx.diffCmd ?? null,
    specs,
  });
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
