import type { EffortEpisode as EffortEpisodeType } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_PENDING_AGE_HOURS,
  DEFAULT_MAX_PENDING_BYTES,
  EpisodePendingStore,
  type PendingEpisode,
  type PendingEpisodeFileStore,
  type PendingEvictionReason,
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

/** An entry padded to a controllable rough size via `commands` — `entryBytes` below measures its
 *  ACTUAL serialized size, so tests never guess a byte count; they derive expectations from the
 *  exact same measurement the implementation uses. */
function bigEntry(scopeId: string, enqueuedAt: string, padLen: number): PendingEpisode {
  return entry({ scopeId, enqueuedAt, episode: episode({ commands: ['x'.repeat(padLen)] }) });
}

/** The identical measurement `trimPending`'s byte axis uses (RUN-249 discretion: actual UTF-8
 *  bytes of the entry's own JSON, not `.length`'s UTF-16 code units) — reused here so a test
 *  expresses its cap relative to a REAL measured size rather than a guessed constant. */
function entryBytes(e: PendingEpisode): number {
  return Buffer.byteLength(JSON.stringify(e), 'utf8');
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

describe('trimPending — the byte axis (RUN-249)', () => {
  it('DEFAULT_MAX_PENDING_BYTES is 8 MiB', () => {
    expect(DEFAULT_MAX_PENDING_BYTES).toBe(8 * 1024 * 1024);
  });

  it('evicts OLDEST first when the survivors serialize larger than maxBytes, independent of age/count', () => {
    const now = new Date('2026-08-08T00:00:00.000Z');
    const a = bigEntry('a', '2026-08-01T00:00:00.000Z', 2000);
    const b = bigEntry('b', '2026-08-02T00:00:00.000Z', 2000);
    const c = bigEntry('c', '2026-08-03T00:00:00.000Z', 2000);
    // Room for only the two newest — well under maxCount/maxAgeHours, so this is the byte axis
    // acting alone.
    const cap = entryBytes(b) + entryBytes(c) + 1;
    const out = trimPending([a, b, c], now, 500, DEFAULT_MAX_PENDING_AGE_HOURS, cap);
    expect(out.map((e) => e.scopeId)).toEqual(['b', 'c']);
    // "trimmed to AT OR UNDER it" (acceptance) — the survivors' own total fits the cap.
    expect(out.reduce((sum, e) => sum + entryBytes(e), 0)).toBeLessThanOrEqual(cap);
  });

  it('reports the byte-eviction reason via onEvict, distinguishable from age/count', () => {
    const now = new Date('2026-08-08T00:00:00.000Z');
    const a = bigEntry('a', '2026-08-01T00:00:00.000Z', 2000);
    const b = bigEntry('b', '2026-08-02T00:00:00.000Z', 2000);
    const cap = entryBytes(b) + 1; // room for only the newest
    const dropped: Array<{ scopeId: string; reason: PendingEvictionReason }> = [];
    trimPending([a, b], now, 500, DEFAULT_MAX_PENDING_AGE_HOURS, cap, (e, reason) =>
      dropped.push({ scopeId: e.scopeId, reason }),
    );
    expect(dropped).toEqual([{ scopeId: 'a', reason: 'bytes' }]);
  });

  it('never truncates a surviving entry’s content to fit — intelligence.execution.stages is byte-identical', () => {
    const now = new Date('2026-08-08T00:00:00.000Z');
    const stages = [
      {
        stage: 'primary',
        tokens: { inputTokens: 1, outputTokens: 2 },
        source: 'runner',
        sourceId: 'primary',
      },
    ];
    const survivor = entry({
      scopeId: 'keep',
      enqueuedAt: '2026-08-03T00:00:00.000Z',
      intelligence: { execution: { stages } } as unknown as PendingEpisode['intelligence'],
    });
    const doomed = bigEntry('drop', '2026-08-01T00:00:00.000Z', 5000);
    const cap = entryBytes(survivor) + 10;
    const out = trimPending([doomed, survivor], now, 500, DEFAULT_MAX_PENDING_AGE_HOURS, cap);
    expect(out.map((e) => e.scopeId)).toEqual(['keep']);
    // Byte-identical: the surviving entry's stages are untouched, not shortened to fit.
    expect(
      (out[0]?.intelligence as { execution: { stages: unknown } } | undefined)?.execution.stages,
    ).toEqual(stages);
  });

  it('a single surviving entry that alone exceeds maxBytes is KEPT, not evicted (discretion: delivery over an exact quota)', () => {
    const now = new Date('2026-08-08T00:00:00.000Z');
    const solo = bigEntry('solo', '2026-08-01T00:00:00.000Z', 5000);
    const cap = 100; // far smaller than the entry itself
    const out = trimPending([solo], now, 500, DEFAULT_MAX_PENDING_AGE_HOURS, cap);
    expect(out.map((e) => e.scopeId)).toEqual(['solo']);
  });

  it('the byte pass never re-admits an entry the count pass already dropped, and cannot evict one twice', () => {
    const now = new Date('2026-08-08T00:00:00.000Z');
    const a = entry({ scopeId: 'a', enqueuedAt: '2026-08-01T00:00:00.000Z' });
    const b = entry({ scopeId: 'b', enqueuedAt: '2026-08-02T00:00:00.000Z' });
    const c = entry({ scopeId: 'c', enqueuedAt: '2026-08-03T00:00:00.000Z' });
    const dropped: Array<{ scopeId: string; reason: PendingEvictionReason }> = [];
    // maxCount=1 forces the count pass to drop 'a' and 'b' first; the byte cap (generous) would
    // happily hold all three, so it must never resurrect either.
    const out = trimPending(
      [a, b, c],
      now,
      1,
      DEFAULT_MAX_PENDING_AGE_HOURS,
      DEFAULT_MAX_PENDING_BYTES,
      (e, r) => dropped.push({ scopeId: e.scopeId, reason: r }),
    );
    expect(out.map((e) => e.scopeId)).toEqual(['c']);
    // Each of 'a'/'b' is reported evicted exactly ONCE, by the count pass — never twice, never by
    // the byte pass too.
    expect(dropped).toEqual([
      { scopeId: 'a', reason: 'count' },
      { scopeId: 'b', reason: 'count' },
    ]);
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

describe('EpisodePendingStore — byte bound enforced on write (RUN-249)', () => {
  it('put trims to maxBytes immediately, exactly like the count bound', async () => {
    const backing = memStore();
    const a = bigEntry('a', '2026-08-01T00:00:00.000Z', 2000);
    const b = bigEntry('b', '2026-08-02T00:00:00.000Z', 2000);
    const cap = entryBytes(b) + 1; // room for only the newest, once both are present
    const store = new EpisodePendingStore(backing, { maxCount: 500, maxBytes: cap, now: NOW });
    await store.put(a);
    await store.put(b);
    const survivors = await store.list();
    expect(survivors.map((e) => e.scopeId)).toEqual(['b']);
  });

  it('logs a byte eviction distinguishably from an age or a count eviction', async () => {
    const lines: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const logger = { warn: (msg: string, fields?: Record<string, unknown>) => lines.push({ msg, fields }) };

    // Byte eviction.
    const byteBacking = memStore();
    const a = bigEntry('a', '2026-08-01T00:00:00.000Z', 2000);
    const b = bigEntry('b', '2026-08-02T00:00:00.000Z', 2000);
    const byteStore = new EpisodePendingStore(byteBacking, {
      maxCount: 500,
      maxBytes: entryBytes(b) + 1,
      now: NOW,
      logger,
    });
    await byteStore.put(a);
    await byteStore.put(b);
    const byteLine = lines.find((l) => l.fields?.scopeId === 'a');
    expect(byteLine?.msg).toBe('pending episode evicted from spool');
    expect(byteLine?.fields).toMatchObject({ reason: 'bytes' });

    // Count eviction — same log line shape, different `reason`.
    lines.length = 0;
    const countStore = new EpisodePendingStore(memStore(), { maxCount: 1, now: NOW, logger });
    await countStore.put(entry({ scopeId: 'x', enqueuedAt: '2026-08-01T00:00:00.000Z' }));
    await countStore.put(entry({ scopeId: 'y', enqueuedAt: '2026-08-02T00:00:00.000Z' }));
    const countLine = lines.find((l) => l.fields?.scopeId === 'x');
    expect(countLine?.fields).toMatchObject({ reason: 'count' });

    // Age eviction — same log line shape, different `reason` again.
    lines.length = 0;
    const ageStore = new EpisodePendingStore(memStore(), { maxAgeHours: 1, now: NOW, logger });
    await ageStore.put(entry({ scopeId: 'old', enqueuedAt: '2026-08-01T00:00:00.000Z' }));
    const ageLine = lines.find((l) => l.fields?.scopeId === 'old');
    expect(ageLine?.fields).toMatchObject({ reason: 'age' });

    // Three distinct reasons observed across the three scenarios above.
    expect(new Set([byteLine?.fields?.reason, countLine?.fields?.reason, ageLine?.fields?.reason])).toEqual(
      new Set(['bytes', 'count', 'age']),
    );
  });
});

describe('EpisodePendingStore — intelligence (RUN-284)', () => {
  const VERIFY_SOURCE = { source: 'runner' as const, sourceId: 'verify' };
  const intelligence = {
    execution: {
      clocks: {
        verifyDurationMs: {
          status: 'complete' as const,
          value: 12,
          provenance: 'runner_observed' as const,
          source: VERIFY_SOURCE.source,
          sourceId: VERIFY_SOURCE.sourceId,
          observedAt: '2026-08-01T00:00:00.000Z',
          acceptedAt: null,
          reason: null,
        },
      },
    },
  };

  it('an entry WITH intelligence persists it byte-identically — a retry resends the same payload', async () => {
    const backing = memStore();
    const store = new EpisodePendingStore(backing, { now: NOW });
    const original = entry({ enqueuedAt: '2026-08-07T00:00:00.000Z', intelligence });
    await store.put(original);
    const [back] = await store.list();
    expect(back?.intelligence).toEqual(intelligence);
  });

  // The compatibility case RUN-284's own locked decision names: a spool entry persisted BEFORE
  // this field existed carries no `intelligence` key at all in its serialized JSON — not `null`,
  // not `undefined` written out, simply absent. `EpisodePendingStore` does no schema validation of
  // its own (`toEnrichmentPayload` is the one validation point, applied fresh on every send), so an
  // old entry must load and be uploadable exactly as it always was.
  it('a PRE-EXISTING entry with no intelligence key loads fine — the old-spool-entry compatibility case', async () => {
    const backing = memStore();
    // Write the OLD shape directly, bypassing `entry()`'s helper (which would happily accept an
    // `intelligence: undefined` key that JSON.stringify would drop anyway — this instead models the
    // literal on-disk shape a pre-RUN-284 daemon actually wrote: the key is simply not there).
    const oldShapeEntry = {
      scopeId: 'epi_old',
      episode: episode(),
      mint: { projectId: 'prj_p', repositoryKey: 'myrepo', runnerId: 'rnr_1' },
      enqueuedAt: '2026-08-07T00:00:00.000Z',
    };
    await backing.write({ pending: [oldShapeEntry as unknown as PendingEpisode] });

    const store = new EpisodePendingStore(backing, { now: NOW });
    const survived = await store.list();

    expect(survived).toHaveLength(1);
    expect(survived[0]?.scopeId).toBe('epi_old');
    expect(survived[0]?.intelligence).toBeUndefined();
  });

  it('put on a store already holding an old-shape entry does not disturb it', async () => {
    const backing = memStore();
    const oldShapeEntry = {
      scopeId: 'epi_old',
      episode: episode(),
      mint: { projectId: 'prj_p', repositoryKey: 'myrepo', runnerId: 'rnr_1' },
      enqueuedAt: '2026-08-07T00:00:00.000Z',
    };
    await backing.write({ pending: [oldShapeEntry as unknown as PendingEpisode] });
    const store = new EpisodePendingStore(backing, { now: NOW });

    await store.put(entry({ scopeId: 'epi_new', enqueuedAt: '2026-08-07T01:00:00.000Z', intelligence }));

    const survived = await store.list();
    expect(survived.map((e) => e.scopeId).sort()).toEqual(['epi_new', 'epi_old']);
    expect(survived.find((e) => e.scopeId === 'epi_old')?.intelligence).toBeUndefined();
    expect(survived.find((e) => e.scopeId === 'epi_new')?.intelligence).toEqual(intelligence);
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
