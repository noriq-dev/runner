import { z } from 'zod';
import { ExecutionSpec } from './execution-spec';
import { ExecutionKind, ExecutionRole, LineageCompleteness } from './orchestration';
import { RunModelUsage } from './runner';
import { RunBudget } from './runner';

// PLNR-290: runtime-neutral Project Intelligence vocabulary shared by Noriq and Runner. This
// file defines facts and evidence states only. Storage, extraction, queries, risk, comparison,
// and presentation deliberately live in later tasks.

export const PROJECT_INTELLIGENCE_CONTRACT_VERSION = 1 as const;

export const MetricCompleteness = z.enum(['unavailable', 'partial', 'not_applicable', 'complete']);
export type MetricCompleteness = z.infer<typeof MetricCompleteness>;

export const MetricProvenance = z.enum([
  'server_observed',
  'runner_observed',
  'driver_reported',
  'backend_observed',
  'derived',
  'inferred',
  'unavailable',
]);
export type MetricProvenance = z.infer<typeof MetricProvenance>;

export const IntelligenceSource = z.enum([
  'd1_coordination',
  'd1_orchestration',
  'project_memory_episode',
  'runner',
  'driver',
  'vcs_backend',
  'derived_generation',
]);
export type IntelligenceSource = z.infer<typeof IntelligenceSource>;

const metricObservation = {
  provenance: MetricProvenance,
  source: IntelligenceSource,
  sourceId: z.string().nullable().default(null),
  observedAt: z.string().datetime().nullable().default(null),
  acceptedAt: z.string().datetime().nullable().default(null),
  reason: z.string().nullable().default(null),
};

/**
 * A metric can never use a numeric zero to mean "unknown". Available states carry a value;
 * unavailable/not-applicable states are forced to null by construction.
 */
const metricEnvelope = <T extends z.ZodType>(value: T) => z.discriminatedUnion('status', [
  z.object({ status: z.literal('complete'), value, ...metricObservation }),
  z.object({ status: z.literal('partial'), value, ...metricObservation }),
  z.object({ status: z.literal('unavailable'), value: z.null(), ...metricObservation }),
  z.object({ status: z.literal('not_applicable'), value: z.null(), ...metricObservation }),
]);

export const IntelligenceNumberMetric = metricEnvelope(z.number().finite().nonnegative());
export const IntelligenceIntegerMetric = metricEnvelope(z.number().int().nonnegative());
export const IntelligenceDurationMs = metricEnvelope(z.number().finite().nonnegative());
export const IntelligenceRatioMetric = metricEnvelope(z.number().finite().min(0).max(1));
export const IntelligenceModelUsageMetric = metricEnvelope(RunModelUsage);
export type IntelligenceNumberMetric = z.infer<typeof IntelligenceNumberMetric>;
export type IntelligenceIntegerMetric = z.infer<typeof IntelligenceIntegerMetric>;
export type IntelligenceDurationMs = z.infer<typeof IntelligenceDurationMs>;
export type IntelligenceRatioMetric = z.infer<typeof IntelligenceRatioMetric>;

export const EvidenceMaturity = z.enum([
  'insufficient_evidence',
  'cannot_yet_distinguish',
  'directional_signal',
  'distinguishable',
]);
export type EvidenceMaturity = z.infer<typeof EvidenceMaturity>;

export const StrategyCoordinate = z.object({
  tool: z.string().nullable().default(null),
  vendor: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  effort: z.string().nullable().default(null),
  workflow: z.string().nullable().default(null),
  reviewer: z.string().nullable().default(null),
  verifier: z.string().nullable().default(null),
  contextStrategy: z.string().nullable().default(null),
  concurrencyStrategy: z.string().nullable().default(null),
});
export type StrategyCoordinate = z.infer<typeof StrategyCoordinate>;

export const ConfigurationFingerprintKind = z.enum([
  'runner',
  'workflow',
  'reviewer',
  'verifier',
  'manifest',
  'context',
  'execution_profile',
]);

export const ConfigurationFingerprint = z.object({
  kind: ConfigurationFingerprintKind,
  name: z.string().nullable().default(null),
  version: z.string().nullable().default(null),
  fingerprint: z.string().min(1),
});
export type ConfigurationFingerprint = z.infer<typeof ConfigurationFingerprint>;

export const ExecutedExecutionProfileEvidence = z.object({
  id: z.string().min(1).max(80).regex(/^[A-Za-z0-9._:-]+$/),
  generation: z.number().int().positive(),
  effectiveFingerprint: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:+\-=]+$/),
  inventoryFingerprint: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:+\-=]+$/),
}).strict();
export type ExecutedExecutionProfileEvidence = z.infer<typeof ExecutedExecutionProfileEvidence>;

/** Late Runner evidence about the configuration that actually executed. It is deliberately
 * distinct from the server's commissioning snapshot and optional on telemetry for old Runners. */
export const ExecutedConfigurationEvidence = z.object({
  strategy: StrategyCoordinate.nullable().default(null),
  configuration: z.array(ConfigurationFingerprint).default([]),
  executionProfile: ExecutedExecutionProfileEvidence.nullable().default(null),
});
export type ExecutedConfigurationEvidence = z.infer<typeof ExecutedConfigurationEvidence>;

export const ProjectIntelligenceIdentity = z.object({
  episodeId: z.string().min(1),
  projectId: z.string().min(1),
  runId: z.string().min(1),
  sitting: z.number().int().positive(),
  taskId: z.string().nullable().default(null),
  planId: z.string().nullable().default(null),
  planDispatchId: z.string().nullable().default(null),
  orchestrationId: z.string().nullable().default(null),
  executionId: z.string().nullable().default(null),
  repositoryKey: z.string().min(1).nullable().default(null),
  branch: z.string().min(1).nullable().default(null),
  baseId: z.string().min(1).nullable().default(null),
  lineage: LineageCompleteness,
  /** Additive source discriminator. Legacy episodes omit it and remain Runner-run episodes. */
  workSource: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('runner_run'), runId: z.string().min(1), sitting: z.number().int().positive() }),
    z.object({
      kind: z.literal('copilot_claim'),
      claimId: z.string().min(1),
      executionId: z.string().min(1).nullable().default(null),
    }),
  ]).optional(),
});
export type ProjectIntelligenceIdentity = z.infer<typeof ProjectIntelligenceIdentity>;

export const TaskCommissioningSnapshot = z.object({
  taskType: z.string().nullable().default(null),
  tags: z.array(z.string().min(1)).default([]),
  executionSpecFingerprint: z.string().nullable().default(null),
  capturedAt: z.string().datetime(),
});

export const EpisodePreExecutionFacts = z.object({
  task: TaskCommissioningSnapshot,
  requestedStrategy: StrategyCoordinate.nullable().default(null),
  commissionedStrategy: StrategyCoordinate.nullable().default(null),
  commissionedSpec: ExecutionSpec.nullable().default(null),
  budget: RunBudget.nullable().default(null),
  configuration: z.array(ConfigurationFingerprint).default([]),
});
export type EpisodePreExecutionFacts = z.infer<typeof EpisodePreExecutionFacts>;

export const EpisodeClockFacts = z.object({
  queueDurationMs: IntelligenceDurationMs,
  dispatchToStartMs: IntelligenceDurationMs,
  elapsedExecutionMs: IntelligenceDurationMs,
  humanBlockedMs: IntelligenceDurationMs,
  verifyDurationMs: IntelligenceDurationMs,
});

export const EpisodeStageFact = z.object({
  executionId: z.string().nullable().default(null),
  kind: ExecutionKind,
  role: ExecutionRole,
  stage: z.string().nullable().default(null),
  elapsedMs: IntelligenceDurationMs,
  tokens: IntelligenceIntegerMetric,
  costUSD: IntelligenceNumberMetric,
});
export type EpisodeStageFact = z.infer<typeof EpisodeStageFact>;

export const BackendChangeStats = z.object({
  backend: z.string().nullable().default(null),
  changedFiles: IntelligenceIntegerMetric,
  additions: IntelligenceIntegerMetric,
  deletions: IntelligenceIntegerMetric,
  churn: IntelligenceIntegerMetric,
});
export type BackendChangeStats = z.infer<typeof BackendChangeStats>;

export const EpisodeExecutionFacts = z.object({
  executedStrategy: StrategyCoordinate.nullable().default(null),
  executedSpec: ExecutionSpec.nullable().default(null),
  observedModelUsage: IntelligenceModelUsageMetric,
  clocks: EpisodeClockFacts,
  stages: z.array(EpisodeStageFact).default([]),
  changes: BackendChangeStats,
});
export type EpisodeExecutionFacts = z.infer<typeof EpisodeExecutionFacts>;

export const EpisodeOutcomeFacts = z.object({
  runOutcome: z.enum(['done', 'failed', 'cancelled']),
  landingOutcome: z.enum(['landed', 'not_landed', 'failed', 'pending']),
  reviewRounds: IntelligenceIntegerMetric,
  acceptanceCoverage: IntelligenceRatioMetric,
});
export type EpisodeOutcomeFacts = z.infer<typeof EpisodeOutcomeFacts>;

export const IntelligenceSourceWatermarks = z.object({
  memoryRevision: z.number().int().nonnegative().nullable().default(null),
  coordinationEventSequence: z.number().int().nonnegative().nullable().default(null),
  orchestrationAcceptedAt: z.string().datetime().nullable().default(null),
  capturedAt: z.string().datetime(),
});
export type IntelligenceSourceWatermarks = z.infer<typeof IntelligenceSourceWatermarks>;

export const IntelligenceAlgorithmVersions = z.object({
  extraction: z.string().min(1),
  retrieval: z.string().min(1).nullable().default(null),
  risk: z.string().min(1).nullable().default(null),
  comparison: z.string().min(1).nullable().default(null),
});

// PLNR-433: what a run actually READ, as distinct from what it was told to do (`preExecution`) or
// what it did (`execution`). Blocks RUN-247, which already holds every one of these facts on the
// Runner's own `ContextPack`/`ContextPackRetrieval` (verified against the checked-out Runner
// source, not assumed) and has had nowhere server-side to put them.
//
// PLACEMENT — a top-level sibling of preExecution/execution/outcome, not nested under either
// (task's own discretion point, argued here): `preExecution` is the server's own immutable
// commissioning snapshot — what the run was TOLD before it started; a daemon-reported fact about
// what it actually consumed does not belong inside that server-authoritative object. `execution`
// is scoped to the run's own clocks/stages/changes, and this task's OWN acceptance requires that
// reporting context facts leave `execution.stages`/`clocks`/`changes` untouched — nesting under
// `execution` would make that something the merge function has to work to preserve; a disjoint
// top-level key makes it true by construction instead.
//
// THE NO-TEXT RULE IS STRUCTURAL: every field below is a count, an enum, a boolean, or a
// `metricEnvelope` around one of those — never a bare `z.string()`. `ContextPackNotice.reason` and
// every excerpt/citation field on the real `ContextPack` (memory.ts:704) are free text and have no
// counterpart here; only whether a notice fired (boolean) or how many fired (count) is carried.
//
// REQUESTED-VS-CONSUMED lives in `metricEnvelope`'s existing four statuses, not a bespoke fact kind
// (design point 2 — checked against the real `metricEnvelope`/`BackendChangeStats`/
// `observedModelUsage` shapes in this same file before concluding this, not assumed): see
// `IntelligenceContextConsumptionMetric` below. `not_applicable` (value: null) = never asked — no
// task anchor, no repository key to assemble a pack against. `unavailable` (value: null) = asked
// and got nothing back before anything rendered (no fetcher configured, a timeout, a server error
// — the Runner's own `ContextPackOmission` names which, but that is Runner-side reasoning about
// its OWN request, not a fact this analytics contract needs a parallel enum for: the four envelope
// statuses already say everything an episode record needs to say about it, and adding
// `ContextPackOmission` here too would just give the daemon two ways to describe one state).
// `complete` (value populated, mode: 'semantic') = rendered in full. `partial` (value populated,
// mode: 'keyword', and/or a section carrying `truncated`/`unanswerable`) = rendered, but bounded or
// degraded. That is three (in fact four) states, and none of them is a raw zero: "never requested"
// and "requested but never rendered" both carry `value: null` and are distinguished ONLY by
// `status`, exactly as the acceptance requires.
//
// REVISION IDENTITY — decided HERE, not punted to the Runner (the task explicitly asks for that):
// NOT NOW. `IntelligenceSourceWatermarks.memoryRevision` looks like it might already answer "which
// revision of memory did this run see", but it is stamped at EPISODE-recording time
// (`ProjectMemory.recordEpisode`'s `acceptedMemoryRevision`, read after the run finishes), not at
// PACK-assembly time — a long build can see `memory_revision` advance while it runs, so reusing
// that watermark for "which revision did the pack see" would be silently wrong, not merely
// approximate. A correct id would have to originate on `ContextPack` itself (memory.ts:704), which
// today carries only `generatedAt`, and widening that schema is explicitly out of this task's scope
// (a follow-up task, per the execution spec's `deferred` list) — so there is nowhere honest to
// source a pack-assembly-time revision id from in this diff. Leaving it out rather than growing a
// second, wrong watermark that would need its own reconciliation with the first.
//
// Duplicated enum values below (`ContextConsumptionSectionId`/`Mode`/`Role`) mirror `memory.ts`'s
// `ContextPackSectionId`/`ContextPackMode`/`ContextPackRole`. `memory.ts` imports
// `ProjectIntelligenceEpisode` from THIS file (for `EffortEpisode.intelligence`), so this file
// importing back from `memory.ts` would be a cycle — the duplication itself is forced. UNLIKE
// `memory.ts`'s own `ContextPackProvenance`, which mirrors the Worker-internal `RetrievalStage` "by
// convention, not by import" because a compile-time check is genuinely unavailable across that
// package boundary, both halves of these three pairs live in this SAME package — so nothing is
// kept in sync "by hand": `memory.ts` (which already imports from this file, so the dependency
// direction is untouched) carries a type-level bidirectional equality assertion for all three
// pairs, right after its own `ContextPackSectionId`/`Mode`/`Role` declarations, that fails
// `npx tsc --noEmit` the moment either side adds, removes, or renames a value.
export const ContextConsumptionSectionId = z.enum([
  'active_decisions',
  'known_hazards',
  'failed_approaches',
  'relevant_memories',
  'similar_episodes',
  'graph_neighborhood',
  'affected_tests',
  'active_neighboring_work',
  'uncertainty',
  'source_excerpts',
]);
export type ContextConsumptionSectionId = z.infer<typeof ContextConsumptionSectionId>;

/** One rendered section's shape as it counts for analytics — never its excerpts, citations, or
 * notice text. `ContextPackNotice.reason` is free text and stays out of this contract entirely;
 * only whether a notice of each kind fired, as a boolean, crosses the boundary. */
export const ContextConsumptionSectionFact = z.object({
  id: ContextConsumptionSectionId,
  excerptCount: z.number().int().nonnegative(),
  graphEntityCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  unanswerable: z.boolean(),
});
export type ContextConsumptionSectionFact = z.infer<typeof ContextConsumptionSectionFact>;

export const ContextConsumptionMode = z.enum(['semantic', 'keyword']);
export type ContextConsumptionMode = z.infer<typeof ContextConsumptionMode>;
export const ContextConsumptionRole = z.enum(['scope', 'build', 'verify', 'human']);
export type ContextConsumptionRole = z.infer<typeof ContextConsumptionRole>;

/** What a run's context pack looked like when it was rendered — counts, enums and booleans only
 * (locked decision): no excerpt text, no citation path, no memory statement, no notice reason
 * string has anywhere to go in this shape, structurally, regardless of who implements RUN-247. */
export const ContextConsumptionSnapshot = z.object({
  mode: ContextConsumptionMode,
  role: ContextConsumptionRole,
  charBudget: z.number().int().positive(),
  charsUsed: z.number().int().nonnegative(),
  sections: z.array(ContextConsumptionSectionFact).default([]),
  similarEpisodesConsidered: z.number().int().nonnegative(),
  staleCitationsCount: z.number().int().nonnegative(),
  noticesCount: z.number().int().nonnegative(),
  retrievalTookMs: z.number().int().nonnegative(),
});
export type ContextConsumptionSnapshot = z.infer<typeof ContextConsumptionSnapshot>;

export const IntelligenceContextConsumptionMetric = metricEnvelope(ContextConsumptionSnapshot);
export type IntelligenceContextConsumptionMetric = z.infer<typeof IntelligenceContextConsumptionMetric>;

export const ProjectIntelligenceEpisode = z.object({
  schemaVersion: z.literal(PROJECT_INTELLIGENCE_CONTRACT_VERSION),
  identity: ProjectIntelligenceIdentity,
  sources: IntelligenceSourceWatermarks,
  versions: IntelligenceAlgorithmVersions,
  preExecution: EpisodePreExecutionFacts,
  execution: EpisodeExecutionFacts,
  outcome: EpisodeOutcomeFacts,
  /** PLNR-433: `.optional()`, not `.default()` — a pre-change stored episode has no key for this
   * fact at all, and must still parse unchanged. Only a daemon upload (RUN-247) ever sets it; the
   * server-built skeleton (`memory/episodes.ts#loadEpisodeSkeleton`) deliberately leaves it unset,
   * since the server never sees the Runner's own `ContextPack` — setting a manufactured
   * `not_applicable` default there would claim server knowledge of "never asked" for runs the
   * server simply has no opinion on yet. */
  contextConsumption: IntelligenceContextConsumptionMetric.optional(),
});
export type ProjectIntelligenceEpisode = z.infer<typeof ProjectIntelligenceEpisode>;

/** Explicit downstream observations. These are append-only facts about what was observed later;
 * they do not revise an episode's immediate outcome and do not assert blame or causality. */
export const ProjectQualityEventType = z.enum([
  'task_reopened',
  'work_reverted',
  'regression_task_linked',
]);
export type ProjectQualityEventType = z.infer<typeof ProjectQualityEventType>;

export const ProjectQualityEvent = z.object({
  schemaVersion: z.literal(PROJECT_INTELLIGENCE_CONTRACT_VERSION),
  id: z.string().min(1),
  operationKey: z.string().min(1),
  projectId: z.string().min(1),
  type: ProjectQualityEventType,
  taskId: z.string().min(1),
  relatedTaskId: z.string().min(1).nullable().default(null),
  runId: z.string().min(1).nullable().default(null),
  sitting: z.number().int().positive().nullable().default(null),
  episodeId: z.string().min(1).nullable().default(null),
  orchestrationId: z.string().min(1).nullable().default(null),
  executionId: z.string().min(1).nullable().default(null),
  artifactRef: z.string().min(1).nullable().default(null),
  source: z.object({
    kind: z.enum(['coordination_event', 'explicit_user_action']),
    eventId: z.string().min(1).nullable().default(null),
    eventSequence: z.number().int().nonnegative().nullable().default(null),
  }),
  actor: z.object({
    kind: z.enum(['agent', 'human', 'system']),
    id: z.string().min(1),
  }),
  observedAt: z.string().datetime(),
  provenance: z.record(z.string(), z.unknown()).default({}),
}).superRefine((event, ctx) => {
  if ((event.runId == null) !== (event.sitting == null)) {
    ctx.addIssue({ code: 'custom', message: 'runId and sitting must be supplied together' });
  }
  if ((event.type === 'regression_task_linked') !== (event.relatedTaskId != null)) {
    ctx.addIssue({ code: 'custom', message: 'only regression_task_linked requires relatedTaskId' });
  }
  if ((event.type === 'work_reverted') !== (event.artifactRef != null)) {
    ctx.addIssue({ code: 'custom', message: 'only work_reverted requires artifactRef' });
  }
  if ((event.source.kind === 'coordination_event') !== (event.source.eventId != null)) {
    ctx.addIssue({ code: 'custom', message: 'coordination_event sources require eventId; explicit actions do not carry one' });
  }
});
export type ProjectQualityEvent = z.infer<typeof ProjectQualityEvent>;

export const AnalyticsGenerationState = z.enum(['not_started', 'stale', 'building', 'complete', 'failed']);
export const AnalyticsGenerationDescriptor = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  state: AnalyticsGenerationState,
  versions: IntelligenceAlgorithmVersions,
  sources: IntelligenceSourceWatermarks,
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable().default(null),
  error: z.string().nullable().default(null),
});
export type AnalyticsGenerationDescriptor = z.infer<typeof AnalyticsGenerationDescriptor>;

export const AnalyticsStaleSource = z.enum([
  'extraction_version',
  'project_memory',
  'coordination',
  'orchestration',
]);
export type AnalyticsStaleSource = z.infer<typeof AnalyticsStaleSource>;

export const ProjectAnalyticsHealth = z.object({
  projectId: z.string().min(1),
  state: AnalyticsGenerationState,
  extractionVersion: z.string().min(1),
  active: AnalyticsGenerationDescriptor.nullable(),
  building: AnalyticsGenerationDescriptor.nullable(),
  latestFailure: AnalyticsGenerationDescriptor.nullable(),
  staleSources: z.array(AnalyticsStaleSource),
  lag: z.object({
    memoryRevisions: z.number().int().nonnegative().nullable(),
    coordinationEvents: z.number().int().nonnegative().nullable(),
    orchestrationChanged: z.boolean(),
  }),
  currentSources: IntelligenceSourceWatermarks,
  lastSuccessfulIncrementalAt: z.string().datetime().nullable(),
  lastSuccessfulFullRebuildAt: z.string().datetime().nullable(),
  retry: z.object({
    pending: z.boolean(),
    attempts: z.number().int().nonnegative(),
    requestedAt: z.string().datetime().nullable(),
    lastAttemptAt: z.string().datetime().nullable(),
    nextRetryAt: z.string().datetime().nullable(),
    lastError: z.string().nullable(),
  }),
  storage: z.object({
    canonicalRetainedRows: z.number().int().nonnegative(),
    disposableDerivedRows: z.number().int().nonnegative(),
    byKind: z.object({
      episodes: z.number().int().nonnegative(),
      commissioningFacts: z.number().int().nonnegative(),
      qualityEvents: z.number().int().nonnegative(),
      analyticsGenerations: z.number().int().nonnegative(),
      analyticsRows: z.number().int().nonnegative(),
      analyticsSnapshotRows: z.number().int().nonnegative(),
      analyticsQualityEventRows: z.number().int().nonnegative(),
    }),
  }),
});
export type ProjectAnalyticsHealth = z.infer<typeof ProjectAnalyticsHealth>;

// PLNR-426: the daemon-reportable Project Intelligence CONTRACT — what a runner, driver, or VCS
// backend may assert about an episode via the upload path (apps/api/src/do/ProjectMemory.ts'
// completeEpisodeIngest). Storage/merge POLICY — how an accepted observation folds into the
// server's ProjectIntelligenceEpisode, immutable commissioning fingerprints, last-writer-wins per
// metric envelope, server-stamped acceptedAt — deliberately stays server-side, in
// apps/api/src/memory/episode-intelligence.ts: a daemon has no business knowing HOW its facts are
// merged, only WHAT it is allowed to assert. This file is vendored wholesale into the Runner repo,
// so it can `safeParse` its own upload payload before sending it.

/**
 * Daemon-legal subsets of MetricProvenance / IntelligenceSource. Each is declared as a `const`
 * tuple checked with `satisfies readonly MetricProvenance[]` (resp. `IntelligenceSource[]`), so a
 * typo or a value that has drifted out of its parent enum fails `npx tsc --noEmit` at THIS
 * declaration — not silently at runtime, three function calls later, as an entire discarded
 * episode. That gap is exactly what PLNR-426 closes: `provenance: 'unavailable'` was legal in
 * `MetricProvenance` but absent from the old hand-written `Set`, so it parsed clean against the
 * vendored `EpisodeStageFact`, passed the Runner's typecheck/lint/tests, and still failed
 * `daemonMetric`'s refine server-side — discarding the whole episode behind an HTTP 200.
 *
 * Membership must be preserved exactly: `server_observed` / `inferred` stay server-only (a daemon
 * cannot forge a server-observed fact), and `unavailable` — the common case when, say, a Codex
 * reviewer reports tokens but never sets a cost field — must stay allowed.
 */
const DAEMON_PROVENANCE_VALUES = [
  'runner_observed',
  'driver_reported',
  'backend_observed',
  'derived',
  'unavailable',
] as const satisfies readonly MetricProvenance[];
export const DAEMON_PROVENANCE: ReadonlySet<string> = new Set(DAEMON_PROVENANCE_VALUES);

const DAEMON_SOURCE_VALUES = [
  'runner',
  'driver',
  'vcs_backend',
] as const satisfies readonly IntelligenceSource[];
export const DAEMON_SOURCES: ReadonlySet<string> = new Set(DAEMON_SOURCE_VALUES);

type DaemonAssertableMetric = { provenance: string; source: string };

function isDaemonObservation(metric: DaemonAssertableMetric): boolean {
  return DAEMON_PROVENANCE.has(metric.provenance) && DAEMON_SOURCES.has(metric.source);
}

const daemonMetric = <T extends DaemonAssertableMetric>(schema: z.ZodType<T>) => schema.refine(isDaemonObservation, {
  message: 'daemon intelligence must carry runner, driver, or VCS-backend provenance',
});

const UploadedEpisodeStageFact = EpisodeStageFact.extend({
  elapsedMs: daemonMetric(EpisodeStageFact.shape.elapsedMs),
  tokens: daemonMetric(EpisodeStageFact.shape.tokens),
  costUSD: daemonMetric(EpisodeStageFact.shape.costUSD),
});

const UploadedBackendChangeStats = z.object({
  backend: BackendChangeStats.shape.backend.optional(),
  changedFiles: daemonMetric(BackendChangeStats.shape.changedFiles).optional(),
  additions: daemonMetric(BackendChangeStats.shape.additions).optional(),
  deletions: daemonMetric(BackendChangeStats.shape.deletions).optional(),
  churn: daemonMetric(BackendChangeStats.shape.churn).optional(),
});

/**
 * The only Project Intelligence facts an episode-uploading daemon may assert. Everything else in
 * ProjectIntelligenceEpisode is server-owned and is stripped at the ingest boundary, including
 * identity, source watermarks, algorithm versions, commissioning task/spec/strategy/budget,
 * outcome, executed strategy, and executed spec.
 */
export const UploadedEpisodeIntelligence = z.object({
  preExecution: z.object({
    configuration: z.array(ConfigurationFingerprint).optional(),
  }).optional(),
  execution: z.object({
    observedModelUsage: daemonMetric(IntelligenceModelUsageMetric).optional(),
    clocks: z.object({
      verifyDurationMs: daemonMetric(IntelligenceDurationMs).optional(),
    }).optional(),
    stages: z.array(UploadedEpisodeStageFact).optional(),
    changes: UploadedBackendChangeStats.optional(),
  }).optional(),
  /** PLNR-433: entirely daemon-observed — the Runner is the only party that ever sees its own
   * `ContextPack`, so unlike `preExecution`/`execution` above (which mix server- and daemon-owned
   * fields), this is asserted as one whole metric, refined by the SAME `daemonMetric` guard every
   * other uploaded metric carries, so a Runner vendoring only packages/shared can `safeParse` its
   * own context-facts payload before sending it (the whole point of PLNR-426). */
  contextConsumption: daemonMetric(IntelligenceContextConsumptionMetric).optional(),
});
export type UploadedEpisodeIntelligence = z.infer<typeof UploadedEpisodeIntelligence>;
