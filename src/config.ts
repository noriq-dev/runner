import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunnerConfig } from '@noriq-dev/shared';
import { parse as parseToml } from 'smol-toml';

/** The machine config lives here by default (see @noriq-dev/shared manifest contract). */
export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.noriq', 'runner.toml');

/** Expand a leading ~ to the user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Parse + validate runner.toml text against the shared RunnerConfig contract.
 * Pure (no fs) so it is trivially testable. Throws a human-readable error that
 * names the offending field on invalid TOML or a schema violation. Scan roots are
 * ~-expanded and resolved to absolute paths for downstream discovery.
 */
export function parseRunnerConfig(text: string): RunnerConfig {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (err) {
    throw new Error(`runner.toml is not valid TOML: ${(err as Error).message}`);
  }
  const result = RunnerConfig.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`runner.toml failed validation:\n${issues}`);
  }
  const cfg = result.data;
  return { ...cfg, scanRoots: cfg.scanRoots.map((r) => path.resolve(expandHome(r))) };
}

/** Load + validate the machine config from disk (default: ~/.noriq/runner.toml). */
export async function loadRunnerConfig(
  configPath: string = DEFAULT_CONFIG_PATH,
): Promise<{ config: RunnerConfig; path: string }> {
  const resolved = expandHome(configPath);
  if (!existsSync(resolved)) {
    throw new Error(`no runner config at ${resolved} — create it (see README) or pass --config <path>`);
  }
  const text = await readFile(resolved, 'utf8');
  return { config: parseRunnerConfig(text), path: resolved };
}
