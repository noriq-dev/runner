import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";

export async function checkoutIdentity(repository: string): Promise<string> {
  const canonical = await realpath(repository);
  return `repo_${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
}

export function stableDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
