import type { IndexSource } from '../index-source';
import type { LockConflict, LockGrant } from '../lock-client';

/**
 * The VCS seam (RUN-49): the nine outcomes the daemon needs from source control, named as
 * outcomes rather than git verbs. This is VCS-SPIKE.md §2 made real — the operation set was
 * *discovered, not designed*: RunSupervisor's `Pick<WorktreeManager>` already declared exactly
 * this list, so extracting it is a rename of a seam every test already injects through.
 * (`openReview` joined later — RUN-85, the RUN-28 merge-request flow asked backend-neutrally —
 * by the same discovery route: daemon.ts was already doing it, git-only, outside the seam.
 * `integrateFromRun`/`publishToRun` joined at RUN-170: the same two contracts with the other
 * side named BY RUN ID, so a wave's child step can return to its parent run's line without a
 * ref ever crossing the seam.)
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

/**
 * A read-only lease over the repo's tree for BACKGROUND INDEXING (RUN-211) — never for an agent.
 * Repeats `Workspace`'s type discipline exactly, for the reason `Workspace`'s own comment gives:
 * `localPath` is the only field here that is EVER a filesystem path (and is now optional — see
 * `source`), `baseId` is an opaque token in the owning backend's id-space, and `location` is
 * backend-owned `unknown` state, so reaching in is a type error rather than a code-review catch.
 * No ref, branch (beyond the display-only field below), or sha field is added that common code
 * could pass back to a backend as an operand —
 * RUN-50's trap applies here verbatim: a Perforce depot path satisfies both `startsWith('/')` and
 * `path.isAbsolute()` while being no filesystem path at all, and git fuses the two namespaces so a
 * git-first design never notices. The fusion has to stay unrepresentable, not merely discouraged.
 */
export interface IndexSnapshot {
  /**
   * How the indexer READS this snapshot (RUN-252/254/255). The one field a caller needs, and the
   * reason `localPath` below is no longer it: a snapshot's job is to hand over a source, not to
   * promise a directory.
   *
   * Requiring a filesystem path was the seam bug that made both live backends answer
   * `unsupported` (RUN-211). It forced every backend to MATERIALIZE a full tree first — on a
   * deliberately-large Perforce depot the single most expensive thing that could be asked of it —
   * when both live backends can serve file content at a revision far more cheaply: Perforce reads
   * the depot with no client workspace at all, and Diversion reads its REST API with no checkout.
   * Neither needs to write a byte to disk, and neither should have to.
   */
  source: IndexSource;
  /**
   * Where this snapshot materialized a tree, IF it did — for logs and diagnostics only. Absent on
   * a backend that materializes nothing (Perforce's depot, Diversion's API), and a real filesystem
   * path when present, the ONLY field here that is one.
   *
   * Optional rather than a union arm deliberately: every consumer reads `source`, so a discriminant
   * would make callers narrow a shape they never branch on. Absent-means-nothing-on-disk is a fact
   * a log line wants and the indexer does not.
   */
  localPath?: string;
  /**
   * The snapshot's base, in the backend's own id-space. `Workspace.baseId`'s contract verbatim:
   * an opaque token, hand it back to the SAME backend as a ref, display it, never parse it.
   */
  baseId: string;
  /**
   * Reported scope, in words — for logs and the index generation manifest's `branch` field.
   * `Workspace.workRef`'s exact status, not a looser one: display ONLY, and the moment this
   * becomes an operand it is `location` smuggled past the type system. Shared's
   * `IndexGenerationManifest.branch` is a `BranchRef` the server stores as the scope a `baseId`
   * is fresh against, and its own definition admits a symbolic class ("default", "integration")
   * where no single branch applies — this is that scope metadata crossing the wire, not a ref
   * crossing the seam. Absent when the backend's snapshot has no branch at all (git: detached, by
   * design — see `VcsBackend.leaseIndexSnapshot`).
   */
  branch?: string;
  /**
   * Intent, not enforcement (discretion note 8 in RUN-211's spec): no backend chmods this tree.
   * The invariant is structural instead — no agent ever runs in an index snapshot, the indexer
   * opens files `O_RDONLY` through `openConfined`, and a snapshot (detached, or a pool-of-1
   * backend's idle workspace) can land nothing — so a full recursive chmod would pay a
   * monorepo-sized tree walk to defend a property nothing here can violate. Always `true` on an
   * `ok:true` acquisition result; kept as a field (not dropped) so a caller reads intent without
   * having to know that fact about every backend.
   */
  readOnly: true;
  /** Backend-owned state, opaque to everything outside the backend that minted it — see
   *  `Workspace.location`'s comment; the same reasoning applies verbatim. Unlike `Workspace`,
   *  never round-trips through JSON (a snapshot is never parked), so it carries no
   *  serializability obligation of its own. */
  location: unknown;
}

/**
 * The outcome of asking for an index snapshot (RUN-211). A discriminated result, never a throw,
 * for the two ROUTINE conditions: `busy` (a backend whose leases cannot overlap is occupied —
 * indexing yields to a run, not the other way round) and `unsupported` (this backend cannot
 * produce a read-only snapshot at all). The same judgement `publish`'s `{ok:false,
 * reason:'race'}` already records: indexing is background work, so "not now" is an expected
 * outcome, and a throw would make a routine, correct condition look like a fault. A backend's own
 * infra failures (a git command that genuinely errors) still reject the promise, exactly as
 * `lease` does today — this union is for outcomes a caller is meant to branch on, not for faults.
 */
export type IndexSnapshotResult =
  | { ok: true; snapshot: IndexSnapshot }
  | { ok: false; reason: 'busy' | 'unsupported'; detail?: string };

/**
 * The outcome of `VcsBackend.changesBetween` (RUN-212) — named as an OUTCOME, never a bare diff:
 * either "here is what moved" or "ask me for everything". The two arms must never be confused
 * (locked decision 1): an empty diff and "I could not tell" are the same SHAPE and opposite
 * MEANINGS, and the wrong one is silent — an index kept serving a stale generation while every
 * consumer believes it is current. This is `hasWork`'s rule one verb over, for a caller that acts
 * CREDULOUSLY on the answer (skips re-indexing) rather than destructively — just as bad, and
 * harder to notice, because nothing crashes.
 *
 * `{ok:true}` with both lists empty is a REAL, DISTINCT answer meaning nothing changed (locked
 * decision 2) — not a stand-in for "could not tell". Every backend that cannot relate two bases
 * with confidence — unrelated histories, a base it can no longer resolve, an ambiguous
 * relationship, a query that errored, a rename it cannot express, or a change set past this
 * backend's own bound — answers `full-index-required` instead, never an empty or partial list.
 *
 * A RENAME is a deletion of the old path PLUS a change at the new path (locked decision 3) —
 * never its own arm, never a from/to pair. The index is path-keyed (the server's generation
 * carries `deletions: RepoPath[]` and file records by path), so an undecomposed rename would
 * leave the old path in the index forever, describing a file that no longer exists. Whether a
 * backend detected a rename via a similarity heuristic must not change the index's contents —
 * only which of these two lists a path lands in.
 */
export type ChangesBetweenResult =
  | { ok: true; changed: string[]; deleted: string[] }
  | { ok: false; reason: 'full-index-required'; detail: string };

export interface LeaseOptions {
  /** Scope runs get a physically read-only checkout (defense-in-depth). */
  readOnly?: boolean;
  /**
   * Lease from another Run's work instead of the repo's current state — how a verify run gets
   * the build's output (RUN-21). By run id, NOT by ref: how a run's work is named (a branch, a
   * shelved change) is the backend's own business.
   */
  fromRunId?: string;
  /**
   * Fork from a named landing TARGET (the plan's / integration working branch) when it exists,
   * instead of the repo's current state (RUN-82). This is how a later task in a plan sees its
   * predecessors' landed work: they land on `[land].branch`, so a run based there starts from
   * that accumulation and its landing rebase is a trivial fast-forward — without it a later task
   * forks from a stale main, cannot see the work it builds on, and its review diff double-counts
   * it. A landing target, named the same way `targetExists`/`createTarget`/`integrate` name one
   * (a string the backend interprets); a live backend leases from that target's own state.
   *
   * Ignored together with `fromRunId`: a verify run leases from the build it judges, never a
   * branch. The caller passes this ONLY when the target already exists — the backend may assume
   * it does.
   */
  fromTarget?: string;
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
 * What `openReview` (RUN-85) needs, said backend-neutrally. `head` and `base` are
 * backend-interpreted strings in exactly the register `targetExists`/`createTarget` use for
 * `target` — git reads branches, a server-backed VCS reads whatever names its lines.
 */
export interface ReviewRequest {
  /** The plan's working target holding the landed work — already shared, where sharing exists. */
  head: string;
  /** The protected target, named by the repo's manifest (`[land].mergeTarget`). Never by a dispatch. */
  base: string;
  planTitle: string;
  planKey: string;
}

/**
 * The outcome of asking for an onward review (RUN-85). Field contracts are MergeRequestResult's,
 * kept verbatim — the daemon's reconcile path branches on them.
 */
export interface ReviewResult {
  ok: boolean;
  /** Where the review lives, when one was opened (git: the PR URL). */
  url?: string;
  /** Why it could not be opened. Never throws — a plan's work is landed and pushed either way. */
  detail?: string;
  /** The command a human can run, when we could not. */
  command?: string;
}

/**
 * What a lock op needs beyond the workspace (RUN-98): which project, whose identity holds the
 * lock, the scope branch, and the task to auto-release against.
 *
 * `token` is the RUN's bound agent token (RUN-43), NOT the daemon's — so the daemon's
 * predictive acquire and the in-agent hook's reactive acquire share ONE holder and never fight
 * each other, and the server's auto-release-on-task-settle covers cleanup (RUN-97 §2).
 */
export interface LockContext {
  projectId: string;
  token: string;
  /** Scope branch = the run's LANDING TARGET, not its throwaway worktree branch (RUN-97 §5).
   *  null/absent → lock across all branches. */
  branch?: string | null;
  /** Link locks to the anchor task so they auto-release when it settles. */
  taskId?: string | null;
}

/**
 * The outcome of an acquire. `enabled:false` on an `ok:true` result means the project has file
 * locking turned OFF — a no-op grant the caller proceeds past, distinct from a real grant. A
 * conflict is all-or-nothing: nothing was taken, and `conflicts` names who to coordinate with.
 */
export type LockOutcome =
  | { ok: true; enabled: boolean; locks: LockGrant[] }
  | { ok: false; conflicts: LockConflict[] };

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

  /**
   * True when `dispose` makes unlanded work durable itself (Diversion: the branch is already
   * server-side; Perforce: dispose shelves before cleaning) — so the caller may ALWAYS dispose.
   *
   * Exists because git's keep-the-work shape is the opposite: its dispose DESTROYS, so the
   * supervisor keeps an unlanded build by *skipping* dispose — and on a pool-of-1 backend that
   * skip holds the lease forever and wedges every later run on the repo. The flag lets each
   * backend say which shape it is; absent means git's (skip to keep).
   */
  readonly disposePreservesWork?: boolean;

  /**
   * True when this backend can hold MANY leases at once — git isolates in SPACE (a worktree
   * per lease costs nothing), so a wave's overlapping steps may each take one (RUN-170).
   *
   * Absent means leases take turns (the live backends' pool-of-1 queue, RUN-48) — and on such
   * a backend overlap is not merely slow but a DEADLOCK: a child lease taken while the parent
   * holds the pool blocks forever, in-process, with nothing to time out. The wave scheduler
   * reads this flag and runs the same wave sequentially instead, which is always a correct way
   * to do the work. Absent is deliberately the unsafe-to-overlap reading, so a new backend
   * gets the conservative behaviour without knowing this flag exists.
   */
  readonly leasesOverlap?: boolean;

  /** Lease an isolated workspace, exclusively, for this Run. Git mints one; a live backend
   *  would wait its turn for one. */
  lease(repoRoot: string, runId: string, opts?: LeaseOptions): Promise<Workspace>;

  /** Give the workspace back. Git destroys it (worktree + never-shared branch); a live backend
   *  would CLEAN it (revert unopened, delete the pending change) and hand it back to the pool —
   *  which is why this is not named `remove`. Safe to call twice. */
  dispose(ws: Workspace): Promise<void>;

  /**
   * Did this Run actually produce anything — saved or not? A no-op run must not reach verify:
   * a PASS over an empty tree would land the Run in review as a success with nothing in it.
   *
   * **`false` means "there is no work", never "the query failed"** (RUN-152). A backend that
   * cannot tell must REJECT. Both callers act destructively on `false` — one disposes a workspace
   * (git's dispose is `worktree remove --force` plus `branch -D` on a never-pushed branch), the
   * other reports the run a no-op and reaps it — so answering "no work" on an error is a fail-open
   * on a decision that destroys the only copy of a continuation's committed diff.
   *
   * A rejection rather than a third `'unknown'` result, deliberately: a string union would make
   * the destructive branch reachable by accident, since `if (await hasWork(ws))` is truthy for
   * `'none'` just as it is for `'unknown'`. A rejection cannot be ignored by omission, and it
   * carries the underlying error for the log.
   */
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
   * `integrate`, with the base named BY RUN ID (RUN-170): make the workspace contain run
   * `runId`'s current work PLUS this workspace's own — how a wave's child step picks up the
   * parent run's accumulated line before landing back on it. By run id, NOT by ref, symmetric
   * with `LeaseOptions.fromRunId`: how a run's work is named (a branch, a shelved change) is
   * the backend's own business, and a ref parameter here would reopen the exact leak RUN-50
   * closed — `publish`'s old `fromRef` was the supervisor passing git's branch name back in.
   *
   * Same conflict contract as `integrate`: PATHS, left IN PROGRESS for an agent to resolve;
   * callers that don't resolve must `abandonIntegrate`. A backend whose leases cannot overlap
   * (`leasesOverlap` absent) never legitimately receives this call — its waves run
   * sequentially in one workspace — and refuses loudly rather than guess at a line it has no
   * name for.
   */
  integrateFromRun(ws: Workspace, runId: string): Promise<IntegrateResult>;

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
   * `publish`, with the target named BY RUN ID (RUN-170): land the workspace's state on run
   * `runId`'s line IFF that line hasn't moved — compare-and-swap, never a merge commit,
   * `publish`'s contract verbatim. This is the child→parent return trip of a concurrent wave,
   * and the CAS is what serializes two children finishing together: the loser gets
   * `{ok:false, reason:'race'}`, re-runs `integrateFromRun`, and retries — the same race the
   * landing flow already handles against `[land].branch`. Run-id addressed for
   * `LeaseOptions.fromRunId`'s reason: no ref crosses the seam.
   */
  publishToRun(ws: Workspace, runId: string): Promise<PublishResult>;

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
   * Open the plan's onward review from `head` into `base` — RUN-28's merge request, named as an
   * outcome (RUN-85). Git shells the operator's `gh`, in the DAEMON, after the gate
   * (merge-request.ts holds the credential rationale). A server-backed VCS, where `gh` is not
   * the review surface and no review API has been measured, answers honestly that review
   * happens in its own tool: `{ok:false}` with a `detail` naming the backend and where a human
   * acts — so the caller warns and records instead of silently doing nothing, which is the
   * exact defect RUN-85 closes.
   *
   * REQUIRED, not optional — share()'s pattern, not `lock?`'s, deliberately: the daemon asks
   * this of every backend at plan completion, and an omitted method would BE the silence this
   * verb exists to remove. Required forces each future backend to say where review happens.
   * Returns rather than throws: the work is landed (and shared, where sharing exists) either way.
   */
  openReview(repoRoot: string, review: ReviewRequest): Promise<ReviewResult>;

  /**
   * Crash recovery: find workspaces whose Run died with a previous daemon and clean them up —
   * EXCEPT any still holding work that exists nowhere else. Git reconstructs everything from
   * the local repo (the run id is in the branch name — no external state); a live backend's
   * registry is the server's, which is that backend's documented cost. Returns the count
   * actually removed.
   *
   * `isOwned` names the runs THIS daemon still holds, so the sweep can also run periodically
   * (RUN-153) rather than only at startup. At startup it is never needed — every prior process is
   * gone — but mid-flight a live run's workspace looks exactly like a leaked one and may be
   * legitimately empty, so nothing else can tell them apart. Absent = the startup meaning.
   */
  reapOrphans(
    repoRoot: string,
    opts?: { onSkip?: (path: string) => void; isOwned?: (runId: string) => boolean },
  ): Promise<number>;

  /**
   * Acquire a read-only snapshot of the repo's tree for indexing (RUN-211) — never for an agent.
   * REQUIRED, not optional: `openReview`'s precedent, stated in its own doc, applies verbatim —
   * an omitted method would BE the silence this verb exists to remove, and a backend that cannot
   * produce a snapshot says so with `{ok:false, reason:'unsupported'}` rather than by absence.
   *
   * Concurrency is preserved PER BACKEND, deliberately not uniform — the same isolation split
   * `leasesOverlap` names for run leases, one verb over: git isolates in SPACE, so a snapshot
   * costs nothing extra and many may be held at once, overlapping run leases freely. A live
   * backend's pool-of-1 (`leasesOverlap` absent) must TRY-ACQUIRE and never enqueue — a snapshot
   * requested while the SAME process holds a run lease is exactly when indexing is triggered
   * (after landing or publishing), so chaining onto that queue is `integrateFromRun`'s documented
   * deadlock shape one verb over: an in-process promise chain with nothing to time out. Refusing
   * outranks waiting for a second reason too: run execution outranks background indexing.
   */
  leaseIndexSnapshot(repoRoot: string): Promise<IndexSnapshotResult>;

  /**
   * Give a snapshot back. IDEMPOTENT (a second call is a no-op) and structurally incapable of
   * touching a Run workspace: it removes only a snapshot IT minted, identified through its own
   * `location`, and refuses anything else — a `Workspace`, or a hand-edited object — with a
   * message naming the problem, the way `gitLocation` already refuses a foreign workspace.
   * `IndexSnapshot` and `Workspace` are structurally close enough (both carry
   * `localPath`/`baseId`/`readOnly`/`location`) that a `Workspace` variable satisfies this
   * parameter's TYPE by ordinary structural typing — so this runtime check is the only thing
   * standing between a foreign object and whatever destructive op the backend performs.
   * REQUIRED for the same reason `leaseIndexSnapshot` is: a backend that answers `unsupported` to
   * every acquisition still has to say what release does with an object it could never have
   * minted, which is refuse it, not silently succeed.
   */
  releaseIndexSnapshot(snapshot: IndexSnapshot): Promise<void>;

  /**
   * Relate two opaque bases in THIS backend's own id-space and report what moved between them —
   * for background indexing (RUN-212), never for an agent. `ChangesBetweenResult`'s doc carries
   * the full outcome contract; this doc carries the interface-level obligations.
   *
   * REQUIRED, not optional — `openReview`'s precedent, stated in its own doc, applies verbatim
   * (locked decision 5): an omitted method reads as "nobody thought about this backend", while a
   * present method that refuses records that it WAS considered and why, and leaves the note
   * where a future implementer will be standing. Git answers this precisely (`worktree.ts`'s
   * `changesBetween`, the git half of this contract); Diversion and Perforce refuse with
   * `full-index-required` and a `detail` naming the backend and what a real implementation would
   * need. Callers treat both identically, so requiring the method everywhere costs nothing and
   * the information it carries when refused is not nothing.
   *
   * Common code — everything outside `git.ts`/`worktree.ts` — never assumes a SHA, a branch
   * name, a numeric ordering, or an ancestry direction from `from`/`to` (locked decision 6):
   * they are opaque tokens, exactly `Workspace.baseId`'s contract, handed to the SAME backend
   * that minted them and never interpreted by a caller. A caller that sorted the two, or assumed
   * `from` is an ancestor of `to`, would work on git and silently invert — or simply have no
   * meaning — on a backend where ids are not ordered at all.
   *
   * Paths in both of `ChangesBetweenResult`'s lists are repository-relative with FORWARD
   * SLASHES, matching what `src/index-scan.ts` produces and what the sensitive-file deny list
   * matches on (locked decision 7): these lists join to the scanner's output and to
   * `IndexGenerationManifest.deletions`, and two spellings of one path would silently double-
   * count on Windows — `comparableWorktreePath`'s exact concern, one layer up.
   */
  changesBetween(repoRoot: string, from: string, to: string): Promise<ChangesBetweenResult>;

  /**
   * Lock capability (RUN-98), OPTIONAL on the seam: a backend with no lock layer omits it, and
   * callers treat absence as "no enforcement here" — exactly how the supervisor treats its other
   * optional deps (checkClaimable, getParkState). The three shipped backends implement it:
   *  - git has no native lock → delegates to Noriq's lock primitive (the common case);
   *  - Perforce/Diversion use their native locks and mirror into the Noriq view for a unified
   *    dashboard.
   * Uniform to the supervisor either way (RUN-97 §1).
   */

  /** Acquire exclusive locks over `paths` for this Run, all-or-nothing. A conflict returns
   *  `{ ok:false, conflicts }` and takes nothing; a locking-disabled project returns
   *  `{ ok:true, enabled:false }`. Re-acquiring one's own paths renews them. */
  lock?(ws: Workspace, paths: string[], ctx: LockContext): Promise<LockOutcome>;

  /** Release locks this Run holds — by grant id or by the exact paths taken. Safe with nothing
   *  held (already auto-released on task settle, or expired). */
  unlock?(ws: Workspace, sel: { lockIds?: string[]; paths?: string[] }, ctx: LockContext): Promise<void>;

  /** Look without taking (read-only): who holds locks colliding with `paths` on the scope
   *  branch, and which are already ours. The dispatch-time precheck (RUN-103) runs BEFORE any
   *  lease, so this takes `repoRoot`, not a Workspace. */
  queryLocks?(
    repoRoot: string,
    paths: string[],
    ctx: LockContext,
  ): Promise<{ enabled: boolean; conflicts: LockConflict[]; mine: LockGrant[] }>;

  /** The repo-relative paths this Run touched (uncommitted + committed since its base) — the
   *  hard-floor lock gate acquires them before the diff is made durable (RUN-102). Optional: a
   *  backend that cannot enumerate them omits it and the floor is skipped for that backend. */
  changedPaths?(ws: Workspace): Promise<string[]>;

  /** Release EVERY lock this Run holds, on its terminal path (RUN-104) — prompt cleanup so peers
   *  unblock sooner. For a task-anchored run the server also auto-releases on task settle, and
   *  TTL covers a crash, so this is promptness, not correctness. */
  releaseRunLocks?(ws: Workspace, ctx: LockContext): Promise<void>;
}
