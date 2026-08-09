/**
 * Secret-shaped value withholding for the format adapters (RUN-218, Project Memory §7).
 *
 * **This is the one place in the indexer where the direction of caution FLIPS.** Everywhere else
 * in Project Memory the rule is may-miss-never-invent: a fact this daemon fails to notice costs
 * coverage, never correctness, so an adapter declines by omission rather than guesses (see
 * `index-adapters.ts`'s own doc). Here a miss does not cost coverage — it LEAKS: an emitted entity
 * is `content` a later phase ships to a server (`indexer.ts`'s own doc: "this file reads bytes
 * that later phases ship to a SERVER"). So the rule inverts: **when unsure, WITHHOLD.** Do not
 * "correct" this back toward may-miss-never-invent later — the two rules answer different
 * questions (is a fact true? vs. may a value leave the box?) and this module only ever answers
 * the second one.
 *
 * **Withholding is ALL-OR-NOTHING per value** (locked decision 3): a withheld value's entity gets
 * `content: null`, never a masked or truncated form. A prefix is exactly what identifies a
 * credential's type and issuer (`ghp_`, `sk-`, `xoxb-`, a PEM header) — printing "sk-ab..." is not
 * caution, it is a leak with a fig leaf. The KEY (or heading, or label) stays, because the key is
 * the useful graph fact ("this repo configures a `bearer` header somewhere") and the value never
 * was.
 *
 * **Two independent triggers, either one withholds** (locked decision 4): a KEY name
 * (`keyLooksSensitive`) and a VALUE's own shape (`valueLooksSecret`). Neither subsumes the other —
 * `[auth] a = "ghp_..."` has an innocuous key but a shaped value; `password = "hunter2"` has a
 * shaped key but a value no pattern will ever recognise. `shouldWithholdValue` is the join: it
 * fires on whichever check answers first, and callers holding a key/value pair use it; callers
 * holding only free text (a markdown section, a fenced code block — no "key" exists there) use
 * `scanTextForSecretShapedContent`, the value-shape half applied to a blob rather than one field.
 *
 * **This module is independent of `index-deny.ts`.** That is a PATH floor — it runs before any
 * adapter and keeps `.env`/`*.pem`/`.ssh/**` from ever reaching decoded text at all. This is a
 * second, independent floor for a value inside a file that legitimately IS indexed (a token
 * hardcoded into an ordinary `config.json`, a bearer example pasted into a `.md` doc) — the
 * residual risk `THREAT-MODEL.md`'s `[index]` section already names ("a secret pasted into an
 * ordinary file ... no path-based list can see it"). Neither floor substitutes for the other.
 *
 * **A third caller, a third entry point, RUN-258.** `indexer.ts`'s `full`-mode FILE content (raw
 * decoded source, never an adapter-extracted value) was outside every check above until now — the
 * residual risk THREAT-MODEL.md's `[index]` section names ("a token hardcoded into `src/foo.ts` is
 * in the payload exactly as before"). `scanTextForCredentialMarkers` is that third entry point:
 * deliberately the marker-only third of `scanTextForSecretShapedContent`, with NO key-name check
 * (a whole file has no single "key") and NO entropy scan (tuned for a short isolated value, not
 * hundreds of lines of real code — see that function's own doc for the measured false positives on
 * this repo's own source). `indexer.ts` is the only caller.
 */

// ---------------------------------------------------------------------------
// Key-name vocabulary
// ---------------------------------------------------------------------------

/**
 * Substrings checked against a normalized (lowercased, non-alphanumeric stripped) key name.
 * Deliberately broad and substring-based rather than exact-match: `api_key`, `apiKey`, `API-KEY`,
 * and `x-api-key-header` all normalize to something containing `apikey`. The cost of that breadth
 * is a real false positive — `author` contains `auth` and normalizes to `withhold` a plain name
 * field — and per this module's inversion, that is the CORRECT direction to err: an author's name
 * unindexed costs nothing; a credential indexed cannot be recalled.
 */
const SENSITIVE_KEY_SUBSTRINGS = [
  'token',
  'secret',
  'password',
  'passwd',
  'credential',
  'privatekey',
  'apikey',
  'auth',
  'bearer',
  'session',
  'cookie',
  'salt',
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Does this key name look like it names a secret? Substring match on the normalized key —
 *  see the module doc for why breadth (and its false positives) is the deliberate choice here. */
export function keyLooksSensitive(key: string): boolean {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEY_SUBSTRINGS.some((s) => normalized.includes(s));
}

// ---------------------------------------------------------------------------
// Value-shape vocabulary
// ---------------------------------------------------------------------------

/** A PEM-encoded key/certificate header — `-----BEGIN RSA PRIVATE KEY-----`,
 *  `-----BEGIN CERTIFICATE-----`, `-----BEGIN OPENSSH PRIVATE KEY-----`, and siblings. */
const PEM_HEADER_RE = /-----BEGIN [A-Z0-9 ]+-----/;

/** Three dot-separated base64url segments — a JWT/JWS. Ten-char minimum per segment so an
 *  ordinary short dotted string (a version number, a hostname) cannot reach three qualifying
 *  segments by accident; a real JWT's header/payload/signature segments are all far longer than
 *  that in practice. */
const JWT_EXACT_RE = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;
const JWT_SEARCH_RE = /[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;

/** Common issuer/vendor prefixes for a token whose TYPE and ISSUER the prefix alone reveals —
 *  which is exactly why locked decision 3 forbids printing even this much of a withheld value. */
const ISSUER_PREFIXES = [
  'ghp_', // GitHub personal access token
  'gho_', // GitHub OAuth token
  'github_pat_', // GitHub fine-grained PAT
  'sk-', // OpenAI/Anthropic-style secret key
  'xoxa-',
  'xoxb-',
  'xoxp-',
  'xoxr-',
  'xoxs-', // Slack tokens
  'AKIA', // AWS access key id
  'AIza', // Google API key
];

function matchedIssuerPrefix(value: string): string | null {
  return ISSUER_PREFIXES.find((p) => value.startsWith(p)) ?? null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `ISSUER_PREFIXES`, matched at a TOKEN boundary — a whole-file caller's own need, never the
 * isolated-VALUE callers' (`matchedIssuerPrefix`, unchanged, plain `startsWith`): an already-isolated
 * JSON/TOML leaf has nothing else for `sk-` to be a substring OF, but a whole file of English
 * identifiers does — `risk-`, `desk-`, `task-`, `kiosk-` all contain the literal substring `sk-`
 * measured directly against this repo's own `src/adjudication.ts` (RUN-258, the false positive
 * locked decision 1 names). A negative lookbehind requiring the character immediately before the
 * prefix to be absent or non-word (never a letter/digit/`_`) rejects exactly those — `task-`'s `s`
 * is preceded by the word character `a`, so no boundary exists there — while still matching a real
 * token wherever it actually starts a word: a quote, `=`, whitespace, or the start of the file. This
 * is deliberately NOT applied to `matchedIssuerPrefix`/`scanTextForSecretShapedContent` above, whose
 * VALUE-level behaviour this task must not change (their own caller already isolated the value, so
 * there is no surrounding word for the prefix to hide inside).
 */
const ISSUER_PREFIX_TOKEN_RE = new RegExp(
  `(?<![A-Za-z0-9_])(?:${ISSUER_PREFIXES.map(escapeRegExp).join('|')})`,
);

// ---------------------------------------------------------------------------
// High-entropy heuristic
//
// A stated threshold, not a vibe: LENGTH >= 20, at least 3 of {lowercase, uppercase, digit,
// symbol} character classes present, AND Shannon entropy >= 4.0 bits/char. The character-class
// floor is what keeps a hex SHA (only lowercase+digit — 2 classes, max possible entropy 4.0 bits
// exactly since log2(16) = 4) from ever qualifying regardless of how the entropy threshold is
// tuned — filtered by construction, not by the entropy number happening to land under the line.
// Natural-language prose (a licence string) and a typical lowercase URL both fail on ENTROPY
// (repeated letters, common words, repeated path characters), not on length or character classes
// alone — see index-redact.test.ts for the measured cases this was tuned against, per this task's
// own instruction to verify against reality rather than assert a threshold that merely sounds
// right.
// ---------------------------------------------------------------------------

export const ENTROPY_MIN_LENGTH = 20;
export const ENTROPY_MIN_CHAR_CLASSES = 3;
export const ENTROPY_THRESHOLD_BITS_PER_CHAR = 4.0;

function shannonEntropyBitsPerChar(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function charClassCount(s: string): number {
  let n = 0;
  if (/[a-z]/.test(s)) n += 1;
  if (/[A-Z]/.test(s)) n += 1;
  if (/[0-9]/.test(s)) n += 1;
  if (/[^A-Za-z0-9]/.test(s)) n += 1;
  return n;
}

/** Does this single token look like a generated secret rather than ordinary text? See the block
 *  comment above for the three-part threshold and why each part is there. A real credential is one
 *  contiguous token — never internal whitespace — so a value containing a space is disqualified
 *  outright rather than merely scored: natural-language prose over a large-enough alphabet
 *  (letters, punctuation, the space itself as its own "symbol" character class) can otherwise
 *  cross the same bits-per-character threshold a generated token does purely from having many
 *  distinct characters, as measured directly against an SPDX licence string in this module's own
 *  test — a single space-free WORD from that same sentence stays well under the threshold, which
 *  is exactly the discriminator `scanTextForSecretShapedContent`'s per-token split already relies
 *  on for free text; this guard makes the same true for a whole config VALUE. */
export function looksHighEntropy(value: string): boolean {
  if (value.length < ENTROPY_MIN_LENGTH) return false;
  if (/\s/.test(value)) return false;
  if (charClassCount(value) < ENTROPY_MIN_CHAR_CLASSES) return false;
  return shannonEntropyBitsPerChar(value) >= ENTROPY_THRESHOLD_BITS_PER_CHAR;
}

// ---------------------------------------------------------------------------
// Combined checks
// ---------------------------------------------------------------------------

/** Does this single VALUE (already isolated — a JSON/TOML leaf, one array element) look secret,
 *  independent of what key it was found under? Returns a human-readable reason (never the value
 *  itself, never a substring of it — including the matched issuer PREFIX, which is exactly what
 *  identifies a credential's type and issuer per this module's own doc, so it is named only in
 *  code comments/tests, never returned to a caller) or null. */
export function valueLooksSecret(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (PEM_HEADER_RE.test(trimmed)) return 'PEM key/certificate header';
  if (JWT_EXACT_RE.test(trimmed)) return 'JWT-shaped value (three dot-separated base64url segments)';
  if (matchedIssuerPrefix(trimmed)) return 'known credential prefix';
  if (looksHighEntropy(trimmed)) return 'high-entropy value';
  return null;
}

/**
 * The join locked decision 4 asks for: withhold if EITHER the key name or the value's own shape
 * looks secret. `key` is `null` when there is no key in scope (an array element with no field
 * name) — in that case only the value-shape half can fire, which is correct: there is nothing to
 * name-match against.
 *
 * The key name IS embedded in its own reason string below (`sensitive key name ("${key}")`) —
 * deliberately, and NOT the same mistake `valueLooksSecret` above avoids. A key is public
 * structural information already visible anywhere this config is read (`.noriq/project.toml`'s
 * own committed text, a `package.json` a repo ships) — it names the SHAPE of a secret ("this repo
 * configures a `password`"), never the secret itself. A VALUE's matched prefix is different in
 * kind: `ghp_`/`sk-`/`AKIA` is a fragment of the credential's own bytes, which is precisely what
 * locked decision 3 says must never appear even in redacted form. The two reason strings look
 * similar; only one of them is safe to interpolate, and this comment is here so a future edit
 * does not "fix" this one to match that one.
 */
export function shouldWithholdValue(key: string | null, value: string): string | null {
  if (key !== null && keyLooksSensitive(key)) return `sensitive key name ("${key}")`;
  return valueLooksSecret(value);
}

/**
 * The free-text counterpart for a caller with no key/value pair to check — a markdown section's
 * prose, a fenced code block's body. Scans for the same value-shape signals as `valueLooksSecret`,
 * substring-anchored rather than whole-string, plus a per-token entropy scan (splitting on
 * whitespace) since a secret embedded in running text (`API_KEY=sk-...` inside an example) is not
 * the whole blob's own shape, only one token's. Callers apply this ALL-OR-NOTHING to the entity
 * that would have carried the text (locked decision 3, one level up: the heading/label survives,
 * the section body does not) — there is no masked or trimmed return value here, only a reason or
 * null, by the same design as `shouldWithholdValue`.
 *
 * Unchanged by RUN-258 (out of scope — that task adds a THIRD, marker-only entry point below for a
 * whole FILE, `scanTextForCredentialMarkers`, and is explicit that this function's own tuning must
 * not move): plain substring matching here, not `ISSUER_PREFIX_TOKEN_RE`'s token-boundary version,
 * because this function's callers already isolated the blob (a markdown section, a code fence) —
 * there is no surrounding English word for `sk-` to hide inside the way there is in a whole file of
 * source (`src/adjudication.ts`'s own `task-`, measured — see `scanTextForCredentialMarkers`'s doc).
 */
export function scanTextForSecretShapedContent(text: string): string | null {
  if (PEM_HEADER_RE.test(text)) return 'PEM key/certificate header';
  if (JWT_SEARCH_RE.test(text)) return 'JWT-shaped value (three dot-separated base64url segments)';
  // Same reasoning as `valueLooksSecret`: the matched prefix itself is never returned, only the
  // fact that one matched — the prefix is a fragment of the credential's own bytes.
  if (ISSUER_PREFIXES.some((p) => text.includes(p))) return 'known credential prefix';
  for (const rawToken of text.split(/\s+/)) {
    const token = rawToken.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    if (looksHighEntropy(token)) return 'high-entropy token';
  }
  return null;
}

/**
 * The marker-only entry point RUN-258 needs: a `full`-mode FILE's raw decoded source
 * (`indexer.ts`'s file-entity push), never an adapter-isolated value. Reuses this module's existing
 * marker PATTERNS (`PEM_HEADER_RE`, `JWT_SEARCH_RE`, `ISSUER_PREFIXES` — the vocabulary lives in
 * exactly one place, per locked decision 5) but composes them differently from every caller above,
 * for two reasons specific to scanning a WHOLE file rather than one isolated value:
 *
 * 1. **No key-name check, no entropy scan.** `keyLooksSensitive`/`looksHighEntropy` were tuned
 *    against short, isolated values and do not transfer to hundreds of lines of real code — measured
 *    directly against this repo's own source (`index-redact.test.ts`'s fixtures were never run
 *    against a whole file): `src/acceptance.ts` trips the entropy test on a regex literal. Composing
 *    either heuristic over whole-file text is the "obvious alternative" this task's locked decisions
 *    name and reject, not an oversight to "complete" back toward `scanTextForSecretShapedContent`.
 * 2. **The issuer-prefix check is TOKEN-BOUNDARY-AWARE** (`ISSUER_PREFIX_TOKEN_RE`), not the plain
 *    substring match every VALUE-level caller above uses. `sk-` as a bare substring matches inside
 *    ordinary English — `risk-`, `desk-`, and this repo's own `src/adjudication.ts`, which repeats
 *    `task-` throughout its prose (measured: composing the plain substring check here withheld that
 *    file's entire content, exactly the false positive locked decision 1 names). A PEM header and a
 *    JWT are already specific enough at any length that they need no such change — `PEM_HEADER_RE`/
 *    `JWT_SEARCH_RE` are reused verbatim, unmodified from the VALUE-level checks above.
 *
 * Only ever returns the marker CLASS (never the matched bytes or even the matched prefix, same
 * reasoning as `valueLooksSecret`), so a caller may safely surface the return value in a status
 * record or diagnostic. `indexer.ts` is the only caller.
 */
export function scanTextForCredentialMarkers(text: string): string | null {
  if (PEM_HEADER_RE.test(text)) return 'PEM key/certificate header';
  if (JWT_SEARCH_RE.test(text)) return 'JWT-shaped value (three dot-separated base64url segments)';
  if (ISSUER_PREFIX_TOKEN_RE.test(text)) return 'known credential prefix';
  return null;
}
