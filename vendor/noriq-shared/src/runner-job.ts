import { z } from 'zod';
import { ExecutionSpec } from './execution-spec';

const id = z.string().trim().min(1).max(128);
const text = (maximum: number) => z.string().trim().min(1).max(maximum);
export const RunnerJobRevision = text(1_000);
export type RunnerJobRevision = z.infer<typeof RunnerJobRevision>;

export const RunnerJobCheckpoint = z.object({
  ref: RunnerJobRevision,
  label: text(500),
  url: z.string().url().max(2_000).nullable(),
}).strict();
export type RunnerJobCheckpoint = z.infer<typeof RunnerJobCheckpoint>;

export const RunnerJobRetainedLocation = z.object({
  vcs: text(100),
  label: text(1_000),
  url: z.string().url().max(2_000).nullable(),
}).strict();
export type RunnerJobRetainedLocation = z.infer<typeof RunnerJobRetainedLocation>;

export const RunnerJobLandingPolicy = z.enum(['retain', 'manual', 'auto', 'direct']);
export type RunnerJobLandingPolicy = z.infer<typeof RunnerJobLandingPolicy>;

export const RunnerJobLandingStatus = z.enum([
  'retained', 'requested', 'landing', 'landed', 'failed', 'not_applicable',
]);
export type RunnerJobLandingStatus = z.infer<typeof RunnerJobLandingStatus>;

export const RunnerJobLanding = z.object({
  policy: RunnerJobLandingPolicy,
  status: RunnerJobLandingStatus,
  target: text(1_000).nullable(),
  checkpoint: RunnerJobCheckpoint.nullable(),
  error: z.string().max(20_000).nullable(),
  requestId: id.nullable(),
}).strict();
export type RunnerJobLanding = z.infer<typeof RunnerJobLanding>;

export const RunnerJobTaskSnapshot = z.object({
  taskId: id,
  key: text(160),
  title: text(500),
  body: z.string().max(100_000),
  executionSpec: ExecutionSpec.nullable(),
  status: z.enum(['todo', 'failed']),
  retry: z.boolean(),
  order: z.number().int().nonnegative(),
  phaseOrder: z.number().int().nonnegative(),
}).strict();
export type RunnerJobTaskSnapshot = z.infer<typeof RunnerJobTaskSnapshot>;

export const RunnerJobDependency = z.object({
  taskId: id,
  dependsOnTaskId: id,
}).strict();
export type RunnerJobDependency = z.infer<typeof RunnerJobDependency>;

export const RunnerJobSource = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('task'),
    projectId: id,
    projectKey: text(80),
    task: RunnerJobTaskSnapshot,
  }).strict(),
  z.object({
    kind: z.literal('plan'),
    projectId: id,
    projectKey: text(80),
    planId: id,
    planKey: text(160),
    planTitle: text(500),
    tasks: z.array(RunnerJobTaskSnapshot).min(1).max(500),
    dependencies: z.array(RunnerJobDependency).max(5_000),
  }).strict(),
]);
export type RunnerJobSource = z.infer<typeof RunnerJobSource>;

export const RunnerJobStatus = z.enum([
  'queued', 'assigned', 'running', 'waiting', 'succeeded', 'partial', 'failed', 'cancelled',
]);
export type RunnerJobStatus = z.infer<typeof RunnerJobStatus>;

export const RunnerJobPhase = z.enum([
  'preparing', 'planning', 'building', 'checking', 'reviewing', 'repairing', 'integrating', 'finalizing',
]);
export type RunnerJobPhase = z.infer<typeof RunnerJobPhase>;

export const RunnerJobTaskResult = z.enum([
  'pending', 'running', 'accepted', 'failed', 'not_started', 'cancelled',
]);
export type RunnerJobTaskResult = z.infer<typeof RunnerJobTaskResult>;

export const RunnerJobUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
  calls: z.number().int().nonnegative(),
}).strict();
export type RunnerJobUsage = z.infer<typeof RunnerJobUsage>;

/**
 * Stable intelligence vocabulary for RunnerJob work. These stages are deliberately
 * finer grained than RunnerJobPhase: phases drive the operator-facing lifecycle,
 * while stages describe bounded work without creating execution child nodes.
 */
export const RunnerJobObservationStage = z.enum([
  'preflight', 'workspace', 'plan', 'setup', 'build', 'candidate', 'integrate',
  'check', 'review', 'repair', 'accept', 'preserve', 'finalize', 'human_wait', 'landing',
]);
export type RunnerJobObservationStage = z.infer<typeof RunnerJobObservationStage>;

export const RunnerJobMetricStatus = z.enum(['complete', 'partial', 'unavailable', 'not_applicable']);
export type RunnerJobMetricStatus = z.infer<typeof RunnerJobMetricStatus>;

export const RunnerJobMetricProvenance = z.enum([
  'runner_reported', 'driver_reported', 'derived', 'server_measured', 'not_reported',
]);
export type RunnerJobMetricProvenance = z.infer<typeof RunnerJobMetricProvenance>;

const metricEnvelope = <T extends z.ZodTypeAny>(value: T) => z.discriminatedUnion('status', [
  z.object({
    status: z.literal('complete'), value, provenance: RunnerJobMetricProvenance.exclude(['not_reported']),
  }).strict(),
  z.object({
    status: z.literal('partial'), value, provenance: RunnerJobMetricProvenance.exclude(['not_reported']),
  }).strict(),
  z.object({
    status: z.literal('unavailable'), value: z.null(), provenance: RunnerJobMetricProvenance,
  }).strict(),
  z.object({
    status: z.literal('not_applicable'), value: z.null(), provenance: RunnerJobMetricProvenance,
  }).strict(),
]);

export const RunnerJobTokenMetric = metricEnvelope(z.number().int().nonnegative());
export const RunnerJobCostMetric = metricEnvelope(z.number().nonnegative());
export const RunnerJobDurationMetric = metricEnvelope(z.number().int().nonnegative());
export type RunnerJobTokenMetric = z.infer<typeof RunnerJobTokenMetric>;
export type RunnerJobCostMetric = z.infer<typeof RunnerJobCostMetric>;
export type RunnerJobDurationMetric = z.infer<typeof RunnerJobDurationMetric>;

export const RunnerJobObservationUsage = z.object({
  inputTokens: RunnerJobTokenMetric,
  outputTokens: RunnerJobTokenMetric,
  cacheReadTokens: RunnerJobTokenMetric,
  cacheWriteTokens: RunnerJobTokenMetric,
  calls: RunnerJobTokenMetric,
  costUsd: RunnerJobCostMetric,
}).strict();
export type RunnerJobObservationUsage = z.infer<typeof RunnerJobObservationUsage>;

export const RunnerJobObservationActor = z.object({
  kind: z.enum(['runner', 'agent', 'command', 'vcs']),
  driver: text(100),
  vendor: z.string().max(100).nullable(),
  model: z.string().max(200).nullable(),
  effort: z.string().max(100).nullable(),
  role: z.string().max(100).nullable(),
  operation: text(200),
}).strict();
export type RunnerJobObservationActor = z.infer<typeof RunnerJobObservationActor>;

/** Sanitized evidence only: no prompts, transcripts, reasoning, raw logs, command output, or diffs. */
export const RunnerJobObservationEvidence = z.object({
  operationDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  resultDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean().nullable(),
  changedPathCount: z.number().int().nonnegative().nullable(),
  blockerFindings: z.number().int().nonnegative().nullable(),
  majorFindings: z.number().int().nonnegative().nullable(),
  minorFindings: z.number().int().nonnegative().nullable(),
  checkpointRef: z.string().max(1_000).nullable(),
  errorCode: z.string().max(100).nullable(),
}).strict();
export type RunnerJobObservationEvidence = z.infer<typeof RunnerJobObservationEvidence>;

export const RunnerJobAgentContext = z.object({
  role: text(100),
  driver: text(100),
  vendor: z.string().max(100).nullable(),
  model: z.string().max(200).nullable(),
  effort: z.string().max(100).nullable(),
}).strict();
export type RunnerJobAgentContext = z.infer<typeof RunnerJobAgentContext>;

export const RunnerJobFinding = z.object({
  severity: z.enum(['blocker', 'major', 'minor']),
  title: text(500),
  body: z.string().max(20_000),
  path: z.string().max(2_000).nullable(),
  line: z.number().int().positive().nullable(),
}).strict();
export type RunnerJobFinding = z.infer<typeof RunnerJobFinding>;

export const RunnerJobCheck = z.object({
  command: text(4_000),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  output: z.string().max(40_000),
  timedOut: z.boolean(),
}).strict();
export type RunnerJobCheck = z.infer<typeof RunnerJobCheck>;

export const RunnerJobOutput = z.object({
  workspaceMode: z.enum(['isolated', 'direct']),
  retainedLocation: RunnerJobRetainedLocation,
  baseRevision: RunnerJobRevision,
  headRevision: RunnerJobRevision,
  acceptedTaskCheckpoints: z.record(z.string(), RunnerJobCheckpoint),
  checks: z.array(RunnerJobCheck).max(1_000),
  findings: z.array(RunnerJobFinding).max(1_000),
  usage: RunnerJobUsage,
  summary: z.string().max(20_000),
  dirtyPaths: z.array(z.string().max(2_000)).max(10_000),
  landing: RunnerJobLanding.optional(),
}).strict();
export type RunnerJobOutput = z.infer<typeof RunnerJobOutput>;

const at = z.string().datetime();
export const RunnerJobEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('job.context'), at,
    vcs: text(100), workspaceMode: z.enum(['isolated', 'direct']),
    landingPolicy: RunnerJobLandingPolicy, agents: z.array(RunnerJobAgentContext).max(32),
  }).strict(),
  z.object({
    type: z.literal('stage.started'), at, observationId: id, taskId: id.nullable(),
    stage: RunnerJobObservationStage, attempt: z.number().int().positive(),
    actor: RunnerJobObservationActor,
  }).strict(),
  z.object({
    type: z.literal('stage.finished'), at, startedAt: at,
    observationId: id, taskId: id.nullable(), stage: RunnerJobObservationStage,
    attempt: z.number().int().positive(), actor: RunnerJobObservationActor,
    outcome: z.enum(['succeeded', 'failed', 'cancelled', 'skipped']),
    duration: RunnerJobDurationMetric, usage: RunnerJobObservationUsage,
    recovery: z.enum(['none', 'journal_replay', 'process_recovery']),
    evidence: RunnerJobObservationEvidence,
  }).strict(),
  z.object({ type: z.literal('progress'), at, phase: RunnerJobPhase, message: z.string().max(4_000), progress: z.number().min(0).max(1) }).strict(),
  z.object({ type: z.literal('task.plan'), at, taskId: id, plan: z.string().max(20_000) }).strict(),
  z.object({ type: z.literal('task.result'), at, taskId: id, status: RunnerJobTaskResult, checkpoint: RunnerJobCheckpoint.nullable(), summary: z.string().max(20_000), findings: z.array(RunnerJobFinding).max(100) }).strict(),
  z.object({ type: z.literal('question'), at, questionId: id, prompt: z.string().max(20_000) }).strict(),
  z.object({ type: z.literal('usage'), at, usage: RunnerJobUsage }).strict(),
  z.object({ type: z.literal('warning'), at, code: text(100), message: z.string().max(20_000) }).strict(),
  z.object({ type: z.literal('terminal'), at, status: z.enum(['succeeded', 'partial', 'failed', 'cancelled']), output: RunnerJobOutput }).strict(),
]);
export type RunnerJobEvent = z.infer<typeof RunnerJobEvent>;

export const RunnerJobAssignment = z.object({
  protocolVersion: z.literal(2),
  jobId: id,
  assignmentId: id,
  snapshotDigest: z.string().regex(/^[0-9a-f]{64}$/),
  source: RunnerJobSource,
  repoRef: text(500),
  expectedBaseRevision: RunnerJobRevision,
}).strict();
export type RunnerJobAssignment = z.infer<typeof RunnerJobAssignment>;

export const RunnerJobDispatch = z.object({ runnerId: id, repoRef: text(500) }).strict();
export type RunnerJobDispatch = z.infer<typeof RunnerJobDispatch>;

export const RunnerJobRunnerMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), protocolVersion: z.literal(2), runnerId: id, capacity: z.number().int().min(1).max(32), repositories: z.array(z.object({ repositoryKey: id, repoRef: text(500), vcs: text(100), baseRevision: RunnerJobRevision }).strict()).max(1_000) }).strict(),
  z.object({ type: z.literal('heartbeat'), freeSlots: z.number().int().min(0).max(32), activeJobIds: z.array(id).max(32) }).strict(),
  z.object({ type: z.literal('job.accept'), jobId: id, assignmentId: id }).strict(),
  z.object({ type: z.literal('job.event'), jobId: id, assignmentId: id, seq: z.number().int().positive(), payload: RunnerJobEvent }).strict(),
  z.object({ type: z.literal('job.reconcile'), jobId: id, assignmentId: id, lastLocalSeq: z.number().int().nonnegative() }).strict(),
  z.object({
    type: z.literal('job.land.result'), jobId: id, assignmentId: id, requestId: id,
    status: z.enum(['landed', 'failed']), target: text(1_000),
    checkpoint: RunnerJobCheckpoint.nullable(), error: z.string().max(20_000).nullable(),
  }).strict(),
]);
export type RunnerJobRunnerMessage = z.infer<typeof RunnerJobRunnerMessage>;

export const RunnerJobServerMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('job.assign'), assignment: RunnerJobAssignment }).strict(),
  z.object({ type: z.literal('job.cancel'), jobId: id, assignmentId: id, reason: z.string().max(4_000) }).strict(),
  z.object({ type: z.literal('job.answer'), jobId: id, assignmentId: id, questionId: id, answer: z.string().max(20_000) }).strict(),
  z.object({ type: z.literal('job.event.ack'), jobId: id, assignmentId: id, seq: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('job.reconcile.result'), jobId: id, assignmentId: id, action: z.enum(['continue', 'cancel']) }).strict(),
  z.object({ type: z.literal('job.land'), jobId: id, assignmentId: id, requestId: id, target: text(1_000) }).strict(),
  z.object({ type: z.literal('job.land.ack'), jobId: id, assignmentId: id, requestId: id }).strict(),
]);
export type RunnerJobServerMessage = z.infer<typeof RunnerJobServerMessage>;
