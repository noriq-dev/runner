import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkVendorProvenance } from '../scripts/vendor-check.mjs';
import { hashTree } from '../scripts/vendor-provenance.mjs';

/**
 * RUN-240: the check half of vendored-contract provenance, proven against a TEMP directory —
 * never this repo's own committed `vendor/noriq-shared/src` (which this task's own report proves
 * separately, live, by hand-editing and restoring it) and never a real Noriq checkout. This is the
 * permanent regression coverage; the live demonstration is a one-time proof this task's report
 * quotes verbatim.
 */

describe('checkVendorProvenance (RUN-240)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'noriq-vendor-check-'));
    await writeFile(path.join(dir, 'a.ts'), 'export const a = 1;\n');
    await writeFile(path.join(dir, 'b.ts'), 'export const b = 2;\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('passes on an untouched tree', async () => {
    const provenance = { sourceCommit: 'deadbeef', sourceDirty: false, files: await hashTree(dir) };
    const result = await checkVendorProvenance(dir, provenance);
    expect(result).toEqual({ ok: true, problems: [] });
  });

  it('fails on a hand-edited file — a hash mismatch, named', async () => {
    const provenance = { sourceCommit: 'deadbeef', sourceDirty: false, files: await hashTree(dir) };
    await writeFile(path.join(dir, 'a.ts'), 'export const a = 1; // hand-edited\n');

    const result = await checkVendorProvenance(dir, provenance);

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(['hash mismatch: a.ts (hand-edited since it was vendored)']);
  });

  it('fails on a partially-refreshed directory (a file the record names is gone) — never compiles into a silently mixed contract', async () => {
    const provenance = { sourceCommit: 'deadbeef', sourceDirty: false, files: await hashTree(dir) };
    await rm(path.join(dir, 'b.ts'));

    const result = await checkVendorProvenance(dir, provenance);

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(['missing: b.ts (recorded in provenance, absent on disk)']);
  });

  it('fails on an extra file the record never accounted for — the other half of an interrupted refresh', async () => {
    const provenance = { sourceCommit: 'deadbeef', sourceDirty: false, files: await hashTree(dir) };
    await writeFile(path.join(dir, 'c.ts'), 'export const c = 3;\n');

    const result = await checkVendorProvenance(dir, provenance);

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(['extra: c.ts (on disk, not recorded in provenance)']);
  });

  it('fails with no provenance record at all, rather than treating absence as trivially passing', async () => {
    const result = await checkVendorProvenance(dir, null);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('no provenance record');
  });
});
