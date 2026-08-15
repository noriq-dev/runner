import type { MachineConfig } from "./config.js";
import { discoverProjects } from "./discovery.js";
import { createDriverRegistry } from "./drivers/registry.js";
import type { WorkspaceAccess } from "./drivers/types.js";
import { createBackendRegistry, selectBackend } from "./vcs/detect.js";

export interface RunnerDoctorReport {
  runnerId: string | null;
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
    access: WorkspaceAccess[];
    runnerControlVisible: boolean;
    projectTools: string[];
    warnings: string[];
    preflightChecks: number;
  }>;
}

interface DriverCheck {
  driver: string;
  version: string;
  authenticated: boolean;
  access: WorkspaceAccess;
  requireControlMcp: boolean;
  runnerControlVisible: boolean;
  projectTools: string[];
  warnings: string[];
}

export function aggregateDriverChecks(
  checks: DriverCheck[],
): RunnerDoctorReport["drivers"] {
  const reports = new Map<string, RunnerDoctorReport["drivers"][number]>();
  for (const check of checks) {
    const existing = reports.get(check.driver);
    if (!existing) {
      reports.set(check.driver, {
        driver: check.driver,
        version: check.version,
        authenticated: check.authenticated,
        access: [check.access],
        runnerControlVisible:
          !check.requireControlMcp || check.runnerControlVisible,
        projectTools: [...new Set(check.projectTools)].sort(),
        warnings: [...new Set(check.warnings)].sort(),
        preflightChecks: 1,
      });
      continue;
    }
    existing.authenticated &&= check.authenticated;
    if (!existing.access.includes(check.access)) {
      existing.access.push(check.access);
      existing.access.sort();
    }
    if (check.requireControlMcp)
      existing.runnerControlVisible &&= check.runnerControlVisible;
    existing.projectTools = [
      ...new Set([...existing.projectTools, ...check.projectTools]),
    ].sort();
    existing.warnings = [
      ...new Set([...existing.warnings, ...check.warnings]),
    ].sort();
    if (existing.version !== check.version) {
      existing.warnings = [
        ...new Set([
          ...existing.warnings,
          `inconsistent versions observed: ${existing.version}, ${check.version}`,
        ]),
      ].sort();
    }
    existing.preflightChecks += 1;
  }
  return [...reports.values()].sort((left, right) =>
    left.driver.localeCompare(right.driver),
  );
}

/** Run every read-only startup check without connecting to Noriq or spending model tokens. */
export async function doctorRunner(
  config: MachineConfig,
): Promise<RunnerDoctorReport> {
  const projects = await discoverProjects(config.runner.scanRoots);
  const backends = createBackendRegistry(config);
  const drivers = createDriverRegistry(config);
  const repositories: RunnerDoctorReport["repositories"] = [];
  const driverChecks: DriverCheck[] = [];
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
    for (const role of ["guide", "builder", "reviewer", "repairer"] as const) {
      for (const profile of Object.values(project.config.agents[role])) {
        const driver = drivers[profile.driver];
        if (!driver)
          throw new Error(
            `project ${project.config.repositoryKey} selects unknown ${role} driver ${profile.driver}`,
          );
        const access: WorkspaceAccess =
          role === "builder" || role === "repairer"
            ? "workspace-write"
            : "read-only";
        const requireControlMcp = role === "guide";
        const key = `${project.repository}:${driver.id}:${access}:${requireControlMcp}`;
        if (checked.has(key)) continue;
        checked.add(key);
        const result = await driver.preflight({
          workspace: project.repository,
          access,
          requireControlMcp,
        });
        driverChecks.push({
          driver: result.driver,
          version: result.version,
          authenticated: result.authenticated,
          access,
          requireControlMcp,
          runnerControlVisible: result.runnerControlVisible,
          projectTools: result.projectTools,
          warnings: result.warnings,
        });
      }
    }
  }
  return {
    runnerId: config.runner.id ?? null,
    serverUrl: config.runner.serverUrl,
    stateDirectory: config.runner.stateDirectory,
    repositories,
    drivers: aggregateDriverChecks(driverChecks),
  };
}
