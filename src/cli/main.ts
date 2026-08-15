#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type AuthorizationMode, authorize } from "../auth/authorize.js";
import { createTokenProvider } from "../auth/token-provider.js";
import { loadMachineConfig } from "../config.js";
import { runDaemon } from "../daemon.js";
import { discoverProjects } from "../discovery.js";
import { doctorRunner } from "../doctor.js";
import { loadDurableJobState } from "../supervisor.js";
import { bashCompletion } from "./completion.js";
import { absolute, option, resolveConfigPath } from "./config-path.js";
import { runInit } from "./init.js";
import {
  COMMAND_NAMES,
  completionCandidates,
  formatCommandHelp,
  formatHelp,
  validateCommandArgs,
} from "./registry.js";
import { authenticateVendor, vendorStatus } from "./vendor-auth.js";

async function version(): Promise<string> {
  let raw: string | null = null;
  for (const relative of ["../package.json", "../../package.json"]) {
    try {
      raw = await readFile(new URL(relative, import.meta.url), "utf8");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (!raw) throw new Error("package.json could not be located");
  const manifest = JSON.parse(raw) as { version?: unknown };
  if (typeof manifest.version !== "string" || !manifest.version)
    throw new Error("package.json contains no version");
  return manifest.version;
}

function commandArgs(args: string[]): string[] {
  const configIndex = args.indexOf("--config");
  if (configIndex < 0) return args;
  return args.filter(
    (_value, index) => index !== configIndex && index !== configIndex + 1,
  );
}

async function authCommand(args: string[], configPath: string): Promise<void> {
  const [target = "status", ...rest] = commandArgs(args);
  const config = await loadMachineConfig(configPath);
  if (target === "noriq") {
    const mode: AuthorizationMode = rest.includes("--device")
      ? "device"
      : rest.includes("--browser")
        ? "browser"
        : "auto";
    const server = option(rest, "--server") ?? config.runner.serverUrl;
    await authorize({
      server,
      mode,
      ...(config.auth.noriq.credentialsFile
        ? { credentialsPath: config.auth.noriq.credentialsFile }
        : {}),
      out: (line) => process.stdout.write(`${line}\n`),
    });
    if (config.runner.tokenSource !== "oauth")
      process.stderr.write(
        "Warning: runner.token or runner.tokenEnv takes precedence over stored OAuth credentials.\n",
      );
    return;
  }
  if (target === "codex" || target === "claude") {
    await authenticateVendor(config, target, rest.includes("--device"));
    return;
  }
  if (target !== "status")
    throw new Error("auth target must be noriq, codex, claude, or status");
  const requested =
    rest.find((value) => ["noriq", "codex", "claude", "all"].includes(value)) ??
    "all";
  const status: Record<string, unknown> = {};
  if (requested === "all" || requested === "noriq")
    status.noriq = await createTokenProvider(config).status();
  if (requested === "all" || requested === "codex")
    status.codex = await vendorStatus(config, "codex");
  if (requested === "all" || requested === "claude")
    status.claude = await vendorStatus(config, "claude");
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
}

async function main(): Promise<void> {
  const [command = "start", ...args] = process.argv.slice(2);
  if (command === "__complete") {
    process.stdout.write(`${completionCandidates(args).join("\n")}\n`);
    return;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    if (command === "version") validateCommandArgs(command, args);
    process.stdout.write(`${await version()}\n`);
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    if (command === "help" && args.length > 0) {
      if (args.length > 1)
        throw new Error("help accepts at most one command name");
      process.stdout.write(formatCommandHelp(args[0]!));
    } else {
      if (command === "help") validateCommandArgs(command, args);
      process.stdout.write(formatHelp());
    }
    return;
  }
  if (command === "control-mcp") {
    await import("../control-mcp.js");
    return;
  }
  if (!COMMAND_NAMES.includes(command))
    throw new Error(`unknown command ${command}; run noriq-runner help`);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(formatCommandHelp(command));
    return;
  }
  validateCommandArgs(command, args);
  if (command === "completion") {
    if ((args[0] ?? "bash") !== "bash")
      throw new Error("only Bash completion is currently supported");
    process.stdout.write(bashCompletion());
    return;
  }
  const configPath = await resolveConfigPath(args);
  if (command === "init") {
    await runInit({ configPath, force: args.includes("--force") });
    return;
  }
  if (command === "auth") {
    await authCommand(args, configPath);
    return;
  }
  if (command === "usage") {
    const stateDirectory = option(args, "--state-directory");
    const jobId = option(args, "--job");
    if (!stateDirectory || !jobId)
      throw new Error(
        "usage requires --state-directory <path> and --job <job-id>",
      );
    const state = await loadDurableJobState(resolve(stateDirectory), jobId);
    if (!state) throw new Error(`no durable state found for job ${jobId}`);
    process.stdout.write(
      `${JSON.stringify(
        {
          jobId,
          status: state.status,
          total: state.usage,
          invocations: Object.values(state.invocations).map((invocation) => ({
            id: invocation.id,
            taskId: invocation.taskId,
            role: invocation.role,
            status: invocation.status,
            usage: invocation.usage ?? null,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const config = await loadMachineConfig(configPath);
  if (command === "validate") {
    process.stdout.write(
      `${JSON.stringify({
        valid: true,
        runnerId: config.runner.id ?? null,
        serverUrl: config.runner.serverUrl,
        tokenSource: config.runner.tokenSource,
        drivers: Object.keys(config.drivers).sort(),
        backends: Object.keys(config.backends).sort(),
        scanRoots: config.runner.scanRoots,
      })}\n`,
    );
    return;
  }
  if (command === "doctor") {
    process.stdout.write(
      `${JSON.stringify(await doctorRunner(config), null, 2)}\n`,
    );
    return;
  }
  if (command === "discover") {
    const projects = await discoverProjects(
      config.runner.scanRoots,
      config.discovery.maxDepth,
    );
    const output = projects.map((project) => ({
      checkoutId: project.checkoutId,
      repositoryKey: project.config.repositoryKey,
      projectKey: project.config.key,
      repository: project.repository,
      vcs: project.vcs,
      configPath: project.configPath,
    }));
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }
  if (command.startsWith("index-")) {
    const operator = await import("../memory/index/operator.js");
    await operator.runIndexCommand(command, {
      config,
      path: absolute(option(args, "--path") ?? process.cwd()),
      json: args.includes("--json"),
      checkDeterminism: args.includes("--check-determinism"),
    });
    return;
  }
  await runDaemon(config);
}

export function runCli(): void {
  void main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
