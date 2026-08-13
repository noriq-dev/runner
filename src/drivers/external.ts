import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MachineConfig } from "../config.js";
import { findingSchema, usageSchema } from "../contracts.js";
import { runProcess } from "../process.js";
import {
  type AgentDriver,
  type AgentDriverCapabilities,
  type AgentEvent,
  type AgentRequest,
  type AgentResult,
  type AgentSession,
  type DriverPreflight,
  type DriverPreflightRequest,
  PromiseAgentSession,
} from "./types.js";

type ExternalConfig = Extract<
  MachineConfig["drivers"][string],
  { adapter: "external-jsonl-v1" }
>;

type JsonObject = Record<string, unknown>;

function object(value: unknown, context: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${context} must be a JSON object`);
  return value as JsonObject;
}

function parseLines(text: string): JsonObject[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0)
    throw new Error("external-jsonl-v1 emitted no frames");
  return lines.map((line, index) => {
    try {
      return object(JSON.parse(line), `frame ${index + 1}`);
    } catch (error) {
      throw new Error(
        `external-jsonl-v1 malformed frame ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

function sameCapabilities(
  actual: unknown,
  expected: AgentDriverCapabilities,
): boolean {
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object")
      return `{${Object.entries(value as JsonObject)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
        .join(",")}}`;
    return JSON.stringify(value);
  };
  return stable(object(actual, "capabilities")) === stable(expected);
}

function validateEnvelope(frame: JsonObject, index: number): void {
  if (frame.protocol !== "noriq-agent-driver" || frame.version !== 1)
    throw new Error(
      `external-jsonl-v1 frame ${index + 1} has an unsupported protocol`,
    );
}

function terminalFrames(frames: JsonObject[]): number[] {
  return frames
    .map((frame, index) =>
      frame.type === "result" ||
      frame.type === "error" ||
      frame.type === "preflight-result"
        ? index
        : -1,
    )
    .filter((index) => index >= 0);
}

function validateTerminal(
  frames: JsonObject[],
  expectedType: string,
): JsonObject {
  frames.forEach(validateEnvelope);
  const terminals = terminalFrames(frames);
  if (terminals.length !== 1)
    throw new Error(
      `external-jsonl-v1 expected exactly one terminal frame, received ${terminals.length}`,
    );
  const terminalIndex = terminals[0]!;
  if (terminalIndex !== frames.length - 1)
    throw new Error(
      "external-jsonl-v1 emitted a frame after its terminal frame",
    );
  const terminal = frames[terminalIndex]!;
  if (terminal.type === "error") {
    const detail = object(terminal.error, "terminal error");
    throw new Error(String(detail.message ?? "external driver error"));
  }
  if (terminal.type !== expectedType)
    throw new Error(
      `external-jsonl-v1 expected ${expectedType}, received ${String(terminal.type)}`,
    );
  return terminal;
}

export class ExternalJsonlV1Driver implements AgentDriver {
  readonly capabilities: AgentDriverCapabilities;

  constructor(
    readonly id: string,
    private readonly config: ExternalConfig,
    private readonly stateDirectory: string,
  ) {
    this.capabilities = {
      structuredOutput: true,
      workspaceAccess: [...config.capabilities.workspaceAccess],
      runnerControlMcpInjection: config.capabilities.runnerControlMcpInjection,
      projectNativeConfiguration:
        config.capabilities.projectNativeConfiguration,
      usageAccuracy: config.capabilities.usageAccuracy,
      hardBudget: config.capabilities.hardBudget,
      processTreeTermination: config.capabilities.processTreeTermination,
    };
  }

  private async call(
    cwd: string,
    input: JsonObject,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<JsonObject[]> {
    const result = await runProcess({
      command: this.config.command,
      args: this.config.args,
      cwd,
      env: { PATH: process.env.PATH, ...this.config.env },
      timeoutMs,
      stdin: `${JSON.stringify(input)}\n`,
      maxOutputBytes: 8 * 1024 * 1024,
      ...(signal ? { signal } : {}),
    });
    if (result.exitCode !== 0 || result.timedOut)
      throw new Error(
        `external driver ${this.id} failed: ${result.stderr || result.stdout}`,
      );
    return parseLines(result.stdout);
  }

  async preflight(request: DriverPreflightRequest): Promise<DriverPreflight> {
    if (!this.capabilities.workspaceAccess.includes(request.access))
      throw new Error(
        `${this.id} cannot enforce ${request.access} workspace access`,
      );
    const frames = await this.call(
      request.workspace,
      {
        protocol: "noriq-agent-driver",
        version: 1,
        type: "preflight",
        driverId: this.id,
        request,
        capabilities: this.capabilities,
      },
      30_000,
    );
    const terminal = validateTerminal(frames, "preflight-result");
    if (!sameCapabilities(terminal.capabilities, this.capabilities))
      throw new Error(`external driver ${this.id} reported capability drift`);
    return {
      driver: this.id,
      version: String(terminal.driverVersion ?? "external-jsonl-v1"),
      authenticated: terminal.authenticated === true,
      capabilities: this.capabilities,
      runnerControlVisible: terminal.runnerControlVisible === true,
      projectTools: Array.isArray(terminal.projectTools)
        ? terminal.projectTools.map(String).slice(0, 100)
        : [],
      warnings: Array.isArray(terminal.warnings)
        ? terminal.warnings.map(String).slice(0, 100)
        : [],
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

  async start(request: AgentRequest): Promise<AgentSession> {
    return new PromiseAgentSession(
      request.invocationId,
      async (signal, emit) => this.invoke(request, signal, emit),
      request.signal,
    );
  }

  private async invoke(
    request: AgentRequest,
    signal: AbortSignal,
    emit: (event: AgentEvent) => void,
  ): Promise<AgentResult> {
    if (!this.capabilities.workspaceAccess.includes(request.access))
      throw new Error(
        `${this.id} cannot enforce ${request.access} workspace access`,
      );
    const directory = join(
      this.stateDirectory,
      "artifacts",
      request.invocationId,
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const frames = await this.call(
      request.workspace,
      {
        protocol: "noriq-agent-driver",
        version: 1,
        type: "invocation",
        driverId: this.id,
        capabilities: this.capabilities,
        invocation: {
          invocationId: request.invocationId,
          role: request.role,
          taskId: request.taskId,
          taskKey: request.taskKey,
          workspace: request.workspace,
          access: request.access,
          prompt: request.prompt,
          outputSchema: request.outputSchema,
          model:
            request.projectConfig.agents[
              request.role === "repairer" ? "builder" : request.role
            ].model,
          effort:
            request.projectConfig.agents[
              request.role === "repairer" ? "builder" : request.role
            ].effort,
        },
      },
      request.projectConfig.harness.maxJobMinutes * 60_000,
      signal,
    );
    const terminal = validateTerminal(frames, "result");
    if (!sameCapabilities(terminal.capabilities, this.capabilities))
      throw new Error(`external driver ${this.id} reported capability drift`);
    for (const [index, frame] of frames.entries()) {
      if (index === frames.length - 1) break;
      if (frame.type !== "event")
        throw new Error(`external-jsonl-v1 frame ${index + 1} is not an event`);
      const value = object(frame.event, `event ${index + 1}`);
      if (!["status", "text", "usage", "warning"].includes(String(value.type)))
        throw new Error(
          `external-jsonl-v1 event ${index + 1} has an unknown type`,
        );
      emit(value as unknown as AgentEvent);
    }
    const raw = object(terminal.result, "terminal result");
    const structured = object(raw.structured ?? {}, "result.structured");
    const result: AgentResult = {
      success: raw.success !== false,
      summary: String(raw.summary ?? ""),
      ...(typeof raw.plan === "string" ? { plan: raw.plan } : {}),
      findings: Array.isArray(raw.findings)
        ? raw.findings.map((finding) => findingSchema.parse(finding))
        : [],
      usage: usageSchema.parse(raw.usage),
      rawLogPath: join(directory, "external.jsonl"),
      structured,
      ...(Array.isArray(raw.controlActions)
        ? {
            controlActions: raw.controlActions as NonNullable<
              AgentResult["controlActions"]
            >,
          }
        : {}),
    };
    await writeFile(
      result.rawLogPath,
      `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`,
      {
        mode: 0o600,
      },
    );
    await writeFile(join(directory, "receipt.json"), JSON.stringify(result), {
      mode: 0o600,
    });
    return result;
  }
}

/** @deprecated use ExternalJsonlV1Driver */
export { ExternalJsonlV1Driver as ExternalDriverAdapter };
