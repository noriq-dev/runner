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
import { assertAcyclicSource } from "./contracts.js";
import {
  abortRebase,
  amendCheckpoint,
  checkpoint,
  continueRebase,
  createTaskWorktree,
  currentRevision,
  diffForReview,
  dirtyPaths,
  GitRebaseConflict,
  integrateTask,
  integrateWip,
  type JobWorkspace,
  normalizeWipCheckpoint,
  prepareJobWorkspace,
  rebaseTask,
  releaseJobWorkspace,
  removeTaskWorktree,
  restoreJobWorkspace,
  runCommands,
  safeRefPart,
} from "./git.js";
import { ChecksummedJournal } from "./journal.js";
import {
  builderPrompt,
  guideOutputSchema,
  guidePrompt,
  repairPrompt,
  reviewerPrompt,
  type TaskContract,
  workerOutputSchema,
} from "./prompts.js";
import { resultDigest } from "./providers/process-adapter.js";
import type {
  AgentRequest,
  AgentResult,
  AgentRole,
  ProviderAdapter,
} from "./providers/types.js";
import { readyTasks } from "./scheduler.js";
import { type JobState, reduceJobState } from "./state.js";

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
  path: string;
  branch: string;
  draftCommit: string | null;
  buildSummary: string;
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

  constructor(
    private readonly options: {
      assignment: JobAssignment;
      repository: string;
      stateDirectory: string;
      projectConfig: ProjectConfig;
      providers: Record<
        "codex" | "claude" | "fake",
        ProviderAdapter | undefined
      >;
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

  private provider(role: AgentRole): ProviderAdapter {
    const profile =
      this.options.projectConfig.agents[role === "repairer" ? "builder" : role];
    const adapter = this.options.providers[profile.provider];
    if (!adapter)
      throw new Error(
        `provider ${profile.provider} is not configured for ${role}`,
      );
    return adapter;
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
    const provider = this.provider(role);
    const completed = this.state.invocations[id];
    const recovered = await provider.recover(id);
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
      await this.record("usage.recorded", { usage: recovered.usage });
      return recovered;
    }
    const request: AgentRequest = {
      invocationId: id,
      role,
      taskId: task.taskId,
      taskKey: task.key,
      workspace,
      prompt,
      outputSchema: schema,
      projectConfig: this.options.projectConfig,
      signal: this.abort.signal,
    };
    const result = await provider.invoke(request);
    await this.record("invocation.completed", {
      id,
      resultDigest: resultDigest(result),
      recovered: false,
    });
    await this.record("usage.recorded", { usage: result.usage });
    return result;
  }

  private async emit(payload: RunnerJobEventPayload): Promise<void> {
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
      const adapter = this.provider(role);
      const key = `${adapter.name}:${role === "guide"}`;
      if (checked.has(key)) continue;
      checked.add(key);
      const result = await adapter.preflight(
        this.workspace.path,
        role === "guide",
      );
      if (!result.authenticated || !result.structuredOutput)
        throw new Error(`${adapter.name} is not ready`);
      if (role === "guide" && !result.runnerControlVisible)
        throw new Error(`${adapter.name} cannot see the Runner Control MCP`);
      const finiteBudget =
        this.options.projectConfig.harness.maxTokens !== undefined ||
        this.options.projectConfig.harness.maxCostUsd !== undefined;
      if (
        finiteBudget &&
        (!result.costEnforcement || result.usageReporting === "none")
      )
        throw new Error(
          `${adapter.name} cannot enforce the configured finite token/cost cap`,
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
      commit: null,
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
    let guideRound = 0;
    let guideContext = guidePrompt(task);
    let guide: AgentResult;
    let guideInstructions: string | undefined;
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
    const contract = taskContract(guide);
    const plan = guide.plan ?? String(guide.structured.plan ?? guide.summary);
    await this.record("task.plan", { taskId: task.taskId, plan });
    await this.emit({
      type: "task.plan",
      at: now(),
      taskId: task.taskId,
      plan,
    });
    const retained = this.state.tasks[task.taskId];
    const taskWorkspace =
      retained?.workspace && retained.branch
        ? {
            path: retained.workspace,
            branch: retained.branch,
            baseRevision:
              retained.workspaceBase ??
              (await currentRevision(retained.workspace)),
          }
        : await createTaskWorktree(this.workspace, task.key);
    if (!retained?.workspace)
      await this.record("task.workspace", {
        taskId: task.taskId,
        path: taskWorkspace.path,
        branch: taskWorkspace.branch,
        baseRevision: taskWorkspace.baseRevision,
      });
    if (this.options.projectConfig.setup.commands.length > 0) {
      const started = Date.now();
      const setup = await runCommands(
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
    let draftCommit: string | null = null;
    if (this.workspace.mode === "isolated") {
      draftCommit = retained?.draftCommit ?? null;
      if (!draftCommit) {
        const paths = await dirtyPaths(taskWorkspace.path);
        draftCommit =
          paths.length > 0
            ? await checkpoint(taskWorkspace.path, task.key, builder.summary)
            : await currentRevision(taskWorkspace.path);
        await this.record("task.draft", {
          taskId: task.taskId,
          commit: draftCommit,
        });
      }
    }
    return {
      task,
      contract,
      plan,
      path: taskWorkspace.path,
      branch: taskWorkspace.branch,
      draftCommit,
      buildSummary: builder.summary,
    };
  }

  private async settleTask(built: BuiltTask): Promise<boolean> {
    const { task } = built;
    let round = 0;
    try {
      if (this.workspace.mode === "isolated") {
        const rebaseActionId = `rebase:${task.taskId}:${built.draftCommit}`;
        await this.record("action.intent", {
          id: rebaseActionId,
        });
        try {
          await rebaseTask(this.workspace, built.path);
        } catch (error) {
          if (!(error instanceof GitRebaseConflict)) throw error;
          if (round >= this.options.projectConfig.harness.maxRepairRounds) {
            await abortRebase(built.path);
            throw new Error("integration conflict exceeded the repair ceiling");
          }
          round += 1;
          await this.record("task.repair", { taskId: task.taskId, round });
          await this.emit({
            type: "progress",
            at: now(),
            phase: "repairing",
            message: `Repairing integration conflict for ${task.key} (${round}/${this.options.projectConfig.harness.maxRepairRounds})`,
            progress: 0,
          });
          try {
            await this.invoke(
              task,
              "repairer",
              round,
              built.path,
              repairPrompt(
                task,
                built.contract,
                [],
                [
                  {
                    command: "git rebase",
                    exitCode: 1,
                    durationMs: 0,
                    output: error.output,
                    timedOut: false,
                  },
                ],
                round,
              ),
              workerOutputSchema,
            );
            await continueRebase(built.path);
          } catch (repairError) {
            await abortRebase(built.path);
            throw repairError;
          }
        }
        built.draftCommit = await currentRevision(built.path);
        await this.record("action.completed", {
          id: rebaseActionId,
          result: built.draftCommit,
        });
      } else {
        const head = await currentRevision(built.path);
        if (head !== this.workspace.expectedHead)
          throw new Error(
            `direct branch HEAD drifted from ${this.workspace.expectedHead} to ${head}`,
          );
      }
      while (true) {
        await this.emit({
          type: "progress",
          at: now(),
          phase: "checking",
          message: `Checking ${task.key}`,
          progress: 0,
        });
        const checkStarted = Date.now();
        const checks = await runCommands(
          built.path,
          this.options.projectConfig.checks.commands,
          this.options.projectConfig.checks.timeoutSeconds,
          this.abort.signal,
        );
        this.checkDurationMs += Date.now() - checkStarted;
        await this.record("task.checked", { taskId: task.taskId, checks });
        const reviewBase =
          this.workspace.mode === "direct"
            ? this.workspace.expectedHead
            : `${await currentRevision(built.path)}^`;
        const diff = await diffForReview(
          built.path,
          reviewBase,
          this.workspace.mode === "direct",
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
          built.path,
          reviewerPrompt(task, built.contract, diff, JSON.stringify(checks)),
          workerOutputSchema,
        );
        await this.record("task.reviewed", {
          taskId: task.taskId,
          findings: reviewer.findings,
        });
        const blockers = blockingFindings(reviewer.findings);
        const failures = failedChecks(checks);
        if (blockers.length === 0 && failures.length === 0) break;
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
            commit: null,
            summary:
              "Blocking checks or review findings remain after the repair ceiling.",
            findings: reviewer.findings,
          });
          await this.retainFailedIsolatedTask(built, "repair rounds exhausted");
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
          built.path,
          repairPrompt(task, built.contract, blockers, failures, round),
          workerOutputSchema,
        );
        if (this.workspace.mode === "isolated")
          built.draftCommit = await amendCheckpoint(
            built.path,
            task.key,
            repair.summary,
          );
      }
      await this.emit({
        type: "progress",
        at: now(),
        phase: "integrating",
        message: `Integrating ${task.key}`,
        progress: 0,
      });
      let commit: string;
      if (this.workspace.mode === "direct") {
        const head = await currentRevision(built.path);
        if (head !== this.workspace.expectedHead)
          throw new Error(`direct branch HEAD drifted before checkpoint`);
        commit = await checkpoint(built.path, task.key, built.buildSummary);
        this.workspace.expectedHead = commit;
      } else {
        commit = await currentRevision(built.path);
        await integrateTask(this.workspace, commit);
      }
      await this.record("task.accepted", { taskId: task.taskId, commit });
      const findings = this.state.tasks[task.taskId]?.findings ?? [];
      await this.emit({
        type: "task.result",
        at: now(),
        taskId: task.taskId,
        status: "accepted",
        commit,
        summary: built.buildSummary,
        findings,
      });
      if (this.workspace.mode === "isolated")
        await removeTaskWorktree(this.workspace, built.path, built.branch);
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (this.workspace.mode === "isolated")
        await this.retainFailedIsolatedTask(built, reason).catch(
          async (preservationError) => {
            await this.record("warning", {
              message: `failed to preserve ${task.key}: ${String(preservationError)}`,
            });
          },
        );
      await this.record("task.failed", {
        taskId: task.taskId,
        reason,
      });
      await this.emit({
        type: "task.result",
        at: now(),
        taskId: task.taskId,
        status: "failed",
        commit: null,
        summary: reason,
        findings: [],
      });
      return false;
    }
  }

  private async retainFailedIsolatedTask(
    built: BuiltTask,
    reason: string,
  ): Promise<void> {
    if (this.workspace.mode !== "isolated") return;
    const commit = await normalizeWipCheckpoint(
      built.path,
      built.task.key,
      reason,
    );
    await integrateWip(this.workspace, commit, built.task.key, reason);
    await this.record("warning", {
      message: `${built.task.key} failed; WIP preserved on the output branch at ${commit}`,
    });
    await removeTaskWorktree(this.workspace, built.path, built.branch);
  }

  private async cleanupFailedBuildTask(
    task: RunnerTaskSnapshot,
    reason: string,
  ): Promise<void> {
    if (this.workspace.mode !== "isolated") return;
    const retained = this.state.tasks[task.taskId];
    if (!retained?.workspace || !retained.branch) return;
    const paths = await dirtyPaths(retained.workspace);
    const head = await currentRevision(retained.workspace);
    if (paths.length > 0 || head !== retained.workspaceBase) {
      const commit = await normalizeWipCheckpoint(
        retained.workspace,
        task.key,
        reason,
      );
      await integrateWip(this.workspace, commit, task.key, reason);
      await this.record("warning", {
        message: `${task.key} build failed; WIP preserved on the output branch at ${commit}`,
      });
    }
    await removeTaskWorktree(
      this.workspace,
      retained.workspace,
      retained.branch,
    );
  }

  private async terminalOutput(
    status: "succeeded" | "partial" | "failed" | "cancelled",
    started: number,
  ): Promise<RunnerJobOutput> {
    const headRevision = await currentRevision(this.workspace.path);
    const acceptedTaskCommits = Object.fromEntries(
      Object.values(this.state.tasks)
        .filter((task) => task.status === "accepted" && task.commit)
        .map((task) => [task.taskId, task.commit!]),
    );
    const checks = Object.values(this.state.tasks).flatMap(
      (task) => task.checks,
    );
    const findings = Object.values(this.state.tasks).flatMap(
      (task) => task.findings,
    );
    return {
      workspaceMode: this.workspace.mode,
      branch: this.workspace.branch,
      baseRevision: this.workspace.baseRevision,
      headRevision,
      acceptedTaskCommits,
      checks,
      findings,
      usage: this.state.usage,
      summary: `${status}: ${Object.keys(acceptedTaskCommits).length} task(s) accepted in ${Date.now() - started}ms (setup ${this.setupDurationMs}ms, checks ${this.checkDurationMs}ms).`,
      dirtyPaths: await dirtyPaths(this.workspace.path),
    };
  }

  private async execute(): Promise<RunnerJobOutput> {
    const started = Date.now();
    const jobDirectory = join(
      this.options.stateDirectory,
      "jobs",
      safeRefPart(this.options.assignment.jobId),
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
    if (!this.state.branch) {
      this.workspace = await prepareJobWorkspace({
        repository: this.options.repository,
        stateDirectory: this.options.stateDirectory,
        jobId: this.options.assignment.jobId,
        key: outputKey,
        kind: source.kind,
        expectedBaseRevision: this.options.assignment.expectedBaseRevision,
        config: this.options.projectConfig,
      });
      await this.record("workspace.ready", {
        branch: this.workspace.branch,
        path: this.workspace.path,
        baseRevision: this.workspace.baseRevision,
        expectedHead: this.workspace.expectedHead,
        mode: this.workspace.mode,
      });
    } else
      this.workspace = await restoreJobWorkspace({
        repository: this.options.repository,
        stateDirectory: this.options.stateDirectory,
        jobId: this.options.assignment.jobId,
        branch: this.state.branch,
        baseRevision: this.state.baseRevision!,
        expectedHead: this.state.expectedHead ?? this.state.baseRevision!,
        mode: this.options.projectConfig.workspace.mode,
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
        this.workspace.mode === "direct"
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
          await this.cleanupFailedBuildTask(task, reason).catch(
            async (preservationError) => {
              await this.record("warning", {
                message: `failed to clean up ${task.key}: ${String(preservationError)}`,
              });
            },
          );
          await this.record("task.failed", {
            taskId: task.taskId,
            reason,
          });
          await this.emit({
            type: "task.result",
            at: now(),
            taskId: task.taskId,
            status: "failed",
            commit: null,
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
            await this.cleanupFailedBuildTask(snapshot, message).catch(
              async (preservationError) => {
                await this.record("warning", {
                  message: `failed to clean up ${snapshot.key}: ${String(preservationError)}`,
                });
              },
            );
          await this.record("task.failed", {
            taskId: task.taskId,
            reason: message,
          });
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
        await releaseJobWorkspace(
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
  const path = join(stateDirectory, "jobs", safeRefPart(jobId), "events.jsonl");
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
