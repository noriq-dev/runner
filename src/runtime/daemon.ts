import { createHash } from "node:crypto";
import {
  type RunnerCatalog,
  type RunnerJobRuntimeRepository,
  runnerCatalogCanonicalJson,
} from "@noriq-dev/shared";
import { createTokenProvider } from "../auth/token-provider.js";
import type { MachineConfig } from "../config.js";
import type { JobAssignment } from "../contracts.js";
import { NoriqCoordinationProvider } from "../coordination/noriq-provider.js";
import { createDriverRegistry } from "../drivers/registry.js";
import { NoriqMemoryContextProvider } from "../memory/context/provider.js";
import { NoriqIndexClient } from "../memory/index/client.js";
import { RepositoryIndexService } from "../memory/index/service.js";
import { NoriqHttpClient } from "../noriq/http.js";
import { OpenAiPricingProvider, type PricingProvider } from "../pricing.js";
import type { ServerToRunner } from "../protocol.js";
import { registerRunner } from "../registration.js";
import { RepositoryCatalogService } from "../repositories/catalog.js";
import type {
  CatalogSnapshot,
  RepositoryCheckout,
} from "../repositories/types.js";
import {
  acknowledgeDurableLanding,
  landDurableJob,
  loadDurableJobState,
  loadPendingLandingResults,
  RunnerJobSupervisor,
} from "../supervisor.js";
import { createBackendRegistry, selectBackend } from "../vcs/detect.js";
import type { SourceControlBackend } from "../vcs/types.js";
import { RunnerSocket } from "../ws-client.js";

type AvailableProject = RepositoryCheckout & { backend: SourceControlBackend };

export async function runtimeCatalog(
  snapshot: CatalogSnapshot,
  backends: Record<string, SourceControlBackend>,
): Promise<{
  projects: AvailableProject[];
  repositories: RunnerJobRuntimeRepository[];
  catalog: RunnerCatalog;
}> {
  const projects = snapshot.checkouts.map((project) => ({
    ...project,
    backend: selectBackend(backends, project.config, project.vcs),
  }));
  const repositories = await Promise.all(
    projects.map(async (project) => ({
      repositoryKey: project.config.repositoryKey,
      repoRef: project.checkoutId,
      vcs: project.backend.kind,
      baseRevision: await project.backend.revisionOf(
        project.repository,
        project.config.sourceControl.base,
      ),
    })),
  );
  const digest = createHash("sha256")
    .update(runnerCatalogCanonicalJson(repositories))
    .digest("hex");
  return {
    projects,
    repositories,
    catalog: { generation: snapshot.generation, digest, repositories },
  };
}

export async function runDaemon(config: MachineConfig): Promise<never> {
  if (config.runner.tokenSource !== "oauth")
    process.stderr.write(
      `Warning: static ${config.runner.tokenSource} credentials suppress Noriq OAuth rotation.\n`,
    );
  const tokens = createTokenProvider(config);
  const initialToken = await tokens.get();
  const catalog = new RepositoryCatalogService({
    scanRoots: config.runner.scanRoots,
    maxDepth: config.discovery.maxDepth,
    intervalSeconds: config.discovery.intervalSeconds,
  });
  const catalogSnapshot = await catalog.refresh();
  const backendRegistry = createBackendRegistry(config);
  const initialCatalog = await runtimeCatalog(catalogSnapshot, backendRegistry);
  let available = initialCatalog.projects;
  let repositories = initialCatalog.repositories;
  let byRef = new Map(
    available.map((project) => [project.checkoutId, project]),
  );
  let registration = await registerRunner(
    config,
    catalogSnapshot.checkouts,
    initialToken,
  );
  initialCatalog.catalog.generation = Math.max(
    initialCatalog.catalog.generation,
    (registration.capabilities?.catalogGeneration ?? 0) + 1,
  );
  const noriq = new NoriqHttpClient(config.runner.serverUrl, tokens);
  const coordination = new NoriqCoordinationProvider(noriq);
  const memoryContext = new NoriqMemoryContextProvider(noriq, registration.id);
  const indexService = new RepositoryIndexService(
    config,
    registration.id,
    new NoriqIndexClient(noriq),
  );
  let indexTargets = available.flatMap((project) => {
    const registered = registration.repos.find(
      (repository) => repository.id === project.checkoutId,
    );
    return registered?.projectId
      ? [
          {
            checkout: project,
            projectId: registered.projectId,
            backend: project.backend,
          },
        ]
      : [];
  });
  let indexStarted = false;
  process.stdout.write(
    `Registered Runner ${registration.id} with ${registration.repos.length} repositories\n`,
  );
  const server = new URL(config.runner.serverUrl);
  server.protocol = server.protocol === "https:" ? "wss:" : "ws:";
  server.pathname = `/ws/runner/${encodeURIComponent(registration.id)}`;
  const socket = new RunnerSocket(
    server.toString(),
    tokens,
    {
      type: "hello",
      protocolVersion: 2,
      runnerId: registration.id,
      capacity: config.runner.maxConcurrentJobs,
      repositories,
    },
    5_000,
    initialToken.generation,
  );
  let pendingRuntime = initialCatalog;
  let runtimeGeneration = initialCatalog.catalog.generation;
  let runtimeConfigDigest = catalogSnapshot.digest;
  let catalogReady = false;
  let dispatchableRepoRefs = new Set<string>();
  const catalogAcknowledgements = new Map<
    number,
    {
      resolve: (
        message: Extract<ServerToRunner, { type: "catalog.ack" }>,
      ) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  const indexTargetsFor = (projects: AvailableProject[]) =>
    projects.flatMap((project) => {
      const registered = registration.repos.find(
        (repository) => repository.id === project.checkoutId,
      );
      return registered?.projectId
        ? [
            {
              checkout: project,
              projectId: registered.projectId,
              backend: project.backend,
            },
          ]
        : [];
    });
  const publishCatalog = async (candidate: typeof pendingRuntime) => {
    catalogReady = false;
    const acknowledgement = new Promise<
      Extract<ServerToRunner, { type: "catalog.ack" }>
    >((resolve, reject) => {
      const previous = catalogAcknowledgements.get(
        candidate.catalog.generation,
      );
      if (previous) {
        clearTimeout(previous.timer);
        previous.reject(new Error("catalog publication was superseded"));
      }
      const waiter = {
        resolve,
        reject,
        timer: undefined as unknown as NodeJS.Timeout,
      };
      const timer = setTimeout(() => {
        if (
          catalogAcknowledgements.get(candidate.catalog.generation) === waiter
        )
          catalogAcknowledgements.delete(candidate.catalog.generation);
        reject(new Error("timed out waiting for catalog acknowledgement"));
      }, 15_000);
      timer.unref();
      waiter.timer = timer;
      catalogAcknowledgements.set(candidate.catalog.generation, waiter);
    });
    socket.send({ type: "catalog.update", catalog: candidate.catalog });
    const ack = await acknowledgement;
    if (!ack.accepted || ack.digest !== candidate.catalog.digest)
      throw new Error(ack.error ?? "Control Plane rejected the Runner catalog");
    dispatchableRepoRefs = new Set(ack.dispatchableRepoRefs);
    available = candidate.projects;
    repositories = candidate.repositories;
    byRef = new Map(available.map((project) => [project.checkoutId, project]));
    indexTargets = indexTargetsFor(available);
    if (indexStarted) indexService.updateTargets(indexTargets);
    catalogReady = true;
    process.stdout.write(
      `Acknowledged catalog generation ${ack.generation} (${dispatchableRepoRefs.size}/${candidate.repositories.length} repositories dispatchable)\n`,
    );
  };
  socket.onTokenGeneration = async (token) => {
    registration = await registerRunner(
      config,
      catalog.snapshot().checkouts,
      token,
    );
    indexTargets = indexTargetsFor(available);
    if (indexStarted) indexService.updateTargets(indexTargets);
  };
  let authenticationReady = true;
  socket.onAuthenticationRequired = () => {
    if (authenticationReady)
      process.stderr.write(
        "Runner authentication requires attention; draining until `noriq-runner auth noriq` replaces the credentials.\n",
      );
    authenticationReady = false;
  };
  socket.onDisconnect = (code, reason) => {
    catalogReady = false;
    for (const pending of catalogAcknowledgements.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error(`connection closed before catalog acknowledgement (${code})`),
      );
    }
    catalogAcknowledgements.clear();
    process.stderr.write(
      `Runner connection closed (${code}): ${reason || "no reason"}\n`,
    );
  };
  catalog.onScan = async (snapshot) => {
    const candidate = await runtimeCatalog(snapshot, backendRegistry);
    const configurationChanged = snapshot.digest !== runtimeConfigDigest;
    const runtimeChanged =
      candidate.catalog.digest !== pendingRuntime.catalog.digest;
    if (!configurationChanged && !runtimeChanged) return;
    runtimeGeneration += 1;
    candidate.catalog.generation = runtimeGeneration;
    pendingRuntime = candidate;
    registration = await registerRunner(
      config,
      snapshot.checkouts,
      await tokens.get(),
    );
    runtimeConfigDigest = snapshot.digest;
    if (socket.connected()) await publishCatalog(candidate);
  };
  catalog.onError = (error) => {
    process.stderr.write(
      `Repository catalog refresh failed: ${String(error)}\n`,
    );
  };
  const drivers = createDriverRegistry(config);
  const pricingProviders: Record<string, PricingProvider | undefined> = {
    openai: new OpenAiPricingProvider({
      stateDirectory: config.runner.stateDirectory,
      enabled: config.pricing.openai.enabled,
      maxStaleHours: config.pricing.openai.maxStaleHours,
    }),
  };
  const openAiModels = new Set<string>();
  for (const project of available)
    for (const roles of Object.values(project.config.agents))
      for (const profile of Object.values(roles)) {
        const driver = drivers[profile.driver];
        if (driver?.vendor === "openai") openAiModels.add(profile.model);
      }
  void Promise.allSettled(
    [...openAiModels].map((model) => pricingProviders.openai!.quote(model)),
  ).then((results) => {
    for (const result of results)
      if (result.status === "fulfilled" && result.value.warning)
        process.stderr.write(`${result.value.warning}\n`);
  });
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
  const queuedContexts = new Map<
    string,
    { project: AvailableProject; projectId: string }
  >();
  const reconciling = new Map<string, JobAssignment>();
  type LandingMessage = Extract<ServerToRunner, { type: "job.land" }>;
  const queuedLandings = new Map<
    string,
    {
      message: LandingMessage;
      project: (typeof available)[number];
      projectId: string;
    }
  >();
  const activeLandings = new Map<string, string>();
  socket.getHeartbeat = () => ({
    freeSlots:
      authenticationReady && catalogReady
        ? Math.max(
            0,
            config.runner.maxConcurrentJobs - active.size - queued.size,
          )
        : 0,
    activeJobIds: [...active.keys(), ...queued.keys()],
  });
  const canStart = (assignment: JobAssignment): boolean => {
    if (active.size >= config.runner.maxConcurrentJobs) return false;
    const project =
      queuedContexts.get(assignment.jobId)?.project ??
      byRef.get(assignment.repoRef);
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
    projectId: string;
  }) => {
    const { message, project, projectId } = entry;
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
      sink: socket,
      coordination: {
        provider: coordination,
        runnerId: registration.id,
        checkoutId: project.checkoutId,
        projectId,
      },
    })
      .then((result) => {
        socket.send({
          type: "job.land.result",
          jobId: message.jobId,
          assignmentId: message.assignmentId,
          requestId: message.requestId,
          ...result,
        });
        const registered = registration.repos.find(
          (repository) => repository.id === project.checkoutId,
        );
        if (result.status === "landed" && registered?.projectId)
          indexService.trigger(
            {
              checkout: project,
              projectId: registered.projectId,
              backend: project.backend,
            },
            true,
          );
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
    const context = queuedContexts.get(assignment.jobId);
    const project = context?.project ?? byRef.get(assignment.repoRef);
    if (!project)
      throw new Error(`no discovered repository for ${assignment.repoRef}`);
    const projectId =
      context?.projectId ??
      registration.repos.find(
        (repository) => repository.id === project.checkoutId,
      )?.projectId;
    if (!projectId)
      throw new Error(
        `checkout ${project.checkoutId} is not associated with a Noriq project`,
      );
    queued.delete(assignment.jobId);
    queuedContexts.delete(assignment.jobId);
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
      pricingProviders,
      memoryContext,
      coordination: {
        provider: coordination,
        runnerId: registration.id,
        checkoutId: project.checkoutId,
        projectId,
      },
      onRepositoryChanged: () => {
        const target = indexTargets.find(
          (candidate) => candidate.checkout.checkoutId === project.checkoutId,
        );
        if (target) indexService.trigger(target, true);
      },
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
  const admit = async (
    assignment: JobAssignment,
    acknowledge: boolean,
  ): Promise<void> => {
    if (!authenticationReady)
      throw new Error("Runner is draining because authentication is required");
    if (!catalogReady || !dispatchableRepoRefs.has(assignment.repoRef))
      throw new Error(
        `Runner is draining because checkout ${assignment.repoRef} is not in the acknowledged catalog`,
      );
    if (active.has(assignment.jobId) || queued.has(assignment.jobId)) return;
    if (active.size + queued.size >= config.runner.maxConcurrentJobs)
      throw new Error("Runner received an assignment beyond its capacity");
    const project = byRef.get(assignment.repoRef);
    if (!project)
      throw new Error(`no discovered repository for ${assignment.repoRef}`);
    const reloaded = await catalog.admit(assignment.repoRef);
    if (reloaded.configDigest !== project.configDigest)
      throw new Error(
        `repository ${assignment.repoRef} configuration changed before admission`,
      );
    const registered = registration.repos.find(
      (repository) => repository.id === project.checkoutId,
    );
    if (!registered?.projectId)
      throw new Error(
        `checkout ${project.checkoutId} is not associated with a Noriq project`,
      );
    if (registered.projectId !== assignment.source.projectId)
      throw new Error(
        `assignment project ${assignment.source.projectId} does not match checkout association ${registered.projectId}`,
      );
    if (acknowledge)
      socket.send({
        type: "job.accept",
        jobId: assignment.jobId,
        assignmentId: assignment.assignmentId,
      });
    queued.set(assignment.jobId, assignment);
    queuedContexts.set(assignment.jobId, {
      project,
      projectId: registered.projectId,
    });
    drain();
  };
  socket.onConnect = async () => {
    authenticationReady = true;
    await publishCatalog(pendingRuntime);
    catalog.start();
    if (!indexStarted) {
      indexStarted = true;
      indexService.start(indexTargets);
    }
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
      if (message.type === "catalog.ack") {
        const pending = catalogAcknowledgements.get(message.generation);
        if (!pending) return;
        catalogAcknowledgements.delete(message.generation);
        clearTimeout(pending.timer);
        pending.resolve(message);
      } else if (message.type === "job.assign") {
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
        } else await admit(message.assignment, true);
      } else if (message.type === "job.reconcile.result") {
        const assignment = reconciling.get(message.jobId);
        reconciling.delete(message.jobId);
        if (!assignment || assignment.assignmentId !== message.assignmentId)
          return;
        if (message.action === "cancel") {
          active.get(message.jobId)?.supervisor.cancel();
          queued.delete(message.jobId);
          queuedContexts.delete(message.jobId);
          return;
        }
        if (!active.has(message.jobId)) await admit(assignment, false);
      } else if (message.type === "job.cancel") {
        let running = active.get(message.jobId);
        if (!running && !queued.has(message.jobId)) {
          const durable = await loadDurableJobState(
            config.runner.stateDirectory,
            message.jobId,
          );
          if (durable?.assignment?.assignmentId === message.assignmentId) {
            await admit(durable.assignment, false);
            running = active.get(message.jobId);
          }
        }
        if (running?.assignmentId === message.assignmentId)
          running.supervisor.cancel();
        if (queued.get(message.jobId)?.assignmentId === message.assignmentId) {
          queued.delete(message.jobId);
          queuedContexts.delete(message.jobId);
        }
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
          queuedLandings.set(message.requestId, {
            message,
            project,
            projectId: durable.assignment.source.projectId,
          });
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
  let reconnectDelayMs = 2_000;
  for (;;) {
    try {
      await socket.connect();
      reconnectDelayMs = 2_000;
    } catch (error) {
      process.stderr.write(`Runner connection failed: ${String(error)}\n`);
      reconnectDelayMs = Math.min(30_000, reconnectDelayMs * 2);
    }
    await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs));
  }
}
