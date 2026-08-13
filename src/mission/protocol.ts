/**
 * Durable, model-free protocol for one Runner mission.
 *
 * Agents propose a small subset of these actions. The harness supplies observations such as
 * child start/exit, VCS checkpoints, and cleanup results. The kernel is the only component that
 * turns an action into facts, and the store commits those facts as one revision.
 */

export interface MissionBudget {
  /** Null means this mission is not bounded on that axis. */
  tokens: number | null;
  /** Null means this mission is not bounded on that axis. */
  usd: number | null;
  /** Null means this mission is not bounded on that axis. */
  activeSeconds: number | null;
}

export interface MissionUsage {
  /** Null means the vendor did not report a cumulative token count. It never means zero. */
  tokens: number | null;
  /** Null means the vendor did not report cost. It never means zero. */
  usd: number | null;
  /** Null means elapsed active time could not be recovered after a process loss. */
  activeSeconds: number | null;
}

export interface MissionObjective {
  brief: string;
  taskId?: string;
  runId?: string;
  repositoryKey?: string;
  baseRevision?: string;
}

export interface MissionCompletionPolicy {
  /** A successful mission must name the exact VCS checkpoint containing the accepted work. */
  requireCheckpoint: boolean;
  /** A successful mission must have a passing review of that exact checkpoint. */
  requireReview: boolean;
}

/** Immutable, machine-owned deterministic validation authority for one mission. */
export type MissionValidationPolicy =
  | {
      kind: 'command';
      policyId: string;
      command: string;
      timeoutSeconds: number;
      shell: string | null;
    }
  | {
      kind: 'none';
      policyId: string;
      /** Explicit trusted explanation; omission is never interpreted as no validation. */
      reason: string;
    };

export interface MissionAgentSelection {
  /** Driver/provider id from the local, allow-listed execution profile. */
  driver: string;
  /** Exact provider model id from trusted local configuration; vendor defaults are forbidden. */
  model: string;
  effort?: MissionEffort;
}

export type MissionEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type MissionRunKind = 'scope' | 'build' | 'verify';
export type MissionLineageRole = 'planner' | 'worker' | 'reviewer' | 'verifier' | 'repair' | 'system';

/** Exact driver permission posture from a trusted local profile. */
export interface MissionDriverPermission {
  write: boolean;
  allow: readonly string[];
  deny: readonly string[];
  auto: boolean;
}

export interface MissionDriverPosture {
  kind: MissionRunKind;
  permission: MissionDriverPermission;
  /** Trusted reporting vocabulary; never derived from the guide's free-form instruction. */
  lineageRole: MissionLineageRole;
}

export interface MissionProjectMcpGrant {
  /** Project-declared server name. */
  server: string;
  /** Exact tool names granted by the trusted local execution profile. */
  tools: readonly string[];
}

/**
 * Trusted, vendor-neutral review assurance declared by the local catalogue owner. Runner never
 * guesses model quality from a model name or effort label. A reviewer is stronger and independent
 * only when its rank is greater, its independence class differs, and its exact driver/model
 * coordinate differs from the subject profile.
 */
export interface MissionReviewAssurance {
  rank: number;
  independenceClass: string;
}

/**
 * Authority-bearing child posture, snapshotted when the mission is created. The guide may select
 * a profile id; it cannot manufacture or widen any of these fields.
 */
export interface MissionExecutionProfile {
  profileId: string;
  role: string;
  permission: 'read' | 'write';
  agent: MissionAgentSelection;
  assurance: MissionReviewAssurance;
  driverPosture: MissionDriverPosture;
  budget: MissionBudget;
  resources: Readonly<Record<string, number>>;
  projectMcp: readonly MissionProjectMcpGrant[];
}

export interface MissionGuideProfile {
  profileId: string;
  agent: MissionAgentSelection;
  budget: MissionBudget;
  /** Durable bound across restarts, in addition to the per-turn budget above. */
  turnLimit: number;
}

export const MAX_MISSION_GUIDE_TURNS = 256;
export const MAX_MISSION_CHILDREN = 256;
export const MAX_MISSION_OBJECTIVE_CHARS = 64_000;
export const MAX_MISSION_CHILD_INSTRUCTION_CHARS = 32_000;
export const MAX_MISSION_PLAN_STEPS = 32;
/** Deterministic scheduler ceiling: initial work plus at most two reviewed repair attempts. */
export const MAX_MISSION_PLAN_REPAIR_ROUNDS = 2;
export const MAX_MISSION_PLAN_SUMMARY_CHARS = 8_000;
export const MAX_MISSION_PLAN_INSTRUCTION_CHARS = 4_000;
export const MAX_MISSION_PLAN_ACCEPTANCE_ITEMS = 16;
export const MAX_MISSION_PLAN_ACCEPTANCE_CHARS = 512;
/**
 * One review must fit intact into a deterministic repair attempt. A larger durable artifact would
 * force the scheduler either to hide a model-authored tail or to buy another summarization turn.
 */
export const MAX_MISSION_REVIEW_SUMMARY_CHARS = 12_000;
/** Bounded combined stdout/stderr tail retained as deterministic validation evidence. */
export const MAX_MISSION_VALIDATION_OUTPUT_BYTES = 16 * 1024;
/** Keeps semantic plan approval inside one bounded guide projection and prompt. */
export const MAX_MISSION_EXECUTION_PLAN_BYTES = 48 * 1024;
/** Leaves headroom for the complete-child envelope beneath the 1 MiB action ceiling. */
export const MAX_MISSION_CHILD_ARTIFACT_BYTES = 768 * 1024;

export interface MissionChildSpec {
  childId: string;
  /** A semantic role, not a provider- or project-specific worker type. */
  role: string;
  instruction: string;
  permission: 'read' | 'write';
  agent: MissionAgentSelection;
  driverPosture: MissionDriverPosture;
  /** Id of the immutable mission profile from which authority was resolved. */
  profileId: string;
  /** Maximum budget held for this child until it reaches a terminal state. */
  budget: MissionBudget;
  /** Opaque, project-neutral capacities such as `editor-session: 1`. */
  resources: Readonly<Record<string, number>>;
  /** Exact per-server grants resolved by Runner, never chosen freely by the guide model. */
  projectMcp: readonly MissionProjectMcpGrant[];
  /** Exact immutable checkpoint this child was commissioned to inspect, when applicable. */
  subjectCheckpointId?: string | null;
  /**
   * Kernel-derived identity for one step of one adopted planner artifact. This is deliberately
   * opaque: the planner-authored step id alone is not unique across replacement plans.
   */
  planStepId?: string | null;
}

export type MissionChildOutcome = 'succeeded' | 'failed' | 'cancelled' | 'lost';
export type MissionOutcome = 'succeeded' | 'failed' | 'cancelled';
export type MissionReviewVerdict = 'passed' | 'changes-requested';
export type MissionFindingSeverity = 'none' | 'low' | 'medium' | 'high' | 'critical';
export type MissionBudgetAxis = keyof MissionBudget;
export type MissionBudgetConstraintReason = 'exceeded' | 'unknown';

/** Machine-validated evidence emitted by an authorized review child. */
export interface MissionReviewArtifact {
  type: 'review';
  checkpointId: string;
  revisionId: string;
  verdict: MissionReviewVerdict;
  highestSeverity: MissionFindingSeverity;
  summary: string;
}

export interface MissionExecutionPlanStep {
  id: string;
  title: string;
  /** Trusted execution profile selected from the mission snapshot. */
  profileId: string;
  /** Optional trusted verify profile. When present, the scheduler reviews the step checkpoint. */
  reviewProfileId?: string;
  instruction: string;
  acceptance: readonly string[];
}

/** Ordered sequential plan produced by an authorized planner child. */
export interface MissionExecutionPlanArtifact {
  type: 'execution-plan';
  summary: string;
  steps: readonly MissionExecutionPlanStep[];
}

export type MissionChildArtifact = MissionReviewArtifact | MissionExecutionPlanArtifact;

export interface CreateMissionAction {
  type: 'create-mission';
  objective?: MissionObjective;
  /**
   * Exact portable project MCP declaration trusted for this mission. Required when any profile
   * grants project tools; a runtime bundle with a different fingerprint must be refused.
   */
  projectMcpDeclarationFingerprint: string | null;
  budget: MissionBudget;
  resources: Readonly<Record<string, number>>;
  guide: MissionGuideProfile;
  profiles: readonly MissionExecutionProfile[];
  validationPolicy: MissionValidationPolicy;
  completion?: MissionCompletionPolicy;
  /** Durable work that remains after logical terminalization (workspace removal, lease release). */
  cleanup?: readonly string[];
}

/** Durable metering boundary committed before a guide model receives a projection. */
export interface BeginGuideTurnAction {
  type: 'begin-guide-turn';
  guideEpoch: number;
  turnId: string;
}

/** Absolute result for one guide invocation, including malformed/refused output. */
export interface CompleteGuideTurnAction {
  type: 'complete-guide-turn';
  turnId: string;
  outcome: 'proposed' | 'failed' | 'cancelled' | 'lost';
  summary: string;
  usage: MissionUsage;
  /** Exact authority-resolved proposal. Present only when outcome is `proposed`. */
  proposal: MissionGuideProposal | null;
}

/**
 * Atomically consume a durable guide proposal and apply its already-resolved kernel action. This
 * closes the restart window between "proposal metered" and "proposal took effect".
 */
export interface ApplyGuideProposalAction {
  type: 'apply-guide-proposal';
  turnId: string;
}

export interface AdoptExecutionPlanAction {
  type: 'adopt-execution-plan';
  guideEpoch: number;
  plannerChildId: string;
  /** Exact canonical artifact the guide saw and approved. */
  planFingerprint: string;
}

/** An action emitted by the guide. `guideEpoch` prevents reuse of an older guide projection. */
export interface SpawnChildAction extends MissionChildSpec {
  type: 'spawn-child';
  guideEpoch: number;
}

/**
 * Durable ownership of a deterministic child attempt. The executor may start or reattach only
 * after this commits, and must make `attemptId` idempotent across process restarts.
 */
export interface StartChildAction {
  type: 'start-child';
  childId: string;
  attemptId: string;
  sessionId?: string | null;
}

/** Absolute cumulative high-water values for one child, never deltas. */
export interface ObserveChildUsageAction {
  type: 'observe-child-usage';
  childId: string;
  usage: MissionUsage;
}

/** A guide request. The harness journals it before interrupting the child process. */
export interface RequestChildCancelAction {
  type: 'request-child-cancel';
  guideEpoch: number;
  childId: string;
  reason: string;
}

/** A harness observation. `summary` is bounded evidence, not an unbounded transcript. */
export interface CompleteChildAction {
  type: 'complete-child';
  childId: string;
  outcome: MissionChildOutcome;
  summary: string;
  usage: MissionUsage;
  artifact?: MissionChildArtifact;
}

/** VCS truth recorded by the harness after inspecting the child workspace. */
export interface RecordCheckpointAction {
  type: 'record-checkpoint';
  checkpointId: string;
  /** Exact immutable backend revision or content digest observed after checkpointing. */
  revisionId: string;
  /** The successful write child that produced it; null means a harness-observed baseline. */
  authorChildId: string | null;
  /**
   * Whether this checkpoint advances its exact parent revision. Optional only for replaying v1
   * journals, where omission means true. New evidence adapters must always provide it.
   */
  changed?: boolean;
  parentCheckpointId?: string | null;
  clean: boolean;
  description?: string;
}

export type MissionWorkspaceReconciliationDisposition = 'restored' | 'quarantined';

/**
 * Harness-only proof that mutations left by one terminal write child can no longer contaminate
 * later work. The guide cannot propose this action: only the trusted workspace/VCS adapter may
 * attest the clean exact revision and whether residue was restored or quarantined.
 */
export interface RecordWorkspaceReconciledAction {
  type: 'record-workspace-reconciled';
  childId: string;
  revisionId: string;
  disposition: MissionWorkspaceReconciliationDisposition;
  summary: string;
}

/** A bounded request that parks useful progress instead of letting the guide guess. */
export interface RaiseQuestionAction {
  type: 'raise-question';
  guideEpoch: number;
  questionId: string;
  prompt: string;
}

/** A harness/Noriq observation; the answer is evidence in the next guide projection. */
export interface AnswerQuestionAction {
  type: 'answer-question';
  questionId: string;
  answer: string;
}

/** Invalidate an in-flight guide response after its process/session must be replaced. */
export interface ReplaceGuideAction {
  type: 'replace-guide';
  guideEpoch: number;
  reason: string;
}

/** Review evidence is permanently tied to the exact checkpoint the reviewer saw. */
export interface RecordReviewAction {
  type: 'record-review';
  reviewId: string;
  /** The independently spawned, read-only child whose bounded result produced this verdict. */
  reviewerChildId: string;
  checkpointId: string;
  /** Must exactly equal the checkpoint's immutable revision identity. */
  revisionId: string;
  verdict: MissionReviewVerdict;
  highestSeverity: MissionFindingSeverity;
  summary: string;
}

export type MissionValidationDisposition = 'passed' | 'failed' | 'not-applicable';

/** Durable authority committed before a validation process may start or be recovered. */
export interface BeginValidationAction {
  type: 'begin-validation';
  validationId: string;
  checkpointId: string;
  revisionId: string;
  policyId: string;
}

/** Harness-only deterministic validation evidence, bound to immutable mission authority. */
export interface RecordValidationAction {
  type: 'record-validation';
  validationId: string;
  checkpointId: string | null;
  revisionId: string | null;
  policyId: string;
  disposition: MissionValidationDisposition;
  exitCode: number | null;
  timedOut: boolean;
  /** True only when the trusted validator quarantined Git-visible mutations before restoring. */
  workspaceChanged: boolean;
  /** Bounded combined stdout/stderr tail. Empty output is valid. */
  outputTail: string;
}

/** A terminal action emitted by the guide. Success is accepted only when the policy is proved. */
export interface CompleteMissionAction {
  type: 'complete-mission';
  guideEpoch: number;
  outcome: MissionOutcome;
  reason: string;
  checkpointId?: string | null;
}

export type MissionGuideProposal =
  | SpawnChildAction
  | AdoptExecutionPlanAction
  | RequestChildCancelAction
  | RaiseQuestionAction
  | CompleteMissionAction;

export interface CompleteCleanupAction {
  type: 'complete-cleanup';
  cleanupId: string;
}

export interface FailCleanupAction {
  type: 'fail-cleanup';
  cleanupId: string;
  error: string;
}

/** Post-cleanup proof that accepted work remains named by a backend-owned durable reference. */
export interface RecordAcceptedRevisionHandoffAction {
  type: 'record-accepted-revision-handoff';
  backend: string;
  repositoryKey: string;
  checkpointId: string;
  revisionId: string;
  reference: string;
  status: 'preserved';
}

export type MissionAction =
  | CreateMissionAction
  | BeginGuideTurnAction
  | CompleteGuideTurnAction
  | ApplyGuideProposalAction
  | AdoptExecutionPlanAction
  | SpawnChildAction
  | StartChildAction
  | ObserveChildUsageAction
  | RequestChildCancelAction
  | CompleteChildAction
  | RecordCheckpointAction
  | RecordWorkspaceReconciledAction
  | RecordReviewAction
  | BeginValidationAction
  | RecordValidationAction
  | RaiseQuestionAction
  | AnswerQuestionAction
  | ReplaceGuideAction
  | CompleteMissionAction
  | CompleteCleanupAction
  | FailCleanupAction
  | RecordAcceptedRevisionHandoffAction;

export interface MissionActionEnvelope {
  missionId: string;
  /** Optimistic revision observed by the caller. */
  expectedRevision: number;
  /** Stable across transport/process retries. */
  actionId: string;
  action: MissionAction;
}

export interface MissionCreatedEvent {
  type: 'mission-created';
  objective?: MissionObjective;
  projectMcpDeclarationFingerprint: string | null;
  budget: MissionBudget;
  resources: Readonly<Record<string, number>>;
  guide: MissionGuideProfile;
  profiles: readonly MissionExecutionProfile[];
  validationPolicy: MissionValidationPolicy;
  completion?: MissionCompletionPolicy;
  cleanup?: readonly string[];
}

export interface GuideTurnStartedEvent {
  type: 'guide-turn-started';
  turnId: string;
  guideEpoch: number;
  profileId: string;
  budget: MissionBudget;
}

export interface GuideTurnCompletedEvent {
  type: 'guide-turn-completed';
  turnId: string;
  outcome: 'proposed' | 'failed' | 'cancelled' | 'lost';
  summary: string;
  usage: MissionUsage;
  proposal: MissionGuideProposal | null;
}

export interface GuideProposalAppliedEvent {
  type: 'guide-proposal-applied';
  turnId: string;
}

export interface ExecutionPlanAdoptedEvent {
  type: 'execution-plan-adopted';
  plannerChildId: string;
  guideEpoch: number;
  planFingerprint: string;
  plan: MissionExecutionPlanArtifact;
}

export interface ChildReservedEvent {
  type: 'child-reserved';
  child: MissionChildSpec;
  guideEpoch: number;
}

export interface ChildStartedEvent {
  type: 'child-started';
  childId: string;
  attemptId: string;
  sessionId?: string | null;
}

export interface ChildUsageObservedEvent {
  type: 'child-usage-observed';
  childId: string;
  usage: MissionUsage;
}

export interface ChildCancelRequestedEvent {
  type: 'child-cancel-requested';
  childId: string;
  reason: string;
  guideEpoch: number;
}

export interface ChildCompletedEvent {
  type: 'child-completed';
  childId: string;
  outcome: MissionChildOutcome;
  summary: string;
  usage: MissionUsage;
  artifact?: MissionChildArtifact;
}

export interface CheckpointRecordedEvent {
  type: 'checkpoint-recorded';
  checkpointId: string;
  revisionId: string;
  authorChildId: string | null;
  /** Omitted by older journals; reducers interpret omission as true. */
  changed?: boolean;
  parentCheckpointId?: string | null;
  clean: boolean;
  description?: string;
}

export interface WorkspaceReconciledEvent {
  type: 'workspace-reconciled';
  childId: string;
  revisionId: string;
  disposition: MissionWorkspaceReconciliationDisposition;
  summary: string;
}

export interface ReviewRecordedEvent {
  type: 'review-recorded';
  reviewId: string;
  reviewerChildId: string;
  checkpointId: string;
  revisionId: string;
  verdict: MissionReviewVerdict;
  highestSeverity: MissionFindingSeverity;
  summary: string;
}

export interface ValidationRecordedEvent {
  type: 'validation-recorded';
  validationId: string;
  checkpointId: string | null;
  revisionId: string | null;
  policyId: string;
  disposition: MissionValidationDisposition;
  exitCode: number | null;
  timedOut: boolean;
  workspaceChanged: boolean;
  outputTail: string;
}

export interface ValidationStartedEvent {
  type: 'validation-started';
  validationId: string;
  checkpointId: string;
  revisionId: string;
  policyId: string;
}

export interface QuestionRaisedEvent {
  type: 'question-raised';
  questionId: string;
  prompt: string;
  guideEpoch: number;
}

export interface QuestionAnsweredEvent {
  type: 'question-answered';
  questionId: string;
  answer: string;
}

export interface GuideReplacedEvent {
  type: 'guide-replaced';
  previousGuideEpoch: number;
  guideEpoch: number;
  reason: string;
}

/** Durable evidence that a finite ceiling was exceeded or became impossible to prove. */
export interface BudgetConstraintTriggeredEvent {
  type: 'budget-constraint-triggered';
  constraintId: string;
  scope: 'mission' | 'child' | 'guide';
  childId?: string;
  turnId?: string;
  axis: MissionBudgetAxis;
  reason: MissionBudgetConstraintReason;
  observed: number | null;
  limit: number;
}

export interface MissionCompletedEvent {
  type: 'mission-completed';
  outcome: MissionOutcome;
  reason: string;
  checkpointId?: string | null;
  guideEpoch: number;
}

export interface CleanupRequiredEvent {
  type: 'cleanup-required';
  cleanupId: string;
}

export interface CleanupCompletedEvent {
  type: 'cleanup-completed';
  cleanupId: string;
}

export interface CleanupFailedEvent {
  type: 'cleanup-failed';
  cleanupId: string;
  error: string;
}

export interface AcceptedRevisionHandoffRecordedEvent {
  type: 'accepted-revision-handoff-recorded';
  backend: string;
  repositoryKey: string;
  checkpointId: string;
  revisionId: string;
  reference: string;
  status: 'preserved';
}

export type MissionEvent =
  | MissionCreatedEvent
  | GuideTurnStartedEvent
  | GuideTurnCompletedEvent
  | GuideProposalAppliedEvent
  | ExecutionPlanAdoptedEvent
  | ChildReservedEvent
  | ChildStartedEvent
  | ChildUsageObservedEvent
  | ChildCancelRequestedEvent
  | ChildCompletedEvent
  | BudgetConstraintTriggeredEvent
  | CheckpointRecordedEvent
  | WorkspaceReconciledEvent
  | ReviewRecordedEvent
  | ValidationStartedEvent
  | ValidationRecordedEvent
  | QuestionRaisedEvent
  | QuestionAnsweredEvent
  | GuideReplacedEvent
  | MissionCompletedEvent
  | CleanupRequiredEvent
  | CleanupCompletedEvent
  | CleanupFailedEvent
  | AcceptedRevisionHandoffRecordedEvent;

export interface MissionEventEnvelope {
  missionId: string;
  revision: number;
  /** Event order within one atomically committed action revision. */
  ordinal: number;
  actionId: string;
  recordedAt: string;
  event: MissionEvent;
}

export interface MissionCommitReceipt {
  missionId: string;
  actionId: string;
  actionFingerprint: string;
  previousRevision: number;
  revision: number;
  eventCount: number;
}
