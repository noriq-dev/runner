import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashTree } from './vendor-provenance.mjs';

// RUN-240: re-verify `vendor/noriq-shared/src` against the provenance `vendor-shared.mjs` last
// recorded — the check half of "do not hand-edit vendored files" (CLAUDE.md,
// vendor/noriq-shared/README.md, VENDORED-CONTRACT.md), which until this task was stated in three
// places and enforced in none. A hand-edited wire-contract file is exactly the failure the whole
// vendoring posture exists to prevent (the two repos silently disagree about a contract each
// believes it owns), so this compares BYTES, not intent — a hash mismatch does not know or care
// whether the edit was well-meant.
//
// Needs no Noriq checkout (unlike `vendor-shared.mjs`): everything this reads —
// `vendor/noriq-shared/src` and its own `PROVENANCE.json` — is committed IN THIS repo, which is
// what makes it safe to run in CI with no sibling clone present, and cheap enough (hashing eight
// small files) to also run inside `npm run check` rather than CI-only (this task's own discretion:
// the trade is a few milliseconds of local `check` time against catching a hand-edit before a PR
// even opens, not after — the same "shift left" reasoning `npm run check` already applies to
// typecheck/lint/test).
//
// Reports THREE distinct kinds of drift, deliberately not collapsed into one boolean:
//   - a HASH MISMATCH is a hand-edited file (the file that predates provenance tracking, or was
//     touched after);
//   - a MISSING file is what an interrupted `rm -rf` + `cp` rollout (RUN-240's own "partially-
//     refreshed vendor directory" scenario) looks like from this side: the old file provenance
//     still names is simply gone;
//   - an EXTRA file is the other half of the same interruption — a file `cp` finished writing
//     that no completed `vendor-shared.mjs` run ever recorded provenance for (or one added
//     upstream and hand-copied in rather than vendored through the script).
// Any one of the three fails the check — a "mostly matches" tree is exactly the "silently mixed
// contract" this task exists to make impossible to ship unnoticed.

const destDir = path.resolve('vendor/noriq-shared/src');
const provenancePath = path.resolve('vendor/noriq-shared/PROVENANCE.json');

/** The comparison, factored out of `main()` so a test can drive it against a temp directory and a
 *  hand-built provenance record — never the real network, never this repo's own committed tree —
 *  per this task's own testing discretion (dependency injection is this repo's strategy; the
 *  filesystem is the one dependency worth injecting here, not faking). */
export async function checkVendorProvenance(dir, provenance) {
  const problems = [];
  if (!provenance || typeof provenance !== 'object' || typeof provenance.files !== 'object') {
    return { ok: false, problems: ['no provenance record (or a malformed one) to check against'] };
  }
  const actual = await hashTree(dir);
  const recorded = provenance.files;

  const actualNames = new Set(Object.keys(actual));
  const recordedNames = new Set(Object.keys(recorded));

  const missing = [...recordedNames].filter((f) => !actualNames.has(f)).sort();
  const extra = [...actualNames].filter((f) => !recordedNames.has(f)).sort();
  const mismatched = [...actualNames].filter((f) => recordedNames.has(f) && actual[f] !== recorded[f]).sort();

  for (const f of missing) problems.push(`missing: ${f} (recorded in provenance, absent on disk)`);
  for (const f of extra) problems.push(`extra: ${f} (on disk, not recorded in provenance)`);
  for (const f of mismatched) problems.push(`hash mismatch: ${f} (hand-edited since it was vendored)`);

  return { ok: problems.length === 0, problems };
}

async function main() {
  let provenance;
  try {
    provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  } catch (err) {
    console.error(`vendor:check FAILED — could not read ${provenancePath}: ${err.message}`);
    console.error('run `npm run vendor:shared -- /path/to/noriq` to (re)vendor and record provenance.');
    process.exitCode = 1;
    return;
  }

  const { ok, problems } = await checkVendorProvenance(destDir, provenance);
  if (ok) {
    console.log(
      `vendor:check PASSED — ${Object.keys(provenance.files).length} file(s) match recorded provenance ` +
        `(commit ${provenance.sourceCommit}${provenance.sourceDirty ? ', source was DIRTY at vendor time' : ''})`,
    );
    return;
  }

  console.error('vendor:check FAILED — vendor/noriq-shared/src does not match its recorded provenance:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "Never hand-edit vendor/noriq-shared/ — if a contract change is needed, land it in planar's " +
      'packages/shared/src FIRST, then `npm run vendor:shared` here (VENDORED-CONTRACT.md).',
  );
  process.exitCode = 1;
}

// Guards `main()` so `test/vendor-check.test.ts` can import `checkVendorProvenance` without also
// running the live check against THIS repo's own committed tree as an import side effect — the
// same `import.meta.url`-vs-`realpath(argv[1])` idiom `cli.ts`'s own `invokedDirectly` uses, for
// the identical reason (a raw `process.argv[1]` comparison is false for a symlinked invocation).
function invokedDirectly(metaUrl, argv1) {
  if (!argv1) return false;
  try {
    return metaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly(import.meta.url, process.argv[1])) {
  await main();
}
