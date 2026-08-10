import { ExecutionSpec, type ExecutionSpecInput } from '@noriq-dev/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDriver, DriverExit, DriverStartOptions } from '../src/drivers/types';
import { zeroTelemetry } from '../src/drivers/types';
import { type PlanHost, parsePlannedSpec, planRun } from '../src/stages/plan';

// RUN-140. A fresh read-only agent writes the spec the builder will be handed. It cannot gate the
// run: every failure path here has to leave the run exactly as it would have been without the
// stage — unplanned, which is how a task with no spec has always worked.

const spec = (over: ExecutionSpecInput = {}) => ExecutionSpec.parse(over);

/** A driver whose one session emits the given text and finishes. */
const driverSaying = (text: string, outcome: DriverExit['outcome'] = 'done'): AgentDriver => ({
  tool: 'claude',
  capabilities: {
    toolHooks: true,
    steer: true,
    interrupt: true,
    resumableSession: true,
    perModelTelemetry: true,
  },
  catalog: { models: [], efforts: [] },
  start: (opts: DriverStartOptions) => {
    const exit: DriverExit = {
      outcome,
      isError: outcome !== 'done',
      reason: outcome === 'done' ? null : 'failed',
      telemetry: { ...zeroTelemetry(), outputTokens: 10 },
    };
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
      // The planner is multiTurn now (RUN-141) — the checker revises through this session.
      continueWith: async () => exit,
    };
  },
});

const tally = () => {
  const slots = new Map<string, unknown>();
  return {
    record: (slot: string, t: unknown) => slots.set(slot, t),
    chargeTime: vi.fn(),
    total: () => zeroTelemetry(),
    slots,
  };
};

const host = (over: Partial<PlanHost> = {}): PlanHost & { saved: unknown[]; milestones: string[] } => {
  const saved: unknown[] = [];
  const milestones: string[] = [];
  return {
    saved,
    milestones,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    report: vi.fn(),
    transcript: () => ({ milestone: (m: string) => milestones.push(m), text: vi.fn() }) as never,
    startAgent: (driver, opts) => {
      const session = driver.start(opts);
      return { session, done: session.done(), stop: async () => session.stop() };
    },
    checkSpec: async (s) => ({ spec: s, findings: [] }),
    saveSpec: async (_p, _t, s) => {
      saved.push(s);
      return true;
    },
    ...over,
  };
};

const input = (driver: AgentDriver) =>
  ({
    run: { id: 'run_1', projectId: 'prj_1', anchor: { type: 'task', taskId: 'task_1' } },
    repo: {},
    worktree: { localPath: '/wt' },
    driver,
    runAgent: { agentId: 'agt_1', label: 'a', token: 't' },
    tally: tally(),
    prompt: 'plan it',
    start: { runId: 'run_1', kind: 'build', cwd: '/wt', permission: { write: false } },
  }) as never;

describe('pulling a spec out of a planner’s answer', () => {
  it('reads a fenced json block', () => {
    const s = parsePlannedSpec('Here is the plan.\n\n```json\n{"requirementIds":["R-1"]}\n```\n');
    expect(s?.requirementIds).toEqual(['R-1']);
  });

  // A model that thinks aloud shows a draft and then a corrected final answer. The first block is
  // the draft; taking it would act on the version the planner itself rejected.
  it('takes the LAST block when a planner showed its working', () => {
    const s = parsePlannedSpec(
      '```json\n{"requirementIds":["DRAFT"]}\n```\nOn reflection:\n```json\n{"requirementIds":["FINAL"]}\n```',
    );
    expect(s?.requirementIds).toEqual(['FINAL']);
  });

  it('accepts a bare object — punctuation is not worth throwing an answer away over', () => {
    expect(parsePlannedSpec('{"discretion":["naming"]}')?.discretion).toEqual(['naming']);
  });

  it('falls back to an earlier block when the last one is not JSON', () => {
    const s = parsePlannedSpec('```json\n{"requirementIds":["GOOD"]}\n```\n```json\nnot json\n```');
    expect(s?.requirementIds).toEqual(['GOOD']);
  });

  it('returns null for prose, which is an unplanned run and not an error', () => {
    expect(parsePlannedSpec('I could not work out what this task wants.')).toBeNull();
  });

  // A planner naming a path that leaves the repo has written something the contract refuses, and
  // the answer to that is an unplanned run — never a thrown stage.
  it('refuses a spec the contract rejects rather than throwing', () => {
    expect(parsePlannedSpec('```json\n{"anticipatedFiles":[{"path":"../../.ssh/id_rsa"}]}\n```')).toBeNull();
  });
});

describe('a spec that did not parse gets ONE repair turn (RUN-197)', () => {
  // The live failure: a planner streamed a complete spec, ended its turn mid-JSON, and the run
  // proceeded unplanned with the whole plan one `continueWith` away from an already-open session.
  it('feeds the failure back through the open session and takes the re-emission', async () => {
    let repairPrompt = '';
    const base = driverSaying('unused');
    const drv: AgentDriver = {
      ...base,
      start: (opts: DriverStartOptions) => {
        const exit: DriverExit = {
          outcome: 'done',
          isError: false,
          reason: null,
          telemetry: zeroTelemetry(),
        };
        queueMicrotask(() => {
          opts.handlers?.onText?.('```json\n{"requirementIds":["R1"], "anticipatedFiles": ['); // cut mid-stream
          opts.handlers?.onExit?.(exit);
        });
        return {
          runId: opts.runId,
          pushInput: () => true,
          interrupt: async () => {},
          stop: async () => {},
          done: async () => exit,
          continueWith: async (feedback: string) => {
            repairPrompt = feedback;
            opts.handlers?.onText?.('\n```json\n{"requirementIds":["R1"]}\n```');
            return exit;
          },
        };
      },
    };
    const h = host();
    const planned = await planRun(h, input(drv));
    expect(planned).not.toBeNull();
    expect(planned!.checked.spec.requirementIds).toEqual(['R1']);
    expect(repairPrompt).toContain('could not be read'); // the exact failure rides the turn
    expect(h.milestones.some((m) => m.includes('asking the planner to re-emit'))).toBe(true);
    await planned!.close(planned!.checked);
  });

  it('a repair that also fails leaves the run exactly as unplanned as before', async () => {
    const h = host();
    // driverSaying's continueWith returns done with NO new text — the repair yields nothing.
    const planned = await planRun(h, input(driverSaying('nothing like json here')));
    expect(planned).toBeNull();
  });
});

describe('the plan stage', () => {
  it('plans, checks the result, and writes it back to the task', async () => {
    const h = host();
    const out = await planRun(h, input(driverSaying('```json\n{"requirementIds":["RUN-140"]}\n```')));
    expect(out?.checked.spec.requirementIds).toEqual(['RUN-140']);
    if (out) await out.close(out.checked); // the write-back happens when the session closes

    expect(h.saved).toHaveLength(1);
    expect((h.saved[0] as { requirementIds: string[] }).requirementIds).toEqual(['RUN-140']);
  });

  // Every one of these leaves the run exactly as it would have been without the stage.
  it('returns null when the planner does not finish', async () => {
    const h = host();
    expect(await planRun(h, input(driverSaying('```json\n{}\n```', 'failed')))).toBeNull();
    expect(h.saved).toHaveLength(0);
    expect(h.milestones.join(' ')).toMatch(/proceeding unplanned/);
  });

  it('returns null when the answer holds no usable spec', async () => {
    const h = host();
    expect(await planRun(h, input(driverSaying('I had a think and decided not to.')))).toBeNull();
    expect(h.saved).toHaveLength(0);
  });

  // The save is what makes the plan an artifact rather than a thought — but a save that fails
  // costs reusability, never this run, which already holds the spec.
  it('still returns the spec when writing it back fails', async () => {
    const h = host({
      saveSpec: async () => {
        throw new Error('server down');
      },
    });
    const out = await planRun(h, input(driverSaying('```json\n{"discretion":["x"]}\n```')));
    if (out) await out.close(out.checked);
    expect(out?.checked.spec.discretion).toEqual(['x']);
  });

  it('runs without a save hook at all — the spec is simply not persisted', async () => {
    const h = host({ saveSpec: undefined });
    const out = await planRun(h, input(driverSaying('```json\n{"discretion":["x"]}\n```')));
    if (out) await out.close(out.checked);
    expect(out?.checked.spec.discretion).toEqual(['x']);
  });

  // The planner's spend is its own slot, so the run's total shows what planning cost rather than
  // folding it into the builder's (RUN-59's per-slot ledger).
  it('bills planning to its own slot', async () => {
    const h = host();
    const i = input(driverSaying('```json\n{}\n```')) as { tally: ReturnType<typeof tally> };
    const planned = await planRun(h, i as never);
    if (planned) await planned.close(planned.checked);
    expect(i.tally.slots.has('plan')).toBe(true);
    expect(i.tally.chargeTime).toHaveBeenCalled();
  });

  // RUN-242: chargeTime used to be a `Date.now()` difference, which a wall-clock step can send
  // negative — `IntelligenceDurationMs`'s own schema would reject that. The clock is now injected
  // and monotonic, so the charged figure is exact and provable without a real timer.
  it('charges the exact elapsed time from an injected clock, never a wall-clock reading', async () => {
    const readings = [1_000, 4_800]; // 3800ms elapsed
    const h = host({ clock: () => readings.shift() ?? 4_800 });
    const i = input(driverSaying('```json\n{}\n```')) as { tally: ReturnType<typeof tally> };
    const planned = await planRun(h, i as never);
    if (planned) await planned.close(planned.checked);
    expect(i.tally.chargeTime).toHaveBeenCalledWith(3.8);
  });

  // The planner wrote these paths from what it read, so a `modify` naming a file that is not there
  // means it guessed — and the builder is told, in the same shape a delivered spec's findings take.
  it('carries the check’s findings through to the builder', async () => {
    const h = host({
      checkSpec: async (s) => ({
        spec: s,
        findings: [{ level: 'problem', where: 'anticipatedFiles[0]', message: 'gone' }],
      }),
    });
    const out = await planRun(h, input(driverSaying('```json\n{"requirementIds":["R"]}\n```')));
    if (out) await out.close(out.checked);
    expect(out?.checked.findings).toHaveLength(1);
    expect(h.milestones.join(' ')).toMatch(/disagreeing with the checkout/);
  });

  it('closes the session even when the planner answered nothing useful', async () => {
    const stops: string[] = [];
    const driver = driverSaying('nothing');
    const wrapped: AgentDriver = {
      ...driver,
      start: (opts) => {
        const s = driver.start(opts);
        return { ...s, stop: async () => void stops.push('stopped') };
      },
    };
    const p2 = await planRun(host(), input(wrapped));
    if (p2) await p2.close(p2.checked);
    expect(stops).toEqual(['stopped']);
  });
});

describe('what the spec parser will not accept', () => {
  it('does not treat an empty planner answer as a spec', () => {
    expect(parsePlannedSpec('')).toBeNull();
    expect(parsePlannedSpec('```json\n\n```')).toBeNull();
  });

  it('parses an empty object into the empty spec, which reads as unplanned downstream', () => {
    const s = parsePlannedSpec('```json\n{}\n```');
    expect(s).toEqual(spec());
  });
});

// A run's ceiling is spent by planning and building both. These are the boundaries that keep the
// stage from costing the run it was meant to help.
describe('what the stage refuses to persist', () => {
  // Storing an empty spec would make every future attempt skip planning: the field is no longer
  // null, so nothing would ever fill it.
  it('does not write an empty planned spec back to the task', async () => {
    const h = host();
    const out = await planRun(h, input(driverSaying('```json\n{}\n```')));
    if (out) await out.close(out.checked);
    expect(out).not.toBeNull(); // this run still gets the (empty) result
    expect(h.saved).toHaveLength(0);
  });

  // A human editing the task mid-plan has said something the planner did not know.
  it('keeps the run’s own spec but reports a declined save', async () => {
    const h = host({ saveSpec: async () => false });
    const out = await planRun(h, input(driverSaying('```json\n{"discretion":["x"]}\n```')));
    if (out) await out.close(out.checked);
    expect(out?.checked.spec.discretion).toEqual(['x']);
    expect(h.milestones.join(' ')).toMatch(/theirs kept, not overwritten/);
  });
});

// The two things the planner must NOT be able to do, asserted where they are decided rather than
// where they are documented. Both were true of the first cut.
describe('the planner’s posture, as it actually reaches the driver', () => {
  it('drops `auto`, which the write clamp deliberately preserves', async () => {
    const { plannerPermission } = await import('../src/supervisor');
    const build = { write: true, allow: [], deny: [], auto: true };
    const p = plannerPermission(build);
    expect(p.write).toBe(false);
    // `auto` survives clampPermissionToWorkflow by design (RUN-68) — and on Claude it means
    // bypass-permissions with unrestricted Bash, in a build's writable worktree.
    expect(p.auto).toBe(false);
  });

  it('keeps the repo’s deny list, which is not the planner’s to relax', async () => {
    const { plannerPermission } = await import('../src/supervisor');
    const p = plannerPermission({
      write: true,
      allow: ['Bash(npm test)'],
      deny: ['Read(.env)'],
      auto: false,
    });
    expect(p.deny).toContain('Read(.env)');
  });
});
