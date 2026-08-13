import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { projectConfigSchema } from "../src/config.js";
import { jobAssignmentSchema } from "../src/contracts.js";
import { ClaudeAgentDriver } from "../src/drivers/claude.js";
import { CodexAgentDriver } from "../src/drivers/codex.js";
import {
  loadDurableJobState,
  MemoryEventSink,
  RunnerJobSupervisor,
} from "../src/supervisor.js";
import { GitSourceControlBackend } from "../src/vcs/git.js";

const execute = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execute("git", args, { cwd });
  return result.stdout.trim();
}

if (process.env.RUNNER_LIVE_AGENTS !== "yes-i-understand")
  throw new Error(
    "set RUNNER_LIVE_AGENTS=yes-i-understand to permit real model calls",
  );

const sourceArgument = process.argv[2];
if (!sourceArgument)
  throw new Error(
    "usage: npm run dogfood:live-agents -- /path/to/git/repository",
  );

const source = resolve(sourceArgument);
const sourceBranch = await git(source, "branch", "--show-current");
if (!sourceBranch) throw new Error(`${source} is not on a named Git branch`);
const temporary = await mkdtemp(join(tmpdir(), "noriq-runner-live-agents-"));
let succeeded = false;

try {
  const repository = join(temporary, "repository");
  await execute("git", [
    "clone",
    "--quiet",
    "--no-local",
    "--branch",
    sourceBranch,
    source,
    repository,
  ]);
  await git(repository, "config", "user.email", "runner-live@example.test");
  await git(repository, "config", "user.name", "Runner Live Dogfood");
  const base = await git(repository, "rev-parse", "HEAD");
  const stateDirectory = join(temporary, "state");
  const codex = new CodexAgentDriver(
    "codex",
    {
      adapter: "codex",
      command: process.env.RUNNER_LIVE_CODEX_COMMAND ?? "codex",
      args: [],
      env: {},
      home:
        process.env.RUNNER_LIVE_CODEX_HOME ?? join(homedir(), ".noriq/codex"),
    },
    stateDirectory,
  );
  const claude = new ClaudeAgentDriver(
    "claude",
    {
      adapter: "claude",
      command: process.env.RUNNER_LIVE_CLAUDE_COMMAND ?? "claude",
      args: [],
      env: {},
      home:
        process.env.RUNNER_LIVE_CLAUDE_HOME ?? join(homedir(), ".noriq/claude"),
    },
    stateDirectory,
  );
  const project = projectConfigSchema.parse({
    key: "LIVE",
    repositoryKey: "runner-live-agent-dogfood",
    defaultBranch: sourceBranch,
    sourceControl: { backend: "git", mode: "isolated", base: sourceBranch },
    harness: { maxParallelTasks: 1, maxRepairRounds: 1, maxJobMinutes: 15 },
    agents: {
      guide: {
        driver: "codex",
        model: process.env.RUNNER_LIVE_CODEX_MODEL ?? "gpt-5.6-sol",
        effort: "low",
      },
      builder: {
        driver: "claude",
        model: process.env.RUNNER_LIVE_CLAUDE_MODEL ?? "sonnet",
        effort: "low",
      },
      reviewer: {
        driver: "codex",
        model: process.env.RUNNER_LIVE_CODEX_MODEL ?? "gpt-5.6-sol",
        effort: "low",
      },
    },
    setup: { commands: [], timeoutSeconds: 30 },
    checks: {
      commands: [
        'test "$(cat .noriq-runner-live-smoke)" = "runner-live-smoke"',
      ],
      timeoutSeconds: 30,
    },
  });
  const assignment = jobAssignmentSchema.parse({
    protocolVersion: 2,
    jobId: "live-agent-smoke",
    assignmentId: "live-agent-smoke-assignment",
    snapshotDigest: createHash("sha256")
      .update(`${source}:${base}`)
      .digest("hex"),
    repoRef: project.repositoryKey,
    expectedBaseRevision: base,
    source: {
      kind: "task",
      projectId: "live-dogfood",
      projectKey: "LIVE",
      task: {
        taskId: "live-agent-smoke-task",
        key: "LIVE-1",
        title: "Create one harmless Runner live-smoke marker",
        body: [
          "Create a file named .noriq-runner-live-smoke at the repository root.",
          "Its complete content must be exactly runner-live-smoke followed by one newline.",
          "Do not modify any other file.",
        ].join(" "),
        executionSpec: {
          requirementIds: ["LIVE-1"],
          anticipatedFiles: [
            {
              path: ".noriq-runner-live-smoke",
              change: "create",
              why: "Provide the disposable live-run proof marker",
            },
          ],
          requiredReading: [],
          lockedDecisions: [
            {
              decision: "Change only .noriq-runner-live-smoke",
              because: "This is a harmless source-control and agent smoke test",
              source: "LIVE-1",
            },
          ],
          discretion: [],
          deferred: ["All existing project files"],
          acceptance: {
            observableTruths: [
              ".noriq-runner-live-smoke contains exactly runner-live-smoke followed by one newline",
            ],
            artifacts: [
              {
                path: ".noriq-runner-live-smoke",
                provides: "the disposable live-run proof marker",
                exports: [],
              },
            ],
            links: [],
          },
          steps: [],
        },
        status: "todo",
        retry: false,
        order: 0,
        phaseOrder: 0,
      },
    },
  });
  const sink = new MemoryEventSink();
  const output = await new RunnerJobSupervisor({
    assignment,
    repository,
    stateDirectory,
    projectConfig: project,
    backend: new GitSourceControlBackend("git"),
    drivers: { codex, claude },
    sink,
  }).run();
  if (!output.summary.startsWith("succeeded:"))
    throw new Error(`live dogfood did not succeed: ${JSON.stringify(output)}`);
  if (output.dirtyPaths.length > 0)
    throw new Error(
      `retained output is dirty: ${output.dirtyPaths.join(", ")}`,
    );
  if ((await git(repository, "rev-parse", sourceBranch)) !== base)
    throw new Error("source branch moved during isolated live dogfood");
  const marker = await git(
    repository,
    "show",
    `${output.retainedLocation.label}:.noriq-runner-live-smoke`,
  );
  if (marker !== "runner-live-smoke")
    throw new Error(`retained marker has unexpected content: ${marker}`);
  const changed = await git(
    repository,
    "diff",
    "--name-only",
    base,
    output.headRevision,
  );
  if (changed !== ".noriq-runner-live-smoke")
    throw new Error(`live agents changed unexpected paths: ${changed}`);
  const durable = await loadDurableJobState(stateDirectory, assignment.jobId);
  if (!durable) throw new Error("live dogfood durable state is unavailable");
  succeeded = true;
  process.stdout.write(
    `${JSON.stringify(
      {
        source,
        base,
        retained: output.retainedLocation,
        headRevision: output.headRevision,
        usage: output.usage,
        invocations: Object.values(durable.invocations).map((invocation) => ({
          role: invocation.role,
          status: invocation.status,
          usage: invocation.usage ?? null,
        })),
        events: sink.events.length,
        changedPaths: [changed],
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (process.env.RUNNER_LIVE_KEEP !== "1")
    await rm(temporary, { recursive: true, force: true });
  else
    process.stderr.write(
      `${succeeded ? "live dogfood" : "failed live dogfood"} evidence retained at ${temporary}\n`,
    );
}
