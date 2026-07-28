// A failing gate hands back a SPECIFICATION, not a critique (RUN-146).
//
// The report a reviewer writes is an argument: here is what I found, here is why it is wrong. That
// is the right shape for a judgement and the wrong shape for the work that follows it, because the
// builder's actual question is "what must be true when I stop?" — and it has to reconstruct that
// from prose, every round, while the daemon already holds the answer as data (RUN-145's
// per-criterion evidence).
//
// So the hand-back leads with the criteria still outstanding and the files they implicate, and the
// report follows as the evidence behind them. The findings stay in full: they are what the builder
// answers number by number (RUN-79's ledger depends on it), and they carry detail a criterion never
// will.
//
// The distinction this exists to make, and the one prose cannot: a `failed` criterion and a
// `behaviour-unverified` one need DIFFERENT work. Failed means the code does not do it — change the
// code. Unverified means nothing established that it does — usually the repair is a test, a run, a
// demonstration, and touching the implementation is the wrong move. Told only "these criteria are
// not satisfied", a builder rewrites working code to satisfy a gate that merely could not see it,
// which costs a round and makes the diff worse. Naming which is which is most of this module's
// value.

import type { AcceptanceEvidence, AcceptanceReport } from './acceptance';
import { failedAcceptance, humanNeededAcceptance, unverifiedAcceptance } from './acceptance';
import type { Finding } from './adjudication';

export interface RepairSpec {
  /** The code does not do what these say. */
  failed: AcceptanceEvidence[];
  /** Nothing established these either way — the repair is usually evidence, not a code change. */
  unverified: AcceptanceEvidence[];
  /** Not reachable from this workspace, so not this round's work. Named so the builder does not
   *  spend the round discovering that for itself. */
  humanNeeded: AcceptanceEvidence[];
  /** How many criteria the gate DID establish. A count, not a list: the builder needs to know it
   *  has standing work to preserve, and re-reading what already passed costs context to say so. */
  verified: number;
  /** Files the findings name — anchors AND the sites cited inside a claim — deduped, in the order
   *  first mentioned. Gathered because the daemon can and the builder would otherwise re-derive it
   *  from prose. */
  files: string[];
  /** How many more the report named than the list carries. Rendered, so a truncated list is never
   *  read as an exhaustive one. */
  filesOmitted: number;
}

/** More than this and the list has stopped being a pointer. A repair touching 20 files is not
 *  scoped by naming them — and when it bites, the render SAYS so, because a truncated list read as
 *  complete is worse than no list. */
const MAX_FILES = 12;

/**
 * `src/land.ts:88` → `src/land.ts`.
 *
 * A location may be a bare path, a `path:line`, a `path:line:col`, or empty (a cross-cutting
 * finding). Line numbers are dropped: they go stale the instant the builder edits, and a stale one
 * reads as precision it does not have.
 *
 * Stripping a trailing `:line` rather than splitting at the FIRST colon, which is what this did and
 * was wrong in two directions at once — it reduced a Windows path to its drive letter (`C:\a.ts:12`
 * → `C`) and truncated any Unix filename that legitimately contains one. Spaces are allowed for the
 * same reason: a path with a space is a path, and rejecting it silently drops a real citation.
 */
function fileOf(location: string): string | null {
  const trimmed = location.trim().replace(/^[`'"([]+|[`'")\]]+$/g, '');
  if (!trimmed) return null;
  const path = trimmed.replace(/(?::\d+){1,2}$/, '').trim();
  if (!path) return null;
  // A separator makes it a path. Failing that, an ALPHABETIC extension does — which keeps `a.ts`
  // and rejects a version number (`v1.2`), where a looser `[/.]` test accepted prose.
  return /[/\\]/.test(path) || /\.[a-z]{1,8}$/i.test(path) ? path : null;
}

/**
 * Paths cited inside a finding's CLAIM, not just at its anchor.
 *
 * RUN-79 asks a reviewer to collapse an invariant into ONE numbered finding, anchored where it is
 * clearest and citing the other leak sites inside that same line. Reading only the anchor therefore
 * lists exactly one file for the finding shape that touches the most — the opposite of what a
 * scoping list is for.
 *
 * Stricter than `fileOf` on purpose: this scans prose, so only a token containing a `/` counts. A
 * bare filename mentioned in a sentence is missed, which is the safe direction — the alternative
 * turns "e.g." and a version number into files the builder is told to go and look at.
 */
const CITED_PATH = /[\w.\-@]+(?:\/[\w.\-@]+)+(?::\d+){0,2}/g;
function citedPaths(claim: string): string[] {
  return [...claim.matchAll(CITED_PATH)].map((m) => fileOf(m[0])).filter((p): p is string => p !== null);
}

/**
 * What is left to do, from what the gate established.
 *
 * Takes the criteria and the findings SEPARATELY rather than trying to join them: a finding names a
 * defect at a line and a criterion names an outcome, and nothing in either says which finding
 * threatens which criterion. Guessing that mapping would put a confident, wrong association in
 * front of the builder — RUN-147 is where requirement ids make the join real.
 */
export function buildRepairSpec(
  report: AcceptanceReport | undefined,
  findings: Finding[],
): RepairSpec | null {
  const files: string[] = [];
  for (const f of findings) {
    for (const path of [fileOf(f.location), ...citedPaths(f.claim)]) {
      if (path && !files.includes(path)) files.push(path);
    }
  }
  const spec: RepairSpec = {
    failed: report ? failedAcceptance(report) : [],
    unverified: report ? unverifiedAcceptance(report) : [],
    humanNeeded: report ? humanNeededAcceptance(report) : [],
    verified: report ? report.entries.filter((e) => e.outcome === 'verified').length : 0,
    files: files.slice(0, MAX_FILES),
    filesOmitted: Math.max(0, files.length - MAX_FILES),
  };
  // No outstanding CRITERION, no specification — the hand-back is the report alone, exactly as it
  // was. A run whose task carries no acceptance criteria is the common case and must not gain a
  // block telling it so, and the file list cannot carry one on its own: every FINDING line the
  // builder is about to read already names its file, so a bare list under a heading about the
  // definition of done would be duplication wearing an authority it does not have. With criteria
  // it earns its place by SCOPING them.
  const outstanding = spec.failed.length + spec.unverified.length + spec.humanNeeded.length;
  return outstanding ? spec : null;
}

const list = (items: AcceptanceEvidence[]): string =>
  items.map((e) => `  ${e.id}. ${e.item.text}\n     the gate said: ${e.evidence}`).join('\n');

/**
 * The repair spec as the builder reads it.
 *
 * Ordered by what it is most likely to get wrong rather than by severity: the unverified block
 * carries the instruction that saves a round, so it is stated as its own thing rather than folded
 * into a list of "unsatisfied criteria" the builder will read as "broken code".
 */
export function renderRepairSpec(spec: RepairSpec): string {
  const parts: string[] = [];
  if (spec.failed.length) {
    parts.push(
      `NOT SATISFIED — the gate established that the work does not do these. Change the code:\n${list(spec.failed)}`,
    );
  }
  if (spec.unverified.length) {
    // The trap in the obvious wording, and it is not hypothetical: "add a test that covers it" is
    // satisfied by a characterization test asserting whatever the code does today. That closes the
    // criterion, passes the next gate, and ships the bug with a green test guarding it — a worse
    // outcome than leaving it unverified, because now nobody will look again. So the evidence is
    // specified by what it must DEMONSTRATE, and the failing case is named as the thing that makes
    // it evidence at all.
    const why =
      'NOT ESTABLISHED — the gate could not confirm these either way. This is usually NOT a code defect: the implementation may be perfectly correct and simply have nothing exercising it, so prefer making it demonstrable over changing code that may already be right. Evidence means something that shows the criterion HOLDS as written — a test asserting the result the criterion states, and which would fail if the code stopped producing it. A test that merely records what the code does today is not evidence; it closes the criterion while guarding the bug, which is worse than leaving it open. If writing that test shows the work does not actually satisfy the criterion, then it IS a defect: fix the code, and say so.';
    parts.push(`${why}\n${list(spec.unverified)}`);
  }
  if (spec.humanNeeded.length) {
    parts.push(
      `NOT YOURS THIS ROUND — the gate judged these unreachable from this workspace. Do not spend the round on them; they are recorded for a human:\n${list(spec.humanNeeded)}`,
    );
  }
  if (spec.verified) {
    parts.push(
      `${spec.verified} other criteri${spec.verified === 1 ? 'on is' : 'a are'} already satisfied. Do not break ${spec.verified === 1 ? 'it' : 'them'} getting to the rest — the next gate checks all of them again, not just these.`,
    );
  }
  if (spec.files.length) {
    const more = spec.filesOmitted ? `, and ${spec.filesOmitted} more it names beyond these` : '';
    parts.push(`Files the report names: ${spec.files.join(', ')}${more}`);
  }
  if (!parts.length) return '';
  return `WHAT IS STILL OUTSTANDING — the definition of done, minus what the gate confirmed. This is the specification for this round; the report below is the evidence behind it.\n\n${parts.join('\n\n')}`;
}
