import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { ProjectManifest } from '@noriq-dev/shared';
import { parse as parseToml } from 'smol-toml';

/** A repo the daemon discovered under a scan root (has a .noriq/project.toml). */
export interface DiscoveredRepo {
  /** Stable per absolute root path — the RunnerRepo id the server keys dispatch on. */
  id: string;
  root: string;
  projectKey: string;
  name: string;
  defaultBranch: string | null;
  manifest: ProjectManifest;
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

async function readManifest(markerPath: string): Promise<ProjectManifest | null> {
  try {
    const raw = parseToml(await readFile(markerPath, 'utf8'));
    const parsed = ProjectManifest.safeParse(raw);
    return parsed.success ? parsed.data : null; // invalid marker → skip
  } catch {
    return null;
  }
}

/** Read + validate a repo's committed manifest off disk. null = absent or invalid.
 *  Exported so callers can re-read it without re-walking every scan root. */
export const loadManifest = (root: string): Promise<ProjectManifest | null> =>
  readManifest(manifestPath(root));

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
      const manifest = await readManifest(marker);
      if (manifest) {
        const root = path.resolve(dir);
        found.set(root, {
          id: repoId(root),
          root,
          projectKey: manifest.key,
          name: path.basename(root),
          defaultBranch: await gitDefaultBranch(root),
          manifest,
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
