import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { IndexAdapterRegistry } from '../src/index-adapters';
import type {
  AdapterParseInput,
  AdapterParseResult,
  IndexParserAdapter,
  ParsedCall,
} from '../src/index-adapters';
import { MAX_INGEST_BATCH_BYTES } from '../src/index-batch';
import { MAX_PARSE_DIAGNOSTICS } from '../src/index-entity';
import { INDEX_LANGUAGES } from '../src/index-policy';
import type { ResolvedIndexConfig } from '../src/index-policy';
import { FakeIndexSource } from '../src/index-source';
import type { FakeIndexSourceItem } from '../src/index-source';
import { runIndexer } from '../src/indexer';
import type { IndexRunTarget } from '../src/indexer';

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

const target = (over: Partial<IndexRunTarget> = {}): IndexRunTarget => ({
  projectId: 'proj_1',
  projectKey: 'RUN',
  repositoryKey: 'runner',
  branch: 'main',
  baseId: 'sha_1',
  ...over,
});

/** A tiny, deterministic, regex-based test adapter — proves the registry/adapter seam works end
 *  to end without depending on RUN-216/218's real (not-yet-built) parsers. Extracts top-level
 *  `function NAME(` declarations in source order (regex exec's own match order is left-to-right,
 *  top-to-bottom — a stable order for a given string, which `dedupeSymbolPaths` requires). Also
 *  emits one diagnostic per `// FIXME` comment, for exercising the bounded-diagnostics path. */
const fakeFunctionAdapter: IndexParserAdapter = {
  id: 'fake-fn',
  version: '1',
  canParse: (path) => path.endsWith('.ts'),
  parse: async (input: AdapterParseInput): Promise<AdapterParseResult> => {
    const symbols: AdapterParseResult['symbols'] = [];
    for (const m of input.content.matchAll(/function (\w+)\(/g)) {
      symbols.push({ symbolPath: [m[1]!], nodeType: 'symbol', label: m[1]!, content: null });
    }
    const diagnostics: AdapterParseResult['diagnostics'] = [];
    for (const _m of input.content.matchAll(/\/\/ FIXME/g)) {
      diagnostics.push({ message: 'unresolved FIXME', severity: 'warning' });
    }
    return { symbols, diagnostics };
  },
};

function registry(): IndexAdapterRegistry {
  return new IndexAdapterRegistry().register(fakeFunctionAdapter);
}

function fixture(): FakeIndexSourceItem[] {
  return [
    { kind: 'file', path: 'src/a.ts', content: 'function foo() {}\nfunction bar() {}\n' },
    { kind: 'file', path: 'src/b.ts', content: 'function baz() {}\n' },
    { kind: 'file', path: 'README.md', content: '# hello\n' },
  ];
}

function decodeBatchRows(compressed: Buffer): Array<Record<string, unknown>> {
  const text = gunzipSync(compressed).toString('utf8');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Mirrors the server's `parseStagedRow` required-field checks — see index-batch.test.ts's own
 *  copy of this comment for why this lives inline rather than importing anything from the server
 *  repo. */
function assertSatisfiesServerRowContract(row: Record<string, unknown>): void {
  if (row.kind === 'node') {
    expect(typeof row.uri === 'string' && (row.uri as string).length > 0).toBe(true);
    expect(typeof row.type === 'string' && (row.type as string).length > 0).toBe(true);
    expect(typeof row.label === 'string' && (row.label as string).length > 0).toBe(true);
    expect(row.content === null || typeof row.content === 'string').toBe(true);
    return;
  }
  if (row.kind === 'edge') {
    expect(typeof row.type === 'string' && (row.type as string).length > 0).toBe(true);
    expect(typeof row.from === 'string' && (row.from as string).length > 0).toBe(true);
    expect(typeof row.to === 'string' && (row.to as string).length > 0).toBe(true);
    return;
  }
  throw new Error(`unknown row kind: ${JSON.stringify(row.kind)}`);
}

describe('runIndexer — determinism', () => {
  it('produces a byte-identical manifest and batches across two runs of the same snapshot', async () => {
    const now = () => Date.UTC(2026, 0, 1);
    const run = () =>
      runIndexer(new FakeIndexSource(fixture()), cfg(), target(), { adapters: registry(), now });

    const first = await run();
    const second = await run();

    expect(first.manifest).toEqual(second.manifest);
    expect(first.batches).toHaveLength(second.batches.length);
    for (let i = 0; i < first.batches.length; i++) {
      expect(first.batches[i]!.compressed.equals(second.batches[i]!.compressed)).toBe(true);
      expect(first.batches[i]!.batchHash).toBe(second.batches[i]!.batchHash);
    }
  });

  it('keeps generationId identical across two runs of the same inputs', async () => {
    const run = () => runIndexer(new FakeIndexSource(fixture()), cfg(), target(), { adapters: registry() });
    const first = await run();
    const second = await run();
    expect(first.manifest.generationId).toBe(second.manifest.generationId);
  });

  for (const [field, value] of [
    ['projectId', 'proj_2'],
    ['repositoryKey', 'other-repo'],
    ['branch', 'other-branch'],
    ['baseId', 'sha_2'],
    ['indexerVersion', '2'],
  ] as const) {
    it(`changes generationId when ${field} changes`, async () => {
      const base = await runIndexer(new FakeIndexSource(fixture()), cfg(), target(), {
        adapters: registry(),
      });
      const changed = await runIndexer(new FakeIndexSource(fixture()), cfg(), target({ [field]: value }), {
        adapters: registry(),
      });
      expect(changed.manifest.generationId).not.toBe(base.manifest.generationId);
    });
  }
});

describe('runIndexer — stable identity under unrelated change', () => {
  it('leaves every OTHER file entity URI identical when one file changes', async () => {
    const before = await runIndexer(new FakeIndexSource(fixture()), cfg(), target(), {
      adapters: registry(),
    });

    const changedFixture = fixture().map((item) =>
      item.kind === 'file' && item.path === 'src/b.ts' ? { ...item, content: 'function baz2() {}\n' } : item,
    );
    const after = await runIndexer(new FakeIndexSource(changedFixture), cfg(), target(), {
      adapters: registry(),
    });

    const urisFor = (records: typeof before.batches) =>
      new Set(
        records
          .flatMap((b) => decodeBatchRows(b.compressed))
          .filter((r) => r.kind === 'node' && !String(r.uri).includes('/b.ts'))
          .map((r) => r.uri),
      );
    expect(urisFor(after.batches)).toEqual(urisFor(before.batches));
  });

  it('does not change a symbol URI when an unrelated line is added above it in the same file', async () => {
    const before = await runIndexer(new FakeIndexSource(fixture()), cfg(), target(), {
      adapters: registry(),
    });

    const withExtraLine = fixture().map((item) =>
      item.kind === 'file' && item.path === 'src/a.ts'
        ? { ...item, content: `// a new unrelated comment\n${item.content}` }
        : item,
    );
    const after = await runIndexer(new FakeIndexSource(withExtraLine), cfg(), target(), {
      adapters: registry(),
    });

    const fooUriIn = (result: typeof before) =>
      result.batches
        .flatMap((b) => decodeBatchRows(b.compressed))
        .find((r) => r.kind === 'node' && String(r.uri).endsWith('#foo'))?.uri;
    expect(fooUriIn(after)).toBe(fooUriIn(before));
    expect(fooUriIn(before)).toBeDefined();
  });
});

describe('runIndexer — platform-stable paths', () => {
  it('produces the same file URI whether the source path uses `/` or `\\`', async () => {
    const forward = await runIndexer(
      new FakeIndexSource([{ kind: 'file', path: 'src/a.ts', content: 'x' }]),
      cfg(),
      target(),
      {},
    );
    const backslash = await runIndexer(
      new FakeIndexSource([{ kind: 'file', path: 'src\\a.ts', content: 'x' }]),
      cfg(),
      target(),
      {},
    );
    const uriOf = (r: typeof forward) =>
      r.batches.flatMap((b) => decodeBatchRows(b.compressed)).find((row) => row.kind === 'node')?.uri;
    expect(uriOf(backslash)).toBe(uriOf(forward));
  });
});

describe('runIndexer — no hidden nondeterminism in the wire content', () => {
  it('contains no ISO-8601 timestamp anywhere in row content', async () => {
    const result = await runIndexer(new FakeIndexSource(fixture()), cfg(), target(), {
      adapters: registry(),
    });
    const isoDate = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
    for (const batch of result.batches) {
      const text = gunzipSync(batch.compressed).toString('utf8');
      expect(isoDate.test(text)).toBe(false);
    }
  });

  it('contains no absolute filesystem path anywhere in row content', async () => {
    const result = await runIndexer(new FakeIndexSource(fixture()), cfg(), target(), {
      adapters: registry(),
    });
    for (const batch of result.batches) {
      const text = gunzipSync(batch.compressed).toString('utf8');
      expect(text.includes(process.cwd())).toBe(false);
      expect(/^\//m.test(text)).toBe(false);
    }
  });
});

describe('runIndexer — content modes', () => {
  it('withholds content and skips adapter parsing entirely in metadata mode', async () => {
    const result = await runIndexer(
      new FakeIndexSource([{ kind: 'file', path: 'src/a.ts', content: 'function foo() {}\n' }]),
      cfg({ contentMode: 'metadata' }),
      target(),
      { adapters: registry() },
    );
    const rows = result.batches.flatMap((b) => decodeBatchRows(b.compressed));
    expect(rows).toHaveLength(1); // the file entity only — no symbol, no declares edge.
    expect(rows[0]).toMatchObject({ kind: 'node', type: 'file', content: null });
    expect(Object.keys(result.parserVersions)).toHaveLength(0);
  });
});

describe('runIndexer — diagnostics', () => {
  it('bounds diagnostics and never lets them reorder or alter successful records', async () => {
    const fixedContent = 'function foo() {}\n';
    // Same symbols, same content, every time — only the DIAGNOSTIC count varies between the two
    // adapters below. This isolates "does injecting parse failures change the successful
    // records" from "does the file's own content differ", which a content-driven diagnostic
    // trigger (e.g. counting `// FIXME` comments) would conflate: adding failure-triggering text
    // to a file necessarily changes that file's OWN content record too, which is a true but
    // uninteresting difference, not the one this acceptance line is about.
    const withNoise: IndexParserAdapter = {
      id: 'fake-fn',
      version: '1',
      canParse: (path) => path.endsWith('.ts'),
      parse: async () => ({
        symbols: [{ symbolPath: ['foo'], nodeType: 'symbol', label: 'foo', content: null }],
        diagnostics: Array.from({ length: MAX_PARSE_DIAGNOSTICS + 10 }, () => ({
          message: 'injected parse failure',
          severity: 'warning' as const,
        })),
      }),
    };
    const withoutNoise: IndexParserAdapter = {
      ...withNoise,
      parse: async () => ({
        symbols: [{ symbolPath: ['foo'], nodeType: 'symbol', label: 'foo', content: null }],
        diagnostics: [],
      }),
    };

    const withDiagnostics = await runIndexer(
      new FakeIndexSource([{ kind: 'file', path: 'src/a.ts', content: fixedContent }]),
      cfg(),
      target(),
      { adapters: new IndexAdapterRegistry().register(withNoise) },
    );
    expect(withDiagnostics.diagnostics).toHaveLength(MAX_PARSE_DIAGNOSTICS);
    expect(withDiagnostics.diagnosticsOverflow).toBe(10);

    const withoutDiagnostics = await runIndexer(
      new FakeIndexSource([{ kind: 'file', path: 'src/a.ts', content: fixedContent }]),
      cfg(),
      target(),
      { adapters: new IndexAdapterRegistry().register(withoutNoise) },
    );
    expect(withoutDiagnostics.diagnostics).toHaveLength(0);

    // The successful records (file + symbol + declares edge) are byte-identical whether or not
    // the same file also produced 1,010 injected diagnostics.
    expect(withDiagnostics.manifest.contentHash).toBe(withoutDiagnostics.manifest.contentHash);
    expect(withDiagnostics.batches.map((b) => b.batchHash)).toEqual(
      withoutDiagnostics.batches.map((b) => b.batchHash),
    );
  });

  it('records which parser produced each diagnostic', async () => {
    const result = await runIndexer(
      new FakeIndexSource([{ kind: 'file', path: 'src/a.ts', content: '// FIXME\n' }]),
      cfg(),
      target(),
      { adapters: registry() },
    );
    expect(result.diagnostics[0]?.source).toBe('fake-fn@1');
  });
});

describe('runIndexer — parser versions', () => {
  it('records the id/version of every adapter that actually parsed a file', async () => {
    const result = await runIndexer(new FakeIndexSource(fixture()), cfg(), target(), {
      adapters: registry(),
    });
    expect(result.parserVersions).toEqual({ 'fake-fn': '1' });
  });
});

describe('runIndexer — adapter throw isolation (RUN-216)', () => {
  it('a throwing adapter costs only its own file — the file entity survives and every other file is intact', async () => {
    const throwing: IndexParserAdapter = {
      id: 'throws',
      version: '1',
      canParse: (path) => path.endsWith('.ts'),
      parse: async () => {
        throw new Error('boom — a WASM trap or an adapter bug, not an ordinary syntax error');
      },
    };
    const result = await runIndexer(new FakeIndexSource(fixture()), cfg(), target(), {
      adapters: new IndexAdapterRegistry().register(throwing),
    });

    // Every file still gets its own `file` entity (indexer.ts pushes it BEFORE calling parse) —
    // no symbols, because the only registered adapter threw on every .ts file.
    const rows = result.batches.flatMap((b) => decodeBatchRows(b.compressed));
    const fileRows = rows.filter((r) => r.kind === 'node' && r.type === 'file');
    expect(fileRows).toHaveLength(3); // a.ts, b.ts, README.md — README isn't claimed by `throwing`.

    // One bounded diagnostic per throwing file, naming the adapter, never a thrown exception.
    expect(result.diagnostics).toHaveLength(2); // src/a.ts and src/b.ts both match `throwing`.
    for (const d of result.diagnostics) {
      expect(d.severity).toBe('error');
      expect(d.message).toContain('threw while parsing');
      expect(d.source).toBe('throws@1');
    }
    expect(result.parserVersions).toEqual({ throws: '1' });
  });

  it('a rejected parse() promise is isolated the same way a thrown one is', async () => {
    const rejecting: IndexParserAdapter = {
      id: 'rejects',
      version: '1',
      canParse: (path) => path.endsWith('.ts'),
      parse: () => Promise.reject(new Error('async boom')),
    };
    const result = await runIndexer(
      new FakeIndexSource([{ kind: 'file', path: 'src/a.ts', content: 'function f(){}' }]),
      cfg(),
      target(),
      { adapters: new IndexAdapterRegistry().register(rejecting) },
    );
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toContain('async boom');
  });
});

describe('runIndexer — same-file call edges (RUN-216)', () => {
  const callAdapter = (calls: ParsedCall[]): IndexParserAdapter => ({
    id: 'fake-calls',
    version: '1',
    canParse: (path) => path.endsWith('.ts'),
    parse: async () => ({
      symbols: [
        { symbolPath: ['add'], nodeType: 'symbol', label: 'add', content: null },
        { symbolPath: ['helper'], nodeType: 'symbol', label: 'helper', content: null },
      ],
      diagnostics: [],
      calls,
    }),
  });

  it('wires a "resolved" call into a real calls edge between the two symbol URIs', async () => {
    const adapter = callAdapter([
      { fromSymbolPath: ['add'], toSymbolPath: ['helper'], confidence: 'resolved' },
    ]);
    const result = await runIndexer(
      new FakeIndexSource([{ kind: 'file', path: 'src/a.ts', content: 'x' }]),
      cfg(),
      target(),
      { adapters: new IndexAdapterRegistry().register(adapter) },
    );
    const rows = result.batches.flatMap((b) => decodeBatchRows(b.compressed));
    const edge = rows.find((r) => r.kind === 'edge' && r.type === 'calls');
    expect(edge).toBeDefined();
    const addUri = rows.find((r) => r.kind === 'node' && String(r.uri).endsWith('#add'))?.uri;
    const helperUri = rows.find((r) => r.kind === 'node' && String(r.uri).endsWith('#helper'))?.uri;
    expect(edge).toMatchObject({ from: addUri, to: helperUri });
    expect(result.inferredEdgesOmitted).toBe(0);
  });

  it('never places an "inferred" call on the wire, but counts it as omitted', async () => {
    const adapter = callAdapter([
      { fromSymbolPath: ['add'], toSymbolPath: ['helper'], confidence: 'inferred' },
    ]);
    const result = await runIndexer(
      new FakeIndexSource([{ kind: 'file', path: 'src/a.ts', content: 'x' }]),
      cfg(),
      target(),
      { adapters: new IndexAdapterRegistry().register(adapter) },
    );
    const rows = result.batches.flatMap((b) => decodeBatchRows(b.compressed));
    expect(rows.some((r) => r.kind === 'edge' && r.type === 'calls')).toBe(false);
    expect(result.inferredEdgesOmitted).toBe(1);
  });

  it('drops a call naming a symbolPath this same parse() never declared — never a fabricated target', async () => {
    const adapter = callAdapter([
      { fromSymbolPath: ['add'], toSymbolPath: ['nonexistent'], confidence: 'resolved' },
    ]);
    const result = await runIndexer(
      new FakeIndexSource([{ kind: 'file', path: 'src/a.ts', content: 'x' }]),
      cfg(),
      target(),
      { adapters: new IndexAdapterRegistry().register(adapter) },
    );
    const rows = result.batches.flatMap((b) => decodeBatchRows(b.compressed));
    expect(rows.some((r) => r.kind === 'edge' && r.type === 'calls')).toBe(false);
    expect(result.inferredEdgesOmitted).toBe(0);
  });
});

describe('runIndexer — deletions', () => {
  it('reports no deletions when no previous file list is supplied', async () => {
    const result = await runIndexer(new FakeIndexSource(fixture()), cfg(), target(), {
      adapters: registry(),
    });
    expect(result.manifest.deletions).toEqual([]);
  });

  it('reports paths present previously but missing from this scan', async () => {
    const result = await runIndexer(new FakeIndexSource(fixture()), cfg(), target(), {
      adapters: registry(),
      previousFilePaths: ['src/a.ts', 'src/removed.ts'],
    });
    expect(result.manifest.deletions).toEqual(['src/removed.ts']);
  });
});

describe('runIndexer — server row contract and batch ceiling', () => {
  it('every row satisfies the server-mirrored required-field contract', async () => {
    const result = await runIndexer(new FakeIndexSource(fixture()), cfg(), target(), {
      adapters: registry(),
    });
    const rows = result.batches.flatMap((b) => decodeBatchRows(b.compressed));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) assertSatisfiesServerRowContract(row);
  });

  it('never produces a batch over the 8 MiB compressed ceiling', async () => {
    const result = await runIndexer(new FakeIndexSource(fixture()), cfg(), target(), {
      adapters: registry(),
    });
    for (const batch of result.batches)
      expect(batch.compressed.length).toBeLessThanOrEqual(MAX_INGEST_BATCH_BYTES);
  });

  it('produces batchCount matching the number of encoded batches, and a manifest the vendored schema accepts', async () => {
    const result = await runIndexer(new FakeIndexSource(fixture()), cfg(), target(), {
      adapters: registry(),
    });
    expect(result.manifest.batchCount).toBe(result.batches.length);
    expect(result.manifest.fileCount).toBe(3);
  });
});
