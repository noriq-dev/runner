import type { RunBudget } from '@noriq-dev/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { superviseBudget, totalTokens } from '../src/drivers/budget';
import type {
  AgentDriver,
  DriverCapabilities,
  DriverCatalog,
  DriverExit,
  DriverSession,
  DriverStartOptions,
  DriverTelemetry,
} from '../src/drivers/types';
import { zeroTelemetry } from '../src/drivers/types';

// A driver whose session the test drives directly: emit telemetry, complete
// naturally, and observe stop().
class FakeDriver implements AgentDriver {
  readonly tool = 'claude' as const;
  readonly capabilities: DriverCapabilities = {
    toolHooks: true,
    steer: true,
    interrupt: true,
    resumableSession: true,
    perModelTelemetry: true,
  };
  readonly catalog: DriverCatalog = { models: [], efforts: [] };
  handlers!: DriverStartOptions['handlers'];
  stops = 0;
  private settle!: (e: DriverExit) => void;
  private donePromise!: Promise<DriverExit>;
  /** The hand-back turn currently awaiting an answer, if any (RUN-29/30 multiTurn). */
  private turn: ((e: DriverExit) => void) | null = null;
  private started?: DriverSession;

  start(opts: DriverStartOptions) {
    this.handlers = opts.handlers;
    this.donePromise = new Promise<DriverExit>((r) => {
      this.settle = r;
    });
    this.started = {
      runId: opts.runId,
      pushInput: () => true,
      interrupt: async () => {},
      stop: async () => {
        this.stops += 1;
        const exit: DriverExit = {
          outcome: 'failed',
          isError: true,
          reason: 'stopped',
          telemetry: zeroTelemetry(),
        };
        // Settling the pending turn is the real driver's behaviour, not a convenience: a stop()
        // that leaves `continueWith` unresolved hangs whoever awaited it (fixed in claude.ts
        // during RUN-133), and a fake that forgives it cannot test a turn being cut short.
        const pending = this.turn;
        this.turn = null;
        pending?.(exit);
        this.handlers?.onExit?.(exit);
        this.settle(exit);
      },
      done: () => this.donePromise,
      // Only a multiTurn session has one — the contract the supervisor branches on.
      ...(opts.multiTurn
        ? {
            continueWith: (_text: string) =>
              new Promise<DriverExit>((resolve, reject) => {
                // Rejecting an overlap is claude.ts's behaviour, not a nicety: a fake that queued
                // the second turn instead would hide what the budget layer does with a rejection.
                if (this.turn) return reject(new Error('a turn is already in flight'));
                this.turn = resolve;
              }),
          }
        : {}),
    };
    return this.started;
  }

  /** The session start() handed back — the object the budget wrapper wraps. */
  session(): DriverSession {
    if (!this.started) throw new Error('not started');
    return this.started;
  }

  /** Is a hand-back turn waiting on the agent? False means nothing was ever pushed. */
  pendingTurn(): boolean {
    return this.turn !== null;
  }

  /** Answer the in-flight hand-back turn, as a driver does when the agent replies. */
  answerTurn(t: Partial<DriverTelemetry> = {}): void {
    const pending = this.turn;
    this.turn = null;
    pending?.({ outcome: 'done', isError: false, reason: null, telemetry: { ...zeroTelemetry(), ...t } });
  }

  emit(t: Partial<DriverTelemetry>): void {
    this.handlers?.onTelemetry?.({ ...zeroTelemetry(), ...t });
  }
  complete(t: Partial<DriverTelemetry> = {}): void {
    const exit: DriverExit = {
      outcome: 'done',
      isError: false,
      reason: null,
      telemetry: { ...zeroTelemetry(), ...t },
    };
    this.handlers?.onExit?.(exit);
    this.settle(exit);
  }
}

const budget = (over: Partial<RunBudget> = {}): RunBudget => ({
  maxTokens: null,
  maxUsd: null,
  maxDurationSeconds: null,
  maxRounds: null,
  ...over,
});

const startOpts = (b: RunBudget): DriverStartOptions => ({
  runId: 'run_1',
  kind: 'build',
  cwd: '/wt',
  prompt: 'x',
  permission: { write: true, allow: [], deny: [], auto: false },
  budget: b,
});

// `performance` joins the default fakes because the wall-clock ledger measures itself with
// `performance.now()` — a monotonic source, so an NTP step cannot credit a stretch negative time
// (RUN-159). A fake clock that moved `Date` but not `performance` would leave every stretch
// measured as zero and the ledger permanently full.
beforeEach(() =>
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  }),
);
afterEach(() => vi.useRealTimers());

describe('totalTokens', () => {
  it('sums input + output + cache', () => {
    expect(
      totalTokens({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheCreationTokens: 1,
        costUsd: 0,
        numTurns: 0,
      }),
    ).toBe(18);
  });
});

describe('superviseBudget', () => {
  it('passes a natural completion through untouched when under budget', async () => {
    const d = new FakeDriver();
    const run = superviseBudget(d, startOpts(budget({ maxTokens: 1000 })));
    d.emit({ inputTokens: 100, outputTokens: 50 });
    d.complete({ inputTokens: 100, outputTokens: 60 });
    const exit = await run.done;
    expect(exit.outcome).toBe('done');
    expect(d.stops).toBe(0);
  });

  it('SIGTERMs and fails with budget:tokens on a token breach', async () => {
    const d = new FakeDriver();
    const run = superviseBudget(d, startOpts(budget({ maxTokens: 150 })));
    d.emit({ inputTokens: 100, outputTokens: 40 }); // 140 — ok
    expect(d.stops).toBe(0);
    d.emit({ inputTokens: 120, outputTokens: 50 }); // 170 — breach
    const exit = await run.done;
    expect(d.stops).toBe(1); // process SIGTERM'd
    expect(exit).toMatchObject({ outcome: 'failed', reason: 'budget:tokens' });
  });

  it('fails with budget:usd on a cost breach', async () => {
    const d = new FakeDriver();
    const run = superviseBudget(d, startOpts(budget({ maxUsd: 1.0 })));
    d.emit({ costUsd: 1.5 });
    const exit = await run.done;
    expect(exit).toMatchObject({ outcome: 'failed', reason: 'budget:usd' });
    expect(d.stops).toBe(1);
  });

  it('fails with budget:duration when the wall-clock deadline fires', async () => {
    const d = new FakeDriver();
    const run = superviseBudget(d, startOpts(budget({ maxDurationSeconds: 30 })));
    vi.advanceTimersByTime(29_000);
    expect(d.stops).toBe(0);
    vi.advanceTimersByTime(2_000); // past 30s
    const exit = await run.done;
    expect(exit).toMatchObject({ outcome: 'failed', reason: 'budget:duration' });
    expect(d.stops).toBe(1);
  });

  it('clears the deadline timer on natural completion (no late breach)', async () => {
    const d = new FakeDriver();
    const run = superviseBudget(d, startOpts(budget({ maxDurationSeconds: 30 })));
    d.complete();
    const exit = await run.done;
    expect(exit.outcome).toBe('done');
    vi.advanceTimersByTime(60_000); // deadline would have fired — but it was cleared
    expect(d.stops).toBe(0);
  });

  it('first breach wins (only one stop)', async () => {
    const d = new FakeDriver();
    const run = superviseBudget(d, startOpts(budget({ maxTokens: 10, maxUsd: 0.01 })));
    d.emit({ inputTokens: 100, costUsd: 5 }); // both limits exceeded at once
    await run.done;
    expect(d.stops).toBe(1);
  });
});

// RUN-133. `superviseBudget` polices ONE session; the run-level allocator sits above it and needs a
// way in, because a session can outlive the ceiling it was handed — a multiTurn builder is kept
// open while the reviewer spends from the same run budget.
describe('the run-level spend guard (RUN-133)', () => {
  it('stops the session when the guard answers, even with room in its own budget', async () => {
    const d = new FakeDriver();
    const run = superviseBudget(d, {
      ...startOpts(budget({ maxTokens: 1_000_000 })),
      // The session is nowhere near ITS ceiling; the RUN is over. Only the guard can know that.
      spendGuard: () => 'budget:tokens',
    });
    d.emit({ outputTokens: 1 });
    await vi.advanceTimersByTimeAsync(0);
    const exit = await run.done;
    expect(exit.outcome).toBe('failed');
    expect(exit.reason).toBe('budget:tokens');
    expect(d.stops).toBe(1);
  });

  it('leaves the session alone while the guard answers null', async () => {
    const d = new FakeDriver();
    const run = superviseBudget(d, { ...startOpts(budget()), spendGuard: () => null });
    d.emit({ outputTokens: 5000 });
    d.complete({ outputTokens: 5000 });
    expect((await run.done).outcome).toBe('done');
    expect(d.stops).toBe(0);
  });

  it('takes precedence over the per-session budget, which stays the fallback', async () => {
    const d = new FakeDriver();
    const run = superviseBudget(d, {
      ...startOpts(budget({ maxTokens: 10 })),
      spendGuard: () => null, // the run is fine…
    });
    d.emit({ outputTokens: 100 }); // …but this session is over ITS OWN ceiling
    await vi.advanceTimersByTimeAsync(0);
    expect((await run.done).reason).toBe('budget:tokens');
  });

  // `onTelemetry` is OPTIONAL in the driver contract while every exit carries a figure, so a driver
  // that reports its spend only at the end used to slip past every check and report `done`.
  it('checks the EXIT telemetry too, so a tickless driver cannot overspend silently', async () => {
    const d = new FakeDriver();
    const run = superviseBudget(d, startOpts(budget({ maxTokens: 100 })));
    d.complete({ inputTokens: 500 }); // no tick at all — the spend arrives with the exit
    const exit = await run.done;
    expect(exit.reason).toBe('budget:tokens');
    expect(exit.outcome).toBe('failed');
  });
});

// RUN-159. A multiTurn session's first result CLEARS the wall-clock deadline, and that result is
// where such a session's life begins rather than ends — so every hand-back turn used to run with no
// time bound at all. The token axis was closed by RUN-133's spendGuard; a turn spending only time
// had nothing watching it.
describe('the per-turn wall-clock deadline (RUN-159)', () => {
  const multiTurn = (b: RunBudget): DriverStartOptions => ({ ...startOpts(b), multiTurn: true });

  it('stops a hand-back turn that hangs past the deadline', async () => {
    const d = new FakeDriver();
    const run = superviseBudget(d, multiTurn(budget({ maxDurationSeconds: 30 })));
    d.complete(); // first result — under multiTurn the session stays OPEN
    expect((await run.done).outcome).toBe('done');
    expect(d.stops).toBe(0);

    const turn = run.session.continueWith?.('fix the type error');
    vi.advanceTimersByTime(31_000); // the turn simply never answers
    expect(d.stops).toBe(1);
    // …and the turn says WHY. The driver settles a stopped turn as `reason:'stopped'`, which is
    // true and useless; `done` already resolved on the first result, so this exit is the only
    // place its caller can learn the session ran out of clock.
    expect(await turn).toMatchObject({ outcome: 'failed', reason: 'budget:duration' });
  });

  // The whole point, and the thing a first cut got wrong: a turn is armed for the REMAINDER. Each
  // turn re-receiving the full ceiling is the per-session-copy bug RUN-133 removed from tokens and
  // USD — a 30s run could then take 29s, then 29s more, then 29s more, forever.
  it('charges each turn against the session remainder, not a fresh copy of the ceiling', async () => {
    const d = new FakeDriver();
    const run = superviseBudget(d, multiTurn(budget({ maxDurationSeconds: 30 })));
    vi.advanceTimersByTime(10_000); // the first turn takes 10s of the 30
    d.complete();
    await run.done;

    const first = run.session.continueWith?.('round 1');
    vi.advanceTimersByTime(15_000); // 25s of 30 spent
    d.answerTurn();
    expect(await first).toMatchObject({ outcome: 'done' });
    expect(d.stops).toBe(0);

    // Idle between turns is the caller running the verify floor, not the agent working — the
    // session is not armed, so it is not charged.
    vi.advanceTimersByTime(60_000);
    expect(d.stops).toBe(0);

    const second = run.session.continueWith?.('round 2');
    vi.advanceTimersByTime(4_000); // 29s — still inside
    expect(d.stops).toBe(0);
    vi.advanceTimersByTime(2_000); // …past 30s of ARMED time
    expect(d.stops).toBe(1);
    expect(await second).toMatchObject({ reason: 'budget:duration' });
  });

  // A live, healthy session with the run's clock spent under it — the realistic shape, because the
  // seconds ran out somewhere ELSE (a reviewer) while this session sat idle between turns.
  it('declines a turn outright once the clock is gone, rather than starting one to kill', async () => {
    const d = new FakeDriver();
    let runSecondsLeft = 30;
    const run = superviseBudget(d, {
      ...multiTurn(budget({ maxDurationSeconds: 30 })),
      clockGuard: () => runSecondsLeft,
    });
    d.complete();
    await run.done;
    expect(d.stops).toBe(0); // the session is alive and well

    runSecondsLeft = 0; // a reviewer spent the rest of the run's clock
    const turn = await run.session.continueWith?.('one more?');
    expect(turn).toMatchObject({ outcome: 'failed', reason: 'budget:duration' });
    expect(d.pendingTurn()).toBe(false); // nothing was ever pushed at the agent
    expect(d.stops).toBe(1); // …and the session was closed rather than left holding a worktree
  });

  // The run's ceiling, not just this session's snapshot: a session held open across a reviewer's
  // spend is re-armed against what the RUN has left. This is `spendGuard`'s problem on the time
  // axis — the session's own allowance was computed before the reviewer existed.
  it('arms a turn against the run remainder when that is tighter than the session allowance', async () => {
    const d = new FakeDriver();
    let runSecondsLeft = 30;
    const run = superviseBudget(d, {
      ...multiTurn(budget({ maxDurationSeconds: 30 })), // this session thinks it has all 30
      clockGuard: () => runSecondsLeft,
    });
    d.complete();
    await run.done;

    runSecondsLeft = 5; // a reviewer took 25 of the run's 30 seconds
    const turn = run.session.continueWith?.('fix it');
    vi.advanceTimersByTime(4_000);
    expect(d.stops).toBe(0);
    vi.advanceTimersByTime(2_000); // past the RUN's 5, nowhere near the session's 30
    expect(d.stops).toBe(1);
    expect(await turn).toMatchObject({ reason: 'budget:duration' });
  });

  // The driver rejects an overlapping turn (claude.ts). A shared timer slot would let that
  // rejected turn's cleanup disarm the LIVE one — and the orphaned timer would then stop the
  // session in the middle of a later, perfectly legitimate turn.
  it('gives each turn its own timer, so a rejected overlap cannot orphan one', async () => {
    const d = new FakeDriver();
    const run = superviseBudget(d, multiTurn(budget({ maxDurationSeconds: 60 })));
    d.complete();
    await run.done;

    const first = run.session.continueWith?.('round 1');
    await expect(run.session.continueWith?.('overlapping')).rejects.toThrow(/already in flight/);
    vi.advanceTimersByTime(5_000);
    d.answerTurn(); // the live turn finishes well inside the ceiling and disarms ITS timer
    expect(await first).toMatchObject({ outcome: 'done' });

    // Idle: the caller is running the verify floor, the session is not armed, nothing is charged.
    // This is what separates the orphan's deadline (60s from turn 1's start) from the next turn's
    // own (55s of REMAINDER from whenever it starts), and so what makes this test discriminating.
    vi.advanceTimersByTime(35_000);

    // Under a shared slot the overlap's cleanup would have disarmed the live turn's timer, leaving
    // the overlap's own armed to fire at 60s — in the middle of this perfectly legitimate turn.
    const second = run.session.continueWith?.('round 2');
    vi.advanceTimersByTime(25_000); // past the orphan's 60s, well inside this turn's 55
    expect(d.stops).toBe(0);
    d.answerTurn();
    expect(await second).toMatchObject({ outcome: 'done' });
  });

  // `breach` is a SESSION-scoped fact, and the rewrite above reads it after the turn returns. A
  // session that already breached must therefore take no further work — otherwise a later turn that
  // ran perfectly normally is relabelled with an old breach, which is a worse lie than the one the
  // rewrite fixes.
  it('refuses another turn once the session has breached, rather than relabelling a good one', async () => {
    const d = new FakeDriver();
    let over = false;
    const run = superviseBudget(d, {
      ...multiTurn(budget()),
      spendGuard: () => (over ? 'budget:tokens' : null),
    });
    d.complete();
    await run.done;

    over = true; // the reviewer spent the rest of the run's tokens
    const first = run.session.continueWith?.('round 1');
    d.emit({ outputTokens: 1 }); // the guard trips on the tick → the turn is cut short
    expect(await first).toMatchObject({ reason: 'budget:tokens' });

    const second = run.session.continueWith?.('round 2');
    expect(d.pendingTurn()).toBe(false); // declined outright — never handed to the agent
    expect(await second).toMatchObject({ outcome: 'failed', reason: 'budget:tokens' });
  });

  it('arms nothing for a turn when the run has no duration ceiling', async () => {
    const d = new FakeDriver();
    const run = superviseBudget(d, multiTurn(budget({ maxTokens: 1000 })));
    d.complete();
    await run.done;
    const turn = run.session.continueWith?.('take your time');
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(d.stops).toBe(0);
    d.answerTurn();
    expect(await turn).toMatchObject({ outcome: 'done' });
  });

  // The wrapper sits in front of the driver's session; everything else about it must still read
  // through. `sessionId` in particular is assigned by the driver AFTER start() and is what parks a
  // run (RUN-30) — a snapshot would park it with a stale id, or none at all.
  it('passes the rest of the session through, including a sessionId set after start', async () => {
    const d = new FakeDriver();
    const run = superviseBudget(d, multiTurn(budget()));
    const raw = d.session();
    expect(run.session.sessionId).toBeUndefined();
    raw.sessionId = 'sess_abc'; // the SDK tells us the id on its first message
    expect(run.session.sessionId).toBe('sess_abc');
    expect(run.session.runId).toBe('run_1');
    expect(run.session.pushInput('steer')).toBe(true);
  });

  // Every driver today builds its session from closures, so a wrapper that passes methods through
  // with the WRONG receiver would work fine and ship unnoticed — until a driver returns a class
  // instance. That is the RUN-131 defect exactly, and it is why the wrapper delegates by hand
  // instead of inheriting from the session.
  it('preserves the receiver, so a class-instance session keeps working through the wrapper', async () => {
    class ClassSession implements DriverSession {
      readonly runId = 'run_1';
      // A `#private` read THROWS when `this` is not the instance itself — an object that merely
      // inherits from it does not carry the brand. That is the assertion: no bookkeeping to fake
      // past, and it fails loudly rather than by a subtly wrong value.
      #brand = 'real';
      calls: string[] = [];
      private settleDone!: (e: DriverExit) => void;
      private readonly donePromise = new Promise<DriverExit>((r) => {
        this.settleDone = r;
      });
      private note(name: string) {
        this.calls.push(`${name}:${this.#brand}`);
      }
      pushInput(_t: string) {
        this.note('pushInput');
        return true;
      }
      async interrupt() {
        this.note('interrupt');
      }
      async stop() {
        this.note('stop');
        this.settleDone({ outcome: 'done', isError: false, reason: null, telemetry: zeroTelemetry() });
      }
      done() {
        this.note('done');
        return this.donePromise;
      }
      async continueWith(_t: string): Promise<DriverExit> {
        this.note('continueWith');
        return { outcome: 'done', isError: false, reason: null, telemetry: zeroTelemetry() };
      }
    }
    const impl = new ClassSession();
    const driver: AgentDriver = {
      tool: 'claude',
      capabilities: new FakeDriver().capabilities,
      catalog: { models: [], efforts: [] },
      start: () => impl,
    };

    const run = superviseBudget(driver, multiTurn(budget({ maxDurationSeconds: 30 })));
    run.session.pushInput('x');
    await run.session.interrupt();
    void run.session.done();
    await run.session.continueWith?.('fix it');
    await run.session.stop(); // the WRAPPER's stop, not BudgetRun's — that one holds the raw session
    // Every call reached the real instance. A prototype wrapper would run them with `this` bound to
    // the wrapper, where the private-field read throws and any write (`this.closed = true`) would
    // land on the wrapper instead of the session.
    expect(impl.calls).toEqual([
      'pushInput:real',
      'interrupt:real',
      'done:real',
      'continueWith:real',
      'stop:real',
    ]);
  });

  it('leaves a single-turn session untouched — it has no continueWith to wrap', async () => {
    const d = new FakeDriver();
    const run = superviseBudget(d, startOpts(budget({ maxDurationSeconds: 30 })));
    expect(run.session.continueWith).toBeUndefined();
    expect(run.session).toBe(d.session());
  });
});
