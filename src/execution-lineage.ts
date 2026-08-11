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

/**
 * The source of truth for local execution ownership (RUN-265).
 *
 * A binding is deliberately derived when it is consulted, from work this process is supervising
 * and from parks durable enough to survive the process. Keeping a second mutable binding map made
 * restart and cancellation correctness depend on every terminal call site remembering to update it.
 */
export class ExecutionLifecycle<Park extends ParkedExecution> {
  private readonly active = new Map<string, Pick<Run, 'id' | 'execution'>>();

  constructor(
    private readonly parked?: {
      park(entry: Park): Promise<void>;
      list(): Promise<Park[]>;
      unpark(runId: string): Promise<Park | null>;
    },
  ) {}

  /** Per-run ordering makes a terminal signal win over a park that was still being prepared. */
  private readonly transitions = new Map<string, Promise<unknown>>();
  private readonly terminal = new Set<string>();

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

  begin(run: Pick<Run, 'id' | 'execution'>): void {
    this.terminal.delete(run.id);
    this.active.set(run.id, run);
  }

  /** A successful park leaves durable ownership behind but no longer has an active supervisor. */
  inactive(runId: string): void {
    this.active.delete(runId);
  }

  /** The supervising stack reached a terminal outcome (including a thrown one). */
  complete(runId: string): void {
    // A terminal stack cannot create another park after it returns. Cancellation keeps its
    // tombstone only while an active stack could still finish an already-started park transition.
    this.terminal.delete(runId);
    this.inactive(runId);
  }

  /** Park creation belongs here so cancellation cannot race a post-probe direct store write. */
  async park(entry: Park): Promise<boolean> {
    return this.serialize(entry.run.id, async () => {
      if (this.terminal.has(entry.run.id)) return false;
      await this.parked?.park(entry);
      return true;
    });
  }

  /** Reads parks now rather than caching them: another daemon lifecycle may have removed one. */
  async registry(): Promise<ExecutionRunRegistry> {
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

    for (const run of this.active.values()) bind(run);
    // A terminal signal is authoritative immediately, even while its durable deletion waits for
    // the ordered transition. An active stack remains bound above until its own finally runs.
    for (const park of (await this.parked?.list()) ?? []) {
      if (!this.terminal.has(park.run.id)) bind(park.run);
    }
    return registry;
  }

  /** Read the parked record and atomically make its run active again before a resume can spawn. */
  async resume(runId: string): Promise<Park | null> {
    return this.serialize(runId, async () => {
      if (this.terminal.has(runId)) return null;
      const park = await this.parked?.unpark(runId);
      if (park) this.active.set(park.run.id, park.run);
      return park ?? null;
    });
  }

  /** A non-terminal stage answer consumes its record while its supervising stack remains active. */
  async unpark(runId: string): Promise<Park | null> {
    return this.serialize(runId, async () => (await this.parked?.unpark(runId)) ?? null);
  }

  /** A server-terminal fact blocks any late park and removes the durable half in one transition. */
  async terminalizePark(runId: string): Promise<Park | null> {
    this.terminal.add(runId);
    const park = await this.serialize(runId, async () => (await this.parked?.unpark(runId)) ?? null);
    // A directly cancelled persisted park has no supervising stack that will call `complete`.
    // Its tombstone has done its job once the ordered deletion finishes, so retaining it would
    // make daemon memory scale with historical cancellations rather than live lifecycle state.
    if (!this.active.has(runId)) this.terminal.delete(runId);
    return park;
  }

  /** Startup reads the durable half before the WebSocket can deliver a new assignment. */
  async restore(): Promise<void> {
    await this.registry();
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
