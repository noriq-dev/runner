import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "noriq-runner-built-"));

async function collect(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  return { exitCode, stdout, stderr };
}

try {
  const expectedVersion = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ).version;
  const reportedVersion = await collect(
    spawn(process.execPath, [join(root, "dist/cli.js"), "version"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  if (
    reportedVersion.exitCode !== 0 ||
    reportedVersion.stdout.trim() !== expectedVersion
  )
    throw new Error(`built CLI version failed: ${reportedVersion.stderr}`);
  const reportedHelp = await collect(
    spawn(process.execPath, [join(root, "dist/cli.js"), "help"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  if (
    reportedHelp.exitCode !== 0 ||
    !reportedHelp.stdout.includes("noriq-runner <command>")
  )
    throw new Error(`built CLI help failed: ${reportedHelp.stderr}`);

  const config = join(temporary, "runner.toml");
  await writeFile(
    config,
    `[runner]\nid = "built-smoke"\nserverUrl = "https://example.test"\ntoken = "not-a-real-token"\nstateDirectory = ${JSON.stringify(join(temporary, "state"))}\nscanRoots = [${JSON.stringify(root)}]\nmaxConcurrentJobs = 1\n\n[drivers.fake]\nadapter = "external-jsonl-v1"\ncommand = "/usr/bin/false"\nargs = []\n[drivers.fake.capabilities]\nworkspaceAccess = ["read-only", "workspace-write"]\nrunnerControlMcpInjection = true\nprojectNativeConfiguration = true\nusageAccuracy = "none"\nhardBudget = false\nprocessTreeTermination = true\n\n[backends.git]\nadapter = "git"\ncommand = "/usr/bin/git"\n`,
    { mode: 0o600 },
  );
  const validation = await collect(
    spawn(
      process.execPath,
      [join(root, "dist/cli.js"), "validate", "--config", config],
      {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  if (validation.exitCode !== 0 || !validation.stdout.includes('"valid":true'))
    throw new Error(`built CLI validation failed: ${validation.stderr}`);

  const control = spawn(process.execPath, [join(root, "dist/control-mcp.js")], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  control.stdin.end(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
  );
  const response = await collect(control);
  if (
    response.exitCode !== 0 ||
    !response.stdout.includes('"name":"noriq-runner-control"')
  )
    throw new Error(`built Control MCP smoke failed: ${response.stderr}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
