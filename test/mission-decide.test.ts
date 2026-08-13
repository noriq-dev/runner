import { describe, expect, it } from 'vitest';
import { type MissionDecisionAccepted, decideMission } from '../src/mission/decide';
import { type MissionState, initialMissionState } from '../src/mission/model';
import {
  missionExecutionPlanFingerprint,
  missionPlanChildId,
  missionPlanStepKey,
} from '../src/mission/plan-identity';
import type {
  CreateMissionAction,
  MissionAction,
  MissionBudget,
  MissionEvent,
  MissionExecutionProfile,
  SpawnChildAction,
} from '../src/mission/protocol';
import { applyMissionEvent } from '../src/mission/reducer';
import { createStoredMissionAction } from '../src/mission/store';

const unlimited: MissionBudget = { tokens: null, usd: null, activeSeconds: null };
const zero: MissionBudget = { tokens: 0, usd: 0, activeSeconds: 0 };
const buildPosture = {
  kind: 'build',
  permission: { write: true, allow: [], deny: [], auto: false },
  lineageRole: 'worker',
} as const;
const reviewPosture = {
  kind: 'verify',
  permission: { write: false, allow: [], deny: [], auto: false },
  lineageRole: 'reviewer',
} as const;
const guide = {
  profileId: 'guide',
  agent: { driver: 'test-guide', model: 'guide-model' },
  budget: zero,
  turnLimit: 20,
} as const;
const noValidation = {
  kind: 'none',
  policyId: 'test-none-v1',
  reason: 'No deterministic validation in this unit fixture.',
} as const;

function workerProfile(
  profileId: string,
  permission: 'read' | 'write',
  budget: MissionBudget,
  resources: Readonly<Record<string, number>>,
): MissionExecutionProfile {
  return {
    profileId,
    role: 'worker',
    permission,
    agent:
      permission === 'write'
        ? { driver: 'test-driver', model: 'worker-model' }
        : { driver: 'review-driver', model: 'review-model' },
    assurance:
      permission === 'write'
        ? { rank: 1, independenceClass: 'build' }
        : { rank: 2, independenceClass: 'independent-review' },
    driverPosture: permission === 'write' ? buildPosture : reviewPosture,
    budget,
    resources,
    projectMcp: [],
  };
}

function defaultProfiles(
  budget: MissionBudget,
  resources: Readonly<Record<string, number>>,
): readonly MissionExecutionProfile[] {
  const profiles: MissionExecutionProfile[] = [
    workerProfile('worker-read', 'read', zero, {}),
    workerProfile('worker-write', 'write', zero, {}),
    workerProfile('worker-mission-budget', 'read', budget, {}),
  ];
  if (Object.keys(resources).length > 0) {
    profiles.push(workerProfile('worker-resources', 'read', zero, resources));
    for (const [index, [key, units]] of Object.entries(resources).entries()) {
      profiles.push(workerProfile(`worker-resource-${index}`, 'read', zero, { [key]: units }));
    }
  }
  return profiles;
}

function applyEvents(
  state: MissionState,
  events: readonly MissionEvent[],
  revision = state.revision + 1,
): MissionState {
  return events.reduce((current, event) => applyMissionEvent(current, event, revision), state);
}

function accept(state: MissionState, action: MissionAction): MissionState {
  const decision = decideMission(state, action);
  if (!decision.accepted) {
    throw new Error(`expected '${action.type}' to be accepted: ${decision.code}: ${decision.reason}`);
  }
  return applyEvents(state, decision.events);
}

function createMission(overrides: Partial<Omit<CreateMissionAction, 'type'>> = {}): MissionState {
  const budget = overrides.budget ?? unlimited;
  const resources = overrides.resources ?? {};
  return accept(initialMissionState('mission-adversarial'), {
    type: 'create-mission',
    projectMcpDeclarationFingerprint: null,
    budget,
    resources,
    guide,
    profiles: defaultProfiles(budget, resources),
    validationPolicy: noValidation,
    completion: { requireCheckpoint: false, requireReview: false },
    ...overrides,
  });
}

type SpawnOverrides = Partial<Omit<SpawnChildAction, 'type' | 'guideEpoch' | 'childId' | 'profileId'>> & {
  profileId?: string;
};

function spawnAction(state: MissionState, childId: string, overrides: SpawnOverrides = {}): SpawnChildAction {
  const permission = overrides.permission ?? 'read';
  const candidate = {
    type: 'spawn-child',
    guideEpoch: state.guideEpoch,
    childId,
    role: 'worker',
    instruction: `Perform bounded work for ${childId}.`,
    permission,
    agent:
      permission === 'write'
        ? { driver: 'test-driver', model: 'worker-model' }
        : { driver: 'review-driver', model: 'review-model' },
    driverPosture: overrides.driverPosture ?? (permission === 'write' ? buildPosture : reviewPosture),
    budget: zero,
    resources: {},
    projectMcp: [],
    ...overrides,
  } satisfies Omit<SpawnChildAction, 'profileId'> & { profileId?: string };
  const profile = candidate.profileId
    ? state.profiles[candidate.profileId]
    : Object.values(state.profiles).find(
        (available) =>
          available.role === candidate.role &&
          available.permission === candidate.permission &&
          JSON.stringify(available.agent) === JSON.stringify(candidate.agent) &&
          JSON.stringify(available.driverPosture) === JSON.stringify(candidate.driverPosture) &&
          JSON.stringify(available.budget) === JSON.stringify(candidate.budget) &&
          JSON.stringify(available.resources) === JSON.stringify(candidate.resources) &&
          JSON.stringify(available.projectMcp) === JSON.stringify(candidate.projectMcp),
      );
  if (!profile) throw new Error(`no execution profile matches child '${childId}'`);
  return { ...candidate, profileId: profile.profileId };
}

function spawnChild(state: MissionState, childId: string, overrides: SpawnOverrides = {}): MissionState {
  return accept(state, spawnAction(state, childId, overrides));
}

function startAndComplete(
  state: MissionState,
  childId: string,
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'lost' = 'succeeded',
  artifact?: Extract<MissionAction, { type: 'complete-child' }>['artifact'],
): MissionState {
  let next = accept(state, {
    type: 'start-child',
    childId,
    attemptId: `attempt-${childId}`,
  });
  next = accept(next, {
    type: 'complete-child',
    childId,
    outcome,
    summary: `${childId} completed.`,
    usage: { tokens: 0, usd: 0, activeSeconds: 0 },
    ...(artifact ? { artifact } : {}),
  });
  return next;
}

function accepted(decision: ReturnType<typeof decideMission>): MissionDecisionAccepted {
  if (!decision.accepted) throw new Error(`expected acceptance: ${decision.code}: ${decision.reason}`);
  return decision;
}

describe('mission decision invariants', () => {
  it('reserves and meters guide turns durably before any guide proposal is considered', () => {
    let state = createMission({
      budget: { tokens: 10, usd: 2, activeSeconds: 20 },
      guide: {
        profileId: 'bounded-guide',
        agent: { driver: 'test-guide', model: 'planning-model' },
        budget: { tokens: 5, usd: 1, activeSeconds: 10 },
        turnLimit: 20,
      },
    });
    state = accept(state, {
      type: 'begin-guide-turn',
      guideEpoch: state.guideEpoch,
      turnId: 'turn-one',
    });
    expect(state.guideTurns['turn-one']).toMatchObject({
      status: 'running',
      profileId: 'bounded-guide',
      budget: { tokens: 5, usd: 1, activeSeconds: 10 },
    });
    expect(
      decideMission(state, {
        type: 'begin-guide-turn',
        guideEpoch: state.guideEpoch,
        turnId: 'turn-two',
      }),
    ).toMatchObject({ accepted: false, code: 'invalid-state' });

    state = accept(state, {
      type: 'complete-guide-turn',
      turnId: 'turn-one',
      outcome: 'failed',
      summary: 'The guide returned no admissible proposal.',
      usage: { tokens: 6, usd: 0.5, activeSeconds: 5 },
      proposal: null,
    });
    expect(state.usage).toEqual({ tokens: 6, usd: 0.5, activeSeconds: 5 });
    expect(Object.values(state.budgetConstraints)).toEqual([
      expect.objectContaining({
        scope: 'guide',
        turnId: 'turn-one',
        axis: 'tokens',
        reason: 'exceeded',
      }),
    ]);
    expect(
      decideMission(state, {
        type: 'begin-guide-turn',
        guideEpoch: state.guideEpoch,
        turnId: 'turn-two',
      }),
    ).toMatchObject({ accepted: false, code: 'budget-exhausted' });
  });

  it('refuses any child authority that differs from its immutable execution profile', () => {
    const state = createMission({
      projectMcpDeclarationFingerprint: 'a'.repeat(64),
      profiles: [
        {
          ...workerProfile('mcp-reader', 'read', zero, {}),
          projectMcp: [{ server: 'project-tools', tools: ['inspect'] }],
        },
      ],
    });
    expect(
      decideMission(state, {
        type: 'spawn-child',
        guideEpoch: state.guideEpoch,
        childId: 'widened-child',
        profileId: 'mcp-reader',
        role: 'worker',
        instruction: 'Attempt to widen a trusted profile.',
        permission: 'write',
        agent: { driver: 'test-driver', model: 'worker-model' },
        driverPosture: reviewPosture,
        budget: zero,
        resources: {},
        projectMcp: [{ server: 'project-tools', tools: ['inspect', 'mutate'] }],
      }),
    ).toMatchObject({ accepted: false, code: 'invalid-action' });
  });

  it('journals budget overage durably and blocks both success and new child work', () => {
    let state = createMission({ budget: { tokens: 10, usd: null, activeSeconds: null } });
    state = spawnChild(state, 'worker-one', {
      budget: { tokens: 10, usd: null, activeSeconds: null },
    });
    state = accept(state, {
      type: 'start-child',
      childId: 'worker-one',
      attemptId: 'attempt-one',
    });

    const observation = accepted(
      decideMission(state, {
        type: 'observe-child-usage',
        childId: 'worker-one',
        usage: { tokens: 11, usd: 0, activeSeconds: 1 },
      }),
    );
    expect(observation.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'budget-constraint-triggered',
          scope: 'child',
          axis: 'tokens',
          reason: 'exceeded',
          observed: 11,
          limit: 10,
        }),
        expect.objectContaining({
          type: 'budget-constraint-triggered',
          scope: 'mission',
          axis: 'tokens',
          reason: 'exceeded',
          observed: 11,
          limit: 10,
        }),
      ]),
    );
    state = applyEvents(state, observation.events);
    state = accept(state, {
      type: 'complete-child',
      childId: 'worker-one',
      outcome: 'failed',
      summary: 'Stopped after crossing the token ceiling.',
      usage: { tokens: 11, usd: 0, activeSeconds: 1 },
    });

    expect(Object.keys(state.budgetConstraints)).toHaveLength(2);
    expect(
      decideMission(
        state,
        spawnAction(state, 'worker-two', {
          instruction: 'Must not start after a durable overage.',
        }),
      ),
    ).toMatchObject({ accepted: false, code: 'budget-exhausted' });
    expect(
      decideMission(state, {
        type: 'complete-mission',
        guideEpoch: state.guideEpoch,
        outcome: 'succeeded',
        reason: 'Do not erase the overage by stopping the child.',
      }),
    ).toMatchObject({ accepted: false, code: 'completion-unproved' });
  });

  it('treats unknown vendor cost as a durable constraint rather than zero spend', () => {
    let state = createMission({ budget: { tokens: null, usd: 5, activeSeconds: null } });
    state = spawnChild(state, 'worker-one', {
      budget: { tokens: null, usd: 5, activeSeconds: null },
    });
    state = accept(state, {
      type: 'start-child',
      childId: 'worker-one',
      attemptId: 'attempt-one',
    });
    state = accept(state, {
      type: 'observe-child-usage',
      childId: 'worker-one',
      usage: { tokens: 1, usd: null, activeSeconds: 1 },
    });

    expect(state.usage.usd).toBeNull();
    expect(Object.values(state.budgetConstraints)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'child', axis: 'usd', reason: 'unknown', observed: null }),
        expect.objectContaining({ scope: 'mission', axis: 'usd', reason: 'unknown', observed: null }),
      ]),
    );
    expect(
      decideMission(
        state,
        spawnAction(state, 'worker-two', {
          instruction: 'Must not assume unknown cost means free.',
        }),
      ),
    ).toMatchObject({ accepted: false, code: 'budget-exhausted' });
  });

  it('allows failed cleanup to be retried to completion but never to regress afterward', () => {
    let state = createMission({ cleanup: ['workspace', 'resource-lease'] });
    state = accept(state, {
      type: 'complete-mission',
      guideEpoch: state.guideEpoch,
      outcome: 'failed',
      reason: 'No acceptable implementation was produced.',
    });
    const terminal = state.terminal;

    state = accept(state, {
      type: 'fail-cleanup',
      cleanupId: 'workspace',
      error: 'workspace is busy',
    });
    expect(state.cleanup.workspace).toMatchObject({ status: 'failed', error: 'workspace is busy' });
    state = accept(state, { type: 'complete-cleanup', cleanupId: 'workspace' });
    expect(state.cleanup.workspace).toEqual({
      cleanupId: 'workspace',
      status: 'completed',
      error: null,
    });

    expect(
      decideMission(state, {
        type: 'fail-cleanup',
        cleanupId: 'workspace',
        error: 'late stale failure',
      }),
    ).toMatchObject({ accepted: false, code: 'invalid-state' });
    expect(decideMission(state, { type: 'complete-cleanup', cleanupId: 'workspace' })).toMatchObject({
      accepted: false,
      code: 'invalid-state',
    });
    expect(state.terminal).toEqual(terminal);
    expect(state.status).toBe('failed');
  });

  it('requires explicit not-applicable validation before checkpoint-free success', () => {
    let state = createMission();
    expect(
      decideMission(state, {
        type: 'complete-mission',
        guideEpoch: state.guideEpoch,
        outcome: 'succeeded',
        reason: 'No checkpoint was required.',
      }),
    ).toMatchObject({ accepted: false, code: 'completion-unproved' });

    state = accept(state, {
      type: 'record-validation',
      validationId: 'validation-none',
      checkpointId: null,
      revisionId: null,
      policyId: noValidation.policyId,
      disposition: 'not-applicable',
      exitCode: null,
      timedOut: false,
      workspaceChanged: false,
      outputTail: '',
    });
    state = accept(state, {
      type: 'complete-mission',
      guideEpoch: state.guideEpoch,
      outcome: 'succeeded',
      reason: 'The explicit none policy was durably recorded.',
    });
    expect(state.terminal).toMatchObject({ outcome: 'succeeded', checkpointId: null });
  });

  it('makes failed command validation terminal for an exact revision and requires a new revision', () => {
    const commandPolicy = {
      kind: 'command',
      policyId: 'focused-tests-v1',
      command: 'npm test',
      timeoutSeconds: 300,
      shell: null,
    } as const;
    let state = createMission({
      objective: { brief: 'Validate one exact revision.', baseRevision: 'base-revision' },
      validationPolicy: commandPolicy,
    });
    state = spawnChild(state, 'writer', { permission: 'write' });
    state = startAndComplete(state, 'writer');
    state = accept(state, {
      type: 'record-checkpoint',
      checkpointId: 'checkpoint-one',
      revisionId: 'revision-one',
      authorChildId: 'writer',
      clean: true,
    });
    state = accept(state, {
      type: 'begin-validation',
      validationId: 'validation-failed',
      checkpointId: 'checkpoint-one',
      revisionId: 'revision-one',
      policyId: commandPolicy.policyId,
    });
    expect(
      decideMission(state, {
        type: 'begin-guide-turn',
        guideEpoch: state.guideEpoch,
        turnId: 'guide-during-validation',
      }),
    ).toMatchObject({ accepted: false, code: 'invalid-state' });
    expect(
      decideMission(state, {
        type: 'begin-validation',
        validationId: 'competing-validation',
        checkpointId: 'checkpoint-one',
        revisionId: 'revision-one',
        policyId: commandPolicy.policyId,
      }),
    ).toMatchObject({ accepted: false, code: 'invalid-state' });
    state = accept(state, {
      type: 'record-validation',
      validationId: 'validation-failed',
      checkpointId: 'checkpoint-one',
      revisionId: 'revision-one',
      policyId: commandPolicy.policyId,
      disposition: 'failed',
      exitCode: 1,
      timedOut: false,
      workspaceChanged: false,
      outputTail: 'One focused test failed.',
    });

    expect(
      decideMission(state, {
        type: 'complete-mission',
        guideEpoch: state.guideEpoch,
        outcome: 'succeeded',
        reason: 'A failed deterministic check cannot prove success.',
        checkpointId: 'checkpoint-one',
      }),
    ).toMatchObject({ accepted: false, code: 'completion-unproved' });
    expect(
      decideMission(state, {
        type: 'record-validation',
        validationId: 'validation-retry',
        checkpointId: 'checkpoint-one',
        revisionId: 'revision-one',
        policyId: commandPolicy.policyId,
        disposition: 'passed',
        exitCode: 0,
        timedOut: false,
        workspaceChanged: false,
        outputTail: 'A rerun cannot erase the prior failure.',
      }),
    ).toMatchObject({ accepted: false, code: 'invalid-state' });
  });

  it('records preserved handoff only for the terminal revision after all cleanup completes', () => {
    const commandPolicy = {
      kind: 'command',
      policyId: 'focused-tests-v1',
      command: 'npm test',
      timeoutSeconds: 300,
      shell: null,
    } as const;
    let state = createMission({
      objective: {
        brief: 'Preserve the accepted revision.',
        repositoryKey: 'runner',
        baseRevision: 'base-revision',
      },
      completion: { requireCheckpoint: true, requireReview: false },
      cleanup: ['workspace'],
      validationPolicy: commandPolicy,
    });
    state = spawnChild(state, 'writer', { permission: 'write' });
    state = startAndComplete(state, 'writer');
    state = accept(state, {
      type: 'record-checkpoint',
      checkpointId: 'accepted-checkpoint',
      revisionId: 'accepted-revision',
      authorChildId: 'writer',
      clean: true,
    });
    state = accept(state, {
      type: 'begin-validation',
      validationId: 'accepted-validation',
      checkpointId: 'accepted-checkpoint',
      revisionId: 'accepted-revision',
      policyId: commandPolicy.policyId,
    });
    state = accept(state, {
      type: 'record-validation',
      validationId: 'accepted-validation',
      checkpointId: 'accepted-checkpoint',
      revisionId: 'accepted-revision',
      policyId: commandPolicy.policyId,
      disposition: 'passed',
      exitCode: 0,
      timedOut: false,
      workspaceChanged: false,
      outputTail: 'Focused tests passed.',
    });
    state = accept(state, {
      type: 'complete-mission',
      guideEpoch: state.guideEpoch,
      outcome: 'succeeded',
      reason: 'The exact revision passed deterministic validation.',
      checkpointId: 'accepted-checkpoint',
    });
    const handoff = {
      type: 'record-accepted-revision-handoff' as const,
      backend: 'git',
      repositoryKey: 'runner',
      checkpointId: 'accepted-checkpoint',
      revisionId: 'accepted-revision',
      reference: 'refs/noriq/accepted/mission-adversarial',
      status: 'preserved' as const,
    };
    expect(decideMission(state, handoff)).toMatchObject({ accepted: false, code: 'invalid-state' });
    state = accept(state, { type: 'complete-cleanup', cleanupId: 'workspace' });
    state = accept(state, handoff);
    expect(state.acceptedRevisionHandoff).toMatchObject({
      backend: handoff.backend,
      repositoryKey: handoff.repositoryKey,
      checkpointId: handoff.checkpointId,
      revisionId: handoff.revisionId,
      reference: handoff.reference,
      status: handoff.status,
    });
    expect(decideMission(state, handoff)).toMatchObject({ accepted: false, code: 'invalid-state' });
  });

  it('does not let a later pass erase requested changes on the same immutable checkpoint', () => {
    let state = createMission({
      completion: { requireCheckpoint: true, requireReview: true },
      profiles: [
        workerProfile('worker-write', 'write', zero, {}),
        workerProfile('reviewer', 'read', zero, {}),
      ],
    });
    state = spawnChild(state, 'builder', { permission: 'write', profileId: 'worker-write' });
    state = startAndComplete(state, 'builder');
    state = accept(state, {
      type: 'record-checkpoint',
      checkpointId: 'checkpoint-a',
      revisionId: 'revision-a',
      authorChildId: 'builder',
      clean: true,
    });

    for (const reviewer of ['reviewer-critical', 'reviewer-pass']) {
      state = spawnChild(state, reviewer, {
        profileId: 'reviewer',
        subjectCheckpointId: 'checkpoint-a',
      });
      state = startAndComplete(state, reviewer, 'succeeded', {
        type: 'review',
        checkpointId: 'checkpoint-a',
        revisionId: 'revision-a',
        verdict: reviewer === 'reviewer-critical' ? 'changes-requested' : 'passed',
        highestSeverity: reviewer === 'reviewer-critical' ? 'critical' : 'none',
        summary:
          reviewer === 'reviewer-critical'
            ? 'The revision has a critical defect.'
            : 'A second reviewer did not reproduce it.',
      });
    }
    state = accept(state, {
      type: 'record-review',
      reviewId: 'critical-review',
      reviewerChildId: 'reviewer-critical',
      checkpointId: 'checkpoint-a',
      revisionId: 'revision-a',
      verdict: 'changes-requested',
      highestSeverity: 'critical',
      summary: 'The revision has a critical defect.',
    });
    state = accept(state, {
      type: 'record-review',
      reviewId: 'later-pass',
      reviewerChildId: 'reviewer-pass',
      checkpointId: 'checkpoint-a',
      revisionId: 'revision-a',
      verdict: 'passed',
      highestSeverity: 'none',
      summary: 'A second reviewer did not reproduce it.',
    });

    expect(
      decideMission(state, {
        type: 'record-checkpoint',
        checkpointId: 'checkpoint-alias',
        revisionId: 'revision-a',
        authorChildId: 'builder',
        parentCheckpointId: 'checkpoint-a',
        clean: true,
      }),
    ).toMatchObject({ accepted: false, code: 'invalid-action' });

    expect(
      decideMission(state, {
        type: 'complete-mission',
        guideEpoch: state.guideEpoch,
        outcome: 'succeeded',
        reason: 'A later pass must not erase the earlier blocker.',
        checkpointId: 'checkpoint-a',
      }),
    ).toMatchObject({ accepted: false, code: 'completion-unproved' });
  });

  it.each([
    [
      'scope-kind',
      {
        kind: 'scope',
        permission: { write: false, allow: [], deny: [], auto: false },
        lineageRole: 'reviewer',
      },
    ],
    [
      'worker-lineage',
      {
        kind: 'verify',
        permission: { write: false, allow: [], deny: [], auto: false },
        lineageRole: 'worker',
      },
    ],
  ] as const)('rejects a checkpoint review reservation with %s posture before launch', (_label, posture) => {
    let state = createMission({
      profiles: [
        workerProfile('writer-profile', 'write', zero, {}),
        { ...workerProfile('review-profile', 'read', zero, {}), driverPosture: posture },
        workerProfile('valid-review-profile', 'read', zero, {}),
      ],
    });
    state = spawnChild(state, 'writer', { permission: 'write', profileId: 'writer-profile' });
    state = startAndComplete(state, 'writer');
    state = accept(state, {
      type: 'record-checkpoint',
      checkpointId: 'authority-checkpoint',
      revisionId: 'authority-revision',
      authorChildId: 'writer',
      clean: true,
    });
    expect(
      decideMission(
        state,
        spawnAction(state, 'reader', {
          profileId: 'review-profile',
          driverPosture: posture,
          subjectCheckpointId: 'authority-checkpoint',
        }),
      ),
    ).toMatchObject({ accepted: false, code: 'invalid-action' });
  });

  it('requires any review artifact to match the authorized child and exact immutable revision', () => {
    let state = createMission({
      profiles: [
        workerProfile('writer-profile', 'write', zero, {}),
        workerProfile('reviewer-profile', 'read', zero, {}),
      ],
    });
    state = spawnChild(state, 'writer', { permission: 'write', profileId: 'writer-profile' });
    state = startAndComplete(state, 'writer');
    state = accept(state, {
      type: 'record-checkpoint',
      checkpointId: 'artifact-checkpoint',
      revisionId: 'artifact-revision',
      authorChildId: 'writer',
      clean: true,
    });
    state = spawnChild(state, 'reviewer', {
      profileId: 'reviewer-profile',
      subjectCheckpointId: 'artifact-checkpoint',
    });
    state = accept(state, {
      type: 'start-child',
      childId: 'reviewer',
      attemptId: 'attempt-reviewer',
    });
    expect(
      decideMission(state, {
        type: 'complete-child',
        childId: 'reviewer',
        outcome: 'succeeded',
        summary: 'Reported a different revision.',
        usage: zero,
        artifact: {
          type: 'review',
          checkpointId: 'artifact-checkpoint',
          revisionId: 'wrong-revision',
          verdict: 'passed',
          highestSeverity: 'none',
          summary: 'This result cannot authorize review evidence.',
        },
      }),
    ).toMatchObject({ accepted: false, code: 'invalid-action' });

    state = accept(state, {
      type: 'complete-child',
      childId: 'reviewer',
      outcome: 'succeeded',
      summary: 'Exact review artifact.',
      usage: zero,
      artifact: {
        type: 'review',
        checkpointId: 'artifact-checkpoint',
        revisionId: 'artifact-revision',
        verdict: 'changes-requested',
        highestSeverity: 'high',
        summary: 'An exact high-severity finding remains.',
      },
    });
    expect(state.children.reviewer?.artifact).toEqual({
      type: 'review',
      checkpointId: 'artifact-checkpoint',
      revisionId: 'artifact-revision',
      verdict: 'changes-requested',
      highestSeverity: 'high',
      summary: 'An exact high-severity finding remains.',
    });
  });

  it('handles own prototype-named resources and never grants inherited capacity', () => {
    const capacities = JSON.parse('{"__proto__":1,"constructor":1,"toString":1}') as Record<string, number>;
    const request = JSON.parse('{"__proto__":1,"constructor":1,"toString":1}') as Record<string, number>;
    let state = createMission({ resources: capacities });
    expect(Object.hasOwn(state.resources, '__proto__')).toBe(true);
    state = spawnChild(state, 'holder', { resources: request });

    expect(
      decideMission(
        state,
        spawnAction(state, 'contender', {
          instruction: 'Must not exceed the prototype-named capacity.',
          resources: JSON.parse('{"__proto__":1}') as Record<string, number>,
        }),
      ),
    ).toMatchObject({ accepted: false, code: 'resource-exhausted' });

    const inherited = Object.create({ phantom: 1 }) as Record<string, number>;
    expect(
      decideMission(initialMissionState('inherited-capacity'), {
        type: 'create-mission',
        projectMcpDeclarationFingerprint: null,
        budget: unlimited,
        resources: inherited,
        guide,
        profiles: [workerProfile('phantom-user', 'read', zero, { phantom: 1 })],
        validationPolicy: noValidation,
      }),
    ).toMatchObject({ accepted: false, code: 'invalid-action' });
  });

  it('refuses reserved-to-success but accepts reserved-to-lost and releases reservations', () => {
    let state = createMission({ resources: { scarce: 1 } });
    state = spawnChild(state, 'never-started', { resources: { scarce: 1 } });

    expect(
      decideMission(state, {
        type: 'complete-child',
        childId: 'never-started',
        outcome: 'succeeded',
        summary: 'A process that never started cannot prove success.',
        usage: { tokens: 0, usd: 0, activeSeconds: 0 },
      }),
    ).toMatchObject({ accepted: false, code: 'invalid-state' });

    state = accept(state, {
      type: 'complete-child',
      childId: 'never-started',
      outcome: 'lost',
      summary: 'The reservation could not be materialized.',
      usage: { tokens: 0, usd: 0, activeSeconds: 0 },
    });
    expect(state.children['never-started']?.status).toBe('lost');
    expect(
      decideMission(
        state,
        spawnAction(state, 'replacement', {
          instruction: 'Use the released capacity.',
          resources: { scarce: 1 },
        }),
      ),
    ).toMatchObject({ accepted: true });
  });

  it('blocks later reservations until a failed write child is restored to the exact base revision', () => {
    let state = createMission({
      objective: {
        brief: 'Keep failed write residue out of later attempts.',
        baseRevision: 'base-revision',
      },
    });
    state = spawnChild(state, 'failed-writer', { permission: 'write' });
    state = startAndComplete(state, 'failed-writer', 'failed');

    expect(decideMission(state, spawnAction(state, 'later-writer', { permission: 'write' }))).toMatchObject({
      accepted: false,
      code: 'invalid-state',
      reason: expect.stringContaining('workspace reconciliation'),
    });
    expect(
      decideMission(state, {
        type: 'record-workspace-reconciled',
        childId: 'failed-writer',
        revisionId: 'wrong-revision',
        disposition: 'restored',
        summary: 'This proof names the wrong revision.',
      }),
    ).toMatchObject({ accepted: false, code: 'invalid-state' });

    state = accept(state, {
      type: 'record-workspace-reconciled',
      childId: 'failed-writer',
      revisionId: 'base-revision',
      disposition: 'restored',
      summary: 'Restored the workspace to the exact mission base.',
    });
    expect(decideMission(state, spawnAction(state, 'later-writer', { permission: 'write' }))).toMatchObject({
      accepted: true,
    });
  });

  it('accepts a clean child checkpoint automatically but requires restore after a dirty checkpoint', () => {
    let clean = createMission();
    clean = spawnChild(clean, 'clean-writer', { permission: 'write' });
    clean = startAndComplete(clean, 'clean-writer');
    expect(
      decideMission(clean, {
        type: 'record-workspace-reconciled',
        childId: 'clean-writer',
        revisionId: 'clean-revision',
        disposition: 'restored',
        summary: 'A successful child cannot skip its checkpoint.',
      }),
    ).toMatchObject({ accepted: false, code: 'invalid-state' });
    clean = accept(clean, {
      type: 'record-checkpoint',
      checkpointId: 'clean-checkpoint',
      revisionId: 'clean-revision',
      authorChildId: 'clean-writer',
      clean: true,
    });
    expect(decideMission(clean, spawnAction(clean, 'after-clean', { permission: 'write' }))).toMatchObject({
      accepted: true,
    });

    let dirty = createMission();
    dirty = spawnChild(dirty, 'dirty-writer', { permission: 'write' });
    dirty = startAndComplete(dirty, 'dirty-writer');
    dirty = accept(dirty, {
      type: 'record-checkpoint',
      checkpointId: 'dirty-checkpoint',
      revisionId: 'dirty-revision',
      authorChildId: 'dirty-writer',
      clean: false,
    });
    expect(decideMission(dirty, spawnAction(dirty, 'before-restore', { permission: 'write' }))).toMatchObject(
      {
        accepted: false,
        code: 'invalid-state',
      },
    );
    dirty = accept(dirty, {
      type: 'record-workspace-reconciled',
      childId: 'dirty-writer',
      revisionId: 'dirty-revision',
      disposition: 'restored',
      summary: 'Removed the dirty worktree residue at the exact checkpoint revision.',
    });
    expect(decideMission(dirty, spawnAction(dirty, 'after-restore', { permission: 'write' }))).toMatchObject({
      accepted: true,
    });
  });

  it('records an honest no-op checkpoint alias without letting it erase revision-governing evidence', () => {
    let state = createMission({
      objective: { brief: 'Allow a bounded no-op.', baseRevision: 'base-revision' },
    });
    state = spawnChild(state, 'first-no-op', { permission: 'write' });
    state = startAndComplete(state, 'first-no-op');
    state = accept(state, {
      type: 'record-checkpoint',
      checkpointId: 'base-alias-one',
      revisionId: 'base-revision',
      authorChildId: 'first-no-op',
      parentCheckpointId: null,
      changed: false,
      clean: true,
    });
    expect(state.checkpoints['base-alias-one']).toMatchObject({
      revisionId: 'base-revision',
      changed: false,
    });

    state = spawnChild(state, 'second-no-op', { permission: 'write' });
    state = startAndComplete(state, 'second-no-op');
    expect(
      decideMission(state, {
        type: 'record-checkpoint',
        checkpointId: 'dishonest-advance',
        revisionId: 'base-revision',
        authorChildId: 'second-no-op',
        parentCheckpointId: 'base-alias-one',
        changed: true,
        clean: true,
      }),
    ).toMatchObject({ accepted: false, code: 'invalid-action' });
    state = accept(state, {
      type: 'record-checkpoint',
      checkpointId: 'base-alias-two',
      revisionId: 'base-revision',
      authorChildId: 'second-no-op',
      parentCheckpointId: 'base-alias-one',
      changed: false,
      clean: true,
    });
    expect(state.checkpointOrder).toEqual(['base-alias-one', 'base-alias-two']);
  });

  it.each([
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
  ] as const)(
    'terminalizes a %s mission with a running child and accepts its late %s exit',
    (missionOutcome, childOutcome) => {
      let state = createMission({ cleanup: ['workspace'] });
      state = spawnChild(state, 'running-child');
      state = accept(state, {
        type: 'start-child',
        childId: 'running-child',
        attemptId: 'attempt-one',
      });

      const completion = accepted(
        decideMission(state, {
          type: 'complete-mission',
          guideEpoch: state.guideEpoch,
          outcome: missionOutcome,
          reason: `Mission ${missionOutcome} while work was in flight.`,
        }),
      );
      expect(completion.events.map((event) => event.type)).toEqual([
        'mission-completed',
        'child-cancel-requested',
        'cleanup-required',
      ]);
      state = applyEvents(state, completion.events);
      expect(state.children['running-child']?.status).toBe('cancelling');
      const terminal = state.terminal;

      state = accept(state, {
        type: 'complete-child',
        childId: 'running-child',
        outcome: childOutcome,
        summary: 'Process exit observed after logical terminalization.',
        usage: { tokens: 1, usd: null, activeSeconds: 1 },
      });
      expect(state.status).toBe(missionOutcome);
      expect(state.terminal).toEqual(terminal);
      expect(state.children['running-child']?.status).toBe(childOutcome);
    },
  );

  it('binds checkpoint lineage, authorship, review subject, and reviewer independence', () => {
    let state = createMission();
    state = spawnChild(state, 'writer', { permission: 'write' });
    state = startAndComplete(state, 'writer');

    expect(
      decideMission(state, {
        type: 'record-checkpoint',
        checkpointId: 'checkpoint-one',
        revisionId: 'git-sha-one',
        authorChildId: 'missing-writer',
        clean: true,
      }),
    ).toMatchObject({ accepted: false, code: 'invalid-state' });
    state = accept(state, {
      type: 'record-checkpoint',
      checkpointId: 'checkpoint-one',
      revisionId: 'git-sha-one',
      authorChildId: 'writer',
      clean: true,
    });

    state = spawnChild(state, 'reviewer-one', {
      permission: 'read',
      subjectCheckpointId: 'checkpoint-one',
    });
    state = startAndComplete(state, 'reviewer-one', 'succeeded', {
      type: 'review',
      checkpointId: 'checkpoint-one',
      revisionId: 'git-sha-one',
      verdict: 'passed',
      highestSeverity: 'none',
      summary: 'Independent review passed.',
    });
    expect(
      decideMission(state, {
        type: 'record-review',
        reviewId: 'wrong-revision-review',
        reviewerChildId: 'reviewer-one',
        checkpointId: 'checkpoint-one',
        revisionId: 'git-sha-other',
        verdict: 'passed',
        highestSeverity: 'none',
        summary: 'The logical checkpoint id matches, but the immutable revision does not.',
      }),
    ).toMatchObject({ accepted: false, code: 'invalid-state' });
    expect(
      decideMission(state, {
        type: 'record-review',
        reviewId: 'self-review',
        reviewerChildId: 'writer',
        checkpointId: 'checkpoint-one',
        revisionId: 'git-sha-one',
        verdict: 'passed',
        highestSeverity: 'none',
        summary: 'The author must not review its own work.',
      }),
    ).toMatchObject({ accepted: false, code: 'invalid-state' });
    state = accept(state, {
      type: 'record-review',
      reviewId: 'review-one',
      reviewerChildId: 'reviewer-one',
      checkpointId: 'checkpoint-one',
      revisionId: 'git-sha-one',
      verdict: 'passed',
      highestSeverity: 'none',
      summary: 'Independent review passed.',
    });
    expect(state.checkpoints['checkpoint-one']?.revisionId).toBe('git-sha-one');
    expect(state.reviews['review-one']?.revisionId).toBe('git-sha-one');

    state = spawnChild(state, 'writer-two', { permission: 'write' });
    state = startAndComplete(state, 'writer-two');

    expect(
      decideMission(state, {
        type: 'record-checkpoint',
        checkpointId: 'checkpoint-two',
        revisionId: 'git-sha-two',
        authorChildId: 'writer-two',
        parentCheckpointId: null,
        clean: true,
      }),
    ).toMatchObject({ accepted: false, code: 'invalid-action' });
    state = accept(state, {
      type: 'record-checkpoint',
      checkpointId: 'checkpoint-two',
      revisionId: 'git-sha-two',
      authorChildId: 'writer-two',
      parentCheckpointId: 'checkpoint-one',
      clean: true,
    });
    expect(
      decideMission(state, {
        type: 'record-review',
        reviewId: 'wrong-subject-review',
        reviewerChildId: 'reviewer-one',
        checkpointId: 'checkpoint-two',
        revisionId: 'git-sha-two',
        verdict: 'passed',
        highestSeverity: 'none',
        summary: 'This reviewer only saw checkpoint one.',
      }),
    ).toMatchObject({ accepted: false, code: 'invalid-state' });

    state = spawnChild(state, 'reviewer-two', {
      permission: 'read',
      subjectCheckpointId: 'checkpoint-two',
    });
    state = startAndComplete(state, 'reviewer-two', 'succeeded', {
      type: 'review',
      checkpointId: 'checkpoint-two',
      revisionId: 'git-sha-two',
      verdict: 'passed',
      highestSeverity: 'none',
      summary: 'A distinct reviewer inspected the exact child-two subject.',
    });
    expect(
      decideMission(state, {
        type: 'record-review',
        reviewId: 'review-two',
        reviewerChildId: 'reviewer-two',
        checkpointId: 'checkpoint-two',
        revisionId: 'git-sha-two',
        verdict: 'passed',
        highestSeverity: 'none',
        summary: 'A distinct reviewer inspected the exact child-two subject.',
      }),
    ).toMatchObject({ accepted: true });
  });

  it('blocks successful completion while an adopted execution plan is unresolved', () => {
    const plannerProfile: MissionExecutionProfile = {
      profileId: 'planner-profile',
      role: 'planner',
      permission: 'read',
      agent: { driver: 'test-driver', model: 'planner-model' },
      assurance: { rank: 2, independenceClass: 'planning' },
      driverPosture: {
        kind: 'scope',
        permission: { write: false, allow: [], deny: [], auto: false },
        lineageRole: 'planner',
      },
      budget: zero,
      resources: {},
      projectMcp: [],
    };
    const builder = workerProfile('plan-builder', 'write', zero, {});
    const reviewer = workerProfile('plan-reviewer', 'read', zero, {});
    let state = createMission({ profiles: [plannerProfile, builder, reviewer] });
    state = spawnChild(state, 'planner', {
      profileId: plannerProfile.profileId,
      role: plannerProfile.role,
      permission: plannerProfile.permission,
      agent: plannerProfile.agent,
      driverPosture: plannerProfile.driverPosture,
    });
    state = startAndComplete(state, 'planner', 'succeeded', {
      type: 'execution-plan',
      summary: 'One bounded reviewed change.',
      steps: [
        {
          id: 'step-one',
          title: 'Implement the change',
          profileId: builder.profileId,
          reviewProfileId: reviewer.profileId,
          instruction: 'Implement the bounded change.',
          acceptance: ['The exact checkpoint passes review.'],
        },
      ],
    });
    state = accept(state, {
      type: 'adopt-execution-plan',
      guideEpoch: state.guideEpoch,
      plannerChildId: 'planner',
      planFingerprint: missionExecutionPlanFingerprint(
        state.children.planner!.artifact as Parameters<typeof missionExecutionPlanFingerprint>[0],
      ),
    });

    expect(
      decideMission(state, {
        type: 'complete-mission',
        guideEpoch: state.guideEpoch,
        outcome: 'succeeded',
        reason: 'The guide must not skip unresolved adopted work.',
      }),
    ).toMatchObject({ accepted: false, code: 'completion-unproved' });
  });

  it('rejects a plan whose complete bounded repair lineage cannot fit the mission budget', () => {
    const plannerBudget: MissionBudget = { tokens: 10, usd: null, activeSeconds: null };
    const builderBudget: MissionBudget = { tokens: 20, usd: null, activeSeconds: null };
    const reviewerBudget: MissionBudget = { tokens: 5, usd: null, activeSeconds: null };
    const boundedGuide = {
      ...guide,
      budget: { tokens: 10, usd: null, activeSeconds: null },
    };
    const plannerProfile: MissionExecutionProfile = {
      profileId: 'budget-planner',
      role: 'planner',
      permission: 'read',
      agent: { driver: 'planner-driver', model: 'planner-model' },
      assurance: { rank: 2, independenceClass: 'planning' },
      driverPosture: {
        kind: 'scope',
        permission: { write: false, allow: [], deny: [], auto: false },
        lineageRole: 'planner',
      },
      budget: plannerBudget,
      resources: {},
      projectMcp: [],
    };
    const builder = workerProfile('budget-builder', 'write', builderBudget, {});
    const reviewer = workerProfile('budget-reviewer', 'read', reviewerBudget, {});
    const artifact = {
      type: 'execution-plan' as const,
      summary: 'One step with a fully reserved repair lineage.',
      steps: [
        {
          id: 'bounded-step',
          title: 'Implement and review',
          profileId: builder.profileId,
          reviewProfileId: reviewer.profileId,
          instruction: 'Implement the bounded change.',
          acceptance: ['The exact checkpoint passes independent review.'],
        },
      ],
    };
    const completionDecision = (missionTokens: number) => {
      let state = createMission({
        budget: { tokens: missionTokens, usd: null, activeSeconds: null },
        guide: boundedGuide,
        profiles: [plannerProfile, builder, reviewer],
      });
      state = spawnChild(state, 'budget-planner-child', {
        profileId: plannerProfile.profileId,
        role: plannerProfile.role,
        permission: plannerProfile.permission,
        agent: plannerProfile.agent,
        driverPosture: plannerProfile.driverPosture,
        budget: plannerProfile.budget,
      });
      state = accept(state, {
        type: 'start-child',
        childId: 'budget-planner-child',
        attemptId: 'budget-planner-attempt',
      });
      return {
        state,
        decision: decideMission(state, {
          type: 'complete-child',
          childId: 'budget-planner-child',
          outcome: 'succeeded',
          summary: 'Produced a budgeted plan.',
          usage: { tokens: 5, usd: 0, activeSeconds: 1 },
          artifact,
        }),
      };
    };

    const unaffordable = completionDecision(99).decision;
    expect(unaffordable).toMatchObject({ accepted: false, code: 'invalid-action' });
    expect(unaffordable.accepted ? '' : unaffordable.reason).toContain('only 94 remain');

    const exact = completionDecision(100);
    expect(exact.decision).toMatchObject({ accepted: true });
    if (!exact.decision.accepted) throw new Error(exact.decision.reason);
    const completed = applyEvents(exact.state, exact.decision.events);
    expect(
      decideMission(completed, {
        type: 'adopt-execution-plan',
        guideEpoch: completed.guideEpoch,
        plannerChildId: 'budget-planner-child',
        planFingerprint: missionExecutionPlanFingerprint(artifact),
      }),
    ).toMatchObject({ accepted: true });
  });

  it('refuses planner artifacts that omit review or select an equal, coupled, or self-equivalent reviewer', () => {
    const plannerProfile: MissionExecutionProfile = {
      profileId: 'policy-planner',
      role: 'planner',
      permission: 'read',
      agent: { driver: 'planner-driver', model: 'planner-model' },
      assurance: { rank: 3, independenceClass: 'planning' },
      driverPosture: {
        kind: 'scope',
        permission: { write: false, allow: [], deny: [], auto: false },
        lineageRole: 'planner',
      },
      budget: zero,
      resources: {},
      projectMcp: [],
    };
    const builder = {
      ...workerProfile('policy-builder', 'write', zero, {}),
      assurance: { rank: 2, independenceClass: 'build' },
    };
    const validReviewer = {
      ...workerProfile('policy-reviewer', 'read', zero, {}),
      assurance: { rank: 3, independenceClass: 'independent-review' },
    };
    const invalidReviewers: Array<[string, MissionExecutionProfile | null]> = [
      ['omitted review', null],
      [
        'equal rank',
        {
          ...workerProfile('equal-reviewer', 'read', zero, {}),
          assurance: { rank: 2, independenceClass: 'equal-review' },
        },
      ],
      [
        'coupled independence class',
        {
          ...workerProfile('coupled-reviewer', 'read', zero, {}),
          assurance: { rank: 3, independenceClass: builder.assurance.independenceClass },
        },
      ],
      [
        'self-equivalent coordinate',
        {
          ...workerProfile('equivalent-reviewer', 'read', zero, {}),
          agent: { ...builder.agent },
          assurance: { rank: 3, independenceClass: 'equivalent-review' },
        },
      ],
    ];

    for (const [label, invalidReviewer] of invalidReviewers) {
      let state = createMission({
        profiles: [plannerProfile, builder, validReviewer, ...(invalidReviewer ? [invalidReviewer] : [])],
      });
      state = spawnChild(state, 'policy-planner-child', {
        profileId: plannerProfile.profileId,
        role: plannerProfile.role,
        permission: plannerProfile.permission,
        agent: plannerProfile.agent,
        driverPosture: plannerProfile.driverPosture,
      });
      state = accept(state, {
        type: 'start-child',
        childId: 'policy-planner-child',
        attemptId: 'policy-planner-attempt',
      });
      const decision = decideMission(state, {
        type: 'complete-child',
        childId: 'policy-planner-child',
        outcome: 'succeeded',
        summary: `Planner proposed ${label}.`,
        usage: zero,
        artifact: {
          type: 'execution-plan',
          summary: 'One mutation that must receive independent stronger review.',
          steps: [
            {
              id: 'policy-step',
              title: 'Mutate safely',
              profileId: builder.profileId,
              ...(invalidReviewer ? { reviewProfileId: invalidReviewer.profileId } : {}),
              instruction: 'Make the bounded mutation.',
              acceptance: ['Independent stronger review passes.'],
            },
          ],
        },
      });
      expect(decision, label).toMatchObject({ accepted: false, code: 'invalid-action' });
      expect(decision.accepted ? '' : decision.reason, label).toMatch(
        /independent stronger review profile|higher assurance rank/,
      );
    }
  });

  it('does not confuse a replacement plan with superseded work that reused a step id', () => {
    const plannerProfile: MissionExecutionProfile = {
      profileId: 'planner-profile',
      role: 'planner',
      permission: 'read',
      agent: { driver: 'test-driver', model: 'planner-model' },
      assurance: { rank: 2, independenceClass: 'planning' },
      driverPosture: {
        kind: 'scope',
        permission: { write: false, allow: [], deny: [], auto: false },
        lineageRole: 'planner',
      },
      budget: zero,
      resources: {},
      projectMcp: [],
    };
    const builder = workerProfile('plan-builder', 'write', zero, {});
    const reviewer = workerProfile('plan-reviewer', 'read', zero, {});
    let state = createMission({ profiles: [plannerProfile, builder, reviewer] });
    const artifact = {
      type: 'execution-plan' as const,
      summary: 'One replacement-safe step.',
      steps: [
        {
          id: 'shared-human-id',
          title: 'Implement the change',
          profileId: builder.profileId,
          reviewProfileId: reviewer.profileId,
          instruction: 'Implement the bounded change.',
          acceptance: ['Focused tests pass.'],
        },
      ],
    };

    for (const plannerChildId of ['planner-one', 'planner-two']) {
      state = spawnChild(state, plannerChildId, {
        profileId: plannerProfile.profileId,
        role: plannerProfile.role,
        permission: plannerProfile.permission,
        agent: plannerProfile.agent,
        driverPosture: plannerProfile.driverPosture,
      });
      state = startAndComplete(state, plannerChildId, 'succeeded', artifact);
      state = accept(state, {
        type: 'adopt-execution-plan',
        guideEpoch: state.guideEpoch,
        plannerChildId,
        planFingerprint: missionExecutionPlanFingerprint(artifact),
      });
      if (plannerChildId === 'planner-one') {
        const failedOldWorker = missionPlanChildId(
          state.missionId,
          plannerChildId,
          'shared-human-id',
          'work',
          0,
        );
        state = spawnChild(state, failedOldWorker, {
          profileId: builder.profileId,
          role: builder.role,
          permission: builder.permission,
          agent: builder.agent,
          driverPosture: builder.driverPosture,
          planStepId: missionPlanStepKey(state.missionId, plannerChildId, 'shared-human-id'),
        });
        state = startAndComplete(state, failedOldWorker, 'failed');
        state = accept(state, {
          type: 'record-workspace-reconciled',
          childId: failedOldWorker,
          revisionId: 'replacement-plan-base',
          disposition: 'restored',
          summary: 'Restored the mission workspace before adopting replacement work.',
        });
      }
    }

    const oldKey = missionPlanStepKey(state.missionId, 'planner-one', 'shared-human-id');
    const currentKey = missionPlanStepKey(state.missionId, 'planner-two', 'shared-human-id');
    expect(
      decideMission(
        state,
        spawnAction(state, 'stale-plan-worker', {
          profileId: builder.profileId,
          role: builder.role,
          permission: builder.permission,
          agent: builder.agent,
          driverPosture: builder.driverPosture,
          planStepId: oldKey,
        }),
      ),
    ).toMatchObject({ accepted: false, code: 'invalid-action' });
    expect(
      decideMission(
        state,
        spawnAction(state, missionPlanChildId(state.missionId, 'planner-two', 'shared-human-id', 'work', 0), {
          profileId: builder.profileId,
          role: builder.role,
          permission: builder.permission,
          agent: builder.agent,
          driverPosture: builder.driverPosture,
          planStepId: currentKey,
        }),
      ),
    ).toMatchObject({ accepted: true });
  });

  it('keeps maximum-child terminal cancellation fan-out within the durable event-batch bound', () => {
    let state = createMission();
    for (let index = 0; index < 256; index += 1) {
      state = spawnChild(state, String(index), { profileId: 'worker-write', permission: 'write' });
    }
    const action = {
      type: 'complete-mission' as const,
      guideEpoch: state.guideEpoch,
      outcome: 'failed' as const,
      reason: 'terminal failure detail '.repeat(2_780).slice(0, 64_000),
    };
    const decision = accepted(decideMission(state, action));
    const cancellations = decision.events.filter((event) => event.type === 'child-cancel-requested');

    expect(cancellations).toHaveLength(256);
    expect(cancellations.map((event) => event.childId)).toEqual(
      Array.from({ length: 256 }, (_value, index) => String(index)),
    );
    expect(cancellations.every((event) => event.reason.length <= 4_096)).toBe(true);
    expect(() =>
      createStoredMissionAction(
        {
          missionId: state.missionId,
          expectedRevision: state.revision,
          actionId: 'bounded-terminal-fanout',
          action,
        },
        decision.events,
        state.revision + 1,
        null,
        '2026-08-12T00:00:00.000Z',
      ),
    ).not.toThrow();
  });
});
