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
const REQUIREMENT_CAP = 32;
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

/** Split a requirement bracket into ids. Comma, semicolon or whitespace separated — a model will
 *  use whichever, and rejecting one spelling would silently drop the association. */
const parseRequirements = (raw: string | undefined): string[] => {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(/[,;\s]+/)
        .map((r) => r.trim())
        .filter(Boolean),
    ),
  ]
    .map((r) => cap(r, REQUIREMENT_CAP))
    .slice(0, MAX_REQUIREMENTS);
};

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
 * Keyed on the REQUIREMENT it threatens when the reviewer named one (RUN-147), else on the claim's
 * prose as before. That is the whole point of carrying requirement ids: the prose key is defeated
 * by a paraphrase, and a fresh reviewer paraphrases by construction — it never saw the earlier
 * round's wording. So the builder answered a finding with evidence, the next reviewer restated it
 * differently, the key missed, and the rebuttal was lost. A requirement id survives rewording
 * because it is not wording.
 *
 * Still scoped by LOCATION, not requirement alone: a requirement is usually met in several places
 * and two genuinely different defects against it should stay two findings. The trade when both do
 * land at one location is a re-raise rather than a duplicate — the entry keeps the newest claim, so
 * the builder still reads the current wording, and the earlier adjudication is not silently lost.
 */
const keyOf = (requirements: string[], location: string, claim: string) => {
  const where = location.toLowerCase().trim();
  if (requirements.length) {
    // Sorted, so a reviewer listing the same two requirements in the other order is the same key.
    return `req:${[...requirements]
      .map((r) => r.toLowerCase())
      .sort()
      .join(',')}::${where}`;
  }
  return `${where}::${claim.toLowerCase().trim().slice(0, 60)}`;
};

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
  const indexByKey = new Map(result.map((e, i) => [keyOf(e.requirements ?? [], e.location, e.claim), i]));
  for (const f of findings) {
    const r = byId.get(f.id);
    const entry: LedgerEntry = {
      id: f.id,
      round,
      severity: f.severity,
      requirements: f.requirements,
      location: f.location,
      claim: f.claim,
      status: r?.status ?? 'unanswered',
      pointer: r?.pointer ?? null,
      reason: r?.reason ?? null,
    };
    const key = keyOf(f.requirements, f.location, f.claim);
    const at = indexByKey.get(key);
    if (at !== undefined) result[at] = entry;
    else {
      indexByKey.set(key, result.length);
      result.push(entry);
    }
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
  /** Findings still contested or unanswered — a fixed one is not standing against it. */
  standing: LedgerEntry[];
  /** Findings raised against it and since fixed. Kept because "this was wrong and got fixed" is a
   *  different, more useful statement than silence. */
  fixed: LedgerEntry[];
}

export function requirementOutcomes(requirements: string[], ledger: LedgerEntry[]): RequirementOutcome[] {
  return requirements.map((requirement) => {
    const mine = ledger.filter((e) =>
      (e.requirements ?? []).some((r) => r.toLowerCase() === requirement.toLowerCase()),
    );
    return {
      requirement,
      standing: mine.filter((e) => e.status !== 'fixed'),
      fixed: mine.filter((e) => e.status === 'fixed'),
    };
  });
}

/** The per-requirement summary for a task comment. Empty when the task named no requirements — a
 *  run that was given none has nothing to report against them, and a heading saying so is noise. */
export function renderRequirementOutcomes(outcomes: RequirementOutcome[]): string {
  if (!outcomes.length) return '';
  const lines = outcomes.map((o) => {
    if (o.standing.length) {
      const detail = o.standing
        .map((e) => `\n      ${e.location || '(no location)'} — ${e.claim} [${e.status}]`)
        .join('');
      return `- ❌ **${o.requirement}** — ${o.standing.length} finding(s) still standing${detail}`;
    }
    if (o.fixed.length) return `- ✅ **${o.requirement}** — ${o.fixed.length} finding(s) raised and fixed`;
    // NOT "met". Nobody raised anything against it, which is not the same as anyone checking it.
    return `- ➖ **${o.requirement}** — no finding was raised against it`;
  });
  return `**Requirements** — what the review found, per requirement:\n\n${lines.join('\n')}`;
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
