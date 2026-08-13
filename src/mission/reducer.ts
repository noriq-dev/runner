import {
  DEFAULT_COMPLETION_POLICY,
  type MissionState,
  ZERO_MISSION_USAGE,
  initialMissionState,
  ownMissionValue,
} from './model';
import type { MissionEvent, MissionEventEnvelope, MissionGuideProposal } from './protocol';

function aggregateUsage(
  children: MissionState['children'],
  guideTurns: MissionState['guideTurns'],
): MissionState['usage'] {
  const values = Object.values(children);
  const guides = Object.values(guideTurns);
  const usage = [...values.map((child) => child.usage), ...guides.map((turn) => turn.usage)];
  return {
    tokens: usage.some((observed) => observed.tokens === null)
      ? null
      : usage.reduce((total, observed) => total + (observed.tokens ?? 0), 0),
    usd: usage.some((observed) => observed.usd === null)
      ? null
      : values.reduce((total, child) => total + (child.usage.usd ?? 0), 0) +
        guides.reduce((total, turn) => total + (turn.usage.usd ?? 0), 0),
    activeSeconds: usage.some((observed) => observed.activeSeconds === null)
      ? null
      : values.reduce((total, child) => total + (child.usage.activeSeconds ?? 0), 0) +
        guides.reduce((total, turn) => total + (turn.usage.activeSeconds ?? 0), 0),
  };
}

const copyBudget = (budget: MissionState['budget']): MissionState['budget'] => ({ ...budget });
const copyUsage = (usage: MissionState['usage']): MissionState['usage'] => ({ ...usage });
const copyNumberRecord = (record: Readonly<Record<string, number>>): Readonly<Record<string, number>> => ({
  ...record,
});
const copyAgent = <T extends { driver: string; model?: string; effort?: string }>(agent: T): T => ({
  ...agent,
});
const copyDriverPosture = <T extends { permission: { allow: readonly string[]; deny: readonly string[] } }>(
  posture: T,
): T =>
  ({
    ...posture,
    permission: {
      ...posture.permission,
      allow: [...posture.permission.allow],
      deny: [...posture.permission.deny],
    },
  }) as T;
const copyProjectMcp = <T extends readonly { server: string; tools: readonly string[] }[]>(grants: T): T =>
  grants.map((grant) => ({ ...grant, tools: [...grant.tools] })) as unknown as T;
const copyGuideProposal = (proposal: MissionGuideProposal | null): MissionGuideProposal | null => {
  if (proposal?.type !== 'spawn-child') return proposal ? { ...proposal } : null;
  return {
    ...proposal,
    agent: copyAgent(proposal.agent),
    driverPosture: copyDriverPosture(proposal.driverPosture),
    budget: copyBudget(proposal.budget),
    resources: copyNumberRecord(proposal.resources),
    projectMcp: copyProjectMcp(proposal.projectMcp),
  };
};
const copyExecutionPlan = <T extends { steps: readonly { acceptance: readonly string[] }[] }>(plan: T): T =>
  ({
    ...plan,
    steps: plan.steps.map((step) => ({ ...step, acceptance: [...step.acceptance] })),
  }) as T;

/**
 * Fold an already-accepted fact without re-running command validation. Replays must remain possible
 * after policy code changes; only the journal's structural/hash validation belongs on this path.
 */
export function applyMissionEvent(
  state: MissionState,
  event: MissionEvent,
  revision: number = state.revision,
): MissionState {
  switch (event.type) {
    case 'mission-created':
      return {
        ...state,
        revision,
        status: 'active',
        objective: event.objective ? { ...event.objective } : null,
        projectMcpDeclarationFingerprint: event.projectMcpDeclarationFingerprint,
        budget: copyBudget(event.budget),
        resources: copyNumberRecord(event.resources),
        guide: {
          ...event.guide,
          agent: copyAgent(event.guide.agent),
          budget: copyBudget(event.guide.budget),
        },
        profiles: Object.fromEntries(
          event.profiles.map((profile) => [
            profile.profileId,
            {
              ...profile,
              agent: copyAgent(profile.agent),
              assurance: { ...profile.assurance },
              driverPosture: copyDriverPosture(profile.driverPosture),
              budget: copyBudget(profile.budget),
              resources: copyNumberRecord(profile.resources),
              projectMcp: copyProjectMcp(profile.projectMcp),
            },
          ]),
        ),
        validationPolicy: { ...event.validationPolicy },
        completion: event.completion ? { ...event.completion } : DEFAULT_COMPLETION_POLICY,
        cleanupPlan: [...(event.cleanup ?? [])],
      };
    case 'guide-turn-started':
      return {
        ...state,
        revision,
        guideTurns: {
          ...state.guideTurns,
          [event.turnId]: {
            turnId: event.turnId,
            startedRevision: revision,
            guideEpoch: event.guideEpoch,
            profileId: event.profileId,
            budget: copyBudget(event.budget),
            status: 'running',
            usage: { ...ZERO_MISSION_USAGE },
            summary: null,
            proposal: null,
          },
        },
        guideTurnOrder: [...state.guideTurnOrder, event.turnId],
      };
    case 'guide-turn-completed': {
      const turn = ownMissionValue(state.guideTurns, event.turnId);
      if (!turn) return { ...state, revision };
      const guideTurns = {
        ...state.guideTurns,
        [event.turnId]: {
          ...turn,
          status: event.outcome,
          usage: copyUsage(event.usage),
          summary: event.summary,
          proposal: copyGuideProposal(event.proposal),
        },
      };
      return {
        ...state,
        revision,
        guideTurns,
        usage: aggregateUsage(state.children, guideTurns),
      };
    }
    case 'guide-proposal-applied': {
      const turn = ownMissionValue(state.guideTurns, event.turnId);
      if (!turn) return { ...state, revision };
      return {
        ...state,
        revision,
        guideTurns: {
          ...state.guideTurns,
          [event.turnId]: { ...turn, status: 'applied' },
        },
        consecutiveGuideRepairs: 0,
        lastGuideFeedback: null,
      };
    }
    case 'execution-plan-adopted':
      return {
        ...state,
        revision,
        guideEpoch: event.guideEpoch + 1,
        activePlan: {
          plannerChildId: event.plannerChildId,
          guideEpoch: event.guideEpoch,
          planFingerprint: event.planFingerprint,
          plan: copyExecutionPlan(event.plan),
        },
        // Adopting the newest successful plan retires every older successful planner artifact.
        // The guide may never oscillate backward into stale work after a replan.
        retiredPlannerChildIds: [
          ...new Set([
            ...state.retiredPlannerChildIds,
            ...state.childOrder.filter(
              (childId) => ownMissionValue(state.children, childId)?.artifact?.type === 'execution-plan',
            ),
            event.plannerChildId,
          ]),
        ],
      };
    case 'child-reserved':
      return {
        ...state,
        revision,
        guideEpoch: event.guideEpoch + 1,
        children: {
          ...state.children,
          [event.child.childId]: {
            ...event.child,
            agent: { ...event.child.agent },
            driverPosture: copyDriverPosture(event.child.driverPosture),
            budget: copyBudget(event.child.budget),
            resources: copyNumberRecord(event.child.resources),
            projectMcp: copyProjectMcp(event.child.projectMcp),
            subjectCheckpointId: event.child.subjectCheckpointId ?? null,
            planStepId: event.child.planStepId ?? null,
            status: 'reserved',
            attemptId: null,
            sessionId: null,
            usage: ZERO_MISSION_USAGE,
            summary: null,
            artifact: null,
            cancelReason: null,
          },
        },
        childOrder: [...state.childOrder, event.child.childId],
      };
    case 'child-started': {
      const child = ownMissionValue(state.children, event.childId);
      if (!child) return { ...state, revision };
      return {
        ...state,
        revision,
        children: {
          ...state.children,
          [event.childId]: {
            ...child,
            status: 'running',
            attemptId: event.attemptId,
            sessionId: event.sessionId ?? null,
          },
        },
      };
    }
    case 'child-usage-observed': {
      const child = ownMissionValue(state.children, event.childId);
      if (!child) return { ...state, revision };
      const children = {
        ...state.children,
        [event.childId]: { ...child, usage: copyUsage(event.usage) },
      };
      return {
        ...state,
        revision,
        usage: aggregateUsage(children, state.guideTurns),
        children,
      };
    }
    case 'child-cancel-requested': {
      const child = ownMissionValue(state.children, event.childId);
      if (!child) return { ...state, revision };
      return {
        ...state,
        revision,
        guideEpoch: event.guideEpoch + 1,
        children: {
          ...state.children,
          [event.childId]: { ...child, status: 'cancelling', cancelReason: event.reason },
        },
      };
    }
    case 'child-completed': {
      const child = ownMissionValue(state.children, event.childId);
      if (!child) return { ...state, revision };
      const children = {
        ...state.children,
        [event.childId]: {
          ...child,
          status: event.outcome,
          usage: copyUsage(event.usage),
          summary: event.summary,
          artifact:
            event.artifact?.type === 'execution-plan'
              ? {
                  ...event.artifact,
                  steps: event.artifact.steps.map((step) => ({
                    ...step,
                    acceptance: [...step.acceptance],
                  })),
                }
              : event.artifact
                ? { ...event.artifact }
                : null,
        },
      };
      return {
        ...state,
        revision,
        usage: aggregateUsage(children, state.guideTurns),
        children,
      };
    }
    case 'budget-constraint-triggered':
      return {
        ...state,
        revision,
        budgetConstraints: {
          ...state.budgetConstraints,
          [event.constraintId]: {
            constraintId: event.constraintId,
            scope: event.scope,
            childId: event.childId ?? null,
            turnId: event.turnId ?? null,
            axis: event.axis,
            reason: event.reason,
            observed: event.observed,
            limit: event.limit,
          },
        },
      };
    case 'checkpoint-recorded':
      return {
        ...state,
        revision,
        checkpoints: {
          ...state.checkpoints,
          [event.checkpointId]: {
            checkpointId: event.checkpointId,
            revisionId: event.revisionId,
            authorChildId: event.authorChildId,
            changed: event.changed ?? true,
            parentCheckpointId: event.parentCheckpointId ?? null,
            clean: event.clean,
            description: event.description ?? null,
          },
        },
        checkpointOrder: [...state.checkpointOrder, event.checkpointId],
      };
    case 'workspace-reconciled':
      return {
        ...state,
        revision,
        workspaceReconciliations: {
          ...state.workspaceReconciliations,
          [event.childId]: {
            childId: event.childId,
            revisionId: event.revisionId,
            disposition: event.disposition,
            summary: event.summary,
          },
        },
      };
    case 'review-recorded':
      return {
        ...state,
        revision,
        reviews: {
          ...state.reviews,
          [event.reviewId]: {
            reviewId: event.reviewId,
            reviewerChildId: event.reviewerChildId,
            checkpointId: event.checkpointId,
            revisionId: event.revisionId,
            verdict: event.verdict,
            highestSeverity: event.highestSeverity,
            summary: event.summary,
          },
        },
        reviewOrder: [...state.reviewOrder, event.reviewId],
      };
    case 'validation-started':
      return {
        ...state,
        revision,
        activeValidation: {
          validationId: event.validationId,
          checkpointId: event.checkpointId,
          revisionId: event.revisionId,
          policyId: event.policyId,
        },
      };
    case 'validation-recorded':
      return {
        ...state,
        revision,
        activeValidation: null,
        validations: {
          ...state.validations,
          [event.validationId]: {
            validationId: event.validationId,
            checkpointId: event.checkpointId,
            revisionId: event.revisionId,
            policyId: event.policyId,
            disposition: event.disposition,
            exitCode: event.exitCode,
            timedOut: event.timedOut,
            workspaceChanged: event.workspaceChanged,
            outputTail: event.outputTail,
          },
        },
        validationOrder: [...state.validationOrder, event.validationId],
      };
    case 'question-raised':
      return {
        ...state,
        revision,
        guideEpoch: event.guideEpoch + 1,
        questions: {
          ...state.questions,
          [event.questionId]: {
            questionId: event.questionId,
            prompt: event.prompt,
            answer: null,
            status: 'pending',
          },
        },
        questionOrder: [...state.questionOrder, event.questionId],
      };
    case 'question-answered': {
      const question = ownMissionValue(state.questions, event.questionId);
      if (!question) return { ...state, revision };
      return {
        ...state,
        revision,
        questions: {
          ...state.questions,
          [event.questionId]: { ...question, answer: event.answer, status: 'answered' },
        },
      };
    }
    case 'guide-replaced':
      return {
        ...state,
        revision,
        guideEpoch: event.guideEpoch,
        consecutiveGuideRepairs: state.consecutiveGuideRepairs + 1,
        lastGuideFeedback: event.reason,
      };
    case 'mission-completed':
      return {
        ...state,
        revision,
        status: event.outcome,
        guideEpoch: event.guideEpoch + 1,
        terminal: {
          outcome: event.outcome,
          reason: event.reason,
          checkpointId: event.checkpointId ?? null,
        },
      };
    case 'cleanup-required':
      return {
        ...state,
        revision,
        cleanup: {
          ...state.cleanup,
          [event.cleanupId]: { cleanupId: event.cleanupId, status: 'pending', error: null },
        },
      };
    case 'cleanup-completed': {
      const cleanup = ownMissionValue(state.cleanup, event.cleanupId);
      if (!cleanup) return { ...state, revision };
      return {
        ...state,
        revision,
        cleanup: {
          ...state.cleanup,
          [event.cleanupId]: { ...cleanup, status: 'completed', error: null },
        },
      };
    }
    case 'cleanup-failed': {
      const cleanup = ownMissionValue(state.cleanup, event.cleanupId);
      if (!cleanup) return { ...state, revision };
      return {
        ...state,
        revision,
        cleanup: {
          ...state.cleanup,
          [event.cleanupId]: { ...cleanup, status: 'failed', error: event.error },
        },
      };
    }
    case 'accepted-revision-handoff-recorded':
      return {
        ...state,
        revision,
        acceptedRevisionHandoff: {
          backend: event.backend,
          repositoryKey: event.repositoryKey,
          checkpointId: event.checkpointId,
          revisionId: event.revisionId,
          reference: event.reference,
          status: event.status,
        },
      };
  }
}

export function reduceMission(missionId: string, events: readonly MissionEventEnvelope[]): MissionState {
  return reduceMissionFrom(initialMissionState(missionId), events);
}

/** Incrementally fold a validated journal suffix onto an already-derived authoritative state. */
export function reduceMissionFrom(
  state: MissionState,
  events: readonly MissionEventEnvelope[],
): MissionState {
  return events.reduce(
    (current, envelope) => applyMissionEvent(current, envelope.event, envelope.revision),
    state,
  );
}
