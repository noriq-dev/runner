/**
 * The `plan` stage (RUN-140): a fresh read-only agent writes the execution spec the builder will be
 * handed, when the task arrived without one.
 *
 * A SEPARATE CONTEXT from the builder, and that is the whole point of the phase rather than an
 * implementation detail. A build agent asked to plan its own work plans in the same context it then
 * executes in: the plan is never written down, nobody can correct it before it is acted on, and the
 * agent's most valuable early context goes on rediscovering the repo instead of on the work. Here
 * the plan is an artifact — visible in the dashboard, correctable by a human, reusable by a retry.
 *
 * Read-only by construction, not by instruction. The actor runs at the `verify` posture, so
 * `clampPermissionToWorkflow` forces `write = false` at the spawn (RUN-118/158) — a planner that
 * decided to start implementing could not, whatever its prompt said.
 *
 * It cannot gate the run. A planner that fails, produces nothing parseable, or has no budget left
 * leaves the run exactly as it would have been without this stage: unplanned, which is how every
 * run worked before RUN-134 and how a task with no spec still works. Planning is worth tokens; it
 * is not worth a run.
 */

import type { ExecutionSpec, Run } from '@noriq-dev/shared';
import { ExecutionSpec as ExecutionSpecSchema, hasExecutionSpec } from '@noriq-dev/shared';
import type { RunAgent } from '../client';
import type { BudgetRun } from '../drivers/budget';
import type { AgentDriver, DriverSession, DriverStartOptions } from '../drivers/types';
import type { CheckedExecutionSpec } from '../execution-spec';
import type { logger as defaultLogger } from '../logger';
import type { ResolvedRepo, RunReport, RunTally } from '../supervisor';
import type { RunTranscript } from '../transcript';
import type { Workspace } from '../vcs/types';

/** How much planner output is kept. One spec plus its preamble is a few kB; a model producing
 *  more than this is not producing a spec. */
export const PLANNER_OUTPUT_CAP = 64_000;

export interface PlanHost {
  readonly log: typeof defaultLogger;
  report(runId: string, frame: RunReport): void;
  transcript(runId: string): RunTranscript;
  startAgent(driver: AgentDriver, opts: DriverStartOptions): BudgetRun;
  /** Makes the planner cancellable while it runs (RUN-16/18) — it is a live session like any
   *  other, and one outside this is one `run.cancel` cannot reach. */
  steering?: {
    register: (runId: string, session: DriverSession, stop: () => Promise<void>) => void;
    unregister: (runId: string) => void;
  };
  /** Check a synthesized spec against the workspace, exactly as a delivered one is (RUN-139). */
  checkSpec(spec: ExecutionSpec, root: string): Promise<CheckedExecutionSpec>;
  /** Write the spec back to the Noriq task, so it is visible, correctable, and reusable. Answers
   *  FALSE when it declined — the task gained a spec while this one was being written, and a human
   *  who edited a task mid-plan has said something the planner has not. */
  saveSpec?(projectId: string, taskId: string, spec: ExecutionSpec): Promise<boolean>;
}

export interface PlanInput {
  run: Run;
  repo: ResolvedRepo;
  worktree: Workspace;
  driver: AgentDriver;
  runAgent: RunAgent;
  tally: RunTally;
  /** The planner's own prompt, assembled by `prepare` from the planner template. */
  prompt: string;
  /** Everything the spawn needs bar the prompt, handlers and env — the same shape `execute` takes. */
  start: Omit<DriverStartOptions, 'handlers' | 'env' | 'prompt' | 'multiTurn'>;
}

/**
 * Extract the spec from a planner's output.
 *
 * Takes the LAST fenced json block, not the first: a model that thinks aloud often shows a draft
 * and then a corrected final answer, and the first block is the draft. A bare object with no fence
 * is accepted too — the instruction asks for a fence, and refusing an otherwise perfect answer over
 * punctuation would throw away the tokens that produced it.
 *
 * Returns null when there is nothing parseable, which is a legitimate outcome and not an error: the
 * run proceeds unplanned.
 */
export function parsePlannedSpec(text: string): ExecutionSpec | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  const candidates = fenced.length
    ? fenced.reverse()
    : [bareObject(text)].filter((c): c is string => c !== null);
  for (const c of candidates) {
    try {
      const parsed = ExecutionSpecSchema.safeParse(JSON.parse(c));
      // safeParse and not parse: a planner naming a path that leaves the repo, or a change kind
      // that does not exist, has written something this contract refuses — and the answer to that
      // is an unplanned run, never a thrown stage.
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON. Try the next candidate; a model that emitted two blocks may have got one right.
    }
  }
  return null;
}

/** The outermost `{…}` in a body with no fence. Deliberately crude: this is the fallback path. */
function bareObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

/** What the stage produced. `null` = the run stays unplanned, which is not a failure. */
export type PlanOutcome = CheckedExecutionSpec | null;

export const planRun = async (host: PlanHost, plan: PlanInput): Promise<PlanOutcome> => {
  const { run, tally } = plan;
  host.report(run.id, { status: 'running', phase: 'agent' });
  host.transcript(run.id).milestone('no execution spec on this task — planning it in a fresh context first');

  let text = '';
  const startedAt = Date.now();
  const budgetRun = host.startAgent(plan.driver, {
    ...plan.start,
    prompt: plan.prompt,
    handlers: {
      onTelemetry: (t) => {
        // Its own slot, so the run's total shows what planning cost rather than folding it into
        // the builder's (RUN-59's per-slot ledger).
        tally.record('plan', t);
        host.report(run.id, { status: 'running', telemetry: tally.total() });
      },
      onText: (t) => {
        // Bounded. The answer is one JSON object and a sentence; a model that produces megabytes
        // has gone wrong, and accumulating all of it would spend memory to parse something that
        // will not be a spec. Keeping the TAIL rather than the head is deliberate — the block the
        // parser wants is the last one.
        text = (text + t).slice(-PLANNER_OUTPUT_CAP);
        host.transcript(run.id).text('agent', t);
      },
    },
  });

  host.steering?.register(run.id, budgetRun.session, budgetRun.stop);

  let exit: Awaited<BudgetRun['done']>;
  try {
    exit = await budgetRun.done;
  } finally {
    host.steering?.unregister(run.id);
    // A planner is single-turn, but stopping is what closes the SDK query — an open one keeps the
    // daemon's event loop alive forever (RUN-29).
    await budgetRun.stop().catch(() => {});
    tally.chargeTime((Date.now() - startedAt) / 1000);
  }
  tally.record('plan', exit.telemetry);

  if (exit.outcome !== 'done') {
    host.log.warn('planner did not finish — the run proceeds unplanned', {
      runId: run.id,
      reason: exit.reason,
    });
    host
      .transcript(run.id)
      .milestone(`planning did not finish (${exit.reason ?? 'failed'}) — proceeding unplanned`);
    return null;
  }

  const spec = parsePlannedSpec(text);
  if (!spec) {
    host.log.warn('planner produced no usable spec — the run proceeds unplanned', { runId: run.id });
    host.transcript(run.id).milestone('planning produced nothing usable — proceeding unplanned');
    return null;
  }

  // Checked exactly as a delivered spec is (RUN-139), and for a sharper reason: the planner wrote
  // these paths from what it read, so a `modify` naming a file that is not there means it guessed.
  // The builder is told, and so is anyone reading the transcript.
  const checked = await host.checkSpec(spec, plan.worktree.localPath);
  const problems = checked.findings.filter((f) => f.level === 'problem');
  if (problems.length) {
    host.log.warn('the planned spec disagrees with the checkout', {
      runId: run.id,
      where: problems.map((f) => f.where).join(', '),
    });
  }
  host
    .transcript(run.id)
    .milestone(
      `planned: ${spec.anticipatedFiles.length} anticipated file(s), ${spec.acceptance.observableTruths.length} acceptance criteri(a)${
        problems.length ? `, ${problems.length} disagreeing with the checkout` : ''
      }`,
    );

  // Write it back so it is VISIBLE and CORRECTABLE — the point of planning in the open rather than
  // in the builder's head. Best-effort: a save that fails costs reusability on a retry and the
  // human's chance to correct it, never this run, which already holds the spec in hand.
  // An EMPTY planned spec is not worth persisting: `hasExecutionSpec` reads it as unplanned
  // anyway, and storing it would make every future attempt skip planning because the field is no
  // longer null. A planner that found nothing to say leaves the task exactly as it was.
  if (host.saveSpec && run.anchor?.type === 'task' && hasExecutionSpec(spec)) {
    const saved = await host.saveSpec(run.projectId, run.anchor.taskId, spec).catch((err) => {
      host.log.warn('could not save the planned spec back to the task', {
        runId: run.id,
        err: String(err),
      });
      return false;
    });
    // A DECLINED save is not a failure: the task gained a spec while this one was being written,
    // which means a human said something the planner did not know. This run still uses what it
    // planned — it is already briefed — but the task keeps theirs.
    if (!saved) {
      host
        .transcript(run.id)
        .milestone('the task gained a spec while planning — theirs kept, not overwritten');
    }
  }

  return checked;
};
