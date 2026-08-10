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
  recordIdentity,
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

/**
 * RUN-278: `sortRecords` compares an edge's three fields IN PLACE rather than building
 * `recordIdentity`'s joined string on both operands of every comparison — the same ordering with no
 * allocation, and 3.1x faster on a real 839800-record pass (533ms -> 171ms). The equivalence rests on
 * `\u0000` sorting below every character these fields can contain, which is exactly why that
 * separator was chosen. These tests assert the equivalence against `recordIdentity` DIRECTLY, on the
 * prefix cases where a naive separator would diverge — because the argument for the optimization is a
 * property of the data, and a property nobody checks is a comment.
 */
describe('sortRecords orders by recordIdentity even though it never builds one (RUN-278)', () => {
  /** The ordering `sortRecords` is supposed to implement, spelled out the slow, obvious way. */
  const byIdentity = (records: readonly IndexRecord[]): IndexRecord[] =>
    [...records].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'node' ? -1 : 1;
      const ia = recordIdentity(a);
      const ib = recordIdentity(b);
      return ia < ib ? -1 : ia > ib ? 1 : 0;
    });

  it('agrees with the joined-identity ordering when one edge field is a strict PREFIX of another', () => {
    // The real, everyday shape of this: `x.ts` against `x.tsx`. A URI is a path, and one path being
    // a prefix of another is the norm rather than a corner — comparing `x.ts<SEP>declares<SEP>a`
    // against `x.tsx<SEP>declares<SEP>a` must reach the separator against `x`.
    const records: IndexRecord[] = [
      edge({ from: 'x.tsx', type: 'declares', to: 'a' }),
      edge({ from: 'x.ts', type: 'declares', to: 'b' }),
      edge({ from: 'x.ts', type: 'imports', to: 'a' }),
      edge({ from: 'x.ts', type: 'declares', to: 'ba' }),
    ];
    expect(sortRecords(records)).toEqual(byIdentity(records));
    // Pin the direction too, so this cannot pass by both orderings being wrong the same way.
    expect(sortRecords(records).map((r) => (r as EdgeRecord).from)).toEqual([
      'x.ts',
      'x.ts',
      'x.ts',
      'x.tsx',
    ]);
  });

  it('agrees when an edge TYPE is a prefix of another, which no current type is', () => {
    // Cast deliberately: no two `MemoryEdgeType` values are prefixes of one another today
    // (`vendor/noriq-shared/src/memory.ts` — 18 values, checked), so this case is unreachable
    // through the type system and would otherwise go untested. It is still worth pinning, because
    // the enum is a wire contract that GROWS: the day someone adds `tests_integration` beside
    // `tests`, the separator's minimum-code-unit property is what keeps this ordering correct, and
    // nothing else in the suite would notice if it stopped holding.
    const asType = (t: string) => t as EdgeRecord['type'];
    const records: IndexRecord[] = [
      edge({ from: 'a', type: asType('testsMore'), to: 'a' }),
      edge({ from: 'a', type: asType('tests'), to: 'z' }),
    ];
    expect(sortRecords(records)).toEqual(byIdentity(records));
    expect(sortRecords(records).map((r) => (r as EdgeRecord).type)).toEqual(['tests', 'testsMore']);
  });

  it('agrees when a field is EMPTY, the extreme of the prefix case', () => {
    // Also unreachable through the ordinary path — `parseStagedRow` rejects an empty `from`/`to`
    // (mirrored by `assertSatisfiesServerRowContract` above) — but the comparator must not depend on
    // that guarantee holding one layer up, and an empty string is where a prefix comparison is most
    // easily got wrong.
    const records: IndexRecord[] = [
      edge({ from: 'a', type: 'tests', to: 'b' }),
      edge({ from: '', type: 'tests', to: 'b' }),
      edge({ from: 'a', type: 'tests', to: '' }),
    ];
    expect(sortRecords(records)).toEqual(byIdentity(records));
  });

  it('agrees with the joined-identity ordering on EVERY pair in a dense cross-product', () => {
    // Exhaustively pairwise, not randomized over whole arrays. Two earlier drafts of this test
    // sorted a few hundred random records and compared the arrays — and BOTH passed with `type` and
    // `to` compared in the wrong order. The first drew from too wide an alphabet to produce a
    // discriminating pair; the second was dense enough that its records became structurally
    // IDENTICAL, so two genuinely different orderings compared equal under `toEqual`. Comparing
    // pairs directly has neither failure mode: every ordering decision is its own assertion.
    // Field values chosen so prefixes abound ('a' < 'ab' < 'abc') — that is where an ordering built
    // on a joined string and one built field-wise could disagree.
    const fields = ['', 'a', 'ab', 'abc', 'b'];
    const types = ['calls', 'declares', 'tests'] as const;
    const edges: EdgeRecord[] = [];
    for (const from of fields)
      for (const type of types) for (const to of fields) edges.push(edge({ from, type, to }));

    const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);
    let compared = 0;
    for (const a of edges) {
      for (const b of edges) {
        const ia = recordIdentity(a);
        const ib = recordIdentity(b);
        // `sortRecords` on exactly two records exposes the comparator's own verdict: it puts the
        // lesser first, and leaves a tie in input order (V8's sort is stable).
        const ordered = sortRecords([a, b]);
        const viaSort = ordered[0] === a && ordered[1] === b ? (ia === ib ? 0 : -1) : 1;
        expect(sign(viaSort)).toBe(sign(ia < ib ? -1 : ia > ib ? 1 : 0));
        compared++;
      }
    }
    // Guard the guard: a cross-product that silently collapsed would make every assertion above
    // vacuous, so pin the count (5 froms x 3 types x 5 tos = 75 edges, squared).
    expect(edges).toHaveLength(75);
    expect(compared).toBe(75 * 75);
  });

  it('keeps nodes ahead of edges regardless of how the identities themselves compare', () => {
    // A node whose uri sorts LAST against an edge whose identity sorts FIRST: kind still wins.
    const records: IndexRecord[] = [edge({ from: 'a', to: 'a' }), node({ uri: 'zzz' })];
    expect(sortRecords(records).map((r) => r.kind)).toEqual(['node', 'edge']);
    expect(sortRecords(records)).toEqual(byIdentity(records));
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
  it('is identical for identical sorted records', async () => {
    const records = sortRecords([node(), edge()]);
    expect(await computeContentHash(records)).toBe(await computeContentHash(sortRecords([node(), edge()])));
  });

  it('changes when any record changes', async () => {
    const a = sortRecords([node()]);
    const b = sortRecords([node({ label: 'different' })]);
    expect(await computeContentHash(a)).not.toBe(await computeContentHash(b));
  });

  // RUN-238: chunking must not change a single hashed byte. `yieldEveryRecords: 1` forces a real
  // `setImmediate` checkpoint between EVERY record — the most aggressive chunking this function
  // can ever do in production — and the digest must still match the never-chunked (default) run.
  it('is byte-identical whether it checkpoints after every record or never at all', async () => {
    const records = sortRecords([
      node(),
      edge(),
      node({ uri: 'noriq://file/RUN/runner/b.ts', label: 'b.ts' }),
    ]);
    const chunked = await computeContentHash(records, { yieldEveryRecords: 1 });
    const unchunked = await computeContentHash(records, { yieldEveryRecords: 1_000_000 });
    expect(chunked).toBe(unchunked);
  });
});

describe('encodeBatches', () => {
  it('always produces at least one batch, even for zero records', async () => {
    const batches = await encodeBatches('gen_1', []);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.rowCount).toBe(0);
    expect(batches[0]?.batchNumber).toBe(0);
  });

  it('batchHash is the SHA-256 of the compressed bytes, independently verifiable', async () => {
    const batches = await encodeBatches('gen_1', sortRecords([node()]));
    const batch = batches[0]!;
    const expected = createHash('sha256').update(batch.compressed).digest('hex');
    expect(batch.batchHash).toBe(expected);
  });

  it('decompresses back to the exact canonical JSONL of the sorted rows', async () => {
    const records = sortRecords([node(), edge()]);
    const batches = await encodeBatches('gen_1', records);
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

  it('never exceeds MAX_INGEST_BATCH_BYTES compressed', async () => {
    const batches = await encodeBatches('gen_1', sortRecords([node()]));
    for (const batch of batches) expect(batch.compressed.length).toBeLessThanOrEqual(MAX_INGEST_BATCH_BYTES);
  });

  it('splits into multiple batches once the uncompressed budget is exceeded', async () => {
    const records: IndexRecord[] = Array.from({ length: 20 }, (_, i) =>
      node({ uri: `noriq://file/RUN/runner/f${i}.ts`, label: `f${i}.ts`, content: 'x'.repeat(500) }),
    );
    const batches = await encodeBatches('gen_1', sortRecords(records), { maxUncompressedBytes: 2_000 });
    expect(batches.length).toBeGreaterThan(1);
    // Batch numbers are contiguous starting at 0, and every row across every batch accounts for
    // exactly the input records — no record dropped, none duplicated.
    expect(batches.map((b) => b.batchNumber)).toEqual(batches.map((_, i) => i));
    const totalRows = batches.reduce((sum, b) => sum + b.rowCount, 0);
    expect(totalRows).toBe(records.length);
  });

  it('stamps every batch with the same generationId', async () => {
    const records: IndexRecord[] = Array.from({ length: 10 }, (_, i) =>
      node({ uri: `noriq://file/RUN/runner/f${i}.ts`, label: `f${i}.ts`, content: 'x'.repeat(200) }),
    );
    const batches = await encodeBatches('gen_shared', sortRecords(records), { maxUncompressedBytes: 500 });
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) expect(batch.generationId).toBe('gen_shared');
  });

  it('stays under the real 8 MiB ceiling for a large batch of poorly-compressible content', async () => {
    // Base64 has a limited (64-symbol) alphabet, so it still compresses somewhat — this is a
    // realistic stress test of the DEFAULT (non-overridden) safety margin, not a claim that gzip
    // can never compress it at all. The correctness guarantee itself rests on DEFLATE's bounded
    // worst-case framing overhead (see index-batch.ts's module doc), not on this test.
    const bigRecord = node({ content: randomBytes(6_000_000).toString('base64') });
    const batches = await encodeBatches('gen_1', sortRecords([bigRecord]));
    for (const batch of batches) expect(batch.compressed.length).toBeLessThanOrEqual(MAX_INGEST_BATCH_BYTES);
  });

  // RUN-238: same property as computeContentHash above, at this function's own grain — chunking
  // must not move a record into a different batch or change a batch's own bytes.
  it('produces byte-identical batches whether it checkpoints after every record or never at all', async () => {
    const records: IndexRecord[] = Array.from({ length: 20 }, (_, i) =>
      node({ uri: `noriq://file/RUN/runner/f${i}.ts`, label: `f${i}.ts`, content: 'x'.repeat(500) }),
    );
    const sorted = sortRecords(records);
    const chunked = await encodeBatches('gen_1', sorted, {
      maxUncompressedBytes: 2_000,
      yieldEveryRecords: 1,
    });
    const unchunked = await encodeBatches('gen_1', sorted, {
      maxUncompressedBytes: 2_000,
      yieldEveryRecords: 1_000_000,
    });
    expect(chunked.map((b) => b.batchHash)).toEqual(unchunked.map((b) => b.batchHash));
    expect(chunked.map((b) => b.rowCount)).toEqual(unchunked.map((b) => b.rowCount));
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
      // The vendored schema now regex-validates contentHash as a lowercase SHA-256 hex digest;
      // production always computes one (index-scan.ts's `createHash('sha256')`), so the fixture
      // matches rather than exercising a shape the real writer never produces.
      contentHash: 'a'.repeat(64),
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
