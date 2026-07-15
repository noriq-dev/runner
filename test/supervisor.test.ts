import type { PermissionProfile, ProjectManifest, Run, RunBudget } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import type { RunAgent } from '../src/client';
import type {
  AgentDriver,
  DriverExit,
  DriverSession,
  DriverStartOptions,
  DriverTelemetry,
} from '../src/drivers/types';
import { zeroTelemetry } from '../src/drivers/types';
import { type RunReport, RunSupervisor, assemblePrompt, mergeBudget } from '../src/supervisor';
import type { WorktreeInfo } from '../src/worktree';

// A driver whose run the test completes by calling complete() — which drives the
// wrapped onExit (superviseBudget resolves its done from it).
class FakeDriver implements AgentDriver {
  opts?: DriverStartOptions;
  /** Turns handed back by the supervisor (RUN-29's verify feedback loop). */
  continuations: string[] = [];
  /** Outcome of each continueWith, in order. Defaults to 'done' — the agent fixed it. */
  continueOutcomes: Array<'done' | 'failed'> = [];
  /** True once stop() was called — a multiTurn session that nobody closes hangs the daemon. */
  stopped = false;
  constructor(readonly tool: 'claude' | 'codex') {}
  start(opts: DriverStartOptions): DriverSession {
    this.opts = opts;
    return {
      runId: opts.runId,
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
  complete(outcome: 'done' | 'failed'): void {
    this.opts?.handlers?.onExit?.({
      outcome,
      isError: outcome === 'failed',
      reason: outcome === 'failed' ? 'boom' : null,
      telemetry: { ...zeroTelemetry(), outputTokens: 42 },
    });
  }
}

class FakeWorktrees {
  created: Array<{ root: string; runId: string; readOnly: boolean; baseRef?: string }> = [];
  removed: string[] = [];
  /** Whether the agent left a diff. Defaults true — most tests model real work. */
  changed = true;
  hasChangesCalls = 0;
  /** Set to make create() reject, modelling a branch that no longer exists. */
  createFails = false;
  create = async (
    root: string,
    runId: string,
    opts: { readOnly?: boolean; baseRef?: string } = {},
  ): Promise<WorktreeInfo> => {
    if (this.createFails) throw new Error(`invalid reference: ${opts.baseRef}`);
    this.created.push({ root, runId, readOnly: !!opts.readOnly, baseRef: opts.baseRef });
    return {
      runId,
      repoRoot: root,
      path: `/wt/${runId}`,
      branch: `noriq/run/${runId}`,
      readOnly: !!opts.readOnly,
      baseSha: 'base0000',
    };
  };
  hasChanges = async (): Promise<boolean> => {
    this.hasChangesCalls += 1;
    return this.changed;
  };
  commits: Array<{ path: string; message: string }> = [];
  commitWork = async (info: { path: string }, message: string): Promise<boolean> => {
    this.commits.push({ path: info.path, message });
    return this.changed;
  };
  remove = async (info: { path: string }): Promise<void> => {
    this.removed.push(info.path);
  };

  // ── landing ────────────────────────────────────────────────────────────────
  /** Branches that exist. The landing branch is absent until something creates it. */
  branches = new Set<string>(['main']);
  createdBranches: Array<{ branch: string; from: string }> = [];
  /** Paths git cannot merge on the next rebase; empty = clean. */
  conflicts: string[] = [];
  /** Set by continueRebase's outcome — what the "agent" left behind. */
  stillConflicted: string[] = [];
  rebases: string[] = [];
  aborted = 0;
  landings: Array<{ branch: string; fromRef: string }> = [];
  /** Make landFastForward throw, modelling a branch that moved under us. */
  landRaces = false;

  refExists = async (_root: string, ref: string): Promise<boolean> => this.branches.has(ref);
  createBranch = async (_root: string, branch: string, from: string): Promise<void> => {
    this.branches.add(branch);
    this.createdBranches.push({ branch, from });
  };
  rebaseOnto = async (
    _info: { path: string },
    onto: string,
  ): Promise<{ ok: true } | { ok: false; conflicts: string[] }> => {
    this.rebases.push(onto);
    return this.conflicts.length ? { ok: false, conflicts: this.conflicts } : { ok: true };
  };
  continueRebase = async (): Promise<{ ok: true } | { ok: false; conflicts: string[] }> =>
    this.stillConflicted.length ? { ok: false, conflicts: this.stillConflicted } : { ok: true };
  abortRebase = async (): Promise<void> => {
    this.aborted += 1;
  };
  landFastForward = async (
    _root: string,
    branch: string,
    fromRef: string,
  ): Promise<{ ok: true; sha: string } | { ok: false; reason: 'race' | 'error'; detail: string }> => {
    if (this.landRaces) return { ok: false, reason: 'race', detail: `${branch} has moved on` };
    if (this.landRefuses) return { ok: false, reason: 'error', detail: this.landRefuses };
    this.landings.push({ branch, fromRef });
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
  pushBranch = async (
    root: string,
    branch: string,
  ): Promise<{ ok: true } | { ok: false; detail: string }> => {
    this.pushes.push({ root, branch });
    return this.pushFails ? { ok: false, detail: this.pushFails } : { ok: true };
  };
}

const perm = (write: boolean): PermissionProfile => ({ write, network: 'restricted', allow: [], deny: [] });
const manifest = (over: Partial<ProjectManifest> = {}): ProjectManifest => ({
  key: 'PROJ',
  verify: { cmd: 'npm test', timeoutSeconds: null },
  tool: null,
  defaultBranch: null,
  land: null,
  permissions: { scope: perm(false), build: perm(true), verify: perm(false) },
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
  budget: { maxTokens: null, maxUsd: null, maxDurationSeconds: null },
  status: 'dispatched',
  // Not yet started, so nothing to report (RUN-31). The daemon sets the phase; the server
  // only ever reads it back to us.
  phase: null,
  exit: null,
  worktreePath: null,
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
  } = {},
) {
  const worktrees = new FakeWorktrees();
  if (over.changed === false) worktrees.changed = false;
  if (over.createFails) worktrees.createFails = true;
  if (over.conflicts) worktrees.conflicts = over.conflicts;
  if (over.stillConflicted) worktrees.stillConflicted = over.stillConflicted;
  if (over.landRaces) worktrees.landRaces = true;
  const reports: Array<{ runId: string } & RunReport> = [];
  const comments: Array<{ projectId: string; taskId: string; body: string }> = [];
  const claude = new FakeDriver('claude');
  const codex = new FakeDriver('codex');
  let verifyRan = false;
  let verifyCalls = 0;
  const supervisor = new RunSupervisor({
    drivers: over.drivers ?? { claude, codex },
    worktrees,
    resolveRepo: (repoRef) =>
      over.hasRepo === false ? null : { root: `/repos/${repoRef}`, manifest: over.manifest ?? manifest() },
    report: (runId, r) => reports.push({ runId, ...r }),
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
    createRunAgent: async () => testAgent(),
    server: 'https://noriq.example',
    defaultBudget: over.defaultBudget,
  });
  return {
    supervisor,
    worktrees,
    reports,
    comments,
    claude,
    codex,
    verifyRan: () => verifyRan,
    verifyCalls: () => verifyCalls,
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
    expect(p).toMatch(/never push/);
    expect(p).toContain('npm test'); // verify cmd
    expect(p).toContain('task_9');
  });
  it('tells the build agent the daemon commits, so it stops reporting that as a failure', () => {
    // A real run ended with "⚠️ Not committed — a human needs to commit it" 71s AFTER
    // the daemon had already committed it. The prompt never said who commits.
    const p = assemblePrompt(makeRun({ kind: 'build' }), manifest(), {
      agent: testAgent(),
      server: 'https://s',
    });
    expect(p).toMatch(/do NOT need to commit/i);
    expect(p).toMatch(/daemon commits/i);
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
  const machine: RunBudget = { maxTokens: 500_000, maxUsd: 5, maxDurationSeconds: 1800 };
  const empty: RunBudget = { maxTokens: null, maxUsd: null, maxDurationSeconds: null };

  it('falls back to the machine ceilings when the Run carries none', () => {
    // The dashboard dispatch form leaves these blank by default — without the
    // fallback such a Run would execute with no ceiling at all.
    expect(mergeBudget(empty, machine)).toEqual(machine);
    expect(mergeBudget(null, machine)).toEqual(machine);
  });

  it('lets the Run win per-dimension, not whole-object', () => {
    // Setting only maxUsd must NOT silently drop the machine's token/time ceilings.
    expect(mergeBudget({ maxTokens: null, maxUsd: 1, maxDurationSeconds: null }, machine)).toEqual({
      maxTokens: 500_000,
      maxUsd: 1,
      maxDurationSeconds: 1800,
    });
  });

  it('honours an explicit Run budget above the machine default (default, not clamp)', () => {
    expect(mergeBudget({ maxTokens: null, maxUsd: 50, maxDurationSeconds: null }, machine)?.maxUsd).toBe(50);
  });

  it('stays unbounded only when nothing is configured anywhere', () => {
    expect(mergeBudget(null, null)).toBeNull();
    expect(mergeBudget(empty, null)).toEqual(empty);
  });
});

describe('RunSupervisor budget defaults', () => {
  it('runs a budget-less dispatch under the machine ceilings from runner.toml', async () => {
    const { supervisor, claude } = harness({
      defaultBudget: { maxTokens: 500_000, maxUsd: 5, maxDurationSeconds: 1800 },
    });
    const run = supervisor.supervise(makeRun({ kind: 'scope' }));
    await flush();
    claude.complete('done');
    await run;

    // The whole point: an unbudgeted dispatch must not reach the driver unbounded.
    expect(claude.opts?.budget).toEqual({ maxTokens: 500_000, maxUsd: 5, maxDurationSeconds: 1800 });
  });

  it('still lets an explicit Run budget take precedence', async () => {
    const { supervisor, claude } = harness({
      defaultBudget: { maxTokens: 500_000, maxUsd: 5, maxDurationSeconds: 1800 },
    });
    const run = supervisor.supervise(
      makeRun({ kind: 'scope', budget: { maxTokens: null, maxUsd: 1, maxDurationSeconds: null } }),
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
    expect(h.worktrees.created[0]?.baseRef).toBe('noriq/run/run_build7');
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
    expect(exit.reason).toContain('noriq/run/run_build7');
  });

  it('leaves scope/build runs branching from HEAD', async () => {
    const h = harness();
    const done = h.supervisor.supervise(makeRun({ kind: 'build' }));
    await flush();
    expect(h.worktrees.created[0]?.baseRef).toBeUndefined();
    h.claude.complete('done');
    await done;
  });

  it('ignores verifiesRunId on a non-verify run', async () => {
    const h = harness();
    const done = h.supervisor.supervise(makeRun({ kind: 'build', verifiesRunId: 'run_build7' }));
    await flush();
    expect(h.worktrees.created[0]?.baseRef).toBeUndefined();
    h.claude.complete('done');
    await done;
  });

  it('still works for an unanchored verify run (plain git diff)', async () => {
    const h = harness();
    const done = h.supervisor.supervise(makeRun({ kind: 'verify', verifiesRunId: null }));
    await flush();
    expect(h.worktrees.created[0]?.baseRef).toBeUndefined();
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
