import type {
  AgentTool,
  EffortEpisode,
  EpisodeStageFact,
  IntelligenceContextConsumptionMetric,
  IntelligenceDurationMs,
  LandPolicy,
  PermissionProfile,
  ProjectManifest,
  Run,
  RunBudget,
  RunEffort,
  RunKind,
  RunPhase,
  UploadedEpisodeIntelligence,
} from '@noriq-dev/shared';
import type {
  ConfigurationFingerprint,
  ExecutedConfigurationEvidence,
  ExecutionSpec,
} from '@noriq-dev/shared';
import { UNATTRIBUTED_MODEL_ID, hasExecutionSpec } from '@noriq-dev/shared';
import {
  type AcceptanceItem,
  acceptanceOverflow,
  enumerateAcceptance,
  renderAcceptanceChecklist,
} from './acceptance';
import {
  type Finding,
  type FindingResponse,
  type LedgerEntry,
  MAX_TASK_POINTERS,
  type SpinOffCheck,
  applyContestResponses,
  buildLedger,
  parseFindingResponses,
  parseFindings,
  reconciledEntry,
  renderContestRecord,
  spinOffsHold,
  subclaimsOf,
  taskRefsIn,
} from './adjudication';
import {
  type AgentCoordinate,
  coordinateFromParts,
  foldStageCoordinate,
  tryParseCoordinate,
} from './agent-coordinate';
import type { VerifiedContextPack } from './citation-verify';
import type { ParkState, RunAgent, SpinOffProvenance } from './client';
import { computeConfigurationFingerprints } from './config-fingerprint';
import type { ContextPackFetcher, ContextPackRetrieval } from './context-pack';
import type { ContinuableRun, ContinuableStore } from './continuable';
import { type BudgetRun, monotonicMs, superviseBudget, totalTokens } from './drivers/budget';
import type {
  AgentDriver,
  DriverExit,
  DriverSession,
  DriverStartOptions,
  DriverTelemetry,
  ModelUsage,
  NoriqMcp,
} from './drivers/types';
import { zeroTelemetry } from './drivers/types';
import {
  type CheckedExecutionSpec,
  type SpecPathProbe,
  checkExecutionSpec,
  renderExecutionSpec,
  renderUnreadableSpec,
} from './execution-spec';
import {
  type LandOutcome,
  assembleConflictPrompt,
  parseResolution,
  rejectTargetBranch,
  resolveLandBranch,
} from './land';
import type { LockConflict } from './lock-client';
import { LockEnforcer } from './lock-hooks';
import { logger as defaultLogger } from './logger';
import { renderMemoryEvidence } from './memory-render';
import {
  type ParkedRun,
  type ParkedStore,
  continuationResumePrompt,
  expiredParks,
  resumePrompt,
} from './parked';
import { renderPrompt, renderUserTemplate } from './prompts';
import { buildRepairSpec } from './repair';
import { type DocReader, type PathProbe, loadRepoContextBrief } from './repo-context';
import { type RepoIntel, hasFacts, renderRepoFacts } from './repo-intel';
import { type BudgetReservation, exceedsRun, reserveFromRun } from './run-budget';
import { type StageName, stagesFor, stopBefore } from './run-machine';
import { STAGE_NORIQ_TOOLS, sanitizedAgentEnv } from './security';
import { runSetup } from './setup';
import { stageFactFromTelemetry } from './stage-facts';
import {
  type ExecuteHost,
  type ExecuteOutcome,
  type PatternMapHost,
  type PlanCheckHost,
  type PlanHost,
  type PlanOutcome,
  type PlannedRun,
  type PrepareHost,
  type PreparedRun,
  type RunPipeline,
  type StageHost,
  type StageImpl,
  checkPlan,
  checkerFindings,
  executeChain,
  executeRun,
  integrateStage,
  mapPatterns,
  planRun,
  prepareRun,
  renderAnalogs,
  renderPriorSteps,
  renderStepFocus,
  reviewStage,
  settleStage,
  verifyStage,
  worthMapping,
} from './stages';
import { authorSpecBlock, buildRunBrief } from './stages/brief';
import type { ChainWave, StepSummary } from './stages/chain';
import type { DeliveredSteer } from './steering';
import { checkSteps } from './steps';
import { type RunLogSegment, RunTranscript } from './transcript';
import type { LockContext, LockOutcome, VcsBackend, Workspace } from './vcs/types';
import type { VerificationReportWire } from './verification-report';
import {
  type CommandObservation,
  type VerifyExec,
  type VerifyResult,
  type VerifySpec,
  defaultExec,
  timedVerify,
  verifyFeedbackPrompt,
  verifyFixRounds,
} from './verify';
import {
  type VerifyVerdict,
  assembleVerifyPrompt,
  judgeWithAcceptance,
  readEscalation,
} from './verify-agent';
import { assembleReviewerPrompt, reviewerContestPrompt, reviewerFeedbackPrompt } from './verify-reviewer';
import { VERSION } from './version';
import {
  BUILTIN_WORKFLOWS,
  type StageCoordinateKey,
  type Workflow,
  clampPermissionToWorkflow,
  resolveWorkflow,
  runWorkflow,
  stageCoordinate,
  workflowFor,
} from './workflow';
import type { WorkflowCatalog } from './workflow-store';

// Wires the two core run kinds through a real cycle: resolve the repo → prepare an
// isolated worktree (scope/verify read-only, build read-write) → assemble the
// kind-specific prompt → run the selected driver under the Run budget → stream
// status/telemetry back → clean up. Composes RUN-11 (worktree), RUN-12/13
// (drivers), RUN-14 (budget).
//
// The daemon creates each Run's Noriq identity up front and hands the process a token bound
// to it (RUN-43), so the agent reports its own work as an actor the daemon can name. It used
// to be the reverse: the prompt asked the model to register ITSELF via set_agent_identity, so
// attribution depended on the model complying and the daemon never learned who its own child
// was — run.status.agentId was null on every run ever reported.

/** The slice of a VcsBackend the supervisor drives — everything except reapOrphans, which is
 *  the daemon's (crash recovery is not a per-Run concern). */
export type SupervisorVcs = Pick<
  VcsBackend,
  | 'lease'
  | 'dispose'
  | 'hasWork'
  | 'checkpoint'
  | 'targetExists'
  | 'createTarget'
  | 'integrate'
  | 'resumeIntegrate'
  | 'abandonIntegrate'
  | 'publish'
  | 'share'
  | 'disposePreservesWork'
  // RUN-229: citation verification's own drift signal — required, not optional, because every
  // real backend already implements it (`VcsBackend.changesBetween`'s own doc: "REQUIRED, not
  // optional"), so widening this Pick costs nothing except a fake that never bothered typing
  // itself as `SupervisorVcs` in the first place (every existing test fake casts `as never` at
  // its `vcsFor` call site instead).
  | 'changesBetween'
  // RUN-245: `settle`'s own analytics read of the same workspace — required for the identical
  // reason `changesBetween` is (every real backend already implements it; `changeStats`'s own doc
  // in `vcs/types.ts` states it plainly: "REQUIRED, not optional").
  | 'changeStats'
> &
  // Optional so every existing fake keeps compiling; absent reads as git, the machine default.
  // The reviewer (RUN-61) keys its diff instruction off this — `git diff` is a lie on Perforce.
  // lock/unlock/queryLocks are optional the same way (RUN-98): a fake or lock-less backend omits
  // them, and the supervisor treats absence as "no lock layer" (RUN-101/103).
  // The wave trio (RUN-170) is optional with the OPPOSITE default direction: absence reads as
  // "leases cannot overlap", so a fake that says nothing gets the sequential chain it always had —
  // the conservative degradation `VcsBackend.leasesOverlap` documents.
  Partial<
    Pick<
      VcsBackend,
      | 'kind'
      | 'lock'
      | 'unlock'
      | 'queryLocks'
      | 'changedPaths'
      | 'releaseRunLocks'
      | 'leasesOverlap'
      | 'integrateFromRun'
      | 'publishToRun'
    >
  >;

export interface ResolvedRepo {
  root: string;
  manifest: ProjectManifest;
  /** Freshly loaded at dispatch and pinned with this resolved repo for the run. */
  workflowCatalog?: WorkflowCatalog;
  /**
   * This repo's backend (RUN-60), when it is not the machine default — the daemon detects per
   * repo (git by `.git`, Diversion by the dv registry) and routes here. Omitted → `deps.vcs`,
   * which keeps every existing caller and test meaning exactly what it meant.
   */
  vcs?: SupervisorVcs;
}

export interface RunReport {
  /** `blocked` = parked on a human (RUN-30). Non-terminal and resumable → running. */
  status: 'running' | 'blocked' | 'done' | 'failed';
  worktreePath?: string | null;
  /** The agent working this Run. The wire has always carried this slot and it was always
   *  null, because the daemon never knew the identity its child invented for itself — the
   *  daemon creates it now (RUN-43), so it can finally say. */
  agentId?: string | null;
  /** What this Run is doing right now (RUN-31): the ~90s of verify + land used to report a
   *  blanket `running` with the spend frozen, which is indistinguishable from a hung agent.
   *  Rides the telemetry frame, not the status one — a phase change is not a transition. */
  phase?: RunPhase;
  telemetry?: DriverTelemetry;
  /** Rolling tail of the agent's output for the live dashboard (RUN-22), tail-capped. */
  logTail?: string;
  /**
   * The execution spec this run was actually briefed with (RUN-166) — sent ONCE, when it is
   * resolved, and absent on every other frame.
   *
   * The daemon is the writer rather than the server at dispatch, and that is the decision. A run
   * whose task carried no spec gets one from the `plan` stage: a spec the server never sent and
   * could not have recorded. Those are exactly the runs where "what was this agent told?" matters
   * most, because nobody wrote the contract beforehand — so a dispatch-time copy would be empty
   * precisely where it is needed.
   */
  executedSpec?: ExecutionSpec;
  /**
   * RUN-241: the coordinate this run actually resolved and started under — sent ONCE, when
   * `prepareRun` has settled tool/model/effort/workflow, and absent on every other frame. Mirrors
   * `executedSpec` exactly (see `ws.ts`'s own doc comment on that field for why this rides
   * telemetry rather than minting a status transition): late Runner evidence, not permission to
   * rewrite the server's immutable commissioning snapshot, so it is deliberately write-once on
   * the server side too.
   *
   * `configuration` (per-component fingerprints) is left `[]` here — populating it is RUN-246's
   * task, and `[]` is the schema's own default, so an empty array says "not populated yet", not
   * "nothing configured". `reviewer`/`verifier` stay `null`: neither is chosen this early in
   * `supervise` (the inline reviewer's coordinate is resolved inside `runReviewer`, per round),
   * and a guessed value would be worse than an honest gap for a field Project Intelligence reads
   * as evidence.
   */
  executedConfiguration?: ExecutedConfigurationEvidence;
  exit?: Record<string, unknown> | null;
}

export interface RunSupervisorDeps {
  /** One driver per tool (claude/codex). */
  drivers: Partial<Record<AgentTool, AgentDriver>>;
  /** The VCS seam (RUN-49). This Pick is the interface's origin story: its git-verb
   *  predecessor was how the nine outcomes were DISCOVERED — the supervisor already declared
   *  exactly what it needs, so the seam was renamed, not designed. This is the MACHINE DEFAULT;
   *  a repo may carry its own backend via ResolvedRepo.vcs (RUN-60). */
  vcs: SupervisorVcs;
  /** repoRef → local repo root + the manifest to run under. May be async: the daemon
   *  re-reads the committed marker per Run so a config edit needs no restart. */
  resolveRepo: (repoRef: string) => ResolvedRepo | null | Promise<ResolvedRepo | null>;
  /** Report a Run status transition upstream (→ WsClient.sendRunStatus). */
  report: (runId: string, report: RunReport) => void;
  /** Stream transcript segments upstream (RUN-74, → WsClient.sendRunLog). The role-labeled
   *  record of every voice in the run — the "why was it refused" surface. Optional and
   *  best-effort by construction: a transcript must never gate a run. */
  reportLog?: (runId: string, segments: RunLogSegment[]) => void;
  /**
   * Create this Run's Noriq agent and take its credential (→ NoriqClient.createRunAgent).
   *
   * The daemon owns the identity's lifecycle (RUN-43): it exists before the process does,
   * and the process is authenticated as it by a token bound to it alone. This replaces
   * `parentAgentId`, which was both wrong and inert — daemon.ts passed the RUNNER id into a
   * field documented as an agent id, and it only ever reached the model as prompt text
   * asking it to please register itself.
   *
   * Omitted → the agent gets no Noriq identity and no MCP access, which is a no-op run.
   */
  createRunAgent?: (runId: string, opts: { label?: string; allowedTools?: string[] }) => Promise<RunAgent>;
  /** The Noriq server the spawned agent reaches over direct MCP. */
  server: string;
  /**
   * Machine-local ceilings from runner.toml's `[budget]`, applied per-dimension to a
   * Run that doesn't carry its own. Without this a dispatch with no budget runs
   * completely unbounded — no token, USD, or wall-clock ceiling.
   */
  defaultBudget?: RunBudget | null;
  // `getToken` is gone (RUN-43): it injected the DAEMON's own OAuth token into every spawned
  // agent's MCP transport — the credential that can register runners and reach every project
  // its human can. Agents now get a per-run token bound to one identity, from createRunAgent.
  /** Resolve an anchor task's title/body so the prompt can inline it (→ NoriqClient.getTask). */
  resolveTask?: (taskId: string) => Promise<AnchorTask | null>;
  /**
   * Read-only phase/plan-gate probe (RUN-81, → NoriqClient.checkClaimable): is a task-anchored
   * run's task claimable RIGHT NOW? Consulted BEFORE spawning, as defense in depth — the server's
   * dispatch/claim gate is the primary authority, but a bug there (a phase-2 task offered while
   * phase 1 is only in review) must not spawn an agent on work that isn't unlocked yet.
   *
   * Omitted, or a null answer (probe unavailable / transient error), leaves the gate UNCONSULTED
   * — the daemon spawns exactly as before. Only an explicit `{ claimable: false }` declines.
   */
  checkClaimable?: (taskId: string) => Promise<{ claimable: boolean; reason: string | null } | null>;
  /**
   * Look up a task a CONTESTED response's `task:<ref>` pointer names (RUN-188, →
   * NoriqClient.getTask; the server resolves keys and ids alike). The DAEMON runs this check
   * because the judging reviewer holds no Noriq credential and must not gain one (RUN-43) — it is
   * handed the result as ledger data, never a token. Same probe posture as checkClaimable: a
   * throw and a null are the same non-answer, recorded UNVERIFIED — which can never CREDIT a
   * contest and never fails the run by itself. Omitted → no facts are attached and a task pointer
   * stays exactly the free text it was before this existed.
   */
  resolveSpinOff?: (ref: string) => Promise<SpinOffLookup | null>;
  /** Deadline for ONE resolveSpinOff lookup (RUN-188). The await sits on the adjudication path —
   *  between the builder's turn and the fold — so a stalled MCP call must degrade to the same
   *  unverified non-answer a failed one does rather than hang the run. Omitted →
   *  TASK_LOOKUP_TIMEOUT_MS; present for tests, the contextBudget pattern. */
  spinOffTimeoutMs?: number;
  /**
   * Dispatch-time predictive locking (RUN-103): the DECLARED file scope of a run, if one is
   * known, so the daemon can take its locks before the agent starts and refuse a dispatch that
   * would clash — extending the RUN-81 phase-gate backstop from "is the task claimable" to "are
   * its files free".
   *
   * Honest by construction: no run carries a declared scope on the wire today, so this is a
   * PLUGGABLE resolver (a future dispatch field / task metadata), and when it is absent or yields
   * nothing the predictive layer no-ops — the reactive hook (RUN-101) and hard floor (RUN-102)
   * remain the guarantee. Paths are repo-relative.
   */
  resolveLockScope?: (
    run: Run,
    /** The anchor task's execution spec (RUN-142) — its `anticipatedFiles` is the first thing that
     *  declares, before any work, which files a run intends to touch. Null when it has none. */
    spec: ExecutionSpec | null,
  ) => Promise<string[] | null> | string[] | null;
  /** How `[context]` paths are checked to exist and stay inside the repo (RUN-128). Injected so
   *  tests never touch a real tree; omitted → the real fs probe. */
  pathProbe?: PathProbe;
  /** How an execution spec's paths are checked (RUN-139). A separate seam from `pathProbe`
   *  because it answers a richer question — file vs directory, gone vs could-not-look — that
   *  `[context]` deliberately collapses. Omitted → the real fs probe. */
  specPathProbe?: SpecPathProbe;
  /** Write a planned spec back onto the anchor task (RUN-140). Omitted → the spec is used for this
   *  run and not persisted, which costs reusability and a human's chance to correct it. */
  saveExecutionSpec?: (projectId: string, taskId: string, spec: ExecutionSpec) => Promise<boolean>;
  /** Background indexing's landing/publish trigger site (RUN-222, → `IndexTriggerHub.onLanded`).
   *  Fire-and-forget: called after a successful landing, never awaited by anything whose outcome
   *  the run reports (`stages/integrate.ts`'s own call site). Omitted → no index trigger layer
   *  wired, and a landing simply triggers nothing, exactly as before this existed. */
  onLanded?: (repoRoot: string, branch: string, sha: string) => void;
  /**
   * Hand a freshly assembled effort episode to delivery (RUN-227, `StageHost.recordEpisode`'s own
   * seam — its doc names this exact wiring point). `daemon.ts` binds it to `episode-upload.ts`'s
   * `deliverEpisode`, which enqueues durably before attempting a network call — this dep itself
   * must stay synchronous and fire-and-forget the same way, or `settle` would be awaiting a network
   * round trip it is documented never to. Omitted → no delivery layer wired, a test's ordinary
   * posture and every host before this task.
   *
   * `intelligence` (RUN-284) is threaded through unchanged — see `StageHost.recordEpisode`'s own
   * doc on why it rides as a second argument rather than a field on `episode`.
   */
  recordEpisode?: (episode: EffortEpisode, intelligence?: UploadedEpisodeIntelligence) => void;
  /**
   * Hand a freshly built verification report to delivery (RUN-230, `PrepareHost.reportVerification`
   * — that seam's own doc names this exact wiring point). `daemon.ts` binds it to
   * `verification-report.ts`'s `deliverVerificationReport`, which enqueues durably before
   * attempting a network call — this dep itself must stay synchronous and fire-and-forget for the
   * identical reason `recordEpisode` does. Omitted → no delivery layer wired, a test's ordinary
   * posture and every host before this task.
   */
  reportVerification?: (runId: string, agentToken: string, report: VerificationReportWire) => void;
  /** The repo-facts cache (RUN-143). Omitted → every run re-derives what the last one worked out,
   *  which is exactly the behaviour before it existed. `getEntry` (RUN-233) is the seeder's own
   *  precedence read — see `mapPatternsIfWorthIt`. */
  repoIntel?: Pick<RepoIntel, 'get' | 'put' | 'getEntry'>;
  /** How required-reading files are read for inlining (RUN-129). Injected for the same reason;
   *  omitted → the real fs. */
  readDoc?: DocReader;
  /** Characters of inlined documentation allowed into one brief (RUN-129). Omitted →
   *  `CONTEXT_BUDGET_CHARS`. Present for tests and for a future per-repo knob, if one earns itself. */
  contextBudget?: number;
  /**
   * Is this Run parked on a human, and have they answered? (→ NoriqClient.getParkState, RUN-30)
   *
   * The server is the authority: only it saw the `request_input`, because the agent reaches
   * Noriq over MCP directly and the daemon is not in that path. Omitted → parking is off and a
   * session that ends is simply finished, exactly as before RUN-30.
   */
  getParkState?: (runId: string) => Promise<ParkState>;
  /**
   * Tell the server a run's open blocked question died with the run (RUN-199), on a terminal path
   * that declines to park it (a budget breach, a crash, a resumable driver with no session).
   * Omitted → the signal is left standing, the pre-RUN-199 behaviour a human clears by hand. Never
   * fatal: a failure here must not turn a terminal run into a throw.
   */
  abandonSignal?: (runId: string, signalId: string) => Promise<void>;
  /** Where parked runs are remembered across restarts (RUN-30). Omitted → parking is off. */
  parked?: Pick<ParkedStore, 'park' | 'get' | 'unpark' | 'list'>;
  /** Where a failed build's continuation state (spend + adjudication ledger) is kept, so a
   *  "continue a failed run" (RUN-91/92) re-seeds instead of resetting. Omitted → a continue still
   *  works off the kept worktree, but reports only its own sitting's spend and re-derives findings. */
  continuable?: Pick<ContinuableStore, 'get' | 'put' | 'remove'>;
  /** How long a park may sit before the daemon fails it (RUN-30). Default: DEFAULT_PARK_TTL_HOURS. */
  parkTtlHours?: number;
  /** Makes the live session steerable + cancellable while it runs (RUN-16/18). `key` names which
   *  of the run's sessions is registering — a wave holds several at once (RUN-170); omitted, the
   *  bridge treats the run as its single session, which every non-chain call site is. */
  steering?: {
    register: (runId: string, session: DriverSession, stop: () => Promise<void>, key?: string) => void;
    unregister: (runId: string, key?: string) => void;
    /** Has an operator cancelled this run (RUN-165)? Asked at every stage boundary, because a
     *  cancel is a fact about the RUN and the pipeline is many sessions with gaps between them. */
    isCancelled?: (runId: string) => boolean;
    /** Drop the record once the run is terminal, so a long-lived daemon does not keep one entry
     *  per cancelled run for its whole life. */
    forget?: (runId: string) => void;
    /** Drain this run's observed steer deliveries (RUN-225) — see `SteeringBridge`'s own doc. */
    steeringHistory?: (runId: string) => DeliveredSteer[];
  };
  /**
   * How many of a decomposed run's wave steps may overlap (RUN-170): the daemon's own
   * `concurrency` minus what the REST of the machine is running, asked again before EACH wave —
   * a chain runs a long time, and a limit sampled once would keep spending capacity the machine
   * no longer has. Takes the asking RUN's id so the daemon can exclude that run's own sessions
   * from the count. A run that saturates the machine with its own steps starves every other run,
   * which is worse than a slow run — so the limit is the machine's spare capacity, not a per-run
   * knob.
   *
   * Omitted → 1, which is the fully sequential chain every decomposed run was before this
   * existed. Conservative deliberately: a dep only the daemon binds must not default to
   * unbounded concurrency in every harness that never heard of it.
   */
  waveLimit?: (runId: string) => number;
  /** Injectable command runner for the deterministic verify floor (RUN-19). */
  verifyExec?: VerifyExec;
  /** Where workspace-bootstrap markers live (RUN-202). Injected so tests never touch ~/.noriq —
   *  the marker is keyed by workspace PATH, and fake paths collide across a suite. */
  setupMarkerDir?: string;
  /** Post the verify failure output as a comment on the anchor task (the floor-gate surface). */
  postComment?: (projectId: string, taskId: string, body: string) => void;
  /** RUN-228's task context pack fetch (→ `NoriqClient.getContextPack`, bound with this daemon's
   *  own `runnerId` — the same closure shape `getIndexCursor`'s own dep, `getCursor`, already
   *  uses in `daemon.ts`). Omitted → retrieval never runs, which `context-pack.ts` treats as one
   *  more degradation path a run proceeds through exactly as it did before this existed. */
  getContextPack?: ContextPackFetcher;
  logger?: typeof defaultLogger;
}

/**
 * Resolve the ceilings a Run actually executes under: the Run's own budget wins
 * per-dimension, and runner.toml's `[budget]` fills each gap.
 *
 * Per-dimension (not whole-object) on purpose — a dispatch that sets only `maxTokens`
 * must still inherit the machine's USD and wall-clock ceilings, or the one field it
 * specified would silently disable the other two.
 *
 * These are DEFAULTS, not clamps: an explicit Run budget above the machine's is
 * honoured, matching what runner.toml.example documents.
 */
export function mergeBudget(runBudget?: RunBudget | null, fallback?: RunBudget | null): RunBudget | null {
  if (!runBudget && !fallback) return null;
  return {
    maxTokens: runBudget?.maxTokens ?? fallback?.maxTokens ?? null,
    maxUsd: runBudget?.maxUsd ?? fallback?.maxUsd ?? null,
    maxDurationSeconds: runBudget?.maxDurationSeconds ?? fallback?.maxDurationSeconds ?? null,
    // The reviewer-round override (PLNR-180/RUN-91) is the dispatch's alone — the machine fallback
    // never sets it — but it merges per-dimension like the rest so it survives to the supervisor.
    maxRounds: runBudget?.maxRounds ?? fallback?.maxRounds ?? null,
  };
}

/**
 * Which model + effort a Run actually executes with (RUN-33).
 *
 * Three layers, most specific first: the DISPATCH (a human chose, for this run), then the REPO's
 * per-kind `[defaults]` (a repo said "scope with something strong"), then nothing — the tool's own
 * default, which is what every run got before this existed.
 *
 * Per-field, not whole-object, for the same reason mergeBudget is: a dispatch that names only a
 * model must still inherit the repo's effort for that kind, or the one field it set would
 * silently erase the other.
 */
/**
 * The dispatch's effective coordinate (RUN-114): the `agent` string when present, else one
 * synthesized from the legacy `{agentTool, model, effort}` triple. A malformed wire coordinate
 * falls back to the triple rather than sinking the run — the triple is always well-formed (its
 * fields are wire-validated), so there is a safe answer. This is the ONE place the runner reconciles
 * new-form and legacy-form dispatches; everything downstream reads a coordinate.
 */
export function runCoordinate(run: Pick<Run, 'agent' | 'agentTool' | 'model' | 'effort'>): AgentCoordinate {
  const fromTriple = coordinateFromParts(run.agentTool, run.model, run.effort);
  if (!run.agent) return fromTriple;
  return tryParseCoordinate(run.agent) ?? fromTriple;
}

/** The driver a run selects — its coordinate's tool (RUN-114). Identical to `agentTool` for a
 *  legacy dispatch that carries no coordinate. */
export function resolveAgentTool(run: Pick<Run, 'agent' | 'agentTool' | 'model' | 'effort'>): string {
  return runCoordinate(run).tool;
}

/**
 * The kind whose POSTURE a run actually runs under (RUN-126) — the daemon's authoritative answer,
 * not the dispatcher's. When a run selects a custom `workflow`, its posture IS that workflow's base
 * (a `docs` workflow based on `scope` is read-only), so the base wins over whatever `kind` the
 * dispatch carried. This closes the footgun where a UI (or any client) selects a read-only workflow
 * but leaves `kind = build`: the daemon holds the manifest and decides, so a mismatched dispatched
 * kind can never escalate write. With no explicit selection, a loaded definition matching the
 * kind wins by RUN-192's source precedence; with no such definition, the dispatched `kind` stands.
 * An unknown EXPLICIT name also leaves the kind standing here — but no dispatch reaches this with
 * one any more: prepare refuses a selected name that does not resolve (RUN-196) before anything is
 * acquired, so that arm is the posture fail-safe for the paths that skip prepare's gate (parked
 * rehydration, `waveFor`, `startAgent`'s clamp), not a dispatch behaviour.
 *
 * `promptShape` is the base kind by construction — a built-in's is its own id, a custom's is
 * inherited from its base — so it doubles as the posture kind.
 *
 * NOT a deprecation window, whatever its neighbours are (settled by RUN-163). Accepting a bare
 * `kind` looks like back-compat for dispatchers that predate `workflow`, and removing it on that
 * reading would delete a security property: the rule is that the DAEMON decides posture from the
 * manifest it holds, so no client can escalate write by naming a kind. That has to survive any
 * tidying of the surrounding compatibility shims, and it is the reason this function exists rather
 * than reading `run.kind` at each site.
 */
export function effectiveKind(
  run: Pick<Run, 'kind' | 'workflow'>,
  source: Pick<ProjectManifest, 'workflows'> | WorkflowCatalog,
): RunKind {
  const wf = resolveWorkflow(run.workflow ?? run.kind, source);
  const kind = (wf?.promptShape ?? run.kind) as RunKind;
  // A kind outside the union degrades to SCOPE rather than being passed through. Everything
  // downstream indexes a fixed-key record with this — `manifest.permissions[kind]`,
  // `manifest.defaults[kind]`, `noriqToolNamesFor(kind)` — and an unrecognised key yields
  // `undefined`, which the write clamp then throws on. A WS dispatch is schema-validated, but a
  // PARKED run is rehydrated from JSON on disk without revalidation, so this is reachable. Scope
  // because a fallback that guessed `build` would answer "I don't recognise this" with "then you
  // may write and land".
  // `Object.hasOwn`, not `in` — see the note on `isBuiltinId`: `'toString' in BUILTIN_WORKFLOWS` is
  // true, which would wave through the exact keys this guard exists to catch.
  return Object.hasOwn(BUILTIN_WORKFLOWS, kind) ? kind : 'scope';
}

export function resolveModel(
  run: Pick<Run, 'kind' | 'agent' | 'agentTool' | 'model' | 'effort'>,
  manifest: ProjectManifest,
): { model?: string; effort?: RunEffort } {
  const repo = manifest.defaults?.[run.kind as RunKind];
  // Precedence, most specific first: the dispatch coordinate (RUN-114, which already folds the
  // agent string OR the legacy triple) → the repo `[defaults.<kind>].agent` coordinate (RUN-113) →
  // the repo's legacy model/effort pair → the tool's own default (absence).
  const dispatch = runCoordinate(run);
  const repoCoord = repo?.agent ? tryParseCoordinate(repo.agent) : null;
  const model = dispatch.model ?? repoCoord?.model ?? repo?.model ?? null;
  const effort = dispatch.effort ?? repoCoord?.effort ?? repo?.effort ?? null;
  // Undefined rather than null: these become DriverStartOptions fields, and the drivers treat
  // "absent" as "don't pass it", which is what lets the tool apply its own default.
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

/**
 * Replace a prepared start's model/effort with a stage's resolved pair (RUN-193). The prepared
 * values are dropped FIRST: a stage coordinate that names a different vendor severs the model to the
 * tool's default, and spreading over `...prepared.start` would otherwise leave the prepared model —
 * the wrong vendor's — behind. With no stage coordinate the resolved pair equals the prepared one,
 * so this is a no-op there.
 */
const withStageModel = (
  start: Omit<DriverStartOptions, 'handlers' | 'env'>,
  resolved: { model?: string; effort?: RunEffort },
): Omit<DriverStartOptions, 'handlers' | 'env'> => {
  // Overwrite rather than merge: a stage coordinate that names a different vendor severs the model
  // to the tool's default, so the prepared model/effort (the wrong vendor's) must be REPLACED, not
  // filled in behind. Absent → undefined, which the drivers read as "don't pass it".
  return { ...start, model: resolved.model, effort: resolved.effort };
};

/** Sum two model mixes model-by-model, field-by-field (RUN-59). Absent on both sides → absent. */
export const mergeModelUsage = (
  a?: Record<string, ModelUsage>,
  b?: Record<string, ModelUsage>,
): Record<string, ModelUsage> | undefined => {
  if (!a && !b) return undefined;
  const out: Record<string, ModelUsage> = {};
  for (const src of [a, b]) {
    if (!src) continue;
    for (const [id, u] of Object.entries(src)) {
      const cur = out[id];
      out[id] = cur
        ? {
            inputTokens: cur.inputTokens + u.inputTokens,
            outputTokens: cur.outputTokens + u.outputTokens,
            cacheReadInputTokens: cur.cacheReadInputTokens + u.cacheReadInputTokens,
            cacheCreationInputTokens: cur.cacheCreationInputTokens + u.cacheCreationInputTokens,
            costUSD: cur.costUSD + u.costUSD,
          }
        : { ...u };
    }
  }
  return out;
};

/**
 * Fold ONE session's aggregate telemetry into the unattributed bucket (RUN-86). Reads the four
 * token classes + cost off a `DriverTelemetry` (whose field names differ from `ModelUsage`'s:
 * `cacheReadTokens`→`cacheReadInputTokens`, `costUsd`→`costUSD`) and adds them in — so the bucket
 * carries exactly what this session contributed to the run totals, and the mix keeps summing.
 */
const addUnattributed = (acc: ModelUsage | undefined, t: DriverTelemetry): ModelUsage => ({
  inputTokens: (acc?.inputTokens ?? 0) + t.inputTokens,
  outputTokens: (acc?.outputTokens ?? 0) + t.outputTokens,
  cacheReadInputTokens: (acc?.cacheReadInputTokens ?? 0) + t.cacheReadTokens,
  cacheCreationInputTokens: (acc?.cacheCreationInputTokens ?? 0) + t.cacheCreationTokens,
  costUSD: (acc?.costUSD ?? 0) + t.costUsd,
});

/** A park's prior spend, rehydrated as a telemetry snapshot to SEED a resumed run's tally (RUN-59).
 *  Prior tokens land in inputTokens — the split across the four buckets is not recoverable from the
 *  park (it stores one total), and the figure that matters (and that the budget reads) is the sum.
 *  The prior MIX carries over whole, so a resumed run's breakdown keeps summing to its total. */
export const telemetryFromSpent = (spent: ParkedRun['spent']): DriverTelemetry => ({
  inputTokens: spent.tokens,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: spent.usd,
  numTurns: 0,
  ...(spent.modelUsage ? { modelUsage: spent.modelUsage } : {}),
});

/**
 * The run's spend, tallied across every SESSION that bills to it (RUN-59).
 *
 * A run is not one session: the primary agent (and its fix turns), each inline-reviewer round, the
 * conflict resolver, and a park's prior spend all cost real tokens on real — sometimes DIFFERENT —
 * models. Reporting only the primary's mix is the same half-truth as reporting only the dispatched
 * model. Each session records its latest snapshot under its own slot; the run's figure is the sum.
 *
 * Authority, not size: `record` is last-writer-wins per slot, NOT a max. Within one session each
 * result is that session's running cumulative aggregate and arrives AFTER its own live ticks, so the
 * latest snapshot is the authoritative one — picking "the largest" would let a live over-count (or a
 * mix-less interim tick) beat the result that supersedes it.
 *
 * The mix must SUM to the run total beside it — that is the one thing the tooltip must never break.
 * RUN-59 kept that by making the mix all-or-nothing: one un-attributed spending session (codex, the
 * claude usage-fallback, a pre-RUN-59 park) dropped the WHOLE mix. But that discarded a Claude
 * builder's perfectly good breakdown just because its reviewer was codex — the run showed "not
 * reported" beside real, attributable spend. RUN-86 keeps the sum without the loss: un-attributable
 * spend is folded into ONE reserved `(unattributed)` bucket carrying exactly what those sessions
 * contributed to `acc`, so attributed models + the bucket still land on the total. The bucket is a
 * real key the dashboard renders as "unattributed"; only a genuinely spend-less run has no mix.
 */
export class RunTally {
  private readonly slots = new Map<string, DriverTelemetry>();
  /** Agent-active seconds charged to this run so far — the wall-clock dimension's spend. Separate
   *  from the slots because time is not telemetry: it accumulates, it is never last-writer-wins. */
  private active = 0;

  /**
   * The run's ONE ceiling (RUN-133). Held here because the tally is already the run's cumulative
   * spend and is already threaded to every place a session starts — so "what is left" is a
   * subtraction on numbers this object has, rather than a second object following it everywhere.
   * The POLICY is still `reserveFromRun`'s; this only carries the inputs.
   *
   * Null/absent = unbounded, which is what every existing caller and test means by omitting it.
   */
  constructor(
    private readonly ceiling: RunBudget | null = null,
    priorActiveSeconds = 0,
  ) {
    this.active = priorActiveSeconds;
  }

  /** Record a session's latest snapshot. Last-writer-wins per slot (see class doc). */
  record(slot: string, t: DriverTelemetry): void {
    this.slots.set(slot, t);
  }

  /** Charge a finished session's active stretch to the run. The post-driver sessions — builder,
   *  reviewer, conflict turn — are strictly sequential, so their stretches sum without overlap; a
   *  wave's step sessions DO overlap (RUN-170) and each still charges its own stretch, so under
   *  concurrency this figure is agent COMPUTE time, not wall-clock. That is the deliberate reading
   *  of `maxDurationSeconds` for a wave: three sessions running an hour together cost three hours
   *  of the ceiling, the conservative direction — overlap can only exhaust a run sooner. */
  chargeTime(seconds: number): void {
    this.active += Math.max(0, seconds);
  }

  /** Agent-active seconds burned so far, including any prior sitting's. */
  activeSeconds(): number {
    return this.active;
  }

  /**
   * Every verify-duration envelope this run has actually observed (RUN-284, RUN-242's own
   * "one duration per attempt, logged as it happens" — this is where "logged" also becomes
   * "kept"). Appended, never replaced: a retry loop's later attempts are a DIFFERENT command run
   * (`verifyWithFeedback`'s own doc), so each one is its own entry rather than overwriting the
   * last, and `intelligence-payload.ts` is what folds this list into the run-wide sum semantics —
   * this object stays a plain accumulator, the same division of labour `stageFacts()` already
   * draws between "what was recorded" and "what it means".
   */
  private readonly verifyDurationEvents: IntelligenceDurationMs[] = [];

  /** Record one verify-duration observation — every call site that used to only log `timedVerify`'s
   *  callback now also calls this, so `settle` can read what RUN-242 was already measuring.
   *
   * RUN-251: made TOTAL rather than trusted total. An ordinary array push cannot throw today, but
   * two of this method's three call sites run inside `timedVerify`'s own `finally` block
   * (`verify.ts`'s doc: "onDuration always fires before it propagates, but it still propagates") —
   * a throw THERE would not merely cost this metric, it would replace a clean PASS's return value
   * with a fresh exception, turning a passing verify into a thrown error. Guarding at the method
   * makes every call site total at once, rather than trusting each caller to remember the danger of
   * the `finally` it sits in. */
  recordVerifyDuration(d: IntelligenceDurationMs): void {
    try {
      this.verifyDurationEvents.push(d);
    } catch {
      // Best-effort, like every other analytics capture in this codebase: a bad push costs this one
      // observation, never the verify result it was timing. `RunTally` carries no logger to report
      // through — the same reason `guard`/`clockGuard` above stay silent on their own edges.
    }
  }

  /** Every verify-duration envelope recorded so far, in observation order. */
  verifyDurations(): readonly IntelligenceDurationMs[] {
    return this.verifyDurationEvents;
  }

  /**
   * What the NEXT session may spend: the run's ceiling minus everything already spent (RUN-133).
   *
   * Every `startAgent` goes through this instead of taking a fresh copy of the ceiling, which is
   * what makes a run's total spend bounded rather than bounded-per-session. `{ ok: false }` means
   * the caller must not spawn at all — see `reserveFromRun` for why that is a result and not a
   * one-token budget.
   */
  reserve(): BudgetReservation {
    return reserveFromRun(this.ceiling, { telemetry: this.total(), activeSeconds: this.active });
  }

  /**
   * A LIVE spend check for one session, for `DriverStartOptions.spendGuard` (RUN-133).
   *
   * A reservation is a snapshot, and a session can outlive it: the builder's is computed before it
   * starts, then the reviewer spends from the same ceiling, and the builder is handed work back.
   * Checking its own cumulative against that stale allowance lets the RUN exceed its budget while
   * no session ever breaches. This folds the live tick into the run's view under `slot` — the same
   * last-writer-wins slot the session's result will land in — and asks the allocator.
   *
   * Recording rather than probing a copy is deliberate: the write is idempotent (a later tick and
   * finally the authoritative result overwrite it), and it keeps ONE definition of the run's spend.
   * It does not report anything; who publishes a frame is still each call site's decision (RUN-59).
   */
  guard(slot: string): (t: DriverTelemetry) => string | null {
    return (t) => {
      // A PROBE, never a write. Recording the live tick looked equivalent — same slot, and the
      // authoritative result overwrites it moments later — but `stop()` fires an exit carrying ZERO
      // telemetry, and last-writer-wins then erased the session's real spend from the run's total.
      // A read-only check also keeps RUN-59's reporting contract exactly: a reviewer's live ticks
      // still never enter the tally, so no frame can show a total climbing past a stale mix.
      const probe = new Map(this.slots);
      probe.set(slot, t);
      // `exceedsRun`, NOT `reserve()`: a running session is over only when the run is strictly OVER
      // its ceiling. `reserve()` answers "may I start another one", where landing exactly on the
      // number is a no — using it here killed a session that spent precisely what it was allowed.
      return exceedsRun(this.ceiling, { telemetry: this.sum(probe.values()), activeSeconds: this.active });
    };
  }

  /**
   * The wall-clock counterpart of `guard`, for `DriverStartOptions.clockGuard` (RUN-159): seconds
   * left on the run, right now.
   *
   * Reads `active` rather than probing like `guard` does, because time is not telemetry — a
   * session's stretch is charged once, when it ends, so there is no in-flight figure to swap in.
   * That also means the answer EXCLUDES the caller's own running stretch, which is correct: the
   * session's own budget already covers that half, and the arming side takes the tighter of the two.
   */
  clockGuard(): () => number | null {
    return () => {
      const max = this.ceiling?.maxDurationSeconds;
      return max == null ? null : Math.max(0, max - this.active);
    };
  }

  /* `active` is only as good as the clock its callers time with, which is why every one of them
   * uses `monotonicMs` — a wall-clock step would otherwise hand this ledger seconds nobody spent
   * (or credit back seconds that were), and the budget layer would enforce against the drift. */

  /** Seed a slot only if empty — used for a park's prior spend, which must not clobber a live
   *  session that already recorded under the same slot. */
  seed(slot: string, t: DriverTelemetry): void {
    if (!this.slots.has(slot)) this.slots.set(slot, t);
  }

  total(): DriverTelemetry {
    return this.sum(this.slots.values());
  }

  /** Sum an arbitrary set of slot snapshots. Split out so `guard` can total a PROBE — the live
   *  slots with one session's in-flight tick swapped in — without writing that tick anywhere. */
  private sum(snapshots: Iterable<DriverTelemetry>): DriverTelemetry {
    const acc = zeroTelemetry();
    const fold: MixFold = {};
    for (const t of snapshots) RunTally.foldSnapshot(acc, fold, t);
    RunTally.finalizeMix(acc, fold);
    return acc;
  }

  /**
   * Per-slot Project Intelligence facts (RUN-243), built from the SAME walk `total()` runs over
   * each slot's snapshot — not a second accumulator kept in sync with it by hand. `foldSnapshot`
   * is the one definition of "how does one slot's snapshot add into a running total"; `sum()`
   * above calls it per snapshot and this calls it per slot, ADDITIONALLY building the per-slot
   * fact `sum()` has no reason to. "Stage facts sum to the run total" is therefore structural —
   * the two numbers come out of the identical addition, not two additions asserted to agree.
   *
   * Slot names are read here for the first time (`sum()` only ever sees bare snapshots) —
   * `stageFactFromTelemetry` (`stage-facts.ts`) is what turns a slot name into the vendored
   * `ExecutionKind`/`ExecutionRole`, kept in its own module because that classification has
   * nothing to do with tallying and everything to do with the slot vocabulary's meaning.
   */
  stageFacts(): { stages: EpisodeStageFact[]; total: DriverTelemetry } {
    const acc = zeroTelemetry();
    const fold: MixFold = {};
    const stages: EpisodeStageFact[] = [];
    for (const [slot, t] of this.slots) {
      RunTally.foldSnapshot(acc, fold, t);
      stages.push(stageFactFromTelemetry(slot, t));
    }
    RunTally.finalizeMix(acc, fold);
    return { stages, total: acc };
  }

  /** One snapshot's contribution to a running total — shared by `sum()` and `stageFacts()` so
   *  they can never independently drift on what "adding a slot in" means. */
  private static foldSnapshot(acc: DriverTelemetry, fold: MixFold, t: DriverTelemetry): void {
    acc.inputTokens += t.inputTokens;
    acc.outputTokens += t.outputTokens;
    acc.cacheReadTokens += t.cacheReadTokens;
    acc.cacheCreationTokens += t.cacheCreationTokens;
    acc.costUsd += t.costUsd;
    acc.numTurns += t.numTurns;
    const spent =
      t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreationTokens > 0 || t.costUsd > 0;
    // Spend from mix-less sessions, collected into the one reserved bucket (RUN-86) instead of
    // nuking the whole mix. Each such session adds its OWN aggregate — the same numbers it puts in
    // `acc` — so the bucket + the attributed models sum back to the total (codex lands here at $0,
    // matching that `acc.costUsd` already books it at $0).
    if (t.modelUsage) fold.mix = mergeModelUsage(fold.mix, t.modelUsage);
    else if (spent) fold.unattributed = addUnattributed(fold.unattributed, t);
  }

  private static finalizeMix(acc: DriverTelemetry, fold: MixFold): void {
    // A mix exists if ANYTHING was attributed or anything was unattributed; only a spend-less run
    // leaves both undefined (→ no mix, the daemon sends `{}` → the honest "not reported").
    if (fold.mix || fold.unattributed) {
      acc.modelUsage = {
        ...fold.mix,
        ...(fold.unattributed ? { [UNATTRIBUTED_MODEL_ID]: fold.unattributed } : {}),
      };
    }
  }
}

/** `RunTally`'s running mix-in-progress, threaded through `foldSnapshot` and closed out by
 *  `finalizeMix` — split out of the accumulator object itself since `DriverTelemetry.modelUsage`
 *  is only ever written once, at the end, never accumulated field-by-field like the rest. */
interface MixFold {
  mix?: Record<string, ModelUsage>;
  unattributed?: ModelUsage;
}

/** The anchor task's human-readable content, inlined into the prompt. */
/**
 * What the hard lock floor (RUN-102) concluded. `conflicts` is what it FOUND; `unknownScope` is
 * the case it could not look at all (RUN-156) — kept apart because an empty `conflicts` used to
 * mean both, and one of those is a pass while the other is a floor that never ran.
 */
export interface LockFloorOutcome {
  conflicts: LockConflict[];
  /** Set when the floor could not COMPLETE its check — the scope could not be enumerated, or the
   *  lock service did not answer. Carries the underlying reason for the log and the comment. */
  unchecked?: string;
}

export interface AnchorTask {
  key: string;
  title: string;
  body: string | null;
  /** What this task was commissioned with (RUN-139). Null = nobody wrote one. */
  executionSpec?: ExecutionSpec | null;
  /** The SERVER holds a spec it could not read (RUN-135) — not the same as having none. */
  executionSpecUnreadable?: boolean;
}

/** What the RUN-188 task-pointer check needs of a task: enough to say it EXISTS and where it came
 *  from. Structurally satisfied by client.ts's TaskBrief, the same seam shape as AnchorTask. */
export interface SpinOffLookup {
  key: string;
  title: string;
  /** Provenance a spun-off task carries. Absent on a task a human filed by hand — still a
   *  legitimate contest target ("tracked THERE" does not require the builder filed it); the
   *  reviewer weighs the difference, told which it is. */
  spinOff?: SpinOffProvenance | null;
}

/** Distinct task lookups one fold turn may spend (RUN-188). Past it a ref is recorded as
 *  unchecked — still `verified: false`, so it credits nothing — rather than silently dropped: a
 *  builder spinning off ten tasks to dodge ten findings meets the control instead of outrunning
 *  it, and the ledger says so out loud (the no-silent-caps rule). */
const MAX_TASK_LOOKUPS_PER_TURN = 8;
/** Deadline for one task lookup (RUN-188). This await sits between the builder's turn and the
 *  ledger fold, so a hung MCP call with no deadline would stall the run's adjudication — and the
 *  probe posture is that a lookup that cannot ANSWER is a non-answer, which a stall is. */
const TASK_LOOKUP_TIMEOUT_MS = 10_000;

/**
 * The RUNNABLE half of `[verify]` (RUN-61). Since the stage became a choice, `cmd` is
 * nullable — a reviewer-only section has no command — and every caller that shells out
 * narrows through here instead of trusting the field.
 */
export function cmdVerify(verify: ProjectManifest['verify']): VerifySpec | null {
  return verify?.cmd
    ? {
        cmd: verify.cmd,
        timeoutSeconds: verify.timeoutSeconds,
        shell: verify.shell,
        maxRounds: verify.maxRounds,
      }
    : null;
}

/**
 * Commit message for a run checkpoint (RUN-96): WHAT changed on the subject line, the runner's
 * attribution in the body. The old `noriq run <id>: <label>` order made every agent commit read
 * identically in one-line history — the id nobody scans pushed the task key/title everybody
 * scans off the right edge.
 */
export function runCommitMessage(runId: string, label: string): string {
  return `${label}\n\nnoriq run ${runId}`;
}

/** Render the anchor. A bare task id tells the agent nothing — inline the title/body
 *  the daemon already resolved so it starts knowing the job instead of spending its
 *  first turn (and possibly failing) on a get_task round-trip. */
function renderAnchor(run: Run, task?: AnchorTask | null): string {
  if (run.anchor?.type === 'task') {
    if (!task) return `\nApproved task: ${run.anchor.taskId}`;
    return `\nApproved task: ${task.key} (${run.anchor.taskId}) — ${task.title}${
      task.body ? `\n\n${task.body}` : ''
    }`;
  }
  return run.anchor?.type === 'plan' ? `\nPlan: ${run.anchor.planId}` : '';
}

/** Assemble the kind-specific prompt. Scope explores read-only and emits a
 *  PROPOSED plan; build implements an approved task into a review diff. The agent is
 *  TOLD who it is (RUN-43) rather than asked to introduce itself. */
export function assemblePrompt(
  run: Run,
  manifest: ProjectManifest,
  ctx: {
    agent: RunAgent;
    server: string;
    task?: AnchorTask | null;
    diffCmd?: string;
    /** The resolved workflow (RUN-121). Default: the built-in for run.kind. A custom workflow with
     *  a `promptRef` supplies its own brief; its inherited posture still drives everything else. */
    workflow?: Workflow;
    /** The repo's own orientation block, already resolved off disk (RUN-128). Optional: a marker
     *  with neither a `[context]` nor a CLAUDE.md/AGENTS.md renders as it did before RUN-128. */
    repoContext?: string;
    /** The same facts with no inlined documents, for the verify family (RUN-154). */
    repoContextBrief?: string;
    /** The verified context pack, rendered for an AUTHORING actor (RUN-231, `memory-render.ts`).
     *  Optional: a repo whose retrieval never ran, or produced nothing, renders as it did before
     *  this task existed. */
    memory?: string;
    /** The same pack, rendered for a JUDGING actor (RUN-231) — smaller budget, the reviewer frame.
     *  Selected the same way `repoContextBrief` already is: by what the actor IS, below. */
    memoryBrief?: string;
    /**
     * The anchor task's execution spec, already checked against the checkout and rendered
     * (RUN-139). A string for the same reason `repoContext` is: checking touches the disk, and
     * prompt assembly stays synchronous and pure.
     *
     * Empty for a task with no spec, which stays the common case — every task filed before the
     * contract grew one, and plenty since. The verify family does NOT receive it: a reviewer
     * judging a diff against acceptance criteria is RUN-145's design, not a free extra here.
     */
    executionSpec?: string;
    /**
     * The same spec's ACCEPTANCE CRITERIA, numbered, for the verify family (RUN-139 → RUN-145).
     *
     * An actor that judges needs the standard it is judging against, not the author's working
     * notes about which files to touch and what was deferred — that much was RUN-139. What RUN-145
     * changes is the FORM: a judge is asked to answer each criterion with an outcome and a piece
     * of evidence, and it can only do that against criteria that have numbers. The prose rendering
     * this replaced is gone rather than kept alongside, because a model shown the same criteria
     * twice answers the paragraph and skips the list.
     */
    acceptance?: AcceptanceItem[];
    acceptanceOverflow?: number;
    /**
     * Render the PLANNER's brief instead of this workflow's own (RUN-140).
     *
     * A shape override rather than a workflow of its own: planning is a stage inside a build, not
     * a different run — same repo, same task, same identity, same budget ledger. Giving it a
     * `Workflow` would have made it declarable in a manifest, and a repo able to declare its own
     * planner posture is exactly the widening `clampPermissionToWorkflow` exists to stop.
     */
    promptShapeOverride?: 'planner' | 'plan-checker' | 'pattern-mapper';
    /** The adjudication ledger, for the plan checker's own prior-rounds section (RUN-141). */
    ledger?: string;
    /** User-template diagnostics. The default is quiet for pure callers; production binds the
     *  daemon logger in buildRunBrief. */
    promptWarning?: (message: string, details: { variable: string; source: string }) => void;
  },
): string {
  const anchor = renderAnchor(run, ctx.task);
  const wf = ctx.workflow ?? workflowFor(run.kind as RunKind); // the prompt family is a workflow trait
  // The daemon created this identity before the process existed and handed it a token that
  // can only be this agent, so there is nothing to register (RUN-43). The old prompt asked
  // the model to call set_agent_identity — which made attribution depend on it complying,
  // left the daemon unable to name its own child, and quietly produced anonymous agents
  // whenever the model skipped the step or (as with codex) had no MCP to call.
  // Every kind can reach a human, so the invitation belongs in the shared identity block
  // (RUN-32). The allowlist grants the tools; this is what stops them going unused. An agent
  // that hits an ambiguity with no invitation to ask does not stop — it picks, and hopes.
  // request_input is not a way to give up: the daemon ends the session, keeps the worktree,
  // and resumes THIS session with the answer (RUN-30), so asking costs the agent nothing.
  const identity = renderPrompt('identity', {
    label: ctx.agent.label,
    agentId: ctx.agent.agentId,
    // The PLANNER announces itself as a planner (RUN-140). It ran as "BUILD agent … MODE: PLAN",
    // which is a contradiction in the first two lines of a prompt, and the half of it that was
    // wrong was the half describing what the agent may do.
    kind:
      ctx.promptShapeOverride === 'planner'
        ? 'PLAN'
        : ctx.promptShapeOverride === 'plan-checker'
          ? 'PLAN CHECK'
          : ctx.promptShapeOverride === 'pattern-mapper'
            ? 'PATTERN MAP'
            : wf.promptShape.toUpperCase(),
    projectKey: manifest.key,
    server: ctx.server,
    // The planner and the checker are spawned with NO `noriqMcp` (RUN-140/141), so the shared
    // identity's "report your work through Noriq, call request_input if you are stuck" would be
    // instructions to use tools that are not there — and a compliant model that tries one instead
    // of answering produces no verdict, which is how an unchecked plan slips through.
    noriq: !ctx.promptShapeOverride,
  });

  // The repo's `[context]` block (RUN-128), rendered ahead of the brief for the scope and build
  // families. A custom workflow's own prompt receives it as `{{context}}` but must PLACE that tag
  // to get it — a template we do not control cannot have text injected into it. The verify family
  // gets the NAMES-ONLY rendering instead (RUN-154), for the reason below.
  // Which rendering an actor gets follows what it IS, not which template it uses. `verifyActor` is
  // the flag that means "this one judges" — so a repo-defined workflow based on `verify` (RUN-119)
  // gets the bounded, explicitly-untrusted block through its own `{{context}}` too, instead of 16k
  // of inlined documents. Note it is NOT `produces`: scope produces a plan rather than a diff, but
  // it is an author reading the repo, not a gate deciding on it.
  const repoContext = (wf.verifyActor ? ctx.repoContextBrief : ctx.repoContext) ?? '';
  // Audience follows what the actor IS (RUN-231 locked decision 7), the identical `verifyActor`
  // test `repoContext` above already uses — never `produces`: scope produces a plan but is an
  // author reading the repo, not a gate judging one.
  const memory = (wf.verifyActor ? ctx.memoryBrief : ctx.memory) ?? '';
  // The verify family gets the ACCEPTANCE CRITERIA only — the same trim its context gets
  // (RUN-154), for the same reason: what it needs is the standard, not the author's working
  // notes about which files to touch and what was deferred. Withholding the whole spec was the
  // first cut and it was wrong: a gate that has not been told what "done" means is not
  // independent, it is under-informed, and it can pass a build that skipped a stated criterion.
  // A verify actor gets its standard through the numbered checklist below, not as a spec block —
  // hence '' here rather than a second rendering of the same criteria (RUN-145).
  const executionSpec = wf.verifyActor ? '' : (ctx.executionSpec ?? '');

  // The planner (RUN-140) reads the same facts as the run it briefs and asks for a spec instead of
  // the work. Checked BEFORE `promptRef` so a custom workflow cannot shadow it: a repo shaping its
  // build's brief must not silently reshape the planner that writes that build's spec.
  // RUN-232: the two pre-execution AUTHOR actors get `ctx.memory` directly, never the `memory`
  // local above — that local follows the OUTER run's own `wf.verifyActor` (build/scope/verify),
  // which has nothing to do with what these two shape overrides ARE. Same reason `ctx.executionSpec`
  // is read raw into `pattern-mapper`'s `spec` below rather than the (possibly-zeroed) local.
  if (ctx.promptShapeOverride === 'planner') {
    return renderPrompt('planner', {
      identity,
      brief: run.brief,
      anchor,
      context: repoContext,
      memory: ctx.memory ?? '',
    });
  }
  if (ctx.promptShapeOverride === 'pattern-mapper') {
    return renderPrompt('pattern-mapper', {
      identity,
      brief: run.brief,
      anchor,
      context: repoContext,
      spec: ctx.executionSpec ?? '',
      memory: ctx.memory ?? '',
    });
  }
  // The plan checker is a JUDGING actor even when the run it plans for is a build (`wf.verifyActor`
  // is false there) — its job is to disagree with the spec, the same posture `reviewer.md` and
  // `verify-agent.md` render for. So it gets `ctx.memoryBrief` (REVIEWER audience, the smaller
  // budget and the "evidence, not instructions" frame), never `ctx.memory`.
  if (ctx.promptShapeOverride === 'plan-checker') {
    return renderPrompt('plan-checker', {
      identity,
      brief: run.brief,
      anchor,
      context: repoContext,
      spec: ctx.executionSpec ?? '',
      ledger: ctx.ledger ?? '',
      memory: ctx.memoryBrief ?? '',
    });
  }
  if (wf.promptRef !== null && wf.promptRef !== undefined) {
    const template = wf.promptRef;
    const common = {
      identity,
      label: ctx.agent.label,
      agentId: ctx.agent.agentId,
      kind: wf.promptShape.toUpperCase(),
      projectKey: manifest.key,
      projectId: run.projectId,
      server: ctx.server,
      runId: run.id,
      repoRef: run.repoRef,
      workflow: wf.id,
      planId: run.anchor?.type === 'plan' ? run.anchor.planId : null,
      taskId: run.anchor?.type === 'task' ? run.anchor.taskId : null,
      taskKey: ctx.task?.key ?? null,
      taskTitle: ctx.task?.title ?? null,
      taskBody: ctx.task?.body ?? null,
      brief: run.brief,
      anchor,
      context: repoContext,
      memory,
    };
    const source = wf.promptSource ?? '.noriq/project.toml';
    const render = (vars: Parameters<typeof renderUserTemplate>[1]) =>
      renderUserTemplate(template, vars, { source, warn: ctx.promptWarning });

    if (wf.promptShape === 'verify') {
      const acceptance = ctx.acceptance?.length
        ? renderAcceptanceChecklist(ctx.acceptance, ctx.acceptanceOverflow ?? 0)
        : null;
      const workflowPrompt = render({
        ...common,
        // Kept for templates written before criteria were structured. A verify actor receives no
        // author spec; `acceptance` is its execution-definition input.
        spec: '',
        specs: `${run.brief}${anchor}`,
        diffCmd: ctx.diffCmd ?? null,
        acceptance,
        acceptanceOverflow: ctx.acceptanceOverflow ?? 0,
      });
      return assembleVerifyPrompt(`${run.brief}${anchor}`, {
        agent: ctx.agent,
        server: ctx.server,
        diffCmd: ctx.diffCmd,
        repoContext,
        workflowPrompt,
        memory,
        ...(ctx.acceptance?.length
          ? { acceptance: ctx.acceptance, acceptanceOverflow: ctx.acceptanceOverflow ?? 0 }
          : {}),
      });
    }

    return render({
      ...common,
      spec: executionSpec,
      ...(wf.promptShape === 'build'
        ? {
            verifyCmd: manifest.verify?.cmd ?? null,
            reviewer: Boolean(manifest.verify?.agent),
          }
        : {}),
    });
  }
  if (wf.promptShape === 'scope') {
    return renderPrompt('scope', {
      identity,
      brief: run.brief,
      anchor,
      context: repoContext,
      spec: executionSpec,
      memory,
    });
  }
  if (wf.promptShape === 'build') {
    // The agent is NOT told to run the verify command (RUN-29). It used to be, and the daemon then
    // ran the SAME command itself as the actual gate — so the agent paid tokens and about a minute
    // to answer a question that got asked again, properly, right afterwards. Its run was advisory;
    // the daemon's is authoritative and free. Measured on run_mrlig93q5b574b502963: ~3m24s of agent
    // time including its own verify, then 62s of daemon verify.
    // Its allowlist still permits running tests — iterating on one file while working is cheap and
    // targeted. What it must not do is burn the full suite to grade itself.
    //
    // The reviewer sentence is fairness, not just information (RUN-61): a builder that learns of
    // the reviewer only from a rejection reads it as scope creep and argues; one told up front
    // writes for the review.
    return renderPrompt('build', {
      identity,
      verifyCmd: manifest.verify?.cmd ?? null,
      reviewer: Boolean(manifest.verify?.agent),
      brief: run.brief,
      anchor,
      context: repoContext,
      spec: executionSpec,
      memory,
    });
  }
  // verify kind (RUN-20): a fresh, independent, adversarial reviewer. It receives the repo's
  // orientation by NAME only (RUN-154) — it is the actor asked whether a diff looks like this
  // repo's code, so telling it nothing about this repo was backwards, but its context is already
  // carrying the diff and inlining documents on top would crowd out the subject.
  return assembleVerifyPrompt(`${run.brief}${anchor}`, {
    agent: ctx.agent,
    server: ctx.server,
    diffCmd: ctx.diffCmd,
    repoContext,
    memory,
    ...(ctx.acceptance?.length
      ? { acceptance: ctx.acceptance, acceptanceOverflow: ctx.acceptanceOverflow ?? 0 }
      : {}),
  });
}

/**
 * What fraction of a run's remaining ceiling planning may take (RUN-140).
 *
 * A planner handed the whole remainder can spend it and leave the build it was meant to brief with
 * nothing — a run that produced a perfect plan and no work. A quarter is a judgement, not a
 * measurement: enough to read a repo and write a spec, and small enough that losing all of it
 * still leaves a build worth starting.
 */
const PLAN_BUDGET_SHARE = 0.25;

/** A budget nothing can be spent under. Handed to a builder whose run has nothing left, so the
 *  spawn declines by the same rule every other stage does rather than by a special case. */
const EXHAUSTED_BUDGET = { maxTokens: 0, maxUsd: 0, maxDurationSeconds: 1, maxRounds: null } as const;

/** The planner's share of what the run has left. Null dimensions stay null: an unbounded run does
 *  not acquire a planning ceiling nobody asked for. */
function plannerBudget(remaining: RunBudget): RunBudget {
  const share = (v: number | null) => (v == null ? null : Math.max(1, Math.floor(v * PLAN_BUDGET_SHARE)));
  return {
    maxTokens: share(remaining.maxTokens),
    maxUsd: remaining.maxUsd == null ? null : Math.max(0.01, remaining.maxUsd * PLAN_BUDGET_SHARE),
    maxDurationSeconds: share(remaining.maxDurationSeconds),
    maxRounds: remaining.maxRounds,
  };
}

/**
 * The planner's permission profile (RUN-140).
 *
 * `clampPermissionToWorkflow` at the verify posture forces `write = false`, which is the floor
 * every judging actor gets — but `auto` deliberately SURVIVES that clamp (RUN-68, and CLAUDE.md
 * says so), and `auto` on Claude means bypass-permissions with unrestricted Bash. The planner runs
 * inside a BUILD's worktree, which is physically writable, so a repo with `[permissions.build]
 * auto = true` would have handed a "read-only" planner a shell in a writable tree.
 *
 * So it is dropped here rather than in the clamp. The clamp's behaviour is a documented, deliberate
 * boundary a repo opts into for its own agents; this is a NEW actor the repo never opted anything
 * into, and it has no use for a shell — it reads files and emits JSON.
 */
export function plannerPermission(base: PermissionProfile): PermissionProfile {
  return { ...clampPermissionToWorkflow(base, BUILTIN_WORKFLOWS.verify), auto: false };
}

/** The tighter of two remainders, per dimension. Null on either side means "unbounded there", so
 *  the other one wins; null on both leaves the dimension unbounded. */
function tighter(a: RunBudget | undefined, b: RunBudget | undefined): RunBudget | undefined {
  if (!a) return b;
  if (!b) return a;
  const min = (x: number | null, y: number | null) => (x == null ? y : y == null ? x : Math.min(x, y));
  return {
    maxTokens: min(a.maxTokens, b.maxTokens),
    maxUsd: min(a.maxUsd, b.maxUsd),
    maxDurationSeconds: min(a.maxDurationSeconds, b.maxDurationSeconds),
    maxRounds: a.maxRounds ?? b.maxRounds,
  };
}

/** Add two telemetry snapshots. Used for the planning phase's own running total, which is a SUM
 *  across sessions rather than the tally's last-writer-wins per slot. */
function sumTelemetry(a: DriverTelemetry, b: DriverTelemetry): DriverTelemetry {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    costUsd: a.costUsd + b.costUsd,
    numTurns: a.numTurns + b.numTurns,
  };
}

export class RunSupervisor {
  private readonly log: typeof defaultLogger;
  /** One landing at a time per repo — see withRepoLock. */
  private readonly repoLocks = new Map<string, Promise<unknown>>();

  /** One transcript per run (RUN-74), keyed so an in-process resume CONTINUES the seq
   *  stream — the server dedups on (runId, seq), and a restarted seq would collide with
   *  rows already written and be silently dropped. */
  private readonly transcripts = new Map<string, RunTranscript>();

  private transcript(runId: string): RunTranscript {
    let t = this.transcripts.get(runId);
    if (!t) {
      const sink = this.deps.reportLog;
      t = new RunTranscript(sink ? (segments) => sink(runId, segments) : () => {});
      this.transcripts.set(runId, t);
    }
    return t;
  }

  /**
   * The surface the pipeline's stages reach (RUN-131), built as an explicit object rather than by
   * handing the stages `this`.
   *
   * Deliberate: satisfying `StageHost` structurally would mean making `landRun`, `enforceLockFloor`
   * and the rest PUBLIC on an exported class, and a typed caller could then invoke `landRun` with
   * its own policy — skipping the no-changes gate, the checkpoint, the lock floor, the deterministic
   * floor and the review that landing is only ever supposed to happen after. A refactor that
   * publishes a way around the gates it is refactoring has changed the security surface, whatever it
   * did to the control flow. Closures keep every one of them private.
   */
  private stageHost(): StageHost {
    return {
      forgetCancellation: (runId) => this.deps.steering?.forget?.(runId),
      // No history, never "unknown" (RUN-225): a bridge that cannot answer and a bridge that
      // answered empty read identically to `settle` — both are "nothing observed this sitting".
      steeringHistory: (runId) => this.deps.steering?.steeringHistory?.(runId) ?? [],
      abandonOrphanedSignal: (runId) => this.abandonOrphanedSignal(runId),
      log: this.log,
      report: (runId, frame) => this.deps.report(runId, frame),
      // A no-op without a comment sink, which is exactly how every call site already treated it.
      postComment: (projectId, taskId, body) => this.deps.postComment?.(projectId, taskId, body),
      transcript: (runId) => this.transcript(runId),
      // Close the transcript with its outcome and forget it — the stream a human reads has to END
      // (RUN-74), and a map that only ever grows is a leak with a nicer name.
      endTranscript: (runId, outcome) => {
        const t = this.transcripts.get(runId);
        if (!t) return 0;
        t.milestone(`run finished: ${outcome}`);
        t.end();
        // Read AFTER closing and before forgetting it: closing flushes whatever was buffered and
        // then appends the milestone, so the number of seqs it consumes is not fixed. Returning
        // the real value is what stops a continuation numbering into rows that already exist
        // (RUN-183) — the caller must never try to derive this by counting.
        const next = t.nextSeq();
        this.transcripts.delete(runId);
        return next;
      },
      vcsFor: (repo) => this.vcsFor(repo),
      lockScopeBranch: (repo, run) => this.lockScopeBranch(repo, run),
      withRepoLock: (root, fn) => this.withRepoLock(root, fn),
      enforceLockFloor: (repo, run, ws, token) => this.enforceLockFloor(repo, run, ws, token),
      verifyWithFeedback: (ctx) => this.verifyWithFeedback(ctx),
      reviewWithFeedback: (ctx) => this.reviewWithFeedback(ctx),
      landRun: (ctx) => this.landRun(ctx),
      onLanded: (repo, branch, sha) => this.deps.onLanded?.(repo.root, branch, sha),
      // RUN-227: the seam `StageHost.recordEpisode`'s own doc names as unwired until this task.
      // `this.deps.recordEpisode` is itself synchronous (see that dep's doc) — nothing here awaits
      // it, so `settle` calling this stays exactly as non-blocking as it was before it existed.
      recordEpisode: (episode, intelligence) => this.deps.recordEpisode?.(episode, intelligence),
      // The run's effective ceiling: the dispatch's, else the machine default (RUN-14). Only
      // `prepare` reads this — every LATER session reserves from the tally instead (RUN-133), so
      // that the run's sessions divide one ceiling rather than each receiving a copy of it.
      runBudget: (run) => mergeBudget(run.budget, this.deps.defaultBudget) ?? undefined,
      ...(this.deps.continuable ? { continuable: this.deps.continuable } : {}),
    };
  }

  constructor(private readonly deps: RunSupervisorDeps) {
    this.log = deps.logger ?? defaultLogger;
  }

  /** The repo's own backend when the daemon routed one (RUN-60), else the machine default. */
  private vcsFor(repo: ResolvedRepo): SupervisorVcs {
    return repo.vcs ?? this.deps.vcs;
  }

  /**
   * The wave seam a chain reaches source control through (RUN-170) — closures over `vcsFor(repo)`
   * and the parent RUN ID, the same DI pattern `checkpoint` already uses at both `executeChain`
   * call sites. Closures rather than the backend itself, deliberately: the chain gets exactly the
   * verbs a wave needs, with the child→parent return trip already run-addressed, so no branch or
   * ref string can originate above the seam (RUN-50's rule under concurrency).
   */
  private waveFor(repo: ResolvedRepo, run: Run): ChainWave {
    const vcs = this.vcsFor(repo);
    // The parent workspace's posture, recomputed the way `prepare` computed it: a child checkout
    // is the SAME run's workspace and must carry the same physical floor — a decomposed
    // non-producing run (scope, verify) whose steps overlap must not receive writable child trees
    // when its parent tree is read-only. The permission clamp already denies the edit tools
    // (RUN-118); this keeps the worktree-level floor symmetric with the sitting that leased first.
    const readOnly = !runWorkflow(run, repo.workflowCatalog ?? repo.manifest).worktreeWritable;
    return {
      // All three run-addressed pieces, or none: a backend (or fake) that declares overlap but
      // lacks the return-trip verbs cannot bring a child's work back, and absence is defined as
      // the safe, sequential reading (vcs/types.ts).
      leasesOverlap: Boolean(vcs.leasesOverlap && vcs.integrateFromRun && vcs.publishToRun),
      // Re-asked by the chain before each wave, not sampled here: what is spare NOW is the answer.
      limit: () => this.deps.waveLimit?.(run.id) ?? 1,
      lease: (childId) => vcs.lease(repo.root, childId, { fromRunId: run.id, readOnly }),
      checkpoint: (ws, label) => vcs.checkpoint(ws, runCommitMessage(run.id, label)),
      integrateBack: (ws) => vcs.integrateFromRun!(ws, run.id),
      abandonIntegrate: (ws) => vcs.abandonIntegrate(ws),
      publishBack: (ws) => vcs.publishToRun!(ws, run.id),
      hasWork: (ws) => vcs.hasWork(ws),
      dispose: (ws) => vcs.dispose(ws),
      // The park-state probe (RUN-30's authority) — how the chain learns a wave child stopped to
      // ask a human, since a child cannot park. Absent with parking off, exactly like parkIfBlocked.
      // A probe FAILURE propagates rather than reading as "not blocked" (RUN-152's direction —
      // the unknown answer must not become the one acted on): the chain is the actor that decides
      // what an unanswerable probe means, and coercing here decided it silently.
      ...(this.deps.getParkState
        ? { probeBlocked: async () => Boolean((await this.deps.getParkState!(run.id))?.blocked) }
        : {}),
    };
  }

  /**
   * The ONE way this supervisor starts a driver (RUN-109). Every agent spawn — main run, reviewer,
   * conflict turn, verify-fix — funnels through here so the sanitized child env is a supervisor
   * guarantee, not a per-driver habit. `env` is set BEFORE the caller's opts so an explicit
   * override still wins, but no caller sets it: they all inherit the stripped env by construction.
   *
   * The write floor is enforced here too (RUN-158), AFTER the caller's opts so nothing can spread
   * past it. Every call site already clamps and should keep doing so — the clamp at the site is
   * where the intent is legible — but "we audited every caller" is a property that decays with the
   * next caller, and it had already decayed once: `runReviewer` handed `[permissions.verify]` over
   * raw, so a repo asking for a writable verify posture got a reviewer holding Edit/Write on the
   * diff it was judging. `opts.kind` is the posture kind at every site (a custom workflow resolves
   * to its base via `effectiveKind`), so clamping by it here is exactly what the sites compute —
   * idempotent where they got it right, and the floor where a future one forgets.
   */
  private startAgent(driver: AgentDriver, opts: DriverStartOptions): BudgetRun {
    return superviseBudget(driver, {
      env: sanitizedAgentEnv(),
      ...opts,
      permission: clampPermissionToWorkflow(opts.permission, workflowFor(opts.kind)),
    });
  }

  /**
   * The branch a run's file locks are scoped to (RUN-97 §5): the branch it will LAND on, where
   * two runs actually contend — not its throwaway `noriq/run/<id>` worktree branch (on which
   * they'd never collide). The `[land]` target when configured, else the dispatch's target, else
   * the repo default. null → all-branches, the safe fallback when nothing names a target.
   */
  private lockScopeBranch(repo: ResolvedRepo, run: Run): string | null {
    if (repo.manifest.land) return resolveLandBranch(repo.manifest.land.branch, run.planKey);
    return run.targetBranch ?? repo.manifest.defaultBranch ?? null;
  }

  /**
   * The reactive per-edit lock enforcer for a build (RUN-101), or undefined when there is no
   * lock layer to enforce through. Bound to the run's workspace + agent token + scope branch, so
   * the driver's PreToolUse hook locks each path the agent edits, as that run's holder. Only for
   * `build`: scope and verify never write, so they never take a write lock.
   */
  private lockEnforcerFor(
    repo: ResolvedRepo,
    run: Run,
    worktree: Workspace,
    kind: RunKind,
    token: string,
  ): LockEnforcer | undefined {
    const vcs = this.vcsFor(repo);
    if (!workflowFor(kind).produces || !vcs.lock || !vcs.unlock) return undefined;
    const ctx: LockContext = {
      projectId: run.projectId,
      token,
      branch: this.lockScopeBranch(repo, run),
      taskId: run.anchor?.type === 'task' ? run.anchor.taskId : null,
    };
    return new LockEnforcer({
      root: worktree.localPath,
      lock: (paths) => vcs.lock!(worktree, paths, ctx),
      release: (paths) => vcs.unlock!(worktree, { paths }, ctx).then(() => undefined),
      onDeny: (paths, conflicts) => {
        this.log.info('lock hook denied an edit to a peer-held path', {
          runId: run.id,
          paths,
          holders: conflicts.map((c) => c.holderName ?? c.holder),
        });
        // Surface it in the run view (RUN-106) via the transcript pipeline (RUN-74): the human
        // watching sees WHY an edit was blocked, and by whom.
        this.transcript(run.id).milestone(
          `🔒 lock hook blocked an edit to ${paths.join(', ')} — held by ${conflicts
            .map((c) => c.holderName ?? c.holder)
            .join(', ')}`,
        );
      },
    });
  }

  /**
   * The hard floor (RUN-102): before a build's diff is made durable, acquire locks over EVERY
   * path it changed, as the run's holder. For a Claude build this is an idempotent renew of what
   * the reactive hook already took; for a Codex build (no in-process hook) it is the FIRST
   * acquisition — and a conflict means the run edited a path a peer holds, so the run is gated
   * rather than allowed to clobber. Daemon-side, so no token ever reaches the agent's shell.
   *
   * Three outcomes, and the third is the one RUN-156 added: the floor could not COMPLETE its check.
   * That used to arrive as a pass, by two different routes — a failed enumeration became an empty
   * path set (nothing to lock), and a failed lock call became `{ ok: true }`. Both reported success
   * for a check that never happened.
   *
   * Both now fail CLOSED, and the earlier draft of this fix got that wrong. It kept the lock call
   * failing OPEN on the grounds that "the reactive hook and the dispatch-time check are still
   * standing" — which is false in exactly the case this floor exists for. A Codex build has no
   * in-process hook, and a first sitting declares no predictive scope, so for that run this call IS
   * the only acquisition and its failure means nothing was checked at all.
   *
   * What gating costs is bounded and what it prevents is not: the diff is checkpointed just above,
   * `driverSucceeded` stays true so the workspace is kept, and the run is recorded continuable — so
   * a Noriq blip costs a re-dispatch, while the alternative is landing over a peer's held file with
   * no line anywhere saying the check was skipped.
   *
   * A project with locking genuinely DISABLED still passes: that is a service saying `enabled:
   * false`, which is an answer.
   */
  private async enforceLockFloor(
    repo: ResolvedRepo,
    run: Run,
    worktree: Workspace,
    token: string,
  ): Promise<LockFloorOutcome> {
    const vcs = this.vcsFor(repo);
    if (!vcs.lock || !vcs.changedPaths) return { conflicts: [] };
    let paths: string[];
    try {
      paths = await vcs.changedPaths(worktree);
    } catch (err) {
      return { conflicts: [], unchecked: `could not read what this run changed: ${err}` };
    }
    if (!paths.length) return { conflicts: [] };
    const ctx: LockContext = {
      projectId: run.projectId,
      token,
      branch: this.lockScopeBranch(repo, run),
      taskId: run.anchor?.type === 'task' ? run.anchor.taskId : null,
    };
    let outcome: LockOutcome;
    try {
      outcome = await vcs.lock(worktree, paths, ctx);
    } catch (err) {
      return { conflicts: [], unchecked: `the lock service did not answer: ${err}` };
    }
    return { conflicts: outcome.ok ? [] : outcome.conflicts };
  }

  /**
   * The branch a run forks from — and is measured against — instead of HEAD (RUN-82): the
   * resolved `[land]` target, when it is configured AND already exists (a predecessor landed on
   * it). This is what lets a later task in a plan see its predecessors' work: they land on the
   * plan's working branch, so a run based there starts from that accumulation and its landing
   * rebase is a trivial fast-forward. Null when no `[land]`, or the target does not exist yet
   * (the first task in a plan) — the run forks from HEAD, exactly as before. The dispatch's
   * targetBranch override is deliberately NOT applied here: it is validated at land time, and
   * forking from the computed plan branch keeps lease-time free of that decision.
   */
  private async planBase(repo: ResolvedRepo, run: Run): Promise<string | null> {
    const land = repo.manifest.land;
    if (!land) return null;
    const target = resolveLandBranch(land.branch, run.planKey);
    const exists = await this.vcsFor(repo)
      .targetExists(repo.root, target)
      .catch(() => false);
    return exists ? target : null;
  }

  /**
   * Serialize work per repo. rebase → verify → fast-forward is a read-modify-write of
   * one branch: two concurrent runs would each rebase onto the same tip, each verify a
   * combination the other never saw, and the loser's fast-forward would fail (or worse,
   * succeed against a tip that moved). Queueing costs a verify's wall-clock on the second
   * run and buys a correct answer.
   */
  private withRepoLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.repoLocks.get(root) ?? Promise.resolve();
    // Run next regardless of how the previous one settled — a failed landing must not
    // wedge the queue for every later run.
    const next = prev.then(fn, fn);
    this.repoLocks.set(
      root,
      next.catch(() => {}),
    );
    return next;
  }

  /**
   * Land a passing build: rebase onto the integration branch, re-verify the result, and
   * fast-forward it in. Every failure path leaves the run's branch intact — the work is
   * never lost, it just waits for a human.
   */
  private async landRun(ctx: {
    run: Run;
    repo: ResolvedRepo;
    worktree: Workspace;
    policy: LandPolicy;
    task: AnchorTask | null;
    driver: AgentDriver;
    permission: PermissionProfile;
    noriqMcp?: NoriqMcp;
    budget?: RunBudget;
    /** The run's cross-session tally (RUN-59): a conflict-resolution turn spends real tokens, and
     *  resolveConflict records them into it. */
    tally: RunTally;
    /** The still-live build session, when the run was started multiTurn — so a gate failure on
     *  the rebased result can be handed back rather than ending the run (RUN-29). */
    session?: DriverSession;
  }): Promise<LandOutcome> {
    const { run, repo, worktree, policy } = ctx;
    // Per-plan working branch (RUN-28): `[land].branch` may template `<planKey>`, so each plan
    // accumulates on its own branch and its merge request is one coherent body of work. The plan
    // is resolved server-side and frozen on the Run at dispatch — the daemon cannot work it out,
    // since a task-anchored run only knows its task and plan membership lives in phase_tasks.
    const computed = resolveLandBranch(policy.branch, run.planKey);

    // A dispatch may steer its own landing branch (RUN-41) — but only inside the envelope the
    // REPO allows. The manifest is the authority: the repo owner and whoever clicked dispatch are
    // not always the same person, and `[land]` authorises landing *here*, not landing anywhere.
    //
    // A refused override FAILS the run rather than quietly landing on the default. Someone asked
    // for a specific branch; silently doing something else with an agent's diff is how work ends
    // up somewhere nobody looked.
    let branch = computed;
    if (run.targetBranch && run.targetBranch !== computed) {
      const refusal = rejectTargetBranch(run.targetBranch, policy);
      if (refusal) {
        this.log.warn('refusing the dispatch’s branch override', {
          runId: run.id,
          target: run.targetBranch,
          refusal,
        });
        return { landed: false, branch: computed, reason: 'error', detail: refusal };
      }
      branch = run.targetBranch;
    }
    const vcs = this.vcsFor(repo);

    // First landing into this branch: fork it from the repo's declared main so the
    // integration line starts somewhere sane rather than from this run's base.
    if (!(await vcs.targetExists(repo.root, branch))) {
      const from = repo.manifest.defaultBranch ?? worktree.baseId;
      await vcs.createTarget(repo.root, branch, from);
      this.log.info('created the landing branch', { branch, from });
    }

    let rebase = await vcs.integrate(worktree, branch);
    let resolvedByAgent: boolean | undefined;
    let agentSaid = '';

    if (!rebase.ok) {
      const conflicts = rebase.conflicts;
      // A backend whose conflicts live server-side (Diversion) names the page a human
      // resolves them on. Its presence also means agent resolution CANNOT work there — the
      // conflict is not in the files — so it routes straight to the human path.
      const resolveUrl = rebase.resolveUrl;
      if (!policy.resolveConflicts || resolveUrl) {
        await vcs.abandonIntegrate(worktree);
        return { landed: false, branch, reason: 'conflict', conflicts, detail: resolveUrl };
      }
      this.log.info('rebase conflict — asking the build agent whether it is mechanical', {
        runId: run.id,
        conflicts,
      });
      const attempt = await this.resolveConflict(ctx, conflicts);
      agentSaid = attempt.text;
      resolvedByAgent = attempt.resolved;
      if (!attempt.resolved) {
        // The agent judged it needs a human. That is the correct answer, not a failure —
        // picking a winner would silently discard someone's work.
        await vcs.abandonIntegrate(worktree);
        return {
          landed: false,
          branch,
          reason: 'conflict',
          conflicts,
          resolvedByAgent: false,
          detail: agentSaid,
        };
      }
      const cont = await vcs.resumeIntegrate(worktree);
      if (!cont.ok) {
        await vcs.abandonIntegrate(worktree);
        return {
          landed: false,
          branch,
          reason: 'conflict',
          conflicts: cont.conflicts,
          resolvedByAgent: false,
          detail: `the agent said RESOLVED: YES but conflict markers remained in: ${cont.conflicts.join(', ')}`,
        };
      }
      rebase = { ok: true };
    }

    // The gate, on the REBASED result — the thing that will actually land. A failure is handed
    // back to the live agent (RUN-29), which matters most HERE: this verify runs on the rebase, so
    // the break may be a collision with work that landed while this run was going. That is exactly
    // the failure an agent can fix in context and a human should not have to re-derive.
    //
    // The CMD half only (RUN-61): the reviewer already judged intent before landing began, and a
    // rebase does not change what the diff means — it changes whether the COMBINATION still works,
    // which is precisely the deterministic command's question. Re-running an agent review inside
    // the repo lock would serialize every other run behind a judgment call that cannot change.
    const rebaseGate = cmdVerify(repo.manifest.verify);
    // The rebase gate's own observation (RUN-225), attached to whichever `LandOutcome` this call
    // returns below — undefined unless this block actually runs the command (autoPush-only
    // policies, or a rebase that never got this far, leave it unset rather than a lie).
    let commandObserved: CommandObservation | undefined;
    if (policy.onlyWhenVerifyPasses && rebaseGate) {
      // The sessionless path (no live agent to hand a failure back to) runs the command exactly
      // once — `attempts: 1` is not a default standing in for a missing observation, it is what
      // happened.
      const result = ctx.session
        ? await this.verifyWithFeedback({
            run: ctx.run,
            spec: rebaseGate,
            cwd: worktree.localPath,
            session: ctx.session,
            tally: ctx.tally,
            phase: 'landing', // this verify IS the landing pipeline; don't rename it mid-flight
          })
        : {
            ...(await timedVerify(
              rebaseGate,
              worktree.localPath,
              (d) => {
                this.log.info('deterministic verify (landing, sessionless) timed', {
                  runId: ctx.run.id,
                  cmd: rebaseGate.cmd,
                  durationMs: d,
                });
                ctx.tally.recordVerifyDuration(d);
              },
              { exec: this.deps.verifyExec },
            )),
            attempts: 1,
          };
      commandObserved = {
        site: 'landing',
        cmd: rebaseGate.cmd,
        passed: result.passed,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        attempts: result.attempts,
      };
      if (!result.passed) {
        return {
          landed: false,
          branch,
          reason: 'verify',
          detail: result.output,
          resolvedByAgent,
          commandObserved,
        };
      }
      this.log.info('verify passed on the rebased result', { runId: run.id, branch });
      // A fix the live agent made to pass THIS gate lives only in the working tree, but publish
      // fast-forwards the branch's committed HEAD — so without folding it in, the landed (and, under
      // autoPush, pushed) result would silently drop the fix and land the broken combination the
      // gate just rejected. Same working-tree-vs-committed split as the inline reviewer's. A clean
      // tree (gate passed first try, or the sessionless runVerify path) is a no-op checkpoint.
      await vcs.checkpoint(worktree, runCommitMessage(run.id, 'landing fix')).catch((err) => {
        this.log.warn('could not commit the landing fix — the branch may fast-forward without it', {
          runId: run.id,
          err: String(err),
        });
        return false;
      });
    }

    const ff = await vcs.publish(worktree, branch);
    if (!ff.ok) {
      // Distinguish "the branch moved" (retryable) from "git refused" (needs a human) —
      // collapsing both into 'race' sends everyone hunting a concurrency bug that isn't
      // there, which is exactly what happened the first time this ran against `main`.
      return { landed: false, branch, reason: ff.reason, detail: ff.detail, resolvedByAgent };
    }

    // The work is landed. Everything below is about whether it also LEAVES this machine —
    // opt-in, default false, because it crosses the boundary the rest of the model rests on
    // (RUN-27). A failure here must never fail the run: the diff is on the branch either way,
    // and reporting "failed" would send someone hunting for work that is right there.
    if (!ctx.policy.autoPush) {
      return {
        landed: true,
        branch,
        sha: ff.sha,
        resolvedByAgent,
        ...(commandObserved ? { commandObserved } : {}),
      };
    }
    const push = await vcs.share(ctx.repo.root, branch);
    if (!push.ok) {
      this.log.warn('landed, but the push failed — the work is on the branch locally', {
        runId: ctx.run.id,
        branch,
        detail: push.detail,
      });
    }
    return {
      landed: true,
      branch,
      sha: ff.sha,
      resolvedByAgent,
      pushed: push.ok,
      ...(commandObserved ? { commandObserved } : {}),
      ...(push.ok ? {} : { pushDetail: push.detail }),
    };
  }

  /**
   * Run the gate, and hand a failure back to the LIVE agent to fix (RUN-29).
   *
   * The daemon owns the verdict — it always did, for free, on the real thing. What changes is what
   * happens next: a failing gate used to end the run, so a human re-dispatched and a fresh agent
   * re-derived a failure whose exact output the daemon already had. Now the same session gets the
   * command, the code and the output, fixes it, and the gate re-runs.
   *
   * Bounded (RUN-21's K=2, since RUN-94 the repo may commit its own `[verify] maxRounds`): an
   * agent that cannot fix it in a couple of tries will usually keep spending, so the default
   * stays tight. The budget still applies underneath, so a loop cannot outrun its ceiling.
   */
  /** The verify command's outcome, in the transcript (RUN-74): a pass is one system line, a
   *  failure also carries the output tail in the 'verify' voice — the part a human reads. */
  private recordVerifyOutcome(
    transcript: RunTranscript,
    cmd: string,
    result: { passed: boolean; exitCode: number | null; timedOut: boolean; output: string },
  ): void {
    if (result.passed) {
      transcript.milestone(`verify command passed (\`${cmd}\`)`);
      return;
    }
    transcript.milestone(
      `verify command FAILED (\`${cmd}\`${result.timedOut ? ', timed out' : `, exit ${result.exitCode}`})`,
    );
    transcript.text('verify', result.output.slice(-4000) || '(no output)');
    transcript.flush();
  }

  private async verifyWithFeedback(ctx: {
    run: Run;
    spec: VerifySpec;
    cwd: string;
    session: DriverSession;
    /** The run's cross-session tally (RUN-133): a hand-back turn's active seconds are charged to
     *  it when the turn ends, which is what a later session's reservation — and the live
     *  `clockGuard` re-arming this session's own deadline (RUN-159) — is short by. */
    tally: RunTally;
    /** The phase to return to between fix turns — 'verifying' on the standalone gate,
     *  'landing' when this runs inside the landing pipeline (RUN-31). */
    phase: RunPhase;
  }): Promise<VerifyResult & { attempts: number }> {
    const transcript = this.transcript(ctx.run.id);
    // One duration per attempt (RUN-242) — logged as it happens rather than folded into one figure
    // for the whole call, since a retry loop's later attempts are a DIFFERENT command run, not a
    // continuation of the first one's clock. Also RECORDED onto the run's tally now (RUN-284), not
    // merely logged — `intelligence-payload.ts` is what folds the per-attempt list `settle` reads
    // off `ctx.tally.verifyDurations()` into the sum semantics locked decision.
    const logDuration = (attempt: number) => (d: IntelligenceDurationMs) => {
      this.log.info('deterministic verify command timed', {
        runId: ctx.run.id,
        cmd: ctx.spec.cmd,
        attempt,
        durationMs: d,
      });
      ctx.tally.recordVerifyDuration(d);
    };
    let result = await timedVerify(ctx.spec, ctx.cwd, logDuration(1), { exec: this.deps.verifyExec });
    this.recordVerifyOutcome(transcript, ctx.spec.cmd, result);
    // How many times THIS call actually ran the command (RUN-225) — the daemon's own observation,
    // separate from `rounds` below (the CEILING on retries, which a session with nothing left to
    // fix never exhausts).
    let attempts = 1;
    // continueWith is absent unless the run was started multiTurn — a run with no live session to
    // talk to (or a driver that cannot) simply gets the verdict, exactly as before.
    if (result.passed || !ctx.session.continueWith) return { ...result, attempts };

    // The repo's committed bound, else the daemon's K=2 (RUN-94). 0 = a pure gate: the verdict
    // stands and no fix turn is spent — the repo said so, in the commit.
    const rounds = verifyFixRounds(ctx.spec);
    for (let attempt = 1; attempt <= rounds; attempt++) {
      this.log.info('verify failed — handing it back to the live agent', {
        runId: ctx.run.id,
        attempt,
        exitCode: result.exitCode,
      });
      // Tokens burn again on a fix turn, so the phase has to say 'agent' or the spend appears
      // to climb during "verifying" — the same lie this task exists to stop telling (RUN-31).
      this.deps.report(ctx.run.id, { status: 'running', phase: 'agent' });
      // A hand-back is more agent time on the run's clock (RUN-133). Its TOKENS are policed live by
      // the session's spendGuard and its SECONDS by the deadline re-armed around this turn
      // (RUN-159) — but the deadline is enforcement, not accounting: charging the stretch here is
      // what makes the next session's reservation, and the next turn's own deadline, short by it.
      const fixStartedAt = monotonicMs();
      const exit = await ctx.session
        .continueWith(verifyFeedbackPrompt(ctx.spec, result, attempt))
        .catch((err): DriverExit | null => {
          this.log.warn('could not hand the failure back', { runId: ctx.run.id, err: String(err) });
          return null;
        })
        .finally(() => ctx.tally.chargeTime((monotonicMs() - fixStartedAt) / 1000));
      // The agent died, errored, or breached its budget trying to fix it. Its last verdict stands;
      // pushing more turns at a session that just failed is how a loop becomes a spend. The RUN's
      // reason stays the gate's, deliberately — the failing verify is what a human must act on —
      // so the turn's own reason is logged here or it is lost (RUN-159).
      if (!exit || exit.outcome !== 'done') {
        if (exit?.reason)
          this.log.info('the fix turn ended early', { runId: ctx.run.id, reason: exit.reason });
        return { ...result, attempts };
      }
      this.deps.report(ctx.run.id, { status: 'running', phase: ctx.phase });
      result = await timedVerify(ctx.spec, ctx.cwd, logDuration(attempt + 1), { exec: this.deps.verifyExec });
      attempts += 1;
      this.recordVerifyOutcome(transcript, ctx.spec.cmd, result);
      if (result.passed) {
        this.log.info('verify passed after the agent fixed it', { runId: ctx.run.id, attempt });
        return { ...result, attempts };
      }
    }
    return { ...result, attempts };
  }

  /**
   * The inline reviewer loop (RUN-61): a FRESH agent judges the diff against the intent; a FAIL
   * report is handed to the LIVE builder to fix, then a fresh reviewer looks again. Bounded by
   * `[verify.agent] maxRounds` for the same reason verifyWithFeedback is bounded by K=2, and the
   * budget still applies underneath.
   *
   * Every round gets a NEW reviewer session — never a continuation. A reviewer that has already
   * said FAIL and then watches the fix arrive is grading its own instructions; a fresh one judges
   * the work as it stands, which is the property the gate exists for.
   */
  private async reviewWithFeedback(ctx: {
    run: Run;
    repo: ResolvedRepo;
    worktree: Workspace;
    driver: AgentDriver;
    /** The live build session — the feedback target, NOT the reviewer's. */
    session: DriverSession;
    task: AnchorTask | null;
    /** The run's cross-session tally (RUN-59): each reviewer round records its spend here so the
     *  run's mix includes the reviewer's model, which may be a different vendor entirely. */
    tally: RunTally;
    /** Live accessor for the builder session's output, so the fix turn's structured RESPONSE
     *  block can be captured and fed into the next reviewer's ledger (RUN-79). */
    getSessionText?: () => string;
    budget?: RunBudget;
    /** A prior attempt's adjudication ledger, on a "continue a failed run" (RUN-92): the first
     *  fresh reviewer starts from the findings the earlier sitting already settled instead of
     *  relitigating them. Empty/absent on a normal run. */
    priorLedger?: LedgerEntry[];
    /** The numbered acceptance criteria every round's reviewer answers (RUN-145). */
    acceptance?: AcceptanceItem[];
    acceptanceOverflow?: number;
    /** The requirement ids a finding may name (RUN-147). */
    requirements?: string[];
    /** Whether the deterministic command has already run (RUN-177) — false on the landing path. */
    verifyRan?: boolean;
    /** The run's Noriq connection — each reviewer round gets the escalation pair through it. */
    noriqMcp?: NoriqMcp;
    /** The run's agent identity — what a review-stage park is recorded under (RUN-190). */
    runAgent?: { agentId: string; label: string; token: string };
    /** A fix round's own deterministic re-check ran (RUN-225) — reported so the caller can fold it
     *  into the episode's command evidence; this method has no `RunPipeline` of its own to write. */
    onCommandObserved?: (o: CommandObservation) => void;
    /** RUN-231: the run's verified context pack, carried from `RunPipeline.verifiedContextPack` —
     *  every reviewer round (including the terminal contest's re-adjudication) renders it fresh
     *  through the reviewer-audience frame. Absent/null → no memory block, exactly as before this
     *  task existed. */
    verifiedContextPack?: VerifiedContextPack | null;
  }): Promise<VerifyVerdict & { rounds: number; ledger: LedgerEntry[]; looks: number }> {
    const reviewer = ctx.repo.manifest.verify?.agent;
    // The repo's committed round budget is the ceiling; a dispatch may only spend UP TO it.
    const manifestRounds = reviewer?.maxRounds ?? 0;
    // A "continue a failed run" dispatch (PLNR-180) carries budget.maxRounds — a fresh reviewer-
    // round budget for the kept worktree. The manifest clamps it: the server never reads the repo
    // owner's [verify.agent].maxRounds, so it can't be widened past what the owner committed
    // (RUN-91). Null (a normal dispatch) → the manifest's own value, unchanged.
    const maxRounds =
      ctx.budget?.maxRounds != null ? Math.min(ctx.budget.maxRounds, manifestRounds) : manifestRounds;
    // The same intent a dispatched verify run would get: the anchor task's text, else the brief.
    const intent = ctx.task
      ? `${ctx.task.key} — ${ctx.task.title}${ctx.task.body ? `\n\n${ctx.task.body}` : ''}`
      : ctx.run.brief;
    const floorCmd = cmdVerify(ctx.repo.manifest.verify);

    const transcript = this.transcript(ctx.run.id);

    // runReviewer inspects `git diff baseId...HEAD` — a COMMITTED range. Anything the builder
    // left only in the working tree is invisible to it: the pre-review deterministic floor may
    // already have handed a fix turn back (afterDriver), and every fix round below adds more.
    // Fold the current tree into the branch before each look, or the fresh reviewer re-reads the
    // SAME commit and re-reports the SAME findings every round while the floor — which shells out
    // over the working tree — silently passes. This is the exact split that failed RUN-56: verify
    // green, review red, forever. Committing here is also what lets a post-review landing rebase
    // the fixes in rather than fast-forwarding past uncommitted work.
    const foldFixIntoBranch = (label: string) =>
      this.vcsFor(ctx.repo)
        .checkpoint(ctx.worktree, runCommitMessage(ctx.run.id, label))
        .catch((err) => {
          this.log.warn('could not commit before re-review — the reviewer may not see the fix', {
            runId: ctx.run.id,
            err: String(err),
          });
          return false;
        });

    // The cross-round adjudication ledger (RUN-79): findings raised in earlier rounds plus the
    // builder's structured rebuttal to each, carried to every fresh reviewer so a settled finding
    // is verified rather than relitigated. Seeded from a prior attempt on a continue (RUN-92);
    // empty on the first look of a normal run.
    let ledger: LedgerEntry[] = ctx.priorLedger ?? [];

    /**
     * Fold a round's findings into the ledger AS SOON AS THEY ARE RAISED, rather than only when a
     * fix turn follows them.
     *
     * They used to enter inside the fix loop, which meant the LAST round's findings never entered
     * at all — including the terminal ones that actually failed the run, which are the ones a human
     * most wants recorded. A repo with `maxRounds = 0` (a pure gate, no hand-back) had an empty
     * ledger however much its reviewer found. RUN-147 makes that visible: the per-requirement
     * report reads the ledger, so an unrecorded finding is a requirement reported as clear.
     *
     * Entered with no responses, so they read as 'unanswered' — which is exactly true until the
     * builder answers. The response folds onto the SAME entry later, and `buildLedger` keeps an
     * existing adjudication when a re-raise brings none, so nothing is lost.
     *
     * Recorded whatever the VERDICT was, including `unknown`. A reviewer that wrote three findings
     * and then crashed found three real things, and dropping them because it never reached its
     * verdict line is the same discarding-partial-work mistake RUN-145 fixed for acceptance
     * evidence. It cannot inflate a failure either: on a PASS nothing counts as standing anyway
     * (requirementOutcomes), and an `unknown` gates the run on its own terms.
     */
    const record = (v: VerifyVerdict, round: number) => {
      ledger = buildLedger(ledger, parseFindings(v.findings), [], round);
    };

    // Every ACTUAL reviewer invocation (RUN-225) — distinct from `rounds` below, which counts fix
    // rounds spent. Incremented at the two call sites of `runReviewer` in this method (the initial
    // look and each re-review) plus whatever `contestTerminalFindings` adds for its own re-
    // adjudication, so it reads as the true look count at every return, including a first-look PASS.
    let looks = 1;

    await foldFixIntoBranch('pre-review checkpoint');
    let verdict = await this.runReviewer({ ...ctx, intent, round: 1, ledger });
    transcript.milestone(reviewVerdictMilestone(verdict, 1));
    record(verdict, 1);
    if (verdict.passed || !ctx.session.continueWith) return { ...verdict, rounds: 0, ledger, looks };

    for (let round = 1; round <= maxRounds; round++) {
      // Only a clear FAIL is a refusal. 'unknown' means NO JUDGMENT — the reviewer was killed,
      // crashed, breached its ceiling, or never wrote a VERDICT line (RUN-72's dogfood: a human
      // killing a hung codex reviewer read as "reviewer refused the work"). There are no
      // findings to hand the builder, and a fix turn against a non-report is pure spend.
      if (verdict.verdict !== 'fail') return { ...verdict, rounds: round - 1, ledger, looks };
      // An HONOURED structural escalation ends the loop here (RUN-175): the reviewer has diagnosed
      // an invariant with no single enforcement point and evidenced it, so every remaining fix
      // round would buy patched sites while the class survives — the RUN-66 death, foreseen
      // instead of relived. The verdict (escalation riding on it) goes back a FAIL; the review
      // stage reports the diagnosis and its own terminal reason. The findings are already in the
      // ledger (recorded when raised), so a continuation still sees them.
      if (verdict.escalation) return { ...verdict, rounds: round - 1, ledger, looks };
      this.log.info('reviewer refused the work — handing the report to the live agent', {
        runId: ctx.run.id,
        round,
        verdict: verdict.verdict,
      });
      transcript.milestone(
        `handing the reviewer's report to the live agent (fix round ${round}/${maxRounds})`,
      );
      // This round's findings, for the ledger — parsed from the reviewer's OWN output (its
      // numbered FINDING lines), so the builder's response can be paired to them by number.
      const findings = parseFindings(verdict.findings);
      // Tokens burn on a fix turn — the phase must say so (RUN-31).
      this.deps.report(ctx.run.id, { status: 'running', phase: 'agent' });
      // Snapshot the builder's output length BEFORE the fix turn; the delta after is exactly the
      // fix turn's text, from which we parse the structured RESPONSE block (RUN-79). Captured here,
      // before the floor re-verify below can append its own turns.
      const textBefore = ctx.getSessionText?.().length ?? 0;
      // Same as the deterministic floor's hand-back: the seconds are charged here (RUN-133).
      const fixStartedAt = monotonicMs();
      const exit = await ctx.session
        .continueWith(
          reviewerFeedbackPrompt(
            verdict.findings,
            round,
            maxRounds,
            // The gate's own evidence, turned into what is left to do (RUN-146). Built from THIS
            // round's verdict, so a criterion the builder satisfied last round is not re-issued as
            // outstanding work.
            buildRepairSpec(verdict.acceptance, findings),
          ),
        )
        .catch((err): DriverExit | null => {
          this.log.warn('could not hand the report back', { runId: ctx.run.id, err: String(err) });
          return null;
        })
        .finally(() => ctx.tally.chargeTime((monotonicMs() - fixStartedAt) / 1000));
      const fixText = ctx.getSessionText?.().slice(textBefore) ?? '';
      // Fold this round's findings + the builder's rebuttal into the ledger the NEXT reviewer
      // sees. A CONTESTED pointer naming a task is checked FIRST (RUN-188, the same path the
      // terminal contest uses), so the fact — verified or not — rides the fold and reaches the
      // fresh reviewer as data it could never look up itself.
      const fixResponses = await this.verifyTaskPointers(ctx.run.id, parseFindingResponses(fixText));
      ledger = buildLedger(ledger, findings, fixResponses, round);
      // The builder died, errored, or breached its budget on the fix. The reviewer's verdict
      // stands; pushing more turns at a session that just failed is how a loop becomes a spend.
      // Same as the floor's hand-back: the run keeps the reviewer's reason, so the turn's own
      // reason is logged here or nobody ever learns the session ran out (RUN-159).
      if (!exit || exit.outcome !== 'done') {
        if (exit?.reason)
          this.log.info('the fix turn ended early', { runId: ctx.run.id, reason: exit.reason });
        return { ...verdict, rounds: round, ledger, looks };
      }
      this.deps.report(ctx.run.id, { status: 'running', phase: 'verifying' });
      // A fix that satisfies the reviewer but breaks the typecheck must not slip through: the
      // deterministic floor re-runs (with its own bounded feedback) before the re-review.
      if (floorCmd) {
        const floor = await this.verifyWithFeedback({
          run: ctx.run,
          spec: floorCmd,
          cwd: ctx.worktree.localPath,
          session: ctx.session,
          tally: ctx.tally,
          phase: 'verifying',
        });
        // A real command the daemon watched exit (RUN-225) — reported whether it passed or not, so
        // the episode shows the re-check happened even when it is what ends the round below.
        ctx.onCommandObserved?.({
          site: 'review-fix',
          cmd: floorCmd.cmd,
          passed: floor.passed,
          exitCode: floor.exitCode,
          timedOut: floor.timedOut,
          attempts: floor.attempts,
        });
        if (!floor.passed) {
          return {
            verdict: 'fail',
            passed: false,
            rounds: round,
            ledger,
            looks,
            findings: `the fix for the reviewer's findings broke the deterministic check (\`${floorCmd.cmd}\`):\n${floor.output.slice(-4000)}`,
          };
        }
      }
      // Commit the builder's fix (and any floor-fix turn above) so the fresh reviewer's
      // `baseId...HEAD` actually advances to include it — without this the re-review is a no-op.
      await foldFixIntoBranch(`reviewer fix round ${round}`);
      verdict = await this.runReviewer({ ...ctx, intent, round: round + 1, ledger });
      looks += 1;
      transcript.milestone(reviewVerdictMilestone(verdict, round + 1));
      record(verdict, round + 1);
      if (verdict.passed) return { ...verdict, rounds: round, ledger, looks };
    }
    // RUN-174: one adjudication turn before the run reports a TERMINAL-round FAIL. The terminal
    // round is where the run ENDS, so a finding raised there for the first time was never fixable
    // OR contestable — both the RUN-66 and RUN-88 dogfood runs died exactly this way, on [medium]
    // findings nobody could answer. The builder gets ONE turn to CONTEST a finding with a pointer
    // (it may NOT change code), then a FRESH reviewer judges the SAME diff plus that new ledger
    // evidence. Deliberately not a fix round: a fix round is budget for new work, and giving the
    // terminal round one would only move the terminal round.
    //
    // Fires only for a clean `fail` that named findings the builder can answer BY NUMBER. An
    // `unknown` is a non-report already returned above (verdict.verdict !== 'fail'), with nothing to
    // contest; a FAIL that wrote no numbered FINDING line gives the RESPONSE block nothing to key
    // to — the ledger holds no entry a pointer could land on. continueWith is already guaranteed
    // here (the passed/no-continueWith return above narrowed it), and the method re-checks it before
    // the turn regardless, since it is what makes the contest a turn on the live builder session.
    // …and never for an honoured escalation (RUN-175): the contest exists to let a builder rebut
    // per-finding claims with pointers, but an escalation is a diagnosis about the DESIGN — that no
    // single check can hold the promise — and the adjudicator for that is the human the diagnosis
    // is surfaced to, not one more spent turn. Stopping the spend is the token's whole point.
    const terminalFindings =
      verdict.verdict === 'fail' && !verdict.escalation ? parseFindings(verdict.findings) : [];
    if (terminalFindings.length) {
      const contested = await this.contestTerminalFindings(
        { ...ctx, intent },
        {
          verdict,
          findings: terminalFindings,
          terminalRound: maxRounds + 1,
          rounds: maxRounds,
          ledger,
          looks,
        },
      );
      if (contested) return contested;
    }
    return { ...verdict, rounds: maxRounds, ledger, looks };
  }

  /**
   * The repo's orientation for a judging actor (RUN-154), resolved HERE rather than threaded from
   * the run's own context. The inline reviewer is reached by two entry paths — a run that finished
   * in one sitting and one resumed days later in a different process (RUN-30) — and only the first
   * ever assembled a prompt, so only the first has a resolved context to pass down. Resolving at
   * the point of use is what makes both paths behave the same, and it is names-only, so it costs
   * a handful of stats and reads no files.
   *
   * Never fatal: a reviewer with no orientation is exactly the reviewer we had before this, so a
   * broken `[context]` degrades the review rather than failing the gate.
   */
  private async reviewerContext(repo: ResolvedRepo, ws: Workspace): Promise<string> {
    return loadRepoContextBrief(ws.localPath, repo.manifest.context, { probe: this.deps.pathProbe })
      .then((c) => c.rendered)
      .catch((err) => {
        this.log.warn('could not resolve [context] for the reviewer — reviewing without it', {
          repo: repo.manifest.key,
          err: String(err),
        });
        return '';
      });
  }

  /** One fresh reviewer session over the build's worktree. Read-only profile, no Noriq
   *  credential, verdict parsed from its output. */
  private async runReviewer(ctx: {
    run: Run;
    repo: ResolvedRepo;
    worktree: Workspace;
    driver: AgentDriver;
    intent: string;
    budget?: RunBudget;
    /** Which look this is (1 = the first review) — transcript attribution (RUN-74). */
    round: number;
    /** The run's cross-session tally (RUN-59): this reviewer's spend is recorded into it under a
     *  per-round slot, so the run's total + mix count the reviewer's model. */
    tally: RunTally;
    /** Findings adjudicated in earlier rounds (RUN-79) — empty on the first look. */
    ledger?: LedgerEntry[];
    /** The numbered acceptance criteria to answer one by one (RUN-145). Empty → this reviewer is
     *  asked for a verdict in prose, exactly as before. */
    acceptance?: AcceptanceItem[];
    acceptanceOverflow?: number;
    /** The requirement ids a finding may name (RUN-147). */
    requirements?: string[];
    /** Whether the deterministic command has already run (RUN-177) — false on the landing path. */
    verifyRan?: boolean;
    /** The run's Noriq connection, for the escalation pair alone (see the spawn below). */
    noriqMcp?: NoriqMcp;
    /** The run's agent identity — what a review-stage park is recorded under (RUN-190). */
    runAgent?: { agentId: string; label: string; token: string };
    /** A prior ask's Q&A block, appended to this round's prompt (RUN-190). */
    stageAnswer?: string;
    /** How many times this round has already paused the run — the cap that stops a reviewer
     *  answering every answer with another question from holding the run forever. */
    asks?: number;
    /** RUN-231: the run's verified context pack. Rendered fresh EVERY round through the
     *  reviewer-audience frame (`memory-render.ts`), the same "resolved at the point of use"
     *  posture `reviewerContext` above already has for `[context]` — this method is reached by
     *  two entry paths (a run that finishes in one sitting, one resumed in another process,
     *  RUN-30) and only the first ever threaded a prompt to begin with. */
    verifiedContextPack?: VerifiedContextPack | null;
  }): Promise<VerifyVerdict> {
    const manifest = ctx.repo.manifest;
    const reviewer = manifest.verify?.agent;
    // The review stage's coordinate (RUN-193) sits at the TOP of this ladder, above `[verify.agent]`
    // — a workflow whose point is a harder look ("audit") says so on the stage rather than by moving
    // the one setting every other workflow shares. Resolved HERE from the run + the pinned catalog,
    // not threaded in: runReviewer is reached by two entry paths (a finished run and one resumed in
    // another process, RUN-30) and only the first ever assembled a context to thread — the same
    // reason `reviewerContext` resolves at the point of use.
    const stageCoord = stageCoordinate(
      runWorkflow(ctx.run, ctx.repo.workflowCatalog ?? ctx.repo.manifest),
      'review',
      this.log,
    );
    // The reviewer as a coordinate (RUN-113): `[verify.agent].agent = "codex.gpt-5_6-sol.high"`
    // names tool+model+effort in one string and WINS over the legacy tool/model/effort fields — but
    // the stage coordinate above wins over both.
    const reviewerCoord = reviewer?.agent ? tryParseCoordinate(reviewer.agent) : null;
    // The `[verify.agent]` + `[defaults.verify]` answer — the pre-RUN-193 ladder, UNCHANGED: the
    // `.agent` coordinate over the legacy `.tool/.model/.effort` fields, and `[defaults.verify]`
    // severed only when `[verify.agent]` itself named a tool (a model id is not portable across
    // vendors). This is the fallback the stage coordinate then folds over.
    const verifyTool = reviewerCoord?.tool ?? reviewer?.tool ?? null;
    const verifyFallback = {
      tool: verifyTool ?? ctx.driver.tool,
      model:
        reviewerCoord?.model ??
        reviewer?.model ??
        (verifyTool ? null : (manifest.defaults?.verify?.model ?? null)),
      effort: reviewerCoord?.effort ?? reviewer?.effort ?? manifest.defaults?.verify?.effort ?? null,
    };
    // The review stage coordinate on TOP (RUN-193), through the SAME `foldStageCoordinate` every
    // other spawn uses — so a stage tool that differs from `[verify.agent]`'s severs its model too,
    // not only `[defaults.verify]`'s. The hand-rolled `?? reviewerCoord?.model` ladder leaked exactly
    // there: `[stages.review] agent = "codex"` inherited `[verify.agent]`'s claude model onto codex.
    const resolved = foldStageCoordinate(stageCoord, verifyFallback);
    // Whether a tool was NAMED at all (stage or `[verify.agent]`) — the run's own driver otherwise.
    const reviewerTool = stageCoord?.tool ?? verifyTool;
    // The reviewer's driver (RUN-70): the repo — or now the workflow's review stage (RUN-193) — may
    // put a different VENDOR's model in judgment, the strongest form of the reviewer's independence.
    // Fail-closed when the named tool has no driver here: silently reviewing with the builder's own
    // vendor would defeat the choice, the same reasoning that fails an absent `shell` pin (RUN-42).
    const driver = reviewerTool ? this.deps.drivers[reviewerTool as AgentTool] : ctx.driver;
    if (!driver) {
      return {
        verdict: 'unknown',
        passed: false,
        findings: `a '${reviewerTool}' reviewer was asked for (the workflow's review stage or [verify.agent]) but this runner has no such driver — install the tool on this machine or change the coordinate`,
      };
    }
    const model = resolved.model;
    const effort = resolved.effort;
    // The diff since the fork, for a git-shaped backend. checkpoint() has already committed the
    // work, so a bare `git diff` shows nothing — the range is the review. A live backend
    // (Perforce/Diversion) has no git to ask; the prompt points at the working tree instead.
    const diffCmd =
      (this.vcsFor(ctx.repo).kind ?? 'git') === 'git' ? `git diff ${ctx.worktree.baseId}...HEAD` : undefined;
    // The reviewer spends from the RUN's remaining ceiling, not a fresh copy of it (RUN-133). A
    // build with a reviewer and a conflict turn used to be handed the dispatched budget three times
    // over, and no single per-session check could ever notice.
    const reservation = ctx.tally.reserve();
    if (!reservation.ok) {
      // Adversarial default, same as a reviewer that crashed: a gate that could not run is not a
      // gate that passed. `review.ts` turns an `unknown` verdict into `review:no-verdict`, so the
      // run is gated with its diff kept — and no process was spawned to be killed a moment later.
      this.log.warn('no budget left for the reviewer — gating rather than reviewing unfunded', {
        runId: ctx.run.id,
        breach: reservation.breach,
      });
      return {
        verdict: 'unknown',
        passed: false,
        findings: `the reviewer could not run: ${reservation.detail}. The diff is kept on its branch; re-dispatch with a larger budget to have it judged.`,
      };
    }

    let text = '';
    // Resolved BEFORE the clock starts. The wall-clock dimension bounds AGENT time (RUN-30's
    // accounting), so charging a slow `[context]` probe to it would spend a run's duration ceiling
    // on work no agent did — and since RUN-133 that number is subtracted from what the next session
    // may spend and persisted into a continuation, so the error would compound rather than pass.
    const reviewerContext = await this.reviewerContext(ctx.repo, ctx.worktree);
    // Pure and synchronous (RUN-231) — nothing here touches disk or the clock, so it costs
    // nothing to compute freshly every round rather than threading a cached render.
    const memory = renderMemoryEvidence(ctx.verifiedContextPack ?? null, { audience: 'reviewer' }).text;
    const startedAt = monotonicMs();
    const session = this.startAgent(driver, {
      runId: `${ctx.run.id}:review`,
      kind: 'verify', // the reviewer IS a verify actor: executes but never edits
      cwd: ctx.worktree.localPath,
      prompt:
        assembleReviewerPrompt({
          intent: ctx.intent,
          diffCmd,
          // Split in two (RUN-177) because the two states are different facts and only one of them
          // was ever told. A landing run's deterministic command runs AFTER this review, against the
          // rebased result — telling the reviewer it "already passed" is false there, and it is
          // instructed not to re-run it, so it cannot find out.
          verifyPassed: ctx.verifyRan === false ? null : (cmdVerify(manifest.verify)?.cmd ?? null),
          verifyPending: ctx.verifyRan === false ? (cmdVerify(manifest.verify)?.cmd ?? null) : null,
          ledger: ctx.ledger,
          repoContext: reviewerContext,
          memory,
          ...(ctx.acceptance?.length
            ? { acceptance: ctx.acceptance, acceptanceOverflow: ctx.acceptanceOverflow ?? 0 }
            : {}),
          ...(ctx.requirements?.length ? { requirements: ctx.requirements } : {}),
        }) + (ctx.stageAnswer ?? ''),
      // CLAMPED, not raw (RUN-158). The line above says this actor executes but never edits, and
      // until now that was the only thing enforcing it here: `[permissions.verify] write = true` in
      // a committed manifest handed the reviewer Edit/Write over the very diff it is judging, which
      // it could then "fix" and PASS. RUN-118's floor was described as applying at every permission
      // site; this was the site it missed — and the one that matters most, because a dispatched
      // verify run is opt-in while the inline reviewer gates every build that configures one.
      permission: clampPermissionToWorkflow(manifest.permissions.verify, BUILTIN_WORKFLOWS.verify),
      // The ESCALATION PAIR only. The reviewer had NO noriqMcp for two reasons that both still
      // hold for everything except these two tools: one run holds one non-reissuable credential
      // (RUN-43), so a second inline identity cannot exist; and authorship separation means the
      // reviewer must not claim, move, or comment as anyone. `raise_alert` and `request_input`
      // move no work — the first notifies, the second PAUSES the run — so the separation
      // survives, and a reviewer that genuinely cannot judge without a human's answer ("is this
      // legacy surface load-bearing?") finally has a move that is not guessing a verdict. The
      // reviewer's output is still its report; the daemon still posts the findings itself.
      noriqMcp: ctx.noriqMcp,
      noriqTools: STAGE_NORIQ_TOOLS,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      budget: reservation.budget,
      // …and the live check, so a reviewer cannot outspend the RUN even inside its own allowance.
      spendGuard: ctx.tally.guard(`review:${ctx.round}`),
      clockGuard: ctx.tally.clockGuard(),
      handlers: {
        onText: (t) => {
          text += t;
          this.transcript(ctx.run.id).text('reviewer', t, ctx.round);
        },
        // The reviewer's LIVE ticks are deliberately NOT folded into the run frame (RUN-59). Its
        // mix is only known at its result, so folding a live tick (tokens, no mix) would strand a
        // climbing total next to a stale primary-only mix under the server's COALESCE. Its spend
        // joins the run at its result instead — see the tally.record below, reported as one jump.
      },
    });
    // Killable while it reviews, same as the conflict resolver — and unregistered after, for the
    // same leak (see resolveConflict).
    this.deps.steering?.register(ctx.run.id, session.session, session.stop);
    try {
      const exit = await session.done;
      // Record the reviewer's whole spend regardless of verdict (RUN-59): the tokens burned whether
      // it PASSed, FAILed, or crashed, and this may be a different vendor's model than the build.
      // A fresh session per round → its exit is that round's own cumulative, so a per-round slot
      // sums rather than overwrites. Then publish the run total, mix and all, as one step.
      ctx.tally.record(`review:${ctx.round}`, exit.telemetry);
      // …and its wall-clock too (RUN-133), so the next session's reservation is short by what this
      // one took. Sessions are strictly sequential here, so these sum rather than overlap.
      ctx.tally.chargeTime((monotonicMs() - startedAt) / 1000);
      this.deps.report(ctx.run.id, { status: 'running', telemetry: ctx.tally.total() });
      if (exit.outcome !== 'done') {
        // Adversarial default: a reviewer that crashed or breached its ceiling cleared nothing.
        // Its PARTIAL evidence is still read (RUN-145) — a reviewer killed at criterion 4 already
        // established something about criteria 1–3, and discarding that would throw away the only
        // work the spend bought. The verdict stays `unknown` regardless: `judgeWithAcceptance`
        // demotes a PASS and never promotes anything, so this cannot turn a dead session into a
        // judgement about the diff.
        return {
          ...judgeWithAcceptance(text, ctx.acceptance ?? []),
          verdict: 'unknown',
          passed: false,
          findings: text.trim() || `the reviewer exited ${exit.reason ?? 'without a report'}`,
        };
      }
      // The reviewer may have PAUSED the run on a human (RUN-190). Probed before the verdict is
      // read, because a report written around an open question is not a judgment — the paused
      // round re-runs FRESH with the Q&A appended, and this round's text is discarded (its own
      // prompt says so). Uncapped, deliberately: each re-ask costs a human an answer, which is
      // the real rate limiter — a cap would read a verdict off a report that stopped to ask.
      if (ctx.runAgent) {
        const answered = await this.parkStage({
          run: ctx.run,
          worktree: ctx.worktree,
          runAgent: ctx.runAgent,
          tally: ctx.tally,
          stage: 'review',
          tail: text.slice(-400),
        });
        if (answered) {
          this.deps.steering?.unregister(ctx.run.id);
          return this.runReviewer({
            ...ctx,
            asks: (ctx.asks ?? 0) + 1,
            stageAnswer: `${ctx.stageAnswer ?? ''}${renderPrompt('stage-answer', answered)}`,
          });
        }
      }
      // Verdict AND per-criterion evidence, reconciled together (RUN-145) — a PASS the report's
      // own acceptance lines contradict is taken as the FAIL it contains.
      const judged = judgeWithAcceptance(text, ctx.acceptance ?? []);
      // The structural-escalation token (RUN-175), read only off a clean exit: a crashed reviewer's
      // half-written token must not end a run the gate never finished judging (the branch above
      // already forces `unknown`). `readEscalation` gates on the report's OWN verdict line, so a
      // PASS judgeWithAcceptance demoted cannot smuggle an escalation in — the reviewer that signed
      // PASS did not judge the run unconvergeable, whatever else its report contradicts. A demotion
      // is logged rather than silent, so "the daemon ignored it" is legible and distinct from "the
      // daemon never saw it"; the run then proceeds as the ordinary FAIL the report already is.
      const escalated = readEscalation(text);
      if (escalated.demoted) {
        this.log.info('reviewer escalation token demoted — the run proceeds as an ordinary FAIL', {
          runId: ctx.run.id,
          round: ctx.round,
          why: escalated.demoted,
        });
      }
      return escalated.escalation ? { ...judged, escalation: escalated.escalation } : judged;
    } finally {
      this.deps.steering?.unregister(ctx.run.id);
    }
  }

  /**
   * The mechanical half of adjudicating a spin-off contest (RUN-188), shared by BOTH fold sites —
   * the fix rounds and the terminal contest — so the two cannot drift on what "checked" means.
   *
   * A CONTESTED pointer may name a task (`task:<ref>`): "real, out of scope, tracked THERE". The
   * judging reviewer holds no Noriq credential and gets none for this (RUN-43), so the daemon
   * looks each named task up and attaches what it saw to the response, which the fold then
   * carries as ledger data — the fresh reviewer judges substance over facts instead of a prose
   * promise. The order of harms is may-miss-never-invent: a lookup that failed, answered
   * malformed, found nothing, or was declined (the per-turn bound) yields `verified: false` — a
   * fact that can only make the contest harder to credit — and never a crash or a gate of its
   * own, the checkClaimable probe posture. No lookup wired → responses pass through untouched and
   * a task pointer stays the free text it always was, which is every daemon before RUN-188.
   */
  private async verifyTaskPointers(runId: string, responses: FindingResponse[]): Promise<FindingResponse[]> {
    const lookup = this.deps.resolveSpinOff;
    if (!lookup) return responses;
    const clip = (s: string, n: number) => {
      const t = s.trim();
      return t.length > n ? `${t.slice(0, n - 1)}…` : t;
    };
    // A stall is a non-answer: race each lookup against a deadline, resolving null either way a
    // real answer never arrives. The timer is unref'd (the budget.ts rule — a forgotten deadline
    // must never be what holds the daemon open) and guarded, since a fake clock need not have it.
    const timeoutMs = this.deps.spinOffTimeoutMs ?? TASK_LOOKUP_TIMEOUT_MS;
    const timedLookup = (ref: string): Promise<SpinOffLookup | null> =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        lookup(ref).then(
          (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          () => {
            clearTimeout(timer);
            resolve(null);
          },
        );
      });
    const facts = new Map<string, SpinOffCheck>();
    let looked = 0;
    const check = async (ref: string): Promise<SpinOffCheck> => {
      const held = facts.get(ref);
      if (held) return held;
      let fact: SpinOffCheck;
      if (looked >= MAX_TASK_LOOKUPS_PER_TURN) {
        fact = {
          ref,
          verified: false,
          detail: 'not checked — this turn named more task pointers than the daemon will look up',
        };
      } else {
        looked += 1;
        const raw = await timedLookup(ref);
        // The seam's answer is DATA, not a contract: resolveSpinOff is injectable and the server
        // behind it is not this daemon's, so a shape this code did not write — a numeric title, a
        // missing key — is the same non-answer a failed lookup is. Validated field by field
        // BEFORE anything touches it, because a throw here would abort the adjudication path a
        // finding was meant to merely stand on (may-miss-never-invent, and never a crash).
        const t = raw && typeof raw.key === 'string' && typeof raw.title === 'string' ? raw : null;
        if (!t) {
          fact = {
            ref,
            verified: false,
            detail: 'no such task reachable from this runner — treat the pointer as pointing at nothing',
          };
        } else {
          // The provenance line is the mechanical fact the reviewer's substance judgment starts
          // from: filed from THIS run against a finding, filed elsewhere, or carrying none (a task
          // a human filed by hand — still a legitimate target, and the reviewer is told which).
          // Field-typed like the answer itself: provenance only ever SHARPENS the existence fact,
          // so a malformed field degrades to the unsharpened line, never to a throw.
          const prov = t.spinOff && typeof t.spinOff === 'object' ? t.spinOff : null;
          const sourceRun = typeof prov?.sourceRunId === 'string' ? prov.sourceRunId : null;
          const from = !prov
            ? 'carries no spin-off provenance — it may predate this run'
            : sourceRun === runId
              ? 'filed from THIS run'
              : sourceRun
                ? `filed from run ${sourceRun}`
                : 'its provenance names no source run';
          const against =
            typeof prov?.finding === 'string' && prov.finding
              ? `, against: "${clip(prov.finding, 120)}"`
              : '';
          fact = {
            ref,
            verified: true,
            detail: `exists — ${t.key}: ${clip(t.title, 100)} (${from}${against})`,
          };
        }
      }
      facts.set(ref, fact);
      return fact;
    };
    const out: FindingResponse[] = [];
    for (const r of responses) {
      // Only a CONTESTED pointer is evidence a task can back — a FIXED points at a change, and
      // checking tasks it happens to mention would attach facts to a claim nobody made. The scan
      // is the parser's, taken off the RAW line (FindingResponse.taskScan): `r.pointer` is the
      // capped DISPLAY, and scanning it let a claim padded past the cap fall off the check — a
      // verified first task crediting a never-checked later one. The fallback serves only a
      // hand-built response that skipped the parser; on parser output an absent scan MEANS the
      // raw pointer named nothing, and a capped substring of it cannot name more.
      const scan =
        r.status === 'contested' ? (r.taskScan ?? taskRefsIn(r.pointer)) : { refs: [], unreadable: 0 };
      if (!scan.refs.length && !scan.unreadable) {
        out.push(r);
        continue;
      }
      const spinOffs: SpinOffCheck[] = [];
      for (const ref of scan.refs.slice(0, MAX_TASK_POINTERS)) spinOffs.push(await check(ref));
      // Every task claim the loop above did NOT check is priced as ONE unverified fact, never
      // dropped: refs past the per-answer cap (three verified tasks must not speak for a fourth
      // nobody looked at) and claims no reference could be read from (a mangled claim degrades
      // toward unverifiable, not toward "no task named"). Unverified is what blocks crediting.
      const over = Math.max(0, scan.refs.length - MAX_TASK_POINTERS);
      if (over > 0 || scan.unreadable > 0) {
        const parts: string[] = [];
        if (over > 0)
          parts.push(`${over} more task pointer(s) than the ${MAX_TASK_POINTERS} one answer may name`);
        if (scan.unreadable > 0)
          parts.push(`${scan.unreadable} task claim(s) with no readable reference (write task:<key>)`);
        spinOffs.push({
          ref: '(unchecked)',
          verified: false,
          detail: `not checked — ${parts.join('; ')}`,
        });
      }
      out.push({ ...r, spinOffs });
    }
    if (facts.size) {
      this.log.info('checked the task pointers the builder contested with', {
        runId,
        refs: [...facts.keys()],
        verified: [...facts.values()].filter((f) => f.verified).length,
      });
    }
    return out;
  }

  /**
   * The RUN-174 contest turn: one adjudication turn after a TERMINAL-round FAIL, before the run
   * reports. Returns the FINAL result iff the contest RAN — a PASS only when every terminal finding
   * drew a checkable CONTESTED response AND a fresh reviewer verified those pointers hold; otherwise
   * the terminal FAIL (its ledger now carrying whatever the builder said). Returns `null` when the
   * contest DECLINED — nothing left to fund it (RUN-133) — so the caller reports the terminal FAIL
   * exactly as it does today.
   *
   * The clearing decision is the daemon's, in one place (criterion 3/4): a fresh re-review is not a
   * free reroll of the verdict. A finding stands unless the builder CONTESTED it with a pointer the
   * adjudicator can SEE, so silence, a `FIXED`, an empty pointer, a response for another id, a
   * finding a ledger cap dropped, a sub-claim left unanswered while its siblings drew the
   * rebuttal (RUN-180), or a task pointer the daemon could not verify (RUN-188) cannot clear it —
   * the run then fails without even spawning the reviewer. Only a full set of visible, checkable contests earns the look; and even then a PASS
   * clears the run only if the reviewer re-raised none of the findings, so its word alone is never
   * enough.
   *
   * No checkpoint after the builder turn, deliberately — the "may NOT change code" rule. `runReviewer`
   * inspects `git diff baseId...HEAD`, a committed range, so an un-checkpointed edit is invisible to
   * it: the fresh reviewer reads the SAME diff the terminal round judged, plus the new ledger
   * evidence. That is what keeps this a judgment over unchanged code rather than a disguised fix
   * round, and it holds whatever the builder's live permission profile allows.
   *
   * One look only. This is not a contest/fix loop — the fresh reviewer's verdict is final, so a
   * builder self-assertion that no reviewer re-checks cannot clear a finding, and a surviving finding
   * does not earn another turn.
   */
  private async contestTerminalFindings(
    ctx: {
      run: Run;
      repo: ResolvedRepo;
      worktree: Workspace;
      driver: AgentDriver;
      /** The live build session — the contest turn runs here (a continuation, not a new spawn). */
      session: DriverSession;
      intent: string;
      tally: RunTally;
      getSessionText?: () => string;
      budget?: RunBudget;
      acceptance?: AcceptanceItem[];
      acceptanceOverflow?: number;
      requirements?: string[];
      verifyRan?: boolean;
    },
    args: {
      /** The terminal verdict — the report a survive reports, so the human sees the findings just
       *  contested rather than a fresh reviewer's paraphrase of them. */
      verdict: VerifyVerdict;
      findings: Finding[];
      /** Where the terminal findings already sit in the ledger (recorded when raised), so the
       *  builder's responses fold onto the SAME entries. */
      terminalRound: number;
      /** Fix rounds spent (maxRounds) — the `rounds` the caller would have reported. */
      rounds: number;
      ledger: LedgerEntry[];
      /** Reviewer invocations before this turn (RUN-225) — `stand` reports it unchanged (no
       *  `runReviewer` call on that path); the re-adjudication path below reports `looks + 1`. */
      looks: number;
    },
  ): Promise<(VerifyVerdict & { rounds: number; ledger: LedgerEntry[]; looks: number }) | null> {
    const transcript = this.transcript(ctx.run.id);
    const stand = (ledger: LedgerEntry[]) => ({
      ...args.verdict,
      rounds: args.rounds,
      ledger,
      looks: args.looks,
    });

    // Reserve FIRST, before the builder turn: the terminal turn is the run's most likely to find the
    // ceiling already gone (RUN-133, same as resolveConflict). Declining spends nothing where
    // spawning-to-kill would spend a process — and `null` tells the caller to report the terminal
    // FAIL untouched.
    const reservation = ctx.tally.reserve();
    if (!reservation.ok) {
      this.log.warn('no budget left for the terminal contest turn — reporting the FAIL as it stands', {
        runId: ctx.run.id,
        breach: reservation.breach,
      });
      return null;
    }
    if (!ctx.session.continueWith) return null;

    this.log.info('handing the terminal findings to the builder for one contest turn (no code change)', {
      runId: ctx.run.id,
      findings: args.findings.length,
    });
    transcript.milestone(
      'the terminal review FAILed — one contest turn (no code change) before the run reports',
    );
    // A turn burns tokens — the phase must say so (RUN-31), same as the fix loop.
    this.deps.report(ctx.run.id, { status: 'running', phase: 'agent' });

    // The delta after the turn is exactly the contest's text, from which the structured RESPONSE
    // block is parsed (RUN-79) — snapshotted before the turn as the fix loop does.
    const textBefore = ctx.getSessionText?.().length ?? 0;
    const startedAt = monotonicMs();
    // The contest prompt carries the RECORD — each terminal finding's sub-claims as the reconciled
    // ledger holds them, lettered by position (RUN-180). Letters are not state anywhere (the
    // structural settlement), so a standing sub-claim this terminal report does not re-list has no
    // letter the builder could otherwise know: the record is what makes it answerable, and its
    // positional letters are exactly the coordinates `applyContestResponses` resolves a response
    // against below — one labelling, shown and folded alike.
    const exit = await ctx.session
      .continueWith(
        reviewerContestPrompt(
          args.verdict.findings,
          renderContestRecord(args.findings, args.ledger, args.terminalRound),
        ),
      )
      .catch((err): DriverExit | null => {
        this.log.warn('could not hand the terminal findings back for a contest', {
          runId: ctx.run.id,
          err: String(err),
        });
        return null;
      })
      .finally(() => ctx.tally.chargeTime((monotonicMs() - startedAt) / 1000));

    // The response↔terminal-finding join, computed ONCE here — before the ledger fold, the exit
    // branch, and the eligibility gate below all read it (RUN-179 criterion 4). A response is
    // EVIDENCE only when it points at something AND names an id THIS terminal round raised: a
    // pointerless self-assertion is persuasion the next reviewer cannot check, and a `FINDING 99`
    // naming no terminal finding is context from nowhere. Folding this ONE `matched` set — not the
    // raw responses — is what keeps the ledger the verifiable-pointer record RUN-79 designed, and
    // stops the join being re-derived, divergently, at each site. Task pointers in the matched set
    // are then checked by the daemon (RUN-188, the fix rounds' own path) so what folds below is
    // the response PLUS the fact — and an unverified pointer folds as exactly that, visible to a
    // human and a continuation even when the gate underneath declines the contest.
    const contestText = ctx.getSessionText?.().slice(textBefore) ?? '';
    const responses = parseFindingResponses(contestText);
    const terminalIds = new Set(args.findings.map((f) => f.id));
    const matched = await this.verifyTaskPointers(
      ctx.run.id,
      responses.filter((r) => r.pointer.trim().length > 0 && terminalIds.has(r.id)),
    );

    // Land that matched evidence on the ledger FIRST — before any outcome branch — so a rebuttal
    // the builder streamed survives even a turn that then ended badly, and a continuation's fresh
    // reviewer sees it as a prior adjudication (RUN-174 criterion 7). Every terminal finding's
    // entry was already written when the finding was RAISED (`record`), so this turn only ADDS
    // answers — `applyContestResponses` resolves each letter against the reconciled entry's
    // positions, exactly the labelling the contest record above showed the builder (RUN-180): the
    // report's own lettering and the record's agree except on the overflow path, where the
    // record — the only letters the builder could answer standing claims by — must win, and
    // re-running the fold's union here resolved report-first and discarded those answers. A
    // finding with no matched response keeps its raise-time entry, 'unanswered'. NO checkpoint
    // above, so the diff a fresh reviewer would read is still the one the terminal round judged.
    const answered = applyContestResponses(args.ledger, args.findings, matched, args.terminalRound);

    // The builder died, errored, or breached its ceiling on the contest turn. The terminal verdict
    // stands — pushing a re-review at a session that just failed is the loop-becomes-spend mistake
    // the fix loop already avoids — but with the ledger now carrying whatever it said.
    if (!exit || exit.outcome !== 'done') {
      if (exit?.reason)
        this.log.info('the contest turn ended early', { runId: ctx.run.id, reason: exit.reason });
      return stand(answered);
    }

    // ── the canonical reconciliation (RUN-174) ────────────────────────────────────────────────
    // ONE place decides whether the contest cleared the run, so no exit can clear a finding another
    // would have kept. Of the `matched` evidence above, a terminal finding is a CANDIDATE to clear
    // only when the builder CONTESTED it (a `FIXED` changed nothing here) AND that contest is VISIBLE
    // to the adjudicator — its entry survived the ledger cap into what the fresh reviewer is handed.
    // Silence, a `FIXED`, or a finding a cap dropped is not a candidate, so it still stands; an empty
    // pointer or a response for another id never reached `matched` at all. What "checkable" means
    // beyond non-empty — does the pointer actually HOLD — is the fresh reviewer's to judge, below.
    //
    // A finding that carries sub-claims is a candidate only when EVERY reconciled sub-claim reads
    // CONTESTED (RUN-180). This is the exact surface the run_ms4t62384u0z6c6p4f5d escape used: a
    // bundled finding was "contested" by rebutting the refutable half, and the other half rode the
    // answer out. A bare `FINDING <n>` response is recorded as evidence but credits no lettered
    // claim, so answering in halves leaves the unanswered half STANDING — and the finding off the
    // candidate set.
    // A contest standing on task pointers none of which the daemon could verify is a pointer at
    // nothing (RUN-188): it folds into the ledger above — the evidence and its failure are both
    // recorded — but it is no candidate to clear, exactly like an empty pointer. spinOffsHold is
    // deliberately vacuous over absent facts, so a response naming no task, a pre-RUN-188
    // response, and a daemon with no lookup wired all clear (or stand) exactly as they did before.
    const contestedWhole = new Set(
      matched
        .filter((r) => r.status === 'contested' && !r.subclaim && spinOffsHold(r.spinOffs))
        .map((r) => r.id),
    );
    // Candidacy is judged on the RECONCILED entry the fold above just wrote, never on this round's
    // parse alone — in EITHER direction. The fold deliberately PRESERVES held sub-claims when a
    // re-raise drops the letters — or repeats only SOME of them, unioning in the claims its
    // wording does not cover — a fresh terminal reviewer paraphrases by construction, so a
    // letterless or narrowed re-raise of a half-answered finding still carries its unanswered
    // claim, and reading `f.subclaims` (empty or a subset on those paths) let a bare or partial
    // contest clear exactly the claim this format exists to keep standing: the RUN-174 escape
    // reborn one round later. And symmetrically: the terminal report's own SHAPE must not be a
    // second gate over a record already fully contested — the contest prompt tells the builder an
    // already-contested record claim needs no fresh answer, so demanding one per-letter (or a bare
    // response beside fully contested letters) would fail the exact builder that followed the
    // prompt. The per-letter responses reach this check through `applyContestResponses`, which
    // resolved each letter against the reconciled entry's own positions — the record's labelling,
    // the one the builder was answering by. The entry is also the VISIBILITY check: the
    // adjudicator judges what the ledger shows it, so a finding whose entry did not survive the
    // fold (the cap) is not evidence and stands.
    //
    // This is also why the overflow-vs-candidacy bug (RUN-189) was a fold bug, not a candidacy
    // bug: `e` here is whatever `buildLedger` wrote for THIS finding at THIS round, so candidacy
    // can only ever require what the entry holds. An overflow that kept the held set whole and
    // dropped the terminal round's own enumeration made `subs` here the OLD claims, not the ones
    // the terminal reviewer actually raised — a contest of stale claims then read as answering a
    // finding nobody had re-examined. `buildLedger`'s overflow branch now never drops this round's
    // own raised claims for the cap (oldest-held goes first instead), so `subs` here is guaranteed
    // to contain every current terminal sub-claim; this site needed no change beyond that guarantee.
    const answerablyContested = (f: Finding) => {
      const e = reconciledEntry(answered, f, args.terminalRound);
      if (!e) return false;
      const subs = subclaimsOf(e);
      // Every reconciled sub-claim must read CONTESTED. A carried rebuttal counts — carrying an
      // answer whose claim wording matched is the fold's whole point — while an unanswered or
      // FIXED claim stands, whichever round enumerated it. FIXED blocking candidacy is not an
      // oversight but the whole-finding rule ("a `FIXED` changed nothing here") at sub-claim
      // grain: the terminal reviewer judged the diff WITH any earlier fix in it and still failed,
      // so "it is fixed" was already adjudicated and never buys the re-roll. A builder who
      // believes a FIXED sub-claim no longer holds has this turn's move: CONTEST it, at the letter
      // the contest record shows for it, with the pointer at the landed change — the fold resolves
      // that letter back to the claim — and the fresh look then verifies it like any other contest.
      // A carried contest whose task pointer did not verify blocks candidacy too (RUN-188): the
      // contest record showed the builder that letter as needing a fresh answer (renderContestRecord
      // marks it), so demanding one here is the FIXED rule again, not a second gate over a record
      // the prompt called settled.
      if (subs.length) return subs.every((s) => s.status === 'contested' && spinOffsHold(s.spinOffs));
      // A single-claim finding keeps the pre-RUN-180 rule unchanged: the builder must have
      // contested it THIS turn — silence over a terminal finding is not a contest, however the
      // entry's carried status reads, because the terminal reviewer raised it over that record.
      return contestedWhole.has(f.id);
    };
    if (!args.findings.every((f) => answerablyContested(f))) {
      // At least one terminal finding was not answerably contested, so it stands and the run fails as
      // it does today — WITHOUT spawning a reviewer whose fresh PASS could clear it (criterion 4).
      // Nothing is spawned to be killed; the contest turn already happened above.
      this.log.info('a terminal finding was not answerably contested — the findings stand', {
        runId: ctx.run.id,
        contested: contestedWhole.size,
        subclaimResponses: matched.filter((r) => r.subclaim).length,
        findings: args.findings.length,
      });
      transcript.milestone('the terminal findings were not all contested — the run fails');
      return stand(answered);
    }

    // Every terminal finding has a checkable contest the adjudicator can see: ONE fresh reviewer
    // verifies the pointers over the SAME diff plus the ledger. One look only — not a contest/fix loop.
    const readjudged = await this.runReviewer({ ...ctx, round: args.rounds + 2, ledger: answered });
    transcript.milestone(reviewVerdictMilestone(readjudged, args.rounds + 2));
    const settled = buildLedger(answered, parseFindings(readjudged.findings), [], args.rounds + 2);

    // RUN-175: the contest's fresh look is a reviewer round like any other, and the token is a
    // per-round judgement honoured when raised — so an HONOURED escalation from this adjudicator
    // must ride out rather than be replaced by the pre-contest verdict below, which would report
    // the one run a reviewer proved unconvergeable as a plain rejection with the diagnosis written
    // and unread. Its OWN report is what survives (not the terminal round's): the escalation's
    // finding number points into that report, and the terminal findings it did not clear are in
    // the ledger it carries. An escalation only ever rides a FAIL, so this cannot shadow the
    // contest-cleared PASS branch beneath it.
    if (readjudged.escalation) {
      this.log.info(
        'the contest’s fresh reviewer escalated STRUCTURAL — the run fails with the cause named',
        {
          runId: ctx.run.id,
        },
      );
      transcript.milestone('the contest’s fresh look escalated STRUCTURAL — the run fails');
      return { ...readjudged, rounds: args.rounds, ledger: settled, looks: args.looks + 1 };
    }

    // The PASS is DAEMON-decided, not taken on the reviewer's word: it clears the run only if the
    // fresh reviewer PASSed AND re-raised none of the terminal findings. A pointer it rejected it
    // re-raises (criterion 4), and a malformed report that lists a finding then signs PASS has not
    // cleared it — either way the finding stands, the same posture judgeWithAcceptance takes for a
    // FAILED criterion under a PASS.
    const loc = (s: string) => s.trim().toLowerCase();
    const reraised = new Set(
      parseFindings(readjudged.findings)
        .map((f) => loc(f.location))
        .filter(Boolean),
    );
    const stillStanding = args.findings.filter((f) => reraised.has(loc(f.location)));
    if (readjudged.passed && stillStanding.length === 0) {
      this.log.info('the contest cleared every terminal finding — the fresh reviewer PASSed', {
        runId: ctx.run.id,
      });
      transcript.milestone('the contest cleared the terminal findings — the run passes');
      return { ...readjudged, rounds: args.rounds, ledger: settled, looks: args.looks + 1 };
    }
    // The findings stand: the run fails as it does today (the terminal report), but the ledger now
    // carries the builder's pointers and the fresh look — so a human, and a continuation, sees the
    // contest happened. A re-raise under a PASS lands here too (the daemon takes the FAIL), as does
    // an `unknown` re-adjudication (crashed / no budget) — a gate that could not run cleared nothing.
    this.log.info('the terminal findings stand after the contest — the run fails', {
      runId: ctx.run.id,
      overrodePass: readjudged.passed && stillStanding.length > 0,
    });
    transcript.milestone('the terminal findings stand after the contest — the run fails');
    return stand(settled);
  }

  /** Give the build agent one bounded turn to resolve its own conflict, in place. */
  private async resolveConflict(
    ctx: {
      run: Run;
      repo: ResolvedRepo;
      worktree: Workspace;
      policy: LandPolicy;
      task: AnchorTask | null;
      driver: AgentDriver;
      permission: PermissionProfile;
      noriqMcp?: NoriqMcp;
      budget?: RunBudget;
      /** The run's cross-session tally (RUN-59): the conflict turn's spend records into it. */
      tally: RunTally;
    },
    conflicts: string[],
  ): Promise<{ resolved: boolean; text: string }> {
    // The last session a run spawns, and the one most likely to find the ceiling already gone
    // (RUN-133). Unresolved is the honest answer: the caller aborts the rebase and the diff waits on
    // its branch for a human — which is exactly what an unfixable conflict does anyway.
    const reservation = ctx.tally.reserve();
    if (!reservation.ok) {
      this.log.warn('no budget left for the conflict turn — leaving the rebase unresolved', {
        runId: ctx.run.id,
        breach: reservation.breach,
      });
      return { resolved: false, text: `no budget left to attempt a resolution: ${reservation.detail}` };
    }

    let text = '';
    const startedAt = monotonicMs();
    const session = this.startAgent(ctx.driver, {
      runId: `${ctx.run.id}:conflict`,
      kind: 'build', // it is editing its own diff — the build floor, nothing wider
      cwd: ctx.worktree.localPath,
      prompt: assembleConflictPrompt({
        conflicts,
        landBranch: ctx.policy.branch,
        task: ctx.task,
        verifyCmd: ctx.repo.manifest.verify?.cmd ?? null,
      }),
      permission: ctx.permission,
      noriqMcp: ctx.noriqMcp,
      budget: reservation.budget,
      spendGuard: ctx.tally.guard('conflict'),
      clockGuard: ctx.tally.clockGuard(),
      handlers: {
        onText: (t) => {
          text += t;
        },
        // Like the reviewer (RUN-59): live ticks are not folded (mix unknown until the result), so
        // the run frame never shows a total climbing past a stale mix. The conflict turn's whole
        // spend joins the run at its result — recorded below and reported as one step.
      },
    });
    // Still killable while it works — and unregistered when it stops. supervise()'s own
    // `finally` already ran for this runId before landing began, so nothing else will
    // clean this up: without the finally below, SteeringBridge would hold a dead session
    // forever (hasRun() answering true, a later cancel interrupting an exited process),
    // leaking one entry per conflicted landing for the daemon's whole life.
    this.deps.steering?.register(ctx.run.id, session.session, session.stop);
    try {
      const exit = await session.done;
      // The conflict turn's spend joins the run whether or not it resolved anything (RUN-59) — the
      // tokens burned either way, on the build's own model (kind:'build', ctx.driver).
      ctx.tally.record('conflict', exit.telemetry);
      ctx.tally.chargeTime((monotonicMs() - startedAt) / 1000);
      this.deps.report(ctx.run.id, { status: 'running', telemetry: ctx.tally.total() });
      if (exit.outcome !== 'done') {
        return { resolved: false, text: text || `agent exited ${exit.reason ?? 'badly'}` };
      }
      return { resolved: parseResolution(text), text };
    } finally {
      this.deps.steering?.unregister(ctx.run.id);
    }
  }

  /** The anchor task's text, best-effort: a lookup failure degrades to the bare id (the prompt
   *  renders it) rather than sinking the run. */
  private async resolveAnchorTask(taskId: string): Promise<AnchorTask | null> {
    if (!this.deps.resolveTask) return null;
    return this.deps.resolveTask(taskId).catch((err) => {
      this.log.warn('anchor task lookup failed — prompting with the bare id', {
        taskId,
        err: String(err),
      });
      return null;
    });
  }

  /**
   * Park a run whose agent stopped to ask a human something (RUN-30) — or don't, and let the
   * caller finalize it. Returns the exit to report iff the run parked.
   *
   * The check is a server read, not a pushed frame, and that is the whole trick: `raiseSignal`
   * commits `status='blocked'` before the `request_input` MCP call returns to the agent, so by
   * the time the agent's turn can possibly end, the row already says so. A frame racing that same
   * instant would sometimes lose — and losing means finalizing the run and reaping the worktree,
   * which is the exact failure this task exists to fix, except intermittent.
   */
  /**
   * Stage parks (RUN-190): the actors that run INSIDE a live `supervise` stack — planner, plan
   * checker, pattern mapper, inline reviewer — wait here for the human's answer, in process.
   * Keyed by run id; `resume` delivers into it. One waiter per run, which is an invariant rather
   * than a limitation: one run executes one stage at a time.
   */
  private readonly stageWaiters = new Map<string, (answer: string) => void>();

  /**
   * Did a STAGE ACTOR park this run on a human (RUN-190)? Probe, and if so: persist the park,
   * report blocked, and WAIT — in process, the stage's own stack held open — until the answer
   * arrives over ws. Returns the answer to re-run the stage with, or null when the run is not
   * parked (the normal case: the stage simply produced what it produced).
   *
   * The wait is bounded by the park TTL, not by a timer here: a daemon restart is the only thing
   * that abandons it, and the persisted record is what makes THAT case legible (see ParkedRun.stage).
   * The workspace stays leased and the tally keeps its figures — a wait costs no tokens and the
   * wall-clock ceiling measures sessions, not silence.
   */
  private async parkStage(ctx: {
    run: Run;
    worktree: Workspace;
    runAgent: { agentId: string; label: string; token: string };
    tally: RunTally;
    stage: 'plan' | 'plan-check' | 'pattern-map' | 'review';
    /** The stage's trailing output — usually the question, which is what the dashboard shows. */
    tail: string;
  }): Promise<{ question: string; answer: string } | null> {
    const { run } = ctx;
    if (!this.deps.parked || !this.deps.getParkState) return null;
    const state = await this.deps.getParkState(run.id).catch(() => null);
    if (!state?.blocked) return null;

    // The waiter is installed BEFORE the park is persisted or reported: the answer can arrive the
    // instant the server learns of the question, and a waiter installed after the report races it.
    // The poll is what lets the wait end WITHOUT an answer — a cancelled run, or a park the TTL
    // reaper removed, must release this stack rather than hold it forever; each fires `null`,
    // and the stage proceeds as unanswered into the boundaries that handle each case.
    let poll: ReturnType<typeof setInterval> | undefined;
    const answerP = new Promise<string | null>((resolveAnswer) => {
      this.stageWaiters.set(run.id, (a: string) => {
        if (poll) clearInterval(poll);
        resolveAnswer(a);
      });
      poll = setInterval(() => {
        void (async () => {
          const cancelled = this.deps.steering?.isCancelled?.(run.id) ?? false;
          // A probe error reads as "still parked" — abandoning a wait on a flaky disk read would
          // drop a question a human is still typing the answer to.
          const entry = cancelled ? null : await this.deps.parked?.get(run.id).catch(() => ({}) as ParkedRun);
          if (!cancelled && entry) return;
          if (poll) clearInterval(poll);
          if (this.stageWaiters.delete(run.id)) resolveAnswer(null);
        })();
      }, 15_000);
    });

    const runSpend = ctx.tally.total();
    await this.deps.parked.park({
      run,
      sessionId: null, // an in-process wait has no session to restore — `stage` is the record
      stage: ctx.stage,
      agentId: ctx.runAgent.agentId,
      agentLabel: ctx.runAgent.label,
      mcpToken: ctx.runAgent.token,
      workspace: ctx.worktree,
      spent: {
        tokens: totalTokens(runSpend),
        usd: runSpend.costUsd,
        ...(runSpend.modelUsage ? { modelUsage: runSpend.modelUsage } : {}),
      },
      activeSeconds: 0,
      parkedAt: new Date().toISOString(),
      question: state.question,
    });
    this.deps.report(run.id, {
      status: 'blocked',
      telemetry: runSpend,
      logTail: ctx.tail || (state.question ?? ''),
    });
    this.transcript(run.id).milestone(
      `the ${ctx.stage} stage asked a human and the run is paused: ${state.question?.slice(0, 200) ?? '(question unavailable)'}`,
    );
    this.log.info('stage parked on a human — holding the stage until the answer arrives', {
      runId: run.id,
      stage: ctx.stage,
      question: state.question?.slice(0, 80) ?? null,
    });

    const answer = await answerP;
    this.stageWaiters.delete(run.id);
    if (poll) clearInterval(poll);
    if (answer === null) {
      // Cancelled, or the park aged out from under us — the stage proceeds unanswered into the
      // boundary that handles whichever it was (the cancel check, or the run's own failure path).
      this.log.info('a stage wait ended without an answer', { runId: run.id, stage: ctx.stage });
      return null;
    }
    this.deps.report(run.id, { status: 'running', phase: 'agent' });
    this.transcript(run.id).milestone('the human answered — the stage re-runs with the answer');
    // The question is captured HERE, from the probe that saw it — after the answer lands, the
    // server's park state is resolved and the question is no longer readable.
    return { question: state.question ?? '(question unavailable)', answer };
  }

  private async parkIfBlocked(ctx: {
    run: Run;
    repo: ResolvedRepo;
    worktree: Workspace;
    exit: DriverExit;
    session: DriverSession;
    /** The driver this session ran on — its `resumableSession` capability decides session-restore
     *  vs continuation park (RUN-199), read as a capability rather than by the driver's name. */
    driver: AgentDriver;
    runAgent: RunAgent;
    activeSeconds: number;
    /** The run's spend tallied across every session so far (RUN-59) — what the park persists so a
     *  resume can keep summing, and what the blocked report carries. */
    tally: RunTally;
    /** The run's trailing output, so the park report carries the last thing it said — usually
     *  the question itself, which is what a human opening the dashboard wants to read. */
    tail: string;
    /** Which step of a decomposed run was speaking (RUN-168). */
    stepId?: string;
    /** What the steps before it concluded (RUN-171). */
    priorSteps?: StepSummary[];
  }): Promise<DriverExit | null> {
    const { run, exit } = ctx;
    if (!this.deps.parked || !this.deps.getParkState) return null;
    // A budget breach or a crash is terminal even if a question is open: resuming a run that was
    // killed for overspending would hand it a fresh ceiling, which is the loophole in reverse. It
    // still may hold an open question — `settle` abandons that (RUN-199), the ONE terminal boundary
    // every declining path here flows through, so no branch needs to abandon on its own.
    if (exit.outcome !== 'done') return null;

    const state = await this.deps.getParkState(run.id).catch((err) => {
      // Can't tell → finalize, the pre-RUN-30 behaviour. Parking on a guess would strand a
      // finished run as blocked forever, waiting for an answer to a question nobody asked.
      this.log.warn('could not check whether the run parked — treating it as finished', {
        runId: run.id,
        err: String(err),
      });
      return null;
    });
    if (!state?.blocked) return null;

    // A driver with a resumable session (claude) parks its real id and resumes IN it; one without
    // (codex, RUN-199) parks with `sessionId: null` and resumes CONTINUATION-style — its work
    // survives on disk in the kept worktree, so a fresh session reads it. The distinction is the
    // capability, never the driver's name: the seam is the only place a vendor's specifics live.
    const resumable = ctx.driver.capabilities.resumableSession;
    const sessionId = resumable ? (ctx.session.sessionId ?? exit.sessionId ?? null) : null;
    if (resumable && !sessionId) {
      // A resumable driver that produced no session id is an anomaly: reported blocked, resumable
      // never, so parking it would be a promise the daemon cannot keep. Finalize with its context
      // intact; `settle` abandons the orphaned signal so the row is not left blocked forever.
      this.log.warn('run asked a human but its resumable tool returned no session — cannot park', {
        runId: run.id,
        tool: run.agentTool,
      });
      return null;
    }

    // The RUN's spend, not just this sitting's (RUN-59): the tally already folds any prior park and
    // every session that billed. Persisting the mix keeps a resume's breakdown summing to its total.
    const runSpend = ctx.tally.total();
    try {
      await this.deps.parked.park({
        run,
        // A resumed run is the same dispatch, not a new one (RUN-192). Persist the loaded catalog so
        // editing a workflow while the question is open affects the next dispatch only, including
        // when the daemon restarts before the answer arrives.
        ...(ctx.repo.workflowCatalog ? { workflowCatalog: ctx.repo.workflowCatalog } : {}),
        sessionId,
        agentId: ctx.runAgent.agentId,
        agentLabel: ctx.runAgent.label,
        mcpToken: ctx.runAgent.token,
        workspace: ctx.worktree,
        spent: {
          tokens: totalTokens(runSpend),
          usd: runSpend.costUsd,
          ...(runSpend.modelUsage ? { modelUsage: runSpend.modelUsage } : {}),
        },
        activeSeconds: ctx.activeSeconds,
        // Where the chain stopped (RUN-168). Omitted entirely for an undecomposed run, so its park
        // record is byte-identical to one written before chains existed — a park is a persisted file
        // other tooling reads, and a field that appears on every record to say "not applicable" is a
        // shape change for nothing.
        ...(ctx.stepId ? { stepId: ctx.stepId } : {}),
        // The hand-off a resumed chain would otherwise start without (RUN-171). Omitted when empty,
        // for the same reason `stepId` is: an undecomposed park keeps the shape it always had.
        ...(ctx.priorSteps?.length ? { priorSteps: ctx.priorSteps } : {}),
        parkedAt: new Date().toISOString(),
        question: state.question,
      });
    } catch (err) {
      // The park could not be PERSISTED (a disk failure). Without the record the run can never be
      // resumed, so parking it would be a promise the daemon cannot keep — finalize instead, its
      // worktree kept by `settle`'s own probe. The intent names this case ("refused/**failed**"):
      // the orphaned signal is abandoned at the terminal boundary like every other declining path.
      this.log.warn('could not persist the park — the run cannot be resumed; finalizing instead', {
        runId: run.id,
        err: String(err),
      });
      return null;
    }
    // The server already moved the row to blocked when the agent asked; reporting it back is what
    // makes the daemon's view and the dashboard's agree, and it carries the final spend.
    this.deps.report(run.id, { status: 'blocked', telemetry: runSpend, logTail: ctx.tail });
    this.log.info('run parked on a human — session ended, worktree kept', {
      runId: run.id,
      question: state.question?.slice(0, 80) ?? null,
    });
    // NOT terminal, and the worktree is deliberately left alone: it holds the work, and the
    // resumed session expects to find it exactly where it was. Carry the RUN's spend (tally total),
    // not this sitting's first-result snapshot, so a caller reading the returned exit agrees with
    // what was reported and parked (RUN-59).
    return { ...exit, outcome: 'done', isError: false, reason: 'parked', sessionId, telemetry: runSpend };
  }

  /**
   * A run terminated WITHOUT parking while the server still holds an open blocked question — tell
   * the server the question died with the run (RUN-199), so the row is not left `blocked` on a
   * question nobody will ever answer into anything. `settle` calls this at the ONE terminal boundary
   * every declining path flows through — the primary session's decline branches, a park write that
   * failed, and a WAVE CHILD that asked (a child cannot park, and the chain reports it failed) — so
   * the abandonment is a property of the run terminating, not a call bolted onto each refusal.
   *
   * Self-probing: a run reaching `settle` has NOT parked (a successful park returns before it), so
   * `blocked === true` here means the question is orphaned. Best-effort throughout — no probe dep,
   * no abandon dep, or any failure is a silent no-op (the pre-RUN-199 behaviour a human clears by
   * hand), never a throw that could wedge a terminal run.
   */
  private async abandonOrphanedSignal(runId: string): Promise<void> {
    if (!this.deps.getParkState || !this.deps.abandonSignal) return;
    const state = await this.deps.getParkState(runId).catch(() => null);
    if (!state?.blocked) return;
    await this.abandonBlockedSignal(runId, state.signalId);
  }

  /** Tell the server one specific blocked question died with its run (RUN-199). Best-effort: a
   *  missing dep or absent signal is a no-op, and a failed call warns rather than throwing. */
  private async abandonBlockedSignal(runId: string, signalId: string | null): Promise<void> {
    if (!signalId || !this.deps.abandonSignal) return;
    await this.deps.abandonSignal(runId, signalId).catch((err) => {
      this.log.warn('could not tell the server a blocked question died with the run', {
        runId,
        err: String(err),
      });
    });
  }

  /**
   * Bring a parked run back with the human's answer (RUN-30).
   *
   * The payoff of the whole feature is here: the agent returns with everything it had already
   * worked out still in context, rather than a fresh run re-reading the repo to re-derive it.
   * Same worktree, same session, same identity — only the answer is new.
   *
   * Idempotent by construction: unpark() removes the entry before anything else, so a duplicate
   * resume (the WS frame AND the reconnect sweep can both fire for one answer) finds nothing and
   * returns null rather than starting a second process in the same worktree.
   */
  /**
   * Deliver a human answer to a stage holding in THIS process (RUN-190). True = delivered; the
   * caller must not treat the run as needing a session restore. The waiter is REMOVED before it
   * fires, so a racing duplicate (ws frame + reconnect sweep) finds nothing and no-ops. The park
   * record is cleaned up best-effort AFTER the wake — a record that outlives its answer is a
   * stale row the reaper handles; an answer lost to a failed disk flush would be a stuck run.
   */
  deliverStageAnswer(runId: string, answer: string): boolean {
    const waiter = this.stageWaiters.get(runId);
    if (!waiter) return false;
    this.stageWaiters.delete(runId);
    waiter(answer);
    this.deps.parked?.unpark(runId).catch((err) => {
      this.log.warn('answered stage park could not be removed from disk — the reaper will', {
        runId,
        err: String(err),
      });
    });
    this.log.info('delivered a human answer to a waiting stage', { runId });
    return true;
  }

  async resume(runId: string, answer: string): Promise<DriverExit | null> {
    // A STAGE park first (RUN-190): the stage's stack is holding in this very process, so the
    // answer is delivered rather than restored.
    if (this.deliverStageAnswer(runId, answer)) {
      return { outcome: 'done', isError: false, reason: 'stage-answer', telemetry: zeroTelemetry() };
    }

    const entry = await this.deps.parked?.unpark(runId);
    if (!entry) return null;
    const { run } = entry;

    // A stage park with nobody waiting: the daemon restarted while the stage held (RUN-190). The
    // stack that would consume this answer is gone, and so is any session — but so is any WORK:
    // a stage park precedes the build (or, for `review`, sits on work already committed to the
    // run's branch, which the continuation flow can pick up). Failing loudly with the reason is
    // the honest move; pretending to resume would run a stage against a context nobody holds.
    if (entry.stage) {
      this.deps.report(run.id, {
        status: 'failed',
        exit: {
          outcome: 'failed',
          reason:
            entry.stage === 'review'
              ? 'the review stage was awaiting this answer when the daemon restarted — the work is committed on the run branch; continue the run to pick it up'
              : `the ${entry.stage} stage was awaiting this answer when the daemon restarted — nothing was built yet; re-dispatch the run`,
        },
      });
      this.log.warn('a stage park did not survive a daemon restart — the run must be re-dispatched', {
        runId: run.id,
        stage: entry.stage,
      });
      return {
        outcome: 'failed',
        isError: true,
        reason: 'stage park lost across restart',
        telemetry: zeroTelemetry(),
      };
    }

    const fail = (reason: string): DriverExit => {
      this.deps.report(run.id, { status: 'failed', exit: { outcome: 'failed', reason } });
      this.log.warn('could not resume a parked run', { runId, reason });
      return { outcome: 'failed', isError: true, reason, telemetry: zeroTelemetry() };
    };

    const currentRepo = await this.deps.resolveRepo(run.repoRef);
    if (!currentRepo) return fail(`repo not found for repoRef ${run.repoRef}`);
    // Re-resolve the repository because the task/spec and manifest may legitimately move during a
    // 72-hour park, but keep the workflow snapshot this dispatch prepared under (RUN-192). Without
    // this overlay, changing a verify-based definition to build while it waits grants the resumed
    // session build posture and runs the producing pipeline. A park written before RUN-192 has no
    // snapshot and retains the old best-effort fallback to the current catalog.
    const repo = entry.workflowCatalog
      ? { ...currentRepo, workflowCatalog: entry.workflowCatalog }
      : currentRepo;
    const workflowSource = repo.workflowCatalog ?? repo.manifest;
    const kind = effectiveKind(run, workflowSource); // RUN-126: a workflow's base posture is authoritative
    // The run's workflow (RUN-117), the NAMED one when the repo defines it (RUN-132) — same
    // posture either way; what the named one adds is its declared stage list.
    const wf = runWorkflow(run, workflowSource);
    // The builder's coordinate (RUN-193), resolved the SAME way `prepare` does — the execute stage's
    // agent on top of the dispatch coordinate. Not honoring it here would resume a build that ran on
    // codex onto claude: the parked session belongs to the coordinate's driver, so restoring it on
    // any other is a session that cannot resume, not merely a wrong model.
    const execCoord = stageCoordinate(wf, 'execute', this.log);
    const tool = execCoord?.tool ?? resolveAgentTool(run); // the coordinate's tool (RUN-114/193)
    const driver = this.deps.drivers[tool as AgentTool];
    if (!driver) return fail(`no driver for tool ${tool}`);
    // A resumable park restores its session and comes back IN it (claude); a non-resumable one
    // (codex, RUN-199) parked with sessionId:null and comes back CONTINUATION-style — a fresh
    // session over the kept worktree, re-briefed from scratch. So a null session id no longer
    // refuses the resume, it SELECTS the path.
    const isContinuation = !entry.sessionId;
    // The model/effort with the execute stage coordinate folded on top (RUN-193), through the same
    // fold every spawn uses — so a resumed session, and the chain steps that spread this `start`,
    // run under the coordinate the fresh build did.
    const resumeModelEffort = foldStageCoordinate(execCoord, {
      tool: resolveAgentTool(run),
      ...resolveModel(run, repo.manifest),
    });

    // The workspace is REUSED, never re-leased: it holds the work the agent did before it
    // asked, and the session it is about to resume expects to find it exactly as it left it.
    // Restored WHOLE from the park (RUN-50) — before that, this code hand-assembled a git-shaped
    // object with `baseSha: ''`, a lie that only worked because git's hasWork tolerates it.
    const worktree = entry.workspace;
    const runAgent: RunAgent = {
      agentId: entry.agentId,
      label: entry.agentLabel,
      token: entry.mcpToken,
      projectId: run.projectId,
      // The park stores no expiry and nothing downstream reads one; what actually bounds this
      // token's usefulness is DEFAULT_PARK_TTL_HOURS, kept well inside its real 7-day life.
      expiresIn: 0,
    };
    const noriqMcp: NoriqMcp = {
      url: `${this.deps.server.replace(/\/+$/, '')}/mcp`,
      token: entry.mcpToken,
    };

    this.deps.report(run.id, { status: 'running', phase: 'agent' });
    this.log.info('resuming a parked run', { runId, agentId: entry.agentId, session: entry.sessionId });

    // What changed while it waited (RUN-164). A park can last up to 72 hours: the human answering
    // may have corrected the spec at the same time — RUN-137 exists so they can — and another run
    // may have landed, moving a file this one's plan names. A resume otherwise carries on against
    // a premise nobody re-checked, and neither the agent nor its reviewer learns the goalposts
    // moved.
    //
    // A DIFF, not a replay: re-sending the whole brief would spend tokens telling a session what
    // it already holds. Silence when nothing moved, which is the common case.
    const {
      rendered: changed,
      checked: resumedSpec,
      task: resumedTask,
    } = await this.specChangedWhileParked(run, worktree, wf.produces).catch((err) => {
      this.log.warn('could not re-check the spec on resume', { runId, err: String(err) });
      return { rendered: '', checked: null, task: null };
    });

    // The resumed run's tally (RUN-59), SEEDED with the park's prior spend + mix so this sitting's
    // figures accumulate onto — and keep summing with — everything spent before the park. It also
    // carries the run's ceiling and the park's active seconds (RUN-133), which is what makes the
    // reservation below the REMAINDER rather than a fresh budget: otherwise "ask a question" is a
    // way to buy more, and a run could park its way past any limit.
    const tally = new RunTally(mergeBudget(run.budget, this.deps.defaultBudget), entry.activeSeconds);
    tally.seed('__prior__', telemetryFromSpent(entry.spent));
    const reservation = tally.reserve();
    if (!reservation.ok) {
      // The park outlived its budget. Fail it rather than spawn a session with nothing to spend —
      // the worktree is kept either way, so the work is not lost.
      return fail(`${reservation.breach}: ${reservation.detail}; not resuming`);
    }

    // Where a resumed CHAIN picks up (RUN-168), computed BEFORE `start` because a continuation resume
    // folds the rebuilt brief into its prompt (RUN-199). The chain is recomputed from the spec as it
    // stands NOW — the same re-fetch RUN-164 does — so a spec corrected during the park is the one
    // that governs. A park written before steps existed records no position; its spec may have GAINED
    // steps since, and chaining it then would treat step one as fresh — erasing the resume session
    // id, never delivering the answer, replaying done work. Such a park resumes as the single session
    // it was written as.
    const resumedChain = entry.stepId ? checkSteps(resumedSpec?.spec) : { steps: [], findings: [] };
    if (!entry.stepId && checkSteps(resumedSpec?.spec).steps.length) {
      this.log.info('this park predates step positions — resuming it as the single session it was', {
        runId,
      });
    }
    // Total length is the wrong question: a two-step chain parked on step two has nothing after it.
    const resumeAt = resumedChain.steps.findIndex((st) => st.id === entry.stepId);
    const hasLaterSteps = resumeAt >= 0 && resumeAt < resumedChain.steps.length - 1;
    // A brief is rebuilt for the later steps (RUN-169) AND for a continuation's own fresh session
    // (RUN-199), which has none to fall back on. The diff range is the same one `prepare` computes: a
    // verify actor's whole subject is the accumulated diff (RUN-21), and a leased build branch is
    // CLEAN — so omitting it would let a resumed verify pass a change it never saw. Non-git backends
    // have no such command and the prompt points at the workspace instead.
    const needsBrief = hasLaterSteps || isContinuation;
    const resumedDiffCmd =
      needsBrief && run.verifiesRunId && (this.vcsFor(repo).kind ?? 'git') === 'git'
        ? `git diff ${(await this.planBase(repo, run).catch(() => null)) ?? repo.manifest.defaultBranch ?? worktree.baseId}...HEAD`
        : undefined;
    // Rebuilt from the same acquire-nothing assembler `prepare` uses (RUN-169). Never fatal for a
    // session RESTORE — it falls back to the answer-only prompt the restored session already has the
    // context for. A CONTINUATION has no such session, so a brief it cannot build IS fatal (below).
    const resumedBrief = needsBrief
      ? await buildRunBrief(this.prepareHost(), {
          run,
          repo,
          worktree,
          task: resumedTask,
          runAgent,
          kind,
          ...(resumedDiffCmd ? { diffCmd: resumedDiffCmd } : {}),
          workflow: wf,
        }).catch((err) => {
          this.log.warn('could not rebuild the brief on resume', { runId, err: String(err) });
          return null;
        })
      : null;
    if (isContinuation && !resumedBrief) {
      // A non-resumable park has no session holding the brief, so a fresh one with only the answer
      // would be worse than not running — an answer to a question it never asked. Fail with the
      // worktree kept, exactly as the busted reservation above does.
      return fail('could not rebuild the brief for a continuation resume; not resuming — worktree kept');
    }
    // The prompt this sitting opens with. A restore hands the answer alone: the session already holds
    // the brief, the task and the repo tour (RUN-30), and re-sending them would waste the context and
    // confuse a conversation mid-thought. A continuation is a FRESH session over the kept worktree
    // (RUN-199), so it gets the whole brief rebuilt from the spec as it stands now — the same brief a
    // first dispatch would build — with the Q&A appended.
    // The Q&A block a continuation gets — appended to the whole-run brief for an undecomposed run,
    // and (RUN-199) to the RESUMED STEP's own brief for a decomposed one, which the chain assembles
    // from `resumedStepQa` so that fresh session is told which step it is on rather than the whole
    // sequence. Empty string on a restore, which never reads it.
    //
    // No `changed` (RUN-164) here: that block re-renders the CURRENT spec framed as "the plan changed
    // — this REPLACES what you were told", which orients a RESTORED session holding the OLD spec. A
    // continuation's brief is rebuilt from the current spec already, so passing it would render the
    // spec twice and frame the second copy as a correction to an original this fresh session never
    // received.
    const continuationQa = isContinuation ? continuationResumePrompt(entry.question, answer) : '';
    const resumePromptText =
      resumedBrief && isContinuation
        ? `${resumedBrief.buildPrompt(authorSpecBlock(resumedTask, resumedSpec), resumedSpec?.spec ?? null)}${continuationQa}`
        : resumePrompt(entry.question, answer, changed);

    // The SAME execute stage `supervise` runs (RUN-131) — including its re-park check, because an
    // agent given an answer may well have a second question and there is no reason the second one
    // is worth less than the first. Everything that differs about a resume is resolved here, in
    // `start`, rather than by a second copy of the spawn-and-await loop.
    const resumeStart = {
      runId: run.id,
      kind,
      cwd: worktree.localPath,
      prompt: resumePromptText,
      // Restore the session on a resumable driver; omit it on a continuation, which opens a fresh
      // session the chain path (RUN-168) already treats as such via `resumeSessionId: undefined`.
      ...(entry.sessionId ? { resumeSessionId: entry.sessionId } : {}),
      permission: clampPermissionToWorkflow(repo.manifest.permissions[kind], wf),
      noriqMcp,
      multiTurn: wf.produces && Boolean(repo.manifest.verify),
      // The same model it was running before it parked (RUN-33/193): the session being resumed is
      // that model's conversation — the execute-stage coordinate included — and quietly finishing
      // the job on a different one would make "resumed with its context intact" only half true.
      ...(resumeModelEffort.model ? { model: resumeModelEffort.model } : {}),
      ...(resumeModelEffort.effort ? { effort: resumeModelEffort.effort } : {}),
      // The REMAINDER, reserved from the tally above (RUN-133) — one allocator for every session
      // a run spawns, rather than a resume-only helper beside a reviewer that had none.
      budget: reservation.budget,
      spendGuard: tally.guard('primary'),
      clockGuard: tally.clockGuard(),
    };
    const resumeBase = {
      run,
      repo,
      worktree,
      driver,
      runAgent,
      tally,
      priorActiveSeconds: entry.activeSeconds,
      start: resumeStart,
    };
    const executed = resumedChain.steps.length
      ? await executeChain(this.executeHost(), {
          ...resumeBase,
          steps: resumedChain.steps,
          ...(entry.stepId ? { resumeFromStepId: entry.stepId } : {}),
          // The Q&A appended to the RESUMED step's own brief when it comes back a FRESH session
          // (RUN-199) — so a decomposed continuation's parked step is told which step it is on and
          // what earlier steps concluded, rather than the whole-run brief a restore would carry.
          ...(continuationQa ? { resumedStepQa: continuationQa } : {}),
          // What the steps before the parked one concluded (RUN-171) — without it, the step after
          // the resume rediscovers everything the run had already established.
          ...(entry.priorSteps?.length ? { priorSteps: entry.priorSteps } : {}),
          // Only when the brief could not be rebuilt: a fresh step with no brief is worse than one
          // that does not run, and saying so beats running it badly.
          ...(resumedBrief ? {} : { stopAfterResumedStep: true }),
          // A fresh step gets the RUN's brief, not the resume's (RUN-169). The resume prompt is
          // deliberately only the question and the human's answer, because the session it restores
          // already holds everything else — but a session opened AFTERWARDS holds nothing, and
          // handing it an answer to a question it never asked was worse than not running it. So
          // the brief is rebuilt here, from the same assembler `prepare` uses.
          stepPrompt: (step, i, prior) =>
            `${resumedBrief?.buildPrompt(authorSpecBlock(resumedTask, resumedSpec), resumedSpec?.spec ?? null) ?? resumeStart.prompt}${renderStepFocus(step, i, resumedChain.steps.length)}${renderPriorSteps(prior)}`,
          checkpoint: (label) => this.vcsFor(repo).checkpoint(worktree, runCommitMessage(run.id, label)),
          // Same wave seam as the supervise path (RUN-170): the resumed step's own wave runs
          // sequentially (the chain enforces that), but the steps AFTER it may overlap.
          wave: this.waveFor(repo, run),
        })
      : await executeRun(this.executeHost(), resumeBase);
    // The parked step is gone from the recomputed plan (RUN-168), or a cancel landed before the
    // resumed session spawned (RUN-165). Both still SETTLE: the park's workspace holds the earlier
    // sittings' work, and settle's own probe is what keeps it — plus the terminal report, the lock
    // release, the refreshed continuation record and the cancellation cleanup that a bare `fail()`
    // here skipped. The inert outcome walks the same pipeline, which on a failed exit is `settle`.
    const outcome = 'chainFailed' in executed ? sessionlessChainExit(run, executed.chainFailed) : executed;
    if (outcome.parked) return outcome.parked;

    return this.afterDriver({
      run,
      repo,
      worktree,
      driver,
      permission: clampPermissionToWorkflow(repo.manifest.permissions[kind], wf),
      noriqMcp,
      task: run.anchor?.type === 'task' ? await this.resolveAnchorTask(run.anchor.taskId) : null,
      runAgent,
      session: outcome.session,
      stopSession: outcome.stopSession,
      executedSpec: resumedSpec,
      exit: outcome.exit,
      tally,
      verifyText: outcome.sessionText,
      getSessionText: outcome.getSessionText,
      tail: outcome.tail,
      // RUN-247: only present when `resumedBrief` actually rebuilt one (`needsBrief` above) — a
      // plain session RESTORE never re-renders memory at all (the session already holds whatever
      // its first sitting saw), so there is nothing this call captured to carry forward. That
      // sitting's own consumption fact is not recoverable here: `resume` has no `prepare`, and a
      // successful park returns before `afterDriver` ever builds a pipeline to capture it onto —
      // the same absence this file already accepts for `contextPack`/`verifiedContextPack`
      // themselves on every resume path.
      contextConsumption: resumedBrief?.contextConsumption,
      // RUN-261: a resumed sitting still spawns a live session (the restored one, or the fresh
      // continuation-style one RUN-199 opens) — `outcome` only lacks this when the resumed chain
      // failed before any step ran (`sessionlessChainExit`), which carries no `agentStartedAt`.
      ...(outcome.agentStartedAt ? { agentStartedAt: outcome.agentStartedAt } : {}),
    });
  }

  /**
   * Fail the parks that have waited too long to be worth resuming (RUN-30).
   *
   * Called on daemon start. A park pins a worktree and a branch while the base moves on
   * underneath it, and its agent's token expires at 7 days — so a park that sits forever is a
   * run that will resume into a world it does not recognise, holding a credential that no longer
   * works. The worktree is deliberately NOT reaped: it holds work that exists nowhere else.
   */
  async expireStaleParks(now = new Date()): Promise<number> {
    const all = (await this.deps.parked?.list()) ?? [];
    const stale = expiredParks(all, now, this.deps.parkTtlHours);
    for (const p of stale) {
      await this.deps.parked?.unpark(p.run.id);
      this.deps.report(p.run.id, {
        status: 'failed',
        exit: { outcome: 'failed', reason: 'park_expired' },
      });
      this.log.warn('parked run expired — nobody answered in time; its worktree is kept', {
        runId: p.run.id,
        parkedAt: p.parkedAt,
        worktree: p.workspace.localPath,
      });
    }
    return stale.length;
  }

  /**
   * Run one dispatched Run to completion. Never throws — failures are reported.
   *
   * Three lines of pipeline (RUN-131): prepare it, execute it, then walk the post-driver stages.
   * The ~260 lines of setup that used to sit here are `stages/prepare.ts`, and the ~60 that spawned
   * and awaited the agent are `stages/execute.ts` — which `resume` now shares rather than repeats.
   */
  async supervise(run: Run): Promise<DriverExit> {
    const fail = (reason: string): DriverExit => {
      this.deps.report(run.id, { status: 'failed', exit: { outcome: 'failed', reason } });
      return { outcome: 'failed', isError: true, reason, telemetry: zeroTelemetry() };
    };

    // A cancel is a fact about the RUN (RUN-165), so it is asked at every boundary rather than
    // inferred from whether a session happens to be registered. `stopBefore` is the sequence's own
    // predicate — a new stage that forgets to ask is a bug this file can state.
    const cancelled = (next: StageName) =>
      stopBefore(next, this.deps.steering?.isCancelled?.(run.id) ?? false);

    const prepared = await prepareRun(this.prepareHost(), run);
    if (!prepared.ok) return fail(prepared.reason);
    const afterPrepare = cancelled('plan');
    if (afterPrepare) return fail(afterPrepare.reason);

    // `plan` (RUN-140), between prepare and execute because a spec written after the build has
    // started is a spec nobody read. It no-ops unless the workflow produces, the run has a task,
    // and that task arrived unplanned — and it can only ever ENRICH the prompt: a planner that
    // fails leaves `start` exactly as prepare built it.
    const { start, checked: executedSpec } = await this.planIfUnplanned(run, prepared);

    // The pre-execution stages are deliberately non-fatal, so a cancel during one of them reads as
    // "that stage produced nothing" — which is exactly how a cancelled run used to reach a build.
    const afterPlan = cancelled('execute');
    if (afterPlan) return fail(afterPlan.reason);

    const base = {
      run,
      repo: prepared.repo,
      worktree: prepared.worktree,
      driver: prepared.driver,
      runAgent: prepared.runAgent,
      tally: prepared.tally,
      start,
      priorActiveSeconds: 0,
    };
    // A spec that declared a runnable decomposition runs as a CHAIN of sessions (RUN-168), one per
    // step; anything else is one session, exactly as before. `checkSteps` has already dropped a
    // decomposition it could not run, so an empty list here means "run this as one" rather than
    // "something was wrong" — which is why there is no branch for the failure.
    // What this run was actually briefed with, recorded once (RUN-166). Sent here rather than at
    // dispatch because THIS is where the answer exists: a task that arrived unplanned executes
    // under whatever the planner wrote, which the server never sent and could not have stored.
    // `hasExecutionSpec`, not truthiness: a planner that answered with nothing produces a
    // normalised-but-EMPTY spec, and reporting that would record "briefed with a vacuous contract"
    // where the truth is "briefed with none" — the two facts this record exists to distinguish.
    if (hasExecutionSpec(executedSpec?.spec)) {
      this.deps.report(run.id, { status: 'running', executedSpec: executedSpec!.spec });
    }

    // The resolved coordinate this run is actually executing under (RUN-241), sent once, the same
    // way and for the same reason as `executedSpec` just above — see `RunReport.executedConfiguration`'s
    // doc for why it rides this frame rather than a status transition. Read from `prepared`/`start`
    // rather than the dispatch request: `driver.tool` and `workflow.id` are what prepare actually
    // picked (a workflow's execute-stage coordinate can override the dispatch tool), and `start`
    // is post-`planIfUnplanned` so a plan-mutated prompt does not race this report — though planning
    // only ever rewrites the prompt, never the tool/model/effort/workflow ladder.
    // `vendor`/`reviewer`/`verifier` stay null: this repo has no vendor identifier distinct from
    // `tool`, and neither judging actor's coordinate is chosen this early (the inline reviewer's is
    // resolved per round inside `runReviewer`) — a guess would be worse than an honest gap here.
    //
    // `configuration` (RUN-246, `config-fingerprint.ts`): the per-component fingerprints that make
    // two revisions of the same `workflow.id`/manifest distinguishable, since a name alone is not —
    // see that module's own doc for the sorting, the per-kind content chosen, and what is kept out
    // (no absolute path, no credential, ever). It reads `prepared.workflow`/`prepared.repo.manifest`
    // — exactly what THIS run resolved to, the same reasoning `strategy` above rests on.
    //
    // Computed SYNCHRONOUSLY and inline, which is the whole reason `config-fingerprint.ts` hashes
    // with `createHash` instead of awaiting the shared `crypto.subtle`-based helper — see that
    // module's own doc. The two alternatives were measured and both cost something real: awaiting
    // five macrotask digests puts event-loop turns on this run's critical path (RUN-238's
    // distinction), and reporting them fire-and-forget loses a race with the terminal status, which
    // `daemon.ts` uses to drop an undelivered `pendingConfiguration` — so a fast run would report
    // no configuration at all. A hashing bug must never cost the run, so it degrades to strategy
    // alone rather than throwing out of `supervise`.
    let configuration: ConfigurationFingerprint[] = [];
    try {
      configuration = computeConfigurationFingerprints({
        runnerVersion: VERSION,
        manifest: prepared.repo.manifest,
        workflow: prepared.workflow,
      });
    } catch (err) {
      this.log.warn('could not compute configuration fingerprints — reporting strategy only', {
        runId: run.id,
        err: String(err),
      });
    }
    this.deps.report(run.id, {
      status: 'running',
      executedConfiguration: {
        strategy: {
          tool: prepared.driver.tool,
          vendor: null,
          model: start.model ?? null,
          effort: start.effort ?? null,
          workflow: prepared.workflow.id,
          reviewer: null,
          verifier: null,
          contextStrategy: null,
          concurrencyStrategy: null,
        },
        configuration,
      },
    });

    const chain = checkSteps(executedSpec?.spec);
    const executed = chain.steps.length
      ? await executeChain(this.executeHost(), {
          ...base,
          steps: chain.steps,
          stepPrompt: (step, i, prior) =>
            `${start.prompt}${renderStepFocus(step, i, chain.steps.length)}${renderPriorSteps(prior)}`,
          checkpoint: (label) =>
            this.vcsFor(prepared.repo).checkpoint(prepared.worktree, runCommitMessage(run.id, label)),
          // The wave seam (RUN-170): overlap capability, limit and the run-addressed return trip,
          // injected as closures the way checkpoint is.
          wave: this.waveFor(prepared.repo, run),
        })
      : await executeRun(this.executeHost(), base);
    // A chain that never started a session (RUN-168) is still a run that PREPARED: the workspace
    // is leased, the locks are held, the transcript is open, a cancel has written the record only
    // `settle` forgets (RUN-165) — so "no session" is not "nothing to settle around". Shaped as an
    // inert outcome it enters the same post-driver walk as every other exit, which reduces to
    // `settle` on a failed exit; `fail()`-ing here instead bypassed the terminal report, the lock
    // release and the workspace's keep-or-dispose decision.
    const outcome = 'chainFailed' in executed ? sessionlessChainExit(run, executed.chainFailed) : executed;
    if (outcome.parked) return outcome.parked;

    return this.afterDriver({
      run,
      repo: prepared.repo,
      worktree: prepared.worktree,
      driver: prepared.driver,
      permission: prepared.permission,
      ...(prepared.noriqMcp ? { noriqMcp: prepared.noriqMcp } : {}),
      task: prepared.task,
      runAgent: prepared.runAgent,
      session: outcome.session,
      stopSession: outcome.stopSession,
      exit: outcome.exit,
      tally: prepared.tally,
      verifyText: outcome.sessionText,
      getSessionText: outcome.getSessionText,
      tail: outcome.tail,
      continued: prepared.continued,
      executedSpec,
      contextPack: prepared.contextPack,
      verifiedContextPack: prepared.verifiedContextPack,
      contextConsumption: prepared.contextConsumption,
      // Absent only when the chain failed before any step spawned a session (RUN-261,
      // `sessionlessChainExit`) — an ordinary undecomposed run always has one, since `executeRun`
      // is reached only past every cancellation check that could have short-circuited first.
      ...(outcome.agentStartedAt ? { agentStartedAt: outcome.agentStartedAt } : {}),
    });
  }

  /**
   * The spec's story since the park (RUN-164): what to tell the resumed session, and the checked
   * spec its GATE will be held to.
   *
   * Re-fetches the anchor task and re-checks it against the workspace as `prepare` would — the two
   * things a resume skips by going straight to `executeRun`. Two independent ways a resumed run's
   * premise goes stale, and this catches both: the SPEC changed (a human corrected it while
   * answering), or the CHECKOUT changed (another run landed and a file the plan names moved).
   *
   * Compared as rendered text rather than by deep-equalling the spec: the rendered block is what
   * the session was actually told, and a difference the rendering does not show is a difference
   * that would not have reached the agent anyway.
   *
   * `checked` rides along because a resume reaches `afterDriver` by its own path (RUN-145). Without
   * it the resumed run's reviewer got an EMPTY checklist while a first-sitting run's got the
   * criteria — so parking, answering a question and carrying on silently disabled the gate's
   * definition of done. One lookup answers both, so the gate cannot end up judging a different spec
   * than the one this session was just told about.
   */
  private async specChangedWhileParked(
    run: Run,
    worktree: Workspace,
    produces: boolean,
  ): Promise<{ rendered: string; checked: CheckedExecutionSpec | null; task: AnchorTask | null }> {
    const none = { rendered: '', checked: null, task: null };
    if (run.anchor?.type !== 'task') return none;
    const task = await this.resolveAnchorTask(run.anchor.taskId);
    if (!task) return none;
    // The TASK rides back too (RUN-169): a resumed chain needs it to rebuild a brief for the steps
    // that never ran, and re-fetching it a second line later would be a second answer to a
    // question that can change between the two.
    if (task.executionSpecUnreadable) return { rendered: renderUnreadableSpec(), checked: null, task };
    if (!task.executionSpec) return { ...none, task };
    const checked = await checkExecutionSpec(task.executionSpec, worktree.localPath, {
      ...(this.deps.specPathProbe ? { probe: this.deps.specPathProbe } : {}),
      produces,
    });
    return { rendered: renderExecutionSpec(checked), checked, task };
  }

  /**
   * The driver + model/effort a PRE-EXECUTION stage runs under (RUN-193): the workflow's stage
   * coordinate on TOP of the run's prepared coordinate (the sub-ladder locked decision #2 names).
   *
   * These stages — planner, plan-checker, pattern-mapper — are NEVER fatal, so their missing-driver
   * behaviour differs from the mandatory `execute` stage's: a coordinate naming a tool this machine
   * has no driver for does NOT refuse the run, it falls back to the prepared driver with a warn
   * (and drops the stage's model with it — a model id is not portable to another vendor's driver),
   * because losing the enrichment entirely is worse than producing it on the run's own driver. When
   * the tool IS present, `foldStageCoordinate` layers the coordinate over the prepared model/effort
   * with the same sever-unless-same-tool rule the reviewer uses.
   */
  private resolveStageAgent(
    coord: AgentCoordinate | null,
    prepared: PreparedRun,
    runId: string,
    stage: StageCoordinateKey,
  ): { driver: AgentDriver; model?: string; effort?: RunEffort } {
    const inherited = {
      ...(prepared.start.model ? { model: prepared.start.model } : {}),
      ...(prepared.start.effort ? { effort: prepared.start.effort } : {}),
    };
    if (!coord) return { driver: prepared.driver, ...inherited };
    const staged = this.deps.drivers[coord.tool as AgentTool];
    if (!staged) {
      this.log.warn(
        `the ${stage} stage names a '${coord.tool}' agent but this runner has no such driver — using the run's driver`,
        { runId, tool: coord.tool },
      );
      return { driver: prepared.driver, ...inherited };
    }
    const folded = foldStageCoordinate(coord, {
      tool: prepared.driver.tool,
      model: prepared.start.model ?? null,
      effort: prepared.start.effort ?? null,
    });
    return {
      driver: staged,
      ...(folded.model ? { model: folded.model } : {}),
      ...(folded.effort ? { effort: folded.effort } : {}),
    };
  }

  /**
   * Run the `plan` stage when it applies, and fold its result into the builder's brief (RUN-140).
   *
   * Returns `prepared.start` untouched whenever planning does not apply or does not work, which is
   * what makes this stage unable to cost a run: every failure path here is "the run proceeds
   * exactly as it would have without me".
   */
  private async planIfUnplanned(
    run: Run,
    prepared: PreparedRun,
  ): Promise<{ start: PreparedRun['start']; checked: CheckedExecutionSpec | null }> {
    // The spec this run proceeds under if planning does not happen or does not work — which is
    // every early return below. The gate downstream is answering ACCEPTANCE CRITERIA (RUN-145), so
    // it needs the spec the build was actually briefed with, and "the one prepare found" and "the
    // one the planner wrote" are different answers on different paths.
    const unplanned = { start: prepared.start, checked: prepared.checkedSpec };
    // Asked before each pre-execution spawn too, not only at the pipeline's boundaries: these
    // stages are minutes long, and a cancel arriving inside one should not be answered by starting
    // the next.
    const stopped = () => this.deps.steering?.isCancelled?.(run.id) ?? false;
    if (stopped()) return unplanned;
    if (!stagesFor(prepared.workflow).some((s) => s.name === 'plan')) return unplanned;
    if (!prepared.plannedTask) return unplanned;

    // The planner spends the RUN's remaining ceiling like any other session (RUN-133) — a run with
    // nothing left declines to plan rather than starting a process to kill.
    const reservation = prepared.tally.reserve();
    if (!reservation.ok) {
      this.log.warn('no budget left to plan this run — proceeding unplanned', {
        runId: run.id,
        breach: reservation.breach,
      });
      return unplanned;
    }

    // The planner may PAUSE the run on a human (RUN-190): a null outcome is probed against the
    // park state before it is read as "proceed unplanned" — proceeding while a human types an
    // answer to the planner's own question would spend the build to ignore them. Each answer
    // re-runs the planner fresh with the Q&A appended. Deliberately UNCAPPED: every iteration
    // costs a human an answer, which is the strongest rate limiter this system has — and a cap
    // would walk the pipeline on while the server still shows the run blocked on an open question.
    // The planner's own coordinate (RUN-193): `[stages.plan] agent` on top of the run's prepared
    // coordinate. A model choice only — the planner keeps `plannerPermission`'s narrowing and the
    // escalation-pair MCP below whatever model it runs on.
    const planAgent = this.resolveStageAgent(
      stageCoordinate(prepared.workflow, 'plan', this.log),
      prepared,
      run.id,
      'plan',
    );
    let answerBlock = '';
    let planned: PlanOutcome = null;
    for (;;) {
      planned = await planRun(this.planHost(), {
        run,
        repo: prepared.repo,
        worktree: prepared.worktree,
        driver: planAgent.driver,
        runAgent: prepared.runAgent,
        tally: prepared.tally,
        prompt: `${prepared.plannerPrompt}${answerBlock}`,
        start: {
          ...withStageModel(prepared.start, planAgent),
          permission: plannerPermission(prepared.permission),
          // The ESCALATION PAIR and nothing else. The planner used to get NO MCP at all (RUN-140):
          // the full floor grants writes the filesystem clamp says nothing about — `update_task`,
          // `claim_task`, `post_comment` — and the daemon writes the spec back itself, so the
          // planner has nothing to report. Both halves of that reasoning still hold, which is why
          // `noriqTools` narrows to raise_alert + request_input alone: a planner facing a decision
          // only a human can make (which of two contradictory requirements wins, whether a
          // half-migrated seam is the old shape or the new one) used to GUESS, because an actor
          // with a question and no way to ask does not stop. Now it pauses the run instead.
          noriqMcp: prepared.noriqMcp,
          noriqTools: STAGE_NORIQ_TOOLS,
          ...(reservation.budget ? { budget: plannerBudget(reservation.budget) } : {}),
          spendGuard: prepared.tally.guard('plan'),
          clockGuard: prepared.tally.clockGuard(),
        },
      }).catch((err) => {
        // A stage that cannot gate the run must not throw out of it either.
        this.log.warn('the plan stage failed — proceeding unplanned', { runId: run.id, err: String(err) });
        return null;
      });
      if (planned) break;
      const answered = await this.parkStage({
        run,
        worktree: prepared.worktree,
        runAgent: prepared.runAgent,
        tally: prepared.tally,
        stage: 'plan',
        tail: '',
      });
      if (!answered) break; // genuinely unplanned, not parked
      answerBlock += renderPrompt('stage-answer', answered);
    }
    if (!planned) return unplanned;

    // The plan checker (RUN-141), through the planner's still-open session. It cannot gate the
    // run: a plan that never clears goes to the builder WITH the findings, because refusing to
    // work over a disagreement between two advisors — about work neither has done — is worse than
    // building a plan somebody criticised.
    const outcome = stopped()
      ? { checked: planned.checked, findings: '' }
      : await this.checkPlanIfConfigured(run, prepared, planned).catch((err) => {
          this.log.warn('the plan checker failed — the plan stands as planned', {
            runId: run.id,
            err: String(err),
          });
          return { checked: planned.checked, findings: '' };
        });
    await planned.close(outcome.checked).catch(() => {});
    // Findings the loop never resolved travel WITH the plan. A criticised plan handed over looking
    // like an approved one is the worst of both: the tokens were spent and the warning was not.
    const unresolved = checkerFindings(outcome.findings);
    const checked: CheckedExecutionSpec = unresolved.length
      ? { ...outcome.checked, findings: [...outcome.checked.findings, ...unresolved] }
      : outcome.checked;

    // The pattern map (RUN-144) and the repo facts it caches (RUN-143).
    const extra = await this.mapPatternsIfWorthIt(run, prepared, checked).catch((err) => {
      this.log.warn('the pattern mapper failed — the builder gets no analogs', {
        runId: run.id,
        err: String(err),
      });
      return '';
    });

    // RE-RESERVE, and AFTER the pre-execution stages rather than before them:
    // `prepared.start.budget` was computed before any of this ran, so handing it to the builder
    // unchanged would let a run spend its ceiling twice — the per-session-copy bug RUN-133 removed.
    // Reserving before the pattern map was the same mistake one stage smaller: the builder would
    // have been told it could spend what the mapper then spent, and killed by the run guard
    // partway into work its own allowance said it could do.
    const rest = prepared.tally.reserve();
    if (!rest.ok) {
      this.log.warn('the pre-execution stages used what was left of this run', {
        runId: run.id,
        breach: rest.breach,
      });
      this.transcript(run.id).milestone(
        `planning used the run's remaining budget (${rest.breach}) — nothing left to build with`,
      );
    }

    return {
      checked,
      start: {
        ...prepared.start,
        prompt: prepared.rebuildPrompt(checked, extra),
        ...(rest.ok ? (rest.budget ? { budget: rest.budget } : {}) : { budget: EXHAUSTED_BUDGET }),
      },
    };
  }

  /**
   * Analogs for the plan's anticipated files, plus the repo facts that outlive this run (RUN-144),
   * seeded where possible from Noriq's own verified memory before any of that runs (RUN-233).
   *
   * Returns the brief section to append, or '' — every reason to produce nothing is a reason to
   * leave the builder exactly as well briefed as it would have been. The AGENT half (analogs, and
   * a MISS's own facts) is skipped when the plan anticipates no files (there is nothing to find an
   * analog FOR) or this workflow never declared the stage; the SEED half below is not, because it
   * spawns nothing and spends nothing — it is a pure translation of a pack this run already fetched.
   */
  private async mapPatternsIfWorthIt(
    run: Run,
    prepared: PreparedRun,
    checked: CheckedExecutionSpec | null,
  ): Promise<string> {
    // Skipped entirely for a CONTINUED run: its `baseId` is a merge-base rather than the tree it
    // is looking at (worktree.ts), so caching under it would file facts learned from a modified
    // checkout against a fork point, and a later fresh run at that fork point would read them.
    const intel = prepared.continued ? undefined : this.deps.repoIntel;

    if (!stagesFor(prepared.workflow).some((st) => st.name === 'pattern-map')) return '';
    if (!worthMapping(checked) || !checked) return '';

    // The FACTS are cacheable and the ANALOGS are not: facts describe the repo whatever the task
    // is, analogs are about THIS task's files. A cache hit therefore short-circuits the facts half
    // and nothing else — an earlier version skipped the whole stage on a hit, which meant a warm
    // cache produced a WORSE brief than a cold one at the very thing this stage exists for.
    //
    // A SEEDED entry would not be the same kind of hit: it would be translated from server memory
    // rather than derived by a run that actually read this repo, so it must not outrank what THIS
    // run is about to work out for itself. Seeding an entry that then silently won every render
    // forever would make a warm cache produce a worse brief than a cold one — exactly what RUN-144
    // already fixed once. So only a LEARNED entry blocks the write below and wins the render.
    //
    // **Nothing writes `'seeded'` today** (RUN-233): the only candidate source was a verified
    // context pack, and it has no honest target here — its verified facts are the PATHS a memory
    // cited, which are not entry points, are already rendered to the agent by `memory-render.ts`
    // with their statements and verdicts, and would land under this block's own "what earlier runs
    // worked out" header. A cache exists to avoid re-paying for expensive local derivation; a pack
    // is one bounded call every run makes anyway. So the origin rule below is a GUARD for a future
    // writer, not a description of live behaviour — with no seeder, `learned` is always true for an
    // existing entry and this method behaves exactly as it did before RUN-233.
    const entry = await intel?.getEntry(prepared.repo.root, prepared.worktree.baseId).catch(() => null);
    const cached = entry?.facts ?? null;
    const learned = entry?.origin === 'learned';
    if (entry) {
      // A seeded entry's line must not claim a run worked it out, since no run would have. Paired
      // with the origin rule above, and unreachable until something writes a seed.
      this.transcript(run.id).milestone(
        learned
          ? 'reused what an earlier run worked out about this repo'
          : "started from what Noriq's memory already says about this repo — nothing has read it yet",
      );
    }

    const reservation = prepared.tally.reserve();
    if (!reservation.ok) {
      this.log.warn('no budget left to map this repo’s patterns', {
        runId: run.id,
        breach: reservation.breach,
      });
      return '';
    }
    if (this.deps.steering?.isCancelled?.(run.id)) return renderRepoFacts(cached);
    // Shared by the first attempt and the answered re-run (RUN-190): cache the facts on a MISS —
    // now meaning "no LEARNED entry" rather than "no entry at all" (RUN-233), so this run's own
    // derived facts still replace a seed — render analogs + facts either way, preferring what this
    // run just derived over a seed it was entitled to replace.
    const finish = async (m: NonNullable<Awaited<ReturnType<typeof mapPatterns>>>): Promise<string> => {
      const derived = !learned && hasFacts(m.facts);
      if (intel && derived) {
        await intel
          .put(prepared.repo.root, prepared.worktree.baseId, m.facts)
          .catch((err: unknown) =>
            this.log.warn('could not cache what this run learned', { err: String(err) }),
          );
      }
      return `${renderAnalogs(m.analogs)}${renderRepoFacts(derived ? m.facts : cached)}`;
    };

    // The mapper's own coordinate (RUN-193): `[stages.pattern-map] agent` on top of the prepared
    // coordinate. Resolved once and reused across the answered re-run below.
    const mapAgent = this.resolveStageAgent(
      stageCoordinate(prepared.workflow, 'pattern-map', this.log),
      prepared,
      run.id,
      'pattern-map',
    );
    const map = await mapPatterns(this.patternMapHost(prepared.tally), {
      run,
      driver: mapAgent.driver,
      checked,
      prompt: prepared.mapperPrompt(checked),
      start: {
        ...withStageModel(prepared.start, mapAgent),
        permission: plannerPermission(prepared.permission),
        // The escalation pair, like the planner (see that site for the whole argument).
        noriqMcp: prepared.noriqMcp,
        noriqTools: STAGE_NORIQ_TOOLS,
        ...(reservation.budget ? { budget: plannerBudget(reservation.budget) } : {}),
        spendGuard: prepared.tally.guard('pattern-map'),
        clockGuard: prepared.tally.clockGuard(),
      },
    });
    // No map may mean the MAPPER PAUSED the run (RUN-190): every answered ask re-runs it with the
    // Q&A appended — uncapped, the human being the rate limiter — and a mapper that produces
    // nothing WITHOUT being parked degrades to the cached facts, exactly as before.
    let current = map;
    let answerBlock = '';
    while (!current) {
      const answered = await this.parkStage({
        run,
        worktree: prepared.worktree,
        runAgent: prepared.runAgent,
        tally: prepared.tally,
        stage: 'pattern-map',
        tail: '',
      });
      if (!answered) return renderRepoFacts(cached);
      answerBlock += renderPrompt('stage-answer', answered);
      current = await mapPatterns(this.patternMapHost(prepared.tally), {
        run,
        driver: mapAgent.driver,
        checked,
        prompt: `${prepared.mapperPrompt(checked)}${answerBlock}`,
        start: {
          ...withStageModel(prepared.start, mapAgent),
          permission: plannerPermission(prepared.permission),
          noriqMcp: prepared.noriqMcp,
          noriqTools: STAGE_NORIQ_TOOLS,
          ...(reservation.budget ? { budget: plannerBudget(reservation.budget) } : {}),
          spendGuard: prepared.tally.guard('pattern-map'),
          clockGuard: prepared.tally.clockGuard(),
        },
      });
    }

    // The facts outlive this run; the analogs do not (see `finish`).
    return finish(current);
  }

  private patternMapHost(tally: RunTally): PatternMapHost {
    return {
      log: this.log,
      report: (runId, frame) => this.deps.report(runId, frame),
      transcript: (runId) => this.transcript(runId),
      startAgent: (driver, opts) => this.startAgent(driver, opts),
      ...(this.deps.steering
        ? {
            steering: {
              register: (runId: string, session: DriverSession, stop: () => Promise<void>) =>
                this.deps.steering?.register(runId, session, stop),
              unregister: (runId: string) => this.deps.steering?.unregister(runId),
            },
          }
        : {}),
      record: (slot, exit) => tally.record(slot, exit.telemetry),
      charge: (seconds) => tally.chargeTime(seconds),
    };
  }

  /**
   * The plan-checker loop (RUN-141), when the repo asked for one.
   *
   * Gated on `[verify.agent]` — the same section that opts a repo into the diff reviewer, and for
   * the same reason: a repo that wants an independent judgement on its WORK is the one that wants
   * an independent judgement on its PLAN, and a second knob would be two ways to say one thing.
   * `maxRounds` bounds the revisions exactly as it bounds the builder's fix turns.
   */
  private async checkPlanIfConfigured(
    run: Run,
    prepared: PreparedRun,
    planned: PlannedRun,
  ): Promise<{ checked: CheckedExecutionSpec; findings: string }> {
    const reviewer = prepared.repo.manifest.verify?.agent;
    if (!reviewer) return { checked: planned.checked, findings: '' };

    // The plan-checker's own coordinate (RUN-193): `[stages.plan-check] agent` — a key that selects
    // this actor's model without being a pipeline stage — on top of the prepared coordinate.
    const checkAgent = this.resolveStageAgent(
      stageCoordinate(prepared.workflow, 'plan-check', this.log),
      prepared,
      run.id,
      'plan-check',
    );
    // One answered re-run (RUN-190): a checker that paused the run gets the answer appended and a
    // fresh look; a second pause stands as an unjudged plan, which never gates anyway.
    let answerBlock = '';
    for (;;) {
      const result = await checkPlan(this.planCheckHost(planned, prepared.tally, planned.envelope), {
        run,
        driver: checkAgent.driver,
        checked: planned.checked,
        maxRounds: reviewer.maxRounds,
        prompt: (spec, ledger) => `${prepared.checkerPrompt(spec, ledger)}${answerBlock}`,
        start: {
          ...withStageModel(prepared.start, checkAgent),
          // Same narrowing as the planner's, and for the same two reasons: `auto` survives the write
          // clamp, and a filesystem clamp says nothing about the control plane. A checker emits a
          // report and nothing else — plus, now, the escalation pair (see the planner site).
          permission: plannerPermission(prepared.permission),
          noriqMcp: prepared.noriqMcp,
          noriqTools: STAGE_NORIQ_TOOLS,
        },
      });
      const answered = await this.parkStage({
        run,
        worktree: prepared.worktree,
        runAgent: prepared.runAgent,
        tally: prepared.tally,
        stage: 'plan-check',
        tail: '',
      });
      if (!answered) return { checked: result.checked, findings: result.findings };
      answerBlock += renderPrompt('stage-answer', answered);
    }
  }

  /**
   * The checker's host. One PLANNING ENVELOPE is shared by the planner and every checker round —
   * `plannerBudget` applied per round would compound (a quarter of a shrinking remainder, six
   * times, is most of the run), and the documented policy is that planning takes a quarter, not
   * that each planning SESSION does.
   *
   * No steering: registering a checker under the run id would overwrite the planner's entry, and
   * the checker's own cleanup would then leave nothing registered — so a cancel arriving during a
   * revision would find no target at all. The planner stays registered for the whole loop, which
   * is the session that actually outlives it.
   */
  private planCheckHost(planned: PlannedRun, tally: RunTally, envelope: RunBudget | null): PlanCheckHost {
    // What the whole planning phase may still spend, tracked here because the tally is the RUN's
    // ledger and knows nothing about phases.
    let spentInPhase = zeroTelemetry();
    let secondsInPhase = 0;
    return {
      log: this.log,
      report: (runId, frame) => this.deps.report(runId, frame),
      transcript: (runId) => this.transcript(runId),
      startAgent: (driver, opts) => this.startAgent(driver, opts),
      revise: (feedback) => planned.revise(feedback),
      reserve: () => {
        // Two ceilings, and the tighter wins: what the RUN has left (so the builder is not starved
        // by an over-eager loop) and what the PLANNING PHASE has left (so the loop cannot take a
        // fresh quarter each round).
        const run = tally.reserve();
        if (!run.ok) return { ok: false, breach: run.breach };
        const phase = reserveFromRun(envelope, { telemetry: spentInPhase, activeSeconds: secondsInPhase });
        if (!phase.ok) return { ok: false, breach: phase.breach };
        const tightest = tighter(run.budget, phase.budget);
        return { ok: true, ...(tightest ? { budget: tightest } : {}) };
      },
      guards: (slot) => ({
        spendGuard: tally.guard(slot),
        clockGuard: tally.clockGuard(),
      }),
      record: (slot, exit) => {
        tally.record(slot, exit.telemetry);
        spentInPhase = sumTelemetry(spentInPhase, exit.telemetry);
      },
      charge: (seconds) => {
        tally.chargeTime(seconds);
        secondsInPhase += Math.max(0, seconds);
      },
    };
  }

  private planHost(): PlanHost {
    return {
      log: this.log,
      report: (runId, frame) => this.deps.report(runId, frame),
      transcript: (runId) => this.transcript(runId),
      startAgent: (driver, opts) => this.startAgent(driver, opts),
      // The planner is a live session like any other: cancellable, and stopped by shutdown. It
      // used to be outside this, so `run.cancel` during planning found no target and answered
      // false while the planner — and then the build — carried on.
      ...(this.deps.steering
        ? {
            steering: {
              register: (runId: string, session: DriverSession, stop: () => Promise<void>) =>
                this.deps.steering?.register(runId, session, stop),
              unregister: (runId: string) => this.deps.steering?.unregister(runId),
            },
          }
        : {}),
      checkSpec: (spec, root) =>
        checkExecutionSpec(spec, root, {
          ...(this.deps.specPathProbe ? { probe: this.deps.specPathProbe } : {}),
          produces: true,
        }),
      ...(this.deps.saveExecutionSpec ? { saveSpec: this.deps.saveExecutionSpec } : {}),
    };
  }

  /**
   * The surface `prepare` reaches — see `stageHost` for why this is closures, not `this`.
   *
   * Every optional dep is re-wrapped in an arrow rather than copied by reference, and that is not
   * ceremony: `this.deps.checkClaimable(id)` calls with `deps` as the receiver, and handing the bare
   * function over would silently call it with the HOST as the receiver instead. A dep written as a
   * method (`checkClaimable() { return this.client... }`) satisfies the declared type and would
   * start throwing — which the claimability probe swallows as a transient failure and fails OPEN,
   * spawning a run the phase gate meant to decline. The daemon passes arrows today; the contract is
   * public, so it must not depend on that.
   */
  private prepareHost(): PrepareHost {
    return {
      log: this.log,
      report: (runId, frame) => this.deps.report(runId, frame),
      postComment: (projectId, taskId, body) => this.deps.postComment?.(projectId, taskId, body),
      transcript: (runId) => this.transcript(runId),
      server: this.deps.server,
      resolveRepo: (repoRef) => this.deps.resolveRepo(repoRef),
      driverFor: (tool) => this.deps.drivers[tool as AgentTool],
      vcsFor: (repo) => this.vcsFor(repo),
      ...(this.deps.checkClaimable
        ? { checkClaimable: (taskId: string) => this.deps.checkClaimable!(taskId) }
        : {}),
      planBase: (repo, run) => this.planBase(repo, run),
      ...(this.deps.createRunAgent
        ? {
            createRunAgent: (runId: string, opts: { label?: string; allowedTools?: string[] }) =>
              this.deps.createRunAgent!(runId, opts),
          }
        : {}),
      resolveAnchorTask: (taskId) => this.resolveAnchorTask(taskId),
      ...(this.deps.resolveLockScope
        ? {
            resolveLockScope: (run: Run, spec: ExecutionSpec | null) =>
              this.deps.resolveLockScope!(run, spec),
          }
        : {}),
      lockScopeBranch: (repo, run) => this.lockScopeBranch(repo, run),
      // Mechanical workspace bootstrap (RUN-202), over the SAME exec seam verify uses — so it
      // inherits the sanitized env, the process-group kill and the output cap, and a test that
      // injects `verifyExec` fakes both without touching a shell.
      runSetup: (spec, cwd) =>
        runSetup(
          spec,
          cwd,
          this.deps.verifyExec ?? defaultExec,
          {
            info: (m, d) => this.log.info(m, d as Record<string, unknown>),
            warn: (m, d) => this.log.warn(m, d as Record<string, unknown>),
          },
          this.deps.setupMarkerDir,
        ),
      lockEnforcerFor: (repo, run, worktree, kind, token) =>
        this.lockEnforcerFor(repo, run, worktree, kind, token),
      runBudget: (run) => mergeBudget(run.budget, this.deps.defaultBudget) ?? null,
      ...(this.deps.getContextPack ? { getContextPack: this.deps.getContextPack } : {}),
      ...(this.deps.reportVerification
        ? {
            reportVerification: (runId: string, agentToken: string, report: VerificationReportWire) =>
              this.deps.reportVerification!(runId, agentToken, report),
          }
        : {}),
      context: {
        ...(this.deps.pathProbe ? { probe: this.deps.pathProbe } : {}),
        ...(this.deps.specPathProbe ? { specProbe: this.deps.specPathProbe } : {}),
        ...(this.deps.readDoc ? { read: this.deps.readDoc } : {}),
        ...(this.deps.contextBudget !== undefined ? { budget: this.deps.contextBudget } : {}),
      },
      ...(this.deps.continuable ? { continuable: this.deps.continuable } : {}),
    };
  }

  /** The surface `execute` reaches. `startAgent` is here — and nowhere wider — because it is the
   *  one place the sanitized child env is applied (RUN-109). */
  private executeHost(): ExecuteHost {
    return {
      log: this.log,
      report: (runId, frame) => this.deps.report(runId, frame),
      transcript: (runId) => this.transcript(runId),
      startAgent: (driver, opts) => this.startAgent(driver, opts),
      ...(this.deps.steering ? { steering: this.deps.steering } : {}),
      parkIfBlocked: (ctx) => this.parkIfBlocked(ctx),
    };
  }

  /**
   * The pipeline AFTER the agent stops talking: commit → land → verify → report → reap.
   *
   * Its own method because a parked run re-enters here (RUN-30). `supervise` runs it once for a
   * run that finished in one sitting; `resume` runs it for one that stopped to ask a question and
   * came back — possibly days later, in a different daemon process. Both must gate identically:
   * a run that asked for help is not a run that gets to skip the gate.
   */
  private async afterDriver(ctx: {
    run: Run;
    repo: ResolvedRepo;
    worktree: Workspace;
    driver: AgentDriver;
    permission: PermissionProfile;
    noriqMcp?: NoriqMcp;
    task: AnchorTask | null;
    runAgent: RunAgent;
    session: DriverSession;
    stopSession: () => Promise<void>;
    exit: DriverExit;
    /** The run's cross-session spend tally (RUN-59) — the reviewer and conflict-resolver sessions
     *  this method spawns record into it, and the terminal report is its total. */
    tally: RunTally;
    verifyText: string;
    /** Live accessor for the session's accumulated output — NOT the `verifyText` snapshot, which
     *  froze when the driver's first turn ended. reviewWithFeedback reads it around each fix turn
     *  to capture the builder's structured response block (RUN-79). */
    getSessionText?: () => string;
    tail: string;
    /** The prior sitting's continuation state on a "continue a failed run" (RUN-92): its ledger
     *  seeds the reviewer, and it decides whether the terminal record is refreshed or dropped. */
    continued?: ContinuableRun | null;
    /** The spec this run was actually briefed with — prepare's, or the one the `plan` stage
     *  synthesized (RUN-145). What the gate answers its acceptance criteria against. */
    executedSpec?: CheckedExecutionSpec | null;
    /** RUN-228's retrieval, carried from `PreparedRun.contextPack` — absent on the `resume` call
     *  site, which has no `prepare` and therefore never fetched one (RunPipeline's own doc). */
    contextPack?: ContextPackRetrieval;
    /** RUN-229's verdicts over that retrieval, carried from `PreparedRun.verifiedContextPack` —
     *  same absence rule as `contextPack` above, for the same reason. */
    verifiedContextPack?: VerifiedContextPack | null;
    /** RUN-247: captured at the render point (`stages/brief.ts`), carried from
     *  `PreparedRun.contextConsumption` on a fresh dispatch, or from a resumed brief rebuild's own
     *  return — absent whenever neither happened this sitting. */
    contextConsumption?: IntelligenceContextConsumptionMetric | null;
    /** The wall-clock moment `execute` observed just before spawning (RUN-261), threaded through
     *  because the pipeline this becomes a field of does not exist until this method builds it.
     *  Absent iff no session ever spawned this sitting (`sessionlessChainExit`). */
    agentStartedAt?: string;
  }): Promise<DriverExit> {
    const { run, repo, worktree, driver, permission, task, runAgent, tally, verifyText, tail } = ctx;
    const continued = ctx.continued ?? null;
    // The run's workflow (RUN-117), the NAMED one when the repo defines it (RUN-132) — same
    // posture either way; what the named one adds is its declared stage list.
    const wf = runWorkflow(run, repo.workflowCatalog ?? repo.manifest);

    // The pipeline as an explicit SEQUENCE (RUN-131). What used to be ~390 lines of gates in one
    // method is now `stagesFor(wf)` — a declared, ordered list this loop walks, so the two flag
    // tests that used to be repeated in every gate (`wf.produces`, `wf.verifyActor`) are stated
    // once, where the sequence is. Which stages come back is `(mandatory ∪ the workflow's
    // declaration) ∩ appliesTo` (RUN-132): the workflow chooses among the optional ones, and the
    // machine decides what may be chosen and in what order.
    const pipeline: RunPipeline = {
      run,
      repo,
      worktree,
      driver,
      permission,
      ...(ctx.noriqMcp ? { noriqMcp: ctx.noriqMcp } : {}),
      task,
      runAgent,
      session: ctx.session,
      stopSession: ctx.stopSession,
      tally,
      sessionText: verifyText,
      ...(ctx.getSessionText ? { getSessionText: ctx.getSessionText } : {}),
      tail,
      continued,
      workflow: wf,
      // Enumerated ONCE, here, so the checklist the gate is shown and the numbers it answers with
      // are the same list — computing it at each use would let a renumbering slip between them
      // and silently repoint every answer (RUN-145).
      acceptance: enumerateAcceptance(ctx.executedSpec?.spec),
      acceptanceOverflow: acceptanceOverflow(ctx.executedSpec?.spec),
      requirements: ctx.executedSpec?.spec.requirementIds ?? [],
      ...(ctx.contextPack ? { contextPack: ctx.contextPack } : {}),
      ...(ctx.verifiedContextPack !== undefined ? { verifiedContextPack: ctx.verifiedContextPack } : {}),
      ...(ctx.contextConsumption ? { contextConsumption: ctx.contextConsumption } : {}),
      ...(ctx.agentStartedAt ? { agentStartedAt: ctx.agentStartedAt } : {}),
      exit: ctx.exit,
      // Whether the DRIVER succeeded — drives worktree retention (a build with a diff is kept for
      // the human even if verify then fails).
      driverSucceeded: ctx.exit.outcome === 'done',
      // Whether the diff reached the integration branch. Once it has, the run's worktree and
      // throwaway branch are disposable — that is what stops them accumulating.
      landed: false,
      // The ledger carried into the terminal continuable record (RUN-92): the reviewer's final one
      // when it runs, else whatever a prior sitting left — a pre-review failure adds nothing.
      ledger: continued?.ledger ?? [],
      // Decided by `verify`, once, at the point the pipeline always decided it.
      landPolicy: null,
      // Appended to by `verify`/`review`/`integrate` as each reaches its own deterministic command
      // (RUN-225) — empty by construction, not a guess, for a sitting that never reaches one.
      commandObservations: [],
    };

    const host = this.stageHost();
    for (const s of stagesFor(wf)) {
      const impl = POST_DRIVER_STAGES[s.name];
      if (impl) await impl(host, pipeline);
    }
    return pipeline.exit;
  }
}

/**
 * The stages this method runs. `prepare` and `execute` are absent by construction, not by omission:
 * they happen BEFORE the pipeline object exists — they are what BUILDS it — so they take a run and
 * return one rather than narrowing a context they were handed, and `supervise` calls them directly.
 * A stage with no entry here is simply not part of the post-driver walk.
 */
const POST_DRIVER_STAGES: Partial<Record<StageName, StageImpl>> = {
  verify: verifyStage,
  review: reviewStage,
  integrate: integrateStage,
  settle: settleStage,
};

/**
 * A chain failure with no session behind it, shaped to enter the post-driver walk (RUN-170).
 *
 * `executeChain` can fail before ANY session exists — a cancel that lands ahead of the first spawn
 * (RUN-165), a wave whose every member failed to lease, a parked step gone from its recomputed
 * plan (RUN-168). Returning those through `fail()` skipped `settle`, and settle is not optional
 * there: prepare has already leased the workspace, taken the locks and opened the transcript, a
 * cancel has written the record only settle forgets, and a failed wave can have landed children's
 * work onto the parent's branch — work the dispose decision must see, or it is force-deleted work
 * that exists nowhere else. The inert session is never exercised: every stage that would touch it
 * gates on `driverSucceeded` / `exit.outcome === 'done'`, which this exit fails by construction,
 * so the walk reduces to the one stage that runs no matter how the run got here.
 */
function sessionlessChainExit(run: Run, reason: string): ExecuteOutcome {
  const exit: DriverExit = { outcome: 'failed', isError: true, reason, telemetry: zeroTelemetry() };
  return {
    exit,
    session: {
      runId: run.id,
      // There is no live input to deliver into; `false` is the contract's honest "turn NOT
      // delivered" (drivers/types.ts), which is what keeps steering's fallback path working.
      pushInput: () => false,
      interrupt: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      done: () => Promise.resolve(exit),
    },
    stopSession: () => Promise.resolve(),
    sessionText: '',
    getSessionText: () => '',
    tail: '',
  };
}

/** One line per reviewer look, in the transcript's system voice (RUN-74). */
function reviewVerdictMilestone(v: VerifyVerdict, round: number): string {
  if (v.passed) return `reviewer verdict: PASS (round ${round})`;
  if (v.verdict === 'fail')
    return v.escalation
      ? `reviewer verdict: FAIL (round ${round}) — escalated STRUCTURAL, the daemon stops the fix rounds`
      : `reviewer verdict: FAIL (round ${round})`;
  return `reviewer rendered NO verdict (round ${round}) — stopped, crashed, or wrote no VERDICT line`;
}
