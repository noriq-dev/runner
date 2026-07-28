// The cross-round adjudication ledger (RUN-79). Every reviewer round is a FRESH, stateless
// session on purpose — a reviewer that watched its own fix arrive would grade its own
// instructions (RUN-61). But total amnesia also erased what was already ADJUDICATED: a run
// re-raised the SAME out-of-scope finding every round (RUN-56), and re-raised a finding the
// builder had answered with concrete evidence TWICE (RUN-59). The builder is told to push back
// with evidence (reviewer-feedback.md) — and the rebuttal never reached the next reviewer, so
// being right changed nothing.
//
// This carries adjudication STATE across rounds without carrying the builder's transcript. The
// contamination rule: the rebuttal enters as verifiable POINTERS (file:line, commit, test),
// never persuasion. A pointer is a fact the next reviewer checks itself; prose is something it
// has to be talked out of. So the reviewer emits NUMBERED findings, the builder answers each in
// a capped structured block, and only those two designated regions are parsed — never the stream.

/** One numbered finding, as the reviewer emits it:
 *  `FINDING <n> [<severity>] [<requirements>] <file:line>: <claim>` — the requirement bracket
 *  optional, because most tasks name no requirements and every finding raised before RUN-147 has
 *  none. */
export interface Finding {
  id: number;
  severity: string;
  /** The requirement ids this finding says are at risk (RUN-147). Empty when the reviewer named
   *  none, which is the whole of the pre-RUN-147 world and every task whose spec has no
   *  `requirementIds`. */
  requirements: string[];
  location: string;
  claim: string;
}

export type FindingStatus = 'fixed' | 'contested';

/** The builder's answer to one finding, from its `FINDING <n>: <STATUS> <pointer> — <reason>` block. */
export interface FindingResponse {
  id: number;
  status: FindingStatus;
  /** file:line / commit / test — a location a reviewer can open, not an argument. */
  pointer: string;
  reason: string;
}

/** One accumulated entry handed to the next reviewer: the finding + the builder's adjudication. */
export interface LedgerEntry {
  id: number;
  /** The round that most recently raised it — a re-raise updates this, it does not duplicate. */
  round: number;
  severity: string;
  /** The requirements this finding threatens (RUN-147) — what makes an entry identifiable across
   *  a reviewer's rewording of it. */
  requirements: string[];
  location: string;
  claim: string;
  /** 'unanswered' when the builder's block named no response for this finding's id. */
  status: FindingStatus | 'unanswered';
  pointer: string | null;
  reason: string | null;
}

// Caps: the ledger is a distilled record, never a transcript by another name. A field longer
// than its cap is truncated, not dropped — a pointer is still checkable truncated.
const SEVERITY_CAP = 24;
const LOCATION_CAP = 120;
const CLAIM_CAP = 240;
const POINTER_CAP = 160;
const REASON_CAP = 200;
/** Room for an external tracker id, which is what a `requirementIds` entry often is. */
const REQUIREMENT_CAP = 64;
/** A finding threatening a dozen requirements has named a theme, not a requirement. */
const MAX_REQUIREMENTS = 6;
/** More entries than this and the run is not converging — carry the most recent and move on. */
const MAX_ENTRIES = 24;

const cap = (s: string, n: number) => {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// `FINDING 1 [High] [R-7] src/init-project.ts:357: detectVcs runs on every init`. The separator
// before the claim is a colon FOLLOWED BY a space, so the colon inside a `file:line` location
// never splits it; the location is non-greedy so it stops at the first such colon-space. Location
// may be empty (a cross-cutting finding). `m` so each finding is its own line; `i` forgives case.
//
// The requirement bracket (RUN-147) is OPTIONAL and sits after the severity, which keeps every
// finding written before it — and every finding on a task that names no requirements — parsing
// byte-identically. A reviewer that ignores the field degrades to the pre-RUN-147 behaviour rather
// than to an unparsed line, which is the only acceptable failure mode for a format a model writes.
const FINDING_RE =
  /^[ \t]*FINDING[ \t]+(\d+)[ \t]*\[([^\]\n]{1,40})\][ \t]*(?:\[([^\]\n]{1,120})\][ \t]*)?([^\n]*?):[ \t]+(.+?)[ \t]*$/gim;

/**
 * Split a requirement bracket into ids, on commas and semicolons ONLY.
 *
 * Not whitespace, though a model will sometimes use it: the contract puts no shape on a
 * `requirementIds` entry (RUN-134), so `Customer login` is a legal id and splitting on spaces would
 * shred it into two that match nothing. A space-separated bracket therefore yields one odd-looking
 * id rather than two good ones — which the run REPORTS as unrecognised instead of dropping, so the
 * mistake is visible rather than silently costing the association.
 */
const parseRequirements = (raw: string | undefined): string[] => {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(/[,;]+/)
        .map((r) => r.trim())
        .filter(Boolean),
    ),
  ]
    .map((r) => cap(r, REQUIREMENT_CAP))
    .slice(0, MAX_REQUIREMENTS);
};

/** A persisted ledger predates this field, and a hand-edited one can hold anything. Normalised on
 *  every read so a malformed record degrades rather than crashing a continuation on `.join`. */
const reqsOf = (e: { requirements?: unknown }): string[] =>
  Array.isArray(e.requirements) ? e.requirements.filter((r): r is string => typeof r === 'string') : [];

/** Extract the reviewer's numbered findings. Anything that does not match the shape is simply
 *  not in the ledger — a reviewer that ignores the format degrades to today's behavior, never
 *  an error. */
export function parseFindings(text: string): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<number>();
  for (const m of text.matchAll(FINDING_RE)) {
    const id = Number(m[1]);
    if (seen.has(id)) continue; // a duplicated number is the reviewer's slip; first wins
    seen.add(id);
    out.push({
      id,
      severity: cap(m[2]!, SEVERITY_CAP),
      requirements: parseRequirements(m[3]),
      location: cap(m[4]!, LOCATION_CAP),
      claim: cap(m[5]!, CLAIM_CAP),
    });
  }
  return out;
}

// `FINDING 1: CONTESTED src/init.ts:164, commit a672b25 — pre-existing, explicit consent`.
// The separator between pointer and reason is ` — ` (em dash) or ` - ` (spaced hyphen), so a
// hyphen inside a path or a range never splits it.
const RESPONSE_RE = /^[ \t]*FINDING[ \t]+(\d+):[ \t]*(FIXED|CONTESTED)\b[ \t]*(.*)$/gim;

/** Extract the builder's per-finding responses from its structured block. Unmatched lines are
 *  ignored; a builder that writes no block yields no responses (the findings then carry into the
 *  ledger as 'unanswered'). */
export function parseFindingResponses(text: string): FindingResponse[] {
  const out: FindingResponse[] = [];
  const seen = new Set<number>();
  for (const m of text.matchAll(RESPONSE_RE)) {
    const id = Number(m[1]);
    if (seen.has(id)) continue;
    seen.add(id);
    const status: FindingStatus = m[2]!.toUpperCase() === 'FIXED' ? 'fixed' : 'contested';
    const rest = m[3]!.trim();
    const sep = rest.search(/\s[—-]\s/);
    const pointer = sep >= 0 ? rest.slice(0, sep) : rest;
    const reason = sep >= 0 ? rest.slice(sep).replace(/^\s*[—-]\s*/, '') : '';
    out.push({ id, status, pointer: cap(pointer, POINTER_CAP), reason: cap(reason, REASON_CAP) });
  }
  return out;
}

/**
 * When two findings across rounds are "the same" — the identity that lets a settled finding stay
 * settled instead of being relitigated under new words.
 *
 * Two rules, tried in order, and the order encodes which mistake is worse. Merging two genuinely
 * different findings destroys one of them: it vanishes from the next reviewer's history and from
 * the run's summary, and nobody learns it existed. Failing to merge a re-raise costs a duplicated
 * row and one round of relitigation — the thing this ledger exists to reduce, but visibly and
 * recoverably. So each rule is allowed to MISS a match; none is allowed to invent one.
 *
 *   1. The PROSE key, unchanged: same location, same first 60 characters of the claim. That is the
 *      whole of the pre-RUN-147 behaviour, and it still catches a reviewer that repeats itself.
 *   2. Failing that, the REQUIREMENT key: a shared requirement id at the same SPECIFIC location.
 *      This is what a paraphrase cannot defeat — a fresh reviewer never saw the earlier wording, so
 *      it restates by construction, and an id is not wording.
 *
 * Rule 2 demands a non-empty location on both sides, and that is not a detail: a cross-cutting
 * finding carries no location, so keying those on the requirement alone would collapse EVERY
 * cross-cutting finding about one requirement into a single row. That is the merge-two-real-things
 * failure at its most likely.
 *
 * What it still cannot do is match across a CHANGE in tagging. A finding tagged in one round and
 * untagged in the next falls back to rule 1, and duplicates if the wording also moved. The prompt
 * asks for consistent tagging and `buildLedger` unions the tags it has seen, which narrows it; the
 * alternative — matching on location alone — is the merge failure again, so this is the limit
 * rather than a gap to close.
 */
const proseKey = (location: string, claim: string) =>
  `${location.toLowerCase().trim()}::${claim.toLowerCase().trim().slice(0, 60)}`;

const shareRequirement = (a: string[], b: string[]) =>
  a.some((x) => b.some((y) => x.toLowerCase() === y.toLowerCase()));

/** The index of the entry this finding re-raises, or -1 for a new one. */
function matchIndex(entries: LedgerEntry[], f: Finding): number {
  const key = proseKey(f.location, f.claim);
  const byProse = entries.findIndex((e) => proseKey(e.location, e.claim) === key);
  if (byProse >= 0) return byProse;
  const where = f.location.trim().toLowerCase();
  if (!f.requirements.length || !where) return -1;
  return entries.findIndex(
    (e) => e.location.trim().toLowerCase() === where && shareRequirement(reqsOf(e), f.requirements),
  );
}

/**
 * Fold one round's findings (⋈ the builder's responses to them) into the running ledger. A
 * finding matching a prior entry REPLACES it — the latest adjudication wins and the entry does
 * not duplicate — otherwise it appends. Bounded to MAX_ENTRIES, keeping the most recent.
 */
export function buildLedger(
  prior: LedgerEntry[],
  findings: Finding[],
  responses: FindingResponse[],
  round: number,
): LedgerEntry[] {
  const byId = new Map(responses.map((r) => [r.id, r]));
  const result = [...prior];
  for (const f of findings) {
    const r = byId.get(f.id);
    const at = matchIndex(result, f);
    const held = at >= 0 ? result[at] : undefined;
    const entry: LedgerEntry = {
      id: f.id,
      round,
      severity: f.severity,
      // UNION with what the entry already carried. A re-raise that drops the tag must not drop the
      // association — the requirement is a fact about the DEFECT, not about this round's wording,
      // and losing it would send the next round's match back to prose.
      requirements: [...new Set([...(held ? reqsOf(held) : []), ...f.requirements])].slice(
        0,
        MAX_REQUIREMENTS,
      ),
      location: f.location,
      claim: f.claim,
      // A re-raise with no response THIS round keeps the answer the builder already gave. Resetting
      // to 'unanswered' would discard the rebuttal this ledger exists to carry — and that path is
      // now the common one, since findings are recorded when RAISED, before a response can exist.
      status: r?.status ?? held?.status ?? 'unanswered',
      pointer: r?.pointer ?? held?.pointer ?? null,
      reason: r?.reason ?? held?.reason ?? null,
    };
    if (at >= 0) result[at] = entry;
    else result.push(entry);
  }
  return result.length > MAX_ENTRIES ? result.slice(-MAX_ENTRIES) : result;
}

/**
 * What the run can say about each requirement when it ends (RUN-147).
 *
 * The run's answer used to be an exit code and a diff, plus prose nobody parses. This is the other
 * half of making it structured evidence: the acceptance report says which CRITERIA were met and on
 * what (RUN-145); this says which REQUIREMENTS still have a finding standing against them and which
 * came through clear.
 *
 * A requirement with no entry is reported as clear, and the wording has to be careful about what
 * that means — no reviewer raised a finding against it, which is not the same as anyone having
 * checked it. Saying "met" here would be the same unevidenced pass RUN-145 exists to refuse.
 */
export interface RequirementOutcome {
  requirement: string;
  /** Findings still standing against it — only meaningful when the gate did NOT clear the work. */
  standing: LedgerEntry[];
  /** Findings raised against it and since resolved. Kept because "this was wrong and got fixed" is
   *  a more useful statement than silence. */
  resolved: LedgerEntry[];
}

export interface RequirementReport {
  outcomes: RequirementOutcome[];
  /** Requirement ids the reviewer named that the spec never declared — a typo, an invented id, or a
   *  space-separated bracket read as one id. Surfaced rather than dropped: silently discarding them
   *  reports "no finding was raised" about a requirement a finding explicitly named, which is the
   *  most confidently wrong thing this summary could say. */
  unrecognised: string[];
}

/**
 * What the run can say about each requirement when it ends (RUN-147).
 *
 * `passed` is not decoration. On a PASS, nothing is standing — the gate looked at the ledger, saw
 * each prior finding and its rebuttal, and cleared the work anyway; that IS the adjudication. A
 * summary that went on reporting a contested finding as an open defect would contradict the verdict
 * of the run that produced it, and it would do so on exactly the runs a human is least likely to
 * read carefully.
 */
export function requirementOutcomes(
  requirements: string[],
  ledger: LedgerEntry[],
  opts: { passed?: boolean } = {},
): RequirementReport {
  const declared = new Set(requirements.map((r) => r.toLowerCase()));
  const outcomes = requirements.map((requirement) => {
    const mine = ledger.filter((e) => reqsOf(e).some((r) => r.toLowerCase() === requirement.toLowerCase()));
    const settled = (e: LedgerEntry) => opts.passed || e.status === 'fixed';
    return {
      requirement,
      standing: mine.filter((e) => !settled(e)),
      resolved: mine.filter(settled),
    };
  });
  const unrecognised = [
    ...new Set(ledger.flatMap((e) => reqsOf(e)).filter((r) => !declared.has(r.toLowerCase()))),
  ];
  return { outcomes, unrecognised };
}

/**
 * The per-requirement summary for a task comment. Empty when the task named no requirements — a run
 * that was given none has nothing to report against them, and a heading saying so is noise.
 *
 * The wording for a requirement nothing was raised against is deliberate and deliberately weak: "no
 * finding was RECORDED against it". Not "met", which would be the unevidenced pass RUN-145 exists to
 * refuse — nobody objecting is not the same as anyone checking. And not "raised" either, because the
 * ledger is bounded (MAX_ENTRIES) and this reads only what survived it.
 */
export function renderRequirementOutcomes(report: RequirementReport): string {
  if (!report.outcomes.length) return '';
  const lines = report.outcomes.map((o) => {
    if (o.standing.length) {
      const detail = o.standing
        .map((e) => `\n      ${e.location || '(no location)'} — ${e.claim} [${e.status}]`)
        .join('');
      return `- ❌ **${o.requirement}** — ${o.standing.length} finding(s) still standing${detail}`;
    }
    if (o.resolved.length)
      return `- ✅ **${o.requirement}** — ${o.resolved.length} finding(s) raised and settled`;
    return `- ➖ **${o.requirement}** — no finding was recorded against it`;
  });
  const stray = report.unrecognised.length
    ? `\n\nThe review also named ${report.unrecognised.map((r) => `\`${r}\``).join(', ')}, which this task does not declare as a requirement — so those findings are not counted above.`
    : '';
  return `**Requirements** — what the review found, per requirement:\n\n${lines.join('\n')}${stray}`;
}

/** Render the ledger as the entry lines for the reviewer's PRIOR ADJUDICATIONS section. The
 *  framing (verify-don't-trust) lives in prompts/reviewer.md — this is only the data. */
export function renderLedger(entries: LedgerEntry[]): string {
  return entries
    .map((e) => {
      const req = e.requirements?.length ? ` {${e.requirements.join(', ')}}` : '';
      const head = `  [round ${e.round}, ${e.severity}]${req} ${e.location || '(no location)'} — ${e.claim}`;
      const status = e.status.toUpperCase();
      const ptr = e.pointer ? ` (${e.pointer})` : '';
      const why = e.reason ? ` — ${e.reason}` : '';
      const answer =
        e.status === 'unanswered'
          ? '      → builder: no response recorded — judge it fresh'
          : `      → builder: ${status}${ptr}${why}`;
      return `${head}\n${answer}`;
    })
    .join('\n');
}
