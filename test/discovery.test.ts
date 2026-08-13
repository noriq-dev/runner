import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { discoverProjects } from "../src/discovery.js";
import { runProcess } from "../src/process.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function repository(key: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "noriq-discovery-"));
  roots.push(root);
  await runProcess({
    command: "git",
    args: ["init", "-q"],
    cwd: root,
    timeoutMs: 10_000,
  });
  await mkdir(join(root, ".noriq"));
  await writeFile(
    join(root, ".noriq", "project.toml"),
    `key = "${key}"
repositoryKey = "repo-${key.toLowerCase()}"
defaultBranch = "main"

[workspace]
mode = "isolated"
baseBranch = "main"

[harness]
maxParallelTasks = 1
maxRepairRounds = 2
maxJobMinutes = 60

[agents.guide]
provider = "fake"
model = "guide"
effort = "high"

[agents.builder]
driver = "fake"
model = "builder"
effort = "medium"

[agents.reviewer]
driver = "fake"
model = "reviewer"
effort = "high"

[setup]
commands = []
timeoutSeconds = 60

[checks]
commands = []
timeoutSeconds = 60
`,
  );
  return root;
}

describe("discoverProjects", () => {
  test("resolves Git from the manifest directory and discovers multiple roots", async () => {
    const first = await repository("ONE");
    const second = await repository("TWO");

    const projects = await discoverProjects([first, second]);

    expect(projects).toHaveLength(2);
    expect(projects.map((project) => project.repository)).toEqual([
      first,
      second,
    ]);
    expect(projects.map((project) => project.config.repositoryKey)).toEqual([
      "repo-one",
      "repo-two",
    ]);
    expect(projects[0]!.config.agents.guide.driver).toBe("fake");
    expect(projects[0]!.config.normalizationWarnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("legacy [workspace]"),
        expect.stringContaining("legacy provider"),
      ]),
    );
  });
});
