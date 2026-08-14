import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadProjectConfig } from "../config.js";
import { detectRepository } from "../vcs/detect.js";
import { checkoutIdentity, stableDigest } from "./identity.js";
import type { CatalogIssue, RepositoryCheckout } from "./types.js";

const ignored = new Set([
  ".git",
  ".hg",
  ".svn",
  ".noriq",
  "node_modules",
  "dist",
  "build",
  "target",
  "Binaries",
  "DerivedDataCache",
  "Intermediate",
  "Saved",
]);

async function file(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function candidates(root: string, maxDepth: number): Promise<string[]> {
  const paths: string[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    const local = [
      join(directory, ".noriq", "project.toml"),
      join(directory, "project.toml"),
    ];
    const found: string[] = [];
    for (const candidate of local)
      if (await file(candidate)) found.push(candidate);
    if (found.length > 0) {
      paths.push(found[0]!);
      return;
    }
    if (depth >= maxDepth) return;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        ignored.has(entry.name)
      )
        continue;
      if (entry.name.startsWith(".") && entry.name !== ".noriq") continue;
      await walk(join(directory, entry.name), depth + 1);
    }
  };
  await walk(await realpath(root), 0);
  return paths;
}

export async function scanRepositories(
  scanRoots: string[],
  maxDepth = 6,
): Promise<{ checkouts: RepositoryCheckout[]; issues: CatalogIssue[] }> {
  const byCheckout = new Map<string, RepositoryCheckout>();
  const issues: CatalogIssue[] = [];
  for (const configuredRoot of scanRoots) {
    let found: string[];
    try {
      found = await candidates(configuredRoot, maxDepth);
    } catch (error) {
      issues.push({
        root: configuredRoot,
        configPath: null,
        code: "scan_failed",
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    for (const configPath of found) {
      try {
        const config = await loadProjectConfig(configPath);
        const detected = await detectRepository(dirname(configPath));
        const repository = await realpath(detected.root);
        const checkoutId = await checkoutIdentity(repository);
        if (byCheckout.has(checkoutId)) continue;
        byCheckout.set(checkoutId, {
          checkoutId,
          repository,
          vcs: detected.kind,
          vcsReason: detected.reason,
          configPath,
          config,
          configDigest: stableDigest(config),
        });
      } catch (error) {
        issues.push({
          root: configuredRoot,
          configPath,
          code: "invalid_config",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return {
    checkouts: [...byCheckout.values()],
    issues,
  };
}

export async function reloadCheckout(
  checkout: RepositoryCheckout,
): Promise<RepositoryCheckout> {
  const config = await loadProjectConfig(checkout.configPath);
  const detected = await detectRepository(dirname(checkout.configPath));
  const repository = await realpath(detected.root);
  const checkoutId = await checkoutIdentity(repository);
  if (checkoutId !== checkout.checkoutId)
    throw new Error(
      "repository checkout identity changed since catalog advertisement",
    );
  return {
    checkoutId,
    repository,
    vcs: detected.kind,
    vcsReason: detected.reason,
    configPath: checkout.configPath,
    config,
    configDigest: stableDigest(config),
  };
}
