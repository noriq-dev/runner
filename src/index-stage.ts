import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IndexJournal, IndexJournalEntry, IndexJournalKey } from './index-journal';

/**
 * Local, disposable staging for a generation's encoded batches (RUN-221 locked decision 6): the
 * durable copy under `~/.noriq/` that lets a snapshot lease be RELEASED before the (slow,
 * network-bound) upload begins, rather than holding a Perforce/Diversion pool-of-1 lease for the
 * duration of a multi-minute upload — `leasesOverlap` being absent on those backends means that is
 * a deadlock for every other index job on the repo, not merely a wait.
 *
 * **The directory is derivable from the KEY alone** (discretion, this task's own note): a plain
 * SHA-256 of the same five-field material `deriveGenerationId` hashes, so the sweep below can
 * compute "what SHOULD exist" from the journal without ever having to parse a directory name back
 * into a key — the one-directional half of the same discipline `index-journal.ts` applies to
 * on-disk shape (never trust what you read as more than a candidate).
 *
 * **Disposable in the same sense the journal is** (locked decision 1, one layer over): nothing
 * here is authority. A missing or corrupt directory is a MISS the caller re-stages over; deleting
 * the whole staging root costs a slower resume (or none — see `index-upload.ts`) and nothing else.
 */

export const DEFAULT_STAGING_ROOT = path.join(os.homedir(), '.noriq', 'index-staging');

const KEY_FIELD_SEP = '\u0000';

/** One-directional id for a journal key: the same NUL-joined five-field material
 *  `deriveGenerationId` (`index-batch.ts`) hashes, reused here rather than restated, so a
 *  directory name can never be walked back into a key — only computed FROM one. */
export function stagingId(key: IndexJournalKey): string {
  const parts = [key.server, key.repositoryKey, key.baseId, key.indexerVersion, key.generationId];
  const material = parts.join(KEY_FIELD_SEP);
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

export function stagingDirFor(key: IndexJournalKey, root: string = DEFAULT_STAGING_ROOT): string {
  return path.join(root, stagingId(key));
}

function batchFileName(batchNumber: number): string {
  return `batch-${batchNumber}.bin`;
}

/** The persistence seam, injected like `JournalStore`/`IntelStore` so tests never touch a real
 *  home directory. */
export interface StagingStore {
  /** Temp-and-rename, `JournalStore`'s own reasoning: a naive truncate-then-write has a window
   *  where a concurrent reader sees a partial file. */
  writeBatch(key: IndexJournalKey, batchNumber: number, bytes: Uint8Array): Promise<void>;
  /** `null` for anything not found or unreadable — a miss, never a throw; nothing on this upload
   *  path treats a staged copy as more than an optimization. */
  readBatch(key: IndexJournalKey, batchNumber: number): Promise<Buffer | null>;
  /** Remove this key's whole staging directory. Safe to call on a key that was never staged
   *  (`index-upload.ts` calls this unconditionally on completion). */
  clear(key: IndexJournalKey): Promise<void>;
}

export const fileStagingStore = (root: string = DEFAULT_STAGING_ROOT): StagingStore => ({
  writeBatch: async (key, batchNumber, bytes) => {
    const dir = stagingDirFor(key, root);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, batchFileName(batchNumber));
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, bytes, { mode: 0o600 });
    await rename(tmp, file);
  },
  readBatch: async (key, batchNumber) => {
    try {
      return await readFile(path.join(stagingDirFor(key, root), batchFileName(batchNumber)));
    } catch {
      return null;
    }
  },
  clear: async (key) => {
    await rm(stagingDirFor(key, root), { recursive: true, force: true });
  },
});

/**
 * Remove every staging directory this journal has no live entry for. **Call this ONLY on daemon
 * startup — never on a timer.** `worktree.ts`'s `reapOrphans` learned this the hard way (RUN-211,
 * commit 30906af): a snapshot on lease looks identical, by inspection, to one a crashed process
 * left behind, and the only moment that ambiguity cannot exist is startup, when no earlier process
 * — and so no lease, and no upload it was mid-way through — survives to be confused for garbage. A
 * staging directory can be mid-write (bytes on disk, journal entry not yet committed) or mid-
 * upload (journal entry present, more bytes than the journal's own last write) at any instant a
 * live daemon is running; only "nothing survived the last exit" makes every directory on disk that
 * lacks a live journal entry unreachable BY CONSTRUCTION rather than merely unlucky timing.
 *
 * This module deliberately wires no scheduler around this function (RUN-221 locked decision 10:
 * no trigger/timer of any kind is this task's to add) — a future caller (RUN-222/223) is
 * responsible for invoking it exactly once, before the coordinator's first `trigger()`.
 */
export async function sweepOrphanedStaging(
  journal: Pick<IndexJournal, 'list'>,
  root: string = DEFAULT_STAGING_ROOT,
): Promise<{ removed: string[] }> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return { removed: [] }; // nothing staged at all — not an error worth surfacing
  }
  const live = new Set((await journal.list()).map((entry) => stagingId(entry)));
  const removed: string[] = [];
  for (const entry of entries) {
    if (live.has(entry)) continue;
    await rm(path.join(root, entry), { recursive: true, force: true }).catch(() => {});
    removed.push(entry);
  }
  return { removed };
}

/**
 * `forget-local-journal` (RUN-223)'s whole implementation — deliberately a small, injectable
 * library function rather than logic inlined into `cli.ts`'s command handler, the same reason
 * `sweepOrphanedStaging` above is one: a command that mutates `~/.noriq/` state needs a seam a
 * test can point at a temp directory, never the operator's own machine.
 *
 * Clears every journal entry `match` selects, plus that entry's staged bytes — and NOTHING else.
 * Locked decision 5, restated at its one call site: this function's own signature is the proof —
 * it takes no `NoriqClient`, no `fetch`, no server dependency of any kind, so there is no code
 * path inside it that could reach the server even by accident. Returns the count forgotten, so the
 * caller (this daemon's CLI) can say precisely what it did rather than a bare "done".
 */
export async function forgetMatchingGenerations(
  journal: Pick<IndexJournal, 'list' | 'forget'>,
  staging: Pick<StagingStore, 'clear'>,
  match: (entry: IndexJournalEntry) => boolean,
): Promise<number> {
  const entries = (await journal.list()).filter(match);
  for (const entry of entries) {
    await journal.forget(entry);
    await staging.clear(entry);
  }
  return entries.length;
}
