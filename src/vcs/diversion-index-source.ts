import type {
  IndexSource,
  IndexSourceListItem,
  IndexSourceReadOutcome,
  ShouldDescend,
} from '../index-source';
import type { DvBlobHttp, DvHttp } from './diversion';

/**
 * The Diversion half of `IndexSource` (RUN-255): background indexing reads Diversion's REST API
 * ONLY — no `dv` CLI, no checkout, no workspace, no pool-of-1 lease. `diversion.ts`'s module doc
 * draws the division of labour this file depends on: the API is the driver surface, the CLI owns
 * only what must materialize files on disk, and indexing reads, so it never touches the CLI at
 * all. Everything below is grounded in measurement against a live account on 2026-08-09 (dv CLI
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
 * **Every non-200 from `/trees` is a REFUSAL to enumerate, never an empty tree** (locked decision 7
 * [RUN-255 numbering], restated for the source that has to act on it): a 401 (expired credential —
 * measured shape: `{"status":401,"title":"…Error","detail":"…"}`) or any other failure status
 * yields ONE `{kind:'refused', path:'.'}` item and stops, so `index-scan.ts` records a failure
 * status rather than reporting "this repo has no files". `DiversionBackend.changesBetween` in
 * `diversion.ts` applies the same rule one layer up for `/compare`.
 *
 * **Containment guarantee, stated the way `openConfined`'s comment states the filesystem one**
 * (locked decision 10): this source is constructed with ONE `repoId`, baked into every request
 * path, and `path` arguments are never filesystem paths — they are keys inside Diversion's own
 * commit tree, resolved server-side against that same `repoId`. There is no local path to escape
 * and no TOCTOU window (no `open`, no descriptor, no re-resolve) — the class of race
 * `FilesystemIndexSource`'s inode-identity check defends against does not exist here. What this
 * does NOT cover: a `repoId` chosen by a caller with the wrong intent (this file trusts whoever
 * constructs it, exactly as `FilesystemIndexSource` trusts its `root` — see that class's doc), and
 * a path Diversion itself is willing to resolve, which this file has no way to second-guess.
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

  /** `path` → `blob.sha`, filled in as `list()` yields — a free `digest()` for anything already
   *  listed (the tree walk already carries `sha` for every file entry), never a second round trip
   *  for a path this source has already seen. See `IndexSource.digest`'s doc: this is a
   *  change-detection hint only, never the index's own content hash. */
  private readonly digestCache = new Map<string, string>();

  constructor(
    private readonly repoId: string,
    private readonly refId: string,
    private readonly http: DvHttp,
    private readonly blobHttp: DvBlobHttp,
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
