import { z } from 'zod';

// PLNR-361/366: runtime-neutral orchestration protocol shared by the Worker, Runner, MCP
// clients, and UI. All additions are optional at the surrounding transport boundary so a v1
// Runner that predates orchestration continues to parse the frames it already understands.

export const ORCHESTRATION_CAPABILITY = 'orchestration.v1' as const;
export const MISSION_CAPABILITY = 'mission.v2' as const;
export const MCP_SESSION_LINEAGE_META = 'io.noriq/sessionLineage' as const;
export const RunnerProtocolCapability = z.enum([ORCHESTRATION_CAPABILITY, MISSION_CAPABILITY]);
export type RunnerProtocolCapability = z.infer<typeof RunnerProtocolCapability>;

export const McpSessionLineageHint = z.object({
  parentPresenceId: z.string().min(1).optional(),
  parentExecutionId: z.string().min(1).optional(),
}).refine((value) => value.parentPresenceId || value.parentExecutionId, {
  message: 'a session lineage hint must name a parent presence or execution',
});
export type McpSessionLineageHint = z.infer<typeof McpSessionLineageHint>;

export const ExecutionKind = z.enum(['copilot_session', 'run', 'sitting', 'stage', 'step', 'gate']);
export const ExecutionRole = z.enum(['orchestrator', 'planner', 'worker', 'reviewer', 'verifier', 'repair', 'system']);
export const ExecutionStatus = z.enum(['pending', 'running', 'parked', 'succeeded', 'failed', 'cancelled', 'interrupted']);
export const ExecutionRelationType = z.enum(['continues', 'verifies', 'repairs', 'hands_off_to', 'depends_on']);
export const ExecutionEventType = z.enum(['started', 'parked', 'resumed', 'succeeded', 'failed', 'cancelled', 'interrupted']);
export const ExecutionLineageStatus = z.enum(['complete', 'partial', 'unknown']);
export const ExecutionLineageMissing = z.enum(['root', 'parent', 'actor', 'presence', 'subject', 'events', 'legacy']);

/**
 * The complete lineage-quality value settled by PLNR-361. The original wire assignment carries
 * the compact status only; Project Intelligence and read models need the reasons as well, and
 * must reuse this authority rather than inventing a second completeness vocabulary.
 */
export const LineageCompleteness = z.object({
  status: ExecutionLineageStatus,
  missing: z.array(ExecutionLineageMissing).default([]),
  reason: z.string().nullable().default(null),
});
export type LineageCompleteness = z.infer<typeof LineageCompleteness>;

export const ExecutionAssignment = z.object({
  schemaVersion: z.literal(1),
  orchestrationId: z.string().min(1),
  executionId: z.string().min(1),
  parentExecutionId: z.string().nullable(),
  role: ExecutionRole,
  lineageStatus: ExecutionLineageStatus,
});
export type ExecutionAssignment = z.infer<typeof ExecutionAssignment>;

export const RunnerExecutionDeclaration = z.object({
  reportId: z.string().min(1).max(160),
  parentExecutionId: z.string().min(1),
  localNodeKey: z.string().min(1).max(160),
  kind: z.enum(['stage', 'step', 'gate']),
  role: ExecutionRole,
  stage: z.string().min(1).max(160).nullable().default(null),
  step: z.string().min(1).max(160).nullable().default(null),
  gateId: z.string().min(1).max(160).nullable().default(null),
  continuesExecutionId: z.string().min(1).nullable().default(null),
  observedAt: z.string().datetime(),
});
export type RunnerExecutionDeclaration = z.infer<typeof RunnerExecutionDeclaration>;

export const RunnerExecutionRelationReport = z.object({
  reportId: z.string().min(1).max(160),
  fromExecutionId: z.string().min(1),
  toExecutionId: z.string().min(1),
  relation: ExecutionRelationType,
  metadata: z.record(z.string(), z.unknown()).optional(),
  observedAt: z.string().datetime(),
});
export type RunnerExecutionRelationReport = z.infer<typeof RunnerExecutionRelationReport>;

export const RunnerExecutionEventReport = z.object({
  reportId: z.string().min(1).max(160),
  executionId: z.string().min(1),
  revision: z.number().int().positive(),
  event: ExecutionEventType,
  observedAt: z.string().datetime(),
  reason: z.string().max(2_000).nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type RunnerExecutionEventReport = z.infer<typeof RunnerExecutionEventReport>;

export const RunnerExecutionReconciliation = z.object({
  reportId: z.string().min(1).max(160),
  declarations: z.array(RunnerExecutionDeclaration).max(128).default([]),
  relations: z.array(RunnerExecutionRelationReport).max(256).default([]),
  events: z.array(RunnerExecutionEventReport).max(256).default([]),
  observedAt: z.string().datetime(),
});
export type RunnerExecutionReconciliation = z.infer<typeof RunnerExecutionReconciliation>;

export const ExecutionReportAck = z.object({
  reportId: z.string(),
  accepted: z.boolean(),
  executionId: z.string().nullable().default(null),
  status: ExecutionStatus.nullable().default(null),
  expectedRevision: z.number().int().positive().nullable().default(null),
  error: z.string().nullable().default(null),
});
export type ExecutionReportAck = z.infer<typeof ExecutionReportAck>;

export const MissionTaskBeginReport = z.object({
  reportId: z.string().min(1).max(160),
  attemptId: z.string().min(1).max(160),
  taskId: z.string().min(1),
  childKey: z.string().min(1).max(160),
  observedAt: z.string().datetime(),
});
export type MissionTaskBeginReport = z.infer<typeof MissionTaskBeginReport>;

export const MissionTaskSettleReport = z.object({
  reportId: z.string().min(1).max(160),
  attemptId: z.string().min(1).max(160),
  claimId: z.string().min(1),
  outcome: z.enum(['done', 'gated', 'failed', 'cancelled']),
  reason: z.string().max(2_000).nullable().default(null),
  observedAt: z.string().datetime(),
});
export type MissionTaskSettleReport = z.infer<typeof MissionTaskSettleReport>;

export const MissionTaskAck = z.object({
  reportId: z.string(),
  attemptId: z.string(),
  phase: z.enum(['begin', 'settle']),
  accepted: z.boolean(),
  taskId: z.string().nullable().default(null),
  claimId: z.string().nullable().default(null),
  executionId: z.string().nullable().default(null),
  taskStatus: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
});
export type MissionTaskAck = z.infer<typeof MissionTaskAck>;

export const MissionLeaseRef = z.object({
  sitting: z.number().int().positive(),
  executionId: z.string().min(1),
  epoch: z.number().int().positive(),
});
export type MissionLeaseRef = z.infer<typeof MissionLeaseRef>;

export const MissionInventoryItem = z.object({
  runId: z.string().min(1),
  lease: MissionLeaseRef,
  attempts: z.array(z.object({
    attemptId: z.string().min(1),
    executionId: z.string().min(1),
    epoch: z.number().int().positive(),
  })).max(256).default([]),
});
export type MissionInventoryItem = z.infer<typeof MissionInventoryItem>;

export const MissionAdoptionResult = z.object({
  runId: z.string(),
  decision: z.enum(['adopt', 'already_terminal', 'cancel', 'unknown']),
  lease: MissionLeaseRef.nullable().default(null),
  reason: z.string().nullable().default(null),
});
export type MissionAdoptionResult = z.infer<typeof MissionAdoptionResult>;
