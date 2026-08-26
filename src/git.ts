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
import {
  type ProjectConfig,
  type SubmodulesConfig,
  submodulePolicyFor,
  submoduleTargetFor,
} from "./config.js";
import type { CheckResult } from "./contracts.js";
import { runProcess } from "./process.js";

const gitExecutable = new AsyncLocalStorage<string>();

export function withGitExecutable<T>(
  command: string,
  operation: () => Promise<T>,
): Promise<T> {
  return gitExecutable.run(command, operation);
}

/**
 * Raw stdout, untrimmed. Porcelain formats are column-significant — a status
 * line is `XY path`, so trimming eats the leading space of the first record and
 * shifts its path by one character.
 */
export async function gitOutput(
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
  return result.stdout;
}

export async function git(
  cwd: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<string> {
  return (await gitOutput(cwd, args, timeoutMs)).trim();
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
  /**
   * Captured at job open. beginTask has no ProjectConfig in its signature, and
   * a job's submodule policy must not change underneath it mid-run, so the
   * resolved config rides the workspace instead of being re-read per task.
   */
  submodules?: SubmodulesConfig;
}

/**
 * `git worktree add` creates a tree whose submodule directories are EMPTY, so
 * every worktree Runner makes has to populate them explicitly or the agent gets
 * a tree that cannot build and no way to tell why from inside it.
 */
export async function populateSubmodules(
  path: string,
  config: SubmodulesConfig | undefined,
): Promise<void> {
  if (!config?.enabled || config.init === "none") return;
  const args = ["submodule", "update", "--init"];
  if (config.init === "recursive") args.push("--recursive");
  await git(path, args);
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
  const submodules = options.config.sourceControl.submodules;
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
      // requireClean above guarantees the tree is clean, so populating the
      // operator's own checkout here cannot discard local submodule work.
      await populateSubmodules(repository, submodules);
      return {
        mode: "direct",
        sourceRepository: repository,
        path: repository,
        branch,
        baseRevision: actualBase,
        expectedHead,
        directLockPath,
        ...(submodules ? { submodules } : {}),
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
  await populateSubmodules(path, submodules);
  return {
    mode: "isolated",
    sourceRepository: repository,
    path,
    branch,
    baseRevision: actualBase,
    expectedHead: actualBase,
    worktreeRoot,
    ...(submodules ? { submodules } : {}),
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
  submodules?: SubmodulesConfig;
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
      ...(options.submodules ? { submodules: options.submodules } : {}),
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
  // Idempotent, and a crash can leave a worktree whose submodules were never
  // populated; re-running costs nothing when they already match.
  await populateSubmodules(path, options.submodules);
  return {
    mode: "isolated",
    sourceRepository,
    path,
    branch,
    baseRevision: options.baseRevision,
    expectedHead: await currentRevision(path),
    worktreeRoot,
    ...(options.submodules ? { submodules: options.submodules } : {}),
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
  await populateSubmodules(path, workspace.submodules);
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

export interface SubmoduleState {
  path: string;
  /** The submodule's working tree has uncommitted changes. */
  dirty: boolean;
  /** Commit currently checked out inside the submodule. */
  head: string;
  /** Gitlink the parent's HEAD records for this path. */
  recorded: string;
}

/**
 * Reads each managed submodule's real state by asking the submodule itself,
 * rather than inferring it from the parent's porcelain, where a moved gitlink
 * and a dirty working tree are easy to confuse.
 */
export async function inspectSubmodules(
  path: string,
  config: SubmodulesConfig | undefined,
): Promise<SubmoduleState[]> {
  if (!config?.enabled) return [];
  const listing = await git(path, ["submodule", "status", "--recursive"]).catch(
    () => "",
  );
  const states: SubmoduleState[] = [];
  for (const line of listing.split("\n")) {
    if (!line.trim()) continue;
    // "<prefix><sha> <path> (<describe>)" — prefix is one status character.
    const parts = line.slice(1).trim().split(/\s+/);
    const submodulePath = parts[1];
    if (!submodulePath) continue;
    const absolute = join(path, submodulePath);
    const dirty = Boolean(
      await git(absolute, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]).catch(() => ""),
    );
    const head = await git(absolute, ["rev-parse", "HEAD"]).catch(() => "");
    const recorded = await git(path, [
      "rev-parse",
      `HEAD:${submodulePath}`,
    ]).catch(() => "");
    states.push({ path: submodulePath, dirty, head, recorded });
  }
  return states;
}

/**
 * Guards the one path that can publish a pointer to a commit that exists
 * nowhere: `git add -A` will happily stage a gitlink whose submodule commit was
 * never created. That lands cleanly and breaks on the next fetch, so it is
 * refused before anything is staged.
 */
/**
 * Where an authored submodule commit is kept durable. It lives in the PARENT
 * repository, not in `.git/modules/<path>`: a clone whose submodule was never
 * initialised has no such module store, and populating one in a worktree does
 * not create it (verified against git 2.55). The parent repository always
 * exists, and a commit is just an object, so it is a valid home for one.
 */
export function submoduleRetentionRef(
  jobId: string,
  taskKey: string,
  submodulePath: string,
): string {
  return `refs/noriq/submodule/${safeRefPart(jobId)}/${safeRefPart(taskKey)}/${safeRefPart(submodulePath)}`;
}

/**
 * Transfers an authored submodule commit into the parent repository and proves
 * it arrived. Naming it with a ref inside the worktree's own submodule store
 * would NOT retain it: that store is deleted with the worktree, taking the ref
 * and the objects together.
 */
async function retainSubmoduleCommit(
  taskPath: string,
  state: SubmoduleState,
  retention: { sourceRepository: string; jobId: string },
  taskKey: string,
): Promise<void> {
  const ref = submoduleRetentionRef(retention.jobId, taskKey, state.path);
  await git(join(taskPath, state.path), [
    "push",
    "--force",
    retention.sourceRepository,
    `${state.head}:${ref}`,
  ]);
  // Verify rather than assume: a checkpoint whose gitlink names a commit that
  // never reached the durable store is the exact corruption this prevents.
  const stored = await git(retention.sourceRepository, [
    "rev-parse",
    "--verify",
    `${ref}^{commit}`,
  ]).catch(() => "");
  if (stored !== state.head)
    throw new Error(
      `submodule ${state.path} commit ${state.head} was not retained in ${retention.sourceRepository} (found ${stored || "nothing"} at ${ref})`,
    );
}

export interface SubmoduleLanding {
  path: string;
  target: string;
  revision: string;
}

/** A submodule target that cannot fast-forward. Retryable, like its parent. */
export class SubmoduleLandingConflict extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
    this.name = "SubmoduleLandingConflict";
  }
}

/**
 * Lands every develop submodule onto its configured target, and MUST run before
 * the parent fast-forwards: a parent whose gitlink is on no submodule branch is
 * a published pointer to nothing.
 *
 * One push does transfer and landing together, and git enforces the rest — a
 * non-fast-forward is rejected by the receiving end, and re-pushing an already
 * landed revision is "Everything up-to-date", which is the idempotence landing
 * needs across disconnects.
 */
export async function landDevelopSubmodules(options: {
  repository: string;
  config: SubmodulesConfig | undefined;
  sourceRevision: string;
}): Promise<SubmoduleLanding[]> {
  const config = options.config;
  if (!config?.enabled) return [];
  const landed: SubmoduleLanding[] = [];
  for (const path of Object.keys(config.paths)) {
    if (submodulePolicyFor(config, path) !== "develop") continue;
    const target = submoduleTargetFor(config, path);
    if (!target)
      throw new Error(
        `submodule ${path} is develop but has no target configured to land onto`,
      );
    const revision = await git(options.repository, [
      "rev-parse",
      `${options.sourceRevision}:${path}`,
    ]).catch(() => "");
    // Not a gitlink at this revision: nothing of this submodule is being landed.
    if (!revision) continue;
    // A clone whose submodule was never initialised has no module store; this
    // creates it and is a no-op once it exists.
    await git(options.repository, ["submodule", "update", "--init", path]);
    const store = resolve(
      options.repository,
      await git(options.repository, [
        "rev-parse",
        "--git-path",
        `modules/${path}`,
      ]),
    );
    // Transfer the objects to a NON-branch ref first. Pushing straight at
    // refs/heads/<target> is refused whenever the submodule's working tree has
    // that branch checked out, which is the ordinary state after `submodule
    // add`.
    await git(options.repository, [
      "push",
      "--force",
      store,
      `${revision}:refs/noriq/landing/${safeRefPart(target)}/${safeRefPart(path)}`,
    ]);
    const worktree = join(options.repository, path);
    const checkedOut = await git(worktree, ["branch", "--show-current"]).catch(
      () => "",
    );
    if (checkedOut === target) {
      // Mirrors how the parent lands into a checked-out branch: refuse a dirty
      // tree, then fast-forward it so the working copy matches what landed.
      const dirty = await dirtyPaths(worktree);
      if (dirty.length > 0)
        throw new SubmoduleLandingConflict(
          `submodule ${path} landing target ${target} is not clean`,
          dirty.join("\n"),
        );
      try {
        await git(worktree, ["merge", "--ff-only", revision]);
      } catch (error) {
        throw new SubmoduleLandingConflict(
          `submodule ${path} cannot fast-forward ${target} to ${revision}`,
          error instanceof Error ? error.message : String(error),
        );
      }
    } else {
      const current = await git(store, [
        "rev-parse",
        "--verify",
        `refs/heads/${target}`,
      ]).catch(() => "");
      if (
        current &&
        current !== revision &&
        !(await isAncestor(store, current, revision))
      )
        throw new SubmoduleLandingConflict(
          `submodule ${path} cannot fast-forward ${target} to ${revision}`,
          `${target} is at ${current}, which is not an ancestor of ${revision}`,
        );
      await git(store, ["update-ref", `refs/heads/${target}`, revision]);
    }
    landed.push({ path, target, revision });
  }
  return landed;
}

export async function assertSubmodulesCommittable(
  path: string,
  config: SubmodulesConfig | undefined,
  taskKey: string,
  retention?: { sourceRepository: string; jobId: string },
): Promise<void> {
  const states = await inspectSubmodules(path, config);
  const dirty = states.filter((state) => state.dirty);
  if (dirty.length > 0)
    throw new Error(
      `task ${taskKey} left uncommitted changes inside submodule(s) ${dirty
        .map((state) => state.path)
        .join(
          ", ",
        )}; a gitlink must never be staged while its submodule commit does not exist`,
    );
  const moved = states.filter(
    (state) => state.head !== state.recorded && state.recorded !== "",
  );
  for (const state of moved) {
    const policy = submodulePolicyFor(config, state.path);
    if (policy === "follow") {
      await assertFollowedUpstream(path, config, state);
      continue;
    }
    if (policy === "develop") {
      if (!retention)
        throw new Error(
          `submodule ${state.path} is develop and its gitlink moved to ${state.head}, but no durable store was supplied to retain it`,
        );
      await retainSubmoduleCommit(path, state, retention, taskKey);
      continue;
    }
    throw new Error(
      `submodule ${state.path} is pinned, but its gitlink moved from ${state.recorded} to ${state.head}`,
    );
  }
}

async function isAncestor(
  path: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await git(path, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/**
 * A populated submodule is usually on a detached HEAD with only remote-tracking
 * refs, so a configured target of "main" has to be allowed to mean origin/main.
 */
async function resolveSubmoduleTarget(
  path: string,
  target: string,
): Promise<string | null> {
  for (const candidate of [target, `origin/${target}`]) {
    try {
      return await git(path, [
        "rev-parse",
        "--verify",
        `${candidate}^{commit}`,
      ]);
    } catch {}
  }
  return null;
}

/**
 * `follow` lets a gitlink advance, but only onto a commit that ALREADY exists
 * upstream. That is what makes the policy cheap: the target is reachable by
 * construction, so it needs no retained ref and no ordered landing. A move to a
 * locally-authored commit is exactly the unreachable pointer this refuses.
 */
async function assertFollowedUpstream(
  path: string,
  config: SubmodulesConfig | undefined,
  state: SubmoduleState,
): Promise<void> {
  const target = submoduleTargetFor(config, state.path);
  if (!target)
    throw new Error(
      `submodule ${state.path} is follow, but has no target configured, so its move to ${state.head} cannot be validated against upstream`,
    );
  const absolute = join(path, state.path);
  const resolved = await resolveSubmoduleTarget(absolute, target);
  if (!resolved)
    throw new Error(
      `submodule ${state.path} is follow, but its target ${target} does not resolve inside the submodule`,
    );
  if (!(await isAncestor(absolute, state.head, resolved)))
    throw new Error(
      `submodule ${state.path} moved to ${state.head}, which is not present on its follow target ${target}`,
    );
}

export async function checkpoint(
  path: string,
  taskKey: string,
  summary: string,
  submodules?: SubmodulesConfig,
  retention?: { sourceRepository: string; jobId: string },
): Promise<string> {
  await assertSubmodulesCommittable(path, submodules, taskKey, retention);
  await git(path, ["add", "-A"]);
  const staged = await git(path, ["diff", "--cached", "--name-only"]);
  if (!staged) throw new Error(`task ${taskKey} produced no changes`);
  await git(path, ["commit", "-m", `${taskKey}: ${summary.slice(0, 200)}`]);
  return git(path, ["rev-parse", "HEAD"]);
}

export async function amendCheckpoint(
  path: string,
  taskKey: string,
  _summary: string,
  submodules?: SubmodulesConfig,
  retention?: { sourceRepository: string; jobId: string },
): Promise<string> {
  await assertSubmodulesCommittable(path, submodules, taskKey, retention);
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
  submodules?: SubmodulesConfig,
): Promise<string> {
  if (includeUntracked) await git(path, ["add", "--intent-to-add", "--", "."]);
  // Without --submodule=diff a changed submodule renders as a one-line
  // "Subproject commit <sha>" pair, which gives a reviewer no basis to approve
  // or reject and invites approving blind.
  return git(path, [
    "diff",
    "--no-ext-diff",
    "--find-renames",
    ...(submodules?.enabled ? ["--submodule=diff"] : []),
    base,
    "--",
  ]);
}

export async function dirtyPaths(path: string): Promise<string[]> {
  const output = await gitOutput(path, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  return output
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3));
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

/**
 * WARNING for submodule work (verified against git 2.55): a submodule inside a
 * worktree does NOT share the main checkout's `.git/modules/<path>` store. It
 * gets its own at `.git/worktrees/<wt>/modules/<path>`, so removing the
 * worktree DESTROYS every object authored in that submodule — a ref created
 * inside it does not survive, because the store holding both is deleted.
 *
 * Phase 1 is safe because checkpoint refuses a moved gitlink, so nothing is
 * ever authored there. Any future policy that lets agents commit inside a
 * submodule must TRANSFER the objects into a durable store (push/fetch into
 * the main module store) BEFORE this runs. Pinning a ref alone is not enough.
 */
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
