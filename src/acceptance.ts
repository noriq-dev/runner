// Per-acceptance-item evidence (RUN-145).
//
// A spec's `acceptance` is the definition of done, and until now a gate answered it in prose: one
// PASS or FAIL over the whole diff, with the reasoning in paragraphs nobody parses. That hides the
// case this module exists to name — the criterion that was never actually checked. A reviewer
// reading a diff sees the code that would satisfy a truth and says PASS, because the code is
// there; nothing established that it DOES what the truth claims. The prose is not wrong, it is
// silent, and silence is read as a pass by every consumer downstream.
//
// So the answer becomes structured and per item: every criterion gets an outcome and a piece of
// evidence a human can open. Three rules make it mean something, and each closes a way the old
// shape failed open:
//
//   1. Silence is NOT a pass. An item the verifier never mentioned comes back
//      `behaviour-unverified`, not verified — the whole failure mode is a criterion falling out of
//      the report unnoticed, and defaulting the unmentioned to "fine" would rebuild it.
//   2. VERIFIED with no evidence is not VERIFIED. An unevidenced pass is exactly "the code looks
//      like it does that", which is the claim this module refuses to accept at face value.
//   3. The daemon resolves the contradiction, not the model. A report that says PASS while marking
//      a criterion FAILED is incoherent, and reading an incoherent report as PASS is fail-open.
//
// What this does NOT do is decide the run's fate on its own. `behaviour-unverified` is recorded and
// surfaced, not fatal: most specs are half-written, and failing every build whose spec has a truth
// nobody could evidence would make the field a tripwire rather than a contract. Routing those gaps
// into work is RUN-146's job — this is the record it reads.

import type { ExecutionSpec } from '@noriq-dev/shared';

/**
 * What a gate concluded about ONE criterion.
 *
 * `behaviour-unverified` is the addition that matters and the reason the other three are not
 * enough: it is neither pass nor fail but "nothing here established this either way", which is the
 * true state of most criteria in most reports and which a two-valued verdict has to round to one
 * side. Rounded up it is a lie; rounded down it fails honest work. Named, it is a fact somebody can
 * act on.
 *
 * `human-needed` is different again and worth its own name: not "unproven" but "unprovable from
 * here" — a truth about a deployed service, a visual judgement, a migration nobody can run in a
 * worktree. Collapsing it into `behaviour-unverified` would send RUN-146 off to write repair work
 * for something no amount of repair reaches.
 */
export type AcceptanceOutcome = 'verified' | 'failed' | 'behaviour-unverified' | 'human-needed';

/** Which half of the contract a criterion came from. Kept because the three are judged
 *  differently: an artifact's existence is checkable by looking, a link is checkable by following
 *  a call, and a truth usually needs something to have been RUN. */
export type AcceptanceKind = 'truth' | 'artifact' | 'link';

export interface AcceptanceItem {
  /** 1-based, stable for one spec, and the number the verifier answers by. Derived from position
   *  rather than content so the same spec always numbers the same way — a verifier's report and
   *  the daemon's checklist have to agree about what "3" means. */
  id: number;
  kind: AcceptanceKind;
  /** The criterion as one line, exactly as the verifier is shown it. */
  text: string;
}

export interface AcceptanceEvidence {
  id: number;
  outcome: AcceptanceOutcome;
  /** file:line, a test name, a command and what it printed — something a human can open. Empty
   *  only for outcomes that have nothing to point at. */
  evidence: string;
  /** The item this is about, carried so a consumer never has to re-join against the spec. */
  item: AcceptanceItem;
}

export interface AcceptanceReport {
  /** One entry per criterion, always, in the spec's order. An item the verifier ignored is
   *  present and `behaviour-unverified` — the report is a statement about the whole contract or
   *  it is prose again. */
  entries: AcceptanceEvidence[];
}

/**
 * How much of one criterion survives into the checklist.
 *
 * Generous on purpose. A criterion is the thing the builder was briefed with and the thing the gate
 * is asked about, so a cap that bites makes those two DIFFERENT definitions of done — the gate
 * grades work against a sentence whose qualification was cut off. This is high enough that a
 * criterion written as one sentence never reaches it, and the `…` is left visible so a reader can
 * tell a trimmed criterion from a terse one.
 */
const TEXT_CAP = 400;
const EVIDENCE_CAP = 240;
/** Beyond this a spec has stopped being a definition of done, and asking for evidence on each of
 *  200 criteria would spend the gate's whole budget on bookkeeping. The overflow is REPORTED (see
 *  `acceptanceOverflow`) rather than silently dropped. */
export const MAX_ACCEPTANCE_ITEMS = 40;

const cap = (s: string, n: number): string => {
  // NEWLINES flattened — every wire format here is one line per item, and a criterion containing a
  // newline would otherwise split into a line that parses as nothing plus a stray fragment. Runs of
  // ordinary spaces are left alone: collapsing them would quietly rewrite a criterion about exact
  // output ("prints `a  b`") into a different one, and the gate would grade against the rewrite.
  const t = s.replace(/[ \t]*\r?\n[ \t]*/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Every criterion the spec names, uncapped in count — the shared source for both the checklist and
 *  the overflow figure, so the two cannot disagree about how many there were. */
function allCriteria(spec: ExecutionSpec | null | undefined): AcceptanceItem[] {
  if (!spec) return [];
  const items: AcceptanceItem[] = [];
  const add = (kind: AcceptanceKind, text: string) => {
    const t = cap(text, TEXT_CAP);
    // An empty criterion is not a criterion. It would occupy a number, arrive at the verifier as a
    // blank line, and come back unverified forever.
    if (t) items.push({ id: items.length + 1, kind, text: t });
  };
  for (const t of spec.acceptance.observableTruths) add('truth', t);
  for (const a of spec.acceptance.artifacts) {
    const provides = a.provides ? ` and provides ${a.provides}` : '';
    const exports = a.exports.length ? `, exporting ${a.exports.join(', ')}` : '';
    add('artifact', `${a.path} exists${provides}${exports}`);
  }
  for (const l of spec.acceptance.links)
    add('link', `${l.from} reaches ${l.to}${l.via ? ` via ${l.via}` : ''}`);
  return items;
}

/**
 * Flatten a spec's acceptance into numbered criteria, in the order `renderExecutionSpec` presents
 * them: truths, then artifacts, then links.
 *
 * Order is part of the contract rather than an implementation detail — the numbers ARE the
 * addressing scheme, so anything that renumbers a spec silently invalidates a report written
 * against the old numbering. Position-derived and stable is the property that matters; which
 * order was chosen matters much less.
 */
export function enumerateAcceptance(spec: ExecutionSpec | null | undefined): AcceptanceItem[] {
  return allCriteria(spec).slice(0, MAX_ACCEPTANCE_ITEMS);
}

/**
 * Criteria the spec names beyond what the checklist carries — said out loud, because a list that
 * silently stops at 40 reads as a complete contract that happens to be short.
 *
 * Counted from the same enumeration the checklist comes from, NOT from the raw arrays: a spec with
 * blank entries has fewer real criteria than list lengths suggest, and counting them would report
 * an overflow that does not exist and tell a gate its list was incomplete when it was not.
 */
export function acceptanceOverflow(spec: ExecutionSpec | null | undefined): number {
  return Math.max(0, allCriteria(spec).length - MAX_ACCEPTANCE_ITEMS);
}

/**
 * The checklist a judging actor is shown — numbered, so its answer can be paired back.
 *
 * This is the ONLY rendering of acceptance a gate sees, deliberately: shown the criteria twice, in
 * prose and again as a checklist, a model answers the prose and skips the list.
 */
export function renderAcceptanceChecklist(items: AcceptanceItem[], overflow = 0): string {
  if (!items.length) return '';
  const lines = items.map((i) => `  ${i.id}. [${i.kind}] ${i.text}`).join('\n');
  const more =
    overflow > 0
      ? `\n  …and ${overflow} more criteria this spec names that did not fit — say in your report that the checklist was incomplete.`
      : '';
  return `${lines}${more}`;
}

// `ACCEPTANCE 3: BEHAVIOUR-UNVERIFIED src/land.ts:88 — the branch is written but nothing exercises it`
//
// Deliberately FORGIVING about everything around the answer, because every strictness here fails in
// the same direction: a line that does not match is not an error, it is an item recorded as
// unaddressed — so a report that plainly marks a criterion FAILED, in a bullet list or after a
// "Final:" label, would be passed by the daemon. Leading bullets, quote markers and list numbering
// are skipped; `.` and `)` are accepted for the separator as well as `:`.
//
// Both spellings of behaviour are accepted for the same reason. The canonical name in this codebase
// is the British one, and a model will produce whichever its training leaned toward; refusing the
// American spelling would discard a correctly-reasoned answer over an `o`, and do it silently — the
// model would be punished for the right answer with the outcome for saying nothing.
const EVIDENCE_RE =
  /^[ \t>*\-–—•\d.)\]]*ACCEPTANCE[ \t]+(\d+)[ \t]*[:.)][ \t]*(VERIFIED|FAILED|BEHAVIOU?R[ _-]?UNVERIFIED|HUMAN[ _-]?NEEDED)\b[ \t]*(.*)$/gim;

const outcomeOf = (token: string): AcceptanceOutcome => {
  const t = token.toUpperCase().replace(/[ _]/g, '-');
  if (t === 'VERIFIED') return 'verified';
  if (t === 'FAILED') return 'failed';
  if (t.startsWith('HUMAN')) return 'human-needed';
  return 'behaviour-unverified';
};

/**
 * How bad an outcome is. Used to pick between two answers for one criterion, so it is an ordering
 * over CONFIDENCE-IN-DONE, not over severity: `verified` is the only one that lets work through, so
 * it loses every tie.
 */
const SEVERITY: Record<AcceptanceOutcome, number> = {
  failed: 3,
  'behaviour-unverified': 2,
  'human-needed': 1,
  verified: 0,
};

/** Does this evidence point at anything? A gate that writes `VERIFIED —` or `VERIFIED N/A` has
 *  pointed at nothing while satisfying a non-empty check, which is the unevidenced pass this module
 *  exists to refuse. Three alphanumerics is the smallest bar that keeps a real pointer (`a.ts`) and
 *  rejects the punctuation-and-shrug answers. */
const pointsAtSomething = (evidence: string): boolean => (evidence.match(/[a-z0-9]/gi)?.length ?? 0) >= 3;

/**
 * Read a gate's structured answer and reconcile it against the criteria it was asked about.
 *
 * The reconciliation is the point — parsing alone would hand back whatever the model chose to talk
 * about, which is the prose problem with extra steps. Every criterion comes back, in order:
 *
 * - An item the report never names is `behaviour-unverified`. It is the single most likely way a
 *   criterion goes unchecked, and it is invisible in prose.
 * - A `verified` with nothing pointed at is DEMOTED to `behaviour-unverified`. "It is verified"
 *   with no evidence is a restatement of the criterion, and this whole module exists because a
 *   restatement reads as a check. Recorded with a message saying why, so the demotion is legible
 *   and not mistaken for the model having said that.
 * - A line addressing a number no criterion has is dropped. A verifier that invents item 9 for a
 *   7-item spec has lost track of the checklist; keeping the line would put an assertion in the
 *   record with no criterion attached to it.
 * - When a criterion is answered MORE THAN ONCE, the least-passing answer wins — not the first, and
 *   not the last. Position is the wrong tiebreak here and either choice is exploitable: a model
 *   that drafts an answer in a fenced example and then writes the real one would beat first-wins,
 *   and a model that trails off restating an earlier line would beat last-wins. Picking by outcome
 *   makes the rule independent of where the lines fall, and it fails in the direction this codebase
 *   has already settled on — a false FAIL costs one more look, a false PASS ships broken code.
 *
 * `failed` is the one outcome NOT demoted for lack of evidence. An unevidenced failure is still a
 * refusal to certify, and demoting it would round a "no" up to "did not check" — the wrong
 * direction, by exactly the argument that makes the other demotion right.
 */
export function reconcileAcceptance(items: AcceptanceItem[], text: string): AcceptanceReport {
  const byId = new Map<number, { outcome: AcceptanceOutcome; evidence: string }>();
  const known = new Set(items.map((i) => i.id));
  for (const m of text.matchAll(EVIDENCE_RE)) {
    const id = Number(m[1]);
    if (!known.has(id)) continue;
    const said = { outcome: outcomeOf(m[2]!), evidence: cap(m[3] ?? '', EVIDENCE_CAP) };
    const held = byId.get(id);
    if (held && SEVERITY[held.outcome] >= SEVERITY[said.outcome]) continue;
    byId.set(id, said);
  }
  const entries = items.map((item): AcceptanceEvidence => {
    const said = byId.get(item.id);
    if (!said) {
      return {
        id: item.id,
        outcome: 'behaviour-unverified',
        evidence: 'the gate did not report on this criterion',
        item,
      };
    }
    if (said.outcome === 'verified' && !pointsAtSomething(said.evidence)) {
      return {
        id: item.id,
        outcome: 'behaviour-unverified',
        evidence: `reported verified but pointed at nothing${said.evidence ? ` ("${said.evidence}")` : ''} — recorded as unverified`,
        item,
      };
    }
    return { id: item.id, outcome: said.outcome, evidence: said.evidence, item };
  });
  return { entries };
}

/**
 * Criteria the gate marked FAILED.
 *
 * A report that ends `VERDICT: PASS` while marking a criterion failed contradicts itself, and the
 * daemon resolves that rather than the model — a self-contradictory report read as PASS is the
 * fail-open shape, and "the last line wins" is not a rule anyone chose, it is just which parser
 * ran. The caller turns this into a FAIL.
 */
export const failedAcceptance = (report: AcceptanceReport): AcceptanceEvidence[] =>
  report.entries.filter((e) => e.outcome === 'failed');

/** Criteria nothing established either way. RUN-146's input: these are the gaps a repair spec is
 *  written from, and they are why the report exists at all. */
export const unverifiedAcceptance = (report: AcceptanceReport): AcceptanceEvidence[] =>
  report.entries.filter((e) => e.outcome === 'behaviour-unverified');

/** Criteria that cannot be settled from a workspace at all. Surfaced for the same reason as the
 *  unverified ones and separately from them: this is the one outcome whose whole content is "a
 *  person has to do something", so a run that ends without saying so has lost the request. */
export const humanNeededAcceptance = (report: AcceptanceReport): AcceptanceEvidence[] =>
  report.entries.filter((e) => e.outcome === 'human-needed');

/** Is there anything here a human should be told about, whatever the verdict was? A passing run is
 *  the only place these would otherwise vanish. */
export const acceptanceNeedsAttention = (report: AcceptanceReport): boolean =>
  report.entries.some((e) => e.outcome !== 'verified');

/** One line for a log or a transcript milestone. */
export function acceptanceSummary(report: AcceptanceReport): string {
  const n = (o: AcceptanceOutcome) => report.entries.filter((e) => e.outcome === o).length;
  return `${n('verified')} verified, ${n('failed')} failed, ${n('behaviour-unverified')} unverified, ${n('human-needed')} need a human (of ${report.entries.length})`;
}

const MARK: Record<AcceptanceOutcome, string> = {
  verified: '✅',
  failed: '❌',
  'behaviour-unverified': '⚠️',
  'human-needed': '🙋',
};

/**
 * The report as a human reads it, on a task comment.
 *
 * Unverified and failed criteria come FIRST regardless of their number: a reader scanning a
 * comment is looking for what is wrong, and a list in spec order buries it under whatever
 * happened to be checkable. The numbers are still shown, so the ordering costs no addressability.
 */
export function renderAcceptanceReport(report: AcceptanceReport): string {
  if (!report.entries.length) return '';
  const rank: Record<AcceptanceOutcome, number> = {
    failed: 0,
    'behaviour-unverified': 1,
    'human-needed': 2,
    verified: 3,
  };
  const lines = [...report.entries]
    .sort((a, b) => rank[a.outcome] - rank[b.outcome] || a.id - b.id)
    .map(
      (e) => `- ${MARK[e.outcome]} **${e.id}.** ${e.item.text}${e.evidence ? `\n      ${e.evidence}` : ''}`,
    )
    .join('\n');
  return `**Acceptance criteria** — ${acceptanceSummary(report)}\n\n${lines}`;
}
