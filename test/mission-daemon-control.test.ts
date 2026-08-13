import type {
  MissionAdoptionResult,
  MissionInventoryItem,
  MissionQuestionAck,
  MissionTaskAck,
} from '@noriq-dev/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  type DaemonMissionCoordinatorLike,
  MAX_DAEMON_MISSION_RECONCILIATION_ROOTS,
  MissionDaemonControl,
  MissionDaemonControlFatalError,
} from '../src/mission/daemon-control';
import {
  type NoriqMissionCommission,
  computeNoriqMissionCommissionDigest,
} from '../src/mission/noriq-coordinator-store';
import { WsMissionCoordinatorTransport } from '../src/mission/noriq-transport';

const NOW = new Date('2026-08-13T01:00:00.000Z');
const FUTURE = '2026-08-13T01:01:00.000Z';
const GENERATION = 1;
const NEXT_GENERATION = 2;

function inventory(runId: string, epoch = 1): MissionInventoryItem {
  return {
    runId,
    lease: { sitting: 3, executionId: `execution_${runId}`, epoch },
    commissionDigest: 'a'.repeat(64),
    attempts: [
      {
        attemptId: `attempt_${runId}`,
        executionId: `child_execution_${runId}`,
        epoch,
      },
    ],
  };
}

function adoption(
  runId: string,
  decision: MissionAdoptionResult['decision'] = 'adopt',
  epoch = 2,
): MissionAdoptionResult {
  return {
    runId,
    decision,
    lease: decision === 'adopt' ? { sitting: 3, executionId: `execution_${runId}`, epoch } : null,
    reason: decision === 'adopt' ? null : `${decision} by server`,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeCoordinator(
  overrides: Partial<DaemonMissionCoordinatorLike> = {},
): DaemonMissionCoordinatorLike {
  return {
    inventoryAll: vi.fn().mockResolvedValue([]),
    reservedRootRunIds: vi.fn().mockResolvedValue([]),
    adopt: vi.fn().mockResolvedValue({}),
    control: vi.fn().mockResolvedValue({ reason: 'completed' }),
    cancel: vi.fn().mockResolvedValue({ reason: 'cancelled' }),
    ...overrides,
  };
}

function fakeTransport() {
  return {
    acknowledge: vi.fn().mockReturnValue(false),
    stop: vi.fn(),
  };
}

function activate(control: MissionDaemonControl, generation = GENERATION): void {
  expect(control.activateTransportGeneration(generation)).toBe(true);
}

function freshCommission(): NoriqMissionCommission {
  const body: Omit<NoriqMissionCommission, 'commissionDigest'> = {
    schemaVersion: 1,
    rootRunId: 'run-fresh',
    lease: { sitting: 1, executionId: 'execution_fresh', epoch: 1 },
    serverCommissionDigest: 'b'.repeat(64),
    publishHandoff: false,
    executionProfile: {
      id: 'default',
      declarationFingerprint: 'decl',
      effectiveFingerprint: 'effective',
      generation: 1,
      attestationCapable: true,
    },
    repositoryKey: 'repo-key',
    baseRevision: '1'.repeat(40),
    tasks: [{ taskId: 'task-fresh', childKey: 'PLNR-1', brief: 'Build it.', dependencyIds: [] }],
    budget: { tokens: 100, usd: null, activeSeconds: 10 },
    catalogFingerprint: 'c'.repeat(64),
    resources: {},
  };
  return { ...body, commissionDigest: computeNoriqMissionCommissionDigest(body) };
}

describe('MissionDaemonControl', () => {
  it('commissions fresh authority durably before starting its root on that exact generation', async () => {
    const commission = freshCommission();
    const commissioned = vi.fn().mockResolvedValue({});
    const controlled = vi.fn().mockResolvedValue({
      reason: 'completed',
      state: {
        rootRunId: commission.rootRunId,
        lease: commission.lease,
        commission,
        tasks: [],
      },
    });
    const control = new MissionDaemonControl({
      coordinator: fakeCoordinator({ commission: commissioned, control: controlled }),
      transport: fakeTransport(),
      sendReconciliation: () => true,
      fatal: vi.fn(),
    });
    activate(control);

    await expect(control.commissionFresh(commission, GENERATION)).resolves.toBe(true);
    await vi.waitFor(() => expect(controlled).toHaveBeenCalledWith(commission.rootRunId));
    expect(commissioned).toHaveBeenCalledWith(commission);
    expect(control.authorizedTransportGeneration(commission.rootRunId)).toBe(GENERATION);
  });

  it('delivers only an exact task acknowledgement to the transport waiter', async () => {
    const transport = new WsMissionCoordinatorTransport({
      sendBegin: () => true,
      sendSettle: () => true,
    });
    const control = new MissionDaemonControl({
      coordinator: fakeCoordinator(),
      transport,
      sendReconciliation: () => true,
      fatal: vi.fn(),
      now: () => NOW,
    });
    activate(control);
    const begin = {
      reportId: 'report_1',
      attemptId: 'attempt_1',
      taskId: 'task_1',
      childKey: 'child_1',
      observedAt: NOW.toISOString(),
    };
    const pending = transport.begin('root_1', inventory('root_1').lease, begin);
    const exact: MissionTaskAck = {
      reportId: begin.reportId,
      attemptId: begin.attemptId,
      phase: 'begin',
      accepted: true,
      taskId: begin.taskId,
      claimId: 'claim_1',
      executionId: 'execution_1',
      taskStatus: 'in_progress',
      error: null,
    };

    expect(control.acknowledgeTask({ ...exact, attemptId: 'other_attempt' }, GENERATION)).toBe(false);
    expect(control.acknowledgeTask(exact, GENERATION)).toBe(true);
    await expect(pending).resolves.toEqual(exact);
    await control.stop();
  });

  it('persists a replayed question acknowledgement after fresh authority is admitted', async () => {
    const commission = freshCommission();
    const questionAck: MissionQuestionAck = {
      reportId: 'replay:question-1',
      questionId: 'question-1',
      attemptId: 'attempt-question-1',
      accepted: true,
      signalId: 'signal-question-1',
      state: 'open',
      error: null,
    };
    const recordQuestionPublication = vi.fn().mockResolvedValue({});
    const pendingControl = deferred<unknown>();
    const control = new MissionDaemonControl({
      coordinator: fakeCoordinator({
        commission: vi.fn().mockResolvedValue({}),
        control: vi.fn().mockReturnValue(pendingControl.promise),
        inspect: vi.fn().mockResolvedValue({
          rootRunId: commission.rootRunId,
          lease: commission.lease,
          commission,
          tasks: [
            {
              task: { taskId: 'task-fresh' },
              attemptId: 'attempt-question-1',
              questionPublication: null,
              observation: { kind: 'human-question', questionId: 'question-1', prompt: 'Choose.' },
            },
          ],
        }),
        recordQuestionPublication,
      }),
      transport: fakeTransport(),
      sendReconciliation: () => true,
      fatal: vi.fn(),
    });
    activate(control);
    await control.commissionFresh(commission, GENERATION);

    await expect(
      control.reconcileQuestionAck(commission.rootRunId, commission.lease, questionAck, GENERATION),
    ).resolves.toBe(true);
    expect(recordQuestionPublication).toHaveBeenCalledWith(
      commission.rootRunId,
      questionAck.questionId,
      questionAck.reportId,
      questionAck.signalId,
    );
    pendingControl.resolve({ reason: 'human-question' });
    await control.stop();
  });

  it('ignores acknowledgements, requests, and results from a superseded generation', async () => {
    const transport = fakeTransport();
    const coordinator = fakeCoordinator({
      inventoryAll: vi.fn().mockResolvedValue([inventory('root_a')]),
      reservedRootRunIds: vi.fn().mockResolvedValue(['root_a']),
    });
    const send = vi.fn().mockReturnValue(true);
    const control = new MissionDaemonControl({
      coordinator,
      transport,
      sendReconciliation: send,
      fatal: vi.fn(),
      now: () => NOW,
    });
    activate(control);
    await control.transportGenerationLost(GENERATION, 'socket replaced');
    activate(control, NEXT_GENERATION);

    const staleAck: MissionTaskAck = {
      reportId: 'report_stale',
      attemptId: 'attempt_stale',
      phase: 'begin',
      accepted: true,
      taskId: 'task_stale',
      claimId: 'claim_stale',
      executionId: 'execution_stale',
      taskStatus: 'in_progress',
      error: null,
    };
    expect(control.acknowledgeTask(staleAck, GENERATION)).toBe(false);
    await expect(
      control.reconcile({ deadline: FUTURE, items: [inventory('root_a')] }, GENERATION),
    ).resolves.toBe(false);
    await expect(control.applyResults([adoption('root_a')], GENERATION)).resolves.toBe(false);

    expect(transport.acknowledge).not.toHaveBeenCalled();
    expect(coordinator.inventoryAll).not.toHaveBeenCalled();
    expect(coordinator.reservedRootRunIds).not.toHaveBeenCalled();
    expect(coordinator.adopt).not.toHaveBeenCalled();
    expect(coordinator.control).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    await control.stop();
  });

  it('replies only for server-named local roots and forwards parsed mismatched local facts', async () => {
    const localA = inventory('root_a', 1);
    const localB = inventory('root_b', 4);
    const coordinator = fakeCoordinator({
      inventoryAll: vi.fn().mockResolvedValue([localA, localB]),
    });
    const send = vi.fn().mockReturnValue(true);
    const fatal = vi.fn();
    const control = new MissionDaemonControl({
      coordinator,
      transport: fakeTransport(),
      sendReconciliation: send,
      fatal,
      now: () => NOW,
    });
    activate(control);
    const serverA = inventory('root_a', 99);
    const serverOnly = inventory('root_server_only', 2);
    const request = { deadline: FUTURE, items: [serverA, serverOnly] };

    await expect(control.reconcile(request, GENERATION)).resolves.toBe(true);
    await expect(control.reconcile(request, GENERATION)).resolves.toBe(true);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, [localA], GENERATION);
    expect(send.mock.calls[0]?.[0]?.[0]).not.toBe(localA);
    expect(send.mock.calls[0]?.[0]?.[0]).not.toEqual(serverA);
    expect(coordinator.inventoryAll).toHaveBeenCalledTimes(2);
    expect(fatal).not.toHaveBeenCalled();
  });

  it('strips coordinator-private fields before reconciliation crosses the wire', async () => {
    const augmented = {
      ...inventory('root_a'),
      privateWorkspace: '/secret/path',
      attempts: [
        {
          ...inventory('root_a').attempts[0]!,
          localPid: 4242,
        },
      ],
    } as unknown as MissionInventoryItem;
    const send = vi.fn().mockReturnValue(true);
    const control = new MissionDaemonControl({
      coordinator: fakeCoordinator({ inventoryAll: vi.fn().mockResolvedValue([augmented]) }),
      transport: fakeTransport(),
      sendReconciliation: send,
      fatal: vi.fn(),
      now: () => NOW,
    });
    activate(control);

    await expect(
      control.reconcile({ deadline: FUTURE, items: [inventory('root_a')] }, GENERATION),
    ).resolves.toBe(true);
    expect(JSON.stringify(send.mock.calls)).not.toContain('privateWorkspace');
    expect(JSON.stringify(send.mock.calls)).not.toContain('localPid');
  });

  it.each([
    {
      name: 'duplicate server root ids',
      request: { deadline: FUTURE, items: [inventory('duplicate'), inventory('duplicate')] },
      code: 'MISSION_RECONCILIATION_INVALID',
    },
    {
      name: 'the wire root bound',
      request: {
        deadline: FUTURE,
        items: Array.from({ length: MAX_DAEMON_MISSION_RECONCILIATION_ROOTS + 1 }, (_, index) =>
          inventory(`root_${index}`),
        ),
      },
      code: 'MISSION_RECONCILIATION_INVALID',
    },
    {
      name: 'an expired deadline',
      request: { deadline: NOW.toISOString(), items: [] },
      code: 'MISSION_RECONCILIATION_EXPIRED',
    },
  ])('fails closed for $name', async ({ request, code }) => {
    const fatal = vi.fn();
    const coordinator = fakeCoordinator();
    const send = vi.fn().mockReturnValue(true);
    const control = new MissionDaemonControl({
      coordinator,
      transport: fakeTransport(),
      sendReconciliation: send,
      fatal,
      now: () => NOW,
    });
    activate(control);

    await expect(control.reconcile(request, GENERATION)).resolves.toBe(false);
    expect(fatal).toHaveBeenCalledOnce();
    expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ code }));
    expect(send).not.toHaveBeenCalled();
  });

  it('fails closed on corrupt inventory without logging the underlying secret', async () => {
    const coordinator = fakeCoordinator({
      inventoryAll: vi.fn().mockRejectedValue(new Error('credential=do-not-log')),
    });
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const fatal = vi.fn();
    const control = new MissionDaemonControl({
      coordinator,
      transport: fakeTransport(),
      sendReconciliation: vi.fn().mockReturnValue(true),
      fatal,
      logger,
      now: () => NOW,
    });
    activate(control);

    await expect(
      control.reconcile({ deadline: FUTURE, items: [inventory('root_a')] }, GENERATION),
    ).resolves.toBe(false);
    expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ code: 'MISSION_INVENTORY_READ_FAILED' }));
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('do-not-log');
  });

  it('fails closed when local inventory is invalid or cannot reach the socket', async () => {
    const duplicateLocal = fakeCoordinator({
      inventoryAll: vi.fn().mockResolvedValue([inventory('root_a'), inventory('root_a')]),
    });
    const duplicateFatal = vi.fn();
    const duplicateControl = new MissionDaemonControl({
      coordinator: duplicateLocal,
      transport: fakeTransport(),
      sendReconciliation: () => true,
      fatal: duplicateFatal,
      now: () => NOW,
    });
    activate(duplicateControl);
    await expect(
      duplicateControl.reconcile({ deadline: FUTURE, items: [inventory('root_a')] }, GENERATION),
    ).resolves.toBe(false);
    expect(duplicateFatal).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'MISSION_INVENTORY_INVALID' }),
    );

    const sendFatal = vi.fn();
    const disconnected = new MissionDaemonControl({
      coordinator: fakeCoordinator({
        inventoryAll: vi.fn().mockResolvedValue([inventory('root_a')]),
      }),
      transport: fakeTransport(),
      sendReconciliation: () => false,
      fatal: sendFatal,
      now: () => NOW,
    });
    activate(disconnected);
    await expect(
      disconnected.reconcile({ deadline: FUTURE, items: [inventory('root_a')] }, GENERATION),
    ).resolves.toBe(false);
    expect(sendFatal).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'MISSION_RECONCILIATION_SEND_FAILED' }),
    );
  });

  it('applies known results sequentially, starts only adopted roots, and quarantines unknown', async () => {
    const events: string[] = [];
    let simultaneousAdoptions = 0;
    let maximumSimultaneousAdoptions = 0;
    const adopt = vi.fn(async (result: MissionAdoptionResult) => {
      events.push(`start:${result.runId}:${result.decision}`);
      simultaneousAdoptions += 1;
      maximumSimultaneousAdoptions = Math.max(maximumSimultaneousAdoptions, simultaneousAdoptions);
      await Promise.resolve();
      simultaneousAdoptions -= 1;
      events.push(`end:${result.runId}:${result.decision}`);
      return {};
    });
    const run = vi.fn().mockResolvedValue({ reason: 'human-question' });
    const coordinator = fakeCoordinator({
      reservedRootRunIds: vi
        .fn()
        .mockResolvedValue(['root_adopt', 'root_cancel', 'root_terminal', 'root_unknown']),
      adopt,
      control: run,
    });
    const control = new MissionDaemonControl({
      coordinator,
      transport: fakeTransport(),
      sendReconciliation: () => true,
      fatal: vi.fn(),
      now: () => NOW,
    });
    activate(control);
    const results = [
      adoption('root_adopt'),
      adoption('not_local'),
      adoption('root_cancel', 'cancel'),
      adoption('root_terminal', 'already_terminal'),
      adoption('root_unknown', 'unknown'),
    ];

    await expect(control.applyResults(results, GENERATION)).resolves.toBe(true);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(adopt.mock.calls.map(([result]) => result.runId)).toEqual([
      'root_adopt',
      'root_cancel',
      'root_terminal',
      'root_unknown',
    ]);
    expect(maximumSimultaneousAdoptions).toBe(1);
    expect(events).toEqual([
      'start:root_adopt:adopt',
      'end:root_adopt:adopt',
      'start:root_cancel:cancel',
      'end:root_cancel:cancel',
      'start:root_terminal:already_terminal',
      'end:root_terminal:already_terminal',
      'start:root_unknown:unknown',
      'end:root_unknown:unknown',
    ]);
    expect(run).toHaveBeenCalledWith('root_adopt');

    // Exact duplicate result frames neither re-adopt nor launch another controller.
    await expect(control.applyResults(results, GENERATION)).resolves.toBe(true);
    expect(adopt).toHaveBeenCalledTimes(4);
    expect(run).toHaveBeenCalledOnce();
    await control.stop();
  });

  it('deduplicates a background controller while an adopted root is active', async () => {
    const active = deferred<unknown>();
    const run = vi.fn().mockReturnValue(active.promise);
    const coordinator = fakeCoordinator({
      reservedRootRunIds: vi.fn().mockResolvedValue(['root_a']),
      control: run,
    });
    const control = new MissionDaemonControl({
      coordinator,
      transport: fakeTransport(),
      sendReconciliation: () => true,
      fatal: vi.fn(),
      now: () => NOW,
    });
    activate(control);

    await control.applyResults([adoption('root_a')], GENERATION);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    await control.applyResults([adoption('root_a')], GENERATION);
    expect(run).toHaveBeenCalledOnce();

    active.resolve({ reason: 'human-question' });
    await control.stop();
    expect(run).toHaveBeenCalledOnce();
  });

  it('rejects duplicate result ids before adoption', async () => {
    const coordinator = fakeCoordinator({
      reservedRootRunIds: vi.fn().mockResolvedValue(['root_a']),
    });
    const fatal = vi.fn();
    const control = new MissionDaemonControl({
      coordinator,
      transport: fakeTransport(),
      sendReconciliation: () => true,
      fatal,
      now: () => NOW,
    });
    activate(control);

    await expect(control.applyResults([adoption('root_a'), adoption('root_a')], GENERATION)).resolves.toBe(
      false,
    );
    expect(coordinator.adopt).not.toHaveBeenCalled();
    expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ code: 'MISSION_RECONCILIATION_INVALID' }));
  });

  it('exposes reserved roots and routes cancellation only to a known root', async () => {
    const cancel = vi.fn().mockResolvedValue({ reason: 'cancelled' });
    const coordinator = fakeCoordinator({
      reservedRootRunIds: vi.fn().mockResolvedValue(['root_known']),
      cancel,
    });
    const control = new MissionDaemonControl({
      coordinator,
      transport: fakeTransport(),
      sendReconciliation: () => true,
      fatal: vi.fn(),
      now: () => NOW,
    });
    activate(control);

    const reserved = await control.reservedRootRunIds();
    expect(reserved).toEqual(['root_known']);
    expect(Object.isFrozen(reserved)).toBe(true);
    await expect(
      control.cancelKnownRoot('root_elsewhere', 'operator cancellation', GENERATION),
    ).resolves.toBe(false);
    await expect(control.cancelKnownRoot('root_known', 'operator cancellation', GENERATION)).resolves.toBe(
      true,
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith('root_known', 'operator cancellation');
  });

  it('drops a cancellation whose socket generation is lost during the inventory read', async () => {
    const inventoryRead = deferred<readonly string[]>();
    const cancel = vi.fn().mockResolvedValue({ reason: 'cancelled' });
    const coordinator = fakeCoordinator({
      reservedRootRunIds: vi.fn().mockReturnValue(inventoryRead.promise),
      cancel,
    });
    const control = new MissionDaemonControl({
      coordinator,
      transport: fakeTransport(),
      sendReconciliation: () => true,
      fatal: vi.fn(),
      now: () => NOW,
    });
    activate(control);

    const cancelling = control.cancelKnownRoot('root_known', 'old socket cancellation', GENERATION);
    await vi.waitFor(() => expect(coordinator.reservedRootRunIds).toHaveBeenCalledOnce());
    const lost = control.transportGenerationLost(GENERATION, 'socket replaced');
    activate(control, NEXT_GENERATION);
    inventoryRead.resolve(['root_known']);

    await expect(cancelling).resolves.toBe(false);
    await lost;
    expect(cancel).not.toHaveBeenCalled();
    await control.stop();
  });

  it('quiesces the lost transport generation before applying a new adoption', async () => {
    const barrier = deferred<void>();
    const quarantineAll = vi.fn().mockReturnValue(barrier.promise);
    const adopt = vi.fn().mockResolvedValue({});
    const transport = fakeTransport();
    const coordinator = fakeCoordinator({
      reservedRootRunIds: vi.fn().mockResolvedValue(['root_a']),
      quarantineAll,
      adopt,
    });
    const control = new MissionDaemonControl({
      coordinator,
      transport,
      sendReconciliation: () => true,
      fatal: vi.fn(),
      now: () => NOW,
    });
    activate(control);

    const lost = control.transportGenerationLost(GENERATION, 'socket closed');
    activate(control, NEXT_GENERATION);
    const applying = control.applyResults([adoption('root_a')], NEXT_GENERATION);
    await vi.waitFor(() => expect(quarantineAll).toHaveBeenCalledWith('socket closed'));
    expect(transport.stop).toHaveBeenCalledWith('socket closed');
    expect(adopt).not.toHaveBeenCalled();

    barrier.resolve();
    await lost;
    await expect(applying).resolves.toBe(true);
    expect(adopt).toHaveBeenCalledOnce();
    await control.stop();
  });

  it('does not send a stale reconciliation after disconnect during a slow inventory read', async () => {
    const localInventory = deferred<readonly MissionInventoryItem[]>();
    const send = vi.fn().mockReturnValue(true);
    const coordinator = fakeCoordinator({
      inventoryAll: vi.fn().mockReturnValue(localInventory.promise),
      quarantineAll: vi.fn(),
    });
    const control = new MissionDaemonControl({
      coordinator,
      transport: fakeTransport(),
      sendReconciliation: send,
      fatal: vi.fn(),
      now: () => NOW,
    });
    activate(control);

    const reconciling = control.reconcile({ deadline: FUTURE, items: [inventory('root_a')] }, GENERATION);
    await vi.waitFor(() => expect(coordinator.inventoryAll).toHaveBeenCalledOnce());
    const lost = control.transportGenerationLost(GENERATION, 'socket closed during inventory');
    activate(control, NEXT_GENERATION);
    localInventory.resolve([inventory('root_a')]);

    await expect(reconciling).resolves.toBe(false);
    await lost;
    expect(send).not.toHaveBeenCalled();
    await control.stop();
  });

  it('does not start control when an old-generation adoption returns after disconnect', async () => {
    const durableAdoption = deferred<unknown>();
    const adopt = vi.fn().mockReturnValue(durableAdoption.promise);
    const run = vi.fn().mockResolvedValue({ reason: 'human-question' });
    const coordinator = fakeCoordinator({
      reservedRootRunIds: vi.fn().mockResolvedValue(['root_a']),
      adopt,
      control: run,
      quarantineAll: vi.fn(),
    });
    const control = new MissionDaemonControl({
      coordinator,
      transport: fakeTransport(),
      sendReconciliation: () => true,
      fatal: vi.fn(),
      now: () => NOW,
    });
    activate(control);

    const applying = control.applyResults([adoption('root_a')], GENERATION);
    await vi.waitFor(() => expect(adopt).toHaveBeenCalledOnce());
    const lost = control.transportGenerationLost(GENERATION, 'socket closed during adoption');
    activate(control, NEXT_GENERATION);
    durableAdoption.resolve({});

    await expect(applying).resolves.toBe(false);
    await lost;
    expect(run).not.toHaveBeenCalled();
    expect(control.authorizedTransportGeneration('root_a')).toBeNull();
    await control.stop();
  });

  it.each(['transport-error', 'authority-conflict'])(
    'abandons the socket generation after a %s durable control stop',
    async (reason) => {
      const restart = vi.fn();
      const coordinator = fakeCoordinator({
        reservedRootRunIds: vi.fn().mockResolvedValue(['root_a']),
        control: vi.fn().mockResolvedValue({ reason }),
      });
      const control = new MissionDaemonControl({
        coordinator,
        transport: fakeTransport(),
        sendReconciliation: () => true,
        fatal: vi.fn(),
        restartTransportGeneration: restart,
        now: () => NOW,
      });
      activate(control);

      await expect(control.applyResults([adoption('root_a')], GENERATION)).resolves.toBe(true);
      await vi.waitFor(() =>
        expect(restart).toHaveBeenCalledWith(
          'mission control stopped before durable transport settlement',
          GENERATION,
        ),
      );
      await control.stop();
    },
  );

  it('restarts the exact generation when coordinator control rejects', async () => {
    const restart = vi.fn();
    const coordinator = fakeCoordinator({
      reservedRootRunIds: vi.fn().mockResolvedValue(['root_a']),
      control: vi.fn().mockRejectedValue(new Error('runtime disappeared')),
    });
    const control = new MissionDaemonControl({
      coordinator,
      transport: fakeTransport(),
      sendReconciliation: () => true,
      fatal: vi.fn(),
      restartTransportGeneration: restart,
      now: () => NOW,
    });
    activate(control);

    await expect(control.applyResults([adoption('root_a')], GENERATION)).resolves.toBe(true);
    await vi.waitFor(() =>
      expect(restart).toHaveBeenCalledWith(
        'mission coordinator control rejected before durable settlement',
        GENERATION,
      ),
    );
    await control.stop();
  });

  it('stops ack waiters, safely quiesces, and waits for active control without cancelling it', async () => {
    const active = deferred<unknown>();
    const run = vi.fn().mockReturnValue(active.promise);
    const cancel = vi.fn();
    const quiesce = vi.fn();
    const coordinator = fakeCoordinator({
      reservedRootRunIds: vi.fn().mockResolvedValue(['root_a']),
      control: run,
      cancel,
      quiesce,
    });
    const transport = new WsMissionCoordinatorTransport({
      sendBegin: () => true,
      sendSettle: () => true,
    });
    const control = new MissionDaemonControl({
      coordinator,
      transport,
      sendReconciliation: () => true,
      fatal: vi.fn(),
      now: () => NOW,
    });
    activate(control);
    const begin = {
      reportId: 'report_waiting',
      attemptId: 'attempt_waiting',
      taskId: 'task_waiting',
      childKey: 'child_waiting',
      observedAt: NOW.toISOString(),
    };
    const waitingAck = transport.begin('root_a', inventory('root_a').lease, begin);
    const ackRejected = expect(waitingAck).rejects.toThrow('daemon shutdown');
    await control.applyResults([adoption('root_a')], GENERATION);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());

    let stopped = false;
    const stopping = control.stop('daemon shutdown').then(() => {
      stopped = true;
    });
    await ackRejected;
    await vi.waitFor(() => expect(quiesce).toHaveBeenCalledOnce());
    expect(stopped).toBe(false);
    expect(cancel).not.toHaveBeenCalled();

    active.resolve({ reason: 'human-question' });
    await stopping;
    expect(stopped).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('rejects stop when coordinator quiescence cannot prove process-tree settlement', async () => {
    const coordinator = fakeCoordinator({
      quiesce: vi.fn().mockRejectedValue(new Error('process tree is still live')),
    });
    const control = new MissionDaemonControl({
      coordinator,
      transport: fakeTransport(),
      sendReconciliation: () => true,
      fatal: vi.fn(),
      now: () => NOW,
    });
    activate(control);

    await expect(control.stop('daemon shutdown')).rejects.toThrow('process tree is still live');
  });

  it('uses a generic bounded fatal error instead of forwarding adoption failures', async () => {
    const coordinator = fakeCoordinator({
      reservedRootRunIds: vi.fn().mockResolvedValue(['root_a']),
      adopt: vi.fn().mockRejectedValue(new Error('secret adoption detail')),
    });
    const fatal = vi.fn();
    const control = new MissionDaemonControl({
      coordinator,
      transport: fakeTransport(),
      sendReconciliation: () => true,
      fatal,
      now: () => NOW,
    });
    activate(control);

    await expect(control.applyResults([adoption('root_a')], GENERATION)).resolves.toBe(false);
    const error = fatal.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(MissionDaemonControlFatalError);
    expect(error).toMatchObject({ code: 'MISSION_ADOPTION_FAILED' });
    expect(String(error)).not.toContain('secret adoption detail');
  });
});
