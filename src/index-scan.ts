import { createHash } from 'node:crypto';
import { isDeniedIndexPath } from './index-deny';
import type { ResolvedIndexConfig } from './index-policy';
import { FilesystemIndexSource } from './index-source';
import type { IndexSource, IndexSourceEntry, IndexSourceRefusalReason } from './index-source';

/**
 * Source-independent POLICY for Project Memory's indexer (RUN-209, split from its enumeration in
 * RUN-252): include/exclude, the hard sensitive-file deny list, every bound, binary detection, the
 * content hash, `contentMode`, and the closed status-reason vocabulary. None of it knows or asks
 * where a candidate's bytes came from — that is `index-source.ts`'s `IndexSource` interface, and
 * this module consumes exactly two methods off it (`list`, `read`) plus nothing else.
 *
 * This split exists because `index-scan.ts` used to take a filesystem directory directly, so every
 * backend needing indexing had to MATERIALIZE a full tree before a single byte could be filtered —
 * fine for git, ruinous for a deliberately-large Perforce depot, and it is why RUN-211 shipped
 * `unsupported` for both live backends: the capability hole was in this file, not in either
 * backend. `scanIndexSource` is what any future source runs through; `scanRepoForIndex` is the
 * thin filesystem wrapper this task is REQUIRED to keep byte-for-byte identical (RUN-209's own
 * audited security surface, and the evidence behind THREAT-MODEL.md's rows for it) — read
 * `index-source.ts`'s module doc first for what moved there and why, then this file for what
 * stayed.
 *
 * **The pipeline, and why the order is fixed** (locked decision 1, unchanged from RUN-209): for
 * every entry a source offers, enumerate → include filter → exclude filter → HARD DENY → per-file
 * bounds → read → regular-file/binary check → hash + status record. An `include` glob can never
 * re-admit a denied path because the deny check runs strictly after it and takes no input that
 * could override it. "Non-overridable" has to be a property of the ORDER, not of a comment saying
 * so — and now also a property of WHO gets asked: a source is never handed the deny list or the
 * include/exclude globs, so it cannot re-implement this filter even by accident, and the deny list
 * holds for every source alike rather than only for the ones that remembered it (RUN-158's shape).
 *
 * **The hard deny list is directory-aware here, not source-aware.** RUN-209's walk pruned a whole
 * denied directory (`.git`, `.ssh`, …) to ONE status record by never recursing into it — a
 * filesystem-walk optimisation this file can no longer perform, because a source's enumeration is
 * opaque to this layer (locked decision 1: this file never asks a source to skip anything). The
 * SAME one-record-per-denied-directory outcome is reproduced instead by walking each candidate's
 * own ANCESTOR path segments against `isDeniedIndexPath` and remembering which ancestor prefixes
 * were already reported (`classifyDenial` below) — the record count a test asserts is unchanged,
 * but the WALK cost is not: a source that enumerates a huge denied subtree (a `.git` with
 * thousands of loose objects) is now fully enumerated before any of it is pruned, where the old
 * filesystem walk skipped the `readdir` entirely. Accepted: uniform deny enforcement across every
 * source outranks this one directory-walk shortcut, and nothing measures or asserts the walk cost.
 *
 * **Determinism is this file's job, not a source's** (locked decision 4). `list()` may yield in any
 * order — `FakeIndexSource`'s tests deliberately scramble it — so this file drains every entry,
 * sorts by repository-relative path (plain code-unit comparison, not locale-aware: a sort whose
 * result depends on ICU data is not reproducible across machines), and only THEN applies bounds.
 * That ordering choice is what makes `stoppedEarly`'s "prefix of the repo" meaningful across two
 * runs of the SAME snapshot — an idempotency key built from (project, repo, branch, baseId,
 * indexer version, batch number) only means anything if two runs split the same tree the same way.
 * The cost is real: a source's enumeration is drained in FULL before a `maxFiles`/`maxTotalBytes`
 * bound can stop anything, where the old filesystem-only walk stopped enumerating the moment a
 * bound tripped. Prioritising a deterministic admitted PREFIX over an early-stopped enumeration is
 * the trade locked decision 4 asks for, not a shortcut taken here.
 *
 * **This module does no parsing.** It yields file identity, size, a content hash, a status, and —
 * gated by `contentMode` — content: never language detection or entity extraction (Phase 3's job).
 *
 * **`contentMode: 'metadata'` withholds source text, not the read itself** (RUN-209 follow-up,
 * locked decision 6): the candidate is still read and hashed exactly as `'full'` mode reads it —
 * citation verification (a later phase) compares hashes, and a hash is a fact about bytes, never
 * the bytes themselves. Only the decoded string is dropped before it ever reaches an
 * `IndexFileCandidate`, and which mode produced a candidate is carried ON the candidate
 * (`contentMode`), not left for a reader to re-derive from the config that made it.
 *
 * **The content hash is OUR hash, one algorithm for every source** (locked decision 3). SHA-256
 * over the raw bytes THIS module read, never a source-native digest (Perforce's own `digest`, an
 * API blob's `sha`) — `IndexSource.digest`'s doc carries the full reasoning: citation verification
 * compares an indexed hash against a live worktree hashed the same way, and a source's own digest
 * algorithm is not guaranteed to agree with it.
 *
 * **Binary detection is content-based**, never extension-based: a NUL byte or invalid UTF-8 in a
 * bounded prefix, so a `.ts` file that is actually a binary blob is reported `binary` rather than
 * shipped as source because its name looked textual.
 *
 * **`[index].enabled` is re-asserted here** (locked decision 10), not only trusted from the
 * caller: `config: null` — which is exactly what `resolveIndexConfig` returns for every OFF or
 * invalid `[index]` — makes `scanIndexSource` touch the source at all and return immediately.
 *
 * **A source's read refusal maps onto the existing closed status-reason enum** (locked decision
 * 7), via `mapSourceRefusal` below — never a second vocabulary. `IndexSource`'s own doc names why
 * its refusal union is deliberately smaller than this one: extend `IndexStatusReason` (and this
 * mapping, in the same change) only for a genuinely new outcome no existing reason already covers.
 *
 * **What this module deliberately does NOT cover.** Confinement — the filesystem source's own
 * TOCTOU defense — lives entirely in `index-source.ts`'s `FilesystemIndexSource`; this file never
 * opens a path itself and has no filesystem-specific knowledge at all. Every other source must
 * state its OWN containment guarantee in its own doc comment (locked decision 2) — this file has
 * no way to check one, and demanding a uniform mechanism here would be the same cargo-culting
 * `index-source.ts`'s module doc explains for why `openConfined`'s specific technique does not
 * generalise.
 */

/** Why a candidate path did not become an indexed file, or why the walk stopped early. Closed —
 *  extend it here, in code, never by a caller inventing a new string (locked decision 6 [RUN-209
 *  numbering]: silence is never an outcome, so every reason a byte was NOT read has to have a name
 *  in this list). A source's own refusal vocabulary (`IndexSourceRefusalReason`) is deliberately
 *  smaller and maps onto a subset of this one — see `mapSourceRefusal`. */
export type IndexStatusReason =
  | 'denied'
  | 'excluded'
  | 'not-included'
  | 'binary'
  | 'too-large'
  | 'unreadable'
  | 'outside-root'
  | 'not-a-file'
  | 'budget-exhausted'
  | 'deadline-exceeded';

export interface IndexStatusRecord {
  /** Repository-relative, POSIX-separated — the same spelling `index-deny.ts` matches against. */
  path: string;
  reason: IndexStatusReason;
  /** Free text for a human/log, never structure a caller should branch on — `reason` is that. */
  detail?: string;
}

interface IndexFileCandidateCommon {
  /** Repository-relative, POSIX-separated. */
  path: string;
  bytes: number;
  /**
   * SHA-256 over the RAW bytes (not the decoded string), hex-encoded — see the module doc's
   * "content hash" note for why this is fixed to one algorithm regardless of source. Produced in
   * EVERY `contentMode`, because a hash is not source text — it is the fact citation verification
   * needs, and `'metadata'` mode exists to withhold the latter while still allowing the former.
   */
  contentHash: string;
}

/** `[index].contentMode === 'full'`: the decoded UTF-8 text. Every candidate here already passed
 *  the binary sniff, so decoding is safe — a binary file never reaches this shape, it becomes a
 *  `binary` status record instead. */
export interface IndexFileCandidateFull extends IndexFileCandidateCommon {
  contentMode: 'full';
  content: string;
}

/** `[index].contentMode === 'metadata'`: the read succeeded and was hashed, but the decoded text
 *  was never retained — `content` is `null` BY POLICY, not by a read failure (a read failure is a
 *  status record, this module never returns a candidate for one). Path/size/hash are still real
 *  facts about a real file; only the source text itself is missing on purpose. */
export interface IndexFileCandidateMetadata extends IndexFileCandidateCommon {
  contentMode: 'metadata';
  content: null;
}

export type IndexFileCandidate = IndexFileCandidateFull | IndexFileCandidateMetadata;

export interface IndexScanResult {
  candidates: IndexFileCandidate[];
  /** Bounded (`MAX_STATUS_RECORDS`) — see `statusOverflow` for what did not fit. */
  statuses: IndexStatusRecord[];
  /** How many additional status records were refused beyond the cap. An unbounded status list is
   *  the same OOM as an unbounded read, one level up (locked decision 7 [RUN-209 numbering]) — a
   *  cap with a visible count is bounded AND honest, which a cap alone is not. */
  statusOverflow: number;
  /** Files actually opened (successfully or not) — the number `maxFiles` bounds. */
  filesOpened: number;
  /** Bytes actually read into a candidate — the number `maxTotalBytes` bounds. Counted the same in
   *  every `contentMode`: the bound guards the read/hash cost, not whether the string is kept. */
  totalBytesRead: number;
  /** True when `maxFiles`, `maxTotalBytes`, or `readDeadlineMs` cut the walk short: the result is
   *  a PREFIX of the repo, not the whole thing, and a caller must not treat an empty remainder as
   *  "nothing else exists". */
  stoppedEarly: boolean;
}

/** Retained status records before overflow starts being counted instead of stored. See RUN-209's
 *  original rationale (still holds): 1000 is generous for an ordinary repo's worth of refusals and
 *  still bounded for a pathological one. */
export const MAX_STATUS_RECORDS = 1000;

/** How much of a candidate's bytes are sniffed for binary content — the same order of magnitude
 *  git's own "contains a NUL in the first 8000 bytes" heuristic uses. */
const BINARY_SNIFF_BYTES = 8_000;

export interface IndexScanDeps {
  /** Injected so a deadline test never has to actually sleep. Defaults to the real clock. */
  now?: () => number;
}

interface ScanState {
  candidates: IndexFileCandidate[];
  statuses: IndexStatusRecord[];
  statusOverflow: number;
  filesOpened: number;
  totalBytesRead: number;
  startedAt: number;
  now: () => number;
  stop: boolean;
  includeRe: RegExp[];
  excludeRe: RegExp[];
  /** Ancestor directory prefixes already reported as `denied` — see the module doc's "hard deny
   *  list is directory-aware" note. Keyed on the exact prefix string `classifyDenial` computed. */
  deniedPrefixes: Set<string>;
}

function pushStatus(state: ScanState, relPath: string, reason: IndexStatusReason, detail?: string): void {
  if (state.statuses.length < MAX_STATUS_RECORDS) {
    state.statuses.push(detail === undefined ? { path: relPath, reason } : { path: relPath, reason, detail });
  } else {
    state.statusOverflow += 1;
  }
}

function deadlinePassed(state: ScanState, deadlineMs: number): boolean {
  return state.now() - state.startedAt >= deadlineMs;
}

// ---------------------------------------------------------------------------
// Glob matching (discretion: a small dependency-free matcher, unchanged from RUN-209).
// ---------------------------------------------------------------------------

function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, '/');
  let re = '';
  let i = 0;
  while (i < normalized.length) {
    const c = normalized[i]!;
    if (c === '*') {
      if (normalized[i + 1] === '*') {
        if (normalized[i + 2] === '/') {
          re += '(?:.*/)?'; // `**/` — zero or more whole path segments.
          i += 3;
        } else {
          re += '.*'; // bare `**` — anything, including `/`.
          i += 2;
        }
      } else {
        re += '[^/]*'; // `*` — anything within one segment.
        i += 1;
      }
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

function matchesAny(patterns: RegExp[], relPath: string): boolean {
  return patterns.some((re) => re.test(relPath));
}

// ---------------------------------------------------------------------------
// Binary detection (content-based, unchanged from RUN-209).
// ---------------------------------------------------------------------------

/** Drop a trailing UTF-8 sequence that the sniff window cut in the middle of, so a prefix boundary
 *  landing mid-character is never mistaken for invalid encoding. */
function trimIncompleteUtf8Tail(buf: Buffer): Buffer {
  let cut = buf.length;
  let back = 0;
  while (cut > 0 && back < 3 && (buf[cut - 1]! & 0xc0) === 0x80) {
    cut -= 1;
    back += 1;
  }
  if (cut === 0) return buf;
  const lead = buf[cut - 1]!;
  let seqLen = 1;
  if ((lead & 0xe0) === 0xc0) seqLen = 2;
  else if ((lead & 0xf0) === 0xe0) seqLen = 3;
  else if ((lead & 0xf8) === 0xf0) seqLen = 4;
  else return buf; // ASCII byte, or a stray continuation byte with no lead — nothing to trim.
  const have = buf.length - (cut - 1);
  return have < seqLen ? buf.subarray(0, cut - 1) : buf;
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, BINARY_SNIFF_BYTES));
  if (sample.includes(0)) return true; // a NUL byte never appears in valid UTF-8 text.
  const trimmed = trimIncompleteUtf8Tail(sample);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(trimmed);
    return false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// The hard deny list, applied ancestor-first so a whole denied directory still collapses to one
// status record (see the module doc) — the ONLY place `isDeniedIndexPath` is called.
// ---------------------------------------------------------------------------

type DenyOutcome = { path: string; reason: string } | 'suppressed' | null;

/**
 * Walk `relPath`'s ANCESTOR segments (never the leaf itself, first pass) against the deny list; the
 * first denied ancestor is reported ONCE per prefix (`seen` dedupes it for every deeper path under
 * it), reproducing the old walk's directory-pruning record count without the walk. A leaf that is
 * itself denied (a basename pattern, an exact tail) with no denied ancestor is checked last and
 * reported on its own path — those never collide across files, so no dedup applies to them.
 */
function classifyDenial(relPath: string, seen: Set<string>): DenyOutcome {
  const segs = relPath.split('/');
  let prefix = '';
  for (let i = 0; i < segs.length - 1; i++) {
    prefix = prefix ? `${prefix}/${segs[i]}` : segs[i]!;
    if (seen.has(prefix)) return 'suppressed';
    const reason = isDeniedIndexPath(prefix);
    if (reason) {
      seen.add(prefix);
      return { path: prefix, reason };
    }
  }
  const reason = isDeniedIndexPath(relPath);
  return reason ? { path: relPath, reason } : null;
}

// ---------------------------------------------------------------------------
// Mapping a source's small refusal vocabulary onto the one closed status enum (locked decision 7).
// An exhaustive switch, deliberately with no default: adding a reason to
// `IndexSourceRefusalReason` without updating this mapping is a compile error, not a silent gap.
// ---------------------------------------------------------------------------

function mapSourceRefusal(reason: IndexSourceRefusalReason): IndexStatusReason {
  switch (reason) {
    case 'outside-root':
      return 'outside-root';
    case 'not-a-file':
      return 'not-a-file';
    case 'not-found':
      return 'unreadable';
    case 'unreadable':
      return 'unreadable';
  }
}

// ---------------------------------------------------------------------------
// Enumeration: drain a source's (possibly unordered) list into a deterministically-sorted array of
// candidates, recording any enumeration-level refusal directly (locked decision 4).
// ---------------------------------------------------------------------------

function byPath(a: IndexSourceEntry, b: IndexSourceEntry): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

async function collectEntries(
  source: IndexSource,
  config: ResolvedIndexConfig,
  state: ScanState,
): Promise<IndexSourceEntry[]> {
  const entries: IndexSourceEntry[] = [];
  for await (const item of source.list()) {
    if (state.stop) break;
    // The wall-clock circuit breaker also bounds ENUMERATION, not only the per-file pipeline below
    // — a source whose listing alone is slow (a huge paginated depot) must not be able to outrun
    // the deadline before a single bound gets a chance to apply.
    if (deadlinePassed(state, config.readDeadlineMs)) {
      pushStatus(state, '.', 'deadline-exceeded');
      state.stop = true;
      break;
    }
    if (item.kind === 'refused') {
      pushStatus(state, item.path, mapSourceRefusal(item.reason), item.detail);
      continue;
    }
    entries.push(item.entry);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// The per-file pipeline: include → exclude → HARD DENY → bounds → read → binary → hash → status.
// ---------------------------------------------------------------------------

async function evaluateEntry(
  source: IndexSource,
  entry: IndexSourceEntry,
  config: ResolvedIndexConfig,
  state: ScanState,
): Promise<void> {
  const relPath = entry.path;

  if (deadlinePassed(state, config.readDeadlineMs)) {
    pushStatus(state, relPath, 'deadline-exceeded');
    state.stop = true;
    return;
  }

  if (state.includeRe.length > 0 && !matchesAny(state.includeRe, relPath)) {
    pushStatus(state, relPath, 'not-included');
    return;
  }
  if (matchesAny(state.excludeRe, relPath)) {
    pushStatus(state, relPath, 'excluded');
    return;
  }

  const denial = classifyDenial(relPath, state.deniedPrefixes);
  if (denial === 'suppressed') return;
  if (denial) {
    pushStatus(state, denial.path, 'denied', denial.reason);
    return;
  }

  // Aggregate bounds — read from this scan's OWN counters, never a source call. Once either
  // trips, the WHOLE scan stops: continuing would just re-derive the same exhausted-budget answer
  // for every remaining entry at real read cost.
  if (state.filesOpened >= config.maxFiles) {
    pushStatus(state, relPath, 'budget-exhausted', `max file count (${config.maxFiles}) reached`);
    state.stop = true;
    return;
  }
  if (state.totalBytesRead >= config.maxTotalBytes) {
    pushStatus(state, relPath, 'budget-exhausted', `max total bytes (${config.maxTotalBytes}) reached`);
    state.stop = true;
    return;
  }

  // A source that reports size cheaply lets an oversized file be refused WITHOUT a read at all —
  // real savings on a source where `read` means a network round trip. A source that cannot (the
  // filesystem source deliberately does not — see its doc) falls through to the read below, whose
  // own `overLimit` signal catches it exactly as it always has (proven by the `no size` acceptance
  // case using `FakeIndexSource`).
  if (entry.size !== undefined && entry.size > config.maxFileBytes) {
    pushStatus(
      state,
      relPath,
      'too-large',
      `exceeds the ${config.maxFileBytes}-byte bound (reported size ${entry.size})`,
    );
    return;
  }

  const outcome = await source.read(relPath, config.maxFileBytes);
  if (!outcome.ok) {
    pushStatus(state, relPath, mapSourceRefusal(outcome.reason), outcome.detail);
    return;
  }
  state.filesOpened += 1;
  if (outcome.overLimit) {
    pushStatus(state, relPath, 'too-large', `exceeds the ${config.maxFileBytes}-byte bound`);
    return;
  }
  if (looksBinary(outcome.bytes)) {
    pushStatus(state, relPath, 'binary');
    return;
  }
  state.totalBytesRead += outcome.bytes.length;
  const contentHash = createHash('sha256').update(outcome.bytes).digest('hex');
  state.candidates.push(
    config.contentMode === 'full'
      ? {
          path: relPath,
          bytes: outcome.bytes.length,
          content: outcome.bytes.toString('utf8'),
          contentHash,
          contentMode: 'full',
        }
      : { path: relPath, bytes: outcome.bytes.length, content: null, contentHash, contentMode: 'metadata' },
  );
}

/**
 * Scan any `IndexSource` under `[index]`'s resolved config — the source-independent policy engine
 * every backend runs through. `scanRepoForIndex` below is the filesystem-specific wrapper most
 * callers want; this is what a future source's own test suite (RUN-254/255) or a fake-source test
 * in THIS repo calls directly.
 *
 * `config: null` means indexing is OFF for this repo and this function never touches `source` at
 * all — the caller is expected to have already gated on `[index].enabled`, and this is the same
 * gate asserted a second time (locked decision 10).
 */
export async function scanIndexSource(
  source: IndexSource,
  config: ResolvedIndexConfig | null,
  deps: IndexScanDeps = {},
): Promise<IndexScanResult> {
  if (!config) {
    return {
      candidates: [],
      statuses: [],
      statusOverflow: 0,
      filesOpened: 0,
      totalBytesRead: 0,
      stoppedEarly: false,
    };
  }

  const now = deps.now ?? Date.now;
  const state: ScanState = {
    candidates: [],
    statuses: [],
    statusOverflow: 0,
    filesOpened: 0,
    totalBytesRead: 0,
    startedAt: now(),
    now,
    stop: false,
    includeRe: config.include.map(globToRegExp),
    excludeRe: config.exclude.map(globToRegExp),
    deniedPrefixes: new Set(),
  };

  const entries = await collectEntries(source, config, state);
  entries.sort(byPath);
  for (const entry of entries) {
    if (state.stop) break;
    await evaluateEntry(source, entry, config, state);
  }

  return {
    candidates: state.candidates,
    statuses: state.statuses,
    statusOverflow: state.statusOverflow,
    filesOpened: state.filesOpened,
    totalBytesRead: state.totalBytesRead,
    stoppedEarly: state.stop,
  };
}

/**
 * Enumerate `root` under `[index]`'s resolved config through the filesystem source, apply
 * include/exclude, the hard deny list, and every bound, and read what survives through
 * `openConfined`.
 *
 * `root` MUST be the already-acquired snapshot root (locked decision 5) — this never re-derives
 * it from a manifest field, an env var, or `process.cwd()`. Kept as an exact, byte-for-byte
 * signature and behaviour over `FilesystemIndexSource` (RUN-252 locked decision 5): this is
 * RUN-209's audited security surface and its adversarial suite is the evidence for the
 * THREAT-MODEL.md rows RUN-210 wrote, so a refactor that also moved this surface would make the
 * diff impossible to review as a refactor.
 */
export async function scanRepoForIndex(
  root: string,
  config: ResolvedIndexConfig | null,
  deps: IndexScanDeps = {},
): Promise<IndexScanResult> {
  const source: IndexSource = new FilesystemIndexSource(root);
  try {
    return await scanIndexSource(source, config, deps);
  } finally {
    await source.close?.();
  }
}
