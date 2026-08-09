import type { Node } from 'web-tree-sitter';
import {
  type AdapterParseInput,
  type AdapterParseResult,
  IndexAdapterRegistry,
  type IndexParserAdapter,
  NOOP_ADAPTER,
  type ParsedCall,
  type ParsedDiagnostic,
  type ParsedImport,
  type ParsedSymbol,
} from './index-adapters';
import { type GrammarId, TreeSitterRuntime, grammarIdForPath } from './treesitter-runtime';

/**
 * The tree-sitter `IndexParserAdapter` for TypeScript/JavaScript/TSX (RUN-216). Extraction rules
 * themselves are RUN-217's job (deferred) — this ships enough to prove a real grammar parses real
 * source into `index-adapters.ts`'s flat shape, and that a relationship this adapter cannot back
 * with certainty is DECLINED rather than guessed (locked decision 6). What is real here: top-level
 * and nested function/class/method/interface/type/enum declarations, `describe`/`it`/`test` test
 * blocks, static import specifiers, and same-file call resolution with confidence (locked
 * decision 7) — everything past that (cross-file imports, dynamic dispatch, JSX-aware symbol
 * shapes) stays undone rather than approximated.
 *
 * **Isolation is TWO-LAYERED, deliberately redundant** (locked decision 5): `parse()` below wraps
 * its own tree-walk in try/catch and turns any throw into a single bounded diagnostic rather than
 * ever propagating — tree-sitter itself is error-tolerant (a syntax error yields `ERROR`/`MISSING`
 * nodes, not a throw, confirmed by measurement), so reaching that catch means something outside
 * ordinary parsing went wrong (a WASM trap, a bug in this file's own walk). `indexer.ts`'s loop
 * ALSO wraps every adapter's `parse()` call — that second layer is the one that actually makes
 * "parser failure isolated to the file" a property of the SEAM, holding even for a future adapter
 * that is not this careful, not just a promise this one file keeps about itself.
 *
 * **Same-file calls only, by construction** — `ParsedCall.fromSymbolPath`/`toSymbolPath` are built
 * exclusively from names this SAME `parse()` call also put in `symbols`, using two passes: pass one
 * walks the tree once, collecting declarations (in stable emission order — `dedupeSymbolPaths`
 * depends on it) and raw call SITES; pass two resolves each site against the completed declaration
 * maps, because "is this name unambiguous across the file" cannot be answered before the whole file
 * has been seen. A callee identifier matching more than one top-level declaration, or matching
 * none, is DROPPED rather than guessed at either candidate.
 *
 * **Confidence has exactly two buckets, deliberately not three** (locked decision 7): a bare
 * `foo()` call resolving to exactly one same-file declaration is `'resolved'`; a `this.foo()` call
 * resolving to exactly one method on the enclosing class is `'inferred'` — `this` binding is not
 * fully dynamic dispatch, but it is not guaranteed static either (call/apply/bind, an instance
 * property shadowing the method), so it is deliberately not filed as `'resolved'`. Everything else
 * (a call through any other member expression, a call to an imported or global name, a computed
 * callee) is DECLINED — omitted from `calls` entirely, never emitted as a third, lower tier of
 * `'inferred'`. `imports` gets no confidence field at all for the same reason: a literal specifier
 * an adapter chooses to emit is always a plain fact read off the source text, never a guess, so
 * there is nothing to grade — a dynamic `import(expr)` is simply never visited by this extraction
 * (it is a `call_expression`, not an `import_statement`), which is what "declines by omission,
 * never emits a placeholder" looks like in practice.
 */

const ADAPTER_VERSION = '1';

const TEST_CALL_NAMES = new Set(['it', 'test']);
const DESCRIBE_CALL_NAME = 'describe';

// ---------------------------------------------------------------------------
// Pass 1: walk the tree once, collecting declarations (in stable order) and raw call sites.
// ---------------------------------------------------------------------------

interface CallSite {
  /** Raw (pre-dedup) path of the symbol this call occurs inside — null for a call at the top of
   *  the file, outside any declared symbol, which is always dropped (no valid `from`). */
  fromPath: string[] | null;
  calleeName: string;
  /** True for `this.<calleeName>()` — the sole `'inferred'` shape this adapter recognises. */
  isThisMember: boolean;
  enclosingClass: string | null;
}

interface WalkState {
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  callSites: CallSite[];
}

/** Outer-to-inner context threaded down the recursion — never mutated in place, always a fresh
 *  object per level, so sibling subtrees can never see each other's declarations. */
interface WalkCtx {
  path: string[] | null;
  enclosingClass: string | null;
  describePath: string[];
}

/** The child of a `string`/`template_string` node that actually holds text, stripped of its own
 *  quote/backtick delimiters — `null` for anything that is not a plain literal (a template with
 *  `${}` interpolation, for instance), which is exactly the "declines by omission" shape for a
 *  specifier or a test name this adapter cannot read statically. */
function literalStringValue(node: Node | null): string | null {
  if (!node) return null;
  if (node.type === 'string') {
    const fragment = node.namedChildren.find((c) => c?.type === 'string_fragment');
    return fragment ? fragment.text : '';
  }
  if (node.type === 'template_string') {
    // Only a template with NO interpolation (every named child is a plain fragment) is a literal
    // this adapter will read — one with `${...}` inside is a runtime-computed value, declined.
    if (node.namedChildren.some((c) => c?.type !== 'string_fragment')) return null;
    return node.namedChildren.map((c) => c?.text ?? '').join('');
  }
  return null;
}

function pushSymbol(
  out: ParsedSymbol[],
  path: string[],
  label: string,
  node: Node,
  nodeType: ParsedSymbol['nodeType'] = 'symbol',
): void {
  out.push({ symbolPath: path, nodeType, label, content: node.text });
}

/** Declarator name for `const NAME = <arrow function or function expression>` — the common
 *  JS/TS "function stored in a variable" shape, alongside real `function_declaration`s. */
function functionValuedDeclaratorName(declarator: Node): string | null {
  const value = declarator.childForFieldName('value');
  if (!value || (value.type !== 'arrow_function' && value.type !== 'function_expression')) return null;
  const name = declarator.childForFieldName('name');
  return name && name.type === 'identifier' ? name.text : null;
}

function walk(node: Node, ctx: WalkCtx, state: WalkState): void {
  switch (node.type) {
    case 'function_declaration': {
      const name = node.childForFieldName('name');
      if (name) {
        const path = [...(ctx.path ?? []), name.text];
        pushSymbol(state.symbols, path, name.text, node);
        walkChildren(node, { ...ctx, path }, state);
        return;
      }
      break;
    }
    case 'class_declaration': {
      const name = node.childForFieldName('name');
      if (name) {
        const path = [...(ctx.path ?? []), name.text];
        pushSymbol(state.symbols, path, name.text, node);
        walkChildren(node, { path, enclosingClass: name.text, describePath: ctx.describePath }, state);
        return;
      }
      break;
    }
    case 'method_definition': {
      const name = node.childForFieldName('name');
      if (name && ctx.path) {
        const path = [...ctx.path, name.text];
        pushSymbol(state.symbols, path, name.text, node);
        walkChildren(node, { ...ctx, path }, state);
        return;
      }
      break;
    }
    case 'interface_declaration':
    case 'type_alias_declaration':
    case 'enum_declaration': {
      const name = node.childForFieldName('name');
      if (name) pushSymbol(state.symbols, [...(ctx.path ?? []), name.text], name.text, node);
      break;
    }
    case 'variable_declarator': {
      const fnName = functionValuedDeclaratorName(node);
      if (fnName) {
        const path = [...(ctx.path ?? []), fnName];
        pushSymbol(state.symbols, path, fnName, node);
        const value = node.childForFieldName('value');
        if (value) walkChildren(value, { ...ctx, path }, state);
        return;
      }
      break;
    }
    case 'import_statement':
    case 'export_statement': {
      const specifier = literalStringValue(node.childForFieldName('source'));
      if (specifier !== null) state.imports.push({ specifier });
      break;
    }
    case 'call_expression': {
      recordCallSite(node, ctx, state);
      break;
    }
    default:
      break;
  }
  walkChildren(node, ctx, state);
}

function walkChildren(node: Node, ctx: WalkCtx, state: WalkState): void {
  for (const child of node.namedChildren) {
    if (child) walk(child, ctx, state);
  }
}

/** `describe('name', fn)` nests `it`/`test` names under it (a real, if partial, "documentation
 *  structure" for tests — RUN-217 may extend it); `it('name', fn)`/`test('name', fn)` become a
 *  `test`-kind symbol. Both are DECLINED (nothing pushed) when the name argument is not a literal
 *  this adapter can read statically — a computed test name is not guessed at. */
function recordCallSite(node: Node, ctx: WalkCtx, state: WalkState): void {
  const callee = node.childForFieldName('function');
  const args = node.childForFieldName('arguments');
  if (callee?.type === 'identifier' && args) {
    const first = args.namedChildren[0] ?? null;
    const label = literalStringValue(first ?? null);
    if (callee.text === DESCRIBE_CALL_NAME && label !== null) {
      const describePath = [...ctx.describePath, label];
      const callback = args.namedChildren[1] ?? null;
      if (callback && (callback.type === 'arrow_function' || callback.type === 'function_expression')) {
        walkChildren(callback, { ...ctx, describePath }, state);
      }
      return;
    }
    if (TEST_CALL_NAMES.has(callee.text) && label !== null) {
      const path = [...ctx.describePath, label];
      pushSymbol(state.symbols, path, label, node, 'test');
      const callback = args.namedChildren[1] ?? null;
      if (callback && (callback.type === 'arrow_function' || callback.type === 'function_expression')) {
        walkChildren(callback, { ...ctx, path }, state);
      }
      return;
    }
  }

  if (callee?.type === 'identifier') {
    state.callSites.push({
      fromPath: ctx.path,
      calleeName: callee.text,
      isThisMember: false,
      enclosingClass: ctx.enclosingClass,
    });
  } else if (callee?.type === 'member_expression') {
    const object = callee.childForFieldName('object');
    const property = callee.childForFieldName('property');
    if (object?.type === 'this' && property?.type === 'property_identifier') {
      state.callSites.push({
        fromPath: ctx.path,
        calleeName: property.text,
        isThisMember: true,
        enclosingClass: ctx.enclosingClass,
      });
    }
    // Any other member-expression callee (obj.method(), console.log(), an imported namespace call)
    // is declined here by simply not recording a call site for it.
  }
}

// ---------------------------------------------------------------------------
// Pass 2: resolve call sites against the completed declaration set.
// ---------------------------------------------------------------------------

/** Resolve `state.callSites` into `ParsedCall`s. A bare identifier call resolves only when EXACTLY
 *  one top-level (depth-1) declaration in the whole file carries that name — ambiguous (an
 *  overload, a shadowed name reused elsewhere) or absent is dropped, never guessed at one
 *  candidate. A `this.NAME()` call resolves only when the enclosing class declares a method
 *  literally named `NAME`. */
function resolveCalls(state: WalkState): ParsedCall[] {
  const topLevelByName = new Map<string, string[][]>();
  for (const symbol of state.symbols) {
    if (symbol.symbolPath.length !== 1) continue;
    const name = symbol.symbolPath[0]!;
    const list = topLevelByName.get(name) ?? [];
    list.push(symbol.symbolPath);
    topLevelByName.set(name, list);
  }

  const methodsByClass = new Map<string, Set<string>>();
  for (const symbol of state.symbols) {
    if (symbol.symbolPath.length !== 2) continue;
    const [className, methodName] = symbol.symbolPath as [string, string];
    const set = methodsByClass.get(className) ?? new Set<string>();
    set.add(methodName);
    methodsByClass.set(className, set);
  }

  const calls: ParsedCall[] = [];
  for (const site of state.callSites) {
    if (!site.fromPath) continue; // No valid caller symbol to attribute this call to.

    if (site.isThisMember) {
      if (site.enclosingClass && methodsByClass.get(site.enclosingClass)?.has(site.calleeName)) {
        calls.push({
          fromSymbolPath: site.fromPath,
          toSymbolPath: [site.enclosingClass, site.calleeName],
          confidence: 'inferred',
        });
      }
      continue;
    }

    const candidates = topLevelByName.get(site.calleeName);
    if (candidates && candidates.length === 1) {
      calls.push({ fromSymbolPath: site.fromPath, toSymbolPath: candidates[0]!, confidence: 'resolved' });
    }
  }
  return calls;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

function countParseErrors(node: Node): number {
  let count = 0;
  const stack: Node[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === 'ERROR' || current.isMissing) count += 1;
    for (const child of current.children) if (child) stack.push(child);
  }
  return count;
}

/** One `IndexParserAdapter` per grammar (locked decision 8: parser versions are recorded PER
 *  GRAMMAR) — all three share the SAME `TreeSitterRuntime`, so `Parser.init()` still runs once
 *  regardless of how many of the three grammars a given repository actually touches, and each
 *  grammar's own `Language.load` still runs at most once (`TreeSitterRuntime.grammar`'s own
 *  cache) no matter how many files this adapter parses. */
export function createTreeSitterAdapter(grammar: GrammarId, runtime: TreeSitterRuntime): IndexParserAdapter {
  return {
    id: `tree-sitter-${grammar}`,
    version: ADAPTER_VERSION,
    canParse: (path) => grammarIdForPath(path) === grammar,
    parse: (input: AdapterParseInput): Promise<AdapterParseResult> => parseFile(grammar, runtime, input),
  };
}

async function parseFile(
  grammar: GrammarId,
  runtime: TreeSitterRuntime,
  input: AdapterParseInput,
): Promise<AdapterParseResult> {
  try {
    // `TreeSitterRuntime.parserFor` awaits the cached grammar (compiled at most once — see this
    // adapter's own doc) and hands back a FRESH `Parser` bound to it: a `Parser` carries mutable
    // state (its own `tree`), so per-call construction is what keeps concurrent `parse()` calls
    // for different files from racing each other, while the expensive part (the grammar itself)
    // stays cached and shared.
    const parser = await runtime.parserFor(grammar);
    const tree = parser.parse(input.content);
    if (!tree) {
      return { symbols: [], diagnostics: [{ message: 'tree-sitter returned no tree', severity: 'error' }] };
    }
    const state: WalkState = { symbols: [], imports: [], callSites: [] };
    walk(tree.rootNode, { path: null, enclosingClass: null, describePath: [] }, state);

    const diagnostics: ParsedDiagnostic[] = [];
    if (tree.rootNode.hasError) {
      const errorCount = countParseErrors(tree.rootNode);
      // ONE bounded diagnostic per file regardless of how many ERROR/MISSING nodes tree-sitter's
      // recovery produced (locked decision 5) — a single very broken file must not threaten
      // `MAX_PARSE_DIAGNOSTICS` on its own. Declarations found OUTSIDE the broken region are still
      // in `state.symbols` above: tree-sitter's error recovery is local, not whole-file.
      diagnostics.push({
        message: `${errorCount} syntax error location(s) — some declarations may be missing or incomplete`,
        severity: 'warning',
      });
    }

    return { symbols: state.symbols, diagnostics, imports: state.imports, calls: resolveCalls(state) };
  } catch (err) {
    // Not ordinary syntax error recovery (tree-sitter never throws for that — measured) — a WASM
    // trap, a stack limit, or a bug in this file's own walk. Isolated to this one file;
    // `indexer.ts`'s own try/catch around every adapter call is the seam-level backstop behind
    // this one (locked decision 5's "two-layered, deliberately redundant" — see this module's doc).
    return {
      symbols: [],
      diagnostics: [
        {
          message: `tree-sitter-${grammar} threw while parsing: ${err instanceof Error ? err.message : String(err)}`,
          severity: 'error',
        },
      ],
    };
  }
}

/** Builds a registry with all three tree-sitter adapters ahead of `NOOP_ADAPTER`, sharing one
 *  `TreeSitterRuntime` — the shape a caller (a future indexer coordinator wiring) uses to get real
 *  TS/JS/TSX coverage; `index-adapters.ts`'s own `createDefaultAdapterRegistry()` deliberately stays
 *  noop-only (its own doc: "a convenience for 'no real adapters yet'"), so this is a SEPARATE
 *  factory rather than a change to that one's behavior. No warm-up call is needed — `parse()` is
 *  itself async now (this task amended `IndexParserAdapter`'s signature; see `index-adapters.ts`'s
 *  own note) and awaits `TreeSitterRuntime.grammar` internally, so the first file of a given
 *  grammar simply pays that grammar's one-time compile cost inline. Wiring this registry into the
 *  actual index-run coordinator is a later phase's job (this task ships the seam, not the
 *  coordinator wiring — see the deferred list). */
export function createTreeSitterAdapterRegistry(): {
  registry: IndexAdapterRegistry;
  runtime: TreeSitterRuntime;
} {
  const runtime = new TreeSitterRuntime();
  const registry = new IndexAdapterRegistry()
    .register(createTreeSitterAdapter('typescript', runtime))
    .register(createTreeSitterAdapter('tsx', runtime))
    .register(createTreeSitterAdapter('javascript', runtime))
    .register(NOOP_ADAPTER);
  return { registry, runtime };
}
