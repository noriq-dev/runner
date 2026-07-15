import type { RunBudget } from '@noriq-dev/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { superviseBudget, totalTokens } from '../src/drivers/budget';
import type { AgentDriver, DriverExit, DriverStartOptions, DriverTelemetry } from '../src/drivers/types';
import { zeroTelemetry } from '../src/drivers/types';

// A driver whose session the test drives directly: emit telemetry, complete
// naturally, and observe stop().
class FakeDriver implements AgentDriver {
  readonly tool = 'claude' as const;
  handlers!: DriverStartOptions['handlers'];
  stops = 0;
  private settle!: (e: DriverExit) => void;
  private donePromise!: Promise<DriverExit>;

  start(opts: DriverStartOptions) {
    this.handlers = opts.handlers;
    this.donePromise = new Promise<DriverExit>((r) => {
      this.settle = r;
    });
    return {
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
        this.handlers?.onExit?.(exit);
        this.settle(exit);
      },
      done: () => this.donePromise,
    };
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
  ...over,
});

const startOpts = (b: RunBudget): DriverStartOptions => ({
  runId: 'run_1',
  kind: 'build',
  cwd: '/wt',
  prompt: 'x',
  permission: { write: true, network: 'restricted', allow: [], deny: [] },
  budget: b,
});

beforeEach(() => vi.useFakeTimers());
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
