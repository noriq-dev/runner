import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Repo hygiene the toolchain cannot see (RUN-256 follow-up).
 *
 * `tsc` and `biome` both accept a RAW NUL byte inside a string literal — it is a valid character in
 * a valid string, so nothing in `npm run check` objects and every test over the code keeps passing.
 * What it breaks is everything that decides text-vs-binary by sniffing for one: `file(1)` reports
 * the source as `data`, `grep` skips it silently (not with a warning — a repo-wide search simply
 * returns no hits for a symbol the file defines), and `git diff` renders it as `Bin`.
 *
 * This daemon has a second, sharper reason to care than ordinary tooling: `index-scan.ts`'s binary
 * sniff makes exactly that judgement, so a source file carrying a NUL is classified `binary` and
 * withheld from Project Memory. A repo cannot index its own source, and the only visible trace is
 * one line in a bounded status list.
 *
 * The separator those NULs were reaching for is fine — it is spelling it as a literal rather than an
 * escape that costs this. A backslash-u-0000 escape produces the identical one-character string, so
 * the bytes on the wire and inside every hash are unchanged either way.
 *
 * This exists because the class RECURRED. Two files carried NULs when it was first noticed
 * (`d55436a`), the sweep that fixed them only covered the two files that had been read rather than
 * the tree, and two more were sitting in `index-coordinator.ts` and `index-stage.ts` — the second of
 * those written and reviewed AFTER the first fix. A defect a green suite cannot see needs a test,
 * not a resolution to be careful.
 */

const ROOTS = ['src', 'test'];

async function collectTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectTsFiles(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('source hygiene', () => {
  it('no source file contains a raw NUL byte', async () => {
    const files = (await Promise.all(ROOTS.map((r) => collectTsFiles(r)))).flat();
    // A guard whose corpus silently emptied would pass forever — assert it found the tree first.
    expect(files.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of files) {
      const bytes = await readFile(file);
      if (bytes.includes(0)) offenders.push(file);
    }

    // Named rather than counted: the fix is per-file (swap the literal for the escape), so the
    // failure message has to say which files without the reader re-running the scan by hand.
    expect(offenders, `write '\\u0000' instead of a literal NUL in: ${offenders.join(', ')}`).toEqual([]);
  });
});
