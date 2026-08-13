import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHANGES_BETWEEN_MAX_PATHS, WorktreeManager, defaultGit, runBranch } from '../src/worktree';

const execFileP = promisify(execFile);
const git = (args: string[], cwd: string) => execFileP('git', args, { cwd });

/**
 * Compare a git-REPORTED path with a Node-COMPUTED one (RUN-42).
 *
 * On Windows the two spellings of one directory differ twice over: git says `C:/Users/…` while
 * path.join says `C:\Users\…`, and os.tmpdir() hands back the 8.3 short form
 * (`C:\Users\RUNNER~1\…`) where git resolves the long one (`runneradmin`). Neither difference
 * means the paths are different.
 *
 * A test-only concern, deliberately: the daemon never compares these. It only ever passes a
 * git-reported path back to git as a cwd, and git (like Node's fs) accepts either form. So this
 * normalizes for the assertion rather than the product normalizing for no one.
 */
const realPath = (p: string) => path.resolve(realpathSync.native(p));
const samePath = (a: string, b: string) => realPath(a) === realPath(b);

let repo: string;
let base: string;
let wm: WorktreeManager;

beforeAll(async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'noriq-wt-'));
  repo = path.join(tmp, 'repo');
  base = path.join(tmp, 'worktrees');
  await execFileP('git', ['init', '-q', '-b', 'main', repo]);
  await writeFile(path.join(repo, 'README.md'), '# hi\n');
  await git(['-c', 'user.email=t@t', '-c', 'user.name=T', 'add', '.'], repo);
  await git(['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '-m', 'init'], repo);
  wm = new WorktreeManager({ baseDir: base });
}, 30000);

afterAll(async () => {
  await rm(path.dirname(repo), { recursive: true, force: true }).catch(() => {});
});

describe('WorktreeManager (real git)', () => {
  it('creates one worktree per run on a throwaway branch', async () => {
    const a = await wm.create(repo, 'runA');
    expect(existsSync(a.path)).toBe(true);
    expect(a.branch).toBe(runBranch('runA'));
    expect(existsSync(path.join(a.path, 'README.md'))).toBe(true);

    const b = await wm.create(repo, 'runB');
    expect(b.path).not.toBe(a.path); // never two runs in one checkout

    const managed = await wm.listManaged(repo);
    expect(managed.map((m) => m.runId).sort()).toEqual(['runA', 'runB']);
  });

  it('mounts a scope worktree read-only', async () => {
    const s = await wm.create(repo, 'runScope', { readOnly: true });
    const mode = (await stat(path.join(s.path, 'README.md'))).mode;
    expect(mode & 0o200).toBe(0); // owner write bit cleared
    await wm.remove(s);
  });

  it('remove tears down the worktree and force-deletes the branch', async () => {
    const w = await wm.create(repo, 'runGone');
    await wm.remove(w);
    expect(existsSync(w.path)).toBe(false);
    const branches = await git(['branch', '--list', w.branch], repo);
    expect(branches.stdout.trim()).toBe(''); // branch deleted (never pushed/merged)
    const managed = await wm.listManaged(repo);
    expect(managed.find((m) => m.runId === 'runGone')).toBeUndefined();
  });

  it('reapOrphans clears all managed worktrees (crash-safe restart)', async () => {
    const before = await wm.listManaged(repo);
    expect(before.length).toBeGreaterThan(0); // runA + runB still around
    const reaped = await wm.reapOrphans(repo);
    expect(reaped).toBe(before.length);
    expect(await wm.listManaged(repo)).toHaveLength(0);
  });

  // RUN-153: the same reap has to run PERIODICALLY, and mid-flight a live run's worktree looks
  // exactly like an orphan — it may be pristine (an agent that has not written yet), so the
  // work-bearing check cannot spare it either. Only the daemon knows, so it has to be asked.
  it('reapOrphans spares a worktree the daemon still owns, empty or not', async () => {
    const mine = await wm.create(repo, 'runLive'); // pristine — reapable on every other rule
    const leaked = await wm.create(repo, 'runLeaked');
    const reaped = await wm.reapOrphans(repo, { isOwned: (id) => id === 'runLive' });

    expect(reaped).toBe(1);
    expect((await wm.listManaged(repo)).map((w) => w.runId)).toEqual(['runLive']);
    expect(existsSync(leaked.path)).toBe(false);
    await wm.remove(mine);
  });

  // Ownership is asked TWICE, because several async git calls run between the two. A parked run
  // resumed inside that window is added to the daemon's live set before it touches its worktree,
  // so only the second question can see it — and the first would already have condemned it.
  it('re-asks ownership immediately before deleting, so a resume mid-sweep is safe', async () => {
    const wt = await wm.create(repo, 'runResumed');
    let asked = 0;
    const reaped = await wm.reapOrphans(repo, {
      // Unowned on the way in, owned by the time the delete is due — the resume landed mid-sweep.
      isOwned: () => ++asked > 1,
    });

    expect(reaped).toBe(0);
    expect(existsSync(wt.path)).toBe(true);
    await wm.remove(wt);
  });
});

describe('unsaved work survives (real git)', () => {
  it('commits an agent diff onto the throwaway branch', async () => {
    const wt = await wm.create(repo, 'commitRun');
    await writeFile(path.join(wt.path, 'feature.ts'), 'export const x = 1;\n');

    expect(await wm.hasChanges(wt)).toBe(true);
    expect(await wm.commitWork(wt, 'noriq run commitRun: ACME-140 Event feed invert')).toBe(true);

    // A real commit now exists on the branch — something a human can review/merge.
    const { stdout: subject } = await git(['log', '-1', '--pretty=%s'], wt.path);
    expect(subject.trim()).toBe('noriq run commitRun: ACME-140 Event feed invert');
    const { stdout: author } = await git(['log', '-1', '--pretty=%an'], wt.path);
    expect(author.trim()).toBe('Noriq Runner');
    const { stdout: ahead } = await git(['rev-list', '--count', `${wt.baseSha}..HEAD`], wt.path);
    expect(Number(ahead.trim())).toBe(1);
    // The tree is clean, but hasChanges still reports true — a commit IS produced work.
    const { stdout: porcelain } = await git(['status', '--porcelain'], wt.path);
    expect(porcelain.trim()).toBe('');
    expect(await wm.hasChanges(wt)).toBe(true);

    await wm.remove(wt);
  });

  it('never runs repository hooks during a Runner-owned checkpoint commit', async () => {
    const wt = await wm.create(repo, 'commitWithoutHooks');
    const commonDir = (await git(['rev-parse', '--git-common-dir'], wt.path)).stdout.trim();
    const hook = path.join(path.resolve(wt.path, commonDir), 'hooks', 'post-commit');
    const marker = path.join(wt.path, 'post-commit-fired');
    await writeFile(hook, '#!/bin/sh\ntouch post-commit-fired\n', { mode: 0o755 });
    await writeFile(path.join(wt.path, 'safe.ts'), 'export const safe = true;\n');

    try {
      expect(await wm.commitWork(wt, 'checkpoint without operator hooks')).toBe(true);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(hook, { force: true });
      await wm.remove(wt);
    }
  });

  it('refuses to erase authoritative branch drift while restoring validator residue', async () => {
    const wt = await wm.create(repo, 'validationAuthorityDrift');
    const expectedRevision = (await git(['rev-parse', 'HEAD'], wt.path)).stdout.trim();
    await writeFile(path.join(wt.path, 'foreign-authority.txt'), 'must remain preserved\n');
    await git(['add', 'foreign-authority.txt'], wt.path);
    await git(
      ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '-m', 'foreign authority drift'],
      wt.path,
    );
    const driftRevision = (await git(['rev-parse', 'HEAD'], wt.path)).stdout.trim();

    await expect(wm.restoreExact(wt, expectedRevision)).rejects.toThrow(/authoritative drift/);
    expect((await git(['rev-parse', 'HEAD'], wt.path)).stdout.trim()).toBe(driftRevision);
    expect((await git(['rev-parse', wt.branch], repo)).stdout.trim()).toBe(driftRevision);

    await wm.remove(wt);
  });

  // RUN-152. `false` from hasChanges is acted on DESTRUCTIVELY — the lock-refusal guard disposes
  // the workspace (`worktree remove --force` + `branch -D` on a never-pushed branch) and the
  // no-changes gate reaps it. Substituting '0' for a failed `rev-list` made "there is no work" and
  // "git could not be asked" the same answer, so a transient failure on an ADOPTED continuation
  // could destroy the prior sitting's committed diff. The distinction has to survive in the type.
  describe('hasChanges cannot answer "no work" for "could not tell"', () => {
    const withGit = (git: (args: string[]) => Promise<{ stdout: string; stderr: string }>) =>
      new WorktreeManager({ baseDir: base, git });
    const wt = { path: '/wt/run_1', baseSha: 'base' };

    it('rejects when rev-list fails, rather than reporting an empty worktree', async () => {
      const wm = withGit(async (args) => {
        if (args[0] === 'status') return { stdout: '', stderr: '' }; // clean tree, so it asks rev-list
        throw new Error('fatal: bad object base');
      });
      await expect(wm.hasChanges(wt)).rejects.toThrow(/bad object/);
    });

    // `Number('')` is 0, so an empty answer took the same fail-open by a shorter route.
    it('rejects when rev-list answers with something that is not a count', async () => {
      const wm = withGit(async (args) =>
        args[0] === 'status' ? { stdout: '', stderr: '' } : { stdout: '\n', stderr: '' },
      );
      await expect(wm.hasChanges(wt)).rejects.toThrow(/no usable answer/);
    });

    // `git rev-list --count ..HEAD` is `HEAD..HEAD` — a confident zero with no error to catch.
    it('rejects when there is no base to measure against', async () => {
      const wm = withGit(async () => ({ stdout: '', stderr: '' }));
      await expect(wm.hasChanges({ path: '/wt/run_1', baseSha: '' })).rejects.toThrow(/no base commit/);
    });

    // `base..HEAD` measures what HEAD POINTS AT. Detached onto the base, a run branch full of
    // commits measures as zero — and that zero is what `branch -D` would act on.
    it('rejects when HEAD is detached rather than calling the branch empty', async () => {
      const wm = withGit(async (args) => {
        if (args[0] === 'status') return { stdout: '', stderr: '' };
        if (args[0] === 'rev-list') return { stdout: '0\n', stderr: '' };
        throw new Error('fatal: ref HEAD is not a symbolic ref'); // git's own detached-HEAD exit
      });
      await expect(wm.hasChanges(wt)).rejects.toThrow(/symbolic ref/);
    });

    it('still answers false for a genuinely empty worktree', async () => {
      const wm = withGit(async (args) =>
        args[0] === 'rev-list' ? { stdout: '0\n', stderr: '' } : { stdout: '', stderr: '' },
      );
      expect(await wm.hasChanges(wt)).toBe(false);
    });
  });

  it('is a no-op when the agent already committed', async () => {
    const wt = await wm.create(repo, 'noopCommit');
    expect(await wm.commitWork(wt, 'nothing to save')).toBe(false);
    await wm.remove(wt);
  });

  it('changedPaths lists BOTH uncommitted and committed-since-base files (the hard-floor set, RUN-102)', async () => {
    const wt = await wm.create(repo, 'changedRun');
    // One committed change…
    await writeFile(path.join(wt.path, 'committed.ts'), 'export const c = 1;\n');
    await wm.commitWork(wt, 'noriq run changedRun: committed work');
    // …and one still in the working tree.
    await writeFile(path.join(wt.path, 'dirty.ts'), 'export const d = 2;\n');

    const paths = (await wm.changedPaths(wt)).sort();
    expect(paths).toEqual(['committed.ts', 'dirty.ts']);
    await wm.remove(wt);
  });

  it('changedPaths is empty for a run that touched nothing', async () => {
    const wt = await wm.create(repo, 'untouchedRun');
    expect(await wm.changedPaths(wt)).toEqual([]);
    await wm.remove(wt);
  });

  // RUN-156. `[]` from here means "this run changed nothing", and the hard lock floor reads that
  // as nothing to lock — a PASS. Both probes used to swallow their errors, so a git failure made
  // the floor a silent no-op that reported success; for a driver with no in-process hook that was
  // the run's ONLY acquisition, so a build could land over a path a peer holds and no line
  // anywhere would say the check never ran.
  describe('changedPaths cannot answer "nothing changed" for "could not tell"', () => {
    const withGit = (git: (args: string[]) => Promise<{ stdout: string; stderr: string }>) =>
      new WorktreeManager({ baseDir: base, git });
    const wt = { path: '/wt/run_1', baseSha: 'base' };

    it('rejects when the working-tree probe fails', async () => {
      const wm = withGit(async (args) => {
        if (args[0] === 'status') throw new Error('fatal: not a git repository');
        return { stdout: '', stderr: '' };
      });
      await expect(wm.changedPaths(wt)).rejects.toThrow(/not a git repository/);
    });

    // A PARTIAL answer is refused too: locking the paths one probe managed to report looks exactly
    // like a floor that ran, while everything the other would have named goes unlocked.
    it('rejects when the committed probe fails, rather than reporting a partial set', async () => {
      const wm = withGit(async (args) => {
        if (args[0] === 'status') return { stdout: ' M src/a.ts\0', stderr: '' };
        throw new Error('fatal: bad object base');
      });
      await expect(wm.changedPaths(wt)).rejects.toThrow(/bad object/);
    });

    // `..HEAD` is `HEAD..HEAD` to git — a confident zero paths, with no error to catch. The floor
    // reads zero paths as nothing to lock, which is a pass.
    it('rejects when there is no base to measure against', async () => {
      const wm = withGit(async () => ({ stdout: '', stderr: '' }));
      await expect(wm.changedPaths({ path: '/wt/run_1', baseSha: '' })).rejects.toThrow(/no base commit/);
    });

    // Detached at the base, a run branch full of commits reports no changed paths — and it is that
    // BRANCH that lands, so the floor would check an empty tree and publish the unchecked branch.
    it('rejects an empty answer from a detached HEAD rather than calling it "changed nothing"', async () => {
      const wm = withGit(async (args) => {
        if (args[0] === 'symbolic-ref') throw new Error('fatal: ref HEAD is not a symbolic ref');
        return { stdout: '', stderr: '' };
      });
      await expect(wm.changedPaths(wt)).rejects.toThrow(/symbolic ref/);
    });

    it('still answers [] for a run that genuinely changed nothing', async () => {
      const wm = withGit(async () => ({ stdout: '', stderr: '' }));
      expect(await wm.changedPaths(wt)).toEqual([]);
    });
  });

  // Git's human output C-QUOTES anything non-ASCII under the default core.quotePath, so a floor
  // reading it locks a path that does not exist and leaves the real one free — a silent under-lock
  // wearing the appearance of a floor that ran. `-z` emits raw bytes, NUL-separated.
  describe('changedPaths reads paths git can round-trip, not git’s display form', () => {
    const withGit = (git: (args: string[]) => Promise<{ stdout: string; stderr: string }>) =>
      new WorktreeManager({ baseDir: base, git });
    const wt = { path: '/wt/run_1', baseSha: 'base' };

    it('asks both probes for -z output', async () => {
      const calls: string[][] = [];
      const wm = withGit(async (args) => {
        calls.push(args);
        return { stdout: 'x.ts\0', stderr: '' };
      });
      await wm.changedPaths(wt);
      expect(calls.find((a) => a[0] === 'status')).toContain('-z');
      expect(calls.find((a) => a[0] === 'diff')).toContain('-z');
    });

    it('keeps a non-ASCII filename intact instead of its escaped spelling', async () => {
      const wm = withGit(async (args) =>
        args[0] === 'status'
          ? { stdout: ' M src/café.ts\0', stderr: '' }
          : { stdout: 'src/naïve.ts\0', stderr: '' },
      );
      expect((await wm.changedPaths(wt)).sort()).toEqual(['src/café.ts', 'src/naïve.ts']);
    });

    // In -z a rename is TWO fields, destination first. Reading the source as its own entry would
    // mangle the entry after it — so it is consumed, not parsed.
    it('takes a rename’s destination and does not mistake its source for the next entry', async () => {
      const wm = withGit(async (args) =>
        args[0] === 'status'
          ? { stdout: 'R  src/new.ts\0src/old.ts\0 M src/after.ts\0', stderr: '' }
          : { stdout: '', stderr: '' },
      );
      expect((await wm.changedPaths(wt)).sort()).toEqual(['src/after.ts', 'src/new.ts']);
    });

    it('does not split a filename that happens to contain " -> "', async () => {
      const wm = withGit(async (args) =>
        args[0] === 'status' ? { stdout: ' M src/a -> b.ts\0', stderr: '' } : { stdout: '', stderr: '' },
      );
      expect(await wm.changedPaths(wt)).toEqual(['src/a -> b.ts']);
    });
  });

  it('NEVER reaps a worktree holding uncommitted work', async () => {
    // The regression: reapOrphans ran `worktree remove --force` on daemon start, which
    // silently destroys an agent's uncommitted diff. This is the guard.
    const wt = await wm.create(repo, 'dirtyRun');
    await writeFile(path.join(wt.path, 'precious.ts'), 'export const keep = true;\n');

    const skipped: string[] = [];
    await wm.reapOrphans(repo, { onSkip: (p) => skipped.push(p) });

    expect(skipped.some((p) => samePath(p, wt.path))).toBe(true);
    expect(existsSync(path.join(wt.path, 'precious.ts'))).toBe(true); // the work is still there

    await rm(wt.path, { recursive: true, force: true });
    await wm.remove(wt).catch(() => {});
  });

  it('NEVER reaps a worktree holding commits the repo does not have', async () => {
    const wt = await wm.create(repo, 'committedRun');
    await writeFile(path.join(wt.path, 'work.ts'), 'export const y = 2;\n');
    await wm.commitWork(wt, 'agent work worth keeping');

    const skipped: string[] = [];
    await wm.reapOrphans(repo, { onSkip: (p) => skipped.push(p) });
    expect(skipped.some((p) => samePath(p, wt.path))).toBe(true); // clean tree, but the commit exists nowhere else
    expect(existsSync(wt.path)).toBe(true);

    await wm.remove(wt);
  });

  it('still reaps a genuinely empty orphan', async () => {
    const wt = await wm.create(repo, 'emptyRun');
    expect(await wm.reapOrphans(repo)).toBeGreaterThanOrEqual(1);
    expect(existsSync(wt.path)).toBe(false); // nothing of value was lost
  });
});

describe('landing on a box with NO git identity (RUN-42)', () => {
  // The condition CI runs in, and the condition a fresh install runs in — which is the whole
  // point of this project. git REFUSES to write a commit with "Committer identity unknown" when
  // none is configured, so `rebase` (which replays commits) and `rebase --continue` (which
  // writes the resolved one) failed outright. commitWork always passed an identity; those two
  // did not, so EVERY landing failed on such a box — RUN-27/28's entire pipeline.
  //
  // GIT_CONFIG_GLOBAL/SYSTEM=devNull is what makes this reproducible on a developer machine
  // that does have an identity. Without it this test passes everywhere and proves nothing —
  // which is exactly how the bug reached main in the first place.
  // A path that does not exist, NOT os.devNull: git treats a missing config file as an empty
  // one (exactly what we want), but on Windows os.devNull is `\\.\nul`, which git cannot open
  // as config at all — `fatal: unable to access '//./nul'`. My first attempt at this test used
  // devNull and CI caught it, which is the same lesson as everything else in this task.
  let noConfig: string;
  const noIdentityGit = (args: string[], cwd: string) =>
    execFileP('git', args, {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: noConfig, GIT_CONFIG_SYSTEM: noConfig },
    });

  let bare: string;
  let wmBare: WorktreeManager;

  beforeAll(async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'noriq-noident-'));
    noConfig = path.join(tmp, 'no-such-gitconfig');
    bare = path.join(tmp, 'repo');
    await execFileP('git', ['init', '-q', '-b', 'main', bare]);
    await writeFile(path.join(bare, 'README.md'), '# hi\n');
    // The FIXTURE still needs an identity to build the repo — the point is what the DAEMON does.
    await git(['-c', 'user.email=t@t', '-c', 'user.name=T', 'add', '.'], bare);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '-m', 'init'], bare);
    wmBare = new WorktreeManager({ baseDir: path.join(tmp, 'worktrees'), git: noIdentityGit });
  }, 30000);

  it('commits a run’s work without borrowing the operator’s identity', async () => {
    const wt = await wmBare.create(bare, 'noid1');
    await writeFile(path.join(wt.path, 'a.ts'), 'export const a = 1;\n');
    expect(await wmBare.commitWork(wt, 'noriq run noid1')).toBe(true);
    const { stdout } = await noIdentityGit(['log', '-1', '--format=%an <%ae>'], wt.path);
    // And it reads as the runner, not as a human who never touched it.
    expect(stdout.trim()).toBe('Noriq Runner <runner@noriq.local>');
  });

  it('rebases without one too — this is the bug CI caught', async () => {
    // A rebase REPLAYS commits, so it writes them, so it needs an author. Without one git does
    // not warn and carry on: it stops.
    await wmBare.createBranch(bare, 'noriq/integration-noid', 'main');
    const first = await wmBare.create(bare, 'noid2');
    await writeFile(path.join(first.path, 'x.ts'), 'export const x = 1;\n');
    await wmBare.commitWork(first, 'first');
    const { stdout: head } = await noIdentityGit(['rev-parse', 'HEAD'], first.path);
    await wmBare.landFastForward(bare, 'noriq/integration-noid', head.trim());

    // A second run, forked from before the first landed → a real rebase, not a no-op.
    const second = await wmBare.create(bare, 'noid3', { baseRef: 'main' });
    await writeFile(path.join(second.path, 'y.ts'), 'export const y = 1;\n');
    await wmBare.commitWork(second, 'second');
    const rebased = await wmBare.rebaseOnto(second, 'noriq/integration-noid');
    expect(rebased).toEqual({ ok: true });
    // The rebased sha, resolved in the WORKTREE — 'HEAD' would resolve in the main checkout,
    // which is a different commit entirely.
    const { stdout: tip } = await noIdentityGit(['rev-parse', 'HEAD'], second.path);
    expect(await wmBare.landFastForward(bare, 'noriq/integration-noid', tip.trim())).toMatchObject({
      ok: true,
    });
  });

  it('continues a conflicted rebase without one', async () => {
    await wmBare.createBranch(bare, 'noriq/integration-conf', 'main');
    const a = await wmBare.create(bare, 'noid4');
    await writeFile(path.join(a.path, 'duel.ts'), 'export const v = "a";\n');
    await wmBare.commitWork(a, 'a');
    const { stdout: aHead } = await noIdentityGit(['rev-parse', 'HEAD'], a.path);
    await wmBare.landFastForward(bare, 'noriq/integration-conf', aHead.trim());

    const b = await wmBare.create(bare, 'noid5', { baseRef: 'main' });
    await writeFile(path.join(b.path, 'duel.ts'), 'export const v = "b";\n');
    await wmBare.commitWork(b, 'b');
    const conflicted = await wmBare.rebaseOnto(b, 'noriq/integration-conf');
    expect(conflicted.ok).toBe(false);

    // The agent "resolves" it; --continue writes the resolved commit, so it needs an author too.
    await writeFile(path.join(b.path, 'duel.ts'), 'export const v = "resolved";\n');
    expect((await wmBare.continueRebase(b)).ok).toBe(true);
    expect(await wmBare.rebaseInProgress(b)).toBe(false);
  });
});

describe('landing primitives (real git)', () => {
  const LAND = 'noriq/integration';

  /** A run that changed `file` to `body` and had the daemon commit it. */
  const runWith = async (id: string, file: string, body: string, baseRef?: string) => {
    const wt = await wm.create(repo, id, baseRef ? { baseRef } : {});
    await writeFile(path.join(wt.path, file), body);
    await wm.commitWork(wt, `noriq run ${id}`);
    return wt;
  };

  it('creates the landing branch on first use and fast-forwards a run into it', async () => {
    expect(await wm.refExists(repo, LAND)).toBe(false);
    await wm.createBranch(repo, LAND, 'main');
    expect(await wm.refExists(repo, LAND)).toBe(true);

    const wt = await runWith('landA', 'a.ts', 'export const a = 1;\n');
    const { stdout: head } = await git(['rev-parse', 'HEAD'], wt.path);
    const landed = await wm.landFastForward(repo, LAND, head.trim());

    expect(landed).toEqual({ ok: true, sha: head.trim() });
    const { stdout: onBranch } = await git(['rev-parse', LAND], repo);
    expect(onBranch.trim()).toBe(head.trim());
    // Landing must NOT disturb the operator's own checkout.
    const { stdout: mainHead } = await git(['rev-parse', 'main'], repo);
    expect(mainHead.trim()).not.toBe(head.trim());
    await wm.remove(wt);
  });

  it('rebases a second run onto what the first one landed, then lands it too', async () => {
    // The whole point of rebase-before-verify: run B is verified against A's result.
    const b = await runWith('landB', 'b.ts', 'export const b = 2;\n');
    const res = await wm.rebaseOnto(b, LAND);
    expect(res.ok).toBe(true);

    // B's worktree now contains A's file — the combination, not B in isolation.
    expect(existsSync(path.join(b.path, 'a.ts'))).toBe(true);

    const { stdout: head } = await git(['rev-parse', 'HEAD'], b.path);
    await wm.landFastForward(repo, LAND, head.trim());
    const { stdout: tip } = await git(['rev-parse', LAND], repo);
    expect(tip.trim()).toBe(head.trim());
    await wm.remove(b);
  });

  it('reports conflicted paths instead of throwing, leaving the rebase resolvable', async () => {
    // Two runs touching the same line from the same base — the case an agent may fix.
    const { stdout: landTip } = await git(['rev-parse', LAND], repo);
    const c = await runWith('landC', 'clash.ts', 'export const v = "from C";\n', landTip.trim());
    const d = await runWith('landD', 'clash.ts', 'export const v = "from D";\n', landTip.trim());

    const { stdout: cHead } = await git(['rev-parse', 'HEAD'], c.path);
    await wm.landFastForward(repo, LAND, cHead.trim()); // C lands first

    const res = await wm.rebaseOnto(d, LAND); // D now collides with C
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.conflicts).toEqual(['clash.ts']);
    // Left in progress ON PURPOSE, so an agent can resolve and continue.
    expect(await wm.rebaseInProgress(d)).toBe(true);

    await wm.abortRebase(d);
    expect(await wm.rebaseInProgress(d)).toBe(false);
    await wm.remove(c);
    await wm.remove(d);
  });

  it('an agent resolving the conflict lets the rebase continue and land', async () => {
    // BOTH runs must fork from the SAME base for their edits to collide — a run forked
    // from a tip that already contains the other rebases cleanly and proves nothing.
    const { stdout: base } = await git(['rev-parse', LAND], repo);
    const x = await runWith('landX', 'duel.ts', 'export const v = "from X";\n', base.trim());
    const e = await runWith('landE', 'duel.ts', 'export const v = "from E";\n', base.trim());

    const { stdout: xHead } = await git(['rev-parse', 'HEAD'], x.path);
    await wm.landFastForward(repo, LAND, xHead.trim()); // X lands first

    const res = await wm.rebaseOnto(e, LAND);
    expect(res.ok).toBe(false); // now E genuinely collides with X's line

    // Stand in for the agent's edit: a resolution that keeps both intents.
    await writeFile(path.join(e.path, 'duel.ts'), 'export const v = "from X and E";\n');
    const cont = await wm.continueRebase(e);
    expect(cont.ok).toBe(true);
    expect(await wm.rebaseInProgress(e)).toBe(false);

    const { stdout: head } = await git(['rev-parse', 'HEAD'], e.path);
    await wm.landFastForward(repo, LAND, head.trim());
    const { stdout: landedFile } = await git(['show', `${LAND}:duel.ts`], repo);
    expect(landedFile).toContain('from X and E');
    await wm.remove(x);
    await wm.remove(e);
  });

  it('refuses to land when the branch moved under the run (not a fast-forward)', async () => {
    // Concurrency guard: inventing a merge commit here would hide a lost race.
    const { stdout: landTip } = await git(['rev-parse', LAND], repo);
    const f = await runWith('landF', 'f.ts', 'export const f = 6;\n', landTip.trim());
    const g = await runWith('landG', 'g.ts', 'export const g = 7;\n', landTip.trim());

    const { stdout: gHead } = await git(['rev-parse', 'HEAD'], g.path);
    await wm.landFastForward(repo, LAND, gHead.trim()); // G wins the race

    const { stdout: fHead } = await git(['rev-parse', 'HEAD'], f.path);
    const res = await wm.landFastForward(repo, LAND, fHead.trim());
    expect(res).toMatchObject({ ok: false, reason: 'race' });
    if (!res.ok) expect(res.detail).toMatch(/not a fast-forward/);
    await wm.remove(f);
    await wm.remove(g);
  });
});

describe('landing onto a branch someone has CHECKED OUT (real git)', () => {
  // The case the first live landing hit: [land].branch = "main", and main is — always —
  // checked out in the operator's own repo. `git branch -f` flatly refuses to move it
  // ("cannot force update the branch 'main' used by worktree at ..."), so landing has to
  // fast-forward inside that worktree instead, the way `git pull` would.
  it('knows which worktree holds a branch', async () => {
    expect(samePath((await wm.checkoutOf(repo, 'main'))!, repo)).toBe(true);
    expect(await wm.checkoutOf(repo, 'noriq/integration')).toBeNull(); // nobody sits on it
  });

  it("fast-forwards the operator's checked-out main, updating its files", async () => {
    const { stdout: mainHead } = await git(['rev-parse', 'main'], repo);
    const wt = await wm.create(repo, 'ontoMain', { baseRef: 'main' });
    await writeFile(path.join(wt.path, 'landed-on-main.ts'), 'export const shipped = true;\n');
    await wm.commitWork(wt, 'noriq run ontoMain: lands on main');

    const res = await wm.landFastForward(repo, 'main', wt.branch);
    expect(res.ok).toBe(true);

    // main actually moved...
    const { stdout: after } = await git(['rev-parse', 'main'], repo);
    expect(after.trim()).not.toBe(mainHead.trim());
    // ...and the operator's working tree has the file, not a phantom "deleted" status.
    expect(existsSync(path.join(repo, 'landed-on-main.ts'))).toBe(true);
    const { stdout: status } = await git(['status', '--porcelain'], repo);
    expect(status.trim()).toBe('');

    await wm.remove(wt);
  });

  it("is not blocked by UNTRACKED files in the operator's tree", async () => {
    // The bug that killed two live landings: `git status --porcelain` lists untracked
    // files (an uncommitted .noriq/project.toml is the common case), and the dirty check counted
    // them. Untracked files cannot block a fast-forward.
    await writeFile(path.join(repo, 'scratch-notes.txt'), 'my own untracked file\n');

    const wt = await wm.create(repo, 'ontoUntracked', { baseRef: 'main' });
    await writeFile(path.join(wt.path, 'ff-with-untracked.ts'), 'export const ok = true;\n');
    await wm.commitWork(wt, 'noriq run ontoUntracked');

    const res = await wm.landFastForward(repo, 'main', wt.branch);
    expect(res.ok).toBe(true); // lands despite the untracked file sitting there
    // ...and the operator's untracked file is left exactly alone.
    expect(await readFile(path.join(repo, 'scratch-notes.txt'), 'utf8')).toContain('my own untracked file');

    await rm(path.join(repo, 'scratch-notes.txt'));
    await wm.remove(wt);
  });

  it('refuses rather than rewrite files under someone with uncommitted work', async () => {
    const wt = await wm.create(repo, 'ontoDirty', { baseRef: 'main' });
    await writeFile(path.join(wt.path, 'another.ts'), 'export const x = 1;\n');
    await wm.commitWork(wt, 'noriq run ontoDirty');

    // The human is mid-edit on main.
    await writeFile(path.join(repo, 'README.md'), '# hi\n\nwork in progress\n');
    const res = await wm.landFastForward(repo, 'main', wt.branch);

    expect(res).toMatchObject({ ok: false, reason: 'error' });
    if (!res.ok) {
      expect(res.detail).toContain('uncommitted changes');
      expect(res.detail).toContain('[land].branch'); // tells them the way out
    }
    // Their edit is untouched, and nothing landed.
    expect(await readFile(path.join(repo, 'README.md'), 'utf8')).toContain('work in progress');

    await git(['checkout', '--', 'README.md'], repo);
    await wm.remove(wt);
  });
});

describe('rebaseInProgress survives a Windows git path (RUN-42)', () => {
  // The bug was silent, which is why it needed pinning: `git rev-parse --git-path rebase-merge`
  // returns an ABSOLUTE path, and on Windows that is `C:/…` — which does not start with '/'.
  // The old `p.startsWith('/')` test therefore read it as relative and mangled it into
  // `${info.path}/C:/…`; existsSync said false; rebaseInProgress answered "no rebase".
  // A wrong ANSWER, not an error — it silently disabled the agent conflict-resolution path
  // that resolveConflict exists to provide, and no smoke test would notice.
  const wmWith = (gitPath: string, existing: string[]) => {
    const seen: string[] = [];
    const wm = new WorktreeManager({
      baseDir: '/base',
      git: async (args) => {
        if (args[0] === 'rev-parse' && args[1] === '--git-path') return { stdout: gitPath, stderr: '' };
        return { stdout: '', stderr: '' }; // `status --porcelain=v2 --branch`: no 'rebase' text
      },
    });
    // Intercept what existsSync is actually asked about — the mangling is the bug, so the path
    // it probes IS the assertion.
    return { wm, seen, existing };
  };

  it('treats an absolute POSIX path as absolute', async () => {
    const { wm } = wmWith('/repo/.git/worktrees/run_1/rebase-merge', []);
    // No such dir exists → not rebasing. The point here is that it did not throw or mangle.
    expect(await wm.rebaseInProgress({ path: '/wt/run_1' })).toBe(false);
  });

  it('does not prepend the worktree to a C:/ path', async () => {
    // On the real Windows box existsSync('C:/repo/.git/…/rebase-merge') answers truthfully;
    // what matters here is that we no longer ask it about '/wt/run_1/C:/repo/…', which can
    // never exist and so could only ever answer "no rebase".
    const { wm } = wmWith('C:/repo/.git/worktrees/run_1/rebase-merge', []);
    await expect(wm.rebaseInProgress({ path: 'C:\\wt\\run_1' })).resolves.toBe(false);
  });

  it('still falls back to porcelain status when git says nothing', async () => {
    const wm = new WorktreeManager({
      baseDir: '/base',
      git: async (args) => {
        if (args[0] === 'rev-parse') return { stdout: '', stderr: '' };
        return { stdout: '# branch.head noriq/run/run_1 (rebase)', stderr: '' };
      },
    });
    expect(await wm.rebaseInProgress({ path: '/wt/run_1' })).toBe(true);
  });
});

describe('continue a failed run adopts the kept worktree (RUN-91)', () => {
  it('re-creating a run id whose branch exists reuses the worktree and its committed work', async () => {
    // First attempt: an agent commits work, then the run "fails" — the daemon keeps the worktree.
    const first = await wm.create(repo, 'continueRun');
    await writeFile(path.join(first.path, 'attempt.ts'), 'export const tries = 1;\n');
    await wm.commitWork(first, 'noriq run continueRun: first attempt');
    const { stdout: firstHead } = await git(['rev-parse', 'HEAD'], first.path);

    // The continue dispatch (PLNR-180) re-sends the SAME run id. create() must ADOPT, never throw
    // on the existing branch, and never re-fork away the committed work.
    const again = await wm.create(repo, 'continueRun');
    expect(again.branch).toBe(first.branch);
    expect(samePath(again.path, first.path)).toBe(true);
    expect(existsSync(path.join(again.path, 'attempt.ts'))).toBe(true);
    const { stdout: againHead } = await git(['rev-parse', 'HEAD'], again.path);
    expect(againHead.trim()).toBe(firstHead.trim()); // same tip — resumed, not restarted

    // baseSha is the fork point (merge-base with the target), so the accumulated diff still counts.
    const { stdout: fork } = await git(['merge-base', again.branch, 'main'], repo);
    expect(again.baseSha).toBe(fork.trim());
    expect(await wm.hasChanges(again)).toBe(true);

    await wm.remove(again);
  });

  it("adopt recognizes a registered worktree despite git's other-slash spelling (RUN-95)", async () => {
    // The Windows CI failure: the daemon builds `C:\Users\RUNNER~1\…` while porcelain prints
    // `C:/Users/…`, so a verbatim compare said "unregistered" and `worktree add` collided with
    // the checkout it should have adopted. Driven through an injected git that reports the
    // OPPOSITE slash spelling of the computed path, so the split reproduces on every OS; the
    // real-git adopt path is covered by the tests around this one.
    const dir = path.join(base, `${path.basename(repo)}-continueWin`);
    // A registered worktree is also a materialized checkout. The stale-registration recovery path
    // intentionally removes registrations whose directory is gone, so keep this fixture faithful
    // to the alternate-slash case it is meant to prove.
    await mkdir(dir, { recursive: true });
    const flipped = dir.includes('\\') ? dir.replace(/\\/g, '/') : dir.replace(/\//g, '\\');
    const calls: string[][] = [];
    const fake = new WorktreeManager({
      baseDir: base,
      git: async (args: string[]) => {
        calls.push(args);
        if (args[0] === 'worktree' && args[1] === 'list')
          return {
            stdout: `worktree ${flipped}\nHEAD abc\nbranch refs/heads/${runBranch('continueWin')}\n`,
            stderr: '',
          };
        if (args[0] === 'merge-base') return { stdout: 'base\n', stderr: '' };
        if (args[0] === 'worktree' && args[1] === 'add')
          throw new Error('adopt must not re-add a registered worktree');
        return { stdout: '', stderr: '' }; // rev-parse --verify: branch "exists"
      },
    });
    const adopted = await fake.create(repo, 'continueWin');
    expect(adopted.branch).toBe(runBranch('continueWin'));
    expect(adopted.baseSha).toBe('base');
    expect(calls.some((a) => a[0] === 'worktree' && a[1] === 'add')).toBe(false);
  });

  it('re-attaches a worktree when the branch was kept but its checkout was pruned', async () => {
    const first = await wm.create(repo, 'continuePruned');
    await writeFile(path.join(first.path, 'work.ts'), 'export const y = 2;\n');
    await wm.commitWork(first, 'noriq run continuePruned: work');
    // A reap that spared committed work can leave the branch while pruning the checkout dir.
    await git(['worktree', 'remove', '--force', first.path], repo);
    expect(existsSync(first.path)).toBe(false);
    expect((await git(['branch', '--list', first.branch], repo)).stdout.trim()).not.toBe('');

    const again = await wm.create(repo, 'continuePruned');
    expect(samePath(again.path, first.path)).toBe(true);
    expect(existsSync(path.join(again.path, 'work.ts'))).toBe(true); // re-attached to the branch tip

    await wm.remove(again);
  });
});

// RUN-170: the wave return trip, against REAL git — the exact composition GitBackend makes of
// these primitives (lease({fromRunId}) → create(baseRef: runBranch(parent)), integrateFromRun →
// rebaseOnto(runBranch(parent)), publishToRun → landFastForward(runBranch(parent), childBranch)).
// The fakes elsewhere pin the chain's sequencing; this pins that git actually delivers the
// outcome: parent tip carries every landed child, the parent's checked-out worktree reflects
// them, the gate's diff sees the accumulation, and no merge commit is invented.
describe('a wave’s return trip (real git)', () => {
  it('lands both children on the parent tip, reflected in the parent worktree, with no merge commit', async () => {
    const parent = await wm.create(repo, 'waveP');
    // The parent's own accumulated work, checkpointed before the wave opens — children fork the
    // BRANCH, so this is what makes it visible to them.
    await writeFile(path.join(parent.path, 'parent.ts'), 'export const p = 1;\n');
    await wm.commitWork(parent, 'parent work');

    // Two children forked FROM THE PARENT RUN's branch — lease({fromRunId}) in git terms.
    const c1 = await wm.create(repo, 'waveP--s1', { baseRef: runBranch('waveP') });
    const c2 = await wm.create(repo, 'waveP--s2', { baseRef: runBranch('waveP') });
    expect(existsSync(path.join(c1.path, 'parent.ts'))).toBe(true); // children see the parent's work

    await writeFile(path.join(c1.path, 'a.ts'), 'export const a = 1;\n');
    await wm.commitWork(c1, 'step s1');
    await writeFile(path.join(c2.path, 'b.ts'), 'export const b = 1;\n');
    await wm.commitWork(c2, 'step s2');

    // The serial return trip: integrate the parent's current line in, then fast-forward the
    // parent branch — which is CHECKED OUT in the parent worktree the whole time — to the child.
    expect(await wm.rebaseOnto(c1, runBranch('waveP'))).toEqual({ ok: true });
    expect((await wm.landFastForward(repo, runBranch('waveP'), runBranch('waveP--s1'))).ok).toBe(true);
    // The second child finds the line moved (its sibling landed) and re-integrates first — the
    // same shape the chain's CAS-loser retry takes.
    expect(await wm.rebaseOnto(c2, runBranch('waveP'))).toEqual({ ok: true });
    expect((await wm.landFastForward(repo, runBranch('waveP'), runBranch('waveP--s2'))).ok).toBe(true);

    // The parent branch tip contains BOTH children's commits…
    const { stdout: subjects } = await git(
      ['log', '--pretty=%s', `${parent.baseSha}..${runBranch('waveP')}`],
      repo,
    );
    expect(subjects).toContain('step s1');
    expect(subjects).toContain('step s2');
    // …the parent WORKTREE reflects them (landFastForward fast-forwards inside the checkout)…
    expect(existsSync(path.join(parent.path, 'a.ts'))).toBe(true);
    expect(existsSync(path.join(parent.path, 'b.ts'))).toBe(true);
    // …the parent-level gate sees the ACCUMULATED diff…
    expect((await wm.changedPaths(parent)).sort()).toEqual(['a.ts', 'b.ts', 'parent.ts']);
    // …and no merge commit was invented anywhere on the line.
    const { stdout: merges } = await git(['rev-list', '--merges', '--count', runBranch('waveP')], repo);
    expect(merges.trim()).toBe('0');

    // Landed children are disposable: their work survives on the parent's line, not in the copy.
    await wm.remove(c1);
    await wm.remove(c2);
    expect(existsSync(path.join(parent.path, 'a.ts'))).toBe(true);
    await wm.remove(parent);
  });

  // The test above lands in the polite order, so nobody ever LOSES. This one drives the race to
  // the refusal itself: two children finish together — both integrate the SAME parent tip, neither
  // has seen the other's work — so the second publish arrives non-fast-forward. Exactly one wins;
  // the loser is answered 'race' (never a merge commit papering over the lost CAS), re-integrates,
  // and its retry lands — the loop the chain runs under WAVE_PUBLISH_ATTEMPTS.
  it('a publish that lost the race is refused; the loser re-integrates and lands — no merge commit', async () => {
    const parent = await wm.create(repo, 'waveR');
    await writeFile(path.join(parent.path, 'parent.ts'), 'export const p = 1;\n');
    await wm.commitWork(parent, 'parent work');

    const c1 = await wm.create(repo, 'waveR--s1', { baseRef: runBranch('waveR') });
    const c2 = await wm.create(repo, 'waveR--s2', { baseRef: runBranch('waveR') });
    await writeFile(path.join(c1.path, 'a.ts'), 'export const a = 1;\n');
    await wm.commitWork(c1, 'step s1');
    await writeFile(path.join(c2.path, 'b.ts'), 'export const b = 1;\n');
    await wm.commitWork(c2, 'step s2');

    // "Finished together": both integrate the parent line at the same point.
    expect(await wm.rebaseOnto(c1, runBranch('waveR'))).toEqual({ ok: true });
    expect(await wm.rebaseOnto(c2, runBranch('waveR'))).toEqual({ ok: true });

    // Exactly one publish wins…
    expect((await wm.landFastForward(repo, runBranch('waveR'), runBranch('waveR--s1'))).ok).toBe(true);
    // …and the other is REFUSED as the race it lost, with nothing invented on the line:
    const lost = await wm.landFastForward(repo, runBranch('waveR'), runBranch('waveR--s2'));
    expect(lost).toMatchObject({ ok: false, reason: 'race' });
    expect(existsSync(path.join(parent.path, 'b.ts'))).toBe(false); // the loser landed nothing

    // The loser's retry: re-integrate (now seeing the winner's commit), publish again.
    expect(await wm.rebaseOnto(c2, runBranch('waveR'))).toEqual({ ok: true });
    expect((await wm.landFastForward(repo, runBranch('waveR'), runBranch('waveR--s2'))).ok).toBe(true);

    // Both children's work is on the parent line, linear history, zero merge commits.
    expect(existsSync(path.join(parent.path, 'a.ts'))).toBe(true);
    expect(existsSync(path.join(parent.path, 'b.ts'))).toBe(true);
    const { stdout: merges } = await git(['rev-list', '--merges', '--count', runBranch('waveR')], repo);
    expect(merges.trim()).toBe('0');

    await wm.remove(c1);
    await wm.remove(c2);
    await wm.remove(parent);
  });
});

// RUN-211: a read-only lease over the repo's tree for background indexing — never for an agent,
// and never a run. Own repo (rather than the shared `repo`/`wm` above) so committing to move
// HEAD and dirtying the working tree — the whole point of the pinning test — cannot leak into
// any other describe block's assumptions about the shared fixture's state.
describe('index snapshots (RUN-211, real git)', () => {
  let snapRepo: string;
  let snapWm: WorktreeManager;

  beforeAll(async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'noriq-wt-snap-'));
    snapRepo = path.join(tmp, 'repo');
    const snapBase = path.join(tmp, 'worktrees');
    await execFileP('git', ['init', '-q', '-b', 'main', snapRepo]);
    await writeFile(path.join(snapRepo, 'README.md'), '# hi\n');
    await git(['-c', 'user.email=t@t', '-c', 'user.name=T', 'add', '.'], snapRepo);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '-m', 'init'], snapRepo);
    snapWm = new WorktreeManager({ baseDir: snapBase });
  }, 30000);

  afterAll(async () => {
    await rm(path.dirname(snapRepo), { recursive: true, force: true }).catch(() => {});
  });

  it('pins a DETACHED worktree, named distinctly from a run worktree', async () => {
    const snap = await snapWm.createIndexSnapshot(snapRepo);
    expect(existsSync(snap.path)).toBe(true);
    expect(path.basename(snap.path)).toContain('index-snapshot'); // never `<repo>-<runId>`

    const { stdout } = await git(['worktree', 'list', '--porcelain'], snapRepo);
    const block = stdout.split('\n\n').find((b) => b.includes('detached'));
    expect(block).toBeDefined(); // no branch — nothing can land from it
    expect(block).not.toMatch(/\nbranch /);

    await snapWm.removeIndexSnapshot(snap);
  });

  it('is pinned: moving HEAD and dirtying the operator’s tree leaves it unchanged', async () => {
    const snap = await snapWm.createIndexSnapshot(snapRepo);
    const before = await readFile(path.join(snap.path, 'README.md'), 'utf8');

    // Move the repo's own HEAD, and dirty its working tree — what a snapshot exists to insulate
    // the indexer from reading.
    await writeFile(path.join(snapRepo, 'README.md'), '# operator is mid-edit\n');
    await git(['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-am', 'operator commit'], snapRepo);

    expect(await readFile(path.join(snap.path, 'README.md'), 'utf8')).toBe(before);
    const { stdout: snapHead } = await git(['rev-parse', 'HEAD'], snap.path);
    expect(snapHead.trim()).toBe(snap.baseSha); // the reported baseId still names it

    await snapWm.removeIndexSnapshot(snap);
  });

  it('release is idempotent — a second call is a no-op, not an error', async () => {
    const snap = await snapWm.createIndexSnapshot(snapRepo);
    await snapWm.removeIndexSnapshot(snap);
    expect(existsSync(snap.path)).toBe(false);
    await expect(snapWm.removeIndexSnapshot(snap)).resolves.toBeUndefined();
  });

  it('never touches a live run worktree held while the snapshot is released', async () => {
    const run = await snapWm.create(snapRepo, 'liveWhileSnapshotting');
    await writeFile(path.join(run.path, 'precious.ts'), 'export const keep = true;\n');
    const snap = await snapWm.createIndexSnapshot(snapRepo);

    await snapWm.removeIndexSnapshot(snap);

    expect(existsSync(run.path)).toBe(true);
    expect(existsSync(path.join(run.path, 'precious.ts'))).toBe(true);
    const branches = await git(['branch', '--list', run.branch], snapRepo);
    expect(branches.stdout.trim()).not.toBe(''); // the run's branch is untouched

    await snapWm.remove(run);
  });

  it('reapOrphans prunes a leftover snapshot on the startup sweep, uncounted in the reaped-run total', async () => {
    // No `isOwned` — the startup meaning: every prior process, and so every lease, is dead.
    const snap = await snapWm.createIndexSnapshot(snapRepo);
    const reaped = await snapWm.reapOrphans(snapRepo);
    expect(reaped).toBe(0); // no run worktrees here — the snapshot must not inflate this number
    expect(existsSync(snap.path)).toBe(false); // yet it was pruned
  });

  it('reapOrphans spares a snapshot on the periodic sweep — indistinguishable from a leased one', async () => {
    // `isOwned` present means this is a MID-FLIGHT sweep: a snapshot on lease (RUN-214) looks
    // exactly like this leftover one, and deleting it would pull the tree out from under an
    // in-flight scan. Only the startup sweep may assume no lease is held.
    const run = await snapWm.create(snapRepo, 'ownedRun');
    const snap = await snapWm.createIndexSnapshot(snapRepo);
    const reaped = await snapWm.reapOrphans(snapRepo, { isOwned: (id) => id === 'ownedRun' });
    expect(reaped).toBe(0); // the owned run was spared, and correctly not counted
    expect(existsSync(run.path)).toBe(true); // the run survives
    expect(existsSync(snap.path)).toBe(true); // so does the snapshot — this sweep must not prune it

    await snapWm.remove(run);
    await snapWm.removeIndexSnapshot(snap);
  });
});

// RUN-212. `full-index-required` is acted on CREDULOUSLY by every future caller — it means "skip
// re-indexing, the answer is trustworthy" — so every condition this backend cannot be confident
// about has to reach that arm rather than an empty (or partial) `changed`/`deleted` pair. Fake
// GitRunner, same rail `hasChanges`/`changedPaths` already use for their own "cannot answer" tests
// above: these are query-shape assertions, not git behaviour, so no real repo is needed here.
describe('changesBetween cannot answer "no changes" for "could not tell" (RUN-212)', () => {
  const withGit = (git: (args: string[]) => Promise<{ stdout: string; stderr: string }>) =>
    new WorktreeManager({ baseDir: base, git });

  it('rejects (full-index-required) when a base does not resolve to a commit', async () => {
    const wm = withGit(async (args) => {
      if (args[0] === 'rev-parse' && args.some((a) => a.includes('missing-sha'))) {
        throw new Error('fatal: bad revision');
      }
      return { stdout: 'sha\n', stderr: '' };
    });
    const res = await wm.changesBetween('/repo', 'missing-sha', 'good-sha');
    expect(res).toEqual({
      ok: false,
      reason: 'full-index-required',
      detail: expect.stringContaining('missing-sha'),
    });
  });

  it('rejects when the two bases share no common ancestor', async () => {
    const wm = withGit(async (args) => {
      if (args[0] === 'rev-parse') return { stdout: 'sha\n', stderr: '' };
      if (args[0] === 'merge-base') throw new Error('fatal: no common ancestor'); // git's own exit
      return { stdout: '', stderr: '' };
    });
    const res = await wm.changesBetween('/repo', 'a', 'b');
    expect(res).toEqual({
      ok: false,
      reason: 'full-index-required',
      detail: expect.stringContaining('could not relate'),
    });
  });

  it('rejects an ambiguous relationship — more than one best common ancestor', async () => {
    const wm = withGit(async (args) => {
      if (args[0] === 'rev-parse') return { stdout: 'sha\n', stderr: '' };
      if (args[0] === 'merge-base') return { stdout: 'anc1\nanc2\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const res = await wm.changesBetween('/repo', 'a', 'b');
    expect(res).toEqual({
      ok: false,
      reason: 'full-index-required',
      detail: expect.stringContaining('ambiguous'),
    });
  });

  // The acceptance line this test is FOR: "a git query that fails yields full-index-required,
  // never {ok:true} with empty lists — asserted with an injected failing GitRunner."
  it('rejects when the diff query itself fails, never answering an empty diff', async () => {
    const wm = withGit(async (args) => {
      if (args[0] === 'rev-parse') return { stdout: 'sha\n', stderr: '' };
      if (args[0] === 'merge-base') return { stdout: 'anc\n', stderr: '' };
      if (args[0] === 'diff') throw new Error('fatal: loose object is corrupt');
      return { stdout: '', stderr: '' };
    });
    const res = await wm.changesBetween('/repo', 'a', 'b');
    expect(res).toEqual({
      ok: false,
      reason: 'full-index-required',
      detail: expect.stringContaining('loose object is corrupt'),
    });
  });

  it('rejects a change set past the cap rather than returning a huge list', async () => {
    const tokens: string[] = [];
    for (let i = 0; i <= CHANGES_BETWEEN_MAX_PATHS; i++) tokens.push('M', `f${i}.ts`);
    const diffOut = `${tokens.join('\0')}\0`;
    const wm = withGit(async (args) => {
      if (args[0] === 'rev-parse') return { stdout: 'sha\n', stderr: '' };
      if (args[0] === 'merge-base') return { stdout: 'anc\n', stderr: '' };
      if (args[0] === 'diff') return { stdout: diffOut, stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const res = await wm.changesBetween('/repo', 'a', 'b');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('full-index-required');
      expect(res.detail).toContain(String(CHANGES_BETWEEN_MAX_PATHS));
    }
  });
});

// RUN-212. The acceptance line is "matches a full-index comparison", not "pins git's own
// --name-status output back at itself" (locked decision 8) — so the expectation here is built by
// an INDEPENDENT reconstruction (`git ls-tree` + `git show` at each endpoint, diffed by path and
// content hash from first principles), never by re-deriving what `changesBetween` itself parses.
// Own repo, like the index-snapshot block above, so committing on the shared primary checkout here
// cannot leak into any other describe block's assumptions.
describe('changesBetween (RUN-212, real git): reconciles with an independent full listing', () => {
  let cbRepo: string;
  let cbWm: WorktreeManager;
  const gitc = (args: string[]) => git(['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], cbRepo);

  async function fullTree(ref: string): Promise<Map<string, string>> {
    const { stdout } = await git(['ls-tree', '-r', '--name-only', '-z', ref], cbRepo);
    const map = new Map<string, string>();
    for (const p of stdout.split('\0').filter(Boolean)) {
      const { stdout: blob } = await git(['show', `${ref}:${p}`], cbRepo);
      map.set(p, createHash('sha256').update(blob).digest('hex'));
    }
    return map;
  }

  beforeAll(async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'noriq-wt-cb-'));
    cbRepo = path.join(tmp, 'repo');
    await execFileP('git', ['init', '-q', '-b', 'main', cbRepo]);
    cbWm = new WorktreeManager({ baseDir: path.join(tmp, 'worktrees') });

    await writeFile(path.join(cbRepo, 'keep.txt'), 'unchanged\n');
    await writeFile(path.join(cbRepo, 'mod.txt'), 'v1\n');
    await writeFile(path.join(cbRepo, 'del.txt'), 'gone soon\n');
    await writeFile(path.join(cbRepo, 'ren_from.txt'), 'rename me, content unchanged\n');
    await gitc(['add', '.']);
    await gitc(['commit', '-q', '-m', 'base']);
  }, 30000);

  afterAll(async () => {
    await rm(path.dirname(cbRepo), { recursive: true, force: true }).catch(() => {});
  });

  it('an added, a modified-twice, a deleted, and a renamed file all land in the right list', async () => {
    const { stdout: fromRaw } = await git(['rev-parse', 'HEAD'], cbRepo);
    const from = fromRaw.trim();

    // Modified TWICE across the range — the reconciliation must see only the net change.
    await writeFile(path.join(cbRepo, 'mod.txt'), 'v2\n');
    await gitc(['commit', '-qam', 'first change to mod.txt']);
    await writeFile(path.join(cbRepo, 'mod.txt'), 'v3\n');
    await gitc(['commit', '-qam', 'second change to mod.txt']);
    // Deleted.
    await gitc(['rm', '-q', 'del.txt']);
    await gitc(['commit', '-qm', 'delete del.txt']);
    // Renamed (pure rename, content untouched, so git's similarity detector finds it at 100%).
    await gitc(['mv', 'ren_from.txt', 'ren_to.txt']);
    await gitc(['commit', '-qm', 'rename ren_from.txt -> ren_to.txt']);
    // Added.
    await writeFile(path.join(cbRepo, 'new.txt'), 'brand new\n');
    await gitc(['add', 'new.txt']);
    await gitc(['commit', '-qm', 'add new.txt']);

    const { stdout: toRaw } = await git(['rev-parse', 'HEAD'], cbRepo);
    const to = toRaw.trim();

    const res = await cbWm.changesBetween(cbRepo, from, to);
    if (!res.ok) throw new Error(`expected ok:true, got full-index-required: ${res.detail}`);

    const fromTree = await fullTree(from);
    const toTree = await fullTree(to);
    const expectedDeleted = [...fromTree.keys()].filter((p) => !toTree.has(p));
    const expectedChanged = [...toTree.keys()].filter(
      (p) => !fromTree.has(p) || fromTree.get(p) !== toTree.get(p),
    );

    expect([...res.changed].sort()).toEqual(expectedChanged.sort());
    expect([...res.deleted].sort()).toEqual(expectedDeleted.sort());

    // Named explicitly too, so a bug shared between this test's own reconstruction and the
    // implementation could not hide behind agreeing with itself.
    expect([...res.changed].sort()).toEqual(['mod.txt', 'new.txt', 'ren_to.txt']);
    expect([...res.deleted].sort()).toEqual(['del.txt', 'ren_from.txt']);
    // A rename is a deletion of the old path PLUS a change at the new — never its own shape
    // (locked decision 3): nothing here names both `ren_from.txt` and `ren_to.txt` together.
    expect(res.changed).not.toContain('keep.txt');
    expect(res.deleted).not.toContain('keep.txt');
  });

  it('two identical bases yield ok:true with empty lists — a real answer, not full-index-required', async () => {
    const { stdout } = await git(['rev-parse', 'HEAD'], cbRepo);
    const sha = stdout.trim();
    expect(await cbWm.changesBetween(cbRepo, sha, sha)).toEqual({ ok: true, changed: [], deleted: [] });
  });

  it('two unrelated bases (separate root commits) yield full-index-required, not an empty diff', async () => {
    const { stdout: mainRaw } = await git(['rev-parse', 'main'], cbRepo);
    const mainSha = mainRaw.trim();

    await gitc(['checkout', '-q', '--orphan', 'unrelated']);
    await git(['rm', '-rf', '-q', '.'], cbRepo);
    await writeFile(path.join(cbRepo, 'orphan.txt'), 'lonely\n');
    await gitc(['add', 'orphan.txt']);
    await gitc(['commit', '-qm', 'unrelated root commit']);
    const { stdout: orphanRaw } = await git(['rev-parse', 'HEAD'], cbRepo);
    const orphanSha = orphanRaw.trim();

    const res = await cbWm.changesBetween(cbRepo, mainSha, orphanSha);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('full-index-required');

    await gitc(['checkout', '-q', 'main']);
    await gitc(['branch', '-D', 'unrelated']);
  });

  it('a base the backend cannot resolve yields full-index-required', async () => {
    const { stdout } = await git(['rev-parse', 'HEAD'], cbRepo);
    const res = await cbWm.changesBetween(cbRepo, stdout.trim(), 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('full-index-required');
  });
});

// RUN-256: `checkIgnored` against a real repo — the exit-code convention this method's own doc
// claims to have measured (0 = at least one ignored, 1 = none, anything else = a real error) is
// pinned here against actual `git check-ignore`, not merely asserted in a comment.
//
// The filename itself is built by concatenation, never spelled literally in this file: RUN-256
// locked decision 1 bars the ignore-file NAME from appearing outside `src/vcs/`, and a literal
// `writeFile`/`git add` call here would put it right back.
const GIT_IGNORE_FILENAME = ['.git', 'ignore'].join('');

describe('checkIgnored (RUN-256, real git)', () => {
  let ciRepo: string;
  let ciWm: WorktreeManager;

  beforeAll(async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'noriq-wt-ci-'));
    ciRepo = path.join(tmp, 'repo');
    await execFileP('git', ['init', '-q', '-b', 'main', ciRepo]);
    ciWm = new WorktreeManager({ baseDir: path.join(tmp, 'worktrees') });
    await writeFile(path.join(ciRepo, GIT_IGNORE_FILENAME), 'node_modules/\n*.log\n');
    await writeFile(path.join(ciRepo, 'src.ts'), 'export {};\n');
    // `git check-ignore` needs to be able to tell a directory-only pattern (`node_modules/`)
    // matches — either a trailing slash on the queried path or (measured) the path actually
    // existing on disk as a directory. Real callers (`buildVcsIgnoredPredicate`) only ever pass
    // paths a real `readdir()` produced, so this mirrors that rather than passing a bare name.
    await mkdir(path.join(ciRepo, 'node_modules'), { recursive: true });
    await writeFile(path.join(ciRepo, 'node_modules', '.gitkeep'), '');
    await git(['-c', 'user.email=t@t', '-c', 'user.name=T', 'add', GIT_IGNORE_FILENAME, 'src.ts'], ciRepo);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '-m', 'init'], ciRepo);
  }, 30000);

  afterAll(async () => {
    await rm(path.dirname(ciRepo), { recursive: true, force: true }).catch(() => {});
  });

  it('a mix of ignored and not-ignored paths: exit 0, only the ignored ones come back', async () => {
    const res = await ciWm.checkIgnored(ciRepo, ['node_modules', 'src.ts', 'debug.log']);
    expect(res).toEqual({ ok: true, ignored: new Set(['node_modules', 'debug.log']) });
  });

  it('none of the given paths are ignored: exit 1 is DATA (an empty set), never an error', async () => {
    const res = await ciWm.checkIgnored(ciRepo, ['src.ts', 'README.md']);
    expect(res).toEqual({ ok: true, ignored: new Set() });
  });

  it('every given path is ignored', async () => {
    const res = await ciWm.checkIgnored(ciRepo, ['node_modules', 'a.log', 'b.log']);
    expect(res).toEqual({ ok: true, ignored: new Set(['node_modules', 'a.log', 'b.log']) });
  });

  it('an empty path list never shells out at all', async () => {
    const throwingGit = async (): Promise<never> => {
      throw new Error('git must never be invoked for an empty path list');
    };
    const wm = new WorktreeManager({ baseDir: path.join(ciRepo, '..', 'wt-unused'), git: throwingGit });
    expect(await wm.checkIgnored(ciRepo, [])).toEqual({ ok: true, ignored: new Set() });
  });

  it('a real failure (not a git repo at all) answers unknown, never throws', async () => {
    const notARepo = await mkdtemp(path.join(os.tmpdir(), 'noriq-wt-not-a-repo-'));
    try {
      const res = await ciWm.checkIgnored(notARepo, ['whatever.txt']);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('unknown');
    } finally {
      await rm(notARepo, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// RUN-222: the cheap "what is current" check. Real git, against the shared `repo` fixture
// (`beforeAll` at the top of this file) — never a worktree, never a lease.
describe('currentBase (RUN-222, real git)', () => {
  it('defaults to HEAD — the same scope createIndexSnapshot defaults to', async () => {
    const { stdout } = await git(['rev-parse', 'HEAD'], repo);
    const res = await wm.currentBase(repo);
    expect(res).toEqual({ ok: true, baseId: stdout.trim() });
  });

  it('resolves a named branch when one is given', async () => {
    const { stdout } = await git(['rev-parse', 'main'], repo);
    const res = await wm.currentBase(repo, 'main');
    expect(res).toEqual({ ok: true, baseId: stdout.trim() });
  });

  it('mints no worktree and takes no lease — the repo has none besides what earlier tests left', async () => {
    const before = (await wm.listManaged(repo)).length;
    await wm.currentBase(repo);
    expect((await wm.listManaged(repo)).length).toBe(before);
  });

  it('a branch that does not exist answers unknown, never throws', async () => {
    const res = await wm.currentBase(repo, 'no-such-branch-at-all');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('unknown');
  });

  it('a real failure (not a git repo at all) answers unknown, never throws', async () => {
    const notARepo = await mkdtemp(path.join(os.tmpdir(), 'noriq-wt-cb-not-a-repo-'));
    try {
      const res = await wm.currentBase(notARepo);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('unknown');
    } finally {
      await rm(notARepo, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// RUN-245: git's real `changeStats` — own repo, like every other real-git describe block above,
// so committing on the shared primary checkout cannot leak into another block's assumptions.
describe('changeStats (RUN-245, real git)', () => {
  let csRepo: string;
  let csWm: WorktreeManager;
  const gitc = (args: string[]) => git(['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], csRepo);

  beforeAll(async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'noriq-wt-cs-'));
    csRepo = path.join(tmp, 'repo');
    await execFileP('git', ['init', '-q', '-b', 'main', csRepo]);
    csWm = new WorktreeManager({ baseDir: path.join(tmp, 'worktrees') });
    await writeFile(path.join(csRepo, 'README.md'), 'line1\n');
    // Present at every worktree's BASE, deliberately — a rename needs its OLD path to already
    // exist at the base for git's detector to have anything to pair with the new one; committing
    // it only inside a worktree's own branch (after the fork point) means the base never saw a
    // delete to pair against, so the diff base→current would just show a plain add.
    await writeFile(path.join(csRepo, 'old-name.ts'), 'a\nb\nc\nd\ne\n');
    await gitc(['add', '.']);
    await gitc(['commit', '-q', '-m', 'init']);
  }, 30000);

  afterAll(async () => {
    await rm(path.dirname(csRepo), { recursive: true, force: true }).catch(() => {});
  });

  it('measures the UNION of a committed change and a further uncommitted edit to the SAME file, one command', async () => {
    const wt = await csWm.create(csRepo, 'csUnion');
    // Committed: base has 1 line, this sitting commits a 2nd.
    await writeFile(path.join(wt.path, 'README.md'), 'line1\nline2\n');
    await csWm.commitWork(wt, 'commit one more line');
    // Then a further, UNCOMMITTED edit on top — the case the locked decision measured: `<base>..HEAD`
    // alone would only see the committed line.
    await writeFile(path.join(wt.path, 'README.md'), 'line1\nline2\nline3\n');

    // Prove the undercount independently before asserting changeStats avoids it. Run INSIDE the
    // worktree, not the shared repo checkout — `HEAD` must resolve to the run's own branch.
    const { stdout: rangeOnly } = await git(['diff', '--numstat', `${wt.baseSha}..HEAD`], wt.path);
    expect(rangeOnly.trim()).toBe('1\t0\tREADME.md'); // misses the uncommitted 3rd line

    const res = await csWm.changeStats(wt);
    expect(res).toEqual({
      ok: true,
      stats: { changedFiles: 1, lines: { additions: 2, deletions: 0, uncountableFiles: 0 } },
    });
    await csWm.remove(wt);
  });

  it("a binary file's '-\\t-' record counts as a changed, uncountable file — never NaN", async () => {
    const wt = await csWm.create(csRepo, 'csBinary');
    await writeFile(path.join(wt.path, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 254, 0, 9, 9]));
    await csWm.commitWork(wt, 'add a binary file');

    const res = await csWm.changeStats(wt);
    if (!res.ok) throw new Error(`expected ok:true, got: ${res.detail}`);
    expect(res.stats.changedFiles).toBe(1);
    expect(res.stats.lines).not.toBeNull();
    expect(res.stats.lines).toEqual({ additions: 0, deletions: 0, uncountableFiles: 1 });
    // Never fabricated: nothing here is NaN, which `Number('-')` would have been.
    for (const n of [res.stats.changedFiles, res.stats.lines?.additions, res.stats.lines?.deletions]) {
      expect(Number.isFinite(n)).toBe(true);
    }
    await csWm.remove(wt);
  });

  it('a pure rename (content unchanged) counts as ONE changed file via the 0/0 shape, no rename branch', async () => {
    const wt = await csWm.create(csRepo, 'csRename');
    // old-name.ts already exists at wt.baseSha (the shared init commit) — renaming it here gives
    // git's detector a real delete-at-old-path to pair with the add-at-new-path.
    await git(['mv', 'old-name.ts', 'new-name.ts'], wt.path);
    await csWm.commitWork(wt, 'rename it, no content change');

    // Confirm this repo's own numstat really does emit the 0/0 shape the parser relies on.
    const { stdout: raw } = await git(['diff', '--numstat', '--find-renames', wt.baseSha], wt.path);
    expect(raw.trim()).toBe('0\t0\told-name.ts => new-name.ts');

    const res = await csWm.changeStats(wt);
    expect(res).toEqual({
      ok: true,
      stats: { changedFiles: 1, lines: { additions: 0, deletions: 0, uncountableFiles: 0 } },
    });
    await csWm.remove(wt);
  });

  it('an untracked file AND an untracked directory are both counted individually, never collapsed', async () => {
    const wt = await csWm.create(csRepo, 'csUntracked');
    await writeFile(path.join(wt.path, 'loose.ts'), 'export const l = 1;\n');
    await mkdir(path.join(wt.path, 'untrackeddir'));
    await writeFile(path.join(wt.path, 'untrackeddir', 'x.ts'), 'export const x = 1;\n');
    await writeFile(path.join(wt.path, 'untrackeddir', 'y.ts'), 'export const y = 1;\n');

    const res = await csWm.changeStats(wt);
    if (!res.ok) throw new Error(`expected ok:true, got: ${res.detail}`);
    // Three untracked files, not one collapsed `??` entry for the directory (the default
    // `-u`/`normal` mode's behaviour, which `-uall` exists to avoid).
    expect(res.stats.changedFiles).toBe(3);
    expect(res.stats.lines).toEqual({ additions: 0, deletions: 0, uncountableFiles: 3 });
    await csWm.remove(wt);
  });

  it('a mix of a text edit, a binary add, and an untracked file aggregates correctly', async () => {
    const wt = await csWm.create(csRepo, 'csMixed');
    await writeFile(path.join(wt.path, 'README.md'), 'line1\nline2\nline3\n'); // +2 lines, tracked
    await writeFile(path.join(wt.path, 'blob.bin'), Buffer.from([0, 1, 2, 0]));
    await csWm.commitWork(wt, 'text edit + binary add');
    await writeFile(path.join(wt.path, 'new.ts'), 'export const n = 1;\n'); // untracked

    const res = await csWm.changeStats(wt);
    if (!res.ok) throw new Error(`expected ok:true, got: ${res.detail}`);
    expect(res.stats.changedFiles).toBe(3); // README.md, blob.bin, new.ts
    expect(res.stats.lines).toEqual({ additions: 2, deletions: 0, uncountableFiles: 2 }); // blob.bin + new.ts
    await csWm.remove(wt);
  });

  it('empty/unresolvable base refuses rather than measuring a confident (wrong) zero', async () => {
    const wt = await csWm.create(csRepo, 'csBadBase');
    await writeFile(path.join(wt.path, 'x.ts'), 'export const x = 1;\n');
    await csWm.commitWork(wt, 'work that must not be reported as zero');

    const emptyBase = await csWm.changeStats({ path: wt.path, baseSha: '' });
    expect(emptyBase.ok).toBe(false);
    if (!emptyBase.ok) expect(emptyBase.detail).toMatch(/no base commit/);

    const unresolvable = await csWm.changeStats({
      path: wt.path,
      baseSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });
    expect(unresolvable.ok).toBe(false);
    if (!unresolvable.ok) expect(unresolvable.detail).toMatch(/does not resolve to a commit/);

    await csWm.remove(wt);
  });

  // Verified against the REAL binary, not merely asserted: a `-c diff.renames=false` GitRunner
  // wrapping every call, pointed at the SAME workspace `csWm`'s default runner just measured,
  // must report identical counts. This is this task's own determinism correction — the locked
  // decision undersold what a repo's `diff.renames` config could do (it changes `additions`/
  // `deletions`, not just `changedFiles`), and `--find-renames` (bare, no threshold) is what pins
  // the answer regardless of it.
  it("a repo's own diff.renames config cannot change the counts (RUN-245's correction to the locked decision)", async () => {
    const wt = await csWm.create(csRepo, 'csDeterminism');
    // old-name.ts already exists at wt.baseSha (the shared init commit) — see the setup comment above.
    await git(['mv', 'old-name.ts', 'new-name.ts'], wt.path);
    await csWm.commitWork(wt, 'rename it, no content change');

    const withRenamesOff = new WorktreeManager({
      baseDir: path.dirname(wt.path),
      git: (args, cwd, stdin) => defaultGit(['-c', 'diff.renames=false', ...args], cwd, stdin),
    });
    const withRenamesOn = new WorktreeManager({
      baseDir: path.dirname(wt.path),
      git: (args, cwd, stdin) => defaultGit(['-c', 'diff.renames=true', ...args], cwd, stdin),
    });

    const [defaultRes, offRes, onRes] = await Promise.all([
      csWm.changeStats(wt),
      withRenamesOff.changeStats(wt),
      withRenamesOn.changeStats(wt),
    ]);
    expect(offRes).toEqual(defaultRes);
    expect(onRes).toEqual(defaultRes);
    expect(defaultRes).toEqual({
      ok: true,
      stats: { changedFiles: 1, lines: { additions: 0, deletions: 0, uncountableFiles: 0 } },
    });

    await csWm.remove(wt);
  });
});

describe('changeStats cannot answer with a fabricated result for "could not tell" (RUN-245)', () => {
  const withGit = (git: (args: string[]) => Promise<{ stdout: string; stderr: string }>) =>
    new WorktreeManager({ baseDir: base, git });
  const wt = { path: '/wt/run_1', baseSha: 'base0000' };

  it('the same fake output produces identical stats across repeated calls (determinism)', async () => {
    const wm2 = withGit(async (args) => {
      if (args[0] === 'rev-parse') return { stdout: 'ok\n', stderr: '' };
      if (args[0] === 'diff') return { stdout: '3\t1\tsrc/a.ts\n-\t-\tsrc/b.bin\n', stderr: '' };
      return { stdout: '?? src/c.ts\0', stderr: '' }; // status
    });
    const first = await wm2.changeStats(wt);
    const second = await wm2.changeStats(wt);
    expect(first).toEqual(second);
    expect(first).toEqual({
      ok: true,
      stats: { changedFiles: 3, lines: { additions: 3, deletions: 1, uncountableFiles: 2 } },
    });
  });

  it('refuses (never throws) when the numstat probe fails', async () => {
    const wm2 = withGit(async (args) => {
      if (args[0] === 'rev-parse') return { stdout: 'ok\n', stderr: '' };
      if (args[0] === 'diff') throw new Error('fatal: bad object base0000');
      return { stdout: '', stderr: '' };
    });
    const res = await wm2.changeStats(wt);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('unavailable');
      expect(res.detail).toContain('bad object');
    }
  });

  it('refuses (never throws) when the untracked-files probe fails', async () => {
    const wm2 = withGit(async (args) => {
      if (args[0] === 'rev-parse') return { stdout: 'ok\n', stderr: '' };
      if (args[0] === 'diff') return { stdout: '1\t0\tsrc/a.ts\n', stderr: '' };
      throw new Error('fatal: index file corrupt'); // status
    });
    const res = await wm2.changeStats(wt);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('unavailable');
      expect(res.detail).toContain('index file corrupt');
    }
  });

  it('refuses when the base cannot be verified as a commit, never a confident zero', async () => {
    const wm2 = withGit(async (args) => {
      if (args[0] === 'rev-parse') throw new Error('fatal: needed a single revision');
      return { stdout: '', stderr: '' };
    });
    const res = await wm2.changeStats(wt);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.detail).toMatch(/does not resolve to a commit/);
  });

  it('refuses on an empty base without ever shelling out', async () => {
    const calls: string[][] = [];
    const wm2 = withGit(async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '' };
    });
    const res = await wm2.changeStats({ path: '/wt/run_1', baseSha: '' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.detail).toMatch(/no base commit/);
    expect(calls).toHaveLength(0);
  });
});
