import type { MachineConfig } from "../config.js";
import { BuiltinCliAgentDriver } from "./cli-adapter.js";

type CodexConfig = Extract<
  MachineConfig["drivers"][string],
  { adapter: "codex" }
>;

/** Codex protocol translation. Vendor policy stays in this adapter. */
export class CodexAgentDriver extends BuiltinCliAgentDriver {
  constructor(id: string, config: CodexConfig, stateDirectory: string) {
    super("codex", config, stateDirectory, id);
  }
}
