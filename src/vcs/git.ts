import { createHash } from "node:crypto";
import { access, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  abortRebase,
  amendCheckpoint,
  checkpoint,
  continueRebase,
  createTaskWorktree,
  currentRevision,
  diffForReview,
  dirtyPaths,
  discoverRepository,
  git as executeGit,
  type JobWorkspace as GitJobWorkspace,
  GitRebaseConflict,
  integrateTask,
  normalizeWipCheckpoint,
  prepareJobWorkspace,
  rebaseTask,
  releaseJobWorkspace,
  removeTaskWorktree,
  restoreJobWorkspace,
  revisionOf,
  runCommands,
  safeRefPart,
} from "../git.js";
import {
  assertBackendHandle,
  type BackendHandle,
  type JobWorkspace,
  type SourceControlBackend,
  type SourceControlCheckpoint,
  type TaskWorkspace,
} from "./types.js";

function stringState(handle: BackendHandle, name: string): string {
  const value = handle.state[name];
  if (typeof value !== "string")
    throw new Error(`git handle is missing ${name}`);
  return value;
}

function optionalState(
  handle: BackendHandle,
  name: string,
): string | undefined {
  const value = handle.state[name];
  return typeof value === "string" ? value : undefined;
}

function checkpointRecord(ref: string, label = ref): SourceControlCheckpoint {
  return { ref, label, url: null };
}

function jobHandle(workspace: GitJobWorkspace, backend: string): BackendHandle {
  return {
    backend,
    version: 1,
    state: {
      sourceRepository: workspace.sourceRepository,
      workRef: workspace.branch,
      ...(workspace.worktreeRoot
        ? { worktreeRoot: workspace.worktreeRoot }
        : {}),
      ...(workspace.directLockPath
        ? { directLockPath: workspace.directLockPath }
        : {}),
    },
  };
}

function fromGit(workspace: GitJobWorkspace, backend: string): JobWorkspace {
  return {
    handle: jobHandle(workspace, backend),
    vcs: "git",
    mode: workspace.mode,
    repositoryIdentity: workspace.sourceRepository,
    path: workspace.path,
    baseRevision: workspace.baseRevision,
    currentRevision: workspace.expectedHead,
    retainedLocation: { vcs: "git", label: workspace.branch, url: null },
  };
}

function toGit(workspace: JobWorkspace, backend: string): GitJobWorkspace {
  assertBackendHandle(workspace.handle, backend, "job workspace");
  const worktreeRoot = optionalState(workspace.handle, "worktreeRoot");
  const directLockPath = optionalState(workspace.handle, "directLockPath");
  return {
    mode: workspace.mode,
    sourceRepository: stringState(workspace.handle, "sourceRepository"),
    path: workspace.path,
    branch: stringState(workspace.handle, "workRef"),
    baseRevision: workspace.baseRevision,
    expectedHead: workspace.currentRevision,
    ...(worktreeRoot ? { worktreeRoot } : {}),
    ...(directLockPath ? { directLockPath } : {}),
  };
}

function taskState(task: TaskWorkspace, backend: string): { workRef: string } {
  assertBackendHandle(task.handle, backend, "task workspace");
  return { workRef: stringState(task.handle, "workRef") };
}

export class GitSourceControlBackend implements SourceControlBackend {
  readonly id: string;
  readonly kind = "git";
  readonly capabilities = {
    isolatedMode: true,
    directMode: true,
    parallelTaskWorkspaces: true,
    durableRecovery: true,
    automatedConflictRepair: true,
  };

  constructor(id = "git") {
    this.id = id;
  }

  discoverRepository = discoverRepository;
  async repositoryIdentity(path: string): Promise<string> {
    return discoverRepository(path);
  }
  revisionOf = revisionOf;

  async openJob(
    options: Parameters<SourceControlBackend["openJob"]>[0],
  ): Promise<JobWorkspace> {
    try {
      const workspace = fromGit(
        await prepareJobWorkspace({ ...options, backendId: this.id }),
        this.id,
      );
      workspace.handle.state.jobId = options.jobId;
      return workspace;
    } catch (error) {
      if (options.config.sourceControl.mode !== "isolated") throw error;
      const workRef = `noriq/${options.kind}/${safeRefPart(options.key)}-${safeRefPart(options.jobId).slice(-10)}`;
      const worktreeRoot = resolve(
        options.stateDirectory,
        "worktrees",
        safeRefPart(options.jobId),
      );
      const path = join(worktreeRoot, "job");
      try {
        await access(path);
        const revision = await currentRevision(path);
        if (revision !== options.expectedBaseRevision) throw error;
        const workspace = fromGit(
          {
            mode: "isolated",
            sourceRepository: await discoverRepository(options.repository),
            path,
            branch: workRef,
            baseRevision: options.expectedBaseRevision,
            expectedHead: revision,
            worktreeRoot,
          },
          this.id,
        );
        workspace.handle.state.jobId = options.jobId;
        return workspace;
      } catch {
        throw error;
      }
    }
  }

  async restoreJob(
    options: Parameters<SourceControlBackend["restoreJob"]>[0],
  ): Promise<JobWorkspace> {
    assertBackendHandle(options.handle, this.id, "restored job");
    let expectedHead = options.currentRevision;
    if (
      options.mode === "direct" &&
      typeof options.handle.state.acceptingTask === "string"
    ) {
      const root = await discoverRepository(options.repository);
      const head = await currentRevision(root);
      if (head !== expectedHead) {
        const parent = await executeGit(root, ["rev-parse", `${head}^`]);
        const message = await executeGit(root, [
          "log",
          "-1",
          "--format=%B",
          head,
        ]);
        if (
          parent !== expectedHead ||
          !message.includes(`Noriq-Job: ${options.jobId}`)
        )
          throw new Error(
            `direct target drifted from ${expectedHead} to ${head} while Runner was offline`,
          );
        expectedHead = head;
      }
    }
    const workspace = fromGit(
      await restoreJobWorkspace({
        repository: options.repository,
        stateDirectory: options.stateDirectory,
        jobId: options.jobId,
        branch: stringState(options.handle, "workRef"),
        baseRevision: options.baseRevision,
        expectedHead,
        mode: options.mode,
        backendId: this.id,
      }),
      this.id,
    );
    workspace.handle.state.jobId = options.jobId;
    return workspace;
  }

  async beginTask(
    workspace: JobWorkspace,
    taskKey: string,
  ): Promise<TaskWorkspace> {
    let task: { path: string; branch: string; baseRevision: string };
    try {
      task = await createTaskWorktree(toGit(workspace, this.id), taskKey);
    } catch (error) {
      if (workspace.mode === "direct") throw error;
      const worktreeRoot = optionalState(workspace.handle, "worktreeRoot");
      if (!worktreeRoot) throw error;
      const branch = `refs/noriq/tmp/${safeRefPart(stringState(workspace.handle, "workRef"))}-${safeRefPart(taskKey)}`;
      const path = join(worktreeRoot, `task-${safeRefPart(taskKey)}`);
      try {
        await access(path);
        const revision = await currentRevision(path);
        if (revision !== workspace.currentRevision) throw error;
        task = { path, branch, baseRevision: revision };
      } catch {
        throw error;
      }
    }
    return {
      handle: {
        backend: this.id,
        version: 1,
        state: { workRef: task.branch },
      },
      path: task.path,
      baseRevision: task.baseRevision,
    };
  }

  async stageCandidate(
    options: Parameters<SourceControlBackend["stageCandidate"]>[0],
  ) {
    taskState(options.task, this.id);
    const changedPaths = await dirtyPaths(options.task.path);
    if (options.workspace.mode === "direct")
      return {
        status: "ready" as const,
        checkpoint: checkpointRecord(
          options.workspace.currentRevision,
          changedPaths.length > 0 ? "uncommitted candidate" : "no-op",
        ),
        changedPaths,
        backendState: options.task.handle,
      };
    const ref =
      changedPaths.length === 0
        ? await currentRevision(options.task.path)
        : options.refresh
          ? await amendCheckpoint(
              options.task.path,
              options.taskKey,
              options.summary,
            )
          : await checkpoint(
              options.task.path,
              options.taskKey,
              options.summary,
            );
    return {
      status: "ready" as const,
      checkpoint: checkpointRecord(ref),
      changedPaths,
      backendState: options.task.handle,
    };
  }

  async integrateLatest(workspace: JobWorkspace, task: TaskWorkspace) {
    if (workspace.mode === "direct") return null;
    try {
      await rebaseTask(toGit(workspace, this.id), task.path);
      return {
        status: "ready" as const,
        checkpoint: checkpointRecord(await currentRevision(task.path)),
        changedPaths: await dirtyPaths(task.path),
        backendState: task.handle,
      };
    } catch (error) {
      if (!(error instanceof GitRebaseConflict)) throw error;
      return {
        status: "conflict" as const,
        paths: await executeGit(task.path, [
          "diff",
          "--name-only",
          "--diff-filter=U",
        ]).then((v) => (v ? v.split("\n") : [])),
        detail: error.output,
        backendState: task.handle,
      };
    }
  }

  async continueConflict(task: TaskWorkspace): Promise<void> {
    taskState(task, this.id);
    await continueRebase(task.path);
  }
  async abortConflict(task: TaskWorkspace): Promise<void> {
    taskState(task, this.id);
    await abortRebase(task.path);
  }

  async reviewDiff(
    workspace: JobWorkspace,
    task: TaskWorkspace,
    candidate: SourceControlCheckpoint,
  ): Promise<string> {
    taskState(task, this.id);
    return diffForReview(
      task.path,
      workspace.mode === "direct"
        ? workspace.currentRevision
        : `${candidate.ref}^`,
      workspace.mode === "direct",
    );
  }

  async acceptCandidate(
    options: Parameters<SourceControlBackend["acceptCandidate"]>[0],
  ): Promise<SourceControlCheckpoint> {
    if (options.workspace.mode === "direct") {
      const actual = await currentRevision(options.task.path);
      if (actual !== options.workspace.currentRevision)
        throw new Error(
          `direct target drifted from ${options.workspace.currentRevision} to ${actual}`,
        );
      const paths = await dirtyPaths(options.task.path);
      const ref =
        paths.length > 0
          ? await checkpoint(
              options.task.path,
              options.taskKey,
              `accepted\n\nNoriq-Job: ${String(options.workspace.handle.state.jobId ?? "unknown")}`,
            )
          : await currentRevision(options.task.path);
      options.workspace.currentRevision = ref;
      return checkpointRecord(ref);
    }
    const gitWorkspace = toGit(options.workspace, this.id);
    const ref = await integrateTask(gitWorkspace, options.candidate.ref);
    options.workspace.currentRevision = ref;
    return checkpointRecord(ref);
  }

  async preserveFailedWork(
    options: Parameters<SourceControlBackend["preserveFailedWork"]>[0],
  ) {
    taskState(options.task, this.id);
    const changed = await dirtyPaths(options.task.path);
    const head = await currentRevision(options.task.path);
    if (changed.length === 0 && head === options.task.baseRevision) return null;
    const recoveryCommit =
      changed.length > 0
        ? await normalizeWipCheckpoint(
            options.task.path,
            options.taskKey,
            options.reason,
          )
        : head;
    const suffix = createHash("sha256")
      .update(`${options.taskKey}:${recoveryCommit}`)
      .digest("hex")
      .slice(0, 10);
    const recoveryRef = `noriq/recovery/${options.taskKey.replace(/[^A-Za-z0-9_.-]+/g, "-")}-${suffix}`;
    await executeGit(options.workspace.repositoryIdentity, [
      "branch",
      "-f",
      recoveryRef,
      recoveryCommit,
    ]);
    if (options.workspace.mode === "direct") {
      await executeGit(options.task.path, [
        "reset",
        "--hard",
        options.workspace.currentRevision,
      ]);
    }
    return { vcs: "git", label: recoveryRef, url: null };
  }

  async inspect(workspace: JobWorkspace) {
    assertBackendHandle(workspace.handle, this.id, "job workspace");
    return {
      revision: await currentRevision(workspace.path),
      dirtyPaths: await dirtyPaths(workspace.path),
      retainedLocation: workspace.retainedLocation,
    };
  }
  async inspectTask(task: TaskWorkspace) {
    taskState(task, this.id);
    return {
      revision: await currentRevision(task.path),
      dirtyPaths: await dirtyPaths(task.path),
      retainedLocation: {
        vcs: "git",
        label: stringState(task.handle, "workRef"),
        url: null,
      },
    };
  }
  async releaseTask(
    workspace: JobWorkspace,
    task: TaskWorkspace,
  ): Promise<void> {
    await removeTaskWorktree(
      toGit(workspace, this.id),
      task.path,
      taskState(task, this.id).workRef,
    );
  }
  async release(workspace: JobWorkspace, jobId: string): Promise<void> {
    await releaseJobWorkspace(toGit(workspace, this.id), jobId);
  }
  async recoverOrphans(
    repository: string,
    stateDirectory: string,
  ): Promise<string[]> {
    const root = await discoverRepository(repository);
    await executeGit(root, ["worktree", "prune"]);
    const key = createHash("sha256").update(root).digest("hex");
    const lockPath = join(
      resolve(stateDirectory, "locks"),
      `${this.id}-${key}.json`,
    );
    try {
      await access(lockPath);
    } catch {
      return [];
    }
    const owner = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid?: number;
      jobId?: string;
      expectedHead?: string;
    };
    if (typeof owner.pid === "number") {
      try {
        process.kill(owner.pid, 0);
        return [];
      } catch {}
    }
    if (!owner.expectedHead)
      throw new Error(
        `cannot safely recover stale Git lock for ${owner.jobId ?? "unknown job"}: pinned revision is missing`,
      );
    const paths = await dirtyPaths(root);
    const head = await currentRevision(root);
    const warnings: string[] = [];
    if (paths.length > 0 || head !== owner.expectedHead) {
      const recoveryCommit =
        paths.length > 0
          ? await normalizeWipCheckpoint(
              root,
              owner.jobId ?? "orphan",
              "Runner process exited before journal acknowledgement",
            )
          : head;
      const recoveryRef = `noriq/recovery/orphan-${createHash("sha256")
        .update(recoveryCommit)
        .digest("hex")
        .slice(0, 10)}`;
      await executeGit(root, ["branch", "-f", recoveryRef, recoveryCommit]);
      await executeGit(root, ["reset", "--hard", owner.expectedHead]);
      warnings.push(`preserved orphaned Git work at ${recoveryRef}`);
    }
    await unlink(lockPath);
    return warnings;
  }
  runCommands = runCommands;
}

/** @deprecated use GitSourceControlBackend */
export { GitSourceControlBackend as GitWorkspaceBackend };
