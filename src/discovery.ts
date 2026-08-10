import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { ProjectManifest } from '@noriq-dev/shared';
import { parse as parseToml } from 'smol-toml';
import { type ResolvedIndexConfig, resolveIndexConfig } from './index-policy';
import { logger as defaultLogger } from './logger';
import { parseRepositoryKey } from './memory-contract';

/** A repo the daemon discovered under a scan root (has a .noriq/project.toml). */
export interface DiscoveredRepo {
  /** Stable per absolute root path — the RunnerRepo id the server keys dispatch on. */
  id: string;
  root: string;
  projectKey: string;
  name: string;
  defaultBranch: string | null;
  manifest: ProjectManifest;
  /**
   * The committed, project-local canonical repository key (Project Memory §6, RUN-208) —
   * VALIDATED with `parseRepositoryKey`, distinct from `id` above (`repoId()`/`RunnerRepo.id`
   * are untouched — this is an additional, independent field, never a replacement). Null when
   * the manifest names none, or when the committed value is malformed: a bad key is a VISIBLE
   * association failure (logged at `error`, Project Memory §4), never silently rebound to
   * `projectKey`, `name`, or `repoId()`. A snapshot at discovery time — `repoReport`
   * (registration.ts) re-validates from whatever manifest it is handed, fresh, per report.
   */
  repositoryKey: string | null;
  /**
   * The resolved repository-indexing EXECUTION policy (RUN-208, `index-policy.ts`) — merges the
   * vendored `IndexSpec` (`enabled`/`include`/`exclude`) with this daemon's own knobs. Null when
   * indexing is off, or the committed `[index]` policy is invalid (logged, never fatal to
   * discovery). Snapshotted here for convenience at daemon start; RUN-209's actual indexer must
   * re-read via `loadIndexConfig` below per run — this field is never the re-read authority.
   */
  indexConfig: ResolvedIndexConfig | null;
}

// Directories never worth descending into when hunting for markers.
const IGNORE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  'target',
  '.cache',
  'coverage',
  'vendor',
]);

/** Deterministic RunnerRepo id for a repo root (survives restarts + reconnects). */
export function repoId(root: string): string {
  return `repo_${createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 12)}`;
}

/** The committed marker's path for a repo root. */
export const manifestPath = (root: string): string => path.join(root, '.noriq', 'project.toml');

/**
 * Kinds whose committed profile still declares the REMOVED `network` key (RUN-88).
 *
 * Reads the RAW parsed TOML, because by the time zod is done the evidence is gone: the key was
 * deleted from `PermissionProfile`, and zod strips unknowns rather than rejecting. That strip is
 * what keeps every pre-RUN-88 repo dispatchable — but on its own it makes the file WORSE than
 * before. `network = "none"` sits committed in the manifest, reading to anyone who opens it like
 * a firewall, while the daemon hands the agent its own full egress and says nothing. The key
 * being unenforced was RUN-88's bug; the key being unenforced AND unmentioned is that same bug
 * with the evidence removed. Silence is not compatibility.
 *
 * Exported (and pure) so the detection is testable without a daemon or an fs.
 */
export function legacyNetworkKinds(raw: unknown): string[] {
  const perms = (raw as { permissions?: unknown } | null | undefined)?.permissions;
  if (!perms || typeof perms !== 'object') return [];
  return Object.entries(perms as Record<string, unknown>)
    .filter(([, profile]) => profile !== null && typeof profile === 'object' && 'network' in profile)
    .map(([kind]) => kind);
}

/** The parsed marker, before AND after the zod parse — `raw` is the hook every RAW-table reader
 *  (legacy `network` detection, and RUN-208's `[index]` execution policy) needs, since by the
 *  time zod is done stripping unknown keys the evidence of a typo is already gone. */
interface ParsedMarker {
  raw: unknown;
  manifest: ProjectManifest;
}

/**
 * Neutralize a malformed `repositoryKey` BEFORE the zod parse, or the whole marker fails to
 * validate (RUN-208, decision 6). The vendored `ProjectManifest.repositoryKey` is
 * `RepositoryKey.nullable()` — a strict field, not a `.catch()` — so a committed value that fails
 * `parseRepositoryKey` would otherwise take `ProjectManifest.safeParse` down for the WHOLE
 * marker, exactly the "one typo skips the whole dispatch path" failure decision 5 refuses for
 * `[index]`. This is the same shape, one field over: log the visible association failure here,
 * then rewrite the raw value to null so the rest of the marker still parses and the repo stays
 * discovered — `parsed.data.repositoryKey` coming out the other side is therefore always either a
 * validated key or null, never a string `parseRepositoryKey` would refuse.
 */
function sanitizeRepositoryKey(
  raw: unknown,
  markerPath: string,
  log: Pick<typeof defaultLogger, 'error'>,
): unknown {
  const table = raw as { repositoryKey?: unknown } | null;
  const rawKey = table?.repositoryKey;
  if (typeof rawKey !== 'string' || rawKey.length === 0) return raw; // absent/null — nothing to sanitize
  const result = parseRepositoryKey(rawKey);
  if (result.ok) return raw; // valid — passes through unchanged
  log.error('project.toml repositoryKey is malformed — this repo has no canonical repository identity', {
    marker: markerPath,
    repositoryKey: rawKey,
    reason: result.reason,
  });
  return { ...(raw as Record<string, unknown>), repositoryKey: null };
}

async function readMarker(
  markerPath: string,
  log: Pick<typeof defaultLogger, 'warn' | 'error'> = defaultLogger,
): Promise<ParsedMarker | null> {
  try {
    const raw = parseToml(await readFile(markerPath, 'utf8'));
    const parsed = ProjectManifest.safeParse(sanitizeRepositoryKey(raw, markerPath, log));
    if (!parsed.success) return null; // invalid marker → skip
    // Say the quiet part, every read. A manifest is re-read per Run (see ManifestStore), so this
    // fires at the moment it matters: right before an agent is spawned with egress the committed
    // file claims it does not have. Noisy by design and self-limiting — delete the key and it
    // stops. A one-shot warning at daemon start would be missed by whoever reads the run log.
    const stale = legacyNetworkKinds(raw);
    if (stale.length) {
      log.warn(
        'project.toml still declares `network` — that key was REMOVED (RUN-88) and is ignored: ' +
          "these agents get this daemon's full network egress regardless of what it says. If a run " +
          'must not reach the network, isolate the box — the file cannot do it. Delete the key.',
        { marker: markerPath, kinds: stale },
      );
    }
    // `raw` here is the ORIGINAL (pre-sanitize) table — index policy parsing (loadIndexConfig)
    // does not care about repositoryKey, and every other raw-table reader wants the real bytes.
    return { raw, manifest: parsed.data };
  } catch {
    return null;
  }
}

async function readManifest(
  markerPath: string,
  log: Pick<typeof defaultLogger, 'warn' | 'error'> = defaultLogger,
): Promise<ProjectManifest | null> {
  return (await readMarker(markerPath, log))?.manifest ?? null;
}

/** Read + validate a repo's committed manifest off disk. null = absent or invalid.
 *  Exported so callers can re-read it without re-walking every scan root. The logger is
 *  injectable for tests; everything else on this path takes the module's own. */
export const loadManifest = (
  root: string,
  log: Pick<typeof defaultLogger, 'warn' | 'error'> = defaultLogger,
): Promise<ProjectManifest | null> => readManifest(manifestPath(root), log);

/**
 * The resolved `[index]` execution policy, re-read fresh off disk on every call (RUN-208) — the
 * same "no restart needed" contract `ManifestStore` gives the rest of the marker. RUN-209's
 * actual indexer is the intended per-run caller; `discoverRepos` below also calls this once at
 * startup to seed `DiscoveredRepo.indexConfig`, but that snapshot is convenience only — editing
 * `[index]` takes effect the next time THIS function is called, not the next daemon restart.
 */
export async function loadIndexConfig(
  root: string,
  log: Pick<typeof defaultLogger, 'warn' | 'error'> = defaultLogger,
): Promise<ResolvedIndexConfig | null> {
  const parsed = await readMarker(manifestPath(root), log);
  if (!parsed) return null;
  const rawIndex = (parsed.raw as { index?: unknown } | null)?.index;
  return resolveIndexConfig(parsed.manifest.index, rawIndex, log);
}

/** Best-effort default branch from .git/HEAD (no git subprocess). */
async function gitDefaultBranch(root: string): Promise<string | null> {
  try {
    const head = await readFile(path.join(root, '.git', 'HEAD'), 'utf8');
    const m = head.match(/ref:\s*refs\/heads\/(.+?)\s*$/);
    return m?.[1] ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Walk the scan roots for .noriq/project.toml markers and self-populate the repo
 * set the daemon registers. Add a repo = drop a marker; there is no central list.
 * Nested markers (monorepos) are found too. Invalid markers are skipped (the
 * caller logs the count). Results are deduped by root and sorted for stability.
 */
export async function discoverRepos(
  scanRoots: string[],
  opts: { maxDepth?: number } = {},
): Promise<DiscoveredRepo[]> {
  const maxDepth = opts.maxDepth ?? 6;
  const found = new Map<string, DiscoveredRepo>();

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const marker = path.join(dir, '.noriq', 'project.toml');
    if (existsSync(marker)) {
      const parsed = await readMarker(marker);
      if (parsed) {
        const { manifest, raw } = parsed;
        const root = path.resolve(dir);
        const rawIndex = (raw as { index?: unknown } | null)?.index;
        found.set(root, {
          id: repoId(root),
          root,
          projectKey: manifest.key,
          name: path.basename(root),
          defaultBranch: await gitDefaultBranch(root),
          manifest,
          // Already sanitized by readMarker (a malformed value never survives the zod parse
          // above) — a straight copy, not a second validation, per decision 8.
          repositoryKey: manifest.repositoryKey,
          indexConfig: resolveIndexConfig(manifest.index, rawIndex),
        });
      }
    }
    // unreadable dir (permissions) → skip
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) return;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      await walk(path.join(dir, e.name), depth + 1);
    }
  }

  for (const root of scanRoots) await walk(path.resolve(root), 0);
  return [...found.values()].sort((a, b) => a.root.localeCompare(b.root));
}
