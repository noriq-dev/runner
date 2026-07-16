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
 * A leased workspace (RUN-50): the local filesystem path and the backend's own location are
 * DIFFERENT TYPES, never interchangeable.
 *
 * The trap this shape exists to prevent: Perforce depot paths (`//depot/proj/file.c`) satisfy
 * both `startsWith('/')` (RUN-42's exact bug) *and* `path.isAbsolute()` — RUN-42's fix — while
 * being no filesystem path at all. RUN-55 then met the trap in live data: a single `-Mj` resolve
 * object carries `clientFile` (filesystem) and `fromFile` (`//depot/…`) side by side. Git fuses
 * the two namespaces, which is exactly why a git-first design never notices. So the fusion is
 * unrepresentable here: one field is a path, the other is not even a string to this code.
 */
export interface Workspace {
  runId: string;
  /**
   * Where the agent's process works — cwd for the driver and for verify. A real filesystem
   * path, and the ONLY field here that is one.
   */
  localPath: string;
  /** Physically read-only lease (scope/verify) — defense-in-depth under the permission floor. */
  readOnly: boolean;
  /**
   * The snapshot this lease started from, in the backend's own id-space (git: a sha; Perforce:
   * a change number; Diversion: a commit id). An opaque token: hand it back to the SAME backend
   * as a ref, display it, never parse it.
   */
  baseId: string;
  /**
   * Where the work lives, in words — for logs, reports, and humans (git/Diversion: the run's
   * branch; Perforce: client + pending change). Display ONLY: the moment this becomes an
   * operand, it is `location` smuggled past the type system.
   */
  workRef: string;
  /**
   * Backend-owned state, opaque to everything outside the backend that minted it — `unknown`
   * so reaching in is a type error, not a code-review catch. Must stay JSON-serializable:
   * parked runs (RUN-30) persist the whole Workspace and hand it back on resume.
   */
  location: unknown;
}

export interface LeaseOptions {
  /** Scope runs get a physically read-only checkout (defense-in-depth). */
  readOnly?: boolean;
  /**
   * Lease from another Run's work instead of the repo's current state — how a verify run gets
   * the build's output (RUN-21). By run id, NOT by ref: how a run's work is named (a branch, a
   * shelved change) is the backend's own business.
   */
  fromRunId?: string;
}

export type IntegrateResult =
  | { ok: true }
  | {
      ok: false;
      conflicts: string[];
      /**
       * Where a human resolves this, when the backend's conflicts live server-side (Diversion:
       * the pending-merge page). Git never sets it — its conflicts are files an agent can edit.
       * A backend that sets it is saying "agent resolution is not possible here; send a person".
       */
      resolveUrl?: string;
    };

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
  dispose(ws: Workspace): Promise<void>;

  /** Did this Run actually produce anything — saved or not? A no-op run must not reach verify:
   *  a PASS over an empty tree would land the Run in review as a success with nothing in it. */
  hasWork(ws: Workspace): Promise<boolean>;

  /** Make the Run's work durable in the workspace, so it survives a reap and a human can review
   *  it. Returns false when there was nothing to save. Git commits locally; note a live backend
   *  checkpoints to the SERVER (`p4 shelve`) — accepted, documented in THREAT-MODEL.md. */
  checkpoint(ws: Workspace, message: string): Promise<boolean>;

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
  integrate(ws: Workspace, target: string): Promise<IntegrateResult>;

  /** Continue a conflicted integration after the agent edited the paths. */
  resumeIntegrate(ws: Workspace): Promise<IntegrateResult>;

  /** Put the workspace back the way it was before a failed integration. */
  abandonIntegrate(ws: Workspace): Promise<void>;

  /**
   * Land the workspace's state on `target` IFF the target hasn't moved — compare-and-swap,
   * never a merge commit. Losing the race is an expected result, not an error: report it and
   * let the caller re-integrate.
   *
   * Takes the WORKSPACE, not a ref: how a run's work is named (its branch, its pending change)
   * is `location`'s business, and the old `fromRef` parameter was the supervisor passing git's
   * branch name back in — the exact leak RUN-50 closes.
   */
  publish(ws: Workspace, target: string): Promise<PublishResult>;

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
