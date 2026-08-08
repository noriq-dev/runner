import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { isDeniedIndexPath } from './index-deny';
import type { ResolvedIndexConfig } from './index-policy';
import { openConfined } from './repo-context';

/**
 * Confined file discovery + bounded reads for Project Memory's indexer (RUN-209).
 *
 * This is the boundary a repo's `[index].include`/`.exclude` gets read through, so it is written
 * to be reviewed as a security artifact: read `index-deny.ts` first, then the pipeline below.
 *
 * **The pipeline, and why the order is fixed** (locked decision 2): for every path this walk
 * reaches, enumerate → include filter → exclude filter → HARD DENY → per-file bounds →
 * `openConfined` → regular-file/binary check → hash + status record. An `include` glob can never
 * re-admit a denied path because the deny check runs strictly after it and takes no input that
 * could override it. "Non-overridable" has to be a property of the ORDER, not of a comment saying
 * so — a deny consulted before include is a deny an include can undo.
 *
 * **Confinement lives in exactly one place.** Every byte this module reads goes through
 * `openConfined` (RUN-151) — open first, then require the re-resolved path inside the re-resolved
 * root AND the same inode as the held descriptor. This file never stats a path and then opens it
 * as the confinement decision: the pre-open checks below (aggregate file/byte/time budgets) read
 * only this walk's OWN counters, never the filesystem, so `openConfined` stays the sole place a
 * path is trusted. The one filesystem call this module makes on a path we do not yet trust is
 * `readdir` on a REAL directory (never a symlinked one — see the walk loop below) purely to learn
 * what is inside it; nothing is read from what it lists until that entry has separately earned an
 * `openConfined` call of its own.
 *
 * **Directories are never candidates and directory symlinks are never followed** (locked decision
 * 8). `readdir`'s `Dirent.isDirectory()` reports the entry's OWN type, never a symlink target's —
 * so the walk only recurses into REAL directories, and a symlink (to a file, a directory, a FIFO,
 * anything) is always treated as a single leaf candidate, never as something to `readdir` again.
 * That single rule is what keeps a directory symlink out of the recursion, in or out of the root,
 * without this file needing its own realpath-based containment check to prune it — `openConfined`
 * already refuses a directory symlink pointing OUTSIDE the root before it even asks whether the
 * target is a file (its containment check runs before its regular-file check), and refuses one
 * pointing INSIDE the root once it discovers the target is not a regular file. Both refusals
 * happen for free at the one place a path is actually opened.
 *
 * **This module does no parsing.** It yields file identity, size, a content hash, a status, and —
 * gated by `contentMode` — content: never language detection or entity extraction (Phase 3's job,
 * deliberately deferred so the confinement boundary is reviewable on its own, without tree-sitter
 * in the same diff).
 *
 * **`contentMode: 'metadata'` withholds source text, not the read itself** (RUN-209 follow-up,
 * closing the gap RUN-210 documented rather than fixed): the file is still opened through
 * `openConfined`, still bounded and binary-sniffed exactly as `'full'` mode reads it, and the hash
 * still covers the same bytes — citation verification (a later phase) compares hashes, and a hash
 * is a fact about bytes, never the bytes themselves. Only the decoded string is dropped before it
 * ever reaches an `IndexFileCandidate`. Which mode produced a candidate is carried ON the
 * candidate (`contentMode`), not left for a reader to re-derive from the config that made it —
 * `content` is typed `null` on the `'metadata'` branch, so "no content" and "content withheld by
 * policy" cannot be confused the way a bare nullable field would invite.
 *
 * **Binary detection is content-based**, never extension-based (locked decision 9): a NUL byte or
 * invalid UTF-8 in a bounded prefix, so a `.ts` file that is actually a binary blob is reported
 * `binary` rather than shipped as source because its name looked textual.
 *
 * **`[index].enabled` is re-asserted here** (locked decision 10), not only trusted from the
 * caller: `config: null` — which is exactly what `resolveIndexConfig` returns for every OFF or
 * invalid `[index]` — makes this function open nothing at all and return immediately.
 *
 * **What this module deliberately does NOT cover.** It takes `root` as trusted input, exactly as
 * `openConfined`'s own doc note requires: this is never re-derived from a manifest field, an env
 * var, or `process.cwd()`, and it makes no VCS call of its own (RUN-211 supplies a snapshot root
 * through this same parameter later — the seam is left that shape on purpose). It performs no
 * upper-bound clamp on the CONFIG VALUES themselves (`maxFileBytes`, `maxTotalBytes`, …) beyond
 * what `index-policy.ts` already validates — those are committed execution knobs, trusted at the
 * same level `[verify]`'s command already is, and an operator who commits an absurd bound gets the
 * cost of that bound, the same way a huge `[context]` file already costs `defaultDocReader` a
 * bounded-but-real read. An attacker who can already write to the checkout as the operator can
 * hardlink or bind-mount an outside file onto a genuinely in-repo path — `openConfined`'s own
 * comment names this limit and it applies here unchanged: that attacker is already inside the
 * boundary this module defends.
 */

/** Why a candidate path did not become an indexed file, or why the walk stopped early. Closed —
 *  extend it here, in code, never by a caller inventing a new string (locked decision 6: silence
 *  is never an outcome, so every reason a byte was NOT read has to have a name in this list). */
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
   * SHA-256 over the RAW bytes (not the decoded string), hex-encoded. Picked once, per the
   * execution spec's discretion note, and not to be changed casually: later phases (citation
   * verification) compare these hashes, so a silent algorithm swap would silently invalidate
   * every citation minted before it. Hashing the raw bytes rather than the decoded string keeps
   * the digest platform-stable — a decode/re-encode round trip is one more place two platforms
   * could disagree about a byte that never actually changed. Produced in EVERY `contentMode`,
   * because a hash is not source text — it is the fact citation verification needs, and
   * `'metadata'` mode exists to withhold the latter while still allowing the former.
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
   *  the same OOM as an unbounded read, one level up (locked decision 7) — a cap with a visible
   *  count is bounded AND honest, which a cap alone is not. */
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

/** Retained status records before overflow starts being counted instead of stored. A repo that
 *  turns on indexing without excluding a large non-source tree can otherwise refuse thousands of
 *  individual files — directory-level deny pruning (see the walk loop) keeps a whole denied
 *  subtree to ONE record, but `excluded`/`not-included` still accrue per file, so this still needs
 *  its own ceiling. 1000 is generous for an ordinary repo's worth of refusals and still bounded
 *  for a pathological one. */
export const MAX_STATUS_RECORDS = 1000;

/** Real directories can never cycle (only a symlink can, and this walk never follows one into a
 *  `readdir`), so this is a courtesy against a pathologically deep tree, not a correctness
 *  requirement — generous enough that no ordinary repo ever reaches it. */
const MAX_WALK_DEPTH = 64;

/** How much of a candidate's bytes are sniffed for binary content — the same order of magnitude
 *  git's own "contains a NUL in the first 8000 bytes" heuristic uses. A prefix, not the whole
 *  file: a legitimately huge text file should not pay a full-file UTF-8 validation just to answer
 *  a yes/no question the first few KB already answer. */
const BINARY_SNIFF_BYTES = 8_000;

export interface IndexScanDeps {
  /** Injected so a deadline test never has to actually sleep. Defaults to the real clock. */
  now?: () => number;
}

interface WalkState {
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
}

function pushStatus(state: WalkState, relPath: string, reason: IndexStatusReason, detail?: string): void {
  if (state.statuses.length < MAX_STATUS_RECORDS) {
    state.statuses.push(detail === undefined ? { path: relPath, reason } : { path: relPath, reason, detail });
  } else {
    state.statusOverflow += 1;
  }
}

function deadlinePassed(state: WalkState, deadlineMs: number): boolean {
  return state.now() - state.startedAt >= deadlineMs;
}

// ---------------------------------------------------------------------------
// Glob matching (discretion: a small dependency-free matcher).
//
// Case-SENSITIVE, unlike index-deny.ts's deliberately case-insensitive match — these are
// user-authored globs against real filesystem paths, which are case-sensitive on the platforms
// this daemon targets in practice (Linux). Containment is never decided here: a glob can name
// anything it likes, including an absolute path or a `..`-laden one, and the worst it can do is
// match NOTHING, because every candidate this matches against is already a repository-relative
// path with no leading `/` and no `..` segment — see the walk loop, which builds relative paths
// by hand rather than resolving them from a glob.
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
// Binary detection (content-based, locked decision 9).
// ---------------------------------------------------------------------------

/** Drop a trailing UTF-8 sequence that the sniff window cut in the middle of, so a prefix boundary
 *  landing mid-character is never mistaken for invalid encoding — the same "don't let the boundary
 *  lie" concern `repo-context.ts`'s `defaultDocReader` documents for its own byte/character cut. */
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
// Bounded read (mirrors `defaultDocReader`'s "read limit+1 to detect the cut" trick, in bytes
// rather than characters — there is no multi-byte-character subtlety here because the bound is a
// byte bound to begin with).
// ---------------------------------------------------------------------------

async function readBounded(fh: FileHandle, maxBytes: number): Promise<{ buf: Buffer; overLimit: boolean }> {
  const want = maxBytes + 1;
  const buf = Buffer.alloc(want);
  let filled = 0;
  for (;;) {
    const { bytesRead } = await fh.read(buf, filled, want - filled, filled);
    if (bytesRead === 0) break; // genuine EOF
    filled += bytesRead;
    if (filled >= want) break;
  }
  return filled > maxBytes
    ? { buf: buf.subarray(0, maxBytes), overLimit: true }
    : { buf: buf.subarray(0, filled), overLimit: false };
}

/** Map an `openConfined` refusal to a status reason. The swap-race message (inode identity
 *  mismatch) is folded into `outside-root`: once a descriptor's identity cannot be trusted, this
 *  reader makes no claim about what it would have read, which is exactly what `outside-root`
 *  already means for every other containment refusal here. */
function classifyOpenError(err: unknown): { reason: IndexStatusReason; detail: string } {
  const detail = err instanceof Error ? err.message : String(err);
  if (/outside the repo/.test(detail)) return { reason: 'outside-root', detail };
  if (/path changed while opening it/.test(detail)) return { reason: 'outside-root', detail };
  if (/not a regular file/.test(detail)) return { reason: 'not-a-file', detail };
  return { reason: 'unreadable', detail };
}

async function evaluateCandidate(
  absPath: string,
  relPath: string,
  root: string,
  config: ResolvedIndexConfig,
  state: WalkState,
): Promise<void> {
  if (state.stop) return;

  // Wall-clock circuit breaker, checked before spending any more work on this candidate — this is
  // deliberately OUTSIDE the include/exclude/deny/bounds pipeline decision 2 names: it is a
  // time-box on the WALK itself, not a per-file admission decision.
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
  const denyReason = isDeniedIndexPath(relPath);
  if (denyReason) {
    pushStatus(state, relPath, 'denied', denyReason);
    return;
  }

  // Aggregate bounds — read from this walk's OWN counters, never the filesystem, so
  // `openConfined` below stays the only path-based check in this pipeline (see the module
  // comment). Once either trips, the WHOLE walk stops: continuing would just re-derive the same
  // exhausted-budget answer for every remaining file at real filesystem cost.
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

  let fh: FileHandle;
  try {
    fh = await openConfined(absPath, root);
  } catch (err) {
    const { reason, detail } = classifyOpenError(err);
    pushStatus(state, relPath, reason, detail);
    return;
  }
  state.filesOpened += 1;
  try {
    const { buf, overLimit } = await readBounded(fh, config.maxFileBytes);
    if (overLimit) {
      pushStatus(state, relPath, 'too-large', `exceeds the ${config.maxFileBytes}-byte bound`);
      return;
    }
    if (looksBinary(buf)) {
      pushStatus(state, relPath, 'binary');
      return;
    }
    state.totalBytesRead += buf.length;
    const contentHash = createHash('sha256').update(buf).digest('hex');
    state.candidates.push(
      config.contentMode === 'full'
        ? {
            path: relPath,
            bytes: buf.length,
            content: buf.toString('utf8'),
            contentHash,
            contentMode: 'full',
          }
        : { path: relPath, bytes: buf.length, content: null, contentHash, contentMode: 'metadata' },
    );
  } catch (err) {
    // A read failure after a successful open (EIO, the file vanishing mid-read, …) — bounded and
    // reported, never fatal to the rest of the scan.
    pushStatus(state, relPath, 'unreadable', err instanceof Error ? err.message : String(err));
  } finally {
    await fh.close().catch(() => {});
  }
}

async function walk(
  dirAbs: string,
  dirRel: string,
  root: string,
  config: ResolvedIndexConfig,
  state: WalkState,
  depth: number,
): Promise<void> {
  if (state.stop || depth > MAX_WALK_DEPTH) return;
  if (deadlinePassed(state, config.readDeadlineMs)) {
    pushStatus(state, dirRel || '.', 'deadline-exceeded');
    state.stop = true;
    return;
  }

  let entries: Dirent[];
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch (err) {
    pushStatus(state, dirRel || '.', 'unreadable', err instanceof Error ? err.message : String(err));
    return;
  }
  // Stable order so a capped status list and a bounded walk both behave predictably run to run.
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const dirent of entries) {
    if (state.stop) return;
    const childAbs = path.join(dirAbs, dirent.name);
    // Built by hand with `/`, never `path.join`+split — `dirent.name` is always one segment, so
    // this is POSIX-spelled by construction on every platform, the same reasoning
    // `repo-context.ts`'s `repoRelative` gives for why the separator cannot be the host's.
    const childRel = dirRel ? `${dirRel}/${dirent.name}` : dirent.name;

    if (dirent.isDirectory()) {
      // A REAL directory — `Dirent.isDirectory()` reports the entry's own type, never a symlink
      // target's, so this branch can only be reached by something `readdir` itself walked into,
      // never by following a link (locked decision 8's actual mechanism; see the module comment).
      const denyReason = isDeniedIndexPath(childRel);
      if (denyReason) {
        // Prune rather than recurse-and-deny-each-file: nothing under a hard-denied directory can
        // ever be admitted, so enumerating it just to deny every entry one at a time would only
        // spend the status-record cap (and real time) on a foregone conclusion.
        pushStatus(state, childRel, 'denied', denyReason);
        continue;
      }
      await walk(childAbs, childRel, root, config, state, depth + 1);
      continue;
    }

    // Anything else — a regular file, or ANY symlink regardless of what it targets — is a single
    // leaf candidate, never something to `readdir` again. `openConfined` is what actually decides
    // its fate (outside-root, not-a-file, or admitted).
    await evaluateCandidate(childAbs, childRel, root, config, state);
  }
}

/**
 * Enumerate `root` under `[index]`'s resolved config, apply include/exclude, the hard deny list,
 * and every bound, and read what survives through `openConfined`.
 *
 * `root` MUST be the already-acquired snapshot root (locked decision 5) — this never re-derives
 * it from a manifest field, an env var, or `process.cwd()`. `config: null` means indexing is OFF
 * for this repo (`resolveIndexConfig`'s own contract) and this function opens nothing at all —
 * the caller is expected to have already gated on `[index].enabled`, and this is the same gate
 * asserted a second time, in the one place that could otherwise read a byte if that gate were
 * ever bypassed (locked decision 10).
 */
export async function scanRepoForIndex(
  root: string,
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
  const state: WalkState = {
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
  };

  await walk(root, '', root, config, state, 0);

  return {
    candidates: state.candidates,
    statuses: state.statuses,
    statusOverflow: state.statusOverflow,
    filesOpened: state.filesOpened,
    totalBytesRead: state.totalBytesRead,
    stoppedEarly: state.stop,
  };
}
