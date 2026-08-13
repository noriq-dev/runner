import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GlobalMissionResourceCoordinator } from '../src/mission/global-resource-coordinator';
import { type MissionChildState, type MissionState, initialMissionState } from '../src/mission/model';

const temporary: string[] = [];

async function directory(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'noriq-resources-'));
  temporary.push(value);
  return value;
}

function child(
  id: string,
  attemptId: string,
  resources: Readonly<Record<string, number>> = { 'external:editor-session': 1 },
): MissionChildState {
  return {
    childId: id,
    role: 'worker',
    instruction: 'work',
    permission: 'write',
    agent: { driver: 'codex', model: 'build-model' },
    driverPosture: {
      kind: 'build',
      permission: { write: true, allow: [], deny: [], auto: false },
      lineageRole: 'worker',
    },
    profileId: 'builder',
    budget: { tokens: 100, usd: null, activeSeconds: 30 },
    resources,
    projectMcp: [],
    subjectCheckpointId: null,
    planStepId: null,
    status: 'running',
    attemptId,
    sessionId: null,
    usage: { tokens: 0, usd: 0, activeSeconds: 0 },
    summary: null,
    artifact: null,
    cancelReason: null,
  };
}

function state(id: string, repositoryKey = 'project-nod'): MissionState {
  return {
    ...initialMissionState(id),
    status: 'active',
    objective: { brief: 'Work safely.', repositoryKey },
    guide: {
      profileId: 'guide',
      agent: { driver: 'claude', model: 'guide-model' },
      budget: { tokens: 100, usd: null, activeSeconds: 30 },
      turnLimit: 3,
    },
  };
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

describe('GlobalMissionResourceCoordinator', () => {
  it('fences one opaque project resource across processes/missions until explicit release', async () => {
    const root = await directory();
    const first = new GlobalMissionResourceCoordinator({
      directory: root,
      capacities: { 'external:editor-session': 1 },
    });
    const second = new GlobalMissionResourceCoordinator({
      directory: root,
      capacities: { 'external:editor-session': 1 },
    });
    const stateA = state('mission-a');
    const stateB = state('mission-b');
    const childA = child('child-a', 'attempt-a');
    const childB = child('child-b', 'attempt-b');

    await first.acquire(stateA, childA, 'attempt-a');
    await first.acquire(stateA, childA, 'attempt-a');
    await expect(second.acquire(stateB, childB, 'attempt-b')).rejects.toThrow(
      /global resource 'external:editor-session' is exhausted/,
    );

    await first.release(stateA, childA);
    await first.release(stateA, childA);
    await expect(second.acquire(stateB, childB, 'attempt-b')).resolves.toBeUndefined();
  });

  it('fences machine-global capacity across different repositories by default', async () => {
    const root = await directory();
    const coordinator = new GlobalMissionResourceCoordinator({
      directory: root,
      capacities: { 'external:editor-session': 1 },
    });

    await coordinator.acquire(state('mission-a', 'repo-a'), child('child-a', 'attempt-a'), 'attempt-a');
    await expect(
      coordinator.acquire(state('mission-b', 'repo-b'), child('child-b', 'attempt-b'), 'attempt-b'),
    ).rejects.toThrow(/exhausted in scope 'machine'/);
  });

  it('uses an explicit trusted scope policy when a resource pool is intentionally per-project', async () => {
    const root = await directory();
    const coordinator = new GlobalMissionResourceCoordinator({
      directory: root,
      capacities: { 'external:editor-session': 1 },
      scope: (mission) => mission.objective?.repositoryKey ?? 'missing',
      scopePolicyId: 'repository-v1',
    });

    await coordinator.acquire(state('mission-a', 'repo-a'), child('child-a', 'attempt-a'), 'attempt-a');
    await expect(
      coordinator.acquire(state('mission-b', 'repo-b'), child('child-b', 'attempt-b'), 'attempt-b'),
    ).resolves.toBeUndefined();
  });

  it('refuses an untrusted resource key absent from local capacity policy', async () => {
    const root = await directory();
    const coordinator = new GlobalMissionResourceCoordinator({
      directory: root,
      capacities: { 'external:editor-session': 1 },
    });
    await expect(
      coordinator.acquire(
        state('mission-a'),
        child('child-a', 'attempt-a', { 'external:untrusted-extra': 1 }),
        'attempt-a',
      ),
    ).rejects.toThrow(/trusted global resource 'external:untrusted-extra' has no capacity/);
  });

  it('requires an explicit stable identity for a custom scope policy', async () => {
    const root = await directory();
    expect(
      () =>
        new GlobalMissionResourceCoordinator({
          directory: root,
          capacities: { 'external:editor-session': 1 },
          scope: () => 'custom',
        }),
    ).toThrow(/requires a stable scopePolicyId/);
  });

  it('rejects a second Runner that interprets an existing ledger with different capacity', async () => {
    const root = await directory();
    const first = new GlobalMissionResourceCoordinator({
      directory: root,
      capacities: { 'external:editor-session': 1 },
    });
    await first.acquire(state('mission-a'), child('child-a', 'attempt-a'), 'attempt-a');

    const conflicting = new GlobalMissionResourceCoordinator({
      directory: root,
      capacities: { 'external:editor-session': 2 },
    });
    await expect(
      conflicting.acquire(state('mission-b'), child('child-b', 'attempt-b'), 'attempt-b'),
    ).rejects.toThrow(/ledger policy differs/);
  });
});
