#!/usr/bin/env node
import { resolve } from "node:path";
import { loadMachineConfig } from "./config.js";
import { runDaemon } from "./daemon.js";
import { doctorRunner } from "./doctor.js";
import { loadDurableJobState } from "./supervisor.js";

function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const [command = "start", ...args] = process.argv.slice(2);
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
    throw new Error(`unknown command ${command}`);
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
