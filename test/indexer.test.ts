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
import { resolveRelativeImport, runIndexer } from '../src/indexer';
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

describe('runIndexer — credential-marker withholding (RUN-258)', () => {
  const GHP_TOKEN = 'ghp_16C7e42F292c6912E7710c838347Ae178B4a';

  it('withholds a full-mode file’s content when it contains a high-confidence credential marker, and skips adapter parsing for it', async () => {
    const result = await runIndexer(
      new FakeIndexSource([
        {
          kind: 'file',
          path: 'src/secret.ts',
          content: `function useToken() {\n  return "${GHP_TOKEN}";\n}\n`,
        },
      ]),
      cfg(),
      target(),
      { adapters: registry() },
    );
    const rows = result.batches.flatMap((b) => decodeBatchRows(b.compressed));
    expect(rows).toHaveLength(1); // the file entity only — no symbol, no declares edge.
    expect(rows[0]).toMatchObject({ kind: 'node', type: 'file', content: null });
    expect(Object.keys(result.parserVersions)).toHaveLength(0);

    // The token appears nowhere in the encoded output at all — not just the file's own content.
    const encodedText = result.batches.map((b) => JSON.stringify(decodeBatchRows(b.compressed))).join('\n');
    expect(encodedText).not.toContain(GHP_TOKEN);
  });

  it('records a bounded diagnostic naming the file and the marker CLASS, never the matched bytes', async () => {
    const result = await runIndexer(
      new FakeIndexSource([
        { kind: 'file', path: 'src/secret.ts', content: `const token = "${GHP_TOKEN}";\n` },
      ]),
      cfg(),
      target(),
      { adapters: registry() },
    );
    expect(result.diagnostics).toHaveLength(1);
    const diagnostic = result.diagnostics[0]!;
    expect(diagnostic.path).toBe('src/secret.ts');
    expect(diagnostic.severity).toBe('warning');
    expect(diagnostic.message).toMatch(/credential marker/);
    expect(diagnostic.message).toMatch(/known credential prefix/);
    expect(diagnostic.message).not.toContain(GHP_TOKEN);
    expect(diagnostic.message).not.toContain('ghp_');
  });

  it('a PEM header, a JWT, and each issuer prefix all withhold the whole file’s content', async () => {
    const cases: Array<[string, string]> = [
      [
        'src/pem.ts',
        'const key = `\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----\n`;\n',
      ],
      [
        'src/jwt.ts',
        'const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.' +
          'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";\n',
      ],
      ['src/ghp.ts', `const t = "${GHP_TOKEN}";\n`],
    ];
    const result = await runIndexer(
      new FakeIndexSource(cases.map(([path, content]) => ({ kind: 'file' as const, path, content }))),
      cfg(),
      target(),
      { adapters: registry() },
    );
    const rows = result.batches.flatMap((b) => decodeBatchRows(b.compressed));
    for (const [path] of cases) {
      const row = rows.find((r) => r.kind === 'node' && String(r.uri).endsWith(`/${path.split('/').pop()}`));
      expect(row?.content).toBeNull();
    }
  });

  it('leaves an ordinary source file with no marker untouched', async () => {
    const result = await runIndexer(
      new FakeIndexSource([
        { kind: 'file', path: 'src/a.ts', content: 'function foo() {}\nfunction bar() {}\n' },
      ]),
      cfg(),
      target(),
      { adapters: registry() },
    );
    const rows = result.batches.flatMap((b) => decodeBatchRows(b.compressed));
    const fileRow = rows.find((r) => r.kind === 'node' && r.type === 'file');
    expect(fileRow?.content).toBe('function foo() {}\nfunction bar() {}\n');
    expect(result.diagnostics).toHaveLength(0);
    // The adapter still ran — symbols exist for the un-withheld file.
    expect(rows.some((r) => r.kind === 'node' && r.type === 'symbol')).toBe(true);
  });

  it('does not withhold the OTHER file when only one candidate in the same run carries a marker', async () => {
    const result = await runIndexer(
      new FakeIndexSource([
        { kind: 'file', path: 'src/a.ts', content: 'function foo() {}\n' },
        { kind: 'file', path: 'src/secret.ts', content: `const t = "${GHP_TOKEN}";\n` },
      ]),
      cfg(),
      target(),
      { adapters: registry() },
    );
    const rows = result.batches.flatMap((b) => decodeBatchRows(b.compressed));
    const aRow = rows.find((r) => r.kind === 'node' && r.type === 'file' && String(r.uri).endsWith('/a.ts'));
    const secretRow = rows.find(
      (r) => r.kind === 'node' && r.type === 'file' && String(r.uri).endsWith('/secret.ts'),
    );
    expect(aRow?.content).toBe('function foo() {}\n');
    expect(secretRow?.content).toBeNull();
  });

  it("leaves contentMode: 'metadata' behaviour unchanged — still one diagnostic-free, content-null file entity", async () => {
    const result = await runIndexer(
      new FakeIndexSource([{ kind: 'file', path: 'src/secret.ts', content: `const t = "${GHP_TOKEN}";\n` }]),
      cfg({ contentMode: 'metadata' }),
      target(),
      { adapters: registry() },
    );
    const rows = result.batches.flatMap((b) => decodeBatchRows(b.compressed));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'node', type: 'file', content: null });
    // No credential-marker diagnostic — the marker scan only runs on full-mode content, and
    // metadata mode already withholds via the pre-existing path (this module's own doc).
    expect(result.diagnostics).toHaveLength(0);
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

// The adapters this repo ships decline an unnameable key at their own source, so this floor exists
// for the NEXT adapter — one unlabelled row out of 6454 made the server reject a whole batch and
// fail an entire generation on the first real upload, because `MemoryNode.label` is min(1) in the
// vendored contract and nothing local checked.
describe('runIndexer — an unlabelled symbol never reaches the wire', () => {
  const labelAdapter = (label: string): IndexParserAdapter => ({
    id: 'fake-unlabelled',
    version: '1',
    canParse: (path) => path.endsWith('.ts'),
    parse: async () => ({
      symbols: [
        { symbolPath: ['bad'], nodeType: 'symbol', label, content: null },
        { symbolPath: ['good'], nodeType: 'symbol', label: 'good', content: null },
      ],
      diagnostics: [],
    }),
  });

  const run = (label: string) =>
    runIndexer(new FakeIndexSource([{ kind: 'file', path: 'src/a.ts', content: 'x' }]), cfg(), target(), {
      adapters: new IndexAdapterRegistry().register(labelAdapter(label)),
    });

  it('drops the row, counts it, and keeps every labelled sibling', async () => {
    const result = await run('');
    const rows = result.batches.flatMap((b) => decodeBatchRows(b.compressed));
    const nodes = rows.filter((r) => r.kind === 'node');
    expect(nodes.every((n) => String(n.label).trim().length > 0)).toBe(true);
    expect(nodes.some((n) => String(n.uri).endsWith('#good'))).toBe(true);
    expect(nodes.some((n) => String(n.uri).endsWith('#bad'))).toBe(false);
    expect(result.unlabelledSymbolsDropped).toBe(1);
  });

  it('takes the dropped symbol’s declares edge with it — an edge to a node nobody sent is an edge to nothing', async () => {
    const result = await run('   ');
    const rows = result.batches.flatMap((b) => decodeBatchRows(b.compressed));
    const declares = rows.filter((r) => r.kind === 'edge' && r.type === 'declares');
    expect(declares.some((e) => String(e.to).endsWith('#bad'))).toBe(false);
    expect(declares.some((e) => String(e.to).endsWith('#good'))).toBe(true);
    expect(result.unlabelledSymbolsDropped).toBe(1);
  });

  it('reports zero when every adapter behaves', async () => {
    const result = await run('bad');
    expect(result.unlabelledSymbolsDropped).toBe(0);
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

describe('resolveRelativeImport (RUN-217 locked decisions 2/3)', () => {
  it('declines a bare specifier immediately, regardless of what the snapshot contains', () => {
    const paths = new Set(['react.ts', 'src/react.ts']);
    expect(resolveRelativeImport('src/a.ts', 'react', paths)).toBeNull();
    expect(resolveRelativeImport('src/a.ts', '@noriq-dev/shared', paths)).toBeNull();
    expect(resolveRelativeImport('src/a.ts', 'node:fs', paths)).toBeNull();
  });

  it('resolves a literal, extension-carrying relative specifier directly', () => {
    const paths = new Set(['src/a.ts', 'src/b.ts']);
    expect(resolveRelativeImport('src/a.ts', './b.ts', paths)).toBe('src/b.ts');
  });

  it('resolves an extensionless relative specifier by trying the documented extension list', () => {
    const paths = new Set(['src/a.ts', 'src/worktree.ts']);
    expect(resolveRelativeImport('src/a.ts', './worktree', paths)).toBe('src/worktree.ts');
  });

  it('resolves an extensionless relative specifier against a directory /index file', () => {
    const paths = new Set(['src/a.ts', 'src/lib/index.ts']);
    expect(resolveRelativeImport('src/a.ts', './lib', paths)).toBe('src/lib/index.ts');
  });

  it('declines when no candidate is present in this generation — no stub, no guess', () => {
    const paths = new Set(['src/a.ts']);
    expect(resolveRelativeImport('src/a.ts', './missing', paths)).toBeNull();
  });

  it('declines an extensionless specifier when two candidates are present — ambiguous', () => {
    const paths = new Set(['src/a.ts', 'src/util.ts', 'src/util.js']);
    expect(resolveRelativeImport('src/a.ts', './util', paths)).toBeNull();
  });

  it('declines when both the extensionless directory and an /index file exist for the same target', () => {
    const paths = new Set(['src/a.ts', 'src/lib.ts', 'src/lib/index.ts']);
    expect(resolveRelativeImport('src/a.ts', './lib', paths)).toBeNull();
  });

  it("joins a `../` specifier relative to the IMPORTER's own directory, not the repo root", () => {
    const paths = new Set(['src/nested/foo.ts', 'src/lib/bar.ts']);
    expect(resolveRelativeImport('src/nested/foo.ts', '../lib/bar', paths)).toBe('src/lib/bar.ts');
  });

  it('resolves a same-directory specifier for an importer at the repository root', () => {
    const paths = new Set(['a.ts', 'b.ts']);
    expect(resolveRelativeImport('a.ts', './b', paths)).toBe('b.ts');
  });
});

describe('runIndexer — imports edges (RUN-217 locked decisions 1/2/3/4)', () => {
  /** Reports whatever specifiers the test wired up for each path — proves the wiring end to end
   *  without depending on RUN-216's real tree-sitter adapter (already covered in its own suite). */
  const importAdapter = (importsByPath: Record<string, string[]>): IndexParserAdapter => ({
    id: 'fake-imports',
    version: '1',
    canParse: () => true,
    parse: async (input: AdapterParseInput): Promise<AdapterParseResult> => ({
      symbols: [],
      diagnostics: [],
      imports: (importsByPath[input.path] ?? []).map((specifier) => ({ specifier })),
    }),
  });

  function importEdges(result: Awaited<ReturnType<typeof runIndexer>>) {
    return result.batches
      .flatMap((b) => decodeBatchRows(b.compressed))
      .filter((r) => r.kind === 'edge' && r.type === 'imports');
  }

  function fileUriFor(result: Awaited<ReturnType<typeof runIndexer>>, path: string): unknown {
    return result.batches
      .flatMap((b) => decodeBatchRows(b.compressed))
      .find((r) => r.kind === 'node' && r.type === 'file' && String(r.uri).endsWith(`/${path}`))?.uri;
  }

  it('wires a resolved relative specifier into a real imports edge between the two file URIs', async () => {
    const result = await runIndexer(
      new FakeIndexSource([
        { kind: 'file', path: 'src/a.ts', content: 'x' },
        { kind: 'file', path: 'src/b.ts', content: 'x' },
      ]),
      cfg(),
      target(),
      { adapters: new IndexAdapterRegistry().register(importAdapter({ 'src/a.ts': ['./b'] })) },
    );
    expect(importEdges(result)).toEqual([
      {
        kind: 'edge',
        type: 'imports',
        from: fileUriFor(result, 'src/a.ts'),
        to: fileUriFor(result, 'src/b.ts'),
      },
    ]);
  });

  it('resolves an import whose target sorts, and is therefore processed, AFTER the importer', async () => {
    // FakeIndexSource enumerates in sorted path order, so 'src/a.ts' is scanned strictly before
    // 'src/z.ts' — this is the exact case a single-pass (candidate-loop-only) resolver would miss
    // (RUN-217 locked decision 2), since 'src/z.ts' is not yet in `currentPaths` when 'src/a.ts'
    // is processed.
    const result = await runIndexer(
      new FakeIndexSource([
        { kind: 'file', path: 'src/a.ts', content: 'x' },
        { kind: 'file', path: 'src/z.ts', content: 'x' },
      ]),
      cfg(),
      target(),
      { adapters: new IndexAdapterRegistry().register(importAdapter({ 'src/a.ts': ['./z'] })) },
    );
    expect(importEdges(result)).toEqual([
      {
        kind: 'edge',
        type: 'imports',
        from: fileUriFor(result, 'src/a.ts'),
        to: fileUriFor(result, 'src/z.ts'),
      },
    ]);
  });

  it('declines a bare specifier — no edge to a node that does not exist in this graph', async () => {
    const result = await runIndexer(
      new FakeIndexSource([{ kind: 'file', path: 'src/a.ts', content: 'x' }]),
      cfg(),
      target(),
      { adapters: new IndexAdapterRegistry().register(importAdapter({ 'src/a.ts': ['react'] })) },
    );
    expect(importEdges(result)).toEqual([]);
  });

  it('declines a relative specifier that resolves to nothing this generation actually indexed', async () => {
    const result = await runIndexer(
      new FakeIndexSource([{ kind: 'file', path: 'src/a.ts', content: 'x' }]),
      cfg(),
      target(),
      { adapters: new IndexAdapterRegistry().register(importAdapter({ 'src/a.ts': ['./missing'] })) },
    );
    expect(importEdges(result)).toEqual([]);
  });

  it('declines an ambiguous extensionless specifier — two candidates present in the snapshot', async () => {
    const result = await runIndexer(
      new FakeIndexSource([
        { kind: 'file', path: 'src/a.ts', content: 'x' },
        { kind: 'file', path: 'src/util.ts', content: 'x' },
        { kind: 'file', path: 'src/util.js', content: 'x' },
      ]),
      cfg(),
      target(),
      { adapters: new IndexAdapterRegistry().register(importAdapter({ 'src/a.ts': ['./util'] })) },
    );
    expect(importEdges(result)).toEqual([]);
  });

  it('targets the imported FILE entity, never a symbol inside it — the edge URI has no # fragment', async () => {
    const result = await runIndexer(
      new FakeIndexSource([
        { kind: 'file', path: 'src/a.ts', content: 'x' },
        { kind: 'file', path: 'src/b.ts', content: 'x' },
      ]),
      cfg(),
      target(),
      { adapters: new IndexAdapterRegistry().register(importAdapter({ 'src/a.ts': ['./b'] })) },
    );
    const edges = importEdges(result);
    expect(edges).toHaveLength(1);
    const edge = edges[0] as { to: string };
    expect(edge.to.includes('#')).toBe(false);
  });

  it('collapses two specifiers from the same file resolving to the same target into one edge', async () => {
    const result = await runIndexer(
      new FakeIndexSource([
        { kind: 'file', path: 'src/a.ts', content: 'x' },
        { kind: 'file', path: 'src/b.ts', content: 'x' },
      ]),
      cfg(),
      target(),
      { adapters: new IndexAdapterRegistry().register(importAdapter({ 'src/a.ts': ['./b', './b.ts'] })) },
    );
    expect(importEdges(result)).toHaveLength(1);
  });

  it('produces a byte-identical result across two runs with import edges present', async () => {
    const run = () =>
      runIndexer(
        new FakeIndexSource([
          { kind: 'file', path: 'src/a.ts', content: 'x' },
          { kind: 'file', path: 'src/b.ts', content: 'x' },
        ]),
        cfg(),
        target(),
        { adapters: new IndexAdapterRegistry().register(importAdapter({ 'src/a.ts': ['./b'] })) },
      );
    const first = await run();
    const second = await run();
    expect(first.manifest.contentHash).toBe(second.manifest.contentHash);
  });
});

describe('runIndexer — related_to edges (RUN-257)', () => {
  /** Mirrors `importAdapter` above, one field over — proves the `references` wiring end to end
   *  without depending on the real markdown adapter (already covered in its own suite). */
  const referenceAdapter = (referencesByPath: Record<string, string[]>): IndexParserAdapter => ({
    id: 'fake-references',
    version: '1',
    canParse: () => true,
    parse: async (input: AdapterParseInput): Promise<AdapterParseResult> => ({
      symbols: [],
      diagnostics: [],
      references: (referencesByPath[input.path] ?? []).map((target) => ({ target })),
    }),
  });

  function relatedToEdges(result: Awaited<ReturnType<typeof runIndexer>>) {
    return result.batches
      .flatMap((b) => decodeBatchRows(b.compressed))
      .filter((r) => r.kind === 'edge' && r.type === 'related_to');
  }

  function fileUriFor(result: Awaited<ReturnType<typeof runIndexer>>, path: string): unknown {
    return result.batches
      .flatMap((b) => decodeBatchRows(b.compressed))
      .find((r) => r.kind === 'node' && r.type === 'file' && String(r.uri).endsWith(`/${path}`))?.uri;
  }

  it('wires a resolved reference into a related_to edge, never imports', async () => {
    const result = await runIndexer(
      new FakeIndexSource([
        { kind: 'file', path: 'README.md', content: 'x' },
        { kind: 'file', path: 'guide.md', content: 'x' },
      ]),
      cfg(),
      target(),
      { adapters: new IndexAdapterRegistry().register(referenceAdapter({ 'README.md': ['./guide.md'] })) },
    );
    expect(relatedToEdges(result)).toEqual([
      {
        kind: 'edge',
        type: 'related_to',
        from: fileUriFor(result, 'README.md'),
        to: fileUriFor(result, 'guide.md'),
      },
    ]);
    const importEdges = result.batches
      .flatMap((b) => decodeBatchRows(b.compressed))
      .filter((r) => r.kind === 'edge' && r.type === 'imports');
    expect(importEdges).toEqual([]);
  });

  it('resolves a reference whose target sorts, and is therefore processed, AFTER the referencer', async () => {
    const result = await runIndexer(
      new FakeIndexSource([
        { kind: 'file', path: 'a.md', content: 'x' },
        { kind: 'file', path: 'z.md', content: 'x' },
      ]),
      cfg(),
      target(),
      { adapters: new IndexAdapterRegistry().register(referenceAdapter({ 'a.md': ['./z.md'] })) },
    );
    expect(relatedToEdges(result)).toEqual([
      {
        kind: 'edge',
        type: 'related_to',
        from: fileUriFor(result, 'a.md'),
        to: fileUriFor(result, 'z.md'),
      },
    ]);
  });

  it('declines a bare target — no edge to a node that does not exist in this graph', async () => {
    const result = await runIndexer(
      new FakeIndexSource([{ kind: 'file', path: 'README.md', content: 'x' }]),
      cfg(),
      target(),
      {
        adapters: new IndexAdapterRegistry().register(
          referenceAdapter({ 'README.md': ['https://example.com/docs'] }),
        ),
      },
    );
    expect(relatedToEdges(result)).toEqual([]);
  });

  it('declines a reference that resolves to nothing this generation actually indexed', async () => {
    const result = await runIndexer(
      new FakeIndexSource([{ kind: 'file', path: 'README.md', content: 'x' }]),
      cfg(),
      target(),
      { adapters: new IndexAdapterRegistry().register(referenceAdapter({ 'README.md': ['./missing.md'] })) },
    );
    expect(relatedToEdges(result)).toEqual([]);
  });

  it('collapses two references from the same file resolving to the same target into one edge', async () => {
    const result = await runIndexer(
      new FakeIndexSource([
        { kind: 'file', path: 'README.md', content: 'x' },
        { kind: 'file', path: 'guide.md', content: 'x' },
      ]),
      cfg(),
      target(),
      {
        adapters: new IndexAdapterRegistry().register(
          referenceAdapter({ 'README.md': ['./guide.md', './guide.md'] }),
        ),
      },
    );
    expect(relatedToEdges(result)).toHaveLength(1);
  });

  it('produces a byte-identical result across two runs with related_to edges present', async () => {
    const run = () =>
      runIndexer(
        new FakeIndexSource([
          { kind: 'file', path: 'README.md', content: 'x' },
          { kind: 'file', path: 'guide.md', content: 'x' },
        ]),
        cfg(),
        target(),
        {
          adapters: new IndexAdapterRegistry().register(referenceAdapter({ 'README.md': ['./guide.md'] })),
        },
      );
    const first = await run();
    const second = await run();
    expect(first.manifest.contentHash).toBe(second.manifest.contentHash);
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
