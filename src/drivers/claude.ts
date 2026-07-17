import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionProfile, RunEffort, RunKind } from '@noriq-dev/shared';
import { AsyncQueue } from '../async-queue';
import type { logger as Logger } from '../logger';
import { noriqToolNamesFor, sanitizedAgentEnv } from '../security';
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
  /** Every SDK message carries it; it is what `resume` takes (RUN-30). */
  session_id?: string;
}
/** A raw streaming delta (`includePartialMessages`). Its text_deltas are the model's
 *  exact token stream — newlines and all — which the assembled `assistant` message loses
 *  at content-block/turn boundaries (RUN-77). We read text from here and keep the
 *  assistant message for usage only. Minimal shape; we touch only text_delta. */
export interface SdkPartialAssistantMessage {
  type: 'stream_event';
  event: { type: string; delta?: { type: string; text?: string } };
  session_id?: string;
}
/** The SDK's per-model aggregate (sdk.d.ts `ModelUsage`). The only complete record of what a run
 *  spent — `usage` describes one model's path and silently omits sub-agents. See
 *  telemetryFromResult for the measurements. */
export interface SdkModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
}
export interface SdkResultMessage {
  type: 'result';
  subtype: string; // 'success' | 'error_max_turns' | 'error_max_budget_usd' | 'error_during_execution' | ...
  is_error: boolean;
  num_turns: number;
  total_cost_usd: number;
  usage: SdkUsage;
  /** Keyed by model id, e.g. 'claude-opus-4-8[1m]' and 'claude-haiku-4-5-20251001'. */
  modelUsage?: Record<string, SdkModelUsage>;
  stop_reason?: string | null;
  session_id?: string;
}
export type SdkMessage =
  | SdkAssistantMessage
  | SdkPartialAssistantMessage
  | SdkResultMessage
  | { type: 'system'; subtype?: string; session_id?: string }
  | { type: string; session_id?: string };

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
  /** The SDK's own EffortLevel — RunEffort's values match it exactly, which is why the Claude
   *  driver passes through where the codex one maps (RUN-33). */
  effort?: RunEffort;
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
  /**
   * Session id to resume — loads that conversation's history (RUN-30).
   *
   * Measured, because the failure mode is silent (a resume that doesn't take just starts fresh,
   * losing exactly the context this exists to save): a closed streaming-input session resumes
   * with its context intact and KEEPS THE SAME session id rather than forking. So one persisted
   * id resumes any number of times.
   */
  resume?: string;
  /** Emit SDKPartialAssistantMessage stream events — the raw text-delta stream we read
   *  for a byte-faithful transcript (RUN-77). */
  includePartialMessages?: boolean;
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

/** The Noriq MCP tool ids a kind is allowed to call, in the Claude SDK's naming. The LIST is
 *  policy and lives in security.ts (RUN-46 — for a year it lived here, which quietly made the
 *  per-kind Noriq floor a Claude-only property); this only applies the SDK's prefix. */
export const noriqToolsFor = (kind: RunKind): string[] =>
  noriqToolNamesFor(kind).map((t) => `mcp__${NORIQ_MCP_NAME}__${t}`);

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

  // AUTO (RUN-68): the repo opted this kind into Claude's own bypass mode — everything is
  // approved except what `disallowedTools` names, and deny outranks bypass, so the write axis
  // above SURVIVES auto. Bare `Bash` is deliberately not denied here: unrestricted execution is
  // what auto means. The honest cost: bash can mutate files, so for a read-only kind auto
  // weakens "cannot edit" from tool-enforced to edit-tools-only (scope keeps its physical
  // chmod; verify does not). Push credentials and the Noriq tool floor hold regardless — the
  // first is absent from the env, the second is enforced by the server's own tool registration
  // (RUN-47), which bypass mode cannot talk its way past.
  if (profile.auto) {
    return {
      permissionMode: 'bypassPermissions',
      allowedTools: dedupe(allowed),
      disallowedTools: dedupe(disallowed),
    };
  }

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

/**
 * The run's true totals, from `modelUsage` rather than `usage` (RUN-34).
 *
 * `result.usage` describes ONE model's path. `result.modelUsage` is the SDK's per-model aggregate,
 * and it is the only complete picture — measured on a real 2-message run:
 *
 *   summed assistant messages : input 4    output 70  cacheRead 40554  cacheCreate 5332
 *   result.usage              : input 4    output 79  cacheRead 40554  cacheCreate 5332
 *   summed modelUsage         : input 540  output 93  cacheRead 40554  cacheCreate 5332
 *
 * The 536 missing input tokens are a haiku sub-agent the primary path never mentions. `usage`
 * cannot see it; `modelUsage` lists it as its own model. The clincher is cost: `total_cost_usd`
 * (0.076198) equals the sum of modelUsage's per-model costUSD to the last digit, and does NOT
 * match anything derivable from `usage` alone. So modelUsage is what the SDK itself bills from.
 *
 * Reading `usage` therefore UNDER-reports: whole models are silently free. A budget enforced on
 * that number does not bind, and the dashboard's spend is wrong low.
 */
function telemetryFromResult(m: SdkResultMessage): DriverTelemetry {
  const models = Object.values(m.modelUsage ?? {});
  if (!models.length) {
    // No modelUsage (an older SDK, or a result shape we have not seen) — fall back rather than
    // report zero. Under-reporting beats inventing.
    return {
      inputTokens: m.usage.input_tokens ?? 0,
      outputTokens: m.usage.output_tokens ?? 0,
      cacheReadTokens: m.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: m.usage.cache_creation_input_tokens ?? 0,
      costUsd: m.total_cost_usd,
      numTurns: m.num_turns,
    };
  }
  return {
    inputTokens: models.reduce((a, u) => a + (u.inputTokens ?? 0), 0),
    outputTokens: models.reduce((a, u) => a + (u.outputTokens ?? 0), 0),
    cacheReadTokens: models.reduce((a, u) => a + (u.cacheReadInputTokens ?? 0), 0),
    cacheCreationTokens: models.reduce((a, u) => a + (u.cacheCreationInputTokens ?? 0), 0),
    // total_cost_usd is the SDK's own sum of these — verified equal to the last digit.
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
        // Stream raw text deltas so the transcript is byte-faithful (RUN-77). The assembled
        // `assistant` message joins content blocks with '' and drops the newlines the model
        // put between them — invisible in prose but it clumps a whole bulleted review into
        // one paragraph. The deltas are the exact token stream; we read text from them.
        includePartialMessages: true,
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
        // Only when asked (RUN-33): omitting these is what lets the tool apply its own default,
        // which is what every run got before this existed.
        ...(opts.effort ? { effort: opts.effort } : {}),
        ...(opts.budget?.maxUsd != null ? { maxBudgetUsd: opts.budget.maxUsd } : {}),
        // Bring a parked run's context back rather than starting over (RUN-30). Same cwd, so
        // the session's own worktree is where it left it.
        ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
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
    const finish = (raw: DriverExit) => {
      if (finished) return;
      finished = true;
      // Carry the session id out on the exit: parking happens BECAUSE the session ended, so the
      // supervisor's only chance to learn what to resume is the exit itself (RUN-30).
      const exit: DriverExit = { ...raw, sessionId: session.sessionId ?? null };
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
    // Text is streamed byte-faithfully from stream_event deltas (RUN-77); this tracks
    // whether the current turn produced any, so the assembled assistant message only
    // supplies text as a fallback (a transport without partial messages, or the tests).
    let sawDeltaText = false;
    const consume = async () => {
      try {
        for await (const msg of query) {
          // Every message carries it, and resuming keeps the SAME id, so the first one to
          // arrive is the one to remember (RUN-30). Read off the union rather than per-branch:
          // the id shows up on system messages too, i.e. before the first assistant turn.
          const sid = (msg as { session_id?: string }).session_id;
          if (sid) session.sessionId = sid;
          if (msg.type === 'stream_event') {
            // The model's exact bytes, delta by delta — the only faithful source for the
            // transcript. Only text_delta; thinking/tool-input deltas are not agent prose.
            const ev = (msg as SdkPartialAssistantMessage).event;
            if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
              sawDeltaText = true;
              opts.handlers?.onText?.(ev.delta.text);
            }
            continue;
          }
          if (msg.type === 'assistant') {
            const am = msg as SdkAssistantMessage;
            // Only if the turn streamed no deltas — extractText joins blocks with '' and
            // drops inter-block newlines, so the deltas are always preferred when present.
            if (!sawDeltaText) {
              const text = extractText(am.message.content ?? []);
              if (text) opts.handlers?.onText?.(text);
            }
            sawDeltaText = false;
            const u = am.message.usage;
            if (u) {
              // RUN-34, measured rather than assumed. The old comment here claimed this sum
              // "climbs well past the truth, then drops when result replaces it". A real 2-message
              // run says otherwise — summing these tracks result.usage almost exactly:
              //
              //   summed here  : input 4  output 70  cacheRead 40554  cacheCreate 5332
              //   result.usage : input 4  output 79  cacheRead 40554  cacheCreate 5332
              //
              // So the live figure is not inflated. It is INCOMPLETE, in the same way result.usage
              // is: both see only the primary model's messages, while modelUsage showed a haiku
              // sub-agent had also burned 536 input / 14 output. The terminal figure now sums
              // modelUsage (telemetryFromResult), so live is a lower bound that steps UP at the
              // end rather than a wrong number that drops.
              //
              // What that means for the budget: superviseBudget reads totalTokens(live), so a
              // ceiling binds on primary-model spend and under-counts sub-agents — it enforces
              // late, never early. A run is not killed for a breach that never happened.
              //
              // Still not perfect: cacheRead is summed per message, and each message's cacheRead
              // is that request's whole context — so a long conversation counts the same cached
              // context once per turn. That IS what you are billed (each request reads it), and
              // result.usage agrees, so it is not double-counting — it is what cache reads cost.
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
    const session: DriverSession = {
      runId: opts.runId,
      // Assigned as soon as the stream says it (see consume). Seeded with what we asked to
      // resume so a resumed session has an id before its first message even lands.
      sessionId: opts.resumeSessionId ?? null,
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
    // Start consuming only once `session` exists — consume() writes the session id onto it.
    void consume();
    return session;
  }
}
