import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoriqClient } from '../src/client';
import { IndexCoordinator, type IndexTarget } from '../src/index-coordinator';
import { IndexJournal, type JournalStore } from '../src/index-journal';
import type { ResolvedIndexConfig } from '../src/index-policy';
import { FakeIndexSource } from '../src/index-source';
import { fileStagingStore } from '../src/index-stage';
import { createIndexWorkStep } from '../src/index-work';
import type { logger as defaultLogger } from '../src/logger';
import type { RunnerIndexCursor } from '../src/memory-contract';
import type { ChangesBetweenResult, IndexSnapshot, IndexSnapshotResult, VcsBackend } from '../src/vcs/types';

/**
 * RUN-223 acceptance: "manual retry twice produces ONE generation — same generationId, second
 * attempt's batches deduped." This is deliberately NOT a re-proof of `uploadGeneration`'s own
 * resume/dedup logic (index-upload.test.ts already owns that) — it proves the thing RUN-223 adds:
 * calling `IndexCoordinator.trigger` twice for an unchanged repo (exactly what `index-reindex`
 * calling `requestManualReindex` twice does, through `index-control.ts`'s `/reindex`/`/retry`
 * routes) converges rather than duplicates, end to end through the REAL work step — never a fake
 * standing in for the very machinery locked decision 7 says this reuses.
 */

const quiet = { info() {}, warn() {}, error() {}, debug() {} } as unknown as typeof defaultLogger;

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

const TARGET: IndexTarget = {
  server: 'https://noriq.example',
  projectId: 'prj_1',
  repositoryKey: 'my-repo',
  checkoutId: 'repo_a',
  projectKey: 'RUN',
  repoRoot: '/repo/a',
  currentBaseId: 'base-1',
};

// No active generation on the server, on EITHER call — an ordinary `full` reconcile both times,
// which is exactly what a repo the server has never indexed looks like from here. The point under
// test is what happens ONE LAYER DOWN, at the upload itself: identical content plus an identical
// identity 5-tuple derives the identical `generationId` (RUN-215's own determinism), and the
// SECOND attempt's `status()` call finds the server already holds it.
const CURSOR: RunnerIndexCursor = {
  repositoryKey: 'my-repo',
  defaultBranch: 'main',
  latestObservedBase: null,
  activeGeneration: null,
  stagedGenerations: [],
  stale: false,
  failedIngest: false,
  failedIngestProblems: [],
  association: { state: 'associated', projectRepositoryId: 'prjrepo_1' },
};

const GRANT = { token: 'ing_tok', maxBytes: 8 * 1024 * 1024, expiresAt: '2026-08-09T00:15:00.000Z' };

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

/** A stateful ingest fake that actually REMEMBERS what it received across two independent
 *  `IndexCoordinator.trigger` calls — a real server would, and the whole acceptance is about what
 *  a SECOND attempt finds when it asks. */
function statefulIngest() {
  const received = new Set<number>();
  let complete = false;
  const calls = { begin: 0, batch: 0, complete: 0, status: 0 };
  const mintFetch = (async () => new Response(JSON.stringify(GRANT), { status: 200 })) as typeof fetch;
  const ingestFetch = (async (input: Parameters<typeof fetch>[0]) => {
    const u = String(input);
    if (u.endsWith('/status')) {
      calls.status += 1;
      return new Response(
        JSON.stringify({
          status: complete ? 'complete' : received.size > 0 ? 'in_progress' : 'unknown',
          batchesReceived: received.size,
          batchesExpected: null,
        }),
        { status: 200 },
      );
    }
    if (u.endsWith('/begin')) {
      calls.begin += 1;
      return new Response('{}', { status: 200 });
    }
    if (u.endsWith('/complete')) {
      calls.complete += 1;
      complete = true;
      return new Response(
        JSON.stringify({
          ok: true,
          batchesReceived: received.size,
          validation: { ok: true, problems: [] },
        }),
        { status: 200 },
      );
    }
    const m = u.match(/\/batch\/(\d+)/);
    if (m?.[1]) {
      calls.batch += 1;
      received.add(Number(m[1]));
      return new Response(JSON.stringify({ ok: true, deduped: false }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { mintFetch, ingestFetch, calls };
}

describe('manual retry is idempotent (RUN-223)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'noriq-manual-retry-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('two triggers for an unchanged repo produce ONE generationId, and the second sends no batches', async () => {
    const ingest = statefulIngest();
    const client = new NoriqClient({
      server: TARGET.server,
      token: 'daemon-tok',
      fetchImpl: ingest.mintFetch,
    });
    const journal = memJournal();

    const snapshotFor = (): IndexSnapshot => ({
      source: new FakeIndexSource([{ kind: 'file', path: 'src/add.ts', content: 'function add() {}\n' }]),
      baseId: 'base-1',
      readOnly: true,
      location: { kind: 'perforce-index-snapshot' },
    });
    const releaseCalls: IndexSnapshot[] = [];
    const vcs: Pick<VcsBackend, 'leaseIndexSnapshot' | 'releaseIndexSnapshot' | 'changesBetween'> = {
      leaseIndexSnapshot: async (): Promise<IndexSnapshotResult> => ({ ok: true, snapshot: snapshotFor() }),
      releaseIndexSnapshot: async (snapshot) => {
        releaseCalls.push(snapshot);
      },
      changesBetween: async (): Promise<ChangesBetweenResult> => ({ ok: true, changed: [], deleted: [] }),
    };

    const generationIds: (string | undefined)[] = [];
    const coordinator = new IndexCoordinator({
      vcsFor: () => vcs,
      resolveConfig: async () => CONFIG,
      getCursor: async () => CURSOR,
      runWork: createIndexWorkStep({
        client,
        runnerId: 'rnr_1',
        vcsFor: () => vcs,
        staging: fileStagingStore(root),
        fetchImpl: ingest.ingestFetch,
        logger: quiet,
      }),
      journal,
      isRunBusy: () => false,
      onStatus: (event) => {
        if (event.type === 'success') generationIds.push(event.generationId);
      },
      logger: quiet,
    });

    // First manual request — an ordinary `full` index, uploads for real.
    await coordinator.trigger(TARGET);
    expect(ingest.calls).toEqual({ begin: 1, batch: 1, complete: 1, status: 1 });

    // Second manual request — exactly what `index-reindex`/`index-retry` calling
    // `requestManualReindex` a second time does. Content is unchanged, so `deriveGenerationId`
    // (a pure function of the five identity fields) computes the SAME id, and this attempt's
    // `status()` call finds the server already reports `complete` — resuming into "nothing to
    // send", never a second begin/batch/complete round.
    await coordinator.trigger(TARGET);
    expect(ingest.calls).toEqual({ begin: 1, batch: 1, complete: 1, status: 2 });

    expect(generationIds).toHaveLength(2);
    expect(generationIds[0]).toBeTruthy();
    expect(generationIds[0]).toBe(generationIds[1]); // ONE generation, not two

    // The snapshot lease was released on every exit path both times (`uploadGeneration`'s own
    // early release, plus the coordinator's unconditional `finally` — release is documented
    // idempotent, so the double call is expected, not a bug) — a converged retry still returns
    // its lease exactly like an ordinary one does.
    expect(releaseCalls).toHaveLength(4);
  });
});
