import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { INDEXER_VERSION, type IndexReconcileOutcome } from './index-reconcile';
import { logger as defaultLogger } from './logger';

/**
 * The operator-visible index status surface (RUN-223) — a VIEW of what THIS daemon last observed
 * and did about one repository's background indexing, never authority. `index-journal.ts` and
 * `repo-intel.ts` say this verbatim for their own files; this module says it for the same reason,
 * one layer up: the server is canonical about what was actually ingested, so deleting this file
 * (or this whole process crashing before writing one) must cost visibility and nothing else.
 *
 * **The vocabulary maps onto machinery that already exists — no parallel taxonomy** (locked
 * decision 3). `reconcile` (`index-reconcile.ts`) decides six outcomes; `resolveConfig` returning
 * null is "no opt-in"; `queued`/`parsing`/`uploading`/`server-validating`/`failed` are phases of
 * one attempt the coordinator and the work step already drive through. `reconcileOperatorState`
 * below is the ONE function that folds the six reconcile outcomes into an operator state, written
 * as an exhaustive `switch` with no `default` — TypeScript refuses to compile it the moment a
 * seventh outcome is added to `IndexReconcileOutcome` without a decision about where it goes, the
 * same chokepoint discipline `index-source.ts`'s `IndexSourceRefusalReason` doc names for its own
 * enum. `test/index-status.test.ts` asserts the same thing at the value level, for a reader who
 * trusts a passing test more than a compiler error in a file they never open.
 *
 * `unavailable` and `incompatible-version` both fold into `'failed'` — deliberately, and unlike
 * every other arm this is a real judgement call, not a free choice among equivalent names: from
 * this daemon's own reconcile loop, "the cursor could not be fetched" and "the batch upload was
 * rejected by the server" are both "this attempt did not proceed for a reason". The DETAIL field
 * is what keeps this honest — it always carries the real reason text, so an operator reading
 * `failed` is never left guessing whether that means "network blip" or "validation rejected" or
 * "an older daemon would have downgraded the index".
 *
 * **`'staged'` (RUN-260) is a tenth state, added deliberately over an otherwise-closed vocabulary.**
 * A successful upload alone does not prove the generation serves search. Current servers return
 * an `activation` receipt from `complete()` after an atomic validate-and-promote; that receipt is
 * server evidence and may report `active` immediately. Older servers omit it, so success remains
 * `staged` until a later cursor reconcile confirms activation. Measured on the first real dogfood
 * ingest, the old code reported
 * `active` here while the server's cursor still had `activeGeneration: None` and the generation
 * was not projected into `nodes`/`edges` at all — `search_project_memory` returned zero results
 * while the operator was told everything was fine. Reusing `server-validating` would be wrong (that
 * means validation is IN FLIGHT; this means it finished and passed). The name `'staged'` is not
 * invented — it is the server's own `RunnerIndexGeneration.status` value for exactly this
 * condition (`vendor/noriq-shared/src/memory.ts`), so the operator vocabulary keeps mapping onto
 * machinery that already exists rather than growing a parallel one.
 *
 * **`active` is reported only from evidence the server supplied, never from bare local success.**
 * The only outcome `reconcile` (`index-reconcile.ts`) can return while an ACTIVE generation
 * demonstrably matches this checkout is `'unchanged'` — by construction it requires a non-null
 * `cursor.activeGeneration`, the same `indexerVersion`, the same `baseId` as this checkout's
 * current one, and `!cursor.stale`. That is precisely "the cursor's own `activeGeneration` matches
 * what is on disk right now", so `IndexStatusStore.record` promotes an `'unchanged'` reconcile to
 * `'active'` rather than leaving it at the vaguer `'unchanged'` — the state a repo that is fully
 * live and current should report is `active`, not a word that only describes how the daemon
 * noticed. This promotion is deliberately NOT narrowed to "the generation THIS daemon itself
 * uploaded" (matched by `generationId`): a fresh daemon whose own `lastSuccess` is empty (restart,
 * or a different checkout of the same canonical repository did the uploading) can reconcile
 * straight to `'unchanged'`, and the server's evidence is exactly as strong in that case — the
 * active generation genuinely reflects this exact base. Requiring a `generationId` match would
 * make a perfectly live repository report short of `active` for a reason that has nothing to do
 * with whether its memory is actually current. The evidence is threaded explicitly rather than
 * inferred implicitly: `IndexStatusEvent`'s `'reconcile'` arm carries `activeGenerationId`, read
 * straight off the cursor `index-coordinator.ts` already fetched for this attempt (no new network
 * call) — so the promotion is provably keyed to what the server said, not to an invariant of
 * `reconcile`'s current implementation that could silently drift later.
 *
 * **No `requiresUpgrade`-shaped boolean for `'staged'`.** `requiresUpgrade` exists to disambiguate
 * *within* the shared `'failed'` bucket, where `incompatible-version` and an ordinary network blip
 * would otherwise be indistinguishable without parsing `detail`. `'staged'` has no such collision —
 * it is its own named state, produced by nothing else, so `record.state === 'staged'` already gives
 * any caller the identical one-line certainty a boolean would, and a redundant field would be
 * exactly the kind of "reads as a feature, does nothing new" surface this module exists to avoid.
 * The CLI's state line names a missing activation receipt as server reconciliation/admin recovery,
 * satisfied by branching the render on `state === 'staged'` directly (`cli.ts`), the same
 * way the `'incompatible-version'` BLOCKED marker branches on `requiresUpgrade` today.
 *
 * **`incompatible-version` is not an ordinary `failed`, and that must be visible without reading
 * `detail` closely.** Every other `failed` invites a retry (a network blip, a rejected validation);
 * `incompatible-version` means retrying is POINTLESS until this daemon itself is upgraded — the
 * active generation on the server was built by a newer indexer, and reconcile refuses precisely to
 * avoid downgrading it (`index-reconcile.ts`'s `isNewerOrUnknown`). `IndexStatusRecord.requiresUpgrade`
 * is the structural signal (never buried in prose a caller has to parse), and `reconcileDetail`
 * below still prefixes the text unmistakably too — belt and suspenders, because a status that
 * invites a pointless retry loop is the mild version of "a status that lies".
 *
 * **No opt-in is answered locally, without a daemon** (`resolveConfig`/`loadIndexConfig` returning
 * null) — this module never produces that state itself; the CLI checks it directly, which is why
 * it is absent from `IndexStatusEvent` below. Every OTHER state requires having actually watched
 * an attempt happen, which only a live (or previously live) daemon process can have done.
 */

/** The closed, ten-value operator vocabulary — nine from the original RUN-223 acceptance plus
 *  `'staged'` (RUN-260, see the module doc). `no-opt-in` is never produced by `IndexStatusStore`
 *  itself (see the module doc) — it is here so callers that render a merged view (CLI, the control
 *  server's `/status`) have one type to hold every state a repo can be in. `'unchanged'` is kept in
 *  this closed set for the same reason `no-opt-in` is: a persisted snapshot written by an older
 *  daemon binary (before RUN-260's promotion) may still hold it, and `isRecordShape` below must
 *  keep reading that file as valid rather than discarding it as corrupt — `record` below no longer
 *  assigns it to a live record's `state` going forward (see the module doc's `'active'` promotion;
 *  `reconcileOperatorState` itself still names it, unweakened, for the reason its own doc gives). */
export const OPERATOR_INDEX_STATES = [
  'no-opt-in',
  'unchanged',
  'queued',
  'parsing',
  'uploading',
  'server-validating',
  'staged',
  'active',
  'failed',
  'association-conflict',
] as const;
export type OperatorIndexState = (typeof OPERATOR_INDEX_STATES)[number];

/** The three phases the work step alone can observe (locked decision 4) — never inferred from
 *  elapsed time or a journal side effect, both of which would be a guess dressed as a status. */
export type IndexJobPhase = 'parsing' | 'uploading' | 'server-validating';

/**
 * Fold one `reconcile` outcome into the operator vocabulary. Exhaustive by construction (see the
 * module doc) — `incremental`/`full` both become `'queued'`: the job has been accepted and is
 * about to run, and which of the two it is stays visible in `detail` (`reconcileDetail` below)
 * rather than doubling the state count for a distinction only the code needs.
 *
 * Still maps `'unchanged'` to `'unchanged'` (RUN-260 does not touch this function's pinned
 * mapping — see the locked decision to keep this switch unweakened). The `'unchanged'` →
 * `'active'` promotion is real, but it needs the fetched cursor's own `activeGeneration`, which
 * this function's signature (an outcome DISCRIMINANT, not the outcome or the cursor) deliberately
 * cannot see — that decision belongs to `IndexStatusStore.record`, the one place `IndexStatusEvent`
 * carries that evidence (see the module doc).
 */
export function reconcileOperatorState(outcome: IndexReconcileOutcome['outcome']): OperatorIndexState {
  switch (outcome) {
    case 'unchanged':
      return 'unchanged';
    case 'incremental':
    case 'full':
      return 'queued';
    case 'association-conflict':
      return 'association-conflict';
    case 'unavailable':
    case 'incompatible-version':
      return 'failed';
  }
}

/** Free-text detail for the record — never branched on, only ever displayed (the same posture
 *  `IndexReconcileOutcome['full']['reason']` already takes for its own field). */
function reconcileDetail(outcome: IndexReconcileOutcome): string | null {
  switch (outcome.outcome) {
    case 'unchanged':
      return null;
    case 'incremental':
      return `incremental — diffing ${outcome.fromBase} → ${outcome.toBase}`;
    case 'full':
      return `full reindex — ${outcome.reason}`;
    case 'association-conflict':
      return outcome.reason;
    case 'unavailable':
      return outcome.reason;
    case 'incompatible-version':
      return `UPGRADE REQUIRED — active generation was built by indexer version ${outcome.activeIndexerVersion}, newer than this daemon's ${outcome.ourIndexerVersion}; retrying will not help until this daemon is upgraded`;
  }
}

/** What the coordinator/work step actually observe, fed to `IndexStatusStore.record` (locked
 *  decision 3/4's single injection point — see `index-coordinator.ts`'s `onStatus` dep and
 *  `index-work.ts`'s `IndexWorkContext.onProgress`).
 *
 *  `reconcile`'s `activeGenerationId` (RUN-260) is the server's `cursor.activeGeneration?.id` at
 *  the moment this attempt reconciled, threaded straight through by `index-coordinator.ts` from
 *  the cursor it already fetched to decide the outcome — never re-derived here, never a second
 *  network call. Optional so older callers/tests that never touch activation status keep
 *  compiling; absent (or `null`) simply means "this reconcile is not evidence of activation",
 *  which is true for every outcome except `'unchanged'` (see the module doc). */
export type IndexStatusEvent =
  | {
      type: 'reconcile';
      repositoryKey: string;
      outcome: IndexReconcileOutcome;
      activeGenerationId?: string | null;
    }
  | { type: 'phase'; repositoryKey: string; phase: IndexJobPhase; detail?: string }
  | {
      type: 'success';
      repositoryKey: string;
      generationId: string;
      baseId: string;
      batchesReceived: number;
      activated?: string;
    }
  | { type: 'failure'; repositoryKey: string; detail: string };

export interface IndexStatusRecord {
  repositoryKey: string;
  state: OperatorIndexState;
  /** ISO timestamp of the last transition into `state` — "last observed at T", never a claim
   *  about what is true right now (the warning this whole surface exists to respect). */
  stateSince: string;
  detail: string | null;
  lastError: { message: string; at: string } | null;
  lastSuccess: { at: string; generationId: string; baseId: string; batchesReceived: number } | null;
  /** This daemon's own `INDEXER_VERSION` at the time of the last observation — never re-read live,
   *  so a status record always reflects what THIS daemon would have produced, not what a
   *  concurrently-upgraded binary might. */
  indexerVersion: string;
  /** True exactly when `state === 'failed'` because reconcile refused an `incompatible-version` —
   *  see the module doc. The structural half of that distinction: a caller can act on this field
   *  without parsing `detail`'s prose. Reset to `false` by any OTHER observation for this
   *  repository (a later reconcile that is not `incompatible-version`, a phase, a success, or a
   *  plain failure) — the situation may have changed, and a stale `true` would be its own lie. */
  requiresUpgrade: boolean;
}

export interface IndexStatusStoreDeps {
  now?: () => number;
  /** Best-effort persistence, called with the full snapshot after every mutation. Never allowed to
   *  throw back into the caller — a write hiccup costs the next CLI read staleness, never a
   *  broken index attempt (the same posture every other best-effort observer in this codebase
   *  takes on its own write path). */
  persist?: (records: IndexStatusRecord[]) => Promise<void>;
  logger?: typeof defaultLogger;
}

/**
 * The in-memory recorder — one process's own live view. `record` is synchronous and never throws:
 * it is called from inside `IndexCoordinator.attempt`'s own control flow, and a status write must
 * never be why an index job fails.
 */
export class IndexStatusStore {
  private readonly records = new Map<string, IndexStatusRecord>();
  private readonly now: () => number;
  private readonly persist?: (records: IndexStatusRecord[]) => Promise<void>;
  private readonly log: typeof defaultLogger;

  constructor(deps: IndexStatusStoreDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.persist = deps.persist;
    this.log = deps.logger ?? defaultLogger;
  }

  snapshot(): IndexStatusRecord[] {
    return [...this.records.values()];
  }

  get(repositoryKey: string): IndexStatusRecord | undefined {
    return this.records.get(repositoryKey);
  }

  record(event: IndexStatusEvent): void {
    const nowIso = new Date(this.now()).toISOString();
    const existing = this.records.get(event.repositoryKey);
    const indexerVersion = existing?.indexerVersion ?? INDEXER_VERSION;
    const base = {
      repositoryKey: event.repositoryKey,
      lastError: existing?.lastError ?? null,
      lastSuccess: existing?.lastSuccess ?? null,
      indexerVersion,
    };

    let next: IndexStatusRecord;
    switch (event.type) {
      case 'reconcile': {
        const folded = reconcileOperatorState(event.outcome.outcome);
        // RUN-260: the ONLY promotion to `'active'` in this whole store, and it is evidence-gated
        // — `'unchanged'` is the one outcome `reconcile` returns while the cursor's own
        // `activeGeneration` demonstrably matches this checkout's current base/version and is not
        // stale (see the module doc). `activeGenerationId` is asserted rather than trusted blindly
        // (defensive: `folded === 'unchanged'` already implies it by `reconcile`'s own contract,
        // but a caller that forgot to thread it must not silently promote on nothing).
        const state: OperatorIndexState =
          folded === 'unchanged' && event.activeGenerationId ? 'active' : folded;
        const detail =
          state === 'active'
            ? `server confirms this base is active (generation ${event.activeGenerationId})`
            : reconcileDetail(event.outcome);
        next = {
          ...base,
          state,
          stateSince: nowIso,
          detail,
          // A reconcile-time failure (`unavailable`/`incompatible-version`) is worth the same
          // visibility as an upload failure — both are "this attempt did not proceed".
          lastError:
            state === 'failed' ? { message: detail ?? event.outcome.outcome, at: nowIso } : base.lastError,
          requiresUpgrade: event.outcome.outcome === 'incompatible-version',
        };
        break;
      }
      case 'phase':
        next = {
          ...base,
          state: event.phase,
          stateSince: nowIso,
          detail: event.detail ?? null,
          requiresUpgrade: false,
        };
        break;
      case 'success':
        // Bare success remains staged for compatibility with older servers. Current servers return
        // an activation receipt from complete(); that is canonical server evidence, not inference.
        next = {
          ...base,
          state: event.activated ? 'active' : 'staged',
          stateSince: nowIso,
          detail: event.activated
            ? `server validated and atomically activated generation ${event.activated}`
            : 'uploaded, sealed and validated, but this server did not confirm activation; reconcile the server cursor before treating it as active.',
          lastSuccess: {
            at: nowIso,
            generationId: event.generationId,
            baseId: event.baseId,
            batchesReceived: event.batchesReceived,
          },
          requiresUpgrade: false,
        };
        break;
      case 'failure':
        next = {
          ...base,
          state: 'failed',
          stateSince: nowIso,
          detail: event.detail,
          lastError: { message: event.detail, at: nowIso },
          requiresUpgrade: false,
        };
        break;
    }

    this.records.set(event.repositoryKey, next);
    if (this.persist) {
      void this.persist(this.snapshot()).catch((err) =>
        this.log.warn('index status persist failed', { err: String(err) }),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Disk persistence — `~/.noriq/index-status.json`. Same discipline as `index-journal.ts` and
// `repo-intel.ts`: mode 0600 (0700 for the directory), temp-and-rename, and a corrupt or missing
// read is a MISS, never a throw. The whole file is rewritten on every mutation (never a partial
// merge) — this store has exactly one writer per daemon process, so there is no concurrent-entry
// loss to guard against the way the journal's per-key merge does.
// ---------------------------------------------------------------------------

export const DEFAULT_STATUS_PATH = path.join(os.homedir(), '.noriq', 'index-status.json');

export function fileIndexStatusPersist(
  statusPath: string = DEFAULT_STATUS_PATH,
): (records: IndexStatusRecord[]) => Promise<void> {
  return async (records) => {
    await mkdir(path.dirname(statusPath), { recursive: true, mode: 0o700 });
    const tmp = `${statusPath}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, statusPath);
  };
}

function isRecordShape(v: unknown): v is IndexStatusRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.repositoryKey === 'string' &&
    typeof r.state === 'string' &&
    (OPERATOR_INDEX_STATES as readonly string[]).includes(r.state) &&
    typeof r.stateSince === 'string'
  );
}

/** The CLI's offline fallback: the last snapshot this daemon persisted, defensively parsed. Used
 *  when no live daemon answers `/status` — always labelled by its own `stateSince` timestamp so a
 *  stale read reads as "last observed at T", never as a present-tense claim (see the module doc). */
export async function readIndexStatusSnapshot(
  statusPath: string = DEFAULT_STATUS_PATH,
): Promise<IndexStatusRecord[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(statusPath, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecordShape);
  } catch {
    return [];
  }
}
