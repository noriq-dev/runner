import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ResolvedIndexConfig } from '../src/index-policy';
import { INDEX_LANGUAGES } from '../src/index-policy';
import { MAX_STATUS_RECORDS, scanIndexSource } from '../src/index-scan';
import type { IndexScanResult } from '../src/index-scan';
import { FakeIndexSource } from '../src/index-source';
import type { FakeIndexSourceItem, IndexSource, IndexSourceReadOutcome } from '../src/index-source';

/** Same generous-bounds-by-default convention `test/index-scan.test.ts` uses. */
const cfg = (over: Partial<ResolvedIndexConfig> = {}): ResolvedIndexConfig => ({
  languages: [...INDEX_LANGUAGES],
  contentMode: 'full',
  maxFiles: 10_000,
  maxFileBytes: 1_000_000,
  maxTotalBytes: 500_000_000,
  readDeadlineMs: 120_000,
  pollIntervalMinutes: 60,
  include: [],
  exclude: [],
  ...over,
});

const byPath = (r: IndexScanResult, p: string) => r.candidates.find((c) => c.path === p);
const statusFor = (r: IndexScanResult, p: string) => r.statuses.find((s) => s.path === p);

describe('scanIndexSource — a source with no filesystem involved', () => {
  it('reads matching files and reports identity, content, and a stable hash — no filesystem behind it', async () => {
    const source = new FakeIndexSource([{ kind: 'file', path: 'a.ts', content: 'export const x = 1;\n' }]);
    const r = await scanIndexSource(source, cfg());
    const c = byPath(r, 'a.ts');
    expect(c?.content).toBe('export const x = 1;\n');
    expect(c?.contentMode).toBe('full');
    expect(c?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns nothing and never calls read() when [index] is off (config is null)', async () => {
    let reads = 0;
    const source = new FakeIndexSource([{ kind: 'file', path: 'a.ts', content: 'x' }]);
    const originalRead = source.read.bind(source);
    source.read = async (p, n) => {
      reads += 1;
      return originalRead(p, n);
    };
    const r = await scanIndexSource(source, null);
    expect(r).toEqual({
      candidates: [],
      statuses: [],
      statusOverflow: 0,
      filesOpened: 0,
      totalBytesRead: 0,
      stoppedEarly: false,
    });
    expect(reads).toBe(0);
  });
});

describe('scanIndexSource — the policy layer inherits every rule, implementing none of it', () => {
  it('a fake source returning a hard-denied path (.env) yields a denied status and no content', async () => {
    const source = new FakeIndexSource([
      { kind: 'file', path: '.env', content: 'SECRET=1' },
      { kind: 'file', path: 'ok.ts', content: 'export {};' },
    ]);
    const r = await scanIndexSource(source, cfg());
    expect(byPath(r, '.env')).toBeUndefined();
    expect(statusFor(r, '.env')?.reason).toBe('denied');
    expect(byPath(r, 'ok.ts')).toBeDefined();
    // The deny list cannot be bypassed by supplying a different source and a wide include.
    const r2 = await scanIndexSource(source, cfg({ include: ['**/*'] }));
    expect(byPath(r2, '.env')).toBeUndefined();
    expect(statusFor(r2, '.env')?.reason).toBe('denied');
  });

  it('collapses a whole denied directory to one status record from a fake source too', async () => {
    const source = new FakeIndexSource([
      { kind: 'file', path: '.git/HEAD', content: 'ref: refs/heads/main' },
      { kind: 'file', path: '.git/objects/pack', content: 'binary-ish' },
    ]);
    const r = await scanIndexSource(source, cfg());
    expect(r.statuses.filter((s) => s.path.startsWith('.git'))).toEqual([
      { path: '.git', reason: 'denied', detail: expect.any(String) },
    ]);
  });

  it('excludes and includes exactly as scanRepoForIndex does, against a source with no directories at all', async () => {
    const source = new FakeIndexSource([
      { kind: 'file', path: 'a.ts', content: 'a' },
      { kind: 'file', path: 'a.test.ts', content: 'a-test' },
    ]);
    const r = await scanIndexSource(source, cfg({ exclude: ['**/*.test.ts'] }));
    expect(byPath(r, 'a.ts')).toBeDefined();
    expect(byPath(r, 'a.test.ts')).toBeUndefined();
    expect(statusFor(r, 'a.test.ts')?.reason).toBe('excluded');
  });

  it('trusts a well-behaved (default) source order rather than re-deriving it', async () => {
    // Construction order is deliberately not path order — `FakeIndexSource`'s default mode sorts
    // it on the way out, exactly like `FilesystemIndexSource`, so this proves the SOURCE produced
    // the deterministic order, not that the policy layer re-sorted a scramble (the RUN-252
    // regression this follow-up removes: a global re-sort would pass this exact assertion too,
    // which is why the counting-source test below is what actually distinguishes the two).
    const files: FakeIndexSourceItem[] = [
      { kind: 'file', path: 'z.ts', content: 'z' },
      { kind: 'file', path: 'a.ts', content: 'a' },
      { kind: 'file', path: 'm/b.ts', content: 'b' },
      { kind: 'file', path: 'm.ts', content: 'm' },
    ];
    const source = new FakeIndexSource(files);
    const r = await scanIndexSource(source, cfg());
    expect(r.candidates.map((c) => c.path)).toEqual(['a.ts', 'm.ts', 'm/b.ts', 'z.ts']);
  });

  it('refuses loudly rather than silently re-sorting a source that breaks the ordering contract', async () => {
    const files: FakeIndexSourceItem[] = [
      { kind: 'file', path: 'z.ts', content: 'z' },
      { kind: 'file', path: 'a.ts', content: 'a' }, // out of order relative to z.ts
    ];
    // `{ scrambled: true }` is the deliberately-misbehaving mode (see FakeIndexSource's doc) —
    // the one thing a well-behaved fake never does by default.
    const source = new FakeIndexSource(files, {}, { scrambled: true });
    await expect(scanIndexSource(source, cfg())).rejects.toThrow(/ordering contract/);
  });

  it('never calls read() for a path pruned by shouldDescend — the point of the predicate', async () => {
    let reads = 0;
    const source = new FakeIndexSource([
      { kind: 'file', path: '.git/HEAD', content: 'ref: refs/heads/main' },
      { kind: 'file', path: '.git/objects/pack', content: 'binary-ish' },
      { kind: 'file', path: 'ok.ts', content: 'export {};' },
    ]);
    const originalRead = source.read.bind(source);
    source.read = async (p, n) => {
      reads += 1;
      return originalRead(p, n);
    };
    const r = await scanIndexSource(source, cfg());
    expect(reads).toBe(1); // ok.ts only — neither .git file was ever read.
    expect(byPath(r, 'ok.ts')).toBeDefined();
  });

  it('stops enumerating a 1000-file source the moment maxFiles bites, not after draining it', async () => {
    let yielded = 0;
    const total = 1000;
    const countingSource: IndexSource = {
      kind: 'counting',
      async *list() {
        for (let i = 0; i < total; i++) {
          yielded += 1;
          // Zero-padded so construction order already satisfies the ordering contract.
          yield { kind: 'file', entry: { path: `f${String(i).padStart(5, '0')}.ts` } } as const;
        }
      },
      async read(): Promise<IndexSourceReadOutcome> {
        return { ok: true, bytes: Buffer.from('x'), overLimit: false };
      },
    };
    const r = await scanIndexSource(countingSource, cfg({ maxFiles: 3 }));
    expect(r.filesOpened).toBe(3);
    expect(r.stoppedEarly).toBe(true);
    // The proof: the source itself never produced anywhere near 1000 entries. A drain-and-sort
    // policy layer would have pulled every single one before this bound got a chance to apply.
    expect(yielded).toBeLessThan(10);
  });

  it('enforces the per-file byte bound even when the source reports no size at all', async () => {
    const source = new FakeIndexSource([
      { kind: 'file', path: 'big.ts', content: 'x'.repeat(1000), size: null },
    ]);
    const r = await scanIndexSource(source, cfg({ maxFileBytes: 10 }));
    expect(byPath(r, 'big.ts')).toBeUndefined();
    expect(statusFor(r, 'big.ts')?.reason).toBe('too-large');
  });

  it('also enforces the per-file byte bound cheaply when the source DOES report an oversized size', async () => {
    let reads = 0;
    const source = new FakeIndexSource([
      { kind: 'file', path: 'big.ts', content: 'x'.repeat(1000), size: 1000 },
    ]);
    const originalRead = source.read.bind(source);
    source.read = async (p, n) => {
      reads += 1;
      return originalRead(p, n);
    };
    const r = await scanIndexSource(source, cfg({ maxFileBytes: 10 }));
    expect(byPath(r, 'big.ts')).toBeUndefined();
    expect(statusFor(r, 'big.ts')?.reason).toBe('too-large');
    // The whole point of a reported size: the too-large verdict costs no read at all.
    expect(reads).toBe(0);
  });

  it('a source read that refuses maps onto the existing status-reason enum, and the scan continues', async () => {
    const source = new FakeIndexSource(
      [
        { kind: 'file', path: 'gone.ts', content: 'placeholder — never actually read' },
        { kind: 'file', path: 'ok.ts', content: 'export {};' },
      ],
      { 'gone.ts': { reason: 'unreadable', detail: 'simulated remote read failure' } },
    );
    const r = await scanIndexSource(source, cfg());
    expect(byPath(r, 'gone.ts')).toBeUndefined();
    expect(statusFor(r, 'gone.ts')).toEqual({
      path: 'gone.ts',
      reason: 'unreadable',
      detail: 'simulated remote read failure',
    });
    expect(byPath(r, 'ok.ts')).toBeDefined();
  });

  it('an enumeration-time refusal is recorded directly, without passing through include/exclude/deny', async () => {
    const source = new FakeIndexSource([
      { kind: 'refused', path: 'unlistable-subtree', reason: 'unreadable', detail: 'listing failed' },
      { kind: 'file', path: 'ok.ts', content: 'export {};' },
    ]);
    // A narrow include that would never have matched 'unlistable-subtree' anyway — proving the
    // refusal is reported regardless of include/exclude, not filtered through them.
    const r = await scanIndexSource(source, cfg({ include: ['**/*.nomatch'] }));
    expect(statusFor(r, 'unlistable-subtree')).toEqual({
      path: 'unlistable-subtree',
      reason: 'unreadable',
      detail: 'listing failed',
    });
    expect(statusFor(r, 'ok.ts')?.reason).toBe('not-included');
  });

  it('withholds raw content in metadata mode, with an identical hash to full mode, from a fake source', async () => {
    const source = new FakeIndexSource([{ kind: 'file', path: 'a.ts', content: 'export const x = 1;\n' }]);
    const full = await scanIndexSource(source, cfg({ contentMode: 'full' }));
    const metadata = await scanIndexSource(source, cfg({ contentMode: 'metadata' }));
    expect(byPath(full, 'a.ts')?.content).toBe('export const x = 1;\n');
    expect(byPath(metadata, 'a.ts')?.content).toBeNull();
    expect(byPath(metadata, 'a.ts')?.contentHash).toBe(byPath(full, 'a.ts')?.contentHash);
    expect(JSON.stringify(metadata)).not.toContain('export const x = 1');
  });

  it('reports binary content by bytes, sourced from memory rather than a file', async () => {
    const source = new FakeIndexSource([
      { kind: 'file', path: 'blob.ts', content: Buffer.from([0x00, 0x01, 0x02, 0xff]) },
    ]);
    const r = await scanIndexSource(source, cfg());
    expect(byPath(r, 'blob.ts')).toBeUndefined();
    expect(statusFor(r, 'blob.ts')?.reason).toBe('binary');
  });

  it('caps and overflows status records exactly as the filesystem source does', async () => {
    const total = MAX_STATUS_RECORDS + 25;
    const source = new FakeIndexSource(
      Array.from({ length: total }, (_, i) => ({
        kind: 'file' as const,
        path: `secrets${i}.json`,
        content: '{}',
      })),
    );
    const r = await scanIndexSource(source, cfg());
    expect(r.statuses).toHaveLength(MAX_STATUS_RECORDS);
    expect(r.statusOverflow).toBe(total - MAX_STATUS_RECORDS);
    expect(r.statuses.every((s) => s.reason === 'denied')).toBe(true);
  });
});

describe('index-scan.ts owns filtering; nothing else in the tree may implement it', () => {
  it('isDeniedIndexPath is called from exactly one module', async () => {
    const srcDir = path.join(import.meta.dirname, '..', 'src');
    const files = (await readdir(srcDir)).filter((f) => f.endsWith('.ts'));
    const callers: string[] = [];
    for (const f of files) {
      const text = await readFile(path.join(srcDir, f), 'utf8');
      if (text.includes('isDeniedIndexPath(')) callers.push(f);
    }
    // index-deny.ts defines it (no self-call); index-scan.ts is the only consumer.
    expect(callers.sort()).toEqual(['index-deny.ts', 'index-scan.ts']);
  });
});
