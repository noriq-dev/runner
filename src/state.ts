import type {
  CheckResult,
  Finding,
  JobAssignment,
  RunnerJobEventPayload,
  RunnerJobPhase,
  RunnerJobStatus,
  RunnerJobTaskStatus,
  Usage,
} from "./contracts.js";
import type { JournalRecord } from "./journal.js";

export interface InvocationState {
  id: string;
  taskId: string;
  role: "guide" | "builder" | "reviewer" | "repairer";
  status: "started" | "completed" | "abandoned";
  resultDigest?: string;
}

export interface TaskState {
  taskId: string;
  status: RunnerJobTaskStatus;
  repairRounds: number;
  plan?: string;
  workspace?: string;
  branch?: string;
  workspaceBase?: string;
  draftCommit?: string;
  commit?: string;
  findings: Finding[];
  checks: CheckResult[];
}

export interface JobState {
  assignment: JobAssignment | null;
  status: RunnerJobStatus;
  phase: RunnerJobPhase;
  cancelled: boolean;
  stopScheduling: boolean;
  baseRevision?: string;
  branch?: string;
  expectedHead?: string;
  tasks: Record<string, TaskState>;
  invocations: Record<string, InvocationState>;
  completedActions: Record<string, unknown>;
  nextEventSeq: number;
  acknowledgedEventSeq: number;
  outboundEvents: Array<{ seq: number; payload: RunnerJobEventPayload }>;
  answers: Record<string, string>;
  questions: Record<string, string>;
  usage: Usage;
  warnings: string[];
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
    warnings: [],
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
      case "workspace.ready":
        state.baseRevision = payload.baseRevision as string;
        state.branch = payload.branch as string;
        state.expectedHead = payload.expectedHead as string;
        break;
      case "task.started":
        state.tasks[payload.taskId as string]!.status = "running";
        break;
      case "task.plan":
        state.tasks[payload.taskId as string]!.plan = payload.plan as string;
        break;
      case "task.workspace": {
        const task = state.tasks[payload.taskId as string]!;
        task.workspace = payload.path as string;
        task.branch = payload.branch as string;
        task.workspaceBase = payload.baseRevision as string;
        break;
      }
      case "task.draft":
        state.tasks[payload.taskId as string]!.draftCommit =
          payload.commit as string;
        break;
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
        task.commit = payload.commit as string;
        state.expectedHead = payload.commit as string;
        break;
      }
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
          invocation.resultDigest = payload.resultDigest as string;
        }
        break;
      }
      case "invocation.abandoned": {
        const invocation = state.invocations[payload.id as string];
        if (invocation) invocation.status = "abandoned";
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
      case "usage.recorded":
        state.usage = addUsage(state.usage, payload.usage as Usage);
        break;
      case "warning":
        state.warnings.push(payload.message as string);
        break;
    }
  }
  return state;
}
