import { describe, expect, it } from 'vitest';
import {
  MissionActionValidationError,
  parseMissionAction,
  validateMissionAction,
} from '../src/mission/action-schema';
import {
  MAX_MISSION_REVIEW_SUMMARY_CHARS,
  MAX_MISSION_VALIDATION_OUTPUT_BYTES,
  type MissionAction,
} from '../src/mission/protocol';

const budget = { tokens: 1_000, usd: 10, activeSeconds: 600 } as const;
const usage = { tokens: 500, usd: null, activeSeconds: 120 } as const;
const projectMcpFingerprint = 'a'.repeat(64);
const projectMcp = [{ server: 'project-tools', tools: ['inspect_asset', 'edit_asset'] }] as const;
const buildPosture = {
  kind: 'build',
  permission: { write: true, allow: [], deny: [], auto: false },
  lineageRole: 'worker',
} as const;
const executionPlan = {
  type: 'execution-plan',
  summary: 'Build and verify one bounded change.',
  steps: [
    {
      id: 'implement',
      title: 'Implement the change',
      profileId: 'builder',
      instruction: 'Implement the accepted behavior.',
      acceptance: ['The focused tests pass.'],
    },
  ],
} as const;

const validActionByType = {
  'create-mission': {
    type: 'create-mission',
    projectMcpDeclarationFingerprint: projectMcpFingerprint,
    objective: {
      brief: 'Implement and verify one bounded change.',
      taskId: 'PLNR-1',
      runId: 'run-1',
      repositoryKey: 'runner',
      baseRevision: 'abc123',
    },
    budget,
    resources: { 'stateful-editor': 1 },
    guide: { profileId: 'guide', agent: { driver: 'claude', model: 'guide-model' }, budget, turnLimit: 20 },
    profiles: [
      {
        profileId: 'builder',
        role: 'builder',
        permission: 'write',
        agent: { driver: 'codex', model: 'build-model', effort: 'medium' },
        assurance: { rank: 1, independenceClass: 'build' },
        driverPosture: buildPosture,
        budget,
        resources: { 'stateful-editor': 1 },
        projectMcp,
      },
    ],
    validationPolicy: {
      kind: 'command',
      policyId: 'test-command-v1',
      command: 'npm test',
      timeoutSeconds: 300,
      shell: null,
    },
    completion: { requireCheckpoint: true, requireReview: true },
    cleanup: ['release-workspace'],
  },
  'begin-guide-turn': { type: 'begin-guide-turn', guideEpoch: 0, turnId: 'guide-turn-1' },
  'complete-guide-turn': {
    type: 'complete-guide-turn',
    turnId: 'guide-turn-1',
    outcome: 'proposed',
    summary: 'Proposed a bounded builder child.',
    usage,
    proposal: null,
  },
  'apply-guide-proposal': { type: 'apply-guide-proposal', turnId: 'guide-turn-1' },
  'adopt-execution-plan': {
    type: 'adopt-execution-plan',
    guideEpoch: 0,
    plannerChildId: 'planner-1',
    planFingerprint: 'b'.repeat(64),
  },
  'spawn-child': {
    type: 'spawn-child',
    guideEpoch: 0,
    childId: 'builder-1',
    role: 'builder',
    instruction: 'Implement the accepted execution plan.',
    permission: 'write',
    agent: { driver: 'codex', model: 'build-model', effort: 'medium' },
    driverPosture: buildPosture,
    profileId: 'builder',
    budget,
    resources: { 'stateful-editor': 1 },
    projectMcp,
    subjectCheckpointId: null,
  },
  'start-child': {
    type: 'start-child',
    childId: 'builder-1',
    attemptId: 'attempt-1',
    sessionId: null,
  },
  'observe-child-usage': { type: 'observe-child-usage', childId: 'builder-1', usage },
  'request-child-cancel': {
    type: 'request-child-cancel',
    guideEpoch: 0,
    childId: 'builder-1',
    reason: 'The mission was cancelled.',
  },
  'complete-child': {
    type: 'complete-child',
    childId: 'builder-1',
    outcome: 'succeeded',
    summary: 'Implementation and local checks completed.',
    usage,
    artifact: executionPlan,
  },
  'record-checkpoint': {
    type: 'record-checkpoint',
    checkpointId: 'abc123',
    revisionId: 'git-sha-abc123',
    authorChildId: 'builder-1',
    changed: true,
    parentCheckpointId: null,
    clean: true,
    description: 'Verified implementation checkpoint.',
  },
  'record-workspace-reconciled': {
    type: 'record-workspace-reconciled',
    childId: 'builder-1',
    revisionId: 'git-sha-abc123',
    disposition: 'restored',
    summary: 'Removed residual writes and restored the exact checkpoint.',
  },
  'record-review': {
    type: 'record-review',
    reviewId: 'review-1',
    reviewerChildId: 'reviewer-1',
    checkpointId: 'abc123',
    revisionId: 'git-sha-abc123',
    verdict: 'passed',
    highestSeverity: 'none',
    summary: 'No actionable findings.',
  },
  'begin-validation': {
    type: 'begin-validation',
    validationId: 'validation-1',
    checkpointId: 'abc123',
    revisionId: 'git-sha-abc123',
    policyId: 'test-command-v1',
  },
  'record-validation': {
    type: 'record-validation',
    validationId: 'validation-1',
    checkpointId: 'abc123',
    revisionId: 'git-sha-abc123',
    policyId: 'test-command-v1',
    disposition: 'passed',
    exitCode: 0,
    timedOut: false,
    workspaceChanged: false,
    outputTail: 'Tests passed.',
  },
  'raise-question': {
    type: 'raise-question',
    guideEpoch: 0,
    questionId: 'question-1',
    prompt: 'Which supported behavior should be preserved?',
  },
  'answer-question': {
    type: 'answer-question',
    questionId: 'question-1',
    answer: 'Preserve both modes.',
  },
  'replace-guide': {
    type: 'replace-guide',
    guideEpoch: 0,
    reason: 'The prior guide session disconnected.',
  },
  'complete-mission': {
    type: 'complete-mission',
    guideEpoch: 0,
    outcome: 'succeeded',
    reason: 'The latest clean checkpoint passed independent review.',
    checkpointId: 'abc123',
  },
  'complete-cleanup': { type: 'complete-cleanup', cleanupId: 'release-workspace' },
  'fail-cleanup': {
    type: 'fail-cleanup',
    cleanupId: 'release-workspace',
    error: 'Workspace is still busy.',
  },
  'record-accepted-revision-handoff': {
    type: 'record-accepted-revision-handoff',
    backend: 'git',
    repositoryKey: 'runner',
    checkpointId: 'abc123',
    revisionId: 'git-sha-abc123',
    reference: 'refs/noriq/accepted/mission-1',
    status: 'preserved',
  },
} satisfies {
  [Type in MissionAction['type']]: Extract<MissionAction, { type: Type }>;
};

const validActions: readonly MissionAction[] = Object.values(validActionByType);

const clone = <T>(value: T): T => structuredClone(value);

describe('mission action runtime validation', () => {
  it('accepts every member of the MissionAction union', () => {
    for (const action of validActions) {
      const result = validateMissionAction(action);
      expect(result, action.type).toMatchObject({ success: true, action });
    }
  });

  it('rejects unknown action types and additional keys at every object level', () => {
    const create = validActionByType['create-mission'];
    const spawn = validActionByType['spawn-child'];
    const cases: unknown[] = [
      { type: 'invent-work', reason: 'models cannot extend the protocol' },
      { ...create, unexpected: true },
      { ...create, objective: { ...create.objective, unexpected: true } },
      { ...create, budget: { ...create.budget, unexpected: 1 } },
      { ...create, completion: { ...create.completion, unexpected: true } },
      { ...create, validationPolicy: { ...create.validationPolicy, unexpected: true } },
      { ...create, guide: { ...create.guide, unexpected: true } },
      { ...create, profiles: [{ ...create.profiles![0], unexpected: true }] },
      { ...spawn, agent: { ...spawn.agent, unexpected: true } },
      { ...spawn, projectMcp: [{ ...spawn.projectMcp![0], unexpected: true }] },
      { ...validActionByType['observe-child-usage'], usage: { ...usage, unexpected: 1 } },
    ];

    for (const candidate of cases) expect(validateMissionAction(candidate).success).toBe(false);
  });

  it('rejects custom and null prototypes, inherited fields, accessors, and symbol keys', () => {
    const failedCleanup = validActionByType['fail-cleanup'];
    const inherited = Object.assign(Object.create({ inherited: true }) as object, failedCleanup);
    const nullPrototype = Object.assign(Object.create(null) as object, failedCleanup);
    let getterCalled = false;
    const accessor = clone(failedCleanup) as Record<string, unknown>;
    Object.defineProperty(accessor, 'error', {
      enumerable: true,
      get() {
        getterCalled = true;
        return 'do not execute me';
      },
    });
    const symbol = clone(failedCleanup) as Record<PropertyKey, unknown>;
    symbol[Symbol('hidden')] = true;

    for (const candidate of [inherited, nullPrototype, accessor, symbol]) {
      expect(validateMissionAction(candidate).success).toBe(false);
    }
    expect(getterCalled).toBe(false);
  });

  it('rejects undefined values, non-finite numbers, sparse arrays, and cycles before parsing', () => {
    const withUndefined = clone(validActionByType['spawn-child']) as Record<string, unknown>;
    (withUndefined.agent as Record<string, unknown>).model = undefined;
    const sparseCleanup = clone(validActionByType['create-mission']) as Record<string, unknown>;
    sparseCleanup.cleanup = new Array(1);
    let arrayGetterCalled = false;
    const hostileCleanup: unknown[] = ['release-workspace'];
    Object.defineProperty(hostileCleanup, 'map', {
      enumerable: true,
      get() {
        arrayGetterCalled = true;
        return Array.prototype.map;
      },
    });
    const withHostileArray = clone(validActionByType['create-mission']) as Record<string, unknown>;
    withHostileArray.cleanup = hostileCleanup;
    const cyclic = clone(validActionByType['create-mission']) as Record<string, unknown>;
    const objective = cyclic.objective as Record<string, unknown>;
    objective.loop = objective;

    for (const candidate of [
      withUndefined,
      { ...validActionByType['observe-child-usage'], usage: { ...usage, tokens: Number.NaN } },
      {
        ...validActionByType['observe-child-usage'],
        usage: { ...usage, activeSeconds: Number.POSITIVE_INFINITY },
      },
      sparseCleanup,
      withHostileArray,
      cyclic,
    ]) {
      expect(validateMissionAction(candidate).success).toBe(false);
    }
    expect(arrayGetterCalled).toBe(false);
  });

  it('enforces bounded type-specific text, integer, enum, null, and resource constraints', () => {
    const cases: unknown[] = [
      { ...validActionByType['spawn-child'], childId: ' '.repeat(2) },
      { ...validActionByType['spawn-child'], guideEpoch: Number.MAX_SAFE_INTEGER + 1 },
      { ...validActionByType['spawn-child'], permission: 'admin' },
      { ...validActionByType['spawn-child'], budget: { ...budget, tokens: 1.5 } },
      { ...validActionByType['spawn-child'], resources: { editor: 0 } },
      { ...validActionByType['create-mission'], resources: { editor: -1 } },
      {
        ...validActionByType['create-mission'],
        resources: JSON.parse('{"__proto__":1}') as unknown,
      },
      { ...validActionByType['start-child'], sessionId: 7 },
      { ...validActionByType['complete-child'], outcome: 'mostly-succeeded' },
      {
        ...validActionByType['complete-child'],
        artifact: {
          ...executionPlan,
          steps: [{ ...executionPlan.steps[0], id: 'constructor' }],
        },
      },
      { ...validActionByType['record-checkpoint'], authorChildId: undefined },
      { ...validActionByType['record-review'], highestSeverity: null },
      {
        ...validActionByType['record-validation'],
        exitCode: 0,
        disposition: 'failed',
        workspaceChanged: false,
      },
      { ...validActionByType['record-validation'], workspaceChanged: true },
      { ...validActionByType['record-validation'], checkpointId: null },
      {
        ...validActionByType['record-validation'],
        outputTail: '🚀'.repeat(MAX_MISSION_VALIDATION_OUTPUT_BYTES / 2),
      },
      {
        ...validActionByType['record-review'],
        summary: 'x'.repeat(MAX_MISSION_REVIEW_SUMMARY_CHARS + 1),
      },
      { ...validActionByType['complete-mission'], checkpointId: false },
      { ...validActionByType['fail-cleanup'], error: 'x'.repeat(16_385) },
    ];

    for (const candidate of cases) expect(validateMissionAction(candidate).success).toBe(false);
  });

  it('rejects duplicate cleanup ids and excessive resource cardinality', () => {
    const resources = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`resource-${index}`, 0]));
    expect(
      validateMissionAction({
        ...validActionByType['create-mission'],
        cleanup: ['release-workspace', 'release-workspace'],
      }).success,
    ).toBe(false);
    expect(validateMissionAction({ ...validActionByType['create-mission'], resources }).success).toBe(false);
  });

  it('binds exact MCP grants to one valid declaration fingerprint', () => {
    const create = validActionByType['create-mission'];
    const profile = create.profiles[0];
    const cases: unknown[] = [
      { ...create, projectMcpDeclarationFingerprint: null },
      { ...create, projectMcpDeclarationFingerprint: 'A'.repeat(64) },
      { ...create, projectMcpDeclarationFingerprint: 'a'.repeat(63) },
      {
        ...create,
        profiles: [{ ...profile, projectMcp: [] }],
      },
      {
        ...create,
        profiles: [{ ...profile, projectMcp: [{ server: 'bad.server', tools: ['inspect_asset'] }] }],
      },
      {
        ...create,
        profiles: [{ ...profile, projectMcp: [{ server: 'project-tools', tools: ['inspect_*'] }] }],
      },
      {
        ...create,
        profiles: [{ ...profile, projectMcp: [{ server: 'project-tools', tools: [' inspect_asset'] }] }],
      },
    ];

    for (const candidate of cases) expect(validateMissionAction(candidate).success).toBe(false);
  });

  it('rejects finite numeric values that cannot be represented safely', () => {
    expect(
      validateMissionAction({
        ...validActionByType['create-mission'],
        budget: { ...budget, usd: Number.MAX_VALUE },
      }).success,
    ).toBe(false);
    expect(
      validateMissionAction({
        ...validActionByType['observe-child-usage'],
        usage: { ...usage, activeSeconds: Number.MAX_VALUE },
      }).success,
    ).toBe(false);
  });

  it('provides a throwing parser for simple kernel admission', () => {
    expect(parseMissionAction(validActionByType['complete-mission'])).toEqual(
      validActionByType['complete-mission'],
    );
    expect(() => parseMissionAction({ type: 'complete-mission' })).toThrow(MissionActionValidationError);
  });
});
