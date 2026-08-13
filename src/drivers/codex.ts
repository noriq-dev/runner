import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { PermissionProfile, RunEffort, RunKind } from '@noriq-dev/shared';
import { DEFAULT_CODEX_HOME, createEphemeralAgentHome, ensurePrivateAgentHome } from '../agent-homes';
import { AsyncQueue } from '../async-queue';
import type { logger as Logger } from '../logger';
import { killProcessTree, treeSpawnOptions } from '../proc';
import { type AgentProcessContainment, isCommissionedAgentProcessContainment } from '../process-containment';
import { reattestProjectMcpExecutablesSync } from '../project-mcp';
import { CODEX_MCP_TOKEN_ENV, noriqToolNamesFor, projectMcpProcessEnv, sanitizedAgentEnv } from '../security';
import { VERSION } from '../version';
import { NORIQ_MCP_NAME } from './claude';
import {
  type AgentDriver,
  type DriverCapabilities,
  type DriverCatalog,
  type DriverExit,
  type DriverOutcome,
  type DriverSession,
  type DriverStartOptions,
  type NoriqMcp,
  type ProjectMcpSession,
  validateDriverMcpAuthority,
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
  | { type: 'error'; message: string }
  // A sign of life and nothing else (RUN-201): any JSON-RPC frame the normalizer does not map —
  // command execution notifications during a long tool run, new-minor renames — still proves the
  // child is alive. The driver re-arms its silence deadline on it and otherwise ignores it;
  // without this, a legitimate 20-minute quiet command would be read as a dead child.
  | { type: 'activity' };

export interface CodexTransport {
  events: AsyncIterable<CodexEvent>;
  /**
   * Resolves only when the directly-owned process has actually exited. `close()` is deliberately
   * bounded and may reject first; this separate acknowledgement lets the driver finish a durable
   * attempt if the process dies later instead of memoizing the timeout forever.
   */
  processExit?: Promise<void>;
  /**
   * Start a turn on the thread: the first with the initial prompt, and — under `multiTurn`
   * (RUN-200) — any later hand-back turn too. The real transport posts `turn/start` against
   * whatever `threadId` already exists (buffering only until the thread itself has started), so
   * calling this again once a prior turn has completed is a SECOND `turn/start` on the SAME live
   * thread, not a resume and not a new process — confirmed against the app-server's own schema:
   * every per-turn override field on `TurnStartParams` (model, effort, cwd, …) is documented as
   * applying "to this turn and subsequent turns", which only makes sense if repeated calls on one
   * thread are the intended shape.
   */
  sendUserTurn(text: string): void;
  /** Steer the active turn with additional user input (mid-session).
   *  @returns false if there is no live turn to steer — the caller must fall back
   *  rather than ack a message the session never received. */
  steer(text: string): boolean;
  /** Interrupt the active turn. */
  interrupt(): void;
  /** Terminate the process and resolve only after the directly-owned process has exited. */
  close(): Promise<void>;
}

export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

/** What codex's `model_reasoning_effort` accepts. Its ceiling is `high`; the Claude SDK's
 *  EffortLevel goes two steps further, which is why RunEffort needs mapping rather than
 *  passing through. */
export type CodexEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface CodexSpawnOptions {
  /** Supplied by CodexDriver; optional only for legacy direct transport tests/callers. */
  runId?: string;
  cwd: string;
  /** Exact workspace authority for an outer containment provider. */
  workspaceRoot?: string;
  workspaceWrite?: boolean;
  containmentReadOnlyRoots?: readonly string[];
  protectedWorkspaceReadOnlyPaths?: readonly string[];
  containmentWriteRoots?: readonly string[];
  /** Exact quota passed to a commissioned provider/broker before Codex is launched. */
  tokenEnvelope?: DriverStartOptions['tokenEnvelope'];
  model?: string;
  /** Tool-agnostic intent (RUN-33); mapEffort turns it into codex's own scale. */
  effort?: RunEffort;
  sandbox: CodexSandbox;
  /** Headless — never block on an interactive approval prompt. */
  approvalPolicy: 'never';
  /** The agent's Noriq connection. Omitted → it cannot report its own work at all. */
  noriqMcp?: NoriqMcp;
  /** Explicit project-owned servers; ambient Codex config remains disabled and separately policed. */
  projectMcp?: ProjectMcpSession;
  /** A stage actor's narrowed Noriq tool set — replaces the kind floor in `enabled_tools`. */
  noriqTools?: readonly string[];
  /** The run kind, so the per-kind Noriq tool floor applies HERE too (RUN-46) — without it
   *  every codex agent got the server's whole tool surface, and a verify agent could
   *  claim_task the work it was judging. */
  kind: RunKind;
  /** The supervisor-sanitized process env (RUN-109). Absent only in tests → `sanitizedAgentEnv()`. */
  env?: NodeJS.ProcessEnv;
  /** Runner's Codex-specific home. Never inherit the operator's global ~/.codex. */
  codexHome?: string;
  /** Trusted outer process/mount boundary. Never sourced from repository configuration. */
  containment?: AgentProcessContainment;
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
  /** Injectable so tests never create or chmod the operator's real ~/.noriq/codex. */
  codexHome?: string;
  prepareCodexHome?: (home: string) => void;
  /** Required for mission execution; ordinary legacy Runs may continue without it. */
  containment?: AgentProcessContainment;
  /** Test seam; production re-attests local MCP executables immediately before provider spawn. */
  reattestProjectMcpExecutables?: typeof reattestProjectMcpExecutablesSync;
}

/**
 * Drives Codex via app-server protocol mode with spawn/stream/steer/interrupt
 * parity with the Claude driver. `done()` completes on the first turn/completed;
 * under `multiTurn` (RUN-200) the process stays live past it and `continueWith`
 * posts further `turn/start`s on the same thread, mirroring the Claude driver's
 * own multiTurn/continueWith pair.
 */
/**
 * Codex's advertised coordinate menu (RUN-115). A suggestion, not a whitelist — `model` is free
 * on the wire. Efforts stop at `high`: codex's `model_reasoning_effort` tops out there, and its
 * driver clamps xhigh/max down, so advertising them would promise a distinction it cannot make.
 */
/** The session liveness deadline (RUN-201): no transport event for this long → torn down as a
 *  normal failure. Generous — deep reasoning still ticks usage well inside it. */
export const CODEX_SILENCE_TEARDOWN_MS = 20 * 60_000;
/** Initialization/MCP inventory is a pre-model authority gate, so it gets its own short deadline. */
export const CODEX_MCP_ATTESTATION_TIMEOUT_MS = 10_000;
export const CODEX_MCP_ATTESTATION_MAX_PAGES = 16;
export const CODEX_MCP_ATTESTATION_MAX_RESULTS = 256;
/** Graceful tree shutdown window before Codex is force-killed. */
export const CODEX_GRACEFUL_STOP_MS = 2_000;
/** Final wait for the directly-owned process to acknowledge the force kill. */
export const CODEX_FORCE_STOP_MS = 5_000;

export const CODEX_CATALOG: DriverCatalog = {
  models: ['gpt-5.6-sol', 'gpt-5.3-codex'],
  efforts: ['low', 'medium', 'high'],
};

export class CodexDriver implements AgentDriver {
  readonly tool = 'codex' as const;
  readonly catalog: DriverCatalog = CODEX_CATALOG;
  // Codex steers and interrupts over JSON-RPC, but has NO in-process tool hooks (locks fall to the
  // hard floor, RUN-102), no per-model telemetry (spend → the (unattributed) bucket, RUN-86), and
  // no session resume — a parked codex run restarts rather than reloading context (RUN-110).
  readonly capabilities: DriverCapabilities;
  private readonly spawnCodex: SpawnCodex;
  private readonly log: Pick<typeof Logger, 'debug' | 'info' | 'warn' | 'error'>;
  private readonly codexHome: string;
  private readonly prepareCodexHome: (home: string) => void;
  private readonly containment?: AgentProcessContainment;
  private readonly reattestProjectMcpExecutables: typeof reattestProjectMcpExecutablesSync;

  constructor(deps: CodexDriverDeps = {}) {
    // A custom transport is opaque to Runner. Do not claim the separately supplied containment
    // protects it; only the built-in spawn path is wired through this boundary.
    const containedBuiltin = deps.containment !== undefined && deps.spawnCodex === undefined;
    this.containment = containedBuiltin ? deps.containment : undefined;
    this.spawnCodex = deps.spawnCodex ?? defaultSpawnCodex;
    this.log = deps.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
    this.codexHome = deps.codexHome ?? DEFAULT_CODEX_HOME;
    this.prepareCodexHome = deps.prepareCodexHome ?? ensurePrivateAgentHome;
    this.reattestProjectMcpExecutables =
      deps.reattestProjectMcpExecutables ?? reattestProjectMcpExecutablesSync;
    this.capabilities = Object.freeze({
      toolHooks: false,
      steer: true,
      interrupt: true,
      resumableSession: false,
      perModelTelemetry: false,
      toolFreeSession: false,
      workspaceIsolatedSession: true,
      projectMcpProcessContainment: containedBuiltin,
      ...(isCommissionedAgentProcessContainment(this.containment)
        ? { commissionedExecutionBoundary: true as const }
        : {}),
      ...(this.containment?.capabilities.providerTokenEnvelope === true
        ? { hardTokenEnvelope: true as const }
        : {}),
      // Codex's own sandbox confines ordinary file operations, but only the outer PID namespace
      // turns terminal process exit into proof that every tool and MCP descendant is gone.
      terminationAcknowledgement: containedBuiltin ? 'process-tree' : 'main-process',
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
        throw new Error('Codex token envelope must contain positive safe-integer limits');
      }
      if (
        !isCommissionedAgentProcessContainment(this.containment) ||
        this.containment.capabilities.providerTokenEnvelope !== true
      ) {
        throw new Error('Codex driver has no commissioned hard token-envelope authority');
      }
    }
    this.prepareCodexHome(this.codexHome);
    if (opts.toolAccess === 'none') {
      throw new Error('Codex driver cannot attest a tool-free session');
    }
    const projectMcpNames = validateDriverMcpAuthority(opts.noriqMcp, opts.projectMcp);
    const sandbox = mapSandbox(opts.permission);
    if (opts.workspaceRoot) {
      if (
        !path.isAbsolute(opts.workspaceRoot) ||
        path.resolve(opts.cwd) !== path.resolve(opts.workspaceRoot)
      ) {
        throw new Error('Codex mission cwd must exactly match its absolute workspace root');
      }
      if (sandbox === 'danger-full-access' && !this.containment) {
        throw new Error('Codex danger-full-access cannot enforce mission workspace isolation');
      }
    }
    if (opts.projectMcp) {
      this.reattestProjectMcpExecutables(opts.projectMcp.bundle, projectMcpNames);
    }
    const transport = this.spawnCodex({
      runId: opts.runId,
      cwd: opts.cwd,
      workspaceRoot: opts.workspaceRoot,
      workspaceWrite: opts.permission.write,
      containmentReadOnlyRoots: opts.containmentReadOnlyRoots,
      protectedWorkspaceReadOnlyPaths: opts.protectedWorkspaceReadOnlyPaths,
      containmentWriteRoots: opts.containmentWriteRoots,
      tokenEnvelope: opts.tokenEnvelope,
      model: opts.model,
      effort: opts.effort,
      sandbox,
      approvalPolicy: 'never',
      noriqMcp: opts.noriqMcp,
      projectMcp: opts.projectMcp,
      noriqTools: opts.noriqTools,
      kind: opts.kind,
      env: opts.env,
      codexHome: this.codexHome,
      containment: this.containment,
    });
    transport.sendUserTurn(opts.prompt);

    let settle!: (exit: DriverExit) => void;
    const donePromise = new Promise<DriverExit>((resolve) => {
      settle = resolve;
    });
    // `finished` gates `done()` — it settles once, on the FIRST terminal event, exactly like the
    // Claude driver. `torndown` gates the PROCESS: under multiTurn the run is not over when the
    // first turn completes (that is the whole point, RUN-200), so the two must not be the same
    // flag — collapsing them is what used to close the transport under the caller's feet the
    // instant a fix round would have needed it.
    let finished = false;
    let torndown = false;
    let teardownPromise: Promise<void> | null = null;
    // The first turn's own outcome, kept so a LATER continueWith can tell a thread that never
    // successfully started from one merely idle between turns (RUN-200 discretion: a continueWith
    // on a thread whose foundation never completed must be an honest failure, not a multi-minute
    // hang waiting on a turn/completed that will never arrive).
    let firstOutcome: DriverOutcome | null = null;
    let stopRequested = false;
    /** Armed by continueWith: the next terminal event belongs to THAT turn, not to done(). */
    let awaitingTurn: ((exit: DriverExit) => void) | null = null;
    let silenceTimer: ReturnType<typeof setTimeout> | undefined;
    const teardown = (): Promise<void> => {
      if (teardownPromise) return teardownPromise;
      torndown = true;
      if (silenceTimer) clearTimeout(silenceTimer);
      // Promise.resolve().then also converts a synchronously throwing injected transport into the
      // same rejected acknowledgement as an asynchronous shutdown failure.
      const attempt = Promise.resolve().then(() => transport.close());
      teardownPromise = attempt;
      void attempt.catch(() => {
        // A bounded close rejection reports immediate ambiguity, but is not a permanent fact about
        // the process. Permit a later observed exit to retry the acknowledgement path.
        if (teardownPromise === attempt) teardownPromise = null;
      });
      return attempt;
    };
    let finishing: Promise<void> | null = null;
    let pendingFinishExit: DriverExit | null = null;
    const rememberFinishExit = (exit: DriverExit): DriverExit => {
      pendingFinishExit ??= exit;
      return pendingFinishExit;
    };
    const finish = (exit: DriverExit): Promise<void> => {
      if (finished) return Promise.resolve();
      if (finishing) return finishing;
      const terminalExit = rememberFinishExit(exit);
      const attempt = (async () => {
        // A single-turn result is not terminal authority until codex itself has exited. If the
        // bounded graceful/force shutdown cannot prove that, this promise rejects and `done()`
        // intentionally remains unsettled so a caller cannot release the worktree underneath a
        // possibly-live writer.
        if (!opts.multiTurn) await teardown();
        finished = true;
        firstOutcome = terminalExit.outcome;
        pendingFinishExit = null;
        opts.handlers?.onExit?.(terminalExit);
        settle(terminalExit);
      })();
      finishing = attempt;
      void attempt.catch(() => {
        // Keep the first terminal result, but do not retain a rejected promise as the only route to
        // `done()`. The transport's later process-exit acknowledgement retries this exact result.
        if (finishing === attempt) finishing = null;
      });
      return attempt;
    };

    // `close()` has a bounded ambiguity deadline; process death does not. If Codex survives that
    // deadline but exits later, retry the rejected teardown/finish promises and settle `done()`.
    // Do not invent a terminal result here: normal stream consumption still owns the outcome.
    void transport.processExit?.then(() => {
      const pending = pendingFinishExit;
      if (!pending || finished) return;
      void finish(pending).catch((error) => opts.handlers?.onError?.(error as Error));
    });

    const live = zeroTelemetry();
    // RUN-201: liveness is a transport question, one layer below RUN-176's socket deadline —
    // twice in one live evening a codex child died without its exit ever reaching the loop
    // below, and the run showed "running" for half an hour with no process behind it. A real
    // turn emits SOMETHING (deltas, usage ticks) well inside this window; total silence past it
    // means dead or wedged, and both settle the same way: torn down as an ordinary failure,
    // which the continuation flow already recovers. Re-armed on every event, cleared at teardown
    // — NOT at `finished` (RUN-200): a multiTurn session's first result leaves `finished` true
    // while the process, and the watchdog over it, both have to keep running for every turn after.
    const armSilence = () => {
      if (torndown) return;
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        this.log.warn('codex went silent past the liveness deadline — tearing the session down', {
          runId: opts.runId,
        });
        const exit: DriverExit = {
          outcome: 'failed',
          isError: true,
          reason: 'driver went silent — torn down (RUN-201)',
          telemetry: { ...live },
        };
        void (async () => {
          try {
            await teardown();
            // A wedge mid-hand-back must fail the turn awaiting it, not the (already-settled) run —
            // the same split `stop()` makes below. With nobody awaiting, it is the ordinary case.
            const pending = awaitingTurn;
            awaitingTurn = null;
            if (pending) pending(exit);
            else await finish(exit);
          } catch (error) {
            opts.handlers?.onError?.(error as Error);
          }
        })();
      }, CODEX_SILENCE_TEARDOWN_MS);
      silenceTimer.unref?.();
    };
    armSilence();
    // Distinct agentMessage items are distinct model messages with no newline between
    // them — insert a paragraph break when the item id changes (RUN-80; claude does the
    // same at assistant-turn boundaries). Id-less deltas (0.142.x) never trigger it.
    let lastItemId: string | undefined;
    const consume = async () => {
      try {
        for await (const ev of transport.events) {
          armSilence();
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
            const exit: DriverExit = {
              outcome: 'done',
              isError: false,
              reason: null,
              telemetry: { ...live },
            };
            // A completion that belongs to a continueWith turn settles THAT, not the run — the
            // run is not over, someone handed it more work and is waiting on the answer (RUN-200,
            // mirroring claude.ts). Only the FIRST completion (no turn awaiting it) is `done()`'s.
            const turn = awaitingTurn;
            awaitingTurn = null;
            if (turn) {
              turn(exit);
            } else {
              await finish(exit);
              // Single-turn: the process was just torn down by finish() above, so there is
              // nothing left to read. Under multiTurn the loop keeps going — a hand-back turn's
              // events (deltas, usage, its own turn_complete) still have to reach this consumer,
              // and stop() is what ends it (RUN-200: the caller owns a multiTurn session).
              if (!opts.multiTurn) return;
            }
          } else if (ev.type === 'error') {
            opts.handlers?.onError?.(new Error(ev.message));
            const exit: DriverExit = {
              outcome: 'failed',
              isError: true,
              reason: ev.message,
              telemetry: { ...live },
            };
            const turn = awaitingTurn;
            awaitingTurn = null;
            if (turn) {
              turn(exit);
            } else {
              await finish(exit);
              if (!opts.multiTurn) return;
            }
          }
        }
        // The event stream ended — the process is gone, whatever turn was in flight included.
        // Under multiTurn this can arrive well after the first turn: no `armSilence` catches it
        // faster than 20 minutes, but a clean exit/close still closes the queue immediately, and
        // that must fail the turn actually waiting rather than the (already-settled) run.
        const exit: DriverExit = {
          outcome: 'failed',
          isError: true,
          reason: stopRequested ? 'stopped' : 'codex stream ended without completing a turn',
          telemetry: { ...live },
        };
        await teardown();
        const pending = awaitingTurn;
        awaitingTurn = null;
        if (pending) pending(exit);
        else await finish(exit);
      } catch (err) {
        const exit: DriverExit = {
          outcome: 'failed',
          isError: true,
          reason: (err as Error).message,
          telemetry: { ...live },
        };
        opts.handlers?.onError?.(err as Error);
        try {
          await teardown();
          const pending = awaitingTurn;
          awaitingTurn = null;
          if (pending) pending(exit);
          else await finish(exit);
        } catch (teardownError) {
          opts.handlers?.onError?.(teardownError as Error);
        }
      }
    };
    void consume();

    return {
      runId: opts.runId,
      pushInput: (text: string): boolean => transport.steer(text),
      // Only present under multiTurn (RUN-200) — the contract marks it optional for exactly that
      // reason (drivers/types.ts). A second `turn/start` on the SAME live thread: `sendUserTurn`
      // already posts exactly that once `threadId` exists, which by now it does (continueWith is
      // only ever reachable after the first turn settled `firstOutcome`).
      continueWith: opts.multiTurn
        ? (text: string): Promise<DriverExit> =>
            new Promise<DriverExit>((resolve, reject) => {
              if (awaitingTurn) return reject(new Error('a turn is already in flight'));
              // An honest failure (RUN-200 discretion), never a fabricated success: a torn-down
              // process, or a thread whose FIRST turn never actually completed, has nothing live
              // to hand another turn to — the same "closed input" case claude.ts rejects on,
              // and it avoids waiting on a turn/completed that a dead thread will never send.
              if (torndown || firstOutcome !== 'done') {
                reject(new Error('no live codex thread to continue'));
                return;
              }
              awaitingTurn = resolve;
              transport.sendUserTurn(text);
            })
        : undefined,
      interrupt: async () => {
        this.log.debug('codex interrupt', { runId: opts.runId });
        transport.interrupt();
      },
      stop: async () => {
        stopRequested = true;
        const exit = rememberFinishExit({
          outcome: 'failed',
          isError: true,
          reason: 'stopped',
          telemetry: { ...live },
        });
        await teardown();
        await finish(exit);
        // Settle a turn that was IN FLIGHT. `finish` is one-shot and was already consumed by the
        // session's first result under multiTurn, so it does nothing here — and continueWith's
        // promise has its own resolver, which only the event stream ever calls. Without this a
        // stop() mid-hand-back would leave reviewWithFeedback/verifyWithFeedback awaiting a turn
        // that can never arrive: the process is gone and the stream is closed (RUN-200, mirroring
        // claude.ts's own stop()).
        const pending = awaitingTurn;
        if (pending) {
          awaitingTurn = null;
          pending({ outcome: 'failed', isError: true, reason: 'stopped', telemetry: { ...live } });
        }
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
  mcpServerStatusList: 'mcpServerStatus/list',
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
type KillCodexProcessTree = typeof killProcessTree;

export const defaultSpawnCodex = (
  opts: CodexSpawnOptions,
  spawnFn: SpawnChild = spawn as unknown as SpawnChild,
  killTree: KillCodexProcessTree = killProcessTree,
): CodexTransport => {
  const durableCodexHome = opts.codexHome ?? DEFAULT_CODEX_HOME;
  const tomlString = (value: string): string => JSON.stringify(value);
  const tomlStringArray = (value: readonly string[]): string =>
    `[${value.map((item) => tomlString(item)).join(',')}]`;
  const tomlStringTable = (value: Readonly<Record<string, string>>): string =>
    `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${tomlString(key)}=${tomlString(item)}`)
      .join(',')}}`;
  const expectedNoriqTools = [...(opts.noriqTools ?? noriqToolNamesFor(opts.kind))];
  const projectMcpNames = validateDriverMcpAuthority(opts.noriqMcp, opts.projectMcp);
  const expectedProjectTools: Record<string, readonly string[]> = {};
  for (const name of projectMcpNames) {
    expectedProjectTools[name] = [...(opts.projectMcp?.toolGrants[name] ?? [])];
  }
  const reservedProjectNames = projectMcpNames.filter((name) =>
    [NORIQ_MCP_NAME, 'codex_apps'].includes(name),
  );
  if (reservedProjectNames.length > 0) {
    throw new Error(`project MCP server name '${reservedProjectNames[0]}' is reserved by Codex Runner`);
  }
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
        `mcp_servers.${NORIQ_MCP_NAME}.url=${tomlString(opts.noriqMcp.url)}`,
        '-c',
        `mcp_servers.${NORIQ_MCP_NAME}.bearer_token_env_var=${CODEX_MCP_TOKEN_ENV}`,
        '-c',
        `mcp_servers.${NORIQ_MCP_NAME}.required=true`,
        // The per-kind Noriq floor (RUN-46). `enabled_tools` is codex's per-server allowlist —
        // anything absent is not even advertised to the model. Without this line the floor was
        // a CLAUDE property: the same verify run on codex had every tool the server exposes,
        // claim_task included, which is the one thing the adversarial gate exists to prevent
        // (the reviewer moving the work it judges). JSON.stringify emits a valid TOML string
        // array, which is how -c values are parsed.
        '-c',
        // A stage actor's narrowed set (DriverStartOptions.noriqTools) replaces the kind floor —
        // same seam as the Claude driver, enforced here by the server allowlist itself, which is
        // sandbox-independent: not-enabled is not-advertised, whatever the sandbox mode.
        `mcp_servers.${NORIQ_MCP_NAME}.enabled_tools=${tomlStringArray(expectedNoriqTools)}`,
      ]
    : [];
  const projectMcpArgs = projectMcpNames.flatMap((name): string[] => {
    const server = opts.projectMcp?.bundle.servers[name];
    if (!server) return [];
    const prefix = `mcp_servers.${name}`;
    const enabledTools = expectedProjectTools[name] ?? [];
    if (server.transport === 'stdio') {
      const authorization = opts.projectMcp?.bundle.launcherAuthorizations[name];
      if (!authorization) throw new Error(`project MCP server '${name}' lacks launcher authorization`);
      const serverEnv = projectMcpProcessEnv(opts.env ?? sanitizedAgentEnv(), server.env);
      return [
        '-c',
        `${prefix}.command=${tomlString(authorization.resolvedCommand)}`,
        '-c',
        `${prefix}.args=${tomlStringArray(server.args)}`,
        '-c',
        `${prefix}.env=${tomlStringTable(
          Object.fromEntries(
            Object.entries(serverEnv).filter((entry): entry is [string, string] => entry[1] !== undefined),
          ),
        )}`,
        '-c',
        `${prefix}.required=true`,
        '-c',
        `${prefix}.enabled_tools=${tomlStringArray(enabledTools)}`,
      ];
    }
    return [
      '-c',
      `${prefix}.url=${tomlString(server.url)}`,
      ...(Object.keys(server.headers).length
        ? ['-c', `${prefix}.http_headers=${tomlStringTable(server.headers)}`]
        : []),
      '-c',
      `${prefix}.required=true`,
      '-c',
      `${prefix}.enabled_tools=${tomlStringArray(enabledTools)}`,
    ];
  });
  // Model + effort (RUN-33), per-spawn for the same reason as the MCP config above: writing
  // them to ~/.codex/config.toml would reconfigure the human's own codex behind their back.
  // Both omitted unless asked for, so an unset Run gets codex's own default exactly as before.
  const modelArgs = [
    ...(opts.model ? ['-c', `model=${tomlString(opts.model)}`] : []),
    ...(opts.effort ? ['-c', `model_reasoning_effort=${mapEffort(opts.effort)}`] : []),
  ];
  // Sanitized env (RUN-24): strip secrets + block git push/credential prompts. Since RUN-109 the
  // stripped base is handed down by the supervisor (`opts.env`; the `??` is the test-only
  // fallback). Codex can only read its bearer token from the environment (no header option), so
  // that one token — and only when MCP is actually wired — is put back deliberately, on top of the
  // already-stripped base. See CODEX_MCP_TOKEN_ENV in security.ts for why this token is the exception.
  const base = opts.env ?? sanitizedAgentEnv();
  // RUN-290 defense in depth. CODEX_HOME below is the isolation boundary; these flags ensure a
  // deliberate Runner-specific preference cannot turn hosted apps or plugin-delivered tools back
  // on for an unattended session. Direct MCP config is policed by the effective-inventory gate.
  const capabilityArgs = [
    '--disable',
    'apps',
    '--disable',
    'plugins',
    '--disable',
    'remote_plugin',
    '--disable',
    'skill_mcp_dependency_install',
  ];
  // Legacy Runs keep their existing durable Runner-specific home. A contained mission gets a
  // fresh credential-only home per attempt, so Codex cannot persist config, hooks, plugins,
  // sessions, or MCP authority into a later child. The durable auth home is copied by Runner and
  // never mounted into the mission process tree.
  const attemptHome =
    opts.workspaceRoot && opts.containment ? createEphemeralAgentHome('codex', durableCodexHome) : null;
  const codexHome = attemptHome?.home ?? durableCodexHome;
  const childEnv = {
    ...base,
    // Keep package-manager caches and project MCP environment state inside the managed vendor
    // home. MissionAgentEnv deliberately removes the operator's HOME.
    HOME: codexHome,
    // Override, never default: an inherited CODEX_HOME is the exact ambient-config leak this
    // task closes. The directory was prepared by CodexDriver before this transport is spawned.
    CODEX_HOME: codexHome,
    ...(opts.noriqMcp ? { [CODEX_MCP_TOKEN_ENV]: opts.noriqMcp.token } : {}),
  };
  const codexArgs = ['app-server', ...capabilityArgs, ...mcpArgs, ...projectMcpArgs, ...modelArgs];
  const projectMcpReadOnlyRoots = projectMcpNames.flatMap((name) => {
    const authorization = opts.projectMcp?.bundle.launcherAuthorizations[name];
    return authorization ? [authorization.resolvedCommand, ...authorization.readOnlyRoots] : [];
  });
  let contained: ReturnType<AgentProcessContainment['spawn']> | null = null;
  try {
    contained = opts.containment
      ? opts.containment.spawn({
          runId: opts.runId ?? 'codex-transport',
          command: 'codex',
          args: codexArgs,
          cwd: opts.cwd,
          workspaceRoot: opts.workspaceRoot ?? opts.cwd,
          workspaceWrite: opts.workspaceWrite ?? opts.sandbox !== 'read-only',
          env: childEnv,
          providerCredentialRoots: [codexHome],
          ...(opts.tokenEnvelope ? { providerTokenEnvelope: opts.tokenEnvelope } : {}),
          additionalReadOnlyRoots: [...projectMcpReadOnlyRoots, ...(opts.containmentReadOnlyRoots ?? [])],
          protectedWorkspaceReadOnlyPaths: opts.protectedWorkspaceReadOnlyPaths,
          additionalWriteRoots: opts.containmentWriteRoots,
        })
      : null;
  } catch (error) {
    // No process was launched, so there is no process tree to await before removing the seed.
    attemptHome?.cleanup();
    throw error;
  }
  const child =
    contained?.child ??
    spawnFn('codex', codexArgs, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
      // Group it with its descendants so close() can reach them all (RUN-42). POSIX-only; on
      // Windows this is a no-op and taskkill /T walks the tree instead.
      ...treeSpawnOptions(),
    });
  const events = new AsyncQueue<CodexEvent>();
  let processExitObserved = child.exitCode !== null || child.signalCode !== null;
  let acknowledgeProcessExit!: () => void;
  const processExit = new Promise<void>((resolve) => {
    acknowledgeProcessExit = () => {
      if (processExitObserved) return;
      processExitObserved = true;
      resolve();
    };
    if (processExitObserved) resolve();
  });
  if (contained) {
    const cleanupAttemptHome = (): Error | null => {
      try {
        attemptHome?.cleanup();
        return null;
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
    };
    void contained.exited.then(
      () => {
        // `ContainedAgentProcess.exited` is the process-tree authority boundary. Never remove the
        // mounted home from a direct-child event while an MCP/tool descendant may still use it.
        const cleanupError = cleanupAttemptHome();
        if (cleanupError) {
          events.push({
            type: 'error',
            message: `codex attempt-home cleanup failed: ${cleanupError.message}`,
          });
        }
        acknowledgeProcessExit();
      },
      (error) => {
        events.push({
          type: 'error',
          // A rejected containment acknowledgement does not prove the complete process tree is
          // gone. Retain the attempt home instead of removing a mount a possibly-live descendant
          // may still use.
          message: `codex containment failed: ${String(error)}; attempt home retained`,
        });
      },
    );
  }
  const waitForProcessExit = (timeoutMs: number): Promise<boolean> => {
    if (processExitObserved || child.exitCode !== null || child.signalCode !== null) {
      acknowledgeProcessExit();
      return Promise.resolve(true);
    }
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
      processExit.then(() => finish(true));
    });
  };
  let nextId = 1;
  let threadId: string | null = null;
  let turnId: string | null = null;
  let mcpAttested = false;
  let mcpAttestationFailed = false;
  let mcpStatusRequestId: number | null = null;
  const mcpStatuses: Array<{ name?: unknown; tools?: unknown }> = [];
  let mcpStatusPages = 0;
  const mcpStatusCursors = new Set<string>();
  let mcpAttestationTimer: NodeJS.Timeout | null = null;
  const stopMcpAttestationDeadline = (): void => {
    if (!mcpAttestationTimer) return;
    clearTimeout(mcpAttestationTimer);
    mcpAttestationTimer = null;
  };
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
    // A failed spawn has no process to reap and emits no exit. Later process errors with a pid do
    // not prove death and deliberately leave the acknowledgement pending.
    if (!child.pid) acknowledgeProcessExit();
    stopMcpAttestationDeadline();
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

  const failMcpAttestation = (reason: string): void => {
    if (mcpAttestationFailed) return;
    mcpAttestationFailed = true;
    stopMcpAttestationDeadline();
    events.push({ type: 'error', message: `codex MCP isolation failed: ${reason}` });
    events.close();
    killTree(child, { force: false });
  };

  const flushPendingTurn = (): void => {
    if (!threadId || !mcpAttested || pendingTurn === null || mcpAttestationFailed) return;
    send(RPC.turnStart, { threadId, input: userInput(pendingTurn), cwd: opts.cwd });
    pendingTurn = null;
  };

  const requestMcpStatus = (cursor?: string): void => {
    if (!threadId || mcpAttestationFailed) return;
    const cursorKey = cursor ?? '<initial>';
    if (mcpStatusPages >= CODEX_MCP_ATTESTATION_MAX_PAGES) {
      failMcpAttestation(`server inventory exceeded ${CODEX_MCP_ATTESTATION_MAX_PAGES} pages`);
      return;
    }
    if (mcpStatusCursors.has(cursorKey)) {
      failMcpAttestation(`server inventory repeated cursor '${cursorKey}'`);
      return;
    }
    mcpStatusCursors.add(cursorKey);
    mcpStatusPages += 1;
    mcpStatusRequestId = send(RPC.mcpServerStatusList, {
      threadId,
      detail: 'toolsAndAuthOnly',
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if (mcpStatusRequestId === null) failMcpAttestation('could not request the effective server list');
  };

  const finishMcpAttestation = (): void => {
    const expectedNames = [...projectMcpNames, ...(opts.noriqMcp ? [NORIQ_MCP_NAME] : [])].sort();
    const actualNames = mcpStatuses.map((s) => String(s.name ?? '')).sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
      failMcpAttestation(
        `expected servers [${expectedNames.join(', ')}], got [${actualNames.join(', ') || 'none'}]`,
      );
      return;
    }
    if (opts.noriqMcp) {
      const noriq = mcpStatuses.find((s) => s.name === NORIQ_MCP_NAME);
      const actualTools =
        noriq?.tools && typeof noriq.tools === 'object' && !Array.isArray(noriq.tools)
          ? Object.keys(noriq.tools as Record<string, unknown>).sort()
          : [];
      const expectedTools = [...expectedNoriqTools].sort();
      if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) {
        failMcpAttestation(
          `noriq tool inventory differs from the stage allowlist (expected ${expectedTools.length}, got ${actualTools.length})`,
        );
        return;
      }
    }
    for (const name of projectMcpNames) {
      const project = mcpStatuses.find((status) => status.name === name);
      const actualTools =
        project?.tools && typeof project.tools === 'object' && !Array.isArray(project.tools)
          ? Object.keys(project.tools as Record<string, unknown>).sort()
          : [];
      const expectedTools = [...(expectedProjectTools[name] ?? [])].sort();
      if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) {
        failMcpAttestation(
          `${name} tool inventory differs from its exact grant (expected [${expectedTools.join(', ')}], got [${actualTools.join(', ')}])`,
        );
        return;
      }
    }
    mcpAttested = true;
    stopMcpAttestationDeadline();
    flushPendingTurn();
  };

  mcpAttestationTimer = setTimeout(
    () => failMcpAttestation(`attestation exceeded ${CODEX_MCP_ATTESTATION_TIMEOUT_MS}ms`),
    CODEX_MCP_ATTESTATION_TIMEOUT_MS,
  );
  mcpAttestationTimer.unref?.();

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
      if (msg.id !== undefined && msg.id === mcpStatusRequestId) {
        failMcpAttestation(`server inventory request was rejected: ${msg.error.message ?? 'unknown error'}`);
        return;
      }
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
      if (msg.id !== undefined && msg.id === mcpStatusRequestId) {
        const result = msg.result as {
          data?: Array<{ name?: unknown; tools?: unknown }>;
          nextCursor?: unknown;
        };
        if (!Array.isArray(result.data)) {
          failMcpAttestation('server inventory response had no data array');
          return;
        }
        if (mcpStatuses.length + result.data.length > CODEX_MCP_ATTESTATION_MAX_RESULTS) {
          failMcpAttestation(`server inventory exceeded ${CODEX_MCP_ATTESTATION_MAX_RESULTS} results`);
          return;
        }
        mcpStatuses.push(...result.data);
        if (result.nextCursor !== undefined && result.nextCursor !== null && result.nextCursor !== '') {
          if (typeof result.nextCursor !== 'string') {
            failMcpAttestation('server inventory returned an invalid cursor');
            return;
          }
          requestMcpStatus(result.nextCursor);
        } else finishMcpAttestation();
        return;
      }
      // 0.142.x answered thread/start with {threadId}; 0.144.x nests it as {thread:{id}}.
      const r = msg.result as { threadId?: string; thread?: { id?: string }; turn?: { id?: string } };
      const startedThread = r.threadId ?? r.thread?.id;
      if (startedThread) {
        threadId = startedThread;
        // The thread exists, but model work stays held until its EFFECTIVE MCP inventory—not just
        // the CLI args we intended—is exactly the one-server capability boundary RUN-290 promises.
        requestMcpStatus();
      }
      if (r.turn?.id) turnId = r.turn.id;
    }
    if (msg.method) {
      if (msg.method === 'mcpServer/startupStatus/updated') {
        const name = String(msg.params?.name ?? '');
        const expected = new Set([...projectMcpNames, ...(opts.noriqMcp ? [NORIQ_MCP_NAME] : [])]);
        if (name && !expected.has(name)) {
          failMcpAttestation(`unexpected server started: ${name}`);
          return;
        }
      }
      const ev = normalizeNotification(msg.method, msg.params ?? {});
      // Unmapped frames still push `activity` (RUN-201): every frame is proof of life.
      events.push(ev ?? { type: 'activity' });
    }
  });
  child.on('exit', () => {
    acknowledgeProcessExit();
    stopMcpAttestationDeadline();
    events.close();
  });
  // RUN-201 belt: twice live, a dead child's exit never surfaced as a closed stream. 'close'
  // (stdio drained) is a second signal, and the reaper polls the one fact that cannot be missed:
  // a reaped process has a non-null exitCode. Both funnel into the same idempotent close, and
  // the reaper dies on every path out — exit, close, or the transport's own close().
  const reaper = setInterval(() => {
    if (child.exitCode !== null || child.signalCode !== null) {
      acknowledgeProcessExit();
      stopReaper();
      events.close();
    }
  }, 30_000);
  reaper.unref?.();
  const stopReaper = () => clearInterval(reaper);
  child.on('exit', () => {
    // `exit` is the direct-child death acknowledgement. Do not wait for `close`: inherited stdio
    // can keep that later event open after Codex itself is gone, and the capability promised by
    // this transport is deliberately only main-process termination.
    acknowledgeProcessExit();
    stopReaper();
  });
  child.on('close', () => {
    // Node emits close only after exit and all stdio close, so it is also process-death evidence.
    acknowledgeProcessExit();
    stopReaper();
    stopMcpAttestationDeadline();
    events.close();
  });

  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    const attempt = (async () => {
      stopMcpAttestationDeadline();
      if (processExitObserved || child.exitCode !== null || child.signalCode !== null) {
        acknowledgeProcessExit();
        stopReaper();
        return;
      }

      // Reach the ordinary agent/tool/MCP tree first, then escalate. This proves only the direct
      // codex process: process groups and taskkill /T are best-effort reachability mechanisms, not
      // non-escapable containment, which is why the driver capability remains `main-process`.
      killTree(child, { force: false });
      if (await waitForProcessExit(CODEX_GRACEFUL_STOP_MS)) {
        stopReaper();
        return;
      }
      killTree(child, { force: true });
      if (await waitForProcessExit(CODEX_FORCE_STOP_MS)) {
        stopReaper();
        return;
      }
      throw new Error(
        `codex process did not exit within ${CODEX_GRACEFUL_STOP_MS}ms graceful plus ${CODEX_FORCE_STOP_MS}ms forced shutdown`,
      );
    })();
    closePromise = attempt;
    void attempt.catch(() => {
      // The caller must see the bounded failure now, but a late real exit can make a subsequent
      // acknowledgement succeed. Never leave the rejected attempt memoized forever.
      if (closePromise === attempt) closePromise = null;
    });
    return attempt;
  };

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
    processExit,
    // The driver calls this synchronously the instant spawnCodex() returns, long before
    // thread/start's response has been read off stdout — so `threadId` is still null and
    // every real run posted `turn/start {threadId: null}`, which the app-server rejects:
    // no turn ever started and the stream ended with 'codex stream ended without
    // completing a turn'. Buffer instead, and flush when the thread actually exists.
    // (Every codex test injects a fake transport, so nothing caught this.)
    sendUserTurn: (text) => {
      if (threadId && mcpAttested) send(RPC.turnStart, { threadId, input: userInput(text), cwd: opts.cwd });
      else pendingTurn = text;
    },
    steer: (text) => {
      // Nothing to steer until the thread + turn exist; report it rather than pretend.
      if (!threadId || !mcpAttested) return false;
      const id = send(RPC.turnSteer, { threadId, expectedTurnId: turnId, input: userInput(text) });
      if (id !== null) nonFatalIds.add(id); // a rejected steer must not fail the whole run
      return id !== null;
    },
    interrupt: () => send(RPC.turnInterrupt, { threadId, turnId }, true),
    close,
  };
};
