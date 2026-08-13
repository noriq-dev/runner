import { describe, expect, it } from 'vitest';
import { FakeIndexSource, FilesystemIndexSource } from '../src/index-source';
import { GitBackend, type GitOps } from '../src/vcs/git';
import type { IndexSnapshot, Workspace } from '../src/vcs/types';
import type { IndexSnapshotHandle, WorktreeInfo } from '../src/worktree';

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

const snapshotHandle: IndexSnapshotHandle = {
  repoRoot: '/repo',
  path: '/wt/repo-index-snapshot-abc',
  baseSha: 'snap0000',
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
    removePreservingBranch: record('removePreservingBranch', undefined),
    hasChanges: record('hasChanges', true),
    changedPaths: record('changedPaths', ['src/a.ts']),
    commitWork: record('commitWork', true),
    inspectExact: record('inspectExact', { revisionId: 'a'.repeat(40), clean: true }),
    checkpointExact: record('checkpointExact', {
      beforeRevisionId: 'a'.repeat(40),
      revisionId: 'b'.repeat(40),
      changed: true,
      clean: true,
    } as const),
    reconcileExact: record('reconcileExact', {
      revisionId: 'a'.repeat(40),
      clean: true,
      disposition: 'restored',
    } as const),
    restoreExact: record('restoreExact', {
      revisionId: 'a'.repeat(40),
      clean: true,
      changed: false,
    } as const),
    refExists: record('refExists', true),
    createBranch: record('createBranch', undefined),
    rebaseOnto: record('rebaseOnto', { ok: false, conflicts: ['a.ts'] } as const),
    continueRebase: record('continueRebase', { ok: true } as const),
    abortRebase: record('abortRebase', undefined),
    landFastForward: record('landFastForward', { ok: true, sha: 'sha1' } as const),
    pushBranch: record('pushBranch', { ok: false, detail: 'offline' } as const),
    reapOrphans: record('reapOrphans', 2),
    createIndexSnapshot: record('createIndexSnapshot', snapshotHandle),
    removeIndexSnapshot: record('removeIndexSnapshot', undefined),
    changesBetween: record('changesBetween', { ok: true, changed: ['src/a.ts'], deleted: ['src/old.ts'] }),
    checkIgnored: record('checkIgnored', { ok: true, ignored: new Set(['node_modules']) } as const),
    currentBase: record('currentBase', { ok: true, baseId: 'cur0000' } as const),
    changeStats: record('changeStats', {
      ok: true,
      stats: { changedFiles: 2, lines: { additions: 5, deletions: 1, uncountableFiles: 0 } },
    } as const),
  };
  return { ops, calls };
}

describe('GitBackend — the outcome→verb mapping', () => {
  it('kind says what it is, without any supervisor machinery (RUN-56 is a second consumer)', () => {
    const { ops } = recorder();
    expect(new GitBackend(ops).kind).toBe('git');
  });

  it('declares leasesOverlap — git isolates in space, so a wave may hold a lease per step (RUN-170)', () => {
    const { ops } = recorder();
    expect(new GitBackend(ops).leasesOverlap).toBe(true);
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
    // The run-addressed pair (RUN-170): same outcomes, the other side named by run id — the
    // run-id→branch convention stays in here, symmetric with lease({fromRunId}).
    expect(await vcs.integrateFromRun(ws, 'run_parent')).toEqual({ ok: false, conflicts: ['a.ts'] });
    expect(await vcs.publishToRun(ws, 'run_parent')).toEqual({ ok: true, sha: 'sha1' });
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
      // integrateFromRun/publishToRun resolve the run id to ITS branch; the publishing branch
      // still comes out of location, never from a caller-supplied ref (RUN-50, RUN-170).
      { method: 'rebaseOnto', args: [{ path: '/wt/run_1' }, 'noriq/run/run_parent'] },
      { method: 'landFastForward', args: ['/repo', 'noriq/run/run_parent', 'noriq/run/run_1'] },
      { method: 'pushBranch', args: ['/repo', 'noriq/integration'] },
      { method: 'reapOrphans', args: ['/repo', undefined] },
    ]);
  });

  it('maps the opt-in mission evidence capability without using destructive dispose', async () => {
    const { ops, calls } = recorder();
    const vcs = new GitBackend(ops);
    const ws = await vcs.lease('/repo', 'run_1');
    calls.length = 0;

    expect(await vcs.inspectWorkspace(ws)).toEqual({ revisionId: 'a'.repeat(40), clean: true });
    const checkpointOptions = { expectedParentRevisionId: 'a'.repeat(40) };
    expect(await vcs.checkpointExact(ws, 'mission checkpoint', checkpointOptions)).toEqual({
      beforeRevisionId: 'a'.repeat(40),
      revisionId: 'b'.repeat(40),
      changed: true,
      clean: true,
    });
    const reconciliationOptions = {
      expectedRevisionId: 'a'.repeat(40),
      quarantineId: 'attempt-one',
      message: 'Quarantine attempt one.',
    };
    expect(await vcs.reconcileWorkspace(ws, reconciliationOptions)).toEqual({
      revisionId: 'a'.repeat(40),
      clean: true,
      disposition: 'restored',
    });
    expect(await vcs.restoreWorkspace(ws, 'a'.repeat(40))).toEqual({
      revisionId: 'a'.repeat(40),
      clean: true,
      changed: false,
    });
    await vcs.releaseWorkspace(ws, { preserveRevisionId: 'b'.repeat(40) });

    const location = {
      repoRoot: '/repo',
      path: '/wt/run_1',
      branch: 'noriq/run/run_1',
    };
    expect(calls).toEqual([
      { method: 'inspectExact', args: [location] },
      { method: 'checkpointExact', args: [location, 'mission checkpoint', checkpointOptions] },
      { method: 'reconcileExact', args: [{ runId: 'run_1', ...location }, reconciliationOptions] },
      { method: 'restoreExact', args: [{ runId: 'run_1', ...location }, 'a'.repeat(40)] },
      { method: 'removePreservingBranch', args: [location, 'b'.repeat(40)] },
    ]);
  });

  it('refuses mission evidence when persisted branch provenance was edited', async () => {
    const { ops, calls } = recorder();
    const vcs = new GitBackend(ops);
    const ws = await vcs.lease('/repo', 'run_1');
    calls.length = 0;
    const foreign = {
      ...ws,
      workRef: 'main',
      location: { repoRoot: '/repo', branch: 'main' },
    };

    await expect(vcs.inspectWorkspace(foreign)).rejects.toThrow(/branch provenance/);
    await expect(
      vcs.checkpointExact(foreign, 'no', { expectedParentRevisionId: 'a'.repeat(40) }),
    ).rejects.toThrow(/branch provenance/);
    await expect(
      vcs.reconcileWorkspace(foreign, {
        expectedRevisionId: 'a'.repeat(40),
        quarantineId: 'foreign',
        message: 'No.',
      }),
    ).rejects.toThrow(/branch provenance/);
    await expect(vcs.restoreWorkspace(foreign, 'a'.repeat(40))).rejects.toThrow(/branch provenance/);
    await expect(vcs.releaseWorkspace(foreign, { preserveRevisionId: 'a'.repeat(40) })).rejects.toThrow(
      /branch provenance/,
    );
    expect(calls).toEqual([]);
  });

  it('share forwards an explicit remote, and withholds the arg entirely when the caller did', async () => {
    const { ops, calls } = recorder();
    await new GitBackend(ops).share('/repo', 'b', 'upstream');
    expect(calls[0]).toEqual({ method: 'pushBranch', args: ['/repo', 'b', 'upstream'] });
  });

  it('openReview delegates to gh via merge-request.ts — args through, result verbatim (RUN-85)', async () => {
    // The one verb that maps outside GitOps: onward review is `gh pr create` (RUN-28), so the
    // exec is injected the same way GitOps is and merge-request.test.ts keeps owning gh's
    // behaviour (already-exists, hand-runnable command). This pins only the delegation.
    const gh: Array<{ args: string[]; cwd: string }> = [];
    const { ops } = recorder();
    const vcs = new GitBackend(ops, undefined, async (args, cwd) => {
      gh.push({ args, cwd });
      return { stdout: 'https://github.com/noriq-dev/runner/pull/7\n' };
    });
    const res = await vcs.openReview('/repo', {
      head: 'noriq/plan-alpha',
      base: 'main',
      planTitle: 'Runner v2',
      planKey: 'alpha',
    });
    expect(res).toEqual({ ok: true, url: 'https://github.com/noriq-dev/runner/pull/7' });
    expect(gh[0]?.cwd).toBe('/repo');
    expect(gh[0]?.args.slice(0, 6)).toEqual(['pr', 'create', '--base', 'main', '--head', 'noriq/plan-alpha']);
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
    await expect(vcs.publishToRun(alien, 'run_1')).rejects.toThrow(/does not carry a git location/);
    await expect(vcs.dispose(alien)).rejects.toThrow(/run_9/);
  });
});

// RUN-211: leaseIndexSnapshot/releaseIndexSnapshot follow the same naming-boundary discipline as
// every other verb above — this pins the wrap/unwrap and the foreign-object refusal; real git
// detachment/pinning/reap behaviour is worktree.test.ts's job, exactly as `create`'s is.
describe('GitBackend — index snapshot (RUN-211)', () => {
  it('leaseIndexSnapshot wraps the handle into an IndexSnapshot: no branch, readOnly true', async () => {
    const { ops, calls } = recorder();
    const res = await new GitBackend(ops).leaseIndexSnapshot('/repo');
    if (!res.ok) throw new Error('expected an acquired snapshot');
    expect(res.snapshot).toMatchObject({
      localPath: '/wt/repo-index-snapshot-abc',
      baseId: 'snap0000',
      readOnly: true,
      location: { repoRoot: '/repo', kind: 'index-snapshot' },
    });
    // Git materializes, so it reads through the FILESYSTEM source (RUN-252/254/255) — and rooted at
    // the SNAPSHOT, never at the repo, or the indexer would read the operator's working tree
    // instead of the pinned base. `source` is the field the indexer actually consumes, so asserting
    // its identity and root matters more than the `localPath` beside it.
    expect(res.snapshot.source).toBeInstanceOf(FilesystemIndexSource);
    expect(res.snapshot.source.kind).toBe('filesystem');
    expect(calls).toEqual([{ method: 'createIndexSnapshot', args: ['/repo'] }]);
  });

  it('releaseIndexSnapshot unwraps location and calls removeIndexSnapshot verbatim', async () => {
    const { ops, calls } = recorder();
    const vcs = new GitBackend(ops);
    const res = await vcs.leaseIndexSnapshot('/repo');
    calls.length = 0;
    if (!res.ok) throw new Error('expected ok:true');
    await vcs.releaseIndexSnapshot(res.snapshot);
    expect(calls).toEqual([
      {
        method: 'removeIndexSnapshot',
        args: [{ repoRoot: '/repo', path: '/wt/repo-index-snapshot-abc' }],
      },
    ]);
  });

  it('refuses to release a Workspace — structurally close enough to typecheck, refused at runtime anyway', async () => {
    const { ops, calls } = recorder();
    const vcs = new GitBackend(ops);
    const runWorkspace: Workspace = {
      runId: 'run_1',
      localPath: '/wt/run_1',
      readOnly: false,
      baseId: 'base0000',
      workRef: 'noriq/run/run_1',
      location: { repoRoot: '/repo', branch: 'noriq/run/run_1' }, // a REAL run's location
    };
    // Passed as an IndexSnapshot: exactly the structural-typing hazard the interface doc warns
    // about — Workspace satisfies IndexSnapshot's shape with an extra field or two.
    await expect(vcs.releaseIndexSnapshot(runWorkspace as unknown as IndexSnapshot)).rejects.toThrow(
      /not an index snapshot this backend minted/,
    );
    expect(calls.some((c) => c.method === 'removeIndexSnapshot')).toBe(false); // nothing touched
  });

  it('refuses a hand-edited object with no location at all', async () => {
    const { ops } = recorder();
    const vcs = new GitBackend(ops);
    const alien: IndexSnapshot = {
      source: new FakeIndexSource([]),
      localPath: '/somewhere',
      baseId: 'x',
      readOnly: true,
      location: { not: 'a snapshot' },
    };
    await expect(vcs.releaseIndexSnapshot(alien)).rejects.toThrow(
      /not an index snapshot this backend minted/,
    );
  });
});

// RUN-212: same delegation discipline as every other verb — a pure pass-through, no wrap/unwrap,
// because `from`/`to` are already opaque commit ids and `ChangesBetweenResult` is already the
// backend-neutral shape. Real git behaviour (renames, deletions, the full-index fallbacks) is
// worktree.test.ts's job, exactly as `create`'s real git behaviour is.
describe('GitBackend — changesBetween (RUN-212)', () => {
  it('passes repoRoot/from/to straight through and returns the result verbatim', async () => {
    const { ops, calls } = recorder();
    const res = await new GitBackend(ops).changesBetween('/repo', 'sha-from', 'sha-to');
    expect(res).toEqual({ ok: true, changed: ['src/a.ts'], deleted: ['src/old.ts'] });
    expect(calls).toEqual([{ method: 'changesBetween', args: ['/repo', 'sha-from', 'sha-to'] }]);
  });
});

// RUN-256: same pure pass-through discipline as changesBetween one verb over — worktree.test.ts
// owns the real `git check-ignore` behaviour, this only pins the delegation.
describe('GitBackend — queryIgnored (RUN-256)', () => {
  it('passes repoRoot/paths straight through and returns the result verbatim', async () => {
    const { ops, calls } = recorder();
    const res = await new GitBackend(ops).queryIgnored('/repo', ['node_modules', 'src']);
    expect(res).toEqual({ ok: true, ignored: new Set(['node_modules']) });
    expect(calls).toEqual([{ method: 'checkIgnored', args: ['/repo', ['node_modules', 'src']] }]);
  });
});

// RUN-222: same pure pass-through discipline again — worktree.test.ts owns the real `rev-parse`
// behaviour, this only pins the delegation (and that `branch` really is optional).
describe('GitBackend — currentBase (RUN-222)', () => {
  it('passes repoRoot/branch straight through and returns the result verbatim', async () => {
    const { ops, calls } = recorder();
    const res = await new GitBackend(ops).currentBase('/repo', 'main');
    expect(res).toEqual({ ok: true, baseId: 'cur0000' });
    expect(calls).toEqual([{ method: 'currentBase', args: ['/repo', 'main'] }]);
  });

  it('omitting branch passes undefined through, never a synthesized default', async () => {
    const { ops, calls } = recorder();
    await new GitBackend(ops).currentBase('/repo');
    expect(calls).toEqual([{ method: 'currentBase', args: ['/repo', undefined] }]);
  });
});

// RUN-245: same pure pass-through discipline as changesBetween/queryIgnored/currentBase —
// `WorktreeManager.changeStats` already speaks `ChangeStatsResult` and needs nothing from
// `Workspace` beyond `localPath`/`baseId`, so this pins only the delegation. Real git behaviour
// (numstat parsing, binary/rename/untracked handling, determinism) is worktree.test.ts's job.
describe('GitBackend — changeStats (RUN-245)', () => {
  const ws: Workspace = {
    runId: 'run_1',
    localPath: '/wt/run_1',
    readOnly: false,
    baseId: 'base0000',
    workRef: 'noriq/run/run_1',
    location: { repoRoot: '/repo', branch: 'noriq/run/run_1' },
  };

  it('passes {path, baseSha} straight through and returns the result verbatim', async () => {
    const { ops, calls } = recorder();
    const res = await new GitBackend(ops).changeStats(ws);
    expect(res).toEqual({
      ok: true,
      stats: { changedFiles: 2, lines: { additions: 5, deletions: 1, uncountableFiles: 0 } },
    });
    expect(calls).toEqual([{ method: 'changeStats', args: [{ path: '/wt/run_1', baseSha: 'base0000' }] }]);
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
      releaseAllMine: async (...args: unknown[]) => {
        calls.push({ method: 'releaseAllMine', args });
        return { released: [] };
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
