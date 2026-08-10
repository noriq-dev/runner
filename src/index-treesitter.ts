import type { Node, Parser, Tree } from 'web-tree-sitter';
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
 * The tree-sitter `IndexParserAdapter` for TypeScript/JavaScript/TSX (RUN-216 shipped the seam;
 * RUN-217 is the real extraction below). What is real here: top-level and nested
 * function/class/method/interface/type/enum/namespace declarations, TS overload signatures
 * (`function_signature`/`method_signature`/`abstract_method_signature` — each gets its OWN entity,
 * locked decision 8), `describe`/`it`/`test` test blocks, static import specifiers (`import`,
 * re-export `export … from`, and CommonJS `require('literal')` on identical terms — discretion:
 * CommonJS earns its own arm because a repo mixing `require` and `import` should not lose half its
 * dependency graph), a CommonJS `exports.NAME =`/`module.exports.NAME = <function>` assignment
 * treated as a declaration the same way a function-valued `const NAME = …` already is, and
 * same-file call resolution with confidence (locked decision 7).
 *
 * **Declined, deliberately** (discretion — "a shape you cannot identify without type information
 * should be DECLINED, and a comment saying why beats a heuristic that is right most of the time"):
 * route/tool declarations (`app.get('/path', …)`, a `@Get('/path')` decorator, an RPC/tool
 * registration call) get no arm at all — which HTTP verb, which decorator name, which call shape
 * means "this is a route" is framework convention, not syntax a generic TS/JS grammar can see, and
 * this very repo has no such framework to measure against; a wrong guess here is worse than the
 * missing coverage. An anonymous `export default (...)`/`export default function(){}` also gets no
 * symbol — there is no name to hang an identity on, and inventing one (`'default'`) would not
 * survive the file gaining a second anonymous default export elsewhere in a refactor. Neither is a
 * TODO — see the specific `case`/absence below for where each decision actually lives.
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
/** `require('literal')` is a `call_expression`, not an `import_statement` — it needs its own arm
 *  to join `state.imports` at all (discretion: CommonJS "earns an arm" the same way a dynamic
 *  `import(expr)` never does, because a literal argument here is exactly as readable-without-
 *  execution as a static `import` specifier). Recognised ONLY as a bare call to the literal
 *  identifier `require` — `require.resolve(...)`, a shadowed local named `require`, or any other
 *  spelling is out of scope for the same reason a shadowed `it`/`describe` would be: this adapter
 *  has no scope analysis, only syntax. */
const REQUIRE_CALL_NAME = 'require';

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

/** `node.startPosition`/`endPosition` are tree-sitter's own 0-based rows — converted to the
 *  1-based, inclusive-both-ends spelling `index-adapters.ts`'s `SymbolRange` documents (the
 *  spelling a human reads in an editor/diff). Every symbol this adapter emits gets one: unlike
 *  RUN-218's non-tree-sitter adapters, a tree-sitter parse always knows a node's position, so there
 *  is no "no defensible span" case here to decline. Adding this field leaves `symbolPath` — the
 *  only thing a URI is built from (locked decision 9) — completely untouched. */
function pushSymbol(
  out: ParsedSymbol[],
  path: string[],
  label: string,
  node: Node,
  nodeType: ParsedSymbol['nodeType'] = 'symbol',
): void {
  out.push({
    symbolPath: path,
    nodeType,
    label,
    content: node.text,
    range: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
  });
}

/** Declarator name for `const NAME = <arrow function, function expression, or generator function
 *  expression>` — the common JS/TS "function stored in a variable" shape, alongside real
 *  `function_declaration`s. `generator_function` is the grammar's node type for a `function*` VALUE
 *  (as opposed to `generator_function_declaration`, a statement) — measured, not assumed. */
function functionValuedDeclaratorName(declarator: Node): string | null {
  const value = declarator.childForFieldName('value');
  if (
    !value ||
    (value.type !== 'arrow_function' &&
      value.type !== 'function_expression' &&
      value.type !== 'generator_function')
  ) {
    return null;
  }
  const name = declarator.childForFieldName('name');
  return name && name.type === 'identifier' ? name.text : null;
}

/**
 * `exports.NAME = <fn>` or `module.exports.NAME = <fn>` — CommonJS's own way of spelling the
 * function-valued declarator shape above. Returns `NAME` only for exactly those two receiver
 * shapes (a bare `exports` identifier, or `module.exports` as the inner member expression) so a
 * plain `foo.bar = function(){}` assignment on some unrelated object never gets mistaken for an
 * export. `module.exports = <fn>` (the WHOLE module is one function) is deliberately not matched
 * here — that is this file's anonymous-default-export case one level down (discretion: same
 * "nothing to hang identity on" reasoning), and returning `'exports'`/`'default'` for it would
 * invent a name the source never wrote.
 */
function commonJsExportName(assignment: Node): string | null {
  const left = assignment.childForFieldName('left');
  if (!left || left.type !== 'member_expression') return null;
  const property = left.childForFieldName('property');
  if (!property || property.type !== 'property_identifier') return null;

  const object = left.childForFieldName('object');
  if (object?.type === 'identifier' && object.text === 'exports') return property.text;
  if (object?.type === 'member_expression') {
    const innerObject = object.childForFieldName('object');
    const innerProperty = object.childForFieldName('property');
    if (
      innerObject?.type === 'identifier' &&
      innerObject.text === 'module' &&
      innerProperty?.type === 'property_identifier' &&
      innerProperty.text === 'exports'
    ) {
      return property.text;
    }
  }
  return null;
}

function walk(node: Node, ctx: WalkCtx, state: WalkState): void {
  switch (node.type) {
    // `generator_function_declaration` is `function* NAME(){}` as a STATEMENT (as opposed to
    // `generator_function`, the expression form `functionValuedDeclaratorName` matches below) —
    // same shape as an ordinary function declaration in every way this adapter cares about.
    case 'function_declaration':
    case 'generator_function_declaration': {
      const name = node.childForFieldName('name');
      if (name) {
        const path = [...(ctx.path ?? []), name.text];
        pushSymbol(state.symbols, path, name.text, node);
        walkChildren(node, { ...ctx, path }, state);
        return;
      }
      break;
    }
    // `abstract_class_declaration` is a class carrying the `abstract` modifier — a distinct
    // grammar node from `class_declaration`, not a flag on it (measured), but identical for
    // extraction: its own methods may be `method_definition` (concrete) or
    // `abstract_method_signature` (declared, no body) — both handled below.
    case 'class_declaration':
    case 'abstract_class_declaration': {
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
    // A TS overload GROUP — `function foo(a: string): void;` repeated with different parameter
    // types, then one implementation signature — is N+1 separate `function_signature` /
    // `function_declaration` nodes sharing one name (locked decision 8: each becomes its OWN
    // symbol entity here; `dedupeSymbolPaths` one layer up in `index-entity.ts` is what
    // disambiguates the repeated `symbolPath` into distinct URIs, never this file). An ambient
    // `declare function foo(): void;` parses the same way (see `parse errors/ambient` coverage) —
    // no body to recurse into either way, so this case never needs to update `ctx.path`.
    case 'function_signature': {
      const name = node.childForFieldName('name');
      if (name) pushSymbol(state.symbols, [...(ctx.path ?? []), name.text], name.text, node);
      break;
    }
    // The interface-body/abstract-class-body halves of the same overload story:
    // `method_signature` (an interface member, or a non-abstract overload signature inside a
    // class body) and `abstract_method_signature` (`abstract render(): void;`) both declare
    // without a body. Requires `ctx.path` the same way `method_definition` does — a signature
    // with nothing enclosing it is not attributable to anything.
    case 'method_signature':
    case 'abstract_method_signature': {
      const name = node.childForFieldName('name');
      if (name && ctx.path) pushSymbol(state.symbols, [...ctx.path, name.text], name.text, node);
      break;
    }
    // Unlike the group above, `interface_declaration` DOES nest its own path — a `method_signature`
    // inside its body must attribute to the interface, the same way a class's methods attribute to
    // the class.
    case 'interface_declaration': {
      const name = node.childForFieldName('name');
      if (name) {
        const path = [...(ctx.path ?? []), name.text];
        pushSymbol(state.symbols, path, name.text, node);
        walkChildren(node, { ...ctx, path }, state);
        return;
      }
      break;
    }
    // `type_alias_declaration`/`enum_declaration` never nest a path here: a type alias's own shape
    // (a function type, a mapped type, a union) has no declaration inside it this adapter
    // recognises, and an enum's members are values, not declarations.
    case 'type_alias_declaration':
    case 'enum_declaration': {
      const name = node.childForFieldName('name');
      if (name) pushSymbol(state.symbols, [...(ctx.path ?? []), name.text], name.text, node);
      break;
    }
    // `namespace Foo { … }` / `namespace A.B { … }` (parsed as `internal_module`, wrapped in an
    // `expression_statement` the default case below already walks through unchanged). A dotted
    // name (`nested_identifier`, `A.B`) is kept as ONE path segment via its own full `.text` rather
    // than split into `['A','B']` — splitting would make `namespace A.B` indistinguishable from a
    // namespace `A` nesting a namespace `B`, which is not what the source wrote.
    case 'internal_module': {
      const name = node.childForFieldName('name');
      const body = node.childForFieldName('body');
      if (name && body) {
        const path = [...(ctx.path ?? []), name.text];
        pushSymbol(state.symbols, path, name.text, node);
        walkChildren(body, { ...ctx, path }, state);
        return;
      }
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
    // CommonJS's own function-valued-declaration shape — see `commonJsExportName`'s own doc for
    // exactly which receivers qualify and which are deliberately left as a plain assignment
    // (`module.exports = …` alone, an anonymous default export in every way that matters here).
    case 'assignment_expression': {
      const exportName = commonJsExportName(node);
      const value = node.childForFieldName('right');
      const isFunctionValued =
        value?.type === 'function_expression' ||
        value?.type === 'arrow_function' ||
        value?.type === 'generator_function';
      if (exportName && value && isFunctionValued) {
        const path = [...(ctx.path ?? []), exportName];
        pushSymbol(state.symbols, path, exportName, node);
        walkChildren(value, { ...ctx, path }, state);
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
    if (callee.text === REQUIRE_CALL_NAME) {
      // A literal `require('x')` is exactly as readable-without-execution as a static `import`
      // specifier — join `state.imports` on identical terms (`REQUIRE_CALL_NAME`'s own doc).
      // `require(someExpr)` (label === null) is declined the same way a computed dynamic
      // `import(expr)` already is — by omission, never with a placeholder — and either way this is
      // never treated as an ordinary same-file call site: `require` is never a symbol this file
      // declares, so it would only decline there too, but routing it through `calls` at all would
      // blur "an import dependency" with "a same-file call", which are different edges on the wire.
      if (label !== null) state.imports.push({ specifier: label });
      return;
    }
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
    // (RUN-217 locked decision 7) tsx/jsx are TypeScript's and JavaScript's own syntax, not
    // separate POLICY languages — all three grammars declare the same two-entry list regardless of
    // which one actually parses a given file. `[index].languages` gating itself is RUN-219's job;
    // this only makes the field a true statement about what these adapters serve.
    languages: ['typescript', 'javascript'],
    canParse: (path) => grammarIdForPath(path) === grammar,
    parse: (input: AdapterParseInput): Promise<AdapterParseResult> => parseFile(grammar, runtime, input),
  };
}

async function parseFile(
  grammar: GrammarId,
  runtime: TreeSitterRuntime,
  input: AdapterParseInput,
): Promise<AdapterParseResult> {
  // RUN-238: `parser`/`tree` are freed in the `finally` below — see its own comment for why. Held
  // in outer-scope `let`s (not `const` inside the `try`) so that comment's cleanup reaches whichever
  // of the two ever got constructed, including a throw between them.
  let parser: Parser | undefined;
  let tree: Tree | null | undefined;
  try {
    // `TreeSitterRuntime.parserFor` awaits the cached grammar (compiled at most once — see this
    // adapter's own doc) and hands back a FRESH `Parser` bound to it: a `Parser` carries mutable
    // state (its own `tree`), so per-call construction is what keeps concurrent `parse()` calls
    // for different files from racing each other, while the expensive part (the grammar itself)
    // stays cached and shared.
    parser = await runtime.parserFor(grammar);
    tree = parser.parse(input.content);
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
  } finally {
    // RUN-238 (discovered load-testing "background-run coexistence" — this task's own title, not
    // only its single-pass event-loop finding): `web-tree-sitter`'s `Parser`/`Tree` hold
    // Emscripten/WASM-allocated memory that plain JS garbage collection never reclaims — there is
    // no `FinalizationRegistry` anywhere in that library (checked in `node_modules`), so `.delete()`
    // is the ONLY release, and this call site never made one. `walk()` above is fully synchronous
    // and every string this adapter returns (`node.text`, copied by tree-sitter's own getter) is
    // already a plain JS value by the time either object is used past this point, so freeing them
    // here costs nothing this adapter still needs. Measured, not theoretical: leaving this leaked
    // across a ~20000-file pass left the ONE process-wide WASM arena (`Parser.init()` is a single
    // shared Emscripten module — `treesitter-runtime.ts`'s own doc) bloated enough that a SECOND
    // full pass in the same process — exactly what a long-lived daemon does on every landing/poll
    // reindex — degraded from ~15s to effectively hung (still running past 3 minutes, confirmed via
    // `bench/index-load.mts`'s own determinism check, which runs two more full passes). The
    // `language` (grammar) this parser was bound to is deliberately NOT deleted here — it is
    // `TreeSitterRuntime`'s own cached, shared, reused-by-every-file object, and deleting a
    // `Parser` does not delete the `Language` it referenced.
    tree?.delete();
    parser?.delete();
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
