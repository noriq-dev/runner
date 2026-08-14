import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { projectConfigSchema } from "../src/config.js";
import { encodeBatches } from "../src/memory/index/batch.js";
import { scanIndex } from "../src/memory/index/scan.js";
import {
  DiversionIndexSource,
  FilesystemIndexSource,
  GitIndexSource,
  PerforceIndexSource,
} from "../src/memory/index/source.js";
import { runProcess } from "../src/process.js";

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("repository index scanner", () => {
  test("is deterministic and never admits sensitive or generated files", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-index-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "src", "a.ts"), "export const value = 'ok';\n");
    await writeFile(join(root, ".env"), "TOKEN=secret\n");
    await writeFile(join(root, "node_modules", "bad.ts"), "secret\n");
    const project = projectConfigSchema.parse({
      key: "TEST",
      repositoryKey: "test",
      defaultBranch: "main",
      sourceControl: {
        backend: "auto",
        mode: "isolated",
        base: "main",
        landing: "retain",
      },
      harness: { maxParallelTasks: 1, maxRepairRounds: 1, maxJobMinutes: 60 },
      agents: {
        guide: { driver: "fake", model: "guide", effort: "medium" },
        builder: { driver: "fake", model: "builder", effort: "medium" },
        reviewer: { driver: "fake", model: "reviewer", effort: "medium" },
      },
      index: { enabled: true, include: [], exclude: [] },
      setup: { commands: [], timeoutSeconds: 60 },
      checks: { commands: [], timeoutSeconds: 60 },
    });
    const source = new FilesystemIndexSource(root);
    const input = {
      source,
      project,
      limits: {
        maxFiles: 100,
        maxFileBytes: 100_000,
        maxTotalBytes: 1_000_000,
        deadlineSeconds: 10,
      },
    };
    const first = await scanIndex(input);
    const second = await scanIndex(input);
    expect(first.paths).toEqual(["src/a.ts"]);
    expect(first.contentHash).toBe(second.contentHash);
    expect(encodeBatches(first.rows).map((batch) => batch.hash)).toEqual(
      encodeBatches(second.rows).map((batch) => batch.hash),
    );
  });

  test("reads Git from the pinned revision rather than the dirty checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-index-git-"));
    roots.push(root);
    await runProcess({
      command: "git",
      args: ["init", "-q"],
      cwd: root,
      timeoutMs: 10_000,
    });
    await writeFile(join(root, "tracked.ts"), "export const value = 'base';\n");
    await runProcess({
      command: "git",
      args: ["add", "tracked.ts"],
      cwd: root,
      timeoutMs: 10_000,
    });
    await runProcess({
      command: "git",
      args: [
        "-c",
        "user.name=Runner",
        "-c",
        "user.email=runner@example.test",
        "commit",
        "-qm",
        "base",
      ],
      cwd: root,
      timeoutMs: 10_000,
    });
    const revision = (
      await runProcess({
        command: "git",
        args: ["rev-parse", "HEAD"],
        cwd: root,
        timeoutMs: 10_000,
      })
    ).stdout.trim();
    await writeFile(
      join(root, "tracked.ts"),
      "export const value = 'dirty';\n",
    );
    await writeFile(
      join(root, "untracked.ts"),
      "export const leaked = true;\n",
    );

    const source = new GitIndexSource(root, "git", revision);
    expect(await source.list()).toEqual([{ path: "tracked.ts" }]);
    expect(
      (await source.read("tracked.ts", 1_000)).bytes.toString("utf8"),
    ).toBe("export const value = 'base';\n");
    await expect(source.read("untracked.ts", 1_000)).rejects.toThrow(
      /unenumerated/,
    );
  });

  test("keeps Perforce and Diversion behind source-specific adapters", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-index-adapters-"));
    roots.push(root);
    await writeFile(join(root, "local.ts"), "local\n");
    const perforce = new PerforceIndexSource(
      root,
      "p4",
      "42",
      async () => ({
        exitCode: 0,
        signal: null,
        stdout: `... depotFile //depot/src/a.ts\n... clientFile ${join(root, "src", "a.ts")}\n... headAction add\n... fileSize 5\n`,
        stderr: "",
        durationMs: 1,
        timedOut: false,
      }),
      async () => ({
        bytes: Buffer.from("hello"),
        overLimit: false,
        stderr: "",
      }),
    );
    expect(await perforce.list()).toEqual([{ path: "src/a.ts", size: 5 }]);
    expect((await perforce.read("src/a.ts", 100)).bytes.toString()).toBe(
      "hello",
    );
    await expect(perforce.read("src/other.ts", 100)).rejects.toThrow(
      /unenumerated/,
    );
    expect(new DiversionIndexSource(root).kind).toBe("diversion");
  });
});
