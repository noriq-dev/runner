import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionProfile, RunKind } from '@noriq-dev/shared';
import { AsyncQueue } from '../async-queue';
import type { logger as Logger } from '../logger';
import { sanitizedAgentEnv } from '../security';
import {
  type AgentDriver,
  type DriverExit,
  type DriverSession,
  type DriverStartOptions,
  type DriverTelemetry,
  zeroTelemetry,
} from './types';

// ---------------------------------------------------------------------------
// Narrow local mirrors of the @anthropic-ai/claude-agent-sdk types we consume
// (verified against the SDK's sdk.d.ts). The SDK is now a normal dependency
// (RUN-26 moved the whole tree to zod@4, resolving its zod@^4 peer), so `query`
// is imported directly — no more lazy require. We keep these narrow mirrors as an
// anti-corruption layer: the driver depends on the small surface it consumes, and
// tests inject a fake `queryFn` returning this shape without pulling in the SDK.
// ---------------------------------------------------------------------------
export interface SdkUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
export interface SdkContentBlock {
  type: string;
  text?: string;
}
export interface SdkUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: string | null;
}
export interface SdkAssistantMessage {
  type: 'assistant';
  message: { content: SdkContentBlock[]; usage?: SdkUsage };
}
export interface SdkResultMessage {
  type: 'result';
  subtype: string; // 'success' | 'error_max_turns' | 'error_max_budget_usd' | 'error_during_execution' | ...
  is_error: boolean;
  num_turns: number;
  total_cost_usd: number;
  usage: SdkUsage;
  stop_reason?: string | null;
}
export type SdkMessage =
  | SdkAssistantMessage
  | SdkResultMessage
  | { type: 'system'; subtype?: string }
  | { type: string };

export interface SdkQuery extends AsyncIterable<SdkMessage> {
  interrupt(): Promise<unknown>;
  close?(): void;
}
/** Mirror of the SDK's McpHttpServerConfig — the only transport we configure. */
export interface SdkMcpHttpServer {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}
export interface SdkQueryOptions {
  cwd?: string;
  model?: string;
  /** The child's shell env. Mirrors the SDK's `Options.env`. */
  env?: { [envVar: string]: string | undefined };
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  abortController?: AbortController;
  maxTurns?: number;
  maxBudgetUsd?: number;
  mcpServers?: Record<string, SdkMcpHttpServer>;
  /** Ignore all ambient MCP config (user settings, .mcp.json, plugins). */
  strictMcpConfig?: boolean;
}
export type QueryFn = (args: {
  prompt: AsyncIterable<SdkUserMessage>;
  options?: SdkQueryOptions;
}) => SdkQuery;

// ---------------------------------------------------------------------------
// Permission profile → Agent SDK options. Headless (`dontAsk`) so nothing ever
// blocks on an interactive prompt; the allowlist IS the enforcement. Bare `Bash`
// is never granted for a build — the manifest's `allow` carries the bash
// allowlist rules (e.g. "Bash(npm test:*)"), matching "edit + bash-allowlist".
// ---------------------------------------------------------------------------
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite'];
const EDIT_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'];
const dedupe = (xs: string[]): string[] => [...new Set(xs)];

/** The name the daemon's MCP server is registered under → tools are `mcp__noriq__*`. */
export const NORIQ_MCP_NAME = 'noriq';

/**
 * The Noriq tools each kind may call, curated to its job — the per-kind floor extended
 * to Noriq itself, not just the filesystem. A scope agent can propose a plan but not
 * claim work; a build agent can claim/report but not mint plans; verify can read and
 * comment but never mutate. `dontAsk` means anything absent here is denied, so these
 * lists are the whole of an agent's Noriq reach.
 */
const NORIQ_TOOLS: Record<RunKind, string[]> = {
  scope: ['set_agent_identity', 'get_briefing', 'get_task', 'get_plans', 'create_plan'],
  build: [
    'set_agent_identity',
    'get_briefing',
    'get_task',
    'claim_task',
    'release_task',
    'post_comment',
    'read_open_comments',
    'resolve_comment',
    'attach_ref',
    'update_task',
  ],
  verify: ['set_agent_identity', 'get_task', 'get_plans', 'post_comment', 'read_open_comments'],
};

/** The Noriq MCP tool ids a kind is allowed to call. */
export const noriqToolsFor = (kind: RunKind): string[] =>
  (NORIQ_TOOLS[kind] ?? []).map((t) => `mcp__${NORIQ_MCP_NAME}__${t}`);

export function mapPermission(
  profile: PermissionProfile,
  kind: RunKind,
): {
  permissionMode: string;
  allowedTools: string[];
  disallowedTools: string[];
} {
  const allowed = [...READ_TOOLS];
  if (profile.write) allowed.push(...EDIT_TOOLS);
  // The agent reports its own work through Noriq — without these the prompt's
  // "register + claim + report" contract is unsatisfiable and the run is a no-op.
  allowed.push(...noriqToolsFor(kind));
  allowed.push(...profile.allow);

  const disallowed = [...profile.deny];
  // No edit tools without write — that is what read-only means, and it is the property
  // that stops a VERIFY agent from "fixing" the code it is supposed to be judging.
  if (!profile.write) disallowed.push(...EDIT_TOOLS);
  // Bare `Bash` is denied outright ONLY when the profile grants no bash rules of its
  // own. Deny outranks allow, so a blanket 'Bash' here would silently neuter an
  // explicit `Bash(npm test:*)` — the rule would sit in the manifest doing nothing.
  // A read-only kind may still need to EXECUTE (a verifier that cannot run the suite
  // can only ever review by eye); `dontAsk` denies whatever the allowlist omits, so
  // the enumerated rules remain the enforcement.
  const grantsBash = profile.allow.some((r) => r === 'Bash' || r.startsWith('Bash('));
  if (!profile.write && !grantsBash) disallowed.push('Bash');
  return { permissionMode: 'dontAsk', allowedTools: dedupe(allowed), disallowedTools: dedupe(disallowed) };
}

const userTurn = (text: string): SdkUserMessage => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
});

const extractText = (blocks: SdkContentBlock[]): string =>
  blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');

function telemetryFromResult(m: SdkResultMessage): DriverTelemetry {
  return {
    inputTokens: m.usage.input_tokens ?? 0,
    outputTokens: m.usage.output_tokens ?? 0,
    cacheReadTokens: m.usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: m.usage.cache_creation_input_tokens ?? 0,
    costUsd: m.total_cost_usd,
    numTurns: m.num_turns,
  };
}

// The real Agent SDK `query`, adapted to our narrow QueryFn seam. The runtime
// shapes match our mirrors (verified against sdk.d.ts); the casts only bridge the
// nominal gap between the SDK's full types and the small surface we consume.
const realSdkQuery: QueryFn = (args) =>
  sdkQuery(args as Parameters<typeof sdkQuery>[0]) as unknown as SdkQuery;

export interface ClaudeDriverDeps {
  /** Injectable for tests; defaults to the real Agent SDK `query`. */
  queryFn?: QueryFn;
  logger?: Pick<typeof Logger, 'debug' | 'info' | 'warn' | 'error'>;
}

/**
 * Drives Claude via the Agent SDK streaming-input `query()` (NOT one-shot
 * `claude -p`), so the session stays steerable — push user turns mid-run +
 * interrupt(). Applies the per-kind permission profile and parses the stream-json
 * telemetry (tokens / USD) back to the Run. Completes on the first `result`.
 */
export class ClaudeDriver implements AgentDriver {
  readonly tool = 'claude' as const;
  private readonly queryFn: QueryFn;
  private readonly log: Pick<typeof Logger, 'debug' | 'info' | 'warn' | 'error'>;

  constructor(deps: ClaudeDriverDeps = {}) {
    this.queryFn = deps.queryFn ?? realSdkQuery;
    this.log = deps.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
  }

  start(opts: DriverStartOptions): DriverSession {
    const input = new AsyncQueue<SdkUserMessage>();
    input.push(userTurn(opts.prompt));

    const perm = mapPermission(opts.permission, opts.kind);
    const abort = new AbortController();
    const query = this.queryFn({
      prompt: input,
      options: {
        cwd: opts.cwd,
        model: opts.model,
        // The agent's shell environment, with the daemon's OAuth token and cloud/git
        // credentials stripped, and git's credential paths neutered. Without this the
        // spawned `claude` inherits process.env verbatim: an allowlisted `npm test` that
        // shells out could read NORIQ_TOKEN, and `git push` could still prompt. The codex
        // driver and the verify runner have always sanitized — this path never did, which
        // made the security model's central claim false for the DEFAULT tool.
        env: sanitizedAgentEnv(),
        permissionMode: perm.permissionMode,
        allowedTools: perm.allowedTools,
        disallowedTools: perm.disallowedTools,
        abortController: abort,
        // Noriq over the MCP transport: the token rides an Authorization header, so
        // the agent can report its work without the secret ever entering its shell.
        ...(opts.noriqMcp
          ? {
              mcpServers: {
                [NORIQ_MCP_NAME]: {
                  type: 'http',
                  url: opts.noriqMcp.url,
                  headers: { Authorization: `Bearer ${opts.noriqMcp.token}` },
                },
              },
            }
          : {}),
        // ONLY the server we just injected. Otherwise a supervised agent silently
        // inherits the operator's personal MCP config (~/.claude.json, .mcp.json,
        // plugins) — their connectors, their credentials, none of it in the manifest.
        strictMcpConfig: true,
        ...(opts.budget?.maxUsd != null ? { maxBudgetUsd: opts.budget.maxUsd } : {}),
      },
    });

    let settle!: (exit: DriverExit) => void;
    const donePromise = new Promise<DriverExit>((resolve) => {
      settle = resolve;
    });
    let finished = false;
    /** Close the SDK session. Idempotent; safe after it is already gone. */
    const closeSession = () => {
      input.close();
      try {
        query.close?.();
      } catch {
        /* already gone */
      }
    };
    const finish = (exit: DriverExit) => {
      if (finished) return;
      finished = true;
      // multiTurn keeps the session alive past its first result so the caller can hand work back
      // (RUN-29's verify feedback loop, RUN-30's resume). The caller then owns it and must stop()
      // — an open query keeps the event loop alive, so this is opt-in and never the default.
      if (!opts.multiTurn) closeSession();
      opts.handlers?.onExit?.(exit);
      settle(exit);
    };

    /** Armed by continueWith: the next `result` belongs to that turn, not to done(). */
    let awaitingTurn: ((exit: DriverExit) => void) | null = null;

    const live = zeroTelemetry();
    const consume = async () => {
      try {
        for await (const msg of query) {
          if (msg.type === 'assistant') {
            const am = msg as SdkAssistantMessage;
            const text = extractText(am.message.content ?? []);
            if (text) opts.handlers?.onText?.(text);
            const u = am.message.usage;
            if (u) {
              // KNOWN BUG — RUN-34. These are SUMMED per assistant message, but each
              // message's usage describes its own API request, whose input is the entire
              // conversation so far. So the context gets counted once per turn and `live`
              // climbs well past the truth, then drops when `result` replaces it with the
              // SDK's own aggregate (telemetryFromResult, below).
              //
              // This is not cosmetic: superviseBudget's checkSpend reads totalTokens(live)
              // and SIGTERMs on maxTokens — so a long run can be killed for a breach that
              // never happened, and the terminal telemetry will contradict the reason it
              // died. Do NOT "fix" by guessing: confirm what result.usage and modelUsage
              // actually aggregate (sdk.d.ts SDKResultMessage) against a real run's frames
              // first, then make the live figure converge on that definition.
              live.inputTokens += u.input_tokens ?? 0;
              live.outputTokens += u.output_tokens ?? 0;
              live.cacheReadTokens += u.cache_read_input_tokens ?? 0;
              live.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
              live.numTurns += 1;
              opts.handlers?.onTelemetry?.({ ...live });
            }
          } else if (msg.type === 'result') {
            const rm = msg as SdkResultMessage;
            const telemetry = telemetryFromResult(rm);
            opts.handlers?.onTelemetry?.(telemetry);
            const exit: DriverExit = {
              outcome: rm.is_error ? 'failed' : 'done',
              isError: rm.is_error,
              reason: rm.subtype === 'success' ? null : rm.subtype,
              telemetry,
            };
            // A result that belongs to a continueWith turn settles THAT, not the run: the run is
            // not over, someone handed it more work and is waiting on the answer.
            const turn = awaitingTurn;
            awaitingTurn = null;
            if (turn) {
              // Someone is waiting on this turn; the run is not over. Keep reading — under
              // multiTurn more turns may follow.
              turn(exit);
            } else {
              finish(exit);
              // Single-turn: the session closed with the result, so there is nothing left to
              // read. Under multiTurn the loop keeps going and stop() is what ends it.
              if (!opts.multiTurn) return;
            }
          }
        }
        // Stream ended without a result — treat as failure.
        finish({
          outcome: 'failed',
          isError: true,
          reason: 'stream ended without a result',
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
      pushInput: (text: string): boolean => input.push(userTurn(text)),
      // Only meaningful under multiTurn; the contract marks it optional for exactly that reason.
      continueWith: opts.multiTurn
        ? (text: string): Promise<DriverExit> =>
            new Promise<DriverExit>((resolve, reject) => {
              if (awaitingTurn) return reject(new Error('a turn is already in flight'));
              awaitingTurn = resolve;
              if (!input.push(userTurn(text))) {
                awaitingTurn = null;
                reject(new Error('session input is closed — the turn was not delivered'));
              }
            })
        : undefined,
      interrupt: async () => {
        await query.interrupt().catch((err) => this.log.warn('interrupt failed', { err: String(err) }));
      },
      stop: async () => {
        abort.abort();
        // Close explicitly: under multiTurn, finish() deliberately does NOT, so stop() is the
        // only thing that ever shuts the query down. Without this a multi-turn run would leave
        // the SDK session open and the daemon would never exit.
        closeSession();
        finish({ outcome: 'failed', isError: true, reason: 'stopped', telemetry: { ...live } });
      },
      done: () => donePromise,
    };
  }
}
