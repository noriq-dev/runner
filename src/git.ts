import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ProjectConfig } from "./config.js";
import type { CheckResult } from "./contracts.js";
import { runProcess } from "./process.js";

const gitExecutable = new AsyncLocalStorage<string>();

export function withGitExecutable<T>(
  command: string,
  operation: () => Promise<T>,
): Promise<T> {
  return gitExecutable.run(command, operation);
}

export async function git(
  cwd: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<string> {
  const result = await runProcess({
    command: gitExecutable.getStore() ?? "git",
    args,
    cwd,
    timeoutMs,
  });
  if (result.exitCode !== 0)
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  return result.stdout.trim();
}

export function safeRefPart(input: string): string {
  const value = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!value || value === "." || value === "..")
    throw new Error("value cannot form a safe Git reference");
  return value;
}

export interface JobWorkspace {
  mode: "isolated" | "direct";
  sourceRepository: string;
  path: string;
  branch: string;
  baseRevision: string;
  expectedHead: string;
  worktreeRoot?: string;
  directLockPath?: string;
}

export async function discoverRepository(path: string): Promise<string> {
  const root = await git(path, ["rev-parse", "--show-toplevel"]);
  return realpath(root);
}

async function requireClean(path: string): Promise<void> {
  const status = await git(path, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status) throw new Error(`repository is not clean:\n${status}`);
}

async function acquireDirectLock(
  repository: string,
  stateDirectory: string,
  jobId: string,
  backendId = "git",
): Promise<string> {
  const key = createHash("sha256").update(repository).digest("hex");
  const lockDirectory = resolve(stateDirectory, "locks");
  const lockPath = join(lockDirectory, `${backendId}-${key}.json`);
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  try {
    const handle = await open(lockPath, "wx", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({
          backend: backendId,
          jobId,
          repository,
          pid: process.pid,
        }),
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = JSON.parse(await readFile(lockPath, "utf8")) as {
      jobId?: string;
    };
    if (owner.jobId !== jobId)
      throw new Error(
        `direct repository is locked by RunnerJob ${owner.jobId ?? "unknown"}`,
      );
  }
  return lockPath;
}

export async function prepareJobWorkspace(options: {
  repository: string;
  stateDirectory: string;
  jobId: string;
  key: string;
  kind: "task" | "plan";
  expectedBaseRevision: string;
  config: ProjectConfig;
  backendId?: string;
}): Promise<JobWorkspace> {
  const repository = await discoverRepository(options.repository);
  const actualBase = await git(repository, [
    "rev-parse",
    `${options.config.sourceControl.base}^{commit}`,
  ]);
  if (actualBase !== options.expectedBaseRevision) {
    throw new Error(
      `base revision changed: expected ${options.expectedBaseRevision}, found ${actualBase}`,
    );
  }
  if (options.config.sourceControl.mode === "direct") {
    const directLockPath = await acquireDirectLock(
      repository,
      options.stateDirectory,
      options.jobId,
      options.backendId,
    );
    try {
      await requireClean(repository);
      const branch = await git(repository, ["branch", "--show-current"]);
      if (branch !== options.config.sourceControl.target)
        throw new Error(
          `direct mode requires target ${options.config.sourceControl.target}, found ${branch}`,
        );
      const expectedHead = await git(repository, ["rev-parse", "HEAD"]);
      if (expectedHead !== options.expectedBaseRevision)
        throw new Error(
          `direct branch HEAD ${expectedHead} differs from dispatched base ${options.expectedBaseRevision}`,
        );
      await writeFile(
        directLockPath,
        JSON.stringify({
          backend: options.backendId ?? "git",
          jobId: options.jobId,
          repository,
          pid: process.pid,
          expectedHead,
          branch,
        }),
        { mode: 0o600 },
      );
      return {
        mode: "direct",
        sourceRepository: repository,
        path: repository,
        branch,
        baseRevision: actualBase,
        expectedHead,
        directLockPath,
      };
    } catch (error) {
      await unlink(directLockPath).catch(() => {});
      throw error;
    }
  }
  const branch = `noriq/${options.kind}/${safeRefPart(options.key)}-${safeRefPart(options.jobId).slice(-10)}`;
  const worktreeRoot = resolve(
    options.stateDirectory,
    "worktrees",
    safeRefPart(options.jobId),
  );
  const path = join(worktreeRoot, "job");
  await mkdir(worktreeRoot, { recursive: true });
  await git(repository, ["worktree", "add", "-b", branch, path, actualBase]);
  return {
    mode: "isolated",
    sourceRepository: repository,
    path,
    branch,
    baseRevision: actualBase,
    expectedHead: actualBase,
    worktreeRoot,
  };
}

export async function restoreJobWorkspace(options: {
  repository: string;
  stateDirectory: string;
  jobId: string;
  branch: string;
  baseRevision: string;
  expectedHead: string;
  mode: "isolated" | "direct";
  backendId?: string;
}): Promise<JobWorkspace> {
  const sourceRepository = await discoverRepository(options.repository);
  if (options.mode === "direct") {
    const directLockPath = await acquireDirectLock(
      sourceRepository,
      options.stateDirectory,
      options.jobId,
      options.backendId,
    );
    const branch = await git(sourceRepository, ["branch", "--show-current"]);
    if (branch !== options.branch)
      throw new Error(
        `direct branch changed from ${options.branch} to ${branch} while Runner was offline`,
      );
    const head = await currentRevision(sourceRepository);
    if (head !== options.expectedHead)
      throw new Error(
        `direct branch drifted from ${options.expectedHead} to ${head} while Runner was offline`,
      );
    return {
      mode: "direct",
      sourceRepository,
      path: sourceRepository,
      branch,
      baseRevision: options.baseRevision,
      expectedHead: head,
      directLockPath,
    };
  }
  const safeJobId = safeRefPart(options.jobId);
  const worktreeRoot = resolve(options.stateDirectory, "worktrees", safeJobId);
  const path = join(worktreeRoot, "job");
  const branch = await git(path, ["branch", "--show-current"]);
  if (branch !== options.branch)
    throw new Error(
      `retained job worktree branch changed from ${options.branch} to ${branch}`,
    );
  return {
    mode: "isolated",
    sourceRepository,
    path,
    branch,
    baseRevision: options.baseRevision,
    expectedHead: await currentRevision(path),
    worktreeRoot,
  };
}

export async function releaseJobWorkspace(
  workspace: JobWorkspace,
  jobId: string,
): Promise<void> {
  if (!workspace.directLockPath) return;
  try {
    const owner = JSON.parse(
      await readFile(workspace.directLockPath, "utf8"),
    ) as {
      jobId?: string;
    };
    if (owner.jobId === jobId) await unlink(workspace.directLockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function createTaskWorktree(
  workspace: JobWorkspace,
  taskKey: string,
): Promise<{ path: string; branch: string; baseRevision: string }> {
  if (workspace.mode === "direct")
    return {
      path: workspace.path,
      branch: workspace.branch,
      baseRevision: workspace.expectedHead,
    };
  const branch = `refs/noriq/tmp/${safeRefPart(workspace.branch)}-${safeRefPart(taskKey)}`;
  const path = join(workspace.worktreeRoot!, `task-${safeRefPart(taskKey)}`);
  const head = await git(workspace.path, ["rev-parse", "HEAD"]);
  await git(workspace.sourceRepository, [
    "worktree",
    "add",
    "-b",
    branch,
    path,
    head,
  ]);
  return { path, branch, baseRevision: head };
}

export async function rebaseTask(
  workspace: JobWorkspace,
  taskPath: string,
): Promise<void> {
  if (workspace.mode === "direct") return;
  const currentHead = await git(workspace.path, ["rev-parse", "HEAD"]);
  const result = await runProcess({
    command: "git",
    args: ["rebase", currentHead],
    cwd: taskPath,
    timeoutMs: 120_000,
  });
  if (result.exitCode !== 0)
    throw new GitRebaseConflict(`${result.stdout}\n${result.stderr}`.trim());
}

export class GitRebaseConflict extends Error {
  constructor(readonly output: string) {
    super(`task rebase requires repair: ${output.slice(-4_000)}`);
  }
}

export async function continueRebase(taskPath: string): Promise<void> {
  await git(taskPath, ["add", "-A"]);
  const result = await runProcess({
    command: "git",
    args: ["-c", "core.editor=true", "rebase", "--continue"],
    cwd: taskPath,
    timeoutMs: 120_000,
  });
  if (result.exitCode !== 0)
    throw new GitRebaseConflict(`${result.stdout}\n${result.stderr}`.trim());
}

export async function abortRebase(taskPath: string): Promise<void> {
  await runProcess({
    command: "git",
    args: ["rebase", "--abort"],
    cwd: taskPath,
    timeoutMs: 120_000,
  });
}

export async function checkpoint(
  path: string,
  taskKey: string,
  summary: string,
): Promise<string> {
  await git(path, ["add", "-A"]);
  const staged = await git(path, ["diff", "--cached", "--name-only"]);
  if (!staged) throw new Error(`task ${taskKey} produced no changes`);
  await git(path, ["commit", "-m", `${taskKey}: ${summary.slice(0, 200)}`]);
  return git(path, ["rev-parse", "HEAD"]);
}

export async function amendCheckpoint(
  path: string,
  _taskKey: string,
  _summary: string,
): Promise<string> {
  await git(path, ["add", "-A"]);
  await git(path, ["commit", "--amend", "--no-edit"]);
  return git(path, ["rev-parse", "HEAD"]);
}

export async function assertHead(
  path: string,
  expected: string,
): Promise<void> {
  const head = await git(path, ["rev-parse", "HEAD"]);
  if (head !== expected)
    throw new Error(`repository HEAD drifted from ${expected} to ${head}`);
}

export async function integrateTask(
  workspace: JobWorkspace,
  taskCommit: string,
): Promise<string> {
  if (workspace.mode === "direct")
    return git(workspace.path, ["rev-parse", "HEAD"]);
  await git(workspace.path, ["merge", "--ff-only", taskCommit]);
  workspace.expectedHead = await git(workspace.path, ["rev-parse", "HEAD"]);
  return workspace.expectedHead;
}

export async function integrateWip(
  workspace: JobWorkspace,
  taskCommit: string,
  taskKey: string,
  reason: string,
): Promise<string> {
  if (workspace.mode === "direct")
    return git(workspace.path, ["rev-parse", "HEAD"]);
  const message = `WIP ${taskKey}: ${reason.slice(0, 160)}`;
  const merged = await runProcess({
    command: "git",
    args: ["merge", "--no-ff", "-m", message, taskCommit],
    cwd: workspace.path,
    timeoutMs: 120_000,
  });
  if (merged.exitCode !== 0) {
    await runProcess({
      command: "git",
      args: ["merge", "--abort"],
      cwd: workspace.path,
      timeoutMs: 120_000,
    });
    await git(workspace.path, [
      "merge",
      "--no-ff",
      "-s",
      "ours",
      "-m",
      `${message} (conflicting tree retained in history)`,
      taskCommit,
    ]);
  }
  workspace.expectedHead = await git(workspace.path, ["rev-parse", "HEAD"]);
  return workspace.expectedHead;
}

export async function assertDirectUndrifted(
  workspace: JobWorkspace,
): Promise<void> {
  if (workspace.mode !== "direct") return;
  await requireClean(workspace.path);
  const head = await git(workspace.path, ["rev-parse", "HEAD"]);
  if (head !== workspace.expectedHead)
    throw new Error(
      `direct branch drifted from ${workspace.expectedHead} to ${head}`,
    );
}

export async function diffForReview(
  path: string,
  base: string,
  includeUntracked = false,
): Promise<string> {
  if (includeUntracked) await git(path, ["add", "--intent-to-add", "--", "."]);
  return git(path, ["diff", "--no-ext-diff", "--find-renames", base, "--"]);
}

export async function dirtyPaths(path: string): Promise<string[]> {
  const output = await git(path, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  return output ? output.split("\n").map((line) => line.slice(3)) : [];
}

export async function currentRevision(path: string): Promise<string> {
  return git(path, ["rev-parse", "HEAD"]);
}

export async function revisionOf(
  path: string,
  reference: string,
): Promise<string> {
  return git(path, ["rev-parse", `${reference}^{commit}`]);
}

export async function runCommands(
  path: string,
  commands: string[],
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const command of commands) {
    const result = await runProcess({
      command: "bash",
      args: ["-lc", command],
      cwd: path,
      timeoutMs: timeoutSeconds * 1_000,
      ...(signal ? { signal } : {}),
      maxOutputBytes: 40_000,
    });
    results.push({
      command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      output: `${result.stdout}${result.stderr}`.slice(-40_000),
      timedOut: result.timedOut,
    });
    if (result.exitCode !== 0 || result.timedOut) break;
  }
  return results;
}

export async function preserveWip(
  path: string,
  taskKey: string,
  reason: string,
): Promise<string | null> {
  const paths = await dirtyPaths(path);
  if (paths.length === 0) return null;
  await git(path, ["add", "-A"]);
  await git(path, ["commit", "-m", `WIP ${taskKey}: ${reason.slice(0, 160)}`]);
  return git(path, ["rev-parse", "HEAD"]);
}

export async function normalizeWipCheckpoint(
  path: string,
  taskKey: string,
  reason: string,
): Promise<string> {
  const paths = await dirtyPaths(path);
  if (paths.length > 0) {
    await git(path, ["add", "-A"]);
    await git(path, [
      "commit",
      "-m",
      `WIP ${taskKey}: ${reason.slice(0, 160)}`,
    ]);
  } else {
    await git(path, [
      "commit",
      "--amend",
      "-m",
      `WIP ${taskKey}: ${reason.slice(0, 160)}`,
    ]);
  }
  return git(path, ["rev-parse", "HEAD"]);
}

export async function removeTaskWorktree(
  workspace: JobWorkspace,
  path: string,
  branch: string,
): Promise<void> {
  if (workspace.mode === "direct") return;
  await git(workspace.sourceRepository, [
    "worktree",
    "remove",
    "--force",
    path,
  ]);
  await git(workspace.sourceRepository, ["branch", "-D", branch]);
}

export function workspaceLabel(workspace: JobWorkspace): string {
  return `${basename(workspace.sourceRepository)}:${workspace.branch}`;
}
