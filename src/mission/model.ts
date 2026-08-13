import type {
  MissionAgentSelection,
  MissionBudget,
  MissionBudgetAxis,
  MissionBudgetConstraintReason,
  MissionChildArtifact,
  MissionChildOutcome,
  MissionCompletionPolicy,
  MissionDriverPosture,
  MissionExecutionPlanArtifact,
  MissionExecutionProfile,
  MissionFindingSeverity,
  MissionGuideProfile,
  MissionGuideProposal,
  MissionObjective,
  MissionOutcome,
  MissionReviewVerdict,
  MissionUsage,
  MissionValidationDisposition,
  MissionValidationPolicy,
  MissionWorkspaceReconciliationDisposition,
} from './protocol';

export type MissionStatus = 'uninitialized' | 'active' | MissionOutcome;
export type MissionChildStatus = 'reserved' | 'running' | 'cancelling' | MissionChildOutcome;

export interface MissionChildState {
  childId: string;
  role: string;
  instruction: string;
  permission: 'read' | 'write';
  agent: MissionAgentSelection;
  driverPosture: MissionDriverPosture;
  profileId: string;
  budget: MissionBudget;
  resources: Readonly<Record<string, number>>;
  projectMcp: MissionExecutionProfile['projectMcp'];
  subjectCheckpointId: string | null;
  planStepId: string | null;
  status: MissionChildStatus;
  attemptId: string | null;
  sessionId: string | null;
  usage: MissionUsage;
  summary: string | null;
  artifact: MissionChildArtifact | null;
  cancelReason: string | null;
}

export interface MissionCheckpointState {
  checkpointId: string;
  /** Backend-native immutable identity (git SHA, Diversion commit id, or content digest). */
  revisionId: string;
  authorChildId: string | null;
  changed: boolean;
  parentCheckpointId: string | null;
  clean: boolean;
  description: string | null;
}

export interface MissionWorkspaceReconciliationState {
  childId: string;
  revisionId: string;
  disposition: MissionWorkspaceReconciliationDisposition;
  summary: string;
}

export interface MissionWorkspaceReconciliationFact {
  source: 'clean-checkpoint' | 'harness';
  revisionId: string;
  disposition: 'clean-checkpoint' | MissionWorkspaceReconciliationDisposition;
  summary: string | null;
}

export interface MissionBudgetConstraintState {
  constraintId: string;
  scope: 'mission' | 'child' | 'guide';
  childId: string | null;
  turnId: string | null;
  axis: MissionBudgetAxis;
  reason: MissionBudgetConstraintReason;
  observed: number | null;
  limit: number;
}

export interface MissionReviewState {
  reviewId: string;
  reviewerChildId: string;
  checkpointId: string;
  revisionId: string;
  verdict: MissionReviewVerdict;
  highestSeverity: MissionFindingSeverity;
  summary: string;
}

/** Immutable, checkpoint-bound result of the mission's trusted validation policy. */
export interface MissionValidationState {
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

export interface MissionValidationAttemptState {
  validationId: string;
  checkpointId: string;
  revisionId: string;
  policyId: string;
}

/** Backend-owned preserved reference recorded only after successful cleanup. */
export interface MissionAcceptedRevisionHandoffState {
  backend: string;
  repositoryKey: string;
  checkpointId: string;
  revisionId: string;
  reference: string;
  status: 'preserved';
}

export interface MissionCleanupState {
  cleanupId: string;
  status: 'pending' | 'completed' | 'failed';
  error: string | null;
}

export interface MissionGuideTurnState {
  turnId: string;
  /** Revision committed by begin-guide-turn and projected to the guide. */
  startedRevision: number;
  guideEpoch: number;
  profileId: string;
  budget: MissionBudget;
  status: 'running' | 'proposed' | 'applied' | 'failed' | 'cancelled' | 'lost';
  usage: MissionUsage;
  summary: string | null;
  proposal: MissionGuideProposal | null;
}

export interface MissionQuestionState {
  questionId: string;
  prompt: string;
  answer: string | null;
  status: 'pending' | 'answered';
}

export interface MissionTerminalState {
  outcome: MissionOutcome;
  reason: string;
  checkpointId: string | null;
}

export interface MissionActivePlanState {
  plannerChildId: string;
  guideEpoch: number;
  planFingerprint: string;
  plan: MissionExecutionPlanArtifact;
}

export interface MissionState {
  missionId: string;
  revision: number;
  status: MissionStatus;
  guideEpoch: number;
  guide: MissionGuideProfile | null;
  profiles: Readonly<Record<string, MissionExecutionProfile>>;
  guideTurns: Readonly<Record<string, MissionGuideTurnState>>;
  guideTurnOrder: readonly string[];
  /** Consecutive rejected/malformed guide proposals since the last accepted proposal. */
  consecutiveGuideRepairs: number;
  /** Kernel refusal or replacement reason shown to the next guide without replaying transcripts. */
  lastGuideFeedback: string | null;
  activePlan: MissionActivePlanState | null;
  /** Planner artifacts adopted or superseded in this mission can never become pending again. */
  retiredPlannerChildIds: readonly string[];
  objective: MissionObjective | null;
  projectMcpDeclarationFingerprint: string | null;
  budget: MissionBudget;
  usage: MissionUsage;
  budgetConstraints: Readonly<Record<string, MissionBudgetConstraintState>>;
  resources: Readonly<Record<string, number>>;
  completion: MissionCompletionPolicy;
  /** Null only before the mission-created fact is folded. */
  validationPolicy: MissionValidationPolicy | null;
  children: Readonly<Record<string, MissionChildState>>;
  /** Durable insertion order; object-key enumeration is not insertion ordered for numeric ids. */
  childOrder: readonly string[];
  checkpoints: Readonly<Record<string, MissionCheckpointState>>;
  checkpointOrder: readonly string[];
  workspaceReconciliations: Readonly<Record<string, MissionWorkspaceReconciliationState>>;
  reviews: Readonly<Record<string, MissionReviewState>>;
  reviewOrder: readonly string[];
  /** Durable command authority. Non-null means startup must restore/retry before other work. */
  activeValidation: MissionValidationAttemptState | null;
  validations: Readonly<Record<string, MissionValidationState>>;
  validationOrder: readonly string[];
  questions: Readonly<Record<string, MissionQuestionState>>;
  questionOrder: readonly string[];
  cleanupPlan: readonly string[];
  cleanup: Readonly<Record<string, MissionCleanupState>>;
  terminal: MissionTerminalState | null;
  acceptedRevisionHandoff: MissionAcceptedRevisionHandoffState | null;
}

export const ZERO_MISSION_BUDGET: MissionBudget = Object.freeze({
  tokens: null,
  usd: null,
  activeSeconds: null,
});

export const ZERO_MISSION_USAGE: MissionUsage = Object.freeze({
  tokens: 0,
  // Before any child starts, zero spend is known. This becomes null only after a vendor reports
  // usage without a cost value; null is "unknown", never the initial value and never zero.
  usd: 0,
  activeSeconds: 0,
});

export const DEFAULT_COMPLETION_POLICY: MissionCompletionPolicy = Object.freeze({
  requireCheckpoint: true,
  requireReview: true,
});

export function initialMissionState(missionId: string): MissionState {
  return {
    missionId,
    revision: 0,
    status: 'uninitialized',
    guideEpoch: 0,
    guide: null,
    profiles: {},
    guideTurns: {},
    guideTurnOrder: [],
    consecutiveGuideRepairs: 0,
    lastGuideFeedback: null,
    activePlan: null,
    retiredPlannerChildIds: [],
    objective: null,
    projectMcpDeclarationFingerprint: null,
    budget: ZERO_MISSION_BUDGET,
    usage: ZERO_MISSION_USAGE,
    budgetConstraints: {},
    resources: {},
    completion: DEFAULT_COMPLETION_POLICY,
    validationPolicy: null,
    children: {},
    childOrder: [],
    checkpoints: {},
    checkpointOrder: [],
    workspaceReconciliations: {},
    reviews: {},
    reviewOrder: [],
    activeValidation: null,
    validations: {},
    validationOrder: [],
    questions: {},
    questionOrder: [],
    cleanupPlan: [],
    cleanup: {},
    terminal: null,
    acceptedRevisionHandoff: null,
  };
}

export const childIsTerminal = (status: MissionChildStatus): boolean =>
  status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'lost';

/** Prototype-safe lookup for every durable state record keyed by untrusted protocol ids. */
export function ownMissionValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Return children in durable reservation order, independent of JavaScript object-key ordering. */
export const missionChildrenInOrder = (state: MissionState): MissionChildState[] =>
  state.childOrder.flatMap((id) => {
    const child = ownMissionValue(state.children, id);
    return child ? [child] : [];
  });

/**
 * Return the durable fact that makes it safe to admit work after one terminal write child. A
 * successful child-authored clean checkpoint is itself sufficient; every other terminal write
 * outcome needs an explicit harness reconciliation fact.
 */
export function workspaceReconciliationForChild(
  state: MissionState,
  child: MissionChildState,
): MissionWorkspaceReconciliationFact | null {
  const explicit = ownMissionValue(state.workspaceReconciliations, child.childId);
  if (explicit) {
    return {
      source: 'harness',
      revisionId: explicit.revisionId,
      disposition: explicit.disposition,
      summary: explicit.summary,
    };
  }
  if (child.permission !== 'write' || child.status !== 'succeeded') return null;
  const checkpoint = Object.values(state.checkpoints).find(
    (candidate) => candidate.authorChildId === child.childId && candidate.clean,
  );
  return checkpoint
    ? {
        source: 'clean-checkpoint',
        revisionId: checkpoint.revisionId,
        disposition: 'clean-checkpoint',
        summary: checkpoint.description,
      }
    : null;
}

export const unreconciledTerminalWriteChild = (state: MissionState): MissionChildState | null =>
  missionChildrenInOrder(state).find(
    (child) =>
      child.permission === 'write' &&
      childIsTerminal(child.status) &&
      workspaceReconciliationForChild(state, child) === null,
  ) ?? null;

export const latestCheckpoint = (state: MissionState): MissionCheckpointState | null => {
  const id = state.checkpointOrder.at(-1);
  return id ? (ownMissionValue(state.checkpoints, id) ?? null) : null;
};

export const latestReviewForCheckpoint = (
  state: MissionState,
  checkpointId: string,
): MissionReviewState | null => {
  for (let index = state.reviewOrder.length - 1; index >= 0; index--) {
    const review = ownMissionValue(state.reviews, state.reviewOrder[index]!);
    if (review?.checkpointId === checkpointId) return review;
  }
  return null;
};

/**
 * A later pass on an unchanged immutable revision cannot erase a prior request for changes. Match
 * the backend revision as well as the logical checkpoint id so an older journal containing two
 * aliases for one revision cannot bypass its blocking review.
 */
export const governingReviewForCheckpoint = (
  state: MissionState,
  checkpointId: string,
): MissionReviewState | null => {
  const checkpoint = ownMissionValue(state.checkpoints, checkpointId);
  if (!checkpoint) return null;
  let latest: MissionReviewState | null = null;
  for (const id of state.reviewOrder) {
    const review = ownMissionValue(state.reviews, id);
    if (review?.revisionId !== checkpoint.revisionId) continue;
    latest = review;
    if (review.verdict === 'changes-requested') return review;
  }
  return latest;
};

/** Latest durable validation for the exact checkpoint revision and immutable policy authority. */
export const governingValidationForCheckpoint = (
  state: MissionState,
  checkpointId: string | null,
): MissionValidationState | null => {
  const revisionId =
    checkpointId === null
      ? null
      : (ownMissionValue(state.checkpoints, checkpointId)?.revisionId ?? undefined);
  if (revisionId === undefined || !state.validationPolicy) return null;
  for (let index = state.validationOrder.length - 1; index >= 0; index -= 1) {
    const validation = ownMissionValue(state.validations, state.validationOrder[index]!);
    if (
      validation?.checkpointId === checkpointId &&
      validation.revisionId === revisionId &&
      validation.policyId === state.validationPolicy.policyId
    ) {
      return validation;
    }
  }
  return null;
};
