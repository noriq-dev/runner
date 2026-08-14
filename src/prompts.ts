import type { RunnerTaskSnapshot } from "./contracts.js";

export interface TaskContract {
  objective: string;
  constraints: string[];
  scope: string[];
  acceptanceCriteria: string[];
  verification: string[];
}

function taskObjective(task: RunnerTaskSnapshot): string {
  return task.body.trim() ? `${task.title}\n\n${task.body.trim()}` : task.title;
}

function unique(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

export function executionSpecContract(
  task: RunnerTaskSnapshot,
  verificationCommands: string[],
): { contract: TaskContract; plan: string } {
  const spec = task.executionSpec;
  if (!spec) throw new Error("task has no execution specification");
  const constraints = [
    ...spec.lockedDecisions.map(
      (item) =>
        `Locked: ${item.decision}${item.because ? ` because ${item.because}` : ""}${item.source ? ` (${item.source})` : ""}`,
    ),
    ...spec.discretion.map((item) => `Builder discretion: ${item}`),
    ...spec.deferred.map((item) => `Out of scope: ${item}`),
  ];
  const scope = [
    ...spec.anticipatedFiles.map(
      (file) =>
        `${file.change} ${file.path}${file.why ? ` — ${file.why}` : ""}`,
    ),
    ...spec.requiredReading.map((item) => `Read first: ${item}`),
  ];
  const acceptanceCriteria = [
    ...spec.acceptance.observableTruths,
    ...spec.acceptance.artifacts.map(
      (artifact) =>
        `${artifact.path} provides ${artifact.provides || "the declared task artifact"}${artifact.exports.length > 0 ? ` and exports ${artifact.exports.join(", ")}` : ""}`,
    ),
    ...spec.acceptance.links.map(
      (link) =>
        `${link.from} reaches ${link.to}${link.via ? ` via ${link.via}` : ""}`,
    ),
  ];
  const plan =
    spec.steps.length > 0
      ? spec.steps
          .map(
            (step, index) =>
              `${index + 1}. ${step.title}${step.dependsOn.length > 0 ? ` (after ${step.dependsOn.join(", ")})` : ""}`,
          )
          .join("\n")
      : [
          ...spec.requiredReading.map((item) => `Read ${item}.`),
          ...spec.anticipatedFiles.map(
            (file) =>
              `${file.change[0]!.toUpperCase()}${file.change.slice(1)} ${file.path}${file.why ? `: ${file.why}` : "."}`,
          ),
          ...verificationCommands.map((command) => `Verify with ${command}.`),
        ].join("\n") || `Implement ${task.key}: ${task.title}`;
  return {
    contract: {
      objective: taskObjective(task),
      constraints,
      scope,
      acceptanceCriteria,
      verification: verificationCommands,
    },
    plan,
  };
}

/**
 * A guide may fill gaps but cannot erase authored task facts. The merge happens
 * in Runner after structured output validation, so preservation is deterministic
 * rather than a prompt-only request.
 */
export function mergeGuideContract(
  task: RunnerTaskSnapshot,
  guide: TaskContract,
  verificationCommands: string[],
): TaskContract {
  const authored = task.executionSpec
    ? executionSpecContract(task, verificationCommands).contract
    : {
        objective: taskObjective(task),
        constraints: [],
        scope: [],
        acceptanceCriteria: [],
        verification: verificationCommands,
      };
  const guideObjective = guide.objective.trim();
  const objective =
    !guideObjective || authored.objective.includes(guideObjective)
      ? authored.objective
      : `${authored.objective}\n\nGuide clarification:\n${guideObjective}`;
  return {
    objective,
    constraints: unique([...authored.constraints, ...guide.constraints]),
    scope: unique([...authored.scope, ...guide.scope]),
    acceptanceCriteria: unique([
      ...authored.acceptanceCriteria,
      ...guide.acceptanceCriteria,
    ]),
    verification: unique([
      ...authored.verification,
      ...guide.verification,
      ...verificationCommands,
    ]),
  };
}

function guideFacts(task: RunnerTaskSnapshot): string {
  return `Task: ${task.key} — ${task.title}\n\nDescription:\n${task.body || "(none)"}\n\nExecution specification:\n${task.executionSpec ? JSON.stringify(task.executionSpec, null, 2) : "(none supplied)"}`;
}

function taskIdentity(task: RunnerTaskSnapshot): string {
  return `Task: ${task.key} — ${task.title}`;
}

export function guidePrompt(task: RunnerTaskSnapshot): string {
  return `You are the guide for one bounded coding task. Convert the immutable task snapshot into a concise execution contract for a fresh builder. Do not implement code and do not create another planning agent. Preserve every authored requirement, locked decision, scope item, and acceptance condition; fill only missing information. Resolve only ambiguities that can be settled from the repository.\n\n${guideFacts(task)}\n\nReturn objective, constraints, in-scope files or components, acceptance criteria, verification commands, and a compact plan. Keep the plan under 1200 words.`;
}

export function builderPrompt(
  task: RunnerTaskSnapshot,
  contract: TaskContract,
  guideInstructions?: string,
): string {
  return `You are the builder. Implement exactly one task in the current workspace. You may edit files and run focused checks. Do not invoke source-control commands, create checkpoints, publish work, or change source-control configuration; the harness owns those operations. Do not broaden scope. Batch independent reads and commands into the same tool round, and do not repeat a check after it has produced sufficient deterministic evidence. Finish with a truthful summary and verification evidence.\n\n${taskIdentity(task)}\n\nExecution contract:\n${JSON.stringify(contract, null, 2)}${guideInstructions ? `\n\nGuide delegation:\n${guideInstructions}` : ""}`;
}

export function reviewerPrompt(
  task: RunnerTaskSnapshot,
  contract: TaskContract,
  diff: string,
  checkSummary: string,
): string {
  return `=== READ-ONLY REVIEW — DO NOT MODIFY FILES ===\nYou are an independent reviewer. The candidate diff is ground truth; the execution contract is the claim it must satisfy. Inspect repository context when needed, but do not edit files or implement fixes. Report only concrete defects introduced by this candidate. A blocker or major finding names the triggering state, wrong behavior, evidence location, and violated acceptance condition. Minor findings are nonblocking. If no actionable defect survives verification, return an empty findings list.\n\n${taskIdentity(task)}\n\nExecution contract:\n${JSON.stringify(contract, null, 2)}\n\nDeterministic checks:\n${checkSummary}\n\nCandidate diff:\n${diff.slice(0, 200_000)}\n\nRemember: review only; never modify the workspace.`;
}

export function repairPrompt(
  task: RunnerTaskSnapshot,
  contract: TaskContract,
  findings: unknown,
  checks: unknown,
  round: number,
): string {
  return `You are a fresh repair worker for round ${round}. Fix only the blocker/major worker or review findings and deterministic-check failures listed below. Work in the current workspace. Do not invoke source-control commands, create checkpoints, publish work, or change source-control configuration; the harness owns those operations. Batch independent reads and commands into the same tool round, and do not repeat a check after it has produced sufficient deterministic evidence. Re-run focused checks and finish with a truthful summary.\n\n${taskIdentity(task)}\n\nExecution contract:\n${JSON.stringify(contract, null, 2)}\n\nBlocking findings:\n${JSON.stringify(findings, null, 2)}\n\nFailed checks:\n${JSON.stringify(checks, null, 2)}`;
}

export const guideOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "objective",
    "constraints",
    "scope",
    "acceptanceCriteria",
    "verification",
    "plan",
  ],
  properties: {
    summary: { type: "string" },
    objective: { type: "string" },
    constraints: { type: "array", items: { type: "string" } },
    scope: { type: "array", items: { type: "string" } },
    acceptanceCriteria: { type: "array", items: { type: "string" } },
    verification: { type: "array", items: { type: "string" } },
    plan: { type: "string" },
  },
} as const;

export const workerOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "title", "body", "path", "line"],
        properties: {
          severity: { enum: ["blocker", "major", "minor"] },
          title: { type: "string" },
          body: { type: "string" },
          path: { type: ["string", "null"] },
          line: { type: ["integer", "null"] },
        },
      },
    },
  },
} as const;
