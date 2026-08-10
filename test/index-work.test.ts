import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoriqClient } from '../src/client';
import type { IndexTarget, IndexWorkContext, IndexWorkOutcome } from '../src/index-coordinator';
import { IndexJournal, type JournalStore } from '../src/index-journal';
import { INDEX_LANGUAGES } from '../src/index-policy';
import type { ResolvedIndexConfig } from '../src/index-policy';
import { FakeIndexSource } from '../src/index-source';
import { fileStagingStore } from '../src/index-stage';
import { createIndexWorkStep } from '../src/index-work';
import type { IndexSnapshot, VcsBackend } from '../src/vcs/types';

// RUN-222 locked decision 5: the real work step is WIRE-ONLY — snapshot.source -> runIndexer ->
// uploadGeneration. These tests prove the WIRING; runIndexer's own scan/parse behaviour is
// indexer.test.ts's job, and uploadGeneration's own begin/status/batch/complete sequencing and
// release-before-network-call ordering is index-upload.test.ts's — re-proving either here would
// be exactly the second copy locked decision 5 forbids. What is provably THIS file's own: does
// `release` really reach the injected VcsBackend, and does the step read `snapshot.source` alone
// for a snapshot with NO `localPath` key at all (not merely `localPath: undefined` — the
// Perforce/Diversion shape, never git's).

const CONFIG: ResolvedIndexConfig = {
  languages: [...INDEX_LANGUAGES],
  contentMode: 'full',
  maxFiles: 10_000,
  maxFileBytes: 1_000_000,
  maxTotalBytes: 500_000_000,
  readDeadlineMs: 120_000,
  pollIntervalMinutes: 60,
  include: [],
  exclude: [],
};

const TARGET: IndexTarget = {
  server: 'https://noriq.example',
  projectId: 'prj_1',
  repositoryKey: 'my-repo',
  checkoutId: 'repo_a',
  projectKey: 'RUN',
  repoRoot: '/repo/a',
  currentBaseId: 'base-2',
};

const OUTCOME: IndexWorkOutcome = { outcome: 'full', reason: 'no active generation' };

const quiet = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Parameters<
  typeof createIndexWorkStep
>[0]['logger'];

/** A snapshot with NO `localPath` key at all (locked decision 6's own acceptance wording) — the
 *  Perforce/Diversion shape, never git's. */
function depotShapedSnapshot(): IndexSnapshot {
  return {
    source: new FakeIndexSource([{ kind: 'file', path: 'src/add.ts', content: 'function add() {}\n' }]),
    baseId: 'base-2',
    readOnly: true,
    location: { kind: 'perforce-index-snapshot' },
  };
}

const GRANT = { token: 'ing_tok', maxBytes: 8 * 1024 * 1024, expiresAt: '2026-08-08T00:15:00.000Z' };

/** The same two-transport split index-upload.test.ts's own router uses (mint vs. token-in-path
 *  ingest) — narrowed to what these tests need, plus an order-recording hook. */
function router(
  opts: { onCall?: (label: string) => void; validationOk?: boolean; validationProblems?: string[] } = {},
) {
  const mintFetch = (async () => {
    opts.onCall?.('mint');
    return new Response(JSON.stringify(GRANT), { status: 200 });
  }) as typeof fetch;
  const ingestFetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith('/status')) {
      opts.onCall?.('status');
      return new Response(JSON.stringify({ status: 'unknown', batchesReceived: 0, batchesExpected: null }), {
        status: 200,
      });
    }
    if (u.endsWith('/begin')) {
      opts.onCall?.('begin');
      return new Response('{}', { status: 200 });
    }
    if (u.endsWith('/complete')) {
      opts.onCall?.('complete');
      const ok = opts.validationOk ?? true;
      return new Response(
        JSON.stringify({
          ok,
          batchesReceived: 1,
          validation: { ok, problems: ok ? [] : (opts.validationProblems ?? ['bad content hash']) },
        }),
        { status: 200 },
      );
    }
    if (/\/batch\/\d+/.test(u)) {
      opts.onCall?.('batch');
      return new Response(JSON.stringify({ ok: true, deduped: false }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { mintFetch, ingestFetch };
}

function memJournal(): IndexJournal {
  const store: JournalStore = (() => {
    const s = { file: {} as Record<string, unknown> };
    return {
      read: async () => structuredClone(s.file) as never,
      write: async (f) => {
        s.file = structuredClone(f) as never;
      },
    };
  })();
  return new IndexJournal(store);
}

describe('createIndexWorkStep (RUN-222)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'noriq-index-work-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads snapshot.source (never localPath), indexes it for real, uploads, and releases — order proves release precedes the first network call', async () => {
    const order: string[] = [];
    const { mintFetch, ingestFetch } = router({ onCall: (l) => order.push(l) });
    const client = new NoriqClient({ server: TARGET.server, token: 'daemon-tok', fetchImpl: mintFetch });
    const releaseCalls: IndexSnapshot[] = [];
    const vcs: Pick<VcsBackend, 'releaseIndexSnapshot'> = {
      releaseIndexSnapshot: async (snapshot) => {
        releaseCalls.push(snapshot);
        order.push('release');
      },
    };
    const step = createIndexWorkStep({
      client,
      runnerId: 'rnr_1',
      vcsFor: () => vcs,
      staging: fileStagingStore(root),
      fetchImpl: ingestFetch,
      logger: quiet,
    });

    const snapshot = depotShapedSnapshot();
    expect('localPath' in snapshot).toBe(false); // the exact shape locked decision 6 names
    const ctx: IndexWorkContext = {
      target: TARGET,
      snapshot,
      outcome: OUTCOME,
      config: CONFIG,
      journal: memJournal(),
      signal: new AbortController().signal,
    };

    await step(ctx); // must not throw — a thrown error would mean the upload never validated

    expect(releaseCalls).toEqual([snapshot]); // release reached the injected VcsBackend
    // Release, THEN the network — the early-release path (locked decision 7) driven end to end
    // through this file's own wiring, not merely asserted inside index-upload.test.ts.
    expect(order[0]).toBe('release');
    expect(order.slice(1)).toEqual(['mint', 'status', 'begin', 'batch', 'complete']);
  });

  it('a failed upload (server rejects validation) THROWS — never swallowed here', async () => {
    const { mintFetch, ingestFetch } = router({ validationOk: false });
    const client = new NoriqClient({ server: TARGET.server, token: 'daemon-tok', fetchImpl: mintFetch });
    const step = createIndexWorkStep({
      client,
      runnerId: 'rnr_1',
      vcsFor: () => ({ releaseIndexSnapshot: async () => {} }),
      staging: fileStagingStore(root),
      fetchImpl: ingestFetch,
      logger: quiet,
    });
    const ctx: IndexWorkContext = {
      target: TARGET,
      snapshot: depotShapedSnapshot(),
      outcome: OUTCOME,
      config: CONFIG,
      journal: memJournal(),
      signal: new AbortController().signal,
    };
    await expect(step(ctx)).rejects.toThrow(/validation/);
  });

  it('refuses (throws before any scan or network) when the target carries no resolved projectId', async () => {
    const { mintFetch, ingestFetch } = router({});
    const client = new NoriqClient({ server: TARGET.server, token: 'daemon-tok', fetchImpl: mintFetch });
    let scanned = false;
    const step = createIndexWorkStep({
      client,
      runnerId: 'rnr_1',
      vcsFor: () => ({ releaseIndexSnapshot: async () => {} }),
      staging: fileStagingStore(root),
      fetchImpl: async (...args) => {
        scanned = true;
        return ingestFetch(...args);
      },
      logger: quiet,
    });
    const ctx: IndexWorkContext = {
      target: { ...TARGET, projectId: null },
      snapshot: depotShapedSnapshot(),
      outcome: OUTCOME,
      config: CONFIG,
      journal: memJournal(),
      signal: new AbortController().signal,
    };
    await expect(step(ctx)).rejects.toThrow(/projectId/);
    expect(scanned).toBe(false);
  });

  it('a git-shaped snapshot (localPath present, detached, no branch) still uploads under a "default" branch label', async () => {
    const { mintFetch, ingestFetch } = router({});
    const client = new NoriqClient({ server: TARGET.server, token: 'daemon-tok', fetchImpl: mintFetch });
    const step = createIndexWorkStep({
      client,
      runnerId: 'rnr_1',
      vcsFor: () => ({ releaseIndexSnapshot: async () => {} }),
      staging: fileStagingStore(root),
      fetchImpl: ingestFetch,
      logger: quiet,
    });
    const snapshot: IndexSnapshot = {
      source: new FakeIndexSource([{ kind: 'file', path: 'a.ts', content: 'const a = 1;\n' }]),
      localPath: '/wt/repo-index-snapshot-abc',
      baseId: 'gitsha',
      readOnly: true,
      location: { repoRoot: '/repo/a', kind: 'index-snapshot' },
    };
    const ctx: IndexWorkContext = {
      target: TARGET,
      snapshot,
      outcome: OUTCOME,
      config: CONFIG,
      journal: memJournal(),
      signal: new AbortController().signal,
    };
    // RUN-223: a successful attempt now reports back what it uploaded (`IndexWorkResult`) — the
    // coordinator's own status recorder needs it, and this is the wiring-only test that proves
    // the work step's return value is real rather than the coordinator inventing one.
    await expect(step(ctx)).resolves.toMatchObject({
      baseId: 'gitsha',
      batchesReceived: 1,
      generationId: expect.any(String),
    });
  });

  // RUN-234: before this, everything `runIndexer` computed about the scan/parse pass
  // (diagnostics, skipped-file counts, whether the walk stopped early) was dropped on the floor
  // here — the sole way to see any of it was `index-repo` run locally. This is the ONE bounded
  // summary line that now reports it from the background job itself.
  it('logs a bounded parse/file-outcome summary — counts only, never a path', async () => {
    const { mintFetch, ingestFetch } = router({});
    const client = new NoriqClient({ server: TARGET.server, token: 'daemon-tok', fetchImpl: mintFetch });
    const lines: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
    const logger = {
      debug() {},
      warn: (msg: string, fields?: Record<string, unknown>) => lines.push({ level: 'warn', msg, fields }),
      info: (msg: string, fields?: Record<string, unknown>) => lines.push({ level: 'info', msg, fields }),
      error() {},
    } as unknown as Parameters<typeof createIndexWorkStep>[0]['logger'];
    const step = createIndexWorkStep({
      client,
      runnerId: 'rnr_1',
      vcsFor: () => ({ releaseIndexSnapshot: async () => {} }),
      staging: fileStagingStore(root),
      fetchImpl: ingestFetch,
      logger,
    });
    const ctx: IndexWorkContext = {
      target: TARGET,
      snapshot: depotShapedSnapshot(),
      outcome: OUTCOME,
      config: CONFIG,
      journal: memJournal(),
      signal: new AbortController().signal,
    };

    await step(ctx);

    const line = lines.find((l) => l.msg === 'index parse complete');
    expect(line).toBeDefined();
    expect(line?.level).toBe('info'); // nothing noteworthy on this clean, one-file pass
    expect(line?.fields).toMatchObject({
      repositoryKey: 'my-repo',
      files: 1,
      diagnostics: 0,
      diagnosticErrors: 0,
      diagnosticsOverflow: 0,
      skipped: 0,
      skippedOverflow: 0,
      stoppedEarly: false,
    });
    // Never a path or a message string — only counts and a closed-vocabulary breakdown.
    expect(JSON.stringify(line?.fields)).not.toContain('src/add.ts');
  });

  it('a validation rejection with many problems throws a bounded message — never the raw joined array', async () => {
    const manyProblems = Array.from({ length: 20 }, (_, i) => `entity ${i}: field invalid`.repeat(10));
    const { mintFetch, ingestFetch } = router({ validationOk: false, validationProblems: manyProblems });
    const client = new NoriqClient({ server: TARGET.server, token: 'daemon-tok', fetchImpl: mintFetch });
    const step = createIndexWorkStep({
      client,
      runnerId: 'rnr_1',
      vcsFor: () => ({ releaseIndexSnapshot: async () => {} }),
      staging: fileStagingStore(root),
      fetchImpl: ingestFetch,
      logger: quiet,
    });
    const ctx: IndexWorkContext = {
      target: TARGET,
      snapshot: depotShapedSnapshot(),
      outcome: OUTCOME,
      config: CONFIG,
      journal: memJournal(),
      signal: new AbortController().signal,
    };

    let thrown: Error | undefined;
    try {
      await step(ctx);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown?.message).toContain('20 problem(s)');
    // The full 20-entry, 250-char-each array must never land in the thrown message verbatim —
    // that message is what `index-coordinator.ts`'s catch-all logs and persists into
    // `IndexStatusRecord.lastError` (RUN-234, one hop downstream of where the array is thrown away).
    expect(thrown?.message.length).toBeLessThan(2000);
  });
});
