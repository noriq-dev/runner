import type { EffortEpisode as EffortEpisodeType } from '@noriq-dev/shared';
import type { MintIngestCapabilityInput, NoriqClient } from './client';
import { deriveEpisodeScopeId } from './episode';
import type { EpisodePendingStore, PendingEpisode } from './episode-pending';
import { compressBatch } from './index-batch';
import { type RetryCtx, UploadCancelled, ensureNotCancelled, withRetry } from './index-upload';
import {
  type IngestCompleteEpisodeResult,
  IngestError,
  type IngestFailureReason,
  openIngestUpload,
} from './ingest-client';
import { logger as defaultLogger } from './logger';

/**
 * The episode delivery phase (RUN-227) — the SAME signed ingest protocol `index-upload.ts` already
 * speaks (locked decision 1), with `purpose: 'episode'` and a batch count fixed at 1: an episode is
 * one row, so `begin` → one `putBatch` → `complete` is the whole shape, never a resumable multi-
 * batch upload with its own journal (that machinery earns itself on a payload that can outgrow one
 * capability's TTL — an episode never will). `withRetry`/`UploadCancelled`/`ensureNotCancelled` are
 * imported rather than re-derived, for the same reason `index-upload.ts`'s own doc gives for not
 * re-deriving `IngestUpload`'s expiry re-mint: a second copy of "how does a retry back off" is a
 * second thing that can drift from the first.
 *
 * **`begin` failing because the scope is already complete is SUCCESS** (locked decision 3): the
 * server's `beginIngestEpisode` (`apps/api/src/memory/ingest.ts`) throws `"already {status} — this
 * purpose cannot be reopened"` for a scope whose ingest already reached `complete` — the runner's
 * OWN `begin` route wraps every such throw as HTTP 409, which `classifyIngestFailure` reads as
 * `IngestFailureReason: 'conflict'`. `already complete` (not `already aborted` — this module never
 * calls `abort`, so that state should never arise from this module's own retries) means a PRIOR
 * attempt got all the way through: exactly what a retry wanted. Resolved as delivered rather than
 * retried, or a scope that can never reopen would retry forever.
 *
 * **`complete()`'s response body is the real outcome, never the HTTP status alone** (locked
 * decision 4): `IngestCompleteEpisodeResult.recorded`/`.skipped` (widened onto that interface by
 * this task — see its own doc comment) are what `completeEpisodeIngest` actually decided per row.
 * `recorded < 1` is a FAILURE to record even though the HTTP call returned 200 — most likely the
 * race locked decision 5 names (the run's terminal `exit` row had not landed yet when this attempt
 * reached `complete`) — and this module returns a retryable outcome rather than reporting a
 * delivered episode the server silently threw away.
 */

export interface UploadEpisodeInput {
  scopeId: string;
  /** `MintIngestCapabilityInput` minus `purpose`/`scopeId` — this module supplies both itself,
   *  mirroring `UploadGenerationInput.mint`'s own doc. */
  mint: Omit<MintIngestCapabilityInput, 'purpose' | 'scopeId'>;
  /** The exact, already-assembled payload — never rebuilt here. Locked decision 8: a retry sends
   *  this SAME object, timestamps and all, so a later attempt cannot re-stamp what `settle` already
   *  recorded. */
  episode: EffortEpisodeType;
}

export interface UploadEpisodeDeps {
  client: NoriqClient;
  signal?: AbortSignal;
  /** The token-authorized ingest calls' own transport — defaults to global `fetch`, injectable for
   *  tests exactly like `index-upload.ts`'s identical field. */
  fetchImpl?: typeof fetch;
  logger?: typeof defaultLogger;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxRetryAttempts?: number;
}

export type UploadEpisodeOutcome =
  | { ok: true }
  | { ok: false; reason: 'skipped-server-side'; detail: string }
  | { ok: false; reason: IngestFailureReason; detail: string }
  | { ok: false; reason: 'cancelled' };

const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 30_000;
const DEFAULT_MAX_RETRY_ATTEMPTS = 5;

/** A conflict this module treats as delivered, never as a failure to retry — see this module's own
 *  doc on why `already complete` (not `already aborted`) is the only string this matches. */
function isAlreadyCompleteConflict(err: unknown): boolean {
  return err instanceof IngestError && err.reason === 'conflict' && /already complete/i.test(err.message);
}

/**
 * Upload one episode, resumably. Never throws for an ordinary failure mode — every `IngestError`
 * and cancellation come back as a typed `UploadEpisodeOutcome`, exactly like `uploadGeneration`'s
 * own contract. Idempotent by construction without needing a `status()` pre-check the way index
 * uploads do (discretion: an episode is one row): a retried `begin` either finds no prior state (a
 * fresh attempt) or an EXISTING `pending` state that accepts the identical `batchNumber: 0` again —
 * `applyIngestEpisodeBatch`'s own dedupe — or a `complete`d one, which resolves via the conflict
 * path above. No branch here needs to know which case it is in.
 */
export async function uploadEpisode(
  input: UploadEpisodeInput,
  deps: UploadEpisodeDeps,
): Promise<UploadEpisodeOutcome> {
  const log = deps.logger ?? defaultLogger;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const signal = deps.signal ?? new AbortController().signal;
  const retry: RetryCtx = {
    signal,
    baseMs: deps.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
    maxMs: deps.retryMaxMs ?? DEFAULT_RETRY_MAX_MS,
    maxAttempts: deps.maxRetryAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS,
  };
  try {
    ensureNotCancelled(signal);
    const upload = await openIngestUpload(
      deps.client,
      { ...input.mint, purpose: 'episode', scopeId: input.scopeId },
      fetchImpl,
    );
    try {
      await withRetry(() => upload.begin({ batchCount: 1 }), retry);
    } catch (err) {
      if (isAlreadyCompleteConflict(err)) {
        // Locked decision 3: a previous attempt already finished this exact scope. The token this
        // `begin` minted authorizes nothing further either way — `IngestUpload` never learns that;
        // it simply goes unused, same as any capability this module abandons on an early return.
        return { ok: true };
      }
      throw err;
    }
    const bytes = compressBatch(JSON.stringify(input.episode));
    await withRetry(() => upload.putBatch(0, bytes), retry);
    ensureNotCancelled(signal);
    const completed = (await withRetry(() => upload.complete(), retry)) as IngestCompleteEpisodeResult;
    if (completed.recorded < 1) {
      log.warn('episode upload: server recorded nothing this attempt', {
        scopeId: input.scopeId,
        runId: input.episode.runId,
        skipped: completed.skipped,
      });
      return {
        ok: false,
        reason: 'skipped-server-side',
        detail: `server skipped ${completed.skipped} row(s), recorded 0`,
      };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof UploadCancelled) return { ok: false, reason: 'cancelled' };
    if (err instanceof IngestError) return { ok: false, reason: err.reason, detail: err.message };
    throw err;
  }
}

export interface EpisodeDeliveryDeps extends UploadEpisodeDeps {
  /** This daemon's own registration id — captured into every `PendingEpisode.mint` at enqueue time
   *  (locked decision 8's identity half: a retry mints under the SAME runnerId this run actually
   *  ran under, from the persisted entry, never this call's current value). */
  runnerId: string;
  pending: Pick<EpisodePendingStore, 'put' | 'remove' | 'list'>;
}

/**
 * Hand one freshly assembled episode to delivery (the `StageHost.recordEpisode` sink, wired in
 * `daemon.ts`). Durability FIRST: the pending-queue write happens before the network attempt, so a
 * daemon that exits moments later — settle does not wait for either — has still persisted the one
 * copy of this sitting's episode that can ever exist (the worktree it was read from is reaped
 * shortly after). The upload attempt on top is best-effort; `drainPendingEpisodes` is what actually
 * guarantees delivery survives a failed first try.
 *
 * No repositoryKey, no attempt: `POST /api/runner-ingest/capability` 404s a repositoryKey this
 * project has not registered a canonical repository for (`apps/api/src/index.ts`'s own resolver),
 * and a repo with `repositoryKey: null` (indexing never configured, RUN-142's own precedent) would
 * fail that mint identically on every retry forever — a pending entry that can never succeed is
 * strictly worse than none, since it would occupy a bounded queue's slot until age alone evicted it.
 */
export async function deliverEpisode(episode: EffortEpisodeType, deps: EpisodeDeliveryDeps): Promise<void> {
  const log = deps.logger ?? defaultLogger;
  if (!episode.repositoryKey) {
    log.debug('episode has no repositoryKey — skipping delivery (no canonical repository to mint against)', {
      runId: episode.runId,
    });
    return;
  }
  const scopeId = deriveEpisodeScopeId({ runId: episode.runId, terminalAt: episode.createdAt });
  const mint = {
    projectId: episode.projectId,
    repositoryKey: episode.repositoryKey,
    runnerId: deps.runnerId,
  };
  const entry: PendingEpisode = { scopeId, episode, mint, enqueuedAt: new Date().toISOString() };
  await deps.pending.put(entry).catch((err) =>
    log.warn('episode enqueue failed — this sitting’s episode may not survive a restart', {
      runId: episode.runId,
      scopeId,
      err: String(err),
    }),
  );
  const outcome = await uploadEpisode({ scopeId, mint, episode }, deps).catch((err) => {
    log.warn('episode upload attempt threw', { runId: episode.runId, scopeId, err: String(err) });
    return null;
  });
  if (outcome?.ok) await deps.pending.remove(scopeId).catch(() => {});
}

/**
 * Retry every still-pending episode (RUN-227 discretion 3: driven off an EXISTING trigger, not a
 * new timer — `daemon.ts` calls this once at startup, mirroring the index-staging sweep, and again
 * on every `ws-client.ts` reconnect, mirroring `reconcileOwedMerges`/`reconcileParked`, which
 * already reconcile durable state on the identical two occasions for the identical reason: a
 * daemon that was offline, or a delivery that failed while it was up, both need a moment that is
 * not "a run happens to settle" to retry from). Sequential, deliberately — the queue is bounded and
 * episodes are rare enough that a concurrent fan-out would buy nothing but a burst of requests the
 * server has no reason to receive at once.
 */
export async function drainPendingEpisodes(
  deps: EpisodeDeliveryDeps,
): Promise<{ delivered: number; remaining: number }> {
  const log = deps.logger ?? defaultLogger;
  const entries = await deps.pending.list().catch(() => [] as PendingEpisode[]);
  let delivered = 0;
  for (const entry of entries) {
    const outcome = await uploadEpisode(entry, deps).catch((err) => {
      log.warn('episode retry attempt threw', {
        runId: entry.episode.runId,
        scopeId: entry.scopeId,
        err: String(err),
      });
      return null;
    });
    if (outcome?.ok) {
      await deps.pending.remove(entry.scopeId).catch(() => {});
      delivered++;
    }
  }
  return { delivered, remaining: entries.length - delivered };
}
