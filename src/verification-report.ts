import { createHash } from 'node:crypto';
import type { VerifiedContextPack } from './citation-verify';
import { type NoriqClient, NoriqHttpError } from './client';
import { logger as defaultLogger } from './logger';
import type { VerificationState } from './memory-contract';
import type { PendingVerificationReport, VerificationPendingStore } from './verification-pending';

/**
 * RUN-230: report RUN-229's citation verdicts back to Noriq — idempotently, queued when offline,
 * never gating the run, and in a way an agent cannot forge (this task's own acceptance).
 *
 * **The mechanism, not free text.** The ONLY input this module accepts is a `VerifiedContextPack`
 * — `citation-verify.ts`'s own output, produced entirely from `changesBetween`/local reads against
 * the leased worktree. Nothing an agent said reaches this channel: `buildVerificationReport`'s
 * signature has no string parameter a session's output could ever populate, which is what makes
 * "authenticated as the runner/daemon boundary, not an agent prompt claim" (the stated acceptance)
 * true of the SHAPE, not merely of the intent to keep it that way.
 */

// ---------------------------------------------------------------------------
// The wire shape — NOT vendored (planar's own locked decision: "no vendored-contract refresh; the
// route, the normalizer and the RPC all exist"). `VerificationReportCitation`/`VerificationReport`
// live only in `apps/api/src/memory/verification.ts`, server-side. PLNR-348 is filed to move
// `evidenceHash` into the shared slice — until it lands, this is a REPRODUCTION of that server
// module's request shape, not an import of it.
// ---------------------------------------------------------------------------

export interface VerificationReportCitationWire {
  memoryItemId: string;
  evidenceHash: string;
  state: VerificationState;
  /** The base this daemon actually verified the citation AGAINST — never the citation's own
   *  historical `baseId` (that field only feeds `evidenceHash`, below). Locked decision 6: "the
   *  report always carries the base it was OBSERVED at, never a re-stamped one" — this is what the
   *  server writes into `last_verified_base_id`. */
  baseId: string;
  branch: string;
  /** Only meaningful server-side when `state === 'moved'`. `citation-verify.ts` never produces
   *  `moved` (its own module doc: "this module never synthesizes it") — so this daemon never has
   *  anything honest to put here, and this field is always omitted rather than guessed. */
  observedPath?: string | null;
}

export interface VerificationReportWire {
  citations: VerificationReportCitationWire[];
  /** Free text server-side (`z.string().min(1).default('runner-report')`), attributing every
   *  applied row to the actor that produced it — the daemon's own worktree-aware tier, distinct
   *  from Noriq's cheap retrieval-time check (doc §9's "two-tier" verification). Never a
   *  server-supplied or agent-supplied string (locked decision 4). */
  source: string;
}

export interface VerificationReportResult {
  applied: number;
  skipped: number;
  touchedMemoryIds: string[];
}

/** This daemon's own thorough, worktree-aware verification tier (doc §9) — as opposed to Noriq's
 *  cheap retrieval-time check. Distinct from the server's own default (`'runner-report'`) so a
 *  report from THIS code path is distinguishable in the evidence table's `verification_source`
 *  column from one submitted any other way. */
export const VERIFICATION_REPORT_SOURCE = 'runner-thorough';

// ---------------------------------------------------------------------------
// The evidence-identity hash reproduction (this task's own sharp edge, verified before it was
// written).
// ---------------------------------------------------------------------------

/**
 * Reproduction of `apps/api/src/memory/writes.ts`'s `evidenceHash` — `sha256` over
 * `JSON.stringify` of an object with keys in EXACTLY this order (`{repositoryKey, branch, baseId,
 * path, symbol}`), never a spread of the input. The server matches a reported citation on
 * `(memoryItemId, evidenceHash)` and a citation whose pair it does not have is silently SKIPPED —
 * HTTP 200, no error — so a wrong hash produces a report that applies to nothing and looks
 * healthy. `test/verification-report.test.ts` pins a hard-coded digest for a fixed input: PLNR-348
 * is filed to move this function into the shared vendored slice so this reproduction (and its
 * pinned test) can be deleted; until then, a planar-side reorder of these five fields is a
 * cosmetic-looking edit that silently voids every report this daemon sends, and only that test
 * catches it.
 */
export function evidenceHash(ref: {
  repositoryKey: string;
  branch: string;
  baseId: string;
  path: string;
  symbol: string | null;
}): string {
  const canonical = JSON.stringify({
    repositoryKey: ref.repositoryKey,
    branch: ref.branch,
    baseId: ref.baseId,
    path: ref.path,
    symbol: ref.symbol,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Building the report from a verified pack
// ---------------------------------------------------------------------------

export interface VerificationReportContext {
  /** This workspace's own canonical identity (`repo.manifest.repositoryKey`) — the same field
   *  `citation-verify.ts`'s `ctx.repositoryKey` compares every citation against. */
  repositoryKey: string;
  /**
   * The base this daemon actually checked citations against — `Workspace.baseId`, the leased
   * worktree's own snapshot, in the backend's own id-space. NEVER a citation's own recorded
   * `baseId`: that field describes what the evidence row ALREADY claimed before this daemon ever
   * looked at it, and re-sending it back would not be a new observation at all.
   */
  observedBaseId: string;
  /**
   * The branch this daemon actually checked against — `repo.manifest.defaultBranch`, the SAME
   * field `ContextPackInquiry.branch` uses and for the identical reason (that type's own doc):
   * deliberately never `Workspace.workRef`, the run's own throwaway `noriq/run/<id>` branch that
   * no later reader — including a retry of THIS report — could ever match against.
   */
  observedBranch: string;
}

/**
 * Build one report from a verified pack, or `null` when there is nothing reportable — either the
 * pack verified no memory citations at all, or every citation it carried named a repository other
 * than this workspace's own (see the loop body below for why those are excluded rather than sent).
 *
 * Only `excerptKind: 'memory'` sections are read: an episode excerpt's `support` array is a
 * differently-shaped `{kind, detail}[]` describing overlap, never a `ContextPackCitation[]`
 * (`citation-verify.ts`'s own doc) — there is nothing here for this function to report on it.
 */
export function buildVerificationReport(
  pack: VerifiedContextPack,
  ctx: VerificationReportContext,
): VerificationReportWire | null {
  const citations: VerificationReportCitationWire[] = [];
  for (const section of pack.sections) {
    for (const excerpt of section.excerpts) {
      if (excerpt.excerptKind !== 'memory') continue;
      for (const citation of excerpt.evidence) {
        // A citation naming a DIFFERENT repository (a sibling repo in a multi-repo project,
        // `citation-verify.ts`'s own module doc) was never actually checked against anything —
        // this daemon's `observedBaseId`/`observedBranch` describe THIS workspace, and stamping
        // them onto an evidence row that belongs to a repository this daemon knows nothing about
        // would silently corrupt that row's own freshness bookkeeping with a foreign base id. Not
        // spec'd explicitly, but the same "never report what was not actually observed" principle
        // locked decision 6 states for `baseId` — applied here at the repository grain instead.
        if (citation.repositoryKey !== ctx.repositoryKey) continue;
        citations.push({
          memoryItemId: excerpt.id,
          evidenceHash: evidenceHash({
            repositoryKey: citation.repositoryKey,
            branch: citation.branch,
            baseId: citation.baseId,
            path: citation.path,
            symbol: citation.symbol,
          }),
          state: citation.verification.state,
          baseId: ctx.observedBaseId,
          branch: ctx.observedBranch,
        });
      }
    }
  }
  if (!citations.length) return null;
  return { citations, source: VERIFICATION_REPORT_SOURCE };
}

// ---------------------------------------------------------------------------
// Sending — one attempt, classified so a permanent failure never haunts the queue forever
// ---------------------------------------------------------------------------

export type VerificationReportOutcome =
  | { ok: true; result: VerificationReportResult }
  | { ok: false; retryable: true; detail: string }
  | { ok: false; retryable: false; detail: string };

/**
 * One send attempt, authenticated as the RUN'S OWN bound agent (`agentToken` — never this
 * daemon's own token, and never anything an agent supplied): the server's gate is
 * `conn.boundAgent.id === run.agentId` (planar's own locked decision, verified before this was
 * written), which only a token minted for THIS run's agent identity can satisfy.
 *
 * A 401/403 is classified `retryable: false` — this specific token is REVOKED once the run
 * reaches a terminal state (`RunAgent`'s own doc: "the server revokes it when the Run reaches a
 * terminal state"), and unlike RUN-227's episode capability (freshly minted on every retry, under
 * the daemon's own long-lived OAuth identity) there is no way to mint a fresh one — this report
 * can ONLY ever be sent as this run's own agent. Holding such an entry in the bounded queue until
 * its age bound elapses would burn a slot for a delivery that can never succeed; the caller drops
 * it immediately instead. Every other failure — network, timeout, 5xx — is `retryable: true`.
 */
export async function sendVerificationReport(
  runId: string,
  agentToken: string,
  report: VerificationReportWire,
  deps: { client: Pick<NoriqClient, 'reportVerification'> },
): Promise<VerificationReportOutcome> {
  try {
    const result = await deps.client.reportVerification(runId, agentToken, report);
    return { ok: true, result };
  } catch (err) {
    if (err instanceof NoriqHttpError && (err.status === 401 || err.status === 403)) {
      return { ok: false, retryable: false, detail: `${err.status}: ${err.message}` };
    }
    return { ok: false, retryable: true, detail: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Delivery — durable-first, same shape as `episode-upload.ts`'s `deliverEpisode`/
// `drainPendingEpisodes`, and deliberately a SEPARATE queue (see `verification-pending.ts`'s own
// doc for why generalizing the two was rejected).
// ---------------------------------------------------------------------------

export interface VerificationReportDeliveryDeps {
  client: Pick<NoriqClient, 'reportVerification'>;
  pending: Pick<VerificationPendingStore, 'put' | 'remove' | 'list' | 'summary'>;
  logger?: typeof defaultLogger;
}

/**
 * Hand one freshly built report to delivery. Durability FIRST, mirroring `deliverEpisode`'s own
 * reasoning: the pending-queue write happens before the network attempt, so a daemon that crashes
 * moments later has still persisted the one copy of this run's verdicts that exists in memory
 * right now. The send attempt on top is best-effort; `drainPendingVerificationReports` is what
 * actually guarantees delivery survives a first failed try — and NEVER gates the run either way,
 * since nothing here is awaited by the caller (`stages/prepare.ts` fires this and moves on).
 */
export async function deliverVerificationReport(
  runId: string,
  agentToken: string,
  report: VerificationReportWire,
  deps: VerificationReportDeliveryDeps,
): Promise<void> {
  const log = deps.logger ?? defaultLogger;
  const entry: PendingVerificationReport = {
    runId,
    agentToken,
    report,
    enqueuedAt: new Date().toISOString(),
  };
  await deps.pending.put(entry).catch((err) =>
    log.warn('verification report enqueue failed — this run’s citation verdicts may not survive a restart', {
      runId,
      err: String(err),
    }),
  );
  const outcome = await sendVerificationReport(runId, agentToken, report, deps).catch((err) => {
    log.warn('verification report send attempt threw', { runId, err: String(err) });
    return null;
  });
  if (outcome?.ok) {
    await deps.pending.remove(runId).catch(() => {});
    log.debug('verification report delivered', {
      runId,
      applied: outcome.result.applied,
      skipped: outcome.result.skipped,
    });
    return;
  }
  if (outcome && !outcome.retryable) {
    await deps.pending.remove(runId).catch(() => {});
    log.warn('verification report cannot be delivered — dropping (not retryable)', {
      runId,
      detail: outcome.detail,
    });
    return;
  }
  // Visibility (this task's own acceptance: "pending status must be VISIBLE, not merely
  // persisted") — the queue DEPTH, not just this one entry, so an operator reading the log sees
  // whether this is an isolated blip or a growing backlog without needing a separate status call.
  const depth = await deps.pending.summary().catch(() => null);
  log.warn('verification report queued for retry — server unreachable or erroring', {
    runId,
    detail: outcome?.detail ?? 'unknown error',
    pendingCount: depth?.count ?? 'unknown',
  });
}

/**
 * Retry every still-pending report — driven off the SAME two triggers `drainPendingEpisodes`
 * already uses (`daemon.ts`: once at startup, again on every WS reconnect), for the identical
 * reasoning: a daemon that was offline, or a send that failed while it was up, both need a moment
 * that is not "a run happens to prepare" to retry from. Sequential, deliberately — the queue is
 * bounded and reports are rare enough that a concurrent fan-out buys nothing but a burst of
 * requests the server has no reason to receive at once.
 */
export async function drainPendingVerificationReports(
  deps: VerificationReportDeliveryDeps,
): Promise<{ delivered: number; dropped: number; remaining: number }> {
  const log = deps.logger ?? defaultLogger;
  const entries = await deps.pending.list().catch(() => [] as PendingVerificationReport[]);
  let delivered = 0;
  let dropped = 0;
  for (const entry of entries) {
    const outcome = await sendVerificationReport(entry.runId, entry.agentToken, entry.report, deps).catch(
      (err) => {
        log.warn('verification report retry attempt threw', { runId: entry.runId, err: String(err) });
        return null;
      },
    );
    if (outcome?.ok) {
      await deps.pending.remove(entry.runId).catch(() => {});
      delivered++;
    } else if (outcome && !outcome.retryable) {
      await deps.pending.remove(entry.runId).catch(() => {});
      dropped++;
      log.warn('dropping undeliverable verification report from the pending queue', {
        runId: entry.runId,
        detail: outcome.detail,
      });
    }
  }
  return { delivered, dropped, remaining: entries.length - delivered - dropped };
}
