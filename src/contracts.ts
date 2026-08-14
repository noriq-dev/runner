import {
  type RunnerJobCheck as CheckResult,
  type RunnerJobFinding as Finding,
  hasExecutionSpec,
  type RunnerJobAssignment as JobAssignment,
  type RunnerJobAgentRoute,
  RunnerJobAssignment,
  RunnerJobCheck,
  type RunnerJobCostBasis,
  type RunnerJobDurationMetric,
  RunnerJobEvent,
  type RunnerJobEvent as RunnerJobEventPayload,
  RunnerJobFinding,
  type RunnerJobLanding as RunnerJobLandingType,
  type RunnerJobObservationActor,
  RunnerJobObservationEvidence,
  type RunnerJobObservationEvidence as RunnerJobObservationEvidenceType,
  type RunnerJobObservationStage,
  RunnerJobObservationUsage,
  type RunnerJobObservationUsage as RunnerJobObservationUsageType,
  RunnerJobOutput,
  type RunnerJobOutput as RunnerJobOutputType,
  RunnerJobPhase,
  type RunnerJobPhase as RunnerJobPhaseType,
  RunnerJobSource,
  type RunnerJobSource as RunnerJobSourceType,
  RunnerJobStatus,
  type RunnerJobStatus as RunnerJobStatusType,
  RunnerJobTaskResult,
  type RunnerJobTaskResult as RunnerJobTaskStatus,
  RunnerJobUsage,
  type RunnerJobTaskSnapshot as RunnerTaskSnapshot,
  type RunnerJobUsage as Usage,
} from "@noriq-dev/shared";

export const checkResultSchema = RunnerJobCheck;
export const runnerJobEventPayloadSchema = RunnerJobEvent;
export const findingSchema = RunnerJobFinding;
export const observationEvidenceSchema = RunnerJobObservationEvidence;
export const observationUsageSchema = RunnerJobObservationUsage;
export const runnerJobOutputSchema = RunnerJobOutput;
export const runnerJobPhaseSchema = RunnerJobPhase;
export const runnerJobSourceSchema = RunnerJobSource;
export const runnerJobStatusSchema = RunnerJobStatus;
export const taskResultStatusSchema = RunnerJobTaskResult;
export const usageSchema = RunnerJobUsage;
export const jobAssignmentSchema = RunnerJobAssignment;

export type {
  CheckResult,
  Finding,
  JobAssignment,
  RunnerJobAgentRoute,
  RunnerJobCostBasis,
  RunnerJobDurationMetric,
  RunnerJobEventPayload,
  RunnerJobLandingType as RunnerJobLanding,
  RunnerJobObservationActor,
  RunnerJobObservationEvidenceType as RunnerJobObservationEvidence,
  RunnerJobObservationStage,
  RunnerJobObservationUsageType as RunnerJobObservationUsage,
  RunnerJobOutputType as RunnerJobOutput,
  RunnerJobPhaseType as RunnerJobPhase,
  RunnerJobSourceType as RunnerJobSource,
  RunnerJobStatusType as RunnerJobStatus,
  RunnerJobTaskStatus,
  RunnerTaskSnapshot,
  Usage,
};
export { hasExecutionSpec };

export function assertAcyclicSource(source: RunnerJobSourceType): void {
  if (source.kind === "task") return;
  const ids = new Set(source.tasks.map((task) => task.taskId));
  const incoming = new Map([...ids].map((id) => [id, 0]));
  const children = new Map([...ids].map((id) => [id, [] as string[]]));
  for (const edge of source.dependencies) {
    if (
      !ids.has(edge.taskId) ||
      !ids.has(edge.dependsOnTaskId) ||
      edge.taskId === edge.dependsOnTaskId
    ) {
      throw new Error(
        `invalid dependency ${edge.taskId} -> ${edge.dependsOnTaskId}`,
      );
    }
    incoming.set(edge.taskId, (incoming.get(edge.taskId) ?? 0) + 1);
    children.get(edge.dependsOnTaskId)?.push(edge.taskId);
  }
  const ready = [...incoming]
    .filter(([, count]) => count === 0)
    .map(([id]) => id);
  let visited = 0;
  for (const id of ready) {
    visited += 1;
    for (const child of children.get(id) ?? []) {
      const count = (incoming.get(child) ?? 0) - 1;
      incoming.set(child, count);
      if (count === 0) ready.push(child);
    }
  }
  if (visited !== ids.size)
    throw new Error("plan task dependencies contain a cycle");
}
