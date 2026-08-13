import { describe, expect, it } from 'vitest';
import { initialMissionState } from '../src/mission/model';
import type {
  ChildReservedEvent,
  ChildUsageObservedEvent,
  MissionCreatedEvent,
} from '../src/mission/protocol';
import { applyMissionEvent } from '../src/mission/reducer';

const buildPosture = {
  kind: 'build',
  permission: { write: true, allow: [], deny: [], auto: false },
  lineageRole: 'worker',
} as const;
const PROJECT_MCP_FINGERPRINT = 'a'.repeat(64);
const guide = {
  profileId: 'guide',
  agent: { driver: 'test-guide', model: 'guide-model' },
  budget: { tokens: 10, usd: 1, activeSeconds: 10 },
  turnLimit: 20,
};

describe('mission reducer ownership', () => {
  it('does not retain aliases to mutable mission-created event input', () => {
    const objective = { brief: 'Original objective', taskId: 'TASK-1' };
    const budget = { tokens: 100, usd: 10, activeSeconds: 60 };
    const resources = JSON.parse('{"__proto__":1,"editor":2}') as Record<string, number>;
    const completion = { requireCheckpoint: true, requireReview: true };
    const cleanup = ['workspace', 'lease'];
    const validationPolicy = {
      kind: 'command' as const,
      policyId: 'test-command-v1',
      command: 'npm test',
      timeoutSeconds: 300,
      shell: null,
    };
    const profileAgent = { driver: 'test-worker', model: 'builder-model' };
    const profileBudget = { tokens: 20, usd: 2, activeSeconds: 30 };
    const profileResources = { editor: 1 };
    const profileTools = ['inspect'];
    const profiles = [
      {
        profileId: 'builder',
        role: 'builder',
        permission: 'write' as const,
        agent: profileAgent,
        assurance: { rank: 1, independenceClass: 'build' },
        driverPosture: buildPosture,
        budget: profileBudget,
        resources: profileResources,
        projectMcp: [{ server: 'project', tools: profileTools }],
      },
    ];
    const event: MissionCreatedEvent = {
      type: 'mission-created',
      projectMcpDeclarationFingerprint: PROJECT_MCP_FINGERPRINT,
      objective,
      budget,
      resources,
      guide,
      profiles,
      validationPolicy,
      completion,
      cleanup,
    };

    const state = applyMissionEvent(initialMissionState('mission-one'), event, 1);
    objective.brief = 'Mutated objective';
    budget.tokens = 999;
    resources.editor = 999;
    resources.__proto__ = 999;
    completion.requireCheckpoint = false;
    cleanup[0] = 'mutated-cleanup';
    validationPolicy.command = 'false';
    profileAgent.driver = 'mutated-driver';
    profileBudget.tokens = 999;
    profileResources.editor = 999;
    profileTools[0] = 'mutated-tool';

    expect(state.objective).toEqual({ brief: 'Original objective', taskId: 'TASK-1' });
    expect(state.budget).toEqual({ tokens: 100, usd: 10, activeSeconds: 60 });
    expect(state.resources.editor).toBe(2);
    expect(state.resources.__proto__).toBe(1);
    expect(state.completion).toEqual({ requireCheckpoint: true, requireReview: true });
    expect(state.cleanupPlan).toEqual(['workspace', 'lease']);
    expect(state.validationPolicy).toEqual({
      kind: 'command',
      policyId: 'test-command-v1',
      command: 'npm test',
      timeoutSeconds: 300,
      shell: null,
    });
    expect(state.profiles.builder).toMatchObject({
      agent: { driver: 'test-worker', model: 'builder-model' },
      budget: { tokens: 20, usd: 2, activeSeconds: 30 },
      resources: { editor: 1 },
      projectMcp: [{ server: 'project', tools: ['inspect'] }],
    });
  });

  it('copies nested child reservation and usage values out of journal events', () => {
    let state = applyMissionEvent(
      initialMissionState('mission-one'),
      {
        type: 'mission-created',
        projectMcpDeclarationFingerprint: null,
        budget: { tokens: null, usd: null, activeSeconds: null },
        resources: { editor: 1 },
        guide,
        profiles: [
          {
            profileId: 'builder',
            role: 'builder',
            permission: 'write',
            agent: { driver: 'test-driver', model: 'builder-model' },
            assurance: { rank: 1, independenceClass: 'build' },
            driverPosture: buildPosture,
            budget: { tokens: 20, usd: 2, activeSeconds: 30 },
            resources: { editor: 1 },
            projectMcp: [],
          },
        ],
        validationPolicy: { kind: 'none', policyId: 'none-v1', reason: 'No deterministic command.' },
      },
      1,
    );
    const agent = { driver: 'test-driver', model: 'builder-model' };
    const budget = { tokens: 20, usd: 2, activeSeconds: 30 };
    const resources = { editor: 1 };
    const reservation: ChildReservedEvent = {
      type: 'child-reserved',
      guideEpoch: 0,
      child: {
        childId: 'builder',
        role: 'builder',
        instruction: 'Build the bounded change.',
        permission: 'write',
        profileId: 'builder',
        agent,
        driverPosture: buildPosture,
        budget,
        resources,
        projectMcp: [],
      },
    };
    state = applyMissionEvent(state, reservation, 2);
    agent.driver = 'mutated-driver';
    budget.tokens = 999;
    resources.editor = 999;

    expect(state.children.builder).toMatchObject({
      agent: { driver: 'test-driver', model: 'builder-model' },
      budget: { tokens: 20, usd: 2, activeSeconds: 30 },
      resources: { editor: 1 },
    });

    state = applyMissionEvent(
      state,
      { type: 'child-started', childId: 'builder', attemptId: 'attempt-one' },
      3,
    );
    const usage = { tokens: 5, usd: 0.5, activeSeconds: 4 };
    const observation: ChildUsageObservedEvent = {
      type: 'child-usage-observed',
      childId: 'builder',
      usage,
    };
    const observed = applyMissionEvent(state, observation, 4);
    usage.tokens = 777;
    usage.usd = 77;

    expect(observed.children.builder?.usage).toEqual({ tokens: 5, usd: 0.5, activeSeconds: 4 });
    expect(observed.usage).toEqual({ tokens: 5, usd: 0.5, activeSeconds: 4 });
  });

  it('folds validation and accepted revision handoff as durable detached facts', () => {
    let state = applyMissionEvent(
      initialMissionState('mission-one'),
      {
        type: 'mission-created',
        projectMcpDeclarationFingerprint: null,
        objective: { brief: 'Preserve accepted work.', repositoryKey: 'runner' },
        budget: { tokens: null, usd: null, activeSeconds: null },
        resources: {},
        guide,
        profiles: [
          {
            profileId: 'reviewer',
            role: 'reviewer',
            permission: 'read',
            agent: { driver: 'test-driver', model: 'review-model' },
            assurance: { rank: 2, independenceClass: 'review' },
            driverPosture: {
              kind: 'verify',
              permission: { write: false, allow: [], deny: [], auto: false },
              lineageRole: 'reviewer',
            },
            budget: { tokens: 20, usd: 2, activeSeconds: 30 },
            resources: {},
            projectMcp: [],
          },
        ],
        validationPolicy: { kind: 'none', policyId: 'none-v1', reason: 'Explicitly waived.' },
      },
      1,
    );
    state = applyMissionEvent(
      state,
      {
        type: 'validation-recorded',
        validationId: 'validation-1',
        checkpointId: null,
        revisionId: null,
        policyId: 'none-v1',
        disposition: 'not-applicable',
        exitCode: null,
        timedOut: false,
        workspaceChanged: false,
        outputTail: '',
      },
      2,
    );
    state = applyMissionEvent(
      state,
      {
        type: 'accepted-revision-handoff-recorded',
        backend: 'git',
        repositoryKey: 'runner',
        checkpointId: 'checkpoint-1',
        revisionId: 'revision-1',
        reference: 'refs/noriq/accepted/mission-one',
        status: 'preserved',
      },
      3,
    );

    expect(state.validationOrder).toEqual(['validation-1']);
    expect(state.validations['validation-1']).toMatchObject({
      policyId: 'none-v1',
      disposition: 'not-applicable',
      checkpointId: null,
    });
    expect(state.acceptedRevisionHandoff).toEqual({
      backend: 'git',
      repositoryKey: 'runner',
      checkpointId: 'checkpoint-1',
      revisionId: 'revision-1',
      reference: 'refs/noriq/accepted/mission-one',
      status: 'preserved',
    });
  });
});
