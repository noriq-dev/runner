import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Language, Parser } from 'web-tree-sitter';

/**
 * The tree-sitter runtime for RUN-216's language-adapter seam: one WASM engine plus a small,
 * cached set of grammars, shared by every `IndexParserAdapter` this daemon registers for source
 * code. `index-treesitter.ts` is the only caller; this module owns nothing about symbol/call
 * extraction, only "get me a working `Parser` for language X, paying init/compile costs once".
 *
 * **Packaging (RUN-216 locked decisions 1/2/4), measured on this machine before anything else was
 * written**: native `tree-sitter` bindings are refused outright (`node-gyp`/prebuild-download,
 * incompatible with a single bundled `dist/cli.js` shipped to three OSes). Of the WASM options,
 * only ONE coherent runtime+grammar pairing actually works —
 * `web-tree-sitter@0.26.x`'s OWN bundled WASM runtime (`Parser.init()`, no `locateFile`) paired
 * with `@vscode/tree-sitter-wasm`'s grammar builds. The other three combinations tried all fail:
 * native bindings hit an ERESOLVE peer conflict against this repo's toolchain; `tree-sitter-wasms`'
 * grammars are built against an older ABI and throw inside `getDylinkMetadata` under 0.26's
 * runtime; and VS Code's own `tree-sitter.wasm` runtime (as opposed to its grammar builds) fails
 * `Parser.init({locateFile})` because that runtime pairs with VS Code's own loader, not
 * web-tree-sitter's. None of that is re-litigated here — this file only implements the one
 * pairing that measured working.
 *
 * **`web-tree-sitter` ships as a real npm dependency, resolved at runtime, same as the Claude
 * Agent SDK** (`scripts/build.mjs`'s `external`) — bundling its JS would strand the internal
 * `import.meta.url`-relative lookup its own `Parser.init()` uses to find its 200KB runtime WASM
 * file, which only resolves correctly when the package sits at its own installed location.
 *
 * **Grammar bytes are INLINED into `dist/cli.js`, never installed as a runtime dependency**
 * (locked decision 3 vs. locked decision 1's tension, resolved here): `@vscode/tree-sitter-wasm`
 * ships ~40 languages and 22MB unpacked — pulling it as an npm dependency for every end user just
 * to reach the handful of grammars this daemon actually uses would be exactly the "whole
 * collection" locked decision 3 forbids. So it is a devDependency ONLY: `scripts/build.mjs` reads
 * the `.wasm` files it needs at BUILD time and injects them as base64 through the same `define`
 * rail `__RUNNER_PROMPTS__` already uses to keep `dist/cli.js` self-contained (`prompts.ts`'s own
 * pattern, copied here). The dev/test path (tsx/vitest, no `define`) reads the same `.wasm` files
 * straight out of `@vscode/tree-sitter-wasm`'s `node_modules` install instead — that package IS
 * present there because it is a devDependency, exactly mirroring `prompts.ts`'s "read the file"
 * fallback.
 *
 * **RUN-239 grew this from 3 grammars (~3.2MB, ~4.3MB of base64) to 5**: TypeScript, JavaScript,
 * and TSX stay; C++ (`tree-sitter-cpp.wasm`, 5,394,393 bytes measured on this host) and ini
 * (`tree-sitter-ini.wasm`, 4,716 bytes) join, on measured demand — see `GRAMMARS`' own comment.
 * The C++ grammar alone very nearly doubles `dist/cli.js` (see `INDEX-OPERATIONS.md`'s "Adapter
 * roadmap" for the measured before/after bundle size) — accepted explicitly, on this same
 * inlining rail, rather than inventing a second, lazy-loaded packaging mechanism for one large
 * grammar: one mechanism to reason about beats two, and C++ is the one language this task's own
 * measurement found real demand for at meaningful scale (53,660 lines across 257 files in Project
 * Nod). C# (`tree-sitter-c-sharp.wasm`, 5,103,332 bytes measured — nearly as large as C++) is the
 * clearest case for NOT paying that cost twice: only 8 UBT `.Build.cs`/`.Target.cs` files exist
 * across every Noriq-managed project.
 */

export type GrammarId = 'typescript' | 'javascript' | 'tsx' | 'cpp' | 'ini';

interface GrammarSpec {
  /** `@vscode/tree-sitter-wasm`'s own filename under `wasm/` — meaningful only to the dev-path
   *  fallback and to `scripts/build.mjs`, which reads this same package by the same relative path
   *  to produce the inlined bytes. */
  wasmFile: string;
}

const GRAMMARS: Record<GrammarId, GrammarSpec> = {
  typescript: { wasmFile: 'tree-sitter-typescript.wasm' },
  javascript: { wasmFile: 'tree-sitter-javascript.wasm' },
  tsx: { wasmFile: 'tree-sitter-tsx.wasm' },
  // RUN-239: measured demand (all three Noriq-managed projects), not the task body's guessed
  // list — Project Nod (Unreal, on Diversion) has 137 .cpp + 120 .h, 53660 lines; Go and Rust have
  // ZERO files anywhere. `tree-sitter-cpp.wasm` is 5,394,393 bytes measured on this host — accepted
  // as the one large addition (see this module's own packaging doc, updated below, for the bundle
  // arithmetic). `.ini` rides the same rail for Unreal's 6 config files at 4,716 bytes — effectively
  // free by comparison. C# (`tree-sitter-c-sharp.wasm`, 5,103,332 bytes measured) is deliberately
  // NOT added: 8 UBT `.Build.cs`/`.Target.cs` files do not justify doubling the bundle again.
  cpp: { wasmFile: 'tree-sitter-cpp.wasm' },
  ini: { wasmFile: 'tree-sitter-ini.wasm' },
};

/**
 * Injected at build time by esbuild's `define` — see this module's doc. Guarded with `typeof`
 * rather than a bare reference for the same reason `version.ts`/`prompts.ts` are: the dev path
 * (tsx/vitest, no define) must not throw a ReferenceError on the undeclared identifier.
 */
declare const __RUNNER_GRAMMARS__: Record<string, string> | undefined;

const devRequire = createRequire(import.meta.url);

/** Raw grammar bytes for `id` — bundled base64 when built, a real file read under tsx/vitest.
 *  Never caches its own return: `TreeSitterRuntime.grammar` below is the cache, so this stays a
 *  plain, testable "get me the bytes" function with no state of its own. */
export function loadGrammarBytes(id: GrammarId): Uint8Array {
  if (typeof __RUNNER_GRAMMARS__ !== 'undefined') {
    const b64 = __RUNNER_GRAMMARS__[id];
    if (b64 === undefined) throw new Error(`index-treesitter: no bundled grammar for '${id}'`);
    return Buffer.from(b64, 'base64');
  }
  // Dev/test path only — see this module's doc for why @vscode/tree-sitter-wasm is safe to
  // require.resolve here (a devDependency, present in THIS repo's own node_modules) but must never
  // be reached from a bundled dist/cli.js an end user installed.
  const path = devRequire.resolve(`@vscode/tree-sitter-wasm/wasm/${GRAMMARS[id].wasmFile}`);
  return readFileSync(path);
}

export interface TreeSitterRuntimeStats {
  /** How many times `Parser.init()` was actually invoked — must stay 1 across an entire index run
   *  regardless of how many files or grammars were touched (locked decision 9, and one of the
   *  task's own observable truths: "the runtime inits once ... asserted by counting"). */
  initCount: number;
  /** `grammarId -> how many times Language.load actually ran for it` — must stay at most 1 per
   *  grammar across an entire index run, the other half of the same observable truth. */
  grammarLoadCounts: Readonly<Record<string, number>>;
}

/**
 * One process-wide-shareable tree-sitter engine: `Parser.init()` compiles a WASM module and each
 * `Language.load` compiles a multi-megabyte grammar (TypeScript's is 1.4MB) — both cached here so
 * a multi-file, multi-grammar index run pays either cost once, never per file (locked decision 9).
 * A class rather than a module-level singleton so a test (or a future daemon-lifetime cache) can
 * hold its own instance without cross-test pollution — the same DI-for-testability posture
 * `GitRunner`/`VerifyExec` take, applied to a library rather than an I/O boundary.
 */
export class TreeSitterRuntime {
  private initPromise: Promise<void> | null = null;
  private initCount = 0;
  private readonly grammarPromises = new Map<GrammarId, Promise<Language>>();
  private readonly grammarLoadCounts = new Map<GrammarId, number>();

  /** Idempotent — the underlying `Parser.init()` runs on the FIRST call only; every later caller
   *  (including a concurrent one, since this caches the in-flight promise, not just a settled
   *  one) awaits that same call. */
  private ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initCount += 1;
      this.initPromise = Parser.init();
    }
    return this.initPromise;
  }

  /** The cached `Language` for `id`, compiling it on the first request only. */
  async grammar(id: GrammarId): Promise<Language> {
    let promise = this.grammarPromises.get(id);
    if (!promise) {
      this.grammarLoadCounts.set(id, (this.grammarLoadCounts.get(id) ?? 0) + 1);
      promise = this.ensureInit().then(() => Language.load(loadGrammarBytes(id)));
      this.grammarPromises.set(id, promise);
    }
    return promise;
  }

  /** A fresh `Parser` bound to `id`'s cached grammar. Parsers themselves are cheap and NOT
   *  reused across calls (a `Parser` carries mutable state — `tree`, `language` — a shared
   *  instance would race across files if this daemon ever parses concurrently); only the
   *  expensive grammar compile is cached. */
  async parserFor(id: GrammarId): Promise<Parser> {
    const language = await this.grammar(id);
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
  }

  get stats(): TreeSitterRuntimeStats {
    return { initCount: this.initCount, grammarLoadCounts: Object.fromEntries(this.grammarLoadCounts) };
  }
}

/** `.tsx` gets its OWN grammar (measured, not assumed — discretion in the task): the plain
 *  TypeScript grammar's tree comes back with `hasError: true` on real JSX syntax, while the TSX
 *  grammar parses the same source cleanly. `.jsx` needs no separate grammar — `@vscode/tree-sitter-
 *  wasm`'s `javascript` build already parses JSX (measured the same way), so branching it to `tsx`
 *  would cost a second 1.4MB grammar load for zero benefit. */
export function grammarIdForPath(path: string): GrammarId | null {
  if (path.endsWith('.tsx')) return 'tsx';
  if (path.endsWith('.ts') || path.endsWith('.mts') || path.endsWith('.cts')) return 'typescript';
  if (/\.(?:js|jsx|mjs|cjs)$/.test(path)) return 'javascript';
  return null;
}
