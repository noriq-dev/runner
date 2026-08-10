import type { IndexGenerationManifest } from '@noriq-dev/shared';
import type { MintIngestCapabilityInput, NoriqClient } from './client';
import type { EncodedBatch } from './index-batch';
import type { IndexJournal, IndexJournalKey } from './index-journal';
import type { StagingStore } from './index-stage';
import {
  type IngestCompleteIndexResult,
  IngestError,
  type IngestFailureReason,
  type IngestUpload,
  openIngestUpload,
} from './ingest-client';
import { logger as defaultLogger } from './logger';

/**
 * The upload phase (RUN-221) — a PHASE of the coordinator's existing job (locked decision 9), not
 * a second scheduler: this module owns no lease, no trigger, and no lifecycle of its own. It takes
 * an already-computed `IndexerResult` slice (`manifest` + `batches`, RUN-215's output — locked
 * decision 12: nothing here re-reads, re-hashes, or re-walks the repository) and drives it through
 * begin → batch* → complete, resumably, against the journal and staging seams RUN-214/this task
 * define. A future `IndexWorkStep` (RUN-222) calls `runIndexer` for the scan/encode half, then
 * this module for the upload half, passing a `release` closure over `vcs.releaseIndexSnapshot` —
 * this module never touches `VcsBackend` itself, so `IndexWorkContext`'s shape needed no change to
 * host it.
 *
 * **Order, precisely** (locked decision 6, the acceptance line it exists to satisfy):
 *   1. Write an initial journal entry (0 confirmed) — so the staging sweep sees this generation as
 *      LIVE from this function's very first instant, before a single byte is staged.
 *   2. If the batch set fits under `maxStagedBytes`: write every batch to `StagingStore`, THEN call
 *      `release()` — the snapshot lease is gone before the first network call. Over the ceiling:
 *      stream straight from the in-memory `batches` this attempt already holds, and never call
 *      `release()` at all — the caller's own cleanup (the coordinator's `finally`) releases it once
 *      this function returns, exactly as it always has.
 *   3. `status()` FIRST (locked decision 2) — the server is asked before a single batch is (re)sent.
 *      `complete` short-circuits to local cleanup; `unknown`/`aborted` call `begin()`; every case
 *      then uploads from `status.batchesReceived` onward.
 *   4. `complete()`, gated on `validation.ok` (locked decision 4) — never a local record of done
 *      without it.
 *
 * **Progress is a HIGH-WATER MARK, not a per-batch set** (discretion 4): batches are uploaded
 * SEQUENTIALLY, in batch-number order, one call at a time — deliberately, because that is what
 * makes `IngestStatusResult.batchesReceived` (a bare COUNT; the server names no batch numbers)
 * exact rather than merely a hint. A per-batch set would have to answer "which specific numbers
 * does a count of 3 mean were received" with no server data to ground it; a high-water mark asks
 * that question in the one shape sequential sending already answers for free. The local journal
 * value is written for visibility, for the staging sweep's liveness signal, and for completion
 * bookkeeping — it is never READ back to decide what to (re)send (see the module doc's own
 * reasoning below on why the server, not this file, stays the one source that vote counts).
 *
 * **The journal is consulted for nothing but the sweep and human visibility.** Locked decision 2
 * says resume asks the server FIRST and uses the journal only to avoid re-sending bytes it can
 * PROVE the server already has — `status()` already proves exactly that, more authoritatively than
 * any local record could (a local claim can be stale in either direction; the server's own count
 * cannot lie about what the server holds). So this module never calls `journal.get()`: trusting a
 * local claim over a fresh server answer would be the exact shortcut locked decision 1 warns
 * against, one layer over. A corrupt, missing, or mismatched journal therefore cannot skew a
 * resume decision by construction, not merely by care — there is no code path that reads one.
 *
 * **Every failure LEAVES state for the next attempt** (discretion 5) — the journal entry and any
 * staged bytes are cleared ONLY on a validated `complete()`. A terminal `IngestError`, a validation
 * failure, a retry ceiling, or a cancellation all return a typed failure and touch nothing else:
 * the next coordinator trigger re-derives the identical generation (RUN-215's own determinism) and
 * `status()` picks up wherever the server actually got to. Inventing a second "give up forever"
 * local record would duplicate what the coordinator's own re-trigger cadence already provides.
 */

/** How this attempt is tracked, for a human reading the journal file and for the staging sweep's
 *  liveness signal — never read back to drive a decision (see this module's doc). */
export interface UploadProgress {
  /** How many of `batchCount` batches this attempt has itself confirmed the server holds — see
   *  the module doc on why a high-water mark, not a per-batch set. */
  batchesConfirmed: number;
  batchCount: number;
  /** Whether this generation's bytes were durably staged under `~/.noriq/` (vs. streamed straight
   *  from memory because the batch set was over `maxStagedBytes`). */
  staged: boolean;
}

export type UploadOutcome =
  | { ok: true; batchesReceived: number }
  | { ok: false; reason: 'validation'; problems: string[] }
  | { ok: false; reason: IngestFailureReason; detail: string }
  | { ok: false; reason: 'cancelled' };

export interface UploadGenerationInput {
  key: IndexJournalKey;
  /** `MintIngestCapabilityInput` minus `purpose`/`scopeId` — this module supplies both itself
   *  (`IngestUpload`'s own doc, locked decision 7: one purpose, one scopeId, minted here, never
   *  reused across generations). `scopeId` is always `manifest.generationId`. */
  mint: Omit<MintIngestCapabilityInput, 'purpose' | 'scopeId'>;
  manifest: IndexGenerationManifest;
  /** RUN-215's `IndexerResult.batches` — already sorted, hashed, and gzip-encoded. This module
   *  never re-derives any of that (locked decision 12). */
  batches: readonly EncodedBatch[];
}

export interface UploadGenerationDeps {
  client: NoriqClient;
  journal: IndexJournal;
  staging: StagingStore;
  /** Release the VCS snapshot lease. IDEMPOTENT — `VcsBackend.releaseIndexSnapshot`'s own
   *  contract — called once, early, when the batch set fits under `maxStagedBytes`; never called
   *  otherwise, leaving the caller's own cleanup to release it once this function returns. */
  release: () => Promise<void>;
  /** RUN-223's `server-validating` phase hook — called exactly once, right before `complete()`,
   *  the one call that actually asks the server to validate this generation. Optional so every
   *  existing caller (and every test) is unaffected; never called for a resume that finds the
   *  server already reports `status: 'complete'` (there is nothing left to validate). */
  onServerValidating?: () => void;
  signal: AbortSignal;
  /** The token-authorized ingest calls' own transport — defaults to global `fetch`, injectable
   *  for tests exactly like `openIngestUpload`'s own third parameter. */
  fetchImpl?: typeof fetch;
  logger?: typeof defaultLogger;
  /** Bytes above which this attempt streams from memory and keeps the snapshot instead of
   *  staging to disk and releasing early (locked decision 6, discretion 3's default). */
  maxStagedBytes?: number;
  /** `ws-client.ts`'s own backoff shape, reused rather than reinvented (discretion 1): a
   *  retryable failure waits `min(retryBaseMs * 2^attempt, retryMaxMs)` before the next try, up
   *  to `maxRetryAttempts`. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxRetryAttempts?: number;
}

/** RUN-219 measured this repo's own root (103k entities) at 18 batches, well under the 8 MiB cap
 *  per batch in practice — "large but ordinary", per this task's own discretion note. 128 MiB
 *  gives several times that ordinary shape's headroom while still refusing an outlier monorepo
 *  that would otherwise hold a pool-of-1 lease for an unreasonable multiple of local disk I/O. */
export const DEFAULT_MAX_STAGED_BYTES = 128 * 1024 * 1024;

const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 30_000;
const DEFAULT_MAX_RETRY_ATTEMPTS = 5;

/**
 * `IngestFailureReason`s worth a backoff retry (locked decision 5, this module's own reading of
 * it): `http`/`transport` are the generic transient remainder; `expired`/`wrong-scope` are folded
 * in too, not because this module re-derives their policy (`IngestUpload` already re-mints and
 * retries once internally — locked decision 5 says not to re-derive that), but because a retry
 * here simply calls the SAME `IngestUpload` method again, which re-enters that same internal path
 * on its own next 401. This module adds no separate re-mint logic of its own.
 *
 * Deliberately EXCLUDED: `disabled` (permanent — stops rather than retrying to a ceiling),
 * `too-large` (a local refusal that never touched the network — retrying it wastes a slot and
 * proves nothing), and `bad-request`/`conflict`/`forbidden`/`not-found` (terminal for the
 * attempt, locked decision 5's own vocabulary).
 */
/** RUN-234 locked decision 2: a server validation rejection names one problem per bad entity in
 *  the generation, which scales with the REPOSITORY, not with this event — logging the whole
 *  array would be a per-entity dump wearing a log line's clothes. A capped, truncated sample
 *  plus the real count is a diagnosis (what kind of thing failed) without being a listing. */
export const MAX_LOGGED_VALIDATION_PROBLEMS = 5;

/** Bound one problem string's own length the same way `IngestError`'s message already bounds a
 *  response body (`ingest-client.ts`'s 300-char slice) — a single server-authored string is not
 *  the unbounded-cardinality case decision 2 is about, but nothing here guarantees it is short. */
const MAX_PROBLEM_CHARS = 200;

/** The bounded projection of `completed.validation.problems` this module logs — never the raw
 *  array. Exported so `index-work.ts`'s own thrown-error message (the ONLY other place these
 *  strings can reach a log line, via `index-coordinator.ts`'s catch-all) can bound identically
 *  rather than re-deriving the same cap with a different number. */
export function boundedValidationProblems(problems: readonly string[]): {
  count: number;
  sample: string[];
} {
  return {
    count: problems.length,
    sample: problems.slice(0, MAX_LOGGED_VALIDATION_PROBLEMS).map((p) => p.slice(0, MAX_PROBLEM_CHARS)),
  };
}

export const RETRYABLE_REASONS: ReadonlySet<IngestFailureReason> = new Set([
  'http',
  'transport',
  'expired',
  'wrong-scope',
]);

/** A sentinel converted to `{ok:false, reason:'cancelled'}` by whichever module's own catch sees
 *  it, rather than letting a caller see a bare thrown error for what is, on this path, an entirely
 *  routine outcome (the coordinator's `cancelAll`, RUN-165's shape). Exported (RUN-227) so
 *  `episode-upload.ts` — the identical begin/batch/complete shape over a different purpose, this
 *  module's own doc comment directs it to follow — shares this instead of a second class no
 *  `instanceof` check could ever tell apart from this one. */
export class UploadCancelled extends Error {}

export function ensureNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new UploadCancelled();
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface RetryCtx {
  signal: AbortSignal;
  baseMs: number;
  maxMs: number;
  maxAttempts: number;
}

/** Retry a single ingest call with `ws-client.ts`'s own backoff shape, only for the reasons
 *  `RETRYABLE_REASONS` names — everything else (a terminal `IngestError`, or any non-`IngestError`
 *  thrown, which this module has no business interpreting) is rethrown on the first attempt.
 *  Exported (RUN-227) for `episode-upload.ts` to share — see `UploadCancelled`'s doc on why a
 *  second copy of this would be a second answer to "how does a retry back off". */
export async function withRetry<T>(step: () => Promise<T>, ctx: RetryCtx): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    ensureNotCancelled(ctx.signal);
    try {
      return await step();
    } catch (err) {
      if (!(err instanceof IngestError) || !RETRYABLE_REASONS.has(err.reason) || attempt >= ctx.maxAttempts) {
        throw err;
      }
      const delay = Math.min(ctx.baseMs * 2 ** attempt, ctx.maxMs);
      await sleep(delay, ctx.signal);
    }
  }
}

function beginInputFrom(manifest: IndexGenerationManifest) {
  return {
    branch: manifest.branch,
    baseId: manifest.baseId,
    indexerVersion: manifest.indexerVersion,
    batchCount: manifest.batchCount,
    fileCount: manifest.fileCount,
    contentHash: manifest.contentHash,
    deletions: manifest.deletions,
    createdAt: manifest.createdAt,
  };
}

/** Upload one generation, resumably. See this module's doc for the full order and the reasoning
 *  behind every discretion call. Never throws for an ordinary failure mode — every `IngestError`
 *  and cancellation come back as a typed `UploadOutcome`; only a genuinely unexpected error (not
 *  an `IngestError`, e.g. a `StagingStore`/`IndexJournal` implementation that itself throws
 *  outside its documented defensive contract) propagates, exactly like every other seam in this
 *  codebase that trusts its own dependencies to keep their own contracts. */
export async function uploadGeneration(
  input: UploadGenerationInput,
  deps: UploadGenerationDeps,
): Promise<UploadOutcome> {
  const log = deps.logger ?? defaultLogger;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const maxStagedBytes = deps.maxStagedBytes ?? DEFAULT_MAX_STAGED_BYTES;
  const retry: RetryCtx = {
    signal: deps.signal,
    baseMs: deps.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
    maxMs: deps.retryMaxMs ?? DEFAULT_RETRY_MAX_MS,
    maxAttempts: deps.maxRetryAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS,
  };
  const { key, manifest, batches } = input;
  const ordered = [...batches].sort((a, b) => a.batchNumber - b.batchNumber);

  try {
    ensureNotCancelled(deps.signal);

    const totalBytes = batches.reduce((n, b) => n + b.compressed.byteLength, 0);
    const underCeiling = totalBytes <= maxStagedBytes;

    // Step 1: a live journal entry BEFORE anything else, so the startup sweep never mistakes this
    // generation's staging directory (if any) for an orphan mid-attempt.
    await deps.journal.put(key, {
      batchesConfirmed: 0,
      batchCount: ordered.length,
      staged: underCeiling,
    } satisfies UploadProgress);

    if (underCeiling) {
      for (const batch of ordered) {
        ensureNotCancelled(deps.signal);
        await deps.staging.writeBatch(key, batch.batchNumber, batch.compressed);
      }
      // The acceptance line this whole branch exists for: the snapshot is gone before the first
      // network call below.
      await deps.release();
    }
    // Over the ceiling: no staging, no early release — `deps.release` is never called here, and
    // the caller's own cleanup releases the snapshot once this function returns (locked decision
    // 6's "keep the snapshot and stream").

    const upload: IngestUpload = await openIngestUpload(
      deps.client,
      { ...input.mint, purpose: 'index', scopeId: manifest.generationId },
      fetchImpl,
    );

    const status = await withRetry(() => upload.status(), retry);

    if (status.status === 'complete') {
      // Resume found the server already finished this generation (a crash between `complete()`
      // succeeding and local cleanup running) — nothing to send, just clean up locally.
      await deps.journal.forget(key);
      await deps.staging.clear(key);
      return { ok: true, batchesReceived: status.batchesReceived };
    }

    if (
      status.batchesExpected !== null &&
      status.batchesExpected !== ordered.length &&
      status.status !== 'unknown'
    ) {
      // Informational only — this SHOULD be unreachable given `generationId` is a pure function
      // of content (a re-derived generation always re-encodes the same batch count), but this is
      // not this module's floor to enforce; it is worth a log line if it is ever wrong.
      log.warn('index upload: server batch count disagrees with this attempt’s own encoding', {
        repositoryKey: key.repositoryKey,
        generationId: key.generationId,
        serverExpected: status.batchesExpected,
        thisAttempt: ordered.length,
      });
    }

    if (status.status === 'unknown' || status.status === 'aborted') {
      // ASSUMPTION (no live ingest endpoint to verify against — see this task's report): an
      // `aborted` generation accepts a fresh `begin()` the same as one never begun. If that is
      // wrong, the server's own `begin` route refuses with a named reason (`conflict` most
      // likely), which this function already surfaces rather than silently reinterpreting.
      await withRetry(() => upload.begin(beginInputFrom(manifest)), retry);
    }

    let confirmed = Math.min(
      status.status === 'unknown' || status.status === 'aborted' ? 0 : status.batchesReceived,
      ordered.length,
    );

    // RUN-234: the ONE place this daemon can say "this attempt is picking up where a prior one
    // left off" — a fact the server's own `status()` just proved, not a guess (`confirmed` above
    // already reflects it). Only when there is something to resume FROM: a fresh attempt with
    // nothing confirmed yet is the ordinary case and would make this line noise on every upload.
    if (confirmed > 0) {
      log.info('index upload resuming a prior attempt', {
        repositoryKey: key.repositoryKey,
        generationId: key.generationId,
        batchesConfirmed: confirmed,
        batchCount: ordered.length,
      });
    }

    for (const batch of ordered) {
      if (batch.batchNumber < confirmed) continue; // the server already has it (locked decision 2/3)
      ensureNotCancelled(deps.signal);
      await withRetry(() => upload.putBatch(batch.batchNumber, batch.compressed), retry);
      confirmed = batch.batchNumber + 1;
      await deps.journal.put(key, {
        batchesConfirmed: confirmed,
        batchCount: ordered.length,
        staged: underCeiling,
      } satisfies UploadProgress);
    }

    ensureNotCancelled(deps.signal);
    deps.onServerValidating?.();
    const completed = (await withRetry(() => upload.complete(), retry)) as IngestCompleteIndexResult;

    if (!completed.validation.ok) {
      // Locked decision 4: never a local record of done without server validation. Left for the
      // next attempt (discretion 5) — the journal and any staged bytes are untouched.
      log.warn('index upload: server rejected validation at complete()', {
        repositoryKey: key.repositoryKey,
        generationId: key.generationId,
        ...boundedValidationProblems(completed.validation.problems),
      });
      return { ok: false, reason: 'validation', problems: completed.validation.problems };
    }

    await deps.journal.forget(key);
    await deps.staging.clear(key);
    return { ok: true, batchesReceived: completed.batchesReceived };
  } catch (err) {
    if (err instanceof UploadCancelled) return { ok: false, reason: 'cancelled' };
    if (err instanceof IngestError) return { ok: false, reason: err.reason, detail: err.message };
    throw err;
  }
}
