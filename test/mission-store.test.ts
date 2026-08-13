import { describe, expect, it } from 'vitest';
import { MissionKernel } from '../src/mission/kernel';
import { MemoryMissionStore } from '../src/mission/memory-store';
import type { MissionAction, MissionActionEnvelope, MissionEvent } from '../src/mission/protocol';
import {
  InvalidMissionCommitError,
  type MissionStore,
  MissionStoreConflictError,
  canonicalMissionJson,
  missionActionFingerprint,
} from '../src/mission/store';

const guide = {
  profileId: 'guide',
  agent: { driver: 'test-guide', model: 'guide-model' },
  budget: { tokens: 10, usd: 1, activeSeconds: 10 },
  turnLimit: 20,
} as const;
const profiles = [
  {
    profileId: 'worker',
    role: 'worker',
    permission: 'read',
    agent: { driver: 'test-worker', model: 'worker-model' },
    assurance: { rank: 1, independenceClass: 'test-review' },
    driverPosture: {
      kind: 'verify',
      permission: { write: false, allow: [], deny: [], auto: false },
      lineageRole: 'reviewer',
    },
    budget: { tokens: 10, usd: 1, activeSeconds: 10 },
    resources: {},
    projectMcp: [],
  },
] as const;
const validationPolicy = {
  kind: 'none',
  policyId: 'test-none-v1',
  reason: 'No deterministic validation in this unit fixture.',
} as const;
const units = (value: string): number => [...value].reduce((total, char) => total + char.charCodeAt(0), 0);
const action = (value: string): MissionAction => ({
  type: 'create-mission',
  projectMcpDeclarationFingerprint: null,
  budget: { tokens: units(value), usd: null, activeSeconds: null },
  resources: {},
  guide,
  profiles,
  validationPolicy,
});
const event = (value: string): MissionEvent => ({
  type: 'mission-created',
  projectMcpDeclarationFingerprint: null,
  budget: { tokens: units(value), usd: null, activeSeconds: null },
  resources: {},
  guide,
  profiles,
  validationPolicy,
});

const envelope = (expectedRevision: number, actionId: string, value: string): MissionActionEnvelope => ({
  missionId: 'mission-one',
  expectedRevision,
  actionId,
  action: action(value),
});

const commit = (
  store: MissionStore,
  expectedRevision: number,
  actionId: string,
  actionValue: string,
  eventValue: string = actionValue,
) => store.commit(envelope(expectedRevision, actionId, actionValue), [event(eventValue)]);

function exerciseStore(name: string, create: () => MissionStore): void {
  describe(name, () => {
    it('commits every event in one action at one revision with ordered ordinals', async () => {
      const store = create();
      const receipt = await store.commit(envelope(0, 'action-one', 'first'), [
        event('first'),
        event('also first'),
      ]);

      expect(receipt).toMatchObject({ previousRevision: 0, revision: 1, eventCount: 2 });
      const history = await store.load('mission-one');
      expect(history.revision).toBe(1);
      expect(history.events.map(({ revision, ordinal }) => ({ revision, ordinal }))).toEqual([
        { revision: 1, ordinal: 0 },
        { revision: 1, ordinal: 1 },
      ]);
    });

    it('checks idempotency before a now-stale expected revision and returns the original receipt', async () => {
      const store = create();
      const original = await commit(store, 0, 'action-one', 'first');
      await commit(store, 1, 'action-two', 'second');

      // Events are the action's result, not its identity. A retry is recognized by the canonical
      // action and returns before considering a freshly recomputed result batch.
      const retried = await commit(store, 0, 'action-one', 'first', 'ignored retry output');
      expect(retried).toEqual(original);
      expect((await store.load('mission-one')).revision).toBe(2);
    });

    it('returns an idempotent receipt before rejecting a future expected revision', async () => {
      const store = create();
      const original = await commit(store, 0, 'action-one', 'first');
      const futureRetry = {
        ...envelope(999, 'action-one', 'first'),
      };

      await expect(store.commit(futureRetry, [event('ignored')])).resolves.toEqual(original);
    });

    it('rejects reuse of an action id with a changed action fingerprint before checking revision', async () => {
      const store = create();
      await commit(store, 0, 'action-one', 'first');
      await commit(store, 1, 'action-two', 'second');

      await expect(commit(store, 0, 'action-one', 'changed')).rejects.toMatchObject({
        name: 'MissionStoreConflictError',
        kind: 'action',
      });
    });

    it('admits exactly one concurrent writer for an expected revision', async () => {
      const store = create();
      const outcomes = await Promise.allSettled([
        commit(store, 0, 'action-one', 'first'),
        commit(store, 0, 'action-two', 'second'),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
      expect(rejected).toMatchObject({ reason: { name: 'MissionStoreConflictError', kind: 'revision' } });
      expect((await store.load('mission-one')).revision).toBe(1);
    });

    it('returns detached histories and receipts', async () => {
      const store = create();
      const receipt = await commit(store, 0, 'action-one', 'first');
      (receipt as { actionId: string }).actionId = 'caller mutation';
      const history = await store.load('mission-one');
      (history.actions[0]!.action as { budget: { tokens: number | null } }).budget.tokens = 999_999;

      expect((await store.load('mission-one')).actions[0]!.action).toMatchObject({
        budget: { tokens: units('first') },
      });
    });

    it('returns only the requested authoritative suffix', async () => {
      const store = create();
      await commit(store, 0, 'action-one', 'first');
      await commit(store, 1, 'action-two', 'second');

      const delta = await store.loadSince('mission-one', 1);
      expect(delta).toMatchObject({ previousRevision: 1, revision: 2 });
      expect(delta.actions.map((entry) => entry.receipt.actionId)).toEqual(['action-two']);
      expect(delta.events).toHaveLength(1);
    });

    it('enumerates each durable in-memory mission as a healthy candidate', async () => {
      const store = create();
      await commit(store, 0, 'action-one', 'first');

      expect(await store.listMissionEntries()).toEqual([{ missionId: 'mission-one' }]);
      expect(await store.listMissionIds()).toEqual(['mission-one']);
    });

    it('admits only one live controller and releases it idempotently', async () => {
      const store = create();
      const lease = await store.acquireController('mission-one');
      await expect(store.acquireController('mission-one')).rejects.toMatchObject({
        name: 'MissionControllerBusyError',
      });

      await lease.release();
      await lease.release();
      const successor = await store.acquireController('mission-one');
      await successor.release();
    });
  });
}

exerciseStore(
  'MemoryMissionStore',
  () => new MemoryMissionStore({ now: () => new Date('2026-08-12T12:00:00.000Z') }),
);

describe('MemoryMissionStore terminal reserve', () => {
  const dispatchAccepted = async (
    kernel: MissionKernel,
    missionId: string,
    actionId: string,
    missionAction: MissionAction,
  ) => {
    const state = await kernel.inspect(missionId);
    const result = await kernel.dispatch({
      missionId,
      expectedRevision: state.revision,
      actionId,
      action: missionAction,
    });
    if (!result.accepted) throw new Error(`${missionAction.type} was refused: ${result.reason}`);
    return result.state;
  };

  const createLifecycleMission = (
    kernel: MissionKernel,
    missionId: string,
    cleanup: readonly string[] = [],
  ) =>
    dispatchAccepted(kernel, missionId, 'create', {
      type: 'create-mission',
      projectMcpDeclarationFingerprint: null,
      budget: { tokens: 100, usd: null, activeSeconds: 100 },
      resources: {},
      guide,
      profiles,
      validationPolicy,
      ...(cleanup.length > 0 ? { cleanup } : {}),
    });

  it('preserves start, completion, and review evidence for an authorized reviewer at the exact boundary', async () => {
    const store = new MemoryMissionStore({ maxJournalActions: 8, emergencyReserveActions: 5 });
    const kernel = new MissionKernel(store);
    const missionId = 'review-settlement';
    const profile = profiles[0];
    await createLifecycleMission(kernel, missionId);
    let state = await dispatchAccepted(kernel, missionId, 'subject', {
      type: 'record-checkpoint',
      checkpointId: 'subject',
      revisionId: 'subject-revision',
      authorChildId: null,
      clean: true,
    });
    state = await dispatchAccepted(kernel, missionId, 'reserve-reviewer', {
      type: 'spawn-child',
      guideEpoch: state.guideEpoch,
      childId: 'reviewer',
      role: profile.role,
      instruction: 'Review the exact subject.',
      permission: profile.permission,
      agent: profile.agent,
      driverPosture: profile.driverPosture,
      profileId: profile.profileId,
      budget: profile.budget,
      resources: profile.resources,
      projectMcp: profile.projectMcp,
      subjectCheckpointId: 'subject',
    });

    // Ordinary admission is exhausted at revision three. These are settlements of the child that
    // was already authorized, and together consume exactly the remaining lifecycle capacity.
    await expect(
      kernel.dispatch({
        missionId,
        expectedRevision: state.revision,
        actionId: 'ordinary-work-is-blocked',
        action: { type: 'begin-guide-turn', guideEpoch: state.guideEpoch, turnId: 'too-late' },
      }),
    ).rejects.toMatchObject({ name: 'MissionJournalLimitError', dimension: 'actions' });

    state = await dispatchAccepted(kernel, missionId, 'start-reviewer', {
      type: 'start-child',
      childId: 'reviewer',
      attemptId: 'attempt-reviewer',
    });
    state = await dispatchAccepted(kernel, missionId, 'complete-reviewer', {
      type: 'complete-child',
      childId: 'reviewer',
      outcome: 'succeeded',
      summary: 'Review passed.',
      usage: { tokens: 1, usd: 0, activeSeconds: 1 },
      artifact: {
        type: 'review',
        checkpointId: 'subject',
        revisionId: 'subject-revision',
        verdict: 'passed',
        highestSeverity: 'none',
        summary: 'No findings.',
      },
    });
    state = await dispatchAccepted(kernel, missionId, 'record-review', {
      type: 'record-review',
      reviewId: 'review-evidence',
      reviewerChildId: 'reviewer',
      checkpointId: 'subject',
      revisionId: 'subject-revision',
      verdict: 'passed',
      highestSeverity: 'none',
      summary: 'No findings.',
    });

    expect(state).toMatchObject({
      revision: 6,
      children: { reviewer: { status: 'succeeded' } },
      reviews: { 'review-evidence': { reviewerChildId: 'reviewer' } },
    });
  });

  it('preserves a pending human answer at the exact boundary', async () => {
    const store = new MemoryMissionStore({ maxJournalActions: 5, emergencyReserveActions: 3 });
    const kernel = new MissionKernel(store);
    const missionId = 'question-settlement';
    let state = await createLifecycleMission(kernel, missionId);
    state = await dispatchAccepted(kernel, missionId, 'raise-question', {
      type: 'raise-question',
      guideEpoch: state.guideEpoch,
      questionId: 'question',
      prompt: 'Which approved behavior should be retained?',
    });

    expect(state.revision).toBe(2); // Exactly the ordinary class limit for this store.
    state = await dispatchAccepted(kernel, missionId, 'answer-question', {
      type: 'answer-question',
      questionId: 'question',
      answer: 'Retain the reviewed behavior.',
    });

    expect(state.questions.question).toMatchObject({
      status: 'answered',
      answer: 'Retain the reviewed behavior.',
    });
  });

  it('retains a final cleanup attempt after a failed cleanup consumes reserve', async () => {
    const store = new MemoryMissionStore({ maxJournalActions: 4, emergencyReserveActions: 3 });
    const kernel = new MissionKernel(store);
    const missionId = 'cleanup-settlement';
    let state = await createLifecycleMission(kernel, missionId, ['workspace']);
    state = await dispatchAccepted(kernel, missionId, 'terminal', {
      type: 'complete-mission',
      guideEpoch: state.guideEpoch,
      outcome: 'failed',
      reason: 'Stop before cleanup.',
    });
    state = await dispatchAccepted(kernel, missionId, 'cleanup-failed', {
      type: 'fail-cleanup',
      cleanupId: 'workspace',
      error: 'Transient cleanup failure.',
    });
    state = await dispatchAccepted(kernel, missionId, 'cleanup-completed', {
      type: 'complete-cleanup',
      cleanupId: 'workspace',
    });

    expect(state).toMatchObject({
      revision: 4,
      terminal: { outcome: 'failed' },
      cleanup: { workspace: { status: 'completed', error: null } },
    });
  });

  it('admits accepted revision handoff after ordinary admission is exhausted', async () => {
    const store = new MemoryMissionStore({ maxJournalActions: 4, emergencyReserveActions: 3 });
    await commit(store, 0, 'ordinary-create', 'ordinary');
    await expect(commit(store, 1, 'ordinary-blocked', 'blocked')).rejects.toMatchObject({
      name: 'MissionJournalLimitError',
      dimension: 'actions',
    });
    await expect(
      store.commit(
        {
          missionId: 'mission-one',
          expectedRevision: 1,
          actionId: 'emergency-handoff',
          action: {
            type: 'record-accepted-revision-handoff',
            backend: 'git',
            repositoryKey: 'example/repository',
            checkpointId: 'accepted-checkpoint',
            revisionId: 'accepted-revision',
            reference: 'refs/heads/noriq/run/accepted',
            status: 'preserved',
          },
        },
        [
          {
            type: 'accepted-revision-handoff-recorded',
            backend: 'git',
            repositoryKey: 'example/repository',
            checkpointId: 'accepted-checkpoint',
            revisionId: 'accepted-revision',
            reference: 'refs/heads/noriq/run/accepted',
            status: 'preserved',
          },
        ],
      ),
    ).resolves.toMatchObject({ revision: 2 });
  });

  it('will not start validation unless its result and terminal tail still fit', async () => {
    const commandPolicy = {
      kind: 'command' as const,
      policyId: 'tight-validation-v1',
      command: 'true',
      timeoutSeconds: 10,
      shell: null,
    };
    const initialize = async (store: MemoryMissionStore) => {
      await store.commit(
        {
          missionId: 'tight-validation',
          expectedRevision: 0,
          actionId: 'create',
          action: {
            type: 'create-mission',
            projectMcpDeclarationFingerprint: null,
            budget: { tokens: 10, usd: null, activeSeconds: 10 },
            resources: {},
            guide,
            profiles,
            validationPolicy: commandPolicy,
          },
        },
        [
          {
            type: 'mission-created',
            projectMcpDeclarationFingerprint: null,
            budget: { tokens: 10, usd: null, activeSeconds: 10 },
            resources: {},
            guide,
            profiles,
            validationPolicy: commandPolicy,
          },
        ],
      );
      await store.commit(
        {
          missionId: 'tight-validation',
          expectedRevision: 1,
          actionId: 'checkpoint',
          action: {
            type: 'record-checkpoint',
            checkpointId: 'checkpoint',
            revisionId: 'revision',
            authorChildId: null,
            clean: true,
          },
        },
        [
          {
            type: 'checkpoint-recorded',
            checkpointId: 'checkpoint',
            revisionId: 'revision',
            authorChildId: null,
            clean: true,
          },
        ],
      );
    };
    const begin = (store: MemoryMissionStore) =>
      store.commit(
        {
          missionId: 'tight-validation',
          expectedRevision: 2,
          actionId: 'begin-validation',
          action: {
            type: 'begin-validation',
            validationId: 'validation',
            checkpointId: 'checkpoint',
            revisionId: 'revision',
            policyId: commandPolicy.policyId,
          },
        },
        [
          {
            type: 'validation-started',
            validationId: 'validation',
            checkpointId: 'checkpoint',
            revisionId: 'revision',
            policyId: commandPolicy.policyId,
          },
        ],
      );

    const tooTight = new MemoryMissionStore({ maxJournalActions: 5, emergencyReserveActions: 1 });
    await initialize(tooTight);
    await expect(begin(tooTight)).rejects.toMatchObject({
      name: 'MissionJournalLimitError',
      dimension: 'actions',
    });

    const exactFit = new MemoryMissionStore({ maxJournalActions: 6, emergencyReserveActions: 1 });
    await initialize(exactFit);
    await expect(begin(exactFit)).resolves.toMatchObject({ revision: 3 });
    await expect(
      exactFit.commit(
        {
          missionId: 'tight-validation',
          expectedRevision: 3,
          actionId: 'record-validation',
          action: {
            type: 'record-validation',
            validationId: 'validation',
            checkpointId: 'checkpoint',
            revisionId: 'revision',
            policyId: commandPolicy.policyId,
            disposition: 'failed',
            exitCode: 1,
            timedOut: false,
            workspaceChanged: false,
            outputTail: 'failed',
          },
        },
        [
          {
            type: 'validation-recorded',
            validationId: 'validation',
            checkpointId: 'checkpoint',
            revisionId: 'revision',
            policyId: commandPolicy.policyId,
            disposition: 'failed',
            exitCode: 1,
            timedOut: false,
            workspaceChanged: false,
            outputTail: 'failed',
          },
        ],
      ),
    ).resolves.toMatchObject({ revision: 4 });
    await expect(
      exactFit.commit(
        {
          missionId: 'tight-validation',
          expectedRevision: 4,
          actionId: 'terminal',
          action: {
            type: 'complete-mission',
            guideEpoch: 0,
            outcome: 'failed',
            reason: 'validation failed',
          },
        },
        [
          {
            type: 'mission-completed',
            guideEpoch: 0,
            outcome: 'failed',
            reason: 'validation failed',
          },
        ],
      ),
    ).resolves.toMatchObject({ revision: 5 });
  });
});

describe('mission journal canonicalization', () => {
  it('gives equivalent action object key orders one fingerprint', () => {
    const first = {
      type: 'create-mission',
      projectMcpDeclarationFingerprint: null,
      budget: { tokens: 10, usd: null, activeSeconds: null },
      resources: {},
      guide,
      profiles,
      validationPolicy,
    } as MissionAction;
    const second = {
      profiles,
      guide,
      validationPolicy,
      resources: {},
      budget: { activeSeconds: null, usd: null, tokens: 10 },
      type: 'create-mission',
      projectMcpDeclarationFingerprint: null,
    } as MissionAction;
    expect(missionActionFingerprint(first)).toBe(missionActionFingerprint(second));
    expect(canonicalMissionJson(first)).toBe(canonicalMissionJson(second));
  });

  it('rejects silent JSON coercions rather than collapsing distinct actions', () => {
    expect(() => missionActionFingerprint({ value: Number.NaN } as unknown as MissionAction)).toThrow(
      InvalidMissionCommitError,
    );
    expect(() => missionActionFingerprint({ value: undefined } as unknown as MissionAction)).toThrow(
      InvalidMissionCommitError,
    );
    expect(() => missionActionFingerprint(new Date() as unknown as MissionAction)).toThrow(
      InvalidMissionCommitError,
    );
  });

  it('exposes typed optimistic-concurrency errors', async () => {
    const store = new MemoryMissionStore();
    await expect(commit(store, 1, 'action-one', 'first')).rejects.toBeInstanceOf(MissionStoreConflictError);
  });
});
