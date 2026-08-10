import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_PENDING_VERIFICATION_AGE_HOURS,
  type PendingVerificationFileStore,
  type PendingVerificationReport,
  VerificationPendingStore,
  trimPendingVerification,
} from '../src/verification-pending';
import type { VerificationReportWire } from '../src/verification-report';

// RUN-230: the bounded, restart-surviving queue of undelivered verification reports. Mirrors
// `test/episode-pending.test.ts`'s own structure exactly — `VerificationPendingStore` exercised
// against an in-memory `PendingVerificationFileStore`, `trimPendingVerification` (the bound
// itself) tested directly as a pure function — because the retention shape genuinely is the same
// (`verification-pending.ts`'s own doc argues why the STORE stays separate from
// `EpisodePendingStore` while the bound behaviour does not need to).

function report(over: Partial<VerificationReportWire> = {}): VerificationReportWire {
  return {
    citations: [
      {
        memoryItemId: 'mem_1',
        evidenceHash: 'deadbeef',
        state: 'valid',
        baseId: 'base_1',
        branch: 'main',
      },
    ],
    source: 'runner-thorough',
    ...over,
  };
}

function entry(over: Partial<PendingVerificationReport> = {}): PendingVerificationReport {
  return {
    runId: 'run_1',
    agentToken: 'tok_1',
    report: report(),
    enqueuedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function memStore(): PendingVerificationFileStore & {
  fileForTest: { pending: PendingVerificationReport[] };
} {
  const state = { pending: [] as PendingVerificationReport[] };
  return {
    fileForTest: state,
    read: async () => structuredClone({ pending: state.pending }),
    write: async (f) => {
      state.pending = structuredClone(f.pending);
    },
  };
}

describe('trimPendingVerification — the bound itself', () => {
  it('drops entries older than maxAgeHours regardless of count', () => {
    const now = new Date('2026-08-08T00:00:00.000Z');
    const fresh = entry({ runId: 'fresh', enqueuedAt: '2026-08-07T23:00:00.000Z' });
    const stale = entry({ runId: 'stale', enqueuedAt: '2026-07-01T00:00:00.000Z' });
    const out = trimPendingVerification([fresh, stale], now, 500, 24);
    expect(out.map((e) => e.runId)).toEqual(['fresh']);
  });

  it('past maxCount, drops the OLDEST survivors first, keeping the most recent', () => {
    const now = new Date('2026-08-08T00:00:00.000Z');
    const entries = [
      entry({ runId: 'a', enqueuedAt: '2026-08-01T00:00:00.000Z' }),
      entry({ runId: 'b', enqueuedAt: '2026-08-02T00:00:00.000Z' }),
      entry({ runId: 'c', enqueuedAt: '2026-08-03T00:00:00.000Z' }),
    ];
    const out = trimPendingVerification(entries, now, 2, DEFAULT_MAX_PENDING_VERIFICATION_AGE_HOURS);
    expect(out.map((e) => e.runId)).toEqual(['b', 'c']);
  });

  it('an entry with an unparseable enqueuedAt degrades toward eviction, not toward being kept forever', () => {
    const now = new Date('2026-08-08T00:00:00.000Z');
    const malformed = entry({ runId: 'bad', enqueuedAt: 'not-a-date' });
    const good = entry({ runId: 'good', enqueuedAt: '2026-08-07T00:00:00.000Z' });
    const out = trimPendingVerification(
      [malformed, good],
      now,
      500,
      DEFAULT_MAX_PENDING_VERIFICATION_AGE_HOURS,
    );
    expect(out.map((e) => e.runId)).toEqual(['good']);
  });

  it('under both bounds, every entry survives untouched', () => {
    const now = new Date('2026-08-08T00:00:00.000Z');
    const entries = [entry({ runId: 'a' }), entry({ runId: 'b' })];
    const out = trimPendingVerification(entries, now, 500, DEFAULT_MAX_PENDING_VERIFICATION_AGE_HOURS);
    expect(out).toHaveLength(2);
  });
});

const NOW = () => new Date('2026-08-08T00:00:00.000Z');

describe('VerificationPendingStore — restart survival', () => {
  it('a fresh store reading a store another instance wrote sees the same entries — the restart case', async () => {
    const backing = memStore();
    const writer = new VerificationPendingStore(backing, { now: NOW });
    await writer.put(entry({ runId: 'a', enqueuedAt: '2026-08-07T00:00:00.000Z' }));
    await writer.put(entry({ runId: 'b', enqueuedAt: '2026-08-07T00:00:00.000Z' }));

    const reader = new VerificationPendingStore(backing, { now: NOW });
    const survived = await reader.list();
    expect(survived.map((e) => e.runId).sort()).toEqual(['a', 'b']);
  });

  it('put persists the report payload byte-identically — a retry must resend it verbatim', async () => {
    const backing = memStore();
    const store = new VerificationPendingStore(backing, { now: NOW });
    const original = entry({
      enqueuedAt: '2026-08-07T00:00:00.000Z',
      report: report({
        citations: [
          { memoryItemId: 'mem_2', evidenceHash: 'abc', state: 'changed', baseId: 'b1', branch: 'main' },
        ],
      }),
    });
    await store.put(original);
    const [back] = await store.list();
    expect(back?.report).toEqual(original.report);
    expect(back?.agentToken).toBe(original.agentToken);
  });
});

describe('VerificationPendingStore — cleanup after acknowledgement', () => {
  it('remove drops exactly the acknowledged run and leaves the rest', async () => {
    const backing = memStore();
    const store = new VerificationPendingStore(backing, { now: NOW });
    await store.put(entry({ runId: 'a', enqueuedAt: '2026-08-07T00:00:00.000Z' }));
    await store.put(entry({ runId: 'b', enqueuedAt: '2026-08-07T00:00:00.000Z' }));
    await store.remove('a');
    expect((await store.list()).map((e) => e.runId)).toEqual(['b']);
  });

  it('removing an already-gone run is a no-op, never a throw', async () => {
    const backing = memStore();
    const store = new VerificationPendingStore(backing, { now: NOW });
    await store.put(entry({ runId: 'a', enqueuedAt: '2026-08-07T00:00:00.000Z' }));
    await expect(store.remove('nonexistent')).resolves.toBeUndefined();
    expect((await store.list()).map((e) => e.runId)).toEqual(['a']);
  });
});

describe('VerificationPendingStore — retention bounds enforced on write', () => {
  it('put trims to maxCount immediately — a queue that is only ever written to never exceeds it', async () => {
    const backing = memStore();
    const store = new VerificationPendingStore(backing, { maxCount: 2, now: NOW });
    await store.put(entry({ runId: 'a', enqueuedAt: '2026-08-01T00:00:00.000Z' }));
    await store.put(entry({ runId: 'b', enqueuedAt: '2026-08-02T00:00:00.000Z' }));
    await store.put(entry({ runId: 'c', enqueuedAt: '2026-08-03T00:00:00.000Z' }));
    const survivors = await store.list();
    expect(survivors).toHaveLength(2);
    expect(survivors.map((e) => e.runId)).toEqual(['b', 'c']);
  });

  it('re-enqueuing the SAME runId replaces the entry rather than duplicating it', async () => {
    const backing = memStore();
    const store = new VerificationPendingStore(backing, { now: NOW });
    await store.put(entry({ runId: 'a', enqueuedAt: '2026-08-01T00:00:00.000Z' }));
    await store.put(entry({ runId: 'a', enqueuedAt: '2026-08-02T00:00:00.000Z' }));
    const survivors = await store.list();
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.enqueuedAt).toBe('2026-08-02T00:00:00.000Z');
  });
});

describe('VerificationPendingStore — visibility (pending status must be VISIBLE, not merely persisted)', () => {
  it('summary reports the count and the oldest enqueuedAt', async () => {
    const backing = memStore();
    const store = new VerificationPendingStore(backing, { now: NOW });
    expect(await store.summary()).toEqual({ count: 0, oldestEnqueuedAt: null });
    await store.put(entry({ runId: 'a', enqueuedAt: '2026-08-05T00:00:00.000Z' }));
    await store.put(entry({ runId: 'b', enqueuedAt: '2026-08-03T00:00:00.000Z' }));
    expect(await store.summary()).toEqual({ count: 2, oldestEnqueuedAt: '2026-08-03T00:00:00.000Z' });
  });
});

describe('filePendingVerificationStore — corrupt file degrades to empty', () => {
  it('a store whose read throws is treated as empty by VerificationPendingStore, never as a crash', async () => {
    const broken: PendingVerificationFileStore = {
      read: async () => {
        throw new Error('disk read failed');
      },
      write: async () => {},
    };
    const store = new VerificationPendingStore(broken);
    await expect(store.list()).resolves.toEqual([]);
  });
});
