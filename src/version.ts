import { createRequire } from 'node:module';

/**
 * The runner's release version. package.json is the single source of truth (RUN-36).
 *
 * This was a hand-typed literal under `// Bump in lockstep with package.json` — two sources of
 * truth held together by a comment — and `scripts/build.mjs` injected nothing, so a published
 * `dist/cli.js` could confidently report a version the package wasn't. A version that can lie is
 * worse than none: RUN-37 (auto-update) compares against it, and the server uses it to decide
 * whether a runner is too old to trust.
 *
 * Injected at build time by esbuild's `define`. Guarded with `typeof` rather than a bare
 * reference so the dev path (tsx/vitest, no define) doesn't throw a ReferenceError — an
 * undeclared identifier is safe under typeof, and esbuild folds the whole expression to a
 * constant in the bundle.
 */
declare const __RUNNER_VERSION__: string;

function devVersion(): string {
  // Only reached under tsx/vitest, where package.json is a real file next to src/.
  try {
    const require = createRequire(import.meta.url);
    return (require('../package.json') as { version: string }).version;
  } catch {
    return '0.0.0-dev';
  }
}

export const VERSION: string = typeof __RUNNER_VERSION__ !== 'undefined' ? __RUNNER_VERSION__ : devVersion();
