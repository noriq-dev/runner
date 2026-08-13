import type { RunnerJobSource, RunnerTaskSnapshot } from "./contracts.js";

export interface ScheduleState {
  accepted: Set<string>;
  running: Set<string>;
  failed: Set<string>;
  stopScheduling: boolean;
}

export function orderedTasks(source: RunnerJobSource): RunnerTaskSnapshot[] {
  const tasks = source.kind === "task" ? [source.task] : source.tasks;
  return [...tasks].sort(
    (left, right) =>
      left.phaseOrder - right.phaseOrder ||
      left.order - right.order ||
      left.key.localeCompare(right.key),
  );
}

export function readyTasks(
  source: RunnerJobSource,
  state: ScheduleState,
  capacity: number,
): RunnerTaskSnapshot[] {
  if (state.stopScheduling || capacity <= 0) return [];
  const dependencies = new Map<string, string[]>();
  if (source.kind === "plan") {
    for (const edge of source.dependencies) {
      const existing = dependencies.get(edge.taskId) ?? [];
      existing.push(edge.dependsOnTaskId);
      dependencies.set(edge.taskId, existing);
    }
  }
  return orderedTasks(source)
    .filter(
      (task) =>
        !state.accepted.has(task.taskId) &&
        !state.running.has(task.taskId) &&
        !state.failed.has(task.taskId),
    )
    .filter((task) =>
      (dependencies.get(task.taskId) ?? []).every((id) =>
        state.accepted.has(id),
      ),
    )
    .slice(0, capacity);
}
