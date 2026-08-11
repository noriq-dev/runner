import type { Run } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import { ExecutionLifecycle, resolveRunLineage } from '../src/execution-lineage';

const run = (over: Partial<Run> = {}): Pick<Run, 'id' | 'execution'> => ({
  id: 'run_1',
  execution: {
    schemaVersion: 1,
    orchestrationId: 'orc_1',
    executionId: 'exe_1',
    parentExecutionId: null,
    role: 'worker',
    lineageStatus: 'complete',
  },
  ...over,
});

describe('resolveRunLineage', () => {
  it('retains every shared assignment field after parsing it', () => {
    const result = resolveRunLineage(run(), new Map());
    expect(result).toEqual({
      ok: true,
      lineage: {
        type: 'assigned',
        assignment: {
          schemaVersion: 1,
          orchestrationId: 'orc_1',
          executionId: 'exe_1',
          parentExecutionId: null,
          role: 'worker',
          lineageStatus: 'complete',
        },
      },
    });
  });

  it('makes an explicit legacy root when an older server supplied no assignment', () => {
    expect(resolveRunLineage(run({ execution: null }), new Map())).toEqual({
      ok: true,
      lineage: { type: 'legacy-root', assignment: null },
    });
  });

  it('refuses an assignment outside the shared contract version and role vocabulary', () => {
    const result = resolveRunLineage(
      run({ execution: { ...run().execution!, schemaVersion: 2, role: 'unscoped' } as never }),
      new Map(),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/execution assignment is malformed/);
  });

  it('refuses a self-parenting execution', () => {
    const result = resolveRunLineage(
      run({ execution: { ...run().execution!, parentExecutionId: 'exe_1' } }),
      new Map(),
    );
    expect(result).toEqual({ ok: false, reason: 'execution assignment names itself as its parent' });
  });

  it('refuses an execution already bound to another live run', () => {
    const result = resolveRunLineage(run(), new Map([['exe_1', 'run_live']]));
    expect(result).toEqual({ ok: false, reason: 'execution exe_1 is already bound to live run run_live' });
  });

  it('reconstructs a persisted park as an owner before a restarted daemon accepts a retry', async () => {
    const parks = new Map([['run_parked', { run: run({ id: 'run_parked' }) }]]);
    const lifecycle = new ExecutionLifecycle({
      list: async () => [...parks.values()],
      unpark: async (runId) => {
        const park = parks.get(runId) ?? null;
        parks.delete(runId);
        return park;
      },
    });

    await lifecycle.restore();
    expect(resolveRunLineage(run({ id: 'run_retry' }), await lifecycle.registry())).toEqual({
      ok: false,
      reason: 'execution exe_1 is already bound to live run run_parked',
    });
  });

  it('drops a directly cancelled park from the derived registry immediately', async () => {
    const parks = new Map([['run_parked', { run: run({ id: 'run_parked' }) }]]);
    const lifecycle = new ExecutionLifecycle({
      list: async () => [...parks.values()],
      unpark: async (runId) => {
        const park = parks.get(runId) ?? null;
        parks.delete(runId);
        return park;
      },
    });

    await lifecycle.discardPark('run_parked');
    expect(resolveRunLineage(run({ id: 'run_retry' }), await lifecycle.registry()).ok).toBe(true);
  });
});
