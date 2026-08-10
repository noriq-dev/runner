import type { EffortEpisode as EffortEpisodeType } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_PENDING_AGE_HOURS,
  EpisodePendingStore,
  type PendingEpisode,
  type PendingEpisodeFileStore,
  trimPending,
} from '../src/episode-pending';

// RUN-227: the bounded, restart-surviving undelivered-episode queue. `EpisodePendingStore` is
// exercised against an in-memory `PendingEpisodeFileStore` (mirroring `index-journal.test.ts`'s own
// fake) — never a real home directory — and `trimPending` (the bound itself) is tested directly as
// a pure function, since it is the one piece of this module the acceptance criteria are actually
// about.

function episode(over: Partial<EffortEpisodeType> = {}): EffortEpisodeType {
  return {
    id: 'epi_1',
    projectId: 'prj_p',
    runId: 'run_1',
    taskId: null,
    repositoryKey: 'myrepo',
    baseId: null,
    timeline: [],
    filesTouched: [],
    commands: [],
    testsRun: [],
    failures: [],
    findings: [],
    reviewRounds: 0,
    tokenUsage: {},
    costUSD: 0,
    acceptanceCoverage: null,
    steeringEvents: [],
    landingOutcome: 'pending',
    remainingWork: [],
    selfSummary: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function entry(over: Partial<PendingEpisode> = {}): PendingEpisode {
  return {
    scopeId: 'epi_scope_1',
    episode: episode(),
    mint: { projectId: 'prj_p', repositoryKey: 'myrepo', runnerId: 'rnr_1' },
    enqueuedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function memStore(): PendingEpisodeFileStore & { fileForTest: { pending: PendingEpisode[] } } {
  const state = { pending: [] as PendingEpisode[] };
  return {
    fileForTest: state,
    read: async () => structuredClone({ pending: state.pending }),
    write: async (f) => {
      state.pending = structuredClone(f.pending);
    },
  };
}

describe('trimPending — the bound itself (RUN-227 locked decision 7)', () => {
  it('drops entries older than maxAgeHours regardless of count', () => {
    const now = new Date('2026-08-08T00:00:00.000Z');
    const fresh = entry({ scopeId: 'fresh', enqueuedAt: '2026-08-07T23:00:00.000Z' });
    const stale = entry({ scopeId: 'stale', enqueuedAt: '2026-07-01T00:00:00.000Z' });
    const out = trimPending([fresh, stale], now, 500, 24);
    expect(out.map((e) => e.scopeId)).toEqual(['fresh']);
  });

  it('past maxCount, drops the OLDEST survivors first, keeping the most recent', () => {
    const now = new Date('2026-08-08T00:00:00.000Z');
    const entries = [
      entry({ scopeId: 'a', enqueuedAt: '2026-08-01T00:00:00.000Z' }),
      entry({ scopeId: 'b', enqueuedAt: '2026-08-02T00:00:00.000Z' }),
      entry({ scopeId: 'c', enqueuedAt: '2026-08-03T00:00:00.000Z' }),
    ];
    const out = trimPending(entries, now, 2, DEFAULT_MAX_PENDING_AGE_HOURS);
    expect(out.map((e) => e.scopeId)).toEqual(['b', 'c']);
  });

  it('an entry with an unparseable enqueuedAt degrades toward eviction, not toward being kept forever', () => {
    const now = new Date('2026-08-08T00:00:00.000Z');
    const malformed = entry({ scopeId: 'bad', enqueuedAt: 'not-a-date' });
    const good = entry({ scopeId: 'good', enqueuedAt: '2026-08-07T00:00:00.000Z' });
    const out = trimPending([malformed, good], now, 500, DEFAULT_MAX_PENDING_AGE_HOURS);
    expect(out.map((e) => e.scopeId)).toEqual(['good']);
  });

  it('under both bounds, every entry survives untouched', () => {
    const now = new Date('2026-08-08T00:00:00.000Z');
    const entries = [entry({ scopeId: 'a' }), entry({ scopeId: 'b' })];
    const out = trimPending(entries, now, 500, DEFAULT_MAX_PENDING_AGE_HOURS);
    expect(out).toHaveLength(2);
  });
});

// A fixed reference instant — every test below pins `EpisodePendingStore`'s clock to this rather
// than trusting the real wall clock, so a fixture's `enqueuedAt` is never at the mercy of when the
// suite happens to run relative to `DEFAULT_MAX_PENDING_AGE_HOURS`.
const NOW = () => new Date('2026-08-08T00:00:00.000Z');

describe('EpisodePendingStore — restart survival (RUN-227)', () => {
  it('a fresh store reading a store another instance wrote sees the same entries — the restart case', async () => {
    const backing = memStore();
    const writer = new EpisodePendingStore(backing, { now: NOW });
    await writer.put(entry({ scopeId: 'a', enqueuedAt: '2026-08-07T00:00:00.000Z' }));
    await writer.put(entry({ scopeId: 'b', enqueuedAt: '2026-08-07T00:00:00.000Z' }));

    // A NEW store instance over the SAME backing file — what a daemon restart looks like.
    const reader = new EpisodePendingStore(backing, { now: NOW });
    const survived = await reader.list();
    expect(survived.map((e) => e.scopeId).sort()).toEqual(['a', 'b']);
  });

  it('put persists the episode payload byte-identically — a retry must resend it verbatim', async () => {
    const backing = memStore();
    const store = new EpisodePendingStore(backing, { now: NOW });
    const original = entry({
      enqueuedAt: '2026-08-07T00:00:00.000Z',
      episode: episode({ createdAt: '2026-08-01T12:34:56.000Z', filesTouched: ['a.ts'] }),
    });
    await store.put(original);
    const [back] = await store.list();
    expect(back?.episode).toEqual(original.episode);
  });
});

describe('EpisodePendingStore — cleanup after acknowledgement (RUN-227)', () => {
  it('remove drops exactly the acknowledged scope and leaves the rest', async () => {
    const backing = memStore();
    const store = new EpisodePendingStore(backing, { now: NOW });
    await store.put(entry({ scopeId: 'a', enqueuedAt: '2026-08-07T00:00:00.000Z' }));
    await store.put(entry({ scopeId: 'b', enqueuedAt: '2026-08-07T00:00:00.000Z' }));
    await store.remove('a');
    expect((await store.list()).map((e) => e.scopeId)).toEqual(['b']);
  });

  it('removing an already-gone scope is a no-op, never a throw', async () => {
    const backing = memStore();
    const store = new EpisodePendingStore(backing, { now: NOW });
    await store.put(entry({ scopeId: 'a', enqueuedAt: '2026-08-07T00:00:00.000Z' }));
    await expect(store.remove('nonexistent')).resolves.toBeUndefined();
    expect((await store.list()).map((e) => e.scopeId)).toEqual(['a']);
  });
});

describe('EpisodePendingStore — retention bounds enforced on write (RUN-227 locked decision 7)', () => {
  it('put trims to maxCount immediately — a queue that is only ever written to never exceeds it', async () => {
    const backing = memStore();
    const store = new EpisodePendingStore(backing, { maxCount: 2, now: NOW });
    await store.put(entry({ scopeId: 'a', enqueuedAt: '2026-08-01T00:00:00.000Z' }));
    await store.put(entry({ scopeId: 'b', enqueuedAt: '2026-08-02T00:00:00.000Z' }));
    await store.put(entry({ scopeId: 'c', enqueuedAt: '2026-08-03T00:00:00.000Z' }));
    const survivors = await store.list();
    expect(survivors).toHaveLength(2);
    expect(survivors.map((e) => e.scopeId)).toEqual(['b', 'c']);
  });

  it('re-enqueuing the SAME scopeId replaces the entry rather than duplicating it', async () => {
    const backing = memStore();
    const store = new EpisodePendingStore(backing, { now: NOW });
    await store.put(entry({ scopeId: 'a', enqueuedAt: '2026-08-01T00:00:00.000Z' }));
    await store.put(entry({ scopeId: 'a', enqueuedAt: '2026-08-02T00:00:00.000Z' }));
    const survivors = await store.list();
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.enqueuedAt).toBe('2026-08-02T00:00:00.000Z');
  });
});

describe('filePendingEpisodeStore — corrupt file degrades to empty (RUN-227, index-journal.ts’s precedent)', () => {
  it('a store whose read throws is treated as empty by EpisodePendingStore, never as a crash', async () => {
    const broken: PendingEpisodeFileStore = {
      read: async () => {
        throw new Error('disk read failed');
      },
      write: async () => {},
    };
    const store = new EpisodePendingStore(broken);
    await expect(store.list()).resolves.toEqual([]);
  });
});
