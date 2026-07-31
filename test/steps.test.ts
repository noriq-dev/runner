import { ExecutionSpec, type ExecutionSpecInput } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import { MAX_STEPS, checkSteps, owningRunId, planWaves, renderSteps, stepWorkspaceId } from '../src/steps';

// RUN-148. A spec may declare an ordered decomposition. The PLANNER owns the judgement (which files
// are one coherent piece of work); the daemon owns the mechanics (are these ids usable, is this
// ordering runnable, is this affordable) — and nothing here gates a run: a decomposition that does
// not survive is dropped, and the run proceeds as one, which is what every run was before this.

const spec = (over: ExecutionSpecInput = {}) => ExecutionSpec.parse(over);
const step = (id: string, over: Record<string, unknown> = {}) => ({ id, title: `do ${id}`, ...over });
const ids = (c: { steps: Array<{ id: string }> }) => c.steps.map((s) => s.id);

describe('what the daemon will chain', () => {
  it('keeps the planner’s declared order when nothing contradicts it', () => {
    const c = checkSteps(spec({ steps: [step('a'), step('b'), step('c')] }));
    expect(ids(c)).toEqual(['a', 'b', 'c']);
    expect(c.findings).toEqual([]);
  });

  // Declaration order usually IS the intent, and honouring it keeps a transcript reading the way
  // the plan reads — but a dependency is the authority when the two disagree, or the run starts
  // work on a foundation that does not exist yet.
  it('moves a step its successor depends on ahead of it', () => {
    const c = checkSteps(spec({ steps: [step('a', { dependsOn: ['b'] }), step('b')] }));
    expect(ids(c)).toEqual(['b', 'a']);
  });

  it('breaks ties the way the planner wrote them, not the way a queue pops', () => {
    const c = checkSteps(spec({ steps: [step('a'), step('b'), step('c', { dependsOn: ['a'] })] }));
    expect(ids(c)).toEqual(['a', 'b', 'c']);
  });
});

// Every rejection drops the WHOLE decomposition. Running the half that validated would execute a
// different plan than the one anybody checked — steps missing, their files unclaimed, their
// acceptance criteria unowned. One run is the plan that was always going to work.
describe('what it refuses, and how it refuses', () => {
  it('drops a decomposition with a cycle rather than guessing an order', () => {
    const c = checkSteps(spec({ steps: [step('a', { dependsOn: ['b'] }), step('b', { dependsOn: ['a'] })] }));
    expect(c.steps).toEqual([]);
    expect(c.findings[0]!.message).toMatch(/form a cycle/);
  });

  it('drops one naming a dependency no step declares', () => {
    const c = checkSteps(spec({ steps: [step('a', { dependsOn: ['ghost'] }), step('b')] }));
    expect(c.steps).toEqual([]);
    expect(c.findings[0]!.message).toMatch(/depends on `ghost`, which no step declares/);
  });

  // A duplicate id makes a dependency ambiguous and a transcript label meaningless.
  it('drops one with a duplicate id', () => {
    const c = checkSteps(spec({ steps: [step('a'), step('a')] }));
    expect(c.steps).toEqual([]);
    expect(c.findings[0]!.message).toMatch(/duplicate step id/);
  });

  it('drops a step that depends on itself', () => {
    const c = checkSteps(spec({ steps: [step('a', { dependsOn: ['a'] }), step('b')] }));
    expect(c.steps).toEqual([]);
    expect(c.findings[0]!.message).toMatch(/depends on itself/);
  });

  // A decomposition of one is a single run with extra bookkeeping.
  it('ignores a single-step decomposition', () => {
    const c = checkSteps(spec({ steps: [step('a')] }));
    expect(c.steps).toEqual([]);
    expect(c.findings[0]!.message).toMatch(/running as one/);
  });

  // A count ceiling is a COST judgement, which the daemon may make; the grouping is not.
  it('refuses more steps than it will chain, and says the hand-offs are the reason', () => {
    const many = Array.from({ length: MAX_STEPS + 1 }, (_, i) => step(`s${i}`));
    const c = checkSteps(spec({ steps: many }));
    expect(c.steps).toEqual([]);
    expect(c.findings[0]!.message).toMatch(/hand-offs would cost more than the work/);
  });

  // The common case, and it must stay silent: most work is one step and saying so on every task
  // would be noise.
  it('says nothing at all about a spec that declares no steps', () => {
    expect(checkSteps(spec({ requirementIds: ['R-1'] }))).toEqual({ steps: [], findings: [] });
    expect(checkSteps(null)).toEqual({ steps: [], findings: [] });
  });
});

// RUN-149. Which steps may run at the same time. Two different questions: `dependsOn` is the
// PLAN's statement about order and is authoritative; whether two declared file sets intersect is
// arithmetic the daemon does.
describe('grouping steps into waves', () => {
  const ok = (over: ExecutionSpecInput) => checkSteps(spec(over)).steps;
  const shape = (waves: Array<Array<{ id: string }>>) => waves.map((w) => w.map((s) => s.id));

  it('runs independent, non-overlapping steps together', () => {
    const waves = planWaves(
      ok({
        steps: [
          step('a', { anticipatedFiles: [{ path: 'src/a.ts' }] }),
          step('b', { anticipatedFiles: [{ path: 'src/b.ts' }] }),
        ],
      }),
    );
    expect(shape(waves)).toEqual([['a', 'b']]);
  });

  it('holds a dependent step back until its predecessor has finished', () => {
    const waves = planWaves(ok({ steps: [step('a'), step('b', { dependsOn: ['a'] }), step('c')] }));
    // c is independent, so it rides with a; b waits for a.
    expect(shape(waves)).toEqual([['a', 'c'], ['b']]);
  });

  // The declaration that drives predictive locking is the one that decides this — two steps that
  // both mean to edit a file are not two things to do at once, whatever their dependencies say.
  it('separates steps whose declared files overlap, even with no dependency between them', () => {
    const waves = planWaves(
      ok({
        steps: [
          step('a', { anticipatedFiles: [{ path: 'src/shared.ts' }, { path: 'src/a.ts' }] }),
          step('b', { anticipatedFiles: [{ path: 'src/shared.ts' }] }),
        ],
      }),
    );
    expect(shape(waves)).toEqual([['a'], ['b']]);
  });

  // A decomposition must not outrun the machine. Steps that do not fit fall to the next wave —
  // a slower schedule, never a smaller plan.
  it('caps a wave without dropping anything', () => {
    const waves = planWaves(ok({ steps: [step('a'), step('b'), step('c')] }), 2);
    expect(shape(waves)).toEqual([['a', 'b'], ['c']]);
  });

  // A caller asking for no concurrency is answered the way it asked rather than looped over.
  it('degrades to one step per wave at a limit of one, or of zero', () => {
    const steps = ok({ steps: [step('a'), step('b')] });
    expect(shape(planWaves(steps, 1))).toEqual([['a'], ['b']]);
    expect(shape(planWaves(steps, 0))).toEqual([['a'], ['b']]);
  });

  it('has no waves for no steps', () => {
    expect(planWaves([])).toEqual([]);
  });

  // Every step appears exactly once, whatever the shape — the property that makes a schedule a
  // schedule rather than a filter.
  it('schedules every step exactly once', () => {
    const steps = ok({
      steps: [
        step('a', { anticipatedFiles: [{ path: 'x.ts' }] }),
        step('b', { dependsOn: ['a'] }),
        step('c', { anticipatedFiles: [{ path: 'x.ts' }] }),
        step('d', { dependsOn: ['b', 'c'] }),
      ],
    });
    const flat = planWaves(steps, 2)
      .flat()
      .map((s) => s.id);
    expect(flat.sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});

// RUN-170. Wave children are STEPS of one run, not runs of their own: a child workspace id embeds
// its parent's run id so ownership is recoverable with no external registry — the same rule that
// lets reapOrphans reconstruct run ids from branch names.
describe('a wave child’s workspace identity', () => {
  it('rides the parent run id, recoverably', () => {
    const id = stepWorkspaceId('run_1', 's2-steering');
    expect(id).toBe('run_1--s2-steering');
    expect(owningRunId(id)).toBe('run_1');
  });

  // The id reaches git refs and worktree directory names, and a step id is a planner's free text.
  // `.` is excluded because `..` is invalid inside a ref component.
  it('narrows a free-text step id to ref-safe characters', () => {
    expect(stepWorkspaceId('run_1', 'fix auth (v2)…')).toBe('run_1--fix-auth-v2-');
    expect(stepWorkspaceId('run_1', 'a..b')).toBe('run_1--a-b');
  });

  it('answers a plain run id with itself — the sweep asks about every workspace', () => {
    expect(owningRunId('run_ms6w066e')).toBe('run_ms6w066e');
  });

  // A step id containing the separator still resolves to the parent: the FIRST separator wins,
  // because a real run id is server-minted and never contains one.
  it('finds the parent past a separator inside the step id itself', () => {
    expect(owningRunId(stepWorkspaceId('run_1', 'a--b'))).toBe('run_1');
  });
});

describe('what the builder is told', () => {
  it('states that the ORDER is the instruction, not a summary of the work', () => {
    const out = renderSteps(checkSteps(spec({ steps: [step('a'), step('b')] })));
    expect(out).toMatch(/THIS WORK IS A SEQUENCE/);
    // Without this a list of steps is read as a description and done in whatever order was
    // convenient — which is what would have happened anyway.
    expect(out).toMatch(/the order is the instruction, not a summary/);
    expect(out).toMatch(/1\. \[a\] do a/);
    expect(out).toMatch(/2\. \[b\] do b/);
  });

  it('carries each step’s own files and truths, since that is what makes it a step', () => {
    const out = renderSteps(
      checkSteps(
        spec({
          steps: [
            step('a', {
              anticipatedFiles: [{ path: 'src/a.ts', change: 'create' }],
              acceptance: { observableTruths: ['the seam exists'] },
            }),
            step('b'),
          ],
        }),
      ),
    );
    expect(out).toContain('files: src/a.ts (create)');
    expect(out).toContain('done when: the seam exists');
  });

  // A plan that turns out to be wrong once you are in the code is a fact worth having, and an
  // agent that silently reshapes it leaves nobody able to tell that it did.
  it('asks the builder to say so rather than silently reshape the plan', () => {
    const out = renderSteps(checkSteps(spec({ steps: [step('a'), step('b')] })));
    expect(out).toMatch(/say so and why rather than silently reshaping the plan/);
  });

  it('renders nothing for a run with no decomposition', () => {
    expect(renderSteps({ steps: [], findings: [] })).toBe('');
  });
});
