import type { IndexGenerationManifest } from "@noriq-dev/shared";
import { describe, expect, test, vi } from "vitest";
import { NoriqIndexClient } from "../src/memory/index/client.js";
import type { NoriqHttpClient } from "../src/noriq/http.js";

const manifest: IndexGenerationManifest = {
  generationId: "idx_generation",
  projectId: "project",
  repositoryKey: "repository",
  branch: "main",
  baseId: "base",
  indexerVersion: "runner-v1",
  batchCount: 2,
  fileCount: 2,
  contentHash: "a".repeat(64),
  deletions: [],
  createdAt: new Date().toISOString(),
};

const batches = [
  { number: 0, bytes: Buffer.from("first"), hash: "b".repeat(64), rowCount: 1 },
  {
    number: 1,
    bytes: Buffer.from("second"),
    hash: "c".repeat(64),
    rowCount: 1,
  },
];

function http(): NoriqHttpClient {
  return {
    serverUrl: "https://noriq.example",
    json: vi.fn(async () => ({
      token: "capability",
      maxBytes: 1_000,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })),
  } as unknown as NoriqHttpClient;
}

describe("NoriqIndexClient", () => {
  test("uses server progress as authority and resumes at the first missing batch", async () => {
    const paths: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path.endsWith("/status"))
        return Response.json({
          status: "staged",
          sealed: false,
          batchesReceived: 1,
          batchesExpected: 2,
          validation: null,
        });
      if (path.includes("/batch/")) return Response.json({ ok: true });
      if (path.endsWith("/complete"))
        return Response.json({
          ok: true,
          batchesReceived: 2,
          validation: { ok: true, problems: [] },
          activation: { activated: manifest.generationId },
        });
      throw new Error(`unexpected request ${path}`);
    }) as typeof fetch;
    const client = new NoriqIndexClient(http(), fetchImpl);

    await client.upload({ runnerId: "runner", manifest, batches });

    expect(paths).toEqual([
      "/api/memory-ingest/capability/status",
      "/api/memory-ingest/capability/batch/1",
      "/api/memory-ingest/capability/complete",
    ]);
  });

  test("begins an unknown generation and refuses failed validation", async () => {
    const paths: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path.endsWith("/status"))
        return Response.json({
          status: "unknown",
          sealed: false,
          batchesReceived: 0,
          batchesExpected: null,
          validation: null,
        });
      if (path.endsWith("/begin") || path.includes("/batch/"))
        return Response.json({ ok: true });
      return Response.json({
        ok: true,
        batchesReceived: 2,
        validation: { ok: false, problems: ["content hash mismatch"] },
      });
    }) as typeof fetch;
    const client = new NoriqIndexClient(http(), fetchImpl);

    await expect(
      client.upload({ runnerId: "runner", manifest, batches }),
    ).rejects.toThrow(/content hash mismatch/);
    expect(paths).toContain("/api/memory-ingest/capability/begin");
    expect(paths).toContain("/api/memory-ingest/capability/batch/0");
    expect(paths).toContain("/api/memory-ingest/capability/batch/1");
  });
});
