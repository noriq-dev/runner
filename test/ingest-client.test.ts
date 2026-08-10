import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NoriqClient } from '../src/client';
import { IngestError, openIngestUpload } from '../src/ingest-client';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  rawBody: unknown;
}

/** A fake transport for the FIVE `/api/memory-ingest/:token/*` calls — deliberately separate from
 *  the client's own fetchImpl, mirroring the real split (Bearer-authorized mint vs. token-in-path
 *  ingest routes are two different trust shapes, never one transport). */
function fakeIngestFetch(
  respond: (url: string, init: RequestInit) => Response,
  captured: Captured[],
): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of new Headers(init?.headers).entries()) headers[k] = v;
    captured.push({ url: String(url), method: init?.method ?? 'GET', headers, rawBody: init?.body });
    return respond(String(url), (init ?? {}) as RequestInit);
  }) as typeof fetch;
}

function mintFetch(status: number, payload: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), { status })) as typeof fetch;
}

function makeClient(fetchImpl: typeof fetch): NoriqClient {
  return new NoriqClient({ server: 'https://noriq.example', token: 'daemon-oauth-token', fetchImpl });
}

const GRANT = { token: 'ing_tok_abc123', maxBytes: 8 * 1024 * 1024, expiresAt: '2026-08-08T00:15:00.000Z' };

const MINT_INPUT = {
  projectId: 'prj_1',
  repositoryKey: 'my-repo',
  purpose: 'index' as const,
  scopeId: 'gen_1',
  runnerId: 'rnr_1',
};

describe('openIngestUpload (RUN-220)', () => {
  it('mints under the daemon identity and returns an uploader bound to that (purpose, scopeId)', async () => {
    const client = makeClient(mintFetch(200, GRANT));
    const upload = await openIngestUpload(client, MINT_INPUT, mintFetch(200, {}));
    expect(upload.purpose).toBe('index');
    expect(upload.scopeId).toBe('gen_1');
    expect(upload.maxBatchBytes).toBe(GRANT.maxBytes);
    expect(upload.snapshot).toEqual({
      purpose: 'index',
      scopeId: 'gen_1',
      maxBytes: GRANT.maxBytes,
      expiresAt: GRANT.expiresAt,
      open: true,
    });
  });

  it.each([
    [503, 'disabled'],
    [404, 'not-found'],
    [403, 'forbidden'],
    [400, 'bad-request'],
    [500, 'http'],
  ] as const)('a %i mint failure maps to reason %s', async (status, reason) => {
    const client = makeClient(mintFetch(status, { error: 'x' }));
    await expect(openIngestUpload(client, MINT_INPUT)).rejects.toMatchObject({ reason, status });
  });

  it('a mint transport failure never reaches the caller as a bare/unwrapped error', async () => {
    const client = makeClient((async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch);
    await expect(openIngestUpload(client, MINT_INPUT)).rejects.toBeInstanceOf(IngestError);
  });
});

describe('IngestUpload — the five token-authorized calls', () => {
  it('authorizes with the token in the URL PATH alone — no Authorization header, no cookie', async () => {
    const client = makeClient(mintFetch(200, GRANT));
    const captured: Captured[] = [];
    const ingestFetch = fakeIngestFetch(() => new Response('{}', { status: 200 }), captured);
    const upload = await openIngestUpload(client, MINT_INPUT, ingestFetch);

    await upload.begin({
      branch: 'main',
      baseId: 'sha1',
      indexerVersion: '1',
      batchCount: 1,
      fileCount: 1,
      contentHash: 'h',
      createdAt: '2026-08-08T00:00:00.000Z',
    });
    await upload.status();

    expect(captured).toHaveLength(2);
    for (const c of captured) {
      expect(c.url).toContain(`/api/memory-ingest/${GRANT.token}/`);
      expect(c.headers.authorization).toBeUndefined();
      expect(c.headers.cookie).toBeUndefined();
    }
    expect(captured[0]?.url.endsWith('/begin')).toBe(true);
    expect(captured[0]?.method).toBe('POST');
    expect(captured[1]?.url.endsWith('/status')).toBe(true);
    expect(captured[1]?.method).toBe('GET');
  });

  it('begin sends the manifest fields verbatim as the JSON body (server overrides the other three)', async () => {
    const client = makeClient(mintFetch(200, GRANT));
    const captured: Captured[] = [];
    const ingestFetch = fakeIngestFetch(() => new Response('{"ok":true}', { status: 200 }), captured);
    const upload = await openIngestUpload(client, MINT_INPUT, ingestFetch);
    const manifest = {
      branch: 'main',
      baseId: 'sha-123',
      indexerVersion: '1.0.0',
      batchCount: 3,
      fileCount: 42,
      contentHash: 'deadbeef',
      deletions: ['old/file.ts'],
      createdAt: '2026-08-08T00:00:00.000Z',
    };
    await upload.begin(manifest);
    expect(JSON.parse(String(captured[0]?.rawBody))).toEqual(manifest);
  });

  it('the X-Batch-Hash header is the SHA-256 of EXACTLY the bytes PUT — never re-encoded', async () => {
    const client = makeClient(mintFetch(200, GRANT));
    const captured: Captured[] = [];
    const ingestFetch = fakeIngestFetch(
      () => new Response(JSON.stringify({ ok: true, deduped: false }), { status: 200 }),
      captured,
    );
    const upload = await openIngestUpload(client, MINT_INPUT, ingestFetch);
    const bytes = new TextEncoder().encode('stand-in for gzipped jsonl rows');
    const result = await upload.putBatch(2, bytes);
    expect(result).toEqual({ ok: true, deduped: false });

    const call = captured.find((c) => c.url.includes('/batch/2'));
    const expectedHash = createHash('sha256').update(bytes).digest('hex');
    expect(call?.headers['x-batch-hash']).toBe(expectedHash);
    // Same reference — the client never rebuilds, recompresses, or reserializes the payload.
    expect(call?.rawBody).toBe(bytes);
    expect(call?.method).toBe('PUT');
  });

  it('refuses a batch over the mint response maxBytes LOCALLY — no request is made', async () => {
    const client = makeClient(mintFetch(200, { ...GRANT, maxBytes: 10 }));
    const captured: Captured[] = [];
    const ingestFetch = fakeIngestFetch(() => new Response('{}', { status: 200 }), captured);
    const upload = await openIngestUpload(client, MINT_INPUT, ingestFetch);
    const oversized = new Uint8Array(11);
    await expect(upload.putBatch(0, oversized)).rejects.toMatchObject({ reason: 'too-large' });
    expect(captured).toHaveLength(0);
  });

  it('refuses a negative/non-integer batchNumber locally, before any request', async () => {
    const client = makeClient(mintFetch(200, GRANT));
    const captured: Captured[] = [];
    const ingestFetch = fakeIngestFetch(() => new Response('{}', { status: 200 }), captured);
    const upload = await openIngestUpload(client, MINT_INPUT, ingestFetch);
    await expect(upload.putBatch(-1, new Uint8Array(1))).rejects.toMatchObject({ reason: 'bad-request' });
    expect(captured).toHaveLength(0);
  });

  it.each([
    [401, 'invalid or expired ingest token', 'expired'],
    [401, 'ingest capability scope no longer exists', 'wrong-scope'],
    [503, 'ingest not enabled', 'disabled'],
    [400, 'batchNumber must be a non-negative integer', 'bad-request'],
    [404, 'no ingest in progress', 'not-found'],
    [409, 'generation gen_1 is already complete', 'conflict'],
    [413, 'batch exceeds 8388608 bytes', 'too-large'],
  ] as const)('classifies a %i ingest response (%s) as reason %s', async (status, message, reason) => {
    const client = makeClient(mintFetch(200, GRANT)); // remint (on a 401) always succeeds here
    const ingestFetch = (async () =>
      new Response(JSON.stringify({ error: message }), { status })) as typeof fetch;
    const upload = await openIngestUpload(client, MINT_INPUT, ingestFetch);
    await expect(upload.status()).rejects.toMatchObject({ reason, status });
  });

  it('re-mints automatically on a mid-upload 401 and retries the SAME call once', async () => {
    let mintCalls = 0;
    const mintFetchImpl = (async () => {
      mintCalls += 1;
      const grant = mintCalls === 1 ? GRANT : { ...GRANT, token: 'ing_tok_fresh789' };
      return new Response(JSON.stringify(grant), { status: 200 });
    }) as typeof fetch;
    const client = makeClient(mintFetchImpl);

    const captured: Captured[] = [];
    let batchCalls = 0;
    const ingestFetch = fakeIngestFetch((url) => {
      if (url.includes('/batch/')) {
        batchCalls += 1;
        if (batchCalls === 1) {
          return new Response(JSON.stringify({ error: 'invalid or expired ingest token' }), { status: 401 });
        }
        return new Response(JSON.stringify({ ok: true, deduped: false }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }, captured);

    const upload = await openIngestUpload(client, MINT_INPUT, ingestFetch);
    const bytes = new TextEncoder().encode('payload');
    const result = await upload.putBatch(0, bytes);

    expect(result).toEqual({ ok: true, deduped: false });
    expect(mintCalls).toBe(2); // the initial mint + one re-mint
    expect(batchCalls).toBe(2); // the 401'd attempt + the retry
    expect(captured[0]?.url).toContain(GRANT.token);
    expect(captured[1]?.url).toContain('ing_tok_fresh789');
  });

  it('drops the held token after complete() — a later call refuses locally, never re-touches the network', async () => {
    const client = makeClient(mintFetch(200, GRANT));
    const captured: Captured[] = [];
    const ingestFetch = fakeIngestFetch(
      () =>
        new Response(
          JSON.stringify({ ok: true, batchesReceived: 1, validation: { ok: true, problems: [] } }),
          { status: 200 },
        ),
      captured,
    );
    const upload = await openIngestUpload(client, MINT_INPUT, ingestFetch);
    await upload.complete();
    expect(upload.snapshot.open).toBe(false);
    captured.length = 0;
    await expect(upload.status()).rejects.toMatchObject({ reason: 'bad-request' });
    expect(captured).toHaveLength(0);
  });

  it('drops the held token after abort() the same way', async () => {
    const client = makeClient(mintFetch(200, GRANT));
    const ingestFetch = fakeIngestFetch(
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      [],
    );
    const upload = await openIngestUpload(client, MINT_INPUT, ingestFetch);
    await upload.abort();
    expect(upload.snapshot.open).toBe(false);
  });

  // This task's own acceptance: driven through a FAILING transport, scan every string the client
  // surfaces for the token. The transport below deliberately mimics a real fetch implementation
  // that echoes the request URL (which carries the token in its path) into its own error message.
  it('never leaks the token — driven through a failing transport, scanning the thrown error', async () => {
    const client = makeClient(mintFetch(200, GRANT));
    const failingFetch = (async (url: string | URL) => {
      throw new Error(`fetch failed: connect ECONNREFUSED ${String(url)}`);
    }) as typeof fetch;
    const upload = await openIngestUpload(client, MINT_INPUT, failingFetch);

    let caught: unknown;
    try {
      await upload.status();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IngestError);
    const err = caught as Error;
    const emitted = [err.message, err.toString(), err.stack ?? ''].join('\n');
    expect(emitted).not.toContain(GRANT.token);
  });

  it('never leaks the token in the error thrown for a non-2xx ingest response either', async () => {
    const client = makeClient(mintFetch(200, GRANT));
    // Body text large enough to be truncated — the token must not survive even inside the slice.
    const ingestFetch = (async (url: string | URL) =>
      new Response(JSON.stringify({ error: `refused for ${String(url)}` }), { status: 409 })) as typeof fetch;
    const upload = await openIngestUpload(client, MINT_INPUT, ingestFetch);
    let caught: unknown;
    try {
      await upload.status();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IngestError);
    expect((caught as Error).message).not.toContain(GRANT.token);
  });

  it('putBatch calls are independent — no ordering is enforced client-side (server dedupes by batchNumber)', async () => {
    const client = makeClient(mintFetch(200, GRANT));
    const seen: number[] = [];
    const ingestFetch = fakeIngestFetch((url) => {
      const m = /\/batch\/(\d+)/.exec(url);
      if (m?.[1]) seen.push(Number(m[1]));
      return new Response(JSON.stringify({ ok: true, deduped: false }), { status: 200 });
    }, []);
    const upload = await openIngestUpload(client, MINT_INPUT, ingestFetch);
    // Deliberately out of order and concurrent.
    await Promise.all([
      upload.putBatch(2, new Uint8Array([1])),
      upload.putBatch(0, new Uint8Array([2])),
      upload.putBatch(1, new Uint8Array([3])),
    ]);
    expect(seen.sort()).toEqual([0, 1, 2]);
  });
});
