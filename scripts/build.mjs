import { chmod, readFile, readdir } from 'node:fs/promises';
// Bundle the CLI into a single self-contained ESM file. Bundling inlines the
// vendored @noriq-dev/shared, smol-toml, ws, and zod so the published package needs no
// runtime dependency resolution and `npx @noriq-dev/runner` just works.
import { build } from 'esbuild';

const outfile = 'dist/cli.js';

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
const grammarsDir = new URL('../node_modules/@vscode/tree-sitter-wasm/wasm/', import.meta.url);
const grammarFiles = {
  typescript: 'tree-sitter-typescript.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
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

await build({
  entryPoints: ['src/cli.ts'],
  outfile,
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
});

await chmod(outfile, 0o755);
console.log(`built ${outfile}`);
