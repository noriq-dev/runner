import { type ChildProcess, spawn } from 'node:child_process';

/**
 * Killing a process AND everything it spawned, on both platforms (RUN-42).
 *
 * The daemon's job is supervising other people's processes, and every one of them is a tree: a
 * shell that spawned vitest that spawned esbuild; a codex that spawned a test command. Signalling
 * only the process we happen to hold a handle to is how a "stopped" run keeps burning CPU, keeps
 * a worktree locked, and keeps stdio open — and 'close' fires only once ALL stdio are closed, so
 * a missed grandchild does not merely leak, it hangs the parent waiting on it.
 *
 * POSIX and Windows disagree about nearly everything here, which is why this is one module rather
 * than four call sites each getting it half right:
 *
 * | | POSIX | Windows |
 * |---|---|---|
 * | group the tree | `detached: true` → new process group | `detached` = new CONSOLE; no groups exist |
 * | signal the tree | `process.kill(-pid, …)` | negative pids are REJECTED by Node |
 * | graceful stop | SIGTERM; the process may clean up | no SIGTERM — `kill('SIGTERM')` IS TerminateProcess |
 *
 * That last row is a real semantic difference and it cannot be papered over: "ask nicely, then
 * force" does not exist on Windows. `taskkill` without `/F` is the nearest thing (it posts
 * WM_CLOSE, which a console app is free to ignore), so that is what `force: false` uses there.
 */

/** Injected so the platform branches are testable from either OS (the house pattern — drivers
 *  take a queryFn, worktrees a GitRunner). CI runs the real thing on windows-latest, which is
 *  what keeps these stubs honest about the platform they describe. */
export interface ProcDeps {
  platform?: string;
  spawnFn?: typeof spawn;
  killFn?: (pid: number, signal: NodeJS.Signals) => void;
}

const isWin = (deps: ProcDeps) => (deps.platform ?? process.platform) === 'win32';

/** Spawn options that put a child and its descendants somewhere killProcessTree can reach. */
export const treeSpawnOptions = (deps: ProcDeps = {}): { detached: boolean } => ({
  // POSIX: one process group, so a single signal reaches the whole tree.
  // Windows: `detached` would mean "new console window" — useless here, and visible on a daemon
  // that should not be. taskkill /T walks the tree from the pid instead, so nothing to group.
  detached: !isWin(deps),
});

/**
 * Kill `child` and its descendants. Best-effort and never throws: a process that is already gone
 * is the normal case, not an error — and this is called from timeout handlers and teardown, where
 * throwing would take the daemon with it.
 *
 * @param force POSIX: SIGKILL vs SIGTERM. Windows: taskkill `/F` vs a WM_CLOSE request.
 */
export function killProcessTree(
  child: Pick<ChildProcess, 'pid' | 'kill'>,
  opts: { force?: boolean } = {},
  deps: ProcDeps = {},
): void {
  const force = opts.force ?? true;
  if (!child.pid) return;
  const doSpawn = deps.spawnFn ?? spawn;
  const doKill = deps.killFn ?? ((pid, sig) => void process.kill(pid, sig));

  if (isWin(deps)) {
    try {
      // /T is the entire point: without it only the wrapper dies and its children are orphaned,
      // still holding the pipes this kill was meant to release.
      const args = ['/T', ...(force ? ['/F'] : []), '/PID', String(child.pid)];
      doSpawn('taskkill', args, { stdio: 'ignore' }).on('error', () => fallback(child, force));
    } catch {
      fallback(child, force);
    }
    return;
  }

  try {
    // Negative pid = the whole process group (see treeSpawnOptions).
    doKill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    // No group (not spawned detached), or already reaped. Signal whatever we still can.
    fallback(child, force);
  }
}

function fallback(child: Pick<ChildProcess, 'kill'>, force = true): void {
  try {
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    /* already dead */
  }
}
