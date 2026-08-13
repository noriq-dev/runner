import type { RunBudget } from '@noriq-dev/shared';
import type { AgentDriver, DriverExit, DriverSession, DriverStartOptions, DriverTelemetry } from './types';
import { zeroTelemetry } from './types';

// Legacy Runs retain reactive token/USD supervision plus a wall-clock deadline: on an observed
// breach the wrapper stops the process and forces failed{reason:'budget:<dim>'}. Mission launches
// additionally require DriverStartOptions.tokenEnvelope at a commissioned provider boundary;
// telemetry cannot retroactively make already-consumed tokens a hard ceiling.

export type BudgetBreach = 'budget:tokens' | 'budget:usd' | 'budget:duration';

/**
 * The clock every duration in the budget layer is measured against (RUN-159).
 *
 * `performance.now()` and not `Date.now()`: these are DURATIONS, and a wall clock steps — an NTP
 * correction backwards mid-run credits a stretch negative time and hands the next turn more
 * allowance than the run has left; a forward step spends a ceiling nobody used. `setTimeout` is
 * already monotonic, so this is the accounting catching up with the enforcement. Exported because
 * the run's own active-seconds ledger (`RunTally.chargeTime`, whose callers time the stretch) has
 * to agree with this one — they are subtracted from the same ceiling.
 */
export const monotonicMs = (): number => performance.now();

/** A turn that was never handed to the agent. Zero telemetry is the literal truth — nothing ran —
 *  and no telemetry from it is ever folded into the run's tally, which only records what a session
 *  reported. (The caller still charges the microseconds it took to decline; that is not worth a
 *  branch, but it is why this says "no telemetry" rather than "nothing".) */
const declined = (reason: BudgetBreach): DriverExit => ({
  outcome: 'failed',
  isError: true,
  reason,
  telemetry: zeroTelemetry(),
});

/** All tokens processed this run (input + output + cache) — the conservative
 *  count for a hard ceiling. */
export const totalTokens = (t: DriverTelemetry): number =>
  t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreationTokens;

export interface BudgetRun {
  /**
   * The session — steer/interrupt through it as normal.
   *
   * A budget-aware WRAPPER of the driver's, when the session can be handed work back: a
   * `continueWith` turn is on the wall clock too, and the caller should not have to remember that
   * (RUN-159). Everything else delegates verbatim.
   */
  session: DriverSession;
  /** Resolves with the budget-aware terminal exit (breach → failed{budget}). */
  done: Promise<DriverExit>;
  /** Stop the run (also disarms the wall-clock deadline). */
  stop(): Promise<void>;
}

/**
 * Start a driver run under a hard budget. Token/USD limits are checked on every
 * telemetry tick; the wall-clock limit fires on a timer, re-armed against the remainder for each
 * hand-back turn (RUN-159). First breach wins and stops the process; the terminal exit's reason is
 * overridden to the breach.
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
  // The session's wall-clock ledger (RUN-159). `maxDurationSeconds` bounds the SESSION, and a
  // multiTurn session is several armed stretches — its first result plus every hand-back turn —
  // separated by idle time while the caller runs the verify floor or a reviewer. Only the armed
  // stretches are the agent's, so only they are charged. A turn is therefore armed for the
  // REMAINDER, never for a fresh copy of the ceiling: handing each turn the full allowance is the
  // per-session-copy bug RUN-133 removed one axis at a time, and time is the last axis.
  let spentMs = 0;

  /**
   * Arm the deadline for whatever is left, and return the disarm for THIS stretch.
   *
   * "Whatever is left" is the tighter of two remainders, for the same reason `spendGuard` exists:
   * this session's own allowance is a SNAPSHOT taken before it started, and a multiTurn session
   * outlives it — the reviewer spends run seconds between two hand-back turns, so by the time the
   * builder is handed work back its own arithmetic is stale and generous. `clockGuard` asks the
   * run's allocator, which knows what every session took. Neither alone is enough: the guard is
   * absent for a session with no run ledger, and it does not see this stretch in flight.
   *
   * Each stretch owns its own handle rather than a shared slot: the driver rejects an overlapping
   * `continueWith` (claude.ts), and a shared slot would let that rejected turn's cleanup disarm the
   * live one, leaving an orphan timer to stop the session mid-turn later. Returns null when the
   * clock is out, which is the caller's cue to decline rather than start a stretch it would
   * immediately have to kill.
   */
  const startClock = (): (() => void) | null => {
    const ownMs =
      budget.maxDurationSeconds == null
        ? Number.POSITIVE_INFINITY
        : budget.maxDurationSeconds * 1000 - spentMs;
    const runSeconds = startOpts.clockGuard?.();
    const remaining = Math.min(ownMs, runSeconds == null ? Number.POSITIVE_INFINITY : runSeconds * 1000);
    if (remaining === Number.POSITIVE_INFINITY) return () => {}; // no ceiling on either side — nothing to arm
    if (remaining <= 0) return null;
    const armedAt = monotonicMs();
    const timer = setTimeout(() => trip('budget:duration'), remaining);
    // A budget timer must never be the reason the daemon outlives its work. Every path in this
    // function disarms, but "every path" is exactly the claim a hung turn or a throwing `start()`
    // falsifies, and an armed 30-minute ceiling holding the event loop open is a worse failure than
    // the one it was watching for. Guarded because a fake clock need not implement it.
    if (typeof timer.unref === 'function') timer.unref();
    let disarmed = false;
    return () => {
      if (disarmed) return;
      disarmed = true;
      clearTimeout(timer);
      spentMs += monotonicMs() - armedAt;
    };
  };

  let disarmSession: () => void = () => {};
  const finalize = (exit: DriverExit) => {
    if (resolved) return;
    resolved = true;
    disarmSession();
    settle(breach ? { ...exit, outcome: 'failed', isError: true, reason: breach } : exit);
  };

  // Wrap the caller's handlers so we can observe telemetry + the exit without
  // stealing them. `held` breaks the mutual reference: the handlers reference the
  // session (to stop it) but the session is produced by driver.start(handlers).
  const userHandlers = startOpts.handlers;
  const held: { session?: DriverSession } = {};
  const requestStop = (session: DriverSession | undefined): void => {
    // A rejected stop means shutdown was not acknowledged. Swallow only the detached rejection;
    // the driver's done/registry boundary remains responsible for keeping the attempt unsettled.
    void session?.stop().catch(() => undefined);
  };
  const trip = (which: BudgetBreach) => {
    if (breach) return;
    breach = which;
    requestStop(held.session); // SIGTERM → driver finish → onExit → finalize overrides the reason
  };
  const checkSpend = (t: DriverTelemetry) => {
    if (breach) return;
    // The run-level guard first when there is one (RUN-133). It sees what EVERY session has spent,
    // not just this one's, which is the only way a session that outlives its own snapshot — a
    // multiTurn builder handed work back after the reviewer spent — can still be held to the run's
    // ceiling. `budget` remains the fallback and the wall-clock deadline's source either way.
    const guarded = startOpts.spendGuard?.(t);
    if (guarded) return trip(guarded as BudgetBreach);
    if (budget.maxTokens != null && totalTokens(t) > budget.maxTokens) trip('budget:tokens');
    else if (budget.maxUsd != null && t.costUsd > budget.maxUsd) trip('budget:usd');
  };

  // Arm the wall-clock deadline BEFORE start(). A driver that fails fast — a rejected
  // model, a transport that errors on spawn — can call onExit synchronously from inside
  // start(), so finalize()'s disarm would run against a timer that doesn't exist
  // yet. Arming afterwards would then leave a timer nothing can clear (finalize is guarded
  // by `resolved`), holding the event loop open for the whole budget and eventually firing
  // against a session that died long ago. Timers are async and the schema requires
  // maxDurationSeconds >= 1, so this cannot fire before held.session is set.
  disarmSession = startClock() ?? (() => {});

  let session: DriverSession;
  try {
    session = driver.start({
      ...startOpts,
      handlers: {
        ...userHandlers,
        onTelemetry: (t) => {
          userHandlers?.onTelemetry?.(t);
          checkSpend(t);
        },
        onExit: (exit) => {
          userHandlers?.onExit?.(exit);
          // The exit's own telemetry counts too. `onTelemetry` is OPTIONAL in the driver contract
          // while every exit carries a figure, so a driver that reports its spend only at the end
          // (or a fake that emits no ticks) slipped past both this ceiling and the run's guard, and
          // the run reported `done` on a breach. Checking here cannot stop anything — the session is
          // already over — but it names the reason, and it lets `finalize` override the outcome
          // rather than blessing an overrun as success.
          checkSpend(exit.telemetry);
          finalize(exit);
        },
      },
    });
  } catch (err) {
    // A `start()` that throws never reaches the disarm below and never produces a session to stop,
    // so the deadline armed a moment ago would sit until it fired. `unref` keeps it from holding
    // the daemon open; this keeps a retry loop from accumulating one per attempt.
    disarmSession();
    throw err;
  }
  held.session = session;
  // A telemetry/exit callback delivered SYNCHRONOUSLY from inside start() sets `breach` before
  // there is a session to stop — `trip` runs against an empty `held`. The driver contract permits
  // that (claude's consumer is async, but nothing requires it), so settle the debt here.
  if (breach) requestStop(session);

  // A hand-back turn is on the clock too (RUN-159).
  //
  // `finalize` disarms on the driver's first result — which is where a multiTurn session's life
  // BEGINS rather than ends (RUN-29/30). Every hand-back turn after it (the verify-fix loop, the
  // reviewer-fix loop, landing's re-verify) therefore ran with no wall-clock bound at all: a fix
  // turn that simply hung was unbounded no matter what `maxDurationSeconds` said. RUN-133 closed
  // the tokens/USD half of the same hole with `spendGuard` and charged the turn's seconds to the
  // run's tally, but nothing INTERRUPTED a turn that was spending only time.
  //
  // The tempting fix — stop disarming at the first result — is the wrong one: a single-turn run
  // would then hold an armed timer until stop(), and `parkIfBlocked` returns before `settle` ever
  // calls one. Re-arming per stretch, against the remainder, bounds the session as a whole.
  //
  // Wrapping the session rather than exposing an arm/disarm pair on `BudgetRun` is deliberate: a
  // caller that has to REMEMBER to bound its turn is a caller that eventually does not (RUN-158).
  const rawContinue = session.continueWith;
  const guarded: DriverSession = !rawContinue
    ? session
    : {
        // An explicit delegate, not `Object.create(session)`: a prototype wrapper passes the
        // methods through but calls them with the WRAPPER as `this`, so a driver whose session is
        // a class instance (private fields, `this.closed = true`) breaks or silently writes its
        // state onto the wrapper. Every driver today returns closures, which is exactly why such a
        // bug would ship unnoticed — the same receiver mistake a review caught in RUN-131.
        // Delegating by hand costs a new OPTIONAL member of `DriverSession` being dropped here
        // (a required one is a type error, which is the failure mode we want).
        get runId() {
          return session.runId;
        },
        // Live, in both directions: the driver assigns `sessionId` to the real session after
        // start(), and parking a run reads it (RUN-30). A snapshot would park with a stale id.
        get sessionId() {
          return session.sessionId;
        },
        set sessionId(v: string | null | undefined) {
          session.sessionId = v;
        },
        pushInput: (text) => session.pushInput(text),
        interrupt: () => session.interrupt(),
        stop: () => session.stop(),
        done: () => session.done(),
        continueWith: async (text: string): Promise<DriverExit> => {
          // A session that has ALREADY breached takes no more work. Without this the run's
          // `breach` — a session-scoped fact — would relabel a later turn that returned perfectly
          // normally, which is a worse lie than the one the rewrite below fixes.
          if (breach) return declined(breach);
          const disarm = startClock();
          // Out of clock before the turn even starts. Decline it rather than spawn a stretch to
          // kill (RUN-133's rule for a stage with nothing left), and close the session — no further
          // turn can be afforded, so keeping the process alive only holds a worktree.
          if (!disarm) {
            trip('budget:duration');
            return declined('budget:duration');
          }
          try {
            const exit = await rawContinue.call(session, text);
            // A turn's own result may be the only report of its spend: `onTelemetry` is optional in
            // the driver contract while every exit carries a figure (the same hole the session's
            // `onExit` closes above). Checking here cannot stop a turn that is already over, but it
            // names the reason rather than blessing an overrun as `done`.
            //
            // ENFORCEMENT only — the figure is not recorded. A tally slot is last-writer-wins, and
            // a stopped or declined turn's exit can carry a partial or zero figure, which would
            // then ERASE the session's real spend from the run's total (the RUN-133 bug that broke
            // five park tests). Every driver that can be handed work back ticks as it goes, so the
            // tally is fed by `onTelemetry`; a hypothetical tickless one would be enforced here and
            // under-reported there, which is the safe direction to be wrong in.
            checkSpend(exit.telemetry);
            // Name the breach on the turn, the way `finalize` names it on the run. The driver
            // settles a stopped turn as `reason:'stopped'`, which is true but says nothing about
            // WHY — and `done` already resolved on the first result, so this exit is the only
            // place the turn's caller can learn the session ran out of budget.
            return breach ? { ...exit, outcome: 'failed', isError: true, reason: breach } : exit;
          } finally {
            disarm();
          }
        },
      };

  return {
    session: guarded,
    done,
    stop: async () => {
      disarmSession();
      await session.stop();
    },
  };
}
