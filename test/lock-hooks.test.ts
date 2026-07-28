import { describe, expect, it, vi } from 'vitest';
import { lockHooks } from '../src/drivers/claude';
import {
  type LockAcquireOutcome,
  LockEnforcer,
  denyReason,
  extractPaths,
  lockPathsForTool,
  parseBashTargets,
  toRepoRelative,
} from '../src/lock-hooks';

describe('path extraction (RUN-101, ported from the PLNR hook)', () => {
  it('takes the file_path of the edit tools and the notebook_path of NotebookEdit', () => {
    expect(extractPaths('Write', { file_path: '/r/a.ts' })).toEqual(['/r/a.ts']);
    expect(extractPaths('Edit', { file_path: '/r/a.ts' })).toEqual(['/r/a.ts']);
    expect(extractPaths('MultiEdit', { file_path: '/r/a.ts' })).toEqual(['/r/a.ts']);
    expect(extractPaths('NotebookEdit', { notebook_path: '/r/n.ipynb' })).toEqual(['/r/n.ipynb']);
    expect(extractPaths('Read', { file_path: '/r/a.ts' })).toEqual([]); // a read locks nothing
  });

  it('parses the write targets of a simple shell command', () => {
    expect(parseBashTargets('touch a.txt')).toEqual(['a.txt']);
    expect(parseBashTargets('rm -rf build out')).toEqual(['build', 'out']);
    expect(parseBashTargets('echo hi > log.txt')).toEqual(['log.txt']);
    expect(parseBashTargets('cp x y && mv y z')).toEqual(['x', 'y', 'z']);
  });

  it('FAILS OPEN on any dynamic construct — a false block on a shell command is worse than a missed lock', () => {
    expect(parseBashTargets('rm $FILE')).toEqual([]); // variable
    expect(parseBashTargets('rm *.tmp')).toEqual([]); // glob
    expect(parseBashTargets('cat <(gen)')).toEqual([]); // process substitution
    expect(parseBashTargets('echo `date` > f')).toEqual([]); // command substitution
  });

  it('only a git checkout pathspec after -- is a write; a bare branch checkout is not', () => {
    expect(parseBashTargets('git checkout main')).toEqual([]);
    expect(parseBashTargets('git checkout -- src/a.ts')).toEqual(['src/a.ts']);
  });

  it('toRepoRelative keeps in-repo paths POSIX and drops escapes', () => {
    expect(toRepoRelative('/repo/src/a.ts', '/repo')).toBe('src/a.ts');
    expect(toRepoRelative('src/a.ts', '/repo')).toBe('src/a.ts');
    expect(toRepoRelative('/etc/passwd', '/repo')).toBeNull(); // outside the worktree
    expect(toRepoRelative('/repo', '/repo')).toBeNull(); // the root itself
  });

  it('lockPathsForTool repo-scopes, dedupes, and drops out-of-tree paths', () => {
    expect(
      lockPathsForTool('Bash', { command: 'touch a.txt && touch a.txt && touch /etc/x' }, '/repo'),
    ).toEqual(['a.txt']);
  });
});

describe('LockEnforcer.guard (RUN-101)', () => {
  const enforcer = (
    lock: (paths: string[]) => Promise<LockAcquireOutcome>,
    release = vi.fn(async () => {}),
  ) => new LockEnforcer({ root: '/repo', lock, release });

  it('allows a read/non-file tool without calling the lock layer', async () => {
    const lock = vi.fn(async () => ({ ok: true, enabled: true, locks: [] }) as LockAcquireOutcome);
    expect(await enforcer(lock).guard('Read', { file_path: '/repo/a.ts' })).toBeNull();
    expect(lock).not.toHaveBeenCalled();
  });

  it('acquires the write set and allows when granted', async () => {
    const lock = vi.fn(
      async (paths: string[]) =>
        ({ ok: true, enabled: true, locks: paths.map((p) => ({ id: p, path: p })) }) as LockAcquireOutcome,
    );
    expect(await enforcer(lock).guard('Write', { file_path: '/repo/src/a.ts' })).toBeNull();
    expect(lock).toHaveBeenCalledWith(['src/a.ts']);
  });

  it('DENIES with a coordination message when a peer holds the path', async () => {
    const lock = async () =>
      ({
        ok: false,
        conflicts: [
          { path: 'src/a.ts', holder: 'agt_o', holderName: 'peer', taskKey: 'RUN-1', expiresAt: 'T' },
        ],
      }) as LockAcquireOutcome;
    const reason = await enforcer(lock).guard('Edit', { file_path: '/repo/src/a.ts' });
    expect(reason).toContain('locked by peer');
    expect(reason).toContain('RUN-1');
    expect(reason).toContain('Coordinate');
  });

  it('FAILS OPEN when the lock service throws — a blip must not wedge the edit', async () => {
    const lock = async () => {
      throw new Error('network');
    };
    expect(await enforcer(lock).guard('Write', { file_path: '/repo/a.ts' })).toBeNull();
  });

  it('releases exactly what it acquired on Stop (and nothing when it held nothing)', async () => {
    const release = vi.fn(async () => {});
    const lock = async (paths: string[]) =>
      ({ ok: true, enabled: true, locks: paths.map((p) => ({ id: p, path: p })) }) as LockAcquireOutcome;
    const e = enforcer(lock, release);
    await e.guard('Write', { file_path: '/repo/a.ts' });
    await e.guard('Write', { file_path: '/repo/b.ts' });
    await e.releaseHeld();
    expect(release).toHaveBeenCalledWith(['a.ts', 'b.ts']);
    await e.releaseHeld(); // idempotent — nothing left to drop
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('a locking-disabled project grants but records nothing to release', async () => {
    const release = vi.fn(async () => {});
    const lock = async () => ({ ok: true, enabled: false, locks: [] }) as LockAcquireOutcome;
    const e = enforcer(lock, release);
    expect(await e.guard('Write', { file_path: '/repo/a.ts' })).toBeNull();
    await e.releaseHeld();
    expect(release).not.toHaveBeenCalled();
  });
});

describe('denyReason', () => {
  it('names one file vs several and always tells the agent how to unblock', () => {
    expect(denyReason([{ path: 'a', holder: 'x' }])).toMatch(/holds a file/);
    expect(
      denyReason([
        { path: 'a', holder: 'x' },
        { path: 'b', holder: 'y' },
      ]),
    ).toMatch(/holds files/);
  });
});

describe('lockHooks — the Claude SDK glue (RUN-101)', () => {
  const enforcerDenying = new LockEnforcer({
    root: '/repo',
    lock: async () => ({ ok: false, conflicts: [{ path: 'a.ts', holder: 'agt_o', holderName: 'peer' }] }),
    release: async () => {},
  });

  it('PreToolUse returns a deny decision the SDK feeds back to the model', async () => {
    const hooks = lockHooks(enforcerDenying);
    const cb = hooks.PreToolUse![0]!.hooks[0]!;
    const out = await cb(
      { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/repo/a.ts' } },
      'tu',
      {
        signal: new AbortController().signal,
      },
    );
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('locked by peer');
  });

  it('PreToolUse allows (empty output) when nothing conflicts', async () => {
    const enforcer = new LockEnforcer({
      root: '/repo',
      lock: async () => ({ ok: true, enabled: true, locks: [] }),
      release: async () => {},
    });
    const cb = lockHooks(enforcer).PreToolUse![0]!.hooks[0]!;
    const out = await cb(
      { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/repo/a.ts' } },
      'tu',
      {
        signal: new AbortController().signal,
      },
    );
    expect(out).toEqual({});
  });

  it('wires a Stop hook that releases', async () => {
    const release = vi.fn(async () => {});
    const enforcer = new LockEnforcer({
      root: '/repo',
      lock: async (p) => ({ ok: true, enabled: true, locks: p.map((x) => ({ id: x, path: x })) }),
      release,
    });
    const hooks = lockHooks(enforcer);
    await hooks.PreToolUse![0]!.hooks[0]!(
      { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/repo/a.ts' } },
      'tu',
      { signal: new AbortController().signal },
    );
    await hooks.Stop![0]!.hooks[0]!({ hook_event_name: 'Stop' }, undefined, {
      signal: new AbortController().signal,
    });
    expect(release).toHaveBeenCalledWith(['a.ts']);
  });
});
