import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Repo intelligence (RUN-143): the compact architectural facts a run works out, kept so the next
 * one does not work them out again.
 *
 * Nothing in the runner preserved what a repo IS. Parked state preserves one session, continuation
 * state preserves spend and adjudications, transcripts preserve what happened — and every run
 * still rediscovered where the tests live, what the module layout is, and which conventions the
 * repo actually follows. That is the same tokens, spent repeatedly, to reach an answer that
 * changes only when the code does.
 *
 * **A CACHE, NOT AN AUTHORITY.** Three consequences, and each is a rule rather than a caveat:
 *
 *   - Nothing here is a source of truth Noriq does not already hold. A doc, a manifest `[context]`
 *     block, a task's execution spec — those are authored, versioned, and reviewable. This is
 *     derived, disposable, and answers to none of that. Deleting the whole file must cost latency
 *     and nothing else, which is the property every read here is written to preserve.
 *   - It is keyed to the BASE the facts were derived from, in the backend's own id-space, so a
 *     stale entry is not returned rather than being returned with a caveat. An entry for a
 *     different base is simply a miss.
 *   - It is per (server, repo), because a checkout reachable from two Noriq instances is two
 *     different projects that happen to share a directory, and one's facts are not the other's.
 *
 * Local and machine-scoped, under `~/.noriq/`. It is never committed, never uploaded, and holds
 * only what a read of the repo would tell you anyway.
 */

/** What one run learned about a repo. Deliberately short: this is orientation, not a wiki, and a
 *  cache that grows without bound becomes a thing to maintain rather than a thing to delete. */
export interface RepoFacts {
  /** Where to start reading, as repo-relative paths. */
  entryPoints: string[];
  /** How the repo is laid out, one line per module or area. */
  layout: string[];
  /** Non-negotiable steers a run should already know ("ESM only", "no barrel files"). */
  conventions: string[];
  /** How this repo is checked, verbatim — the command, not a description of it. */
  testCommands: string[];
}

export interface RepoIntelEntry extends RepoFacts {
  /** The backend base these facts were derived from (`Workspace.baseId`). An opaque token: it is
   *  compared for equality and never parsed. */
  baseId: string;
  /** When they were written. Informational — staleness is decided by `baseId`, never by age,
   *  because a repo that has not moved has not gone stale however long it has been. */
  learnedAt: string;
}

/** The whole file: server → repo id → entry. */
type IntelFile = Record<string, Record<string, RepoIntelEntry>>;

export const DEFAULT_INTEL_PATH = path.join(os.homedir(), '.noriq', 'repo-intel.json');

/** The persistence seam, injected like `GitRunner` and `VerifyExec` so tests never touch a real
 *  home directory. */
export interface IntelStore {
  read(): Promise<IntelFile>;
  write(file: IntelFile): Promise<void>;
}

export const fileIntelStore = (intelPath: string = DEFAULT_INTEL_PATH): IntelStore => ({
  read: async () => {
    try {
      return JSON.parse(await readFile(intelPath, 'utf8')) as IntelFile;
    } catch {
      // Missing or corrupt is a MISS, never an error. A cache that can fail a run is worse than
      // no cache: the run would have worked without it.
      return {};
    }
  },
  write: async (file) => {
    await mkdir(path.dirname(intelPath), { recursive: true });
    await writeFile(intelPath, `${JSON.stringify(file, null, 2)}\n`);
  },
});

/** How many facts of each kind are kept. A cap rather than a budget: this is a short orientation
 *  block, and a run that learned forty conventions has learned a document. */
const PER_KIND_CAP = 12;
/** How long one fact may be. Long enough for a real convention, short enough that nobody is
 *  tempted to put a design decision here — those belong in a doc, which is versioned. */
const FACT_CHARS = 240;

const trim = (items: readonly string[]): string[] =>
  items
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.length > FACT_CHARS ? `${s.slice(0, FACT_CHARS - 1)}…` : s))
    .slice(0, PER_KIND_CAP);

export const emptyFacts = (): RepoFacts => ({
  entryPoints: [],
  layout: [],
  conventions: [],
  testCommands: [],
});

/** Is there anything in these facts? An entry with nothing in it is a miss that costs a write. */
export const hasFacts = (f: RepoFacts): boolean =>
  f.entryPoints.length + f.layout.length + f.conventions.length + f.testCommands.length > 0;

export class RepoIntel {
  constructor(
    private readonly store: IntelStore,
    /** Which Noriq this daemon is talking to. Part of the key because a checkout reachable from
     *  two instances is two projects sharing a directory. */
    private readonly server: string,
  ) {}

  /**
   * The facts for this repo AT THIS BASE, or null.
   *
   * A different base is a miss, not a stale hit with a warning. The alternative — returning older
   * facts and letting the caller judge — puts a "is this still true?" decision in front of an
   * agent, which is precisely the work this exists to save.
   */
  async get(repoId: string, baseId: string): Promise<RepoFacts | null> {
    const file = await this.store.read().catch(() => ({}) as IntelFile);
    const entry = file[this.server]?.[repoId];
    if (!entry || entry.baseId !== baseId) return null;
    return {
      entryPoints: entry.entryPoints,
      layout: entry.layout,
      conventions: entry.conventions,
      testCommands: entry.testCommands,
    };
  }

  /**
   * Record what a run learned. Replaces whatever was there for this repo: the facts describe one
   * base, and merging two bases' facts would produce a description of no repo at all.
   *
   * Best-effort in both directions — a read that fails starts from empty, and a write that fails
   * is logged by the caller and forgotten. Neither may cost a run.
   */
  async put(repoId: string, baseId: string, facts: RepoFacts): Promise<void> {
    const trimmed: RepoFacts = {
      entryPoints: trim(facts.entryPoints),
      layout: trim(facts.layout),
      conventions: trim(facts.conventions),
      testCommands: trim(facts.testCommands),
    };
    if (!hasFacts(trimmed)) return; // nothing learned is not worth a write
    const file = await this.store.read().catch(() => ({}) as IntelFile);
    const forServer = file[this.server] ?? {};
    forServer[repoId] = { ...trimmed, baseId, learnedAt: new Date().toISOString() };
    file[this.server] = forServer;
    await this.store.write(file);
  }

  /** Forget a repo's facts — for an operator with a cache that has gone wrong, and for tests. */
  async forget(repoId: string): Promise<void> {
    const file = await this.store.read().catch(() => ({}) as IntelFile);
    if (!file[this.server]?.[repoId]) return;
    delete file[this.server]?.[repoId];
    await this.store.write(file);
  }
}

/**
 * Render the facts as a brief section.
 *
 * Introduced as what it is — a previous run's notes, at a known base, possibly wrong — because the
 * failure mode of a cache in a prompt is an agent trusting it over the repo in front of it. The
 * repo is always the authority; this is a shortcut to the parts of it worth reading first.
 *
 * Empty facts render as '', so a repo nobody has learned yet reads exactly as it did before.
 */
export function renderRepoFacts(facts: RepoFacts | null): string {
  if (!facts || !hasFacts(facts)) return '';
  const section = (label: string, items: string[]) =>
    items.length ? `${label}:\n${items.map((i) => `- ${i}`).join('\n')}` : '';
  const parts = [
    section('Start reading here', facts.entryPoints),
    section('How it is laid out', facts.layout),
    section('Conventions this repo actually follows', facts.conventions),
    section('How it is checked', facts.testCommands),
  ].filter(Boolean);
  return `\n\nWHAT EARLIER RUNS WORKED OUT ABOUT THIS REPO — notes from a previous run at this same commit, kept so you do not pay to re-derive them. They are a shortcut, not an authority: the code in front of you is the truth, and anything here that disagrees with it is wrong and worth saying so.\n\n${parts.join('\n\n')}`;
}
