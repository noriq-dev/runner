import { describe, expect, it } from 'vitest';
import { compareGenerations } from '../src/index-debug';
import { INDEX_LANGUAGES } from '../src/index-policy';
import type { ResolvedIndexConfig } from '../src/index-policy';
import { buildIndexAdapterRegistry } from '../src/index-registry';
import { FakeIndexSource } from '../src/index-source';
import { runIndexer } from '../src/indexer';
import type { IndexRunTarget } from '../src/indexer';

/**
 * "The determinism test compares canonical artifacts ... AND must assert stability under a
 * changed ENUMERATION order" (RUN-219's execution spec, locked decision 10). The spec's own note
 * — "`index-source.ts` REQUIRES ascending path order from a source and refuses loudly otherwise —
 * so vary what the policy layer sees, not the source's contract" — is why this file does two
 * things rather than one:
 *
 * 1. Feed `runIndexer` the SAME file set built from `FakeIndexSource` constructors given the items
 *    in genuinely different insertion orders. `FakeIndexSource.list()` sorts before yielding by
 *    default (`index-source.ts`'s own doc: "a well-behaved source, meeting `IndexSource.list`'s
 *    ordering contract exactly"), so `scanIndexSource`/`runIndexer` see the identical ascending
 *    sequence either way — this is the honest form the property can take without breaking the
 *    contract `index-source.ts` enforces: the canonical output cannot depend on an incidental
 *    construction-time order that never reaches the pipeline as a different order at all.
 * 2. Separately, PROVE why a genuinely out-of-order source cannot silently produce a different
 *    canonical result: `index-scan.ts`'s own doc says a source that breaks the ascending contract
 *    is "refused LOUDLY rather than silently re-sorted" — measured here directly with
 *    `{ scrambled: true }`. This is what makes (1) sufficient: the ONLY way enumeration order could
 *    reach the indexer differently is for a source to violate its contract, and that path throws
 *    before it ever reaches `sortRecords`/`contentHash`, rather than reaching them silently wrong.
 */

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

const FILES = [
  { path: 'src/a.ts', content: "import { z } from './z';\nexport function a() { return z(); }\n" },
  { path: 'src/m.ts', content: 'export function m() { return 1; }\n' },
  { path: 'src/z.ts', content: 'export function z() { return 2; }\n' },
  { path: 'README.md', content: '# Title\n\nSome text with a [link](./src/a.ts).\n' },
  { path: 'config.json', content: '{"port": 8080}' },
];

describe('canonical output does not depend on construction-time enumeration order', () => {
  it('a forward-ordered and a reverse-ordered FakeIndexSource construction produce byte-identical output', async () => {
    const config = cfg();
    const forward = FILES.map((f) => ({ kind: 'file' as const, ...f }));
    const reversed = [...forward].reverse();

    const { registry: r1 } = buildIndexAdapterRegistry(config);
    const { registry: r2 } = buildIndexAdapterRegistry(config);
    const first = await runIndexer(new FakeIndexSource(forward), config, target(), { adapters: r1 });
    const second = await runIndexer(new FakeIndexSource(reversed), config, target(), { adapters: r2 });

    expect(compareGenerations(first, second)).toEqual({ ok: true, mismatches: [] });
    // And the RECORD order itself (not just the hash) is identical — `sortRecords` owns ordering,
    // never the order candidates arrived in.
    expect(first.records.map((r) => (r.kind === 'node' ? r.uri : `${r.from}->${r.to}`))).toEqual(
      second.records.map((r) => (r.kind === 'node' ? r.uri : `${r.from}->${r.to}`)),
    );
  });

  it('a shuffled-but-unscrambled construction (still sorted by list()) also agrees', async () => {
    const config = cfg();
    const shuffled = [FILES[2], FILES[0], FILES[4], FILES[1], FILES[3]].map((f) => ({
      kind: 'file' as const,
      ...f!,
    }));
    const ordered = FILES.map((f) => ({ kind: 'file' as const, ...f }));

    const { registry: r1 } = buildIndexAdapterRegistry(config);
    const { registry: r2 } = buildIndexAdapterRegistry(config);
    const first = await runIndexer(new FakeIndexSource(shuffled), config, target(), { adapters: r1 });
    const second = await runIndexer(new FakeIndexSource(ordered), config, target(), { adapters: r2 });

    expect(compareGenerations(first, second)).toEqual({ ok: true, mismatches: [] });
  });
});

describe('a source that actually violates the ascending-order contract is refused loudly, never silently corrected', () => {
  it('{ scrambled: true } makes the scan throw rather than produce a different canonical result', async () => {
    const config = cfg();
    const { registry } = buildIndexAdapterRegistry(config);
    const items = [...FILES].reverse().map((f) => ({ kind: 'file' as const, ...f }));
    const scrambled = new FakeIndexSource(items, {}, { scrambled: true });
    await expect(runIndexer(scrambled, config, target(), { adapters: registry })).rejects.toThrow();
  });
});
