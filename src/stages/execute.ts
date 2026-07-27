/**
 * The `execute` stage (RUN-131): run the agent under its budget, steerable, until it stops talking
 * — or parks on a human.
 *
 * The one stage BOTH entry points share. `supervise` reaches it with a freshly prepared run;
 * `resume` reaches it with a parked one carrying a restored session id, the human's answer as its
 * prompt, and only the REMAINDER of the budget. Everything that differs between those two is
 * resolved by the caller and arrives as `plan.start`; what is left — accumulating the output,
 * registering steering, folding the terminal result into the run's tally, and asking the server
 * whether the session ended because it finished or because it asked a question — is identical, and
 * used to be written twice.
 *
 * It owns the driver's `handlers` for a reason: the accumulated text IS the verify actor's verdict
 * and the tail IS the dashboard's live log, so a caller that supplied its own would silently
 * disconnect both. `env` is the mirror case and belongs to the supervisor's `startAgent`, which is
 * the single point where the sanitized child environment is applied (RUN-109).
 */

import type { Run } from '@noriq-dev/shared';
import type { RunAgent } from '../client';
import { type BudgetRun, monotonicMs } from '../drivers/budget';
import type { AgentDriver, DriverExit, DriverSession, DriverStartOptions } from '../drivers/types';
import type { logger as defaultLogger } from '../logger';
import type { ResolvedRepo, RunReport, RunTally } from '../supervisor';
import type { RunTranscript } from '../transcript';
import type { Workspace } from '../vcs/types';
import type { StepSummary } from './chain';

/** How much of the agent's trailing output to stream as the live log tail (RUN-22). */
export const LOG_TAIL_CAP = 4000;

/** What running an agent may reach. Narrow, because execution is the one stage that only needs a
 *  driver, a place to report, and the park probe. */
export interface ExecuteHost {
  readonly log: typeof defaultLogger;
  report(runId: string, frame: RunReport): void;
  transcript(runId: string): RunTranscript;
  /** The supervisor's single spawn point — it is what applies the sanitized env (RUN-109). */
  startAgent(driver: AgentDriver, opts: DriverStartOptions): BudgetRun;
  /** Makes the live session steerable + cancellable while it runs (RUN-16/18). */
  steering?: {
    register: (runId: string, session: DriverSession, stop: () => Promise<void>) => void;
    unregister: (runId: string) => void;
  };
  /** Did this run stop to ask a human (RUN-30)? Returns the exit to report iff it parked. */
  parkIfBlocked(ctx: {
    run: Run;
    repo: ResolvedRepo;
    worktree: Workspace;
    exit: DriverExit;
    session: DriverSession;
    runAgent: RunAgent;
    activeSeconds: number;
    tally: RunTally;
    tail: string;
    /** Which step was speaking, on a decomposed run (RUN-168) — persisted so a resume knows where
     *  the chain stopped rather than finishing one session and calling the run done. */
    stepId?: string;
    /** What the steps BEFORE it concluded (RUN-171) — persisted so a resumed chain briefs its
     *  later steps with the hand-off rather than starting them ignorant. */
    priorSteps?: StepSummary[];
  }): Promise<DriverExit | null>;
}

export interface ExecutePlan {
  run: Run;
  repo: ResolvedRepo;
  worktree: Workspace;
  driver: AgentDriver;
  runAgent: RunAgent;
  /** The run's cross-session tally (RUN-59), already seeded with any prior spend. */
  tally: RunTally;
  /** The driver options, fully resolved by the caller — minus `handlers` and `env`. */
  start: Omit<DriverStartOptions, 'handlers' | 'env'>;
  /**
   * Seconds this run has already spent ACTIVE, before this sitting. Zero for a first sitting; a
   * resume carries the park's, so the wall-clock ceiling measures work rather than the wait for a
   * human (RUN-30).
   */
  priorActiveSeconds: number;
  /** Which step this session IS, on a decomposed run (RUN-168). Absent for an undecomposed run. */
  stepId?: string;
  /** What earlier steps concluded, carried so a park can persist it (RUN-171). */
  priorSteps?: StepSummary[];
  /**
   * Which tally slot this session's spend records into. Defaults to `primary`, which is every
   * undecomposed run.
   *
   * A chain must pass a slot PER STEP, and the two halves have to agree: the tally is
   * last-writer-wins per slot (a session reports its own cumulative), so N steps sharing `primary`
   * would leave the run's total showing only the last one — and the live guard, which reads the
   * slot it was named with, would be probing a different figure from the one being written.
   */
  slot?: string;
}

/** Either the run parked on a human — terminal for this sitting — or it finished talking. */
export type ExecuteOutcome =
  | { parked: DriverExit }
  | {
      parked?: undefined;
      exit: DriverExit;
      session: DriverSession;
      stopSession: () => Promise<void>;
      /** The agent's accumulated output — the verify actor's verdict is parsed from it. */
      sessionText: string;
      /** Live accessor for the same output, which keeps growing through fix turns (RUN-79). */
      getSessionText: () => string;
      tail: string;
    };

export const executeRun = async (host: ExecuteHost, plan: ExecutePlan): Promise<ExecuteOutcome> => {
  const { run, tally } = plan;
  let sessionText = ''; // accumulated agent output — the verify verdict is parsed from it
  let tail = ''; // rolling tail of the same output, capped, for the live dashboard (RUN-22)

  // Active time, for a park's wall-clock accounting (RUN-30): the wait for a human is not the
  // run's, so only the stretch from here to the session's end counts against maxDurationSeconds.
  const startedAt = monotonicMs();
  const budgetRun = host.startAgent(plan.driver, {
    ...plan.start,
    handlers: {
      // Each telemetry tick carries the current spend AND the latest log tail, so the dashboard
      // sees burn + output without a status transition per tick. The primary session — including
      // its fix turns, which stream through these same handlers — records into the tally, and the
      // reported figure is the RUN total (RUN-59). A live tick carries no mix (only a result
      // knows the split), so the mix appears when the result lands, not before.
      onTelemetry: (t) => {
        tally.record(plan.slot ?? 'primary', t);
        host.report(run.id, { status: 'running', telemetry: tally.total(), logTail: tail });
      },
      onText: (t) => {
        sessionText += t;
        tail = (tail + t).slice(-LOG_TAIL_CAP);
        // Labelled by THIS session's own step (RUN-150), not by a "current step" the transcript
        // holds: the moment two steps overlap, a shared label relabels whichever one did not move
        // it last, and the result is a transcript that reads plausibly and attributes the wrong
        // work to the wrong step.
        host.transcript(run.id).text('agent', t, null, plan.stepId ?? null);
      },
    },
  });
  // Steerable + cancellable while it runs (RUN-16/18).
  host.steering?.register(run.id, budgetRun.session, budgetRun.stop);

  let exit: DriverExit;
  try {
    exit = await budgetRun.done;
  } finally {
    host.steering?.unregister(run.id);
  }
  // The terminal result, recorded authoritatively (RUN-59): a driver whose result carries a mix
  // but emits no separate onTelemetry tick (or a fake in tests) is captured here. Fix turns that
  // run later stream through the handler above and overwrite this with their fuller cumulative.
  tally.record(plan.slot ?? 'primary', exit.telemetry);
  // This sitting's active stretch joins the run's wall-clock spend (RUN-133), so what the reviewer
  // and the conflict turn may spend is short by what the agent already took. The tally was seeded
  // with any PRIOR sitting's seconds at construction, which is why only this sitting is added here.
  tally.chargeTime((monotonicMs() - startedAt) / 1000);
  // Carry the RUN's spend rather than this sitting's first-result snapshot. `settle` recomputes the
  // same total before reporting, and `parkIfBlocked` reads the tally directly, so this changes no
  // outcome — it just stops the exit in flight from disagreeing with everything that reads it.
  exit = { ...exit, telemetry: tally.total() };

  // The session ending is ambiguous (RUN-30): an agent that asked a human a question ends its
  // turn exactly like one that finished. Only the server knows which, so ask it before treating
  // this as terminal — everything downstream destroys context that a parked run still needs.
  const parked = await host.parkIfBlocked({
    run,
    repo: plan.repo,
    worktree: plan.worktree,
    exit,
    session: budgetRun.session,
    runAgent: plan.runAgent,
    activeSeconds: plan.priorActiveSeconds + (monotonicMs() - startedAt) / 1000,
    tally,
    tail,
    ...(plan.stepId ? { stepId: plan.stepId } : {}),
    ...(plan.priorSteps?.length ? { priorSteps: plan.priorSteps } : {}),
  });
  if (parked) return { parked };

  return {
    exit,
    session: budgetRun.session,
    stopSession: budgetRun.stop,
    sessionText,
    getSessionText: () => sessionText,
    tail,
  };
};
