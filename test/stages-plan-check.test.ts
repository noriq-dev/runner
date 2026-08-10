import { ExecutionSpec, type ExecutionSpecInput } from '@noriq-dev/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDriver, DriverExit, DriverStartOptions } from '../src/drivers/types';
import { zeroTelemetry } from '../src/drivers/types';
import type { CheckedExecutionSpec } from '../src/execution-spec';
import { type PlanCheckHost, checkPlan } from '../src/stages/plan-check';

// RUN-141. A fresh read-only actor judges the SPEC, not the diff — the phase's payoff, because an
// error caught here costs a paragraph and the same error caught after the build costs the build.
// What it must never do is gate the run: two advisors disagreeing about work neither has done is
// not a reason to refuse the work.

const checked = (over: ExecutionSpecInput = {}): CheckedExecutionSpec => ({
  spec: ExecutionSpec.parse(over),
  findings: [],
});

/** A driver that answers each spawn with the next scripted verdict. */
const checkerSaying = (...answers: string[]): AgentDriver & { spawns: number } => {
  const d = {
    spawns: 0,
    tool: 'claude' as const,
    capabilities: {
      toolHooks: true,
      steer: true,
      interrupt: true,
      resumableSession: true,
      perModelTelemetry: true,
    },
    catalog: { models: [], efforts: [] },
    start: (opts: DriverStartOptions) => {
      const text = answers[d.spawns] ?? answers.at(-1) ?? '';
      d.spawns += 1;
      const exit: DriverExit = { outcome: 'done', isError: false, reason: null, telemetry: zeroTelemetry() };
      queueMicrotask(() => {
        opts.handlers?.onText?.(text);
        opts.handlers?.onExit?.(exit);
      });
      return {
        runId: opts.runId,
        pushInput: () => true,
        interrupt: async () => {},
        stop: async () => {},
        done: async () => exit,
      };
    },
  };
  return d;
};

const host = (
  over: Partial<PlanCheckHost> = {},
): PlanCheckHost & { milestones: string[]; revisions: string[] } => {
  const milestones: string[] = [];
  const revisions: string[] = [];
  return {
    milestones,
    revisions,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    report: vi.fn(),
    transcript: () => ({ milestone: (m: string) => milestones.push(m), text: vi.fn() }) as never,
    startAgent: (driver, opts) => {
      const session = driver.start(opts);
      return { session, done: session.done(), stop: async () => session.stop() };
    },
    revise: async (feedback) => {
      revisions.push(feedback);
      return {
        checked: checked({ discretion: [`revised ${revisions.length}`] }),
        text: 'FINDING 1: CONTESTED src/a.ts:12 — the criterion is checkable there',
      };
    },
    reserve: () => ({ ok: true }),
    guards: () => ({}),
    record: vi.fn(),
    charge: vi.fn(),
    ...over,
  };
};

const input = (driver: AgentDriver, maxRounds = 2) =>
  ({
    run: { id: 'run_1', projectId: 'prj_1' },
    driver,
    checked: checked({ requirementIds: ['R-1'] }),
    prompt: (_spec: unknown, ledger: string) => `check this. LEDGER:${ledger}`,
    start: { runId: 'run_1', kind: 'build', cwd: '/wt', permission: { write: false } },
    maxRounds,
  }) as never;

describe('a plan that passes', () => {
  it('costs one round and hands the plan on unchanged', async () => {
    const d = checkerSaying('Looks coherent.\nVERDICT: PASS');
    const h = host();
    const r = await checkPlan(h, input(d));
    expect(r.verdict).toBe('pass');
    expect(d.spawns).toBe(1);
    expect(h.revisions).toHaveLength(0);
    expect(r.checked.spec.requirementIds).toEqual(['R-1']);
    // A pass carries no findings forward — minor notes are worth writing down and not worth
    // putting in front of the builder as if they were problems.
    expect(r.findings).toBe('');
  });

  // RUN-242: the round's wall-clock stretch is timed against an injectable monotonic clock rather
  // than Date.now(), so the charged figure is exact and provable without a real timer.
  it('charges the exact elapsed time from an injected clock', async () => {
    const readings = [2_000, 5_250]; // 3250ms elapsed
    const h = host({ clock: () => readings.shift() ?? 5_250 });
    await checkPlan(h, input(checkerSaying('Looks coherent.\nVERDICT: PASS')));
    expect(h.charge).toHaveBeenCalledWith(3.25);
  });
});

describe('a plan that fails', () => {
  it('revises through the planner and re-checks, taking the revision when it clears', async () => {
    const d = checkerSaying('FINDING 1 [blocking] acceptance: vague\n\nVERDICT: FAIL', 'VERDICT: PASS');
    const h = host();
    const r = await checkPlan(h, input(d));
    expect(d.spawns).toBe(2);
    expect(h.revisions).toHaveLength(1);
    expect(h.revisions[0]).toContain('vague');
    expect(r.verdict).toBe('pass');
    expect(r.checked.spec.discretion).toEqual(['revised 1']); // the revised plan, not the original
  });

  // The whole point of bounding it: a loop between two models with no ceiling is a budget.
  it('stops at maxRounds and hands the builder the plan WITH the findings', async () => {
    const d = checkerSaying('FINDING 1 [blocking] scope: too big\n\nVERDICT: FAIL');
    const h = host();
    const r = await checkPlan(h, input(d, 2));
    expect(h.revisions).toHaveLength(2);
    expect(d.spawns).toBe(3); // the first look plus one per revision
    expect(r.verdict).toBe('fail');
    expect(r.findings).toContain('too big');
    expect(h.milestones.join(' ')).toMatch(/did not clear its checker/);
  });

  it('never revises when maxRounds is 0 — a pure gate that only reports', async () => {
    const d = checkerSaying('FINDING 1 [blocking] scope: too big\n\nVERDICT: FAIL');
    const h = host();
    const r = await checkPlan(h, input(d, 0));
    expect(d.spawns).toBe(1);
    expect(h.revisions).toHaveLength(0);
    expect(r.findings).toContain('too big');
  });
});

// `unknown` means the checker produced NO JUDGEMENT — killed, crashed, or it never wrote a VERDICT
// line. Spending a planning round answering a non-report is the mistake RUN-72 caught downstream.
describe('a checker that did not judge', () => {
  it('does not revise against a non-report', async () => {
    const d = checkerSaying('I had a look and I am not sure.');
    const h = host();
    const r = await checkPlan(h, input(d));
    expect(r.verdict).toBe('unknown');
    expect(h.revisions).toHaveLength(0);
  });

  it('returns the plan untouched when there is no budget to check it', async () => {
    const d = checkerSaying('VERDICT: FAIL');
    const h = host({ reserve: () => ({ ok: false, breach: 'budget:tokens' }) });
    const r = await checkPlan(h, input(d));
    expect(d.spawns).toBe(0);
    expect(r.verdict).toBe('unknown');
    expect(r.checked.spec.requirementIds).toEqual(['R-1']);
  });

  it('keeps the plan as it was when the planner cannot revise', async () => {
    const d = checkerSaying('FINDING 1 [blocking] x: y\n\nVERDICT: FAIL');
    const h = host({ revise: async () => null });
    const r = await checkPlan(h, input(d));
    expect(r.checked.spec.requirementIds).toEqual(['R-1']); // the original, not a lost revision
    expect(r.verdict).toBe('fail');
  });
});

// Total amnesia between rounds is what let a reviewer re-raise a point the other side had already
// answered (RUN-56/59). A planner that cannot make a settled point stay settled keeps paying.
describe('the adjudication ledger across rounds', () => {
  it('carries earlier findings into the next checker’s prompt', async () => {
    const prompts: string[] = [];
    const d = checkerSaying('FINDING 1 [blocking] acceptance: vague\n\nVERDICT: FAIL', 'VERDICT: PASS');
    const h = host();
    const i = input(d) as { prompt: (s: unknown, l: string) => string };
    i.prompt = (_s, ledger) => {
      prompts.push(ledger);
      return 'check';
    };
    const r = await checkPlan(h, i as never);
    expect(prompts[0]).toBe(''); // nothing settled yet on the first look
    expect(prompts[1]).toContain('vague'); // …and the second knows what round 1 raised
    expect(r.ledger).toHaveLength(1);
  });

  it('does not duplicate a finding the checker raised twice', async () => {
    const d = checkerSaying('FINDING 1 [blocking] acceptance: vague\n\nVERDICT: FAIL');
    const r = await checkPlan(host(), input(d, 2));
    expect(r.ledger).toHaveLength(1);
    expect(r.ledger[0]?.round).toBe(2); // the round that most recently raised it
  });

  // The half that makes a point SETTLED rather than merely raised. A ledger carrying the
  // accusation without the answer is the shape that let a reviewer re-raise a finding the other
  // side had already answered with evidence (RUN-59).
  it('records the planner’s answer, not just the checker’s claim', async () => {
    const d = checkerSaying('FINDING 1 [blocking] acceptance: vague\n\nVERDICT: FAIL', 'VERDICT: PASS');
    const r = await checkPlan(host(), input(d));
    expect(r.ledger[0]?.status).toBe('contested');
    expect(r.ledger[0]?.pointer).toBe('src/a.ts:12');
  });

  it('records `unanswered` when the planner fixed it silently, rather than inventing agreement', async () => {
    const d = checkerSaying('FINDING 1 [blocking] acceptance: vague\n\nVERDICT: FAIL', 'VERDICT: PASS');
    const h = host({ revise: async () => ({ checked: checked({ discretion: ['fixed'] }), text: 'done.' }) });
    const r = await checkPlan(h, input(d));
    expect(r.ledger[0]?.status).toBe('unanswered');
  });
});
