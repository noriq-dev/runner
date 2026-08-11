import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  EffortEpisode as EffortEpisodeType,
  UploadedEpisodeIntelligence as UploadedEpisodeIntelligenceType,
} from '@noriq-dev/shared';
import type { MintIngestCapabilityInput } from './client';
import { logger as defaultLogger } from './logger';

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
 * The count bound. **Superseded claim, corrected here rather than softened (CLAUDE.md's standing
 * rule for a claim measurement falsified): say what changed and that the old wording is false.**
 * This used to justify itself with "an entry is a few KB of JSON... so 500 pending episodes is on
 * the order of a few MB on disk." That was true when written and is now false by an order of
 * magnitude for a chain-heavy run: since RUN-284/245 an entry carries `intelligence.execution.stages`
 * — one `EpisodeStageFact` per tally slot (every chain step, every review round, every plan-check),
 * UNBOUNDED in count. Measured on this repo's own builders: one `EpisodeStageFact` serializes to
 * 715 bytes, so a payload runs ~1.9 KB at one stage, ~15 KB at twenty, ~44 KB at sixty (a realistic
 * chain-heavy sitting), ~144 KB at two hundred. At 44 KB, 500 entries is ~22 MB — an order of
 * magnitude past the retired claim, and it was load-bearing: it was the entire justification for
 * this constant's value. Count and age stay the PRIMARY controls (an ordinary daemon never
 * approaches either); `DEFAULT_MAX_PENDING_BYTES` below is the backstop `trimPending` now enforces
 * for the case neither prices — a chain-heavy daemon offline for days.
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
 * The byte bound (RUN-249) — a third axis `trimPending` enforces on WRITE, oldest evicted first,
 * exactly like the age and count axes above. 8 MiB: measured to hold every one of the 500 typical
 * (few-KB) entries the count bound's own doc describes, or roughly 180 worst-case chain-heavy ones
 * (~44 KB each) — small enough that the atomic temp-and-rename write (`filePendingEpisodeStore.write`)
 * stays cheap, generous enough that no ordinary daemon under sustained failure hits it before the
 * count bound would anyway. It is the backstop for the case the count bound's own doc now names:
 * a chain-heavy daemon offline for days, where 500 entries can run ~22 MB rather than "a few MB".
 *
 * Measured as the actual UTF-8 bytes of each entry's own `JSON.stringify` (`Buffer.byteLength`, NOT
 * `.length` — discretion: `.length` counts UTF-16 code units, which diverges from what the atomic
 * write path actually puts on disk for any non-ASCII content — a Latin-1-supplement character is 1
 * UTF-16 unit but 2 UTF-8 bytes, a surrogate-pair character (emoji, some CJK) is 2 UTF-16 units but
 * up to 4 UTF-8 bytes — real divergence for a bound built to reason about actual disk cost, and
 * `filePendingEpisodeStore.write` writes the file as UTF-8, so `Buffer.byteLength` measures the
 * SAME unit the write path spends). Summed per-entry rather than one stringify of the whole file:
 * close enough for a backstop this coarse (the array/object wrapping and `null, 2` indentation
 * overhead the real file adds on top is negligible next to an 8 MiB cap), and it means a single
 * entry's own size is known without re-serializing every survivor on each eviction step.
 */
export const DEFAULT_MAX_PENDING_BYTES = 8 * 1024 * 1024;

/** Which axis evicted a given entry — `trimPending`'s optional `onEvict` callback reports this so a
 *  caller's log line can tell a byte eviction from an age or count one (RUN-249 acceptance). */
export type PendingEvictionReason = 'age' | 'count' | 'bytes';

/**
 * Trim `entries` to at most `maxCount`, none older than `maxAgeHours`, and no larger in total than
 * `maxBytes` (RUN-227 locked decision 7, RUN-249's byte axis: enforced on WRITE, never deferred to
 * whenever something happens to read the queue — a queue trimmed only on read grows unbounded on
 * exactly the daemon that never gets a chance to retry, which is the offline case this queue exists
 * for).
 *
 * OLDEST dropped first on all three axes (discretion 4, extended to the byte axis by the same
 * reasoning): age-expired entries go regardless of count or size — an episode past its own age
 * bound is not worth carrying however few entries share the file. When the survivors still exceed
 * `maxCount`, the OLDEST of what remains goes next. When the survivors of THAT still serialize
 * larger than `maxBytes`, the OLDEST of what remains goes next again — a daemon under sustained
 * delivery failure keeps the entries with the best remaining chance of still being useful, and a
 * freshly-enqueued episode is never evicted to make room for one already stale. The three passes
 * compose safely because each only ever removes from the FRONT of the same oldest-first-sorted
 * list: no entry already dropped by an earlier pass can be "evicted again" by a later one (it is
 * simply no longer in the array), and the byte pass can only ever shrink what the count pass
 * already bounded — never re-admit an entry the count pass dropped, so it cannot undo the count
 * pass's own intent.
 *
 * **The single-oversized-entry exception (discretion 3):** the byte pass never evicts the LAST
 * remaining survivor merely for exceeding `maxBytes` on its own. Chosen over evicting it because the
 * two failure modes are not symmetric: keeping an oversized entry blows the documented file-size
 * bound by that one entry's own size — a bounded, logged, rare overage, never the unbounded growth
 * this axis exists to backstop — while evicting it loses that episode's entire pending enrichment
 * with no recourse (the server's automatic skeleton, PLNR-263, covers only the base episode, never
 * the richer upload this queue carries). Delivery eventually succeeding is worth more than a disk
 * quota staying exact in a case this rare; `onEvict` still fires for every entry actually dropped,
 * so a kept oversized entry is not silent — see `EpisodePendingStore.put`'s own logging.
 *
 * That exception has a CONSEQUENCE worth stating rather than leaving to be discovered: no set
 * containing an over-cap entry can satisfy the bound, so oldest-first eviction strips every OTHER
 * entry trying to get under it and the queue degenerates to that one — an oversized episode crowds
 * out deliverable ones. Accepted because the precondition is unreachable, measured rather than
 * assumed: an `EpisodeStageFact` serializes to ~715 bytes, so one entry would need on the order of
 * 11,000 stage facts to reach 8 MiB, and a run's slot count is bounded at both ends (`steps.ts`
 * validates a decomposition's count as affordable; review rounds by `maxRounds`). If a future payload
 * shape makes a single entry genuinely able to exceed the cap, this is the trade to revisit — and the
 * fix then is a per-entry cap that drops the offender instead of its neighbours, not a bigger number.
 *
 * `onEvict`, when given, is called once per entry actually dropped, with which axis dropped it —
 * this function stays a pure computation (existing callers/tests that omit it see no behaviour
 * change), and `EpisodePendingStore.put` is the one caller that supplies it, to log a distinguishable
 * line per eviction reason (RUN-249 acceptance: "logged with enough detail to tell it from an age or
 * count eviction").
 */
export function trimPending(
  entries: readonly PendingEpisode[],
  now: Date,
  maxCount: number = DEFAULT_MAX_PENDING,
  maxAgeHours: number = DEFAULT_MAX_PENDING_AGE_HOURS,
  maxBytes: number = DEFAULT_MAX_PENDING_BYTES,
  onEvict?: (entry: PendingEpisode, reason: PendingEvictionReason) => void,
): PendingEpisode[] {
  const cutoffMs = now.getTime() - maxAgeHours * 3600_000;
  // An entry whose `enqueuedAt` cannot even be parsed is worse than merely old — degrade it toward
  // eviction, the same direction every defensive read in this codebase degrades a malformed value.
  const notExpired: PendingEpisode[] = [];
  for (const e of entries) {
    const t = new Date(e.enqueuedAt).getTime();
    if (Number.isFinite(t) && t >= cutoffMs) notExpired.push(e);
    else onEvict?.(e, 'age');
  }
  const oldestFirst = [...notExpired].sort(
    (a, b) => new Date(a.enqueuedAt).getTime() - new Date(b.enqueuedAt).getTime(),
  );

  let survivors = oldestFirst;
  if (survivors.length > maxCount) {
    const overflow = survivors.length - maxCount;
    for (let i = 0; i < overflow; i++) onEvict?.(survivors[i]!, 'count');
    survivors = survivors.slice(overflow);
  }

  // Byte axis (RUN-249) — see this function's own doc for why oldest-first composes safely with
  // the count pass above, and why the single last survivor is never evicted for its own size alone.
  const sizes = survivors.map((e) => Buffer.byteLength(JSON.stringify(e), 'utf8'));
  let total = sizes.reduce((sum, n) => sum + n, 0);
  let start = 0;
  while (total > maxBytes && start < survivors.length - 1) {
    total -= sizes[start]!;
    onEvict?.(survivors[start]!, 'bytes');
    start++;
  }
  return start > 0 ? survivors.slice(start) : survivors;
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
  private readonly maxBytes: number;
  private readonly now: () => Date;
  private readonly log: Pick<typeof defaultLogger, 'warn'>;

  constructor(
    private readonly store: PendingEpisodeFileStore,
    opts: {
      maxCount?: number;
      maxAgeHours?: number;
      maxBytes?: number;
      now?: () => Date;
      logger?: Pick<typeof defaultLogger, 'warn'>;
    } = {},
  ) {
    this.maxCount = opts.maxCount ?? DEFAULT_MAX_PENDING;
    this.maxAgeHours = opts.maxAgeHours ?? DEFAULT_MAX_PENDING_AGE_HOURS;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_PENDING_BYTES;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.logger ?? defaultLogger;
  }

  private async read(): Promise<PendingEpisodeFile> {
    const raw = await this.store.read().catch(() => null);
    return raw && Array.isArray(raw.pending) ? raw : { pending: [] };
  }

  /** Insert or replace (by `scopeId` — a retry that re-enqueues the identical scope before its
   *  prior entry cleared must not duplicate it) and trim to the bound, THEN write — the bound is
   *  enforced on this call, never deferred to `list`. Every entry `trimPending` actually drops is
   *  logged here with WHICH axis dropped it (RUN-249 acceptance), so a byte eviction reads
   *  distinguishably from an age or count one. */
  async put(entry: PendingEpisode): Promise<void> {
    const file = await this.read();
    const withoutSameScope = file.pending.filter((e) => e.scopeId !== entry.scopeId);
    const trimmed = trimPending(
      [...withoutSameScope, entry],
      this.now(),
      this.maxCount,
      this.maxAgeHours,
      this.maxBytes,
      (evicted, reason) =>
        this.log.warn('pending episode evicted from spool', {
          scopeId: evicted.scopeId,
          runId: evicted.episode.runId,
          reason,
          enqueuedAt: evicted.enqueuedAt,
        }),
    );
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
