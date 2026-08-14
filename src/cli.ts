#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadMachineConfig } from "./config.js";
import { runDaemon } from "./daemon.js";
import { doctorRunner } from "./doctor.js";
import { loadDurableJobState } from "./supervisor.js";

function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const help = `noriq-runner <command> [options]

Commands:
  start       Start the Runner daemon
  validate    Validate machine configuration without connecting
  doctor      Check repositories, VCS backends, and agent drivers
  usage       Show durable usage for one job
  version     Print the installed Runner version
  help        Show this help

Options:
  --config <path>           Machine configuration (default: runner.toml)
  --state-directory <path> State directory for usage
  --job <id>                Job ID for usage
`;

async function version(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof manifest.version !== "string" || manifest.version.length === 0)
    throw new Error("package.json does not contain a valid version");
  return manifest.version;
}

async function main(): Promise<void> {
  const [command = "start", ...args] = process.argv.slice(2);
  if (command === "version" || command === "--version" || command === "-v") {
    process.stdout.write(`${await version()}\n`);
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(help);
    return;
  }
  if (command === "control-mcp") {
    await import("./control-mcp.js");
    return;
  }
  if (command === "usage") {
    const stateDirectory = argument(args, "--state-directory");
    const jobId = argument(args, "--job");
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
  if (!new Set(["start", "validate", "doctor"]).has(command))
    throw new Error(`unknown command ${command}; run noriq-runner help`);
  const configPath = resolve(argument(args, "--config") ?? "runner.toml");
  const config = await loadMachineConfig(configPath);
  if (command === "validate") {
    process.stdout.write(
      `${JSON.stringify({
        valid: true,
        runnerId: config.runner.id ?? null,
        serverUrl: config.runner.serverUrl,
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
  await runDaemon(config);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
