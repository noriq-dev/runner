import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { CHANGES_BETWEEN_MAX_PATHS } from '../worktree';
import { DiversionIndexSource, decodeObjectStatus, isDirectoryMode } from './diversion-index-source';
import type { LockDelegate } from './git';
import type {
  ChangesBetweenResult,
  CurrentBaseResult,
  IgnoreQueryResult,
  IndexSnapshot,
  IndexSnapshotResult,
  IntegrateResult,
  LeaseOptions,
  LockContext,
  LockOutcome,
  PublishResult,
  ReviewRequest,
  ReviewResult,
  VcsBackend,
  Workspace,
} from './types';

const execFileP = promisify(execFile);

/**
 * Diversion, as a VcsBackend (RUN-51).
 *
 * Everything here is grounded in measurement, not documentation trust: RUN-54 ran the CLI
 * against a real server (VCS-SPIKE.md §9), and the API mapping below was read out of
 * docs.diversion.dev and then proven live (`GET /repos` with the CLI's own stored token).
 * The division of labour follows what §9 established:
 *
 *  - **The REST API is the driver surface** (api.diversion.dev/v0). The CLI is a human tool —
 *    conflicted merges exit 0 and open a browser — but the API returns merges as objects:
 *    202 + merge_id on conflict, and GET /merges/{id} lists each conflict's PATHS. That is
 *    what lets `integrate` honour its contract here.
 *  - **The CLI (via the dv sync agent) owns anything that must materialize files on disk** —
 *    checkout, update — because file sync IS the agent's job and the API cannot do it.
 *
 * Two §9 findings shape the semantics, and neither is a choice:
 *
 *  - **Diversion's native merge papers over races** (measured: target moved → "Merge
 *    succeeded", exit 0). There is no precondition parameter in the API either. So `publish`
 *    carries the compare-and-swap ITSELF: re-merge the target into the run's branch first —
 *    the server answering 200 ("already current") is the proof the target has not moved —
 *    and only then merge back. The window between the two calls is real and documented; git
 *    does not have one (`--ff-only` is atomic), and THREAT-MODEL.md says so.
 *  - **Conflicts are server-side objects with no documented resolve endpoint**, so agent
 *    conflict-resolution does not exist on this backend: `integrate` reports the paths AND
 *    the web URL where a human resolves it (`resolveUrl`), and `resumeIntegrate` cannot
 *    succeed — every Diversion conflict is a human conflict. Honest, shippable, and strictly
 *    worse than git; revisit only if the API grows a resolve surface.
 *
 * The lease is POOL-OF-1 on the repo's own workspace: runs take turns. §9 measured per-run
 * workspaces at 4.4s on a toy repo, so pool-N is possible — but it needs a placement policy
 * (dv refuses some directories) and a real large-repo cost number (RUN-55's open question),
 * so the conservative default the plan blessed for live backends stands until measured.
 * Consequence, and it is deliberate: `maxConcurrent` is not the isolation mechanism here —
 * this in-process queue is — and two DAEMONS on one workspace are not defended against; the
 * workspace registry is `~/.diversion/ws`, one agent per machine, so one daemon per machine
 * is the operating assumption.
 *
 * `leaseIndexSnapshot`/`changesBetween` (RUN-255, both refused `unsupported`/`full-index-required`
 * by RUN-211/212 for want of a measured path) are DELIBERATELY outside the pool-of-1 lease and the
 * CLI split above: background indexing reads, so it never checks out, never touches the CLI, and
 * never waits its turn for the workspace — it cannot contend with a run holding the lease. Since
 * RUN-281 that is no longer the same as "pure API for every byte": `leaseIndexSnapshot` also
 * offers `repoRoot` itself — the SAME directory `lease()` above checks branches into — as a
 * CANDIDATE local root, and `DiversionIndexSource.read()` uses those bytes only after verifying
 * them against this commit's own digest. Reading that directory needs no lease and takes none: it
 * is an ordinary filesystem read of whatever happens to be sitting there, verified rather than
 * trusted, which is exactly what makes it safe to do without coordinating with whichever run might
 * be re-checking that same directory out at the same moment. `diversion-index-source.ts`'s module
 * doc carries the measurement (a live account, 2026-08-09, extended 2026-08-10) behind all of this.
 */

export interface DvHttpResponse {
  status: number;
  body: unknown;
}

/** Injectable HTTP transport to api.diversion.dev — tests fake it; prod signs with the CLI's token. */
export type DvHttp = (method: string, apiPath: string, body?: unknown) => Promise<DvHttpResponse>;

/** Injectable CLI runner for the sync-touching operations (checkout/update/reset). */
export type DvCli = (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;

export const DV_API_BASE = 'https://api.diversion.dev/v0';

/**
 * The production transport reads the CLI's own credential per request — the dv agent refreshes
 * that file itself, so re-reading is what keeps a long daemon working without re-implementing
 * the OAuth refresh dance. The token goes only to its own service, over TLS.
 */
export async function dvStoredToken(home: string = os.homedir()): Promise<string> {
  const dir = path.join(home, '.diversion', 'credentials');
  const entries = await readdir(dir);
  const user = entries.find((e) => e.startsWith('dv.u.'));
  if (!user) throw new Error('no Diversion credential found — run `dv login` first');
  const cred = JSON.parse(await readFile(path.join(dir, user), 'utf8')) as {
    token?: { access_token?: string };
  };
  const token = cred.token?.access_token;
  if (!token) throw new Error(`Diversion credential ${user} has no access_token — run \`dv login\``);
  return token;
}

export const realDvHttp =
  (fetchFn: typeof fetch = fetch, home?: string): DvHttp =>
  async (method, apiPath, body) => {
    const token = await dvStoredToken(home);
    const res = await fetchFn(`${DV_API_BASE}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  };

export interface DvBlobResult {
  status: number;
  /** Present only when `status === 200` — the embedded blob bytes. */
  bytes?: Buffer;
  /** Free text for logs on a non-200 status — never structure a caller branches on. */
  detail?: string;
}

/**
 * Injectable raw-bytes transport for blob content (RUN-255) — kept separate from `DvHttp` on
 * purpose, not merely for symmetry: `realDvHttp` always decodes its response as JSON (`res.text()`
 * then `JSON.parse`), and that would corrupt binary content — a `.text()` read forces UTF-8
 * decoding, and a byte sequence that is not valid UTF-8 (any binary asset, and plenty of "text"
 * files that are not UTF-8) comes back with silent U+FFFD replacement characters, no error to
 * catch it. `force_blob_embedding=true` is what keeps a content read to ONE request against
 * `api.diversion.dev`: without it the endpoint answers `204` with a signed redirect to a Cloudflare
 * R2 URL (measured 2026-08-09) that this transport would otherwise have to follow itself, outside
 * the Bearer-token auth this whole file is scoped to.
 */
export type DvBlobHttp = (repoId: string, refId: string, path: string) => Promise<DvBlobResult>;

export const realDvBlobHttp =
  (fetchFn: typeof fetch = fetch, home?: string): DvBlobHttp =>
  async (repoId, refId, filePath) => {
    const token = await dvStoredToken(home);
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const res = await fetchFn(
      `${DV_API_BASE}/repos/${encodeURIComponent(repoId)}/blobs/${encodeURIComponent(refId)}/${encodedPath}?force_blob_embedding=true`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status !== 200) {
      const detail = await res.text().catch(() => '');
      return { status: res.status, detail: detail.slice(0, 500) };
    }
    return { status: 200, bytes: Buffer.from(await res.arrayBuffer()) };
  };

export const realDvCli: DvCli = async (args, cwd) => {
  const { stdout, stderr } = await execFileP('dv', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return { stdout, stderr };
};

/** What this backend stashes in Workspace.location. */
interface DvLocation {
  repoId: string;
  branch: string;
  /** The branch the leased workspace sits on when idle — restored by dispose. */
  baseBranch: string;
}

function dvLocation(ws: Workspace): DvLocation {
  const loc = ws.location as Partial<DvLocation> | null | undefined;
  if (
    typeof loc?.repoId === 'string' &&
    typeof loc?.branch === 'string' &&
    typeof loc?.baseBranch === 'string'
  ) {
    return { repoId: loc.repoId, branch: loc.branch, baseBranch: loc.baseBranch };
  }
  throw new Error(
    `workspace for run ${ws.runId} does not carry a Diversion location — it was minted by another backend or an incompatible daemon version`,
  );
}

/**
 * What this backend stashes in an `IndexSnapshot`'s `location` (RUN-255) — tagged with a
 * discriminant `DvLocation` above does not carry, for exactly the reason `git.ts`'s
 * `GitIndexSnapshotLocation` gives (see that file's comment): `IndexSnapshot` and `Workspace` are
 * structurally close enough that a `Workspace` satisfies this type by ordinary structural typing,
 * so `kind` is what lets `dvIndexSnapshotLocation` refuse a foreign object instead of acting on it.
 */
interface DvIndexSnapshotLocation {
  kind: 'index-snapshot';
  repoId: string;
}

function dvIndexSnapshotLocation(snapshot: IndexSnapshot): DvIndexSnapshotLocation {
  const loc = snapshot.location as Partial<DvIndexSnapshotLocation> | null | undefined;
  if (loc?.kind === 'index-snapshot' && typeof loc.repoId === 'string') {
    return { kind: 'index-snapshot', repoId: loc.repoId };
  }
  throw new Error(
    'Diversion refuses to release an index snapshot it did not mint — it was minted by another backend or an incompatible daemon version',
  );
}

/** The page a human resolves a pending merge on — the CLI prints exactly this shape (§9). */
export const dvMergeUrl = (repoId: string, mergeId: string): string =>
  `https://app.diversion.dev/repo/${repoId}/merges/${mergeId}`;

export interface DiversionBackendOpts {
  /** The Diversion repo id (dv.repo.…) this backend serves — one backend instance per repo. */
  repoId: string;
  http?: DvHttp;
  cli?: DvCli;
  /** Content transport for background indexing (RUN-255) — see `DvBlobHttp`'s doc for why it is
   *  not just `http` again. Unused by anything except `leaseIndexSnapshot`'s snapshot. */
  blobHttp?: DvBlobHttp;
  /** The Noriq lock view (RUN-100). Diversion's own soft locks are Pro-gated, so the runner's
   *  cross-run coordination + the unified dashboard live in the Noriq lock primitive (the same
   *  primitive git uses); the native soft lock is layered on best-effort and DEGRADES to the
   *  Noriq layer alone when the workspace isn't Pro. Absent → native only / reports disabled. */
  locks?: LockDelegate;
}

interface MergeConflict {
  conflict_id?: string;
  result?: { path?: string };
  other?: { path?: string };
  base?: { path?: string };
}

/** `queryIgnored`'s cached result shape — see its own doc and `computeKnownPaths`'s. */
interface KnownPaths {
  /** Every path Diversion tracks at HEAD, plus every locally-added path `dv status` reports under
   *  `New:` (untracked but NOT ignored). */
  files: Set<string>;
  /** Every ancestor directory of every path in `files` — the O(1) answer for a directory
   *  candidate, computed once rather than scanned per call. */
  dirPrefixes: Set<string>;
}

/**
 * `dv status`'s prose sections (`New:`/`Modified:`/`Deleted:`, each followed by tab-indented
 * paths, one per line, until the next section header or EOF) — `hasWork` above already parses
 * this SAME output shape with a boolean regex; this is the same grammar generalized to collect
 * the paths themselves rather than only testing for a match. A header line is matched at column
 * zero (`^`) so an indented path line that happens to start with a section-header WORD (unlikely,
 * but this is prose, not a wire format) is never mistaken for a new section.
 */
function parseStatusSection(stdout: string, section: 'New' | 'Modified' | 'Deleted'): string[] {
  const lines = stdout.split('\n');
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^(New|Modified|Deleted):/.test(line)) {
      inSection = line.startsWith(`${section}:`);
      continue;
    }
    if (inSection) {
      const path = line.trim();
      if (path) out.push(path);
    }
  }
  return out;
}

export class DiversionBackend implements VcsBackend {
  readonly kind = 'diversion';
  /** Unlanded work survives dispose without help: checkpointed commits live on the run's
   *  server-side branch, and even uncommitted edits synced continuously (§9). Skipping dispose
   *  to "keep" work here would only wedge the pool-of-1 lease (RUN-52's find). */
  readonly disposePreservesWork = true;
  private readonly repoId: string;
  private readonly http: DvHttp;
  private readonly cli: DvCli;
  private readonly blobHttp: DvBlobHttp;
  private readonly locks?: LockDelegate;
  /**
   * The pool-of-1 lease: one exclusive occupant of the repo's workspace at a time, in-process.
   * A promise chain rather than a mutex object so a crashed lease (rejected promise) does not
   * poison the queue — each waiter chains on settlement, not success.
   */
  private queue: Promise<unknown> = Promise.resolve();
  /** Pending server-side merges per run, so abandon/resume can find them. */
  private readonly pendingMerges = new Map<string, string>();
  /** Release functions for held leases, keyed by run. */
  private readonly held = new Map<string, () => void>();
  /** `queryIgnored`'s one-shot cache (RUN-256 correction) — keyed by `repoRoot` rather than
   *  assumed singular, but in practice one backend instance sees one repoRoot for one debug walk's
   *  whole lifetime, so this pays the tree-fetch cost ONCE regardless of how many directories the
   *  walk visits. See `knownPathsFor`'s own doc for why this must be one-shot at all. */
  private readonly knownPathsCache = new Map<string, Promise<KnownPaths | null>>();

  constructor(opts: DiversionBackendOpts) {
    this.repoId = opts.repoId;
    this.http = opts.http ?? realDvHttp();
    this.cli = opts.cli ?? realDvCli;
    this.blobHttp = opts.blobHttp ?? realDvBlobHttp();
    this.locks = opts.locks;
  }

  private api(method: string, p: string, body?: unknown) {
    return this.http(method, `/repos/${encodeURIComponent(this.repoId)}${p}`, body);
  }

  /**
   * Resolve a branch NAME to its id via the list endpoint (`GET /branches`, the same shape
   * `reapOrphans` already reads). `branchHead` below is this method's only caller now — folding
   * the two together would work too (see that method's doc for why it stays a separate name),
   * but "list branches and find one by name" is a distinct enough question to name on its own.
   *
   * `null` on anything short of an exact match: a renamed-away or deleted branch is a real
   * "cannot resolve", never a guess at the nearest name. A failed LIST call is a different animal
   * and is not folded into that null — it throws, so a transient failure resolving a name is never
   * silently reported as "no such branch" to a caller that acts on that answer (`lease` treats it
   * as "start fresh"; `hasWork`/`targetExists` treat it as "nothing here").
   */
  private async branchIdByName(name: string): Promise<string | null> {
    const res = await this.api('GET', '/branches');
    if (res.status !== 200) {
      throw new Error(`could not list branches in ${this.repoId} to resolve ${name}: HTTP ${res.status}`);
    }
    const items = (res.body as { items?: Array<{ branch_name?: string; branch_id?: string }> }).items ?? [];
    return items.find((b) => b.branch_name === name)?.branch_id ?? null;
  }

  /**
   * The branch's tip, or null when the branch does not exist yet — which is an ANSWER: a run that
   * has committed nothing has no branch, and that is the ordinary state of a fresh lease.
   *
   * A 200 carrying no `commit_id` is not that (RUN-157). It is a branch the server says exists and
   * then declines to describe, and it used to collapse into the same null — so `hasWork` reported
   * "no work" for a response it could not read at all, and the caller acts on `false` by disposing.
   *
   * Accepts a branch NAME or a `dv.branch.` id (RUN-259), discriminated on that prefix — Diversion's
   * own id shape, already relied on elsewhere in this file (the test fake's `branchId` helper,
   * `leaseIndexSnapshot`'s `default_branch_id`). This is not convenience overloading: `GET
   * /branches/{name}` measured a reproducible 500 against a real account — `main`, and a feature
   * branch, every branch tried, not only the default one an earlier fix here scoped itself to —
   * while `GET /branches/{id}` (the exact same endpoint) answered 200 every time. Whether the 500
   * is this account's own quirk or true of every Diversion account is unmeasured and open; the fix
   * below is correct either way, since the id lookup works in both worlds. Six call sites in this
   * class hand this method a name; resolving HERE, once, is what stops a seventh from reopening the
   * bug the way the sixth already did. An id-shaped argument skips the resolve round trip entirely
   * (`leaseIndexSnapshot`, `computeKnownPaths` — both already hold an id and should keep paying for
   * only the one call); anything else resolves through `branchIdByName` first, and a name that
   * resolves to nothing is `null` — the same "no such branch" answer a 404 gives below, not a throw.
   */
  private async branchHead(branch: string): Promise<string | null> {
    const id = branch.startsWith('dv.branch.') ? branch : await this.branchIdByName(branch);
    if (id === null) return null;
    const res = await this.api('GET', `/branches/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`branch lookup for ${branch} failed: HTTP ${res.status}`);
    const b = res.body as { commit_id?: string; branch_id?: string };
    if (!b.commit_id) {
      throw new Error(`branch ${branch} exists but reported no commit — cannot tell what it holds`);
    }
    return b.commit_id;
  }

  async lease(repoRoot: string, runId: string, opts?: LeaseOptions): Promise<Workspace> {
    // Wait for the current occupant. Chaining on `finally` keeps a failed run from wedging
    // the pool — the next lease proceeds whether the last one succeeded or died.
    const turn = this.queue;
    let release!: () => void;
    this.queue = this.queue.then(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    await turn;
    this.held.set(runId, release);

    try {
      // Where the run's work will live. From another run's branch when verifying it (the
      // convention is this backend's, mirrored from git's), else from the workspace's branch.
      const branch = `noriq/run/${runId}`;
      const { stdout: baseBranchRaw } = await this.cli(['branch-name'], repoRoot);
      const baseBranch = baseBranchRaw.trim();

      // Continue a failed run (RUN-93): the run's OWN branch already exists server-side from a kept
      // prior attempt — dispose preserves it (§9), so a re-dispatch of the same run id finds it
      // here. Adopt it: `POST /branches` would 409 on the existing name, and re-forking would
      // abandon the work the prior attempt committed. `hasWork` compares the branch head to
      // `baseId`, so the current line head as base makes the branch's own commits read as work.
      const priorHead = opts?.fromRunId ? null : await this.branchHead(branch);
      if (priorHead !== null) {
        const baseId = (await this.branchHead(baseBranch)) ?? priorHead;
        await this.cli(['checkout', branch, '--discard-changes', '--ignore-shelf'], repoRoot);
        return {
          runId,
          localPath: repoRoot,
          readOnly: opts?.readOnly ?? false,
          baseId,
          workRef: branch,
          location: { repoId: this.repoId, branch, baseBranch } satisfies DvLocation,
        };
      }

      const from = opts?.fromRunId ? `noriq/run/${opts.fromRunId}` : baseBranch;

      const baseId = await this.branchHead(from);
      if (baseId === null) throw new Error(`cannot lease from ${from}: no such branch in ${this.repoId}`);

      const created = await this.api(
        'POST',
        `/branches?branch_name=${encodeURIComponent(branch)}&commit_id=${encodeURIComponent(baseId)}`,
      );
      if (created.status >= 300) throw new Error(`could not create ${branch}: HTTP ${created.status}`);
      // The sync agent materializes the branch into the working directory. This is the one
      // step the API cannot do — file sync is the agent's whole job (§9).
      await this.cli(['checkout', branch, '--discard-changes', '--ignore-shelf'], repoRoot);

      return {
        runId,
        localPath: repoRoot,
        readOnly: opts?.readOnly ?? false,
        baseId,
        workRef: branch,
        location: { repoId: this.repoId, branch, baseBranch } satisfies DvLocation,
      };
    } catch (err) {
      // A lease that failed to set up must not hold the pool.
      this.held.delete(runId);
      release();
      throw err;
    }
  }

  async dispose(ws: Workspace): Promise<void> {
    const loc = dvLocation(ws);
    try {
      // CLEAN, never destroy (RUN-48): drop uncommitted noise, hand the workspace back on its
      // idle branch. The run's BRANCH is deliberately left alone — it is server-side, durable,
      // and may hold the only committed copy of unlanded work; branch grooming is a human's
      // call on a backend where every branch is team-visible.
      await this.cli(['checkout', loc.baseBranch, '--discard-changes', '--ignore-shelf'], ws.localPath);
    } finally {
      this.held.get(ws.runId)?.();
      this.held.delete(ws.runId);
      this.pendingMerges.delete(ws.runId);
    }
  }

  async hasWork(ws: Workspace): Promise<boolean> {
    const loc = dvLocation(ws);
    // Uncommitted changes in the workspace, or commits on the run branch past its base.
    const { stdout } = await this.cli(['status', '--nowait', '--no-limit'], ws.localPath);
    if (/^\s*(New|Modified|Deleted):/m.test(stdout)) return true;
    const head = await this.branchHead(loc.branch);
    return head !== null && head !== ws.baseId;
  }

  async checkpoint(ws: Workspace, message: string): Promise<boolean> {
    // The durability half of checkpoint is already true before this runs — §9: every write
    // syncs to the cloud continuously. This adds the REVIEWABLE commit.
    try {
      const { stdout } = await this.cli(['commit', '-a', '-m', message], ws.localPath);
      return /New commit ID/i.test(stdout);
    } catch (err) {
      // "Nothing to commit" is a false, not a failure — mirror commitWork's contract.
      if (/no changes|nothing to commit/i.test((err as Error).message)) return false;
      throw err;
    }
  }

  async targetExists(_repoRoot: string, target: string): Promise<boolean> {
    return (await this.branchHead(target)) !== null;
  }

  async createTarget(_repoRoot: string, target: string, from: string): Promise<void> {
    // `from` may be a branch name or a commit id (the supervisor passes either — the manifest's
    // defaultBranch, or the lease's baseId). Branch names resolve to their head first.
    const commitId = from.startsWith('dv.commit.') ? from : await this.branchHead(from);
    if (!commitId) throw new Error(`cannot create ${target}: ${from} does not resolve`);
    const res = await this.api(
      'POST',
      `/branches?branch_name=${encodeURIComponent(target)}&commit_id=${encodeURIComponent(commitId)}`,
    );
    if (res.status >= 300) throw new Error(`could not create ${target}: HTTP ${res.status}`);
  }

  /**
   * Merge the target INTO the run's branch (no rebase exists here — §9 measured the outcome
   * surviving anyway: the merged tree contains target + work, and the landed tree is
   * byte-identical to the verified one).
   */
  async integrate(ws: Workspace, target: string): Promise<IntegrateResult> {
    const loc = dvLocation(ws);
    const res = await this.api(
      'POST',
      `/merges?base_id=${encodeURIComponent(loc.branch)}&other_id=${encodeURIComponent(target)}`,
    );
    if (res.status === 200 || res.status === 201) {
      // 200 = already current, 201 = merged clean. Either way the workspace must now SHOW the
      // merged result — verify runs on these files, and the merge happened server-side.
      await this.cli(['update', '--conflict_resolution', 'accept-incoming'], ws.localPath);
      return { ok: true };
    }
    if (res.status === 202) {
      const mergeId = (res.body as { merge_id?: string }).merge_id ?? '';
      this.pendingMerges.set(ws.runId, mergeId);
      return {
        ok: false,
        conflicts: await this.conflictPaths(mergeId),
        // The honest shape on this backend: conflicts live on the SERVER, no API resolve
        // surface is documented, so a human at this URL is the only path through (§9).
        resolveUrl: dvMergeUrl(this.repoId, mergeId),
      };
    }
    throw new Error(`merge of ${target} into ${loc.branch} failed: HTTP ${res.status}`);
  }

  private async conflictPaths(mergeId: string): Promise<string[]> {
    if (!mergeId) return [];
    const res = await this.api('GET', `/merges/${encodeURIComponent(mergeId)}`);
    if (res.status !== 200) return [];
    const merge = res.body as { conflicts?: MergeConflict[] };
    const paths = (merge.conflicts ?? [])
      .map((c) => c.result?.path ?? c.other?.path ?? c.base?.path)
      .filter((p): p is string => !!p);
    return [...new Set(paths)];
  }

  /**
   * Cannot succeed here, by measurement rather than by choice: the conflict is a server-side
   * object, local file edits do not touch it, and no resolve endpoint is documented. Every
   * Diversion conflict is a human conflict — this re-reports the paths and the URL so the
   * failure comment says exactly where to go.
   */
  async resumeIntegrate(ws: Workspace): Promise<IntegrateResult> {
    const mergeId = this.pendingMerges.get(ws.runId) ?? '';
    return {
      ok: false,
      conflicts: await this.conflictPaths(mergeId),
      resolveUrl: mergeId ? dvMergeUrl(this.repoId, mergeId) : undefined,
    };
  }

  async abandonIntegrate(ws: Workspace): Promise<void> {
    // No delete-merge endpoint is documented; an unresolved merge goes stale server-side.
    // Locally there is nothing to un-do — the workspace files were never touched by a
    // conflicted merge (§9: the CLI leaves the tree CLEAN on conflict).
    this.pendingMerges.delete(ws.runId);
  }

  /**
   * The backend-carried compare-and-swap (§9: Diversion's own merge papers over races, and the
   * API has no precondition). Two server calls:
   *
   *   1. merge target → run branch. **200 ("already current") is the CAS proof**: the run
   *      branch already contains the target's head, so the target has not moved since
   *      integrate. 201 means it DID move — the call just re-integrated it, so the tree now
   *      differs from what verify saw → report the race and let the caller re-verify.
   *   2. merge run branch → target. What lands is the tree verify saw (§9 measured the landed
   *      tree byte-identical), under a commit id verify never saw — the guarantee is
   *      tree-level on this backend.
   *
   * The window between 1 and 2 is real: a commit to the target in that gap lands a combination
   * nothing verified. Git has no such window; THREAT-MODEL.md carries the difference.
   */
  async publish(ws: Workspace, target: string): Promise<PublishResult> {
    const loc = dvLocation(ws);
    const guard = await this.api(
      'POST',
      `/merges?base_id=${encodeURIComponent(loc.branch)}&other_id=${encodeURIComponent(target)}`,
    );
    if (guard.status === 201) {
      return {
        ok: false,
        reason: 'race',
        detail: `${target} moved since this run integrated it — re-verify against the updated branch`,
      };
    }
    if (guard.status === 202) {
      const mergeId = (guard.body as { merge_id?: string }).merge_id ?? '';
      return {
        ok: false,
        reason: 'error',
        detail: `${target} moved and now conflicts with the run's work — a human must resolve: ${dvMergeUrl(this.repoId, mergeId)}`,
      };
    }
    if (guard.status !== 200) {
      return { ok: false, reason: 'error', detail: `CAS guard failed: HTTP ${guard.status}` };
    }

    const res = await this.api(
      'POST',
      `/merges?base_id=${encodeURIComponent(target)}&other_id=${encodeURIComponent(loc.branch)}`,
    );
    if (res.status === 201) return { ok: true, sha: (res.body as { id?: string }).id ?? '' };
    if (res.status === 200) {
      // Nothing to land — the target already contains the run's work.
      return { ok: true, sha: (await this.branchHead(target)) ?? '' };
    }
    if (res.status === 202) {
      const mergeId = (res.body as { merge_id?: string }).merge_id ?? '';
      return {
        ok: false,
        reason: 'error',
        detail: `landing conflicted inside the CAS window — a human must resolve: ${dvMergeUrl(this.repoId, mergeId)}`,
      };
    }
    return { ok: false, reason: 'error', detail: `publish failed: HTTP ${res.status}` };
  }

  /**
   * The run-addressed pair (RUN-170), expressible here without new API surface: this backend
   * already names a run's line itself — `noriq/run/<id>`, the convention lease() applies — so
   * the run id resolves to that branch IN HERE and the existing integrate/publish machinery
   * (the server-side merge, the backend-carried CAS) does the rest. Implemented even though
   * `leasesOverlap` is absent (pool-of-1 — waves run sequentially here today), because the
   * verbs are honestly answerable; the pool, not this method, is what stops overlap.
   */
  integrateFromRun(ws: Workspace, runId: string): Promise<IntegrateResult> {
    return this.integrate(ws, `noriq/run/${runId}`);
  }

  publishToRun(ws: Workspace, runId: string): Promise<PublishResult> {
    return this.publish(ws, `noriq/run/${runId}`);
  }

  /** Publishing already reached the server — there is nothing further to share (§9: the CLI
   *  has no push at all). A no-op success, exactly as the interface allows for. */
  async share(_repoRoot: string, _target: string): Promise<{ ok: true }> {
    return { ok: true };
  }

  /**
   * The daemon cannot open a Diversion review (RUN-85): `gh` is not the review surface here,
   * and no pending-merge creation endpoint has been measured — inventing that POST is exactly
   * what this file's discipline forbids (dvMergeUrl needs a merge id this flow does not have).
   * So the honest answer is a refusal that says where review actually happens, built from
   * plain prose: the caller warns and records it, which is the whole point — a hand-written
   * `[land].mergeTarget` on this backend used to do NOTHING, silently. No server call: this
   * method states a fact about Diversion, it does not act.
   */
  async openReview(_repoRoot: string, review: ReviewRequest): Promise<ReviewResult> {
    return {
      ok: false,
      detail:
        `review happens in Diversion: merge branch ${review.head} into ${review.base} in the ` +
        `Diversion app (repo ${this.repoId}) — the daemon cannot open a Diversion merge request`,
    };
  }

  /**
   * Crash recovery inverts on this backend (§9): everything a dead run wrote is ALREADY on the
   * server — uncommitted edits included — so there is no local litter to reap and nothing at
   * risk. Leftover noriq/run/* branches are durable, attributable, team-visible history, and
   * deleting team-visible history is a human's call, not a startup side effect. Reported via
   * onSkip so the daemon's "kept" log names them.
   */
  async reapOrphans(_repoRoot: string, opts?: { onSkip?: (path: string) => void }): Promise<number> {
    const res = await this.api('GET', '/branches');
    if (res.status !== 200) return 0;
    const branches = (res.body as { items?: Array<{ branch_name?: string }> }).items ?? [];
    for (const b of branches) {
      if (b.branch_name?.startsWith('noriq/run/')) opts?.onSkip?.(b.branch_name);
    }
    return 0;
  }

  /**
   * NEVER `busy`, NEVER touches `held`/`queue` (RUN-255 locked decision 1) — a reversal of
   * RUN-211's try-acquire posture, not a refinement of it. RUN-211's `busy` check assumed a
   * hypothetical snapshot mechanism that might share the pool-of-1 workspace or the CLI with a
   * held run lease, and refused to even TRY rather than risk the `integrateFromRun`-shaped
   * deadlock a queued wait would be. That assumption no longer holds: this snapshot is pure REST
   * API — no checkout, no workspace, no CLI call anywhere in it — so it has nothing to contend
   * with a held lease OVER. Checking `held.size` here would refuse a real, safe acquisition for a
   * contention that cannot occur, which is worse than the stale check being merely redundant: it
   * would report `busy` for indexing running the entire time a build run is active, which is
   * exactly when landing/publishing triggers it. The snapshot is pinned to the repo's DEFAULT
   * branch's current head (never a moving branch NAME — a long scan must not have its base slide
   * out from under it), read via `GET /repos/{repo}` then `branchHead`, the same lookup `lease`
   * already trusts — passing `default_branch_ID`, never `default_branch_NAME`. `branchHead` itself
   * resolves a name now too (RUN-259: `GET /branches/{name}` measured a reproducible 500 against a
   * real account, on every branch tried, not only this repo's default — `branchIdByName` covers it
   * for any caller that only has a name), so passing the id here is no longer required for
   * correctness, only for cost: this snapshot already holds `default_branch_id` for free off the
   * same `GET /repos/{repo}` call, and handing it straight to `branchHead` skips the extra
   * `GET /branches` list round trip name resolution would otherwise cost. `default_branch_name` is
   * kept only for the snapshot's own DISPLAY field (`IndexSnapshot.branch`'s contract: never an
   * operand).
   *
   * `repoRoot` is no longer unused (RUN-281): it is the SAME directory `lease()` above checks
   * branches into — this daemon's one pool-of-1 workspace for this repo — and it is offered,
   * unconditionally and without taking any lease, as `IndexSnapshot.localPath` AND as the
   * `DiversionIndexSource` constructor's own candidate root, so its `read()` can verify-then-read
   * from it. Offered, never trusted: whatever is sitting at `repoRoot` when this runs could be at
   * any commit, mid-checkout, or simply not exist, and `DiversionIndexSource` never assumes
   * otherwise — see that file's module doc for the full scheme. This is exactly the extension
   * `IndexSnapshot.localPath`'s own doc in `vcs/types.ts` now documents: an operand for the
   * snapshot's own `source`, still never one for anything outside it.
   */
  async leaseIndexSnapshot(repoRoot: string): Promise<IndexSnapshotResult> {
    const repoRes = await this.api('GET', '');
    if (repoRes.status !== 200) {
      return {
        ok: false,
        reason: 'unsupported',
        detail: `could not read repo ${this.repoId} to resolve its default branch: HTTP ${repoRes.status}`,
      };
    }
    const repoBody = repoRes.body as { default_branch_id?: string; default_branch_name?: string };
    const branchId = repoBody.default_branch_id;
    const branch = repoBody.default_branch_name;
    if (!branchId || !branch) {
      return { ok: false, reason: 'unsupported', detail: `repo ${this.repoId} reports no default branch` };
    }
    const baseId = await this.branchHead(branchId);
    if (baseId === null) {
      return {
        ok: false,
        reason: 'unsupported',
        detail: `default branch ${branch} (${branchId}) in ${this.repoId} has no commits yet`,
      };
    }

    return {
      ok: true,
      snapshot: {
        source: new DiversionIndexSource(this.repoId, baseId, this.http, this.blobHttp, repoRoot),
        baseId,
        branch,
        readOnly: true,
        // The offer, for logs/diagnostics (`IndexSnapshot.localPath`'s own doc) — the SAME string
        // just wired into `DiversionIndexSource` above as its verify-then-read candidate root, one
        // fact minted once, delivered twice. Never read as an operand outside this backend.
        localPath: repoRoot,
        location: { kind: 'index-snapshot', repoId: this.repoId } satisfies DvIndexSnapshotLocation,
      },
    };
  }

  /**
   * Idempotent no-op past the identity check (RUN-255): unlike git's snapshot, this one never
   * materialized anything — no checkout, no directory, no server-side reservation — so there is
   * nothing to give back beyond confirming the caller is not handing this backend a foreign
   * object (`dvIndexSnapshotLocation` applies the same discipline `dvLocation` applies to a
   * foreign `Workspace`). `source.close?.()` is called anyway, defensively, in case a future
   * source variant ever holds something open.
   */
  async releaseIndexSnapshot(snapshot: IndexSnapshot): Promise<void> {
    dvIndexSnapshotLocation(snapshot);
    await snapshot.source.close?.();
  }

  /**
   * The cheap "what is current" check (RUN-222). An EXPLICIT `branch` is a three-line delegation
   * to `branchHead`, which resolves a NAME itself as of RUN-259 — no extra round trip. Omitted →
   * this resolves the repo's DEFAULT branch first, via the exact same call `leaseIndexSnapshot`
   * above already makes (`GET /repos/{repo}` → `default_branch_id`), then delegates the same way.
   *
   * **Deliberately NOT `dv branch-name` via `this.cli`**, despite `computeKnownPaths` using exactly
   * that CLI call for a similar-sounding question. The two questions are NOT the same: this backend
   * is pool-of-1 (§9 at the top of this file) — `repoRoot` is ONE shared local checkout that every
   * lease/dispose cycle re-`checkout`s to a different branch (`lease()` itself), so `dv branch-name`
   * answers "what is THIS WORKSPACE showing right now," never "what is the repo's default branch."
   * `computeKnownPaths` gets away with it because `queryIgnored`'s only caller is the operator-run
   * `index-repo` debug command, never this daemon's own background path. `currentBase` is the
   * opposite: the trigger layer calls it with no `isRunBusy` gate in front (that check lives INSIDE
   * the coordinator's `attempt()`, downstream of where the trigger layer already computed
   * `currentBaseId`), and `onLanded` fires BEFORE the just-finished run's workspace is disposed — so
   * the likely moment for this fallback to run on a repo with no configured `defaultBranch` is
   * exactly when the shared workspace is still checked out to that run's own throwaway branch. A
   * `dv branch-name` fallback would then hand `branchHead` that run's branch name and report ITS
   * head as "the current base" — a confidently WRONG answer, not an honest `unknown`, the one thing
   * `CurrentBaseResult`'s doc forbids. The API-based resolution has no such window: `GET /repos`
   * asks the SERVER for the repo's own identity fact, never the local checkout's transient state.
   */
  async currentBase(_repoRoot: string, branch?: string): Promise<CurrentBaseResult> {
    try {
      let resolved = branch;
      if (!resolved) {
        const repoRes = await this.api('GET', '');
        if (repoRes.status !== 200) {
          return {
            ok: false,
            reason: 'unknown',
            detail: `could not read repo ${this.repoId} to resolve its default branch: HTTP ${repoRes.status}`,
          };
        }
        const repoBody = repoRes.body as { default_branch_id?: string };
        if (!repoBody.default_branch_id) {
          return { ok: false, reason: 'unknown', detail: `repo ${this.repoId} reports no default branch` };
        }
        resolved = repoBody.default_branch_id;
      }
      const head = await this.branchHead(resolved);
      return head === null
        ? { ok: false, reason: 'unknown', detail: `branch ${resolved} does not resolve in ${this.repoId}` }
        : { ok: true, baseId: head };
    } catch (err) {
      return { ok: false, reason: 'unknown', detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * `GET /repos/{repo}/compare?base_id=&other_id=&recurse=all_changes` (RUN-255, measured live) —
   * `diversion-index-source.ts`'s module doc carries the full measurement; this is the decode.
   * Every item's `other_item` is present even for a pure deletion (a tombstone entry: same path,
   * a canonical "deleted" hash, no `blob`) — measured across 10,637 real items, zero exceptions —
   * so `other_item` absent is treated as an answer this file cannot trust rather than guessed at.
   * A directory tombstone or add (`mode` TREE/SUBREPO) is skipped: `recurse=all_changes` also lists
   * the FILES inside a new/deleted folder as their own items, so nothing is lost by ignoring the
   * folder-level entry itself (measured: a 227-item "move a directory tree" diff carried individual
   * file adds/deletes alongside the directory-level ones).
   *
   * `has_restricted_files` escalates the WHOLE answer (locked decision 8): never measured `true`
   * against this OWNER-access account, but a `true` means some paths were filtered from `items`
   * by permissions, and reporting the rest as complete would be the same harm an empty diff is —
   * a stale generation served as current because nobody could see what was missing.
   */
  async changesBetween(_repoRoot: string, from: string, to: string): Promise<ChangesBetweenResult> {
    const res = await this.api(
      'GET',
      `/compare?base_id=${encodeURIComponent(from)}&other_id=${encodeURIComponent(to)}&recurse=all_changes`,
    );
    if (res.status !== 200) {
      return {
        ok: false,
        reason: 'full-index-required',
        detail: `compare ${from}..${to} in ${this.repoId} failed: HTTP ${res.status}`,
      };
    }

    const body = res.body as {
      items?: Array<{
        status: number;
        other_item?: { path: string; mode: number; prev_path?: string };
      }>;
      has_restricted_files?: boolean;
    };
    if (body.has_restricted_files) {
      return {
        ok: false,
        reason: 'full-index-required',
        detail: `compare ${from}..${to} in ${this.repoId} reports has_restricted_files — the listing is incomplete, not a full diff`,
      };
    }

    const changed = new Set<string>();
    const deleted = new Set<string>();
    for (const item of body.items ?? []) {
      const oi = item.other_item;
      if (!oi) {
        return {
          ok: false,
          reason: 'full-index-required',
          detail: `compare ${from}..${to} in ${this.repoId} returned an item with no other_item — cannot express it`,
        };
      }
      if (isDirectoryMode(oi.mode)) continue; // directories are never index candidates.

      const verb = decodeObjectStatus(item.status);
      if (verb === null) {
        return {
          ok: false,
          reason: 'full-index-required',
          detail: `compare ${from}..${to} in ${this.repoId} reported an unrecognized status ${item.status} at ${oi.path}`,
        };
      }
      if (verb === 'intact') continue; // never seen on a real from/to compare — no-op if it is.
      if (verb === 'deleted') {
        deleted.add(oi.path);
      } else {
        changed.add(oi.path);
      }
      // A rename hands the OLD path directly (locked decision 5) — no rename arm, no heuristic:
      // the old path is removed from the index, the new path is (re-)read into it.
      if (oi.prev_path && oi.prev_path !== oi.path) deleted.add(oi.prev_path);
    }

    if (changed.size + deleted.size > CHANGES_BETWEEN_MAX_PATHS) {
      return {
        ok: false,
        reason: 'full-index-required',
        detail: `${changed.size + deleted.size} changed paths between ${from} and ${to} exceeds the ${CHANGES_BETWEEN_MAX_PATHS}-path cap`,
      };
    }
    return { ok: true, changed: [...changed], deleted: [...deleted] };
  }

  /**
   * **Corrected after being wrong.** The first landing of this method concluded `dv --help` names
   * no `check-ignore`/`p4 ignores` equivalent and returned `unknown` unconditionally. That premise
   * was true and the conclusion was not: there is no DEDICATED query command, but Diversion still
   * honours `.dvignore` AND `.gitignore` (docs.diversion.dev/basic/dvignore, and confirmed live
   * against a real repo — `dv status` silently omits a file matching either from its `New:`
   * section while an unmatched sibling appears, for both dialects). The fix is not a parser for
   * either dialect (still forbidden — see the module-level `.dvignore`/`.gitignore` floor); it is
   * asking Diversion the SAME two ways this backend already asks it everything else:
   *
   *   1. **What does Diversion TRACK** — `GET /trees/{ref}?recurse=true`, the exact endpoint
   *      `DiversionIndexSource` already uses for real indexing (reused via its own `.list()`
   *      rather than re-walked here, so there is exactly one implementation of that pagination).
   *      A path in this set is definitely not ignored — ignore rules only ever gate whether a NEW
   *      path gets added, never an already-tracked one.
   *   2. **What would Diversion ADD if asked** — `dv status`'s `New:` section, the CLI's own
   *      answer to "which untracked files are not ignored" (reusing `hasWork`'s already-measured
   *      section-header parsing, extended to collect paths rather than only testing for a match).
   *
   * A path on disk in NEITHER set is ignored — the caller (`buildVcsIgnoredPredicate`,
   * `index-repo.ts`) only ever asks about paths a real `readdir` produced, so "absent from both"
   * cannot mean "does not exist".
   *
   * **Neither endpoint offers a per-directory batch** — `/trees` always pages the WHOLE tree
   * (`DiversionIndexSource`'s own doc: `ShouldDescend` "buys back only pipeline cost, never
   * network cost"), and `dv status <paths>` — the form that WOULD scope to a batch — switches to
   * per-file SYNC-status reporting and answers "Synced" for literally any argument, including a
   * path that does not exist, discarding the ignore signal entirely (measured, not assumed,
   * against the same live repo). So this cannot be the cheap, PER-DIRECTORY primitive
   * `git check-ignore --stdin`/`p4 ignores -i` are — it is one FULL, EXPENSIVE fetch, cached for
   * the rest of this backend instance's life (`knownPathsFor` below), never repeated per
   * directory. A backend answering this way is the honest tradeoff for a REST-and-CLI-only VCS
   * with no local index to consult, not a shortcut.
   */
  async queryIgnored(repoRoot: string, paths: string[]): Promise<IgnoreQueryResult> {
    const known = await this.knownPathsFor(repoRoot);
    if (!known) {
      return {
        ok: false,
        reason: 'unknown',
        detail:
          'could not resolve what Diversion tracks for this workspace (no current branch, or ' +
          'the tree/status fetch failed) — see the daemon log for the underlying error',
      };
    }
    const ignored = new Set<string>();
    for (const p of paths) {
      if (known.files.has(p) || known.dirPrefixes.has(p)) continue;
      ignored.add(p);
    }
    return { ok: true, ignored };
  }

  /**
   * The one-shot fetch `queryIgnored` above never repeats per directory (its own doc explains
   * why). `dirPrefixes` holds every ANCESTOR directory of every known file (`Content/Base/Crow` for
   * `Content/Base/Crow/ABP_Crow.uasset`) so a directory candidate resolves in O(1) rather than a
   * per-call scan over the whole tree — computed once here, alongside the files themselves, never
   * recomputed by a caller.
   *
   * Returns `null` — never throws — on anything that stops this from being trustworthy: no
   * resolvable branch, a non-200 tree page, a CLI failure. `null` reads as "unknown" one layer up,
   * per this method's own may-miss-never-invent contract; a PARTIAL tree (a page fetched, a later
   * one failed) is exactly as untrustworthy as no tree at all, so it is not returned as if it were
   * complete.
   */
  private async knownPathsFor(repoRoot: string): Promise<KnownPaths | null> {
    let cached = this.knownPathsCache.get(repoRoot);
    if (!cached) {
      cached = this.computeKnownPaths(repoRoot);
      this.knownPathsCache.set(repoRoot, cached);
    }
    return cached;
  }

  private async computeKnownPaths(repoRoot: string): Promise<KnownPaths | null> {
    try {
      const { stdout: branchRaw } = await this.cli(['branch-name'], repoRoot);
      const branch = branchRaw.trim();
      if (!branch) return null;
      // `branchHead` resolves a NAME itself now (RUN-259, the follow-up RUN-256 filed: `GET
      // /branches/{name}` 500s and `GET /branches/{id}` 200s for the exact same branch, measured
      // live against every branch on a real account, not only the default one this call first hit
      // it on) — the explicit branchIdByName-then-branchHead(id) two-step this used to need is
      // redundant now that a single call does both steps INSIDE branchHead, not per caller.
      const head = await this.branchHead(branch);
      if (!head) return null;

      const files = new Set<string>();
      const dirPrefixes = new Set<string>();
      const source = new DiversionIndexSource(this.repoId, head, this.http, this.blobHttp);
      for await (const item of source.list()) {
        if (item.kind !== 'file') return null; // a refused '.' means the whole listing failed
        files.add(item.entry.path);
        const segments = item.entry.path.split('/');
        for (let i = 1; i < segments.length; i++) dirPrefixes.add(segments.slice(0, i).join('/'));
      }

      const { stdout: statusRaw } = await this.cli(['status', '--nowait', '--no-limit'], repoRoot);
      for (const newPath of parseStatusSection(statusRaw, 'New')) {
        files.add(newPath);
        const segments = newPath.split('/');
        for (let i = 1; i < segments.length; i++) dirPrefixes.add(segments.slice(0, i).join('/'));
      }

      return { files, dirPrefixes };
    } catch {
      return null; // network error, missing dv binary, malformed response — all unknown, never a guess
    }
  }

  /**
   * Locking on Diversion (RUN-100): the Noriq lock view is the AUTHORITATIVE cross-run
   * coordination layer (same primitive as git — so two runner runs contend uniformly and the
   * dashboard is unified), and Diversion's own SOFT LOCK is layered on best-effort after a grant.
   *
   * Soft locks are Pro-gated: on a non-Pro workspace the native call fails, and locking DEGRADES
   * to the Noriq layer alone (RUN-100) — which is fully functional, just without dv's own file
   * indicator. The native call never fails the grant the Noriq view already made. The exact dv
   * soft-lock endpoint shape is confirmed at the RUN-107 dogfood against a live Pro workspace;
   * until then the degrade path is the guaranteed one.
   */
  async lock(ws: Workspace, paths: string[], ctx: LockContext): Promise<LockOutcome> {
    if (!this.locks || paths.length === 0) return { ok: true, enabled: false, locks: [] };
    const r = await this.locks.acquire(ctx.token, {
      projectId: ctx.projectId,
      paths,
      branch: ctx.branch,
      taskId: ctx.taskId,
    });
    if (!r.ok) return { ok: false, conflicts: r.conflicts };
    if (r.enabled) await this.nativeSoftLock(ws, paths, 'acquire');
    return { ok: true, enabled: r.enabled, locks: r.locks };
  }

  async unlock(
    ws: Workspace,
    sel: { lockIds?: string[]; paths?: string[] },
    ctx: LockContext,
  ): Promise<void> {
    if (!this.locks) return;
    if (sel.paths?.length) await this.nativeSoftLock(ws, sel.paths, 'release');
    await this.locks.release(ctx.token, ctx.projectId, sel);
  }

  async queryLocks(_repoRoot: string, paths: string[], ctx: LockContext) {
    if (!this.locks || paths.length === 0) return { enabled: false, conflicts: [], mine: [] };
    return this.locks.check(ctx.token, { projectId: ctx.projectId, paths, branch: ctx.branch });
  }

  /** Release the run's Noriq-view locks (RUN-104); dv soft locks (Pro) release with the
   *  workspace's branch switch on dispose. */
  async releaseRunLocks(_ws: Workspace, ctx: LockContext): Promise<void> {
    if (!this.locks) return;
    await this.locks.releaseAllMine(ctx.token, ctx.projectId);
  }

  /** Best-effort Diversion soft lock over `paths`. Guarded whole: any failure (Pro-gated, offline,
   *  endpoint drift) degrades silently to the Noriq layer, which already decided the outcome. */
  private async nativeSoftLock(ws: Workspace, paths: string[], verb: 'acquire' | 'release'): Promise<void> {
    try {
      const loc = dvLocation(ws);
      const method = verb === 'acquire' ? 'POST' : 'DELETE';
      await this.api(method, '/locks', { branch: loc.branch, paths });
    } catch {
      /* soft locks are Pro-gated — the Noriq layer stands (RUN-100 graceful degrade) */
    }
  }
}
