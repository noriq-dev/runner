import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionProfile, RunEffort, RunKind } from '@noriq-dev/shared';
import { DEFAULT_CLAUDE_HOME, createEphemeralAgentHome, ensurePrivateAgentHome } from '../agent-homes';
import { AsyncQueue } from '../async-queue';
import type { LockEnforcer } from '../lock-hooks';
import type { logger as Logger } from '../logger';
import {
  type AgentProcessContainment,
  type ContainedAgentProcess,
  isCommissionedAgentProcessContainment,
} from '../process-containment';
import { reattestProjectMcpExecutablesSync } from '../project-mcp';
import { noriqToolNamesFor, projectMcpProcessEnv, sanitizedAgentEnv } from '../security';
import {
  type AgentDriver,
  type DriverCapabilities,
  type DriverCatalog,
  type DriverExit,
  type DriverSession,
  type DriverStartOptions,
  type DriverTelemetry,
  type ModelUsage,
  type ProjectMcpSession,
  validateDriverMcpAuthority,
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
  /** Present on the installed Agent SDK. Required when a project MCP bundle is supplied. */
  initializationResult?(): Promise<unknown>;
  /** Effective runtime inventory, not merely the options Runner intended to pass. */
  mcpServerStatus?(): Promise<SdkMcpServerStatus[]>;
}
/** Narrow mirrors of the SDK MCP transports Runner configures explicitly. */
export interface SdkMcpHttpServer {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  alwaysLoad?: boolean;
}
export interface SdkMcpSseServer {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
  alwaysLoad?: boolean;
}
export interface SdkMcpStdioServer {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  alwaysLoad?: boolean;
}
export type SdkMcpServer = SdkMcpHttpServer | SdkMcpSseServer | SdkMcpStdioServer;
export interface SdkMcpServerStatus {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  error?: string;
  /** Effective tools reported by the installed SDK for this server. */
  tools?: Array<{ name: string }>;
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
  /** Empty disables every built-in Agent SDK tool. */
  tools?: string[];
  abortController?: AbortController;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Advisory SDK task pacing; the commissioned provider boundary remains the hard authority. */
  taskBudget?: { total: number };
  mcpServers?: Record<string, SdkMcpServer>;
  /** In-process hooks (RUN-101): PreToolUse denies an edit to a locked path, Stop releases. */
  hooks?: Partial<Record<'PreToolUse' | 'Stop' | 'SubagentStop', SdkHookMatcher[]>>;
  /** Ignore all ambient MCP config (user settings, .mcp.json, plugins). */
  strictMcpConfig?: boolean;
  /** Filesystem settings sources. RUN-291 admits only Runner's dedicated user source. */
  settingSources?: Array<'user' | 'project' | 'local'>;
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
  /** Installed SDK seam used to put the CLI and all tool/MCP descendants in one boundary. */
  spawnClaudeCodeProcess?: (options: SdkSpawnOptions) => ChildProcessWithoutNullStreams;
  /** Exact native CLI selected from the installed Agent SDK optional dependency. */
  pathToClaudeCodeExecutable?: string;
}
export interface SdkSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: { [envVar: string]: string | undefined };
  signal: AbortSignal;
}
/**
 * Narrow mirror of the SDK's in-process hook shape (RUN-101), the same anti-corruption pattern
 * as the message mirrors above — we emit exactly this (verified against sdk.d.ts `HookCallback` /
 * `PreToolUseHookSpecificOutput`), and tests inject a fake `queryFn` that invokes it.
 */
export interface SdkHookInput {
  hook_event_name: string;
  tool_name?: string;
  tool_input?: unknown;
}
export interface SdkHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse';
    permissionDecision?: 'allow' | 'deny' | 'ask' | 'defer';
    permissionDecisionReason?: string;
  };
}
export type SdkHookCallback = (
  input: SdkHookInput,
  toolUseId: string | undefined,
  opts: { signal: AbortSignal },
) => Promise<SdkHookOutput>;
export interface SdkHookMatcher {
  matcher?: string;
  hooks: SdkHookCallback[];
}

export type QueryFn = (args: {
  prompt: AsyncIterable<SdkUserMessage>;
  options?: SdkQueryOptions;
}) => SdkQuery;

export interface ClaudeAgentSdkInstallation {
  sdkPackageName: '@anthropic-ai/claude-agent-sdk';
  sdkEntryPath: string;
  sdkPackageJsonPath: string;
  nativePackageName: string;
  nativePackageJsonPath: string;
  executablePath: string;
}

const moduleRequire = createRequire(import.meta.url);

function sdkPrefersMusl(): boolean {
  if (process.platform !== 'linux') return false;
  const report =
    typeof process.report?.getReport === 'function'
      ? (process.report.getReport() as { header?: { glibcVersionRuntime?: string } })
      : null;
  return report !== null && report.header?.glibcVersionRuntime === undefined;
}

/**
 * Mirror the installed Agent SDK's native-package selection exactly. Resolving relative to the
 * SDK entry (rather than Runner) also works when npm keeps optional dependencies nested.
 */
export function resolveClaudeAgentSdkInstallation(): ClaudeAgentSdkInstallation {
  const sdkPackageName = '@anthropic-ai/claude-agent-sdk' as const;
  const sdkEntryPath = realpathSync(moduleRequire.resolve(sdkPackageName));
  const sdkRequire = createRequire(sdkEntryPath);
  const executableName = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const base = sdkPackageName;
  const nativePackages =
    process.platform === 'android'
      ? [`${base}-linux-${process.arch}-android`]
      : process.platform === 'linux'
        ? sdkPrefersMusl()
          ? [`${base}-linux-${process.arch}-musl`, `${base}-linux-${process.arch}`]
          : [`${base}-linux-${process.arch}`, `${base}-linux-${process.arch}-musl`]
        : [`${base}-${process.platform}-${process.arch}`];

  for (const nativePackageName of nativePackages) {
    try {
      const selected = sdkRequire.resolve(`${nativePackageName}/${executableName}`);
      if (!existsSync(selected)) continue;
      return {
        sdkPackageName,
        sdkEntryPath,
        sdkPackageJsonPath: realpathSync(path.join(path.dirname(sdkEntryPath), 'package.json')),
        nativePackageName,
        nativePackageJsonPath: realpathSync(sdkRequire.resolve(`${nativePackageName}/package.json`)),
        executablePath: realpathSync(selected),
      };
    } catch {
      // Continue in the SDK's platform/libc preference order.
    }
  }
  throw new Error(
    `Native Claude CLI for ${process.platform}-${process.arch} is unavailable from the installed ${sdkPackageName} optional dependencies`,
  );
}

export function resolveClaudeCodeExecutable(): string {
  return resolveClaudeAgentSdkInstallation().executablePath;
}

// ---------------------------------------------------------------------------
// Permission profile → Agent SDK options. Headless (`dontAsk`) so nothing ever
// blocks on an interactive prompt; the allowlist IS the enforcement. Bare `Bash`
// is never granted for a build — the manifest's `allow` carries the bash
// allowlist rules (e.g. "Bash(npm test:*)"), matching "edit + bash-allowlist".
// ---------------------------------------------------------------------------
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite'];
const EDIT_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'];
const dedupe = (xs: string[]): string[] => [...new Set(xs)];
const PROJECT_MCP_ATTESTATION_TIMEOUT_MS = 10_000;
const PROJECT_MCP_ATTESTATION_POLL_MS = 50;
export const CLAUDE_CONTAINED_GRACEFUL_STOP_MS = 3_000;
export const CLAUDE_CONTAINED_FORCE_STOP_MS = 5_000;

function waitForContainedExit(handle: ContainedAgentProcess, timeoutMs: number): Promise<boolean> {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(exited);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    handle.exited.then(
      () => finish(true),
      () => finish(false),
    );
  });
}

async function proveContainedExit(handle: ContainedAgentProcess): Promise<void> {
  if (await waitForContainedExit(handle, CLAUDE_CONTAINED_GRACEFUL_STOP_MS)) return;
  handle.child.kill('SIGTERM');
  if (await waitForContainedExit(handle, CLAUDE_CONTAINED_GRACEFUL_STOP_MS)) return;
  handle.child.kill('SIGKILL');
  if (await waitForContainedExit(handle, CLAUDE_CONTAINED_FORCE_STOP_MS)) return;
  throw new Error(
    `Claude containment did not exit within ${CLAUDE_CONTAINED_GRACEFUL_STOP_MS * 2}ms graceful plus ${CLAUDE_CONTAINED_FORCE_STOP_MS}ms forced shutdown`,
  );
}

/** The name the daemon's MCP server is registered under → tools are `mcp__noriq__*`. */
export const NORIQ_MCP_NAME = 'noriq';

/** The Noriq MCP tool ids a kind is allowed to call, in the Claude SDK's naming. The LIST is
 *  policy and lives in security.ts (RUN-46 — for a year it lived here, which quietly made the
 *  per-kind Noriq floor a Claude-only property); this only applies the SDK's prefix. */
export const noriqToolsFor = (kind: RunKind): string[] =>
  noriqToolNamesFor(kind).map((t) => `mcp__${NORIQ_MCP_NAME}__${t}`);

/**
 * The PreToolUse + Stop hook option that wires an in-process LockEnforcer into the SDK (RUN-101).
 * PreToolUse asks the enforcer to lock the tool's write set; a conflict → `permissionDecision:
 * 'deny'` with the conflict text, which the SDK feeds back to the model. Stop releases.
 */
export function lockHooks(enforcer: LockEnforcer): NonNullable<SdkQueryOptions['hooks']> {
  return {
    PreToolUse: [
      {
        hooks: [
          async (input): Promise<SdkHookOutput> => {
            const reason = await enforcer.guard(
              input.tool_name ?? '',
              (input.tool_input as Record<string, unknown>) ?? {},
            );
            return reason
              ? {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                    permissionDecisionReason: reason,
                  },
                }
              : {};
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          async (): Promise<SdkHookOutput> => {
            await enforcer.releaseHeld();
            return {};
          },
        ],
      },
    ],
  };
}

export function mapPermission(
  profile: PermissionProfile,
  kind: RunKind,
  noriqTools?: readonly string[],
  projectMcp?: ProjectMcpSession,
): {
  permissionMode: string;
  allowedTools: string[];
  disallowedTools: string[];
} {
  const allowed = [...READ_TOOLS];
  if (profile.write) allowed.push(...EDIT_TOOLS);
  // The agent reports its own work through Noriq — without these the prompt's
  // "register + claim + report" contract is unsatisfiable and the run is a no-op.
  // A stage actor's narrowed set (DriverStartOptions.noriqTools) replaces the kind floor when
  // present: it shares the run's identity, so the server advertises the run's full catalogue,
  // and this narrowing is what keeps the extra tools out of the actor's hands.
  const noriq = noriqTools ? noriqTools.map((t) => `mcp__${NORIQ_MCP_NAME}__${t}`) : noriqToolsFor(kind);
  allowed.push(...noriq);
  // The project declaration supplies server transports, while the trusted execution profile
  // supplies exact tools. A server wildcard would turn declaration into authority, so never emit
  // one here.
  const exactProjectTools = new Set<string>();
  if (projectMcp) {
    for (const name of Object.keys(projectMcp.toolGrants).sort()) {
      for (const tool of projectMcp.toolGrants[name] ?? []) {
        exactProjectTools.add(`mcp__${name}__${tool}`);
      }
    }
    for (const rule of profile.allow) {
      const addressesProjectServer = Object.keys(projectMcp.toolGrants).some((name) =>
        rule.startsWith(`mcp__${name}__`),
      );
      if (
        (rule.startsWith('mcp__') && rule.includes('*')) ||
        (addressesProjectServer && !exactProjectTools.has(rule))
      ) {
        throw new Error(`permission allowlist may not widen exact project MCP grants: ${rule}`);
      }
    }
  }
  allowed.push(...exactProjectTools);
  allowed.push(...profile.allow);

  const disallowed = [...profile.deny];
  // No edit tools without write — that is what read-only means, and it is the property
  // that stops a VERIFY agent from "fixing" the code it is supposed to be judging.
  if (!profile.write) disallowed.push(...EDIT_TOOLS);
  // The complement of a narrowed set is DENIED, not merely un-allowed. Deny outranks bypass, so
  // this is the half that holds under `auto = true` — an allowlist alone gates nothing there.
  // The universe is EVERY kind's floor, not this session's: a stage actor runs under the RUN's
  // shared credential, so the server advertises the run's catalogue — an inline reviewer spawned
  // as `verify` inside a build run can see `claim_task`, and denying only the verify floor would
  // leave every build-only tool reachable under bypass.
  if (noriqTools) {
    const catalogue = new Set((['scope', 'build', 'verify'] as RunKind[]).flatMap((k) => noriqToolsFor(k)));
    disallowed.push(...[...catalogue].filter((t) => !noriq.includes(t)));
  }

  // AUTO (RUN-68): the repo opted this kind into Claude's own bypass mode — everything is
  // approved except what `disallowedTools` names, and deny outranks bypass, so the write axis
  // above SURVIVES auto. Bare `Bash` is deliberately not denied here: unrestricted execution is
  // what auto means. The honest cost: bash can mutate files, so for a read-only kind auto
  // weakens "cannot edit" from tool-enforced to edit-tools-only (scope keeps its physical
  // chmod; verify does not). Push credentials and the Noriq tool floor hold regardless — the
  // first is absent from the env, the second is enforced by the server's own tool registration
  // (RUN-47), which bypass mode cannot talk its way past.
  // Project MCP tools require the allowlist to be the enforcement boundary. Claude's bypass mode
  // treats allowedTools as hints rather than a ceiling, so a session with project capability is
  // always headless dontAsk even if the general repo profile opted into auto.
  if (profile.auto && Object.keys(projectMcp?.toolGrants ?? {}).length === 0) {
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
  // Object.ENTRIES, not values (RUN-59): the KEYS are the model ids, and they are the whole point
  // of the breakdown — the run above measured a haiku sub-agent the primary path never named.
  const models = Object.entries(m.modelUsage ?? {});
  if (!models.length) {
    // No modelUsage (an older SDK, or a result shape we have not seen) — fall back rather than
    // report zero. Under-reporting beats inventing. Deliberately NO modelUsage: a mix built from
    // the `usage` fallback would claim one model incurred everything, which is the exact lie
    // RUN-59 removes — absent reads as "not reported", a single invented model reads as truth.
    return {
      inputTokens: m.usage.input_tokens ?? 0,
      outputTokens: m.usage.output_tokens ?? 0,
      cacheReadTokens: m.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: m.usage.cache_creation_input_tokens ?? 0,
      costUsd: m.total_cost_usd,
      numTurns: m.num_turns,
    };
  }
  // The literal per-model facts, SDK keys un-renamed (RUN-59). Not percentages, not derived: the
  // percentage denominator (tokens vs cost) is a fork with no right answer, so the daemon stores the
  // raw numbers and the UI decides. All four token classes kept — the totals are computed from all
  // four, so a breakdown that dropped cache tokens would not sum to the figure shown beside it.
  const modelUsage: Record<string, ModelUsage> = {};
  for (const [id, u] of models) {
    modelUsage[id] = {
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      cacheReadInputTokens: u.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: u.cacheCreationInputTokens ?? 0,
      costUSD: u.costUSD ?? 0,
    };
  }
  return {
    inputTokens: models.reduce((a, [, u]) => a + (u.inputTokens ?? 0), 0),
    outputTokens: models.reduce((a, [, u]) => a + (u.outputTokens ?? 0), 0),
    cacheReadTokens: models.reduce((a, [, u]) => a + (u.cacheReadInputTokens ?? 0), 0),
    cacheCreationTokens: models.reduce((a, [, u]) => a + (u.cacheCreationInputTokens ?? 0), 0),
    // total_cost_usd is the SDK's own sum of these — verified equal to the last digit.
    costUsd: m.total_cost_usd,
    numTurns: m.num_turns,
    modelUsage,
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
  /** Injectable so tests never create or chmod the operator's real ~/.noriq/claude. */
  claudeHome?: string;
  prepareClaudeHome?: (home: string) => void;
  /** Required for mission execution; ordinary legacy Runs may continue without it. */
  containment?: AgentProcessContainment;
  /** Exact SDK-native CLI selected during mission runtime preflight. Legacy Runs do not need it. */
  claudeCodeExecutable?: string;
  /** Test seam; production re-attests local MCP executables immediately before provider spawn. */
  reattestProjectMcpExecutables?: typeof reattestProjectMcpExecutablesSync;
  /** Test seam; production materializes a credential-only home for every mission attempt. */
  createAttemptHome?: typeof createEphemeralAgentHome;
}

/**
 * Drives Claude via the Agent SDK streaming-input `query()` (NOT one-shot
 * `claude -p`), so the session stays steerable — push user turns mid-run +
 * interrupt(). Applies the per-kind permission profile and parses the stream-json
 * telemetry (tokens / USD) back to the Run. Completes on the first `result`.
 */
/**
 * Claude's advertised coordinate menu (RUN-115). A suggestion for the picker, not a whitelist —
 * `model` is free-form on the wire, so a newer id the daemon has never heard of still dispatches.
 * Newest-first; the SDK takes every RunEffort verbatim.
 */
export const CLAUDE_CATALOG: DriverCatalog = {
  models: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5'],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
};

export class ClaudeDriver implements AgentDriver {
  readonly tool = 'claude' as const;
  // The Agent SDK gives us all four (RUN-110): in-process hooks (lockHooks below), soft steer +
  // interrupt on the streaming session, a resumable session id, and a per-model spend aggregate.
  readonly capabilities: DriverCapabilities;
  readonly catalog: DriverCatalog = CLAUDE_CATALOG;
  private readonly queryFn: QueryFn;
  private readonly log: Pick<typeof Logger, 'debug' | 'info' | 'warn' | 'error'>;
  private readonly claudeHome: string;
  private readonly prepareClaudeHome: (home: string) => void;
  private readonly containment?: AgentProcessContainment;
  private readonly claudeCodeExecutable?: string;
  private readonly reattestProjectMcpExecutables: typeof reattestProjectMcpExecutablesSync;
  private readonly createAttemptHome: typeof createEphemeralAgentHome;

  constructor(deps: ClaudeDriverDeps = {}) {
    // An injected query implementation is opaque: Runner cannot prove it honors the SDK custom
    // spawn seam. It may still be used by direct tests, but never earns mission capabilities.
    const containedSdk = deps.containment !== undefined && deps.queryFn === undefined;
    this.queryFn = deps.queryFn ?? realSdkQuery;
    this.log = deps.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
    this.claudeHome = deps.claudeHome ?? DEFAULT_CLAUDE_HOME;
    this.prepareClaudeHome = deps.prepareClaudeHome ?? ensurePrivateAgentHome;
    this.reattestProjectMcpExecutables =
      deps.reattestProjectMcpExecutables ?? reattestProjectMcpExecutablesSync;
    this.createAttemptHome = deps.createAttemptHome ?? createEphemeralAgentHome;
    this.containment = deps.containment;
    this.claudeCodeExecutable = deps.claudeCodeExecutable;
    this.capabilities = Object.freeze({
      toolHooks: true,
      steer: true,
      interrupt: true,
      resumableSession: true,
      perModelTelemetry: true,
      toolFreeSession: true,
      workspaceIsolatedSession: containedSdk,
      projectMcpProcessContainment: containedSdk,
      ...(containedSdk && isCommissionedAgentProcessContainment(deps.containment)
        ? { commissionedExecutionBoundary: true as const }
        : {}),
      ...(containedSdk && deps.containment?.capabilities.providerTokenEnvelope === true
        ? { hardTokenEnvelope: true as const }
        : {}),
      // The SDK's custom spawn seam exposes the actual CLI process. With a containment provider,
      // its exit tears down the PID namespace and therefore covers every tool/MCP descendant.
      terminationAcknowledgement: containedSdk ? 'process-tree' : 'none',
    });
  }

  start(opts: DriverStartOptions): DriverSession {
    if (opts.tokenEnvelope) {
      if (
        !Number.isSafeInteger(opts.tokenEnvelope.totalTokens) ||
        opts.tokenEnvelope.totalTokens < 1 ||
        !Number.isSafeInteger(opts.tokenEnvelope.maxTurns) ||
        opts.tokenEnvelope.maxTurns < 1
      ) {
        throw new Error('Claude token envelope must contain positive safe-integer limits');
      }
      if (
        !isCommissionedAgentProcessContainment(this.containment) ||
        this.containment.capabilities.providerTokenEnvelope !== true
      ) {
        throw new Error('Claude driver has no commissioned hard token-envelope authority');
      }
      const delegates = opts.permission.allow.filter(
        (rule) =>
          rule === 'Agent' || rule.startsWith('Agent(') || rule === 'Task' || rule.startsWith('Task('),
      );
      if (delegates.length > 0) {
        throw new Error('Claude native delegation is unavailable without live subagent metering');
      }
    }
    this.prepareClaudeHome(this.claudeHome);
    if (opts.workspaceRoot) {
      if (
        !path.isAbsolute(opts.workspaceRoot) ||
        path.resolve(opts.cwd) !== path.resolve(opts.workspaceRoot)
      ) {
        throw new Error('Claude mission cwd must exactly match its absolute workspace root');
      }
      if (!this.containment) throw new Error('Claude driver cannot attest mission workspace isolation');
    }
    if (opts.toolAccess === 'none' && (opts.noriqMcp || opts.projectMcp)) {
      throw new Error('tool-free Claude sessions may not receive MCP authority');
    }
    const sdkSelectedClaudeCodeExecutable = opts.workspaceRoot ? resolveClaudeCodeExecutable() : undefined;
    if (
      sdkSelectedClaudeCodeExecutable &&
      this.claudeCodeExecutable &&
      realpathSync(this.claudeCodeExecutable) !== sdkSelectedClaudeCodeExecutable
    ) {
      throw new Error('Claude mission executable no longer matches the installed Agent SDK selection');
    }
    const missionClaudeCodeExecutable = sdkSelectedClaudeCodeExecutable;
    if (missionClaudeCodeExecutable && !path.isAbsolute(missionClaudeCodeExecutable)) {
      throw new Error('Claude mission executable must be an absolute SDK-native path');
    }
    const input = new AsyncQueue<SdkUserMessage>();
    const projectMcpNames = validateDriverMcpAuthority(opts.noriqMcp, opts.projectMcp);
    const projectToolGrants: Record<string, readonly string[]> = {};
    for (const name of projectMcpNames) {
      projectToolGrants[name] = [...(opts.projectMcp?.toolGrants[name] ?? [])];
    }
    const projectMcp: ProjectMcpSession | undefined = opts.projectMcp
      ? { bundle: opts.projectMcp.bundle, toolGrants: projectToolGrants }
      : undefined;
    if (projectMcpNames.includes(NORIQ_MCP_NAME)) {
      throw new Error(`project MCP server name '${NORIQ_MCP_NAME}' is reserved by Runner`);
    }
    // Intended SDK options are not proof of the effective MCP surface. Any session with MCP
    // authority — including a Noriq-only legacy Run — must prove the connected inventory before
    // Runner releases the first user turn (and therefore before model spend begins).
    const requiresMcpAttestation = projectMcpNames.length > 0 || opts.noriqMcp !== undefined;
    const baseAgentEnv = opts.env ?? sanitizedAgentEnv();
    let attemptHome: ReturnType<typeof createEphemeralAgentHome> | null = null;
    let claudeHome = this.claudeHome;
    const agentEnv = {
      ...baseAgentEnv,
      HOME: claudeHome,
      // Override, never default: Runner state belongs under ~/.noriq/claude, and the user's
      // interactive ~/.claude settings/plugins/hooks must not enter an unattended session.
      CLAUDE_CONFIG_DIR: claudeHome,
    };
    let containedProcess: ContainedAgentProcess | null = null;
    const spawnClaudeCodeProcess = this.containment
      ? (spawnOptions: SdkSpawnOptions): ChildProcessWithoutNullStreams => {
          if (containedProcess) throw new Error('Claude SDK attempted to spawn more than one managed CLI');
          if (missionClaudeCodeExecutable && spawnOptions.command !== missionClaudeCodeExecutable) {
            throw new Error('Claude SDK changed the attested mission executable before spawn');
          }
          const spawnCwd = path.resolve(spawnOptions.cwd ?? opts.cwd);
          if (spawnCwd !== path.resolve(opts.cwd)) {
            throw new Error('Claude SDK changed the attested mission cwd before spawn');
          }
          if (projectMcp) {
            this.reattestProjectMcpExecutables(projectMcp.bundle, projectMcpNames);
          }
          try {
            containedProcess =
              this.containment?.spawn({
                runId: opts.runId,
                command: spawnOptions.command,
                args: spawnOptions.args,
                cwd: spawnCwd,
                workspaceRoot: opts.workspaceRoot ?? opts.cwd,
                workspaceWrite: opts.permission.write,
                env: {
                  ...spawnOptions.env,
                  HOME: claudeHome,
                  CLAUDE_CONFIG_DIR: claudeHome,
                },
                providerCredentialRoots: [claudeHome],
                ...(opts.tokenEnvelope ? { providerTokenEnvelope: opts.tokenEnvelope } : {}),
                additionalReadOnlyRoots: projectMcpNames
                  .flatMap((name) => {
                    const authorization = projectMcp?.bundle.launcherAuthorizations[name];
                    return authorization
                      ? [authorization.resolvedCommand, ...authorization.readOnlyRoots]
                      : [];
                  })
                  .concat(opts.containmentReadOnlyRoots ?? []),
                protectedWorkspaceReadOnlyPaths: opts.protectedWorkspaceReadOnlyPaths,
                additionalWriteRoots: opts.containmentWriteRoots,
              }) ?? null;
          } catch (error) {
            // A synchronous refusal launches no process tree, so its unused seed is safe to erase.
            attemptHome?.cleanup();
            throw error;
          }
          if (!containedProcess) {
            attemptHome?.cleanup();
            throw new Error('Claude containment provider disappeared before spawn');
          }
          const held = containedProcess;
          const ownedAttemptHome = attemptHome;
          if (ownedAttemptHome) {
            void held.exited.then(
              () => {
                // This promise is the containment provider's complete process-tree boundary.
                // Direct-child exit is intentionally insufficient cleanup authority.
                try {
                  ownedAttemptHome.cleanup();
                } catch (error) {
                  opts.handlers?.onError?.(new Error(`Claude attempt-home cleanup failed: ${String(error)}`));
                }
              },
              (error) => {
                // A rejected containment acknowledgement does not prove every descendant exited.
                // Preserve the home rather than deleting a path a possibly-live process can use.
                this.log.error('Claude attempt home retained after ambiguous containment failure', {
                  err: String(error),
                  runId: opts.runId,
                });
              },
            );
          }
          spawnOptions.signal.addEventListener(
            'abort',
            () => {
              if (held.child.exitCode === null && held.child.signalCode === null) held.child.kill('SIGKILL');
            },
            { once: true },
          );
          return held.child;
        }
      : undefined;
    const mcpServers: Record<string, SdkMcpServer> = {};
    for (const name of projectMcpNames) {
      const server = opts.projectMcp?.bundle.servers[name];
      if (!server) continue;
      mcpServers[name] =
        server.transport === 'stdio'
          ? {
              type: 'stdio',
              command: projectMcp?.bundle.launcherAuthorizations[name]?.resolvedCommand ?? server.command,
              args: [...server.args],
              // MCP children receive the same stripped base as the agent plus only the
              // project-declared values. They never inherit the daemon process wholesale.
              env: projectMcpProcessEnv(baseAgentEnv, server.env),
            }
          : {
              type: server.transport,
              url: server.url,
              headers: server.headers,
            };
    }
    if (opts.noriqMcp) {
      mcpServers[NORIQ_MCP_NAME] = {
        type: 'http',
        url: opts.noriqMcp.url,
        headers: { Authorization: `Bearer ${opts.noriqMcp.token}` },
      };
    }

    const perm =
      opts.toolAccess === 'none'
        ? { permissionMode: 'dontAsk', allowedTools: [], disallowedTools: ['mcp__*'] }
        : mapPermission(opts.permission, opts.kind, opts.noriqTools, projectMcp);
    if (opts.tokenEnvelope) {
      // `modelUsage` is authoritative only at terminal result time. Prevent native Agent/Task
      // delegation so a child cannot spend through a subagent before live accounting sees it.
      perm.disallowedTools = dedupe([...perm.disallowedTools, 'Agent', 'Task']);
    }
    const abort = new AbortController();
    if (projectMcp) {
      this.reattestProjectMcpExecutables(projectMcp.bundle, projectMcpNames);
    }
    // Materialize the attempt home only after synchronous authority validation has passed, but
    // before the SDK can inspect its environment or launch the contained vendor process.
    if (opts.workspaceRoot) {
      attemptHome = this.createAttemptHome('claude', this.claudeHome);
      claudeHome = attemptHome.home;
      agentEnv.HOME = claudeHome;
      agentEnv.CLAUDE_CONFIG_DIR = claudeHome;
    }
    let query: SdkQuery;
    try {
      query = this.queryFn({
        prompt: input,
        options: {
          cwd: opts.cwd,
          model: opts.model,
          // The agent's shell environment: the daemon's OAuth token and cloud/git creds stripped,
          // git's credential paths neutered. Handed down pre-sanitized by the supervisor (RUN-109),
          // so this guarantee no longer depends on the driver remembering to do it; the `??` is the
          // test-only fallback for a start with no supervisor-provided env.
          env: agentEnv,
          permissionMode: perm.permissionMode,
          allowedTools: perm.allowedTools,
          disallowedTools: perm.disallowedTools,
          ...(opts.toolAccess === 'none' ? { tools: [] } : {}),
          abortController: abort,
          // Stream raw text deltas so the transcript is byte-faithful (RUN-77). The assembled
          // `assistant` message joins content blocks with '' and drops the newlines the model
          // put between them — invisible in prose but it clumps a whole bulleted review into
          // one paragraph. The deltas are the exact token stream; we read text from them.
          includePartialMessages: true,
          // Noriq over the MCP transport: the token rides an Authorization header, so
          // the agent can report its work without the secret ever entering its shell.
          ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
          // Reactive file locking (RUN-101): a PreToolUse hook denies an edit to a path another
          // agent holds, a Stop hook releases what this session took. Runs IN-PROCESS in the
          // daemon (the enforcer holds the run's token + lock client), so the credential never
          // enters the agent's shell — the whole reason sanitizedAgentEnv strips it. Injected by
          // the runner, so it cannot be skipped: the guaranteed variant of the PLNR client hook.
          ...(opts.lockEnforcer ? { hooks: lockHooks(opts.lockEnforcer) } : {}),
          // ONLY the server we just injected. Otherwise a supervised agent silently
          // inherits the operator's personal MCP config (~/.claude.json, .mcp.json,
          // plugins) — their connectors, their credentials, none of it in the manifest.
          strictMcpConfig: true,
          // The SDK defaults to user + project + local. Legacy Runs retain the isolated Runner user
          // source. Mission attempts load no filesystem settings at all: the managed home is writable
          // for SDK/auth state, so a prior child must not be able to persist hooks, plugins, skills,
          // permissions, or MCP authority into a later child or the guide. Mission authority arrives
          // only through these explicit options and the separately validated project bundle.
          settingSources: opts.workspaceRoot ? [] : ['user'],
          ...(missionClaudeCodeExecutable ? { pathToClaudeCodeExecutable: missionClaudeCodeExecutable } : {}),
          ...(spawnClaudeCodeProcess ? { spawnClaudeCodeProcess } : {}),
          // Only when asked (RUN-33): omitting these is what lets the tool apply its own default,
          // which is what every run got before this existed.
          ...(opts.effort ? { effort: opts.effort } : {}),
          ...(opts.budget?.maxUsd != null ? { maxBudgetUsd: opts.budget.maxUsd } : {}),
          ...(opts.tokenEnvelope
            ? {
                maxTurns: opts.tokenEnvelope.maxTurns,
                taskBudget: { total: opts.tokenEnvelope.totalTokens },
              }
            : {}),
          // Bring a parked run's context back rather than starting over (RUN-30). Same cwd, so
          // the session's own worktree is where it left it.
          ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
        },
      });
    } catch (error) {
      // No published containment handle means no process tree exists. Once spawn succeeds, only
      // the provider's complete-tree exit acknowledgement may remove the mounted home.
      if (!containedProcess) attemptHome?.cleanup();
      throw error;
    }
    let mcpAttested = !requiresMcpAttestation;

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
    const proveSessionExit = async (): Promise<void> => {
      if (!this.containment) return;
      const handle = containedProcess as ContainedAgentProcess | null;
      if (!handle) {
        // The closed SDK session never launched a process, so there is no process tree that could
        // still hold this home. Avoid leaking the pre-spawn credential seed on SDK startup errors.
        attemptHome?.cleanup();
        throw new Error('Claude SDK did not publish its contained process handle');
      }
      await proveContainedExit(handle);
    };
    let finishing: Promise<void> | null = null;
    let pendingFinish: DriverExit | null = null;
    const finish = (raw: DriverExit): Promise<void> => {
      if (finished) return Promise.resolve();
      pendingFinish ??= raw;
      if (finishing) return finishing;
      const attempt = (async () => {
        // multiTurn keeps the session alive past its first result so the caller can hand work back
        // (RUN-29/30). A single-turn result is not durable terminal authority until the outer
        // containment process exits and its PID namespace has been torn down.
        if (!opts.multiTurn) {
          closeSession();
          await proveSessionExit();
        }
        const terminal = pendingFinish;
        if (!terminal) throw new Error('Claude terminal result disappeared before settlement');
        const exit: DriverExit = { ...terminal, sessionId: session.sessionId ?? null };
        pendingFinish = null;
        finished = true;
        opts.handlers?.onExit?.(exit);
        settle(exit);
      })();
      finishing = attempt;
      void attempt.catch(() => {
        if (finishing === attempt) finishing = null;
      });
      return attempt;
    };

    // If bounded shutdown reports ambiguity but the process exits later, retry the same terminal
    // result. Never synthesize success from process exit alone.
    const lateContained = containedProcess as ContainedAgentProcess | null;
    if (lateContained) {
      void lateContained.exited.then(
        () => {
          if (pendingFinish && !finished) {
            void finish(pendingFinish).catch((error) => opts.handlers?.onError?.(error as Error));
          }
        },
        (error) => opts.handlers?.onError?.(error as Error),
      );
    }

    /** Armed by continueWith: the next `result` belongs to that turn, not to done(). */
    let awaitingTurn: ((exit: DriverExit) => void) | null = null;
    let streamTerminated = false;
    const settleAwaitingTurn = (exit: DriverExit): boolean => {
      const pending = awaitingTurn;
      if (!pending) return false;
      // Clear before invoking user code so stop/result/stream termination races are one-shot.
      awaitingTurn = null;
      pending(exit);
      return true;
    };

    const live = zeroTelemetry();
    // Text is streamed byte-faithfully from stream_event deltas (RUN-77); this tracks
    // whether the current turn produced any, so the assembled assistant message only
    // supplies text as a fallback (a transport without partial messages, or the tests).
    let sawDeltaText = false;
    // Distinct assistant turns carry NO newline between them — the model ends one response
    // and the next begins after tool calls; every chat UI renders that as a paragraph
    // break, but raw concatenation reads "…the SDK behavior.Now I have…" (RUN-80). The
    // driver is the only layer that sees turn boundaries, so it inserts the break into the
    // onText stream: armed when a turn ends, spent by the next text emitted, never before
    // the first text, and tool_use-only turns can't stack extras.
    let emittedText = false;
    let pendingTurnBreak = false;
    const emitText = (text: string) => {
      if (pendingTurnBreak) {
        pendingTurnBreak = false;
        opts.handlers?.onText?.('\n\n');
      }
      emittedText = true;
      opts.handlers?.onText?.(text);
    };
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
              emitText(ev.delta.text);
            }
            continue;
          }
          if (msg.type === 'assistant') {
            const am = msg as SdkAssistantMessage;
            // Only if the turn streamed no deltas — extractText joins blocks with '' and
            // drops inter-block newlines, so the deltas are always preferred when present.
            if (!sawDeltaText) {
              const text = extractText(am.message.content ?? []);
              if (text) emitText(text);
            }
            sawDeltaText = false;
            // The turn is over; whatever text comes next is a new paragraph (RUN-80).
            if (emittedText) pendingTurnBreak = true;
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
            if (settleAwaitingTurn(exit)) {
              // Someone is waiting on this turn; the run is not over. Keep reading — under
              // multiTurn more turns may follow.
            } else {
              void finish(exit).catch((error) => opts.handlers?.onError?.(error as Error));
              // Single-turn: the session closed with the result, so there is nothing left to
              // read. Under multiTurn the loop keeps going and stop() is what ends it.
              if (!opts.multiTurn) return;
            }
          }
        }
        // A multi-turn session's first result has already consumed finish(). If the SDK stream
        // then disappears during hand-back, settle that turn independently so its caller cannot
        // wait forever for a result that no transport can now deliver.
        streamTerminated = true;
        closeSession();
        const exit: DriverExit = {
          outcome: 'failed',
          isError: true,
          reason: 'stream ended without a result',
          telemetry: { ...live },
        };
        settleAwaitingTurn(exit);
        void finish(exit).catch((error) => opts.handlers?.onError?.(error as Error));
      } catch (err) {
        opts.handlers?.onError?.(err as Error);
        streamTerminated = true;
        closeSession();
        const exit: DriverExit = {
          outcome: 'failed',
          isError: true,
          reason: (err as Error).message,
          telemetry: { ...live },
        };
        settleAwaitingTurn(exit);
        void finish(exit).catch((error) => opts.handlers?.onError?.(error as Error));
      }
    };
    const session: DriverSession = {
      runId: opts.runId,
      // Assigned as soon as the stream says it (see consume). Seeded with what we asked to
      // resume so a resumed session has an id before its first message even lands.
      sessionId: opts.resumeSessionId ?? null,
      // Before effective MCP attestation, a steer must take the caller's durable fallback path —
      // queueing it behind an inventory that may fail would acknowledge delivery that never occurs.
      pushInput: (text: string): boolean => mcpAttested && input.push(userTurn(text)),
      // Only meaningful under multiTurn; the contract marks it optional for exactly that reason.
      continueWith: opts.multiTurn
        ? (text: string): Promise<DriverExit> =>
            new Promise<DriverExit>((resolve, reject) => {
              if (streamTerminated)
                return reject(new Error('session stream is closed — the turn was not delivered'));
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
        await proveSessionExit();
        await finish({ outcome: 'failed', isError: true, reason: 'stopped', telemetry: { ...live } });
        // Settle a turn that was IN FLIGHT. `finish` is one-shot and was consumed by the session's
        // first result, so under multiTurn it does nothing here — and `continueWith`'s promise has
        // its own resolver, which only the result stream ever calls. Stopping mid-hand-back would
        // otherwise leave the caller awaiting a turn that can never arrive: the process is gone,
        // the stream is closed, and `reviewWithFeedback`/`verifyWithFeedback` wait forever, which
        // hangs the run and pins its worktree. Reachable since RUN-133 gave the budget layer a
        // reason to stop a session DURING a hand-back (the run-level spend guard).
        settleAwaitingTurn({ outcome: 'failed', isError: true, reason: 'stopped', telemetry: { ...live } });
      },
      done: () => donePromise,
    };
    // Start consuming only once `session` exists — consume() writes the session id onto it.
    void consume();
    if (!requiresMcpAttestation) {
      input.push(userTurn(opts.prompt));
    } else {
      // MCP is executable capability, so intended options are not enough evidence.
      // Hold the first user turn until the SDK reports the exact effective server set connected.
      void (async () => {
        try {
          if (!query.initializationResult || !query.mcpServerStatus) {
            throw new Error('the installed Claude Agent SDK cannot attest MCP server status');
          }
          const expected = [...projectMcpNames, ...(opts.noriqMcp ? [NORIQ_MCP_NAME] : [])].sort();
          const expectedSet = new Set(expected);
          const deadline = Date.now() + PROJECT_MCP_ATTESTATION_TIMEOUT_MS;
          const beforeDeadline = <T>(operation: Promise<T>, description: string): Promise<T> =>
            new Promise<T>((resolve, reject) => {
              const remaining = deadline - Date.now();
              if (remaining <= 0) {
                reject(new Error(`timed out waiting for ${description}`));
                return;
              }
              const timer = setTimeout(
                () => reject(new Error(`timed out waiting for ${description}`)),
                remaining,
              );
              operation.then(
                (value) => {
                  clearTimeout(timer);
                  resolve(value);
                },
                (error) => {
                  clearTimeout(timer);
                  reject(error);
                },
              );
            });

          await beforeDeadline(query.initializationResult(), 'Claude MCP initialization');
          let statuses: SdkMcpServerStatus[] = [];
          for (;;) {
            if (finished) return;
            statuses = await beforeDeadline(query.mcpServerStatus(), 'Claude MCP server inventory');
            const actual = statuses.map((status) => status.name).sort();
            const unexpected = actual.filter((name) => !expectedSet.has(name));
            if (unexpected.length > 0 || new Set(actual).size !== actual.length) {
              throw new Error(
                `expected servers [${expected.join(', ')}], got [${actual.join(', ') || 'none'}]`,
              );
            }
            const unavailable = statuses.find(
              (status) => status.status !== 'connected' && status.status !== 'pending',
            );
            if (unavailable) {
              throw new Error(
                `${unavailable.name} is ${unavailable.status}${unavailable.error ? `: ${unavailable.error}` : ''}`,
              );
            }
            if (
              JSON.stringify(actual) === JSON.stringify(expected) &&
              statuses.every((status) => status.status === 'connected')
            ) {
              break;
            }
            await beforeDeadline(
              new Promise<void>((resolve) => setTimeout(resolve, PROJECT_MCP_ATTESTATION_POLL_MS)),
              'Claude MCP servers to connect',
            );
          }
          for (const name of projectMcpNames) {
            const status = statuses.find((candidate) => candidate.name === name);
            const actualTools = Array.isArray(status?.tools)
              ? status.tools
                  .map((tool) => tool?.name)
                  .filter((tool): tool is string => typeof tool === 'string')
                  .sort()
              : [];
            const expectedTools = [...(projectToolGrants[name] ?? [])].sort();
            const actualToolSet = new Set(actualTools);
            const expectedToolSet = new Set(expectedTools);
            const missingTools = expectedTools.filter((tool) => !actualToolSet.has(tool));
            const unexpectedTools = actualTools.filter((tool) => !expectedToolSet.has(tool));
            const exactInventory =
              actualTools.length === expectedTools.length &&
              actualTools.every((tool, index) => tool === expectedTools[index]);
            if (!exactInventory) {
              throw new Error(
                `${name} tool inventory differs from its exact grant (missing [${missingTools.join(', ')}], unexpected [${unexpectedTools.join(', ')}], available [${actualTools.join(', ')}])`,
              );
            }
          }
          if (opts.noriqMcp) {
            const status = statuses.find((candidate) => candidate.name === NORIQ_MCP_NAME);
            const actualTools = Array.isArray(status?.tools)
              ? status.tools
                  .map((tool) => tool?.name)
                  .filter((tool): tool is string => typeof tool === 'string')
                  .sort()
              : [];
            const grantedTools = [...new Set(opts.noriqTools ?? noriqToolNamesFor(opts.kind))].sort();
            const actualToolSet = new Set(actualTools);
            const missingTools = grantedTools.filter((tool) => !actualToolSet.has(tool));

            // A primary session's server catalogue and grant are the same policy. Stage actors
            // deliberately pass a narrower override while sharing their parent Run's credential,
            // so their upstream catalogue must instead equal one of Runner's known Run-kind
            // catalogues and contain every narrowed grant. This still fails closed on a newly
            // introduced/ambient tool without making inline reviewers unusable.
            const knownCatalogues = (['scope', 'build', 'verify'] as RunKind[]).map((kind) =>
              [...noriqToolNamesFor(kind)].sort(),
            );
            const matchesExpectedCatalogue = opts.noriqTools
              ? knownCatalogues.some(
                  (catalogue) =>
                    catalogue.length === actualTools.length &&
                    catalogue.every((tool, index) => tool === actualTools[index]),
                )
              : grantedTools.length === actualTools.length &&
                grantedTools.every((tool, index) => tool === actualTools[index]);
            if (missingTools.length > 0 || !matchesExpectedCatalogue) {
              throw new Error(
                `noriq tool inventory differs from Runner authority (missing grants [${missingTools.join(', ')}], available [${actualTools.join(', ')}])`,
              );
            }
          }
          mcpAttested = true;
          if (!input.push(userTurn(opts.prompt)))
            throw new Error('session input closed before the first turn');
        } catch (error) {
          const reason = `claude MCP isolation failed: ${(error as Error).message}`;
          opts.handlers?.onError?.(new Error(reason));
          closeSession();
          void finish({ outcome: 'failed', isError: true, reason, telemetry: { ...live } }).catch(
            (finishError) => opts.handlers?.onError?.(finishError as Error),
          );
        }
      })();
    }
    return session;
  }
}
