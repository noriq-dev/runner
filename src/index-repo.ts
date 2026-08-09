import { execFileSync } from 'node:child_process';
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
  const result = await runIndexer(source, resolved.config, target, {
    adapters: registry,
    now: options.now,
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
