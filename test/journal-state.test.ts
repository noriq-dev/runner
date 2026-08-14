import { appendFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

    // A reduction must not alter the immutable journal input. The supervisor
    // reduces the whole journal after every append and again after restart.
    expect(reduceJobState(journal.all()).usage).toEqual(expectedUsage);
    await journal.append("warning", { message: "later record" });
    expect(reduceJobState(journal.all()).usage).toEqual(expectedUsage);
  });
});
