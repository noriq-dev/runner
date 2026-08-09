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
 * enumerates and reads; it is never asked whether a path is wanted, and it can never answer that
 * question even if it tried, because it is never handed the deny list or a manifest's
 * include/exclude globs to consult. RUN-209's whole point was making "non-overridable" a property
 * of the WALK'S ORDER rather than of a comment saying so — a source that filtered would be a
 * second policy, and the deny list would hold only for the sources that remembered it, which is
 * the exact shape of the RUN-158 defect (a rule described as holding for a family that held only
 * for one member). So this file has no import of `index-deny.ts` or `index-policy.ts`, and that
 * absence is load-bearing, not incidental — it is the thing that makes "a source cannot filter"
 * true by construction rather than by discipline.
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
 * **Ordering is not this file's job either** (locked decision 4). `list()` yields entries in
 * whatever order is cheapest for the source to produce; `FakeIndexSource` below deliberately does
 * NOT sort, so a test using it proves the POLICY layer is what makes enumeration deterministic —
 * a source that pre-sorted would be indistinguishable, in the one test that matters, from a policy
 * that forgot to.
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
 * One source of files for the indexer (RUN-252). `FilesystemIndexSource` is the only production
 * implementation this task ships; RUN-254 (Perforce) and RUN-255 (Diversion) are deferred but this
 * is the shape they implement against.
 *
 * Implementable WITHOUT a local filesystem and WITHOUT holding the whole tree in memory (locked
 * decision 8): `list()` is an async iterable so a source may enumerate a monorepo lazily (a
 * paginated API call, a streamed `p4 files` output), and `read()` is per-path so no source is ever
 * asked to buffer more than one file's content at a time. The POLICY layer (`index-scan.ts`)
 * chooses to buffer the (small) path+size metadata it drains from `list()` in order to sort it —
 * that is a policy-side memory cost paid once for determinism, not an obligation this interface
 * places on the source.
 */
export interface IndexSource {
  /** Which source this is — for logs, never branched on by the policy layer (the same posture
   *  `VcsBackend.kind` holds: informational, not a dispatch key). */
  readonly kind: string;

  /** Enumerate every file this source can see, in any order — see the module doc for why sorting
   *  is deliberately not this method's job. */
  list(): AsyncIterable<IndexSourceListItem>;

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
 * Sorted by plain code-unit comparison, not `localeCompare` (a deliberate change from the walk this
 * replaces): a sibling order that depends on ICU locale data is not deterministic ACROSS machines,
 * which is exactly what locked decision 4 rules out. It happens to make no difference to any
 * existing candidate here — file names in these tests are plain ASCII — and the POLICY layer
 * re-sorts every entry globally regardless, so this ordering only affects which subtree gets
 * enumerated first, never which files are ultimately admitted.
 */
async function* walkFs(absDir: string, relDir: string, depth: number): AsyncGenerator<IndexSourceListItem> {
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
      yield* walkFs(childAbs, childRel, depth + 1);
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

  list(): AsyncIterable<IndexSourceListItem> {
    return walkFs(this.root, '', 0);
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
 * `list()` yields items in exactly the order they were constructed with — DELIBERATELY never
 * sorted, so a test can hand this scrambled paths and assert the POLICY layer is what produces a
 * stable order, not this source doing the policy's job for it.
 */
export class FakeIndexSource implements IndexSource {
  readonly kind = 'fake';

  constructor(
    private readonly items: FakeIndexSourceItem[],
    private readonly readOverrides: FakeIndexSourceReadOverrides = {},
  ) {}

  async *list(): AsyncIterable<IndexSourceListItem> {
    for (const item of this.items) {
      if (item.kind === 'refused') {
        yield { kind: 'refused', path: item.path, reason: item.reason, detail: item.detail };
        continue;
      }
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
