import type {
  Finding,
  RunnerJobObservationUsage,
  Usage,
} from "../contracts.js";

export type AgentRole = "guide" | "builder" | "reviewer" | "repairer";
export type WorkspaceAccess = "read-only" | "workspace-write";

export interface ResolvedAgentProfile {
  driver: string;
  vendor: string | null;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
}

export interface AgentRequest {
  invocationId: string;
  role: AgentRole;
  taskId: string;
  taskKey: string;
  workspace: string;
  access: WorkspaceAccess;
  prompt: string;
  outputSchema: Record<string, unknown>;
  profile: ResolvedAgentProfile;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface AgentResult {
  success: boolean;
  summary: string;
  plan?: string;
  findings: Finding[];
  usage: Usage;
  /** Independent usage axes; legacy/external receipts may omit this. */
  usageEvidence?: RunnerJobObservationUsage;
  /** Monotonic driver-observed duration when the receipt captured it. */
  durationMs?: number;
  rawLogPath: string;
  structured: Record<string, unknown>;
  controlActions?: Array<{
    at: string;
    name: string;
    args: Record<string, unknown>;
  }>;
}

export interface AgentEvent {
  type: "status" | "text" | "usage" | "warning";
  at: string;
  message?: string;
  usage?: Usage;
}

export interface AgentDriverCapabilities {
  structuredOutput: true;
  workspaceAccess: readonly WorkspaceAccess[];
  runnerControlMcpInjection: boolean;
  projectNativeConfiguration: boolean;
  usageAccuracy: "exact" | "partial" | "none";
  hardBudget: boolean;
  processTreeTermination: boolean;
}

export interface DriverPreflightRequest {
  workspace: string;
  access: WorkspaceAccess;
  requireControlMcp: boolean;
}

export interface DriverPreflight {
  driver: string;
  version: string;
  authenticated: boolean;
  capabilities: AgentDriverCapabilities;
  runnerControlVisible: boolean;
  projectTools: string[];
  warnings: string[];
}

export interface AgentSession {
  readonly invocationId: string;
  events(): AsyncIterable<AgentEvent>;
  result(): Promise<AgentResult>;
  cancel(reason?: string): Promise<void>;
}

export interface AgentDriver {
  readonly id: string;
  readonly vendor: string | null;
  readonly capabilities: AgentDriverCapabilities;
  preflight(request: DriverPreflightRequest): Promise<DriverPreflight>;
  recover(invocationId: string): Promise<AgentResult | null>;
  start(request: AgentRequest): Promise<AgentSession>;
}

/** A small session primitive used by in-process and CLI protocol translators. */
export class PromiseAgentSession implements AgentSession {
  private readonly abort = new AbortController();
  private readonly eventLog: AgentEvent[] = [];
  private readonly terminal: Promise<AgentResult>;

  constructor(
    readonly invocationId: string,
    execute: (
      signal: AbortSignal,
      emit: (event: AgentEvent) => void,
    ) => Promise<AgentResult>,
    upstream?: AbortSignal,
  ) {
    const abort = () => this.abort.abort(upstream?.reason);
    if (upstream?.aborted) abort();
    else upstream?.addEventListener("abort", abort, { once: true });
    this.terminal = execute(this.abort.signal, (event) =>
      this.eventLog.push(event),
    ).finally(() => upstream?.removeEventListener("abort", abort));
  }

  async *events(): AsyncIterable<AgentEvent> {
    await this.terminal.catch(() => {});
    for (const event of this.eventLog) yield event;
  }

  result(): Promise<AgentResult> {
    return this.terminal;
  }

  async cancel(reason = "cancelled by Runner"): Promise<void> {
    this.abort.abort(new Error(reason));
    await this.terminal.catch(() => {});
  }
}
