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

  it('fences question acknowledgements by root and lease and correlates exact handoffs', async () => {
    const transport = new WsMissionCoordinatorTransport({
      sendBegin: () => true,
      sendSettle: () => true,
      sendQuestion: () => true,
      sendHandoff: () => true,
    });
    const question = {
      reportId: 'question_report',
      questionId: 'question_1',
      attemptId: 'attempt_1',
      prompt: 'Which option?',
      observedAt: '2026-08-13T00:02:00.000Z',
    };
    const pendingQuestion = transport.question('run_1', lease, question);
    const questionAck = {
      reportId: question.reportId,
      questionId: question.questionId,
      attemptId: question.attemptId,
      accepted: true,
      state: 'open' as const,
      signalId: 'signal_1',
      error: null,
    };
    expect(transport.acknowledgeQuestion('run_2', lease, questionAck)).toBe(false);
    expect(transport.acknowledgeQuestion('run_1', { ...lease, epoch: 3 }, questionAck)).toBe(false);
    expect(transport.acknowledgeQuestion('run_1', lease, questionAck)).toBe(true);
    await expect(pendingQuestion).resolves.toEqual(questionAck);

    const publication = {
      reportId: 'handoff_report',
      handoff: {
        schemaVersion: 1 as const,
        handoffId: 'handoff_1',
        backend: 'git',
        repositoryKey: 'repo-key',
        checkpoint: 'checkpoint_1',
        revision: 'revision_1',
        reference: 'refs/heads/noriq/run_1',
      },
    };
    const pendingHandoff = transport.handoff('run_1', lease, publication);
    expect(
      transport.acknowledgeHandoff({
        reportId: publication.reportId,
        accepted: true,
        handoffId: 'wrong',
        state: 'preserved_unlanded',
        preservedAt: '2026-08-13T00:03:00.000Z',
        consumedAt: null,
        consumptionId: null,
        error: null,
      }),
    ).toBe(false);
    const handoffAck = {
      reportId: publication.reportId,
      accepted: true,
      handoffId: publication.handoff.handoffId,
      state: 'preserved_unlanded' as const,
      preservedAt: '2026-08-13T00:03:00.000Z',
      consumedAt: null,
      consumptionId: null,
      error: null,
    };
    expect(transport.acknowledgeHandoff(handoffAck)).toBe(true);
    await expect(pendingHandoff).resolves.toEqual(handoffAck);
  });
});
