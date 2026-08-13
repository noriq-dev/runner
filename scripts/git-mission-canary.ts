import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createGitMissionWorkspaceAdapter } from '../src/mission/git-workspace-adapter';
import type {
  MissionChildExecutor,
  MissionChildResult,
  MissionGuide,
  MissionGuideRequest,
} from '../src/mission/harness';
import { JsonlMissionStore } from '../src/mission/jsonl-store';
import { missionExecutionPlanFingerprint } from '../src/mission/plan-identity';
import {
  missionProfileCatalogResourceCapacities,
  snapshotMissionProfileCatalog,
} from '../src/mission/profile-catalog';
import type {
  MissionExecutionPlanArtifact,
  MissionExecutionProfile,
  MissionGuideProfile,
  MissionUsage,
} from '../src/mission/protocol';
import { MissionService } from '../src/mission/service';

const execFileP = promisify(execFile);
const CANARY_FILE = 'noriq-mission-canary.txt';
const GUIDE_USAGE: MissionUsage = { tokens: 17, usd: 0, activeSeconds: 0.01 };
const PLANNER_USAGE: MissionUsage = { tokens: 37, usd: 0, activeSeconds: 0.02 };
const INITIAL_BUILD_USAGE: MissionUsage = { tokens: 53, usd: 0, activeSeconds: 0.03 };
const REPAIR_USAGE: MissionUsage = { tokens: 41, usd: 0, activeSeconds: 0.02 };
const REVIEW_USAGE: MissionUsage = { tokens: 29, usd: 0, activeSeconds: 0.01 };

const runtimeAuthority = Object.freeze({
  authorityFingerprint: `sha256:${'c'.repeat(64)}` as const,
  assertAuthority: async () => undefined,
});

export interface GitMissionCanaryTarget {
  repositoryKey: string;
  repositoryRoot: string;
}

export interface GitMissionCanaryResult {
  repositoryKey: string;
  sourceRoot: string;
  sourceRevision: string;
  disposableCloneRemoved: true;
  missionId: string;
  status: 'succeeded';
  guideTurns: number;
  childRoles: string[];
  reviewVerdicts: string[];
  repairRounds: number;
  usage: MissionUsage;
  acceptedRevision: string;
  acceptedReference: string;
  acceptedFile: string;
  elapsedMs: number;
}

function guideEnvelope(request: MissionGuideRequest, actionId: string, action: object): string {
  return JSON.stringify({
    missionId: request.projection.missionId,
    guideEpoch: request.projection.guideEpoch,
    expectedRevision: request.projection.revision,
    actionId,
    action,
  });
}

function profileCatalog() {
  const guide: MissionGuideProfile = {
    profileId: 'canary-guide',
    agent: { driver: 'claude', model: 'deterministic-canary-guide', effort: 'high' },
    budget: { tokens: 500, usd: null, activeSeconds: 30 },
    turnLimit: 5,
  };
  const profiles: readonly MissionExecutionProfile[] = [
    {
      profileId: 'canary-planner',
      role: 'planner',
      permission: 'read',
      agent: { driver: 'claude', model: 'deterministic-canary-planner', effort: 'high' },
      assurance: { rank: 2, independenceClass: 'planning' },
      driverPosture: {
        kind: 'scope',
        permission: { write: false, allow: ['Read'], deny: ['Edit', 'Network'], auto: false },
        lineageRole: 'planner',
      },
      budget: { tokens: 200, usd: null, activeSeconds: 30 },
      resources: {},
      projectMcp: [],
    },
    {
      profileId: 'canary-builder',
      role: 'builder',
      permission: 'write',
      agent: { driver: 'codex', model: 'deterministic-canary-builder', effort: 'medium' },
      assurance: { rank: 1, independenceClass: 'build' },
      driverPosture: {
        kind: 'build',
        permission: { write: true, allow: ['Read', 'Edit'], deny: ['Network'], auto: false },
        lineageRole: 'worker',
      },
      budget: { tokens: 200, usd: null, activeSeconds: 30 },
      resources: { 'workspace-writer': 1 },
      projectMcp: [],
    },
    {
      profileId: 'canary-reviewer',
      role: 'reviewer',
      permission: 'read',
      agent: { driver: 'claude', model: 'deterministic-canary-reviewer', effort: 'high' },
      assurance: { rank: 3, independenceClass: 'independent-review' },
      driverPosture: {
        kind: 'verify',
        permission: { write: false, allow: ['Read'], deny: ['Edit', 'Network'], auto: false },
        lineageRole: 'reviewer',
      },
      budget: { tokens: 200, usd: null, activeSeconds: 30 },
      resources: {},
      projectMcp: [],
    },
  ];
  return snapshotMissionProfileCatalog({
    guide,
    profiles,
    validationPolicy: {
      kind: 'none',
      policyId: 'git-canary-structural-v1',
      reason: 'The canary proves orchestration and exact Git evidence without repository-specific commands.',
    },
  });
}

function executionPlan(repositoryKey: string): MissionExecutionPlanArtifact {
  return {
    type: 'execution-plan',
    summary: `Exercise the complete reviewed Git mission lifecycle for ${repositoryKey}.`,
    steps: [
      {
        id: 'write-reviewed-canary',
        title: 'Create and independently review the canary artifact',
        profileId: 'canary-builder',
        reviewProfileId: 'canary-reviewer',
        instruction: `Write ${CANARY_FILE}; repair it if the independent reviewer requests changes.`,
        acceptance: [
          `${CANARY_FILE} records status=accepted and repository=${repositoryKey}.`,
          'The accepted content is preserved by an exact Git revision and branch reference.',
        ],
      },
    ],
  };
}

function scriptedGuide(
  repositoryKey: string,
  plan: MissionExecutionPlanArtifact,
): {
  guide: MissionGuide;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    guide: {
      async next(request) {
        calls += 1;
        const planner = request.projection.children.find((child) => child.profileId === 'canary-planner');
        if (!planner) {
          return {
            output: guideEnvelope(request, 'dispatch-canary-planner', {
              type: 'dispatch_child',
              childId: 'canary-planner',
              profileId: 'canary-planner',
              instruction: `Plan one bounded, reviewed Git canary for ${repositoryKey}.`,
            }),
            usage: GUIDE_USAGE,
          };
        }
        if (request.projection.pendingPlan) {
          return {
            output: guideEnvelope(request, 'adopt-canary-plan', {
              type: 'adopt_plan',
              plannerChildId: request.projection.pendingPlan.plannerChildId,
              planFingerprint: request.projection.pendingPlan.planFingerprint,
            }),
            usage: GUIDE_USAGE,
          };
        }
        const checkpoint = request.projection.checkpoint;
        if (
          checkpoint?.clean &&
          checkpoint.review?.verdict === 'passed' &&
          checkpoint.review.highestSeverity === 'none'
        ) {
          return {
            output: guideEnvelope(request, 'complete-canary-mission', {
              type: 'propose_completion',
              outcome: 'succeeded',
              reason: 'The repaired checkpoint passed exact independent review.',
              checkpointId: checkpoint.checkpointId,
            }),
            usage: GUIDE_USAGE,
          };
        }
        throw new Error(
          `canary guide reached an unexpected state after ${calls} calls; plan ${missionExecutionPlanFingerprint(plan)}`,
        );
      },
    },
  };
}

function scriptedChildren(
  repositoryKey: string,
  plan: MissionExecutionPlanArtifact,
  workspace: ReturnType<typeof createGitMissionWorkspaceAdapter>,
): MissionChildExecutor {
  return {
    async startOrAttach(request) {
      const resolution = await workspace.resolve(request.state, request.child);
      let activated = false;
      return {
        attemptId: request.attemptId,
        async activate() {
          await resolution.verifyLaunchAuthority();
          activated = true;
        },
        async cancel() {},
        async done(): Promise<MissionChildResult> {
          if (!activated) throw new Error(`child '${request.child.childId}' ran before activation`);
          if (request.child.profileId === 'canary-planner') {
            await request.onUsage(PLANNER_USAGE);
            return {
              outcome: 'succeeded',
              summary: 'Produced one bounded step with an independent exact-revision review.',
              usage: PLANNER_USAGE,
              artifact: plan,
            };
          }
          if (request.child.permission === 'write') {
            const repairing = request.child.instruction.includes('Repair round:');
            const content = [
              `status=${repairing ? 'accepted' : 'needs-review'}`,
              `repository=${repositoryKey}`,
              `phase=${repairing ? 'repair' : 'initial-build'}`,
              '',
            ].join('\n');
            await writeFile(path.join(resolution.cwd, CANARY_FILE), content, 'utf8');
            const usage = repairing ? REPAIR_USAGE : INITIAL_BUILD_USAGE;
            await request.onUsage(usage);
            return {
              outcome: 'succeeded',
              summary: repairing
                ? 'Repaired the canary artifact to its accepted state.'
                : 'Created the initial canary artifact for independent review.',
              usage,
            };
          }
          const content = await readFile(path.join(resolution.cwd, CANARY_FILE), 'utf8');
          const passed = content.includes('status=accepted');
          await request.onUsage(REVIEW_USAGE);
          return {
            outcome: 'succeeded',
            summary: passed ? 'The exact repaired revision passed.' : 'The exact revision needs one repair.',
            usage: REVIEW_USAGE,
            artifact: {
              type: 'review',
              checkpointId: request.child.subjectCheckpointId ?? 'missing-checkpoint',
              revisionId: resolution.revisionId,
              verdict: passed ? 'passed' : 'changes-requested',
              highestSeverity: passed ? 'none' : 'low',
              summary: passed
                ? 'The exact revision contains the accepted repository-bound canary content.'
                : 'Set status=accepted while preserving the repository identity.',
            },
          };
        },
      };
    },
  };
}

async function git(args: readonly string[], cwd?: string): Promise<string> {
  const result = await execFileP('git', [...args], {
    ...(cwd ? { cwd } : {}),
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout.trim();
}

export async function runGitMissionCanary(target: GitMissionCanaryTarget): Promise<GitMissionCanaryResult> {
  const started = Date.now();
  const sourceRoot = await realpath(target.repositoryRoot);
  const sourceTopLevel = await realpath(await git(['rev-parse', '--show-toplevel'], sourceRoot));
  if (sourceTopLevel !== sourceRoot) {
    throw new Error(`canary target '${sourceRoot}' is not an exact Git top-level`);
  }
  const sourceRevision = await git(['rev-parse', '--verify', 'HEAD^{commit}'], sourceRoot);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `noriq-${target.repositoryKey}-canary-`));
  const cloneRoot = path.join(tempRoot, 'repository');
  const stateRoot = path.join(tempRoot, 'state');
  const worktreeRoot = path.join(tempRoot, 'worktrees');
  try {
    await git(['clone', '--quiet', '--shared', sourceRoot, cloneRoot]);
    const cloneRevision = await git(['rev-parse', '--verify', 'HEAD^{commit}'], cloneRoot);
    if (cloneRevision !== sourceRevision) {
      throw new Error(`disposable clone changed base from ${sourceRevision} to ${cloneRevision}`);
    }
    const missionDigest = createHash('sha256')
      .update(`${target.repositoryKey}\0${sourceRevision}\0${tempRoot}`, 'utf8')
      .digest('hex')
      .slice(0, 20);
    const missionId = `git-canary-${missionDigest}`;
    const workspace = createGitMissionWorkspaceAdapter({
      repositoryKey: target.repositoryKey,
      repositoryRoot: cloneRoot,
      stateDirectory: path.join(stateRoot, 'git'),
      worktreeDirectory: worktreeRoot,
      runtimeAuthority,
    });
    await workspace.preflight();
    const objective = {
      brief: `Run the reviewed Git orchestration canary for ${target.repositoryKey}.`,
      repositoryKey: target.repositoryKey,
      baseRevision: sourceRevision,
      runId: missionId,
    };
    await workspace.validateMissionAuthority(missionId, objective);

    const catalog = profileCatalog();
    const plan = executionPlan(target.repositoryKey);
    const guide = scriptedGuide(target.repositoryKey, plan);
    const store = new JsonlMissionStore(path.join(stateRoot, 'journals'));
    const service = new MissionService(
      {
        store,
        guide: guide.guide,
        guideOwnerDeathProof: { ownerDeathTerminatesProcessTree: true },
        children: scriptedChildren(target.repositoryKey, plan, workspace),
        evidence: workspace.evidence,
        validation: workspace.validation,
        cleanup: workspace.cleanup,
        acceptedRevisionHandoff: workspace.acceptedRevisionHandoff,
      },
      [catalog],
    );
    const created = await service.create({
      missionId,
      actionId: 'create-git-canary',
      catalogFingerprint: catalog.fingerprint,
      objective,
      budget: { tokens: 10_000, usd: null, activeSeconds: 1_000 },
      resources: missionProfileCatalogResourceCapacities(catalog),
      completion: { requireCheckpoint: true, requireReview: true },
      cleanup: workspace.cleanupPlan,
    });
    if (!created.accepted) throw new Error(`canary mission creation was refused: ${created.reason}`);

    const stop = await service.control(missionId);
    if (stop.reason !== 'terminal' || stop.state.status !== 'succeeded') {
      throw new Error(
        stop.reason === 'runtime-error'
          ? `canary mission failed at runtime: ${stop.error}`
          : `canary mission stopped as ${stop.reason}/${stop.state.status}: ${stop.state.terminal?.reason ?? 'no terminal reason'}`,
      );
    }
    const handoff = stop.state.acceptedRevisionHandoff;
    if (!handoff) throw new Error('successful canary omitted its accepted Git handoff');
    const namedRevision = await git(['rev-parse', '--verify', `${handoff.reference}^{commit}`], cloneRoot);
    if (namedRevision !== handoff.revisionId) {
      throw new Error(`handoff ${handoff.reference} names ${namedRevision}, expected ${handoff.revisionId}`);
    }
    const acceptedFile = await git(['show', `${handoff.revisionId}:${CANARY_FILE}`], cloneRoot);
    const expectedFile = `status=accepted\nrepository=${target.repositoryKey}\nphase=repair`;
    if (acceptedFile !== expectedFile) {
      throw new Error(`accepted canary content differs: ${JSON.stringify(acceptedFile)}`);
    }
    const reviews = stop.state.reviewOrder.map((reviewId) => stop.state.reviews[reviewId]!);
    const childRoles = stop.state.childOrder.map((childId) => stop.state.children[childId]!.role);
    return {
      repositoryKey: target.repositoryKey,
      sourceRoot,
      sourceRevision,
      disposableCloneRemoved: true,
      missionId,
      status: 'succeeded',
      guideTurns: guide.calls(),
      childRoles,
      reviewVerdicts: reviews.map((review) => `${review.verdict}:${review.highestSeverity}`),
      repairRounds: childRoles.filter((role) => role === 'builder').length - 1,
      usage: stop.state.usage,
      acceptedRevision: handoff.revisionId,
      acceptedReference: handoff.reference,
      acceptedFile,
      elapsedMs: Date.now() - started,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function parseTargets(args: readonly string[]): GitMissionCanaryTarget[] {
  if (args.length === 0) {
    throw new Error('usage: npm run test:canary:git -- repository-key=/absolute/git/repository [...]');
  }
  return args.map((argument) => {
    const separator = argument.indexOf('=');
    if (separator <= 0 || separator === argument.length - 1) {
      throw new Error(`invalid canary target '${argument}'; expected repository-key=/absolute/path`);
    }
    const repositoryKey = argument.slice(0, separator);
    const repositoryRoot = argument.slice(separator + 1);
    if (!path.isAbsolute(repositoryRoot)) {
      throw new Error(`canary repository '${repositoryRoot}' must be absolute`);
    }
    return { repositoryKey, repositoryRoot };
  });
}

async function main(): Promise<void> {
  const targets = parseTargets(process.argv.slice(2));
  const results = [];
  for (const target of targets) results.push(await runGitMissionCanary(target));
  process.stdout.write(`${JSON.stringify({ mode: 'deterministic-agent', results }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
