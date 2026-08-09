import { createHash, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { IndexGenerationManifest } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import {
  MAX_INGEST_BATCH_BYTES,
  assembleManifest,
  computeBatchHash,
  computeContentHash,
  deriveGenerationId,
  encodeBatches,
  sortRecords,
  toStagedRow,
} from '../src/index-batch';
import type { EdgeRecord, EntityRecord, IndexRecord } from '../src/index-entity';

/**
 * A local mirror of the server's `parseStagedRow`
 * (/var/home/mtuska/git/noriq/noriq/apps/api/src/memory/ingest.ts) — read, never imported (a
 * different trust/deploy boundary), and never modified. This is the "asserted by a local check
 * mirroring `parseStagedRow`" acceptance line: every row this indexer produces must satisfy these
 * exact required-field checks, independent of whatever `StagedNodeRow`/`StagedEdgeRow` TypeScript
 * shapes claim at compile time.
 */
function assertSatisfiesServerRowContract(input: object): void {
  const row = input as Record<string, unknown>;
  if (row.kind === 'node') {
    expect(typeof row.uri === 'string' && row.uri.length > 0).toBe(true);
    expect(typeof row.type === 'string' && row.type.length > 0).toBe(true);
    expect(typeof row.label === 'string' && row.label.length > 0).toBe(true);
    expect(row.content === null || typeof row.content === 'string').toBe(true);
    return;
  }
  if (row.kind === 'edge') {
    expect(typeof row.type === 'string' && row.type.length > 0).toBe(true);
    expect(typeof row.from === 'string' && row.from.length > 0).toBe(true);
    expect(typeof row.to === 'string' && row.to.length > 0).toBe(true);
    return;
  }
  throw new Error(`unknown row kind: ${JSON.stringify(row.kind)}`);
}

const node = (over: Partial<EntityRecord> = {}): EntityRecord => ({
  kind: 'node',
  uri: 'noriq://file/RUN/runner/a.ts',
  type: 'file',
  label: 'a.ts',
  content: 'export {}',
  ...over,
});

const edge = (over: Partial<EdgeRecord> = {}): EdgeRecord => ({
  kind: 'edge',
  type: 'declares',
  from: 'noriq://file/RUN/runner/a.ts',
  to: 'noriq://symbol/RUN/runner/a.ts#foo',
  ...over,
});

describe('toStagedRow / server row contract', () => {
  it('produces a row satisfying the server-mirrored contract for a node', () => {
    assertSatisfiesServerRowContract(toStagedRow(node()));
  });

  it('produces a row satisfying the server-mirrored contract for an edge', () => {
    assertSatisfiesServerRowContract(toStagedRow(edge()));
  });

  it('carries a null content through for a metadata-mode entity', () => {
    const row = toStagedRow(node({ content: null }));
    expect(row).toMatchObject({ content: null });
    assertSatisfiesServerRowContract(row);
  });

  it('never adds a field beyond the server-mirrored shape', () => {
    expect(Object.keys(toStagedRow(node())).sort()).toEqual(['content', 'kind', 'label', 'type', 'uri']);
    expect(Object.keys(toStagedRow(edge())).sort()).toEqual(['from', 'kind', 'to', 'type']);
  });
});

describe('sortRecords', () => {
  it('orders nodes before edges', () => {
    const out = sortRecords([edge(), node()]);
    expect(out.map((r) => r.kind)).toEqual(['node', 'edge']);
  });

  it('sorts nodes by uri with a plain code-unit comparison, not locale-aware', () => {
    const upper = node({ uri: 'noriq://file/RUN/runner/B.ts', label: 'B.ts' });
    const lower = node({ uri: 'noriq://file/RUN/runner/a.ts', label: 'a.ts' });
    const out = sortRecords([lower, upper]);
    // Plain code-unit order puts uppercase 'B' (0x42) before lowercase 'a' (0x61) — a
    // locale-aware compare (`localeCompare`) would put them the other way round on most locales.
    expect(out.map((r) => (r as EntityRecord).uri)).toEqual([upper.uri, lower.uri]);
  });

  it('is stable and reproducible across repeated calls on the same input', () => {
    const records: IndexRecord[] = [node({ uri: 'z' }), edge(), node({ uri: 'a' })];
    expect(sortRecords(records)).toEqual(sortRecords(records));
  });

  it('sorts edges by (from, type, to)', () => {
    const e1 = edge({ from: 'b', to: 'x' });
    const e2 = edge({ from: 'a', to: 'y' });
    const out = sortRecords([e1, e2]);
    expect(out).toEqual([e2, e1]);
  });
});

describe('deriveGenerationId', () => {
  const base = {
    projectId: 'proj_1',
    repositoryKey: 'runner',
    branch: 'main',
    baseId: 'sha1',
    indexerVersion: '1',
  };

  it('is deterministic for identical input', () => {
    expect(deriveGenerationId(base)).toBe(deriveGenerationId({ ...base }));
  });

  it('never calls Date.now or Math.random — same input always yields the same id', () => {
    const first = deriveGenerationId(base);
    const second = deriveGenerationId(base);
    expect(first).toBe(second);
  });

  for (const field of ['projectId', 'repositoryKey', 'branch', 'baseId', 'indexerVersion'] as const) {
    it(`changes when ${field} changes`, () => {
      const changed = { ...base, [field]: `${base[field]}-different` };
      expect(deriveGenerationId(changed)).not.toBe(deriveGenerationId(base));
    });
  }
});

describe('computeContentHash', () => {
  it('is identical for identical sorted records', () => {
    const records = sortRecords([node(), edge()]);
    expect(computeContentHash(records)).toBe(computeContentHash(sortRecords([node(), edge()])));
  });

  it('changes when any record changes', () => {
    const a = sortRecords([node()]);
    const b = sortRecords([node({ label: 'different' })]);
    expect(computeContentHash(a)).not.toBe(computeContentHash(b));
  });
});

describe('encodeBatches', () => {
  it('always produces at least one batch, even for zero records', () => {
    const batches = encodeBatches('gen_1', []);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.rowCount).toBe(0);
    expect(batches[0]?.batchNumber).toBe(0);
  });

  it('batchHash is the SHA-256 of the compressed bytes, independently verifiable', () => {
    const batches = encodeBatches('gen_1', sortRecords([node()]));
    const batch = batches[0]!;
    const expected = createHash('sha256').update(batch.compressed).digest('hex');
    expect(batch.batchHash).toBe(expected);
  });

  it('decompresses back to the exact canonical JSONL of the sorted rows', () => {
    const records = sortRecords([node(), edge()]);
    const batches = encodeBatches('gen_1', records);
    const decompressed = gunzipSync(batches[0]!.compressed).toString('utf8');
    const expectedLines = records.map((r) => {
      const row = toStagedRow(r);
      const sortedKeys = Object.keys(row).sort();
      const obj: Record<string, unknown> = {};
      for (const k of sortedKeys) obj[k] = (row as unknown as Record<string, unknown>)[k];
      return JSON.stringify(obj);
    });
    expect(decompressed).toBe(`${expectedLines.join('\n')}\n`);
  });

  it('never exceeds MAX_INGEST_BATCH_BYTES compressed', () => {
    const batches = encodeBatches('gen_1', sortRecords([node()]));
    for (const batch of batches) expect(batch.compressed.length).toBeLessThanOrEqual(MAX_INGEST_BATCH_BYTES);
  });

  it('splits into multiple batches once the uncompressed budget is exceeded', () => {
    const records: IndexRecord[] = Array.from({ length: 20 }, (_, i) =>
      node({ uri: `noriq://file/RUN/runner/f${i}.ts`, label: `f${i}.ts`, content: 'x'.repeat(500) }),
    );
    const batches = encodeBatches('gen_1', sortRecords(records), { maxUncompressedBytes: 2_000 });
    expect(batches.length).toBeGreaterThan(1);
    // Batch numbers are contiguous starting at 0, and every row across every batch accounts for
    // exactly the input records — no record dropped, none duplicated.
    expect(batches.map((b) => b.batchNumber)).toEqual(batches.map((_, i) => i));
    const totalRows = batches.reduce((sum, b) => sum + b.rowCount, 0);
    expect(totalRows).toBe(records.length);
  });

  it('stamps every batch with the same generationId', () => {
    const records: IndexRecord[] = Array.from({ length: 10 }, (_, i) =>
      node({ uri: `noriq://file/RUN/runner/f${i}.ts`, label: `f${i}.ts`, content: 'x'.repeat(200) }),
    );
    const batches = encodeBatches('gen_shared', sortRecords(records), { maxUncompressedBytes: 500 });
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) expect(batch.generationId).toBe('gen_shared');
  });

  it('stays under the real 8 MiB ceiling for a large batch of poorly-compressible content', () => {
    // Base64 has a limited (64-symbol) alphabet, so it still compresses somewhat — this is a
    // realistic stress test of the DEFAULT (non-overridden) safety margin, not a claim that gzip
    // can never compress it at all. The correctness guarantee itself rests on DEFLATE's bounded
    // worst-case framing overhead (see index-batch.ts's module doc), not on this test.
    const bigRecord = node({ content: randomBytes(6_000_000).toString('base64') });
    const batches = encodeBatches('gen_1', sortRecords([bigRecord]));
    for (const batch of batches) expect(batch.compressed.length).toBeLessThanOrEqual(MAX_INGEST_BATCH_BYTES);
  });
});

describe('assembleManifest', () => {
  it('produces a zod-valid IndexGenerationManifest', () => {
    const manifest = assembleManifest({
      generationId: 'gen_1',
      projectId: 'proj_1',
      repositoryKey: 'runner',
      branch: 'main',
      baseId: 'sha1',
      indexerVersion: '1',
      batchCount: 1,
      fileCount: 3,
      contentHash: 'abc123',
      deletions: ['old.ts'],
      now: () => Date.UTC(2026, 0, 1),
    });
    expect(() => IndexGenerationManifest.parse(manifest)).not.toThrow();
    expect(manifest.createdAt).toBe(new Date(Date.UTC(2026, 0, 1)).toISOString());
  });

  it("copies the deletions array rather than aliasing the caller's", () => {
    const deletions = ['a.ts'];
    const manifest = assembleManifest({
      generationId: 'gen_1',
      projectId: 'p',
      repositoryKey: 'r',
      branch: 'main',
      baseId: 'b',
      indexerVersion: '1',
      batchCount: 1,
      fileCount: 0,
      contentHash: 'x',
      deletions,
      now: () => 0,
    });
    deletions.push('b.ts');
    expect(manifest.deletions).toEqual(['a.ts']);
  });
});

describe('computeBatchHash', () => {
  it('matches an independently computed SHA-256 of the same bytes', () => {
    const bytes = Buffer.from('hello');
    expect(computeBatchHash(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
});
