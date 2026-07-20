import type { LockClient } from '../lock-client';
import { type WorktreeManager, runBranch } from '../worktree';
import type { LeaseOptions, LockContext, LockOutcome, VcsBackend, Workspace } from './types';

/** The slice of LockClient the git backend delegates its lock ops to — injectable, and OPTIONAL:
 *  a daemon with no Noriq lock layer wired (or a test) constructs GitBackend without it, and the
 *  lock ops become graceful no-ops (`enabled:false`). */
export type LockDelegate = Pick<LockClient, 'acquire' | 'release' | 'check'>;

/** The slice of WorktreeManager this backend delegates to — injectable for tests. */
export type GitOps = Pick<
  WorktreeManager,
  | 'create'
  | 'remove'
  | 'hasChanges'
  | 'changedPaths'
  | 'commitWork'
  | 'refExists'
  | 'createBranch'
  | 'rebaseOnto'
  | 'continueRebase'
  | 'abortRebase'
  | 'landFastForward'
  | 'pushBranch'
  | 'reapOrphans'
>;

/**
 * What git stashes in `Workspace.location` (RUN-50): the repo this worktree belongs to and the
 * throwaway branch carrying the run's work. Exactly the two things the old interface made the
 * SUPERVISOR carry (`repoRoot` params, the `fromRef` argument to publish) — now they never
 * leave the backend.
 */
interface GitLocation {
  repoRoot: string;
  branch: string;
}

/**
 * `location` is `unknown` by design, so the backend re-establishes its shape at every use
 * rather than trusting a cast — because a Workspace does not only arrive from `lease()`: a
 * parked run (RUN-30) round-trips one through JSON on disk, where an old daemon's schema or a
 * hand-edited file can produce anything. A workspace from another backend, or from a stale
 * park, must fail HERE, with a message naming the problem — not as a git error about a branch
 * called "[object Object]".
 */
function gitLocation(ws: Workspace): GitLocation {
  const loc = ws.location as Partial<GitLocation> | null | undefined;
  if (typeof loc?.repoRoot === 'string' && typeof loc?.branch === 'string') {
    return { repoRoot: loc.repoRoot, branch: loc.branch };
  }
  throw new Error(
    `workspace for run ${ws.runId} does not carry a git location — it was minted by another backend or an incompatible daemon version`,
  );
}

/**
 * Git, as a VcsBackend (RUN-49).
 *
 * Deliberately a thin delegation over WorktreeManager rather than a move of its code: the git
 * implementation is proven (worktree.test.ts exercises it against real repos, and CI runs it on
 * Windows), and a pure rename must not disturb it. This class is the NAMING boundary — each
 * method's doc in vcs/types.ts says what the outcome means; worktree.ts says how git delivers
 * it. When a second backend exists and the guts want restructuring, that is its own task with
 * its own evidence, not a rider on a rename.
 *
 * The verb→outcome mapping, for the record (it is also pinned by test/vcs-git.test.ts):
 *
 *   lease → create · dispose → remove · hasWork → hasChanges · checkpoint → commitWork
 *   targetExists → refExists · createTarget → createBranch · integrate → rebaseOnto
 *   resumeIntegrate → continueRebase · abandonIntegrate → abortRebase
 *   publish → landFastForward · share → pushBranch · reapOrphans → reapOrphans
 */
export class GitBackend implements VcsBackend {
  readonly kind = 'git';
  private readonly git: GitOps;
  private readonly locks?: LockDelegate;

  constructor(git: GitOps, locks?: LockDelegate) {
    this.git = git;
    this.locks = locks;
  }

  async lease(repoRoot: string, runId: string, opts?: LeaseOptions): Promise<Workspace> {
    const info = await this.git.create(repoRoot, runId, {
      readOnly: opts?.readOnly,
      // "Lease from run X's work" in git terms: X's throwaway branch. The run-id → branch-name
      // convention is this backend's own (worktree.ts owns it), which is why the option is a
      // run id and not a ref — the supervisor no longer knows the convention exists.
      // A landing target (RUN-82) is already a branch here, so it IS the base ref directly.
      // fromRunId wins: a verify run leases from the build it judges, not from a target.
      baseRef: opts?.fromRunId ? runBranch(opts.fromRunId) : opts?.fromTarget,
    });
    return {
      runId: info.runId,
      localPath: info.path,
      readOnly: info.readOnly,
      baseId: info.baseSha,
      workRef: info.branch,
      location: { repoRoot: info.repoRoot, branch: info.branch } satisfies GitLocation,
    };
  }

  // async so a bad location REJECTS like every other seam failure, rather than throwing
  // synchronously from a method whose signature promises a Promise.
  async dispose(ws: Workspace): Promise<void> {
    const loc = gitLocation(ws);
    return this.git.remove({ repoRoot: loc.repoRoot, path: ws.localPath, branch: loc.branch });
  }

  hasWork(ws: Workspace): Promise<boolean> {
    return this.git.hasChanges({ path: ws.localPath, baseSha: ws.baseId });
  }

  changedPaths(ws: Workspace): Promise<string[]> {
    return this.git.changedPaths({ path: ws.localPath, baseSha: ws.baseId });
  }

  checkpoint(ws: Workspace, message: string): Promise<boolean> {
    return this.git.commitWork({ path: ws.localPath }, message);
  }

  targetExists(repoRoot: string, target: string): Promise<boolean> {
    return this.git.refExists(repoRoot, target);
  }

  createTarget(repoRoot: string, target: string, from: string): Promise<void> {
    return this.git.createBranch(repoRoot, target, from);
  }

  integrate(ws: Workspace, target: string) {
    return this.git.rebaseOnto({ path: ws.localPath }, target);
  }

  resumeIntegrate(ws: Workspace) {
    return this.git.continueRebase({ path: ws.localPath });
  }

  abandonIntegrate(ws: Workspace): Promise<void> {
    return this.git.abortRebase({ path: ws.localPath });
  }

  async publish(ws: Workspace, target: string) {
    const loc = gitLocation(ws);
    return this.git.landFastForward(loc.repoRoot, target, loc.branch);
  }

  share(repoRoot: string, target: string, remote?: string) {
    return remote === undefined
      ? this.git.pushBranch(repoRoot, target)
      : this.git.pushBranch(repoRoot, target, remote);
  }

  reapOrphans(repoRoot: string, opts?: { onSkip?: (path: string) => void }): Promise<number> {
    return this.git.reapOrphans(repoRoot, opts);
  }

  /**
   * Git has NO native file lock (RUN-98) — the whole reason this plan exists — so all three lock
   * ops delegate to Noriq's lock primitive over the injected client, held as the run's agent
   * (`ctx.token`). With no client wired they are no-ops that report `enabled:false`, so a daemon
   * or test without a lock layer behaves exactly as before.
   */
  async lock(_ws: Workspace, paths: string[], ctx: LockContext): Promise<LockOutcome> {
    if (!this.locks || paths.length === 0) return { ok: true, enabled: false, locks: [] };
    const r = await this.locks.acquire(ctx.token, {
      projectId: ctx.projectId,
      paths,
      branch: ctx.branch,
      taskId: ctx.taskId,
    });
    return r.ok ? { ok: true, enabled: r.enabled, locks: r.locks } : { ok: false, conflicts: r.conflicts };
  }

  async unlock(
    _ws: Workspace,
    sel: { lockIds?: string[]; paths?: string[] },
    ctx: LockContext,
  ): Promise<void> {
    if (!this.locks) return;
    await this.locks.release(ctx.token, ctx.projectId, sel);
  }

  async queryLocks(_repoRoot: string, paths: string[], ctx: LockContext) {
    if (!this.locks || paths.length === 0) return { enabled: false, conflicts: [], mine: [] };
    return this.locks.check(ctx.token, { projectId: ctx.projectId, paths, branch: ctx.branch });
  }
}
