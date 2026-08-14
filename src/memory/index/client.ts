import {
  type RunnerIndexCursor as Cursor,
  IndexGenerationManifest,
  type IndexGenerationManifest as Manifest,
  RunnerIndexCursor,
} from "@noriq-dev/shared";
import { z } from "zod";
import type { NoriqHttpClient } from "../../noriq/http.js";
import type { EncodedBatch } from "./batch.js";

const capabilitySchema = z.object({
  token: z.string().min(1),
  maxBytes: z.number().int().positive(),
  expiresAt: z.string().datetime(),
});

const ingestStatusSchema = z.object({
  status: z.enum(["unknown", "staged", "active", "superseded"]),
  sealed: z.boolean(),
  batchesReceived: z.number().int().nonnegative(),
  batchesExpected: z.number().int().nonnegative().nullable(),
  validation: z
    .object({
      ok: z.boolean(),
      problems: z.array(z.string()),
    })
    .nullable(),
});

const completionSchema = z.object({
  ok: z.literal(true),
  batchesReceived: z.number().int().nonnegative(),
  validation: z.object({
    ok: z.boolean(),
    problems: z.array(z.string()),
  }),
  activation: z.unknown().optional(),
});

export class NoriqIndexClient {
  constructor(
    private readonly http: NoriqHttpClient,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async cursor(input: {
    projectId: string;
    repositoryKey: string;
    runnerId: string;
    checkoutId: string;
  }): Promise<Cursor> {
    const result = await this.http.json<unknown>(
      "/api/runner-memory/index-cursor",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    return RunnerIndexCursor.parse(result);
  }

  async upload(input: {
    runnerId: string;
    manifest: Manifest;
    batches: EncodedBatch[];
  }): Promise<void> {
    const manifest = IndexGenerationManifest.parse(input.manifest);
    const maximum = Math.max(
      ...input.batches.map((batch) => batch.bytes.length),
      1,
    );
    const capability = capabilitySchema.parse(
      await this.http.json<unknown>("/api/runner-ingest/capability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: manifest.projectId,
          repositoryKey: manifest.repositoryKey,
          purpose: "index",
          scopeId: manifest.generationId,
          runnerId: input.runnerId,
          maxBytes: maximum,
        }),
      }),
    );
    const path = `/api/memory-ingest/${encodeURIComponent(capability.token)}`;
    if (input.batches.some((batch) => batch.bytes.length > capability.maxBytes))
      throw new Error(
        `index batch exceeds granted capability limit ${capability.maxBytes}`,
      );
    let status = ingestStatusSchema.parse(
      await this.anonymousJson(`${path}/status`, { method: "GET" }),
    );
    if (status.status === "active") return;
    if (status.status === "superseded")
      throw new Error("index generation was already superseded");
    if (status.status === "unknown") {
      await this.anonymousJson(`${path}/begin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(manifest),
      });
      status = {
        status: "staged",
        sealed: false,
        batchesReceived: 0,
        batchesExpected: manifest.batchCount,
        validation: null,
      };
    }
    if (
      status.batchesExpected !== null &&
      status.batchesExpected !== input.batches.length
    )
      throw new Error(
        `server expects ${status.batchesExpected} index batches, local generation has ${input.batches.length}`,
      );
    if (!status.sealed && status.batchesReceived > input.batches.length)
      throw new Error(
        "server reports more index batches than the local generation",
      );
    if (!status.sealed)
      for (const batch of input.batches) {
        if (batch.number < status.batchesReceived) continue;
        await this.anonymousJson(`${path}/batch/${batch.number}`, {
          method: "PUT",
          headers: {
            "Content-Encoding": "gzip",
            "Content-Type": "application/x-ndjson",
            "X-Batch-Hash": batch.hash,
          },
          body: new Uint8Array(batch.bytes),
        });
      }
    const completed = completionSchema.parse(
      await this.anonymousJson(`${path}/complete`, { method: "POST" }),
    );
    if (!completed.validation.ok)
      throw new Error(
        `index generation validation failed: ${completed.validation.problems.slice(0, 5).join("; ")}`,
      );
  }

  private async anonymousJson(
    path: string,
    init: RequestInit,
  ): Promise<unknown> {
    const response = await this.fetchImpl(
      new URL(path, this.http.serverUrl),
      init,
    );
    const text = await response.text();
    if (!response.ok)
      throw new Error(
        `index ingest ${path} failed (${response.status}): ${text.slice(0, 500)}`,
      );
    return text ? JSON.parse(text) : null;
  }
}
