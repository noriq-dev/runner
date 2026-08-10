import type {
  IndexSource,
  IndexSourceListItem,
  IndexSourceReadOutcome,
  ShouldDescend,
} from '../index-source';
import { readVerifiedLocal } from '../index-source';
import type { DvBlobHttp, DvHttp } from './diversion';

/**
 * The Diversion half of `IndexSource` (RUN-255, extended RUN-281): background indexing reads
 * Diversion's REST API — never the `dv` CLI, never a checkout, never the pool-of-1 lease — but,
 * since RUN-281, it is no longer API-ONLY for CONTENT: `read()` first tries a locally-offered
 * candidate root, and uses those bytes ONLY when a fresh hash over them matches this same commit's
 * own digest exactly. This does not weaken "no CLI, no checkout, no lease" — it is the opposite of
 * trusting an ambient checkout: the file below never runs `dv`, never asks anything to materialize
 * a tree, and never waits its turn for the pool-of-1 workspace, because it never NEEDS one to be
 * current — a stale, dirty, or entirely absent local root simply fails verification and falls back
 * to the API path this file has always had. See "Verify-then-read: reading local bytes without
 * trusting them" below for the full scheme and the measurement behind it. `diversion.ts`'s module
 * doc draws the division of labour this file depends on for everything else: the API is the driver
 * surface, the CLI owns only what must materialize files on disk for a RUN, and indexing reads.
 * Everything below is grounded in measurement against a live account on 2026-08-09 (dv CLI
 * v1.0.1017, ~7259-file repo `dv.repo.e821a7a1-…`), never in documentation trust — the same
 * discipline `diversion.ts`'s §9 reference set for the rest of this backend.
 *
 * **Enumeration is `GET /trees/{ref_id}?recurse=true`, not `/compare`** (discretion, measured).
 * Both endpoints can list a whole tree — `/compare` doubles as one when `base_id` is omitted (the
 * OpenAPI spec: "If omitted, assuming the empty tree") — but only `/trees` answers this file's
 * actual obligation, `IndexSource.list`'s ordering contract: a live compare of the same commit
 * came back in an UNSORTED, internal-storage order (measured: item 0 was `""`, item 2 was
 * `Config`, item 3 `Source`, ahead of alphabetically-earlier paths), while `/trees` came back
 * strictly ascending by path on every page, every time. Meeting the contract over an unsorted
 * source would mean buffering the WHOLE tree to sort it — the exact anti-pattern
 * `index-source.ts`'s module doc describes RUN-252 closing for the filesystem source — so
 * `/compare` is used only where this file actually needs a DIFF (`DiversionBackend.changesBetween`
 * in `diversion.ts`), never for enumeration.
 *
 * **Pagination is `limit`+`skip`, not `offset`** (measured, and the reason is not cosmetics).
 * `/trees` accepts three ways to move through a big listing: `limit` (page size, default 1500),
 * `skip` (item count to skip), and `offset` (an item NAME to resume after). `offset` is documented
 * as "in directory when iterating its entries" and measured to mean exactly that even with
 * `recurse=true`: the page after `offset=<last path of page 1>` came back starting at
 * `Content/Characters/…`, alphabetically BEFORE the tail of page 1 (`Content/Fab/…`) — a
 * per-directory resume point, not a flattened cursor, so chaining it across pages does not visit
 * every path once. `skip`, by contrast, measured as an exact, stable slice of the single sorted
 * listing (`limit=1500&skip=1500` byte-for-byte equalled elements 1500..2999 of one `limit=20000`
 * call) — so `TREE_PAGE_SIZE` below is a `limit`, and `skip` advances by it. **Memory cost**: one
 * page (`TREE_PAGE_SIZE` entries, ~380 bytes/item measured) is ever held at once — never the whole
 * tree — so a monorepo's total round-trip count is `fileCount / TREE_PAGE_SIZE`, not one giant
 * buffered response.
 *
 * **Directories are filtered by `mode`, decoded from the OpenAPI `FileMode` schema**
 * (`x-ogen-enum-naming`: `16877` TREE, `33188` FILE, `33261` EXECUTABLE, `40960` SYMLINK, `57344`
 * SUBREPO) — never inferred from samples (locked decision 4 [RUN-255 numbering]). A live listing's
 * first real items were exactly `Config`, `Source` (mode `16877`, no `blob`) — the module doc's
 * own locked decision 3 restated as a measured fact, not a hypothesis. `FILE_MODE_SUBREPO` never
 * appeared in the measured repo (no nested-repo pointers to observe) and is treated the same as a
 * directory on the same reasoning `index-source.ts` gives for a symlink it never recurses into: a
 * type this file has no measured content-read path for is excluded rather than guessed at.
 *
 * **`ShouldDescend` is honoured, but buys back only PIPELINE cost, never network cost** — stated
 * plainly because it is the one place this source's guarantee is weaker than
 * `FilesystemIndexSource`'s. `/trees?recurse=true` is a single flat, already-recursed listing:
 * there is no per-directory "should I list this" call to skip, so a denied directory's bytes are
 * already on the wire by the time `shouldDescend` could refuse them. What IS bought back: this
 * file checks every candidate's ANCESTOR chain against `shouldDescend` before yielding it (mirrors
 * `index-source.ts`'s `FakeIndexSource` — no real per-directory recursion to prune, so the check
 * runs the same way), which stops `index-scan.ts`'s policy pipeline (`comparePaths` + the full
 * include/exclude/deny evaluation) from ever running on a path inside a denied subtree. Switching
 * to a non-recursive, directory-by-directory walk (`recurse=false` + one call per directory) WOULD
 * buy back the network cost too, at the price of one HTTP round trip per directory instead of one
 * per `TREE_PAGE_SIZE` files — a bad trade for Diversion specifically, because this backend's own
 * deny list floor (`.git`, `.ssh`, `secrets`, …) names directories Diversion itself never creates
 * (unlike git's `.git`, there is no large VCS-internal directory living inside a Diversion tree to
 * prune away), so the realistic saving is near zero against a real cost multiplier.
 *
 * **`access_denied` (a per-entry field, not the aggregate `has_restricted_files` `/compare`
 * carries) is escalated as a `refused` listing item, never silently dropped** (locked decision 8
 * restated one endpoint over) — an entry Diversion flags as access-denied is a fact this file can
 * see but cannot read, and dropping it silently would let a path the caller cannot see look
 * identical to a path that was never there. Never measured `true` against the live account (an
 * OWNER-access token sees everything) — the field and its meaning come from the OpenAPI `FileEntry`
 * schema, not a sample.
 *
 * **Content is `GET /blobs/{ref_id}/{path}?force_blob_embedding=true`, never `/files/{ref_id}/…`**
 * (measured; corrects a working assumption from before this task's own measurement pass).
 * `/files/{ref_id}/{path}` answers with `FileEntry` JSON — metadata (path/hash/mode/blob
 * descriptor), never bytes; it is what `digest()` below reads. `/blobs/{ref_id}/{path}` is the
 * actual content endpoint, and it defaults to a `204` carrying a signed redirect to a
 * Cloudflare R2 URL (measured) — `force_blob_embedding=true` is what keeps every content read to
 * ONE request against `api.diversion.dev`, inside the Bearer-token auth this whole backend is
 * scoped to, rather than a second unauthenticated hop to a storage host this file would otherwise
 * have to know how to follow. `blobs/known-digests` (the other discretion candidate) is explicitly
 * `x-hidden` in the spec, described as "Internal endpoint, only used by the P4 bulk-upload
 * importer" — not a surface this file has any standing to call.
 *
 * **No true byte-range read is measured.** `read()` fetches the whole blob and truncates the
 * result to `maxBytes` client-side (mirroring `IndexSourceReadOutcome`'s "+1, to detect the cut"
 * contract) rather than asking the server to stop early — no `Range` support was found for
 * `force_blob_embedding=true` in the spec or measured against the live API. This costs a full
 * download on the rare `read()` call that reaches an oversized file directly; the ordinary path
 * never pays it, because `list()` reports `entry.size` from the SAME tree listing that already
 * carries `blob.size` for every file (locked decision — see `IndexSourceEntry.size`'s doc in
 * `index-source.ts`), so `index-scan.ts`'s bounds check refuses a too-large candidate BEFORE
 * `read()` is ever called for it.
 *
 * **Verify-then-read: reading local bytes without trusting them** (RUN-281). Diversion serves
 * every file as its own HTTP round trip — measured **161ms/file** against Project Nod's live API,
 * which is why a 1905-file pass hit `readDeadlineMs`'s old 120s filesystem-calibrated default at
 * 741 files, `stoppedEarly: true` (see `INDEX-OPERATIONS.md` for the full before/after). This
 * backend's own pool-of-1 workspace (`diversion.ts`'s `repoRoot`) sits on disk already, checked
 * out to WHATEVER a run last left it at — reading it directly would be reading the wrong commit,
 * or somebody's uncommitted diff, under this generation's identity. But `list()` already caches
 * `path → blob.sha` as it yields (`digestCache` below), one HTTP call per `TREE_PAGE_SIZE` files,
 * ALREADY PAID FOR by the enumeration this file was going to do anyway — and that digest is
 * measured to be plain SHA-1 of the raw file bytes (31/31 sampled paths matched, across source,
 * binaries, a 419MB file, and 10 CRLF-containing files with no line-ending normalization). So a
 * local read can be VERIFIED rather than trusted: hash the local candidate, compare it to the
 * cached digest for that exact path at this exact commit, and use those bytes ONLY on an exact
 * match — `index-source.ts`'s `readVerifiedLocal` is the shared mechanism, reused unchanged by any
 * future verify-then-read source (Perforce's listing carries a digest too — RUN-281's own deferred
 * half). A mismatch, a missing file, or an unreadable one all fall back to the unchanged
 * `/blobs` fetch below with no special case and no error surfaced — the SAME code path this file
 * has always run when `localRoot` is absent entirely (a repo this daemon has never checked out
 * locally at all, or a caller that never offers a candidate). Never a lease, never the CLI, never
 * a wait: indexing yields to runs, always, and a verify-then-read pass that needed the lease to be
 * safe would not be safe — the whole point of hashing every byte is that it is safe WITHOUT one,
 * even while a run is actively re-checking that same directory out from under this scan.
 *
 * **Every non-200 from `/trees` is a REFUSAL to enumerate, never an empty tree** (locked decision 7
 * [RUN-255 numbering], restated for the source that has to act on it): a 401 (expired credential —
 * measured shape: `{"status":401,"title":"…Error","detail":"…"}`) or any other failure status
 * yields ONE `{kind:'refused', path:'.'}` item and stops, so `index-scan.ts` records a failure
 * status rather than reporting "this repo has no files". `DiversionBackend.changesBetween` in
 * `diversion.ts` applies the same rule one layer up for `/compare`.
 *
 * **Containment guarantee, stated the way `openConfined`'s comment states the filesystem one**
 * (locked decision 10, amended RUN-281 for the local half). Every `path` this file sends to the
 * API is never a filesystem path — it is a key inside Diversion's own commit tree, resolved
 * server-side against the ONE `repoId` baked into every request path — so there is no local path
 * to escape and no TOCTOU window on the API side (no `open`, no descriptor, no re-resolve) at all.
 * The verify-then-read half DOES open real file descriptors against `localRoot`, so it is not
 * exempt from the class of race `FilesystemIndexSource`'s inode-identity check defends against —
 * it reuses that exact mechanism (`openConfined`, via `readVerifiedLocal` in `index-source.ts`)
 * rather than inventing a second one, confined to `localRoot` the same way `FilesystemIndexSource`
 * is confined to its own `root`. The hash comparison is a SEPARATE, additional property on top of
 * that confinement, not a substitute for it: confinement says "this descriptor is really inside
 * `localRoot`"; the digest match says "and its bytes are really this commit's." What this does NOT
 * cover: a `repoId` or `localRoot` chosen by a caller with the wrong intent (this file trusts
 * whoever constructs it, exactly as `FilesystemIndexSource` trusts its `root` — see that class's
 * doc), and a path Diversion itself is willing to resolve via the API, which this file has no way
 * to second-guess.
 */

/** `FileMode` (OpenAPI schema, `x-ogen-enum-naming`) — decoded from the spec, never inferred. */
const FILE_MODE_TREE = 16877; // 040755 — a directory: never a read candidate.
const FILE_MODE_SUBREPO = 57344; // 0160000 — a nested-repo pointer, no blob of its own; see module doc.

/** True for a mode this source never yields as a file candidate — see the module doc's "mode is
 *  decoded from the spec" note. Exported so `diversion.ts`'s `changesBetween` applies the exact
 *  same rule to `/compare`'s items (one decoding, used by both endpoints, never duplicated). */
export function isDirectoryMode(mode: number): boolean {
  return mode === FILE_MODE_TREE || mode === FILE_MODE_SUBREPO;
}

/**
 * `ObjectStatus` (OpenAPI schema: "One of: 1 - INTACT, 2 - ADDED, 3 - MODIFIED, 4 - DELETED",
 * `x-ogen-enum-naming`) — decoded from the spec, never inferred from samples (locked decision 4).
 * Applies ONLY to a `ComparisonItem`'s own top-level `status` field — `base_item.status` /
 * `other_item.status` encode each SIDE's own per-entry state, not the comparison's verb, and
 * measured ambiguous besides: a plain edit showed `base_item.status: 1` beside
 * `other_item.status: 3` (matching the top-level `3`), while a detected rename showed
 * `other_item.status: 3` with NO `base_item` present at all. The top-level field is the one
 * Diversion itself marks `required` on `ComparisonItem` and is unambiguous in every case measured;
 * this file never reads a side's own `status`.
 */
export type DvChangeVerb = 'intact' | 'added' | 'modified' | 'deleted';

/** `null` for a numeric status this file has never seen documented — the caller must escalate
 *  rather than guess (RUN-255 acceptance: "an unrecognized status escalates rather than
 *  defaulting"). Exported for the same reason `isDirectoryMode` is: `diversion.ts`'s
 *  `changesBetween` decodes `/compare`'s items through this one function. */
export function decodeObjectStatus(status: number): DvChangeVerb | null {
  switch (status) {
    case 1:
      return 'intact';
    case 2:
      return 'added';
    case 3:
      return 'modified';
    case 4:
      return 'deleted';
    default:
      return null;
  }
}

/** Bounded page size for `/trees/{ref}` pagination — see the module doc's "pagination is
 *  limit+skip" note for the measurement behind it. ~380 bytes/item measured, so one page is a few
 *  hundred KB; a monorepo's total round-trip count is its file count divided by this number. */
const TREE_PAGE_SIZE = 2000;

/** The digest algorithm the depot's own `blob.sha` is measured to be — see the module doc's
 *  "verify-then-read" section for the 31/31 sample behind this. Named as a constant, not
 *  hardcoded at the one call site, so a future correction to the measurement is a one-line change. */
const LOCAL_VERIFY_HASH_ALGORITHM = 'sha1';

/**
 * `IndexSource.minReadDeadlineMs`'s value for this backend (RUN-281) — a floor, never a fixed
 * override: `index-work.ts` takes `Math.max(config.readDeadlineMs, this)`, so a repo's own higher
 * configured bound always wins. Derived from the measurement this task made directly, not guessed:
 * Project Nod's own cold pass read 741 files in 123s over HTTP before hitting the OLD 120s default
 * — 166ms/file end to end, matching the 161ms/file measured independently against the same live
 * API. Extrapolated to this repo's own ~1905-file candidate set, a fully cold or fully dirty pass
 * (the verify-then-read fast path finding nothing to verify — a first-ever index, or a checkout
 * nothing has synced yet) needs roughly 1905 * 0.166s ≈ 316s just for content reads, before
 * enumeration and per-file processing overhead. 600s (10 minutes) is that estimate with close to
 * 2x headroom — generous enough that an ordinary cold pass finishes inside it, without being so
 * large that a genuinely stuck job (a hung connection, a server outage) goes unnoticed for the
 * better part of an hour. See `INDEX-OPERATIONS.md`'s own before/after numbers for the real pass
 * this constant was calibrated against.
 */
const DIVERSION_MIN_READ_DEADLINE_MS = 600_000;

interface DvFileEntry {
  path: string;
  mode: number;
  access_denied?: boolean;
  blob?: { size: number; sha: string };
}

interface DvTreePage {
  items?: DvFileEntry[];
  has_more?: boolean;
}

function encodePathSegments(relPath: string): string {
  return relPath.split('/').map(encodeURIComponent).join('/');
}

function describeBody(body: unknown): string {
  try {
    return JSON.stringify(body).slice(0, 300);
  } catch {
    return String(body).slice(0, 300);
  }
}

/**
 * Mirrors `index-source.ts`'s private `passesShouldDescend` (not exported there — this source has
 * no real directories of its own to prune, exactly as `FakeIndexSource` does not, so it checks
 * every ANCESTOR segment of the candidate itself). See this file's module doc for why this buys
 * back pipeline cost only, never the network cost of a listing already in hand.
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

/**
 * The Diversion `IndexSource` (RUN-255). One instance is scoped to one `(repoId, refId)` pair —
 * `refId` is a commit id in Diversion's own id-space (`IndexSnapshot.baseId`'s contract), never a
 * branch name or a workspace: a snapshot's whole point is a fixed point in history, and a branch
 * name would silently move under a long-running scan.
 */
export class DiversionIndexSource implements IndexSource {
  readonly kind = 'diversion';

  /** See `IndexSource.minReadDeadlineMs`'s own doc for why this is DECLARED rather than something
   *  the policy layer detects, and `DIVERSION_MIN_READ_DEADLINE_MS`'s own doc for the measurement
   *  behind the value. */
  readonly minReadDeadlineMs = DIVERSION_MIN_READ_DEADLINE_MS;

  /** `path` → `blob.sha`, filled in as `list()` yields — a free `digest()` for anything already
   *  listed (the tree walk already carries `sha` for every file entry), never a second round trip
   *  for a path this source has already seen. See `IndexSource.digest`'s doc: this is a
   *  change-detection hint only, never the index's own content hash. Doubles, since RUN-281, as
   *  the trusted digest the verify-then-read fast path hashes a local candidate against — see the
   *  module doc's "verify-then-read" section.
   */
  private readonly digestCache = new Map<string, string>();

  constructor(
    private readonly repoId: string,
    private readonly refId: string,
    private readonly http: DvHttp,
    private readonly blobHttp: DvBlobHttp,
    /**
     * A CANDIDATE local root this source's own backend offers (RUN-281) — never trusted, never
     * walked, never opened except through `read()`'s own hash check against `digestCache`. Absent
     * (the RUN-255 shape, still the default for anything that constructs this source directly, as
     * every test in this repo but the new verify-then-read ones does) means every read goes
     * straight to `/blobs`, exactly as before this task. See `IndexSnapshot.localPath`'s own doc
     * in `vcs/types.ts` for what "offer" means at the type level, and `DiversionBackend
     * .leaseIndexSnapshot` in `diversion.ts` for the one place that mints both this constructor
     * argument and that field together, from the same `repoRoot`.
     */
    private readonly localRoot?: string,
  ) {}

  async *list(shouldDescend?: ShouldDescend): AsyncIterable<IndexSourceListItem> {
    let skip = 0;
    for (;;) {
      const res = await this.http(
        'GET',
        `/repos/${encodeURIComponent(this.repoId)}/trees/${encodeURIComponent(this.refId)}` +
          `?recurse=true&limit=${TREE_PAGE_SIZE}&skip=${skip}`,
      );
      if (res.status !== 200) {
        yield {
          kind: 'refused',
          path: '.',
          reason: 'unreadable',
          detail: `tree listing for ${this.refId} in ${this.repoId} failed: HTTP ${res.status} ${describeBody(res.body)}`,
        };
        return;
      }
      const page = res.body as DvTreePage;
      const items = page.items ?? [];
      for (const entry of items) {
        if (isDirectoryMode(entry.mode)) continue; // never a candidate — locked decision 3.
        if (shouldDescend && !passesShouldDescend(entry.path, shouldDescend)) continue;
        if (entry.access_denied) {
          yield {
            kind: 'refused',
            path: entry.path,
            reason: 'unreadable',
            detail:
              'Diversion reports this path as access-denied by path permissions — the listing is ' +
              'incomplete here, not proof the path is absent',
          };
          continue;
        }
        if (entry.blob?.sha) this.digestCache.set(entry.path, entry.blob.sha);
        yield { kind: 'file', entry: { path: entry.path, size: entry.blob?.size } };
      }
      if (page.has_more === false || items.length < TREE_PAGE_SIZE) return;
      skip += TREE_PAGE_SIZE;
    }
  }

  async read(relPath: string, maxBytes: number): Promise<IndexSourceReadOutcome> {
    // Verify-then-read (RUN-281): only ever attempted when a candidate root was offered AND this
    // exact path's digest is already sitting in `digestCache` — populated for free by `list()`,
    // never fetched fresh here (a fresh fetch would spend an HTTP call to save one, which is not a
    // fast path). Every ordinary indexing pass enumerates before it reads, so this is populated by
    // the time `read()` is ever called for a path `list()` yielded; a caller that reads a path
    // this source never listed (a handful of unit tests below) simply never sees the fast path,
    // which is the correct, safe answer for a path this source has no digest to verify against.
    if (this.localRoot !== undefined) {
      const digest = this.digestCache.get(relPath);
      if (digest !== undefined) {
        const verified = await readVerifiedLocal(
          this.localRoot,
          relPath,
          maxBytes,
          digest,
          LOCAL_VERIFY_HASH_ALGORITHM,
        );
        if (verified) return { ok: true, bytes: verified.bytes, overLimit: verified.overLimit };
        // null: missing, unreadable, or a hash mismatch — every one of those falls through to the
        // exact same `/blobs` fetch below, unconditionally and silently (locked decision: the
        // failure mode of a wrong assumption about the digest must be a slow pass, never a wrong
        // one — see `readVerifiedLocal`'s own doc in `index-source.ts`).
      }
    }
    const res = await this.blobHttp(this.repoId, this.refId, relPath);
    if (res.status === 404) {
      return { ok: false, reason: 'not-found', detail: `no such blob at ${this.refId}` };
    }
    if (res.status === 410) {
      return {
        ok: false,
        reason: 'not-found',
        detail: 'blob permanently unreachable — the on-demand fetch queue dead-lettered it',
      };
    }
    if (res.status !== 200 || !res.bytes) {
      return {
        ok: false,
        reason: 'unreadable',
        detail: `blob read for ${relPath} at ${this.refId} failed: HTTP ${res.status}${res.detail ? ` ${res.detail}` : ''}`,
      };
    }
    const overLimit = res.bytes.length > maxBytes;
    return { ok: true, bytes: overLimit ? res.bytes.subarray(0, maxBytes) : res.bytes, overLimit };
  }

  async digest(relPath: string): Promise<string | undefined> {
    const cached = this.digestCache.get(relPath);
    if (cached !== undefined) return cached;
    const res = await this.http(
      'GET',
      `/repos/${encodeURIComponent(this.repoId)}/files/${encodeURIComponent(this.refId)}/${encodePathSegments(relPath)}`,
    );
    if (res.status !== 200) return undefined;
    const entry = res.body as { blob?: { sha?: string } };
    return entry.blob?.sha;
  }
}
