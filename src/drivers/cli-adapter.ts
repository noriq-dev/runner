import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createEphemeralAgentHome,
  initializeClaudeProjectState,
} from "../agent-home.js";
import type { MachineConfig } from "../config.js";
import { findingSchema, usageSchema } from "../contracts.js";
import { controlMcpCommand } from "../control-mcp-command.js";
import { runProcess } from "../process.js";
import type {
  AgentDriver,
  AgentDriverCapabilities,
  AgentRequest,
  AgentResult,
  DriverPreflight,
  DriverPreflightRequest,
} from "./types.js";
import { type AgentSession, PromiseAgentSession } from "./types.js";

function parseLastObject(text: string): Record<string, unknown> {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]!);
      if (value && typeof value === "object" && !Array.isArray(value))
        return value as Record<string, unknown>;
    } catch {}
  }
  throw new Error("driver produced no structured JSON object");
}

const runnerControlServer = "noriq_runner";
const runnerControlTools = [
  "ask_human",
  "delegate",
  "get_job_state",
  "inspect_diff",
  "record_task_plan",
  "request_completion",
  "run_checks",
] as const;

function claudeSystemPrompt(role: AgentRequest["role"]): string {
  if (role === "guide")
    return "Act as an unattended task planner. Do not edit files. Use only the supplied Runner Control tools when needed, and return the required structured output.";
  if (role === "reviewer")
    return "Act as an independent read-only code reviewer. Report only concrete defects introduced by the candidate, and return the required structured output.";
  if (role === "repairer")
    return "Act as an unattended repository repair worker. Obey the task and project instructions, use only supplied tools, do not run shell commands or source-control commands, and return the required structured output. Runner executes the configured deterministic checks after you return.";
  return "Act as an unattended repository builder. Obey the task and project instructions, use only supplied tools, do not run shell commands or source-control commands, and return the required structured output. Runner executes the configured deterministic checks after you return.";
}

function jsonLines(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        const value = JSON.parse(line) as unknown;
        return value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    })
    .filter((value): value is Record<string, unknown> => value !== null);
}

function codexMcpInventory(text: string): Array<Record<string, unknown>> {
  const value = JSON.parse(text) as unknown;
  if (!Array.isArray(value))
    throw new Error("Codex MCP inventory was not a JSON array");
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry),
  );
}

async function claudeProjectMcpConfiguration(
  workspace: string,
): Promise<{ path: string; allowedTools: string[] } | null> {
  const path = join(workspace, ".mcp.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Claude project .mcp.json must be a JSON object");
  const servers = (value as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers))
    throw new Error("Claude project .mcp.json must contain mcpServers");
  const names = Object.keys(servers);
  if (names.length > 100)
    throw new Error("Claude project .mcp.json exceeds 100 servers");
  const unsafeName = names.find(
    (name) => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name),
  );
  if (unsafeName)
    throw new Error(
      `Claude project .mcp.json contains an unsafe server name: ${unsafeName}`,
    );
  return {
    path,
    // Claude's CLI grants every tool on one server with mcp__<serverName>.
    // Runner does not inspect the server commands or tool schemas.
    allowedTools: names.map((name) => `mcp__${name}`),
  };
}

function assertClaudeControlInventory(frames: Record<string, unknown>[]): void {
  const init = frames.find(
    (frame) => frame.type === "system" && frame.subtype === "init",
  );
  if (!init) throw new Error("Claude emitted no runtime tool inventory");
  const servers = Array.isArray(init.mcp_servers) ? init.mcp_servers : [];
  const control = servers.find(
    (server) =>
      server &&
      typeof server === "object" &&
      (server as Record<string, unknown>).name === runnerControlServer,
  ) as Record<string, unknown> | undefined;
  if (control?.status !== "connected")
    throw new Error("Claude did not connect the injected noriq_runner MCP");
  const tools = new Set(
    Array.isArray(init.tools) ? init.tools.map(String) : [],
  );
  const missing = runnerControlTools.filter(
    (tool) => !tools.has(`mcp__${runnerControlServer}__${tool}`),
  );
  if (missing.length > 0)
    throw new Error(
      `Claude Runner Control MCP is missing tools: ${missing.join(", ")}`,
    );
  const unexpectedServers = servers
    .filter(
      (server) =>
        server &&
        typeof server === "object" &&
        (server as Record<string, unknown>).status === "connected" &&
        (server as Record<string, unknown>).name !== runnerControlServer,
    )
    .map((server) => String((server as Record<string, unknown>).name));
  const unexpectedTools = [...tools].filter(
    (tool) =>
      tool.startsWith("mcp__") &&
      !tool.startsWith(`mcp__${runnerControlServer}__`),
  );
  if (unexpectedServers.length > 0 || unexpectedTools.length > 0)
    throw new Error(
      `Claude guide exposed unexpected MCP authority: ${[
        ...unexpectedServers,
        ...unexpectedTools,
      ].join(", ")}`,
    );
}

function configArguments(
  adapter: "codex" | "claude",
  command: { command: string; args: string[] },
): string[] {
  if (adapter === "codex")
    return [
      "--config",
      `mcp_servers.noriq_runner.command=${JSON.stringify(command.command)}`,
      "--config",
      `mcp_servers.noriq_runner.args=${JSON.stringify(command.args)}`,
    ];
  return [
    "--mcp-config",
    JSON.stringify({ mcpServers: { noriq_runner: command } }),
  ];
}

function numberField(
  value: Record<string, unknown>,
  ...names: string[]
): number {
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === "number" && Number.isFinite(candidate))
      return Math.max(0, Math.trunc(candidate));
  }
  return 0;
}

export abstract class BuiltinCliAgentDriver implements AgentDriver {
  readonly id: string;
  readonly capabilities: AgentDriverCapabilities;
  private readonly adapter: "codex" | "claude";
  private readonly config: Extract<
    MachineConfig["drivers"][string],
    { adapter: "codex" | "claude" }
  >;
  private readonly stateDirectory: string;

  constructor(
    adapter: "codex" | "claude",
    config: Extract<
      MachineConfig["drivers"][string],
      { adapter: "codex" | "claude" }
    >,
    stateDirectory: string,
    id: string = adapter,
  ) {
    this.id = id;
    this.adapter = adapter;
    this.config = config;
    this.stateDirectory = stateDirectory;
    this.capabilities = {
      structuredOutput: true,
      workspaceAccess: ["read-only", "workspace-write"],
      runnerControlMcpInjection: true,
      projectNativeConfiguration: true,
      usageAccuracy: adapter === "codex" ? "exact" : "partial",
      hardBudget: false,
      processTreeTermination: true,
    };
  }

  /** @deprecated Kept for source compatibility with the first rebuild prototype. */
  get name(): string {
    return this.id;
  }

  private env(
    workspace: string,
    home: string,
    control?: { state: string; actions: string },
  ): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      ...this.config.env,
    };
    if (this.adapter === "codex") env.CODEX_HOME = home;
    else env.CLAUDE_CONFIG_DIR = home;
    env.NORIQ_JOB_WORKSPACE = workspace;
    if (control) {
      env.NORIQ_CONTROL_STATE = control.state;
      env.NORIQ_CONTROL_ACTIONS = control.actions;
    }
    return env;
  }

  private async restrictedCodexMcpArguments(
    workspace: string,
    home: string,
  ): Promise<string[]> {
    const inventory = await runProcess({
      command: this.config.command,
      args: [...this.config.args, "mcp", "list", "--json"],
      cwd: workspace,
      env: this.env(workspace, home),
      timeoutMs: 30_000,
    });
    if (inventory.exitCode !== 0)
      throw new Error(
        `${this.id} MCP isolation inventory failed: ${inventory.stderr || inventory.stdout}`,
      );
    return codexMcpInventory(inventory.stdout).flatMap((server) => {
      const name = String(server.name ?? "");
      if (!name || name === runnerControlServer) return [];
      return ["--config", `mcp_servers.${JSON.stringify(name)}.enabled=false`];
    });
  }

  async preflight(request: DriverPreflightRequest): Promise<DriverPreflight> {
    const { workspace, requireControlMcp: requireControl } = request;
    if (!this.capabilities.workspaceAccess.includes(request.access))
      throw new Error(
        `${this.id} cannot enforce ${request.access} workspace access`,
      );
    const attemptHome = await createEphemeralAgentHome(
      this.adapter,
      this.config.home,
      this.stateDirectory,
    );
    try {
      if (this.adapter === "claude")
        await initializeClaudeProjectState(
          attemptHome.path,
          workspace,
          requireControl || request.access === "workspace-write",
        );
      const environment = this.env(workspace, attemptHome.path);
      const version = await runProcess({
        command: this.config.command,
        args: ["--version"],
        cwd: workspace,
        env: environment,
        timeoutMs: 30_000,
      });
      if (version.exitCode !== 0)
        throw new Error(
          `${this.id} version preflight failed: ${version.stderr}`,
        );
      const help = await runProcess({
        command: this.config.command,
        args: this.adapter === "codex" ? ["exec", "--help"] : ["--help"],
        cwd: workspace,
        env: environment,
        timeoutMs: 30_000,
      });
      const structuredOutput =
        this.adapter === "codex"
          ? help.stdout.includes("--output-schema") &&
            help.stdout.includes("--json") &&
            help.stdout.includes("--ignore-user-config")
          : help.stdout.includes("--output-format") &&
            help.stdout.includes("--json-schema") &&
            help.stdout.includes("--strict-mcp-config") &&
            help.stdout.includes("--no-session-persistence") &&
            help.stdout.includes("--system-prompt");
      if (!structuredOutput)
        throw new Error(
          `${this.id} does not expose required unattended-mode flags`,
        );
      const auth = await runProcess({
        command: this.config.command,
        args:
          this.adapter === "codex"
            ? ["login", "status"]
            : ["auth", "status", "--json"],
        cwd: workspace,
        env: environment,
        timeoutMs: 30_000,
      });
      const authenticated = auth.exitCode === 0;
      if (!authenticated)
        throw new Error(
          `${this.id} authentication preflight failed: ${auth.stderr || auth.stdout}`,
        );

      let runnerControlVisible = !requireControl;
      let projectTools: string[] = [];
      const warnings: string[] = [];
      if (requireControl && this.adapter === "codex") {
        const control = await controlMcpCommand();
        const injection = configArguments(this.adapter, control);
        const inventory = await runProcess({
          command: this.config.command,
          args: [...this.config.args, "mcp", "list", "--json", ...injection],
          cwd: workspace,
          env: environment,
          timeoutMs: 30_000,
        });
        if (inventory.exitCode !== 0)
          throw new Error(
            `${this.id} MCP inventory failed: ${inventory.stderr || inventory.stdout}`,
          );
        const servers = codexMcpInventory(inventory.stdout);
        runnerControlVisible = servers.some(
          (server) =>
            server.name === runnerControlServer && server.enabled !== false,
        );
        if (!runnerControlVisible)
          throw new Error(
            `${this.id} did not expose the injected noriq_runner MCP`,
          );
        projectTools = servers
          .filter((server) => server.name !== runnerControlServer)
          .map((server) => String(server.name))
          .slice(0, 100);
        warnings.push(
          "Project-native MCP inventory is diagnostic; guide and reviewer calls disable it, while builder and repair calls leave it vendor-native.",
        );
      } else if (requireControl) {
        runnerControlVisible = true;
        warnings.push(
          "Claude cannot inspect one-shot MCP flags without a model call; the guide invocation must attest the effective server and tool inventory before its result is accepted.",
        );
      }
      return {
        driver: this.id,
        version: version.stdout.trim() || version.stderr.trim(),
        authenticated,
        capabilities: this.capabilities,
        runnerControlVisible,
        projectTools,
        warnings,
      };
    } finally {
      await attemptHome.cleanup();
    }
  }

  async recover(invocationId: string): Promise<AgentResult | null> {
    try {
      return JSON.parse(
        await readFile(
          join(this.stateDirectory, "artifacts", invocationId, "receipt.json"),
          "utf8",
        ),
      ) as AgentResult;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async invoke(request: AgentRequest): Promise<AgentResult> {
    const artifactDirectory = join(
      this.stateDirectory,
      "artifacts",
      request.invocationId,
    );
    await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
    const schemaPath = join(artifactDirectory, "schema.json");
    const outputPath = join(artifactDirectory, "result.json");
    const rawLogPath = join(artifactDirectory, "driver.log");
    const controlStatePath = join(artifactDirectory, "control-state.json");
    const controlActionsPath = join(artifactDirectory, "control-actions.jsonl");
    await writeFile(schemaPath, JSON.stringify(request.outputSchema), {
      mode: 0o600,
    });
    await writeFile(
      controlStatePath,
      JSON.stringify({
        invocationId: request.invocationId,
        taskId: request.taskId,
        role: request.role,
      }),
      { mode: 0o600 },
    );
    await writeFile(controlActionsPath, "", { mode: 0o600 });
    let args: string[];
    if (this.adapter === "codex") {
      const profile =
        request.projectConfig.agents[
          request.role === "repairer" ? "builder" : request.role
        ];
      args = [
        ...this.config.args,
        "exec",
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--disable",
        "apps",
        "--disable",
        "plugins",
        "--disable",
        "remote_plugin",
        "--disable",
        "skill_mcp_dependency_install",
        "--disable",
        "multi_agent",
        "--config",
        'web_search="disabled"',
        "--config",
        "tools.view_image=false",
        "--model",
        profile.model,
        "--config",
        `model_reasoning_effort=${JSON.stringify(profile.effort)}`,
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
        "-",
      ];
      if (request.role === "guide" || request.role === "reviewer")
        args.splice(this.config.args.length + 2, 0, "--disable", "shell_tool");
      args.splice(this.config.args.length + 2, 0, "--sandbox", request.access);
    } else {
      const profile =
        request.projectConfig.agents[
          request.role === "repairer" ? "builder" : request.role
        ];
      args = [
        ...this.config.args,
        "-p",
        "--no-session-persistence",
        "--output-format",
        "stream-json",
        "--verbose",
        "--disable-slash-commands",
        "--no-chrome",
        "--prompt-suggestions",
        "false",
        "--system-prompt",
        claudeSystemPrompt(request.role),
        "--model",
        profile.model,
        "--effort",
        profile.effort === "xhigh" ||
        profile.effort === "max" ||
        profile.effort === "ultra"
          ? "high"
          : profile.effort,
        "--json-schema",
        JSON.stringify(request.outputSchema),
      ];
      if (request.role === "guide" || request.role === "reviewer")
        args.push(
          "--strict-mcp-config",
          "--setting-sources",
          "user",
          "--tools",
          "",
        );
      else {
        args.push(
          "--setting-sources",
          "project",
          "--tools",
          "Edit,Glob,Grep,Read,Write",
          "--strict-mcp-config",
        );
        const projectMcp = await claudeProjectMcpConfiguration(
          request.workspace,
        );
        if (projectMcp) {
          args.push("--mcp-config", projectMcp.path);
          if (projectMcp.allowedTools.length > 0)
            args.push("--allowedTools", ...projectMcp.allowedTools);
        }
      }
      if (request.access === "read-only")
        args.push(
          "--permission-mode",
          "plan",
          "--disallowedTools",
          "Write,Edit,NotebookEdit",
        );
      else args.push("--permission-mode", "acceptEdits");
      if (request.role === "guide")
        args.push(
          "--settings",
          JSON.stringify({ enableAllProjectMcpServers: true }),
          "--allowedTools",
          `mcp__${runnerControlServer}`,
        );
    }
    if (request.role === "guide") {
      const injection = configArguments(
        this.adapter,
        await controlMcpCommand(),
      );
      if (this.adapter === "codex")
        args.splice(args.length - 1, 0, ...injection);
      else args.push(...injection);
    }
    const attemptHome = await createEphemeralAgentHome(
      this.adapter,
      this.config.home,
      this.stateDirectory,
    );
    const result = await (async () => {
      try {
        if (this.adapter === "claude")
          await initializeClaudeProjectState(
            attemptHome.path,
            request.workspace,
            request.role === "guide",
          );
        if (
          this.adapter === "codex" &&
          (request.role === "guide" || request.role === "reviewer")
        )
          args.splice(
            args.length - 1,
            0,
            ...(await this.restrictedCodexMcpArguments(
              request.workspace,
              attemptHome.path,
            )),
          );
        return await runProcess({
          command: this.config.command,
          args,
          cwd: request.workspace,
          env: this.env(request.workspace, attemptHome.path, {
            state: controlStatePath,
            actions: controlActionsPath,
          }),
          timeoutMs: request.projectConfig.harness.maxJobMinutes * 60_000,
          ...(request.signal ? { signal: request.signal } : {}),
          stdin: request.prompt,
          maxOutputBytes: 8 * 1024 * 1024,
        });
      } finally {
        await attemptHome.cleanup();
      }
    })();
    await writeFile(rawLogPath, `${result.stdout}\n${result.stderr}`, {
      mode: 0o600,
    });
    if (result.exitCode !== 0 || result.timedOut)
      throw new Error(
        `${this.id} invocation failed (${result.exitCode ?? result.signal}): ${result.stderr.slice(-4_000)}`,
      );
    const frames = jsonLines(result.stdout);
    if (this.adapter === "claude" && request.role === "guide")
      assertClaudeControlInventory(frames);
    let structured: Record<string, unknown>;
    if (this.adapter === "codex") {
      structured = JSON.parse(await readFile(outputPath, "utf8"));
    } else {
      const final = [...frames]
        .reverse()
        .find((frame) => frame.type === "result");
      const candidate = final?.structured_output ?? final?.result;
      structured =
        typeof candidate === "string"
          ? parseLastObject(candidate)
          : ((candidate as Record<string, unknown> | undefined) ??
            parseLastObject(result.stdout));
    }
    const findings = Array.isArray(structured.findings)
      ? structured.findings.map((finding) => findingSchema.parse(finding))
      : [];
    const finalFrame = [...frames]
      .reverse()
      .find(
        (frame) => frame.type === "result" || frame.type === "turn.completed",
      );
    const frameUsage =
      finalFrame && typeof finalFrame.usage === "object" && finalFrame.usage
        ? (finalFrame.usage as Record<string, unknown>)
        : {};
    const reportedUsage =
      typeof structured.usage === "object" && structured.usage
        ? (structured.usage as Record<string, unknown>)
        : frameUsage;
    const reportedInput = numberField(
      reportedUsage,
      "inputTokens",
      "input_tokens",
    );
    const cacheRead = numberField(
      reportedUsage,
      "cachedTokens",
      "cached_input_tokens",
      "cache_read_input_tokens",
    );
    const cacheCreation = numberField(
      reportedUsage,
      "cacheCreationTokens",
      "cache_creation_input_tokens",
    );
    const usage = usageSchema.parse({
      inputTokens:
        this.adapter === "codex"
          ? Math.max(0, reportedInput - cacheRead)
          : reportedInput,
      outputTokens: numberField(reportedUsage, "outputTokens", "output_tokens"),
      cachedTokens: cacheRead + cacheCreation,
      costUsd:
        typeof reportedUsage.costUsd === "number"
          ? reportedUsage.costUsd
          : typeof finalFrame?.total_cost_usd === "number"
            ? finalFrame.total_cost_usd
            : null,
      calls: 1,
    });
    const agentResult: AgentResult = {
      success: true,
      summary: String(structured.summary ?? "Completed"),
      ...(typeof structured.plan === "string" ? { plan: structured.plan } : {}),
      findings,
      usage,
      rawLogPath,
      structured,
    };
    const actionText = await readFile(controlActionsPath, "utf8");
    const controlActions = actionText
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            at: string;
            name: string;
            args: Record<string, unknown>;
          },
      );
    if (controlActions.length > 0) agentResult.controlActions = controlActions;
    await writeFile(
      join(artifactDirectory, "receipt.json"),
      JSON.stringify(agentResult),
      { mode: 0o600 },
    );
    return agentResult;
  }

  async start(request: AgentRequest): Promise<AgentSession> {
    return new PromiseAgentSession(
      request.invocationId,
      async (signal, emit) => {
        emit({
          type: "status",
          at: new Date().toISOString(),
          message: "started",
        });
        const result = await this.invoke({ ...request, signal });
        emit({
          type: "usage",
          at: new Date().toISOString(),
          usage: result.usage,
        });
        return result;
      },
      request.signal,
    );
  }
}

export function resultDigest(result: AgentResult): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        summary: result.summary,
        plan: result.plan,
        findings: result.findings,
        structured: result.structured,
      }),
    )
    .digest("hex");
}
