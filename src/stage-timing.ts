import type { IntelligenceDurationMs, IntelligenceSource } from '@noriq-dev/shared';
import { monotonicMs } from './drivers/budget';

/**
 * The monotonic timing seam (RUN-242) shared by every stage that measures its own wall clock.
 *
 * Three sites (`stages/plan.ts`, `stages/plan-check.ts`, `stages/pattern-map.ts`) used to compute
 * elapsed time as `Date.now() - startedAt` and charge the difference straight to the run's
 * wall-clock budget. That is a bug, not a style choice: `Date.now()` is a WALL clock, and a wall
 * clock can step — an NTP correction, a suspend/resume — for reasons that have nothing to do with
 * how long the stage actually ran. A backward step charges the budget a negative duration (which
 * `IntelligenceDurationMs`'s own `nonnegative()` constraint rejects outright), and a forward step
 * charges a ceiling nobody spent. `drivers/budget.ts`'s `monotonicMs` (`performance.now()`) already
 * fixed this for the budget-supervision layer and for every stage added since (`execute.ts`,
 * `episode-summary.ts`) — this module is that same reading, re-exported under the timing-specific
 * vocabulary (`elapsedMs`, envelope builders) the three older sites and the verify gate both want,
 * and it is a re-export rather than a second implementation so the two never disagree about "now".
 *
 * Injectable by construction (this repo's testing strategy, CLAUDE.md): every function here takes
 * an optional `Clock`, so a test can drive elapsed time with a scripted sequence instead of waiting
 * on a real timer or fighting one that only ticks forward in whole milliseconds.
 */
export type Clock = () => number;

/** The default clock: `performance.now()`, the same reading the budget-supervision layer times
 *  against. Not a second implementation — see the module doc. */
export const defaultClock: Clock = monotonicMs;

/**
 * Milliseconds between a mark and now, clamped at zero.
 *
 * `performance.now()` is specified to be monotonic, so a negative reading should not be reachable
 * from the default clock — but a MISWIRED injected clock (a test double, or a future caller that
 * passes the wrong mark) producing one is a bug in the caller, not a reason to hand
 * `IntelligenceDurationMs`'s `nonnegative()` check a value it will throw on. Clamping here is the
 * one place that can never be skipped, rather than trusting every envelope builder to remember it.
 */
export function elapsedMs(startedAt: number, clock: Clock = defaultClock): number {
  return Math.max(0, clock() - startedAt);
}

/** Where a duration envelope's `source`/`sourceId` point (RUN-242) — every envelope this module's
 *  callers build names one, so a reader can tell a runner-observed reading from a driver-reported
 *  one without inspecting `provenance` alone. */
export interface DurationSource {
  source: IntelligenceSource;
  sourceId?: string | null;
}

const nowIso = (): string => new Date().toISOString();

const observation = (source: DurationSource, reason: string | null) => ({
  provenance: 'runner_observed' as const,
  source: source.source,
  sourceId: source.sourceId ?? null,
  observedAt: nowIso(),
  acceptedAt: nowIso(),
  reason,
});

/** A duration the daemon actually measured, start mark to finish mark. */
export function completeDuration(
  elapsedMs: number,
  source: DurationSource,
  reason: string | null = null,
): IntelligenceDurationMs {
  return { status: 'complete', value: elapsedMs, ...observation(source, reason) };
}

/**
 * The stage could not run here — no command was configured, or the workflow declines this stage
 * (RUN-242's own acceptance names this explicitly). `value` is forced `null` by the schema: this is
 * the envelope a caller reports INSTEAD of simply not measuring anything, so "0ms" never has to
 * stand in for "did not run" — the failure mode the task calls out by name.
 */
export function notApplicableDuration(source: DurationSource, reason: string): IntelligenceDurationMs {
  return { status: 'not_applicable', value: null, ...observation(source, reason) };
}

/** The stage ran, but the boundary between "started" and "settled" was lost — a crash or a thrown
 *  error between the two marks. Distinct from `not_applicable` (never started) and from `complete`
 *  (both marks landed): this is "we do not actually know how long it took", which is a different
 *  fact than either. */
export function unavailableDuration(source: DurationSource, reason: string): IntelligenceDurationMs {
  return { status: 'unavailable', value: null, ...observation(source, reason) };
}
