import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Locked decision 4: "The debug command NEVER uploads and never mints an ingest capability. It
 * must not import `ingest-client.ts` or `client.ts`, and a test must assert that."
 *
 * The honest unit to check is NOT `cli.ts` — `cli.ts` already imports `client.ts`/`ingest-client.ts`
 * transitively through `start`'s `Daemon` for entirely unrelated reasons, so a test walking from
 * `cli.ts` would report "reachable" for a reason that has nothing to do with this command. The
 * actual command logic lives in `src/index-repo.ts` (orchestration), `src/index-debug.ts` (report
 * building), and `src/index-registry.ts` (the adapter composition) — `cli.ts`'s `cmdIndexRepo` is a
 * thin wrapper over `index-repo.ts` alone, so THAT is the graph this test walks.
 *
 * A small, dependency-free static import walker: read each file's source, regex out every
 * `from './x'` / `from '../x'` specifier (both `import` and `export … from`), resolve it relative
 * to the importing file, and recurse. No bundler, no `madge` — this repo has neither as a
 * dependency, and the regex only needs to handle THIS codebase's own stated convention (extensionless
 * relative imports, `verbatimModuleSyntax`, single or double quotes — `CLAUDE.md`'s own
 * "Conventions" section).
 */

const SRC_DIR = path.resolve(__dirname, '..', 'src');

const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\bfrom\s+)?['"](\.[^'"]+)['"]/g;

function resolveModule(fromFile: string, specifier: string): string {
  const resolved = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [`${resolved}.ts`, path.join(resolved, 'index.ts'), `${resolved}.tsx`];
  for (const candidate of candidates) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  // Fall back to the resolved path with .ts appended even if unreadable — walk() below will throw
  // a clear error naming it rather than silently skipping a module this codebase actually has.
  return `${resolved}.ts`;
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

/** BFS the import graph starting from `entryFiles`, returning every module file reached
 *  (including the entry files themselves). */
function walkImportGraph(entryFiles: string[]): Set<string> {
  const visited = new Set<string>();
  const queue = [...entryFiles];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);
    for (const specifier of importsOf(file)) {
      queue.push(resolveModule(file, specifier));
    }
  }
  return visited;
}

describe('index-repo command import graph (RUN-219 locked decision 4)', () => {
  const entry = [
    path.join(SRC_DIR, 'index-repo.ts'),
    path.join(SRC_DIR, 'index-debug.ts'),
    path.join(SRC_DIR, 'index-registry.ts'),
  ];

  it('sanity: the walker actually traverses more than the entry files themselves', () => {
    const reached = walkImportGraph(entry);
    // Guards against a regex/resolution bug silently making this test vacuously true.
    expect(reached.size).toBeGreaterThan(entry.length + 5);
    for (const e of entry) expect(reached.has(e)).toBe(true);
  });

  it('never reaches client.ts or ingest-client.ts', () => {
    const reached = walkImportGraph(entry);
    const basenames = [...reached].map((f) => path.basename(f));
    expect(basenames).not.toContain('client.ts');
    expect(basenames).not.toContain('ingest-client.ts');
  });

  it('control: the SAME walker, started from daemon.ts, DOES reach client.ts — proving the walker is not simply blind to it', () => {
    const reached = walkImportGraph([path.join(SRC_DIR, 'daemon.ts')]);
    const basenames = [...reached].map((f) => path.basename(f));
    expect(basenames).toContain('client.ts');
  });
});
