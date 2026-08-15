import { access, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { machineConfigSchema, projectConfigSchema } from "../src/config.js";
import type { DiscoveredProject } from "../src/discovery.js";
import { registerRunner } from "../src/registration.js";

function project(root: string): DiscoveredProject {
  return {
    repository: root,
    vcs: "git",
    vcsReason: "test",
    configPath: join(root, ".noriq", "project.toml"),
    config: projectConfigSchema.parse({
      key: "RUN",
      repositoryKey: "noriq-runner",
      defaultBranch: "main",
      sourceControl: { backend: "git", mode: "isolated", base: "main" },
      harness: { maxParallelTasks: 1, maxRepairRounds: 1, maxJobMinutes: 5 },
      agents: {
        guide: { driver: "fake", model: "guide", effort: "high" },
        builder: { driver: "fake", model: "builder", effort: "medium" },
        reviewer: { driver: "fake", model: "reviewer", effort: "high" },
      },
      setup: { commands: [], timeoutSeconds: 30 },
      checks: { commands: [], timeoutSeconds: 30 },
    }),
  };
}

describe("Runner registration", () => {
  it("registers resolved repositories and persists a fresh server identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-registration-"));
    await mkdir(join(root, ".noriq"));
    const stateDirectory = join(root, "state");
    const config = machineConfigSchema.parse({
      runner: {
        label: "test runner",
        serverUrl: "https://noriq.test",
        token: "secret",
        stateDirectory,
        scanRoots: [root],
        maxConcurrentJobs: 2,
      },
      drivers: {},
      backends: {},
    });
    let body: Record<string, unknown> | undefined;
    const registered = await registerRunner(
      config,
      [project(root)],
      async (input, init) => {
        expect(String(input)).toBe("https://noriq.test/api/runners");
        expect(init?.headers).toMatchObject({ Authorization: "Bearer secret" });
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            runner: {
              id: "rnr_fresh",
              status: "online",
              capabilities: {
                catalogGeneration: 7,
                catalogDigest: "a".repeat(64),
              },
              repos: [
                {
                  id: "noriq-runner",
                  projectKey: "RUN",
                  projectId: "prj_runner",
                  repositoryKey: "noriq-runner",
                },
              ],
            },
          }),
          { status: 200 },
        );
      },
    );
    expect(registered.id).toBe("rnr_fresh");
    expect(registered.capabilities).toMatchObject({
      catalogGeneration: 7,
      catalogDigest: "a".repeat(64),
    });
    expect(body).toMatchObject({
      label: "test runner",
      // Noriq catalog revision 2 refuses Runner versions below 0.16.0.
      // Keep the rebuild's distinct prerelease identity above that release floor.
      version: "0.18.1",
      kinds: [],
      maxConcurrency: 2,
      protocolCapabilities: [
        "runner-job.v2",
        "runner.catalog.v1",
        "runner.memory-context.v1",
        "runner.coordination.v1",
      ],
      repos: [
        {
          id: "noriq-runner",
          projectKey: "RUN",
          repositoryKey: "noriq-runner",
        },
      ],
    });
    expect(body).not.toHaveProperty("runnerId");
    expect(
      JSON.parse(await readFile(join(stateDirectory, "runner.json"), "utf8")),
    ).toEqual({
      runnerId: "rnr_fresh",
    });
    await expect(
      access(join(stateDirectory, "runner.json")),
    ).resolves.toBeUndefined();
  });

  it("refuses a registration that leaves a project unresolved", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "runner-registration-unresolved-"),
    );
    const config = machineConfigSchema.parse({
      runner: {
        id: "rnr_existing",
        serverUrl: "https://noriq.test",
        token: "secret",
        stateDirectory: join(root, "state"),
        scanRoots: [root],
      },
      drivers: {},
      backends: {},
    });
    await expect(
      registerRunner(
        config,
        [project(root)],
        async () =>
          new Response(
            JSON.stringify({
              runner: {
                id: "rnr_existing",
                status: "online",
                repos: [
                  {
                    id: "noriq-runner",
                    projectKey: "RUN",
                    projectId: null,
                    repositoryKey: "noriq-runner",
                  },
                ],
              },
            }),
          ),
      ),
    ).rejects.toThrow(/left projects unresolved: RUN/);
  });
});
