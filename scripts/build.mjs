import { execFile } from 'node:child_process';
import { chmod, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
// Bundle the CLI into a single self-contained ESM file. Bundling inlines the
// vendored @noriq-dev/shared, smol-toml, ws, and zod so the published package needs no
// runtime dependency resolution and `npx @noriq-dev/runner` just works.
import { build } from 'esbuild';

const cliOutfile = 'dist/cli.js';
const libraryOutfile = 'dist/index.js';
const declarationOutdir = path.resolve('dist/types');
const declarationEntry = path.join(declarationOutdir, 'src/mission-library.d.ts');
const sharedDeclarationEntry = path.join(declarationOutdir, 'vendor/noriq-shared/src/index.d.ts');
const exec = promisify(execFile);

async function listDeclarationFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listDeclarationFiles(absolute)));
    } else if (entry.isFile() && entry.name.endsWith('.d.ts')) {
      files.push(absolute);
    }
  }
  return files;
}

function declarationRuntimeSpecifier(fromFile, targetFile) {
  const runtimeTarget = targetFile.replace(/\.d\.ts$/, '.js');
  const relative = path.relative(path.dirname(fromFile), runtimeTarget).split(path.sep).join('/');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

function normalizeDeclarationSpecifier(specifier, declarationFile) {
  if (specifier === '@noriq-dev/shared') {
    return declarationRuntimeSpecifier(declarationFile, sharedDeclarationEntry);
  }
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return specifier;
  return path.posix.extname(specifier) ? specifier : `${specifier}.js`;
}

function rewriteDeclarationSpecifiers(source, declarationFile) {
  return source
    .replace(
      /(\bfrom\s+)(['"])([^'"]+)\2/g,
      (_match, prefix, quote, specifier) =>
        `${prefix}${quote}${normalizeDeclarationSpecifier(specifier, declarationFile)}${quote}`,
    )
    .replace(
      /(\bimport\s*\(\s*)(['"])([^'"]+)\2(\s*\))/g,
      (_match, prefix, quote, specifier, suffix) =>
        `${prefix}${quote}${normalizeDeclarationSpecifier(specifier, declarationFile)}${quote}${suffix}`,
    )
    .replace(
      /(\bimport\s+)(['"])([^'"]+)\2/g,
      (_match, prefix, quote, specifier) =>
        `${prefix}${quote}${normalizeDeclarationSpecifier(specifier, declarationFile)}${quote}`,
    );
}

async function emitDeclarations() {
  await rm(declarationOutdir, { recursive: true, force: true });
  const tsc = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
  const config = fileURLToPath(new URL('../tsconfig.package-types.json', import.meta.url));
  await exec(process.execPath, [tsc, '--project', config], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    maxBuffer: 16 * 1024 * 1024,
  });

  for (const declarationFile of await listDeclarationFiles(declarationOutdir)) {
    const source = await readFile(declarationFile, 'utf8');
    const rewritten = rewriteDeclarationSpecifiers(source, declarationFile);
    if (rewritten.includes('@noriq-dev/shared')) {
      throw new Error(`unshipped @noriq-dev/shared reference in ${declarationFile}`);
    }
    await writeFile(declarationFile, rewritten, 'utf8');
  }

  await readFile(declarationEntry);
}

// package.json is the single source of truth for the version (RUN-36). src/version.ts used to
// hardcode it under a "bump in lockstep" comment while this script injected nothing — so the
// published bundle could report a version the package wasn't. Inject it, and `noriq-runner
// version` cannot lie.
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

// Prompt templates ride the same define rail as the version: prompts/*.md are maintained as
// files but ship INSIDE the bundle, so dist/cli.js stays self-contained (no `files` addition,
// nothing to resolve at runtime). src/prompts.ts falls back to reading the files under
// tsx/vitest. trimEnd mirrors that fallback — files end with a newline, prompts must not.
const promptsDir = new URL('../prompts/', import.meta.url);
const prompts = {};
for (const f of (await readdir(promptsDir)).filter((f) => f.endsWith('.md') && f !== 'README.md')) {
  prompts[f.slice(0, -3)] = (await readFile(new URL(f, promptsDir), 'utf8')).trimEnd();
}

// RUN-216: the tree-sitter grammars this daemon actually uses (TypeScript, JavaScript, TSX — never
// @vscode/tree-sitter-wasm's full ~40-language, 22MB collection, per that task's locked decision
// 3), base64-inlined through the SAME define rail as the prompts above so dist/cli.js stays
// self-contained without installing that package for every end user. @vscode/tree-sitter-wasm is
// a devDependency ONLY (see src/treesitter-runtime.ts's module doc) — present here, at build time,
// and in this repo's own node_modules for tsx/vitest, but never shipped as a runtime dependency.
//
// RUN-239 adds cpp (5,394,393 bytes measured on this host — the one large addition, accepted
// explicitly for measured demand; see src/treesitter-runtime.ts's own doc for the bundle-size
// trade) and ini (4,716 bytes — effectively free by comparison), on the SAME rail rather than a
// new lazy-loading mechanism for the large one: one packaging mechanism to reason about.
const grammarsDir = new URL('../node_modules/@vscode/tree-sitter-wasm/wasm/', import.meta.url);
const grammarFiles = {
  typescript: 'tree-sitter-typescript.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  ini: 'tree-sitter-ini.wasm',
};
const grammars = {};
for (const [id, file] of Object.entries(grammarFiles)) {
  grammars[id] = (await readFile(new URL(file, grammarsDir))).toString('base64');
}

// @anthropic-ai/claude-agent-sdk stays EXTERNAL (RUN-26): it's a large package that
// spawns the `claude` binary and carries its own subtree (@anthropic-ai/sdk, the MCP
// SDK), so it ships as a normal npm dependency and is resolved at runtime — not
// inlined. It's the only SDK-family package the daemon imports directly.
//
// web-tree-sitter joins it for a different but analogous reason (RUN-216, measured — see
// src/treesitter-runtime.ts's module doc): its own Parser.init() locates its ~200KB runtime WASM
// file via an import.meta.url-relative lookup from ITS OWN installed location. Bundling its JS
// would strand that lookup; staying external keeps the package at the location it expects, same
// as the Agent SDK precedent above. It ships as a normal npm dependency for exactly this reason —
// unlike @vscode/tree-sitter-wasm, whose grammar BYTES are inlined above instead.
const external = ['@anthropic-ai/claude-agent-sdk', 'web-tree-sitter'];

const commonBuildOptions = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external,
  // Folds src/version.ts's `typeof __RUNNER_VERSION__` guard to a constant. The guard exists
  // so the dev path (tsx, no define) falls back to reading package.json instead of throwing.
  define: {
    __RUNNER_VERSION__: JSON.stringify(version),
    __RUNNER_PROMPTS__: JSON.stringify(prompts),
    __RUNNER_GRAMMARS__: JSON.stringify(grammars),
  },
  sourcemap: true,
  // ESM shim so bundled CJS deps that reference require/__dirname still work.
  // No shebang here — esbuild hoists the one from src/cli.ts to line 1; a second
  // one in the banner would land on line 2 and break the ESM parse.
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      'const require = __cr(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
};

await build({
  ...commonBuildOptions,
  entryPoints: ['src/cli.ts'],
  outfile: cliOutfile,
});

// The import surface is intentionally mission-only rather than a second build of `src/index.ts`.
// That historical barrel exports the grammar-backed indexing stack, whose inlined WASM already
// rides inside the CLI. Mission consumers need the durable harness and generic MCP preparation
// boundary, not a duplicate copy of every daemon subsystem and grammar in their package import.
await build({
  ...commonBuildOptions,
  entryPoints: ['src/mission-library.ts'],
  outfile: libraryOutfile,
});

await emitDeclarations();

await chmod(cliOutfile, 0o755);
console.log(`built ${cliOutfile}, ${libraryOutfile}, and ${path.relative('.', declarationEntry)}`);
