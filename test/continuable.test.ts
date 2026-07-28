import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContinuableStore } from '../src/continuable';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'noriq-cont-'));
  file = path.join(dir, 'continuable-runs.json');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const entry = (over: Partial<Parameters<ContinuableStore['put']>[0]> = {}) => ({
  runId: 'run_1',
  spent: { tokens: 1000, usd: 0.5 },
  ledger: [],
  failedAt: '2026-07-17T00:00:00.000Z',
  ...over,
});

describe('ContinuableStore', () => {
  it('round-trips a record through disk (a restart between fail and continue must not lose it)', async () => {
    await new ContinuableStore(file).put(entry({ spent: { tokens: 1234, usd: 0.9 } }));
    // A FRESH store (no shared cache) reads it back — the on-disk state, not memory.
    const got = await new ContinuableStore(file).get('run_1');
    expect(got?.spent).toEqual({ tokens: 1234, usd: 0.9 });
  });

  it('put replaces in place — a re-failed continuation refreshes rather than appends', async () => {
    const store = new ContinuableStore(file);
    await store.put(entry({ spent: { tokens: 1000, usd: 0.5 } }));
    await store.put(entry({ spent: { tokens: 1500, usd: 0.8 } })); // the next sitting's cumulative
    expect((await store.get('run_1'))?.spent.tokens).toBe(1500);
    expect(await new ContinuableStore(file).get('run_1')).not.toBeNull();
  });

  it('remove drops the record; a resolved run leaves nothing to continue', async () => {
    const store = new ContinuableStore(file);
    await store.put(entry());
    await store.remove('run_1');
    expect(await store.get('run_1')).toBeNull();
    expect(await new ContinuableStore(file).get('run_1')).toBeNull();
  });

  it('a missing file reads as empty rather than throwing', async () => {
    expect(await new ContinuableStore(path.join(dir, 'nope.json')).get('run_1')).toBeNull();
  });

  it('a corrupt file degrades to empty — a lost record never strands the daemon', async () => {
    await writeFile(file, '{ this is not json');
    const store = new ContinuableStore(file);
    expect(await store.get('run_1')).toBeNull();
    // …and it recovers: a put after the corrupt read writes a clean file.
    await store.put(entry());
    expect(await new ContinuableStore(file).get('run_1')).not.toBeNull();
  });
});
