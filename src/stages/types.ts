/**
 * The seam a stage sees (RUN-131).
 *
 * A stage is a function over a shared, mutable run context plus a HOST — the supervisor, narrowed
 * to the operations stages actually perform. The narrowing is the point: it is a written-down list
 * of everything the pipeline is allowed to do, so a new stage (RUN-140/141/144) is added against a
 * declared surface rather than against a 2,400-line class.
 *
 * The leaf implementations stay on the supervisor and are reached through this interface rather
 * than copied. `landRun`, `enforceLockFloor`, `reviewWithFeedback` and `verifyWithFeedback` are the
 * security-critical ones — a refactor that also rewrote them would be two changes wearing one
 * commit, and the ticket is explicit that this is a move.
 */

import type { LandPolicy, PermissionProfile, Run, RunBudget, RunPhase } from '@noriq-dev/shared';
import type { LedgerEntry } from '../adjudication';
import type { ContinuableRun, ContinuableStore } from '../continuable';
import type { AgentDriver, DriverExit, DriverSession, NoriqMcp } from '../drivers/types';
import type { LandOutcome } from '../land';
import type { LockConflict } from '../lock-client';
import type { logger as defaultLogger } from '../logger';
import type { AnchorTask, ResolvedRepo, RunReport, RunTally, SupervisorVcs } from '../supervisor';
import type { RunTranscript } from '../transcript';
import type { Workspace } from '../vcs/types';
import type { VerifyResult, VerifySpec } from '../verify';
import type { VerifyVerdict } from '../verify-agent';
import type { Workflow } from '../workflow';

/** What every stage may reach. Implemented by `RunSupervisor`. */
export interface StageHost {
  readonly log: typeof defaultLogger;
  /** Report a frame to the server (status, telemetry, phase). Best-effort by contract. */
  report(runId: string, frame: RunReport): void;
  /** Post to the anchor task, when there is one. A no-op without a comment sink. */
  postComment(projectId: string, taskId: string, body: string): void;
  transcript(runId: string): RunTranscript;
  /** Close and forget a run's transcript — the stream a human reads has to END (RUN-74). */
  endTranscript(runId: string, outcome: string): void;
  vcsFor(repo: ResolvedRepo): SupervisorVcs;
  /** The branch a run's locks are scoped to. */
  lockScopeBranch(repo: ResolvedRepo, run: Run): string | null;
  /** One landing at a time per repo — rebase→verify→fast-forward is a read-modify-write. */
  withRepoLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T>;
  /** RUN-102's hard floor: lock everything the build changed, before it can land. */
  enforceLockFloor(
    repo: ResolvedRepo,
    run: Run,
    ws: Workspace,
    token: string,
  ): Promise<readonly LockConflict[]>;
  /** The deterministic floor, with RUN-29's hand-back to the live session on a failure. */
  verifyWithFeedback(ctx: {
    run: Run;
    spec: VerifySpec;
    cwd: string;
    session: DriverSession;
    /** The phase to return to between fix turns — 'verifying' on the standalone gate,
     *  'landing' when this runs inside the landing pipeline (RUN-31). */
    phase: RunPhase;
  }): Promise<VerifyResult>;
  /** The inline reviewer and its bounded fix rounds (RUN-61/79). */
  reviewWithFeedback(ctx: {
    run: Run;
    repo: ResolvedRepo;
    worktree: Workspace;
    driver: AgentDriver;
    session: DriverSession;
    task: AnchorTask | null;
    tally: RunTally;
    getSessionText?: () => string;
    budget?: RunBudget;
    priorLedger?: LedgerEntry[];
  }): Promise<VerifyVerdict & { rounds: number; ledger: LedgerEntry[] }>;
  /** Rebase onto the landing branch, re-verify there, fast-forward, and (opt-in) push. */
  landRun(ctx: {
    run: Run;
    repo: ResolvedRepo;
    worktree: Workspace;
    policy: LandPolicy;
    task: AnchorTask | null;
    driver: AgentDriver;
    permission: PermissionProfile;
    noriqMcp?: NoriqMcp;
    budget?: RunBudget;
    tally: RunTally;
    session?: DriverSession;
  }): Promise<LandOutcome>;
  /** The run's effective budget: the dispatch's, else the machine default. */
  runBudget(run: Run): RunBudget | undefined;
  /** The continuation store, when one is wired. Absent = no continue-a-failed-run support. */
  readonly continuable?: Pick<ContinuableStore, 'get' | 'put' | 'remove'>;
}

/**
 * The context stages read and write.
 *
 * Mutable on purpose, and only in the four fields below. A stage's whole effect on the run's fate
 * is `exit`, `driverSucceeded`, `landed`, and `ledger` — everything else is the sitting's fixed
 * facts. Keeping the mutable set this small is what makes the sequence readable: the questions
 * "what can this stage change?" and "what does the next one see?" have a four-item answer.
 */
export interface RunPipeline {
  // ── fixed for the sitting ────────────────────────────────────────────────────
  readonly run: Run;
  readonly repo: ResolvedRepo;
  readonly worktree: Workspace;
  readonly driver: AgentDriver;
  readonly permission: PermissionProfile;
  readonly noriqMcp?: NoriqMcp;
  readonly task: AnchorTask | null;
  readonly runAgent: { agentId: string; token: string };
  readonly session: DriverSession;
  readonly stopSession: () => Promise<void>;
  readonly tally: RunTally;
  /** The agent's accumulated output — the verify actor's verdict is parsed from it. */
  readonly sessionText: string;
  /** Live accessor for the same output, which keeps growing through fix turns (RUN-79). */
  readonly getSessionText?: () => string;
  readonly tail: string;
  /** The prior sitting's state on a "continue a failed run" (RUN-92). */
  readonly continued: ContinuableRun | null;
  readonly workflow: Workflow;

  // ── the four a stage may move ────────────────────────────────────────────────
  /** The run's fate so far. A gate narrows it; nothing ever widens it back to done. */
  exit: DriverExit;
  /** Did the DRIVER succeed — which decides whether the workspace is kept for a human. */
  driverSucceeded: boolean;
  /** Has the diff reached the integration branch. Once it has, the workspace is disposable. */
  landed: boolean;
  /** The freshest adjudication state, for the continuable record. */
  ledger: LedgerEntry[];
  /**
   * Whether this run is landing, and under which policy — captured ONCE by `verify`, at the same
   * point the pipeline used to capture it, and read by `integrate` afterwards.
   *
   * A snapshot rather than two reads of `repo.manifest.land`, and that is not fussiness: the
   * manifest is re-read per run (RUN-?), `ResolvedRepo` hands it over as a mutable object, and a
   * manifest that changed between the two reads would produce a run that skips the deterministic
   * floor AND skips landing — or one that runs the floor and then lands anyway. Reading it twice
   * makes the pipeline's shape depend on a file nobody promised would hold still.
   */
  landPolicy: LandPolicy | null;
}

/** A stage: it reads the context, does its work, and may narrow the run's fate. */
export type StageImpl = (host: StageHost, ctx: RunPipeline) => Promise<void>;
