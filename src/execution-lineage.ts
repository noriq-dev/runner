import { ExecutionAssignment } from '@noriq-dev/shared';
import type { ExecutionAssignment as ExecutionAssignmentValue, Run } from '@noriq-dev/shared';

/** The daemon's local view of a dispatch's lineage. Older servers deliberately have no assignment. */
export type RunLineage =
  | { type: 'assigned'; assignment: ExecutionAssignmentValue }
  | { type: 'legacy-root'; assignment: null };

export type RunLineageResolution = { ok: true; lineage: RunLineage } | { ok: false; reason: string };

/** A live binding prevents two concurrent Runs from claiming one server execution identity. */
export type ExecutionRunRegistry = ReadonlyMap<string, string>;

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
