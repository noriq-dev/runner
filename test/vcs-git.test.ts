import { describe, expect, it } from 'vitest';
import { GitBackend, type GitOps } from '../src/vcs/git';
import type { Workspace } from '../src/vcs/types';
import type { WorktreeInfo } from '../src/worktree';

// GitBackend is a naming boundary, so its whole contract is the MAPPING: each outcome reaches
// the right git verb, with the arguments passed through untouched and the result returned
// verbatim. Nothing here exercises git itself — worktree.test.ts owns that behaviour, against
// real repos, and this seam must not duplicate (or drift from) it.
//
// Since RUN-50 the boundary also carries the TYPE split: WorktreeInfo (git's own shape, path +
// branch fused) stays behind the backend, and what comes out is a Workspace whose localPath is
// the only filesystem path and whose location is opaque. These tests pin the wrap/unwrap.

const info: WorktreeInfo = {
  runId: 'run_1',
  repoRoot: '/repo',
  path: '/wt/run_1',
  branch: 'noriq/run/run_1',
  readOnly: false,
  baseSha: 'base0000',
};

function recorder() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    <T>(method: string, result: T) =>
    async (...args: unknown[]): Promise<T> => {
      calls.push({ method, args });
      return result;
    };
  const ops: GitOps = {
    create: record('create', info),
    remove: record('remove', undefined),
    hasChanges: record('hasChanges', true),
    changedPaths: record('changedPaths', ['src/a.ts']),
    commitWork: record('commitWork', true),
    refExists: record('refExists', true),
    createBranch: record('createBranch', undefined),
    rebaseOnto: record('rebaseOnto', { ok: false, conflicts: ['a.ts'] } as const),
    continueRebase: record('continueRebase', { ok: true } as const),
    abortRebase: record('abortRebase', undefined),
    landFastForward: record('landFastForward', { ok: true, sha: 'sha1' } as const),
    pushBranch: record('pushBranch', { ok: false, detail: 'offline' } as const),
    reapOrphans: record('reapOrphans', 2),
  };
  return { ops, calls };
}

describe('GitBackend — the outcome→verb mapping', () => {
  it('kind says what it is, without any supervisor machinery (RUN-56 is a second consumer)', () => {
    const { ops } = recorder();
    expect(new GitBackend(ops).kind).toBe('git');
  });

  it('lease wraps WorktreeInfo into a Workspace: localPath is the path, location hides the rest', async () => {
    const { ops, calls } = recorder();
    const ws = await new GitBackend(ops).lease('/repo', 'run_1', { readOnly: true });
    expect(ws).toEqual({
      runId: 'run_1',
      localPath: '/wt/run_1',
      readOnly: false, // verbatim from what git reported, not from what was asked
      baseId: 'base0000',
      workRef: 'noriq/run/run_1',
      location: { repoRoot: '/repo', branch: 'noriq/run/run_1' },
    });
    expect(calls[0]).toEqual({
      method: 'create',
      args: ['/repo', 'run_1', { readOnly: true, baseRef: undefined }],
    });
  });

  it('lease({fromRunId}) becomes the OTHER run’s branch — the naming convention stays in here', async () => {
    const { ops, calls } = recorder();
    await new GitBackend(ops).lease('/repo', 'run_2', { fromRunId: 'run_1' });
    expect(calls[0]?.args[2]).toEqual({ readOnly: undefined, baseRef: 'noriq/run/run_1' });
  });

  it('lease({fromTarget}) forks from the landing branch directly (RUN-82)', async () => {
    const { ops, calls } = recorder();
    await new GitBackend(ops).lease('/repo', 'run_2', { fromTarget: 'noriq/plan-x' });
    expect(calls[0]?.args[2]).toEqual({ readOnly: undefined, baseRef: 'noriq/plan-x' });
  });

  it('fromRunId WINS over fromTarget — a verify run judges the build, not the plan branch (RUN-82)', async () => {
    const { ops, calls } = recorder();
    await new GitBackend(ops).lease('/repo', 'run_2', { fromRunId: 'run_1', fromTarget: 'noriq/plan-x' });
    expect(calls[0]?.args[2]).toEqual({ readOnly: undefined, baseRef: 'noriq/run/run_1' });
  });

  it('maps every workspace outcome to its verb, unwrapping location — results verbatim', async () => {
    const { ops, calls } = recorder();
    const vcs = new GitBackend(ops);
    const ws: Workspace = await vcs.lease('/repo', 'run_1');
    calls.length = 0;

    await vcs.dispose(ws);
    expect(await vcs.hasWork(ws)).toBe(true);
    expect(await vcs.checkpoint(ws, 'msg')).toBe(true);
    expect(await vcs.targetExists('/repo', 'noriq/integration')).toBe(true);
    await vcs.createTarget('/repo', 'noriq/integration', 'main');
    // The two shapes the interface exists to preserve: conflict PATHS, and compare-and-swap.
    expect(await vcs.integrate(ws, 'noriq/integration')).toEqual({ ok: false, conflicts: ['a.ts'] });
    expect(await vcs.resumeIntegrate(ws)).toEqual({ ok: true });
    await vcs.abandonIntegrate(ws);
    expect(await vcs.publish(ws, 'noriq/integration')).toEqual({ ok: true, sha: 'sha1' });
    expect(await vcs.share('/repo', 'noriq/integration')).toEqual({ ok: false, detail: 'offline' });
    expect(await vcs.reapOrphans('/repo')).toBe(2);

    expect(calls).toEqual([
      { method: 'remove', args: [{ repoRoot: '/repo', path: '/wt/run_1', branch: 'noriq/run/run_1' }] },
      { method: 'hasChanges', args: [{ path: '/wt/run_1', baseSha: 'base0000' }] },
      { method: 'commitWork', args: [{ path: '/wt/run_1' }, 'msg'] },
      { method: 'refExists', args: ['/repo', 'noriq/integration'] },
      { method: 'createBranch', args: ['/repo', 'noriq/integration', 'main'] },
      { method: 'rebaseOnto', args: [{ path: '/wt/run_1' }, 'noriq/integration'] },
      { method: 'continueRebase', args: [{ path: '/wt/run_1' }] },
      { method: 'abortRebase', args: [{ path: '/wt/run_1' }] },
      // publish takes the WORKSPACE; the branch it publishes from comes out of location,
      // never from a caller-supplied ref (RUN-50).
      { method: 'landFastForward', args: ['/repo', 'noriq/integration', 'noriq/run/run_1'] },
      { method: 'pushBranch', args: ['/repo', 'noriq/integration'] },
      { method: 'reapOrphans', args: ['/repo', undefined] },
    ]);
  });

  it('share forwards an explicit remote, and withholds the arg entirely when the caller did', async () => {
    const { ops, calls } = recorder();
    await new GitBackend(ops).share('/repo', 'b', 'upstream');
    expect(calls[0]).toEqual({ method: 'pushBranch', args: ['/repo', 'b', 'upstream'] });
  });

  it('refuses a workspace whose location it did not mint — by name, not with a git error', async () => {
    // The guard exists for the park file: a Workspace round-trips through JSON on disk
    // (RUN-30), where another backend's location or an old daemon's schema can produce
    // anything. It must fail HERE, legibly — not as git complaining about a branch called
    // "[object Object]".
    const { ops } = recorder();
    const vcs = new GitBackend(ops);
    const alien: Workspace = {
      runId: 'run_9',
      localPath: '/wt/run_9',
      readOnly: false,
      baseId: 'x',
      workRef: 'client-9',
      location: { client: 'ws9', change: 42 }, // a Perforce-shaped location
    };
    await expect(vcs.publish(alien, 'main')).rejects.toThrow(/does not carry a git location/);
    await expect(vcs.dispose(alien)).rejects.toThrow(/run_9/);
  });
});

// Git has no native lock (RUN-98): the backend's lock ops are pure delegation to the injected
// Noriq lock client, held as the RUN's token. Absent client → graceful no-op.
describe('GitBackend — lock delegation (RUN-98)', () => {
  const ws: Workspace = {
    runId: 'run_1',
    localPath: '/wt/run_1',
    readOnly: false,
    baseId: 'b',
    workRef: 'noriq/run/run_1',
    location: { repoRoot: '/repo', branch: 'noriq/run/run_1' },
  };
  const ctx = { projectId: 'prj_x', token: 'run-token', branch: 'main', taskId: 'task_9' };

  function lockRecorder(acquireResult: unknown) {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const locks = {
      acquire: async (...args: unknown[]) => {
        calls.push({ method: 'acquire', args });
        return acquireResult as never;
      },
      release: async (...args: unknown[]) => {
        calls.push({ method: 'release', args });
        return { released: [] };
      },
      check: async (...args: unknown[]) => {
        calls.push({ method: 'check', args });
        return { enabled: true, conflicts: [], mine: [] };
      },
    };
    return { locks, calls };
  }

  it('lock delegates to acquire with the run token + scope branch + task, and passes a grant through', async () => {
    const { ops } = recorder();
    const { locks, calls } = lockRecorder({ ok: true, enabled: true, locks: [{ id: 'lk_1', path: 'a.ts' }] });
    const out = await new GitBackend(ops, locks).lock(ws, ['a.ts'], ctx);
    expect(out).toEqual({ ok: true, enabled: true, locks: [{ id: 'lk_1', path: 'a.ts' }] });
    expect(calls[0]).toEqual({
      method: 'acquire',
      args: ['run-token', { projectId: 'prj_x', paths: ['a.ts'], branch: 'main', taskId: 'task_9' }],
    });
  });

  it('lock surfaces a conflict verbatim (all-or-nothing)', async () => {
    const { ops } = recorder();
    const conflict = { ok: false, conflicts: [{ path: 'a.ts', holder: 'agt_other', holderName: 'peer' }] };
    const { locks } = lockRecorder(conflict);
    expect(await new GitBackend(ops, locks).lock(ws, ['a.ts'], ctx)).toEqual(conflict);
  });

  it('lock/queryLocks are no-ops with no client wired — a daemon without a lock layer is unchanged', async () => {
    const { ops } = recorder();
    const vcs = new GitBackend(ops); // no lock delegate
    expect(await vcs.lock(ws, ['a.ts'], ctx)).toEqual({ ok: true, enabled: false, locks: [] });
    expect(await vcs.queryLocks('/repo', ['a.ts'], ctx)).toEqual({ enabled: false, conflicts: [], mine: [] });
  });

  it('empty path list never calls the server (nothing to lock)', async () => {
    const { ops } = recorder();
    const { locks, calls } = lockRecorder({ ok: true, enabled: true, locks: [] });
    await new GitBackend(ops, locks).lock(ws, [], ctx);
    expect(calls).toHaveLength(0);
  });

  it('unlock delegates release by ids; queryLocks delegates check with the scope branch', async () => {
    const { ops } = recorder();
    const { locks, calls } = lockRecorder({ ok: true, enabled: true, locks: [] });
    const vcs = new GitBackend(ops, locks);
    await vcs.unlock(ws, { lockIds: ['lk_1'] }, ctx);
    await vcs.queryLocks('/repo', ['a.ts'], ctx);
    expect(calls.find((c) => c.method === 'release')?.args).toEqual([
      'run-token',
      'prj_x',
      { lockIds: ['lk_1'] },
    ]);
    expect(calls.find((c) => c.method === 'check')?.args).toEqual([
      'run-token',
      { projectId: 'prj_x', paths: ['a.ts'], branch: 'main' },
    ]);
  });
});
