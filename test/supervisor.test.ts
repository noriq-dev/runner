import path from 'node:path';
import type { ModelDefault, PermissionProfile, ProjectManifest, Run, RunBudget } from '@noriq-dev/shared';
import { ExecutionSpec, UNATTRIBUTED_MODEL_ID } from '@noriq-dev/shared';
import { describe, expect, it, vi } from 'vitest';
import type { LedgerEntry } from '../src/adjudication';
import type { ParkState, RunAgent } from '../src/client';
import type { ContinuableRun } from '../src/continuable';
import { totalTokens } from '../src/drivers/budget';
import type {
  AgentDriver,
  DriverCapabilities,
  DriverCatalog,
  DriverExit,
  DriverSession,
  DriverStartOptions,
  DriverTelemetry,
  ModelUsage,
} from '../src/drivers/types';
import { zeroTelemetry } from '../src/drivers/types';
import type { LockConflict } from '../src/lock-client';
import type { ParkedRun } from '../src/parked';
import type { DocReader, PathProbe } from '../src/repo-context';
import { noriqToolNamesFor } from '../src/security';
import { LOCK_RELEASE_TIMEOUT_MS } from '../src/stages/settle';
import {
  type AnchorTask,
  type RunReport,
  RunSupervisor,
  RunTally,
  type SpinOffLookup,
  assemblePrompt,
  effectiveKind,
  mergeBudget,
  mergeModelUsage,
  resolveModel,
  telemetryFromSpent,
} from '../src/supervisor';
import type { LockContext, LockOutcome, Workspace } from '../src/vcs/types';
import { BUILTIN_WORKFLOWS } from '../src/workflow';

// A driver whose run the test completes by calling complete() — which drives the
// wrapped onExit (superviseBudget resolves its done from it).
class FakeDriver implements AgentDriver {
  opts?: DriverStartOptions;
  /** The session id this driver reports — what a park persists and a resume takes (RUN-30). */
  sessionId: string | null = 'sess-fake';
  /** Every start(), in order. A resumed run must reuse the session, not open a fresh one. */
  starts: DriverStartOptions[] = [];
  /** Turns handed back by the supervisor (RUN-29's verify feedback loop). */
  continuations: string[] = [];
  /** Outcome of each continueWith, in order. Defaults to 'done' — the agent fixed it. */
  continueOutcomes: Array<'done' | 'failed'> = [];
  /** Text the agent "emits" during each continueWith, in order — models the real driver
   *  streaming a fix turn's output via onText (RUN-79's ledger reads it). Empty = silent. */
  continueTexts: string[] = [];
  /** Tokens each continueWith turn spends, in order (RUN-133). Default 0 = a free fix turn, which
   *  is what every pre-RUN-133 test assumed. */
  continueTokens: number[] = [];
  /** The primary session's running cumulative, so a fix turn reports a TOTAL the way a real driver
   *  does rather than a per-turn delta. */
  private primarySpend = 0;
  /** True once stop() was called — a multiTurn session that nobody closes hangs the daemon. */
  stopped = false;
  /** True when the budget layer stopped the session DURING a hand-back turn — the RUN-133 run-level
   *  guard firing, as distinct from settle's ordinary stopSession at the end of every run. */
  stoppedDuringFix = false;
  /** Mirrors the real drivers' capabilities (RUN-110): claude wires hooks, codex doesn't. */
  capabilities: DriverCapabilities = {
    toolHooks: true,
    steer: true,
    interrupt: true,
    resumableSession: true,
    perModelTelemetry: true,
  };
  catalog: DriverCatalog = { models: [], efforts: [] };
  constructor(readonly tool: 'claude' | 'codex') {
    if (tool === 'codex') {
      this.capabilities = {
        toolHooks: false,
        steer: true,
        interrupt: true,
        resumableSession: false,
        perModelTelemetry: false,
      };
    }
  }
  start(opts: DriverStartOptions): DriverSession {
    this.opts = opts;
    this.starts.push(opts);
    return {
      runId: opts.runId,
      sessionId: this.sessionId,
      pushInput: () => true,
      interrupt: async () => {},
      stop: async () => {
        this.stopped = true;
        this.opts?.handlers?.onExit?.({
          outcome: 'failed',
          isError: true,
          reason: 'stopped',
          telemetry: zeroTelemetry(),
        });
      },
      done: () => new Promise<DriverExit>(() => {}),
      // Mirrors the real driver: present ONLY under multiTurn, so a test that forgets to ask for
      // it sees exactly what a scope run sees — no loop.
      continueWith: opts.multiTurn
        ? async (text: string): Promise<DriverExit> => {
            this.continuations.push(text);
            // Stream this fix turn's output the way the real driver does, so anything reading
            // the session text (the ledger's RESPONSE-block capture) sees it. Emit to THIS
            // session's handlers (the closed-over opts), not this.opts — the latter has since
            // moved to the reviewer session, but the fix turn belongs to the build session.
            const emitted = this.continueTexts.shift();
            if (emitted) opts.handlers?.onText?.(emitted);
            // A fix turn SPENDS (RUN-133). The fake used to return zero telemetry and emit no tick,
            // which made the one overrun this task exists to close invisible: the builder's session
            // is kept open across the reviewer's spend, so a hand-back is the one place a run can
            // exceed its ceiling while no single session breaches its own. `continueTokens` scripts
            // it; the default stays 0 so no existing test changes.
            const spend = this.continueTokens.shift() ?? 0;
            this.primarySpend += spend;
            const cumulative = { ...zeroTelemetry(), outputTokens: this.primarySpend };
            if (spend) opts.handlers?.onTelemetry?.(cumulative);
            // A real driver's turn ENDS when the budget layer SIGTERMs the session mid-flight. The
            // tick above is what trips it, so the check has to come after — and this is the only
            // place a run-level breach is observable, since settle stops every session anyway.
            if (this.stopped) {
              this.stoppedDuringFix = true;
              return { outcome: 'failed', isError: true, reason: 'stopped', telemetry: cumulative };
            }
            const outcome = this.continueOutcomes.shift() ?? 'done';
            return {
              outcome,
              isError: outcome === 'failed',
              reason: outcome === 'failed' ? 'died mid-fix' : null,
              // The session's CUMULATIVE, which is what a real driver reports and what the tally's
              // last-writer-wins slot expects.
              telemetry: spend ? cumulative : zeroTelemetry(),
            };
          }
        : undefined,
    };
  }
  emitText(text: string): void {
    this.opts?.handlers?.onText?.(text);
  }
  emitTelemetry(t: Partial<DriverTelemetry> = {}): void {
    this.opts?.handlers?.onTelemetry?.({ ...zeroTelemetry(), ...t });
  }
  /** Default spend is 42 output tokens; a test that cares about the model mix (RUN-59) passes its
   *  own telemetry (e.g. a modelUsage breakdown). */
  complete(outcome: 'done' | 'failed', telemetry: Partial<DriverTelemetry> = { outputTokens: 42 }): void {
    // Keep the fix-turn cumulative continuous with whatever the PRIMARY session reported. A
    // reviewer/conflict session completing must not rewrite the builder's running total — they are
    // different sessions with different slots.
    if (!this.opts?.runId.includes(':')) this.primarySpend = telemetry.outputTokens ?? this.primarySpend;
    this.opts?.handlers?.onExit?.({
      outcome,
      isError: outcome === 'failed',
      reason: outcome === 'failed' ? 'boom' : null,
      telemetry: { ...zeroTelemetry(), ...telemetry },
    });
  }
}

class FakeWorktrees {
  created: Array<{
    root: string;
    runId: string;
    readOnly: boolean;
    fromRunId?: string;
    fromTarget?: string;
  }> = [];
  removed: string[] = [];
  /** Whether the agent left a diff. Defaults true — most tests model real work. */
  changed = true;
  hasChangesCalls = 0;
  /** Set to make lease() reject, modelling a branch that no longer exists. */
  createFails = false;
  lease = async (
    root: string,
    runId: string,
    opts: { readOnly?: boolean; fromRunId?: string; fromTarget?: string } = {},
  ): Promise<Workspace> => {
    if (this.createFails) throw new Error(`invalid reference: ${opts.fromRunId}`);
    this.created.push({
      root,
      runId,
      readOnly: !!opts.readOnly,
      fromRunId: opts.fromRunId,
      fromTarget: opts.fromTarget,
    });
    return {
      runId,
      localPath: `/wt/${runId}`,
      readOnly: !!opts.readOnly,
      baseId: 'base0000',
      workRef: `noriq/run/${runId}`,
      // This fake is its own backend, so its location is its own business — which is the
      // point: the supervisor must work without ever looking inside it.
      location: { repoRoot: root, branch: `noriq/run/${runId}` },
    };
  };
  /** When set, `hasWork` REJECTS instead of answering — the "could not ask" case a backend must
   *  never report as "no work" (RUN-152). */
  hasWorkError: string | null = null;
  hasWork = async (): Promise<boolean> => {
    this.hasChangesCalls += 1;
    if (this.hasWorkError) throw new Error(this.hasWorkError);
    return this.changed;
  };
  commits: Array<{ path: string; message: string }> = [];
  checkpoint = async (ws: Workspace, message: string): Promise<boolean> => {
    this.commits.push({ path: ws.localPath, message });
    return this.changed;
  };
  dispose = async (ws: Workspace): Promise<void> => {
    this.removed.push(ws.localPath);
  };

  // ── locking (RUN-98/102) ─────────────────────────────────────────────────────
  /** Paths this run "changed" — the hard floor acquires these before landing. Empty (default)
   *  → the floor no-ops, so every existing test is unaffected. */
  changedFiles: string[] = [];
  /** Conflicts the lock layer returns; empty = granted. */
  lockConflicts: LockConflict[] = [];
  /** Every acquire the supervisor made through the seam (floor + reactive). */
  lockCalls: Array<{ paths: string[]; ctx: LockContext }> = [];
  releases: Array<{ paths?: string[] }> = [];
  /** When set, `changedPaths` REJECTS — git could not say what the run touched (RUN-156). */
  changedPathsError: string | null = null;
  changedPaths = async (): Promise<string[]> => {
    if (this.changedPathsError) throw new Error(this.changedPathsError);
    return this.changedFiles;
  };
  /** When set, `lock` REJECTS — the service did not answer at all (RUN-156). */
  lockError: string | null = null;
  /** A project with locking genuinely off: the service ANSWERS `enabled:false`. */
  lockingDisabled = false;
  lock = async (_ws: Workspace, paths: string[], ctx: LockContext): Promise<LockOutcome> => {
    this.lockCalls.push({ paths, ctx });
    if (this.lockError) throw new Error(this.lockError);
    if (this.lockingDisabled) return { ok: true, enabled: false, locks: [] };
    return this.lockConflicts.length
      ? { ok: false, conflicts: this.lockConflicts }
      : { ok: true, enabled: true, locks: paths.map((p) => ({ id: p, path: p })) };
  };
  unlock = async (_ws: Workspace, sel: { lockIds?: string[]; paths?: string[] }): Promise<void> => {
    this.releases.push({ paths: sel.paths });
  };
  /** Every terminal release-all (RUN-104), by the run's holder token. */
  releasedAll: string[] = [];
  /** Ordered log of landing, lock-release and the terminal report. The release is bounded on both
   *  sides: AFTER landing so locks are held through the merge (RUN-105), and BEFORE the terminal
   *  report, which is what retires the agent the release authenticates as (RUN-177). */
  timeline: Array<'land' | 'release' | 'report'> = [];
  /** A lock service that accepts the request and never answers — the hang the settle path must
   *  survive, which no `.catch()` can rescue (RUN-177). */
  hangRelease = false;
  releaseRunLocks = async (_ws: Workspace, ctx: LockContext): Promise<void> => {
    if (this.hangRelease) return new Promise<void>(() => {});
    // Record on a LATER tick, deliberately. Recording synchronously would make the timeline read
    // `['release', 'report']` even if settle stopped awaiting the release at all — the ordering
    // assertions would pass against the very regression they exist to catch.
    await Promise.resolve();
    this.releasedAll.push(ctx.token);
    this.timeline.push('release');
  };

  // ── landing ────────────────────────────────────────────────────────────────
  /** Branches that exist. The landing branch is absent until something creates it. */
  branches = new Set<string>(['main']);
  createdBranches: Array<{ branch: string; from: string }> = [];
  /** Paths git cannot merge on the next rebase; empty = clean. */
  conflicts: string[] = [];
  /** Set by resumeIntegrate's outcome — what the "agent" left behind. */
  stillConflicted: string[] = [];
  rebases: string[] = [];
  aborted = 0;
  landings: Array<{ branch: string; fromRef: string }> = [];
  /** Make publish lose the race, modelling a branch that moved under us. */
  landRaces = false;

  targetExists = async (_root: string, ref: string): Promise<boolean> => this.branches.has(ref);
  createTarget = async (_root: string, branch: string, from: string): Promise<void> => {
    this.branches.add(branch);
    this.createdBranches.push({ branch, from });
  };
  integrate = async (
    _ws: Workspace,
    onto: string,
  ): Promise<{ ok: true } | { ok: false; conflicts: string[] }> => {
    this.rebases.push(onto);
    return this.conflicts.length ? { ok: false, conflicts: this.conflicts } : { ok: true };
  };
  resumeIntegrate = async (): Promise<{ ok: true } | { ok: false; conflicts: string[] }> =>
    this.stillConflicted.length ? { ok: false, conflicts: this.stillConflicted } : { ok: true };
  abandonIntegrate = async (): Promise<void> => {
    this.aborted += 1;
  };
  publish = async (
    ws: Workspace,
    branch: string,
  ): Promise<{ ok: true; sha: string } | { ok: false; reason: 'race' | 'error'; detail: string }> => {
    if (this.landRaces) return { ok: false, reason: 'race', detail: `${branch} has moved on` };
    if (this.landRefuses) return { ok: false, reason: 'error', detail: this.landRefuses };
    // fromRef preserved in the recording via workRef, so the assertions still name the run
    // branch that reached publish — the fake reads its own display field, never location.
    this.landings.push({ branch, fromRef: ws.workRef });
    this.timeline.push('land');
    return { ok: true, sha: 'landedsha' };
  };
  /** Non-empty → git refuses the landing with this message (e.g. a checked-out branch). */
  landRefuses = '';

  /** Every push the supervisor made. Empty is the assertion that matters most: `autoPush`
   *  defaults false, and a landing must not reach a remote unless a repo asked (RUN-27). */
  pushes: Array<{ root: string; branch: string }> = [];
  /** Non-empty → the push fails with this message. The run must still be a SUCCESS: the work
   *  is landed locally, and only its trip to the remote failed. */
  pushFails = '';
  share = async (root: string, branch: string): Promise<{ ok: true } | { ok: false; detail: string }> => {
    this.pushes.push({ root, branch });
    return this.pushFails ? { ok: false, detail: this.pushFails } : { ok: true };
  };
}

const perm = (write: boolean): PermissionProfile => ({
  write,
  allow: [],
  deny: [],
  auto: false,
});
const noModel = (): ModelDefault => ({ agent: null, model: null, effort: null });
const manifest = (over: Partial<ProjectManifest> = {}): ProjectManifest => ({
  key: 'PROJ',
  board: null,
  verify: { cmd: 'npm test', timeoutSeconds: null, shell: null, maxRounds: 2, agent: null },
  context: { requiredReading: [], entryPoints: [], conventions: [], agentInstructions: 'inline' as const },
  tool: null,
  defaultBranch: null,
  land: null,
  permissions: { scope: perm(false), build: perm(true), verify: perm(false) },
  // No per-kind model/effort by default: this repo takes whatever the tool defaults to,
  // which is what every run got before RUN-33 existed.
  defaults: { scope: noModel(), build: noModel(), verify: noModel() },
  workflows: {},
  ...over,
});

/** Let supervise() run to the point where it has started the driver. A macrotask
 *  drains the microtask queue, so this doesn't break every time the pipeline gains a step. */
const flush = () => new Promise((r) => setTimeout(r, 0));

const makeRun = (over: Partial<Run> = {}): Run => ({
  id: 'run_1',
  projectId: 'prj_p',
  runnerId: 'rnr_1',
  agentId: null,
  // No plan by default: a one-off dispatch. The per-plan branch (RUN-28) is opt-in on both
  // sides — a `<planKey>` template AND a run that actually belongs to a plan.
  planKey: null,
  // No override by default: a dispatch steers its branch only when a human asked (RUN-41).
  targetBranch: null,
  kind: 'scope',
  anchor: null,
  verifiesRunId: null,
  brief: 'ship the thing',
  repoRef: 'repo_a',
  agentTool: 'claude',
  // No coordinate by default (RUN-114): a legacy-shaped dispatch — the runner synthesizes one
  // from agentTool/model/effort below, so behaviour is identical to before the coordinate existed.
  agent: null,
  // No custom workflow by default (RUN-121): the run's kind selects the built-in.
  workflow: null,
  // No per-dispatch override by default (RUN-33): the repo's [defaults], then the tool's own.
  model: null,
  effort: null,
  budget: { maxTokens: null, maxUsd: null, maxDurationSeconds: null, maxRounds: null },
  status: 'dispatched',
  // Not yet started, so nothing to report (RUN-31). The daemon sets the phase; the server
  // only ever reads it back to us.
  phase: null,
  exit: null,
  worktreePath: null,
  // The server's read-path field (RUN-59); the daemon only ever WRITES the mix via telemetry.
  modelUsage: null,
  createdBy: 'usr_1',
  createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
  dispatchedAt: '2026-07-14T00:00:00.000Z',
  startedAt: null,
  ...over,
});

function harness(
  over: {
    manifest?: ProjectManifest;
    hasRepo?: boolean;
    drivers?: Partial<Record<'claude' | 'codex', AgentDriver>>;
    verifyPasses?: boolean;
    /** Per-call verify outcomes, in order — models the agent fixing it (RUN-29). */
    verifyResults?: boolean[];
    defaultBudget?: RunBudget | null;
    /** false → the agent left the worktree pristine (a no-op run). */
    changed?: boolean;
    /** true → worktree creation throws (e.g. the build's branch is gone). */
    createFails?: boolean;
    /** Paths git cannot merge when the run rebases onto the landing branch. */
    conflicts?: string[];
    /** What the agent left unresolved after its attempt. */
    stillConflicted?: string[];
    /** true → the landing branch moved under the run. */
    landRaces?: boolean;
    /** A per-repo backend riding ResolvedRepo (RUN-60) — must win over deps.vcs. */
    repoVcs?: FakeWorktrees;
    /** Override the stubbed `[context]` seams (RUN-128/129) for a test that exercises them. */
    pathProbe?: PathProbe;
    readDoc?: DocReader;
    contextBudget?: number;
    /** Pre-seed the continuable store (RUN-92) to model a re-dispatched "continue a failed run". */
    continuableSeed?: ContinuableRun;
    /** What the server says when asked whether the run parked (RUN-30). */
    parkState?: Partial<ParkState>;
    /** true → asking the server throws, modelling a server the daemon cannot reach. */
    parkStateFails?: boolean;
    parkTtlHours?: number;
    /** RUN-81 phase-gate probe. Presence of this key wires checkClaimable; the value is what it
     *  returns ({claimable:false} declines the spawn, null = probe unavailable → fail open).
     *  Absent = the dep is not wired at all (the pre-RUN-81 daemon). */
    claimGate?: { claimable: boolean; reason: string | null } | null;
    /** The paths a build "changed" — the hard lock floor (RUN-102) acquires these. */
    changedFiles?: string[];
    /** Conflicts the lock layer returns when the floor acquires; empty = granted. */
    lockConflicts?: LockConflict[];
    hangRelease?: boolean;
    /** The declared scope the predictive resolver returns (RUN-103); presence wires the dep. */
    lockScope?: string[] | null;
    /** Which runs an operator has cancelled (RUN-165). Presence wires the steering dep. */
    cancelled?: string[];
    /** The anchor task the server hands back — how a test gives a run an execution spec, and so
     *  the acceptance criteria its gate must answer (RUN-145). */
    anchorTask?: AnchorTask | null;
    /** RUN-188 task-pointer lookup. Presence wires resolveSpinOff; the map is ref → task (a
     *  missing ref answers null, 'fails' → every lookup throws, 'hangs' → every lookup never
     *  resolves, driving the deadline). Absent = the dep is not wired, the pre-RUN-188 daemon. */
    spinOffTasks?: Record<string, SpinOffLookup> | 'fails' | 'hangs';
  } = {},
) {
  // Mutable, because a park can last 72 hours and a human may correct the spec while it waits
  // (RUN-164) — a test of a resumed chain has to be able to model that.
  let anchorTask = over.anchorTask ?? null;
  const worktrees = new FakeWorktrees();
  if (over.changed === false) worktrees.changed = false;
  if (over.createFails) worktrees.createFails = true;
  if (over.conflicts) worktrees.conflicts = over.conflicts;
  if (over.stillConflicted) worktrees.stillConflicted = over.stillConflicted;
  if (over.landRaces) worktrees.landRaces = true;
  if (over.changedFiles) worktrees.changedFiles = over.changedFiles;
  if (over.lockConflicts) worktrees.lockConflicts = over.lockConflicts;
  if (over.hangRelease) worktrees.hangRelease = true;
  const reports: Array<{ runId: string } & RunReport> = [];
  const transcript: Array<{
    seq: number;
    role: string;
    round: number | null;
    step: string | null;
    text: string;
  }> = [];
  const comments: Array<{ projectId: string; taskId: string; body: string }> = [];
  const claude = new FakeDriver('claude');
  const codex = new FakeDriver('codex');
  let verifyRan = false;
  let verifyCalls = 0;
  const parked = new FakeParked();
  const continuable = new FakeContinuable();
  if (over.continuableSeed) continuable.entries.set(over.continuableSeed.runId, over.continuableSeed);
  const parkChecks: string[] = [];
  const claimChecks: string[] = [];
  const agentCreates: Array<{ label?: string; allowedTools?: string[] }> = [];
  // Mutable, because the real thing is: once a human answers, the server marks the signal
  // answered and moves the run back to running, so the NEXT check says "not blocked".
  const park = { state: over.parkState };
  const supervisor = new RunSupervisor({
    drivers: over.drivers ?? { claude, codex },
    vcs: worktrees,
    resolveRepo: (repoRef) =>
      over.hasRepo === false
        ? null
        : {
            root: `/repos/${repoRef}`,
            manifest: over.manifest ?? manifest(),
            ...(over.repoVcs ? { vcs: over.repoVcs } : {}),
          },
    report: (runId, r) => {
      reports.push({ runId, ...r });
      // Only the TERMINAL report carries `exit` — and only that one retires the run agent.
      if (r.exit) worktrees.timeline.push('report');
    },
    reportLog: (_runId, segments) => transcript.push(...segments),
    postComment: (projectId, taskId, body) => comments.push({ projectId, taskId, body }),
    // `[context]` resolution (RUN-128/129) is stubbed out here, like every other seam: these
    // repo roots (`/repos/repo_a`) do not exist, and a real fs round-trip settles on the
    // threadpool — LATER than the single `flush()` tick these tests spawn within, which would
    // strand every one of them waiting on a session that had not been created yet.
    // Context rendering has its own coverage in test/repo-context.test.ts.
    pathProbe: over.pathProbe ?? (async () => 'missing'),
    readDoc: over.readDoc ?? (async () => ''),
    ...(over.contextBudget !== undefined ? { contextBudget: over.contextBudget } : {}),
    verifyExec: async () => {
      verifyRan = true;
      verifyCalls += 1;
      // `verifyResults` scripts a sequence, so a test can model "fails, agent fixes it, passes" —
      // the whole point of RUN-29's loop. Falls back to the old fixed behaviour.
      const scripted = over.verifyResults?.[verifyCalls - 1];
      if (scripted !== undefined) {
        return scripted
          ? { exitCode: 0, output: 'ok', timedOut: false }
          : { exitCode: 1, output: 'TS2322: type error', timedOut: false };
      }
      return over.verifyPasses === false
        ? { exitCode: 1, output: 'TS2322: type error', timedOut: false }
        : { exitCode: 0, output: 'ok', timedOut: false };
    },
    createRunAgent: async (_runId, opts) => {
      agentCreates.push(opts ?? {});
      return testAgent();
    },
    server: 'https://noriq.example',
    defaultBudget: over.defaultBudget,
    parked,
    continuable,
    parkTtlHours: over.parkTtlHours,
    getParkState: async (runId) => {
      parkChecks.push(runId);
      if (over.parkStateFails) throw new Error('server unreachable');
      return {
        status: park.state?.blocked ? 'blocked' : 'running',
        blocked: false,
        signalId: null,
        question: null,
        answer: null,
        ...park.state,
      };
    },
    ...('claimGate' in over
      ? {
          checkClaimable: async (taskId: string) => {
            claimChecks.push(taskId);
            return over.claimGate ?? null;
          },
        }
      : {}),
    ...(over.lockScope !== undefined ? { resolveLockScope: () => over.lockScope ?? null } : {}),
    ...(over.anchorTask !== undefined ? { resolveTask: async () => anchorTask } : {}),
    ...(over.spinOffTasks !== undefined
      ? {
          resolveSpinOff: (ref: string): Promise<SpinOffLookup | null> => {
            if (over.spinOffTasks === 'hangs') return new Promise(() => {}); // never resolves
            if (over.spinOffTasks === 'fails') return Promise.reject(new Error('server unreachable'));
            return Promise.resolve((over.spinOffTasks as Record<string, SpinOffLookup>)[ref] ?? null);
          },
          // Tests must not wait out the real deadline; the value only needs to be a deadline.
          spinOffTimeoutMs: 25,
        }
      : {}),
    ...(over.cancelled
      ? {
          steering: {
            register: () => {},
            unregister: () => {},
            isCancelled: (runId: string) => (over.cancelled ?? []).includes(runId),
            forget: () => {},
          },
        }
      : {}),
  });
  return {
    supervisor,
    worktrees,
    reports,
    comments,
    transcript,
    claude,
    codex,
    parked,
    continuable,
    parkChecks,
    claimChecks,
    agentCreates,
    /** Model the run asking a question on its NEXT session end — a park mid-chain. */
    parkNext: () => {
      park.state = { blocked: true, signalId: 'sig_1', question: 'Approach A or B?' };
    },
    /** Model a human rewriting the task's spec while the run is parked. */
    setAnchorTask: (t: AnchorTask | null) => {
      anchorTask = t;
    },
    /** Model the human answering: the server stops calling the run blocked. */
    answerIt: () => {
      park.state = { blocked: false };
    },
    verifyRan: () => verifyRan,
    verifyCalls: () => verifyCalls,
  };
}

/** The parked store, in memory. Its on-disk behaviour is pinned in parked.test.ts; here it is
 *  just the thing supervise() hands a park to and resume() takes one from. */
class FakeParked {
  entries = new Map<string, ParkedRun>();
  park = async (e: ParkedRun): Promise<void> => {
    this.entries.set(e.run.id, e);
  };
  get = async (id: string): Promise<ParkedRun | null> => this.entries.get(id) ?? null;
  list = async (): Promise<ParkedRun[]> => [...this.entries.values()];
  unpark = async (id: string): Promise<ParkedRun | null> => {
    const e = this.entries.get(id) ?? null;
    this.entries.delete(id);
    return e;
  };
}

/** The continuable store (RUN-92), in memory — what supervise() reads to re-seed a continuation
 *  and writes at a gate-fail. On-disk behaviour is pinned in continuable.test.ts. */
class FakeContinuable {
  entries = new Map<string, ContinuableRun>();
  puts: ContinuableRun[] = [];
  put = async (e: ContinuableRun): Promise<void> => {
    this.puts.push(e);
    this.entries.set(e.runId, e);
  };
  get = async (id: string): Promise<ContinuableRun | null> => this.entries.get(id) ?? null;
  remove = async (id: string): Promise<void> => {
    this.entries.delete(id);
  };
}

/** The identity the daemon creates for a Run (RUN-43). The old fixture was the bare string
 *  'agt_daemon', which quietly hid a real bug: daemon.ts passed the RUNNER id into a field
 *  documented as an agent id, and no test could tell the difference. */
const testAgent = (over: Partial<RunAgent> = {}): RunAgent => ({
  agentId: 'agt_run1',
  label: 'build-abc123',
  projectId: 'prj_test',
  token: 'plnrt_bound_to_agt_run1',
  expiresIn: 3600,
  ...over,
});

describe('assemblePrompt', () => {
  it('scope prompt is read-only + create_plan, with identity', () => {
    const p = assemblePrompt(makeRun({ kind: 'scope' }), manifest(), {
      agent: testAgent(),
      server: 'https://s',
    });
    expect(p).toMatch(/SCOPE/);
    expect(p).toMatch(/create_plan/);
    expect(p).toMatch(/proposed:true/); // RUN-23: scope plans must be gated for human approval
    expect(p).toMatch(/Do NOT modify/);
    // The agent is TOLD its identity (RUN-43); it no longer registers itself, so asserting
    // a set_agent_identity instruction would assert the bug this task removed.
    expect(p).toContain('agt_run1');
    expect(p).toMatch(/do NOT call set_agent_identity/);
    expect(p).toContain('https://s');
  });
  it('build prompt is read-write + review diff + verify cmd + anchored task', () => {
    const p = assemblePrompt(
      makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } }),
      manifest(),
      { agent: testAgent(), server: 'https://s' },
    );
    expect(p).toMatch(/BUILD/);
    expect(p).toMatch(/review diff/);
    expect(p).toMatch(/never publish or push/);
    expect(p).toContain('npm test'); // verify cmd
    expect(p).toContain('task_9');
    // VCS-neutral: the build prompt names no git verb (a live backend has no worktree/commit).
    expect(p).not.toMatch(/worktree|git commit/);
  });
  it('tells the build agent the daemon commits, so it stops reporting that as a failure', () => {
    // A real run ended with "⚠️ Not committed — a human needs to commit it" 71s AFTER
    // the daemon had already committed it. The prompt never said who commits.
    const p = assemblePrompt(makeRun({ kind: 'build' }), manifest(), {
      agent: testAgent(),
      server: 'https://s',
    });
    expect(p).toMatch(/do NOT need to commit/i);
    expect(p).toMatch(/daemon captures/i);
  });
});

describe('the repo context block reaches the brief (RUN-128)', () => {
  const block = '\n\nThis repo says of itself:\n- Start here: src/daemon.ts';

  it('build carries it, ahead of the brief', () => {
    const p = assemblePrompt(makeRun({ kind: 'build' }), manifest(), {
      agent: testAgent(),
      server: 'https://s',
      repoContext: block,
    });
    expect(p).toContain('This repo says of itself:');
    expect(p).toContain('src/daemon.ts');
    // Orientation before the job: an agent should know the ground rules before it reads the ask.
    expect(p.indexOf('This repo says of itself:')).toBeLessThan(p.indexOf('Brief:'));
  });

  it('scope carries it too — exploration benefits most from orientation', () => {
    const p = assemblePrompt(makeRun({ kind: 'scope' }), manifest(), {
      agent: testAgent(),
      server: 'https://s',
      repoContext: block,
    });
    expect(p).toContain('This repo says of itself:');
    expect(p.indexOf('This repo says of itself:')).toBeLessThan(p.indexOf('Brief:'));
  });

  // A `docs` workflow based on scope: it inherits the base's posture AND (RUN-132) its stage list
  // verbatim — only the prompt is its own.
  const customWf = (promptRef: string) => ({
    ...BUILTIN_WORKFLOWS.scope,
    id: 'docs',
    promptRef,
  });

  // A custom prompt is a template we do not control, so the block cannot be injected into it —
  // the author must place `{{context}}`. Documented in prompts/README.md; asserted here so the
  // limitation stays visible rather than being discovered by a workflow author.
  it('a custom workflow that places {{context}} gets the block', () => {
    const p = assemblePrompt(makeRun({ kind: 'scope', workflow: 'docs' }), manifest(), {
      agent: testAgent(),
      server: 'https://s',
      workflow: customWf('DOCS-MODE: {{brief}}{{context}}'),
      repoContext: block,
    });
    expect(p).toContain('This repo says of itself:');
  });

  it('a custom workflow that omits the tag silently does without it', () => {
    const p = assemblePrompt(makeRun({ kind: 'scope', workflow: 'docs' }), manifest(), {
      agent: testAgent(),
      server: 'https://s',
      workflow: customWf('DOCS-MODE: {{brief}}'),
      repoContext: block,
    });
    expect(p).not.toContain('This repo says of itself');
  });

  // The no-op guarantee: a repo that declares no [context] must get the pre-RUN-128 prompt.
  it('renders byte-identically to before when the repo declared nothing', () => {
    const args = { agent: testAgent(), server: 'https://s' };
    for (const kind of ['scope', 'build'] as const) {
      const withEmpty = assemblePrompt(makeRun({ kind }), manifest(), {
        ...args,
        repoContext: '',
      });
      const without = assemblePrompt(makeRun({ kind }), manifest(), args);
      expect(withEmpty).toBe(without);
      expect(without).not.toContain('This repo says of itself');
    }
  });
});

describe('the build brief states its own definition of done (RUN-127)', () => {
  const build = (over: Partial<ProjectManifest> = {}) =>
    assemblePrompt(makeRun({ kind: 'build' }), manifest(over), {
      agent: testAgent(),
      server: 'https://s',
    });

  it('names the bar as a list, not just "implement the work"', () => {
    const p = build();
    expect(p).toContain('Done means all of these, not just the first:');
    expect(p).toMatch(/no stub, no TODO standing in for the work/);
  });

  // The gate the daemon cannot enforce: a run that silently under-delivers reads as a pass.
  it('makes reporting a gap explicitly cheaper than hiding one', () => {
    expect(build()).toMatch(/Naming a gap costs you nothing here/);
    expect(build()).toMatch(/presenting unfinished work as done/);
  });

  it('names the actual verify command when the repo has one', () => {
    expect(build()).toMatch(/`npm test` passes on what you leave behind/);
  });

  it('degrades honestly when the repo configures no verify floor', () => {
    const p = build({ verify: null });
    expect(p).toContain('the checks this repo already runs still pass');
    expect(p).not.toContain('passes on what you leave behind');
  });

  it('only promises a reviewer when one is configured', () => {
    expect(build()).not.toMatch(/reviewer, reading your diff/); // default manifest: cmd, no agent
    const withReviewer = build({
      verify: {
        cmd: 'npm test',
        timeoutSeconds: null,
        shell: null,
        maxRounds: 2,
        agent: { agent: null, tool: null, model: null, effort: null, maxRounds: 2 },
      },
    });
    expect(withReviewer).toMatch(/the reviewer, reading your diff against that intent/);
  });

  // The bar sits next to the ask, both at the end, where a model attends most.
  it('places the bar after the brief', () => {
    const p = build();
    expect(p.indexOf('Brief:')).toBeLessThan(p.indexOf('Done means'));
  });

  it('is a build-only concern — scope already defines its own success', () => {
    const p = assemblePrompt(makeRun({ kind: 'scope' }), manifest(), {
      agent: testAgent(),
      server: 'https://s',
    });
    expect(p).not.toContain('Done means all of these');
    expect(p).toContain('Success = a proposed plan is emitted');
  });
});

describe('[context] reaches the spawned agent (RUN-128/129)', () => {
  // The harness stubs these seams away by default, so prove the wiring end-to-end at least once:
  // a repo that declares context must have it in the prompt the driver was actually started with.
  const declaring = () =>
    manifest({
      context: {
        requiredReading: ['CLAUDE.md'],
        entryPoints: ['src/daemon.ts'],
        conventions: ['ESM only'],
        agentInstructions: 'inline' as const,
      },
    });

  // The tree the context is read from must be the one the agent stands in. A build forks from the
  // plan base and a continuation adopts its own branch, so the discovered checkout's CLAUDE.md can
  // describe a different tree entirely — and the prompt then tells the agent not to re-read it.
  it('reads the context out of the run’s workspace, not the discovered checkout', async () => {
    const seen: string[] = [];
    const h = harness({
      manifest: declaring(),
      pathProbe: async (abs) => {
        seen.push(abs);
        return true;
      },
      readDoc: async (abs) => {
        seen.push(abs);
        return '# house rules';
      },
    });
    const done = h.supervisor.supervise(makeRun({ kind: 'build' }));
    await flush();
    h.claude.complete('done');
    await done;
    expect(seen.length).toBeGreaterThan(0);
    // Resolved, not spelled: these are `path.resolve` outputs, so on Windows they arrive as
    // `D:\wt\run_1\…` and a literal `/wt/run_1` prefix would fail a passing daemon.
    expect(seen.every((p) => p.startsWith(path.resolve('/wt/run_1')))).toBe(true);
    expect(seen.some((p) => p.startsWith(path.resolve('/repos')))).toBe(false);
  });

  it('inlines the declared reading and the orientation into the build brief', async () => {
    const h = harness({
      manifest: declaring(),
      pathProbe: async () => true,
      readDoc: async () => '# house rules',
    });
    const done = h.supervisor.supervise(makeRun({ kind: 'build' }));
    await flush();
    const prompt = h.claude.opts?.prompt ?? '';
    expect(prompt).toContain('This repo says of itself:');
    expect(prompt).toContain('- Start here: src/daemon.ts');
    expect(prompt).toContain('- Conventions (non-negotiable): ESM only');
    expect(prompt).toContain('----- CLAUDE.md -----');
    expect(prompt).toContain('# house rules');
    // Bulk reference first, the ask last — the shape long-context models attend to best.
    expect(prompt.indexOf('# house rules')).toBeLessThan(prompt.indexOf('Brief:'));
    h.claude.complete('done');
    await done;
  });

  it('drops paths that do not resolve but keeps the conventions — they are words, not files', async () => {
    const h = harness({ manifest: declaring(), pathProbe: async () => 'missing' });
    const done = h.supervisor.supervise(makeRun({ kind: 'build' }));
    await flush();
    const prompt = h.claude.opts?.prompt ?? '';
    expect(prompt).toContain('- Conventions (non-negotiable): ESM only');
    expect(prompt).not.toContain('CLAUDE.md'); // nothing inlined, nothing named
    expect(prompt).not.toContain('Start here');
    h.claude.complete('done');
    await done;
  });

  it('a repo declaring no [context] at all spawns exactly as before', async () => {
    const h = harness({ pathProbe: async () => 'missing' });
    const done = h.supervisor.supervise(makeRun({ kind: 'build' }));
    await flush();
    expect(h.claude.opts?.prompt ?? '').not.toContain('This repo says of itself');
    h.claude.complete('done');
    await done;
  });

  it('honours the budget, truncating rather than crowding out the brief', async () => {
    const h = harness({
      manifest: declaring(),
      pathProbe: async () => true,
      // Honours `limit` like the real reader: the budget bounds the READ, not just the kept slice.
      readDoc: async (_abs, limit) => 'x'.repeat(limit + 1),
      contextBudget: 100,
    });
    const done = h.supervisor.supervise(makeRun({ kind: 'build' }));
    await flush();
    const prompt = h.claude.opts?.prompt ?? '';
    expect(prompt).toContain('(FIRST 100 characters only — the rest was not read)');
    expect(prompt).toContain('Brief:'); // the ask survived
    h.claude.complete('done');
    await done;
  });
});

describe('the phase-gate spawn backstop (RUN-81)', () => {
  const anchored = () => makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } });

  it('declines BEFORE leasing or spawning when the task is not claimable (phase locked)', async () => {
    const h = harness({ claimGate: { claimable: false, reason: 'phase 1 not complete' } });
    const exit = await h.supervisor.supervise(anchored());
    expect(exit.outcome).toBe('failed');
    expect(exit.reason).toMatch(/not claimable yet/);
    expect(exit.reason).toMatch(/phase 1 not complete/); // the server's reason is surfaced
    expect(h.claimChecks).toEqual(['task_9']); // the probe was consulted
    expect(h.worktrees.created).toEqual([]); // nothing leased
    expect(h.agentCreates).toEqual([]); // no identity created
    expect(h.claude.starts).toEqual([]); // no agent spawned — the whole point
    expect(h.reports.some((r) => r.status === 'failed')).toBe(true);
  });

  it('spawns normally when the task IS claimable', async () => {
    const h = harness({ claimGate: { claimable: true, reason: null } });
    const done = h.supervisor.supervise(anchored());
    await flush();
    expect(h.claimChecks).toEqual(['task_9']);
    expect(h.worktrees.created.length).toBe(1); // leased → it ran
    h.claude.complete('done');
    await done;
  });

  it('fails OPEN — a null probe answer (unavailable / transient) never strands a run', async () => {
    const h = harness({ claimGate: null });
    const done = h.supervisor.supervise(anchored());
    await flush();
    expect(h.claimChecks).toEqual(['task_9']); // asked
    expect(h.worktrees.created.length).toBe(1); // but spawned anyway
    h.claude.complete('done');
    await done;
  });

  it('is not consulted for a run with no task anchor (a plan or bare-brief dispatch)', async () => {
    const h = harness({ claimGate: { claimable: false, reason: 'ignored' } });
    const done = h.supervisor.supervise(makeRun({ kind: 'scope' })); // anchor: null
    await flush();
    expect(h.claimChecks).toEqual([]); // nothing to gate on
    expect(h.worktrees.created.length).toBe(1);
    h.claude.complete('done');
    await done;
  });

  it('the pre-RUN-81 daemon (no probe wired) spawns exactly as before', async () => {
    const h = harness(); // no claimGate key → checkClaimable dep omitted
    const done = h.supervisor.supervise(anchored());
    await flush();
    expect(h.claimChecks).toEqual([]);
    expect(h.worktrees.created.length).toBe(1);
    h.claude.complete('done');
    await done;
  });
});

describe('RunSupervisor', () => {
  it('scope: read-only worktree, running→done reports, worktree cleaned up', async () => {
    const h = harness();
    const done = h.supervisor.supervise(makeRun({ kind: 'scope' }));
    await flush();
    expect(h.worktrees.created).toEqual([
      { root: '/repos/repo_a', runId: 'run_1', readOnly: true, baseRef: undefined },
    ]);
    expect(h.reports.find((r) => r.status === 'running')?.worktreePath).toBe('/wt/run_1');
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('done');
    expect(h.reports.at(-1)?.status).toBe('done');
    expect(h.worktrees.removed).toEqual(['/wt/run_1']); // scope worktree removed
  });

  it('build success: read-write worktree KEPT (the review diff)', async () => {
    const h = harness();
    const done = h.supervisor.supervise(makeRun({ kind: 'build', agentTool: 'claude' }));
    await flush();
    expect(h.worktrees.created[0]?.readOnly).toBe(false);
    h.claude.complete('done');
    await done;
    expect(h.worktrees.removed).toEqual([]); // kept for the human to merge
  });

  it('build failure with NOTHING in the tree: worktree cleaned up', async () => {
    // This test used to assert the opposite with work present — a crashed build's worktree
    // removed, harness default changed=true — which is the disposal that destroyed a killed
    // continuation's three sittings of committed work. The startup reaper has always kept
    // work-bearing orphans; settle now agrees with it. Cleanup is for EMPTY trees.
    const h = harness({ changed: false });
    const done = h.supervisor.supervise(makeRun({ kind: 'build' }));
    await flush();
    h.claude.complete('failed');
    const exit = await done;
    expect(exit.outcome).toBe('failed');
    expect(h.worktrees.removed).toEqual(['/wt/run_1']);
  });

  it('declares the kind’s Noriq tool floor when creating the run agent (RUN-47)', async () => {
    // The server advertises exactly this list to the agent over MCP, so the catalogue the
    // model sees and the allowlist the driver enforces are two views of one policy — the
    // supervisor must send the same list security.ts hands the drivers, not its own copy.
    const h = harness();
    const done = h.supervisor.supervise(makeRun({ kind: 'verify', verifiesRunId: 'run_0' }));
    await flush();
    expect(h.agentCreates).toHaveLength(1);
    expect(h.agentCreates[0]?.allowedTools).toEqual(noriqToolNamesFor('verify'));
    // The catalogue-shrinking floor must keep the tools whose absence bites silently.
    expect(h.agentCreates[0]?.allowedTools).toContain('get_briefing');
    expect(h.agentCreates[0]?.allowedTools).toContain('heartbeat');
    expect(h.agentCreates[0]?.allowedTools).not.toContain('claim_task');
    h.claude.complete('done');
    await done;
  });

  it('selects the driver by agentTool', async () => {
    const h = harness();
    const done = h.supervisor.supervise(makeRun({ kind: 'build', agentTool: 'codex' }));
    await flush();
    expect(h.codex.opts?.cwd).toBe('/wt/run_1'); // codex driver started
    expect(h.claude.opts).toBeUndefined();
    h.codex.complete('done');
    await done;
  });

  it('a dispatch AGENT coordinate overrides agentTool + carries model/effort (RUN-114)', async () => {
    // Legacy agentTool says claude, but the coordinate names codex — the coordinate wins.
    const h = harness();
    const done = h.supervisor.supervise(
      makeRun({ kind: 'build', agentTool: 'claude', agent: 'codex.gpt-5_6-sol.high' }),
    );
    await flush();
    expect(h.codex.opts?.cwd).toBe('/wt/run_1'); // the coordinate's driver started
    expect(h.claude.opts).toBeUndefined();
    expect(h.codex.opts?.model).toBe('gpt-5.6-sol'); // unescaped from the coordinate
    expect(h.codex.opts?.effort).toBe('high');
    h.codex.complete('done');
    await done;
  });

  it('a legacy dispatch with no coordinate still resolves identically (RUN-114 back-compat)', async () => {
    const h = harness();
    const done = h.supervisor.supervise(
      makeRun({ kind: 'build', agentTool: 'codex', agent: null, model: 'gpt-5.3-codex', effort: 'low' }),
    );
    await flush();
    expect(h.codex.opts?.cwd).toBe('/wt/run_1');
    expect(h.codex.opts?.model).toBe('gpt-5.3-codex');
    expect(h.codex.opts?.effort).toBe('low');
    h.codex.complete('done');
    await done;
  });

  it('hands a lock enforcer only to a driver with in-process hooks (RUN-110)', async () => {
    // claude declares toolHooks → gets the reactive PreToolUse enforcer (RUN-101)
    const ha = harness();
    const a = ha.supervisor.supervise(makeRun({ kind: 'build', agentTool: 'claude' }));
    await flush();
    expect(ha.claude.opts?.lockEnforcer).toBeDefined();
    ha.claude.complete('done');
    await a;

    // codex has no hooks → no enforcer handed to it; the hard floor (RUN-102) is its only guard
    const hb = harness();
    const b = hb.supervisor.supervise(makeRun({ kind: 'build', agentTool: 'codex' }));
    await flush();
    expect(hb.codex.opts?.lockEnforcer).toBeUndefined();
    hb.codex.complete('done');
    await b;
  });

  it('keys lock enforcement off capabilities, not the driver NAME (RUN-111)', async () => {
    // A driver that calls itself 'claude' but declares no in-process hooks must NOT get an
    // enforcer — the supervisor reads the capability, never the vendor name. This is the guard
    // that keeps the driver map the ONLY place a tool identity matters.
    const claude = new FakeDriver('claude');
    claude.capabilities = { ...claude.capabilities, toolHooks: false };
    const codex = new FakeDriver('codex');
    const h = harness({ drivers: { claude, codex } });
    const done = h.supervisor.supervise(makeRun({ kind: 'build', agentTool: 'claude' }));
    await flush();
    expect(claude.opts?.lockEnforcer).toBeUndefined();
    claude.complete('done');
    await done;
  });

  it('a custom workflow supplies its own prompt but inherits its base posture (RUN-121)', async () => {
    const m = manifest({
      workflows: { docs: { base: 'scope', prompt: 'DOCS-MODE: survey {{brief}} read-only' } },
    });
    const h = harness({ manifest: m });
    const done = h.supervisor.supervise(
      makeRun({ kind: 'scope', workflow: 'docs', brief: 'the auth module' }),
    );
    await flush();
    expect(h.claude.opts?.prompt).toContain('DOCS-MODE: survey the auth module read-only');
    expect(h.claude.opts?.permission.write).toBe(false); // inherited scope posture: read-only
    h.claude.complete('done');
    await done;
  });

  it('a workflow BASE overrides a mismatched dispatched kind — no write escalation (RUN-126)', async () => {
    // The footgun closed daemon-side: dispatch says kind=build (writable) but names a scope-based
    // workflow. The daemon holds the manifest, so the base wins — the run is READ-ONLY regardless.
    const m = manifest({
      workflows: { docs: { base: 'scope', prompt: 'DOCS: survey {{brief}}' } },
    });
    const h = harness({ manifest: m });
    const done = h.supervisor.supervise(makeRun({ kind: 'build', workflow: 'docs' }));
    await flush();
    expect(h.claude.opts?.permission.write).toBe(false); // base=scope posture, not dispatched build
    expect(h.claude.opts?.kind).toBe('scope'); // the driver runs under the effective kind
    expect(h.claude.opts?.prompt).toContain('DOCS: survey'); // custom prompt still applies
    h.claude.complete('done');
    await done;
  });

  it('an unknown workflow name falls back to the built-in for the kind (RUN-121)', async () => {
    const h = harness();
    const done = h.supervisor.supervise(makeRun({ kind: 'scope', workflow: 'nonexistent' }));
    await flush();
    // no throw, and the scope built-in prompt is used
    expect(h.claude.opts?.prompt).toContain('MODE: SCOPE');
    h.claude.complete('done');
    await done;
  });

  it('a verify run stays read-only even if the manifest grants write (RUN-118 floor)', async () => {
    // The workflow-independent floor: a non-producing workflow can never be handed write, no matter
    // what [permissions.verify] says — "verify executes but never edits" is not a manifest's to undo.
    const m = manifest({
      permissions: { scope: perm(false), build: perm(true), verify: perm(true) },
    });
    const h = harness({ manifest: m });
    const done = h.supervisor.supervise(makeRun({ kind: 'verify' }));
    await flush();
    expect(h.claude.opts?.permission.write).toBe(false); // clamped, despite verify: perm(true)
    h.claude.complete('done');
    await done;
  });

  it('build done + verify passes → done (floor gate cleared)', async () => {
    const h = harness({ verifyPasses: true });
    const done = h.supervisor.supervise(
      makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } }),
    );
    await flush();
    h.claude.complete('done');
    const exit = await done;
    expect(h.verifyRan()).toBe(true);
    expect(exit.outcome).toBe('done');
    expect(h.comments).toEqual([]);
    expect(h.worktrees.removed).toEqual([]); // kept
  });

  it('build done + verify FAILS → gated to failed{verify}, comment posted, worktree kept', async () => {
    const h = harness({ verifyPasses: false });
    const done = h.supervisor.supervise(
      makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } }),
    );
    await flush();
    h.claude.complete('done'); // driver succeeded…
    const exit = await done;
    expect(exit).toMatchObject({ outcome: 'failed', reason: 'verify' }); // …but the floor gate blocks done
    expect(h.reports.at(-1)?.status).toBe('failed');
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]).toMatchObject({ projectId: 'prj_p', taskId: 'task_9' });
    expect(h.comments[0]?.body).toContain('TS2322');
    expect(h.worktrees.removed).toEqual([]); // driver succeeded → diff kept for a human to fix
  });

  it('scope run does not trigger verify', async () => {
    const h = harness({ verifyPasses: false });
    const done = h.supervisor.supervise(makeRun({ kind: 'scope' }));
    await flush();
    h.claude.complete('done');
    await done;
    expect(h.verifyRan()).toBe(false); // verify is the BUILD floor gate only
  });

  it('verify run: PASS verdict → done, worktree cleaned up (RUN-20)', async () => {
    const h = harness();
    const done = h.supervisor.supervise(
      makeRun({ kind: 'verify', anchor: { type: 'task', taskId: 'task_9' } }),
    );
    await flush();
    // Writable on purpose (was read-only): the verifier is told to run the suite, which
    // needs node_modules and test temp files. It still cannot EDIT — that is enforced by
    // the profile (no Edit/Write tools), not by chmod. See "worktree writability by kind".
    expect(h.worktrees.created[0]?.readOnly).toBe(false);
    h.claude.emitText('inspected the diff; specs met.\nVERDICT: PASS');
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('done');
    expect(h.comments).toEqual([]);
    expect(h.worktrees.removed).toEqual(['/wt/run_1']); // verify worktree cleaned up
  });

  it('verify run: FAIL verdict → gated to failed{verify_agent} + findings comment (RUN-20)', async () => {
    const h = harness();
    const done = h.supervisor.supervise(
      makeRun({ kind: 'verify', anchor: { type: 'task', taskId: 'task_9' } }),
    );
    await flush();
    h.claude.emitText('the test for the 401 case was deleted.\nVERDICT: FAIL');
    h.claude.complete('done'); // driver finished…
    const exit = await done;
    expect(exit).toMatchObject({ outcome: 'failed', reason: 'verify_agent' }); // …but the verdict gates it
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]?.body).toContain('was deleted');
  });

  it('verify run: no verdict → treated as FAIL (RUN-20)', async () => {
    const h = harness();
    const done = h.supervisor.supervise(
      makeRun({ kind: 'verify', anchor: { type: 'task', taskId: 'task_9' } }),
    );
    await flush();
    h.claude.emitText('i looked around a bit'); // never emits a VERDICT line
    h.claude.complete('done');
    const exit = await done;
    expect(exit).toMatchObject({ outcome: 'failed', reason: 'verify_agent' });
  });

  it('streams live telemetry ticks with spend + a capped log tail (RUN-22)', async () => {
    const h = harness();
    const done = h.supervisor.supervise(makeRun({ kind: 'build' }));
    await flush();
    h.claude.emitText('compiling module A...\n');
    h.claude.emitTelemetry({ outputTokens: 1200, costUsd: 0.34 });
    const tick = h.reports.find((r) => r.telemetry && r.status === 'running');
    expect(tick?.telemetry?.outputTokens).toBe(1200);
    expect(tick?.telemetry?.costUsd).toBeCloseTo(0.34);
    expect(tick?.logTail).toContain('compiling module A');

    // The tail is bounded — a torrent of output never sends an unbounded payload.
    h.claude.emitText('x'.repeat(9000));
    h.claude.emitTelemetry({ outputTokens: 2000, costUsd: 0.5 });
    const big = h.reports.filter((r) => r.telemetry).at(-1);
    expect(big?.logTail?.length).toBeLessThanOrEqual(4000);

    h.claude.complete('done');
    await done;
    expect(h.reports.at(-1)?.logTail).toBeDefined(); // terminal report carries the final tail too
  });

  it('fails cleanly when the repo cannot be resolved (no worktree)', async () => {
    const h = harness({ hasRepo: false });
    const exit = await h.supervisor.supervise(makeRun());
    expect(exit).toMatchObject({ outcome: 'failed' });
    expect(exit.reason).toMatch(/repo not found/);
    expect(h.worktrees.created).toEqual([]);
    expect(h.reports.at(-1)?.status).toBe('failed');
  });

  it('fails cleanly when no driver is installed for the tool', async () => {
    const h = harness({ drivers: {} });
    const exit = await h.supervisor.supervise(makeRun({ agentTool: 'codex' }));
    expect(exit.reason).toMatch(/no driver for tool codex/);
  });
});

describe('assemblePrompt inlines the anchor task', () => {
  const run = makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_mrl4r9' } });
  const ctx = { agent: testAgent(), server: 'https://s' };

  it('gives the agent the actual job, not an opaque id', () => {
    // The first real dispatch handed the agent only `task_mrl4r9kd…` and it correctly
    // reported there was "nothing to implement".
    const p = assemblePrompt(run, manifest(), {
      ...ctx,
      task: { key: 'ACME-140', title: 'Event feed invert', body: 'Newest events belong at the bottom.' },
    });
    expect(p).toContain('ACME-140');
    expect(p).toContain('Event feed invert');
    expect(p).toContain('Newest events belong at the bottom.');
    expect(p).toContain('task_mrl4r9'); // the id still travels, for claim/release
  });

  it('handles a task with no body', () => {
    const p = assemblePrompt(run, manifest(), {
      ...ctx,
      task: { key: 'ACME-140', title: 'Event feed invert', body: null },
    });
    expect(p).toContain('Event feed invert');
  });

  it('degrades to the bare id when the lookup came back empty', () => {
    // Best-effort: a get_task failure must not sink the run — the agent can still
    // fetch it itself now that it has MCP access.
    const p = assemblePrompt(run, manifest(), { ...ctx, task: null });
    expect(p).toContain('Approved task: task_mrl4r9');
  });
});

// RUN-139. The spec reaches the actor that WRITES in full, and the actor that JUDGES as the
// definition of done alone. Both were wrong in the first cut: the reviewer got nothing.
//
// RUN-145 changed the FORM the judge's half arrives in — numbered criteria it answers one by one,
// not a prose block — so what these assert is that the author's notes still never reach a gate and
// the criteria still never reach the author's block twice.
describe('assemblePrompt places the execution spec', () => {
  const ctx = { agent: testAgent(), server: 'https://s' };
  const SPEC = '\n\nEXECUTION SPEC — full, for the author';
  const ACCEPT = [{ id: 1, kind: 'truth' as const, text: 'the daemon reaps orphans on start' }];

  it('gives a build agent the whole spec, after the brief it explains', () => {
    const p = assemblePrompt(makeRun({ kind: 'build' }), manifest(), {
      ...ctx,
      executionSpec: SPEC,
      acceptance: ACCEPT,
    });
    expect(p).toContain(SPEC.trim());
    expect(p).not.toContain(ACCEPT[0]!.text);
    // After the brief, not before: the spec is the ask's own detail, where `[context]` is
    // reference read ahead of the ask.
    expect(p.indexOf('Brief:')).toBeLessThan(p.indexOf('EXECUTION SPEC'));
  });

  it('gives a scope agent the whole spec too — it is an author, not a gate', () => {
    const p = assemblePrompt(makeRun({ kind: 'scope' }), manifest(), { ...ctx, executionSpec: SPEC });
    expect(p).toContain(SPEC.trim());
  });

  it('gives the verify actor the acceptance criteria and NOT the author’s working notes', () => {
    const p = assemblePrompt(makeRun({ kind: 'verify' }), manifest(), {
      ...ctx,
      executionSpec: SPEC,
      acceptance: ACCEPT,
    });
    expect(p).toContain(ACCEPT[0]!.text);
    expect(p).not.toContain(SPEC.trim());
    // …once. Shown the same criteria twice — as a list and again as prose — a model answers the
    // prose and skips the list, which is the whole reason the second rendering was deleted.
    expect(p.split(ACCEPT[0]!.text)).toHaveLength(2);
    // And it is told HOW to answer, or the numbers buy nothing.
    expect(p).toMatch(/ACCEPTANCE <n>:/);
  });

  it('renders nothing anywhere for a task with no spec', () => {
    for (const kind of ['scope', 'build', 'verify'] as const) {
      const p = assemblePrompt(makeRun({ kind }), manifest(), ctx);
      expect(p, kind).not.toContain('EXECUTION SPEC');
      expect(p, kind).not.toContain('COMMISSIONED TO ACHIEVE');
    }
  });
});

describe('mergeBudget', () => {
  const machine: RunBudget = { maxTokens: 500_000, maxUsd: 5, maxDurationSeconds: 1800, maxRounds: null };
  const empty: RunBudget = { maxTokens: null, maxUsd: null, maxDurationSeconds: null, maxRounds: null };

  it('falls back to the machine ceilings when the Run carries none', () => {
    // The dashboard dispatch form leaves these blank by default — without the
    // fallback such a Run would execute with no ceiling at all.
    expect(mergeBudget(empty, machine)).toEqual(machine);
    expect(mergeBudget(null, machine)).toEqual(machine);
  });

  it('lets the Run win per-dimension, not whole-object', () => {
    // Setting only maxUsd must NOT silently drop the machine's token/time ceilings.
    expect(
      mergeBudget({ maxTokens: null, maxUsd: 1, maxDurationSeconds: null, maxRounds: null }, machine),
    ).toEqual({
      maxTokens: 500_000,
      maxUsd: 1,
      maxDurationSeconds: 1800,
      maxRounds: null,
    });
  });

  it('honours an explicit Run budget above the machine default (default, not clamp)', () => {
    expect(
      mergeBudget({ maxTokens: null, maxUsd: 50, maxDurationSeconds: null, maxRounds: null }, machine)
        ?.maxUsd,
    ).toBe(50);
  });

  it('stays unbounded only when nothing is configured anywhere', () => {
    expect(mergeBudget(null, null)).toBeNull();
    expect(mergeBudget(empty, null)).toEqual(empty);
  });
});

describe('RunSupervisor budget defaults', () => {
  it('runs a budget-less dispatch under the machine ceilings from runner.toml', async () => {
    const { supervisor, claude } = harness({
      defaultBudget: { maxTokens: 500_000, maxUsd: 5, maxDurationSeconds: 1800, maxRounds: null },
    });
    const run = supervisor.supervise(makeRun({ kind: 'scope' }));
    await flush();
    claude.complete('done');
    await run;

    // The whole point: an unbudgeted dispatch must not reach the driver unbounded.
    expect(claude.opts?.budget).toEqual({
      maxTokens: 500_000,
      maxUsd: 5,
      maxDurationSeconds: 1800,
      maxRounds: null,
    });
  });

  it('still lets an explicit Run budget take precedence', async () => {
    const { supervisor, claude } = harness({
      defaultBudget: { maxTokens: 500_000, maxUsd: 5, maxDurationSeconds: 1800, maxRounds: null },
    });
    const run = supervisor.supervise(
      makeRun({
        kind: 'scope',
        budget: { maxTokens: null, maxUsd: 1, maxDurationSeconds: null, maxRounds: null },
      }),
    );
    await flush();
    claude.complete('done');
    await run;

    expect(claude.opts?.budget).toMatchObject({ maxUsd: 1, maxTokens: 500_000 });
  });
});

describe('a build that changes nothing is not a success', () => {
  it('fails as no_changes and never runs verify', async () => {
    // What happened on the first real dispatch: the agent was blocked, bailed cleanly,
    // and left the worktree pristine. Verifying that re-tests untouched HEAD for ~a
    // minute to answer a question nobody asked.
    const h = harness({ changed: false });
    const done = h.supervisor.supervise(makeRun({ kind: 'build' }));
    await flush();
    h.claude.complete('done');
    const exit = await done;

    expect(exit.outcome).toBe('failed');
    expect(exit.reason).toBe('no_changes');
    expect(h.verifyRan()).toBe(false); // the whole point — no wasted suite run
  });

  it('cleans up the empty worktree rather than keeping it for review', async () => {
    const h = harness({ changed: false });
    const done = h.supervisor.supervise(makeRun({ kind: 'build' }));
    await flush();
    h.claude.complete('done');
    await done;
    // Nothing to review — don't leave a branch behind pretending there is.
    expect(h.worktrees.removed).toEqual(['/wt/run_1']);
  });

  it('reports a terminal status so the dashboard cannot strand the Run', async () => {
    const h = harness({ changed: false });
    const done = h.supervisor.supervise(makeRun({ kind: 'build' }));
    await flush();
    h.claude.complete('done');
    await done;
    expect(h.reports.at(-1)).toMatchObject({ status: 'failed', exit: { reason: 'no_changes' } });
  });

  // RUN-152. Declaring `no_changes` REAPS the worktree, so guessing "empty" on a probe that merely
  // errored destroys the diff. Guessing "full" at worst spends a verify run on a tree a human can
  // still open. The gate always intended this default; the swallowed error is what stopped it.
  it('does not call it a no-op when the probe could not answer', async () => {
    const blind = new FakeWorktrees();
    blind.hasWorkError = 'fatal: bad object base0000';
    const h = harness({ repoVcs: blind });
    const done = h.supervisor.supervise(makeRun({ kind: 'build' }));
    await flush();
    h.claude.complete('done');
    const exit = await done;

    expect(exit.reason).not.toBe('no_changes');
    expect(h.verifyRan()).toBe(true); // let the gate decide on the real tree
    expect(blind.removed).toEqual([]); // and never reap on a guess
  });

  it('still verifies a build that DID change something', async () => {
    const h = harness({ changed: true });
    const done = h.supervisor.supervise(makeRun({ kind: 'build' }));
    await flush();
    h.claude.complete('done');
    const exit = await done;

    expect(h.verifyRan()).toBe(true);
    expect(exit.outcome).toBe('done');
  });

  it('does not gate scope runs on a diff (they produce plans, not code)', async () => {
    const h = harness({ changed: false });
    const done = h.supervisor.supervise(makeRun({ kind: 'scope' }));
    await flush();
    h.claude.complete('done');
    const exit = await done;

    // A scope run's artifact is a proposed plan — an empty worktree is CORRECT.
    expect(exit.outcome).toBe('done');
    expect(h.worktrees.hasChangesCalls).toBe(0);
  });
});

describe("the run's diff is made durable", () => {
  it('commits the worktree onto the throwaway branch, labelled with the task', async () => {
    // The agent may have no git allowlist (or may simply not bother). Loose files are
    // destroyed by the next `worktree remove --force` — including the reap on the
    // daemon's next start — so the daemon commits rather than trusting the agent.
    const h = harness();
    const done = h.supervisor.supervise(
      makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } }),
    );
    await flush();
    h.claude.complete('done');
    await done;

    expect(h.worktrees.commits).toEqual([
      { path: '/wt/run_1', message: expect.stringContaining('noriq run run_1') },
    ]);
    // Subject line first, attribution in the body (RUN-96): one-line history must show WHAT
    // changed (task key + title), never a wall of identical run ids.
    const [subject, blank, attribution] = h.worktrees.commits[0]!.message.split('\n');
    expect(subject).toBe('ship the thing'); // the run's brief — what a human scans for
    expect(blank).toBe('');
    expect(attribution).toBe('noriq run run_1');
  });

  it('commits BEFORE verify, so a gated build still leaves a reviewable diff', async () => {
    const h = harness({ verifyPasses: false });
    const done = h.supervisor.supervise(makeRun({ kind: 'build' }));
    await flush();
    h.claude.complete('done');
    const exit = await done;

    expect(exit.reason).toBe('verify');
    expect(h.worktrees.commits).toHaveLength(1); // the work survives the gate
    expect(h.worktrees.removed).toEqual([]); // and the worktree is kept for the human
  });

  it('does not commit a scope run (its artifact is a plan, not a diff)', async () => {
    const h = harness();
    const done = h.supervisor.supervise(makeRun({ kind: 'scope' }));
    await flush();
    h.claude.complete('done');
    await done;
    expect(h.worktrees.commits).toEqual([]);
  });

  it('does not commit a build whose agent failed', async () => {
    const h = harness();
    const done = h.supervisor.supervise(makeRun({ kind: 'build' }));
    await flush();
    h.claude.complete('failed');
    await done;
    expect(h.worktrees.commits).toEqual([]);
  });
});

describe('the hard lock floor (RUN-102)', () => {
  const buildRun = () => makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } });

  it('acquires locks over the build’s changed paths, as the run holder, before landing', async () => {
    const h = harness({ manifest: LANDING(), changedFiles: ['src/a.ts', 'src/b.ts'] });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    expect((await done).outcome).toBe('done');
    // The floor ran on exactly the changed set, scoped to the landing branch, as the run agent.
    const floor = h.worktrees.lockCalls.find((c) => c.paths.includes('src/a.ts'));
    expect(floor?.paths).toEqual(['src/a.ts', 'src/b.ts']);
    expect(floor?.ctx.branch).toBe('noriq/integration'); // the [land] target, not noriq/run/*
    expect(floor?.ctx.token).toBe('plnrt_bound_to_agt_run1'); // held as the run's agent, not the daemon
    expect(h.worktrees.landings).toHaveLength(1); // clean acquire → it landed
  });

  it('GATES a build that changed a path a peer holds — kept for review, never landed', async () => {
    const h = harness({
      manifest: LANDING(),
      changedFiles: ['src/shared.ts'],
      lockConflicts: [{ path: 'src/shared.ts', holder: 'agt_peer', holderName: 'peer', taskKey: 'RUN-2' }],
    });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    const exit = await done;

    expect(exit.outcome).toBe('failed');
    expect(exit.reason).toBe('lock'); // gated by the floor, not verify
    expect(h.worktrees.commits).toHaveLength(1); // the diff IS committed first…
    expect(h.worktrees.landings).toEqual([]); // …but never lands over the peer
    expect(h.worktrees.removed).toEqual([]); // and the worktree is kept for a human
    expect(h.comments.some((c) => c.body.includes('src/shared.ts') && c.body.includes('peer'))).toBe(true);
  });

  // RUN-156. An empty changed set means "nothing to lock", which the floor reads as a PASS — so a
  // failure to ENUMERATE arrived as a floor that silently did not run. For a driver with no
  // in-process hook this is the run's ONLY acquisition, so the build would land over whatever a
  // peer holds with nothing anywhere saying the check was skipped.
  it('GATES when it cannot tell what the build changed — a floor that locked nothing is not a pass', async () => {
    const blind = new FakeWorktrees();
    blind.changedPathsError = 'fatal: not a git repository';
    const h = harness({ manifest: LANDING(), repoVcs: blind });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    const exit = await done;

    expect(exit.outcome).toBe('failed');
    expect(exit.reason).toBe('lock:unchecked'); // distinct from a real conflict — it IS different
    expect(blind.lockCalls).toEqual([]); // nothing was locked, which is the whole problem
    expect(blind.landings).toEqual([]); // …so it must not land
    expect(blind.commits).toHaveLength(1); // the diff is committed first — gating costs a re-dispatch
    expect(blind.removed).toEqual([]); // …and the worktree is kept for a human
    expect(h.comments.some((c) => c.body.includes('could not check this run'))).toBe(true);
  });

  // The other route to the same hole, and the one my first fix left open: a lock service that does
  // not answer used to become `{ ok: true }`. The justification was that the reactive hook and the
  // dispatch-time check still stood — false for a Codex build on a first sitting, which has
  // neither, so that call IS the only acquisition.
  it('GATES when the lock service does not answer — not just when git does not', async () => {
    const blind = new FakeWorktrees();
    blind.changedFiles = ['src/a.ts'];
    blind.lockError = 'ECONNREFUSED';
    const h = harness({ manifest: LANDING(), repoVcs: blind });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    const exit = await done;

    expect(exit.reason).toBe('lock:unchecked');
    expect(blind.landings).toEqual([]);
    expect(blind.removed).toEqual([]); // kept, and continuable — the cost is a re-dispatch
  });

  // A project with locking genuinely OFF is a service answering, not one failing.
  it('a locking-disabled project still passes the floor', async () => {
    const off = new FakeWorktrees();
    off.changedFiles = ['src/a.ts'];
    off.lockingDisabled = true;
    const h = harness({ manifest: LANDING(), repoVcs: off });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    expect((await done).outcome).toBe('done');
    expect(off.landings).toHaveLength(1);
  });

  it('no changed paths → the floor is a no-op (nothing acquired)', async () => {
    const h = harness({ manifest: LANDING(), changedFiles: [] });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await done;
    expect(h.worktrees.lockCalls).toEqual([]); // never touched the lock layer
    expect(h.worktrees.landings).toHaveLength(1);
  });

  it('surfaces a lock gate in the run transcript, for the run view (RUN-106)', async () => {
    const h = harness({
      manifest: LANDING(),
      changedFiles: ['src/shared.ts'],
      lockConflicts: [{ path: 'src/shared.ts', holder: 'agt_peer', holderName: 'peer' }],
    });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await done;
    const text = h.transcript.map((s) => s.text).join('\n');
    expect(text).toMatch(/🔒 hard lock floor gated this build.*src\/shared\.ts.*peer/s);
  });
});

describe('dispatch-time predictive locking (RUN-103)', () => {
  const buildRun = () => makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } });

  it('takes the declared scope before the agent starts, then runs', async () => {
    const h = harness({ manifest: LANDING(), lockScope: ['src/x.ts'] });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    expect((await done).outcome).toBe('done');
    // The FIRST acquire is the predictive one, on the declared scope, before any driver output.
    expect(h.worktrees.lockCalls[0]?.paths).toEqual(['src/x.ts']);
    expect(h.claude.starts).toHaveLength(1); // the agent still ran
  });

  it('REFUSES a dispatch whose declared scope clashes — no agent spawned, worktree disposed', async () => {
    const h = harness({
      manifest: LANDING(),
      lockScope: ['src/hot.ts'],
      lockConflicts: [{ path: 'src/hot.ts', holder: 'agt_peer', holderName: 'peer' }],
      // Disposal is now conditional on the workspace being EMPTY (RUN-130): this scenario is a
      // fresh lease, so it still disposes. The case where it must NOT is covered two tests down.
      changed: false,
    });
    const exit = await h.supervisor.supervise(buildRun());
    expect(exit.outcome).toBe('failed');
    expect(exit.reason).toMatch(/locked by another run/);
    expect(h.claude.starts).toHaveLength(0); // never spawned — refused, not raced
    expect(h.worktrees.removed).toEqual(['/wt/run_1']); // the just-leased worktree is disposed
    expect(h.comments.some((c) => c.body.includes('src/hot.ts'))).toBe(true);
  });

  // RUN-130's sharp edge. A CONTINUATION adopts its kept worktree and branch (RUN-91) — and a
  // continuation is exactly what declares a scope, so this refusal fires precisely where the
  // workspace holds the prior sitting's committed diff. Disposing it force-removes the worktree
  // and -D's a never-pushed branch: work that exists nowhere else, destroyed by a lock conflict.
  it('KEEPS a workspace that holds work when the scope clashes — never force-deletes a continuation', async () => {
    const h = harness({
      manifest: LANDING(),
      lockScope: ['src/hot.ts'],
      lockConflicts: [{ path: 'src/hot.ts', holder: 'agt_peer', holderName: 'peer' }],
    });
    const exit = await h.supervisor.supervise(buildRun()); // `changed` defaults true → holds work
    expect(exit.outcome).toBe('failed');
    expect(h.claude.starts).toHaveLength(0); // still refused, not raced
    expect(h.worktrees.removed).toEqual([]); // …but the work survives the refusal
  });

  // Only GIT's dispose destroys. A live backend's dispose RETURNS THE LEASE, so skipping it there
  // preserves nothing and wedges every later run on the repo until the daemon restarts.
  it('still disposes on a clash when the backend preserves work — dispose is the lease release', async () => {
    const pooled = new FakeWorktrees();
    // `repoVcs` wins over deps.vcs (RUN-60), so the conflict has to be armed on THIS instance.
    (pooled as { disposePreservesWork?: boolean }).disposePreservesWork = true;
    pooled.lockConflicts = [{ path: 'src/hot.ts', holder: 'agt_peer', holderName: 'peer' }];
    const h = harness({ manifest: LANDING(), lockScope: ['src/hot.ts'], repoVcs: pooled });
    await h.supervisor.supervise(buildRun()); // holds work, but disposal is non-destructive here
    expect(pooled.removed).toEqual(['/wt/run_1']);
  });

  // RUN-152. The guard here always read "could not tell" as work — but `hasWork` used to answer
  // `false` on a failed probe, so the guard never saw the error and disposed anyway. A transient
  // git failure on a continuation was therefore enough to force-remove a diff that exists nowhere
  // else. The backend rejects now; this pins that the refusal path keeps the workspace.
  it('KEEPS the workspace when it cannot TELL whether there is work', async () => {
    const blind = new FakeWorktrees();
    blind.hasWorkError = 'fatal: bad object base0000';
    blind.lockConflicts = [{ path: 'src/hot.ts', holder: 'agt_peer', holderName: 'peer' }];
    const h = harness({ manifest: LANDING(), lockScope: ['src/hot.ts'], repoVcs: blind });
    const exit = await h.supervisor.supervise(buildRun());
    expect(exit.outcome).toBe('failed');
    expect(exit.reason).toMatch(/locked by another run/); // still refused
    expect(blind.removed).toEqual([]); // …but nothing was destroyed on a guess
  });

  it('still disposes an EMPTY workspace on a clash — nothing to lose, nothing to leak', async () => {
    const h = harness({
      manifest: LANDING(),
      lockScope: ['src/hot.ts'],
      lockConflicts: [{ path: 'src/hot.ts', holder: 'agt_peer', holderName: 'peer' }],
      changed: false, // a fresh lease with nothing in it
    });
    await h.supervisor.supervise(buildRun());
    expect(h.worktrees.removed).toEqual(['/wt/run_1']);
  });

  it('no resolver wired → predictive layer is silent (the common case today)', async () => {
    const h = harness({ manifest: LANDING() }); // lockScope absent
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    expect((await done).outcome).toBe('done');
    expect(h.claude.starts).toHaveLength(1);
  });
});

describe('lock release on terminal (RUN-104)', () => {
  it('releases the run’s locks as its holder on EVERY terminal path (kept-work build included)', async () => {
    // A build that changed something but did not land is KEPT (worktree not disposed) — its locks
    // must still release so a peer unblocks. The release fires regardless of retention.
    const h = harness({ verifyPasses: false }); // gated → kept, not landed
    const done = h.supervisor.supervise(
      makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } }),
    );
    await flush();
    h.claude.complete('done');
    await done;
    expect(h.worktrees.removed).toEqual([]); // kept for the human…
    expect(h.worktrees.releasedAll).toEqual(['plnrt_bound_to_agt_run1']); // …but locks released
  });

  it('releases on a clean landed build too', async () => {
    const h = harness({ manifest: LANDING() });
    const done = h.supervisor.supervise(
      makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } }),
    );
    await flush();
    h.claude.complete('done');
    expect((await done).outcome).toBe('done');
    expect(h.worktrees.releasedAll).toEqual(['plnrt_bound_to_agt_run1']);
  });

  it('HOLDS locks through the merge and releases AFTER landing, never before (RUN-105)', async () => {
    // Two runs land onto one integration branch serially; the first must keep its locks until its
    // work is actually on the branch, or the second could grab a file mid-landing and race it.
    const h = harness({ manifest: LANDING() });
    const done = h.supervisor.supervise(
      makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } }),
    );
    await flush();
    h.claude.complete('done');
    await done;
    expect(h.worktrees.timeline).toEqual(['land', 'release', 'report']); // land first, THEN release
  });

  it('releases BEFORE the terminal report, which is what revokes the token it releases with (RUN-177)', async () => {
    // Reporting a terminal status makes the server retire the run's agent. The release
    // authenticates AS that agent, so below the report it is a 401 by construction — which is
    // exactly what the first live dispatch logged. Harmless only while the floor was failing
    // before it acquired anything; a real leak the moment that was fixed.
    const h = harness({ manifest: LANDING() });
    const done = h.supervisor.supervise(
      makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } }),
    );
    await flush();
    h.claude.complete('done');
    await done;
    const release = h.worktrees.timeline.indexOf('release');
    const report = h.worktrees.timeline.indexOf('report');
    expect(release).toBeGreaterThanOrEqual(0);
    expect(report).toBeGreaterThan(release);
  });

  it('settles anyway when the lock service accepts the release and never answers (RUN-177)', async () => {
    // The regression the isolated `withTimeout` tests cannot catch: settle awaiting the release
    // DIRECTLY. A hung lock service would then leave this run non-terminal server-side, its agent
    // un-retired, its continuation unrecorded and its runner slot held for the daemon's whole life.
    vi.useFakeTimers();
    try {
      const h = harness({ hangRelease: true });
      const done = h.supervisor.supervise(
        makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } }),
      );
      await vi.advanceTimersByTimeAsync(0); // stands in for flush() under fake timers
      h.claude.complete('done');
      // Reach settle, then walk past the bound. Without it this await never returns.
      await vi.advanceTimersByTimeAsync(LOCK_RELEASE_TIMEOUT_MS + 1);
      await done;

      // The terminal report went out despite the release never answering — only the TERMINAL one
      // carries `exit`, so this is not satisfied by the earlier `running` reports.
      expect(h.reports.at(-1)?.exit).toBeDefined();
      expect(h.worktrees.timeline).toContain('report');
      expect(h.worktrees.timeline).not.toContain('release'); // it never answered, so it never recorded
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases before the terminal report on a GATED build too, not just a landed one', async () => {
    // The kept-work path reports `failed` and skips dispose — the release still has to beat the
    // report there, and that is the path the live runs actually took.
    const h = harness({ verifyPasses: false });
    const done = h.supervisor.supervise(
      makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } }),
    );
    await flush();
    h.claude.complete('done');
    await done;
    expect(h.worktrees.timeline).toEqual(['release', 'report']);
  });

  it('a run in one worktree is gated by a lock a run in ANOTHER worktree holds (RUN-105)', async () => {
    // Locks live server-side, so two runs on the same repo (each in its own worktree) see each
    // other's holds — the peer conflict here IS another worktree's run. The hard floor gates the
    // second rather than letting it clobber the first's file.
    const h = harness({
      manifest: LANDING(),
      changedFiles: ['src/shared.ts'],
      lockConflicts: [{ path: 'src/shared.ts', holder: 'agt_worktree_b', holderName: 'run in worktree B' }],
    });
    const done = h.supervisor.supervise(
      makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } }),
    );
    await flush();
    h.claude.complete('done');
    expect((await done).reason).toBe('lock');
    expect(h.worktrees.landings).toEqual([]); // the two never land over each other
  });
});

describe('worktree writability by kind', () => {
  it('gives VERIFY a writable checkout so it can actually run the suite', async () => {
    // Its prompt says "exercise the behavior — don't just re-run the tests". A chmod'd
    // read-only tree makes that impossible (no node_modules, no test temp files).
    const h = harness();
    const done = h.supervisor.supervise(makeRun({ kind: 'verify' }));
    await flush();
    expect(h.worktrees.created[0]?.readOnly).toBe(false);
    h.claude.emitText('VERDICT: PASS');
    h.claude.complete('done');
    await done;
  });

  it('keeps SCOPE physically read-only (defense in depth)', async () => {
    const h = harness();
    const done = h.supervisor.supervise(makeRun({ kind: 'scope' }));
    await flush();
    expect(h.worktrees.created[0]?.readOnly).toBe(true);
    h.claude.complete('done');
    await done;
  });
});

describe('a verify run can actually SEE the diff it judges', () => {
  const verifyRun = (over: Partial<Run> = {}) =>
    makeRun({
      kind: 'verify',
      anchor: { type: 'task', taskId: 'task_9' },
      verifiesRunId: 'run_build7',
      ...over,
    });

  it("branches the verifier's worktree from the build's branch, not HEAD", async () => {
    // The bug: every worktree came from HEAD, so `git diff` was empty and the verdict
    // was about unchanged code.
    const h = harness();
    const done = h.supervisor.supervise(verifyRun());
    await flush();
    expect(h.worktrees.created[0]?.fromRunId).toBe('run_build7'); // the RUN, not its branch (RUN-50)
    h.claude.emitText('VERDICT: PASS');
    h.claude.complete('done');
    await done;
  });

  it('points the prompt at the range under review, not a bare `git diff`', async () => {
    // Branching from the build is not enough: that checkout is CLEAN, so a plain
    // `git diff` still shows nothing. Three-dot = everything since the fork point.
    const h = harness({ manifest: manifest({ defaultBranch: 'main' }) });
    const done = h.supervisor.supervise(verifyRun());
    await flush();
    expect(h.claude.opts?.prompt).toContain('git diff main...HEAD');
    h.claude.emitText('VERDICT: PASS');
    h.claude.complete('done');
    await done;
  });

  it('falls back to the fork-point sha when the repo declares no default branch', async () => {
    const h = harness({ manifest: manifest({ defaultBranch: null }) });
    const done = h.supervisor.supervise(verifyRun());
    await flush();
    expect(h.claude.opts?.prompt).toContain('git diff base0000...HEAD');
    h.claude.emitText('VERDICT: PASS');
    h.claude.complete('done');
    await done;
  });

  it('fails loudly when the build branch is gone rather than PASS an empty diff', async () => {
    // Silently falling back to HEAD would hand back a confident PASS on nothing —
    // worse than having no gate at all.
    const h = harness({ createFails: true });
    const exit = await h.supervisor.supervise(verifyRun());
    expect(exit.outcome).toBe('failed');
    expect(exit.reason).toContain('run_build7');
    // Names the RUN whose work is missing, not its branch: since RUN-50 the supervisor does
    // not know the branch convention exists — the old assertion here was pinning the leak.
    expect(exit.reason).toContain('its work is not in this repo');
  });

  it('leaves scope/build runs branching from HEAD', async () => {
    const h = harness();
    const done = h.supervisor.supervise(makeRun({ kind: 'build' }));
    await flush();
    expect(h.worktrees.created[0]?.fromRunId).toBeUndefined();
    h.claude.complete('done');
    await done;
  });

  it('ignores verifiesRunId on a non-verify run', async () => {
    const h = harness();
    const done = h.supervisor.supervise(makeRun({ kind: 'build', verifiesRunId: 'run_build7' }));
    await flush();
    expect(h.worktrees.created[0]?.fromRunId).toBeUndefined();
    h.claude.complete('done');
    await done;
  });

  it('still works for an unanchored verify run (plain git diff)', async () => {
    const h = harness();
    const done = h.supervisor.supervise(makeRun({ kind: 'verify', verifiesRunId: null }));
    await flush();
    expect(h.worktrees.created[0]?.fromRunId).toBeUndefined();
    h.claude.emitText('VERDICT: PASS');
    h.claude.complete('done');
    await done;
  });
});

const LANDING = (over: Partial<ProjectManifest['land']> = {}) =>
  manifest({
    defaultBranch: 'main',
    // autoPush defaults FALSE — the fixture says so explicitly, because a landing fixture that
    // silently pushed would be exactly the accident RUN-27 exists to prevent.
    land: {
      branch: 'noriq/integration',
      mergeTarget: null,
      allowedBranches: [],
      onlyWhenVerifyPasses: true,
      resolveConflicts: true,
      autoPush: false,
      ...over,
    },
  });

// RUN-27: `[land].autoPush`. This crosses the one boundary the rest of the security model rests
// on — "nothing an agent writes leaves this machine" — so the default is the feature. Auto-landing
// was defensible precisely because `git push` stayed human, and `git log origin/main..main` was the
// operator's "what did the agents do while I wasn't looking?" check.
// RUN-29: the daemon owns verify, and a failure goes back to the LIVE agent.
//
// It used to run twice: the build prompt told the agent to run the verify command (tokens, ~62s),
// then the daemon ran the SAME command itself as the real gate (free). The agent was paying to
// answer a question that got asked again properly a minute later.
describe('verify feedback loop (RUN-29)', () => {
  const buildRun = () => makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } });

  it('does not ask the agent to run the full check itself', () => {
    // The expensive half of the double-verify. Its allowlist still permits running tests — cheap
    // and targeted while iterating is fine; burning the suite to grade itself is not.
    const p = assemblePrompt(makeRun({ kind: 'build' }), manifest(), {
      agent: testAgent(),
      server: 'https://s',
    });
    expect(p).not.toMatch(/Before finishing, run the verify command/);
    expect(p).toMatch(/run for you after you finish/);
    expect(p).toContain('npm test'); // it still knows WHAT the gate is
  });

  it('hands a failing gate back, and passes once the agent fixes it', async () => {
    // The gate becomes a feedback loop instead of a verdict: the agent gets the exact command,
    // code and output, in context, without a human re-dispatching and a fresh agent re-deriving
    // a failure the daemon already had in full.
    const h = harness({ verifyResults: [false, true] });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    const exit = await done;

    expect(exit.outcome).toBe('done'); // it recovered — no human, no re-dispatch
    expect(h.claude.continuations).toHaveLength(1);
    expect(h.claude.continuations[0]).toContain('npm test');
    expect(h.claude.continuations[0]).toContain('TS2322: type error'); // the actual output
    expect(h.verifyCalls()).toBe(2); // failed, then passed
  });

  it('gives up after a bounded number of tries', async () => {
    // An agent that cannot fix it in two goes will not on the third — it will keep spending.
    const h = harness({ verifyPasses: false });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    const exit = await done;

    expect(exit.reason).toBe('verify'); // gated to a human
    expect(h.claude.continuations).toHaveLength(2); // K=2, not forever
    expect(h.comments.some((c) => c.body.includes('npm test'))).toBe(true); // and said why
  });

  it("honors a repo's committed [verify] maxRounds over the K=2 default (RUN-94)", async () => {
    // The bound is the repo's to commit, not the daemon's to hardcode: a long-tail suite may
    // earn 4 rounds. The default stays 2 — this widens only where a manifest says so.
    const wider = manifest();
    if (wider.verify) wider.verify.maxRounds = 4;
    const h = harness({ verifyPasses: false, manifest: wider });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    const exit = await done;

    expect(exit.reason).toBe('verify'); // still gated in the end…
    expect(h.claude.continuations).toHaveLength(4); // …but after the committed 4 rounds
    // The last hand-back says it IS the last — the prompt's warning tracks the real bound.
    expect(h.claude.continuations[3]).toContain('last attempt');
    expect(h.claude.continuations[2]).not.toContain('last attempt');
  });

  it('maxRounds = 0 is a pure gate — the verdict stands, no fix turn is spent', async () => {
    const gateOnly = manifest();
    if (gateOnly.verify) gateOnly.verify.maxRounds = 0;
    const h = harness({ verifyPasses: false, manifest: gateOnly });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    const exit = await done;

    expect(exit.reason).toBe('verify');
    expect(h.claude.continuations).toEqual([]); // the repo said so, in the commit
  });

  it('stops pushing turns at a session that died trying', async () => {
    // The agent errored or breached its budget mid-fix. Its last verdict stands: pushing more
    // turns at a dead session is how a loop becomes a spend.
    const h = harness({ verifyPasses: false });
    h.claude.continueOutcomes = ['failed'];
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await done;
    expect(h.claude.continuations).toHaveLength(1); // asked once, it died, stop
  });

  it('closes the session — a multiTurn run that nobody closes hangs the daemon', async () => {
    // The driver deliberately does NOT self-close under multiTurn (that is the whole feature), so
    // the supervisor owns it. An open SDK query keeps the event loop alive forever.
    const h = harness({ verifyResults: [true] });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await done;
    expect(h.claude.stopped).toBe(true);
  });

  it('a scope run is single-turn — no loop, nothing to close', async () => {
    // Only a build with a verify command can loop. Everything else wants exactly the old
    // behaviour: finish on the first result and close.
    const h = harness();
    const done = h.supervisor.supervise(makeRun({ kind: 'scope' }));
    await flush();
    expect(h.claude.opts?.multiTurn).toBe(false);
    h.claude.complete('done');
    await done;
    expect(h.claude.continuations).toEqual([]);
  });
});

describe('[land].autoPush (RUN-27)', () => {
  const buildRun = () => makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } });

  it('does NOT push by default — a landing stays on this machine', async () => {
    // The single most important assertion in this file. Every repo already using [land] must not
    // start pushing because a new field appeared; consent has to be re-given, not inherited.
    const h = harness({ manifest: LANDING() });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    expect((await done).outcome).toBe('done');
    expect(h.worktrees.landings).toHaveLength(1); // it DID land…
    expect(h.worktrees.pushes).toEqual([]); // …and went nowhere
  });

  it('pushes the landed branch when a repo opts in', async () => {
    const h = harness({ manifest: LANDING({ autoPush: true }) });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    expect((await done).outcome).toBe('done');
    expect(h.worktrees.pushes).toEqual([{ root: '/repos/repo_a', branch: 'noriq/integration' }]);
  });

  it('a failed push does not fail the run — the work IS landed', async () => {
    // The diff is on the branch either way; only its trip to the remote failed. Marking the run
    // failed would send someone hunting for work that is sitting right there.
    const h = harness({ manifest: LANDING({ autoPush: true }) });
    h.worktrees.pushFails = 'remote rejected: protected branch';
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('done'); // the run SUCCEEDED
    expect(h.worktrees.pushes).toHaveLength(1); // it tried
    expect(h.worktrees.landings).toHaveLength(1); // and the work is on the branch regardless
  });

  it('pushes nothing when the landing itself failed', async () => {
    // Nothing landed → there is nothing to publish. Pushing here would put a branch on the
    // remote that the gate never passed.
    const h = harness({ manifest: LANDING({ autoPush: true }) });
    h.worktrees.landRaces = true;
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await done;
    expect(h.worktrees.landings).toEqual([]);
    expect(h.worktrees.pushes).toEqual([]);
  });

  it('pushes nothing when the verify gate refused the build', async () => {
    const h = harness({ manifest: LANDING({ autoPush: true }), verifyPasses: false });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await done;
    expect(h.worktrees.pushes).toEqual([]);
  });
});

// RUN-41: a dispatch steering its own landing branch.
describe('per-dispatch target branch (RUN-41)', () => {
  const buildRun = (over = {}) =>
    makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' }, ...over });

  it('lands on the dispatch’s branch when the repo allows it', async () => {
    const h = harness({ manifest: LANDING({ allowedBranches: ['feature/**'] }) });
    const done = h.supervisor.supervise(buildRun({ targetBranch: 'feature/risky-refactor' }));
    await flush();
    h.claude.complete('done');
    expect((await done).outcome).toBe('done');
    expect(h.worktrees.landings).toEqual([{ branch: 'feature/risky-refactor', fromRef: 'noriq/run/run_1' }]);
  });

  it('FAILS the run when the repo did not allow the override — it does not quietly use the default', async () => {
    // Silently landing somewhere other than where a human asked is how an agent's diff ends up
    // in a place nobody looked. Refuse loudly instead.
    const h = harness({ manifest: LANDING() }); // no allowedBranches → not steerable
    const done = h.supervisor.supervise(buildRun({ targetBranch: 'main' }));
    await flush();
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('failed');
    expect(h.worktrees.landings).toEqual([]); // nothing landed anywhere
  });

  it('refuses a branch outside the allowlist', async () => {
    const h = harness({ manifest: LANDING({ allowedBranches: ['feature/**'] }) });
    const done = h.supervisor.supervise(buildRun({ targetBranch: 'main' }));
    await flush();
    h.claude.complete('done');
    expect((await done).outcome).toBe('failed');
    expect(h.worktrees.landings).toEqual([]);
  });

  it('no override → the repo’s computed branch, exactly as before', async () => {
    const h = harness({ manifest: LANDING({ allowedBranches: ['feature/**'] }) });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await done;
    expect(h.worktrees.landings).toEqual([{ branch: 'noriq/integration', fromRef: 'noriq/run/run_1' }]);
  });
});

describe('landing a passing build (no human per run)', () => {
  const buildRun = () => makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } });

  it('rebases onto the integration tip, verifies THERE, then fast-forwards it in', async () => {
    const h = harness({ manifest: LANDING() });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    const exit = await done;

    expect(exit.outcome).toBe('done');
    // Order is the whole point: verify must judge the REBASED result, because two runs
    // can each be green at their own fork point and broken together.
    expect(h.worktrees.rebases).toEqual(['noriq/integration']);
    expect(h.verifyRan()).toBe(true);
    expect(h.worktrees.landings).toEqual([{ branch: 'noriq/integration', fromRef: 'noriq/run/run_1' }]);
  });

  it('reaps the worktree + branch once landed — the accumulation fix', async () => {
    const h = harness({ manifest: LANDING() });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await done;
    // The diff lives on the integration branch now; keeping a per-run directory forever
    // is exactly the graveyard this replaces.
    expect(h.worktrees.removed).toEqual(['/wt/run_1']);
  });

  it('creates the landing branch from defaultBranch on first use', async () => {
    const h = harness({ manifest: LANDING() });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await done;
    expect(h.worktrees.createdBranches).toEqual([{ branch: 'noriq/integration', from: 'main' }]);
  });

  it('does not land when the rebased result fails verify, and KEEPS the diff', async () => {
    const h = harness({ manifest: LANDING(), verifyPasses: false });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    const exit = await done;

    expect(exit.outcome).toBe('failed');
    expect(exit.reason).toBe('land:verify');
    expect(h.worktrees.landings).toEqual([]);
    // The work must survive: a human has to reconcile it.
    expect(h.worktrees.removed).toEqual([]);
    expect(h.comments[0]?.body).toContain('individually fine and broken together');
  });

  it('commits a fix the agent makes to pass the rebase gate BEFORE publishing it', async () => {
    // The landing sibling of the reviewer bug: when the post-rebase gate fails and the live agent
    // fixes it, that fix lives only in the working tree. publish fast-forwards the branch's
    // committed HEAD, so without folding it in first the daemon lands (and, under autoPush, pushes)
    // the very combination the gate just rejected. The fix must be committed before publish.
    const h = harness({ manifest: LANDING(), verifyResults: [false, true] });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    const exit = await done;

    expect(exit.outcome).toBe('done');
    expect(h.claude.continuations).toHaveLength(1); // the gate failed and the agent fixed it
    expect(h.worktrees.landings).toHaveLength(1); // and it landed
    // The build's own commit PLUS a landing-fix commit folding the working-tree fix into HEAD,
    // so publish fast-forwards the fixed tip rather than the broken one.
    expect(h.worktrees.commits.some((c) => /landing fix/.test(c.message))).toBe(true);
  });

  it('does nothing at all when the manifest declares no [land]', async () => {
    const h = harness(); // land: null
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    const exit = await done;

    expect(exit.outcome).toBe('done');
    expect(h.worktrees.rebases).toEqual([]);
    expect(h.worktrees.landings).toEqual([]);
    expect(h.worktrees.removed).toEqual([]); // opt-in: the old keep-for-review behaviour
  });

  it('never lands a scope run', async () => {
    const h = harness({ manifest: LANDING() });
    const done = h.supervisor.supervise(makeRun({ kind: 'scope' }));
    await flush();
    h.claude.complete('done');
    await done;
    expect(h.worktrees.landings).toEqual([]);
  });

  it('never lands a build that produced nothing', async () => {
    const h = harness({ manifest: LANDING(), changed: false });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    const exit = await done;
    expect(exit.reason).toBe('no_changes');
    expect(h.worktrees.landings).toEqual([]);
  });

  it('reports a race rather than inventing a merge commit', async () => {
    const h = harness({ manifest: LANDING(), landRaces: true });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    const exit = await done;
    expect(exit.reason).toBe('land:race');
    expect(h.worktrees.removed).toEqual([]);
  });

  it('honours onlyWhenVerifyPasses=false', async () => {
    const h = harness({ manifest: LANDING({ onlyWhenVerifyPasses: false }), verifyPasses: false });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('done');
    expect(h.worktrees.landings).toHaveLength(1); // landed unverified, as configured
  });
});

describe('plan-branch fork base (RUN-82)', () => {
  // A [land] with a per-plan working branch, and a run that belongs to that plan.
  const PLAN_LAND = LANDING({ branch: 'noriq/plan-<planKey>' });
  const planRun = (kind: 'build' | 'verify' = 'build') =>
    makeRun({
      kind,
      anchor: { type: 'task', taskId: 'task_9' },
      planKey: 'the-curated-init',
      ...(kind === 'verify' ? { verifiesRunId: 'run_build7' } : {}),
    });

  it('a build forks from the plan branch when it already exists (a predecessor landed)', async () => {
    const h = harness({ manifest: PLAN_LAND });
    h.worktrees.branches.add('noriq/plan-the-curated-init'); // RUN-62/63 landed here
    const done = h.supervisor.supervise(planRun());
    await flush();
    // The worktree forked from the plan branch — so it sees predecessors' work, no mirroring.
    expect(h.worktrees.created[0]?.fromTarget).toBe('noriq/plan-the-curated-init');
    h.claude.complete('done');
    await done;
  });

  it('the FIRST task (plan branch does not exist yet) forks from HEAD, exactly as before', async () => {
    const h = harness({ manifest: PLAN_LAND }); // branches = {main} only
    const done = h.supervisor.supervise(planRun());
    await flush();
    expect(h.worktrees.created[0]?.fromTarget).toBeUndefined(); // HEAD, no target
    h.claude.complete('done');
    await done;
  });

  it('no [land] configured → no plan base, forks from HEAD', async () => {
    const h = harness(); // manifest() has land: null
    h.worktrees.branches.add('noriq/plan-the-curated-init');
    const done = h.supervisor.supervise(planRun());
    await flush();
    expect(h.worktrees.created[0]?.fromTarget).toBeUndefined();
    h.claude.complete('done');
    await done;
  });

  it('a verify run does NOT fork from the plan branch — it leases from the build it judges', async () => {
    const h = harness({ manifest: PLAN_LAND });
    h.worktrees.branches.add('noriq/plan-the-curated-init');
    const done = h.supervisor.supervise(planRun('verify'));
    await flush();
    expect(h.worktrees.created[0]?.fromRunId).toBe('run_build7'); // the build's work
    expect(h.worktrees.created[0]?.fromTarget).toBeUndefined(); // NOT the plan branch
    // …but it is MEASURED against the plan branch, so its diff is the true task delta, not
    // every predecessor's landed work re-counted.
    expect(h.claude.opts?.prompt).toContain('git diff noriq/plan-the-curated-init...HEAD');
    h.claude.emitText('VERDICT: PASS');
    h.claude.complete('done');
    await done;
  });
});

// RUN-145. The gate answers the definition of done criterion by criterion, with evidence — and
// this actor had never been given the criteria in ANY form. RUN-139 handed them to the DISPATCHED
// verify run and CLAUDE.md said "the verify family"; the family has two members and this is the one
// that gates every build with a [verify.agent], while the dispatched run is opt-in. Same shape as
// RUN-158: a rule described as holding everywhere, holding at the site that runs less often.
// RUN-168. A decomposed spec runs as a chain of sessions, one per step. The point is that each
// starts FRESH — not carrying the previous step's exploration — and inherits its conclusions
// instead. A chain of fresh contexts beats one long context only if each link gets the hand-off.
// RUN-166. A task's spec is a live row anyone may edit at any point, so "what was this builder
// told?" was inferred from the current row rather than answered — and once verification grades a
// run against per-acceptance-item evidence (RUN-145), which criteria applied to THIS run stops
// being a curiosity and becomes the input to a gate.
describe('a run records the spec it was briefed with (RUN-166)', () => {
  const buildRun = () => makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } });
  const withSpec = (): AnchorTask => ({
    key: 'ACME-1',
    title: 'reap orphans',
    body: null,
    executionSpec: ExecutionSpec.parse({ acceptance: { observableTruths: ['it reaps on start'] } }),
  });

  it('reports it once, and it is the spec the agent was actually briefed with', async () => {
    const h = harness({ anchorTask: withSpec() });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await done;

    const reported = h.reports.filter((r) => r.executedSpec);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.executedSpec!.acceptance.observableTruths).toEqual(['it reaps on start']);
  });

  // Nothing to record for a task nobody planned and no planner ran on — and a run with no spec
  // must not report an empty one, which would read as "briefed with nothing" rather than "no
  // spec". The daemon says nothing instead.
  it('says nothing for a run with no spec', async () => {
    const h = harness({ anchorTask: null });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await done;
    expect(h.reports.filter((r) => r.executedSpec)).toHaveLength(0);
  });
});

describe('a decomposed run is a chain of sessions (RUN-168)', () => {
  const twoSteps = (): AnchorTask => ({
    key: 'ACME-1',
    title: 'the contract, then its consumer',
    body: null,
    executionSpec: ExecutionSpec.parse({
      steps: [
        { id: 's1', title: 'land the contract', anticipatedFiles: [{ path: 'src/a.ts', change: 'create' }] },
        { id: 's2', title: 'consume it', dependsOn: ['s1'] },
      ],
    }),
  });

  const threeSteps = (): AnchorTask => ({
    key: 'ACME-1',
    title: 'three steps',
    body: null,
    executionSpec: ExecutionSpec.parse({
      steps: [
        { id: 's1', title: 'first' },
        { id: 's2', title: 'second' },
        { id: 's3', title: 'third' },
      ],
    }),
  });

  const buildRun = () => makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } });

  it('spawns one session per step, each with its own brief, and lands only at the end', async () => {
    const h = harness({ anchorTask: twoSteps() });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.emitText('step one done');
    h.claude.complete('done'); // s1
    for (let i = 0; i < 200 && h.claude.starts.length < 2; i++) await new Promise((r) => setTimeout(r, 0));
    h.claude.emitText('step two done');
    h.claude.complete('done'); // s2
    const exit = await done;

    expect(h.claude.starts).toHaveLength(2);
    expect(h.claude.starts[0]!.prompt).toContain('YOU ARE DOING STEP 1 OF 2: land the contract');
    expect(h.claude.starts[1]!.prompt).toContain('YOU ARE DOING STEP 2 OF 2: consume it');
    // A FRESH session, not the previous step's continued — that is the whole reason to decompose.
    expect(h.claude.starts[1]!.resumeSessionId).toBeUndefined();
    // …carrying what step one concluded, so it does not rediscover it.
    expect(h.claude.starts[1]!.prompt).toContain('WHAT THE EARLIER STEPS DID');
    expect(h.claude.starts[1]!.prompt).toContain('step one done');
    expect(exit.outcome).toBe('done');
  });

  // Continuing past a failed step would build later steps on a foundation the run already knows is
  // broken, and would report a run that did half its plan as one that did all of it. Three steps
  // and a failure in the MIDDLE, because failing the only session is what a run did before this
  // existed — it would pass with the feature removed and prove nothing about chains.
  it('stops at the step that failed, having run the ones before it', async () => {
    const h = harness({ anchorTask: threeSteps() });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.emitText('one done');
    h.claude.complete('done'); // s1
    for (let i = 0; i < 200 && h.claude.starts.length < 2; i++) await new Promise((r) => setTimeout(r, 0));
    h.claude.complete('failed'); // s2
    const exit = await done;
    expect(h.claude.starts).toHaveLength(2); // s1 ran, s2 failed, s3 never started
    expect(exit).toMatchObject({ outcome: 'failed' });
    expect(h.transcript.map((t) => t.text).join('\n')).toMatch(/step 2\/3 did not finish/);
  });

  // The tally is last-writer-wins PER SLOT, so steps sharing `primary` would leave the run's total
  // showing only the last one — and the live guard, named per step, would be probing a different
  // figure from the one being written.
  it('records each step’s spend in its own slot, so the run total is the whole chain', async () => {
    const h = harness({ anchorTask: twoSteps() });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done', { outputTokens: 100 }); // s1
    for (let i = 0; i < 200 && h.claude.starts.length < 2; i++) await new Promise((r) => setTimeout(r, 0));
    h.claude.complete('done', { outputTokens: 30 }); // s2
    const exit = await done;
    // 130, not 30. Sharing a slot would have reported only the last step.
    expect(exit.telemetry?.outputTokens).toBe(130);
  });

  it('says in the transcript which step is speaking, and which never ran', async () => {
    const h = harness({ anchorTask: twoSteps() });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('failed');
    await done;
    const said = h.transcript.map((t) => t.text).join('\n');
    expect(said).toContain('step 1/2 — land the contract [s1]');
    expect(said).toMatch(/the remaining steps did not run/);
  });

  // RUN-150. Without this a five-step run reads as one undifferentiated stream and an operator has
  // no idea what is actually happening — the whole reason a decomposition is worth watching.
  it('labels each step’s transcript segments, and stops labelling once the chain is over', async () => {
    const h = harness({ anchorTask: twoSteps() });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.emitText('one');
    h.claude.complete('done');
    for (let i = 0; i < 200 && h.claude.starts.length < 2; i++) await new Promise((r) => setTimeout(r, 0));
    h.claude.emitText('two');
    h.claude.complete('done');
    await done;

    const said = h.transcript.filter((t) => t.text === 'one' || t.text === 'two');
    expect(said.map((t) => [t.text, t.step])).toEqual([
      ['one', 's1'],
      ['two', 's2'],
    ]);
    // The gates that follow belong to the PARENT — the label rides each SESSION, so nothing after
    // the chain inherits the last step's. On a FAILED chain that would be the step that failed,
    // which is exactly the wrong answer in the place a human looks first.
    expect(h.transcript.at(-1)!.step).toBeNull();
    // …and a reviewer round, which runs after the chain, is unlabelled for the same reason.
    expect(h.transcript.filter((t) => t.role === 'reviewer').every((t) => t.step === null)).toBe(true);
  });

  // A spec with no steps must behave exactly as it did before — that is most runs.
  it('runs a spec with no steps as one session, as always', async () => {
    const h = harness({ anchorTask: null });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await done;
    expect(h.claude.starts).toHaveLength(1);
    expect(h.claude.starts[0]!.prompt).not.toContain('YOU ARE DOING STEP');
  });
});

describe('the inline reviewer answers acceptance criteria (RUN-145)', () => {
  const REVIEWED = () =>
    manifest({
      verify: {
        cmd: null,
        timeoutSeconds: null,
        shell: null,
        maxRounds: 0,
        agent: { agent: null, tool: null, model: null, effort: null, maxRounds: 0 },
      },
    });

  const withCriteria = (...truths: string[]): AnchorTask => ({
    key: 'ACME-1',
    title: 'reap orphans',
    body: null,
    executionSpec: ExecutionSpec.parse({ acceptance: { observableTruths: truths } }),
  });

  /** Build → reviewer, with the reviewer emitting `reply` as its whole report. */
  const reviewedWith = async (task: AnchorTask | null, reply: string) => {
    const h = harness({ manifest: REVIEWED(), anchorTask: task });
    const done = h.supervisor.supervise(
      makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } }),
    );
    await flush();
    h.claude.complete('done'); // the build turn
    for (let i = 0; i < 200; i++) {
      if (h.claude.opts?.runId === 'run_1:review' && h.claude.starts.length >= 2) break;
      await new Promise((r) => setTimeout(r, 0));
    }
    const review = h.claude.starts[1];
    if (!review) throw new Error('the reviewer session never started');
    h.claude.emitText(reply);
    h.claude.complete('done');
    return { h, review, exit: await done };
  };

  it('is shown the numbered criteria and told how to answer them', async () => {
    const { review } = await reviewedWith(
      withCriteria('the daemon reaps orphans on start', 'no agent ever gets push credentials'),
      'ACCEPTANCE 1: VERIFIED src/worktree.ts:88\nACCEPTANCE 2: VERIFIED src/security.ts:20\nVERDICT: PASS',
    );
    expect(review.prompt).toContain('1. [truth] the daemon reaps orphans on start');
    expect(review.prompt).toContain('2. [truth] no agent ever gets push credentials');
    // The numbers buy nothing without the format that spends them.
    expect(review.prompt).toContain('ACCEPTANCE <n>:');
    expect(review.prompt).toMatch(/recorded as BEHAVIOUR-UNVERIFIED/);
  });

  // The report answered its own question twice. Reading it as PASS is not a decision anybody made —
  // it falls out of which parser ran last.
  it('gates the run when the reviewer signs off PASS over a criterion it marked FAILED', async () => {
    const { exit, h } = await reviewedWith(
      withCriteria('the daemon reaps orphans on start'),
      'ACCEPTANCE 1: FAILED nothing reaps on start\nVERDICT: PASS',
    );
    expect(exit.outcome).toBe('failed');
    expect(exit.reason).toBe('review');
    expect(h.comments.map((c) => c.body).join('\n')).toMatch(/the daemon overrode this PASS/);
  });

  // Most specs are half-written. Failing every build over a truth nobody could evidence would make
  // the field a tripwire — but a passing run is the ONLY place such a gap would otherwise vanish,
  // so it is posted rather than merely logged.
  it('lets a PASS stand over an unanswered criterion, and says so on the task', async () => {
    const { exit, h } = await reviewedWith(
      withCriteria('the daemon reaps orphans on start', 'it never pushes'),
      'ACCEPTANCE 1: VERIFIED src/worktree.ts:88\nVERDICT: PASS',
    );
    expect(exit.outcome).toBe('done');
    const posted = h.comments.map((c) => c.body).join('\n');
    expect(posted).toMatch(/1 verified, 0 failed, 1 unverified/);
    expect(posted).toMatch(/it never pushes/);
  });

  // Most runs carry no spec, and those reviews must look exactly as they did before.
  it('says nothing about acceptance for a run with no spec', async () => {
    const { review, h, exit } = await reviewedWith(null, 'VERDICT: PASS');
    expect(review.prompt).not.toContain('ACCEPTANCE CRITERIA');
    expect(exit.outcome).toBe('done');
    expect(h.comments).toEqual([]);
  });
});

// RUN-146. The report is an argument; the fix turn needs a specification. The daemon already holds
// what is outstanding as data, so it leads with it rather than making the builder reconstruct it
// from prose every round.
// RUN-147. A finding tied to the requirement it threatens survives a fresh reviewer's rewording,
// and the run can say which requirements came through clear.
describe('findings carry requirement ids (RUN-147)', () => {
  const REVIEWED = () =>
    manifest({
      verify: {
        cmd: null,
        timeoutSeconds: null,
        shell: null,
        maxRounds: 0,
        agent: { agent: null, tool: null, model: null, effort: null, maxRounds: 0 },
      },
    });

  const taskRequiring = (...requirementIds: string[]): AnchorTask => ({
    key: 'ACME-1',
    title: 'reap orphans',
    body: null,
    executionSpec: ExecutionSpec.parse({ requirementIds }),
  });

  const reviewedWith = async (task: AnchorTask | null, reply: string) => {
    const h = harness({ manifest: REVIEWED(), anchorTask: task });
    const done = h.supervisor.supervise(
      makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } }),
    );
    await flush();
    h.claude.complete('done');
    for (let i = 0; i < 200; i++) {
      if (h.claude.opts?.runId === 'run_1:review' && h.claude.starts.length >= 2) break;
      await new Promise((r) => setTimeout(r, 0));
    }
    const review = h.claude.starts[1]!;
    h.claude.emitText(reply);
    h.claude.complete('done');
    return { h, review, exit: await done };
  };

  it('tells the reviewer which requirements exist and how to name one', async () => {
    const { review } = await reviewedWith(taskRequiring('R-7', 'R-9'), 'VERDICT: PASS');
    expect(review.prompt).toContain('traceable to these requirements: R-7, R-9');
    expect(review.prompt).toContain('FINDING <n> [<severity>] [<requirement ids>] <file:line>');
    // The reason, not just the format — a rule with no rationale is one a model drops under load.
    expect(review.prompt).toMatch(/survives rewording because it is not wording/);
    // …and the guard against stretching to fit.
    expect(review.prompt).toMatch(/a wrong association is worse than no association/);
  });

  it('reports per requirement when the run ends, including the ones nothing was raised against', async () => {
    // maxRounds 0 makes the first review the TERMINAL one, so the finding draws a RUN-174 contest
    // turn (no code change). The builder streams no rebuttal, so nothing is contested and the
    // finding stands with no re-review — R-7 is reported open.
    const { h } = await reviewedWith(
      taskRequiring('R-7', 'R-9'),
      'FINDING 1 [High] [R-7] src/a.ts:1: it never reaps\nVERDICT: FAIL',
    );
    const posted = h.comments.map((c) => c.body).join('\n');
    expect(posted).toMatch(/❌ \*\*R-7\*\* — 1 finding\(s\) still standing/);
    expect(posted).toMatch(/➖ \*\*R-9\*\* — no finding was recorded against it/);
  });

  it('says nothing about requirements for a task that names none', async () => {
    const { review, h } = await reviewedWith(null, 'VERDICT: PASS');
    expect(review.prompt).not.toContain('traceable to these requirements');
    expect(h.comments.map((c) => c.body).join('\n')).not.toContain('Requirements');
  });
});

describe('a failing gate hands back a specification (RUN-146)', () => {
  const REVIEWED = () =>
    manifest({
      verify: {
        cmd: null,
        timeoutSeconds: null,
        shell: null,
        maxRounds: 1,
        agent: { agent: null, tool: null, model: null, effort: null, maxRounds: 1 },
      },
    });

  const taskWith = (...truths: string[]): AnchorTask => ({
    key: 'ACME-1',
    title: 'reap orphans',
    body: null,
    executionSpec: ExecutionSpec.parse({ acceptance: { observableTruths: truths } }),
  });

  /** Build → reviewer FAILs with `report` → the builder's fix turn. Returns that turn's text. */
  const fixTurnAfter = async (task: AnchorTask | null, report: string) => {
    const h = harness({ manifest: REVIEWED(), anchorTask: task });
    const done = h.supervisor.supervise(
      makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } }),
    );
    await flush();
    h.claude.complete('done'); // build turn
    for (let i = 0; i < 200; i++) {
      if (h.claude.opts?.runId === 'run_1:review') break;
      await new Promise((r) => setTimeout(r, 0));
    }
    h.claude.emitText(report);
    h.claude.complete('done'); // reviewer round 1
    for (let i = 0; i < 200; i++) {
      if (h.claude.continuations.length) break;
      await new Promise((r) => setTimeout(r, 0));
    }
    const turn = h.claude.continuations[0] ?? '';
    // Let the run finish so nothing is left pending.
    for (let i = 0; i < 200 && h.claude.starts.length < 3; i++) await new Promise((r) => setTimeout(r, 0));
    h.claude.emitText('VERDICT: PASS');
    h.claude.complete('done');
    await done.catch(() => {});
    return turn;
  };

  it('leads with the outstanding criteria, and keeps the report as the evidence behind them', async () => {
    const turn = await fixTurnAfter(
      taskWith('it reaps orphans on start'),
      'FINDING 1 [High] src/worktree.ts:88: reapOrphans is never called\nACCEPTANCE 1: FAILED nothing reaps\nVERDICT: FAIL',
    );
    expect(turn).toMatch(/WHAT IS STILL OUTSTANDING/);
    expect(turn).toMatch(/NOT SATISFIED[\s\S]*it reaps orphans on start/);
    expect(turn).toContain('Files the report names: src/worktree.ts');
    // The findings are still there in full — the builder answers them number by number, and the
    // ledger (RUN-79) depends on that block existing.
    expect(turn).toContain('reapOrphans is never called');
    expect(turn).toMatch(/FINDING <n>: FIXED/);
    // Specification first, evidence second.
    expect(turn.indexOf('WHAT IS STILL OUTSTANDING')).toBeLessThan(turn.indexOf('Its report'));
  });

  // The failure this exists to prevent: a builder told only "not satisfied" rewrites code that was
  // already correct to satisfy a gate that merely could not see it.
  it('tells the builder an unverified criterion usually needs evidence, not a code change', async () => {
    const turn = await fixTurnAfter(
      taskWith('it never pushes'),
      'FINDING 1 [Med] src/a.ts:1: something else\nACCEPTANCE 1: BEHAVIOUR-UNVERIFIED nothing covers it\nVERDICT: FAIL',
    );
    expect(turn).toMatch(/NOT ESTABLISHED[\s\S]*usually NOT a code defect/);
    expect(turn).toMatch(/prefer making it demonstrable/);
    // …and the trap closed: a characterization test is not evidence.
    expect(turn).toMatch(/merely records what the code does today is not evidence/);
  });

  // A spec built once and reused would tell round 2 to fix what round 1 already fixed — and the
  // builder, told a criterion is still outstanding when it is not, either re-does the work or
  // starts distrusting the block. Each round's spec comes from THAT round's verdict.
  it('reflects the round it is handed to, not the first one', async () => {
    const h = harness({
      manifest: manifest({
        verify: {
          cmd: null,
          timeoutSeconds: null,
          shell: null,
          maxRounds: 2,
          agent: { agent: null, tool: null, model: null, effort: null, maxRounds: 2 },
        },
      }),
      anchorTask: taskWith('it reaps orphans', 'it never pushes'),
    });
    const done = h.supervisor.supervise(
      makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } }),
    );
    await flush();
    h.claude.complete('done');
    const awaitReview = async (n: number) => {
      for (let i = 0; i < 300; i++) {
        if (h.claude.opts?.runId === 'run_1:review' && h.claude.starts.length >= n) return;
        await new Promise((r) => setTimeout(r, 0));
      }
      throw new Error(`reviewer ${n} never started`);
    };
    await awaitReview(2);
    h.claude.emitText('FINDING 1 [High] src/a.ts:1: x\nACCEPTANCE 1: FAILED nothing reaps\nVERDICT: FAIL');
    h.claude.complete('done'); // round 1
    await awaitReview(3);
    // Round 1's criterion is fixed; a DIFFERENT one now fails.
    h.claude.emitText(
      'FINDING 2 [High] src/b.ts:1: y\nACCEPTANCE 1: VERIFIED src/a.ts:9\nACCEPTANCE 2: FAILED it pushes\nVERDICT: FAIL',
    );
    h.claude.complete('done'); // round 2
    for (let i = 0; i < 300 && h.claude.continuations.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    await awaitReview(4);
    h.claude.emitText('VERDICT: PASS');
    h.claude.complete('done');
    await done;

    const [first, second] = h.claude.continuations;
    expect(first).toContain('it reaps orphans');
    expect(second).toContain('it never pushes');
    // The one round 2's reviewer just marked VERIFIED must not be re-issued as outstanding work.
    expect(second).not.toMatch(/NOT SATISFIED[\s\S]*it reaps orphans/);
    expect(second).toMatch(/1 other criterion is already satisfied/);
  });

  // Every run without a spec, which is most of them, must get exactly the hand-back it got before.
  it('adds nothing for a run with no criteria', async () => {
    const turn = await fixTurnAfter(null, 'FINDING 1 [High] src/a.ts:1: broken\nVERDICT: FAIL');
    expect(turn).not.toContain('WHAT IS STILL OUTSTANDING');
    expect(turn).toContain('broken');
  });
});

describe('the inline reviewer (RUN-61)', () => {
  const REVIEWED = (
    cmd: string | null = 'npm test',
    agent: Partial<NonNullable<NonNullable<ProjectManifest['verify']>['agent']>> = {},
  ) =>
    manifest({
      verify: {
        cmd,
        timeoutSeconds: null,
        shell: null,
        maxRounds: 2,
        agent: { agent: null, tool: null, model: null, effort: null, maxRounds: 2, ...agent },
      },
    });

  const buildRun = () => makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } });

  /** Wait for the Nth driver start to be the reviewer's session. */
  const onReviewTurn = async (h: ReturnType<typeof harness>, atLeastStarts = 2) => {
    for (let i = 0; i < 100; i++) {
      if (h.claude.opts?.runId === 'run_1:review' && h.claude.starts.length >= atLeastStarts) return;
      await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error('the reviewer session never started');
  };

  // RUN-154. The reviewer is the actor asked whether a diff looks like this repo's code, and it was
  // the one told nothing about what this repo's code looks like. Names only — its context already
  // carries the diff — and resolved at the point of use, so a run RESUMED in a later process gets
  // it too (only the first sitting ever assembles a prompt with the run's own context in scope).
  it("carries the repo's own conventions, by name, without inlining the documents", async () => {
    const reads: string[] = [];
    const h = harness({
      manifest: {
        ...REVIEWED('npm test'),
        context: {
          requiredReading: ['CLAUDE.md'],
          entryPoints: ['src/daemon.ts'],
          conventions: ['ESM only'],
          agentInstructions: 'inline' as const,
        },
      },
      pathProbe: async () => true,
      readDoc: async (abs) => {
        reads.push(abs);
        return '# house rules';
      },
    });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onReviewTurn(h);

    const review = h.claude.starts[1]!;
    expect(review.prompt).toContain('QUOTED FROM THE REPOSITORY UNDER REVIEW');
    expect(review.prompt).toContain('- Conventions (non-negotiable): ESM only');
    expect(review.prompt).toContain('CLAUDE.md');
    expect(review.prompt).toMatch(/before judging the diff/);
    // The document itself stays out: the diff is what this actor's context is for.
    expect(review.prompt).not.toContain('# house rules');
    // Exactly ONE read in the whole run — the builder's. The reviewer's loader added none: it
    // resolves paths and never opens them, which is what "names only" has to mean to be worth it.
    expect(reads).toEqual([path.resolve('/wt/run_1', 'CLAUDE.md')]);
    // The daemon's verdict rules come AFTER repo-controlled text — last word to the side that is
    // not written by the repository being judged.
    expect(review.prompt.indexOf('QUOTED FROM THE REPOSITORY')).toBeLessThan(
      review.prompt.indexOf('End your response with EXACTLY one line'),
    );
    // …and the BUILDER still gets it inlined — the two actors want different things.
    expect(h.claude.starts[0]?.prompt).toContain('# house rules');

    h.claude.emitText('VERDICT: PASS');
    h.claude.complete('done');
    await done;
  });

  it('spawns a fresh read-only session with NO Noriq credential, and a PASS reaches done', async () => {
    const h = harness({ manifest: REVIEWED('npm test', { model: 'claude-opus-4-8', effort: 'high' }) });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done'); // the build turn
    await onReviewTurn(h);

    const review = h.claude.starts[1]!;
    expect(review.runId).toBe('run_1:review');
    expect(review.kind).toBe('verify'); // executes but never edits — the verify floor
    expect(review.permission.write).toBe(false);
    expect(review.noriqMcp).toBeUndefined(); // one run, one credential (RUN-43) — the reviewer has none
    expect(review.model).toBe('claude-opus-4-8'); // the SET model — the point of the knob
    expect(review.effort).toBe('high');
    expect(review.prompt).toContain('git diff base0000...HEAD'); // the diff since the fork
    expect(review.prompt).toContain('ship the thing'); // the intent it judges against (the brief here)

    h.claude.emitText('Checked the diff against the intent.\nVERDICT: PASS');
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('done');
    expect(h.verifyRan()).toBe(true); // the cmd floor still ran first
  });

  // RUN-158. The assertion above passed for the wrong reason: the default `[permissions.verify]`
  // profile already says `write = false`, so it only ever proved the default. The reviewer's
  // profile was handed over RAW, so a repo that asked for a writable verify posture got a reviewer
  // holding Edit/Write over the diff it was judging — free to "fix" the code and then PASS it.
  // RUN-118's floor is described as applying at every permission site; this was the site it missed,
  // and the one that matters most: a dispatched verify run is opt-in, the inline reviewer gates
  // every build that configures one.
  it('stays read-only even when the manifest asks for a WRITABLE verify posture (RUN-158)', async () => {
    const writableVerify = REVIEWED();
    writableVerify.permissions.verify = { ...writableVerify.permissions.verify, write: true };
    const h = harness({ manifest: writableVerify });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onReviewTurn(h);

    expect(h.claude.starts[1]!.permission.write).toBe(false);
    // The build's own agent is untouched — a producing workflow keeps its declared profile, which
    // is the half of the clamp that must NOT change.
    expect(h.claude.starts[0]!.permission.write).toBe(true);

    h.claude.emitText('VERDICT: PASS');
    h.claude.complete('done');
    await done;
  });

  it('a reviewer AGENT coordinate picks the vendor, model, and effort (RUN-113)', async () => {
    // [verify.agent] agent = "codex.gpt-5_6-sol.high" → a codex reviewer judging a claude build.
    const h = harness({ manifest: REVIEWED('npm test', { agent: 'codex.gpt-5_6-sol.high' }) });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done'); // the build turn runs on claude
    for (let i = 0; i < 50; i++) {
      if (h.codex.starts.some((s) => s.runId === 'run_1:review')) break;
      await new Promise((r) => setTimeout(r, 0));
    }
    const review = h.codex.starts.find((s) => s.runId === 'run_1:review');
    expect(review).toBeDefined();
    expect(review?.model).toBe('gpt-5.6-sol'); // unescaped from the coordinate
    expect(review?.effort).toBe('high');
    h.codex.emitText('VERDICT: PASS');
    h.codex.complete('done');
    await done;
  });

  it('hands a FAIL report back to the builder, then a FRESH reviewer passes the fix', async () => {
    const h = harness({ manifest: REVIEWED(), verifyResults: [true, true] });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onReviewTurn(h, 2);
    h.claude.emitText('The error path is untested.\nVERDICT: FAIL');
    h.claude.complete('done'); // reviewer #1 files FAIL
    await onReviewTurn(h, 3); // fix turn ran (continueWith), floor re-ran, reviewer #2 starts
    expect(h.claude.continuations.some((c) => c.includes('The error path is untested'))).toBe(true);
    h.claude.emitText('Fixed now.\nVERDICT: PASS');
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('done');
    expect(h.verifyCalls()).toBe(2); // the fix must re-pass the deterministic floor too
  });

  it('carries round 1 findings + the builder’s rebuttal into round 2’s reviewer prompt (RUN-79)', async () => {
    // The RUN-59 failure mode: a fresh reviewer re-raised a finding the builder had answered
    // with evidence, because the rebuttal never reached it. The ledger carries round 1's
    // numbered finding AND the builder's structured CONTESTED pointer into round 2's prompt.
    const h = harness({ manifest: REVIEWED(), verifyResults: [true, true] });
    // The builder's fix turn emits a structured RESPONSE block — the ledger parses it.
    h.claude.continueTexts = [
      'Looked at it.\nFINDING 1: CONTESTED src/telemetry.ts:5, commit abc123 — mix is primary-session by design',
    ];
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done'); // the build turn
    await onReviewTurn(h, 2);
    // Reviewer round 1 files a NUMBERED finding, then FAIL.
    h.claude.emitText('FINDING 1 [High] src/telemetry.ts:5: reviewer mix stripped\nVERDICT: FAIL');
    h.claude.complete('done');
    await onReviewTurn(h, 3); // fix turn ran (RESPONSE block emitted), reviewer #2 starts

    const round2Prompt = h.claude.starts[2]!.prompt;
    expect(round2Prompt).toMatch(/PRIOR ADJUDICATIONS/); // the ledger reached round 2
    expect(round2Prompt).toContain('reviewer mix stripped'); // round 1's finding claim
    expect(round2Prompt).toContain('CONTESTED (src/telemetry.ts:5, commit abc123)'); // the rebuttal pointer
    expect(round2Prompt).toMatch(/verify the pointer against the diff yourself/i); // the frame

    h.claude.emitText('Verified the pointer holds.\nVERDICT: PASS');
    h.claude.complete('done');
    expect((await done).outcome).toBe('done');
  });

  it('commits the fix before re-review, so the fresh reviewer diff includes it (not the stale HEAD)', async () => {
    // The RUN-56 failure mode: the builder edits the working tree, but the reviewer inspects
    // `git diff baseId...HEAD` — a committed range. Without a checkpoint between rounds, HEAD
    // never advances, so every fresh reviewer re-reads the SAME diff and re-reports the SAME
    // findings, while the deterministic floor (which reads the working tree) passes. The daemon
    // must fold the fix into the branch before the re-review.
    const h = harness({ manifest: REVIEWED(), verifyResults: [true, true] });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onReviewTurn(h, 2);
    h.claude.emitText('The error path is untested.\nVERDICT: FAIL');
    h.claude.complete('done'); // reviewer #1 files FAIL
    await onReviewTurn(h, 3); // fix turn ran, floor re-ran, reviewer #2 starts
    // A commit was made carrying the fix round — HEAD moved, so reviewer #2's range is fresh.
    expect(h.worktrees.commits.some((c) => /fix round 1/.test(c.message))).toBe(true);
    h.claude.emitText('Fixed now.\nVERDICT: PASS');
    h.claude.complete('done');
    await done;
  });

  it('the TRANSCRIPT carries every voice, in order: build → verify → reviewer → fix → re-review (RUN-74)', async () => {
    // The dogfood pain this exists for: both builds were refused and the dashboard could not
    // say why — only the core agent's tail ever reached the server.
    const h = harness({ manifest: REVIEWED(), verifyResults: [true, true] });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.emitText('implementing…');
    h.claude.complete('done');
    await onReviewTurn(h, 2);
    h.claude.emitText('The error path is untested.\nVERDICT: FAIL');
    h.claude.complete('done');
    await onReviewTurn(h, 3);
    h.claude.emitText('Fixed now.\nVERDICT: PASS');
    h.claude.complete('done');
    await done;

    const stream = h.transcript.map((s) => [s.role, s.round] as const);
    // The builder spoke, the floor passed, reviewer round 1 refused, the report was handed
    // back, reviewer round 2 passed, and the run closed — each as its own voice, in order.
    const roleOrder = h.transcript.map((s) => `${s.role}${s.round ? `:${s.round}` : ''}`);
    expect(roleOrder[0]).toBe('agent');
    expect(roleOrder).toContain('reviewer:1');
    expect(roleOrder).toContain('reviewer:2');
    expect(roleOrder.indexOf('reviewer:1')).toBeLessThan(roleOrder.indexOf('reviewer:2'));
    const text = h.transcript.map((s) => s.text).join('\n');
    expect(text).toContain('verify command passed');
    expect(text).toContain('reviewer verdict: FAIL (round 1)');
    expect(text).toContain("handing the reviewer's report to the live agent (fix round 1/2)");
    expect(text).toContain('reviewer verdict: PASS (round 2)');
    expect(text).toMatch(/run finished: done/);
    // Seqs are monotonic — the server dedups on them.
    expect(h.transcript.every((s, i) => i === 0 || s.seq > h.transcript[i - 1]!.seq)).toBe(true);
    void stream;
  });

  it('gates the run when the reviewer still refuses after maxRounds, and posts the report', async () => {
    const h = harness({ manifest: REVIEWED('npm test', { maxRounds: 1 }), verifyResults: [true, true] });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onReviewTurn(h, 2);
    h.claude.emitText('Not good enough.\nVERDICT: FAIL');
    h.claude.complete('done');
    await onReviewTurn(h, 3);
    h.claude.emitText('Still not good enough.\nVERDICT: FAIL');
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('failed');
    expect(exit.reason).toBe('review');
    expect(h.comments.at(-1)?.body).toMatch(/does not satisfy the intent/);
    expect(h.comments.at(-1)?.body).toContain('Still not good enough');
    expect(h.worktrees.removed).toEqual([]); // the diff is kept — a human still needs it
  });

  // RUN-175. The reviewer could already say STRUCTURAL in prose; only the builder read it, so a
  // run diagnosed as unconvergeable still burned every fix round rediscovering that. The token is
  // the machine-readable half — honoured only evidenced, and a FAIL either way.
  const ESCALATED = [
    'FINDING 1 [High] src/a.ts:10: the write floor is re-derived per site — also src/b.ts:20 and src/c.ts:30',
    'ESCALATE STRUCTURAL FINDING 1: no single chokepoint enforces the floor — src/a.ts:10, src/b.ts:20, src/c.ts:30',
    'VERDICT: FAIL',
  ].join('\n');

  it('an honoured escalation ends the loop in round 1: no fix turn, a distinct reason, the diagnosis posted (RUN-175)', async () => {
    const h = harness({ manifest: REVIEWED() }); // maxRounds 2 — none of them spent
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onReviewTurn(h, 2);
    h.claude.emitText(ESCALATED);
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('failed');
    expect(exit.reason).toBe('review:structural'); // distinct from a plain 'review' rejection
    expect(h.claude.continuations).toEqual([]); // the remaining rounds were NOT spent
    expect(h.claude.starts).toHaveLength(2); // build + exactly one reviewer — no contest turn either
    const body = h.comments.at(-1)?.body ?? '';
    expect(body).toMatch(/STRUCTURALLY unconvergeable/);
    expect(body).toContain('no single chokepoint enforces the floor'); // the diagnosis leads
    expect(body).toContain('src/b.ts:20'); // the evidence shows, rather than asks to be trusted
    expect(h.worktrees.removed).toEqual([]); // a FAIL, never a silent pass — the diff is kept
    // The transcript names the fail-fast, so a human reading the stream sees why round 2 never ran.
    expect(h.transcript.map((s) => s.text).join('\n')).toContain('escalated STRUCTURAL');
  });

  it('a demoted (under-evidenced) escalation consumes rounds exactly as an ordinary FAIL (RUN-175)', async () => {
    const h = harness({ manifest: REVIEWED('npm test', { maxRounds: 1 }), verifyResults: [true, true] });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onReviewTurn(h, 2);
    // One cited instance — below the floor of 3, so the token is ignored, not honoured.
    h.claude.emitText(
      'FINDING 1 [High] src/a.ts:10: one bad site\nESCALATE STRUCTURAL FINDING 1: feels systemic — src/a.ts:10\nVERDICT: FAIL',
    );
    h.claude.complete('done');
    await onReviewTurn(h, 3); // the fix round DID run — the demotion changed nothing
    h.claude.emitText('Still leaking.\nVERDICT: FAIL');
    h.claude.complete('done');
    const exit = await done;
    expect(exit.reason).toBe('review'); // the ordinary rejection, not the escalation terminal
    expect(h.claude.continuations).toHaveLength(1); // the manifest's one round was spent, as today
  });

  it('an escalation token on a PASS changes nothing — the run reaches done (RUN-175)', async () => {
    const h = harness({ manifest: REVIEWED() });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onReviewTurn(h, 2);
    h.claude.emitText(
      'ESCALATE STRUCTURAL FINDING 1: everything — src/a.ts:1, src/b.ts:2, src/c.ts:3\nVERDICT: PASS',
    );
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('done');
  });

  it('maxRounds 0 is a pure gate: one review, no hand-back', async () => {
    const h = harness({ manifest: REVIEWED('npm test', { maxRounds: 0 }) });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onReviewTurn(h, 2);
    h.claude.emitText('VERDICT: FAIL');
    h.claude.complete('done');
    const exit = await done;
    expect(exit.reason).toBe('review');
    expect(h.claude.continuations).toEqual([]); // never handed back
    expect(h.claude.starts).toHaveLength(2); // build + exactly one reviewer
  });

  // A "continue a failed run" dispatch (PLNR-180/RUN-91) carries budget.maxRounds — a fresh
  // reviewer-round budget for the kept worktree — clamped by the repo's committed ceiling.
  const continueRun = (maxRounds: number) =>
    makeRun({
      kind: 'build',
      anchor: { type: 'task', taskId: 'task_9' },
      budget: { maxTokens: null, maxUsd: null, maxDurationSeconds: null, maxRounds },
    });

  it('budget.maxRounds narrows the reviewer rounds: 0 is a pure gate over a manifest that allows 2 (RUN-91)', async () => {
    const h = harness({ manifest: REVIEWED('npm test', { maxRounds: 2 }) });
    const done = h.supervisor.supervise(continueRun(0));
    await flush();
    h.claude.complete('done');
    await onReviewTurn(h, 2);
    h.claude.emitText('VERDICT: FAIL');
    h.claude.complete('done');
    const exit = await done;
    expect(exit.reason).toBe('review');
    expect(h.claude.continuations).toEqual([]); // dispatch said 0 → never handed back, despite manifest 2
    expect(h.claude.starts.filter((s) => s.runId === 'run_1:review')).toHaveLength(1);
  });

  it('budget.maxRounds cannot WIDEN past the manifest ceiling — the repo owner clamps it (RUN-91)', async () => {
    // The manifest allows one fix round; a continue asking for five gets one, not five.
    const h = harness({ manifest: REVIEWED('npm test', { maxRounds: 1 }), verifyResults: [true, true] });
    const done = h.supervisor.supervise(continueRun(5));
    await flush();
    h.claude.complete('done');
    await onReviewTurn(h, 2);
    h.claude.emitText('VERDICT: FAIL');
    h.claude.complete('done');
    await onReviewTurn(h, 3);
    h.claude.emitText('VERDICT: FAIL');
    h.claude.complete('done');
    const exit = await done;
    expect(exit.reason).toBe('review'); // gated after the manifest's single fix round, not five
    expect(h.claude.starts.filter((s) => s.runId === 'run_1:review')).toHaveLength(2); // initial + 1
  });

  // Continuation continuity (RUN-92): a re-dispatched failed run re-seeds from the record the prior
  // sitting left, so spend stays cumulative and the ledger is not relitigated.
  // Deliberately NO `subclaims` field (RUN-180): a prior sitting's persisted record can predate
  // sub-claims, and a continuation must load it as a single-claim entry (normalised on read)
  // rather than crash — so these seeds keep the pre-RUN-180 shape a real record on disk has.
  const priorLedgerEntry = {
    id: 1,
    round: 2,
    severity: 'high',
    requirements: [],
    location: 'src/auth.ts:42',
    claim: 'THE-PRIOR-FINDING-ABOUT-AUTH',
    status: 'fixed' as const,
    pointer: 'src/auth.ts:50',
    reason: 'guarded now',
  } as unknown as LedgerEntry;

  it('re-seeds the prior sitting spend so a continuation reports CUMULATIVE totals (RUN-92)', async () => {
    const seed: ContinuableRun = {
      runId: 'run_1',
      spent: { tokens: 1000, usd: 0.5 },
      ledger: [],
      failedAt: '2026-07-17T00:00:00.000Z',
    };
    const h = harness({ manifest: REVIEWED('npm test'), continuableSeed: seed, verifyResults: [true] });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done', { inputTokens: 40, costUsd: 0.1 }); // the build turn's spend
    await onReviewTurn(h, 2);
    h.claude.emitText('VERDICT: PASS');
    h.claude.complete('done', { inputTokens: 20, costUsd: 0.05 }); // the reviewer's spend
    await done;
    const terminal = h.reports.filter((r) => r.status === 'done').at(-1);
    // prior 1000 (seeded into inputTokens) + build 40 + reviewer 20 = 1060 — never a reset to 60.
    expect(terminal?.telemetry?.inputTokens).toBe(1060);
    expect(terminal?.telemetry?.costUsd).toBeCloseTo(0.65);
  });

  it('hands the prior adjudication ledger to the FIRST reviewer of a continuation (RUN-92)', async () => {
    const seed: ContinuableRun = {
      runId: 'run_1',
      spent: { tokens: 10, usd: 0 },
      ledger: [priorLedgerEntry],
      failedAt: '2026-07-17T00:00:00.000Z',
    };
    const h = harness({ manifest: REVIEWED('npm test'), continuableSeed: seed });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onReviewTurn(h, 2);
    // The very first review of the continuation already carries the settled finding — it verifies
    // the pointer instead of raising it fresh (the whole point of not relitigating).
    expect(h.claude.starts[1]?.prompt).toContain('THE-PRIOR-FINDING-ABOUT-AUTH');
    h.claude.emitText('VERDICT: PASS');
    h.claude.complete('done');
    await done;
  });

  it('records a continuable entry when a build gate-fails, and clears it when one passes (RUN-92)', async () => {
    // Fail: the reviewer refuses through its one fix round → gated, worktree kept, record written.
    const failed = harness({ manifest: REVIEWED('npm test', { maxRounds: 1 }), verifyResults: [true, true] });
    const runF = failed.supervisor.supervise(buildRun());
    await flush();
    failed.claude.complete('done');
    await onReviewTurn(failed, 2);
    failed.claude.emitText('FINDING 1 [high] src/auth.ts:9: the 401 path is untested\nVERDICT: FAIL');
    failed.claude.complete('done');
    await onReviewTurn(failed, 3);
    failed.claude.emitText('FINDING 1 [high] src/auth.ts:9: still untested\nVERDICT: FAIL');
    failed.claude.complete('done');
    // The terminal round FAILed — RUN-174's contest turn runs, but the builder streams no rebuttal,
    // so nothing is contested and the run gate-fails with the finding on the record (no re-review).
    await runF;
    const record = failed.continuable.puts.at(-1);
    expect(record?.runId).toBe('run_1');
    expect(record?.ledger.length).toBeGreaterThan(0); // the reviewer's finding is carried forward
    expect(failed.continuable.entries.has('run_1')).toBe(true);

    // The next sitting's transcript must number ABOVE everything this one wrote (RUN-183). The
    // server keys segments on (runId, seq) with INSERT OR IGNORE, so an overlap is not a clash —
    // it is silence, and a continued run showed a human nothing at all for 49 minutes.
    const highest = Math.max(...failed.transcript.map((s) => s.seq));
    expect(record?.lastLogSeq).toBeGreaterThan(highest);
    // Derived from the closed transcript rather than counted by the caller: closing FLUSHES what
    // was buffered and then appends a terminal milestone, so "one more than before" is not
    // reliably true and a caller that assumed it would hand out a number already used.
    expect(record?.lastLogSeq).toBe(highest + 1);

    // Pass: a build that satisfies the gate clears any record a prior failed sitting left.
    const seed: ContinuableRun = {
      runId: 'run_1',
      spent: { tokens: 5, usd: 0 },
      ledger: [priorLedgerEntry],
      failedAt: '2026-07-17T00:00:00.000Z',
    };
    const ok = harness({ manifest: REVIEWED('npm test'), continuableSeed: seed, verifyResults: [true] });
    const runP = ok.supervisor.supervise(buildRun());
    await flush();
    ok.claude.complete('done');
    await onReviewTurn(ok, 2);
    ok.claude.emitText('VERDICT: PASS');
    ok.claude.complete('done');
    await runP;
    expect(ok.continuable.entries.has('run_1')).toBe(false); // resolved → nothing left to continue
  });

  it('a sitting that CRASHES refreshes the record — history kept, tallies current', async () => {
    // The live incident: a continuation was killed minutes in, and the blanket remove threw away
    // the PRIOR sitting's spend, ledger and transcript position — the next continue started
    // blind, with three sittings of history gone. But "leave it untouched" is wrong in the other
    // direction: a stale record's spend undercounts the killed sitting (the next ceiling comes
    // out WIDER), and its lastLogSeq predates the terminal milestone (the next sitting's first
    // segments collide and vanish). Only a REFRESH loses neither.
    const seed: ContinuableRun = {
      runId: 'run_1',
      spent: { tokens: 5, usd: 0 },
      ledger: [priorLedgerEntry],
      lastLogSeq: 108,
      failedAt: '2026-07-17T00:00:00.000Z',
    };
    const h = harness({ continuableSeed: seed });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('failed', { outputTokens: 40 }); // died AFTER spending — driverSucceeded false
    await done;
    const kept = h.continuable.entries.get('run_1');
    expect(kept).toBeDefined();
    expect(kept?.ledger).toEqual([priorLedgerEntry]); // the prior adjudications survive
    // CUMULATIVE: seed 5 + this sitting's 40. A stale 5 would hand the next sitting the killed
    // sitting's 40 tokens back as fresh budget.
    expect(kept?.spent.tokens).toBe(45);
    // ADVANCED: the terminal milestone was written above 108, so a record still saying 108 would
    // point the next sitting into rows that already exist.
    expect(kept?.lastLogSeq).toBeGreaterThan(108);
  });

  it('a crashed run whose workspace still holds work KEEPS it — never force-delete the only copy', async () => {
    // driverSucceeded alone was the dispose test, and it destroyed real work: a killed
    // continuation reads as "driver did not succeed", but its workspace carries every prior
    // sitting's committed diff on a branch nothing else references. The backend is ASKED now.
    const h = harness({}); // changed=true: the workspace has work
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('failed');
    await done;
    expect(h.worktrees.created.length).toBe(1); // it leased — the assertion below is not vacuous
    expect(h.worktrees.removed).toEqual([]); // kept for a human, exactly like a gate-fail
    // (the empty-tree cleanup half lives in 'build failure with NOTHING in the tree' above)
  });

  it('a probe that cannot answer errs toward KEEPING the workspace', async () => {
    // A kept empty worktree costs a warning at the next startup sweep; a disposed full one costs
    // the work. The same fail-closed direction as RUN-152's no-changes probe.
    const h = harness({});
    h.worktrees.hasWorkError = 'git exploded';
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('failed');
    await done;
    expect(h.worktrees.removed).toEqual([]);
  });

  // RUN-130: the write half of the predictive lock source. What this sitting changed becomes the
  // continuation's declared scope, so the paths are taken BEFORE the retry respawns rather than
  // discovered at the post-build floor after paying for the work again.
  it('records what the failed sitting changed, as the continuation’s declared lock scope', async () => {
    const h = harness({ verifyPasses: false });
    h.worktrees.changedFiles = ['src/a.ts', 'src/b.ts'];
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    expect((await done).outcome).toBe('failed');
    expect(h.continuable.entries.get('run_1')?.changedPaths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('records no scope when the sitting changed nothing the backend can name', async () => {
    const h = harness({ verifyPasses: false });
    h.worktrees.changedFiles = [];
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await done;
    expect(h.continuable.entries.get('run_1')?.changedPaths).toBeUndefined();
  });

  it('a reviewer with no verdict still GATES the run — but as no-judgment, never as a refusal (RUN-72)', async () => {
    const h = harness({ manifest: REVIEWED('npm test', { maxRounds: 0 }) });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onReviewTurn(h, 2);
    h.claude.emitText('It seems mostly fine, I think?');
    h.claude.complete('done');
    const exit = await done;
    // The adversarial default holds — silence must not read as a pass — but the reason and
    // the comment say the gate never judged, not that the work was found wanting.
    expect(exit.reason).toBe('review:no-verdict');
    expect(h.comments.at(-1)?.body).toMatch(/NO verdict/);
    expect(h.comments.at(-1)?.body).not.toMatch(/does not satisfy the intent/);
  });

  it('a KILLED reviewer is not a refusal: no fix rounds burn, and the comment blames the gate (RUN-72)', async () => {
    // The dogfood incident: a human killed a hung codex reviewer, and the daemon logged
    // "reviewer refused the work — handing the report to the live agent" with verdict
    // 'unknown' — then spent a builder turn fixing findings that did not exist.
    const h = harness({ manifest: REVIEWED('npm test', { maxRounds: 2 }) });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done'); // the build turn
    await onReviewTurn(h, 2);
    h.claude.complete('failed'); // the reviewer session dies — SIGTERM, crash, budget breach
    const exit = await done;
    expect(exit.outcome).toBe('failed');
    expect(exit.reason).toBe('review:no-verdict');
    expect(h.claude.continuations).toEqual([]); // NO feedback turn against a non-report
    expect(h.claude.starts).toHaveLength(2); // build + the one dead reviewer — no re-review either
    expect(h.comments.at(-1)?.body).toMatch(/rendered NO verdict/);
    expect(h.worktrees.removed).toEqual([]); // the diff is kept — nothing judged it wanting
  });

  it('a failing cmd floor screens the work before any reviewer spends a token', async () => {
    const h = harness({ manifest: REVIEWED(), verifyPasses: false });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    const exit = await done;
    expect(exit.reason).toBe('verify'); // the floor's verdict, not the reviewer's
    expect(h.claude.starts.filter((s) => s.runId === 'run_1:review')).toHaveLength(0);
  });

  it('reviewer-only (no cmd): the reviewer IS the gate, and no verify command runs', async () => {
    const h = harness({ manifest: REVIEWED(null) });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onReviewTurn(h, 2);
    expect(h.claude.starts[1]?.prompt).not.toMatch(/already passed/); // no floor to mention
    h.claude.emitText('VERDICT: PASS');
    h.claude.complete('done');
    expect((await done).outcome).toBe('done');
    expect(h.verifyRan()).toBe(false);
  });

  it('no [verify] at all: no gate, no multiTurn, the human is the boundary', async () => {
    const h = harness({ manifest: manifest({ verify: null }) });
    const done = h.supervisor.supervise(makeRun({ kind: 'build' }));
    await flush();
    expect(h.claude.starts[0]?.multiTurn).toBe(false);
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('done');
    expect(h.verifyRan()).toBe(false);
    expect(h.claude.starts).toHaveLength(1);
  });

  it('hands the driver a sanitized env — stripping is a supervisor guarantee (RUN-109)', async () => {
    const prev = process.env.NORIQ_TOKEN;
    process.env.NORIQ_TOKEN = 'super-secret-daemon-token';
    try {
      const h = harness({ manifest: manifest({ verify: null }) });
      const done = h.supervisor.supervise(makeRun({ kind: 'build' }));
      await flush();
      const env = h.claude.starts[0]?.env;
      expect(env).toBeDefined();
      // the daemon's OAuth token never reaches the agent's shell — regardless of driver
      expect(env?.NORIQ_TOKEN).toBeUndefined();
      // git can neither prompt nor push with a credential helper
      expect(env?.GIT_TERMINAL_PROMPT).toBe('0');
      expect(env?.GIT_ASKPASS).toBe('/bin/false');
      h.claude.complete('done');
      await done;
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, 'NORIQ_TOKEN');
      else process.env.NORIQ_TOKEN = prev;
    }
  });

  it('with [land]: the reviewer judges intent BEFORE landing, and a PASS lands', async () => {
    const h = harness({
      manifest: {
        ...LANDING(),
        verify: {
          cmd: 'npm test',
          timeoutSeconds: null,
          shell: null,
          maxRounds: 2,
          agent: { agent: null, tool: null, model: null, effort: null, maxRounds: 2 },
        },
      },
    });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onReviewTurn(h, 2);
    expect(h.worktrees.landings).toHaveLength(0); // nothing landed yet — review comes first
    h.claude.emitText('VERDICT: PASS');
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('done');
    expect(h.worktrees.landings).toHaveLength(1);
  });

  it('with [land]: a reviewer rejection means nothing lands', async () => {
    const h = harness({
      manifest: {
        ...LANDING(),
        verify: {
          cmd: 'npm test',
          timeoutSeconds: null,
          shell: null,
          maxRounds: 2,
          agent: { agent: null, tool: null, model: null, effort: null, maxRounds: 0 },
        },
      },
    });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onReviewTurn(h, 2);
    h.claude.emitText('VERDICT: FAIL');
    h.claude.complete('done');
    const exit = await done;
    expect(exit.reason).toBe('review');
    expect(h.worktrees.landings).toHaveLength(0);
    expect(h.worktrees.removed).toEqual([]); // the unlanded diff waits for a human
  });

  it('runs the reviewer on a DIFFERENT driver when [verify.agent].tool says so (RUN-70)', async () => {
    const h = harness({ manifest: REVIEWED('npm test', { tool: 'codex', model: 'gpt-5.6-sol' }) });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done'); // the build turn, on claude
    for (let i = 0; i < 100 && h.codex.opts?.runId !== 'run_1:review'; i++) await flush();
    // A different vendor's model judging the work — the strongest form of independence.
    const review = h.codex.opts;
    expect(review?.runId).toBe('run_1:review');
    expect(review?.kind).toBe('verify');
    expect(review?.model).toBe('gpt-5.6-sol');
    expect(review?.noriqMcp).toBeUndefined(); // no credential on ANY driver
    expect(h.claude.starts.filter((s) => s.runId === 'run_1:review')).toHaveLength(0);
    h.codex.emitText('VERDICT: PASS');
    h.codex.complete('done');
    expect((await done).outcome).toBe('done');
  });

  it('a reviewer tool with no driver fails CLOSED — never a silent same-vendor review', async () => {
    const claudeOnly = new FakeDriver('claude');
    const h = harness({
      manifest: REVIEWED('npm test', { tool: 'codex' }),
      drivers: { claude: claudeOnly },
    });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    claudeOnly.complete('done');
    const exit = await done;
    // A missing driver is the gate failing to exist, not the work failing review (RUN-72).
    expect(exit.reason).toBe('review:no-verdict');
    expect(h.comments.at(-1)?.body).toMatch(/no such driver/);
    expect(claudeOnly.starts.filter((s) => s.runId === 'run_1:review')).toHaveLength(0);
  });

  it('naming a tool severs the [defaults.verify].model fallback — model names are vendor-specific', async () => {
    const m = REVIEWED('npm test', { tool: 'codex' });
    m.defaults.verify = { agent: null, model: 'claude-sonnet-5', effort: 'high' }; // the OTHER vendor's model
    const h = harness({ manifest: m });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    for (let i = 0; i < 100 && h.codex.opts?.runId !== 'run_1:review'; i++) await flush();
    expect(h.codex.opts?.model).toBeUndefined(); // codex's own default, not claude-sonnet-5
    expect(h.codex.opts?.effort).toBe('high'); // effort is tool-agnostic intent; it survives
    h.codex.emitText('VERDICT: PASS');
    h.codex.complete('done');
    await done;
  });

  it('the reviewer model falls back to [defaults.verify] when the agent block names none', async () => {
    const m = REVIEWED();
    m.defaults.verify = { agent: null, model: 'claude-sonnet-5', effort: 'xhigh' };
    const h = harness({ manifest: m });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onReviewTurn(h, 2);
    expect(h.claude.starts[1]?.model).toBe('claude-sonnet-5');
    expect(h.claude.starts[1]?.effort).toBe('xhigh');
    h.claude.emitText('VERDICT: PASS');
    h.claude.complete('done');
    await done;
  });
});

// RUN-174. Both the RUN-66 and RUN-88 dogfood runs died in the TERMINAL review — the round with no
// fix budget behind it — on findings raised there for the first time, neither fixable NOR
// contestable. The contest turn is the one answer such a finding could still get: one builder turn
// to CONTEST with a pointer (no code change), then a fresh reviewer judges the same diff plus that
// evidence. It is not another fix round, and it can never cost a run that had nothing to spend.
describe('the terminal-round contest turn (RUN-174)', () => {
  const REVIEWED = (maxRounds = 0, cmd: string | null = 'npm test') =>
    manifest({
      verify: {
        cmd,
        timeoutSeconds: null,
        shell: null,
        maxRounds,
        agent: { agent: null, tool: null, model: null, effort: null, maxRounds },
      },
    });
  const buildRun = () => makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } });
  const onReviewTurn = async (h: ReturnType<typeof harness>, atLeastStarts: number) => {
    for (let i = 0; i < 300; i++) {
      if (h.claude.opts?.runId === 'run_1:review' && h.claude.starts.length >= atLeastStarts) return;
      await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error(`the reviewer session (>= ${atLeastStarts} starts) never began`);
  };

  /** Build → terminal reviewer FAILs with one finding → the builder's contest turn streams
   *  `contest` (null = stays silent) → the run settles. For the cases where the contest does NOT
   *  earn a re-review, so `done` resolves without a second reviewer to drive. */
  const terminalContestFails = async (contest: string | null) => {
    const h = harness({ manifest: REVIEWED(), verifyResults: [true] });
    if (contest !== null) h.claude.continueTexts = [contest];
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done'); // build turn
    await onReviewTurn(h, 2);
    h.claude.emitText('FINDING 1 [High] src/a.ts:1: the guard is missing\nVERDICT: FAIL');
    h.claude.complete('done'); // terminal reviewer FAILs
    const exit = await done;
    return { h, exit };
  };
  const reviewerStarts = (h: ReturnType<typeof harness>) =>
    h.claude.starts.filter((s) => s.runId === 'run_1:review').length;

  it('a contested terminal finding a fresh reviewer clears PASSES the run', async () => {
    const h = harness({ manifest: REVIEWED(), verifyResults: [true] });
    // The builder points at evidence the finding is wrong — no code change.
    h.claude.continueTexts = ['FINDING 1: CONTESTED src/a.ts:9 — the guard already covers this'];
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done'); // build turn
    await onReviewTurn(h, 2);
    h.claude.emitText('FINDING 1 [High] src/a.ts:1: the guard is missing\nVERDICT: FAIL');
    h.claude.complete('done'); // terminal reviewer FAILs
    // The contest turn (a continuation of the live builder) runs, then a FRESH reviewer looks once
    // more — it is starts[2], not another fix turn.
    await onReviewTurn(h, 3);
    expect(h.claude.continuations.some((c) => /contest/i.test(c))).toBe(true);
    // The fresh reviewer got the builder's pointer as ledger evidence to verify for itself.
    const readjudged = h.claude.starts[2]!.prompt;
    expect(readjudged).toMatch(/PRIOR ADJUDICATIONS/);
    expect(readjudged).toContain('CONTESTED (src/a.ts:9)');
    h.claude.emitText('The pointer holds — out of scope.\nVERDICT: PASS');
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('done'); // the contest cleared the finding
    expect(h.claude.starts.filter((s) => s.runId === 'run_1:review')).toHaveLength(2); // one extra look
  });

  it('a terminal finding that survives the contest still fails the run, and never checkpoints', async () => {
    const h = harness({ manifest: REVIEWED(), verifyResults: [true] });
    h.claude.continueTexts = ['FINDING 1: CONTESTED src/a.ts:9 — pre-existing'];
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onReviewTurn(h, 2);
    h.claude.emitText('FINDING 1 [High] src/a.ts:1: the guard is missing\nVERDICT: FAIL');
    h.claude.complete('done');
    await onReviewTurn(h, 3);
    h.claude.emitText('The pointer does not hold.\nVERDICT: FAIL'); // the finding stands
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('failed');
    expect(exit.reason).toBe('review');
    expect(h.comments.at(-1)?.body).toMatch(/does not satisfy the intent/);
    // The "may NOT change code" rule: the contest turn adds NO checkpoint (a FIX round folds one in
    // as "reviewer fix round N" so the fresh reviewer sees the change), so the re-adjudication read
    // the same diff the terminal round judged — only the one pre-review checkpoint was taken.
    expect(h.worktrees.commits.some((c) => /fix round/i.test(c.message))).toBe(false);
    expect(h.worktrees.commits.filter((c) => /pre-review checkpoint/i.test(c.message))).toHaveLength(1);
    expect(h.worktrees.removed).toEqual([]); // the diff is kept for a human
  });

  // RUN-175: the contest's fresh adjudicator is a reviewer round like any other, so an honoured
  // escalation it raises must ride out — not be replaced by the pre-contest verdict, which would
  // report the one run a reviewer proved unconvergeable as a plain rejection, diagnosis unread.
  it('an honoured escalation from the contest’s fresh reviewer fail-fasts with the diagnosis (RUN-175)', async () => {
    const h = harness({ manifest: REVIEWED(), verifyResults: [true] });
    h.claude.continueTexts = ['FINDING 1: CONTESTED src/a.ts:9 — the guard already covers this'];
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done'); // build turn
    await onReviewTurn(h, 2);
    h.claude.emitText('FINDING 1 [High] src/a.ts:1: the guard is missing\nVERDICT: FAIL');
    h.claude.complete('done'); // terminal reviewer FAILs, token-free — the contest turn runs
    await onReviewTurn(h, 3);
    h.claude.emitText(
      [
        'FINDING 1 [High] src/a.ts:1: the guard floor is re-derived per site — also src/b.ts:2 and src/c.ts:3',
        'ESCALATE STRUCTURAL FINDING 1: no single chokepoint enforces the guard floor — src/a.ts:1, src/b.ts:2, src/c.ts:3',
        'VERDICT: FAIL',
      ].join('\n'),
    );
    h.claude.complete('done'); // the fresh adjudicator escalates instead of merely re-raising
    const exit = await done;
    expect(exit.outcome).toBe('failed');
    expect(exit.reason).toBe('review:structural'); // not the plain 'review' rejection
    const body = h.comments.at(-1)?.body ?? '';
    expect(body).toMatch(/STRUCTURALLY unconvergeable/);
    expect(body).toContain('no single chokepoint enforces the guard floor'); // the diagnosis surfaced
  });

  // The leak the RUN-174 gate closes: a fresh re-review is not a free reroll of the verdict. Unless
  // the builder actually CONTESTED a finding with a checkable pointer, the finding stands and NO
  // reviewer is spawned to possibly-PASS over it (criterion 4).
  it('a terminal finding nobody contests stands — no fresh reviewer re-rolls the verdict', async () => {
    const { h, exit } = await terminalContestFails(null); // the builder streams no rebuttal
    expect(exit.outcome).toBe('failed');
    expect(exit.reason).toBe('review');
    expect(h.claude.continuations).toHaveLength(1); // the contest turn DID happen…
    expect(reviewerStarts(h)).toBe(1); // …but no re-review followed a non-contest
  });

  it('a FIXED response cannot clear a terminal finding — nothing was changed to fix', async () => {
    const { h, exit } = await terminalContestFails('FINDING 1: FIXED src/a.ts:9 — added the guard');
    expect(exit.outcome).toBe('failed');
    expect(reviewerStarts(h)).toBe(1); // a FIXED is not a contest → no re-review
  });

  it('a CONTESTED with no checkable pointer cannot clear a terminal finding', async () => {
    const { h, exit } = await terminalContestFails('FINDING 1: CONTESTED'); // no pointer given
    expect(exit.outcome).toBe('failed');
    expect(reviewerStarts(h)).toBe(1); // self-assertion with no pointer → no re-review
  });

  // RUN-179: a contest that CONTESTS with a checkable pointer but names a finding id NO terminal
  // finding carries (`FINDING 99` against a single `FINDING 1`) clears the eligibility filter's
  // pointer bar yet leaves the real finding uncontested — so it must NOT buy a fresh adjudicator
  // whose stochastic PASS could clear the run over unchanged code. Same re-roll the pointer/FIXED
  // cases deny, one level up.
  it('a CONTESTED naming an unknown finding id cannot buy a re-adjudication', async () => {
    const { h, exit } = await terminalContestFails('FINDING 99: CONTESTED src/a.ts:9 — not a real finding');
    expect(exit.outcome).toBe('failed'); // FINDING 1 was never answerably contested → it stands
    expect(reviewerStarts(h)).toBe(1); // an unknown id contested → no fresh adjudicator spawned
  });

  it('a contest that answers only SOME terminal findings still fails the run', async () => {
    const h = harness({ manifest: REVIEWED(), verifyResults: [true] });
    // Two findings, one contested with a pointer, the other left unanswered.
    h.claude.continueTexts = ['FINDING 1: CONTESTED src/a.ts:9 — pre-existing'];
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onReviewTurn(h, 2);
    h.claude.emitText(
      'FINDING 1 [High] src/a.ts:1: guard A missing\nFINDING 2 [High] src/b.ts:1: guard B missing\nVERDICT: FAIL',
    );
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('failed'); // finding 2 was never contested → it stands
    expect(reviewerStarts(h)).toBe(1); // not every finding contested → no re-review
  });

  // RUN-180: the same partial answer WITHIN one finding's sub-claims — the run_ms4t62384u0z6c6p4f5d
  // escape. A bundled finding was "contested" by rebutting the refutable half; the other half rode
  // the answer out. With the halves enumerated, a contest that names only one letter leaves the
  // other STANDING, and the finding is not a candidate to clear — no fresh adjudicator to re-roll.
  it('a contest answering only SOME of one finding’s sub-claims fails the run without a re-review', async () => {
    const h = harness({ manifest: REVIEWED(), verifyResults: [true] });
    h.claude.continueTexts = ['FINDING 1b: CONTESTED src/adjudication.ts:248 — slice keeps the most recent'];
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onReviewTurn(h, 2);
    h.claude.emitText(
      [
        'FINDING 1 [High] src/gate.ts:1: the gate bundles two separately-answerable defects [sub-claims: 2]',
        'FINDING 1a: the eligibility check accepts a response naming a nonexistent finding',
        'FINDING 1b: the entry cap can drop a terminal finding before a PASS',
        'VERDICT: FAIL',
      ].join('\n'),
    );
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('failed'); // sub-claim (a) was never contested → the finding stands
    expect(reviewerStarts(h)).toBe(1); // …and no fresh adjudicator was spawned to possibly-PASS over it
    // The ledger records WHICH sub-claim went unanswered — by its claim text, the identity the
    // record keys on (letters are render-derived) — not a finding answered-as-a-whole.
    const entry = h.continuable.puts.at(-1)?.ledger.find((e) => e.id === 1);
    expect(entry?.subclaims?.map((s) => [s.claim, s.status])).toEqual([
      ['the eligibility check accepts a response naming a nonexistent finding', 'unanswered'],
      ['the entry cap can drop a terminal finding before a PASS', 'contested'],
    ]);
    // The contest prompt carried the record: the letters the RESPONSE block answers by.
    expect(h.claude.continuations.at(-1)).toContain(
      '(a) the eligibility check accepts a response naming a nonexistent finding — no answer recorded',
    );
  });

  // …and the bare-number answer is the escape verbatim: a whole-finding CONTESTED must not speak
  // for letters it never named.
  it('a bare CONTESTED cannot clear a finding that enumerated sub-claims', async () => {
    const { h, exit } = await (async () => {
      const h = harness({ manifest: REVIEWED(), verifyResults: [true] });
      h.claude.continueTexts = ['FINDING 1: CONTESTED src/a.ts:9 — the whole thing is wrong'];
      const done = h.supervisor.supervise(buildRun());
      await flush();
      h.claude.complete('done');
      await onReviewTurn(h, 2);
      h.claude.emitText(
        'FINDING 1 [High] src/gate.ts:1: two bundled defects [sub-claims: 2]\nFINDING 1a: half one\nFINDING 1b: half two\nVERDICT: FAIL',
      );
      h.claude.complete('done');
      return { h, exit: await done };
    })();
    expect(exit.outcome).toBe('failed');
    expect(reviewerStarts(h)).toBe(1); // a bare answer credits no sub-claim → no re-review
  });

  // Candidacy reads the RECONCILED ledger entry, not the terminal round's own parse: the fold
  // preserves held sub-claims when a re-raise drops the letters (a fresh reviewer paraphrases by
  // construction), so a letterless terminal re-raise of a half-answered finding still carries its
  // unanswered claim — and a bare contest must not clear it. Checking `f.subclaims` (empty on
  // this path) was the RUN-174 escape reborn one round later.
  it('a letterless re-raise of a half-answered finding is no candidate — the carried letter stands', async () => {
    const h = harness({ manifest: REVIEWED(1), verifyResults: [true, true] });
    h.claude.continueTexts = [
      // The fix turn answers only the refutable half…
      'FINDING 1b: CONTESTED src/y.ts:3 — slice keeps the most recent',
      // …and the contest turn answers the letterless re-raise with a bare whole-finding contest.
      'FINDING 1: CONTESTED src/a.ts:9 — the whole finding is wrong',
    ];
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done'); // build turn
    await onReviewTurn(h, 2);
    h.claude.emitText(
      [
        'FINDING 1 [High] src/gate.ts:1: two bundled defects [sub-claims: 2]',
        'FINDING 1a: half one',
        'FINDING 1b: half two',
        'VERDICT: FAIL',
      ].join('\n'),
    );
    h.claude.complete('done'); // round 1 letters the finding
    await onReviewTurn(h, 3); // fix turn ran (answering only 1b), floor re-ran, round 2 starts
    // The TERMINAL reviewer re-raises the same finding WITHOUT the letters.
    h.claude.emitText('FINDING 1 [High] src/gate.ts:1: two bundled defects\nVERDICT: FAIL');
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('failed'); // carried sub-claim 'half one' was never contested → it stands
    expect(reviewerStarts(h)).toBe(2); // round 1 + terminal — no fresh adjudicator to possibly-PASS
    // The ledger records the half-answered state the candidacy check read.
    const entry = h.continuable.puts.at(-1)?.ledger.find((e) => e.id === 1);
    expect(entry?.subclaims?.map((s) => [s.claim, s.status])).toEqual([
      ['half one', 'unanswered'],
      ['half two', 'contested'],
    ]);
  });

  // The fold-level edition of the same escape: a terminal re-raise that repeats only SOME of the
  // held claims used to REPLACE the held set, so the unanswered claim vanished from the
  // reconciled entry and a contest of the repeated claim alone could clear the finding. The fold
  // now unions the uncovered claim in — matched by wording, the sub-claim's identity — and
  // candidacy, reading the reconciled entry, keeps the finding standing on it.
  it('a terminal re-raise repeating only some letters is no candidate — the uncovered claim stands', async () => {
    const h = harness({ manifest: REVIEWED(1), verifyResults: [true, true] });
    h.claude.continueTexts = [
      // The fix turn answers only the refutable half…
      'FINDING 1b: CONTESTED src/y.ts:3 — slice keeps the most recent',
      // …and the contest turn contests the ONE letter the terminal round chose to repeat.
      'FINDING 1a: CONTESTED src/y.ts:3 — slice keeps the most recent',
    ];
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done'); // build turn
    await onReviewTurn(h, 2);
    h.claude.emitText(
      [
        'FINDING 1 [High] src/gate.ts:1: two bundled defects [sub-claims: 2]',
        'FINDING 1a: half one',
        'FINDING 1b: half two',
        'VERDICT: FAIL',
      ].join('\n'),
    );
    h.claude.complete('done'); // round 1 letters the finding; the fix turn contests only (b)
    await onReviewTurn(h, 3);
    // The TERMINAL reviewer re-raises the finding but letters ONLY the already-rebutted claim.
    h.claude.emitText(
      [
        'FINDING 1 [High] src/gate.ts:1: two bundled defects [sub-claims: 1]',
        'FINDING 1a: half two',
        'VERDICT: FAIL',
      ].join('\n'),
    );
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('failed'); // the uncovered claim was never contested → it stands
    expect(reviewerStarts(h)).toBe(2); // round 1 + terminal — no fresh adjudicator to possibly-PASS
    // The reconciled entry carries the uncovered claim — behind the re-raise's own enumeration in
    // the record's order, visibly unanswered.
    const entry = h.continuable.puts.at(-1)?.ledger.find((e) => e.id === 1);
    expect(entry?.subclaims?.map((s) => [s.claim, s.status])).toEqual([
      ['half two', 'contested'],
      ['half one', 'unanswered'],
    ]);
  });

  // A carried FIXED sub-claim blocks candidacy — the whole-finding rule ("a FIXED changed nothing
  // here") at sub-claim grain: the terminal reviewer judged the diff WITH the fix in it and still
  // failed, so "it is fixed" was already adjudicated and never buys the re-roll.
  it('a carried FIXED sub-claim stands — a bare contest cannot clear over it', async () => {
    const h = harness({ manifest: REVIEWED(1), verifyResults: [true, true] });
    h.claude.continueTexts = [
      'FINDING 1a: FIXED src/f.ts:1 — added the guard\nFINDING 1b: CONTESTED src/y.ts:3 — covered',
      'FINDING 1: CONTESTED src/a.ts:9 — the whole finding is wrong',
    ];
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done'); // build turn
    await onReviewTurn(h, 2);
    h.claude.emitText(
      'FINDING 1 [High] src/gate.ts:1: two bundled defects [sub-claims: 2]\nFINDING 1a: half one\nFINDING 1b: half two\nVERDICT: FAIL',
    );
    h.claude.complete('done'); // round 1; the fix turn FIXes (a), contests (b)
    await onReviewTurn(h, 3);
    h.claude.emitText('FINDING 1 [High] src/gate.ts:1: two bundled defects\nVERDICT: FAIL'); // letterless
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('failed'); // the FIXED letter is not a contest → the finding stands
    expect(reviewerStarts(h)).toBe(2); // no fresh adjudicator spawned
  });

  // …but it is not a dead end: the builder who believes the fixed claim no longer holds CONTESTS
  // it in the contest turn, at the letter the contest record shows for its position — the fold
  // resolves a letter past the report's own lines against exactly those positions — and the
  // finding earns the fresh look like any other full contest.
  it('contesting the carried FIXED sub-claim this turn restores candidacy', async () => {
    const h = harness({ manifest: REVIEWED(1), verifyResults: [true, true] });
    h.claude.continueTexts = [
      'FINDING 1a: FIXED src/f.ts:1 — added the guard\nFINDING 1b: CONTESTED src/y.ts:3 — covered',
      'FINDING 1a: CONTESTED src/f.ts:1 — the guard landed; the claim no longer holds\n' +
        'FINDING 1: CONTESTED src/a.ts:9 — nothing in this finding survives the diff',
    ];
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done'); // build turn
    await onReviewTurn(h, 2);
    h.claude.emitText(
      'FINDING 1 [High] src/gate.ts:1: two bundled defects [sub-claims: 2]\nFINDING 1a: half one\nFINDING 1b: half two\nVERDICT: FAIL',
    );
    h.claude.complete('done'); // round 1; the fix turn FIXes (a), contests (b)
    await onReviewTurn(h, 3);
    h.claude.emitText('FINDING 1 [High] src/gate.ts:1: two bundled defects\nVERDICT: FAIL'); // letterless
    h.claude.complete('done'); // terminal FAIL → contest turn flips (a) to CONTESTED → fresh look
    await onReviewTurn(h, 4);
    h.claude.emitText('Both pointers hold.\nVERDICT: PASS');
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('done');
    expect(reviewerStarts(h)).toBe(3); // rounds 1, terminal, and the contest's fresh look
  });

  // The candidacy contract is the RECONCILED entry alone (criterion: every sub-claim contested and
  // visible, or the finding stands) — the terminal report's own shape is never a second gate. The
  // contest prompt tells the builder an already-contested record claim needs no fresh answer, so a
  // letterless re-raise answered through the record's letters THIS turn must clear without a bare
  // response beside it: demanding one would fail the exact builder that followed the prompt.
  it('a letterless re-raise contested through the record’s letters alone earns the fresh look', async () => {
    const h = harness({ manifest: REVIEWED(1), verifyResults: [true, true] });
    h.claude.continueTexts = [
      // The fix turn answers only the refutable half…
      'FINDING 1b: CONTESTED src/y.ts:3 — slice keeps the most recent',
      // …and the contest turn contests the standing half by its record letter — no bare response.
      'FINDING 1a: CONTESTED src/x.ts:9 — the id filter covers it',
    ];
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done'); // build turn
    await onReviewTurn(h, 2);
    h.claude.emitText(
      'FINDING 1 [High] src/gate.ts:1: two bundled defects [sub-claims: 2]\nFINDING 1a: half one\nFINDING 1b: half two\nVERDICT: FAIL',
    );
    h.claude.complete('done'); // round 1 letters the finding; the fix turn contests only (b)
    await onReviewTurn(h, 3);
    h.claude.emitText('FINDING 1 [High] src/gate.ts:1: two bundled defects\nVERDICT: FAIL'); // letterless
    h.claude.complete('done'); // terminal FAIL → contest turn flips (a) to CONTESTED → fresh look
    await onReviewTurn(h, 4);
    h.claude.emitText('Both pointers hold.\nVERDICT: PASS');
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('done'); // every reconciled sub-claim contested → candidate, no bare needed
    expect(reviewerStarts(h)).toBe(3); // rounds 1, terminal, and the contest's fresh look
  });

  // …and the same clearing holds when every carried claim already holds a rebuttal: the reconciled
  // entry shows each sub-claim contested, the bare contest folds in as whole-finding evidence, and
  // the fresh look adjudicates the carried pointers.
  it('a letterless re-raise whose carried claims are all contested can still earn the fresh look', async () => {
    const h = harness({ manifest: REVIEWED(1), verifyResults: [true, true] });
    h.claude.continueTexts = [
      'FINDING 1a: CONTESTED src/x.ts:9 — the id filter covers it\nFINDING 1b: CONTESTED src/y.ts:3 — slice keeps the most recent',
      'FINDING 1: CONTESTED src/a.ts:9 — both halves already rebutted',
    ];
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done'); // build turn
    await onReviewTurn(h, 2);
    h.claude.emitText(
      'FINDING 1 [High] src/gate.ts:1: two bundled defects [sub-claims: 2]\nFINDING 1a: half one\nFINDING 1b: half two\nVERDICT: FAIL',
    );
    h.claude.complete('done'); // round 1 letters the finding; the fix turn contests BOTH letters
    await onReviewTurn(h, 3);
    h.claude.emitText('FINDING 1 [High] src/gate.ts:1: two bundled defects\nVERDICT: FAIL'); // letterless
    h.claude.complete('done'); // terminal FAIL → contest turn → candidacy holds → fresh look
    await onReviewTurn(h, 4);
    // The adjudicator sees the carried per-letter rebuttals, not an answered-as-a-whole row.
    const readjudged = h.claude.starts[3]!.prompt;
    expect(readjudged).toContain('CONTESTED (src/x.ts:9)');
    expect(readjudged).toContain('CONTESTED (src/y.ts:3)');
    h.claude.emitText('Both pointers hold.\nVERDICT: PASS');
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('done');
    expect(reviewerStarts(h)).toBe(3); // rounds 1, terminal, and the contest's fresh look
  });

  // Held sub-claim state rides only a match that cannot be an invention. The prose rule matches
  // entries on a 60-char claim prefix — legacy identity, unchanged — but two long claims that
  // diverge past it can be two REAL findings, and inheriting one's contested letters let the
  // other reach the fresh look on contests nobody made about its claim. The record drops with the
  // replaced claim instead (a visible miss, never an invented credit), the entry is single-claim,
  // and the pre-RUN-180 rule demands a contest THIS turn.
  it('a prefix-aliased terminal re-raise does not inherit contested letters — no free fresh look', async () => {
    const h = harness({ manifest: REVIEWED(1), verifyResults: [true, true] });
    const prefix = 'the candidacy gate accepts inherited contests as if this claim had been examined ';
    h.claude.continueTexts = [
      // The fix turn contests BOTH letters of round 1's finding…
      'FINDING 1a: CONTESTED src/x.ts:9 — the id filter covers it\nFINDING 1b: CONTESTED src/y.ts:3 — slice keeps the most recent',
      // …and the contest turn says nothing at all.
    ];
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done'); // build turn
    await onReviewTurn(h, 2);
    h.claude.emitText(
      [
        `FINDING 1 [High] src/gate.ts:1: ${prefix}in round one [sub-claims: 2]`,
        'FINDING 1a: half one',
        'FINDING 1b: half two',
        'VERDICT: FAIL',
      ].join('\n'),
    );
    h.claude.complete('done'); // round 1 letters the finding; the fix turn contests both
    await onReviewTurn(h, 3);
    // The TERMINAL claim shares the 60-char prefix but diverges past it — a different claim that
    // the prose key nonetheless matches to the same entry. Letterless, and no requirement bracket.
    h.claude.emitText(`FINDING 1 [High] src/gate.ts:1: ${prefix}never at all\nVERDICT: FAIL`);
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('failed'); // no current contest → the aliased finding stands
    expect(reviewerStarts(h)).toBe(2); // …and no fresh adjudicator was spawned on inherited letters
    // The entry merged (prefix identity, as it always did) but the contested record did not ride.
    const entry = h.continuable.puts.at(-1)?.ledger.find((e) => e.id === 1);
    expect(entry?.claim).toContain('never at all');
    expect(entry?.subclaims).toEqual([]);
  });

  // The record's letters are what the contest resolves against — even where the terminal report's
  // own lettering diverges, which is exactly the overflow path: the fold keeps the held set whole
  // and drops the report's enumeration, so the record shows letters for claims the report never
  // lettered. Answering those letters must credit the displayed claims, not be discarded against
  // the dropped enumeration (the prompt calls the record authoritative; the code must agree).
  it('contesting an overflowed record by its displayed letters earns the fresh look', async () => {
    const h = harness({ manifest: REVIEWED(2), verifyResults: [true, true, true] });
    const finding = (tag: string) =>
      [
        'FINDING 1 [High] src/gate.ts:1: the gate bundles many claims [sub-claims: 4]',
        ...['a', 'b', 'c', 'd'].map((l, i) => `FINDING 1${l}: ${tag} claim ${i + 1}`),
        'VERDICT: FAIL',
      ].join('\n');
    h.claude.continueTexts = [
      '', // fix turn 1: no structured response — every letter stays unanswered
      '', // fix turn 2: same
      // The contest answers every letter THE RECORD shows: (a)–(h) label the eight HELD claims
      // (rounds one and two), the terminal enumeration having been dropped by the overflow.
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
        .map((l) => `FINDING 1${l}: CONTESTED src/${l}.ts:1 — the record claim does not hold`)
        .join('\n'),
    ];
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done'); // build turn
    await onReviewTurn(h, 2);
    h.claude.emitText(finding('one'));
    h.claude.complete('done'); // round 1: four letters
    await onReviewTurn(h, 3);
    h.claude.emitText(finding('two'));
    h.claude.complete('done'); // round 2: four MORE letters — the record now holds eight
    await onReviewTurn(h, 4);
    h.claude.emitText(finding('three')); // terminal: four claims the union cannot hold → dropped
    h.claude.complete('done');
    await onReviewTurn(h, 5); // every displayed letter contested → the fresh look IS spawned
    // The answers landed on the record's claims — none discarded against the dropped enumeration:
    // the adjudicator's PRIOR ADJUDICATIONS shows each held claim with the letter's own pointer,
    // including the positions past the terminal report's four lines.
    const readjudged = h.claude.starts[4]!.prompt;
    expect(readjudged).toMatch(/\(a\) two claim 1/); // the record's order: round 2's union
    expect(readjudged).toContain('CONTESTED (src/a.ts:1)');
    expect(readjudged).toMatch(/\(e\) one claim 1/); // …and the held tail the report never lettered
    expect(readjudged).toContain('CONTESTED (src/e.ts:1)');
    expect(readjudged).not.toContain('three claim'); // the dropped enumeration is not the record
    h.claude.emitText('Every pointer holds.\nVERDICT: PASS');
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('done');
    expect(reviewerStarts(h)).toBe(4); // rounds 1–2, terminal, and the contest's fresh look
  });

  // Enumeration normalisation is all-or-nothing, so a bad enumeration (here: over the cap) leaves
  // NO recorded subset a partial contest could clear — the finding is single-claim again, and the
  // pre-RUN-180 rules apply whole: a bare CONTESTED is a full contest and earns the fresh look.
  it('a voided enumeration degrades the finding to single-claim contest rules', async () => {
    const h = harness({ manifest: REVIEWED(), verifyResults: [true] });
    h.claude.continueTexts = ['FINDING 1: CONTESTED src/a.ts:9 — the whole class is pre-existing'];
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onReviewTurn(h, 2);
    const five = ['a', 'b', 'c', 'd', 'e'].map((l) => `FINDING 1${l}: claim ${l}`).join('\n');
    h.claude.emitText(
      `FINDING 1 [High] src/gate.ts:1: five letters is several findings\n${five}\nVERDICT: FAIL`,
    );
    h.claude.complete('done');
    await onReviewTurn(h, 3); // the bare contest DOES earn the re-review — no letters survived to demand more
    h.claude.emitText('The pointer holds.\nVERDICT: PASS');
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('done');
    expect(reviewerStarts(h)).toBe(2);
  });

  it('a contest naming EVERY sub-claim earns the fresh look, which sees the per-letter rebuttals', async () => {
    const h = harness({ manifest: REVIEWED(), verifyResults: [true] });
    h.claude.continueTexts = [
      'FINDING 1a: CONTESTED src/x.ts:9 — the id filter covers it\nFINDING 1b: CONTESTED src/y.ts:3 — slice keeps the most recent',
    ];
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onReviewTurn(h, 2);
    h.claude.emitText(
      'FINDING 1 [High] src/gate.ts:1: two bundled defects [sub-claims: 2]\nFINDING 1a: half one\nFINDING 1b: half two\nVERDICT: FAIL',
    );
    h.claude.complete('done');
    await onReviewTurn(h, 3);
    // The fresh adjudicator's PRIOR ADJUDICATIONS carries each sub-claim with its own rebuttal.
    const readjudged = h.claude.starts[2]!.prompt;
    expect(readjudged).toMatch(/\(a\) half one/);
    expect(readjudged).toContain('CONTESTED (src/x.ts:9)');
    expect(readjudged).toContain('CONTESTED (src/y.ts:3)');
    h.claude.emitText('Both pointers hold.\nVERDICT: PASS');
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('done'); // every letter contested → the contest could clear the run
    expect(reviewerStarts(h)).toBe(2);
  });

  // Criterion 7: a rebuttal the builder streams before the turn dies must survive into the ledger,
  // so a continuation's fresh reviewer sees it as a prior adjudication rather than relitigating it.
  it('folds a streamed contest response into the ledger even when the contest turn then fails', async () => {
    const h = harness({ manifest: REVIEWED(), verifyResults: [true] });
    h.claude.continueTexts = ['FINDING 1: CONTESTED src/a.ts:9 — pre-existing'];
    h.claude.continueOutcomes = ['failed']; // streams the rebuttal, then dies
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onReviewTurn(h, 2);
    h.claude.emitText('FINDING 1 [High] src/a.ts:1: the guard is missing\nVERDICT: FAIL');
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('failed'); // the terminal FAIL stands after a dead contest turn
    expect(reviewerStarts(h)).toBe(1); // …and no re-review followed it
    // The rebuttal survived into the persisted continuable ledger.
    const record = h.continuable.puts.at(-1);
    const entry = record?.ledger.find((e) => e.id === 1);
    expect(entry?.status).toBe('contested');
    expect(entry?.pointer).toContain('src/a.ts:9');
  });

  // RUN-179: the single matched-response join runs BEFORE the ledger fold, so a POINTERLESS contest
  // streamed before the turn dies is persuasion with nothing to check — it is discarded, not
  // persisted as a contested rebuttal a continuation's fresh reviewer would then have to relitigate.
  it('does NOT persist a pointerless contest as a rebuttal, even from a crashed contest turn', async () => {
    const h = harness({ manifest: REVIEWED(), verifyResults: [true] });
    h.claude.continueTexts = ['FINDING 1: CONTESTED']; // a self-assertion with no pointer
    h.claude.continueOutcomes = ['failed']; // streams it, then dies
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onReviewTurn(h, 2);
    h.claude.emitText('FINDING 1 [High] src/a.ts:1: the guard is missing\nVERDICT: FAIL');
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('failed');
    const record = h.continuable.puts.at(-1);
    const entry = record?.ledger.find((e) => e.id === 1);
    expect(entry).toBeDefined(); // the finding is still in the ledger…
    expect(entry?.status).toBe('unanswered'); // …but the pointerless contest was not folded as evidence
    expect(entry?.pointer).toBeNull();
  });

  // The PASS is the daemon's to accept, not the reviewer's to assert: a malformed report that lists
  // a terminal finding and then signs PASS has cleared nothing (criterion 3/4). This also covers the
  // pointer a fresh reviewer rejects — it re-raises the finding, and the daemon takes the FAIL.
  it('a fresh PASS that still re-raises a terminal finding does NOT clear the run', async () => {
    const h = harness({ manifest: REVIEWED(), verifyResults: [true] });
    h.claude.continueTexts = ['FINDING 1: CONTESTED x — trust me'];
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onReviewTurn(h, 2);
    h.claude.emitText('FINDING 1 [High] src/a.ts:1: the guard is missing\nVERDICT: FAIL');
    h.claude.complete('done');
    await onReviewTurn(h, 3);
    // The fresh reviewer rejects the pointer — it re-raises the finding — yet signs PASS anyway.
    h.claude.emitText('FINDING 1 [High] src/a.ts:1: the guard is STILL missing\nVERDICT: PASS');
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('failed'); // the daemon overrode the PASS — the finding was re-raised
    expect(exit.reason).toBe('review');
  });

  it('declines the contest when the run has nothing left to spend, and reports the FAIL as-is', async () => {
    const h = harness({
      manifest: REVIEWED(),
      defaultBudget: { maxTokens: 1000, maxUsd: null, maxDurationSeconds: null, maxRounds: null },
    });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done', { outputTokens: 0 }); // the builder spent nothing…
    await onReviewTurn(h, 2);
    // …and the terminal reviewer spends exactly the ceiling filing its finding — within its OWN
    // session allowance (the whole 1000), but leaving the run with nothing for a contest turn.
    h.claude.emitText('FINDING 1 [High] src/a.ts:1: the guard is missing\nVERDICT: FAIL');
    h.claude.complete('done', { outputTokens: 1000 });
    const exit = await done;
    expect(exit.outcome).toBe('failed');
    expect(exit.reason).toBe('review');
    expect(h.claude.continuations).toEqual([]); // no contest turn was handed back
    expect(h.claude.starts).toHaveLength(2); // build + the one reviewer — nothing re-adjudicated
  });

  it('never contests an UNKNOWN terminal verdict — a non-report has nothing to answer', async () => {
    const h = harness({ manifest: REVIEWED(), verifyResults: [true] });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onReviewTurn(h, 2);
    // A numbered finding but no VERDICT line → 'unknown'. The finding is parseable, but an unknown
    // is a non-report (killed / crashed / no verdict), so there is nothing to contest.
    h.claude.emitText('FINDING 1 [High] src/a.ts:1: the guard is missing');
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('failed');
    expect(exit.reason).toBe('review:no-verdict');
    expect(h.claude.continuations).toEqual([]); // no contest turn
    expect(h.claude.starts).toHaveLength(2); // build + the one reviewer
  });
});

// RUN-188: the gate integration for spun-off work. A CONTESTED pointer may name a task —
// `task:<key>`, "real, out of scope, tracked THERE" — and the DAEMON checks it mechanically at
// both fold sites through one path, entering the result as ledger data for the credential-less
// fresh reviewer (RUN-43). The order of harms is may-miss-never-invent: a lookup that fails or
// finds nothing never CREDITS a contest and never fails the run by itself, and a daemon with no
// lookup wired behaves exactly as before RUN-188.
describe('spin-off task pointers (RUN-188)', () => {
  const REVIEWED = (maxRounds = 0, cmd: string | null = 'npm test') =>
    manifest({
      verify: {
        cmd,
        timeoutSeconds: null,
        shell: null,
        maxRounds,
        agent: { agent: null, tool: null, model: null, effort: null, maxRounds },
      },
    });
  const buildRun = () => makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } });
  const onReviewTurn = async (h: ReturnType<typeof harness>, atLeastStarts: number) => {
    for (let i = 0; i < 300; i++) {
      if (h.claude.opts?.runId === 'run_1:review' && h.claude.starts.length >= atLeastStarts) return;
      await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error(`the reviewer session (>= ${atLeastStarts} starts) never began`);
  };
  const reviewerStarts = (h: ReturnType<typeof harness>) =>
    h.claude.starts.filter((s) => s.runId === 'run_1:review').length;
  /** A spun-off task on the server, its provenance naming THIS run (run_1) and the finding. */
  const SPUN_OFF: Record<string, SpinOffLookup> = {
    'RUN-201': {
      key: 'RUN-201',
      title: 'Harden the guard floor',
      spinOff: { sourceTaskId: 'task_9', sourceRunId: 'run_1', finding: 'the guard is missing' },
    },
  };
  /** Build → terminal reviewer FAILs → the contest turn streams `contest` → the run settles.
   *  Boxed, because an async return would ADOPT the run promise and deadlock any test that still
   *  has reviewer turns to drive. */
  const terminalContest = async (h: ReturnType<typeof harness>, contest: string) => {
    h.claude.continueTexts = [contest];
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done'); // build turn
    await onReviewTurn(h, 2);
    h.claude.emitText('FINDING 1 [High] src/a.ts:1: the guard is missing\nVERDICT: FAIL');
    h.claude.complete('done'); // terminal reviewer FAILs → the contest turn runs
    return { done };
  };

  it('a verified task pointer earns the fresh look, which reads the daemon’s check as ledger data', async () => {
    const h = harness({ manifest: REVIEWED(), verifyResults: [true], spinOffTasks: SPUN_OFF });
    const { done } = await terminalContest(
      h,
      'FINDING 1: CONTESTED task:RUN-201 — real, out of scope, tracked there',
    );
    await onReviewTurn(h, 3); // the contest cleared candidacy → one fresh adjudicator
    const readjudged = h.claude.starts[2]!.prompt;
    expect(readjudged).toContain('CONTESTED (task:RUN-201)');
    // The daemon's line, not the builder's claim: existence AND provenance, as checkable data.
    expect(readjudged).toContain(
      '→ daemon: task:RUN-201 verified — exists — RUN-201: Harden the guard floor (filed from THIS run, against: "the guard is missing")',
    );
    h.claude.emitText('The task covers the finding and the work is adjacent.\nVERDICT: PASS');
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('done');
    expect(reviewerStarts(h)).toBe(2); // the terminal round + the contest's fresh look
  });

  it('a task the daemon cannot find never buys the re-adjudication — recorded NOT verified', async () => {
    const h = harness({ manifest: REVIEWED(), verifyResults: [true], spinOffTasks: {} });
    const { done } = await terminalContest(h, 'FINDING 1: CONTESTED task:RUN-999 — tracked there, honest');
    const exit = await done;
    expect(exit.outcome).toBe('failed'); // an unverifiable pointer is a pointer at nothing
    expect(exit.reason).toBe('review');
    expect(reviewerStarts(h)).toBe(1); // no fresh adjudicator spawned to possibly-PASS over it
    // The contest and its failed check both survive into the ledger — visible to a human and a
    // continuation, not just to the gate that refused it.
    const entry = h.continuable.puts.at(-1)?.ledger.find((e) => e.id === 1);
    expect(entry?.status).toBe('contested');
    expect(entry?.spinOffs?.map((f) => [f.ref, f.verified])).toEqual([['RUN-999', false]]);
  });

  // The probe posture (checkClaimable's): a throw is the same non-answer as a null — recorded
  // unverified, never a crash, never a gate of its own. The run fails on the finding standing,
  // which is exactly where it stood before the contest.
  it('a lookup that throws is recorded unverified — never a crash, never a credit', async () => {
    const h = harness({ manifest: REVIEWED(), verifyResults: [true], spinOffTasks: 'fails' });
    const { done } = await terminalContest(h, 'FINDING 1: CONTESTED task:RUN-201 — tracked there');
    const exit = await done;
    expect(exit.outcome).toBe('failed');
    expect(reviewerStarts(h)).toBe(1);
    const entry = h.continuable.puts.at(-1)?.ledger.find((e) => e.id === 1);
    expect(entry?.spinOffs?.map((f) => [f.ref, f.verified])).toEqual([['RUN-201', false]]);
  });

  // Every named task must verify: a real task beside a bogus one does not carry the response —
  // refusing may cost a re-contest, crediting would invent the half that was never checked.
  it('a contest naming a verified AND an unverifiable task is no candidate', async () => {
    const h = harness({ manifest: REVIEWED(), verifyResults: [true], spinOffTasks: SPUN_OFF });
    const { done } = await terminalContest(
      h,
      'FINDING 1: CONTESTED task:RUN-201 task:RUN-999 — split across two',
    );
    const exit = await done;
    expect(exit.outcome).toBe('failed');
    expect(reviewerStarts(h)).toBe(1);
  });

  // The per-answer cap is PRICED, never taken silently: a fourth ref is not looked up, and the
  // answer cannot credit a contest even when every named task is real — three verified tasks must
  // not speak for one nobody checked.
  it('a fourth task pointer is never silently dropped — the over-cap answer cannot credit', async () => {
    const four = Object.fromEntries(
      ['A-1', 'A-2', 'A-3', 'A-4'].map((k) => [k, { key: k, title: `real task ${k}` }]),
    );
    const h = harness({ manifest: REVIEWED(), verifyResults: [true], spinOffTasks: four });
    const { done } = await terminalContest(
      h,
      'FINDING 1: CONTESTED task:A-1 task:A-2 task:A-3 task:A-4 — spread across four',
    );
    const exit = await done;
    expect(exit.outcome).toBe('failed');
    expect(reviewerStarts(h)).toBe(1); // no fresh adjudicator on a set the daemon did not finish
    // The saturation fact is in the ledger, out loud — never a silent reduction of the claim set.
    const entry = h.continuable.puts.at(-1)?.ledger.find((e) => e.id === 1);
    const unchecked = entry?.spinOffs?.find((f) => f.ref === '(unchecked)');
    expect(unchecked?.verified).toBe(false);
    expect(unchecked?.detail).toContain('more task pointer(s)');
  });

  // A task-claim token no reference can be read from is a claim the daemon cannot verify — it
  // degrades toward unverifiable (an unverified fact), never toward "no task named".
  it('a task claim the daemon cannot read blocks credit instead of reading as no claim', async () => {
    const h = harness({ manifest: REVIEWED(), verifyResults: [true], spinOffTasks: SPUN_OFF });
    const { done } = await terminalContest(h, 'FINDING 1: CONTESTED task: RUN-201 — tracked there');
    const exit = await done;
    expect(exit.outcome).toBe('failed');
    expect(reviewerStarts(h)).toBe(1);
    const entry = h.continuable.puts.at(-1)?.ledger.find((e) => e.id === 1);
    expect(entry?.spinOffs?.map((f) => [f.ref, f.verified])).toEqual([['(unchecked)', false]]);
    expect(entry?.spinOffs?.[0]?.detail).toContain('no readable reference');
  });

  // A stalled lookup is a non-answer, on a deadline: the run neither hangs on the await nor
  // credits the contest — the same degradation a thrown lookup gets.
  it('a lookup that never resolves times out to unverified — the run neither hangs nor credits', async () => {
    const h = harness({ manifest: REVIEWED(), verifyResults: [true], spinOffTasks: 'hangs' });
    const { done } = await terminalContest(h, 'FINDING 1: CONTESTED task:RUN-201 — tracked there');
    const exit = await done;
    expect(exit.outcome).toBe('failed');
    expect(reviewerStarts(h)).toBe(1);
    const entry = h.continuable.puts.at(-1)?.ledger.find((e) => e.id === 1);
    expect(entry?.spinOffs?.map((f) => [f.ref, f.verified])).toEqual([['RUN-201', false]]);
  });

  // The pre-RUN-188 daemon, byte-identical: no lookup wired → no facts, and a task pointer is the
  // free text it always was — a checkable-looking pointer the fresh reviewer judges from prose.
  it('with no lookup wired a task pointer behaves exactly as before — free text, no daemon line', async () => {
    const h = harness({ manifest: REVIEWED(), verifyResults: [true] }); // spinOffTasks absent
    const { done } = await terminalContest(h, 'FINDING 1: CONTESTED task:RUN-201 — tracked there');
    await onReviewTurn(h, 3); // the non-empty pointer still earns the fresh look, as it did before
    const readjudged = h.claude.starts[2]!.prompt;
    expect(readjudged).toContain('CONTESTED (task:RUN-201)');
    // No daemon DATA line rides the entry (the template's own teaching still mentions the form).
    expect(readjudged).not.toContain('→ daemon: task:RUN-201');
    h.claude.emitText('The pointer holds.\nVERDICT: PASS');
    h.claude.complete('done');
    expect((await done).outcome).toBe('done');
  });

  // The OTHER fold site, same path: a fix-round contest naming a task carries the daemon's check
  // into the ledger the NEXT fresh reviewer reads — the fact reaches it as data it could never
  // look up itself.
  it('a fix-round task pointer is checked and the fact reaches the next fresh reviewer', async () => {
    const h = harness({ manifest: REVIEWED(1), verifyResults: [true, true], spinOffTasks: SPUN_OFF });
    h.claude.continueTexts = ['FINDING 1: CONTESTED task:RUN-201 — out of scope, tracked there'];
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done'); // build turn
    await onReviewTurn(h, 2);
    h.claude.emitText('FINDING 1 [High] src/a.ts:1: the guard is missing\nVERDICT: FAIL');
    h.claude.complete('done'); // round 1 FAILs → fix turn answers with the task pointer
    await onReviewTurn(h, 3); // floor re-ran, round 2's fresh reviewer starts
    const next = h.claude.starts[2]!.prompt;
    expect(next).toMatch(/PRIOR ADJUDICATIONS/);
    expect(next).toContain('CONTESTED (task:RUN-201)');
    expect(next).toContain('→ daemon: task:RUN-201 verified — exists — RUN-201: Harden the guard floor');
    h.claude.emitText('Adjacent work, properly tracked.\nVERDICT: PASS');
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('done');
    expect(reviewerStarts(h)).toBe(2); // round 1 + round 2 — the fact rode the ledger, not a new spawn
  });

  // …and an unverified fix-round pointer rides the ledger too, marked NOT verified, so the next
  // reviewer is told to treat it as pointing at nothing rather than reading prose.
  it('an unverifiable fix-round pointer reaches the next reviewer marked NOT verified', async () => {
    const h = harness({ manifest: REVIEWED(1), verifyResults: [true, true], spinOffTasks: {} });
    h.claude.continueTexts = ['FINDING 1: CONTESTED task:RUN-999 — tracked there'];
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onReviewTurn(h, 2);
    h.claude.emitText('FINDING 1 [High] src/a.ts:1: the guard is missing\nVERDICT: FAIL');
    h.claude.complete('done');
    await onReviewTurn(h, 3);
    expect(h.claude.starts[2]!.prompt).toContain('→ daemon: task:RUN-999 NOT verified');
    h.claude.emitText('VERDICT: PASS');
    h.claude.complete('done');
    await done;
  });
});

describe('rebase conflicts', () => {
  const buildRun = () => makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } });

  /** The conflict turn starts several awaits after the build turn completes (hasChanges,
   *  commit, branch checks, rebase) — wait for the driver to actually be on it. */
  const onConflictTurn = async (h: ReturnType<typeof harness>) => {
    for (let i = 0; i < 100; i++) {
      if (h.claude.opts?.runId === 'run_1:conflict') return;
      await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error('the conflict-resolution turn never started');
  };

  it('lets the agent resolve a mechanical conflict, then lands it', async () => {
    const h = harness({ manifest: LANDING(), conflicts: ['src/a.ts'] });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done'); // the build turn
    await onConflictTurn(h);
    h.claude.emitText('Both sides append to the same list; kept both.\nRESOLVED: YES');
    h.claude.complete('done');
    const exit = await done;

    expect(exit.outcome).toBe('done');
    expect(h.worktrees.landings).toHaveLength(1);
    expect(h.worktrees.aborted).toBe(0);
  });

  it('bails out to a human when the agent says it is not mechanical', async () => {
    const h = harness({ manifest: LANDING(), conflicts: ['src/a.ts'] });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onConflictTurn(h);
    h.claude.emitText('The other side refactored this into a hook.\nRESOLVED: NO');
    h.claude.complete('done');
    const exit = await done;

    // Declining is CORRECT, not a failure of the agent — picking a winner would delete
    // someone's work silently.
    expect(exit.reason).toBe('land:conflict');
    expect(h.worktrees.aborted).toBe(1); // worktree restored, diff intact
    expect(h.worktrees.removed).toEqual([]);
    expect(h.comments[0]?.body).toContain('not mechanically resolvable');
  });

  it('treats an absent/ambiguous verdict as NO', async () => {
    const h = harness({ manifest: LANDING(), conflicts: ['src/a.ts'] });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onConflictTurn(h);
    h.claude.emitText('I had a look and it seems mostly fine?');
    h.claude.complete('done');
    const exit = await done;
    expect(exit.reason).toBe('land:conflict');
  });

  it('catches an agent that claims YES but left markers behind', async () => {
    const h = harness({ manifest: LANDING(), conflicts: ['src/a.ts'], stillConflicted: ['src/a.ts'] });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await onConflictTurn(h);
    h.claude.emitText('RESOLVED: YES');
    h.claude.complete('done');
    const exit = await done;

    expect(exit.reason).toBe('land:conflict');
    expect(h.comments[0]?.body).toContain('conflict markers remained');
  });

  it('does not ask the agent at all when resolveConflicts=false', async () => {
    const h = harness({ manifest: LANDING({ resolveConflicts: false }), conflicts: ['src/a.ts'] });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    const exit = await done;
    expect(exit.reason).toBe('land:conflict');
    expect(h.worktrees.aborted).toBe(1);
  });
});

describe('a run says what it is DOING, not just that it is alive (RUN-31)', () => {
  const buildRun = () => makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } });
  /** The phases reported, in order, with consecutive repeats collapsed. */
  const phases = (h: ReturnType<typeof harness>) =>
    h.reports.map((r) => r.phase).filter((p, i, all) => p && p !== all[i - 1]);

  it('reports `verifying` while the gate runs — the ~90s that read as a hung agent', async () => {
    // The bug this task exists for: process gone, spend frozen, dashboard still says "running".
    const h = harness({ verifyResults: [true] });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await done;
    expect(phases(h)).toEqual(['agent', 'verifying']);
  });

  it('reports `landing` for the rebase → verify → fast-forward', async () => {
    const h = harness({ manifest: LANDING() });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await done;
    // Landing is the umbrella: its internal verify is not a separate thing a human can act on,
    // and renaming it mid-pipeline would make the branch look like it moved twice.
    expect(phases(h)).toEqual(['agent', 'landing']);
  });

  it('flips back to `agent` when the gate hands work back — spend must not climb during "verifying"', async () => {
    // RUN-29's fix turn burns tokens again. Reporting it as `verifying` would recreate this
    // task's bug with the lie pointing the other way.
    const h = harness({ verifyResults: [false, true] });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await done;
    expect(phases(h)).toEqual(['agent', 'verifying', 'agent', 'verifying']);
  });

  it('a phase report never claims the spend is zero', async () => {
    // The phase ticks carry no telemetry. If the daemon or server treated an absent field as
    // "set it to null", entering the gate would blank the spend on the dashboard — which is
    // the exact symptom (numbers stop, then lie) this task is fixing.
    const h = harness({ verifyResults: [true] });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await done;
    const gate = h.reports.find((r) => r.phase === 'verifying');
    expect(gate?.telemetry).toBeUndefined();
    expect(gate?.status).toBe('running'); // still running: a phase is not a status
  });

  it('a scope run reports `agent` and nothing else — it has no gate to sit in', async () => {
    const h = harness();
    const done = h.supervisor.supervise(makeRun({ kind: 'scope' }));
    await flush();
    h.claude.complete('done');
    await done;
    expect(phases(h)).toEqual(['agent']);
  });
});

describe('parking a run on a human (RUN-30)', () => {
  const buildRun = () => makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } });
  const asked = { blocked: true, signalId: 'sig_1', question: 'Approach A or B?' };

  it('a session ending is ambiguous — so it ASKS the server before finalizing', async () => {
    // An agent that asked a question ends its turn exactly like one that finished. The daemon
    // cannot tell them apart locally: request_input goes over the agent's own MCP transport,
    // straight to the server, with the daemon nowhere in that path.
    const h = harness({ parkState: asked, verifyResults: [true] });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await done;
    expect(h.parkChecks).toEqual(['run_1']);
  });

  it('parks instead of finishing: reports blocked, KEEPS the worktree, skips the gate', async () => {
    const h = harness({ parkState: asked, verifyResults: [true] });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await done;

    expect(h.reports.at(-1)?.status).toBe('blocked');
    // The two things that make a park recoverable at all. The worktree holds the work; reaping
    // it (as a finished run does) is what today throws away everything the agent understood.
    expect(h.worktrees.removed).toEqual([]);
    expect((await h.parked.get('run_1'))?.sessionId).toBe('sess-fake');
    // And it is NOT graded: a run that stopped to ask a question has not finished the job.
    expect(h.verifyCalls()).toBe(0);
  });

  it('remembers what resume needs: session, worktree, identity, credential, spend', async () => {
    const h = harness({ parkState: asked });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await done;
    expect(await h.parked.get('run_1')).toMatchObject({
      sessionId: 'sess-fake',
      // The WHOLE workspace, location included (RUN-50): resume hands it back to the backend
      // verbatim, so anything missing here is work the resumed run cannot find.
      workspace: { localPath: '/wt/run_1', workRef: 'noriq/run/run_1' },
      agentId: 'agt_run1',
      // Persisted, not re-minted: RUN-43 made the run→agent credential deliberately
      // non-reissuable, and a park is the same process later, not a second one.
      mcpToken: 'plnrt_bound_to_agt_run1',
      question: 'Approach A or B?',
    });
  });

  it('does NOT park a run the server says is not blocked', async () => {
    const h = harness({ verifyResults: [true] }); // default: not blocked
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    expect((await done).outcome).toBe('done');
    expect(await h.parked.list()).toEqual([]);
    expect(h.verifyCalls()).toBe(1); // gated normally
  });

  it('finalizes rather than parking when it cannot reach the server', async () => {
    // Parking on a guess would strand a FINISHED run as blocked forever, waiting for an answer
    // to a question nobody asked. Falling back to the pre-RUN-30 behaviour is the safe side.
    const h = harness({ parkStateFails: true, verifyResults: [true] });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    expect((await done).outcome).toBe('done');
    expect(await h.parked.list()).toEqual([]);
  });

  it('does not park a run that FAILED, even with a question open', async () => {
    // A budget breach or a crash is terminal. Resuming it would hand it a fresh ceiling —
    // the spend loophole in reverse.
    const h = harness({ parkState: asked });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('failed');
    expect((await done).outcome).toBe('failed');
    expect(await h.parked.list()).toEqual([]);
  });

  it('refuses to park when the tool has no resumable session', async () => {
    // Parking it would promise a return the daemon cannot deliver: reported blocked, resumable
    // never. Fail it loudly with its worktree intact instead.
    const h = harness({ parkState: asked });
    h.claude.sessionId = null;
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await done;
    expect(await h.parked.list()).toEqual([]);
    expect(h.reports.at(-1)?.status).not.toBe('blocked');
  });
});

describe('resuming a parked run (RUN-30)', () => {
  const buildRun = () => makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } });
  const asked = { blocked: true, signalId: 'sig_1', question: 'Approach A or B?' };

  /** Park a run, then hand back a harness whose store holds it. */
  const parkFirst = async (over: Parameters<typeof harness>[0] = {}) => {
    const h = harness({ parkState: asked, ...over });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await done;
    return h;
  };

  it('comes back in the SAME session and the SAME worktree — the whole point', async () => {
    // Not a fresh run re-reading the repo: the agent returns with everything it had already
    // worked out still in context. That is the difference between collaborating and starting over.
    const h = await parkFirst({ verifyResults: [true] });
    h.answerIt();
    const resumed = h.supervisor.resume('run_1', 'Use B.');
    await flush();
    h.claude.complete('done');
    await resumed;

    const second = h.claude.starts.at(-1)!;
    expect(second.resumeSessionId).toBe('sess-fake');
    expect(second.cwd).toBe('/wt/run_1'); // reused, never recreated
    expect(h.worktrees.created).toHaveLength(1); // only the original
  });

  // RUN-168 recorded WHERE a chain parked; RUN-169 is what lets the rest of it run. Before the
  // first, a resume restored one session and reported the run DONE having silently skipped its
  // plan. Between them, it finished the parked step and reported incomplete — honest, but a
  // decomposed run that asked one question cost a re-dispatch, and decomposed runs are exactly the
  // long ones most likely to ask.
  it('a resumed chain runs the steps that never got to', async () => {
    const task: AnchorTask = {
      key: 'ACME-1',
      title: 'two steps',
      body: null,
      executionSpec: ExecutionSpec.parse({
        steps: [
          { id: 's1', title: 'first' },
          { id: 's2', title: 'second' },
        ],
      }),
    };
    const h = await parkFirst({ anchorTask: task });
    // It parked on step one, and the record says so — without that the resume has no idea a chain
    // is in flight, let alone where it stopped.
    expect(h.parked.entries.get('run_1')!.stepId).toBe('s1');

    h.answerIt();
    const resumed = h.supervisor.resume('run_1', 'Use B.');
    await flush();
    const before = h.claude.starts.length;
    h.claude.complete('done'); // the resumed step-one session
    for (let i = 0; i < 300 && h.claude.starts.length <= before; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    const second = h.claude.starts.at(-1)!;
    // A FRESH session for step two, with the RUN's brief — not the resume prompt, which is only
    // the question and the answer and would leave it with no idea what repo it is in.
    expect(second.resumeSessionId).toBeUndefined();
    expect(second.prompt).toContain('YOU ARE DOING STEP 2 OF 2: second');
    expect(second.prompt).toContain('ship the thing'); // the run's own brief
    expect(second.prompt).not.toContain('Use B.'); // not the answer to step one's question
    h.claude.complete('done');
    expect(await resumed).toMatchObject({ outcome: 'done' });
  });

  // RUN-171. `executeChain` gives every step the earlier steps' conclusions, and that hand-off is
  // the whole argument for a chain of fresh contexts over one long one. A resume rebuilt the array
  // EMPTY, so a run parked on step two briefed step three with step two's post-answer output alone
  // — step one's conclusions gone, and step three rediscovering what the run had established.
  it('carries what the steps before the park concluded into the ones after it', async () => {
    const task: AnchorTask = {
      key: 'ACME-1',
      title: 'three steps',
      body: null,
      executionSpec: ExecutionSpec.parse({
        steps: [
          { id: 's1', title: 'first' },
          { id: 's2', title: 'second' },
          { id: 's3', title: 'third' },
        ],
      }),
    };
    // Step one finishes and says something; step two then parks on a question.
    const h = harness({ anchorTask: task, parkState: { blocked: false } });
    const done = h.supervisor.supervise(
      makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } }),
    );
    await flush();
    h.claude.emitText('STEP-ONE-CONCLUSION');
    h.claude.complete('done');
    for (let i = 0; i < 300 && h.claude.starts.length < 2; i++) await new Promise((r) => setTimeout(r, 0));
    h.parkNext();
    h.claude.complete('done'); // step two parks
    await done;

    const parked = h.parked.entries.get('run_1')!;
    expect(parked.stepId).toBe('s2');
    // Step ONE's summary is in the record. The parked step's own is not: it parked mid-turn, so
    // its state is a question rather than a conclusion, and recording that would hand the next
    // step a half-thought.
    expect(parked.priorSteps?.map((p) => p.id)).toEqual(['s1']);
    expect(parked.priorSteps?.[0]!.text).toContain('STEP-ONE-CONCLUSION');

    h.answerIt();
    const resumed = h.supervisor.resume('run_1', 'Use B.');
    await flush();
    const before = h.claude.starts.length;
    h.claude.complete('done'); // the resumed step two
    for (let i = 0; i < 300 && h.claude.starts.length <= before; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    // Step three is briefed with step one's conclusion, not only step two's.
    expect(h.claude.starts.at(-1)!.prompt).toContain('STEP-ONE-CONCLUSION');
    h.claude.complete('done');
    await resumed;
  });

  // A park lasts up to 72 hours and the spec may be corrected while it waits (RUN-164), so the step
  // that parked can be gone from the recomputed chain. Restarting from the top would redo landed
  // work and skipping to the end would abandon it — neither is a guess worth making.
  it('stops rather than guessing when the parked step is gone from the new plan', async () => {
    const parkedWith: AnchorTask = {
      key: 'ACME-1',
      title: 'two steps',
      body: null,
      executionSpec: ExecutionSpec.parse({
        steps: [
          { id: 's1', title: 'first' },
          { id: 's2', title: 'second' },
        ],
      }),
    };
    const h = await parkFirst({ anchorTask: parkedWith });
    expect(h.parked.entries.get('run_1')!.stepId).toBe('s1');
    // A human rewrote the plan while it waited; the step it parked on no longer exists.
    h.setAnchorTask({
      ...parkedWith,
      executionSpec: ExecutionSpec.parse({
        steps: [
          { id: 'x1', title: 'rethought' },
          { id: 'x2', title: 'also rethought' },
        ],
      }),
    });
    h.answerIt();
    const exit = await h.supervisor.resume('run_1', 'Use B.');
    expect(exit).toMatchObject({ outcome: 'failed', reason: 'steps:parked-step-gone' });
    expect(h.transcript.map((t) => t.text).join('\n')).toMatch(/its plan no longer declares/);
  });

  // RUN-145. A resume reaches afterDriver by its OWN path, so it was passing no spec at all: the
  // resumed run's reviewer got an empty checklist while a first-sitting run's got the criteria.
  // Parking, answering a question and carrying on silently disabled the gate's definition of done —
  // and worse than "no checklist", `ACCEPTANCE 1: FAILED` followed by `VERDICT: PASS` then passed,
  // because with no items there was nothing for the override to contradict.
  it('carries the acceptance criteria into the resumed run’s reviewer', async () => {
    const REVIEWED = manifest({
      verify: {
        cmd: null,
        timeoutSeconds: null,
        shell: null,
        maxRounds: 0,
        agent: { agent: null, tool: null, model: null, effort: null, maxRounds: 0 },
      },
    });
    const h = await parkFirst({
      manifest: REVIEWED,
      anchorTask: {
        key: 'ACME-1',
        title: 'reap orphans',
        body: null,
        executionSpec: ExecutionSpec.parse({
          acceptance: { observableTruths: ['the daemon reaps orphans on start'] },
        }),
      },
    });
    h.answerIt();
    const resumed = h.supervisor.resume('run_1', 'Use B.');
    await flush();
    h.claude.complete('done'); // the resumed build turn
    for (let i = 0; i < 200; i++) {
      if (h.claude.opts?.runId === 'run_1:review') break;
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(h.claude.opts!.prompt).toContain('1. [truth] the daemon reaps orphans on start');
    h.claude.emitText('ACCEPTANCE 1: FAILED nothing reaps on start\nVERDICT: PASS');
    h.claude.complete('done');
    const exit = await resumed;
    // The override reaches a resumed run too, which it could not when the checklist was empty.
    expect(exit).toMatchObject({ outcome: 'failed', reason: 'review' });
  });

  it('the prompt is the ANSWER, not a fresh briefing', async () => {
    const h = await parkFirst({ verifyResults: [true] });
    h.answerIt();
    const resumed = h.supervisor.resume('run_1', 'Use B, and mind the cache.');
    await flush();
    h.claude.complete('done');
    await resumed;

    const prompt = h.claude.starts.at(-1)!.prompt;
    expect(prompt).toContain('Use B, and mind the cache.');
    expect(prompt).toContain('Approach A or B?'); // its own question back
    expect(prompt).not.toContain('ship the thing'); // NOT the original brief — it has the context
  });

  it('runs the gate it skipped when it parked', async () => {
    // A run that asked for help is not a run that gets to skip the gate.
    const h = await parkFirst({ verifyResults: [true] });
    h.answerIt();
    const resumed = h.supervisor.resume('run_1', 'Use B.');
    await flush();
    h.claude.complete('done');
    expect((await resumed)?.outcome).toBe('done');
    expect(h.verifyCalls()).toBe(1);
    // Kept, but for the ordinary reason rather than the park: this repo has no [land], so the
    // diff is still on its branch and a human has to look at it. Resume rejoins the normal
    // pipeline — it does not get its own cleanup rules.
    expect(h.worktrees.removed).toEqual([]);
  });

  it('inherits the REMAINING budget, never a fresh one', async () => {
    // Otherwise "ask a question" is a way to buy more budget, and a run could park its way past
    // any ceiling.
    const h = await parkFirst({
      defaultBudget: { maxTokens: 1000, maxUsd: 5, maxDurationSeconds: 600, maxRounds: null },
    });
    h.answerIt();
    const parked = await h.parked.get('run_1');
    expect(parked!.spent.tokens).toBe(42); // what the fake driver burned

    const resumed = h.supervisor.resume('run_1', 'Use B.');
    await flush();
    h.claude.complete('done');
    await resumed;
    expect(h.claude.starts.at(-1)!.budget).toMatchObject({ maxTokens: 1000 - 42 });
  });

  it('does not charge the run for the time a human took to answer', async () => {
    // Wall-clock counts ACTIVE time only. Charging the wait would mean every question answered
    // after lunch returns to a run that is already dead — a slower way to lose the work.
    const h = await parkFirst({
      defaultBudget: { maxTokens: null, maxUsd: null, maxDurationSeconds: 600, maxRounds: null },
    });
    h.answerIt();
    const parked = await h.parked.get('run_1');
    expect(parked!.activeSeconds).toBeLessThan(5); // the test's own runtime, not a wall-clock age

    const resumed = h.supervisor.resume('run_1', 'Use B.');
    await flush();
    h.claude.complete('done');
    await resumed;
    // Still ~the full 600s: the park cost it nothing.
    expect(h.claude.starts.at(-1)!.budget!.maxDurationSeconds).toBeGreaterThan(590);
  });

  it('reports the RUN’s total spend, not just this sitting’s', async () => {
    const h = await parkFirst();
    h.answerIt();
    const resumed = h.supervisor.resume('run_1', 'Use B.');
    await flush();
    h.claude.complete('done');
    const exit = await resumed;
    // 42 before the park + 42 after. A dashboard that reset the number at resume would make
    // the second half of a run look free.
    expect(exit!.telemetry.outputTokens + exit!.telemetry.inputTokens).toBe(84);
  });

  it('is idempotent — the WS frame and the reconnect sweep can both fire', async () => {
    const h = await parkFirst({ verifyResults: [true] });
    h.answerIt();
    const first = h.supervisor.resume('run_1', 'Use B.');
    await flush();
    // The second resume finds nothing: unpark() removed the entry before anything started.
    expect(await h.supervisor.resume('run_1', 'Use B.')).toBeNull();
    h.claude.complete('done');
    await first;
    expect(h.claude.starts).toHaveLength(2); // the original + ONE resume, not two
  });

  it('resuming a run that was never parked is a no-op, not a crash', async () => {
    const h = harness();
    expect(await h.supervisor.resume('run_nope', 'hello?')).toBeNull();
  });

  it('can park AGAIN — a second question is worth as much as the first', async () => {
    const h = await parkFirst();
    const resumed = h.supervisor.resume('run_1', 'Use B.');
    await flush();
    h.claude.complete('done'); // still blocked per parkState → parks again
    await resumed;
    expect((await h.parked.get('run_1'))?.sessionId).toBe('sess-fake');
    // And the spend accumulated across BOTH sittings.
    expect((await h.parked.get('run_1'))?.spent.tokens).toBe(84);
  });
});

describe('expiring a park nobody answered (RUN-30)', () => {
  const buildRun = () => makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } });

  const parkOne = async (parkTtlHours?: number) => {
    const h = harness({ parkState: { blocked: true, signalId: 's', question: 'A or B?' }, parkTtlHours });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done');
    await done;
    return h;
  };

  it('fails a park past its TTL but KEEPS the worktree', async () => {
    const h = await parkOne(0); // any age at all is past a zero TTL
    await new Promise((r) => setTimeout(r, 5));
    expect(await h.supervisor.expireStaleParks()).toBe(1);

    expect(h.reports.at(-1)).toMatchObject({ status: 'failed', exit: { reason: 'park_expired' } });
    expect(await h.parked.list()).toEqual([]);
    // The one thing the daemon never does: the worktree holds work that exists nowhere else.
    expect(h.worktrees.removed).toEqual([]);
  });

  it('leaves a fresh park alone', async () => {
    const h = await parkOne(72);
    expect(await h.supervisor.expireStaleParks()).toBe(0);
    expect(await h.parked.list()).toHaveLength(1);
  });
});

describe('the prompt invites an agent to reach a human (RUN-32)', () => {
  // The allowlist grants the tools; this is what stops them going unused. An agent that hits an
  // ambiguity with no invitation to ask does not stop — it picks, and hopes.
  it('tells every kind it can ask, and that asking is not giving up', () => {
    for (const kind of ['scope', 'build'] as const) {
      const p = assemblePrompt(makeRun({ kind }), manifest(), { agent: testAgent(), server: 'https://s' });
      expect(p).toContain('request_input');
      expect(p).toContain('raise_alert');
      // The reassurance is the point: an agent that believes asking ends its run will guess
      // instead. RUN-30 made "paused, not discarded" true — this is what tells it so.
      expect(p).toMatch(/paused, not discarded/);
    }
  });

  it('the verify prompt says it too — it assembles its own and inherits nothing', () => {
    const p = assemblePrompt(makeRun({ kind: 'verify' }), manifest(), {
      agent: testAgent(),
      server: 'https://s',
    });
    expect(p).toContain('raise_alert');
    expect(p).toContain('request_input');
    expect(p).toContain('VERDICT:'); // still the adversarial gate it was
  });
});

describe('choosing a model + effort (RUN-33)', () => {
  const MODELS = (over: Partial<ProjectManifest['defaults']> = {}): ProjectManifest =>
    manifest({
      defaults: {
        // What the task's own argument asks for: kinds differ, so a repo says so once.
        scope: { agent: null, model: 'claude-opus-4-8', effort: 'high' },
        build: { agent: null, model: 'claude-sonnet-5', effort: 'medium' },
        verify: { agent: null, model: null, effort: 'xhigh' },
        ...over,
      },
    });

  it('the dispatch wins — a human chose, for this run', () => {
    expect(
      resolveModel(
        { agent: null, agentTool: 'claude', kind: 'build', model: 'claude-fable-5', effort: 'max' },
        MODELS(),
      ),
    ).toEqual({
      model: 'claude-fable-5',
      effort: 'max',
    });
  });

  it('falls back to the repo’s default for THAT kind', () => {
    // The point of per-kind: scope is exploration and judgment, build is execution.
    expect(
      resolveModel({ agent: null, agentTool: 'claude', kind: 'scope', model: null, effort: null }, MODELS()),
    ).toEqual({
      model: 'claude-opus-4-8',
      effort: 'high',
    });
    expect(
      resolveModel({ agent: null, agentTool: 'claude', kind: 'build', model: null, effort: null }, MODELS()),
    ).toEqual({
      model: 'claude-sonnet-5',
      effort: 'medium',
    });
  });

  it('merges per FIELD — naming only a model keeps the repo’s effort', () => {
    // Whole-object merge would mean the one field a dispatcher set silently erased the other,
    // which is the bug mergeBudget already exists to avoid.
    expect(
      resolveModel(
        { agent: null, agentTool: 'claude', kind: 'build', model: 'claude-fable-5', effort: null },
        MODELS(),
      ),
    ).toEqual({
      model: 'claude-fable-5',
      effort: 'medium', // the repo's
    });
  });

  it('a repo [defaults].agent COORDINATE supplies the model+effort (RUN-113)', () => {
    const m = MODELS({ build: { agent: 'claude.opus-4_8.high', model: null, effort: null } });
    expect(
      resolveModel({ agent: null, agentTool: 'claude', kind: 'build', model: null, effort: null }, m),
    ).toEqual({
      model: 'opus-4.8', // unescaped from the coordinate
      effort: 'high',
    });
  });

  it('the coordinate wins over the legacy model/effort pair, dispatch still overrides both', () => {
    // agent set AND model/effort set on the same block → the coordinate is authoritative...
    const m = MODELS({ build: { agent: 'claude.opus-4_8.high', model: 'claude-sonnet-5', effort: 'low' } });
    expect(
      resolveModel({ agent: null, agentTool: 'claude', kind: 'build', model: null, effort: null }, m),
    ).toEqual({
      model: 'opus-4.8',
      effort: 'high',
    });
    // ...but a dispatch value still beats the repo default, coordinate or not.
    expect(
      resolveModel(
        { agent: null, agentTool: 'claude', kind: 'build', model: 'claude-fable-5', effort: null },
        m,
      ),
    ).toEqual({
      model: 'claude-fable-5',
      effort: 'high', // from the coordinate, since the dispatch named no effort
    });
  });

  it('says NOTHING when nobody chose — the tool keeps its own default', () => {
    // The pre-RUN-33 behaviour, and it must stay reachable: absent, not null, because the
    // drivers only pass through what is present.
    expect(
      resolveModel(
        { agent: null, agentTool: 'claude', kind: 'build', model: null, effort: null },
        manifest(),
      ),
    ).toEqual({});
  });

  it('an effort with no model is a normal thing to want', () => {
    expect(
      resolveModel({ agent: null, agentTool: 'claude', kind: 'verify', model: null, effort: null }, MODELS()),
    ).toEqual({
      effort: 'xhigh',
    });
  });

  it('reaches the driver — the seam that has been dead since RUN-12', () => {
    // `DriverStartOptions.model` was threaded into query({options:{model}}) from the start and
    // nothing ever set it, because Run had no field to set it from.
    const h = harness({ manifest: MODELS() });
    const done = h.supervisor.supervise(makeRun({ kind: 'scope' }));
    return flush().then(async () => {
      h.claude.complete('done');
      await done;
      expect(h.claude.opts?.model).toBe('claude-opus-4-8');
      expect(h.claude.opts?.effort).toBe('high');
    });
  });

  it('a resumed run comes back on the SAME model it parked on', async () => {
    // The session being resumed is that model's conversation; finishing the job on a different
    // one would make "resumed with its context intact" only half true.
    const h = harness({
      manifest: MODELS(),
      parkState: { blocked: true, signalId: 's', question: 'A or B?' },
    });
    const done = h.supervisor.supervise(makeRun({ kind: 'build', anchor: { type: 'task', taskId: 't' } }));
    await flush();
    h.claude.complete('done');
    await done;

    const resumed = h.supervisor.resume('run_1', 'Use B.');
    await flush();
    h.claude.complete('done');
    await resumed;
    expect(h.claude.starts.at(-1)?.model).toBe('claude-sonnet-5');
    expect(h.claude.starts.at(-1)?.effort).toBe('medium');
  });
});

describe('per-repo backend routing (RUN-60)', () => {
  it('a repo-routed backend wins over the machine default, for EVERY workspace operation', async () => {
    const repoVcs = new FakeWorktrees();
    const h = harness({ repoVcs });
    const done = h.supervisor.supervise(makeRun());
    await flush();
    h.claude.complete('done');
    await done;
    // The whole run went to the repo's backend; the default saw nothing. Routing that split
    // one run across two backends would silently corrupt a live backend's lease.
    expect(repoVcs.created).toHaveLength(1);
    expect(repoVcs.removed).toEqual(['/wt/run_1']);
    expect(h.worktrees.created).toEqual([]);
    expect(h.worktrees.removed).toEqual([]);
  });
});

describe('disposePreservesWork (RUN-52) — the pool-of-1 wedge guard', () => {
  it('a kept build STILL disposes when the backend preserves work itself', async () => {
    // On git, "keep the unlanded diff" means skip dispose — dispose destroys. On a pool-of-1
    // backend (Diversion, Perforce) that skip holds the lease forever and wedges every later
    // run on the repo; their dispose shelves/keeps the work server-side, so disposing IS
    // keeping. The flag is how the backend says which shape it is.
    const repoVcs = new FakeWorktrees();
    (repoVcs as { disposePreservesWork?: boolean }).disposePreservesWork = true;
    const h = harness({ repoVcs });
    const done = h.supervisor.supervise(makeRun({ kind: 'build' }));
    await flush();
    h.claude.complete('done');
    await done;
    expect(repoVcs.removed).toEqual(['/wt/run_1']); // disposed despite being a kept build
  });

  it('git keeps its shape: an unlanded successful build skips dispose', async () => {
    const h = harness();
    const done = h.supervisor.supervise(makeRun({ kind: 'build' }));
    await flush();
    h.claude.complete('done');
    await done;
    expect(h.worktrees.removed).toEqual([]); // kept for the human — dispose would destroy it
  });
});

describe('the run model mix (RUN-59)', () => {
  const mix = (over: Partial<ModelUsage> = {}): ModelUsage => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUSD: 0,
    ...over,
  });
  const tel = (over: Partial<DriverTelemetry> = {}): DriverTelemetry => ({ ...zeroTelemetry(), ...over });

  describe('mergeModelUsage', () => {
    it('sums a shared model field-by-field and unions distinct models', () => {
      const merged = mergeModelUsage(
        { opus: mix({ inputTokens: 4, costUSD: 0.5 }) },
        { opus: mix({ inputTokens: 10, outputTokens: 2, costUSD: 0.1 }), haiku: mix({ inputTokens: 3 }) },
      );
      expect(merged?.opus).toEqual(mix({ inputTokens: 14, outputTokens: 2, costUSD: 0.6 }));
      expect(merged?.haiku).toEqual(mix({ inputTokens: 3 }));
    });
    it('is absent only when BOTH sides are absent', () => {
      expect(mergeModelUsage(undefined, undefined)).toBeUndefined();
      expect(mergeModelUsage({ opus: mix({ inputTokens: 1 }) }, undefined)).toEqual({
        opus: mix({ inputTokens: 1 }),
      });
    });
  });

  describe('RunTally', () => {
    it('sums spend across slots, and its mix sums to those totals', () => {
      const t = new RunTally();
      t.record(
        'primary',
        tel({
          inputTokens: 100,
          costUsd: 0.5,
          modelUsage: { opus: mix({ inputTokens: 100, costUSD: 0.5 }) },
        }),
      );
      t.record(
        'review:1',
        tel({
          inputTokens: 20,
          costUsd: 0.1,
          modelUsage: { sonnet: mix({ inputTokens: 20, costUSD: 0.1 }) },
        }),
      );
      const total = t.total();
      expect(total.inputTokens).toBe(120);
      expect(total.costUsd).toBeCloseTo(0.6);
      // The tooltip invariant: sum of per-model tokens === the run total shown beside it.
      const summed = Object.values(total.modelUsage ?? {}).reduce((a, u) => a + u.inputTokens, 0);
      expect(summed).toBe(total.inputTokens);
      expect(Object.keys(total.modelUsage ?? {})).toEqual(['opus', 'sonnet']);
    });

    it('is last-writer-wins per slot, not max — a result supersedes its own live ticks', () => {
      const t = new RunTally();
      // A live tick can transiently over-count; the authoritative result replaces it.
      t.record('primary', tel({ inputTokens: 999 })); // interim, no mix
      t.record('primary', tel({ inputTokens: 540, modelUsage: { opus: mix({ inputTokens: 540 }) } })); // the result
      expect(t.total().inputTokens).toBe(540);
      expect(t.total().modelUsage).toEqual({ opus: mix({ inputTokens: 540 }) });
    });

    it('folds un-attributable spend into the (unattributed) bucket, keeping the sum (RUN-86)', () => {
      const t = new RunTally();
      t.record('primary', tel({ inputTokens: 200 })); // codex build — spend, no per-model mix
      t.record('review:1', tel({ inputTokens: 20, modelUsage: { sonnet: mix({ inputTokens: 20 }) } }));
      const total = t.total();
      expect(total.inputTokens).toBe(220);
      // sonnet is attributed; codex's 200 lands in the reserved bucket — together they still sum,
      // instead of the old behaviour that discarded sonnet's real breakdown too.
      expect(total.modelUsage).toEqual({
        sonnet: mix({ inputTokens: 20 }),
        [UNATTRIBUTED_MODEL_ID]: mix({ inputTokens: 200 }),
      });
      const summed = Object.values(total.modelUsage ?? {}).reduce((a, u) => a + u.inputTokens, 0);
      expect(summed).toBe(total.inputTokens);
    });

    it('an all-codex run reports only the (unattributed) bucket, still summing (RUN-86)', () => {
      const t = new RunTally();
      t.record('primary', tel({ inputTokens: 150 })); // codex: tokens, no mix, no cost
      expect(t.total().modelUsage).toEqual({ [UNATTRIBUTED_MODEL_ID]: mix({ inputTokens: 150 }) });
    });

    it('a spend-less run reports no mix — the only "not reported" case left (RUN-86)', () => {
      const t = new RunTally();
      t.record('primary', tel()); // phase-only tick: no spend, no mix
      expect(t.total().modelUsage).toBeUndefined();
    });

    it('a zero-spend slot with no mix does not manufacture an empty bucket', () => {
      const t = new RunTally();
      t.record('primary', tel({ inputTokens: 100, modelUsage: { opus: mix({ inputTokens: 100 }) } }));
      t.record('conflict', tel()); // spent nothing, reported no mix — must not add an unattributed key
      expect(t.total().modelUsage).toEqual({ opus: mix({ inputTokens: 100 }) });
    });

    it('seed folds a park’s prior spend, keeping the mix summing across sittings', () => {
      const t = new RunTally();
      t.seed(
        '__prior__',
        telemetryFromSpent({
          tokens: 42,
          usd: 0.2,
          modelUsage: { opus: mix({ inputTokens: 42, costUSD: 0.2 }) },
        }),
      );
      t.record(
        'primary',
        tel({ outputTokens: 8, costUsd: 0.1, modelUsage: { opus: mix({ outputTokens: 8, costUSD: 0.1 }) } }),
      );
      const total = t.total();
      // prior 42 (in inputTokens) + this sitting's 8 output = 50 total tokens.
      expect(total.inputTokens + total.outputTokens).toBe(50);
      const opus = total.modelUsage?.opus;
      expect(opus).toMatchObject({ inputTokens: 42, outputTokens: 8 });
      expect(opus?.costUSD).toBeCloseTo(0.3);
    });

    it('a pre-RUN-59 park (spend, no mix) lands in the (unattributed) bucket, still summing (RUN-86)', () => {
      const t = new RunTally();
      t.seed('__prior__', telemetryFromSpent({ tokens: 42, usd: 0.2 })); // no modelUsage → unattributed
      t.record('primary', tel({ outputTokens: 8, modelUsage: { opus: mix({ outputTokens: 8 }) } }));
      const total = t.total();
      expect(total.inputTokens + total.outputTokens).toBe(50);
      expect(total.modelUsage).toEqual({
        opus: mix({ outputTokens: 8 }),
        // telemetryFromSpent puts prior tokens in inputTokens and usd in costUSD.
        [UNATTRIBUTED_MODEL_ID]: mix({ inputTokens: 42, costUSD: 0.2 }),
      });
    });

    it('the reserved bucket key is exactly the wire literal the dashboard renders (RUN-86/87)', () => {
      // Imported straight from the vendored @noriq-dev/shared now (RUN-87 refreshed it); this pins
      // the byte-identical value the runner emits and the dashboard keys on.
      expect(UNATTRIBUTED_MODEL_ID).toBe('(unattributed)');
    });
  });

  it('folds an Opus build + a Sonnet reviewer into ONE mix that sums to the run total', async () => {
    // The exact case the reviewer flagged: a second session on a DIFFERENT model must appear in the
    // run's "actual" mix, and the breakdown must still sum to the reported total.
    const reviewed = manifest({
      verify: {
        cmd: 'npm test',
        timeoutSeconds: null,
        shell: null,
        maxRounds: 2,
        agent: { agent: null, tool: null, model: null, effort: null, maxRounds: 2 },
      },
    });
    const h = harness({ manifest: reviewed });
    const done = h.supervisor.supervise(
      makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } }),
    );
    await flush();
    // The build turn: Opus.
    h.claude.complete('done', {
      inputTokens: 100,
      costUsd: 0.5,
      modelUsage: { 'claude-opus-4-8': mix({ inputTokens: 100, costUSD: 0.5 }) },
    });
    // Wait for the reviewer session.
    for (let i = 0; i < 100 && h.claude.opts?.runId !== 'run_1:review'; i++) await flush();
    expect(h.claude.opts?.runId).toBe('run_1:review');
    h.claude.emitText('Judged the diff.\nVERDICT: PASS');
    // The reviewer turn: Sonnet — a real, different model spending real tokens.
    h.claude.complete('done', {
      inputTokens: 20,
      costUsd: 0.1,
      modelUsage: { 'claude-sonnet-4-5': mix({ inputTokens: 20, costUSD: 0.1 }) },
    });
    const exit = await done;
    expect(exit.outcome).toBe('done');
    // The terminal report carries BOTH models, summing to the run total.
    const terminal = h.reports.filter((r) => r.status === 'done').at(-1);
    const runMix = terminal?.telemetry?.modelUsage;
    expect(Object.keys(runMix ?? {}).sort()).toEqual(['claude-opus-4-8', 'claude-sonnet-4-5']);
    expect(terminal?.telemetry?.inputTokens).toBe(120);
    const summed = Object.values(runMix ?? {}).reduce((a, u) => a + u.inputTokens, 0);
    expect(summed).toBe(terminal?.telemetry?.inputTokens);
    // And the returned exit agrees with what was reported.
    expect(exit.telemetry.modelUsage).toEqual(runMix);
  });

  it('a codex build + a claude reviewer reports the claude mix + an (unattributed) bucket (RUN-86)', async () => {
    const reviewed = manifest({
      tool: 'codex',
      verify: {
        cmd: 'npm test',
        timeoutSeconds: null,
        shell: null,
        maxRounds: 2,
        agent: { agent: null, tool: 'claude', model: null, effort: null, maxRounds: 2 },
      },
    });
    const h = harness({ manifest: reviewed });
    const done = h.supervisor.supervise(
      makeRun({ kind: 'build', agentTool: 'codex', anchor: { type: 'task', taskId: 'task_9' } }),
    );
    await flush();
    // Codex build: spend, but no per-model mix (the driver cannot attribute it).
    h.codex.complete('done', { inputTokens: 200 });
    for (let i = 0; i < 100 && h.claude.opts?.runId !== 'run_1:review'; i++) await flush();
    expect(h.claude.opts?.runId).toBe('run_1:review');
    h.claude.emitText('Judged the diff.\nVERDICT: PASS');
    h.claude.complete('done', {
      inputTokens: 20,
      modelUsage: { 'claude-sonnet-4-5': mix({ inputTokens: 20 }) },
    });
    const exit = await done;
    expect(exit.outcome).toBe('done');
    const terminal = h.reports.filter((r) => r.status === 'done').at(-1);
    expect(terminal?.telemetry?.inputTokens).toBe(220); // totals count both
    // The claude reviewer's real breakdown survives; codex's un-attributable 200 lands in the
    // reserved bucket, so the mix still sums to the total (RUN-86) instead of being dropped whole.
    expect(terminal?.telemetry?.modelUsage).toEqual({
      'claude-sonnet-4-5': mix({ inputTokens: 20 }),
      [UNATTRIBUTED_MODEL_ID]: mix({ inputTokens: 200 }),
    });
  });

  it('persists the run mix into the park and re-seeds it on resume, still summing', async () => {
    const h = harness({ parkState: { blocked: true, question: 'Which API?' } });
    const done = h.supervisor.supervise(
      makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } }),
    );
    await flush();
    h.claude.complete('done', {
      inputTokens: 100,
      costUsd: 0.5,
      modelUsage: { 'claude-opus-4-8': mix({ inputTokens: 100, costUSD: 0.5 }) },
    });
    await done;
    const parked = await h.parked.get('run_1');
    // The park carries the per-model breakdown, not just the aggregate.
    expect(parked!.spent.modelUsage).toEqual({ 'claude-opus-4-8': mix({ inputTokens: 100, costUSD: 0.5 }) });

    h.answerIt();
    const resumed = h.supervisor.resume('run_1', 'Use v2.');
    await flush();
    h.claude.complete('done', {
      outputTokens: 10,
      costUsd: 0.1,
      modelUsage: { 'claude-opus-4-8': mix({ outputTokens: 10, costUSD: 0.1 }) },
    });
    const exit = await resumed;
    // Opus spend from both sittings, merged; the mix still sums to the run total.
    expect(exit!.telemetry.modelUsage?.['claude-opus-4-8']).toEqual(
      mix({ inputTokens: 100, outputTokens: 10, costUSD: 0.6 }),
    );
    const total = exit!.telemetry;
    const summed = Object.values(total.modelUsage ?? {}).reduce(
      (a, u) => a + u.inputTokens + u.outputTokens,
      0,
    );
    expect(summed).toBe(total.inputTokens + total.outputTokens);
  });
});

// RUN-131. The extraction moved the optional deps onto a stage host, and a bare function copied
// across changes what `this` is when it runs: `this.deps.checkClaimable(id)` calls with `deps` as
// the receiver, `host.checkClaimable(id)` calls with the HOST. A dep written as a method — which
// the declared type allows — would start throwing, and the claimability probe swallows a throw as
// a transient failure and fails OPEN. That is the phase gate silently ceasing to exist.
describe('an optional dep keeps its own receiver (RUN-131)', () => {
  it('a method-style checkClaimable still declines the spawn', async () => {
    const worktrees = new FakeWorktrees();
    const claude = new FakeDriver('claude');
    const reports: Array<{ runId: string } & RunReport> = [];
    // `drivers` is deliberately the member it reads: the deps object has one and the stage host
    // does not, so a lost receiver is a TypeError rather than a silent coincidence.
    const deps = {
      drivers: { claude },
      vcs: worktrees,
      resolveRepo: () => ({ root: '/repos/repo_a', manifest: manifest() }),
      report: (runId: string, r: RunReport) => reports.push({ runId, ...r }),
      createRunAgent: async () => testAgent(),
      server: 'https://noriq.example',
      pathProbe: async () => 'missing' as const,
      readDoc: async () => '',
      async checkClaimable(_taskId: string) {
        const tools = Object.keys(this.drivers).join(',');
        return { claimable: false, reason: `no phase for ${tools}` };
      },
    };
    const supervisor = new RunSupervisor(deps);
    const exit = await supervisor.supervise(
      makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } }),
    );
    expect(exit.outcome).toBe('failed');
    expect(exit.reason).toMatch(/not claimable yet.*no phase for claude/s);
    // And it really did decline BEFORE the lease — a fail-open would have leased and spawned.
    expect(worktrees.created).toEqual([]);
  });
});

// RUN-132. `effectiveKind` is the daemon's authoritative answer to "what posture is this", and its
// result indexes fixed-key records everywhere downstream — `manifest.permissions[kind]`,
// `manifest.defaults[kind]`, `noriqToolNamesFor(kind)`. A kind outside the union yields `undefined`
// from every one of them, and the write clamp then throws on the permission it was handed. A WS
// dispatch is schema-validated; a PARKED run is rehydrated from JSON on disk without revalidation,
// which is the path that makes this reachable rather than theoretical.
describe('effectiveKind never answers with a kind that is not one (RUN-132)', () => {
  const M = { workflows: {} } as never;

  it('passes a real kind through', () => {
    expect(effectiveKind({ kind: 'build', workflow: null }, M)).toBe('build');
    expect(effectiveKind({ kind: 'verify', workflow: null }, M)).toBe('verify');
  });

  it('degrades an unrecognised kind to scope — the narrowest posture, not the nearest', () => {
    expect(effectiveKind({ kind: 'deploy' as never, workflow: null }, M)).toBe('scope');
  });

  // The membership test has to be `Object.hasOwn`: `'toString' in BUILTIN_WORKFLOWS` is true, so an
  // `in` check waves through exactly the keys the guard exists to catch.
  it('does not mistake a prototype property for a kind', () => {
    for (const k of ['toString', 'constructor', '__proto__', 'valueOf']) {
      expect(effectiveKind({ kind: k as never, workflow: null }, M)).toBe('scope');
    }
  });

  it('a custom workflow still decides the posture, and it is still a real kind', () => {
    const withDocs = { workflows: { docs: { base: 'scope', prompt: null } } } as never;
    // The dispatched kind says build; the workflow's base says scope, and the daemon holds the
    // manifest — so a client selecting a read-only workflow cannot leave `kind = build` and write.
    expect(effectiveKind({ kind: 'build', workflow: 'docs' }, withDocs)).toBe('scope');
  });
});

// RUN-133. The ticket's own acceptance: "a run with builder + reviewer + conflict sessions cannot
// collectively exceed its dispatched budget, proven by a test." Before this, each `startAgent` was
// handed a fresh copy of the ceiling and `superviseBudget` watched only that session's telemetry —
// so a build with a reviewer and a conflict turn could spend the dispatched budget three times and
// no single check would ever fire.
describe('one ceiling across the whole run (RUN-133)', () => {
  const CEILING = (over: Partial<RunBudget> = {}): RunBudget => ({
    maxTokens: 1000,
    maxUsd: null,
    maxDurationSeconds: null,
    maxRounds: null,
    ...over,
  });
  const REVIEWED = () =>
    manifest({
      verify: {
        cmd: 'npm test',
        timeoutSeconds: null,
        shell: null,
        maxRounds: 2,
        agent: { agent: null, tool: null, model: null, effort: null, maxRounds: 2 },
      },
    });
  const buildRun = () => makeRun({ kind: 'build', anchor: { type: 'task', taskId: 'task_9' } });
  const onReviewTurn = async (h: ReturnType<typeof harness>) => {
    for (let i = 0; i < 100; i++) {
      if (h.claude.opts?.runId === 'run_1:review') return true;
      await new Promise((r) => setTimeout(r, 0));
    }
    return false;
  };

  it('the builder gets the whole ceiling — it is the first session to spend', async () => {
    const h = harness({ manifest: REVIEWED(), defaultBudget: CEILING() });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    expect(h.claude.starts[0]?.budget?.maxTokens).toBe(1000);
    h.claude.complete('done', { outputTokens: 100 });
    await onReviewTurn(h);
    h.claude.emitText('VERDICT: PASS');
    h.claude.complete('done');
    await done;
  });

  // The property that was missing: the reviewer's ceiling is the REMAINDER, so builder + reviewer
  // sum to the dispatched budget instead of each getting all of it.
  it('the reviewer gets what is LEFT, not another copy of the ceiling', async () => {
    const h = harness({ manifest: REVIEWED(), defaultBudget: CEILING() });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done', { outputTokens: 900 }); // the builder burned 900 of 1000
    expect(await onReviewTurn(h)).toBe(true);
    const review = h.claude.starts[1]!;
    expect(review.runId).toBe('run_1:review');
    expect(review.budget?.maxTokens).toBe(100); // 1000 − 900, not 1000
    h.claude.emitText('VERDICT: PASS');
    h.claude.complete('done');
    await done;
  });

  // A gate that could not run is not a gate that passed — the same posture as a reviewer that
  // crashed. And nothing is spawned merely to be SIGTERMed a moment later.
  it('a builder that spends the whole ceiling leaves no reviewer to spawn — and gates the run', async () => {
    const h = harness({ manifest: REVIEWED(), defaultBudget: CEILING() });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done', { outputTokens: 1000 }); // exactly the ceiling
    const exit = await done;
    expect(h.claude.starts).toHaveLength(1); // the reviewer never started
    expect(exit.outcome).toBe('failed');
    expect(exit.reason).toBe('review:no-verdict');
    // The findings say WHY, so the comment a human reads is not "the reviewer found problems".
    expect(h.comments.some((c) => /could not run.*token ceiling/s.test(c.body))).toBe(true);
  });

  // A dispatch with no ceiling on any dimension is unbounded, and subtracting from `null` must
  // leave `null` rather than inventing a limit — otherwise the allocator would quietly start
  // capping runs nobody capped.
  it('an unbounded run still spawns everything, however much the builder spent', async () => {
    const h = harness({ manifest: REVIEWED() }); // no defaultBudget, run.budget all null
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done', { outputTokens: 10_000_000 });
    expect(await onReviewTurn(h)).toBe(true);
    expect(h.claude.starts[1]?.budget).toEqual({
      maxTokens: null,
      maxUsd: null,
      maxDurationSeconds: null,
      maxRounds: null,
    });
    h.claude.emitText('VERDICT: PASS');
    h.claude.complete('done');
    await done;
  });

  // The hole an adversarial review found in the first pass at this task, and the one that defeats
  // its own acceptance: the builder's session is kept OPEN across the reviewer's spend (RUN-29), so
  // its reservation is stale by the time it is handed work back. Checking its own cumulative
  // against that stale number lets the RUN exceed its ceiling while no single session breaches.
  it('a builder handed work back after the reviewer spent is held to the RUN, not its own snapshot', async () => {
    const h = harness({ manifest: REVIEWED(), defaultBudget: CEILING() });
    h.claude.continueTokens = [100]; // the fix turn takes the builder's cumulative to exactly 1000
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done', { outputTokens: 900 }); // builder: 900, inside its own 1000 allowance
    expect(await onReviewTurn(h)).toBe(true);
    h.claude.emitText('VERDICT: FAIL\nFINDING 1 [High] src/a.ts:1: fix this');
    h.claude.complete('done', { outputTokens: 50 }); // reviewer: 50 → the run is now at 950
    await flush();
    await flush();

    // The builder's OWN cumulative after the fix turn is 900 + 100 = 1000, which is not `> 1000` —
    // its per-session check is satisfied and always would have been, because its allowance was
    // computed before the reviewer existed. The RUN is at 1050. Only a guard that can see every
    // session catches this, which is why the reservation alone was not enough.
    // Not `stopped` — settle stops every session. This flag is only set when the stop landed
    // DURING the fix turn, which is the run-level guard and nothing else.
    expect(h.claude.stoppedDuringFix).toBe(true);
    const exit = await done;
    expect(exit.outcome).toBe('failed');
    // Nowhere near the 3× a per-session ceiling permitted: builder + reviewer + one fix turn, all
    // out of one budget.
    expect(totalTokens(exit.telemetry)).toBeLessThan(1100);
  });

  // The same session, but the spend fits — the guard must not fire on a run that is within budget.
  it('…and left alone when the hand-back fits inside what is left', async () => {
    const h = harness({
      manifest: REVIEWED(),
      defaultBudget: CEILING(),
      verifyResults: [false, true],
    });
    h.claude.continueTokens = [100];
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done', { outputTokens: 700 });
    expect(await onReviewTurn(h)).toBe(true);
    h.claude.emitText('VERDICT: PASS');
    h.claude.complete('done');
    const exit = await done;
    expect(exit.outcome).toBe('done');
  });

  // The third session, and the one most likely to find the ceiling gone. Unresolved is the honest
  // answer: the caller aborts the rebase and the diff waits on its branch, exactly as it would for
  // a conflict the agent could not fix.
  it('a conflict turn with nothing left leaves the rebase unresolved rather than spawning', async () => {
    const withLand = REVIEWED();
    withLand.land = {
      branch: 'main',
      strategy: 'rebase',
      autoPush: false,
      allowedBranches: [],
      resolveConflicts: true,
    } as never;
    const h = harness({ manifest: withLand, defaultBudget: CEILING(), conflicts: ['src/a.ts'] });
    const done = h.supervisor.supervise(buildRun());
    await flush();
    h.claude.complete('done', { outputTokens: 400 });
    expect(await onReviewTurn(h)).toBe(true);
    h.claude.emitText('VERDICT: PASS');
    h.claude.complete('done', { outputTokens: 600 }); // reviewer takes the rest: 400 + 600 = 1000
    const exit = await done;
    // No conflict session was ever started — only the builder and the reviewer.
    expect(h.claude.starts.map((s) => s.runId)).toEqual(['run_1', 'run_1:review']);
    expect(exit.reason).toBe('land:conflict');
  });
});

// RUN-165. The bug, at the level it actually bit: a cancel during a non-fatal pre-execution stage
// stopped that actor and the pipeline read the dead session as "produced nothing", then built.
describe('a cancelled run does not go on to build (RUN-165)', () => {
  it('refuses to spawn the agent when the run was already cancelled', async () => {
    const h = harness({ cancelled: ['run_1'] });
    const exit = await h.supervisor.supervise(makeRun({ kind: 'build' }));
    expect(exit).toMatchObject({ outcome: 'failed', reason: 'cancelled' });
    expect(h.claude.starts).toHaveLength(0);
  });

  // The control is the rest of this file: every other test here wires no cancellation and reaches
  // its agent, so a guard that stopped everything could not have got this far.
});
