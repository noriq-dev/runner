import type { MachineConfig } from "./config.js";
import { discoverProjects } from "./discovery.js";
import { createDriverRegistry } from "./drivers/registry.js";
import type { WorkspaceAccess } from "./drivers/types.js";
import { createBackendRegistry, selectBackend } from "./vcs/detect.js";

export interface RunnerDoctorReport {
  runnerId: string;
  serverUrl: string;
  stateDirectory: string;
  repositories: Array<{
    repositoryKey: string;
    repository: string;
    backend: string;
    base: string;
    baseRevision: string;
  }>;
  drivers: Array<{
    driver: string;
    version: string;
    authenticated: boolean;
    access: WorkspaceAccess;
    runnerControlVisible: boolean;
    projectTools: string[];
    warnings: string[];
  }>;
}

/** Run every read-only startup check without connecting to Noriq or spending model tokens. */
export async function doctorRunner(
  config: MachineConfig,
): Promise<RunnerDoctorReport> {
  const projects = await discoverProjects(config.runner.scanRoots);
  const backends = createBackendRegistry(config);
  const drivers = createDriverRegistry(config);
  const repositories: RunnerDoctorReport["repositories"] = [];
  const driverReports: RunnerDoctorReport["drivers"] = [];
  const checked = new Set<string>();

  for (const project of projects) {
    const backend = selectBackend(backends, project.config, project.vcs);
    repositories.push({
      repositoryKey: project.config.repositoryKey,
      repository: project.repository,
      backend: backend.id,
      base: project.config.sourceControl.base,
      baseRevision: await backend.revisionOf(
        project.repository,
        project.config.sourceControl.base,
      ),
    });
    for (const role of ["guide", "builder", "reviewer"] as const) {
      const profile = project.config.agents[role];
      const driver = drivers[profile.driver];
      if (!driver)
        throw new Error(
          `project ${project.config.repositoryKey} selects unknown ${role} driver ${profile.driver}`,
        );
      const access: WorkspaceAccess =
        role === "builder" ? "workspace-write" : "read-only";
      const requireControlMcp = role === "guide";
      const key = `${project.repository}:${driver.id}:${access}:${requireControlMcp}`;
      if (checked.has(key)) continue;
      checked.add(key);
      const result = await driver.preflight({
        workspace: project.repository,
        access,
        requireControlMcp,
      });
      driverReports.push({
        driver: result.driver,
        version: result.version,
        authenticated: result.authenticated,
        access,
        runnerControlVisible: result.runnerControlVisible,
        projectTools: result.projectTools,
        warnings: result.warnings,
      });
    }
  }
  return {
    runnerId: config.runner.id,
    serverUrl: config.runner.serverUrl,
    stateDirectory: config.runner.stateDirectory,
    repositories,
    drivers: driverReports,
  };
}
