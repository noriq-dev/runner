import { describe, expect, it, vi } from 'vitest';
import { MissionKernel } from '../src/mission/kernel';
import { MemoryMissionStore } from '../src/mission/memory-store';
import type { MissionAction, MissionBudget, MissionExecutionProfile } from '../src/mission/protocol';

const bounded: MissionBudget = { tokens: 100, usd: 10, activeSeconds: 100 };
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
  agent: { driver: 'claude', model: 'planning-model' },
  budget: { tokens: 5, usd: 0.5, activeSeconds: 5 },
  turnLimit: 20,
} as const;
const validationPolicy = {
  kind: 'none',
  policyId: 'test-none-v1',
  reason: 'No deterministic validation in this unit fixture.',
} as const;
const profiles: readonly MissionExecutionProfile[] = [
  ...[20, 40].map((tokens) => ({
    profileId: `builder-${tokens}`,
    role: 'builder',
    permission: 'write' as const,
    agent: { driver: 'codex', model: 'less-expensive-build-model' },
    assurance: { rank: 1, independenceClass: 'build' },
    driverPosture: buildPosture,
    budget: { tokens, usd: tokens / 10, activeSeconds: tokens },
    resources: { 'stateful-editor': 1 },
    projectMcp: [],
  })),
  ...[10, 60].map((tokens) => ({
    profileId: `reviewer-${tokens}`,
    role: 'reviewer',
    permission: 'read' as const,
    agent: { driver: 'claude', model: `review-model-${tokens}` },
    assurance: { rank: 2, independenceClass: 'independent-review' },
    driverPosture: reviewPosture,
    budget: { tokens, usd: tokens / 10, activeSeconds: tokens },
    resources: {},
    projectMcp: [],
  })),
  {
    profileId: 'reviewer-tail',
    role: 'reviewer',
    permission: 'read',
    agent: { driver: 'claude', model: 'review-model-tail' },
    assurance: { rank: 2, independenceClass: 'independent-review' },
    driverPosture: reviewPosture,
    budget: { tokens: 1, usd: 0, activeSeconds: 0 },
    resources: {},
    projectMcp: [],
  },
];

const send = (kernel: MissionKernel, expectedRevision: number, actionId: string, action: MissionAction) =>
  kernel.dispatch({
    missionId: 'mission-one',
    expectedRevision,
    actionId,
    action,
  });

const create = (kernel: MissionKernel, cleanup: readonly string[] = []) =>
  send(kernel, 0, 'create', {
    type: 'create-mission',
    projectMcpDeclarationFingerprint: null,
    objective: { brief: 'Implement and prove one bounded task.' },
    budget: bounded,
    resources: { 'stateful-editor': 1 },
    guide,
    profiles,
    validationPolicy,
    cleanup,
  });

const spawn = (
  kernel: MissionKernel,
  revision: number,
  actionId: string,
  childId: string,
  budget: MissionBudget,
) =>
  send(kernel, revision, actionId, {
    type: 'spawn-child',
    guideEpoch: revision - 1,
    childId,
    role: 'builder',
    instruction: 'Implement the accepted execution plan, then report bounded evidence.',
    permission: 'write',
    profileId: `builder-${budget.tokens}`,
    agent: { driver: 'codex', model: 'less-expensive-build-model' },
    driverPosture: buildPosture,
    budget,
    resources: { 'stateful-editor': 1 },
    projectMcp: [],
  });

describe('MissionKernel', () => {
  it('derives only authoritative journal suffixes and freezes cached state', async () => {
    const store = new MemoryMissionStore();
    const fullLoad = vi.spyOn(store, 'load');
    const loadSince = vi.spyOn(store, 'loadSince');
    const kernel = new MissionKernel(store);

    const created = await create(kernel);
    expect(created.accepted).toBe(true);
    if (!created.accepted) throw new Error('mission creation unexpectedly failed');
    expect(Object.isFrozen(created.state)).toBe(true);
    expect(Object.isFrozen(created.state.profiles)).toBe(true);

    await spawn(kernel, 1, 'spawn-one', 'builder-one', {
      tokens: 20,
      usd: 2,
      activeSeconds: 20,
    });
    await kernel.inspect('mission-one');

    expect(fullLoad).not.toHaveBeenCalled();
    expect(loadSince.mock.calls.map((call) => call[1])).toEqual([0, 1, 2]);
  });

  it('returns the original receipt before validating a stale retry against evolved state', async () => {
    const kernel = new MissionKernel(new MemoryMissionStore());
    const original = await create(kernel);
    expect(original.accepted).toBe(true);
    await spawn(kernel, 1, 'spawn-one', 'builder-one', { tokens: 40, usd: 4, activeSeconds: 40 });

    const retry = await create(kernel);
    expect(retry).toMatchObject({ accepted: true, replayed: true });
    if (original.accepted && retry.accepted) expect(retry.receipt).toEqual(original.receipt);
    expect(retry.state.revision).toBe(2);
  });

  it('reserves budget and opaque resources before spawn without double-counting observed usage', async () => {
    const kernel = new MissionKernel(new MemoryMissionStore());
    await create(kernel);
    await spawn(kernel, 1, 'spawn-one', 'builder-one', { tokens: 40, usd: 4, activeSeconds: 40 });
    await send(kernel, 2, 'started-one', {
      type: 'start-child',
      childId: 'builder-one',
      attemptId: 'attempt-one',
    });
    await send(kernel, 3, 'usage-one', {
      type: 'observe-child-usage',
      childId: 'builder-one',
      usage: { tokens: 10, usd: 1, activeSeconds: 10 },
    });

    // 10 spent + 30 remaining from child one + 60 reserved for child two = the exact ceiling.
    const second = await send(kernel, 4, 'spawn-two', {
      type: 'spawn-child',
      guideEpoch: 1,
      childId: 'reviewer-one',
      role: 'reviewer',
      instruction: 'Review independently.',
      permission: 'read',
      profileId: 'reviewer-60',
      agent: { driver: 'claude', model: 'review-model-60' },
      driverPosture: reviewPosture,
      budget: { tokens: 60, usd: 6, activeSeconds: 60 },
      resources: {},
      projectMcp: [],
    });
    expect(second).toMatchObject({ accepted: true });

    const third = await send(kernel, 5, 'spawn-three', {
      type: 'spawn-child',
      guideEpoch: 2,
      childId: 'extra',
      role: 'reviewer',
      instruction: 'This must not be admitted.',
      permission: 'read',
      profileId: 'reviewer-tail',
      agent: { driver: 'claude', model: 'review-model-tail' },
      driverPosture: reviewPosture,
      budget: { tokens: 1, usd: 0, activeSeconds: 0 },
      resources: {},
      projectMcp: [],
    });
    expect(third).toMatchObject({ accepted: false, code: 'budget-exhausted' });
  });

  it('rejects concurrent reservations for a generic single-capacity stateful tool', async () => {
    const kernel = new MissionKernel(new MemoryMissionStore());
    await create(kernel);
    await spawn(kernel, 1, 'spawn-one', 'builder-one', { tokens: 20, usd: 2, activeSeconds: 20 });
    const second = await send(kernel, 2, 'spawn-two', {
      type: 'spawn-child',
      guideEpoch: 1,
      childId: 'builder-two',
      role: 'builder',
      instruction: 'Conflicting editor work.',
      permission: 'write',
      profileId: 'builder-20',
      agent: { driver: 'codex', model: 'less-expensive-build-model' },
      driverPosture: buildPosture,
      budget: { tokens: 20, usd: 2, activeSeconds: 20 },
      resources: { 'stateful-editor': 1 },
      projectMcp: [],
    });
    expect(second).toMatchObject({ accepted: false, code: 'resource-exhausted' });
  });

  it('treats child usage as absolute high-water observations and preserves unknown USD', async () => {
    const kernel = new MissionKernel(new MemoryMissionStore());
    await create(kernel);
    await spawn(kernel, 1, 'spawn-one', 'builder-one', { tokens: 40, usd: 4, activeSeconds: 40 });
    await send(kernel, 2, 'started-one', {
      type: 'start-child',
      childId: 'builder-one',
      attemptId: 'attempt-one',
    });
    await send(kernel, 3, 'usage-one', {
      type: 'observe-child-usage',
      childId: 'builder-one',
      usage: { tokens: 10, usd: null, activeSeconds: 4 },
    });
    const decreased = await send(kernel, 4, 'usage-two', {
      type: 'observe-child-usage',
      childId: 'builder-one',
      usage: { tokens: 9, usd: null, activeSeconds: 4 },
    });
    expect(decreased).toMatchObject({ accepted: false, code: 'invalid-action' });
    expect((await kernel.inspect('mission-one')).usage).toEqual({ tokens: 10, usd: null, activeSeconds: 4 });
  });

  it('binds success to the latest clean checkpoint and a passing review of that exact checkpoint', async () => {
    const kernel = new MissionKernel(new MemoryMissionStore());
    await create(kernel);
    await send(kernel, 1, 'checkpoint-one', {
      type: 'record-checkpoint',
      checkpointId: 'rev-one',
      revisionId: 'git-sha-one',
      authorChildId: null,
      clean: true,
    });
    await send(kernel, 2, 'spawn-reviewer', {
      type: 'spawn-child',
      guideEpoch: 0,
      childId: 'reviewer-one',
      role: 'reviewer',
      instruction: 'Review the exact checkpoint independently.',
      permission: 'read',
      profileId: 'reviewer-10',
      agent: { driver: 'claude', model: 'review-model-10' },
      driverPosture: reviewPosture,
      budget: { tokens: 10, usd: 1, activeSeconds: 10 },
      resources: {},
      projectMcp: [],
      subjectCheckpointId: 'rev-one',
    });
    await send(kernel, 3, 'start-reviewer', {
      type: 'start-child',
      childId: 'reviewer-one',
      attemptId: 'review-attempt-one',
    });
    await send(kernel, 4, 'complete-reviewer', {
      type: 'complete-child',
      childId: 'reviewer-one',
      outcome: 'succeeded',
      summary: 'Independent review evidence is ready.',
      usage: { tokens: 5, usd: 0.5, activeSeconds: 5 },
      artifact: {
        type: 'review',
        checkpointId: 'rev-one',
        revisionId: 'git-sha-one',
        verdict: 'passed',
        highestSeverity: 'none',
        summary: 'All required gates pass.',
      },
    });
    await send(kernel, 5, 'review-one', {
      type: 'record-review',
      reviewId: 'review-one',
      reviewerChildId: 'reviewer-one',
      checkpointId: 'rev-one',
      revisionId: 'git-sha-one',
      verdict: 'passed',
      highestSeverity: 'none',
      summary: 'All required gates pass.',
    });
    await send(kernel, 6, 'checkpoint-two', {
      type: 'record-checkpoint',
      checkpointId: 'rev-two',
      revisionId: 'git-sha-two',
      authorChildId: null,
      parentCheckpointId: 'rev-one',
      clean: true,
    });

    const stale = await send(kernel, 7, 'complete-stale', {
      type: 'complete-mission',
      guideEpoch: 1,
      outcome: 'succeeded',
      reason: 'Reviewed an older revision.',
      checkpointId: 'rev-one',
    });
    expect(stale).toMatchObject({ accepted: false, code: 'completion-unproved' });

    await send(kernel, 7, 'spawn-reviewer-two', {
      type: 'spawn-child',
      guideEpoch: 1,
      childId: 'reviewer-two',
      role: 'reviewer',
      instruction: 'Review the new exact checkpoint independently.',
      permission: 'read',
      profileId: 'reviewer-10',
      agent: { driver: 'claude', model: 'review-model-10' },
      driverPosture: reviewPosture,
      budget: { tokens: 10, usd: 1, activeSeconds: 10 },
      resources: {},
      projectMcp: [],
      subjectCheckpointId: 'rev-two',
    });
    await send(kernel, 8, 'start-reviewer-two', {
      type: 'start-child',
      childId: 'reviewer-two',
      attemptId: 'review-attempt-two',
    });
    await send(kernel, 9, 'complete-reviewer-two', {
      type: 'complete-child',
      childId: 'reviewer-two',
      outcome: 'succeeded',
      summary: 'Independent review of the latest checkpoint is ready.',
      usage: { tokens: 5, usd: 0.5, activeSeconds: 5 },
      artifact: {
        type: 'review',
        checkpointId: 'rev-two',
        revisionId: 'git-sha-two',
        verdict: 'passed',
        highestSeverity: 'none',
        summary: 'The latest checkpoint passes.',
      },
    });
    await send(kernel, 10, 'review-two', {
      type: 'record-review',
      reviewId: 'review-two',
      reviewerChildId: 'reviewer-two',
      checkpointId: 'rev-two',
      revisionId: 'git-sha-two',
      verdict: 'passed',
      highestSeverity: 'none',
      summary: 'The latest checkpoint passes.',
    });
    await send(kernel, 11, 'validate-latest', {
      type: 'record-validation',
      validationId: 'validation-two',
      checkpointId: 'rev-two',
      revisionId: 'git-sha-two',
      policyId: validationPolicy.policyId,
      disposition: 'not-applicable',
      exitCode: null,
      timedOut: false,
      workspaceChanged: false,
      outputTail: '',
    });
    const completed = await send(kernel, 12, 'complete-latest', {
      type: 'complete-mission',
      guideEpoch: 2,
      outcome: 'succeeded',
      reason: 'Latest checkpoint reviewed and clean.',
    });
    expect(completed).toMatchObject({ accepted: true, state: { terminal: { checkpointId: 'rev-two' } } });
  });

  it('terminalizes atomically with cleanup obligations and never lets cleanup rewrite outcome', async () => {
    const kernel = new MissionKernel(new MemoryMissionStore());
    await create(kernel, ['release-workspace', 'release-resource']);
    const completed = await send(kernel, 1, 'fail', {
      type: 'complete-mission',
      guideEpoch: 0,
      outcome: 'failed',
      reason: 'No viable implementation remained.',
    });
    expect(completed).toMatchObject({
      accepted: true,
      receipt: { eventCount: 3 },
      state: {
        status: 'failed',
        cleanup: {
          'release-workspace': { status: 'pending' },
          'release-resource': { status: 'pending' },
        },
      },
    });

    const cleanup = await send(kernel, 2, 'cleanup-failed', {
      type: 'fail-cleanup',
      cleanupId: 'release-workspace',
      error: 'filesystem busy',
    });
    expect(cleanup).toMatchObject({ accepted: true, state: { status: 'failed' } });
    expect(cleanup.state.terminal).toEqual({
      outcome: 'failed',
      reason: 'No viable implementation remained.',
      checkpointId: null,
    });
  });

  it('can logically cancel while a child exits late without changing the terminal outcome', async () => {
    const kernel = new MissionKernel(new MemoryMissionStore());
    await create(kernel);
    await spawn(kernel, 1, 'spawn-one', 'builder-one', { tokens: 20, usd: 2, activeSeconds: 20 });
    await send(kernel, 2, 'started-one', {
      type: 'start-child',
      childId: 'builder-one',
      attemptId: 'attempt-one',
    });
    await send(kernel, 3, 'cancel', {
      type: 'complete-mission',
      guideEpoch: 1,
      outcome: 'cancelled',
      reason: 'Human cancelled the mission.',
    });
    const late = await send(kernel, 4, 'late-exit', {
      type: 'complete-child',
      childId: 'builder-one',
      outcome: 'cancelled',
      summary: 'Interrupted after mission cancellation.',
      usage: { tokens: 3, usd: null, activeSeconds: 2 },
    });
    expect(late).toMatchObject({ accepted: true, state: { status: 'cancelled' } });
  });
});
