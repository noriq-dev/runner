import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEphemeralAgentHome } from "../src/agent-home.js";
import { type MachineConfig, projectConfigSchema } from "../src/config.js";
import { ClaudeAgentDriver } from "../src/drivers/claude.js";
import { CodexAgentDriver } from "../src/drivers/codex.js";

const projectConfig = projectConfigSchema.parse({
  key: "RUN",
  repositoryKey: "repo",
  defaultBranch: "main",
  workspace: { mode: "isolated", baseBranch: "main" },
  harness: { maxParallelTasks: 1, maxRepairRounds: 1, maxJobMinutes: 1 },
  agents: {
    guide: { driver: "codex", model: "guide", effort: "high" },
    builder: { driver: "codex", model: "builder", effort: "medium" },
    reviewer: { driver: "codex", model: "reviewer", effort: "high" },
  },
  setup: { commands: [], timeoutSeconds: 30 },
  checks: { commands: [], timeoutSeconds: 30 },
});

async function credentialHome(
  root: string,
  vendor: "codex" | "claude",
  name = `${vendor}-home`,
): Promise<string> {
  const home = join(root, name);
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, vendor === "codex" ? "auth.json" : ".credentials.json"),
    "{}",
  );
  if (vendor === "claude")
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({ machineID: "test", projects: {} }),
    );
  return home;
}

async function fakeCodex(root: string): Promise<string> {
  const path = join(root, "fake-codex.mjs");
  await writeFile(
    path,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (process.env.FAKE_ENV_LOG) appendFileSync(process.env.FAKE_ENV_LOG, JSON.stringify({ home: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR }) + '\\n');
if (args.includes('--version')) { console.log('fake-codex 1.0'); process.exit(0); }
if (args.includes('--help')) { console.log('--output-schema --json --ignore-user-config'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') { console.log('logged in'); process.exit(0); }
if (args[0] === 'mcp' && args[1] === 'list') {
  const servers = [];
  if (!process.env.OMIT_CONTROL) servers.push({ name: 'noriq_runner', enabled: true });
  if (existsSync(join(process.cwd(), '.codex', 'config.toml'))) servers.push({ name: 'project_echo', enabled: true });
  console.log(JSON.stringify(servers));
  process.exit(0);
}
if (process.env.REQUIRE_PROJECT_MCP === '1' && !existsSync(join(process.cwd(), '.codex', 'config.toml'))) process.exit(9);
const outputIndex = args.indexOf('--output-last-message');
if (process.env.MALFORMED !== '1' && outputIndex >= 0) writeFileSync(args[outputIndex + 1], JSON.stringify({ summary: 'built', findings: [] }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 4 } }));
`,
    { mode: 0o700 },
  );
  await chmod(path, 0o700);
  return path;
}

async function fakeClaude(root: string): Promise<string> {
  const path = join(root, "fake-claude.mjs");
  await writeFile(
    path,
    `#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fake-claude 1.0'); process.exit(0); }
if (args.includes('--help')) { console.log('--output-format --json-schema --strict-mcp-config --no-session-persistence --system-prompt'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') { console.log('{"authenticated":true}'); process.exit(0); }
if (process.env.REQUIRE_PROJECT_MCP === '1' && !existsSync(join(process.cwd(), '.mcp.json'))) process.exit(9);
if (process.env.REQUIRE_PROJECT_ALLOWED === '1' && !args.includes('mcp__project_echo')) process.exit(10);
if (process.env.REJECT_BASH === '1' && args.some((arg) => arg.includes('Bash'))) process.exit(11);
if (process.env.AUTH_FAILURE === '1') {
  console.log(JSON.stringify({ type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Failed to authenticate: OAuth session expired and could not be refreshed' }] } }));
  console.log(JSON.stringify({ type: 'result', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' }));
  process.exit(1);
}
const tools = ['ask_human', 'delegate', 'get_job_state', 'inspect_diff', 'record_task_plan', 'request_completion', 'run_checks'].map((tool) => 'mcp__noriq_runner__' + tool);
console.log(JSON.stringify({ type: 'system', subtype: 'init', tools: process.env.OMIT_CONTROL === '1' ? [] : tools, mcp_servers: [{ name: 'noriq_runner', status: process.env.OMIT_CONTROL === '1' ? 'failed' : 'connected' }] }));
console.log(JSON.stringify({ type: 'result', structured_output: { summary: 'built', findings: [] }, usage: { input_tokens: 8, cache_read_input_tokens: 2, cache_creation_input_tokens: 5, output_tokens: 3 } }));
`,
    { mode: 0o700 },
  );
  await chmod(path, 0o700);
  return path;
}

describe("built-in driver contract", () => {
  it("serializes and advances copied Claude credentials without blocking distinct homes", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-claude-lease-"));
    const state = join(root, "state");
    const sharedHome = await credentialHome(root, "claude", "shared");
    const distinctHome = await credentialHome(root, "claude", "distinct");
    const initialCredential = JSON.stringify({
      claudeAiOauth: {
        accessToken: "access-initial",
        refreshToken: "refresh-initial",
        expiresAt: 1,
      },
    });
    const rotatedCredential = JSON.stringify({
      claudeAiOauth: {
        accessToken: "access-rotated",
        refreshToken: "refresh-rotated",
        expiresAt: 2,
      },
    });
    await writeFile(join(sharedHome, ".credentials.json"), initialCredential);
    const first = await createEphemeralAgentHome("claude", sharedHome, state);

    const controller = new AbortController();
    const cancelled = createEphemeralAgentHome("claude", sharedHome, state, {
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort(new Error("cancelled while queued"));
    await expect(cancelled).rejects.toThrow(/cancelled while queued/);

    let successorResolved = false;
    const successorPromise = createEphemeralAgentHome(
      "claude",
      sharedHome,
      state,
    ).then((home) => {
      successorResolved = true;
      return home;
    });
    const independent = await createEphemeralAgentHome(
      "claude",
      distinctHome,
      state,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(successorResolved).toBe(false);

    await independent.cleanup();
    await writeFile(join(first.path, ".credentials.json"), rotatedCredential);
    await first.cleanup();
    const successor = await successorPromise;
    expect(
      await readFile(join(successor.path, ".credentials.json"), "utf8"),
    ).toBe(rotatedCredential);
    expect(await readFile(join(sharedHome, ".credentials.json"), "utf8")).toBe(
      rotatedCredential,
    );
    await successor.cleanup();
    expect(await readdir(join(state, "agent-homes"))).toEqual([]);
  });

  it("does not persist invalid Claude credentials or overwrite an external re-login", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-claude-sync-"));
    const state = join(root, "state");
    const home = await credentialHome(root, "claude");
    const credential = (suffix: string) =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: `access-${suffix}`,
          refreshToken: `refresh-${suffix}`,
          expiresAt: 1,
        },
      });
    const initial = credential("initial");
    await writeFile(join(home, ".credentials.json"), initial);

    const invalidAttempt = await createEphemeralAgentHome(
      "claude",
      home,
      state,
    );
    await writeFile(
      join(invalidAttempt.path, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 },
      }),
    );
    await invalidAttempt.cleanup();
    expect(await readFile(join(home, ".credentials.json"), "utf8")).toBe(
      initial,
    );

    const externalAttempt = await createEphemeralAgentHome(
      "claude",
      home,
      state,
    );
    await writeFile(
      join(externalAttempt.path, ".credentials.json"),
      credential("attempt"),
    );
    const external = credential("external");
    await writeFile(join(home, ".credentials.json"), external);
    await externalAttempt.cleanup();
    expect(await readFile(join(home, ".credentials.json"), "utf8")).toBe(
      external,
    );
    expect(await readdir(join(state, "agent-homes"))).toEqual([]);
  });

  it("verifies auth/structured output/control MCP and isolates the driver home", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-driver-"));
    const command = await fakeCodex(root);
    const envLog = join(root, "env.jsonl");
    const home = await credentialHome(root, "codex");
    const driverConfig: Extract<
      MachineConfig["drivers"][string],
      { adapter: "codex" }
    > = {
      adapter: "codex",
      command,
      args: [],
      home,
      env: { FAKE_ENV_LOG: envLog },
    };
    const adapter = new CodexAgentDriver(
      "codex",
      driverConfig,
      join(root, "state"),
    );
    await expect(
      adapter.preflight({
        workspace: root,
        access: "workspace-write",
        requireControlMcp: true,
      }),
    ).resolves.toMatchObject({
      authenticated: true,
      capabilities: { structuredOutput: true },
      runnerControlVisible: true,
    });
    const result = await adapter.invoke({
      invocationId: "invocation",
      role: "builder",
      taskId: "task",
      taskKey: "RUN-1",
      workspace: root,
      access: "workspace-write",
      prompt: "build",
      outputSchema: { type: "object" },
      projectConfig,
    });
    expect(result.usage).toMatchObject({
      inputTokens: 9,
      cachedTokens: 3,
      outputTokens: 4,
    });
    const observations = (await readFile(envLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      observations.every(
        (entry) =>
          entry.home !== driverConfig.home &&
          entry.home.startsWith(join(root, "state", "agent-homes")) &&
          !entry.claude,
      ),
    ).toBe(true);
    expect(await readdir(join(root, "state", "agent-homes"))).toEqual([]);
  });

  it("fails closed when the guide control MCP or structured result is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-driver-fail-"));
    const command = await fakeCodex(root);
    const home = await credentialHome(root, "codex", "home");
    const base: Extract<
      MachineConfig["drivers"][string],
      { adapter: "codex" }
    > = {
      adapter: "codex",
      command,
      args: [],
      home,
      env: { OMIT_CONTROL: "1" },
    };
    const missing = new CodexAgentDriver("codex", base, join(root, "state-a"));
    await expect(
      missing.preflight({
        workspace: root,
        access: "read-only",
        requireControlMcp: true,
      }),
    ).rejects.toThrow(/did not expose/);
    const malformed = new CodexAgentDriver(
      "codex",
      {
        ...base,
        env: { MALFORMED: "1" },
      },
      join(root, "state-b"),
    );
    await expect(
      malformed.invoke({
        invocationId: "malformed",
        role: "builder",
        taskId: "task",
        taskKey: "RUN-2",
        workspace: root,
        access: "workspace-write",
        prompt: "build",
        outputSchema: { type: "object" },
        projectConfig,
      }),
    ).rejects.toThrow();
  });

  it("leaves project-native MCP configuration usable by both vendor builders", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-project-mcp-"));
    await mkdir(join(root, ".codex"));
    await writeFile(
      join(root, ".codex", "config.toml"),
      '[mcp_servers.project_echo]\ncommand = "project-echo"\n',
    );
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: { project_echo: { command: "project-echo" } },
      }),
    );
    const state = join(root, "state");
    const codexHome = await credentialHome(root, "codex");
    const claudeHome = await credentialHome(root, "claude");
    const adapters = [
      new CodexAgentDriver(
        "codex",
        {
          adapter: "codex",
          command: await fakeCodex(root),
          args: [],
          home: codexHome,
          env: { REQUIRE_PROJECT_MCP: "1" },
        },
        state,
      ),
      new ClaudeAgentDriver(
        "claude",
        {
          adapter: "claude",
          command: await fakeClaude(root),
          args: [],
          home: claudeHome,
          env: {
            REQUIRE_PROJECT_MCP: "1",
            REQUIRE_PROJECT_ALLOWED: "1",
            REJECT_BASH: "1",
          },
        },
        state,
      ),
    ];

    for (const adapter of adapters) {
      const preflight = await adapter.preflight({
        workspace: root,
        access: "read-only",
        requireControlMcp: true,
      });
      expect(preflight).toMatchObject({
        runnerControlVisible: true,
      });
      expect(preflight.projectTools).toEqual(
        adapter.name === "codex" ? ["project_echo"] : [],
      );
      const result = await adapter.invoke({
        invocationId: `project-mcp-${adapter.name}`,
        role: "builder",
        taskId: "task",
        taskKey: "RUN-3",
        workspace: root,
        access: "workspace-write",
        prompt: "use project echo",
        outputSchema: { type: "object" },
        projectConfig,
      });
      expect(result).toMatchObject({ summary: "built" });
      if (adapter.name === "claude")
        expect(result.usage).toMatchObject({
          inputTokens: 8,
          cachedTokens: 7,
          outputTokens: 3,
        });
    }
    await expect(
      access(join(root, ".claude", "settings.local.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { "--settings": { command: "bad" } } }),
    );
    await expect(
      adapters[1]!.invoke({
        invocationId: "unsafe-project-mcp-name",
        role: "builder",
        taskId: "task",
        taskKey: "RUN-3",
        workspace: root,
        access: "workspace-write",
        prompt: "build",
        outputSchema: { type: "object" },
        projectConfig,
      }),
    ).rejects.toThrow(/unsafe server name/);
  });

  it("rejects a Claude guide result when the effective control MCP is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-claude-control-"));
    const home = await credentialHome(root, "claude");
    const adapter = new ClaudeAgentDriver(
      "claude",
      {
        adapter: "claude",
        command: await fakeClaude(root),
        args: [],
        home,
        env: { OMIT_CONTROL: "1" },
      },
      join(root, "state"),
    );
    await expect(
      adapter.invoke({
        invocationId: "missing-claude-control",
        role: "guide",
        taskId: "task",
        taskKey: "RUN-4",
        workspace: root,
        access: "read-only",
        prompt: "plan",
        outputSchema: { type: "object" },
        projectConfig,
      }),
    ).rejects.toThrow(/did not connect/);
  });

  it("retains a bounded structured Claude failure reason and provider code", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-claude-failure-"));
    const home = await credentialHome(root, "claude");
    const state = join(root, "state");
    const adapter = new ClaudeAgentDriver(
      "claude",
      {
        adapter: "claude",
        command: await fakeClaude(root),
        args: [],
        home,
        env: { AUTH_FAILURE: "1" },
      },
      state,
    );
    await expect(
      adapter.invoke({
        invocationId: "claude-auth-failure",
        role: "builder",
        taskId: "task",
        taskKey: "RUN-5",
        workspace: root,
        access: "workspace-write",
        prompt: "build",
        outputSchema: { type: "object" },
        projectConfig,
      }),
    ).rejects.toMatchObject({
      code: "authentication_failed",
      message: expect.stringContaining(
        "OAuth session expired and could not be refreshed",
      ),
    });
    expect(await readdir(join(state, "agent-homes"))).toEqual([]);
    await expect(
      readFile(
        join(state, "artifacts", "claude-auth-failure", "driver.log"),
        "utf8",
      ),
    ).resolves.toContain('"error":"authentication_failed"');
  });
});
