import { describe, expect, it } from 'vitest';
import { createTreeSitterAdapter, createTreeSitterAdapterRegistry } from '../src/index-treesitter';
import { TreeSitterRuntime } from '../src/treesitter-runtime';

const runtime = new TreeSitterRuntime();
const tsAdapter = createTreeSitterAdapter('typescript', runtime);
const jsAdapter = createTreeSitterAdapter('javascript', runtime);
const tsxAdapter = createTreeSitterAdapter('tsx', runtime);

describe('createTreeSitterAdapter — canParse', () => {
  it('claims exactly the extensions its grammar owns', () => {
    expect(tsAdapter.canParse('a.ts')).toBe(true);
    expect(tsAdapter.canParse('a.tsx')).toBe(false);
    expect(tsAdapter.canParse('a.js')).toBe(false);
    expect(tsxAdapter.canParse('a.tsx')).toBe(true);
    expect(jsAdapter.canParse('a.js')).toBe(true);
    expect(jsAdapter.canParse('a.jsx')).toBe(true);
  });
});

describe('createTreeSitterAdapter — declarations', () => {
  it('extracts a top-level function declaration', async () => {
    const result = await tsAdapter.parse({ path: 'a.ts', content: 'function add(a, b) { return a + b; }' });
    expect(result.diagnostics).toEqual([]);
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ symbolPath: ['add'], nodeType: 'symbol', label: 'add' }),
    );
  });

  it('extracts a class and its methods, nested under the class name', async () => {
    const result = await tsAdapter.parse({
      path: 'a.ts',
      content: 'class Widget { constructor() {} render() {} }',
    });
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['Widget'] }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['Widget', 'constructor'] }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['Widget', 'render'] }));
  });

  it('extracts interface, type alias, and enum declarations', async () => {
    const result = await tsAdapter.parse({
      path: 'a.ts',
      content: 'interface Options { name: string; }\ntype Id = string | number;\nenum Color { Red, Green }',
    });
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['Options'] }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['Id'] }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['Color'] }));
  });

  it('extracts a const bound to an arrow function as a declaration', async () => {
    const result = await tsAdapter.parse({ path: 'a.ts', content: 'export const square = (x) => x * x;' });
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['square'] }));
  });

  it('a JavaScript source yields declarations the same way a TypeScript one does', async () => {
    const result = await jsAdapter.parse({
      path: 'a.js',
      content: 'function add(a, b) { return a + b; }\nclass W { m() {} }',
    });
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['add'] }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['W', 'm'] }));
  });

  it('extracts describe/it blocks as nested test symbols', async () => {
    const result = await tsAdapter.parse({
      path: 'a.test.ts',
      content: "describe('Widget', () => { it('renders', () => { expect(1).toBe(1); }); });",
    });
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ symbolPath: ['Widget', 'renders'], nodeType: 'test' }),
    );
  });

  it("records the exact source span as a symbol's content", async () => {
    const result = await tsAdapter.parse({ path: 'a.ts', content: 'function add(a, b) { return a + b; }' });
    const sym = result.symbols.find((s) => s.symbolPath.join('.') === 'add');
    expect(sym?.content).toBe('function add(a, b) { return a + b; }');
  });
});

describe('createTreeSitterAdapter — imports', () => {
  it('reads a static import specifier as a literal fact', async () => {
    const result = await tsAdapter.parse({ path: 'a.ts', content: "import { readFile } from 'node:fs';" });
    expect(result.imports).toEqual([{ specifier: 'node:fs' }]);
  });

  it('reads a re-export specifier the same way', async () => {
    const result = await tsAdapter.parse({ path: 'a.ts', content: "export { x } from './y';" });
    expect(result.imports).toEqual([{ specifier: './y' }]);
  });

  it('declines a dynamic import with a computed specifier — no entry, no guess', async () => {
    const result = await tsAdapter.parse({
      path: 'a.ts',
      content: "const name = 'node:os';\nimport(name).then(() => {});",
    });
    expect(result.imports).toEqual([]);
  });
});

describe('createTreeSitterAdapter — reliable calls', () => {
  it('resolves an unambiguous bare call to a same-file function as "resolved"', async () => {
    const result = await tsAdapter.parse({
      path: 'a.ts',
      content: 'function add(a, b) { return helper(a) + b; }\nfunction helper(x) { return x; }',
    });
    expect(result.calls).toContainEqual({
      fromSymbolPath: ['add'],
      toSymbolPath: ['helper'],
      confidence: 'resolved',
    });
  });

  it('resolves a this.method() call to a same-class method as "inferred", distinguishably from resolved', async () => {
    const result = await tsAdapter.parse({
      path: 'a.ts',
      content: 'class Widget { increment() { this.render(); } render() {} }',
    });
    expect(result.calls).toContainEqual({
      fromSymbolPath: ['Widget', 'increment'],
      toSymbolPath: ['Widget', 'render'],
      confidence: 'inferred',
    });
    const resolved = result.calls?.filter((c) => c.confidence === 'resolved') ?? [];
    const inferred = result.calls?.filter((c) => c.confidence === 'inferred') ?? [];
    expect(resolved).toHaveLength(0);
    expect(inferred).toHaveLength(1);
  });

  it('declines a call through a member expression on something other than this — no guessed target', async () => {
    const result = await tsAdapter.parse({
      path: 'a.ts',
      content: 'function log(x) { console.log(x); }',
    });
    expect(result.calls).toEqual([]);
  });

  it('declines a call to an imported/global/undeclared name — no fabricated edge', async () => {
    const result = await tsAdapter.parse({
      path: 'a.ts',
      content: "import { helper } from './other';\nfunction add(a) { return helper(a); }",
    });
    expect(result.calls).toEqual([]);
  });

  it('declines an ambiguous bare call matching more than one same-file declaration', async () => {
    const result = await tsAdapter.parse({
      path: 'a.ts',
      content: [
        'function run() { return dup(); }',
        'function dup() { return 1; }',
        'const dup = () => 2;', // A real redeclaration is invalid JS, but a same-named export from
        // two branches or a namespaced re-declaration is plausible enough to exercise ambiguity —
        // the point under test is purely "more than one candidate must decline", not validity.
      ].join('\n'),
    });
    expect(result.calls?.some((c) => c.toSymbolPath.join('.') === 'dup')).toBe(false);
  });
});

describe('createTreeSitterAdapter — malformed input', () => {
  it('yields a single bounded diagnostic and whatever declarations parsed cleanly, never throws', async () => {
    const content = 'function good() { return 1; }\nfunction broken( {{{ not valid !!!';
    await expect(tsAdapter.parse({ path: 'a.ts', content })).resolves.not.toThrow();
    const result = await tsAdapter.parse({ path: 'a.ts', content });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.severity).toBe('warning');
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['good'] }));
  });

  it('a fully empty file yields no symbols, no diagnostics, no throw', async () => {
    const result = await tsAdapter.parse({ path: 'a.ts', content: '' });
    expect(result).toEqual({ symbols: [], diagnostics: [], imports: [], calls: [] });
  });
});

describe('createTreeSitterAdapter — parser identity', () => {
  it('carries a stable id per grammar', () => {
    expect(tsAdapter.id).toBe('tree-sitter-typescript');
    expect(jsAdapter.id).toBe('tree-sitter-javascript');
    expect(tsxAdapter.id).toBe('tree-sitter-tsx');
  });
});

describe('createTreeSitterAdapterRegistry', () => {
  it('routes each extension to its own grammar and falls back to noop for anything else', () => {
    const { registry } = createTreeSitterAdapterRegistry();
    expect(registry.select('a.ts')?.id).toBe('tree-sitter-typescript');
    expect(registry.select('a.tsx')?.id).toBe('tree-sitter-tsx');
    expect(registry.select('a.js')?.id).toBe('tree-sitter-javascript');
    expect(registry.select('a.py')?.id).toBe('noop');
  });

  it('shares one runtime across all three registered grammars', async () => {
    const { registry, runtime: sharedRuntime } = createTreeSitterAdapterRegistry();
    await registry.select('a.ts')?.parse({ path: 'a.ts', content: 'function f(){}' });
    await registry.select('a.js')?.parse({ path: 'a.js', content: 'function f(){}' });
    expect(sharedRuntime.stats.initCount).toBe(1);
  });
});
