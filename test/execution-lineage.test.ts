import type { Run } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import { ExecutionLifecycle, resolveRunLineage } from '../src/execution-lineage';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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
    expect(resolveRunLineage(run({ id: 'run_retry' }), lifecycle.registry())).toEqual({
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
    expect(resolveRunLineage(run({ id: 'run_retry' }), lifecycle.registry()).ok).toBe(true);
  });

  it('keeps an active cancellation reserved until its supervising stack completes', async () => {
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
    // park releases immediately; an active process must retain ownership until completion.
    lifecycle.begin(run({ id: 'run_parked' }));
    await lifecycle.terminalizePark('run_parked');
    expect(resolveRunLineage(run({ id: 'run_retry' }), lifecycle.registry())).toEqual({
      ok: false,
      reason: 'execution exe_1 is already bound to live run run_parked',
    });
    expect(await lifecycle.park({ run: run({ id: 'run_parked' }) })).toBe(false);
    await lifecycle.complete('run_parked');
    expect(resolveRunLineage(run({ id: 'run_retry' }), lifecycle.registry()).ok).toBe(true);
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
    expect(await parking).toBe(false);
    await terminalizing;
    expect(lifecycle.registry()).toEqual(new Map());
  });
});

describe('ExecutionLifecycle terminal ownership (RUN-294)', () => {
  it('joins durable deletion before a terminal completion releases its bookkeeping', async () => {
    const parked = { run: run({ id: 'run_parked' }) };
    const deletion = deferred<typeof parked | null>();
    let deletes = 0;
    const lifecycle = new ExecutionLifecycle({
      park: async () => {},
      list: async () => [parked],
      unpark: () => {
        deletes += 1;
        return deletion.promise;
      },
    });
    await lifecycle.restore();

    const completing = lifecycle.complete('run_parked');
    expect(lifecycle.registry()).toEqual(new Map()); // logical terminality is immediate
    await turn();
    expect(deletes).toBe(1); // completion remains at the lifecycle boundary until deletion settles

    deletion.resolve(parked);
    await completing;
    expect(await lifecycle.park(parked)).toBe(true); // successful cleanup released the tombstone
  });

  it('retains suppression and surfaces a rejected terminal cleanup', async () => {
    const parked = { run: run({ id: 'run_parked' }) };
    const errors: unknown[] = [];
    const lifecycle = new ExecutionLifecycle(
      {
        park: async () => {},
        list: async () => [parked],
        unpark: async () => {
          throw new Error('disk offline');
        },
      },
      (_runId, err) => errors.push(err),
    );
    await lifecycle.restore();

    await lifecycle.complete('run_parked');
    expect(errors.map(String)).toEqual(['Error: disk offline']);
    expect(lifecycle.registry()).toEqual(new Map());
    expect(await lifecycle.park(parked)).toBe(false); // failed cleanup did not forget terminality
  });

  it('projects a resuming park as owned before its durable delete yields', async () => {
    const parked = { run: run({ id: 'run_parked' }) };
    const deletion = deferred<typeof parked | null>();
    const lifecycle = new ExecutionLifecycle({
      park: async () => {},
      list: async () => [parked],
      unpark: () => deletion.promise,
    });
    await lifecycle.restore();

    const resuming = lifecycle.resume('run_parked');
    await Promise.resolve();
    expect(lifecycle.registry()).toEqual(new Map([['exe_1', 'run_parked']]));
    deletion.resolve(parked);
    expect(await resuming).toEqual(parked);
    expect(lifecycle.registry()).toEqual(new Map([['exe_1', 'run_parked']]));
  });

  it('lets terminalization win while a resume delete is in flight without leaking a tombstone', async () => {
    const parked = { run: run({ id: 'run_parked' }) };
    const deletion = deferred<typeof parked | null>();
    let deletes = 0;
    const lifecycle = new ExecutionLifecycle({
      park: async () => {},
      list: async () => [parked],
      unpark: () => {
        deletes += 1;
        return deletes === 1 ? deletion.promise : Promise.resolve(null);
      },
    });
    await lifecycle.restore();

    const resuming = lifecycle.resume('run_parked');
    await Promise.resolve();
    const terminalizing = lifecycle.terminalizePark('run_parked');
    deletion.resolve(parked);

    expect(await resuming).toBeNull();
    await terminalizing;
    expect(lifecycle.registry()).toEqual(new Map());
    expect(await lifecycle.park(parked)).toBe(true);
  });

  it('joins terminal cleanup after a thrown resume delete, so a retry is not poisoned', async () => {
    const parked = { run: run({ id: 'run_parked' }) };
    const errors: unknown[] = [];
    let deletes = 0;
    const lifecycle = new ExecutionLifecycle(
      {
        park: async () => {},
        list: async () => [parked],
        unpark: async () => {
          deletes += 1;
          if (deletes === 1) throw new Error('rename failed');
          return parked;
        },
      },
      (_runId, err) => errors.push(err),
    );
    await lifecycle.restore();

    await expect(lifecycle.resume('run_parked')).rejects.toThrow('rename failed');
    expect(lifecycle.registry()).toEqual(new Map([['exe_1', 'run_parked']]));
    await lifecycle.complete('run_parked');
    expect(lifecycle.registry()).toEqual(new Map());
    expect(errors).toEqual([]);
    expect(await lifecycle.park(parked)).toBe(true);
  });

  it('uses recovery classification before admission: terminal releases, blocked and unknown fail closed', async () => {
    const parked = { run: run({ id: 'run_parked' }) };
    const lifecycle = (disposition: 'terminal' | 'parked' | 'unknown') => {
      const owner = new ExecutionLifecycle({
        park: async () => {},
        list: async () => [parked],
        unpark: async () => parked,
      });
      return { owner, disposition };
    };

    const terminal = lifecycle('terminal');
    await terminal.owner.restore(async () => terminal.disposition);
    expect(resolveRunLineage(run({ id: 'run_retry' }), terminal.owner.registry()).ok).toBe(true);

    for (const disposition of ['parked', 'unknown'] as const) {
      const retained = lifecycle(disposition);
      await retained.owner.restore(async () => retained.disposition);
      expect(resolveRunLineage(run({ id: 'run_retry' }), retained.owner.registry())).toEqual({
        ok: false,
        reason: 'execution exe_1 is already bound to live run run_parked',
      });
    }
  });
});
