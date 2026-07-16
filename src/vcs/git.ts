import type { WorktreeManager } from '../worktree';
import type { LeaseOptions, VcsBackend, Workspace } from './types';

/** The slice of WorktreeManager this backend delegates to — injectable for tests. */
export type GitOps = Pick<
  WorktreeManager,
  | 'create'
  | 'remove'
  | 'hasChanges'
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

  constructor(git: GitOps) {
    this.git = git;
  }

  lease(repoRoot: string, runId: string, opts?: LeaseOptions): Promise<Workspace> {
    return this.git.create(repoRoot, runId, opts);
  }

  dispose(ws: Pick<Workspace, 'repoRoot' | 'path' | 'branch'>): Promise<void> {
    return this.git.remove(ws);
  }

  hasWork(ws: Pick<Workspace, 'path' | 'baseSha'>): Promise<boolean> {
    return this.git.hasChanges(ws);
  }

  checkpoint(ws: Pick<Workspace, 'path'>, message: string): Promise<boolean> {
    return this.git.commitWork(ws, message);
  }

  targetExists(repoRoot: string, target: string): Promise<boolean> {
    return this.git.refExists(repoRoot, target);
  }

  createTarget(repoRoot: string, target: string, from: string): Promise<void> {
    return this.git.createBranch(repoRoot, target, from);
  }

  integrate(ws: Pick<Workspace, 'path'>, target: string) {
    return this.git.rebaseOnto(ws, target);
  }

  resumeIntegrate(ws: Pick<Workspace, 'path'>) {
    return this.git.continueRebase(ws);
  }

  abandonIntegrate(ws: Pick<Workspace, 'path'>): Promise<void> {
    return this.git.abortRebase(ws);
  }

  publish(repoRoot: string, target: string, fromRef: string) {
    return this.git.landFastForward(repoRoot, target, fromRef);
  }

  share(repoRoot: string, target: string, remote?: string) {
    return remote === undefined
      ? this.git.pushBranch(repoRoot, target)
      : this.git.pushBranch(repoRoot, target, remote);
  }

  reapOrphans(repoRoot: string, opts?: { onSkip?: (path: string) => void }): Promise<number> {
    return this.git.reapOrphans(repoRoot, opts);
  }
}
