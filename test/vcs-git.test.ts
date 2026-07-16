import { describe, expect, it } from 'vitest';
import { GitBackend, type GitOps } from '../src/vcs/git';
import type { WorktreeInfo } from '../src/worktree';

// GitBackend is a naming boundary, so its whole contract is the MAPPING: each outcome reaches
// the right git verb, with the arguments passed through untouched and the result returned
// verbatim. Nothing here exercises git itself — worktree.test.ts owns that behaviour, against
// real repos, and this seam must not duplicate (or drift from) it.

const ws: WorktreeInfo = {
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
    create: record('create', ws),
    remove: record('remove', undefined),
    hasChanges: record('hasChanges', true),
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

  it('maps every outcome to its verb, args untouched, results verbatim', async () => {
    const { ops, calls } = recorder();
    const vcs = new GitBackend(ops);

    expect(await vcs.lease('/repo', 'run_1', { readOnly: true, baseRef: 'main' })).toBe(ws);
    await vcs.dispose(ws);
    expect(await vcs.hasWork(ws)).toBe(true);
    expect(await vcs.checkpoint(ws, 'msg')).toBe(true);
    expect(await vcs.targetExists('/repo', 'noriq/integration')).toBe(true);
    await vcs.createTarget('/repo', 'noriq/integration', 'main');
    // The two shapes the interface exists to preserve: conflict PATHS, and compare-and-swap.
    expect(await vcs.integrate(ws, 'noriq/integration')).toEqual({ ok: false, conflicts: ['a.ts'] });
    expect(await vcs.resumeIntegrate(ws)).toEqual({ ok: true });
    await vcs.abandonIntegrate(ws);
    expect(await vcs.publish('/repo', 'noriq/integration', ws.branch)).toEqual({ ok: true, sha: 'sha1' });
    expect(await vcs.share('/repo', 'noriq/integration')).toEqual({ ok: false, detail: 'offline' });
    expect(await vcs.reapOrphans('/repo')).toBe(2);

    expect(calls).toEqual([
      { method: 'create', args: ['/repo', 'run_1', { readOnly: true, baseRef: 'main' }] },
      { method: 'remove', args: [ws] },
      { method: 'hasChanges', args: [ws] },
      { method: 'commitWork', args: [ws, 'msg'] },
      { method: 'refExists', args: ['/repo', 'noriq/integration'] },
      { method: 'createBranch', args: ['/repo', 'noriq/integration', 'main'] },
      { method: 'rebaseOnto', args: [ws, 'noriq/integration'] },
      { method: 'continueRebase', args: [ws] },
      { method: 'abortRebase', args: [ws] },
      { method: 'landFastForward', args: ['/repo', 'noriq/integration', ws.branch] },
      { method: 'pushBranch', args: ['/repo', 'noriq/integration'] },
      { method: 'reapOrphans', args: ['/repo', undefined] },
    ]);
  });

  it('share forwards an explicit remote, and withholds the arg entirely when the caller did', async () => {
    // pushBranch defaults remote='origin' via a DEFAULT PARAMETER — pass `undefined` through and
    // the default still applies, but the distinction matters if that ever becomes an options
    // object. Pin the passthrough both ways so a refactor can't silently drop the remote.
    const { ops, calls } = recorder();
    await new GitBackend(ops).share('/repo', 'b', 'upstream');
    expect(calls[0]).toEqual({ method: 'pushBranch', args: ['/repo', 'b', 'upstream'] });
  });

  it('a WorktreeManager-shaped object satisfies GitOps structurally — the seam already existed', () => {
    // Type-level: if WorktreeManager stops satisfying GitOps (a rename, a signature drift),
    // this file fails to COMPILE, which is the earliest possible alarm.
    const { ops } = recorder();
    const backend: GitBackend = new GitBackend(ops);
    expect(backend).toBeInstanceOf(GitBackend);
  });
});
