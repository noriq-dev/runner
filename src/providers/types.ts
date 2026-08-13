import type { ProjectConfig } from "../config.js";
import type { Finding, Usage } from "../contracts.js";

export type AgentRole = "guide" | "builder" | "reviewer" | "repairer";

export interface AgentRequest {
  invocationId: string;
  role: AgentRole;
  taskId: string;
  taskKey: string;
  workspace: string;
  prompt: string;
  outputSchema: Record<string, unknown>;
  projectConfig: ProjectConfig;
  signal?: AbortSignal;
}

export interface AgentResult {
  success: boolean;
  summary: string;
  plan?: string;
  findings: Finding[];
  usage: Usage;
  rawLogPath: string;
  structured: Record<string, unknown>;
  controlActions?: Array<{
    at: string;
    name: string;
    args: Record<string, unknown>;
  }>;
}

export interface ProviderPreflight {
  provider: string;
  version: string;
  authenticated: boolean;
  structuredOutput: boolean;
  runnerControlVisible: boolean;
  projectTools: string[];
  warnings: string[];
  usageReporting: "exact" | "partial" | "none";
  costEnforcement: boolean;
}

export interface ProviderAdapter {
  readonly name: "codex" | "claude" | "fake";
  preflight(
    workspace: string,
    requireControl: boolean,
  ): Promise<ProviderPreflight>;
  recover(invocationId: string): Promise<AgentResult | null>;
  invoke(request: AgentRequest): Promise<AgentResult>;
}
