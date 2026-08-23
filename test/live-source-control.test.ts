import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectConfigSchema } from "../src/config.js";
import { DiversionSourceControlBackend } from "../src/vcs/diversion.js";
import { PerforceSourceControlBackend } from "../src/vcs/perforce.js";
import type { SourceControlBackend } from "../src/vcs/types.js";

const explicitlyDisposable =
  process.env.RUNNER_LIVE_VCS_DISPOSABLE === "yes-i-understand";

function project(base: string, backend: string) {
  return projectConfigSchema.parse({
    key: "LIVE",
    repositoryKey: `live-${backend}`,
    defaultBranch: base,
    sourceControl: { backend, mode: "isolated", base },
    harness: { maxParallelTasks: 1, maxRepairRounds: 1, maxJobMinutes: 5 },
    agents: {
      guide: { driver: "fake", model: "fake", effort: "low" },
      builder: { driver: "fake", model: "fake", effort: "low" },
      reviewer: { driver: "fake", model: "fake", effort: "low" },
    },
    setup: { commands: [], timeoutSeconds: 30 },
    checks: { commands: [], timeoutSeconds: 30 },
  });
}

async function liveCandidate(
  backend: SourceControlBackend,
  repository: string,
  baseReference: string,
) {
  const root = await realpath(repository);
  if (/\/Diversion\/Prototype\/?$/.test(root))
    throw new Error("live backend tests refuse to use Project NOD");
  const expectedBaseRevision = await backend.revisionOf(root, baseReference);
  const jobId = `live-${backend.kind}-${Date.now()}`;
  const stateDirectory = await mkdtemp(
    join(tmpdir(), `noriq-live-${backend.kind}-`),
  );
  const workspace = await backend.openJob({
    repository: root,
    stateDirectory,
    jobId,
    key: jobId,
    kind: "task",
    expectedBaseRevision,
    config: project(baseReference, backend.id),
  });
  try {
    const task = await backend.beginTask(workspace, "LIVE-1");
    await writeFile(
      join(task.path, `.noriq-runner-live-${Date.now()}`),
      `${jobId}\n`,
    );
    const staged = await backend.stageCandidate({
      workspace,
      task,
      taskKey: "LIVE-1",
      summary: "opt-in disposable backend validation",
      refresh: false,
    });
    expect(staged.status).toBe("ready");
    if (staged.status !== "ready") throw new Error(staged.detail);
    const accepted = await backend.acceptCandidate({
      workspace,
      task,
      candidate: staged.checkpoint,
      taskKey: "LIVE-1",
    });
    expect(accepted.ref).toBeTruthy();
    if (backend.kind === "diversion") {
      expect(accepted.ref).not.toBe(expectedBaseRevision);
      const inspection = await backend.inspect(workspace);
      expect(inspection.revision).toBe(accepted.ref);
      expect(inspection.dirtyPaths).toEqual([]);
    }
    await backend.releaseTask(workspace, task);
    await backend.release(workspace, jobId);
    const landingRequest = {
      repository: root,
      stateDirectory,
      jobId,
      workspace,
      target: baseReference,
      acceptedTaskCheckpoints: { "LIVE-1": accepted },
    };
    const landed = await backend.land(landingRequest);
    expect(landed.target).toBe(baseReference);
    expect(landed.checkpoint.ref).toBe(
      await backend.revisionOf(root, baseReference),
    );
    await expect(backend.land(landingRequest)).resolves.toEqual(landed);
  } finally {
    await backend.release(workspace, jobId);
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

describe.runIf(
  explicitlyDisposable &&
    Boolean(process.env.RUNNER_LIVE_DIVERSION_REPOSITORY) &&
    Boolean(process.env.RUNNER_LIVE_DIVERSION_BASE),
)("live Diversion backend", () => {
  it("creates, accepts, and lands a candidate in an explicitly disposable repository", async () => {
    const repository = process.env.RUNNER_LIVE_DIVERSION_REPOSITORY!;
    await liveCandidate(
      new DiversionSourceControlBackend("diversion"),
      repository,
      process.env.RUNNER_LIVE_DIVERSION_BASE!,
    );
  }, 120_000);

  it("does the same in its own cloned workspaces without touching the checkout", async () => {
    const repository = process.env.RUNNER_LIVE_DIVERSION_REPOSITORY!;
    const backend = new DiversionSourceControlBackend(
      "diversion",
      "dv",
      undefined,
      "per-task",
    );
    expect(backend.capabilities.parallelTaskWorkspaces).toBe(true);
    const before = await backend.revisionOf(
      repository,
      process.env.RUNNER_LIVE_DIVERSION_BASE!,
    );
    await liveCandidate(
      backend,
      repository,
      process.env.RUNNER_LIVE_DIVERSION_BASE!,
    );
    expect(before).toBeTruthy();
  }, 1_800_000);
});

describe.runIf(
  explicitlyDisposable &&
    Boolean(process.env.RUNNER_LIVE_PERFORCE_REPOSITORY) &&
    Boolean(process.env.RUNNER_LIVE_PERFORCE_BASE),
)("live Perforce backend", () => {
  it("creates, accepts, and lands a cumulative shelf in an explicitly disposable client", async () => {
    const repository = process.env.RUNNER_LIVE_PERFORCE_REPOSITORY!;
    await liveCandidate(
      new PerforceSourceControlBackend("perforce"),
      repository,
      process.env.RUNNER_LIVE_PERFORCE_BASE!,
    );
  }, 120_000);
});
