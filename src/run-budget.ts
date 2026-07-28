/**
 * The run-level budget allocator (RUN-133).
 *
 * `superviseBudget` (drivers/budget.ts) is a per-SESSION ceiling: it watches one session's telemetry
 * and SIGTERMs on breach. That is correct and stays. What was missing is the layer above it — every
 * `startAgent` call received a fresh copy of the run's ceiling and observed only its own spend, so a
 * build with a reviewer and a conflict-repair turn could spend the dispatched budget THREE times and
 * no single check would ever fire. `RunTally` aggregated them, but only to report the number.
 *
 * The fix is a subtraction, not a new enforcement mechanism: each session is handed the REMAINDER
 * rather than the ceiling, so `spent + reservation = ceiling` holds by construction and the existing
 * per-session SIGTERM does the enforcing. Nothing here kills anything.
 *
 * It matters before phases 4–6, not after: every pre-execution stage (planner, checker,
 * pattern-mapper) is another session, and under the old arrangement each one multiplied the ceiling
 * again.
 */

import type { RunBudget } from '@noriq-dev/shared';
import { type BudgetBreach, totalTokens } from './drivers/budget';
import type { DriverTelemetry } from './drivers/types';

/** What a run has burned so far, across every session that billed to it. */
export interface RunSpend {
  /** The cumulative telemetry — `RunTally.total()`, which already folds prior sittings. */
  telemetry: DriverTelemetry;
  /**
   * Seconds the AGENT was actually running. Not wall-clock since dispatch: the wait for a human on
   * a parked run is not the run's, and neither is the daemon's own zero-token verify command
   * (RUN-30's accounting, kept).
   */
  activeSeconds: number;
}

/**
 * What the next session may spend — or the dimension that is already gone.
 *
 * A discriminated result rather than a clamped-to-tiny budget, because those are different
 * instructions. The park-resume helper this replaces floored at `Math.max(1, …)` tokens so an
 * exhausted run still got *something* — which spawns a process, hands it one token, and SIGTERMs it
 * on the first tick. Same terminal outcome, minus a wasted spawn and plus a reason a human can
 * read. Here the caller learns it has nothing to spend BEFORE spawning, and can say what happened.
 */
export type BudgetReservation =
  | { ok: true; budget: RunBudget | undefined }
  | { ok: false; breach: BudgetBreach; detail: string };

/**
 * The remainder of `ceiling` after `spent`, per dimension.
 *
 * Per-dimension for the same reason `mergeBudget` is: a run that exhausted its USD but has tokens
 * left is out, and a ceiling that only sets tokens must not acquire a USD or wall-clock limit here
 * that nobody asked for. A null dimension stays null — unbounded is unbounded.
 *
 * `maxRounds` passes through verbatim: it caps how many times the reviewer may look, not what
 * anything spends, so decrementing it by tokens would be a category error (RUN-91).
 */
export function reserveFromRun(ceiling: RunBudget | null | undefined, spent: RunSpend): BudgetReservation {
  if (!ceiling) return { ok: true, budget: undefined };

  const tokens = totalTokens(spent.telemetry);
  if (ceiling.maxTokens != null && tokens >= ceiling.maxTokens) {
    return {
      ok: false,
      breach: 'budget:tokens',
      detail: `the run has spent ${tokens} of its ${ceiling.maxTokens}-token ceiling`,
    };
  }
  if (ceiling.maxUsd != null && spent.telemetry.costUsd >= ceiling.maxUsd) {
    return {
      ok: false,
      breach: 'budget:usd',
      detail: `the run has spent $${spent.telemetry.costUsd.toFixed(2)} of its $${ceiling.maxUsd.toFixed(2)} ceiling`,
    };
  }
  if (ceiling.maxDurationSeconds != null && spent.activeSeconds >= ceiling.maxDurationSeconds) {
    return {
      ok: false,
      breach: 'budget:duration',
      detail: `the run has used ${Math.round(spent.activeSeconds)}s of its ${ceiling.maxDurationSeconds}s ceiling`,
    };
  }

  const left = (max: number | null, used: number) => (max == null ? null : max - used);
  return {
    ok: true,
    budget: {
      maxTokens: left(ceiling.maxTokens, tokens),
      maxUsd: left(ceiling.maxUsd, spent.telemetry.costUsd),
      maxDurationSeconds: left(ceiling.maxDurationSeconds, spent.activeSeconds),
      maxRounds: ceiling.maxRounds,
    },
  };
}

/**
 * Has the run gone OVER its ceiling — for a session that is already running (RUN-133).
 *
 * Strictly `>`, where `reserveFromRun` is `>=`, and the difference is not pedantry: they answer
 * different questions. "May I start another session?" at exactly the ceiling is NO, because the
 * answer would be a zero budget. "Should I kill the session that is running?" at exactly the
 * ceiling is also no — it spent precisely what it was allowed, and stopping it would fail a run
 * that stayed inside its budget. Reusing the reservation's `>=` here killed a builder whose spend
 * landed exactly on the number.
 *
 * `>` also matches `superviseBudget`'s own per-session check, so the two layers agree on what a
 * breach is rather than differing by one token.
 */
export function exceedsRun(ceiling: RunBudget | null | undefined, spent: RunSpend): BudgetBreach | null {
  if (!ceiling) return null;
  if (ceiling.maxTokens != null && totalTokens(spent.telemetry) > ceiling.maxTokens) {
    return 'budget:tokens';
  }
  if (ceiling.maxUsd != null && spent.telemetry.costUsd > ceiling.maxUsd) return 'budget:usd';
  // Wall-clock is NOT checked here. A running session's seconds are not in the tally until it ends
  // (nothing samples them live), so a check would only ever read a stale number — and the honest
  // bound on a turn's duration is RUN-159's per-turn deadline, not this.
  return null;
}
