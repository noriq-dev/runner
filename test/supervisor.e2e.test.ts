import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectConfigSchema } from "../src/config.js";
import { jobAssignmentSchema } from "../src/contracts.js";
import { FakeAgentDriver } from "../src/drivers/fake.js";
import { runProcess } from "../src/process.js";
import {
  loadDurableJobState,
  MemoryEventSink,
  RunnerJobSupervisor,
} from "../src/supervisor.js";
import { GitWorkspaceBackend } from "../src/vcs/git.js";

async function command(
  cwd: string,
  command: string,
  args: string[],
): Promise<string> {
  const result = await runProcess({ command, args, cwd, timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

describe("RunnerJobSupervisor", () => {
  it("plans, builds, repairs, reviews, and retains one clean task branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-e2e-"));
    const repository = join(root, "repository");
    await command(root, "mkdir", [repository]);
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
    let reviewerCalls = 0;
    const fake = new FakeAgentDriver(
      join(root, "artifacts"),
      async (request) => {
        if (request.role === "guide") {
          return {
            summary: "planned",
            plan: "write the feature and check it",
            structured: {
              objective: "write feature",
              constraints: [],
              scope: ["feature.txt"],
              acceptanceCriteria: ["contains fixed"],
              verification: ["grep fixed feature.txt"],
              plan: "write and verify",
            },
          };
        }
        if (request.role === "builder") {
          await writeFile(join(request.workspace, "feature.txt"), "broken\n");
          return { summary: "added feature" };
        }
        if (request.role === "repairer") {
          await writeFile(join(request.workspace, "feature.txt"), "fixed\n");
          return { summary: "fixed feature" };
        }
        reviewerCalls += 1;
        return reviewerCalls === 1
          ? {
              summary: "broken",
              findings: [
                {
                  severity: "major",
                  title: "wrong value",
                  body: "feature remains broken",
                  path: "feature.txt",
                  line: 1,
                },
              ],
            }
          : { summary: "accepted", findings: [] };
      },
    );
    const config = projectConfigSchema.parse({
      key: "RUN",
      repositoryKey: "repo",
      defaultBranch: "main",
      workspace: { mode: "isolated", baseBranch: "main" },
      harness: { maxParallelTasks: 2, maxRepairRounds: 2, maxJobMinutes: 5 },
      agents: {
        guide: { driver: "fake", model: "guide", effort: "high" },
        builder: { driver: "fake", model: "builder", effort: "medium" },
        reviewer: { driver: "fake", model: "reviewer", effort: "high" },
      },
      setup: { commands: [], timeoutSeconds: 30 },
      checks: { commands: ["grep -q fixed feature.txt"], timeoutSeconds: 30 },
    });
    const assignment = jobAssignmentSchema.parse({
      protocolVersion: 2,
      jobId: "job-e2e",
      assignmentId: "assignment-e2e",
      snapshotDigest: "a".repeat(64),
      repoRef: "repo",
      expectedBaseRevision: base,
      source: {
        kind: "task",
        projectId: "project",
        projectKey: "RUN",
        task: {
          taskId: "task",
          key: "RUN-1",
          title: "Feature",
          body: "",
          executionSpec: null,
          status: "todo",
          retry: false,
          order: 0,
          phaseOrder: 0,
        },
      },
    });
    const sink = new MemoryEventSink();
    const stateDirectory = join(root, "state");
    const supervisor = new RunnerJobSupervisor({
      assignment,
      repository,
      stateDirectory,
      projectConfig: config,
      backend: new GitWorkspaceBackend(),
      drivers: { fake, codex: undefined, claude: undefined },
      sink,
    });
    const output = await supervisor.run();
    expect(output.summary).toContain("succeeded");
    expect(output.retainedLocation.label).toMatch(/^noriq\/task\/run-1-/);
    expect(output.dirtyPaths).toEqual([]);
    expect(
      await readFile(
        join(root, "state", "worktrees", "job-e2e", "job", "feature.txt"),
        "utf8",
      ),
    ).toBe("fixed\n");
    expect(fake.calls.map((call) => call.role)).toEqual([
      "guide",
      "builder",
      "reviewer",
      "repairer",
      "reviewer",
    ]);
    expect(sink.events.at(-1)?.payload.type).toBe("terminal");
    expect(
      await command(repository, "git", [
        "rev-list",
        "--count",
        `${base}..${output.retainedLocation.label}`,
      ]),
    ).toBe("1");
  });

  it("serializes plan integration and delegates an integration conflict to one repair round", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-plan-conflict-"));
    const repository = join(root, "repository");
    await command(root, "mkdir", [repository]);
    await command(repository, "git", ["init", "-b", "main"]);
    await command(repository, "git", [
      "config",
      "user.email",
      "runner@example.test",
    ]);
    await command(repository, "git", ["config", "user.name", "Runner Test"]);
    await writeFile(join(repository, "shared.txt"), "base\n");
    await command(repository, "git", ["add", "."]);
    await command(repository, "git", ["commit", "-m", "base"]);
    const base = await command(repository, "git", ["rev-parse", "HEAD"]);
    const fake = new FakeAgentDriver(
      join(root, "artifacts"),
      async (request) => {
        if (request.role === "guide")
          return {
            summary: "planned",
            plan: "edit shared file",
            structured: {
              objective: "edit shared",
              constraints: [],
              scope: ["shared.txt"],
              acceptanceCriteria: ["change retained"],
              verification: [],
              plan: "edit",
            },
          };
        if (request.role === "builder") {
          await writeFile(
            join(request.workspace, "shared.txt"),
            `${request.taskKey}\n`,
          );
          return { summary: `implemented ${request.taskKey}` };
        }
        if (request.role === "repairer") {
          await writeFile(
            join(request.workspace, "shared.txt"),
            "RUN-10\nRUN-11\n",
          );
          return { summary: "resolved integration conflict" };
        }
        return { summary: "accepted", findings: [] };
      },
    );
    const config = projectConfigSchema.parse({
      key: "RUN",
      repositoryKey: "repo",
      defaultBranch: "main",
      workspace: { mode: "isolated", baseBranch: "main" },
      harness: { maxParallelTasks: 2, maxRepairRounds: 2, maxJobMinutes: 5 },
      agents: {
        guide: { driver: "fake", model: "guide", effort: "high" },
        builder: { driver: "fake", model: "builder", effort: "medium" },
        reviewer: { driver: "fake", model: "reviewer", effort: "high" },
      },
      setup: { commands: [], timeoutSeconds: 30 },
      checks: { commands: ["test -f shared.txt"], timeoutSeconds: 30 },
    });
    const task = (id: string, key: string, order: number) => ({
      taskId: id,
      key,
      title: key,
      body: "",
      executionSpec: {
        anticipatedFiles: [
          {
            path: "shared.txt",
            change: "modify" as const,
            why: "Apply the commissioned edit",
          },
        ],
        acceptance: {
          observableTruths: ["shared.txt contains the accepted change"],
        },
      },
      status: "todo" as const,
      retry: false,
      order,
      phaseOrder: 0,
    });
    const assignment = jobAssignmentSchema.parse({
      protocolVersion: 2,
      jobId: "job-plan",
      assignmentId: "assignment-plan",
      snapshotDigest: "c".repeat(64),
      repoRef: "repo",
      expectedBaseRevision: base,
      source: {
        kind: "plan",
        projectId: "project",
        projectKey: "RUN",
        planId: "plan",
        planKey: "RUN-PLAN",
        planTitle: "Conflict",
        tasks: [task("one", "RUN-10", 0), task("two", "RUN-11", 1)],
        dependencies: [],
      },
    });
    const sink = new MemoryEventSink();
    const output = await new RunnerJobSupervisor({
      assignment,
      repository,
      stateDirectory: join(root, "state"),
      projectConfig: config,
      backend: new GitWorkspaceBackend(),
      drivers: { fake, codex: undefined, claude: undefined },
      sink,
    }).run();
    expect(output.summary).toContain("2 task(s) accepted");
    expect(fake.calls.filter((call) => call.role === "repairer")).toHaveLength(
      1,
    );
    expect(fake.calls.filter((call) => call.role === "guide")).toEqual([]);
    expect(
      await readFile(
        join(root, "state", "worktrees", "job-plan", "job", "shared.txt"),
        "utf8",
      ),
    ).toBe("RUN-10\nRUN-11\n");
    expect(
      await command(repository, "git", [
        "rev-list",
        "--count",
        `${base}..${output.retainedLocation.label}`,
      ]),
    ).toBe("2");
    expect(sink.events.map((event) => event.seq)).toEqual(
      sink.events.map((_, index) => index + 1),
    );
  });

  it("preserves changes and removes the child worktree when a builder crashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-build-failure-"));
    const repository = join(root, "repository");
    await command(root, "mkdir", [repository]);
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
    const fake = new FakeAgentDriver(
      join(root, "artifacts"),
      async (request) => {
        if (request.role === "guide")
          return {
            summary: "planned",
            structured: {
              objective: "write before failure",
              constraints: [],
              scope: ["failed.txt"],
              acceptanceCriteria: ["retain evidence"],
              verification: [],
              plan: "write",
            },
          };
        if (request.role === "builder") {
          await writeFile(join(request.workspace, "failed.txt"), "evidence\n");
          throw new Error("driver crashed after editing");
        }
        return { summary: "unused" };
      },
    );
    const config = projectConfigSchema.parse({
      key: "RUN",
      repositoryKey: "repo",
      defaultBranch: "main",
      workspace: { mode: "isolated", baseBranch: "main" },
      harness: { maxParallelTasks: 1, maxRepairRounds: 2, maxJobMinutes: 5 },
      agents: {
        guide: { driver: "fake", model: "guide", effort: "high" },
        builder: { driver: "fake", model: "builder", effort: "medium" },
        reviewer: { driver: "fake", model: "reviewer", effort: "high" },
      },
      setup: { commands: [], timeoutSeconds: 30 },
      checks: { commands: [], timeoutSeconds: 30 },
    });
    const assignment = jobAssignmentSchema.parse({
      protocolVersion: 2,
      jobId: "job-build-fail",
      assignmentId: "assignment-build-fail",
      snapshotDigest: "d".repeat(64),
      repoRef: "repo",
      expectedBaseRevision: base,
      source: {
        kind: "task",
        projectId: "project",
        projectKey: "RUN",
        task: {
          taskId: "failed-task",
          key: "RUN-20",
          title: "Fail after write",
          body: "",
          executionSpec: null,
          status: "todo",
          retry: false,
          order: 0,
          phaseOrder: 0,
        },
      },
    });
    const stateDirectory = join(root, "state");
    const output = await new RunnerJobSupervisor({
      assignment,
      repository,
      stateDirectory,
      projectConfig: config,
      backend: new GitWorkspaceBackend(),
      drivers: { fake, codex: undefined, claude: undefined },
      sink: new MemoryEventSink(),
    }).run();
    expect(output.summary).toContain("failed");
    expect(output.dirtyPaths).toEqual([]);
    expect(output.retainedLocation.label).toMatch(/^noriq\/recovery\//);
    expect(
      await command(repository, "git", [
        "log",
        "--format=%s",
        `${base}..${output.retainedLocation.label}`,
      ]),
    ).toContain("WIP RUN-20");
    expect(
      await command(repository, "git", ["worktree", "list", "--porcelain"]),
    ).not.toContain("task-run-20");
  });

  it("cancels an active builder without publishing a post-cancel task failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-cancel-"));
    const repository = join(root, "repository");
    await command(root, "mkdir", [repository]);
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
    let builderStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      builderStarted = resolve;
    });
    const fake = new FakeAgentDriver(
      join(root, "artifacts"),
      async (request) => {
        if (request.role === "builder") {
          await writeFile(
            join(request.workspace, "cancelled.txt"),
            "evidence\n",
          );
          builderStarted();
          const signal = request.signal!;
          await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(signal.reason);
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          });
        }
        return { summary: "unused", findings: [] };
      },
    );
    const config = projectConfigSchema.parse({
      key: "RUN",
      repositoryKey: "repo",
      defaultBranch: "main",
      workspace: { mode: "isolated", baseBranch: "main" },
      harness: { maxParallelTasks: 1, maxRepairRounds: 1, maxJobMinutes: 5 },
      agents: {
        guide: { driver: "fake", model: "guide", effort: "high" },
        builder: { driver: "fake", model: "builder", effort: "medium" },
        reviewer: { driver: "fake", model: "reviewer", effort: "high" },
      },
      setup: { commands: [], timeoutSeconds: 30 },
      checks: { commands: [], timeoutSeconds: 30 },
    });
    const assignment = jobAssignmentSchema.parse({
      protocolVersion: 2,
      jobId: "job-cancel",
      assignmentId: "assignment-cancel",
      snapshotDigest: "9".repeat(64),
      repoRef: "repo",
      expectedBaseRevision: base,
      source: {
        kind: "task",
        projectId: "project",
        projectKey: "RUN",
        task: {
          taskId: "cancelled-task",
          key: "RUN-23",
          title: "Cancel active builder",
          body: "",
          executionSpec: {
            anticipatedFiles: [
              {
                path: "cancelled.txt",
                change: "create",
                why: "exercise cancellation preservation",
              },
            ],
          },
          status: "todo",
          retry: false,
          order: 0,
          phaseOrder: 0,
        },
      },
    });
    const sink = new MemoryEventSink();
    const stateDirectory = join(root, "state");
    const supervisor = new RunnerJobSupervisor({
      assignment,
      repository,
      stateDirectory,
      projectConfig: config,
      backend: new GitWorkspaceBackend(),
      drivers: { fake, codex: undefined, claude: undefined },
      sink,
    });
    const running = supervisor.run();
    await started;
    supervisor.cancel();
    const output = await running;
    expect(output.summary).toContain("cancelled");
    expect(output.retainedLocation.label).toMatch(/^noriq\/recovery\//);
    expect(sink.events.at(-1)?.payload).toMatchObject({
      type: "terminal",
      status: "cancelled",
    });
    expect(
      sink.events.filter(
        (event) =>
          event.payload.type === "task.result" &&
          event.payload.status === "failed",
      ),
    ).toEqual([]);
    expect(
      Object.values(
        (await loadDurableJobState(stateDirectory, assignment.jobId))!
          .invocations,
      ),
    ).toMatchObject([{ role: "builder", status: "abandoned" }]);
  });

  it("reviews the working diff and creates one checkpoint in direct mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-direct-e2e-"));
    const repository = join(root, "repository");
    await command(root, "mkdir", [repository]);
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
    const fake = new FakeAgentDriver(
      join(root, "artifacts"),
      async (request) => {
        if (request.role === "guide")
          return {
            summary: "planned",
            structured: {
              objective: "write direct",
              constraints: [],
              scope: ["direct.txt"],
              acceptanceCriteria: ["contains direct"],
              verification: [],
              plan: "write",
            },
          };
        if (request.role === "builder") {
          await writeFile(join(request.workspace, "direct.txt"), "direct\n");
          return { summary: "wrote direct" };
        }
        expect(request.prompt).toContain("+direct");
        return { summary: "accepted", findings: [] };
      },
    );
    const config = projectConfigSchema.parse({
      key: "RUN",
      repositoryKey: "repo",
      defaultBranch: "main",
      workspace: { mode: "direct", baseBranch: "main", directBranch: "main" },
      harness: { maxParallelTasks: 2, maxRepairRounds: 2, maxJobMinutes: 5 },
      agents: {
        guide: { driver: "fake", model: "guide", effort: "high" },
        builder: { driver: "fake", model: "builder", effort: "medium" },
        reviewer: { driver: "fake", model: "reviewer", effort: "high" },
      },
      setup: { commands: [], timeoutSeconds: 30 },
      checks: { commands: ["grep -q direct direct.txt"], timeoutSeconds: 30 },
    });
    const assignment = jobAssignmentSchema.parse({
      protocolVersion: 2,
      jobId: "job-direct",
      assignmentId: "assignment-direct",
      snapshotDigest: "e".repeat(64),
      repoRef: "repo",
      expectedBaseRevision: base,
      source: {
        kind: "task",
        projectId: "project",
        projectKey: "RUN",
        task: {
          taskId: "direct-task",
          key: "RUN-21",
          title: "Direct",
          body: "",
          executionSpec: null,
          status: "todo",
          retry: false,
          order: 0,
          phaseOrder: 0,
        },
      },
    });
    const stateDirectory = join(root, "state");
    const output = await new RunnerJobSupervisor({
      assignment,
      repository,
      stateDirectory,
      projectConfig: config,
      backend: new GitWorkspaceBackend(),
      drivers: { fake, codex: undefined, claude: undefined },
      sink: new MemoryEventSink(),
    }).run();
    expect(output.summary).toContain("succeeded");
    expect(output.retainedLocation.label).toBe("main");
    expect(output.dirtyPaths).toEqual([]);
    expect(
      await command(repository, "git", [
        "rev-list",
        "--count",
        `${base}..HEAD`,
      ]),
    ).toBe("1");
    expect(await readdir(join(stateDirectory, "locks"))).toEqual([]);
  });

  it("preserves failed direct-mode edits without advancing the target branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-direct-failure-"));
    const repository = join(root, "repository");
    await command(root, "mkdir", [repository]);
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
    const fake = new FakeAgentDriver(
      join(root, "artifacts"),
      async (request) => {
        if (request.role === "guide")
          return {
            summary: "planned",
            structured: {
              objective: "write direct evidence before failure",
              constraints: [],
              scope: ["direct-failed.txt"],
              acceptanceCriteria: ["retain failed direct evidence"],
              verification: [],
              plan: "write then fail",
            },
          };
        if (request.role === "builder") {
          await writeFile(
            join(request.workspace, "direct-failed.txt"),
            "evidence\n",
          );
          throw new Error("driver crashed after direct edit");
        }
        return { summary: "unused" };
      },
    );
    const config = projectConfigSchema.parse({
      key: "RUN",
      repositoryKey: "repo",
      defaultBranch: "main",
      workspace: { mode: "direct", baseBranch: "main", directBranch: "main" },
      harness: { maxParallelTasks: 1, maxRepairRounds: 1, maxJobMinutes: 5 },
      agents: {
        guide: { driver: "fake", model: "guide", effort: "high" },
        builder: { driver: "fake", model: "builder", effort: "medium" },
        reviewer: { driver: "fake", model: "reviewer", effort: "high" },
      },
      setup: { commands: [], timeoutSeconds: 30 },
      checks: { commands: [], timeoutSeconds: 30 },
    });
    const assignment = jobAssignmentSchema.parse({
      protocolVersion: 2,
      jobId: "job-direct-fail",
      assignmentId: "assignment-direct-fail",
      snapshotDigest: "f".repeat(64),
      repoRef: "repo",
      expectedBaseRevision: base,
      source: {
        kind: "task",
        projectId: "project",
        projectKey: "RUN",
        task: {
          taskId: "direct-failed-task",
          key: "RUN-22",
          title: "Fail after direct write",
          body: "",
          executionSpec: null,
          status: "todo",
          retry: false,
          order: 0,
          phaseOrder: 0,
        },
      },
    });
    const stateDirectory = join(root, "state");
    const output = await new RunnerJobSupervisor({
      assignment,
      repository,
      stateDirectory,
      projectConfig: config,
      backend: new GitWorkspaceBackend(),
      drivers: { fake, codex: undefined, claude: undefined },
      sink: new MemoryEventSink(),
    }).run();
    expect(output.summary).toContain("failed");
    expect(output.dirtyPaths).toEqual([]);
    expect(output.retainedLocation.label).toMatch(/^noriq\/recovery\//);
    expect(await command(repository, "git", ["rev-parse", "HEAD"])).toBe(base);
    expect(
      await command(repository, "git", [
        "show",
        `${output.retainedLocation.label}:direct-failed.txt`,
      ]),
    ).toBe("evidence");
    expect(await readdir(join(stateDirectory, "locks"))).toEqual([]);
  });
});
