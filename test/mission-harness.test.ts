import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type MissionGuideAction, translateMissionGuideAction } from '../src/mission/guide-protocol';
import {
  MissionChildAttemptError,
  type MissionChildExecutor,
  type MissionChildResult,
  type MissionGuide,
  MissionGuidePreflightError,
  type MissionGuideRequest,
  type MissionGuideResult,
  MissionHarness,
} from '../src/mission/harness';
import { MissionKernel } from '../src/mission/kernel';
import { MemoryMissionStore } from '../src/mission/memory-store';
import type { MissionState } from '../src/mission/model';
import {
  missionExecutionPlanFingerprint,
  missionPlanChildId,
  missionPlanStepKey,
} from '../src/mission/plan-identity';
import type {
  MissionAction,
  MissionExecutionProfile,
  MissionGuideProfile,
  MissionUsage,
  MissionValidationPolicy,
} from '../src/mission/protocol';
import {
  MAX_MISSION_REVIEW_SUMMARY_CHARS,
  MAX_MISSION_VALIDATION_OUTPUT_BYTES,
} from '../src/mission/protocol';
import { canonicalMissionJson } from '../src/mission/store';

const MISSION_ID = 'harness-mission';
const PROJECT_MCP_FINGERPRINT = 'a'.repeat(64);
const GUIDE_USAGE: MissionUsage = { tokens: 7, usd: 0, activeSeconds: 1 };
const CHILD_USAGE: MissionUsage = { tokens: 11, usd: 0, activeSeconds: 1 };

function deterministicEffectId(kind: string, ...values: unknown[]): string {
  const digest = createHash('sha256').update(canonicalMissionJson(values), 'utf8').digest('hex');
  return `${kind}:${digest.slice(0, 48)}`;
}

const buildPosture = {
  kind: 'build',
  permission: {
    write: true,
    allow: ['Read', 'Edit'],
    deny: ['Network'],
    auto: false,
  },
  lineageRole: 'worker',
} as const;

const reviewPosture = {
  kind: 'verify',
  permission: {
    write: false,
    allow: ['Read'],
    deny: ['Edit'],
    auto: false,
  },
  lineageRole: 'reviewer',
} as const;
const plannerPosture = {
  kind: 'scope',
  permission: {
    write: false,
    allow: ['Read'],
    deny: ['Edit'],
    auto: false,
  },
  lineageRole: 'planner',
} as const;

function executionProfiles(
  builderTokens = 100,
  builderActiveSeconds = 100,
): readonly MissionExecutionProfile[] {
  return [
    {
      profileId: 'planner',
      role: 'planner',
      permission: 'read',
      agent: { driver: 'claude', model: 'bounded-planner', effort: 'high' },
      assurance: { rank: 2, independenceClass: 'planning' },
      driverPosture: plannerPosture,
      budget: { tokens: 500, usd: null, activeSeconds: 100 },
      resources: {},
      projectMcp: [{ server: 'project-tools', tools: ['inspect'] }],
    },
    {
      profileId: 'builder',
      role: 'builder',
      permission: 'write',
      agent: { driver: 'codex', model: 'bounded-builder', effort: 'medium' },
      assurance: { rank: 1, independenceClass: 'build' },
      driverPosture: buildPosture,
      budget: { tokens: builderTokens, usd: null, activeSeconds: builderActiveSeconds },
      resources: { 'workspace-writer': 1 },
      projectMcp: [{ server: 'project-tools', tools: ['inspect', 'edit'] }],
    },
    {
      profileId: 'reviewer',
      role: 'reviewer',
      permission: 'read',
      agent: { driver: 'claude', model: 'bounded-reviewer', effort: 'high' },
      assurance: { rank: 2, independenceClass: 'independent-review' },
      driverPosture: reviewPosture,
      budget: { tokens: 100, usd: null, activeSeconds: 100 },
      resources: {},
      projectMcp: [{ server: 'project-tools', tools: ['inspect'] }],
    },
  ];
}

function guideProfile(turnLimit = 10, activeSeconds = 100): MissionGuideProfile {
  return {
    profileId: 'guide',
    agent: { driver: 'claude', model: 'bounded-guide', effort: 'high' },
    budget: { tokens: 100, usd: null, activeSeconds },
    turnLimit,
  };
}

async function dispatch(
  kernel: MissionKernel,
  actionId: string,
  action: MissionAction,
  missionId = MISSION_ID,
): Promise<MissionState> {
  const before = await kernel.inspect(missionId);
  const result = await kernel.dispatch({
    missionId,
    expectedRevision: before.revision,
    actionId,
    action,
  });
  if (!result.accepted) throw new Error(`${action.type} was refused: ${result.reason}`);
  return result.state;
}

async function createMission(
  store: MemoryMissionStore,
  options: {
    turnLimit?: number;
    guideActiveSeconds?: number;
    builderTokens?: number;
    builderActiveSeconds?: number;
    missionActiveSeconds?: number;
    validationPolicy?: MissionValidationPolicy;
    completion?: { requireCheckpoint: boolean; requireReview: boolean };
    cleanup?: readonly string[];
  } = {},
): Promise<MissionKernel> {
  const kernel = new MissionKernel(store);
  await dispatch(kernel, 'create', {
    type: 'create-mission',
    projectMcpDeclarationFingerprint: PROJECT_MCP_FINGERPRINT,
    objective: {
      brief: 'Implement, review, and prove the bounded mission.',
      repositoryKey: 'runner',
    },
    budget: { tokens: 10_000, usd: null, activeSeconds: options.missionActiveSeconds ?? 1_000 },
    resources: { 'workspace-writer': 1 },
    guide: guideProfile(options.turnLimit, options.guideActiveSeconds),
    profiles: executionProfiles(options.builderTokens, options.builderActiveSeconds),
    validationPolicy:
      options.validationPolicy ??
      ({
        kind: 'none',
        policyId: 'test-no-validation',
        reason: 'No deterministic test configured.',
      } as const),
    completion: options.completion ?? { requireCheckpoint: false, requireReview: false },
    ...(options.cleanup ? { cleanup: options.cleanup } : {}),
  });
  return kernel;
}

function envelope(request: MissionGuideRequest, actionId: string, action: MissionGuideAction): string {
  return JSON.stringify({
    missionId: request.projection.missionId,
    guideEpoch: request.projection.guideEpoch,
    expectedRevision: request.projection.revision,
    actionId,
    action,
  });
}

type GuideStep = (request: MissionGuideRequest) => MissionGuideResult | Promise<MissionGuideResult>;

function scriptedGuide(...steps: GuideStep[]): {
  guide: MissionGuide;
  requests: MissionGuideRequest[];
  calls: () => number;
} {
  const requests: MissionGuideRequest[] = [];
  let call = 0;
  return {
    requests,
    calls: () => call,
    guide: {
      async next(request) {
        requests.push(request);
        const step = steps[call++];
        if (!step) throw new Error(`unexpected guide call ${call}`);
        return step(request);
      },
    },
  };
}

describe('guide preflight', () => {
  it('journals one costless deterministic incompatibility and does not churn replacement turns', async () => {
    const store = new MemoryMissionStore();
    await createMission(store, { turnLimit: 10 });
    let calls = 0;
    const harness = new MissionHarness({
      store,
      guide: {
        async next() {
          calls += 1;
          throw new MissionGuidePreflightError('driver lacks process-tree termination');
        },
      },
      children: { startOrAttach: async () => Promise.reject(new Error('unused')) },
    });

    const stop = await harness.run(MISSION_ID);
    expect(stop).toMatchObject({
      reason: 'runtime-error',
      error: expect.stringContaining('preflight is incompatible'),
    });
    expect(calls).toBe(1);
    const state = await harness.load(MISSION_ID);
    expect(state.guideTurnOrder).toHaveLength(1);
    expect(state.guideTurns[state.guideTurnOrder[0]!]).toMatchObject({
      status: 'failed',
      usage: { tokens: 0, usd: 0, activeSeconds: 0 },
    });
  });
});

function turnIds(): () => string {
  let next = 0;
  return () => `turn-${++next}`;
}

const unusedChildren: MissionChildExecutor = {
  async startOrAttach() {
    throw new Error('child executor must not be called');
  },
};

const reconcileTerminalWriteEvidence = {
  async recordAfterChild(state: MissionState, child: MissionState['children'][string]) {
    const checkpoint = Object.values(state.checkpoints).find(
      (candidate) => candidate.authorChildId === child.childId,
    );
    if (child.status === 'succeeded' && !checkpoint) {
      return [
        {
          type: 'record-checkpoint' as const,
          checkpointId: `test-checkpoint-${child.childId}`,
          revisionId: `test-revision-${child.childId}`,
          authorChildId: child.childId,
          parentCheckpointId: state.checkpointOrder.at(-1) ?? null,
          clean: true,
          description: 'Test child left one clean exact checkpoint.',
        },
      ];
    }
    return [
      {
        type: 'record-workspace-reconciled' as const,
        childId: child.childId,
        revisionId: checkpoint?.revisionId ?? state.objective?.baseRevision ?? 'test-workspace-base',
        disposition: 'restored' as const,
        summary: 'Test workspace restored after terminal write child.',
      },
    ];
  },
};

const reviewedPlanEvidence = {
  async recordAfterChild(state: MissionState, child: MissionState['children'][string]) {
    if (child.permission === 'write') {
      return [
        {
          type: 'record-checkpoint' as const,
          checkpointId: `checkpoint-${child.childId}`,
          revisionId: `revision-${child.childId}`,
          authorChildId: child.childId,
          parentCheckpointId: state.checkpointOrder.at(-1) ?? null,
          clean: true,
          description: 'Exact clean plan-step checkpoint.',
        },
      ];
    }
    const artifact = child.artifact?.type === 'review' ? child.artifact : null;
    if (!artifact) throw new Error(`review child '${child.childId}' has no review artifact`);
    return [
      {
        type: 'record-review' as const,
        reviewId: `evidence-${child.childId}`,
        reviewerChildId: child.childId,
        checkpointId: artifact.checkpointId,
        revisionId: artifact.revisionId,
        verdict: artifact.verdict,
        highestSeverity: artifact.highestSeverity,
        summary: artifact.summary,
      },
    ];
  },
};

const preservedTestHandoff = {
  async record(state: MissionState) {
    const checkpointId = state.terminal?.checkpointId;
    const checkpoint = checkpointId ? state.checkpoints[checkpointId] : undefined;
    if (!checkpoint) return null;
    return {
      type: 'record-accepted-revision-handoff' as const,
      backend: 'git',
      repositoryKey: state.objective?.repositoryKey ?? 'runner',
      checkpointId: checkpoint.checkpointId,
      revisionId: checkpoint.revisionId,
      reference: `refs/heads/noriq/run/${state.missionId}`,
      status: 'preserved' as const,
    };
  },
};

async function reserveChild(
  kernel: MissionKernel,
  profileId: 'planner' | 'builder' | 'reviewer',
  childId: string,
  subjectCheckpointId?: string,
): Promise<MissionState> {
  const state = await kernel.inspect(MISSION_ID);
  const translated = translateMissionGuideAction(state, `seed-${childId}`, state.guideEpoch, {
    type: 'dispatch_child',
    childId,
    profileId,
    instruction: `Run ${profileId} work.`,
    ...(subjectCheckpointId ? { subjectCheckpointId } : {}),
  });
  if (!translated.ok) throw new Error(translated.reason);
  return dispatch(kernel, `reserve-${childId}`, translated.action);
}

async function adoptOneStepReviewedPlan(
  kernel: MissionKernel,
  plannerChildId: string,
  stepId: string,
): Promise<void> {
  await reserveChild(kernel, 'planner', plannerChildId);
  await dispatch(kernel, `start-${plannerChildId}`, {
    type: 'start-child',
    childId: plannerChildId,
    attemptId: `attempt:${plannerChildId}`,
  });
  const artifact = {
    type: 'execution-plan' as const,
    summary: 'One bounded step with exact review.',
    steps: [
      {
        id: stepId,
        title: 'Implement the bounded change',
        profileId: 'builder',
        reviewProfileId: 'reviewer',
        instruction: 'Implement only the approved behavior.',
        acceptance: ['The exact clean checkpoint passes independent review.'],
      },
    ],
  };
  await dispatch(kernel, `complete-${plannerChildId}`, {
    type: 'complete-child',
    childId: plannerChildId,
    outcome: 'succeeded',
    summary: 'Planner produced one trusted reviewed step.',
    usage: CHILD_USAGE,
    artifact,
  });
  const state = await kernel.inspect(MISSION_ID);
  await dispatch(kernel, `adopt-${plannerChildId}`, {
    type: 'adopt-execution-plan',
    guideEpoch: state.guideEpoch,
    plannerChildId,
    planFingerprint: missionExecutionPlanFingerprint(artifact),
  });
}

describe('MissionHarness durability and authority', () => {
  it('journals guide usage and a trusted profile proposal before durably starting its child', async () => {
    const store = new MemoryMissionStore();
    await createMission(store);
    const kernel = new MissionKernel(store);
    let guideSawRunningTurn = false;
    let executorSawDurableStart = false;
    let harnessActivatedPublishedChild = false;
    let startedChild: MissionState['children'][string] | undefined;

    const script = scriptedGuide(
      async (request) => {
        const duringGuide = await kernel.inspect(MISSION_ID);
        const running = Object.values(duringGuide.guideTurns).find((turn) => turn.status === 'running');
        guideSawRunningTurn =
          running?.turnId === 'turn-1' &&
          running.startedRevision === request.projection.revision &&
          duringGuide.children['builder-1'] === undefined;
        return {
          output: envelope(request, 'dispatch-builder', {
            type: 'dispatch_child',
            childId: 'builder-1',
            profileId: 'builder',
            instruction: 'Implement only the approved bounded change.',
          }),
          usage: GUIDE_USAGE,
        };
      },
      (request) => ({
        output: envelope(request, 'finish-after-builder', {
          type: 'propose_completion',
          outcome: 'failed',
          reason: 'The ordering test is complete.',
        }),
        usage: GUIDE_USAGE,
      }),
    );

    const children: MissionChildExecutor = {
      async startOrAttach(request) {
        const durable = await kernel.inspect(MISSION_ID);
        const actions = (await store.load(MISSION_ID)).actions.map((entry) => entry.action.type);
        startedChild = request.child;
        executorSawDurableStart =
          durable.children[request.child.childId]?.attemptId === request.attemptId &&
          durable.children[request.child.childId]?.status === 'running' &&
          actions.indexOf('complete-guide-turn') < actions.indexOf('apply-guide-proposal') &&
          actions.indexOf('apply-guide-proposal') < actions.indexOf('start-child');
        return {
          attemptId: request.attemptId,
          async activate() {
            const durable = await kernel.inspect(MISSION_ID);
            harnessActivatedPublishedChild =
              executorSawDurableStart &&
              durable.children[request.child.childId]?.attemptId === request.attemptId &&
              durable.children[request.child.childId]?.status === 'running';
          },
          async cancel() {},
          async done(): Promise<MissionChildResult> {
            if (!harnessActivatedPublishedChild) throw new Error('harness did not activate child');
            return { outcome: 'succeeded', summary: 'Builder completed.', usage: CHILD_USAGE };
          },
        };
      },
    };

    const stop = await new MissionHarness({
      store,
      guide: script.guide,
      children,
      evidence: reconcileTerminalWriteEvidence,
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop.reason).toBe('terminal');
    expect(guideSawRunningTurn).toBe(true);
    expect(executorSawDurableStart).toBe(true);
    expect(harnessActivatedPublishedChild).toBe(true);
    expect(startedChild).toMatchObject({
      childId: 'builder-1',
      profileId: 'builder',
      permission: 'write',
      agent: { driver: 'codex', model: 'bounded-builder', effort: 'medium' },
      driverPosture: buildPosture,
      budget: { tokens: 100, usd: null, activeSeconds: 100 },
      resources: { 'workspace-writer': 1 },
      projectMcp: [{ server: 'project-tools', tools: ['inspect', 'edit'] }],
    });
    expect(stop.state.guideTurns['turn-1']).toMatchObject({
      status: 'applied',
      usage: GUIDE_USAGE,
    });
    expect(stop.state.children['builder-1']?.attemptId).toMatch(/^attempt:[a-f0-9]{48}$/);
  });

  it('reattaches a running child after restart using its exact durable attempt id', async () => {
    const store = new MemoryMissionStore();
    const kernel = await createMission(store);
    await reserveChild(kernel, 'builder', 'builder-restart');
    await dispatch(kernel, 'start-before-restart', {
      type: 'start-child',
      childId: 'builder-restart',
      attemptId: 'attempt:durable-restart-id',
    });
    const attachedAttempts: string[] = [];
    const script = scriptedGuide((request) => ({
      output: envelope(request, 'finish-recovered-child', {
        type: 'propose_completion',
        outcome: 'failed',
        reason: 'Recovered child observation is durable.',
      }),
      usage: GUIDE_USAGE,
    }));

    const stop = await new MissionHarness({
      store,
      guide: script.guide,
      children: {
        async startOrAttach(request) {
          attachedAttempts.push(request.attemptId);
          return {
            attemptId: request.attemptId,
            usageAtAttach: { tokens: 0, usd: 0, activeSeconds: 0 },
            async cancel() {},
            async done() {
              return { outcome: 'succeeded', summary: 'Reattached and settled.', usage: CHILD_USAGE };
            },
          };
        },
      },
      evidence: reconcileTerminalWriteEvidence,
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop.reason).toBe('terminal');
    expect(attachedAttempts).toEqual(['attempt:durable-restart-id']);
    expect(stop.state.children['builder-restart']).toMatchObject({
      status: 'succeeded',
      attemptId: 'attempt:durable-restart-id',
    });
    expect(
      (await store.load(MISSION_ID)).actions.filter((entry) => entry.action.type === 'start-child'),
    ).toHaveLength(1);
  });

  it('reattaches with only the child active-time budget that remains', async () => {
    const store = new MemoryMissionStore();
    const kernel = await createMission(store, { builderActiveSeconds: 0.2 });
    await reserveChild(kernel, 'builder', 'builder-remaining-time');
    await dispatch(kernel, 'start-before-time-restart', {
      type: 'start-child',
      childId: 'builder-remaining-time',
      attemptId: 'attempt:remaining-time',
    });
    await dispatch(kernel, 'usage-before-time-restart', {
      type: 'observe-child-usage',
      childId: 'builder-remaining-time',
      usage: { tokens: 0, usd: 0, activeSeconds: 0.19 },
    });
    let settle!: (result: MissionChildResult) => void;
    const done = new Promise<MissionChildResult>((resolve) => {
      settle = resolve;
    });
    const cancellations: string[] = [];
    const script = scriptedGuide((request) => ({
      output: envelope(request, 'finish-after-active-time', {
        type: 'propose_completion',
        outcome: 'failed',
        reason: 'Recovered child exhausted its remaining active-time budget.',
      }),
      usage: GUIDE_USAGE,
    }));
    const started = performance.now();

    const stop = await new MissionHarness({
      store,
      guide: script.guide,
      children: {
        async startOrAttach(request) {
          return {
            attemptId: request.attemptId,
            usageAtAttach: { tokens: 0, usd: 0, activeSeconds: 0.19 },
            async cancel(reason) {
              cancellations.push(reason);
              settle({
                outcome: 'cancelled',
                summary: 'Stopped at the remaining active-time ceiling.',
                usage: { tokens: 0, usd: 0, activeSeconds: 0.19 },
              });
            },
            done: () => done,
          };
        },
      },
      evidence: reconcileTerminalWriteEvidence,
      newTurnId: turnIds(),
      cancelGraceMs: 100,
    }).run(MISSION_ID);

    expect(performance.now() - started).toBeLessThan(150);
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]).toContain('timed out');
    expect(stop.state.children['builder-remaining-time']?.status).toBe('cancelled');
  });

  it('fails closed when a reattached child has unknown cumulative active time', async () => {
    const store = new MemoryMissionStore();
    const kernel = await createMission(store, { builderActiveSeconds: 10 });
    await reserveChild(kernel, 'builder', 'builder-unknown-time');
    await dispatch(kernel, 'start-before-unknown-time-restart', {
      type: 'start-child',
      childId: 'builder-unknown-time',
      attemptId: 'attempt:unknown-time',
    });
    await dispatch(kernel, 'unknown-time-before-restart', {
      type: 'observe-child-usage',
      childId: 'builder-unknown-time',
      usage: { tokens: 0, usd: 0, activeSeconds: null },
    });
    let settle!: (result: MissionChildResult) => void;
    const done = new Promise<MissionChildResult>((resolve) => {
      settle = resolve;
    });
    const cancellations: string[] = [];

    const stop = await new MissionHarness({
      store,
      guide: {
        async next() {
          throw new Error('unknown active time must block further guide work');
        },
      },
      children: {
        async startOrAttach(request) {
          return {
            attemptId: request.attemptId,
            usageAtAttach: { tokens: 0, usd: 0, activeSeconds: null },
            async cancel(reason) {
              cancellations.push(reason);
              settle({
                outcome: 'cancelled',
                summary: 'Stopped because remaining active time is unknowable.',
                usage: { tokens: 0, usd: 0, activeSeconds: null },
              });
            },
            done: () => done,
          };
        },
      },
      evidence: reconcileTerminalWriteEvidence,
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(cancellations).toEqual([
      'child executor cannot prove cumulative active time for this reattached attempt',
    ]);
    expect(stop.reason, stop.reason === 'runtime-error' ? stop.error : '').toBe('terminal');
    expect(stop).toMatchObject({
      state: {
        status: 'failed',
        children: { 'builder-unknown-time': { status: 'cancelled' } },
      },
    });
    expect(Object.values(stop.state.budgetConstraints)).toContainEqual(
      expect.objectContaining({ scope: 'child', axis: 'activeSeconds', reason: 'unknown' }),
    );
  });

  it.each([
    {
      name: 'missing',
      prior: { tokens: 0, usd: 0, activeSeconds: 0 },
      snapshot: undefined,
      reason: 'did not provide cumulative tokens, activeSeconds usage',
    },
    {
      name: 'invalid',
      prior: { tokens: 0, usd: 0, activeSeconds: 0 },
      snapshot: { tokens: -1, usd: 0, activeSeconds: 0 },
      reason: 'invalid cumulative usage-at-attach snapshot',
    },
    {
      name: 'non-monotonic',
      prior: { tokens: 5, usd: 0, activeSeconds: 1 },
      snapshot: { tokens: 4, usd: 0, activeSeconds: 1 },
      reason: 'non-monotonic cumulative usage-at-attach snapshot',
    },
  ])('fails closed on a $name finite-axis usage-at-attach snapshot', async ({ prior, snapshot, reason }) => {
    const store = new MemoryMissionStore();
    const kernel = await createMission(store);
    await reserveChild(kernel, 'builder', 'invalid-attach-snapshot');
    await dispatch(kernel, 'start-invalid-attach-snapshot', {
      type: 'start-child',
      childId: 'invalid-attach-snapshot',
      attemptId: 'attempt:invalid-attach-snapshot',
    });
    if (prior.tokens > 0 || prior.activeSeconds > 0) {
      await dispatch(kernel, 'prior-invalid-attach-snapshot-usage', {
        type: 'observe-child-usage',
        childId: 'invalid-attach-snapshot',
        usage: prior,
      });
    }
    let settle!: (result: MissionChildResult) => void;
    const done = new Promise<MissionChildResult>((resolve) => {
      settle = resolve;
    });
    const cancellations: string[] = [];
    const script = scriptedGuide((request) => ({
      output: envelope(request, 'finish-invalid-attach-snapshot', {
        type: 'propose_completion',
        outcome: 'failed',
        reason: 'Invalid attach usage was cancelled.',
      }),
      usage: GUIDE_USAGE,
    }));

    const stop = await new MissionHarness({
      store,
      guide: script.guide,
      children: {
        async startOrAttach(request) {
          return {
            attemptId: request.attemptId,
            usageAtAttach: snapshot,
            async cancel(cancelReason) {
              cancellations.push(cancelReason);
              settle({
                outcome: 'cancelled',
                summary: 'Invalid attach usage stopped the child.',
                usage: { tokens: 11, usd: 0, activeSeconds: 1 },
              });
            },
            done: () => done,
          };
        },
      },
      evidence: reconcileTerminalWriteEvidence,
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop.state.children['invalid-attach-snapshot']?.status).toBe('cancelled');
    expect(cancellations).toEqual([expect.stringContaining(reason)]);
  });

  it('leaves an ambiguously failed attach running so a later harness can retry the same attempt', async () => {
    const store = new MemoryMissionStore();
    const kernel = await createMission(store);
    await reserveChild(kernel, 'builder', 'builder-ambiguous');
    let firstAttempt: string | null = null;
    let firstGuideCalls = 0;

    const firstStop = await new MissionHarness({
      store,
      guide: {
        async next() {
          firstGuideCalls += 1;
          throw new Error('an active child must reconcile before guide work');
        },
      },
      children: {
        async startOrAttach(request) {
          firstAttempt = request.attemptId;
          throw new Error('transport response was lost');
        },
      },
      evidence: reconcileTerminalWriteEvidence,
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(firstStop).toMatchObject({
      reason: 'runtime-error',
      error: expect.stringContaining('ambiguous and will be retried'),
    });
    expect(firstStop.state.children['builder-ambiguous']).toMatchObject({
      status: 'running',
      attemptId: firstAttempt,
      summary: null,
    });
    expect(firstGuideCalls).toBe(0);
    expect(
      (await store.load(MISSION_ID)).actions.filter((entry) => entry.action.type === 'complete-child'),
    ).toHaveLength(0);

    const script = scriptedGuide((request) => ({
      output: envelope(request, 'finish-after-attach-retry', {
        type: 'propose_completion',
        outcome: 'failed',
        reason: 'The recoverable attempt was reattached and observed.',
      }),
      usage: GUIDE_USAGE,
    }));
    const retriedAttempts: string[] = [];
    const secondStop = await new MissionHarness({
      store,
      guide: script.guide,
      children: {
        async startOrAttach(request) {
          retriedAttempts.push(request.attemptId);
          return {
            attemptId: request.attemptId,
            usageAtAttach: { tokens: 0, usd: 0, activeSeconds: 0 },
            async cancel() {},
            async done() {
              return { outcome: 'succeeded', summary: 'Recovered attempt settled.', usage: CHILD_USAGE };
            },
          };
        },
      },
      evidence: reconcileTerminalWriteEvidence,
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(secondStop.reason).toBe('terminal');
    expect(retriedAttempts).toEqual([firstAttempt]);
    expect(secondStop.state.children['builder-ambiguous']?.status).toBe('succeeded');
    expect(
      (await store.load(MISSION_ID)).actions.filter((entry) => entry.action.type === 'start-child'),
    ).toHaveLength(1);
  });

  it('cancels a wrong-attempt attachment and leaves the durable attempt recoverable', async () => {
    const store = new MemoryMissionStore();
    const kernel = await createMission(store);
    await reserveChild(kernel, 'builder', 'builder-wrong-attempt');
    const cancellations: string[] = [];
    let guideCalls = 0;

    const stop = await new MissionHarness({
      store,
      guide: {
        async next() {
          guideCalls += 1;
          throw new Error('ambiguous attempt identity must block guide work');
        },
      },
      children: {
        async startOrAttach() {
          return {
            attemptId: 'attempt:wrong-process',
            async cancel(reason) {
              cancellations.push(reason);
            },
            async done() {
              return { outcome: 'cancelled', summary: 'Wrong process stopped.', usage: CHILD_USAGE };
            },
          };
        },
      },
      evidence: reconcileTerminalWriteEvidence,
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop).toMatchObject({
      reason: 'runtime-error',
      error: expect.stringContaining("executor returned attempt 'attempt:wrong-process'"),
      state: { children: { 'builder-wrong-attempt': { status: 'running' } } },
    });
    expect(cancellations).toEqual([expect.stringContaining('wrong attempt identity')]);
    expect(guideCalls).toBe(0);
  });

  it('settles an explicitly definitive attach failure as lost and continues the mission', async () => {
    const store = new MemoryMissionStore();
    await createMission(store);
    await reserveChild(new MissionKernel(store), 'builder', 'builder-definitive');
    const script = scriptedGuide((request) => ({
      output: envelope(request, 'finish-after-definitive-loss', {
        type: 'propose_completion',
        outcome: 'failed',
        reason: 'The definitively absent attempt was recorded as lost.',
      }),
      usage: GUIDE_USAGE,
    }));

    const stop = await new MissionHarness({
      store,
      guide: script.guide,
      children: {
        async startOrAttach() {
          throw new MissionChildAttemptError('executor proved the attempt does not exist', true);
        },
      },
      evidence: {
        async recordAfterChild(_state, child) {
          return [
            {
              type: 'record-workspace-reconciled',
              childId: child.childId,
              revisionId: 'definitive-loss-base',
              disposition: 'restored',
              summary: 'Verified the absent attempt left no workspace residue.',
            },
          ];
        },
      },
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop.reason).toBe('terminal');
    expect(stop.state.children['builder-definitive']).toMatchObject({
      status: 'lost',
      summary: expect.stringContaining('MissionChildAttemptError'),
    });
    expect(stop.state.terminal).toMatchObject({
      outcome: 'failed',
      reason: 'The definitively absent attempt was recorded as lost.',
    });
    expect(script.calls()).toBe(1);
    const actions = (await store.load(MISSION_ID)).actions.map((entry) => entry.action.type);
    expect(actions.indexOf('start-child')).toBeLessThan(actions.indexOf('complete-child'));
    expect(actions.indexOf('complete-child')).toBeLessThan(actions.indexOf('begin-guide-turn'));
  });

  it('replaces malformed guide attempts and enforces the durable turn limit across replacements', async () => {
    const store = new MemoryMissionStore();
    await createMission(store, { turnLimit: 2 });
    const script = scriptedGuide(
      () => ({ output: 'not json', usage: { tokens: 3, usd: 0, activeSeconds: 1 } }),
      () => ({ output: '{"almost":"an envelope"}', usage: { tokens: 4, usd: 0, activeSeconds: 1 } }),
    );

    const stop = await new MissionHarness({
      store,
      guide: script.guide,
      children: unusedChildren,
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop.reason).toBe('terminal');
    expect(stop.state.terminal).toMatchObject({
      outcome: 'failed',
      reason: 'Guide turn limit 2 was exhausted before completion.',
    });
    expect(script.calls()).toBe(2);
    expect(stop.state.guideTurnOrder).toEqual(['turn-1', 'turn-2']);
    expect(Object.values(stop.state.guideTurns).map((turn) => turn.status)).toEqual(['failed', 'failed']);
    expect(stop.state.usage.tokens).toBe(7);
    const actions = (await store.load(MISSION_ID)).actions.map((entry) => entry.action.type);
    expect(actions.filter((type) => type === 'begin-guide-turn')).toHaveLength(2);
    expect(actions.filter((type) => type === 'complete-guide-turn')).toHaveLength(2);
    expect(actions.filter((type) => type === 'replace-guide')).toHaveLength(2);
  });

  it('fails after three consecutive protocol repairs instead of spending the full guide turn budget', async () => {
    const store = new MemoryMissionStore();
    await createMission(store, { turnLimit: 10 });
    const script = scriptedGuide(
      () => ({ output: 'not json', usage: { tokens: 3, usd: 0, activeSeconds: 1 } }),
      () => ({ output: '{"almost":"an envelope"}', usage: { tokens: 4, usd: 0, activeSeconds: 1 } }),
      () => ({ output: 'still not json', usage: { tokens: 5, usd: 0, activeSeconds: 1 } }),
    );

    const stop = await new MissionHarness({
      store,
      guide: script.guide,
      children: unusedChildren,
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop.reason).toBe('terminal');
    expect(stop.state.terminal).toMatchObject({
      outcome: 'failed',
      reason: expect.stringContaining('protocol repair limit 3'),
    });
    expect(script.calls()).toBe(3);
    expect(stop.state.consecutiveGuideRepairs).toBe(3);
    expect(stop.state.guideTurnOrder).toHaveLength(3);
  });

  it('turns a live over-budget observation into a durable cancellation before child settlement', async () => {
    const store = new MemoryMissionStore();
    await createMission(store, { builderTokens: 10 });
    const kernel = new MissionKernel(store);
    let usageDisposition: string | null = null;
    let statusAfterUsage: string | null = null;
    const script = scriptedGuide((request) => ({
      output: envelope(request, 'dispatch-over-budget-child', {
        type: 'dispatch_child',
        childId: 'builder-budget',
        profileId: 'builder',
        instruction: 'Perform bounded work and stream absolute usage.',
      }),
      usage: GUIDE_USAGE,
    }));

    const stop = await new MissionHarness({
      store,
      guide: script.guide,
      children: {
        async startOrAttach(request) {
          return {
            attemptId: request.attemptId,
            async cancel() {},
            async done() {
              usageDisposition = await request.onUsage({ tokens: 11, usd: 0, activeSeconds: 2 });
              statusAfterUsage =
                (await kernel.inspect(MISSION_ID)).children[request.child.childId]?.status ?? null;
              return {
                outcome: 'cancelled',
                summary: 'Stopped after the durable budget signal.',
                usage: { tokens: 11, usd: 0, activeSeconds: 2 },
              };
            },
          };
        },
      },
      evidence: reconcileTerminalWriteEvidence,
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop.reason).toBe('terminal');
    expect(usageDisposition).toBe('cancel');
    expect(statusAfterUsage).toBe('cancelling');
    expect(stop.state.children['builder-budget']?.status).toBe('cancelled');
    expect(Object.values(stop.state.budgetConstraints)).toContainEqual(
      expect.objectContaining({
        scope: 'child',
        childId: 'builder-budget',
        axis: 'tokens',
        reason: 'exceeded',
        observed: 11,
        limit: 10,
      }),
    );
    const actions = (await store.load(MISSION_ID)).actions.map((entry) => entry.action.type);
    expect(actions.indexOf('observe-child-usage')).toBeLessThan(actions.indexOf('request-child-cancel'));
    expect(actions.indexOf('request-child-cancel')).toBeLessThan(actions.indexOf('complete-child'));
  });

  it('does not abandon or overlap a registry-owned start transaction during cancellation', async () => {
    const store = new MemoryMissionStore();
    await createMission(store);
    const script = scriptedGuide((request) => ({
      output: envelope(request, 'dispatch-slow-attach', {
        type: 'dispatch_child',
        childId: 'slow-attach',
        profileId: 'builder',
        instruction: 'Start through one registry transaction.',
      }),
      usage: GUIDE_USAGE,
    }));
    let entered!: () => void;
    const attachEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const attachRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settle!: (result: MissionChildResult) => void;
    const done = new Promise<MissionChildResult>((resolve) => {
      settle = resolve;
    });
    let starts = 0;
    const harness = new MissionHarness({
      store,
      guide: script.guide,
      children: {
        async startOrAttach(request) {
          starts += 1;
          entered();
          await attachRelease;
          return {
            attemptId: request.attemptId,
            async cancel() {
              settle({ outcome: 'cancelled', summary: 'Cancelled after attach.', usage: CHILD_USAGE });
              return new Promise<void>(() => {});
            },
            done: () => done,
          };
        },
      },
      evidence: reconcileTerminalWriteEvidence,
      newTurnId: turnIds(),
      cancelGraceMs: 20,
    });

    const running = harness.run(MISSION_ID);
    await attachEntered;
    let cancelSettled = false;
    const cancelling = harness.cancelMission(MISSION_ID, 'Cancel during attach.').then((stop) => {
      cancelSettled = true;
      return stop;
    });
    await Promise.resolve();
    expect(cancelSettled).toBe(false);
    expect(starts).toBe(1);
    release();

    await expect(cancelling).resolves.toMatchObject({ reason: 'terminal' });
    await expect(running).resolves.toMatchObject({ reason: 'terminal' });
    expect(starts).toBe(1);
  });

  it('keeps an unsettled cancelled execution registered and refuses to launch a replacement', async () => {
    const store = new MemoryMissionStore();
    const kernel = await createMission(store);
    const script = scriptedGuide((request) => ({
      output: envelope(request, 'dispatch-cross-process-child', {
        type: 'dispatch_child',
        childId: 'cross-process-child',
        profileId: 'builder',
        instruction: 'Wait for a durable cancellation from another controller.',
      }),
      usage: GUIDE_USAGE,
    }));
    let ready!: () => void;
    const childReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let starts = 0;
    let cancellations = 0;
    const harness = new MissionHarness({
      store,
      guide: script.guide,
      children: {
        async startOrAttach(request) {
          starts += 1;
          return {
            attemptId: request.attemptId,
            async cancel() {
              cancellations += 1;
              return new Promise<void>(() => {});
            },
            done() {
              ready();
              return new Promise<MissionChildResult>(() => {});
            },
          };
        },
      },
      evidence: reconcileTerminalWriteEvidence,
      newTurnId: turnIds(),
      cancelGraceMs: 5,
      durablePollMs: 1,
    });

    const running = harness.run(MISSION_ID);
    await childReady;
    const beforeCancel = await kernel.inspect(MISSION_ID);
    await dispatch(kernel, 'external-child-cancel', {
      type: 'request-child-cancel',
      guideEpoch: beforeCancel.guideEpoch,
      childId: 'cross-process-child',
      reason: 'Durable cancellation from another Runner process.',
    });

    await expect(running).resolves.toMatchObject({
      reason: 'runtime-error',
      error: expect.stringContaining('remains registered'),
      state: { children: { 'cross-process-child': { status: 'cancelling' } } },
    });
    await expect(harness.run(MISSION_ID)).resolves.toMatchObject({
      reason: 'runtime-error',
      error: expect.stringContaining('remains registered'),
    });
    expect(starts).toBe(1);
    expect(cancellations).toBe(1);
    expect(
      (await store.load(MISSION_ID)).actions.filter((entry) => entry.action.type === 'complete-child'),
    ).toHaveLength(0);
  });

  it('journals usage-at-attach before waiting and honors its cancellation disposition', async () => {
    const store = new MemoryMissionStore();
    const kernel = await createMission(store, { builderTokens: 10 });
    await reserveChild(kernel, 'builder', 'attach-over-budget');
    await dispatch(kernel, 'start-attach-over-budget', {
      type: 'start-child',
      childId: 'attach-over-budget',
      attemptId: 'attempt:attach-over-budget',
    });
    let settle!: (result: MissionChildResult) => void;
    const done = new Promise<MissionChildResult>((resolve) => {
      settle = resolve;
    });
    let durableTypesAtCancel: string[] = [];

    const stop = await new MissionHarness({
      store,
      guide: {
        async next() {
          throw new Error('attach-time budget constraint must block guide work');
        },
      },
      children: {
        async startOrAttach(request) {
          return {
            attemptId: request.attemptId,
            usageAtAttach: { tokens: 11, usd: 0, activeSeconds: 1 },
            async cancel() {
              durableTypesAtCancel = (await store.load(MISSION_ID)).actions.map((entry) => entry.action.type);
              settle({
                outcome: 'cancelled',
                summary: 'Attach snapshot exceeded budget.',
                usage: { tokens: 11, usd: 0, activeSeconds: 1 },
              });
            },
            done: () => done,
          };
        },
      },
      evidence: reconcileTerminalWriteEvidence,
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop).toMatchObject({ reason: 'terminal', state: { status: 'failed' } });
    expect(durableTypesAtCancel).toContain('observe-child-usage');
    expect(durableTypesAtCancel).toContain('request-child-cancel');
    expect(durableTypesAtCancel.indexOf('observe-child-usage')).toBeLessThan(
      durableTypesAtCancel.indexOf('request-child-cancel'),
    );
  });

  it('excludes attach latency and does not double-count streamed active time at completion', async () => {
    const store = new MemoryMissionStore();
    const kernel = await createMission(store, { builderActiveSeconds: 0.11 });
    await reserveChild(kernel, 'builder', 'attach-latency');
    await dispatch(kernel, 'start-attach-latency', {
      type: 'start-child',
      childId: 'attach-latency',
      attemptId: 'attempt:attach-latency',
    });
    await dispatch(kernel, 'usage-before-attach-latency', {
      type: 'observe-child-usage',
      childId: 'attach-latency',
      usage: { tokens: 0, usd: 0, activeSeconds: 0.1 },
    });
    const cancellations: string[] = [];
    const script = scriptedGuide((request) => ({
      output: envelope(request, 'finish-attach-latency', {
        type: 'propose_completion',
        outcome: 'failed',
        reason: 'Attach latency accounting was verified.',
      }),
      usage: GUIDE_USAGE,
    }));

    const stop = await new MissionHarness({
      store,
      guide: script.guide,
      children: {
        async startOrAttach(request) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return {
            attemptId: request.attemptId,
            usageAtAttach: { tokens: 0, usd: 0, activeSeconds: 0.1 },
            async cancel(reason) {
              cancellations.push(reason);
            },
            async done() {
              await request.onUsage({ tokens: 1, usd: 0, activeSeconds: 0.105 });
              return {
                outcome: 'succeeded',
                summary: 'Settled below the remaining active-time ceiling.',
                usage: { tokens: 1, usd: 0, activeSeconds: 0.105 },
              };
            },
          };
        },
      },
      evidence: reconcileTerminalWriteEvidence,
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(cancellations).toEqual([]);
    expect(stop.state.children['attach-latency']).toMatchObject({
      status: 'succeeded',
      usage: { tokens: 1, usd: 0, activeSeconds: 0.105 },
    });
  });

  it('terminalizes journal exhaustion instead of wedging on a durable unapplied proposal', async () => {
    const store = new MemoryMissionStore({ maxJournalActions: 7, emergencyReserveActions: 2 });
    await createMission(store);
    const script = scriptedGuide((request) => ({
      output: envelope(request, 'proposal-too-expensive-to-settle', {
        type: 'dispatch_child',
        childId: 'journal-boundary-writer',
        profileId: 'builder',
        instruction: 'This write child would require more settlement actions than remain.',
      }),
      usage: GUIDE_USAGE,
    }));
    let childCalls = 0;

    const stop = await new MissionHarness({
      store,
      guide: script.guide,
      children: {
        async startOrAttach() {
          childCalls += 1;
          throw new Error('a child whose settlement cannot fit must never launch');
        },
      },
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop).toMatchObject({
      reason: 'terminal',
      state: {
        status: 'failed',
        terminal: {
          outcome: 'failed',
          reason: expect.stringContaining('journal actions capacity was exhausted'),
        },
      },
    });
    expect(script.calls()).toBe(1);
    expect(childCalls).toBe(0);
    const actions = (await store.load(MISSION_ID)).actions.map((entry) => entry.action.type);
    expect(actions).toContain('complete-guide-turn');
    expect(actions).toContain('replace-guide');
    expect(actions).not.toContain('apply-guide-proposal');
    expect(actions).not.toContain('start-child');
  });

  it('fails closed when a driver reports non-monotonic live telemetry', async () => {
    const store = new MemoryMissionStore();
    await createMission(store);
    const dispositions: string[] = [];
    const script = scriptedGuide(
      (request) => ({
        output: envelope(request, 'dispatch-non-monotonic', {
          type: 'dispatch_child',
          childId: 'non-monotonic-child',
          profileId: 'builder',
          instruction: 'Report cumulative telemetry.',
        }),
        usage: GUIDE_USAGE,
      }),
      (request) => ({
        output: envelope(request, 'finish-non-monotonic', {
          type: 'propose_completion',
          outcome: 'failed',
          reason: 'Non-monotonic telemetry was cancelled.',
        }),
        usage: GUIDE_USAGE,
      }),
    );

    const stop = await new MissionHarness({
      store,
      guide: script.guide,
      children: {
        async startOrAttach(request) {
          return {
            attemptId: request.attemptId,
            async cancel() {},
            async done() {
              dispositions.push(await request.onUsage({ tokens: 5, usd: 0, activeSeconds: 1 }));
              dispositions.push(await request.onUsage({ tokens: 4, usd: 0, activeSeconds: 1 }));
              return {
                outcome: 'succeeded',
                summary: 'Driver incorrectly ignored the cancellation disposition.',
                usage: { tokens: 5, usd: 0, activeSeconds: 1 },
              };
            },
          };
        },
      },
      evidence: reconcileTerminalWriteEvidence,
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(dispositions).toEqual(['continue', 'cancel']);
    expect(stop.state.children['non-monotonic-child']).toMatchObject({
      status: 'cancelled',
      usage: { tokens: 5, usd: 0, activeSeconds: 1 },
      cancelReason: expect.stringContaining('usage observation was refused'),
    });
  });

  it('repairs and re-reviews a low-severity adopted-plan finding without another guide turn', async () => {
    const store = new MemoryMissionStore();
    const kernel = await createMission(store, {
      validationPolicy: {
        kind: 'command',
        policyId: 'plan-validation',
        command: 'npm test -- --runInBand',
        timeoutSeconds: 120,
        shell: null,
      },
    });
    const plannerId = 'planner-for-bounded-repair';
    const stepId = 'repairable-step';
    await adoptOneStepReviewedPlan(kernel, plannerId, stepId);
    const executed: Array<{
      childId: string;
      subjectCheckpointId: string | null;
      instruction: string;
    }> = [];
    const validationCheckpoints: Array<{ checkpointId: string; executedChildren: number }> = [];
    let reviewRound = 0;
    const reviewTail = 'TAIL-REPAIR-EVIDENCE';
    const completeReviewSummary = `${'r'.repeat(
      MAX_MISSION_REVIEW_SUMMARY_CHARS - reviewTail.length,
    )}${reviewTail}`;
    const script = scriptedGuide((request) => ({
      output: envelope(request, 'complete-after-bounded-repair', {
        type: 'propose_completion',
        outcome: 'succeeded',
        reason: 'The repaired checkpoint passed exact independent review.',
      }),
      usage: GUIDE_USAGE,
    }));

    const stop = await new MissionHarness({
      store,
      guide: script.guide,
      children: {
        async startOrAttach(request) {
          executed.push({
            childId: request.child.childId,
            subjectCheckpointId: request.child.subjectCheckpointId,
            instruction: request.child.instruction,
          });
          return {
            attemptId: request.attemptId,
            async cancel() {},
            async done(): Promise<MissionChildResult> {
              if (request.child.subjectCheckpointId === null) {
                return {
                  outcome: 'succeeded',
                  summary: 'Writer produced one clean checkpoint.',
                  usage: CHILD_USAGE,
                };
              }
              const checkpoint = request.state.checkpoints[request.child.subjectCheckpointId]!;
              const firstReview = reviewRound++ === 0;
              return {
                outcome: 'succeeded',
                summary: firstReview ? 'One bounded defect remains.' : 'The repair is accepted.',
                usage: CHILD_USAGE,
                artifact: {
                  type: 'review',
                  checkpointId: checkpoint.checkpointId,
                  revisionId: checkpoint.revisionId,
                  verdict: firstReview ? 'changes-requested' : 'passed',
                  highestSeverity: firstReview ? 'low' : 'none',
                  summary: firstReview
                    ? completeReviewSummary
                    : 'The exact repaired checkpoint satisfies every acceptance criterion.',
                },
              };
            },
          };
        },
      },
      evidence: reviewedPlanEvidence,
      validation: {
        async validate(state, checkpoint, policy) {
          validationCheckpoints.push({
            checkpointId: checkpoint.checkpointId,
            executedChildren: executed.length,
          });
          return {
            type: 'record-validation',
            validationId: state.activeValidation!.validationId,
            checkpointId: checkpoint.checkpointId,
            revisionId: checkpoint.revisionId,
            policyId: policy.policyId,
            disposition: 'passed',
            exitCode: 0,
            timedOut: false,
            workspaceChanged: false,
            outputTail: 'The deterministic plan validation passed.',
          };
        },
        async recover(state, checkpoint, policy) {
          return {
            type: 'record-validation',
            validationId: state.activeValidation!.validationId,
            checkpointId: checkpoint.checkpointId,
            revisionId: checkpoint.revisionId,
            policyId: policy.policyId,
            disposition: 'failed',
            exitCode: null,
            timedOut: false,
            workspaceChanged: false,
            outputTail: 'Recovered interrupted validation.',
          };
        },
      },
      acceptedRevisionHandoff: preservedTestHandoff,
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop).toMatchObject({ reason: 'terminal', state: { status: 'succeeded' } });
    expect(script.calls()).toBe(1);
    expect(validationCheckpoints).toEqual([
      {
        checkpointId: `checkpoint-${missionPlanChildId(MISSION_ID, plannerId, stepId, 'work', 1)}`,
        executedChildren: 4,
      },
    ]);
    expect(script.requests[0]?.projection.validation.latest).toMatchObject({
      validationId: expect.stringMatching(/^validation:/),
      disposition: 'passed',
    });
    expect(executed.map(({ childId }) => childId)).toEqual([
      missionPlanChildId(MISSION_ID, plannerId, stepId, 'work', 0),
      missionPlanChildId(MISSION_ID, plannerId, stepId, 'review', 0),
      missionPlanChildId(MISSION_ID, plannerId, stepId, 'work', 1),
      missionPlanChildId(MISSION_ID, plannerId, stepId, 'review', 1),
    ]);
    expect(executed[2]?.instruction).toContain('Repair round: 1 of 2');
    expect(completeReviewSummary).toHaveLength(MAX_MISSION_REVIEW_SUMMARY_CHARS);
    expect(executed[2]?.instruction).toContain(completeReviewSummary);
    expect(executed[2]?.instruction).not.toContain('[truncated]');
    expect(executed[3]?.subjectCheckpointId).toBe(
      `checkpoint-${missionPlanChildId(MISSION_ID, plannerId, stepId, 'work', 1)}`,
    );
  });

  it('returns a high-severity adopted-plan review to the guide without dispatching a repair', async () => {
    const store = new MemoryMissionStore();
    const kernel = await createMission(store);
    const plannerId = 'planner-for-high-review';
    const stepId = 'high-severity-step';
    await adoptOneStepReviewedPlan(kernel, plannerId, stepId);
    const executed: string[] = [];
    const script = scriptedGuide((request) => ({
      output: envelope(request, 'stop-after-high-review', {
        type: 'propose_completion',
        outcome: 'failed',
        reason: 'The high-severity finding requires a replacement plan.',
      }),
      usage: GUIDE_USAGE,
    }));

    const stop = await new MissionHarness({
      store,
      guide: script.guide,
      children: {
        async startOrAttach(request) {
          executed.push(request.child.childId);
          return {
            attemptId: request.attemptId,
            async cancel() {},
            async done(): Promise<MissionChildResult> {
              if (request.child.subjectCheckpointId === null) {
                return { outcome: 'succeeded', summary: 'Writer completed.', usage: CHILD_USAGE };
              }
              const checkpoint = request.state.checkpoints[request.child.subjectCheckpointId]!;
              return {
                outcome: 'succeeded',
                summary: 'High-severity review completed.',
                usage: CHILD_USAGE,
                artifact: {
                  type: 'review',
                  checkpointId: checkpoint.checkpointId,
                  revisionId: checkpoint.revisionId,
                  verdict: 'changes-requested',
                  highestSeverity: 'high',
                  summary: 'The proposed change can corrupt durable mission state.',
                },
              };
            },
          };
        },
      },
      evidence: reviewedPlanEvidence,
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop).toMatchObject({
      reason: 'terminal',
      state: { status: 'failed', terminal: { reason: expect.stringContaining('high-severity') } },
    });
    expect(executed).toEqual([
      missionPlanChildId(MISSION_ID, plannerId, stepId, 'work', 0),
      missionPlanChildId(MISSION_ID, plannerId, stepId, 'review', 0),
    ]);
  });

  it('hard-caps low/medium plan repairs at two rounds before returning control to the guide', async () => {
    const store = new MemoryMissionStore();
    const kernel = await createMission(store);
    const plannerId = 'planner-for-repair-cap';
    const stepId = 'bounded-repair-cap';
    await adoptOneStepReviewedPlan(kernel, plannerId, stepId);
    const executed: string[] = [];
    const script = scriptedGuide((request) => ({
      output: envelope(request, 'stop-after-repair-cap', {
        type: 'propose_completion',
        outcome: 'failed',
        reason: 'The deterministic repair limit was exhausted.',
      }),
      usage: GUIDE_USAGE,
    }));

    const stop = await new MissionHarness({
      store,
      guide: script.guide,
      children: {
        async startOrAttach(request) {
          executed.push(request.child.childId);
          return {
            attemptId: request.attemptId,
            async cancel() {},
            async done(): Promise<MissionChildResult> {
              if (request.child.subjectCheckpointId === null) {
                return { outcome: 'succeeded', summary: 'Repair writer completed.', usage: CHILD_USAGE };
              }
              const checkpoint = request.state.checkpoints[request.child.subjectCheckpointId]!;
              return {
                outcome: 'succeeded',
                summary: 'Another medium finding remains.',
                usage: CHILD_USAGE,
                artifact: {
                  type: 'review',
                  checkpointId: checkpoint.checkpointId,
                  revisionId: checkpoint.revisionId,
                  verdict: 'changes-requested',
                  highestSeverity: 'medium',
                  summary: 'The bounded repair has not yet satisfied the exact acceptance criterion.',
                },
              };
            },
          };
        },
      },
      evidence: reviewedPlanEvidence,
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop).toMatchObject({
      reason: 'terminal',
      state: { status: 'failed', terminal: { reason: expect.stringContaining('limit') } },
    });
    expect(executed).toEqual(
      [0, 1, 2].flatMap((round) => [
        missionPlanChildId(MISSION_ID, plannerId, stepId, 'work', round),
        missionPlanChildId(MISSION_ID, plannerId, stepId, 'review', round),
      ]),
    );
    expect(Object.keys(stop.state.children)).toHaveLength(7); // planner + three bounded pairs
    expect(script.calls()).toBe(1);
  });

  it('binds scheduler children to the mission-scoped adopted plan step key', async () => {
    const store = new MemoryMissionStore();
    const kernel = await createMission(store);
    await reserveChild(kernel, 'planner', 'planner-for-step-key');
    await dispatch(kernel, 'start-planner-for-step-key', {
      type: 'start-child',
      childId: 'planner-for-step-key',
      attemptId: 'attempt:planner-for-step-key',
    });
    await dispatch(kernel, 'complete-planner-for-step-key', {
      type: 'complete-child',
      childId: 'planner-for-step-key',
      outcome: 'succeeded',
      summary: 'Planner produced one trusted step.',
      usage: CHILD_USAGE,
      artifact: {
        type: 'execution-plan',
        summary: 'One step.',
        steps: [
          {
            id: 'reusable-human-id',
            title: 'Bound step',
            profileId: 'builder',
            reviewProfileId: 'reviewer',
            instruction: 'Run the bound plan step.',
            acceptance: ['The child receives the opaque plan identity.'],
          },
        ],
      },
    });
    await dispatch(kernel, 'adopt-planner-for-step-key', {
      type: 'adopt-execution-plan',
      guideEpoch: (await kernel.inspect(MISSION_ID)).guideEpoch,
      plannerChildId: 'planner-for-step-key',
      planFingerprint: missionExecutionPlanFingerprint(
        (await kernel.inspect(MISSION_ID)).children['planner-for-step-key']!.artifact as Parameters<
          typeof missionExecutionPlanFingerprint
        >[0],
      ),
    });
    const observedStepKeys: Array<string | null> = [];
    const script = scriptedGuide((request) => ({
      output: envelope(request, 'finish-plan-step-key', {
        type: 'propose_completion',
        outcome: 'failed',
        reason: 'The scheduler key was observed.',
      }),
      usage: GUIDE_USAGE,
    }));

    const stop = await new MissionHarness({
      store,
      guide: script.guide,
      children: {
        async startOrAttach(request) {
          observedStepKeys.push(request.child.planStepId);
          return {
            attemptId: request.attemptId,
            async cancel() {},
            async done() {
              return { outcome: 'failed', summary: 'Stop after key observation.', usage: CHILD_USAGE };
            },
          };
        },
      },
      evidence: reconcileTerminalWriteEvidence,
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop.reason).toBe('terminal');
    expect(observedStepKeys).toEqual([
      missionPlanStepKey(MISSION_ID, 'planner-for-step-key', 'reusable-human-id'),
    ]);
  });

  it('returns to the guide without reviewing or advancing past a dirty plan checkpoint', async () => {
    const store = new MemoryMissionStore();
    // Two fully reserved work/review lineages plus approval/completion guide turns must fit before
    // the kernel accepts the plan. This test exercises dirty-checkpoint scheduling, not admission.
    const kernel = await createMission(store, { missionActiveSeconds: 2_000 });
    await reserveChild(kernel, 'planner', 'planner-for-dirty-checkpoint');
    await dispatch(kernel, 'start-planner-for-dirty-checkpoint', {
      type: 'start-child',
      childId: 'planner-for-dirty-checkpoint',
      attemptId: 'attempt:planner-for-dirty-checkpoint',
    });
    await dispatch(kernel, 'complete-planner-for-dirty-checkpoint', {
      type: 'complete-child',
      childId: 'planner-for-dirty-checkpoint',
      outcome: 'succeeded',
      summary: 'Planner produced two steps.',
      usage: CHILD_USAGE,
      artifact: {
        type: 'execution-plan',
        summary: 'Dirty checkpoint must stop scheduling.',
        steps: [
          {
            id: 'dirty-first',
            title: 'Dirty first step',
            profileId: 'builder',
            reviewProfileId: 'reviewer',
            instruction: 'Produce a checkpoint.',
            acceptance: ['Checkpoint is clean.'],
          },
          {
            id: 'must-not-start',
            title: 'Later step',
            profileId: 'builder',
            reviewProfileId: 'reviewer',
            instruction: 'This must not start while the workspace is dirty.',
            acceptance: ['The prior step is clean.'],
          },
        ],
      },
    });
    await dispatch(kernel, 'adopt-planner-for-dirty-checkpoint', {
      type: 'adopt-execution-plan',
      guideEpoch: (await kernel.inspect(MISSION_ID)).guideEpoch,
      plannerChildId: 'planner-for-dirty-checkpoint',
      planFingerprint: missionExecutionPlanFingerprint(
        (await kernel.inspect(MISSION_ID)).children['planner-for-dirty-checkpoint']!.artifact as Parameters<
          typeof missionExecutionPlanFingerprint
        >[0],
      ),
    });
    const executedRoles: string[] = [];
    const script = scriptedGuide((request) => ({
      output: envelope(request, 'stop-on-dirty-checkpoint', {
        type: 'propose_completion',
        outcome: 'failed',
        reason: 'A dirty plan checkpoint requires guide intervention.',
      }),
      usage: GUIDE_USAGE,
    }));

    const stop = await new MissionHarness({
      store,
      guide: script.guide,
      children: {
        async startOrAttach(request) {
          executedRoles.push(`${request.child.role}:${request.child.subjectCheckpointId ?? 'work'}`);
          return {
            attemptId: request.attemptId,
            async cancel() {},
            async done() {
              return { outcome: 'succeeded', summary: 'Work left dirty.', usage: CHILD_USAGE };
            },
          };
        },
      },
      evidence: {
        async recordAfterChild(state, child) {
          const checkpoint = Object.values(state.checkpoints).find(
            (candidate) => candidate.authorChildId === child.childId,
          );
          if (checkpoint) {
            return [
              {
                type: 'record-workspace-reconciled',
                childId: child.childId,
                revisionId: checkpoint.revisionId,
                disposition: 'restored',
                summary: 'Restored the dirty worktree to its exact recorded revision.',
              },
            ];
          }
          return [
            {
              type: 'record-checkpoint',
              checkpointId: 'dirty-checkpoint',
              revisionId: 'dirty-revision',
              authorChildId: child.childId,
              clean: false,
            },
          ];
        },
      },
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop.state.terminal?.reason).toContain('dirty plan checkpoint');
    expect(executedRoles).toEqual(['builder:work']);
    expect(Object.keys(stop.state.children)).toHaveLength(2); // planner + first worker only
    expect(stop.state.reviews).toEqual({});
  });
});

describe('MissionHarness evidence, questions, and epilogues', () => {
  it('reconciles failed write residue durably before launching the next child', async () => {
    const store = new MemoryMissionStore();
    await createMission(store);
    const started: string[] = [];
    const script = scriptedGuide(
      (request) => ({
        output: envelope(request, 'dispatch-failed-writer', {
          type: 'dispatch_child',
          childId: 'failed-writer',
          profileId: 'builder',
          instruction: 'Attempt the first write.',
        }),
        usage: GUIDE_USAGE,
      }),
      (request) => {
        expect(request.projection.children[0]?.workspaceReconciliation).toMatchObject({
          source: 'harness',
          disposition: 'restored',
          revisionId: 'workspace-base',
        });
        return {
          output: envelope(request, 'dispatch-later-writer', {
            type: 'dispatch_child',
            childId: 'later-writer',
            profileId: 'builder',
            instruction: 'Run only after the prior residue is gone.',
          }),
          usage: GUIDE_USAGE,
        };
      },
      (request) => ({
        output: envelope(request, 'finish-after-reconciled-writes', {
          type: 'propose_completion',
          outcome: 'failed',
          reason: 'Both expected failure paths were safely reconciled.',
        }),
        usage: GUIDE_USAGE,
      }),
    );

    const stop = await new MissionHarness({
      store,
      guide: script.guide,
      children: {
        async startOrAttach(request) {
          started.push(request.child.childId);
          return {
            attemptId: request.attemptId,
            async cancel() {},
            async done() {
              return { outcome: 'failed', summary: 'Expected write failure.', usage: CHILD_USAGE };
            },
          };
        },
      },
      evidence: {
        async recordAfterChild(_state, child) {
          return [
            {
              type: 'record-workspace-reconciled',
              childId: child.childId,
              revisionId: 'workspace-base',
              disposition: 'restored',
              summary: 'Restored the workspace to its exact clean base.',
            },
          ];
        },
      },
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop).toMatchObject({ reason: 'terminal', state: { terminal: { outcome: 'failed' } } });
    expect(started).toEqual(['failed-writer', 'later-writer']);
    const events = (await store.load(MISSION_ID)).events.map((entry) => entry.event);
    const completedFirst = events.findIndex(
      (event) => event.type === 'child-completed' && event.childId === 'failed-writer',
    );
    const reconciledFirst = events.findIndex(
      (event) => event.type === 'workspace-reconciled' && event.childId === 'failed-writer',
    );
    const reservedSecond = events.findIndex(
      (event) => event.type === 'child-reserved' && event.child.childId === 'later-writer',
    );
    expect(completedFirst).toBeLessThan(reconciledFirst);
    expect(reconciledFirst).toBeLessThan(reservedSecond);
  });

  it('journals explicit not-applicable validation before succeeding without a checkpoint', async () => {
    const store = new MemoryMissionStore();
    await createMission(store, {
      validationPolicy: {
        kind: 'none',
        policyId: 'test-no-validation',
        reason: '🚀'.repeat(8_192),
      },
    });
    const script = scriptedGuide((request) => ({
      output: envelope(request, 'complete-without-checkpoint', {
        type: 'propose_completion',
        outcome: 'succeeded',
        reason: 'This mission intentionally required no workspace revision.',
      }),
      usage: GUIDE_USAGE,
    }));

    const stop = await new MissionHarness({
      store,
      guide: script.guide,
      children: unusedChildren,
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop.reason, stop.reason === 'runtime-error' ? stop.error : '').toBe('terminal');
    expect(stop).toMatchObject({
      state: {
        terminal: {
          outcome: 'succeeded',
          checkpointId: null,
        },
      },
    });
    expect(script.requests[0]?.projection.validation).toEqual({
      policy: { kind: 'none', policyId: 'test-no-validation' },
      active: null,
      latest: expect.objectContaining({
        checkpointId: null,
        revisionId: null,
        policyId: 'test-no-validation',
        disposition: 'not-applicable',
      }),
    });
    expect(stop.state.acceptedRevisionHandoff).toBeNull();
    const validation = stop.state.validations[stop.state.validationOrder[0]!];
    expect(Buffer.byteLength(validation?.outputTail ?? '', 'utf8')).toBe(MAX_MISSION_VALIDATION_OUTPUT_BYTES);
    const events = (await store.load(MISSION_ID)).events.map((entry) => entry.event.type);
    expect(events.indexOf('validation-recorded')).toBeLessThan(events.indexOf('guide-turn-started'));
  });

  it('returns failed deterministic validation to the guide and refuses fake success', async () => {
    const store = new MemoryMissionStore();
    const kernel = await createMission(store, {
      validationPolicy: {
        kind: 'command',
        policyId: 'exact-checkpoint-tests',
        command: 'npm test',
        timeoutSeconds: 120,
        shell: null,
      },
      completion: { requireCheckpoint: true, requireReview: false },
    });
    await dispatch(kernel, 'record-validation-subject', {
      type: 'record-checkpoint',
      checkpointId: 'validation-subject',
      revisionId: 'validation-revision',
      authorChildId: null,
      parentCheckpointId: null,
      clean: true,
      description: 'Exact clean validation subject.',
    });
    let validationCalls = 0;
    let handoffCalls = 0;
    const script = scriptedGuide(
      (request) => ({
        output: envelope(request, 'fake-success-after-failed-validation', {
          type: 'propose_completion',
          outcome: 'succeeded',
          reason: 'Attempt to bypass failed deterministic validation.',
          checkpointId: 'validation-subject',
        }),
        usage: GUIDE_USAGE,
      }),
      (request) => ({
        output: envelope(request, 'honest-failure-after-refusal', {
          type: 'propose_completion',
          outcome: 'failed',
          reason: 'Deterministic validation failed and no repair was requested.',
        }),
        usage: GUIDE_USAGE,
      }),
    );

    const stop = await new MissionHarness({
      store,
      guide: script.guide,
      children: unusedChildren,
      validation: {
        async validate(state, checkpoint, policy) {
          validationCalls += 1;
          return {
            type: 'record-validation',
            validationId: state.activeValidation!.validationId,
            checkpointId: checkpoint.checkpointId,
            revisionId: checkpoint.revisionId,
            policyId: policy.policyId,
            disposition: 'failed',
            exitCode: 1,
            timedOut: false,
            workspaceChanged: false,
            outputTail: 'One deterministic assertion failed.',
          };
        },
        async recover(state, checkpoint, policy) {
          return {
            type: 'record-validation',
            validationId: state.activeValidation!.validationId,
            checkpointId: checkpoint.checkpointId,
            revisionId: checkpoint.revisionId,
            policyId: policy.policyId,
            disposition: 'failed',
            exitCode: null,
            timedOut: false,
            workspaceChanged: false,
            outputTail: 'Recovered interrupted validation.',
          };
        },
      },
      acceptedRevisionHandoff: {
        async record() {
          handoffCalls += 1;
          return null;
        },
      },
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop).toMatchObject({ reason: 'terminal', state: { terminal: { outcome: 'failed' } } });
    expect(validationCalls).toBe(1);
    expect(handoffCalls).toBe(0);
    expect(script.calls()).toBe(2);
    expect(script.requests[0]?.projection.validation.latest).toMatchObject({
      validationId: expect.stringMatching(/^validation:/),
      checkpointId: 'validation-subject',
      revisionId: 'validation-revision',
      disposition: 'failed',
      exitCode: 1,
    });
    expect(script.requests[1]?.projection.guideTurns.lastFeedback?.summary).toContain(
      "success requires validation disposition 'passed'",
    );
  });

  it('recovers a nonterminal inherited validation without rerunning its command', async () => {
    const store = new MemoryMissionStore();
    const commandPolicy = {
      kind: 'command' as const,
      policyId: 'inherited-validation-v1',
      command: 'npm test',
      timeoutSeconds: 60,
      shell: null,
    };
    const kernel = await createMission(store, { validationPolicy: commandPolicy });
    await dispatch(kernel, 'inherited-validation-checkpoint', {
      type: 'record-checkpoint',
      checkpointId: 'inherited-validation-subject',
      revisionId: 'inherited-validation-revision',
      authorChildId: null,
      changed: true,
      clean: true,
    });
    await dispatch(kernel, 'inherited-validation-start', {
      type: 'begin-validation',
      validationId: deterministicEffectId(
        'validation',
        MISSION_ID,
        'inherited-validation-subject',
        'inherited-validation-revision',
        commandPolicy.policyId,
      ),
      checkpointId: 'inherited-validation-subject',
      revisionId: 'inherited-validation-revision',
      policyId: commandPolicy.policyId,
    });
    let validateCalls = 0;
    let recoverCalls = 0;
    const script = scriptedGuide((request) => ({
      output: envelope(request, 'stop-after-interrupted-validation', {
        type: 'propose_completion',
        outcome: 'failed',
        reason: 'The inherited validation attempt was conservatively recovered as failed.',
      }),
      usage: GUIDE_USAGE,
    }));

    const stop = await new MissionHarness({
      store,
      guide: script.guide,
      children: unusedChildren,
      validation: {
        async validate() {
          validateCalls += 1;
          throw new Error('restart recovery must not rerun an inherited validation command');
        },
        async recover(state, checkpoint, policy) {
          recoverCalls += 1;
          return {
            type: 'record-validation',
            validationId: state.activeValidation!.validationId,
            checkpointId: checkpoint.checkpointId,
            revisionId: checkpoint.revisionId,
            policyId: policy.policyId,
            disposition: 'failed',
            exitCode: null,
            timedOut: false,
            workspaceChanged: true,
            outputTail: 'Interrupted validator residue was removed without rerunning the command.',
          };
        },
      },
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop).toMatchObject({
      reason: 'terminal',
      state: { status: 'failed', activeValidation: null, terminal: { outcome: 'failed' } },
    });
    expect(validateCalls).toBe(0);
    expect(recoverCalls).toBe(1);
    expect(script.calls()).toBe(1);
    expect(script.requests[0]?.projection.validation.latest).toMatchObject({
      validationId: expect.stringMatching(/^validation:/),
      disposition: 'failed',
      workspaceChanged: true,
    });
  });

  it('recovers a durably started validation after terminal cancellation without rerunning it', async () => {
    const store = new MemoryMissionStore();
    const commandPolicy = {
      kind: 'command' as const,
      policyId: 'terminal-validation-v1',
      command: 'npm test',
      timeoutSeconds: 60,
      shell: null,
    };
    const kernel = await createMission(store, { validationPolicy: commandPolicy });
    await dispatch(kernel, 'terminal-validation-checkpoint', {
      type: 'record-checkpoint',
      checkpointId: 'terminal-validation-subject',
      revisionId: 'terminal-validation-revision',
      authorChildId: null,
      changed: true,
      clean: true,
    });
    await dispatch(kernel, 'terminal-validation-start', {
      type: 'begin-validation',
      validationId: 'terminal-validation-attempt',
      checkpointId: 'terminal-validation-subject',
      revisionId: 'terminal-validation-revision',
      policyId: commandPolicy.policyId,
    });
    await dispatch(kernel, 'terminal-validation-cancel', {
      type: 'complete-mission',
      guideEpoch: (await kernel.inspect(MISSION_ID)).guideEpoch,
      outcome: 'cancelled',
      reason: 'Operator cancelled during deterministic validation.',
    });
    let validateCalls = 0;
    let recoverCalls = 0;
    const stop = await new MissionHarness({
      store,
      guide: {
        async next() {
          throw new Error('terminal recovery must not invoke the guide');
        },
      },
      children: unusedChildren,
      validation: {
        async validate() {
          validateCalls += 1;
          throw new Error('terminal recovery must not rerun validation');
        },
        async recover(state, checkpoint, policy) {
          recoverCalls += 1;
          return {
            type: 'record-validation',
            validationId: state.activeValidation!.validationId,
            checkpointId: checkpoint.checkpointId,
            revisionId: checkpoint.revisionId,
            policyId: policy.policyId,
            disposition: 'failed',
            exitCode: null,
            timedOut: false,
            workspaceChanged: true,
            outputTail: 'Interrupted validator residue was removed without rerunning the command.',
          };
        },
      },
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop.reason, stop.reason === 'runtime-error' ? stop.error : '').toBe('terminal');
    expect(stop).toMatchObject({
      reason: 'terminal',
      state: {
        status: 'cancelled',
        activeValidation: null,
        terminal: { outcome: 'cancelled' },
      },
    });
    expect(validateCalls).toBe(0);
    expect(recoverCalls).toBe(1);
    expect(stop.state.validations['terminal-validation-attempt']).toMatchObject({
      disposition: 'failed',
      workspaceChanged: true,
    });
    const actions = (await store.load(MISSION_ID)).actions.map((entry) => entry.action.type);
    expect(actions.indexOf('begin-validation')).toBeLessThan(actions.indexOf('complete-mission'));
    expect(actions.indexOf('complete-mission')).toBeLessThan(actions.indexOf('record-validation'));
  });

  it('returns durable terminal cancellation after an in-flight validator acknowledges abort', async () => {
    const store = new MemoryMissionStore();
    const commandPolicy = {
      kind: 'command' as const,
      policyId: 'cancel-live-validation-v1',
      command: 'npm test',
      timeoutSeconds: 60,
      shell: null,
    };
    const kernel = await createMission(store, { validationPolicy: commandPolicy });
    await dispatch(kernel, 'cancel-live-validation-checkpoint', {
      type: 'record-checkpoint',
      checkpointId: 'cancel-live-validation-subject',
      revisionId: 'cancel-live-validation-revision',
      authorChildId: null,
      changed: true,
      clean: true,
    });
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    let validateCalls = 0;
    let recoverCalls = 0;
    const harness = new MissionHarness({
      store,
      guide: {
        async next() {
          throw new Error('cancellation during validation must not invoke the guide');
        },
      },
      children: unusedChildren,
      validation: {
        async validate(_state, _checkpoint, _policy, signal) {
          validateCalls += 1;
          enteredResolve();
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', () => resolve(), { once: true });
          });
          throw new Error('contained validator acknowledged cancellation');
        },
        async recover(state, checkpoint, policy) {
          recoverCalls += 1;
          return {
            type: 'record-validation',
            validationId: state.activeValidation!.validationId,
            checkpointId: checkpoint.checkpointId,
            revisionId: checkpoint.revisionId,
            policyId: policy.policyId,
            disposition: 'failed',
            exitCode: null,
            timedOut: false,
            workspaceChanged: false,
            outputTail: 'Cancelled validator settled and was not rerun.',
          };
        },
      },
      newTurnId: turnIds(),
    });

    const controlling = harness.run(MISSION_ID);
    await entered;
    const cancelled = await harness.cancelMission(MISSION_ID, 'Operator cancelled validation.');
    const originalController = await controlling;

    expect(cancelled).toMatchObject({
      reason: 'terminal',
      state: { status: 'cancelled', activeValidation: null, terminal: { outcome: 'cancelled' } },
    });
    expect(originalController).toEqual(cancelled);
    expect(validateCalls).toBe(1);
    expect(recoverCalls).toBe(1);
  });

  it('does not report checkpoint success until a preserved revision handoff is journaled', async () => {
    const store = new MemoryMissionStore();
    const kernel = await createMission(store, {
      completion: { requireCheckpoint: true, requireReview: false },
    });
    await dispatch(kernel, 'record-unpreserved-subject', {
      type: 'record-checkpoint',
      checkpointId: 'unpreserved-subject',
      revisionId: 'unpreserved-revision',
      authorChildId: null,
      parentCheckpointId: null,
      clean: true,
      description: 'A clean revision that still needs a durable name.',
    });
    const script = scriptedGuide((request) => ({
      output: envelope(request, 'complete-before-handoff', {
        type: 'propose_completion',
        outcome: 'succeeded',
        reason: 'The clean revision is accepted.',
        checkpointId: 'unpreserved-subject',
      }),
      usage: GUIDE_USAGE,
    }));

    const stop = await new MissionHarness({
      store,
      guide: script.guide,
      children: unusedChildren,
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop).toMatchObject({
      reason: 'runtime-error',
      error: 'accepted-revision handoff recorder is unavailable after successful cleanup',
      state: { terminal: { outcome: 'succeeded', checkpointId: 'unpreserved-subject' } },
    });
    expect(stop.state.acceptedRevisionHandoff).toBeNull();
  });

  it('binds builder evidence, an independent reviewer, and success to one exact checkpoint', async () => {
    const store = new MemoryMissionStore();
    await createMission(store, {
      completion: { requireCheckpoint: true, requireReview: true },
      cleanup: ['workspace'],
    });
    const reviewedSubjects: Array<string | null> = [];
    const epilogueOrder: string[] = [];
    const script = scriptedGuide(
      (request) => ({
        output: envelope(request, 'dispatch-builder', {
          type: 'dispatch_child',
          childId: 'builder-evidence',
          profileId: 'builder',
          instruction: 'Implement and leave a clean VCS checkpoint.',
        }),
        usage: GUIDE_USAGE,
      }),
      (request) => {
        const checkpointId = request.projection.checkpoint?.checkpointId ?? 'missing-checkpoint';
        return {
          output: envelope(request, 'dispatch-reviewer', {
            type: 'dispatch_child',
            childId: 'reviewer-evidence',
            profileId: 'reviewer',
            instruction: 'Review the exact immutable checkpoint read-only.',
            subjectCheckpointId: checkpointId,
          }),
          usage: GUIDE_USAGE,
        };
      },
      (request) => ({
        output: envelope(request, 'complete-reviewed-work', {
          type: 'propose_completion',
          outcome: 'succeeded',
          reason: 'The exact latest checkpoint has a passing independent review.',
          checkpointId: request.projection.checkpoint?.checkpointId,
        }),
        usage: GUIDE_USAGE,
      }),
    );

    const stop = await new MissionHarness({
      store,
      guide: script.guide,
      children: {
        async startOrAttach(request) {
          if (request.child.permission === 'read') {
            reviewedSubjects.push(request.child.subjectCheckpointId);
          }
          return {
            attemptId: request.attemptId,
            async cancel() {},
            async done() {
              const result: MissionChildResult = {
                outcome: 'succeeded',
                summary: `${request.child.role} produced bounded evidence.`,
                usage: CHILD_USAGE,
              };
              if (request.child.permission === 'read') {
                result.artifact = {
                  type: 'review',
                  checkpointId: request.child.subjectCheckpointId ?? 'missing-subject',
                  revisionId: 'git-sha-exact',
                  verdict: 'passed',
                  highestSeverity: 'none',
                  summary: 'The exact checkpoint passed independent review.',
                };
              }
              return result;
            },
          };
        },
      },
      evidence: {
        async recordAfterChild(_state, child) {
          if (child.permission === 'write') {
            return [
              {
                type: 'record-checkpoint',
                checkpointId: 'checkpoint-exact',
                revisionId: 'git-sha-exact',
                authorChildId: child.childId,
                parentCheckpointId: null,
                clean: true,
                description: 'Clean builder checkpoint.',
              },
            ];
          }
          return [
            {
              type: 'record-review',
              reviewId: 'review-exact',
              reviewerChildId: child.childId,
              checkpointId: child.subjectCheckpointId ?? 'missing-subject',
              revisionId: 'git-sha-exact',
              verdict: 'passed',
              highestSeverity: 'none',
              summary: 'The exact checkpoint passed independent review.',
            },
          ];
        },
      },
      cleanup: {
        async execute(state, cleanupId) {
          epilogueOrder.push(`cleanup:${cleanupId}:${state.terminal?.outcome ?? 'active'}`);
        },
      },
      acceptedRevisionHandoff: {
        async record(state) {
          epilogueOrder.push(`handoff:${state.cleanup.workspace?.status ?? 'missing'}`);
          return preservedTestHandoff.record(state);
        },
      },
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop.reason).toBe('terminal');
    expect(stop.state.terminal).toEqual({
      outcome: 'succeeded',
      reason: 'The exact latest checkpoint has a passing independent review.',
      checkpointId: 'checkpoint-exact',
    });
    expect(reviewedSubjects).toEqual(['checkpoint-exact']);
    expect(stop.state.checkpoints['checkpoint-exact']).toMatchObject({
      revisionId: 'git-sha-exact',
      authorChildId: 'builder-evidence',
      clean: true,
    });
    expect(stop.state.reviews['review-exact']).toMatchObject({
      reviewerChildId: 'reviewer-evidence',
      checkpointId: 'checkpoint-exact',
      revisionId: 'git-sha-exact',
      verdict: 'passed',
      highestSeverity: 'none',
    });
    expect(script.requests[2]?.projection.checkpoint?.review).toMatchObject({
      reviewId: 'review-exact',
      reviewerChildId: 'reviewer-evidence',
      verdict: 'passed',
    });
    expect(epilogueOrder).toEqual(['cleanup:workspace:succeeded', 'handoff:completed']);
    expect(stop.state.acceptedRevisionHandoff).toEqual({
      backend: 'git',
      repositoryKey: 'runner',
      checkpointId: 'checkpoint-exact',
      revisionId: 'git-sha-exact',
      reference: `refs/heads/noriq/run/${MISSION_ID}`,
      status: 'preserved',
    });
    const actionTypes = (await store.load(MISSION_ID)).actions.map((entry) => entry.action.type);
    expect(actionTypes.indexOf('complete-cleanup')).toBeLessThan(
      actionTypes.indexOf('record-accepted-revision-handoff'),
    );
  });

  it('rejects evidence recorder review fields that differ from the child review artifact', async () => {
    const store = new MemoryMissionStore();
    const kernel = await createMission(store);
    await reserveChild(kernel, 'builder', 'artifact-writer');
    await dispatch(kernel, 'start-artifact-writer', {
      type: 'start-child',
      childId: 'artifact-writer',
      attemptId: 'attempt:artifact-writer',
    });
    await dispatch(kernel, 'complete-artifact-writer', {
      type: 'complete-child',
      childId: 'artifact-writer',
      outcome: 'succeeded',
      summary: 'Writer done.',
      usage: CHILD_USAGE,
    });
    await dispatch(kernel, 'record-artifact-checkpoint', {
      type: 'record-checkpoint',
      checkpointId: 'artifact-subject',
      revisionId: 'artifact-sha',
      authorChildId: 'artifact-writer',
      clean: true,
    });
    await reserveChild(kernel, 'reviewer', 'artifact-reviewer', 'artifact-subject');

    const stop = await new MissionHarness({
      store,
      guide: {
        async next() {
          throw new Error('mismatched evidence must fail before guide work');
        },
      },
      children: {
        async startOrAttach(request) {
          return {
            attemptId: request.attemptId,
            async cancel() {},
            async done(): Promise<MissionChildResult> {
              return {
                outcome: 'succeeded',
                summary: 'Machine-validated artifact ready.',
                usage: CHILD_USAGE,
                artifact: {
                  type: 'review',
                  checkpointId: 'artifact-subject',
                  revisionId: 'artifact-sha',
                  verdict: 'changes-requested',
                  highestSeverity: 'high',
                  summary: 'A high-severity defect remains.',
                },
              };
            },
          };
        },
      },
      evidence: {
        async recordAfterChild(_state, child) {
          return [
            {
              type: 'record-review',
              reviewId: 'rubber-stamp',
              reviewerChildId: child.childId,
              checkpointId: 'artifact-subject',
              revisionId: 'artifact-sha',
              verdict: 'passed',
              highestSeverity: 'none',
              summary: 'The adapter must not rewrite the artifact as a pass.',
            },
          ];
        },
      },
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop).toMatchObject({
      reason: 'terminal',
      state: {
        status: 'failed',
        terminal: { reason: expect.stringContaining('does not exactly match') },
        reviews: {},
      },
    });
  });

  it('rejects evidence whose type or attribution does not match the completed child role', async () => {
    const store = new MemoryMissionStore();
    const kernel = await createMission(store);
    await reserveChild(kernel, 'builder', 'evidence-author');

    const stop = await new MissionHarness({
      store,
      guide: {
        async next() {
          throw new Error('misattributed evidence must fail before guide work');
        },
      },
      children: {
        async startOrAttach(request) {
          return {
            attemptId: request.attemptId,
            async cancel() {},
            async done() {
              return { outcome: 'succeeded', summary: 'Writer settled.', usage: CHILD_USAGE };
            },
          };
        },
      },
      evidence: {
        async recordAfterChild(state, child) {
          if (state.terminal) return reconcileTerminalWriteEvidence.recordAfterChild(state, child);
          return [
            {
              type: 'record-checkpoint' as const,
              checkpointId: 'misattributed-checkpoint',
              revisionId: 'misattributed-revision',
              authorChildId: 'another-child',
              clean: true,
            },
          ];
        },
      },
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop).toMatchObject({
      reason: 'terminal',
      state: { status: 'failed', checkpoints: {} },
    });
    expect(stop.state.terminal?.reason).toContain('requires exactly one checkpoint attributed to itself');
  });

  it('journals a human question before notification and resumes only after its durable answer', async () => {
    const store = new MemoryMissionStore();
    await createMission(store);
    const kernel = new MissionKernel(store);
    const callbackSnapshots: Array<{ status: string; lastAction: string | undefined }> = [];
    const script = scriptedGuide(
      (request) => ({
        output: envelope(request, 'blocking-decision', {
          type: 'ask_human',
          question: 'Which approved behavior should the mission preserve?',
        }),
        usage: GUIDE_USAGE,
      }),
      (request) => ({
        output: envelope(request, 'finish-after-answer', {
          type: 'propose_completion',
          outcome: 'failed',
          reason: `Recorded answer: ${request.projection.questions[0]?.answer ?? 'missing'}`,
        }),
        usage: GUIDE_USAGE,
      }),
    );
    const harness = new MissionHarness({
      store,
      guide: script.guide,
      children: unusedChildren,
      newTurnId: turnIds(),
      async onQuestion(question) {
        const durable = await kernel.inspect(MISSION_ID);
        const history = await store.load(MISSION_ID);
        callbackSnapshots.push({
          status: durable.questions[question.questionId]?.status ?? 'missing',
          lastAction: history.actions.at(-1)?.action.type,
        });
      },
    });

    const parked = await harness.run(MISSION_ID);
    expect(parked.reason).toBe('human-question');
    if (parked.reason !== 'human-question') throw new Error(`unexpected stop: ${parked.reason}`);
    expect(callbackSnapshots).toEqual([{ status: 'pending', lastAction: 'apply-guide-proposal' }]);
    expect(parked.state.guideTurns['turn-1']?.status).toBe('applied');

    const answered = await harness.answerQuestion(
      MISSION_ID,
      parked.question.questionId,
      'Preserve the reviewed compatibility behavior.',
    );
    expect(answered.questions[parked.question.questionId]).toMatchObject({
      status: 'answered',
      answer: 'Preserve the reviewed compatibility behavior.',
    });

    const completed = await harness.run(MISSION_ID);
    expect(completed.reason).toBe('terminal');
    expect(completed.state.terminal?.reason).toContain('Preserve the reviewed compatibility behavior.');
    expect(script.calls()).toBe(2);
    expect(callbackSnapshots).toHaveLength(1);
  });

  it('cancels a durable running attempt and finishes cleanup without changing terminal outcome', async () => {
    const store = new MemoryMissionStore();
    const kernel = await createMission(store, { cleanup: ['workspace', 'lease'] });
    await reserveChild(kernel, 'builder', 'builder-cancel');
    await dispatch(kernel, 'start-before-cancel', {
      type: 'start-child',
      childId: 'builder-cancel',
      attemptId: 'attempt:cancelled-running-child',
    });
    const cancellations: Array<{ reason: string; status: string; terminal: string | undefined }> = [];
    const cleanups: Array<{ cleanupId: string; childStatus: string | undefined }> = [];
    let handoffCalls = 0;

    const harness = new MissionHarness({
      store,
      guide: {
        async next() {
          throw new Error('terminal reconciliation must not invoke the guide');
        },
      },
      children: {
        async startOrAttach(request) {
          let cancelled = false;
          return {
            attemptId: request.attemptId,
            usageAtAttach: { tokens: 0, usd: 0, activeSeconds: 0 },
            async cancel(reason) {
              const durable = await kernel.inspect(MISSION_ID);
              cancellations.push({
                reason,
                status: durable.children[request.child.childId]?.status ?? 'missing',
                terminal: durable.terminal?.outcome,
              });
              cancelled = true;
            },
            async done() {
              return {
                outcome: cancelled ? 'cancelled' : 'lost',
                summary: 'Terminal epilogue settled the child.',
                usage: CHILD_USAGE,
              };
            },
          };
        },
      },
      evidence: {
        async recordAfterChild(_state, child) {
          return [
            {
              type: 'record-workspace-reconciled',
              childId: child.childId,
              revisionId: 'cancelled-workspace-base',
              disposition: 'restored',
              summary: 'Removed cancelled write residue before cleanup released the workspace.',
            },
          ];
        },
      },
      cleanup: {
        async execute(state, cleanupId) {
          cleanups.push({ cleanupId, childStatus: state.children['builder-cancel']?.status });
        },
      },
      acceptedRevisionHandoff: {
        async record() {
          handoffCalls += 1;
          return null;
        },
      },
      newTurnId: turnIds(),
    });

    const stop = await harness.cancelMission(MISSION_ID, 'Operator cancelled the mission.');
    expect(stop.reason).toBe('terminal');
    expect(stop.state.terminal).toMatchObject({
      outcome: 'cancelled',
      reason: 'Operator cancelled the mission.',
    });
    expect(cancellations).toEqual([
      {
        reason: 'mission cancelled: Operator cancelled the mission.',
        status: 'cancelling',
        terminal: 'cancelled',
      },
    ]);
    expect(cleanups).toEqual([
      { cleanupId: 'workspace', childStatus: 'cancelled' },
      { cleanupId: 'lease', childStatus: 'cancelled' },
    ]);
    expect(handoffCalls).toBe(0);
    expect(stop.state.cleanup).toMatchObject({
      workspace: { status: 'completed', error: null },
      lease: { status: 'completed', error: null },
    });
    const actions = (await store.load(MISSION_ID)).actions.map((entry) => entry.action.type);
    expect(actions.indexOf('complete-mission')).toBeLessThan(actions.indexOf('complete-child'));
    expect(actions.indexOf('complete-child')).toBeLessThan(actions.indexOf('record-workspace-reconciled'));
    expect(actions.indexOf('record-workspace-reconciled')).toBeLessThan(actions.indexOf('complete-cleanup'));
    expect(actions.indexOf('complete-child')).toBeLessThan(actions.indexOf('complete-cleanup'));
  });

  it('preserves terminal workspace reconciliation after a transient evidence failure', async () => {
    const store = new MemoryMissionStore();
    const kernel = await createMission(store, { cleanup: ['workspace'] });
    await reserveChild(kernel, 'builder', 'terminal-failed-writer');
    await dispatch(kernel, 'terminal-failed-writer-start', {
      type: 'start-child',
      childId: 'terminal-failed-writer',
      attemptId: 'attempt:terminal-failed-writer',
    });
    await dispatch(kernel, 'terminal-failed-writer-exit', {
      type: 'complete-child',
      childId: 'terminal-failed-writer',
      outcome: 'failed',
      summary: 'Write failed with possible residue.',
      usage: CHILD_USAGE,
    });
    await dispatch(kernel, 'terminal-after-failed-write', {
      type: 'complete-mission',
      guideEpoch: (await kernel.inspect(MISSION_ID)).guideEpoch,
      outcome: 'failed',
      reason: 'Stop after the failed write.',
    });
    let evidenceAttempts = 0;
    const cleanups: string[] = [];
    const harness = new MissionHarness({
      store,
      guide: {
        async next() {
          throw new Error('terminal mission must not invoke the guide');
        },
      },
      children: unusedChildren,
      evidence: {
        async recordAfterChild(_state, child) {
          evidenceAttempts += 1;
          if (evidenceAttempts === 1) throw new Error('VCS adapter temporarily unavailable');
          return [
            {
              type: 'record-workspace-reconciled',
              childId: child.childId,
              revisionId: 'terminal-base',
              disposition: 'quarantined',
              summary: 'Quarantined the contaminated workspace on retry.',
            },
          ];
        },
      },
      cleanup: {
        async execute(_state, cleanupId) {
          cleanups.push(cleanupId);
        },
      },
    });

    const first = await harness.run(MISSION_ID);
    expect(first).toMatchObject({
      reason: 'runtime-error',
      error: expect.stringContaining('VCS adapter temporarily unavailable'),
      state: { status: 'failed', workspaceReconciliations: {} },
    });
    expect(cleanups).toEqual([]);

    const second = await harness.run(MISSION_ID);
    expect(second).toMatchObject({
      reason: 'terminal',
      state: {
        workspaceReconciliations: {
          'terminal-failed-writer': { disposition: 'quarantined', revisionId: 'terminal-base' },
        },
        cleanup: { workspace: { status: 'completed' } },
      },
    });
    expect(evidenceAttempts).toBe(2);
    expect(cleanups).toEqual(['workspace']);
  });

  it('applies a durable proposed guide action after restart without invoking a new guide', async () => {
    const store = new MemoryMissionStore();
    const kernel = await createMission(store);
    await dispatch(kernel, 'begin-before-restart', {
      type: 'begin-guide-turn',
      guideEpoch: 0,
      turnId: 'restart-proposal',
    });
    await dispatch(kernel, 'complete-before-restart', {
      type: 'complete-guide-turn',
      turnId: 'restart-proposal',
      outcome: 'proposed',
      summary: 'guide proposed propose_completion',
      usage: GUIDE_USAGE,
      proposal: {
        type: 'complete-mission',
        guideEpoch: 0,
        outcome: 'failed',
        reason: 'Recovered the already-metered durable proposal.',
      },
    });
    let guideCalls = 0;

    const stop = await new MissionHarness({
      store,
      guide: {
        async next() {
          guideCalls += 1;
          throw new Error('a durable proposal must be recovered without another guide call');
        },
      },
      children: unusedChildren,
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop.reason).toBe('terminal');
    expect(guideCalls).toBe(0);
    expect(stop.state.terminal).toMatchObject({
      outcome: 'failed',
      reason: 'Recovered the already-metered durable proposal.',
    });
    expect(stop.state.guideTurns['restart-proposal']).toMatchObject({
      status: 'applied',
      usage: GUIDE_USAGE,
    });
    expect((await store.load(MISSION_ID)).actions.at(-1)?.action).toEqual({
      type: 'apply-guide-proposal',
      turnId: 'restart-proposal',
    });
  });

  it('fails closed on unknown spend when containment proves a recovered guide process died', async () => {
    const store = new MemoryMissionStore();
    const kernel = await createMission(store);
    await dispatch(kernel, 'begin-lost-guide', {
      type: 'begin-guide-turn',
      guideEpoch: 0,
      turnId: 'lost-guide',
    });
    let guideCalls = 0;

    const stop = await new MissionHarness({
      store,
      guide: {
        async next() {
          guideCalls += 1;
          throw new Error('a lost durable guide turn must be reconciled before another launch');
        },
      },
      guideOwnerDeathProof: { ownerDeathTerminatesProcessTree: true },
      children: unusedChildren,
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop.reason).toBe('terminal');
    expect(stop.state.status).toBe('failed');
    expect(guideCalls).toBe(0);
    expect(stop.state.guideTurns['lost-guide']).toMatchObject({
      status: 'lost',
      usage: { tokens: null, usd: null, activeSeconds: null },
    });
    expect(Object.values(stop.state.budgetConstraints)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'guide', axis: 'tokens', reason: 'unknown' }),
        expect.objectContaining({ scope: 'mission', axis: 'tokens', reason: 'unknown' }),
        expect.objectContaining({ scope: 'guide', axis: 'activeSeconds', reason: 'unknown' }),
        expect.objectContaining({ scope: 'mission', axis: 'activeSeconds', reason: 'unknown' }),
      ]),
    );
  });

  it('does not classify or relaunch an unattached guide turn without owner-death proof', async () => {
    const store = new MemoryMissionStore();
    const kernel = await createMission(store);
    await dispatch(kernel, 'begin-unclassified-guide', {
      type: 'begin-guide-turn',
      guideEpoch: 0,
      turnId: 'unclassified-guide',
    });
    let guideCalls = 0;

    const stop = await new MissionHarness({
      store,
      guide: {
        async next() {
          guideCalls += 1;
          throw new Error('an unclassified durable guide turn must not be relaunched');
        },
      },
      children: unusedChildren,
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop).toMatchObject({
      reason: 'runtime-error',
      error: expect.stringContaining('owner-death process-tree proof'),
      state: {
        status: 'active',
        guideTurns: { 'unclassified-guide': { status: 'running' } },
      },
    });
    expect(guideCalls).toBe(0);
  });

  it('does not replace a timed-out guide until cancellation is acknowledged', async () => {
    const store = new MemoryMissionStore();
    await createMission(store, { guideActiveSeconds: 0.005 });
    let guideCalls = 0;
    let observedAbort = false;

    const stop = await new MissionHarness({
      store,
      guide: {
        next(request) {
          guideCalls += 1;
          request.signal.addEventListener('abort', () => {
            observedAbort = true;
          });
          return new Promise<MissionGuideResult>(() => {});
        },
      },
      children: unusedChildren,
      newTurnId: turnIds(),
      cancelGraceMs: 5,
    }).run(MISSION_ID);

    expect(stop).toMatchObject({
      reason: 'runtime-error',
      error: expect.stringContaining('did not acknowledge cancellation'),
      state: { guideTurns: { 'turn-1': { status: 'running' } } },
    });
    expect(observedAbort).toBe(true);
    expect(guideCalls).toBe(1);
    expect((await store.load(MISSION_ID)).actions.map((entry) => entry.action.type)).not.toContain(
      'replace-guide',
    );
  });

  it('reports a runtime error when terminal cleanup is durable but no executor exists', async () => {
    const store = new MemoryMissionStore();
    const kernel = await createMission(store, { cleanup: ['workspace', 'lease'] });
    await dispatch(kernel, 'terminal-before-cleanup', {
      type: 'complete-mission',
      guideEpoch: 0,
      outcome: 'failed',
      reason: 'Stopped before implementation.',
    });

    const stop = await new MissionHarness({
      store,
      guide: {
        async next() {
          throw new Error('terminal cleanup reconciliation must not invoke a guide');
        },
      },
      children: unusedChildren,
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop).toMatchObject({
      reason: 'runtime-error',
      error: 'cleanup executor is unavailable for durable obligations: workspace, lease',
      state: { status: 'failed', terminal: { outcome: 'failed' } },
    });
    expect(stop.state.cleanup).toMatchObject({
      workspace: { status: 'pending' },
      lease: { status: 'pending' },
    });
  });

  it('finalizes a terminal mission lost guide turn before continuing cleanup after owner death', async () => {
    const store = new MemoryMissionStore();
    const kernel = await createMission(store, { cleanup: ['workspace'] });
    await dispatch(kernel, 'begin-terminal-lost-guide', {
      type: 'begin-guide-turn',
      guideEpoch: 0,
      turnId: 'terminal-lost-guide',
    });
    await dispatch(kernel, 'terminal-with-running-guide', {
      type: 'complete-mission',
      guideEpoch: 0,
      outcome: 'failed',
      reason: 'Operator terminalized the mission while its guide was active.',
    });
    let guideCalls = 0;
    const cleanupCalls: string[] = [];

    const stop = await new MissionHarness({
      store,
      guide: {
        async next() {
          guideCalls += 1;
          throw new Error('a terminal lost guide turn must not be relaunched');
        },
      },
      guideOwnerDeathProof: { ownerDeathTerminatesProcessTree: true },
      children: unusedChildren,
      cleanup: {
        async execute(_state, cleanupId) {
          cleanupCalls.push(cleanupId);
        },
      },
      newTurnId: turnIds(),
    }).run(MISSION_ID);

    expect(stop).toMatchObject({
      reason: 'terminal',
      state: {
        status: 'failed',
        guideTurns: {
          'terminal-lost-guide': {
            status: 'lost',
            usage: { tokens: null, usd: null, activeSeconds: null },
          },
        },
        cleanup: { workspace: { status: 'completed' } },
      },
    });
    expect(guideCalls).toBe(0);
    expect(cleanupCalls).toEqual(['workspace']);
  });

  it('retries failed durable cleanup on the next reconciliation', async () => {
    const store = new MemoryMissionStore();
    const kernel = await createMission(store, { cleanup: ['workspace'] });
    await dispatch(kernel, 'terminal-before-cleanup-retry', {
      type: 'complete-mission',
      guideEpoch: 0,
      outcome: 'failed',
      reason: 'Stopped before implementation.',
    });
    let attempts = 0;
    const harness = new MissionHarness({
      store,
      guide: {
        async next() {
          throw new Error('terminal mission must not invoke a guide');
        },
      },
      children: unusedChildren,
      cleanup: {
        async execute() {
          attempts += 1;
          if (attempts === 1) throw new Error('workspace is still busy');
        },
      },
      evidence: reconcileTerminalWriteEvidence,
      newTurnId: turnIds(),
    });

    const first = await harness.run(MISSION_ID);
    expect(first).toMatchObject({
      reason: 'runtime-error',
      error: 'durable cleanup obligations remain incomplete: workspace',
      state: { cleanup: { workspace: { status: 'failed' } } },
    });

    const second = await harness.run(MISSION_ID);
    expect(second).toMatchObject({
      reason: 'terminal',
      state: { cleanup: { workspace: { status: 'completed' } } },
    });
    expect(attempts).toBe(2);
  });

  it('holds the controller lease until an in-flight cleanup operation settles', async () => {
    const store = new MemoryMissionStore();
    const kernel = await createMission(store, { cleanup: ['workspace'] });
    await dispatch(kernel, 'terminal-before-long-cleanup', {
      type: 'complete-mission',
      guideEpoch: 0,
      outcome: 'failed',
      reason: 'Stopped before cleanup.',
    });
    let entered!: () => void;
    const cleanupEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const cleanupRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    let attempts = 0;
    const cleanup = {
      async execute() {
        attempts += 1;
        entered();
        await cleanupRelease;
      },
    };
    const first = new MissionHarness({
      store,
      guide: {
        async next() {
          throw new Error('terminal mission must not invoke a guide');
        },
      },
      children: unusedChildren,
      cleanup,
      newTurnId: turnIds(),
      cancelGraceMs: 1,
    });
    const second = new MissionHarness({
      store,
      guide: {
        async next() {
          throw new Error('terminal mission must not invoke a guide');
        },
      },
      children: unusedChildren,
      cleanup,
      newTurnId: turnIds(),
    });

    const running = first.run(MISSION_ID);
    await cleanupEntered;
    await expect(second.run(MISSION_ID)).rejects.toMatchObject({ name: 'MissionControllerBusyError' });
    expect(attempts).toBe(1);
    release();
    await expect(running).resolves.toMatchObject({
      reason: 'terminal',
      state: { cleanup: { workspace: { status: 'completed' } } },
    });
  });

  it('cancels an actively controlled child without starting a competing local controller', async () => {
    const store = new MemoryMissionStore();
    await createMission(store);
    const script = scriptedGuide((request) => ({
      output: envelope(request, 'dispatch-live-child', {
        type: 'dispatch_child',
        childId: 'live-builder',
        profileId: 'builder',
        instruction: 'Implement until the operator cancels.',
      }),
      usage: GUIDE_USAGE,
    }));
    let ready!: () => void;
    const childReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let settle!: (result: MissionChildResult) => void;
    const childDone = new Promise<MissionChildResult>((resolve) => {
      settle = resolve;
    });
    const cancellations: string[] = [];
    const harness = new MissionHarness({
      store,
      guide: script.guide,
      children: {
        async startOrAttach(request) {
          return {
            attemptId: request.attemptId,
            async cancel(reason) {
              if (cancellations.length > 0) return;
              cancellations.push(reason);
              settle({ outcome: 'cancelled', summary: 'Operator cancelled.', usage: CHILD_USAGE });
            },
            done() {
              ready();
              return childDone;
            },
          };
        },
      },
      evidence: reconcileTerminalWriteEvidence,
      newTurnId: turnIds(),
    });

    const running = harness.run(MISSION_ID);
    await childReady;
    const cancelled = await harness.cancelMission(MISSION_ID, 'Stop now.');

    await expect(running).resolves.toBe(cancelled);
    expect(cancelled).toMatchObject({ reason: 'terminal', state: { status: 'cancelled' } });
    expect(cancellations).toEqual(['mission cancelled: Stop now.']);
  });

  it('quiesces an active child process without terminalizing its durable mission', async () => {
    const store = new MemoryMissionStore();
    await createMission(store);
    const script = scriptedGuide((request) => ({
      output: envelope(request, 'dispatch-quiesced-child', {
        type: 'dispatch_child',
        childId: 'quiesced-builder',
        profileId: 'builder',
        instruction: 'Implement until this Runner shuts down.',
      }),
      usage: GUIDE_USAGE,
    }));
    let ready!: () => void;
    const childReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let settle!: (result: MissionChildResult) => void;
    const childDone = new Promise<MissionChildResult>((resolve) => {
      settle = resolve;
    });
    const cancellations: string[] = [];
    const harness = new MissionHarness({
      store,
      guide: script.guide,
      children: {
        async startOrAttach(request) {
          return {
            attemptId: request.attemptId,
            async cancel(reason) {
              cancellations.push(reason);
              settle({ outcome: 'cancelled', summary: 'Runner process quiesced.', usage: CHILD_USAGE });
            },
            done() {
              ready();
              return childDone;
            },
          };
        },
      },
      evidence: reconcileTerminalWriteEvidence,
      newTurnId: turnIds(),
    });

    const running = harness.run(MISSION_ID);
    await childReady;
    await harness.quiesce('test shutdown');

    await expect(running).resolves.toMatchObject({
      reason: 'runtime-error',
      error: expect.stringContaining('mission control quiesced'),
      state: { status: 'active', terminal: null },
    });
    expect(cancellations).toEqual(['test shutdown']);
    await expect(harness.run(MISSION_ID)).rejects.toThrow(/harness is quiescing/);
    expect((await harness.load(MISSION_ID)).terminal).toBeNull();
  });

  it('does not complete quiescence at guide abort acknowledgement before guide settlement', async () => {
    const store = new MemoryMissionStore();
    await createMission(store);
    let entered!: () => void;
    const guideEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let settleGuide!: (result: MissionGuideResult) => void;
    const guideSettlement = new Promise<MissionGuideResult>((resolve) => {
      settleGuide = resolve;
    });
    const harness = new MissionHarness({
      store,
      guide: {
        next(request) {
          entered();
          expect(request.signal.aborted).toBe(false);
          return guideSettlement;
        },
      },
      children: unusedChildren,
      newTurnId: turnIds(),
      cancelGraceMs: 5,
    });

    const running = harness.run(MISSION_ID);
    await guideEntered;
    const stopping = harness.quiesce('test shutdown');
    const early = await Promise.race([
      stopping.then(() => 'stopped' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 20)),
    ]);
    expect(early).toBe('pending');

    settleGuide({ output: '', usage: GUIDE_USAGE });
    await stopping;
    await expect(running).resolves.toMatchObject({
      reason: 'runtime-error',
      error: expect.stringContaining('did not acknowledge cancellation'),
    });
  });

  it('does not complete quiescence at child cancel acknowledgement before done settlement', async () => {
    const store = new MemoryMissionStore();
    await createMission(store);
    const script = scriptedGuide((request) => ({
      output: envelope(request, 'dispatch-slow-cancel-child', {
        type: 'dispatch_child',
        childId: 'slow-cancel-builder',
        profileId: 'builder',
        instruction: 'Remain active until process-tree settlement is proved.',
      }),
      usage: GUIDE_USAGE,
    }));
    let childReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      childReady = resolve;
    });
    let settleChild!: (result: MissionChildResult) => void;
    const childSettlement = new Promise<MissionChildResult>((resolve) => {
      settleChild = resolve;
    });
    const cancellations: string[] = [];
    const harness = new MissionHarness({
      store,
      guide: script.guide,
      children: {
        async startOrAttach(request) {
          return {
            attemptId: request.attemptId,
            async cancel(reason) {
              cancellations.push(reason);
            },
            done() {
              childReady();
              return childSettlement;
            },
          };
        },
      },
      evidence: reconcileTerminalWriteEvidence,
      newTurnId: turnIds(),
      cancelGraceMs: 5,
    });

    const running = harness.run(MISSION_ID);
    await ready;
    const stopping = harness.quiesce('test shutdown');
    const early = await Promise.race([
      stopping.then(() => 'stopped' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 20)),
    ]);
    expect(early).toBe('pending');
    expect(cancellations).toEqual(['test shutdown']);

    settleChild({ outcome: 'cancelled', summary: 'process tree settled', usage: CHILD_USAGE });
    await stopping;
    await expect(running).resolves.toMatchObject({
      reason: 'runtime-error',
      error: expect.stringContaining('mission control quiesced'),
    });
  });

  it('admits only one controller across harness instances', async () => {
    const store = new MemoryMissionStore();
    await createMission(store);
    let entered!: () => void;
    const guideEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const guideRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = new MissionHarness({
      store,
      guide: {
        async next(request) {
          entered();
          await guideRelease;
          return {
            output: envelope(request, 'finish-first-controller', {
              type: 'propose_completion',
              outcome: 'failed',
              reason: 'Controller lease test complete.',
            }),
            usage: GUIDE_USAGE,
          };
        },
      },
      children: unusedChildren,
      newTurnId: turnIds(),
    });
    const second = new MissionHarness({
      store,
      guide: {
        async next() {
          throw new Error('second controller must not invoke a guide');
        },
      },
      children: unusedChildren,
      newTurnId: turnIds(),
    });

    const controlling = first.run(MISSION_ID);
    await guideEntered;
    await expect(second.run(MISSION_ID)).rejects.toMatchObject({ name: 'MissionControllerBusyError' });
    release();
    await expect(controlling).resolves.toMatchObject({ reason: 'terminal', state: { status: 'failed' } });
  });
});
