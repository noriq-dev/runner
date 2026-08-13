import { describe, expect, it } from "vitest";
import { runProcess } from "../src/process.js";

describe("process supervision", () => {
  it("captures structured completion and bounds timeout", async () => {
    const success = await runProcess({
      command: process.execPath,
      args: ["-e", 'process.stdout.write("ok")'],
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });
    expect(success).toMatchObject({
      exitCode: 0,
      stdout: "ok",
      timedOut: false,
    });
    const timeout = await runProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      timeoutMs: 50,
    });
    expect(timeout.timedOut).toBe(true);
  });
});
