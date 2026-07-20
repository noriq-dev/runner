import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { LockDelegate } from './git';
import type {
  IntegrateResult,
  LeaseOptions,
  LockContext,
  LockOutcome,
  PublishResult,
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

/** The page a human resolves a pending merge on — the CLI prints exactly this shape (§9). */
export const dvMergeUrl = (repoId: string, mergeId: string): string =>
  `https://app.diversion.dev/repo/${repoId}/merges/${mergeId}`;

export interface DiversionBackendOpts {
  /** The Diversion repo id (dv.repo.…) this backend serves — one backend instance per repo. */
  repoId: string;
  http?: DvHttp;
  cli?: DvCli;
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

export class DiversionBackend implements VcsBackend {
  readonly kind = 'diversion';
  /** Unlanded work survives dispose without help: checkpointed commits live on the run's
   *  server-side branch, and even uncommitted edits synced continuously (§9). Skipping dispose
   *  to "keep" work here would only wedge the pool-of-1 lease (RUN-52's find). */
  readonly disposePreservesWork = true;
  private readonly repoId: string;
  private readonly http: DvHttp;
  private readonly cli: DvCli;
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

  constructor(opts: DiversionBackendOpts) {
    this.repoId = opts.repoId;
    this.http = opts.http ?? realDvHttp();
    this.cli = opts.cli ?? realDvCli;
    this.locks = opts.locks;
  }

  private api(method: string, p: string, body?: unknown) {
    return this.http(method, `/repos/${encodeURIComponent(this.repoId)}${p}`, body);
  }

  private async branchHead(branch: string): Promise<string | null> {
    const res = await this.api('GET', `/branches/${encodeURIComponent(branch)}`);
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`branch lookup for ${branch} failed: HTTP ${res.status}`);
    const b = res.body as { commit_id?: string; branch_id?: string };
    return b.commit_id ?? null;
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

  /** Publishing already reached the server — there is nothing further to share (§9: the CLI
   *  has no push at all). A no-op success, exactly as the interface allows for. */
  async share(_repoRoot: string, _target: string): Promise<{ ok: true }> {
    return { ok: true };
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
