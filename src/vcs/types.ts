import type { WorktreeInfo } from '../worktree';

/**
 * The VCS seam (RUN-49): the nine outcomes the daemon needs from source control, named as
 * outcomes rather than git verbs. This is VCS-SPIKE.md §2 made real — the operation set was
 * *discovered, not designed*: RunSupervisor's `Pick<WorktreeManager>` already declared exactly
 * this list, so extracting it is a rename of a seam every test already injects through.
 *
 * Two shapes here were arrived at by being burned, and must survive any future backend verbatim:
 *
 *  - **`publish` is compare-and-swap, not write.** `{ok:false, reason:'race'}` is the honest
 *    result on every backend — git's `--ff-only`, Perforce's submit out-of-date check, and
 *    Diversion's server-side merge all lose the same race. A backend that papers over the race
 *    with a merge commit cannot implement this interface.
 *  - **`integrate` returns conflict PATHS, not a boolean.** The landing flow (RUN-27/28) hands
 *    them to the build agent to resolve; a backend that can only say "it conflicted" makes agent
 *    conflict-resolution impossible.
 *
 * Verbs deliberately absent: `rebase` (Diversion has none — merging the target IN also yields a
 * tree containing target + work, which is all `integrate` promises), and any bare `push`
 * (`share` exists, but as git's own publishing step — on a server-backed VCS, `publish` already
 * reached the server and `share` is meaningless).
 */

/**
 * A leased workspace. Today this is exactly git's WorktreeInfo — `branch` and `baseSha` are
 * git concepts leaking through the alias, and RUN-50 owns splitting it into a local filesystem
 * path + an opaque backend-owned location. Do not add fields here; add them there.
 */
export type Workspace = WorktreeInfo;

export interface LeaseOptions {
  /** Scope runs get a physically read-only checkout (defense-in-depth). */
  readOnly?: boolean;
  /** Base ref to lease from. Defaults to the repo's current state. */
  baseRef?: string;
}

export type IntegrateResult = { ok: true } | { ok: false; conflicts: string[] };

export type PublishResult =
  | { ok: true; sha: string }
  | { ok: false; reason: 'race' | 'error'; detail: string };

export type ShareResult = { ok: true } | { ok: false; detail: string };

/**
 * One VCS backend. Git today; Diversion (RUN-51) and Perforce (RUN-52) are the candidates the
 * shape was proven against on paper (VCS-SPIKE.md §3/§4) — pending the hands-on discoveries
 * (RUN-54/55) before either is built.
 *
 * The isolation model is the real split between backends (RUN-48), and it lives entirely inside
 * `lease`/`dispose`: git isolates in SPACE (a worktree costs nothing — mint per Run, destroy
 * after), a live backend isolates in TIME (the repo is large on purpose and the workspace is
 * server-side state, so runs take turns in a fixed pool, default 1). "One workspace per Run;
 * never two runs in one checkout" holds under both — it is what the exclusive lease MEANS. A
 * live backend's lease must eventually be a real cross-restart mutex; git's never needs one,
 * which is why none is built here — but the seam must not preclude it.
 */
export interface VcsBackend {
  /** Which backend this is. The one question a caller (init-project, logs) may ask without any
   *  of the supervisor's machinery. */
  readonly kind: string;

  /** Lease an isolated workspace, exclusively, for this Run. Git mints one; a live backend
   *  would wait its turn for one. */
  lease(repoRoot: string, runId: string, opts?: LeaseOptions): Promise<Workspace>;

  /** Give the workspace back. Git destroys it (worktree + never-shared branch); a live backend
   *  would CLEAN it (revert unopened, delete the pending change) and hand it back to the pool —
   *  which is why this is not named `remove`. Safe to call twice. */
  dispose(ws: Pick<Workspace, 'repoRoot' | 'path' | 'branch'>): Promise<void>;

  /** Did this Run actually produce anything — saved or not? A no-op run must not reach verify:
   *  a PASS over an empty tree would land the Run in review as a success with nothing in it. */
  hasWork(ws: Pick<Workspace, 'path' | 'baseSha'>): Promise<boolean>;

  /** Make the Run's work durable in the workspace, so it survives a reap and a human can review
   *  it. Returns false when there was nothing to save. Git commits locally; note a live backend
   *  checkpoints to the SERVER (`p4 shelve`) — accepted, documented in THREAT-MODEL.md. */
  checkpoint(ws: Pick<Workspace, 'path'>, message: string): Promise<boolean>;

  /** Does the landing target exist? (Tells "no landing branch yet" from a typo.) */
  targetExists(repoRoot: string, target: string): Promise<boolean>;

  /** Bring the landing target into existence at `from` — its first existence. */
  createTarget(repoRoot: string, target: string, from: string): Promise<void>;

  /**
   * Make the workspace contain the current target PLUS this Run's work — so what verify sees is
   * what will land — or say which paths collide. Git rebases; a backend without rebase may merge
   * the target in instead: the outcome (a combined tree, with the target an ancestor so
   * `publish` still fast-forwards) is the contract, not the verb.
   *
   * On conflict the integration is left IN PROGRESS so an agent can resolve the listed paths;
   * callers that don't resolve must `abandonIntegrate`.
   */
  integrate(ws: Pick<Workspace, 'path'>, target: string): Promise<IntegrateResult>;

  /** Continue a conflicted integration after the agent edited the paths. */
  resumeIntegrate(ws: Pick<Workspace, 'path'>): Promise<IntegrateResult>;

  /** Put the workspace back the way it was before a failed integration. */
  abandonIntegrate(ws: Pick<Workspace, 'path'>): Promise<void>;

  /**
   * Land the workspace's state on `target` IFF the target hasn't moved — compare-and-swap,
   * never a merge commit. Losing the race is an expected result, not an error: report it and
   * let the caller re-integrate.
   */
  publish(repoRoot: string, target: string, fromRef: string): Promise<PublishResult>;

  /**
   * Git's extra publishing step (RUN-27 `[land].autoPush`): push the landed target to its
   * remote — one explicit refspec, never force. Meaningless on a server-backed VCS, where
   * `publish` already reached the server; kept on the interface because the daemon's merge-
   * request flow (RUN-28) needs it, and a backend where it is a no-op may say `{ok:true}`.
   * Returns rather than throws: the work is already landed locally, so a failed share is news,
   * not a failure.
   */
  share(repoRoot: string, target: string, remote?: string): Promise<ShareResult>;

  /**
   * Crash recovery: find workspaces whose Run died with a previous daemon and clean them up —
   * EXCEPT any still holding work that exists nowhere else. Git reconstructs everything from
   * the local repo (the run id is in the branch name — no external state); a live backend's
   * registry is the server's, which is that backend's documented cost. Returns the count
   * actually removed.
   */
  reapOrphans(repoRoot: string, opts?: { onSkip?: (path: string) => void }): Promise<number>;
}
