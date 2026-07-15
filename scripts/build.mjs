import { chmod, readFile } from 'node:fs/promises';
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

// @anthropic-ai/claude-agent-sdk stays EXTERNAL (RUN-26): it's a large package that
// spawns the `claude` binary and carries its own subtree (@anthropic-ai/sdk, the MCP
// SDK), so it ships as a normal npm dependency and is resolved at runtime — not
// inlined. It's the only SDK-family package the daemon imports directly.
const external = ['@anthropic-ai/claude-agent-sdk'];

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
  define: { __RUNNER_VERSION__: JSON.stringify(version) },
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
