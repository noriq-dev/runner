import type { MachineConfig } from "../config.js";
import { BuiltinCliAgentDriver } from "./cli-adapter.js";

type ClaudeConfig = Extract<
  MachineConfig["drivers"][string],
  { adapter: "claude" }
>;

/** Claude protocol translation. Vendor policy stays in this adapter. */
export class ClaudeAgentDriver extends BuiltinCliAgentDriver {
  constructor(id: string, config: ClaudeConfig, stateDirectory: string) {
    super("claude", config, stateDirectory, id);
  }
}
