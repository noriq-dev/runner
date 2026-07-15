#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { type AuthMode, authorize, resolveMode } from './auth';
import { DEFAULT_CONFIG_PATH, loadRunnerConfig } from './config';
import { DEFAULT_CREDENTIALS_PATH } from './credentials';
import { Daemon } from './daemon';
import { discoverRepos } from './discovery';
import { runInit } from './init';
import { logger, setLogLevel } from './logger';
import { TokenSource } from './token';
import { checkForUpdate, updateAdvice } from './update';
import { VERSION } from './version';

const HELP = `noriq-runner v${VERSION} — Noriq's local execution-plane daemon

Usage:
  noriq-runner <command> [options]

Commands:
  init             Guided setup: config + authorization, then show what it found
  update           Check whether this runner is behind (it will not replace itself)
  auth             Authorize this machine with Noriq and store its token
  start            Discover repos, register with Noriq, and supervise dispatched runs
  discover         Scan roots for .noriq/project.toml markers and list found repos
  config           Load, validate, and print the resolved machine config
  version          Print the version
  help             Print this help

Options:
  --config <path>  Path to runner.toml (default: ${DEFAULT_CONFIG_PATH})
  --log-level <l>  debug | info | warn | error (default: info)

auth options:
  --server <url>   Noriq server to authorize against (default: the config's server)
  --browser        Force the browser flow (loopback + PKCE)
  --device         Force the device-code flow — for a box with no browser (SSH, CI)

Environment:
  NORIQ_TOKEN      A token to use as-is; overrides the stored credentials.
  NORIQ_NO_BROWSER Set to force the device flow, as --device does.
  NORIQ_LOG_LEVEL  Same as --log-level.
`;

interface ParsedArgs {
  command: string;
  configPath?: string;
  logLevel?: string;
  server?: string;
  authMode: AuthMode;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let configPath: string | undefined;
  let logLevel: string | undefined;
  let server: string | undefined;
  let authMode: AuthMode = 'auto';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config') configPath = argv[++i];
    else if (arg === '--log-level') logLevel = argv[++i];
    else if (arg === '--server') server = argv[++i];
    else if (arg === '--device') authMode = 'device';
    else if (arg === '--browser') authMode = 'browser';
    else if (arg === '--version' || arg === '-v') positional.push('version');
    else if (arg === '--help' || arg === '-h') positional.push('help');
    else if (arg?.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else if (arg) positional.push(arg);
  }
  return { command: positional[0] ?? 'help', configPath, logLevel, server, authMode };
}

/** The server to talk to: --server wins, else the machine config's. */
async function resolveServer(args: ParsedArgs): Promise<string> {
  if (args.server) return args.server;
  try {
    const { config } = await loadRunnerConfig(args.configPath ?? DEFAULT_CONFIG_PATH);
    return config.server;
  } catch (err) {
    throw new Error(
      `no --server given and the config could not be read (${(err as Error).message}) — pass --server <url> or create ~/.noriq/runner.toml`,
    );
  }
}

async function cmdAuth(args: ParsedArgs): Promise<void> {
  const server = await resolveServer(args);
  const mode = resolveMode(args.authMode, process.env, process.platform);
  if (args.authMode === 'auto' && mode === 'device') {
    logger.info('no browser on this box — using the device flow (--browser to override)');
  }
  const creds = await authorize({ server, mode: args.authMode, out: (line) => console.log(line) });
  logger.info('authorized', {
    server,
    credentials: DEFAULT_CREDENTIALS_PATH,
    expiresAt: creds.expiresAt,
    refreshable: Boolean(creds.refreshToken),
  });
  console.log('\n✓ this runner is authorized — run `noriq-runner start`');
}

/**
 * Check, report, and tell the human what to run — explicitly NOT a self-replace.
 *
 * Reads the runner's own public repo directly; Noriq is not in this path (it does not build or
 * publish the runner, so it has no authority over the number).
 *
 * Exit code carries the answer so a script can use it: 0 current, 1 behind. An `update` that
 * silently exits 0 while you are three releases back is the sort of thing nobody notices.
 */
async function cmdUpdate(): Promise<number> {
  const check = await checkForUpdate();
  console.log(updateAdvice(check));
  if (check.latest == null) {
    logger.warn('could not reach the version feed — assuming nothing');
    return 0; // unable to check is NOT out of date
  }
  return check.behind ? 1 : 0;
}

async function cmdConfig(configPath?: string): Promise<void> {
  const { config, path } = await loadRunnerConfig(configPath ?? DEFAULT_CONFIG_PATH);
  logger.info('loaded runner config', { path });
  console.log(JSON.stringify(config, null, 2));
}

async function cmdDiscover(configPath?: string): Promise<void> {
  const { config } = await loadRunnerConfig(configPath ?? DEFAULT_CONFIG_PATH);
  const repos = await discoverRepos(config.scanRoots);
  logger.info(`discovered ${repos.length} repo(s) under ${config.scanRoots.length} scan root(s)`);
  console.log(
    JSON.stringify(
      repos.map((r) => ({
        id: r.id,
        projectKey: r.projectKey,
        name: r.name,
        root: r.root,
        defaultBranch: r.defaultBranch,
      })),
      null,
      2,
    ),
  );
}

async function cmdStart(configPath?: string): Promise<void> {
  const { config } = await loadRunnerConfig(configPath ?? DEFAULT_CONFIG_PATH);
  logger.info('runner starting', {
    label: config.label,
    server: config.server,
    scanRoots: config.scanRoots,
    concurrency: config.concurrency,
  });

  // TokenSource (not a bare read) so a daemon that outlives the 7-day access TTL
  // refreshes itself instead of silently dropping offline.
  const tokens = new TokenSource({ server: config.server });
  const daemon = new Daemon(config, tokens);
  const handle = await daemon.start();

  // Long-lived: the WS connection + heartbeat keep the event loop alive. Stop
  // cleanly on signals. Process supervision on run.assigned lands in RUN-12+.
  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) {
      // Second signal: the operator is insisting. Go now, orphans and all.
      logger.warn(`received ${sig} again — exiting immediately`);
      process.exit(1);
    }
    shuttingDown = true;
    logger.info(`received ${sig} — stopping live runs, then shutting down`);
    // MUST await: exiting first orphans every spawned agent, which keeps burning tokens
    // against the worktree with no budget enforcer left alive to stop it.
    await handle.stop().catch((err) => logger.warn('shutdown had trouble', { err: String(err) }));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  logger.info('runner online — waiting for dispatches (Ctrl-C to stop)', { runnerId: handle.runnerId });
}

export async function run(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    logger.error((err as Error).message);
    console.log(`\n${HELP}`);
    return 2;
  }
  if (args.logLevel) setLogLevel(args.logLevel as 'debug' | 'info' | 'warn' | 'error');

  try {
    switch (args.command) {
      case 'help':
        console.log(HELP);
        return 0;
      case 'version':
        console.log(VERSION);
        return 0;
      case 'init':
        // Interactive by construction — the opposite of `start`, which must never block on
        // stdin because it runs under systemd/CI (RUN-40).
        await runInit({ configPath: args.configPath });
        return 0;
      case 'update':
        return await cmdUpdate();
      case 'auth':
        await cmdAuth(args);
        return 0;
      case 'config':
        await cmdConfig(args.configPath);
        return 0;
      case 'discover':
        await cmdDiscover(args.configPath);
        return 0;
      case 'start':
        await cmdStart(args.configPath);
        return 0;
      default:
        logger.error(`unknown command: ${args.command}`);
        console.log(`\n${HELP}`);
        return 2;
    }
  } catch (err) {
    logger.error((err as Error).message);
    return 1;
  }
}

/**
 * Is this module the script node was asked to run? Guards `run()` so importing it from a test
 * does not execute the CLI.
 *
 * **Compare REAL paths, not the ones we were handed.** `process.argv[1]` is the path the user
 * invoked, and for a global install that is npm's bin symlink
 * (`…/bin/noriq-runner` → `…/lib/node_modules/@noriq-dev/runner/dist/cli.js`), while
 * `import.meta.url` is always the resolved target — node follows symlinks when it resolves a
 * module. So comparing them raw is `false` for **every `npm i -g` install on every platform**,
 * and the CLI parses its args, matches its command, and exits 0 having printed nothing.
 *
 * v0.2.0 shipped exactly that: `npm i -g @noriq-dev/runner && noriq-runner version` printed
 * nothing and exited 0. Nothing in the test suite or CI could see it — tests import `run`
 * directly (so the guard is supposed to be false) and `npm run dev` passes a real path. The
 * bug lives *only* on the path a stranger takes, which is the path we never took.
 *
 * Symlink layers stack, so a second one hides behind the first: on Fedora Atomic `/home` is a
 * symlink to `/var/home`, which breaks the raw comparison on its own even with no npm bin link.
 */
export function invokedDirectly(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false; // `node -e`, a REPL, an import — nobody asked for a script
  try {
    return metaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false; // argv[1] names nothing on disk, so it isn't us
  }
}

if (invokedDirectly(import.meta.url, process.argv[1])) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
