/**
 * A decomposed run, executed as a chain of sessions (RUN-168).
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
 * What this does NOT do, deliberately:
 *
 * - **No per-step lock scope.** A sequential chain holds the parent's union, which is the correct
 *   hold for work that cannot race itself. Narrower per-step locks buy something only once steps
 *   run concurrently, and that is where the change belongs.
 * - **No per-step gate.** The deterministic floor and the reviewer judge the accumulated diff once,
 *   at the parent. A criterion is a statement about the finished work, and a step that satisfies
 *   its own slice can leave the whole unmet; running the most expensive stage per step would also
 *   multiply it by the decomposition.
 * - **No separate workspace per step.** Sequential steps share the parent's, checkpointing between
 *   them so the next step's fresh context reads the previous one's work from the tree rather than
 *   being told about it. A lease per step would erode "one worktree per Run" to buy isolation
 *   between things that cannot conflict.
 */

import type { ExecutionStep } from '@noriq-dev/shared';
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

export interface ChainPlan extends Omit<ExecutePlan, 'stepId'> {
  /** The validated, ordered decomposition. Two or more by construction (`checkSteps`). */
  steps: ExecutionStep[];
  /** This step's brief, built from the run's own facts plus what earlier steps concluded. */
  stepPrompt: (step: ExecutionStep, index: number, prior: StepSummary[]) => string;
  /** Capture the accumulated work between steps, so the next session reads it from the tree.
   *  Returns false when there was nothing to capture, which is not an error. */
  checkpoint: (label: string) => Promise<boolean>;
  /** Resume a chain from this step, skipping the ones already finished (RUN-168). The FIRST step
   *  run is then the parked one, resumed rather than started — `plan.start` carries its session id.
   *  Absent on a fresh run. */
  resumeFromStepId?: string;
}

/**
 * Run the chain, and stop at the first step that does not finish.
 *
 * Stopping is not pessimism. A step that failed, parked, or ran out of budget leaves the tree in a
 * state the next step was not planned against, so continuing would build step three on a foundation
 * the run already knows is broken — and would report a run that did most of its plan as one that
 * did all of it. The outcome returned is that step's, so the run's fate and its reason are the
 * failing step's, not a summary invented here.
 *
 * The LAST step's session is the one returned on success, and that is what the gate's fix turns
 * hand back to (RUN-146's repair spec tells it what is outstanding, with file pointers, so it can
 * fix work an earlier step did).
 */
export async function executeChain(host: ExecuteHost, plan: ChainPlan): Promise<ExecuteOutcome> {
  const { run, steps } = plan;
  // A resumed chain re-enters at the step that parked; everything before it is already done.
  // An UNKNOWN id is the interesting case: the spec may have been corrected during a park of up to
  // 72 hours (RUN-164), so the step that parked can be gone from the recomputed chain. Restarting
  // from the top would redo landed work, and skipping to the end would abandon it — so the run
  // stops and says so, because which of those a human wants is not something to guess.
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
    return {
      parked: {
        outcome: 'failed',
        isError: true,
        reason: 'steps:parked-step-gone',
        telemetry: plan.tally.total(),
      },
    };
  }

  const prior: StepSummary[] = [];
  let last: ExecuteOutcome | null = null;

  for (const [i, step] of steps.entries()) {
    if (i < from) continue;
    host.transcript(run.id).milestone(`step ${i + 1}/${steps.length} — ${step.title} [${step.id}]`);

    // Every step reserves from the RUN's remaining ceiling (RUN-133). A step with nothing left
    // declines rather than starting a process to kill, and the run stops there with its earlier
    // steps' work intact — the same shape as any exhausted run.
    const reservation = plan.tally.reserve();
    if (!reservation.ok) {
      host.log.warn('no budget left for the next step — stopping the chain', {
        runId: run.id,
        stepId: step.id,
        breach: reservation.breach,
      });
      host
        .transcript(run.id)
        .milestone(
          `the run's ceiling was reached at step ${i + 1}/${steps.length} (${reservation.breach}) — steps ${i + 1} onward did not run`,
        );
      if (last) return last;
      return {
        parked: {
          outcome: 'failed',
          isError: true,
          reason: `steps:${reservation.breach}`,
          telemetry: plan.tally.total(),
        },
      };
    }

    // The FIRST step of a resumed chain is the parked session coming back, so it keeps the caller's
    // `start` verbatim — its resume session id and the human's answer as its prompt. Every other
    // step is a fresh session with its own brief.
    const resumingThisOne = i === from && Boolean(plan.resumeFromStepId);
    const outcome = await executeRun(host, {
      ...plan,
      stepId: step.id,
      start: resumingThisOne
        ? plan.start
        : {
            ...plan.start,
            prompt: plan.stepPrompt(step, i, prior),
            // A fresh session, never the previous step's: inheriting it would make this one long
            // context wearing a decomposition, which is the thing being avoided.
            resumeSessionId: undefined,
            ...(reservation.budget ? { budget: reservation.budget } : {}),
            spendGuard: plan.tally.guard(`step:${step.id}`),
            clockGuard: plan.tally.clockGuard(),
          },
      // Only the first step of a sitting carries the prior active seconds; charging them again per
      // step would make a chain's wall-clock ceiling shrink by its own length.
      priorActiveSeconds: i === from ? plan.priorActiveSeconds : 0,
    });

    if (outcome.parked) return outcome;
    last = outcome;
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
      return outcome;
    }

    prior.push({ id: step.id, title: step.title, text: outcome.sessionText.slice(-SUMMARY_CAP) });

    // Capture before the next step opens, so its fresh session reads this one's work from the tree
    // rather than from a summary. Best-effort: a checkpoint that fails leaves the work in the
    // worktree, where the next step still sees it — it costs the per-step commit boundary, not the
    // work — so it must not stop a chain that is otherwise fine.
    if (i < steps.length - 1) {
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
      // The session that just finished is closed before the next opens. A chain that left every
      // step's session alive would hold N of them open for the length of the run, and on a
      // multiTurn driver nothing else ever closes one (settle closes only the last).
      await outcome.stopSession().catch(() => {});
    }
  }

  // Unreachable while `checkSteps` guarantees two or more, but a null here would be a crash rather
  // than a bad run, and the caller has a perfectly good single-session path to fall back to.
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
