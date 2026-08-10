import { describe, expect, it } from 'vitest';
import { IndexJournal, type IndexJournalKey, type JournalStore } from '../src/index-journal';

// RUN-214 locked decision 5: the journal is DISPOSABLE and never authority, keyed by the full
// (server, repositoryKey, baseId, indexerVersion, generationId) tuple — a mismatch on any of the
// five is a miss, never a repair and never a partial reuse.

const memStore = (): JournalStore & { file: Record<string, unknown> } => {
  const state = { file: {} as Record<string, unknown> };
  return {
    get file() {
      return state.file;
    },
    read: async () => structuredClone(state.file) as never,
    write: async (f) => {
      state.file = structuredClone(f) as never;
    },
  };
};

const KEY = (over: Partial<IndexJournalKey> = {}): IndexJournalKey => ({
  server: 'https://noriq.test',
  repositoryKey: 'my-repo',
  baseId: 'base-1',
  indexerVersion: '1',
  generationId: 'gen_1',
  ...over,
});

describe('a hit is a hit only at the exact key', () => {
  it('returns what was recorded, at the same key', async () => {
    const journal = new IndexJournal(memStore());
    await journal.put(KEY(), { batchesUploaded: 2 });
    expect(await journal.get(KEY())).toMatchObject({ progress: { batchesUploaded: 2 } });
  });

  it('is a miss for a generation nobody has recorded', async () => {
    expect(await new IndexJournal(memStore()).get(KEY())).toBeNull();
  });

  it('is a miss when the baseId differs — never a partial reuse', async () => {
    const journal = new IndexJournal(memStore());
    await journal.put(KEY(), { batchesUploaded: 2 });
    expect(await journal.get(KEY({ baseId: 'base-2' }))).toBeNull();
  });

  it('is a miss when the indexerVersion differs', async () => {
    const journal = new IndexJournal(memStore());
    await journal.put(KEY(), { batchesUploaded: 2 });
    expect(await journal.get(KEY({ indexerVersion: '2' }))).toBeNull();
  });

  it('is a miss when the generationId differs — a different map path entirely', async () => {
    const journal = new IndexJournal(memStore());
    await journal.put(KEY(), { batchesUploaded: 2 });
    expect(await journal.get(KEY({ generationId: 'gen_2' }))).toBeNull();
  });

  it('keeps two servers’ progress apart, same repositoryKey', async () => {
    const store = memStore();
    await new IndexJournal(store).put(KEY({ server: 'https://a.test' }), { batchesUploaded: 1 });
    await new IndexJournal(store).put(KEY({ server: 'https://b.test' }), { batchesUploaded: 9 });
    expect((await new IndexJournal(store).get(KEY({ server: 'https://a.test' })))?.progress).toEqual({
      batchesUploaded: 1,
    });
    expect((await new IndexJournal(store).get(KEY({ server: 'https://b.test' })))?.progress).toEqual({
      batchesUploaded: 9,
    });
  });

  it('a corrupt store is a miss, never a thrown error', async () => {
    const broken: JournalStore = {
      read: async () => {
        throw new Error('disk read failed');
      },
      write: async () => {},
    };
    expect(await new IndexJournal(broken).get(KEY())).toBeNull();
  });

  it('a store returning a non-object shape is a miss, not a crash', async () => {
    const weird: JournalStore = { read: async () => null as never, write: async () => {} };
    expect(await new IndexJournal(weird).get(KEY())).toBeNull();
  });
});

describe('writing', () => {
  it('replaces the entry at the same key', async () => {
    const journal = new IndexJournal(memStore());
    await journal.put(KEY(), { batchesUploaded: 1 });
    await journal.put(KEY(), { batchesUploaded: 5 });
    expect((await journal.get(KEY()))?.progress).toEqual({ batchesUploaded: 5 });
  });

  it('forgetting a key removes only that key', async () => {
    const store = memStore();
    const journal = new IndexJournal(store);
    await journal.put(KEY(), { batchesUploaded: 1 });
    await journal.put(KEY({ generationId: 'gen_2' }), { batchesUploaded: 2 });
    await journal.forget(KEY());
    expect(await journal.get(KEY())).toBeNull();
    expect(await journal.get(KEY({ generationId: 'gen_2' }))).not.toBeNull();
  });

  it('forgetting an absent key is a no-op, never a throw', async () => {
    await expect(new IndexJournal(memStore()).forget(KEY())).resolves.toBeUndefined();
  });
});

describe('list (RUN-221 — the staging sweep’s only consumer)', () => {
  it('is empty for a fresh journal', async () => {
    expect(await new IndexJournal(memStore()).list()).toEqual([]);
  });

  it('returns every entry across servers, repos, and generations', async () => {
    const store = memStore();
    const journal = new IndexJournal(store);
    await journal.put(KEY(), { batchesUploaded: 1 });
    await journal.put(KEY({ generationId: 'gen_2' }), { batchesUploaded: 2 });
    await journal.put(KEY({ server: 'https://b.test', repositoryKey: 'other-repo' }), {
      batchesUploaded: 3,
    });
    const entries = await journal.list();
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.generationId).sort()).toEqual(['gen_1', 'gen_1', 'gen_2'].sort());
  });

  it('a corrupt store yields an empty list, never a throw', async () => {
    const broken: JournalStore = {
      read: async () => {
        throw new Error('disk read failed');
      },
      write: async () => {},
    };
    expect(await new IndexJournal(broken).list()).toEqual([]);
  });

  it('skips a malformed nested shape rather than throwing', async () => {
    const weird: JournalStore = {
      read: async () =>
        ({
          'https://noriq.test': { 'my-repo': null, 'other-repo': 'not-an-object' },
        }) as never,
      write: async () => {},
    };
    expect(await new IndexJournal(weird).list()).toEqual([]);
  });
});
