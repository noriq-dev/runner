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
});
