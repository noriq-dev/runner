import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { StagedRow } from "@noriq-dev/shared";

export interface EncodedBatch {
  number: number;
  bytes: Buffer;
  hash: string;
  rowCount: number;
}

function canonical(row: StagedRow): string {
  return JSON.stringify(Object.fromEntries(Object.entries(row).sort()));
}

export function encodeBatches(
  rows: StagedRow[],
  maximumBytes = 7_500_000,
): EncodedBatch[] {
  const batches: EncodedBatch[] = [];
  let pending: string[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    const bytes = gzipSync(`${pending.join("\n")}\n`, { level: 9 });
    if (bytes.length > maximumBytes)
      throw new Error(`compressed index batch exceeds ${maximumBytes} bytes`);
    batches.push({
      number: batches.length,
      bytes,
      hash: createHash("sha256").update(bytes).digest("hex"),
      rowCount: pending.length,
    });
    pending = [];
  };
  for (const row of rows) {
    const line = canonical(row);
    const candidate = gzipSync(`${[...pending, line].join("\n")}\n`, {
      level: 1,
    });
    if (candidate.length > maximumBytes && pending.length > 0) flush();
    pending.push(line);
  }
  flush();
  return batches;
}
