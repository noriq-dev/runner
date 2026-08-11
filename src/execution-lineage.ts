import { ExecutionAssignment } from '@noriq-dev/shared';
import type { ExecutionAssignment as ExecutionAssignmentValue, Run } from '@noriq-dev/shared';

/** The daemon's local view of a dispatch's lineage. Older servers deliberately have no assignment. */
export type RunLineage =
  | { type: 'assigned'; assignment: ExecutionAssignmentValue }
  | { type: 'legacy-root'; assignment: null };

export type RunLineageResolution = { ok: true; lineage: RunLineage } | { ok: false; reason: string };

/** A live binding prevents two concurrent Runs from claiming one server execution identity. */
export type ExecutionRunRegistry = ReadonlyMap<string, string>;

/** The small persisted shape the lifecycle owner needs; the full park stays owned by `parked.ts`. */
export interface ParkedExecution {
  readonly run: Pick<Run, 'id' | 'execution'>;
}

/** The server's durable answer about a park reconstructed after this process restarted. */
export type RecoveredParkDisposition = 'parked' | 'terminal' | 'unknown';

type ExecutionState<Park extends ParkedExecution> =
  | { readonly kind: 'active'; readonly run: Pick<Run, 'id' | 'execution'>; readonly park: Park | null }
  | { readonly kind: 'parked'; readonly park: Park }
  | { readonly kind: 'resuming'; readonly park: Park }
  | { readonly kind: 'terminal'; readonly park: Park | null; readonly active: boolean };

/**
 * The source of truth for local execution ownership (RUN-265).
 *
 * Each run occupies exactly one explicit state. `active` may retain a durable park while a stage
 * waits, `resuming` keeps ownership while disk deletion yields, and `terminal` suppresses a park
 * until physical cleanup succeeds. The registry is therefore a synchronous projection of one
 * state map rather than a join across independently sampled active and durable stores.
 */
export class ExecutionLifecycle<Park extends ParkedExecution> {
  private readonly states = new Map<string, ExecutionState<Park>>();

  constructor(
    private readonly parked?: {
      park(entry: Park): Promise<void>;
      list(): Promise<Park[]>;
      unpark(runId: string): Promise<Park | null>;
    },
    private readonly onCleanupError?: (runId: string, err: unknown) => void,
  ) {}

  /** Per-run ordering makes a terminal signal win over a park that was still being prepared. */
  private readonly transitions = new Map<string, Promise<unknown>>();
  private serialize<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const prior = this.transitions.get(runId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(work);
    this.transitions.set(runId, next);
    void next
      .finally(() => {
        if (this.transitions.get(runId) === next) this.transitions.delete(runId);
      })
      // `next` still carries the write error to its caller; this side branch only tidies the queue.
      .catch(() => undefined);
    return next;
  }

  private reportCleanupError(runId: string, err: unknown): void {
    try {
      this.onCleanupError?.(runId, err);
    } catch {
      // Cleanup reporting is diagnostic. It must not turn a swallowed disk failure into an
      // unhandled rejection after the run's real terminal outcome has already been returned.
    }
  }

  begin(run: Pick<Run, 'id' | 'execution'>): void {
    const current = this.states.get(run.id);
    // Run ids are server identities and are not re-used. Retaining a terminal state that still
    // covers a durable record is the fail-closed answer if an invalid duplicate nevertheless lands.
    if (current?.kind === 'terminal' && current.park) return;
    this.states.set(run.id, { kind: 'active', run, park: null });
  }

  /** A successful park leaves durable ownership behind but no longer has an active supervisor. */
  inactive(runId: string): void {
    const current = this.states.get(runId);
    if (current?.kind !== 'active') return;
    if (current.park) this.states.set(runId, { kind: 'parked', park: current.park });
    else this.states.delete(runId);
  }

  /** The supervising stack reached a terminal outcome (including a thrown one). */
  async complete(runId: string): Promise<void> {
    // Mark first so a concurrent cancellation or late park cannot revive the owner, then JOIN the
    // durable deletion. A terminal Run must not report completion while an old park can recreate
    // its execution reservation after restart (RUN-265).
    const current = this.states.get(runId);
    const park =
      current?.kind === 'active' || current?.kind === 'terminal'
        ? current.park
        : current?.kind === 'parked' || current?.kind === 'resuming'
          ? current.park
          : null;
    this.states.set(runId, { kind: 'terminal', park, active: false });
    try {
      await this.removeTerminalPark(runId);
    } catch (err) {
      // A failed disk write cannot safely release the tombstone. Report it, but preserve the run's
      // real terminal result: recovery will classify the durable record again before admission.
      this.reportCleanupError(runId, err);
    }
  }

  /** Park creation belongs here so cancellation cannot race a post-probe direct store write. */
  async park(entry: Park): Promise<boolean> {
    return this.serialize(entry.run.id, async () => {
      if (this.states.get(entry.run.id)?.kind === 'terminal') return false;
      await this.parked?.park(entry);
      const current = this.states.get(entry.run.id);
      if (current?.kind === 'terminal') {
        // Terminality can arrive while the disk write yields. Preserve the just-written record so
        // the queued cleanup removes it, and tell the caller it did not successfully park.
        this.states.set(entry.run.id, { kind: 'terminal', park: entry, active: current.active });
        return false;
      }
      if (current?.kind === 'active') {
        this.states.set(entry.run.id, { kind: 'active', run: current.run, park: entry });
      } else {
        this.states.set(entry.run.id, { kind: 'parked', park: entry });
      }
      return true;
    });
  }

  /** One atomic in-process snapshot; startup hydration and every transition maintain both halves. */
  registry(): ExecutionRunRegistry {
    const registry = new Map<string, string>();
    const bind = (run: Pick<Run, 'id' | 'execution'>) => {
      const assignment = ExecutionAssignment.safeParse(run.execution);
      if (!assignment.success) return;
      const prior = registry.get(assignment.data.executionId);
      // Preserve a collision as a value no real run id can equal. Returning either owner would let
      // that owner re-enter while the other persisted claimant was silently ignored.
      registry.set(
        assignment.data.executionId,
        prior && prior !== run.id ? '<multiple-local-runs>' : (prior ?? run.id),
      );
    };

    for (const state of this.states.values()) {
      if (state.kind === 'active') bind(state.run);
      else if (state.kind === 'parked' || state.kind === 'resuming') bind(state.park.run);
    }
    return registry;
  }

  /** Read the parked record and atomically make its run active again before a resume can spawn. */
  async resume(runId: string): Promise<Park | null> {
    return this.serialize(runId, async () => {
      const current = this.states.get(runId);
      if (current?.kind !== 'parked') return null;
      const known = current.park;
      // Claim active ownership BEFORE the durable delete yields. A registry snapshot overlapping
      // this move therefore projects the resuming state, never neither representation.
      this.states.set(runId, { kind: 'resuming', park: known });
      try {
        const park = await this.parked?.unpark(runId);
        if (!park) {
          if (this.states.get(runId)?.kind !== 'terminal') this.states.delete(runId);
          return null;
        }
        if (this.states.get(runId)?.kind === 'terminal') {
          // Cancellation won while deletion was in flight. The durable record is gone, and the
          // queued terminal cleanup will release the in-memory tombstone without spawning.
          const terminal = this.states.get(runId);
          this.states.set(runId, {
            kind: 'terminal',
            park: null,
            active: terminal?.kind === 'terminal' ? terminal.active : true,
          });
          return null;
        }
        this.states.set(runId, { kind: 'active', run: park.run, park: null });
        return park;
      } catch (err) {
        if (this.states.get(runId)?.kind === 'terminal') {
          const terminal = this.states.get(runId);
          this.states.set(runId, {
            kind: 'terminal',
            park: known,
            active: terminal?.kind === 'terminal' ? terminal.active : true,
          });
        } else {
          this.states.set(runId, { kind: 'parked', park: known });
        }
        throw err;
      }
    });
  }

  /** A non-terminal stage answer consumes its record while its supervising stack remains active. */
  async unpark(runId: string): Promise<Park | null> {
    return this.serialize(runId, async () => {
      const park = (await this.parked?.unpark(runId)) ?? null;
      const current = this.states.get(runId);
      if (current?.kind === 'active') {
        this.states.set(runId, { kind: 'active', run: current.run, park: null });
      } else if (current?.kind === 'parked' || current?.kind === 'resuming') {
        this.states.delete(runId);
      } else if (current?.kind === 'terminal') {
        this.states.set(runId, { kind: 'terminal', park: null, active: current.active });
      }
      return park;
    });
  }

  /** A server-terminal fact blocks any late park and removes the durable half in one transition. */
  async terminalizePark(runId: string): Promise<Park | null> {
    const current = this.states.get(runId);
    const park =
      current?.kind === 'active' || current?.kind === 'terminal'
        ? current.park
        : current?.kind === 'parked' || current?.kind === 'resuming'
          ? current.park
          : null;
    // `resuming` has not spawned a replacement stack yet. If terminality wins while its delete
    // yields, resume returns null and nobody will later call complete(), so it is detached here.
    const active = current?.kind === 'active' ? true : current?.kind === 'terminal' ? current.active : false;
    this.states.set(runId, { kind: 'terminal', park, active });
    return this.removeTerminalPark(runId);
  }

  private removeTerminalPark(runId: string): Promise<Park | null> {
    return this.serialize(runId, async () => {
      const park = (await this.parked?.unpark(runId)) ?? null;
      // Delete only the terminal state this cleanup belongs to. A theoretically re-used run id
      // must not let an old background cleanup erase a newer active owner.
      const current = this.states.get(runId);
      if (current?.kind === 'terminal') {
        if (current.active) {
          this.states.set(runId, { kind: 'terminal', park: null, active: true });
        } else {
          this.states.delete(runId);
        }
      }
      return park;
    });
  }

  /** Hydrate before admission, then classify crash-recovered parks through the durable server fact. */
  async restore(classify?: (park: Park) => Promise<RecoveredParkDisposition>): Promise<void> {
    const parks = (await this.parked?.list()) ?? [];
    for (const park of parks) this.states.set(park.run.id, { kind: 'parked', park });
    if (!classify) return;

    await Promise.all(
      parks.map(async (park) => {
        const disposition = await classify(park).catch(() => 'unknown' as const);
        if (disposition !== 'terminal') return;
        this.states.set(park.run.id, { kind: 'terminal', park, active: false });
        // Recovery joins the same durable terminal transition as a live stack. A failed deletion
        // retains its tombstone and is retried from the server's terminal fact on the next boot.
        await this.complete(park.run.id);
      }),
    );
  }
}

/**
 * Validate the part of an execution assignment the Runner can know locally (RUN-265).
 *
 * Transport validation normally happens at the WebSocket boundary, but retaining the parse here
 * keeps direct callers fail-closed and makes the legacy null case explicit rather than accidental.
 */
export function resolveRunLineage(
  run: Pick<Run, 'id' | 'execution'>,
  registry: ExecutionRunRegistry,
): RunLineageResolution {
  if (run.execution == null) return { ok: true, lineage: { type: 'legacy-root', assignment: null } };

  const parsed = ExecutionAssignment.safeParse(run.execution);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `execution assignment is malformed: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    };
  }
  const assignment = parsed.data;
  if (assignment.parentExecutionId === assignment.executionId) {
    return { ok: false, reason: 'execution assignment names itself as its parent' };
  }
  const boundRunId = registry.get(assignment.executionId);
  if (boundRunId && boundRunId !== run.id) {
    return {
      ok: false,
      reason: `execution ${assignment.executionId} is already bound to live run ${boundRunId}`,
    };
  }
  return { ok: true, lineage: { type: 'assigned', assignment } };
}
