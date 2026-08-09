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
 * rejected by the server" are both "this attempt did not proceed for a reason", and the acceptance
 * vocabulary names exactly nine states, not eleven. The DETAIL field is what keeps this honest —
 * it always carries the real reason text, so an operator reading `failed` is never left guessing
 * whether that means "network blip" or "validation rejected" or "an older daemon would have
 * downgraded the index".
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

/** The closed, nine-value operator vocabulary the acceptance names exactly. `no-opt-in` is never
 *  produced by `IndexStatusStore` itself (see the module doc) — it is here so callers that render
 *  a merged view (CLI, the control server's `/status`) have one type to hold every state a repo
 *  can be in. */
export const OPERATOR_INDEX_STATES = [
  'no-opt-in',
  'unchanged',
  'queued',
  'parsing',
  'uploading',
  'server-validating',
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
 *  `index-work.ts`'s `IndexWorkContext.onProgress`). */
export type IndexStatusEvent =
  | { type: 'reconcile'; repositoryKey: string; outcome: IndexReconcileOutcome }
  | { type: 'phase'; repositoryKey: string; phase: IndexJobPhase; detail?: string }
  | { type: 'success'; repositoryKey: string; generationId: string; baseId: string; batchesReceived: number }
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
        const state = reconcileOperatorState(event.outcome.outcome);
        const detail = reconcileDetail(event.outcome);
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
        next = {
          ...base,
          state: 'active',
          stateSince: nowIso,
          detail: null,
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
