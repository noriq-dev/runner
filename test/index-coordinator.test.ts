import { describe, expect, it, vi } from 'vitest';
import {
  IndexCoordinator,
  type IndexCoordinatorDeps,
  type IndexTarget,
  type IndexWorkStep,
} from '../src/index-coordinator';
import { IndexJournal } from '../src/index-journal';
import type { ResolvedIndexConfig } from '../src/index-policy';
import { INDEXER_VERSION } from '../src/index-reconcile';
import { FakeIndexSource } from '../src/index-source';
import type { RunnerIndexCursor } from '../src/memory-contract';
import type { ChangesBetweenResult, IndexSnapshot, IndexSnapshotResult, VcsBackend } from '../src/vcs/types';

// RUN-214. Every observable truth this suite proves is about LIFECYCLE — coalescing, the
// single-job guard, release, cancellation, priority — provable with a no-op work step, exactly as
// the coordinator's own locked decision 1 says. Nothing here fakes a parser.

const quiet = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Console &
  IndexCoordinatorDeps['logger'];

// A macrotask boundary — not just one microtask — so an `attempt` that hops through several real
// `await`s (resolveConfig → getCursor → changesBetween → leaseIndexSnapshot → runWork) has
// genuinely reached the point under test before the next assertion or trigger fires. Calling
// `trigger()` without awaiting IS synchronous up to the coordinator's own bookkeeping
// (`active.set` happens before the caller's first real await — see the coordinator's doc on why
// two back-to-back `trigger()` calls reliably coalesce), but reaching `runWork` itself takes
// several real microtask hops this cannot skip.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const GEN = (over: Partial<NonNullable<RunnerIndexCursor['activeGeneration']>> = {}) => ({
  id: 'gen_1',
  branch: 'main',
  baseId: 'base-1',
  indexerVersion: INDEXER_VERSION,
  status: 'active' as const,
  batchCount: 3,
  fileCount: 100,
  sealedAt: '2026-08-01T00:00:00.000Z',
  validationProblems: [],
  createdAt: '2026-08-01T00:00:00.000Z',
  activatedAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

const CURSOR = (over: Partial<RunnerIndexCursor> = {}): RunnerIndexCursor => ({
  repositoryKey: 'my-repo',
  defaultBranch: 'main',
  latestObservedBase: 'base-1',
  activeGeneration: GEN(),
  stagedGenerations: [],
  stale: false,
  failedIngest: false,
  failedIngestProblems: [],
  association: { state: 'associated', projectRepositoryId: 'prjrepo_1' },
  ...over,
});

const CONFIG: ResolvedIndexConfig = {
  languages: ['typescript'],
  contentMode: 'full',
  maxFiles: 100,
  maxFileBytes: 1_000_000,
  maxTotalBytes: 10_000_000,
  readDeadlineMs: 60_000,
  pollIntervalMinutes: 60,
  include: [],
  exclude: [],
};

const TARGET = (over: Partial<IndexTarget> = {}): IndexTarget => ({
  server: 'https://noriq.test',
  projectId: 'prj_1',
  repositoryKey: 'my-repo',
  checkoutId: 'repo_a',
  projectKey: 'RUN',
  repoRoot: '/repo/a',
  currentBaseId: 'base-2', // moved from GEN()'s base-1, so the ordinary case is incremental
  ...over,
});

function fakeSnapshot(over: Partial<IndexSnapshot> = {}): IndexSnapshot {
  return { source: new FakeIndexSource([]), baseId: 'base-2', readOnly: true, location: {}, ...over };
}

/** A fake VcsBackend slice with every call recorded, so a test can assert not just outcomes but
 *  which methods were (and were NOT) invoked — the shape `cancellation never aborts staging` and
 *  `busy never leases twice in one attempt` need. */
function fakeVcs(
  opts: {
    lease?: () => IndexSnapshotResult | Promise<IndexSnapshotResult>;
    changesBetween?: () => ChangesBetweenResult | Promise<ChangesBetweenResult>;
  } = {},
) {
  const releaseCalls: IndexSnapshot[] = [];
  const leaseCalls: string[] = [];
  const changesBetweenCalls: Array<[string, string, string]> = [];
  const vcs: Pick<VcsBackend, 'leaseIndexSnapshot' | 'releaseIndexSnapshot' | 'changesBetween'> = {
    leaseIndexSnapshot: vi.fn(async (repoRoot: string): Promise<IndexSnapshotResult> => {
      leaseCalls.push(repoRoot);
      return opts.lease ? opts.lease() : { ok: true, snapshot: fakeSnapshot() };
    }),
    releaseIndexSnapshot: vi.fn(async (snapshot: IndexSnapshot) => {
      releaseCalls.push(snapshot);
    }),
    changesBetween: vi.fn(
      async (repoRoot: string, from: string, to: string): Promise<ChangesBetweenResult> => {
        changesBetweenCalls.push([repoRoot, from, to]);
        return opts.changesBetween ? opts.changesBetween() : { ok: true, changed: [], deleted: [] };
      },
    ),
  };
  return { vcs, releaseCalls, leaseCalls, changesBetweenCalls };
}

function makeDeps(over: Partial<IndexCoordinatorDeps> = {}): {
  deps: IndexCoordinatorDeps;
  getCursorCalls: IndexTarget[];
  runWorkCalls: number;
} {
  const getCursorCalls: IndexTarget[] = [];
  let runWorkCalls = 0;
  const { vcs } = fakeVcs();
  const deps: IndexCoordinatorDeps = {
    vcsFor: () => vcs,
    resolveConfig: async () => CONFIG,
    getCursor: async (target) => {
      getCursorCalls.push(target);
      return CURSOR();
    },
    runWork: async () => {
      runWorkCalls += 1;
    },
    journal: new IndexJournal({ read: async () => ({}), write: async () => {} }),
    isRunBusy: () => false,
    logger: quiet,
    ...over,
  };
  return {
    deps,
    getCursorCalls,
    get runWorkCalls() {
      return runWorkCalls;
    },
  };
}

describe('priority — runs outrank indexing (decision 10)', () => {
  it('starts no job and asks no cursor while the daemon is busy with runs', async () => {
    const { vcs, leaseCalls } = fakeVcs();
    let getCursorCalled = false;
    const coordinator = new IndexCoordinator({
      vcsFor: () => vcs,
      resolveConfig: async () => CONFIG,
      getCursor: async () => {
        getCursorCalled = true;
        return CURSOR();
      },
      runWork: async () => {
        throw new Error('must not be called while runs are busy');
      },
      journal: new IndexJournal({ read: async () => ({}), write: async () => {} }),
      isRunBusy: () => true,
      logger: quiet,
    });
    await coordinator.trigger(TARGET());
    expect(getCursorCalled).toBe(false);
    expect(leaseCalls).toEqual([]);
  });
});

describe('RUN-238: isRunBusy is threaded into the work context, not just checked once at the top', () => {
  it('ctx.isRunBusy passed to runWork is the exact same predicate as deps.isRunBusy', async () => {
    let busy = false;
    const observed: boolean[] = [];
    const { vcs } = fakeVcs();
    const { deps } = makeDeps({
      vcsFor: () => vcs,
      isRunBusy: () => busy,
      runWork: async (ctx) => {
        observed.push(ctx.isRunBusy());
        busy = true; // flip AFTER the first read — proves this is a live predicate, not a snapshot.
        observed.push(ctx.isRunBusy());
      },
    });
    await new IndexCoordinator(deps).trigger(TARGET());
    expect(observed).toEqual([false, true]);
  });
});

describe('manifest resolution gate', () => {
  it('a null resolved config starts nothing, without ever asking for a cursor', async () => {
    const { deps, getCursorCalls } = makeDeps({ resolveConfig: async () => null });
    const coordinator = new IndexCoordinator(deps);
    await coordinator.trigger(TARGET());
    expect(getCursorCalls).toEqual([]);
  });
});

describe('the four non-starting reconcile outcomes lease nothing and start nothing (decision 6)', () => {
  it('unchanged', async () => {
    const { vcs, leaseCalls } = fakeVcs();
    const { deps } = makeDeps({ vcsFor: () => vcs, getCursor: async () => CURSOR() });
    const coordinator = new IndexCoordinator(deps);
    await coordinator.trigger(TARGET({ currentBaseId: 'base-1' })); // matches GEN()'s own base
    expect(leaseCalls).toEqual([]);
  });

  it('unavailable — a null cursor', async () => {
    const { vcs, leaseCalls } = fakeVcs();
    const { deps } = makeDeps({ vcsFor: () => vcs, getCursor: async () => null });
    const coordinator = new IndexCoordinator(deps);
    await coordinator.trigger(TARGET());
    expect(leaseCalls).toEqual([]);
  });

  it('incompatible-version', async () => {
    const { vcs, leaseCalls } = fakeVcs();
    const { deps } = makeDeps({
      vcsFor: () => vcs,
      getCursor: async () => CURSOR({ activeGeneration: GEN({ indexerVersion: '99' }) }),
    });
    const coordinator = new IndexCoordinator(deps);
    await coordinator.trigger(TARGET());
    expect(leaseCalls).toEqual([]);
  });

  it('association-conflict', async () => {
    const { vcs, leaseCalls } = fakeVcs();
    const { deps } = makeDeps({
      vcsFor: () => vcs,
      getCursor: async () =>
        CURSOR({ association: { state: 'conflict', projectRepositoryId: 'other', reason: 'nope' } }),
    });
    const coordinator = new IndexCoordinator(deps);
    await coordinator.trigger(TARGET());
    expect(leaseCalls).toEqual([]);
  });
});

describe('a busy lease defers (decision 9)', () => {
  it('logs no error and does not consume a pending re-run flag', async () => {
    let leaseAttempts = 0;
    const errors: unknown[] = [];
    const log = { ...quiet, error: (...a: unknown[]) => errors.push(a) } as IndexCoordinatorDeps['logger'];
    const { vcs, leaseCalls } = fakeVcs({
      lease: () => {
        leaseAttempts += 1;
        // Busy on the FIRST attempt only — the coalesced re-run (triggered by the pending flag a
        // duplicate trigger sets below) should succeed and actually run work.
        return leaseAttempts === 1 ? { ok: false, reason: 'busy' } : { ok: true, snapshot: fakeSnapshot() };
      },
    });
    let runWorkCalls = 0;
    const { deps } = makeDeps({
      vcsFor: () => vcs,
      runWork: async () => {
        runWorkCalls += 1;
      },
      logger: log,
    });
    const coordinator = new IndexCoordinator(deps);
    // Both calls fire before either awaits: the first claims the active slot synchronously (see
    // the coordinator's doc on why this is safe to rely on), so the second coalesces into pending.
    const p1 = coordinator.trigger(TARGET());
    const p2 = coordinator.trigger(TARGET());
    await Promise.all([p1, p2]);
    expect(leaseCalls.length).toBe(2); // the busy attempt, then the coalesced re-run
    expect(runWorkCalls).toBe(1); // only the SECOND (successful) lease ever reached work
    expect(errors).toEqual([]); // never logged as an error
  });
});

describe('coalescing (decision 3)', () => {
  it('two triggers while a job is active produce one additional run afterwards, not two', async () => {
    let releaseWork: (() => void) | undefined;
    const workGate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    let runWorkCalls = 0;
    const { deps } = makeDeps({
      runWork: async () => {
        runWorkCalls += 1;
        if (runWorkCalls === 1) await workGate; // hold the first job open
      },
    });
    const coordinator = new IndexCoordinator(deps);
    const p1 = coordinator.trigger(TARGET());
    await tick(); // let the first attempt genuinely reach — and block inside — runWork
    expect(runWorkCalls).toBe(1); // the first job is genuinely still open
    const p2 = coordinator.trigger(TARGET()); // coalesces
    const p3 = coordinator.trigger(TARGET()); // replaces the same pending flag, still just one
    releaseWork?.();
    await Promise.all([p1, p2, p3]);
    expect(runWorkCalls).toBe(2); // exactly one coalesced re-run, never a queue of three
  });

  it('different canonical repositories index concurrently without blocking each other', async () => {
    const gates: Record<string, () => void> = {};
    const started: string[] = [];
    const { deps } = makeDeps({
      runWork: async (ctx) => {
        started.push(ctx.target.repositoryKey);
        await new Promise<void>((resolve) => {
          gates[ctx.target.repositoryKey] = resolve;
        });
      },
    });
    const coordinator = new IndexCoordinator(deps);
    const pA = coordinator.trigger(TARGET({ repositoryKey: 'repo-a' }));
    const pB = coordinator.trigger(TARGET({ repositoryKey: 'repo-b' }));
    await tick(); // let both attempts genuinely reach runWork
    expect(started.sort()).toEqual(['repo-a', 'repo-b']); // both started before either finished
    gates['repo-a']?.();
    gates['repo-b']?.();
    await Promise.all([pA, pB]);
  });

  it('two distinct local checkouts of the same canonical repositoryKey cannot run jobs at once', async () => {
    let concurrentRunners = 0;
    let maxConcurrent = 0;
    const { deps } = makeDeps({
      runWork: async () => {
        concurrentRunners += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrentRunners);
        await Promise.resolve();
        concurrentRunners -= 1;
      },
    });
    const coordinator = new IndexCoordinator(deps);
    const pA = coordinator.trigger(TARGET({ repoRoot: '/checkout/a' }));
    const pB = coordinator.trigger(TARGET({ repoRoot: '/checkout/b' })); // same repositoryKey
    await Promise.all([pA, pB]);
    expect(maxConcurrent).toBe(1);
  });
});

describe('crash recovery (decision 4 — in-process only)', () => {
  it('a fresh coordinator has no lock to clear', () => {
    const { deps } = makeDeps();
    const coordinator = new IndexCoordinator(deps);
    expect(coordinator.hasActiveJob(TARGET())).toBe(false);
  });
});

describe('the snapshot is released on every exit path (decision 7)', () => {
  it('success', async () => {
    const { vcs, releaseCalls } = fakeVcs();
    const { deps } = makeDeps({ vcsFor: () => vcs, runWork: async () => {} });
    await new IndexCoordinator(deps).trigger(TARGET());
    expect(releaseCalls.length).toBe(1);
  });

  it('no-work — the work step resolves having found nothing to do', async () => {
    const { vcs, releaseCalls } = fakeVcs();
    const { deps } = makeDeps({
      vcsFor: () => vcs,
      runWork: async (ctx) => {
        // A real no-op step: checks the journal, finds nothing, does nothing.
        await ctx.journal.get({
          server: ctx.target.server,
          repositoryKey: ctx.target.repositoryKey,
          baseId: ctx.target.currentBaseId,
          indexerVersion: INDEXER_VERSION,
          generationId: 'gen_x',
        });
      },
    });
    await new IndexCoordinator(deps).trigger(TARGET());
    expect(releaseCalls.length).toBe(1);
  });

  it('a thrown work step', async () => {
    const { vcs, releaseCalls } = fakeVcs();
    const { deps } = makeDeps({
      vcsFor: () => vcs,
      runWork: async () => {
        throw new Error('boom');
      },
    });
    // Never rejects the caller — a background subsystem's failure is logged, not thrown.
    await expect(new IndexCoordinator(deps).trigger(TARGET())).resolves.toBeUndefined();
    expect(releaseCalls.length).toBe(1);
  });

  it('cancellation', async () => {
    const { vcs, releaseCalls } = fakeVcs();
    let sawAbort = false;
    const { deps } = makeDeps({
      vcsFor: () => vcs,
      runWork: (ctx) =>
        new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            sawAbort = true;
            resolve();
          });
        }),
    });
    const coordinator = new IndexCoordinator(deps);
    const p = coordinator.trigger(TARGET());
    await tick(); // let the attempt genuinely reach runWork and register its abort listener
    await coordinator.cancelAll();
    await p;
    expect(sawAbort).toBe(true);
    expect(releaseCalls.length).toBe(1);
  });

  it('shutdown — cancelAll only resolves after the release has actually happened', async () => {
    const releaseOrder: string[] = [];
    const { vcs } = fakeVcs();
    vi.mocked(vcs.releaseIndexSnapshot).mockImplementation(async () => {
      await Promise.resolve();
      releaseOrder.push('released');
    });
    const { deps } = makeDeps({
      vcsFor: () => vcs,
      runWork: (ctx) =>
        new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => resolve());
        }),
    });
    const coordinator = new IndexCoordinator(deps);
    const p = coordinator.trigger(TARGET());
    await tick(); // let the attempt genuinely reach runWork and register its abort listener
    await coordinator.cancelAll();
    releaseOrder.push('cancelAll returned');
    await p;
    expect(releaseOrder).toEqual(['released', 'cancelAll returned']);
  });
});

describe('cancellation leaves server-side staging alone (decision 8)', () => {
  it('only releases the snapshot — no other vcs call is made after cancellation', async () => {
    const { vcs, releaseCalls, changesBetweenCalls } = fakeVcs();
    const { deps } = makeDeps({
      vcsFor: () => vcs,
      runWork: (ctx) =>
        new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => resolve());
        }),
    });
    const coordinator = new IndexCoordinator(deps);
    const p = coordinator.trigger(TARGET());
    await tick(); // let the attempt genuinely reach runWork and register its abort listener
    await coordinator.cancelAll();
    await p;
    // The only two vcs calls across the whole attempt: the changesBetween the reconcile decision
    // needed, and the release cancellation triggers. Nothing resembling an abort/delete of staged
    // server state — there is no such method on the seam at all, and this proves nothing NEW was
    // invented to reach for one.
    expect(releaseCalls.length).toBe(1);
    expect(changesBetweenCalls.length).toBe(1);
    expect(vcs.leaseIndexSnapshot).toHaveBeenCalledTimes(1);
  });
});

describe('the injected work step receives the journal, never interpreted by the coordinator', () => {
  it('a mismatched journal key reads back as a miss inside the work step', async () => {
    const journal = new IndexJournal({ read: async () => ({}), write: async () => {} });
    await journal.put(
      {
        server: 'https://noriq.test',
        repositoryKey: 'my-repo',
        baseId: 'base-1',
        indexerVersion: '1',
        generationId: 'gen_1',
      },
      { batches: 3 },
    );
    let sawNull = false;
    const runWork: IndexWorkStep = async (ctx) => {
      const entry = await ctx.journal.get({
        server: ctx.target.server,
        repositoryKey: ctx.target.repositoryKey,
        baseId: ctx.target.currentBaseId, // the CURRENT base, not the stale journal's base-1
        indexerVersion: '1',
        generationId: 'gen_1',
      });
      sawNull = entry === null;
    };
    const { deps } = makeDeps({ journal, runWork });
    await new IndexCoordinator(deps).trigger(TARGET());
    expect(sawNull).toBe(true);
  });
});
