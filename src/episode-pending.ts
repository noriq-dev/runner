import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  EffortEpisode as EffortEpisodeType,
  UploadedEpisodeIntelligence as UploadedEpisodeIntelligenceType,
} from '@noriq-dev/shared';
import type { MintIngestCapabilityInput } from './client';

/**
 * The bounded, restart-surviving queue of undelivered episodes (RUN-227).
 *
 * Unlike `index-journal.ts` — a DISPOSABLE view the server can always reconstruct the truth of,
 * where a corrupt read just costs a re-derived generation — an entry here is the ONLY durable copy
 * of a sitting's episode once the daemon holds it: the worktree it was read from is reaped shortly
 * after `settle`, so a lost pending entry loses that episode's rich half forever (the server's own
 * automatic skeleton, PLNR-263, still exists — this queue is what carries the enrichment upload
 * ADDS on top of it). `parked.ts`'s `ParkedStore` is the closer precedent for that reason: an
 * in-memory cache flushed to disk on every mutation, temp-and-rename on write so a crash mid-write
 * cannot leave a truncated file that reads as "nothing pending" — the same failure mode
 * `ParkedStore`'s own doc names. A corrupt file still degrades to empty rather than a dead daemon
 * (nothing here is worth refusing to boot over), but that is a LAST resort, not this module's
 * ordinary operating assumption the way it is `index-journal.ts`'s.
 */

export interface PendingEpisode {
  scopeId: string;
  /** The exact, already-assembled payload this scope was minted for — never rebuilt on a retry
   *  (RUN-227 locked decision 8). */
  episode: EffortEpisodeType;
  /** Captured once, at enqueue time, alongside the episode — a retry mints against the SAME
   *  (projectId, repositoryKey, runnerId) this run actually ran under, never whatever the daemon's
   *  current registration happens to be by the time the queue is drained. */
  mint: Omit<MintIngestCapabilityInput, 'purpose' | 'scopeId'>;
  /** When this entry was written — the age bound's own clock, and never touched again: an entry
   *  ages from the moment its episode became undeliverable, not from whenever it is retried. */
  enqueuedAt: string;
  /**
   * The narrow Project Intelligence payload (RUN-284), when `settle` assembled one — rides BESIDE
   * the episode, never inside it, the same split `UploadEpisodeInput` makes. Optional for two
   * independent reasons that must both degrade the same way: a sitting that observed nothing
   * intelligence-shaped never had one to carry, and every entry this store persisted BEFORE this
   * field existed has no key here at all. Both read as "send the episode without it" — this store
   * does no schema validation of its own (`toEnrichmentPayload` is the one validation point, run
   * fresh on every send including a retry drained from here), so an old entry loads exactly as it
   * always did.
   */
  intelligence?: UploadedEpisodeIntelligenceType;
}

type PendingEpisodeFile = { pending: PendingEpisode[] };

export const DEFAULT_PENDING_EPISODE_PATH = path.join(os.homedir(), '.noriq', 'episode-pending.json');

/**
 * The count bound. Generous: an entry is a few KB of JSON (bounded further by `episode.ts`'s own
 * per-field caps — `MAX_CMD_CHARS`, `MAX_DETAIL_CHARS`, and the acceptance/finding lists a spec
 * already keeps small), so 500 pending episodes is on the order of a few MB on disk — cheap to
 * hold, and far more than a healthy daemon should ever accumulate between successful drains.
 */
export const DEFAULT_MAX_PENDING = 500;

/**
 * The age bound, in hours. A week: long enough to survive an extended server outage or an operator
 * on vacation, short enough that an episode this stale is not worth carrying forever if delivery
 * never manages to catch up — the run it describes is long since a matter of the historical record
 * either way (the server's own automatic skeleton, PLNR-263, already exists for it).
 */
export const DEFAULT_MAX_PENDING_AGE_HOURS = 24 * 7;

/**
 * Trim `entries` to at most `maxCount`, none older than `maxAgeHours` (RUN-227 locked decision 7:
 * enforced on WRITE, never deferred to whenever something happens to read the queue — a queue
 * trimmed only on read grows unbounded on exactly the daemon that never gets a chance to retry,
 * which is the offline case this queue exists for).
 *
 * OLDEST dropped first on both axes (discretion 4): age-expired entries go regardless of count: an
 * episode past its own age bound is not worth carrying however few entries share the file. When the
 * survivors still exceed `maxCount`, the OLDEST of what remains goes next — a daemon under
 * sustained delivery failure keeps the entries with the best remaining chance of still being
 * useful, and a freshly-enqueued episode is never evicted to make room for one already stale.
 */
export function trimPending(
  entries: readonly PendingEpisode[],
  now: Date,
  maxCount: number = DEFAULT_MAX_PENDING,
  maxAgeHours: number = DEFAULT_MAX_PENDING_AGE_HOURS,
): PendingEpisode[] {
  const cutoffMs = now.getTime() - maxAgeHours * 3600_000;
  // An entry whose `enqueuedAt` cannot even be parsed is worse than merely old — degrade it toward
  // eviction, the same direction every defensive read in this codebase degrades a malformed value.
  const notExpired = entries.filter((e) => {
    const t = new Date(e.enqueuedAt).getTime();
    return Number.isFinite(t) && t >= cutoffMs;
  });
  const oldestFirst = [...notExpired].sort(
    (a, b) => new Date(a.enqueuedAt).getTime() - new Date(b.enqueuedAt).getTime(),
  );
  return oldestFirst.length > maxCount ? oldestFirst.slice(oldestFirst.length - maxCount) : oldestFirst;
}

/** The persistence seam, injected like `JournalStore`/`ParkedStore`'s own file, so a test never
 *  touches a real home directory. */
export interface PendingEpisodeFileStore {
  read(): Promise<PendingEpisodeFile>;
  write(file: PendingEpisodeFile): Promise<void>;
}

export const filePendingEpisodeStore = (
  file: string = DEFAULT_PENDING_EPISODE_PATH,
): PendingEpisodeFileStore => ({
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
      return parsed as PendingEpisodeFile;
    } catch {
      return { pending: [] };
    }
  },
  write: async (f) => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    // Temp-and-rename (`index-journal.ts`/`parked.ts`'s identical reasoning): a crash mid-write must
    // never leave a truncated file a concurrent read mistakes for "nothing pending", which would
    // silently drop every OTHER entry the write was replacing rather than just this one.
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  },
});

export class EpisodePendingStore {
  private readonly maxCount: number;
  private readonly maxAgeHours: number;
  private readonly now: () => Date;

  constructor(
    private readonly store: PendingEpisodeFileStore,
    opts: { maxCount?: number; maxAgeHours?: number; now?: () => Date } = {},
  ) {
    this.maxCount = opts.maxCount ?? DEFAULT_MAX_PENDING;
    this.maxAgeHours = opts.maxAgeHours ?? DEFAULT_MAX_PENDING_AGE_HOURS;
    this.now = opts.now ?? (() => new Date());
  }

  private async read(): Promise<PendingEpisodeFile> {
    const raw = await this.store.read().catch(() => null);
    return raw && Array.isArray(raw.pending) ? raw : { pending: [] };
  }

  /** Insert or replace (by `scopeId` — a retry that re-enqueues the identical scope before its
   *  prior entry cleared must not duplicate it) and trim to the bound, THEN write — the bound is
   *  enforced on this call, never deferred to `list`. */
  async put(entry: PendingEpisode): Promise<void> {
    const file = await this.read();
    const withoutSameScope = file.pending.filter((e) => e.scopeId !== entry.scopeId);
    const trimmed = trimPending([...withoutSameScope, entry], this.now(), this.maxCount, this.maxAgeHours);
    await this.store.write({ pending: trimmed });
  }

  /** Drop one delivered (or otherwise resolved) entry. Never throws on one already gone — a
   *  redundant remove (two drain passes racing, unlikely but not this store's business to forbid)
   *  is a no-op, not an error. */
  async remove(scopeId: string): Promise<void> {
    const file = await this.read();
    const next = file.pending.filter((e) => e.scopeId !== scopeId);
    if (next.length === file.pending.length) return;
    await this.store.write({ pending: next });
  }

  async list(): Promise<PendingEpisode[]> {
    return (await this.read()).pending;
  }
}
