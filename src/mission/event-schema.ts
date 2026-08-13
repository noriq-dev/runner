import { z } from 'zod';
import {
  MAX_MISSION_CHILD_INSTRUCTION_CHARS,
  MAX_MISSION_GUIDE_TURNS,
  MAX_MISSION_OBJECTIVE_CHARS,
  MAX_MISSION_PLAN_ACCEPTANCE_CHARS,
  MAX_MISSION_PLAN_ACCEPTANCE_ITEMS,
  MAX_MISSION_PLAN_INSTRUCTION_CHARS,
  MAX_MISSION_PLAN_STEPS,
  MAX_MISSION_PLAN_SUMMARY_CHARS,
  MAX_MISSION_REVIEW_SUMMARY_CHARS,
  MAX_MISSION_VALIDATION_OUTPUT_BYTES,
} from './protocol';
import type { MissionEvent } from './protocol';

const MAX_RESOURCE_KEYS = 128;
const UNSAFE_OBJECT_KEYS = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);

const boundedText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, 'must contain non-whitespace text');
const boundedRecordKey = (max: number) =>
  boundedText(max).refine((key) => !UNSAFE_OBJECT_KEYS.has(key), 'reserved object key is not allowed');

const safeNonNegativeInteger = z
  .number()
  .refine((value) => Number.isSafeInteger(value) && value >= 0, 'must be a non-negative safe integer');
const finiteNonNegativeNumber = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);

const nullableBudgetInteger = z.union([safeNonNegativeInteger, z.null()]);
const nullableBudgetNumber = z.union([finiteNonNegativeNumber, z.null()]);

const budgetSchema = z.strictObject({
  tokens: nullableBudgetInteger,
  usd: nullableBudgetNumber,
  activeSeconds: nullableBudgetNumber,
});

const usageSchema = z.strictObject({
  tokens: nullableBudgetInteger,
  usd: nullableBudgetNumber,
  activeSeconds: nullableBudgetNumber,
});
const reviewArtifactSchema = z.strictObject({
  type: z.literal('review'),
  checkpointId: boundedText(512),
  revisionId: boundedText(512),
  verdict: z.enum(['passed', 'changes-requested']),
  highestSeverity: z.enum(['none', 'low', 'medium', 'high', 'critical']),
  summary: boundedText(MAX_MISSION_REVIEW_SUMMARY_CHARS),
});
const executionPlanStepSchema = z.strictObject({
  id: boundedRecordKey(128),
  title: boundedText(256),
  profileId: boundedRecordKey(256),
  reviewProfileId: boundedRecordKey(256).optional(),
  instruction: boundedText(MAX_MISSION_PLAN_INSTRUCTION_CHARS),
  acceptance: z
    .array(boundedText(MAX_MISSION_PLAN_ACCEPTANCE_CHARS))
    .min(1)
    .max(MAX_MISSION_PLAN_ACCEPTANCE_ITEMS),
});
const executionPlanArtifactSchema = z.strictObject({
  type: z.literal('execution-plan'),
  summary: boundedText(MAX_MISSION_PLAN_SUMMARY_CHARS),
  steps: z
    .array(executionPlanStepSchema)
    .min(1)
    .max(MAX_MISSION_PLAN_STEPS)
    .refine(
      (steps) => new Set(steps.map((step) => step.id)).size === steps.length,
      'plan step ids must be unique',
    ),
});
const childArtifactSchema = z.discriminatedUnion('type', [reviewArtifactSchema, executionPlanArtifactSchema]);

const resourceKeySchema = boundedRecordKey(128);

function resourcesSchema(allowZero: boolean) {
  const units = z
    .number()
    .refine(
      (value) => Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0),
      allowZero ? 'must be a non-negative safe integer' : 'must be a positive safe integer',
    );
  return z
    .record(resourceKeySchema, units)
    .refine((resources) => Object.keys(resources).length <= MAX_RESOURCE_KEYS, {
      message: `must contain at most ${MAX_RESOURCE_KEYS} resource keys`,
    });
}

const objectiveSchema = z.strictObject({
  brief: boundedText(MAX_MISSION_OBJECTIVE_CHARS),
  taskId: boundedText(256).optional(),
  runId: boundedText(256).optional(),
  repositoryKey: boundedText(256).optional(),
  baseRevision: boundedText(512).optional(),
});

const completionPolicySchema = z.strictObject({
  requireCheckpoint: z.boolean(),
  requireReview: z.boolean(),
});

const validationPolicySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('command'),
    policyId: boundedRecordKey(256),
    command: boundedText(16_384),
    timeoutSeconds: z.number().int().positive().max(86_400),
    shell: z.union([boundedText(512), z.null()]),
  }),
  z.strictObject({
    kind: z.literal('none'),
    policyId: boundedRecordKey(256),
    reason: boundedText(16_384),
  }),
]);

const agentSelectionSchema = z.strictObject({
  driver: boundedText(128),
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
});

const uniqueBoundedRules = z
  .array(boundedText(512))
  .max(256)
  .refine((rules) => new Set(rules).size === rules.length, 'permission rules must be unique');

const driverPostureSchema = z.strictObject({
  kind: z.enum(['scope', 'build', 'verify']),
  permission: z.strictObject({
    write: z.boolean(),
    allow: uniqueBoundedRules,
    deny: uniqueBoundedRules,
    auto: z.boolean(),
  }),
  lineageRole: z.enum(['planner', 'worker', 'reviewer', 'verifier', 'repair', 'system']),
});

const projectMcpGrantSchema = z.strictObject({
  server: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  tools: z
    .array(
      z
        .string()
        .min(1)
        .max(256)
        .refine((tool) => tool === tool.trim() && !tool.includes('*'), 'must be an exact tool name'),
    )
    .min(1)
    .max(256)
    .refine((tools) => new Set(tools).size === tools.length, 'tool grants must be unique'),
});

const projectMcpGrantsSchema = z
  .array(projectMcpGrantSchema)
  .max(16)
  .refine(
    (grants) => new Set(grants.map((grant) => grant.server)).size === grants.length,
    'project MCP server grants must be unique',
  );

const guideProfileSchema = z.strictObject({
  profileId: boundedRecordKey(256),
  agent: agentSelectionSchema,
  budget: budgetSchema,
  turnLimit: z.number().int().positive().max(MAX_MISSION_GUIDE_TURNS),
});

const reviewAssuranceSchema = z.strictObject({
  rank: z.number().refine((value) => Number.isSafeInteger(value) && value > 0, {
    message: 'assurance rank must be a positive safe integer',
  }),
  independenceClass: boundedRecordKey(128),
});

const projectMcpFingerprintSchema = z.union([z.string().regex(/^[a-f0-9]{64}$/), z.null()]);

const executionProfileSchema = z.strictObject({
  profileId: boundedRecordKey(256),
  role: boundedText(128),
  permission: z.enum(['read', 'write']),
  agent: agentSelectionSchema,
  assurance: reviewAssuranceSchema,
  driverPosture: driverPostureSchema,
  budget: budgetSchema,
  resources: resourcesSchema(false),
  projectMcp: projectMcpGrantsSchema,
});

const executionProfilesSchema = z
  .array(executionProfileSchema)
  .min(1)
  .max(64)
  .refine(
    (profiles) => new Set(profiles.map((profile) => profile.profileId)).size === profiles.length,
    'execution profile ids must be unique',
  );

const cleanupSchema = z
  .array(boundedRecordKey(256))
  .max(128)
  .refine((cleanup) => new Set(cleanup).size === cleanup.length, 'cleanup ids must be unique');

const guideEpochSchema = safeNonNegativeInteger;
const childIdSchema = boundedRecordKey(256);
const planStepIdSchema = boundedRecordKey(128);
const checkpointIdSchema = boundedRecordKey(512);
const turnIdSchema = boundedRecordKey(256);
const questionIdSchema = boundedRecordKey(256);
const reviewIdSchema = boundedRecordKey(256);
const cleanupIdSchema = boundedRecordKey(256);
const revisionIdSchema = boundedText(512);
const validationIdSchema = boundedRecordKey(256);
const policyIdSchema = boundedRecordKey(256);
const validationOutputTailSchema = z
  .string()
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= MAX_MISSION_VALIDATION_OUTPUT_BYTES,
    `must be at most ${MAX_MISSION_VALIDATION_OUTPUT_BYTES} UTF-8 bytes`,
  );

const childSpecSchema = z.strictObject({
  childId: childIdSchema,
  role: boundedText(128),
  instruction: boundedText(MAX_MISSION_CHILD_INSTRUCTION_CHARS),
  permission: z.enum(['read', 'write']),
  agent: agentSelectionSchema,
  driverPosture: driverPostureSchema,
  profileId: boundedRecordKey(256),
  budget: budgetSchema,
  resources: resourcesSchema(false),
  projectMcp: projectMcpGrantsSchema,
  subjectCheckpointId: z.union([checkpointIdSchema, z.null()]).optional(),
  planStepId: z.union([planStepIdSchema, z.null()]).optional(),
});

const spawnChildProposalSchema = z.strictObject({
  type: z.literal('spawn-child'),
  guideEpoch: guideEpochSchema,
  ...childSpecSchema.shape,
});

const requestChildCancelProposalSchema = z.strictObject({
  type: z.literal('request-child-cancel'),
  guideEpoch: guideEpochSchema,
  childId: childIdSchema,
  reason: boundedText(16_384),
});

const raiseQuestionProposalSchema = z.strictObject({
  type: z.literal('raise-question'),
  guideEpoch: guideEpochSchema,
  questionId: questionIdSchema,
  prompt: boundedText(32_000),
});

const completeMissionProposalSchema = z.strictObject({
  type: z.literal('complete-mission'),
  guideEpoch: guideEpochSchema,
  outcome: z.enum(['succeeded', 'failed', 'cancelled']),
  reason: boundedText(64_000),
  checkpointId: z.union([checkpointIdSchema, z.null()]).optional(),
});

const adoptExecutionPlanProposalSchema = z.strictObject({
  type: z.literal('adopt-execution-plan'),
  guideEpoch: guideEpochSchema,
  plannerChildId: childIdSchema,
  planFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

const guideProposalSchema = z.discriminatedUnion('type', [
  spawnChildProposalSchema,
  adoptExecutionPlanProposalSchema,
  requestChildCancelProposalSchema,
  raiseQuestionProposalSchema,
  completeMissionProposalSchema,
]);

const budgetConstraintSchema = z.strictObject({
  type: z.literal('budget-constraint-triggered'),
  constraintId: boundedText(512),
  scope: z.enum(['mission', 'child', 'guide']),
  childId: childIdSchema.optional(),
  turnId: turnIdSchema.optional(),
  axis: z.enum(['tokens', 'usd', 'activeSeconds']),
  reason: z.enum(['exceeded', 'unknown']),
  observed: z.union([finiteNonNegativeNumber, z.null()]),
  limit: finiteNonNegativeNumber,
});

/** Strict runtime schema for every event accepted by a mission store or reducer boundary. */
const missionEventBaseSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('mission-created'),
    objective: objectiveSchema.optional(),
    projectMcpDeclarationFingerprint: projectMcpFingerprintSchema,
    budget: budgetSchema,
    resources: resourcesSchema(true),
    guide: guideProfileSchema,
    profiles: executionProfilesSchema,
    validationPolicy: validationPolicySchema,
    completion: completionPolicySchema.optional(),
    cleanup: cleanupSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('execution-plan-adopted'),
    plannerChildId: childIdSchema,
    guideEpoch: guideEpochSchema,
    planFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    plan: executionPlanArtifactSchema,
  }),
  z.strictObject({
    type: z.literal('guide-turn-started'),
    turnId: turnIdSchema,
    guideEpoch: guideEpochSchema,
    profileId: boundedRecordKey(256),
    budget: budgetSchema,
  }),
  z.strictObject({
    type: z.literal('guide-turn-completed'),
    turnId: turnIdSchema,
    outcome: z.enum(['proposed', 'failed', 'cancelled', 'lost']),
    summary: boundedText(64_000),
    usage: usageSchema,
    proposal: z.union([guideProposalSchema, z.null()]),
  }),
  z.strictObject({
    type: z.literal('guide-proposal-applied'),
    turnId: turnIdSchema,
  }),
  z.strictObject({
    type: z.literal('child-reserved'),
    child: childSpecSchema,
    guideEpoch: guideEpochSchema,
  }),
  z.strictObject({
    type: z.literal('child-started'),
    childId: childIdSchema,
    attemptId: boundedText(256),
    sessionId: z.union([boundedText(512), z.null()]).optional(),
  }),
  z.strictObject({
    type: z.literal('child-usage-observed'),
    childId: childIdSchema,
    usage: usageSchema,
  }),
  z.strictObject({
    type: z.literal('child-cancel-requested'),
    childId: childIdSchema,
    reason: boundedText(16_384),
    guideEpoch: guideEpochSchema,
  }),
  z.strictObject({
    type: z.literal('child-completed'),
    childId: childIdSchema,
    outcome: z.enum(['succeeded', 'failed', 'cancelled', 'lost']),
    summary: boundedText(64_000),
    usage: usageSchema,
    artifact: childArtifactSchema.optional(),
  }),
  budgetConstraintSchema,
  z.strictObject({
    type: z.literal('checkpoint-recorded'),
    checkpointId: checkpointIdSchema,
    revisionId: revisionIdSchema,
    authorChildId: z.union([childIdSchema, z.null()]),
    changed: z.boolean().optional(),
    parentCheckpointId: z.union([checkpointIdSchema, z.null()]).optional(),
    clean: z.boolean(),
    description: boundedText(16_384).optional(),
  }),
  z.strictObject({
    type: z.literal('workspace-reconciled'),
    childId: childIdSchema,
    revisionId: revisionIdSchema,
    disposition: z.enum(['restored', 'quarantined']),
    summary: boundedText(16_384),
  }),
  z.strictObject({
    type: z.literal('review-recorded'),
    reviewId: reviewIdSchema,
    reviewerChildId: childIdSchema,
    checkpointId: checkpointIdSchema,
    revisionId: revisionIdSchema,
    verdict: z.enum(['passed', 'changes-requested']),
    highestSeverity: z.enum(['none', 'low', 'medium', 'high', 'critical']),
    summary: boundedText(MAX_MISSION_REVIEW_SUMMARY_CHARS),
  }),
  z.strictObject({
    type: z.literal('validation-started'),
    validationId: validationIdSchema,
    checkpointId: checkpointIdSchema,
    revisionId: revisionIdSchema,
    policyId: policyIdSchema,
  }),
  z.strictObject({
    type: z.literal('validation-recorded'),
    validationId: validationIdSchema,
    checkpointId: z.union([checkpointIdSchema, z.null()]),
    revisionId: z.union([revisionIdSchema, z.null()]),
    policyId: policyIdSchema,
    disposition: z.enum(['passed', 'failed', 'not-applicable']),
    exitCode: z.union([z.number().safe().int(), z.null()]),
    timedOut: z.boolean(),
    workspaceChanged: z.boolean(),
    outputTail: validationOutputTailSchema,
  }),
  z.strictObject({
    type: z.literal('question-raised'),
    questionId: questionIdSchema,
    prompt: boundedText(32_000),
    guideEpoch: guideEpochSchema,
  }),
  z.strictObject({
    type: z.literal('question-answered'),
    questionId: questionIdSchema,
    answer: boundedText(64_000),
  }),
  z.strictObject({
    type: z.literal('guide-replaced'),
    previousGuideEpoch: guideEpochSchema,
    guideEpoch: guideEpochSchema,
    reason: boundedText(16_384),
  }),
  z.strictObject({
    type: z.literal('mission-completed'),
    outcome: z.enum(['succeeded', 'failed', 'cancelled']),
    reason: boundedText(64_000),
    checkpointId: z.union([checkpointIdSchema, z.null()]).optional(),
    guideEpoch: guideEpochSchema,
  }),
  z.strictObject({
    type: z.literal('cleanup-required'),
    cleanupId: cleanupIdSchema,
  }),
  z.strictObject({
    type: z.literal('cleanup-completed'),
    cleanupId: cleanupIdSchema,
  }),
  z.strictObject({
    type: z.literal('cleanup-failed'),
    cleanupId: cleanupIdSchema,
    error: boundedText(16_384),
  }),
  z.strictObject({
    type: z.literal('accepted-revision-handoff-recorded'),
    backend: boundedText(128),
    repositoryKey: boundedText(256),
    checkpointId: checkpointIdSchema,
    revisionId: revisionIdSchema,
    reference: boundedText(2_048),
    status: z.literal('preserved'),
  }),
]);

/** Strict runtime schema for every event accepted by a mission store or reducer boundary. */
export const missionEventSchema = missionEventBaseSchema.superRefine((event, context) => {
  if (event.type === 'mission-created') {
    const hasProjectGrants = event.profiles.some((profile) => profile.projectMcp.length > 0);
    if (hasProjectGrants !== (event.projectMcpDeclarationFingerprint !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'project MCP grants require exactly one trusted declaration fingerprint',
      });
    }
    return;
  }
  if (event.type === 'guide-turn-completed') {
    if ((event.outcome === 'proposed') !== (event.proposal !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'only a proposed guide turn may carry a resolved proposal',
      });
    }
    return;
  }
  if (event.type === 'validation-recorded') {
    if ((event.checkpointId === null) !== (event.revisionId === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'validation checkpoint and revision must either both be null or both be present',
      });
    }
    if (event.disposition === 'passed' && (event.exitCode !== 0 || event.timedOut)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'passed validation requires exit code zero' });
    }
    if (event.disposition === 'passed' && event.workspaceChanged) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'changed workspace cannot pass validation' });
    }
    if (event.disposition === 'not-applicable' && (event.exitCode !== null || event.timedOut)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'not-applicable validation cannot have an exit code or timeout',
      });
    }
    if (event.disposition === 'not-applicable' && event.workspaceChanged) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'not-applicable validation has no workspace effect',
      });
    }
    if (
      event.disposition === 'failed' &&
      event.exitCode === 0 &&
      !event.timedOut &&
      !event.workspaceChanged
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'failed validation requires process failure, timeout, or quarantined workspace changes',
      });
    }
    return;
  }
  if (event.type !== 'budget-constraint-triggered') return;

  if (event.scope === 'child') {
    if (event.childId === undefined || event.turnId !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'child constraints require only childId' });
    }
  } else if (event.scope === 'guide') {
    if (event.turnId === undefined || event.childId !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'guide constraints require only turnId' });
    }
  } else if (event.childId !== undefined || event.turnId !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'mission constraints cannot name a child or guide turn',
    });
  }

  if (event.axis === 'tokens') {
    if (!Number.isSafeInteger(event.limit)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'token limit must be a safe integer' });
    }
    if (event.observed !== null && !Number.isSafeInteger(event.observed)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'observed tokens must be a safe integer' });
    }
  }
  if (event.reason === 'unknown' && event.observed !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'unknown constraints require null observed' });
  }
  if (event.reason === 'exceeded' && event.observed === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'exceeded constraints require observed' });
  }
});

export class MissionEventValidationError extends Error {
  override readonly name = 'MissionEventValidationError';
}

export type MissionEventValidationResult =
  | { success: true; event: MissionEvent }
  | { success: false; error: MissionEventValidationError };

function inspectPlainData(value: unknown, path: string, seen: WeakSet<object>): string | null {
  if (value === undefined) return `${path} contains undefined`;
  if (typeof value === 'number' && !Number.isFinite(value)) return `${path} contains a non-finite number`;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return null;
  }
  if (typeof value !== 'object') return `${path} is not JSON data`;
  if (seen.has(value)) return `${path} contains a cycle`;
  seen.add(value);
  try {
    const expectedPrototype = Array.isArray(value) ? Array.prototype : Object.prototype;
    if (Object.getPrototypeOf(value) !== expectedPrototype) return `${path} has a custom prototype`;

    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length > 0) return `${path} contains a symbol key`;

    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        if (!Object.hasOwn(descriptors, key)) return `${path} contains a sparse array`;
        const descriptor = descriptors[key];
        if (!descriptor || !('value' in descriptor)) return `${path}[${index}] is an accessor`;
        const issue = inspectPlainData(descriptor.value, `${path}[${index}]`, seen);
        if (issue) return issue;
      }
      const allowedKeys = new Set(['length']);
      for (let index = 0; index < value.length; index += 1) allowedKeys.add(String(index));
      for (const key of Object.keys(descriptors)) {
        if (!allowedKeys.has(key)) return `${path} contains a non-index array key`;
      }
      return null;
    }

    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (UNSAFE_OBJECT_KEYS.has(key)) return `${path} contains a reserved object key`;
      if (!descriptor.enumerable) return `${path}.${key} is not enumerable`;
      if (!('value' in descriptor)) return `${path}.${key} is an accessor`;
      const issue = inspectPlainData(descriptor.value, `${path}.${key}`, seen);
      if (issue) return issue;
    }
    return null;
  } finally {
    seen.delete(value);
  }
}

/**
 * Validate an unknown event before it is persisted or reduced. Validation never invokes accessors
 * and returns a detached, plain event on success.
 */
export function validateMissionEvent(candidate: unknown): MissionEventValidationResult {
  let structuralIssue: string | null;
  try {
    structuralIssue = inspectPlainData(candidate, 'event', new WeakSet());
  } catch {
    structuralIssue = 'event cannot be safely inspected';
  }
  if (structuralIssue) {
    return { success: false, error: new MissionEventValidationError(structuralIssue) };
  }

  const parsed = missionEventSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      success: false,
      error: new MissionEventValidationError('event does not match the strict mission event schema'),
    };
  }
  return { success: true, event: parsed.data as MissionEvent };
}

/** Parse an unknown event, throwing `MissionEventValidationError` when it is malformed. */
export function parseMissionEvent(candidate: unknown): MissionEvent {
  const result = validateMissionEvent(candidate);
  if (!result.success) throw result.error;
  return result.event;
}
