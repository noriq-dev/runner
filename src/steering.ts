import type { DriverSession } from './drivers/types';
import { logger as defaultLogger } from './logger';

// The steering bridge: delivers a Noriq steer (arriving over /ws/runner) onto a
// running agent's live-input channel. Because the daemon owns the process + the
// streaming input, a soft steer queues a user turn at the next boundary and a
// hard steer interrupts the current inference then injects — reaching even a
// thinking, non-tool-calling agent, the case stateless MCP push cannot serve.

export type SteerMode = 'soft' | 'hard';
export type SteerDelivery = 'runtime' | 'fallback' | 'dropped';

export interface Steer {
  runId: string;
  steerId: string;
  mode: SteerMode;
  body: string;
  sourceCommentId?: string | null;
  sourceMessageId?: string | null;
  noticeCursor?: number | null;
}

export interface SteerResult {
  steerId: string;
  runId: string;
  delivered: boolean;
  via: SteerDelivery;
  noticeCursor: number | null;
  detail: string | null;
}

/**
 * Canonical mapping from a Noriq comment/event kind to a steer mode — the source
 * of the `mode` carried on the wire. Priority bumps and scope redirects hard-
 * interrupt (stop + re-plan); instructions, messages, and questions queue softly.
 */
export function steerModeForKind(kind: string): SteerMode {
  return kind === 'priority' || kind === 'scope_redirect' || kind === 'redirect' ? 'hard' : 'soft';
}

interface SteerTarget {
  session: DriverSession;
  /** Stop the whole budgeted run (clears the deadline timer + SIGTERMs). */
  stop: () => Promise<void>;
}

export class SteeringBridge {
  private readonly targets = new Map<string, SteerTarget>();
  private readonly log: typeof defaultLogger;

  constructor(deps: { logger?: typeof defaultLogger } = {}) {
    this.log = deps.logger ?? defaultLogger;
  }

  /** A run's live session becomes steerable when it starts. `stop` tears the whole
   *  run down (used by cancel); `session` carries the steer injection. */
  register(runId: string, session: DriverSession, stop: () => Promise<void>): void {
    this.targets.set(runId, { session, stop });
  }

  /** …and stops being steerable when it ends. */
  unregister(runId: string): void {
    this.targets.delete(runId);
  }

  hasRun(runId: string): boolean {
    return this.targets.has(runId);
  }

  /**
   * SIGTERM every live session — daemon shutdown. Returns the runIds it stopped.
   *
   * A spawned `claude`/`codex` is NOT in the daemon's process-teardown path: exiting
   * without this orphans them. They keep editing the worktree and spending real money,
   * and the only thing that would have stopped them — the budget enforcer's deadline and
   * telemetry checks — died with the daemon.
   */
  async stopAll(): Promise<string[]> {
    const ids = [...this.targets.keys()];
    await Promise.all(
      ids.map(async (runId) => {
        const target = this.targets.get(runId);
        this.targets.delete(runId);
        try {
          await target?.stop();
        } catch (err) {
          this.log.warn('failed to stop a run during shutdown', { runId, err: String(err) });
        }
      }),
    );
    return ids;
  }

  /** run.cancel/stop (RUN-18): hard-interrupt the current inference, then SIGTERM
   *  the process — the supervisor's teardown removes the worktree. */
  async cancelRun(runId: string): Promise<boolean> {
    const target = this.targets.get(runId);
    if (!target) return false;
    try {
      await target.session.interrupt();
    } catch (err) {
      this.log.warn('cancel interrupt failed', { runId, err: String(err) });
    }
    await target.stop();
    this.log.info('run cancelled — SIGTERM + teardown', { runId });
    return true;
  }

  /**
   * Apply a steer to its run's live process. Soft → queue a user turn; hard →
   * interrupt the current inference, then inject the redirect. Returns a delivery
   * result the caller acks back to Noriq (dedup / notices fallback: RUN-17).
   */
  async applySteer(steer: Steer): Promise<SteerResult> {
    const base = { steerId: steer.steerId, runId: steer.runId, noticeCursor: steer.noticeCursor ?? null };
    const target = this.targets.get(steer.runId);
    if (!target) {
      // No live process → can't inject; the MCP notices block is the fallback.
      return { ...base, delivered: false, via: 'dropped', detail: 'no live run for steer' };
    }
    try {
      if (steer.mode === 'hard') await target.session.interrupt();
      // pushInput reports FALSE when the session's input already closed — the agent
      // finished while this steer was in flight. That push is a silent no-op, so claiming
      // via:'runtime' would suppress the notices fallback (the documented dedup guard) and
      // the steer would reach nobody while the human watched it get acked as delivered.
      const delivered = target.session.pushInput(steer.body);
      if (!delivered) {
        this.log.warn('steer arrived after the session closed — leaving it to the notices fallback', {
          runId: steer.runId,
          mode: steer.mode,
        });
        return { ...base, delivered: false, via: 'dropped', detail: 'session input closed' };
      }
      this.log.info('steer delivered', { runId: steer.runId, mode: steer.mode });
      return { ...base, delivered: true, via: 'runtime', detail: null };
    } catch (err) {
      this.log.warn('steer delivery failed', { runId: steer.runId, err: String(err) });
      return { ...base, delivered: false, via: 'fallback', detail: (err as Error).message };
    }
  }
}
