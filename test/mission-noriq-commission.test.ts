import { createHash } from 'node:crypto';
import { Run } from '@noriq-dev/shared';
import type { MissionRootCommission } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import type { MissionExecutionProfileMatch } from '../src/mission/execution-profile-registry';
import type { LocalMissionRuntime } from '../src/mission/local-runtime';
import { noriqMissionCommissionFromAssignment } from '../src/mission/noriq-commission';

const LEASE = { sitting: 2, executionId: 'exe_root', epoch: 1 };
const PROFILE = {
  id: 'project-default',
  declarationFingerprint: `sha256:${'a'.repeat(64)}`,
  effectiveFingerprint: `sha256:${'b'.repeat(64)}`,
  generation: 4,
  attestationCapable: true as const,
};

function run() {
  return Run.parse({
    id: 'run_root',
    projectId: 'prj_1',
    runnerId: 'rnr_1',
    agentId: null,
    execution: null,
    kind: 'build',
    anchor: { type: 'plan', planId: 'plan_1' },
    verifiesRunId: null,
    planKey: 'PLN-1',
    targetBranch: null,
    brief: '',
    repoRef: 'repo_1',
    agentTool: 'codex',
    agent: null,
    workflow: 'mission.v2',
    executionProfile: PROFILE,
    missionMode: null,
    model: null,
    effort: null,
    budget: { maxTokens: 800, maxUsd: 2, maxDurationSeconds: 80, maxRounds: null },
    status: 'dispatched',
    phase: null,
    exit: null,
    worktreePath: null,
    tokensUsed: 0,
    usdSpent: 0,
    modelUsage: null,
    createdBy: 'usr_1',
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
    dispatchedAt: '2026-08-13T00:00:00.000Z',
    startedAt: null,
  });
}

function profile(): MissionExecutionProfileMatch<LocalMissionRuntime> {
  return {
    declaration: {
      schemaVersion: 1,
      id: PROFILE.id,
      generation: PROFILE.generation,
      maxConcurrency: 2,
      missionBudget: { tokens: 1_000, usd: 5, activeSeconds: 100 },
      externalResourceCapacities: {},
      catalog: {},
    },
    declarationFingerprint: PROFILE.declarationFingerprint,
    effectiveFingerprint: PROFILE.effectiveFingerprint,
    runtime: {
      catalog: { fingerprint: 'c'.repeat(64) },
      resources: { 'external:ue-editor': 1 },
    } as unknown as LocalMissionRuntime,
  };
}

function signed(snapshot: MissionRootCommission['snapshot']): MissionRootCommission {
  return {
    digest: createHash('sha256').update(JSON.stringify(snapshot), 'utf8').digest('hex'),
    snapshot,
  } as MissionRootCommission;
}

describe('noriqMissionCommissionFromAssignment', () => {
  it('binds the server snapshot, local Git base, profile runtime, budget, and topological task order', () => {
    const baseTask = {
      body: 'Implement exactly the commissioned behavior.',
      priority: 2,
      type: 'feature',
      estimate: 3,
      dueAt: null,
      workflow: null,
      executionSpec: null,
      phaseId: 'phase_1',
      phaseTitle: 'Build',
      phaseOrder: 0,
      taskOrder: 0,
    };
    const snapshot = {
      schemaVersion: 1 as const,
      commissionId: 'mco_1',
      runId: 'run_root',
      sitting: 2,
      planId: 'plan_1',
      planTitle: 'Plan title',
      planBody: 'Shared plan authority.',
      planRevision: 'plan-revision',
      commissionedAt: '2026-08-13T00:00:00.000Z',
      tasks: [
        { ...baseTask, taskId: 'task_b', key: 'PLN-2', title: 'Second', taskOrder: 1 },
        { ...baseTask, taskId: 'task_a', key: 'PLN-1', title: 'First', taskOrder: 0 },
      ],
      dependencies: [{ taskId: 'task_b', dependsOnTaskId: 'task_a' }],
    };
    const serverCommission = signed(snapshot);
    const commission = noriqMissionCommissionFromAssignment({
      run: run(),
      lease: LEASE,
      serverCommission,
      repositoryKey: 'repo-key',
      baseRevision: '1'.repeat(40),
      profile: profile(),
    });

    expect(commission.serverCommissionDigest).toBe(serverCommission.digest);
    expect(commission.publishHandoff).toBe(true);
    expect(commission.baseRevision).toBe('1'.repeat(40));
    expect(commission.tasks.map((task) => task.taskId)).toEqual(['task_a', 'task_b']);
    expect(commission.tasks[1]?.dependencyIds).toEqual(['task_a']);
    expect(commission.budget).toEqual({ tokens: 800, usd: 2, activeSeconds: 80 });
    expect(commission.catalogFingerprint).toBe('c'.repeat(64));
    expect(commission.resources).toEqual({ 'external:ue-editor': 1 });
  });

  it('keeps explicit task roots off the plan-only handoff channel and rejects digest tampering', () => {
    const snapshot = {
      schemaVersion: 1 as const,
      commissionId: 'mco_2',
      runId: 'run_root',
      sitting: 2,
      taskId: 'task_a',
      commissionedAt: '2026-08-13T00:00:00.000Z',
      task: {
        taskId: 'task_a',
        key: 'PLN-1',
        title: 'One task',
        body: 'Do it.',
        priority: 1,
        type: 'feature',
        estimate: null,
        dueAt: null,
        workflow: null,
        executionSpec: null,
      },
    };
    const serverCommission = signed(snapshot);
    const input = {
      run: run(),
      lease: LEASE,
      serverCommission,
      repositoryKey: 'repo-key',
      baseRevision: '2'.repeat(40),
      profile: profile(),
    };
    expect(noriqMissionCommissionFromAssignment(input).publishHandoff).toBe(false);
    expect(() =>
      noriqMissionCommissionFromAssignment({
        ...input,
        serverCommission: { ...serverCommission, digest: '0'.repeat(64) },
      }),
    ).toThrow(/digest does not match/);
  });
});
