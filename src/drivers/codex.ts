import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { PermissionProfile, RunEffort, RunKind } from '@noriq-dev/shared';
import { AsyncQueue } from '../async-queue';
import type { logger as Logger } from '../logger';
import { killProcessTree, treeSpawnOptions } from '../proc';
import { CODEX_MCP_TOKEN_ENV, noriqToolNamesFor, sanitizedAgentEnv } from '../security';
import { VERSION } from '../version';
import { NORIQ_MCP_NAME } from './claude';
import {
  type AgentDriver,
  type DriverCapabilities,
  type DriverExit,
  type DriverSession,
  type DriverStartOptions,
  type NoriqMcp,
  zeroTelemetry,
} from './types';

// ---------------------------------------------------------------------------
// Codex driver — protocol parity with the Claude driver behind one AgentDriver
// interface. Codex is driven via its `app-server` protocol mode (JSON-RPC over
// stdio): thread/start → turn/start, with turn/steer for mid-session user input,
// turn/interrupt, and sandbox permission flags. The process is abstracted behind
// an injectable CodexTransport (like the Claude driver's queryFn) so the driver
// logic is fully testable without the real binary or OpenAI auth.
// ---------------------------------------------------------------------------

/** Normalized, driver-facing events (the transport maps the real app-server
 *  notifications into these). Token usage is cumulative for the thread.
 *
 *  No per-MODEL breakdown, deliberately (RUN-59): the app-server's usage notification carries one
 *  cumulative thread total (input/output/cacheRead), no model key and no cost. Per-model figures
 *  live only in the session JSONL on disk (what ccusage parses), and a per-agent split is an open
 *  upstream request (openai/codex#14642). So this driver never emits `modelUsage`, and the run
 *  reports "not reported" rather than implying 100% of the requested model — the lie RUN-59
 *  removes. Do NOT synthesize a single-model mix from the thread total to fill the gap. */
export type CodexEvent =
  // itemId: which agentMessage item a text delta belongs to (0.144.x names one; 0.142.x
  // doesn't) — the driver inserts a paragraph break when it changes, because distinct
  // items are distinct model messages with no newline between them (RUN-80).
  | { type: 'text'; text: string; itemId?: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens: number }
  | { type: 'turn_complete' }
  | { type: 'error'; message: string };

export interface CodexTransport {
  events: AsyncIterable<CodexEvent>;
  /** Start the first user turn with the initial prompt. */
  sendUserTurn(text: string): void;
  /** Steer the active turn with additional user input (mid-session).
   *  @returns false if there is no live turn to steer — the caller must fall back
   *  rather than ack a message the session never received. */
  steer(text: string): boolean;
  /** Interrupt the active turn. */
  interrupt(): void;
  /** Terminate the process. */
  close(): void;
}

export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

/** What codex's `model_reasoning_effort` accepts. Its ceiling is `high`; the Claude SDK's
 *  EffortLevel goes two steps further, which is why RunEffort needs mapping rather than
 *  passing through. */
export type CodexEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface CodexSpawnOptions {
  cwd: string;
  model?: string;
  /** Tool-agnostic intent (RUN-33); mapEffort turns it into codex's own scale. */
  effort?: RunEffort;
  sandbox: CodexSandbox;
  /** Headless — never block on an interactive approval prompt. */
  approvalPolicy: 'never';
  /** The agent's Noriq connection. Omitted → it cannot report its own work at all. */
  noriqMcp?: NoriqMcp;
  /** The run kind, so the per-kind Noriq tool floor applies HERE too (RUN-46) — without it
   *  every codex agent got the server's whole tool surface, and a verify agent could
   *  claim_task the work it was judging. */
  kind: RunKind;
  /** The supervisor-sanitized process env (RUN-109). Absent only in tests → `sanitizedAgentEnv()`. */
  env?: NodeJS.ProcessEnv;
}
export type SpawnCodex = (opts: CodexSpawnOptions) => CodexTransport;

/** Permission profile → Codex sandbox. Codex's sandbox is coarser than the
 *  Claude driver's tool allowlist: scope/verify → read-only, build → workspace-
 *  write (writes confined to the worktree). The manifest bash allowlist doesn't
 *  map 1:1 (Codex gates by sandbox level + approval policy, not per-command).
 *
 *  AUTO (RUN-68) grants `danger-full-access` — but ONLY when the profile also grants write.
 *  The sandbox is the ONLY enforcement codex has, so dropping it for a read-only kind would
 *  silently turn `auto` into `write`, and those are different promises: auto loosens command
 *  gating, never the write axis. For a read-only kind auto is therefore a no-op here — headless
 *  codex never prompted anyway, so there is nothing softer than read-only to give it. */
export function mapSandbox(profile: PermissionProfile): CodexSandbox {
  if (profile.auto && profile.write) return 'danger-full-access';
  return profile.write ? 'workspace-write' : 'read-only';
}

/**
 * RunEffort (intent) → codex's `model_reasoning_effort` (RUN-33). mapSandbox's neighbour, and
 * the same idea: the shared contract carries what we MEAN, each driver knows its own backend.
 *
 * Mapped rather than passed through, because codex tops out at `high` while RunEffort (matching
 * the Claude SDK, the finer-grained of the two) has `xhigh` and `max` above it. Those clamp:
 * "think as hard as you can" is the honest reading, and it is what the Claude SDK itself does
 * when asked for an effort a given model cannot do.
 *
 * The clamp is not cosmetic. Verified against codex-cli 0.142.4: `-c model_reasoning_effort=…`
 * is accepted for ANY value at parse time — a bogus one does not fail the spawn. So passing
 * `xhigh` straight through would not error here; it would surface later, as an API-level failure
 * mid-run, after the tokens were spent.
 */
export function mapEffort(effort: RunEffort): CodexEffort {
  return effort === 'xhigh' || effort === 'max' ? 'high' : effort;
}

export interface CodexDriverDeps {
  /** Injectable for tests; defaults to spawning the real `codex app-server`. */
  spawnCodex?: SpawnCodex;
  logger?: Pick<typeof Logger, 'debug' | 'info' | 'warn' | 'error'>;
}

/**
 * Drives Codex via app-server protocol mode with spawn/stream/steer/interrupt
 * parity with the Claude driver. Completes on the first turn/completed.
 */
export class CodexDriver implements AgentDriver {
  readonly tool = 'codex' as const;
  // Codex steers and interrupts over JSON-RPC, but has NO in-process tool hooks (locks fall to the
  // hard floor, RUN-102), no per-model telemetry (spend → the (unattributed) bucket, RUN-86), and
  // no session resume — a parked codex run restarts rather than reloading context (RUN-110).
  readonly capabilities: DriverCapabilities = {
    toolHooks: false,
    steer: true,
    interrupt: true,
    resumableSession: false,
    perModelTelemetry: false,
  };
  private readonly spawnCodex: SpawnCodex;
  private readonly log: Pick<typeof Logger, 'debug' | 'info' | 'warn' | 'error'>;

  constructor(deps: CodexDriverDeps = {}) {
    this.spawnCodex = deps.spawnCodex ?? defaultSpawnCodex;
    this.log = deps.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
  }

  start(opts: DriverStartOptions): DriverSession {
    const transport = this.spawnCodex({
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      sandbox: mapSandbox(opts.permission),
      approvalPolicy: 'never',
      noriqMcp: opts.noriqMcp,
      kind: opts.kind,
      env: opts.env,
    });
    transport.sendUserTurn(opts.prompt);

    let settle!: (exit: DriverExit) => void;
    const donePromise = new Promise<DriverExit>((resolve) => {
      settle = resolve;
    });
    let finished = false;
    const finish = (exit: DriverExit) => {
      if (finished) return;
      finished = true;
      try {
        transport.close();
      } catch {
        /* already gone */
      }
      opts.handlers?.onExit?.(exit);
      settle(exit);
    };

    const live = zeroTelemetry();
    // Distinct agentMessage items are distinct model messages with no newline between
    // them — insert a paragraph break when the item id changes (RUN-80; claude does the
    // same at assistant-turn boundaries). Id-less deltas (0.142.x) never trigger it.
    let lastItemId: string | undefined;
    const consume = async () => {
      try {
        for await (const ev of transport.events) {
          if (ev.type === 'text') {
            if (ev.text) {
              if (ev.itemId && lastItemId && ev.itemId !== lastItemId) opts.handlers?.onText?.('\n\n');
              if (ev.itemId) lastItemId = ev.itemId;
              opts.handlers?.onText?.(ev.text);
            }
          } else if (ev.type === 'usage') {
            // Codex reports cumulative thread usage — set (don't accumulate).
            live.inputTokens = ev.inputTokens;
            live.outputTokens = ev.outputTokens;
            live.cacheReadTokens = ev.cacheReadTokens;
            opts.handlers?.onTelemetry?.({ ...live });
          } else if (ev.type === 'turn_complete') {
            live.numTurns += 1;
            opts.handlers?.onTelemetry?.({ ...live });
            finish({ outcome: 'done', isError: false, reason: null, telemetry: { ...live } });
            return;
          } else if (ev.type === 'error') {
            opts.handlers?.onError?.(new Error(ev.message));
            finish({ outcome: 'failed', isError: true, reason: ev.message, telemetry: { ...live } });
            return;
          }
        }
        finish({
          outcome: 'failed',
          isError: true,
          reason: 'codex stream ended without completing a turn',
          telemetry: { ...live },
        });
      } catch (err) {
        opts.handlers?.onError?.(err as Error);
        finish({ outcome: 'failed', isError: true, reason: (err as Error).message, telemetry: { ...live } });
      }
    };
    void consume();

    return {
      runId: opts.runId,
      pushInput: (text: string): boolean => transport.steer(text),
      interrupt: async () => {
        this.log.debug('codex interrupt', { runId: opts.runId });
        transport.interrupt();
      },
      stop: async () => {
        transport.close();
        finish({ outcome: 'failed', isError: true, reason: 'stopped', telemetry: { ...live } });
      },
      done: () => donePromise,
    };
  }
}

// ---------------------------------------------------------------------------
// Default transport: spawn `codex app-server` and speak its JSON-RPC protocol.
// Method/notification names are from the app-server protocol bindings (codex
// 0.142.x). This path is exercised end-to-end at the RUN-25 dogfood (it needs
// the codex binary + OpenAI auth); the driver logic itself is covered by tests
// against an injected fake transport.
// ---------------------------------------------------------------------------

// JSON-RPC method + notification names. The app-server protocol RENAMES things between
// minor releases (RUN-72): every notification the 0.142.x driver knew had a different name
// by 0.144.5, and the daemon can't pick which codex a machine has installed — so each
// concept accepts every name it has ever had. Requests are stable so far; notifications
// are where the churn lives. Validated live against 0.142.4 and 0.144.5.
const RPC = {
  initialize: 'initialize',
  threadStart: 'thread/start',
  turnStart: 'turn/start',
  turnSteer: 'turn/steer',
  turnInterrupt: 'turn/interrupt',
} as const;
const NOTIF = {
  agentMessageDelta: ['thread/agentMessageDelta', 'item/agentMessage/delta'],
  tokenUsage: ['thread/tokenUsageUpdated', 'thread/tokenUsage/updated'],
  turnCompleted: ['turn/completed'],
  error: ['thread/error', 'error'],
} as const;

interface TokenBreakdown {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

/** Map a raw app-server JSON-RPC notification to a normalized CodexEvent. */
export function normalizeNotification(method: string, params: Record<string, unknown>): CodexEvent | null {
  if ((NOTIF.agentMessageDelta as readonly string[]).includes(method)) {
    // 0.144.x carries the owning item's id (itemId, or item.id); 0.142.x has neither —
    // the field is simply absent then, and the driver's break-on-change never fires.
    const p = params as { delta?: unknown; itemId?: unknown; item?: { id?: unknown } };
    const itemId = p.itemId ?? p.item?.id;
    return {
      type: 'text',
      text: String(p.delta ?? ''),
      ...(itemId != null ? { itemId: String(itemId) } : {}),
    };
  }
  if ((NOTIF.tokenUsage as readonly string[]).includes(method)) {
    const total = ((params as { tokenUsage?: { total?: TokenBreakdown } }).tokenUsage?.total ??
      {}) as TokenBreakdown;
    return {
      type: 'usage',
      inputTokens: total.inputTokens ?? 0,
      outputTokens: total.outputTokens ?? 0,
      cacheReadTokens: total.cachedInputTokens ?? 0,
    };
  }
  if ((NOTIF.turnCompleted as readonly string[]).includes(method)) {
    // Since 0.144.x the turn carries its own outcome — an API failure arrives as
    // turn/completed{status:'failed'}, and reading that as success would mark a run
    // `done` whose agent never answered. Only an explicit 'failed' is a failure:
    // 0.142.x sends no status at all, and that generation's failures came as thread/error.
    const turn = (params as { turn?: { status?: string; error?: { message?: string } } }).turn;
    if (turn?.status === 'failed') {
      return { type: 'error', message: turn.error?.message ?? 'codex turn failed' };
    }
    return { type: 'turn_complete' };
  }
  if ((NOTIF.error as readonly string[]).includes(method)) {
    const err = (params as { error?: { message?: string } }).error;
    return { type: 'error', message: err?.message ?? 'codex error' };
  }
  return null;
}

/** The child-process seam. Injectable ONLY so the real transport's protocol handling is
 *  testable without the codex binary — every other codex test replaces the whole
 *  transport, which is exactly how the threadId race and the missing 'error' listener
 *  both shipped. */
export type SpawnChild = (
  cmd: string,
  args: string[],
  opts: Record<string, unknown>,
) => ChildProcessWithoutNullStreams;

export const defaultSpawnCodex = (
  opts: CodexSpawnOptions,
  spawnFn: SpawnChild = spawn as unknown as SpawnChild,
): CodexTransport => {
  // Wire the agent's Noriq MCP connection (RUN-43). This was simply ABSENT: the driver
  // spawned codex with no MCP config while the prompt ordered it to register itself against
  // a server it had no connection to — so every codex agent was silently anonymous and
  // un-attributable, and nothing errored.
  //
  // `-c` overrides are per-spawn, which matters: `codex mcp add` would write the server into
  // the user's own ~/.codex/config.toml, so the daemon would be reconfiguring the human's
  // codex behind their back. The value is parsed as TOML and falls back to a literal string,
  // which is what a bare URL lands as.
  const mcpArgs = opts.noriqMcp
    ? [
        '-c',
        `mcp_servers.${NORIQ_MCP_NAME}.url=${opts.noriqMcp.url}`,
        '-c',
        `mcp_servers.${NORIQ_MCP_NAME}.bearer_token_env_var=${CODEX_MCP_TOKEN_ENV}`,
        // The per-kind Noriq floor (RUN-46). `enabled_tools` is codex's per-server allowlist —
        // anything absent is not even advertised to the model. Without this line the floor was
        // a CLAUDE property: the same verify run on codex had every tool the server exposes,
        // claim_task included, which is the one thing the adversarial gate exists to prevent
        // (the reviewer moving the work it judges). JSON.stringify emits a valid TOML string
        // array, which is how -c values are parsed.
        '-c',
        `mcp_servers.${NORIQ_MCP_NAME}.enabled_tools=${JSON.stringify(noriqToolNamesFor(opts.kind))}`,
      ]
    : [];
  // Model + effort (RUN-33), per-spawn for the same reason as the MCP config above: writing
  // them to ~/.codex/config.toml would reconfigure the human's own codex behind their back.
  // Both omitted unless asked for, so an unset Run gets codex's own default exactly as before.
  const modelArgs = [
    ...(opts.model ? ['-c', `model=${opts.model}`] : []),
    ...(opts.effort ? ['-c', `model_reasoning_effort=${mapEffort(opts.effort)}`] : []),
  ];
  // Sanitized env (RUN-24): strip secrets + block git push/credential prompts. Since RUN-109 the
  // stripped base is handed down by the supervisor (`opts.env`; the `??` is the test-only
  // fallback). Codex can only read its bearer token from the environment (no header option), so
  // that one token — and only when MCP is actually wired — is put back deliberately, on top of the
  // already-stripped base. See CODEX_MCP_TOKEN_ENV in security.ts for why this token is the exception.
  const base = opts.env ?? sanitizedAgentEnv();
  const child = spawnFn('codex', ['app-server', ...mcpArgs, ...modelArgs], {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: opts.noriqMcp ? { ...base, [CODEX_MCP_TOKEN_ENV]: opts.noriqMcp.token } : base,
    // Group it with its descendants so close() can reach them all (RUN-42). POSIX-only; on
    // Windows this is a no-op and taskkill /T walks the tree instead.
    ...treeSpawnOptions(),
  });
  const events = new AsyncQueue<CodexEvent>();
  let nextId = 1;
  let threadId: string | null = null;
  let turnId: string | null = null;
  /** A turn requested before the thread existed — flushed once thread/start answers. */
  let pendingTurn: string | null = null;
  /** Requests whose rejection must NOT kill the run: a lost steer already has a fallback
   *  (the notices channel re-delivers), so its error is a shrug, not a verdict. */
  const nonFatalIds = new Set<number>();

  // A missing `codex` binary emits 'error' on the child. With no listener Node rethrows it
  // as an uncaught exception and the ENTIRE daemon dies — taking every concurrently
  // supervised Claude run down with it, none of them reporting a terminal status. Turn it
  // into a normal run failure instead.
  child.on('error', (err) => {
    events.push({ type: 'error', message: `codex process error: ${err.message}` });
    events.close();
  });

  const send = (method: string, params: Record<string, unknown>, isNotification = false): number | null => {
    const id = nextId++;
    const frame = isNotification
      ? { jsonrpc: '2.0', method, params }
      : { jsonrpc: '2.0', id, method, params };
    try {
      child.stdin.write(`${JSON.stringify(frame)}\n`);
      return id;
    } catch {
      // stdin is gone (EPIPE) — the process died. Never throw from a send.
      return null;
    }
  };

  const userInput = (text: string) => [{ type: 'text', text }];

  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    let msg: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: { message?: string };
    };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    // A JSON-RPC ERROR RESPONSE has neither `result` nor `method` — this branch existing at
    // all is RUN-72. Without it a rejected initialize/thread/start (which is how a protocol
    // mismatch presents) vanished: threadId stayed null, the buffered first turn never
    // flushed, and the run hung forever with codex idle at zero CPU. A rejected request is
    // a verdict; say so and let the driver fail the run with the reason.
    if (msg.error) {
      if (msg.id === undefined || !nonFatalIds.delete(msg.id)) {
        events.push({
          type: 'error',
          message: `codex rejected a request: ${msg.error.message ?? 'unknown error'}`,
        });
      }
      return;
    }
    // Capture ids from responses so we can steer/interrupt the active turn.
    if (msg.result) {
      // 0.142.x answered thread/start with {threadId}; 0.144.x nests it as {thread:{id}}.
      const r = msg.result as { threadId?: string; thread?: { id?: string }; turn?: { id?: string } };
      const startedThread = r.threadId ?? r.thread?.id;
      if (startedThread) {
        threadId = startedThread;
        // The thread exists now — release the turn that was requested before it did.
        if (pendingTurn !== null) {
          send(RPC.turnStart, { threadId, input: userInput(pendingTurn), cwd: opts.cwd });
          pendingTurn = null;
        }
      }
      if (r.turn?.id) turnId = r.turn.id;
    }
    if (msg.method) {
      const ev = normalizeNotification(msg.method, msg.params ?? {});
      if (ev) events.push(ev);
    }
  });
  child.on('exit', () => events.close());

  // Handshake → start the thread with the requested sandbox. clientInfo.version became
  // MANDATORY in codex 0.144.x — without it initialize is rejected outright (and that
  // rejection used to be swallowed, which is how every codex run silently hung, RUN-72).
  // Older codex ignores the extra fields.
  send(RPC.initialize, { clientInfo: { name: 'noriq-runner', title: 'Noriq Runner', version: VERSION } });
  send(RPC.threadStart, {
    cwd: opts.cwd,
    sandbox: opts.sandbox,
    approvalPolicy: opts.approvalPolicy,
    ...(opts.model ? { model: opts.model } : {}),
  });

  return {
    events,
    // The driver calls this synchronously the instant spawnCodex() returns, long before
    // thread/start's response has been read off stdout — so `threadId` is still null and
    // every real run posted `turn/start {threadId: null}`, which the app-server rejects:
    // no turn ever started and the stream ended with 'codex stream ended without
    // completing a turn'. Buffer instead, and flush when the thread actually exists.
    // (Every codex test injects a fake transport, so nothing caught this.)
    sendUserTurn: (text) => {
      if (threadId) send(RPC.turnStart, { threadId, input: userInput(text), cwd: opts.cwd });
      else pendingTurn = text;
    },
    steer: (text) => {
      // Nothing to steer until the thread + turn exist; report it rather than pretend.
      if (!threadId) return false;
      const id = send(RPC.turnSteer, { threadId, expectedTurnId: turnId, input: userInput(text) });
      if (id !== null) nonFatalIds.add(id); // a rejected steer must not fail the whole run
      return id !== null;
    },
    interrupt: () => send(RPC.turnInterrupt, { threadId, turnId }, true),
    close: () => {
      // The tree, not just codex (RUN-42): codex spawns tools of its own, and a stop that leaves
      // them running leaves the run's worktree locked and its CPU burning under a run the daemon
      // has already reported terminal. `force: false` keeps the POSIX contract the budget/steering
      // code was written against — SIGTERM, a chance to clean up. Windows has no equivalent (see
      // proc.ts): "ask nicely" is a WM_CLOSE a console app may ignore, and kill('SIGTERM') there
      // is already a hard TerminateProcess, so graceful-then-force is a POSIX-only idea.
      killProcessTree(child, { force: false });
    },
  };
};
