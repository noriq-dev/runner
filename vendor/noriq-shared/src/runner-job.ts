import { z } from 'zod';
import { ExecutionSpec } from './execution-spec';
import type { IntelligenceContextConsumptionMetric } from './intelligence';

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
  'preflight', 'workspace', 'plan', 'setup', 'memory', 'build', 'candidate', 'integrate',
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

export const RunnerJobRouteSize = z.enum(['tiny', 'small', 'medium', 'large']);
export type RunnerJobRouteSize = z.infer<typeof RunnerJobRouteSize>;

export const RunnerJobRouteRisk = z.enum(['low', 'medium', 'high']);
export type RunnerJobRouteRisk = z.infer<typeof RunnerJobRouteRisk>;

export const RunnerJobSpecCoverage = z.enum(['none', 'partial', 'complete']);
export type RunnerJobSpecCoverage = z.infer<typeof RunnerJobSpecCoverage>;

const routeReason = z.string().trim().min(1).max(100).regex(/^[a-z][a-z0-9._-]*$/);
export const RunnerJobAgentRoute = z.object({
  taskId: id,
  role: text(100),
  attempt: z.number().int().positive().max(100),
  policyVersion: text(100),
  size: RunnerJobRouteSize,
  risk: RunnerJobRouteRisk,
  specCoverage: RunnerJobSpecCoverage,
  reasons: z.array(routeReason).max(16).refine((reasons) => new Set(reasons).size === reasons.length, {
    message: 'route reasons must be unique',
  }),
  candidateCount: z.number().int().nonnegative().max(32),
  eligibleCount: z.number().int().nonnegative().max(32),
  actor: RunnerJobObservationActor.nullable(),
  decision: z.enum(['invoke', 'skip']),
}).strict().superRefine((route, ctx) => {
  if (route.eligibleCount > route.candidateCount) {
    ctx.addIssue({ code: 'custom', path: ['eligibleCount'], message: 'eligibleCount cannot exceed candidateCount' });
  }
  if (route.decision === 'invoke' && route.actor === null) {
    ctx.addIssue({ code: 'custom', path: ['actor'], message: 'invoked routes require an actor' });
  }
  if (route.decision === 'skip' && route.actor !== null) {
    ctx.addIssue({ code: 'custom', path: ['actor'], message: 'skipped routes cannot select an actor' });
  }
});
export type RunnerJobAgentRoute = z.infer<typeof RunnerJobAgentRoute>;

export const RunnerJobCostBasis = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('driver_reported'),
  }).strict(),
  z.object({
    kind: z.literal('api_list_estimate'),
    priceSource: z.object({
      provider: text(100),
      catalog: text(200),
      fetchedAt: z.string().datetime(),
      ageSeconds: z.number().int().nonnegative().max(31_536_000),
      stale: z.boolean(),
    }).strict(),
  }).strict(),
]);
export type RunnerJobCostBasis = z.infer<typeof RunnerJobCostBasis>;

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

// Runtime-importing intelligence.ts here would create an initialization cycle because that
// contract consumes RunnerJob schemas. Keep a strict wire schema locally and make TypeScript
// prove it remains structurally identical to IntelligenceContextConsumptionMetric.
const RunnerJobContextConsumptionSection = z.object({
  id: z.enum([
    'active_decisions', 'known_hazards', 'failed_approaches', 'relevant_memories',
    'related_documents',
    'similar_episodes', 'graph_neighborhood', 'affected_tests', 'active_neighboring_work',
    'uncertainty', 'source_excerpts',
  ]),
  excerptCount: z.number().int().nonnegative(),
  graphEntityCount: z.number().int().nonnegative(),
  documentReferenceCount: z.number().int().nonnegative().optional(),
  truncated: z.boolean(),
  unanswerable: z.boolean(),
}).strict();
const RunnerJobContextConsumptionSnapshot = z.object({
  mode: z.enum(['semantic', 'keyword']),
  role: z.enum(['scope', 'build', 'verify', 'human']),
  charBudget: z.number().int().positive(),
  charsUsed: z.number().int().nonnegative(),
  sections: z.array(RunnerJobContextConsumptionSection).default([]),
  similarEpisodesConsidered: z.number().int().nonnegative(),
  staleCitationsCount: z.number().int().nonnegative(),
  noticesCount: z.number().int().nonnegative(),
  retrievalTookMs: z.number().int().nonnegative(),
}).strict();
const RunnerJobContextMetricObservation = {
  provenance: z.enum([
    'server_observed', 'runner_observed', 'driver_reported', 'backend_observed',
    'derived', 'inferred', 'unavailable',
  ]),
  source: z.enum([
    'd1_coordination', 'd1_orchestration', 'project_memory_episode', 'runner', 'driver',
    'vcs_backend', 'derived_generation',
  ]),
  sourceId: z.string().nullable().default(null),
  observedAt: at.nullable().default(null),
  acceptedAt: at.nullable().default(null),
  reason: z.string().nullable().default(null),
};
export const RunnerJobContextConsumptionMetric = z.discriminatedUnion('status', [
  z.object({ status: z.literal('complete'), value: RunnerJobContextConsumptionSnapshot, ...RunnerJobContextMetricObservation }).strict(),
  z.object({ status: z.literal('partial'), value: RunnerJobContextConsumptionSnapshot, ...RunnerJobContextMetricObservation }).strict(),
  z.object({ status: z.literal('unavailable'), value: z.null(), ...RunnerJobContextMetricObservation }).strict(),
  z.object({ status: z.literal('not_applicable'), value: z.null(), ...RunnerJobContextMetricObservation }).strict(),
]);
export type RunnerJobContextConsumptionMetric = z.infer<typeof RunnerJobContextConsumptionMetric>;
type ContextMetricMatchesIntelligence = RunnerJobContextConsumptionMetric extends IntelligenceContextConsumptionMetric
  ? IntelligenceContextConsumptionMetric extends RunnerJobContextConsumptionMetric ? true : false
  : false;
const contextMetricMatchesIntelligence: ContextMetricMatchesIntelligence = true;
void contextMetricMatchesIntelligence;

const RunnerJobStageFinishedEvent = z.object({
  type: z.literal('stage.finished'), at, startedAt: at,
  observationId: id, taskId: id.nullable(), stage: RunnerJobObservationStage,
  attempt: z.number().int().positive(), actor: RunnerJobObservationActor,
  outcome: z.enum(['succeeded', 'failed', 'cancelled', 'skipped']),
  duration: RunnerJobDurationMetric, usage: RunnerJobObservationUsage,
  costBasis: RunnerJobCostBasis.optional(),
  recovery: z.enum(['none', 'journal_replay', 'process_recovery']),
  evidence: RunnerJobObservationEvidence,
}).strict().superRefine((event, ctx) => {
  const cost = event.usage.costUsd;
  if (!event.costBasis || cost.status === 'unavailable' || cost.status === 'not_applicable') return;
  if (event.costBasis.kind === 'driver_reported' && cost.provenance !== 'driver_reported') {
    ctx.addIssue({ code: 'custom', path: ['usage', 'costUsd', 'provenance'], message: 'driver-reported cost requires driver_reported provenance' });
  }
  if (event.costBasis.kind === 'api_list_estimate' && cost.provenance !== 'derived') {
    ctx.addIssue({ code: 'custom', path: ['usage', 'costUsd', 'provenance'], message: 'API-list estimate requires derived provenance' });
  }
});

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
  RunnerJobStageFinishedEvent,
  z.object({ type: z.literal('agent.route'), at, route: RunnerJobAgentRoute }).strict(),
  z.object({
    type: z.literal('memory.context'), at, taskId: id,
    packDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    generatedAt: at.nullable(),
    consumption: RunnerJobContextConsumptionMetric,
  }).strict().superRefine((event, ctx) => {
    if (!['runner_observed', 'driver_reported', 'backend_observed'].includes(event.consumption.provenance)
        || !['runner', 'driver', 'vcs_backend'].includes(event.consumption.source)) {
      ctx.addIssue({
        code: 'custom', path: ['consumption'],
        message: 'memory context must carry daemon-observed provenance',
      });
    }
  }),
  z.object({ type: z.literal('progress'), at, taskId: id.optional(), phase: RunnerJobPhase, message: z.string().max(4_000), progress: z.number().min(0).max(1) }).strict(),
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

export const RunnerCoordinationLeaseKind = z.enum(['repository', 'paths', 'landing']);
export type RunnerCoordinationLeaseKind = z.infer<typeof RunnerCoordinationLeaseKind>;

export const RunnerCoordinationLeaseScope = z.object({
  repositoryKey: text(500),
  lane: text(1_000),
  kind: RunnerCoordinationLeaseKind,
  paths: z.array(text(2_000)).max(256),
}).strict().superRefine((scope, ctx) => {
  if (scope.kind === 'paths' && scope.paths.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['paths'], message: 'path leases require at least one path' });
  }
  if (scope.kind !== 'paths' && scope.paths.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['paths'], message: 'only path leases may name paths' });
  }
});
export type RunnerCoordinationLeaseScope = z.infer<typeof RunnerCoordinationLeaseScope>;

export const RunnerCoordinationLeaseIdentity = z.object({
  runnerId: id,
  checkoutId: id,
  projectId: id,
  jobId: id,
  assignmentId: id,
  taskId: id.nullable(),
  idempotencyKey: text(256),
  landingRequestId: id.optional(),
}).strict();
export type RunnerCoordinationLeaseIdentity = z.infer<typeof RunnerCoordinationLeaseIdentity>;

export const RunnerCoordinationLease = RunnerCoordinationLeaseIdentity.extend({
  leaseId: id,
  repositoryKey: text(500),
  lane: text(1_000),
  kind: RunnerCoordinationLeaseKind,
  paths: z.array(text(2_000)).max(256),
  fencingToken: z.number().int().nonnegative(),
  expiresAt: z.string().datetime(),
}).strict();
export type RunnerCoordinationLease = z.infer<typeof RunnerCoordinationLease>;

export const RunnerCoordinationAcquire = RunnerCoordinationLeaseIdentity.extend({
  repositoryKey: text(500),
  lane: text(1_000),
  kind: RunnerCoordinationLeaseKind,
  paths: z.array(text(2_000)).max(256),
  ttlSeconds: z.literal(90),
  previousFencingToken: z.number().int().nonnegative().optional(),
}).strict();
export type RunnerCoordinationAcquire = z.infer<typeof RunnerCoordinationAcquire>;

export const RunnerCoordinationExchange = z.object({
  lease: RunnerCoordinationLease,
  scope: RunnerCoordinationLeaseScope,
  ttlSeconds: z.literal(90),
}).strict();
export type RunnerCoordinationExchange = z.infer<typeof RunnerCoordinationExchange>;

export const RunnerCoordinationRenew = z.object({
  leaseId: id, fencingToken: z.number().int().nonnegative(), ttlSeconds: z.literal(90),
}).strict();
export type RunnerCoordinationRenew = z.infer<typeof RunnerCoordinationRenew>;

export const RunnerCoordinationRecover = RunnerCoordinationLease.extend({
  ttlSeconds: z.literal(90),
}).strict();
export type RunnerCoordinationRecover = z.infer<typeof RunnerCoordinationRecover>;

export const RunnerCoordinationRelease = z.object({
  leaseId: id, fencingToken: z.number().int().nonnegative(),
}).strict();
export type RunnerCoordinationRelease = z.infer<typeof RunnerCoordinationRelease>;

export const RunnerCoordinationAcquireResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('acquired'), lease: RunnerCoordinationLease }).strict(),
  z.object({
    status: z.literal('conflict'), retryAfterMs: z.number().int().nonnegative(),
    conflictingKind: RunnerCoordinationLeaseKind,
  }).strict(),
]);
export type RunnerCoordinationAcquireResult = z.infer<typeof RunnerCoordinationAcquireResult>;

export const RunnerJobRuntimeRepository = z.object({
  repositoryKey: id,
  repoRef: text(500),
  vcs: text(100),
  baseRevision: RunnerJobRevision,
}).strict();
export type RunnerJobRuntimeRepository = z.infer<typeof RunnerJobRuntimeRepository>;

export const RunnerCatalog = z.object({
  generation: z.number().int().positive(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  repositories: z.array(RunnerJobRuntimeRepository).max(1_000),
}).strict().superRefine((catalog, ctx) => {
  const refs = new Set<string>();
  for (const [index, repository] of catalog.repositories.entries()) {
    if (refs.has(repository.repoRef)) {
      ctx.addIssue({ code: 'custom', path: ['repositories', index, 'repoRef'], message: 'repoRef must be unique within a catalog' });
    }
    refs.add(repository.repoRef);
  }
});
export type RunnerCatalog = z.infer<typeof RunnerCatalog>;

/** Stable digest input shared by daemon and server. Inventory order is not semantic. */
export function runnerCatalogCanonicalJson(repositories: RunnerJobRuntimeRepository[]): string {
  return JSON.stringify([...repositories]
    .sort((a, b) => a.repoRef.localeCompare(b.repoRef))
    .map(({ repositoryKey, repoRef, vcs, baseRevision }) => ({ repositoryKey, repoRef, vcs, baseRevision })));
}

export const RunnerJobRunnerMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), protocolVersion: z.literal(2), runnerId: id, capacity: z.number().int().min(1).max(32), repositories: z.array(RunnerJobRuntimeRepository).max(1_000) }).strict(),
  z.object({ type: z.literal('catalog.update'), catalog: RunnerCatalog }).strict(),
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
  z.object({
    type: z.literal('catalog.ack'), generation: z.number().int().positive(),
    digest: z.string().regex(/^[0-9a-f]{64}$/), accepted: z.boolean(),
    dispatchableRepoRefs: z.array(text(500)).max(1_000), error: z.string().max(4_000).nullable(),
  }).strict(),
  z.object({ type: z.literal('job.assign'), assignment: RunnerJobAssignment }).strict(),
  z.object({ type: z.literal('job.cancel'), jobId: id, assignmentId: id, reason: z.string().max(4_000) }).strict(),
  z.object({ type: z.literal('job.answer'), jobId: id, assignmentId: id, questionId: id, answer: z.string().max(20_000) }).strict(),
  z.object({ type: z.literal('job.event.ack'), jobId: id, assignmentId: id, seq: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('job.reconcile.result'), jobId: id, assignmentId: id, action: z.enum(['continue', 'cancel']) }).strict(),
  z.object({ type: z.literal('job.land'), jobId: id, assignmentId: id, requestId: id, target: text(1_000) }).strict(),
  z.object({ type: z.literal('job.land.ack'), jobId: id, assignmentId: id, requestId: id }).strict(),
]);
export type RunnerJobServerMessage = z.infer<typeof RunnerJobServerMessage>;
