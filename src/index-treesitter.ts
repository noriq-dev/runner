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
import { shouldWithholdValue } from './index-redact';
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

// =============================================================================================
// C++ (RUN-239) — measured demand (Project Nod, the one Noriq-managed Unreal project: 137 .cpp +
// 120 .h, 53660 lines), not the task body's guessed language list (Go/Rust: zero files anywhere).
//
// **Node-type mapping, the substantive judgement this adapter makes**: a free function
// (`function_definition`/`declaration` whose declarator resolves to a bare `identifier`), a class
// or struct (`class_specifier`/`struct_specifier`, requiring BOTH a `name` and a `body` field —
// see "locally broken" below for why a bodyless one is declined rather than treated as a forward
// declaration worth a symbol), and a method (the same declarator resolution, nested under the
// class either because it is LEXICALLY inside the class body — `field_identifier`/
// `destructor_name` declarators — or because it is an out-of-class definition whose
// `qualified_identifier` declarator names the class explicitly, e.g. `Widget::doThing`). A
// `namespace` becomes a symbol the same way a class does, nesting its members exactly like
// `index-treesitter.ts`'s existing TS `internal_module` handling. `enum_specifier`, `using`
// (`alias_declaration`), and `typedef` (`type_definition`) each become ONE symbol, no nested
// members — the same "the declaration is the fact, its innards are not" rule the TS adapter
// already applies to `enum_declaration`.
//
// **Header declaration vs. implementation definition: TWO symbols, not one** (the discretion item
// this task calls out explicitly). `void Widget::doThing();` in a header and
// `void Widget::doThing() { … }` in a .cpp both resolve to the identical `symbolPath`
// `['Widget', 'doThing']` — matching, on purpose, so `index-entity.ts`'s `dedupeSymbolPaths`
// disambiguates them into two distinct entities the SAME way it already disambiguates a TS
// overload group (`index-treesitter.ts`'s own locked decision 8, reused verbatim rather than
// invented fresh). Merging them into ONE entity would require deciding "is this declaration the
// same as that definition", a semantic question this per-file, no-type-information adapter cannot
// answer even within a single file — let alone across the header/implementation split, which is
// usually two different files this adapter never sees together at all (`index-adapters.ts`'s own
// "one file at a time" constraint). Emitting two is the conservative, honest answer: it never
// claims an identity link this adapter cannot back.
//
// **A `qualified_identifier` scope that is itself a template instantiation
// (`Container<T>::method`) DECLINES** — `resolveScopeChain` only resolves a `namespace_identifier`
// or another `qualified_identifier`, never a `template_type`. The type argument the source spells
// out is not stable identity text the way a namespace or class name is (which instantiation is
// "the" `Container<T>`?), so an out-of-line templated method definition gets no symbol rather than
// a guessed one. A real coverage gap on template-heavy code, taken deliberately.
//
// **`.h` is parsed as C++, unconditionally** (discretion) — there is no C grammar on the same
// inlining rail and zero measured demand for one (Project Nod's 8 `.cs`/0 `.c` files are the only
// non-C++ source in the one repo with real C++ demand). A plain C header mostly still parses (the
// declarative subset this adapter reads — functions, structs, enums, typedefs — is a near-superset
// in the C++ grammar); a construct that does not degrades through the same "locally broken" and
// "unresolved declarator" declines as any other unparseable C++.
//
// **No `test`/`api` node type, unlike the TS adapter's `describe`/`it`** — there is no single
// dominant C++ test-macro convention the way JS has one: gtest's `TEST`/`TEST_F`, Catch2's
// `TEST_CASE`, and Unreal's own `IMPLEMENT_SIMPLE_AUTOMATION_TEST` macro family are three
// incompatible call/macro shapes, and guessing one framework's spelling is exactly the "a wrong
// guess is worse than the missing coverage" case this same file's TS adapter already declined for
// route decorators. Every C++ symbol this adapter emits is `nodeType: 'symbol'`.
//
// **A declaration whose own parse tree contains an ERROR/MISSING node anywhere inside it is
// declined WHOLESALE — no symbol, no recursion into it** (`isCppNodeBroken` below). This is
// COARSER than the TS/JS adapter's one-diagnostic-per-file design, which still trusts declarations
// found outside a narrow local ERROR region (this file's own doc, "Isolation is TWO-LAYERED") —
// deliberately revisited here because MEASURED real C++ breaks the assumption that a nearby error
// stays nearby. Sampling all 227 `.cpp`/`.h` files in Project Nod's `Source/` tree: 97 (42.7%)
// contain at least one parse-error node. One shape measured directly — `class SURVIVAL_API
// UC_InventoryComponent : public UActorComponent` mis-parses so that the `class_specifier`'s OWN
// `name` field becomes the literal token `SURVIVAL_API`, not the real class name — is real and is
// exactly why this gate is per-DECLARATION rather than per-file: the corruption does not sit near
// the identity this adapter would extract, it IS the identity, and admitting it would fabricate a
// symbol. Declining any node whose subtree `hasError` is what catches that specific misparse
// without mass-declining whole files: the check is per DECLARATION node (a `class_specifier`, a
// `function_definition`, …), never per container (`namespace_definition` is never gated this way,
// so ONE broken member does not take its siblings down with it) and never per file.
//
// **CORRECTION, measured**: the `<MODULE>_API` export macro above is NOT what causes most of those
// 97 (now 114/257 on a later, larger sample — see below) parse errors, and an earlier version of
// this comment claimed it was. Blanking every `\b[A-Z][A-Z0-9_]*_API\b` token (equal-length spaces)
// across all 257 real `.cpp`/`.h` files and re-parsing left the error count IDENTICAL — 114/257,
// not one file improved. Clustering the actual first ERROR/MISSING node per failing file found
// three real causes instead, none of them the export macro: `GENERATED_BODY()` and its
// `_UCLASS_BODY`/`_IINTERFACE_BODY`/`_USTRUCT_BODY` siblings — call-shaped with NO trailing `;`
// inside a class body, so the grammar's recovery reports a MISSING semicolon and loses whatever
// follows in that scope (82/114 files); `UMETA(...)` breaking a `UENUM`'s enumerator list
// (23/114); and the `DECLARE_..._DELEGATE...(...)` macro family (9/114). `blankCppMacroNoise`
// below blanks exactly those three, measured to actually help — see its own doc for the numbers
// and why `UCLASS`/`USTRUCT`/`UPROPERTY`/`UFUNCTION` are deliberately left untouched.
// =============================================================================================

const CPP_ADAPTER_VERSION = '1';

/** Extensions this adapter claims — the two Project Nod actually has (`.cpp`/`.h`) plus the
 *  standard C++ variants sharing the identical grammar (discretion). `.inl`/`.ipp` are NOT
 *  claimed: those conventionally hold textual fragments meant to be `#include`d mid-declaration
 *  (a class body, a template definition continued from elsewhere) rather than a standalone
 *  translation unit, so a generic file-level parse is far more likely to see a dangling fragment
 *  than a real declaration — no measured demand either way, so left off rather than guessed at. */
const CPP_EXTENSION_RE = /\.(?:cpp|cc|cxx|h|hpp|hh)$/i;

/**
 * MEASURED cause of most of this grammar's parse errors on real Unreal C++ — corrected from an
 * earlier (wrong) belief that a `<MODULE>_API` export macro before the class name was the culprit
 * (blanking every `_API` token across all 257 real Project Nod `.cpp`/`.h` files left the error
 * count IDENTICAL, 114/257, not one file improved; see this section's own doc). Clustering the
 * actual first ERROR/MISSING node per failing file found these three instead:
 *
 * - `GENERATED_BODY()` and its `_UCLASS_BODY`/`_IINTERFACE_BODY`/`_USTRUCT_BODY` siblings —
 *   call-shaped, no trailing `;`, inside a class body: the grammar reports a MISSING semicolon and
 *   loses whatever follows in that scope. 82 of the 114 failing files.
 * - `UMETA(...)` inside a `UENUM`'s enumerator list. 23 of the 114.
 * - `DECLARE_..._DELEGATE...(...)` (`DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam`,
 *   `_FourParams`, …). 9 of the 114.
 *
 * `UCLASS`/`USTRUCT`/`UPROPERTY`/`UFUNCTION` are deliberately NOT included — they already parse as
 * ordinary call expressions (measured) and no symbol gain was measured from blanking them; adding
 * them without a measured reason would be exactly the guess this task's "measure, don't assert"
 * instruction forbids.
 *
 * These are TEXT-level patterns, not syntax-aware — a match inside a string literal or a comment
 * would be blanked too (a known, accepted limitation of this technique, not something this task
 * attempts to fix by parsing comments/strings out first).
 */
const CPP_MACRO_NOISE_PATTERNS: readonly RegExp[] = [
  /\bGENERATED_(?:BODY|UCLASS_BODY|IINTERFACE_BODY|USTRUCT_BODY)\s*\(\s*\)/g,
  /\bUMETA\s*\([^)]*\)/g,
  /\bDECLARE_[A-Z_]*DELEGATE[A-Za-z_]*\s*\([^;]*?\)\s*;/g,
];

/** Blank every character of a matched macro invocation to a space, EXCEPT an embedded newline,
 *  which is kept as-is — see `CPP_MACRO_NOISE_PATTERNS`' own doc. A byte-for-byte space-fill that
 *  also blanked newlines would collapse a multi-line `DECLARE_..._DELEGATE...(...)` call's line
 *  count, silently shifting the `SymbolRange` of every symbol declared after it in the same file. */
function blankPreservingNewlines(match: string): string {
  return match.replace(/[^\n]/g, ' ');
}

/**
 * Blank `CPP_MACRO_NOISE_PATTERNS` to EQUAL-LENGTH spaces, never delete — the property the whole
 * approach rests on (asserted directly in `test/index-treesitter.test.ts`, not just claimed here):
 * blanking preserves `content.length` exactly, so `node.startIndex`/`endIndex`/`startPosition`/
 * `endPosition` computed against the BLANKED text remain valid offsets into the ORIGINAL text too.
 * This is what lets `parseCppFile` parse a throwaway blanked copy while every symbol's `content`
 * and `range` still describe real, unmodified source (see `pushCppSymbol`) — the file entity
 * itself (`indexer.ts`'s own mint, outside this adapter entirely) never sees this transform at
 * all, only `AdapterParseInput.content` as the caller supplied it.
 */
export function blankCppMacroNoise(content: string): string {
  let out = content;
  for (const pattern of CPP_MACRO_NOISE_PATTERNS) {
    out = out.replace(pattern, (m) => blankPreservingNewlines(m));
  }
  return out;
}

interface CppCallSite {
  fromPath: string[] | null;
  calleeName: string;
  isThisMember: boolean;
  enclosingClass: string | null;
}

interface CppWalkState {
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  callSites: CppCallSite[];
  /** The TRUE, un-blanked source text — every symbol's `content` is sliced from THIS (via
   *  `node.startIndex`/`endIndex`), never `node.text`, which would read off the blanked tree
   *  `parseCppFile` actually parsed. See `blankCppMacroNoise`'s own doc. */
  originalContent: string;
}

interface CppWalkCtx {
  path: string[] | null;
  enclosingClass: string | null;
}

/** See this section's own doc, "A declaration whose own parse tree contains an ERROR/MISSING node
 *  ... is declined WHOLESALE". `node.hasError` is tree-sitter's own "this node or any descendant
 *  is an ERROR/MISSING node" — exactly the granularity needed to catch a misparsed declarator
 *  without punishing an unrelated sibling declaration. */
function isCppNodeBroken(node: Node): boolean {
  return node.hasError;
}

function pushCppSymbol(state: CppWalkState, path: string[], label: string, node: Node): void {
  state.symbols.push({
    symbolPath: path,
    nodeType: 'symbol',
    label,
    // Sliced from the ORIGINAL text, not `node.text` — see `CppWalkState.originalContent`'s doc.
    // Valid because blanking is length- and offset-preserving by construction.
    content: state.originalContent.slice(node.startIndex, node.endIndex),
    range: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
  });
}

/** The child of a C++ `string_literal` (`"like/this"`) that actually holds text, stripped of its
 *  own quote delimiters — mirrors `literalStringValue` above one grammar over; a different node
 *  type (`string_literal` vs. TS's `string`) rules out sharing the one function directly. */
function cppStringLiteralContent(node: Node): string | null {
  const fragment = node.namedChildren.find((c) => c?.type === 'string_content');
  return fragment ? fragment.text : null;
}

/** Peel `pointer_declarator`/`reference_declarator` layers a RETURN-type modifier adds
 *  (`int* getPtr()`, `Foo& operator=(...)`) down to the `function_declarator` underneath. Returns
 *  `null` — decline — for anything that does not bottom out at one, which is exactly what a
 *  function-POINTER VARIABLE declaration does instead (`int (*fnPtr)(int, int);` parses as a
 *  `function_declarator` whose OWN `declarator` field is a `parenthesized_declarator`, never a
 *  name): unwrapping through THAT shape too would extract `fnPtr` as if it were a function
 *  declaration, which is exactly the ambiguity may-miss-never-invent exists to decline rather than
 *  guess through — the grammar does not disambiguate "function returning a pointer" from "variable
 *  holding a function pointer" any more precisely than this. */
function unwrapToFunctionDeclarator(node: Node | null): Node | null {
  let current = node;
  while (current && (current.type === 'pointer_declarator' || current.type === 'reference_declarator')) {
    current = current.childForFieldName('declarator');
  }
  return current && current.type === 'function_declarator' ? current : null;
}

/** The scope segments of a `qualified_identifier`'s own `scope` field — a single
 *  `namespace_identifier` (`Widget::doThing`'s scope is just `Widget`) or, recursively, a nested
 *  `qualified_identifier` (`A::B::method`'s outer scope is itself `A::B`). `null` — decline — for
 *  anything else, most importantly `template_type` (`Container<T>::method`): see this section's
 *  own doc for why a template argument is not stable identity text. */
function resolveScopeChain(node: Node | null): string[] | null {
  if (!node) return null;
  if (node.type === 'namespace_identifier') return [node.text];
  if (node.type === 'qualified_identifier') {
    const scope = resolveScopeChain(node.childForFieldName('scope'));
    const name = node.childForFieldName('name');
    if (!scope || !name || name.type !== 'identifier') return null;
    return [...scope, name.text];
  }
  return null;
}

/** `~Widget` for a `destructor_name` node — its own `identifier` child, prefixed the way the
 *  source itself spells a destructor, never the bare class name alone (which would collide with
 *  the constructor's own symbolPath). */
function destructorLabel(node: Node): string | null {
  const inner = node.namedChildren.find((c) => c?.type === 'identifier');
  return inner ? `~${inner.text}` : null;
}

/** Resolve a `function_declarator`'s own `declarator` field to a name plus the scope segments a
 *  `qualified_identifier` (an out-of-class definition) carries — `{ scopeSegments: [], name }` for
 *  a plain `identifier`/`field_identifier`/`destructor_name` (a free function, an inline method, an
 *  inline destructor), non-empty `scopeSegments` for `Widget::doThing`. `operator_name` (operator
 *  overloads) DECLINES, deliberately (discretion): canonicalizing `operator[]` vs. `operator ()`
 *  spacing/spelling is a real ambiguity this adapter chooses not to guess through, the same
 *  "declined, deliberately" posture the TS adapter takes for route decorators. Anything else
 *  (a `parenthesized_declarator`, …) declines the same way. */
function resolveFunctionDeclaratorName(fnDeclarator: Node): { scopeSegments: string[]; name: string } | null {
  const declarator = fnDeclarator.childForFieldName('declarator');
  if (!declarator) return null;
  switch (declarator.type) {
    case 'identifier':
    case 'field_identifier':
      return { scopeSegments: [], name: declarator.text };
    case 'destructor_name': {
      const label = destructorLabel(declarator);
      return label ? { scopeSegments: [], name: label } : null;
    }
    case 'qualified_identifier': {
      const scopeSegments = resolveScopeChain(declarator.childForFieldName('scope'));
      const nameNode = declarator.childForFieldName('name');
      if (!scopeSegments || !nameNode) return null;
      if (nameNode.type === 'identifier') return { scopeSegments, name: nameNode.text };
      if (nameNode.type === 'destructor_name') {
        const label = destructorLabel(nameNode);
        return label ? { scopeSegments, name: label } : null;
      }
      return null;
    }
    default:
      return null;
  }
}

/** The full extraction for a `function_definition`/`declaration`/`field_declaration`'s OWN
 *  `declarator` field: unwrap any pointer/reference return-type wrapping, resolve the underlying
 *  `function_declarator`'s name, and prefix with `pathPrefix` (the enclosing namespace/class path
 *  already accumulated by the walk) plus any scope the declarator's own qualified name carries.
 *  `null` — decline, no symbol — for a plain variable declaration, an operator overload, a
 *  function-pointer variable, or anything `resolveFunctionDeclaratorName` already declines. */
function resolveDeclaredFunctionPath(
  outerDeclarator: Node | null,
  pathPrefix: readonly string[],
): { path: string[]; scopeSegments: string[] } | null {
  const fnDeclarator = unwrapToFunctionDeclarator(outerDeclarator);
  if (!fnDeclarator) return null;
  const resolved = resolveFunctionDeclaratorName(fnDeclarator);
  if (!resolved) return null;
  return {
    path: [...pathPrefix, ...resolved.scopeSegments, resolved.name],
    scopeSegments: resolved.scopeSegments,
  };
}

/** `call_expression.function` — a bare `identifier` (`add(1, 2)`) or a `this->member()`
 *  `field_expression` (the C++ spelling of TS's `this.member()`; `argument`/`field` are its own
 *  field names). Any other receiver (`obj.method()`, `obj->method()` where `obj` is not `this`,
 *  `Namespace::freeFn()`, a computed callee) declines by simply recording no call site — the same
 *  posture `index-treesitter.ts`'s TS adapter already takes for every member expression that is
 *  not `this`. */
function recordCppCallSite(node: Node, ctx: CppWalkCtx, state: CppWalkState): void {
  const callee = node.childForFieldName('function');
  if (callee?.type === 'identifier') {
    state.callSites.push({
      fromPath: ctx.path,
      calleeName: callee.text,
      isThisMember: false,
      enclosingClass: ctx.enclosingClass,
    });
  } else if (callee?.type === 'field_expression') {
    const argument = callee.childForFieldName('argument');
    const field = callee.childForFieldName('field');
    if (argument?.type === 'this' && field?.type === 'field_identifier') {
      state.callSites.push({
        fromPath: ctx.path,
        calleeName: field.text,
        isThisMember: true,
        enclosingClass: ctx.enclosingClass,
      });
    }
  }
}

function walkCppChildren(node: Node, ctx: CppWalkCtx, state: CppWalkState): void {
  for (const child of node.namedChildren) {
    if (child) walkCpp(child, ctx, state);
  }
}

function walkCpp(node: Node, ctx: CppWalkCtx, state: CppWalkState): void {
  switch (node.type) {
    // A `namespace` never itself gated on `hasError` (see this section's own doc) — its role is
    // purely a CONTAINER, and each member declared inside is independently gated when the walk
    // reaches it, the same way a file-level error never blanks out unrelated declarations.
    case 'namespace_definition': {
      const name = node.childForFieldName('name');
      const body = node.childForFieldName('body');
      if (name && body) {
        const path = [...(ctx.path ?? []), name.text];
        pushCppSymbol(state, path, name.text, node);
        walkCppChildren(node, { ...ctx, path }, state);
        return;
      }
      // An anonymous `namespace { … }` (no `name` field) — falls through to the generic walk
      // below with `ctx` UNCHANGED: its members belong to the enclosing scope, exactly C++'s own
      // semantics for an unnamed namespace, so this is not "declined", only "not itself named".
      break;
    }
    case 'class_specifier':
    case 'struct_specifier': {
      if (isCppNodeBroken(node)) return;
      const name = node.childForFieldName('name');
      const body = node.childForFieldName('body');
      // BOTH fields required: a bodyless `class Foo;` (a genuine forward declaration, nothing to
      // attribute members to) and the exact `SURVIVAL_API`-as-classname misparse this section's
      // doc measures (whose `class_specifier` carries `name` but never `body`, because the real
      // body landed inside a sibling ERROR node instead) both decline the identical way.
      if (name && body) {
        const path = [...(ctx.path ?? []), name.text];
        pushCppSymbol(state, path, name.text, node);
        walkCppChildren(node, { path, enclosingClass: name.text }, state);
        return;
      }
      break;
    }
    case 'function_definition': {
      if (isCppNodeBroken(node)) return;
      const resolved = resolveDeclaredFunctionPath(node.childForFieldName('declarator'), ctx.path ?? []);
      if (resolved) {
        pushCppSymbol(state, resolved.path, resolved.path.at(-1)!, node);
        // An out-of-class definition (`Widget::doThing`) sets `enclosingClass` from its OWN
        // qualified scope, not the lexical namespace it happens to sit in — a `this->x()` call
        // inside it resolves against `Widget`'s methods regardless of which namespace block wraps
        // the definition. An inline definition (empty `scopeSegments`) keeps whatever
        // `enclosingClass` the surrounding `class_specifier` already set.
        const enclosingClass =
          resolved.scopeSegments.length > 0 ? resolved.scopeSegments.at(-1)! : ctx.enclosingClass;
        walkCppChildren(node, { path: resolved.path, enclosingClass }, state);
        return;
      }
      break;
    }
    // `declaration` (a bodyless forward declaration — the .h half of a header/implementation
    // split, or a ctor/dtor declared but not defined in a class body) and `field_declaration` (a
    // declared-only method WITH a return type, or a data member) share the identical
    // declarator-resolution rule: if it names a function, one symbol, no recursion (nothing to
    // recurse into); if not (a plain variable, or a nested class/struct/enum declared as this
    // field's own `type` — tree-sitter-cpp's own shape for `class Bar { class Inner {...}; };`),
    // decline and fall through to the generic walk, which visits any such nested declaration on
    // its own terms via the `class_specifier` case above.
    case 'declaration':
    case 'field_declaration': {
      if (isCppNodeBroken(node)) return;
      const resolved = resolveDeclaredFunctionPath(node.childForFieldName('declarator'), ctx.path ?? []);
      if (resolved) {
        pushCppSymbol(state, resolved.path, resolved.path.at(-1)!, node);
        return;
      }
      break;
    }
    // Members are values, not declarations — same rule the TS adapter already applies to
    // `enum_declaration`; only the enum's own name becomes a symbol.
    case 'enum_specifier': {
      if (isCppNodeBroken(node)) return;
      const name = node.childForFieldName('name');
      if (name) pushCppSymbol(state, [...(ctx.path ?? []), name.text], name.text, node);
      break;
    }
    case 'alias_declaration': {
      if (isCppNodeBroken(node)) return;
      const name = node.childForFieldName('name');
      if (name) pushCppSymbol(state, [...(ctx.path ?? []), name.text], name.text, node);
      break;
    }
    case 'type_definition': {
      if (isCppNodeBroken(node)) return;
      const declarator = node.childForFieldName('declarator');
      // Only the simple `typedef <type> Name;` shape is read — a function-pointer or array-shaped
      // typedef declarator declines the same way an equivalently-shaped variable declaration does.
      if (declarator?.type === 'type_identifier') {
        pushCppSymbol(state, [...(ctx.path ?? []), declarator.text], declarator.text, node);
      }
      break;
    }
    case 'preproc_include': {
      const pathNode = node.childForFieldName('path');
      if (pathNode?.type === 'system_lib_string') {
        // `<string>` — angle-bracket includes are never file-relative, so the specifier is kept
        // literal (stripped of its own `<`/`>`) rather than normalized: `resolveRelativeImport`
        // declines any specifier not starting with `.` regardless, the same way a bare TS
        // `import 'react'` already declines with no special-casing needed here.
        const text = pathNode.text;
        if (text.length >= 2) state.imports.push({ specifier: text.slice(1, -1) });
      } else if (pathNode?.type === 'string_literal') {
        const content = cppStringLiteralContent(pathNode);
        // Quoted includes search the INCLUDING FILE'S OWN DIRECTORY first — the C++ standard's own
        // quoted-include rule, not a framework guess — so a specifier with no leading `.` is
        // normalized to one (`Foo.h` -> `./Foo.h`) purely so `resolveRelativeImport`'s existing
        // bare-vs-relative dispatch (index-adapters.ts's own doc) treats it as relative, matching
        // language semantics rather than inventing a resolution rule of this adapter's own.
        if (content !== null) {
          state.imports.push({ specifier: content.startsWith('.') ? content : `./${content}` });
        }
      }
      break;
    }
    case 'call_expression': {
      recordCppCallSite(node, ctx, state);
      break;
    }
    default:
      break;
  }
  walkCppChildren(node, ctx, state);
}

/** Same-file call resolution — structurally identical to `resolveCalls` above (bare identifier
 *  resolves only against an unambiguous TOP-LEVEL, i.e. unnamespaced, declaration;
 *  `this->member()` resolves only against the enclosing class's own methods, at `'inferred'`
 *  confidence). Kept as its own function rather than sharing `resolveCalls` directly: the two
 *  languages' `CallSite`/`WalkState` shapes coincide today by construction, not by a documented
 *  contract, and C++ is the more likely of the two to need call resolution that TS's rule cannot
 *  express (argument-count-based overload disambiguation, say) — sharing now would mean un-sharing
 *  later under exactly the kind of change most likely to need it. */
function resolveCppCalls(state: CppWalkState): ParsedCall[] {
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
    if (!site.fromPath) continue;
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

async function parseCppFile(
  runtime: TreeSitterRuntime,
  input: AdapterParseInput,
): Promise<AdapterParseResult> {
  // See `parseFile` above for why `parser`/`tree` are freed in `finally` (RUN-238) and why this
  // isolation is deliberately two-layered with `indexer.ts`'s own per-adapter try/catch.
  let parser: Parser | undefined;
  let tree: Tree | null | undefined;
  try {
    parser = await runtime.parserFor('cpp');
    // Parse a BLANKED COPY (see `blankCppMacroNoise`'s own doc) — `input.content` itself is never
    // mutated, and the caller's file entity (`indexer.ts`, outside this adapter) mints its own
    // content from that same untouched `input.content`, never from anything this function does.
    tree = parser.parse(blankCppMacroNoise(input.content));
    if (!tree) {
      return { symbols: [], diagnostics: [{ message: 'tree-sitter returned no tree', severity: 'error' }] };
    }
    const state: CppWalkState = { symbols: [], imports: [], callSites: [], originalContent: input.content };
    walkCpp(tree.rootNode, { path: null, enclosingClass: null }, state);

    const diagnostics: ParsedDiagnostic[] = [];
    if (tree.rootNode.hasError) {
      const errorCount = countParseErrors(tree.rootNode);
      diagnostics.push({
        message: `${errorCount} syntax error location(s) — some declarations may be missing or incomplete`,
        severity: 'warning',
      });
    }

    return { symbols: state.symbols, diagnostics, imports: state.imports, calls: resolveCppCalls(state) };
  } catch (err) {
    return {
      symbols: [],
      diagnostics: [
        {
          message: `tree-sitter-cpp threw while parsing: ${err instanceof Error ? err.message : String(err)}`,
          severity: 'error',
        },
      ],
    };
  } finally {
    tree?.delete();
    parser?.delete();
  }
}

export function createCppTreeSitterAdapter(runtime: TreeSitterRuntime): IndexParserAdapter {
  return {
    id: 'tree-sitter-cpp',
    version: CPP_ADAPTER_VERSION,
    languages: ['cpp'],
    canParse: (path) => CPP_EXTENSION_RE.test(path),
    parse: (input) => parseCppFile(runtime, input),
  };
}

// =============================================================================================
// ini (RUN-239) — Unreal's 6 `.ini` config files; `tree-sitter-ini.wasm` is 4,716 bytes, effectively
// free on the same inlining rail the C++ grammar above justifies on its own. Flat by construction
// (a `document` of top-level `setting`s and `section`s, each `section` holding its own `setting`s
// — no further nesting the grammar exposes), so this adapter reads the tree directly rather than
// needing the recursive walk C++/TS require. Claims any `.ini`, not only Unreal's `Config/*.ini`
// (discretion) — the grammar and shape are generic, and narrowing to a path convention would be a
// judgement call about repo layout this daemon otherwise avoids (`DEFAULT_EXCLUDE_GLOBS`'s own
// doc, `index-policy.ts`, states the same principle for a different list).
//
// Every symbol is `nodeType: 'symbol'`, `content` gated through `shouldWithholdValue` exactly like
// `index-formats.ts`'s JSON/TOML leaves (same key=value shape, same secret-shaped-value risk —
// reusing that check rather than inventing a second one). A malformed section header (no closing
// `]`, or nothing between the brackets) DECLINES the whole section — no guessed name — the same
// "no defensible identity, no symbol" posture as every other adapter in this file.
// =============================================================================================

const INI_ADAPTER_VERSION = '1';

/** `pathPrefix` is `[]` for a top-level setting (no enclosing section) or `[sectionName]` for one
 *  nested under a section — `null` when `node` carries no `setting_name` at all, which the ini
 *  grammar never actually emits for a `setting` node, but is checked anyway rather than assumed
 *  (a total function, no non-null assertion). */
function iniSettingSymbol(node: Node, pathPrefix: readonly string[]): ParsedSymbol | null {
  const nameNode = node.namedChildren.find((c) => c?.type === 'setting_name');
  if (!nameNode) return null;
  const valueNode = node.namedChildren.find((c) => c?.type === 'setting_value');
  const key = nameNode.text;
  const value = valueNode ? valueNode.text.trim() : '';
  const withheldReason = shouldWithholdValue(key, value);
  return {
    symbolPath: [...pathPrefix, key],
    nodeType: 'symbol',
    label: key,
    content: withheldReason ? null : value,
    range: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
  };
}

function parseIniDocument(tree: Tree): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  for (const child of tree.rootNode.namedChildren) {
    if (!child) continue;
    if (child.type === 'setting') {
      const sym = iniSettingSymbol(child, []);
      if (sym) symbols.push(sym);
      continue;
    }
    if (child.type !== 'section') continue;
    const sectionNameNode = child.namedChildren.find((c) => c?.type === 'section_name');
    const textNode = sectionNameNode?.namedChildren.find((c) => c?.type === 'text');
    if (!textNode || textNode.text.trim().length === 0) continue; // malformed/empty header — decline the section
    const sectionName = textNode.text;
    symbols.push({
      symbolPath: [sectionName],
      nodeType: 'symbol',
      label: sectionName,
      content: null,
      range: {
        startLine: sectionNameNode!.startPosition.row + 1,
        endLine: sectionNameNode!.endPosition.row + 1,
      },
    });
    for (const settingNode of child.namedChildren) {
      if (settingNode?.type !== 'setting') continue;
      const sym = iniSettingSymbol(settingNode, [sectionName]);
      if (sym) symbols.push(sym);
    }
  }
  return symbols;
}

async function parseIniFile(
  runtime: TreeSitterRuntime,
  input: AdapterParseInput,
): Promise<AdapterParseResult> {
  let parser: Parser | undefined;
  let tree: Tree | null | undefined;
  try {
    parser = await runtime.parserFor('ini');
    tree = parser.parse(input.content);
    if (!tree) {
      return { symbols: [], diagnostics: [{ message: 'tree-sitter returned no tree', severity: 'error' }] };
    }
    const symbols = parseIniDocument(tree);
    const diagnostics: ParsedDiagnostic[] = tree.rootNode.hasError
      ? [{ message: 'ini parse error(s) — some settings may be missing or incomplete', severity: 'warning' }]
      : [];
    return { symbols, diagnostics };
  } catch (err) {
    return {
      symbols: [],
      diagnostics: [
        {
          message: `tree-sitter-ini threw while parsing: ${err instanceof Error ? err.message : String(err)}`,
          severity: 'error',
        },
      ],
    };
  } finally {
    tree?.delete();
    parser?.delete();
  }
}

export function createIniTreeSitterAdapter(runtime: TreeSitterRuntime): IndexParserAdapter {
  return {
    id: 'tree-sitter-ini',
    version: INI_ADAPTER_VERSION,
    languages: ['ini'],
    canParse: (path) => path.toLowerCase().endsWith('.ini'),
    parse: (input) => parseIniFile(runtime, input),
  };
}

/** Builds a registry with all five tree-sitter adapters ahead of `NOOP_ADAPTER`, sharing one
 *  `TreeSitterRuntime` — the shape a caller (a future indexer coordinator wiring) uses to get real
 *  TS/JS/TSX/C++/ini coverage; `index-adapters.ts`'s own `createDefaultAdapterRegistry()` deliberately stays
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
    .register(createCppTreeSitterAdapter(runtime))
    .register(createIniTreeSitterAdapter(runtime))
    .register(NOOP_ADAPTER);
  return { registry, runtime };
}
