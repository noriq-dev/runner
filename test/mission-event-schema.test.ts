import { describe, expect, it } from 'vitest';
import {
  MissionEventValidationError,
  parseMissionEvent,
  validateMissionEvent,
} from '../src/mission/event-schema';
import {
  MAX_MISSION_REVIEW_SUMMARY_CHARS,
  MAX_MISSION_VALIDATION_OUTPUT_BYTES,
  type MissionEvent,
} from '../src/mission/protocol';

const budget = { tokens: 1_000, usd: 10, activeSeconds: 600 } as const;
const usage = { tokens: 500, usd: null, activeSeconds: 120 } as const;
const projectMcpFingerprint = 'a'.repeat(64);
const projectMcp = [{ server: 'project-tools', tools: ['inspect_asset', 'edit_asset'] }] as const;
const buildPosture = {
  kind: 'build',
  permission: { write: true, allow: ['Read', 'Write'], deny: ['Delete'], auto: false },
  lineageRole: 'worker',
} as const;
const guide = {
  profileId: 'guide',
  agent: { driver: 'claude', model: 'guide-model', effort: 'high' },
  budget,
  turnLimit: 20,
} as const;
const profiles = [
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
] as const;
const child = {
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
} as const;
const proposal = {
  type: 'spawn-child',
  guideEpoch: 0,
  ...child,
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

const validEventByType = {
  'mission-created': {
    type: 'mission-created',
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
    guide,
    profiles,
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
  'guide-turn-started': {
    type: 'guide-turn-started',
    turnId: 'guide-turn-1',
    guideEpoch: 0,
    profileId: 'guide',
    budget,
  },
  'guide-turn-completed': {
    type: 'guide-turn-completed',
    turnId: 'guide-turn-1',
    outcome: 'proposed',
    summary: 'Proposed a bounded builder child.',
    usage,
    proposal,
  },
  'guide-proposal-applied': { type: 'guide-proposal-applied', turnId: 'guide-turn-1' },
  'execution-plan-adopted': {
    type: 'execution-plan-adopted',
    plannerChildId: 'planner-1',
    guideEpoch: 0,
    planFingerprint: 'b'.repeat(64),
    plan: executionPlan,
  },
  'child-reserved': { type: 'child-reserved', child, guideEpoch: 0 },
  'child-started': {
    type: 'child-started',
    childId: 'builder-1',
    attemptId: 'attempt-1',
    sessionId: null,
  },
  'child-usage-observed': { type: 'child-usage-observed', childId: 'builder-1', usage },
  'child-cancel-requested': {
    type: 'child-cancel-requested',
    childId: 'builder-1',
    reason: 'The mission was cancelled.',
    guideEpoch: 0,
  },
  'child-completed': {
    type: 'child-completed',
    childId: 'builder-1',
    outcome: 'succeeded',
    summary: 'Implementation and local checks completed.',
    usage,
    artifact: executionPlan,
  },
  'budget-constraint-triggered': {
    type: 'budget-constraint-triggered',
    constraintId: 'child:builder-1:tokens:exceeded',
    scope: 'child',
    childId: 'builder-1',
    axis: 'tokens',
    reason: 'exceeded',
    observed: 1_001,
    limit: 1_000,
  },
  'checkpoint-recorded': {
    type: 'checkpoint-recorded',
    checkpointId: 'abc123',
    revisionId: 'git:abc123',
    authorChildId: 'builder-1',
    changed: true,
    parentCheckpointId: null,
    clean: true,
    description: 'Verified implementation checkpoint.',
  },
  'workspace-reconciled': {
    type: 'workspace-reconciled',
    childId: 'builder-1',
    revisionId: 'git:abc123',
    disposition: 'restored',
    summary: 'Removed residual writes and restored the exact checkpoint.',
  },
  'review-recorded': {
    type: 'review-recorded',
    reviewId: 'review-1',
    reviewerChildId: 'reviewer-1',
    checkpointId: 'abc123',
    revisionId: 'git:abc123',
    verdict: 'passed',
    highestSeverity: 'none',
    summary: 'No actionable findings.',
  },
  'validation-started': {
    type: 'validation-started',
    validationId: 'validation-1',
    checkpointId: 'abc123',
    revisionId: 'git:abc123',
    policyId: 'test-command-v1',
  },
  'validation-recorded': {
    type: 'validation-recorded',
    validationId: 'validation-1',
    checkpointId: 'abc123',
    revisionId: 'git:abc123',
    policyId: 'test-command-v1',
    disposition: 'passed',
    exitCode: 0,
    timedOut: false,
    workspaceChanged: false,
    outputTail: 'Tests passed.',
  },
  'question-raised': {
    type: 'question-raised',
    questionId: 'question-1',
    prompt: 'Which supported behavior should be preserved?',
    guideEpoch: 0,
  },
  'question-answered': {
    type: 'question-answered',
    questionId: 'question-1',
    answer: 'Preserve both modes.',
  },
  'guide-replaced': {
    type: 'guide-replaced',
    previousGuideEpoch: 0,
    guideEpoch: 1,
    reason: 'The prior guide session disconnected.',
  },
  'mission-completed': {
    type: 'mission-completed',
    outcome: 'succeeded',
    reason: 'The latest clean checkpoint passed independent review.',
    checkpointId: 'abc123',
    guideEpoch: 0,
  },
  'cleanup-required': { type: 'cleanup-required', cleanupId: 'release-workspace' },
  'cleanup-completed': { type: 'cleanup-completed', cleanupId: 'release-workspace' },
  'cleanup-failed': {
    type: 'cleanup-failed',
    cleanupId: 'release-workspace',
    error: 'Workspace is still busy.',
  },
  'accepted-revision-handoff-recorded': {
    type: 'accepted-revision-handoff-recorded',
    backend: 'git',
    repositoryKey: 'runner',
    checkpointId: 'abc123',
    revisionId: 'git:abc123',
    reference: 'refs/noriq/accepted/mission-1',
    status: 'preserved',
  },
} satisfies {
  [Type in MissionEvent['type']]: Extract<MissionEvent, { type: Type }>;
};

const validEvents: readonly MissionEvent[] = Object.values(validEventByType);

const clone = <T>(value: T): T => structuredClone(value);

describe('mission event runtime validation', () => {
  it('accepts every member of the MissionEvent union', () => {
    for (const event of validEvents) {
      const result = validateMissionEvent(event);
      expect(result, event.type).toMatchObject({ success: true, event });
    }
  });

  it('rejects unknown event types and additional keys at every object level', () => {
    const created = validEventByType['mission-created'];
    const reserved = validEventByType['child-reserved'];
    const completedTurn = validEventByType['guide-turn-completed'];
    const cases: unknown[] = [
      { type: 'agent-said-so', result: 'success' },
      { ...created, unexpected: true },
      { ...created, objective: { ...created.objective, unexpected: true } },
      { ...created, budget: { ...created.budget, unexpected: 1 } },
      { ...created, guide: { ...created.guide, unexpected: true } },
      { ...created, validationPolicy: { ...created.validationPolicy, unexpected: true } },
      { ...created, profiles: [{ ...created.profiles[0], unexpected: true }] },
      {
        ...created,
        profiles: [
          {
            ...created.profiles[0],
            driverPosture: { ...created.profiles[0].driverPosture, unexpected: true },
          },
        ],
      },
      { ...reserved, child: { ...reserved.child, unexpected: true } },
      {
        ...reserved,
        child: {
          ...reserved.child,
          projectMcp: [{ ...reserved.child.projectMcp[0], unexpected: true }],
        },
      },
      { ...completedTurn, proposal: { ...completedTurn.proposal, unexpected: true } },
      { ...validEventByType['child-usage-observed'], usage: { ...usage, unexpected: 1 } },
    ];

    for (const candidate of cases) expect(validateMissionEvent(candidate).success).toBe(false);
  });

  it('rejects custom and null prototypes, inherited fields, accessors, and symbol keys', () => {
    const cleanup = validEventByType['cleanup-failed'];
    const inherited = Object.assign(Object.create({ inherited: true }) as object, cleanup);
    const nullPrototype = Object.assign(Object.create(null) as object, cleanup);
    let getterCalled = false;
    const accessor = clone(cleanup) as Record<string, unknown>;
    Object.defineProperty(accessor, 'error', {
      enumerable: true,
      get() {
        getterCalled = true;
        return 'do not execute me';
      },
    });
    const symbol = clone(cleanup) as Record<PropertyKey, unknown>;
    symbol[Symbol('hidden')] = true;

    for (const candidate of [inherited, nullPrototype, accessor, symbol]) {
      expect(validateMissionEvent(candidate).success).toBe(false);
    }
    expect(getterCalled).toBe(false);
  });

  it('rejects undefined values, non-finite numbers, sparse arrays, cycles, and hostile arrays', () => {
    const withUndefined = clone(validEventByType['child-reserved']) as Record<string, unknown>;
    ((withUndefined.child as Record<string, unknown>).agent as Record<string, unknown>).model = undefined;
    const sparseProfiles = clone(validEventByType['mission-created']) as Record<string, unknown>;
    sparseProfiles.profiles = new Array(1);
    let arrayGetterCalled = false;
    const hostileCleanup: unknown[] = ['release-workspace'];
    Object.defineProperty(hostileCleanup, 'map', {
      enumerable: true,
      get() {
        arrayGetterCalled = true;
        return Array.prototype.map;
      },
    });
    const withHostileArray = clone(validEventByType['mission-created']) as Record<string, unknown>;
    withHostileArray.cleanup = hostileCleanup;
    const cyclic = clone(validEventByType['mission-created']) as Record<string, unknown>;
    const objective = cyclic.objective as Record<string, unknown>;
    objective.loop = objective;

    for (const candidate of [
      withUndefined,
      { ...validEventByType['child-usage-observed'], usage: { ...usage, tokens: Number.NaN } },
      {
        ...validEventByType['child-usage-observed'],
        usage: { ...usage, activeSeconds: Number.POSITIVE_INFINITY },
      },
      {
        ...validEventByType['child-usage-observed'],
        usage: { ...usage, usd: Number.MAX_VALUE },
      },
      sparseProfiles,
      withHostileArray,
      cyclic,
    ]) {
      expect(validateMissionEvent(candidate).success).toBe(false);
    }
    expect(arrayGetterCalled).toBe(false);
  });

  it('enforces bounded identifiers, text, numeric values, enums, nulls, and resources', () => {
    const cases: unknown[] = [
      { ...validEventByType['child-reserved'], guideEpoch: Number.MAX_SAFE_INTEGER + 1 },
      {
        ...validEventByType['child-reserved'],
        child: { ...child, permission: 'admin' },
      },
      {
        ...validEventByType['child-reserved'],
        child: { ...child, budget: { ...budget, tokens: 1.5 } },
      },
      {
        ...validEventByType['child-reserved'],
        child: { ...child, resources: { editor: 0 } },
      },
      { ...validEventByType['mission-created'], resources: { editor: -1 } },
      {
        ...validEventByType['mission-created'],
        resources: JSON.parse('{"__proto__":1}') as unknown,
      },
      { ...validEventByType['child-started'], sessionId: 7 },
      { ...validEventByType['child-completed'], outcome: 'mostly-succeeded' },
      { ...validEventByType['checkpoint-recorded'], authorChildId: undefined },
      { ...validEventByType['review-recorded'], highestSeverity: null },
      { ...validEventByType['validation-recorded'], checkpointId: null },
      {
        ...validEventByType['validation-recorded'],
        disposition: 'failed',
        exitCode: 0,
        workspaceChanged: false,
      },
      { ...validEventByType['validation-recorded'], workspaceChanged: true },
      {
        ...validEventByType['validation-recorded'],
        outputTail: '🚀'.repeat(MAX_MISSION_VALIDATION_OUTPUT_BYTES / 2),
      },
      {
        ...validEventByType['review-recorded'],
        summary: 'x'.repeat(MAX_MISSION_REVIEW_SUMMARY_CHARS + 1),
      },
      { ...validEventByType['mission-completed'], checkpointId: false },
      { ...validEventByType['cleanup-failed'], error: 'x'.repeat(16_385) },
      {
        ...validEventByType['budget-constraint-triggered'],
        observed: Number.MAX_SAFE_INTEGER + 1,
      },
    ];

    for (const candidate of cases) expect(validateMissionEvent(candidate).success).toBe(false);
  });

  it('enforces guide proposal and budget-constraint shape invariants', () => {
    const completedTurn = validEventByType['guide-turn-completed'];
    const constraint = validEventByType['budget-constraint-triggered'];
    const cases: unknown[] = [
      { ...completedTurn, outcome: 'failed' },
      { ...completedTurn, proposal: null },
      { ...constraint, childId: undefined },
      { ...constraint, scope: 'mission' },
      { ...constraint, scope: 'guide', turnId: 'guide-turn-1' },
      { ...constraint, reason: 'unknown' },
      { ...constraint, reason: 'unknown', observed: 500 },
      { ...constraint, observed: null },
      { ...constraint, limit: 1.5 },
    ];

    for (const candidate of cases) expect(validateMissionEvent(candidate).success).toBe(false);

    for (const alternateProposal of [
      {
        type: 'request-child-cancel',
        guideEpoch: 0,
        childId: 'builder-1',
        reason: 'The live budget was exceeded.',
      },
      {
        type: 'raise-question',
        guideEpoch: 0,
        questionId: 'question-1',
        prompt: 'Which behavior is intended?',
      },
      {
        type: 'complete-mission',
        guideEpoch: 0,
        outcome: 'succeeded',
        reason: 'The exact checkpoint passed review.',
        checkpointId: 'abc123',
      },
    ] as const) {
      expect(validateMissionEvent({ ...completedTurn, proposal: alternateProposal }).success).toBe(true);
    }
    expect(validateMissionEvent({ ...completedTurn, outcome: 'failed', proposal: null }).success).toBe(true);

    expect(
      validateMissionEvent({
        type: 'budget-constraint-triggered',
        constraintId: 'guide:guide-turn-1:usd:unknown',
        scope: 'guide',
        turnId: 'guide-turn-1',
        axis: 'usd',
        reason: 'unknown',
        observed: null,
        limit: 3.5,
      }).success,
    ).toBe(true);
  });

  it('rejects duplicate profile, permission, MCP tool, server, and cleanup entries', () => {
    const created = validEventByType['mission-created'];
    const profile = created.profiles[0];
    const cases: unknown[] = [
      { ...created, profiles: [profile, clone(profile)] },
      { ...created, cleanup: ['release-workspace', 'release-workspace'] },
      {
        ...created,
        profiles: [
          {
            ...profile,
            driverPosture: {
              ...profile.driverPosture,
              permission: { ...profile.driverPosture.permission, allow: ['Read', 'Read'] },
            },
          },
        ],
      },
      {
        ...created,
        profiles: [
          {
            ...profile,
            projectMcp: [{ server: 'project-tools', tools: ['inspect_asset', 'inspect_asset'] }],
          },
        ],
      },
      {
        ...created,
        profiles: [
          {
            ...profile,
            projectMcp: [projectMcp[0], clone(projectMcp[0])],
          },
        ],
      },
    ];

    for (const candidate of cases) expect(validateMissionEvent(candidate).success).toBe(false);
  });

  it('binds exact MCP grants to one valid declaration fingerprint', () => {
    const created = validEventByType['mission-created'];
    const profile = created.profiles[0];
    const cases: unknown[] = [
      { ...created, projectMcpDeclarationFingerprint: null },
      { ...created, projectMcpDeclarationFingerprint: 'A'.repeat(64) },
      { ...created, projectMcpDeclarationFingerprint: 'a'.repeat(63) },
      { ...created, profiles: [{ ...profile, projectMcp: [] }] },
      {
        ...created,
        profiles: [{ ...profile, projectMcp: [{ server: 'bad.server', tools: ['inspect_asset'] }] }],
      },
      {
        ...created,
        profiles: [{ ...profile, projectMcp: [{ server: 'project-tools', tools: ['inspect_*'] }] }],
      },
    ];

    for (const candidate of cases) expect(validateMissionEvent(candidate).success).toBe(false);
  });

  it('returns a detached event and provides a throwing parser', () => {
    const source = clone(validEventByType['mission-created']);
    const parsed = parseMissionEvent(source);
    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);

    const mutableSource = source as unknown as {
      objective: { brief: string };
      profiles: Array<{
        agent: { driver: string };
        projectMcp: Array<{ tools: string[] }>;
      }>;
    };
    mutableSource.objective.brief = 'mutated source';
    mutableSource.profiles[0]!.agent.driver = 'mutated-driver';
    mutableSource.profiles[0]!.projectMcp[0]!.tools[0] = 'mutated-tool';
    expect(parsed).toEqual(validEventByType['mission-created']);
    expect(() => parseMissionEvent({ type: 'mission-created' })).toThrow(MissionEventValidationError);
  });
});
