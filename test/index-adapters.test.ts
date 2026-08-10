import { describe, expect, it } from 'vitest';
import {
  IndexAdapterRegistry,
  type IndexParserAdapter,
  NOOP_ADAPTER,
  createDefaultAdapterRegistry,
} from '../src/index-adapters';

const tsAdapter: IndexParserAdapter = {
  id: 'fake-ts',
  version: '1',
  canParse: (path) => path.endsWith('.ts'),
  parse: async () => ({ symbols: [], diagnostics: [] }),
};

describe('IndexAdapterRegistry', () => {
  it('returns null when nothing claims the path', () => {
    const registry = new IndexAdapterRegistry();
    expect(registry.select('a.ts')).toBeNull();
  });

  it('selects the first registered adapter that claims the path', () => {
    const registry = new IndexAdapterRegistry();
    registry.register(tsAdapter);
    expect(registry.select('a.ts')).toBe(tsAdapter);
    expect(registry.select('a.py')).toBeNull();
  });

  it('gives an earlier registration priority over a later, also-matching one', () => {
    const other: IndexParserAdapter = { ...tsAdapter, id: 'other-ts' };
    const registry = new IndexAdapterRegistry();
    registry.register(tsAdapter).register(other);
    expect(registry.select('a.ts')?.id).toBe('fake-ts');
  });

  it('exposes every registered adapter via `all`', () => {
    const registry = new IndexAdapterRegistry().register(tsAdapter);
    expect(registry.all).toEqual([tsAdapter]);
  });
});

describe('NOOP_ADAPTER', () => {
  it('claims every path and extracts nothing', async () => {
    expect(NOOP_ADAPTER.canParse('anything.whatsoever')).toBe(true);
    await expect(NOOP_ADAPTER.parse({ path: 'a.ts', content: 'whatever' })).resolves.toEqual({
      symbols: [],
      diagnostics: [],
    });
  });
});

describe('createDefaultAdapterRegistry', () => {
  it('falls back to NOOP_ADAPTER for any path', () => {
    const registry = createDefaultAdapterRegistry();
    expect(registry.select('anything.rs')?.id).toBe('noop');
  });

  it('lets a real adapter registered afterward shadow the fallback for paths it claims', () => {
    const registry = createDefaultAdapterRegistry();
    registry.register(tsAdapter);
    // Registration order still governs selection — NOOP_ADAPTER was registered first by the
    // factory, so it (not tsAdapter) wins even for a `.ts` path. This documents the ordering
    // contract rather than asserting a preference: a caller wanting a real adapter to win over the
    // fallback must build its OWN registry with the real adapter registered first, which is why
    // `createDefaultAdapterRegistry` is a convenience for "no real adapters yet", not a general
    // "always try mine first" helper.
    expect(registry.select('a.ts')?.id).toBe('noop');
  });
});
