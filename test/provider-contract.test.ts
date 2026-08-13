import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type MachineConfig, projectConfigSchema } from "../src/config.js";
import { CliProviderAdapter } from "../src/providers/process-adapter.js";

const projectConfig = projectConfigSchema.parse({
  key: "RUN",
  repositoryKey: "repo",
  defaultBranch: "main",
  workspace: { mode: "isolated", baseBranch: "main" },
  harness: { maxParallelTasks: 1, maxRepairRounds: 1, maxJobMinutes: 1 },
  agents: {
    guide: { provider: "codex", model: "guide", effort: "high" },
    builder: { provider: "codex", model: "builder", effort: "medium" },
    reviewer: { provider: "codex", model: "reviewer", effort: "high" },
  },
  setup: { commands: [], timeoutSeconds: 30 },
  checks: { commands: [], timeoutSeconds: 30 },
});

async function fakeCodex(root: string): Promise<string> {
  const path = join(root, "fake-codex.mjs");
  await writeFile(
    path,
    `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (process.env.FAKE_ENV_LOG) appendFileSync(process.env.FAKE_ENV_LOG, JSON.stringify({ home: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR }) + '\\n');
if (args.includes('--version')) { console.log('fake-codex 1.0'); process.exit(0); }
if (args.includes('--help')) { console.log('--output-schema --json'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') { console.log('logged in'); process.exit(0); }
if (args[0] === 'mcp' && args[1] === 'list') { console.log(process.env.OMIT_CONTROL ? '[]' : '[{"name":"noriq_runner","enabled":true}]'); process.exit(0); }
const outputIndex = args.indexOf('--output-last-message');
if (process.env.MALFORMED !== '1' && outputIndex >= 0) writeFileSync(args[outputIndex + 1], JSON.stringify({ summary: 'built', findings: [] }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 4 } }));
`,
    { mode: 0o700 },
  );
  await chmod(path, 0o700);
  return path;
}

describe("CLI provider contract", () => {
  it("verifies auth/structured output/control MCP and isolates the provider home", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-provider-"));
    const command = await fakeCodex(root);
    const envLog = join(root, "env.jsonl");
    const providerConfig: NonNullable<MachineConfig["providers"]["codex"]> = {
      command,
      args: [],
      home: join(root, "codex-home"),
      env: { FAKE_ENV_LOG: envLog },
    };
    const adapter = new CliProviderAdapter(
      "codex",
      providerConfig,
      join(root, "state"),
    );
    await expect(adapter.preflight(root, true)).resolves.toMatchObject({
      authenticated: true,
      structuredOutput: true,
      runnerControlVisible: true,
    });
    const result = await adapter.invoke({
      invocationId: "invocation",
      role: "builder",
      taskId: "task",
      taskKey: "RUN-1",
      workspace: root,
      prompt: "build",
      outputSchema: { type: "object" },
      projectConfig,
    });
    expect(result.usage).toMatchObject({
      inputTokens: 12,
      cachedTokens: 3,
      outputTokens: 4,
    });
    const observations = (await readFile(envLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      observations.every(
        (entry) => entry.home === providerConfig.home && !entry.claude,
      ),
    ).toBe(true);
  });

  it("fails closed when the guide control MCP or structured result is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-provider-fail-"));
    const command = await fakeCodex(root);
    const base: NonNullable<MachineConfig["providers"]["codex"]> = {
      command,
      args: [],
      home: join(root, "home"),
      env: { OMIT_CONTROL: "1" },
    };
    const missing = new CliProviderAdapter(
      "codex",
      base,
      join(root, "state-a"),
    );
    await expect(missing.preflight(root, true)).rejects.toThrow(
      /did not expose/,
    );
    const malformed = new CliProviderAdapter(
      "codex",
      {
        ...base,
        env: { MALFORMED: "1" },
      },
      join(root, "state-b"),
    );
    await expect(
      malformed.invoke({
        invocationId: "malformed",
        role: "builder",
        taskId: "task",
        taskKey: "RUN-2",
        workspace: root,
        prompt: "build",
        outputSchema: { type: "object" },
        projectConfig,
      }),
    ).rejects.toThrow();
  });
});
