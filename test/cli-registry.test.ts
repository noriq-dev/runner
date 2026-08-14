import { describe, expect, test } from "vitest";
import { bashCompletion } from "../src/cli/completion.js";
import {
  COMMANDS,
  completionCandidates,
  formatHelp,
  validateCommandArgs,
} from "../src/cli/registry.js";

describe("CLI registry", () => {
  test("drives help and completion from one command inventory", () => {
    const help = formatHelp();
    const candidates = completionCandidates([""]);
    for (const command of COMMANDS) {
      expect(help).toContain(command.name);
      expect(candidates).toContain(command.name);
    }
    expect(completionCandidates(["auth", ""])).toEqual(
      expect.arrayContaining(["noriq", "codex", "claude", "status"]),
    );
    expect(completionCandidates(["auth", "status", ""])).toEqual(
      expect.arrayContaining(["noriq", "codex", "claude", "all"]),
    );
    expect(bashCompletion()).toContain("noriq-runner __complete");
    expect(() => validateCommandArgs("auth", ["status", "all"])).not.toThrow();
    expect(() => validateCommandArgs("start", ["--bogus"])).toThrow(
      /unknown option/,
    );
    expect(() => validateCommandArgs("auth", ["noriq", "--server"])).toThrow(
      /requires a value/,
    );
  });
});
