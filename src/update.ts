import { VERSION } from './version';

/**
 * Is this runner behind? (RUN-37)
 *
 * Reads the version straight from the runner's own public repo. Noriq is deliberately NOT in
 * this path: it does not build, publish, or own the runner, so putting it in the middle made it
 * a release-distribution service for a number it has no authority over — an indirection that
 * could only add staleness and a second thing to keep in sync.
 *
 * package.json on main, not a dedicated version.json: it is ALREADY the single source of truth
 * (RUN-36 made the build inject from it), and a second file is a second thing to bump — whose
 * failure mode is a feed that disagrees with the artifact it describes, which is the bug RUN-36
 * existed to remove.
 *
 * ## What this deliberately does NOT do
 *
 * It does not replace anything. `@noriq-dev/runner` IS published, so "nothing to fetch" is not
 * the reason — the reason is what replacement would mean.
 *
 * The daemon holds the operator's OAuth token (90-day refresh), spawns agents at a permission
 * floor it chooses, and with `[land]` can write the repo's branches. Whoever controls the version
 * feed controls all of that on every opted-in box. The package carries npm's registry
 * signatures — which every package gets, and which prove "npm served this", not "this was built
 * from that repo" — and no provenance attestation. Unattended replacement on that basis means a
 * compromised publish propagates to every runner with nobody present at the moment of change.
 * That is a supply-chain decision for a human to make, not a default to ship.
 *
 * Two things make it defensible when someone wants it: publish with `--provenance` from CI (so a
 * runner can verify the artifact came from the expected repo + workflow), and solve the drain +
 * restart problem — the daemon supervises live agents, so swapping under them strands worktrees
 * and orphans runs, and it cannot exec itself cleanly while holding a WS and child processes.
 * `HeartbeatInput.status` already has `'draining'`, which is the hook. See THREAT-MODEL.md.
 *
 * So this is the check: a public GET, and a runner that says out loud when it is behind, naming
 * the exact command a human can run.
 *
 * Caveat worth knowing: main can be AHEAD of npm (bump, commit, publish later), so this can
 * briefly name a version `npm i -g` will not yet install. That is a release-procedure problem
 * (push and publish together), and it is why an unreachable or unparsable feed yields null
 * rather than a guess — advertising a version nobody can install is worse than saying nothing.
 */

/** The runner's own repo. Public, so no credential and no server in the middle. */
const VERSION_SOURCE = 'https://raw.githubusercontent.com/noriq-dev/runner/main/package.json';

export interface UpdateCheck {
  current: string;
  latest: string | null;
  /** True only when we actually know both and current < latest. Unknown is never "behind". */
  behind: boolean;
}

/** Compare dotted numeric versions. <0, 0, >0. A pre-release sorts before its release, so
 *  0.2.0-rc.1 is older than 0.2.0 — which is what a human means by it. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = v.split('-', 2);
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  if (x.pre && y.pre) return x.pre === y.pre ? 0 : x.pre < y.pre ? -1 : 1;
  return 0;
}

/**
 * Ask the repo what the current release is.
 *
 * Never throws: a runner must not fall over, or refuse to start, because a version feed had a bad
 * day — being unable to check is not the same as being out of date, and treating it as such would
 * be worse than not checking at all.
 */
export async function checkForUpdate(
  opts: { fetchImpl?: typeof fetch; current?: string; source?: string } = {},
): Promise<UpdateCheck> {
  const current = opts.current ?? VERSION;
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(opts.source ?? VERSION_SOURCE, { headers: { 'User-Agent': 'noriq-runner' } });
    if (!res.ok) return { current, latest: null, behind: false };
    const pkg = (await res.json()) as { version?: unknown };
    const latest = typeof pkg.version === 'string' ? pkg.version : null;
    return { current, latest, behind: latest != null && compareVersions(current, latest) < 0 };
  } catch {
    return { current, latest: null, behind: false };
  }
}

/** What to tell a human who is behind. Names the command rather than running it — see the
 *  module comment for why the daemon does not replace itself. */
export function updateAdvice(check: UpdateCheck): string {
  if (check.latest == null) return `noriq-runner ${check.current} (could not reach the version feed)`;
  if (check.behind) {
    return `noriq-runner ${check.current} → ${check.latest} available: npm i -g @noriq-dev/runner@latest`;
  }
  return `noriq-runner ${check.current} is current`;
}
