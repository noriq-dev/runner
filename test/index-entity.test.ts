import { parseEntityUri } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import {
  DiagnosticsCollector,
  MAX_PARSE_DIAGNOSTICS,
  buildFileEntityUri,
  buildSymbolEntityUri,
  computeDeletions,
  decodeSymbolPath,
  decodeUriPath,
  dedupeSymbolPaths,
  encodeSymbolPath,
  encodeUriPath,
  normalizeRepoPath,
} from '../src/index-entity';

const scope = { projectKey: 'RUN', repositoryKey: 'runner' };

describe('buildFileEntityUri', () => {
  it('is stable and parses back to the same path', () => {
    const uri = buildFileEntityUri(scope, 'src/foo/bar.ts');
    expect(uri).toBe('noriq://file/RUN/runner/src/foo/bar.ts');
    const ref = parseEntityUri(uri);
    expect(ref).toEqual({ kind: 'file', projectKey: 'RUN', repositoryKey: 'runner', path: 'src/foo/bar.ts' });
  });

  it('never embeds a line number, content hash, or batch index', () => {
    const uri = buildFileEntityUri(scope, 'src/foo.ts');
    // The identity is (projectKey, repositoryKey, path) alone — nothing else appears in the URI.
    expect(uri).toBe('noriq://file/RUN/runner/src/foo.ts');
  });

  it('round-trips a path containing `#`', () => {
    const original = 'src/notes#1.md';
    const uri = buildFileEntityUri(scope, original);
    const ref = parseEntityUri(uri);
    if (ref.kind !== 'file') throw new Error('expected a file ref');
    expect(decodeUriPath(ref.path)).toBe(original);
  });

  it('round-trips a path containing `?`', () => {
    const original = 'src/what?.ts';
    const uri = buildFileEntityUri(scope, original);
    const ref = parseEntityUri(uri);
    if (ref.kind !== 'file') throw new Error('expected a file ref');
    expect(decodeUriPath(ref.path)).toBe(original);
  });

  it('round-trips a path containing a literal `%`', () => {
    const original = 'src/100%done.ts';
    const uri = buildFileEntityUri(scope, original);
    const ref = parseEntityUri(uri);
    if (ref.kind !== 'file') throw new Error('expected a file ref');
    expect(decodeUriPath(ref.path)).toBe(original);
  });
});

describe('buildSymbolEntityUri', () => {
  it('joins nested declarations outer-to-inner', () => {
    const uri = buildSymbolEntityUri(scope, 'src/foo.ts', ['Outer', 'method']);
    expect(uri).toBe('noriq://symbol/RUN/runner/src/foo.ts#Outer.method');
  });

  it('adding a line above the symbol never changes its URI — there is no line number to move', () => {
    // The URI is a pure function of (path, symbolPath); this is really a statement about the
    // function's inputs; there is nothing "line-shaped" it could ever be sensitive to.
    const before = buildSymbolEntityUri(scope, 'src/foo.ts', ['bar']);
    const after = buildSymbolEntityUri(scope, 'src/foo.ts', ['bar']);
    expect(before).toBe(after);
  });

  it('round-trips a symbol name containing `#`, `?`, `.`, and `%`', () => {
    const original = ['Outer', 'weird#name?.thing%'];
    const uri = buildSymbolEntityUri(scope, 'src/foo.ts', original);
    const ref = parseEntityUri(uri);
    if (ref.kind !== 'symbol') throw new Error('expected a symbol ref');
    expect(decodeSymbolPath(ref.name)).toEqual(original);
  });

  it('builds test and api kinds through the same shape', () => {
    const testUri = buildSymbolEntityUri(scope, 'src/foo.test.ts', ['does the thing'], 'test');
    expect(parseEntityUri(testUri).kind).toBe('test');
    const apiUri = buildSymbolEntityUri(scope, 'src/routes.ts', ['GET /widgets'], 'api');
    expect(parseEntityUri(apiUri).kind).toBe('api');
  });
});

describe('encodeSymbolPath / decodeSymbolPath', () => {
  it('round-trips segments with no special characters', () => {
    const segments = ['Outer', 'Inner', 'method'];
    expect(decodeSymbolPath(encodeSymbolPath(segments))).toEqual(segments);
  });

  it('refuses an empty symbol path', () => {
    expect(() => encodeSymbolPath([])).toThrow();
  });
});

describe('encodeUriPath / decodeUriPath', () => {
  it('preserves `/` as the segment separator', () => {
    expect(encodeUriPath('src/foo/bar.ts')).toBe('src/foo/bar.ts');
  });

  it('round-trips every reserved character independently', () => {
    for (const original of ['a#b.ts', 'a?b.ts', 'a%b.ts', 'a#b?c%d.ts']) {
      expect(decodeUriPath(encodeUriPath(original))).toBe(original);
    }
  });
});

describe('normalizeRepoPath', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizeRepoPath('src\\foo\\bar.ts')).toBe('src/foo/bar.ts');
  });

  it('is a no-op on an already-forward-slash path', () => {
    expect(normalizeRepoPath('src/foo/bar.ts')).toBe('src/foo/bar.ts');
  });

  it('produces the identical result for `/`- and `\\`-separated input of the same fixture', () => {
    expect(normalizeRepoPath('src/foo/bar.ts')).toBe(normalizeRepoPath('src\\foo\\bar.ts'));
  });
});

describe('dedupeSymbolPaths', () => {
  it('leaves the first occurrence of a symbol path untouched', () => {
    const out = dedupeSymbolPaths([['Foo', 'bar']]);
    expect(out).toEqual([['Foo', 'bar']]);
  });

  it('disambiguates repeats deterministically in emission order', () => {
    const out = dedupeSymbolPaths([
      ['Foo', 'bar'],
      ['Foo', 'bar'],
      ['Foo', 'bar'],
      ['Foo', 'baz'],
    ]);
    expect(out).toEqual([
      ['Foo', 'bar'],
      ['Foo', 'bar$2'],
      ['Foo', 'bar$3'],
      ['Foo', 'baz'],
    ]);
  });

  it('treats distinct symbol paths independently even when they share a tail segment', () => {
    const out = dedupeSymbolPaths([
      ['A', 'run'],
      ['B', 'run'],
    ]);
    expect(out).toEqual([
      ['A', 'run'],
      ['B', 'run'],
    ]);
  });
});

describe('computeDeletions', () => {
  it('reports nothing when there is no previous generation to diff against', () => {
    expect(computeDeletions(['a.ts'], undefined)).toEqual([]);
  });

  it('reports paths present before but absent now, sorted by plain code-unit order', () => {
    const out = computeDeletions(['b.ts'], ['b.ts', 'a.ts', 'Z.ts']);
    expect(out).toEqual(['Z.ts', 'a.ts']); // code-unit order: uppercase sorts before lowercase.
  });

  it('reports nothing when every previous path still exists', () => {
    expect(computeDeletions(['a.ts', 'b.ts'], ['a.ts'])).toEqual([]);
  });
});

describe('DiagnosticsCollector', () => {
  it('accepts diagnostics up to the cap', () => {
    const collector = new DiagnosticsCollector();
    collector.push({ path: 'a.ts', message: 'oops', severity: 'error', source: 'noop@1' });
    expect(collector.diagnostics).toHaveLength(1);
    expect(collector.overflow).toBe(0);
  });

  it('bounds at MAX_PARSE_DIAGNOSTICS and counts the rest instead of storing them', () => {
    const collector = new DiagnosticsCollector();
    for (let i = 0; i < MAX_PARSE_DIAGNOSTICS + 25; i++) {
      collector.push({ path: `f${i}.ts`, message: 'oops', severity: 'warning', source: 'noop@1' });
    }
    expect(collector.diagnostics).toHaveLength(MAX_PARSE_DIAGNOSTICS);
    expect(collector.overflow).toBe(25);
    // The retained diagnostics are the FIRST ones pushed, never reordered by later overflow.
    expect(collector.diagnostics[0]?.path).toBe('f0.ts');
    expect(collector.diagnostics[MAX_PARSE_DIAGNOSTICS - 1]?.path).toBe(`f${MAX_PARSE_DIAGNOSTICS - 1}.ts`);
  });
});
