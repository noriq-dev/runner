import { describe, expect, it } from "vitest";
import {
  assertAcyclicSource,
  type RunnerJobSource,
  runnerJobEventPayloadSchema,
  runnerJobSourceSchema,
} from "../src/contracts.js";
import { runnerToServerSchema } from "../src/protocol.js";
import { orderedTasks, readyTasks } from "../src/scheduler.js";

function plan(): RunnerJobSource {
  return runnerJobSourceSchema.parse({
    kind: "plan",
    projectId: "project",
    projectKey: "RUN",
    planId: "plan",
    planKey: "PLAN-1",
    planTitle: "Test plan",
    tasks: [
      {
        taskId: "b",
        key: "RUN-2",
        title: "B",
        body: "",
        executionSpec: null,
        status: "todo",
        retry: false,
        order: 1,
        phaseOrder: 0,
      },
      {
        taskId: "a",
        key: "RUN-1",
        title: "A",
        body: "",
        executionSpec: null,
        status: "todo",
        retry: false,
        order: 0,
        phaseOrder: 0,
      },
      {
        taskId: "c",
        key: "RUN-3",
        title: "C",
        body: "",
        executionSpec: null,
        status: "todo",
        retry: false,
        order: 0,
        phaseOrder: 1,
      },
    ],
    dependencies: [{ taskId: "c", dependsOnTaskId: "a" }],
  });
}

describe("RunnerJob source and scheduler", () => {
  it("accepts VCS-tagged hello entries with opaque revisions", () => {
    expect(
      runnerToServerSchema.parse({
        type: "hello",
        protocolVersion: 2,
        runnerId: "runner",
        capacity: 1,
        repositories: [
          {
            repositoryKey: "perforce-project",
            repoRef: "perforce-project",
            vcs: "perforce",
            baseRevision: "12345",
          },
        ],
      }),
    ).toBeTruthy();
  });

  it("accepts bounded route, task progress, and API-list cost-basis evidence", () => {
    expect(
      runnerJobEventPayloadSchema.parse({
        type: "agent.route",
        at: "2026-08-14T00:00:00.000Z",
        route: {
          taskId: "task",
          role: "builder",
          attempt: 1,
          policyVersion: "task-routing-v1",
          size: "small",
          risk: "low",
          specCoverage: "complete",
          reasons: ["spec.complete"],
          candidateCount: 3,
          eligibleCount: 2,
          decision: "invoke",
          actor: {
            kind: "agent",
            role: "builder",
            driver: "codex-pool",
            vendor: "openai",
            model: "gpt-5.6-terra",
            effort: "medium",
            operation: "invoke",
          },
        },
      }),
    ).toBeTruthy();
    expect(
      runnerJobEventPayloadSchema.parse({
        type: "progress",
        at: "2026-08-14T00:00:01.000Z",
        phase: "building",
        taskId: "task",
        message: "Building",
        progress: 0,
      }),
    ).toBeTruthy();
    expect(
      runnerJobEventPayloadSchema.parse({
        type: "stage.finished",
        at: "2026-08-14T00:00:02.000Z",
        startedAt: "2026-08-14T00:00:01.000Z",
        observationId: "observation",
        taskId: "task",
        stage: "build",
        attempt: 1,
        actor: {
          kind: "agent",
          driver: "codex-pool",
          vendor: "openai",
          model: "gpt-5.6-terra",
          effort: "medium",
          role: "builder",
          operation: "invoke",
        },
        outcome: "succeeded",
        duration: {
          status: "complete",
          value: 1_000,
          provenance: "driver_reported",
        },
        usage: {
          inputTokens: {
            status: "complete",
            value: 100,
            provenance: "driver_reported",
          },
          outputTokens: {
            status: "complete",
            value: 10,
            provenance: "driver_reported",
          },
          cacheReadTokens: {
            status: "partial",
            value: 0,
            provenance: "driver_reported",
          },
          cacheWriteTokens: {
            status: "unavailable",
            value: null,
            provenance: "not_reported",
          },
          calls: {
            status: "complete",
            value: 1,
            provenance: "driver_reported",
          },
          costUsd: { status: "partial", value: 0.0004, provenance: "derived" },
        },
        recovery: "none",
        evidence: {
          operationDigest: null,
          resultDigest: "a".repeat(64),
          exitCode: null,
          timedOut: null,
          changedPathCount: 2,
          blockerFindings: 0,
          majorFindings: 0,
          minorFindings: 0,
          checkpointRef: null,
          errorCode: null,
        },
        costBasis: {
          kind: "api_list_estimate",
          priceSource: {
            provider: "openai",
            catalog: "official-api-list",
            fetchedAt: "2026-08-14T00:00:00.000Z",
            ageSeconds: 2,
            stale: false,
          },
        },
      }),
    ).toBeTruthy();
    expect(
      runnerJobEventPayloadSchema.parse({
        type: "progress",
        at: "2026-08-14T00:00:03.000Z",
        phase: "finalizing",
        message: "Finalizing",
        progress: 0,
      }),
    ).toBeTruthy();
  });
  it("uses stable phase, task, and key order", () => {
    expect(orderedTasks(plan()).map((task) => task.key)).toEqual([
      "RUN-1",
      "RUN-2",
      "RUN-3",
    ]);
  });

  it("gates dependencies and honors capacity", () => {
    expect(
      readyTasks(
        plan(),
        {
          accepted: new Set(),
          failed: new Set(),
          running: new Set(),
          stopScheduling: false,
        },
        2,
      ).map((task) => task.taskId),
    ).toEqual(["a", "b"]);
    expect(
      readyTasks(
        plan(),
        {
          accepted: new Set(["a"]),
          failed: new Set(),
          running: new Set(["b"]),
          stopScheduling: false,
        },
        2,
      ).map((task) => task.taskId),
    ).toEqual(["c"]);
  });

  it("rejects cycles and foreign task references", () => {
    const source = plan();
    if (source.kind !== "plan") throw new Error("fixture");
    expect(() =>
      assertAcyclicSource({
        ...source,
        dependencies: [
          { taskId: "a", dependsOnTaskId: "c" },
          { taskId: "c", dependsOnTaskId: "a" },
        ],
      }),
    ).toThrow(/cycle/);
    expect(() =>
      assertAcyclicSource({
        ...source,
        dependencies: [{ taskId: "missing", dependsOnTaskId: "a" }],
      }),
    ).toThrow(/invalid dependency/);
  });
});
