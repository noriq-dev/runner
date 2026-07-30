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
    limit: 4,
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

function harness(over: { tally?: RunTally } = {}) {
  const spawns: FakeSpawn[] = [];
  const parkProbes: string[] = [];
  const transcript: Array<{ text: string; step: string | null }> = [];
  const parentCheckpoints: string[] = [];
  /** `id#key` per registration (RUN-170): the composite the SteeringBridge keys sessions by, so a
   *  cancel can stop EVERY live session of the run — two entries here means two reachable ones. */
  const steering = { registered: [] as string[], unregistered: [] as string[] };
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
      const s = new FakeSpawn(opts, spawns.length);
      spawns.push(s);
      return s.budgetRun;
    },
    steering: {
      register: (id, _session, _stop, key) => steering.registered.push(key ? `${id}#${key}` : id),
      unregister: (id, key) => steering.unregistered.push(key ? `${id}#${key}` : id),
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
  return { host, spawns, plan, tally, parkProbes, transcript, parentCheckpoints, steering };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
/** Pump until `cond` holds — bounded, so a hang fails the test rather than the suite. */
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
};

describe('a wave actually overlaps (RUN-170)', () => {
  it('runs both steps at once, each in its own leased workspace, and lands them back serially', async () => {
    const h = harness();
    const w = fakeWave();
    const running = executeChain(
      h.host,
      h.plan({ steps: steps({ id: 'a', files: ['a.ts'] }, { id: 'b', files: ['b.ts'] }), wave: w.wave }),
    );
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
    const out = await running;
    if ('chainFailed' in out || out.parked) throw new Error('expected a finished chain');

    // Serial return trip, in wave order: checkpoint the child, integrate the parent's line in,
    // publish (CAS), dispose — a landed child's workspace does not outlive its landing.
    expect(w.integrations).toEqual(['run_1--a', 'run_1--b']);
    expect(w.publishes).toEqual(['run_1--a', 'run_1--b']);
    expect(w.disposed).toEqual(['run_1--a', 'run_1--b']);
    expect(out.exit.outcome).toBe('done');
    // The gate reads BOTH voices — the whole run's output, not the last step's.
    expect(out.sessionText).toContain('A concluded');
    expect(out.sessionText).toContain('B concluded');
  });

  it('labels each overlapping step’s transcript segments with its own step id', async () => {
    const h = harness();
    const w = fakeWave();
    const running = executeChain(
      h.host,
      h.plan({ steps: steps({ id: 'a', files: ['a.ts'] }, { id: 'b', files: ['b.ts'] }), wave: w.wave }),
    );
    await until(() => h.spawns.length === 2);
    h.spawns[0]!.text('from-a');
    h.spawns[1]!.text('from-b');
    expect(h.transcript.filter((t) => t.text === 'from-a')[0]!.step).toBe('a');
    expect(h.transcript.filter((t) => t.text === 'from-b')[0]!.step).toBe('b');
    h.spawns[0]!.end();
    h.spawns[1]!.end();
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
    const running = executeChain(
      h.host,
      h.plan({ steps: steps({ id: 'a', files: ['a.ts'] }, { id: 'b', files: ['b.ts'] }), wave: w.wave }),
    );
    await until(() => h.spawns.length === 2);
    expect(h.spawns.every((s) => s.live)).toBe(true); // asserted UNDER overlap, per the ticket
    for (const s of h.spawns) {
      expect(s.opts.budget).toMatchObject({ maxTokens: 500, maxUsd: 4, maxDurationSeconds: 300 });
      // Rounds pass through verbatim: they cap reviewer looks, nothing a step spends.
      expect(s.opts.budget?.maxRounds).toBe(3);
    }
    h.spawns[0]!.end();
    h.spawns[1]!.end();
    await running;
  });

  it('each step records its spend into its own step:<id> slot', async () => {
    const h = harness();
    const w = fakeWave();
    const running = executeChain(
      h.host,
      h.plan({ steps: steps({ id: 'a', files: ['a.ts'] }, { id: 'b', files: ['b.ts'] }), wave: w.wave }),
    );
    await until(() => h.spawns.length === 2);
    expect(h.spawns.map((s) => s.opts.runId)).toEqual(['run_1', 'run_1']); // one run identity
    h.spawns[0]!.end({ telemetry: { ...zeroTelemetry(), outputTokens: 100 } });
    h.spawns[1]!.end({ telemetry: { ...zeroTelemetry(), outputTokens: 30 } });
    await running;
    // 130, not 30: last-writer-wins is per SLOT, and each concurrent session has its own.
    expect(h.tally.total().outputTokens).toBe(130);
  });

  // The CAS is what serializes two children finishing together: the loser re-integrates and
  // retries — the same race landRun handles against [land].branch — and never a merge commit.
  it('re-integrates and retries when a publish loses the race', async () => {
    const h = harness();
    const w = fakeWave();
    w.state.racesLeft = 1;
    const running = executeChain(
      h.host,
      h.plan({ steps: steps({ id: 'a', files: ['a.ts'] }, { id: 'b', files: ['b.ts'] }), wave: w.wave }),
    );
    await until(() => h.spawns.length === 2);
    h.spawns[0]!.end();
    h.spawns[1]!.end();
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
    const running = executeChain(
      h.host,
      h.plan({ steps: steps({ id: 'a', files: ['a.ts'] }, { id: 'b', files: ['b.ts'] }), wave: w.wave }),
    );
    await until(() => h.spawns.length === 2);
    h.spawns[0]!.end();
    h.spawns[1]!.end();
    const out = await running;
    if ('chainFailed' in out || out.parked) throw new Error('expected an outcome');
    expect(out.exit).toMatchObject({ outcome: 'failed', reason: 'steps:child-conflict' });
    expect(w.abandoned).toContain('run_1--a');
    // Never force-delete work that exists nowhere else: the conflicted child is kept.
    expect(w.disposed).toEqual([]);
  });
});

describe('a failed step lets its wave finish, then the chain stops (RUN-170)', () => {
  it('siblings complete and land; no later wave starts; the outcome is the failing step’s', async () => {
    const h = harness();
    const w = fakeWave();
    const running = executeChain(
      h.host,
      h.plan({
        steps: steps(
          { id: 'a', files: ['a.ts'] },
          { id: 'b', files: ['b.ts'] },
          { id: 'c', dependsOn: ['a', 'b'] },
        ),
        wave: w.wave,
      }),
    );
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
  });

  it('disposes a failed child that produced nothing — an empty workspace holds no work to lose', async () => {
    const h = harness();
    const w = fakeWave();
    w.state.hasWork = false;
    const running = executeChain(
      h.host,
      h.plan({ steps: steps({ id: 'a', files: ['a.ts'] }, { id: 'b', files: ['b.ts'] }), wave: w.wave }),
    );
    await until(() => h.spawns.length === 2);
    h.spawns[0]!.end({ outcome: 'failed', isError: true, reason: 'boom' });
    h.spawns[1]!.end();
    await running;
    expect(w.disposed).toContain('run_1--a'); // empty → disposed
    expect(w.disposed).toContain('run_1--b'); // landed → disposed
  });
});

describe('a wave child never parks (RUN-170)', () => {
  it('keeps every child session away from the park probe', async () => {
    const h = harness();
    const w = fakeWave();
    const running = executeChain(
      h.host,
      h.plan({ steps: steps({ id: 'a', files: ['a.ts'] }, { id: 'b', files: ['b.ts'] }), wave: w.wave }),
    );
    await until(() => h.spawns.length === 2);
    h.spawns[0]!.end();
    h.spawns[1]!.end();
    await running;
    // The host's parkIfBlocked recorder never fired for a wave child: the park record persists ONE
    // workspace, and a child-workspace park would resume into the wrong tree.
    expect(h.parkProbes).toEqual([]);
  });

  it('stops the chain when a child asked a human — landed, kept, and said out loud', async () => {
    const h = harness();
    const w = fakeWave({ probeBlocked: async () => true });
    const running = executeChain(
      h.host,
      h.plan({
        steps: steps(
          { id: 'a', files: ['a.ts'] },
          { id: 'b', files: ['b.ts'] },
          { id: 'c', dependsOn: ['a', 'b'] },
        ),
        wave: w.wave,
      }),
    );
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
    const w = fakeWave({ limit: 1 });
    const running = executeChain(h.host, h.plan({ steps: twoIndependent(), wave: w.wave }));
    await until(() => h.spawns.length === 1);
    await tick();
    expect(h.spawns).toHaveLength(1);
    h.spawns[0]!.end();
    await until(() => h.spawns.length === 2);
    h.spawns[1]!.end();
    await running;
    expect(w.leases).toEqual([]);
  });

  it('runs a wave sequentially when the parent cannot be checkpointed first', async () => {
    const h = harness();
    const w = fakeWave();
    const p = h.plan({ steps: twoIndependent(), wave: w.wave });
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
      h.plan({ steps: steps({ id: 'a b', files: ['a.ts'] }, { id: 'a·b', files: ['b.ts'] }), wave: w.wave }),
    );
    await until(() => h.spawns.length === 1);
    await tick();
    expect(h.spawns).toHaveLength(1);
    expect(w.leases).toEqual([]);
    h.spawns[0]!.end();
    await until(() => h.spawns.length === 2);
    h.spawns[1]!.end();
    await running;
  });
});
