import type { MemoryNodeType } from '@noriq-dev/shared';

/**
 * The parser adapter registry (RUN-215) — the seam RUN-216 (tree-sitter) and RUN-218 (non-
 * tree-sitter format adapters, e.g. a JSON/TOML/markdown reader) plug into. Neither is built here;
 * this task ships the interface and, per the deferred list, "at most a trivial fallback adapter"
 * (`NOOP_ADAPTER` below) proving the interface's minimal legal shape.
 *
 * **The interface must not assume a parse tree** (discretion, stated as a hard constraint because
 * RUN-218's adapters have no tree to hand back). `IndexParserAdapter.parse` takes decoded source
 * text and returns a flat list of symbols plus diagnostics — no AST, no node handles, no callback
 * into a shared tree walker. A tree-sitter adapter builds this same flat shape by walking its own
 * tree internally; a line-oriented or regex-based adapter builds it directly. Neither leaks its
 * internal representation across this boundary, so `indexer.ts` never has to know which kind of
 * adapter it is holding.
 *
 * **An adapter only ever sees ONE file's decoded text** — no cross-file knowledge, no import
 * resolution, no project-wide symbol table. `indexer.ts` calls `parse` once per candidate; edges
 * beyond a file's own `declares` (file → its symbols) are a later phase's job once cross-file
 * resolution exists to back them safely (a `calls`/`imports` edge to a symbol this adapter cannot
 * see is a guess, not a fact, and this indexer records only what content hashing and file
 * enumeration have actually PROVEN).
 *
 * **Zero model tokens** (locked decision 10, restated for this seam specifically): every adapter
 * `indexer.ts` will ever call — this task's `NOOP_ADAPTER`, RUN-216/218's real ones — is
 * deterministic code operating on bytes already in memory. Nothing in this interface's shape makes
 * room for an LLM call (no prompt, no async streaming, no partial/interruptible result), which is
 * deliberate: a parser adapter that needed a network round trip would defeat the whole point of a
 * token-free pass that can run on every base movement.
 *
 * **Adapters are consulted content-mode gated, by the CALLER, not by this file** — `indexer.ts`
 * only invokes `parse` for a candidate whose content survived (`contentMode: 'full'`); a
 * `'metadata'`-mode candidate never reaches an adapter at all, because there is no decoded text to
 * hand it. This module has no opinion on that gate; it only defines what an adapter receives once
 * one is actually called.
 */

/** The three entity kinds a symbol-level parse result may produce — the vendored
 *  `MemoryNodeType`'s repository-scoped, path-plus-name arms (`symbol`/`test`/`api`); `file` is
 *  never produced here because `indexer.ts` mints exactly one file entity per candidate itself,
 *  outside any adapter. */
export type SymbolNodeType = Extract<MemoryNodeType, 'symbol' | 'test' | 'api'>;

/**
 * One declaration an adapter found inside a file. `symbolPath` is outer-to-inner (`['Outer',
 * 'method']` for a nested declaration) — never a line number, never a byte offset (locked decision
 * 5; `index-entity.ts`'s `buildSymbolEntityUri` is the only thing that turns this into an
 * identity, and it never accepts one). Emission ORDER across one `parse()` call must be stable for
 * a given file's content — `index-entity.ts`'s `dedupeSymbolPaths` relies on it to disambiguate
 * two same-named symbols deterministically.
 */
export interface ParsedSymbol {
  symbolPath: string[];
  nodeType: SymbolNodeType;
  label: string;
  /** The symbol's own derived payload (its source span, a docstring, a signature) — `null` when an
   *  adapter has nothing content-shaped to offer for this symbol kind. Never a chunk with its own
   *  identity (locked decision 8) — this is one entity's `content` field, nothing more. */
  content: string | null;
}

export interface ParsedDiagnostic {
  message: string;
  severity: 'error' | 'warning';
}

export interface AdapterParseInput {
  /** Repository-relative, forward-slash path — already normalized by the caller. */
  path: string;
  /** Decoded UTF-8 text. Every candidate reaching an adapter already passed the scanner's binary
   *  sniff (`index-scan.ts`), so this is always real source text, never a decision an adapter has
   *  to make for itself. */
  content: string;
}

export interface AdapterParseResult {
  symbols: ParsedSymbol[];
  diagnostics: ParsedDiagnostic[];
}

/**
 * One parser. `canParse` is a cheap, synchronous yes/no (typically an extension or filename check)
 * so the registry can try several adapters per path without paying a real parse for each; `parse`
 * does the actual work once one has claimed a path.
 */
export interface IndexParserAdapter {
  /** Stable across versions of the SAME parser — `NOOP_ADAPTER`'s `'noop'`, a future
   *  `'tree-sitter-typescript'`. Recorded onto every diagnostic and symbol this adapter produces
   *  (`indexer.ts`'s `parserVersions` summary) — RUN-215 scope's "record indexer and parser
   *  versions". */
  readonly id: string;
  /** Bumped by the adapter's OWN author whenever its output for unchanged input would change — the
   *  same reasoning `INDEXER_VERSION` (`index-reconcile.ts`) states one level up, scoped to one
   *  parser instead of the whole daemon. */
  readonly version: string;
  canParse(path: string): boolean;
  parse(input: AdapterParseInput): AdapterParseResult;
}

/**
 * Ordered list of adapters, tried in REGISTRATION order — the first `canParse` to answer `true`
 * wins, so a caller registers its most specific adapters before any catch-all. Not a map keyed by
 * extension: an adapter may claim a path by any predicate (a filename, a shebang line a future
 * adapter might want to sniff), and the interface must not assume "extension" is how the choice is
 * made.
 */
export class IndexAdapterRegistry {
  private readonly adapters: IndexParserAdapter[] = [];

  register(adapter: IndexParserAdapter): this {
    this.adapters.push(adapter);
    return this;
  }

  /** `null` when no registered adapter claims this path — `indexer.ts` treats that exactly like a
   *  candidate that only ever gets its own `file` entity, no symbols. */
  select(path: string): IndexParserAdapter | null {
    for (const adapter of this.adapters) {
      if (adapter.canParse(path)) return adapter;
    }
    return null;
  }

  get all(): readonly IndexParserAdapter[] {
    return this.adapters;
  }
}

/**
 * The trivial fallback the deferred list allows ("at most a trivial fallback adapter"): claims
 * every path, extracts nothing. Exists to prove `IndexParserAdapter`'s minimal legal
 * implementation compiles and runs cleanly through the whole pipeline BEFORE RUN-216/218 exist —
 * every file still gets its own durable `file` entity regardless of whether any adapter recognises
 * it, so shipping no real language adapters yet costs symbol/test/api coverage, never file
 * coverage.
 */
export const NOOP_ADAPTER: IndexParserAdapter = {
  id: 'noop',
  version: '1',
  canParse: () => true,
  parse: () => ({ symbols: [], diagnostics: [] }),
};

/**
 * `NOOP_ADAPTER` registered as the tail entry, so `select` never returns `null` for a caller that
 * takes this default rather than supplying its own registry — a real adapter registered ahead of
 * it (RUN-216/218, or a test double) simply shadows it for the paths it claims.
 */
export function createDefaultAdapterRegistry(): IndexAdapterRegistry {
  return new IndexAdapterRegistry().register(NOOP_ADAPTER);
}
