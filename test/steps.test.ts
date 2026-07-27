import { ExecutionSpec, type ExecutionSpecInput } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import { MAX_STEPS, checkSteps, renderSteps } from '../src/steps';

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
