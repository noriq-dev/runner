import { existsSync } from 'node:fs';
// Refresh the vendored @noriq-dev/shared runtime-neutral slice from a local Noriq
// checkout. Vendoring (not a published dep) keeps this repo standalone until the
// wire contract freezes — see vendor/noriq-shared/README.md.
//
// Usage: npm run vendor:shared [-- /path/to/noriq]
import { cp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

// Sibling checkout by default (the remote is noriq-dev/noriq, so a fresh clone is
// `noriq`); pass an explicit path for any other layout.
const noriq = process.argv[2] ?? path.resolve('../../noriq');
const srcDir = path.join(noriq, 'packages/shared/src');
const destDir = path.resolve('vendor/noriq-shared/src');

if (!existsSync(srcDir)) {
  console.error(`Noriq shared source not found at ${srcDir}`);
  console.error('pass the Noriq checkout path: npm run vendor:shared -- /path/to/noriq');
  process.exit(1);
}

await rm(destDir, { recursive: true, force: true });
await cp(srcDir, destDir, { recursive: true });
const files = (await readdir(destDir)).filter((f) => f.endsWith('.ts'));
console.log(`vendored ${files.length} file(s) from ${srcDir}:`);
for (const f of files) console.log(`  - ${f}`);
