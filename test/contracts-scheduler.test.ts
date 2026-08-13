import { describe, expect, it } from "vitest";
import {
  assertAcyclicSource,
  type RunnerJobSource,
  runnerJobSourceSchema,
} from "../src/contracts.js";
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
