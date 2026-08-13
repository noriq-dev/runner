import { describe, expect, it } from 'vitest';
import type { MissionChildExecutor, MissionGuide } from '../src/mission/harness';
import { MemoryMissionStore } from '../src/mission/memory-store';
import {
  type MissionProfileCatalogSnapshot,
  snapshotMissionProfileCatalog,
} from '../src/mission/profile-catalog';
import type { CreateMissionAction } from '../src/mission/protocol';
import { MissionService } from '../src/mission/service';
import type { MissionStoreEnumerationEntry } from '../src/mission/store';

const createAction = (turnLimit = 2): CreateMissionAction => ({
  type: 'create-mission',
  objective: {
    brief: 'Ship the bounded change.',
    repositoryKey: 'runner',
    baseRevision: 'immutable-base-revision',
  },
  projectMcpDeclarationFingerprint: null,
  budget: { tokens: 10_000, usd: 5, activeSeconds: 300 },
  resources: {},
  guide: {
    profileId: 'guide',
    agent: { driver: 'codex', model: 'guide-model', effort: 'high' },
    budget: { tokens: 1_000, usd: 1, activeSeconds: 30 },
    turnLimit,
  },
  profiles: [
    {
      profileId: 'builder',
      role: 'builder',
      permission: 'write',
      agent: { driver: 'codex', model: 'build-model', effort: 'medium' },
      assurance: { rank: 1, independenceClass: 'build' },
      driverPosture: {
        kind: 'build',
        permission: {
          write: true,
          allow: ['Read', 'Edit'],
          deny: [],
          auto: false,
        },
        lineageRole: 'worker',
      },
      budget: { tokens: 5_000, usd: 2, activeSeconds: 120 },
      resources: {},
      projectMcp: [],
    },
    {
      profileId: 'reviewer',
      role: 'reviewer',
      permission: 'read',
      agent: { driver: 'claude', model: 'review-model', effort: 'high' },
      assurance: { rank: 2, independenceClass: 'independent-review' },
      driverPosture: {
        kind: 'verify',
        permission: {
          write: false,
          allow: ['Read'],
          deny: ['Edit'],
          auto: false,
        },
        lineageRole: 'reviewer',
      },
      budget: { tokens: 2_000, usd: 1, activeSeconds: 60 },
      resources: {},
      projectMcp: [],
    },
  ],
  validationPolicy: {
    kind: 'none',
    policyId: 'test-none-v1',
    reason: 'No deterministic validation in this unit fixture.',
  },
  completion: { requireCheckpoint: false, requireReview: false },
});

const createFixture = (missionId: string, turnLimit = 2) => {
  const action = createAction(turnLimit);
  const catalog: MissionProfileCatalogSnapshot = snapshotMissionProfileCatalog({
    guide: action.guide,
    profiles: action.profiles,
    validationPolicy: action.validationPolicy,
  });
  return {
    catalog,
    request: {
      missionId,
      actionId: 'create',
      catalogFingerprint: catalog.fingerprint,
      objective: action.objective,
      budget: action.budget,
      resources: action.resources,
      completion: action.completion,
    },
  };
};

const unusedChildren: MissionChildExecutor = {
  startOrAttach: async () => {
    throw new Error('no child should be started');
  },
};

const completingGuide: MissionGuide = {
  next: async ({ projection }) => ({
    output: JSON.stringify({
      missionId: projection.missionId,
      expectedRevision: projection.revision,
      guideEpoch: projection.guideEpoch,
      actionId: 'finish',
      action: {
        type: 'propose_completion',
        outcome: 'succeeded',
        reason: 'Objective is complete.',
      },
    }),
    usage: { tokens: 10, usd: 0.01, activeSeconds: 0.1 },
  }),
};

class StoreWithCorruptCandidate extends MemoryMissionStore {
  override async listMissionEntries(): Promise<readonly MissionStoreEnumerationEntry[]> {
    return [
      {
        missionId: 'journal:mission-corrupt.jsonl',
        error: 'corrupt journal fixture',
      },
      ...(await super.listMissionEntries()),
    ];
  }
}

describe('MissionService', () => {
  it('creates a mission idempotently on revision zero', async () => {
    const store = new MemoryMissionStore();
    const { catalog, request } = createFixture('mission-service-create');
    const service = new MissionService({ store, guide: completingGuide, children: unusedChildren }, [
      catalog,
    ]);

    const created = await service.create(request);
    const replayed = await service.create(request);

    expect(created.accepted).toBe(true);
    expect(created.accepted && created.replayed).toBe(false);
    expect(replayed.accepted).toBe(true);
    expect(replayed.accepted && replayed.replayed).toBe(true);
    expect((await service.inspect(request.missionId)).status).toBe('active');
  });

  it('resolves authority only from a catalog registered by local composition', async () => {
    const store = new MemoryMissionStore();
    const { catalog, request } = createFixture('mission-service-untrusted-catalog');
    const service = new MissionService({ store, guide: completingGuide, children: unusedChildren }, [
      catalog,
    ]);

    await expect(service.create({ ...request, catalogFingerprint: 'f'.repeat(64) })).rejects.toThrow(
      'is not registered locally',
    );
    expect((await service.inspect(request.missionId)).status).toBe('uninitialized');
  });

  it('requires finite positive mission token and active-time ceilings before creation', async () => {
    const store = new MemoryMissionStore();
    const { catalog, request } = createFixture('mission-service-bounded-budget');
    const service = new MissionService({ store, guide: completingGuide, children: unusedChildren }, [
      catalog,
    ]);

    await expect(
      service.create({
        ...request,
        budget: { ...request.budget, tokens: null },
      }),
    ).rejects.toThrow(/token budget must be a finite positive safe integer/);
    await expect(
      service.create({
        ...request,
        budget: { ...request.budget, activeSeconds: 0 },
      }),
    ).rejects.toThrow(/activeSeconds budget must be finite and positive/);
    await expect(service.create({ ...request, budget: { ...request.budget, usd: -1 } })).rejects.toThrow(
      /USD budget must be null or finite and non-negative/,
    );
    expect((await service.inspect(request.missionId)).status).toBe('uninitialized');

    const created = await service.create({
      ...request,
      budget: { ...request.budget, usd: null },
    });
    expect(created.accepted).toBe(true);
  });

  it('requires repository and immutable base authority before admitting writable profiles', async () => {
    const store = new MemoryMissionStore();
    const { catalog, request } = createFixture('mission-service-write-authority');
    const service = new MissionService({ store, guide: completingGuide, children: unusedChildren }, [
      catalog,
    ]);

    await expect(
      service.create({
        ...request,
        objective: {
          brief: request.objective!.brief,
          baseRevision: request.objective!.baseRevision,
        },
      }),
    ).rejects.toThrow(/repositoryKey/);
    await expect(
      service.create({
        ...request,
        objective: {
          brief: request.objective!.brief,
          repositoryKey: request.objective!.repositoryKey,
        },
      }),
    ).rejects.toThrow(/baseRevision/);
    expect((await service.inspect(request.missionId)).status).toBe('uninitialized');
  });

  it('refuses a forged catalog snapshot at the local composition boundary', () => {
    const store = new MemoryMissionStore();
    const { catalog } = createFixture('mission-service-forged-catalog');
    const forged = { ...structuredClone(catalog), fingerprint: 'f'.repeat(64) };

    expect(
      () =>
        new MissionService({ store, guide: completingGuide, children: unusedChildren }, [
          forged as MissionProfileCatalogSnapshot,
        ]),
    ).toThrow(/fingerprint does not match/);
  });

  it('controls a mission through guide completion', async () => {
    const store = new MemoryMissionStore();
    const { catalog, request } = createFixture('mission-service-control');
    const service = new MissionService({ store, guide: completingGuide, children: unusedChildren }, [
      catalog,
    ]);
    await service.create(request);

    const stop = await service.control('mission-service-control');

    expect(stop.reason).toBe('terminal');
    expect(stop.state.status).toBe('succeeded');
    expect(stop.guideTurns).toBe(1);
  });

  it('answers while a local question callback is still yielding and continues after that controller exits', async () => {
    const store = new MemoryMissionStore();
    const { catalog, request } = createFixture('mission-service-answer-race');
    let guideCall = 0;
    let releaseNotification!: () => void;
    const notificationGate = new Promise<void>((resolve) => {
      releaseNotification = resolve;
    });
    let notificationStarted!: () => void;
    const notificationStart = new Promise<void>((resolve) => {
      notificationStarted = resolve;
    });
    const service = new MissionService(
      {
        store,
        children: unusedChildren,
        guide: {
          async next({ projection }) {
            guideCall += 1;
            return {
              output: JSON.stringify({
                missionId: projection.missionId,
                expectedRevision: projection.revision,
                guideEpoch: projection.guideEpoch,
                actionId: guideCall === 1 ? 'ask' : 'finish-after-answer',
                action:
                  guideCall === 1
                    ? {
                        type: 'ask_human',
                        question: 'Choose the compatibility behavior.',
                      }
                    : {
                        type: 'propose_completion',
                        outcome: 'succeeded',
                        reason: `Used answer: ${projection.questions[0]?.answer ?? 'missing'}`,
                      },
              }),
              usage: { tokens: 10, usd: 0.01, activeSeconds: 0.1 },
            };
          },
        },
        async onQuestion() {
          notificationStarted();
          await notificationGate;
        },
      },
      [catalog],
    );
    await service.create(request);

    const firstControl = service.control(request.missionId);
    await notificationStart;
    const questionId = (await service.inspect(request.missionId)).questionOrder[0]!;
    const continuation = service.answerAndContinue(
      request.missionId,
      questionId,
      'Preserve the reviewed behavior.',
    );
    releaseNotification();

    await expect(firstControl).resolves.toMatchObject({
      reason: 'human-question',
    });
    await expect(continuation).resolves.toMatchObject({
      reason: 'terminal',
      state: {
        status: 'succeeded',
        terminal: { reason: 'Used answer: Preserve the reviewed behavior.' },
      },
    });
    expect(guideCall).toBe(2);
  });

  it('reconciles every durable mission sequentially without aborting the batch', async () => {
    const store = new StoreWithCorruptCandidate();
    const { catalog } = createFixture('unused');
    const service = new MissionService({ store, guide: completingGuide, children: unusedChildren }, [
      catalog,
    ]);
    for (const missionId of ['mission-b', 'mission-a']) {
      await service.create(createFixture(missionId).request);
    }

    const results = await service.reconcileAll();

    expect(results.map((result) => result.missionId)).toEqual([
      'journal:mission-corrupt.jsonl',
      'mission-a',
      'mission-b',
    ]);
    expect(results[0]).toEqual({
      missionId: 'journal:mission-corrupt.jsonl',
      ok: false,
      error: 'corrupt journal fixture',
    });
    expect(results.slice(1).every((result) => result.ok && result.stop.reason === 'terminal')).toBe(true);
  });

  it('enumerates durable startup inventory without invoking models or mutating journals', async () => {
    const store = new StoreWithCorruptCandidate();
    const { catalog, request } = createFixture('mission-inspect-only');
    let guideCalls = 0;
    const service = new MissionService(
      {
        store,
        children: unusedChildren,
        guide: {
          async next(input) {
            guideCalls += 1;
            return completingGuide.next(input);
          },
        },
      },
      [catalog],
    );
    await service.create(request);
    const before = await store.load(request.missionId);

    const inventory = await service.inspectAll();

    expect(inventory).toEqual([
      {
        missionId: 'journal:mission-corrupt.jsonl',
        ok: false,
        error: 'corrupt journal fixture',
      },
      expect.objectContaining({
        missionId: request.missionId,
        ok: true,
        state: expect.objectContaining({ status: 'active', revision: 1 }),
      }),
    ]);
    expect(guideCalls).toBe(0);
    const after = await store.load(request.missionId);
    expect(after.revision).toBe(before.revision);
    expect(after.headHash).toBe(before.headHash);
  });

  it('drains terminal cleanup before an active journal may invoke its guide', async () => {
    const store = new MemoryMissionStore();
    const terminalFixture = createFixture('mission-z-terminal');
    const activeFixture = createFixture('mission-a-active');
    const initial = new MissionService({ store, guide: completingGuide, children: unusedChildren }, [
      terminalFixture.catalog,
    ]);
    await initial.create({ ...terminalFixture.request, cleanup: ['release-workspace'] });
    await expect(initial.control(terminalFixture.request.missionId)).resolves.toMatchObject({
      reason: 'runtime-error',
      state: { status: 'succeeded' },
    });
    await initial.create(activeFixture.request);

    const order: string[] = [];
    const recovered = new MissionService(
      {
        store,
        children: unusedChildren,
        cleanup: {
          execute: async (_state, cleanupId) => {
            order.push(`cleanup:${cleanupId}`);
          },
        },
        guide: {
          next: async (request) => {
            order.push(`guide:${request.projection.missionId}`);
            return completingGuide.next(request);
          },
        },
      },
      [terminalFixture.catalog],
    );

    const results = await recovered.reconcileAll();

    expect(results.every((result) => result.ok)).toBe(true);
    expect(order).toEqual(['cleanup:release-workspace', 'guide:mission-a-active']);
  });
});
