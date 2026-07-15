import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorktreeManager, runBranch } from '../src/worktree';

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

  it('is a no-op when the agent already committed', async () => {
    const wt = await wm.create(repo, 'noopCommit');
    expect(await wm.commitWork(wt, 'nothing to save')).toBe(false);
    await wm.remove(wt);
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
