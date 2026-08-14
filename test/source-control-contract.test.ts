import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
