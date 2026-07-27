// The independent adversarial verify agent (RUN-20, run kind=verify). A FRESH
// agent — never the one that wrote the code — is given only the phase's task specs
// + the accumulated diff and prompted to find why the work does NOT satisfy the
// intent. This catches what a passing test suite can't: a weakened/deleted test, a
// spec quietly unmet, a missing edge case. Its verdict gates the phase.

import {
  type AcceptanceItem,
  type AcceptanceReport,
  acceptanceSummary,
  failedAcceptance,
  reconcileAcceptance,
  renderAcceptanceChecklist,
} from './acceptance';
import { renderPrompt } from './prompts';

export type Verdict = 'pass' | 'fail' | 'unknown';

export interface VerifyVerdict {
  verdict: Verdict;
  passed: boolean;
  findings: string;
  /** Per-criterion evidence (RUN-145). Absent when the actor was given no criteria to answer —
   *  which is most runs, since most tasks carry no spec. */
  acceptance?: AcceptanceReport;
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
  /** The repo's own orientation, NAMES ONLY (RUN-154). A verifier judges a diff against this
   *  repo's conventions, so being told nothing about them was backwards; the contents are left
   *  out because the diff already owns this actor's context. Absent = renders as it did before. */
  repoContext?: string;
  /** The spec's acceptance criteria, numbered, for a per-item answer (RUN-145). Empty/absent →
   *  the section renders nothing and this actor answers in prose as it did before. */
  acceptance?: AcceptanceItem[];
  /** Criteria that did not fit the checklist, named rather than dropped. */
  acceptanceOverflow?: number;
}

/** Build the adversarial verify prompt (prompts/verify-agent.md) from the phase specs.
 *  The verify kind assembles its own prompt, so RUN-32's invitation (raise_alert /
 *  request_input) is repeated in the template — it does not inherit assemblePrompt's identity
 *  block. A verifier that finds something alarming but out of scope for its verdict has
 *  nowhere else to put it: its output is parsed for PASS/FAIL, so prose around the verdict is
 *  read by nobody.
 *
 *  Like the inline reviewer (RUN-76), the template scopes the verdict to what the diff CHANGED
 *  and treats the specs as a floor, not a ceiling — the strict "when ambiguous, FAIL" posture
 *  stays, but only for code the diff touched, so pre-existing code and behavior beyond the
 *  specs cannot manufacture a false FAIL. RUN-78 adds the same workspace-boundary rule the
 *  inline reviewer carries: a spec whose implementation lives in another repo/service is
 *  follow-up, not a finding, while a contract this diff participates in stays in scope. */
export function assembleVerifyPrompt(specs: string, ctx: VerifyPromptContext): string {
  return renderPrompt('verify-agent', {
    label: ctx.agent.label,
    agentId: ctx.agent.agentId,
    server: ctx.server,
    diffCmd: ctx.diffCmd ?? null,
    context: ctx.repoContext ?? '',
    acceptance: ctx.acceptance?.length
      ? renderAcceptanceChecklist(ctx.acceptance, ctx.acceptanceOverflow ?? 0)
      : null,
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

/**
 * Parse a verdict AND its per-criterion evidence, and refuse to accept a report that contradicts
 * itself (RUN-145).
 *
 * A gate that marks a criterion FAILED and then signs off PASS has not passed the work — it has
 * written two answers and left whoever reads it last to pick. Reading that as PASS is the
 * fail-open shape, and it is not even a choice anybody made: it falls out of the verdict line
 * being parsed by one function and the evidence by another. So the daemon decides, here, once.
 *
 * Only a PASS is demoted. An `unknown` verdict stays unknown even alongside failed criteria,
 * because unknown means the gate never rendered a judgment — killed, crashed, out of budget — and
 * RUN-72's separation of "the work was found wanting" from "the gate did not run" is exactly what
 * a half-written report from a killed process would destroy. The failed criteria are still
 * recorded and still surfaced; what they do not do is convert an infrastructure failure into a
 * verdict about the diff.
 *
 * `behaviour-unverified` never moves the verdict. Most specs are half-written, and failing every
 * build with a truth nobody could evidence would make the field a tripwire rather than a contract.
 * Those gaps are the record RUN-146 reads.
 */
export function judgeWithAcceptance(output: string, items: AcceptanceItem[]): VerifyVerdict {
  const base = parseVerdict(output);
  if (!items.length) return base;
  const acceptance = reconcileAcceptance(items, output);
  const failed = failedAcceptance(acceptance);
  if (base.verdict !== 'pass' || !failed.length) return { ...base, acceptance };
  const cited = failed
    .map((f) => `  ${f.id}. ${f.item.text}${f.evidence ? ` — ${f.evidence}` : ''}`)
    .join('\n');
  return {
    verdict: 'fail',
    passed: false,
    acceptance,
    findings: `${base.findings}\n\n[the daemon overrode this PASS: the report marks ${failed.length} acceptance criteri${
      failed.length === 1 ? 'on' : 'a'
    } FAILED, which a PASS cannot stand alongside — ${acceptanceSummary(acceptance)}]\n${cited}`,
  };
}

/** Format a failed verify verdict for a task comment (the phase-gate surface). */
export function verifyAgentComment(v: VerifyVerdict): string {
  const why =
    v.verdict === 'unknown'
      ? 'returned no clear verdict (treated as FAIL)'
      : 'found the diff does NOT satisfy the intent';
  return `🔍 Independent verify agent ${why} — this phase cannot advance.\n\n${v.findings.slice(-6000)}`;
}
