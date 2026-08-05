import type { Run } from '@noriq-dev/shared';
import { ExecutionSpec } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import type { RunAgent } from '../src/client';
import type { BudgetRun } from '../src/drivers/budget';
import type {
  AgentDriver,
  DriverCapabilities,
  DriverExit,
  DriverSession,
  DriverStartOptions,
} from '../src/drivers/types';
import { zeroTelemetry } from '../src/drivers/types';
import { type ChainPlan, type ChainWave, type ExecuteHost, executeChain } from '../src/stages';
import { stepWorkspaceId } from '../src/steps';
import { type ResolvedRepo, RunTally } from '../src/supervisor';
import type { IntegrateResult, PublishResult, Workspace } from '../src/vcs/types';

// RUN-170. A wave's steps actually overlap: a workspace per overlapping step, budget SHARES of one
// reservation, serial integrate-back, and honest degradation to the sequential chain everywhere
// overlap is not safe. Chain coverage otherwise rides supervisor.test.ts (the RUN-168 describe);
// this file exists because a concurrency test that runs steps one at a time cannot catch the
// budget bug — the assertions here hold sessions OPEN and check what is true while both are live.
//
// One structural rule shapes most fixtures: the last SCHEDULED step always runs sequentially in
// the parent workspace (the chain's success outcome is the session the gates hand fix turns to,
// and a wave child's workspace is disposed when its work lands) — so a fixture that wants two
// steps genuinely overlapping needs a third step scheduled after them.

const CAPS: DriverCapabilities = {
  toolHooks: true,
  steer: true,
  interrupt: true,
  resumableSession: true,
  perModelTelemetry: true,
};
const driver: AgentDriver = {
  tool: 'claude',
  capabilities: CAPS,
  catalog: { models: [], efforts: [] },
  start: () => ({}) as DriverSession,
};

const run = { id: 'run_1', projectId: 'prj_p' } as Run;
const repo: ResolvedRepo = { root: '/repo', manifest: {} as never };
const parentWs: Workspace = {
  runId: 'run_1',
  localPath: '/wt/run_1',
  readOnly: false,
  workRef: 'noriq/run/run_1',
  baseId: 'basesha',
  location: { branch: 'noriq/run/run_1' },
};
const runAgent: RunAgent = {
  agentId: 'agt_1',
  label: 'build-abc',
  token: 'tok_run',
  projectId: 'prj_p',
  expiresIn: 3600,
};

/** One driver spawn the test settles BY HAND — held open until finish() is called, which is
 *  exactly what an overlap assertion needs (stages-execute.test.ts's FakeSpawn, multiplied). */
class FakeSpawn {
  stopped = false;
  private settle!: (e: DriverExit) => void;
  readonly budgetRun: BudgetRun;
  constructor(
    readonly opts: DriverStartOptions,
    n: number,
  ) {
    let settle!: (e: DriverExit) => void;
    const done = new Promise<DriverExit>((r) => {
      settle = r;
    });
    this.settle = settle;
    this.budgetRun = {
      session: { runId: opts.runId, sessionId: `sess-${n}` } as DriverSession,
      done,
      stop: async () => {
        this.stopped = true;
      },
    };
  }
  text(t: string): void {
    this.opts.handlers?.onText?.(t);
  }
  finish(exit: Partial<DriverExit> = {}): void {
    this.settle({
      outcome: 'done',
      isError: false,
      reason: null,
      telemetry: zeroTelemetry(),
      ...exit,
    });
  }
  /** The live (unsettled) marker: a spawn that finished no longer counts toward overlap. */
  live = true;
  end(exit: Partial<DriverExit> = {}): void {
    this.live = false;
    this.finish(exit);
  }
}

/** The wave seam, faked: mints a workspace per lease and records every verb with its target. */
function fakeWave(over: Partial<ChainWave> = {}) {
  const leases: string[] = [];
  const checkpoints: Array<{ ws: string; label: string }> = [];
  const integrations: string[] = [];
  const abandoned: string[] = [];
  const publishes: string[] = [];
  const disposed: string[] = [];
  const state = {
    /** Publish answers 'race' this many times before landing — the CAS loser's path. */
    racesLeft: 0,
    /** integrateBack answers these conflicts (once set, every call). */
    conflicts: [] as string[],
    /** what hasWork answers for a failed child (default: it has work → keep). */
    hasWork: true,
  };
  const wsFor = (id: string): Workspace => ({
    runId: id,
    localPath: `/wt/${id}`,
    readOnly: false,
    baseId: 'base',
    workRef: `noriq/run/${id}`,
    location: { branch: `noriq/run/${id}` },
  });
  const wave: ChainWave = {
    leasesOverlap: true,
    limit: () => 4,
    lease: async (childId) => {
      leases.push(childId);
      return wsFor(childId);
    },
    checkpoint: async (ws, label) => {
      checkpoints.push({ ws: ws.runId, label });
      return true;
    },
    integrateBack: async (ws): Promise<IntegrateResult> => {
      integrations.push(ws.runId);
      return state.conflicts.length ? { ok: false, conflicts: state.conflicts } : { ok: true };
    },
    abandonIntegrate: async (ws) => {
      abandoned.push(ws.runId);
    },
    publishBack: async (ws): Promise<PublishResult> => {
      publishes.push(ws.runId);
      if (state.racesLeft > 0) {
        state.racesLeft -= 1;
        return { ok: false, reason: 'race', detail: 'the line moved' };
      }
      return { ok: true, sha: 'landed' };
    },
    hasWork: async () => state.hasWork,
    dispose: async (ws) => {
      disposed.push(ws.runId);
    },
    ...over,
  };
  return { wave, leases, checkpoints, integrations, abandoned, publishes, disposed, state };
}

const steps = (...defs: Array<{ id: string; dependsOn?: string[]; files?: string[] }>) =>
  ExecutionSpec.parse({
    steps: defs.map((d) => ({
      id: d.id,
      title: `do ${d.id}`,
      ...(d.dependsOn ? { dependsOn: d.dependsOn } : {}),
      ...(d.files ? { anticipatedFiles: d.files.map((path) => ({ path })) } : {}),
    })),
  }).steps;

/** Three independent steps: a and b genuinely overlap, c is the sequential tail. */
const threeIndependent = () =>
  steps({ id: 'a', files: ['a.ts'] }, { id: 'b', files: ['b.ts'] }, { id: 'c', files: ['c.ts'] });

/** a and b overlap; c is a later wave — so a failure in the first wave has a wave to NOT start. */
const pairThenDependent = () =>
  steps({ id: 'a', files: ['a.ts'] }, { id: 'b', files: ['b.ts'] }, { id: 'c', dependsOn: ['a', 'b'] });

function harness(over: { tally?: RunTally } = {}) {
  const spawns: FakeSpawn[] = [];
  const parkProbes: string[] = [];
  const transcript: Array<{ text: string; step: string | null }> = [];
  const parentCheckpoints: string[] = [];
  /** `id#key` per registration (RUN-170): the composite the SteeringBridge keys sessions by, so a
   *  cancel can stop EVERY live session of the run — two entries here means two reachable ones. */
  const steering = { registered: [] as string[], unregistered: [] as string[] };
  /** The persisted cancellation fact (RUN-165) the chain probes before every spawn. */
  const cancel = { cancelled: false };
  /** When set, startAgent THROWS for a matching spawn — the synchronous driver-start failure the
   *  wave must settle like any failed member rather than reject on. */
  let failSpawn: ((opts: DriverStartOptions) => boolean) | null = null;
  const host: ExecuteHost = {
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    report: () => {},
    transcript: () =>
      ({
        text: (_role: string, t: string, _round: number | null, step: string | null) =>
          transcript.push({ text: t, step }),
        milestone: (t: string, step?: string | null) => transcript.push({ text: t, step: step ?? null }),
      }) as never,
    startAgent: (_d, opts) => {
      if (failSpawn?.(opts)) throw new Error('driver start failed');
      const s = new FakeSpawn(opts, spawns.length);
      spawns.push(s);
      return s.budgetRun;
    },
    steering: {
      register: (id, _session, _stop, key) => steering.registered.push(key ? `${id}#${key}` : id),
      unregister: (id, key) => steering.unregistered.push(key ? `${id}#${key}` : id),
      isCancelled: () => cancel.cancelled,
    },
    // The recorder that pins the no-park rule: a wave child must never reach the REAL park probe.
    parkIfBlocked: async (ctx) => {
      parkProbes.push(ctx.stepId ?? '(none)');
      return null;
    },
  };
  const tally = over.tally ?? new RunTally();
  const plan = (extra: Partial<ChainPlan> & Pick<ChainPlan, 'steps'>): ChainPlan => ({
    run,
    repo,
    worktree: parentWs,
    driver,
    runAgent,
    tally,
    priorActiveSeconds: 0,
    start: {
      runId: 'run_1',
      kind: 'build' as const,
      cwd: parentWs.localPath,
      prompt: 'go',
      permission: {} as never,
    },
    stepPrompt: (step, i) => `step ${i + 1}: ${step.title}`,
    checkpoint: async (label) => {
      parentCheckpoints.push(label);
      return true;
    },
    ...extra,
  });
  return {
    host,
    spawns,
    plan,
    tally,
    parkProbes,
    transcript,
    parentCheckpoints,
    steering,
    cancel,
    setFailSpawn: (f: (opts: DriverStartOptions) => boolean) => {
      failSpawn = f;
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
/** Pump until `cond` holds — bounded, so a hang fails the test rather than the suite. */
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
};

describe('a wave actually overlaps (RUN-170)', () => {
  it('runs the overlapping steps at once in their own workspaces, lands them serially, then runs the tail in the parent', async () => {
    const h = harness();
    const w = fakeWave();
    const running = executeChain(h.host, h.plan({ steps: threeIndependent(), wave: w.wave }));
    await until(() => h.spawns.length === 2);
    // The overlap assertion itself: TWO sessions live simultaneously, neither settled.
    expect(h.spawns.every((s) => s.live)).toBe(true);
    // …each in its own child workspace, leased under the derived child id.
    expect(w.leases).toEqual([stepWorkspaceId('run_1', 'a'), stepWorkspaceId('run_1', 'b')]);
    expect(h.spawns.map((s) => s.opts.cwd)).toEqual(['/wt/run_1--a', '/wt/run_1--b']);
    // The parent was checkpointed BEFORE the wave opened: children fork the branch, and
    // uncommitted parent work would be invisible to every one of them.
    expect(h.parentCheckpoints[0]).toMatch(/^before wave: a, b$/);
    // Both live sessions are registered under their own composite keys — what lets a cancel
    // mid-wave stop EVERY session of the run instead of whichever registered last (RUN-170).
    expect(h.steering.registered).toEqual(['run_1#step:a', 'run_1#step:b']);

    h.spawns[0]!.text('A concluded');
    h.spawns[0]!.end();
    h.spawns[1]!.text('B concluded');
    h.spawns[1]!.end();
    // The tail step opens only after the children LANDED — a fresh session in the PARENT
    // workspace, which is what makes the chain's returned session one the gates can hand fix
    // turns to (a child's cwd is disposed the moment its work lands).
    await until(() => h.spawns.length === 3);
    expect(h.spawns[2]!.opts.cwd).toBe(parentWs.localPath);
    // Serial return trip, in wave order, already done by the time the tail opened.
    expect(w.integrations).toEqual(['run_1--a', 'run_1--b']);
    expect(w.publishes).toEqual(['run_1--a', 'run_1--b']);
    expect(w.disposed).toEqual(['run_1--a', 'run_1--b']);
    // Every child session is CLOSED — none of them is the one handed onward.
    expect(h.spawns[0]!.stopped).toBe(true);
    expect(h.spawns[1]!.stopped).toBe(true);

    h.spawns[2]!.text('C concluded');
    h.spawns[2]!.end();
    const out = await running;
    if ('chainFailed' in out || out.parked) throw new Error('expected a finished chain');
    expect(out.exit.outcome).toBe('done');
    // The session handed onward is the tail's — live, parent-workspace, repairable.
    expect(out.session).toBe(h.spawns[2]!.budgetRun.session);
    expect(h.spawns[2]!.stopped).toBe(false);
    // The gate reads EVERY voice — the whole run's output, not the last step's.
    expect(out.sessionText).toContain('A concluded');
    expect(out.sessionText).toContain('B concluded');
    expect(out.sessionText).toContain('C concluded');
  });

  it('labels each overlapping step’s transcript segments with its own step id', async () => {
    const h = harness();
    const w = fakeWave();
    const running = executeChain(h.host, h.plan({ steps: threeIndependent(), wave: w.wave }));
    await until(() => h.spawns.length === 2);
    h.spawns[0]!.text('from-a');
    h.spawns[1]!.text('from-b');
    expect(h.transcript.filter((t) => t.text === 'from-a')[0]!.step).toBe('a');
    expect(h.transcript.filter((t) => t.text === 'from-b')[0]!.step).toBe('b');
    h.spawns[0]!.end();
    h.spawns[1]!.end();
    await until(() => h.spawns.length === 3);
    h.spawns[2]!.end();
    await running;
  });

  // The RUN-133 shape under concurrency: reserve() hands out the remainder, so two concurrent
  // reserves would each be told they may spend everything. ONE reservation is split instead, and
  // the assertion runs while both sessions are genuinely live — a sequential test cannot catch it.
  it('splits ONE reservation across the wave — the shares sum to at most the remainder', async () => {
    const h = harness({
      tally: new RunTally({ maxTokens: 1000, maxUsd: 8, maxDurationSeconds: 600, maxRounds: 3 }),
    });
    const w = fakeWave();
    const running = executeChain(h.host, h.plan({ steps: threeIndependent(), wave: w.wave }));
    await until(() => h.spawns.length === 2);
    expect(h.spawns.every((s) => s.live)).toBe(true); // asserted UNDER overlap, per the ticket
    for (const s of h.spawns) {
      expect(s.opts.budget).toMatchObject({ maxTokens: 500, maxUsd: 4, maxDurationSeconds: 300 });
      // Rounds pass through verbatim: they cap reviewer looks, nothing a step spends.
      expect(s.opts.budget?.maxRounds).toBe(3);
    }
    h.spawns[0]!.end();
    h.spawns[1]!.end();
    await until(() => h.spawns.length === 3);
    h.spawns[2]!.end();
    await running;
  });

  it('each step records its spend into its own step:<id> slot', async () => {
    const h = harness();
    const w = fakeWave();
    const running = executeChain(h.host, h.plan({ steps: threeIndependent(), wave: w.wave }));
    await until(() => h.spawns.length === 2);
    expect(h.spawns.map((s) => s.opts.runId)).toEqual(['run_1', 'run_1']); // one run identity
    h.spawns[0]!.end({ telemetry: { ...zeroTelemetry(), outputTokens: 100 } });
    h.spawns[1]!.end({ telemetry: { ...zeroTelemetry(), outputTokens: 30 } });
    await until(() => h.spawns.length === 3);
    h.spawns[2]!.end({ telemetry: { ...zeroTelemetry(), outputTokens: 5 } });
    await running;
    // 135, not 5: last-writer-wins is per SLOT, and each concurrent session has its own.
    expect(h.tally.total().outputTokens).toBe(135);
  });

  // The CAS is what serializes two children finishing together: the loser re-integrates and
  // retries — the same race landRun handles against [land].branch — and never a merge commit.
  it('re-integrates and retries when a publish loses the race', async () => {
    const h = harness();
    const w = fakeWave();
    w.state.racesLeft = 1;
    const running = executeChain(h.host, h.plan({ steps: threeIndependent(), wave: w.wave }));
    await until(() => h.spawns.length === 2);
    h.spawns[0]!.end();
    h.spawns[1]!.end();
    await until(() => h.spawns.length === 3);
    h.spawns[2]!.end();
    const out = await running;
    if ('chainFailed' in out || out.parked) throw new Error('expected a finished chain');
    expect(out.exit.outcome).toBe('done');
    // Child a lost once: integrate, publish (race), integrate again, publish (landed).
    expect(w.integrations).toEqual(['run_1--a', 'run_1--a', 'run_1--b']);
    expect(w.publishes).toEqual(['run_1--a', 'run_1--a', 'run_1--b']);
  });

  it('fails the step on an integrate conflict, abandons the merge and keeps the workspace', async () => {
    const h = harness();
    const w = fakeWave();
    w.state.conflicts = ['src/x.ts'];
    const running = executeChain(h.host, h.plan({ steps: threeIndependent(), wave: w.wave }));
    await until(() => h.spawns.length === 2);
    h.spawns[0]!.end();
    h.spawns[1]!.end();
    const out = await running;
    if ('chainFailed' in out || out.parked) throw new Error('expected an outcome');
    expect(out.exit).toMatchObject({ outcome: 'failed', reason: 'steps:child-conflict' });
    expect(w.abandoned).toContain('run_1--a');
    // The land-failure notice is the failing child's segment (RUN-170's attribution rule).
    expect(h.transcript.find((t) => t.text.includes('did not land back'))!.step).toBe('a');
    // Never force-delete work that exists nowhere else: the conflicted children are kept —
    // and the tail step never starts, because the chain stops at the failure.
    expect(w.disposed).toEqual([]);
    expect(h.spawns).toHaveLength(2);
  });
});

describe('a failed step lets its wave finish, then the chain stops (RUN-170)', () => {
  it('siblings complete and land; no later wave starts; the outcome is the failing step’s', async () => {
    const h = harness();
    const w = fakeWave();
    const running = executeChain(h.host, h.plan({ steps: pairThenDependent(), wave: w.wave }));
    await until(() => h.spawns.length === 2);
    h.spawns[0]!.end({ outcome: 'failed', isError: true, reason: 'boom' });
    h.spawns[1]!.text('B landed anyway');
    h.spawns[1]!.end();
    const out = await running;
    if ('chainFailed' in out || out.parked) throw new Error('expected an outcome');

    // The sibling's work was going to succeed, and it did: cancelling it would throw that away.
    expect(w.publishes).toEqual(['run_1--b']);
    expect(w.disposed).toEqual(['run_1--b']);
    // The failing child had work → its workspace is kept for a human.
    expect(w.leases).toHaveLength(2);
    // No later wave: step c never spawned.
    expect(h.spawns).toHaveLength(2);
    // The run's outcome is the failing step's, over the accumulated text.
    expect(out.exit).toMatchObject({ outcome: 'failed', reason: 'boom' });
    expect(out.sessionText).toContain('B landed anyway');
    // A child's milestones are ITS segments, not the parent voice's — attribution is what keeps
    // a transcript readable once two steps' segments interleave (RUN-150/170).
    expect(h.transcript.find((t) => t.text.includes('did not finish'))!.step).toBe('a');
    expect(h.transcript.find((t) => t.text.includes('workspace is kept'))!.step).toBe('a');
  });

  // A member THROWING — a driver whose start() fails is an explicitly supported failure — must
  // settle like any failed member: siblings integrate, workspaces settle, the run gets a failed
  // outcome. A rejection escaping the wave loses all three at once.
  it('settles a member whose spawn THREW: siblings land, its workspace is kept, the run fails', async () => {
    const h = harness();
    const w = fakeWave();
    h.setFailSpawn((opts) => opts.cwd === '/wt/run_1--b');
    const running = executeChain(h.host, h.plan({ steps: pairThenDependent(), wave: w.wave }));
    await until(() => h.spawns.length === 1); // only a's session exists — b's spawn threw
    h.spawns[0]!.text('A landed anyway');
    h.spawns[0]!.end();
    const out = await running;
    if ('chainFailed' in out) throw new Error(`chain never produced a session: ${out.chainFailed}`);
    if (out.parked) throw new Error('expected an outcome');
    // The finished sibling's work still landed…
    expect(w.publishes).toEqual(['run_1--a']);
    expect(w.disposed).toEqual(['run_1--a']);
    // …the thrown member's workspace was settled by the keep rule (it answers hasWork=true here)…
    expect(w.leases).toHaveLength(2);
    // …no later wave started, and the run reports a failure, not an escaped rejection.
    expect(h.spawns).toHaveLength(1);
    expect(out.exit.outcome).toBe('failed');
    expect(out.exit.reason).toContain('steps:child-failed');
  });

  it('disposes a failed child that produced nothing — an empty workspace holds no work to lose', async () => {
    const h = harness();
    const w = fakeWave();
    w.state.hasWork = false;
    const running = executeChain(h.host, h.plan({ steps: pairThenDependent(), wave: w.wave }));
    await until(() => h.spawns.length === 2);
    h.spawns[0]!.end({ outcome: 'failed', isError: true, reason: 'boom' });
    h.spawns[1]!.end();
    await running;
    expect(w.disposed).toContain('run_1--a'); // empty → disposed
    expect(w.disposed).toContain('run_1--b'); // landed → disposed
  });
});

describe('a wave child never parks (RUN-170)', () => {
  it('keeps every child session away from the park probe — only the sequential tail reaches it', async () => {
    const h = harness();
    const w = fakeWave();
    const running = executeChain(h.host, h.plan({ steps: pairThenDependent(), wave: w.wave }));
    await until(() => h.spawns.length === 2);
    h.spawns[0]!.end();
    h.spawns[1]!.end();
    await until(() => h.spawns.length === 3);
    h.spawns[2]!.end();
    await running;
    // The host's parkIfBlocked recorder never fired for a wave child (the park record persists
    // ONE workspace, and a child-workspace park would resume into the wrong tree); step c ran
    // sequentially in the parent workspace, so its ordinary probe is the only one.
    expect(h.parkProbes).toEqual(['c']);
  });

  it('stops the chain when a child asked a human — landed, kept, and said out loud', async () => {
    const h = harness();
    const w = fakeWave({ probeBlocked: async () => true });
    const running = executeChain(h.host, h.plan({ steps: pairThenDependent(), wave: w.wave }));
    await until(() => h.spawns.length === 2);
    h.spawns[0]!.end();
    h.spawns[1]!.end();
    const out = await running;
    if ('chainFailed' in out || out.parked) throw new Error('expected an outcome');
    // The work landed (both children published) but the chain must not run step c: its park check
    // would adopt the child's stale question and park the WRONG session against it.
    expect(w.publishes).toHaveLength(2);
    expect(h.spawns).toHaveLength(2);
    expect(out.exit).toMatchObject({ outcome: 'failed', reason: 'steps:child-asked' });
    expect(h.transcript.map((t) => t.text).join('\n')).toMatch(/cannot park/);
  });

  // The unknown answer must not become the acted-on one (RUN-152's direction): a probe failure
  // read as "nobody asked" lets the tail's own park check adopt a child's stale question and park
  // the WRONG session — a corrupted resume, where stopping costs a re-dispatch with every landed
  // child's work kept.
  it('an unanswerable park probe stops the chain rather than risking a wrong-session park', async () => {
    const h = harness();
    const w = fakeWave({
      probeBlocked: async () => {
        throw new Error('server flake');
      },
    });
    const running = executeChain(h.host, h.plan({ steps: pairThenDependent(), wave: w.wave }));
    await until(() => h.spawns.length === 2);
    h.spawns[0]!.end();
    h.spawns[1]!.end();
    const out = await running;
    if ('chainFailed' in out || out.parked) throw new Error('expected an outcome');
    expect(w.publishes).toHaveLength(2); // the children's work still landed and is kept
    expect(h.spawns).toHaveLength(2); // the tail never spawned — nothing to park wrongly
    expect(out.exit).toMatchObject({ outcome: 'failed', reason: 'steps:park-probe-failed' });
    expect(h.transcript.map((t) => t.text).join('\n')).toMatch(/could not confirm/);
  });
});

describe('a cancel is a fact about the RUN, wherever it lands mid-chain (RUN-165/170)', () => {
  // The race cancelRun alone cannot cover: it stops the sessions REGISTERED at that instant, and
  // a wave child still awaiting its lease has none — the lease then resolves and a session nothing
  // ever stops would spawn. The persisted fact is probed after the lease, before any process.
  it('a cancel landing while children are still leasing spawns no session at all', async () => {
    const h = harness();
    let releaseLeases!: () => void;
    const gate = new Promise<void>((r) => {
      releaseLeases = r;
    });
    const w = fakeWave({
      lease: async (childId) => {
        await gate; // both leases held in flight — the cancel lands here
        return {
          runId: childId,
          localPath: `/wt/${childId}`,
          readOnly: false,
          baseId: 'base',
          workRef: `noriq/run/${childId}`,
          location: { branch: `noriq/run/${childId}` },
        };
      },
    });
    const running = executeChain(h.host, h.plan({ steps: pairThenDependent(), wave: w.wave }));
    await tick(); // the wave opened; both leases are pending
    h.cancel.cancelled = true; // the operator cancels — no session exists for cancelRun to stop
    releaseLeases();
    const out = await running;
    expect(h.spawns).toHaveLength(0); // the leases resolved, and still nothing spawned
    if (!('chainFailed' in out)) throw new Error('expected a chain that never started a session');
    expect(out.chainFailed).toBe('cancelled');
  });

  it('a cancel landing between waves stops the chain before its next session', async () => {
    const h = harness();
    const w = fakeWave();
    const running = executeChain(h.host, h.plan({ steps: pairThenDependent(), wave: w.wave }));
    await until(() => h.spawns.length === 2);
    h.cancel.cancelled = true; // lands in the gap: the wave is settling, step c has not spawned
    h.spawns[0]!.end();
    h.spawns[1]!.end();
    const out = await running;
    if ('chainFailed' in out || out.parked) throw new Error('expected an outcome');
    // The finished children's work still landed (done before the cancel took effect)…
    expect(w.publishes).toHaveLength(2);
    // …but no further session spawned, and the run reports the cancellation.
    expect(h.spawns).toHaveLength(2);
    expect(out.exit).toMatchObject({ outcome: 'failed', reason: 'cancelled' });
  });
});

describe('degrading to the sequential chain, which is always correct (RUN-170)', () => {
  const twoIndependent = () => steps({ id: 'a', files: ['a.ts'] }, { id: 'b', files: ['b.ts'] });

  it('runs one step at a time on a backend whose leases cannot overlap — and leases nothing', async () => {
    const h = harness();
    const w = fakeWave({ leasesOverlap: false });
    const running = executeChain(h.host, h.plan({ steps: twoIndependent(), wave: w.wave }));
    await until(() => h.spawns.length === 1);
    await tick();
    expect(h.spawns).toHaveLength(1); // the second step has NOT started
    h.spawns[0]!.end();
    await until(() => h.spawns.length === 2);
    h.spawns[1]!.end();
    const out = await running;
    if ('chainFailed' in out || out.parked) throw new Error('expected a finished chain');
    // On a pool-of-1 backend a child lease taken while the parent holds the pool deadlocks — so a
    // sequential wave must never issue one. The steps share the parent's workspace.
    expect(w.leases).toEqual([]);
    expect(h.spawns.map((s) => s.opts.cwd)).toEqual([parentWs.localPath, parentWs.localPath]);
  });

  it('runs fully sequentially at a limit of 1, however capable the backend', async () => {
    const h = harness();
    const w = fakeWave({ limit: () => 1 });
    const running = executeChain(h.host, h.plan({ steps: threeIndependent(), wave: w.wave }));
    await until(() => h.spawns.length === 1);
    await tick();
    expect(h.spawns).toHaveLength(1);
    h.spawns[0]!.end();
    await until(() => h.spawns.length === 2);
    h.spawns[1]!.end();
    await until(() => h.spawns.length === 3);
    h.spawns[2]!.end();
    await running;
    expect(w.leases).toEqual([]);
  });

  // An exhausted run must not OPEN a wave: the first-step exception (spawn once and let the
  // budget layer decline — the same failure shape as an undecomposed run) is kept at the first
  // STEP's grain. Overlapping would lease N workspaces and start N processes only to kill them,
  // which is RUN-133's spawn-to-kill shape multiplied by the wave width.
  it('an exhausted run leases nothing — one sequential spawn carries the decline, never N', async () => {
    const tally = new RunTally({ maxTokens: 100, maxUsd: null, maxDurationSeconds: null, maxRounds: null });
    tally.record('prior-sitting', { ...zeroTelemetry(), outputTokens: 100 }); // ceiling already spent
    const h = harness({ tally });
    const w = fakeWave();
    const running = executeChain(h.host, h.plan({ steps: threeIndependent(), wave: w.wave }));
    await until(() => h.spawns.length === 1);
    await tick();
    expect(h.spawns).toHaveLength(1); // ONE spawn carries the decline
    expect(w.leases).toEqual([]); // no child workspace was ever taken
    // The budget layer declines the turn in production; the fake stands in for its terminal exit.
    h.spawns[0]!.end({ outcome: 'failed', isError: true, reason: 'budget:tokens' });
    const out = await running;
    if ('chainFailed' in out || out.parked) throw new Error('expected an outcome');
    expect(out.exit).toMatchObject({ outcome: 'failed', reason: 'budget:tokens' });
    expect(h.spawns).toHaveLength(1); // the chain stopped — no sibling, no tail
  });

  // The other boundary: a remainder too small to hand every member a spendable share. Flooring
  // shares UP would let their sum outspend the remainder; passing the floored 0 through would
  // hand a member a dimension the budget wrapper cannot arm (`superviseBudget` relies on the
  // schema's maxDurationSeconds >= 1 — a 0 disarms the deadline entirely, the opposite of
  // bounding it at nothing; the same floor guards maxTokens). So the wave declines to overlap
  // and each sequential step reserves the true remainder in turn.
  it('a remainder too small to split runs the wave sequentially rather than handing out zero shares', async () => {
    const tally = new RunTally({ maxTokens: 1, maxUsd: null, maxDurationSeconds: null, maxRounds: null });
    const h = harness({ tally });
    const w = fakeWave();
    const running = executeChain(h.host, h.plan({ steps: threeIndependent(), wave: w.wave }));
    await until(() => h.spawns.length === 1);
    await tick();
    expect(h.spawns).toHaveLength(1); // sequential — never two live
    expect(w.leases).toEqual([]);
    // The remainder reaches the step WHOLE and spendable, not floor-divided to 0.
    expect(h.spawns[0]!.opts.budget?.maxTokens).toBe(1);
    h.spawns[0]!.end();
    await until(() => h.spawns.length === 2);
    expect(h.spawns[0]!.live).toBe(false); // one at a time, genuinely
    h.spawns[1]!.end();
    await until(() => h.spawns.length === 3);
    h.spawns[2]!.end();
    const out = await running;
    if ('chainFailed' in out || out.parked) throw new Error('expected a finished chain');
    expect(out.exit.outcome).toBe('done');
  });

  // The limit is re-asked before EACH wave, not sampled once: a machine that got busy after the
  // chain started narrows the next wave rather than overlapping on capacity that is gone.
  it('re-asks the limit per wave — a limit that drops mid-chain de-overlaps the next wave', async () => {
    const h = harness();
    let cap = 4;
    const w = fakeWave({ limit: () => cap });
    // Two independent pairs: (a,b) then (c,d dependsOn a,b … make d depend so waves split).
    const running = executeChain(
      h.host,
      h.plan({
        steps: steps(
          { id: 'a', files: ['a.ts'] },
          { id: 'b', files: ['b.ts'] },
          { id: 'c', dependsOn: ['a', 'b'], files: ['c.ts'] },
          { id: 'd', dependsOn: ['a', 'b'], files: ['d.ts'] },
          { id: 'e', dependsOn: ['c', 'd'] },
        ),
        wave: w.wave,
      }),
    );
    await until(() => h.spawns.length === 2); // wave 1 overlaps at cap 4
    cap = 1; // the machine got busy while a and b ran
    h.spawns[0]!.end();
    h.spawns[1]!.end();
    await until(() => h.spawns.length === 3);
    await tick();
    expect(h.spawns).toHaveLength(3); // c runs ALONE: the re-asked limit de-overlapped wave 2
    expect(h.spawns[2]!.opts.cwd).toBe(parentWs.localPath); // …sequentially, in the parent
    h.spawns[2]!.end();
    await until(() => h.spawns.length === 4);
    h.spawns[3]!.end();
    await until(() => h.spawns.length === 5);
    h.spawns[4]!.end();
    const out = await running;
    if ('chainFailed' in out || out.parked) throw new Error('expected a finished chain');
    expect(w.leases).toEqual([stepWorkspaceId('run_1', 'a'), stepWorkspaceId('run_1', 'b')]);
  });

  it('runs a wave sequentially when the parent cannot be checkpointed first', async () => {
    const h = harness();
    const w = fakeWave();
    const p = h.plan({ steps: threeIndependent(), wave: w.wave });
    p.checkpoint = async () => {
      throw new Error('index.lock held');
    };
    const running = executeChain(h.host, p);
    await until(() => h.spawns.length === 1);
    await tick();
    // Children fork the parent's BRANCH: uncommitted parent work would be invisible to them, so
    // an uncheckpointable parent forfeits the overlap, never the work.
    expect(h.spawns).toHaveLength(1);
    expect(w.leases).toEqual([]);
    h.spawns[0]!.end();
    await until(() => h.spawns.length === 2);
    h.spawns[1]!.end();
    await until(() => h.spawns.length === 3);
    h.spawns[2]!.end();
    await running;
  });

  it('runs the chain exactly as before when no wave seam is injected at all', async () => {
    const h = harness();
    const running = executeChain(h.host, h.plan({ steps: twoIndependent() }));
    await until(() => h.spawns.length === 1);
    h.spawns[0]!.end();
    await until(() => h.spawns.length === 2);
    h.spawns[1]!.end();
    const out = await running;
    if ('chainFailed' in out || out.parked) throw new Error('expected a finished chain');
    expect(out.exit.outcome).toBe('done');
    expect(h.spawns.map((s) => s.opts.cwd)).toEqual([parentWs.localPath, parentWs.localPath]);
  });

  // Two sessions must never share a checkout (the invariant per-step workspaces exist to keep), so
  // ids that collide once made workspace-safe forfeit the overlap instead.
  it('runs a wave sequentially when two step ids collide once made ref-safe', async () => {
    const h = harness();
    const w = fakeWave();
    const running = executeChain(
      h.host,
      h.plan({
        steps: steps(
          { id: 'a b', files: ['a.ts'] },
          { id: 'a·b', files: ['b.ts'] },
          { id: 'c', files: ['c.ts'] },
        ),
        wave: w.wave,
      }),
    );
    await until(() => h.spawns.length === 1);
    await tick();
    expect(h.spawns).toHaveLength(1);
    expect(w.leases).toEqual([]);
    h.spawns[0]!.end();
    await until(() => h.spawns.length === 2);
    h.spawns[1]!.end();
    await until(() => h.spawns.length === 3);
    h.spawns[2]!.end();
    await running;
  });
});

// RUN-193. Steps are one run's sessions under one identity — they take the execute stage's
// coordinate by INHERITANCE, because `prepare` folded it into `start` (the model/effort and the
// driver) before the chain ever ran, and `chain.ts` spreads that `start` verbatim per step. So the
// wiring point is prepare, not chain; this only pins that the spread carries the coordinate through.
describe('chain steps inherit the execute stage’s coordinate via plan.start (RUN-193)', () => {
  const twoDependent = () => steps({ id: 'a' }, { id: 'b', dependsOn: ['a'] });

  it('every step session spreads plan.start’s model and effort', async () => {
    const h = harness();
    const running = executeChain(
      h.host,
      h.plan({
        steps: twoDependent(),
        // What prepare hands over once the execute-stage coordinate is folded in (RUN-193): the
        // builder's chosen model/effort live on `start`, and the driver is `plan.driver`.
        start: {
          runId: 'run_1',
          kind: 'build',
          cwd: parentWs.localPath,
          prompt: 'go',
          permission: {} as never,
          model: 'gpt-5.6-sol',
          effort: 'high',
        },
      }),
    );
    await until(() => h.spawns.length === 1);
    h.spawns[0]!.end();
    await until(() => h.spawns.length === 2);
    h.spawns[1]!.end();
    const out = await running;
    if ('chainFailed' in out || out.parked) throw new Error('expected a finished chain');
    expect(h.spawns.map((s) => s.opts.model)).toEqual(['gpt-5.6-sol', 'gpt-5.6-sol']);
    expect(h.spawns.map((s) => s.opts.effort)).toEqual(['high', 'high']);
    // One driver for the whole chain — the run's, which prepare already pointed at the coordinate's
    // tool. Steps never re-resolve it.
    expect(h.spawns.every((s) => s.opts.runId === 'run_1')).toBe(true);
  });
});
