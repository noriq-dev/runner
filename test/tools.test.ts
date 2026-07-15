import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectTools } from '../src/tools';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'noriq-tools-'));
  await writeFile(path.join(dir, 'claude'), '#!/bin/sh\n');
  // no 'codex' → should not be detected
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('detectTools', () => {
  it('detects executables present on PATH', () => {
    expect(detectTools({ PATH: dir })).toEqual(['claude']);
  });

  it('returns [] when PATH is empty', () => {
    expect(detectTools({ PATH: '' })).toEqual([]);
    expect(detectTools({})).toEqual([]);
  });
});
