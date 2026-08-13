import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DIVERSION_MISSION_WORKSPACE_CLEANUP_ID,
  type DiversionMissionCli,
  type DiversionMissionHttp,
  DiversionMissionWorkspaceAdapter,
} from '../src/mission/diversion-workspace-adapter';
import {
  type MissionCheckpointState,
  type MissionChildState,
  type MissionState,
  initialMissionState,
} from '../src/mission/model';
import type { MissionReviewArtifact } from '../src/mission/protocol';
import type {
  AgentProcessContainment,
  AgentProcessLaunch,
  ContainedAgentProcess,
} from '../src/process-containment';

const roots: string[] = [];
const REPO_ID = 'dv.repo.test';
const REPOSITORY_KEY = 'example/diversion';
const BASE = 'dv.commit.1';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const posture = (permission: 'read' | 'write') =>
  ({
    kind: permission === 'write' ? 'build' : 'verify',
    permission: {
      write: permission === 'write',
      allow: ['Read'],
      deny: permission === 'write' ? [] : ['Edit'],
      auto: false,
    },
    lineageRole: permission === 'write' ? 'worker' : 'reviewer',
  }) as const;

function child(
  childId: string,
  permission: 'read' | 'write',
  status: MissionChildState['status'] = 'running',
  overrides: Partial<MissionChildState> = {},
): MissionChildState {
  return {
    childId,
    role: permission === 'write' ? 'builder' : 'reviewer',
    instruction: 'Perform bounded work.',
    permission,
    agent: { driver: 'test', model: 'test' },
    driverPosture: posture(permission),
    profileId: permission === 'write' ? 'builder' : 'reviewer',
    budget: { tokens: 100, usd: null, activeSeconds: 100 },
    resources: {},
    projectMcp: [],
    subjectCheckpointId: null,
    planStepId: null,
    status,
    attemptId: 'attempt-1',
    sessionId: 'session-1',
    usage: { tokens: 1, usd: 0, activeSeconds: 1 },
    summary: status === 'running' ? null : 'Child completed.',
    artifact: null,
    cancelReason: null,
    ...overrides,
  };
}

function missionState(
  missionId: string,
  missionChild?: MissionChildState,
  checkpoints: readonly MissionCheckpointState[] = [],
): MissionState {
  return {
    ...initialMissionState(missionId),
    revision: 1,
    status: 'active',
    objective: {
      brief: 'Perform a bounded Diversion mission.',
      repositoryKey: REPOSITORY_KEY,
      baseRevision: BASE,
    },
    children: missionChild ? { [missionChild.childId]: missionChild } : {},
    childOrder: missionChild ? [missionChild.childId] : [],
    checkpoints: Object.fromEntries(checkpoints.map((checkpoint) => [checkpoint.checkpointId, checkpoint])),
    checkpointOrder: checkpoints.map((checkpoint) => checkpoint.checkpointId),
  };
}

interface Branch {
  branch_id: string;
  branch_name: string;
  commit_id: string;
  branch_description: string;
}

interface Workspace {
  workspace_id: string;
  repo_id: string;
  name: string;
  branch_id: string;
  base_commit_id: string;
  source_commit: string;
  journal_ordinal_id: number;
  localPath?: string;
}

class FakeDiversion {
  readonly branches = new Map<string, Branch>();
  readonly workspaces = new Map<string, Workspace>();
  readonly commits = new Map<
    string,
    { commit_id: string; branch_id: string; parents: string[]; commit_message: string }
  >();
  readonly calls: string[] = [];
  dirty = false;
  ignoredDirty = false;
  nextBranch = 1;
  nextWorkspace = 1;
  nextCommit = 2;
  failBeforeBranchCreate = false;
  failAfterBranchCreate = false;
  failAfterWorkspaceCreate = false;
  failAfterCommit = false;
  failAfterWorkspaceDelete = false;

  constructor() {
    this.commits.set(BASE, {
      commit_id: BASE,
      branch_id: 'dv.branch.main',
      parents: [],
      commit_message: 'base',
    });
  }

  private branch(id: string): Branch {
    const branch = this.branches.get(id);
    if (!branch) throw new Error(`missing fake branch ${id}`);
    return branch;
  }

  private workspace(id: string): Workspace {
    const workspace = this.workspaces.get(id);
    if (!workspace) throw new Error(`missing fake workspace ${id}`);
    return workspace;
  }

  http: DiversionMissionHttp = async (method, apiPath, body) => {
    this.calls.push(`${method} ${apiPath}`);
    const prefix = `/repos/${REPO_ID}`;
    if (!apiPath.startsWith(prefix)) throw new Error(`unexpected repo path ${apiPath}`);
    const suffix = apiPath.slice(prefix.length);
    if (method === 'GET' && suffix === '') return { status: 200, body: { repo_id: REPO_ID } };

    const commitGet = suffix.match(/^\/commits\/(dv\.commit\.[^/]+)$/);
    if (method === 'GET' && commitGet) {
      const commit = this.commits.get(decodeURIComponent(commitGet[1]!));
      return commit ? { status: 200, body: commit } : { status: 404, body: null };
    }

    if (method === 'GET' && suffix === '/branches') {
      return { status: 200, body: { object: 'Branch', items: [...this.branches.values()] } };
    }
    if (method === 'POST' && suffix === '/branches') {
      if (this.failBeforeBranchCreate) {
        this.failBeforeBranchCreate = false;
        throw new Error('injected crash before branch create');
      }
      const request = body as {
        commit_id: string;
        branch_name: string;
        branch_description: string;
      };
      const id = `dv.branch.${this.nextBranch++}`;
      this.branches.set(id, {
        branch_id: id,
        branch_name: request.branch_name,
        commit_id: request.commit_id,
        branch_description: request.branch_description,
      });
      if (this.failAfterBranchCreate) {
        this.failAfterBranchCreate = false;
        throw new Error('injected crash after branch create');
      }
      return { status: 201, body: { id } };
    }
    const branchGet = suffix.match(/^\/branches\/(dv\.branch\.[^/]+)$/);
    if (method === 'GET' && branchGet) {
      const branch = this.branches.get(decodeURIComponent(branchGet[1]!));
      return branch ? { status: 200, body: branch } : { status: 404, body: null };
    }

    if (method === 'GET' && suffix === '/workspaces') {
      return { status: 200, body: { object: 'Workspace', items: [...this.workspaces.values()] } };
    }
    if (method === 'POST' && suffix === '/workspaces') {
      const request = body as { branch_id: string; name: string };
      const branch = this.branch(request.branch_id);
      const id = `dv.ws.${this.nextWorkspace++}`;
      this.workspaces.set(id, {
        workspace_id: id,
        repo_id: REPO_ID,
        name: request.name,
        branch_id: request.branch_id,
        base_commit_id: branch.commit_id,
        source_commit: branch.commit_id,
        journal_ordinal_id: 1,
      });
      if (this.failAfterWorkspaceCreate) {
        this.failAfterWorkspaceCreate = false;
        throw new Error('injected crash after workspace create');
      }
      return { status: 201, body: { id } };
    }
    const workspaceGet = suffix.match(/^\/workspaces\/(dv\.ws\.[^/?]+)$/);
    if (method === 'GET' && workspaceGet) {
      const workspace = this.workspaces.get(decodeURIComponent(workspaceGet[1]!));
      return workspace ? { status: 200, body: workspace } : { status: 404, body: null };
    }
    if (method === 'DELETE' && workspaceGet) {
      const existed = this.workspaces.delete(decodeURIComponent(workspaceGet[1]!));
      if (existed && this.failAfterWorkspaceDelete) {
        this.failAfterWorkspaceDelete = false;
        throw new Error('injected crash after workspace delete');
      }
      return { status: existed ? 204 : 404, body: null };
    }
    const statusGet = suffix.match(/^\/workspaces\/(dv\.ws\.[^/]+)\/status\?/);
    if (method === 'GET' && statusGet) {
      return {
        status: 200,
        body: {
          changed_items_count: this.dirty ? 1 : 0,
          changed_files_count: this.dirty ? 1 : 0,
          incomplete_result: false,
          conflicts: [],
        },
      };
    }
    const autoForward = suffix.match(/^\/workspaces\/(dv\.ws\.[^/]+)\/set_auto_forwarding$/);
    if (method === 'POST' && autoForward) return { status: 204, body: null };
    const reset = suffix.match(/^\/workspaces\/(dv\.ws\.[^/]+)\/reset$/);
    if (method === 'POST' && reset) {
      this.dirty = false;
      return { status: 200, body: { success: ['changed'], fail: [] } };
    }
    const commit = suffix.match(/^\/workspaces\/(dv\.ws\.[^/]+)\/commit$/);
    if (method === 'POST' && commit) {
      if (!this.dirty) return { status: 200, body: null };
      const workspace = this.workspace(decodeURIComponent(commit[1]!));
      const branch = this.branch(workspace.branch_id);
      const id = `dv.commit.${this.nextCommit++}`;
      const request = body as { commit_message: string };
      this.commits.set(id, {
        commit_id: id,
        branch_id: branch.branch_id,
        parents: [branch.commit_id],
        commit_message: request.commit_message,
      });
      branch.commit_id = id;
      workspace.base_commit_id = id;
      this.dirty = false;
      if (this.failAfterCommit) {
        this.failAfterCommit = false;
        throw new Error('injected crash after commit');
      }
      return { status: 201, body: { id, failed_paths: [] } };
    }
    throw new Error(`unhandled fake Diversion request ${method} ${suffix}`);
  };

  private async rewriteLocator(workspace: Workspace): Promise<void> {
    if (!workspace.localPath) return;
    const branch = this.branch(workspace.branch_id);
    workspace.base_commit_id = branch.commit_id;
    const metadata = path.join(workspace.localPath, '.diversion');
    await mkdir(metadata, { recursive: true });
    await writeFile(
      path.join(metadata, workspace.workspace_id),
      JSON.stringify({
        WorkspaceID: workspace.workspace_id,
        RepoID: REPO_ID,
        Path: workspace.localPath,
        BranchID: branch.branch_id,
        BranchName: branch.branch_name,
        CommitID: branch.commit_id,
      }),
    );
  }

  cli: DiversionMissionCli = async (args, cwd) => {
    this.calls.push(`dv ${args.join(' ')}`);
    if (args[0] === 'version') return { stdout: 'dv test\n', stderr: '' };
    if (args[0] === 'clone') {
      const localPath = args[2]!;
      const workspaceId = args[4]!;
      const workspace = this.workspace(workspaceId);
      workspace.localPath = localPath;
      await mkdir(localPath, { recursive: false });
      await this.rewriteLocator(workspace);
      return { stdout: 'cloned\n', stderr: '' };
    }
    if (args[0] === 'status') {
      const workspace = [...this.workspaces.values()].find((candidate) => candidate.localPath === cwd);
      if (!workspace) throw new Error('status outside fake workspace');
      await this.rewriteLocator(workspace);
      return { stdout: `${this.branch(workspace.branch_id).commit_id}\n`, stderr: '' };
    }
    if (args[0] === 'clean') {
      const removedWorkspaceEntries = this.ignoredDirty;
      this.ignoredDirty = false;
      return { stdout: '', stderr: '', removedWorkspaceEntries };
    }
    if (args[0] === 'unregister') {
      await rm(path.join(cwd, '.diversion'), { recursive: true, force: true });
      return { stdout: 'unregistered\n', stderr: '' };
    }
    throw new Error(`unhandled fake dv command: ${args.join(' ')}`);
  };
}

class TestContainment implements AgentProcessContainment {
  readonly capabilities = {
    processTreeTermination: true,
    ownerDeathTermination: true,
    workspaceIsolation: true,
    protectedWorkspaceSubpaths: true,
    projectMcpProcessContainment: true,
  } as const;
  readonly launches: AgentProcessLaunch[] = [];

  async probe(): Promise<void> {}

  spawn(request: AgentProcessLaunch): ContainedAgentProcess {
    this.launches.push(request);
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return {
      child,
      exited: new Promise<void>((resolve, reject) => {
        child.once('exit', () => resolve());
        child.once('error', reject);
      }),
      terminate: (signal = 'SIGTERM') => child.kill(signal),
    };
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noriq-diversion-mission-'));
  roots.push(root);
  const stateDirectory = path.join(root, 'state');
  const workspaceDirectory = path.join(root, 'workspaces');
  const diversion = new FakeDiversion();
  const makeAdapter = () =>
    new DiversionMissionWorkspaceAdapter({
      repositoryKey: REPOSITORY_KEY,
      repoId: REPO_ID,
      stateDirectory,
      workspaceDirectory,
      http: diversion.http,
      cli: diversion.cli,
    });
  return { root, stateDirectory, workspaceDirectory, diversion, makeAdapter };
}

async function leaseRecord(stateDirectory: string): Promise<Record<string, unknown>> {
  const filename = (await readdir(stateDirectory)).find((entry) => entry.startsWith('lease-'));
  if (!filename) throw new Error('expected Diversion lease record');
  return JSON.parse(await readFile(path.join(stateDirectory, filename), 'utf8')) as Record<string, unknown>;
}

function checkpointFromAction(action: {
  checkpointId: string;
  revisionId: string;
  authorChildId: string | null;
  changed?: boolean;
  parentCheckpointId?: string | null;
  clean: boolean;
  description?: string;
}): MissionCheckpointState {
  return {
    checkpointId: action.checkpointId,
    revisionId: action.revisionId,
    authorChildId: action.authorChildId,
    changed: action.changed ?? true,
    parentCheckpointId: action.parentCheckpointId ?? null,
    clean: action.clean,
    description: action.description ?? null,
  };
}

describe('DiversionMissionWorkspaceAdapter', () => {
  it('materializes only a deterministic private workspace and protects its locator', async () => {
    const { workspaceDirectory, diversion, makeAdapter } = await fixture();
    const running = child('planner', 'read');
    const state = missionState('mission-private', running);
    const adapter = makeAdapter();

    await adapter.preflight();
    await adapter.validateMissionAuthority(state.missionId, state.objective ?? undefined);
    const resolution = await adapter.resolve(state, running);

    expect(resolution.cwd.startsWith(`${workspaceDirectory}${path.sep}`)).toBe(true);
    expect(resolution.revisionId).toBe(BASE);
    expect(resolution.protectedWorkspaceReadOnlyPaths).toEqual(['.diversion']);
    await expect(resolution.verifyLaunchAuthority()).resolves.toBeUndefined();
    expect(diversion.branches.size).toBe(1);
    expect(diversion.workspaces.size).toBe(1);
    expect(diversion.calls.some((call) => call.includes('dv clone'))).toBe(true);
  });

  it('recovers branch and workspace identities after create/record crash windows', async () => {
    const { diversion, makeAdapter } = await fixture();
    const running = child('planner', 'read');
    const state = missionState('mission-recover', running);
    diversion.failAfterBranchCreate = true;

    await expect(makeAdapter().resolve(state, running)).rejects.toThrow(/injected crash/);
    expect(diversion.branches.size).toBe(1);
    diversion.failAfterWorkspaceCreate = true;
    await expect(makeAdapter().resolve(state, running)).rejects.toThrow(/injected crash/);
    expect(diversion.workspaces.size).toBe(1);

    await expect(makeAdapter().resolve(state, running)).resolves.toMatchObject({ revisionId: BASE });
    expect(diversion.branches.size).toBe(1);
    expect(diversion.workspaces.size).toBe(1);
  });

  it('releases allocation intents safely before a workspace has ever existed', async () => {
    const beforeBranch = await fixture();
    const running = child('build', 'write');
    const effectFree = missionState('mission-clean-intent', running);
    beforeBranch.diversion.failBeforeBranchCreate = true;
    await expect(beforeBranch.makeAdapter().resolve(effectFree, running)).rejects.toThrow(
      /before branch create/,
    );
    const cancelledEffectFree: MissionState = {
      ...effectFree,
      status: 'cancelled',
      terminal: { outcome: 'cancelled', reason: 'cancelled during allocation', checkpointId: null },
    };

    await beforeBranch.makeAdapter().execute(cancelledEffectFree, DIVERSION_MISSION_WORKSPACE_CLEANUP_ID);
    expect(await leaseRecord(beforeBranch.stateDirectory)).toMatchObject({
      phase: 'released',
      branchId: null,
      workspaceId: null,
      materialized: false,
      localUnregistered: true,
      remoteWorkspaceDeleted: true,
      localRemoved: true,
      preservedRevisionId: BASE,
    });

    const afterBranch = await fixture();
    const branchOnly = missionState('mission-clean-branch', running);
    afterBranch.diversion.failAfterBranchCreate = true;
    await expect(afterBranch.makeAdapter().resolve(branchOnly, running)).rejects.toThrow(
      /after branch create/,
    );
    const cancelledBranchOnly: MissionState = {
      ...branchOnly,
      status: 'cancelled',
      terminal: { outcome: 'cancelled', reason: 'cancelled during allocation', checkpointId: null },
    };

    const cleanup = afterBranch.makeAdapter();
    await cleanup.execute(cancelledBranchOnly, DIVERSION_MISSION_WORKSPACE_CLEANUP_ID);
    await cleanup.execute(cancelledBranchOnly, DIVERSION_MISSION_WORKSPACE_CLEANUP_ID);
    expect(afterBranch.diversion.branches.size).toBe(1);
    expect(afterBranch.diversion.workspaces.size).toBe(0);
    expect(await leaseRecord(afterBranch.stateDirectory)).toMatchObject({
      phase: 'released',
      branchId: 'dv.branch.1',
      workspaceId: null,
      materialized: false,
      remoteWorkspaceDeleted: true,
      preservedRevisionId: BASE,
    });
  });

  it('recovers an exact deterministic checkpoint committed before a crash', async () => {
    const { diversion, makeAdapter } = await fixture();
    const running = child('build', 'write');
    const active = missionState('mission-checkpoint-crash', running);
    const adapter = makeAdapter();
    await adapter.resolve(active, running);
    const completed = child('build', 'write', 'succeeded');
    const terminalChildState = missionState(active.missionId, completed);
    diversion.dirty = true;
    diversion.ignoredDirty = true;
    diversion.failAfterCommit = true;

    await expect(adapter.recordAfterChild(terminalChildState, completed)).rejects.toThrow(/injected crash/);
    const actions = await makeAdapter().recordAfterChild(terminalChildState, completed);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: 'record-checkpoint',
      revisionId: 'dv.commit.2',
      changed: true,
      clean: true,
    });
    expect(diversion.commits.size).toBe(2);
    expect(diversion.ignoredDirty).toBe(false);
  });

  it('resets failed write residue to the exact current revision', async () => {
    const { diversion, makeAdapter } = await fixture();
    const running = child('build', 'write');
    const active = missionState('mission-reset', running);
    const adapter = makeAdapter();
    await adapter.resolve(active, running);
    diversion.dirty = true;
    const failed = child('build', 'write', 'failed');
    const failedState = missionState(active.missionId, failed);

    const actions = await adapter.recordAfterChild(failedState, failed);

    expect(actions).toEqual([
      expect.objectContaining({
        type: 'record-workspace-reconciled',
        childId: 'build',
        revisionId: BASE,
        disposition: 'restored',
      }),
    ]);
    expect(diversion.dirty).toBe(false);
  });

  it('records an exact review without moving the checkpoint', async () => {
    const { diversion, makeAdapter } = await fixture();
    const builder = child('build', 'write');
    const adapter = makeAdapter();
    await adapter.resolve(missionState('mission-review', builder), builder);
    diversion.dirty = true;
    const completed = child('build', 'write', 'succeeded');
    const checkpointAction = (
      await adapter.recordAfterChild(missionState('mission-review', completed), completed)
    )[0];
    if (!checkpointAction || checkpointAction.type !== 'record-checkpoint') {
      throw new Error('expected checkpoint action');
    }
    const checkpoint = checkpointFromAction(checkpointAction);
    const artifact: MissionReviewArtifact = {
      type: 'review',
      checkpointId: checkpoint.checkpointId,
      revisionId: checkpoint.revisionId,
      verdict: 'passed',
      highestSeverity: 'none',
      summary: 'Exact review passed.',
    };
    const reviewer = child('review', 'read', 'succeeded', {
      subjectCheckpointId: checkpoint.checkpointId,
      artifact,
    });
    const reviewState = missionState('mission-review', reviewer, [checkpoint]);

    await expect(adapter.recordAfterChild(reviewState, reviewer)).resolves.toEqual([
      expect.objectContaining({
        type: 'record-review',
        checkpointId: checkpoint.checkpointId,
        revisionId: checkpoint.revisionId,
        verdict: 'passed',
      }),
    ]);
  });

  it('requires bound containment and restores validation mutations before recording failure', async () => {
    const { diversion, makeAdapter } = await fixture();
    const builder = child('build', 'write');
    const adapter = makeAdapter();
    await adapter.resolve(missionState('mission-validation', builder), builder);
    const completed = child('build', 'write', 'succeeded');
    const checkpointAction = (
      await adapter.recordAfterChild(missionState('mission-validation', completed), completed)
    )[0];
    if (!checkpointAction || checkpointAction.type !== 'record-checkpoint') {
      throw new Error('expected checkpoint action');
    }
    const checkpoint = checkpointFromAction(checkpointAction);
    const policy = {
      kind: 'command' as const,
      policyId: 'test-validation',
      command: 'true',
      timeoutSeconds: 10,
      shell: '/bin/sh',
    };
    const validationState: MissionState = {
      ...missionState('mission-validation', undefined, [checkpoint]),
      validationPolicy: policy,
      activeValidation: {
        validationId: 'validation-1',
        checkpointId: checkpoint.checkpointId,
        revisionId: checkpoint.revisionId,
        policyId: policy.policyId,
      },
    };

    await expect(
      adapter.validate(validationState, checkpoint, policy, new AbortController().signal),
    ).rejects.toThrow(/before containment is bound/);
    const containment = new TestContainment();
    adapter.bindContainment(containment);
    await expect(
      adapter.validate(validationState, checkpoint, policy, new AbortController().signal),
    ).resolves.toMatchObject({
      type: 'record-validation',
      validationId: 'validation-1',
      disposition: 'passed',
      workspaceChanged: false,
    });
    expect(containment.launches[0]?.protectedWorkspaceReadOnlyPaths).toEqual(['.diversion']);

    diversion.ignoredDirty = true;
    await expect(
      adapter.validate(validationState, checkpoint, policy, new AbortController().signal),
    ).resolves.toMatchObject({ disposition: 'failed', workspaceChanged: true });
    expect(diversion.ignoredDirty).toBe(false);

    diversion.dirty = true;
    await expect(adapter.recover(validationState, checkpoint, policy)).resolves.toMatchObject({
      type: 'record-validation',
      validationId: 'validation-1',
      disposition: 'failed',
      workspaceChanged: true,
    });
    expect(diversion.dirty).toBe(false);
    expect(containment.launches).toHaveLength(2);
  });

  it('unregisters and deletes only the mission workspace while preserving accepted branch handoff', async () => {
    const { stateDirectory, diversion, makeAdapter } = await fixture();
    const running = child('build', 'write');
    const missionId = 'mission-cleanup';
    const adapter = makeAdapter();
    await adapter.resolve(missionState(missionId, running), running);
    diversion.dirty = true;
    const completed = child('build', 'write', 'succeeded');
    const checkpointAction = (
      await adapter.recordAfterChild(missionState(missionId, completed), completed)
    )[0];
    if (!checkpointAction || checkpointAction.type !== 'record-checkpoint') {
      throw new Error('expected checkpoint action');
    }
    const checkpoint = checkpointFromAction(checkpointAction);
    const terminal: MissionState = {
      ...missionState(missionId, undefined, [checkpoint]),
      revision: 10,
      status: 'succeeded',
      terminal: { outcome: 'succeeded', reason: 'done', checkpointId: checkpoint.checkpointId },
      cleanupPlan: [DIVERSION_MISSION_WORKSPACE_CLEANUP_ID],
      cleanup: {
        [DIVERSION_MISSION_WORKSPACE_CLEANUP_ID]: {
          cleanupId: DIVERSION_MISSION_WORKSPACE_CLEANUP_ID,
          status: 'completed',
          error: null,
        },
      },
    };

    diversion.failAfterWorkspaceDelete = true;
    await expect(adapter.execute(terminal, DIVERSION_MISSION_WORKSPACE_CLEANUP_ID)).rejects.toThrow(
      /after workspace delete/,
    );
    expect(await leaseRecord(stateDirectory)).toMatchObject({
      phase: 'releasing',
      localUnregistered: true,
      remoteWorkspaceDeleted: false,
    });
    await adapter.execute(terminal, DIVERSION_MISSION_WORKSPACE_CLEANUP_ID);
    await adapter.execute(terminal, DIVERSION_MISSION_WORKSPACE_CLEANUP_ID);

    expect(diversion.workspaces.size).toBe(0);
    expect(diversion.branches.size).toBe(1);
    expect(await leaseRecord(stateDirectory)).toMatchObject({
      phase: 'released',
      localUnregistered: true,
      remoteWorkspaceDeleted: true,
      localRemoved: true,
      preservedRevisionId: checkpoint.revisionId,
    });
    await expect(adapter.record(terminal)).resolves.toMatchObject({
      backend: 'diversion',
      checkpointId: checkpoint.checkpointId,
      revisionId: checkpoint.revisionId,
      status: 'preserved',
    });
  });

  it('rejects overlapping private authority roots', async () => {
    const { root, diversion } = await fixture();
    const shared = path.join(root, 'shared');
    const overlap = new DiversionMissionWorkspaceAdapter({
      repositoryKey: REPOSITORY_KEY,
      repoId: REPO_ID,
      stateDirectory: shared,
      workspaceDirectory: path.join(shared, 'workspaces'),
      http: diversion.http,
      cli: diversion.cli,
    });
    await expect(overlap.preflight()).rejects.toThrow(/must not overlap/);
  });
});
