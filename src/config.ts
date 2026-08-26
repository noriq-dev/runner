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

const agentEffortSchema = z.enum([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

const agentProfileSchema = z
  .object({
    driver: registeredId.optional(),
    provider: registeredId.optional(),
    model: z.string().trim().min(1).max(200),
    effort: agentEffortSchema,
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

const tieredAgentProfilesSchema = z
  .object({
    economy: agentProfileSchema.optional(),
    balanced: agentProfileSchema,
    strong: agentProfileSchema.optional(),
  })
  .strict();

const agentRoleSchema = z.union([
  agentProfileSchema,
  tieredAgentProfilesSchema,
]);

const pathPrefixSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !/(^|\/)\.\.(\/|$)/.test(value),
    "must be a repository-relative path prefix using / separators",
  )
  .transform((value) => value.replace(/\/+$/, ""));

/**
 * Per-submodule policy, because submodules mean different things inside one
 * repository: a vendored dependency and an actively-developed sibling library
 * carry different risk. "pinned" populates and refuses any change, "follow"
 * lets the gitlink advance to a commit that already exists upstream, and
 * "develop" lets agents author commits inside the submodule.
 */
const submodulePolicySchema = z.enum(["pinned", "follow", "develop"]);

const submoduleEntrySchema = z
  .object({
    policy: submodulePolicySchema.optional(),
    // Branch inside the SUBMODULE that its work follows or lands on.
    target: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const submodulesSchema = z
  .object({
    enabled: z.boolean().default(true),
    init: z.enum(["recursive", "top-level", "none"]).default("recursive"),
    policy: submodulePolicySchema.default("pinned"),
    paths: z.record(z.string().trim().min(1), submoduleEntrySchema).default({}),
  })
  .strict();

const sourceControlSchema = z
  .object({
    backend: registeredId.or(z.literal("auto")).default("auto"),
    mode: z.enum(["isolated", "direct"]).default("isolated"),
    base: z.string().trim().min(1).max(500),
    target: z.string().trim().min(1).max(500).optional(),
    landing: z.enum(["retain", "manual", "auto"]).default("retain"),
    submodules: submodulesSchema.optional(),
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
        guide: agentRoleSchema,
        builder: agentRoleSchema,
        reviewer: agentRoleSchema,
        repairer: agentRoleSchema.optional(),
      })
      .strict(),
    routing: z
      .object({
        elevatedPathPrefixes: z.array(pathPrefixSchema).max(200).default([]),
        criticalPathPrefixes: z.array(pathPrefixSchema).max(200).default([]),
      })
      .strict()
      .default({ elevatedPathPrefixes: [], criticalPathPrefixes: [] }),
    memory: z
      .object({
        context: z
          .object({
            enabled: z.boolean().default(true),
            tokenBudget: z.number().int().min(256).max(16_000).default(1_500),
          })
          .strict()
          .default({ enabled: true, tokenBudget: 1_500 }),
      })
      .strict()
      .default({ context: { enabled: true, tokenBudget: 1_500 } }),
    index: z
      .object({
        enabled: z.boolean().default(false),
        include: z
          .array(z.string().trim().min(1).max(500))
          .max(500)
          .default([]),
        exclude: z
          .array(z.string().trim().min(1).max(500))
          .max(500)
          .default([]),
      })
      .strict()
      .default({ enabled: false, include: [], exclude: [] }),
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
          landing: "retain" as const,
          // Legacy [workspace] predates submodules; unmanaged is correct, and
          // stating it keeps both arms of this union the same shape.
          submodules: undefined as SubmodulesConfig | undefined,
          ...(input.workspace!.directBranch
            ? { target: input.workspace!.directBranch }
            : {}),
        };
      })();
    if (sourceControl.mode === "direct" && !sourceControl.target)
      throw new Error("sourceControl.target is required in direct mode");
    if (
      sourceControl.mode === "isolated" &&
      sourceControl.landing !== "retain" &&
      !sourceControl.target
    )
      throw new Error(
        "sourceControl.target is required when isolated output will be landed",
      );
    if (sourceControl.mode === "direct" && sourceControl.landing !== "retain")
      throw new Error(
        "sourceControl.landing must be retain in direct mode because accepted work is already committed to the target",
      );
    const normalizeAgent = (profile: z.infer<typeof agentProfileSchema>) => {
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
    const normalizeRole = (
      role: z.infer<typeof agentRoleSchema>,
      name: "guide" | "builder" | "reviewer" | "repairer",
    ) => {
      if ("model" in role) {
        warnings.push(
          `legacy [agents.${name}] profile was normalized across economy, balanced, and strong tiers`,
        );
        const profile = normalizeAgent(role);
        return { economy: profile, balanced: profile, strong: profile };
      }
      const balanced = normalizeAgent(role.balanced);
      return {
        economy: role.economy ? normalizeAgent(role.economy) : balanced,
        balanced,
        strong: role.strong ? normalizeAgent(role.strong) : balanced,
      };
    };
    const builder = normalizeRole(input.agents.builder, "builder");
    return {
      key: input.key,
      repositoryKey: input.repositoryKey,
      defaultBranch: input.defaultBranch,
      sourceControl,
      harness: input.harness,
      agents: {
        guide: normalizeRole(input.agents.guide, "guide"),
        builder,
        reviewer: normalizeRole(input.agents.reviewer, "reviewer"),
        repairer: input.agents.repairer
          ? normalizeRole(input.agents.repairer, "repairer")
          : builder,
      },
      routing: input.routing,
      memory: input.memory,
      index: input.index,
      setup: input.setup,
      checks: input.checks,
      normalizationWarnings: [...new Set(warnings)],
    };
  },
);
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type SubmodulePolicy = z.infer<typeof submodulePolicySchema>;
export type SubmodulesConfig = z.infer<typeof submodulesSchema>;

/**
 * The policy governing one submodule path, or null when this project does not
 * manage submodules at all. An unlisted path resolves to the project default,
 * so a repository only needs an entry for a submodule that differs from it.
 */
export function submodulePolicyFor(
  config: SubmodulesConfig | undefined,
  path: string,
): SubmodulePolicy | null {
  if (!config || !config.enabled) return null;
  return config.paths[path]?.policy ?? config.policy;
}

/** The submodule's own branch this path follows or lands on, when configured. */
export function submoduleTargetFor(
  config: SubmodulesConfig | undefined,
  path: string,
): string | null {
  if (!config || !config.enabled) return null;
  return config.paths[path]?.target ?? null;
}

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
      vendor: registeredId.optional(),
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
      // "shared" keeps every job and task inside the one existing checkout,
      // switching branches in place. "per-task" gives each job and each task
      // its own `dv clone --new-workspace`, which is what lets tasks build
      // concurrently — at the cost of a full sync per workspace, which is why
      // it is opt-in rather than the default (RUN-53 records the cost concern).
      workspaces: z.enum(["shared", "per-task"]).default("shared"),
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
    id: z.string().trim().min(1).optional(),
    label: z.string().trim().min(1).max(200).default("Noriq Runner"),
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
    if (value.token && value.tokenEnv)
      context.addIssue({
        code: "custom",
        path: ["token"],
        message: "configure at most one of token or tokenEnv",
      });
  });

const machineConfigInputSchema = z
  .object({
    runner: runnerMachineSchema,
    auth: z
      .object({
        noriq: z
          .object({
            credentialsFile: z.string().trim().min(1).optional(),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({ noriq: {} }),
    discovery: z
      .object({
        intervalSeconds: z.number().int().min(5).max(86_400).default(60),
        maxDepth: z.number().int().min(0).max(32).default(6),
      })
      .strict()
      .default({ intervalSeconds: 60, maxDepth: 6 }),
    memory: z
      .object({
        indexer: z
          .object({
            pollMinutes: z.number().int().min(1).max(10_080).default(60),
            maxFiles: z.number().int().min(1).max(1_000_000).default(20_000),
            maxFileBytes: z
              .number()
              .int()
              .min(1_024)
              .max(100_000_000)
              .default(1_000_000),
            maxTotalBytes: z
              .number()
              .int()
              .min(1_024)
              .max(2_000_000_000)
              .default(100_000_000),
            deadlineSeconds: z.number().int().min(10).max(86_400).default(120),
          })
          .strict()
          .default({
            pollMinutes: 60,
            maxFiles: 20_000,
            maxFileBytes: 1_000_000,
            maxTotalBytes: 100_000_000,
            deadlineSeconds: 120,
          }),
      })
      .strict()
      .default({
        indexer: {
          pollMinutes: 60,
          maxFiles: 20_000,
          maxFileBytes: 1_000_000,
          maxTotalBytes: 100_000_000,
          deadlineSeconds: 120,
        },
      }),
    drivers: z.record(registeredId, driverSchema),
    backends: z.record(registeredId, backendSchema).default({
      git: { adapter: "git", command: "git" },
      diversion: { adapter: "diversion", command: "dv", workspaces: "shared" },
      perforce: { adapter: "perforce", command: "p4" },
    }),
    pricing: z
      .object({
        openai: z
          .object({
            enabled: z.boolean().default(true),
            maxStaleHours: z.number().int().min(0).max(168).default(168),
          })
          .strict()
          .default({ enabled: true, maxStaleHours: 168 }),
      })
      .strict()
      .default({ openai: { enabled: true, maxStaleHours: 168 } }),
  })
  .strict();
export const machineConfigSchema = machineConfigInputSchema.transform(
  (input, context) => {
    const token = input.runner.tokenEnv
      ? process.env[input.runner.tokenEnv]
      : input.runner.token;
    if (input.runner.tokenEnv && !token) {
      context.addIssue({
        code: "custom",
        path: ["runner", "tokenEnv"],
        message: `environment variable ${input.runner.tokenEnv} is not set`,
      });
      return z.NEVER;
    }
    const { tokenEnv: _tokenEnv, ...runner } = input.runner;
    return {
      ...input,
      runner: {
        ...runner,
        ...(token ? { token } : {}),
        tokenSource: token
          ? input.runner.tokenEnv
            ? "environment"
            : "literal"
          : "oauth",
      },
    };
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
