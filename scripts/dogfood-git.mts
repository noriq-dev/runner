import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { projectConfigSchema } from "../src/config.js";
import { jobAssignmentSchema } from "../src/contracts.js";
import { FakeAgentDriver } from "../src/drivers/fake.js";
import { MemoryEventSink, RunnerJobSupervisor } from "../src/supervisor.js";
import { GitSourceControlBackend } from "../src/vcs/git.js";

const execute = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execute("git", args, { cwd });
  return result.stdout.trim();
}

async function dogfood(source: string, index: number): Promise<void> {
  const absolute = resolve(source);
  const branch = await git(absolute, "branch", "--show-current");
  if (!branch) throw new Error(`${absolute} is not on a named Git branch`);
  const temporary = await mkdtemp(join(tmpdir(), "noriq-runner-dogfood-"));
  try {
    const repository = join(temporary, "repository");
    await execute("git", [
      "clone",
      "--quiet",
      "--no-local",
      "--branch",
      branch,
      absolute,
      repository,
    ]);
    await git(
      repository,
      "config",
      "user.email",
      "runner-dogfood@example.test",
    );
    await git(repository, "config", "user.name", "Runner Dogfood");
    const base = await git(repository, "rev-parse", "HEAD");
    const stateDirectory = join(temporary, "state");
    const driver = new FakeAgentDriver(
      join(temporary, "artifacts"),
      async (request) => {
        if (request.role === "guide")
          return {
            summary: "bounded dogfood plan",
            structured: {
              objective: "Create one harmless dogfood marker",
              constraints: ["Do not change existing project files"],
              scope: [".noriq-runner-dogfood"],
              acceptanceCriteria: ["marker exists"],
              verification: ["test -f .noriq-runner-dogfood"],
              plan: "Write and verify the marker",
            },
          };
        if (request.role === "builder") {
          await writeFile(
            join(request.workspace, ".noriq-runner-dogfood"),
            `source=${absolute}\nbase=${base}\n`,
          );
          return { summary: "created isolated dogfood marker" };
        }
        return { summary: "candidate accepted", findings: [] };
      },
    );
    const project = projectConfigSchema.parse({
      key: "DOGFOOD",
      repositoryKey: `dogfood-${index}`,
      defaultBranch: branch,
      sourceControl: { backend: "git", mode: "isolated", base: branch },
      harness: { maxParallelTasks: 1, maxRepairRounds: 1, maxJobMinutes: 5 },
      agents: {
        guide: { driver: "fake", model: "fake", effort: "low" },
        builder: { driver: "fake", model: "fake", effort: "low" },
        reviewer: { driver: "fake", model: "fake", effort: "low" },
      },
      setup: { commands: [], timeoutSeconds: 30 },
      checks: {
        commands: ["test -f .noriq-runner-dogfood"],
        timeoutSeconds: 30,
      },
    });
    const assignment = jobAssignmentSchema.parse({
      protocolVersion: 2,
      jobId: `dogfood-${index}`,
      assignmentId: `dogfood-assignment-${index}`,
      snapshotDigest: String(index).repeat(64),
      repoRef: project.repositoryKey,
      expectedBaseRevision: base,
      source: {
        kind: "task",
        projectId: "dogfood",
        projectKey: "DOGFOOD",
        task: {
          taskId: `dogfood-task-${index}`,
          key: `DOGFOOD-${index}`,
          title: "Exercise Runner against a real repository",
          body: "Create an isolated marker and retain it for review.",
          executionSpec: null,
          status: "todo",
          retry: false,
          order: 0,
          phaseOrder: 0,
        },
      },
    });
    const output = await new RunnerJobSupervisor({
      assignment,
      repository,
      stateDirectory,
      projectConfig: project,
      backend: new GitSourceControlBackend("git"),
      drivers: { fake: driver },
      sink: new MemoryEventSink(),
    }).run();
    if (
      !output.summary.startsWith("succeeded:") ||
      output.dirtyPaths.length > 0
    )
      throw new Error(
        `dogfood failed for ${absolute}: ${JSON.stringify(output)}`,
      );
    process.stdout.write(
      `${absolute}: ${output.headRevision} at ${output.retainedLocation.label}\n`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const sources = process.argv.slice(2);
if (sources.length === 0)
  throw new Error("usage: npm run dogfood:git -- /path/to/repository [...]");
for (const [index, source] of sources.entries())
  await dogfood(source, index + 1);
