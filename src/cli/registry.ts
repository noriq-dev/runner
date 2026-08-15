export interface CommandSpec {
  name: string;
  summary: string;
  flags: readonly string[];
  values?: Readonly<Record<string, readonly string[]>>;
}

export const GLOBAL_FLAGS = ["--config", "--help", "-h"] as const;

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "init",
    summary: "Guided machine configuration and authentication",
    flags: ["--force"],
  },
  {
    name: "auth",
    summary: "Authenticate Noriq, Codex, or Claude under Runner-owned homes",
    flags: ["--browser", "--device", "--reauth", "--server"],
    values: {
      target: ["noriq", "codex", "claude", "status"],
      statusTarget: ["noriq", "codex", "claude", "all"],
    },
  },
  { name: "start", summary: "Start the Runner daemon", flags: [] },
  {
    name: "validate",
    summary: "Validate machine configuration without connecting",
    flags: [],
  },
  {
    name: "doctor",
    summary: "Check repositories, VCS backends, and agent drivers",
    flags: [],
  },
  {
    name: "discover",
    summary: "Scan configured roots and list repository checkouts",
    flags: ["--json"],
  },
  {
    name: "usage",
    summary: "Show durable usage for one job",
    flags: ["--state-directory", "--job"],
  },
  {
    name: "index-repo",
    summary: "Preview the current repository index locally",
    flags: ["--path", "--check-determinism", "--json"],
  },
  {
    name: "index-status",
    summary: "Show durable repository-index status",
    flags: ["--path", "--json"],
  },
  {
    name: "index-reindex",
    summary: "Request an immediate repository reindex",
    flags: ["--path"],
  },
  {
    name: "index-cancel",
    summary: "Cancel an active repository-index operation",
    flags: ["--path"],
  },
  {
    name: "completion",
    summary: "Print the Bash completion script",
    flags: [],
    values: { shell: ["bash"] },
  },
  { name: "version", summary: "Print the installed Runner version", flags: [] },
  { name: "help", summary: "Show this help", flags: [] },
] as const;

export const COMMAND_NAMES = COMMANDS.map((command) => command.name);

export function commandSpec(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name === name);
}

export function formatHelp(): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length)) + 3;
  return `noriq-runner <command> [options]\n\nCommands:\n${COMMANDS.map(
    (command) => `  ${command.name.padEnd(width)}${command.summary}`,
  ).join(
    "\n",
  )}\n\nGlobal options:\n  --config <path>  Machine configuration\n  --help, -h       Show command help\n`;
}

export function formatCommandHelp(name: string): string {
  const spec = commandSpec(name);
  if (!spec) throw new Error(`unknown command ${name}`);
  const positional = Object.entries(spec.values ?? {}).flatMap(
    ([key, values]) =>
      key === "target" || key === "shell"
        ? [`  ${key.padEnd(14)}${values.join(" | ")}`]
        : [],
  );
  const flags = [...GLOBAL_FLAGS, ...spec.flags].filter(
    (flag, index, values) => values.indexOf(flag) === index,
  );
  const optionLines = flags.map(
    (flag) => `  ${flag}${VALUE_FLAGS.has(flag) ? " <value>" : ""}`,
  );
  return `noriq-runner ${name} [options]\n\n${spec.summary}\n${
    positional.length > 0 ? `\nArguments:\n${positional.join("\n")}\n` : ""
  }${optionLines.length > 0 ? `\nOptions:\n${optionLines.join("\n")}\n` : ""}`;
}

export const VALUE_FLAGS = new Set([
  "--config",
  "--server",
  "--state-directory",
  "--job",
  "--path",
]);
export const FILE_SENTINEL = "__noriq_files__";

export function completionCandidates(words: string[]): string[] {
  const current = words.at(-1) ?? "";
  const prior = words.slice(0, -1);
  const previous = prior.at(-1);
  if (previous === "--config" || previous === "--path") return [FILE_SENTINEL];
  if (previous && VALUE_FLAGS.has(previous)) return [];
  const commandName = prior.find((word) => !word.startsWith("-"));
  const spec = commandName ? commandSpec(commandName) : undefined;
  if (!spec)
    return [...COMMAND_NAMES, "--version", ...GLOBAL_FLAGS].filter(
      (value, index, values) =>
        values.indexOf(value) === index && value.startsWith(current),
    );
  if (spec.name === "auth" && prior.length === 1 && !current.startsWith("-"))
    return [...(spec.values?.target ?? [])].filter((value) =>
      value.startsWith(current),
    );
  if (spec.name === "auth" && prior[1] === "status" && prior.length === 2)
    return [...(spec.values?.statusTarget ?? [])].filter((value) =>
      value.startsWith(current),
    );
  if (spec.name === "completion" && prior.length === 1)
    return [...(spec.values?.shell ?? [])].filter((value) =>
      value.startsWith(current),
    );
  return [...GLOBAL_FLAGS, ...spec.flags].filter((value) =>
    value.startsWith(current),
  );
}

export function validateCommandArgs(name: string, args: string[]): void {
  const spec = commandSpec(name);
  if (!spec) throw new Error(`unknown command ${name}`);
  const flags = new Set([...GLOBAL_FLAGS, ...spec.flags]);
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("-")) {
      positional.push(value);
      continue;
    }
    if (!flags.has(value))
      throw new Error(`unknown option ${value} for ${name}`);
    if (VALUE_FLAGS.has(value)) {
      const argument = args[index + 1];
      if (!argument || argument.startsWith("-"))
        throw new Error(`${value} requires a value`);
      index += 1;
    }
  }
  if (name === "auth") {
    const target = positional[0] ?? "status";
    if (!(spec.values?.target ?? []).includes(target))
      throw new Error(`invalid auth target ${target}`);
    if (
      target === "status" &&
      positional[1] &&
      !(spec.values?.statusTarget ?? []).includes(positional[1])
    )
      throw new Error(`invalid auth status target ${positional[1]}`);
    if (positional.length > (target === "status" ? 2 : 1))
      throw new Error("too many auth arguments");
    const noriqOnly = ["--browser", "--reauth", "--server"].find((flag) =>
      args.includes(flag),
    );
    if (noriqOnly && target !== "noriq")
      throw new Error(`${noriqOnly} is only valid for auth noriq`);
    if (args.includes("--device") && !["noriq", "codex"].includes(target))
      throw new Error(`--device is not valid for auth ${target}`);
    return;
  }
  if (name === "completion") {
    if (
      positional.length > 1 ||
      (positional[0] && !(spec.values?.shell ?? []).includes(positional[0]))
    )
      throw new Error("completion shell must be bash");
    return;
  }
  if (positional.length > 0)
    throw new Error(`${name} does not accept positional arguments`);
}
