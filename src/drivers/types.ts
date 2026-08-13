import path from 'node:path';
import type { AgentTool, PermissionProfile, RunBudget, RunEffort, RunKind } from '@noriq-dev/shared';
import type { LockEnforcer } from '../lock-hooks';
import type { ProjectMcpBundle } from '../project-mcp';

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

/**
 * The executable project MCP declaration plus the exact, trusted tool authority for one agent
 * session. The repository owns the transports in `bundle`; the mission execution profile owns
 * `toolGrants`. Keeping those inputs separate prevents a project from granting every tool merely
 * by declaring a server.
 *
 * Tool names are bare MCP names. Drivers translate them to their vendor-specific representation.
 */
export interface ProjectMcpSession {
  bundle: ProjectMcpBundle;
  toolGrants: Readonly<Record<string, readonly string[]>>;
}

// Keep exact grants safe across every vendor representation. Claude serializes `allowedTools` as
// one comma-delimited CLI value, so punctuation outside this identifier alphabet could turn one
// repository-supplied tool name into multiple permission entries.
const PROJECT_MCP_TOOL_NAME = /^[A-Za-z0-9_.-]{1,256}$/;

/**
 * Validate the cross-vendor project MCP authority boundary and return its stable server order.
 * Only granted servers launch for this session. A grant without a declared transport is invalid;
 * ungranted project servers remain dormant.
 */
export function validateProjectMcpSession(projectMcp?: ProjectMcpSession): string[] {
  if (!projectMcp) return [];
  if (!projectMcp.bundle || !projectMcp.bundle.servers) {
    throw new Error('invalid project MCP session: bundle is required');
  }
  if (
    !projectMcp.toolGrants ||
    typeof projectMcp.toolGrants !== 'object' ||
    Array.isArray(projectMcp.toolGrants)
  ) {
    throw new Error('invalid project MCP session: toolGrants must be an object');
  }

  const declaredNames = Object.keys(projectMcp.bundle.servers).sort();
  const authorizationNames = Object.keys(projectMcp.bundle.launcherAuthorizations ?? {}).sort();
  const endpointAuthorizationNames = Object.keys(projectMcp.bundle.endpointAuthorizations ?? {}).sort();
  const grantNames = Object.keys(projectMcp.toolGrants).sort();
  for (const name of [...new Set([...declaredNames, ...grantNames])]) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) {
      throw new Error(`invalid project MCP session: unsafe server name '${name}'`);
    }
    if (name === 'noriq' || name === 'codex_apps') {
      throw new Error(`invalid project MCP session: server name '${name}' is reserved by Runner`);
    }
  }
  const undeclared = grantNames.filter((name) => !declaredNames.includes(name));
  if (undeclared.length > 0) {
    throw new Error(`invalid project MCP session: grants name undeclared servers [${undeclared.join(', ')}]`);
  }

  const expectedAuthorizations = declaredNames.filter(
    (name) => projectMcp.bundle.servers[name]?.transport === 'stdio',
  );
  if (JSON.stringify(authorizationNames) !== JSON.stringify(expectedAuthorizations)) {
    throw new Error(
      `invalid project MCP session: stdio launcher authorizations differ from declared servers (expected [${expectedAuthorizations.join(', ')}], got [${authorizationNames.join(', ')}])`,
    );
  }
  for (const server of authorizationNames) {
    const authorization = projectMcp.bundle.launcherAuthorizations[server];
    if (
      !authorization ||
      !/^[\x21-\x7e]{1,512}$/.test(authorization.policyId) ||
      !/^[\x21-\x7e]{1,512}$/.test(authorization.executableIdentity) ||
      !/^[\x21-\x7e]{1,512}$/.test(authorization.runtimeClosureIdentity) ||
      !/^sha256:[a-f0-9]{64}$/.test(authorization.authorizedArgvIdentity) ||
      typeof authorization.resolvedCommand !== 'string' ||
      !path.isAbsolute(authorization.resolvedCommand) ||
      !Array.isArray(authorization.readOnlyRoots) ||
      authorization.readOnlyRoots.some((root) => typeof root !== 'string' || !path.isAbsolute(root))
    ) {
      throw new Error(`invalid project MCP session: '${server}' has invalid launcher authorization`);
    }
  }
  const expectedEndpointAuthorizations = declaredNames.filter(
    (name) => projectMcp.bundle.servers[name]?.transport !== 'stdio',
  );
  if (JSON.stringify(endpointAuthorizationNames) !== JSON.stringify(expectedEndpointAuthorizations)) {
    throw new Error(
      `invalid project MCP session: endpoint authorizations differ from declared servers (expected [${expectedEndpointAuthorizations.join(', ')}], got [${endpointAuthorizationNames.join(', ')}])`,
    );
  }
  for (const server of endpointAuthorizationNames) {
    const authorization = projectMcp.bundle.endpointAuthorizations[server];
    const declaration = projectMcp.bundle.servers[server];
    if (
      !authorization ||
      !/^[\x21-\x7e]{1,512}$/.test(authorization.policyId) ||
      !/^[\x21-\x7e]{1,512}$/.test(authorization.endpointIdentity) ||
      typeof authorization.resolvedUrl !== 'string' ||
      declaration?.transport === 'stdio' ||
      authorization.resolvedUrl !== declaration?.url
    ) {
      throw new Error(`invalid project MCP session: '${server}' has invalid endpoint authorization`);
    }
  }

  const flattenedAddresses = new Map<string, string>();
  for (const server of grantNames) {
    const tools = projectMcp.toolGrants[server];
    if (!Array.isArray(tools) || tools.length === 0) {
      throw new Error(`invalid project MCP session: '${server}' must grant at least one exact tool`);
    }
    if (tools.length > 256) {
      throw new Error(`invalid project MCP session: '${server}' grants more than 256 tools`);
    }
    const seen = new Set<string>();
    for (const tool of tools) {
      if (typeof tool !== 'string' || !PROJECT_MCP_TOOL_NAME.test(tool)) {
        throw new Error(`invalid project MCP session: '${server}' grants an invalid exact tool name`);
      }
      if (seen.has(tool)) {
        throw new Error(`invalid project MCP session: '${server}' grants duplicate tool '${tool}'`);
      }
      seen.add(tool);
      const address = `mcp__${server}__${tool}`;
      const existing = flattenedAddresses.get(address);
      if (existing) {
        throw new Error(
          `invalid project MCP session: flattened tool address '${address}' collides between '${existing}' and '${server}/${tool}'`,
        );
      }
      flattenedAddresses.set(address, `${server}/${tool}`);
    }
  }
  return grantNames;
}

/** Project MCP and Noriq MCP are separate authority domains and may not share one agent session. */
export function validateDriverMcpAuthority(
  noriqMcp: NoriqMcp | undefined,
  projectMcp: ProjectMcpSession | undefined,
): string[] {
  const projectNames = validateProjectMcpSession(projectMcp);
  if (noriqMcp && projectNames.length > 0) {
    throw new Error('one driver session may not combine project MCP authority with Noriq MCP authority');
  }
  return projectNames;
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
  /**
   * `none` is a privileged harness request for a pure inference turn: no built-in, MCP, app,
   * plugin, web, or repository tools may be exposed. Drivers that cannot enforce this must reject
   * the start before model work. Omitted means the normal permission-profile surface.
   */
  toolAccess?: 'none';
  /**
   * Exact canonical workspace root requested by the mission harness. A driver may accept this
   * only when its declared `workspaceIsolatedSession` capability can enforce the matching
   * read-only/workspace-write posture. It is not a prompt hint.
   */
  workspaceRoot?: string;
  /** Machine-trusted host paths needed by this exact workspace view. */
  containmentReadOnlyRoots?: readonly string[];
  /** Workspace-relative backend control paths remounted read-only after the workspace bind. */
  protectedWorkspaceReadOnlyPaths?: readonly string[];
  /** Machine-trusted private state needed by this exact workspace view. */
  containmentWriteRoots?: readonly string[];
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
  /**
   * Provider-side, pre-spend mission envelope. Reactive telemetry is deliberately insufficient
   * here: a driver advertising `hardTokenEnvelope` must pass this exact finite total to a vendor
   * control that rejects further turns/tokens before they are consumed.
   */
  tokenEnvelope?: {
    /** Total input, cache-input, reasoning, and output tokens allowed for this session. */
    totalTokens: number;
    /** Finite provider-side turn ceiling; one guide decision is always one turn. */
    maxTurns: number;
  };
  /**
   * A LIVE spend check for this session, consulted on every telemetry tick (RUN-133). Returns the
   * dimension that is gone, or null to continue; a non-null answer stops the session exactly as a
   * `budget` breach does.
   *
   * It exists because `budget` is a SNAPSHOT and a session can outlive it. A build's session is
   * kept open for hand-back turns (RUN-29/30), and between two of those turns the reviewer spends
   * from the same run ceiling — so the builder's original allowance is stale by the time it is
   * handed work back, and comparing its own cumulative against that stale number lets the RUN
   * exceed its budget while no single session ever breaches. The guard asks the run's allocator
   * instead, which knows what every session has spent.
   *
   * Absent → `budget` alone decides, which is what every test fake and any caller without a run
   * ledger means. Present → it wins for tokens/USD; the wall-clock deadline is still `budget`'s.
   */
  spendGuard?: (t: DriverTelemetry) => string | null;
  /**
   * The wall-clock counterpart of `spendGuard` (RUN-159): how many seconds the RUN has left, asked
   * each time a stretch of agent work is armed. Null (or absent) = unbounded on that axis.
   *
   * Same staleness it exists to fix, different axis. `budget.maxDurationSeconds` is this session's
   * allowance at the moment it was reserved; a multiTurn session outlives that, and the seconds a
   * reviewer spends between two hand-back turns are the run's, not free. Without this the builder
   * would be re-armed against its own original allowance and the run's total could exceed its
   * ceiling by however much every other session took.
   *
   * The tighter of the two remainders wins, so a caller with no run ledger loses nothing.
   */
  clockGuard?: () => number | null;
  /** Noriq access for the agent. Omit only in tests — a real Run needs it. */
  noriqMcp?: NoriqMcp;
  /**
   * Project-owned MCP transports plus this session's exact per-server tool grants. No vendor
   * driver may rediscover ambient project/user MCP configuration or infer authority from the
   * presence of a server.
   */
  projectMcp?: ProjectMcpSession;
  /**
   * Narrow THIS session's Noriq tool set below its kind's floor (bare names, un-prefixed).
   *
   * Absent, the driver derives the set from `kind` (`noriqToolNamesFor`) — the right answer for
   * every primary session. The stage actors (planner, plan checker, pattern mapper, inline
   * reviewer) pass `STAGE_NORIQ_TOOLS` here: they share the run's one identity, so the server-side
   * catalogue is the run's, and this is the seam that keeps a read-only actor from holding
   * `update_task` while still being able to reach a human. Drivers enforce it both ways — the
   * complement is DENIED, not merely un-allowed, so a bypass-permissions profile cannot widen it.
   */
  noriqTools?: readonly string[];
  /**
   * Reactive per-edit file locking (RUN-101). When present, a driver that supports in-process
   * tool-use hooks (Claude) wires it as a PreToolUse deny + a Stop release — the runner's
   * GUARANTEED, unskippable variant of the PLNR client hook, run in-process so the run's token
   * never enters the agent's shell. A driver without such hooks (Codex) ignores it and relies on
   * the hard floor (RUN-102) + its native sandbox instead.
   */
  lockEnforcer?: LockEnforcer;
  /**
   * The sanitized process environment the agent MUST run under (RUN-109).
   *
   * Computed ONCE by the supervisor (`sanitizedAgentEnv`) and handed down, so the trust boundary
   * — no daemon token, no cloud/git creds, no git push/prompt — is a SUPERVISOR guarantee that
   * holds no matter who spawns, rather than a thing each driver remembers to do. It used to live
   * inside claude.ts/codex.ts because they spawn the local process; a future driver that runs the
   * agent elsewhere still receives this and must ship it to wherever the process actually runs.
   *
   * Absent only in tests, where a driver falls back to `sanitizedAgentEnv()` so the default is
   * still safe. A driver that needs one credential IN the env (codex's MCP bearer token, which has
   * no header option) adds ONLY that, on top of this already-stripped base.
   */
  env?: NodeJS.ProcessEnv;
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
  /**
   * Terminate the session/process. The strength of the acknowledgement is declared by
   * `DriverCapabilities.terminationAcknowledgement`; callers that own a worktree or another
   * reusable resource must require the strength they need before starting the session.
   */
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

/**
 * What a driver's runtime can and cannot do (RUN-110).
 *
 * The claude/codex asymmetry used to be implicit — the supervisor handed every driver a
 * `lockEnforcer` and simply trusted claude to wire it and codex to ignore it; per-model telemetry
 * "just wasn't there" for codex. This makes those differences a declared contract the supervisor
 * reads, so behaviour keys off a capability, not a driver's NAME — and a future driver (a remote
 * executor) declares what it supports rather than the supervisor knowing it by hard-coded tool id.
 */
export interface DriverCapabilities {
  /**
   * In-process tool-use hooks — the reactive per-edit lock layer (RUN-101): PreToolUse deny +
   * Stop release. false → the driver ignores `lockEnforcer` and the daemon-side hard floor
   * (RUN-102) is the ONLY lock guard for its runs (this is the Codex posture).
   */
  toolHooks: boolean;
  /** Soft steer: `pushInput` injects a next-turn user message into a live session. */
  steer: boolean;
  /** Hard interrupt of the current inference (`interrupt`). */
  interrupt: boolean;
  /** A resumable session id for park/resume (RUN-30). false → a parked run of this driver cannot
   *  bring its context back and must restart (Codex has no resume). */
  resumableSession: boolean;
  /** Per-model spend attribution (RUN-59). false → its spend lands in the `(unattributed)` bucket
   *  (RUN-86) rather than a per-model breakdown (Codex reports tokens but no split, no cost). */
  perModelTelemetry: boolean;
  /** The driver can enforce `DriverStartOptions.toolAccess = 'none'` before model work. */
  toolFreeSession?: boolean;
  /** Model tools/process writes can be confined to `workspaceRoot` without unsafe fallback. */
  workspaceIsolatedSession?: boolean;
  /**
   * The provider can enforce `DriverStartOptions.tokenEnvelope` before spend. Post-hoc telemetry,
   * cancellation, and output truncation do not satisfy this capability.
   */
  hardTokenEnvelope?: true;
  /**
   * Mission launches use a commissioned boundary that separates provider credentials, enforces
   * host/network ceilings, binds immutable runtime authority, and can re-attest that authority.
   */
  commissionedExecutionBoundary?: true;
  /** Project MCP subprocesses are members of the same managed process/mount boundary. External
   * endpoint/editor side effects require separate resource fencing and are not claimed here. */
  projectMcpProcessContainment?: boolean;
  /**
   * What a resolved `DriverSession.stop()` (and a single-turn terminal `done()`) proves:
   *
   * - `none`: the driver requested shutdown but cannot observe even the main process exit.
   * - `main-process`: the directly-owned agent process exited; descendants were signalled but
   *   may have escaped the observable process group/tree.
   * - `process-tree`: the driver owns a containment primitive that proves the agent and every
   *   tool/MCP descendant exited.
   *
   * Omitted is `none`, deliberately, so older and test drivers fail closed when a mission needs
   * to know that its workspace can be released safely.
   */
  terminationAcknowledgement?: 'none' | 'main-process' | 'process-tree';
}

/**
 * A driver's advertised menu (RUN-115): the model ids and efforts it can build coordinates from,
 * so the dashboard can offer a real picker (`claude.<model>.<effort>`) instead of a free-text box.
 * Deliberately a SUGGESTION, not a whitelist — `model` stays free-form on the wire (vendors ship
 * models weekly), so a coordinate naming a model not in this list is still accepted; the catalog
 * only seeds the common choices.
 */
export interface DriverCatalog {
  /** Known/suggested model ids for this driver, newest-first. May be stale; not enforced. */
  models: string[];
  /** The efforts this driver meaningfully distinguishes (codex collapses xhigh/max into high). */
  efforts: RunEffort[];
}

export interface AgentDriver {
  readonly tool: AgentTool;
  /** What this driver's runtime supports — read by the supervisor instead of branching on `tool`. */
  readonly capabilities: DriverCapabilities;
  /** The models + efforts this driver advertises for the coordinate picker (RUN-115). */
  readonly catalog: DriverCatalog;
  start(opts: DriverStartOptions): DriverSession;
}
