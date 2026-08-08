import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { chmod, mkdir, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * Normalize a path for comparing what the DAEMON built against what GIT reports (RUN-95).
 *
 * On Windows one directory has several spellings: path.join says `C:\Users\RUNNER~1\…`
 * (backslashes, possibly the 8.3 short form) while git porcelain prints `C:/Users/…`. Comparing
 * them verbatim concluded a registered worktree wasn't — so a continue's adopt path ran
 * `worktree add` into the existing checkout and every Windows continue failed. realpath collapses
 * the short/long split where the path exists (falling back for one that doesn't), slashes are
 * unified, and win32 compares case-insensitively because its filesystems do.
 */
export function comparableWorktreePath(p: string): string {
  // Slashes FIRST: a backslashed spelling is not even absolute to POSIX path.resolve, which
  // would silently prefix the cwd and defeat the comparison this exists for.
  const unified = p.replace(/\\/g, '/');
  let resolved = unified;
  try {
    resolved = realpathSync.native(unified);
  } catch {
    // Not on disk (e.g. a pruned checkout still listed as prunable) — compare as spelled.
  }
  const posix = path.resolve(resolved).replace(/\\/g, '/');
  return process.platform === 'win32' ? posix.toLowerCase() : posix;
}

/** Where per-Run worktrees are created (outside any repo). */
export const DEFAULT_WORKTREES_DIR = path.join(os.homedir(), '.noriq', 'worktrees');

/** Runs a git subcommand in a repo. Injectable so the lifecycle is testable. */
export type GitRunner = (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;

export const defaultGit: GitRunner = async (args, cwd) => {
  const { stdout, stderr } = await execFileP('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return { stdout, stderr };
};

/**
 * Who the daemon commits as, passed per-invocation (RUN-42).
 *
 * Per-invocation because the daemon must not depend on — or mutate — the operator's global git
 * config, and because the authorship should read as the runner's rather than as the human's.
 *
 * It is REQUIRED, not cosmetic, on any git command that writes a commit. Git refuses outright
 * with "Committer identity unknown" when none is configured, and a fresh box has none: that is
 * the exact machine this project is trying to be installable on. `commitWork` always had this;
 * `rebase` and `rebase --continue` did not, so on a box with no global identity EVERY landing
 * failed — RUN-27/28's whole pipeline — and the CI runner, which has no identity, is what
 * finally said so out loud.
 */
const AUTHOR = ['-c', 'user.name=Noriq Runner', '-c', 'user.email=runner@noriq.local'];

/** Hooks belong to the operator, not to this Run — never fire them on its behalf. */
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

/** Every Run's throwaway branch is namespaced so it's recognizable + reapable. */
export const WORKTREE_BRANCH_PREFIX = 'noriq/run/';
export const runBranch = (runId: string): string => `${WORKTREE_BRANCH_PREFIX}${runId}`;

export interface WorktreeInfo {
  runId: string;
  repoRoot: string;
  path: string;
  branch: string;
  readOnly: boolean;
  /** The commit this branch forked from — resolved at create time, because once the
   *  agent commits, the worktree's own HEAD no longer identifies the starting point. */
  baseSha: string;
}

export interface CreateWorktreeOptions {
  /** Scope runs get a physically read-only checkout (defense-in-depth; the driver
   *  permission profile is the primary enforcement). */
  readOnly?: boolean;
  /** Base ref to branch from. Defaults to the repo's current HEAD. */
  baseRef?: string;
}

/**
 * A read-only index snapshot's git-level handle (RUN-211) — `WorktreeManager.createIndexSnapshot`'s
 * return, wrapped by `GitBackend.leaseIndexSnapshot` into the backend-neutral `IndexSnapshot`.
 * Deliberately narrower than `WorktreeInfo`: no `branch` (a snapshot is detached — see
 * `createIndexSnapshot`) and no `runId` (a snapshot belongs to no run).
 */
export interface IndexSnapshotHandle {
  repoRoot: string;
  path: string;
  /** The commit the snapshot is pinned at — resolved at create time, same reasoning as
   *  `WorktreeInfo.baseSha`, though nothing can move a detached HEAD here after the fact. */
  baseSha: string;
}

/** The infix that makes a snapshot's directory unmistakably not a run worktree (`<repo>-<runId>`
 *  never contains this), both for a human reading `~/.noriq/worktrees` and for the reap sweep's
 *  own naming-based recognition below — a snapshot has no branch, so it cannot be recognized the
 *  way `listManaged` recognizes a run (RUN-211). */
const INDEX_SNAPSHOT_INFIX = 'index-snapshot';

function indexSnapshotDirName(repoRoot: string, id: string): string {
  return `${path.basename(repoRoot)}-${INDEX_SNAPSHOT_INFIX}-${id}`;
}

// Recursively flip write bits on a checkout. Skips the .git pointer. Best-effort:
// individual chmod failures don't abort (permission enforcement is layered).
async function chmodTree(dir: string, writable: boolean): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return;
  for (const e of entries) {
    if (e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (writable) {
        await chmod(p, 0o755).catch(() => {});
        await chmodTree(p, writable);
      } else {
        // lock children first, then the dir, so we can still descend
        await chmodTree(p, writable);
        await chmod(p, 0o555).catch(() => {});
      }
    } else {
      await chmod(p, writable ? 0o644 : 0o444).catch(() => {});
    }
  }
}
export const setReadOnly = (dir: string): Promise<void> => chmodTree(dir, false);
export const setWritable = (dir: string): Promise<void> => chmodTree(dir, true);

/**
 * One git worktree per Run on a throwaway branch (noriq/run/<id>) — never two runs
 * in one checkout, never auto-push/merge. The branch name encodes the run id, so
 * leftover worktrees are reapable after a daemon crash without any external state.
 */
export class WorktreeManager {
  private readonly baseDir: string;
  private readonly git: GitRunner;

  constructor(opts: { baseDir: string; git?: GitRunner }) {
    this.baseDir = opts.baseDir;
    this.git = opts.git ?? defaultGit;
  }

  private worktreePath(repoRoot: string, runId: string): string {
    return path.join(this.baseDir, `${path.basename(repoRoot)}-${runId}`);
  }

  /** Does the run's throwaway branch already exist locally? True only for a kept, gate-failed
   *  prior attempt at this exact run id (RUN-91) — a fresh run's id has never been minted. */
  private async branchExists(repoRoot: string, branch: string): Promise<boolean> {
    try {
      await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot);
      return true;
    } catch {
      return false; // rev-parse --quiet exits non-zero (no output) when the ref is absent
    }
  }

  /** Is `dir` still a registered worktree of this repo? (A reap can spare a branch but prune its
   *  worktree; then a continue must re-attach one rather than assume the checkout is there.) */
  private async worktreeRegistered(repoRoot: string, dir: string): Promise<boolean> {
    const { stdout } = await this.git(['worktree', 'list', '--porcelain'], repoRoot);
    // Never compare the spellings verbatim (RUN-95): git prints forward slashes where this
    // daemon built platform ones, which on Windows read as "not registered" for a worktree
    // that very much was — and the adopt path then collided with its own checkout.
    const want = comparableWorktreePath(dir);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .some(
        (line) =>
          line.startsWith('worktree ') && comparableWorktreePath(line.slice('worktree '.length)) === want,
      );
  }

  /** Create the Run's isolated worktree + throwaway branch. */
  async create(repoRoot: string, runId: string, opts: CreateWorktreeOptions = {}): Promise<WorktreeInfo> {
    await mkdir(this.baseDir, { recursive: true });
    const branch = runBranch(runId);
    const dir = this.worktreePath(repoRoot, runId);
    const baseRef = opts.baseRef ?? 'HEAD';

    // Continue a failed run (RUN-91). A gate-failed build is KEPT, not disposed, so its branch and
    // worktree survive on disk; the server re-dispatches the SAME run id (PLNR-180) and "resume"
    // is inferred from exactly this — the branch already existing. Adopt it: `worktree add -b`
    // would fail on the branch, and re-forking would discard the work the prior attempt committed.
    // The fork point is recovered as the branch's merge-base with the target, so the diff still
    // spans the WHOLE accumulated change rather than only what this sitting adds.
    if (await this.branchExists(repoRoot, branch)) {
      if (!(await this.worktreeRegistered(repoRoot, dir))) {
        await this.git(['worktree', 'add', dir, branch], repoRoot); // branch kept, worktree pruned
      }
      const { stdout: forkSha } = await this.git(['merge-base', branch, baseRef], repoRoot);
      // No setReadOnly on adopt: a continue is a build (writable), and re-chmod'ing a tree full of
      // the prior attempt's work is both pointless and a fight with the agent about to edit it.
      return {
        runId,
        repoRoot,
        path: dir,
        branch,
        readOnly: opts.readOnly ?? false,
        baseSha: forkSha.trim(),
      };
    }

    // Pin the fork point BEFORE the agent can move HEAD — this is what "did it change
    // anything?" is measured against later.
    const { stdout: baseSha } = await this.git(['rev-parse', baseRef], repoRoot);
    await this.git(['worktree', 'add', '-b', branch, dir, baseRef], repoRoot);
    const info: WorktreeInfo = {
      runId,
      repoRoot,
      path: dir,
      branch,
      readOnly: opts.readOnly ?? false,
      baseSha: baseSha.trim(),
    };
    if (info.readOnly) await setReadOnly(dir);
    return info;
  }

  /**
   * Pin a DETACHED worktree at `baseRef` (default HEAD) for read-only indexing (RUN-211) — never
   * for an agent. No branch, ever: indexing the repo root directly would read the operator's
   * working tree — dirty files, a mid-rebase state — so the index would describe a tree no
   * `baseId` names, and a pinned detached checkout is what makes the result deterministic for a
   * given base instead. No branch also means nothing can land from it, and `reapOrphans`'s own
   * branch-name recognition (`listManaged`) never mistakes it for an orphaned RUN — the directory
   * naming (`<repo>-index-snapshot-<id>`, never `<repo>-<runId>`) is what the sweep below uses to
   * recognize one on its own terms.
   *
   * Space-isolated like `create`: every call mints its own worktree, so many snapshots — and a
   * snapshot alongside any number of run worktrees — may coexist without contention.
   */
  async createIndexSnapshot(repoRoot: string, opts: { baseRef?: string } = {}): Promise<IndexSnapshotHandle> {
    await mkdir(this.baseDir, { recursive: true });
    const baseRef = opts.baseRef ?? 'HEAD';
    const dir = path.join(this.baseDir, indexSnapshotDirName(repoRoot, randomUUID()));
    const { stdout: baseSha } = await this.git(['rev-parse', baseRef], repoRoot);
    await this.git(['worktree', 'add', '--detach', dir, baseRef], repoRoot);
    return { repoRoot, path: dir, baseSha: baseSha.trim() };
  }

  /**
   * Remove a snapshot minted by `createIndexSnapshot`. IDEMPOTENT: a second call (or one racing a
   * prior removal) finds `git worktree remove` failing on an already-gone path, which is
   * swallowed the same way `remove()` swallows it for a run's worktree — a no-op, not an error.
   * No branch to delete: a snapshot never had one.
   */
  async removeIndexSnapshot(handle: Pick<IndexSnapshotHandle, 'repoRoot' | 'path'>): Promise<void> {
    await this.git(['worktree', 'remove', '--force', handle.path], handle.repoRoot).catch(() => {});
    await this.git(['worktree', 'prune'], handle.repoRoot).catch(() => {});
  }

  /** Snapshot worktrees left behind by a crashed daemon, recognized by directory naming alone —
   *  they carry no branch, so `listManaged`'s branch-based recognition can never see them. Used
   *  only by `reapOrphans`, which prunes every one it finds ONLY on the startup sweep (`isOwned`
   *  absent): a snapshot is detached and was never written, so no PROCESS crash can lose work by
   *  leaving one behind — but a snapshot currently on lease (RUN-214) is indistinguishable from a
   *  leaked one by inspection, same as a live run's workspace, and deleting it out from under an
   *  in-flight indexing scan pulls the tree out from under it mid-read. Startup is the one time
   *  that risk cannot exist: every prior process, and so every lease, died with it. */
  private async listIndexSnapshots(repoRoot: string): Promise<string[]> {
    let stdout: string;
    try {
      ({ stdout } = await this.git(['worktree', 'list', '--porcelain'], repoRoot));
    } catch {
      return [];
    }
    const out: string[] = [];
    let curPath: string | null = null;
    let detached = false;
    const flush = () => {
      if (curPath && detached && path.basename(curPath).includes(`-${INDEX_SNAPSHOT_INFIX}-`)) {
        out.push(curPath);
      }
      curPath = null;
      detached = false;
    };
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        flush();
        curPath = line.slice('worktree '.length).trim();
      } else if (line.trim() === 'detached') {
        detached = true;
      } else if (line.trim() === '') {
        flush();
      }
    }
    flush();
    return out;
  }

  /**
   * Did this Run actually produce anything? Counts BOTH uncommitted working-tree
   * changes and commits the agent made on its throwaway branch — an agent may leave
   * the diff either way.
   *
   * The daemon uses this to tell a real build from a no-op. An agent that bailed (no
   * plan, blocked, or simply refused) leaves the worktree pristine; running the verify
   * command over that is pure waste, and worse, a PASS on an empty tree would land the
   * Run in review as a success with nothing in it.
   *
   * **Throws rather than answering `false` when git cannot be asked** (RUN-152). This used to
   * substitute `'0'` for a failed `rev-list`, which made "no committed work" and "the query broke"
   * the same answer — a fail-OPEN, because every consumer of `false` destroys something: the
   * lock-refusal guard disposes the workspace (`worktree remove --force` + `branch -D` on a branch
   * that was never pushed), and the no-changes gate reaps it. On an ADOPTED continuation that is
   * the prior sitting's committed diff, which exists nowhere else. Both callers already wrapped
   * this in a `.catch(() => true)`; the swallow inside was what stopped those guards from ever
   * firing.
   */
  async hasChanges(info: Pick<WorktreeInfo, 'path' | 'baseSha'>): Promise<boolean> {
    const { stdout: dirty } = await this.git(['status', '--porcelain'], info.path);
    if (dirty.trim()) return true;
    // An empty base makes git read `..HEAD` as `HEAD..HEAD` and print a confident 0 — a fail-open
    // with no error anywhere to catch. A parked record persisted with `baseId: ''` reaches here.
    if (!info.baseSha.trim()) throw new Error('worktree has no base commit — cannot tell what it produced');
    // Committed work: anything on this branch that isn't on the base it forked from.
    const { stdout: ahead } = await this.git(['rev-list', '--count', `${info.baseSha}..HEAD`], info.path);
    const count = ahead.trim();
    // `rev-list --count` always prints a number. Anything else means we did not get an answer,
    // and `Number('')` is 0 — the same fail-open by a shorter route.
    if (!/^\d+$/.test(count)) {
      throw new Error(`git rev-list --count gave no usable answer: ${JSON.stringify(ahead)}`);
    }
    if (Number(count) > 0) return true;
    // About to answer "there is nothing here", which is the answer that gets acted on by deleting
    // things. `base..HEAD` only measures what HEAD points at: with a DETACHED HEAD sitting on the
    // base, a run branch full of commits measures as zero, and `branch -D` then takes the lot.
    // Exiting nonzero when HEAD is not on a branch is exactly what `symbolic-ref` is for.
    await this.git(['symbolic-ref', '--quiet', 'HEAD'], info.path);
    return false;
  }

  /**
   * The repo-relative paths this run touched — uncommitted (working tree) PLUS committed since
   * the base it forked from (RUN-102). The hard-floor lock gate acquires these as the run's
   * holder before the diff is made durable, so a write the reactive hook never saw (a Codex run,
   * or a Bash write its parser bailed on) still cannot land over a path a peer holds.
   *
   * **Throws rather than returning a partial or empty set** (RUN-156). Both probes used to swallow
   * their errors, so "this run changed nothing" and "git would not tell me what it changed" arrived
   * as the same `[]` — and the floor treats an empty set as nothing to lock, which is a PASS. That
   * is a fail-open on the one layer that is the FIRST acquisition for a driver with no in-process
   * hook: a build could land over a path a peer holds and no line anywhere would say so.
   *
   * A partial answer is refused for the same reason. Locking the paths one probe managed to report
   * looks exactly like a floor that ran, while the paths the other probe would have named go
   * unlocked — a silent under-lock is worse than a loud failure, because only one of them gets
   * looked at.
   *
   * Both probes are read with `-z`, which is the same requirement wearing different clothes. Git's
   * human output C-QUOTES anything non-ASCII or unusual under the default `core.quotePath`, so
   * `src/é.ts` arrives as `"src/\303\251.ts"` — and a floor that locks that string has locked a path
   * that does not exist while leaving the real one free. `-z` emits raw bytes with NUL separators:
   * no quoting to undo, and no ambiguity for a filename containing a newline or ` -> `.
   */
  async changedPaths(info: Pick<WorktreeInfo, 'path' | 'baseSha'>): Promise<string[]> {
    // Same guard as `hasChanges`, and for the same reason: git reads `..HEAD` as `HEAD..HEAD` and
    // reports a confident zero paths. Here that is a floor with nothing to lock, which reads as a
    // pass.
    if (!info.baseSha.trim()) throw new Error('worktree has no base commit — cannot tell what it changed');
    const set = new Set<string>();

    // `XY <path>\0`, and for a rename/copy `XY <new>\0<old>\0` — two fields, destination FIRST.
    const { stdout: porc } = await this.git(['status', '--porcelain', '-z'], info.path);
    const fields = porc.split('\0');
    for (let i = 0; i < fields.length; i++) {
      const entry = fields[i];
      if (!entry) continue;
      const status = entry.slice(0, 2);
      const p = entry.slice(3);
      // The rename's SOURCE is the next field. Consumed rather than parsed: the write this floor
      // is protecting is the destination, and treating a source as its own entry would mangle the
      // one after it.
      if (status.includes('R') || status.includes('C')) i += 1;
      if (p) set.add(p);
    }

    const { stdout: committed } = await this.git(
      ['diff', '--name-only', '-z', `${info.baseSha}..HEAD`],
      info.path,
    );
    for (const p of committed.split('\0')) if (p) set.add(p);

    // About to answer "this run changed nothing" — the answer the floor reads as a pass. Detached
    // at the base, a run branch full of commits reports no paths, and it is that BRANCH that lands.
    if (!set.size) await this.git(['symbolic-ref', '--quiet', 'HEAD'], info.path);
    return [...set];
  }

  /** Tear down a worktree + delete its (never-pushed) branch. Safe to call twice. */
  async remove(info: Pick<WorktreeInfo, 'repoRoot' | 'path' | 'branch'>): Promise<void> {
    await setWritable(info.path).catch(() => {}); // so git can delete read-only scope files
    await this.git(['worktree', 'remove', '--force', info.path], info.repoRoot).catch(() => {});
    await this.git(['worktree', 'prune'], info.repoRoot).catch(() => {});
    // -D (not -d): the branch was never merged/pushed, that's expected — force-delete.
    await this.git(['branch', '-D', info.branch], info.repoRoot).catch(() => {});
  }

  /** List this daemon's managed worktrees in a repo (parsed from `git worktree list`). */
  async listManaged(repoRoot: string): Promise<Array<{ path: string; branch: string; runId: string }>> {
    let stdout: string;
    try {
      ({ stdout } = await this.git(['worktree', 'list', '--porcelain'], repoRoot));
    } catch {
      return [];
    }
    const out: Array<{ path: string; branch: string; runId: string }> = [];
    let curPath: string | null = null;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) curPath = line.slice('worktree '.length).trim();
      else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim(); // refs/heads/noriq/run/<id>
        const branch = ref.replace(/^refs\/heads\//, '');
        if (curPath && branch.startsWith(WORKTREE_BRANCH_PREFIX)) {
          out.push({ path: curPath, branch, runId: branch.slice(WORKTREE_BRANCH_PREFIX.length) });
        }
        curPath = null;
      } else if (line.trim() === '') {
        curPath = null;
      }
    }
    return out;
  }

  /**
   * Commit whatever the Run left behind onto its throwaway branch, so the diff is a
   * real commit a human can review, cherry-pick, or merge — and so it survives a reap.
   *
   * The daemon does this rather than the agent: an agent that bails, forgets, or lacks
   * a git allowlist would otherwise leave the work as loose files that the next
   * `git worktree remove --force` deletes without trace. Returns false when there was
   * nothing to commit.
   *
   * Local commit only — this never pushes, and no agent gets push credentials.
   */
  async commitWork(info: Pick<WorktreeInfo, 'path'>, message: string): Promise<boolean> {
    const { stdout: dirty } = await this.git(['status', '--porcelain'], info.path);
    if (!dirty.trim()) return false; // already committed by the agent, or nothing to save
    await this.git(['add', '-A'], info.path);
    await this.git(
      [
        ...AUTHOR,
        'commit',
        '--no-verify', // hooks are the operator's, not this Run's to trigger
        '-m',
        message,
      ],
      info.path,
    );
    return true;
  }

  /** Does this ref resolve in the repo? (Used to tell "no landing branch yet" from a typo.) */
  async refExists(repoRoot: string, ref: string): Promise<boolean> {
    return await this.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoRoot)
      .then(() => true)
      .catch(() => false);
  }

  /** Create `branch` at `from` — the landing branch's first existence. */
  async createBranch(repoRoot: string, branch: string, from: string): Promise<void> {
    await this.git(['branch', branch, from], repoRoot);
  }

  /**
   * Rebase the Run's commits onto `onto` inside its own worktree, so the diff that gets
   * verified is the diff that will land. Returns the conflicted paths instead of throwing
   * — a conflict is an expected outcome here, not an error, and the caller may hand it to
   * the agent to resolve.
   *
   * On conflict the rebase is left IN PROGRESS (not aborted): that is what lets an agent
   * open the conflicted files, fix them, and continue. Callers that don't resolve must
   * call `abortRebase`.
   */
  async rebaseOnto(
    info: Pick<WorktreeInfo, 'path'>,
    onto: string,
  ): Promise<{ ok: true } | { ok: false; conflicts: string[] }> {
    try {
      // AUTHOR because a rebase WRITES commits (it replays them onto a new base), and git
      // refuses with "Committer identity unknown" when none is configured — which is the
      // default state of a fresh box, and was of CI.
      await this.git([...NO_HOOKS, ...AUTHOR, 'rebase', onto], info.path);
      return { ok: true };
    } catch {
      const { stdout } = await this.git(['diff', '--name-only', '--diff-filter=U'], info.path).catch(() => ({
        stdout: '',
        stderr: '',
      }));
      const conflicts = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      // A rebase that failed with no unmerged paths isn't a conflict we can hand to an
      // agent (bad ref, dirty tree, …) — surface it as such rather than pretend.
      if (!conflicts.length) {
        await this.abortRebase(info).catch(() => {});
        throw new Error(`rebase onto ${onto} failed without conflicts`);
      }
      return { ok: false, conflicts };
    }
  }

  /** Is a rebase still in progress (i.e. unresolved)? */
  async rebaseInProgress(info: Pick<WorktreeInfo, 'path'>): Promise<boolean> {
    const { stdout } = await this.git(['status', '--porcelain=v2', '--branch'], info.path).catch(() => ({
      stdout: '',
      stderr: '',
    }));
    // Cheap + portable: rev-parse the rebase state dirs git maintains during one.
    const { stdout: dir } = await this.git(['rev-parse', '--git-path', 'rebase-merge'], info.path).catch(
      () => ({ stdout: '', stderr: '' }),
    );
    if (!dir.trim()) return stdout.includes('rebase');
    const { existsSync } = await import('node:fs');
    const { stdout: apply } = await this.git(['rev-parse', '--git-path', 'rebase-apply'], info.path).catch(
      () => ({ stdout: '', stderr: '' }),
    );
    // path.isAbsolute, NOT startsWith('/') (RUN-42). `--git-path` returns an absolute path here,
    // and on Windows that is `C:/…` — which does not start with '/', so it read as RELATIVE and
    // got mangled into `${info.path}/C:/…`. existsSync then said false and rebaseInProgress()
    // answered "no rebase in progress" — a WRONG ANSWER rather than an error, silently disabling
    // the agent conflict-resolution path that resolveConflict exists to provide.
    const resolve = (p: string) => (path.isAbsolute(p) ? p : path.join(info.path, p));
    return existsSync(resolve(dir.trim())) || existsSync(resolve(apply.trim() || 'x'));
  }

  /** Stage everything and continue a conflicted rebase (after an agent resolved it). */
  async continueRebase(
    info: Pick<WorktreeInfo, 'path'>,
  ): Promise<{ ok: true } | { ok: false; conflicts: string[] }> {
    await this.git(['add', '-A'], info.path);
    try {
      await this.git(
        // core.editor=true so `--continue` never opens an editor for the commit message, and
        // AUTHOR for the same reason as rebaseOnto: this writes the resolved commit.
        [...NO_HOOKS, ...AUTHOR, '-c', 'core.editor=true', 'rebase', '--continue'],
        info.path,
      );
      return { ok: true };
    } catch {
      const { stdout } = await this.git(['diff', '--name-only', '--diff-filter=U'], info.path).catch(() => ({
        stdout: '',
        stderr: '',
      }));
      return {
        ok: false,
        conflicts: stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      };
    }
  }

  /** Put the worktree back the way it was before a failed rebase. */
  async abortRebase(info: Pick<WorktreeInfo, 'path'>): Promise<void> {
    await this.git(['rebase', '--abort'], info.path).catch(() => {});
  }

  /**
   * Fast-forward `branch` to the Run's HEAD. FF-only by design: the Run was just rebased
   * onto this branch, so anything other than a fast-forward means the branch moved under
   * us (a concurrent landing) — better to fail and retry than to invent a merge commit
   * nobody asked for.
   *
   * Local only. The daemon does not push, and this does not change that.
   */
  /** Which worktree, if any, has `branch` checked out. Load-bearing: git flatly refuses
   *  to move a branch that someone has checked out, and `main` always does. */
  async checkoutOf(repoRoot: string, branch: string): Promise<string | null> {
    const { stdout } = await this.git(['worktree', 'list', '--porcelain'], repoRoot).catch(() => ({
      stdout: '',
      stderr: '',
    }));
    let cur: string | null = null;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) cur = line.slice('worktree '.length).trim();
      else if (line.startsWith('branch ')) {
        if (line.slice('branch '.length).trim() === `refs/heads/${branch}`) return cur;
        cur = null;
      }
    }
    return null;
  }

  async landFastForward(
    repoRoot: string,
    branch: string,
    fromRef: string,
  ): Promise<{ ok: true; sha: string } | { ok: false; reason: 'race' | 'error'; detail: string }> {
    const { stdout: before } = await this.git(['rev-parse', branch], repoRoot);
    const { stdout: ahead } = await this.git(['rev-list', '--count', `${branch}..${fromRef}`], repoRoot);
    const { stdout: behind } = await this.git(['rev-list', '--count', `${fromRef}..${branch}`], repoRoot);
    // Genuinely not a fast-forward: the branch grew commits this run never saw. Inventing
    // a merge commit here would paper over a lost race and land an untested combination.
    if (Number(behind.trim()) > 0) {
      return {
        ok: false,
        reason: 'race',
        detail: `${branch} has moved on (${behind.trim()} commit(s) the run doesn't have) — not a fast-forward`,
      };
    }
    if (Number(ahead.trim()) === 0) return { ok: true, sha: before.trim() }; // nothing to land

    try {
      const checkout = await this.checkoutOf(repoRoot, branch);
      if (!checkout) {
        // Nobody is sitting on it — just move the ref. No working tree to disturb.
        await this.git(['branch', '-f', branch, fromRef], repoRoot);
      } else {
        // `git branch -f` FAILS on a checked-out branch ("cannot force update the branch
        // ... used by worktree at ..."), which is the normal case when [land].branch is
        // `main`. Fast-forward inside that worktree instead — exactly what `git pull`
        // does — but only if it's clean: silently rewriting files under someone's editor
        // is not a trade the daemon gets to make on their behalf.
        // TRACKED changes only. Untracked files (a scratch dir, an uncommitted
        // .noriq/project.toml) do not block a fast-forward and must not veto a landing —
        // and if an untracked file WOULD be clobbered by the merge, git refuses on its
        // own with a precise message, which the catch below reports verbatim.
        const { stdout: dirty } = await this.git(['status', '--porcelain', '--untracked-files=no'], checkout);
        if (dirty.trim()) {
          return {
            ok: false,
            reason: 'error',
            detail: `${branch} is checked out at ${checkout} with uncommitted changes, so landing would rewrite files under you. Commit or stash there, or point [land].branch at a branch you do not sit on.`,
          };
        }
        await this.git(['-c', 'core.hooksPath=/dev/null', 'merge', '--ff-only', fromRef], checkout);
      }
    } catch (err) {
      // Anything git refused for a reason we did not anticipate — report what it SAID
      // rather than guessing at a cause.
      return { ok: false, reason: 'error', detail: (err as Error).message };
    }
    const { stdout: after } = await this.git(['rev-parse', branch], repoRoot);
    return { ok: true, sha: after.trim() };
  }

  /**
   * Push the landing branch to its remote (RUN-27, `[land].autoPush`).
   *
   * Deliberately narrow, because this is the one boundary the daemon otherwise has:
   *
   *  - **one refspec, named explicitly** (`branch:branch`) — never `--all`, never `--tags`,
   *    never a bare `git push` that could follow a `push.default` config into pushing something
   *    else. The daemon pushes the branch it just landed on, and nothing else exists as far as
   *    this command is concerned.
   *  - **never `--force`**, and `--force-with-lease` is not a compromise either: a non-fast-
   *    forward means the remote has commits this machine has not seen, which is a human's
   *    problem. Rewriting someone else's history to make a robot's push succeed is not a trade
   *    the daemon gets to make.
   *
   * Returns rather than throws: the work is ALREADY landed locally when this runs, so a failed
   * push is news, not a failure. Treating it as one would mark a run failed whose diff is safely
   * on the branch — and send someone hunting for work that is right there.
   */
  async pushBranch(
    repoRoot: string,
    branch: string,
    remote = 'origin',
  ): Promise<{ ok: true } | { ok: false; detail: string }> {
    try {
      await this.git(['push', remote, `${branch}:${branch}`], repoRoot);
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  /**
   * Crash-safe cleanup: on a fresh daemon start every local process is gone, so any
   * leftover noriq/run/* worktree is orphaned (the server reconcile fails its Run).
   * Reap them — EXCEPT any that still holds unsaved work.
   *
   * A worktree with uncommitted changes or commits of its own is an agent's output that
   * nothing else has a copy of; `git worktree remove --force` would destroy it silently.
   * Skip those and let a human decide. Returns the count actually removed.
   *
   * `isOwned` is what lets this run PERIODICALLY rather than only at startup (RUN-153). At start
   * the question does not arise — every prior process is dead, so every managed worktree is by
   * definition an orphan. Mid-flight it is the whole question: a live run's worktree is
   * indistinguishable from a leaked one by inspection, and it can be legitimately empty (an agent
   * that has not written yet), so `hasUnsavedWork` would not save it. The daemon answers from
   * what it owns; a caller that passes nothing gets the startup meaning unchanged.
   */
  async reapOrphans(
    repoRoot: string,
    opts: { onSkip?: (path: string) => void; isOwned?: (runId: string) => boolean } = {},
  ): Promise<number> {
    const managed = (await this.listManaged(repoRoot)).filter((w) => !opts.isOwned?.(w.runId));
    // An orphan's fork point died with the daemon that made it, so measure against the
    // primary worktree's HEAD: commits the branch holds that the repo doesn't.
    const { stdout: mainHead } = await this.git(['rev-parse', 'HEAD'], repoRoot).catch(() => ({
      stdout: '',
      stderr: '',
    }));
    let removed = 0;
    for (const w of managed) {
      const unsaved = await this.hasUnsavedWork(w.path, mainHead.trim()).catch(() => true);
      if (unsaved) {
        opts.onSkip?.(w.path);
        continue;
      }
      // Asked AGAIN, immediately before the delete. The filter above ran before several async git
      // calls, and a parked run can be resumed inside that window — it is added to the daemon's
      // live set before it touches its worktree, so the second question catches it and the first
      // one could not.
      if (opts.isOwned?.(w.runId)) continue;
      await this.remove({ repoRoot, path: w.path, branch: w.branch });
      removed += 1;
    }

    // Index snapshots (RUN-211) are pruned only on the STARTUP sweep — `opts.isOwned` absent,
    // this same doc's "Absent = the startup meaning" above. At startup no process survives, so no
    // snapshot can be on lease, and it is safe by construction: detached, never written, holds no
    // work. Mid-flight (`isOwned` present) a leased snapshot looks exactly like a leaked one — the
    // same problem `isOwned` exists to solve for `managed` above — and unlike a run's worktree it
    // has no "still holds unsaved work" check to fall back on, because nothing is ever written to
    // one; the failure mode instead is deleting the tree out from under an in-flight scan reading
    // it (RUN-214's coordinator leases and releases one). Never added to `removed` either way: a
    // snapshot is not a run, and counting it would corrupt the reaped-run total the daemon logs.
    if (!opts.isOwned) {
      for (const snapshotPath of await this.listIndexSnapshots(repoRoot)) {
        await this.removeIndexSnapshot({ repoRoot, path: snapshotPath });
      }
    }

    return removed;
  }

  /** Work that exists ONLY here: uncommitted files, or commits the repo doesn't have.
   *  Errs toward "yes" — a wrong guess costs a stale directory, never someone's work. */
  private async hasUnsavedWork(path: string, mainHead: string): Promise<boolean> {
    const { stdout: dirty } = await this.git(['status', '--porcelain'], path);
    if (dirty.trim()) return true;
    if (!mainHead) return true; // can't establish a baseline → keep it
    const { stdout: ahead } = await this.git(['rev-list', '--count', `${mainHead}..HEAD`], path).catch(
      () => ({ stdout: '1', stderr: '' }),
    );
    return Number(ahead.trim() || '0') > 0;
  }
}
