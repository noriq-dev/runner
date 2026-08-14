import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { projectConfigSchema } from "../src/config.js";
import { jobAssignmentSchema } from "../src/contracts.js";
import type {
  CoordinationLease,
  CoordinationProvider,
} from "../src/coordination/types.js";
import { FakeAgentDriver } from "../src/drivers/fake.js";
import { MemoryEventSink, RunnerJobSupervisor } from "../src/supervisor.js";
import type { SourceControlBackend } from "../src/vcs/types.js";

describe("supervisor routing boundaries", () => {
  it("rejects authored decomposition before any workspace, VCS, or agent effect", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-decomposed-"));
    const config = projectConfigSchema.parse({
      key: "RUN",
      repositoryKey: "runner",
      defaultBranch: "main",
      sourceControl: { backend: "git", mode: "isolated", base: "main" },
      harness: { maxParallelTasks: 1, maxRepairRounds: 1, maxJobMinutes: 30 },
      agents: {
        guide: { driver: "fake", model: "guide", effort: "medium" },
        builder: { driver: "fake", model: "builder", effort: "medium" },
        reviewer: { driver: "fake", model: "reviewer", effort: "high" },
      },
      setup: { commands: [], timeoutSeconds: 30 },
      checks: { commands: ["npm test"], timeoutSeconds: 30 },
    });
    const assignment = jobAssignmentSchema.parse({
      protocolVersion: 2,
      jobId: "job-decomposed",
      assignmentId: "assignment-decomposed",
      snapshotDigest: "d".repeat(64),
      repoRef: "runner",
      expectedBaseRevision: "base",
      source: {
        kind: "task",
        projectId: "project",
        projectKey: "RUN",
        task: {
          taskId: "task",
          key: "RUN-600",
          title: "Already decomposed",
          body: "Run each authored step independently.",
          executionSpec: {
            steps: [
              {
                id: "one",
                title: "First bounded task",
                anticipatedFiles: [{ path: "one.ts", change: "create" }],
                acceptance: { observableTruths: ["one exists"] },
              },
            ],
          },
          status: "todo",
          retry: false,
          order: 0,
          phaseOrder: 0,
        },
      },
    });
    let vcsEffects = 0;
    const backend = new Proxy({} as SourceControlBackend, {
      get() {
        vcsEffects += 1;
        throw new Error("VCS must not be inspected for decomposed tasks");
      },
    });
    const fake = new FakeAgentDriver(join(root, "artifacts"));
    const sink = new MemoryEventSink();
    const supervisor = new RunnerJobSupervisor({
      assignment,
      repository: join(root, "repository-that-need-not-exist"),
      stateDirectory: join(root, "state"),
      projectConfig: config,
      backend,
      drivers: { fake },
      sink,
    });

    await expect(supervisor.run()).rejects.toMatchObject({
      code: "unsupported_decomposition",
    });
    expect(vcsEffects).toBe(0);
    expect(fake.calls).toEqual([]);
    expect(sink.events).toEqual([]);
  });

  it("spends no workspace or agent effects while coordination is waiting", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-coordination-wait-"));
    const config = projectConfigSchema.parse({
      key: "RUN",
      repositoryKey: "runner",
      defaultBranch: "main",
      sourceControl: { backend: "git", mode: "isolated", base: "main" },
      harness: { maxParallelTasks: 1, maxRepairRounds: 1, maxJobMinutes: 30 },
      agents: {
        guide: { driver: "fake", model: "guide", effort: "medium" },
        builder: { driver: "fake", model: "builder", effort: "medium" },
        reviewer: { driver: "fake", model: "reviewer", effort: "high" },
      },
      setup: { commands: [], timeoutSeconds: 30 },
      checks: { commands: [], timeoutSeconds: 30 },
    });
    const assignment = jobAssignmentSchema.parse({
      protocolVersion: 2,
      jobId: "job-waiting",
      assignmentId: "assignment-waiting",
      snapshotDigest: "e".repeat(64),
      repoRef: "repo_checkout",
      expectedBaseRevision: "base",
      source: {
        kind: "task",
        projectId: "project",
        projectKey: "RUN",
        task: {
          taskId: "task",
          key: "RUN-601",
          title: "Wait before effects",
          body: "Create one file.",
          executionSpec: {
            anticipatedFiles: [{ path: "one.ts", change: "create" }],
            acceptance: { observableTruths: ["one.ts exists"] },
          },
          status: "todo",
          retry: false,
          order: 0,
          phaseOrder: 0,
        },
      },
    });
    let acquisitionAttempted!: () => void;
    const attempted = new Promise<void>((resolve) => {
      acquisitionAttempted = resolve;
    });
    const provider: CoordinationProvider = {
      acquire: vi.fn(async () => {
        acquisitionAttempted();
        return {
          status: "conflict" as const,
          retryAfterMs: 2_000,
          conflictingKind: "paths" as const,
        };
      }),
      exchange: vi.fn(),
      renew: vi.fn(),
      recover: vi.fn(
        async () => null,
      ) as unknown as CoordinationProvider["recover"],
      release: vi.fn(async (_lease: CoordinationLease) => {}),
    };
    const openJob = vi.fn();
    const backend = {
      id: "git",
      kind: "git",
      capabilities: {
        isolatedMode: true,
        directMode: true,
        parallelTaskWorkspaces: true,
        durableRecovery: true,
        automatedConflictRepair: true,
      },
      openJob,
      recoverOrphans: vi.fn(),
    } as unknown as SourceControlBackend;
    const fake = new FakeAgentDriver(join(root, "artifacts"));
    const supervisor = new RunnerJobSupervisor({
      assignment,
      repository: join(root, "repository"),
      stateDirectory: join(root, "state"),
      projectConfig: config,
      backend,
      drivers: { fake },
      coordination: {
        provider,
        runnerId: "runner",
        checkoutId: "repo_checkout",
        projectId: "project",
      },
      sink: new MemoryEventSink(),
    });

    const running = supervisor.run();
    await attempted;
    expect(openJob).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
    supervisor.cancel();
    await expect(running).rejects.toThrow(/cancelled/);
    expect(provider.release).not.toHaveBeenCalled();
  });
});
