#!/usr/bin/env node
import { resolve } from "node:path";
import { loadMachineConfig } from "./config.js";
import { runDaemon } from "./daemon.js";

async function main(): Promise<void> {
  const [command = "start", ...args] = process.argv.slice(2);
  if (command === "control-mcp") {
    await import("./control-mcp.js");
    return;
  }
  if (command !== "start") throw new Error(`unknown command ${command}`);
  const configIndex = args.indexOf("--config");
  const configPath = resolve(
    configIndex >= 0 ? (args[configIndex + 1] ?? "runner.toml") : "runner.toml",
  );
  await runDaemon(await loadMachineConfig(configPath));
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
