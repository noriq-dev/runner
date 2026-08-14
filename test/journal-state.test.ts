import { appendFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jobAssignmentSchema } from "../src/contracts.js";
import { ChecksummedJournal } from "../src/journal.js";
import { reduceJobState } from "../src/state.js";

describe("checksummed journal", () => {
  it("replays state and detects corruption", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runner-journal-"));
    const path = join(directory, "events.jsonl");
    const journal = await ChecksummedJournal.open(path);
    await journal.append("warning", { message: "one" });
    await journal.append("event.queued", {
      seq: 1,
      payload: {
        type: "warning",
        at: new Date().toISOString(),
        code: "x",
        message: "y",
      },
    });
    await journal.append("event.acked", { seq: 1 });
    const reopened = await ChecksummedJournal.open(path);
    expect(reduceJobState(reopened.all()).warnings).toEqual(["one"]);
    expect(reduceJobState(reopened.all()).outboundEvents).toEqual([]);
    await appendFile(path, '{"version":1,"seq":4}\n');
    await expect(ChecksummedJournal.open(path)).rejects.toThrow();
  });

  it("replays atomic invocation evidence once and preserves partial known cost", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runner-usage-journal-"));
    const journal = await ChecksummedJournal.open(
      join(directory, "events.jsonl"),
    );
    const actor = {
      kind: "agent",
      driver: "external",
      vendor: null,
      model: "model",
      effort: "medium",
      role: "builder",
      operation: "invoke",
    };
    const evidence = {
      operationDigest: null,
      resultDigest: "a".repeat(64),
      exitCode: null,
      timedOut: null,
      changedPathCount: null,
      blockerFindings: null,
      majorFindings: null,
      minorFindings: null,
      checkpointRef: null,
      errorCode: null,
    };
    const metric = (value: number) => ({
      status: "complete",
      value,
      provenance: "driver_reported",
    });
    const usage = (cost: number | null) => ({
      inputTokens: metric(10),
      outputTokens: metric(5),
      cacheReadTokens: metric(2),
      cacheWriteTokens: {
        status: "unavailable",
        value: null,
        provenance: "not_reported",
      },
      calls: metric(1),
      costUsd:
        cost === null
          ? {
              status: "unavailable",
              value: null,
              provenance: "not_reported",
            }
          : metric(cost),
    });
    for (const [id, cost] of [
      ["one", 1.25],
      ["two", null],
    ] as const) {
      await journal.append("invocation.started", {
        id,
        taskId: "task",
        role: "builder",
        status: "started",
        attempt: 1,
        startedAt: new Date().toISOString(),
        actor,
        ...(id === "two"
          ? {
              pricing: {
                quote: {
                  vendor: "openai",
                  model: "gpt-5.6-sol",
                  sourceUrl:
                    "https://developers.openai.com/api/docs/models/gpt-5.6-sol.md",
                  fetchedAt: "2026-08-14T00:00:00.000Z",
                  expiresAt: "2026-08-15T00:00:00.000Z",
                  sourceDigest: "b".repeat(64),
                  quoteDigest: "c".repeat(64),
                  parserVersion: "openai-model-markdown-v1",
                  rates: {
                    inputPerMillion: 5,
                    cachedInputPerMillion: 0.5,
                    cacheWritePerMillion: 6.25,
                    outputPerMillion: 30,
                    longContextThresholdTokens: 272_000,
                    longContextInputMultiplier: 2,
                    longContextOutputMultiplier: 1.5,
                  },
                },
                stale: false,
                warning: null,
              },
            }
          : {}),
      });
      await journal.append("invocation.completed", {
        id,
        completedAt: new Date().toISOString(),
        resultDigest: "a".repeat(64),
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cachedTokens: 2,
          costUsd: cost,
          calls: 1,
        },
        usageEvidence: usage(cost),
        duration: metric(10),
        actor,
        recovery: "none",
        evidence,
      });
    }
    await journal.append("invocation.completed", {
      id: "one",
      usageEvidence: usage(1.25),
    });
    const expectedUsage = {
      inputTokens: 20,
      outputTokens: 10,
      cachedTokens: 4,
      costUsd: null,
      calls: 2,
    };
    const state = reduceJobState(journal.all());
    expect(state.observationUsage.costUsd).toEqual({
      status: "partial",
      value: 1.25,
      provenance: "derived",
    });
    expect(state.observationUsage.calls.value).toBe(2);
    expect(state.usage).toEqual(expectedUsage);
    expect(state.invocations.two?.pricing?.quote?.quoteDigest).toBe(
      "c".repeat(64),
    );

    // A reduction must not alter the immutable journal input. The supervisor
    // reduces the whole journal after every append and again after restart.
    expect(reduceJobState(journal.all()).usage).toEqual(expectedUsage);
    await journal.append("warning", { message: "later record" });
    expect(reduceJobState(journal.all()).usage).toEqual(expectedUsage);
  });

  it("replays acknowledged progress as the durable job and task phase source", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runner-phase-journal-"));
    const journal = await ChecksummedJournal.open(
      join(directory, "events.jsonl"),
    );
    const task = (taskId: string, order: number) => ({
      taskId,
      key: `RUN-${order + 1}`,
      title: `Task ${order + 1}`,
      body: "",
      executionSpec: null,
      status: "todo" as const,
      retry: false,
      order,
      phaseOrder: 0,
    });
    const assignment = jobAssignmentSchema.parse({
      protocolVersion: 2,
      jobId: "job-phase",
      assignmentId: "assignment-phase",
      snapshotDigest: "f".repeat(64),
      repoRef: "runner",
      expectedBaseRevision: "base",
      source: {
        kind: "plan",
        projectId: "project",
        projectKey: "RUN",
        planId: "plan",
        planKey: "RUN-PLAN",
        planTitle: "Parallel phases",
        tasks: [task("one", 0), task("two", 1)],
        dependencies: [],
      },
    });
    await journal.append("job.assigned", { assignment });
    await journal.append("event.queued", {
      seq: 1,
      payload: {
        type: "progress",
        at: "2026-08-14T00:00:00.000Z",
        phase: "building",
        taskId: "one",
        message: "Building one",
        progress: 0,
      },
    });
    await journal.append("event.acked", { seq: 1 });
    await journal.append("event.queued", {
      seq: 2,
      payload: {
        type: "progress",
        at: "2026-08-14T00:00:01.000Z",
        phase: "reviewing",
        taskId: "two",
        message: "Reviewing two",
        progress: 0,
      },
    });
    await journal.append("event.acked", { seq: 2 });
    await journal.append("event.queued", {
      seq: 3,
      payload: {
        type: "progress",
        at: "2026-08-14T00:00:02.000Z",
        phase: "finalizing",
        message: "Finalizing",
        progress: 0,
      },
    });
    await journal.append("event.acked", { seq: 3 });

    const reopened = await ChecksummedJournal.open(
      join(directory, "events.jsonl"),
    );
    const state = reduceJobState(reopened.all());
    expect(state.phase).toBe("finalizing");
    expect(state.tasks.one?.phase).toBe("building");
    expect(state.tasks.two?.phase).toBe("reviewing");
    expect(state.outboundEvents).toEqual([]);
  });
});
