import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { PermissionProfile } from '@noriq-dev/shared';
import { AsyncQueue } from '../async-queue';
import type { logger as Logger } from '../logger';
import { sanitizedAgentEnv } from '../security';
import {
  type AgentDriver,
  type DriverExit,
  type DriverSession,
  type DriverStartOptions,
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
 *  notifications into these). Token usage is cumulative for the thread. */
export type CodexEvent =
  | { type: 'text'; text: string }
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

export interface CodexSpawnOptions {
  cwd: string;
  model?: string;
  sandbox: CodexSandbox;
  /** Headless — never block on an interactive approval prompt. */
  approvalPolicy: 'never';
}
export type SpawnCodex = (opts: CodexSpawnOptions) => CodexTransport;

/** Permission profile → Codex sandbox. Codex's sandbox is coarser than the
 *  Claude driver's tool allowlist: scope/verify → read-only, build → workspace-
 *  write (writes confined to the worktree). The manifest bash allowlist doesn't
 *  map 1:1 (Codex gates by sandbox level + approval policy, not per-command). */
export function mapSandbox(profile: PermissionProfile): CodexSandbox {
  return profile.write ? 'workspace-write' : 'read-only';
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
      sandbox: mapSandbox(opts.permission),
      approvalPolicy: 'never',
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
    const consume = async () => {
      try {
        for await (const ev of transport.events) {
          if (ev.type === 'text') {
            if (ev.text) opts.handlers?.onText?.(ev.text);
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

// JSON-RPC method + notification names (validate against the installed codex at
// the dogfood; kept as named constants so a version bump is a one-line change).
const RPC = {
  initialize: 'initialize',
  threadStart: 'thread/start',
  turnStart: 'turn/start',
  turnSteer: 'turn/steer',
  turnInterrupt: 'turn/interrupt',
} as const;
const NOTIF = {
  agentMessageDelta: 'thread/agentMessageDelta',
  tokenUsage: 'thread/tokenUsageUpdated',
  turnCompleted: 'turn/completed',
  error: 'thread/error',
} as const;

interface TokenBreakdown {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

/** Map a raw app-server JSON-RPC notification to a normalized CodexEvent. */
export function normalizeNotification(method: string, params: Record<string, unknown>): CodexEvent | null {
  if (method === NOTIF.agentMessageDelta) {
    return { type: 'text', text: String((params as { delta?: unknown }).delta ?? '') };
  }
  if (method === NOTIF.tokenUsage) {
    const total = ((params as { tokenUsage?: { total?: TokenBreakdown } }).tokenUsage?.total ??
      {}) as TokenBreakdown;
    return {
      type: 'usage',
      inputTokens: total.inputTokens ?? 0,
      outputTokens: total.outputTokens ?? 0,
      cacheReadTokens: total.cachedInputTokens ?? 0,
    };
  }
  if (method === NOTIF.turnCompleted) return { type: 'turn_complete' };
  if (method === NOTIF.error) {
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
  // Sanitized env (RUN-24): strip secrets + block git push/credential prompts.
  const child = spawnFn('codex', ['app-server'], {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: sanitizedAgentEnv(),
  });
  const events = new AsyncQueue<CodexEvent>();
  let nextId = 1;
  let threadId: string | null = null;
  let turnId: string | null = null;
  /** A turn requested before the thread existed — flushed once thread/start answers. */
  let pendingTurn: string | null = null;

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
    let msg: { method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    // Capture ids from responses so we can steer/interrupt the active turn.
    if (msg.result) {
      const r = msg.result as { threadId?: string; turn?: { id?: string } };
      if (r.threadId) {
        threadId = r.threadId;
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

  // Handshake → start the thread with the requested sandbox.
  send(RPC.initialize, { clientInfo: { name: 'noriq-runner' } });
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
      return send(RPC.turnSteer, { threadId, expectedTurnId: turnId, input: userInput(text) }) !== null;
    },
    interrupt: () => send(RPC.turnInterrupt, { threadId, turnId }, true),
    close: () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    },
  };
};
