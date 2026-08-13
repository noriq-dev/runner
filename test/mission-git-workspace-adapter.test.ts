import { execFile } from 'node:child_process';
import { constants, accessSync, existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GIT_MISSION_WORKSPACE_CAPABILITIES,
  GIT_MISSION_WORKSPACE_CLEANUP_ID,
  GitMissionWorkspaceAdapter,
  type GitMissionWorkspaceAdapterOptions,
  createGitMissionWorkspaceAdapter,
} from '../src/mission/git-workspace-adapter';
import {
  type MissionCheckpointState,
  type MissionChildState,
  initialMissionState,
} from '../src/mission/model';
import type { MissionReviewArtifact } from '../src/mission/protocol';
import { LinuxBubblewrapContainment } from '../src/process-containment';
import { GitBackend } from '../src/vcs/git';
import { WorktreeManager } from '../src/worktree';

const execFileP = promisify(execFile);
const git = (args: string[], cwd: string) => execFileP('git', args, { cwd });
const roots: string[] = [];
const runtimeAuthority = Object.freeze({
  authorityFingerprint: `sha256:${'d'.repeat(64)}` as const,
  assertAuthority: async () => undefined,
});

class FailBeforeBranchBackend extends GitBackend {
  override async createTarget(): Promise<void> {
    throw new Error('injected crash before branch creation');
  }
}

class FailBeforeActiveRecordBackend extends GitBackend {
  override async lease(): Promise<never> {
    throw new Error('injected crash after branch creation');
  }
}

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
    instruction: 'Perform the bounded work.',
    permission,
    agent: { driver: 'test', model: 'test-model' },
    driverPosture: posture(permission),
    profileId: permission === 'write' ? 'builder' : 'reviewer',
    budget: { tokens: 100, usd: null, activeSeconds: 100 },
    resources: { workspace: 1 },
    projectMcp: [],
    subjectCheckpointId: null,
    planStepId: null,
    status,
    attemptId: 'attempt-1',
    sessionId: 'session-1',
    usage: { tokens: 1, usd: 0, activeSeconds: 1 },
    summary: status === 'running' ? null : 'Bounded child result.',
    artifact: null,
    cancelReason: null,
    ...overrides,
  };
}

function missionState(
  missionId: string,
  baseRevision: string,
  missionChild?: MissionChildState,
  checkpoints: readonly MissionCheckpointState[] = [],
) {
  const initial = initialMissionState(missionId);
  return {
    ...initial,
    revision: 1,
    status: 'active' as const,
    objective: {
      brief: 'Perform the bounded Git mission.',
      repositoryKey: 'example/repository',
      baseRevision,
    },
    children: missionChild ? { [missionChild.childId]: missionChild } : {},
    childOrder: missionChild ? [missionChild.childId] : [],
    checkpoints: Object.fromEntries(checkpoints.map((checkpoint) => [checkpoint.checkpointId, checkpoint])),
    checkpointOrder: checkpoints.map((checkpoint) => checkpoint.checkpointId),
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noriq-git-workspace-adapter-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  const worktrees = path.join(root, 'worktrees');
  const stateDirectory = path.join(root, 'adapter-state');
  await execFileP('git', ['init', '-q', '-b', 'main', repo]);
  await writeFile(path.join(repo, '.gitignore'), 'ignored-cache/\n');
  await writeFile(path.join(repo, 'README.md'), '# mission adapter\n');
  await git(['-c', 'user.email=t@t', '-c', 'user.name=T', 'add', '.'], repo);
  await git(['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '-m', 'base'], repo);
  const baseRevision = (await git(['rev-parse', 'HEAD'], repo)).stdout.trim();
  const manager = () => new WorktreeManager({ baseDir: worktrees });
  const makeAdapter = () =>
    createGitMissionWorkspaceAdapter({
      repositoryKey: 'example/repository',
      repositoryRoot: repo,
      stateDirectory,
      worktreeDirectory: worktrees,
      runtimeAuthority,
    });
  const injectedAdapter = (
    backend: GitBackend,
    overrides: Pick<GitMissionWorkspaceAdapterOptions, 'validationExec'> = {},
  ) =>
    new GitMissionWorkspaceAdapter({
      repositoryKey: 'example/repository',
      repositoryRoot: repo,
      stateDirectory,
      worktreeDirectory: worktrees,
      backend,
      runtimeAuthority,
      ...overrides,
    });
  return { root, repo, worktrees, stateDirectory, baseRevision, manager, makeAdapter, injectedAdapter };
}

async function leaseRecord(stateDirectory: string): Promise<Record<string, unknown>> {
  const filename = (await readdir(stateDirectory)).find((entry) => entry.startsWith('lease-'));
  if (!filename) throw new Error('expected durable lease record');
  return JSON.parse(await readFile(path.join(stateDirectory, filename), 'utf8')) as Record<string, unknown>;
}

function checkpointFromAction(
  action: Extract<
    Awaited<ReturnType<GitMissionWorkspaceAdapter['recordAfterChild']>>[number],
    {
      type: 'record-checkpoint';
    }
  >,
): MissionCheckpointState {
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

describe('GitMissionWorkspaceAdapter (real Git)', () => {
  const bwrapAvailable =
    process.platform === 'linux' &&
    (() => {
      try {
        accessSync('/usr/bin/bwrap', constants.X_OK);
        return true;
      } catch {
        return false;
      }
    })();

  it('preflights the canonical operational repository without mutating Git state', async () => {
    const { repo, worktrees, makeAdapter } = await fixture();
    expect(existsSync(worktrees)).toBe(false);
    const before = {
      status: (await git(['status', '--porcelain=v1', '--untracked-files=all'], repo)).stdout,
      refs: (await git(['for-each-ref', '--format=%(refname) %(objectname)'], repo)).stdout,
      worktrees: (await git(['worktree', 'list', '--porcelain'], repo)).stdout,
    };

    await expect(makeAdapter().preflight()).resolves.toBeUndefined();
    const worktreeMetadata = await lstat(worktrees);
    if (process.platform !== 'win32') expect(worktreeMetadata.mode & 0o077).toBe(0);

    expect({
      status: (await git(['status', '--porcelain=v1', '--untracked-files=all'], repo)).stdout,
      refs: (await git(['for-each-ref', '--format=%(refname) %(objectname)'], repo)).stdout,
      worktrees: (await git(['worktree', 'list', '--porcelain'], repo)).stdout,
    }).toEqual(before);
  });

  it('refuses a nested directory that Git would otherwise discover through an ancestor', async () => {
    const { root, repo } = await fixture();
    const nested = path.join(repo, 'nested-project');
    const stateDirectory = path.join(root, 'nested-adapter-state');
    const worktreeDirectory = path.join(root, 'nested-worktrees');
    await mkdir(nested);
    const adapter = createGitMissionWorkspaceAdapter({
      repositoryKey: 'example/repository',
      repositoryRoot: nested,
      stateDirectory,
      worktreeDirectory,
      runtimeAuthority,
    });

    await expect(adapter.preflight()).rejects.toThrow(/itself contain an explicit \.git marker/);
    expect(existsSync(stateDirectory)).toBe(false);
    expect(existsSync(worktreeDirectory)).toBe(false);
  });

  it('refuses a local gitfile that redirects the configured root to an ancestor repository', async () => {
    const { root, repo } = await fixture();
    const nested = path.join(repo, 'redirected-project');
    const stateDirectory = path.join(root, 'redirected-adapter-state');
    await mkdir(nested);
    await writeFile(path.join(nested, '.git'), `gitdir: ${path.join(repo, '.git')}\n`);
    const adapter = createGitMissionWorkspaceAdapter({
      repositoryKey: 'example/repository',
      repositoryRoot: nested,
      stateDirectory,
      worktreeDirectory: path.join(root, 'redirected-worktrees'),
      runtimeAuthority,
    });

    await expect(adapter.preflight()).rejects.toThrow(/does not register .* as an exact worktree/);
    expect(existsSync(stateDirectory)).toBe(false);
  });

  it('rejects an overlapping standard worktree root before creating it in the repository', async () => {
    const { repo, stateDirectory } = await fixture();
    const overlapping = path.join(repo, 'managed-worktrees');
    const adapter = createGitMissionWorkspaceAdapter({
      repositoryKey: 'example/repository',
      repositoryRoot: repo,
      stateDirectory,
      worktreeDirectory: overlapping,
      runtimeAuthority,
    });

    await expect(adapter.preflight()).rejects.toThrow(/must not overlap/);
    expect(existsSync(overlapping)).toBe(false);
  });

  it('canonicalizes a standard worktree reached through a symlink alias before persisting it', async () => {
    const { root, repo, stateDirectory, baseRevision } = await fixture();
    const alias = path.join(root, 'root-alias');
    await symlink(root, alias, 'dir');
    const aliasedWorktrees = path.join(alias, 'aliased-worktrees');
    const adapter = createGitMissionWorkspaceAdapter({
      repositoryKey: 'example/repository',
      repositoryRoot: repo,
      stateDirectory,
      worktreeDirectory: aliasedWorktrees,
      runtimeAuthority,
    });
    const running = child('build-aliased', 'write');
    const state = missionState('mission-aliased', baseRevision, running);

    await adapter.preflight();
    const resolution = await adapter.resolve(state, running);
    expect(resolution.cwd).toBe(
      await realpath(path.join(root, 'aliased-worktrees', path.basename(resolution.cwd))),
    );
    expect(resolution.cwd.startsWith(`${path.join(root, 'aliased-worktrees')}${path.sep}`)).toBe(true);
    await expect(resolution.verifyLaunchAuthority()).resolves.toBeUndefined();
  });

  it('validates exact mission base authority without leasing a workspace', async () => {
    const { repo, baseRevision, makeAdapter } = await fixture();
    const adapter = makeAdapter();
    const objective = {
      brief: 'Validate before guide execution.',
      repositoryKey: 'example/repository',
      baseRevision,
    };

    await expect(adapter.validateMissionAuthority('mission-authority', objective)).resolves.toBeUndefined();
    expect((await git(['branch', '--list', 'noriq/run/*'], repo)).stdout).toBe('');
    expect((await git(['worktree', 'list', '--porcelain'], repo)).stdout.match(/^worktree /gm)).toHaveLength(
      1,
    );

    await expect(
      adapter.validateMissionAuthority('mission-authority', {
        ...objective,
        baseRevision: baseRevision.slice(0, 12),
      }),
    ).rejects.toThrow(/full lowercase Git object id/);
    await expect(
      adapter.validateMissionAuthority('mission-authority', {
        ...objective,
        repositoryKey: 'wrong/repository',
      }),
    ).rejects.toThrow(/repositoryKey/);
    await expect(
      adapter.validateMissionAuthority('mission-authority', {
        ...objective,
        baseRevision: 'f'.repeat(baseRevision.length),
      }),
    ).rejects.toThrow(/does not resolve to an exact Git commit/);
  });

  it('refuses VCS work after the commissioned runtime authority rotates in place', async () => {
    const { repo, worktrees, stateDirectory, baseRevision } = await fixture();
    let fingerprint = `sha256:${'1'.repeat(64)}` as `sha256:${string}`;
    const mutableAuthority = {
      get authorityFingerprint() {
        return fingerprint;
      },
      assertAuthority: async () => undefined,
    };
    const adapter = new GitMissionWorkspaceAdapter({
      repositoryKey: 'example/repository',
      repositoryRoot: repo,
      stateDirectory,
      worktreeDirectory: worktrees,
      backend: new GitBackend(new WorktreeManager({ baseDir: worktrees })),
      runtimeAuthority: mutableAuthority,
    });
    await adapter.preflight();
    fingerprint = `sha256:${'2'.repeat(64)}`;

    await expect(
      adapter.validateMissionAuthority('mission-runtime-drift', {
        brief: 'Do not mutate under changed VCS authority.',
        repositoryKey: 'example/repository',
        baseRevision,
      }),
    ).rejects.toThrow(/execution-boundary identity changed/);
  });

  it.skipIf(!bwrapAvailable)(
    'provides a private contained Git status/diff view without exposing repository metadata',
    async () => {
      const { baseRevision, makeAdapter } = await fixture();
      const adapter = makeAdapter();
      const running = child('review-contained-git', 'read');
      const state = missionState('mission-contained-git', baseRevision, running);
      const resolution = await adapter.resolve(state, running);
      const containment = new LinuxBubblewrapContainment();
      const handle = containment.spawn({
        runId: 'contained-git-view',
        command: '/usr/bin/git',
        args: ['status', '--short'],
        cwd: resolution.cwd,
        workspaceRoot: resolution.cwd,
        workspaceWrite: false,
        env: { PATH: '/usr/bin:/bin', ...resolution.trustedEnv },
        additionalReadOnlyRoots: resolution.containmentReadOnlyRoots,
        protectedWorkspaceReadOnlyPaths: resolution.protectedWorkspaceReadOnlyPaths,
        additionalWriteRoots: resolution.containmentWriteRoots,
      });
      let stdout = '';
      let stderr = '';
      handle.child.stdout.setEncoding('utf8');
      handle.child.stderr.setEncoding('utf8');
      handle.child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      handle.child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      await handle.exited;

      expect(handle.child.exitCode, stderr).toBe(0);
      expect(stdout).toBe('');
      expect(
        resolution.containmentReadOnlyRoots?.some((root) =>
          root.includes(`${path.sep}.git${path.sep}objects`),
        ),
      ).toBe(true);
      expect(resolution.containmentReadOnlyRoots?.some((root) => root.endsWith(`${path.sep}.git`))).toBe(
        false,
      );
      expect(resolution.protectedWorkspaceReadOnlyPaths).toEqual(['.git']);
    },
  );

  it('leases once under a durable private record and rechecks exact launch authority', async () => {
    const { repo, stateDirectory, baseRevision, makeAdapter } = await fixture();
    const running = child('build-1', 'write');
    const state = missionState('mission-concurrent', baseRevision, running);
    const first = makeAdapter();
    const second = makeAdapter();

    const [left, right] = await Promise.all([first.resolve(state, running), second.resolve(state, running)]);
    expect(left).toMatchObject({
      cwd: right.cwd,
      revisionId: baseRevision,
      leaseGeneration: right.leaseGeneration,
      protectedWorkspaceReadOnlyPaths: ['.git'],
    });
    await expect(left.verifyLaunchAuthority()).resolves.toBeUndefined();
    expect((await git(['branch', '--list', 'noriq/run/*'], repo)).stdout.trim().split('\n')).toHaveLength(1);

    const records = (await readdir(stateDirectory)).filter((entry) => entry.startsWith('lease-'));
    expect(records).toHaveLength(1);
    const recordPath = path.join(stateDirectory, records[0]!);
    const metadata = await lstat(recordPath);
    if (process.platform !== 'win32') expect(metadata.mode & 0o077).toBe(0);
    expect(JSON.parse(await readFile(recordPath, 'utf8'))).toMatchObject({
      version: 1,
      missionId: state.missionId,
      repositoryKey: 'example/repository',
      baseRevisionId: baseRevision,
      leaseGeneration: left.leaseGeneration,
      status: 'active',
    });

    await writeFile(path.join(left.cwd, 'untrusted-loose.txt'), 'dirty\n');
    await expect(left.verifyLaunchAuthority()).rejects.toThrow(/dirty/);
  });

  it('recovers an allocating intent written before its deterministic branch exists', async () => {
    const { repo, stateDirectory, baseRevision, manager, makeAdapter, injectedAdapter } = await fixture();
    const running = child('build-intent-crash', 'write');
    const state = missionState('mission-intent-crash', baseRevision, running);
    const crashing = injectedAdapter(new FailBeforeBranchBackend(manager()));

    await expect(crashing.resolve(state, running)).rejects.toThrow(/injected crash before branch/);
    expect(await leaseRecord(stateDirectory)).toMatchObject({
      status: 'allocating',
      workspace: null,
      baseRevisionId: baseRevision,
    });
    expect((await git(['branch', '--list', 'noriq/run/*'], repo)).stdout).toBe('');
    await expect(
      makeAdapter().validateMissionAuthority(state.missionId, state.objective ?? undefined),
    ).resolves.toBeUndefined();

    const recovered = await makeAdapter().resolve(state, running);
    expect(recovered.revisionId).toBe(baseRevision);
    await expect(recovered.verifyLaunchAuthority()).resolves.toBeUndefined();
    expect(await leaseRecord(stateDirectory)).toMatchObject({ status: 'active' });
  });

  it('adopts the exact branch after a crash before the active record is durable', async () => {
    const { repo, stateDirectory, baseRevision, manager, makeAdapter, injectedAdapter } = await fixture();
    const running = child('build-branch-crash', 'write');
    const state = missionState('mission-branch-crash', baseRevision, running);
    const crashing = injectedAdapter(new FailBeforeActiveRecordBackend(manager()));

    await expect(crashing.resolve(state, running)).rejects.toThrow(/injected crash after branch/);
    expect(await leaseRecord(stateDirectory)).toMatchObject({
      status: 'allocating',
      workspace: null,
    });
    const branch = (
      await git(['branch', '--list', 'noriq/run/*', '--format=%(refname:short)'], repo)
    ).stdout.trim();
    expect(branch).not.toBe('');
    expect((await git(['rev-parse', branch], repo)).stdout.trim()).toBe(baseRevision);

    const recovered = await makeAdapter().resolve(state, running);
    await expect(recovered.verifyLaunchAuthority()).resolves.toBeUndefined();
    expect(await leaseRecord(stateDirectory)).toMatchObject({
      status: 'active',
      workspace: { localPath: recovered.cwd, workRef: branch },
    });
  });

  it('cleans an allocating intent without creating a branch or worktree just to remove it', async () => {
    const { repo, worktrees, stateDirectory, baseRevision, manager, makeAdapter, injectedAdapter } =
      await fixture();
    const running = child('build-clean-intent', 'write');
    const active = missionState('mission-clean-intent', baseRevision, running);
    await expect(
      injectedAdapter(new FailBeforeBranchBackend(manager())).resolve(active, running),
    ).rejects.toThrow(/injected crash before branch/);
    const terminal = {
      ...active,
      status: 'cancelled' as const,
      terminal: { outcome: 'cancelled' as const, reason: 'Cancelled during allocation.', checkpointId: null },
    };

    await makeAdapter().execute(terminal, GIT_MISSION_WORKSPACE_CLEANUP_ID);
    expect(await leaseRecord(stateDirectory)).toMatchObject({
      status: 'released',
      workspace: null,
      preservedRevisionId: baseRevision,
    });
    expect((await git(['branch', '--list', 'noriq/run/*'], repo)).stdout).toBe('');
    expect(
      existsSync(worktrees) ? (await readdir(worktrees)).filter((entry) => !entry.startsWith('.')) : [],
    ).toEqual([]);
  });

  it('adopts and releases an allocating branch during terminal cleanup', async () => {
    const { repo, stateDirectory, baseRevision, manager, makeAdapter, injectedAdapter } = await fixture();
    const running = child('build-clean-branch', 'write');
    const active = missionState('mission-clean-branch', baseRevision, running);
    await expect(
      injectedAdapter(new FailBeforeActiveRecordBackend(manager())).resolve(active, running),
    ).rejects.toThrow(/injected crash after branch/);
    const branch = (
      await git(['branch', '--list', 'noriq/run/*', '--format=%(refname:short)'], repo)
    ).stdout.trim();
    const terminal = {
      ...active,
      status: 'cancelled' as const,
      terminal: { outcome: 'cancelled' as const, reason: 'Cancelled during allocation.', checkpointId: null },
    };

    await makeAdapter().execute(terminal, GIT_MISSION_WORKSPACE_CLEANUP_ID);
    const record = await leaseRecord(stateDirectory);
    expect(record).toMatchObject({
      status: 'released',
      preservedRevisionId: baseRevision,
      workspace: { workRef: branch },
    });
    expect(existsSync((record.workspace as { localPath: string }).localPath)).toBe(false);
    expect((await git(['rev-parse', branch], repo)).stdout.trim()).toBe(baseRevision);
    await expect(makeAdapter().execute(terminal, GIT_MISSION_WORKSPACE_CLEANUP_ID)).resolves.toBeUndefined();
  });

  it('adopts a preserved mission branch after physical worktree loss with a new generation', async () => {
    const { repo, baseRevision, makeAdapter } = await fixture();
    const running = child('build-1', 'write');
    const state = missionState('mission-adopt', baseRevision, running);
    const first = await makeAdapter().resolve(state, running);
    await git(['worktree', 'remove', first.cwd], repo);

    const adopted = await makeAdapter().resolve(state, running);
    expect(adopted.cwd).toBe(first.cwd);
    expect(adopted.revisionId).toBe(baseRevision);
    expect(adopted.leaseGeneration).not.toBe(first.leaseGeneration);
    await expect(adopted.verifyLaunchAuthority()).resolves.toBeUndefined();
  });

  it('repairs a prunable registration when the durable worktree path disappeared', async () => {
    const { repo, baseRevision, makeAdapter } = await fixture();
    const running = child('build-prunable', 'write');
    const state = missionState('mission-prunable-adopt', baseRevision, running);
    const first = await makeAdapter().resolve(state, running);

    // Model filesystem loss or owner death during physical removal: the checkout disappears while
    // Git still retains its administrative registration and reports it as prunable.
    await rm(first.cwd, { recursive: true, force: true });
    const staleListing = (await git(['worktree', 'list', '--porcelain'], repo)).stdout;
    expect(staleListing).toContain(`worktree ${first.cwd}`);
    expect(staleListing).toContain('prunable');

    const adopted = await makeAdapter().resolve(state, running);
    expect(adopted.cwd).toBe(first.cwd);
    expect(existsSync(adopted.cwd)).toBe(true);
    expect(adopted.revisionId).toBe(baseRevision);
    expect(adopted.leaseGeneration).not.toBe(first.leaseGeneration);
    await expect(adopted.verifyLaunchAuthority()).resolves.toBeUndefined();
  });

  it('refuses a deterministic branch that has no durable lease record', async () => {
    const { root, repo, baseRevision, makeAdapter } = await fixture();
    const running = child('build-1', 'write');
    const state = missionState('mission-ambiguous-branch', baseRevision, running);
    await makeAdapter().resolve(state, running);

    const unrecordedView = new GitMissionWorkspaceAdapter({
      repositoryKey: 'example/repository',
      repositoryRoot: repo,
      stateDirectory: path.join(root, 'different-adapter-state'),
      backend: new GitBackend(new WorktreeManager({ baseDir: path.join(root, 'worktrees') })),
      runtimeAuthority,
    });
    await expect(
      unrecordedView.validateMissionAuthority(state.missionId, state.objective ?? undefined),
    ).rejects.toThrow(/unrecorded Git mission branch/);
    await expect(unrecordedView.resolve(state, running)).rejects.toThrow(/unrecorded Git mission branch/);
  });

  it('accepts matching active and released durable lease records on idempotent validation', async () => {
    const { baseRevision, makeAdapter } = await fixture();
    const adapter = makeAdapter();
    const running = child('build-1', 'write');
    const active = missionState('mission-retry-authority', baseRevision, running);
    const resolution = await adapter.resolve(active, running);

    await expect(
      makeAdapter().validateMissionAuthority(active.missionId, active.objective ?? undefined),
    ).resolves.toBeUndefined();

    const cancelled = {
      ...active,
      status: 'cancelled' as const,
      children: {
        [running.childId]: child(running.childId, 'write', 'cancelled'),
      },
      terminal: { outcome: 'cancelled' as const, reason: 'Cancelled.', checkpointId: null },
    };
    await makeAdapter().recordAfterChild(cancelled, cancelled.children[running.childId]!);
    await makeAdapter().execute(cancelled, GIT_MISSION_WORKSPACE_CLEANUP_ID);
    expect(existsSync(resolution.cwd)).toBe(false);
    await expect(
      makeAdapter().validateMissionAuthority(cancelled.missionId, cancelled.objective ?? undefined),
    ).resolves.toBeUndefined();
  });

  it('checkpoints successful writers exactly, including a stable no-op checkpoint', async () => {
    const { baseRevision, makeAdapter } = await fixture();
    const adapter = makeAdapter();
    const firstRunning = child('build-1', 'write');
    const firstState = missionState('mission-checkpoint', baseRevision, firstRunning);
    const workspace = await adapter.resolve(firstState, firstRunning);
    await writeFile(path.join(workspace.cwd, 'feature.ts'), 'export const feature = true;\n');
    await mkdir(path.join(workspace.cwd, 'ignored-cache'));
    await writeFile(path.join(workspace.cwd, 'ignored-cache', 'successful-writer.tmp'), 'ephemeral\n');

    const firstDone = child('build-1', 'write', 'succeeded');
    const completedFirst = missionState('mission-checkpoint', baseRevision, firstDone);
    const [firstAction] = await adapter.recordAfterChild(completedFirst, firstDone);
    expect(firstAction).toMatchObject({
      type: 'record-checkpoint',
      authorChildId: firstDone.childId,
      changed: true,
      parentCheckpointId: null,
      clean: true,
    });
    if (!firstAction || firstAction.type !== 'record-checkpoint') throw new Error('expected checkpoint');
    expect(firstAction.revisionId).not.toBe(baseRevision);
    expect(existsSync(path.join(workspace.cwd, 'ignored-cache'))).toBe(false);

    // Retrying before the journal accepts the action addresses the same checkpoint and revision.
    expect(await adapter.recordAfterChild(completedFirst, firstDone)).toEqual([firstAction]);

    const checkpoint = checkpointFromAction(firstAction);
    const secondRunning = child('build-2', 'write', 'running', { attemptId: 'attempt-2' });
    const secondState = missionState('mission-checkpoint', baseRevision, secondRunning, [checkpoint]);
    await adapter.resolve(secondState, secondRunning);
    const secondDone = child('build-2', 'write', 'succeeded', { attemptId: 'attempt-2' });
    const [secondAction] = await adapter.recordAfterChild(
      missionState('mission-checkpoint', baseRevision, secondDone, [checkpoint]),
      secondDone,
    );
    expect(secondAction).toMatchObject({
      type: 'record-checkpoint',
      revisionId: firstAction.revisionId,
      changed: false,
      parentCheckpointId: firstAction.checkpointId,
      clean: true,
    });
  });

  it('reconciles failed writer residue and removes ignored child-controlled files', async () => {
    const { baseRevision, makeAdapter } = await fixture();
    const adapter = makeAdapter();
    const running = child('build-failed', 'write');
    const runningState = missionState('mission-reconcile', baseRevision, running);
    const workspace = await adapter.resolve(runningState, running);
    await mkdir(path.join(workspace.cwd, 'ignored-cache'));
    await writeFile(path.join(workspace.cwd, 'ignored-cache', 'credential.tmp'), 'secret residue\n');

    const failed = child('build-failed', 'write', 'failed');
    // A fresh adapter instance proves the durable record is enough to reconcile after restart.
    const [action] = await makeAdapter().recordAfterChild(
      missionState('mission-reconcile', baseRevision, failed),
      failed,
    );
    expect(action).toEqual({
      type: 'record-workspace-reconciled',
      childId: failed.childId,
      revisionId: baseRevision,
      disposition: 'restored',
      summary: `Git workspace restored cleanly to ${baseRevision}.`,
    });
    expect(existsSync(path.join(workspace.cwd, 'ignored-cache'))).toBe(false);
  });

  it('records a review only when the read-only child left its exact subject unchanged', async () => {
    const { baseRevision, makeAdapter } = await fixture();
    const adapter = makeAdapter();
    const builder = child('build-reviewed', 'write');
    const buildState = missionState('mission-review', baseRevision, builder);
    const workspace = await adapter.resolve(buildState, builder);
    await writeFile(path.join(workspace.cwd, 'reviewed.ts'), 'export const reviewed = true;\n');
    const built = child('build-reviewed', 'write', 'succeeded');
    const [checkpointAction] = await adapter.recordAfterChild(
      missionState('mission-review', baseRevision, built),
      built,
    );
    if (!checkpointAction || checkpointAction.type !== 'record-checkpoint') {
      throw new Error('expected checkpoint');
    }
    const checkpoint = checkpointFromAction(checkpointAction);
    const artifact: MissionReviewArtifact = {
      type: 'review',
      checkpointId: checkpoint.checkpointId,
      revisionId: checkpoint.revisionId,
      verdict: 'passed',
      highestSeverity: 'none',
      summary: 'Exact reviewed revision passes.',
    };
    const reviewer = child('review-1', 'read', 'succeeded', {
      attemptId: 'review-attempt-1',
      subjectCheckpointId: checkpoint.checkpointId,
      artifact,
    });
    const reviewState = missionState('mission-review', baseRevision, reviewer, [checkpoint]);

    const [reviewAction] = await adapter.recordAfterChild(reviewState, reviewer);
    expect(reviewAction).toMatchObject({
      type: 'record-review',
      reviewerChildId: reviewer.childId,
      checkpointId: checkpoint.checkpointId,
      revisionId: checkpoint.revisionId,
      verdict: 'passed',
      highestSeverity: 'none',
      summary: artifact.summary,
    });

    await writeFile(path.join(workspace.cwd, 'review-tamper.ts'), 'tampered\n');
    await expect(adapter.recordAfterChild(reviewState, reviewer)).rejects.toThrow(/dirty/);
  });

  it('checks successful planner reads without manufacturing review evidence', async () => {
    const { baseRevision, makeAdapter } = await fixture();
    const adapter = makeAdapter();
    const running = child('planner-1', 'read', 'running', {
      role: 'planner',
      profileId: 'planner',
      driverPosture: {
        kind: 'scope',
        permission: { write: false, allow: ['Read'], deny: ['Edit'], auto: false },
        lineageRole: 'planner',
      },
    });
    const state = missionState('mission-planner', baseRevision, running);
    const workspace = await adapter.resolve(state, running);
    const planned = child('planner-1', 'read', 'succeeded', {
      role: 'planner',
      profileId: 'planner',
      driverPosture: running.driverPosture,
      artifact: {
        type: 'execution-plan',
        summary: 'One bounded step.',
        steps: [
          {
            id: 'step-1',
            title: 'Build it',
            profileId: 'builder',
            instruction: 'Implement the bounded change.',
            acceptance: ['The focused test passes.'],
          },
        ],
      },
    });
    const plannedState = missionState('mission-planner', baseRevision, planned);
    await expect(adapter.recordAfterChild(plannedState, planned)).resolves.toEqual([]);

    await writeFile(path.join(workspace.cwd, 'planner-tamper.txt'), 'unexpected mutation\n');
    await expect(adapter.recordAfterChild(plannedState, planned)).rejects.toThrow(/dirty/);
  });

  it('validates only the exact clean leased revision and re-proves it after command settlement', async () => {
    const { baseRevision, manager, injectedAdapter } = await fixture();
    const calls: Array<{ cmd: string; cwd: string; timeoutMs: number; shell?: string }> = [];
    const adapter = injectedAdapter(new GitBackend(manager()), {
      validationExec: async (cmd, cwd, timeoutMs, shell) => {
        calls.push({ cmd, cwd, timeoutMs, ...(shell ? { shell } : {}) });
        return {
          exitCode: 0,
          output: `discarded-prefix-${'x'.repeat(20_000)}`,
          timedOut: false,
        };
      },
    });
    const running = child('build-validation', 'write');
    const runningState = missionState('mission-validation', baseRevision, running);
    const workspace = await adapter.resolve(runningState, running);
    await writeFile(path.join(workspace.cwd, 'validated.ts'), 'accepted\n');
    const done = child('build-validation', 'write', 'succeeded');
    const [checkpointAction] = await adapter.recordAfterChild(
      missionState('mission-validation', baseRevision, done),
      done,
    );
    if (!checkpointAction || checkpointAction.type !== 'record-checkpoint') {
      throw new Error('expected checkpoint');
    }
    const checkpoint = checkpointFromAction(checkpointAction);
    const commandPolicy = {
      kind: 'command' as const,
      policyId: 'project-validation-v1',
      command: 'npm run check',
      timeoutSeconds: 7,
      shell: '/bin/bash',
    };
    const validationState = {
      ...missionState('mission-validation', baseRevision, done, [checkpoint]),
      validationPolicy: commandPolicy,
      activeValidation: {
        validationId: 'validation-attempt-1',
        checkpointId: checkpoint.checkpointId,
        revisionId: checkpoint.revisionId,
        policyId: commandPolicy.policyId,
      },
    };
    const signal = new AbortController().signal;

    const validation = await adapter.validate(validationState, checkpoint, commandPolicy, signal);
    expect(calls).toEqual([
      {
        cmd: 'npm run check',
        cwd: workspace.cwd,
        timeoutMs: 7_000,
        shell: '/bin/bash',
      },
    ]);
    expect(validation).toMatchObject({
      type: 'record-validation',
      checkpointId: checkpoint.checkpointId,
      revisionId: checkpoint.revisionId,
      policyId: commandPolicy.policyId,
      disposition: 'passed',
      exitCode: 0,
      timedOut: false,
      workspaceChanged: false,
    });
    expect(Buffer.byteLength(validation.outputTail, 'utf8')).toBe(16 * 1024);
    expect(validation.outputTail).toBe('x'.repeat(16 * 1024));

    await writeFile(path.join(workspace.cwd, 'dirty-before-validation.txt'), 'dirty\n');
    const restartedAdapter = injectedAdapter(new GitBackend(manager()), {
      validationExec: async (cmd, cwd, timeoutMs, shell) => {
        calls.push({ cmd, cwd, timeoutMs, ...(shell ? { shell } : {}) });
        return {
          exitCode: 0,
          output: `discarded-prefix-${'x'.repeat(20_000)}`,
          timedOut: false,
        };
      },
    });
    await expect(
      restartedAdapter.validate(validationState, checkpoint, commandPolicy, signal),
    ).resolves.toEqual(validation);
    expect(calls).toHaveLength(2);
    expect(existsSync(path.join(workspace.cwd, 'dirty-before-validation.txt'))).toBe(false);

    const mutatingAdapter = injectedAdapter(new GitBackend(manager()), {
      validationExec: async (_cmd, cwd) => {
        await writeFile(path.join(cwd, 'validation-residue.txt'), 'residue\n');
        return { exitCode: 0, output: 'looked successful', timedOut: false };
      },
    });
    const mutatingValidation = await mutatingAdapter.validate(
      validationState,
      checkpoint,
      commandPolicy,
      signal,
    );
    expect(mutatingValidation).toMatchObject({
      disposition: 'failed',
      exitCode: 0,
      timedOut: false,
      workspaceChanged: true,
    });
    expect(mutatingValidation.outputTail).toMatch(/Validation changed the exact workspace/);
    expect(existsSync(path.join(workspace.cwd, 'validation-residue.txt'))).toBe(false);
    await expect(
      mutatingAdapter.validate(validationState, checkpoint, commandPolicy, signal),
    ).resolves.toEqual(mutatingValidation);

    const nonePolicy = {
      kind: 'none' as const,
      policyId: 'project-validation-none-v1',
      reason: 'This project has no deterministic validation command.',
    };
    const notApplicable = await adapter.validate(
      { ...validationState, validationPolicy: nonePolicy },
      checkpoint,
      nonePolicy,
      signal,
    );
    expect(calls).toHaveLength(2);
    expect(notApplicable).toMatchObject({
      type: 'record-validation',
      checkpointId: checkpoint.checkpointId,
      revisionId: checkpoint.revisionId,
      policyId: nonePolicy.policyId,
      disposition: 'not-applicable',
      exitCode: null,
      timedOut: false,
      workspaceChanged: false,
      outputTail: nonePolicy.reason,
    });
  });

  it.skipIf(!bwrapAvailable)(
    'runs validation in owner-death containment and protects backend metadata',
    async () => {
      const { baseRevision, makeAdapter } = await fixture();
      const adapter = makeAdapter();
      const bubblewrap = new LinuxBubblewrapContainment();
      adapter.bindContainment({
        capabilities: {
          ...bubblewrap.capabilities,
          providerCredentialIsolation: true,
          hostResourceIsolation: true,
          networkEgressIsolation: true,
          immutableRuntimeAuthority: true,
        },
        authorityFingerprint: runtimeAuthority.authorityFingerprint,
        assertAuthority: runtimeAuthority.assertAuthority,
        probe: bubblewrap.probe.bind(bubblewrap),
        spawn: bubblewrap.spawn.bind(bubblewrap),
      });
      const running = child('build-contained-validation', 'write');
      const workspace = await adapter.resolve(
        missionState('mission-contained-validation', baseRevision, running),
        running,
      );
      const done = child('build-contained-validation', 'write', 'succeeded');
      const [checkpointAction] = await adapter.recordAfterChild(
        missionState('mission-contained-validation', baseRevision, done),
        done,
      );
      if (!checkpointAction || checkpointAction.type !== 'record-checkpoint') {
        throw new Error('expected contained validation checkpoint');
      }
      const checkpoint = checkpointFromAction(checkpointAction);
      const policy = {
        kind: 'command' as const,
        policyId: 'contained-validation-v1',
        command: "printf 'retargeted' > .git",
        timeoutSeconds: 5,
        shell: '/bin/sh',
      };
      const state = {
        ...missionState('mission-contained-validation', baseRevision, done, [checkpoint]),
        validationPolicy: policy,
        activeValidation: {
          validationId: 'contained-validation-attempt',
          checkpointId: checkpoint.checkpointId,
          revisionId: checkpoint.revisionId,
          policyId: policy.policyId,
        },
      };
      const metadataBefore = await readFile(path.join(workspace.cwd, '.git'), 'utf8');
      const protectedResult = await adapter.validate(state, checkpoint, policy, new AbortController().signal);
      expect(protectedResult).toMatchObject({
        disposition: 'failed',
        timedOut: false,
        workspaceChanged: false,
      });
      expect(protectedResult.exitCode).not.toBe(0);
      expect(await readFile(path.join(workspace.cwd, '.git'), 'utf8')).toBe(metadataBefore);

      const cancellation = new AbortController();
      const longPolicy = {
        ...policy,
        command: "printf 'started' > validation-started.tmp; sleep 30",
        policyId: 'contained-cancel-v1',
      };
      const cancelState = {
        ...state,
        validationPolicy: longPolicy,
        activeValidation: { ...state.activeValidation, policyId: longPolicy.policyId },
      };
      const operation = adapter.validate(cancelState, checkpoint, longPolicy, cancellation.signal);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (existsSync(path.join(workspace.cwd, 'validation-started.tmp'))) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(path.join(workspace.cwd, 'validation-started.tmp'))).toBe(true);
      cancellation.abort();
      await expect(operation).resolves.toMatchObject({
        disposition: 'failed',
        timedOut: false,
        workspaceChanged: true,
      });
      expect(existsSync(path.join(workspace.cwd, 'validation-started.tmp'))).toBe(false);
    },
  );

  it('releases without deleting the accepted branch and never creates a workspace for cleanup', async () => {
    const { repo, stateDirectory, baseRevision, makeAdapter } = await fixture();
    const adapter = makeAdapter();
    expect(adapter.capabilities).toBe(GIT_MISSION_WORKSPACE_CAPABILITIES);
    expect(adapter.cleanupPlan).toEqual([GIT_MISSION_WORKSPACE_CLEANUP_ID]);
    const running = child('build-cleanup', 'write');
    const runningState = missionState('mission-cleanup', baseRevision, running);
    const workspace = await adapter.resolve(runningState, running);
    await writeFile(path.join(workspace.cwd, 'accepted.ts'), 'accepted\n');
    const done = child('build-cleanup', 'write', 'succeeded');
    const [action] = await adapter.recordAfterChild(
      missionState('mission-cleanup', baseRevision, done),
      done,
    );
    if (!action || action.type !== 'record-checkpoint') throw new Error('expected checkpoint');
    const checkpoint = checkpointFromAction(action);
    const active = missionState('mission-cleanup', baseRevision, done, [checkpoint]);
    const terminal = {
      ...active,
      status: 'succeeded' as const,
      terminal: {
        outcome: 'succeeded' as const,
        reason: 'Exact checkpoint passed review.',
        checkpointId: checkpoint.checkpointId,
      },
    };

    await expect(adapter.record(terminal)).rejects.toThrow(/released durable Git workspace lease/);
    await adapter.execute(terminal, GIT_MISSION_WORKSPACE_CLEANUP_ID);
    expect(existsSync(workspace.cwd)).toBe(false);
    const branch = (
      await git(['branch', '--list', 'noriq/run/*', '--format=%(refname:short)'], repo)
    ).stdout.trim();
    const preserved = await git(['show-ref', '--verify', '--hash', `refs/heads/${branch}`], repo);
    expect(preserved.stdout.trim()).toBe(checkpoint.revisionId);
    await expect(adapter.record(terminal)).resolves.toEqual({
      type: 'record-accepted-revision-handoff',
      backend: 'git',
      repositoryKey: 'example/repository',
      checkpointId: checkpoint.checkpointId,
      revisionId: checkpoint.revisionId,
      reference: branch,
      status: 'preserved',
    });
    await expect(adapter.execute(terminal, GIT_MISSION_WORKSPACE_CLEANUP_ID)).resolves.toBeUndefined();
    await expect(
      adapter.validateMissionAuthority(terminal.missionId, terminal.objective ?? undefined),
    ).resolves.toBeUndefined();

    await git(['branch', '-f', branch, baseRevision], repo);
    await expect(adapter.record(terminal)).rejects.toThrow(/preserved Git mission branch.*expected/);
    await expect(
      adapter.validateMissionAuthority(terminal.missionId, terminal.objective ?? undefined),
    ).rejects.toThrow(/released Git mission branch.*expected/);

    const recordCount = (await readdir(stateDirectory)).filter((entry) => entry.startsWith('lease-')).length;
    const neverLeased = missionState('mission-never-leased', baseRevision);
    await adapter.execute(
      {
        ...neverLeased,
        status: 'cancelled',
        terminal: { outcome: 'cancelled', reason: 'Cancelled before work.', checkpointId: null },
      },
      GIT_MISSION_WORKSPACE_CLEANUP_ID,
    );
    expect((await readdir(stateDirectory)).filter((entry) => entry.startsWith('lease-'))).toHaveLength(
      recordCount,
    );
    expect((await git(['branch', '--list', 'noriq/run/*'], repo)).stdout.trim().split('\n')).toHaveLength(1);
  });
});
