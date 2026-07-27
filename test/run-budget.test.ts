import type { RunBudget } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import { zeroTelemetry } from '../src/drivers/types';
import { exceedsRun, reserveFromRun } from '../src/run-budget';

// RUN-133. Every `startAgent` used to receive a fresh copy of the run's ceiling and `superviseBudget`
// only ever saw one session's telemetry, so a build with a reviewer and a conflict turn could spend
// the dispatched budget three times over and no single check would fire. This is the subtraction
// that makes them divide one ceiling instead.

const ceiling = (over: Partial<RunBudget> = {}): RunBudget => ({
  maxTokens: null,
  maxUsd: null,
  maxDurationSeconds: null,
  maxRounds: null,
  ...over,
});
const spent = (over: { tokens?: number; usd?: number; seconds?: number } = {}) => ({
  telemetry: { ...zeroTelemetry(), inputTokens: over.tokens ?? 0, costUsd: over.usd ?? 0 },
  activeSeconds: over.seconds ?? 0,
});

describe('reserveFromRun hands out the remainder, never the ceiling', () => {
  it('no ceiling means no reservation to make', () => {
    expect(reserveFromRun(null, spent({ tokens: 10_000 }))).toEqual({ ok: true, budget: undefined });
    expect(reserveFromRun(undefined, spent())).toEqual({ ok: true, budget: undefined });
  });

  // The property the whole task exists for: what one session may spend plus what the run already
  // spent equals the ceiling. Sum across sessions is therefore bounded by construction.
  it('spent + reservation = ceiling, on every dimension', () => {
    const c = ceiling({ maxTokens: 1000, maxUsd: 5, maxDurationSeconds: 600 });
    const r = reserveFromRun(c, spent({ tokens: 400, usd: 1.25, seconds: 90 }));
    expect(r.ok && r.budget).toEqual({
      maxTokens: 600,
      maxUsd: 3.75,
      maxDurationSeconds: 510,
      maxRounds: null,
    });
  });

  it('an unbounded dimension stays unbounded — it does not acquire a limit nobody asked for', () => {
    const r = reserveFromRun(ceiling({ maxTokens: 1000 }), spent({ tokens: 100, usd: 9, seconds: 900 }));
    expect(r.ok && r.budget).toEqual({
      maxTokens: 900,
      maxUsd: null,
      maxDurationSeconds: null,
      maxRounds: null,
    });
  });

  // `maxRounds` caps how many times the reviewer LOOKS, not what anything spends. Decrementing it
  // by tokens would be a category error (RUN-91).
  it('carries maxRounds through verbatim rather than decrementing it', () => {
    const r = reserveFromRun(ceiling({ maxTokens: 1000, maxRounds: 2 }), spent({ tokens: 999 }));
    expect(r.ok && r.budget?.maxRounds).toBe(2);
  });
});

describe('reserveFromRun refuses when a dimension is gone', () => {
  it('names the dimension that ran out, not just "budget"', () => {
    expect(reserveFromRun(ceiling({ maxTokens: 100 }), spent({ tokens: 100 }))).toMatchObject({
      ok: false,
      breach: 'budget:tokens',
    });
    expect(reserveFromRun(ceiling({ maxUsd: 1 }), spent({ usd: 1.5 }))).toMatchObject({
      ok: false,
      breach: 'budget:usd',
    });
    expect(reserveFromRun(ceiling({ maxDurationSeconds: 60 }), spent({ seconds: 61 }))).toMatchObject({
      ok: false,
      breach: 'budget:duration',
    });
  });

  it('ANY exhausted dimension is exhausted, even with room on the others', () => {
    const c = ceiling({ maxTokens: 1000, maxUsd: 1 });
    expect(reserveFromRun(c, spent({ tokens: 10, usd: 1 })).ok).toBe(false);
  });

  // Exactly-at-the-ceiling is out, not "one more free session at zero". `>=`, deliberately.
  it('treats spending exactly the ceiling as exhausted', () => {
    expect(reserveFromRun(ceiling({ maxTokens: 100 }), spent({ tokens: 100 })).ok).toBe(false);
    expect(reserveFromRun(ceiling({ maxTokens: 100 }), spent({ tokens: 99 })).ok).toBe(true);
  });

  // The trap the park-resume helper this replaces worked around by flooring at 1 token: a remainder
  // of exactly zero reads as "no limit" to `superviseBudget`, turning an exhausted run into an
  // unlimited one. Refusing is the answer; a one-token budget just spawns a process to kill it.
  it('never returns a zero remainder, which would read as unbounded', () => {
    const r = reserveFromRun(ceiling({ maxTokens: 100 }), spent({ tokens: 100 }));
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty('budget');
  });

  it('says how much of what was spent, so the comment a human reads is specific', () => {
    const r = reserveFromRun(ceiling({ maxUsd: 2 }), spent({ usd: 2.5 }));
    expect(r.ok === false && r.detail).toMatch(/\$2\.50 of its \$2\.00 ceiling/);
  });
});

describe('the dimensions are independent (RUN-14 per-dimension semantics)', () => {
  it('a token-only ceiling never bounds time or money', () => {
    const r = reserveFromRun(ceiling({ maxTokens: 10 }), spent({ seconds: 100_000, usd: 500 }));
    expect(r.ok).toBe(true);
  });

  it('a time-only ceiling never bounds tokens', () => {
    const r = reserveFromRun(ceiling({ maxDurationSeconds: 100 }), spent({ tokens: 10_000_000 }));
    expect(r.ok && r.budget?.maxDurationSeconds).toBe(100);
  });
});

// The second half of the enforcement pair, and the one an adversarial review caught me getting
// wrong by reusing `reserveFromRun`: the two answer different questions and differ by one token.
describe('exceedsRun judges a session already running', () => {
  it('is strictly OVER — spending exactly the ceiling is not a breach', () => {
    // The failure this exists to prevent: a builder at 950 plus a reviewer at 50 lands precisely on
    // a 1000 ceiling. It spent what it was allowed; killing it fails a run that stayed in budget.
    expect(exceedsRun(ceiling({ maxTokens: 1000 }), spent({ tokens: 1000 }))).toBeNull();
    expect(exceedsRun(ceiling({ maxTokens: 1000 }), spent({ tokens: 1001 }))).toBe('budget:tokens');
  });

  // …while the reservation at that same number says "no more sessions", because the only thing it
  // could hand out is a zero budget.
  it('disagrees with reserveFromRun at the boundary, on purpose', () => {
    const c = ceiling({ maxTokens: 1000 });
    const at = spent({ tokens: 1000 });
    expect(exceedsRun(c, at)).toBeNull(); // do not kill what is running
    expect(reserveFromRun(c, at).ok).toBe(false); // do not start another
  });

  it('matches the per-session check, so the two layers agree on what a breach is', () => {
    expect(exceedsRun(ceiling({ maxUsd: 2 }), spent({ usd: 2 }))).toBeNull();
    expect(exceedsRun(ceiling({ maxUsd: 2 }), spent({ usd: 2.01 }))).toBe('budget:usd');
  });

  it('no ceiling, no breach', () => {
    expect(exceedsRun(null, spent({ tokens: 10_000 }))).toBeNull();
  });

  // A running session's seconds are not in the tally until it ends, so checking them here would
  // only ever read a stale number. RUN-159 is where a turn's duration gets a real bound.
  it('does not judge wall-clock — that number is stale while a session runs', () => {
    expect(exceedsRun(ceiling({ maxDurationSeconds: 10 }), spent({ seconds: 9999 }))).toBeNull();
  });
});
