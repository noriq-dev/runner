import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

export async function hashTree(root) {
  const hashes = {};
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else
        hashes[relative(root, path)] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
    }
  }
  await walk(root);
  return Object.fromEntries(
    Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right)),
  );
}
