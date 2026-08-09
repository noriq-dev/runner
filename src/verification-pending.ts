import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { VerificationReportWire } from './verification-report';

/**
 * The bounded, restart-surviving queue of undelivered verification reports (RUN-230).
 *
 * `episode-pending.ts` (RUN-227) is the precedent this deliberately MIRRORS in shape — temp-and-
 * rename on write, trimmed on write (never on read), oldest-evicted-first on both the count and
 * age axes — and deliberately does NOT literally share code or a store class with. Two real
 * differences, not a preference:
 *
 *   1. **What authorizes a retry.** An episode's `mint` field is a set of IDENTITY parameters
 *      (projectId, repositoryKey, runnerId) that a retry uses to mint a FRESH ingest capability
 *      under the daemon's own long-lived OAuth credential — always retryable, forever, because the
 *      credential that authorizes minting never expires with the episode. A verification report
 *      has no such path: the server's gate requires the RUN'S OWN bound-agent token specifically
 *      (`conn.boundAgent.id === run.agentId`, planar's own locked decision), and that token is
 *      revoked once the run reaches a terminal state. So this queue persists the TOKEN itself
 *      (`agentToken`, captured once at enqueue time, exactly like `parked.ts`'s own precedent for
 *      holding a bound agent token on disk under the same uid-boundary caveat as
 *      `credentials.json`), and a retry can go permanently, structurally dead in a way an
 *      episode retry never does — `verification-report.ts`'s `sendVerificationReport` classifies
 *      a 401/403 as non-retryable specifically because of this, and its caller drops the entry
 *      immediately rather than letting a doomed retry sit until the age bound elapses.
 *   2. **The delivery protocol.** An episode goes through the multi-step signed ingest protocol
 *      (`begin`/`putBatch`/`complete`, `episode-upload.ts`) with its own capability-expiry retry
 *      logic; a verification report is one POST with a Bearer header. Sharing a store class across
 *      two payload shapes this different would mean the store's own type either erases the
 *      distinction (a union with dead branches on both sides) or leaks it back out through casts —
 *      cheaper to keep the two queues small and separately typed than to build a shared
 *      abstraction whose only real audience is one field apart.
 *
 * What IS shared, deliberately, because it is the actual bound the acceptance criteria are about:
 * the shape of "bounded on two axes, trimmed on write, oldest first" — restated here rather than
 * factored out, since `trimPending` in `episode-pending.ts` is eleven lines and importing it would
 * buy nothing but a cross-module dependency between two otherwise-independent queues for no
 * shared behaviour beyond what copying costs to keep in sync.
 */

export interface PendingVerificationReport {
  /** One run produces exactly one verification report (built once from that run's own
   *  `verifiedContextPack`, sent from `stages/prepare.ts`) — `runId` is therefore already a
   *  natural unique key, the same role `scopeId` plays for `PendingEpisode`. */
  runId: string;
  /** The run's own bound-agent token, captured at enqueue time — see this module's own doc for
   *  why a retry cannot re-derive or re-mint this the way an episode's `mint` can. */
  agentToken: string;
  /** The exact, already-built report — never rebuilt on a retry (the same locked-decision shape
   *  RUN-227 follows for `PendingEpisode.episode`): a queued report sent three days later must
   *  still name the base it was OBSERVED at, not a base re-stamped at retry time. */
  report: VerificationReportWire;
  /** When this entry was written — the age bound's own clock, untouched after that. */
  enqueuedAt: string;
}

type PendingVerificationReportFile = { pending: PendingVerificationReport[] };

export const DEFAULT_PENDING_VERIFICATION_PATH = path.join(
  os.homedir(),
  '.noriq',
  'verification-pending.json',
);

/** Same order-of-magnitude reasoning as `episode-pending.ts`'s identical constant: a report is a
 *  handful of citations, each a few short fields — cheap to hold, and far more than a healthy
 *  daemon should ever accumulate between successful drains. */
export const DEFAULT_MAX_PENDING_VERIFICATION = 500;

/**
 * The age bound, in hours. A week, same as episodes — NOT shortened to track the run-agent
 * token's own lifetime, because the 401/403 short-circuit (`sendVerificationReport`'s own doc) is
 * what actually protects this queue from holding a doomed entry; the age bound is a backstop for
 * an entry that is never retried at all (the daemon never reconnects, or the server stays
 * unreachable), not the mechanism that decides whether one CAN succeed.
 */
export const DEFAULT_MAX_PENDING_VERIFICATION_AGE_HOURS = 24 * 7;

/**
 * Trim `entries` to at most `maxCount`, none older than `maxAgeHours` — enforced on WRITE, never
 * deferred to read (`episode-pending.ts`'s `trimPending`, same reasoning restated for this queue:
 * a queue trimmed only on read grows unbounded on exactly the daemon that never gets a chance to
 * retry, which is the offline case this queue exists for). OLDEST dropped first on both axes.
 */
export function trimPendingVerification(
  entries: readonly PendingVerificationReport[],
  now: Date,
  maxCount: number = DEFAULT_MAX_PENDING_VERIFICATION,
  maxAgeHours: number = DEFAULT_MAX_PENDING_VERIFICATION_AGE_HOURS,
): PendingVerificationReport[] {
  const cutoffMs = now.getTime() - maxAgeHours * 3600_000;
  const notExpired = entries.filter((e) => {
    const t = new Date(e.enqueuedAt).getTime();
    return Number.isFinite(t) && t >= cutoffMs;
  });
  const oldestFirst = [...notExpired].sort(
    (a, b) => new Date(a.enqueuedAt).getTime() - new Date(b.enqueuedAt).getTime(),
  );
  return oldestFirst.length > maxCount ? oldestFirst.slice(oldestFirst.length - maxCount) : oldestFirst;
}

/** The persistence seam, injected so a test never touches a real home directory (`ParkedStore`/
 *  `EpisodePendingStore`'s own convention). */
export interface PendingVerificationFileStore {
  read(): Promise<PendingVerificationReportFile>;
  write(file: PendingVerificationReportFile): Promise<void>;
}

export const filePendingVerificationStore = (
  file: string = DEFAULT_PENDING_VERIFICATION_PATH,
): PendingVerificationFileStore => ({
  read: async () => {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !Array.isArray((parsed as { pending?: unknown }).pending)
      ) {
        return { pending: [] };
      }
      return parsed as PendingVerificationReportFile;
    } catch {
      return { pending: [] };
    }
  },
  write: async (f) => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    // Temp-and-rename: a crash mid-write must never leave a truncated file a concurrent read
    // mistakes for "nothing pending", which would silently drop every OTHER entry the write was
    // replacing rather than just this one (`episode-pending.ts`/`parked.ts`'s identical reasoning).
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  },
});

export class VerificationPendingStore {
  private readonly maxCount: number;
  private readonly maxAgeHours: number;
  private readonly now: () => Date;

  constructor(
    private readonly store: PendingVerificationFileStore,
    opts: { maxCount?: number; maxAgeHours?: number; now?: () => Date } = {},
  ) {
    this.maxCount = opts.maxCount ?? DEFAULT_MAX_PENDING_VERIFICATION;
    this.maxAgeHours = opts.maxAgeHours ?? DEFAULT_MAX_PENDING_VERIFICATION_AGE_HOURS;
    this.now = opts.now ?? (() => new Date());
  }

  private async read(): Promise<PendingVerificationReportFile> {
    const raw = await this.store.read().catch(() => null);
    return raw && Array.isArray(raw.pending) ? raw : { pending: [] };
  }

  /** Insert or replace (by `runId` — a retry that re-enqueues before its prior entry cleared must
   *  not duplicate it) and trim to the bound, THEN write. */
  async put(entry: PendingVerificationReport): Promise<void> {
    const file = await this.read();
    const withoutSameRun = file.pending.filter((e) => e.runId !== entry.runId);
    const trimmed = trimPendingVerification(
      [...withoutSameRun, entry],
      this.now(),
      this.maxCount,
      this.maxAgeHours,
    );
    await this.store.write({ pending: trimmed });
  }

  /** Drop one delivered (or permanently undeliverable) entry. Never throws on one already gone. */
  async remove(runId: string): Promise<void> {
    const file = await this.read();
    const next = file.pending.filter((e) => e.runId !== runId);
    if (next.length === file.pending.length) return;
    await this.store.write({ pending: next });
  }

  async list(): Promise<PendingVerificationReport[]> {
    return (await this.read()).pending;
  }

  /** Visibility (this task's own acceptance: "pending status must be VISIBLE, not merely
   *  persisted"). Cheap enough to call from a log line at every enqueue — a caller wanting more
   *  than a count/oldest-age summary already has `list()`. */
  async summary(): Promise<{ count: number; oldestEnqueuedAt: string | null }> {
    const entries = await this.list();
    if (!entries.length) return { count: 0, oldestEnqueuedAt: null };
    const oldest = entries.reduce((a, b) => (a.enqueuedAt < b.enqueuedAt ? a : b));
    return { count: entries.length, oldestEnqueuedAt: oldest.enqueuedAt };
  }
}
