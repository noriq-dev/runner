#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DEFAULT_CODEX_HOME, loginCodex } from './agent-homes';
import { type AuthMode, authorize, resolveMode } from './auth';
import { completionCandidates, completionScript, formatCommandTable } from './completion';
import { DEFAULT_CONFIG_PATH, loadRunnerConfig } from './config';
import { DEFAULT_CREDENTIALS_PATH } from './credentials';
import { Daemon } from './daemon';
import { discoverRepos, loadIndexConfig, loadManifest } from './discovery';
import {
  requestIndexCancel,
  requestIndexReindex,
  requestIndexRetry,
  requestIndexStatus,
} from './index-control';
import { DEFAULT_DEBUG_LIMIT, compareGenerations, renderDebugReport } from './index-debug';
import { IndexJournal, fileJournalStore } from './index-journal';
import { INDEX_LANGUAGES } from './index-policy';
import { buildIndexAdapterRegistry } from './index-registry';
import { buildIndexRepoReport, runIndexRepo } from './index-repo';
import { fileStagingStore, forgetMatchingGenerations } from './index-stage';
import type { IndexStatusRecord } from './index-status';
import { readIndexStatusSnapshot } from './index-status';
import type { IndexTriggerStatus } from './index-triggers';
import { runInit } from './init';
import { runInitProject } from './init-project';
import { logger, setLogLevel } from './logger';
import { TokenSource } from './token';
import type { GrammarId } from './treesitter-runtime';
import { checkForUpdate, updateAdvice } from './update';
import { VERSION } from './version';

const HELP = `noriq-runner v${VERSION} — Noriq's local execution-plane daemon

Usage:
  noriq-runner <command> [options]

Commands:
${formatCommandTable()}

Options:
  --config <path>  Path to runner.toml (default: ${DEFAULT_CONFIG_PATH})
  --log-level <l>  debug | info | warn | error (default: info)

Shell completion:
  Add tab-completion for commands, flags, and flag values. Source the script from
  your shell's rc file so it loads every session:
    bash:  echo 'eval "$(noriq-runner completion bash)"' >> ~/.bashrc
    zsh:   echo 'eval "$(noriq-runner completion zsh)"'  >> ~/.zshrc
         (zsh needs \`autoload -U compinit && compinit\` earlier in the rc file)

auth options:
  --server <url>   Noriq server to authorize against (default: the config's server)
  --browser        Force the browser flow (loopback + PKCE)
  --device         Force the device-code flow — for a box with no browser (SSH, CI)

codex-auth:
  Runs \`codex login\` with CODEX_HOME=${DEFAULT_CODEX_HOME}. Runner-spawned Codex sessions never
  fall back to ~/.codex, so authenticate this dedicated home before dispatching Codex work.

init-project options:
  --advanced       Start in the advanced tier: after the quick questions (key, driver, verify
                   command, reviewer, landing branch), also curate per-kind model/effort
                   defaults, the [land] envelope, build allow/deny rules, and the default
                   branch. Without it the quick tier runs alone, and one trailing question
                   offers the same fork

index-repo options (local only — never uploads, never mints an ingest capability; use this to
dry-run what background indexing would produce, without a daemon or a server):
  --path <dir>     Repo to index (default: the current directory)
  --force          Index even if [index].enabled is not true for this repo — steps past that
                    repo's own consent boundary, for local debugging only
  --json           Print the report as JSON instead of human-readable text
  --limit <n>      Cap entity/edge/diagnostic listings at n rows (default: 50)
  --show-content   Include entity content in the listing — still redacted (see THREAT-MODEL.md)
  --check-determinism
                    Index twice and compare the canonical output instead of printing a report

index-status options — ten distinguishable states (no-opt-in, queued, parsing, uploading,
server-validating, staged, active, failed, association-conflict, plus legacy unchanged — see
INDEX-OPERATIONS.md). Current servers validate and atomically activate a successful upload;
STAGED means an older server did not return activation proof and must be reconciled or recovered
by an admin before search can use it. Reads a
live daemon's control server when one answers; otherwise falls back to the last snapshot that
daemon wrote to disk, labelled with when it was observed — never a synthesized "now":
  --path <dir>     Repo to report on (default: the current directory)
  --server <url>   Noriq server this repo reports to (default: the config's server)
  --json           Print the record as JSON instead of human-readable text

index-reindex / index-retry options — asks a RUNNING daemon to reindex now, through the same
trigger machinery already coalesces/deduplicates against; retrying twice converges on one
generation rather than starting a second (deduped batches), so it is safe to run again. Requires a
live daemon (noriq-runner start) — prints plainly and exits 1 if none answers, never hangs:
  --path <dir>     Repo to reindex (default: the current directory)
  --server <url>   Noriq server this repo reports to (default: the config's server)

index-cancel options — asks a running daemon to cancel this repo's ACTIVE index job, if any.
Requires a live daemon; a repo with nothing running is a no-op, reported as such, not an error:
  --path <dir>     Repo whose active job to cancel (default: the current directory)
  --server <url>   Noriq server this repo reports to (default: the config's server)

index-forget-journal options — LOCAL ONLY, needs no daemon: clears this machine's own record of
an in-progress index upload (the journal entry and any staged bytes) for the repo at --path. This
does NOT retract anything already uploaded — the server's own record of what it ingested is
authoritative and untouched; only what THIS machine remembered about the attempt is cleared:
  --path <dir>     Repo whose local journal state to forget (default: the current directory)
  --server <url>   Noriq server this repo reports to (default: the config's server)

Environment:
  NORIQ_TOKEN      A token to use as-is; overrides the stored credentials.
  NORIQ_NO_BROWSER Set to force the device flow, as --device does.
  NORIQ_LOG_LEVEL  Same as --log-level.

See INDEX-OPERATIONS.md in this repo for the full index/memory lifecycle guide: every state,
local journals and staging, why episode/verification retries have no command here (they retry
automatically), common failures, and an operator recovery checklist.
`;

interface ParsedArgs {
  command: string;
  /** Positional arguments after the command, e.g. `completion bash` → ['bash']. */
  rest: string[];
  configPath?: string;
  logLevel?: string;
  server?: string;
  authMode: AuthMode;
  advanced: boolean;
  indexPath?: string;
  indexForce: boolean;
  indexJson: boolean;
  indexLimit?: number;
  indexShowContent: boolean;
  indexCheckDeterminism: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let configPath: string | undefined;
  let logLevel: string | undefined;
  let server: string | undefined;
  let authMode: AuthMode = 'auto';
  let advanced = false;
  let indexPath: string | undefined;
  let indexForce = false;
  let indexJson = false;
  let indexLimit: number | undefined;
  let indexShowContent = false;
  let indexCheckDeterminism = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config') configPath = argv[++i];
    else if (arg === '--log-level') logLevel = argv[++i];
    else if (arg === '--server') server = argv[++i];
    else if (arg === '--device') authMode = 'device';
    else if (arg === '--browser') authMode = 'browser';
    else if (arg === '--advanced') advanced = true;
    else if (arg === '--path') indexPath = argv[++i];
    else if (arg === '--force') indexForce = true;
    else if (arg === '--json') indexJson = true;
    else if (arg === '--show-content') indexShowContent = true;
    else if (arg === '--check-determinism') indexCheckDeterminism = true;
    else if (arg === '--limit') {
      const raw = argv[++i];
      const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
      if (!Number.isInteger(parsed) || parsed < 0)
        throw new Error(`--limit expects a non-negative integer, got: ${raw}`);
      indexLimit = parsed;
    } else if (arg === '--version' || arg === '-v') positional.push('version');
    else if (arg === '--help' || arg === '-h') positional.push('help');
    else if (arg?.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else if (arg) positional.push(arg);
  }
  return {
    command: positional[0] ?? 'help',
    rest: positional.slice(1),
    configPath,
    logLevel,
    server,
    authMode,
    advanced,
    indexPath,
    indexForce,
    indexJson,
    indexLimit,
    indexShowContent,
    indexCheckDeterminism,
  };
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

/**
 * `index-selftest` (RUN-216): parse a trivial snippet through every bundled tree-sitter grammar
 * and report pass/fail per grammar. This is the packaging proof itself, not a demo — RUN-216's own
 * locked decision 4 requires proving the grammar `.wasm` resolves from the INSTALLED/bundled
 * package by actually EXECUTING `dist/cli.js`, not by trusting a passing `vitest` run (tsx/vitest
 * read `node_modules` directly, so both stay green even when the bundle's own asset resolution is
 * broken — the exact failure shape `__RUNNER_PROMPTS__` already exists to avoid, one layer up).
 * Also the reason this command exists at all rather than staying test-only code: without a reachable
 * call site in `cli.ts`'s own import graph, esbuild's dead-code elimination drops the whole
 * tree-sitter module tree from `dist/cli.js` — including the `define`-inlined grammar bytes — since
 * nothing shipped in the binary today calls `runIndexer` (RUN-217+'s coordinator wiring is what
 * will do that; this command is what lets THIS task prove its own packaging before that wiring
 * exists). Exits non-zero if any grammar fails to load or mis-parses its own snippet — the shape a
 * platform-specific CI job (locked acceptance: "works on Linux, macOS, and Windows CI") runs after
 * `npm run build` to catch a packaging regression before it reaches an install.
 *
 * **Builds its registry through `buildIndexAdapterRegistry` (`index-registry.ts`)** — the same
 * composition function `index-repo` uses (RUN-219's own acceptance: "both commands obtain their
 * adapters from the same composition function") — with every `[index].languages` value admitted,
 * since this command is proving the tree-sitter GRAMMARS load from the bundle, never exercising the
 * language gate itself. Selecting the adapter via `registry.select(probe.path)` rather than calling
 * `createTreeSitterAdapter` directly means the two commands cannot silently disagree about which
 * adapter answers for a given path.
 */
async function cmdIndexSelftest(): Promise<number> {
  const { registry, runtime } = buildIndexAdapterRegistry({ languages: [...INDEX_LANGUAGES] });

  const probes: Record<GrammarId, { path: string; content: string; expect: string }> = {
    typescript: {
      path: 'a.ts',
      content: 'export function add(a: number): number { return a; }',
      expect: 'add',
    },
    javascript: { path: 'a.js', content: 'function add(a) { return a; }', expect: 'add' },
    tsx: { path: 'a.tsx', content: 'export function App() { return <div>{1}</div>; }', expect: 'App' },
    // RUN-239.
    cpp: { path: 'a.cpp', content: 'int add(int a, int b) { return a + b; }', expect: 'add' },
    ini: { path: 'a.ini', content: '[Section]\nKey=Value\n', expect: 'Section' },
  };

  let ok = true;
  const report: Array<Record<string, unknown>> = [];
  for (const [id, probe] of Object.entries(probes) as Array<[GrammarId, (typeof probes)[GrammarId]]>) {
    const adapter = registry.select(probe.path);
    if (!adapter) {
      ok = false;
      report.push({ grammar: id, passed: false, error: 'no adapter registered for this probe path' });
      continue;
    }
    try {
      const result = await adapter.parse({ path: probe.path, content: probe.content });
      const found = result.symbols.some((s) => s.symbolPath.includes(probe.expect));
      const passed = found && result.diagnostics.every((d) => d.severity !== 'error');
      ok = ok && passed;
      report.push({ grammar: id, adapterId: adapter.id, version: adapter.version, passed });
    } catch (err) {
      ok = false;
      report.push({ grammar: id, passed: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  console.log(JSON.stringify({ ok, runtime: runtime.stats, grammars: report }, null, 2));
  return ok ? 0 : 1;
}

/**
 * `index-repo` (RUN-219): index THIS repository locally and print a summary, entity/edge listing,
 * or a determinism check — no server, no network, no upload, ever (locked decision 4 — enforced by
 * this command's own import graph never reaching `ingest-client.ts`/`client.ts`, asserted by
 * `index-repo.test.ts`, not merely by this comment). `index-repo.ts` is the orchestrator; this
 * function is thin CLI glue over it: resolve flags, call it, render what comes back, pick an exit
 * code.
 *
 * **Respects `[index].enabled` by default** (locked decision 8): a repo that has not opted in gets
 * an explanation and exit 1, never a silent no-op and never an index anyway. `--force` steps past
 * that — loudly, naming exactly what it is stepping past — for local debugging of a repo that has
 * not (yet) turned indexing on, or a bare directory with no `.noriq/project.toml` at all.
 */
async function cmdIndexRepo(args: ParsedArgs): Promise<number> {
  const root = args.indexPath ?? process.cwd();
  const runOptions = {
    root,
    force: args.indexForce,
    limit: args.indexLimit,
    showContent: args.indexShowContent,
  };

  const first = await runIndexRepo(runOptions);
  if (!first) {
    logger.error(
      "indexing is OFF for this repo — [index].enabled is not 'true' in .noriq/project.toml (or " +
        'the [index] table is invalid). Pass --force to index anyway for LOCAL DEBUGGING ONLY: this ' +
        'command never uploads and never mints an ingest capability, with or without that flag.',
    );
    return 1;
  }
  if (first.configSource === 'forced-default') {
    logger.warn(
      "--force stepped past this repo's own [index].enabled consent boundary. Local only — " +
        'nothing this command reads ever leaves this machine.',
    );
  }

  if (args.indexCheckDeterminism) {
    const second = await runIndexRepo(runOptions);
    const check = second
      ? compareGenerations(first.result, second.result)
      : { ok: false, mismatches: ['the second run refused — [index] state changed between the two runs'] };
    if (args.indexJson) {
      console.log(JSON.stringify(check, null, 2));
    } else {
      console.log(
        check.ok
          ? 'determinism check: PASS — two runs produced byte-identical output'
          : 'determinism check: FAIL',
      );
      for (const mismatch of check.mismatches) console.log(`  - ${mismatch}`);
    }
    return check.ok ? 0 : 1;
  }

  const report = await buildIndexRepoReport(first, {
    limit: args.indexLimit ?? DEFAULT_DEBUG_LIMIT,
    showContent: args.indexShowContent,
  });
  console.log(args.indexJson ? JSON.stringify(report, null, 2) : renderDebugReport(report));
  return 0;
}

/** This repo's canonical repository key, or a printed explanation of why there is none — shared
 *  by every RUN-223 command below, all of which key off it the identical way the daemon's own
 *  trigger layer does (`.noriq/project.toml`'s `repositoryKey`, never `projectKey`/`id`). */
async function resolveRepositoryKey(root: string): Promise<string | null> {
  const manifest = await loadManifest(root);
  const repositoryKey = manifest?.repositoryKey ?? null;
  if (!repositoryKey) {
    logger.error(
      'this repo has no valid repositoryKey in .noriq/project.toml — background indexing has no ' +
        'canonical repository identity to key off, so there is nothing this command can look up',
    );
  }
  return repositoryKey;
}

const epoch = (ms: number | null): string => (ms === null ? 'never' : new Date(ms).toISOString());

/**
 * `index-status` (RUN-223) — the operator-visible view of background indexing for the repo at
 * `--path`. "No opt-in" is answered LOCALLY (`resolveConfig`/`loadIndexConfig` returning null IS
 * the state — asking a daemon would only re-run the identical check it already applies to itself).
 * Every other state needs a daemon that has actually observed an attempt: this prefers a LIVE
 * answer from the control server (`index-control.ts`) and falls back to the last snapshot that
 * daemon persisted to disk, labelled by its own timestamp — a view, never a claim about right now
 * (`index-status.ts`'s own doc on why this surface is disposable).
 */
async function cmdIndexStatus(args: ParsedArgs): Promise<number> {
  const root = args.indexPath ?? process.cwd();
  const config = await loadIndexConfig(root);
  if (!config) {
    if (args.indexJson) console.log(JSON.stringify({ state: 'no-opt-in' }, null, 2));
    else console.log("state: no-opt-in — [index].enabled is not 'true' in .noriq/project.toml for this repo");
    return 0;
  }

  const repositoryKey = await resolveRepositoryKey(root);
  if (!repositoryKey) return 1;
  const server = await resolveServer(args);

  const live = await requestIndexStatus();
  const record: IndexStatusRecord | null = live.ok
    ? (live.data.records.find((r) => r.repositoryKey === repositoryKey) ?? null)
    : ((await readIndexStatusSnapshot()).find((r) => r.repositoryKey === repositoryKey) ?? null);
  const trigger: IndexTriggerStatus | null = live.ok
    ? (live.data.triggers.find((t) => t.repositoryKey === repositoryKey) ?? null)
    : null;
  const source = live.ok
    ? 'live daemon'
    : `no live daemon reachable (${live.reason}) — showing the last local snapshot, if any`;

  if (args.indexJson) {
    console.log(JSON.stringify({ repositoryKey, server, source, record, trigger }, null, 2));
    return 0;
  }

  console.log(renderIndexStatusText({ repositoryKey, server, source, record, trigger }));
  return 0;
}

/**
 * The human-readable render, pulled out as a pure function so it is directly testable with a
 * synthetic record/trigger — `cmdIndexStatus` above always reaches this through `~/.noriq`'s
 * default paths (a live daemon or the persisted snapshot), which a test must not touch for the
 * same reason no test here writes the operator's real `~/.noriq/index-journal.json`.
 */
export function renderIndexStatusText(info: {
  repositoryKey: string;
  server: string;
  source: string;
  record: IndexStatusRecord | null;
  trigger: IndexTriggerStatus | null;
}): string {
  const lines = [`repository: ${info.repositoryKey}`, `server: ${info.server}`, `source: ${info.source}`];
  const record = info.record;
  if (!record) {
    lines.push('state: unknown — no observation of this repository has ever been recorded');
  } else {
    // Unmistakable without reading `detail` closely (locked decision, RUN-223 round 2): every
    // OTHER `failed` invites a retry, this one means retrying is pointless until the daemon
    // itself is upgraded — printed on the state line itself, not left to a prose scan.
    //
    // `'staged'` gets the same unmistakable-on-the-state-line treatment, keyed off the
    // state itself rather than a second boolean — unlike `requiresUpgrade`, which disambiguates
    // WITHIN the shared `'failed'` bucket, `'staged'` is its own named state produced by nothing
    // else, so there is no ambiguity a flag would resolve. Every OTHER non-terminal state here
    // invites a retry; this one names server reconciliation/admin recovery so an operator does
    // not retry an upload that already validated.
    lines.push(
      `state: ${record.state}` +
        `${record.requiresUpgrade ? ' [BLOCKED — upgrade this daemon, do not retry]' : ''}` +
        `${record.state === 'staged' ? ' [server did not confirm activation — reconcile or recover as admin, do not retry]' : ''}`,
      `since: ${record.stateSince}`,
    );
    if (record.detail) lines.push(`detail: ${record.detail}`);
    lines.push(
      record.lastSuccess
        ? `last success: ${record.lastSuccess.at} (generation ${record.lastSuccess.generationId}, base ` +
            `${record.lastSuccess.baseId}, ${record.lastSuccess.batchesReceived} batch(es) received)`
        : 'last success: none observed',
    );
    lines.push(
      record.lastError
        ? `last error: ${record.lastError.at} — ${record.lastError.message}`
        : 'last error: none observed',
    );
    lines.push(`parser (indexer) version: ${record.indexerVersion}`);
  }
  if (info.trigger) {
    const trigger = info.trigger;
    lines.push(
      `last requested: ${epoch(trigger.lastRequestedAt)} (${trigger.lastRequestedReason ?? 'n/a'})`,
      `last triggered: ${epoch(trigger.lastTriggeredAt)}`,
      `next poll: ${trigger.nextPollAt === null ? 'not scheduled' : epoch(trigger.nextPollAt)}`,
    );
  }
  return lines.join('\n');
}

/**
 * `index-reindex`/`index-retry` (RUN-223) — the identical request under two names (locked
 * decision 7: retry is a TRIGGER through the existing coalescing/dedup machinery, never a second
 * upload path — `deriveGenerationId` and `uploadGeneration`'s own resume-from-server-status make
 * re-requesting converge rather than duplicate). Requires a live daemon; refuses locally when
 * `[index].enabled` is off rather than sending a request the daemon would itself have to refuse
 * (locked decision 8: no new command may bypass that gate, including by way of a misleadingly
 * successful-looking request).
 */
async function cmdIndexManual(args: ParsedArgs, kind: 'reindex' | 'retry'): Promise<number> {
  const root = args.indexPath ?? process.cwd();
  const config = await loadIndexConfig(root);
  if (!config) {
    logger.error(
      "indexing is OFF for this repo — [index].enabled is not 'true' in .noriq/project.toml. " +
        'Nothing was requested.',
    );
    return 1;
  }
  const repositoryKey = await resolveRepositoryKey(root);
  if (!repositoryKey) return 1;

  const result =
    kind === 'reindex' ? await requestIndexReindex(repositoryKey) : await requestIndexRetry(repositoryKey);
  if (!result.ok) {
    if (result.reason === 'no-daemon') {
      logger.error(
        'no runner daemon is reachable for this repo — start it with `noriq-runner start` first. ' +
          'Nothing was queued.',
      );
    } else {
      logger.error(`the daemon refused: ${result.reason}`);
    }
    return 1;
  }
  console.log(
    `queued a manual ${kind} for ${repositoryKey} — the daemon will re-reconcile against the server; run \`index-status\` to watch progress. Requesting this again is safe: it converges on the same generation rather than starting a second.`,
  );
  return 0;
}

/** `index-cancel` (RUN-223) — asks a running daemon to abort this repo's ACTIVE index job, if any.
 *  A repo with nothing running is a reported no-op, never an error: cancelling something that
 *  already finished (or never started) is not a mistake, it is a race the caller lost harmlessly. */
async function cmdIndexCancel(args: ParsedArgs): Promise<number> {
  const root = args.indexPath ?? process.cwd();
  const repositoryKey = await resolveRepositoryKey(root);
  if (!repositoryKey) return 1;

  const result = await requestIndexCancel(repositoryKey);
  if (!result.ok) {
    if (result.reason === 'no-daemon') {
      logger.error('no runner daemon is reachable for this repo — nothing to cancel.');
    } else {
      logger.error(`the daemon refused: ${result.reason}`);
    }
    return 1;
  }
  console.log(
    result.data.ok
      ? `cancelled the active index job for ${repositoryKey}.`
      : `nothing was running for ${repositoryKey} — no active job to cancel.`,
  );
  return 0;
}

/**
 * `index-forget-journal` (RUN-223) — LOCAL ONLY, needs no daemon: clears this machine's own
 * bookkeeping (the journal entry and any staged bytes) for every in-flight generation this repo
 * has under the resolved server. Locked decision 5: this must make it impossible to believe it
 * deleted server memory — it clears local state and NOTHING else, and says so in its own output,
 * not only in help text, because someone reaching for this is usually trying to undo an upload,
 * which this command cannot do.
 */
async function cmdIndexForgetJournal(args: ParsedArgs): Promise<number> {
  const root = args.indexPath ?? process.cwd();
  const repositoryKey = await resolveRepositoryKey(root);
  if (!repositoryKey) return 1;
  const server = await resolveServer(args);

  const journal = new IndexJournal(fileJournalStore());
  const staging = fileStagingStore();
  const count = await forgetMatchingGenerations(
    journal,
    staging,
    (e) => e.server === server && e.repositoryKey === repositoryKey,
  );
  console.log(
    `cleared ${count} local index-upload record(s) and any staged bytes for ${repositoryKey} on ${server}.\nThis does NOT retract anything already uploaded. The server is the sole authority on what it has ingested, and that record is unchanged — only what THIS machine remembered about the attempt was cleared. There is no way, from this daemon, to retract an upload that already reached the server.`,
  );
  return 0;
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
  // The completion hook, handled before parseArgs: its argv is raw shell words (flags, empty
  // trailing word, partial tokens) that the normal parser would consume or reject. Hidden from
  // help — it exists only for the generated completion scripts to call.
  if (argv[0] === '__complete') {
    for (const candidate of completionCandidates(argv.slice(1))) console.log(candidate);
    return 0;
  }

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
      case 'init-project':
        // Marks the repo the user is standing in — cwd is the input, so there is no path
        // argument to get wrong (RUN-56).
        await runInitProject({ configPath: args.configPath, advanced: args.advanced });
        return 0;
      case 'update':
        return await cmdUpdate();
      case 'auth':
        await cmdAuth(args);
        return 0;
      case 'codex-auth':
        await loginCodex();
        console.log(`\n✓ Codex is authorized for Noriq Runner at ${DEFAULT_CODEX_HOME}`);
        return 0;
      case 'config':
        await cmdConfig(args.configPath);
        return 0;
      case 'completion': {
        const shell = args.rest[0];
        if (shell !== 'bash' && shell !== 'zsh') {
          logger.error('usage: noriq-runner completion <bash|zsh>');
          return 2;
        }
        console.log(completionScript(shell));
        return 0;
      }
      case 'discover':
        await cmdDiscover(args.configPath);
        return 0;
      case 'index-repo':
        return await cmdIndexRepo(args);
      case 'index-status':
        return await cmdIndexStatus(args);
      case 'index-reindex':
        return await cmdIndexManual(args, 'reindex');
      case 'index-retry':
        return await cmdIndexManual(args, 'retry');
      case 'index-cancel':
        return await cmdIndexCancel(args);
      case 'index-forget-journal':
        return await cmdIndexForgetJournal(args);
      case 'index-selftest':
        return await cmdIndexSelftest();
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
