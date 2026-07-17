import type { RunBudget } from '@noriq-dev/shared';
import type { AgentDriver, DriverExit, DriverSession, DriverStartOptions, DriverTelemetry } from './types';

// The daemon polices spend — never the agent. superviseBudget wraps a driver run,
// watches token/USD telemetry from the stream + a wall-clock deadline against the
// Run budget, and on breach SIGTERMs the process (session.stop()) and forces the
// terminal exit to failed{reason:'budget:<dim>'}. A hard ceiling, never unbounded.

export type BudgetBreach = 'budget:tokens' | 'budget:usd' | 'budget:duration';

/** All tokens processed this run (input + output + cache) — the conservative
 *  count for a hard ceiling. */
export const totalTokens = (t: DriverTelemetry): number =>
  t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreationTokens;

export interface BudgetRun {
  /** The underlying session — steer/interrupt through it as normal. */
  session: DriverSession;
  /** Resolves with the budget-aware terminal exit (breach → failed{budget}). */
  done: Promise<DriverExit>;
  /** Stop the run (also clears the deadline timer). */
  stop(): Promise<void>;
}

/**
 * Start a driver run under a hard budget. Token/USD limits are checked on every
 * telemetry tick; the wall-clock limit fires on a timer. First breach wins and
 * stops the process; the terminal exit's reason is overridden to the breach.
 */
export function superviseBudget(driver: AgentDriver, startOpts: DriverStartOptions): BudgetRun {
  // maxRounds is irrelevant to SIGTERM enforcement here (it caps reviewer rounds, not spend) —
  // null completes the RunBudget shape without changing any ceiling this function checks.
  const budget: RunBudget = {
    maxTokens: null,
    maxUsd: null,
    maxDurationSeconds: null,
    maxRounds: null,
    ...startOpts.budget,
  };
  let breach: BudgetBreach | null = null;
  let resolved = false;
  let settle!: (exit: DriverExit) => void;
  const done = new Promise<DriverExit>((resolve) => {
    settle = resolve;
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;

  const clearDeadline = () => {
    if (deadline) clearTimeout(deadline);
    deadline = undefined;
  };
  const finalize = (exit: DriverExit) => {
    if (resolved) return;
    resolved = true;
    clearDeadline();
    settle(breach ? { ...exit, outcome: 'failed', isError: true, reason: breach } : exit);
  };

  // Wrap the caller's handlers so we can observe telemetry + the exit without
  // stealing them. `held` breaks the mutual reference: the handlers reference the
  // session (to stop it) but the session is produced by driver.start(handlers).
  const userHandlers = startOpts.handlers;
  const held: { session?: DriverSession } = {};
  const trip = (which: BudgetBreach) => {
    if (breach) return;
    breach = which;
    void held.session?.stop(); // SIGTERM → driver finish → onExit → finalize overrides the reason
  };
  const checkSpend = (t: DriverTelemetry) => {
    if (breach) return;
    if (budget.maxTokens != null && totalTokens(t) > budget.maxTokens) trip('budget:tokens');
    else if (budget.maxUsd != null && t.costUsd > budget.maxUsd) trip('budget:usd');
  };

  // Arm the wall-clock deadline BEFORE start(). A driver that fails fast — a rejected
  // model, a transport that errors on spawn — can call onExit synchronously from inside
  // start(), so finalize()'s clearDeadline() would run against a timer that doesn't exist
  // yet. Arming afterwards would then leave a timer nothing can clear (finalize is guarded
  // by `resolved`), holding the event loop open for the whole budget and eventually firing
  // against a session that died long ago. Timers are async and the schema requires
  // maxDurationSeconds >= 1, so this cannot fire before held.session is set.
  if (budget.maxDurationSeconds != null) {
    deadline = setTimeout(() => trip('budget:duration'), budget.maxDurationSeconds * 1000);
  }

  const session = driver.start({
    ...startOpts,
    handlers: {
      ...userHandlers,
      onTelemetry: (t) => {
        userHandlers?.onTelemetry?.(t);
        checkSpend(t);
      },
      onExit: (exit) => {
        userHandlers?.onExit?.(exit);
        finalize(exit);
      },
    },
  });
  held.session = session;

  return {
    session,
    done,
    stop: async () => {
      clearDeadline();
      await session.stop();
    },
  };
}
