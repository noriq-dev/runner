import type { RunnerTaskSnapshot } from "./contracts.js";

export interface TaskContract {
  objective: string;
  constraints: string[];
  scope: string[];
  acceptanceCriteria: string[];
  verification: string[];
}

function taskFacts(task: RunnerTaskSnapshot): string {
  return `Task: ${task.key} — ${task.title}\n\nDescription:\n${task.body || "(none)"}\n\nExecution specification:\n${task.executionSpec ? JSON.stringify(task.executionSpec, null, 2) : "(none supplied)"}`;
}

export function guidePrompt(task: RunnerTaskSnapshot): string {
  return `You are the guide for one bounded coding task. Convert the immutable task snapshot into a concise execution contract for a fresh builder. Do not implement code and do not create another planning agent. If the execution specification is usable, preserve it instead of inventing a second plan. Resolve only ambiguities that can be settled from the repository.\n\n${taskFacts(task)}\n\nReturn objective, constraints, in-scope files or components, acceptance criteria, verification commands, and a compact plan. Keep the plan under 1200 words.`;
}

export function builderPrompt(
  task: RunnerTaskSnapshot,
  contract: TaskContract,
  guideInstructions?: string,
): string {
  return `You are the builder. Implement exactly one task in the current Git worktree. You may edit files and run focused checks. Do not commit, push, merge, create branches, or alter worktrees; the harness owns Git. Do not broaden scope. Finish with a truthful summary and verification evidence.\n\n${taskFacts(task)}\n\nExecution contract:\n${JSON.stringify(contract, null, 2)}${guideInstructions ? `\n\nGuide delegation:\n${guideInstructions}` : ""}`;
}

export function reviewerPrompt(
  task: RunnerTaskSnapshot,
  contract: TaskContract,
  diff: string,
  checkSummary: string,
): string {
  return `You are an independent read-only reviewer. You cannot edit files and must not implement fixes. Review the final rebased diff against the task contract and repository behavior. Report only concrete defects introduced by this diff. A blocker or major finding must name a failure scenario, evidence location, and violated acceptance condition. Minor findings are nonblocking. If no actionable defect exists, return an empty findings list.\n\n${taskFacts(task)}\n\nExecution contract:\n${JSON.stringify(contract, null, 2)}\n\nDeterministic checks:\n${checkSummary}\n\nFinal diff:\n${diff.slice(0, 200_000)}`;
}

export function repairPrompt(
  task: RunnerTaskSnapshot,
  contract: TaskContract,
  findings: unknown,
  checks: unknown,
  round: number,
): string {
  return `You are a fresh repair worker for round ${round}. Fix only the blocking deterministic-check failures and blocker/major review findings listed below. Work in the current worktree. Do not commit, push, merge, create branches, or alter worktrees; the harness owns Git. Re-run focused checks and finish with a truthful summary.\n\n${taskFacts(task)}\n\nExecution contract:\n${JSON.stringify(contract, null, 2)}\n\nBlocking findings:\n${JSON.stringify(findings, null, 2)}\n\nFailed checks:\n${JSON.stringify(checks, null, 2)}`;
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
