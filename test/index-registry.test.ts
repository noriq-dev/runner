import { describe, expect, it } from 'vitest';
import { NOOP_ADAPTER } from '../src/index-adapters';
import { INDEX_LANGUAGES } from '../src/index-policy';
import { buildIndexAdapterRegistry } from '../src/index-registry';

describe('buildIndexAdapterRegistry (RUN-219)', () => {
  it('with every language admitted, a .ts path selects the real tree-sitter adapter', () => {
    const { registry } = buildIndexAdapterRegistry({ languages: [...INDEX_LANGUAGES] });
    const adapter = registry.select('src/a.ts');
    expect(adapter?.id).toBe('tree-sitter-typescript');
  });

  it('narrowed to markdown only, a .ts path falls through to NOOP_ADAPTER — never unrecognised', () => {
    const { registry } = buildIndexAdapterRegistry({ languages: ['markdown'] });
    const adapter = registry.select('src/a.ts');
    expect(adapter?.id).toBe(NOOP_ADAPTER.id);
  });

  it('narrowed to markdown only, a .md path still selects the real markdown adapter', () => {
    const { registry } = buildIndexAdapterRegistry({ languages: ['markdown'] });
    const adapter = registry.select('README.md');
    expect(adapter?.id).toBe('config-markdown');
  });

  it('narrowed to json only, .toml and .md both fall through to NOOP_ADAPTER', () => {
    const { registry } = buildIndexAdapterRegistry({ languages: ['json'] });
    expect(registry.select('a.toml')?.id).toBe(NOOP_ADAPTER.id);
    expect(registry.select('a.md')?.id).toBe(NOOP_ADAPTER.id);
    expect(registry.select('a.json')?.id).toBe('config-json');
  });

  it('an EMPTY language list still registers NOOP_ADAPTER — select() never returns null', () => {
    const { registry } = buildIndexAdapterRegistry({ languages: [] });
    expect(registry.select('src/a.ts')?.id).toBe(NOOP_ADAPTER.id);
    expect(registry.select('README.md')?.id).toBe(NOOP_ADAPTER.id);
    expect(registry.select('anything.at.all')?.id).toBe(NOOP_ADAPTER.id);
  });

  it('NOOP_ADAPTER is always the LAST registered entry, regardless of language configuration', () => {
    const { registry } = buildIndexAdapterRegistry({ languages: [...INDEX_LANGUAGES] });
    const all = registry.all;
    expect(all.length).toBeGreaterThan(1);
    expect(all[all.length - 1]?.id).toBe(NOOP_ADAPTER.id);
    // And it never shadows an earlier, more specific adapter for a path that one claims.
    expect(registry.select('src/a.ts')?.id).not.toBe(NOOP_ADAPTER.id);
  });

  it('tsx/js grammars are also gated on the shared typescript/javascript language entries', () => {
    const { registry } = buildIndexAdapterRegistry({ languages: ['javascript'] });
    expect(registry.select('a.tsx')?.id).toBe('tree-sitter-tsx');
    expect(registry.select('a.js')?.id).toBe('tree-sitter-javascript');
    expect(registry.select('a.ts')?.id).toBe('tree-sitter-typescript');
  });

  it('RUN-239: with every language admitted, .cpp/.h/.ini select the new tree-sitter adapters', () => {
    const { registry } = buildIndexAdapterRegistry({ languages: [...INDEX_LANGUAGES] });
    expect(registry.select('src/a.cpp')?.id).toBe('tree-sitter-cpp');
    expect(registry.select('src/a.h')?.id).toBe('tree-sitter-cpp');
    expect(registry.select('Config/DefaultGame.ini')?.id).toBe('tree-sitter-ini');
  });

  it('RUN-239: narrowed to cpp only, a .ini path falls through to NOOP_ADAPTER — languages are independent', () => {
    const { registry } = buildIndexAdapterRegistry({ languages: ['cpp'] });
    expect(registry.select('a.cpp')?.id).toBe('tree-sitter-cpp');
    expect(registry.select('a.ini')?.id).toBe(NOOP_ADAPTER.id);
  });

  it('RUN-239: .uproject/.uplugin select the EXISTING JSON adapter, no new code path', () => {
    const { registry } = buildIndexAdapterRegistry({ languages: [...INDEX_LANGUAGES] });
    expect(registry.select('Survival.uproject')?.id).toBe('config-json');
    expect(registry.select('Plugins/Foo/Foo.uplugin')?.id).toBe('config-json');
  });
});
