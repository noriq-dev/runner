import { z } from 'zod';
import type { MissionState } from './model';
import { missionExecutionPlanFingerprint } from './plan-identity';
import type { MissionGuideProposal } from './protocol';

export type GuideCompletionOutcome = 'succeeded' | 'failed' | 'cancelled';

/**
 * The guide's deliberately small vocabulary. Authority-bearing fields are absent: a guide selects
 * an immutable profile id and the harness copies its complete posture from durable mission state.
 */
export type MissionGuideAction =
  | {
      type: 'dispatch_child';
      childId: string;
      profileId: string;
      instruction: string;
      subjectCheckpointId?: string | null;
    }
  | { type: 'adopt_plan'; plannerChildId: string; planFingerprint: string }
  | { type: 'cancel_child'; childId: string; reason: string }
  | { type: 'ask_human'; question: string }
  | {
      type: 'propose_completion';
      outcome: GuideCompletionOutcome;
      reason: string;
      checkpointId?: string | null;
    };

export interface MissionGuideEnvelope {
  missionId: string;
  guideEpoch: number;
  expectedRevision: number;
  actionId: string;
  action: MissionGuideAction;
}

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const RESERVED_RECORD_KEYS = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);
const boundedRecordKey = (max: number) =>
  boundedText(max).refine((key) => !RESERVED_RECORD_KEYS.has(key), 'reserved object key is not allowed');
const checkpointId = boundedRecordKey(512);
const childId = boundedRecordKey(256);
const profileId = boundedRecordKey(256);

const guideActionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('dispatch_child'),
    childId,
    profileId,
    instruction: boundedText(32_000),
    subjectCheckpointId: z.union([checkpointId, z.null()]).optional(),
  }),
  z.strictObject({
    type: z.literal('adopt_plan'),
    plannerChildId: childId,
    planFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({
    type: z.literal('cancel_child'),
    childId,
    reason: boundedText(8_000),
  }),
  z.strictObject({ type: z.literal('ask_human'), question: boundedText(8_000) }),
  z.strictObject({
    type: z.literal('propose_completion'),
    outcome: z.enum(['succeeded', 'failed', 'cancelled']),
    reason: boundedText(16_000),
    checkpointId: z.union([checkpointId, z.null()]).optional(),
  }),
]);

export const missionGuideEnvelopeSchema = z.strictObject({
  missionId: boundedText(1_024),
  guideEpoch: z.number().int().nonnegative(),
  expectedRevision: z.number().int().nonnegative(),
  // The value is also embedded in the durable `question:<actionId>` identity. Keep the envelope
  // bound below the kernel's 256-character question-id ceiling so a schema-valid ask cannot turn
  // into a deterministic dispatch failure after an expensive guide call.
  actionId: boundedText(160),
  action: guideActionSchema,
});

export type MissionGuideParseResult =
  | { ok: true; envelope: MissionGuideEnvelope }
  | { ok: false; reason: string };

/** Parse one strict JSON value. Fences, commentary, extra keys, and unknown actions are refused. */
export function parseMissionGuideEnvelope(output: string): MissionGuideParseResult {
  let candidate: unknown;
  try {
    candidate = JSON.parse(output);
  } catch {
    return { ok: false, reason: 'guide output is not one JSON value' };
  }
  const parsed = missionGuideEnvelopeSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, reason: 'guide output does not match the action schema' };
  return { ok: true, envelope: parsed.data };
}

export type GuideTranslationResult =
  | { ok: true; action: MissionGuideProposal }
  | { ok: false; reason: string };

const isReviewerProfile = (profile: MissionState['profiles'][string]): boolean =>
  profile.permission === 'read' &&
  profile.driverPosture.kind === 'verify' &&
  profile.driverPosture.permission.write === false &&
  (profile.driverPosture.lineageRole === 'reviewer' || profile.driverPosture.lineageRole === 'verifier');

/** Resolve a guide proposal through immutable authority snapshotted in mission state. */
export function translateMissionGuideAction(
  state: MissionState,
  actionId: string,
  guideEpoch: number,
  action: MissionGuideAction,
): GuideTranslationResult {
  switch (action.type) {
    case 'dispatch_child': {
      const profile = Object.hasOwn(state.profiles, action.profileId)
        ? state.profiles[action.profileId]
        : undefined;
      if (!profile) return { ok: false, reason: `unknown execution profile '${action.profileId}'` };
      if (action.subjectCheckpointId != null) {
        if (!Object.hasOwn(state.checkpoints, action.subjectCheckpointId)) {
          return {
            ok: false,
            reason: `unknown subject checkpoint '${action.subjectCheckpointId}'`,
          };
        }
        if (!isReviewerProfile(profile)) {
          return {
            ok: false,
            reason: 'a checkpoint subject requires an authorized read-only reviewer or verifier profile',
          };
        }
      } else if (isReviewerProfile(profile)) {
        return {
          ok: false,
          reason: 'an authorized reviewer or verifier requires an exact checkpoint subject',
        };
      }
      return {
        ok: true,
        action: {
          type: 'spawn-child',
          guideEpoch,
          childId: action.childId,
          instruction: action.instruction,
          ...(action.subjectCheckpointId !== undefined
            ? { subjectCheckpointId: action.subjectCheckpointId }
            : {}),
          planStepId: null,
          profileId: profile.profileId,
          role: profile.role,
          permission: profile.permission,
          agent: { ...profile.agent },
          driverPosture: {
            ...profile.driverPosture,
            permission: {
              ...profile.driverPosture.permission,
              allow: [...profile.driverPosture.permission.allow],
              deny: [...profile.driverPosture.permission.deny],
            },
          },
          budget: { ...profile.budget },
          resources: { ...profile.resources },
          projectMcp: profile.projectMcp.map((grant) => ({
            server: grant.server,
            tools: [...grant.tools],
          })),
        },
      };
    }
    case 'adopt_plan': {
      const planner = Object.hasOwn(state.children, action.plannerChildId)
        ? state.children[action.plannerChildId]
        : undefined;
      if (!planner || planner.status !== 'succeeded' || planner.artifact?.type !== 'execution-plan') {
        return { ok: false, reason: `child '${action.plannerChildId}' has no successful execution plan` };
      }
      const planFingerprint = missionExecutionPlanFingerprint(planner.artifact);
      if (action.planFingerprint !== planFingerprint) {
        return { ok: false, reason: 'plan fingerprint differs from the complete projected artifact' };
      }
      return {
        ok: true,
        action: {
          type: 'adopt-execution-plan',
          guideEpoch,
          plannerChildId: action.plannerChildId,
          planFingerprint,
        },
      };
    }
    case 'propose_completion':
      return {
        ok: true,
        action: {
          type: 'complete-mission',
          guideEpoch,
          outcome: action.outcome,
          reason: action.reason,
          ...(action.checkpointId !== undefined ? { checkpointId: action.checkpointId } : {}),
        },
      };
    case 'cancel_child':
      return {
        ok: true,
        action: {
          type: 'request-child-cancel',
          guideEpoch,
          childId: action.childId,
          reason: action.reason,
        },
      };
    case 'ask_human':
      return {
        ok: true,
        action: {
          type: 'raise-question',
          guideEpoch,
          questionId: `question:${actionId}`,
          prompt: action.question,
        },
      };
  }
}

export const MISSION_GUIDE_ACTION_SCHEMA = JSON.stringify(
  {
    envelope: {
      missionId: '<copy projection.missionId>',
      guideEpoch: '<copy projection.guideEpoch>',
      expectedRevision: '<copy projection.revision>',
      actionId: '<stable unique string; reuse it for a retry of the same proposal>',
      action: '<exactly one action below>',
    },
    actions: [
      {
        type: 'dispatch_child',
        childId: '<unique string>',
        profileId: '<one profileId offered in projection.profiles>',
        instruction: '<bounded objective and expected evidence>',
        subjectCheckpointId: '<optional exact checkpoint id or null>',
      },
      {
        type: 'adopt_plan',
        plannerChildId: '<successful planner child with an execution-plan artifact>',
        planFingerprint: '<copy pendingPlan.planFingerprint after reviewing every plan field>',
      },
      { type: 'cancel_child', childId: '<active child id>', reason: '<bounded reason>' },
      { type: 'ask_human', question: '<one blocking question>' },
      {
        type: 'propose_completion',
        outcome: '<succeeded, failed, or cancelled>',
        reason: '<bounded evidence-based reason>',
        checkpointId: '<optional exact checkpoint id or null>',
      },
    ],
    rule: 'No additional fields are allowed at any level.',
  },
  null,
  2,
);
