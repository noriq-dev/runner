import type { AgentTool, PermissionProfile, RunBudget, RunEffort, RunKind } from '@noriq-dev/shared';
import type { LockEnforcer } from '../lock-hooks';

// The common driver contract — one interface over both the Claude Agent SDK
// (RUN-12) and the Codex protocol-mode driver (RUN-13). A driver turns a Run into
// a live, steerable agent process and streams telemetry/status back.

/**
 * What ONE model spent (RUN-59) — the SDK's own per-model aggregate, keys un-renamed. Mirrors the
 * wire contract's `RunModelMix` (a mix's per-model value); kept as a local interface for the same
 * anti-corruption reason the driver mirrors the rest of the SDK's shape (see claude.ts). All four
 * token classes, so a breakdown sums to the run total shown beside it.
 */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

export interface DriverTelemetry {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  numTurns: number;
  /**
   * The spend broken down by the model that actually incurred it (RUN-59), keyed by the tool's own
   * model id. ABSENT when the driver cannot attribute spend by model — codex has no per-model
   * aggregate, and the claude `usage`-fallback path sees only one path. Absent means "not reported",
   * never "100% of the requested model": inventing a single-model mix is the lie this exists to
   * remove. When present, the per-model token classes sum to the fields above.
   */
  modelUsage?: Record<string, ModelUsage>;
}

export const zeroTelemetry = (): DriverTelemetry => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  numTurns: 0,
});

export type DriverOutcome = 'done' | 'failed';

export interface DriverExit {
  outcome: DriverOutcome;
  isError: boolean;
  reason: string | null;
  telemetry: DriverTelemetry;
  /** The tool's own session id, when it has one (RUN-30) — what `resume` takes to bring a
   *  parked run's context back. Null on a driver that has no resumable session. */
  sessionId?: string | null;
}

export interface DriverHandlers {
  /** Assistant text as it arrives (for dashboard visibility + steering context). */
  onText?: (text: string) => void;
  /** Cumulative token/USD telemetry, emitted as the SDK reports it. */
  onTelemetry?: (telemetry: DriverTelemetry) => void;
  /** Terminal outcome. */
  onExit?: (exit: DriverExit) => void;
  /** Non-terminal error (logged; the run may still continue or fail). */
  onError?: (err: Error) => void;
}

/**
 * The Noriq MCP connection a spawned agent reports its own work through
 * (set_agent_identity / claim / create_plan / comment).
 *
 * The token rides the MCP transport's Authorization header — NOT the agent's shell
 * env, which `sanitizedAgentEnv` deliberately strips. Without this the agent has no
 * way to reach Noriq at all, and the prompt's instructions to register and report
 * are unsatisfiable.
 */
export interface NoriqMcp {
  /** The MCP endpoint, e.g. https://noriq.example/mcp */
  url: string;
  /** The daemon's OAuth token — the agent acts under the runner's connection. */
  token: string;
}

export interface DriverStartOptions {
  /**
   * Keep the session open after its first result so the caller can hand work back (RUN-29/30).
   *
   * Opt-in, and the default is off deliberately: every existing path (scope, verify, a build with
   * no verify command) wants exactly today's behaviour — finish on the first result and close. A
   * session left open with nobody to close it hangs the daemon, so only a caller that has a
   * `finally { stop() }` should ask for this.
   */
  multiTurn?: boolean;
  /**
   * Resume a parked run's session instead of starting a new one (RUN-30).
   *
   * This is what makes a blocked run cheap to answer: the agent comes back with everything it
   * had already worked out still in context, rather than a fresh process re-deriving it from
   * the repo. Ignored by drivers with no resumable session.
   */
  resumeSessionId?: string | null;
  runId: string;
  kind: RunKind;
  /** The Run's isolated git worktree (RUN-11). */
  cwd: string;
  /** The assembled initial prompt (brief + context). */
  prompt: string;
  /** Per-kind permission profile from the repo manifest (scope read-only; build write). */
  permission: PermissionProfile;
  model?: string;
  /**
   * How hard the model should think (RUN-33) — tool-agnostic intent, mapped per driver
   * (`mapEffort` for codex; the Claude SDK takes these values verbatim).
   *
   * Absent = don't ask for one, so the tool applies its own default. That is what every run got
   * before this existed, and it stays the behaviour for any run that does not choose.
   */
  effort?: RunEffort;
  /** Ceilings for daemon-side budget enforcement (RUN-14). */
  budget?: RunBudget;
  /** Noriq access for the agent. Omit only in tests — a real Run needs it. */
  noriqMcp?: NoriqMcp;
  /**
   * Reactive per-edit file locking (RUN-101). When present, a driver that supports in-process
   * tool-use hooks (Claude) wires it as a PreToolUse deny + a Stop release — the runner's
   * GUARANTEED, unskippable variant of the PLNR client hook, run in-process so the run's token
   * never enters the agent's shell. A driver without such hooks (Codex) ignores it and relies on
   * the hard floor (RUN-102) + its native sandbox instead.
   */
  lockEnforcer?: LockEnforcer;
  handlers?: DriverHandlers;
}

export interface DriverSession {
  readonly runId: string;
  /**
   * The tool's session id, once it has told us one (RUN-30).
   *
   * Not readonly and not available at start(): the SDK assigns it, and we only learn it when the
   * first message comes back. A caller that needs it to park a run reads it at that point, not
   * before — which is fine, because a run cannot park before it has said anything.
   */
  sessionId?: string | null;
  /** Steer: push a user turn into the live session (soft — next-turn injection).
   *  @returns false when the session's input is already closed, i.e. the turn was NOT
   *  delivered. Steering depends on this: acking `via:'runtime'` for a message the
   *  session never received suppresses the notices fallback and loses it entirely. */
  pushInput(text: string): boolean;
  /** Hard interrupt the current inference. */
  interrupt(): Promise<void>;
  /** Terminate the session/process. */
  stop(): Promise<void>;
  /** Resolves when the run reaches a terminal exit. */
  done(): Promise<DriverExit>;
  /**
   * Push a turn and await the NEXT result, with the session still alive (RUN-29/30).
   *
   * Only present when the run was started with `multiTurn` — the driver otherwise closes on its
   * first result, which is the whole reason the verify gate could only ever be a verdict and
   * never a feedback loop.
   *
   * The caller then OWNS the session and must stop() it: nothing else closes the query, and an
   * open one keeps the daemon's event loop alive forever.
   */
  continueWith?(text: string): Promise<DriverExit>;
}

export interface AgentDriver {
  readonly tool: AgentTool;
  start(opts: DriverStartOptions): DriverSession;
}
