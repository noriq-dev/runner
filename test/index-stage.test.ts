import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexJournal, type IndexJournalKey, type JournalStore } from '../src/index-journal';
import { fileStagingStore, stagingDirFor, stagingId, sweepOrphanedStaging } from '../src/index-stage';

// RUN-221 locked decision 6/7/discretion 2: local staging under `~/.noriq/`, keyed by a directory
// derivable from the journal key alone, swept ONLY on startup.

const KEY = (over: Partial<IndexJournalKey> = {}): IndexJournalKey => ({
  server: 'https://noriq.test',
  repositoryKey: 'my-repo',
  baseId: 'base-1',
  indexerVersion: '1',
  generationId: 'gen_1',
  ...over,
});

const memJournalStore = (): JournalStore & { file: Record<string, unknown> } => {
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

describe('stagingId / stagingDirFor', () => {
  it('is deterministic for the same key', () => {
    expect(stagingId(KEY())).toBe(stagingId(KEY()));
  });

  it('differs when any of the five key fields differs', () => {
    const base = stagingId(KEY());
    expect(stagingId(KEY({ server: 'https://other.test' }))).not.toBe(base);
    expect(stagingId(KEY({ repositoryKey: 'other-repo' }))).not.toBe(base);
    expect(stagingId(KEY({ baseId: 'base-2' }))).not.toBe(base);
    expect(stagingId(KEY({ indexerVersion: '2' }))).not.toBe(base);
    expect(stagingId(KEY({ generationId: 'gen_2' }))).not.toBe(base);
  });

  it('the directory sits under the given root, named by the id alone', () => {
    const dir = stagingDirFor(KEY(), '/tmp/root');
    expect(dir).toBe(path.join('/tmp/root', stagingId(KEY())));
  });
});

describe('fileStagingStore (real filesystem)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'noriq-index-stage-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes a batch and reads it back byte-identical', async () => {
    const store = fileStagingStore(root);
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await store.writeBatch(KEY(), 0, bytes);
    const readBack = await store.readBatch(KEY(), 0);
    expect(readBack).not.toBeNull();
    expect([...(readBack as Buffer)]).toEqual([1, 2, 3, 4, 5]);
  });

  it('readBatch is a miss (null), never a throw, for a batch never written', async () => {
    const store = fileStagingStore(root);
    expect(await store.readBatch(KEY(), 7)).toBeNull();
  });

  it('readBatch is a miss for an entirely unknown key', async () => {
    const store = fileStagingStore(root);
    await store.writeBatch(KEY(), 0, new Uint8Array([1]));
    expect(await store.readBatch(KEY({ generationId: 'gen_other' }), 0)).toBeNull();
  });

  it('clear removes the whole directory, and is a no-op on a key never staged', async () => {
    const store = fileStagingStore(root);
    await store.writeBatch(KEY(), 0, new Uint8Array([1]));
    await store.writeBatch(KEY(), 1, new Uint8Array([2]));
    const dir = stagingDirFor(KEY(), root);
    expect(existsSync(dir)).toBe(true);
    await store.clear(KEY());
    expect(existsSync(dir)).toBe(false);
    await expect(store.clear(KEY({ generationId: 'gen_never_staged' }))).resolves.toBeUndefined();
  });

  it('two different keys stage into two different directories', async () => {
    const store = fileStagingStore(root);
    await store.writeBatch(KEY(), 0, new Uint8Array([1]));
    await store.writeBatch(KEY({ generationId: 'gen_2' }), 0, new Uint8Array([2]));
    const entries = await readdir(root);
    expect(entries).toHaveLength(2);
  });
});

describe('sweepOrphanedStaging (real filesystem, startup-only by contract)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'noriq-index-stage-sweep-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('removes a staging directory with no journal entry at all', async () => {
    const store = fileStagingStore(root);
    await store.writeBatch(KEY(), 0, new Uint8Array([1]));
    const journal = new IndexJournal(memJournalStore());
    const { removed } = await sweepOrphanedStaging(journal, root);
    expect(removed).toEqual([stagingId(KEY())]);
    expect(existsSync(stagingDirFor(KEY(), root))).toBe(false);
  });

  it('spares a staging directory with a live journal entry for the exact same key', async () => {
    const store = fileStagingStore(root);
    await store.writeBatch(KEY(), 0, new Uint8Array([1]));
    const journal = new IndexJournal(memJournalStore());
    await journal.put(KEY(), { batchesConfirmed: 0, batchCount: 1, staged: true });
    const { removed } = await sweepOrphanedStaging(journal, root);
    expect(removed).toEqual([]);
    expect(existsSync(stagingDirFor(KEY(), root))).toBe(true);
  });

  it('removes an orphan while sparing a live directory in the same sweep', async () => {
    const store = fileStagingStore(root);
    const liveKey = KEY({ generationId: 'gen_live' });
    const orphanKey = KEY({ generationId: 'gen_orphan' });
    await store.writeBatch(liveKey, 0, new Uint8Array([1]));
    await store.writeBatch(orphanKey, 0, new Uint8Array([2]));
    const journal = new IndexJournal(memJournalStore());
    await journal.put(liveKey, { batchesConfirmed: 0, batchCount: 1, staged: true });
    const { removed } = await sweepOrphanedStaging(journal, root);
    expect(removed).toEqual([stagingId(orphanKey)]);
    expect(existsSync(stagingDirFor(liveKey, root))).toBe(true);
    expect(existsSync(stagingDirFor(orphanKey, root))).toBe(false);
  });

  it('a journal entry for a DIFFERENT key does not spare this one — full key match, not "any entry"', async () => {
    const store = fileStagingStore(root);
    await store.writeBatch(KEY(), 0, new Uint8Array([1]));
    const journal = new IndexJournal(memJournalStore());
    await journal.put(KEY({ baseId: 'base-2' }), { batchesConfirmed: 0, batchCount: 1, staged: true });
    const { removed } = await sweepOrphanedStaging(journal, root);
    expect(removed).toEqual([stagingId(KEY())]);
  });

  it('a missing staging root is not an error — empty removal, no throw', async () => {
    const journal = new IndexJournal(memJournalStore());
    const missingRoot = path.join(root, 'does-not-exist');
    await expect(sweepOrphanedStaging(journal, missingRoot)).resolves.toEqual({ removed: [] });
  });

  it('a corrupt journal store still lets the sweep run — nothing is spared, nothing throws', async () => {
    const store = fileStagingStore(root);
    await store.writeBatch(KEY(), 0, new Uint8Array([1]));
    const broken: JournalStore = {
      read: async () => {
        throw new Error('disk read failed');
      },
      write: async () => {},
    };
    const { removed } = await sweepOrphanedStaging(new IndexJournal(broken), root);
    expect(removed).toEqual([stagingId(KEY())]);
  });
});
