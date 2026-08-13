import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";

const commandList = z.array(z.string().trim().min(1).max(4_000)).max(100);
const agentProfileSchema = z
  .object({
    provider: z.enum(["codex", "claude", "fake"]),
    model: z.string().trim().min(1).max(200),
    effort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]),
  })
  .strict();

export const projectConfigSchema = z
  .object({
    key: z.string().trim().min(1).max(80),
    repositoryKey: z.string().trim().min(1).max(200),
    defaultBranch: z.string().trim().min(1).max(500),
    workspace: z
      .object({
        mode: z.enum(["isolated", "direct"]).default("isolated"),
        baseBranch: z.string().trim().min(1).max(500),
        directBranch: z.string().trim().min(1).max(500).optional(),
      })
      .strict(),
    harness: z
      .object({
        maxParallelTasks: z.number().int().min(1).max(32).default(2),
        maxRepairRounds: z.number().int().min(0).max(10).default(2),
        maxJobMinutes: z.number().int().min(1).max(10_080).default(240),
        maxTokens: z.number().int().positive().optional(),
        maxCostUsd: z.number().positive().optional(),
      })
      .strict(),
    agents: z
      .object({
        guide: agentProfileSchema,
        builder: agentProfileSchema,
        reviewer: agentProfileSchema,
      })
      .strict(),
    setup: z
      .object({
        commands: commandList.default([]),
        timeoutSeconds: z.number().int().min(1).max(86_400).default(900),
      })
      .strict(),
    checks: z
      .object({
        commands: commandList.default([]),
        timeoutSeconds: z.number().int().min(1).max(86_400).default(900),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.workspace.mode === "direct" && !value.workspace.directBranch) {
      context.addIssue({
        code: "custom",
        path: ["workspace", "directBranch"],
        message: "directBranch is required in direct mode",
      });
    }
  });
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

const providerSchema = z
  .object({
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
    home: z.string().trim().min(1),
    env: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const machineConfigSchema = z
  .object({
    runner: z
      .object({
        id: z.string().trim().min(1),
        serverUrl: z.string().url(),
        token: z.string().min(1),
        stateDirectory: z
          .string()
          .trim()
          .min(1)
          .default(resolve(homedir(), ".local/state/noriq-runner")),
        scanRoots: z.array(z.string().trim().min(1)).min(1),
        maxConcurrentJobs: z.number().int().min(1).max(32).default(1),
      })
      .strict(),
    providers: z
      .object({
        codex: providerSchema.optional(),
        claude: providerSchema.optional(),
        fake: providerSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type MachineConfig = z.infer<typeof machineConfigSchema>;

async function readToml(path: string): Promise<unknown> {
  return parse(await readFile(path, "utf8"));
}

export async function loadProjectConfig(path: string): Promise<ProjectConfig> {
  return projectConfigSchema.parse(await readToml(path));
}

export async function loadMachineConfig(path: string): Promise<MachineConfig> {
  return machineConfigSchema.parse(await readToml(path));
}
