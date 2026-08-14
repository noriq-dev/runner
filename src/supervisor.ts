import { createHash } from "node:crypto";
import { mkdir, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectConfig } from "./config.js";
import type {
  CheckResult,
  Finding,
  JobAssignment,
  RunnerJobEventPayload,
  RunnerJobLanding,
  RunnerJobObservationActor,
  RunnerJobObservationEvidence,
  RunnerJobObservationStage,
  RunnerJobObservationUsage,
  RunnerJobOutput,
  RunnerTaskSnapshot,
} from "./contracts.js";
import { assertAcyclicSource } from "./contracts.js";
import { DurableLeaseManager } from "./coordination/lease-manager.js";
import type { CoordinationProvider, LeaseScope } from "./coordination/types.js";
import type {
  AgentDriver,
  AgentRequest,
  AgentResult,
  AgentRole,
  ResolvedAgentProfile,
} from "./drivers/types.js";
import {
  notApplicableUsage,
  observationUsageFromLegacy,
  observedMetric,
  unavailableMetric,
} from "./intelligence.js";
import { ChecksummedJournal } from "./journal.js";
import type { MemoryContextProvider } from "./memory/context/provider.js";
import { attributeUsageCost, type PricingProvider } from "./pricing.js";
import {
  builderPrompt,
  executionSpecContract,
  guideOutputSchema,
  guidePrompt,
  mergeGuideContract,
  repairPrompt,
  reviewerPrompt,
  type TaskContract,
  workerOutputSchema,
} from "./prompts.js";
import {
  classifyCandidate,
  classifyTask,
  executionSpecCoverage,
  resolveRoute,
  routeCandidateCounts,
  type TaskClassification,
  wireRouteClassification,
} from "./routing.js";
import { readyTasks } from "./scheduler.js";
import { type JobState, type LandingReport, reduceJobState } from "./state.js";
import type {
  JobWorkspace,
  SourceControlBackend,
  SourceControlCheckpoint,
  TaskWorkspace,
} from "./vcs/types.js";
import { IntegrationConflict } from "./vcs/types.js";

export interface JobEventSink {
  publish(
    jobId: string,
    assignmentId: string,
    seq: number,
    payload: RunnerJobEventPayload,
  ): Promise<number>;
}

interface BuiltTask {
  task: RunnerTaskSnapshot;
  contract: TaskContract;
  plan: string;
  workspace: TaskWorkspace;
  candidate: SourceControlCheckpoint;
  changedPaths: string[];
  classification: TaskClassification;
  buildSummary: string;
  workerFindings: Finding[];
}

function safeIdPart(input: string): string {
  const value = input.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 120);
  if (!value || value === "." || value === "..")
    throw new Error("identifier cannot form a safe state path");
  return value;
}

function resultDigest(result: AgentResult): string {
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

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function emptyEvidence(
  overrides: Partial<RunnerJobObservationEvidence> = {},
): RunnerJobObservationEvidence {
  return {
    operationDigest: null,
    resultDigest: null,
    exitCode: null,
    timedOut: null,
    changedPathCount: null,
    blockerFindings: null,
    majorFindings: null,
    minorFindings: null,
    checkpointRef: null,
    errorCode: null,
    ...overrides,
  };
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "");
    if (/^[A-Za-z0-9_.-]{1,100}$/.test(code)) return code;
  }
  return error instanceof Error && /^[A-Za-z0-9_.-]{1,100}$/.test(error.name)
    ? error.name
    : "ERROR";
}

function now(): string {
  return new Date().toISOString();
}
function invocationId(
  jobId: string,
  taskId: string,
  role: AgentRole,
  round = 0,
): string {
  return createHash("sha256")
    .update(`${jobId}:${taskId}:${role}:${round}`)
    .digest("hex")
    .slice(0, 32);
}
function failedChecks(checks: CheckResult[]): CheckResult[] {
  return checks.filter((check) => check.exitCode !== 0 || check.timedOut);
}
function blockingFindings(findings: Finding[]): Finding[] {
  return findings.filter(
    (finding) => finding.severity === "blocker" || finding.severity === "major",
  );
}
function findingEvidence(
  result: Pick<AgentResult, "findings">,
): Partial<RunnerJobObservationEvidence> {
  return {
    blockerFindings: result.findings.filter(
      (finding) => finding.severity === "blocker",
    ).length,
    majorFindings: result.findings.filter(
      (finding) => finding.severity === "major",
    ).length,
    minorFindings: result.findings.filter(
      (finding) => finding.severity === "minor",
    ).length,
  };
}
function workspaceInstruction(workspace: string): string {
  return `Runtime workspace root: ${JSON.stringify(workspace)}. Resolve every repository-relative path under this exact root; do not substitute /repo or another conventional mount path.`;
}
function taskContract(result: AgentResult): TaskContract {
  const value = result.structured;
  return {
    objective: String(value.objective ?? result.summary),
    constraints: Array.isArray(value.constraints)
      ? value.constraints.map(String)
      : [],
    scope: Array.isArray(value.scope) ? value.scope.map(String) : [],
    acceptanceCriteria: Array.isArray(value.acceptanceCriteria)
      ? value.acceptanceCriteria.map(String)
      : [],
    verification: Array.isArray(value.verification)
      ? value.verification.map(String)
      : [],
  };
}

class UnsupportedDecompositionError extends Error {
  readonly code = "unsupported_decomposition";
}

export class RunnerJobSupervisor {
  private journal!: ChecksummedJournal;
  private state!: JobState;
  private readonly abort = new AbortController();
  private workspace!: JobWorkspace;
  private workspaceReady = false;
  private workspaceReleased = false;
  private setupDurationMs = 0;
  private checkDurationMs = 0;
  private readonly answerWaiters = new Map<
    string,
    { resolve: (answer: string) => void; reject: (error: Error) => void }
  >();
  private readonly earlyAnswers = new Map<string, string>();
  private recordTail: Promise<void> = Promise.resolve();
  private emitTail: Promise<void> = Promise.resolve();
  private coordination: DurableLeaseManager | null = null;
  private coordinationDeadline = 0;

  constructor(
    private readonly options: {
      assignment: JobAssignment;
      repository: string;
      stateDirectory: string;
      projectConfig: ProjectConfig;
      backend: SourceControlBackend;
      drivers: Record<string, AgentDriver | undefined>;
      pricingProviders?: Record<string, PricingProvider | undefined>;
      memoryContext?: MemoryContextProvider;
      coordination?: {
        provider: CoordinationProvider;
        runnerId: string;
        checkoutId: string;
        projectId: string;
      };
      onRepositoryChanged?: () => void | Promise<void>;
      sink: JobEventSink;
    },
  ) {}

  cancel(): void {
    this.abort.abort(new Error("job cancelled"));
  }

  private coordinationScope(tasks: RunnerTaskSnapshot[]): LeaseScope {
    const lane =
      this.options.projectConfig.sourceControl.target ??
      this.options.projectConfig.sourceControl.base;
    const requiresRepository =
      this.options.projectConfig.sourceControl.mode === "direct" ||
      !this.options.backend.capabilities.parallelTaskWorkspaces ||
      tasks.some((task) => executionSpecCoverage(task) !== "build_ready");
    if (requiresRepository)
      return {
        repositoryKey: this.options.projectConfig.repositoryKey,
        lane,
        kind: "repository",
        paths: [],
      };
    const paths = [
      ...new Set(
        tasks.flatMap(
          (task) =>
            task.executionSpec?.anticipatedFiles.map((file) => file.path) ?? [],
        ),
      ),
    ].sort();
    return paths.length > 0
      ? {
          repositoryKey: this.options.projectConfig.repositoryKey,
          lane,
          kind: "paths",
          paths,
        }
      : {
          repositoryKey: this.options.projectConfig.repositoryKey,
          lane,
          kind: "repository",
          paths: [],
        };
  }

  private async acquireCoordination(
    tasks: RunnerTaskSnapshot[],
  ): Promise<void> {
    const configured = this.options.coordination;
    if (!configured) return;
    this.coordinationDeadline =
      Date.now() + this.options.projectConfig.harness.maxJobMinutes * 60_000;
    this.coordination = new DurableLeaseManager(configured.provider, {
      stateDirectory: this.options.stateDirectory,
      identity: {
        runnerId: configured.runnerId,
        checkoutId: configured.checkoutId,
        projectId: configured.projectId,
        jobId: this.options.assignment.jobId,
        assignmentId: this.options.assignment.assignmentId,
        taskId: null,
        idempotencyKey: `${this.options.assignment.jobId}:workspace:v1`,
      },
      onWaiting: async (attempt, delayMs) => {
        await this.record("coordination.waiting", {
          attempt,
          delayMs,
          taskIds: tasks.map((task) => task.taskId),
        });
      },
      onAcquired: async (lease) => {
        await this.record("coordination.acquired", {
          leaseId: lease.leaseId,
          kind: lease.kind,
          pathCount: lease.paths.length,
          fencingToken: lease.fencingToken,
          expiresAt: lease.expiresAt,
        });
      },
      onLost: async (error) => {
        await this.record("coordination.lost", {
          message: (error instanceof Error
            ? error.message
            : String(error)
          ).slice(0, 500),
        });
        this.abort.abort(new Error("coordination lease was lost"));
      },
    });
    const desired = this.coordinationScope(tasks);
    const recovered = await this.coordination.recover();
    if (!recovered)
      await this.coordination.acquire(
        desired,
        this.abort.signal,
        this.coordinationDeadline,
      );
    else if (
      recovered.kind !== desired.kind ||
      recovered.lane !== desired.lane ||
      JSON.stringify(recovered.paths) !== JSON.stringify(desired.paths)
    )
      await this.coordination.exchange(
        desired,
        this.abort.signal,
        this.coordinationDeadline,
      );
  }

  async answer(questionId: string, answer: string): Promise<void> {
    if (!this.journal) {
      this.earlyAnswers.set(questionId, answer);
      return;
    }
    await this.record("question.answered", { questionId, answer });
    this.answerWaiters.get(questionId)?.resolve(answer);
    this.answerWaiters.delete(questionId);
  }

  private async waitForAnswer(questionId: string): Promise<string> {
    const existing = this.state.answers[questionId];
    if (existing !== undefined) return existing;
    return new Promise<string>((resolve, reject) => {
      this.answerWaiters.set(questionId, { resolve, reject });
      this.abort.signal.addEventListener(
        "abort",
        () => reject(new Error("job cancelled while waiting for human input")),
        { once: true },
      );
    });
  }

  private async record(type: string, payload: unknown): Promise<void> {
    const operation = this.recordTail.then(async () => {
      await this.journal.append(type, payload);
      this.state = reduceJobState(this.journal.all());
      await this.journal.writeSnapshot(this.state);
    });
    this.recordTail = operation.catch(() => {});
    await operation;
  }

  private dependencyDegree(taskId: string): number {
    const source = this.options.assignment.source;
    if (source.kind === "task") return 0;
    return source.dependencies.filter(
      (edge) => edge.taskId === taskId || edge.dependsOnTaskId === taskId,
    ).length;
  }

  private driver(profile: { driver: string }, role: AgentRole): AgentDriver {
    const driver = this.options.drivers[profile.driver];
    if (!driver)
      throw new Error(`driver ${profile.driver} is not configured for ${role}`);
    return driver;
  }

  private resolvedProfile(
    role: AgentRole,
    round: number,
    classification: TaskClassification,
  ): ResolvedAgentProfile {
    const route = resolveRoute(
      this.options.projectConfig,
      role,
      classification,
      round,
    );
    const driver = this.driver(route.profile, role);
    return {
      ...route.profile,
      vendor: driver.vendor,
    };
  }

  private enforceBudget(): void {
    const config = this.options.projectConfig.harness;
    const usedTokens =
      this.state.usage.inputTokens + this.state.usage.outputTokens;
    if (config.maxTokens !== undefined && usedTokens >= config.maxTokens)
      throw new Error(`job token cap ${config.maxTokens} exhausted`);
    if (
      config.maxCostUsd !== undefined &&
      (this.state.usage.costUsd === null ||
        this.state.usage.costUsd >= config.maxCostUsd)
    )
      throw new Error(
        `job cost cap ${config.maxCostUsd} cannot admit another call`,
      );
  }

  private observationId(
    stage: RunnerJobObservationStage,
    operation: string,
    taskId: string | null,
    attempt: number,
  ): string {
    return createHash("sha256")
      .update(
        `${this.options.assignment.jobId}:${taskId ?? "job"}:${stage}:${operation}:${attempt}`,
      )
      .digest("hex")
      .slice(0, 32);
  }

  private agentActor(
    role: AgentRole,
    profile: ResolvedAgentProfile,
  ): RunnerJobObservationActor {
    return {
      kind: "agent",
      driver: profile.driver,
      vendor: profile.vendor,
      model: profile.model,
      effort: profile.effort,
      role,
      operation: "invoke",
    };
  }

  private async emitRoute(
    task: RunnerTaskSnapshot,
    role: AgentRole,
    round: number,
    classification: TaskClassification,
    profile: ResolvedAgentProfile | null,
    decision: "invoke" | "skip",
  ): Promise<void> {
    const key = `${task.taskId}:${role}:${round + 1}`;
    if (this.state.routeDecisions[key]) return;
    const selected = resolveRoute(
      this.options.projectConfig,
      role,
      classification,
      round,
    );
    await this.emit({
      type: "agent.route",
      at: now(),
      route: {
        taskId: task.taskId,
        role,
        attempt: round + 1,
        policyVersion: classification.policyVersion,
        ...wireRouteClassification(classification),
        ...routeCandidateCounts(
          this.options.projectConfig,
          role,
          selected.tier,
          decision,
        ),
        decision,
        actor: profile ? this.agentActor(role, profile) : null,
      },
    });
  }

  private backendActor(
    kind: "command" | "vcs" | "runner",
    operation: string,
    role: string | null = null,
  ): RunnerJobObservationActor {
    return {
      kind,
      driver: kind === "runner" ? "noriq-runner" : this.options.backend.id,
      vendor: null,
      model: null,
      effort: null,
      role,
      operation,
    };
  }

  private async observe<T>(options: {
    stage: RunnerJobObservationStage;
    operation: string;
    taskId: string | null;
    attempt?: number;
    actor: RunnerJobObservationActor;
    work: () => Promise<T>;
    evidence?: (result: T) => Partial<RunnerJobObservationEvidence>;
  }): Promise<T> {
    let attempt = options.attempt ?? 1;
    let observationId = this.observationId(
      options.stage,
      options.operation,
      options.taskId,
      attempt,
    );
    while (this.state.observations[observationId]?.finished) {
      attempt += 1;
      observationId = this.observationId(
        options.stage,
        options.operation,
        options.taskId,
        attempt,
      );
    }
    const existing = this.state.observations[observationId];
    const startedAt = now();
    if (!existing?.started)
      await this.emit({
        type: "stage.started",
        at: startedAt,
        observationId,
        taskId: options.taskId,
        stage: options.stage,
        attempt,
        actor: options.actor,
      });
    const monotonicStarted = performance.now();
    try {
      const result = await options.work();
      if (!this.state.observations[observationId]?.finished)
        await this.emit({
          type: "stage.finished",
          at: now(),
          startedAt,
          observationId,
          taskId: options.taskId,
          stage: options.stage,
          attempt,
          actor: options.actor,
          outcome: "succeeded",
          duration: observedMetric(
            Math.max(0, Math.round(performance.now() - monotonicStarted)),
            "complete",
            "runner_reported",
          ),
          usage: notApplicableUsage(),
          recovery: existing?.started ? "process_recovery" : "none",
          evidence: emptyEvidence({
            operationDigest: digest({
              driver: options.actor.driver,
              operation: options.operation,
            }),
            ...options.evidence?.(result),
          }),
        });
      return result;
    } catch (error) {
      if (!this.state.observations[observationId]?.finished)
        await this.emit({
          type: "stage.finished",
          at: now(),
          startedAt,
          observationId,
          taskId: options.taskId,
          stage: options.stage,
          attempt,
          actor: options.actor,
          outcome: this.abort.signal.aborted ? "cancelled" : "failed",
          duration: observedMetric(
            Math.max(0, Math.round(performance.now() - monotonicStarted)),
            "complete",
            "runner_reported",
          ),
          usage: notApplicableUsage(),
          recovery: existing?.started ? "process_recovery" : "none",
          evidence: emptyEvidence({
            operationDigest: digest({
              driver: options.actor.driver,
              operation: options.operation,
            }),
            errorCode: safeErrorCode(error),
          }),
        });
      throw error;
    }
  }

  private async emitInvocationFinished(id: string): Promise<void> {
    const invocation = this.state.invocations[id];
    if (!invocation || this.state.observations[id]?.finished) return;
    if (!invocation.actor || !invocation.duration || !invocation.evidence)
      throw new Error(`invocation ${id} has an incomplete durable observation`);
    await this.emit({
      type: "stage.finished",
      at: invocation.completedAt ?? now(),
      startedAt: invocation.startedAt ?? invocation.completedAt ?? now(),
      observationId: id,
      taskId: invocation.taskId,
      stage:
        invocation.role === "guide"
          ? "plan"
          : invocation.role === "builder"
            ? "build"
            : invocation.role === "reviewer"
              ? "review"
              : "repair",
      attempt: invocation.attempt ?? 1,
      actor: invocation.actor,
      outcome: invocation.outcome ?? "failed",
      duration: invocation.duration,
      usage: invocation.usageEvidence ?? {
        inputTokens: unavailableMetric(),
        outputTokens: unavailableMetric(),
        cacheReadTokens: unavailableMetric(),
        cacheWriteTokens: unavailableMetric(),
        calls: unavailableMetric(),
        costUsd: unavailableMetric(),
      },
      recovery: invocation.recovery ?? "journal_replay",
      evidence: invocation.evidence,
      ...(invocation.costBasis ? { costBasis: invocation.costBasis } : {}),
    });
  }

  private async runObservedCommands(options: {
    taskId: string;
    stage: "setup" | "check";
    commands: string[];
    timeoutSeconds: number;
    path: string;
    attempt?: number;
  }): Promise<CheckResult[]> {
    const starts = options.commands.map((command, index) => {
      let attempt = options.attempt ?? 1;
      let observationId = this.observationId(
        options.stage,
        `${options.stage}-command-${index}`,
        options.taskId,
        attempt,
      );
      while (this.state.observations[observationId]?.finished) {
        attempt += 1;
        observationId = this.observationId(
          options.stage,
          `${options.stage}-command-${index}`,
          options.taskId,
          attempt,
        );
      }
      return {
        command,
        observationId,
        attempt,
        recovered: false,
        startedAt: now(),
        actor: this.backendActor(
          "command",
          `${options.stage}.command`,
          options.stage,
        ),
      };
    });
    for (const start of starts)
      start.recovered = Boolean(
        this.state.observations[start.observationId]?.started,
      );
    for (const start of starts) {
      if (this.state.observations[start.observationId]?.started) continue;
      await this.emit({
        type: "stage.started",
        at: start.startedAt,
        observationId: start.observationId,
        taskId: options.taskId,
        stage: options.stage,
        attempt: start.attempt,
        actor: start.actor,
      });
    }
    let checks: CheckResult[];
    try {
      checks = await this.options.backend.runCommands(
        options.path,
        options.commands,
        options.timeoutSeconds,
        this.abort.signal,
      );
    } catch (error) {
      for (const start of starts) {
        if (this.state.observations[start.observationId]?.finished) continue;
        await this.emit({
          type: "stage.finished",
          at: now(),
          startedAt: start.startedAt,
          observationId: start.observationId,
          taskId: options.taskId,
          stage: options.stage,
          attempt: start.attempt,
          actor: start.actor,
          outcome: this.abort.signal.aborted ? "cancelled" : "failed",
          duration: unavailableMetric(),
          usage: notApplicableUsage(),
          recovery: start.recovered ? "process_recovery" : "none",
          evidence: emptyEvidence({
            operationDigest: digest(start.command),
            errorCode: safeErrorCode(error),
          }),
        });
      }
      throw error;
    }
    for (const [index, start] of starts.entries()) {
      if (this.state.observations[start.observationId]?.finished) continue;
      const check = checks[index];
      await this.emit({
        type: "stage.finished",
        at: now(),
        startedAt: start.startedAt,
        observationId: start.observationId,
        taskId: options.taskId,
        stage: options.stage,
        attempt: start.attempt,
        actor: start.actor,
        outcome:
          check && check.exitCode === 0 && !check.timedOut
            ? "succeeded"
            : this.abort.signal.aborted
              ? "cancelled"
              : "failed",
        duration:
          check === undefined
            ? unavailableMetric()
            : observedMetric(check.durationMs, "complete", "driver_reported"),
        usage: notApplicableUsage(),
        recovery: start.recovered ? "process_recovery" : "none",
        evidence: emptyEvidence({
          operationDigest: digest(start.command),
          resultDigest: check
            ? digest({
                exitCode: check.exitCode,
                durationMs: check.durationMs,
                timedOut: check.timedOut,
              })
            : null,
          exitCode: check?.exitCode ?? null,
          timedOut: check?.timedOut ?? null,
          errorCode: check === undefined ? "MISSING_CHECK_RESULT" : null,
        }),
      });
    }
    return checks;
  }

  private async stageCandidateObserved(
    task: RunnerTaskSnapshot,
    workspace: TaskWorkspace,
    summary: string,
    refresh: boolean,
    attempt: number,
  ) {
    return this.observe({
      stage: "candidate",
      operation: refresh ? "refresh-candidate" : "stage-candidate",
      taskId: task.taskId,
      attempt,
      actor: this.backendActor("vcs", "stageCandidate"),
      work: () =>
        this.options.backend.stageCandidate({
          workspace: this.workspace,
          task: workspace,
          taskKey: task.key,
          summary,
          refresh,
        }),
      evidence: (value) => ({
        changedPathCount:
          value.status === "conflict"
            ? value.paths.length
            : value.changedPaths.length,
        checkpointRef: value.status === "ready" ? value.checkpoint.ref : null,
        resultDigest: digest({
          status: value.status,
          changedPathCount:
            value.status === "conflict"
              ? value.paths.length
              : value.changedPaths.length,
        }),
      }),
    });
  }

  private async integrateLatestObserved(
    task: RunnerTaskSnapshot,
    workspace: TaskWorkspace,
    attempt: number,
  ) {
    return this.observe({
      stage: "integrate",
      operation: "integrate-latest",
      taskId: task.taskId,
      attempt,
      actor: this.backendActor("vcs", "integrateLatest"),
      work: () =>
        this.options.backend.integrateLatest(this.workspace, workspace),
      evidence: (value) => ({
        changedPathCount:
          value?.status === "conflict"
            ? value.paths.length
            : (value?.changedPaths.length ?? 0),
        checkpointRef: value?.status === "ready" ? value.checkpoint.ref : null,
        resultDigest: digest({
          status: value?.status ?? "not-needed",
          changedPathCount:
            value?.status === "conflict"
              ? value.paths.length
              : (value?.changedPaths.length ?? 0),
        }),
      }),
    });
  }

  private async conflictActionObserved(
    task: RunnerTaskSnapshot,
    workspace: TaskWorkspace,
    operation: "continueConflict" | "abortConflict",
    attempt: number,
  ): Promise<void> {
    await this.observe({
      stage: "integrate",
      operation,
      taskId: task.taskId,
      attempt,
      actor: this.backendActor("vcs", operation),
      work: () => this.options.backend[operation](workspace),
    });
  }

  private async reviewDiffObserved(
    built: BuiltTask,
    attempt: number,
  ): Promise<string> {
    return this.observe({
      stage: "review",
      operation: "review-diff",
      taskId: built.task.taskId,
      attempt,
      actor: this.backendActor("vcs", "reviewDiff", "reviewer"),
      work: () =>
        this.options.backend.reviewDiff(
          this.workspace,
          built.workspace,
          built.candidate,
        ),
      evidence: (value) => ({ resultDigest: digest({ bytes: value.length }) }),
    });
  }

  private async acceptCandidateObserved(
    built: BuiltTask,
    attempt: number,
  ): Promise<SourceControlCheckpoint> {
    return this.observe({
      stage: "accept",
      operation: "accept-candidate",
      taskId: built.task.taskId,
      attempt,
      actor: this.backendActor("vcs", "acceptCandidate"),
      work: () =>
        this.options.backend.acceptCandidate({
          workspace: this.workspace,
          task: built.workspace,
          candidate: built.candidate,
          taskKey: built.task.key,
        }),
      evidence: (value) => ({ checkpointRef: value.ref }),
    });
  }

  private async releaseTaskObserved(
    task: RunnerTaskSnapshot,
    workspace: TaskWorkspace,
    attempt: number,
  ): Promise<void> {
    await this.observe({
      stage: "finalize",
      operation: "release-task",
      taskId: task.taskId,
      attempt,
      actor: this.backendActor("vcs", "releaseTask"),
      work: () => this.options.backend.releaseTask(this.workspace, workspace),
    });
  }

  private async releaseWorkspaceObserved(attempt: number): Promise<void> {
    if (this.workspaceReleased) return;
    await this.observe({
      stage: "finalize",
      operation: "release-workspace",
      taskId: null,
      attempt,
      actor: this.backendActor("vcs", "release"),
      work: () =>
        this.options.backend.release(
          this.workspace,
          this.options.assignment.jobId,
        ),
    });
    this.workspaceReleased = true;
  }

  private async invoke(
    task: RunnerTaskSnapshot,
    role: AgentRole,
    round: number,
    workspace: string,
    prompt: string,
    schema: Record<string, unknown>,
    classification = classifyTask(
      task,
      this.options.projectConfig,
      this.dependencyDegree(task.taskId),
    ),
  ): Promise<AgentResult> {
    this.enforceBudget();
    const routedClassification =
      role === "repairer" && round > 0
        ? {
            ...classification,
            reasons: [
              ...new Set([
                ...classification.reasons,
                "repair_escalation" as const,
              ]),
            ],
          }
        : classification;
    // Vendor CLIs resolve cwd through filesystem aliases (for example,
    // Fedora's /home -> /var/home). Keep the path in the prompt identical to
    // the runtime cwd; Claude otherwise treats the aliased absolute path as
    // outside the workspace and asks an unattended process for permission.
    const runtimeWorkspace = await realpath(workspace);
    const id = invocationId(
      this.options.assignment.jobId,
      task.taskId,
      role,
      round,
    );
    const profile = this.resolvedProfile(role, round, routedClassification);
    const driver = this.driver(profile, role);
    const actor = this.agentActor(role, profile);
    await this.emitRoute(
      task,
      role,
      round,
      routedClassification,
      profile,
      "invoke",
    );
    let durable = this.state.invocations[id];
    if (!durable) {
      const startedAt = now();
      const provider = profile.vendor
        ? this.options.pricingProviders?.[profile.vendor]
        : undefined;
      const pricing = provider
        ? await provider.quote(profile.model, this.abort.signal)
        : null;
      if (pricing?.warning)
        await this.record("warning", { message: pricing.warning });
      await this.record("invocation.started", {
        id,
        taskId: task.taskId,
        role,
        status: "started",
        attempt: round + 1,
        startedAt,
        actor,
        ...(pricing ? { pricing } : {}),
      });
      durable = this.state.invocations[id];
    }
    if (!this.state.observations[id]?.started)
      await this.emit({
        type: "stage.started",
        at: durable?.startedAt ?? now(),
        observationId: id,
        taskId: task.taskId,
        stage:
          role === "guide"
            ? "plan"
            : role === "builder"
              ? "build"
              : role === "reviewer"
                ? "review"
                : "repair",
        attempt: round + 1,
        actor,
      });
    const recovered = await driver.recover(id);
    if (durable?.status === "completed") {
      if (!recovered)
        throw new Error(`completed invocation ${id} lost its durable receipt`);
      if (
        !durable.actor ||
        !durable.duration ||
        !durable.evidence ||
        !durable.usageEvidence
      ) {
        const digestValue = resultDigest(recovered);
        const usage = attributeUsageCost(
          recovered.usageEvidence ??
            observationUsageFromLegacy(
              recovered.usage,
              driver.capabilities.usageAccuracy,
            ),
          durable.pricing ?? null,
          new Date(durable.completedAt ?? now()),
        );
        await this.record("invocation.completed", {
          id,
          resultDigest: digestValue,
          completedAt: now(),
          usage: recovered.usage,
          usageEvidence: usage.usage,
          ...(usage.costBasis ? { costBasis: usage.costBasis } : {}),
          duration:
            recovered.durationMs === undefined
              ? unavailableMetric()
              : observedMetric(
                  recovered.durationMs,
                  "complete",
                  "driver_reported",
                ),
          actor,
          recovery: "journal_replay",
          evidence: emptyEvidence({
            resultDigest: digestValue,
            ...findingEvidence(recovered),
          }),
        });
      }
      await this.emitInvocationFinished(id);
      await this.emit({ type: "usage", at: now(), usage: this.state.usage });
      return recovered;
    }
    if (recovered) {
      const completedAt = now();
      const usage = attributeUsageCost(
        recovered.usageEvidence ??
          observationUsageFromLegacy(
            recovered.usage,
            driver.capabilities.usageAccuracy,
          ),
        durable?.pricing ?? null,
        new Date(completedAt),
      );
      await this.record("invocation.completed", {
        id,
        resultDigest: resultDigest(recovered),
        completedAt,
        usage: recovered.usage,
        usageEvidence: usage.usage,
        ...(usage.costBasis ? { costBasis: usage.costBasis } : {}),
        duration:
          recovered.durationMs === undefined
            ? unavailableMetric()
            : observedMetric(
                recovered.durationMs,
                "complete",
                "driver_reported",
              ),
        actor,
        recovery: "process_recovery",
        evidence: emptyEvidence({
          resultDigest: resultDigest(recovered),
          ...findingEvidence(recovered),
        }),
      });
      await this.emitInvocationFinished(id);
      await this.emit({ type: "usage", at: now(), usage: this.state.usage });
      return recovered;
    }
    const request: AgentRequest = {
      invocationId: id,
      role,
      taskId: task.taskId,
      taskKey: task.key,
      workspace: runtimeWorkspace,
      access:
        role === "guide" || role === "reviewer"
          ? "read-only"
          : "workspace-write",
      prompt: `${workspaceInstruction(runtimeWorkspace)}\n\n${prompt}`,
      outputSchema: schema,
      profile,
      timeoutMs: this.options.projectConfig.harness.maxJobMinutes * 60_000,
      signal: this.abort.signal,
    };
    const monotonicStarted = performance.now();
    try {
      const session = await driver.start(request);
      const result = await session.result();
      const completedAt = now();
      const usage = attributeUsageCost(
        result.usageEvidence ??
          observationUsageFromLegacy(
            result.usage,
            driver.capabilities.usageAccuracy,
          ),
        durable?.pricing ?? null,
        new Date(completedAt),
      );
      await this.record("invocation.completed", {
        id,
        resultDigest: resultDigest(result),
        completedAt,
        usage: result.usage,
        usageEvidence: usage.usage,
        ...(usage.costBasis ? { costBasis: usage.costBasis } : {}),
        duration: observedMetric(
          result.durationMs ??
            Math.max(0, Math.round(performance.now() - monotonicStarted)),
          "complete",
          result.durationMs === undefined
            ? "runner_reported"
            : "driver_reported",
        ),
        actor,
        recovery: "none",
        evidence: emptyEvidence({
          resultDigest: resultDigest(result),
          ...findingEvidence(result),
        }),
      });
      await this.emitInvocationFinished(id);
      await this.emit({ type: "usage", at: now(), usage: this.state.usage });
      return result;
    } catch (error) {
      const usageEvidence: RunnerJobObservationUsage = {
        inputTokens: unavailableMetric(),
        outputTokens: unavailableMetric(),
        cacheReadTokens: unavailableMetric(),
        cacheWriteTokens: unavailableMetric(),
        calls: observedMetric(1, "complete", "runner_reported"),
        costUsd: unavailableMetric(),
      };
      await this.record("invocation.abandoned", {
        id,
        completedAt: now(),
        duration: observedMetric(
          Math.max(0, Math.round(performance.now() - monotonicStarted)),
          "complete",
          "runner_reported",
        ),
        usageEvidence,
        actor,
        recovery: "none",
        outcome: this.abort.signal.aborted ? "cancelled" : "failed",
        evidence: emptyEvidence({ errorCode: safeErrorCode(error) }),
      });
      await this.emitInvocationFinished(id);
      await this.emit({ type: "usage", at: now(), usage: this.state.usage });
      throw error;
    }
  }

  private async emit(payload: RunnerJobEventPayload): Promise<void> {
    const operation = this.emitTail.then(() => this.emitSerialized(payload));
    this.emitTail = operation.catch(() => {});
    await operation;
  }

  private async emitSerialized(payload: RunnerJobEventPayload): Promise<void> {
    const seq = this.state.nextEventSeq;
    await this.record("event.queued", { seq, payload });
    try {
      const acknowledged = await this.options.sink.publish(
        this.options.assignment.jobId,
        this.options.assignment.assignmentId,
        seq,
        payload,
      );
      if (acknowledged >= seq)
        await this.record("event.acked", { seq: acknowledged });
    } catch (error) {
      await this.record("warning", {
        message: `event ${seq} remains queued: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async preflight(): Promise<void> {
    const roles: AgentRole[] = ["guide", "builder", "reviewer", "repairer"];
    const checked = new Set<string>();
    for (const role of roles) {
      for (const configured of Object.values(
        this.options.projectConfig.agents[role],
      )) {
        const driver = this.driver(configured, role);
        const profile: ResolvedAgentProfile = {
          ...configured,
          vendor: driver.vendor,
        };
        const access =
          role === "guide" || role === "reviewer"
            ? "read-only"
            : "workspace-write";
        const key = `${driver.id}:${access}:${role === "guide"}`;
        if (checked.has(key)) continue;
        checked.add(key);
        const result = await this.observe({
          stage: "preflight",
          operation: `agent-preflight-${driver.id}-${access}-${role}`,
          taskId: null,
          actor: { ...this.agentActor(role, profile), operation: "preflight" },
          work: () =>
            driver.preflight({
              workspace: this.workspace.path,
              access,
              requireControlMcp: role === "guide",
            }),
          evidence: (value) => ({
            resultDigest: digest({
              driver: value.driver,
              version: value.version,
              authenticated: value.authenticated,
              runnerControlVisible: value.runnerControlVisible,
              warnings: value.warnings.length,
            }),
          }),
        });
        if (!result.authenticated) throw new Error(`${driver.id} is not ready`);
        if (!driver.capabilities.workspaceAccess.includes(access))
          throw new Error(`${driver.id} cannot enforce ${access} access`);
        if (role === "guide" && !result.runnerControlVisible)
          throw new Error(`${driver.id} cannot see the Runner Control MCP`);
        const finiteBudget =
          this.options.projectConfig.harness.maxTokens !== undefined ||
          this.options.projectConfig.harness.maxCostUsd !== undefined;
        if (
          finiteBudget &&
          (!driver.capabilities.hardBudget ||
            driver.capabilities.usageAccuracy === "none")
        )
          throw new Error(
            `${driver.id} cannot enforce the configured finite token/cost cap`,
          );
        for (const warning of result.warnings)
          await this.record("warning", { message: warning });
      }
    }
  }

  private async buildTask(task: RunnerTaskSnapshot): Promise<BuiltTask> {
    const dependencyDegree = this.dependencyDegree(task.taskId);
    const initialClassification = classifyTask(
      task,
      this.options.projectConfig,
      dependencyDegree,
    );
    await this.record("task.started", { taskId: task.taskId });
    await this.emit({
      type: "task.result",
      at: now(),
      taskId: task.taskId,
      status: "running",
      checkpoint: null,
      summary: `Started ${task.key}`,
      findings: [],
    });
    await this.emit({
      type: "progress",
      at: now(),
      phase: "planning",
      taskId: task.taskId,
      message: `Planning ${task.key}`,
      progress: 0,
    });
    let contract: TaskContract;
    let plan: string;
    let guideInstructions: string | undefined;
    if (initialClassification.specCoverage === "build_ready") {
      await this.emitRoute(
        task,
        "guide",
        0,
        initialClassification,
        null,
        "skip",
      );
      ({ contract, plan } = executionSpecContract(
        task,
        this.options.projectConfig.checks.commands,
      ));
    } else {
      let guideRound = 0;
      let guideContext = guidePrompt(task);
      let guide: AgentResult;
      while (true) {
        guide = await this.invoke(
          task,
          "guide",
          guideRound,
          this.workspace.path,
          guideContext,
          guideOutputSchema,
          initialClassification,
        );
        const planAction = guide.controlActions?.find(
          (action) =>
            action.name === "record_task_plan" &&
            typeof action.args.plan === "string",
        );
        if (planAction) guide.plan = String(planAction.args.plan);
        const delegation = guide.controlActions?.find(
          (action) =>
            action.name === "delegate" && action.args.role === "builder",
        );
        if (delegation && typeof delegation.args.instructions === "string")
          guideInstructions = delegation.args.instructions;
        const question = guide.controlActions?.find(
          (action) =>
            action.name === "ask_human" &&
            typeof action.args.question === "string",
        );
        if (!question) break;
        if (guideRound >= 2)
          throw new Error(
            "guide exceeded the three-question human input ceiling",
          );
        const questionId = createHash("sha256")
          .update(
            `${this.options.assignment.jobId}:${task.taskId}:question:${guideRound}`,
          )
          .digest("hex")
          .slice(0, 24);
        const prompt = String(question.args.question);
        if (!this.state.questions[questionId]) {
          await this.record("question.published", { questionId, prompt });
          await this.emit({ type: "question", at: now(), questionId, prompt });
        }
        const answer = await this.waitForAnswer(questionId);
        guideRound += 1;
        guideContext = `${guidePrompt(task)}\n\nHuman answer to ${prompt}:\n${answer}`;
      }
      contract = mergeGuideContract(
        task,
        taskContract(guide),
        this.options.projectConfig.checks.commands,
      );
      plan = guide.plan ?? String(guide.structured.plan ?? guide.summary);
    }
    const narrowedPaths =
      task.executionSpec?.anticipatedFiles.map((file) => file.path) ?? [];
    if (
      this.coordination?.current()?.kind === "repository" &&
      this.options.assignment.source.kind === "task" &&
      initialClassification.specCoverage !== "build_ready" &&
      narrowedPaths.length > 0
    )
      await this.coordination.exchange(
        {
          repositoryKey: this.options.projectConfig.repositoryKey,
          lane:
            this.options.projectConfig.sourceControl.target ??
            this.options.projectConfig.sourceControl.base,
          kind: "paths",
          paths: narrowedPaths,
        },
        this.abort.signal,
        this.coordinationDeadline,
      );
    const buildClassification = initialClassification;
    await this.record("task.plan", { taskId: task.taskId, plan });
    await this.emit({
      type: "task.plan",
      at: now(),
      taskId: task.taskId,
      plan,
    });
    const retained = this.state.tasks[task.taskId];
    const taskWorkspace: TaskWorkspace =
      retained?.workspace ??
      (await this.observe({
        stage: "workspace",
        operation: "begin-task",
        taskId: task.taskId,
        actor: this.backendActor("vcs", "beginTask"),
        work: () => this.options.backend.beginTask(this.workspace, task.key),
        evidence: (value) => ({
          resultDigest: digest({ baseRevision: value.baseRevision }),
          checkpointRef: value.baseRevision,
        }),
      }));
    if (!retained?.workspace)
      await this.record("task.workspace", {
        taskId: task.taskId,
        workspace: taskWorkspace,
        jobWorkspace: this.workspace,
      });
    if (this.options.projectConfig.setup.commands.length > 0) {
      const started = performance.now();
      const setup = await this.runObservedCommands({
        taskId: task.taskId,
        stage: "setup",
        commands: this.options.projectConfig.setup.commands,
        timeoutSeconds: this.options.projectConfig.setup.timeoutSeconds,
        path: taskWorkspace.path,
      });
      this.setupDurationMs += Math.max(
        0,
        Math.round(performance.now() - started),
      );
      if (failedChecks(setup).length > 0)
        throw new Error(
          `setup failed for ${task.key}: ${failedChecks(setup)[0]!.output}`,
        );
    }
    await this.emit({
      type: "progress",
      at: now(),
      phase: "building",
      taskId: task.taskId,
      message: `Building ${task.key}`,
      progress: 0,
    });
    let memoryEvidence: string | undefined;
    if (
      this.options.projectConfig.memory.context.enabled &&
      this.options.memoryContext
    ) {
      const memory = await this.options.memoryContext.retrieve({
        projectId: this.options.assignment.source.projectId,
        taskId: task.taskId,
        repositoryKey: this.options.projectConfig.repositoryKey,
        branch: this.options.projectConfig.defaultBranch,
        baseId: taskWorkspace.baseRevision,
        workspace: taskWorkspace.path,
        tokenBudget: this.options.projectConfig.memory.context.tokenBudget,
      });
      memoryEvidence = memory.text || undefined;
      await this.record("memory.context", {
        taskId: task.taskId,
        packDigest: memory.digest,
        generatedAt: memory.generatedAt,
        consumption: memory.consumption,
      });
      await this.emit({
        type: "memory.context",
        at: now(),
        taskId: task.taskId,
        packDigest: memory.digest,
        generatedAt: memory.generatedAt,
        consumption: memory.consumption,
      });
      if (memory.warning) {
        await this.record("warning", { message: memory.warning });
        await this.emit({
          type: "warning",
          at: now(),
          code: "memory-context-unavailable",
          message: memory.warning,
        });
      }
    }
    const builder = await this.invoke(
      task,
      "builder",
      0,
      taskWorkspace.path,
      builderPrompt(task, contract, guideInstructions, memoryEvidence),
      workerOutputSchema,
      buildClassification,
    );
    await this.record("task.findings", {
      taskId: task.taskId,
      findings: builder.findings,
    });
    let candidate = retained?.candidate;
    let changedPaths =
      task.executionSpec?.anticipatedFiles.map((file) => file.path) ?? [];
    if (!candidate) {
      const staged = await this.stageCandidateObserved(
        task,
        taskWorkspace,
        builder.summary,
        false,
        1,
      );
      if (staged.status === "conflict")
        throw new IntegrationConflict(
          "candidate staging requires conflict repair",
          staged.detail,
          staged.paths,
        );
      candidate = staged.checkpoint;
      changedPaths = staged.changedPaths;
      await this.record("task.candidate", {
        taskId: task.taskId,
        candidate,
        workspace: taskWorkspace,
      });
    }
    return {
      task,
      contract,
      plan,
      workspace: taskWorkspace,
      candidate,
      changedPaths,
      classification: buildClassification,
      buildSummary: builder.summary,
      workerFindings: builder.findings,
    };
  }

  private async settleTask(built: BuiltTask): Promise<boolean> {
    const { task } = built;
    let round = 0;
    try {
      while (true) {
        const workerBlockers = blockingFindings(built.workerFindings);
        if (workerBlockers.length > 0) {
          if (round >= this.options.projectConfig.harness.maxRepairRounds) {
            await this.record("task.failed", {
              taskId: task.taskId,
              reason: "worker findings exceeded the repair ceiling",
            });
            await this.emit({
              type: "task.result",
              at: now(),
              taskId: task.taskId,
              status: "failed",
              checkpoint: null,
              summary:
                "Blocking worker findings remain after the repair ceiling.",
              findings: built.workerFindings,
            });
            await this.retainFailedTask(
              built,
              "worker findings exceeded the repair ceiling",
            );
            return false;
          }
          round += 1;
          await this.record("task.repair", { taskId: task.taskId, round });
          await this.emit({
            type: "progress",
            at: now(),
            phase: "repairing",
            taskId: task.taskId,
            message: `Repairing worker findings for ${task.key} (${round}/${this.options.projectConfig.harness.maxRepairRounds})`,
            progress: 0,
          });
          const repair = await this.invoke(
            task,
            "repairer",
            round,
            built.workspace.path,
            repairPrompt(task, built.contract, workerBlockers, [], round),
            workerOutputSchema,
            built.classification,
          );
          built.buildSummary = repair.summary;
          built.workerFindings = repair.findings;
          await this.record("task.findings", {
            taskId: task.taskId,
            findings: repair.findings,
          });
          const staged = await this.stageCandidateObserved(
            task,
            built.workspace,
            repair.summary,
            true,
            round + 1,
          );
          if (staged.status === "conflict")
            throw new IntegrationConflict(
              "candidate refresh requires conflict repair",
              staged.detail,
              staged.paths,
            );
          built.candidate = staged.checkpoint;
          built.changedPaths = staged.changedPaths;
          await this.record("task.candidate", {
            taskId: task.taskId,
            candidate: built.candidate,
            workspace: built.workspace,
          });
          continue;
        }
        const integration = await this.integrateLatestObserved(
          task,
          built.workspace,
          round + 1,
        );
        if (integration?.status === "conflict") {
          if (!this.options.backend.capabilities.automatedConflictRepair)
            throw new Error(
              `${this.options.backend.id} integration requires human resolution: ${integration.detail}`,
            );
          if (round >= this.options.projectConfig.harness.maxRepairRounds) {
            await this.conflictActionObserved(
              task,
              built.workspace,
              "abortConflict",
              round + 1,
            );
            throw new Error("integration conflict exceeded the repair ceiling");
          }
          round += 1;
          await this.record("task.repair", { taskId: task.taskId, round });
          await this.emit({
            type: "progress",
            at: now(),
            phase: "repairing",
            taskId: task.taskId,
            message: `Repairing source-control conflict for ${task.key} (${round}/${this.options.projectConfig.harness.maxRepairRounds})`,
            progress: 0,
          });
          try {
            const repair = await this.invoke(
              task,
              "repairer",
              round,
              built.workspace.path,
              repairPrompt(
                task,
                built.contract,
                [],
                [
                  {
                    command: `${this.options.backend.id} integration`,
                    exitCode: 1,
                    durationMs: 0,
                    output: integration.detail,
                    timedOut: false,
                  },
                ],
                round,
              ),
              workerOutputSchema,
              built.classification,
            );
            built.buildSummary = repair.summary;
            built.workerFindings = repair.findings;
            await this.record("task.findings", {
              taskId: task.taskId,
              findings: repair.findings,
            });
            await this.conflictActionObserved(
              task,
              built.workspace,
              "continueConflict",
              round,
            );
            const staged = await this.stageCandidateObserved(
              task,
              built.workspace,
              repair.summary,
              true,
              round + 1,
            );
            if (staged.status === "conflict") throw new Error(staged.detail);
            built.candidate = staged.checkpoint;
            built.changedPaths = staged.changedPaths;
            await this.record("task.candidate", {
              taskId: task.taskId,
              candidate: built.candidate,
              workspace: built.workspace,
            });
          } catch (repairError) {
            await this.conflictActionObserved(
              task,
              built.workspace,
              "abortConflict",
              round,
            );
            throw repairError;
          }
          continue;
        }
        if (integration?.status === "ready") {
          built.candidate = integration.checkpoint;
          built.changedPaths = integration.changedPaths;
          await this.record("task.candidate", {
            taskId: task.taskId,
            candidate: built.candidate,
            workspace: built.workspace,
          });
        }
        await this.emit({
          type: "progress",
          at: now(),
          phase: "checking",
          taskId: task.taskId,
          message: `Checking ${task.key}`,
          progress: 0,
        });
        const checkStarted = performance.now();
        const checks = await this.runObservedCommands({
          taskId: task.taskId,
          stage: "check",
          commands: this.options.projectConfig.checks.commands,
          timeoutSeconds: this.options.projectConfig.checks.timeoutSeconds,
          path: built.workspace.path,
          attempt: round + 1,
        });
        this.checkDurationMs += Math.max(
          0,
          Math.round(performance.now() - checkStarted),
        );
        await this.record("task.checked", { taskId: task.taskId, checks });
        const diff = await this.reviewDiffObserved(built, round + 1);
        built.classification = classifyCandidate(
          built.classification,
          task,
          this.options.projectConfig,
          {
            changedPaths: built.changedPaths,
            diffBytes: Buffer.byteLength(diff),
            failedChecks: failedChecks(checks).length > 0,
            priorRepair: round > 0,
          },
        );
        await this.emit({
          type: "progress",
          at: now(),
          phase: "reviewing",
          taskId: task.taskId,
          message: `Reviewing ${task.key}`,
          progress: 0,
        });
        const reviewer = await this.invoke(
          task,
          "reviewer",
          round,
          built.workspace.path,
          reviewerPrompt(task, built.contract, diff, JSON.stringify(checks)),
          workerOutputSchema,
          built.classification,
        );
        await this.record("task.reviewed", {
          taskId: task.taskId,
          findings: reviewer.findings,
        });
        const blockers = blockingFindings(reviewer.findings);
        const failures = failedChecks(checks);
        if (blockers.length === 0 && failures.length === 0) {
          await this.emit({
            type: "progress",
            at: now(),
            phase: "integrating",
            taskId: task.taskId,
            message: `Accepting ${task.key}`,
            progress: 0,
          });
          let acceptedCheckpoint: SourceControlCheckpoint;
          try {
            this.workspace.handle.state.acceptingTask = task.key;
            await this.record("workspace.updated", {
              workspace: this.workspace,
            });
            acceptedCheckpoint = await this.acceptCandidateObserved(
              built,
              round + 1,
            );
          } catch (error) {
            if (!(error instanceof IntegrationConflict)) throw error;
            const reintegration = await this.integrateLatestObserved(
              task,
              built.workspace,
              100 + round,
            );
            if (!reintegration || reintegration.status === "ready") {
              const restaged = await this.stageCandidateObserved(
                task,
                built.workspace,
                "candidate refreshed after target movement",
                true,
                100 + round,
              );
              if (restaged.status === "conflict")
                throw new Error(restaged.detail);
              built.candidate = restaged.checkpoint;
              built.changedPaths = restaged.changedPaths;
              await this.record("task.candidate", {
                taskId: task.taskId,
                candidate: built.candidate,
                workspace: built.workspace,
              });
              continue;
            }
            if (
              !this.options.backend.capabilities.automatedConflictRepair ||
              round >= this.options.projectConfig.harness.maxRepairRounds
            )
              throw error;
            round += 1;
            await this.record("task.repair", { taskId: task.taskId, round });
            const repair = await this.invoke(
              task,
              "repairer",
              round,
              built.workspace.path,
              repairPrompt(
                task,
                built.contract,
                [],
                [
                  {
                    command: `${this.options.backend.id} acceptance`,
                    exitCode: 1,
                    durationMs: 0,
                    output: reintegration.detail,
                    timedOut: false,
                  },
                ],
                round,
              ),
              workerOutputSchema,
              built.classification,
            );
            built.buildSummary = repair.summary;
            built.workerFindings = repair.findings;
            await this.record("task.findings", {
              taskId: task.taskId,
              findings: repair.findings,
            });
            await this.conflictActionObserved(
              task,
              built.workspace,
              "continueConflict",
              100 + round,
            );
            const restaged = await this.stageCandidateObserved(
              task,
              built.workspace,
              repair.summary,
              true,
              200 + round,
            );
            if (restaged.status === "conflict")
              throw new Error(restaged.detail);
            built.candidate = restaged.checkpoint;
            built.changedPaths = restaged.changedPaths;
            await this.record("task.candidate", {
              taskId: task.taskId,
              candidate: built.candidate,
              workspace: built.workspace,
            });
            continue;
          }
          delete this.workspace.handle.state.acceptingTask;
          await this.record("task.accepted", {
            taskId: task.taskId,
            checkpoint: acceptedCheckpoint,
            currentRevision: this.workspace.currentRevision,
            workspace: this.workspace,
          });
          await this.emit({
            type: "task.result",
            at: now(),
            taskId: task.taskId,
            status: "accepted",
            checkpoint: acceptedCheckpoint,
            summary: built.buildSummary,
            findings: reviewer.findings,
          });
          await this.releaseTaskObserved(task, built.workspace, round + 1);
          if (this.workspace.mode === "direct")
            await this.options.onRepositoryChanged?.();
          return true;
        }
        if (round >= this.options.projectConfig.harness.maxRepairRounds) {
          await this.record("task.failed", {
            taskId: task.taskId,
            reason: "repair rounds exhausted",
          });
          await this.emit({
            type: "task.result",
            at: now(),
            taskId: task.taskId,
            status: "failed",
            checkpoint: null,
            summary:
              "Blocking checks or review findings remain after the repair ceiling.",
            findings: reviewer.findings,
          });
          await this.retainFailedTask(built, "repair rounds exhausted");
          return false;
        }
        round += 1;
        await this.record("task.repair", { taskId: task.taskId, round });
        await this.emit({
          type: "progress",
          at: now(),
          phase: "repairing",
          taskId: task.taskId,
          message: `Repairing ${task.key} (${round}/${this.options.projectConfig.harness.maxRepairRounds})`,
          progress: 0,
        });
        const repair = await this.invoke(
          task,
          "repairer",
          round,
          built.workspace.path,
          repairPrompt(task, built.contract, blockers, failures, round),
          workerOutputSchema,
          built.classification,
        );
        built.buildSummary = repair.summary;
        built.workerFindings = repair.findings;
        await this.record("task.findings", {
          taskId: task.taskId,
          findings: repair.findings,
        });
        const staged = await this.stageCandidateObserved(
          task,
          built.workspace,
          repair.summary,
          true,
          round + 1,
        );
        if (staged.status === "conflict")
          throw new IntegrationConflict(
            "candidate refresh requires conflict repair",
            staged.detail,
            staged.paths,
          );
        built.candidate = staged.checkpoint;
        built.changedPaths = staged.changedPaths;
        await this.record("task.candidate", {
          taskId: task.taskId,
          candidate: built.candidate,
          workspace: built.workspace,
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const cancelled = this.abort.signal.aborted;
      await this.retainFailedTask(built, reason, !cancelled).catch(
        async (preservationError) => {
          await this.record("warning", {
            message: `failed to preserve ${task.key}: ${String(preservationError)}`,
          });
        },
      );
      await this.record(cancelled ? "task.cancelled" : "task.failed", {
        taskId: task.taskId,
        reason,
      });
      if (cancelled) return false;
      await this.emit({
        type: "task.result",
        at: now(),
        taskId: task.taskId,
        status: "failed",
        checkpoint: null,
        summary: reason,
        findings: [],
      });
      return false;
    }
  }

  private async retainFailedTask(
    built: BuiltTask,
    reason: string,
    publishWarning = true,
  ): Promise<void> {
    const location = await this.observe({
      stage: "preserve",
      operation: "preserve-failed-work",
      taskId: built.task.taskId,
      attempt: this.state.tasks[built.task.taskId]!.repairRounds + 1,
      actor: this.backendActor("vcs", "preserveFailedWork"),
      work: () =>
        this.options.backend.preserveFailedWork({
          workspace: this.workspace,
          task: built.workspace,
          taskKey: built.task.key,
          reason,
        }),
      evidence: (value) => ({
        resultDigest: digest({ retained: value !== null, vcs: value?.vcs }),
      }),
    });
    if (location) {
      await this.record("task.retained", {
        taskId: built.task.taskId,
        location,
      });
      const message = `${built.task.key} failed; work preserved at ${location.label}`;
      await this.record("warning", { message });
      if (publishWarning)
        await this.emit({
          type: "warning",
          at: now(),
          code: "failed-work-retained",
          message,
        });
    }
    await this.releaseTaskObserved(
      built.task,
      built.workspace,
      1000 + this.state.tasks[built.task.taskId]!.repairRounds,
    );
  }

  private async cleanupFailedBuildTask(
    task: RunnerTaskSnapshot,
    reason: string,
    publishWarning = true,
  ): Promise<void> {
    const retained = this.state.tasks[task.taskId];
    if (!retained?.workspace) return;
    const location = await this.observe({
      stage: "preserve",
      operation: "preserve-failed-build",
      taskId: task.taskId,
      attempt: retained.repairRounds + 1,
      actor: this.backendActor("vcs", "preserveFailedWork"),
      work: () =>
        this.options.backend.preserveFailedWork({
          workspace: this.workspace,
          task: retained.workspace!,
          taskKey: task.key,
          reason,
        }),
      evidence: (value) => ({
        resultDigest: digest({ retained: value !== null, vcs: value?.vcs }),
      }),
    });
    if (location) {
      await this.record("task.retained", { taskId: task.taskId, location });
      const message = `${task.key} build failed; work preserved at ${location.label}`;
      await this.record("warning", { message });
      if (publishWarning)
        await this.emit({
          type: "warning",
          at: now(),
          code: "failed-work-retained",
          message,
        });
    }
    await this.releaseTaskObserved(
      task,
      retained.workspace,
      2000 + retained.repairRounds,
    );
  }

  private async terminalOutput(
    status: "succeeded" | "partial" | "failed" | "cancelled",
    started: number,
    attempt: number,
  ): Promise<RunnerJobOutput> {
    const inspection = await this.observe({
      stage: "finalize",
      operation: "inspect-workspace",
      taskId: null,
      attempt,
      actor: this.backendActor("vcs", "inspect"),
      work: () => this.options.backend.inspect(this.workspace),
      evidence: (value) => ({
        changedPathCount: value.dirtyPaths.length,
        checkpointRef: value.revision,
      }),
    });
    const acceptedTaskCheckpoints = Object.fromEntries(
      Object.values(this.state.tasks)
        .filter((task) => task.status === "accepted" && task.checkpoint)
        .map((task) => [task.taskId, task.checkpoint!]),
    );
    const checks = Object.values(this.state.tasks).flatMap(
      (task) => task.checks,
    );
    const findings = Object.values(this.state.tasks).flatMap(
      (task) => task.findings,
    );
    const landing: RunnerJobLanding =
      this.workspace.mode === "direct"
        ? {
            policy: "direct",
            status: "landed",
            target: this.options.projectConfig.sourceControl.target ?? null,
            checkpoint: {
              ref: inspection.revision,
              label:
                this.options.projectConfig.sourceControl.target ??
                this.workspace.retainedLocation.label,
              url: null,
            },
            error: null,
            requestId: null,
          }
        : status !== "succeeded"
          ? {
              policy: this.options.projectConfig.sourceControl.landing,
              status: "not_applicable",
              target: this.options.projectConfig.sourceControl.target ?? null,
              checkpoint: null,
              error: null,
              requestId: null,
            }
          : this.options.projectConfig.sourceControl.landing === "auto"
            ? (this.state.automaticLanding ?? {
                policy: "auto",
                status: "failed",
                target: this.options.projectConfig.sourceControl.target ?? null,
                checkpoint: null,
                error: "automatic landing did not produce a durable outcome",
                requestId: null,
              })
            : {
                policy: this.options.projectConfig.sourceControl.landing,
                status: "retained",
                target: this.options.projectConfig.sourceControl.target ?? null,
                checkpoint: null,
                error: null,
                requestId: null,
              };
    return {
      workspaceMode: this.workspace.mode,
      retainedLocation:
        Object.keys(acceptedTaskCheckpoints).length > 0
          ? this.workspace.retainedLocation
          : (this.state.recoveryLocations.at(-1) ??
            this.workspace.retainedLocation),
      baseRevision: this.workspace.baseRevision,
      headRevision: inspection.revision,
      acceptedTaskCheckpoints,
      checks,
      findings,
      usage: this.state.usage,
      summary: `${status}: ${Object.keys(acceptedTaskCheckpoints).length} task(s) accepted in ${Math.max(0, Math.round(performance.now() - started))}ms (setup ${this.setupDurationMs}ms, checks ${this.checkDurationMs}ms).`,
      dirtyPaths: inspection.dirtyPaths,
      landing,
    };
  }

  private async performAutomaticLanding(): Promise<void> {
    if (this.state.automaticLanding) return;
    const target = this.options.projectConfig.sourceControl.target;
    if (!target)
      throw new Error("automatic landing requires sourceControl.target");
    const acceptedTaskCheckpoints = Object.fromEntries(
      Object.values(this.state.tasks)
        .filter((task) => task.status === "accepted" && task.checkpoint)
        .map((task) => [task.taskId, task.checkpoint!]),
    );
    let landing: RunnerJobLanding;
    try {
      await this.observe({
        stage: "landing",
        operation: "recover-orphans-before-auto-land",
        taskId: null,
        actor: this.backendActor("vcs", "recoverOrphans"),
        work: () =>
          this.options.backend.recoverOrphans(
            this.options.repository,
            this.options.stateDirectory,
          ),
        evidence: (value) => ({
          resultDigest: digest({ warningCount: value.length }),
        }),
      });
      const result = await this.observe({
        stage: "landing",
        operation: "auto-land",
        taskId: null,
        actor: this.backendActor("vcs", "land"),
        work: () =>
          this.options.backend.land({
            repository: this.options.repository,
            stateDirectory: this.options.stateDirectory,
            jobId: this.options.assignment.jobId,
            workspace: this.workspace,
            target,
            acceptedTaskCheckpoints,
          }),
        evidence: (value) => ({ checkpointRef: value.checkpoint.ref }),
      });
      landing = {
        policy: "auto",
        status: "landed",
        target: result.target,
        checkpoint: result.checkpoint,
        error: null,
        requestId: null,
      };
    } catch (error) {
      landing = {
        policy: "auto",
        status: "failed",
        target,
        checkpoint: null,
        error: (error instanceof Error ? error.message : String(error)).slice(
          0,
          20_000,
        ),
        requestId: null,
      };
    }
    await this.record("landing.auto.completed", { landing });
    if (landing.status === "landed") await this.options.onRepositoryChanged?.();
  }

  private async execute(): Promise<RunnerJobOutput> {
    const started = performance.now();
    const jobDirectory = join(
      this.options.stateDirectory,
      "jobs",
      safeIdPart(this.options.assignment.jobId),
    );
    await mkdir(jobDirectory, { recursive: true, mode: 0o700 });
    this.journal = await ChecksummedJournal.open(
      join(jobDirectory, "events.jsonl"),
    );
    this.state = reduceJobState(this.journal.all());
    for (const [questionId, answer] of this.earlyAnswers) {
      await this.record("question.answered", { questionId, answer });
      this.earlyAnswers.delete(questionId);
    }
    assertAcyclicSource(this.options.assignment.source);
    if (!this.state.assignment)
      await this.record("job.assigned", {
        assignment: this.options.assignment,
        projectConfig: this.options.projectConfig,
        projectConfigDigest: digest(this.options.projectConfig),
      });
    if (
      this.options.assignment.assignmentId !==
      this.state.assignment?.assignmentId
    )
      throw new Error("assignment fencing mismatch with durable state");
    const source = this.options.assignment.source;
    const assignedTasks = source.kind === "task" ? [source.task] : source.tasks;
    const decomposed = assignedTasks.find(
      (task) => executionSpecCoverage(task) === "decomposed",
    );
    if (decomposed) {
      throw new UnsupportedDecompositionError(
        `${decomposed.key} contains authored execution steps; dispatch them as first-class plan tasks`,
      );
    }
    await this.acquireCoordination(assignedTasks);
    const outputKey = source.kind === "task" ? source.task.key : source.planKey;
    if (!this.state.workspace) {
      const orphanWarnings = await this.observe({
        stage: "workspace",
        operation: "recover-orphans",
        taskId: null,
        actor: this.backendActor("vcs", "recoverOrphans"),
        work: () =>
          this.options.backend.recoverOrphans(
            this.options.repository,
            this.options.stateDirectory,
          ),
        evidence: (value) => ({
          resultDigest: digest({ warningCount: value.length }),
        }),
      });
      this.workspace = await this.observe({
        stage: "workspace",
        operation: "open-job",
        taskId: null,
        actor: this.backendActor("vcs", "openJob"),
        work: () =>
          this.options.backend.openJob({
            repository: this.options.repository,
            stateDirectory: this.options.stateDirectory,
            jobId: this.options.assignment.jobId,
            key: outputKey,
            kind: source.kind,
            expectedBaseRevision: this.options.assignment.expectedBaseRevision,
            config: this.options.projectConfig,
          }),
        evidence: (value) => ({
          checkpointRef: value.baseRevision,
          resultDigest: digest({ vcs: value.vcs, mode: value.mode }),
        }),
      });
      await this.record("workspace.opened", { workspace: this.workspace });
      for (const message of [
        ...this.options.projectConfig.normalizationWarnings,
        ...orphanWarnings,
      ]) {
        await this.record("warning", { message });
        await this.emit({
          type: "warning",
          at: now(),
          code: "configuration-or-recovery",
          message,
        });
      }
    } else
      this.workspace = await this.observe({
        stage: "workspace",
        operation: "restore-job",
        taskId: null,
        actor: this.backendActor("vcs", "restoreJob"),
        work: () =>
          this.options.backend.restoreJob({
            repository: this.options.repository,
            stateDirectory: this.options.stateDirectory,
            jobId: this.options.assignment.jobId,
            handle: this.state.workspace!.handle,
            baseRevision: this.state.workspace!.baseRevision,
            currentRevision: this.state.workspace!.currentRevision,
            mode: this.options.projectConfig.sourceControl.mode,
          }),
        evidence: (value) => ({ checkpointRef: value.currentRevision }),
      });
    this.workspaceReady = true;
    for (const event of this.state.outboundEvents) {
      const acknowledged = await this.options.sink.publish(
        this.options.assignment.jobId,
        this.options.assignment.assignmentId,
        event.seq,
        event.payload,
      );
      if (acknowledged >= event.seq)
        await this.record("event.acked", { seq: acknowledged });
    }
    if (!this.state.contextPublished) {
      const agents = (
        ["guide", "builder", "reviewer", "repairer"] as AgentRole[]
      ).flatMap((role) =>
        Object.entries(this.options.projectConfig.agents[role]).map(
          ([tier, configured]) => ({
            role: `${role}:${tier}`,
            driver: configured.driver,
            vendor: this.driver(configured, role).vendor,
            model: configured.model,
            effort: configured.effort,
          }),
        ),
      );
      await this.emit({
        type: "job.context",
        at: now(),
        vcs: this.workspace.vcs,
        workspaceMode: this.workspace.mode,
        landingPolicy:
          this.workspace.mode === "direct"
            ? "direct"
            : this.options.projectConfig.sourceControl.landing,
        agents,
      });
    }
    await this.preflight();
    await this.record("job.started", {});
    while (!this.state.stopScheduling && !this.abort.signal.aborted) {
      const accepted = new Set(
        Object.values(this.state.tasks)
          .filter((task) => task.status === "accepted")
          .map((task) => task.taskId),
      );
      const failed = new Set(
        Object.values(this.state.tasks)
          .filter((task) => task.status === "failed")
          .map((task) => task.taskId),
      );
      const ready = readyTasks(
        source,
        {
          accepted,
          failed,
          running: new Set(),
          stopScheduling: this.state.stopScheduling,
        },
        !this.options.backend.capabilities.parallelTaskWorkspaces
          ? 1
          : this.workspace.mode === "direct"
            ? 1
            : this.options.projectConfig.harness.maxParallelTasks,
      );
      if (ready.length === 0) break;
      const built = await Promise.allSettled(
        ready.map((task) => this.buildTask(task)),
      );
      const successful: BuiltTask[] = [];
      for (let index = 0; index < built.length; index += 1) {
        const result = built[index]!;
        const task = ready[index]!;
        if (result.status === "fulfilled") successful.push(result.value);
        else {
          const reason = String(result.reason);
          const cancelled = this.abort.signal.aborted;
          await this.cleanupFailedBuildTask(task, reason, !cancelled).catch(
            async (preservationError) => {
              await this.record("warning", {
                message: `failed to clean up ${task.key}: ${String(preservationError)}`,
              });
            },
          );
          await this.record(cancelled ? "task.cancelled" : "task.failed", {
            taskId: task.taskId,
            reason,
          });
          if (cancelled) continue;
          await this.emit({
            type: "task.result",
            at: now(),
            taskId: task.taskId,
            status: "failed",
            checkpoint: null,
            summary: reason,
            findings: [],
          });
        }
      }
      for (const task of successful.sort(
        (left, right) =>
          left.task.phaseOrder - right.task.phaseOrder ||
          left.task.order - right.task.order ||
          left.task.key.localeCompare(right.task.key),
      )) {
        if (this.abort.signal.aborted) {
          await this.retainFailedTask(task, "job cancelled", false).catch(
            async (preservationError) => {
              await this.record("warning", {
                message: `failed to preserve ${task.task.key}: ${String(preservationError)}`,
              });
            },
          );
          await this.record("task.cancelled", {
            taskId: task.task.taskId,
          });
          continue;
        }
        await this.settleTask(task);
      }
    }
    if (this.abort.signal.aborted) await this.record("job.cancelled", {});
    for (const task of Object.values(this.state.tasks)) {
      if (task.status === "pending" && this.abort.signal.aborted)
        await this.record("task.cancelled", { taskId: task.taskId });
    }
    const acceptedCount = Object.values(this.state.tasks).filter(
      (task) => task.status === "accepted",
    ).length;
    const failedCount = Object.values(this.state.tasks).filter(
      (task) => task.status === "failed",
    ).length;
    const status = this.abort.signal.aborted
      ? "cancelled"
      : failedCount === 0 &&
          acceptedCount === Object.keys(this.state.tasks).length
        ? "succeeded"
        : acceptedCount > 0
          ? "partial"
          : "failed";
    await this.emit({
      type: "progress",
      at: now(),
      phase: "finalizing",
      message: `Finalizing ${outputKey}`,
      progress: 0,
    });
    if (
      status === "succeeded" &&
      this.workspace.mode === "isolated" &&
      this.options.projectConfig.sourceControl.landing === "auto"
    ) {
      if (this.coordination)
        await this.coordination.exchange(
          {
            repositoryKey: this.options.projectConfig.repositoryKey,
            lane:
              this.options.projectConfig.sourceControl.target ??
              this.options.projectConfig.sourceControl.base,
            kind: "landing",
            paths: [],
          },
          this.abort.signal,
          this.coordinationDeadline,
        );
      await this.performAutomaticLanding();
    }
    const output = await this.observe({
      stage: "finalize",
      operation: "terminal-output",
      taskId: null,
      actor: this.backendActor("runner", "terminalOutput"),
      work: () => this.terminalOutput(status, started, 1),
      evidence: (value) => ({
        changedPathCount: value.dirtyPaths.length,
        checkpointRef: value.headRevision,
        blockerFindings: value.findings.filter(
          (item) => item.severity === "blocker",
        ).length,
        majorFindings: value.findings.filter(
          (item) => item.severity === "major",
        ).length,
        minorFindings: value.findings.filter(
          (item) => item.severity === "minor",
        ).length,
      }),
    });
    await this.releaseWorkspaceObserved(1);
    await this.emit({ type: "terminal", at: now(), status, output });
    await this.record("job.terminal", { status });
    return output;
  }

  async run(): Promise<RunnerJobOutput> {
    const started = performance.now();
    try {
      return await this.execute();
    } catch (error) {
      if (!this.journal || !this.state || !this.workspaceReady) throw error;
      const message = error instanceof Error ? error.message : String(error);
      await this.emit({
        type: "progress",
        at: now(),
        phase: "finalizing",
        message: "Finalizing failed RunnerJob",
        progress: 0,
      });
      await this.record("warning", { message });
      for (const task of Object.values(this.state.tasks)) {
        if (task.status === "running") {
          const snapshot =
            this.options.assignment.source.kind === "task"
              ? this.options.assignment.source.task
              : this.options.assignment.source.tasks.find(
                  (candidate) => candidate.taskId === task.taskId,
                );
          if (snapshot)
            await this.cleanupFailedBuildTask(
              snapshot,
              message,
              !this.abort.signal.aborted,
            ).catch(async (preservationError) => {
              await this.record("warning", {
                message: `failed to clean up ${snapshot.key}: ${String(preservationError)}`,
              });
            });
          await this.record(
            this.abort.signal.aborted ? "task.cancelled" : "task.failed",
            {
              taskId: task.taskId,
              reason: message,
            },
          );
        }
      }
      const accepted = Object.values(this.state.tasks).some(
        (task) => task.status === "accepted",
      );
      const status = this.abort.signal.aborted
        ? "cancelled"
        : accepted
          ? "partial"
          : "failed";
      const output = await this.observe({
        stage: "finalize",
        operation: "terminal-output",
        taskId: null,
        attempt: 2,
        actor: this.backendActor("runner", "terminalOutput"),
        work: () => this.terminalOutput(status, started, 2),
        evidence: (value) => ({
          changedPathCount: value.dirtyPaths.length,
          checkpointRef: value.headRevision,
        }),
      });
      await this.releaseWorkspaceObserved(2);
      await this.emit({ type: "terminal", at: now(), status, output });
      await this.record("job.terminal", { status });
      return output;
    } finally {
      try {
        if (this.workspaceReady && !this.workspaceReleased)
          await this.options.backend.release(
            this.workspace,
            this.options.assignment.jobId,
          );
      } finally {
        await this.coordination?.release().catch(async (error) => {
          if (this.journal)
            await this.record("warning", {
              message: `coordination lease release deferred: ${String(error)}`,
            });
        });
      }
    }
  }
}

export async function loadDurableJobState(
  stateDirectory: string,
  jobId: string,
): Promise<JobState | null> {
  const path = join(stateDirectory, "jobs", safeIdPart(jobId), "events.jsonl");
  const journal = await ChecksummedJournal.open(path);
  return journal.all().length > 0 ? reduceJobState(journal.all()) : null;
}

async function appendDurableRecord(
  journal: ChecksummedJournal,
  type: string,
  payload: unknown,
): Promise<JobState> {
  await journal.append(type, payload);
  const state = reduceJobState(journal.all());
  await journal.writeSnapshot(state);
  return state;
}

export async function landDurableJob(options: {
  stateDirectory: string;
  repository: string;
  projectConfig: ProjectConfig;
  backend: SourceControlBackend;
  jobId: string;
  assignmentId: string;
  requestId: string;
  target: string;
  sink?: JobEventSink;
  coordination?: {
    provider: CoordinationProvider;
    runnerId: string;
    checkoutId: string;
    projectId: string;
  };
}): Promise<LandingReport> {
  const journal = await ChecksummedJournal.open(
    join(
      options.stateDirectory,
      "jobs",
      safeIdPart(options.jobId),
      "events.jsonl",
    ),
  );
  let state = reduceJobState(journal.all());
  if (
    !state.assignment ||
    state.assignment.assignmentId !== options.assignmentId
  )
    throw new Error("landing request does not match the durable assignment");
  if (state.status !== "succeeded")
    throw new Error("only a durably succeeded RunnerJob can be landed");
  if (!state.workspace)
    throw new Error("durable RunnerJob has no retained workspace");
  if (state.workspace.mode !== "isolated")
    throw new Error("direct RunnerJob output is already landed");
  if (!["manual", "auto"].includes(options.projectConfig.sourceControl.landing))
    throw new Error("project configuration does not authorize Runner landing");
  if (
    options.projectConfig.sourceControl.target !== options.target ||
    !options.projectConfig.sourceControl.target
  )
    throw new Error(
      "landing target differs from the committed project configuration",
    );

  const existing = state.landingRequests[options.requestId];
  if (existing) {
    if (existing.target !== options.target)
      throw new Error("landing request id was reused for a different target");
    if (existing.result) return existing.result;
  } else {
    state = await appendDurableRecord(journal, "landing.requested", {
      requestId: options.requestId,
      target: options.target,
    });
  }
  const acceptedTaskCheckpoints = Object.fromEntries(
    Object.values(state.tasks)
      .filter((task) => task.status === "accepted" && task.checkpoint)
      .map((task) => [task.taskId, task.checkpoint!]),
  );
  const workspace = state.workspace;
  if (!workspace)
    throw new Error("durable RunnerJob lost its retained workspace");
  const landingAbort = new AbortController();
  const coordination = options.coordination
    ? new DurableLeaseManager(options.coordination.provider, {
        stateDirectory: options.stateDirectory,
        identity: {
          runnerId: options.coordination.runnerId,
          checkoutId: options.coordination.checkoutId,
          projectId: options.coordination.projectId,
          jobId: options.jobId,
          assignmentId: options.assignmentId,
          taskId: null,
          idempotencyKey: `${options.jobId}:landing:${options.requestId}:v1`,
          landingRequestId: options.requestId,
        },
        onWaiting: async (attempt, delayMs) => {
          state = await appendDurableRecord(
            journal,
            "coordination.landing.waiting",
            { requestId: options.requestId, attempt, delayMs },
          );
        },
        onAcquired: async (lease) => {
          state = await appendDurableRecord(
            journal,
            "coordination.landing.acquired",
            {
              requestId: options.requestId,
              leaseId: lease.leaseId,
              fencingToken: lease.fencingToken,
              expiresAt: lease.expiresAt,
            },
          );
        },
        onLost: async (error) => {
          state = await appendDurableRecord(
            journal,
            "coordination.landing.lost",
            {
              requestId: options.requestId,
              message: (error instanceof Error
                ? error.message
                : String(error)
              ).slice(0, 500),
            },
          );
          landingAbort.abort(new Error("landing coordination lease was lost"));
        },
      })
    : null;
  let result: LandingReport;
  const publish = async (payload: RunnerJobEventPayload): Promise<void> => {
    if (!options.sink) return;
    const seq = state.nextEventSeq;
    state = await appendDurableRecord(journal, "event.queued", {
      seq,
      payload,
    });
    const acknowledged = await options.sink.publish(
      options.jobId,
      options.assignmentId,
      seq,
      payload,
    );
    if (acknowledged >= seq)
      state = await appendDurableRecord(journal, "event.acked", {
        seq: acknowledged,
      });
  };
  const observeLanding = async <T>(
    operation: string,
    requestedAttempt: number,
    work: () => Promise<T>,
    evidence: (value: T) => Partial<RunnerJobObservationEvidence>,
  ): Promise<T> => {
    let attempt = requestedAttempt;
    const observationIdFor = () =>
      createHash("sha256")
        .update(
          `${options.jobId}:landing:${options.requestId}:${operation}:${attempt}`,
        )
        .digest("hex")
        .slice(0, 32);
    let observationId = observationIdFor();
    while (state.observations[observationId]?.finished) {
      attempt += 1;
      observationId = observationIdFor();
    }
    const actor: RunnerJobObservationActor = {
      kind: "vcs",
      driver: options.backend.id,
      vendor: null,
      model: null,
      effort: null,
      role: null,
      operation,
    };
    const startedAt = now();
    const recovered = Boolean(state.observations[observationId]?.started);
    if (!recovered)
      await publish({
        type: "stage.started",
        at: startedAt,
        observationId,
        taskId: null,
        stage: "landing",
        attempt,
        actor,
      });
    const monotonicStarted = performance.now();
    try {
      const value = await work();
      if (!state.observations[observationId]?.finished)
        await publish({
          type: "stage.finished",
          at: now(),
          startedAt,
          observationId,
          taskId: null,
          stage: "landing",
          attempt,
          actor,
          outcome: "succeeded",
          duration: observedMetric(
            Math.max(0, Math.round(performance.now() - monotonicStarted)),
            "complete",
            "runner_reported",
          ),
          usage: notApplicableUsage(),
          recovery: recovered ? "process_recovery" : "none",
          evidence: emptyEvidence({
            operationDigest: digest({ driver: options.backend.id, operation }),
            ...evidence(value),
          }),
        });
      return value;
    } catch (error) {
      if (!state.observations[observationId]?.finished)
        await publish({
          type: "stage.finished",
          at: now(),
          startedAt,
          observationId,
          taskId: null,
          stage: "landing",
          attempt,
          actor,
          outcome: "failed",
          duration: observedMetric(
            Math.max(0, Math.round(performance.now() - monotonicStarted)),
            "complete",
            "runner_reported",
          ),
          usage: notApplicableUsage(),
          recovery: recovered ? "process_recovery" : "none",
          evidence: emptyEvidence({
            operationDigest: digest({ driver: options.backend.id, operation }),
            errorCode: safeErrorCode(error),
          }),
        });
      throw error;
    }
  };
  try {
    if (coordination) {
      const desired: LeaseScope = {
        repositoryKey: options.projectConfig.repositoryKey,
        lane: options.target,
        kind: "landing",
        paths: [],
      };
      const recovered = await coordination.recover();
      if (!recovered)
        await coordination.acquire(
          desired,
          landingAbort.signal,
          Date.now() + options.projectConfig.harness.maxJobMinutes * 60_000,
        );
      else if (
        recovered.kind !== desired.kind ||
        recovered.repositoryKey !== desired.repositoryKey ||
        recovered.lane !== desired.lane ||
        recovered.paths.length !== 0
      )
        throw new Error("recovered landing lease has an unexpected scope");
    }
    if (landingAbort.signal.aborted) throw landingAbort.signal.reason;
    await observeLanding(
      "recoverOrphans",
      1,
      () =>
        options.backend.recoverOrphans(
          options.repository,
          options.stateDirectory,
        ),
      (value) => ({ resultDigest: digest({ warningCount: value.length }) }),
    );
    if (landingAbort.signal.aborted) throw landingAbort.signal.reason;
    const landed = await observeLanding(
      "land",
      1,
      () =>
        options.backend.land({
          repository: options.repository,
          stateDirectory: options.stateDirectory,
          jobId: options.jobId,
          workspace,
          target: options.target,
          acceptedTaskCheckpoints,
        }),
      (value) => ({ checkpointRef: value.checkpoint.ref }),
    );
    result = {
      status: "landed",
      target: landed.target,
      checkpoint: landed.checkpoint,
      error: null,
    };
  } catch (error) {
    result = {
      status: "failed",
      target: options.target,
      checkpoint: null,
      error: (error instanceof Error ? error.message : String(error)).slice(
        0,
        20_000,
      ),
    };
  } finally {
    await coordination?.release().catch(async (error) => {
      state = await appendDurableRecord(journal, "warning", {
        message: `landing coordination lease release deferred: ${String(error)}`,
      });
    });
  }
  await appendDurableRecord(journal, "landing.completed", {
    requestId: options.requestId,
    result,
  });
  return result;
}

export async function acknowledgeDurableLanding(
  stateDirectory: string,
  jobId: string,
  requestId: string,
): Promise<void> {
  const journal = await ChecksummedJournal.open(
    join(stateDirectory, "jobs", safeIdPart(jobId), "events.jsonl"),
  );
  const state = reduceJobState(journal.all());
  const request = state.landingRequests[requestId];
  if (!request?.result || request.status === "acked") return;
  await appendDurableRecord(journal, "landing.acked", { requestId });
}

export interface PendingLandingResult extends LandingReport {
  jobId: string;
  assignmentId: string;
  requestId: string;
}

export async function loadPendingLandingResults(
  stateDirectory: string,
): Promise<PendingLandingResult[]> {
  const jobsDirectory = join(stateDirectory, "jobs");
  let entries: string[];
  try {
    entries = await readdir(jobsDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const pending: PendingLandingResult[] = [];
  for (const entry of entries) {
    const journal = await ChecksummedJournal.open(
      join(jobsDirectory, entry, "events.jsonl"),
    );
    const state = reduceJobState(journal.all());
    if (!state.assignment) continue;
    for (const request of Object.values(state.landingRequests)) {
      if (request.status !== "completed" || !request.result) continue;
      pending.push({
        jobId: state.assignment.jobId,
        assignmentId: state.assignment.assignmentId,
        requestId: request.requestId,
        ...request.result,
      });
    }
  }
  return pending;
}

export class MemoryEventSink implements JobEventSink {
  readonly events: Array<{
    jobId: string;
    assignmentId: string;
    seq: number;
    payload: RunnerJobEventPayload;
  }> = [];
  async publish(
    jobId: string,
    assignmentId: string,
    seq: number,
    payload: RunnerJobEventPayload,
  ): Promise<number> {
    const prior = this.events.find(
      (event) => event.jobId === jobId && event.seq === seq,
    );
    if (prior && JSON.stringify(prior.payload) !== JSON.stringify(payload))
      throw new Error("conflicting event replay");
    if (!prior) this.events.push({ jobId, assignmentId, seq, payload });
    return Math.max(
      ...this.events
        .filter((event) => event.jobId === jobId)
        .map((event) => event.seq),
    );
  }
}
