import { missionProfileAdmission } from './decide';
import {
  type MissionState,
  governingReviewForCheckpoint,
  latestCheckpoint,
  missionChildrenInOrder,
  ownMissionValue,
  workspaceReconciliationForChild,
} from './model';
import { missionExecutionPlanFingerprint, missionPlanStepKey } from './plan-identity';
import type {
  MissionBudget,
  MissionChildArtifact,
  MissionExecutionPlanArtifact,
  MissionUsage,
} from './protocol';

type ProjectedChildArtifact =
  | Extract<MissionChildArtifact, { type: 'review' }>
  | {
      type: 'execution-plan';
      summary: string;
      steps: Array<{
        id: string;
        title: string;
        profileId: string;
        reviewProfileId?: string;
        instruction: string;
        acceptance: string[];
      }>;
    };

export interface MissionGuideProjection {
  missionId: string;
  revision: number;
  guideEpoch: number;
  status: MissionState['status'];
  objective: MissionState['objective'];
  budget: {
    ceiling: MissionBudget;
    used: MissionUsage;
    constraints: Array<{
      constraintId: string;
      scope: string;
      childId: string | null;
      turnId: string | null;
      axis: string;
      reason: string;
      observed: number | null;
      limit: number;
    }>;
  };
  profiles: Array<{
    profileId: string;
    role: string;
    permission: 'read' | 'write';
    kind: string;
    lineageRole: string;
    /** Advisory only. The kernel repeats admission after the guide turn settles. */
    dispatchable: boolean;
    unavailableReason: string | null;
    /** Capability hint only; authority, model selection, budgets, and exact tools stay kernel-side. */
    projectMcpServers: string[];
  }>;
  guideTurns: {
    completed: number;
    runningTurnId: string | null;
    lastFeedback: null | { status: string; summary: string };
  };
  children: Array<{
    childId: string;
    profileId: string;
    role: string;
    permission: 'read' | 'write';
    status: string;
    attemptId: string | null;
    subjectCheckpointId: string | null;
    planStepId: string | null;
    usage: MissionUsage;
    summary: string | null;
    artifact: ProjectedChildArtifact | null;
    cancelReason: string | null;
    workspaceReconciliation: null | {
      source: 'clean-checkpoint' | 'harness';
      revisionId: string;
      disposition: 'clean-checkpoint' | 'restored' | 'quarantined';
      summary: string | null;
    };
  }>;
  questions: Array<{
    questionId: string;
    prompt: string;
    answer: string | null;
    status: 'pending' | 'answered';
  }>;
  checkpoint: null | {
    checkpointId: string;
    revisionId: string;
    authorChildId: string | null;
    changed: boolean;
    clean: boolean;
    review: null | {
      reviewId: string;
      reviewerChildId: string;
      revisionId: string;
      verdict: string;
      highestSeverity: string;
      summary: string;
    };
  };
  validation: {
    policy: null | { kind: 'command' | 'none'; policyId: string };
    active: null | {
      validationId: string;
      checkpointId: string;
      revisionId: string;
      policyId: string;
    };
    latest: null | {
      validationId: string;
      checkpointId: string | null;
      revisionId: string | null;
      policyId: string;
      disposition: 'passed' | 'failed' | 'not-applicable';
      exitCode: number | null;
      timedOut: boolean;
      workspaceChanged: boolean;
      outputTail: string;
    };
  };
  acceptedRevisionHandoff: null | {
    backend: string;
    repositoryKey: string;
    checkpointId: string;
    revisionId: string;
    reference: string;
    status: 'preserved';
  };
  completion: MissionState['completion'];
  /** Complete, untruncated semantic authority offered for one exact guide adoption decision. */
  pendingPlan: null | {
    plannerChildId: string;
    planFingerprint: string;
    plan: MissionExecutionPlanArtifact;
  };
  activePlan: null | {
    plannerChildId: string;
    planFingerprint: string;
    summary: string;
    stepIds: string[];
    currentStep: null | {
      id: string;
      title: string;
      instruction: string;
      acceptance: string[];
      workerStatus: string | null;
      checkpointClean: boolean | null;
      reviewStatus: string | null;
    };
  };
}

export interface MissionProjectionLimits {
  maxChildren?: number;
  maxQuestions?: number;
  maxSummaryChars?: number;
  maxObjectiveChars?: number;
  /**
   * Explicit hard serialized projection ceiling. Without an override, ordinary turns target 64 KiB
   * and the one plan-adoption turn targets 128 KiB; non-trimmable authority may expand only up to
   * the absolute 192,000-character ceiling. Historical arrays are trimmed oldest-first.
   */
  maxSerializedChars?: number;
}

/** Normal guide turns should not carry a transcript-sized current-state frame. */
export const DEFAULT_MISSION_GUIDE_PROJECTION_CHARS = 64 * 1024;
/** One adoption turn receives every field of the at-most-48-KiB execution plan. */
export const DEFAULT_PENDING_PLAN_GUIDE_PROJECTION_CHARS = 128 * 1024;
/** Compatibility/safety ceiling for non-trimmable objective, profile, checkpoint, and plan authority. */
export const MAX_MISSION_GUIDE_PROJECTION_CHARS = 192_000;

const TRUNCATED_SUFFIX = '[truncated]';
const clipped = (value: string, limit: number): string =>
  value.length <= limit
    ? value
    : `${value.slice(0, Math.max(0, limit - TRUNCATED_SUFFIX.length))}${TRUNCATED_SUFFIX}`.slice(0, limit);

/** Build a bounded current-state view. Transcripts, prompts, agent selection, and secrets stay out. */
export function projectMissionForGuide(
  state: MissionState,
  limits: MissionProjectionLimits = {},
): MissionGuideProjection {
  const maxChildren = limits.maxChildren ?? 32;
  const maxQuestions = limits.maxQuestions ?? 16;
  const maxSummaryChars = limits.maxSummaryChars ?? 2_000;
  const maxObjectiveChars = limits.maxObjectiveChars ?? 8_000;
  const requestedMaxSerializedChars = limits.maxSerializedChars;
  if (
    requestedMaxSerializedChars !== undefined &&
    (!Number.isSafeInteger(requestedMaxSerializedChars) || requestedMaxSerializedChars < 1)
  ) {
    throw new Error('maxSerializedChars must be a positive safe integer');
  }
  const checkpoint = latestCheckpoint(state);
  const review = checkpoint ? governingReviewForCheckpoint(state, checkpoint.checkpointId) : null;
  const latestValidationId = state.validationOrder.at(-1);
  const latestValidation = latestValidationId
    ? ownMissionValue(state.validations, latestValidationId)
    : undefined;
  const orderedChildren = missionChildrenInOrder(state);
  const runningGuide = Object.values(state.guideTurns).find((turn) => turn.status === 'running');
  const latestSettledGuideTurn = [...state.guideTurnOrder]
    .reverse()
    .map((id) => ownMissionValue(state.guideTurns, id))
    .find((turn) => turn !== undefined && turn.status !== 'running');
  const projectArtifact = (artifact: MissionChildArtifact | null): ProjectedChildArtifact | null => {
    if (!artifact) return null;
    if (artifact.type === 'review') {
      return { ...artifact, summary: clipped(artifact.summary, maxSummaryChars) };
    }
    const plan: ProjectedChildArtifact = {
      type: 'execution-plan',
      summary: clipped(artifact.summary, maxSummaryChars),
      // The durable plan remains in kernel state. A child artifact is historical evidence for the
      // guide, so cap it aggressively; `activePlan.currentStep` below carries actionable detail.
      steps: artifact.steps.slice(0, 8).map((step) => ({
        ...step,
        instruction: clipped(step.instruction, maxSummaryChars),
        acceptance: step.acceptance
          .slice(0, 8)
          .map((criterion) => clipped(criterion, Math.min(maxSummaryChars, 512))),
      })),
    };
    return plan;
  };

  const activePlan = state.activePlan;
  const pendingPlanner = [...orderedChildren]
    .reverse()
    .find(
      (child) =>
        child.status === 'succeeded' &&
        child.artifact?.type === 'execution-plan' &&
        !state.retiredPlannerChildIds.includes(child.childId),
    );
  const currentPlanStep = activePlan
    ? (activePlan.plan.steps.find((step) => {
        const stepKey = missionPlanStepKey(state.missionId, activePlan.plannerChildId, step.id);
        const related = orderedChildren.filter((child) => child.planStepId === stepKey);
        const worker = related.filter((child) => child.subjectCheckpointId === null).at(-1);
        if (!worker || worker.status !== 'succeeded') return true;
        const checkpoint = Object.values(state.checkpoints).find(
          (candidate) => candidate.authorChildId === worker.childId,
        );
        if (worker.permission === 'write' && !checkpoint?.clean) return true;
        if (!step.reviewProfileId) return false;
        const reviewer = related.find((child) => child.subjectCheckpointId === checkpoint?.checkpointId);
        if (!reviewer || reviewer.status !== 'succeeded') return true;
        const planReview = checkpoint ? governingReviewForCheckpoint(state, checkpoint.checkpointId) : null;
        return planReview?.reviewerChildId !== reviewer.childId || planReview.verdict !== 'passed';
      }) ?? null)
    : null;

  const projection: MissionGuideProjection = {
    missionId: state.missionId,
    revision: state.revision,
    guideEpoch: state.guideEpoch,
    status: state.status,
    objective: state.objective
      ? (Object.fromEntries(
          Object.entries(state.objective).map(([key, value]) => [
            key,
            typeof value === 'string' ? clipped(value, maxObjectiveChars) : value,
          ]),
        ) as MissionState['objective'])
      : null,
    budget: {
      ceiling: state.budget,
      used: state.usage,
      constraints: Object.values(state.budgetConstraints).map((constraint) => ({ ...constraint })),
    },
    profiles: Object.values(state.profiles).map((profile) => {
      const admission = missionProfileAdmission(state, profile, runningGuide?.turnId);
      return {
        profileId: profile.profileId,
        role: profile.role,
        permission: profile.permission,
        kind: profile.driverPosture.kind,
        lineageRole: profile.driverPosture.lineageRole,
        dispatchable: admission.dispatchable,
        unavailableReason:
          admission.reason === null ? null : clipped(admission.reason, Math.min(maxSummaryChars, 512)),
        projectMcpServers: profile.projectMcp.map((grant) => grant.server),
      };
    }),
    guideTurns: {
      completed: state.guideTurnOrder.filter(
        (id) => ownMissionValue(state.guideTurns, id)?.status !== 'running',
      ).length,
      runningTurnId: runningGuide?.turnId ?? null,
      lastFeedback:
        state.lastGuideFeedback !== null
          ? {
              status: 'rejected',
              summary: clipped(state.lastGuideFeedback, maxSummaryChars),
            }
          : latestSettledGuideTurn?.summary
            ? {
                status: latestSettledGuideTurn.status,
                summary: clipped(latestSettledGuideTurn.summary, maxSummaryChars),
              }
            : null,
    },
    children: orderedChildren.slice(-maxChildren).map((child) => {
      const reconciliation = workspaceReconciliationForChild(state, child);
      return {
        childId: child.childId,
        profileId: child.profileId,
        role: child.role,
        permission: child.permission,
        status: child.status,
        attemptId: child.attemptId,
        subjectCheckpointId: child.subjectCheckpointId,
        planStepId: child.planStepId,
        usage: child.usage,
        summary: child.summary === null ? null : clipped(child.summary, maxSummaryChars),
        artifact: projectArtifact(child.artifact),
        cancelReason: child.cancelReason,
        workspaceReconciliation: reconciliation
          ? {
              ...reconciliation,
              revisionId: clipped(reconciliation.revisionId, 512),
              summary:
                reconciliation.summary === null ? null : clipped(reconciliation.summary, maxSummaryChars),
            }
          : null,
      };
    }),
    questions: state.questionOrder.slice(-maxQuestions).flatMap((id) => {
      const question = ownMissionValue(state.questions, id);
      return question
        ? [
            {
              ...question,
              prompt: clipped(question.prompt, maxSummaryChars),
              answer: question.answer === null ? null : clipped(question.answer, maxSummaryChars),
            },
          ]
        : [];
    }),
    checkpoint: checkpoint
      ? {
          checkpointId: checkpoint.checkpointId,
          revisionId: checkpoint.revisionId,
          authorChildId: checkpoint.authorChildId,
          changed: checkpoint.changed,
          clean: checkpoint.clean,
          review: review
            ? {
                reviewId: review.reviewId,
                reviewerChildId: review.reviewerChildId,
                revisionId: review.revisionId,
                verdict: review.verdict,
                highestSeverity: review.highestSeverity,
                summary: clipped(review.summary, maxSummaryChars),
              }
            : null,
        }
      : null,
    validation: {
      policy: state.validationPolicy
        ? { kind: state.validationPolicy.kind, policyId: state.validationPolicy.policyId }
        : null,
      active: state.activeValidation ? { ...state.activeValidation } : null,
      latest: latestValidation
        ? {
            validationId: clipped(latestValidation.validationId, 512),
            checkpointId:
              latestValidation.checkpointId === null ? null : clipped(latestValidation.checkpointId, 512),
            revisionId:
              latestValidation.revisionId === null ? null : clipped(latestValidation.revisionId, 512),
            policyId: clipped(latestValidation.policyId, 256),
            disposition: latestValidation.disposition,
            exitCode: latestValidation.exitCode,
            timedOut: latestValidation.timedOut,
            workspaceChanged: latestValidation.workspaceChanged,
            outputTail: clipped(latestValidation.outputTail, maxSummaryChars),
          }
        : null,
    },
    acceptedRevisionHandoff: state.acceptedRevisionHandoff
      ? {
          backend: clipped(state.acceptedRevisionHandoff.backend, 128),
          repositoryKey: clipped(state.acceptedRevisionHandoff.repositoryKey, 256),
          checkpointId: clipped(state.acceptedRevisionHandoff.checkpointId, 512),
          revisionId: clipped(state.acceptedRevisionHandoff.revisionId, 512),
          reference: clipped(state.acceptedRevisionHandoff.reference, maxSummaryChars),
          status: state.acceptedRevisionHandoff.status,
        }
      : null,
    completion: state.completion,
    pendingPlan:
      pendingPlanner?.artifact?.type === 'execution-plan'
        ? {
            plannerChildId: pendingPlanner.childId,
            planFingerprint: missionExecutionPlanFingerprint(pendingPlanner.artifact),
            plan: {
              type: 'execution-plan',
              summary: pendingPlanner.artifact.summary,
              steps: pendingPlanner.artifact.steps.map((step) => ({
                ...step,
                acceptance: [...step.acceptance],
              })),
            },
          }
        : null,
    activePlan: activePlan
      ? {
          plannerChildId: activePlan.plannerChildId,
          planFingerprint: activePlan.planFingerprint,
          summary: clipped(activePlan.plan.summary, maxSummaryChars),
          stepIds: activePlan.plan.steps.map((step) => step.id),
          currentStep: currentPlanStep
            ? {
                id: currentPlanStep.id,
                title: clipped(currentPlanStep.title, Math.min(maxSummaryChars, 256)),
                instruction: clipped(currentPlanStep.instruction, maxSummaryChars),
                acceptance: currentPlanStep.acceptance
                  .slice(0, 16)
                  .map((criterion) => clipped(criterion, Math.min(maxSummaryChars, 512))),
                workerStatus:
                  orderedChildren
                    .filter(
                      (child) =>
                        child.planStepId ===
                          missionPlanStepKey(
                            state.missionId,
                            activePlan.plannerChildId,
                            currentPlanStep.id,
                          ) && child.subjectCheckpointId === null,
                    )
                    .at(-1)?.status ?? null,
                checkpointClean: (() => {
                  const stepKey = missionPlanStepKey(
                    state.missionId,
                    activePlan.plannerChildId,
                    currentPlanStep.id,
                  );
                  const worker = orderedChildren
                    .filter((child) => child.planStepId === stepKey && child.subjectCheckpointId === null)
                    .at(-1);
                  if (!worker) return null;
                  return (
                    Object.values(state.checkpoints).find(
                      (candidate) => candidate.authorChildId === worker.childId,
                    )?.clean ?? null
                  );
                })(),
                reviewStatus: (() => {
                  const stepKey = missionPlanStepKey(
                    state.missionId,
                    activePlan.plannerChildId,
                    currentPlanStep.id,
                  );
                  const worker = orderedChildren
                    .filter((child) => child.planStepId === stepKey && child.subjectCheckpointId === null)
                    .at(-1);
                  const checkpoint = worker
                    ? Object.values(state.checkpoints).find(
                        (candidate) => candidate.authorChildId === worker.childId,
                      )
                    : null;
                  return (
                    orderedChildren.find(
                      (child) =>
                        child.planStepId === stepKey &&
                        child.subjectCheckpointId === checkpoint?.checkpointId,
                    )?.status ?? null
                  );
                })(),
              }
            : null,
        }
      : null,
  };

  const serializedChars = (value: unknown): number => JSON.stringify(value).length;
  const phaseTarget = projection.pendingPlan
    ? DEFAULT_PENDING_PLAN_GUIDE_PROJECTION_CHARS
    : DEFAULT_MISSION_GUIDE_PROJECTION_CHARS;
  const nonHistoricalChars = serializedChars({
    ...projection,
    children: [],
    questions: [],
  });
  // A large but valid profile catalogue must not strand a mission merely because the economical
  // target is smaller than its kernel-owned authority. Expand only as far as that non-trimmable
  // frame requires, and never beyond the pre-existing absolute safety ceiling.
  const maxSerializedChars =
    requestedMaxSerializedChars ??
    Math.min(MAX_MISSION_GUIDE_PROJECTION_CHARS, Math.max(phaseTarget, nonHistoricalChars));

  // Per-field clipping alone does not bound the sum of many valid children/questions/artifacts.
  // Remove oldest evidence deterministically until the whole model-visible frame fits. The most
  // recent evidence, exact current checkpoint, and complete pending-plan authority remain preferred.
  while (
    serializedChars(projection) > maxSerializedChars &&
    (projection.children.length > 0 || projection.questions.length > 0)
  ) {
    if (projection.children.length >= projection.questions.length && projection.children.length > 0) {
      projection.children.shift();
    } else if (projection.questions.length > 0) {
      projection.questions.shift();
    }
  }
  if (serializedChars(projection) > maxSerializedChars) {
    throw new Error(`mission guide projection cannot fit its ${maxSerializedChars}-character trusted limit`);
  }
  return projection;
}
