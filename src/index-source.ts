import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { openConfined } from './repo-context';

/**
 * The VCS-neutral half of the indexer's file access (RUN-252) — enumeration and per-path reads,
 * with no idea what POLICY (`index-scan.ts`) does with either.
 *
 * **Why this file exists at all.** `index-scan.ts` used to own a filesystem walk directly, so
 * every backend that wanted indexing had to first MATERIALIZE a full tree on disk before a single
 * byte could be filtered — cheap for git (a worktree costs nothing), ruinous for a
 * deliberately-large Perforce depot or a server-backed Diversion repo, and it is why RUN-211
 * shipped `unsupported` for both: the capability hole was in this seam, not in either backend.
 * Both live backends can serve file CONTENT at a revision far more cheaply than a materialized
 * tree (measured 2026-08-09): Perforce reads the depot with `p4 files@change` / `p4 print` with no
 * client workspace at all, and Diversion's REST API exposes tree/file endpoints at a commit. This
 * interface is the shape that lets a future backend (RUN-254/255, deferred — not built here) do
 * that, without POLICY caring which backend it is talking to.
 *
 * **What is deliberately NOT here.** Every filtering and bounding decision — include/exclude, the
 * hard sensitive-file deny list, every size/count/time bound, binary detection, the content hash,
 * `contentMode`, and the closed `IndexStatusReason` vocabulary — stays in `index-scan.ts`. A source
 * enumerates and reads; it is never asked to make a filtering DECISION on a file, and it can never
 * answer that question even if it tried, because it is never handed the deny list or a manifest's
 * include/exclude globs to consult. RUN-209's whole point was making "non-overridable" a property
 * of the WALK'S ORDER rather than of a comment saying so — a source that filtered would be a
 * second policy, and the deny list would hold only for the sources that remembered it, which is
 * the exact shape of the RUN-158 defect (a rule described as holding for a family that held only
 * for one member). So this file has no import of `index-deny.ts` or `index-policy.ts`, and that
 * absence is load-bearing, not incidental — it is the thing that makes "a source cannot filter"
 * true by construction rather than by discipline.
 *
 * **`list()`'s `shouldDescend` is not an exception to that** (RUN-252 follow-up, closing an
 * enumeration-cost regression this file's first cut shipped with — see `index-scan.ts`'s module
 * doc for the full accounting). It is an opaque yes/no the POLICY layer hands the source for one
 * directory at a time; this file never sees a reason, a deny-list entry, or a glob through it,
 * only a boolean answer to "descend into this or not". A source that calls it prunes for free what
 * `index-scan.ts` would otherwise enumerate in full just to collapse to one status record after
 * the fact (a `.git` with thousands of loose objects, paid on every index). A source that ignores
 * the predicate entirely widens nothing: every file it enumerates anyway still meets the SAME
 * per-file deny check `index-scan.ts` always ran, so the floor holds either way — the predicate
 * buys back the walk cost, never the security property.
 *
 * **Confinement is a per-source guarantee, not a per-interface one** (locked decision 2).
 * `FilesystemIndexSource` below is `openConfined`'s existing contract, completely unchanged: open
 * first, then prove the descriptor is the same inode as the re-resolved, re-contained path. That
 * defends a filesystem TOCTOU race — a symlink or a parent directory swapped out from under a path
 * between the time it was checked and the time it was read. Neither a depot read nor an HTTP read
 * has that race: there is no local path to swap out from under `p4 print` or a `GET` request.
 * Demanding an inode-identity check from every future source would be cargo-culting a defense
 * against a threat that source does not face — but the GUARANTEE `openConfined` provides (this
 * source cannot be made to read outside the repository it was scoped to) has to be re-established
 * by whatever mechanism actually fits that source's own trust model, stated in its own doc comment
 * — RUN-254/255 (deferred) inherit that obligation, not this file's specific mechanism.
 *
 * **Ordering IS this file's job now** (locked decision 4, restated — RUN-252 follow-up). The first
 * cut of this split read "enumeration is deterministic per source: a stable sort by
 * repository-relative path" as leaving the SORTING to whichever layer wanted it, so
 * `index-scan.ts` drained every entry into an array and sorted it globally — for
 * `FilesystemIndexSource`, which already walks siblings sorted-then-recurse (see `walkFs` below),
 * that re-sort bought determinism the source had already paid for, at the cost of buffering the
 * whole enumeration before a single bound could apply. The obligation belongs to the SOURCE,
 * because only the source knows what "cheap" order looks like for it (a depot listing, an API
 * page) and can pay for a sort once instead of the policy layer buffering everything to redo it
 * later. `IndexSource.list`'s own doc below states the requirement and why; `FakeIndexSource`
 * yields sorted by default so a policy-layer test exercises the REAL contract, with an explicit
 * opt-out to play a source that breaks it — see `index-scan.ts`'s module doc for how a broken
 * contract is detected rather than silently repaired.
 */

/**
 * One file this source knows about, before any policy decision has touched it.
 *
 * `path` is repository-relative and POSIX-separated — the same spelling `index-deny.ts` matches
 * against and `VcsBackend.changesBetween`'s doc requires of every path crossing this seam. A
 * source's OWN containment guarantee (see the module doc) is what keeps this path honest; the
 * policy layer does not re-derive or re-validate it beyond the string matching include/exclude/deny
 * already do on any string.
 */
export interface IndexSourceEntry {
  path: string;
  /**
   * Byte size, when the source can report it without paying for a read — `readdir`+`stat` for the
   * filesystem, `fstat -Ol` for Perforce, not always available from an API's listing endpoint.
   * Absent is a real, expected answer, not a defect: `index-scan.ts`'s bounds layer treats a
   * missing size as "ask the read", never as "unbounded" — see `evaluateEntry`'s comment there for
   * why `FilesystemIndexSource` chooses to leave this unset even though it COULD stat every entry
   * (RUN-252 discretion): the size the bound actually needs is answered for free by the same
   * bounded read this file already used to make, one call, not two.
   */
  size?: number;
}

/**
 * Why a source could not deliver a path's bytes. Small and source-agnostic on purpose — this is
 * NOT `IndexStatusReason` (locked decision 7): a second closed vocabulary for the same question is
 * how a status becomes untallyable, so the policy layer owns the ONE enum callers actually read,
 * and `index-scan.ts`'s `mapSourceRefusal` is the single place these fold onto it. Extend THIS
 * union only when a source hits an outcome none of these four name (a timeout, a rate limit) —
 * and extend the mapping in the same change, since an unmapped reason is a compile error, not a
 * silently-dropped one.
 */
export type IndexSourceRefusalReason = 'not-found' | 'not-a-file' | 'outside-root' | 'unreadable';

/**
 * The outcome of `IndexSource.read`. `overLimit` on the `ok:true` arm is MECHANICAL, never a
 * decision: the source stopped reading after `maxBytes` (+1, to detect the cut) because the
 * POLICY layer told it to, exactly the efficiency `readBounded` always bought — the source is not
 * deciding the file is too large, it is reporting that more bytes existed past the point it was
 * asked to stop at. Locked decision 1's "a source never enforces a bound" is about a source
 * REFUSING or FILTERING on its own judgement; being handed a mechanical stop point by the caller
 * and reporting whether it was hit is not that.
 */
export type IndexSourceReadOutcome =
  | { ok: true; bytes: Buffer; overLimit: boolean }
  | { ok: false; reason: IndexSourceRefusalReason; detail?: string };

/**
 * One item out of `IndexSource.list()`. Almost always `file`; `refused` exists for an enumeration
 * problem that is not about any ONE candidate path — an unreadable directory, a subtree a source
 * cannot list — the same "no silent drops" instinct `repo-context.ts`'s `UnresolvedPath` encodes:
 * a walk that silently produced fewer files than the tree actually has is worse than one that
 * says where it gave up. `path` here names what could not be listed (a directory, a prefix), not
 * a candidate file, so the policy layer records it directly as a status without running it through
 * include/exclude/deny — those questions are about FILES this source is offering, and an
 * enumeration failure never got far enough to offer one.
 */
export type IndexSourceListItem =
  | { kind: 'file'; entry: IndexSourceEntry }
  | { kind: 'refused'; path: string; reason: IndexSourceRefusalReason; detail?: string };

/**
 * Whether a source should descend into one directory during `list()` — the POLICY layer's own
 * judgement, handed down as a plain boolean function so the source never has to know WHY (RUN-252
 * follow-up; see the module doc's "not an exception" note). `relDirPath` is repository-relative
 * and POSIX-separated, the same spelling every other path crossing this seam uses. A source that
 * calls this and gets `false` owes the policy layer no record for what it skipped — the caller
 * that answered `false` already knows, and has done its own bookkeeping before answering.
 */
export type ShouldDescend = (relDirPath: string) => boolean;

/**
 * One source of files for the indexer (RUN-252). `FilesystemIndexSource` is the only production
 * implementation this task ships; RUN-254 (Perforce) and RUN-255 (Diversion) are deferred but this
 * is the shape they implement against.
 *
 * Implementable WITHOUT a local filesystem and WITHOUT holding the whole tree in memory (locked
 * decision 8): `list()` is an async iterable so a source may enumerate a monorepo lazily (a
 * paginated API call, a streamed `p4 files` output), and `read()` is per-path so no source is ever
 * asked to buffer more than one file's content at a time. The POLICY layer (`index-scan.ts`)
 * streams `list()`'s output rather than buffering and re-sorting it (RUN-252 follow-up) — see
 * `list`'s own doc for the ordering contract that makes streaming safe.
 */
export interface IndexSource {
  /** Which source this is — for logs, never branched on by the policy layer (the same posture
   *  `VcsBackend.kind` holds: informational, not a dispatch key). */
  readonly kind: string;

  /**
   * Enumerate every file this source can see.
   *
   * MUST yield in a deterministic, stable order for a given base — repository-relative path,
   * plain code-unit comparison, never locale-aware (a sort whose result depends on ICU data is
   * not reproducible across machines). This is not a courtesy: the policy layer (`index-scan.ts`)
   * streams this output and applies `maxFiles`/`maxTotalBytes`/the deadline AS IT ARRIVES instead
   * of draining and re-sorting first (RUN-252 follow-up, locked decision 4 restated), so a source
   * that reorders the same tree between two runs would make `stoppedEarly`'s "prefix of the repo"
   * mean a DIFFERENT prefix each time. That matters beyond one run: the idempotency key a batch is
   * split under is (project, repo, branch, baseId, indexer version, batch number) — two runs of
   * the SAME snapshot only split the same tree into the same batches if enumeration order is
   * stable. `FilesystemIndexSource` below meets this by walking siblings sorted-then-recursing;
   * a future backend (RUN-254/255) meets it however fits its own listing call (many APIs, and
   * `p4 files`, already return path-sorted output for free — measured, not assumed).
   *
   * `shouldDescend`, when supplied, is an opaque yes/no for one directory at a time — see
   * `ShouldDescend`'s doc. Calling it before recursing into a directory is how a source avoids
   * enumerating a subtree the policy layer would only collapse to one status record afterwards;
   * ignoring it changes nothing about which files are ultimately admitted, only how much walk time
   * it costs to reach the same per-file deny check.
   */
  list(shouldDescend?: ShouldDescend): AsyncIterable<IndexSourceListItem>;

  /**
   * Read one file's bytes, stopping after `maxBytes` (+1, to detect a cut without buffering an
   * arbitrarily larger file) — see `IndexSourceReadOutcome`'s doc for why this is a mechanical
   * stop point, not a bound the source is enforcing on its own initiative. `path` is exactly one
   * of the paths this source's own `list()` produced.
   */
  read(path: string, maxBytes: number): Promise<IndexSourceReadOutcome>;

  /**
   * A source-native digest for cheap same-source change detection (locked decision 3) — Perforce's
   * `digest`, an API blob's `sha`. Optional, unused by anything in this task: nothing in
   * `index-scan.ts` calls it yet, and nothing may EVER treat it as the index's content hash or
   * compare it across two different sources — that hash is `index-scan.ts`'s own SHA-256 over the
   * bytes it read, one algorithm for every source, because citation verification (a later phase)
   * compares an indexed hash against a live worktree hashed the same way.
   */
  digest?(path: string): Promise<string | undefined>;

  /** Release whatever this source held open (a paginated cursor, a pooled connection). Optional;
   *  `FilesystemIndexSource` has nothing to close, and a caller always uses `?.()`. */
  close?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// The filesystem source — today's walk, unchanged in behaviour, moved here.
// ---------------------------------------------------------------------------

/** Same courtesy the old walk gave: real directories can never cycle, so this only guards a
 *  pathologically deep tree, not a correctness requirement. */
const MAX_WALK_DEPTH = 64;

/** Mirrors `defaultDocReader`'s "read limit+1 to detect the cut" trick, in bytes. */
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

/** Map an `openConfined` refusal onto this source's small refusal vocabulary. The swap-race
 *  message (inode identity mismatch) folds into `outside-root`: once a descriptor's identity
 *  cannot be trusted, this source makes no claim about what it would have read. */
function classifyOpenError(err: unknown): { reason: IndexSourceRefusalReason; detail: string } {
  const detail = err instanceof Error ? err.message : String(err);
  if (/outside the repo/.test(detail)) return { reason: 'outside-root', detail };
  if (/path changed while opening it/.test(detail)) return { reason: 'outside-root', detail };
  if (/not a regular file/.test(detail)) return { reason: 'not-a-file', detail };
  return { reason: 'unreadable', detail };
}

/**
 * Depth-first, sorted-siblings-then-recurse walk — a REAL directory only (`Dirent.isDirectory()`
 * reports the entry's own type, never a symlink target's), so a symlink of any kind is always a
 * single leaf entry, never something this recurses into. That single rule is what keeps a
 * directory symlink out of the recursion, in or out of the root, without this function needing its
 * own realpath-based containment check — `openConfined` (in `read()`) already refuses a directory
 * symlink pointing outside the root, and refuses one pointing inside once it discovers the target
 * is not a regular file. Both refusals happen for free at the one place a path is actually opened.
 *
 * Sorted by plain code-unit comparison, not `localeCompare`: a sibling order that depends on ICU
 * locale data is not deterministic ACROSS machines, which is exactly what `IndexSource.list`'s
 * doc requires. This is no longer a courtesy the policy layer re-derives for us — `index-scan.ts`
 * streams this output directly and relies on it being genuinely sorted (RUN-252 follow-up), so an
 * ordering bug here would be a contract violation the policy layer refuses loudly rather than
 * masks.
 *
 * `shouldDescend`, when supplied, is consulted before EVERY recursion, never before yielding a
 * leaf — pruning is a directory-level decision (see `ShouldDescend`'s doc). A denied directory is
 * never `readdir`'d at all: the caller already knows and has recorded whatever it needed to
 * before answering `false`, which is the whole point (the regression this closes paid for a full
 * `readdir` of a `.git` with thousands of loose objects just to throw the result away afterwards).
 */
async function* walkFs(
  absDir: string,
  relDir: string,
  depth: number,
  shouldDescend?: ShouldDescend,
): AsyncGenerator<IndexSourceListItem> {
  if (depth > MAX_WALK_DEPTH) return;

  let entries: Dirent[];
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch (err) {
    yield {
      kind: 'refused',
      path: relDir || '.',
      reason: 'unreadable',
      detail: err instanceof Error ? err.message : String(err),
    };
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const dirent of entries) {
    const childAbs = path.join(absDir, dirent.name);
    // Built by hand with `/`, never `path.join`+split — `dirent.name` is always one segment, so
    // this is POSIX-spelled by construction on every platform (`repo-context.ts`'s `repoRelative`
    // gives the same reasoning for why the separator cannot be the host's).
    const childRel = relDir ? `${relDir}/${dirent.name}` : dirent.name;

    if (dirent.isDirectory()) {
      if (shouldDescend && !shouldDescend(childRel)) continue; // pruned — no readdir, no yield.
      yield* walkFs(childAbs, childRel, depth + 1, shouldDescend);
    } else {
      // Anything else — a regular file, or ANY symlink regardless of what it targets — is a
      // single leaf candidate. `read()` is what actually decides its fate. No size is offered:
      // see `IndexSourceEntry.size`'s doc for why this source leaves it to the bounded read.
      yield { kind: 'file', entry: { path: childRel } };
    }
  }
}

/**
 * `openConfined` remains the sole confined reader, unchanged (locked decision 2). `root` is
 * trusted input, exactly as `openConfined`'s own doc requires: never re-derived from a manifest
 * field, an env var, or `process.cwd()` — the caller (`index-scan.ts`'s `scanRepoForIndex`) is the
 * one place that owns getting this right, same as it always was.
 */
export class FilesystemIndexSource implements IndexSource {
  readonly kind = 'filesystem';

  constructor(private readonly root: string) {}

  list(shouldDescend?: ShouldDescend): AsyncIterable<IndexSourceListItem> {
    return walkFs(this.root, '', 0, shouldDescend);
  }

  async read(relPath: string, maxBytes: number): Promise<IndexSourceReadOutcome> {
    const absPath = path.join(this.root, ...relPath.split('/'));
    let fh: FileHandle;
    try {
      fh = await openConfined(absPath, this.root);
    } catch (err) {
      return { ok: false, ...classifyOpenError(err) };
    }
    try {
      const { buf, overLimit } = await readBounded(fh, maxBytes);
      return { ok: true, bytes: buf, overLimit };
    } catch (err) {
      // A read failure after a successful open (EIO, the file vanishing mid-read, …) — bounded
      // and reported, never a throw the caller has to catch.
      return { ok: false, reason: 'unreadable', detail: err instanceof Error ? err.message : String(err) };
    } finally {
      await fh.close().catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// The fake in-memory source — exported so a policy-layer test needs no filesystem, and so
// RUN-254/255 can reuse it for their own backend-shaped tests (RUN-252 discretion).
// ---------------------------------------------------------------------------

/** One entry to seed a `FakeIndexSource` with. `size: null` means "report no size" (the case
 *  `index-scan.ts`'s bounds layer must still enforce via the read's `overLimit` signal); omitting
 *  `size` defaults it to the content's own byte length. */
export type FakeIndexSourceItem =
  | { kind: 'file'; path: string; content: string | Buffer; size?: number | null }
  | { kind: 'refused'; path: string; reason: IndexSourceRefusalReason; detail?: string };

/** A read-time refusal for a path this source DID list — simulates a file that existed at
 *  enumeration but could not be delivered (a depot object deleted between listing and print, a
 *  timed-out fetch), distinct from `FakeIndexSourceItem`'s `refused` kind, which never reaches the
 *  per-file pipeline at all. */
export type FakeIndexSourceReadOverrides = Record<
  string,
  { reason: IndexSourceRefusalReason; detail?: string }
>;

/**
 * An in-memory `IndexSource` with no filesystem involved — the vehicle for proving `index-scan.ts`
 * is genuinely source-independent (RUN-252's central acceptance claim) rather than merely
 * refactored around one.
 *
 * `list()` yields sorted by path BY DEFAULT — a well-behaved source, meeting `IndexSource.list`'s
 * ordering contract exactly as `FilesystemIndexSource` does — so a policy-layer test using the
 * default constructor exercises the REAL contract rather than the scramble-then-re-sort shape that
 * hid the RUN-252 drain-and-sort regression in the first place. Pass `{ scrambled: true }` to play
 * a source that BREAKS the contract instead, for the one test that needs to exercise
 * `index-scan.ts`'s out-of-order handling.
 */
export class FakeIndexSource implements IndexSource {
  readonly kind = 'fake';

  constructor(
    private readonly items: FakeIndexSourceItem[],
    private readonly readOverrides: FakeIndexSourceReadOverrides = {},
    private readonly options: { scrambled?: boolean } = {},
  ) {}

  async *list(shouldDescend?: ShouldDescend): AsyncIterable<IndexSourceListItem> {
    const ordered = this.options.scrambled
      ? this.items
      : [...this.items].sort((a, b) => comparePaths(a.path, b.path));
    for (const item of ordered) {
      if (item.kind === 'refused') {
        yield { kind: 'refused', path: item.path, reason: item.reason, detail: item.detail };
        continue;
      }
      // No real directories to prune here, so this source honours `shouldDescend` by checking
      // every ANCESTOR segment of the candidate itself (see `passesShouldDescend`) — the same
      // outcome `FilesystemIndexSource` gets from never `readdir`-ing a denied directory, without
      // this source needing to model directories as first-class entries at all.
      if (shouldDescend && !passesShouldDescend(item.path, shouldDescend)) continue;
      const size = item.size === null ? undefined : (item.size ?? byteLength(item.content));
      yield { kind: 'file', entry: { path: item.path, size } };
    }
  }

  async read(relPath: string, maxBytes: number): Promise<IndexSourceReadOutcome> {
    const override = this.readOverrides[relPath];
    if (override) return { ok: false, ...override };
    const item = this.items.find((i): i is Extract<FakeIndexSourceItem, { kind: 'file' }> => {
      return i.kind === 'file' && i.path === relPath;
    });
    if (!item) {
      return { ok: false, reason: 'not-found', detail: `no such file in this fake source: ${relPath}` };
    }
    const buf = Buffer.isBuffer(item.content) ? item.content : Buffer.from(item.content, 'utf8');
    const overLimit = buf.length > maxBytes;
    return { ok: true, bytes: overLimit ? buf.subarray(0, maxBytes) : buf, overLimit };
  }
}

function byteLength(content: string | Buffer): number {
  return Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content, 'utf8');
}

/**
 * Plain code-unit path comparison — never locale-aware, the same reasoning `walkFs`'s sibling sort
 * gives (see its doc). Exported so `index-scan.ts` checks a source's actual output against the
 * SAME comparator this file uses to produce it, rather than restating the rule and risking the two
 * drifting apart.
 */
export function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Mirrors `FilesystemIndexSource`'s own directory-level pruning (see `walkFs`) for a source with
 * no real directories of its own: checked ANCESTOR-first, so the first denied prefix stops the
 * check immediately — exactly as a real walk never `readdir`s past it — rather than asking about
 * every deeper segment too.
 */
function passesShouldDescend(relPath: string, shouldDescend: ShouldDescend): boolean {
  const segs = relPath.split('/');
  let prefix = '';
  for (let i = 0; i < segs.length - 1; i++) {
    prefix = prefix ? `${prefix}/${segs[i]}` : segs[i]!;
    if (!shouldDescend(prefix)) return false;
  }
  return true;
}
