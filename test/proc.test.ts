import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { type ProcDeps, killProcessTree, treeSpawnOptions } from '../src/proc';

// Injected platform, so both branches are exercised from either OS — the house pattern (drivers
// take a queryFn, worktrees a GitRunner). The `windows-latest` CI job added with this task is
// what keeps these stubs honest about the platform they claim to describe.
type FakeChild = Pick<ChildProcess, 'pid' | 'kill'> & { kill: ReturnType<typeof vi.fn> };
const child = (pid = 4242): FakeChild => ({ pid, kill: vi.fn() }) as unknown as FakeChild;
/** A child that never started. Its own helper, because `child(undefined)` would take the
 *  default 4242 and quietly assert the opposite of what it reads like. */
const unstarted = (): FakeChild => ({ pid: undefined, kill: vi.fn() }) as unknown as FakeChild;

/** Records what a platform's kill path actually reached for. */
const spy = (platform: string, over: Partial<ProcDeps> = {}) => {
  const spawned: Array<{ cmd: string; args: string[] }> = [];
  const killed: Array<{ pid: number; signal: string }> = [];
  const deps: ProcDeps = {
    platform,
    spawnFn: ((cmd: string, args: string[]) => {
      spawned.push({ cmd, args });
      return { on: () => {} };
    }) as never,
    killFn: (pid, signal) => void killed.push({ pid, signal }),
    ...over,
  };
  return { deps, spawned, killed };
};

describe('treeSpawnOptions (RUN-42)', () => {
  it('groups the tree on POSIX', () => {
    // detached = new process group, so one signal reaches the shell AND the vitest under it.
    expect(treeSpawnOptions({ platform: 'linux' })).toEqual({ detached: true });
  });

  it('does NOT detach on Windows — there it means "new console", not "new group"', () => {
    // The premise does not hold there, and the side effect is a console window popping up on a
    // daemon that should be invisible. taskkill /T walks the tree instead; nothing to group.
    expect(treeSpawnOptions({ platform: 'win32' })).toEqual({ detached: false });
  });
});

describe('killProcessTree (RUN-42)', () => {
  it('POSIX: signals the process GROUP, not the process', () => {
    const { deps, killed } = spy('linux');
    killProcessTree(child(4242), { force: true }, deps);
    // Negative pid = the group. Signalling 4242 alone leaves the grandchildren holding the pipes,
    // and 'close' fires only once every stdio is closed.
    expect(killed).toEqual([{ pid: -4242, signal: 'SIGKILL' }]);
  });

  it('POSIX: SIGTERM when asked to stop gracefully', () => {
    const { deps, killed } = spy('linux');
    killProcessTree(child(7), { force: false }, deps);
    expect(killed).toEqual([{ pid: -7, signal: 'SIGTERM' }]);
  });

  it('POSIX: falls back to the bare child when there is no group', () => {
    const c = child(9);
    const { deps } = spy('linux', {
      killFn: () => {
        throw new Error('ESRCH'); // not detached, or already reaped
      },
    });
    killProcessTree(c, {}, deps);
    expect(c.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('Windows: taskkill /T /F, and NEVER a negative pid', () => {
    const { deps, spawned, killed } = spy('win32');
    killProcessTree(child(4242), { force: true }, deps);
    expect(spawned).toEqual([{ cmd: 'taskkill', args: ['/T', '/F', '/PID', '4242'] }]);
    // The bug this replaces: Node REJECTS a negative pid on Windows, so the POSIX path did not
    // merely misbehave — it threw, and the fallback reaped only the wrapper, orphaning the tree.
    expect(killed).toEqual([]);
  });

  it('Windows: /T even for a graceful stop — orphaning is not a kindness', () => {
    const { deps, spawned } = spy('win32');
    killProcessTree(child(11), { force: false }, deps);
    // No /F: the closest Windows has to "ask nicely" (WM_CLOSE, which a console app may ignore).
    expect(spawned).toEqual([{ cmd: 'taskkill', args: ['/T', '/PID', '11'] }]);
  });

  it('Windows: falls back to the child when taskkill itself cannot run', () => {
    const c = child(3);
    const { deps } = spy('win32', {
      spawnFn: (() => {
        throw new Error('ENOENT: taskkill missing');
      }) as never,
    });
    killProcessTree(c, {}, deps);
    expect(c.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does nothing for a child that never started', () => {
    const { deps, killed, spawned } = spy('linux');
    killProcessTree(unstarted(), {}, deps);
    expect(killed).toEqual([]);
    expect(spawned).toEqual([]);
  });

  it('never throws for a process that is already gone', () => {
    const c = child(5);
    c.kill.mockImplementation(() => {
      throw new Error('ESRCH');
    });
    const { deps } = spy('linux', {
      killFn: () => {
        throw new Error('ESRCH');
      },
    });
    // Called from a timeout handler and from teardown — throwing here takes the daemon with it.
    expect(() => killProcessTree(c, {}, deps)).not.toThrow();
  });
});
