import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { authorize } from './auth';
import { DEFAULT_CONFIG_PATH, expandHome } from './config';
import { DEFAULT_CREDENTIALS_PATH } from './credentials';
import { discoverRepos } from './discovery';
import { discover } from './oauth';
import { detectTools } from './tools';

/**
 * `noriq-runner init` — the guided setup (RUN-40).
 *
 * A new user hit two cliffs, each only revealing the next: `start` → "no runner config"; write
 * the TOML by hand → `start` → "no Noriq token". Both messages are good. The SEQUENCE was the
 * problem, and hand-editing config before anything validates it means a typo'd server URL isn't
 * caught until auth fails, pointing at the wrong thing.
 *
 * Three rules this follows, in order of how much they matter:
 *
 *  1. **Validate before writing.** The server is checked with a real discovery fetch before the
 *     file is created, so a bad URL fails in a second instead of leaving broken config on disk.
 *  2. **Never clobber.** Re-running must not eat a tuned runner.toml.
 *  3. **Show what it found.** Discovery output is the highest-value moment in onboarding: it is
 *     where someone learns their scanRoots are wrong ("found 0 repos") BEFORE they ever
 *     dispatch, rather than wondering later why nothing is dispatchable.
 *
 * Why this is not `start --interactive`: `start` runs under systemd, nohup and CI, where a
 * prompt on stdin is a hang, not a question. Keeping `start` non-interactive and loud, and
 * putting the hand-holding in a command that is explicitly interactive, is the honest split.
 */

export interface InitDeps {
  /** Injectable for tests — defaults to real prompting over stdin/stdout. */
  ask?: (question: string, fallback?: string) => Promise<string>;
  out?: (line: string) => void;
  configPath?: string;
  /** Injectable so tests never hit the network or a browser. */
  verifyServer?: (server: string) => Promise<void>;
  runAuthorize?: (server: string) => Promise<{ expiresAt: string | null }>;
  findRepos?: (scanRoots: string[]) => Promise<Array<{ name: string; projectKey: string; root: string }>>;
  /** Skip the auth step (already authorized, or the caller wants config only). */
  skipAuth?: boolean;
}

export interface InitResult {
  configPath: string;
  wroteConfig: boolean;
  authorized: boolean;
  reposFound: number;
}

/** A default label a human will recognize in the Runners panel: their machine's name. */
export const defaultLabel = (hostname: string = os.hostname()): string =>
  hostname
    .split('.')[0]
    ?.toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 40) || 'my-runner';

/**
 * Escape a value for a TOML basic (double-quoted) string.
 *
 * The backslash is the load-bearing one (RUN-42). TOML basic strings treat `\` as an escape
 * introducer, so an unescaped Windows path does not merely look odd — it makes the file
 * UNPARSEABLE: `C:\Users\…` reads `\U` as a unicode escape and dies with "invalid non-hex
 * character in unicode escape". `noriq init` therefore wrote a runner.toml the daemon then
 * refused to start with, on the exact first run of the exact command that exists so a stranger
 * can get started. Found by the windows-latest CI leg.
 *
 * Order matters: backslashes FIRST, or the escaping of `"` gets re-escaped.
 */
export const tomlString = (v: string): string =>
  `"${v
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    // TOML forbids raw control characters in basic strings; a tab is plausible in a path on a
    // bad day, and the rest cost nothing to handle correctly.
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')}"`;

/** Serialize a RunnerConfig to TOML by hand — a whole encoder dependency to emit six keys would
 *  be silly, and the shape is fixed. Comments are the point: this file is meant to be edited. */
export function renderConfig(cfg: {
  label: string;
  server: string;
  scanRoots: string[];
  concurrency: number;
}): string {
  const roots = cfg.scanRoots.map(tomlString).join(', ');
  return `# Noriq Runner — machine-local config, written by \`noriq-runner init\`.
# Never commit this file. Edit freely; the daemon re-reads it on start.

# Shown in the dashboard's Runners panel.
label = ${tomlString(cfg.label)}

# The Noriq server this runner dials.
server = ${tomlString(cfg.server)}

# Directories walked to find repos. A repo opts in by committing .noriq/project.toml —
# there is no central list, so adding a repo means dropping a marker in it.
scanRoots = [${roots}]

# Max concurrent Runs on this machine.
concurrency = ${cfg.concurrency}

# Default ceilings for Runs dispatched without their own. Uncomment to bound spend:
# a Run with no budget anywhere runs unbounded — no token, USD, or wall-clock limit.
[budget]
# maxTokens = 500000
# maxUsd = 5
# maxDurationSeconds = 1800
`;
}

export async function runInit(deps: InitDeps = {}): Promise<InitResult> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const configPath = deps.configPath ?? DEFAULT_CONFIG_PATH;

  // This command is interactive by construction, so demand a terminal — and demand it BEFORE
  // printing a banner that implies something is happening.
  //
  // Found by running it rather than testing it: piped or under CI, readline hits EOF, the
  // pending question() never settles, the event loop empties, and node exits **0** having asked
  // a question nobody could answer and written nothing. A setup command that silently succeeds
  // while doing nothing is worse than one that fails. The tests inject `ask`, so they sail past
  // the real readline path entirely — which is exactly how this survived.
  if (!deps.ask && !process.stdin.isTTY) {
    throw new Error(
      'init is interactive and needs a terminal — run it in a shell, or configure by hand: ' +
        'copy runner.toml.example to ~/.noriq/runner.toml, then `noriq-runner auth` (device flow works headless).',
    );
  }

  const rl = deps.ask ? null : createInterface({ input: process.stdin, output: process.stdout });
  // A pending question when stdin closes (Ctrl-D) resolves to undefined and would otherwise
  // hang forever — surface it as the abort it is.
  let closed = false;
  rl?.once('close', () => {
    closed = true;
  });
  const ask =
    deps.ask ??
    (async (question: string, fallback?: string) => {
      const suffix = fallback ? ` [${fallback}]` : '';
      const answer = await rl!.question(`${question}${suffix}: `);
      if (closed && answer === undefined)
        throw new Error('input closed — setup aborted, nothing was written');
      return (answer ?? '').trim() || fallback || '';
    });

  try {
    out('');
    out('  Noriq Runner setup');
    out('  ──────────────────');
    out('');

    // Rule 2, checked FIRST: finding out we would clobber after asking four questions wastes
    // the human's time and risks them answering "y" out of momentum.
    let wroteConfig = false;
    if (existsSync(configPath)) {
      out(`  A config already exists at ${configPath}.`);
      const overwrite = (await ask('  Overwrite it? (y/N)', 'N')).toLowerCase();
      if (overwrite !== 'y' && overwrite !== 'yes') {
        out('  Keeping it. Skipping to authorization.');
        out('');
      } else {
        wroteConfig = true;
      }
    } else {
      wroteConfig = true;
    }

    if (wroteConfig) {
      const label = await ask('  Label for this machine', defaultLabel());
      const server = normalizeServer(await ask('  Noriq server URL', 'https://noriq.example'));

      // Rule 1: prove the server is real BEFORE writing anything. This is one round-trip and it
      // turns "auth mysteriously failed" into "that URL isn't a Noriq server".
      out('');
      out(`  Checking ${server} …`);
      const verify = deps.verifyServer ?? (async (s: string) => void (await discover(s)));
      try {
        await verify(server);
        out('  ✓ reachable, and it speaks OAuth');
      } catch (err) {
        out(`  ✗ could not reach a Noriq server at ${server}`);
        out(`    ${(err as Error).message}`);
        out('');
        out('  Nothing was written. Fix the URL and run `noriq-runner init` again.');
        return { configPath, wroteConfig: false, authorized: false, reposFound: 0 };
      }

      out('');
      const rootsAnswer = await ask(
        '  Where are your repos? (comma-separated)',
        path.join(os.homedir(), 'code'),
      );
      const scanRoots = rootsAnswer
        .split(',')
        .map((r) => path.resolve(expandHome(r.trim())))
        .filter(Boolean);
      const concurrency = Number.parseInt(await ask('  Max concurrent runs', '2'), 10) || 1;

      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, renderConfig({ label, server, scanRoots, concurrency }), 'utf8');
      out('');
      out(`  ✓ wrote ${configPath}`);
    }

    // Auth. Reuses the same authorize() as `noriq-runner auth` — loopback when there's a
    // browser, device flow when there isn't. No second implementation to drift.
    let authorized = false;
    if (!deps.skipAuth) {
      const { config } = await loadForAuth(configPath);
      out('');
      out('  Authorizing this runner…');
      out('  You will be asked which projects it may reach — it will not see the others.');
      out('');
      const run = deps.runAuthorize ?? (async (s: string) => authorize({ server: s, out }));
      try {
        await run(config.server);
        authorized = true;
        out('');
        out(`  ✓ authorized — credentials in ${DEFAULT_CREDENTIALS_PATH}`);
      } catch (err) {
        out(`  ✗ authorization failed: ${(err as Error).message}`);
        out('    The config is written, so just run `noriq-runner auth` when ready.');
      }
    }

    // Rule 3. This is where someone learns their scanRoots are wrong — before dispatching,
    // not after wondering why the dashboard shows nothing.
    const { config } = await loadForAuth(configPath);
    const find = deps.findRepos ?? ((roots: string[]) => discoverRepos(roots));
    const repos = await find(config.scanRoots);
    out('');
    if (repos.length) {
      out(`  Found ${repos.length} repo${repos.length === 1 ? '' : 's'}:`);
      for (const r of repos) out(`    ${r.name} → ${r.projectKey}   (${r.root})`);
    } else {
      out('  Found no repos under:');
      for (const r of config.scanRoots) out(`    ${r}`);
      out('');
      out('  A repo opts in by committing .noriq/project.toml — see project.toml.example.');
      out('  Nothing can be dispatched here until at least one exists.');
    }

    const tools = detectTools();
    out('');
    out(`  Drivers detected: ${tools.length ? tools.join(', ') : 'none — install claude or codex'}`);
    out('');
    out(
      authorized || deps.skipAuth
        ? '  Ready. Start it with:  noriq-runner start'
        : '  Next:  noriq-runner auth',
    );
    out('');
    return { configPath, wroteConfig, authorized, reposFound: repos.length };
  } finally {
    rl?.close();
  }
}

/** Accept what a human types: bare host, trailing slash, missing scheme. */
export function normalizeServer(input: string): string {
  const raw = input.trim().replace(/\/+$/, '');
  if (!raw) return raw;
  return /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
}

/** Read back what we just wrote (or what was already there) so auth and discovery use the
 *  file's values, not the in-memory answers — if the file says something different, that is
 *  what `start` will use, and init should be showing the same truth. */
async function loadForAuth(configPath: string) {
  const { loadRunnerConfig } = await import('./config');
  return loadRunnerConfig(configPath);
}
