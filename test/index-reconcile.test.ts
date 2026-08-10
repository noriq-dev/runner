import { describe, expect, it } from 'vitest';
import { INDEXER_VERSION, type ReconcileInput, associationNotice, reconcile } from '../src/index-reconcile';
import type { RunnerIndexCursor, RunnerStagedGeneration } from '../src/memory-contract';
import { stagesFor } from '../src/run-machine';
import { BUILTIN_WORKFLOWS } from '../src/workflow';

const GEN = (over: Partial<RunnerIndexCursor['activeGeneration']> = {}) => ({
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

const input = (over: Partial<ReconcileInput> = {}): ReconcileInput => ({
  cursor: CURSOR(),
  currentBaseId: 'base-1',
  indexerVersion: INDEXER_VERSION,
  ...over,
});

const staged = (over: Partial<RunnerStagedGeneration> = {}): RunnerStagedGeneration => ({
  ...GEN({ status: 'staged' }),
  validated: true,
  ...over,
});

describe('reconcile — unchanged (RUN-213 acceptance)', () => {
  it('same base, same indexer version, not stale → unchanged, schedules nothing', () => {
    expect(reconcile(input())).toEqual({ outcome: 'unchanged' });
  });

  it('same base but the server considers it stale → not unchanged', () => {
    const out = reconcile(input({ cursor: CURSOR({ stale: true }) }));
    expect(out.outcome).not.toBe('unchanged');
  });

  it('a moved base never reuses stale local results as current: differing baseId is never unchanged', () => {
    const out = reconcile(input({ currentBaseId: 'base-2' }));
    expect(out.outcome).not.toBe('unchanged');
  });
});

describe('reconcile — moved base (decision 10, defers to changesBetween/RUN-212)', () => {
  it('a usable changesBetween on a moved base → incremental, carrying the from-base', () => {
    const out = reconcile(
      input({ currentBaseId: 'base-2', changesBetween: { ok: true, changed: ['a.ts'], deleted: [] } }),
    );
    expect(out).toEqual({ outcome: 'incremental', fromBase: 'base-1', toBase: 'base-2' });
  });

  it('full-index-required from changesBetween becomes full', () => {
    const out = reconcile(
      input({
        currentBaseId: 'base-2',
        changesBetween: { ok: false, reason: 'full-index-required', detail: 'unrelated histories' },
      }),
    );
    expect(out.outcome).toBe('full');
    expect(out).toMatchObject({ reason: 'unrelated histories' });
  });

  it('a moved base with no changesBetween supplied also becomes full, never incremental', () => {
    const out = reconcile(input({ currentBaseId: 'base-2' }));
    expect(out.outcome).toBe('full');
  });

  // RUN-275: the three tests that used to live here pinned a `resumeCandidate` on the outcome.
  // Nothing ever read it, and it could not soundly justify skipping work either — it matched on
  // base and indexer version, while `deriveGenerationId` leaves the MANIFEST out, so one id can
  // hold content built under different include/exclude globs. What survives is the property that
  // matters: a staged generation, whatever its state, does not change the DECISION.
  it('a staged generation at the current base does not change the outcome (RUN-275)', () => {
    const candidate = staged({ baseId: 'base-2', indexerVersion: INDEXER_VERSION });
    const bare = reconcile(
      input({ currentBaseId: 'base-2', changesBetween: { ok: true, changed: [], deleted: [] } }),
    );
    const withStaged = reconcile(
      input({
        currentBaseId: 'base-2',
        cursor: CURSOR({ stagedGenerations: [candidate] }),
        changesBetween: { ok: true, changed: [], deleted: [] },
      }),
    );
    expect(withStaged).toEqual(bare);
    expect(withStaged.outcome).toBe('incremental');
  });

  it('an unvalidated staged generation likewise changes nothing (RUN-275)', () => {
    const unvalidated = staged({ baseId: 'base-2', indexerVersion: INDEXER_VERSION, validated: false });
    const out = reconcile(
      input({
        currentBaseId: 'base-2',
        cursor: CURSOR({ stagedGenerations: [unvalidated] }),
        changesBetween: { ok: true, changed: [], deleted: [] },
      }),
    );
    expect(out).toEqual({ outcome: 'incremental', fromBase: 'base-1', toBase: 'base-2' });
  });
});

describe('reconcile — version skew is decided in both directions (decision 7)', () => {
  it('a NEWER active indexer version → incompatible-version, schedules nothing', () => {
    const out = reconcile(input({ cursor: CURSOR({ activeGeneration: GEN({ indexerVersion: '2' }) }) }));
    expect(out).toEqual({
      outcome: 'incompatible-version',
      activeIndexerVersion: '2',
      ourIndexerVersion: '1',
    });
  });

  it('an OLDER active indexer version → full, even at the same base', () => {
    const out = reconcile(input({ cursor: CURSOR({ activeGeneration: GEN({ indexerVersion: '0' }) }) }));
    expect(out.outcome).toBe('full');
  });

  it('an unparseable active indexer version fails toward incompatible-version, never full', () => {
    const out = reconcile(
      input({ cursor: CURSOR({ activeGeneration: GEN({ indexerVersion: 'rewrite-7' }) }) }),
    );
    expect(out.outcome).toBe('incompatible-version');
  });

  it('no active generation at all → full, never incompatible-version', () => {
    const out = reconcile(input({ cursor: CURSOR({ activeGeneration: null }) }));
    expect(out.outcome).toBe('full');
  });
});

describe('reconcile — association (decision 8)', () => {
  it('a conflicting association blocks indexing: association-conflict, schedules nothing', () => {
    const out = reconcile(
      input({
        cursor: CURSOR({
          association: { state: 'conflict', projectRepositoryId: 'prjrepo_other', reason: 'bound elsewhere' },
        }),
      }),
    );
    expect(out).toEqual({
      outcome: 'association-conflict',
      projectRepositoryId: 'prjrepo_other',
      reason: 'bound elsewhere',
    });
  });

  it('not-associated does NOT block: the ordinary decision (unchanged here) still applies', () => {
    const out = reconcile(input({ cursor: CURSOR({ association: { state: 'not-associated' } }) }));
    expect(out).toEqual({ outcome: 'unchanged' });
  });

  it('associationNotice: error for conflict, warn for not-associated, nothing for associated', () => {
    expect(associationNotice({ state: 'conflict', projectRepositoryId: 'p', reason: 'r' })?.level).toBe(
      'error',
    );
    expect(associationNotice({ state: 'not-associated' })?.level).toBe('warn');
    expect(associationNotice({ state: 'associated', projectRepositoryId: 'p' })).toBeNull();
  });

  it('a conflicting association does not touch run dispatch: the run pipeline is unaware reconcile exists', () => {
    // reconcile takes no dispatch/supervisor handle of any kind — there is nothing for an
    // association-conflict outcome to call into. Demonstrated concretely: computing an
    // association-conflict outcome alongside an ordinary run-pipeline computation leaves the
    // latter exactly as it is with no `[index]`/memory awareness at all (RUN-213 is a pure
    // additional READ; it does not gate `stagesFor`/workflow resolution in any way).
    const conflictOutcome = reconcile(
      input({
        cursor: CURSOR({
          association: { state: 'conflict', projectRepositoryId: 'prjrepo_other', reason: 'bound elsewhere' },
        }),
      }),
    );
    expect(conflictOutcome.outcome).toBe('association-conflict');
    const build = BUILTIN_WORKFLOWS.build;
    expect(stagesFor(build)).toEqual(stagesFor(build));
  });
});

describe('reconcile — a failed/unresolvable cursor fetch (decision 6)', () => {
  it('null cursor → unavailable, never unchanged, never full', () => {
    const out = reconcile(input({ cursor: null }));
    expect(out.outcome).toBe('unavailable');
    expect((out as { reason: string }).reason.length).toBeGreaterThan(0);
  });
});

describe('reconcile — idempotence (acceptance: "idempotent across daemon restart")', () => {
  it('is a pure function of its inputs: same inputs in, same outcome out, every time', () => {
    const one = input({ currentBaseId: 'base-2', changesBetween: { ok: true, changed: ['x'], deleted: [] } });
    const first = reconcile(one);
    const second = reconcile(one);
    const third = reconcile({ ...one }); // a fresh object, not the same reference — no closure state
    expect(first).toEqual(second);
    expect(first).toEqual(third);
  });

  it("reconciling with a DIFFERENT currentBaseId right after never reuses the prior call's answer", () => {
    const moved = input({
      currentBaseId: 'base-2',
      changesBetween: { ok: true, changed: ['x'], deleted: [] },
    });
    const unchanged = input();
    reconcile(moved);
    // A stateful implementation (a cache keyed wrong, a memoized last-seen base) would leak the
    // previous call's verdict here. A pure function cannot.
    expect(reconcile(unchanged)).toEqual({ outcome: 'unchanged' });
  });
});
