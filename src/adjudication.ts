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

/** One separately-answerable claim inside a collapsed finding (RUN-180), from a
 *  `FINDING <n><letter>: <claim>` line under the numbered FINDING line. NOT an instance list:
 *  instances of one root cause stay evidence inside a single claim — a sub-claim is a claim that
 *  could be true while its siblings are false, which is what makes it answerable on its own. */
export interface SubClaim {
  /** The single letter the RESPONSE side names it by — `FINDING 1a: CONTESTED …`. */
  letter: string;
  claim: string;
}

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
  /** The finding's enumerated separately-answerable claims (RUN-180). Empty for every finding that
   *  enumerates none — the whole of the pre-RUN-180 world — which keeps the finding one answerable
   *  unit, exactly as before. */
  subclaims: SubClaim[];
}

export type FindingStatus = 'fixed' | 'contested';

/** The builder's answer to one finding, from its `FINDING <n>: <STATUS> <pointer> — <reason>` block. */
export interface FindingResponse {
  id: number;
  /** The sub-claim letter this response answers (RUN-180) — `FINDING 1a: …` — or null for the
   *  whole-finding form, which is every response written before sub-claims existed. */
  subclaim: string | null;
  status: FindingStatus;
  /** file:line / commit / test — a location a reviewer can open, not an argument. */
  pointer: string;
  reason: string;
}

/** A sub-claim as the ledger carries it: the claim plus the builder's answer TO THAT CLAIM, so a
 *  half-rebutted finding reads as half-rebutted instead of as answered-as-a-whole (RUN-180). */
export interface AdjudicatedSubClaim extends SubClaim {
  status: FindingStatus | 'unanswered';
  pointer: string | null;
  reason: string | null;
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
  /** 'unanswered' when the builder's block named no response for this finding's id. On an entry
   *  with sub-claims this is only the WHOLE-FINDING answer — per-sub-claim adjudication lives in
   *  `subclaims`, and a bare `FINDING <n>` response is recorded here without crediting any of them
   *  (RUN-180): answering the half you can refute must not read as answering the whole. */
  status: FindingStatus | 'unanswered';
  pointer: string | null;
  reason: string | null;
  /** The enumerated sub-claims with their own answers (RUN-180). Empty on every entry whose
   *  finding enumerated none — the pre-RUN-180 world, which folds, matches, and renders exactly
   *  as it always did. */
  subclaims: AdjudicatedSubClaim[];
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
/** A finding needing more than a handful of separately-answerable claims is several findings — or
 *  an instance list wearing letters, which is the enumeration RUN-89/90 bought out (RUN-180).
 *  Unlike MAX_REQUIREMENTS this cap DROPS the whole enumeration rather than slicing it: a kept
 *  (a)–(d) beside a silently cut (e) would let the terminal contest clear the finding on four
 *  contests while the fifth claim was never even recorded — the RUN-174 escape reborn one level
 *  down. See parseFindings: enumeration is all-or-nothing, the RUN-148 steps precedent. */
const MAX_SUBCLAIMS = 4;
/** What one round may ENUMERATE is MAX_SUBCLAIMS; what an entry may ACCUMULATE is this — a
 *  re-raise that repeats only some held letters must not DROP the rest (see buildLedger), so the
 *  reconciled set can outgrow one round's cap. Still a hard cap ("never a transcript by another
 *  name"), and like MAX_SUBCLAIMS it never slices: a union it cannot hold keeps the HELD set
 *  whole and drops the new enumeration, because a kept subset is the escape (RUN-148 shape). */
const MAX_LEDGER_SUBCLAIMS = 8;
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

// `FINDING 1a: the eligibility gate accepts a response naming a nonexistent finding` — a
// sub-claim line under its numbered FINDING line (RUN-180). Its OWN line rather than an inline
// list on the FINDING line, so a sub-claim never fights the claim for room under CLAIM_CAP and
// prose parentheses cannot fake one. Invisible to FINDING_RE (no severity bracket) and to
// RESPONSE_RE as it stood (a letter where the colon must be), so every report and every response
// written before this parses byte-identically.
//
// Normalisation is ALL-OR-NOTHING per finding. The candidacy gate asks "was every sub-claim
// contested?", and it can only ask that of the sub-claims that were RECORDED — so keeping the
// well-formed half of a bad enumeration would let a finding clear on the letters that parsed
// while a malformed sibling was never even entered, the exact escape this format exists to close.
//
// Which is why there is no malformed-label DETECTOR here. Detection is enumerating the shapes a
// model might malform a letter into, and every edition of that list leaked at its next edge:
// single-letter matching missed `1aa`, letters-hard-against-the-number missed the spaced `1 b:`, a
// separator allowlist missed the parenthesized `1(b):`, a junk class with a `\b` missed `1b_:` and
// `1b2:` — each time the unseen sibling left the valid letters standing as the "complete"
// enumeration. So nothing is enumerated. A line is CLASSIFIED exactly once (see parseFindings)
// when either of two structural nets sees it, and then it is one of three things: the numbered
// FINDING line itself, a strict sub-claim line, or — everything else — a voider of that finding's
// whole enumeration. The strict shape is the only allowlist, and a shape that cannot be mistaken
// for it simply does not exist.
//
// Net one — the HEAD: any line whose FIRST LETTERS are `FINDING <n>`. The prefix may be ANY run
// of non-letter characters, because markdown decoration is exactly that — `- FINDING 1b:`,
// `> FINDING 1b:`, `**FINDING 1b:**`, `2. FINDING 1b:` are each a lettered-INTENT line a
// whitespace-only anchor could not see, and an unseen sibling leaves the valid letters standing
// as the "complete" enumeration (the kept-subset escape through the anchor itself).
//
// Net two — the NEAR-COLON TOKEN: `FINDING <n>` followed by a colon within a few characters,
// ANYWHERE in the line. This is what catches decoration that wears letters — `(b) FINDING 1b:`
// slips the head net because its prefix contains a letter, and any list-marker vocabulary
// (`(b)`, `ii.`, `Note:`) is an enumerable set that would leak at its next member. A colon hard
// by the token is label-intent; a colon further on is sentence structure. The window also covers
// a mutated label under the decoration (`(b) FINDING 1 b:`, `(b) FINDING 1(b):`), so the two
// escapes do not compose within it.
//
// The boundary's other side is equally deliberate: a MID-SENTENCE mention (`…described in
// FINDING 1.`, `see FINDING 1 for the full chain: …`) has words before the token and no colon
// beside it, and never voids — reports narrate their findings by number, so voiding on mention
// would kill every enumeration in any report that explains itself. The residue this leaves —
// word-prefixed decoration whose label ALSO pushed the colon out of the window, or replaced it —
// is indistinguishable from prose by any rule that spares prose, and reads as prose: it records
// nothing, which on its own can clear nothing. The report's own `ESCALATE STRUCTURAL FINDING <n>:`
// line is the one format-legal shape net two would see, and is exempted by its exact prefix.
//
// The deliberate cost is prose at line start or with a colon by the number: `FINDING 1 rests…`
// or `as FINDING 1: the gate…` voids finding 1's enumeration, degrading it to the single-claim
// finding it always was — which is current behaviour, and always a correct way to record it (the
// RUN-148 steps rule: a decomposition that cannot be run soundly is dropped, never half-run). A
// lost enumeration is a duller report; a kept subset is the escape. Legacy reports are untouched
// by construction: their only classified lines are the numbered finding lines themselves
// (skipped as such) and prose, which voids an enumeration no legacy finding has.
const HEAD_LINE_RE = /^[^a-zA-Z\n]*FINDING[ \t]+(\d+)/i;
const NEAR_COLON_TOKEN_RE = /\bFINDING[ \t]+(\d+)[^:\n]{0,8}:/gi;
const ESCALATE_LINE_RE = /^[ \t]*ESCALATE[ \t]+STRUCTURAL[ \t]+FINDING\b/i;
/** FINDING_RE's shape, single-line and stateless, for classifying one already-extracted line. */
const FINDING_LINE_RE = new RegExp(FINDING_RE.source, 'i');
const SUBCLAIM_SHAPE_RE = /^[ \t]*FINDING[ \t]+(\d+)([a-z])[ \t]*:[ \t]+(.+?)[ \t]*$/i;

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

/** Same contract for sub-claims (RUN-180): a ledger persisted before they existed — every park and
 *  continuation seed until now — reads as single-claim entries, and a hand-edited record degrades
 *  field by field rather than crashing. Exported because the terminal-contest candidacy check in
 *  the supervisor reads entries the same way — never trusted from the object. */
export const subclaimsOf = (e: { subclaims?: unknown }): AdjudicatedSubClaim[] =>
  Array.isArray(e.subclaims)
    ? e.subclaims
        .filter(
          (s): s is Record<string, unknown> & { letter: string; claim: string } =>
            typeof s === 'object' &&
            s !== null &&
            typeof (s as { letter?: unknown }).letter === 'string' &&
            typeof (s as { claim?: unknown }).claim === 'string',
        )
        .slice(0, MAX_LEDGER_SUBCLAIMS)
        .map((s) => ({
          letter: s.letter,
          claim: s.claim,
          status: s.status === 'fixed' || s.status === 'contested' ? s.status : 'unanswered',
          pointer: typeof s.pointer === 'string' ? s.pointer : null,
          reason: typeof s.reason === 'string' ? s.reason : null,
        }))
    : [];

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
      subclaims: [],
    });
  }
  // Second pass (RUN-180): attach sub-claim lines to the finding their number names. Keyed by
  // number rather than by position, so prose between the lines cannot orphan one. A line naming a
  // finding nobody numbered is ignored — there is no finding to degrade.
  //
  // Per finding, all-or-nothing, by classifying once every line either structural net sees — the
  // HEAD net (first letters are `FINDING <n>`, so letterless markdown decoration is included) and
  // the NEAR-COLON TOKEN net (`FINDING <n>…:` anywhere in the line, so decoration wearing letters
  // is included): the numbered FINDING line itself is pass 1's subject; a strict sub-claim line
  // records its letter; and ANY other classified line — a decorated label, a spaced or punctuated
  // letter, a doubled letter, a trailing `_` or digit, a duplicated letter (the RESPONSE side
  // could not say which claim it answered), a fifth letter (the cap), line-start prose — voids
  // the WHOLE enumeration (`null` below) and the finding stays single-claim. Never an error, and
  // never a kept subset a partial contest could clear. The strict-shape checks compare the NUMBER
  // too: a sub-claim line of finding 2 that mentions `FINDING 1:` in its claim is strict for 2
  // and a voider for 1 — never a recorder of either's letters onto the other.
  const byId = new Map(out.map((f) => [f.id, f]));
  const pending = new Map<number, SubClaim[] | null>();
  for (const line of text.split('\n')) {
    if (ESCALATE_LINE_RE.test(line)) continue; // the format's own escalation line; letters nothing, voids nothing
    const ids = new Set<number>();
    const head = HEAD_LINE_RE.exec(line);
    if (head) ids.add(Number(head[1]));
    for (const t of line.matchAll(NEAR_COLON_TOKEN_RE)) ids.add(Number(t[1]));
    for (const id of ids) {
      if (!byId.has(id)) continue;
      const asFinding = FINDING_LINE_RE.exec(line);
      if (asFinding && Number(asFinding[1]) === id) continue; // the numbered FINDING line — pass 1's subject
      const list = pending.get(id);
      if (list === null) continue; // already voided — one bad line spoils the set, not just itself
      const shaped = SUBCLAIM_SHAPE_RE.exec(line);
      const letter = shaped && Number(shaped[1]) === id ? shaped[2]?.toLowerCase() : undefined;
      const held = list ?? [];
      if (!letter || held.some((s) => s.letter === letter) || held.length >= MAX_SUBCLAIMS) {
        pending.set(id, null);
        continue;
      }
      held.push({ letter, claim: cap(shaped![3]!, CLAIM_CAP) });
      pending.set(id, held);
    }
  }
  for (const [id, subs] of pending) if (subs) byId.get(id)!.subclaims = subs;
  return out;
}

// `FINDING 1: CONTESTED src/init.ts:164, commit a672b25 — pre-existing, explicit consent`.
// The separator between pointer and reason is ` — ` (em dash) or ` - ` (spaced hyphen), so a
// hyphen inside a path or a range never splits it.
//
// The sub-claim letter (RUN-180) is OPTIONAL and sits between the number and the colon —
// `FINDING 1a: CONTESTED …` answers sub-claim (a) alone. Positionally additive, so every response
// written without one parses byte-identically as the whole-finding form it always was.
const RESPONSE_RE = /^[ \t]*FINDING[ \t]+(\d+)([a-z])?:[ \t]*(FIXED|CONTESTED)\b[ \t]*(.*)$/gim;

/** Extract the builder's per-finding responses from its structured block. Unmatched lines are
 *  ignored; a builder that writes no block yields no responses (the findings then carry into the
 *  ledger as 'unanswered'). */
export function parseFindingResponses(text: string): FindingResponse[] {
  const out: FindingResponse[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(RESPONSE_RE)) {
    const id = Number(m[1]);
    const subclaim = m[2]?.toLowerCase() ?? null;
    // Keyed by number AND letter (RUN-180): `FINDING 1a` and `FINDING 1b` are two answers, and a
    // bare `FINDING 1` beside them is a third — the whole-finding form, deduped as it always was.
    const key = `${id}${subclaim ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const status: FindingStatus = m[3]!.toUpperCase() === 'FIXED' ? 'fixed' : 'contested';
    const rest = m[4]!.trim();
    const sep = rest.search(/\s[—-]\s/);
    const pointer = sep >= 0 ? rest.slice(0, sep) : rest;
    const reason = sep >= 0 ? rest.slice(sep).replace(/^\s*[—-]\s*/, '') : '';
    out.push({
      id,
      subclaim,
      status,
      pointer: cap(pointer, POINTER_CAP),
      reason: cap(reason, REASON_CAP),
    });
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
  // The whole-finding form and the per-sub-claim form are two different answers (RUN-180): a bare
  // `FINDING 1` folds onto the entry, a `FINDING 1a` onto sub-claim (a) alone — crediting one to
  // the other is exactly the answered-as-a-whole read this split exists to stop.
  const byId = new Map(responses.filter((r) => !r.subclaim).map((r) => [r.id, r]));
  const bySub = new Map(responses.filter((r) => r.subclaim).map((r) => [`${r.id}${r.subclaim}`, r]));
  // A carried sub-claim answer matches on the claim's FULL wording, not the entry key's 60-char
  // prefix and not the letter. A prefix aliases two long claims that diverge past it — both would
  // inherit one rebuttal, answering a claim nobody answered — and a letter is one reviewer's
  // ordering, not the claim's identity. Full wording may MISS a paraphrase (the sub-claim reads as
  // unanswered, visibly, and the builder can answer again); it cannot INVENT a match, which is the
  // failure the whole ledger refuses.
  //
  // …which is also why a TRUNCATED claim never carries: cap() marks truncation with a trailing
  // ellipsis, and two distinct over-cap claims cap to the same text — so a key ending in one is a
  // prefix wearing an identity, the aliasing above through the cap instead of the slice. Skipping
  // it costs a visibly unanswered sub-claim on a claim longer than CLAIM_CAP; matching it answers
  // a claim nobody answered.
  const subKey = (c: string) => c.toLowerCase().trim();
  const carriedFrom = (held: AdjudicatedSubClaim[], claim: string): AdjudicatedSubClaim | undefined => {
    const key = subKey(claim);
    if (key.endsWith('…')) return undefined;
    return held.find((h) => subKey(h.claim) === key);
  };
  const nextFreeLetter = (used: Set<string>): string | undefined => {
    for (let c = 97; c <= 122; c++) {
      const l = String.fromCharCode(c);
      if (!used.has(l)) return l;
    }
    return undefined;
  };
  // This round's enumeration wins its own framing (the latest wording, like the claim itself) —
  // but it must not LOSE what the entry already holds. A re-raise that repeats only SOME of the
  // held letters used to replace the set wholesale, so a held unanswered claim vanished exactly
  // when the terminal round enumerated the letters it cared about — and the candidacy gate can
  // only keep standing what was RECORDED: the RUN-174 escape through the fold itself. So held
  // claims the new wording does not cover are UNIONED in beside the new set, keeping their
  // adjudication. Two deliberate asymmetries:
  //   - a held CONTESTED claim the re-raise abandoned is dropped: the reviewer no longer asserts
  //     it and the builder had rebutted it, so keeping it bloats the record and dropping it can
  //     clear nothing (a contested letter only ever counted toward clearing). Unanswered and
  //     FIXED letters — the ones whose loss would flip a finding clearable — always carry.
  //   - coverage is the claim's full wording (the carry key), so a reworded survivor rides as a
  //     duplicate row rather than being merged away — may MISS, never INVENT — and a truncated
  //     (ellipsis-capped) key never counts as covering, for the same aliasing reason carriedFrom
  //     refuses it.
  // A carried claim keeps its letter when this round's set left it free — the builder saw that
  // letter in the ledger and an answer naming it now still credits it — and is re-lettered when
  // taken, in which case no response is credited (the old letter now names this round's claim;
  // crediting either way would be inventing). A union past MAX_LEDGER_SUBCLAIMS keeps the HELD
  // set whole and drops the new enumeration — all-or-nothing, never a sliced subset.
  //
  // Crediting a held letter holds on EVERY path that preserves held sub-claims, not just the
  // union: a letterless re-raise and the union-overflow fallback keep the held set, and the
  // builder — told a standing letter stays answerable BY its letter — may be answering it this
  // very turn. Losing that response would discard a valid current adjudication, the thing the
  // ledger exists to carry. The one exclusion is a letter this round's enumeration re-used: the
  // response then names the report in front of the builder, and crediting the held claim too
  // would be inventing.
  const mergedSubclaims = (f: Finding, heldSubs: AdjudicatedSubClaim[]): AdjudicatedSubClaim[] => {
    const claimed = new Set(f.subclaims.map((sc) => sc.letter));
    const creditHeld = (subs: AdjudicatedSubClaim[]): AdjudicatedSubClaim[] =>
      subs.map((h) => {
        const rs = claimed.has(h.letter) ? undefined : bySub.get(`${f.id}${h.letter}`);
        return rs
          ? { letter: h.letter, claim: h.claim, status: rs.status, pointer: rs.pointer, reason: rs.reason }
          : h;
      });
    // A re-raise that dropped the letters entirely keeps the held sub-claims AND their answers,
    // the same preservation the whole-finding status gets below.
    if (!f.subclaims.length) return creditHeld(heldSubs);
    const mapped = f.subclaims.map((sc) => {
      const rs = bySub.get(`${f.id}${sc.letter}`);
      const carried = carriedFrom(heldSubs, sc.claim);
      return {
        letter: sc.letter,
        claim: sc.claim,
        status: rs?.status ?? carried?.status ?? ('unanswered' as const),
        pointer: rs?.pointer ?? carried?.pointer ?? null,
        reason: rs?.reason ?? carried?.reason ?? null,
      };
    });
    const used = new Set(mapped.map((s) => s.letter));
    const covered = new Set(mapped.map((s) => subKey(s.claim)).filter((k) => !k.endsWith('…')));
    const extras: AdjudicatedSubClaim[] = [];
    for (const h of heldSubs) {
      if (h.status === 'contested' || covered.has(subKey(h.claim))) continue;
      covered.add(subKey(h.claim));
      const keepLetter = !used.has(h.letter);
      const rs = keepLetter ? bySub.get(`${f.id}${h.letter}`) : undefined;
      const letter = keepLetter ? h.letter : nextFreeLetter(used);
      // No letter left to carry it losslessly — the held set stands, with this turn's answers.
      if (!letter) return creditHeld(heldSubs);
      used.add(letter);
      extras.push({
        letter,
        claim: h.claim,
        status: rs?.status ?? h.status,
        pointer: rs?.pointer ?? h.pointer,
        reason: rs?.reason ?? h.reason,
      });
    }
    const union = [...mapped, ...extras];
    return union.length > MAX_LEDGER_SUBCLAIMS ? creditHeld(heldSubs) : union;
  };
  const result = [...prior];
  for (const f of findings) {
    const r = byId.get(f.id);
    const at = matchIndex(result, f);
    const held = at >= 0 ? result[at] : undefined;
    const heldSubs = held ? subclaimsOf(held) : [];
    const subclaims: AdjudicatedSubClaim[] = mergedSubclaims(f, heldSubs);
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
      subclaims,
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
/** What a sub-claimed entry's answers amount to as ONE adjudication (RUN-180): every letter fixed
 *  is fixed; every letter answered but any contested is contested; any letter unanswered leaves
 *  the whole unanswered — an answer in halves must not settle the finding, and a bare
 *  whole-finding response never overrides the letters (crediting it to them is the escape).
 *  An entry without sub-claims keeps its recorded status: the whole pre-RUN-180 world. */
const effectiveStatus = (e: LedgerEntry): FindingStatus | 'unanswered' => {
  const subs = subclaimsOf(e);
  if (!subs.length) return e.status;
  if (subs.some((s) => s.status === 'unanswered')) return 'unanswered';
  return subs.every((s) => s.status === 'fixed') ? 'fixed' : 'contested';
};

export function requirementOutcomes(
  requirements: string[],
  ledger: LedgerEntry[],
  opts: { passed?: boolean } = {},
): RequirementReport {
  const declared = new Set(requirements.map((r) => r.toLowerCase()));
  const outcomes = requirements.map((requirement) => {
    const mine = ledger.filter((e) => reqsOf(e).some((r) => r.toLowerCase() === requirement.toLowerCase()));
    // Settlement reads the RECONCILED state, not the raw field (RUN-180): a finding whose every
    // sub-claim came back FIXED is resolved even though no bare response ever set `status`.
    const settled = (e: LedgerEntry) => opts.passed || effectiveStatus(e) === 'fixed';
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
      // A sub-claimed entry says WHICH claims stand (RUN-180) — `[unanswered]` on the whole row is
      // the wording that hid the RUN-174 escape, where the answered half spoke for the silent one.
      const state = (e: LedgerEntry) => {
        const subs = subclaimsOf(e);
        if (!subs.length) return `[${e.status}]`;
        return `[sub-claims: ${subs.map((s) => `(${s.letter}) ${s.status}`).join(', ')}]`;
      };
      const detail = o.standing
        .map((e) => `\n      ${e.location || '(no location)'} — ${e.claim} ${state(e)}`)
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
      // A partially answered finding renders sub-claim by sub-claim (RUN-180): the one that STANDS
      // is named rather than absorbed into its siblings' answer. A whole-finding response is shown
      // too when one was recorded — it is evidence — but it speaks for no lettered claim.
      const subs = subclaimsOf(e);
      if (!subs.length) return `${head}\n${answer}`;
      const subLines = subs.map((s) => {
        const sPtr = s.pointer ? ` (${s.pointer})` : '';
        const sWhy = s.reason ? ` — ${s.reason}` : '';
        const sAnswer =
          s.status === 'unanswered'
            ? 'no response recorded — this sub-claim STANDS; judge it fresh'
            : `${s.status.toUpperCase()}${sPtr}${sWhy}`;
        return `      (${s.letter}) ${s.claim}\n          → builder: ${sAnswer}`;
      });
      const whole =
        e.status === 'unanswered'
          ? []
          : [`      → builder, on the finding as a whole (credits no sub-claim): ${status}${ptr}${why}`];
      return [head, ...whole, ...subLines].join('\n');
    })
    .join('\n');
}
