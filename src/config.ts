import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";

const registeredId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]{1,100}$/);
const commandList = z.array(z.string().trim().min(1).max(4_000)).max(100);
const environmentVariable = z
  .string()
  .trim()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,199}$/);

const legacyAgentProfileSchema = z
  .object({
    driver: registeredId.optional(),
    provider: registeredId.optional(),
    model: z.string().trim().min(1).max(200),
    effort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.driver && !value.provider)
      context.addIssue({
        code: "custom",
        path: ["driver"],
        message: "driver is required",
      });
    if (value.driver && value.provider && value.driver !== value.provider)
      context.addIssue({
        code: "custom",
        path: ["provider"],
        message: "legacy provider must match driver when both are present",
      });
  });

const sourceControlSchema = z
  .object({
    backend: registeredId.or(z.literal("auto")).default("auto"),
    mode: z.enum(["isolated", "direct"]).default("isolated"),
    base: z.string().trim().min(1).max(500),
    target: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const legacyWorkspaceSchema = z
  .object({
    mode: z.enum(["isolated", "direct"]).default("isolated"),
    baseBranch: z.string().trim().min(1).max(500),
    directBranch: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const projectConfigInputSchema = z
  .object({
    key: z.string().trim().min(1).max(80),
    repositoryKey: z.string().trim().min(1).max(200),
    defaultBranch: z.string().trim().min(1).max(500),
    sourceControl: sourceControlSchema.optional(),
    workspace: legacyWorkspaceSchema.optional(),
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
        guide: legacyAgentProfileSchema,
        builder: legacyAgentProfileSchema,
        reviewer: legacyAgentProfileSchema,
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
    if (!value.sourceControl && !value.workspace)
      context.addIssue({
        code: "custom",
        path: ["sourceControl"],
        message: "sourceControl is required",
      });
    if (value.sourceControl && value.workspace)
      context.addIssue({
        code: "custom",
        path: ["workspace"],
        message: "workspace and sourceControl cannot both be configured",
      });
  });

export const projectConfigSchema = projectConfigInputSchema.transform(
  (input) => {
    const warnings: string[] = [];
    const sourceControl =
      input.sourceControl ??
      (() => {
        warnings.push(
          "legacy [workspace] configuration was normalized; use [sourceControl] with base/target",
        );
        return {
          backend: "auto" as const,
          mode: input.workspace!.mode,
          base: input.workspace!.baseBranch,
          ...(input.workspace!.directBranch
            ? { target: input.workspace!.directBranch }
            : {}),
        };
      })();
    if (sourceControl.mode === "direct" && !sourceControl.target)
      throw new Error("sourceControl.target is required in direct mode");
    const normalizeAgent = (
      profile: z.infer<typeof legacyAgentProfileSchema>,
    ) => {
      if (!profile.driver)
        warnings.push(
          `legacy provider = ${JSON.stringify(profile.provider)} was normalized to driver`,
        );
      return {
        driver: profile.driver ?? profile.provider!,
        model: profile.model,
        effort: profile.effort,
      };
    };
    return {
      key: input.key,
      repositoryKey: input.repositoryKey,
      defaultBranch: input.defaultBranch,
      sourceControl,
      harness: input.harness,
      agents: {
        guide: normalizeAgent(input.agents.guide),
        builder: normalizeAgent(input.agents.builder),
        reviewer: normalizeAgent(input.agents.reviewer),
      },
      setup: input.setup,
      checks: input.checks,
      normalizationWarnings: [...new Set(warnings)],
    };
  },
);
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

const driverCommon = {
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
};

const driverSchema = z.discriminatedUnion("adapter", [
  z
    .object({
      adapter: z.literal("codex"),
      ...driverCommon,
      home: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      adapter: z.literal("claude"),
      ...driverCommon,
      home: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      adapter: z.literal("external-jsonl-v1"),
      ...driverCommon,
      capabilities: z
        .object({
          workspaceAccess: z
            .array(z.enum(["read-only", "workspace-write"]))
            .min(1),
          runnerControlMcpInjection: z.boolean(),
          projectNativeConfiguration: z.boolean(),
          usageAccuracy: z.enum(["exact", "partial", "none"]),
          hardBudget: z.boolean(),
          processTreeTermination: z.boolean(),
        })
        .strict(),
    })
    .strict(),
]);

const backendSchema = z.discriminatedUnion("adapter", [
  z
    .object({
      adapter: z.literal("git"),
      command: z.string().trim().min(1).default("git"),
    })
    .strict(),
  z
    .object({
      adapter: z.literal("diversion"),
      command: z.string().trim().min(1).default("dv"),
    })
    .strict(),
  z
    .object({
      adapter: z.literal("perforce"),
      command: z.string().trim().min(1).default("p4"),
    })
    .strict(),
]);

const runnerMachineSchema = z
  .object({
    id: z.string().trim().min(1),
    serverUrl: z.string().url(),
    token: z.string().min(1).optional(),
    tokenEnv: environmentVariable.optional(),
    stateDirectory: z
      .string()
      .trim()
      .min(1)
      .default(resolve(homedir(), ".local/state/noriq-runner")),
    scanRoots: z.array(z.string().trim().min(1)).min(1),
    maxConcurrentJobs: z.number().int().min(1).max(32).default(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.token) === Boolean(value.tokenEnv))
      context.addIssue({
        code: "custom",
        path: ["token"],
        message: "configure exactly one of token or tokenEnv",
      });
  });

const machineConfigInputSchema = z
  .object({
    runner: runnerMachineSchema,
    drivers: z.record(registeredId, driverSchema),
    backends: z.record(registeredId, backendSchema).default({
      git: { adapter: "git", command: "git" },
      diversion: { adapter: "diversion", command: "dv" },
      perforce: { adapter: "perforce", command: "p4" },
    }),
  })
  .strict();
export const machineConfigSchema = machineConfigInputSchema.transform(
  (input, context) => {
    const token = input.runner.tokenEnv
      ? process.env[input.runner.tokenEnv]
      : input.runner.token;
    if (!token) {
      context.addIssue({
        code: "custom",
        path: ["runner", "tokenEnv"],
        message: `environment variable ${input.runner.tokenEnv} is not set`,
      });
      return z.NEVER;
    }
    const { tokenEnv: _tokenEnv, ...runner } = input.runner;
    return { ...input, runner: { ...runner, token } };
  },
);
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
