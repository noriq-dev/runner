// A plan that is a SEQUENCE (RUN-148).
//
// A spec may declare `steps`: an ordered decomposition of work too large for one context. The
// contract carries them (RUN-148's shared half) and the planner authors them; this is the daemon's
// half — what it will accept, and what it tells the builder.
//
// The division of labour is the same one the workflow machine draws: the PLANNER owns the
// judgement (which files are one coherent piece of work), the DAEMON owns the mechanics (are these
// ids usable, is this ordering runnable, is this affordable). A daemon that second-guessed the
// grouping would be re-deciding the thing it asked a planner to decide; a daemon that accepted a
// cyclic dependency graph would hand a scheduler something it cannot run.
//
// Nothing here gates a run. A decomposition that does not survive validation is DROPPED and the run
// proceeds as a single run — which is what every run was before this and is always a correct way to
// do the work. Refusing to build because a planner numbered its steps badly would make an
// optimisation into a tripwire, the same rule the execution spec has carried since RUN-139.

import type { ExecutionSpec, ExecutionStep } from '@noriq-dev/shared';

/** Why a decomposition was not used. Reported, never fatal. */
export interface StepFinding {
  where: string;
  message: string;
}

export interface CheckedSteps {
  /** The steps to run, in execution order. Empty = run as one, the common case. */
  steps: ExecutionStep[];
  findings: StepFinding[];
}

/**
 * More than this and the hand-offs cost more than the work.
 *
 * A ceiling on COUNT is a cost judgement the daemon may make; the grouping itself is not. Twelve
 * is well above any decomposition seen in practice and low enough that a planner that has started
 * emitting one step per file is caught.
 */
export const MAX_STEPS = 12;

/** A decomposition of one is not a decomposition — it is a single run with extra bookkeeping, one
 *  more label in the transcript and one more thing to explain. */
const MIN_STEPS = 2;

/**
 * What the daemon will actually run, from what the planner declared.
 *
 * Everything rejected here is rejected as a WHOLE. A decomposition is a plan for the same work, so
 * running the half of it that validated would execute a different plan than the one anybody
 * checked — some steps missing, their files unclaimed, their acceptance criteria unowned. Dropping
 * to one run is the honest fallback: it is the plan that was always going to work.
 */
export function checkSteps(spec: ExecutionSpec | null | undefined): CheckedSteps {
  const none = (findings: StepFinding[] = []): CheckedSteps => ({ steps: [], findings });
  const declared = spec?.steps ?? [];
  if (!declared.length) return none();
  if (declared.length < MIN_STEPS) {
    return none([
      {
        where: 'steps',
        message: `only ${declared.length} step declared — running as one, which is the same work with less bookkeeping`,
      },
    ]);
  }
  if (declared.length > MAX_STEPS) {
    return none([
      {
        where: 'steps',
        message: `${declared.length} steps declared, more than the ${MAX_STEPS} this daemon will chain — the hand-offs would cost more than the work. Running as one.`,
      },
    ]);
  }

  const findings: StepFinding[] = [];
  const ids = new Set<string>();
  for (const [i, s] of declared.entries()) {
    if (ids.has(s.id)) {
      findings.push({
        where: `steps[${i}]`,
        message: `duplicate step id \`${s.id}\` — a dependency naming it could mean either, and a transcript labelled with it could be either.`,
      });
    }
    ids.add(s.id);
  }
  for (const [i, s] of declared.entries()) {
    for (const dep of s.dependsOn) {
      if (dep === s.id) {
        findings.push({ where: `steps[${i}]`, message: `step \`${s.id}\` depends on itself.` });
      } else if (!ids.has(dep)) {
        findings.push({
          where: `steps[${i}]`,
          message: `step \`${s.id}\` depends on \`${dep}\`, which no step declares.`,
        });
      }
    }
  }
  if (findings.length) return none(findings);

  const ordered = topoOrder(declared);
  if (!ordered) {
    return none([
      {
        where: 'steps',
        message: 'the declared dependencies form a cycle, so no order satisfies them. Running as one.',
      },
    ]);
  }
  return { steps: ordered, findings: [] };
}

/**
 * Declaration order, corrected where a dependency contradicts it.
 *
 * A planner usually declares steps in the order it means them to run, and honouring that keeps a
 * transcript reading the way the plan reads. But `dependsOn` is the authority when the two
 * disagree: a step declared third that a later one depends on has to move, and running the
 * declared order regardless would start work on a foundation that does not exist yet.
 *
 * Returns null on a cycle — the caller drops the whole decomposition, because a cycle is not a
 * plan that is merely mis-ordered, it is one that cannot be run at all.
 */
function topoOrder(steps: ExecutionStep[]): ExecutionStep[] | null {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const done = new Set<string>();
  const out: ExecutionStep[] = [];
  // Kahn's, but scanning in DECLARATION order each pass so ties break the way the planner wrote
  // them rather than the way a queue happens to pop.
  while (out.length < steps.length) {
    const ready = steps.filter((s) => !done.has(s.id) && s.dependsOn.every((d) => done.has(d)));
    if (!ready.length) return null; // nothing runnable and steps remain: a cycle
    for (const s of ready) {
      done.add(s.id);
      out.push(byId.get(s.id)!);
    }
  }
  return out;
}

/**
 * The steps grouped into WAVES — sets that may run at the same time (RUN-149).
 *
 * A step joins a wave when two things hold, and they are different questions:
 *
 *   1. Every step it `dependsOn` is already in an EARLIER wave. This is the plan's own statement
 *      about order and it is the authority on it.
 *   2. Its declared files do not overlap any step already in that wave. This is the daemon's
 *      question, not the planner's — the planner said what each step touches, and whether two of
 *      those sets intersect is arithmetic.
 *
 * The second is why an undeclared overlap is not merely a missed optimisation. `anticipatedFiles`
 * is briefed to the agent as "a starting point, not a fence", so two steps in one wave CAN reach
 * for the same file despite declaring otherwise — which is exactly why concurrent steps need
 * separate workspaces rather than trusting the declaration. The overlap check decides what is
 * worth running together; it is not what makes running together safe.
 *
 * `limit` caps a wave, so a decomposition cannot outrun the machine. Steps that do not fit are not
 * dropped — they fall to the next wave, which is a slower schedule and never a smaller plan.
 *
 * A pure function over the validated list, so the schedule can be reasoned about and tested
 * without a workspace, a driver, or a clock.
 */
export function planWaves(steps: ExecutionStep[], limit = Number.POSITIVE_INFINITY): ExecutionStep[][] {
  const waves: ExecutionStep[][] = [];
  const done = new Set<string>();
  const remaining = [...steps];
  while (remaining.length) {
    const wave: ExecutionStep[] = [];
    const claimed = new Set<string>();
    for (const step of remaining) {
      if (wave.length >= limit) break;
      if (!step.dependsOn.every((d) => done.has(d))) continue;
      const files = step.anticipatedFiles.map((f) => f.path);
      if (files.some((f) => claimed.has(f))) continue;
      wave.push(step);
      for (const f of files) claimed.add(f);
    }
    // Nothing was runnable and steps remain. `checkSteps` has already refused a cycle, so the only
    // way here is a `limit` of zero or less — a caller asking for no concurrency at all. Answer it
    // the way it was asked rather than looping: one step per wave is a valid schedule.
    if (!wave.length) {
      const next = remaining.shift();
      if (!next) break;
      done.add(next.id);
      waves.push([next]);
      continue;
    }
    for (const s of wave) {
      done.add(s.id);
      remaining.splice(remaining.indexOf(s), 1);
    }
    waves.push(wave);
  }
  return waves;
}

/**
 * The decomposition as the builder reads it.
 *
 * Until each step is its own session (the remainder of RUN-148), this is what makes a declared
 * decomposition worth anything: one agent doing the work in a stated order, finishing each piece
 * before starting the next. That is most of the value — the architecture doc's own reason for
 * sequencing this before concurrency is that better-shaped sequential work beats poorly-shaped
 * parallel work, and the shape is the plan rather than the scheduling.
 *
 * It says out loud that the ORDER is the instruction. A list of steps read as a summary of the
 * work is a list an agent will do in whatever order it finds convenient, which is what it would
 * have done anyway.
 */
export function renderSteps(checked: CheckedSteps): string {
  if (!checked.steps.length) return '';
  const body = checked.steps
    .map((s, i) => {
      const files = s.anticipatedFiles.length
        ? `\n     files: ${s.anticipatedFiles.map((f) => `${f.path} (${f.change})`).join(', ')}`
        : '';
      const truths = s.acceptance.observableTruths.length
        ? `\n     done when: ${s.acceptance.observableTruths.join('; ')}`
        : '';
      return `  ${i + 1}. [${s.id}] ${s.title}${files}${truths}`;
    })
    .join('\n');
  return `\n\nTHIS WORK IS A SEQUENCE. Do these in the order given, finishing each before starting the next — the order is the instruction, not a summary of what is involved. Land each step in a state the next one can build on, and say which step you are on as you go. If a step turns out to be wrong or unnecessary once you are in the code, say so and why rather than silently reshaping the plan.\n${body}`;
}
