import type {
  MissionLeaseRef,
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

export interface WsMissionTransportOptions {
  sendBegin(rootRunId: string, lease: MissionLeaseRef, report: MissionTaskBeginReport): boolean;
  sendSettle(rootRunId: string, lease: MissionLeaseRef, report: MissionTaskSettleReport): boolean;
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

  /** Reject every in-memory waiter on shutdown; durable reports remain available for retry. */
  stop(reason = 'mission transport stopped'): void {
    for (const [reportId, pending] of this.pending) {
      this.pending.delete(reportId);
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
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
