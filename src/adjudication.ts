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

/** One numbered finding, as the reviewer emits it: `FINDING <n> [<severity>] <file:line>: <claim>`. */
export interface Finding {
  id: number;
  severity: string;
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
/** More entries than this and the run is not converging — carry the most recent and move on. */
const MAX_ENTRIES = 24;

const cap = (s: string, n: number) => {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// `FINDING 1 [High] src/init-project.ts:357: detectVcs runs on every init`. The separator
// before the claim is a colon FOLLOWED BY a space, so the colon inside a `file:line` location
// never splits it; the location is non-greedy so it stops at the first such colon-space. Location
// may be empty (a cross-cutting finding). `m` so each finding is its own line; `i` forgives case.
const FINDING_RE = /^[ \t]*FINDING[ \t]+(\d+)[ \t]*\[([^\]\n]{1,40})\][ \t]*([^\n]*?):[ \t]+(.+?)[ \t]*$/gim;

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
      location: cap(m[3]!, LOCATION_CAP),
      claim: cap(m[4]!, CLAIM_CAP),
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

/** Two findings are "the same" across rounds when they point at the same place and say the same
 *  thing — so a re-raise updates the existing entry instead of duplicating it, which is what lets
 *  a settled finding stay settled. */
const keyOf = (location: string, claim: string) =>
  `${location.toLowerCase().trim()}::${claim.toLowerCase().trim().slice(0, 60)}`;

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
  const indexByKey = new Map(result.map((e, i) => [keyOf(e.location, e.claim), i]));
  for (const f of findings) {
    const r = byId.get(f.id);
    const entry: LedgerEntry = {
      id: f.id,
      round,
      severity: f.severity,
      location: f.location,
      claim: f.claim,
      status: r?.status ?? 'unanswered',
      pointer: r?.pointer ?? null,
      reason: r?.reason ?? null,
    };
    const key = keyOf(f.location, f.claim);
    const at = indexByKey.get(key);
    if (at !== undefined) result[at] = entry;
    else {
      indexByKey.set(key, result.length);
      result.push(entry);
    }
  }
  return result.length > MAX_ENTRIES ? result.slice(-MAX_ENTRIES) : result;
}

/** Render the ledger as the entry lines for the reviewer's PRIOR ADJUDICATIONS section. The
 *  framing (verify-don't-trust) lives in prompts/reviewer.md — this is only the data. */
export function renderLedger(entries: LedgerEntry[]): string {
  return entries
    .map((e) => {
      const head = `  [round ${e.round}, ${e.severity}] ${e.location || '(no location)'} — ${e.claim}`;
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
