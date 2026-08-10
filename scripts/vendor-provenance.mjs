import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

// RUN-240: the hashing half shared between `vendor-shared.mjs` (which WRITES a provenance record)
// and `vendor-check.mjs` (which VERIFIES the vendored tree still matches one). One implementation
// so "what counts as this file's hash" cannot drift between the writer and the reader of the same
// record — the exact defect class a provenance mechanism exists to rule out.

/** SHA-256 of a file's exact bytes, hex-encoded. */
async function hashFile(absPath) {
  const bytes = await readFile(absPath);
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Every file under `dir`, recursively, as `{ relativePath: sha256hex }` — POSIX-separated
 * (`path.sep` is `\` on Windows; a provenance record written on one platform must still verify on
 * another, since CI runs both, RUN-42) and sorted, so the JSON this produces is stable output
 * (byte-identical across two runs against the same tree) rather than directory-iteration-order
 * dependent, which would make every `npm run vendor:shared` an unreviewable diff even when
 * nothing actually changed.
 */
export async function hashTree(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries.filter((e) => e.isFile());
  const pairs = await Promise.all(
    files.map(async (e) => {
      const abs = path.join(e.parentPath ?? e.path, e.name);
      const rel = path.relative(dir, abs).split(path.sep).join('/');
      return [rel, await hashFile(abs)];
    }),
  );
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(pairs);
}
