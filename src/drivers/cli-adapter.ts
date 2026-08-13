import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MachineConfig } from "../config.js";
import { findingSchema, usageSchema } from "../contracts.js";
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

async function controlMcpCommand(): Promise<{
  command: string;
  args: string[];
}> {
  const built = fileURLToPath(new URL("../control-mcp.js", import.meta.url));
  try {
    await access(built);
    return { command: process.execPath, args: [built] };
  } catch {
    const source = fileURLToPath(new URL("../control-mcp.ts", import.meta.url));
    await access(source);
    return { command: process.execPath, args: [...process.execArgv, source] };
  }
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
    control?: { state: string; actions: string },
  ): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      ...this.config.env,
    };
    if (this.adapter === "codex") env.CODEX_HOME = this.config.home;
    else env.CLAUDE_CONFIG_DIR = this.config.home;
    env.NORIQ_JOB_WORKSPACE = workspace;
    if (control) {
      env.NORIQ_CONTROL_STATE = control.state;
      env.NORIQ_CONTROL_ACTIONS = control.actions;
    }
    return env;
  }

  async preflight(request: DriverPreflightRequest): Promise<DriverPreflight> {
    const { workspace, requireControlMcp: requireControl } = request;
    if (!this.capabilities.workspaceAccess.includes(request.access))
      throw new Error(
        `${this.id} cannot enforce ${request.access} workspace access`,
      );
    const version = await runProcess({
      command: this.config.command,
      args: ["--version"],
      cwd: workspace,
      env: this.env(workspace),
      timeoutMs: 30_000,
    });
    if (version.exitCode !== 0)
      throw new Error(`${this.id} version preflight failed: ${version.stderr}`);
    const help = await runProcess({
      command: this.config.command,
      args: this.adapter === "codex" ? ["exec", "--help"] : ["--help"],
      cwd: workspace,
      env: this.env(workspace),
      timeoutMs: 30_000,
    });
    const structuredOutput =
      this.adapter === "codex"
        ? help.stdout.includes("--output-schema") &&
          help.stdout.includes("--json")
        : help.stdout.includes("--output-format") &&
          help.stdout.includes("--json-schema");
    if (!structuredOutput)
      throw new Error(
        `${this.id} does not expose required structured-output flags`,
      );
    const auth = await runProcess({
      command: this.config.command,
      args:
        this.adapter === "codex"
          ? ["login", "status"]
          : ["auth", "status", "--json"],
      cwd: workspace,
      env: this.env(workspace),
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
    if (requireControl) {
      const control = await controlMcpCommand();
      const injection = configArguments(this.adapter, control);
      const inventory = await runProcess({
        command: this.config.command,
        args:
          this.adapter === "codex"
            ? [...this.config.args, "mcp", "list", "--json", ...injection]
            : [...this.config.args, ...injection, "--", "mcp", "list"],
        cwd: workspace,
        env: this.env(workspace),
        timeoutMs: 30_000,
      });
      if (inventory.exitCode !== 0)
        throw new Error(
          `${this.id} MCP inventory failed: ${inventory.stderr || inventory.stdout}`,
        );
      runnerControlVisible = inventory.stdout.includes("noriq_runner");
      if (!runnerControlVisible)
        throw new Error(
          `${this.id} did not expose the injected noriq_runner MCP`,
        );
      projectTools = inventory.stdout
        .split("\n")
        .filter(
          (line) =>
            /mcp|connected|enabled/i.test(line) &&
            !line.includes("noriq_runner"),
        )
        .slice(0, 100);
      warnings.push(
        "Project-native MCP inventory is diagnostic; Runner does not interpret it.",
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
      args.splice(this.config.args.length + 2, 0, "--sandbox", request.access);
    } else {
      const profile =
        request.projectConfig.agents[
          request.role === "repairer" ? "builder" : request.role
        ];
      args = [
        ...this.config.args,
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
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
      if (request.access === "read-only")
        args.push(
          "--permission-mode",
          "plan",
          "--disallowedTools",
          "Write,Edit,NotebookEdit",
        );
      else args.push("--permission-mode", "acceptEdits");
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
    const result = await runProcess({
      command: this.config.command,
      args,
      cwd: request.workspace,
      env: this.env(request.workspace, {
        state: controlStatePath,
        actions: controlActionsPath,
      }),
      timeoutMs: request.projectConfig.harness.maxJobMinutes * 60_000,
      ...(request.signal ? { signal: request.signal } : {}),
      stdin: request.prompt,
      maxOutputBytes: 8 * 1024 * 1024,
    });
    await writeFile(rawLogPath, `${result.stdout}\n${result.stderr}`, {
      mode: 0o600,
    });
    if (result.exitCode !== 0 || result.timedOut)
      throw new Error(
        `${this.id} invocation failed (${result.exitCode ?? result.signal}): ${result.stderr.slice(-4_000)}`,
      );
    let structured: Record<string, unknown>;
    if (this.adapter === "codex") {
      structured = JSON.parse(await readFile(outputPath, "utf8"));
    } else {
      const frames = result.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter(Boolean) as Record<string, unknown>[];
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
    const frames = result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as Record<string, unknown>[];
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
    const usage = usageSchema.parse({
      inputTokens: numberField(reportedUsage, "inputTokens", "input_tokens"),
      outputTokens: numberField(reportedUsage, "outputTokens", "output_tokens"),
      cachedTokens: numberField(
        reportedUsage,
        "cachedTokens",
        "cached_input_tokens",
        "cache_read_input_tokens",
      ),
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
