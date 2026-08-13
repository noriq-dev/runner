import type { MachineConfig } from "./config.js";
import type { JobAssignment } from "./contracts.js";
import { discoverProjects } from "./discovery.js";
import { revisionOf } from "./git.js";
import { CliProviderAdapter } from "./providers/process-adapter.js";
import type { ProviderAdapter } from "./providers/types.js";
import { loadDurableJobState, RunnerJobSupervisor } from "./supervisor.js";
import { RunnerSocket } from "./ws-client.js";

export async function runDaemon(config: MachineConfig): Promise<never> {
  const projects = await discoverProjects(config.runner.scanRoots);
  const repositories = await Promise.all(
    projects.map(async (project) => ({
      repositoryKey: project.config.repositoryKey,
      repoRef: project.config.repositoryKey,
      baseRevision: await revisionOf(
        project.repository,
        project.config.workspace.baseBranch,
      ),
    })),
  );
  const byRef = new Map(
    projects.map((project) => [project.config.repositoryKey, project]),
  );
  const server = new URL(config.runner.serverUrl);
  server.protocol = server.protocol === "https:" ? "wss:" : "ws:";
  server.pathname = `/ws/runner/${encodeURIComponent(config.runner.id)}`;
  const socket = new RunnerSocket(server.toString(), config.runner.token, {
    type: "hello",
    protocolVersion: 2,
    runnerId: config.runner.id,
    capacity: config.runner.maxConcurrentJobs,
    repositories,
  });
  const providers: Record<
    "codex" | "claude" | "fake",
    ProviderAdapter | undefined
  > = {
    codex: config.providers.codex
      ? new CliProviderAdapter(
          "codex",
          config.providers.codex,
          config.runner.stateDirectory,
        )
      : undefined,
    claude: config.providers.claude
      ? new CliProviderAdapter(
          "claude",
          config.providers.claude,
          config.runner.stateDirectory,
        )
      : undefined,
    fake: undefined,
  };
  const active = new Map<
    string,
    { assignmentId: string; supervisor: RunnerJobSupervisor }
  >();
  const reconciling = new Map<string, JobAssignment>();
  socket.getHeartbeat = () => ({
    freeSlots: Math.max(0, config.runner.maxConcurrentJobs - active.size),
    activeJobIds: [...active.keys()],
  });
  const start = (assignment: JobAssignment) => {
    if (active.has(assignment.jobId)) return;
    if (active.size >= config.runner.maxConcurrentJobs)
      throw new Error("Runner received an assignment beyond its capacity");
    const project = byRef.get(assignment.repoRef);
    if (!project)
      throw new Error(`no discovered repository for ${assignment.repoRef}`);
    socket.send({
      type: "job.accept",
      jobId: assignment.jobId,
      assignmentId: assignment.assignmentId,
    });
    const supervisor = new RunnerJobSupervisor({
      assignment,
      repository: project.repository,
      stateDirectory: config.runner.stateDirectory,
      projectConfig: project.config,
      providers,
      sink: socket,
    });
    active.set(assignment.jobId, {
      assignmentId: assignment.assignmentId,
      supervisor,
    });
    void supervisor.run().then(
      () => active.delete(assignment.jobId),
      (error) => {
        process.stderr.write(
          `RunnerJob ${assignment.jobId} crashed before terminalization: ${String(error)}\n`,
        );
        active.delete(assignment.jobId);
      },
    );
  };
  socket.onMessage = (message) => {
    void (async () => {
      if (message.type === "job.assign") {
        const running = active.get(message.assignment.jobId);
        const durable = await loadDurableJobState(
          config.runner.stateDirectory,
          message.assignment.jobId,
        );
        if (running || durable?.assignment) {
          if (
            (running?.assignmentId ?? durable?.assignment?.assignmentId) !==
            message.assignment.assignmentId
          )
            throw new Error(
              `stale assignment received for ${message.assignment.jobId}`,
            );
          reconciling.set(message.assignment.jobId, message.assignment);
          socket.send({
            type: "job.reconcile",
            jobId: message.assignment.jobId,
            assignmentId: message.assignment.assignmentId,
            lastLocalSeq: durable?.nextEventSeq ? durable.nextEventSeq - 1 : 0,
          });
        } else start(message.assignment);
      } else if (message.type === "job.reconcile.result") {
        const assignment = reconciling.get(message.jobId);
        reconciling.delete(message.jobId);
        if (!assignment || assignment.assignmentId !== message.assignmentId)
          return;
        if (message.action === "cancel") {
          active.get(message.jobId)?.supervisor.cancel();
          return;
        }
        if (!active.has(message.jobId)) start(assignment);
      } else if (message.type === "job.cancel") {
        const running = active.get(message.jobId);
        if (running?.assignmentId === message.assignmentId)
          running.supervisor.cancel();
        reconciling.delete(message.jobId);
      } else if (message.type === "job.answer") {
        const running = active.get(message.jobId);
        if (running?.assignmentId === message.assignmentId)
          await running.supervisor.answer(message.questionId, message.answer);
      }
    })().catch((error) => {
      process.stderr.write(`Runner protocol error: ${String(error)}\n`);
    });
  };
  for (;;) {
    try {
      await socket.connect();
    } catch (error) {
      process.stderr.write(`Runner connection failed: ${String(error)}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}
