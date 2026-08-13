import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finding } from "../contracts.js";
import type {
  AgentRequest,
  AgentResult,
  ProviderAdapter,
  ProviderPreflight,
} from "./types.js";

export type FakeHandler = (
  request: AgentRequest,
  call: number,
) => Promise<Partial<AgentResult> & { structured?: Record<string, unknown> }>;

export class FakeProviderAdapter implements ProviderAdapter {
  readonly name = "fake" as const;
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

  async preflight(
    _workspace: string,
    _requireControl: boolean,
  ): Promise<ProviderPreflight> {
    return {
      provider: "fake",
      version: "fake-1",
      authenticated: true,
      structuredOutput: true,
      runnerControlVisible: true,
      projectTools: ["project.echo"],
      warnings: [],
      usageReporting: "exact",
      costEnforcement: true,
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
    this.calls.push(request);
    const rawLogPath = join(
      this.artifactRoot,
      request.invocationId,
      "provider.log",
    );
    await mkdir(join(this.artifactRoot, request.invocationId), {
      recursive: true,
    });
    const partial = await this.handler(request, this.calls.length);
    await writeFile(
      rawLogPath,
      JSON.stringify({ role: request.role, taskId: request.taskId }),
    );
    const result: AgentResult = {
      success: partial.success ?? true,
      summary: partial.summary ?? `${request.role} completed`,
      ...(partial.plan === undefined ? {} : { plan: partial.plan }),
      findings: (partial.findings ?? []) as Finding[],
      usage: partial.usage ?? {
        inputTokens: 10,
        outputTokens: 5,
        cachedTokens: 0,
        costUsd: 0,
        calls: 1,
      },
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
}
