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

import type { ExecutionSpec, Run, RunBudget } from '@noriq-dev/shared';
import { ExecutionSpec as ExecutionSpecSchema, hasExecutionSpec } from '@noriq-dev/shared';
import type { RunAgent } from '../client';
import type { BudgetRun } from '../drivers/budget';
import type { AgentDriver, DriverSession, DriverStartOptions } from '../drivers/types';
import type { CheckedExecutionSpec } from '../execution-spec';
import type { logger as defaultLogger } from '../logger';
import { renderPrompt } from '../prompts';
import type { ResolvedRepo, RunReport, RunTally } from '../supervisor';
import type { RunTranscript } from '../transcript';
import type { Workspace } from '../vcs/types';

/** How much planner output is kept. One spec plus its preamble is a few kB; a model producing
 *  more than this is not producing a spec. */
export const PLANNER_OUTPUT_CAP = 64_000;

/** The repair turn's own deadline (RUN-197): the stage's budget may carry no duration ceiling,
 *  and a turn that never settles must still reach abandon() rather than hold the slot forever. */
export const REPAIR_TURN_TIMEOUT_MS = 10 * 60_000;

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
  return parsePlannedSpecDetailed(text).spec;
}

/**
 * The same parse, with WHY it failed — the words the repair turn hands back (RUN-197). The error
 * is the LAST candidate's, which is the block the model most recently meant; earlier drafts'
 * failures would send it fixing text it already superseded.
 */
export function parsePlannedSpecDetailed(text: string): {
  spec: ExecutionSpec | null;
  error: string | null;
} {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  const candidates = fenced.length
    ? fenced.reverse()
    : [bareObject(text)].filter((c): c is string => c !== null);
  let error: string | null = candidates.length ? null : 'no JSON object found in the output at all';
  for (const c of candidates) {
    try {
      const parsed = ExecutionSpecSchema.safeParse(JSON.parse(c));
      // safeParse and not parse: a planner naming a path that leaves the repo, or a change kind
      // that does not exist, has written something this contract refuses — and the answer to that
      // is an unplanned run, never a thrown stage.
      if (parsed.success) return { spec: parsed.data, error: null };
      if (!error) {
        error = `the JSON parsed but the spec contract refused it: ${parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`;
      }
    } catch (err) {
      // Not JSON. Try the next candidate; a model that emitted two blocks may have got one right.
      // An unterminated block is the live-observed shape: a session that ended mid-emission left
      // no closing fence, so the bare-object fallback caught a truncated `{…` and failed here.
      if (!error) error = `the output is not valid JSON: ${String(err)}`;
    }
  }
  return { spec: null, error };
}

/** The outermost `{…}` in a body with no fence. Deliberately crude: this is the fallback path. */
function bareObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

/**
 * What the stage produced. `null` = the run stays unplanned, which is not a failure.
 *
 * The session stays OPEN when a plan came back, because the checker (RUN-141) revises through it:
 * a planner asked to fix its own plan in a fresh context would be re-deriving everything it
 * already worked out. The caller therefore OWNS it and must `close()` — nothing else shuts the
 * query down, and an open one keeps the daemon's event loop alive forever (RUN-29).
 */
export interface PlannedRun {
  checked: CheckedExecutionSpec;
  /** The whole PLANNING phase's ceiling — the planner and every checker round share it (RUN-141).
   *  Recomputing a fraction per session would compound into most of the run. */
  envelope: RunBudget | null;
  /**
   * Hand the planner a revision request and take its new spec. Null = the turn failed or produced
   * nothing usable, which ends the loop with the plan as it stands.
   *
   * `text` is the turn's own output, for the adjudication half of the ledger: a planner that
   * contested a finding with a pointer has said something the NEXT checker needs, and a ledger
   * that records only the finding carries the accusation without the answer (RUN-79).
   */
  revise(feedback: string): Promise<{ checked: CheckedExecutionSpec; text: string } | null>;
  /** Close the planner's session, and persist whatever the loop settled on. */
  close(final: CheckedExecutionSpec): Promise<void>;
}
export type PlanOutcome = PlannedRun | null;

export const planRun = async (host: PlanHost, plan: PlanInput): Promise<PlanOutcome> => {
  const { run, tally } = plan;
  host.report(run.id, { status: 'running', phase: 'agent' });
  host.transcript(run.id).milestone('no execution spec on this task — planning it in a fresh context first');

  let text = '';
  /** Non-null only while a repair (RUN-197) or revision (RUN-198) turn runs — that turn's own
   *  bounded accumulator, because a length snapshot into the sliding tail cap cannot isolate one. */
  let repairBuf: string | null = null;
  const startedAt = Date.now();
  const budgetRun = host.startAgent(plan.driver, {
    ...plan.start,
    prompt: plan.prompt,
    // Kept open so the checker can hand revisions back into the context that wrote the plan
    // (RUN-141). `close` below is the only thing that shuts it, and every path reaches one.
    multiTurn: true,
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
        // The repair turn's own accumulator (RUN-197). A length snapshot into `text` cannot
        // isolate a turn: the tail cap SLIDES once the buffer is full, so `slice(before)` would
        // drop the head of the re-emission by however much the first attempt overflowed.
        if (repairBuf !== null) repairBuf = (repairBuf + t).slice(-PLANNER_OUTPUT_CAP);
        host.transcript(run.id).text('agent', t);
      },
    },
  });

  host.steering?.register(run.id, budgetRun.session, budgetRun.stop);

  // The session stays open past its first result (multiTurn) — `close()` is what ends it, and
  // every path below reaches one. Steering stays registered until then, so a cancel during the
  // checker loop still has a target.
  const abandon = async (why: string): Promise<null> => {
    host.steering?.unregister(run.id);
    await budgetRun.stop().catch(() => {});
    tally.chargeTime((Date.now() - startedAt) / 1000);
    host.transcript(run.id).milestone(`${why} — proceeding unplanned`);
    return null;
  };

  // Everything from here to the `return` runs with the session ALREADY OPEN and its ownership not
  // yet handed over. A throw in any of it — `done` rejecting, `checkSpec` failing, a transcript
  // callback — would leave an SDK query nobody holds a handle to, and an open one keeps the
  // daemon's event loop alive forever (RUN-29). So the whole stretch is guarded.
  let exit: Awaited<BudgetRun['done']>;
  try {
    exit = await budgetRun.done;
  } catch (err) {
    await abandon(`planning errored (${String(err)})`);
    return null;
  }
  tally.record('plan', exit.telemetry);

  if (exit.outcome !== 'done') {
    host.log.warn('planner did not finish — the run proceeds unplanned', {
      runId: run.id,
      reason: exit.reason,
    });
    return abandon(`planning did not finish (${exit.reason ?? 'failed'})`);
  }

  let { spec, error } = parsePlannedSpecDetailed(text);
  if (!spec) {
    // ONE repair turn through the still-open session (RUN-197), before the bin. The live failure
    // this closes: a planner streamed a complete ~15k spec, ended its turn mid-JSON, and the run
    // proceeded UNPLANNED with the whole plan sitting one `continueWith` away — the session is
    // already open for the checker's revise loop, so asking costs a turn, not a context.
    const turn = budgetRun.session.continueWith;
    if (turn) {
      host.log.warn('planner spec did not parse — asking the same session to re-emit', {
        runId: run.id,
        error,
      });
      host.transcript(run.id).milestone('the planned spec did not parse — asking the planner to re-emit it');
      repairBuf = '';
      // Bounded even when the stage's own budget carries no duration ceiling: a repair turn that
      // never settles must still reach abandon(), or the stage holds its slot forever.
      const repaired = await Promise.race([
        turn
          .call(budgetRun.session, renderPrompt('plan-reparse', { error: error ?? 'unparseable output' }))
          .catch(() => null),
        new Promise<null>((r) => setTimeout(r, REPAIR_TURN_TIMEOUT_MS, null)),
      ]);
      // The repair turn's OWN accumulator only — `text` still holds the broken block, and parsing
      // the whole of it would find that block again.
      if (repaired?.outcome === 'done') spec = parsePlannedSpecDetailed(repairBuf).spec;
      repairBuf = null;
    }
    if (!spec) {
      host.log.warn('planner produced no usable spec — the run proceeds unplanned', { runId: run.id });
      return abandon('planning produced nothing usable');
    }
  }

  // Checked exactly as a delivered spec is (RUN-139), and for a sharper reason: the planner wrote
  // these paths from what it read, so a `modify` naming a file that is not there means it guessed.
  // The builder is told, and so is anyone reading the transcript.
  const checked = await host.checkSpec(spec, plan.worktree.localPath).catch(async (err) => {
    await abandon(`could not check the planned spec (${String(err)})`);
    return null;
  });
  if (!checked) return null;
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

  const save = async (final: CheckedExecutionSpec): Promise<void> => {
    // Written back so the plan is VISIBLE and CORRECTABLE — the point of planning in the open
    // rather than in the builder's head. Best-effort: a save that fails costs reusability on a
    // retry and a human's chance to correct it, never this run, which already holds the spec.
    //
    // An EMPTY spec is not worth persisting: `hasExecutionSpec` reads it as unplanned anyway, and
    // storing it would make every future attempt skip planning because the field is no longer null.
    if (!host.saveSpec || run.anchor?.type !== 'task' || !hasExecutionSpec(final.spec)) return;
    const saved = await host.saveSpec(run.projectId, run.anchor.taskId, final.spec).catch((err) => {
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
  };

  return {
    checked,
    envelope: plan.start.budget ?? null,
    revise: async (feedback: string) => {
      // Parse only THIS turn's output — through the turn accumulator, not a length snapshot into
      // `text`: the tail cap SLIDES once the buffer is full, and a slid snapshot misaligns every
      // later parse (RUN-198; the exact bug RUN-197 fixed for the repair turn — "could not
      // revise" on the live run was this). Parsing the whole buffer would be worse still: it
      // finds the ORIGINAL plan's fence and hands it back as the revision.
      const turn = budgetRun.session.continueWith;
      if (!turn) return null;
      repairBuf = '';
      const revisedExit = await turn.call(budgetRun.session, feedback).catch((err) => {
        host.log.warn('could not hand the plan findings back', { runId: run.id, err: String(err) });
        return null;
      });
      const turnText = repairBuf;
      repairBuf = null;
      if (!revisedExit || revisedExit.outcome !== 'done') return null;
      const revised = parsePlannedSpec(turnText);
      // The revision REPLACES the plan, so nothing parseable means the previous one stands rather
      // than being lost — a checker round that produced no new plan has cost tokens, not a plan.
      if (!revised) return null;
      return { checked: await host.checkSpec(revised, plan.worktree.localPath), text: turnText };
    },
    close: async (final: CheckedExecutionSpec) => {
      // STOPPING IS UNCONDITIONAL. Saving first and stopping after meant a save that hung or threw
      // left the session open — and the caller discards this promise's rejection, so nothing would
      // ever have noticed. The persistence is the part that is allowed to fail.
      try {
        await save(final);
      } finally {
        host.steering?.unregister(run.id);
        await budgetRun.stop().catch(() => {});
        tally.chargeTime((Date.now() - startedAt) / 1000);
      }
    },
  };
};
