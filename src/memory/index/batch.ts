import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { StagedRow } from "@noriq-dev/shared";

export interface EncodedBatch {
  number: number;
  bytes: Buffer;
  hash: string;
  rowCount: number;
}

const DEFAULT_MAXIMUM_COMPRESSED_BYTES = 7_500_000;
const DEFAULT_MAXIMUM_UNCOMPRESSED_BYTES = 15_000_000;

function canonical(row: StagedRow): string {
  return JSON.stringify(Object.fromEntries(Object.entries(row).sort()));
}

export function encodeBatches(
  rows: StagedRow[],
  maximumBytes = DEFAULT_MAXIMUM_COMPRESSED_BYTES,
  maximumUncompressedBytes = DEFAULT_MAXIMUM_UNCOMPRESSED_BYTES,
): EncodedBatch[] {
  const batches: EncodedBatch[] = [];
  let pending: string[] = [];
  let pendingBytes = 0;
  const emit = (lines: string[]) => {
    if (lines.length === 0) return;
    const payload = `${lines.join("\n")}\n`;
    const uncompressedBytes = Buffer.byteLength(payload);
    if (uncompressedBytes > maximumUncompressedBytes) {
      if (lines.length === 1)
        throw new Error(
          `uncompressed index row exceeds ${maximumUncompressedBytes} bytes`,
        );
      const middle = Math.floor(lines.length / 2);
      emit(lines.slice(0, middle));
      emit(lines.slice(middle));
      return;
    }
    const bytes = gzipSync(payload, { level: 9 });
    if (bytes.length > maximumBytes) {
      if (lines.length === 1)
        throw new Error(`compressed index row exceeds ${maximumBytes} bytes`);
      const middle = Math.floor(lines.length / 2);
      emit(lines.slice(0, middle));
      emit(lines.slice(middle));
      return;
    }
    batches.push({
      number: batches.length,
      bytes,
      hash: createHash("sha256").update(bytes).digest("hex"),
      rowCount: lines.length,
    });
  };
  const flush = () => {
    emit(pending);
    pending = [];
    pendingBytes = 0;
  };
  for (const row of rows) {
    const line = canonical(row);
    const lineBytes = Buffer.byteLength(line) + 1;
    if (
      pending.length > 0 &&
      pendingBytes + lineBytes > maximumUncompressedBytes
    )
      flush();
    pending.push(line);
    pendingBytes += lineBytes;
  }
  flush();
  return batches;
}
