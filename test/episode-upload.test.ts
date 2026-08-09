import type { EffortEpisode as EffortEpisodeType } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import { NoriqClient } from '../src/client';
import { deriveEpisodeScopeId } from '../src/episode';
import {
  EpisodePendingStore,
  type PendingEpisode,
  type PendingEpisodeFileStore,
} from '../src/episode-pending';
import {
  type EpisodeDeliveryDeps,
  type UploadEpisodeDeps,
  type UploadEpisodeInput,
  deliverEpisode,
  drainPendingEpisodes,
  uploadEpisode,
} from '../src/episode-upload';

// RUN-227: episode delivery over the existing signed ingest protocol. Fakes are built at the FETCH
// layer — never by mocking `IngestUpload` — the same discipline `index-upload.test.ts` already
// establishes for exactly this reason (this plan's own warning that a fake politer than the real
// server is how a batching task ships broken). The `complete` handler's default response mirrors
// `ProjectMemory.completeEpisodeIngest`'s REAL shape (`recorded`/`skipped`), which is the whole
// point of this task's own most dangerous locked decision.

const GRANT = { token: 'ing_tok_epi', maxBytes: 8 * 1024 * 1024, expiresAt: '2026-08-09T00:15:00.000Z' };

const MINT_INPUT = { projectId: 'prj_1', repositoryKey: 'myrepo', runnerId: 'rnr_1' };

function episode(over: Partial<EffortEpisodeType> = {}): EffortEpisodeType {
  return {
    id: 'epi_1',
    projectId: 'prj_1',
    runId: 'run_1',
    taskId: null,
    repositoryKey: 'myrepo',
    baseId: null,
    timeline: [],
    filesTouched: [],
    commands: [],
    testsRun: [],
    failures: [],
    findings: [],
    reviewRounds: 0,
    tokenUsage: {},
    costUSD: 0,
    acceptanceCoverage: null,
    steeringEvents: [],
    landingOutcome: 'pending',
    remainingWork: [],
    selfSummary: null,
    createdAt: '2026-08-08T00:00:00.000Z',
    ...over,
  };
}

/** A router over the two DISTINCT transports a real upload uses — `index-upload.test.ts`'s own
 *  split, reused rather than re-invented. */
function router(handlers: {
  mint?: () => Response;
  begin?: () => Response;
  batch?: (n: number) => Response;
  complete?: () => Response;
}) {
  const calls: { url: string; method: string }[] = [];
  const mintFetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    return (handlers.mint ?? (() => new Response(JSON.stringify(GRANT), { status: 200 })))();
  }) as typeof fetch;
  const ingestFetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? 'GET' });
    if (u.endsWith('/begin')) return (handlers.begin ?? (() => new Response('{}', { status: 200 })))();
    if (u.endsWith('/complete')) {
      return (
        handlers.complete ??
        (() =>
          new Response(
            JSON.stringify({ ok: true, batchesReceived: 1, rowCount: 1, recorded: 1, skipped: 0 }),
            { status: 200 },
          ))
      )();
    }
    const m = /\/batch\/(\d+)/.exec(u);
    if (m?.[1] !== undefined) {
      const n = Number(m[1]);
      return (
        handlers.batch ?? (() => new Response(JSON.stringify({ ok: true, deduped: false }), { status: 200 }))
      )(n);
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { mintFetch, ingestFetch, calls };
}

function makeDeps(
  over: Partial<UploadEpisodeDeps> = {},
  fetches?: { mintFetch: typeof fetch; ingestFetch: typeof fetch },
): UploadEpisodeDeps {
  const { mintFetch, ingestFetch } = fetches ?? router({});
  const client = new NoriqClient({
    server: 'https://noriq.example',
    token: 'daemon-tok',
    fetchImpl: mintFetch,
  });
  return {
    client,
    signal: new AbortController().signal,
    fetchImpl: ingestFetch,
    retryBaseMs: 1,
    retryMaxMs: 2,
    maxRetryAttempts: 2,
    ...over,
  };
}

describe('uploadEpisode (RUN-227)', () => {
  it('happy path: begin -> putBatch(0) -> complete, recorded 1', async () => {
    const { mintFetch, ingestFetch, calls } = router({});
    const deps = makeDeps({}, { mintFetch, ingestFetch });
    const input: UploadEpisodeInput = { scopeId: 'epi_scope_1', mint: MINT_INPUT, episode: episode() };

    const result = await uploadEpisode(input, deps);

    expect(result).toEqual({ ok: true });
    expect(calls.some((c) => c.url.endsWith('/begin'))).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/batch/0'))).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/complete'))).toBe(true);
  });

  it('the skipped-row trap: HTTP 200 with recorded:0 is a FAILURE to record, never a delivered episode', async () => {
    const { mintFetch, ingestFetch } = router({
      complete: () =>
        new Response(JSON.stringify({ ok: true, batchesReceived: 1, rowCount: 1, recorded: 0, skipped: 1 }), {
          status: 200,
        }),
    });
    const deps = makeDeps({}, { mintFetch, ingestFetch });
    const input: UploadEpisodeInput = { scopeId: 'epi_scope_1', mint: MINT_INPUT, episode: episode() };

    const result = await uploadEpisode(input, deps);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: 'skipped-server-side' });
  });

  it('a begin refused because the scope is already complete resolves as delivered (locked decision 3)', async () => {
    const { mintFetch, ingestFetch, calls } = router({
      begin: () =>
        new Response(
          JSON.stringify({
            error: 'episode upload epi_scope_1 already complete — this purpose cannot be reopened',
          }),
          { status: 409 },
        ),
    });
    const deps = makeDeps({}, { mintFetch, ingestFetch });
    const input: UploadEpisodeInput = { scopeId: 'epi_scope_1', mint: MINT_INPUT, episode: episode() };

    const result = await uploadEpisode(input, deps);

    expect(result).toEqual({ ok: true });
    // Resolved WITHOUT ever reaching batch/complete — the scope is already done.
    expect(calls.some((c) => c.url.endsWith('/batch/0'))).toBe(false);
  });

  it('a begin refused for a DIFFERENT reason (e.g. already aborted) is NOT treated as delivered', async () => {
    const { mintFetch, ingestFetch } = router({
      begin: () =>
        new Response(
          JSON.stringify({
            error: 'episode upload epi_scope_1 already aborted — this purpose cannot be reopened',
          }),
          { status: 409 },
        ),
    });
    const deps = makeDeps({}, { mintFetch, ingestFetch });
    const input: UploadEpisodeInput = { scopeId: 'epi_scope_1', mint: MINT_INPUT, episode: episode() };

    const result = await uploadEpisode(input, deps);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: 'conflict' });
  });

  it('idempotent retry: uploading the same sitting twice converges on the same scopeId and both calls succeed', async () => {
    const seenScopes = new Set<string>();
    const { mintFetch, ingestFetch } = router({
      begin: () => new Response('{}', { status: 200 }),
    });
    const trackingIngest = (async (url: string | URL, init?: RequestInit) => {
      seenScopes.add(String(url).split('/api/memory-ingest/')[1]?.split('/')[0] ?? '');
      return ingestFetch(url, init);
    }) as typeof fetch;
    const ep = episode();
    const scopeId = deriveEpisodeScopeId({ runId: ep.runId, terminalAt: ep.createdAt });
    const input: UploadEpisodeInput = { scopeId, mint: MINT_INPUT, episode: ep };
    const deps1 = makeDeps({}, { mintFetch, ingestFetch: trackingIngest });
    const deps2 = makeDeps({}, { mintFetch, ingestFetch: trackingIngest });

    const first = await uploadEpisode(input, deps1);
    const second = await uploadEpisode(input, deps2);

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    // Both attempts minted a capability for the identical scopeId — never two different ones.
    expect(seenScopes.size).toBe(1);
  });

  it('two SITTINGS of the same run id derive two distinct scopeIds', () => {
    const a = deriveEpisodeScopeId({ runId: 'run_1', terminalAt: '2026-08-08T00:00:00.000Z' });
    const b = deriveEpisodeScopeId({ runId: 'run_1', terminalAt: '2026-08-08T01:00:00.000Z' });
    expect(a).not.toBe(b);
  });

  it('a network transport failure is a retryable outcome, never a throw', async () => {
    const failingFetch = (async () => {
      throw new Error('ECONNRESET');
    }) as typeof fetch;
    const deps = makeDeps({ fetchImpl: failingFetch, maxRetryAttempts: 0 });
    const input: UploadEpisodeInput = { scopeId: 'epi_scope_1', mint: MINT_INPUT, episode: episode() };

    const result = await uploadEpisode(input, deps);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: 'transport' });
  });
});

function memPendingStore(): PendingEpisodeFileStore {
  const state = { pending: [] as PendingEpisode[] };
  return {
    read: async () => structuredClone({ pending: state.pending }),
    write: async (f) => {
      state.pending = structuredClone(f.pending);
    },
  };
}

describe('deliverEpisode (RUN-227)', () => {
  it('enqueues durably BEFORE attempting the network call, and clears the entry once delivered', async () => {
    const { mintFetch, ingestFetch } = router({});
    const pending = new EpisodePendingStore(memPendingStore());
    const deps: EpisodeDeliveryDeps = {
      client: new NoriqClient({ server: 'https://noriq.example', token: 'tok', fetchImpl: mintFetch }),
      fetchImpl: ingestFetch,
      runnerId: 'rnr_1',
      pending,
    };

    await deliverEpisode(episode(), deps);

    expect(await pending.list()).toEqual([]);
  });

  it('a repositoryKey-less episode is never enqueued — the mint would 404 forever', async () => {
    const pending = new EpisodePendingStore(memPendingStore());
    const deps: EpisodeDeliveryDeps = {
      client: new NoriqClient({ server: 'https://noriq.example', token: 'tok' }),
      runnerId: 'rnr_1',
      pending,
    };

    await deliverEpisode(episode({ repositoryKey: null }), deps);

    expect(await pending.list()).toEqual([]);
  });

  it('never gates: a delivery whose client throws still resolves without throwing', async () => {
    const throwingClient = new NoriqClient({
      server: 'https://noriq.example',
      token: 'tok',
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as typeof fetch,
    });
    const pending = new EpisodePendingStore(memPendingStore());
    const deps: EpisodeDeliveryDeps = {
      client: throwingClient,
      runnerId: 'rnr_1',
      pending,
      maxRetryAttempts: 0,
    };

    await expect(deliverEpisode(episode(), deps)).resolves.toBeUndefined();
    // The entry survives — delivery failed, so the pending queue still holds it for a later retry.
    expect(await pending.list()).toHaveLength(1);
  });
});

describe('drainPendingEpisodes (RUN-227)', () => {
  it('delivers every entry it can and leaves the rest, reporting an accurate count', async () => {
    const store = memPendingStore();
    const pending = new EpisodePendingStore(store);
    await pending.put({
      scopeId: 'epi_a',
      episode: episode({ runId: 'run_a' }),
      mint: MINT_INPUT,
      enqueuedAt: '2026-08-08T00:00:00.000Z',
    });
    await pending.put({
      scopeId: 'epi_b',
      episode: episode({ runId: 'run_b' }),
      mint: MINT_INPUT,
      enqueuedAt: '2026-08-08T00:00:00.000Z',
    });
    const { mintFetch, ingestFetch } = router({
      complete: () => {
        // Deliver only the FIRST scope this drain sees; the second still fails.
        return new Response(
          JSON.stringify({ ok: true, batchesReceived: 1, rowCount: 1, recorded: 0, skipped: 1 }),
          {
            status: 200,
          },
        );
      },
    });
    let completeCalls = 0;
    const alternatingIngest = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/complete')) {
        completeCalls += 1;
        if (completeCalls === 1) {
          return new Response(
            JSON.stringify({ ok: true, batchesReceived: 1, rowCount: 1, recorded: 1, skipped: 0 }),
            {
              status: 200,
            },
          );
        }
      }
      return ingestFetch(url, init);
    }) as typeof fetch;
    const deps: EpisodeDeliveryDeps = {
      client: new NoriqClient({ server: 'https://noriq.example', token: 'tok', fetchImpl: mintFetch }),
      fetchImpl: alternatingIngest,
      runnerId: 'rnr_1',
      pending,
      retryBaseMs: 1,
      retryMaxMs: 2,
      maxRetryAttempts: 1,
    };

    const result = await drainPendingEpisodes(deps);

    expect(result).toEqual({ delivered: 1, remaining: 1 });
    const survivors = await pending.list();
    expect(survivors.map((e) => e.scopeId)).toEqual(['epi_b']);
  });
});
