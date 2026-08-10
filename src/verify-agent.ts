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
import { parseFindings } from './adjudication';
import { renderPrompt } from './prompts';

export type Verdict = 'pass' | 'fail' | 'unknown';

/**
 * The reviewer's STRUCTURAL diagnosis, honoured (RUN-175).
 *
 * RUN-90 taught the reviewer to say whether an invariant-class leak is BOUNDED (enumerable now) or
 * STRUCTURAL (no single enforcement point) — as prose only the builder reads. A run the reviewer
 * had already diagnosed as structurally unconvergeable still burned every remaining fix round
 * rediscovering that, then failed anyway. This is the machine-readable half: present on a verdict
 * only when the daemon checked the evidence and honoured the claim, so a consumer never has to
 * re-litigate whether an escalation was earned.
 */
export interface ReviewEscalation {
  /** The numbered FINDING this report raised that names the invariant-class. */
  findingId: number;
  /** The broken promise, in the reviewer's words — what a human re-dispatches around. */
  diagnosis: string;
  /** The distinct `file:line` instances cited as the evidence that the class is real. */
  instances: string[];
}

export interface VerifyVerdict {
  verdict: Verdict;
  passed: boolean;
  findings: string;
  /** Per-criterion evidence (RUN-145). Absent when the actor was given no criteria to answer —
   *  which is most runs, since most tasks carry no spec. */
  acceptance?: AcceptanceReport;
  /** An HONOURED structural escalation (RUN-175). Only ever set on a clear FAIL whose report
   *  passed the evidence gate (`readEscalation`), and only by the inline-reviewer path — the
   *  dispatched verify run has no fix-round loop for a token to short-circuit. Absent otherwise,
   *  which is every report written before the token existed. */
  escalation?: ReviewEscalation;
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
  /** Rendered custom workflow text. It is evidence supplied by the repo/operator and is quoted
   *  inside the daemon-owned verify frame; it never replaces the verdict instructions. */
  workflowPrompt?: string;
  /** The spec's acceptance criteria, numbered, for a per-item answer (RUN-145). Empty/absent →
   *  the section renders nothing and this actor answers in prose as it did before. */
  acceptance?: AcceptanceItem[];
  /** Criteria that did not fit the checklist, named rather than dropped. */
  acceptanceOverflow?: number;
  /** The verified context pack, rendered through the reviewer-audience quoted-evidence frame
   *  (RUN-231, `memory-render.ts`). Empty/absent → the block renders nothing, exactly as before
   *  this task landed. Placed BEFORE the acceptance/verdict instructions in the template so the
   *  daemon's own instructions stay the last word over untrusted retrieved evidence. */
  memory?: string;
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
    workflowPrompt: ctx.workflowPrompt ?? '',
    memory: ctx.memory ?? '',
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

// `ESCALATE STRUCTURAL FINDING 2: the write floor is re-derived per site — src/a.ts:9, src/b.ts:14`
//
// Same forgiving prefix as EVIDENCE_RE, `FINDING` optional, `.`/`)` accepted for the separator —
// a reviewer that reasoned its way to a real structural diagnosis must not lose it to punctuation.
// What is NOT forgiven is the evidence, below: a token is easier to emit than RUN-90's paragraph,
// and a reviewer that can end a run in one word will, so the gate is mechanical and strict.
const ESCALATION_RE =
  /^[ \t>*\-–—•\d.)\]]*ESCALATE[ \t]+STRUCTURAL\b(?:[ \t]+FINDING)?[ \t]+(\d+)[ \t]*[:.)][ \t]*(.*)$/gim;

/** A `path:line`-shaped citation — the anchor shape FINDING lines already use. The optional range
 *  suffix keeps `src/a.ts:10-20` one citation instead of a citation and a stray number. */
const INSTANCE_RE = /[\w@./\\-]+:\d+(?:[-–]\d+)?/g;
const DIAGNOSIS_CAP = 300;

/** "Several", made mechanical. RUN-90's prose bar is "several instances + unlike mechanisms + one
 *  named broken promise, cited"; a machine can count the cited instances and read the diagnosis,
 *  but cannot judge "unlike mechanisms" — the checkable proxy is that the instances span more
 *  than one FILE (below), and the qualitative half stays in the prompt. */
export const ESCALATION_INSTANCE_FLOOR = 3;

/** The named-broken-promise half, as a floor a shrug cannot meet. `pointsAtSomething`'s three
 *  alphanumerics was the wrong precedent to reuse here: it guards a claim's EVIDENCE, where `bad`
 *  next to three citations would have been honoured — but the diagnosis IS the deliverable (it is
 *  the sentence a human re-dispatches around), and a promise has a subject and a verb where a
 *  word has neither. Four words is low enough that no genuinely named invariant ever trips it. */
const ESCALATION_PROSE_FLOOR = 4;

const capLine = (s: string, n: number): string => {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The distinct code sites cited in a stretch of text. A bare `12:30` is a time, not a site, so
 *  the path part must contain something a path has and a number does not. Deduped case-blind:
 *  the same site cited three times is one instance, not three. */
const distinctInstances = (text: string): string[] => {
  const seen = new Map<string, string>();
  for (const m of text.match(INSTANCE_RE) ?? []) {
    const path = m.slice(0, m.indexOf(':'));
    if (!/[a-z_/\\]/i.test(path)) continue;
    const key = m.toLowerCase();
    if (!seen.has(key)) seen.set(key, m);
  }
  return [...seen.values()];
};

export interface EscalationReading {
  /** The honoured escalation — the token named a FINDING this report raised, cited enough
   *  distinct instances, and named the promise in words. Null when no token appeared or none
   *  survived the gate. */
  escalation: ReviewEscalation | null;
  /** Why a token that WAS present is ignored — surfaced so the demotion is legible in a log
   *  rather than mistaken for the daemon never having seen it. Null when no token appeared or
   *  one was honoured. */
  demoted: string | null;
}

/**
 * Read the reviewer's structural-escalation token off its report, and demote what the evidence
 * does not carry (RUN-175).
 *
 * The RUN-145 posture, applied to a claim that ends runs instead of criteria: an unevidenced
 * token is demoted, never honoured — the run proceeds as the ordinary FAIL the report already is.
 * The precedent is `pointsAtSomething`: a claim with nothing pointed at is not the claim. Every
 * check here fails toward today's behaviour, because the failure modes are asymmetric — a demoted
 * real escalation costs the fix rounds we spend today, an honoured lazy one converts a run that
 * might still converge into a failure on one word.
 *
 * What the gate demands, each mechanical and each mirroring a piece of RUN-90's prose bar:
 * - The report's own verdict is FAIL. A PASS is never converted by a token (escalation asserts
 *   the run cannot converge, which is incoherent alongside a clean pass), and an absent/ambiguous
 *   verdict means the gate never rendered a judgment for the token to ride on.
 * - The token names a numbered FINDING this report raised — the invariant-class must occupy a
 *   number, exactly as RUN-90 requires, so the escalation is anchored to a claim the builder and
 *   the ledger can see.
 * - At least ESCALATION_INSTANCE_FLOOR distinct `file:line` instances are cited, on the named
 *   finding or the token line itself — "several instances, cited", counted.
 * - The cited instances span more than one file — the checkable proxy for "unlike mechanisms".
 *   RUN-90's structural evidence is "a trim in one path, a split in another"; three sites one
 *   file-local fix could close are the BOUNDED case wearing the token.
 * - The diagnosis names the promise in a sentence (ESCALATION_PROSE_FLOOR words beyond the
 *   citations): a line that is only citations, or a one-word shrug beside them, has evidenced
 *   something but named nothing to re-dispatch around.
 *
 * A report with no token returns `{ null, null }` and the caller's behaviour is byte-identical to
 * today's — the field this feeds is optional and absent.
 */
export function readEscalation(output: string): EscalationReading {
  const tokens = [...output.matchAll(ESCALATION_RE)];
  if (!tokens.length) return { escalation: null, demoted: null };
  if (parseVerdict(output).verdict !== 'fail') {
    return {
      escalation: null,
      demoted:
        'the report’s own verdict is not FAIL — a token never converts a PASS, and an absent verdict is no judgment to escalate',
    };
  }
  const findings = parseFindings(output);
  const demotions: string[] = [];
  for (const m of tokens) {
    const id = Number(m[1]);
    const diagnosis = (m[2] ?? '').trim();
    const finding = findings.find((f) => f.id === id);
    if (!finding) {
      demotions.push(`names FINDING ${id}, which this report never raised as a numbered finding`);
      continue;
    }
    const instances = distinctInstances(`${finding.location} ${finding.claim} ${diagnosis}`);
    if (instances.length < ESCALATION_INSTANCE_FLOOR) {
      demotions.push(
        `cites ${instances.length} distinct instance(s); the floor is ${ESCALATION_INSTANCE_FLOOR}`,
      );
      continue;
    }
    const files = new Set(instances.map((i) => i.slice(0, i.lastIndexOf(':')).toLowerCase()));
    if (files.size < 2) {
      demotions.push(
        'every cited instance sits in one file — structural means unlike mechanisms, and one file is one place to fix',
      );
      continue;
    }
    // Words with at least two letters, citations stripped first so a pile of paths cannot count
    // as the promise they fail to name.
    if (
      (diagnosis.replace(INSTANCE_RE, ' ').match(/[a-z]{2,}[\w-]*/gi)?.length ?? 0) < ESCALATION_PROSE_FLOOR
    ) {
      demotions.push(
        'cites instances but names no broken promise — a diagnosis is a sentence naming the invariant, not a word beside citations',
      );
      continue;
    }
    return {
      escalation: { findingId: id, diagnosis: capLine(diagnosis, DIAGNOSIS_CAP), instances },
      demoted: null,
    };
  }
  return { escalation: null, demoted: demotions[0] ?? null };
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
