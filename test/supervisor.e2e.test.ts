import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectConfigSchema } from "../src/config.js";
import { jobAssignmentSchema } from "../src/contracts.js";
import { runProcess } from "../src/process.js";
import { FakeProviderAdapter } from "../src/providers/fake.js";
import { MemoryEventSink, RunnerJobSupervisor } from "../src/supervisor.js";

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
    const fake = new FakeProviderAdapter(
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
        guide: { provider: "fake", model: "guide", effort: "high" },
        builder: { provider: "fake", model: "builder", effort: "medium" },
        reviewer: { provider: "fake", model: "reviewer", effort: "high" },
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
    const supervisor = new RunnerJobSupervisor({
      assignment,
      repository,
      stateDirectory: join(root, "state"),
      projectConfig: config,
      providers: { fake, codex: undefined, claude: undefined },
      sink,
    });
    const output = await supervisor.run();
    expect(output.summary).toContain("succeeded");
    expect(output.branch).toMatch(/^noriq\/task\/run-1-/);
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
        `${base}..${output.branch}`,
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
    const fake = new FakeProviderAdapter(
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
        guide: { provider: "fake", model: "guide", effort: "high" },
        builder: { provider: "fake", model: "builder", effort: "medium" },
        reviewer: { provider: "fake", model: "reviewer", effort: "high" },
      },
      setup: { commands: [], timeoutSeconds: 30 },
      checks: { commands: ["test -f shared.txt"], timeoutSeconds: 30 },
    });
    const task = (id: string, key: string, order: number) => ({
      taskId: id,
      key,
      title: key,
      body: "",
      executionSpec: null,
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
    const output = await new RunnerJobSupervisor({
      assignment,
      repository,
      stateDirectory: join(root, "state"),
      projectConfig: config,
      providers: { fake, codex: undefined, claude: undefined },
      sink: new MemoryEventSink(),
    }).run();
    expect(output.summary).toContain("2 task(s) accepted");
    expect(fake.calls.filter((call) => call.role === "repairer")).toHaveLength(
      1,
    );
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
        `${base}..${output.branch}`,
      ]),
    ).toBe("2");
  });
});
