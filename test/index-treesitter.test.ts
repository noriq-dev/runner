import { describe, expect, it } from 'vitest';
import { buildSymbolEntityUri } from '../src/index-entity';
import type { UriScope } from '../src/index-entity';
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

describe('createTreeSitterAdapter — source ranges (RUN-217)', () => {
  it('records a 1-based, inclusive-both-ends range matching the source', async () => {
    const result = await tsAdapter.parse({
      path: 'a.ts',
      content: 'function add(a, b) {\n  return a + b;\n}',
    });
    const sym = result.symbols.find((s) => s.symbolPath.join('.') === 'add');
    expect(sym?.range).toEqual({ startLine: 1, endLine: 3 });
  });

  it('leaves the symbol URI-relevant symbolPath untouched by adding a range', async () => {
    const result = await tsAdapter.parse({ path: 'a.ts', content: 'function add(a, b) { return a + b; }' });
    const sym = result.symbols.find((s) => s.symbolPath.join('.') === 'add');
    expect(sym?.symbolPath).toEqual(['add']);
  });

  // A range is derived, per-parse — it must NEVER leak into identity. The test above proves one
  // field on one parse; this proves the thing the task's own acceptance line actually asks for:
  // TWO DIFFERENT parses of the same declarations, formatted differently, still produce the same
  // symbolPaths in the same order (and therefore the same URIs), even though their ranges — by
  // construction, since the fixture below is genuinely reformatted — do not.
  it('keeps every symbolPath — and therefore every symbol URI — byte-identical across a whitespace-only reformat', async () => {
    const compact = [
      'function add(a, b) { return a + b; }',
      'class Widget {',
      '  render() {',
      '    const helper = (x) => x + 1;',
      '    return helper(1);',
      '  }',
      '}',
    ].join('\n');

    // Same declarations, same nesting (top-level function; a class with a method; an arrow bound
    // to a local const, nested two levels deep inside that method) — only whitespace and line
    // breaks differ: extra blank lines, deeper indentation, a signature broken across lines, and a
    // trailing newline the compact source does not have.
    const reformatted = [
      '',
      'function add(',
      '  a,',
      '  b',
      ') {',
      '  return a + b;',
      '}',
      '',
      '',
      'class Widget {',
      '',
      '    render() {',
      '        const helper = (x) =>',
      '            x + 1;',
      '',
      '        return helper(1);',
      '    }',
      '',
      '}',
      '',
    ].join('\n');

    const before = await tsAdapter.parse({ path: 'a.ts', content: compact });
    const after = await tsAdapter.parse({ path: 'a.ts', content: reformatted });

    const beforePaths = before.symbols.map((s) => s.symbolPath);
    const afterPaths = after.symbols.map((s) => s.symbolPath);
    // Sanity on the fixture itself, so a future edit that breaks one of the four declarations
    // fails loudly here rather than the assertions below silently comparing two empty arrays.
    expect(beforePaths).toEqual([['add'], ['Widget'], ['Widget', 'render'], ['Widget', 'render', 'helper']]);

    expect(afterPaths).toEqual(beforePaths); // same symbolPaths, same emission order.

    // Keeps the test honest: if the ranges did NOT differ, the fixture would not actually be
    // reformatted, and the equality above would be proving nothing.
    expect(before.symbols).toHaveLength(after.symbols.length);
    for (let i = 0; i < before.symbols.length; i++) {
      expect(after.symbols[i]?.range).not.toEqual(before.symbols[i]?.range);
    }

    // The identity that actually ships: run both parses' paths through the real URI builder
    // (`index-entity.ts`) with the same scope, and require the resulting URIs to match exactly —
    // not just their inputs.
    const scope: UriScope = { projectKey: 'RUN', repositoryKey: 'runner' };
    const beforeUris = beforePaths.map((symbolPath, i) =>
      buildSymbolEntityUri(scope, 'a.ts', symbolPath, before.symbols[i]!.nodeType),
    );
    const afterUris = afterPaths.map((symbolPath, i) =>
      buildSymbolEntityUri(scope, 'a.ts', symbolPath, after.symbols[i]!.nodeType),
    );
    expect(afterUris).toEqual(beforeUris);
  });
});

describe('createTreeSitterAdapter — TS overload signatures (RUN-217 locked decision 8)', () => {
  it('gives each overload signature, plus the implementation, its own symbol entity', async () => {
    const result = await tsAdapter.parse({
      path: 'a.ts',
      content: [
        'function foo(a: string): void;',
        'function foo(a: number): void;',
        'function foo(a: any): void { console.log(a); }',
      ].join('\n'),
    });
    const fooSymbols = result.symbols.filter((s) => s.symbolPath.length === 1 && s.symbolPath[0] === 'foo');
    expect(fooSymbols).toHaveLength(3);
  });

  it('never resolves a same-file call to an overloaded name — the existing ambiguity rule covers it', async () => {
    const result = await tsAdapter.parse({
      path: 'a.ts',
      content: [
        'function foo(a: string): void;',
        'function foo(a: number): void;',
        'function foo(a: any): void { console.log(a); }',
        'function caller() { foo(1); }',
      ].join('\n'),
    });
    expect(result.calls?.some((c) => c.toSymbolPath.join('.') === 'foo')).toBe(false);
  });

  it('gives each class-method overload signature its own symbol entity, nested under the class', async () => {
    const result = await tsAdapter.parse({
      path: 'a.ts',
      content: [
        'class Widget {',
        '  render(a: string): void;',
        '  render(a: number): void;',
        '  render(a: any): void { console.log(a); }',
        '}',
      ].join('\n'),
    });
    const renderSymbols = result.symbols.filter((s) => s.symbolPath.join('.').startsWith('Widget.render'));
    expect(renderSymbols).toHaveLength(3);
  });

  it('an ambient (`declare function`) overload signature is still extracted, without a body', async () => {
    const result = await tsAdapter.parse({ path: 'a.ts', content: 'declare function foo(): void;' });
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['foo'] }));
  });
});

describe('createTreeSitterAdapter — interfaces and abstract classes (RUN-217)', () => {
  it('nests an interface method signature under the interface name', async () => {
    const result = await tsAdapter.parse({
      path: 'a.ts',
      content: 'interface Options { render(a: string): void; }',
    });
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['Options'] }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['Options', 'render'] }));
  });

  it('extracts an abstract class and both its abstract and concrete methods', async () => {
    const result = await tsAdapter.parse({
      path: 'a.ts',
      content: 'abstract class Base {\n  abstract render(): void;\n  concrete() {}\n}',
    });
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['Base'] }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['Base', 'render'] }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['Base', 'concrete'] }));
  });
});

describe('createTreeSitterAdapter — namespaces (RUN-217 discretion)', () => {
  it('nests a declaration inside a namespace under the namespace name', async () => {
    const result = await tsAdapter.parse({
      path: 'a.ts',
      content: 'namespace Foo {\n  export function bar() {}\n}',
    });
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['Foo'] }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['Foo', 'bar'] }));
  });

  it('keeps a dotted namespace name as one path segment, not two', async () => {
    const result = await tsAdapter.parse({
      path: 'a.ts',
      content: 'namespace A.B {\n  export function bar() {}\n}',
    });
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['A.B'] }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['A.B', 'bar'] }));
  });
});

describe('createTreeSitterAdapter — generators', () => {
  it('extracts a generator function declaration the same way as an ordinary function', async () => {
    const result = await tsAdapter.parse({ path: 'a.ts', content: 'function* gen() { yield 1; }' });
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['gen'] }));
  });

  it('extracts a const bound to a generator function expression', async () => {
    const result = await jsAdapter.parse({ path: 'a.js', content: 'const gen = function*() { yield 1; };' });
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['gen'] }));
  });
});

describe('createTreeSitterAdapter — ESM exports (RUN-217)', () => {
  it('extracts a named export the same as an unexported declaration', async () => {
    const result = await tsAdapter.parse({ path: 'a.ts', content: 'export function foo() {}' });
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['foo'] }));
  });

  it('extracts a default-exported named function/class by its own name', async () => {
    const result = await tsAdapter.parse({
      path: 'a.ts',
      content: 'export default function baz() {}\nexport default class Qux {}',
    });
    // Two separate parses so each default export is unambiguous about which symbol is which —
    // combined here only to prove the walk reaches inside `export default` at all.
    const result2 = await tsAdapter.parse({ path: 'a.ts', content: 'export default class Qux {}' });
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['baz'] }));
    expect(result2.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['Qux'] }));
  });

  it('declines an anonymous export default — no name to hang an identity on', async () => {
    const result = await tsAdapter.parse({ path: 'a.ts', content: 'export default () => {};' });
    expect(result.symbols).toEqual([]);
  });

  it('reads a bare re-export-list statement without treating it as an import', async () => {
    const result = await tsAdapter.parse({ path: 'a.ts', content: 'const a = 1;\nexport { a };' });
    expect(result.imports).toEqual([]);
  });

  it('reads `export * from` and `export * as ns from` as import-shaped dependency facts', async () => {
    const result = await tsAdapter.parse({
      path: 'a.ts',
      content: "export * from './mod';\nexport * as ns from './mod2';",
    });
    expect(result.imports).toEqual([{ specifier: './mod' }, { specifier: './mod2' }]);
  });
});

describe('createTreeSitterAdapter — CommonJS (RUN-217 discretion)', () => {
  it('reads a require() literal specifier the same way a static import is read', async () => {
    const result = await jsAdapter.parse({ path: 'a.js', content: "const fs = require('node:fs');" });
    expect(result.imports).toEqual([{ specifier: 'node:fs' }]);
  });

  it('declines a require() with a computed argument — no entry, no guess', async () => {
    const result = await jsAdapter.parse({
      path: 'a.js',
      content: "const name = 'node:fs';\nconst fs = require(name);",
    });
    expect(result.imports).toEqual([]);
  });

  it('never treats require() as a same-file call site', async () => {
    const result = await jsAdapter.parse({ path: 'a.js', content: "const fs = require('node:fs');" });
    expect(result.calls).toEqual([]);
  });

  it('treats `exports.NAME = function(){}` as a declaration named NAME', async () => {
    const result = await jsAdapter.parse({
      path: 'a.js',
      content: 'exports.qux = function() { return 1; };',
    });
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['qux'] }));
  });

  it('treats `module.exports.NAME = function(){}` as a declaration named NAME', async () => {
    const result = await jsAdapter.parse({
      path: 'a.js',
      content: 'module.exports.baz = function() { return 1; };',
    });
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['baz'] }));
  });

  it('declines a bare `module.exports = function(){}` — anonymous, nothing to hang identity on', async () => {
    const result = await jsAdapter.parse({ path: 'a.js', content: 'module.exports = function() {};' });
    expect(result.symbols).toEqual([]);
  });

  it('does not mistake an unrelated `foo.bar = function(){}` assignment for an export', async () => {
    const result = await jsAdapter.parse({ path: 'a.js', content: 'foo.bar = function() {};' });
    expect(result.symbols).toEqual([]);
  });
});

describe('createTreeSitterAdapter — declared languages (RUN-217 locked decision 7)', () => {
  it('declares typescript and javascript on every grammar — tsx/jsx are their syntax, not a third language', () => {
    expect(tsAdapter.languages).toEqual(['typescript', 'javascript']);
    expect(jsAdapter.languages).toEqual(['typescript', 'javascript']);
    expect(tsxAdapter.languages).toEqual(['typescript', 'javascript']);
  });
});

describe('createTreeSitterAdapter — TSX', () => {
  it('extracts a function component and resolves a call from inside its JSX', async () => {
    const result = await tsxAdapter.parse({
      path: 'a.tsx',
      content: [
        'export function App() {',
        '  return <div onClick={() => track()}>hi</div>;',
        '}',
        'function track() {}',
      ].join('\n'),
    });
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['App'] }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ symbolPath: ['track'] }));
    expect(result.calls).toContainEqual({
      fromSymbolPath: ['App'],
      toSymbolPath: ['track'],
      confidence: 'resolved',
    });
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
