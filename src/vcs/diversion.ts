import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runCommands } from "../git.js";
import { runProcess } from "../process.js";
import {
  assertBackendHandle,
  type BackendHandle,
  type JobWorkspace,
  type SourceControlBackend,
  type SourceControlCheckpoint,
  type TaskWorkspace,
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

export class DiversionSourceControlBackend implements SourceControlBackend {
  readonly kind = "diversion";
  readonly capabilities = {
    isolatedMode: true,
    directMode: true,
    parallelTaskWorkspaces: false,
    durableRecovery: true,
    automatedConflictRepair: false,
  };

  constructor(
    readonly id = "diversion",
    private readonly command = "dv",
    private readonly injectedCli?: (
      cwd: string,
      args: string[],
    ) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>,
  ) {}

  private async dv(cwd: string, args: string[], allowFailure = false) {
    const result = this.injectedCli
      ? await this.injectedCli(cwd, args)
      : await runProcess({
          command: this.command,
          args,
          cwd,
          timeoutMs: 120_000,
        });
    if (!allowFailure && result.exitCode !== 0)
      throw new Error(
        `dv ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
      );
    return result;
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

  private async referenceRevision(
    path: string,
    reference: string,
  ): Promise<string> {
    const result = await this.dv(path, ["branch", reference], true);
    if (result.exitCode !== 0)
      throw new Error(`Diversion reference ${reference} does not exist`);
    const revision = `${result.stdout}\n${result.stderr}`.match(
      /^\s*commit\s+([^\s]+)$/m,
    )?.[1];
    if (!revision)
      throw new Error(`dv branch ${reference} did not report a revision`);
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

  private async requireClean(path: string): Promise<void> {
    const paths = await this.dirtyPaths(path);
    if (paths.length > 0)
      throw new Error(`Diversion workspace is not clean:\n${paths.join("\n")}`);
  }

  private async acquireLock(
    repository: string,
    stateDirectory: string,
    jobId: string,
  ): Promise<string> {
    const key = createHash("sha256").update(repository).digest("hex");
    const directory = resolve(stateDirectory, "locks");
    const path = join(directory, `${this.id}-${key}.json`);
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

  async openJob(
    options: Parameters<SourceControlBackend["openJob"]>[0],
  ): Promise<JobWorkspace> {
    const repository = await repositoryRoot(options.repository);
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
          ["branch", outputReference],
          true,
        );
        if (existing.exitCode === 0) {
          const revision = existing.stdout.match(
            /^\s*commit\s+([^\s]+)$/m,
          )?.[1];
          if (revision !== base)
            throw new Error(
              `existing Diversion output ${outputReference} is not pinned to ${base}`,
            );
          if (currentReference !== outputReference)
            await this.dv(repository, ["checkout", outputReference]);
        } else {
          if (currentReference !== options.config.sourceControl.base)
            await this.dv(repository, [
              "checkout",
              options.config.sourceControl.base,
            ]);
          await this.dv(repository, ["branch", "-c", outputReference]);
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

  async restoreJob(
    options: Parameters<SourceControlBackend["restoreJob"]>[0],
  ): Promise<JobWorkspace> {
    assertBackendHandle(options.handle, this.id, "restored job");
    const repository = await repositoryRoot(options.repository);
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

  async beginTask(
    workspace: JobWorkspace,
    taskKey: string,
  ): Promise<TaskWorkspace> {
    assertBackendHandle(workspace.handle, this.id, "job workspace");
    const outputReference = stringState(workspace.handle, "outputReference");
    if ((await this.currentReference(workspace.path)) !== outputReference)
      await this.dv(workspace.path, ["checkout", outputReference]);
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
      ["branch", candidateReference],
      true,
    );
    if (existing.exitCode === 0) {
      const revision = existing.stdout.match(/^\s*commit\s+([^\s]+)$/m)?.[1];
      if (revision !== baseRevision)
        throw new Error(
          `existing Diversion candidate ${candidateReference} is not pinned to ${baseRevision}`,
        );
      await this.dv(workspace.path, ["checkout", candidateReference]);
    } else await this.dv(workspace.path, ["branch", "-c", candidateReference]);
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
    const changedPaths = await this.dirtyPaths(options.task.path);
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
    if (changedPaths.length > 0)
      await this.dv(options.task.path, [
        "commit",
        "-a",
        "-m",
        `${options.taskKey}: ${options.summary.slice(0, 200)}`,
      ]);
    const ref = await this.currentRevision(options.task.path);
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
    return {
      status: "ready" as const,
      checkpoint: checkpoint(await this.currentRevision(task.path)),
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
      const paths = await this.dirtyPaths(options.task.path);
      if (paths.length > 0)
        await this.dv(options.task.path, [
          "commit",
          "-a",
          "-m",
          `${options.taskKey}: accepted [noriq job ${stringState(options.workspace.handle, "jobId")}]`,
        ]);
      const revision = await this.currentRevision(options.task.path);
      options.workspace.currentRevision = revision;
      return checkpoint(revision);
    }
    const candidateReference = stringState(
      options.task.handle,
      "candidateReference",
    );
    await this.dv(options.workspace.path, ["checkout", outputReference]);
    const outputRevision = await this.currentRevision(options.workspace.path);
    if (outputRevision !== options.workspace.currentRevision)
      throw new Error(
        `Diversion output drifted from ${options.workspace.currentRevision} to ${outputRevision}`,
      );
    await this.dv(options.workspace.path, ["merge", candidateReference]);
    const revision = await this.currentRevision(options.workspace.path);
    options.workspace.currentRevision = revision;
    return checkpoint(revision);
  }

  async preserveFailedWork(
    options: Parameters<SourceControlBackend["preserveFailedWork"]>[0],
  ) {
    assertBackendHandle(options.task.handle, this.id, "task workspace");
    const dirty = await this.dirtyPaths(options.task.path);
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
        await this.dv(options.task.path, [
          "checkout",
          stringState(options.task.handle, "outputReference"),
        ]);
        await this.dv(options.task.path, [
          "reset",
          "--hard",
          options.workspace.currentRevision,
        ]);
      }
      options.task.handle.state.preserved = true;
      return { vcs: this.kind, label: recovery, url: null };
    }
    if (dirty.length > 0)
      await this.dv(options.task.path, [
        "commit",
        "-a",
        "-m",
        `WIP ${options.taskKey}: ${options.reason.slice(0, 160)}`,
      ]);
    options.task.handle.state.preserved = true;
    const candidateReference = stringState(
      options.task.handle,
      "candidateReference",
    );
    await this.dv(options.task.path, [
      "checkout",
      stringState(options.task.handle, "outputReference"),
    ]);
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
    if (workspace.mode === "direct" || task.handle.state.preserved === true)
      return;
    const outputReference = stringState(task.handle, "outputReference");
    if ((await this.currentReference(task.path)) !== outputReference)
      await this.dv(task.path, ["checkout", outputReference]);
    await this.dv(task.path, [
      "branch",
      "-d",
      stringState(task.handle, "candidateReference"),
    ]);
  }

  async release(workspace: JobWorkspace, jobId: string): Promise<void> {
    assertBackendHandle(workspace.handle, this.id, "job workspace");
    const lockPath = stringState(workspace.handle, "lockPath");
    try {
      if ((await this.dirtyPaths(workspace.path)).length === 0) {
        const original = stringState(workspace.handle, "originalReference");
        if ((await this.currentReference(workspace.path)) !== original)
          await this.dv(workspace.path, ["checkout", original]);
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
    const lockPath = join(
      resolve(stateDirectory, "locks"),
      `${this.id}-${key}.json`,
    );
    if (!(await exists(lockPath))) return [];
    const owner = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid?: number;
      jobId?: string;
    };
    if (typeof owner.pid === "number") {
      try {
        process.kill(owner.pid, 0);
        return [];
      } catch {}
    }
    const warnings: string[] = [];
    const dirty = await this.dirtyPaths(root);
    if (dirty.length > 0) {
      const shelf = `noriq-orphan-${safeName(owner.jobId ?? "unknown")}`;
      await this.dv(root, ["shelf", "create", shelf, "."]);
      warnings.push(`preserved orphaned Diversion work in shelf ${shelf}`);
    }
    await unlink(lockPath);
    return warnings;
  }

  runCommands = runCommands;
}

/** @deprecated use DiversionSourceControlBackend */
export { DiversionSourceControlBackend as DiversionWorkspaceBackend };
