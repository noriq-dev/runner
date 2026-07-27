import { existsSync } from 'node:fs';
// Refresh the vendored @noriq-dev/shared runtime-neutral slice from a local Noriq
// checkout. Vendoring (not a published dep) keeps this repo standalone until the
// wire contract freezes — see vendor/noriq-shared/README.md.
//
// Usage: npm run vendor:shared [-- /path/to/noriq]
import { cp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

// Where a Noriq checkout usually is, tried in order. Both are "a sibling clone named
// `noriq`" — the remote is noriq-dev/noriq — and they differ only in whether the two
// repos sit directly beside each other (`~/git/{runner,noriq}`) or under a shared
// parent (`~/git/noriq/{runner,noriq}`). Guessing one and failing on the other sent
// this script's own task hunting for the right invocation; an explicit path still wins.
const CANDIDATES = ['../../noriq', '../noriq'];
const shared = (root) => path.join(root, 'packages/shared/src');

const explicit = process.argv[2];
const srcDir = explicit
  ? shared(path.resolve(explicit))
  : CANDIDATES.map((c) => shared(path.resolve(c))).find(existsSync);
const destDir = path.resolve('vendor/noriq-shared/src');

if (!srcDir || !existsSync(srcDir)) {
  console.error(
    `Noriq shared source not found at ${srcDir ?? CANDIDATES.map((c) => shared(path.resolve(c))).join(' or ')}`,
  );
  console.error('pass the Noriq checkout path: npm run vendor:shared -- /path/to/noriq');
  process.exit(1);
}

await rm(destDir, { recursive: true, force: true });
await cp(srcDir, destDir, { recursive: true });
const files = (await readdir(destDir)).filter((f) => f.endsWith('.ts'));
console.log(`vendored ${files.length} file(s) from ${srcDir}:`);
for (const f of files) console.log(`  - ${f}`);
