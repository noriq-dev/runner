import { describe, expect, it } from "vitest";
import { projectConfigSchema } from "../src/config.js";
import type { RunnerTaskSnapshot } from "../src/contracts.js";
import { CodexAgentDriver } from "../src/drivers/codex.js";
import {
  classifyCandidate,
  classifyTask,
  executionSpecCoverage,
  resolveRoute,
  routeCandidateCounts,
  wireRouteClassification,
} from "../src/routing.js";

function config(
  overrides: {
    direct?: boolean;
    checks?: string[];
    elevated?: string[];
    critical?: string[];
  } = {},
) {
  return projectConfigSchema.parse({
    key: "RUN",
    repositoryKey: "runner",
    defaultBranch: "main",
    sourceControl: overrides.direct
      ? {
          backend: "git",
          mode: "direct",
          base: "main",
          target: "main",
          landing: "retain",
        }
      : { backend: "git", mode: "isolated", base: "main" },
    harness: { maxParallelTasks: 2, maxRepairRounds: 2, maxJobMinutes: 30 },
    agents: {
      guide: {
        economy: { driver: "cheap", model: "guide-e", effort: "low" },
        balanced: { driver: "middle", model: "guide-b", effort: "medium" },
        strong: { driver: "frontier", model: "guide-s", effort: "high" },
      },
      builder: {
        economy: { driver: "cheap", model: "build-e", effort: "low" },
        balanced: { driver: "middle", model: "build-b", effort: "medium" },
        strong: { driver: "frontier", model: "build-s", effort: "high" },
      },
      reviewer: {
        economy: { driver: "cheap", model: "review-e", effort: "low" },
        balanced: { driver: "middle", model: "review-b", effort: "medium" },
        strong: { driver: "frontier", model: "review-s", effort: "high" },
      },
    },
    routing: {
      elevatedPathPrefixes: overrides.elevated ?? [],
      criticalPathPrefixes: overrides.critical ?? [],
    },
    setup: { commands: [], timeoutSeconds: 30 },
    checks: { commands: overrides.checks ?? ["npm test"], timeoutSeconds: 30 },
  });
}

function task(
  options: {
    files?: number;
    acceptance?: number;
    reading?: number;
    body?: string;
    partial?: boolean;
    empty?: boolean;
    links?: number;
    change?: "create" | "modify" | "delete";
    pathPrefix?: string;
    steps?: number;
  } = {},
): RunnerTaskSnapshot {
  const files = options.files ?? 1;
  const prefix = options.pathPrefix ? `${options.pathPrefix}/` : "src/";
  return {
    taskId: "task",
    key: "RUN-1",
    title: "Route a task",
    body: options.body ?? "Implement the bounded change.",
    executionSpec: options.empty
      ? null
      : {
          requirementIds: [],
          anticipatedFiles: options.partial
            ? []
            : Array.from({ length: files }, (_, index) => ({
                path: `${prefix}file-${index}.ts`,
                change: options.change ?? "modify",
                why: "bounded scope",
              })),
          requiredReading: Array.from(
            { length: options.reading ?? 0 },
            (_, index) => `doc-${index}.md`,
          ),
          lockedDecisions: options.partial
            ? [
                {
                  decision: "Keep the API",
                  because: "compatibility",
                  source: "",
                },
              ]
            : [],
          discretion: [],
          deferred: [],
          acceptance: {
            observableTruths: Array.from(
              { length: options.acceptance ?? 1 },
              (_, index) => `truth ${index}`,
            ),
            artifacts: [],
            links: Array.from({ length: options.links ?? 0 }, (_, index) => ({
              from: `source-${index}`,
              to: `target-${index}`,
              via: "registration",
            })),
          },
          steps: Array.from({ length: options.steps ?? 0 }, (_, index) => ({
            id: `step-${index}`,
            title: `Step ${index}`,
            anticipatedFiles: [],
            dependsOn: [],
            acceptance: { observableTruths: [], artifacts: [], links: [] },
          })),
        },
    status: "todo",
    retry: false,
    order: 0,
    phaseOrder: 0,
  };
}

describe("deterministic task routing", () => {
  it("classifies every specification coverage state", () => {
    expect(executionSpecCoverage(task({ empty: true }))).toBe("empty");
    expect(executionSpecCoverage(task({ partial: true }))).toBe("partial");
    expect(executionSpecCoverage(task())).toBe("build_ready");
    expect(executionSpecCoverage(task({ steps: 1 }))).toBe("decomposed");
  });

  it.each([
    ["tiny", task()],
    ["small", task({ files: 3, acceptance: 3, reading: 2 })],
    ["standard", task({ files: 4 })],
    ["large", task({ files: 8 })],
    ["large", task({ acceptance: 8 })],
    ["large", task({ reading: 6 })],
    ["large", task({ body: "x".repeat(25 * 1024) })],
  ])("classifies %s at its deterministic boundary", (expected, snapshot) => {
    expect(classifyTask(snapshot, config()).size).toBe(expected);
  });

  it("takes the largest matching rule and routes missing or partial specs as standard", () => {
    expect(classifyTask(task({ empty: true }), config()).size).toBe("standard");
    expect(classifyTask(task({ partial: true }), config()).size).toBe(
      "standard",
    );
    expect(classifyTask(task(), config(), 4).size).toBe("large");
    expect(classifyTask(task({ reading: 2 }), config()).size).toBe("tiny");
  });

  it("applies deterministic risk floors and repair escalation", () => {
    const ordinary = classifyTask(task(), config());
    expect(resolveRoute(config(), "builder", ordinary).tier).toBe("economy");

    const elevated = classifyTask(
      task({ pathPrefix: "scripts" }),
      config({ elevated: ["scripts"] }),
    );
    expect(elevated.risk).toBe("elevated");
    expect(resolveRoute(config(), "builder", elevated).tier).toBe("balanced");
    expect(resolveRoute(config(), "reviewer", elevated).tier).toBe("strong");
    expect(resolveRoute(config(), "guide", elevated).tier).toBe("economy");
    expect(resolveRoute(config(), "repairer", elevated, 1).tier).toBe("strong");

    const critical = classifyTask(
      task({ pathPrefix: "src/security" }),
      config({ critical: ["src/security"] }),
    );
    expect(critical.risk).toBe("critical");
    for (const role of ["guide", "builder", "reviewer", "repairer"] as const)
      expect(resolveRoute(config(), role, critical).tier).toBe("strong");
  });

  it("treats deletes, direct workspaces, and missing checks as elevated", () => {
    expect(classifyTask(task({ change: "delete" }), config()).risk).toBe(
      "elevated",
    );
    expect(classifyTask(task(), config({ direct: true })).risk).toBe(
      "elevated",
    );
    expect(classifyTask(task(), config({ checks: [] })).risk).toBe("elevated");
  });

  it("only upgrades a reviewer route from actual candidate evidence", () => {
    const initial = classifyTask(
      task(),
      config({ critical: ["src/security"] }),
    );
    const standard = classifyCandidate(initial, task(), config(), {
      changedPaths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
      diffBytes: 1_000,
      failedChecks: false,
    });
    expect(standard.size).toBe("standard");
    expect(standard.risk).toBe("elevated");
    const critical = classifyCandidate(
      initial,
      task(),
      config({ critical: ["src/security"] }),
      {
        changedPaths: ["src/security/auth.ts"],
        diffBytes: 500,
        failedChecks: false,
      },
    );
    expect(critical.risk).toBe("critical");
    const repaired = classifyCandidate(initial, task(), config(), {
      changedPaths: ["src/file-0.ts"],
      diffBytes: 500,
      failedChecks: false,
      priorRepair: true,
    });
    expect(repaired.risk).toBe("elevated");
    expect(resolveRoute(config(), "reviewer", repaired).tier).toBe("strong");
    const large = classifyCandidate(standard, task(), config(), {
      changedPaths: Array.from({ length: 8 }, (_, index) => `src/${index}.ts`),
      diffBytes: 500,
      failedChecks: true,
      priorRepair: true,
    });
    expect(large.size).toBe("large");
    expect(large.reasons).toEqual(
      expect.arrayContaining([
        "actual_diff_large",
        "failed_checks",
        "repair_escalation",
      ]),
    );
    expect(resolveRoute(config(), "reviewer", large).tier).toBe("strong");
  });

  it("normalizes legacy and incomplete tier profiles without coupling driver IDs to vendors", () => {
    const parsed = projectConfigSchema.parse({
      key: "RUN",
      repositoryKey: "runner",
      defaultBranch: "main",
      sourceControl: { backend: "git", mode: "isolated", base: "main" },
      harness: { maxParallelTasks: 1, maxRepairRounds: 1, maxJobMinutes: 30 },
      agents: {
        guide: { driver: "custom-codex", model: "one", effort: "medium" },
        builder: {
          balanced: { driver: "claude-pool", model: "two", effort: "medium" },
        },
        reviewer: { driver: "custom-codex", model: "three", effort: "high" },
      },
      setup: { commands: [], timeoutSeconds: 30 },
      checks: { commands: ["npm test"], timeoutSeconds: 30 },
    });
    expect(parsed.agents.guide.economy).toEqual(parsed.agents.guide.strong);
    expect(parsed.agents.builder.economy).toEqual(
      parsed.agents.builder.balanced,
    );
    expect(parsed.agents.builder.strong).toEqual(
      parsed.agents.builder.balanced,
    );
    expect(parsed.agents.repairer).toEqual(parsed.agents.builder);

    const driver = new CodexAgentDriver(
      "custom-codex",
      {
        adapter: "codex",
        command: "codex",
        args: [],
        env: {},
        home: "/tmp/codex",
      },
      "/tmp/state",
    );
    expect(driver.id).toBe("custom-codex");
    expect(driver.vendor).toBe("openai");
  });

  it("maps rich local classification into the bounded control-plane vocabulary", () => {
    const classification = classifyTask(
      task({ files: 4, acceptance: 4, pathPrefix: "infra" }),
      config({ elevated: ["infra"] }),
    );
    expect(wireRouteClassification(classification)).toMatchObject({
      size: "medium",
      risk: "medium",
      specCoverage: "complete",
      reasons: expect.arrayContaining([
        "spec.complete",
        "size.files.medium",
        "risk.path_elevated",
      ]),
    });
  });

  it("deduplicates fallback profiles in candidate and eligible counts", () => {
    const parsed = projectConfigSchema.parse({
      key: "RUN",
      repositoryKey: "runner",
      defaultBranch: "main",
      sourceControl: { backend: "git", mode: "isolated", base: "main" },
      harness: { maxParallelTasks: 1, maxRepairRounds: 1, maxJobMinutes: 30 },
      agents: {
        guide: { driver: "same", model: "guide", effort: "medium" },
        builder: {
          economy: { driver: "cheap", model: "builder", effort: "low" },
          balanced: { driver: "same", model: "builder", effort: "medium" },
          strong: { driver: "same", model: "builder", effort: "medium" },
        },
        reviewer: { driver: "same", model: "reviewer", effort: "high" },
      },
      setup: { commands: [], timeoutSeconds: 30 },
      checks: { commands: ["npm test"], timeoutSeconds: 30 },
    });
    expect(
      routeCandidateCounts(parsed, "builder", "balanced", "invoke"),
    ).toEqual({
      candidateCount: 2,
      eligibleCount: 1,
    });
    expect(routeCandidateCounts(parsed, "builder", "balanced", "skip")).toEqual(
      {
        candidateCount: 2,
        eligibleCount: 0,
      },
    );
  });
});
