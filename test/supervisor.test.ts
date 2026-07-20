import type { ModelDefault, PermissionProfile, ProjectManifest, Run, RunBudget } from '@noriq-dev/shared';
import { UNATTRIBUTED_MODEL_ID } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import type { ParkState, RunAgent } from '../src/client';
import type { ContinuableRun } from '../src/continuable';
import type {
  AgentDriver,
  DriverExit,
  DriverSession,
  DriverStartOptions,
  DriverTelemetry,
  ModelUsage,
} from '../src/drivers/types';
import { zeroTelemetry } from '../src/drivers/types';
import type { LockConflict } from '../src/lock-client';
import type { ParkedRun } from '../src/parked';
import { noriqToolNamesFor } from '../src/security';
import {
  type RunReport,
  RunSupervisor,
  RunTally,
  assemblePrompt,
  mergeBudget,
  mergeModelUsage,
  resolveModel,
  telemetryFromSpent,
} from '../src/supervisor';
import type { LockContext, LockOutcome, Workspace } from '../src/vcs/types';

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
  /** True once stop() was called — a multiTurn session that nobody closes hangs the daemon. */
  stopped = false;
  constructor(readonly tool: 'claude' | 'codex') {}
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
            const outcome = this.continueOutcomes.shift() ?? 'done';
            return {
              outcome,
              isError: outcome === 'failed',
              reason: outcome === 'failed' ? 'died mid-fix' : null,
              telemetry: zeroTelemetry(),
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
  hasWork = async (): Promise<boolean> => {
    this.hasChangesCalls += 1;
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
  changedPaths = async (): Promise<string[]> => this.changedFiles;
  lock = async (_ws: Workspace, paths: string[], ctx: LockContext): Promise<LockOutcome> => {
    this.lockCalls.push({ paths, ctx });
    return this.lockConflicts.length
      ? { ok: false, conflicts: this.lockConflicts }
      : { ok: true, enabled: true, locks: paths.map((p) => ({ id: p, path: p })) };
  };
  unlock = async (_ws: Workspace, sel: { lockIds?: string[]; paths?: string[] }): Promise<void> => {
    this.releases.push({ paths: sel.paths });
  };
  /** Every terminal release-all (RUN-104), by the run's holder token. */
  releasedAll: string[] = [];
  /** Ordered log of landing vs lock-release, to prove locks are HELD THROUGH the merge and
   *  released AFTER it (RUN-105). */
  timeline: Array<'land' | 'release'> = [];
  releaseRunLocks = async (_ws: Workspace, ctx: LockContext): Promise<void> => {
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
  network: 'restricted',
  allow: [],
  deny: [],
  auto: false,
});
const noModel = (): ModelDefault => ({ model: null, effort: null });
const manifest = (over: Partial<ProjectManifest> = {}): ProjectManifest => ({
  key: 'PROJ',
  board: null,
  verify: { cmd: 'npm test', timeoutSeconds: null, shell: null, maxRounds: 2, agent: null },
  tool: null,
  defaultBranch: null,
  land: null,
  permissions: { scope: perm(false), build: perm(true), verify: perm(false) },
  // No per-kind model/effort by default: this repo takes whatever the tool defaults to,
  // which is what every run got before RUN-33 existed.
  defaults: { scope: noModel(), build: noModel(), verify: noModel() },
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
    /** The declared scope the predictive resolver returns (RUN-103); presence wires the dep. */
    lockScope?: string[] | null;
  } = {},
) {
  const worktrees = new FakeWorktrees();
  if (over.changed === false) worktrees.changed = false;
  if (over.createFails) worktrees.createFails = true;
  if (over.conflicts) worktrees.conflicts = over.conflicts;
  if (over.stillConflicted) worktrees.stillConflicted = over.stillConflicted;
  if (over.landRaces) worktrees.landRaces = true;
  if (over.changedFiles) worktrees.changedFiles = over.changedFiles;
  if (over.lockConflicts) worktrees.lockConflicts = over.lockConflicts;
  const reports: Array<{ runId: string } & RunReport> = [];
  const transcript: Array<{ seq: number; role: string; round: number | null; text: string }> = [];
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
    report: (runId, r) => reports.push({ runId, ...r }),
    reportLog: (_runId, segments) => transcript.push(...segments),
    postComment: (projectId, taskId, body) => comments.push({ projectId, taskId, body }),
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

  it('build failure: worktree cleaned up', async () => {
    const h = harness();
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
    });
    const exit = await h.supervisor.supervise(buildRun());
    expect(exit.outcome).toBe('failed');
    expect(exit.reason).toMatch(/locked by another run/);
    expect(h.claude.starts).toHaveLength(0); // never spawned — refused, not raced
    expect(h.worktrees.removed).toEqual(['/wt/run_1']); // the just-leased worktree is disposed
    expect(h.comments.some((c) => c.body.includes('src/hot.ts'))).toBe(true);
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
    expect(h.worktrees.timeline).toEqual(['land', 'release']); // land first, THEN release
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
        agent: { tool: null, model: null, effort: null, maxRounds: 2, ...agent },
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
  const priorLedgerEntry = {
    id: 1,
    round: 2,
    severity: 'high',
    location: 'src/auth.ts:42',
    claim: 'THE-PRIOR-FINDING-ABOUT-AUTH',
    status: 'fixed' as const,
    pointer: 'src/auth.ts:50',
    reason: 'guarded now',
  };

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
    await runF;
    const record = failed.continuable.puts.at(-1);
    expect(record?.runId).toBe('run_1');
    expect(record?.ledger.length).toBeGreaterThan(0); // the reviewer's finding is carried forward
    expect(failed.continuable.entries.has('run_1')).toBe(true);

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

  it('with [land]: the reviewer judges intent BEFORE landing, and a PASS lands', async () => {
    const h = harness({
      manifest: {
        ...LANDING(),
        verify: {
          cmd: 'npm test',
          timeoutSeconds: null,
          shell: null,
          maxRounds: 2,
          agent: { tool: null, model: null, effort: null, maxRounds: 2 },
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
          agent: { tool: null, model: null, effort: null, maxRounds: 0 },
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
    m.defaults.verify = { model: 'claude-sonnet-5', effort: 'high' }; // the OTHER vendor's model
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
    m.defaults.verify = { model: 'claude-sonnet-5', effort: 'xhigh' };
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
        scope: { model: 'claude-opus-4-8', effort: 'high' },
        build: { model: 'claude-sonnet-5', effort: 'medium' },
        verify: { model: null, effort: 'xhigh' },
        ...over,
      },
    });

  it('the dispatch wins — a human chose, for this run', () => {
    expect(resolveModel({ kind: 'build', model: 'claude-fable-5', effort: 'max' }, MODELS())).toEqual({
      model: 'claude-fable-5',
      effort: 'max',
    });
  });

  it('falls back to the repo’s default for THAT kind', () => {
    // The point of per-kind: scope is exploration and judgment, build is execution.
    expect(resolveModel({ kind: 'scope', model: null, effort: null }, MODELS())).toEqual({
      model: 'claude-opus-4-8',
      effort: 'high',
    });
    expect(resolveModel({ kind: 'build', model: null, effort: null }, MODELS())).toEqual({
      model: 'claude-sonnet-5',
      effort: 'medium',
    });
  });

  it('merges per FIELD — naming only a model keeps the repo’s effort', () => {
    // Whole-object merge would mean the one field a dispatcher set silently erased the other,
    // which is the bug mergeBudget already exists to avoid.
    expect(resolveModel({ kind: 'build', model: 'claude-fable-5', effort: null }, MODELS())).toEqual({
      model: 'claude-fable-5',
      effort: 'medium', // the repo's
    });
  });

  it('says NOTHING when nobody chose — the tool keeps its own default', () => {
    // The pre-RUN-33 behaviour, and it must stay reachable: absent, not null, because the
    // drivers only pass through what is present.
    expect(resolveModel({ kind: 'build', model: null, effort: null }, manifest())).toEqual({});
  });

  it('an effort with no model is a normal thing to want', () => {
    expect(resolveModel({ kind: 'verify', model: null, effort: null }, MODELS())).toEqual({
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
        agent: { tool: null, model: null, effort: null, maxRounds: 2 },
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
        agent: { tool: 'claude', model: null, effort: null, maxRounds: 2 },
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
