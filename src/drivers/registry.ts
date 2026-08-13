import type { MachineConfig } from "../config.js";
import { ClaudeAgentDriver } from "./claude.js";
import { CodexAgentDriver } from "./codex.js";
import { ExternalJsonlV1Driver } from "./external.js";
import type { AgentDriver } from "./types.js";

export function createDriverRegistry(
  config: MachineConfig,
): Record<string, AgentDriver> {
  return Object.fromEntries(
    Object.entries(config.drivers).map(([id, driver]) => {
      if (driver.adapter === "codex")
        return [
          id,
          new CodexAgentDriver(id, driver, config.runner.stateDirectory),
        ];
      if (driver.adapter === "claude")
        return [
          id,
          new ClaudeAgentDriver(id, driver, config.runner.stateDirectory),
        ];
      return [
        id,
        new ExternalJsonlV1Driver(id, driver, config.runner.stateDirectory),
      ];
    }),
  );
}
