import { IndexAdapterRegistry, NOOP_ADAPTER } from './index-adapters';
import type { IndexParserAdapter } from './index-adapters';
import {
  createJsonAdapter,
  createMarkdownAdapter,
  createTomlAdapter,
  createUbtAdapter,
} from './index-formats';
import type { IndexLanguage, ResolvedIndexConfig } from './index-policy';
import {
  createCppTreeSitterAdapter,
  createIniTreeSitterAdapter,
  createTreeSitterAdapter,
} from './index-treesitter';
import { TreeSitterRuntime } from './treesitter-runtime';

/**
 * The composition function `[index].languages` gating needed and never had (RUN-219) — the piece
 * that makes that policy field real rather than parsed-and-discarded. `index-policy.ts` REFUSES an
 * unknown language name because the field "feeds a per-language parser selection later"
 * (`index-policy.ts`'s own comment); this is that later, and until this file existed the comment
 * was describing a control that did not exist — a typo in `[index].languages` was rejected at parse
 * time while a CORRECT value silently changed nothing, the same defect shape this phase has now
 * shipped and fixed three times (`contentMode`, `AdapterParseResult.imports`, and this).
 *
 * **The gate lives HERE, at registry construction — never inside `IndexAdapterRegistry.select()`,
 * never inside `runIndexer`'s candidate loop.** `index-adapters.ts`'s own doc is explicit that
 * `select()`'s contract is path-only; threading `ResolvedIndexConfig` into that seam would put
 * policy inside a interface whose whole point is staying ignorant of it. A factory that takes the
 * config and returns an already-filtered registry keeps `select()` untouched and lets this file's
 * OWN filtering be tested without a filesystem, a source, or `runIndexer` at all.
 *
 * **`NOOP_ADAPTER` is UNGATED and always last**, regardless of `config.languages` — it has no
 * `languages` field (`index-adapters.ts`'s own "absent means ungated" contract), so it is registered
 * unconditionally and after every language-gated adapter. This is what keeps `indexer.ts`'s
 * invariant true through this gate: a file entity exists whether or not any adapter recognises it,
 * so narrowing `languages` costs SYMBOL coverage for the languages left out, never FILE coverage. A
 * repo that sets `languages = ["markdown"]` still gets every `.ts` file addressable, citable, and
 * diffable — just with no symbols under it.
 *
 * **One shared `TreeSitterRuntime` per call**, matching `createTreeSitterAdapterRegistry`'s own
 * reasoning (`index-treesitter.ts`) — `Parser.init()` and each grammar's `Language.load` still run
 * at most once per registry, regardless of how many of the five TS/JS/TSX/C++/ini (RUN-239) tree-
 * sitter grammars a repo's `languages` set actually admits.
 *
 * **Both `index-repo` and `index-selftest` build their registry through this one function**
 * (RUN-219's own acceptance) — so the two commands cannot silently disagree about which adapters
 * exist. `index-selftest` calls it with every language admitted (it is proving the tree-sitter
 * grammars load from the bundle, not exercising the language gate), `index-repo` calls it with
 * whatever `[index].languages` (or the forced default) actually resolved to.
 */
export interface BuiltIndexAdapterRegistry {
  registry: IndexAdapterRegistry;
  runtime: TreeSitterRuntime;
}

export function buildIndexAdapterRegistry(
  config: Pick<ResolvedIndexConfig, 'languages'>,
): BuiltIndexAdapterRegistry {
  const runtime = new TreeSitterRuntime();
  const wanted = new Set<IndexLanguage>(config.languages);

  // Registration order is TRIED order (`IndexAdapterRegistry.select`'s own doc) — tree-sitter
  // ahead of the format adapters is arbitrary among these (no two ever claim the same extension),
  // kept simply for readability; NOOP_ADAPTER's position at the tail is the only one that matters.
  const gated: IndexParserAdapter[] = [
    createTreeSitterAdapter('typescript', runtime),
    createTreeSitterAdapter('tsx', runtime),
    createTreeSitterAdapter('javascript', runtime),
    // RUN-239: C++ and ini, on measured demand — see index-policy.ts's own INDEX_LANGUAGES doc.
    createCppTreeSitterAdapter(runtime),
    createIniTreeSitterAdapter(runtime),
    createJsonAdapter(),
    createTomlAdapter(),
    createMarkdownAdapter(),
    // RUN-280: UBT's `.Build.cs`/`.Target.cs` module descriptors — no grammar, see
    // index-formats.ts's own doc on why this is the same non-tree-sitter approach as the three above.
    createUbtAdapter(),
  ];

  const registry = new IndexAdapterRegistry();
  for (const adapter of gated) {
    // `adapter.languages` absent would mean ungated (index-adapters.ts's own contract) — none of
    // the six above actually omit it today, but the check is written for the general case rather
    // than assuming every future adapter this file composes will always declare one.
    if (!adapter.languages || adapter.languages.some((lang) => wanted.has(lang))) {
      registry.register(adapter);
    }
  }
  registry.register(NOOP_ADAPTER);

  return { registry, runtime };
}
