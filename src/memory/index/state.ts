import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IndexGenerationManifest } from "@noriq-dev/shared";
import { z } from "zod";

const statusSchema = z.object({
  checkoutId: z.string(),
  repositoryKey: z.string(),
  phase: z.enum([
    "idle",
    "queued",
    "scanning",
    "uploading",
    "complete",
    "failed",
    "cancelled",
  ]),
  generationId: z.string().nullable(),
  baseId: z.string().nullable(),
  fileCount: z.number().int().nonnegative(),
  batchCount: z.number().int().nonnegative(),
  error: z.string().nullable(),
  updatedAt: z.string().datetime(),
});
export type IndexStatus = z.infer<typeof statusSchema>;

const stagingSchema = z.object({
  checkoutId: z.string(),
  configDigest: z.string(),
  manifest: IndexGenerationManifest,
  batches: z.array(
    z.object({
      number: z.number().int().nonnegative(),
      hash: z.string().regex(/^[0-9a-f]{64}$/),
      rowCount: z.number().int().nonnegative(),
      compressedBytes: z.number().int().nonnegative(),
    }),
  ),
  updatedAt: z.string().datetime(),
});
export type IndexStaging = z.infer<typeof stagingSchema>;

function key(checkoutId: string): string {
  return createHash("sha256").update(checkoutId).digest("hex").slice(0, 24);
}

export function indexStatePath(
  stateDirectory: string,
  checkoutId: string,
): string {
  return join(stateDirectory, "index", `${key(checkoutId)}.json`);
}

export function indexRequestPath(
  stateDirectory: string,
  checkoutId: string,
): string {
  return join(stateDirectory, "index", `${key(checkoutId)}.request.json`);
}

export function indexStagingPath(
  stateDirectory: string,
  checkoutId: string,
): string {
  return join(stateDirectory, "index", `${key(checkoutId)}.staging.json`);
}

export async function readIndexStaging(
  stateDirectory: string,
  checkoutId: string,
): Promise<IndexStaging | null> {
  try {
    return stagingSchema.parse(
      JSON.parse(
        await readFile(indexStagingPath(stateDirectory, checkoutId), "utf8"),
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

export async function writeIndexStaging(
  stateDirectory: string,
  staging: IndexStaging,
): Promise<void> {
  const directory = join(stateDirectory, "index");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = indexStagingPath(stateDirectory, staging.checkoutId);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(staging)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function clearIndexStaging(
  stateDirectory: string,
  checkoutId: string,
): Promise<void> {
  await unlink(indexStagingPath(stateDirectory, checkoutId)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
}

export async function readIndexStatus(
  stateDirectory: string,
  checkoutId: string,
): Promise<IndexStatus | null> {
  try {
    return statusSchema.parse(
      JSON.parse(
        await readFile(indexStatePath(stateDirectory, checkoutId), "utf8"),
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeIndexStatus(
  stateDirectory: string,
  status: IndexStatus,
): Promise<void> {
  const directory = join(stateDirectory, "index");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = indexStatePath(stateDirectory, status.checkoutId);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(status)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function writeIndexRequest(
  stateDirectory: string,
  checkoutId: string,
  action: "reindex" | "cancel",
): Promise<void> {
  const directory = join(stateDirectory, "index");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = indexRequestPath(stateDirectory, checkoutId);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(
    temporary,
    `${JSON.stringify({ action, requestedAt: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
  await rename(temporary, path);
}

export async function takeIndexRequest(
  stateDirectory: string,
  checkoutId: string,
): Promise<"reindex" | "cancel" | null> {
  const path = indexRequestPath(stateDirectory, checkoutId);
  try {
    const parsed = z
      .object({ action: z.enum(["reindex", "cancel"]) })
      .parse(JSON.parse(await readFile(path, "utf8")));
    await unlink(path);
    return parsed.action;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
