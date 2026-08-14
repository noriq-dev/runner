import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finding } from "../contracts.js";
import { observationUsageFromLegacy } from "../intelligence.js";
import type {
  AgentDriver,
  AgentDriverCapabilities,
  AgentRequest,
  AgentResult,
  DriverPreflight,
  DriverPreflightRequest,
} from "./types.js";
import { type AgentSession, PromiseAgentSession } from "./types.js";

export type FakeHandler = (
  request: AgentRequest,
  call: number,
) => Promise<Partial<AgentResult> & { structured?: Record<string, unknown> }>;

export class FakeAgentDriver implements AgentDriver {
  readonly id = "fake" as const;
  readonly capabilities: AgentDriverCapabilities = {
    structuredOutput: true,
    workspaceAccess: ["read-only", "workspace-write"],
    runnerControlMcpInjection: true,
    projectNativeConfiguration: true,
    usageAccuracy: "exact",
    hardBudget: true,
    processTreeTermination: true,
  };
  get name(): string {
    return this.id;
  }
  calls: AgentRequest[] = [];
  constructor(
    private readonly artifactRoot: string,
    private readonly handler: FakeHandler = async (request) => ({
      summary: `${request.role} completed`,
      structured:
        request.role === "guide"
          ? {
              objective: "Implement task",
              constraints: [],
              scope: [],
              acceptanceCriteria: ["task works"],
              verification: [],
              plan: "Implement and verify",
              summary: "planned",
            }
          : {},
    }),
  ) {}

  async preflight(_request: DriverPreflightRequest): Promise<DriverPreflight> {
    return {
      driver: "fake",
      version: "fake-1",
      authenticated: true,
      capabilities: this.capabilities,
      runnerControlVisible: true,
      projectTools: ["project.echo"],
      warnings: [],
    };
  }

  async recover(invocationId: string): Promise<AgentResult | null> {
    try {
      return JSON.parse(
        await readFile(
          join(this.artifactRoot, invocationId, "receipt.json"),
          "utf8",
        ),
      ) as AgentResult;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async invoke(request: AgentRequest): Promise<AgentResult> {
    const started = performance.now();
    this.calls.push(request);
    const rawLogPath = join(
      this.artifactRoot,
      request.invocationId,
      "driver.log",
    );
    await mkdir(join(this.artifactRoot, request.invocationId), {
      recursive: true,
    });
    const partial = await this.handler(request, this.calls.length);
    await writeFile(
      rawLogPath,
      JSON.stringify({ role: request.role, taskId: request.taskId }),
    );
    const usage = partial.usage ?? {
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 0,
      costUsd: 0,
      calls: 1,
    };
    const result: AgentResult = {
      success: partial.success ?? true,
      summary: partial.summary ?? `${request.role} completed`,
      ...(partial.plan === undefined ? {} : { plan: partial.plan }),
      findings: (partial.findings ?? []) as Finding[],
      usage,
      usageEvidence:
        partial.usageEvidence ?? observationUsageFromLegacy(usage, "exact"),
      durationMs:
        partial.durationMs ??
        Math.max(0, Math.round(performance.now() - started)),
      rawLogPath,
      structured: partial.structured ?? {},
      ...(partial.controlActions === undefined
        ? {}
        : { controlActions: partial.controlActions }),
    };
    await writeFile(
      join(this.artifactRoot, request.invocationId, "receipt.json"),
      JSON.stringify(result),
    );
    return result;
  }

  async start(request: AgentRequest): Promise<AgentSession> {
    return new PromiseAgentSession(
      request.invocationId,
      (signal) => this.invoke({ ...request, signal }),
      request.signal,
    );
  }
}
