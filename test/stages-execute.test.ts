import type { Run } from '@noriq-dev/shared';
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
import { type ExecuteHost, LOG_TAIL_CAP, executeRun } from '../src/stages';
import { type ResolvedRepo, RunTally } from '../src/supervisor';
import type { Workspace } from '../src/vcs/types';

// RUN-131. Spawning the agent, accumulating its output, folding the terminal result into the run's
// tally and asking the server whether the session ended or PARKED used to be written twice — once
// in `supervise`, once in `resume` — and the only way to test either copy was to drive a whole
// supervisor. It is one function now, which is what makes the contract below assertable.

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
const worktree: Workspace = {
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

/** A driver spawn the test drives by hand: emit text/telemetry, then finish it. */
class FakeSpawn {
  opts!: DriverStartOptions;
  stopped = false;
  private settle!: (e: DriverExit) => void;
  readonly budgetRun: BudgetRun;
  constructor() {
    let settle!: (e: DriverExit) => void;
    const done = new Promise<DriverExit>((r) => {
      settle = r;
    });
    this.settle = settle;
    this.budgetRun = {
      session: { runId: 'run_1', sessionId: 'sess-1' } as DriverSession,
      done,
      stop: async () => {
        this.stopped = true;
      },
    };
  }
  text(t: string): void {
    this.opts.handlers?.onText?.(t);
  }
  telemetry(outputTokens: number): void {
    this.opts.handlers?.onTelemetry?.({ ...zeroTelemetry(), outputTokens });
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
}

function harness(over: { parks?: DriverExit | null } = {}) {
  const spawn = new FakeSpawn();
  const registered: string[] = [];
  const unregistered: string[] = [];
  const parkCalls: Array<{ activeSeconds: number; tail: string; exit: DriverExit }> = [];
  const host: ExecuteHost = {
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    report: () => {},
    transcript: () => ({ text: () => {}, milestone: () => {} }) as never,
    startAgent: (_d, opts) => {
      spawn.opts = opts;
      return spawn.budgetRun;
    },
    steering: {
      // Records `id#key` when a key rides along (RUN-170) — the keyless shape stays the bare id.
      register: (id, _session, _stop, key) => registered.push(key ? `${id}#${key}` : id),
      unregister: (id, key) => unregistered.push(key ? `${id}#${key}` : id),
    },
    parkIfBlocked: async (ctx) => {
      parkCalls.push({ activeSeconds: ctx.activeSeconds, tail: ctx.tail, exit: ctx.exit });
      return over.parks ?? null;
    },
  };
  const tally = new RunTally();
  const plan = {
    run,
    repo,
    worktree,
    driver,
    runAgent,
    tally,
    priorActiveSeconds: 0,
    start: {
      runId: 'run_1',
      kind: 'build' as const,
      cwd: '/wt/run_1',
      prompt: 'go',
      permission: {} as never,
    },
  };
  return { host, spawn, plan, tally, registered, unregistered, parkCalls };
}

describe('execute owns the output, because everything downstream reads it', () => {
  it('accumulates the full session text and hands back a LIVE accessor for it', async () => {
    const { host, spawn, plan } = harness();
    const running = executeRun(host, plan);
    await Promise.resolve();
    spawn.text('hello ');
    spawn.text('world');
    spawn.finish();
    const out = await running;
    if (out.parked) throw new Error('unexpected park');
    // The snapshot froze at the driver's terminal result; the accessor keeps reading the same
    // buffer, which is what lets a fix turn's output reach the ledger (RUN-79).
    expect(out.sessionText).toBe('hello world');
    spawn.text('!');
    expect(out.getSessionText()).toBe('hello world!');
    expect(out.sessionText).toBe('hello world');
  });

  it('caps the dashboard tail without capping the verdict text', async () => {
    const { host, spawn, plan } = harness();
    const running = executeRun(host, plan);
    await Promise.resolve();
    spawn.text('x'.repeat(LOG_TAIL_CAP + 500));
    spawn.finish();
    const out = await running;
    if (out.parked) throw new Error('unexpected park');
    expect(out.tail).toHaveLength(LOG_TAIL_CAP);
    expect(out.sessionText).toHaveLength(LOG_TAIL_CAP + 500);
  });

  it('supplies the handlers itself — a caller cannot pass its own and disconnect the verdict', async () => {
    const { host, spawn, plan } = harness();
    const running = executeRun(host, plan);
    await Promise.resolve();
    expect(spawn.opts.handlers?.onText).toBeTypeOf('function');
    expect(spawn.opts.handlers?.onTelemetry).toBeTypeOf('function');
    // Everything else is the caller's, passed through untouched.
    expect(spawn.opts.prompt).toBe('go');
    spawn.finish();
    await running;
  });
});

describe('execute folds every tick into the run tally (RUN-59)', () => {
  it('records the live ticks and then the terminal result', async () => {
    const { host, spawn, plan, tally } = harness();
    const running = executeRun(host, plan);
    await Promise.resolve();
    spawn.telemetry(10);
    spawn.finish({ telemetry: { ...zeroTelemetry(), outputTokens: 42 } });
    const out = await running;
    if (out.parked) throw new Error('unexpected park');
    // The terminal result SUPERSEDES the tick for the same slot rather than adding to it.
    expect(tally.total().outputTokens).toBe(42);
    // And the exit in flight agrees with the tally, rather than carrying only this session's
    // first-result snapshot.
    expect(out.exit.telemetry.outputTokens).toBe(42);
  });

  it('a resume keeps summing onto the seeded prior spend', async () => {
    const { host, spawn, plan, tally } = harness();
    tally.seed('__prior__', { ...zeroTelemetry(), outputTokens: 900 });
    const running = executeRun(host, plan);
    await Promise.resolve();
    spawn.finish({ telemetry: { ...zeroTelemetry(), outputTokens: 42 } });
    const out = await running;
    if (out.parked) throw new Error('unexpected park');
    expect(out.exit.telemetry.outputTokens).toBe(942);
  });
});

describe('execute is where a run parks, for both entry points', () => {
  it('returns the parked exit and no session — nothing downstream may run', async () => {
    const parked: DriverExit = {
      outcome: 'done',
      isError: false,
      reason: 'parked',
      telemetry: zeroTelemetry(),
    };
    const { host, spawn, plan } = harness({ parks: parked });
    const running = executeRun(host, plan);
    await Promise.resolve();
    spawn.finish();
    const out = await running;
    expect(out.parked).toBe(parked);
    expect(out).not.toHaveProperty('session');
  });

  // RUN-30: the wait for a human is not the run's, so a resumed run's wall-clock accounting has to
  // pick up where the park left off rather than restart at zero.
  it('counts this sitting ON TOP of what a resume already spent active', async () => {
    const { host, spawn, plan, parkCalls } = harness();
    const running = executeRun(host, { ...plan, priorActiveSeconds: 120 });
    await Promise.resolve();
    spawn.finish();
    await running;
    expect(parkCalls[0]?.activeSeconds).toBeGreaterThanOrEqual(120);
    expect(parkCalls[0]?.activeSeconds).toBeLessThan(130);
  });

  it('hands the park the trailing output — usually the question a human is about to read', async () => {
    const { host, spawn, plan, parkCalls } = harness();
    const running = executeRun(host, plan);
    await Promise.resolve();
    spawn.text('which API should I use?');
    spawn.finish();
    await running;
    expect(parkCalls[0]?.tail).toBe('which API should I use?');
  });
});

describe('steering', () => {
  it('registers the live session and unregisters it however the run ends', async () => {
    const { host, spawn, plan, registered, unregistered } = harness();
    const running = executeRun(host, plan);
    await Promise.resolve();
    expect(registered).toEqual(['run_1']);
    expect(unregistered).toEqual([]);
    spawn.finish({ outcome: 'failed', isError: true, reason: 'budget' });
    await running;
    expect(unregistered).toEqual(['run_1']);
  });

  // RUN-170: the steering key IS the tally slot — the slot is already unique per concurrent
  // session, and two names for "which session am I" is two names that can disagree. Without this,
  // a wave's step sessions register under the bare runId and clobber each other.
  it('registers and unregisters under the tally slot on a decomposed run', async () => {
    const { host, spawn, plan, registered, unregistered } = harness();
    const running = executeRun(host, { ...plan, slot: 'step:s1', stepId: 's1' });
    await Promise.resolve();
    expect(registered).toEqual(['run_1#step:s1']);
    spawn.finish();
    await running;
    expect(unregistered).toEqual(['run_1#step:s1']);
  });
});
