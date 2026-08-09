import { describe, expect, it } from 'vitest';
import { TreeSitterRuntime, grammarIdForPath, loadGrammarBytes } from '../src/treesitter-runtime';

describe('grammarIdForPath', () => {
  it('routes .tsx to its own grammar (measured: the plain TypeScript grammar mis-parses JSX)', () => {
    expect(grammarIdForPath('src/App.tsx')).toBe('tsx');
  });

  it('routes .ts/.mts/.cts to typescript', () => {
    expect(grammarIdForPath('src/a.ts')).toBe('typescript');
    expect(grammarIdForPath('src/a.mts')).toBe('typescript');
    expect(grammarIdForPath('src/a.cts')).toBe('typescript');
  });

  it('routes .js/.jsx/.mjs/.cjs to javascript (measured: the javascript grammar parses JSX fine)', () => {
    expect(grammarIdForPath('src/a.js')).toBe('javascript');
    expect(grammarIdForPath('src/a.jsx')).toBe('javascript');
    expect(grammarIdForPath('src/a.mjs')).toBe('javascript');
    expect(grammarIdForPath('src/a.cjs')).toBe('javascript');
  });

  it('returns null for an unrecognized extension', () => {
    expect(grammarIdForPath('README.md')).toBeNull();
    expect(grammarIdForPath('src/a.py')).toBeNull();
  });
});

describe('loadGrammarBytes', () => {
  it('returns real, non-empty WASM bytes for every grammar this daemon ships', () => {
    for (const id of ['typescript', 'javascript', 'tsx'] as const) {
      const bytes = loadGrammarBytes(id);
      expect(bytes.length).toBeGreaterThan(1000);
      // A WASM binary's first four bytes are the fixed magic number `\0asm`.
      expect(Array.from(bytes.slice(0, 4))).toEqual([0x00, 0x61, 0x73, 0x6d]);
    }
  });
});

describe('TreeSitterRuntime', () => {
  it('inits the WASM engine exactly once, and loads a given grammar exactly once, across many requests', async () => {
    const runtime = new TreeSitterRuntime();
    await Promise.all([
      runtime.grammar('typescript'),
      runtime.grammar('typescript'),
      runtime.grammar('javascript'),
      runtime.grammar('typescript'),
    ]);
    // A second round after the first has settled must not load anything again either.
    await runtime.grammar('typescript');
    await runtime.grammar('javascript');

    expect(runtime.stats.initCount).toBe(1);
    expect(runtime.stats.grammarLoadCounts).toEqual({ typescript: 1, javascript: 1 });
  });

  it('parses real TypeScript source through a grammar it loaded', async () => {
    const runtime = new TreeSitterRuntime();
    const parser = await runtime.parserFor('typescript');
    const tree = parser.parse('function add(a: number, b: number): number { return a + b; }');
    expect(tree?.rootNode.hasError).toBe(false);
    expect(tree?.rootNode.text).toContain('function add');
  });

  it('does not throw on malformed source — tree-sitter is error-tolerant by design', async () => {
    const runtime = new TreeSitterRuntime();
    const parser = await runtime.parserFor('typescript');
    const tree = parser.parse('function broken( {{{ this is not valid syntax at all !!!');
    expect(tree?.rootNode.hasError).toBe(true);
  });

  it('gives .tsx source a clean parse under the tsx grammar but errors under the plain typescript grammar', async () => {
    const runtime = new TreeSitterRuntime();
    const jsx = 'export function App() { return <div className="x">{value}</div>; }';

    const tsxParser = await runtime.parserFor('tsx');
    expect(tsxParser.parse(jsx)?.rootNode.hasError).toBe(false);

    const tsParser = await runtime.parserFor('typescript');
    expect(tsParser.parse(jsx)?.rootNode.hasError).toBe(true);
  });
});
