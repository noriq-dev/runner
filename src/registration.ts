import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { RUNNER_JOB_CAPABILITY } from "@noriq-dev/shared";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };
import type { MachineConfig } from "./config.js";
import type { DiscoveredProject } from "./discovery.js";

const registeredRepositorySchema = z
  .object({
    id: z.string(),
    projectKey: z.string(),
    projectId: z.string().nullable(),
    repositoryKey: z.string().nullable(),
  })
  .passthrough();

const registrationResponseSchema = z.object({
  runner: z
    .object({
      id: z.string().min(1),
      status: z.string(),
      repos: z.array(registeredRepositorySchema),
    })
    .passthrough(),
});

const registrationStateSchema = z.object({ runnerId: z.string().min(1) });

export type RegisteredRunner = z.infer<
  typeof registrationResponseSchema
>["runner"];

async function persistedRunnerId(
  stateDirectory: string,
): Promise<string | undefined> {
  try {
    const raw = await readFile(join(stateDirectory, "runner.json"), "utf8");
    return registrationStateSchema.parse(JSON.parse(raw)).runnerId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function persistRunnerId(
  stateDirectory: string,
  runnerId: string,
): Promise<void> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const path = join(stateDirectory, "runner.json");
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify({ runnerId })}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

export async function registerRunner(
  config: MachineConfig,
  projects: DiscoveredProject[],
  fetchImpl: typeof fetch = fetch,
): Promise<RegisteredRunner> {
  const runnerId =
    config.runner.id ?? (await persistedRunnerId(config.runner.stateDirectory));
  const response = await fetchImpl(
    new URL("/api/runners", config.runner.serverUrl),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.runner.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...(runnerId ? { runnerId } : {}),
        label: config.runner.label,
        version: packageJson.version,
        tools: [],
        agents: [],
        kinds: [],
        maxConcurrency: config.runner.maxConcurrentJobs,
        repos: projects.map((project) => ({
          id: project.config.repositoryKey,
          projectKey: project.config.key,
          repositoryKey: project.config.repositoryKey,
          name: basename(project.repository),
          defaultBranch: project.config.defaultBranch,
          workflows: [],
          executionProfiles: [],
        })),
        protocolCapabilities: [RUNNER_JOB_CAPABILITY],
      }),
    },
  );
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `Runner registration failed (${response.status}): ${text.slice(0, 500)}`,
    );
  const { runner } = registrationResponseSchema.parse(JSON.parse(text));
  if (runnerId && runner.id !== runnerId)
    throw new Error(
      `Runner registration changed identity from ${runnerId} to ${runner.id}`,
    );
  const unresolved = projects.filter((project) => {
    const repository = runner.repos.find(
      (candidate) =>
        candidate.id === project.config.repositoryKey ||
        candidate.repositoryKey === project.config.repositoryKey,
    );
    return !repository?.projectId;
  });
  if (unresolved.length > 0)
    throw new Error(
      `Runner registration left projects unresolved: ${unresolved
        .map((project) => project.config.key)
        .join(", ")}`,
    );
  await persistRunnerId(config.runner.stateDirectory, runner.id);
  return runner;
}
