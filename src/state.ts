import type {
  CheckResult,
  Finding,
  JobAssignment,
  RunnerJobDurationMetric,
  RunnerJobEventPayload,
  RunnerJobLanding,
  RunnerJobObservationActor,
  RunnerJobObservationEvidence,
  RunnerJobObservationUsage,
  RunnerJobPhase,
  RunnerJobStatus,
  RunnerJobTaskStatus,
  Usage,
} from "./contracts.js";
import {
  addObservationUsage,
  aggregateUsageAsLegacy,
  notApplicableUsage,
} from "./intelligence.js";
import type { JournalRecord } from "./journal.js";
import type {
  JobWorkspace,
  RetainedLocation,
  SourceControlCheckpoint,
  TaskWorkspace,
} from "./vcs/types.js";

export interface InvocationState {
  id: string;
  taskId: string;
  role: "guide" | "builder" | "reviewer" | "repairer";
  status: "started" | "completed" | "abandoned";
  attempt?: number;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
  resultDigest?: string | undefined;
  usage?: Usage | undefined;
  usageEvidence?: RunnerJobObservationUsage | undefined;
  usageContributionRecorded?: boolean | undefined;
  duration?: RunnerJobDurationMetric | undefined;
  actor?: RunnerJobObservationActor | undefined;
  recovery?: "none" | "journal_replay" | "process_recovery" | undefined;
  evidence?: RunnerJobObservationEvidence | undefined;
  outcome?: "succeeded" | "failed" | "cancelled" | "skipped" | undefined;
}

export interface ObservationState {
  observationId: string;
  started: boolean;
  finished: boolean;
}

export interface TaskState {
  taskId: string;
  status: RunnerJobTaskStatus;
  repairRounds: number;
  plan?: string;
  workspace?: TaskWorkspace;
  candidate?: SourceControlCheckpoint;
  checkpoint?: SourceControlCheckpoint;
  findings: Finding[];
  checks: CheckResult[];
}

export interface LandingReport {
  status: "landed" | "failed";
  target: string;
  checkpoint: SourceControlCheckpoint | null;
  error: string | null;
}

export interface LandingRequestState {
  requestId: string;
  target: string;
  status: "requested" | "completed" | "acked";
  result?: LandingReport;
}

export interface JobState {
  assignment: JobAssignment | null;
  status: RunnerJobStatus;
  phase: RunnerJobPhase;
  cancelled: boolean;
  stopScheduling: boolean;
  workspace?: JobWorkspace;
  recoveryLocations: RetainedLocation[];
  tasks: Record<string, TaskState>;
  invocations: Record<string, InvocationState>;
  observations: Record<string, ObservationState>;
  contextPublished: boolean;
  completedActions: Record<string, unknown>;
  nextEventSeq: number;
  acknowledgedEventSeq: number;
  outboundEvents: Array<{ seq: number; payload: RunnerJobEventPayload }>;
  answers: Record<string, string>;
  questions: Record<string, string>;
  usage: Usage;
  observationUsage: RunnerJobObservationUsage;
  warnings: string[];
  automaticLanding?: RunnerJobLanding;
  landingRequests: Record<string, LandingRequestState>;
}

export function emptyJobState(): JobState {
  return {
    assignment: null,
    status: "queued",
    phase: "preparing",
    cancelled: false,
    stopScheduling: false,
    tasks: {},
    invocations: {},
    observations: {},
    contextPublished: false,
    completedActions: {},
    nextEventSeq: 1,
    acknowledgedEventSeq: 0,
    outboundEvents: [],
    answers: {},
    questions: {},
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: null,
      calls: 0,
    },
    observationUsage: notApplicableUsage(),
    warnings: [],
    recoveryLocations: [],
    landingRequests: {},
  };
}

function addUsage(left: Usage, right: Usage): Usage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cachedTokens: left.cachedTokens + right.cachedTokens,
    costUsd:
      left.costUsd === null || right.costUsd === null
        ? null
        : left.costUsd + right.costUsd,
    calls: left.calls + right.calls,
  };
}

export function reduceJobState(records: readonly JournalRecord[]): JobState {
  const state = emptyJobState();
  for (const record of records) {
    const payload = record.payload as Record<string, unknown>;
    switch (record.type) {
      case "job.assigned": {
        const assignment = payload.assignment as JobAssignment;
        state.assignment = assignment;
        state.status = "assigned";
        const tasks =
          assignment.source.kind === "task"
            ? [assignment.source.task]
            : assignment.source.tasks;
        for (const task of tasks) {
          state.tasks[task.taskId] = {
            taskId: task.taskId,
            status: "pending",
            repairRounds: 0,
            findings: [],
            checks: [],
          };
        }
        break;
      }
      case "job.started":
        state.status = "running";
        break;
      case "job.phase":
        state.phase = payload.phase as RunnerJobPhase;
        break;
      case "job.cancelled":
        state.cancelled = true;
        state.stopScheduling = true;
        break;
      case "job.terminal":
        state.status = payload.status as RunnerJobStatus;
        break;
      case "workspace.opened":
      case "workspace.updated":
        state.workspace = payload.workspace as unknown as JobWorkspace;
        break;
      case "task.started":
        state.tasks[payload.taskId as string]!.status = "running";
        break;
      case "task.plan":
        state.tasks[payload.taskId as string]!.plan = payload.plan as string;
        break;
      case "task.workspace": {
        const task = state.tasks[payload.taskId as string]!;
        task.workspace = payload.workspace as unknown as TaskWorkspace;
        if (payload.jobWorkspace)
          state.workspace = payload.jobWorkspace as unknown as JobWorkspace;
        break;
      }
      case "task.candidate": {
        const task = state.tasks[payload.taskId as string]!;
        task.candidate = payload.candidate as SourceControlCheckpoint;
        if (payload.workspace)
          task.workspace = payload.workspace as unknown as TaskWorkspace;
        break;
      }
      case "task.checked":
        state.tasks[payload.taskId as string]!.checks.push(
          ...(payload.checks as CheckResult[]),
        );
        break;
      case "task.reviewed":
        state.tasks[payload.taskId as string]!.findings =
          payload.findings as Finding[];
        break;
      case "task.repair":
        state.tasks[payload.taskId as string]!.repairRounds =
          payload.round as number;
        break;
      case "task.accepted": {
        const task = state.tasks[payload.taskId as string]!;
        task.status = "accepted";
        task.checkpoint = payload.checkpoint as SourceControlCheckpoint;
        if (payload.workspace)
          state.workspace = payload.workspace as unknown as JobWorkspace;
        else if (state.workspace)
          state.workspace.currentRevision = payload.currentRevision as string;
        break;
      }
      case "task.retained":
        state.recoveryLocations.push(payload.location as RetainedLocation);
        break;
      case "task.failed":
        state.tasks[payload.taskId as string]!.status = "failed";
        state.stopScheduling = true;
        break;
      case "task.cancelled":
        state.tasks[payload.taskId as string]!.status = "cancelled";
        break;
      case "invocation.started": {
        const invocation = payload as unknown as InvocationState;
        state.invocations[invocation.id] = invocation;
        break;
      }
      case "invocation.completed": {
        const invocation = state.invocations[payload.id as string];
        if (invocation) {
          invocation.status = "completed";
          if (payload.resultDigest !== undefined)
            invocation.resultDigest = payload.resultDigest as string;
          if (payload.completedAt !== undefined)
            invocation.completedAt = payload.completedAt as string;
          if (payload.usage !== undefined)
            invocation.usage = payload.usage as Usage;
          if (payload.usageEvidence !== undefined)
            invocation.usageEvidence =
              payload.usageEvidence as RunnerJobObservationUsage;
          if (payload.duration !== undefined)
            invocation.duration =
              payload.duration as InvocationState["duration"];
          if (payload.actor !== undefined)
            invocation.actor = payload.actor as RunnerJobObservationActor;
          if (payload.recovery !== undefined)
            invocation.recovery =
              payload.recovery as InvocationState["recovery"];
          if (payload.evidence !== undefined)
            invocation.evidence =
              payload.evidence as RunnerJobObservationEvidence;
          invocation.outcome = "succeeded";
          if (
            invocation.usageEvidence &&
            !invocation.usageContributionRecorded
          ) {
            state.observationUsage = addObservationUsage(
              state.observationUsage,
              invocation.usageEvidence,
            );
            state.usage = aggregateUsageAsLegacy(state.observationUsage);
            invocation.usageContributionRecorded = true;
          }
        }
        break;
      }
      case "invocation.abandoned": {
        const invocation = state.invocations[payload.id as string];
        if (invocation?.status === "started") {
          invocation.status = "abandoned";
          invocation.completedAt = payload.completedAt as string | undefined;
          invocation.duration = payload.duration as InvocationState["duration"];
          invocation.actor = payload.actor as
            | RunnerJobObservationActor
            | undefined;
          invocation.recovery = payload.recovery as InvocationState["recovery"];
          invocation.evidence = payload.evidence as
            | RunnerJobObservationEvidence
            | undefined;
          invocation.outcome = payload.outcome as InvocationState["outcome"];
          invocation.usageEvidence = payload.usageEvidence as
            | RunnerJobObservationUsage
            | undefined;
          if (invocation.usageEvidence) {
            state.observationUsage = addObservationUsage(
              state.observationUsage,
              invocation.usageEvidence,
            );
            state.usage = aggregateUsageAsLegacy(state.observationUsage);
            invocation.usageContributionRecorded = true;
          }
        }
        break;
      }
      case "action.completed":
        state.completedActions[payload.id as string] = payload.result;
        break;
      case "event.queued":
        state.outboundEvents.push({
          seq: payload.seq as number,
          payload: payload.payload as RunnerJobEventPayload,
        });
        if ((payload.payload as RunnerJobEventPayload).type === "job.context") {
          state.contextPublished = true;
        } else if (
          (payload.payload as RunnerJobEventPayload).type === "stage.started"
        ) {
          const observation = payload.payload as Extract<
            RunnerJobEventPayload,
            { type: "stage.started" }
          >;
          state.observations[observation.observationId] = {
            observationId: observation.observationId,
            started: true,
            finished: false,
          };
        } else if (
          (payload.payload as RunnerJobEventPayload).type === "stage.finished"
        ) {
          const observation = payload.payload as Extract<
            RunnerJobEventPayload,
            { type: "stage.finished" }
          >;
          state.observations[observation.observationId] = {
            observationId: observation.observationId,
            started: true,
            finished: true,
          };
        }
        state.nextEventSeq = Math.max(
          state.nextEventSeq,
          (payload.seq as number) + 1,
        );
        break;
      case "event.acked":
        state.acknowledgedEventSeq = Math.max(
          state.acknowledgedEventSeq,
          payload.seq as number,
        );
        state.outboundEvents = state.outboundEvents.filter(
          (event) => event.seq > state.acknowledgedEventSeq,
        );
        break;
      case "question.answered":
        state.answers[payload.questionId as string] = payload.answer as string;
        if (state.status === "waiting") state.status = "running";
        break;
      case "question.published":
        state.status = "waiting";
        state.questions[payload.questionId as string] =
          payload.prompt as string;
        break;
      case "usage.recorded": {
        const usage = payload.usage as Usage;
        const invocation = state.invocations[payload.id as string];
        if (!invocation?.usage) {
          state.usage = addUsage(state.usage, usage);
          if (invocation) invocation.usage = usage;
        }
        break;
      }
      case "warning":
        state.warnings.push(payload.message as string);
        break;
      case "landing.auto.completed":
        state.automaticLanding = payload.landing as RunnerJobLanding;
        break;
      case "landing.requested":
        state.landingRequests[payload.requestId as string] = {
          requestId: payload.requestId as string,
          target: payload.target as string,
          status: "requested",
        };
        break;
      case "landing.completed": {
        const request = state.landingRequests[payload.requestId as string];
        if (request) {
          request.status = "completed";
          request.result = payload.result as LandingReport;
        }
        break;
      }
      case "landing.acked": {
        const request = state.landingRequests[payload.requestId as string];
        if (request) request.status = "acked";
        break;
      }
    }
  }
  return state;
}
