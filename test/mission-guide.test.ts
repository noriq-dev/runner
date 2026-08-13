import { describe, expect, it } from 'vitest';
import { decideMission } from '../src/mission/decide';
import { parseMissionGuideEnvelope, translateMissionGuideAction } from '../src/mission/guide-protocol';
import { renderMissionGuidePrompt } from '../src/mission/harness';
import { initialMissionState } from '../src/mission/model';
import { missionExecutionPlanFingerprint, missionPlanStepKey } from '../src/mission/plan-identity';
import {
  DEFAULT_MISSION_GUIDE_PROJECTION_CHARS,
  DEFAULT_PENDING_PLAN_GUIDE_PROJECTION_CHARS,
  projectMissionForGuide,
} from '../src/mission/projection';
import {
  MAX_MISSION_EXECUTION_PLAN_BYTES,
  type MissionAction,
  type MissionExecutionPlanArtifact,
} from '../src/mission/protocol';
import { applyMissionEvent } from '../src/mission/reducer';

const PROJECT_MCP_FINGERPRINT = 'a'.repeat(64);

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
  agent: { driver: 'guide-driver', model: 'guide-model' },
  budget: { tokens: 500, usd: 1, activeSeconds: 60 },
  turnLimit: 20,
} as const;
const profiles = [
  {
    profileId: 'builder',
    role: 'builder',
    permission: 'write',
    agent: { driver: 'local-driver', model: 'small-model' },
    assurance: { rank: 1, independenceClass: 'build' },
    driverPosture: buildPosture,
    budget: { tokens: 1_000, usd: 1, activeSeconds: 60 },
    resources: {},
    projectMcp: [{ server: 'project-tools', tools: ['inspect', 'edit'] }],
  },
  {
    profileId: 'reviewer',
    role: 'reviewer',
    permission: 'read',
    agent: { driver: 'driver', model: 'review-model' },
    assurance: { rank: 2, independenceClass: 'independent-review' },
    driverPosture: reviewPosture,
    budget: { tokens: 100, usd: null, activeSeconds: 10 },
    resources: {},
    projectMcp: [],
  },
] as const;

const dispatch = {
  missionId: 'mission-1',
  guideEpoch: 2,
  expectedRevision: 7,
  actionId: 'guide-8',
  action: {
    type: 'dispatch_child',
    childId: 'worker-1',
    profileId: 'builder',
    instruction: 'Implement the bounded change.',
  },
} as const;

const guideState = () =>
  applyMissionEvent(
    initialMissionState('mission-1'),
    {
      type: 'mission-created',
      projectMcpDeclarationFingerprint: PROJECT_MCP_FINGERPRINT,
      budget: { tokens: 10_000, usd: 10, activeSeconds: 600 },
      resources: {},
      guide,
      profiles,
      validationPolicy: {
        kind: 'none',
        policyId: 'test-no-validation',
        reason: 'No deterministic validation is configured for this protocol fixture.',
      },
      completion: { requireCheckpoint: false, requireReview: false },
    },
    1,
  );

describe('mission guide protocol', () => {
  it('accepts one exact JSON envelope and translates it to a kernel proposal', () => {
    const parsed = parseMissionGuideEnvelope(JSON.stringify(dispatch));
    expect(parsed).toMatchObject({ ok: true, envelope: dispatch });
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(
      translateMissionGuideAction(
        guideState(),
        parsed.envelope.actionId,
        parsed.envelope.guideEpoch,
        parsed.envelope.action,
      ),
    ).toEqual({
      ok: true,
      action: {
        type: 'spawn-child',
        guideEpoch: 2,
        childId: 'worker-1',
        profileId: 'builder',
        role: 'builder',
        instruction: 'Implement the bounded change.',
        permission: 'write',
        agent: { driver: 'local-driver', model: 'small-model' },
        driverPosture: buildPosture,
        budget: { tokens: 1_000, usd: 1, activeSeconds: 60 },
        resources: {},
        projectMcp: [{ server: 'project-tools', tools: ['inspect', 'edit'] }],
        planStepId: null,
      },
    });
  });

  it('refuses an unknown profile and never lets the guide manufacture authority', () => {
    const parsed = parseMissionGuideEnvelope(
      JSON.stringify({
        ...dispatch,
        action: { ...dispatch.action, profileId: 'not-offered' },
      }),
    );
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(
      translateMissionGuideAction(
        guideState(),
        parsed.envelope.actionId,
        parsed.envelope.guideEpoch,
        parsed.envelope.action,
      ),
    ).toEqual({ ok: false, reason: "unknown execution profile 'not-offered'" });
  });

  it('requires exact checkpoint subjects only on authorized review profiles', () => {
    let state = guideState();
    state = applyMissionEvent(
      state,
      {
        type: 'checkpoint-recorded',
        checkpointId: 'subject-checkpoint',
        revisionId: 'subject-revision',
        authorChildId: null,
        clean: true,
      },
      state.revision + 1,
    );

    expect(
      translateMissionGuideAction(state, 'bad-worker-subject', state.guideEpoch, {
        type: 'dispatch_child',
        childId: 'worker-with-subject',
        profileId: 'builder',
        instruction: 'This build profile must not impersonate a reviewer.',
        subjectCheckpointId: 'subject-checkpoint',
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('authorized read-only reviewer') });
    expect(
      translateMissionGuideAction(state, 'missing-review-subject', state.guideEpoch, {
        type: 'dispatch_child',
        childId: 'reviewer-without-subject',
        profileId: 'reviewer',
        instruction: 'This review is missing its immutable subject.',
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('requires an exact checkpoint subject') });
  });

  it.each([
    ['prose around JSON', `result: ${JSON.stringify(dispatch)}`],
    ['a code fence', `\`\`\`json\n${JSON.stringify(dispatch)}\n\`\`\``],
    ['an unknown action', JSON.stringify({ ...dispatch, action: { type: 'shell', command: 'true' } })],
    ['an extra field', JSON.stringify({ ...dispatch, authority: 'complete-it-yourself' })],
    [
      'an authority field',
      JSON.stringify({ ...dispatch, action: { ...dispatch.action, permission: 'write' } }),
    ],
    ['an oversized action id', JSON.stringify({ ...dispatch, actionId: 'x'.repeat(161) })],
  ])('refuses %s', (_label, output) => {
    expect(parseMissionGuideEnvelope(output).ok).toBe(false);
  });
});

describe('guide projection', () => {
  const addCompletedPlanner = (
    state: ReturnType<typeof guideState>,
    childId: string,
    instruction: string,
    planOverride?: MissionExecutionPlanArtifact,
  ) => {
    const plan: MissionExecutionPlanArtifact = planOverride ?? {
      type: 'execution-plan' as const,
      summary: `Plan from ${childId}.`,
      steps: [
        {
          id: 'step',
          title: 'Implement',
          profileId: 'builder',
          instruction,
          acceptance: ['The exact requested behavior is verified.'],
        },
      ],
    };
    let next = applyMissionEvent(
      state,
      {
        type: 'child-reserved',
        guideEpoch: state.guideEpoch,
        child: {
          childId,
          role: 'planner',
          instruction: 'Produce one bounded plan.',
          permission: 'read',
          profileId: 'reviewer',
          agent: profiles[1].agent,
          driverPosture: {
            kind: 'scope',
            permission: { write: false, allow: [], deny: [], auto: false },
            lineageRole: 'planner',
          },
          budget: profiles[1].budget,
          resources: {},
          projectMcp: [],
        },
      },
      state.revision + 1,
    );
    next = applyMissionEvent(
      next,
      {
        type: 'child-completed',
        childId,
        outcome: 'succeeded',
        summary: 'Planner returned a plan.',
        usage: { tokens: 1, usd: 0, activeSeconds: 1 },
        artifact: plan,
      },
      next.revision + 1,
    );
    return { state: next, plan };
  };

  it('projects every pending plan field, binds adoption to its fingerprint, and never reoffers it', () => {
    const first = addCompletedPlanner(guideState(), 'planner-a', 'Implement only A.');
    const firstFingerprint = missionExecutionPlanFingerprint(first.plan);
    const firstProjection = projectMissionForGuide(first.state);
    expect(firstProjection.pendingPlan).toEqual({
      plannerChildId: 'planner-a',
      planFingerprint: firstFingerprint,
      plan: first.plan,
    });
    expect(
      translateMissionGuideAction(first.state, 'adopt-a', first.state.guideEpoch, {
        type: 'adopt_plan',
        plannerChildId: 'planner-a',
        planFingerprint: '0'.repeat(64),
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('fingerprint') });

    const second = addCompletedPlanner(first.state, 'planner-b', 'Implement only B.');
    const state = applyMissionEvent(
      second.state,
      {
        type: 'execution-plan-adopted',
        plannerChildId: 'planner-b',
        guideEpoch: second.state.guideEpoch,
        planFingerprint: missionExecutionPlanFingerprint(second.plan),
        plan: second.plan,
      },
      second.state.revision + 1,
    );
    expect(projectMissionForGuide(state).pendingPlan).toBeNull();
    expect(
      decideMission(state, {
        type: 'adopt-execution-plan',
        guideEpoch: state.guideEpoch,
        plannerChildId: 'planner-a',
        planFingerprint: firstFingerprint,
      }),
    ).toMatchObject({ accepted: false, reason: expect.stringMatching(/adopted|superseded/) });
  });

  it('keeps complete near-limit pending-plan authority inside the larger one-turn phase bound', () => {
    const plan: MissionExecutionPlanArtifact = {
      type: 'execution-plan',
      summary: 's'.repeat(6_000),
      steps: Array.from({ length: 10 }, (_, index) => ({
        id: `step-${index}`,
        title: `Bounded step ${index}`,
        profileId: 'builder',
        instruction: `${index}:`.padEnd(3_500, 'i'),
        acceptance: [`Step ${index} is verified.`],
      })),
    };
    const planBytes = Buffer.byteLength(JSON.stringify(plan), 'utf8');
    expect(planBytes).toBeGreaterThan(40 * 1024);
    expect(planBytes).toBeLessThanOrEqual(MAX_MISSION_EXECUTION_PLAN_BYTES);

    const planned = addCompletedPlanner(guideState(), 'planner-near-limit', 'unused', plan);
    const projection = projectMissionForGuide(planned.state);
    expect(JSON.stringify(projection).length).toBeLessThanOrEqual(
      DEFAULT_PENDING_PLAN_GUIDE_PROJECTION_CHARS,
    );
    expect(projection.pendingPlan).toEqual({
      plannerChildId: 'planner-near-limit',
      planFingerprint: missionExecutionPlanFingerprint(plan),
      plan,
    });
  });

  it('exposes bounded durable workspace reconciliation and reopens profile dispatchability', () => {
    let state = guideState();
    state = applyMissionEvent(
      state,
      {
        type: 'child-reserved',
        guideEpoch: state.guideEpoch,
        child: {
          childId: 'failed-writer',
          role: 'builder',
          instruction: 'Attempt the write.',
          permission: 'write',
          profileId: 'builder',
          agent: profiles[0].agent,
          driverPosture: buildPosture,
          budget: profiles[0].budget,
          resources: {},
          projectMcp: profiles[0].projectMcp,
        },
      },
      state.revision + 1,
    );
    state = applyMissionEvent(
      state,
      {
        type: 'child-completed',
        childId: 'failed-writer',
        outcome: 'failed',
        summary: 'The write failed.',
        usage: { tokens: 1, usd: 0, activeSeconds: 1 },
      },
      state.revision + 1,
    );
    expect(projectMissionForGuide(state).profiles[0]).toMatchObject({
      dispatchable: false,
      unavailableReason: expect.stringContaining('workspace reconciliation'),
    });

    state = applyMissionEvent(
      state,
      {
        type: 'workspace-reconciled',
        childId: 'failed-writer',
        revisionId: 'base-revision',
        disposition: 'quarantined',
        summary: 'q'.repeat(100),
      },
      state.revision + 1,
    );
    const projection = projectMissionForGuide(state, { maxSummaryChars: 20 });
    expect(projection.children[0]?.workspaceReconciliation).toEqual({
      source: 'harness',
      revisionId: 'base-revision',
      disposition: 'quarantined',
      summary: expect.stringMatching(/^q+\[truncated\]$/),
    });
    expect(projection.profiles[0]).toMatchObject({ dispatchable: true, unavailableReason: null });
  });

  it('carries the prior refusal into a replacement guide turn and exposes dispatchability hints', () => {
    let state = guideState();
    state = applyMissionEvent(
      state,
      {
        type: 'guide-turn-started',
        turnId: 'failed-turn',
        guideEpoch: state.guideEpoch,
        profileId: guide.profileId,
        budget: guide.budget,
      },
      state.revision + 1,
    );
    state = applyMissionEvent(
      state,
      {
        type: 'guide-turn-completed',
        turnId: 'failed-turn',
        outcome: 'failed',
        summary: 'guide output did not match the exact schema',
        usage: { tokens: 1, usd: 0, activeSeconds: 1 },
        proposal: null,
      },
      state.revision + 1,
    );
    state = applyMissionEvent(
      state,
      {
        type: 'guide-replaced',
        previousGuideEpoch: state.guideEpoch,
        guideEpoch: state.guideEpoch + 1,
        reason: 'Use one exact JSON action envelope on the replacement turn.',
      },
      state.revision + 1,
    );
    state = applyMissionEvent(
      state,
      {
        type: 'guide-turn-started',
        turnId: 'replacement-turn',
        guideEpoch: state.guideEpoch,
        profileId: guide.profileId,
        budget: guide.budget,
      },
      state.revision + 1,
    );

    const projection = projectMissionForGuide(state);
    expect(projection.guideTurns).toMatchObject({
      runningTurnId: 'replacement-turn',
      lastFeedback: {
        status: 'rejected',
        summary: 'Use one exact JSON action envelope on the replacement turn.',
      },
    });
    expect(projection.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ profileId: 'builder', dispatchable: true, unavailableReason: null }),
        expect.objectContaining({
          profileId: 'reviewer',
          dispatchable: false,
          unavailableReason: expect.stringContaining('checkpoint'),
        }),
      ]),
    );
  });

  it('contains bounded evidence, exact checkpoint review, and no child instruction/transcript', () => {
    let state = initialMissionState('mission-1');
    state = applyMissionEvent(
      state,
      {
        type: 'mission-created',
        projectMcpDeclarationFingerprint: PROJECT_MCP_FINGERPRINT,
        objective: { brief: 'x'.repeat(100) },
        budget: { tokens: 10_000, usd: 10, activeSeconds: 600 },
        resources: {},
        guide,
        profiles,
        validationPolicy: {
          kind: 'none',
          policyId: 'test-no-validation',
          reason: 'No deterministic validation is configured for this projection fixture.',
        },
        completion: { requireCheckpoint: true, requireReview: true },
      },
      1,
    );
    state = applyMissionEvent(
      state,
      {
        type: 'child-reserved',
        guideEpoch: 0,
        child: {
          childId: 'reviewer-1',
          role: 'reviewer',
          instruction: 'untrusted long private instruction',
          permission: 'read',
          profileId: 'reviewer',
          agent: { driver: 'driver', model: 'review-model' },
          driverPosture: reviewPosture,
          budget: { tokens: 100, usd: null, activeSeconds: 10 },
          resources: {},
          projectMcp: [],
        },
      },
      2,
    );
    state = applyMissionEvent(
      state,
      {
        type: 'child-completed',
        childId: 'reviewer-1',
        outcome: 'succeeded',
        summary: 's'.repeat(100),
        usage: { tokens: 5, usd: null, activeSeconds: 1 },
        artifact: {
          type: 'review',
          checkpointId: 'artifact-checkpoint',
          revisionId: 'artifact-revision',
          verdict: 'changes-requested',
          highestSeverity: 'high',
          summary: 'a'.repeat(100),
        },
      },
      3,
    );
    state = applyMissionEvent(
      state,
      {
        type: 'checkpoint-recorded',
        checkpointId: 'commit-a',
        revisionId: 'git-sha-a',
        authorChildId: null,
        clean: true,
      },
      4,
    );
    state = applyMissionEvent(
      state,
      {
        type: 'review-recorded',
        reviewId: 'blocking-review',
        reviewerChildId: 'reviewer-1',
        checkpointId: 'commit-a',
        revisionId: 'git-sha-a',
        verdict: 'changes-requested',
        highestSeverity: 'high',
        summary: 'A high-severity defect remains open.',
      },
      5,
    );
    state = applyMissionEvent(
      state,
      {
        type: 'review-recorded',
        reviewId: 'later-pass',
        reviewerChildId: 'reviewer-1',
        checkpointId: 'commit-a',
        revisionId: 'git-sha-a',
        verdict: 'passed',
        highestSeverity: 'none',
        summary: 'r'.repeat(100),
      },
      6,
    );

    const projection = projectMissionForGuide(state, {
      maxChildren: 1,
      maxSummaryChars: 30,
      maxObjectiveChars: 20,
    });
    expect(projection.objective?.brief).toHaveLength(20);
    expect(projection.children).toHaveLength(1);
    expect(projection.children[0]?.summary).toHaveLength(30);
    expect(projection.children[0]?.artifact?.summary).toHaveLength(30);
    expect(projection.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ profileId: 'builder', kind: 'build', lineageRole: 'worker' }),
        expect.objectContaining({ profileId: 'reviewer', kind: 'verify', lineageRole: 'reviewer' }),
      ]),
    );
    expect(projection.checkpoint).toMatchObject({
      checkpointId: 'commit-a',
      revisionId: 'git-sha-a',
      review: {
        reviewerChildId: 'reviewer-1',
        reviewId: 'blocking-review',
        revisionId: 'git-sha-a',
        verdict: 'changes-requested',
      },
    });
    expect(JSON.stringify(projection)).not.toContain('untrusted long private instruction');
    expect(JSON.stringify(projection)).not.toContain('small-model');
    expect(JSON.stringify(projection)).not.toContain('inspect');
    expect(projection.guideTurns.lastFeedback).toBeNull();
  });

  it('exposes bounded validation and preserved-handoff facts without rendering the command', () => {
    let state = applyMissionEvent(
      initialMissionState('mission-validation-projection'),
      {
        type: 'mission-created',
        projectMcpDeclarationFingerprint: PROJECT_MCP_FINGERPRINT,
        objective: { brief: 'Project bounded terminal evidence.', repositoryKey: 'runner' },
        budget: { tokens: 10_000, usd: 10, activeSeconds: 600 },
        resources: {},
        guide,
        profiles,
        validationPolicy: {
          kind: 'command',
          policyId: 'exact-tests',
          command: 'printf super-secret-command',
          timeoutSeconds: 120,
          shell: '/super-secret-shell',
        },
        completion: { requireCheckpoint: true, requireReview: false },
      },
      1,
    );
    state = applyMissionEvent(
      state,
      {
        type: 'checkpoint-recorded',
        checkpointId: 'accepted-checkpoint',
        revisionId: 'accepted-revision',
        authorChildId: null,
        clean: true,
      },
      state.revision + 1,
    );
    state = applyMissionEvent(
      state,
      {
        type: 'validation-recorded',
        validationId: 'accepted-validation',
        checkpointId: 'accepted-checkpoint',
        revisionId: 'accepted-revision',
        policyId: 'exact-tests',
        disposition: 'passed',
        exitCode: 0,
        timedOut: false,
        workspaceChanged: false,
        outputTail: 'v'.repeat(100),
      },
      state.revision + 1,
    );
    state = applyMissionEvent(
      state,
      {
        type: 'mission-completed',
        outcome: 'succeeded',
        reason: 'Exact validation passed.',
        checkpointId: 'accepted-checkpoint',
        guideEpoch: state.guideEpoch,
      },
      state.revision + 1,
    );
    state = applyMissionEvent(
      state,
      {
        type: 'accepted-revision-handoff-recorded',
        backend: 'git',
        repositoryKey: 'runner',
        checkpointId: 'accepted-checkpoint',
        revisionId: 'accepted-revision',
        reference: 'r'.repeat(100),
        status: 'preserved',
      },
      state.revision + 1,
    );

    const projection = projectMissionForGuide(state, { maxSummaryChars: 30 });
    expect(projection.validation).toEqual({
      policy: { kind: 'command', policyId: 'exact-tests' },
      active: null,
      latest: {
        validationId: 'accepted-validation',
        checkpointId: 'accepted-checkpoint',
        revisionId: 'accepted-revision',
        policyId: 'exact-tests',
        disposition: 'passed',
        exitCode: 0,
        timedOut: false,
        workspaceChanged: false,
        outputTail: expect.stringMatching(/^v+\[truncated\]$/),
      },
    });
    expect(projection.acceptedRevisionHandoff).toEqual({
      backend: 'git',
      repositoryKey: 'runner',
      checkpointId: 'accepted-checkpoint',
      revisionId: 'accepted-revision',
      reference: expect.stringMatching(/^r+\[truncated\]$/),
      status: 'preserved',
    });
    expect(JSON.stringify(projection)).not.toContain('super-secret');
  });

  it('carries a blocking review across legacy logical aliases of one immutable revision', () => {
    let state = guideState();
    state = applyMissionEvent(
      state,
      {
        type: 'checkpoint-recorded',
        checkpointId: 'original',
        revisionId: 'same-revision',
        authorChildId: null,
        clean: true,
      },
      2,
    );
    state = applyMissionEvent(
      state,
      {
        type: 'review-recorded',
        reviewId: 'original-blocker',
        reviewerChildId: 'reviewer-one',
        checkpointId: 'original',
        revisionId: 'same-revision',
        verdict: 'changes-requested',
        highestSeverity: 'critical',
        summary: 'The immutable revision is blocked.',
      },
      3,
    );
    // Replaying old journals remains safe even if they predate the unique-revision admission rule.
    state = applyMissionEvent(
      state,
      {
        type: 'checkpoint-recorded',
        checkpointId: 'legacy-alias',
        revisionId: 'same-revision',
        authorChildId: null,
        parentCheckpointId: 'original',
        clean: true,
      },
      4,
    );
    state = applyMissionEvent(
      state,
      {
        type: 'review-recorded',
        reviewId: 'alias-pass',
        reviewerChildId: 'reviewer-two',
        checkpointId: 'legacy-alias',
        revisionId: 'same-revision',
        verdict: 'passed',
        highestSeverity: 'none',
        summary: 'A later alias cannot erase the blocker.',
      },
      5,
    );

    expect(projectMissionForGuide(state).checkpoint).toMatchObject({
      checkpointId: 'legacy-alias',
      revisionId: 'same-revision',
      review: {
        reviewId: 'original-blocker',
        revisionId: 'same-revision',
        verdict: 'changes-requested',
        highestSeverity: 'critical',
      },
    });
  });

  it('enforces one aggregate serialized projection bound', () => {
    let state = guideState();
    for (let index = 0; index < 8; index += 1) {
      state = applyMissionEvent(
        state,
        {
          type: 'child-reserved',
          guideEpoch: state.guideEpoch,
          child: {
            childId: `bounded-${index}`,
            role: 'reviewer',
            instruction: 'unprojected',
            permission: 'read',
            profileId: 'reviewer',
            agent: { driver: 'driver', model: 'review-model' },
            driverPosture: reviewPosture,
            budget: { tokens: 100, usd: null, activeSeconds: 10 },
            resources: {},
            projectMcp: [],
          },
        },
        state.revision + 1,
      );
      state = applyMissionEvent(
        state,
        {
          type: 'child-completed',
          childId: `bounded-${index}`,
          outcome: 'succeeded',
          summary: 's'.repeat(200),
          usage: { tokens: 1, usd: null, activeSeconds: 1 },
        },
        state.revision + 1,
      );
    }

    const projection = projectMissionForGuide(state, {
      maxChildren: 8,
      maxSummaryChars: 100,
      maxSerializedChars: 1_600,
    });
    expect(JSON.stringify(projection).length).toBeLessThanOrEqual(1_600);
    expect(projection.children.at(-1)?.childId).toBe('bounded-7');
    expect(projection.children.length).toBeLessThan(8);
  });

  it('trims ordinary historical evidence to the economical default projection bound', () => {
    let state = guideState();
    for (let index = 0; index < 40; index += 1) {
      state = applyMissionEvent(
        state,
        {
          type: 'child-reserved',
          guideEpoch: state.guideEpoch,
          child: {
            childId: `history-${index}`,
            role: 'reviewer',
            instruction: 'unprojected',
            permission: 'read',
            profileId: 'reviewer',
            agent: { driver: 'driver', model: 'review-model' },
            driverPosture: reviewPosture,
            budget: { tokens: 100, usd: null, activeSeconds: 10 },
            resources: {},
            projectMcp: [],
          },
        },
        state.revision + 1,
      );
      state = applyMissionEvent(
        state,
        {
          type: 'child-completed',
          childId: `history-${index}`,
          outcome: 'succeeded',
          summary: `${index}:`.padEnd(3_000, 's'),
          usage: { tokens: 1, usd: null, activeSeconds: 1 },
        },
        state.revision + 1,
      );
    }

    const projection = projectMissionForGuide(state);
    expect(JSON.stringify(projection).length).toBeLessThanOrEqual(DEFAULT_MISSION_GUIDE_PROJECTION_CHARS);
    expect(projection.children.at(-1)?.childId).toBe('history-39');
    expect(projection.children.length).toBeLessThan(32);
  });

  it('renders the bounded projection compactly with room for the trusted guide frame', () => {
    const projection = projectMissionForGuide(guideState());
    const prompt = renderMissionGuidePrompt(projection);
    expect(prompt.length).toBeLessThanOrEqual(256_000);
    expect(prompt).toContain(`"missionId":"${projection.missionId}"`);
    expect(prompt).not.toContain(`\n  "missionId"`);
  });

  it('keeps a dirty adopted-plan checkpoint visible as the current unresolved step', () => {
    const step = {
      id: 'write-step',
      title: 'Write safely',
      profileId: 'builder',
      instruction: 'Make one bounded change.',
      acceptance: ['The checkpoint is clean.'],
    };
    let state = guideState();
    state = applyMissionEvent(
      state,
      {
        type: 'execution-plan-adopted',
        plannerChildId: 'planner-one',
        guideEpoch: state.guideEpoch,
        planFingerprint: 'b'.repeat(64),
        plan: { type: 'execution-plan', summary: 'One step.', steps: [step] },
      },
      state.revision + 1,
    );
    state = applyMissionEvent(
      state,
      {
        type: 'child-reserved',
        guideEpoch: state.guideEpoch,
        child: {
          childId: 'planned-worker',
          role: 'builder',
          instruction: 'trusted scheduler text',
          permission: 'write',
          profileId: 'builder',
          agent: { driver: 'local-driver', model: 'small-model' },
          driverPosture: buildPosture,
          budget: { tokens: 1_000, usd: 1, activeSeconds: 60 },
          resources: {},
          projectMcp: [{ server: 'project-tools', tools: ['inspect', 'edit'] }],
          planStepId: missionPlanStepKey(state.missionId, 'planner-one', step.id),
        },
      },
      state.revision + 1,
    );
    state = applyMissionEvent(
      state,
      {
        type: 'child-completed',
        childId: 'planned-worker',
        outcome: 'succeeded',
        summary: 'Work completed but the workspace remained dirty.',
        usage: { tokens: 1, usd: 0, activeSeconds: 1 },
      },
      state.revision + 1,
    );
    state = applyMissionEvent(
      state,
      {
        type: 'checkpoint-recorded',
        checkpointId: 'dirty-checkpoint',
        revisionId: 'dirty-revision',
        authorChildId: 'planned-worker',
        clean: false,
      },
      state.revision + 1,
    );

    expect(projectMissionForGuide(state).activePlan?.currentStep).toMatchObject({
      id: 'write-step',
      workerStatus: 'succeeded',
      checkpointClean: false,
      reviewStatus: null,
    });
  });

  it('leaves completion admission to the deterministic kernel', () => {
    const state = applyMissionEvent(
      initialMissionState('mission-1'),
      {
        type: 'mission-created',
        projectMcpDeclarationFingerprint: PROJECT_MCP_FINGERPRINT,
        budget: { tokens: null, usd: null, activeSeconds: null },
        resources: {},
        guide,
        profiles,
        validationPolicy: {
          kind: 'none',
          policyId: 'test-no-validation',
          reason: 'No deterministic validation is configured for this completion fixture.',
        },
        completion: { requireCheckpoint: true, requireReview: true },
      },
      1,
    );
    const proposal = translateMissionGuideAction(state, 'complete-proposal', 0, {
      type: 'propose_completion',
      outcome: 'succeeded',
      reason: 'looks done',
    });
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) throw new Error(proposal.reason);
    const decision = decideMission(state, proposal.action as MissionAction);
    expect(decision).toMatchObject({ accepted: false, code: 'completion-unproved' });
  });
});
