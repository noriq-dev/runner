import { describe, expect, it } from 'vitest';
import { IndexAdapterRegistry, createDefaultAdapterRegistry } from '../src/index-adapters';
import type { AdapterParseResult } from '../src/index-adapters';
import { IndexInterrupted, computeContentHash } from '../src/index-batch';
import { INDEX_LANGUAGES } from '../src/index-policy';
import type { ResolvedIndexConfig } from '../src/index-policy';
import { buildIndexAdapterRegistry } from '../src/index-registry';
import { FakeIndexSource } from '../src/index-source';
import { runIndexer } from '../src/indexer';
import type { IndexRunTarget } from '../src/indexer';

/**
 * RUN-238's fast, DI-only proof of the yield/abort/busy-abandon/determinism properties
 * `bench/index-load.mts` proves at full scale on a real tree. Every fixture here is a handful of
 * `FakeIndexSource` files with `yieldEveryFiles`/`yieldEveryRecords` forced down to 1 — the
 * `EncodeBatchesOptions.maxUncompressedBytes` test-only-override convention, applied to the new
 * knob — so a checkpoint fires on every single item instead of needing thousands of fixture files
 * to reach one. No real SDK, network, or git — the CLAUDE.md testing strategy, unchanged by this
 * task.
 */

const cfg = (): ResolvedIndexConfig => ({
  languages: [...INDEX_LANGUAGES],
  contentMode: 'full',
  maxFiles: 10_000,
  maxFileBytes: 1_000_000,
  maxTotalBytes: 500_000_000,
  readDeadlineMs: 120_000,
  pollIntervalMinutes: 60,
  include: [],
  exclude: [],
});

const target = (): IndexRunTarget => ({
  projectId: 'proj_1',
  projectKey: 'RUN',
  repositoryKey: 'runner',
  branch: 'main',
  baseId: 'sha_1',
});

function fakeFiles(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    kind: 'file' as const,
    path: `src/f${i}.ts`,
    content: `export function f${i}() { return ${i}; }\n`,
  }));
}

/** A registry with ONE adapter that claims every path and calls `onParse(index)` before returning
 *  a trivial result — the hook a test uses to trigger an abort or flip a busy flag AT a specific
 *  point mid-pass, proving the checkpoint that follows actually observes it. */
function hookedAdapterRegistry(onParse: (index: number) => void): IndexAdapterRegistry {
  let count = 0;
  const registry = new IndexAdapterRegistry();
  registry.register({
    id: 'test-hook',
    version: '1',
    canParse: () => true,
    parse: async (): Promise<AdapterParseResult> => {
      const index = count++;
      onParse(index);
      return { symbols: [], diagnostics: [] };
    },
  });
  return registry;
}

describe('cooperative checkpoints yield via a real macrotask, never a microtask', () => {
  it('lets an independent timer tick during a pass forced to checkpoint on every item', async () => {
    // The measured defect (RUN-238) IS a microtask loop: `await adapter.parse(...)` refills the
    // microtask queue every iteration and never lets a timer fire. If `cooperativeCheckpoint` were
    // built the same way, this timer would never tick even once before `runIndexer` resolves —
    // exactly the failure mode this test exists to catch.
    const source = new FakeIndexSource(fakeFiles(60));
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 1);
    try {
      await runIndexer(source, cfg(), target(), {
        adapters: createDefaultAdapterRegistry(),
        yieldEveryFiles: 1,
        yieldEveryRecords: 1,
      });
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
  });
});

describe('an AbortSignal reaches the parse loop (RUN-238 — before this, runIndexer took no signal at all)', () => {
  it('an already-aborted signal stops the pass before the candidate loop starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const source = new FakeIndexSource(fakeFiles(5));
    let parseCount = 0;
    const registry = hookedAdapterRegistry(() => {
      parseCount++;
    });

    let caught: unknown;
    try {
      await runIndexer(source, cfg(), target(), { adapters: registry, signal: controller.signal });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(IndexInterrupted);
    expect((caught as IndexInterrupted).reason).toBe('aborted');
    expect(parseCount).toBe(0); // never reached the candidate loop at all.
  });

  it('a signal aborted DURING parsing stops the pass mid-way — never every candidate, never a manifest', async () => {
    const controller = new AbortController();
    const source = new FakeIndexSource(fakeFiles(6));
    // Abort while the 3rd file (index 2) is "being parsed" — the checkpoint at the top of the
    // NEXT loop iteration (yieldEveryFiles: 1) must observe it before file index 3 is touched.
    const registry = hookedAdapterRegistry((index) => {
      if (index === 2) controller.abort();
    });

    let caught: unknown;
    let result: unknown;
    try {
      result = await runIndexer(source, cfg(), target(), {
        adapters: registry,
        signal: controller.signal,
        yieldEveryFiles: 1,
      });
    } catch (err) {
      caught = err;
    }

    expect(result).toBeUndefined(); // no `IndexerResult` — no manifest, no generation, no batches.
    expect(caught).toBeInstanceOf(IndexInterrupted);
    expect((caught as IndexInterrupted).reason).toBe('aborted');
  });
});

describe('isRunBusy() is re-checked mid-parse (RUN-238 — before this it was consulted once, before leasing)', () => {
  it('a busy daemon abandons an in-progress pass rather than pausing it', async () => {
    let busy = false;
    const source = new FakeIndexSource(fakeFiles(6));
    const registry = hookedAdapterRegistry((index) => {
      if (index === 2) busy = true; // flips busy right after the 3rd file "parses".
    });

    let caught: unknown;
    try {
      await runIndexer(source, cfg(), target(), {
        adapters: registry,
        isRunBusy: () => busy,
        yieldEveryFiles: 1,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(IndexInterrupted);
    expect((caught as IndexInterrupted).reason).toBe('busy');
  });

  it('a daemon that never becomes busy runs the pass to completion normally', async () => {
    const source = new FakeIndexSource(fakeFiles(4));
    const { registry } = buildIndexAdapterRegistry(cfg());
    const result = await runIndexer(source, cfg(), target(), {
      adapters: registry,
      isRunBusy: () => false,
      yieldEveryFiles: 1,
    });
    expect(result.manifest.fileCount).toBe(4);
  });
});

describe('yielding does not change contentHash (RUN-238 locked decision: a yield must never reorder)', () => {
  it('runIndexer checkpointing on every file/record produces the identical contentHash as one that never chunks', async () => {
    const files = fakeFiles(40);
    const { registry: r1 } = buildIndexAdapterRegistry(cfg());
    const { registry: r2 } = buildIndexAdapterRegistry(cfg());

    const chunked = await runIndexer(new FakeIndexSource(files), cfg(), target(), {
      adapters: r1,
      yieldEveryFiles: 1,
      yieldEveryRecords: 1,
    });
    const unchunked = await runIndexer(new FakeIndexSource(files), cfg(), target(), {
      adapters: r2,
      yieldEveryFiles: 1_000_000,
      yieldEveryRecords: 1_000_000,
    });

    expect(chunked.manifest.contentHash).toBe(unchunked.manifest.contentHash);
    expect(chunked.batches.map((b) => b.batchHash)).toEqual(unchunked.batches.map((b) => b.batchHash));
    // Record ORDER itself, not just the hash — a yield that reordered anything would likely still
    // collide on the hash by coincidence far less often than it would on this direct comparison.
    const uris = (r: (typeof chunked)['records'][number]) =>
      r.kind === 'node' ? r.uri : `${r.from}->${r.to}`;
    expect(chunked.records.map(uris)).toEqual(unchunked.records.map(uris));
  });

  it('computeContentHash alone: every yieldEveryRecords cadence from 1 up to "never" agrees', async () => {
    const { registry } = buildIndexAdapterRegistry(cfg());
    const result = await runIndexer(new FakeIndexSource(fakeFiles(25)), cfg(), target(), {
      adapters: registry,
    });
    const hashes = await Promise.all(
      [1, 2, 7, 1_000_000].map((yieldEveryRecords) =>
        computeContentHash(result.records, { yieldEveryRecords }),
      ),
    );
    for (const h of hashes) expect(h).toBe(hashes[0]);
  });
});
