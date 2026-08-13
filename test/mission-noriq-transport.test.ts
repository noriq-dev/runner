import type { MissionTaskAck } from '@noriq-dev/shared';
import { describe, expect, it, vi } from 'vitest';
import { WsMissionCoordinatorTransport } from '../src/mission/noriq-transport';

const lease = { sitting: 1, executionId: 'execution_root', epoch: 2 };
const begin = {
  reportId: 'begin_report',
  attemptId: 'attempt_1',
  taskId: 'task_1',
  childKey: 'child_1',
  observedAt: '2026-08-13T00:00:00.000Z',
};
const settle = {
  reportId: 'settle_report',
  attemptId: 'attempt_1',
  claimId: 'claim_1',
  outcome: 'done' as const,
  reason: null,
  observedAt: '2026-08-13T00:01:00.000Z',
};

describe('WsMissionCoordinatorTransport', () => {
  it('correlates exact begin and settle acknowledgements', async () => {
    const transport = new WsMissionCoordinatorTransport({
      sendBegin: () => true,
      sendSettle: () => true,
    });
    const pendingBegin = transport.begin('run_1', lease, begin);
    const beginAck: MissionTaskAck = {
      reportId: begin.reportId,
      attemptId: begin.attemptId,
      phase: 'begin',
      accepted: true,
      taskId: begin.taskId,
      claimId: 'claim_1',
      executionId: 'execution_child',
      taskStatus: 'in_progress',
      error: null,
    };
    expect(transport.acknowledge(beginAck)).toBe(true);
    await expect(pendingBegin).resolves.toEqual(beginAck);

    const pendingSettle = transport.settle('run_1', lease, settle);
    const settleAck: MissionTaskAck = {
      ...beginAck,
      reportId: settle.reportId,
      phase: 'settle',
      taskStatus: 'done',
    };
    expect(transport.acknowledge(settleAck)).toBe(true);
    await expect(pendingSettle).resolves.toEqual(settleAck);
    expect(transport.acknowledge(settleAck)).toBe(false);
  });

  it('fails immediately on a disconnected socket and permits the same durable report to retry', async () => {
    let connected = false;
    const transport = new WsMissionCoordinatorTransport({
      sendBegin: () => connected,
      sendSettle: () => connected,
    });
    await expect(transport.begin('run_1', lease, begin)).rejects.toThrow(/could not reach/);
    connected = true;
    const retried = transport.begin('run_1', lease, begin);
    transport.acknowledge({
      reportId: begin.reportId,
      attemptId: begin.attemptId,
      phase: 'begin',
      accepted: false,
      taskId: null,
      claimId: null,
      executionId: null,
      taskStatus: null,
      error: 'refused',
    });
    await expect(retried).resolves.toMatchObject({ accepted: false });
  });

  it('rejects mismatched acknowledgements, times out, and stops all waiters', async () => {
    vi.useFakeTimers();
    const transport = new WsMissionCoordinatorTransport({
      sendBegin: () => true,
      sendSettle: () => true,
      timeoutMs: 100,
    });
    const timedOut = transport.begin('run_1', lease, begin);
    const timeoutAssertion = expect(timedOut).rejects.toThrow(/timed out/);
    expect(
      transport.acknowledge({
        reportId: begin.reportId,
        attemptId: 'wrong',
        phase: 'begin',
        accepted: false,
        taskId: null,
        claimId: null,
        executionId: null,
        taskStatus: null,
        error: null,
      }),
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await timeoutAssertion;

    const stopped = transport.settle('run_1', lease, settle);
    transport.stop('shutdown');
    await expect(stopped).rejects.toThrow('shutdown');
    vi.useRealTimers();
  });
});
