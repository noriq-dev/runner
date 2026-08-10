import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IndexReconcileOutcome } from '../src/index-reconcile';
import {
  IndexStatusStore,
  type IndexStatusStoreDeps,
  OPERATOR_INDEX_STATES,
  fileIndexStatusPersist,
  readIndexStatusSnapshot,
  reconcileOperatorState,
} from '../src/index-status';

const quiet = { info() {}, warn() {}, error() {}, debug() {} } as unknown as IndexStatusStoreDeps['logger'];

// RUN-223 locked decision 3: every `IndexReconcileOutcome` arm maps to exactly one operator-
// visible state. `reconcileOperatorState`'s own exhaustive switch (no `default`) already fails to
// COMPILE the moment a seventh arm is added without a decision about where it goes — this test
// asserts the same thing at the value level, and pins down what each arm maps to today, so a
// change to the mapping itself (not just a new arm) is visible in a diff.
describe('reconcileOperatorState — every IndexReconcileOutcome arm maps to exactly one state', () => {
  const SAMPLE_OUTCOMES: IndexReconcileOutcome[] = [
    { outcome: 'unchanged' },
    { outcome: 'incremental', fromBase: 'a', toBase: 'b' },
    { outcome: 'full', reason: 'no active generation' },
    { outcome: 'association-conflict', projectRepositoryId: 'prjrepo_1', reason: 'bound elsewhere' },
    { outcome: 'unavailable', reason: 'fetch failed' },
    { outcome: 'incompatible-version', activeIndexerVersion: '2', ourIndexerVersion: '1' },
  ];

  it('covers every arm — this list itself must name all six, or the test is not exhaustive', () => {
    const arms = new Set(SAMPLE_OUTCOMES.map((o) => o.outcome));
    expect(arms).toEqual(
      new Set([
        'unchanged',
        'incremental',
        'full',
        'association-conflict',
        'unavailable',
        'incompatible-version',
      ]),
    );
  });

  it('maps every arm to a value from the closed nine-state vocabulary', () => {
    for (const outcome of SAMPLE_OUTCOMES) {
      const state = reconcileOperatorState(outcome.outcome);
      expect(OPERATOR_INDEX_STATES).toContain(state);
    }
  });

  it('pins the exact mapping — a change here is a design decision, not an accident', () => {
    const mapped = Object.fromEntries(
      SAMPLE_OUTCOMES.map((o) => [o.outcome, reconcileOperatorState(o.outcome)]),
    );
    expect(mapped).toEqual({
      unchanged: 'unchanged',
      incremental: 'queued',
      full: 'queued',
      'association-conflict': 'association-conflict',
      unavailable: 'failed',
      'incompatible-version': 'failed',
    });
  });

  it('never produces no-opt-in — that state is answered locally, never by this function', () => {
    for (const outcome of SAMPLE_OUTCOMES) {
      expect(reconcileOperatorState(outcome.outcome)).not.toBe('no-opt-in');
    }
  });
});

describe('IndexStatusStore', () => {
  it('starts with no record for a repository that has never been observed', () => {
    const store = new IndexStatusStore({ now: () => 0, logger: quiet });
    expect(store.get('my-repo')).toBeUndefined();
    expect(store.snapshot()).toEqual([]);
  });

  it('a reconcile event sets state/detail/stateSince from the outcome', () => {
    const store = new IndexStatusStore({ now: () => 1000, logger: quiet });
    store.record({
      type: 'reconcile',
      repositoryKey: 'my-repo',
      outcome: { outcome: 'full', reason: 'no active generation on the server' },
    });
    const rec = store.get('my-repo');
    expect(rec?.state).toBe('queued');
    expect(rec?.detail).toContain('no active generation on the server');
    expect(rec?.stateSince).toBe(new Date(1000).toISOString());
    expect(rec?.lastError).toBeNull();
    expect(rec?.lastSuccess).toBeNull();
  });

  it('an unavailable/incompatible-version reconcile ALSO records a lastError — both fold to failed', () => {
    const store = new IndexStatusStore({ now: () => 1000, logger: quiet });
    store.record({
      type: 'reconcile',
      repositoryKey: 'my-repo',
      outcome: { outcome: 'unavailable', reason: 'network blip' },
    });
    const rec = store.get('my-repo');
    expect(rec?.state).toBe('failed');
    expect(rec?.lastError).toEqual({ message: 'network blip', at: new Date(1000).toISOString() });
    // An ordinary failure invites a retry — never flagged as blocked.
    expect(rec?.requiresUpgrade).toBe(false);
  });

  // RUN-223 round 2: `incompatible-version` is NOT an ordinary `failed` — retrying is pointless
  // until this daemon is upgraded, and that must be visible without parsing `detail`'s prose.
  describe('requiresUpgrade — incompatible-version is not an ordinary failure', () => {
    it('an incompatible-version reconcile sets requiresUpgrade AND prefixes detail unmistakably', () => {
      const store = new IndexStatusStore({ now: () => 1000, logger: quiet });
      store.record({
        type: 'reconcile',
        repositoryKey: 'my-repo',
        outcome: { outcome: 'incompatible-version', activeIndexerVersion: '2', ourIndexerVersion: '1' },
      });
      const rec = store.get('my-repo');
      expect(rec?.state).toBe('failed');
      expect(rec?.requiresUpgrade).toBe(true);
      expect(rec?.detail).toMatch(/^UPGRADE REQUIRED —/);
    });

    it('an ordinary unavailable failure does NOT set requiresUpgrade', () => {
      const store = new IndexStatusStore({ now: () => 1000, logger: quiet });
      store.record({
        type: 'reconcile',
        repositoryKey: 'my-repo',
        outcome: { outcome: 'unavailable', reason: 'network blip' },
      });
      expect(store.get('my-repo')?.requiresUpgrade).toBe(false);
    });

    it('requiresUpgrade clears on the NEXT observation once the situation has moved on', () => {
      const store = new IndexStatusStore({ now: () => 1000, logger: quiet });
      store.record({
        type: 'reconcile',
        repositoryKey: 'my-repo',
        outcome: { outcome: 'incompatible-version', activeIndexerVersion: '2', ourIndexerVersion: '1' },
      });
      expect(store.get('my-repo')?.requiresUpgrade).toBe(true);

      // The daemon was upgraded (or the server's active generation changed) — the next reconcile
      // is ordinary again, and a stale `true` here would be its own lie.
      store.record({
        type: 'reconcile',
        repositoryKey: 'my-repo',
        outcome: { outcome: 'unchanged' },
      });
      expect(store.get('my-repo')?.requiresUpgrade).toBe(false);
    });
  });

  it('phase events move through parsing/uploading/server-validating', () => {
    const store = new IndexStatusStore({ now: () => 2000, logger: quiet });
    store.record({ type: 'phase', repositoryKey: 'my-repo', phase: 'parsing' });
    expect(store.get('my-repo')?.state).toBe('parsing');
    store.record({ type: 'phase', repositoryKey: 'my-repo', phase: 'uploading', detail: '3 batch(es)' });
    expect(store.get('my-repo')?.state).toBe('uploading');
    expect(store.get('my-repo')?.detail).toBe('3 batch(es)');
    store.record({ type: 'phase', repositoryKey: 'my-repo', phase: 'server-validating' });
    expect(store.get('my-repo')?.state).toBe('server-validating');
  });

  it('a current-server success receipt records active + lastSuccess and keeps prior error history', () => {
    const store = new IndexStatusStore({ now: () => 3000, logger: quiet });
    store.record({ type: 'failure', repositoryKey: 'my-repo', detail: 'earlier attempt broke' });
    store.record({
      type: 'success',
      repositoryKey: 'my-repo',
      generationId: 'gen_1',
      baseId: 'base-1',
      batchesReceived: 4,
      activated: 'gen_1',
    });
    const rec = store.get('my-repo');
    expect(rec?.state).toBe('active');
    expect(rec?.detail).toContain('atomically activated');
    expect(rec?.lastSuccess).toEqual({
      at: new Date(3000).toISOString(),
      generationId: 'gen_1',
      baseId: 'base-1',
      batchesReceived: 4,
    });
    // History, not amnesia: a fresh success does not erase what the last error WAS.
    expect(rec?.lastError?.message).toBe('earlier attempt broke');
  });

  it('keeps a success without an activation receipt staged for older-server compatibility', () => {
    const store = new IndexStatusStore({ now: () => 3000, logger: quiet });
    store.record({
      type: 'success',
      repositoryKey: 'my-repo',
      generationId: 'gen_legacy',
      baseId: 'base-1',
      batchesReceived: 4,
    });
    expect(store.get('my-repo')?.state).toBe('staged');
    expect(store.get('my-repo')?.detail).toContain('did not confirm activation');
  });

  // `active` may be reported only from server evidence: either complete()'s activation receipt or
  // the cursor's activeGeneration threaded through reconcile.
  describe('active is reported only from explicit server evidence', () => {
    it('an unchanged reconcile carrying activeGenerationId promotes straight to active', () => {
      const store = new IndexStatusStore({ now: () => 7000, logger: quiet });
      store.record({
        type: 'reconcile',
        repositoryKey: 'my-repo',
        outcome: { outcome: 'unchanged' },
        activeGenerationId: 'gen_42',
      });
      const rec = store.get('my-repo');
      expect(rec?.state).toBe('active');
      expect(rec?.detail).toContain('gen_42');
    });

    it('an unchanged reconcile with no activeGenerationId does NOT promote to active', () => {
      const store = new IndexStatusStore({ now: () => 7000, logger: quiet });
      store.record({
        type: 'reconcile',
        repositoryKey: 'my-repo',
        outcome: { outcome: 'unchanged' },
      });
      expect(store.get('my-repo')?.state).not.toBe('active');
    });

    it('a legacy staged record is promoted to active by the next reconcile confirming activation', () => {
      const store = new IndexStatusStore({ now: () => 8000, logger: quiet });
      store.record({
        type: 'success',
        repositoryKey: 'my-repo',
        generationId: 'gen_9',
        baseId: 'base-9',
        batchesReceived: 2,
      });
      expect(store.get('my-repo')?.state).toBe('staged');

      store.record({
        type: 'reconcile',
        repositoryKey: 'my-repo',
        outcome: { outcome: 'unchanged' },
        activeGenerationId: 'gen_9',
      });
      expect(store.get('my-repo')?.state).toBe('active');
      // lastSuccess survives the transition — it is history, not overwritten by a reconcile.
      expect(store.get('my-repo')?.lastSuccess?.generationId).toBe('gen_9');
    });

    it('a full/incremental reconcile never promotes to active, even with activeGenerationId set', () => {
      const store = new IndexStatusStore({ now: () => 9000, logger: quiet });
      store.record({
        type: 'reconcile',
        repositoryKey: 'my-repo',
        outcome: { outcome: 'full', reason: 'active generation older than ours' },
        activeGenerationId: 'gen_1',
      });
      expect(store.get('my-repo')?.state).toBe('queued');
    });
  });

  it('a failure event records failed + lastError, and keeps a prior lastSuccess as history', () => {
    const store = new IndexStatusStore({ now: () => 4000, logger: quiet });
    store.record({
      type: 'success',
      repositoryKey: 'my-repo',
      generationId: 'gen_1',
      baseId: 'base-1',
      batchesReceived: 1,
    });
    store.record({ type: 'failure', repositoryKey: 'my-repo', detail: 'validation rejected' });
    const rec = store.get('my-repo');
    expect(rec?.state).toBe('failed');
    expect(rec?.lastError).toEqual({ message: 'validation rejected', at: new Date(4000).toISOString() });
    expect(rec?.lastSuccess?.generationId).toBe('gen_1');
  });

  it('persists a full snapshot after every mutation, best-effort', async () => {
    const writes: unknown[][] = [];
    const store = new IndexStatusStore({
      now: () => 5000,
      logger: quiet,
      persist: async (records) => {
        writes.push(records);
      },
    });
    store.record({ type: 'phase', repositoryKey: 'repo-a', phase: 'parsing' });
    await Promise.resolve(); // let the fire-and-forget persist settle
    expect(writes).toHaveLength(1);
    expect((writes[0] as { repositoryKey: string }[])[0]?.repositoryKey).toBe('repo-a');
  });

  it('a throwing persist never surfaces to the caller of record()', () => {
    const store = new IndexStatusStore({
      now: () => 6000,
      logger: quiet,
      persist: async () => {
        throw new Error('disk full');
      },
    });
    expect(() => store.record({ type: 'phase', repositoryKey: 'repo-a', phase: 'parsing' })).not.toThrow();
  });
});

describe('disk persistence — mode 0600, temp-and-rename, corrupt-read-is-a-miss', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'noriq-index-status-'));
    file = path.join(dir, 'index-status.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes mode 0600 and round-trips through readIndexStatusSnapshot', async () => {
    const persist = fileIndexStatusPersist(file);
    await persist([
      {
        repositoryKey: 'my-repo',
        state: 'active',
        stateSince: '2026-08-09T00:00:00.000Z',
        detail: null,
        lastError: null,
        lastSuccess: {
          at: '2026-08-09T00:00:00.000Z',
          generationId: 'gen_1',
          baseId: 'b1',
          batchesReceived: 2,
        },
        indexerVersion: '1',
        requiresUpgrade: false,
      },
    ]);
    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
    const back = await readIndexStatusSnapshot(file);
    expect(back).toHaveLength(1);
    expect(back[0]?.repositoryKey).toBe('my-repo');
  });

  it('a missing file reads as an empty list, never a throw', async () => {
    await expect(readIndexStatusSnapshot(path.join(dir, 'nope.json'))).resolves.toEqual([]);
  });

  it('a corrupt file reads as an empty list, never a throw', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, 'not json{{{');
    await expect(readIndexStatusSnapshot(file)).resolves.toEqual([]);
  });

  it('leaves no temp file behind after a successful write', async () => {
    await fileIndexStatusPersist(file)([]);
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(dir);
    expect(entries).toEqual(['index-status.json']);
  });

  it('a shape that is not an array reads as an empty list', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, JSON.stringify({ not: 'an array' }));
    await expect(readIndexStatusSnapshot(file)).resolves.toEqual([]);
    // Sanity the file really was well-formed JSON, just the wrong shape — proves the guard is a
    // SHAPE check, not merely catching a parse error.
    const raw = await readFile(file, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
