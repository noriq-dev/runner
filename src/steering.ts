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

/** `SteerResult` plus the one fact its own return omits — what kind of steer this was (RUN-225).
 *  The DELIVERY outcome is the observation, not the arrival: a steer that reached zero sessions is
 *  distinguishable from one `pushInput` accepted, which `SteerResult.delivered` already carries —
 *  this just keeps `mode` alongside it for the episode text (`episode.ts`'s formatter), since a
 *  dropped `hard` (a re-scope nobody saw) and a dropped `soft` (a nudge nobody saw) read
 *  differently to a human. */
export interface DeliveredSteer extends SteerResult {
  mode: SteerMode;
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

/** How long a cancel or hard steer waits for a session's polite `interrupt()` before moving on.
 *  The interrupt is a courtesy to the driver (finish the token, flush state); the SIGTERM behind
 *  a cancel is the enforcement, and a driver that never acknowledges must not stand between the
 *  run and it — nor, on a decomposed run, between the operator and the run's OTHER sessions
 *  (RUN-170). */
const INTERRUPT_GRACE_MS = 5_000;

/** A resolve-only timer that must never be the reason the daemon outlives its work — the budget
 *  layer's own unref rule, guarded the same way because a fake clock need not implement it. */
const grace = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });

export class SteeringBridge {
  /**
   * runId → session key → target. Two levels because a decomposed run's wave holds several live
   * sessions at once (RUN-170), and a single runId-keyed map made the second registration clobber
   * the first: its unregister then dropped the survivor's entry, leaving a live, spending session
   * that no cancel could reach. The session key is the run's tally slot (`step:<id>`; `primary`
   * for an undecomposed run) — the same "the two halves have to agree" convention as the tally,
   * already unique per concurrent session for the tally's own last-writer-wins reason.
   */
  private readonly targets = new Map<string, Map<string, SteerTarget>>();
  /**
   * Runs an operator has cancelled (RUN-165).
   *
   * Cancelling used to mean only "stop whatever session is registered right now", and a pipeline
   * is many sessions with gaps between them. A cancel landing during a planner, a plan checker or
   * a pattern mapper stopped that one actor — and every one of those stages is deliberately
   * non-fatal, so the pipeline read the dead session as "this stage produced nothing" and started
   * the build. A cancel landing BETWEEN stages found nothing registered at all and answered false.
   *
   * So the fact has to outlive the session. This set is the fact; `isCancelled` is how the stage
   * machine asks, and `RUN_STAGES` is where the check belongs rather than in each new stage's
   * memory.
   *
   * Bounded by `forget`, called when a run reaches a terminal — otherwise a long-lived daemon
   * accumulates one entry per cancelled run forever.
   */
  private readonly cancelled = new Set<string>();
  /**
   * Every `applySteer` outcome this run has produced, since its last drain (RUN-225) — the
   * daemon's own observation of DELIVERY, not the server's independent `steers` table read. Kept
   * here rather than on `RunPipeline`: a steer can land during `execute`, before the pipeline
   * object exists at all (`afterDriver` builds it only once the driver stops talking), and this
   * bridge is the one thing already alive for the whole sitting AND reachable from both the
   * ws-client's steer handler (outside the supervisor entirely) and `settle` (through `StageHost`).
   * Drained by `steeringHistory`, not merely read, for the same reason `cancelled` is dropped by
   * `forget`: a long-lived daemon must not accumulate one entry per run forever.
   */
  private readonly delivered = new Map<string, DeliveredSteer[]>();
  private readonly log: typeof defaultLogger;
  private readonly interruptGraceMs: number;

  constructor(deps: { logger?: typeof defaultLogger; interruptGraceMs?: number } = {}) {
    this.log = deps.logger ?? defaultLogger;
    this.interruptGraceMs = deps.interruptGraceMs ?? INTERRUPT_GRACE_MS;
  }

  /** A run's live session becomes steerable when it starts. `stop` tears that session down (used
   *  by cancel); `session` carries the steer injection. `key` names WHICH of the run's sessions
   *  this is — omitted by every single-session caller, passed as the tally slot by a chain whose
   *  wave runs steps concurrently (RUN-170). */
  register(runId: string, session: DriverSession, stop: () => Promise<void>, key = 'primary'): void {
    let sessions = this.targets.get(runId);
    if (!sessions) {
      sessions = new Map();
      this.targets.set(runId, sessions);
    }
    sessions.set(key, { session, stop });
  }

  /** …and stops being steerable when it ends. Removes only its OWN entry: a step session's
   *  cleanup must not deafen its still-running siblings (RUN-170). */
  unregister(runId: string, key = 'primary'): void {
    const sessions = this.targets.get(runId);
    if (!sessions) return;
    sessions.delete(key);
    if (sessions.size === 0) this.targets.delete(runId);
  }

  hasRun(runId: string): boolean {
    return (this.targets.get(runId)?.size ?? 0) > 0;
  }

  /**
   * Live sessions registered right now, minus `excludeRunId`'s own (RUN-170). The bridge is the
   * one place every session — primary, reviewer, planner, wave child — already announces itself,
   * so it is where the daemon's capacity questions get an honest answer: the wave limit subtracts
   * what the REST of the machine is running, and the heartbeat's free-slot count must see a
   * wave's children as occupied capacity. Counting active RUNS undercounts both — a run's wave is
   * several processes the run count reads as one.
   */
  liveSessionCount(excludeRunId?: string): number {
    let n = 0;
    for (const [runId, sessions] of this.targets) {
      if (runId !== excludeRunId) n += sessions.size;
    }
    return n;
  }

  /** ONE run's live sessions — the per-run half of the same capacity question, for the daemon's
   *  reservation ledger (RUN-170): a run's claim on the machine is the busiest of its grant, its
   *  live sessions, and its seat, and this is the middle measure. */
  liveSessionsOf(runId: string): number {
    return this.targets.get(runId)?.size ?? 0;
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
    const stops: Promise<void>[] = [];
    for (const runId of ids) {
      // Snapshot before stopping: a stopped session's own cleanup unregisters it, and mutating
      // the live map mid-iteration is how a sibling gets skipped.
      const sessions = [...(this.targets.get(runId)?.values() ?? [])];
      this.targets.delete(runId);
      for (const target of sessions) {
        stops.push(
          (async () => {
            try {
              await target.stop();
            } catch (err) {
              this.log.warn('failed to stop a run during shutdown', { runId, err: String(err) });
            }
          })(),
        );
      }
    }
    await Promise.all(stops);
    return ids;
  }

  /** run.cancel/stop (RUN-18): hard-interrupt the current inference, then SIGTERM
   *  the process — the supervisor's teardown removes the worktree. A decomposed run's
   *  wave is several sessions; a cancel is a fact about the RUN, so EVERY one of them
   *  is stopped (RUN-170) — one refusing must not strand the rest, same as stopAll. */
  async cancelRun(runId: string): Promise<boolean> {
    // Recorded FIRST, and recorded whether or not anything is running. A cancel that arrives
    // between two stages has nothing to stop and is still a cancel — answering false and letting
    // the next stage spawn is how an operator pays for a run they ended.
    this.cancelled.add(runId);
    const sessions = [...(this.targets.get(runId)?.values() ?? [])];
    if (sessions.length === 0) {
      this.log.info('run cancelled with no live session — the pipeline stops at its next stage', { runId });
      return true;
    }
    // CONCURRENT fan-out with a BOUNDED courtesy. This loop used to await each session's
    // unbounded interrupt() in turn, so one hung driver stood between the run and its own
    // SIGTERM — and between the cancel and every later sibling. Each session now races its
    // interrupt against the grace and takes its stop regardless, and no session waits on
    // another's: the guarantee is the SIGTERM, not the driver's cooperation.
    await Promise.all(
      sessions.map(async (target) => {
        await Promise.race([
          Promise.resolve()
            .then(() => target.session.interrupt())
            .catch((err) => {
              this.log.warn('cancel interrupt failed', { runId, err: String(err) });
            }),
          grace(this.interruptGraceMs),
        ]);
        try {
          await target.stop();
        } catch (err) {
          this.log.warn('cancel stop failed — the run’s other sessions stop regardless', {
            runId,
            err: String(err),
          });
        }
      }),
    );
    this.log.info('run cancelled — SIGTERM + teardown', { runId, sessions: sessions.length });
    return true;
  }

  /** Has this run been cancelled? Asked at every stage boundary — a cancel is a fact about the
   *  RUN, not about whichever session happened to be live when it arrived. */
  isCancelled(runId: string): boolean {
    return this.cancelled.has(runId);
  }

  /** Drop a run's cancellation record once it is terminal. Without this a long-lived daemon keeps
   *  one entry per cancelled run for its whole life. */
  forget(runId: string): void {
    this.cancelled.delete(runId);
  }

  /**
   * Apply a steer to its run's live process. Soft → queue a user turn; hard →
   * interrupt the current inference, then inject the redirect. Returns a delivery
   * result the caller acks back to Noriq (dedup / notices fallback: RUN-17).
   */
  async applySteer(steer: Steer): Promise<SteerResult> {
    // Recorded through every exit of this method (RUN-225) — `record` wraps the return value
    // rather than each `return` site duplicating the push, so a future exit path cannot forget it.
    const record = (r: SteerResult): SteerResult => {
      const history = this.delivered.get(steer.runId) ?? [];
      history.push({ ...r, mode: steer.mode });
      this.delivered.set(steer.runId, history);
      return r;
    };
    const base = { steerId: steer.steerId, runId: steer.runId, noticeCursor: steer.noticeCursor ?? null };
    const sessions = [...(this.targets.get(steer.runId)?.values() ?? [])];
    if (sessions.length === 0) {
      // No live process → can't inject; the MCP notices block is the fallback.
      return record({ ...base, delivered: false, via: 'dropped', detail: 'no live run for steer' });
    }
    // A steer names the RUN, and the wire carries no session address — so on a decomposed run
    // whose wave holds several live sessions (RUN-170) it is delivered to every one of them.
    // The order of harms: a session hearing a redirect it did not need costs a paragraph of
    // context; the one session it was about NOT hearing it loses the steer. Delivery is claimed
    // when ANY session accepted — the notices fallback exists for the reached-nobody case.
    let delivered = 0;
    const errs: Error[] = [];
    // Concurrent per-session, with the hard half's interrupt bounded — cancelRun's rule, for the
    // same reason: one hung driver must not cost the run's OTHER sessions their steer. On a
    // timeout the injection is still attempted; the session hears it at its next boundary.
    await Promise.all(
      sessions.map(async (target) => {
        try {
          if (steer.mode === 'hard') {
            await Promise.race([
              Promise.resolve().then(() => target.session.interrupt()),
              grace(this.interruptGraceMs),
            ]);
          }
          // pushInput reports FALSE when the session's input already closed — the agent
          // finished while this steer was in flight. That push is a silent no-op, so claiming
          // via:'runtime' for it would suppress the notices fallback (the documented dedup guard)
          // and the steer would reach nobody while the human watched it get acked as delivered.
          if (target.session.pushInput(steer.body)) delivered += 1;
        } catch (err) {
          errs.push(err as Error);
          this.log.warn('steer delivery failed', { runId: steer.runId, err: String(err) });
        }
      }),
    );
    if (delivered > 0) {
      this.log.info('steer delivered', { runId: steer.runId, mode: steer.mode, sessions: delivered });
      return record({ ...base, delivered: true, via: 'runtime', detail: null });
    }
    if (errs.length > 0) {
      return record({ ...base, delivered: false, via: 'fallback', detail: errs[0]!.message });
    }
    this.log.warn('steer arrived after the session closed — leaving it to the notices fallback', {
      runId: steer.runId,
      mode: steer.mode,
    });
    return record({ ...base, delivered: false, via: 'dropped', detail: 'session input closed' });
  }

  /**
   * Drain this run's delivery observations (RUN-225) — called once, from `settle`, so the daemon
   * never accumulates history for a run that already reported. A run whose sitting saw no steers
   * gets `[]`, indistinguishable from "no steering bridge wired at all" — both are the honest
   * "nothing observed" answer `episode.ts` records as an empty `steeringEvents`.
   */
  steeringHistory(runId: string): DeliveredSteer[] {
    const history = this.delivered.get(runId) ?? [];
    this.delivered.delete(runId);
    return history;
  }
}
