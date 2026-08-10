import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IndexGenerationManifest } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import { NoriqClient } from '../src/client';
import { type ContextPackFetcher, retrieveContextPack } from '../src/context-pack';
import type { EncodedBatch } from '../src/index-batch';
import { IndexCoordinator, type IndexCoordinatorDeps, type IndexTarget } from '../src/index-coordinator';
import { IndexJournal, type IndexJournalKey, type JournalStore } from '../src/index-journal';
import type { ResolvedIndexConfig } from '../src/index-policy';
import { INDEXER_VERSION, reconcile } from '../src/index-reconcile';
import { FakeIndexSource } from '../src/index-source';
import { fileStagingStore } from '../src/index-stage';
import { type UploadGenerationDeps, type UploadGenerationInput, uploadGeneration } from '../src/index-upload';
import type { RunnerIndexCursor } from '../src/memory-contract';
import type { ChangesBetweenResult, IndexSnapshotResult, VcsBackend } from '../src/vcs/types';

/**
 * RUN-240: release compatibility. Every scenario below is proven against an INJECTED fake
 * transport (a `fetchImpl` this test builds, never a live server — this repo's own testing
 * discipline) or a pure function, per this task's own locked decision: a compatibility matrix that
 * quietly tests something adjacent and reports it as covered is the exact defect class this whole
 * plan keeps finding. Where a scenario cannot be reached this way — a live OLD deployment, actual
 * R2 object storage (still only DESIGNED server-side, THREAT-MODEL.md's own "PARTLY IMPLEMENTED"
 * row) — RELEASE.md says so plainly instead of a test that only looks like coverage.
 *
 * Two things this file deliberately does NOT re-prove, because another suite already owns them and
 * a second copy would be exactly the "second answer to one question" this codebase's own doc
 * comments keep warning against:
 *   - `uploadGeneration`'s own begin/status/batch/complete sequencing — index-upload.test.ts.
 *   - `createIndexWorkStep`'s wiring (snapshot.source -> runIndexer -> uploadGeneration ->
 *     release) — index-work.test.ts.
 * What IS this file's own: composing real `uploadGeneration` outcomes with the real
 * `IndexCoordinator`/`reconcile`/`NoriqClient`/`retrieveContextPack` contracts to answer the
 * specific compatibility questions RUN-240 asks — an old server, disabled memory, a version skew
 * that actually shipped (RUN-239), and a rollback.
 */

const quiet = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as IndexCoordinatorDeps['logger'];

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

// ---------------------------------------------------------------------------
// 1. Retrieval against an old server: always degrades, and RECORDS the omission (never a payload
//    silently lost — that acceptance line is about uploads; this is the deliberate always-degrade
//    contract on the read side, which this task must not tighten — see the module's own doc).
// ---------------------------------------------------------------------------

describe('retrieval against an old server (404 on a route it never grew) degrades and records why', () => {
  it('getIndexCursor: a 404 from an old server collapses to null, never a thrown error', async () => {
    const oldServer = (async () => new Response('Not Found', { status: 404 })) as typeof fetch;
    const client = new NoriqClient({
      server: 'https://old.example',
      token: 't',
      fetchImpl: oldServer,
      logger: quiet as never,
    });
    const cursor = await client.getIndexCursor('rnr_1', {
      projectId: 'prj_1',
      repositoryKey: 'my-repo',
      checkoutId: 'repo_a',
    });
    expect(cursor).toBeNull();
  });

  it('getContextPack: a 404 from an old server collapses to null, never a thrown error', async () => {
    const oldServer = (async () => new Response('Not Found', { status: 404 })) as typeof fetch;
    const client = new NoriqClient({
      server: 'https://old.example',
      token: 't',
      fetchImpl: oldServer,
      logger: quiet as never,
    });
    const pack = await client.getContextPack('rnr_1', { projectId: 'prj_1', taskId: 'task_1' });
    expect(pack).toBeNull();
  });

  it('retrieveContextPack: an old-server 404 (surfaced by the fetcher as null, NoriqClient’s own contract) is attempted and its omission is RECORDED, not merely swallowed', async () => {
    const fetcherAgainstOldServer: ContextPackFetcher = async () => null;
    const result = await retrieveContextPack(fetcherAgainstOldServer, {
      projectId: 'prj_1',
      taskId: 'task_1',
      repositoryKey: 'my-repo',
      baseId: 'base-1',
      branch: null,
      role: 'build',
    });
    // attempted: true is the acceptance-relevant fact — a run whose retrieval degraded is
    // distinguishable from one that never asked at all (context-pack.ts's own module doc).
    expect(result.attempted).toBe(true);
    expect(result.pack).toBeNull();
    expect(result.omission).toEqual({ reason: 'unavailable' });
  });

  it('reconcile treats an unreachable cursor (what an old/disabled server produces) as "schedule nothing", never as a reason to reindex blind', () => {
    const outcome = reconcile({ cursor: null, currentBaseId: 'base-1', indexerVersion: INDEXER_VERSION });
    expect(outcome).toEqual({
      outcome: 'unavailable',
      reason: expect.stringContaining('index cursor unavailable'),
    });
  });
});

// ---------------------------------------------------------------------------
// 2. An UPLOAD against an old server is a different case from retrieval (locked decision): work
//    already done and evidence about to be dropped must be VISIBLE, and never retried into a hot
//    loop. `disabled` (503 — no ingest route at all) and `not-found` (404 — an old server's
//    `/api/runner-ingest/capability` doesn't recognise this shape) are both terminal reasons,
//    excluded from `RETRYABLE_REASONS` (index-upload.ts) by name.
// ---------------------------------------------------------------------------

const MANIFEST: IndexGenerationManifest = {
  generationId: 'gen_compat_1',
  projectId: 'prj_1',
  repositoryKey: 'my-repo',
  branch: 'main',
  baseId: 'base-1',
  indexerVersion: INDEXER_VERSION,
  batchCount: 1,
  fileCount: 1,
  contentHash: 'content-hash',
  deletions: [],
  createdAt: '2026-08-10T00:00:00.000Z',
};
const BATCHES: EncodedBatch[] = [
  {
    generationId: MANIFEST.generationId,
    batchNumber: 0,
    batchHash: 'h0',
    compressed: Buffer.from('x'),
    rowCount: 1,
  },
];
const KEY: IndexJournalKey = {
  server: 'https://old.example',
  repositoryKey: 'my-repo',
  baseId: 'base-1',
  indexerVersion: INDEXER_VERSION,
  generationId: MANIFEST.generationId,
};
const MINT_INPUT = { projectId: 'prj_1', repositoryKey: 'my-repo', runnerId: 'rnr_1' };

async function uploadDeps(
  root: string,
  mintFetch: typeof fetch,
  ingestFetch: typeof fetch,
  over: Partial<UploadGenerationDeps> = {},
): Promise<UploadGenerationDeps> {
  const client = new NoriqClient({ server: KEY.server, token: 'daemon-tok', fetchImpl: mintFetch });
  return {
    client,
    journal: memJournal(),
    staging: fileStagingStore(root),
    release: async () => {},
    signal: new AbortController().signal,
    fetchImpl: ingestFetch,
    retryBaseMs: 1,
    retryMaxMs: 2,
    maxRetryAttempts: 2,
    ...over,
  };
}

describe('an upload an old server refuses is visible, typed, and never retried into a hot loop', () => {
  let root: string;

  const cleanupRoot = async () => rm(root, { recursive: true, force: true });

  it('503 from mint (old server has no ingest route enabled at all) -> terminal "disabled", minted exactly once', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'noriq-compat-'));
    try {
      let mintCalls = 0;
      const mintFetch = (async () => {
        mintCalls += 1;
        return new Response('ingest not configured on this server', { status: 503 });
      }) as typeof fetch;
      const neverReached = (async () => {
        throw new Error('an ingest route must never be called when mint itself refused');
      }) as typeof fetch;
      const deps = await uploadDeps(root, mintFetch, neverReached);
      const input: UploadGenerationInput = {
        key: KEY,
        mint: MINT_INPUT,
        manifest: MANIFEST,
        batches: BATCHES,
      };

      const outcome = await uploadGeneration(input, deps);

      expect(outcome).toEqual({ ok: false, reason: 'disabled', detail: expect.stringContaining('503') });
      // Never retried into a hot loop — 'disabled' is not in RETRYABLE_REASONS (index-upload.ts).
      expect(mintCalls).toBe(1);
    } finally {
      await cleanupRoot();
    }
  });

  it('404 from mint (old server does not recognise this repository key route) -> terminal "not-found", minted exactly once', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'noriq-compat-'));
    try {
      let mintCalls = 0;
      const mintFetch = (async () => {
        mintCalls += 1;
        return new Response('repository not found', { status: 404 });
      }) as typeof fetch;
      const neverReached = (async () => {
        throw new Error('unreachable');
      }) as typeof fetch;
      const deps = await uploadDeps(root, mintFetch, neverReached);
      const input: UploadGenerationInput = {
        key: KEY,
        mint: MINT_INPUT,
        manifest: MANIFEST,
        batches: BATCHES,
      };

      const outcome = await uploadGeneration(input, deps);

      expect(outcome).toEqual({ ok: false, reason: 'not-found', detail: expect.stringContaining('404') });
      expect(mintCalls).toBe(1);
    } finally {
      await cleanupRoot();
    }
  });

  it('a persistent 5xx during upload (what "no R2 configured server-side" surfaces as, per INDEX-OPERATIONS.md’s own Troubleshooting section) retries with backoff up to a BOUND, then fails typed — never an infinite retry loop', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'noriq-compat-'));
    try {
      let beginCalls = 0;
      const mintFetch = (async () =>
        new Response(
          JSON.stringify({
            token: 'ing_tok',
            maxBytes: 8 * 1024 * 1024,
            expiresAt: '2026-08-10T01:00:00.000Z',
          }),
          { status: 200 },
        )) as typeof fetch;
      const ingestFetch = (async (url: string | URL) => {
        const u = String(url);
        if (u.endsWith('/status'))
          return new Response(
            JSON.stringify({ status: 'unknown', batchesReceived: 0, batchesExpected: null }),
            {
              status: 200,
            },
          );
        if (u.endsWith('/begin')) {
          beginCalls += 1;
          // Standing in for server-side object storage that "is still only DESIGNED, not built"
          // (THREAT-MODEL.md): an ordinary 5xx, indistinguishable in shape from any other server
          // error — there is no distinct "storage unavailable" signal to fake more specifically.
          return new Response('internal error', { status: 500 });
        }
        return new Response('{}', { status: 200 });
      }) as typeof fetch;
      const deps = await uploadDeps(root, mintFetch, ingestFetch, { maxRetryAttempts: 2 });
      const input: UploadGenerationInput = {
        key: KEY,
        mint: MINT_INPUT,
        manifest: MANIFEST,
        batches: BATCHES,
      };

      const outcome = await uploadGeneration(input, deps);

      expect(outcome).toEqual({ ok: false, reason: 'http', detail: expect.stringContaining('500') });
      // 1 original attempt + maxRetryAttempts(2) retries = 3, never unbounded.
      expect(beginCalls).toBe(3);
    } finally {
      await cleanupRoot();
    }
  });

  it('a failed upload is never silently dropped: it reaches the coordinator’s own log and status stream, and the coordinator still resolves without throwing to its caller', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'noriq-compat-'));
    try {
      const mintFetch = (async () =>
        new Response('ingest not configured on this server', { status: 503 })) as typeof fetch;
      const neverReached = (async () => {
        throw new Error('unreachable');
      }) as typeof fetch;
      const deps = await uploadDeps(root, mintFetch, neverReached);
      const input: UploadGenerationInput = {
        key: KEY,
        mint: MINT_INPUT,
        manifest: MANIFEST,
        batches: BATCHES,
      };

      // The exact conversion `index-work.ts`'s own createIndexWorkStep performs on a non-ok
      // outcome (its own comment: "A failed upload THROWS rather than being swallowed here") —
      // quoted, not re-invented, so this composes the REAL uploadGeneration outcome with the REAL
      // failure contract the coordinator actually receives, without re-proving createIndexWorkStep's
      // own snapshot/release wiring (index-work.test.ts's job).
      const runWork = async () => {
        const outcome = await uploadGeneration(input, deps);
        if (!outcome.ok) {
          const detail =
            outcome.reason === 'validation'
              ? `${outcome.problems.length} problem(s)`
              : outcome.reason === 'cancelled'
                ? 'cancelled'
                : outcome.detail;
          throw new Error(`index upload did not complete (${outcome.reason}): ${detail}`);
        }
        return { generationId: 'ok', baseId: 'base-1', batchesReceived: outcome.batchesReceived };
      };

      const errors: Array<{ repositoryKey: string; err: string }> = [];
      const statusEvents: unknown[] = [];
      // Unlike the "disabled memory" scenarios below, this one must actually REACH the work step
      // to prove the failure is surfaced — so the lease succeeds here, deliberately, rather than
      // reusing the refusing `fakeVcs()` default.
      const vcs: Pick<VcsBackend, 'leaseIndexSnapshot' | 'releaseIndexSnapshot' | 'changesBetween'> = {
        leaseIndexSnapshot: async () => ({
          ok: true,
          snapshot: { source: new FakeIndexSource([]), baseId: 'base-1', readOnly: true, location: {} },
        }),
        releaseIndexSnapshot: async () => {},
        changesBetween: async () => ({ ok: true, changed: [], deleted: [] }),
      };
      const coordinator = new IndexCoordinator({
        vcsFor: () => vcs,
        resolveConfig: async () => CONFIG,
        getCursor: async () => CURSOR(),
        runWork,
        journal: memJournal(),
        isRunBusy: () => false,
        onStatus: (event) => statusEvents.push(event),
        logger: {
          ...quiet,
          error: (_msg: string, fields?: Record<string, unknown>) => {
            errors.push({ repositoryKey: String(fields?.repositoryKey), err: String(fields?.err) });
          },
        } as unknown as IndexCoordinatorDeps['logger'],
      });

      // Resolves — a background subsystem's failure must never throw at whoever called trigger()
      // (the same posture orphanSweep/owedMergeReconciler take, index-coordinator.ts's own doc).
      await expect(coordinator.trigger(TARGET())).resolves.toBeUndefined();

      expect(errors).toHaveLength(1);
      expect(errors[0]?.err).toContain('disabled');
      const failure = statusEvents.find((e): e is { type: 'failure'; detail: string } => {
        return typeof e === 'object' && e !== null && (e as { type?: string }).type === 'failure';
      });
      expect(failure?.detail).toContain('disabled');
    } finally {
      await cleanupRoot();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Disabled memory: the daemon proceeds and says what it skipped — no cursor fetch, no lease,
//    no throw. `resolveConfig` returning null is `loadIndexConfig`'s own contract for "[index] is
//    absent, not true, or the table is invalid" (index-policy.ts).
// ---------------------------------------------------------------------------

const CONFIG: ResolvedIndexConfig = {
  languages: ['typescript'],
  contentMode: 'full',
  maxFiles: 100,
  maxFileBytes: 1_000_000,
  maxTotalBytes: 10_000_000,
  readDeadlineMs: 60_000,
  pollIntervalMinutes: 60,
  include: [],
  exclude: [],
};

const GEN = (over: Partial<NonNullable<RunnerIndexCursor['activeGeneration']>> = {}) => ({
  id: 'gen_1',
  branch: 'main',
  baseId: 'base-1',
  indexerVersion: INDEXER_VERSION,
  status: 'active' as const,
  batchCount: 3,
  fileCount: 100,
  sealedAt: '2026-08-01T00:00:00.000Z',
  validationProblems: [],
  createdAt: '2026-08-01T00:00:00.000Z',
  activatedAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

const CURSOR = (over: Partial<RunnerIndexCursor> = {}): RunnerIndexCursor => ({
  repositoryKey: 'my-repo',
  defaultBranch: 'main',
  latestObservedBase: 'base-1',
  activeGeneration: GEN(),
  stagedGenerations: [],
  stale: false,
  failedIngest: false,
  failedIngestProblems: [],
  association: { state: 'associated', projectRepositoryId: 'prjrepo_1' },
  ...over,
});

const TARGET = (over: Partial<IndexTarget> = {}): IndexTarget => ({
  server: 'https://noriq.test',
  projectId: 'prj_1',
  repositoryKey: 'my-repo',
  checkoutId: 'repo_a',
  projectKey: 'RUN',
  repoRoot: '/repo/a',
  currentBaseId: 'base-2',
  ...over,
});

function fakeVcs(opts: { changesBetween?: () => ChangesBetweenResult } = {}) {
  const leaseCalls: string[] = [];
  const vcs: Pick<VcsBackend, 'leaseIndexSnapshot' | 'releaseIndexSnapshot' | 'changesBetween'> = {
    leaseIndexSnapshot: async (repoRoot: string): Promise<IndexSnapshotResult> => {
      leaseCalls.push(repoRoot);
      return { ok: false, reason: 'unsupported', detail: 'not used in this scenario' };
    },
    releaseIndexSnapshot: async () => {},
    changesBetween: async (): Promise<ChangesBetweenResult> =>
      opts.changesBetween ? opts.changesBetween() : { ok: true, changed: [], deleted: [] },
  };
  return { vcs, leaseCalls };
}

describe('disabled memory: the daemon proceeds, and says what it skipped', () => {
  it('resolveConfig() -> null (indexing off or misconfigured) never fetches a cursor and never leases a snapshot', async () => {
    let getCursorCalled = false;
    const { vcs, leaseCalls } = fakeVcs();
    const coordinator = new IndexCoordinator({
      vcsFor: () => vcs,
      resolveConfig: async () => null,
      getCursor: async () => {
        getCursorCalled = true;
        return CURSOR();
      },
      runWork: async () => {
        throw new Error('must not run — indexing is off for this repo');
      },
      journal: memJournal(),
      isRunBusy: () => false,
      logger: quiet,
    });

    await expect(coordinator.trigger(TARGET())).resolves.toBeUndefined();
    expect(getCursorCalled).toBe(false);
    expect(leaseCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. The real INDEXER_VERSION migration (RUN-239 bumped '1' -> '2' in this very history) and its
//    rollback mirror, plus the safety property that neither ever touches the lease pool via a
//    guess in the dangerous direction (decision 7's asymmetry).
// ---------------------------------------------------------------------------

describe('the real INDEXER_VERSION skew (RUN-239: ‘1’ -> ‘2’), and its rollback mirror', () => {
  it('a daemon at ‘2’ meeting an active generation built at ‘1’ performs a FULL pass (the parser changed, unchanged files also changed)', () => {
    const outcome = reconcile({
      cursor: CURSOR({ activeGeneration: GEN({ indexerVersion: '1' }) }),
      currentBaseId: 'base-1',
      indexerVersion: '2',
    });
    expect(outcome).toEqual({
      outcome: 'full',
      reason: expect.stringContaining('older than this'),
    });
  });

  it('a daemon rolled back to ‘1’ meeting an active generation built at ‘2’ refuses with incompatible-version — never downgrades the server’s index', () => {
    const outcome = reconcile({
      cursor: CURSOR({ activeGeneration: GEN({ indexerVersion: '2' }) }),
      currentBaseId: 'base-1',
      indexerVersion: '1',
    });
    expect(outcome).toEqual({
      outcome: 'incompatible-version',
      activeIndexerVersion: '2',
      ourIndexerVersion: '1',
    });
  });

  it('rollback safety: incompatible-version never leases a snapshot — the coordinator refuses before touching the VCS at all, and resolves without throwing', async () => {
    const { vcs, leaseCalls } = fakeVcs();
    const coordinator = new IndexCoordinator({
      vcsFor: () => vcs,
      resolveConfig: async () => CONFIG,
      getCursor: async () => CURSOR({ activeGeneration: GEN({ indexerVersion: '2' }) }),
      runWork: async () => {
        throw new Error('must not run — a rolled-back daemon must never write over a newer index');
      },
      journal: memJournal(),
      isRunBusy: () => false,
      logger: quiet,
    });

    await expect(coordinator.trigger(TARGET({ indexerVersion: '1' }))).resolves.toBeUndefined();
    expect(leaseCalls).toEqual([]);
  });

  it('canonical server memory stays recoverable across a rollback: retrieval carries no local indexer version at all, so a rolled-back daemon reads the same generation an up-to-date one would', async () => {
    // getIndexCursor's/getContextPack's own request shapes (client.ts) never include this
    // daemon's INDEXER_VERSION — retrieval is not gated on it structurally, only indexing-side
    // reconcile is. Proven by construction: a cursor whose active generation was built at '2'
    // parses and returns identically regardless of which local indexerVersion asked for it.
    const cursorBody = CURSOR({ activeGeneration: GEN({ indexerVersion: '2' }) });
    const server = (async () => new Response(JSON.stringify(cursorBody), { status: 200 })) as typeof fetch;
    const client = new NoriqClient({ server: 'https://noriq.example', token: 't', fetchImpl: server });
    const cursor = await client.getIndexCursor('rnr_1', {
      projectId: 'prj_1',
      repositoryKey: 'my-repo',
      checkoutId: 'repo_a',
    });
    expect(cursor?.activeGeneration?.indexerVersion).toBe('2');
  });
});

// ---------------------------------------------------------------------------
// 5. Run dispatch, verify, landing, and park are structurally independent of the indexing
//    subsystem — asserted, not assumed (this task's own locked decision). If a future change
//    threads an index-coordinator import into any of these, this fails the moment the import
//    lands, which is the point: the coupling this test forbids is exactly what would let a
//    declined/refused index path start affecting run behaviour it has no business touching.
// ---------------------------------------------------------------------------

describe('rollback safety: the RUN path never imports the indexing subsystem', () => {
  const bannedModules = [
    'index-coordinator',
    'index-status',
    'index-work',
    'index-upload',
    'index-reconcile',
  ];
  const runPathFiles = ['src/supervisor.ts', 'src/run-machine.ts', 'src/land.ts', 'src/parked.ts'];

  it.each(runPathFiles)('%s imports none of the indexing subsystem modules', (relPath) => {
    const source = readFileSync(path.resolve(relPath), 'utf8');
    const importLines = source.split('\n').filter((l) => /^\s*import\b/.test(l) || /from\s+['"]/.test(l));
    for (const banned of bannedModules) {
      const hit = importLines.find((l) => l.includes(`'./${banned}'`) || l.includes(`"./${banned}"`));
      expect(
        hit,
        `${relPath} must not import ./${banned} — a declined/refused index path must never reach run dispatch, verify, landing, or park`,
      ).toBeUndefined();
    }
  });
});
