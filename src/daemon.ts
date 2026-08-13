import type { MachineConfig } from "./config.js";
import type { JobAssignment } from "./contracts.js";
import { discoverProjects } from "./discovery.js";
import { createDriverRegistry } from "./drivers/registry.js";
import type { ServerToRunner } from "./protocol.js";
import { registerRunner } from "./registration.js";
import {
  acknowledgeDurableLanding,
  landDurableJob,
  loadDurableJobState,
  loadPendingLandingResults,
  RunnerJobSupervisor,
} from "./supervisor.js";
import { createBackendRegistry, selectBackend } from "./vcs/detect.js";
import { RunnerSocket } from "./ws-client.js";

export async function runDaemon(config: MachineConfig): Promise<never> {
  const projects = await discoverProjects(config.runner.scanRoots);
  const backendRegistry = createBackendRegistry(config);
  const available = projects.map((project) => ({
    ...project,
    backend: selectBackend(backendRegistry, project.config, project.vcs),
  }));
  const repositories = await Promise.all(
    available.map(async (project) => ({
      repositoryKey: project.config.repositoryKey,
      repoRef: project.config.repositoryKey,
      vcs: project.backend.kind,
      baseRevision: await project.backend.revisionOf(
        project.repository,
        project.config.sourceControl.base,
      ),
    })),
  );
  const byRef = new Map(
    available.map((project) => [project.config.repositoryKey, project]),
  );
  const registration = await registerRunner(config, projects);
  process.stdout.write(
    `Registered Runner ${registration.id} with ${registration.repos.length} repositories\n`,
  );
  const server = new URL(config.runner.serverUrl);
  server.protocol = server.protocol === "https:" ? "wss:" : "ws:";
  server.pathname = `/ws/runner/${encodeURIComponent(registration.id)}`;
  const socket = new RunnerSocket(server.toString(), config.runner.token, {
    type: "hello",
    protocolVersion: 2,
    runnerId: registration.id,
    capacity: config.runner.maxConcurrentJobs,
    repositories,
  });
  const drivers = createDriverRegistry(config);
  const active = new Map<
    string,
    {
      assignmentId: string;
      repositoryKey: string;
      exclusive: boolean;
      supervisor: RunnerJobSupervisor;
    }
  >();
  const queued = new Map<string, JobAssignment>();
  const reconciling = new Map<string, JobAssignment>();
  type LandingMessage = Extract<ServerToRunner, { type: "job.land" }>;
  const queuedLandings = new Map<
    string,
    {
      message: LandingMessage;
      project: (typeof available)[number];
    }
  >();
  const activeLandings = new Map<string, string>();
  socket.getHeartbeat = () => ({
    freeSlots: Math.max(
      0,
      config.runner.maxConcurrentJobs - active.size - queued.size,
    ),
    activeJobIds: [...active.keys(), ...queued.keys()],
  });
  const canStart = (assignment: JobAssignment): boolean => {
    if (active.size >= config.runner.maxConcurrentJobs) return false;
    const project = byRef.get(assignment.repoRef);
    if (!project) return false;
    if (activeLandings.has(project.config.repositoryKey)) return false;
    const exclusive =
      project.config.sourceControl.mode === "direct" ||
      !project.backend.capabilities.parallelTaskWorkspaces;
    return ![...active.values()].some(
      (running) =>
        running.repositoryKey === project.config.repositoryKey &&
        (exclusive || running.exclusive),
    );
  };
  let drain = (): void => {};
  const startLanding = (entry: {
    message: LandingMessage;
    project: (typeof available)[number];
  }) => {
    const { message, project } = entry;
    queuedLandings.delete(message.requestId);
    activeLandings.set(project.config.repositoryKey, message.requestId);
    void landDurableJob({
      stateDirectory: config.runner.stateDirectory,
      repository: project.repository,
      projectConfig: project.config,
      backend: project.backend,
      jobId: message.jobId,
      assignmentId: message.assignmentId,
      requestId: message.requestId,
      target: message.target,
    })
      .then((result) => {
        socket.send({
          type: "job.land.result",
          jobId: message.jobId,
          assignmentId: message.assignmentId,
          requestId: message.requestId,
          ...result,
        });
      })
      .catch((error) => {
        process.stderr.write(
          `RunnerJob ${message.jobId} landing crashed: ${String(error)}\n`,
        );
      })
      .finally(() => {
        activeLandings.delete(project.config.repositoryKey);
        drain();
      });
  };
  const start = (assignment: JobAssignment) => {
    if (active.has(assignment.jobId)) return;
    if (active.size >= config.runner.maxConcurrentJobs)
      throw new Error("Runner received an assignment beyond its capacity");
    const project = byRef.get(assignment.repoRef);
    if (!project)
      throw new Error(`no discovered repository for ${assignment.repoRef}`);
    queued.delete(assignment.jobId);
    const exclusive =
      project.config.sourceControl.mode === "direct" ||
      !project.backend.capabilities.parallelTaskWorkspaces;
    const supervisor = new RunnerJobSupervisor({
      assignment,
      repository: project.repository,
      stateDirectory: config.runner.stateDirectory,
      projectConfig: project.config,
      backend: project.backend,
      drivers,
      sink: socket,
    });
    active.set(assignment.jobId, {
      assignmentId: assignment.assignmentId,
      repositoryKey: project.config.repositoryKey,
      exclusive,
      supervisor,
    });
    void supervisor.run().then(
      () => {
        active.delete(assignment.jobId);
        drain();
      },
      (error) => {
        process.stderr.write(
          `RunnerJob ${assignment.jobId} crashed before terminalization: ${String(error)}\n`,
        );
        active.delete(assignment.jobId);
        drain();
      },
    );
  };
  drain = () => {
    for (const entry of queuedLandings.values()) {
      const key = entry.project.config.repositoryKey;
      if (activeLandings.has(key)) continue;
      if ([...active.values()].some((running) => running.repositoryKey === key))
        continue;
      startLanding(entry);
    }
    for (const assignment of queued.values()) {
      if (canStart(assignment)) start(assignment);
    }
  };
  const admit = (assignment: JobAssignment, acknowledge: boolean): void => {
    if (active.has(assignment.jobId) || queued.has(assignment.jobId)) return;
    if (active.size + queued.size >= config.runner.maxConcurrentJobs)
      throw new Error("Runner received an assignment beyond its capacity");
    if (!byRef.has(assignment.repoRef))
      throw new Error(`no discovered repository for ${assignment.repoRef}`);
    if (acknowledge)
      socket.send({
        type: "job.accept",
        jobId: assignment.jobId,
        assignmentId: assignment.assignmentId,
      });
    queued.set(assignment.jobId, assignment);
    drain();
  };
  socket.onConnect = async () => {
    for (const pending of await loadPendingLandingResults(
      config.runner.stateDirectory,
    )) {
      socket.send({
        type: "job.land.result",
        jobId: pending.jobId,
        assignmentId: pending.assignmentId,
        requestId: pending.requestId,
        status: pending.status,
        target: pending.target,
        checkpoint: pending.checkpoint,
        error: pending.error,
      });
    }
  };
  socket.onMessage = (message) => {
    void (async () => {
      if (message.type === "job.assign") {
        const running = active.get(message.assignment.jobId);
        const waiting = queued.get(message.assignment.jobId);
        const durable = await loadDurableJobState(
          config.runner.stateDirectory,
          message.assignment.jobId,
        );
        if (running || waiting || durable?.assignment) {
          if (
            (running?.assignmentId ??
              waiting?.assignmentId ??
              durable?.assignment?.assignmentId) !==
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
        } else admit(message.assignment, true);
      } else if (message.type === "job.reconcile.result") {
        const assignment = reconciling.get(message.jobId);
        reconciling.delete(message.jobId);
        if (!assignment || assignment.assignmentId !== message.assignmentId)
          return;
        if (message.action === "cancel") {
          active.get(message.jobId)?.supervisor.cancel();
          return;
        }
        if (!active.has(message.jobId)) admit(assignment, false);
      } else if (message.type === "job.cancel") {
        let running = active.get(message.jobId);
        if (!running && !queued.has(message.jobId)) {
          const durable = await loadDurableJobState(
            config.runner.stateDirectory,
            message.jobId,
          );
          if (durable?.assignment?.assignmentId === message.assignmentId) {
            admit(durable.assignment, false);
            running = active.get(message.jobId);
          }
        }
        if (running?.assignmentId === message.assignmentId)
          running.supervisor.cancel();
        if (queued.get(message.jobId)?.assignmentId === message.assignmentId)
          queued.delete(message.jobId);
        reconciling.delete(message.jobId);
      } else if (message.type === "job.answer") {
        const running = active.get(message.jobId);
        if (running?.assignmentId === message.assignmentId)
          await running.supervisor.answer(message.questionId, message.answer);
      } else if (message.type === "job.land") {
        const durable = await loadDurableJobState(
          config.runner.stateDirectory,
          message.jobId,
        );
        if (durable?.assignment?.assignmentId !== message.assignmentId)
          throw new Error(
            `landing request does not match durable job ${message.jobId}`,
          );
        const project = byRef.get(durable.assignment.repoRef);
        if (!project)
          throw new Error(
            `no discovered repository for ${durable.assignment.repoRef}`,
          );
        if (
          !queuedLandings.has(message.requestId) &&
          ![...activeLandings.values()].includes(message.requestId)
        ) {
          queuedLandings.set(message.requestId, { message, project });
          drain();
        }
      } else if (message.type === "job.land.ack") {
        await acknowledgeDurableLanding(
          config.runner.stateDirectory,
          message.jobId,
          message.requestId,
        );
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
