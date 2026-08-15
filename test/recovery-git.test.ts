import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectConfigSchema } from "../src/config.js";
import { jobAssignmentSchema } from "../src/contracts.js";
import { FakeAgentDriver } from "../src/drivers/fake.js";
import { prepareJobWorkspace, releaseJobWorkspace } from "../src/git.js";
import { ChecksummedJournal } from "../src/journal.js";
import { runProcess } from "../src/process.js";
import { MemoryEventSink, RunnerJobSupervisor } from "../src/supervisor.js";
import { GitWorkspaceBackend } from "../src/vcs/git.js";

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

async function repository(
  root: string,
): Promise<{ path: string; base: string }> {
  const path = join(root, "repository");
  await mkdir(path);
  await command(path, "git", ["init", "-b", "main"]);
  await command(path, "git", ["config", "user.email", "runner@example.test"]);
  await command(path, "git", ["config", "user.name", "Runner Test"]);
  await writeFile(join(path, "README.md"), "base\n");
  await command(path, "git", ["add", "."]);
  await command(path, "git", ["commit", "-m", "base"]);
  return { path, base: await command(path, "git", ["rev-parse", "HEAD"]) };
}

const config = (mode: "isolated" | "direct") =>
  projectConfigSchema.parse({
    key: "RUN",
    repositoryKey: "repo",
    defaultBranch: "main",
    workspace: {
      mode,
      baseBranch: "main",
      ...(mode === "direct" ? { directBranch: "main" } : {}),
    },
    harness: { maxParallelTasks: 1, maxRepairRounds: 1, maxJobMinutes: 5 },
    agents: {
      guide: { driver: "fake", model: "guide", effort: "high" },
      builder: { driver: "fake", model: "builder", effort: "medium" },
      reviewer: { driver: "fake", model: "reviewer", effort: "high" },
    },
    setup: { commands: [], timeoutSeconds: 30 },
    checks: { commands: ["test -f recovered.txt"], timeoutSeconds: 30 },
  });

function invocation(
  jobId: string,
  taskId: string,
  role: string,
  round = 0,
): string {
  return createHash("sha256")
    .update(`${jobId}:${taskId}:${role}:${round}`)
    .digest("hex")
    .slice(0, 32);
}

function receipt(summary: string, structured: Record<string, unknown> = {}) {
  return {
    success: true,
    summary,
    findings: [],
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 0,
      costUsd: 0,
      calls: 1,
    },
    rawLogPath: "recovered.log",
    structured,
  };
}

describe("workspace durability", () => {
  it("durably waits for a human answer and re-invokes a fresh guide", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-question-"));
    const repo = await repository(root);
    const assignment = jobAssignmentSchema.parse({
      protocolVersion: 2,
      jobId: "job-question",
      assignmentId: "assignment-question",
      snapshotDigest: "b".repeat(64),
      repoRef: "repo",
      expectedBaseRevision: repo.base,
      source: {
        kind: "task",
        projectId: "project",
        projectKey: "RUN",
        task: {
          taskId: "question-task",
          key: "RUN-5",
          title: "Ask",
          body: "",
          executionSpec: null,
          status: "todo",
          retry: false,
          order: 0,
          phaseOrder: 0,
        },
      },
    });
    let guideCalls = 0;
    const fake = new FakeAgentDriver(
      join(root, "artifacts"),
      async (request) => {
        if (request.role === "guide") {
          guideCalls += 1;
          return {
            summary: "planned",
            plan: "write answer",
            structured: {
              objective:
                guideCalls === 1 ? "write answer" : "write forty-two answer",
              constraints: [],
              scope: ["answer.txt"],
              acceptanceCriteria: ["answer exists"],
              verification: [],
              plan: "write answer",
            },
            ...(guideCalls === 1
              ? {
                  controlActions: [
                    {
                      at: new Date().toISOString(),
                      name: "ask_human",
                      args: { question: "Which answer should be written?" },
                    },
                  ],
                }
              : {}),
          };
        }
        if (request.role === "builder") {
          expect(request.prompt).toContain("forty-two");
          await writeFile(join(request.workspace, "answer.txt"), "forty-two\n");
        }
        return { summary: "accepted", findings: [] };
      },
    );
    const sink = new MemoryEventSink();
    const questionConfig = config("isolated");
    questionConfig.checks.commands = ["test -f answer.txt"];
    const supervisor = new RunnerJobSupervisor({
      assignment,
      repository: repo.path,
      stateDirectory: join(root, "state"),
      projectConfig: questionConfig,
      backend: new GitWorkspaceBackend(),
      drivers: { fake, codex: undefined, claude: undefined },
      sink,
    });
    const running = supervisor.run();
    await expect
      .poll(
        () =>
          sink.events.find(
            (candidate) => candidate.payload.type === "question",
          ),
        { interval: 10, timeout: 10_000 },
      )
      .toBeTruthy();
    const question = sink.events.find(
      (candidate) => candidate.payload.type === "question",
    );
    expect(question?.payload.type).toBe("question");
    if (question?.payload.type !== "question")
      throw new Error("question event was not emitted");
    await supervisor.answer(question.payload.questionId, "forty-two");
    expect((await running).summary).toContain("succeeded");
    expect(fake.calls.map((call) => call.role)).toEqual([
      "guide",
      "guide",
      "builder",
      "reviewer",
    ]);
  }, 15_000);

  it("resumes a completed builder receipt without invoking it or duplicating the checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-recovery-"));
    const repo = await repository(root);
    const stateDirectory = join(root, "state");
    const artifactRoot = join(root, "artifacts");
    const assignment = jobAssignmentSchema.parse({
      protocolVersion: 2,
      jobId: "job-recovery",
      assignmentId: "assignment-recovery",
      snapshotDigest: "a".repeat(64),
      repoRef: "repo",
      expectedBaseRevision: repo.base,
      source: {
        kind: "task",
        projectId: "project",
        projectKey: "RUN",
        task: {
          taskId: "task",
          key: "RUN-2",
          title: "Recover",
          body: "",
          executionSpec: null,
          status: "todo",
          retry: false,
          order: 0,
          phaseOrder: 0,
        },
      },
    });
    const backend = new GitWorkspaceBackend();
    const workspace = await backend.openJob({
      repository: repo.path,
      stateDirectory,
      jobId: assignment.jobId,
      key: "RUN-2",
      kind: "task",
      expectedBaseRevision: repo.base,
      config: config("isolated"),
    });
    const child = await backend.beginTask(workspace, "RUN-2");
    await writeFile(join(child.path, "recovered.txt"), "from receipt\n");
    const guideId = invocation(assignment.jobId, "task", "guide");
    const builderId = invocation(assignment.jobId, "task", "builder");
    for (const [id, value] of [
      [
        guideId,
        receipt("planned", {
          objective: "recover",
          constraints: [],
          scope: ["recovered.txt"],
          acceptanceCriteria: ["file exists"],
          verification: ["test -f recovered.txt"],
          plan: "recover",
        }),
      ],
      [builderId, receipt("built")],
    ] as const) {
      await mkdir(join(artifactRoot, id), { recursive: true });
      await writeFile(
        join(artifactRoot, id, "receipt.json"),
        JSON.stringify(value),
      );
    }
    const journal = await ChecksummedJournal.open(
      join(stateDirectory, "jobs", "job-recovery", "events.jsonl"),
    );
    await journal.append("job.assigned", { assignment });
    await journal.append("workspace.opened", { workspace });
    await journal.append("job.started", {});
    await journal.append("task.started", { taskId: "task" });
    await journal.append("task.plan", { taskId: "task", plan: "recover" });
    await journal.append("task.workspace", {
      taskId: "task",
      workspace: child,
    });
    await journal.append("invocation.started", {
      id: guideId,
      taskId: "task",
      role: "guide",
      status: "started",
    });
    await journal.append("invocation.completed", {
      id: guideId,
      resultDigest: "guide",
      recovered: false,
    });
    await journal.append("invocation.started", {
      id: builderId,
      taskId: "task",
      role: "builder",
      status: "started",
    });
    await journal.append("invocation.completed", {
      id: builderId,
      resultDigest: "builder",
      recovered: false,
    });

    const fake = new FakeAgentDriver(artifactRoot, async (request) => {
      if (request.role === "reviewer")
        return { summary: "accepted", findings: [] };
      throw new Error("completed invocation repeated");
    });
    Object.defineProperty(fake, "vendor", { value: "openai" });
    let pricingCalls = 0;
    const output = await new RunnerJobSupervisor({
      assignment,
      repository: repo.path,
      stateDirectory,
      projectConfig: config("isolated"),
      backend,
      drivers: { fake, codex: undefined, claude: undefined },
      pricingProviders: {
        openai: {
          vendor: "openai",
          quote: async () => {
            pricingCalls += 1;
            return { quote: null, stale: false, warning: null };
          },
        },
      },
      sink: new MemoryEventSink(),
    }).run();
    expect(output.summary).toContain("succeeded");
    expect(fake.calls.map((call) => call.role)).toEqual(["reviewer"]);
    expect(pricingCalls).toBe(1);
    expect(
      await command(repo.path, "git", [
        "rev-list",
        "--count",
        `${repo.base}..${output.retainedLocation.label}`,
      ]),
    ).toBe("1");
  });

  it("holds one exclusive direct-mode repository lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-direct-lock-"));
    const repo = await repository(root);
    const stateDirectory = join(root, "state");
    const first = await prepareJobWorkspace({
      repository: repo.path,
      stateDirectory,
      jobId: "direct-one",
      key: "RUN-3",
      kind: "task",
      expectedBaseRevision: repo.base,
      config: config("direct"),
    });
    await expect(
      prepareJobWorkspace({
        repository: repo.path,
        stateDirectory,
        jobId: "direct-two",
        key: "RUN-4",
        kind: "task",
        expectedBaseRevision: repo.base,
        config: config("direct"),
      }),
    ).rejects.toThrow(/locked by RunnerJob direct-one/);
    await releaseJobWorkspace(first, "direct-one");
    const second = await prepareJobWorkspace({
      repository: repo.path,
      stateDirectory,
      jobId: "direct-two",
      key: "RUN-4",
      kind: "task",
      expectedBaseRevision: repo.base,
      config: config("direct"),
    });
    await releaseJobWorkspace(second, "direct-two");
  });

  it("recovers a direct acceptance that completed before its journal acknowledgement", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-direct-receipt-gap-"));
    const repo = await repository(root);
    const stateDirectory = join(root, "state");
    const backend = new GitWorkspaceBackend();
    const workspace = await backend.openJob({
      repository: repo.path,
      stateDirectory,
      jobId: "direct-gap",
      key: "RUN-9",
      kind: "task",
      expectedBaseRevision: repo.base,
      config: config("direct"),
    });
    const durableHandle = structuredClone(workspace.handle);
    durableHandle.state.acceptingTask = "RUN-9";
    workspace.handle.state.acceptingTask = "RUN-9";
    const task = await backend.beginTask(workspace, "RUN-9");
    await writeFile(
      join(task.path, "accepted-before-journal.txt"),
      "accepted\n",
    );
    const staged = await backend.stageCandidate({
      workspace,
      task,
      taskKey: "RUN-9",
      summary: "accepted",
      refresh: false,
    });
    if (staged.status !== "ready") throw new Error("candidate not ready");
    const accepted = await backend.acceptCandidate({
      workspace,
      task,
      candidate: staged.checkpoint,
      taskKey: "RUN-9",
    });
    await backend.release(workspace, "direct-gap");

    const restored = await backend.restoreJob({
      repository: repo.path,
      stateDirectory,
      jobId: "direct-gap",
      handle: durableHandle,
      mode: "direct",
      baseRevision: repo.base,
      currentRevision: repo.base,
    });
    expect(restored.currentRevision).toBe(accepted.ref);
    const replayed = await backend.acceptCandidate({
      workspace: restored,
      task,
      candidate: staged.checkpoint,
      taskKey: "RUN-9",
    });
    expect(replayed.ref).toBe(accepted.ref);
    expect(
      await command(repo.path, "git", [
        "rev-list",
        "--count",
        `${repo.base}..HEAD`,
      ]),
    ).toBe("1");
    await backend.release(restored, "direct-gap");
  });
});
