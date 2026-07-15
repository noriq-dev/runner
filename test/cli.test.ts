import { realpathSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invokedDirectly, run } from '../src/cli';
import { VERSION } from '../src/version';

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
