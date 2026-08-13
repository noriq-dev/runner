import type {
  MissionHandoffAck,
  MissionHandoffPublication,
  MissionLeaseRef,
  MissionQuestionAck,
  MissionQuestionPublication,
  MissionTaskAck,
  MissionTaskBeginReport,
  MissionTaskSettleReport,
} from '@noriq-dev/shared';
import type { NoriqMissionCoordinatorTransport } from './noriq-coordinator';

export const DEFAULT_NORIQ_MISSION_ACK_TIMEOUT_MS = 15_000;

interface PendingAck {
  attemptId: string;
  phase: MissionTaskAck['phase'];
  resolve(ack: MissionTaskAck): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingQuestionAck {
  rootRunId: string;
  lease: MissionLeaseRef;
  questionId: string;
  attemptId: string | null;
  resolve(ack: MissionQuestionAck): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingHandoffAck {
  handoffId: string;
  resolve(ack: MissionHandoffAck): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface WsMissionTransportOptions {
  sendBegin(rootRunId: string, lease: MissionLeaseRef, report: MissionTaskBeginReport): boolean;
  sendSettle(rootRunId: string, lease: MissionLeaseRef, report: MissionTaskSettleReport): boolean;
  sendQuestion?(rootRunId: string, lease: MissionLeaseRef, question: MissionQuestionPublication): boolean;
  sendHandoff?(rootRunId: string, lease: MissionLeaseRef, publication: MissionHandoffPublication): boolean;
  timeoutMs?: number;
}

/**
 * Correlates durable coordinator reports with Noriq acknowledgements. The coordinator persists a
 * report before invoking this transport, so disconnect and timeout are retryable: no new report
 * identity is minted and a later control pass resends the exact same report.
 */
export class WsMissionCoordinatorTransport implements NoriqMissionCoordinatorTransport {
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingAck>();
  private readonly pendingQuestions = new Map<string, PendingQuestionAck>();
  private readonly pendingHandoffs = new Map<string, PendingHandoffAck>();

  constructor(private readonly options: WsMissionTransportOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_NORIQ_MISSION_ACK_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError('mission acknowledgement timeout must be positive');
    }
  }

  begin(rootRunId: string, lease: MissionLeaseRef, report: MissionTaskBeginReport): Promise<MissionTaskAck> {
    return this.sendAndWait(report.reportId, report.attemptId, 'begin', () =>
      this.options.sendBegin(rootRunId, lease, report),
    );
  }

  settle(
    rootRunId: string,
    lease: MissionLeaseRef,
    report: MissionTaskSettleReport,
  ): Promise<MissionTaskAck> {
    return this.sendAndWait(report.reportId, report.attemptId, 'settle', () =>
      this.options.sendSettle(rootRunId, lease, report),
    );
  }

  question(
    rootRunId: string,
    lease: MissionLeaseRef,
    question: MissionQuestionPublication,
  ): Promise<MissionQuestionAck> {
    if (this.pendingQuestions.has(question.reportId)) {
      return Promise.reject(
        new Error(`mission question '${question.reportId}' already awaits acknowledgement`),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = this.timeout('question', question.reportId, this.pendingQuestions, reject);
      this.pendingQuestions.set(question.reportId, {
        rootRunId,
        lease,
        questionId: question.questionId,
        attemptId: question.attemptId,
        resolve,
        reject,
        timer,
      });
      if (!this.options.sendQuestion?.(rootRunId, lease, question)) {
        this.rejectPending(this.pendingQuestions, question.reportId, timer);
        reject(new Error(`mission question '${question.reportId}' could not reach the live socket`));
      }
    });
  }

  handoff(
    rootRunId: string,
    lease: MissionLeaseRef,
    publication: MissionHandoffPublication,
  ): Promise<MissionHandoffAck> {
    if (this.pendingHandoffs.has(publication.reportId)) {
      return Promise.reject(
        new Error(`mission handoff '${publication.reportId}' already awaits acknowledgement`),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = this.timeout('handoff', publication.reportId, this.pendingHandoffs, reject);
      this.pendingHandoffs.set(publication.reportId, {
        handoffId: publication.handoff.handoffId,
        resolve,
        reject,
        timer,
      });
      if (!this.options.sendHandoff?.(rootRunId, lease, publication)) {
        this.rejectPending(this.pendingHandoffs, publication.reportId, timer);
        reject(new Error(`mission handoff '${publication.reportId}' could not reach the live socket`));
      }
    });
  }

  /** Deliver one exact acknowledgement. Unknown/late frames are harmless and return false. */
  acknowledge(ack: MissionTaskAck): boolean {
    const pending = this.pending.get(ack.reportId);
    if (!pending) return false;
    if (ack.attemptId !== pending.attemptId || ack.phase !== pending.phase) return false;
    this.pending.delete(ack.reportId);
    clearTimeout(pending.timer);
    pending.resolve(ack);
    return true;
  }

  acknowledgeQuestion(rootRunId: string, lease: MissionLeaseRef, ack: MissionQuestionAck): boolean {
    const pending = this.pendingQuestions.get(ack.reportId);
    if (
      !pending ||
      pending.rootRunId !== rootRunId ||
      JSON.stringify(pending.lease) !== JSON.stringify(lease) ||
      ack.questionId !== pending.questionId ||
      ack.attemptId !== pending.attemptId
    )
      return false;
    this.pendingQuestions.delete(ack.reportId);
    clearTimeout(pending.timer);
    pending.resolve(ack);
    return true;
  }

  acknowledgeHandoff(ack: MissionHandoffAck): boolean {
    const pending = this.pendingHandoffs.get(ack.reportId);
    if (
      !pending ||
      (ack.accepted
        ? ack.handoffId !== pending.handoffId
        : ack.handoffId !== null && ack.handoffId !== pending.handoffId)
    )
      return false;
    this.pendingHandoffs.delete(ack.reportId);
    clearTimeout(pending.timer);
    pending.resolve(ack);
    return true;
  }

  /** Reject every in-memory waiter on shutdown; durable reports remain available for retry. */
  stop(reason = 'mission transport stopped'): void {
    for (const [reportId, pending] of this.pending) {
      this.pending.delete(reportId);
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    for (const pendingMap of [this.pendingQuestions, this.pendingHandoffs] as const) {
      for (const [reportId, pending] of pendingMap) {
        pendingMap.delete(reportId);
        clearTimeout(pending.timer);
        pending.reject(new Error(reason));
      }
    }
  }

  private timeout<T extends { timer: ReturnType<typeof setTimeout> }>(
    kind: string,
    reportId: string,
    pending: Map<string, T>,
    reject: (error: Error) => void,
  ): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      pending.delete(reportId);
      reject(new Error(`mission ${kind} acknowledgement timed out for '${reportId}'`));
    }, this.timeoutMs);
    timer.unref?.();
    return timer;
  }

  private rejectPending<T>(
    pending: Map<string, T>,
    reportId: string,
    timer: ReturnType<typeof setTimeout>,
  ): void {
    pending.delete(reportId);
    clearTimeout(timer);
  }

  private sendAndWait(
    reportId: string,
    attemptId: string,
    phase: MissionTaskAck['phase'],
    send: () => boolean,
  ): Promise<MissionTaskAck> {
    if (this.pending.has(reportId)) {
      return Promise.reject(new Error(`mission report '${reportId}' already awaits acknowledgement`));
    }
    return new Promise<MissionTaskAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reportId);
        reject(new Error(`mission ${phase} acknowledgement timed out for '${reportId}'`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(reportId, { attemptId, phase, resolve, reject, timer });
      if (!send()) {
        this.pending.delete(reportId);
        clearTimeout(timer);
        reject(new Error(`mission ${phase} report '${reportId}' could not reach the live socket`));
      }
    });
  }
}
