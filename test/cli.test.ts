import { realpathSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invokedDirectly, run } from '../src/cli';
import { VERSION } from '../src/version';
import { buildIndexRepoFixture } from './fixtures/index-repo-fixtures';

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((m?: unknown) => void out.push(String(m)));
  vi.spyOn(console, 'error').mockImplementation((m?: unknown) => void err.push(String(m)));
});
afterEach(() => vi.restoreAllMocks());

describe('cli', () => {
  it('version prints the version and exits 0', async () => {
    expect(await run(['version'])).toBe(0);
    expect(out.join('\n')).toContain(VERSION);
  });

  it('help (default) prints usage and exits 0', async () => {
    expect(await run([])).toBe(0);
    expect(out.join('\n')).toContain('Usage:');
  });

  it('an unknown command exits 2', async () => {
    expect(await run(['frobnicate'])).toBe(2);
  });

  it('an unknown option exits 2', async () => {
    expect(await run(['--nope'])).toBe(2);
  });

  it('start with a missing config fails gracefully (exit 1, no throw)', async () => {
    expect(await run(['start', '--config', '/no/such/runner.toml'])).toBe(1);
    expect(err.join('\n')).toMatch(/no runner config/);
  });

  it('index-selftest parses a snippet through every grammar and exits 0 (RUN-216)', async () => {
    expect(await run(['index-selftest'])).toBe(0);
    const report = JSON.parse(out.join('\n'));
    expect(report.ok).toBe(true);
    expect(report.runtime).toEqual({
      initCount: 1,
      grammarLoadCounts: { typescript: 1, javascript: 1, tsx: 1 },
    });
    expect(report.grammars).toHaveLength(3);
    for (const g of report.grammars) expect(g.passed).toBe(true);
  });

  it('help lists index-repo and its options', async () => {
    expect(await run(['help'])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('index-repo');
    expect(text).toContain('--check-determinism');
  });
});

describe('index-repo (RUN-219)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'noriq-cli-index-repo-'));
    await buildIndexRepoFixture(dir);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('refuses without [index].enabled and without --force — exit 1, names the flag', async () => {
    expect(await run(['index-repo', '--path', dir])).toBe(1);
    expect(err.join('\n')).toMatch(/--force/);
  });

  it('--force indexes a repo with no manifest at all, prints a summary, and exits 0', async () => {
    expect(await run(['index-repo', '--path', dir, '--force'])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('index-repo');
    expect(text).toContain('entities');
    expect(err.join('\n')).toMatch(/--force stepped past/);
  });

  it('--force --json prints a parseable, bounded report', async () => {
    expect(await run(['index-repo', '--path', dir, '--force', '--json', '--limit', '2'])).toBe(0);
    const report = JSON.parse(out.join('\n'));
    expect(report.entities.shown.length).toBeLessThanOrEqual(2);
    expect(typeof report.generation.generationId).toBe('string');
    expect(report.configSource).toBe('forced-default');
  });

  it('--check-determinism reports PASS for an unchanged fixture tree', async () => {
    expect(await run(['index-repo', '--path', dir, '--force', '--check-determinism'])).toBe(0);
    expect(out.join('\n')).toMatch(/PASS/);
  });

  it('--check-determinism --json is machine-parseable', async () => {
    expect(await run(['index-repo', '--path', dir, '--force', '--check-determinism', '--json'])).toBe(0);
    const check = JSON.parse(out.join('\n'));
    expect(check).toEqual({ ok: true, mismatches: [] });
  });

  it('a real secret-shaped value never reaches stdout under --show-content', async () => {
    const secret = 'ghp_ThisIsAFakeButShapedGithubToken0123456';
    await writeFile(path.join(dir, 'secret.ts'), `export function leaky() { return "${secret}"; }\n`);
    expect(await run(['index-repo', '--path', dir, '--force', '--show-content', '--limit', '1000'])).toBe(0);
    expect(out.join('\n')).not.toContain(secret);
  });

  it('an unknown --limit value is a usage error (exit 2)', async () => {
    expect(await run(['index-repo', '--path', dir, '--force', '--limit', 'nope'])).toBe(2);
  });
});

// Every test above calls run() directly — which is precisely why v0.2.0 shipped a binary that
// printed nothing and exited 0 for every command. The suite proved the CLI's behaviour and
// never proved it was reachable. These tests cover the ONE line that decides that.
describe('invokedDirectly — the entry guard', () => {
  let dir: string;
  let real: string;
  let metaUrl: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'noriq-cli-'));
    real = path.join(dir, 'cli.js');
    await writeFile(real, '');
    // The tmpdir itself may sit behind a symlink (/tmp, or macOS /var → /private/var), which is
    // the very thing under test — so resolve it the way node resolves a module URL.
    metaUrl = pathToFileURL(realpathSync(real)).href;
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('true when invoked through a symlink — how EVERY global npm install runs', async () => {
    const link = path.join(dir, 'noriq-runner');
    await symlink(real, link);
    expect(invokedDirectly(metaUrl, link)).toBe(true);
  });

  it('true when invoked by its real path', () => {
    expect(invokedDirectly(metaUrl, real)).toBe(true);
  });

  it('false for another script — a test importing run() must not spawn the CLI', async () => {
    const other = path.join(dir, 'vitest.js');
    await writeFile(other, '');
    expect(invokedDirectly(metaUrl, other)).toBe(false);
  });

  it('false with no argv[1] (node -e, a REPL) rather than throwing', () => {
    expect(invokedDirectly(metaUrl, undefined)).toBe(false);
  });

  it('false when argv[1] names nothing on disk rather than throwing', () => {
    expect(invokedDirectly(metaUrl, path.join(dir, 'gone'))).toBe(false);
  });
});
