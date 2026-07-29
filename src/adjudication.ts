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
  /** The finding's enumerated separately-answerable claims (RUN-180), from the strict
   *  `FINDING <n><letter>: <claim>` lines under the numbered FINDING line, in report order. NOT an
   *  instance list: instances of one root cause stay evidence inside a single claim — a sub-claim
   *  is a claim that could be true while its siblings are false, which is what makes it answerable
   *  on its own. A sub-claim's identity is its claim TEXT (this run's structural settlement): the
   *  letters are positional labels of the report they appeared in — the parse enforces a, b, c… in
   *  order, so a claim's letter IS its index here — and they die at the parse boundary; nothing
   *  downstream stores or reconciles one. Empty for every finding that enumerates none — the whole
   *  of the pre-RUN-180 world — which keeps the finding one answerable unit, exactly as before. */
  subclaims: string[];
}

/** The letter that labels sub-claim `i` wherever one is rendered or read — the ONE derivation
 *  (RUN-180): report lines carry it by parse rule, renders derive it from position, and a RESPONSE
 *  letter resolves back through it to the claim text that is the sub-claim's actual identity. */
export const subclaimLetter = (i: number): string => String.fromCharCode(97 + i);

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
 *  half-rebutted finding reads as half-rebutted instead of as answered-as-a-whole (RUN-180).
 *  Deliberately NO letter field: a letter is one report's positional label, not the claim's
 *  identity, and persisting one is what let eight generations of letter-set reconciliation leak
 *  (this run's structural settlement). Renders re-derive letters from position. */
export interface AdjudicatedSubClaim {
  claim: string;
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

/** A sub-claim's identity: its normalized claim TEXT (the structural settlement). Everything that
 *  matches, carries, or credits a sub-claim across rounds keys on this — never on a letter. */
const subKey = (c: string) => c.toLowerCase().trim();
/** A TRUNCATED claim is a prefix wearing an identity: cap() marks truncation with a trailing
 *  ellipsis, and two distinct over-cap claims cap to the same text — so a capped key may never
 *  match across sets. The cost is a visibly unanswered sub-claim on an over-long claim — a miss,
 *  never an invention, which is the order of harms the whole ledger obeys. */
const carryable = (k: string) => !k.endsWith('…');

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
// The rule that actually closes that escape is the COMPLETENESS DECLARATION, not any shape rule: a
// FINDING line that enumerates must end its claim with `[sub-claims: <n>]`, and the enumeration is
// kept only when EXACTLY n strict lettered lines arrive. Shape nets (below) can only void what
// they can SEE, and a mangled line can compose decoration, spacing, and separator loss into a
// shape indistinguishable from English — `(b) FINDING 1 b — claim B` is invisible to every net
// that spares prose, and each review round of this run's own gestation found another such
// composition. The declaration voids by ABSENCE instead: a line that mangles into ANY shape
// whatsoever — visible or not — subtracts from the strict count, mismatches the certificate, and
// the whole enumeration degrades to the single-claim finding. No declaration → no enumeration
// (letters without a certificate are never kept); a mangled declaration fails to parse as one and
// lands in the same place. The residue is no longer a parser hole but authorial incoherence: a
// kept subset now requires the reviewer to certify the subset as complete — to declare a count
// that excludes a line it wrote — which no shape can produce on its own.
//
// The shape nets below remain as hygiene AROUND that rule — they void visible label mutations
// early and keep narration harmless — but validity never rests on them. Detection by shape is
// enumerating the shapes a model might malform a letter into, and every edition of that list
// leaked at its next edge: single-letter matching missed `1aa`, letters-hard-against-the-number
// missed the spaced `1 b:`, a separator allowlist missed the parenthesized `1(b):`, a junk class
// with a `\b` missed `1b_:` and `1b2:`, the colon window missed the swallowed colon — each time
// the unseen sibling left the valid letters standing as the "complete" enumeration until the
// declaration made unseen mean uncounted. A line is CLASSIFIED exactly once (see parseFindings)
// when either structural net sees it, and then it is one of three things: the numbered FINDING
// line itself, the strict sub-claim shape — lettered a, b, c… in report order, naming a claim no
// sibling already names — or, everything else, a voider of that finding's whole enumeration. The
// in-order rule is what makes a letter pure position (the settlement: identity is claim text; a
// letter is a positional label of the report it appeared in, never state), and the
// no-duplicate-claim rule keeps that identity unambiguous inside one enumeration — two letters
// naming one claim is not separately answerable, so it is an intended-but-invalid enumeration
// like any other.
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
// Net three — the LABELLED TOKEN: word-material glued to the number (`FINDING 1b`, `1aa`,
// `1b2`, `1b_`) is a label whether or not a colon survived the decoration — `(b) FINDING 1b —
// second claim` slips the head net (lettered prefix) AND net two (the dash swallowed the colon),
// and was the escape the first two nets left standing. So after the lines are classified, any
// labelled token voids its finding's enumeration unless it sits on one of that finding's OWN
// lines — its numbered FINDING line or an accepted strict sub-claim line, the only places a
// lettered token is the format rather than a mutation of it. There is deliberately NO in-range
// sparing: an earlier edition spared a single letter the enumeration records, on the theory that
// it could hide only a duplicate of a recorded claim — refuted, because a DISTINCT claim can wear
// a recorded letter (`FINDING 1a: first` + `(b) FINDING 1a — distinct second`), and a certificate
// that counts only the strict line then blesses the kept subset. A worn letter and a narrated one
// are prose-indistinguishable, so both void; reports narrate a sub-claim as `(a)` (the form every
// render uses) or by its claim text, never as a bare `FINDING 1a` token.
//
// The boundary's other side is equally deliberate: a MID-SENTENCE mention (`…described in
// FINDING 1.`, `see FINDING 1 for the full chain: …`) has words before the token, no colon
// beside it and no label glued to the number, and never voids — reports narrate their findings by
// number, so voiding on mention would kill every enumeration in any report that explains itself.
// The report's own `ESCALATE STRUCTURAL FINDING <n>:` line is the one format-legal shape net two
// would see, and is exempted by its exact prefix.
//
// The deliberate cost is prose at line start or with a colon by the number — `FINDING 1 rests…`,
// `as FINDING 1: the gate…` — and lettered narration anywhere: each voids finding 1's
// enumeration, degrading it to the single-claim finding it always was — which is current
// behaviour, and always a correct way to record it (the RUN-148 steps rule: a decomposition that
// cannot be run soundly is dropped, never half-run). A lost enumeration is a duller report; a
// kept subset is the escape. Legacy reports are untouched by construction: their only classified
// lines are the numbered finding lines themselves (skipped as such) and prose, which voids an
// enumeration no legacy finding has — and net three only ever voids, so a report that enumerated
// nothing has nothing it can touch.
const HEAD_LINE_RE = /^[^a-zA-Z\n]*FINDING[ \t]+(\d+)/i;
const NEAR_COLON_TOKEN_RE = /\bFINDING[ \t]+(\d+)[^:\n]{0,8}:/gi;
/** The label must START with a non-digit word character: `\d+` backtracking must not be able to
 *  split a longer NUMBER (`FINDING 12`) into `1` + label `2` and void finding 1 on a mention of
 *  finding 12. */
const LABELLED_TOKEN_RE = /\bFINDING[ \t]+(\d+)([a-z_]\w*)/gi;
const ESCALATE_LINE_RE = /^[ \t]*ESCALATE[ \t]+STRUCTURAL[ \t]+FINDING\b/i;
/** FINDING_RE's shape, single-line and stateless, for classifying one already-extracted line. */
const FINDING_LINE_RE = new RegExp(FINDING_RE.source, 'i');
const SUBCLAIM_SHAPE_RE = /^[ \t]*FINDING[ \t]+(\d+)([a-z])[ \t]*:[ \t]+(.+?)[ \t]*$/i;
/** The completeness declaration, at the very end of the FINDING line's claim. Strict on purpose:
 *  a mutated declaration is claim text, the finding then has no certificate, and its letters are
 *  not kept — the same safe degradation as every other malformation. Stripped from the stored
 *  claim, so the ledger, the prose key, and every render carry the claim alone. */
const SUBCLAIM_DECL_RE = /[ \t]*\[[ \t]*sub-claims:[ \t]*(\d{1,2})[ \t]*\]$/i;

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
 *  field by field rather than crashing. An entry persisted by the letter-era shape loads too: the
 *  claim is the identity, so a stray `letter` field is simply ignored. Exported because the
 *  terminal-contest candidacy check in the supervisor reads entries the same way — never trusted
 *  from the object. */
export const subclaimsOf = (e: { subclaims?: unknown }): AdjudicatedSubClaim[] =>
  Array.isArray(e.subclaims)
    ? e.subclaims
        .filter(
          (s): s is Record<string, unknown> & { claim: string } =>
            typeof s === 'object' && s !== null && typeof (s as { claim?: unknown }).claim === 'string',
        )
        .slice(0, MAX_LEDGER_SUBCLAIMS)
        .map((s) => ({
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
  // The completeness certificate per finding (RUN-180): how many sub-claims the FINDING line says
  // it enumerates. Extracted BEFORE the claim is capped — truncation must not eat the certificate
  // — and stripped from the stored claim, so ledger identity and every render carry prose alone.
  const declared = new Map<number, number>();
  for (const m of text.matchAll(FINDING_RE)) {
    const id = Number(m[1]);
    if (seen.has(id)) continue; // a duplicated number is the reviewer's slip; first wins
    seen.add(id);
    const rawClaim = m[5]!;
    const decl = SUBCLAIM_DECL_RE.exec(rawClaim);
    if (decl) declared.set(id, Number(decl[1]));
    out.push({
      id,
      severity: cap(m[2]!, SEVERITY_CAP),
      requirements: parseRequirements(m[3]),
      location: cap(m[4]!, LOCATION_CAP),
      claim: cap(decl ? rawClaim.slice(0, decl.index) : rawClaim, CLAIM_CAP),
      subclaims: [],
    });
  }
  // Second pass (RUN-180): attach sub-claim lines to the finding their number names. Keyed by
  // number rather than by position, so prose between the lines cannot orphan one. A line naming a
  // finding nobody numbered is ignored — there is no finding to degrade.
  //
  // This is the ONE enforcement point of the enumeration invariant (the structural settlement):
  // every line either structural net sees — the HEAD net (first letters are `FINDING <n>`, so
  // letterless markdown decoration is included) and the NEAR-COLON TOKEN net (`FINDING <n>…:`
  // anywhere in the line, so decoration wearing letters is included) — is classified exactly once,
  // per finding, all-or-nothing: the numbered FINDING line itself is pass 1's subject; the strict
  // sub-claim shape whose letter is the NEXT letter in sequence and whose claim no sibling already
  // names records a claim; and ANY other classified line — a decorated label, a spaced or
  // punctuated letter, a doubled letter, a trailing `_` or digit, an out-of-sequence or repeated
  // letter, a repeated claim text, a fifth letter (the cap), line-start prose — voids the WHOLE
  // enumeration (`null` below) and the finding stays single-claim. Never an error, and never a
  // kept subset a partial contest could clear. Fold, render, and candidacy consume the canonical
  // set this pass emits and carry no shape judgment of their own — the class dies where the data
  // is born. The strict-shape checks compare the NUMBER too: a sub-claim line of finding 2 that
  // mentions `FINDING 1:` in its claim is strict for 2 and a voider for 1 — never a recorder of
  // either's claims onto the other.
  const byId = new Map(out.map((f) => [f.id, f]));
  const pending = new Map<number, string[] | null>();
  const lines = text.split('\n');
  // A finding's OWN lines — its numbered FINDING line and its accepted strict sub-claim lines —
  // are the only places a lettered token of that finding is format rather than mutation, so they
  // are the only lines net three spares. Keyed per (line, id): finding 2's strict line quoting a
  // `FINDING 1a` token is still narration ABOUT 1, and voids 1's enumeration like any other.
  const ownLines = new Set<string>();
  lines.forEach((line, li) => {
    if (ESCALATE_LINE_RE.test(line)) return; // the format's own escalation line; letters nothing, voids nothing
    const ids = new Set<number>();
    const head = HEAD_LINE_RE.exec(line);
    if (head) ids.add(Number(head[1]));
    for (const t of line.matchAll(NEAR_COLON_TOKEN_RE)) ids.add(Number(t[1]));
    for (const id of ids) {
      if (!byId.has(id)) continue;
      const asFinding = FINDING_LINE_RE.exec(line);
      if (asFinding && Number(asFinding[1]) === id) {
        ownLines.add(`${li}:${id}`); // the numbered FINDING line — pass 1's subject
        continue;
      }
      const list = pending.get(id);
      if (list === null) continue; // already voided — one bad line spoils the set, not just itself
      const shaped = SUBCLAIM_SHAPE_RE.exec(line);
      const letter = shaped && Number(shaped[1]) === id ? shaped[2]?.toLowerCase() : undefined;
      const held = list ?? [];
      const claim = shaped ? cap(shaped[3]!, CLAIM_CAP) : '';
      if (
        !letter ||
        letter !== subclaimLetter(held.length) || // letters are position: a, b, c…, no gaps, no repeats
        held.length >= MAX_SUBCLAIMS ||
        held.some((c) => subKey(c) === subKey(claim)) // one claim, one identity — even ellipsis-capped
      ) {
        pending.set(id, null);
        continue;
      }
      ownLines.add(`${li}:${id}`);
      held.push(claim);
      pending.set(id, held);
    }
  });
  // Net three runs after the line pass — a narration may precede the lines it narrates, and which
  // lines are a finding's own is only known once the pass classified them. ANY labelled token off
  // the finding's own lines is an intended sub-claim the nets above could not classify, a mutation
  // of one, or narration wearing the same shape — indistinguishable by construction, so all void
  // (no in-range sparing: a recorded letter can be WORN by a distinct unrecorded claim, and the
  // certificate then blesses the kept subset). Nothing recorded → nothing a subset could clear →
  // nothing to void.
  lines.forEach((line, li) => {
    if (ESCALATE_LINE_RE.test(line)) return;
    for (const m of line.matchAll(LABELLED_TOKEN_RE)) {
      const id = Number(m[1]);
      if (ownLines.has(`${li}:${id}`)) continue;
      if (pending.get(id)?.length) pending.set(id, null);
    }
  });
  // The completeness check, last, because it is a fact about the finished set: the enumeration is
  // kept only when the FINDING line certified EXACTLY this many sub-claims. This is what the shape
  // nets above cannot do — they void what they can see, and a line can mangle into English — where
  // a mangled line of ANY shape is simply not counted, so the mismatch voids the whole. Letters
  // with no certificate are never kept: keeping them would put validity back on the nets alone,
  // and the safe degradation for a missing or mutated certificate is the single-claim finding.
  for (const [id, subs] of pending) {
    if (subs && declared.get(id) !== subs.length) pending.set(id, null);
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
  // prefix and not a letter. A prefix aliases two long claims that diverge past it — both would
  // inherit one rebuttal, answering a claim nobody answered — and a letter is one report's
  // ordering, not the claim's identity (the structural settlement). Full wording may MISS a
  // paraphrase (the sub-claim reads as unanswered, visibly, and the builder can answer again); it
  // cannot INVENT a match, which is the failure the whole ledger refuses. A truncated
  // (ellipsis-capped) claim never carries, for the same aliasing reason — see `carryable`.
  const carriedFrom = (held: AdjudicatedSubClaim[], claim: string): AdjudicatedSubClaim | undefined => {
    const key = subKey(claim);
    if (!carryable(key)) return undefined;
    return held.find((h) => subKey(h.claim) === key);
  };
  // This round's enumeration wins its own framing (the latest wording, like the claim itself) —
  // but it must not LOSE what the entry already holds. A re-raise that repeats only SOME of the
  // held claims used to replace the set wholesale, so a held unanswered claim vanished exactly
  // when the terminal round enumerated the claims it cared about — and the candidacy gate can
  // only keep standing what was RECORDED: the RUN-174 escape through the fold itself. So held
  // claims the new wording does not cover are UNIONED in beside the new set, keeping their
  // adjudication. Two deliberate asymmetries:
  //   - a held CONTESTED claim the re-raise abandoned is dropped: the reviewer no longer asserts
  //     it and the builder had rebutted it, so keeping it bloats the record and dropping it can
  //     clear nothing (a contested claim only ever counted toward clearing). Unanswered and
  //     FIXED claims — the ones whose loss would flip a finding clearable — always carry.
  //   - coverage is the claim's full wording (the carry key), so a reworded survivor rides as a
  //     duplicate row rather than being merged away — may MISS, never INVENT — and a truncated
  //     key never counts as covering, for the same aliasing reason carriedFrom refuses it.
  // A union past MAX_LEDGER_SUBCLAIMS keeps the HELD set whole and drops the new enumeration —
  // all-or-nothing, never a sliced subset — with this turn's answers still landed on it by
  // wording, because the builder may be answering in the very fold that overflows.
  //
  // RESPONSE letters are resolved HERE, at the fold boundary, into claim text — the only identity
  // the ledger stores. A letter names a line the builder was SHOWN: this report's lettered lines
  // first (the parse made those positional), and past them the record's own positions — which is
  // exactly what any render of the entry labels them (renderLedger, the contest record), since an
  // entry is written as [this round's claims…, carried extras…]. A letter that names neither
  // resolves to nothing: a visible miss the builder can repeat, never an invented credit.
  const mergedSubclaims = (f: Finding, heldSubs: AdjudicatedSubClaim[]): AdjudicatedSubClaim[] => {
    const responseAt = (i: number) => bySub.get(`${f.id}${subclaimLetter(i)}`);
    const adjudicated = (
      claim: string,
      rs: FindingResponse | undefined,
      held?: AdjudicatedSubClaim,
    ): AdjudicatedSubClaim => ({
      claim,
      status: rs?.status ?? held?.status ?? ('unanswered' as const),
      pointer: rs?.pointer ?? held?.pointer ?? null,
      reason: rs?.reason ?? held?.reason ?? null,
    });
    // Held claims stay answerable at the positions this report's own lines do not shadow — the
    // letters the record's rendering shows for them.
    const creditedHeld = heldSubs.map((h, i) =>
      i >= f.subclaims.length ? adjudicated(h.claim, responseAt(i), h) : h,
    );
    // A re-raise that dropped the letters entirely keeps the held sub-claims AND their answers,
    // the same preservation the whole-finding status gets below.
    if (!f.subclaims.length) return creditedHeld;
    const mapped = f.subclaims.map((claim, i) =>
      adjudicated(claim, responseAt(i), carriedFrom(heldSubs, claim)),
    );
    const covered = new Set(mapped.map((s) => subKey(s.claim)).filter(carryable));
    const extras: AdjudicatedSubClaim[] = [];
    heldSubs.forEach((h, i) => {
      const k = subKey(h.claim);
      // The skip reads the PRIOR status: a claim contested this very turn is not "abandoned by
      // both sides", and dropping it would hide the fresh rebuttal from the adjudicator's render.
      if (h.status === 'contested' || covered.has(k)) return;
      if (carryable(k)) covered.add(k);
      extras.push(i >= f.subclaims.length ? adjudicated(h.claim, responseAt(i), h) : h);
    });
    const union = [...mapped, ...extras];
    if (union.length <= MAX_LEDGER_SUBCLAIMS) return union;
    // Overflow: the held set stands whole — and this turn's answers to re-listed claims land on it
    // by wording, so standing whole does not cost a valid current adjudication.
    const landed = new Map<string, FindingResponse>();
    f.subclaims.forEach((claim, i) => {
      const rs = responseAt(i);
      const k = subKey(claim);
      if (rs && carryable(k)) landed.set(k, rs);
    });
    return creditedHeld.map((h) => {
      const k = subKey(h.claim);
      const rs = carryable(k) ? landed.get(k) : undefined;
      return rs ? adjudicated(h.claim, rs) : h;
    });
  };
  // Held sub-claim state transfers only across a match that cannot be an INVENTION (RUN-180).
  // matchIndex's prose rule keys on a 60-char prefix — kept byte-identical for ENTRY identity,
  // the pre-RUN-147 world — but two long claims that diverge past the prefix can be two REAL
  // findings, and carrying one's contested letters onto the other let a terminal finding reach
  // the fresh look on contests nobody made about it: the prefix-aliasing escape at parent grain,
  // the same one `carriedFrom` refuses one level down. So the sub-claim record rides only the
  // claim's FULL wording (a truncated claim never matches — see `carryable`) or the rule-2 bar,
  // a shared requirement id at a specific location, because an id is not wording. The cost of
  // refusing is the held record dropping with the replaced claim — a MISS, visible as the entry's
  // own claim change and answerable again; carrying would INVENT, the forbidden order of harms.
  const trustedCarry = (e: LedgerEntry, f: Finding): boolean => {
    const k = subKey(f.claim);
    if (carryable(k) && subKey(e.claim) === k) return true;
    return f.location.trim().length > 0 && shareRequirement(reqsOf(e), f.requirements);
  };
  const result = [...prior];
  for (const f of findings) {
    const r = byId.get(f.id);
    const at = matchIndex(result, f);
    const held = at >= 0 ? result[at] : undefined;
    const heldSubs = held && trustedCarry(held, f) ? subclaimsOf(held) : [];
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
        return `[sub-claims: ${subs.map((s, i) => `(${subclaimLetter(i)}) ${s.status}`).join(', ')}]`;
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
      // Letters are derived from position here, never read from the entry (the settlement): the
      // fold resolves a response letter through exactly this derivation, so what a reader answers
      // by is what the record credits.
      const subLines = subs.map((s, i) => {
        const sPtr = s.pointer ? ` (${s.pointer})` : '';
        const sWhy = s.reason ? ` — ${s.reason}` : '';
        const sAnswer =
          s.status === 'unanswered'
            ? 'no response recorded — this sub-claim STANDS; judge it fresh'
            : `${s.status.toUpperCase()}${sPtr}${sWhy}`;
        return `      (${subclaimLetter(i)}) ${s.claim}\n          → builder: ${sAnswer}`;
      });
      const whole =
        e.status === 'unanswered'
          ? []
          : [`      → builder, on the finding as a whole (credits no sub-claim): ${status}${ptr}${why}`];
      return [head, ...whole, ...subLines].join('\n');
    })
    .join('\n');
}

/**
 * The entry the fold wrote for THIS finding in THIS round — the reconciled record the
 * terminal-contest candidacy judges and the contest record renders. Matched on the values the fold
 * itself wrote (id, round, location, claim), so it cannot alias a prior attempt's persisted entry.
 * `undefined` means the entry did not survive the fold (the MAX_ENTRIES cap): what the adjudicator
 * cannot be shown is not evidence, so the caller treats the finding as standing.
 */
export function reconciledEntry(entries: LedgerEntry[], f: Finding, round: number): LedgerEntry | undefined {
  const loc = (s: string) => s.trim().toLowerCase();
  return entries.find(
    (e) => e.round === round && e.id === f.id && loc(e.location) === loc(f.location) && e.claim === f.claim,
  );
}

/**
 * Land the contest turn's responses on the reconciled terminal entries (RUN-180). The contest
 * prompt hands the builder THE RECORD — each terminal finding's sub-claims as the reconciled
 * entry holds them, lettered by position — and declares that lettering authoritative. So a
 * contest letter resolves against the ENTRY's positions, never against the terminal report's own
 * enumeration. The two agree wherever the fold kept the report's claims in front (the union
 * writes [this round's claims…, carried extras…]); where they diverge — the overflow path, which
 * keeps the held set whole and drops the report's enumeration — the record in front of the
 * builder is the only labelling it could answer by, and resolving report-first there discarded
 * answers to the very claims the record displayed.
 *
 * The claim set is FIXED at the terminal fold: a contest adds answers, never claims — re-running
 * the union here would let the one no-new-code turn reshape the record it is answering. A letter
 * past the entry's claims resolves to nothing (a visible miss, never an invented credit), a bare
 * response lands on the entry as whole-finding evidence crediting no letter (the RUN-174 rule),
 * and a finding whose entry did not survive the fold has nothing to land on and stands — what
 * the adjudicator cannot be shown is not evidence.
 */
export function applyContestResponses(
  entries: LedgerEntry[],
  findings: Finding[],
  responses: FindingResponse[],
  round: number,
): LedgerEntry[] {
  const byId = new Map(responses.filter((r) => !r.subclaim).map((r) => [r.id, r]));
  const bySub = new Map(responses.filter((r) => r.subclaim).map((r) => [`${r.id}${r.subclaim}`, r]));
  const out = [...entries];
  for (const f of findings) {
    const e = reconciledEntry(out, f, round);
    if (!e) continue;
    const r = byId.get(f.id);
    const subclaims = subclaimsOf(e).map((s, i) => {
      const rs = bySub.get(`${f.id}${subclaimLetter(i)}`);
      return rs ? { claim: s.claim, status: rs.status, pointer: rs.pointer, reason: rs.reason } : s;
    });
    out[out.indexOf(e)] = {
      ...e,
      status: r?.status ?? e.status,
      pointer: r?.pointer ?? e.pointer,
      reason: r?.reason ?? e.reason,
      subclaims,
    };
  }
  return out;
}

/**
 * The sub-claims each terminal finding carries on the record, rendered for the CONTEST turn
 * (RUN-180). Letters are derived from position — the same derivation the fold resolves a response
 * letter through — so this block is what makes a carried claim answerable at all: a letterless or
 * narrowed terminal re-raise does not repeat a standing sub-claim, the builder's session may
 * remember it under a label a later round re-used, and letters are not state anywhere (the
 * settlement), so the record in front of the builder is the one authoritative labelling. Data
 * only; the framing — that an unanswered or FIXED sub-claim blocks clearing, and how to contest
 * one — lives in prompts/reviewer-contest.md. Null when no terminal finding carries sub-claims,
 * which is every pre-RUN-180 report and renders the prompt without the section.
 */
export function renderContestRecord(
  findings: Finding[],
  entries: LedgerEntry[],
  round: number,
): string | null {
  const blocks = findings.flatMap((f) => {
    const e = reconciledEntry(entries, f, round);
    const subs = e ? subclaimsOf(e) : [];
    if (!subs.length) return [];
    const lines = subs.map((s, i) => {
      const ptr = s.pointer ? ` (${s.pointer})` : '';
      const answer = s.status === 'unanswered' ? 'no answer recorded' : `${s.status.toUpperCase()}${ptr}`;
      return `  (${subclaimLetter(i)}) ${s.claim} — ${answer}`;
    });
    return [`FINDING ${f.id}:\n${lines.join('\n')}`];
  });
  return blocks.length ? blocks.join('\n') : null;
}
