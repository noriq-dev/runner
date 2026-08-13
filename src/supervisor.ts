import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectConfig } from "./config.js";
import type {
  CheckResult,
  Finding,
  JobAssignment,
  RunnerJobEventPayload,
  RunnerJobOutput,
  RunnerTaskSnapshot,
} from "./contracts.js";
import { assertAcyclicSource, hasExecutionSpec } from "./contracts.js";
import type {
  AgentDriver,
  AgentRequest,
  AgentResult,
  AgentRole,
} from "./drivers/types.js";
import { ChecksummedJournal } from "./journal.js";
import {
  builderPrompt,
  executionSpecContract,
  guideOutputSchema,
  guidePrompt,
  repairPrompt,
  reviewerPrompt,
  type TaskContract,
  workerOutputSchema,
} from "./prompts.js";
import { readyTasks } from "./scheduler.js";
import { type JobState, reduceJobState } from "./state.js";
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
  buildSummary: string;
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

export class RunnerJobSupervisor {
  private journal!: ChecksummedJournal;
  private state!: JobState;
  private readonly abort = new AbortController();
  private workspace!: JobWorkspace;
  private workspaceReady = false;
  private setupDurationMs = 0;
  private checkDurationMs = 0;
  private readonly answerWaiters = new Map<
    string,
    { resolve: (answer: string) => void; reject: (error: Error) => void }
  >();
  private readonly earlyAnswers = new Map<string, string>();
  private recordTail: Promise<void> = Promise.resolve();
  private emitTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      assignment: JobAssignment;
      repository: string;
      stateDirectory: string;
      projectConfig: ProjectConfig;
      backend: SourceControlBackend;
      drivers: Record<string, AgentDriver | undefined>;
      sink: JobEventSink;
    },
  ) {}

  cancel(): void {
    this.abort.abort(new Error("job cancelled"));
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

  private driver(role: AgentRole): AgentDriver {
    const profile =
      this.options.projectConfig.agents[role === "repairer" ? "builder" : role];
    const driver = this.options.drivers[profile.driver];
    if (!driver)
      throw new Error(`driver ${profile.driver} is not configured for ${role}`);
    return driver;
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

  private async invoke(
    task: RunnerTaskSnapshot,
    role: AgentRole,
    round: number,
    workspace: string,
    prompt: string,
    schema: Record<string, unknown>,
  ): Promise<AgentResult> {
    this.enforceBudget();
    const id = invocationId(
      this.options.assignment.jobId,
      task.taskId,
      role,
      round,
    );
    const driver = this.driver(role);
    const completed = this.state.invocations[id];
    const recovered = await driver.recover(id);
    if (completed?.status === "completed" && recovered) return recovered;
    if (!completed)
      await this.record("invocation.started", {
        id,
        taskId: task.taskId,
        role,
        status: "started",
      });
    if (recovered) {
      await this.record("invocation.completed", {
        id,
        resultDigest: resultDigest(recovered),
        recovered: true,
      });
      await this.record("usage.recorded", { id, usage: recovered.usage });
      return recovered;
    }
    const request: AgentRequest = {
      invocationId: id,
      role,
      taskId: task.taskId,
      taskKey: task.key,
      workspace,
      access:
        role === "guide" || role === "reviewer"
          ? "read-only"
          : "workspace-write",
      prompt,
      outputSchema: schema,
      projectConfig: this.options.projectConfig,
      signal: this.abort.signal,
    };
    const session = await driver.start(request);
    const result = await session.result();
    await this.record("invocation.completed", {
      id,
      resultDigest: resultDigest(result),
      recovered: false,
    });
    await this.record("usage.recorded", { id, usage: result.usage });
    return result;
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
    const roles: AgentRole[] = ["guide", "builder", "reviewer"];
    const checked = new Set<string>();
    for (const role of roles) {
      const driver = this.driver(role);
      const access =
        role === "guide" || role === "reviewer"
          ? "read-only"
          : "workspace-write";
      const key = `${driver.id}:${access}:${role === "guide"}`;
      if (checked.has(key)) continue;
      checked.add(key);
      const result = await driver.preflight({
        workspace: this.workspace.path,
        access,
        requireControlMcp: role === "guide",
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

  private async buildTask(task: RunnerTaskSnapshot): Promise<BuiltTask> {
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
      message: `Planning ${task.key}`,
      progress: 0,
    });
    let contract: TaskContract;
    let plan: string;
    let guideInstructions: string | undefined;
    if (hasExecutionSpec(task.executionSpec)) {
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
      contract = taskContract(guide);
      plan = guide.plan ?? String(guide.structured.plan ?? guide.summary);
    }
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
      (await this.options.backend.beginTask(this.workspace, task.key));
    if (!retained?.workspace)
      await this.record("task.workspace", {
        taskId: task.taskId,
        workspace: taskWorkspace,
        jobWorkspace: this.workspace,
      });
    if (this.options.projectConfig.setup.commands.length > 0) {
      const started = Date.now();
      const setup = await this.options.backend.runCommands(
        taskWorkspace.path,
        this.options.projectConfig.setup.commands,
        this.options.projectConfig.setup.timeoutSeconds,
        this.abort.signal,
      );
      this.setupDurationMs += Date.now() - started;
      if (failedChecks(setup).length > 0)
        throw new Error(
          `setup failed for ${task.key}: ${failedChecks(setup)[0]!.output}`,
        );
    }
    await this.emit({
      type: "progress",
      at: now(),
      phase: "building",
      message: `Building ${task.key}`,
      progress: 0,
    });
    const builder = await this.invoke(
      task,
      "builder",
      0,
      taskWorkspace.path,
      builderPrompt(task, contract, guideInstructions),
      workerOutputSchema,
    );
    let candidate = retained?.candidate;
    if (!candidate) {
      const staged = await this.options.backend.stageCandidate({
        workspace: this.workspace,
        task: taskWorkspace,
        taskKey: task.key,
        summary: builder.summary,
        refresh: false,
      });
      if (staged.status === "conflict")
        throw new IntegrationConflict(
          "candidate staging requires conflict repair",
          staged.detail,
          staged.paths,
        );
      candidate = staged.checkpoint;
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
      buildSummary: builder.summary,
    };
  }

  private async settleTask(built: BuiltTask): Promise<boolean> {
    const { task } = built;
    let round = 0;
    try {
      while (true) {
        const integration = await this.options.backend.integrateLatest(
          this.workspace,
          built.workspace,
        );
        if (integration?.status === "conflict") {
          if (!this.options.backend.capabilities.automatedConflictRepair)
            throw new Error(
              `${this.options.backend.id} integration requires human resolution: ${integration.detail}`,
            );
          if (round >= this.options.projectConfig.harness.maxRepairRounds) {
            await this.options.backend.abortConflict(built.workspace);
            throw new Error("integration conflict exceeded the repair ceiling");
          }
          round += 1;
          await this.record("task.repair", { taskId: task.taskId, round });
          await this.emit({
            type: "progress",
            at: now(),
            phase: "repairing",
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
            );
            await this.options.backend.continueConflict(built.workspace);
            const staged = await this.options.backend.stageCandidate({
              workspace: this.workspace,
              task: built.workspace,
              taskKey: task.key,
              summary: repair.summary,
              refresh: true,
            });
            if (staged.status === "conflict") throw new Error(staged.detail);
            built.candidate = staged.checkpoint;
            await this.record("task.candidate", {
              taskId: task.taskId,
              candidate: built.candidate,
              workspace: built.workspace,
            });
          } catch (repairError) {
            await this.options.backend.abortConflict(built.workspace);
            throw repairError;
          }
          continue;
        }
        if (integration?.status === "ready") {
          built.candidate = integration.checkpoint;
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
          message: `Checking ${task.key}`,
          progress: 0,
        });
        const checkStarted = Date.now();
        const checks = await this.options.backend.runCommands(
          built.workspace.path,
          this.options.projectConfig.checks.commands,
          this.options.projectConfig.checks.timeoutSeconds,
          this.abort.signal,
        );
        this.checkDurationMs += Date.now() - checkStarted;
        await this.record("task.checked", { taskId: task.taskId, checks });
        const diff = await this.options.backend.reviewDiff(
          this.workspace,
          built.workspace,
          built.candidate,
        );
        await this.emit({
          type: "progress",
          at: now(),
          phase: "reviewing",
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
            message: `Accepting ${task.key}`,
            progress: 0,
          });
          let acceptedCheckpoint: SourceControlCheckpoint;
          try {
            this.workspace.handle.state.acceptingTask = task.key;
            await this.record("workspace.updated", {
              workspace: this.workspace,
            });
            acceptedCheckpoint = await this.options.backend.acceptCandidate({
              workspace: this.workspace,
              task: built.workspace,
              candidate: built.candidate,
              taskKey: task.key,
            });
          } catch (error) {
            if (!(error instanceof IntegrationConflict)) throw error;
            const reintegration = await this.options.backend.integrateLatest(
              this.workspace,
              built.workspace,
            );
            if (!reintegration || reintegration.status === "ready") {
              const restaged = await this.options.backend.stageCandidate({
                workspace: this.workspace,
                task: built.workspace,
                taskKey: task.key,
                summary: "candidate refreshed after target movement",
                refresh: true,
              });
              if (restaged.status === "conflict")
                throw new Error(restaged.detail);
              built.candidate = restaged.checkpoint;
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
            );
            await this.options.backend.continueConflict(built.workspace);
            const restaged = await this.options.backend.stageCandidate({
              workspace: this.workspace,
              task: built.workspace,
              taskKey: task.key,
              summary: repair.summary,
              refresh: true,
            });
            if (restaged.status === "conflict")
              throw new Error(restaged.detail);
            built.candidate = restaged.checkpoint;
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
          await this.options.backend.releaseTask(
            this.workspace,
            built.workspace,
          );
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
        );
        const staged = await this.options.backend.stageCandidate({
          workspace: this.workspace,
          task: built.workspace,
          taskKey: task.key,
          summary: repair.summary,
          refresh: true,
        });
        if (staged.status === "conflict")
          throw new IntegrationConflict(
            "candidate refresh requires conflict repair",
            staged.detail,
            staged.paths,
          );
        built.candidate = staged.checkpoint;
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
    const location = await this.options.backend.preserveFailedWork({
      workspace: this.workspace,
      task: built.workspace,
      taskKey: built.task.key,
      reason,
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
    await this.options.backend.releaseTask(this.workspace, built.workspace);
  }

  private async cleanupFailedBuildTask(
    task: RunnerTaskSnapshot,
    reason: string,
    publishWarning = true,
  ): Promise<void> {
    const retained = this.state.tasks[task.taskId];
    if (!retained?.workspace) return;
    const location = await this.options.backend.preserveFailedWork({
      workspace: this.workspace,
      task: retained.workspace,
      taskKey: task.key,
      reason,
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
    await this.options.backend.releaseTask(this.workspace, retained.workspace);
  }

  private async terminalOutput(
    status: "succeeded" | "partial" | "failed" | "cancelled",
    started: number,
  ): Promise<RunnerJobOutput> {
    const inspection = await this.options.backend.inspect(this.workspace);
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
      summary: `${status}: ${Object.keys(acceptedTaskCheckpoints).length} task(s) accepted in ${Date.now() - started}ms (setup ${this.setupDurationMs}ms, checks ${this.checkDurationMs}ms).`,
      dirtyPaths: inspection.dirtyPaths,
    };
  }

  private async execute(): Promise<RunnerJobOutput> {
    const started = Date.now();
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
      });
    if (
      this.options.assignment.assignmentId !==
      this.state.assignment?.assignmentId
    )
      throw new Error("assignment fencing mismatch with durable state");
    const source = this.options.assignment.source;
    const outputKey = source.kind === "task" ? source.task.key : source.planKey;
    if (!this.state.workspace) {
      const orphanWarnings = await this.options.backend.recoverOrphans(
        this.options.repository,
        this.options.stateDirectory,
      );
      this.workspace = await this.options.backend.openJob({
        repository: this.options.repository,
        stateDirectory: this.options.stateDirectory,
        jobId: this.options.assignment.jobId,
        key: outputKey,
        kind: source.kind,
        expectedBaseRevision: this.options.assignment.expectedBaseRevision,
        config: this.options.projectConfig,
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
      this.workspace = await this.options.backend.restoreJob({
        repository: this.options.repository,
        stateDirectory: this.options.stateDirectory,
        jobId: this.options.assignment.jobId,
        handle: this.state.workspace.handle,
        baseRevision: this.state.workspace.baseRevision,
        currentRevision: this.state.workspace.currentRevision,
        mode: this.options.projectConfig.sourceControl.mode,
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
    const output = await this.terminalOutput(status, started);
    await this.emit({ type: "terminal", at: now(), status, output });
    await this.record("job.terminal", { status });
    return output;
  }

  async run(): Promise<RunnerJobOutput> {
    const started = Date.now();
    try {
      return await this.execute();
    } catch (error) {
      if (!this.journal || !this.state || !this.workspaceReady) throw error;
      const message = error instanceof Error ? error.message : String(error);
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
      const output = await this.terminalOutput(status, started);
      await this.emit({ type: "terminal", at: now(), status, output });
      await this.record("job.terminal", { status });
      return output;
    } finally {
      if (this.workspaceReady)
        await this.options.backend.release(
          this.workspace,
          this.options.assignment.jobId,
        );
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
