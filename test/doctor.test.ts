import { describe, expect, test } from "vitest";
import { aggregateDriverChecks } from "../src/doctor.js";

describe("Runner doctor", () => {
  test("aggregates project and role preflights by registered driver", () => {
    const reports = aggregateDriverChecks([
      {
        driver: "codex",
        version: "1.0.0",
        authenticated: true,
        access: "read-only",
        requireControlMcp: true,
        runnerControlVisible: true,
        projectTools: ["project-a"],
        warnings: ["shared warning"],
      },
      {
        driver: "codex",
        version: "1.0.0",
        authenticated: true,
        access: "read-only",
        requireControlMcp: false,
        runnerControlVisible: false,
        projectTools: ["project-b"],
        warnings: ["shared warning"],
      },
      {
        driver: "claude",
        version: "2.0.0",
        authenticated: true,
        access: "workspace-write",
        requireControlMcp: false,
        runnerControlVisible: false,
        projectTools: [],
        warnings: [],
      },
    ]);

    expect(reports).toHaveLength(2);
    expect(reports.find((report) => report.driver === "codex")).toEqual({
      driver: "codex",
      version: "1.0.0",
      authenticated: true,
      access: ["read-only"],
      runnerControlVisible: true,
      projectTools: ["project-a", "project-b"],
      warnings: ["shared warning"],
      preflightChecks: 2,
    });
  });
});
