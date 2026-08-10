import { createHash } from 'node:crypto';
import {
  type IngestCapabilityGrant,
  type MintIngestCapabilityInput,
  type NoriqClient,
  NoriqHttpError,
} from './client';
import type { IndexGenerationManifest } from './memory-contract';

// RUN-220: the authenticated ingest client — begin/batch/complete/abort/status against the five
// TOKEN-authorized `/api/memory-ingest/:token/*` routes PLNR-260 landed (measured from
// apps/api/src/index.ts:3241-3330 and apps/api/src/memory/ingest.ts, not invented — locked
// decision 1). RunnerHub carries none of this: the server added no bulk WS frame either (locked
// decision 8), so this module is HTTP-only by construction — it has no socket to reach for.
//
// The capability token is a bearer credential for writing one project's memory (locked decision
// 2) and it sits IN THE URL PATH, not a header — every place this file could log or report a
// request, it reports the ACTION name and the response body, never the URL or the token itself.
// `redactToken` exists as defense in depth for the one path that isn't fully under this file's
// control: whatever a failing `fetchImpl` throws (a transport error's own message can legitimately
// contain the URL it was trying to reach).
//
// No R2 / server-directed upload exists today (locked decision 9, checked against the landed
// route bodies): `PUT /api/memory-ingest/:token/batch/:n` reads the request body directly with
// `readBoundedBody` and never returns a redirect or a second URL. `IngestUpload.putBatch` is the
// seam a server-directed flow would extend — it already isolates "how do these bytes get to the
// server" behind one method — but there is nothing to redirect to yet, so it isn't built.

/** Mirrors the server's own two-purpose vocabulary (PLNR-260 §8, `IngestClaims.purpose`). */
export type IngestPurpose = 'index' | 'episode';

/**
 * The `begin` body for `purpose: 'index'` — every `IndexGenerationManifest` field EXCEPT the
 * three the server overrides from the token's own claims, not the request body
 * (`apps/api/src/index.ts`'s begin route: `{...body, generationId: claims.scopeId, projectId:
 * claims.pid, repositoryKey: claims.repositoryKey}`). Sending those three would simply be
 * overwritten, so the type omits them rather than let a caller believe they travel.
 */
export type BeginIndexIngestInput = Omit<
  IndexGenerationManifest,
  'generationId' | 'projectId' | 'repositoryKey'
>;

/**
 * The `begin` body for `purpose: 'episode'`. `EpisodeUploadManifest` is deliberately NOT vendored
 * (apps/api/src/memory/ingest.ts's own comment: "a server-internal wire convention... not yet a
 * contract anything vendors") — Phase 5 owns real episode payloads (deferred, this task's own
 * scope note); this only lets the client express the shape the `begin` route already accepts.
 */
export interface BeginEpisodeIngestInput {
  batchCount: number;
}

export interface IngestBatchResult {
  ok: true;
  deduped: boolean;
}

export interface IngestCompleteIndexResult {
  ok: true;
  batchesReceived: number;
  validation: { ok: boolean; problems: string[] };
}

export interface IngestCompleteEpisodeResult {
  ok: true;
  batchesReceived: number;
  rowCount: number;
  /**
   * RUN-227's own load-bearing check (measured against `ProjectMemory.completeEpisodeIngest`,
   * `apps/api/src/do/ProjectMemory.ts`, not invented): every accumulated row is parsed and either
   * RECORDED or SKIPPED (a malformed row, a run unknown in this project, or — the case that will
   * actually happen — a run with no terminal `exit` row yet, RUN-227 locked decision 5's race).
   * The HTTP call succeeds either way, so `recorded`/`skipped` are the only honest signal: a caller
   * that reads `ok`/`batchesReceived` alone reports a delivered episode the server silently threw
   * away. Absent from this interface until RUN-227 — the server has returned both fields since
   * PLNR-263 landed; nothing here READ them, which is exactly the gap this comment closes.
   */
  recorded: number;
  skipped: number;
}

export interface IngestStatusResult {
  status: 'unknown' | 'pending' | 'complete' | 'aborted';
  batchesReceived: number;
  batchesExpected: number | null;
}

/**
 * Every distinguishable failure mode this client's callers can branch on (this task's own
 * acceptance: "each produce a DISTINCT outcome the caller can branch on") — RUN-221's retry logic
 * needs exactly this granularity (locked decision 5): `disabled` is permanent (503 — this server
 * has no ingest at all), `expired`/`wrong-scope` call for a re-mint, `too-large` is a LOCAL refusal
 * that never touched the network, and `transport`/`http` are the generic remainder a caller may
 * retry with backoff. Named only for what the landed server actually distinguishes (measured, not
 * invented) — see `classifyIngestFailure`/`classifyMintFailure` for the exact mapping.
 */
export type IngestFailureReason =
  | 'expired'
  | 'wrong-scope'
  | 'disabled'
  | 'not-found'
  | 'forbidden'
  | 'bad-request'
  | 'conflict'
  | 'too-large'
  | 'http'
  | 'transport';

/** Every error this module raises, mint or upload alike — one shape so a caller checks `.reason`/
 *  `.status` without caring which of the six calls produced it. `.message` is ALWAYS token-free
 *  (locked decision 2); see `redactToken`. */
export class IngestError extends Error {
  constructor(
    readonly reason: IngestFailureReason,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'IngestError';
  }
}

/** Replace every occurrence of `token` in `text` — defense in depth for whatever a failing
 *  `fetchImpl` throws (its own message may legitimately quote the URL it tried to reach, and the
 *  token rides that URL's path). Never a no-op guard on an empty token: an empty string is not a
 *  live capability, so there is nothing sensitive left to protect at that point anyway. */
function redactToken(text: string, token: string): string {
  return token.length > 0 ? text.split(token).join('<ingest-token>') : text;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Map an ingest-route failure (the five `/api/memory-ingest/:token/*` calls) to a reason —
 *  `requireIngestCap` (apps/api/src/index.ts) produces exactly two 401 messages, so the text is
 *  the only thing that tells "expired" and "wrong-scope" apart; every other status maps on the
 *  status code alone. */
function classifyIngestFailure(status: number, bodyText: string): IngestFailureReason {
  if (status === 401) return /scope no longer exists/i.test(bodyText) ? 'wrong-scope' : 'expired';
  if (status === 503) return 'disabled';
  if (status === 400) return 'bad-request';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 413) return 'too-large';
  return 'http';
}

/** Map a `POST /api/runner-ingest/capability` mint failure to the same reason vocabulary. */
function classifyMintFailure(status: number): IngestFailureReason {
  if (status === 503) return 'disabled';
  if (status === 404) return 'not-found';
  if (status === 403) return 'forbidden';
  if (status === 400) return 'bad-request';
  return 'http';
}

/** SHA-256 of exactly these bytes, hex-encoded — the value `X-Batch-Hash` carries and the server
 *  verifies BEFORE decompressing (locked decision 3). Never re-derive this from anything other
 *  than the literal bytes about to be PUT: a second encoding here is a second chance to disagree
 *  with what actually goes over the wire. */
function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A minted capability bound to exactly one (purpose, scopeId), driving the begin → batch* →
 * complete/abort lifecycle and, optionally, `status`. A class rather than a bare function
 * (this task's own discretion note): every method closes over the ONE token/generation this
 * instance was minted for, so "which upload does this batch belong to" cannot be gotten wrong by
 * passing the wrong token to the wrong call.
 *
 * Re-mint on expiry is AUTOMATIC and transparent (discretion: the 15-minute TTL is real and a
 * large repository's upload can plausibly outlive it) — `send()` re-mints against the identical
 * `MintIngestCapabilityInput` on a 401 and retries the SAME call once. Re-minting is safe mid-
 * upload because server-side state (`index_generations`/`index_batches`) is keyed by `scopeId`,
 * never by the token itself — a fresh token for the same scope resumes the same generation.
 *
 * Concurrency and ordering are deliberately NOT this class's job: `ingestIndexBatch`
 * (apps/api/src/do/ProjectMemory.ts) keys every batch by `(generationId, batchNumber)`, dedupes
 * on that key, and has no ordering precondition — batches may arrive in any order or overlap in
 * flight, so `putBatch` calls are safe to issue concurrently (e.g. `Promise.all`), and this class
 * runs none of them for the caller. RUN-221 owns the upload journal and crash-safe resume; the
 * only retry this class performs itself is the expiry re-mint above — everything else (backoff on
 * a transient 5xx, deciding how many batches to have in flight) is that seam's job, not this one's.
 */
export class IngestUpload {
  private token: string;
  private maxBytes: number;
  private expiresAt: string;

  constructor(
    private readonly client: NoriqClient,
    private readonly grantInput: MintIngestCapabilityInput,
    grant: IngestCapabilityGrant,
    private readonly fetchImpl: typeof fetch,
  ) {
    this.token = grant.token;
    this.maxBytes = grant.maxBytes;
    this.expiresAt = grant.expiresAt;
  }

  get purpose(): IngestPurpose {
    return this.grantInput.purpose;
  }

  get scopeId(): string {
    return this.grantInput.scopeId;
  }

  /** The server's own clamp for a SINGLE batch (locked decision 4) — `putBatch` refuses locally
   *  against this number; it is never a constant copied out of the server's source here. */
  get maxBatchBytes(): number {
    return this.maxBytes;
  }

  /** A TOKEN-FREE snapshot for a caller (RUN-221's journal, most likely) that wants to record this
   *  session's shape without ever persisting the bearer token itself (locked decision 2: "never
   *  written to disk"). `open` is false once `complete`/`abort`/`discard` has run. */
  get snapshot(): {
    purpose: IngestPurpose;
    scopeId: string;
    maxBytes: number;
    expiresAt: string;
    open: boolean;
  } {
    return {
      purpose: this.grantInput.purpose,
      scopeId: this.grantInput.scopeId,
      maxBytes: this.maxBytes,
      expiresAt: this.expiresAt,
      open: this.token.length > 0,
    };
  }

  /** Drop the held token without calling the server — for a caller that hit a local,
   *  unrecoverable failure (e.g. `putBatch`'s own size refusal, below) and wants this instance to
   *  stop being usable rather than silently retaining a live credential past the point anything
   *  still needs it. `complete()`/`abort()` call this themselves on success. */
  discard(): void {
    this.token = '';
  }

  private async remint(): Promise<void> {
    let grant: IngestCapabilityGrant;
    try {
      grant = await this.client.mintIngestCapability(this.grantInput);
    } catch (err) {
      if (err instanceof NoriqHttpError) {
        throw new IngestError(classifyMintFailure(err.status), err.message, err.status);
      }
      throw new IngestError('transport', `ingest capability re-mint failed: ${messageOf(err)}`);
    }
    this.token = grant.token;
    this.maxBytes = grant.maxBytes;
    this.expiresAt = grant.expiresAt;
  }

  private async send(
    action: string,
    pathSuffix: string,
    method: string,
    init: { headers?: Record<string, string>; body?: RequestInit['body'] } = {},
    retried = false,
  ): Promise<unknown> {
    if (!this.token) {
      throw new IngestError('bad-request', `ingest session already closed — cannot ${action}`);
    }
    const url = `${this.client.baseUrl}/api/memory-ingest/${this.token}${pathSuffix}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers: init.headers, body: init.body });
    } catch (err) {
      throw new IngestError(
        'transport',
        `ingest ${action} transport failure: ${redactToken(messageOf(err), this.token)}`,
      );
    }
    const text = await res.text();
    // The TTL is 15 minutes and a large upload can outlive it (discretion: automatic mid-upload
    // re-mint) — one re-mint against the SAME (purpose, scopeId), one retry of THIS call, never a
    // loop: a token still invalid after a fresh mint is a real failure, not a transient one.
    if (res.status === 401 && !retried) {
      await this.remint();
      return this.send(action, pathSuffix, method, init, true);
    }
    if (!res.ok) {
      const reason = classifyIngestFailure(res.status, text);
      throw new IngestError(
        reason,
        `ingest ${action} → ${res.status}: ${redactToken(text.slice(0, 300), this.token)}`,
        res.status,
      );
    }
    return text ? JSON.parse(text) : {};
  }

  /** `POST .../begin`. For `purpose: 'index'`, `manifest` is every `IndexGenerationManifest`
   *  field but the three the token's own claims supply; for `purpose: 'episode'`, just the batch
   *  count. */
  async begin(manifest: BeginIndexIngestInput | BeginEpisodeIngestInput): Promise<void> {
    await this.send('begin', '/begin', 'POST', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
  }

  /**
   * `PUT .../batch/:batchNumber` — `bytes` MUST already be the exact gzipped payload (locked
   * decision 3: never re-hash, re-compress, or re-serialize what RUN-215 hands over). Refuses
   * locally, before any request, when `bytes` exceeds `maxBatchBytes` (locked decision 4) — the
   * server's own `readBoundedBody` would throw at the same ceiling, but only after the whole
   * transfer had already spent itself finding that out.
   */
  async putBatch(batchNumber: number, bytes: Uint8Array): Promise<IngestBatchResult> {
    if (!Number.isInteger(batchNumber) || batchNumber < 0) {
      throw new IngestError('bad-request', `batchNumber must be a non-negative integer, got ${batchNumber}`);
    }
    if (bytes.byteLength > this.maxBytes) {
      throw new IngestError(
        'too-large',
        `batch is ${bytes.byteLength} bytes, exceeds this capability's ${this.maxBytes}-byte ceiling`,
      );
    }
    const hash = sha256Hex(bytes);
    const result = await this.send('batch', `/batch/${batchNumber}`, 'PUT', {
      headers: { 'X-Batch-Hash': hash },
      body: bytes,
    });
    return result as IngestBatchResult;
  }

  /** `POST .../complete` — drops the held token on success (locked decision 2: it has no more
   *  uploads left to authorize). A failure leaves the session open: a caller may inspect
   *  `.reason`/`.status` and decide whether retrying `complete()` itself makes sense. */
  async complete(): Promise<IngestCompleteIndexResult | IngestCompleteEpisodeResult> {
    const result = await this.send('complete', '/complete', 'POST');
    this.discard();
    return result as IngestCompleteIndexResult | IngestCompleteEpisodeResult;
  }

  /** `POST .../abort` — drops the held token on success, same reasoning as `complete()`. */
  async abort(): Promise<{ ok: true }> {
    const result = await this.send('abort', '/abort', 'POST');
    this.discard();
    return result as { ok: true };
  }

  /** `GET .../status` — read-only; never touches `this.token`'s lifecycle. Left for a caller
   *  (RUN-221's journal, most likely) to poll for resumability; this class does not poll it
   *  itself (discretion: "left for RUN-221's journal to drive"). */
  async status(): Promise<IngestStatusResult> {
    return (await this.send('status', '/status', 'GET')) as IngestStatusResult;
  }
}

/**
 * Mint a capability under the daemon's own OAuth identity (`client`) and return the bound
 * uploader for it (locked decision 7: one purpose, one scopeId, minted here — never reused across
 * generations). The only entry point this module exposes for STARTING an upload; every other
 * capability lifecycle call hangs off the returned `IngestUpload`.
 */
export async function openIngestUpload(
  client: NoriqClient,
  input: MintIngestCapabilityInput,
  fetchImpl: typeof fetch = fetch,
): Promise<IngestUpload> {
  let grant: IngestCapabilityGrant;
  try {
    grant = await client.mintIngestCapability(input);
  } catch (err) {
    if (err instanceof NoriqHttpError) {
      throw new IngestError(classifyMintFailure(err.status), err.message, err.status);
    }
    throw new IngestError('transport', `ingest capability mint failed: ${messageOf(err)}`);
  }
  return new IngestUpload(client, input, grant, fetchImpl);
}
