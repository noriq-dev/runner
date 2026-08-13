import {
  type MissionChildState,
  type MissionState,
  childIsTerminal,
  governingReviewForCheckpoint,
  governingValidationForCheckpoint,
  latestCheckpoint,
  missionChildrenInOrder,
  unreconciledTerminalWriteChild,
  workspaceReconciliationForChild,
} from './model';
import { missionExecutionPlanFingerprint, missionPlanChildId, missionPlanStepKey } from './plan-identity';
import { profileCanIndependentlyReview } from './profile-catalog';
import {
  MAX_MISSION_CHILDREN,
  MAX_MISSION_CHILD_INSTRUCTION_CHARS,
  MAX_MISSION_EXECUTION_PLAN_BYTES,
  MAX_MISSION_GUIDE_TURNS,
  MAX_MISSION_OBJECTIVE_CHARS,
  MAX_MISSION_PLAN_ACCEPTANCE_CHARS,
  MAX_MISSION_PLAN_ACCEPTANCE_ITEMS,
  MAX_MISSION_PLAN_INSTRUCTION_CHARS,
  MAX_MISSION_PLAN_REPAIR_ROUNDS,
  MAX_MISSION_PLAN_STEPS,
  MAX_MISSION_PLAN_SUMMARY_CHARS,
  MAX_MISSION_REVIEW_SUMMARY_CHARS,
  MAX_MISSION_VALIDATION_OUTPUT_BYTES,
} from './protocol';
import type {
  MissionAction,
  MissionBudget,
  MissionBudgetAxis,
  MissionEvent,
  MissionExecutionPlanArtifact,
  MissionExecutionProfile,
  MissionFindingSeverity,
  MissionUsage,
} from './protocol';
import { canonicalMissionJson } from './store';

export interface MissionDecisionAccepted {
  accepted: true;
  events: readonly MissionEvent[];
}

export interface MissionDecisionRefused {
  accepted: false;
  code:
    | 'invalid-action'
    | 'invalid-state'
    | 'stale-guide'
    | 'budget-exhausted'
    | 'resource-exhausted'
    | 'completion-unproved';
  reason: string;
}

export type MissionDecision = MissionDecisionAccepted | MissionDecisionRefused;

const accept = (...events: MissionEvent[]): MissionDecisionAccepted => ({ accepted: true, events });
const refuse = (code: MissionDecisionRefused['code'], reason: string): MissionDecisionRefused => ({
  accepted: false,
  code,
  reason,
});

const finiteNonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0;
const RESERVED_RECORD_KEYS = new Set(Object.getOwnPropertyNames(Object.prototype));

function validBudget(budget: MissionBudget): boolean {
  return (
    (budget.tokens === null || (Number.isSafeInteger(budget.tokens) && budget.tokens >= 0)) &&
    (budget.usd === null || finiteNonNegative(budget.usd)) &&
    (budget.activeSeconds === null || finiteNonNegative(budget.activeSeconds))
  );
}

function validUsage(usage: MissionUsage): boolean {
  return (
    (usage.tokens === null || (Number.isSafeInteger(usage.tokens) && usage.tokens >= 0)) &&
    (usage.usd === null || finiteNonNegative(usage.usd)) &&
    (usage.activeSeconds === null || finiteNonNegative(usage.activeSeconds))
  );
}

function validValidationPolicy(
  policy: Extract<MissionAction, { type: 'create-mission' }>['validationPolicy'],
) {
  if (!validIdentifier(policy.policyId, 256)) return false;
  if (policy.kind === 'none') return hasText(policy.reason, 16_384);
  return (
    hasText(policy.command, 16_384) &&
    Number.isSafeInteger(policy.timeoutSeconds) &&
    policy.timeoutSeconds > 0 &&
    policy.timeoutSeconds <= 86_400 &&
    (policy.shell === null || hasText(policy.shell, 512))
  );
}

function validResources(resources: Readonly<Record<string, number>>, allowZero: boolean): boolean {
  return Object.entries(resources).every(
    ([key, units]) =>
      key.length > 0 &&
      key.length <= 128 &&
      Number.isSafeInteger(units) &&
      (allowZero ? units >= 0 : units > 0),
  );
}

function validAgent(agent: { driver: string; model: string; effort?: string }): boolean {
  return (
    hasText(agent.driver, 128) &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(agent.model) &&
    (agent.effort === undefined || ['low', 'medium', 'high', 'xhigh', 'max'].includes(agent.effort))
  );
}

function validDriverPosture(posture: {
  kind: string;
  permission: { write: boolean; allow: readonly string[]; deny: readonly string[]; auto: boolean };
  lineageRole: string;
}): boolean {
  const validRules = (rules: readonly string[]): boolean =>
    Array.isArray(rules) &&
    rules.length <= 256 &&
    new Set(rules).size === rules.length &&
    rules.every((rule) => hasText(rule, 512));
  return (
    ['scope', 'build', 'verify'].includes(posture.kind) &&
    typeof posture.permission.write === 'boolean' &&
    typeof posture.permission.auto === 'boolean' &&
    validRules(posture.permission.allow) &&
    validRules(posture.permission.deny) &&
    ['planner', 'worker', 'reviewer', 'verifier', 'repair', 'system'].includes(posture.lineageRole)
  );
}

function validProjectMcp(grants: readonly { server: string; tools: readonly string[] }[]): boolean {
  return (
    Array.isArray(grants) &&
    grants.length <= 16 &&
    new Set(grants.map((grant) => grant.server)).size === grants.length &&
    grants.every(
      (grant) =>
        /^[A-Za-z0-9_-]{1,64}$/.test(grant.server) &&
        Array.isArray(grant.tools) &&
        grant.tools.length > 0 &&
        grant.tools.length <= 256 &&
        new Set(grant.tools).size === grant.tools.length &&
        grant.tools.every(
          (tool: unknown) =>
            typeof tool === 'string' && hasText(tool, 256) && tool === tool.trim() && !tool.includes('*'),
        ),
    )
  );
}

function sameProfileAuthority(
  action: Extract<MissionAction, { type: 'spawn-child' }>,
  profile: MissionState['profiles'][string],
): boolean {
  return (
    action.role === profile.role &&
    action.permission === profile.permission &&
    action.agent.driver === profile.agent.driver &&
    action.agent.model === profile.agent.model &&
    action.agent.effort === profile.agent.effort &&
    action.driverPosture.kind === profile.driverPosture.kind &&
    action.driverPosture.lineageRole === profile.driverPosture.lineageRole &&
    action.driverPosture.permission.write === profile.driverPosture.permission.write &&
    action.driverPosture.permission.auto === profile.driverPosture.permission.auto &&
    sameStringSet(action.driverPosture.permission.allow, profile.driverPosture.permission.allow) &&
    sameStringSet(action.driverPosture.permission.deny, profile.driverPosture.permission.deny) &&
    action.budget.tokens === profile.budget.tokens &&
    action.budget.usd === profile.budget.usd &&
    action.budget.activeSeconds === profile.budget.activeSeconds &&
    sameNumberRecord(action.resources, profile.resources) &&
    sameProjectMcp(action.projectMcp, profile.projectMcp)
  );
}

function validReviewAssurance(profile: MissionExecutionProfile): boolean {
  return (
    Number.isSafeInteger(profile.assurance.rank) &&
    profile.assurance.rank > 0 &&
    validIdentifier(profile.assurance.independenceClass, 128)
  );
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const expected = new Set(right);
  return left.length === expected.size && left.every((value) => expected.has(value));
}

function sameNumberRecord(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === ownValue(right, key));
}

function sameProjectMcp(
  left: readonly { server: string; tools: readonly string[] }[],
  right: readonly { server: string; tools: readonly string[] }[],
): boolean {
  if (left.length !== right.length) return false;
  const expected = new Map(right.map((grant) => [grant.server, new Set(grant.tools)]));
  return left.every((grant) => {
    const tools = expected.get(grant.server);
    return (
      tools !== undefined && tools.size === grant.tools.length && grant.tools.every((tool) => tools.has(tool))
    );
  });
}

const hasText = (value: string, max = MAX_MISSION_OBJECTIVE_CHARS): boolean =>
  value.trim().length > 0 && value.length <= max;
const validIdentifier = (value: string, max: number): boolean =>
  hasText(value, max) && !RESERVED_RECORD_KEYS.has(value);

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function activeChildren(state: MissionState) {
  return missionChildrenInOrder(state).filter((child) => !childIsTerminal(child.status));
}

const hasPendingQuestion = (state: MissionState): boolean =>
  Object.values(state.questions).some((question) => question.status === 'pending');

function reservedBudget(
  state: MissionState,
  axis: keyof MissionBudget,
  ignoredGuideTurnId?: string,
  ignoredChildId?: string,
): number | null {
  let total = 0;
  for (const child of activeChildren(state)) {
    if (child.childId === ignoredChildId) continue;
    const ceiling = child.budget[axis];
    if (ceiling === null) return null;
    const observed = child.usage[axis];
    // Unknown observed USD cannot safely release any of the child's reservation. The reservation
    // is a maximum total for the child, so known usage releases only the corresponding remainder;
    // adding the full ceiling to aggregate usage would double-count spend already observed.
    total += observed === null ? ceiling : Math.max(0, ceiling - observed);
  }
  for (const turn of Object.values(state.guideTurns)) {
    if (turn.status !== 'running' || turn.turnId === ignoredGuideTurnId) continue;
    const ceiling = turn.budget[axis];
    if (ceiling === null) return null;
    const observed = turn.usage[axis];
    total += observed === null ? ceiling : Math.max(0, ceiling - observed);
  }
  return total;
}

function usedBudget(state: MissionState, axis: keyof MissionBudget): number | null {
  return state.usage[axis];
}

function budgetAdmission(
  state: MissionState,
  requested: MissionBudget,
  ignoredGuideTurnId?: string,
): MissionDecisionRefused | null {
  for (const axis of ['tokens', 'usd', 'activeSeconds'] as const) {
    const ceiling = state.budget[axis];
    if (ceiling === null) continue;
    const used = usedBudget(state, axis);
    const held = reservedBudget(state, axis, ignoredGuideTurnId);
    const next = requested[axis];
    if (used === null || held === null || next === null) {
      return refuse(
        'budget-exhausted',
        `cannot prove ${axis} capacity because usage or reservation is unknown`,
      );
    }
    if (used + held >= ceiling || used + held + next > ceiling) {
      return refuse('budget-exhausted', `${axis} budget has no capacity for another work item`);
    }
  }
  return null;
}

function resourceAdmission(
  state: MissionState,
  requested: Readonly<Record<string, number>>,
): MissionDecisionRefused | null {
  const held: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const child of activeChildren(state)) {
    for (const [key, units] of Object.entries(child.resources)) held[key] = (held[key] ?? 0) + units;
  }
  for (const [key, units] of Object.entries(requested)) {
    const capacity = ownValue(state.resources, key);
    if (capacity === undefined || (held[key] ?? 0) + units > capacity) {
      return refuse('resource-exhausted', `resource '${key}' has no capacity for ${units} units`);
    }
  }
  return null;
}

function projectedUsage(state: MissionState, childId: string, usage: MissionUsage): MissionUsage {
  const children = Object.values(state.children).map((child) =>
    child.childId === childId ? { ...child, usage } : child,
  );
  const allUsage = [
    ...children.map((child) => child.usage),
    ...Object.values(state.guideTurns).map((turn) => turn.usage),
  ];
  return {
    tokens: allUsage.some((observed) => observed.tokens === null)
      ? null
      : allUsage.reduce((total, observed) => total + (observed.tokens ?? 0), 0),
    usd: allUsage.some((observed) => observed.usd === null)
      ? null
      : allUsage.reduce((total, observed) => total + (observed.usd ?? 0), 0),
    activeSeconds: allUsage.some((observed) => observed.activeSeconds === null)
      ? null
      : allUsage.reduce((total, observed) => total + (observed.activeSeconds ?? 0), 0),
  };
}

function constraintEvents(state: MissionState, childId: string, usage: MissionUsage): MissionEvent[] {
  const child = ownValue(state.children, childId);
  if (!child) return [];
  const missionUsage = projectedUsage(state, childId, usage);
  const events: MissionEvent[] = [];
  const inspect = (scope: 'mission' | 'child', budget: MissionBudget, observedUsage: MissionUsage) => {
    for (const axis of ['tokens', 'usd', 'activeSeconds'] as const satisfies readonly MissionBudgetAxis[]) {
      const limit = budget[axis];
      if (limit === null) continue;
      const observed = observedUsage[axis];
      const reason = observed === null ? 'unknown' : observed > limit ? 'exceeded' : null;
      if (!reason) continue;
      const constraintId = `${scope}:${scope === 'child' ? childId : 'all'}:${axis}:${reason}`;
      if (ownValue(state.budgetConstraints, constraintId)) continue;
      events.push({
        type: 'budget-constraint-triggered',
        constraintId,
        scope,
        ...(scope === 'child' ? { childId } : {}),
        axis,
        reason,
        observed,
        limit,
      });
    }
  };
  inspect('child', child.budget, usage);
  inspect('mission', state.budget, missionUsage);
  return events;
}

function usageMonotonic(previous: MissionUsage, next: MissionUsage): boolean {
  if (
    previous.activeSeconds !== null &&
    previous.activeSeconds > 0 &&
    (next.activeSeconds === null || next.activeSeconds < previous.activeSeconds)
  ) {
    return false;
  }
  if (
    previous.tokens !== null &&
    previous.tokens > 0 &&
    (next.tokens === null || next.tokens < previous.tokens)
  ) {
    return false;
  }
  // A child's synthetic pre-start zero may become unknown when its vendor first reports telemetry
  // without cost. Once a positive cost is known it may neither decrease nor disappear.
  if (previous.usd !== null && previous.usd > 0 && (next.usd === null || next.usd < previous.usd)) {
    return false;
  }
  return true;
}

const severityRank: Record<MissionFindingSeverity, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function isAuthorizedReviewer(
  subject: Pick<MissionChildState | MissionExecutionProfile, 'permission' | 'driverPosture'>,
): boolean {
  return (
    subject.permission === 'read' &&
    subject.driverPosture.kind === 'verify' &&
    !subject.driverPosture.permission.write &&
    ['reviewer', 'verifier'].includes(subject.driverPosture.lineageRole)
  );
}

function isAuthorizedPlanner(child: MissionChildState): boolean {
  return (
    child.permission === 'read' &&
    child.driverPosture.kind === 'scope' &&
    !child.driverPosture.permission.write &&
    child.driverPosture.lineageRole === 'planner'
  );
}

export interface MissionProfileAdmission {
  dispatchable: boolean;
  reason: string | null;
}

/**
 * Produce a non-authoritative availability hint for the guide. The kernel repeats every check
 * when the proposal is applied. `settlingGuideTurnId` models the reservation that will be released
 * before a successfully parsed proposal reaches child admission.
 */
export function missionProfileAdmission(
  state: MissionState,
  profile: MissionExecutionProfile,
  settlingGuideTurnId?: string,
): MissionProfileAdmission {
  const unavailable = (reason: string): MissionProfileAdmission => ({ dispatchable: false, reason });
  if (state.terminal || state.status !== 'active') return unavailable('mission is not active');
  if (hasPendingQuestion(state)) return unavailable('mission is waiting on a human answer');
  if (Object.keys(state.budgetConstraints).length > 0) {
    return unavailable('a durable budget constraint prevents new child work');
  }
  if (Object.keys(state.children).length >= MAX_MISSION_CHILDREN) {
    return unavailable(`mission reached its ${MAX_MISSION_CHILDREN}-child limit`);
  }
  const contaminatedBy = unreconciledTerminalWriteChild(state);
  if (contaminatedBy) {
    return unavailable(
      `terminal write child '${contaminatedBy.childId}' has no durable workspace reconciliation`,
    );
  }
  if (profile.budget.tokens === 0 || profile.budget.activeSeconds === 0) {
    return unavailable('profile has no positive token or active-time allowance');
  }
  if (isAuthorizedReviewer(profile) && state.checkpointOrder.length === 0) {
    return unavailable('review profile requires an exact durable checkpoint subject');
  }
  const budgetRefusal = budgetAdmission(state, profile.budget, settlingGuideTurnId);
  if (budgetRefusal) return unavailable(budgetRefusal.reason);
  const resourceRefusal = resourceAdmission(state, profile.resources);
  if (resourceRefusal) return unavailable(resourceRefusal.reason);
  return { dispatchable: true, reason: null };
}

function validateExecutionPlan(
  state: MissionState,
  child: MissionChildState,
  plan: MissionExecutionPlanArtifact,
  options: {
    /** Final planner usage is projected before its completion event enters durable state. */
    completingUsage?: MissionUsage;
    /** Approval and final completion each require their own bounded guide proposal. */
    reserveGuideTurns: number;
  },
): string | null {
  if (!isAuthorizedPlanner(child) || child.subjectCheckpointId !== null) {
    return 'execution plan requires an independent read-only scope child with planner lineage';
  }
  if (
    !hasText(plan.summary, MAX_MISSION_PLAN_SUMMARY_CHARS) ||
    plan.steps.length < 1 ||
    plan.steps.length > MAX_MISSION_PLAN_STEPS
  ) {
    return 'execution plan summary or step count is invalid';
  }
  if (new Set(plan.steps.map((step) => step.id)).size !== plan.steps.length) {
    return 'execution plan step ids must be unique';
  }
  if (Buffer.byteLength(canonicalMissionJson(plan), 'utf8') > MAX_MISSION_EXECUTION_PLAN_BYTES) {
    return `execution plan exceeds the ${MAX_MISSION_EXECUTION_PLAN_BYTES}-byte guide-approval limit`;
  }
  let requiredChildren = 0;
  const requiredBudget: Record<keyof MissionBudget, number | null> = {
    tokens: 0,
    usd: 0,
    activeSeconds: 0,
  };
  const reserveProfile = (profile: MissionExecutionProfile, attempts: number): void => {
    for (const axis of ['tokens', 'usd', 'activeSeconds'] as const) {
      const current = requiredBudget[axis];
      const ceiling = profile.budget[axis];
      if (current === null || ceiling === null) {
        requiredBudget[axis] = null;
        continue;
      }
      const total = current + ceiling * attempts;
      requiredBudget[axis] =
        Number.isFinite(total) && (axis !== 'tokens' || Number.isSafeInteger(total)) ? total : null;
    }
  };
  for (const step of plan.steps) {
    if (
      !validIdentifier(step.id, 128) ||
      !hasText(step.title, 256) ||
      !hasText(step.instruction, MAX_MISSION_PLAN_INSTRUCTION_CHARS) ||
      step.acceptance.length < 1 ||
      step.acceptance.length > MAX_MISSION_PLAN_ACCEPTANCE_ITEMS ||
      step.acceptance.some((criterion) => !hasText(criterion, MAX_MISSION_PLAN_ACCEPTANCE_CHARS))
    ) {
      return `execution plan step '${step.id}' is invalid`;
    }
    const profile = ownValue(state.profiles, step.profileId);
    if (
      !profile ||
      profile.permission !== 'write' ||
      profile.driverPosture.kind !== 'build' ||
      !profile.driverPosture.permission.write ||
      !['worker', 'repair'].includes(profile.driverPosture.lineageRole)
    ) {
      return `execution plan step '${step.id}' does not select an authorized build profile`;
    }
    if (profile.permission === 'write' && step.reviewProfileId === undefined) {
      return `execution plan step '${step.id}' requires an independent stronger review profile`;
    }
    if (step.reviewProfileId !== undefined) {
      if (profile.permission !== 'write') {
        return `execution plan step '${step.id}' cannot require checkpoint review without a write profile`;
      }
      const reviewer = ownValue(state.profiles, step.reviewProfileId);
      if (!reviewer || !isAuthorizedReviewer(reviewer)) {
        return `execution plan step '${step.id}' does not select an authorized review profile`;
      }
      if (!profileCanIndependentlyReview(profile, reviewer)) {
        return `execution plan step '${step.id}' review profile must have a higher assurance rank, different independence class, and different driver/model coordinate`;
      }
      // Admission reserves enough child identities for the initial work/review pair and every
      // bounded deterministic repair/re-review pair. A plan cannot become impossible merely by
      // reaching the mission child ceiling in the middle of an authorized repair loop.
      const attempts = MAX_MISSION_PLAN_REPAIR_ROUNDS + 1;
      requiredChildren += 2 * attempts;
      reserveProfile(profile, attempts);
      reserveProfile(reviewer, attempts);
    } else {
      requiredChildren += 1;
      reserveProfile(profile, 1);
    }
  }
  if (Object.keys(state.children).length + requiredChildren > MAX_MISSION_CHILDREN) {
    return `execution plan exceeds the ${MAX_MISSION_CHILDREN}-child mission limit`;
  }
  if (!Number.isSafeInteger(options.reserveGuideTurns) || options.reserveGuideTurns < 0) {
    return 'execution plan guide-turn reservation is invalid';
  }
  if (options.reserveGuideTurns > 0) {
    if (!state.guide) return 'execution plan cannot reserve required guide turns without a guide profile';
    for (const axis of ['tokens', 'usd', 'activeSeconds'] as const) {
      const current = requiredBudget[axis];
      const ceiling = state.guide.budget[axis];
      if (current === null || ceiling === null) {
        requiredBudget[axis] = null;
        continue;
      }
      const total = current + ceiling * options.reserveGuideTurns;
      requiredBudget[axis] =
        Number.isFinite(total) && (axis !== 'tokens' || Number.isSafeInteger(total)) ? total : null;
    }
  }
  const used = options.completingUsage
    ? projectedUsage(state, child.childId, options.completingUsage)
    : state.usage;
  for (const axis of ['tokens', 'usd', 'activeSeconds'] as const) {
    const missionCeiling = state.budget[axis];
    if (missionCeiling === null) continue;
    const observed = used[axis];
    const held = reservedBudget(state, axis, undefined, options.completingUsage ? child.childId : undefined);
    const planned = requiredBudget[axis];
    if (observed === null || held === null || planned === null) {
      return `execution plan cannot prove ${axis} feasibility under the finite mission budget`;
    }
    const total = observed + held + planned;
    if (
      !Number.isFinite(total) ||
      (axis === 'tokens' && !Number.isSafeInteger(total)) ||
      total > missionCeiling
    ) {
      return `execution plan requires up to ${planned} future ${axis}, but only ${Math.max(
        0,
        missionCeiling - observed - held,
      )} remain after observed usage and active reservations`;
    }
  }
  return null;
}

export function unresolvedActiveMissionPlan(state: MissionState): string | null {
  const active = state.activePlan;
  if (!active) return null;
  for (const step of active.plan.steps) {
    const stepKey = missionPlanStepKey(state.missionId, active.plannerChildId, step.id);
    const workers = missionChildrenInOrder(state).filter(
      (child) => child.planStepId === stepKey && child.subjectCheckpointId === null,
    );
    if (workers.length < 1 || workers.length > MAX_MISSION_PLAN_REPAIR_ROUNDS + 1) {
      return `adopted plan step '${step.id}' has no bounded worker lineage`;
    }
    for (let round = 0; round < workers.length; round += 1) {
      const worker = workers[round]!;
      if (
        worker.childId !==
          missionPlanChildId(state.missionId, active.plannerChildId, step.id, 'work', round) ||
        worker.profileId !== step.profileId ||
        worker.status !== 'succeeded'
      ) {
        return `adopted plan step '${step.id}' has an invalid worker at round ${round}`;
      }
      const checkpoints = Object.values(state.checkpoints).filter(
        (checkpoint) => checkpoint.authorChildId === worker.childId,
      );
      const checkpoint = checkpoints[0];
      if (worker.permission === 'write' && (checkpoints.length !== 1 || !checkpoint?.clean)) {
        return `adopted plan step '${step.id}' lacks one clean immutable checkpoint at round ${round}`;
      }
      if (!step.reviewProfileId) continue;
      if (!checkpoint) return `adopted plan step '${step.id}' review has no worker checkpoint`;
      const reviewers = missionChildrenInOrder(state).filter(
        (child) => child.planStepId === stepKey && child.subjectCheckpointId === checkpoint.checkpointId,
      );
      const reviewer = reviewers[0];
      if (
        reviewers.length !== 1 ||
        reviewer?.childId !==
          missionPlanChildId(state.missionId, active.plannerChildId, step.id, 'review', round) ||
        reviewer.profileId !== step.reviewProfileId ||
        reviewer.status !== 'succeeded'
      ) {
        return `adopted plan step '${step.id}' has no exact successful reviewer at round ${round}`;
      }
      const review = governingReviewForCheckpoint(state, checkpoint.checkpointId);
      if (!review || review.reviewerChildId !== reviewer.childId) {
        return `adopted plan step '${step.id}' lacks exact review evidence at round ${round}`;
      }
      const isLatestRound = round === workers.length - 1;
      if (isLatestRound) {
        if (review.verdict !== 'passed' || review.highestSeverity !== 'none') {
          return `adopted plan step '${step.id}' lacks an exact passing review`;
        }
      } else if (
        review.verdict !== 'changes-requested' ||
        !['low', 'medium'].includes(review.highestSeverity)
      ) {
        return `adopted plan step '${step.id}' has an unauthorized repair transition at round ${round}`;
      }
    }
  }
  return null;
}

export function decideMission(state: MissionState, action: MissionAction): MissionDecision {
  if (action.type === 'create-mission') {
    if (state.status !== 'uninitialized') return refuse('invalid-state', 'mission already exists');
    if (!validBudget(action.budget)) return refuse('invalid-action', 'mission budget is invalid');
    if (!validValidationPolicy(action.validationPolicy)) {
      return refuse('invalid-action', 'mission validation policy is invalid');
    }
    if (!validResources(action.resources, true))
      return refuse('invalid-action', 'resource capacities are invalid');
    if (
      !validAgent(action.guide.agent) ||
      !validBudget(action.guide.budget) ||
      !validIdentifier(action.guide.profileId, 256) ||
      !Number.isSafeInteger(action.guide.turnLimit) ||
      action.guide.turnLimit < 1 ||
      action.guide.turnLimit > MAX_MISSION_GUIDE_TURNS
    ) {
      return refuse('invalid-action', 'guide execution profile is invalid');
    }
    if (!Array.isArray(action.profiles) || action.profiles.length === 0 || action.profiles.length > 64) {
      return refuse('invalid-action', 'mission must snapshot between 1 and 64 execution profiles');
    }
    if (new Set(action.profiles.map((profile) => profile.profileId)).size !== action.profiles.length) {
      return refuse('invalid-action', 'execution profile ids must be unique');
    }
    for (const profile of action.profiles) {
      if (
        !validIdentifier(profile.profileId, 256) ||
        !hasText(profile.role, 128) ||
        !validAgent(profile.agent) ||
        !validReviewAssurance(profile) ||
        !validDriverPosture(profile.driverPosture) ||
        profile.driverPosture.permission.write !== (profile.permission === 'write') ||
        !validBudget(profile.budget) ||
        !validResources(profile.resources, false) ||
        !validProjectMcp(profile.projectMcp)
      ) {
        return refuse('invalid-action', `execution profile '${profile.profileId}' is invalid`);
      }
      for (const [key, units] of Object.entries(profile.resources) as Array<[string, number]>) {
        const capacity = ownValue(action.resources, key);
        if (capacity === undefined || units > capacity) {
          return refuse(
            'invalid-action',
            `execution profile '${profile.profileId}' exceeds resource '${key}'`,
          );
        }
      }
    }
    for (const subject of action.profiles.filter((profile) => profile.permission === 'write')) {
      if (!action.profiles.some((reviewer) => profileCanIndependentlyReview(subject, reviewer))) {
        return refuse(
          'invalid-action',
          `write profile '${subject.profileId}' has no authorized independent stronger reviewer`,
        );
      }
    }
    const hasProjectGrants = action.profiles.some((profile) => profile.projectMcp.length > 0);
    if (
      hasProjectGrants !== (action.projectMcpDeclarationFingerprint !== null) ||
      (action.projectMcpDeclarationFingerprint !== null &&
        !/^[a-f0-9]{64}$/.test(action.projectMcpDeclarationFingerprint))
    ) {
      return refuse('invalid-action', 'project MCP grants are not bound to one trusted declaration');
    }
    if (action.objective && !hasText(action.objective.brief, MAX_MISSION_OBJECTIVE_CHARS)) {
      return refuse('invalid-action', 'objective brief is empty or too large');
    }
    const cleanup = action.cleanup ?? [];
    if (new Set(cleanup).size !== cleanup.length || cleanup.some((id) => !validIdentifier(id, 256))) {
      return refuse('invalid-action', 'cleanup ids must be unique, non-empty, and bounded');
    }
    return accept({
      type: 'mission-created',
      projectMcpDeclarationFingerprint: action.projectMcpDeclarationFingerprint,
      budget: action.budget,
      resources: action.resources,
      guide: action.guide,
      profiles: action.profiles,
      validationPolicy: action.validationPolicy,
      cleanup,
      ...(action.objective ? { objective: action.objective } : {}),
      ...(action.completion ? { completion: action.completion } : {}),
    });
  }

  if (
    state.activeValidation !== null &&
    action.type !== 'record-validation' &&
    action.type !== 'complete-mission'
  ) {
    return refuse('invalid-state', 'durable validation must settle before any other mission action');
  }

  if (action.type === 'begin-guide-turn') {
    if (state.terminal) return refuse('invalid-state', 'terminal mission has no guide turn');
    if (state.status !== 'active' || !state.guide) return refuse('invalid-state', 'mission is not active');
    if (action.guideEpoch !== state.guideEpoch) {
      return refuse('stale-guide', `expected guide epoch ${state.guideEpoch}`);
    }
    if (!validIdentifier(action.turnId, 256) || ownValue(state.guideTurns, action.turnId)) {
      return refuse('invalid-action', 'guide turn id is invalid or already exists');
    }
    if (Object.values(state.guideTurns).some((turn) => turn.status === 'running')) {
      return refuse('invalid-state', 'another guide turn is already running');
    }
    if (state.guideTurnOrder.length >= state.guide.turnLimit) {
      return refuse('budget-exhausted', 'durable guide turn limit is exhausted');
    }
    if (hasPendingQuestion(state)) return refuse('invalid-state', 'mission is waiting on a human answer');
    if (Object.keys(state.budgetConstraints).length > 0) {
      return refuse('budget-exhausted', 'a durable budget constraint prevents another guide turn');
    }
    const budgetRefusal = budgetAdmission(state, state.guide.budget);
    if (budgetRefusal) return budgetRefusal;
    return accept({
      type: 'guide-turn-started',
      turnId: action.turnId,
      guideEpoch: action.guideEpoch,
      profileId: state.guide.profileId,
      budget: state.guide.budget,
    });
  }

  if (action.type === 'complete-guide-turn') {
    const turn = ownValue(state.guideTurns, action.turnId);
    if (!turn) return refuse('invalid-action', `unknown guide turn '${action.turnId}'`);
    if (turn.status !== 'running') return refuse('invalid-state', 'guide turn is already terminal');
    if (!validUsage(action.usage)) return refuse('invalid-action', 'guide usage is invalid');
    if (!hasText(action.summary, 64_000)) return refuse('invalid-action', 'guide summary is invalid');
    if ((action.outcome === 'proposed') !== (action.proposal !== null)) {
      return refuse('invalid-action', 'only a proposed guide turn may carry a resolved proposal');
    }
    const events: MissionEvent[] = [
      {
        type: 'guide-turn-completed',
        turnId: action.turnId,
        outcome: action.outcome,
        summary: action.summary,
        usage: action.usage,
        proposal: action.proposal,
      },
    ];
    const projectedMission: MissionUsage = {
      tokens:
        state.usage.tokens === null || action.usage.tokens === null
          ? null
          : state.usage.tokens + action.usage.tokens,
      usd: state.usage.usd === null || action.usage.usd === null ? null : state.usage.usd + action.usage.usd,
      activeSeconds:
        state.usage.activeSeconds === null || action.usage.activeSeconds === null
          ? null
          : state.usage.activeSeconds + action.usage.activeSeconds,
    };
    const inspect = (scope: 'guide' | 'mission', budget: MissionBudget, usage: MissionUsage) => {
      for (const axis of ['tokens', 'usd', 'activeSeconds'] as const satisfies readonly MissionBudgetAxis[]) {
        const limit = budget[axis];
        if (limit === null) continue;
        const observed = usage[axis];
        const reason = observed === null ? 'unknown' : observed > limit ? 'exceeded' : null;
        if (!reason) continue;
        const constraintId = `${scope}:${scope === 'guide' ? action.turnId : 'all'}:${axis}:${reason}`;
        if (ownValue(state.budgetConstraints, constraintId)) continue;
        events.push({
          type: 'budget-constraint-triggered',
          constraintId,
          scope,
          ...(scope === 'guide' ? { turnId: action.turnId } : {}),
          axis,
          reason,
          observed,
          limit,
        });
      }
    };
    inspect('guide', turn.budget, action.usage);
    inspect('mission', state.budget, projectedMission);
    return accept(...events);
  }

  if (action.type === 'apply-guide-proposal') {
    if (state.terminal) return refuse('invalid-state', 'terminal mission cannot apply a guide proposal');
    const turn = ownValue(state.guideTurns, action.turnId);
    if (!turn) return refuse('invalid-action', `unknown guide turn '${action.turnId}'`);
    if (turn.status !== 'proposed' || !turn.proposal) {
      return refuse('invalid-state', 'guide turn has no unapplied proposal');
    }
    if (turn.guideEpoch !== state.guideEpoch) {
      return refuse('stale-guide', `expected guide epoch ${state.guideEpoch}`);
    }
    const proposalDecision = decideMission(state, turn.proposal);
    if (!proposalDecision.accepted) return proposalDecision;
    return accept({ type: 'guide-proposal-applied', turnId: action.turnId }, ...proposalDecision.events);
  }

  if (action.type === 'adopt-execution-plan') {
    if (state.terminal) return refuse('invalid-state', 'terminal mission cannot adopt an execution plan');
    if (state.status !== 'active') return refuse('invalid-state', 'mission is not active');
    if (action.guideEpoch !== state.guideEpoch) {
      return refuse('stale-guide', `expected guide epoch ${state.guideEpoch}`);
    }
    const planner = ownValue(state.children, action.plannerChildId);
    if (!planner || planner.status !== 'succeeded' || planner.artifact?.type !== 'execution-plan') {
      return refuse('invalid-action', 'planner child has no successful machine-validated execution plan');
    }
    if (state.retiredPlannerChildIds.includes(planner.childId)) {
      return refuse('invalid-state', 'this execution plan was adopted or superseded and cannot be replayed');
    }
    const newestPendingPlannerId = [...state.childOrder]
      .reverse()
      .find(
        (childId) =>
          !state.retiredPlannerChildIds.includes(childId) &&
          ownValue(state.children, childId)?.status === 'succeeded' &&
          ownValue(state.children, childId)?.artifact?.type === 'execution-plan',
      );
    if (newestPendingPlannerId !== planner.childId) {
      return refuse('invalid-state', 'only the newest pending execution plan may be adopted');
    }
    const planError = validateExecutionPlan(state, planner, planner.artifact, {
      // A successfully adopted plan still needs one fresh guide turn to prove completion.
      reserveGuideTurns: 1,
    });
    if (planError) return refuse('invalid-action', planError);
    const planFingerprint = missionExecutionPlanFingerprint(planner.artifact);
    if (action.planFingerprint !== planFingerprint) {
      return refuse('invalid-action', 'execution plan fingerprint differs from the guide-approved artifact');
    }
    return accept({
      type: 'execution-plan-adopted',
      plannerChildId: planner.childId,
      guideEpoch: action.guideEpoch,
      planFingerprint,
      plan: planner.artifact,
    });
  }

  const terminal = state.terminal !== null;
  if (action.type === 'complete-cleanup' || action.type === 'fail-cleanup') {
    if (!terminal) return refuse('invalid-state', 'cleanup is only valid after mission terminalization');
    const cleanup = ownValue(state.cleanup, action.cleanupId);
    if (!cleanup) return refuse('invalid-action', `unknown cleanup '${action.cleanupId}'`);
    if (action.type === 'complete-cleanup') {
      if (cleanup.status === 'completed') return refuse('invalid-state', 'cleanup is already completed');
      return accept({ type: 'cleanup-completed', cleanupId: action.cleanupId });
    }
    if (cleanup.status === 'completed') return refuse('invalid-state', 'completed cleanup cannot regress');
    if (!hasText(action.error, 16_384))
      return refuse('invalid-action', 'cleanup error is empty or too large');
    return accept({ type: 'cleanup-failed', cleanupId: action.cleanupId, error: action.error });
  }

  if (action.type === 'record-accepted-revision-handoff') {
    if (!state.terminal || state.terminal.outcome !== 'succeeded') {
      return refuse('invalid-state', 'accepted revision handoff requires a succeeded terminal mission');
    }
    if (state.acceptedRevisionHandoff) {
      return refuse('invalid-state', 'accepted revision handoff is already recorded');
    }
    if (
      !validIdentifier(action.backend, 128) ||
      !validIdentifier(action.repositoryKey, 256) ||
      !validIdentifier(action.checkpointId, 512) ||
      !hasText(action.revisionId, 512) ||
      !hasText(action.reference, 2_048)
    ) {
      return refuse('invalid-action', 'accepted revision handoff evidence is invalid');
    }
    if (state.cleanupPlan.some((cleanupId) => ownValue(state.cleanup, cleanupId)?.status !== 'completed')) {
      return refuse('invalid-state', 'accepted revision handoff requires all cleanup to complete');
    }
    if (!state.terminal.checkpointId || action.checkpointId !== state.terminal.checkpointId) {
      return refuse('invalid-state', 'handoff checkpoint must equal the successful terminal checkpoint');
    }
    const checkpoint = ownValue(state.checkpoints, action.checkpointId);
    if (!checkpoint || action.revisionId !== checkpoint.revisionId) {
      return refuse('invalid-state', 'handoff revision must equal the terminal checkpoint revision');
    }
    if (!state.objective?.repositoryKey || action.repositoryKey !== state.objective.repositoryKey) {
      return refuse('invalid-state', 'handoff repository must equal the mission repository');
    }
    return accept({
      type: 'accepted-revision-handoff-recorded',
      backend: action.backend,
      repositoryKey: action.repositoryKey,
      checkpointId: action.checkpointId,
      revisionId: action.revisionId,
      reference: action.reference,
      status: action.status,
    });
  }

  if (action.type === 'answer-question') {
    if (terminal) return refuse('invalid-state', 'terminal mission does not accept question answers');
    const question = ownValue(state.questions, action.questionId);
    if (!question) return refuse('invalid-action', `unknown question '${action.questionId}'`);
    if (question.status !== 'pending') return refuse('invalid-state', 'question is already answered');
    if (!hasText(action.answer, 64_000)) return refuse('invalid-action', 'answer is empty or too large');
    return accept({ type: 'question-answered', questionId: action.questionId, answer: action.answer });
  }

  if (action.type === 'replace-guide') {
    if (terminal) return refuse('invalid-state', 'terminal mission has no guide to replace');
    if (action.guideEpoch !== state.guideEpoch) {
      return refuse('stale-guide', `expected guide epoch ${state.guideEpoch}`);
    }
    if (!hasText(action.reason, 16_384)) return refuse('invalid-action', 'replacement reason is invalid');
    return accept({
      type: 'guide-replaced',
      previousGuideEpoch: state.guideEpoch,
      guideEpoch: state.guideEpoch + 1,
      reason: action.reason,
    });
  }

  // Late usage and exit observations are durable truth even after logical terminalization. They
  // cannot mutate the terminal outcome, but retaining them makes reconciliation and billing honest.
  const lateObservation =
    action.type === 'observe-child-usage' ||
    action.type === 'complete-child' ||
    action.type === 'record-checkpoint' ||
    action.type === 'record-workspace-reconciled' ||
    action.type === 'record-validation' ||
    action.type === 'request-child-cancel';
  if (terminal && !lateObservation) return refuse('invalid-state', 'mission outcome is immutable');
  if (state.status !== 'active' && !lateObservation) return refuse('invalid-state', 'mission is not active');

  switch (action.type) {
    case 'spawn-child': {
      if (action.guideEpoch !== state.guideEpoch) {
        return refuse('stale-guide', `expected guide epoch ${state.guideEpoch}`);
      }
      if (hasPendingQuestion(state)) return refuse('invalid-state', 'mission is waiting on a human answer');
      if (!validIdentifier(action.childId, 256) || ownValue(state.children, action.childId)) {
        return refuse('invalid-action', 'child id is invalid or already exists');
      }
      if (Object.keys(state.children).length >= MAX_MISSION_CHILDREN) {
        return refuse('resource-exhausted', `mission reached its ${MAX_MISSION_CHILDREN}-child limit`);
      }
      {
        const contaminatedBy = unreconciledTerminalWriteChild(state);
        if (contaminatedBy) {
          return refuse(
            'invalid-state',
            `terminal write child '${contaminatedBy.childId}' requires durable workspace reconciliation before another child can be reserved`,
          );
        }
      }
      if (!hasText(action.role, 128) || !hasText(action.instruction, MAX_MISSION_CHILD_INSTRUCTION_CHARS)) {
        return refuse('invalid-action', 'child role or instruction is invalid');
      }
      const profile = ownValue(state.profiles, action.profileId);
      if (!profile) return refuse('invalid-action', `unknown execution profile '${action.profileId}'`);
      if (!sameProfileAuthority(action, profile)) {
        return refuse('invalid-action', 'spawn authority differs from the selected execution profile');
      }
      if (!validBudget(action.budget)) return refuse('invalid-action', 'child budget is invalid');
      if (!validResources(action.resources, false))
        return refuse('invalid-action', 'child resources are invalid');
      if (Object.keys(state.budgetConstraints).length > 0) {
        return refuse('budget-exhausted', 'a durable budget constraint prevents new child work');
      }
      if (action.subjectCheckpointId != null && !ownValue(state.checkpoints, action.subjectCheckpointId)) {
        return refuse('invalid-action', `unknown subject checkpoint '${action.subjectCheckpointId}'`);
      }
      if (action.subjectCheckpointId != null && !isAuthorizedReviewer(profile)) {
        return refuse(
          'invalid-action',
          'a checkpoint subject requires an authorized read-only reviewer or verifier profile',
        );
      }
      if (action.subjectCheckpointId != null) {
        const checkpoint = ownValue(state.checkpoints, action.subjectCheckpointId);
        const author = checkpoint?.authorChildId
          ? ownValue(state.children, checkpoint.authorChildId)
          : undefined;
        const subjectProfile = author ? ownValue(state.profiles, author.profileId) : undefined;
        if (subjectProfile && !profileCanIndependentlyReview(subjectProfile, profile)) {
          return refuse(
            'invalid-action',
            'checkpoint reviewer must have a higher assurance rank, different independence class, and different driver/model coordinate',
          );
        }
      }
      if (action.subjectCheckpointId == null && isAuthorizedReviewer(profile) && action.planStepId != null) {
        return refuse('invalid-action', 'an adopted-plan reviewer requires an exact checkpoint subject');
      }
      if (action.planStepId != null) {
        const activePlan = state.activePlan;
        const step = activePlan?.plan.steps.find(
          (candidate) =>
            missionPlanStepKey(state.missionId, activePlan.plannerChildId, candidate.id) ===
            action.planStepId,
        );
        if (!step) {
          return refuse('invalid-action', `unknown adopted plan step '${action.planStepId}'`);
        }
        const workers = missionChildrenInOrder(state).filter(
          (child) => child.planStepId === action.planStepId && child.subjectCheckpointId === null,
        );
        if (action.subjectCheckpointId == null) {
          if (action.profileId !== step.profileId) {
            return refuse(
              'invalid-action',
              `plan step '${step.id}' requires build profile '${step.profileId}'`,
            );
          }
          const round = workers.length;
          if (round > MAX_MISSION_PLAN_REPAIR_ROUNDS) {
            return refuse(
              'invalid-state',
              `plan step '${step.id}' exhausted its ${MAX_MISSION_PLAN_REPAIR_ROUNDS} repair rounds`,
            );
          }
          const expectedChildId = missionPlanChildId(
            state.missionId,
            activePlan!.plannerChildId,
            step.id,
            'work',
            round,
          );
          if (action.childId !== expectedChildId) {
            return refuse(
              'invalid-action',
              `plan step '${step.id}' round ${round} requires child '${expectedChildId}'`,
            );
          }
          if (round > 0) {
            if (!step.reviewProfileId) {
              return refuse('invalid-state', `unreviewed plan step '${step.id}' cannot dispatch a repair`);
            }
            const priorWorker = workers[round - 1]!;
            const priorCheckpoints = Object.values(state.checkpoints).filter(
              (checkpoint) => checkpoint.authorChildId === priorWorker.childId,
            );
            const priorCheckpoint = priorCheckpoints[0];
            if (
              priorWorker.status !== 'succeeded' ||
              priorCheckpoints.length !== 1 ||
              !priorCheckpoint?.clean
            ) {
              return refuse(
                'invalid-state',
                `plan step '${step.id}' repair requires the prior successful clean checkpoint`,
              );
            }
            const priorReviewers = missionChildrenInOrder(state).filter(
              (child) =>
                child.planStepId === action.planStepId &&
                child.subjectCheckpointId === priorCheckpoint.checkpointId,
            );
            const priorReviewer = priorReviewers[0];
            const priorReview = governingReviewForCheckpoint(state, priorCheckpoint.checkpointId);
            if (
              priorReviewers.length !== 1 ||
              priorReviewer?.childId !==
                missionPlanChildId(
                  state.missionId,
                  activePlan!.plannerChildId,
                  step.id,
                  'review',
                  round - 1,
                ) ||
              priorReviewer.profileId !== step.reviewProfileId ||
              priorReviewer.status !== 'succeeded' ||
              priorReview?.reviewerChildId !== priorReviewer.childId ||
              priorReview.verdict !== 'changes-requested' ||
              !['low', 'medium'].includes(priorReview.highestSeverity)
            ) {
              return refuse(
                'invalid-state',
                `plan step '${step.id}' repair requires one exact low-or-medium changes-requested review`,
              );
            }
          }
        } else {
          if (!step.reviewProfileId || action.profileId !== step.reviewProfileId) {
            return refuse(
              'invalid-action',
              `plan step '${step.id}' requires review profile '${step.reviewProfileId ?? 'none'}'`,
            );
          }
          const checkpoint = ownValue(state.checkpoints, action.subjectCheckpointId);
          const author = checkpoint?.authorChildId
            ? ownValue(state.children, checkpoint.authorChildId)
            : undefined;
          if (!author || author.planStepId !== action.planStepId || author.profileId !== step.profileId) {
            return refuse(
              'invalid-action',
              `plan review '${step.id}' must inspect its trusted plan worker checkpoint`,
            );
          }
          const round = workers.findIndex((worker) => worker.childId === author.childId);
          if (round < 0 || author.childId !== workers.at(-1)?.childId || !checkpoint?.clean) {
            return refuse(
              'invalid-state',
              `plan review '${step.id}' must inspect the latest clean plan worker checkpoint`,
            );
          }
          const expectedChildId = missionPlanChildId(
            state.missionId,
            activePlan!.plannerChildId,
            step.id,
            'review',
            round,
          );
          if (action.childId !== expectedChildId) {
            return refuse(
              'invalid-action',
              `plan review '${step.id}' round ${round} requires child '${expectedChildId}'`,
            );
          }
          if (
            missionChildrenInOrder(state).some(
              (child) =>
                child.planStepId === action.planStepId &&
                child.subjectCheckpointId === action.subjectCheckpointId,
            )
          ) {
            return refuse(
              'invalid-state',
              `plan step '${step.id}' already has a reviewer for this checkpoint`,
            );
          }
        }
      }
      const budgetRefusal = budgetAdmission(state, action.budget);
      if (budgetRefusal) return budgetRefusal;
      const resourceRefusal = resourceAdmission(state, action.resources);
      if (resourceRefusal) return resourceRefusal;
      const { type: _type, guideEpoch, ...child } = action;
      return accept({ type: 'child-reserved', child, guideEpoch });
    }
    case 'start-child': {
      const child = ownValue(state.children, action.childId);
      if (!child) return refuse('invalid-action', `unknown child '${action.childId}'`);
      if (child.status !== 'reserved') return refuse('invalid-state', 'child is not reserved');
      {
        const contaminatedBy = unreconciledTerminalWriteChild(state);
        if (contaminatedBy) {
          return refuse(
            'invalid-state',
            `terminal write child '${contaminatedBy.childId}' requires durable workspace reconciliation before another child can start`,
          );
        }
      }
      if (!hasText(action.attemptId, 256)) return refuse('invalid-action', 'attempt id is invalid');
      return accept({
        type: 'child-started',
        childId: action.childId,
        attemptId: action.attemptId,
        ...(action.sessionId !== undefined ? { sessionId: action.sessionId } : {}),
      });
    }
    case 'observe-child-usage': {
      const child = ownValue(state.children, action.childId);
      if (!child) return refuse('invalid-action', `unknown child '${action.childId}'`);
      if (child.status !== 'running' && child.status !== 'cancelling') {
        return refuse('invalid-state', 'usage requires a running or cancelling child');
      }
      if (!validUsage(action.usage) || !usageMonotonic(child.usage, action.usage)) {
        return refuse('invalid-action', 'usage must be an absolute cumulative high-water value');
      }
      return accept(
        { type: 'child-usage-observed', childId: action.childId, usage: action.usage },
        ...constraintEvents(state, action.childId, action.usage),
      );
    }
    case 'request-child-cancel': {
      if (action.guideEpoch !== state.guideEpoch) {
        return refuse('stale-guide', `expected guide epoch ${state.guideEpoch}`);
      }
      const child = ownValue(state.children, action.childId);
      if (!child) return refuse('invalid-action', `unknown child '${action.childId}'`);
      if (childIsTerminal(child.status) || child.status === 'cancelling') {
        return refuse('invalid-state', 'child is not cancellable');
      }
      if (!hasText(action.reason, 16_384)) return refuse('invalid-action', 'cancel reason is invalid');
      return accept({
        type: 'child-cancel-requested',
        childId: action.childId,
        reason: action.reason,
        guideEpoch: action.guideEpoch,
      });
    }
    case 'complete-child': {
      const child = ownValue(state.children, action.childId);
      if (!child) return refuse('invalid-action', `unknown child '${action.childId}'`);
      if (childIsTerminal(child.status)) return refuse('invalid-state', 'child is already terminal');
      if (child.status === 'reserved' && action.outcome === 'succeeded') {
        return refuse('invalid-state', 'a child cannot succeed before its process starts');
      }
      if (!validUsage(action.usage) || !usageMonotonic(child.usage, action.usage)) {
        return refuse('invalid-action', 'final usage must be an absolute cumulative high-water value');
      }
      if (!hasText(action.summary, 64_000)) return refuse('invalid-action', 'child summary is invalid');
      if (action.artifact?.type === 'review') {
        const artifact = action.artifact;
        const checkpoint = child.subjectCheckpointId
          ? ownValue(state.checkpoints, child.subjectCheckpointId)
          : undefined;
        if (
          action.outcome !== 'succeeded' ||
          !isAuthorizedReviewer(child) ||
          !checkpoint ||
          artifact.checkpointId !== checkpoint.checkpointId ||
          artifact.revisionId !== checkpoint.revisionId ||
          !hasText(artifact.summary, MAX_MISSION_REVIEW_SUMMARY_CHARS) ||
          (artifact.verdict === 'passed' && artifact.highestSeverity !== 'none') ||
          (artifact.verdict === 'changes-requested' && artifact.highestSeverity === 'none')
        ) {
          return refuse(
            'invalid-action',
            'review artifact does not match an authorized successful review child and exact revision',
          );
        }
      } else if (action.artifact?.type === 'execution-plan') {
        const planError = validateExecutionPlan(state, child, action.artifact, {
          completingUsage: action.usage,
          // One guide approves the plan; another proves completion after deterministic execution.
          reserveGuideTurns: 2,
        });
        if (action.outcome !== 'succeeded' || planError) {
          return refuse(
            'invalid-action',
            planError ?? 'only a successful planner may emit an execution plan',
          );
        }
      } else if (
        action.outcome === 'succeeded' &&
        ((isAuthorizedReviewer(child) && child.subjectCheckpointId !== null) || isAuthorizedPlanner(child))
      ) {
        return refuse(
          'invalid-action',
          'successful planner and review children require a machine-validated artifact',
        );
      }
      return accept(
        {
          type: 'child-completed',
          childId: action.childId,
          outcome: action.outcome,
          summary: action.summary,
          usage: action.usage,
          ...(action.artifact ? { artifact: action.artifact } : {}),
        },
        ...constraintEvents(state, action.childId, action.usage),
      );
    }
    case 'record-checkpoint':
      if (
        !validIdentifier(action.checkpointId, 512) ||
        !hasText(action.revisionId, 512) ||
        ownValue(state.checkpoints, action.checkpointId)
      ) {
        return refuse('invalid-action', 'checkpoint id is invalid or already exists');
      }
      {
        const existingRevision = Object.values(state.checkpoints).find(
          (checkpoint) => checkpoint.revisionId === action.revisionId,
        );
        if (existingRevision && action.changed !== false) {
          return refuse(
            'invalid-action',
            `immutable revision is already recorded as checkpoint '${existingRevision.checkpointId}'`,
          );
        }
      }
      if (activeChildren(state).some((child) => child.permission === 'write')) {
        return refuse('invalid-state', 'cannot checkpoint while a write child still owns its reservation');
      }
      {
        const latest = latestCheckpoint(state);
        const expectedParent = latest?.checkpointId ?? null;
        const expectedParentRevision = latest?.revisionId ?? state.objective?.baseRevision;
        if ((action.parentCheckpointId ?? null) !== expectedParent) {
          return refuse('invalid-action', `checkpoint parent must be ${expectedParent ?? 'null'}`);
        }
        if (action.changed === false && expectedParentRevision !== action.revisionId) {
          return refuse(
            'invalid-action',
            'an unchanged checkpoint must equal its exact parent or mission base revision',
          );
        }
        if (action.changed === true && expectedParentRevision === action.revisionId) {
          return refuse('invalid-action', 'a changed checkpoint must advance its exact parent revision');
        }
        if (action.authorChildId !== null) {
          const author = ownValue(state.children, action.authorChildId);
          if (!author || author.permission !== 'write' || author.status !== 'succeeded') {
            return refuse('invalid-state', 'checkpoint author must be a successful write child');
          }
          if (
            Object.values(state.checkpoints).some(
              (checkpoint) => checkpoint.authorChildId === action.authorChildId,
            )
          ) {
            return refuse('invalid-state', 'a write child may author only one immutable checkpoint');
          }
        } else if (Object.values(state.children).some((child) => child.permission === 'write')) {
          return refuse('invalid-state', 'a post-build checkpoint must identify its author child');
        }
      }
      return accept({
        type: 'checkpoint-recorded',
        checkpointId: action.checkpointId,
        revisionId: action.revisionId,
        authorChildId: action.authorChildId,
        changed: action.changed ?? true,
        clean: action.clean,
        ...(action.parentCheckpointId !== undefined ? { parentCheckpointId: action.parentCheckpointId } : {}),
        ...(action.description !== undefined ? { description: action.description } : {}),
      });
    case 'record-workspace-reconciled': {
      const child = ownValue(state.children, action.childId);
      if (!child) return refuse('invalid-action', `unknown child '${action.childId}'`);
      if (child.permission !== 'write' || !childIsTerminal(child.status)) {
        return refuse('invalid-state', 'workspace reconciliation requires a terminal write child');
      }
      if (workspaceReconciliationForChild(state, child)) {
        return refuse('invalid-state', 'write child workspace is already reconciled');
      }
      const authoredCheckpoint = Object.values(state.checkpoints).find(
        (checkpoint) => checkpoint.authorChildId === child.childId,
      );
      if (child.status === 'succeeded' && !authoredCheckpoint) {
        return refuse(
          'invalid-state',
          'a successful write child must record its exact checkpoint before workspace reconciliation',
        );
      }
      if (!hasText(action.revisionId, 512) || !hasText(action.summary, 16_384)) {
        return refuse('invalid-action', 'workspace reconciliation evidence is invalid');
      }
      const activeWriter = activeChildren(state).find(
        (candidate) =>
          candidate.permission === 'write' &&
          (candidate.status === 'running' || candidate.status === 'cancelling'),
      );
      if (activeWriter) {
        return refuse(
          'invalid-state',
          `cannot reconcile workspace while write child '${activeWriter.childId}' is active`,
        );
      }
      const expectedRevision = latestCheckpoint(state)?.revisionId ?? state.objective?.baseRevision;
      if (expectedRevision !== undefined && action.revisionId !== expectedRevision) {
        return refuse('invalid-state', `workspace reconciliation revision must equal '${expectedRevision}'`);
      }
      return accept({
        type: 'workspace-reconciled',
        childId: child.childId,
        revisionId: action.revisionId,
        disposition: action.disposition,
        summary: action.summary,
      });
    }
    case 'record-review': {
      if (!validIdentifier(action.reviewId, 256) || ownValue(state.reviews, action.reviewId)) {
        return refuse('invalid-action', 'review id is invalid or already exists');
      }
      const reviewedCheckpoint = ownValue(state.checkpoints, action.checkpointId);
      if (!reviewedCheckpoint) {
        return refuse('invalid-action', `unknown checkpoint '${action.checkpointId}'`);
      }
      if (action.revisionId !== reviewedCheckpoint.revisionId) {
        return refuse('invalid-state', 'review revision does not match the checkpoint identity');
      }
      {
        const reviewer = ownValue(state.children, action.reviewerChildId);
        if (!reviewer) return refuse('invalid-action', `unknown reviewer child '${action.reviewerChildId}'`);
        if (reviewer.permission !== 'read' || reviewer.status !== 'succeeded') {
          return refuse('invalid-state', 'review must come from a successful, independently read-only child');
        }
        if (
          reviewer.driverPosture.kind !== 'verify' ||
          reviewer.driverPosture.permission.write ||
          !['reviewer', 'verifier'].includes(reviewer.driverPosture.lineageRole)
        ) {
          return refuse(
            'invalid-state',
            'review evidence requires a verify-kind child with reviewer or verifier lineage',
          );
        }
        if (reviewer.subjectCheckpointId !== action.checkpointId) {
          return refuse('invalid-state', 'reviewer was not commissioned against this exact checkpoint');
        }
        if (
          Object.values(state.reviews).some((review) => review.reviewerChildId === action.reviewerChildId)
        ) {
          return refuse('invalid-state', 'a review child may record only one review artifact');
        }
        if (reviewedCheckpoint.authorChildId === action.reviewerChildId) {
          return refuse('invalid-state', 'checkpoint author cannot review its own work');
        }
        const artifact = reviewer.artifact?.type === 'review' ? reviewer.artifact : null;
        if (
          !artifact ||
          artifact.checkpointId !== action.checkpointId ||
          artifact.revisionId !== action.revisionId ||
          artifact.verdict !== action.verdict ||
          artifact.highestSeverity !== action.highestSeverity ||
          artifact.summary !== action.summary
        ) {
          return refuse('invalid-state', 'review evidence must exactly match the reviewer artifact');
        }
      }
      if (action.verdict === 'passed' && severityRank[action.highestSeverity] > 0) {
        return refuse('invalid-action', 'a passing review cannot contain an open finding');
      }
      if (action.verdict === 'changes-requested' && action.highestSeverity === 'none') {
        return refuse('invalid-action', 'changes-requested must identify a finding severity');
      }
      if (!hasText(action.summary, MAX_MISSION_REVIEW_SUMMARY_CHARS)) {
        return refuse('invalid-action', 'review summary is invalid');
      }
      return accept({ ...action, type: 'review-recorded' });
    }
    case 'begin-validation': {
      if (state.terminal || state.status !== 'active') {
        return refuse('invalid-state', 'validation can start only for an active mission');
      }
      const policy = state.validationPolicy;
      if (!policy || policy.kind !== 'command') {
        return refuse('invalid-state', 'only a command validation policy starts a process attempt');
      }
      if (state.activeValidation) return refuse('invalid-state', 'another validation attempt is active');
      if (activeChildren(state).length > 0) {
        return refuse('invalid-state', 'validation cannot start while a child is active');
      }
      if (Object.values(state.guideTurns).some((turn) => turn.status === 'running')) {
        return refuse('invalid-state', 'validation cannot start while a guide turn is active');
      }
      if (!validIdentifier(action.validationId, 256) || ownValue(state.validations, action.validationId)) {
        return refuse('invalid-action', 'validation id is invalid or already recorded');
      }
      const checkpoint = latestCheckpoint(state);
      if (
        !checkpoint ||
        !checkpoint.clean ||
        action.checkpointId !== checkpoint.checkpointId ||
        action.revisionId !== checkpoint.revisionId ||
        action.policyId !== policy.policyId
      ) {
        return refuse('invalid-state', 'validation attempt must bind the exact latest clean checkpoint');
      }
      if (
        Object.values(state.validations).some(
          (validation) =>
            validation.policyId === action.policyId &&
            validation.checkpointId === action.checkpointId &&
            validation.revisionId === action.revisionId,
        )
      ) {
        return refuse('invalid-state', 'validation is already recorded for this exact revision and policy');
      }
      return accept({ ...action, type: 'validation-started' });
    }
    case 'record-validation': {
      const policy = state.validationPolicy;
      if (!policy) return refuse('invalid-state', 'mission has no immutable validation policy');
      if (!validIdentifier(action.validationId, 256) || ownValue(state.validations, action.validationId)) {
        return refuse('invalid-action', 'validation id is invalid or already exists');
      }
      if (action.policyId !== policy.policyId) {
        return refuse('invalid-action', 'validation policy id differs from mission authority');
      }
      if ((action.checkpointId === null) !== (action.revisionId === null)) {
        return refuse('invalid-action', 'validation checkpoint and revision must both be present or null');
      }
      if (Buffer.byteLength(action.outputTail, 'utf8') > MAX_MISSION_VALIDATION_OUTPUT_BYTES) {
        return refuse('invalid-action', 'validation output tail exceeds the durable byte limit');
      }
      if (activeChildren(state).length > 0) {
        return refuse('invalid-state', 'cannot record validation while a child is active');
      }
      const checkpoint = latestCheckpoint(state);
      if (checkpoint) {
        if (action.checkpointId !== checkpoint.checkpointId || action.revisionId !== checkpoint.revisionId) {
          return refuse('invalid-state', 'validation must bind the exact latest checkpoint revision');
        }
        if (!checkpoint.clean) {
          return refuse('invalid-state', 'validation requires a clean checkpoint');
        }
      } else if (action.checkpointId !== null || action.revisionId !== null) {
        return refuse('invalid-state', 'validation cannot name a checkpoint that is not recorded');
      }
      if (!checkpoint && policy.kind !== 'none') {
        return refuse('invalid-state', 'command validation requires an exact recorded checkpoint');
      }
      if (
        Object.values(state.validations).some(
          (validation) =>
            validation.policyId === action.policyId &&
            validation.checkpointId === action.checkpointId &&
            validation.revisionId === action.revisionId,
        )
      ) {
        return refuse('invalid-state', 'validation is already recorded for this exact revision and policy');
      }
      if (policy.kind === 'none') {
        if (state.activeValidation !== null) {
          return refuse('invalid-state', 'none validation cannot settle a command attempt');
        }
        if (
          action.disposition !== 'not-applicable' ||
          action.exitCode !== null ||
          action.timedOut ||
          action.workspaceChanged
        ) {
          return refuse('invalid-action', 'none validation requires a not-applicable process-free result');
        }
      } else {
        const attempt = state.activeValidation;
        if (
          !attempt ||
          attempt.validationId !== action.validationId ||
          attempt.checkpointId !== action.checkpointId ||
          attempt.revisionId !== action.revisionId ||
          attempt.policyId !== action.policyId
        ) {
          return refuse('invalid-state', 'command result does not match its durable validation attempt');
        }
        if (action.disposition === 'not-applicable') {
          return refuse('invalid-action', 'command validation cannot be marked not-applicable');
        }
        if (action.disposition === 'passed' && (action.exitCode !== 0 || action.timedOut)) {
          return refuse('invalid-action', 'passed command validation requires exit code zero');
        }
        if (action.disposition === 'passed' && action.workspaceChanged) {
          return refuse('invalid-action', 'a command that changed the exact workspace cannot pass');
        }
        // The process exit is only one part of the trusted validation postcondition. Exit zero may
        // still be a failed validation when the command changed the exact workspace; the adapter
        // restores/quarantines that residue before this harness-only action is admitted.
        if (
          action.disposition === 'failed' &&
          action.exitCode === 0 &&
          !action.timedOut &&
          !action.workspaceChanged
        ) {
          return refuse(
            'invalid-action',
            'failed command validation requires process failure, timeout, or workspace changes',
          );
        }
      }
      return accept({ ...action, type: 'validation-recorded' });
    }
    case 'raise-question':
      if (action.guideEpoch !== state.guideEpoch) {
        return refuse('stale-guide', `expected guide epoch ${state.guideEpoch}`);
      }
      if (hasPendingQuestion(state)) return refuse('invalid-state', 'another question is already pending');
      if (!validIdentifier(action.questionId, 256) || ownValue(state.questions, action.questionId)) {
        return refuse('invalid-action', 'question id is invalid or already exists');
      }
      if (!hasText(action.prompt, 32_000)) return refuse('invalid-action', 'question prompt is invalid');
      return accept({
        type: 'question-raised',
        questionId: action.questionId,
        prompt: action.prompt,
        guideEpoch: action.guideEpoch,
      });
    case 'complete-mission': {
      if (action.guideEpoch !== state.guideEpoch) {
        return refuse('stale-guide', `expected guide epoch ${state.guideEpoch}`);
      }
      if (!hasText(action.reason, 64_000)) return refuse('invalid-action', 'completion reason is invalid');
      if (action.outcome === 'succeeded' && activeChildren(state).length > 0) {
        return refuse('completion-unproved', 'children are still reserved or running');
      }
      if (action.outcome === 'succeeded' && state.activeValidation !== null) {
        return refuse('completion-unproved', 'deterministic validation is still active');
      }
      if (action.outcome === 'succeeded' && Object.keys(state.budgetConstraints).length > 0) {
        return refuse('completion-unproved', 'success is blocked by a durable budget constraint');
      }
      if (action.outcome === 'succeeded') {
        const contaminatedBy = unreconciledTerminalWriteChild(state);
        if (contaminatedBy) {
          return refuse(
            'completion-unproved',
            `terminal write child '${contaminatedBy.childId}' has no durable workspace reconciliation`,
          );
        }
      }
      if (action.outcome === 'succeeded') {
        const unresolvedPlan = unresolvedActiveMissionPlan(state);
        if (unresolvedPlan) return refuse('completion-unproved', unresolvedPlan);
      }
      let completedCheckpointId = action.checkpointId ?? null;
      if (action.outcome === 'succeeded') {
        const checkpoint = action.checkpointId
          ? ownValue(state.checkpoints, action.checkpointId)
          : latestCheckpoint(state);
        if (state.completion.requireCheckpoint && !checkpoint) {
          return refuse('completion-unproved', 'success requires a recorded checkpoint');
        }
        if (checkpoint && !checkpoint.clean) {
          return refuse('completion-unproved', 'success checkpoint is not clean');
        }
        const latest = latestCheckpoint(state);
        if (checkpoint && latest?.checkpointId !== checkpoint.checkpointId) {
          return refuse('completion-unproved', 'success must settle the latest recorded checkpoint');
        }
        if (state.completion.requireReview && checkpoint) {
          const review = governingReviewForCheckpoint(state, checkpoint.checkpointId);
          if (!review || review.verdict !== 'passed' || review.highestSeverity !== 'none') {
            return refuse('completion-unproved', 'success requires a passing review of the exact checkpoint');
          }
        }
        if (state.completion.requireReview && !checkpoint) {
          return refuse('completion-unproved', 'success review has no checkpoint');
        }
        const policy = state.validationPolicy;
        if (!policy) {
          return refuse('completion-unproved', 'success has no immutable validation policy');
        }
        const validation = governingValidationForCheckpoint(state, checkpoint?.checkpointId ?? null);
        if (!validation) {
          return refuse(
            'completion-unproved',
            checkpoint
              ? 'success requires validation of the exact latest checkpoint revision'
              : 'success without a checkpoint requires explicit not-applicable validation evidence',
          );
        }
        const requiredDisposition = policy.kind === 'command' ? 'passed' : 'not-applicable';
        if (validation.disposition !== requiredDisposition) {
          return refuse(
            'completion-unproved',
            `success requires validation disposition '${requiredDisposition}' for policy '${policy.policyId}'`,
          );
        }
        if (!checkpoint && policy.kind !== 'none') {
          return refuse(
            'completion-unproved',
            'success without a checkpoint requires an explicit none policy',
          );
        }
        completedCheckpointId = checkpoint?.checkpointId ?? null;
      }
      const events: MissionEvent[] = [
        {
          type: 'mission-completed',
          outcome: action.outcome,
          reason: action.reason,
          guideEpoch: action.guideEpoch,
          ...(completedCheckpointId !== null ? { checkpointId: completedCheckpointId } : {}),
        },
      ];
      if (action.outcome !== 'succeeded') {
        for (const child of activeChildren(state)) {
          const prefix = `mission ${action.outcome}: `;
          events.push({
            type: 'child-cancel-requested',
            childId: child.childId,
            // This fan-out can include every child in the mission. Keep the aggregate event batch
            // below the store's 2 MiB bound even when the terminal reason itself is maximal.
            reason: `${prefix}${action.reason}`.slice(0, 4_096),
            guideEpoch: action.guideEpoch,
          });
        }
      }
      // Completion and obligation creation are one atomic journal revision. Cleanup is deliberately
      // post-terminal and may fail/retry without changing the mission's logical outcome.
      for (const cleanupId of state.cleanupPlan) events.push({ type: 'cleanup-required', cleanupId });
      return accept(...events);
    }
  }
}
