/**
 * A decomposed run, executed as a chain of sessions (RUN-168) — and, where the schedule and the
 * backend both allow it, a WAVE of them at once (RUN-170).
 *
 * RUN-148 taught the planner to declare steps and told ONE agent to work them in order. This runs
 * each step in its own session, which is the point of decomposing at all: a step that starts fresh
 * is not carrying the previous step's exploration, its false starts, or the file it read and did
 * not need. What it carries instead is a summary, and that hand-off is the whole trade — a chain of
 * fresh contexts beats one long context only if each link inherits the conclusions.
 *
 * Built on `executeRun` rather than beside it. Every property a session needs — the budget
 * reservation, steering registration, the wall-clock charge, the park probe — is already correct
 * there and is correct per session; a second spawn loop would be a second place for those to drift.
 *
 * A wave (RUN-149's `planWaves`) runs concurrently only when THREE things hold, each a different
 * authority: the schedule put more than one step in it (the plan's order + the daemon's overlap
 * arithmetic), the backend isolates in SPACE (`leasesOverlap` — on a pool-of-1 backend a child
 * lease taken while the parent holds the pool deadlocks, in-process, with nothing to time out),
 * and the daemon's concurrency has room (`ChainWave.limit`). Anything short of all three runs the
 * same wave sequentially, which is always a correct way to do the work. Each overlapping step gets
 * its own workspace, forked from the parent run's line by run id on the VCS seam — never by a ref
 * this file carries (RUN-50's rule, kept) — and lands back on it serially: publish is
 * compare-and-swap, so a loser re-integrates and retries rather than minting a merge commit.
 *
 * What this does NOT do, deliberately:
 *
 * - **No per-step lock scope.** Sequential OR concurrent, the chain holds the parent's union.
 *   Every step session runs under the run's ONE lock holder (RUN-43's bound agent token), so locks
 *   cannot arbitrate between siblings — separate workspaces are what make overlap safe, and
 *   narrowing the hold would be a courtesy to OTHER runs, not correctness (RUN-170's settled
 *   decision).
 * - **No per-step gate.** The deterministic floor and the reviewer judge the accumulated diff once,
 *   at the parent. A criterion is a statement about the finished work, and a step that satisfies
 *   its own slice can leave the whole unmet; running the most expensive stage per step would also
 *   multiply it by the decomposition.
 * - **No workspace for a SEQUENTIAL step.** Steps that cannot race need no isolating (the RUN-149
 *   amendment: the invariant that carries the isolation is *never two runs in one checkout*, and a
 *   run's own sequential steps share its one workspace, checkpointing between them). Only steps a
 *   wave actually overlaps take one each — `anticipatedFiles` is briefed as "a starting point, not
 *   a fence", so the declaration cannot substitute for isolation.
 * - **No park for a wave child.** A park persists ONE workspace and one session position, and a
 *   resume restores into the run's own worktree — a child-workspace park has no representation and
 *   would resume into the wrong tree. A child that stops to ask a human ends its step unfinished
 *   instead, handled by the failed-step policy, and the chain says so out loud.
 */

import type { ExecutionStep, RunBudget } from '@noriq-dev/shared';
import { planWaves, stepWorkspaceId } from '../steps';
import type { IntegrateResult, PublishResult, Workspace } from '../vcs/types';
import type { ExecuteHost, ExecuteOutcome, ExecutePlan } from './execute';
import { executeRun } from './execute';

/** What one finished step hands the next. */
export interface StepSummary {
  id: string;
  title: string;
  /** The step's own closing output, capped — what it changed and what it learned. */
  text: string;
}

/** How much of a step's output rides forward. Enough for conclusions, not enough to reconstruct the
 *  context the fresh session exists to avoid inheriting. */
const SUMMARY_CAP = 1200;

/** How many times a child re-integrates after losing the publish CAS before its step fails. Serial
 *  integration means a race is rare here (the same shape `landRun` retries against `[land].branch`);
 *  a bound keeps a backend that ALWAYS answers 'race' from looping the run. */
const WAVE_PUBLISH_ATTEMPTS = 3;

/**
 * The seam a wave reaches source control through (RUN-170): closures over the parent run's
 * backend, injected exactly the way `checkpoint` already is — the supervisor binds `vcsFor(repo)`
 * and the parent RUN ID, so the child→parent return trip is run-addressed on the `VcsBackend`
 * seam and no branch or ref string ever originates here (RUN-50's rule, kept under concurrency).
 */
export interface ChainWave {
  /**
   * Whether this backend can hold MANY leases at once (`VcsBackend.leasesOverlap`). False is the
   * conservative reading and forces every wave sequential — on a pool-of-1 backend a child lease
   * taken while the parent holds the pool blocks forever, in-process, with nothing to time out.
   */
  leasesOverlap: boolean;
  /**
   * How many of a wave's steps may actually overlap — the daemon's own concurrency minus what
   * the REST of the machine is running, asked again before EACH wave rather than sampled once: a
   * chain runs for a long time, and a limit frozen at its start would keep claiming capacity that
   * another run's wave has since taken (or ignore capacity that freed up). A run that saturates
   * the machine with its own steps starves every other run, which is worse than a slow run.
   * Floor 1 upstream; `planWaves` treats anything ≤1 as one-per-wave.
   */
  limit: () => number;
  /** Lease a child workspace forked from the PARENT RUN's work (`lease(root, childId,
   *  {fromRunId})` — the closure carries root and parent id). */
  lease: (childWorkspaceId: string) => Promise<Workspace>;
  /** Checkpoint a CHILD workspace — the parent-bound `ChainPlan.checkpoint` cannot, and publish
   *  is a CAS over committed state, so an uncommitted child diff would land as nothing. */
  checkpoint: (ws: Workspace, label: string) => Promise<boolean>;
  /** `integrateFromRun(ws, parentRunId)`: make the child contain the parent's current line plus
   *  its own work — how a later-finishing sibling picks up what an earlier one landed. */
  integrateBack: (ws: Workspace) => Promise<IntegrateResult>;
  /** Clean up a conflicted integration. A child's conflict FAILS the step (kept workspace, a
   *  human decides) rather than spending a resolution turn — wiring the conflict machinery
   *  per-child is real work RUN-170 defers. */
  abandonIntegrate: (ws: Workspace) => Promise<void>;
  /** `publishToRun(ws, parentRunId)`: land the child on the parent's line IFF it hasn't moved —
   *  compare-and-swap, never a merge commit. The loser re-integrates and retries. */
  publishBack: (ws: Workspace) => Promise<PublishResult>;
  /** Did the child produce anything nothing else has? Decides keep-vs-dispose for a FAILED child;
   *  a rejection errs toward keep (RUN-152's contract — both callers of `false` destroy). */
  hasWork: (ws: Workspace) => Promise<boolean>;
  /** Give a landed (or empty) child workspace back. Never called on one holding unlanded work. */
  dispose: (ws: Workspace) => Promise<void>;
  /**
   * Is the RUN blocked on a human right now (the server's park state)? A wave child cannot park —
   * see the header — but its `request_input` still marks the RUN blocked server-side, and without
   * this probe the next SEQUENTIAL step's park check would adopt that stale question and park the
   * wrong session against it. Absent = parking is off, exactly the pre-RUN-30 posture.
   */
  probeBlocked?: () => Promise<boolean>;
}

export interface ChainPlan extends Omit<ExecutePlan, 'stepId'> {
  /** The validated, ordered decomposition. Two or more by construction (`checkSteps`). */
  steps: ExecutionStep[];
  /** This step's brief, built from the run's own facts plus what earlier steps concluded. */
  stepPrompt: (step: ExecutionStep, index: number, prior: StepSummary[]) => string;
  /** Capture the accumulated work between steps, so the next session reads it from the tree.
   *  Returns false when there was nothing to capture, which is not an error. */
  checkpoint: (label: string) => Promise<boolean>;
  /** The wave seam (RUN-170). Absent → every wave runs sequentially in the parent's workspace,
   *  which is exactly the pre-RUN-170 chain. */
  wave?: ChainWave;
  /** What the steps before the resumed one concluded, restored from the park (RUN-171). */
  priorSteps?: StepSummary[];
  /** Resume a chain from this step, skipping the ones already finished (RUN-168). The FIRST step
   *  run is then the parked one, resumed rather than started — `plan.start` carries its session id.
   *  Absent on a fresh run. */
  resumeFromStepId?: string;
  /**
   * Stop once the resumed step finishes, even with steps left, and report the run incomplete.
   *
   * Set on the resume path, and it is a limitation stated rather than a policy chosen. A fresh
   * step needs the RUN's brief — identity, task, repo context, the sequence — and a resume does not
   * have one: its prompt is deliberately just the question and the human's answer, because the
   * session it restores already holds everything else. Briefing a NEW session with that would give
   * it an answer to a question it never asked and nothing else, which is worse than not running it.
   *
   * So the resumed step finishes and the run says what is left. That is not the silent truncation
   * this ticket exists to stop — that was a run reporting DONE having skipped its plan; this
   * reports incomplete and names the steps, which is a fact a human can act on.
   */
  stopAfterResumedStep?: boolean;
}

/** A chain that could not run at all — no session was started, so there is no outcome to carry.
 *  The caller reports it the way it reports any run it could not start. */
export type ChainOutcome = ExecuteOutcome | { chainFailed: string };

/** A finished (non-parked) session outcome — what the chain accumulates and returns. */
type SessionOutcome = ExecuteOutcome & { parked?: undefined };

/**
 * Each wave member's share of ONE reservation (RUN-170). `RunTally.reserve()` hands out the
 * remainder, which is correct for sequential sessions and wrong when N run at once — each would be
 * told it may spend everything, the RUN-133 per-session-copy bug reborn. Splitting one reservation
 * keeps the invariant by construction: the sum of the shares never exceeds the remainder at wave
 * start. `maxRounds` passes through verbatim — it caps reviewer looks, nothing a step spends.
 */
function splitBudget(budget: RunBudget | undefined, n: number): RunBudget | undefined {
  if (!budget || n <= 1) return budget;
  const share = (v: number | null) => (v == null ? null : Math.floor(v / n));
  return {
    maxTokens: share(budget.maxTokens),
    maxUsd: budget.maxUsd == null ? null : budget.maxUsd / n,
    maxDurationSeconds: share(budget.maxDurationSeconds),
    maxRounds: budget.maxRounds,
  };
}

/**
 * Run the chain, and stop at the first step that does not finish.
 *
 * Stopping is not pessimism. A step that failed, parked, or ran out of budget leaves the tree in a
 * state the next step was not planned against, so continuing would build step three on a foundation
 * the run already knows is broken — and would report a run that did most of its plan as one that
 * did all of it. The outcome returned is that step's, so the run's fate and its reason are the
 * failing step's, not a summary invented here. Under a wave the same rule holds at wave grain:
 * already-running siblings FINISH and their work lands (cancelling them throws away work that was
 * going to succeed, and the budget shares bound the waste), then no later wave starts.
 *
 * The LAST step's session is the one returned on success, and that is what the gate's fix turns
 * hand back to (RUN-146's repair spec tells it what is outstanding, with file pointers, so it can
 * fix work an earlier step did).
 */
export async function executeChain(host: ExecuteHost, plan: ChainPlan): Promise<ChainOutcome> {
  const { run, steps } = plan;
  // A resumed chain re-enters at the step that parked; everything before it is already done.
  // An UNKNOWN id is the interesting case: the spec may have been corrected during a park of up to
  // 72 hours (RUN-164), so the step that parked can be gone from the recomputed chain. Restarting
  // from the top would redo landed work, and skipping to the end would abandon it — so the run
  // fails and says so, because which of those a human wants is not something to guess.
  const from = plan.resumeFromStepId ? steps.findIndex((s) => s.id === plan.resumeFromStepId) : 0;
  if (from < 0) {
    host.log.warn('the step this run parked on is gone from its plan — stopping rather than guessing', {
      runId: run.id,
      stepId: plan.resumeFromStepId,
    });
    host
      .transcript(run.id)
      .milestone(
        `this run parked on step \`${plan.resumeFromStepId}\`, which its plan no longer declares — the spec changed while it waited. Its work is kept; re-dispatch to continue against the new plan.`,
      );
    return { chainFailed: 'steps:parked-step-gone' };
  }

  // Seeded from the park on a resume (RUN-171): the steps before this one already concluded
  // something, and starting empty makes the next step rediscover it.
  const prior: StepSummary[] = [...(plan.priorSteps ?? [])];
  // The whole run's output, not the last step's. The verify actor's verdict and RUN-145's
  // acceptance evidence are parsed from this, and a decomposed verify run whose FIRST step found
  // the fault would otherwise be cleared by a later step's PASS — the gate reading only the last
  // voice is exactly the fail-open this codebase keeps closing.
  let allText = '';
  let last: SessionOutcome | null = null;
  const indexOf = new Map(steps.map((s, i) => [s.id, i]));

  /** Fold a raw session outcome into the run's accumulated view — the shape `last` holds. */
  const withAllText = (outcome: SessionOutcome): SessionOutcome => ({
    ...outcome,
    sessionText: allText,
    getSessionText: () => allText + outcome.getSessionText().slice(outcome.sessionText.length),
  });

  /** The persisted cancellation fact (RUN-165), asked before EVERY chain spawn — the one helper
   *  all three spawn entries share (the wave loop, each sequential step, each wave member after
   *  its lease). The stage machine's `stopBefore` only sees the pipeline's boundaries, and a
   *  chain is many sessions with gaps between them inside ONE stage: a cancel landing in a gap —
   *  or while a child's lease is still resolving, past `cancelRun`'s snapshot of live sessions —
   *  must not be answered by spawning the next session. */
  const cancelled = () => host.steering?.isCancelled?.(run.id) ?? false;
  /** The chain's stop for a cancelled run: the work so far rides out (settle still runs on the
   *  returned session), and nothing after it spawns. */
  const cancelStop = (): ChainOutcome => {
    host.log.info('the run was cancelled — the chain stops before its next session', { runId: run.id });
    host.transcript(run.id).milestone('the run was cancelled — the remaining steps did not run');
    return last
      ? { ...last, exit: { ...last.exit, outcome: 'failed', isError: true, reason: 'cancelled' } }
      : { chainFailed: 'cancelled' };
  };

  /** The budget-exhausted stop, shared by both paths: FAILED, not the previous step's success.
   *  Returning that outcome unchanged would send a run that did half its plan through verify and
   *  landing and report it done — the silently-truncated-plan shape, arriving by the budget. */
  const budgetStop = (i: number, breach: string): ChainOutcome => {
    host
      .transcript(run.id)
      .milestone(
        `the run's ceiling was reached before step ${i + 1}/${steps.length} (${breach}) — that step and everything after it did not run`,
      );
    return {
      ...(last as SessionOutcome),
      exit: {
        ...(last as SessionOutcome).exit,
        outcome: 'failed',
        isError: true,
        reason: `steps:${breach}`,
      },
    };
  };

  /** One step in the parent's workspace — the pre-RUN-170 chain body. Returns the outcome to STOP
   *  the chain with, or null to continue. `isFinal` marks the last SCHEDULED step — the one whose
   *  session the chain hands onward — which under a wave schedule is not always the last-indexed
   *  one; keying the close/keep decision on the index left the handed-on session already closed. */
  const runStep = async (step: ExecutionStep, i: number, isFinal: boolean): Promise<ChainOutcome | null> => {
    // A cancel that landed since the last session ended (RUN-165) — the gap between two steps is
    // inside the execute stage, where no stage boundary asks.
    if (cancelled()) return cancelStop();
    // The line announcing a step belongs to it (RUN-150). Every other segment is labelled by the
    // SESSION that emits it, which is what keeps attribution right once steps can overlap.
    host.transcript(run.id).milestone(`step ${i + 1}/${steps.length} — ${step.title} [${step.id}]`, step.id);

    // Every step reserves from the RUN's remaining ceiling (RUN-133). The FIRST step is not gated
    // on it: a run with nothing left is handled the way every other exhausted run is — the budget
    // layer declines the turn — and refusing here instead would give a decomposed run a different
    // failure shape from an undecomposed one for the same condition.
    const reservation = plan.tally.reserve();
    if (!reservation.ok && last) {
      host.log.warn('no budget left for the next step — stopping the chain', {
        runId: run.id,
        stepId: step.id,
        breach: reservation.breach,
      });
      return budgetStop(i, reservation.breach);
    }

    // The FIRST step of a resumed chain is the parked session coming back, so it keeps the caller's
    // `start` verbatim — its resume session id and the human's answer as its prompt. Every other
    // step is a fresh session with its own brief.
    const resumingThisOne = i === from && Boolean(plan.resumeFromStepId);
    const outcome = await executeRun(host, {
      ...plan,
      stepId: step.id,
      // What a park would need to persist if this step asks a question (RUN-171) — the steps
      // BEFORE it, since its own conclusions do not exist yet.
      priorSteps: prior,
      // Its own tally slot, or N steps would overwrite one another's spend and the run would report
      // only the last (RUN-133's accounting is last-writer-wins PER SLOT).
      slot: `step:${step.id}`,
      start: resumingThisOne
        ? plan.start
        : {
            ...plan.start,
            prompt: plan.stepPrompt(step, i, prior),
            // A fresh session, never the previous step's: inheriting it would make this one long
            // context wearing a decomposition, which is the thing being avoided.
            resumeSessionId: undefined,
            ...(reservation.ok && reservation.budget ? { budget: reservation.budget } : {}),
            spendGuard: plan.tally.guard(`step:${step.id}`),
            clockGuard: plan.tally.clockGuard(),
          },
      // The run's active seconds SO FAR, read from the tally rather than threaded — which is what
      // makes a park on step three record the whole run's active time rather than that step's.
      priorActiveSeconds: plan.tally.activeSeconds(),
    });

    if (outcome.parked) return outcome;
    allText += outcome.sessionText;
    const merged = withAllText(outcome);
    last = merged;
    if (outcome.exit.outcome !== 'done') {
      host.log.warn('a step did not finish — the chain stops here', {
        runId: run.id,
        stepId: step.id,
        reason: outcome.exit.reason,
      });
      host
        .transcript(run.id)
        .milestone(
          `step ${i + 1}/${steps.length} did not finish (${outcome.exit.reason ?? 'no reason given'}) — the remaining steps did not run`,
        );
      return merged;
    }

    prior.push({ id: step.id, title: step.title, text: outcome.sessionText.slice(-SUMMARY_CAP) });

    // A resume finishes the step that parked and stops there — see `stopAfterResumedStep` for why
    // a fresh step cannot be briefed from a resume. Reported as incomplete, naming what is left,
    // rather than as a run that did its plan.
    if (plan.stopAfterResumedStep && !isFinal) {
      const remaining = steps.slice(i + 1).map((r) => r.id);
      host.log.warn('a resumed chain finished its parked step; the rest need a fresh dispatch', {
        runId: run.id,
        remaining,
      });
      host
        .transcript(run.id)
        .milestone(
          `step ${i + 1}/${steps.length} finished after the resume. Steps ${remaining.join(', ')} still need a full brief, which a resume cannot build — the work so far is kept; re-dispatch to continue.`,
        );
      return {
        ...merged,
        exit: { ...merged.exit, outcome: 'failed', isError: true, reason: 'steps:resume-incomplete' },
      };
    }

    if (!isFinal) {
      // Capture before the next step opens, so its fresh session reads this one's work from the
      // tree rather than from a summary. Best-effort: a checkpoint that fails leaves the work in
      // the worktree, where the next step still sees it — it costs the per-step commit boundary,
      // not the work — so it must not stop a chain that is otherwise fine.
      const ok = await plan.checkpoint(`step ${i + 1}/${steps.length}: ${step.title}`).catch((err) => {
        host.log.warn('could not capture a step before the next one', {
          runId: run.id,
          stepId: step.id,
          err: String(err),
        });
        return false;
      });
      if (!ok) {
        host.log.info('a step captured nothing — it changed no files', { runId: run.id, stepId: step.id });
      }
      // Close the finished session before the next opens. A chain that left every step's session
      // alive would hold N of them open for the run's length, and on a multiTurn driver nothing
      // else ever closes one (settle closes only the last). A stop that THROWS is logged rather
      // than swallowed: it means a live process this chain no longer has a handle to.
      await outcome.stopSession().catch((err) => {
        host.log.warn('a finished step could not be closed — its process may still be running', {
          runId: run.id,
          stepId: step.id,
          err: String(err),
        });
      });
    }
    return null;
  };

  /** One landed-or-not child. `landChild` is the serial return trip: checkpoint the child (publish
   *  is a CAS over COMMITTED state), integrate the parent's current line in, publish — and on a
   *  lost race, re-integrate and retry, which is the same race `landRun` handles at `[land]`. */
  const landChild = async (
    step: ExecutionStep,
    i: number,
    ws: Workspace,
  ): Promise<{ ok: true } | { ok: false; reason: string; detail: string }> => {
    const wave = plan.wave!;
    try {
      await wave.checkpoint(ws, `step ${i + 1}/${steps.length}: ${step.title}`);
    } catch (err) {
      return { ok: false, reason: 'steps:child-checkpoint', detail: String(err) };
    }
    for (let attempt = 1; attempt <= WAVE_PUBLISH_ATTEMPTS; attempt++) {
      let integ: IntegrateResult;
      try {
        integ = await wave.integrateBack(ws);
      } catch (err) {
        return { ok: false, reason: 'steps:child-integrate', detail: String(err) };
      }
      if (!integ.ok) {
        // A child's conflict fails the STEP (workspace kept, a human decides) — see
        // ChainWave.abandonIntegrate for why no resolution turn is spent here.
        await wave.abandonIntegrate(ws).catch(() => {});
        return {
          ok: false,
          reason: 'steps:child-conflict',
          detail: `conflicts in ${integ.conflicts.join(', ')}`,
        };
      }
      let pub: PublishResult;
      try {
        pub = await wave.publishBack(ws);
      } catch (err) {
        return { ok: false, reason: 'steps:child-publish', detail: String(err) };
      }
      if (pub.ok) {
        host
          .transcript(run.id)
          .milestone(`step ${i + 1}/${steps.length} [${step.id}] landed back on the run's line`, step.id);
        // Landed → the work exists on the parent's line, so the child's copy is disposable. A
        // dispose that fails costs a directory, never the work.
        await wave.dispose(ws).catch((err) => {
          host.log.warn('could not dispose a landed child workspace', {
            runId: run.id,
            stepId: step.id,
            err: String(err),
          });
        });
        return { ok: true };
      }
      if (pub.reason !== 'race') return { ok: false, reason: 'steps:child-publish', detail: pub.detail };
      // Lost the CAS: a sibling (or something else) moved the parent's line. Re-integrate and retry.
    }
    return {
      ok: false,
      reason: 'steps:child-publish',
      detail: `lost the publish race ${WAVE_PUBLISH_ATTEMPTS} times`,
    };
  };

  /** Keep-or-dispose for a child whose work did NOT land: never force-delete work that exists
   *  nowhere else. A `hasWork` rejection errs toward keep (RUN-152 — `false` is acted on
   *  destructively, so an unknown answer must not become it). */
  const keepOrDisposeChild = async (step: ExecutionStep, ws: Workspace): Promise<void> => {
    const wave = plan.wave!;
    const has = await wave.hasWork(ws).catch(() => true);
    if (!has) {
      await wave.dispose(ws).catch(() => {});
      return;
    }
    host.log.warn('keeping a wave child workspace — its work landed nowhere else', {
      runId: run.id,
      stepId: step.id,
      path: ws.localPath,
    });
    host
      .transcript(run.id)
      .milestone(`step [${step.id}]'s workspace is kept at ${ws.localPath} — its work landed nowhere else`);
  };

  type WaveMember = {
    step: ExecutionStep;
    i: number;
    ws?: Workspace;
    outcome?: SessionOutcome;
    /** Set when the member never produced a session outcome (lease failed). */
    failed?: string;
  };

  /** A wave of overlapping steps: lease per member, run concurrently, land back serially.
   *  Returns the outcome to STOP the chain with, null to continue — or 'run-sequentially' when
   *  the wave cannot safely overlap after all (the caller then uses the ordinary path). */
  const runWave = async (waveSteps: ExecutionStep[]): Promise<ChainOutcome | null | 'run-sequentially'> => {
    const wave = plan.wave!;
    // Child workspace ids ride runBranch()'s convention, so a planner's free-text step id is
    // narrowed to ref-safe characters — and two ids that collide once narrowed would put two
    // sessions in ONE checkout, the exact invariant per-step workspaces exist to keep. Sequential
    // is always a correct way to do the work.
    const childIds = new Map(waveSteps.map((s) => [s.id, stepWorkspaceId(run.id, s.id)]));
    if (new Set(childIds.values()).size < waveSteps.length) {
      host.log.warn('two step ids collide once made workspace-safe — running this wave sequentially', {
        runId: run.id,
        steps: waveSteps.map((s) => s.id),
      });
      return 'run-sequentially';
    }
    // The parent is checkpointed before the wave opens (RUN-170's settled decision): a lease from
    // a run forks the BRANCH, so uncommitted parent work would be invisible to every child — and
    // the parent worktree must be clean when children publish into it (git's fast-forward refuses
    // a dirty checked-out target). A checkpoint that THROWS forfeits the overlap, not the work.
    try {
      await plan.checkpoint(`before wave: ${waveSteps.map((s) => s.id).join(', ')}`);
    } catch (err) {
      host.log.warn('could not checkpoint the parent before a wave — running it sequentially', {
        runId: run.id,
        err: String(err),
      });
      return 'run-sequentially';
    }

    // ONE reservation divides across the wave. N concurrent `reserve()` calls would each be handed
    // the whole remainder (see splitBudget) — and the first wave keeps the first-step exception:
    // an exhausted run spawns and is declined by the budget layer, the same failure shape as an
    // undecomposed run.
    const firstIndex = indexOf.get(waveSteps[0]!.id)!;
    const reservation = plan.tally.reserve();
    if (!reservation.ok && last) {
      host.log.warn('no budget left for the next wave — stopping the chain', {
        runId: run.id,
        breach: reservation.breach,
      });
      return budgetStop(firstIndex, reservation.breach);
    }
    const share = reservation.ok ? splitBudget(reservation.budget, waveSteps.length) : undefined;

    host
      .transcript(run.id)
      .milestone(
        `wave of ${waveSteps.length}: steps ${waveSteps.map((s) => s.id).join(', ')} run concurrently, each in its own workspace`,
      );

    // A wave child never parks (see the header). The override is the enforcement point: the run's
    // park state is instead probed once, after the wave, where the chain can answer it honestly.
    const childHost: ExecuteHost = { ...host, parkIfBlocked: async () => null };

    const members = await Promise.all(
      waveSteps.map(async (step): Promise<WaveMember> => {
        const i = indexOf.get(step.id)!;
        host
          .transcript(run.id)
          .milestone(`step ${i + 1}/${steps.length} — ${step.title} [${step.id}]`, step.id);
        let ws: Workspace;
        try {
          ws = await wave.lease(childIds.get(step.id)!);
        } catch (err) {
          host.log.warn('could not lease a workspace for a wave step', {
            runId: run.id,
            stepId: step.id,
            err: String(err),
          });
          return { step, i, failed: `steps:lease-failed: ${err}` };
        }
        // A cancel that landed WHILE the lease was resolving (RUN-165/170): `cancelRun` stops only
        // the sessions registered at that instant, so a session spawned after its snapshot would
        // be one nothing ever stops. The persisted fact is asked here, past the await, before any
        // process exists — the member settles as failed and its workspace is kept or disposed by
        // the ordinary rule.
        if (cancelled()) return { step, i, ws, failed: 'cancelled' };
        // A member must RESOLVE whatever happens to it — this map runs under Promise.all, and one
        // member throwing (a driver whose start() throws is an explicitly supported failure) would
        // reject the whole wave: siblings' finished work never integrated, their workspaces never
        // settled, and the run's outcome an exception instead of the failing step's.
        try {
          const outcome = await executeRun(childHost, {
            ...plan,
            worktree: ws,
            stepId: step.id,
            priorSteps: prior,
            slot: `step:${step.id}`,
            start: {
              ...plan.start,
              cwd: ws.localPath,
              prompt: plan.stepPrompt(step, i, prior),
              resumeSessionId: undefined,
              // The reactive lock hook is bound to the PARENT worktree's root; in a child checkout
              // it would compute wrong repo-relative paths and lock names that exist nowhere. The
              // child degrades to the Codex posture — the hard floor (RUN-102) still runs over the
              // parent worktree at landing, AFTER the children's commits have landed into it.
              lockEnforcer: undefined,
              ...(reservation.ok && share ? { budget: share } : {}),
              spendGuard: plan.tally.guard(`step:${step.id}`),
              clockGuard: plan.tally.clockGuard(),
            },
            priorActiveSeconds: plan.tally.activeSeconds(),
          });
          // Unreachable while childHost never parks; the guard keeps a future edit from silently
          // parking a child workspace nothing can resume into.
          if (outcome.parked) return { step, i, ws, failed: 'steps:child-parked' };
          return { step, i, ws, outcome };
        } catch (err) {
          host.log.warn('a wave step threw before producing an outcome — its siblings still land', {
            runId: run.id,
            stepId: step.id,
            err: String(err),
          });
          return { step, i, ws, failed: `steps:child-failed: ${err}` };
        }
      }),
    );

    // The return trip is SERIAL (the settled decision): each finished child lands on the parent's
    // line in turn, so the CAS almost never loses and the gate sees one accumulated diff. A failed
    // step does not cancel its siblings — their work was going to succeed and it lands here — but
    // it does stop the chain: no later wave starts, and the run's outcome is the failing step's.
    let failure: { member: WaveMember; reason: string } | null = null;
    let lastLanded: SessionOutcome | null = null;
    for (const m of members) {
      if (!m.outcome) {
        failure ??= { member: m, reason: m.failed ?? 'steps:child-failed' };
        // A member that got a workspace but no outcome (executeRun threw) still settles it by the
        // same rule as any failed child: keep what holds work, dispose what holds nothing.
        if (m.ws) await keepOrDisposeChild(m.step, m.ws);
        continue;
      }
      allText += m.outcome.sessionText;
      if (m.outcome.exit.outcome !== 'done') {
        host.log.warn('a wave step did not finish — its siblings land, then the chain stops', {
          runId: run.id,
          stepId: m.step.id,
          reason: m.outcome.exit.reason,
        });
        host
          .transcript(run.id)
          .milestone(
            `step ${m.i + 1}/${steps.length} did not finish (${m.outcome.exit.reason ?? 'no reason given'}) — its running siblings finish and land, then the chain stops`,
          );
        failure ??= { member: m, reason: m.outcome.exit.reason ?? 'steps:child-failed' };
        await keepOrDisposeChild(m.step, m.ws!);
        continue;
      }
      const landed = await landChild(m.step, m.i, m.ws!);
      if (!landed.ok) {
        host.log.warn('a wave step finished but its work did not land — its workspace is kept', {
          runId: run.id,
          stepId: m.step.id,
          reason: landed.reason,
          detail: landed.detail,
        });
        host
          .transcript(run.id)
          .milestone(
            `step ${m.i + 1}/${steps.length} [${m.step.id}] did not land back (${landed.detail}) — its workspace is kept`,
          );
        failure ??= { member: m, reason: landed.reason };
        continue;
      }
      // Siblings' summaries join after the wave closes: every member was briefed with the prior
      // list as of wave start, and only steps AFTER the wave read what it adds.
      prior.push({ id: m.step.id, title: m.step.title, text: m.outcome.sessionText.slice(-SUMMARY_CAP) });
      lastLanded = withAllText(m.outcome);
      last = lastLanded;
    }

    // Close every wave session except a failing step's — its outcome is the run's, and settle
    // stops the returned session. A child session is NEVER the one the chain hands onward on
    // success: its cwd is a workspace that is DISPOSED when its work lands, and the gates' fix
    // turns would then edit a removed checkout — which is why the last SCHEDULED step always runs
    // sequentially in the parent workspace (the main loop's tail rule) and every child closes here.
    const keep = failure?.member.outcome ?? null;
    for (const m of members) {
      if (!m.outcome) continue;
      if (keep && m.outcome.session === keep.session) continue;
      await m.outcome.stopSession().catch((err) => {
        host.log.warn('a finished wave step could not be closed — its process may still be running', {
          runId: run.id,
          stepId: m.step.id,
          err: String(err),
        });
      });
    }

    if (failure) {
      const raw = failure.member.outcome;
      if (raw) {
        // The failing step's own outcome, over the whole run's accumulated text. A land-failure
        // rides a session that exited 'done', so the exit is forced to the failure it is.
        const merged = withAllText(raw);
        return raw.exit.outcome !== 'done'
          ? merged
          : { ...merged, exit: { ...merged.exit, outcome: 'failed', isError: true, reason: failure.reason } };
      }
      // No session ever existed for the failing member (its lease failed). A sibling's outcome
      // carries the accumulated work; with none at all, the chain never started anything.
      const carrier = lastLanded ?? last;
      if (!carrier) return { chainFailed: failure.reason };
      return {
        ...carrier,
        exit: { ...carrier.exit, outcome: 'failed', isError: true, reason: failure.reason },
      };
    }

    // A child that stopped to ask a human marked the RUN blocked server-side, and a child cannot
    // park (see the header). Left unanswered, the next sequential step's own park check would
    // adopt the stale question and park the WRONG session against it — so the chain stops here,
    // work landed and kept, and says what happened.
    if (wave.probeBlocked && lastLanded) {
      const blocked = await wave.probeBlocked().catch(() => false);
      if (blocked) {
        host.log.warn('a wave step stopped to ask a human — a concurrent step cannot park', {
          runId: run.id,
        });
        host
          .transcript(run.id)
          .milestone(
            'a step in this wave asked a human a question. A concurrent step cannot park (its workspace has no park record), so the chain stops with the work so far landed and kept — answer on the task and re-dispatch.',
          );
        return {
          ...lastLanded,
          exit: { ...lastLanded.exit, outcome: 'failed', isError: true, reason: 'steps:child-asked' },
        };
      }
    }
    return null;
  };

  // The schedule (RUN-149's planWaves), drawn one wave at a time rather than once: the limit is
  // the machine's SPARE capacity, which moves while a chain runs, so each wave asks again and the
  // remaining steps are re-grouped under the answer. Satisfied dependencies are pruned first —
  // the planner only sees live edges — and a resumed chain slices off the steps already done.
  // With no wave seam, a backend whose leases cannot overlap, or a limit of 1, every wave comes
  // out a singleton — byte-identical order to the pre-RUN-170 sequential chain, since
  // `checkSteps` already topo-ordered the list.
  const doneIds = new Set(steps.slice(0, from).map((s) => s.id));
  let remaining = steps.slice(from);
  while (remaining.length) {
    // Asked per wave as well as per spawn: a cancelled run must not even LEASE for its next wave.
    if (cancelled()) return cancelStop();
    const overlapCap = plan.wave?.leasesOverlap ? Math.max(1, plan.wave.limit()) : 1;
    const pruned = remaining.map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => !doneIds.has(d)) }));
    // Only the FIRST wave of the re-plan is executed; the rest is re-drawn next iteration, against
    // whatever the limit says then. planWaves always schedules at least one step for a non-empty
    // list, so the loop strictly shrinks `remaining`.
    const waveIds = new Set((planWaves(pruned, overlapCap)[0] ?? []).map((s) => s.id));
    const pending = remaining.filter((s) => waveIds.has(s.id));
    if (!pending.length) throw new Error(`chain for ${run.id} could not schedule its remaining steps`);
    // The resumed step is a RESTORED session in the parent's workspace — overlapping fresh
    // siblings around it would fork a base that session is still moving. Its wave runs
    // sequentially; waves after it may overlap.
    const resumedInWave = Boolean(plan.resumeFromStepId) && pending.some((s) => indexOf.get(s.id)! === from);
    // The last SCHEDULED step always runs sequentially, in the parent workspace, after its
    // siblings land: the chain's success outcome is a live session the gates hand fix turns to
    // (RUN-29/146/174 — the contract stated in this function's doc since RUN-168), and a wave
    // child's cwd is a workspace that is DISPOSED when its work lands — handing that session
    // onward would run repairs in a removed checkout while the reviewer folds the PARENT tree.
    //
    // The cost is priced, not overlooked: a final wave of N overlaps N-1, so the minimum
    // decomposition (two independent steps) runs sequentially — pure wall-clock, exactly what
    // every decomposed run was before RUN-170. The two ways to buy that overlap back were both
    // worse than the hour they save. Running the tail IN the parent workspace concurrently with
    // its sibling children breaks the settled wave precondition — the parent checkout must be
    // CLEAN when children publish into it (git's fast-forward refuses a dirty checked-out
    // target), so a failed tail would strand every landed sibling un-landed, and committing a
    // failed step's half-written tree to un-strand them puts partial work on the run's line.
    // Sealing the returned session (no continueWith) instead revokes every gate's repair turn
    // for exactly the long, decomposed runs that need them most — trading a terminal failure for
    // a wall-clock win. A plan whose last step DEPENDS on the others (the common shape a planner
    // writes) loses nothing at all: its tail was already its own wave.
    const isLastWave = pending.length === remaining.length;
    const tail = isLastWave ? pending[pending.length - 1]! : null;
    const overlapped = tail ? pending.slice(0, -1) : pending;
    let sequentially =
      overlapped.length <= 1 || !plan.wave?.leasesOverlap || overlapCap <= 1 || resumedInWave;
    if (!sequentially) {
      const flow = await runWave(overlapped);
      if (flow === 'run-sequentially') sequentially = true;
      else if (flow) return flow;
    }
    if (sequentially) {
      for (const step of overlapped) {
        const flow = await runStep(step, indexOf.get(step.id)!, false);
        if (flow) return flow;
      }
    }
    if (tail) {
      const flow = await runStep(tail, indexOf.get(tail.id)!, true);
      if (flow) return flow;
    }
    for (const s of pending) doneIds.add(s.id);
    remaining = remaining.filter((s) => !waveIds.has(s.id));
  }

  // Unreachable while `checkSteps` guarantees two or more, but a null here would be a crash rather
  // than a bad run.
  if (!last) throw new Error(`chain for ${run.id} ran no steps`);
  return last;
}

/**
 * Which step this session is, and the instruction that makes a step a step.
 *
 * The run's own brief already carries the whole sequence (RUN-148), so this does not repeat it —
 * it says which line of that list is this session's, and that the rest are not. Without the second
 * half a fresh agent handed a plan and a repo does the whole plan, which is the decomposition
 * spending N sessions to get one session's work.
 */
export function renderStepFocus(step: ExecutionStep, index: number, total: number): string {
  const files = step.anticipatedFiles.length
    ? `\n\nFiles this step expects to touch — a starting point, not a fence:\n${step.anticipatedFiles
        .map((f) => `- ${f.path} (${f.change})${f.why ? ` — ${f.why}` : ''}`)
        .join('\n')}`
    : '';
  const truths = step.acceptance.observableTruths.length
    ? `\n\nThis step is done when all of these are TRUE:\n${step.acceptance.observableTruths
        .map((t) => `- ${t}`)
        .join('\n')}`
    : '';
  return `\n\nYOU ARE DOING STEP ${index + 1} OF ${total}: ${step.title}\n\nDo THIS step and stop. The later steps are listed above so you can see where this one is going and leave it in a state they can build on — they are not yours to do, and doing them costs the fresh context each was going to get. Earlier steps are already done and their work is in this workspace. If this step turns out to be wrong or already handled, say so and why rather than finding something else to do with the turn.${files}${truths}`;
}

/** What earlier steps concluded, for the next step's brief. Empty on the first. */
export function renderPriorSteps(prior: StepSummary[]): string {
  if (!prior.length) return '';
  const body = prior.map((s) => `----- ${s.id} — ${s.title} -----\n${s.text.trim()}`).join('\n\n');
  return `\n\nWHAT THE EARLIER STEPS DID. You did not do this work and are not being asked to re-check it; it is here so you do not rediscover what was already settled. It is each step's own closing account, so treat it as a report rather than as a specification — where it disagrees with the code in front of you, the code is right and that disagreement is worth saying out loud.\n\n${body}`;
}
