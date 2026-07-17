import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LedgerEntry } from './adjudication';
import type { ModelUsage } from './drivers/types';

/**
 * The local state a "continue a failed run" (RUN-91/92) needs but git cannot hold.
 *
 * The kept worktree carries the WORK (RUN-91 adopts it off disk), and the server carries the run's
 * identity and lifecycle. What neither holds is the two things a continuation must inherit to stay
 * consistent: the spend the run had reached, and the adjudication ledger the last sitting settled.
 * Both live only in the daemon's memory during a run, so they are persisted here at the moment a
 * build gate-fails with its worktree kept, and read back when the same run id is re-dispatched.
 *
 * Deliberately its OWN store, not folded into ParkedStore (RUN-30): a park is "blocked on a human,
 * resume the live session", with a TTL tied to the agent token's life and a resume path that
 * expects a session id. A continuable is "failed, resumable from disk with a fresh session", keyed
 * to a worktree that survives independently. Conflating them would put a failed run in front of the
 * park-answer sweep and the park-expiry logic, neither of which should touch it.
 *
 * Losing this file is graceful: a continue whose record is gone still adopts the worktree and runs
 * (RUN-91) — it just reports only its own sitting's spend and re-derives the prior findings (which
 * refute against the fixed tree). So a corrupt/absent file degrades, never strands.
 */
export const DEFAULT_CONTINUABLE_PATH = path.join(os.homedir(), '.noriq', 'continuable-runs.json');

export interface ContinuableRun {
  runId: string;
  /**
   * The run's spend when it failed, so a continuation's tally RE-SEEDS from it (RUN-92) and its
   * reported figures stay cumulative. Without it the fresh tally reports only the continuation's
   * spend, and `recordRunTelemetry` (which takes the frame's non-null value) overwrites the
   * server's tokens_used / model_usage with the smaller number — spend visibly drops on continue.
   * Shape mirrors `ParkedRun.spent`; `modelUsage` absent means the prior spend could not be
   * attributed by model (codex, the usage-fallback), so the resumed mix reports none rather than
   * one that does not sum.
   */
  spent: { tokens: number; usd: number; modelUsage?: Record<string, ModelUsage> };
  /**
   * The adjudication ledger (RUN-79) as it stood when the run failed: the fresh reviewer on the
   * continuation starts from the findings the prior sitting already raised and the builder's
   * rebuttals, so a settled finding is verified against the kept tree rather than relitigated from
   * scratch. Empty when the failure was not a reviewer gate (a deterministic verify or land fail).
   */
  ledger: LedgerEntry[];
  failedAt: string;
}

type ContinuableFile = { continuable: ContinuableRun[] };

export class ContinuableStore {
  private readonly file: string;
  private cache: Map<string, ContinuableRun> | null = null;

  constructor(file: string = DEFAULT_CONTINUABLE_PATH) {
    this.file = file;
  }

  private async load(): Promise<Map<string, ContinuableRun>> {
    if (this.cache) return this.cache;
    if (!existsSync(this.file)) {
      this.cache = new Map();
      return this.cache;
    }
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as ContinuableFile;
      this.cache = new Map((parsed.continuable ?? []).map((c) => [c.runId, c]));
    } catch {
      // Corrupt file → start empty rather than refuse to boot; a lost record only costs a
      // continuation its spend/ledger continuity, never the work (which is on disk).
      this.cache = new Map();
    }
    return this.cache;
  }

  private async flush(): Promise<void> {
    const continuable = [...(this.cache ?? new Map()).values()];
    await mkdir(path.dirname(this.file), { recursive: true });
    // Write-then-rename so a crash mid-write can't leave a truncated file that reads as empty.
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ continuable }, null, 2)}\n`);
    await rename(tmp, this.file);
  }

  /** Record (or refresh) a failed run's continuation state. */
  async put(entry: ContinuableRun): Promise<void> {
    (await this.load()).set(entry.runId, entry);
    await this.flush();
  }

  async get(runId: string): Promise<ContinuableRun | null> {
    return (await this.load()).get(runId) ?? null;
  }

  /** Drop the record once the run reaches a terminal that is not "failed with kept work" — the
   *  continuation succeeded (or was abandoned), so there is nothing left to continue. */
  async remove(runId: string): Promise<void> {
    const map = await this.load();
    if (map.delete(runId)) await this.flush();
  }
}
