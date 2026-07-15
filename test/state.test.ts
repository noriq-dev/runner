import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadState, saveState } from '../src/state';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'noriq-state-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('runner state', () => {
  it('round-trips the runnerId (creating parent dirs)', async () => {
    const p = path.join(dir, 'nested', 'runner-state.json');
    await saveState({ runnerId: 'rnr_42' }, p);
    expect(await loadState(p)).toEqual({ runnerId: 'rnr_42' });
  });

  it('returns {} for a missing state file', async () => {
    expect(await loadState(path.join(dir, 'nope.json'))).toEqual({});
  });

  it('returns {} for a corrupt state file', async () => {
    const p = path.join(dir, 'corrupt.json');
    await writeFile(p, 'not json');
    expect(await loadState(p)).toEqual({});
  });
});
