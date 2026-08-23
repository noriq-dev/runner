import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { projectConfigSchema } from "../src/config.js";
import { runProcess } from "../src/process.js";
import { DiversionSourceControlBackend } from "../src/vcs/diversion.js";
import { GitSourceControlBackend } from "../src/vcs/git.js";
import {
  type P4Cli,
  PerforceSourceControlBackend,
} from "../src/vcs/perforce.js";

async function command(
  cwd: string,
  executable: string,
  args: string[],
): Promise<string> {
  const result = await runProcess({
    command: executable,
    args,
    cwd,
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function project(kind: "isolated" | "direct", base: string) {
  return projectConfigSchema.parse({
    key: "RUN",
    repositoryKey: "repo",
    defaultBranch: "main",
    sourceControl: {
      backend: "auto",
      mode: kind,
      base: kind === "isolated" ? base : base,
      ...(kind === "direct" ? { target: "main" } : {}),
    },
    harness: { maxParallelTasks: 4, maxRepairRounds: 2, maxJobMinutes: 5 },
    agents: {
      guide: { driver: "fake", model: "guide", effort: "high" },
      builder: { driver: "fake", model: "builder", effort: "medium" },
      reviewer: { driver: "fake", model: "reviewer", effort: "high" },
    },
    setup: { commands: [], timeoutSeconds: 30 },
    checks: { commands: [], timeoutSeconds: 30 },
  });
}

function diversionFake() {
  const revisions = new Map<string, string>([["main", "dv-100"]]);
  let current = "main";
  let dirty = false;
  let sequence = 100;
  let staleRevision: { reference: string; revision: string } | undefined;
  const shelves: string[] = [];
  const calls: string[] = [];
  const cli = async (_cwd: string, args: string[]) => {
    calls.push(args.join(" "));
    const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
    if (args[0] === "branch-name") return ok(`${current}\n`);
    if (args[0] === "status" && args[1] === "--commit-id-only") {
      if (staleRevision?.reference === current) {
        const revision = staleRevision.revision;
        staleRevision = undefined;
        return ok(`${revision}\n`);
      }
      return ok(`${revisions.get(current)}\n`);
    }
    if (args[0] === "branch" && args[1] === "-c") {
      revisions.set(args[2]!, revisions.get(current)!);
      current = args[2]!;
      return ok();
    }
    if (args[0] === "branch" && args[1] === "-d") {
      revisions.delete(args[2]!);
      return ok();
    }
    if (args[0] === "show") {
      const revision = revisions.get(args[1]!);
      return revision
        ? ok(`commit ${revision}\n`)
        : { exitCode: 1, stdout: "", stderr: "not found" };
    }
    if (args[0] === "checkout") {
      current = args[1]!;
      return ok();
    }
    if (args[0] === "diff" && args[1] === "--name-status")
      return ok(dirty ? "M\tfeature.txt\n" : "");
    if (args[0] === "diff") return ok("diff -- feature.txt\n");
    if (args[0] === "commit") {
      staleRevision = { reference: current, revision: revisions.get(current)! };
      sequence += 1;
      revisions.set(current, `dv-${sequence}`);
      dirty = false;
      return ok(`New commit ID: dv-${sequence}\n`);
    }
    if (args[0] === "merge" && args[1] !== "--abort") {
      staleRevision = { reference: current, revision: revisions.get(current)! };
      sequence += 1;
      revisions.set(current, `dv-${sequence}`);
      return ok(`Commit ID: dv-${sequence}\n`);
    }
    if (args[0] === "shelf" && args[1] === "create") {
      shelves.push(args[2]!);
      dirty = false;
      return ok();
    }
    if (args[0] === "reset") return ok();
    return ok();
  };
  return {
    cli,
    calls,
    revisions,
    shelves,
    edit: () => {
      dirty = true;
    },
  };
}

/**
 * Unlike diversionFake, this models MANY workspaces: branch state is per
 * directory, and `clone` materialises a real directory with a `.diversion`
 * marker. A single-`current`-pointer fake cannot tell a per-task workspace
 * apart from an in-place checkout, which is the whole point of these tests.
 */
function diversionWorkspaceFake(source: string) {
  const repoId = "dv.repo.11111111-2222-3333-4444-555555555555";
  const revisions = new Map<string, string>([["main", "dv-100"]]);
  const workspaces = new Map<string, { branch: string; dirty: boolean }>([
    [source, { branch: "main", dirty: false }],
  ]);
  const deleted: string[] = [];
  const calls: string[] = [];
  let sequence = 100;
  let workspaceSequence = 0;
  let refuseDelete = false;

  const at = (cwd: string) => {
    const entry = workspaces.get(cwd);
    if (!entry) throw new Error(`fake: no Diversion workspace at ${cwd}`);
    return entry;
  };

  const cli = async (cwd: string, args: string[]) => {
    calls.push(`${cwd} :: ${args.join(" ")}`);
    const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
    const fail = (stderr: string) => ({ exitCode: 1, stdout: "", stderr });
    if (args[0] === "repo")
      return ok(`Cloned Locally:\nfixture (${repoId})(${source})\n\nOther:\n`);
    if (args[0] === "clone") {
      const path = args[2]!;
      const reference = args[5]!;
      if (args[1] !== repoId) return fail(`unknown repo ${args[1]}`);
      if (!revisions.has(reference)) return fail(`unknown ref ${reference}`);
      workspaceSequence += 1;
      await mkdir(join(path, ".diversion"), { recursive: true });
      await writeFile(
        join(path, ".diversion", `dv.ws.fake-${workspaceSequence}`),
        "",
      );
      workspaces.set(path, { branch: reference, dirty: false });
      return ok();
    }
    if (args[0] === "workspace" && args[1] === "delete") {
      if (refuseDelete) return fail("workspace is busy");
      deleted.push(args[2]!);
      workspaces.delete(cwd);
      return ok();
    }
    if (args[0] === "branch-name") return ok(`${at(cwd).branch}\n`);
    if (args[0] === "status" && args[1] === "--commit-id-only")
      return ok(`${revisions.get(at(cwd).branch)}\n`);
    if (args[0] === "branch" && args[1] === "-c") {
      const name = args[2]!;
      revisions.set(name, revisions.get(at(cwd).branch)!);
      at(cwd).branch = name;
      return ok();
    }
    if (args[0] === "branch" && args[1] === "-d") {
      revisions.delete(args[2]!);
      return ok();
    }
    if (args[0] === "show") {
      const revision = revisions.get(args[1]!);
      return revision ? ok(`commit ${revision}\n`) : fail("not found");
    }
    if (args[0] === "checkout") {
      if (!revisions.has(args[1]!)) return fail(`unknown ref ${args[1]}`);
      at(cwd).branch = args[1]!;
      return ok();
    }
    if (args[0] === "diff" && args[1] === "--name-status")
      return ok(at(cwd).dirty ? "M\tfeature.txt\n" : "");
    if (args[0] === "diff") return ok("diff -- feature.txt\n");
    if (args[0] === "commit") {
      sequence += 1;
      revisions.set(at(cwd).branch, `dv-${sequence}`);
      at(cwd).dirty = false;
      return ok(`New commit ID: dv-${sequence}\n`);
    }
    if (args[0] === "merge" && args[1] !== "--abort") {
      sequence += 1;
      revisions.set(at(cwd).branch, `dv-${sequence}`);
      return ok(`Commit ID: dv-${sequence}\n`);
    }
    return ok();
  };

  return {
    cli,
    calls,
    revisions,
    deleted,
    workspaces,
    branchAt: (path: string) => workspaces.get(path)?.branch ?? null,
    edit: (path: string) => {
      at(path).dirty = true;
    },
    refuseDeletion: (value: boolean) => {
      refuseDelete = value;
    },
  };
}

function perforceFake(root: string) {
  let nextChange = 100;
  let hasEdits = false;
  const opened = new Map<string, string[]>();
  const shelves: string[] = [];
  const submitted: string[] = [];
  const descriptions = new Map<string, string>();
  const calls: string[] = [];
  const cli: P4Cli = async (_cwd, args, stdin) => {
    calls.push(args.join(" "));
    const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
    if (args.includes("info") && args.includes("%clientName%"))
      return ok("client-test\n");
    if (args.includes("info") && args.includes("%serverAddress%"))
      return ok("p4:1666\n");
    if (args[0] === "client" && args[1] === "-o")
      return ok(
        "Client: client-test\nOptions: allwrite noclobber nocompress unlocked nomodtime normdir\n",
      );
    if (args.includes("where")) {
      const filespec = args.at(-1)!;
      if (filespec.startsWith("//client-test/"))
        return ok(`${join(root, filespec.slice("//client-test/".length))}\n`);
      return ok(`${join(root, "...")}\n`);
    }
    if (args.includes("changes")) return ok("100\n");
    if (args[0] === "change" && args[1] === "-i") {
      nextChange += 1;
      descriptions.set(String(nextChange), stdin ?? "");
      return ok(`Change ${nextChange} created.\n`);
    }
    if (args[0] === "change" && args[1] === "-o") {
      const change = args[2]!;
      return ok(
        `Change: ${change}\nStatus: ${submitted.includes(change) ? "submitted" : "pending"}\nDescription:\n${descriptions.get(change) ?? ""}\n`,
      );
    }
    if (args.includes("opened")) {
      const changeIndex = args.indexOf("-c");
      const paths =
        changeIndex >= 0
          ? (opened.get(args[changeIndex + 1]!) ?? [])
          : [...opened.values()].flat();
      return paths.length
        ? ok(
            `${paths
              .map(
                (path) =>
                  `//client-test/${relative(root, path).replaceAll("\\", "/")}`,
              )
              .join("\n")}\n`,
          )
        : {
            exitCode: 1,
            stdout: "",
            stderr: "File(s) not opened on this client.",
          };
    }
    if (args[0] === "reconcile" && args.includes("-n"))
      return hasEdits
        ? ok("feature.txt - reconcile\n")
        : { exitCode: 1, stdout: "", stderr: "No file(s) to reconcile." };
    if (args[0] === "reconcile") {
      const change = args[args.indexOf("-c") + 1]!;
      if (hasEdits) opened.set(change, [join(root, "feature.txt")]);
      hasEdits = false;
      return ok();
    }
    if (args[0] === "reopen") {
      const change = args[args.indexOf("-c") + 1]!;
      const prior = [...opened.values()].flat();
      opened.clear();
      opened.set(change, prior);
      return ok();
    }
    if (args[0] === "shelve") {
      const change = args[args.indexOf("-c") + 1]!;
      if (args.includes("-d")) {
        const index = shelves.indexOf(change);
        if (index >= 0) shelves.splice(index, 1);
        return ok();
      }
      shelves.push(change);
      return ok();
    }
    if (args[0] === "describe")
      return ok("==== //depot/feature.txt ====\n+change\n");
    if (args[0] === "submit") {
      const change = args[args.indexOf("-c") + 1]!;
      submitted.push(change);
      opened.delete(change);
      return ok(`Change ${change} submitted.\n`);
    }
    if (args[0] === "revert") {
      opened.delete(args[args.indexOf("-c") + 1]!);
      return ok();
    }
    return ok();
  };
  return {
    cli,
    calls,
    shelves,
    submitted,
    edit: () => {
      hasEdits = true;
    },
  };
}

describe("source-control backend contract", () => {
  it("defaults to retained output and requires explicit safe landing targets", () => {
    expect(project("isolated", "main").sourceControl.landing).toBe("retain");
    expect(() =>
      projectConfigSchema.parse({
        key: "RUN",
        repositoryKey: "repo",
        defaultBranch: "main",
        sourceControl: {
          backend: "git",
          mode: "isolated",
          base: "main",
          landing: "manual",
        },
        harness: {
          maxParallelTasks: 1,
          maxRepairRounds: 1,
          maxJobMinutes: 5,
        },
        agents: {
          guide: { driver: "fake", model: "guide", effort: "high" },
          builder: { driver: "fake", model: "builder", effort: "medium" },
          reviewer: { driver: "fake", model: "reviewer", effort: "high" },
        },
        setup: { commands: [], timeoutSeconds: 30 },
        checks: { commands: [], timeoutSeconds: 30 },
      }),
    ).toThrow(/target is required/);
  });

  it("rejects deferred landing policies in direct mode", () => {
    for (const landing of ["manual", "auto"] as const) {
      expect(() =>
        projectConfigSchema.parse({
          key: "RUN",
          repositoryKey: "repo",
          defaultBranch: "main",
          sourceControl: {
            backend: "git",
            mode: "direct",
            base: "main",
            target: "main",
            landing,
          },
          harness: {
            maxParallelTasks: 1,
            maxRepairRounds: 1,
            maxJobMinutes: 5,
          },
          agents: {
            guide: { driver: "fake", model: "guide", effort: "high" },
            builder: { driver: "fake", model: "builder", effort: "medium" },
            reviewer: { driver: "fake", model: "reviewer", effort: "high" },
          },
          setup: { commands: [], timeoutSeconds: 30 },
          checks: { commands: [], timeoutSeconds: 30 },
        }),
      ).toThrow(
        /sourceControl\.landing must be retain in direct mode because accepted work is already committed to the target/,
      );
    }
  });

  it("keeps an isolated Git no-op off the review diff and creates the first repair commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-git-no-op-"));
    const repository = join(root, "repository");
    await mkdir(repository);
    await command(repository, "git", ["init", "-b", "main"]);
    await command(repository, "git", [
      "config",
      "user.email",
      "runner@example.test",
    ]);
    await command(repository, "git", ["config", "user.name", "Runner Test"]);
    await writeFile(join(repository, "README.md"), "base\n");
    await command(repository, "git", ["add", "."]);
    await command(repository, "git", ["commit", "-m", "base"]);
    const base = await command(repository, "git", ["rev-parse", "HEAD"]);
    const backend = new GitSourceControlBackend("git-test");
    const workspace = await backend.openJob({
      repository,
      stateDirectory: join(root, "state"),
      jobId: "git-no-op",
      key: "RUN-5",
      kind: "task",
      expectedBaseRevision: base,
      config: project("isolated", "main"),
    });
    const task = await backend.beginTask(workspace, "RUN-5");
    const priorTask = await backend.beginTask(workspace, "RUN-4");

    const noOp = await backend.stageCandidate({
      workspace,
      task,
      taskKey: "RUN-5",
      summary: "builder was blocked",
      refresh: false,
    });
    if (noOp.status !== "ready") throw new Error("candidate not ready");
    expect(noOp.checkpoint).toMatchObject({ ref: base, label: "no-op" });
    expect(task.handle.state.candidateCreated).toBe(false);
    expect(await backend.reviewDiff(workspace, task, noOp.checkpoint)).toBe("");

    await writeFile(join(priorTask.path, "prior.txt"), "prior\n");
    const prior = await backend.stageCandidate({
      workspace,
      task: priorTask,
      taskKey: "RUN-4",
      summary: "created prior plan output",
      refresh: false,
    });
    if (prior.status !== "ready") throw new Error("candidate not ready");
    const acceptedPrior = await backend.acceptCandidate({
      workspace,
      task: priorTask,
      candidate: prior.checkpoint,
      taskKey: "RUN-4",
    });
    const integrated = await backend.integrateLatest(workspace, task);
    if (integrated?.status !== "ready")
      throw new Error("no-op task did not integrate");
    expect(integrated.checkpoint.ref).toBe(acceptedPrior.ref);
    expect(task.handle.state.candidateCreated).toBe(false);
    expect(
      await backend.reviewDiff(workspace, task, integrated.checkpoint),
    ).toBe("");

    await writeFile(join(task.path, "repaired.txt"), "repaired\n");
    const repaired = await backend.stageCandidate({
      workspace,
      task,
      taskKey: "RUN-5",
      summary: "created repaired output",
      refresh: true,
    });
    if (repaired.status !== "ready") throw new Error("candidate not ready");
    expect(repaired.checkpoint.ref).not.toBe(base);
    expect(task.handle.state.candidateCreated).toBe(true);
    expect(
      await command(task.path, "git", [
        "rev-parse",
        `${repaired.checkpoint.ref}^`,
      ]),
    ).toBe(acceptedPrior.ref);
    expect(
      await command(task.path, "git", [
        "log",
        "-1",
        "--format=%B",
        repaired.checkpoint.ref,
      ]),
    ).toContain("RUN-5: created repaired output");
    expect(
      await backend.reviewDiff(workspace, task, repaired.checkpoint),
    ).toContain("repaired.txt");

    await backend.releaseTask(workspace, priorTask);
    await backend.releaseTask(workspace, task);
    await backend.release(workspace, "git-no-op");
  });

  it("keeps Diversion candidates off the accepted output until acceptance", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-diversion-contract-"));
    await mkdir(join(root, ".diversion"));
    const fake = diversionFake();
    const backend = new DiversionSourceControlBackend(
      "dv-test",
      "dv",
      fake.cli,
    );
    const workspace = await backend.openJob({
      repository: root,
      stateDirectory: join(root, "state"),
      jobId: "job",
      key: "RUN-1",
      kind: "task",
      expectedBaseRevision: "dv-100",
      config: project("isolated", "main"),
    });
    const outputReference = workspace.retainedLocation.label;
    const task = await backend.beginTask(workspace, "RUN-1");
    const recoveredTask = await backend.beginTask(workspace, "RUN-1");
    expect(recoveredTask.handle).toEqual(task.handle);
    fake.edit();
    const staged = await backend.stageCandidate({
      workspace,
      task,
      taskKey: "RUN-1",
      summary: "candidate",
      refresh: false,
    });
    expect(staged.status).toBe("ready");
    expect(staged.status === "ready" && staged.checkpoint.ref).toBe("dv-101");
    expect(fake.calls).toContain("commit -a --no-verify -m RUN-1: candidate");
    expect(fake.revisions.get(outputReference)).toBe("dv-100");
    if (staged.status !== "ready") throw new Error("candidate not ready");
    const accepted = await backend.acceptCandidate({
      workspace,
      task,
      candidate: staged.checkpoint,
      taskKey: "RUN-1",
    });
    expect(accepted.ref).not.toBe("dv-100");
    expect(accepted.ref).toBe("dv-102");
    expect(backend.capabilities.parallelTaskWorkspaces).toBe(false);
    const foreign = structuredClone(task);
    foreign.handle.backend = "git";
    await expect(backend.inspectTask(foreign)).rejects.toThrow(/refuses/);
    await backend.releaseTask(workspace, task);
    expect(fake.calls).toContain(
      `branch -d ${outputReference}/candidate-run-1 -f`,
    );
    await backend.release(workspace, "job");
    const landed = await backend.land({
      repository: root,
      stateDirectory: join(root, "state"),
      jobId: "job",
      workspace,
      target: "main",
      acceptedTaskCheckpoints: { task: accepted },
    });
    expect(landed).toMatchObject({
      target: "main",
      checkpoint: { ref: "dv-103", label: "main" },
    });
    expect(fake.revisions.get("main")).toBe("dv-103");
  });

  it("gives every Diversion task its own workspace under per-task isolation", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-diversion-per-task-"));
    await mkdir(join(root, "checkout", ".diversion"), { recursive: true });
    const source = await realpath(join(root, "checkout"));
    await writeFile(join(source, ".diversion", "dv.ws.source"), "");
    const fake = diversionWorkspaceFake(source);
    const backend = new DiversionSourceControlBackend(
      "dv-test",
      "dv",
      fake.cli,
      "per-task",
    );
    expect(backend.capabilities.parallelTaskWorkspaces).toBe(true);

    const workspace = await backend.openJob({
      repository: source,
      stateDirectory: join(root, "state"),
      jobId: "job",
      key: "RUN-1",
      kind: "task",
      expectedBaseRevision: "dv-100",
      config: project("isolated", "main"),
    });
    const outputReference = workspace.retainedLocation.label;

    // The job works in a clone, and the human's checkout never moved.
    expect(workspace.path).not.toBe(source);
    expect(fake.branchAt(workspace.path)).toBe(outputReference);
    expect(fake.branchAt(source)).toBe("main");

    // Two tasks, two real working copies on disk.
    const first = await backend.beginTask(workspace, "RUN-1");
    const second = await backend.beginTask(workspace, "RUN-2");
    expect(first.path).not.toBe(second.path);
    expect(first.path).not.toBe(workspace.path);
    expect(fake.branchAt(first.path)).toBe(
      `${outputReference}/candidate-run-1`,
    );
    expect(fake.branchAt(second.path)).toBe(
      `${outputReference}/candidate-run-2`,
    );
    expect(fake.branchAt(source)).toBe("main");

    // Each task commits into its own workspace without disturbing the other.
    fake.edit(first.path);
    const staged = await backend.stageCandidate({
      workspace,
      task: first,
      taskKey: "RUN-1",
      summary: "candidate",
      refresh: false,
    });
    if (staged.status !== "ready") throw new Error("candidate not ready");
    expect(fake.revisions.get(outputReference)).toBe("dv-100");
    expect(fake.revisions.get(`${outputReference}/candidate-run-2`)).toBe(
      "dv-100",
    );

    const accepted = await backend.acceptCandidate({
      workspace,
      task: first,
      candidate: staged.checkpoint,
      taskKey: "RUN-1",
    });
    expect(fake.revisions.get(outputReference)).toBe(accepted.ref);
    expect(fake.branchAt(source)).toBe("main");

    // Teardown deregisters the cloned workspaces rather than leaking them.
    await backend.releaseTask(workspace, first);
    await backend.releaseTask(workspace, second);
    expect(fake.workspaces.has(first.path)).toBe(false);
    expect(fake.workspaces.has(second.path)).toBe(false);
    expect(fake.deleted).toHaveLength(2);

    await backend.release(workspace, "job");
    expect(fake.workspaces.has(workspace.path)).toBe(false);

    // Landing survives the job workspace being gone: it provisions its own.
    const landed = await backend.land({
      repository: source,
      stateDirectory: join(root, "state"),
      jobId: "job",
      workspace,
      target: "main",
      acceptedTaskCheckpoints: { task: accepted },
    });
    expect(landed.target).toBe("main");
    expect(fake.revisions.get("main")).toBe(landed.checkpoint.ref);
    expect(fake.revisions.get("main")).not.toBe("dv-100");
    // Still never touched the human's checkout: not just unchanged in the end,
    // but never the target of a mutating command at any point.
    expect(fake.branchAt(source)).toBe("main");
    expect(fake.workspaces.has(source)).toBe(true);
    const mutating = fake.calls.filter(
      (call) =>
        call.startsWith(`${source} :: `) &&
        /:: (checkout|commit|merge|reset|shelf|branch -[cd]|workspace delete)/.test(
          call,
        ),
    );
    expect(mutating).toEqual([]);
  });

  it("keeps a preserved Diversion candidate branch after its workspace is torn down", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-diversion-preserve-"));
    await mkdir(join(root, "checkout", ".diversion"), { recursive: true });
    const source = await realpath(join(root, "checkout"));
    await writeFile(join(source, ".diversion", "dv.ws.source"), "");
    const fake = diversionWorkspaceFake(source);
    const backend = new DiversionSourceControlBackend(
      "dv-test",
      "dv",
      fake.cli,
      "per-task",
    );
    const workspace = await backend.openJob({
      repository: source,
      stateDirectory: join(root, "state"),
      jobId: "job",
      key: "RUN-1",
      kind: "task",
      expectedBaseRevision: "dv-100",
      config: project("isolated", "main"),
    });
    const task = await backend.beginTask(workspace, "RUN-1");
    const candidateReference = `${workspace.retainedLocation.label}/candidate-run-1`;

    fake.edit(task.path);
    const preserved = await backend.preserveFailedWork({
      workspace,
      task,
      taskKey: "RUN-1",
      reason: "checks failed",
    });
    expect(preserved).toMatchObject({ label: candidateReference });
    // The work was committed to the branch, so it outlives the workspace.
    expect(fake.revisions.get(candidateReference)).not.toBe("dv-100");

    await backend.releaseTask(workspace, task);
    expect(fake.workspaces.has(task.path)).toBe(false);
    expect(fake.revisions.has(candidateReference)).toBe(true);
    expect(fake.calls).not.toContain(
      `${workspace.path} :: branch -d ${candidateReference} -f`,
    );
  });

  it("keeps a per-task Diversion job on its own workspaces after the setting flips back to shared", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-diversion-flip-"));
    await mkdir(join(root, "checkout", ".diversion"), { recursive: true });
    const source = await realpath(join(root, "checkout"));
    await writeFile(join(source, ".diversion", "dv.ws.source"), "");
    const stateDirectory = join(root, "state");
    const fake = diversionWorkspaceFake(source);
    const perTask = new DiversionSourceControlBackend(
      "dv-test",
      "dv",
      fake.cli,
      "per-task",
    );
    const workspace = await perTask.openJob({
      repository: source,
      stateDirectory,
      jobId: "job",
      key: "RUN-1",
      kind: "task",
      expectedBaseRevision: "dv-100",
      config: project("isolated", "main"),
    });

    // The operator switches the setting back while this job is still open.
    const shared = new DiversionSourceControlBackend(
      "dv-test",
      "dv",
      fake.cli,
      "shared",
    );
    const restored = await shared.restoreJob({
      repository: source,
      stateDirectory,
      jobId: "job",
      handle: workspace.handle,
      mode: "isolated",
      baseRevision: "dv-100",
      currentRevision: "dv-100",
    });
    // The handle decides, not the setting: still its own workspace, and the
    // human's checkout is still on its own branch.
    expect(restored.path).toBe(workspace.path);
    expect(restored.path).not.toBe(source);
    const task = await shared.beginTask(restored, "RUN-1");
    expect(task.path).not.toBe(source);
    expect(fake.branchAt(source)).toBe("main");
  });

  it("does not destroy Diversion task workspaces or overclaim during orphan recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-diversion-orphan-"));
    await mkdir(join(root, "checkout", ".diversion"), { recursive: true });
    const source = await realpath(join(root, "checkout"));
    await writeFile(join(source, ".diversion", "dv.ws.source"), "");
    const stateDirectory = join(root, "state");
    const fake = diversionWorkspaceFake(source);
    const backend = new DiversionSourceControlBackend(
      "dv-test",
      "dv",
      fake.cli,
      "per-task",
    );
    const workspace = await backend.openJob({
      repository: source,
      stateDirectory,
      jobId: "job",
      key: "RUN-1",
      kind: "task",
      expectedBaseRevision: "dv-100",
      config: project("isolated", "main"),
    });
    const task = await backend.beginTask(workspace, "RUN-1");
    const lockPath = (workspace.handle.state as { lockPath: string }).lockPath;
    await writeFile(
      lockPath,
      JSON.stringify({
        ...JSON.parse(await readFile(lockPath, "utf8")),
        pid: 0x7ffffff0,
      }),
    );

    const warnings = await backend.recoverOrphans(source, stateDirectory);
    // The job clone is re-provisionable, so reclaiming it is safe. The task
    // clone is not — nothing re-clones it, and it may hold uncommitted work.
    expect(fake.workspaces.has(workspace.path)).toBe(false);
    expect(fake.workspaces.has(task.path)).toBe(true);
    expect(await stat(task.path).then(() => true)).toBe(true);
    // And the record that finds it again must survive, with no false claim.
    expect(await stat(lockPath).then(() => true)).toBe(true);
    expect(warnings.join(" ")).not.toContain(
      "reclaimed orphaned Diversion workspaces",
    );
    expect(warnings.join(" ")).toContain("left in place");
  });

  it("keeps the landing lock when a Diversion landing workspace cannot be reclaimed", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-diversion-landing-"));
    await mkdir(join(root, "checkout", ".diversion"), { recursive: true });
    const source = await realpath(join(root, "checkout"));
    await writeFile(join(source, ".diversion", "dv.ws.source"), "");
    const stateDirectory = join(root, "state");
    const fake = diversionWorkspaceFake(source);
    const backend = new DiversionSourceControlBackend(
      "dv-test",
      "dv",
      fake.cli,
      "per-task",
    );
    const workspace = await backend.openJob({
      repository: source,
      stateDirectory,
      jobId: "job",
      key: "RUN-1",
      kind: "task",
      expectedBaseRevision: "dv-100",
      config: project("isolated", "main"),
    });
    const task = await backend.beginTask(workspace, "RUN-1");
    fake.edit(task.path);
    const staged = await backend.stageCandidate({
      workspace,
      task,
      taskKey: "RUN-1",
      summary: "candidate",
      refresh: false,
    });
    if (staged.status !== "ready") throw new Error("candidate not ready");
    const accepted = await backend.acceptCandidate({
      workspace,
      task,
      candidate: staged.checkpoint,
      taskKey: "RUN-1",
    });
    await backend.releaseTask(workspace, task);
    await backend.release(workspace, "job");

    // A manual landing long after the job workspace is gone.
    fake.refuseDeletion(true);
    const landed = await backend.land({
      repository: source,
      stateDirectory,
      jobId: "job",
      workspace,
      target: "main",
      acceptedTaskCheckpoints: { task: accepted },
    });
    expect(fake.revisions.get("main")).toBe(landed.checkpoint.ref);
    // The landing clone is still registered, so its record must remain.
    const locks = await readdir(join(stateDirectory, "locks"));
    expect(locks).toHaveLength(1);
    const owner = JSON.parse(
      await readFile(join(stateDirectory, "locks", locks[0]!), "utf8"),
    ) as { workspaceRoot?: string };
    expect(typeof owner.workspaceRoot).toBe("string");

    // And recovery finds it through that record once it can be reclaimed.
    fake.refuseDeletion(false);
    await writeFile(
      join(stateDirectory, "locks", locks[0]!),
      JSON.stringify({ ...owner, pid: 0x7ffffff0 }),
    );
    const warnings = await backend.recoverOrphans(source, stateDirectory);
    expect(warnings.join(" ")).toContain("reclaimed");
    expect(await readdir(join(stateDirectory, "locks"))).toHaveLength(0);
  });

  it("keeps the recovery record when a Diversion workspace refuses to deregister", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-diversion-stranded-"));
    await mkdir(join(root, "checkout", ".diversion"), { recursive: true });
    const source = await realpath(join(root, "checkout"));
    await writeFile(join(source, ".diversion", "dv.ws.source"), "");
    const stateDirectory = join(root, "state");
    const fake = diversionWorkspaceFake(source);
    const backend = new DiversionSourceControlBackend(
      "dv-test",
      "dv",
      fake.cli,
      "per-task",
    );
    const workspace = await backend.openJob({
      repository: source,
      stateDirectory,
      jobId: "job",
      key: "RUN-1",
      kind: "task",
      expectedBaseRevision: "dv-100",
      config: project("isolated", "main"),
    });
    const lockPath = (workspace.handle.state as { lockPath: string }).lockPath;
    expect(await readdir(join(stateDirectory, "locks"))).toHaveLength(1);

    // The workspace cannot be deregistered, so it is still registered in the
    // cloud. Dropping the lock here would leave nothing naming it.
    fake.refuseDeletion(true);
    await backend.release(workspace, "job");
    expect(fake.workspaces.has(workspace.path)).toBe(true);
    expect(await stat(workspace.path).then(() => true)).toBe(true);
    expect(await stat(lockPath).then(() => true)).toBe(true);

    // Once the workspace can be reclaimed, orphan recovery finds it through
    // that lock and reports what it did.
    fake.refuseDeletion(false);
    await writeFile(
      lockPath,
      JSON.stringify({
        ...JSON.parse(await readFile(lockPath, "utf8")),
        pid: 0x7ffffff0,
      }),
    );
    const warnings = await backend.recoverOrphans(source, stateDirectory);
    expect(warnings.join(" ")).toContain("reclaimed orphaned Diversion");
    expect(fake.workspaces.has(workspace.path)).toBe(false);
    expect(await readdir(join(stateDirectory, "locks"))).toHaveLength(0);
  });

  it("uses cumulative Perforce shelves in isolated mode and submits direct candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-p4-contract-"));
    await writeFile(join(root, ".p4config"), "P4CLIENT=client-test\n");
    const fake = perforceFake(root);
    const backend = new PerforceSourceControlBackend("p4-test", "p4", fake.cli);
    const isolated = await backend.openJob({
      repository: root,
      stateDirectory: join(root, "state-a"),
      jobId: "isolated-job",
      key: "RUN-2",
      kind: "plan",
      expectedBaseRevision: "100",
      config: project("isolated", "//depot/project/...#head"),
    });
    expect(fake.calls).toContain(`-ztag -F %path% where ${join(root, "...")}`);
    const first = await backend.beginTask(isolated, "RUN-2");
    const recoveredFirst = await backend.beginTask(isolated, "RUN-2");
    expect(recoveredFirst.handle).toEqual(first.handle);
    fake.edit();
    const firstCandidate = await backend.stageCandidate({
      workspace: isolated,
      task: first,
      taskKey: "RUN-2",
      summary: "first",
      refresh: false,
    });
    if (firstCandidate.status !== "ready")
      throw new Error("candidate not ready");
    expect(fake.calls).toContain(
      "-ztag -F %path% where //client-test/feature.txt",
    );
    await backend.acceptCandidate({
      workspace: isolated,
      task: first,
      candidate: firstCandidate.checkpoint,
      taskKey: "RUN-2",
    });
    await backend.beginTask(isolated, "RUN-3");
    expect(fake.calls.some((call) => call.startsWith("reopen -c"))).toBe(true);
    expect(fake.shelves).toEqual([firstCandidate.checkpoint.ref]);
    expect(backend.capabilities.parallelTaskWorkspaces).toBe(false);
    await backend.release(isolated, "isolated-job");
    const landedShelf = await backend.land({
      repository: root,
      stateDirectory: join(root, "state-a"),
      jobId: "isolated-job",
      workspace: isolated,
      target: "//depot/project/...#head",
      acceptedTaskCheckpoints: { first: firstCandidate.checkpoint },
    });
    expect(landedShelf).toMatchObject({
      target: "//depot/project/...#head",
      checkpoint: {
        ref: firstCandidate.checkpoint.ref,
        label: `submitted change ${firstCandidate.checkpoint.ref}`,
      },
    });
    expect(fake.submitted).toEqual([firstCandidate.checkpoint.ref]);

    const directFake = perforceFake(root);
    const directBackend = new PerforceSourceControlBackend(
      "p4-direct",
      "p4",
      directFake.cli,
    );
    const direct = await directBackend.openJob({
      repository: root,
      stateDirectory: join(root, "state-b"),
      jobId: "direct-job",
      key: "RUN-4",
      kind: "task",
      expectedBaseRevision: "100",
      config: project("direct", "//depot/project/...#head"),
    });
    const directTask = await directBackend.beginTask(direct, "RUN-4");
    directFake.edit();
    const directCandidate = await directBackend.stageCandidate({
      workspace: direct,
      task: directTask,
      taskKey: "RUN-4",
      summary: "direct",
      refresh: false,
    });
    if (directCandidate.status !== "ready")
      throw new Error("candidate not ready");
    const submitted = await directBackend.acceptCandidate({
      workspace: direct,
      task: directTask,
      candidate: directCandidate.checkpoint,
      taskKey: "RUN-4",
    });
    expect(submitted.label).toMatch(/^submitted change /);
    expect(directFake.submitted).toEqual([directCandidate.checkpoint.ref]);
    const replayed = await directBackend.acceptCandidate({
      workspace: direct,
      task: directTask,
      candidate: directCandidate.checkpoint,
      taskKey: "RUN-4",
    });
    expect(replayed).toEqual(submitted);
    expect(directFake.submitted).toEqual([directCandidate.checkpoint.ref]);
    await directBackend.release(direct, "direct-job");
    expect(directFake.calls).toContain("clean -e -a -d //...");
  });
});
