import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type {
  EffortEpisode as EffortEpisodeType,
  UploadedEpisodeIntelligence as UploadedEpisodeIntelligenceType,
} from '@noriq-dev/shared';
import { UploadedEpisodeIntelligence } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
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
  toEnrichmentPayload,
  uploadEpisode,
} from '../src/episode-upload';
import { stageFactFromTelemetry } from '../src/stage-facts';
import { completeDuration } from '../src/stage-timing';

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
  const calls: { url: string; method: string; body?: RequestInit['body'] }[] = [];
  const mintFetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body });
    return (handlers.mint ?? (() => new Response(JSON.stringify(GRANT), { status: 200 })))();
  }) as typeof fetch;
  const ingestFetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? 'GET', body: init?.body });
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

/** Decode the gzipped JSON body PUT to `/batch/0` — the exact bytes `ingest-client.ts`'s
 *  `putBatch` sends verbatim (locked decision 3: never re-serialized past this point), so
 *  decoding it back is the only way to assert what actually crossed the wire rather than what a
 *  unit test on `toEnrichmentPayload` alone would merely imply. */
function decodeBatchBody(calls: { url: string; method: string; body?: RequestInit['body'] }[]): unknown {
  const call = calls.find((c) => c.url.endsWith('/batch/0'));
  if (!call?.body) throw new Error('no /batch/0 call captured');
  const bytes = call.body as Uint8Array;
  return JSON.parse(gunzipSync(Buffer.from(bytes)).toString('utf8'));
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

  it('RUN-264: the actual wire body sent to /batch/0 is the narrowed enrichment payload, not the full local record', async () => {
    const { mintFetch, ingestFetch, calls } = router({});
    const deps = makeDeps({}, { mintFetch, ingestFetch });
    const ep = episode({
      taskId: 'task_1', // server-owned — must not ship
      timeline: [{ at: '2026-08-08T00:00:00.000Z', label: 'queued' }], // server-owned — must not ship
      costUSD: 12.5, // server-owned — must not ship
      filesTouched: ['src/a.ts'],
      commands: ['npm run check — passed'],
      testsRun: ['npm run check — passed'],
      failures: ['terminal reason: budget exceeded'],
      findings: [{ summary: '[resolved] a finding', severity: 'low' }],
      selfSummary: {
        approachSummary: 'did the thing',
        rejectedHypotheses: [],
        durableLearnings: [],
        unresolvedQuestions: [],
      },
    });
    const input: UploadEpisodeInput = { scopeId: 'epi_scope_1', mint: MINT_INPUT, episode: ep };

    await uploadEpisode(input, deps);

    expect(decodeBatchBody(calls)).toEqual(toEnrichmentPayload(ep));
    expect(decodeBatchBody(calls)).toEqual({
      runId: 'run_1',
      filesTouched: ['src/a.ts'],
      commands: ['npm run check — passed'],
      testsRun: ['npm run check — passed'],
      failures: ['terminal reason: budget exceeded'],
      findings: [{ summary: '[resolved] a finding', severity: 'low' }],
      selfSummary: ep.selfSummary,
    });
    // Every server-owned key from the full local record is absent, not merely empty.
    const body = decodeBatchBody(calls) as Record<string, unknown>;
    for (const key of [
      'id',
      'projectId',
      'taskId',
      'repositoryKey',
      'baseId',
      'timeline',
      'reviewRounds',
      'tokenUsage',
      'costUSD',
      'acceptanceCoverage',
      'steeringEvents',
      'landingOutcome',
      'remainingWork',
      'createdAt',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(body, key)).toBe(false);
    }
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

  // RUN-234: `uploadEpisode` never THROWS for an ordinary failure (its own doc) — before this,
  // that meant a typed, non-ok outcome here was entirely silent (only a genuine bug that threw
  // ever reached a log line). A 503 ("ingest not enabled") is exactly the ordinary case: caught
  // inside `uploadEpisode`, returned as a typed outcome, never thrown.
  it('an ordinary (non-throwing) failed attempt is now logged with its reason — not silent', async () => {
    const { mintFetch, ingestFetch } = router({ mint: () => new Response('{}', { status: 503 }) });
    const pending = new EpisodePendingStore(memPendingStore());
    const lines: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const deps: EpisodeDeliveryDeps = {
      client: new NoriqClient({ server: 'https://noriq.example', token: 'tok', fetchImpl: mintFetch }),
      fetchImpl: ingestFetch,
      runnerId: 'rnr_1',
      pending,
      maxRetryAttempts: 0,
      logger: {
        debug() {},
        info() {},
        error() {},
        warn: (msg: string, fields?: Record<string, unknown>) => lines.push({ msg, fields }),
      } as never,
    };

    await deliverEpisode(episode(), deps);

    const line = lines.find((l) => l.msg.includes('did not complete'));
    expect(line).toBeDefined();
    expect(line?.fields).toMatchObject({ runId: 'run_1', reason: 'disabled' });
    expect(await pending.list()).toHaveLength(1); // still pending — a later drain retries it
  });

  // RUN-249 acceptance: "a complete() returning recorded: 0 behind an HTTP 200 still retries, and
  // a test proves the retry is not reported as delivered." `uploadEpisode`'s own "skipped-row trap"
  // test above pins the typed outcome; this pins the effect one layer up, at the sink real code
  // calls: the entry is never cleared from the durable spool, so a later drain still retries it.
  it('recorded:0 behind HTTP 200 is never reported as delivered — the entry survives for a later retry', async () => {
    const { mintFetch, ingestFetch } = router({
      complete: () =>
        new Response(JSON.stringify({ ok: true, batchesReceived: 1, rowCount: 1, recorded: 0, skipped: 1 }), {
          status: 200,
        }),
    });
    const pending = new EpisodePendingStore(memPendingStore());
    const deps: EpisodeDeliveryDeps = {
      client: new NoriqClient({ server: 'https://noriq.example', token: 'tok', fetchImpl: mintFetch }),
      fetchImpl: ingestFetch,
      runnerId: 'rnr_1',
      pending,
      maxRetryAttempts: 0,
    };

    await deliverEpisode(episode(), deps);

    // Never removed — `outcome.ok` was false, so the `deps.pending.remove(scopeId)` branch never ran.
    expect(await pending.list()).toHaveLength(1);
  });
});

describe('exactly-once across a restart (RUN-249): die AFTER complete() succeeds, BEFORE the spool entry clears', () => {
  it('a fresh store instance retried after a crash resolves via the already-complete conflict — exactly one canonical /complete ever lands', async () => {
    const scopeId = 'epi_restart_scope';
    const ep = episode({ runId: 'run_restart' });
    let completeCalls = 0;
    let serverComplete = false; // models server-side state: has this scope reached `complete`?
    const { mintFetch, ingestFetch } = router({
      begin: () =>
        serverComplete
          ? new Response(
              JSON.stringify({
                error: `episode upload ${scopeId} already complete — this purpose cannot be reopened`,
              }),
              { status: 409 },
            )
          : new Response('{}', { status: 200 }),
      complete: () => {
        completeCalls += 1;
        serverComplete = true;
        return new Response(
          JSON.stringify({ ok: true, batchesReceived: 1, rowCount: 1, recorded: 1, skipped: 0 }),
          { status: 200 },
        );
      },
    });

    // The durable backing file — persists across the simulated restart, the same "fresh store
    // instance over the same backing" shape `episode-pending.test.ts`'s own restart test uses.
    const backing = memPendingStore();

    // Sitting 1: enqueue durably, then the upload attempt reaches `complete()` and the server
    // records the canonical update (recorded: 1, serverComplete flips true) — modeled as the
    // daemon dying RIGHT HERE, before `deliverEpisode`'s own `pending.remove()` ever runs. Calling
    // `uploadEpisode` directly (never `deliverEpisode`, which would remove on success) is what lets
    // the test stop at exactly this window.
    const store1 = new EpisodePendingStore(backing);
    await store1.put({ scopeId, episode: ep, mint: MINT_INPUT, enqueuedAt: '2026-08-08T00:00:00.000Z' });
    const firstAttempt = await uploadEpisode(
      { scopeId, mint: MINT_INPUT, episode: ep },
      makeDeps({}, { mintFetch, ingestFetch }),
    );
    expect(firstAttempt).toEqual({ ok: true });
    expect(completeCalls).toBe(1);
    // The crash: nothing removed the entry. It is still exactly where sitting 1 left it.
    expect(await store1.list()).toHaveLength(1);

    // "Restart": a FRESH store instance over the SAME backing file, driven through the daemon's
    // real retry entry point (`drainPendingEpisodes`, what `daemon.ts` calls on startup/reconnect).
    const store2 = new EpisodePendingStore(backing);
    const deps2: EpisodeDeliveryDeps = {
      ...makeDeps({}, { mintFetch, ingestFetch }),
      runnerId: 'rnr_1',
      pending: store2,
    };
    const result = await drainPendingEpisodes(deps2);

    expect(result).toEqual({ delivered: 1, remaining: 0 });
    expect(await store2.list()).toEqual([]);
    // The whole point: the retry resolved via the already-complete conflict at `begin` and never
    // reached `complete` a second time — exactly ONE canonical update landed, ever. Not zero
    // (delivery still happened), not two (no duplicate row).
    expect(completeCalls).toBe(1);
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
    const lines: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const deps: EpisodeDeliveryDeps = {
      client: new NoriqClient({ server: 'https://noriq.example', token: 'tok', fetchImpl: mintFetch }),
      fetchImpl: alternatingIngest,
      runnerId: 'rnr_1',
      pending,
      retryBaseMs: 1,
      retryMaxMs: 2,
      maxRetryAttempts: 1,
      logger: {
        debug() {},
        info() {},
        error() {},
        warn: (msg: string, fields?: Record<string, unknown>) => lines.push({ msg, fields }),
      } as never,
    };

    const result = await drainPendingEpisodes(deps);

    expect(result).toEqual({ delivered: 1, remaining: 1 });
    const survivors = await pending.list();
    expect(survivors.map((e) => e.scopeId)).toEqual(['epi_b']);
    // RUN-234: the surviving entry's WHY, not just its count — the server's own
    // `recorded`/`skipped` split, folded into `uploadEpisode`'s typed `skipped-server-side` outcome.
    const line = lines.find((l) => l.msg.includes('remains pending'));
    expect(line).toBeDefined();
    expect(line?.fields).toMatchObject({ runId: 'run_b', scopeId: 'epi_b', reason: 'skipped-server-side' });
  });
});

describe('toEnrichmentPayload (RUN-264)', () => {
  it('an episode with nothing observed projects to exactly {runId} — every enrichment field absent', () => {
    const payload = toEnrichmentPayload(episode());

    expect(payload).toEqual({ runId: 'run_1' });
    expect(Object.keys(payload)).toEqual(['runId']);
  });

  it('the request body contains only the accepted keys — pinned by the exact key set, never a superset', () => {
    const payload = toEnrichmentPayload(
      episode({
        filesTouched: ['a.ts'],
        commands: ['cmd'],
        testsRun: ['cmd'],
        failures: ['f'],
        findings: [{ summary: 's', severity: 'low' }],
        selfSummary: {
          approachSummary: 'x',
          rejectedHypotheses: [],
          durableLearnings: [],
          unresolvedQuestions: [],
        },
      }),
    );

    expect(new Set(Object.keys(payload))).toEqual(
      new Set(['runId', 'filesTouched', 'commands', 'testsRun', 'failures', 'findings', 'selfSummary']),
    );
  });

  // One test per enrichment field (RUN-264 acceptance): an unobserved field is ABSENT from the
  // payload, never sent as `[]` — the inversion this task exists for. `writeMode: 'enrichment'`
  // merges as `provided ?? existing`, so an empty array would REPLACE whatever the server already
  // has; omitting the key PRESERVES it instead.
  it('filesTouched: empty (ambiguous — "touched nothing" vs "backend could not say") is OMITTED, not []', () => {
    const payload = toEnrichmentPayload(episode({ filesTouched: [] }));
    expect(Object.prototype.hasOwnProperty.call(payload, 'filesTouched')).toBe(false);
  });

  it('commands: empty (no command execution was observed) is OMITTED, not []', () => {
    const payload = toEnrichmentPayload(episode({ commands: [] }));
    expect(Object.prototype.hasOwnProperty.call(payload, 'commands')).toBe(false);
  });

  it('testsRun: empty (same source as commands) is OMITTED, not []', () => {
    const payload = toEnrichmentPayload(episode({ testsRun: [] }));
    expect(Object.prototype.hasOwnProperty.call(payload, 'testsRun')).toBe(false);
  });

  it('failures: empty is OMITTED, not [] — an empty ledger cannot be told apart from "review never ran"', () => {
    const payload = toEnrichmentPayload(episode({ failures: [] }));
    expect(Object.prototype.hasOwnProperty.call(payload, 'failures')).toBe(false);
  });

  it('findings: empty is OMITTED, not [] — same ambiguity as failures', () => {
    const payload = toEnrichmentPayload(episode({ findings: [] }));
    expect(Object.prototype.hasOwnProperty.call(payload, 'findings')).toBe(false);
  });

  it('selfSummary: null is OMITTED, not sent as an explicit null', () => {
    const payload = toEnrichmentPayload(episode({ selfSummary: null }));
    expect(Object.prototype.hasOwnProperty.call(payload, 'selfSummary')).toBe(false);
  });

  // A field the daemon DID observe is present, even when its observed value happens to be the
  // single non-empty entry — proving the omission is conditional on emptiness, not a blanket drop.
  it('a field with a real, non-empty observation is present and carries its exact value', () => {
    const payload = toEnrichmentPayload(
      episode({
        filesTouched: ['src/a.ts'],
        commands: ['npm run check — passed'],
        testsRun: ['npm run check — passed'],
        failures: ['terminal reason: budget exceeded'],
        findings: [{ summary: '[resolved] x', severity: 'high' }],
        selfSummary: {
          approachSummary: 'y',
          rejectedHypotheses: [],
          durableLearnings: [],
          unresolvedQuestions: [],
        },
      }),
    );

    expect(payload.filesTouched).toEqual(['src/a.ts']);
    expect(payload.commands).toEqual(['npm run check — passed']);
    expect(payload.testsRun).toEqual(['npm run check — passed']);
    expect(payload.failures).toEqual(['terminal reason: budget exceeded']);
    expect(payload.findings).toEqual([{ summary: '[resolved] x', severity: 'high' }]);
    expect(payload.selfSummary).toEqual({
      approachSummary: 'y',
      rejectedHypotheses: [],
      durableLearnings: [],
      unresolvedQuestions: [],
    });
  });

  it('runId always ships — the one field the enrichment shape requires, never optional', () => {
    const payload = toEnrichmentPayload(episode({ runId: 'run_xyz' }));
    expect(payload.runId).toBe('run_xyz');
  });
});

// RUN-284: `intelligence` validated fresh inside `toEnrichmentPayload`, on every call, and dropped
// (never the episode) on a failure. `test/intelligence-payload.test.ts` covers the ASSEMBLY (what
// `buildUploadedIntelligence` produces); this covers the BOUNDARY — what actually reaches the wire.

const VERIFY_SOURCE = { source: 'runner' as const, sourceId: 'verify' };

function validIntelligence(): UploadedEpisodeIntelligenceType {
  return {
    execution: {
      stages: [
        stageFactFromTelemetry('primary', {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0.1,
          numTurns: 1,
        } as never),
      ],
      clocks: { verifyDurationMs: completeDuration(12, VERIFY_SOURCE) },
    },
  };
}

describe('toEnrichmentPayload — intelligence (RUN-284)', () => {
  it('no intelligence passed → the key is absent, not sent as undefined or {}', () => {
    const payload = toEnrichmentPayload(episode());
    expect(Object.prototype.hasOwnProperty.call(payload, 'intelligence')).toBe(false);
  });

  it('a VALID payload ships through, parsed (schema-normalized) rather than the raw input object', () => {
    const intelligence = validIntelligence();
    const payload = toEnrichmentPayload(episode(), intelligence);
    expect(payload.intelligence).toEqual(intelligence);
    expect(UploadedEpisodeIntelligence.safeParse(payload.intelligence).success).toBe(true);
  });

  it('an INVALID payload is dropped — the field is absent, the rest of the payload ships anyway', () => {
    const bad = structuredClone(validIntelligence()) as {
      execution: { stages: Array<{ tokens: { provenance: string } }> };
    };
    bad.execution.stages[0]!.tokens.provenance = 'server_observed'; // legal MetricProvenance, not daemon-legal
    const warnings: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const log = { warn: (msg: string, fields?: Record<string, unknown>) => warnings.push({ msg, fields }) };

    const payload = toEnrichmentPayload(
      episode({ filesTouched: ['a.ts'] }),
      bad as unknown as UploadedEpisodeIntelligenceType,
      log,
    );

    expect(Object.prototype.hasOwnProperty.call(payload, 'intelligence')).toBe(false);
    expect(payload.filesTouched).toEqual(['a.ts']); // the rest of the episode still ships
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.msg).toMatch(/failed validation/);
    // Names the issue's PATH — where inside the payload it broke — not just "something is wrong".
    expect(String(warnings[0]?.fields?.issuePath)).toMatch(/stages/);
  });

  it('the actual wire body carries intelligence.execution.stages/.clocks.verifyDurationMs when observed', async () => {
    const { mintFetch, ingestFetch, calls } = router({});
    const deps = makeDeps({}, { mintFetch, ingestFetch });
    const intelligence = validIntelligence();
    const input: UploadEpisodeInput = {
      scopeId: 'epi_scope_1',
      mint: MINT_INPUT,
      episode: episode(),
      intelligence,
    };

    await uploadEpisode(input, deps);

    const body = decodeBatchBody(calls) as { intelligence?: UploadedEpisodeIntelligenceType };
    expect(body.intelligence).toEqual(intelligence);
    // No server-owned field anywhere in what actually left the box.
    for (const key of ['identity', 'sources', 'versions', 'outcome', 'executedStrategy', 'executedSpec']) {
      expect(body.intelligence).not.toHaveProperty(key);
    }
    expect(body.intelligence?.execution).not.toHaveProperty('configuration');
    expect(Object.prototype.hasOwnProperty.call(body, 'preExecution')).toBe(false);
  });

  it('a bad payload never reaches the wire, and the episode still delivers — HTTP still gets its other fields', async () => {
    const { mintFetch, ingestFetch, calls } = router({});
    const deps = makeDeps({}, { mintFetch, ingestFetch });
    const bad = structuredClone(validIntelligence()) as {
      execution: { clocks: { verifyDurationMs: { source: string } } };
    };
    bad.execution.clocks.verifyDurationMs.source = 'd1_coordination'; // legal IntelligenceSource, not daemon-legal
    const input: UploadEpisodeInput = {
      scopeId: 'epi_scope_1',
      mint: MINT_INPUT,
      episode: episode({ filesTouched: ['a.ts'] }),
      intelligence: bad as unknown as UploadedEpisodeIntelligenceType,
    };

    const result = await uploadEpisode(input, deps);

    expect(result).toEqual({ ok: true }); // the episode itself still delivered
    const body = decodeBatchBody(calls) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(body, 'intelligence')).toBe(false);
    expect(body.filesTouched).toEqual(['a.ts']);
  });
});

describe('forward compatibility with a server that predates `intelligence` (RUN-249)', () => {
  // RUN-249 locked decision: no version negotiation or downgrade path exists — the protocol
  // already handles this via zod's default unknown-key-stripping behaviour, VERIFIED here by
  // running it rather than assumed from reading the server source.
  it('an old server shape without an `intelligence` key accepts a payload carrying one, drops the key, and still records the base episode', () => {
    // Mirrors the shape of `UPLOADED_EPISODE_SHAPE` BEFORE PLNR-426 widened it to add
    // `intelligence` — a plain z.object over the base accepted keys, nothing more.
    const OLD_SERVER_SHAPE = z.object({
      runId: z.string(),
      filesTouched: z.array(z.string()).optional(),
      commands: z.array(z.string()).optional(),
      testsRun: z.array(z.string()).optional(),
      failures: z.array(z.string()).optional(),
      findings: z.array(z.unknown()).optional(),
      selfSummary: z.unknown().optional(),
    });

    const payload = toEnrichmentPayload(episode({ filesTouched: ['a.ts'] }), validIntelligence());
    expect(payload).toHaveProperty('intelligence'); // sanity: the wire payload really does carry it

    const parsed = OLD_SERVER_SHAPE.safeParse(payload);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty('intelligence'); // stripped, not rejected
      expect(parsed.data.runId).toBe('run_1'); // the base episode still records
      expect(parsed.data.filesTouched).toEqual(['a.ts']);
    }
  });
});

describe('no episode delivery path over the RunnerHub WS (RUN-249 acceptance)', () => {
  // Verified rather than guarded against: `ws-client.ts` has no episode-shaped frame or fallback
  // to close off today. Asserted here so a future change introducing one would have to touch this
  // test, rather than silently reopening a second delivery path this task's own locked decision
  // says must not exist.
  it('src/ws-client.ts contains no reference to episodes', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'ws-client.ts'), 'utf8');
    expect(src).not.toMatch(/episode/i);
  });
});
