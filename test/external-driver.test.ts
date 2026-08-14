import { access, chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type MachineConfig, projectConfigSchema } from "../src/config.js";
import { ExternalJsonlV1Driver } from "../src/drivers/external.js";

const capabilities = {
  structuredOutput: true as const,
  workspaceAccess: ["read-only", "workspace-write"] as const,
  runnerControlMcpInjection: true,
  projectNativeConfiguration: true,
  usageAccuracy: "exact" as const,
  hardBudget: true,
  processTreeTermination: true,
};

const project = projectConfigSchema.parse({
  key: "RUN",
  repositoryKey: "repo",
  defaultBranch: "main",
  sourceControl: { backend: "auto", mode: "isolated", base: "main" },
  harness: { maxParallelTasks: 1, maxRepairRounds: 1, maxJobMinutes: 1 },
  agents: {
    guide: { driver: "external", model: "guide", effort: "high" },
    builder: { driver: "external", model: "builder", effort: "medium" },
    reviewer: { driver: "external", model: "reviewer", effort: "high" },
  },
  setup: { commands: [], timeoutSeconds: 30 },
  checks: { commands: [], timeoutSeconds: 30 },
});

async function fixture(root: string): Promise<string> {
  const path = join(root, "external.mjs");
  await writeFile(
    path,
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const mode = process.argv[2] ?? "ok";
const frame = (value) => process.stdout.write(JSON.stringify({ protocol: "noriq-agent-driver", version: 1, ...value }) + "\\n");
if (mode === "malformed") { process.stdout.write("not json\\n"); process.exit(0); }
if (mode === "hang") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(process.env.CHILD_PID_FILE, String(child.pid));
  setInterval(() => {}, 1000);
} else if (request.type === "preflight") {
  const caps = mode === "drift" ? { ...request.capabilities, hardBudget: false } : request.capabilities;
  frame({ type: "preflight-result", driverVersion: "fake-1", authenticated: true, runnerControlVisible: true, projectTools: ["project.echo"], warnings: [], capabilities: caps });
} else {
  frame({ type: "event", event: { type: "status", at: new Date().toISOString(), message: "working" } });
  frame({ type: "result", capabilities: request.capabilities, result: { success: true, summary: "done", findings: [], usage: { inputTokens: 2, outputTokens: 1, cachedTokens: 0, costUsd: 0, calls: 1 }, structured: { summary: "done" } } });
  if (mode === "duplicate") frame({ type: "result", capabilities: request.capabilities, result: {} });
  if (mode === "post") frame({ type: "event", event: { type: "status", at: new Date().toISOString() } });
}
`,
  );
  await chmod(path, 0o700);
  return path;
}

function config(
  script: string,
  mode: string,
  env: Record<string, string> = {},
): Extract<MachineConfig["drivers"][string], { adapter: "external-jsonl-v1" }> {
  return {
    adapter: "external-jsonl-v1",
    command: process.execPath,
    args: [script, mode],
    env,
    capabilities: {
      workspaceAccess: [...capabilities.workspaceAccess],
      runnerControlMcpInjection: true,
      projectNativeConfiguration: true,
      usageAccuracy: "exact",
      hardBudget: true,
      processTreeTermination: true,
    },
  };
}

function invocation(root: string) {
  return {
    invocationId: "invocation",
    role: "builder" as const,
    taskId: "task",
    taskKey: "RUN-1",
    workspace: root,
    access: "workspace-write" as const,
    prompt: "build",
    outputSchema: { type: "object" },
    profile: {
      ...project.agents.builder.balanced,
      vendor: null,
    },
    timeoutMs: 60_000,
  };
}

describe("external-jsonl-v1 driver", () => {
  it("normalizes events and one terminal result", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-external-ok-"));
    const driver = new ExternalJsonlV1Driver(
      "external",
      config(await fixture(root), "ok"),
      join(root, "state"),
    );
    await expect(
      driver.preflight({
        workspace: root,
        access: "read-only",
        requireControlMcp: true,
      }),
    ).resolves.toMatchObject({
      authenticated: true,
      runnerControlVisible: true,
    });
    const session = await driver.start(invocation(root));
    await expect(session.result()).resolves.toMatchObject({
      summary: "done",
      usage: { inputTokens: 2, outputTokens: 1 },
    });
    const events = [];
    for await (const event of session.events()) events.push(event);
    expect(events).toMatchObject([{ type: "status", message: "working" }]);
  });

  it.each(["malformed", "duplicate", "post"])(
    "fails closed for %s output",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), `runner-external-${mode}-`));
      const driver = new ExternalJsonlV1Driver(
        "external",
        config(await fixture(root), mode),
        join(root, "state"),
      );
      const session = await driver.start(invocation(root));
      await expect(session.result()).rejects.toThrow();
    },
  );

  it("rejects capability drift during preflight", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-external-drift-"));
    const driver = new ExternalJsonlV1Driver(
      "external",
      config(await fixture(root), "drift"),
      join(root, "state"),
    );
    await expect(
      driver.preflight({
        workspace: root,
        access: "read-only",
        requireControlMcp: true,
      }),
    ).rejects.toThrow(/capability drift/);
  });

  it("terminates the managed process tree on cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-external-cancel-"));
    const pidFile = join(root, "child.pid");
    const driver = new ExternalJsonlV1Driver(
      "external",
      config(await fixture(root), "hang", { CHILD_PID_FILE: pidFile }),
      join(root, "state"),
    );
    const session = await driver.start(invocation(root));
    for (let index = 0; index < 100; index += 1) {
      try {
        await access(pidFile);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const childPid = Number(await readFile(pidFile, "utf8"));
    await session.cancel();
    let running = true;
    for (let index = 0; index < 50; index += 1) {
      try {
        const state = (await readFile(`/proc/${childPid}/stat`, "utf8")).split(
          " ",
        )[2];
        running = state !== "Z";
      } catch {
        running = false;
      }
      if (!running) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(running).toBe(false);
  });
});
