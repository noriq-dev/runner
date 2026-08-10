import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
// Refresh the vendored @noriq-dev/shared runtime-neutral slice from a local Noriq
// checkout. Vendoring (not a published dep) keeps this repo standalone until the
// wire contract freezes — see vendor/noriq-shared/README.md.
//
// Usage: npm run vendor:shared [-- /path/to/noriq]
import { cp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hashTree } from './vendor-provenance.mjs';

// Where a Noriq checkout usually is, tried in order. Both are "a sibling clone named
// `noriq`" — the remote is noriq-dev/noriq — and they differ only in whether the two
// repos sit directly beside each other (`~/git/{runner,noriq}`) or under a shared
// parent (`~/git/noriq/{runner,noriq}`). Guessing one and failing on the other sent
// this script's own task hunting for the right invocation; an explicit path still wins.
const CANDIDATES = ['../../noriq', '../noriq'];
const sharedSubpath = 'packages/shared/src';
const shared = (root) => path.join(root, sharedSubpath);

const explicit = process.argv[2];
const srcRoot = explicit
  ? path.resolve(explicit)
  : CANDIDATES.map((c) => path.resolve(c)).find((r) => existsSync(shared(r)));
const srcDir = srcRoot ? shared(srcRoot) : undefined;
const destDir = path.resolve('vendor/noriq-shared/src');
const provenancePath = path.resolve('vendor/noriq-shared/PROVENANCE.json');

if (!srcDir || !existsSync(srcDir)) {
  console.error(
    `Noriq shared source not found at ${srcDir ?? CANDIDATES.map((c) => shared(path.resolve(c))).join(' or ')}`,
  );
  console.error('pass the Noriq checkout path: npm run vendor:shared -- /path/to/noriq');
  process.exit(1);
}

// RUN-240: provenance is not optional metadata bolted on after the fact — it is what makes "do
// not hand-edit vendored files" (CLAUDE.md, this file's own header, vendor/noriq-shared/README.md)
// something `vendor-check.mjs` can actually catch instead of merely ask nicely for. Both facts
// come from the SOURCE checkout, not the copy: the commit names which upstream state was taken,
// and the dirty flag says whether that commit is even the whole truth (a vendor taken from a
// dirty tree is not reproducible from the commit sha alone — recording the sha while hiding the
// dirt would read as exact and not be, which is worse than recording nothing).
function gitField(args) {
  try {
    return execFileSync('git', args, { cwd: srcRoot, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}
const sourceCommit = gitField(['rev-parse', 'HEAD']);
if (sourceCommit === null) {
  console.error(
    `could not read a git commit at ${srcRoot} — is it a git checkout? Provenance requires one; refusing to vendor without it rather than writing a record that looks exact and is not.`,
  );
  process.exit(1);
}
// Scoped to the copied subtree, not the whole Noriq checkout: an unrelated dirty file elsewhere
// in that monorepo (a different app, a different package) says nothing about whether THIS slice
// is reproducible from `sourceCommit` — scoping the check to what was actually read avoids a false
// "dirty" on every ordinary Noriq working session and a false clean on a subtree that IS dirty
// while sibling files happen to be clean.
const dirtyOutput = gitField(['status', '--porcelain', '--', sharedSubpath]);
const sourceDirty = dirtyOutput === null ? null : dirtyOutput.length > 0;

await rm(destDir, { recursive: true, force: true });
await cp(srcDir, destDir, { recursive: true });
const files = (await readdir(destDir)).filter((f) => f.endsWith('.ts'));
console.log(`vendored ${files.length} file(s) from ${srcDir}:`);
for (const f of files) console.log(`  - ${f}`);

const fileHashes = await hashTree(destDir);
const provenance = {
  sourceCommit,
  sourceDirty,
  vendoredAt: new Date().toISOString(),
  files: fileHashes,
};
await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
console.log(
  `wrote ${provenancePath} — commit ${sourceCommit}${sourceDirty ? ' (source tree was DIRTY)' : ''}, ` +
    `${Object.keys(fileHashes).length} file hash(es)`,
);
if (sourceDirty) {
  console.warn(
    'WARNING: the Noriq checkout had uncommitted changes under packages/shared/src — this vendor ' +
      'is not reproducible from the recorded commit alone. Commit upstream first, then re-vendor.',
  );
}
console.log('run `npm run vendor:check` to re-verify this tree against the record any time.');
