import { createHash } from 'node:crypto';
import type { MissionExecutionPlanArtifact } from './protocol';
import { canonicalMissionJson } from './store';

/** Identity of the complete planner artifact presented to and authorized by the guide. */
export function missionExecutionPlanFingerprint(plan: MissionExecutionPlanArtifact): string {
  return createHash('sha256').update(canonicalMissionJson(plan), 'utf8').digest('hex');
}

/**
 * Opaque identity for one step of one adopted planner artifact.
 *
 * Planner-authored step ids are only unique inside their artifact. Including the mission and
 * planner child prevents evidence from a superseded plan with the same human step id from being
 * mistaken for work on the current plan.
 */
export function missionPlanStepKey(missionId: string, plannerChildId: string, plannerStepId: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([missionId, plannerChildId, plannerStepId]), 'utf8')
    .digest('hex');
  return `plan-${digest}`;
}

/**
 * Kernel-verifiable child identity for one deterministic attempt of an adopted plan step.
 *
 * Round zero preserves the original scheduler identities. Later rounds distinguish both the
 * repair writer and its exact reviewer, so replay can only reattach to the already-authorized
 * attempt rather than accidentally dispatching another copy.
 */
export function missionPlanChildId(
  missionId: string,
  plannerChildId: string,
  plannerStepId: string,
  kind: 'work' | 'review',
  round: number,
): string {
  const effectKind = round === 0 ? `plan-${kind}` : kind === 'work' ? 'plan-repair' : 'plan-repair-review';
  const values =
    round === 0
      ? [missionId, plannerChildId, plannerStepId]
      : [missionId, plannerChildId, plannerStepId, round];
  const digest = createHash('sha256').update(canonicalMissionJson(values), 'utf8').digest('hex');
  return `${effectKind}:${digest.slice(0, 48)}`;
}
