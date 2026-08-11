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
      park: async (park) => {
        parks.set(park.run.id, park);
      },
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
      park: async (park) => {
        parks.set(park.run.id, park);
      },
      list: async () => [...parks.values()],
      unpark: async (runId) => {
        const park = parks.get(runId) ?? null;
        parks.delete(runId);
        return park;
      },
    });

    await lifecycle.terminalizePark('run_parked');
    expect(resolveRunLineage(run({ id: 'run_retry' }), await lifecycle.registry()).ok).toBe(true);
  });

  it('makes a terminal signal win over a late park after its server-state probe', async () => {
    const parks = new Map<string, { run: Pick<Run, 'id' | 'execution'> }>();
    const lifecycle = new ExecutionLifecycle({
      park: async (park) => {
        parks.set(park.run.id, park);
      },
      list: async () => [...parks.values()],
      unpark: async (runId) => {
        const park = parks.get(runId) ?? null;
        parks.delete(runId);
        return park;
      },
    });

    // The park-state probe belongs to a still-active supervisor. A directly cancelled detached
    // park clears its tombstone immediately; this in-flight probe must keep it until completion.
    lifecycle.begin(run({ id: 'run_parked' }));
    await lifecycle.terminalizePark('run_parked');
    expect(await lifecycle.park({ run: run({ id: 'run_parked' }) })).toBe(false);
    lifecycle.complete('run_parked');
    expect(await lifecycle.registry()).toEqual(new Map());
  });

  it('serializes terminalization behind an already-writing park and removes it before releasing ownership', async () => {
    const parks = new Map<string, { run: Pick<Run, 'id' | 'execution'> }>();
    let releaseWrite!: () => void;
    let writing!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      writing = resolve;
    });
    const lifecycle = new ExecutionLifecycle({
      park: async (park) => {
        writing();
        await new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
        parks.set(park.run.id, park);
      },
      list: async () => [...parks.values()],
      unpark: async (runId) => {
        const park = parks.get(runId) ?? null;
        parks.delete(runId);
        return park;
      },
    });

    const parking = lifecycle.park({ run: run({ id: 'run_parked' }) });
    await writeStarted;
    const terminalizing = lifecycle.terminalizePark('run_parked');
    releaseWrite();
    expect(await parking).toBe(true);
    await terminalizing;
    expect(await lifecycle.registry()).toEqual(new Map());
  });
});
