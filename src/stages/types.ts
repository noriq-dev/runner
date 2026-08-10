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

import type {
  EffortEpisode,
  LandPolicy,
  PermissionProfile,
  Run,
  RunBudget,
  RunPhase,
  UploadedEpisodeIntelligence,
} from '@noriq-dev/shared';
import type { AcceptanceItem, AcceptanceReport } from '../acceptance';
import type { LedgerEntry } from '../adjudication';
import type { VerifiedContextPack } from '../citation-verify';
import type { ContextPackRetrieval } from '../context-pack';
import type { ContinuableRun, ContinuableStore } from '../continuable';
import type { AgentDriver, DriverExit, DriverSession, NoriqMcp } from '../drivers/types';
import type { LandOutcome } from '../land';
import type { logger as defaultLogger } from '../logger';
import type { DeliveredSteer } from '../steering';
import type {
  AnchorTask,
  LockFloorOutcome,
  ResolvedRepo,
  RunReport,
  RunTally,
  SupervisorVcs,
} from '../supervisor';
import type { RunTranscript } from '../transcript';
import type { Workspace } from '../vcs/types';
import type { CommandObservation, VerifyResult, VerifySpec } from '../verify';
import type { VerifyVerdict } from '../verify-agent';
import type { Workflow } from '../workflow';

/** What every stage may reach. Implemented by `RunSupervisor`. */
export interface StageHost {
  /** Drop a terminal run's cancellation record (RUN-165). Optional: a caller with no steering
   *  bridge has none to drop. */
  forgetCancellation?(runId: string): void;
  /** A run reaching `settle` has terminated WITHOUT parking (a successful park returns before this
   *  stage). If the server still holds an open blocked question for it, that question is orphaned —
   *  tell the server it died with the run so no `blocked` signal is left standing (RUN-199).
   *  Best-effort and self-probing: absent deps or any failure is a silent no-op. */
  abandonOrphanedSignal(runId: string): Promise<void>;
  readonly log: typeof defaultLogger;
  /** Report a frame to the server (status, telemetry, phase). Best-effort by contract. */
  report(runId: string, frame: RunReport): void;
  /** Post to the anchor task, when there is one. A no-op without a comment sink. */
  postComment(projectId: string, taskId: string, body: string): void;
  transcript(runId: string): RunTranscript;
  /** Close and forget a run's transcript — the stream a human reads has to END (RUN-74). */
  /** Close the run's transcript and return the seq a NEXT sitting must number from (RUN-183).
   *  Returned rather than counted by the caller: closing flushes whatever was buffered AND appends
   *  a terminal milestone, so "one more than before" is not reliably true. */
  endTranscript(runId: string, outcome: string): number;
  vcsFor(repo: ResolvedRepo): SupervisorVcs;
  /** The branch a run's locks are scoped to. */
  lockScopeBranch(repo: ResolvedRepo, run: Run): string | null;
  /** One landing at a time per repo — rebase→verify→fast-forward is a read-modify-write. */
  withRepoLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T>;
  /** RUN-102's hard floor: lock everything the build changed, before it can land. */
  enforceLockFloor(repo: ResolvedRepo, run: Run, ws: Workspace, token: string): Promise<LockFloorOutcome>;
  /** The deterministic floor, with RUN-29's hand-back to the live session on a failure.
   *  `attempts` (RUN-225) is how many times the command actually ran inside this ONE call — the
   *  initial try plus every hand-back retry — folded rather than itemized (see `CommandObservation`
   *  on why the site plus the final outcome is what a reader needs). */
  verifyWithFeedback(ctx: {
    run: Run;
    spec: VerifySpec;
    cwd: string;
    session: DriverSession;
    /** The run's tally (RUN-133) — a hand-back turn's seconds are charged to it. */
    tally: RunTally;
    /** The phase to return to between fix turns — 'verifying' on the standalone gate,
     *  'landing' when this runs inside the landing pipeline (RUN-31). */
    phase: RunPhase;
  }): Promise<VerifyResult & { attempts: number }>;
  /**
   * The inline reviewer and its bounded fix rounds (RUN-61/79).
   *
   * `rounds` counts FIX rounds spent (the existing spend-accounting meaning every caller already
   * relies on — untouched). `looks` (RUN-225) is a distinct, additive count: every actual reviewer
   * invocation, including the first look and the contest turn's re-adjudication, so a run that
   * passed on its first look reads `looks: 1` rather than being indistinguishable from a run that
   * never reviewed at all (`rounds: 0` in both cases — the exact undercount `episode.ts` names).
   */
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
    /** The numbered acceptance criteria this gate must answer (RUN-145). */
    acceptance?: AcceptanceItem[];
    acceptanceOverflow?: number;
    /** The requirement ids a finding may name (RUN-147). */
    requirements?: string[];
    /** Whether the deterministic command has ALREADY run when this reviewer is asked (RUN-177).
     *  False on the landing path, where it runs after the review, against the rebased result. */
    verifyRan?: boolean;
    /** The run's Noriq connection — the reviewer gets the escalation pair through it, no more. */
    noriqMcp?: NoriqMcp;
    /** The run's agent identity, so a reviewer that pauses the run can be parked under it. */
    runAgent?: { agentId: string; label: string; token: string };
    /** A deterministic re-check inside a fix round ran the floor command again (RUN-225) — the
     *  caller records it, since it is a real command the daemon watched exit and would otherwise
     *  vanish with the round's own local state. Optional: a caller with no episode to build (a
     *  test, a future actor that does not care) simply does not get told. */
    onCommandObserved?: (o: CommandObservation) => void;
    /** RUN-231: the run's verified context pack — rendered fresh every round through the
     *  reviewer-audience quoted-evidence frame. Absent/null → no memory block. */
    verifiedContextPack?: VerifiedContextPack | null;
  }): Promise<VerifyVerdict & { rounds: number; ledger: LedgerEntry[]; looks: number }>;
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
  /**
   * A landing just moved `branch` to `sha` on this repo (RUN-222) — background indexing's one
   * landing/publish trigger site. Fire-and-forget by construction: this returns nothing for the
   * caller to await, and the one implementation swallows every failure internally (`IndexTriggerHub
   * .onLanded`'s own doc) — a landing's own outcome must never depend on whether indexing noticed.
   * Absent = no index trigger layer wired (indexing off machine-wide, or a test with nothing to
   * prove here).
   */
  onLanded?(repo: ResolvedRepo, branch: string, sha: string): void;
  /**
   * Hand a freshly assembled effort episode (RUN-224) to whatever wants it. Absent = no sink wired
   * — every host today: delivery (RUN-227) is blocked on PLNR-340 and is not this task's to build.
   * The seam exists so a later delivery layer attaches HERE without reshaping `settleStage` or
   * `buildEpisode` — the same discipline `onLanded` above already established for a trigger nobody
   * had written yet.
   *
   * `intelligence` (RUN-284) rides as a second, independent argument rather than a field on
   * `episode` — the same split `UploadEpisodeInput`/`PendingEpisode` make, because
   * `EffortEpisode.intelligence` stays the FULL server-owned shape and this is the narrow
   * daemon-assertable one (see `intelligence-payload.ts`'s module doc). Undefined whenever `settle`
   * assembled nothing intelligence-shaped for this sitting.
   */
  recordEpisode?(episode: EffortEpisode, intelligence?: UploadedEpisodeIntelligence): void;
  /**
   * Drain this run's observed steer deliveries (RUN-225) — `SteeringBridge`'s own record of what
   * `applySteer` actually did, not the server's independent `steers`-table view. Absent = no
   * steering bridge wired (a test, or a daemon started with steering off); `settle` treats that the
   * same as a bridge that answers `[]` — both mean "nothing observed", never "unknown".
   */
  steeringHistory?(runId: string): DeliveredSteer[];
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
  readonly runAgent: { agentId: string; label: string; token: string };
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
  /** The spec's acceptance criteria, numbered, for the gate to answer one by one (RUN-145).
   *  Empty when the run carries no spec — which is most runs, and the gate then judges in prose
   *  exactly as it did before. */
  readonly acceptance: AcceptanceItem[];
  /** Criteria the spec named beyond what a checklist carries, so the gate can say its list was
   *  incomplete rather than reporting on a contract that was quietly truncated. */
  readonly acceptanceOverflow: number;
  /** The requirement ids this work is traceable to (RUN-147) — what a finding may name, and what
   *  the run reports against when it ends. Empty when the spec names none. */
  readonly requirements: string[];
  /**
   * RUN-228's retrieved task context pack, carried forward from `prepare` UNCHANGED — the seam
   * RUN-229 (worktree citation verification) and RUN-230/231 (the bounded quoted-evidence
   * renderer) attach to. Untrusted server text until both have run: no stage between here and
   * those may fold `.pack` into any prompt (this task's own locked decision). Absent on a
   * RESUMED run — `resume` has no `prepare` (this file's own doc: a parked run restores its
   * state rather than re-preparing), so nothing here fetched one; RUN-229/230 read this as
   * "nothing to verify or render", the same posture an unopted-in repo already produces.
   */
  readonly contextPack?: ContextPackRetrieval;
  /**
   * RUN-231's other half: `contextPack.pack`'s citations, verified against THIS run's own leased
   * worktree (`citation-verify.ts`), carried forward from `prepare` UNCHANGED — the seam this
   * task's own renderer (`memory-render.ts`) attaches to. Same absence rule as `contextPack`
   * above: absent on a RESUMED run (`resume` has no `prepare`, so nothing here verified one),
   * and `null` (present but empty) whenever there was no pack to verify or verification itself
   * failed — `renderMemoryEvidence(null, …)` reads either as "nothing to render", never a defect.
   */
  readonly verifiedContextPack?: VerifiedContextPack | null;
  /**
   * The wall-clock moment observed immediately before the agent actually spawned (RUN-261) — an
   * ISO datetime, threaded from `stages/execute.ts`'s own capture through `afterDriver`'s `ctx`
   * parameter, the same route `contextPack`/`continued`/`executedSpec` above already use to reach a
   * pipeline that does not exist yet at capture time (the mechanism the RUN-225 precedent — carrying
   * a stage's own observation forward rather than re-deriving it — actually calls for here; that
   * ticket's `commandObservations` is a MUTABLE field because verify/review/integrate each append to
   * it AFTER the pipeline is built, which is a different problem from a fixed fact already known
   * before construction). Fixed for the sitting, not one of the four below: nothing past `execute`
   * ever revises when the agent started. Absent when no session ever spawned this sitting (a chain
   * that fails before its first step, `supervisor.ts`'s `sessionlessChainExit`) — `episode.ts`'s
   * `timelineOf` treats that as "never observed" and emits no entry, never a substituted moment. A
   * CHAIN reports its FIRST step's start here, never a later or failing step's — see `chain.ts`'s
   * own `noteStarted`/`withAllText` for how the earliest-wins.
   */
  readonly agentStartedAt?: string;

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
   * Every deterministic command this sitting actually watched exit (RUN-225): `verify`'s own
   * floor run, `integrate`'s landing-gate run, and any fix-round re-check `review` observed via
   * `onCommandObserved`. One flat array rather than three optional fields — the only consumer is
   * `episode.ts`'s `commands`/`testsRun`, and it reads them chronologically, not by site.
   */
  commandObservations: CommandObservation[];
  /**
   * The review stage's own exact reviewer evidence (RUN-225), carried forward because `settle`
   * cannot re-derive it: `rounds` here is `reviewWithFeedback`'s `looks` (every actual invocation,
   * not the FIX-round count of the same-named field on its return value — see `StageHost`'s own
   * doc on why those two are different numbers), and `acceptance` is the exact `AcceptanceReport`
   * the reviewer computed, not the ledger's lossy `LedgerEntry[]` re-encoding of it. Undefined when
   * no review stage ran at all (no `[verify.agent]`, or the run never reached `done` going in) —
   * `episode.ts`'s ledger-derived fallback is exactly correct for "no review happened": 0.
   */
  reviewEvidence?: { rounds: number; acceptance?: AcceptanceReport };
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
