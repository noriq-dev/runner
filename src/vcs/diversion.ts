import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runCommands } from "../git.js";
import { runProcess } from "../process.js";
import {
  assertBackendHandle,
  type BackendHandle,
  type JobWorkspace,
  type LandingResult,
  type SourceControlBackend,
  type SourceControlCapabilities,
  type SourceControlCheckpoint,
  type TaskWorkspace,
  type WorkspaceMode,
} from "./types.js";

function safeName(input: string): string {
  const value = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!value || value === "." || value === "..")
    throw new Error("value cannot form a safe Diversion name");
  return value;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function repositoryRoot(path: string): Promise<string> {
  let candidate = await realpath(path);
  for (;;) {
    if (await exists(join(candidate, ".diversion"))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error(`no Diversion workspace contains ${path}`);
}

function stringState(handle: BackendHandle, name: string): string {
  const value = handle.state[name];
  if (typeof value !== "string")
    throw new Error(`Diversion handle is missing ${name}`);
  return value;
}

function checkpoint(ref: string, label = ref): SourceControlCheckpoint {
  return { ref, label, url: null };
}

export type DiversionWorkspaceStrategy = "shared" | "per-task";

const COMMAND_TIMEOUT_MS = 120_000;

/**
 * A clone waits for the whole initial file sync, and these repositories are
 * large on purpose — the reason per-workspace isolation is opt-in at all. The
 * ceiling only exists so a wedged sync cannot hang a job forever.
 */
const CLONE_TIMEOUT_MS = 3_600_000;

/**
 * A Diversion checkout records its workspace id in a `.diversion/dv.ws.<uuid>`
 * marker file. That is the id `dv workspace delete` wants, and reading it
 * beats parsing the global `dv workspace` listing, which cannot tell two
 * workspaces of the same repository apart by directory.
 */
function workspaceRoot(stateDirectory: string, jobId: string): string {
  return resolve(stateDirectory, "diversion-workspaces", safeName(jobId));
}

async function workspaceIdentifier(path: string): Promise<string> {
  const entries = await readdir(join(path, ".diversion"));
  const marker = entries.find((entry) => entry.startsWith("dv.ws."));
  if (!marker)
    throw new Error(`no Diversion workspace marker found under ${path}`);
  return marker;
}

export class DiversionSourceControlBackend implements SourceControlBackend {
  readonly kind = "diversion";
  readonly capabilities: SourceControlCapabilities;

  constructor(
    readonly id = "diversion",
    private readonly command = "dv",
    private readonly injectedCli?: (
      cwd: string,
      args: string[],
    ) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>,
    private readonly workspaces: DiversionWorkspaceStrategy = "shared",
  ) {
    this.capabilities = {
      isolatedMode: true,
      directMode: true,
      parallelTaskWorkspaces: workspaces === "per-task",
      durableRecovery: true,
      automatedConflictRepair: false,
    };
  }

  /**
   * Per-workspace isolation only applies to isolated mode. A direct job commits
   * straight onto the configured target, and both the supervisor and the daemon
   * already force direct jobs to run exclusively, so a second workspace would
   * buy nothing and cost a full sync.
   */
  private isolates(mode: WorkspaceMode): boolean {
    return this.workspaces === "per-task" && mode === "isolated";
  }

  /**
   * Everything operating on an EXISTING workspace asks the handle, never the
   * current config. A job opened per-task must be restored, released and landed
   * per-task even if the setting has since been changed back to "shared" —
   * otherwise its handle would be driven down the shared path, and the shared
   * path would start checking noriq branches out in the human's checkout.
   */
  private isolatedHandle(handle: BackendHandle): boolean {
    return typeof handle.state.workspaceRoot === "string";
  }

  private async dv(
    cwd: string,
    args: string[],
    allowFailure = false,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ) {
    const result = this.injectedCli
      ? await this.injectedCli(cwd, args)
      : await runProcess({
          command: this.command,
          args,
          cwd,
          timeoutMs,
        });
    if (!allowFailure && result.exitCode !== 0)
      throw new Error(
        `dv ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
      );
    return result;
  }

  /**
   * Every checkout goes through here so none can be issued interactively.
   * `dv checkout` PROMPTS when the target branch holds shelved changes, and
   * runProcess never writes to the child's stdin, so a bare checkout can hang
   * until the command timeout and then fail. The likeliest victim is release(),
   * which checks the operator's own branch back out at teardown — exactly the
   * branch a human is most likely to have shelved work on.
   *
   * --ignore-shelf, never --apply-shelf: applying would silently mix a human's
   * shelved work into an agent's branch, where it could be committed and landed.
   */
  private async checkout(cwd: string, reference: string, allowFailure = false) {
    return this.dv(
      cwd,
      ["checkout", reference, "--ignore-shelf"],
      allowFailure,
    );
  }

  /**
   * `dv clone` addresses a repository by id, not by local path, so a per-task
   * workspace has to resolve the id of the checkout it is cloning from. The
   * "Cloned Locally" section of `dv repo` is the only place that maps one to
   * the other.
   */
  private async repositoryIdentifier(repository: string): Promise<string> {
    const output = (await this.dv(repository, ["repo"])).stdout;
    const target = await realpath(repository);
    for (const line of output.split("\n")) {
      const match = line.match(/^\s*(.+?)\s*\((dv\.repo\.[^)]+)\)\((.+)\)\s*$/);
      if (!match) continue;
      const candidate = await realpath(match[3]!).catch(() => match[3]!);
      if (candidate === target) return match[2]!;
    }
    throw new Error(
      `dv repo did not report a repository id for the checkout at ${repository}`,
    );
  }

  private async cloneWorkspace(
    repositoryId: string,
    path: string,
    reference: string,
  ): Promise<void> {
    const parent = dirname(path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await this.dv(
      parent,
      ["clone", repositoryId, path, "--new-workspace", "--ref", reference],
      false,
      CLONE_TIMEOUT_MS,
    );
  }

  /**
   * Returns true when the workspace is fully gone. A failure to deregister the
   * workspace server-side deliberately LEAVES the directory in place: the
   * directory is the only record that a cloud workspace is still registered,
   * and `recoverOrphans` uses it to retry. Removing it here would turn a
   * retryable leak into a silent one.
   */
  private async destroyWorkspace(path: string): Promise<boolean> {
    if (!(await exists(path))) return true;
    if (!(await exists(join(path, ".diversion")))) {
      await rm(path, { recursive: true, force: true });
      return true;
    }
    const identifier = await workspaceIdentifier(path).catch(() => null);
    if (!identifier) return false;
    const deleted = await this.dv(
      path,
      ["workspace", "delete", identifier, "-f"],
      true,
    );
    if (deleted.exitCode !== 0) return false;
    await rm(path, { recursive: true, force: true });
    return true;
  }

  /**
   * Disposes of every workspace a job cloned. Returns false if any of them
   * could not be deregistered, which callers MUST treat as "keep the lock
   * file": that lock is the only record naming this root, so unlinking it
   * after a partial teardown would strand registered cloud workspaces with
   * nothing left pointing at them.
   */
  private async disposeWorkspaceRoot(
    root: string,
    keep: (child: string) => boolean = () => false,
  ): Promise<boolean> {
    let children: string[];
    try {
      children = await readdir(root);
    } catch (error) {
      // Only "it is not there" means there is nothing left to dispose of.
      // EACCES, EIO and friends mean the answer is UNKNOWN, and reporting
      // success would let the caller delete the recovery record.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      return false;
    }
    let disposed = true;
    for (const child of children) {
      if (keep(child)) {
        disposed = false;
        continue;
      }
      if (!(await this.destroyWorkspace(join(root, child)))) disposed = false;
    }
    if (disposed) await rm(root, { recursive: true, force: true });
    return disposed;
  }

  discoverRepository = repositoryRoot;
  async repositoryIdentity(path: string): Promise<string> {
    return repositoryRoot(path);
  }

  private async currentReference(path: string): Promise<string> {
    const result = await this.dv(path, ["branch-name"]);
    const value = result.stdout.trim();
    if (!value) throw new Error("dv branch-name returned no current reference");
    return value;
  }

  private async currentRevision(path: string): Promise<string> {
    return (await this.dv(path, ["status", "--commit-id-only"])).stdout.trim();
  }

  private async waitForMutationRevision(
    path: string,
    result: { stdout: string; stderr: string },
  ): Promise<string> {
    const reported = `${result.stdout}\n${result.stderr}`.match(
      /(?:New commit ID:|Commit ID:)\s*([^\s]+)/i,
    )?.[1];
    const expected =
      reported ??
      (await this.referenceRevision(path, await this.currentReference(path)));
    const deadline = Date.now() + 30_000;
    let actual = "<unavailable>";
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        actual = await this.currentRevision(path);
        if (actual === expected) return expected;
        lastError = undefined;
      } catch (error) {
        lastError = error;
      }
      await delay(100);
    }
    const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
    throw new Error(
      `Diversion workspace did not sync to ${expected}; still at ${actual}${suffix}`,
    );
  }

  private async referenceRevision(
    path: string,
    reference: string,
  ): Promise<string> {
    const result = await this.dv(
      path,
      ["show", reference, "--color", "never"],
      true,
    );
    if (result.exitCode !== 0)
      throw new Error(`Diversion reference ${reference} does not exist`);
    const revision = `${result.stdout}\n${result.stderr}`.match(
      /^\s*commit\s+([^\s]+)/m,
    )?.[1];
    if (!revision)
      throw new Error(`dv show ${reference} did not report a revision`);
    return revision;
  }

  revisionOf(path: string, reference: string): Promise<string> {
    return this.referenceRevision(path, reference);
  }

  private async dirtyPaths(path: string): Promise<string[]> {
    const output = (
      await this.dv(path, ["diff", "--name-status", "--color", "never"])
    ).stdout.trim();
    if (!output) return [];
    return output
      .split("\n")
      .map((line) => line.split("\t").slice(1).join("\t").trim())
      .filter(Boolean);
  }

  private async settledDirtyPaths(path: string): Promise<string[]> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await this.dv(path, ["status", "--nowait"], true);
      const paths = await this.dirtyPaths(path);
      if (paths.length > 0 || attempt === 4) return paths;
      await delay(100);
    }
    return [];
  }

  private async requireClean(path: string): Promise<void> {
    const paths = await this.dirtyPaths(path);
    if (paths.length > 0)
      throw new Error(`Diversion workspace is not clean:\n${paths.join("\n")}`);
  }

  /**
   * In shared mode the lease is the whole checkout, because that is literally
   * what a job takes over. In per-task mode nothing outside the job's own
   * cloned workspaces is touched, so the lease narrows to the output branch and
   * two jobs on different branches of one repository can run at once.
   */
  private async acquireLock(
    repository: string,
    stateDirectory: string,
    jobId: string,
    scope?: string,
  ): Promise<string> {
    const key = createHash("sha256").update(repository).digest("hex");
    const directory = resolve(stateDirectory, "locks");
    const suffix = scope
      ? `-${createHash("sha256").update(scope).digest("hex").slice(0, 16)}`
      : "";
    const path = join(directory, `${this.id}-${key}${suffix}.json`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({
            backend: this.id,
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
      const owner = JSON.parse(await readFile(path, "utf8")) as {
        backend?: string;
        jobId?: string;
      };
      if (owner.backend !== this.id || owner.jobId !== jobId)
        throw new Error(
          `Diversion workspace is locked by ${owner.jobId ?? "an unknown job"}`,
        );
    }
    return path;
  }

  /**
   * Reuses an existing cloned workspace when one survived a restart, and
   * otherwise clones a fresh one. A directory without a `.diversion` marker is
   * a partial clone from an interrupted run, not a workspace, so it is cleared
   * rather than trusted.
   */
  private async ensureWorkspace(
    repositoryId: string,
    path: string,
    reference: string,
  ): Promise<void> {
    if (await exists(join(path, ".diversion"))) {
      if ((await this.currentReference(path)) !== reference)
        await this.checkout(path, reference);
      return;
    }
    if (await exists(path)) await rm(path, { recursive: true, force: true });
    await this.cloneWorkspace(repositoryId, path, reference);
  }

  /**
   * The per-task counterpart of openJob. It never runs a mutating command in
   * the configured checkout: the output branch is created inside the job's own
   * clone, so the human's working copy keeps whatever branch and uncommitted
   * work it already had.
   */
  private async openIsolatedJob(
    options: Parameters<SourceControlBackend["openJob"]>[0],
    repository: string,
  ): Promise<JobWorkspace> {
    const outputReference = `noriq/${options.kind}/${safeName(options.key)}-${safeName(options.jobId).slice(-10)}`;
    const lockPath = await this.acquireLock(
      repository,
      options.stateDirectory,
      options.jobId,
      outputReference,
    );
    const root = workspaceRoot(options.stateDirectory, options.jobId);
    try {
      const base = await this.referenceRevision(
        repository,
        options.config.sourceControl.base,
      );
      if (base !== options.expectedBaseRevision)
        throw new Error(
          `base revision changed: expected ${options.expectedBaseRevision}, found ${base}`,
        );
      const repositoryId = await this.repositoryIdentifier(repository);
      const path = join(root, "job");
      await writeFile(
        lockPath,
        JSON.stringify({
          backend: this.id,
          jobId: options.jobId,
          repository,
          pid: process.pid,
          outputReference,
          workspaceRoot: root,
        }),
        { mode: 0o600 },
      );
      const existing = await this.dv(
        repository,
        ["show", outputReference, "--color", "never"],
        true,
      );
      if (existing.exitCode === 0) {
        const revision = existing.stdout.match(/^\s*commit\s+([^\s]+)/m)?.[1];
        if (revision !== base)
          throw new Error(
            `existing Diversion output ${outputReference} is not pinned to ${base}`,
          );
        await this.ensureWorkspace(repositoryId, path, outputReference);
      } else {
        await this.ensureWorkspace(
          repositoryId,
          path,
          options.config.sourceControl.base,
        );
        await this.dv(path, ["branch", "-c", outputReference]);
        await this.dv(path, ["status"]);
      }
      const revision = await this.currentRevision(path);
      if (revision !== base)
        throw new Error(
          `Diversion job workspace opened at ${revision}, expected ${base}`,
        );
      return {
        handle: {
          backend: this.id,
          version: 1,
          state: {
            lockPath,
            originalReference: outputReference,
            outputReference,
            jobId: options.jobId,
            workspaceRoot: root,
            repositoryId,
          },
        },
        vcs: this.kind,
        mode: "isolated",
        repositoryIdentity: repository,
        path,
        baseRevision: base,
        currentRevision: base,
        retainedLocation: { vcs: this.kind, label: outputReference, url: null },
      };
    } catch (error) {
      // A half-finished clone must not outlive its lock, or nothing is left
      // naming the workspaces it registered.
      if (await this.disposeWorkspaceRoot(root).catch(() => false))
        await unlink(lockPath).catch(() => {});
      throw error;
    }
  }

  async openJob(
    options: Parameters<SourceControlBackend["openJob"]>[0],
  ): Promise<JobWorkspace> {
    const repository = await repositoryRoot(options.repository);
    if (this.isolates(options.config.sourceControl.mode))
      return this.openIsolatedJob(options, repository);
    const lockPath = await this.acquireLock(
      repository,
      options.stateDirectory,
      options.jobId,
    );
    try {
      await this.requireClean(repository);
      const lockOwner = JSON.parse(await readFile(lockPath, "utf8")) as {
        originalReference?: string;
      };
      const currentReference = await this.currentReference(repository);
      const originalReference = lockOwner.originalReference ?? currentReference;
      const base = await this.referenceRevision(
        repository,
        options.config.sourceControl.base,
      );
      if (base !== options.expectedBaseRevision)
        throw new Error(
          `base revision changed: expected ${options.expectedBaseRevision}, found ${base}`,
        );
      const mode = options.config.sourceControl.mode;
      let outputReference: string;
      if (mode === "direct") {
        outputReference = options.config.sourceControl.target!;
        if (originalReference !== outputReference)
          throw new Error(
            `direct mode requires target ${outputReference}, found ${originalReference}`,
          );
      } else {
        outputReference = `noriq/${options.kind}/${safeName(options.key)}-${safeName(options.jobId).slice(-10)}`;
        await writeFile(
          lockPath,
          JSON.stringify({
            backend: this.id,
            jobId: options.jobId,
            repository,
            pid: process.pid,
            originalReference,
            outputReference,
          }),
          { mode: 0o600 },
        );
        const existing = await this.dv(
          repository,
          ["show", outputReference, "--color", "never"],
          true,
        );
        if (existing.exitCode === 0) {
          const revision = existing.stdout.match(/^\s*commit\s+([^\s]+)/m)?.[1];
          if (revision !== base)
            throw new Error(
              `existing Diversion output ${outputReference} is not pinned to ${base}`,
            );
          if (currentReference !== outputReference)
            await this.checkout(repository, outputReference);
        } else {
          if (currentReference !== options.config.sourceControl.base)
            await this.checkout(repository, options.config.sourceControl.base);
          await this.dv(repository, ["branch", "-c", outputReference]);
          await this.dv(repository, ["status"]);
        }
      }
      return {
        handle: {
          backend: this.id,
          version: 1,
          state: {
            lockPath,
            originalReference,
            outputReference,
            jobId: options.jobId,
          },
        },
        vcs: this.kind,
        mode,
        repositoryIdentity: repository,
        path: repository,
        baseRevision: base,
        currentRevision: base,
        retainedLocation: { vcs: this.kind, label: outputReference, url: null },
      };
    } catch (error) {
      await unlink(lockPath).catch(() => {});
      throw error;
    }
  }

  private async restoreIsolatedJob(
    options: Parameters<SourceControlBackend["restoreJob"]>[0],
    repository: string,
  ): Promise<JobWorkspace> {
    const outputReference = stringState(options.handle, "outputReference");
    const lockPath = await this.acquireLock(
      repository,
      options.stateDirectory,
      options.jobId,
      outputReference,
    );
    options.handle.state.lockPath = lockPath;
    const repositoryId = stringState(options.handle, "repositoryId");
    const root = stringState(options.handle, "workspaceRoot");
    // acquireLock only writes a bare payload when it creates the file, so a
    // lock recreated during restore would lose the workspace root that orphan
    // recovery needs.
    await writeFile(
      lockPath,
      JSON.stringify({
        backend: this.id,
        jobId: options.jobId,
        repository,
        pid: process.pid,
        outputReference,
        workspaceRoot: root,
      }),
      { mode: 0o600 },
    );
    const path = join(root, "job");
    const revision = await this.referenceRevision(repository, outputReference);
    await this.ensureWorkspace(repositoryId, path, outputReference);
    return {
      handle: options.handle,
      vcs: this.kind,
      mode: options.mode,
      repositoryIdentity: repository,
      path,
      baseRevision: options.baseRevision,
      currentRevision: revision,
      retainedLocation: { vcs: this.kind, label: outputReference, url: null },
    };
  }

  async restoreJob(
    options: Parameters<SourceControlBackend["restoreJob"]>[0],
  ): Promise<JobWorkspace> {
    assertBackendHandle(options.handle, this.id, "restored job");
    const repository = await repositoryRoot(options.repository);
    if (this.isolatedHandle(options.handle))
      return this.restoreIsolatedJob(options, repository);
    const lockPath = await this.acquireLock(
      repository,
      options.stateDirectory,
      options.jobId,
    );
    options.handle.state.lockPath = lockPath;
    const outputReference = stringState(options.handle, "outputReference");
    const revision = await this.referenceRevision(repository, outputReference);
    if (revision !== options.currentRevision && options.mode === "direct") {
      if (typeof options.handle.state.acceptingTask !== "string")
        throw new Error(
          `Diversion output drifted from ${options.currentRevision} to ${revision} while Runner was offline`,
        );
      const log = await this.dv(repository, ["log", "-n", "1"]);
      if (!log.stdout.includes(`[noriq job ${options.jobId}]`))
        throw new Error(
          `Diversion output drifted from ${options.currentRevision} to ${revision} while Runner was offline`,
        );
    }
    return {
      handle: options.handle,
      vcs: this.kind,
      mode: options.mode,
      repositoryIdentity: repository,
      path: repository,
      baseRevision: options.baseRevision,
      currentRevision: revision,
      retainedLocation: { vcs: this.kind, label: outputReference, url: null },
    };
  }

  /**
   * The per-task counterpart of beginTask: the candidate branch is created
   * inside the task's own clone, so two tasks of one job hold two real working
   * copies on disk and can build at the same time.
   */
  private async beginIsolatedTask(
    workspace: JobWorkspace,
    taskKey: string,
  ): Promise<TaskWorkspace> {
    const outputReference = stringState(workspace.handle, "outputReference");
    const repositoryId = stringState(workspace.handle, "repositoryId");
    const root = stringState(workspace.handle, "workspaceRoot");
    const candidateReference = `${outputReference}/candidate-${safeName(taskKey)}`;
    const path = join(root, `task-${safeName(taskKey)}`);
    const existing = await this.dv(
      workspace.path,
      ["show", candidateReference, "--color", "never"],
      true,
    );
    if (existing.exitCode === 0) {
      const revision = existing.stdout.match(/^\s*commit\s+([^\s]+)/m)?.[1];
      if (revision !== workspace.currentRevision)
        throw new Error(
          `existing Diversion candidate ${candidateReference} is not pinned to ${workspace.currentRevision}`,
        );
      await this.ensureWorkspace(repositoryId, path, candidateReference);
    } else {
      await this.ensureWorkspace(repositoryId, path, outputReference);
      await this.dv(path, ["branch", "-c", candidateReference]);
      await this.dv(path, ["status"]);
    }
    const baseRevision = await this.currentRevision(path);
    if (baseRevision !== workspace.currentRevision)
      throw new Error(
        `Diversion output drifted from ${workspace.currentRevision} to ${baseRevision}`,
      );
    return {
      handle: {
        backend: this.id,
        version: 1,
        state: { candidateReference, outputReference, workspacePath: path },
      },
      path,
      baseRevision,
    };
  }

  async beginTask(
    workspace: JobWorkspace,
    taskKey: string,
  ): Promise<TaskWorkspace> {
    assertBackendHandle(workspace.handle, this.id, "job workspace");
    if (this.isolatedHandle(workspace.handle))
      return this.beginIsolatedTask(workspace, taskKey);
    const outputReference = stringState(workspace.handle, "outputReference");
    if ((await this.currentReference(workspace.path)) !== outputReference)
      await this.checkout(workspace.path, outputReference);
    const baseRevision = await this.currentRevision(workspace.path);
    if (baseRevision !== workspace.currentRevision)
      throw new Error(
        `Diversion output drifted from ${workspace.currentRevision} to ${baseRevision}`,
      );
    if (workspace.mode === "direct")
      return {
        handle: {
          backend: this.id,
          version: 1,
          state: { candidateReference: outputReference, outputReference },
        },
        path: workspace.path,
        baseRevision,
      };
    const candidateReference = `${outputReference}/candidate-${safeName(taskKey)}`;
    const existing = await this.dv(
      workspace.path,
      ["show", candidateReference, "--color", "never"],
      true,
    );
    if (existing.exitCode === 0) {
      const revision = existing.stdout.match(/^\s*commit\s+([^\s]+)/m)?.[1];
      if (revision !== baseRevision)
        throw new Error(
          `existing Diversion candidate ${candidateReference} is not pinned to ${baseRevision}`,
        );
      await this.checkout(workspace.path, candidateReference);
    } else {
      await this.dv(workspace.path, ["branch", "-c", candidateReference]);
      await this.dv(workspace.path, ["status"]);
    }
    return {
      handle: {
        backend: this.id,
        version: 1,
        state: { candidateReference, outputReference },
      },
      path: workspace.path,
      baseRevision,
    };
  }

  async stageCandidate(
    options: Parameters<SourceControlBackend["stageCandidate"]>[0],
  ) {
    assertBackendHandle(options.task.handle, this.id, "task workspace");
    const changedPaths = await this.settledDirtyPaths(options.task.path);
    if (options.workspace.mode === "direct")
      return {
        status: "ready" as const,
        checkpoint: checkpoint(
          options.workspace.currentRevision,
          changedPaths.length ? "uncommitted candidate" : "no-op",
        ),
        changedPaths,
        backendState: options.task.handle,
      };
    let ref: string;
    if (changedPaths.length > 0) {
      const result = await this.dv(options.task.path, [
        "commit",
        "-a",
        "--no-verify",
        "-m",
        `${options.taskKey}: ${options.summary.slice(0, 200)}`,
      ]);
      ref = await this.waitForMutationRevision(options.task.path, result);
    } else ref = await this.currentRevision(options.task.path);
    return {
      status: "ready" as const,
      checkpoint: checkpoint(ref),
      changedPaths,
      backendState: options.task.handle,
    };
  }

  async integrateLatest(workspace: JobWorkspace, task: TaskWorkspace) {
    assertBackendHandle(task.handle, this.id, "task workspace");
    if (workspace.mode === "direct") return null;
    const result = await this.dv(
      task.path,
      ["merge", stringState(task.handle, "outputReference")],
      true,
    );
    if (result.exitCode !== 0)
      return {
        status: "conflict" as const,
        paths: await this.dirtyPaths(task.path),
        detail: `${result.stdout}\n${result.stderr}`.trim(),
        backendState: task.handle,
      };
    const revision = await this.waitForMutationRevision(task.path, result);
    return {
      status: "ready" as const,
      checkpoint: checkpoint(revision),
      changedPaths: await this.dirtyPaths(task.path),
      backendState: task.handle,
    };
  }

  async continueConflict(): Promise<void> {
    throw new Error(
      "Diversion conflict repair is not advertised by this backend",
    );
  }
  async abortConflict(task: TaskWorkspace): Promise<void> {
    await this.dv(task.path, ["merge", "--abort"], true);
  }

  async reviewDiff(
    _workspace: JobWorkspace,
    task: TaskWorkspace,
  ): Promise<string> {
    assertBackendHandle(task.handle, this.id, "task workspace");
    return (
      await this.dv(task.path, [
        "diff",
        "--base",
        task.baseRevision,
        "--color",
        "never",
      ])
    ).stdout;
  }

  async acceptCandidate(
    options: Parameters<SourceControlBackend["acceptCandidate"]>[0],
  ): Promise<SourceControlCheckpoint> {
    assertBackendHandle(options.task.handle, this.id, "task workspace");
    const outputReference = stringState(options.task.handle, "outputReference");
    if (options.workspace.mode === "direct") {
      const actual = await this.currentRevision(options.task.path);
      if (actual !== options.workspace.currentRevision)
        throw new Error(
          `direct target drifted from ${options.workspace.currentRevision} to ${actual}`,
        );
      const paths = await this.settledDirtyPaths(options.task.path);
      let revision = actual;
      if (paths.length > 0) {
        const result = await this.dv(options.task.path, [
          "commit",
          "-a",
          "--no-verify",
          "-m",
          `${options.taskKey}: accepted [noriq job ${stringState(options.workspace.handle, "jobId")}]`,
        ]);
        revision = await this.waitForMutationRevision(
          options.task.path,
          result,
        );
      }
      options.workspace.currentRevision = revision;
      return checkpoint(revision);
    }
    await this.checkout(options.workspace.path, outputReference);
    const outputRevision = await this.currentRevision(options.workspace.path);
    if (outputRevision !== options.workspace.currentRevision)
      throw new Error(
        `Diversion output drifted from ${options.workspace.currentRevision} to ${outputRevision}`,
      );
    const result = await this.dv(options.workspace.path, [
      "merge",
      options.candidate.ref,
    ]);
    const revision = await this.waitForMutationRevision(
      options.workspace.path,
      result,
    );
    options.workspace.currentRevision = revision;
    return checkpoint(revision);
  }

  /**
   * Lands from a workspace of its own rather than from the configured checkout.
   * It never borrows the job clone, which a manual landing cannot count on
   * still existing — release() disposes of it long before. The landing
   * workspace is provisioned here and disposed of here.
   */
  private async landIsolated(
    options: Parameters<SourceControlBackend["land"]>[0],
  ): Promise<LandingResult> {
    const repository = await repositoryRoot(options.repository);
    const sourceReference = stringState(
      options.workspace.handle,
      "outputReference",
    );
    const sourceRevision = await this.referenceRevision(
      repository,
      sourceReference,
    );
    if (sourceRevision !== options.workspace.currentRevision)
      throw new Error(
        `retained Diversion output ${sourceReference} drifted from ${options.workspace.currentRevision} to ${sourceRevision}`,
      );
    const targetRevision = await this.referenceRevision(
      repository,
      options.target,
    );
    if (targetRevision === sourceRevision)
      return {
        target: options.target,
        checkpoint: checkpoint(sourceRevision, options.target),
      };
    const repositoryId = stringState(options.workspace.handle, "repositoryId");
    const root = stringState(options.workspace.handle, "workspaceRoot");
    const path = join(root, "landing");
    const lockPath = await this.acquireLock(
      repository,
      options.stateDirectory,
      options.jobId,
      `landing:${options.target}`,
    );
    // acquireLock writes a bare payload, which would leave this lock naming no
    // workspace — and it is the only record of the clone made just below.
    await writeFile(
      lockPath,
      JSON.stringify({
        backend: this.id,
        jobId: options.jobId,
        repository,
        pid: process.pid,
        outputReference: sourceReference,
        workspaceRoot: root,
      }),
      { mode: 0o600 },
    );
    try {
      await this.ensureWorkspace(repositoryId, path, options.target);
      const actualTarget = await this.currentRevision(path);
      if (actualTarget !== targetRevision)
        throw new Error(
          `Diversion target ${options.target} drifted from ${targetRevision} to ${actualTarget}`,
        );
      const merged = await this.dv(path, ["merge", sourceReference], true);
      if (merged.exitCode !== 0) {
        await this.dv(path, ["merge", "--abort"], true);
        throw new Error(
          `Diversion could not merge retained output into ${options.target}: ${merged.stderr || merged.stdout}`,
        );
      }
      const landedRevision = await this.waitForMutationRevision(path, merged);
      return {
        target: options.target,
        checkpoint: checkpoint(landedRevision, options.target),
      };
    } finally {
      // destroyWorkspace REPORTS failure, it does not throw. Unlinking the lock
      // regardless would strand a registered workspace with nothing naming it.
      if (await this.destroyWorkspace(path).catch(() => false))
        await unlink(lockPath).catch(() => {});
    }
  }

  async land(
    options: Parameters<SourceControlBackend["land"]>[0],
  ): Promise<LandingResult> {
    assertBackendHandle(options.workspace.handle, this.id, "landing workspace");
    if (this.isolatedHandle(options.workspace.handle))
      return this.landIsolated(options);
    if (options.workspace.mode === "direct")
      return {
        target: options.target,
        checkpoint: checkpoint(
          options.workspace.currentRevision,
          options.target,
        ),
      };
    const repository = await repositoryRoot(options.repository);
    const sourceReference = stringState(
      options.workspace.handle,
      "outputReference",
    );
    const sourceRevision = await this.referenceRevision(
      repository,
      sourceReference,
    );
    if (sourceRevision !== options.workspace.currentRevision)
      throw new Error(
        `retained Diversion output ${sourceReference} drifted from ${options.workspace.currentRevision} to ${sourceRevision}`,
      );
    const targetRevision = await this.referenceRevision(
      repository,
      options.target,
    );
    if (targetRevision === sourceRevision)
      return {
        target: options.target,
        checkpoint: checkpoint(sourceRevision, options.target),
      };

    const lockPath = await this.acquireLock(
      repository,
      options.stateDirectory,
      options.jobId,
    );
    const originalReference = await this.currentReference(repository);
    try {
      await this.requireClean(repository);
      if (originalReference !== options.target)
        await this.checkout(repository, options.target);
      const actualTarget = await this.currentRevision(repository);
      if (actualTarget !== targetRevision)
        throw new Error(
          `Diversion target ${options.target} drifted from ${targetRevision} to ${actualTarget}`,
        );
      const merged = await this.dv(
        repository,
        ["merge", sourceReference],
        true,
      );
      if (merged.exitCode !== 0) {
        await this.dv(repository, ["merge", "--abort"], true);
        throw new Error(
          `Diversion could not merge retained output into ${options.target}: ${merged.stderr || merged.stdout}`,
        );
      }
      const landedRevision = await this.waitForMutationRevision(
        repository,
        merged,
      );
      return {
        target: options.target,
        checkpoint: checkpoint(landedRevision, options.target),
      };
    } finally {
      if ((await this.dirtyPaths(repository)).length === 0) {
        if ((await this.currentReference(repository)) !== originalReference)
          await this.checkout(repository, originalReference);
      }
      const owner = JSON.parse(await readFile(lockPath, "utf8")) as {
        jobId?: string;
      };
      if (owner.jobId === options.jobId) await unlink(lockPath);
    }
  }

  async preserveFailedWork(
    options: Parameters<SourceControlBackend["preserveFailedWork"]>[0],
  ) {
    assertBackendHandle(options.task.handle, this.id, "task workspace");
    const dirty = await this.settledDirtyPaths(options.task.path);
    const current = await this.currentRevision(options.task.path);
    if (dirty.length === 0 && current === options.task.baseRevision)
      return null;
    const suffix = createHash("sha256")
      .update(`${options.taskKey}:${current}:${options.reason}`)
      .digest("hex")
      .slice(0, 10);
    const recovery = `noriq-recovery-${safeName(options.taskKey)}-${suffix}`;
    if (options.workspace.mode === "direct") {
      if (dirty.length > 0)
        await this.dv(options.task.path, ["shelf", "create", recovery, "."]);
      else {
        await this.dv(options.task.path, ["branch", "-c", recovery]);
        await this.checkout(
          options.task.path,
          stringState(options.task.handle, "outputReference"),
        );
        await this.dv(options.task.path, [
          "reset",
          "--hard",
          options.workspace.currentRevision,
        ]);
      }
      options.task.handle.state.preserved = true;
      return { vcs: this.kind, label: recovery, url: null };
    }
    if (dirty.length > 0) {
      const result = await this.dv(options.task.path, [
        "commit",
        "-a",
        "--no-verify",
        "-m",
        `WIP ${options.taskKey}: ${options.reason.slice(0, 160)}`,
      ]);
      await this.waitForMutationRevision(options.task.path, result);
    }
    options.task.handle.state.preserved = true;
    const candidateReference = stringState(
      options.task.handle,
      "candidateReference",
    );
    // A shared checkout has to be moved off the candidate branch before the
    // branch can be left behind. A per-task clone is about to be destroyed, and
    // the checkout would cost a full sync for nothing.
    if (!this.isolatedHandle(options.workspace.handle))
      await this.checkout(
        options.task.path,
        stringState(options.task.handle, "outputReference"),
      );
    return { vcs: this.kind, label: candidateReference, url: null };
  }

  async inspect(workspace: JobWorkspace) {
    assertBackendHandle(workspace.handle, this.id, "job workspace");
    return {
      revision: await this.referenceRevision(
        workspace.path,
        stringState(workspace.handle, "outputReference"),
      ),
      dirtyPaths: await this.dirtyPaths(workspace.path),
      retainedLocation: workspace.retainedLocation,
    };
  }
  async inspectTask(task: TaskWorkspace) {
    assertBackendHandle(task.handle, this.id, "task workspace");
    return {
      revision: await this.currentRevision(task.path),
      dirtyPaths: await this.dirtyPaths(task.path),
      retainedLocation: {
        vcs: this.kind,
        label: stringState(task.handle, "candidateReference"),
        url: null,
      },
    };
  }

  async releaseTask(
    workspace: JobWorkspace,
    task: TaskWorkspace,
  ): Promise<void> {
    assertBackendHandle(task.handle, this.id, "task workspace");
    if (this.isolatedHandle(workspace.handle)) {
      // Preserved work lives on the candidate branch server-side, so the local
      // clone is disposable either way; only the BRANCH is kept.
      const removed = await this.destroyWorkspace(task.path);
      if (removed && task.handle.state.preserved !== true)
        await this.dv(workspace.path, [
          "branch",
          "-d",
          stringState(task.handle, "candidateReference"),
          "-f",
        ]);
      return;
    }
    if (workspace.mode === "direct" || task.handle.state.preserved === true)
      return;
    const outputReference = stringState(task.handle, "outputReference");
    if ((await this.currentReference(task.path)) !== outputReference)
      await this.checkout(task.path, outputReference);
    await this.dv(task.path, [
      "branch",
      "-d",
      stringState(task.handle, "candidateReference"),
      "-f",
    ]);
  }

  async release(workspace: JobWorkspace, jobId: string): Promise<void> {
    assertBackendHandle(workspace.handle, this.id, "job workspace");
    const lockPath = stringState(workspace.handle, "lockPath");
    if (this.isolatedHandle(workspace.handle)) {
      // The job clone is disposable: everything accepted is already on the
      // output branch, and a later manual landing re-provisions its own
      // workspace rather than depending on this one surviving. Sweeping the
      // whole root covers it along with any task whose own release failed. A
      // lock outliving a failed teardown is deliberate — orphan recovery finds
      // the leftovers through it.
      const root = stringState(workspace.handle, "workspaceRoot");
      if (!(await this.disposeWorkspaceRoot(root))) return;
      try {
        const owner = JSON.parse(await readFile(lockPath, "utf8")) as {
          jobId?: string;
        };
        if (owner.jobId === jobId) await unlink(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return;
    }
    try {
      if ((await this.dirtyPaths(workspace.path)).length === 0) {
        const original = stringState(workspace.handle, "originalReference");
        if ((await this.currentReference(workspace.path)) !== original)
          await this.checkout(workspace.path, original);
      }
      const owner = JSON.parse(await readFile(lockPath, "utf8")) as {
        jobId?: string;
      };
      if (owner.jobId === jobId) await unlink(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async recoverOrphans(
    repository: string,
    stateDirectory: string,
  ): Promise<string[]> {
    const root = await repositoryRoot(repository);
    const key = createHash("sha256").update(root).digest("hex");
    // Keyed by lock filename, not by current config: a user who tries per-task
    // and switches back must not lose the only path that reclaims what is left.
    const isolated = await this.recoverIsolatedOrphans(root, stateDirectory);
    const lockPath = join(
      resolve(stateDirectory, "locks"),
      `${this.id}-${key}.json`,
    );
    if (!(await exists(lockPath))) return isolated;
    const owner = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid?: number;
      jobId?: string;
    };
    if (typeof owner.pid === "number") {
      try {
        process.kill(owner.pid, 0);
        return isolated;
      } catch {}
    }
    const warnings: string[] = [...isolated];
    const dirty = await this.dirtyPaths(root);
    if (dirty.length > 0) {
      const shelf = `noriq-orphan-${safeName(owner.jobId ?? "unknown")}`;
      await this.dv(root, ["shelf", "create", shelf, "."]);
      warnings.push(`preserved orphaned Diversion work in shelf ${shelf}`);
    }
    await unlink(lockPath);
    return warnings;
  }

  /**
   * Per-task locks are keyed by branch, so a crashed job leaves a suffixed lock
   * naming the workspaces it never tore down. Committed work is on the server;
   * what leaks here are registered cloud workspaces, which is what this
   * reclaims. A workspace that refuses to deregister is reported rather than
   * silently forgotten.
   */
  private async recoverIsolatedOrphans(
    root: string,
    stateDirectory: string,
  ): Promise<string[]> {
    const key = createHash("sha256").update(root).digest("hex");
    const directory = resolve(stateDirectory, "locks");
    const entries = await readdir(directory).catch(() => [] as string[]);
    const warnings: string[] = [];
    for (const entry of entries) {
      if (!entry.startsWith(`${this.id}-${key}-`) || !entry.endsWith(".json"))
        continue;
      const lockPath = join(directory, entry);
      let owner: { pid?: number; jobId?: string; workspaceRoot?: string };
      try {
        owner = JSON.parse(await readFile(lockPath, "utf8"));
      } catch {
        continue;
      }
      if (typeof owner.pid === "number") {
        try {
          process.kill(owner.pid, 0);
          continue;
        } catch {}
      }
      if (typeof owner.workspaceRoot !== "string") {
        // The lock names no root, so what it owns is UNKNOWN. Deleting it here
        // would report a reclamation that never happened.
        warnings.push(
          `Diversion lock ${entry} names no workspace root; left in place for inspection`,
        );
        continue;
      }
      // A job's own workspace and a landing workspace are both re-provisioned
      // on demand, so they are safe to reclaim. A TASK workspace is not: the
      // supervisor resumes a restored task straight into its persisted path and
      // nothing re-clones it, so destroying one turns a resumable job into a
      // permanently broken one — and takes any uncommitted work with it. The
      // surviving lock is what keeps them findable.
      const disposed = await this.disposeWorkspaceRoot(
        owner.workspaceRoot,
        (child) => child.startsWith("task-"),
      );
      if (!disposed) {
        warnings.push(
          `Diversion workspaces under ${owner.workspaceRoot} were left in place for job ${owner.jobId ?? "unknown"}; they are reclaimed when that job settles, or with \`dv workspace delete\``,
        );
        continue;
      }
      warnings.push(
        `reclaimed orphaned Diversion workspaces from job ${owner.jobId ?? "unknown"}`,
      );
      await unlink(lockPath).catch(() => {});
    }
    return warnings;
  }

  runCommands = runCommands;
}

/** @deprecated use DiversionSourceControlBackend */
export { DiversionSourceControlBackend as DiversionWorkspaceBackend };
