import type { MemoryNodeType } from '@noriq-dev/shared';
import type { IndexLanguage } from './index-policy';

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
 * **`parse` returns a `Promise`** — amended by RUN-216, which is the reason this was not settled as
 * plain synchronous code the way this paragraph originally read. `WebAssembly.instantiate` (what
 * `Parser.init()`/`Language.load` compile onto) is unavoidably async in JS; there is no synchronous
 * escape hatch that stays inside RUN-216's locked WASM-only packaging decision. This changes
 * nothing about the "zero model tokens" property below — the awaited work is a one-shot, in-process
 * WASM compile, not a network round trip or a partial/streamed result — so a caller still gets
 * back one complete `AdapterParseResult` or nothing, exactly as before, just awaited on the way.
 * `NOOP_ADAPTER` returns a resolved `Promise` for the same reason every implementation must now.
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
 * room for an LLM call (no prompt, no partial/interruptible result, no network round trip), which
 * is deliberate: a parser adapter that needed one would defeat the whole point of a token-free pass
 * that can run on every base movement. `Promise`-returning is not an exception to this — see the
 * note above `parse`'s own signature.
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
  /** Where this declaration sits in the file. Optional per RUN-217/218's own "declines by
   *  omission" posture: an adapter with no defensible span for a symbol leaves it off rather than
   *  reporting a guessed one. */
  range?: SymbolRange;
}

/**
 * A declaration's own line span — 1-based and INCLUSIVE at both ends, the spelling a human reads
 * in an editor and a diff, so a rendered citation needs no off-by-one legend.
 *
 * **This never reaches the wire, and that is a contract gap rather than a choice** — the vendored
 * `MemoryNode` (`vendor/noriq-shared/src/memory.ts`) carries `type`/`uri`/`label` and nothing
 * positional, and the vendored slice must land planar-side FIRST (see VENDORED-CONTRACT.md), so a
 * range added here would be dropped by `index-batch.ts`'s wire encoding today. It is recorded
 * anyway because it is free to compute where the parse already knows it, is what local citation
 * verification and the debug CLI (RUN-219) read, and is the field a later planar widening would
 * carry — the same "compute it, count it, say out loud that the wire has nowhere to put it" posture
 * `IndexerResult.inferredEdgesOmitted` already takes one layer up.
 */
export interface SymbolRange {
  startLine: number;
  endLine: number;
}

export interface ParsedDiagnostic {
  message: string;
  severity: 'error' | 'warning';
}

/**
 * Whether an adapter is stating a fact it can prove from what it saw, or a fact it believes but
 * cannot fully back (RUN-216 locked decision 7). Spelled as two plain words rather than a score so
 * a renderer can show either straight to a human with no legend (discretion): `resolved` reads as
 * "this is what the code does", `inferred` reads as "this is what the code probably does". There
 * is deliberately no third option collapsing the two — an adapter that cannot tell which it has
 * DECLINES instead (RUN-216 locked decision 6), it never picks a default confidence for a guess.
 */
export type EdgeConfidence = 'resolved' | 'inferred';

/**
 * One import statement an adapter could read as a literal, static specifier — never a resolved
 * file/symbol URI. `index-adapters.ts`'s own constraint ("an adapter only ever sees ONE file's
 * decoded text") makes resolving `specifier` to another file's entity a cross-file question this
 * per-file adapter cannot answer; recording the specifier text itself is not a guess, it is what
 * the source literally says. A specifier an adapter cannot read statically (a computed dynamic
 * `import(expr)`) is DECLINED by never appearing here at all, never emitted with a placeholder.
 */
export interface ParsedImport {
  specifier: string;
}

/**
 * One call site an adapter could resolve to a specific symbol declared IN THE SAME FILE — never a
 * cross-file target, for the same one-file-at-a-time reason `ParsedImport.specifier` stays literal
 * text. `fromSymbolPath`/`toSymbolPath` are RAW (pre-dedup) symbol paths matching some entry this
 * same `parse()` call also returned in `symbols`; a path matching nothing there is dropped by the
 * caller rather than trusted (`indexer.ts`'s own may-miss-never-invent posture, one level down from
 * the adapter). A call an adapter cannot tie to exactly one declared symbol — a call through a
 * member expression on something other than `this`, a dynamic dispatch, an imported or global
 * function — is DECLINED by omission, never emitted at low confidence with a guessed target
 * (locked decision 6: confidence distinguishes two ways of being RIGHT, never licenses a guess).
 */
export interface ParsedCall {
  fromSymbolPath: string[];
  toSymbolPath: string[];
  confidence: EdgeConfidence;
}

/**
 * One reference an adapter found from its own file to another repository path that is neither a
 * module dependency nor a same-file call — a markdown link, a backtick file mention, and (a future
 * adapter's own judgement call) anything else that is a documented POINTER rather than something
 * that runs (RUN-257). `target` uses the exact specifier grammar `ParsedImport.specifier` does —
 * bare-vs-relative dispatch, extension probing, ambiguity — because `indexer.ts` resolves both
 * through the SAME snapshot-local two-pass resolver (`resolveRelativeImport`, reused rather than
 * reimplemented: whichever relationship an adapter is reporting, "does this specifier name a real
 * path in this generation" is one question with one answer). A target this generation's own scan
 * cannot resolve — bare, ambiguous, or naming nothing that exists — is DECLINED the same way an
 * unresolved import is: no edge, never a guess (locked decision, one layer down from
 * `ParsedImport`'s own "declined by omission" rule).
 *
 * **A distinct type from `ParsedImport`, not a generalisation of it** — the two share a resolution
 * grammar but not a meaning, and `indexer.ts` types the wire edge it produces from each
 * differently (`imports` vs `related_to`) precisely because they are different claims: "this file
 * would not run without that one" versus "this file points at that one". Merging the types would
 * either bolt reference-only concerns (a markdown link with no notion of module resolution) onto
 * every import, or bolt import-only concerns (`node_modules`, a package registry) onto every
 * reference — see `index-formats.ts`'s markdown adapter for the concrete case that forced the
 * split: a `[guide](./guide.md)` link resolving through `imports` would tell a consumer asking
 * "what imports `worktree.ts`" that a documentation file does, which is simply false.
 */
export interface ParsedReference {
  target: string;
}

/**
 * One dependency an adapter's own file names by a bare NAME rather than a path (RUN-280) — a UBT
 * `.Build.cs`'s `PublicDependencyModuleNames`/`PrivateDependencyModuleNames` entry, resolved
 * against every OTHER module this generation declared, never against `ParsedImport`'s relative-path
 * grammar. The two are genuinely different claims, not a generalisation of one another: a UBT
 * module's declaring file can live anywhere under `Source/` or `Plugins/<name>/Source/` with no
 * directional relationship to the dependant's own directory (measured on Project Nod:
 * `Source/ProjectNod/ProjectNod.Build.cs` depends on
 * `Plugins/NodCharacterCreator/Source/NodCharacterCreator/NodCharacterCreator.Build.cs` — not a
 * sibling, not reachable by any relative-path guess `resolveRelativeImport` could make), so
 * `indexer.ts` resolves this by a repo-wide NAME -> declaring-URI map instead (see its own doc on
 * `moduleUriByName`). A name this generation never declared — the common case, since most UBT
 * dependencies are engine modules (`Core`, `Engine`, `UMG`, …) that live in the Unreal installation,
 * not the repo — declines the same way an unresolved `ParsedImport` does: no edge, counted rather
 * than silently dropped.
 */
export interface ParsedModuleDependency {
  moduleName: string;
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
  /** Absent/empty for an adapter that never attempts imports (locked decision 6: declinable
   *  independently of `calls`) — never a required field an adapter has to remember to satisfy. */
  imports?: ParsedImport[];
  /** Absent/empty for an adapter that never attempts calls, or that attempted every call site in
   *  this file and reliably resolved none of them — indistinguishable from each other on purpose,
   *  since both mean "no edge", the property `indexer.ts`'s tests hold it to. */
  calls?: ParsedCall[];
  /** Absent/empty for an adapter that never attempts references (RUN-257) — declinable
   *  independently of `imports`/`calls`, same as those two are of each other. */
  references?: ParsedReference[];
  /** The NAME this file itself declares (RUN-280) — a UBT module or target class name. Absent for
   *  every adapter but the UBT one; present exactly when `symbols` also carries a matching
   *  `symbolPath: [name]` entity, so `indexer.ts` can look up the URI it already minted rather than
   *  recomputing one. This is the key side of `moduleDependencies` below. */
  declaresModule?: string;
  /** Named dependencies this file's own declaration lists, resolved by NAME rather than path — see
   *  `ParsedModuleDependency`'s own doc. Meaningless without `declaresModule` also being set (there
   *  is no declaring entity to hang the edge off of), and `indexer.ts` treats it that way. */
  moduleDependencies?: ParsedModuleDependency[];
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
  /**
   * Which `[index].languages` entries this adapter serves — the join that makes that policy field a
   * real control rather than a parsed-and-ignored one (`index-policy.ts` documents it as "feeds a
   * per-language parser selection later", and Phase 3 is that later). A composition layer filters
   * adapters on it; `select()` below never consults it, because the registry's contract is
   * path-only and policy has no business inside the seam.
   *
   * OPTIONAL, and absent means UNGATED, not "serves nothing" — `NOOP_ADAPTER` claims every path and
   * must survive every language configuration, since a file entity exists whether or not any
   * adapter recognises the file (`indexer.ts`'s own invariant). Narrowing `languages` therefore
   * costs symbol coverage for those languages, never file coverage.
   */
  readonly languages?: readonly IndexLanguage[];
  canParse(path: string): boolean;
  parse(input: AdapterParseInput): Promise<AdapterParseResult>;
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
  parse: async () => ({ symbols: [], diagnostics: [] }),
};

/**
 * `NOOP_ADAPTER` registered as the tail entry, so `select` never returns `null` for a caller that
 * takes this default rather than supplying its own registry — a real adapter registered ahead of
 * it (RUN-216/218, or a test double) simply shadows it for the paths it claims.
 */
export function createDefaultAdapterRegistry(): IndexAdapterRegistry {
  return new IndexAdapterRegistry().register(NOOP_ADAPTER);
}
