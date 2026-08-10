import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * The upload journal (RUN-214, locked decision 5) — the ONE piece of index-job state this daemon
 * persists across a restart, and it is DISPOSABLE, never authority. `repo-intel.ts`'s contract
 * verbatim, one layer over: a corrupt, unreadable, or key-mismatched read is a MISS — redo the
 * work — never a repair and never a partial reuse.
 *
 * Keyed by the full 5-tuple `IndexJournalKey` names: (server, repositoryKey, baseId,
 * indexerVersion, generationId). The server is canonical about what was actually ingested — a
 * journal trusted as authority would let a local file declare a generation complete when the
 * server never received a batch, and a half-trusted journal is worse than none because the gap
 * becomes invisible. So `get` checks every field, not just the map path that reached the entry:
 * `baseId`/`indexerVersion` are stored redundantly and re-verified on read, the same defensive
 * posture `RepoIntel.get` takes against its own nested structure.
 *
 * Nothing uploads yet (Phase 4 is deferred — see VENDORED-CONTRACT.md's phase list). This module
 * only defines the disposable record and its miss/hit contract; `progress` is deliberately opaque
 * (`unknown`) because its real shape belongs to whichever future work step actually batches and
 * uploads, and inventing one here would be exactly the "stub someone later has to find and remove"
 * RUN-214's locked decision 1 warns against, one layer over.
 */

/** The full identity of one generation's journal entry. Every field participates in a match —
 *  there is no partial key (locked decision 5). */
export interface IndexJournalKey {
  server: string;
  repositoryKey: string;
  baseId: string;
  indexerVersion: string;
  generationId: string;
}

export interface IndexJournalEntry extends IndexJournalKey {
  /** Opaque to this store — a future upload step's own progress shape (batches sent, cursor
   *  position, …). This module enforces only the KEY match; it has no opinion about what is
   *  inside. */
  progress: unknown;
  updatedAt: string;
}

/** server -> repositoryKey -> generationId -> entry. */
type JournalFile = Record<string, Record<string, Record<string, IndexJournalEntry>>>;

export const DEFAULT_JOURNAL_PATH = path.join(os.homedir(), '.noriq', 'index-journal.json');

/** The persistence seam, injected like `IntelStore`/`ParkedStore`'s file, so tests never touch a
 *  real home directory. */
export interface JournalStore {
  read(): Promise<JournalFile>;
  write(file: JournalFile): Promise<void>;
}

export const fileJournalStore = (journalPath: string = DEFAULT_JOURNAL_PATH): JournalStore => ({
  read: async () => {
    try {
      const parsed: unknown = JSON.parse(await readFile(journalPath, 'utf8'));
      // Shape-checked, not merely parsed — `null`/`[]` are valid JSON that would otherwise throw
      // on the first property read, and this store's whole contract is that a broken journal is a
      // MISS, never an error that could cost a run.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
      return parsed as JournalFile;
    } catch {
      return {};
    }
  },
  write: async (file) => {
    // Temp-and-rename, `repo-intel.ts`'s exact reasoning: a naive truncate-then-write has a window
    // where a concurrent read sees an empty file, treats it as a miss, and then persists only its
    // own entry — losing every other generation's progress rather than one racing entry.
    await mkdir(path.dirname(journalPath), { recursive: true, mode: 0o700 });
    const tmp = `${journalPath}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, journalPath);
  },
});

export class IndexJournal {
  constructor(private readonly store: JournalStore) {}

  /** Read defensively — a store is a seam anyone can implement, and "a broken journal is a MISS,
   *  never an error" has to hold whatever comes back through it. */
  private async read(): Promise<JournalFile> {
    const raw = await this.store.read().catch(() => null);
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as JournalFile) : {};
  }

  /**
   * The entry for this EXACT key, or null. A mismatch on any of the five fields — including one a
   * corrupt write left behind under the right map path — is a miss, never a partial reuse (locked
   * decision 5): the caller redoes the work rather than presenting a stale generation's progress
   * as this one's.
   */
  async get(key: IndexJournalKey): Promise<IndexJournalEntry | null> {
    const file = await this.read();
    const entry = file[key.server]?.[key.repositoryKey]?.[key.generationId];
    if (!entry) return null;
    if (entry.baseId !== key.baseId || entry.indexerVersion !== key.indexerVersion) return null;
    if (entry.repositoryKey !== key.repositoryKey || entry.generationId !== key.generationId) return null;
    return entry;
  }

  /** Record progress for this generation. Replaces whatever was there for this exact key. */
  async put(key: IndexJournalKey, progress: unknown): Promise<void> {
    const file = await this.read();
    const forServer = file[key.server] ?? {};
    const forRepo = forServer[key.repositoryKey] ?? {};
    forRepo[key.generationId] = { ...key, progress, updatedAt: new Date().toISOString() };
    forServer[key.repositoryKey] = forRepo;
    file[key.server] = forServer;
    await this.store.write(file);
  }

  /** Forget one generation's progress — a completed/superseded generation, or an operator with a
   *  journal that has gone wrong. Never throws on a missing entry. */
  async forget(key: Pick<IndexJournalKey, 'server' | 'repositoryKey' | 'generationId'>): Promise<void> {
    const file = await this.read();
    if (!file[key.server]?.[key.repositoryKey]?.[key.generationId]) return;
    delete file[key.server]?.[key.repositoryKey]?.[key.generationId];
    await this.store.write(file);
  }

  /**
   * Every entry currently recorded, across every server/repo/generation. Used ONLY by the RUN-221
   * staging sweep (`index-stage.ts`'s `sweepOrphanedStaging`) to compute the LIVE set of staging
   * directories — never by upload/resume logic itself, which stays keyed to one exact 5-tuple
   * (locked decision 5's per-key contract is unaffected by this method's existence). Defensive the
   * same way `read`/`get` are: a malformed nested shape at any level is skipped rather than thrown,
   * because a corrupt journal must degrade toward "fewer entries survive" (costing the sweep a
   * false orphan at worst), never toward a crash.
   */
  async list(): Promise<IndexJournalEntry[]> {
    const file = await this.read();
    const out: IndexJournalEntry[] = [];
    for (const forServer of Object.values(file)) {
      if (typeof forServer !== 'object' || forServer === null) continue;
      for (const forRepo of Object.values(forServer)) {
        if (typeof forRepo !== 'object' || forRepo === null) continue;
        for (const entry of Object.values(forRepo)) {
          if (entry && typeof entry === 'object') out.push(entry as IndexJournalEntry);
        }
      }
    }
    return out;
  }
}
