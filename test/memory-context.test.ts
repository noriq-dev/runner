import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextPack } from "@noriq-dev/shared";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runnerJobEventPayloadSchema } from "../src/contracts.js";
import { NoriqMemoryContextProvider } from "../src/memory/context/provider.js";
import type { NoriqHttpClient } from "../src/noriq/http.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "noriq-runner-memory-"));
  temporaryDirectories.push(path);
  return path;
}

function contextPack(
  excerpt: ContextPack["sections"][number]["excerpts"][number],
): ContextPack {
  return {
    taskId: "task",
    projectId: "project",
    branch: "main",
    baseId: "base",
    tokenBudget: 1_500,
    verifiedDecisions: [],
    relevantEntities: [],
    similarEpisodes: [],
    knownHazards: [],
    affectedTests: [],
    activeNeighboringWork: [],
    staleWarnings: [],
    generatedAt: "2026-08-14T00:00:00.000Z",
    role: "build",
    mode: "semantic",
    charBudget: 6_000,
    charsUsed: 200,
    taskFacts: {
      taskId: "task",
      key: "RUN-TEST",
      title: "Use indexed source",
      body: null,
      status: "in_progress",
      priority: 1,
      claimedBy: null,
      claimExpiresAt: null,
      openComments: [],
      executionSpec: null,
      executionSpecUnreadable: false,
    },
    sections: [
      {
        id: "source_excerpts",
        provenance: ["semantic", "exact"],
        notice: null,
        charsAllotted: 2_000,
        charsUsed: 200,
        excerpts: [excerpt],
        graphEntities: [],
        coverage: null,
        items: [],
      },
    ],
    notices: [],
  };
}

function codeExcerpt(
  overrides: Partial<
    Extract<
      ContextPack["sections"][number]["excerpts"][number],
      { excerptKind: "code" }
    >
  > = {},
): Extract<
  ContextPack["sections"][number]["excerpts"][number],
  { excerptKind: "code" }
> {
  return {
    excerptKind: "code",
    id: "noriq://file/RUN/repository/src/context.ts",
    uri: "noriq://file/RUN/repository/src/context.ts",
    projectId: "project",
    repositoryKey: "repository",
    generationId: "generation",
    branch: "main",
    baseId: "base",
    path: "src/context.ts",
    symbol: null,
    entityType: "file",
    label: "src/context.ts",
    content: "export const indexed = true;",
    contentTruncated: false,
    ...overrides,
  };
}

function providerFor(pack: ContextPack): NoriqMemoryContextProvider {
  return new NoriqMemoryContextProvider(
    {
      request: vi.fn(async () => Response.json(pack)),
    } as unknown as NoriqHttpClient,
    "runner",
  );
}

describe("Project Memory context", () => {
  test("reports a failed retrieval as valid bounded unavailable evidence", async () => {
    const provider = new NoriqMemoryContextProvider(
      {
        request: vi.fn(
          async () => new Response("unavailable", { status: 503 }),
        ),
      } as unknown as NoriqHttpClient,
      "runner",
    );
    const result = await provider.retrieve({
      projectId: "project",
      taskId: "task",
      repositoryKey: "repository",
      branch: "main",
      baseId: "a".repeat(40),
      workspace: "/checkout",
      tokenBudget: 1_500,
    });

    expect(result.text).toBe("");
    expect(result.consumption.status).toBe("unavailable");
    expect(
      runnerJobEventPayloadSchema.parse({
        type: "memory.context",
        at: new Date().toISOString(),
        taskId: "task",
        packDigest: result.digest,
        generatedAt: result.generatedAt,
        consumption: result.consumption,
      }),
    ).toBeTruthy();
  });

  test("renders indexed source only after matching it to the pinned checkout", async () => {
    const root = await workspace();
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src/context.ts"),
      "export const indexed = true;\n",
    );
    const result = await providerFor(contextPack(codeExcerpt())).retrieve({
      projectId: "project",
      taskId: "task",
      repositoryKey: "repository",
      branch: "main",
      baseId: "base",
      workspace: root,
      tokenBudget: 1_500,
    });

    expect(result.text).toContain('"kind":"indexed_source"');
    expect(result.text).toContain("| export const indexed = true;");
    expect(result.consumption.status).toBe("complete");
    expect(result.consumption.value?.staleCitationsCount).toBe(0);
    expect(
      result.consumption.value?.sections.find(
        (section) => section.id === "source_excerpts",
      )?.excerptCount,
    ).toBe(1);
  });

  test("decodes index URI path segments before confined checkout verification", async () => {
    const root = await workspace();
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src/context#encoded.ts"),
      "export const encoded = true;\n",
    );
    const result = await providerFor(
      contextPack(
        codeExcerpt({
          path: "src/context%23encoded.ts",
          label: "src/context#encoded.ts",
          content: "export const encoded = true;",
        }),
      ),
    ).retrieve({
      projectId: "project",
      taskId: "task",
      repositoryKey: "repository",
      branch: "main",
      baseId: "base",
      workspace: root,
      tokenBudget: 1_500,
    });

    expect(result.text).toContain('"path":"src/context#encoded.ts"');
    expect(result.text).toContain("| export const encoded = true;");
  });

  test("rejects mismatched and symlink-escaped source without exposing its content", async () => {
    const root = await workspace();
    const outside = await workspace();
    await mkdir(join(root, "src"));
    await writeFile(
      join(outside, "outside.ts"),
      "export const poison = true;\n",
    );
    await symlink(join(outside, "outside.ts"), join(root, "src/context.ts"));
    const result = await providerFor(
      contextPack(codeExcerpt({ content: "export const poison = true;" })),
    ).retrieve({
      projectId: "project",
      taskId: "task",
      repositoryKey: "repository",
      branch: "main",
      baseId: "base",
      workspace: root,
      tokenBudget: 1_500,
    });

    expect(result.text).not.toContain("poison");
    expect(result.consumption.status).toBe("partial");
    expect(result.consumption.value?.staleCitationsCount).toBe(1);
    expect(
      result.consumption.value?.sections.find(
        (section) => section.id === "source_excerpts",
      )?.excerptCount,
    ).toBe(0);
  });
});
