import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invokedDirectly, renderIndexStatusText, run, stopDaemonFailClosed } from '../src/cli';
import { COMMANDS } from '../src/completion';
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
  it('keeps first-signal shutdown fail-closed when daemon stop cannot prove quiescence', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await expect(
        stopDaemonFailClosed(async () => {
          throw new Error('process tree is still live');
        }),
      ).resolves.toBe(false);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

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
      grammarLoadCounts: { typescript: 1, javascript: 1, tsx: 1, cpp: 1, ini: 1 },
    });
    expect(report.grammars).toHaveLength(5);
    for (const g of report.grammars) expect(g.passed).toBe(true);
  });

  it('help lists index-repo and its options', async () => {
    expect(await run(['help'])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('index-repo');
    expect(text).toContain('--check-determinism');
  });

  it('help lists every RUN-223 command', async () => {
    expect(await run(['help'])).toBe(0);
    const text = out.join('\n');
    for (const cmd of [
      'index-status',
      'index-reindex',
      'index-retry',
      'index-cancel',
      'index-forget-journal',
    ]) {
      expect(text).toContain(cmd);
    }
  });

  // RUN-235: help and completion (test/completion.test.ts) are DERIVED from the same
  // `COMMAND_TABLE` — this is the direction drift would first show if a command were ever added
  // to one and not the other, so it asserts the derivation rather than a hand-picked subset.
  it('help lists every command in COMMANDS — the same table completion.ts derives from', async () => {
    expect(await run(['help'])).toBe(0);
    const text = out.join('\n');
    for (const cmd of COMMANDS) expect(text).toContain(cmd);
  });
});

// RUN-223. Every test below is chosen to never touch the operator's real ~/.noriq: the local-only
// checks (no opt-in, a missing repositoryKey, indexing off) all return before any file under
// ~/.noriq is read or written, and the "no live daemon" checks only ever READ
// ~/.noriq/index-control.json (harmless on a box with no runner daemon actually running, which is
// this suite's own assumption throughout — no other test here starts one either).
describe('index-status / index-reindex / index-retry / index-cancel / index-forget-journal (RUN-223)', () => {
  let dir: string;

  async function marker(body: string) {
    await mkdir(path.join(dir, '.noriq'), { recursive: true });
    await writeFile(path.join(dir, '.noriq', 'project.toml'), body);
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'noriq-cli-index-status-'));
    // Point the control-info lookup at a path inside THIS test's temp dir. Without it these tests
    // read the operator's real `~/.noriq/index-control.json`, so every "no live daemon" case here
    // passed or failed depending on whether a daemon happened to be running on the machine — which
    // is exactly how it was caught: they broke the first time this repo's own daemon was started
    // for a live index. A control file that does not exist is what "no daemon" means, so pointing
    // at a nonexistent path inside the temp dir IS the no-daemon fixture.
    process.env.NORIQ_INDEX_CONTROL_PATH = path.join(dir, 'index-control.json');
  });
  afterEach(async () => {
    process.env.NORIQ_INDEX_CONTROL_PATH = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it('index-status: a repo with no [index] table reports no-opt-in and exits 0 — answered locally', async () => {
    await marker('key = "ACME"\n');
    expect(await run(['index-status', '--path', dir])).toBe(0);
    expect(out.join('\n')).toContain('no-opt-in');
  });

  it('index-status --json: no-opt-in is the whole (machine-checkable) body', async () => {
    await marker('key = "ACME"\n');
    expect(await run(['index-status', '--path', dir, '--json'])).toBe(0);
    expect(JSON.parse(out.join('\n'))).toEqual({ state: 'no-opt-in' });
  });

  it('index-status: [index].enabled but no repositoryKey — exit 1, names the missing identity', async () => {
    await marker('key = "ACME"\n\n[index]\nenabled = true\n');
    expect(await run(['index-status', '--path', dir, '--server', 'https://noriq.test'])).toBe(1);
    expect(err.join('\n')).toMatch(/repositoryKey/);
  });

  it('index-status: enabled + a canonical repositoryKey, no live daemon — exit 0, state unknown, never a synthesized present tense', async () => {
    await marker('key = "ACME"\nrepositoryKey = "cli-test-repo-run223"\n\n[index]\nenabled = true\n');
    expect(await run(['index-status', '--path', dir, '--server', 'https://noriq.test'])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('cli-test-repo-run223');
    expect(text).toMatch(/no live daemon reachable|state: unknown/);
  });

  it('index-reindex: indexing OFF refuses locally, without ever asking a daemon', async () => {
    await marker('key = "ACME"\nrepositoryKey = "cli-test-repo-run223"\n');
    expect(await run(['index-reindex', '--path', dir, '--server', 'https://noriq.test'])).toBe(1);
    expect(err.join('\n')).toMatch(/OFF/);
  });

  it('index-retry: same local OFF refusal as index-reindex (locked decision 7 — one function, two names)', async () => {
    await marker('key = "ACME"\nrepositoryKey = "cli-test-repo-run223"\n');
    expect(await run(['index-retry', '--path', dir, '--server', 'https://noriq.test'])).toBe(1);
    expect(err.join('\n')).toMatch(/OFF/);
  });

  it('index-reindex: enabled, no live daemon — exit 1, plainly names the fix ("noriq-runner start")', async () => {
    await marker('key = "ACME"\nrepositoryKey = "cli-test-repo-run223"\n\n[index]\nenabled = true\n');
    expect(await run(['index-reindex', '--path', dir, '--server', 'https://noriq.test'])).toBe(1);
    expect(err.join('\n')).toMatch(/noriq-runner start/);
  });

  it('index-cancel: no repositoryKey at all — exit 1, nothing to look up', async () => {
    await marker('key = "ACME"\n');
    expect(await run(['index-cancel', '--path', dir])).toBe(1);
    expect(err.join('\n')).toMatch(/repositoryKey/);
  });

  it('index-cancel: a repositoryKey but no live daemon — exit 1, says so plainly', async () => {
    await marker('key = "ACME"\nrepositoryKey = "cli-test-repo-run223"\n');
    expect(await run(['index-cancel', '--path', dir])).toBe(1);
    expect(err.join('\n')).toMatch(/nothing to cancel/);
  });

  it('index-forget-journal: no repositoryKey — exit 1 before touching any local store', async () => {
    await marker('key = "ACME"\n');
    expect(await run(['index-forget-journal', '--path', dir])).toBe(1);
    expect(err.join('\n')).toMatch(/repositoryKey/);
  });
});

// RUN-223 round 2: `renderIndexStatusText` pulled out as a pure function precisely so this case
// (a `requiresUpgrade` record) is testable without a live daemon or a real ~/.noriq snapshot.
describe('renderIndexStatusText — the requiresUpgrade distinction is visible without reading detail', () => {
  it('an ordinary failed record renders with no [BLOCKED] marker', () => {
    const text = renderIndexStatusText({
      repositoryKey: 'my-repo',
      server: 'https://noriq.test',
      source: 'live daemon',
      record: {
        repositoryKey: 'my-repo',
        state: 'failed',
        stateSince: '2026-08-09T00:00:00.000Z',
        detail: 'index cursor unavailable — network blip',
        lastError: { message: 'network blip', at: '2026-08-09T00:00:00.000Z' },
        lastSuccess: null,
        indexerVersion: '1',
        requiresUpgrade: false,
      },
      trigger: null,
    });
    expect(text).toContain('state: failed');
    expect(text).not.toContain('BLOCKED');
  });

  it('a requiresUpgrade record renders an unmistakable marker on the state line itself', () => {
    const text = renderIndexStatusText({
      repositoryKey: 'my-repo',
      server: 'https://noriq.test',
      source: 'live daemon',
      record: {
        repositoryKey: 'my-repo',
        state: 'failed',
        stateSince: '2026-08-09T00:00:00.000Z',
        detail:
          'UPGRADE REQUIRED — active generation was built by indexer version 2, newer than this daemon’s 1',
        lastError: { message: 'upgrade required', at: '2026-08-09T00:00:00.000Z' },
        lastSuccess: null,
        indexerVersion: '1',
        requiresUpgrade: true,
      },
      trigger: null,
    });
    const stateLine = text.split('\n').find((l) => l.startsWith('state:'));
    expect(stateLine).toContain('BLOCKED');
    expect(stateLine).toContain('do not retry');
  });

  it('no observation at all renders "unknown" — never a synthesized present tense', () => {
    const text = renderIndexStatusText({
      repositoryKey: 'my-repo',
      server: 'https://noriq.test',
      source: 'no live daemon reachable (no-daemon) — showing the last local snapshot, if any',
      record: null,
      trigger: null,
    });
    expect(text).toContain('state: unknown');
  });

  // `staged` (uploaded and validated without an activation receipt) must not read as a runner
  // failure on the state line itself, the same "unmistakable without parsing detail" bar
  // `requiresUpgrade` already clears for `incompatible-version`.
  it('a staged record renders a server-confirmation recovery marker on the state line, distinct from BLOCKED', () => {
    const text = renderIndexStatusText({
      repositoryKey: 'my-repo',
      server: 'https://noriq.test',
      source: 'live daemon',
      record: {
        repositoryKey: 'my-repo',
        state: 'staged',
        stateSince: '2026-08-09T00:00:00.000Z',
        detail: 'uploaded, sealed and validated, but this server did not confirm activation.',
        lastError: null,
        lastSuccess: {
          at: '2026-08-09T00:00:00.000Z',
          generationId: 'gen_1',
          baseId: 'b1',
          batchesReceived: 2,
        },
        indexerVersion: '1',
        requiresUpgrade: false,
      },
      trigger: null,
    });
    const stateLine = text.split('\n').find((l) => l.startsWith('state:'));
    expect(stateLine).toContain('staged');
    expect(stateLine).toMatch(/server did not confirm activation/i);
    expect(stateLine).not.toContain('BLOCKED');
  });

  it('an active record (post-promotion) renders no marker at all', () => {
    const text = renderIndexStatusText({
      repositoryKey: 'my-repo',
      server: 'https://noriq.test',
      source: 'live daemon',
      record: {
        repositoryKey: 'my-repo',
        state: 'active',
        stateSince: '2026-08-09T00:00:00.000Z',
        detail: 'server confirms this base is active (generation gen_1)',
        lastError: null,
        lastSuccess: {
          at: '2026-08-09T00:00:00.000Z',
          generationId: 'gen_1',
          baseId: 'b1',
          batchesReceived: 2,
        },
        indexerVersion: '1',
        requiresUpgrade: false,
      },
      trigger: null,
    });
    const stateLine = text.split('\n').find((l) => l.startsWith('state:'));
    expect(stateLine).toBe('state: active');
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
