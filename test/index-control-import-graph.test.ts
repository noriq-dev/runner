import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RUN-223 locked decision 8/11 restated as an import-graph test, `index-repo-import-graph.test.ts`'s
 * own pattern reused verbatim: "no new command may upload, mint a capability, or bypass
 * `[index].enabled`" is provable, not merely claimed, by walking `index-control.ts`'s own import
 * graph and asserting it never reaches `client.ts` (registration/mint/token calls) or
 * `ingest-client.ts` (the five token-authorized upload routes). Every RUN-223 CLI command
 * (`index-status`/`-reindex`/`-retry`/`-cancel`/`-forget-journal`) is a thin wrapper calling INTO
 * this module's client-side functions — `cli.ts` itself is not the honest unit to check here for
 * the identical reason that file's own doc gives: `cli.ts` already imports `client.ts` transitively
 * through `start`'s `Daemon`, so a graph walk from there would say "reachable" for a reason that
 * has nothing to do with these five commands.
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

describe('index-control.ts import graph (RUN-223)', () => {
  const entry = [path.join(SRC_DIR, 'index-control.ts')];

  it('sanity: the walker actually traverses more than the entry file itself', () => {
    const reached = walkImportGraph(entry);
    expect(reached.size).toBeGreaterThan(entry.length + 2);
  });

  it('never reaches client.ts — no registration, no mint, no authenticated Noriq call of any kind', () => {
    const reached = walkImportGraph(entry);
    const hit = [...reached].filter((f) => f.endsWith(`${path.sep}client.ts`));
    expect(hit).toEqual([]);
  });

  it('never reaches ingest-client.ts — the five token-authorized upload routes are unreachable', () => {
    const reached = walkImportGraph(entry);
    const hit = [...reached].filter((f) => f.endsWith(`${path.sep}ingest-client.ts`));
    expect(hit).toEqual([]);
  });
});
