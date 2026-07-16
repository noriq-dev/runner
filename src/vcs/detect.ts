import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * Which backend owns a repo (RUN-60). DETECTION, never a manifest field — a committed
 * `vcs = "git"` in the wrong checkout is a lie the daemon would trust, and the marker file
 * travels to checkouts it was not written for (Montana's standing call from RUN-56).
 *
 * Per backend:
 *
 *  - **git** is a filesystem fact: `.git` at the root — a directory, or a FILE (worktrees and
 *    submodules use a gitfile pointer, and this daemon's own run worktrees are exactly that).
 *  - **diversion** has NO in-repo marker at all (measured, RUN-54: a workspace root holds only
 *    project files). The registry is the `dv` CLI's own: `dv repo` lists every cloned repo as
 *    `Name (dv.repo.<uuid>)(<path>)`. Asking the CLI is also the health probe — the sync agent
 *    answers it, and a Diversion repo whose agent is dead must NOT be routed to a backend whose
 *    every "Synced" assumption would quietly fail.
 *
 * Precedence, decided deliberately rather than discovered by accident: **an explicit `.git` at
 * the repo root wins**, and Diversion claims only roots its registry names exactly. Diversion
 * imports FROM git, so a git checkout living inside a Diversion workspace is plausible — and the
 * one thing worse than picking a side is picking silently, so the daemon logs what it chose and
 * why (`reason`).
 *
 * Paths are compared by REALPATH on both sides, and this is not pedantry: on the first machine
 * this ran on, $HOME is `/home/mtuska` while `dv repo` prints `/var/home/mtuska/…` (Fedora
 * Atomic's `/home` symlink — the same symlink that broke the v0.2.0 CLI entry guard). A string
 * compare would deny the operator's own repos.
 */

export interface VcsDetection {
  kind: 'git' | 'diversion';
  /** Diversion's repo id (dv.repo.…) — DiversionBackend is constructed per repo with it. */
  repoId?: string;
  /** Why this repo got this backend — for the discover log, so routing is never silent. */
  reason: string;
}

export interface DetectDeps {
  /** Injectable `dv repo` runner; tests fake it, and prod may not have dv installed at all. */
  dvRepoList?: () => Promise<string>;
  exists?: (p: string) => boolean;
  realpath?: (p: string) => string;
}

const realDvRepoList = async (): Promise<string> => {
  const { stdout } = await execFileP('dv', ['repo'], { maxBuffer: 4 * 1024 * 1024 });
  return stdout;
};

/** `Name (dv.repo.<uuid>)(<path>)` — anchored from the right, because names may hold anything. */
const DV_REPO_LINE = /\((dv\.repo\.[^)]+)\)\((.+)\)\s*$/;

/** Parse `dv repo` output into realpath → repoId. Exposed for tests. */
export function parseDvRepoList(stdout: string, realpath: (p: string) => string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const m = line.match(DV_REPO_LINE);
    if (!m?.[1] || !m[2]) continue;
    try {
      out.set(realpath(m[2].trim()), m[1]);
    } catch {
      // A registry entry whose path no longer exists claims nothing.
    }
  }
  return out;
}

/**
 * Detect backends for a set of repo roots in one pass. One `dv repo` spawn total (not per
 * repo): the answer is machine-global, and the spawn doubles as the agent health probe — if it
 * fails, every root falls back to git and the caller's log says the registry was unreachable.
 */
export async function detectVcs(roots: string[], deps: DetectDeps = {}): Promise<Map<string, VcsDetection>> {
  const exists = deps.exists ?? existsSync;
  const realpath =
    deps.realpath ??
    ((p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return path.resolve(p);
      }
    });

  // Ask dv lazily, once, and only if some root is NOT plainly git — most machines have no dv,
  // and a fleet of pure git repos should not pay a spawn (or a warning) for it.
  let dvMap: Map<string, string> | null | undefined;
  const dvRegistry = async (): Promise<Map<string, string> | null> => {
    if (dvMap !== undefined) return dvMap;
    try {
      dvMap = parseDvRepoList(await (deps.dvRepoList ?? realDvRepoList)(), realpath);
    } catch {
      dvMap = null; // no dv on PATH, or the agent is down — either way the registry is silent
    }
    return dvMap;
  };

  const out = new Map<string, VcsDetection>();
  for (const root of roots) {
    if (exists(path.join(root, '.git'))) {
      // Explicit .git wins even inside a Diversion workspace — see the precedence note above.
      out.set(root, { kind: 'git', reason: '.git present at the root' });
      continue;
    }
    const registry = await dvRegistry();
    const repoId = registry?.get(realpath(root));
    if (repoId) {
      out.set(root, {
        kind: 'diversion',
        repoId,
        reason: `no .git, and the dv registry names this exact path (${repoId})`,
      });
      continue;
    }
    out.set(root, {
      kind: 'git',
      reason:
        registry === null
          ? 'no .git; dv registry unreachable — defaulting to git'
          : 'no .git; not in the dv registry — defaulting to git',
    });
  }
  return out;
}
