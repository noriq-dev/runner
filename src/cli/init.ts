import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { authorize } from "../auth/authorize.js";
import { DEFAULT_CREDENTIALS_PATH } from "../auth/credentials.js";
import { discover as discoverOAuth } from "../auth/oauth.js";
import { loadMachineConfig } from "../config.js";
import { discoverProjects } from "../discovery.js";
import { doctorRunner } from "../doctor.js";

export function tomlString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")}"`;
}

async function executable(name: string): Promise<string | null> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

export async function detectExecutables(): Promise<{
  codex: string | null;
  claude: string | null;
  git: string | null;
  diversion: string | null;
  perforce: string | null;
}> {
  const [codex, claude, git, diversion, perforce] = await Promise.all([
    executable("codex"),
    executable("claude"),
    executable("git"),
    executable("dv"),
    executable("p4"),
  ]);
  return { codex, claude, git, diversion, perforce };
}

export function renderMachineConfig(input: {
  label: string;
  serverUrl: string;
  scanRoots: string[];
  stateDirectory: string;
  concurrency: number;
  credentialsFile: string;
  tools: Awaited<ReturnType<typeof detectExecutables>>;
}): string {
  const drivers = [
    input.tools.codex
      ? `\n[drivers.codex]\nadapter = "codex"\ncommand = ${tomlString(input.tools.codex)}\nargs = []\nhome = ${tomlString(join(homedir(), ".noriq", "codex"))}\n`
      : "",
    input.tools.claude
      ? `\n[drivers.claude]\nadapter = "claude"\ncommand = ${tomlString(input.tools.claude)}\nargs = []\nhome = ${tomlString(join(homedir(), ".noriq", "claude"))}\n`
      : "",
  ].join("");
  const backends = [
    input.tools.git
      ? `\n[backends.git]\nadapter = "git"\ncommand = ${tomlString(input.tools.git)}\n`
      : "",
    input.tools.diversion
      ? `\n[backends.diversion]\nadapter = "diversion"\ncommand = ${tomlString(input.tools.diversion)}\n`
      : "",
    input.tools.perforce
      ? `\n[backends.perforce]\nadapter = "perforce"\ncommand = ${tomlString(input.tools.perforce)}\n`
      : "",
  ].join("");
  return `# Noriq Runner machine configuration. Never commit this file.
[runner]
label = ${tomlString(input.label)}
serverUrl = ${tomlString(input.serverUrl)}
stateDirectory = ${tomlString(input.stateDirectory)}
scanRoots = [${input.scanRoots.map(tomlString).join(", ")}]
maxConcurrentJobs = ${input.concurrency}

[auth.noriq]
credentialsFile = ${tomlString(input.credentialsFile)}

[discovery]
intervalSeconds = 60
maxDepth = 6

[memory.indexer]
pollMinutes = 60
maxFiles = 20000
maxFileBytes = 1000000
maxTotalBytes = 100000000
deadlineSeconds = 120

[pricing.openai]
enabled = true
maxStaleHours = 168
${drivers}${backends}`;
}

export async function runInit(options: {
  configPath: string;
  force?: boolean;
  ask?: (question: string, fallback?: string) => Promise<string>;
  out?: (line: string) => void;
  verifyServer?: (server: string) => Promise<void>;
}): Promise<void> {
  if (!options.ask && !process.stdin.isTTY)
    throw new Error("init is interactive and requires a terminal");
  const out = options.out ?? ((line) => process.stdout.write(`${line}\n`));
  const readline = options.ask
    ? null
    : createInterface({ input: process.stdin, output: process.stdout });
  const ask =
    options.ask ??
    (async (question: string, fallback?: string) => {
      const answer = await readline!.question(
        `${question}${fallback ? ` [${fallback}]` : ""}: `,
      );
      return answer.trim() || fallback || "";
    });
  try {
    let exists = false;
    try {
      await readFile(options.configPath, "utf8");
      exists = true;
    } catch {}
    if (exists && !options.force) {
      const overwrite = (
        await ask(`Overwrite ${options.configPath}? (y/N)`, "N")
      ).toLowerCase();
      if (overwrite !== "y" && overwrite !== "yes") {
        out("Existing configuration kept.");
        return;
      }
    }
    const label = await ask(
      "Runner label",
      hostname().split(".")[0] ?? "noriq-runner",
    );
    let serverUrl = await ask("Noriq server URL", "https://noriq.example");
    if (!/^https?:\/\//i.test(serverUrl)) serverUrl = `https://${serverUrl}`;
    serverUrl = serverUrl.replace(/\/+$/, "");
    out(`Checking ${serverUrl}…`);
    await (
      options.verifyServer ??
      (async (server) => void (await discoverOAuth(server)))
    )(serverUrl);
    const roots = (
      await ask(
        "Repository scan roots (comma-separated)",
        join(homedir(), "git"),
      )
    )
      .split(",")
      .map((entry) => resolve(entry.trim().replace(/^~(?=\/)/, homedir())))
      .filter(Boolean);
    const concurrency = Math.max(
      1,
      Number.parseInt(await ask("Maximum concurrent jobs", "2"), 10) || 1,
    );
    const stateDirectory = join(homedir(), ".local", "state", "noriq-runner");
    const tools = await detectExecutables();
    await mkdir(dirname(options.configPath), { recursive: true, mode: 0o700 });
    await writeFile(
      options.configPath,
      renderMachineConfig({
        label,
        serverUrl,
        scanRoots: roots,
        stateDirectory,
        concurrency,
        credentialsFile: DEFAULT_CREDENTIALS_PATH,
        tools,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    if (process.platform !== "win32") await chmod(options.configPath, 0o600);
    out(`Wrote ${options.configPath}`);
    await authorize({ server: serverUrl, out });
    const config = await loadMachineConfig(options.configPath);
    const projects = await discoverProjects(
      config.runner.scanRoots,
      config.discovery.maxDepth,
    );
    out(`Discovered ${projects.length} configured repository checkout(s).`);
    const doctor = await doctorRunner(config);
    out(
      `Drivers ready: ${doctor.drivers.filter((driver) => driver.authenticated).length}/${doctor.drivers.length}`,
    );
  } finally {
    readline?.close();
  }
}
