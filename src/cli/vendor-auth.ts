import { spawn } from "node:child_process";
import { prepareAgentHome } from "../agent-home.js";
import type { MachineConfig } from "../config.js";

function configuredDriver(config: MachineConfig, adapter: "codex" | "claude") {
  const entry = Object.values(config.drivers).find(
    (driver) => driver.adapter === adapter,
  );
  if (!entry || entry.adapter !== adapter)
    throw new Error(`no ${adapter} driver is configured`);
  return entry;
}

function interactive(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${command} authentication exited with ${signal ?? code ?? "unknown"}`,
          ),
        );
    });
  });
}

function environment(
  home: string,
  adapter: "codex" | "claude",
  configured: Record<string, string>,
) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    ...configured,
    ...(adapter === "codex"
      ? { CODEX_HOME: home }
      : { CLAUDE_CONFIG_DIR: home }),
  } satisfies NodeJS.ProcessEnv;
}

export async function authenticateVendor(
  config: MachineConfig,
  adapter: "codex" | "claude",
  device = false,
): Promise<void> {
  const driver = configuredDriver(config, adapter);
  const home = await prepareAgentHome(driver.home);
  const args =
    adapter === "codex"
      ? [...driver.args, "login", ...(device ? ["--device-auth"] : [])]
      : [...driver.args, "auth", "login"];
  await interactive(
    driver.command,
    args,
    environment(home, adapter, driver.env),
  );
}

export async function vendorStatus(
  config: MachineConfig,
  adapter: "codex" | "claude",
): Promise<{ configured: boolean; authenticated: boolean; detail: string }> {
  let driver: ReturnType<typeof configuredDriver>;
  try {
    driver = configuredDriver(config, adapter);
  } catch {
    return {
      configured: false,
      authenticated: false,
      detail: "not configured",
    };
  }
  const home = await prepareAgentHome(driver.home);
  const args =
    adapter === "codex"
      ? [...driver.args, "login", "status"]
      : [...driver.args, "auth", "status", "--json"];
  return new Promise((resolve) => {
    const child = spawn(driver.command, args, {
      cwd: process.cwd(),
      env: environment(home, adapter, driver.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("error", (error) =>
      resolve({
        configured: true,
        authenticated: false,
        detail: error.message,
      }),
    );
    child.once("exit", (code) =>
      resolve({
        configured: true,
        authenticated: code === 0,
        detail:
          output.replace(/\s+/g, " ").trim().slice(0, 300) || `exit ${code}`,
      }),
    );
  });
}
