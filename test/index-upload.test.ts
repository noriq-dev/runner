import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IndexGenerationManifest } from '@noriq-dev/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoriqClient } from '../src/client';
import type { EncodedBatch } from '../src/index-batch';
import { IndexJournal, type IndexJournalKey, type JournalStore } from '../src/index-journal';
import { fileStagingStore, stagingDirFor } from '../src/index-stage';
import {
  DEFAULT_MAX_STAGED_BYTES,
  MAX_LOGGED_VALIDATION_PROBLEMS,
  type UploadGenerationDeps,
  type UploadGenerationInput,
  boundedValidationProblems,
  uploadGeneration,
} from '../src/index-upload';

// RUN-221: the upload phase. Fakes are built at the FETCH layer (never by mocking `IngestUpload`
// itself) so the real `openIngestUpload`/`IngestUpload`/`classifyIngestFailure` code runs, the
// same discipline `ingest-client.test.ts` already uses — this task's own warning that a fake
// politer than the real server is how a batching task ships broken.

const KEY: IndexJournalKey = {
  server: 'https://noriq.example',
  repositoryKey: 'my-repo',
  baseId: 'sha-base-1',
  indexerVersion: '1',
  generationId: 'gen_1',
};

const GRANT = { token: 'ing_tok_abc123', maxBytes: 8 * 1024 * 1024, expiresAt: '2026-08-08T00:15:00.000Z' };

function batch(n: number, content: string): EncodedBatch {
  return {
    generationId: KEY.generationId,
    batchNumber: n,
    batchHash: `hash-${n}`,
    compressed: Buffer.from(content),
    rowCount: 1,
  };
}

const MANIFEST: IndexGenerationManifest = {
  generationId: KEY.generationId,
  projectId: 'prj_1',
  repositoryKey: KEY.repositoryKey,
  branch: 'main',
  baseId: KEY.baseId,
  indexerVersion: KEY.indexerVersion,
  batchCount: 3,
  fileCount: 10,
  contentHash: 'content-hash',
  deletions: [],
  createdAt: '2026-08-08T00:00:00.000Z',
};

const BATCHES: EncodedBatch[] = [batch(0, 'batch-zero'), batch(1, 'batch-one'), batch(2, 'batch-two')];

const MINT_INPUT = { projectId: 'prj_1', repositoryKey: KEY.repositoryKey, runnerId: 'rnr_1' };

/** A router over the two DISTINCT transports a real upload uses: the client's own Bearer-
 *  authorized mint call, and the token-in-path ingest routes — mirrors `ingest-client.test.ts`'s
 *  own split rather than collapsing them into one fake. */
function router(handlers: {
  mint?: (init: RequestInit) => Response;
  begin?: () => Response;
  status?: () => Response;
  batch?: (n: number) => Response;
  complete?: () => Response;
}) {
  const calls: { url: string; method: string }[] = [];
  const mintFetch = (async (_url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(_url), method: init?.method ?? 'GET' });
    return (handlers.mint ?? (() => new Response(JSON.stringify(GRANT), { status: 200 })))(init ?? {});
  }) as typeof fetch;
  const ingestFetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? 'GET' });
    if (u.endsWith('/begin')) return (handlers.begin ?? (() => new Response('{}', { status: 200 })))();
    if (u.endsWith('/status'))
      return (
        handlers.status ??
        (() =>
          new Response(JSON.stringify({ status: 'unknown', batchesReceived: 0, batchesExpected: null }), {
            status: 200,
          }))
      )();
    if (u.endsWith('/complete'))
      return (
        handlers.complete ??
        (() =>
          new Response(
            JSON.stringify({ ok: true, batchesReceived: 3, validation: { ok: true, problems: [] } }),
            { status: 200 },
          ))
      )();
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

async function makeDeps(
  root: string,
  over: Partial<UploadGenerationDeps> = {},
  fetches?: { mintFetch: typeof fetch; ingestFetch: typeof fetch },
): Promise<{ deps: UploadGenerationDeps; journal: IndexJournal; released: number }> {
  const state = { released: 0 };
  const memStore: JournalStore = (() => {
    const s = { file: {} as Record<string, unknown> };
    return {
      read: async () => structuredClone(s.file) as never,
      write: async (f) => {
        s.file = structuredClone(f) as never;
      },
    };
  })();
  const journal = new IndexJournal(memStore);
  const { mintFetch, ingestFetch } = fetches ?? router({});
  const client = new NoriqClient({
    server: 'https://noriq.example',
    token: 'daemon-tok',
    fetchImpl: mintFetch,
  });
  const deps: UploadGenerationDeps = {
    client,
    journal,
    staging: fileStagingStore(root),
    release: async () => {
      state.released += 1;
    },
    signal: new AbortController().signal,
    fetchImpl: ingestFetch,
    retryBaseMs: 1,
    retryMaxMs: 2,
    maxRetryAttempts: 2,
    ...over,
  };
  return { deps, journal, released: state.released };
}

describe('uploadGeneration (RUN-221)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'noriq-index-upload-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('happy path: unknown -> begin -> every batch PUT in order -> complete, then local cleanup', async () => {
    const putOrder: number[] = [];
    const { mintFetch, ingestFetch, calls } = router({
      batch: (n) => {
        putOrder.push(n);
        return new Response(JSON.stringify({ ok: true, deduped: false }), { status: 200 });
      },
      complete: () =>
        new Response(
          JSON.stringify({
            ok: true,
            batchesReceived: 3,
            validation: { ok: true, problems: [] },
            activation: { activated: 'gen_1', superseded: ['gen_0'] },
          }),
          { status: 200 },
        ),
    });
    const { deps, journal } = await makeDeps(root, {}, { mintFetch, ingestFetch });
    const input: UploadGenerationInput = { key: KEY, mint: MINT_INPUT, manifest: MANIFEST, batches: BATCHES };

    const result = await uploadGeneration(input, deps);

    expect(result).toEqual({ ok: true, batchesReceived: 3, activated: 'gen_1' });
    expect(putOrder).toEqual([0, 1, 2]);
    expect(calls.some((c) => c.url.endsWith('/begin'))).toBe(true);
    expect(await journal.get(KEY)).toBeNull(); // cleaned up on success
  });

  it('releases the VCS snapshot BEFORE the first upload call, within the staging bound', async () => {
    const order: string[] = [];
    let released = 0;
    const { mintFetch, ingestFetch } = router({
      batch: (n) => {
        order.push(`put:${n}`);
        return new Response(JSON.stringify({ ok: true, deduped: false }), { status: 200 });
      },
      begin: () => {
        order.push('begin');
        return new Response('{}', { status: 200 });
      },
      status: () => {
        order.push('status');
        return new Response(
          JSON.stringify({ status: 'unknown', batchesReceived: 0, batchesExpected: null }),
          {
            status: 200,
          },
        );
      },
    });
    const { deps } = await makeDeps(
      root,
      {
        release: async () => {
          released += 1;
          order.push('release');
        },
      },
      { mintFetch, ingestFetch },
    );
    const input: UploadGenerationInput = { key: KEY, mint: MINT_INPUT, manifest: MANIFEST, batches: BATCHES };

    await uploadGeneration(input, deps);

    expect(released).toBe(1);
    expect(order[0]).toBe('release');
    expect(order.indexOf('release')).toBeLessThan(order.indexOf('status'));
    expect(order.indexOf('release')).toBeLessThan(order.indexOf('begin'));
    expect(order.indexOf('release')).toBeLessThan(order.indexOf('put:0'));
  });

  it('stages every batch to disk before releasing', async () => {
    const { deps } = await makeDeps(root);
    const input: UploadGenerationInput = { key: KEY, mint: MINT_INPUT, manifest: MANIFEST, batches: BATCHES };
    await uploadGeneration(input, deps);
    // Staged bytes are cleared on SUCCESS (locked decision 7) — assert indirectly via a run that
    // never reaches completion instead, in the dedicated staging test below; here we assert the
    // staging store's writeBatch was actually exercised by re-running with a store spy.
    let wrote = 0;
    const spyStaging = {
      ...deps.staging,
      writeBatch: async (...args: Parameters<(typeof deps.staging)['writeBatch']>) => {
        wrote += 1;
        return deps.staging.writeBatch(...args);
      },
    };
    const { deps: deps2 } = await makeDeps(root, { staging: spyStaging });
    await uploadGeneration({ ...input, key: { ...KEY, generationId: 'gen_spy' } }, deps2);
    expect(wrote).toBe(3);
  });

  it('over the staging ceiling: keeps the snapshot (never calls release) and still completes', async () => {
    let released = 0;
    const { mintFetch, ingestFetch } = router({});
    const { deps } = await makeDeps(
      root,
      {
        maxStagedBytes: 1, // smaller than any batch — forces the streaming branch
        release: async () => {
          released += 1;
        },
      },
      { mintFetch, ingestFetch },
    );
    const input: UploadGenerationInput = { key: KEY, mint: MINT_INPUT, manifest: MANIFEST, batches: BATCHES };

    const result = await uploadGeneration(input, deps);

    expect(result).toEqual({ ok: true, batchesReceived: 3 });
    expect(released).toBe(0); // caller's own cleanup releases it, not this function
  });

  it('resume: status "pending" with batchesReceived=1 sends only batches 1 and 2, never batch 0 again', async () => {
    const putOrder: number[] = [];
    const { mintFetch, ingestFetch } = router({
      status: () =>
        new Response(JSON.stringify({ status: 'pending', batchesReceived: 1, batchesExpected: 3 }), {
          status: 200,
        }),
      batch: (n) => {
        putOrder.push(n);
        return new Response(JSON.stringify({ ok: true, deduped: false }), { status: 200 });
      },
    });
    const { deps } = await makeDeps(root, {}, { mintFetch, ingestFetch });
    const input: UploadGenerationInput = { key: KEY, mint: MINT_INPUT, manifest: MANIFEST, batches: BATCHES };

    const result = await uploadGeneration(input, deps);

    expect(result).toEqual({ ok: true, batchesReceived: 3 });
    expect(putOrder).toEqual([1, 2]);
  });

  // RUN-234: "resume" is one of this task's own event categories — before this, a genuine resume
  // (the server already holding some batches from a prior attempt) was silent; only a MISMATCH
  // between the server's count and this attempt's own encoding got a log line at all.
  it('a genuine resume (server already holds batches) is logged; a fresh attempt (nothing confirmed) is not', async () => {
    const resumeLines: Array<Record<string, unknown> | undefined> = [];
    const logger = {
      debug() {},
      error() {},
      warn() {},
      info: (msg: string, fields?: Record<string, unknown>) => {
        if (msg.includes('resuming')) resumeLines.push(fields);
      },
    } as unknown as UploadGenerationDeps['logger'];

    const { mintFetch: resumeMint, ingestFetch: resumeIngest } = router({
      status: () =>
        new Response(JSON.stringify({ status: 'pending', batchesReceived: 1, batchesExpected: 3 }), {
          status: 200,
        }),
    });
    const { deps: resumeDeps } = await makeDeps(
      root,
      { logger },
      { mintFetch: resumeMint, ingestFetch: resumeIngest },
    );
    await uploadGeneration({ key: KEY, mint: MINT_INPUT, manifest: MANIFEST, batches: BATCHES }, resumeDeps);
    expect(resumeLines).toHaveLength(1);
    expect(resumeLines[0]).toMatchObject({
      repositoryKey: 'my-repo',
      generationId: 'gen_1',
      batchesConfirmed: 1,
      batchCount: 3,
    });

    resumeLines.length = 0;
    const { mintFetch: freshMint, ingestFetch: freshIngest } = router({}); // status: 'unknown' by default
    const { deps: freshDeps } = await makeDeps(
      root,
      { logger },
      { mintFetch: freshMint, ingestFetch: freshIngest },
    );
    await uploadGeneration({ key: KEY, mint: MINT_INPUT, manifest: MANIFEST, batches: BATCHES }, freshDeps);
    expect(resumeLines).toHaveLength(0);
  });

  it('resume: status "complete" short-circuits to local cleanup — no begin, no batch PUT, no complete() call', async () => {
    const calledPaths: string[] = [];
    const { mintFetch, ingestFetch } = router({
      status: () =>
        new Response(JSON.stringify({ status: 'complete', batchesReceived: 3, batchesExpected: 3 }), {
          status: 200,
        }),
      begin: () => {
        calledPaths.push('begin');
        return new Response('{}', { status: 200 });
      },
      batch: (n) => {
        calledPaths.push(`batch-${n}`);
        return new Response(JSON.stringify({ ok: true, deduped: false }), { status: 200 });
      },
      complete: () => {
        calledPaths.push('complete');
        return new Response(
          JSON.stringify({ ok: true, batchesReceived: 3, validation: { ok: true, problems: [] } }),
          { status: 200 },
        );
      },
    });
    const { deps, journal } = await makeDeps(root, {}, { mintFetch, ingestFetch });
    // Pre-seed a journal entry, as a genuine resume would have one from the earlier attempt.
    await journal.put(KEY, { batchesConfirmed: 3, batchCount: 3, staged: true });
    const input: UploadGenerationInput = { key: KEY, mint: MINT_INPUT, manifest: MANIFEST, batches: BATCHES };

    const result = await uploadGeneration(input, deps);

    expect(result).toEqual({ ok: true, batchesReceived: 3 });
    expect(calledPaths).toEqual([]);
    expect(await journal.get(KEY)).toBeNull();
  });

  it('a journal entry claiming MORE sent than the server reports loses to the server — the missing batches are sent', async () => {
    const putOrder: number[] = [];
    const { mintFetch, ingestFetch } = router({
      status: () =>
        new Response(JSON.stringify({ status: 'pending', batchesReceived: 1, batchesExpected: 3 }), {
          status: 200,
        }),
      batch: (n) => {
        putOrder.push(n);
        return new Response(JSON.stringify({ ok: true, deduped: false }), { status: 200 });
      },
    });
    const { deps, journal } = await makeDeps(root, {}, { mintFetch, ingestFetch });
    // The journal claims all 3 were sent; the server disagrees (only 1). Server wins.
    await journal.put(KEY, { batchesConfirmed: 3, batchCount: 3, staged: true });
    const input: UploadGenerationInput = { key: KEY, mint: MINT_INPUT, manifest: MANIFEST, batches: BATCHES };

    await uploadGeneration(input, deps);

    expect(putOrder).toEqual([1, 2]);
  });

  it.each([
    ['a missing journal (nothing ever recorded)', undefined],
    ['a journal store that throws on read', 'throw'],
    ['a journal store returning null', null],
    ['a journal store returning an array', []],
  ] as const)(
    '%s produces a clean full attempt — never a throw, never a skipped batch',
    async (_label, mode) => {
      const putOrder: number[] = [];
      const { mintFetch, ingestFetch } = router({
        batch: (n) => {
          putOrder.push(n);
          return new Response(JSON.stringify({ ok: true, deduped: false }), { status: 200 });
        },
      });
      let journalStore: JournalStore;
      if (mode === 'throw') {
        journalStore = {
          read: async () => {
            throw new Error('disk read failed');
          },
          write: async () => {},
        };
      } else if (mode === null || Array.isArray(mode)) {
        journalStore = { read: async () => mode as never, write: async () => {} };
      } else {
        const s = { file: {} as Record<string, unknown> };
        journalStore = {
          read: async () => structuredClone(s.file) as never,
          write: async (f) => {
            s.file = structuredClone(f) as never;
          },
        };
      }
      const journal = new IndexJournal(journalStore);
      const { deps } = await makeDeps(root, { journal }, { mintFetch, ingestFetch });
      const input: UploadGenerationInput = {
        key: KEY,
        mint: MINT_INPUT,
        manifest: MANIFEST,
        batches: BATCHES,
      };

      const result = await uploadGeneration(input, deps);

      expect(result).toEqual({ ok: true, batchesReceived: 3 });
      expect(putOrder).toEqual([0, 1, 2]);
    },
  );

  it('a mismatched baseId in an unrelated journal entry does not affect this key’s clean full attempt', async () => {
    const putOrder: number[] = [];
    const { mintFetch, ingestFetch } = router({
      batch: (n) => {
        putOrder.push(n);
        return new Response(JSON.stringify({ ok: true, deduped: false }), { status: 200 });
      },
    });
    const { deps, journal } = await makeDeps(root, {}, { mintFetch, ingestFetch });
    await journal.put({ ...KEY, baseId: 'stale-base' }, { batchesConfirmed: 3, batchCount: 3, staged: true });
    const input: UploadGenerationInput = { key: KEY, mint: MINT_INPUT, manifest: MANIFEST, batches: BATCHES };

    await uploadGeneration(input, deps);

    expect(putOrder).toEqual([0, 1, 2]);
  });

  it('never records complete unless validation.ok is true — problems are surfaced, state is left in place', async () => {
    const { mintFetch, ingestFetch } = router({
      complete: () =>
        new Response(
          JSON.stringify({
            ok: true,
            batchesReceived: 3,
            validation: { ok: false, problems: ['batch 2 checksum mismatch'] },
          }),
          { status: 200 },
        ),
    });
    const { deps, journal } = await makeDeps(root, {}, { mintFetch, ingestFetch });
    const input: UploadGenerationInput = { key: KEY, mint: MINT_INPUT, manifest: MANIFEST, batches: BATCHES };

    const result = await uploadGeneration(input, deps);

    expect(result).toEqual({ ok: false, reason: 'validation', problems: ['batch 2 checksum mismatch'] });
    expect(await journal.get(KEY)).not.toBeNull(); // left for the next attempt
  });

  // RUN-234 locked decision 2: the RETURNED outcome above still carries every problem (a caller
  // that wants the full list unabridged still gets it — this is a LOGGING bound, not a contract
  // change); what must never happen is the full array reaching a log line unbounded, which a
  // monorepo's worth of per-entity validation problems would turn into a dump.
  it('a large validation problem list is logged bounded — count plus a capped, truncated sample', async () => {
    const manyProblems = Array.from({ length: 200 }, (_, i) => `entity ${i}: field "x" is invalid`.repeat(5));
    const { mintFetch, ingestFetch } = router({
      complete: () =>
        new Response(
          JSON.stringify({ ok: true, batchesReceived: 3, validation: { ok: false, problems: manyProblems } }),
          { status: 200 },
        ),
    });
    const lines: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const logger = {
      debug() {},
      info() {},
      error() {},
      warn: (msg: string, fields?: Record<string, unknown>) => lines.push({ msg, fields }),
    } as unknown as UploadGenerationDeps['logger'];
    const { deps } = await makeDeps(root, { logger }, { mintFetch, ingestFetch });
    const input: UploadGenerationInput = { key: KEY, mint: MINT_INPUT, manifest: MANIFEST, batches: BATCHES };

    const result = await uploadGeneration(input, deps);

    expect(result).toMatchObject({ ok: false, reason: 'validation' });
    const line = lines.find((l) => l.msg.includes('rejected validation'));
    expect(line).toBeDefined();
    expect(line?.fields?.count).toBe(200);
    const sample = line?.fields?.sample as string[];
    expect(sample).toHaveLength(MAX_LOGGED_VALIDATION_PROBLEMS);
    for (const s of sample) expect(s.length).toBeLessThanOrEqual(200);
    // The raw problems array must never appear as its own field on the logged line.
    expect(line?.fields?.problems).toBeUndefined();
  });

  describe('boundedValidationProblems (RUN-234)', () => {
    it('caps the sample and truncates each entry, but always reports the true count', () => {
      const problems = Array.from({ length: 50 }, (_, i) => `p${i}`.repeat(100));
      const { count, sample } = boundedValidationProblems(problems);
      expect(count).toBe(50);
      expect(sample).toHaveLength(MAX_LOGGED_VALIDATION_PROBLEMS);
      for (const s of sample) expect(s.length).toBeLessThanOrEqual(200);
    });

    it('a short list is returned in full, untruncated', () => {
      const { count, sample } = boundedValidationProblems(['one problem']);
      expect(count).toBe(1);
      expect(sample).toEqual(['one problem']);
    });
  });

  it('"too-large" is not retried and not counted as a network failure — one PUT attempt only', async () => {
    let putAttempts = 0;
    const { mintFetch, ingestFetch } = router({
      mint: () => new Response(JSON.stringify({ ...GRANT, maxBytes: 2 }), { status: 200 }),
      batch: () => {
        putAttempts += 1;
        return new Response('{}', { status: 200 }); // unreachable — refused locally first
      },
    });
    const { deps } = await makeDeps(root, {}, { mintFetch, ingestFetch });
    const input: UploadGenerationInput = { key: KEY, mint: MINT_INPUT, manifest: MANIFEST, batches: BATCHES };

    const result = await uploadGeneration(input, deps);

    expect(result).toMatchObject({ ok: false, reason: 'too-large' });
    expect(putAttempts).toBe(0);
  });

  it('"disabled" stops immediately — zero retries', async () => {
    let statusAttempts = 0;
    const { mintFetch, ingestFetch } = router({
      status: () => {
        statusAttempts += 1;
        return new Response(JSON.stringify({ error: 'ingest not enabled' }), { status: 503 });
      },
    });
    const { deps } = await makeDeps(root, {}, { mintFetch, ingestFetch });
    const input: UploadGenerationInput = { key: KEY, mint: MINT_INPUT, manifest: MANIFEST, batches: BATCHES };

    const result = await uploadGeneration(input, deps);

    expect(result).toMatchObject({ ok: false, reason: 'disabled' });
    expect(statusAttempts).toBe(1);
  });

  it('a terminal reason (conflict) fails the attempt without retrying', async () => {
    let statusAttempts = 0;
    const { mintFetch, ingestFetch } = router({
      status: () => {
        statusAttempts += 1;
        return new Response(JSON.stringify({ error: 'generation gen_1 is already complete' }), {
          status: 409,
        });
      },
    });
    const { deps } = await makeDeps(root, {}, { mintFetch, ingestFetch });
    const input: UploadGenerationInput = { key: KEY, mint: MINT_INPUT, manifest: MANIFEST, batches: BATCHES };

    const result = await uploadGeneration(input, deps);

    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect(statusAttempts).toBe(1);
  });

  it('a transient transport failure retries within the ceiling and then succeeds', async () => {
    let statusAttempts = 0;
    const { mintFetch, ingestFetch } = router({
      status: () => {
        statusAttempts += 1;
        if (statusAttempts < 2) return new Response('{"error":"boom"}', { status: 500 });
        return new Response(
          JSON.stringify({ status: 'unknown', batchesReceived: 0, batchesExpected: null }),
          {
            status: 200,
          },
        );
      },
    });
    const { deps } = await makeDeps(root, {}, { mintFetch, ingestFetch });
    const input: UploadGenerationInput = { key: KEY, mint: MINT_INPUT, manifest: MANIFEST, batches: BATCHES };

    const result = await uploadGeneration(input, deps);

    expect(result).toEqual({ ok: true, batchesReceived: 3 });
    expect(statusAttempts).toBe(2);
  });

  it('a transient failure that never clears exhausts the retry ceiling and fails, leaving state in place', async () => {
    let statusAttempts = 0;
    const { mintFetch, ingestFetch } = router({
      status: () => {
        statusAttempts += 1;
        return new Response('{"error":"boom"}', { status: 500 });
      },
    });
    const { deps, journal } = await makeDeps(
      root,
      { maxRetryAttempts: 2, retryBaseMs: 1, retryMaxMs: 1 },
      { mintFetch, ingestFetch },
    );
    const input: UploadGenerationInput = { key: KEY, mint: MINT_INPUT, manifest: MANIFEST, batches: BATCHES };

    const result = await uploadGeneration(input, deps);

    expect(result).toMatchObject({ ok: false, reason: 'http' });
    expect(statusAttempts).toBe(3); // the original attempt + 2 retries
    expect(await journal.get(KEY)).not.toBeNull();
  });

  it('a mid-upload token expiry (401 once) does not fail the upload — IngestUpload’s own remint handles it', async () => {
    let batchAttempts = 0;
    let mintAttempts = 0;
    const { mintFetch, ingestFetch } = router({
      mint: () => {
        mintAttempts += 1;
        const grant = mintAttempts === 1 ? GRANT : { ...GRANT, token: 'ing_tok_fresh' };
        return new Response(JSON.stringify(grant), { status: 200 });
      },
      batch: (n) => {
        if (n === 0) {
          batchAttempts += 1;
          if (batchAttempts === 1) {
            return new Response(JSON.stringify({ error: 'invalid or expired ingest token' }), {
              status: 401,
            });
          }
        }
        return new Response(JSON.stringify({ ok: true, deduped: false }), { status: 200 });
      },
    });
    const { deps } = await makeDeps(root, {}, { mintFetch, ingestFetch });
    const input: UploadGenerationInput = { key: KEY, mint: MINT_INPUT, manifest: MANIFEST, batches: BATCHES };

    const result = await uploadGeneration(input, deps);

    expect(result).toEqual({ ok: true, batchesReceived: 3 });
    expect(mintAttempts).toBe(2); // the initial mint + IngestUpload's own internal re-mint
  });

  it('cancellation mid-upload stops before completing and leaves resumable state (no complete() call)', async () => {
    const controller = new AbortController();
    let completeCalled = false;
    const { mintFetch, ingestFetch } = router({
      batch: (n) => {
        if (n === 1) controller.abort();
        return new Response(JSON.stringify({ ok: true, deduped: false }), { status: 200 });
      },
      complete: () => {
        completeCalled = true;
        return new Response(
          JSON.stringify({ ok: true, batchesReceived: 3, validation: { ok: true, problems: [] } }),
          { status: 200 },
        );
      },
    });
    const { deps, journal } = await makeDeps(root, { signal: controller.signal }, { mintFetch, ingestFetch });
    const input: UploadGenerationInput = { key: KEY, mint: MINT_INPUT, manifest: MANIFEST, batches: BATCHES };

    const result = await uploadGeneration(input, deps);

    expect(result).toEqual({ ok: false, reason: 'cancelled' });
    expect(completeCalled).toBe(false);
    expect(await journal.get(KEY)).not.toBeNull(); // resumable — not forgotten
  });

  it('a signal already aborted before the call starts short-circuits without staging or network calls', async () => {
    const controller = new AbortController();
    controller.abort();
    const { mintFetch, ingestFetch, calls } = router({});
    const { deps } = await makeDeps(root, { signal: controller.signal }, { mintFetch, ingestFetch });
    const input: UploadGenerationInput = { key: KEY, mint: MINT_INPUT, manifest: MANIFEST, batches: BATCHES };

    const result = await uploadGeneration(input, deps);

    expect(result).toEqual({ ok: false, reason: 'cancelled' });
    expect(calls).toEqual([]);
  });

  it('the default staging ceiling is the documented constant', () => {
    expect(DEFAULT_MAX_STAGED_BYTES).toBe(128 * 1024 * 1024);
  });

  it('completion clears the staged bytes on disk', async () => {
    const { mintFetch, ingestFetch } = router({});
    const { deps } = await makeDeps(root, {}, { mintFetch, ingestFetch });
    const input: UploadGenerationInput = { key: KEY, mint: MINT_INPUT, manifest: MANIFEST, batches: BATCHES };
    await uploadGeneration(input, deps);
    const { existsSync } = await import('node:fs');
    expect(existsSync(stagingDirFor(KEY, root))).toBe(false);
  });
});
