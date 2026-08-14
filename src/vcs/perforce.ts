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
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runCommands } from "../git.js";
import { runProcess } from "../process.js";
import {
  assertBackendHandle,
  type BackendHandle,
  IntegrationConflict,
  type JobWorkspace,
  type LandingResult,
  type SourceControlBackend,
  type SourceControlCheckpoint,
  type TaskWorkspace,
} from "./types.js";

const NOTHING =
  /not opened on this client|no file\(s\) to reconcile|no files to shelve/i;

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
    if (await exists(join(candidate, ".p4config"))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error(`no Perforce workspace with .p4config contains ${path}`);
}

function stringState(handle: BackendHandle, name: string): string {
  const value = handle.state[name];
  if (typeof value !== "string")
    throw new Error(`Perforce handle is missing ${name}`);
  return value;
}

function checkpoint(ref: string, label: string): SourceControlCheckpoint {
  return { ref, label, url: null };
}

interface P4Result {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type P4Cli = (
  cwd: string,
  args: string[],
  stdin?: string,
) => Promise<P4Result>;

export class PerforceSourceControlBackend implements SourceControlBackend {
  readonly kind = "perforce";
  readonly capabilities = {
    isolatedMode: true,
    directMode: true,
    parallelTaskWorkspaces: false,
    durableRecovery: true,
    automatedConflictRepair: true,
  };

  constructor(
    readonly id = "perforce",
    private readonly command = "p4",
    private readonly injectedCli?: P4Cli,
  ) {}

  private async p4(
    cwd: string,
    args: string[],
    options: {
      stdin?: string;
      allowEmpty?: boolean;
      allowFailure?: boolean;
    } = {},
  ): Promise<P4Result> {
    const result = this.injectedCli
      ? await this.injectedCli(cwd, args, options.stdin)
      : await runProcess({
          command: this.command,
          args,
          cwd,
          env: { ...process.env, PWD: cwd },
          timeoutMs: 120_000,
          ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        });
    if (
      !options.allowFailure &&
      result.exitCode !== 0 &&
      !(
        options.allowEmpty && NOTHING.test(`${result.stdout}\n${result.stderr}`)
      )
    )
      throw new Error(
        `p4 ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
      );
    return result;
  }

  discoverRepository = repositoryRoot;

  private async clientName(path: string): Promise<string> {
    const result = await this.p4(path, ["-ztag", "-F", "%clientName%", "info"]);
    const client = result.stdout.trim();
    if (!client || client === "*unknown*")
      throw new Error("Perforce has no configured client for this workspace");
    return client;
  }

  async repositoryIdentity(path: string): Promise<string> {
    const root = await repositoryRoot(path);
    const client = await this.clientName(root);
    const server = (
      await this.p4(root, ["-ztag", "-F", "%serverAddress%", "info"])
    ).stdout.trim();
    return `${server}:${client}`;
  }

  async revisionOf(path: string, reference: string): Promise<string> {
    const root = await repositoryRoot(path);
    if (/^\d+$/.test(reference)) return reference;
    const result = await this.p4(root, [
      "-ztag",
      "-F",
      "%change%",
      "changes",
      "-m1",
      "-s",
      "submitted",
      reference,
    ]);
    const revision = result.stdout.trim();
    if (!/^\d+$/.test(revision))
      throw new Error(
        `Perforce reference ${reference} did not resolve to a changelist`,
      );
    return revision;
  }

  private async validateClient(root: string): Promise<string> {
    const client = await this.clientName(root);
    const spec = (await this.p4(root, ["client", "-o", client])).stdout;
    const options = spec.match(/^Options:\s*(.+)$/m)?.[1] ?? "";
    if (!/\ballwrite\b/.test(options) || /\bnoallwrite\b/.test(options))
      throw new Error(
        `Perforce client ${client} must be configured with allwrite for writable agents`,
      );
    const mapping = await this.p4(root, [
      "-ztag",
      "-F",
      "%path%",
      "where",
      join(root, "..."),
    ]);
    const mapped = mapping.stdout.trim();
    if (!mapped || mapped.startsWith("-") || !isAbsolute(mapped))
      throw new Error(`Perforce client ${client} does not map ${root}`);
    return client;
  }

  private lockPath(repositoryIdentity: string, stateDirectory: string): string {
    const key = createHash("sha256").update(repositoryIdentity).digest("hex");
    return join(resolve(stateDirectory, "locks"), `${this.id}-${key}.json`);
  }

  private async acquireLock(
    repositoryIdentity: string,
    repository: string,
    stateDirectory: string,
    jobId: string,
  ): Promise<string> {
    const path = this.lockPath(repositoryIdentity, stateDirectory);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
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
          `Perforce workspace is locked by ${owner.jobId ?? "an unknown job"}`,
        );
    }
    return path;
  }

  private async opened(root: string, change?: string): Promise<string[]> {
    const result = await this.p4(
      root,
      [
        "-ztag",
        "-F",
        "%clientFile%",
        "opened",
        ...(change ? ["-c", change] : []),
      ],
      { allowEmpty: true },
    );
    if (NOTHING.test(`${result.stdout}\n${result.stderr}`)) return [];
    const clientFiles = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return Promise.all(
      clientFiles.map(async (clientFile) => {
        const mapping = await this.p4(root, [
          "-ztag",
          "-F",
          "%path%",
          "where",
          clientFile,
        ]);
        const localPath = mapping.stdout.trim();
        if (!localPath || localPath.startsWith("-") || !isAbsolute(localPath))
          throw new Error(`Perforce opened file ${clientFile} is not mapped`);
        const workspacePath = relative(root, localPath).replaceAll("\\", "/");
        if (
          !workspacePath ||
          workspacePath.startsWith("../") ||
          isAbsolute(workspacePath)
        )
          throw new Error(
            `Perforce opened file ${clientFile} maps outside ${root}`,
          );
        return workspacePath;
      }),
    );
  }

  private async requireClean(root: string): Promise<void> {
    const opened = await this.opened(root);
    const preview = await this.p4(root, ["reconcile", "-n", "//..."], {
      allowEmpty: true,
    });
    const pending = NOTHING.test(`${preview.stdout}\n${preview.stderr}`)
      ? []
      : preview.stdout.split(/\r?\n/).filter(Boolean);
    if (opened.length > 0 || pending.length > 0)
      throw new Error(
        `Perforce workspace is not clean:\n${[...opened, ...pending].join("\n")}`,
      );
  }

  private async cleanWorkspace(root: string): Promise<void> {
    await this.p4(root, ["clean", "-e", "-a", "-d", "//..."], {
      allowEmpty: true,
    });
  }

  async openJob(
    options: Parameters<SourceControlBackend["openJob"]>[0],
  ): Promise<JobWorkspace> {
    const root = await repositoryRoot(options.repository);
    const client = await this.validateClient(root);
    const identity = await this.repositoryIdentity(root);
    const lockPath = await this.acquireLock(
      identity,
      root,
      options.stateDirectory,
      options.jobId,
    );
    try {
      await this.requireClean(root);
      const base = await this.revisionOf(
        root,
        options.config.sourceControl.base,
      );
      if (base !== options.expectedBaseRevision)
        throw new Error(
          `base revision changed: expected ${options.expectedBaseRevision}, found ${base}`,
        );
      await this.p4(root, ["sync", `@=${base}`]);
      return {
        handle: {
          backend: this.id,
          version: 1,
          state: { client, lockPath, jobId: options.jobId },
        },
        vcs: this.kind,
        mode: options.config.sourceControl.mode,
        repositoryIdentity: identity,
        path: root,
        baseRevision: base,
        currentRevision: base,
        retainedLocation: {
          vcs: this.kind,
          label:
            options.config.sourceControl.mode === "direct"
              ? `${client} submitted changes`
              : `${client} cumulative shelves`,
          url: null,
        },
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
    const root = await repositoryRoot(options.repository);
    const client = await this.validateClient(root);
    if (client !== stringState(options.handle, "client"))
      throw new Error(
        `Perforce restored job belongs to client ${stringState(options.handle, "client")}`,
      );
    const identity = await this.repositoryIdentity(root);
    options.handle.state.lockPath = await this.acquireLock(
      identity,
      root,
      options.stateDirectory,
      options.jobId,
    );
    return {
      handle: options.handle,
      vcs: this.kind,
      mode: options.mode,
      repositoryIdentity: identity,
      path: root,
      baseRevision: options.baseRevision,
      currentRevision: options.currentRevision,
      retainedLocation: {
        vcs: this.kind,
        label:
          options.mode === "direct"
            ? `${client} submitted changes`
            : `${client} cumulative shelves`,
        url: null,
      },
    };
  }

  private async createChange(
    root: string,
    description: string,
  ): Promise<string> {
    const result = await this.p4(root, ["change", "-i"], {
      stdin: `Change: new\n\nDescription:\n\t${description.replaceAll("\n", " ")}\n`,
    });
    const change = `${result.stdout}\n${result.stderr}`.match(
      /Change\s+(\d+)\s+created/i,
    )?.[1];
    if (!change)
      throw new Error("p4 change -i did not report a numbered changelist");
    return change;
  }

  private async changeSpec(root: string, change: string): Promise<string> {
    return (
      await this.p4(root, ["change", "-o", change], { allowFailure: true })
    ).stdout;
  }

  private async submittedChange(
    root: string,
    change: string,
  ): Promise<boolean> {
    return /^Status:\s*submitted\s*$/im.test(
      await this.changeSpec(root, change),
    );
  }

  async beginTask(
    workspace: JobWorkspace,
    taskKey: string,
  ): Promise<TaskWorkspace> {
    assertBackendHandle(workspace.handle, this.id, "job workspace");
    const jobId = stringState(workspace.handle, "jobId");
    const lockOwner = JSON.parse(
      await readFile(stringState(workspace.handle, "lockPath"), "utf8"),
    ) as { change?: string };
    let change: string;
    if (lockOwner.change) {
      const spec = await this.changeSpec(workspace.path, lockOwner.change);
      if (
        /^Status:\s*pending\s*$/im.test(spec) &&
        spec.includes(`[noriq job ${jobId}] task ${taskKey}`)
      )
        change = lockOwner.change;
      else
        change = await this.createChange(
          workspace.path,
          `[noriq job ${jobId}] task ${taskKey}`,
        );
    } else
      change = await this.createChange(
        workspace.path,
        `[noriq job ${jobId}] task ${taskKey}`,
      );
    const prior = workspace.handle.state.activeChange;
    if (workspace.mode === "isolated" && typeof prior === "string") {
      const priorOpened = await this.opened(workspace.path, prior);
      if (priorOpened.length > 0)
        await this.p4(workspace.path, ["reopen", "-c", change, "//..."]);
    }
    workspace.handle.state.activeChange = change;
    await writeFile(
      stringState(workspace.handle, "lockPath"),
      JSON.stringify({
        backend: this.id,
        jobId,
        repository: workspace.path,
        pid: process.pid,
        change,
      }),
      { mode: 0o600 },
    );
    return {
      handle: {
        backend: this.id,
        version: 1,
        state: { change, client: stringState(workspace.handle, "client") },
      },
      path: workspace.path,
      baseRevision: workspace.currentRevision,
    };
  }

  async stageCandidate(
    options: Parameters<SourceControlBackend["stageCandidate"]>[0],
  ) {
    assertBackendHandle(options.task.handle, this.id, "task workspace");
    const change = stringState(options.task.handle, "change");
    if (await this.submittedChange(options.task.path, change))
      return {
        status: "ready" as const,
        checkpoint: checkpoint(change, `submitted change ${change}`),
        changedPaths: [],
        backendState: options.task.handle,
      };
    await this.p4(options.task.path, ["reconcile", "-c", change, "//..."], {
      allowEmpty: true,
    });
    const changedPaths = await this.opened(options.task.path, change);
    if (changedPaths.length === 0) {
      options.task.handle.state.noOp = true;
      return {
        status: "ready" as const,
        checkpoint: checkpoint(options.workspace.currentRevision, "no-op"),
        changedPaths,
        backendState: options.task.handle,
      };
    }
    await this.p4(options.task.path, ["shelve", "-f", "-c", change]);
    options.task.handle.state.shelved = true;
    return {
      status: "ready" as const,
      checkpoint: checkpoint(change, `shelf ${change}`),
      changedPaths,
      backendState: options.task.handle,
    };
  }

  async integrateLatest(_workspace: JobWorkspace, task: TaskWorkspace) {
    assertBackendHandle(task.handle, this.id, "task workspace");
    const change = stringState(task.handle, "change");
    if (await this.submittedChange(task.path, change)) return null;
    const sync = await this.p4(task.path, ["sync"], { allowFailure: true });
    const resolveResult = await this.p4(
      task.path,
      ["resolve", "-am", "-c", change],
      {
        allowEmpty: true,
        allowFailure: true,
      },
    );
    const detail = `${sync.stdout}\n${sync.stderr}\n${resolveResult.stdout}\n${resolveResult.stderr}`;
    if (
      sync.exitCode !== 0 ||
      resolveResult.exitCode !== 0 ||
      /resolve|conflict/i.test(detail)
    ) {
      const unresolved = await this.p4(
        task.path,
        ["resolve", "-n", "-c", change],
        {
          allowEmpty: true,
          allowFailure: true,
        },
      );
      const paths = unresolved.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      return {
        status: "conflict" as const,
        paths,
        detail: detail.trim(),
        backendState: task.handle,
      };
    }
    return null;
  }

  async continueConflict(task: TaskWorkspace): Promise<void> {
    assertBackendHandle(task.handle, this.id, "task workspace");
    await this.p4(task.path, [
      "resolve",
      "-ay",
      "-c",
      stringState(task.handle, "change"),
    ]);
  }
  async abortConflict(task: TaskWorkspace): Promise<void> {
    assertBackendHandle(task.handle, this.id, "task workspace");
    await this.p4(
      task.path,
      ["revert", "-a", "-c", stringState(task.handle, "change"), "//..."],
      {
        allowEmpty: true,
      },
    );
  }

  async reviewDiff(
    _workspace: JobWorkspace,
    task: TaskWorkspace,
  ): Promise<string> {
    assertBackendHandle(task.handle, this.id, "task workspace");
    if (task.handle.state.noOp === true) return "";
    const change = stringState(task.handle, "change");
    if (await this.submittedChange(task.path, change))
      return (await this.p4(task.path, ["describe", "-du", change])).stdout;
    return (await this.p4(task.path, ["describe", "-S", "-du", change])).stdout;
  }

  async acceptCandidate(
    options: Parameters<SourceControlBackend["acceptCandidate"]>[0],
  ): Promise<SourceControlCheckpoint> {
    assertBackendHandle(options.task.handle, this.id, "task workspace");
    if (options.task.handle.state.noOp === true)
      return checkpoint(options.workspace.currentRevision, "no-op");
    const change = stringState(options.task.handle, "change");
    if (options.workspace.mode === "isolated") {
      options.workspace.currentRevision = change;
      return checkpoint(change, `shelf ${change}`);
    }
    const existing = await this.changeSpec(options.task.path, change);
    if (/^Status:\s*submitted\s*$/im.test(existing)) {
      if (
        !existing.includes(
          `[noriq job ${stringState(options.workspace.handle, "jobId")}]`,
        )
      )
        throw new Error(
          `submitted changelist ${change} is not owned by this RunnerJob`,
        );
      options.workspace.currentRevision = change;
      return checkpoint(change, `submitted change ${change}`);
    }
    const submit = await this.p4(options.task.path, ["submit", "-c", change], {
      allowFailure: true,
    });
    if (submit.exitCode !== 0) {
      const detail = `${submit.stdout}\n${submit.stderr}`.trim();
      if (/out of date|must resolve|resolve/i.test(detail))
        throw new IntegrationConflict(
          "Perforce submit requires reintegration",
          detail,
          await this.opened(options.task.path, change),
        );
      throw new Error(`p4 submit -c ${change} failed: ${detail}`);
    }
    const submitted =
      `${submit.stdout}\n${submit.stderr}`.match(
        /Change\s+(\d+)\s+submitted/i,
      )?.[1] ?? change;
    options.workspace.currentRevision = submitted;
    return checkpoint(submitted, `submitted change ${submitted}`);
  }

  async land(
    options: Parameters<SourceControlBackend["land"]>[0],
  ): Promise<LandingResult> {
    assertBackendHandle(options.workspace.handle, this.id, "landing workspace");
    if (
      options.workspace.mode === "direct" ||
      options.workspace.currentRevision === options.workspace.baseRevision
    )
      return {
        target: options.target,
        checkpoint: checkpoint(
          options.workspace.currentRevision,
          options.workspace.mode === "direct"
            ? `submitted change ${options.workspace.currentRevision}`
            : "no-op",
        ),
      };
    const root = await repositoryRoot(options.repository);
    const identity = await this.repositoryIdentity(root);
    const change = options.workspace.currentRevision;
    if (!/^\d+$/.test(change))
      throw new Error(
        `retained Perforce output ${change} is not a numbered shelf`,
      );
    const accepted = Object.values(options.acceptedTaskCheckpoints).some(
      (candidate) => candidate.ref === change,
    );
    if (!accepted)
      throw new Error(
        `retained Perforce shelf ${change} is not an accepted task checkpoint`,
      );
    const existing = await this.changeSpec(root, change);
    if (/^Status:\s*submitted\s*$/im.test(existing)) {
      if (!existing.includes(`[noriq job ${options.jobId}]`))
        throw new Error(
          `submitted changelist ${change} is not owned by this RunnerJob`,
        );
      return {
        target: options.target,
        checkpoint: checkpoint(change, `submitted change ${change}`),
      };
    }
    if (!/^Status:\s*pending\s*$/im.test(existing))
      throw new Error(`Perforce shelf ${change} is no longer pending`);
    if (!existing.includes(`[noriq job ${options.jobId}]`))
      throw new Error(
        `Perforce shelf ${change} is not owned by this RunnerJob`,
      );

    const lockPath = await this.acquireLock(
      identity,
      root,
      options.stateDirectory,
      options.jobId,
    );
    await writeFile(
      lockPath,
      JSON.stringify({
        backend: this.id,
        operation: "landing",
        jobId: options.jobId,
        repository: root,
        pid: process.pid,
        change,
      }),
      { mode: 0o600 },
    );
    let submitted = false;
    try {
      await this.requireClean(root);
      await this.p4(root, ["sync", options.target]);
      const unshelve = await this.p4(
        root,
        ["unshelve", "-s", change, "-c", change],
        { allowFailure: true },
      );
      if (unshelve.exitCode !== 0)
        throw new Error(
          `p4 unshelve -s ${change} failed: ${unshelve.stderr || unshelve.stdout}`,
        );
      const resolveResult = await this.p4(
        root,
        ["resolve", "-am", "-c", change],
        { allowEmpty: true, allowFailure: true },
      );
      const detail = `${resolveResult.stdout}\n${resolveResult.stderr}`.trim();
      if (resolveResult.exitCode !== 0 || /must resolve|conflict/i.test(detail))
        throw new IntegrationConflict(
          "Perforce landing requires conflict repair",
          detail,
          await this.opened(root, change),
        );
      const submit = await this.p4(root, ["submit", "-c", change], {
        allowFailure: true,
      });
      if (submit.exitCode !== 0) {
        const submitDetail = `${submit.stdout}\n${submit.stderr}`.trim();
        if (/out of date|must resolve|resolve/i.test(submitDetail))
          throw new IntegrationConflict(
            "Perforce landing requires reintegration",
            submitDetail,
            await this.opened(root, change),
          );
        throw new Error(`p4 submit -c ${change} failed: ${submitDetail}`);
      }
      submitted = true;
      const submittedChange =
        `${submit.stdout}\n${submit.stderr}`.match(
          /Change\s+(\d+)\s+submitted/i,
        )?.[1] ?? change;
      return {
        target: options.target,
        checkpoint: checkpoint(
          submittedChange,
          `submitted change ${submittedChange}`,
        ),
      };
    } finally {
      if (!submitted)
        await this.p4(root, ["revert", "-c", change, "//..."], {
          allowEmpty: true,
          allowFailure: true,
        });
      if (!submitted) await this.cleanWorkspace(root);
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
    const change = stringState(options.task.handle, "change");
    await this.p4(options.task.path, ["reconcile", "-c", change, "//..."], {
      allowEmpty: true,
    });
    const paths = await this.opened(options.task.path, change);
    if (paths.length === 0) return null;
    await this.p4(options.task.path, ["shelve", "-f", "-c", change]);
    await this.p4(options.task.path, ["revert", "-c", change, "//..."]);
    await this.cleanWorkspace(options.task.path);
    options.task.handle.state.preserved = true;
    return { vcs: this.kind, label: `shelf ${change}`, url: null };
  }

  async inspect(workspace: JobWorkspace) {
    assertBackendHandle(workspace.handle, this.id, "job workspace");
    return {
      revision: workspace.currentRevision,
      dirtyPaths: await this.opened(workspace.path),
      retainedLocation: workspace.retainedLocation,
    };
  }
  async inspectTask(task: TaskWorkspace) {
    assertBackendHandle(task.handle, this.id, "task workspace");
    const change = stringState(task.handle, "change");
    return {
      revision: change,
      dirtyPaths: await this.opened(task.path, change),
      retainedLocation: { vcs: this.kind, label: `shelf ${change}`, url: null },
    };
  }

  async releaseTask(): Promise<void> {}

  async release(workspace: JobWorkspace, jobId: string): Promise<void> {
    assertBackendHandle(workspace.handle, this.id, "job workspace");
    const active = workspace.handle.state.activeChange;
    if (
      typeof active === "string" &&
      (await this.opened(workspace.path, active)).length > 0
    )
      await this.p4(workspace.path, ["revert", "-c", active, "//..."], {
        allowEmpty: true,
      });
    await this.cleanWorkspace(workspace.path);
    const lockPath = stringState(workspace.handle, "lockPath");
    try {
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
    const identity = await this.repositoryIdentity(root);
    const path = this.lockPath(identity, stateDirectory);
    if (!(await exists(path))) return [];
    const owner = JSON.parse(await readFile(path, "utf8")) as {
      pid?: number;
      change?: string;
      jobId?: string;
    };
    if (typeof owner.pid === "number") {
      try {
        process.kill(owner.pid, 0);
        return [];
      } catch {}
    }
    const warnings: string[] = [];
    if (owner.change) {
      const paths = await this.opened(root, owner.change);
      if (paths.length > 0) {
        await this.p4(root, ["shelve", "-f", "-c", owner.change]);
        await this.p4(root, ["revert", "-c", owner.change, "//..."]);
        await this.cleanWorkspace(root);
        warnings.push(
          `preserved orphaned Perforce work in shelf ${owner.change}`,
        );
      }
    }
    await unlink(path);
    return warnings;
  }

  runCommands = runCommands;
}
