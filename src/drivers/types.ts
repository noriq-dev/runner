import type { AgentTool, PermissionProfile, RunBudget, RunKind } from '@noriq-dev/shared';

// The common driver contract — one interface over both the Claude Agent SDK
// (RUN-12) and the Codex protocol-mode driver (RUN-13). A driver turns a Run into
// a live, steerable agent process and streams telemetry/status back.

export interface DriverTelemetry {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  numTurns: number;
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
  runId: string;
  kind: RunKind;
  /** The Run's isolated git worktree (RUN-11). */
  cwd: string;
  /** The assembled initial prompt (brief + context). */
  prompt: string;
  /** Per-kind permission profile from the repo manifest (scope read-only; build write). */
  permission: PermissionProfile;
  model?: string;
  /** Ceilings for daemon-side budget enforcement (RUN-14). */
  budget?: RunBudget;
  /** Noriq access for the agent. Omit only in tests — a real Run needs it. */
  noriqMcp?: NoriqMcp;
  handlers?: DriverHandlers;
}

export interface DriverSession {
  readonly runId: string;
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
