import { spawn } from 'node:child_process';
import type {
  IndexSource,
  IndexSourceListItem,
  IndexSourceReadOutcome,
  ShouldDescend,
} from '../index-source';
import { comparePaths } from '../index-source';
import type { P4Cli } from './perforce';

/**
 * Perforce's DEPOT half of the indexer's file access (RUN-254) — the seam `index-source.ts`
 * describes as "implementable without a local filesystem" made real for the backend that most
 * needed it: RUN-211 shipped `unsupported` here for want of a measured read-only path, and RUN-212
 * shipped `full-index-required` for `changesBetween` for the same reason. Both are now measured
 * against a real p4d (`scripts/p4d-rig/`, RUN-253) rather than assumed, and the facts below are the
 * design, not decoration on it.
 *
 * **This source materializes NOTHING** (locked decision 1) — no client, no sync, no workspace.
 * Every query below (`p4 files`, `p4 -Ztag fstat -Ol`, `p4 print -q`, `p4 diff2 -q`) was measured to
 * succeed with `P4CLIENT=no-such-client-at-all`: a depot read needs no workspace and no pool lease,
 * which is *why* `PerforceBackend.leaseIndexSnapshot` never contends with a run's pool-of-1 lease
 * the way the old `unsupported` answer implied it eventually would. `list()`/`read()`/`digest()`
 * below therefore take a `(prefix, change)` pair — a depot path pattern ending in Perforce's own
 * `...` wildcard, and the changelist it is pinned at — and nothing else.
 *
 * **Containment (locked decision 9, `openConfined`'s obligation restated for a source with no
 * filesystem at all).** What this guarantees: every depot path this source ever reads is built by
 * concatenating `prefix`'s literal base onto a repository-relative path, and `prefix` itself is
 * never caller-supplied free text — `PerforceBackend.leaseIndexSnapshot` reads it from the
 * OPERATOR's own configured Perforce client (`p4 client -o`'s `View:` line), the same trust
 * `clientName`/`ensureAllwrite` already place in that spec elsewhere in this file. So a repo's own
 * committed manifest cannot smuggle in a different depot subtree the way `index-deny.ts`'s module
 * doc worries `[index].include` could. `read()`/`digest()` additionally refuse a `relPath`
 * containing a `..` or `.` segment, or a leading `/`, before it is ever concatenated — the cheap,
 * confident half of containment. What this does NOT cover: Perforce's own escaping for a filename
 * that itself contains `@ # % *` (its wildcard/revision syntax characters) — this source neither
 * escapes nor unescapes them, so a real depot file named with one of those characters is an
 * unverified edge case (no fixture in the rig exercises it), not a guaranteed-safe or
 * guaranteed-broken path. And unlike `openConfined`'s inode-identity check, there is no local file
 * descriptor to race here — a depot read at a fixed changelist cannot be swapped out from under
 * itself the way a symlink can, so this source closes a different, narrower door than that one.
 *
 * **The digest is Perforce's, MD5, and never the index's content hash** (locked decision 2/3,
 * `IndexSource.digest`'s own doc restated with the measured field name): `-Ztag fstat -Ol`'s tag is
 * `digest`, not `headDigest` — the latter parses without error and returns EMPTY, a silent wrong
 * answer rather than a loud one, measured directly against the rig. `list()` below caches it
 * per-path purely as a byproduct of the one `fstat` call that already produced it, for `digest()`'s
 * benefit; nothing in `index-scan.ts` calls `digest()` today, and nothing may ever store it as the
 * content hash — that is SHA-256 over the bytes this module's caller reads, computed once for every
 * source alike.
 *
 * **A listing at a changelist INCLUDES deletions, and `headAction` is what says so** (locked
 * decision 4, measured): `//depot/docs/OLD.md#2 - delete change 2` is a real line in `p4 files`' —
 * and `fstat`'s — output for a path that does not exist at that base. `list()` below drops any
 * record whose `headAction` is `delete` or `move/delete` before it ever becomes a candidate; a
 * `move` needs no synthesis (locked decision 6) because `move/add` at the new path and
 * `move/delete` at the old one are already two separate, independently-filtered records.
 *
 * **A deleted-at-this-revision path prints SILENTLY EMPTY through `print -q`, not an error**
 * (measured, and the reason the `headAction` filter above is a correctness requirement, not merely
 * an efficiency one): `p4 print -q //depot/docs/OLD.md@2` for the SAME revision `p4 files` reports
 * as deleted exits 0 with empty stdout AND empty stderr — indistinguishable from a genuinely
 * empty file at the bytes-and-exit-code level. A totally unknown path (never existed) is at least
 * reported on stderr (`"... - no such file(s)."`, still exit 0); a path that exists but not yet at
 * this revision answers `"... - no file(s) at that changelist number."`, also exit 0. `read()`
 * recognizes those two messages as `not-found`; the deleted-at-this-revision case has no message to
 * recognize at all, which is why this source's contract — `read()` is only ever asked for a path
 * THIS source's own `list()` produced (`IndexSource.read`'s own doc, verbatim) — is load-bearing
 * here in a way it usually is not: a caller that invented a path `list()` had already excluded
 * would get back a phantom zero-byte "file" with no signal that anything was wrong.
 *
 * **Ordering needs no re-sort discipline of its own, and `shouldDescend` is never called.**
 * `IndexSource.list`'s ordering contract is real here too, but for a different reason than
 * `FilesystemIndexSource`'s: a single `fstat -Ol <prefix>@<change>` call already returns the WHOLE
 * tree's metadata in one round trip — there is no lazy, resumable walk to interrupt, so sorting the
 * already-fully-buffered result array costs nothing beyond what the one p4 call already cost (measured
 * path-sorted in the rig's small sample, matching this file's own defensive sort rather than trusting
 * it blindly — see `list()` below). `shouldDescend`, correspondingly, is accepted (the interface
 * requires it) but never invoked: honoring it would mean one `fstat` call per un-denied directory —
 * trading one cheap round trip for many, the opposite of what pruning bought `FilesystemIndexSource`
 * (avoiding a `readdir` of a directory this source was never going to enumerate one file at a time
 * anyway). Ignoring it costs nothing else: every record this source enumerates still meets
 * `index-scan.ts`'s own per-file deny check, exactly as `IndexSource.list`'s doc promises for a
 * source that skips the predicate.
 *
 * **`P4RawCli` is Buffer-safe on purpose — `P4Cli` (`perforce.ts`) is not, and must not be reused
 * for `print`.** `PerforceBackend`'s existing string-based runner accumulates a child process's
 * stdout with `stdout += d` — a `Buffer`-to-string coercion through the default UTF-8 encoding,
 * fine for the specs and merge3 markers it was built for, but LOSSY for arbitrary depot bytes: a
 * byte sequence that is not valid UTF-8 decodes to the replacement character U+FFFD and re-encodes
 * to a DIFFERENT byte sequence than the depot holds. `src/blob.bin` (the rig's binary fixture, 4096
 * random bytes) is exactly the case that would silently corrupt through that path. `read()` below
 * therefore takes its own `P4RawCli`, which never touches a string until a caller explicitly asks
 * for one (`fstat`/`describe`/`diff2` output, always plain text, still go through the ordinary
 * `P4Cli`).
 */

/** Injectable, Buffer-only p4 invocation for the depot source's content reads (`print`) — see the
 *  module doc for why `P4Cli` (string-based) cannot serve this role. Resolves rather than rejects on
 *  a nonzero exit: several of the outcomes this source cares about (a path absent at a revision, an
 *  unknown path) arrive as an EXIT-0 message on stderr, not a failure, and the code the process
 *  actually left with is still worth reporting for a call site that treats that itself as the news
 *  — never absorbed into a thrown `Error`'s message string the way `P4Cli` does. */
export type P4RawCli = (
  args: string[],
  cwd: string,
) => Promise<{ stdout: Buffer; stderr: Buffer; code: number }>;

export const realP4RawCli: P4RawCli = (args, cwd) =>
  new Promise((resolve, reject) => {
    // Same PWD-matching requirement as `perforce.ts`'s `realP4Cli`, for the same measured reason:
    // p4 trusts PWD over the process's actual cwd when resolving P4CONFIG.
    const child = spawn('p4', args, {
      cwd,
      env: { ...process.env, PWD: cwd },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => stdout.push(d));
    child.stderr.on('data', (d: Buffer) => stderr.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: code ?? -1 });
    });
  });

/** Head actions meaning "absent at this base" (locked decision 4) — measured exhaustively against
 *  the rig's own delete and move fixtures; an exotic action this list does not name (a purge, on a
 *  server configured with limited revision history) falls through as PRESENT, which costs an index
 *  entry for a path that may not resolve rather than silently dropping one that does — the same
 *  direction every uncertain call in this file leans. */
const DELETED_HEAD_ACTIONS = new Set(['delete', 'move/delete']);

interface FstatRecord {
  depotFile: string;
  headAction: string;
  fileSize?: number;
  digest?: string;
}

/**
 * Parse `p4 -Ztag fstat -Ol`'s block-per-file text output (measured against the rig): blocks
 * separated by a blank line, each line `... field value`. A block missing `depotFile` or
 * `headAction` is dropped rather than half-recorded — both are present on every measured record,
 * so a block without them is a parse failure this function absorbs by omission (`list()`'s caller
 * only ever sees a shorter, honest list, never a record with a hole in it).
 */
function parseFstatBlocks(raw: string): FstatRecord[] {
  const records: FstatRecord[] = [];
  for (const block of raw.split(/\n\s*\n/)) {
    const fields = new Map<string, string>();
    for (const line of block.split('\n')) {
      const m = line.match(/^\.\.\. (\S+) (.*)$/);
      if (m?.[1] !== undefined && m[2] !== undefined) fields.set(m[1], m[2]);
    }
    const depotFile = fields.get('depotFile');
    const headAction = fields.get('headAction');
    if (!depotFile || !headAction) continue;
    const sizeRaw = fields.get('fileSize');
    records.push({
      depotFile,
      headAction,
      fileSize: sizeRaw !== undefined && /^\d+$/.test(sizeRaw) ? Number(sizeRaw) : undefined,
      digest: fields.get('digest'),
    });
  }
  return records;
}

/** The literal depot path a `prefix` (ending in Perforce's `...` wildcard) names before the
 *  wildcard — `//depot/...` → `//depot/`, `//depot/proj/...` → `//depot/proj/`. */
function prefixBase(prefix: string): string {
  return prefix.endsWith('...') ? prefix.slice(0, -3) : prefix;
}

/**
 * Strip a snapshot's depot prefix off a full depot path, returning the repository-relative,
 * POSIX-separated remainder `index-deny.ts` and `ChangesBetweenResult`'s doc both require — or
 * `null` when `depotFile` is not actually under `prefix` (defensive: nothing p4 itself reports
 * under a prefix-scoped query should ever fail this, so a caller treats it as "skip", never
 * "crash", the same posture `PerforceBackend`'s own `relative()` takes for a conflict path outside
 * the workspace). Exported for `PerforceBackend.changesBetween`'s own `diff2` parsing, which needs
 * the identical relativization.
 */
export function stripDepotPrefix(prefix: string, depotFile: string): string | null {
  const base = prefixBase(prefix);
  return depotFile.startsWith(base) ? depotFile.slice(base.length) : null;
}

/** Refuses a `relPath` before it is ever concatenated into a depot path argument — the cheap half
 *  of containment the module doc names. A path `list()` itself produced never trips this; only a
 *  caller handing back something else could. */
function escapesRoot(relPath: string): boolean {
  if (relPath.startsWith('/')) return true;
  return relPath.split('/').some((seg) => seg === '..' || seg === '.' || seg === '');
}

export interface PerforceDepotIndexSourceOpts {
  /** Plain-text p4 runner — `fstat`/`describe` output is always ASCII metadata, never depot
   *  content, so the UTF-8 coercion `P4Cli` (`perforce.ts`) performs is safe here. */
  p4: P4Cli;
  /** Buffer-only p4 runner, for `print` alone — see the module doc's binary-safety note. */
  p4Raw: P4RawCli;
  /** Where p4 resolves its connection (P4CONFIG discovery) — the same `repoRoot` every other
   *  `PerforceBackend` call uses, so this source shares ONE connection story with the rest of the
   *  backend rather than inventing its own. Never itself a workspace this source writes into. */
  cwd: string;
  /** A depot path pattern ending in `...`, read from the operator's own client View — see the
   *  module doc's containment note for why this is trusted input, not caller-supplied. */
  prefix: string;
  /** The changelist this snapshot is pinned at, in Perforce's own id-space. */
  change: string;
}

/**
 * `IndexSource` over a Perforce depot subtree at a fixed changelist (RUN-254). See the module doc
 * for the full measured design; this class is the mechanical half of it.
 */
export class PerforceDepotIndexSource implements IndexSource {
  readonly kind = 'perforce-depot';
  private readonly digestCache = new Map<string, string>();

  constructor(private readonly opts: PerforceDepotIndexSourceOpts) {}

  /**
   * One `fstat -Ol` call enumerates the WHOLE scoped subtree at `change` — see the module doc's
   * ordering note for why the defensive sort below is free rather than a "drain before bounding"
   * regression, and for why `shouldDescend` is accepted but never called.
   */
  async *list(_shouldDescend?: ShouldDescend): AsyncIterable<IndexSourceListItem> {
    const { prefix, change, cwd, p4 } = this.opts;
    let stdout: string;
    try {
      ({ stdout } = await p4(['-Ztag', 'fstat', '-Ol', `${prefix}@${change}`], cwd));
    } catch (err) {
      yield {
        kind: 'refused',
        path: '.',
        reason: 'unreadable',
        detail: err instanceof Error ? err.message : String(err),
      };
      return;
    }

    const items: { path: string; size?: number }[] = [];
    for (const rec of parseFstatBlocks(stdout)) {
      if (DELETED_HEAD_ACTIONS.has(rec.headAction)) continue; // absent at this base — locked decision 4
      const rel = stripDepotPrefix(prefix, rec.depotFile);
      if (rel === null) continue;
      if (rec.digest) this.digestCache.set(rel, rec.digest);
      items.push({ path: rel, size: rec.fileSize });
    }
    items.sort((a, b) => comparePaths(a.path, b.path));
    for (const item of items) yield { kind: 'file', entry: { path: item.path, size: item.size } };
  }

  /** See the module doc's "deleted-at-this-revision prints silently empty" note: this trusts its
   *  caller to only ever pass a path this source's own `list()` produced, exactly as
   *  `IndexSource.read`'s interface doc requires of every source. */
  async read(relPath: string, maxBytes: number): Promise<IndexSourceReadOutcome> {
    if (escapesRoot(relPath)) {
      return {
        ok: false,
        reason: 'outside-root',
        detail: `refusing to build a depot path from ${JSON.stringify(relPath)}`,
      };
    }
    const { prefix, change, cwd, p4Raw } = this.opts;
    const depotFile = `${prefixBase(prefix)}${relPath}`;
    let result: { stdout: Buffer; stderr: Buffer; code: number };
    try {
      result = await p4Raw(['print', '-q', `${depotFile}@${change}`], cwd);
    } catch (err) {
      return { ok: false, reason: 'unreadable', detail: err instanceof Error ? err.message : String(err) };
    }
    if (result.code !== 0) {
      return {
        ok: false,
        reason: 'unreadable',
        detail: result.stderr.toString('utf8').trim() || `p4 print exited ${result.code}`,
      };
    }
    // Both measured "absent" messages arrive on stderr despite an exit-0 success (the same
    // "emptiness is an answer" shape `perforce.ts`'s `P4_NOTHING_HERE` already handles for
    // `opened`/`reconcile`) — a genuinely present file never writes to stderr at all.
    const stderrText = result.stderr.toString('utf8');
    if (/no such file\(s\)|no file\(s\) at that changelist/i.test(stderrText)) {
      return { ok: false, reason: 'not-found', detail: stderrText.trim() };
    }
    const overLimit = result.stdout.length > maxBytes;
    return { ok: true, bytes: overLimit ? result.stdout.subarray(0, maxBytes) : result.stdout, overLimit };
  }

  /** Serves `list()`'s own cache when available — `fstat -Ol` already paid for this digest once;
   *  a path never enumerated by THIS instance's `list()` falls back to a fresh, single-path fetch. */
  async digest(relPath: string): Promise<string | undefined> {
    const cached = this.digestCache.get(relPath);
    if (cached !== undefined) return cached;
    if (escapesRoot(relPath)) return undefined;
    const { prefix, change, cwd, p4 } = this.opts;
    const depotFile = `${prefixBase(prefix)}${relPath}`;
    try {
      const { stdout } = await p4(['-Ztag', 'fstat', '-Ol', `${depotFile}@${change}`], cwd);
      return parseFstatBlocks(stdout)[0]?.digest;
    } catch {
      return undefined;
    }
  }
}
