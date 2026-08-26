import { describe, expect, it } from "vitest";
import type { RunnerTaskSnapshot } from "../src/contracts.js";
import {
  builderPrompt,
  executionSpecContract,
  guidePrompt,
  mergeGuideContract,
  repairPrompt,
  reviewerPrompt,
} from "../src/prompts.js";

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

const marker = "BODY_MARKER_4b5a7d";
const representative: RunnerTaskSnapshot = {
  taskId: "task",
  key: "RUN-500",
  title: "Compact representative prompts",
  body: `${marker}: preserve the authored task description without sending it twice.`,
  executionSpec: {
    requirementIds: ["RUN-500"],
    anticipatedFiles: Array.from({ length: 6 }, (_, index) => ({
      path: `src/component-${index}.ts`,
      change: "modify",
      why: `Apply bounded requirement ${index} with enough representative context to expose duplicated serialization.`,
    })),
    requiredReading: ["README.md", "src/contracts.ts", "src/state.ts"],
    lockedDecisions: Array.from({ length: 5 }, (_, index) => ({
      decision: `Preserve durable behavior ${index}`,
      because: "journal replay is authoritative",
      source: `RUN-${400 + index}`,
    })),
    discretion: ["Choose local helper names", "Keep tests focused"],
    deferred: [
      "Do not add another wire protocol",
      "Do not rewrite VCS adapters",
    ],
    acceptance: {
      observableTruths: Array.from(
        { length: 6 },
        (_, index) => `Observable behavior ${index} remains deterministic`,
      ),
      artifacts: [
        {
          path: "src/component-0.ts",
          provides: "the bounded implementation",
          exports: ["runComponent"],
        },
      ],
      links: [
        {
          from: "src/component-1.ts",
          to: "runComponent",
          via: "a direct import",
        },
      ],
    },
    steps: [],
  },
  status: "todo",
  retry: false,
  order: 0,
  phaseOrder: 0,
};

describe("stage prompt compaction", () => {
  it("sends raw task/spec facts only to the guide and one normalized contract to workers", () => {
    const { contract } = executionSpecContract(representative, [
      "npm run check",
    ]);
    const guide = guidePrompt(representative);
    const prompts = [
      builderPrompt(representative, contract),
      reviewerPrompt(representative, contract, "+ candidate", "checks passed"),
      repairPrompt(representative, contract, [{ title: "finding" }], [], 1),
    ];

    expect(occurrences(guide, marker)).toBe(1);
    expect(guide).toContain('"requirementIds"');
    for (const prompt of prompts) {
      expect(occurrences(prompt, marker)).toBe(1);
      expect(prompt).not.toContain('"requirementIds"');
      expect(prompt).not.toContain("Execution specification:");
    }
  });

  it("reduces the serialized representative builder prompt by at least 30 percent", () => {
    const { contract } = executionSpecContract(representative, [
      "npm run check",
    ]);
    const compact = builderPrompt(representative, contract);
    const previousDuplicatedShape = `Task: ${representative.key} — ${representative.title}\n\nDescription:\n${representative.body}\n\nExecution specification:\n${JSON.stringify(representative.executionSpec, null, 2)}\n\nExecution contract:\n${JSON.stringify(contract, null, 2)}`;

    expect(Buffer.byteLength(compact)).toBeLessThanOrEqual(
      Buffer.byteLength(previousDuplicatedShape) * 0.7,
    );
  });

  it("keeps the reviewer read-only and requires verified, scenario-shaped findings", () => {
    const { contract } = executionSpecContract(representative, [
      "npm run check",
    ]);
    const prompt = reviewerPrompt(
      representative,
      contract,
      "+ candidate",
      "checks passed",
    );
    expect(prompt).toContain("READ-ONLY REVIEW — DO NOT MODIFY FILES");
    expect(prompt).toContain("triggering state");
    expect(prompt).toContain("wrong behavior");
    expect(prompt).toContain("return an empty findings list");
    expect(prompt.endsWith("never modify the workspace.")).toBe(true);
  });

  it("deterministically preserves authored partial facts when a guide fills gaps", () => {
    const partial: RunnerTaskSnapshot = {
      ...representative,
      executionSpec: {
        ...representative.executionSpec!,
        anticipatedFiles: [],
        acceptance: { observableTruths: [], artifacts: [], links: [] },
      },
    };
    const merged = mergeGuideContract(
      partial,
      {
        objective: "Add the missing implementation detail.",
        constraints: ["Guide constraint"],
        scope: ["src/new.ts"],
        acceptanceCriteria: ["new behavior works"],
        verification: ["npm test"],
      },
      ["npm run check"],
    );
    expect(merged.objective).toContain(marker);
    expect(merged.objective).toContain(
      "Add the missing implementation detail.",
    );
    expect(merged.constraints).toEqual(
      expect.arrayContaining([
        "Locked: Preserve durable behavior 0 because journal replay is authoritative (RUN-400)",
        "Guide constraint",
      ]),
    );
    expect(merged.scope).toEqual(
      expect.arrayContaining(["Read first: README.md", "src/new.ts"]),
    );
    expect(merged.verification).toEqual(
      expect.arrayContaining(["npm test", "npm run check"]),
    );
  });
});

describe("verification ownership", () => {
  const commands = ["make test-go", "make build-ue"];

  it("tells builder and repair that Runner runs the verification commands", () => {
    const contract = executionSpecContract(representative, commands).contract;
    for (const prompt of [
      builderPrompt(representative, contract, "", ""),
      repairPrompt(representative, contract, [], [], 1),
    ]) {
      // The worker may have no shell at all: the Claude driver spawns builder
      // and repair with --tools Edit,Glob,Grep,Read,Write. Telling it to run
      // checks makes it honestly report a blocker against its own work, which
      // burns every repair round and fails the task before Runner ever reaches
      // the checking stage.
      expect(prompt).toContain(
        "Runner runs the PROJECT'S CONFIGURED check commands itself",
      );
      expect(prompt).toContain("not having run them is not a defect");
      // Runner executes ONLY projectConfig.checks.commands, while
      // contract.verification is a union that also carries guide-proposed
      // commands. Promising Runner runs all of them would let a guide-added
      // check be skipped by the worker, never run by Runner, and the candidate
      // accepted as though it had passed.
      expect(prompt).toContain("Runner does not run it");
      expect(prompt).not.toMatch(/you may .*run focused checks/i);
      expect(prompt).not.toMatch(/re-run focused checks/i);
    }
  });

  it("does not put verification commands in the worker's plan as steps", () => {
    const { plan, contract } = executionSpecContract(representative, commands);
    for (const command of commands) {
      expect(plan).not.toContain(`Verify with ${command}`);
      // Still surfaced, so the worker knows what it will be judged by.
      expect(contract.verification).toContain(command);
    }
  });
});
