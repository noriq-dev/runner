import { IntelligenceDurationMs } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import {
  type Clock,
  completeDuration,
  elapsedMs,
  notApplicableDuration,
  unavailableDuration,
} from '../src/stage-timing';

// RUN-242. The monotonic timing seam: every duration measured in src/ goes through this module
// rather than a Date.now() difference, so a wall-clock step (NTP correction, suspend/resume)
// cannot charge a budget a negative or inflated stretch.

describe('elapsedMs', () => {
  it('reads the difference between a mark and the clock at call time', () => {
    let now = 1_000;
    const clock: Clock = () => now;
    const startedAt = clock(); // 1000
    now = 4_500;
    expect(elapsedMs(startedAt, clock)).toBe(3_500);
  });

  // The specific failure mode this module exists to rule out: a wall clock can run backwards
  // (an NTP step, a suspend/resume) and a `Date.now()` difference would go negative — which
  // `IntelligenceDurationMs`'s own `nonnegative()` constraint rejects at the schema boundary. An
  // injected clock proves the guarantee without needing a real timer or a system-clock mock: even
  // a clock that itself runs backwards between the two reads must never produce a negative elapsed
  // value out of this function.
  it('never yields a negative duration, even from a clock that runs backwards', () => {
    const readings = [5_000, 1_000]; // second reading LOWER than the first — a backward step
    const clock: Clock = () => readings.shift() as number;
    const startedAt = clock(); // 5000
    expect(elapsedMs(startedAt, clock)).toBe(0); // clamped, never negative
  });
});

describe('duration envelopes', () => {
  it('completeDuration carries the measured value and passes the wire schema', () => {
    const d = completeDuration(1234, { source: 'runner', sourceId: 'verify' });
    expect(d.status).toBe('complete');
    expect(d.value).toBe(1234);
    expect(d.provenance).toBe('runner_observed');
    expect(() => IntelligenceDurationMs.parse(d)).not.toThrow();
  });

  // The task's own named failure mode: 0 must never stand in for "unknown" or "did not run". The
  // schema forces `value: null` on both non-measuring statuses — asserted here, not inferred from
  // the builder's intent.
  it('notApplicableDuration forces value to null, never 0', () => {
    const d = notApplicableDuration({ source: 'runner' }, 'no [verify].cmd configured for this repo');
    expect(d.status).toBe('not_applicable');
    expect(d.value).toBeNull();
    expect(d.reason).toMatch(/no \[verify\]\.cmd/);
    expect(() => IntelligenceDurationMs.parse(d)).not.toThrow();
  });

  it('unavailableDuration also forces value to null', () => {
    const d = unavailableDuration({ source: 'runner' }, 'boundary lost');
    expect(d.status).toBe('unavailable');
    expect(d.value).toBeNull();
    expect(() => IntelligenceDurationMs.parse(d)).not.toThrow();
  });

  it('a negative elapsed value would fail the wire schema — proving the clamp is load-bearing', () => {
    // Bypassing elapsedMs's clamp on purpose, to show the schema really would reject what it
    // exists to prevent — the reason `elapsedMs` clamps rather than trusting every caller to.
    expect(() => IntelligenceDurationMs.parse(completeDuration(-1, { source: 'runner' }))).toThrow();
  });
});
