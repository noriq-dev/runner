import { execFileSync } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { loadIndexConfig, loadManifest } from './discovery';
import { DEFAULT_DEBUG_LIMIT, buildDebugReport, compareGenerations } from './index-debug';
import type { BuildDebugReportOptions, DeterminismCheck, IndexDebugReport } from './index-debug';
import { IndexPolicy } from './index-policy';
import type { ResolvedIndexConfig } from './index-policy';
import { buildIndexAdapterRegistry } from './index-registry';
import { FilesystemIndexSource } from './index-source';
import type { IndexSource } from './index-source';
import { runIndexer } from './indexer';
import type { IndexRunTarget, IndexerResult } from './indexer';
import { GitBackend } from './vcs/git';
import { PerforceBackend } from './vcs/perforce';
import type { VcsBackend } from './vcs/types';
import { DEFAULT_WORKTREES_DIR, WorktreeManager } from './worktree';

/**
 * The orchestrator behind `noriq-runner index-repo` (RUN-219) — resolve config, build the language-
 * gated adapter registry (`index-registry.ts`), scan THIS box's own filesystem with the real
 * `FilesystemIndexSource`, and run it through the real `runIndexer` (`indexer.ts`). No fake of
 * anything: this is the first reachable caller of `runIndexer` from `dist/cli.js` at all (RUN-216's
 * own `index-selftest` proves the tree-sitter grammars load from the bundle; this proves the
 * INDEXER — the code path that actually walks a repo and produces entities — is in the bundle too,
 * closing exactly the dead-code-elimination gap RUN-216 flagged and could not close on its own).
 *
 * **Deliberately its own module, never folded into `cli.ts`.** Locked decision 4 requires that this
 * command can never upload or mint an ingest capability, and the only durable way to prove that is
 * a narrow, independently walkable import graph: `cli.ts` itself already reaches `client.ts` and
 * `ingest-client.ts` through `start`'s `Daemon`, so a test asking "does `cli.ts` import them" would
 * answer yes for a reason that has nothing to do with THIS command. `index-repo.test.ts`'s import-
 * graph test walks outward from this file specifically — it, `index-debug.ts`, and everything they
 * in turn import — and asserts neither module is reachable. Keep this file's own imports narrow:
 * anything pulled in here becomes part of what that test has to keep proving clean.
 *
 * **Zero network, zero model calls** (locked decision 13, restated for this specific command):
 * `git rev-parse` below reads only local repository state (never `fetch`/`pull`/anything that
 * touches a remote), `runIndexer`'s own doc already establishes it makes no network or model calls,
 * and nothing else in this file talks to a socket. `IndexRunTarget`'s identity fields are locally
 * synthesized, never resolved against Noriq — this command has no server to resolve them against.
 * The VCS backend construction added for `buildVcsIgnoredPredicate` (RUN-256) does not change this:
 * only git and Perforce are ever routed to from here (`backendFor`'s own doc says why Diversion is
 * not), and both backends' `queryIgnored` is a LOCAL process (`git check-ignore`, `p4 ignores -i` —
 * both measured to need no server connection at all) — never a network call.
 *
 * **Why this file, and not the daemon's snapshot path, asks a `VcsBackend` what it ignores**
 * (RUN-256). `leaseIndexSnapshot` only ever hands back TRACKED content (git: a detached worktree;
 * Perforce/Diversion: depot/API reads) — a VCS's own ignore rules have nothing left to drop
 * there, so wiring `queryIgnored` into that path would be dead code dressed as a safeguard (RUN-256
 * locked decision 6). This command is different: it walks a LIVE filesystem
 * (`FilesystemIndexSource` over `options.root` directly), which sees exactly what an agent's own
 * worktree would — including everything a gitignore-shaped rule would otherwise leave in a debug
 * listing that a real dispatch would never index. `buildVcsIgnoredPredicate` below is the one
 * caller of `VcsBackend.queryIgnored` in this file's whole reachable graph.
 */

export interface IndexRepoOptions {
  root: string;
  /** Index even when `[index].enabled` is not `true` for this repo — an explicit, LOCAL-ONLY
   *  override (locked decision 8: "by default respect `[index].enabled`; any override must be an
   *  explicit flag"). Never changes what this command actually DOES — still zero network, zero
   *  upload either way — only whether it consults the repo's own consent boundary before indexing
   *  at all. The caller (`cli.ts`) is responsible for the loud warning naming that boundary; this
   *  function only decides whether to proceed. */
  force?: boolean;
  limit?: number;
  showContent?: boolean;
  /** Injected clock, threaded to `runIndexer` — test-only; production leaves this unset. */
  now?: () => number;
}

export type IndexRepoConfigSource = 'project.toml' | 'forced-default';

export interface IndexRepoRun {
  root: string;
  configSource: IndexRepoConfigSource;
  config: ResolvedIndexConfig;
  target: IndexRunTarget;
  result: IndexerResult;
}

/** The config `runIndexRepo` falls back to under `--force` when no committed `[index]` policy
 *  applies — `IndexPolicy`'s own schema defaults (every language, `contentMode: 'full'`, the
 *  ordinary bounds), scoped to nothing extra via empty `include`/`exclude`. Built once: `IndexPolicy`
 *  parsing an empty table is a pure, deterministic function of the schema alone, so there is nothing
 *  gained by re-parsing it per call the way `resolveIndexConfig` re-reads a committed file per run. */
const FORCED_DEFAULT_CONFIG: ResolvedIndexConfig = { ...IndexPolicy.parse({}), include: [], exclude: [] };

/**
 * Resolve the config to index under. Returns `null` — refused — when `[index].enabled` is not
 * `true` for this repo (absent, `false`, or an invalid `[index]` table all read as OFF, exactly
 * `resolveIndexConfig`'s own contract) AND `force` was not given: the caller's cue to explain the
 * consent boundary and stop, rather than index anything.
 */
export async function resolveIndexRepoConfig(
  root: string,
  force: boolean,
): Promise<{ config: ResolvedIndexConfig; source: IndexRepoConfigSource } | null> {
  const manifestConfig = await loadIndexConfig(root);
  if (manifestConfig) return { config: manifestConfig, source: 'project.toml' };
  if (!force) return null;
  return { config: FORCED_DEFAULT_CONFIG, source: 'forced-default' };
}

/** Best-effort LOCAL git identity for `IndexRunTarget.branch`/`.baseId` — `git rev-parse` reads
 *  only this checkout's own refs, never the network. Never fatal: a worktree with no git history at
 *  all (a synthesized fixture, a bare directory `index-repo` is pointed at for debugging) still
 *  indexes, just under a placeholder identity — `generationId`/`contentHash` only need to be STABLE
 *  across two runs of this command, never to match what a real dispatch would compute against the
 *  server, since this command never talks to the server. */
function gitRevParse(root: string, args: string[]): string | null {
  try {
    const out = execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    return trimmed.length ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Route `root` to a real `VcsBackend` instance (RUN-256) — a CHEAP, LOCAL-ONLY version of
 * `detectVcs`'s own precedence (`vcs/detect.ts`), deliberately NOT a call to that function:
 * `detectVcs`'s Diversion arm spawns `dv repo` whenever NEITHER `.git` nor `.p4config` is present
 * at the root, and that is exactly the shape of a plain scratch directory with no VCS at all —
 * this command's own fixtures included. Paying that spawn to detect a backend whose
 * `queryIgnored` always answers `unknown` regardless (`diversion.ts`'s own doc: no measured local
 * ignore-check primitive exists) would trade this file's "zero network, zero model calls" posture
 * for a guaranteed no-op, so Diversion is never routed to here — `null` (no VCS-ignore filtering
 * attempted at all) is the honest, and cheaper, answer for a root neither marker names. The
 * `.git`/`.p4config` check itself duplicates `detect.ts`'s own convention rather than importing
 * it, on purpose: importing `detect.ts` here would still make Diversion's arm reachable from this
 * file's graph for no benefit, and the convention is two `existsSync` checks, not logic worth a
 * shared abstraction.
 */
function backendFor(root: string): VcsBackend | null {
  if (existsSync(path.join(root, '.git'))) {
    return new GitBackend(new WorktreeManager({ baseDir: DEFAULT_WORKTREES_DIR }));
  }
  if (existsSync(path.join(root, '.p4config'))) return new PerforceBackend({});
  return null;
}

/** Injectable for `buildVcsIgnoredPredicate`'s own tests — a fake that FAILS when asked to
 *  `readdir` a directory the predicate should already have pruned is exactly the "never
 *  `readdir`'d" acceptance line (RUN-256), and this is the one seam that makes such a fake
 *  possible without touching the real filesystem. */
export type VcsIgnoreWalkDeps = {
  readdir?: (absDir: string) => Promise<Dirent[]>;
};

/**
 * Batch-build a synchronous VCS-ignore predicate for the debug walk (RUN-256) — the one bridge
 * between `VcsBackend.queryIgnored` (async, and answered per BATCH, never per single path) and
 * `index-scan.ts`'s `IndexScanDeps.vcsIgnored` (synchronous, called once per candidate as
 * `scanRepoForIndex`'s own streaming walk reaches it). The bridge has to run to completion BEFORE
 * that walk starts: `ShouldDescend`'s contract there is synchronous, and a real ignore check (a
 * subprocess) is not.
 *
 * Mirrors `walkFs`'s own directory-pruning shape (readdir a level, decide, recurse only into
 * survivors) as a SEPARATE walk, deliberately: this is the one place allowed to ask a `VcsBackend`
 * "what does your own mechanism ignore" (locked decision 1 keeps that question out of
 * `index-scan.ts`/`index-source.ts` entirely), so it cannot be folded into the real scan's own
 * walk without leaking VCS vocabulary across that boundary. The cost is real but bounded: the
 * SURVIVING (non-ignored) tree gets `readdir`'d twice — once here, once by the real scan — while
 * the EXPENSIVE subtree (`node_modules`-shaped) is `readdir`'d by NEITHER walk, which is the
 * whole point (RUN-256's measured 243-vs-6943 gap is a directory-pruning problem, not a
 * double-readdir-of-the-surviving-tree one).
 *
 * One `queryIgnored` call per directory LISTING, covering every sibling — files and
 * subdirectories together — in the SAME call (locked decision 2's "batch the query"): a directory
 * with hundreds of entries costs one round trip, not one per entry. A directory or file the
 * backend reports ignored is recorded and never descended/visited further; every survivor is
 * walked deeper.
 *
 * Returns `null` when the backend answers `unknown` at any point (locked decision 3: never
 * guessed — the caller proceeds with no VCS-ignore filtering at all, exactly today's behaviour)
 * or when `root` itself cannot be listed at all.
 */
export async function buildVcsIgnoredPredicate(
  backend: Pick<VcsBackend, 'queryIgnored'>,
  root: string,
  deps: VcsIgnoreWalkDeps = {},
): Promise<((relPath: string) => boolean) | null> {
  const readDir = deps.readdir ?? ((absDir: string) => readdir(absDir, { withFileTypes: true }));
  const ignored = new Set<string>();

  async function walk(absDir: string, relDir: string): Promise<boolean> {
    let entries: Dirent[];
    try {
      entries = await readDir(absDir);
    } catch {
      return true; // unreadable — the real scan will hit this itself and record it there
    }
    if (entries.length === 0) return true;

    const relPaths = entries.map((e) => (relDir ? `${relDir}/${e.name}` : e.name));
    const result = await backend.queryIgnored(root, relPaths);
    if (!result.ok) return false; // unknown — abandon the whole predicate (locked decision 3)

    const toDescend: Array<{ abs: string; rel: string }> = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const rel = relPaths[i]!;
      if (result.ignored.has(rel)) {
        ignored.add(rel); // never descended, whether a file or a directory
        continue;
      }
      if (entry.isDirectory()) toDescend.push({ abs: path.join(absDir, entry.name), rel });
    }
    for (const d of toDescend) {
      if (!(await walk(d.abs, d.rel))) return false;
    }
    return true;
  }

  const complete = await walk(root, '');
  return complete ? (relPath: string) => ignored.has(relPath) : null;
}

/**
 * One local index pass over `options.root`: resolve config, build the adapter registry FOR THAT
 * CONFIG (the language gate — `index-registry.ts`), scan the real filesystem, run the real
 * `runIndexer`. Returns `null` exactly when `resolveIndexRepoConfig` refused (indexing is off and
 * `force` was not given) — the caller decides what to say about that, this function just declines
 * to touch the filesystem at all in that case.
 */
export async function runIndexRepo(options: IndexRepoOptions): Promise<IndexRepoRun | null> {
  const root = path.resolve(options.root);
  const resolved = await resolveIndexRepoConfig(root, options.force ?? false);
  if (!resolved) return null;

  const manifest = await loadManifest(root);
  const target: IndexRunTarget = {
    // No server resolution happens here (this command never contacts one) — a fixed local
    // placeholder is fine because `generationId` only needs to be stable across two runs of THIS
    // command, never to match a real dispatch's server-assigned id.
    projectId: 'local',
    projectKey: manifest?.key ?? 'local',
    repositoryKey: manifest?.repositoryKey ?? 'local',
    branch: gitRevParse(root, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'unknown',
    baseId: gitRevParse(root, ['rev-parse', 'HEAD']) ?? 'unknown',
  };

  const source: IndexSource = new FilesystemIndexSource(root);
  const { registry } = buildIndexAdapterRegistry(resolved.config);
  // RUN-256: match the debug listing to what a real dispatch would ever index — a detached
  // snapshot worktree holds tracked files only, and this live filesystem walk otherwise reports
  // every VCS-ignored path (node_modules and kin) right alongside them. `null` (backend answered
  // `unknown`, or nothing to check) means no filtering at all — exactly this command's prior
  // behaviour, never a guess.
  const vcs = backendFor(root);
  const vcsIgnored = vcs ? ((await buildVcsIgnoredPredicate(vcs, root)) ?? undefined) : undefined;
  const result = await runIndexer(source, resolved.config, target, {
    adapters: registry,
    now: options.now,
    scan: { now: options.now, vcsIgnored },
  });
  await source.close?.();

  return { root, configSource: resolved.source, config: resolved.config, target, result };
}

/** Convenience: `runIndexRepo` plus `buildDebugReport` over its result, in one call — what the
 *  normal (non `--check-determinism`) CLI path needs. Kept separate from `runIndexRepo` itself so a
 *  determinism check (which wants the raw `IndexerResult`s from two runs, never a report of either)
 *  is not paying for report-building it throws away. */
export async function buildIndexRepoReport(
  run: IndexRepoRun,
  options: Pick<BuildDebugReportOptions, 'limit' | 'showContent'> = {},
): Promise<IndexDebugReport> {
  return buildDebugReport(run.result, {
    root: run.root,
    configSource: run.configSource,
    config: run.config,
    limit: options.limit ?? DEFAULT_DEBUG_LIMIT,
    showContent: options.showContent ?? false,
  });
}

/** Run `index-repo` TWICE over the same options and compare the canonical output
 *  (`compareGenerations`) — the "validate deterministic output" acceptance line, as a library call
 *  rather than only a CLI flag so a test can exercise it directly. Returns `null` when either run
 *  refused (indexing off, no `force`) — nothing to compare. */
export async function checkIndexRepoDeterminism(options: IndexRepoOptions): Promise<DeterminismCheck | null> {
  const first = await runIndexRepo(options);
  if (!first) return null;
  const second = await runIndexRepo(options);
  if (!second) return null;
  return compareGenerations(first.result, second.result);
}
