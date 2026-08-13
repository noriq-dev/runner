import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { hashTree } from "./vendor-provenance.mjs";

const root = resolve("vendor/noriq-shared");
const provenance = JSON.parse(
  await readFile(resolve(root, "PROVENANCE.json"), "utf8"),
);
const actual = await hashTree(resolve(root, "src"));
if (JSON.stringify(actual) !== JSON.stringify(provenance.files)) {
  throw new Error(
    "vendored shared contract differs from PROVENANCE.json; re-run vendor:shared",
  );
}
process.stdout.write(
  `Verified ${Object.keys(actual).length} vendored shared files from ${provenance.sourceCommit}\n`,
);
