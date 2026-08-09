import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * A synthesized golden tree for RUN-219's `index-repo` acceptance shapes — SYNTHESIZED, never a
 * copy of the Noriq or Runner repositories (locked decision 9: those are named as fixture
 * *subjects*, and vendoring either makes the suite enormous, non-hermetic, and a second source of
 * truth for files already in this repo). Built as REAL files on a real temp directory rather than
 * committed into git (discretion): a committed CRLF file risks `core.autocrlf` mangling it on
 * checkout depending on the box, and a committed symlink is not portably a symlink at all on every
 * platform git runs on — writing both at TEST TIME with explicit bytes/`symlink()` calls sidesteps
 * both traps while still exercising the real `FilesystemIndexSource`, which an all-in-memory
 * `FakeIndexSource` fixture never would.
 *
 * Every shape the task names lives here in one small tree:
 *   - a MONOREPO layout (`packages/alpha`, `packages/beta`, each their own `src/index.ts`)
 *   - a GENERATED tree (`dist/bundle.generated.js`) — deliberately NOT under an excluded name,
 *     because the known gap this task must make VISIBLE (never fix — deferred, policy-defaults
 *     work) is that `index-scan.ts` has no default exclude list, so a first opt-in walks it
 *   - a SYMLINK (`linked/via-link.ts` -> `linked/target.ts`), inside the root
 *   - MIXED LINE ENDINGS: `crlf/windows.ts` (CRLF) and its logical twin `crlf/unix.ts` (LF), same
 *     declared function name, for a same-URI comparison
 *   - an OVER-SIZE file (`big/huge.txt`, larger than `IndexPolicy`'s default `maxFileBytes`)
 *   - one file per non-tree-sitter format adapter (`config.json`, `settings.toml`, `docs/notes.md`)
 *     so the language gate has something to gate for every adapter this task wires up
 */
export interface IndexRepoFixturePaths {
  root: string;
  monorepo: string[];
  generated: string;
  symlinkTarget: string;
  symlinkLink: string;
  crlfFile: string;
  lfFile: string;
  oversizeFile: string;
  jsonFile: string;
  tomlFile: string;
  markdownFile: string;
}

async function write(root: string, relPath: string, content: string | Buffer): Promise<string> {
  const abs = path.join(root, ...relPath.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
  return relPath;
}

export async function buildIndexRepoFixture(root: string): Promise<IndexRepoFixturePaths> {
  const monorepo = [
    await write(
      root,
      'packages/alpha/src/index.ts',
      'export function alphaGreet(name: string): string { return `alpha ${name}`; }\n',
    ),
    await write(
      root,
      'packages/beta/src/index.ts',
      'export function betaGreet(name: string): string { return `beta ${name}`; }\n',
    ),
  ];

  const generated = await write(
    root,
    'dist/bundle.generated.js',
    '// GENERATED FILE — DO NOT EDIT\nfunction generatedEntry() { return 1; }\n',
  );

  const symlinkTarget = await write(
    root,
    'linked/target.ts',
    'export function linkedTarget(): number { return 1; }\n',
  );
  const symlinkLink = 'linked/via-link.ts';
  await symlink(path.join(root, 'linked', 'target.ts'), path.join(root, ...symlinkLink.split('/')));

  const FN_NAME = 'lineEndingProbe';
  const lfBody = `export function ${FN_NAME}(): number {\n  return 1;\n}\n`;
  const crlfBody = lfBody.replace(/\n/g, '\r\n');
  const crlfFile = await write(root, 'crlf/windows.ts', crlfBody);
  const lfFile = await write(root, 'crlf/unix.ts', lfBody);

  // Over `IndexPolicy`'s default `maxFileBytes` (1_000_000) — a repeated line so it compresses
  // trivially but still reads as ordinary (non-binary) text for the scanner's binary sniff.
  const oversizeFile = await write(root, 'big/huge.txt', `${'x'.repeat(80)}\n`.repeat(15_000));

  const jsonFile = await write(root, 'config.json', JSON.stringify({ name: 'fixture', port: 8080 }, null, 2));
  const tomlFile = await write(root, 'settings.toml', 'name = "fixture"\nport = 8080\n');
  const markdownFile = await write(
    root,
    'docs/notes.md',
    '# Notes\n\nSome prose about [the code](../packages/alpha/src/index.ts).\n',
  );

  return {
    root,
    monorepo,
    generated,
    symlinkTarget,
    symlinkLink,
    crlfFile,
    lfFile,
    oversizeFile,
    jsonFile,
    tomlFile,
    markdownFile,
  };
}
