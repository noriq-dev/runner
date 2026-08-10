import { TomlError, parse as parseToml } from 'smol-toml';
import type {
  AdapterParseResult,
  IndexParserAdapter,
  ParsedDiagnostic,
  ParsedReference,
  ParsedSymbol,
} from './index-adapters';
import { scanTextForSecretShapedContent, shouldWithholdValue } from './index-redact';

/**
 * The Markdown / JSON / TOML `IndexParserAdapter`s (RUN-218) — the non-tree-sitter half of the
 * adapter registry `index-adapters.ts` defines and `index-treesitter.ts` (RUN-216) already fills
 * for TypeScript/JavaScript. Three adapters, one file, because JSON and TOML share one recursive
 * value-walker after their own parse step, and markdown is small enough not to earn a file of its
 * own.
 *
 * **Markdown is HAND-ROLLED and line-oriented** (locked decision 6) — no markdown dependency, no
 * tree-sitter. It recognises ATX headings (`# Heading`) starting at column 0, fenced code blocks
 * (``` or ~~~), and inline `[text](url)` links — the subset that is exactly line-recognisable,
 * which is what "heading anchors and ranges are deterministic" needs. Setext headings (`===`
 * underlines) and reference-style links (`[text][ref]` plus a separate `[ref]: url` definition)
 * are DECLINED — a full CommonMark implementation is out of scope for a hand-rolled adapter, and
 * ATX + inline links already cover the overwhelming majority of real repository markdown.
 *
 * **Link and code-reference targets are `symbol` ENTITIES, never `ParsedImport` specifiers** — a
 * correction made after this task first landed, once a concurrent RUN-217 change gave
 * `indexer.ts` a real consumer for `AdapterParseResult.imports`: it resolves a `.`-leading
 * specifier into a wire `imports` edge, which means MODULE dependency on that wire, not "this
 * document mentions that path". A markdown link is not a module dependency, so routing it through
 * `imports` would mint a wire edge with the wrong meaning. Since RUN-257 they are ALSO
 * `ParsedReference`s — a second, complementary output the `symbol` entity does not replace — so a
 * resolvable reference gets a typed `related_to` edge too. See `parseMarkdown`'s own doc, right
 * above where both are built, for the full reasoning and why keeping both is not the same
 * duplication `AdapterParseResult.imports`'s edge would have been.
 *
 * **JSON is `JSON.parse`; TOML is `smol-toml`** (locked decision 7 — `smol-toml` is already a
 * runtime dependency, used by `config.ts`/`discovery.ts`/`workflow-store.ts`, so `.noriq/
 * project.toml` is never parsed by two disagreeing parsers). Both adapters feed the SAME
 * `walkConfigValue` once parsed — a JS value tree from either parser is structurally identical
 * (nested plain objects, arrays, primitives), so there is exactly one recursive extractor to keep
 * correct rather than two that could drift.
 *
 * **A parse failure is a FILE DIAGNOSTIC, never a throw, never a dropped file entity** (locked
 * decision 8). Measured, not assumed (see `index-redact.ts`'s sibling caution and this task's own
 * warning to verify): both `JSON.parse`'s thrown `SyntaxError.message` and smol-toml's thrown
 * `TomlError.message`/`.codeblock` embed a PREVIEW OF THE RAW SOURCE TEXT next to the parser's own
 * complaint (`JSON.parse('{"a": SECRET...')` throws `Unexpected token 'S', "{"a": SECRET"... is
 * not valid JSON`; smol-toml's `TomlError` builds a `codeblock` containing the literal offending
 * line). Putting either `.message` verbatim into a diagnostic would leak exactly the content this
 * whole task exists to withhold, through a channel none of `index-redact.ts`'s checks ever sees.
 * So neither adapter ever reads `err.message` on a parse failure: the JSON diagnostic is a fixed,
 * content-free string; the TOML diagnostic uses only `TomlError.line`/`.column` — plain numbers,
 * never a snippet of the document they point into.
 *
 * **Bounded descent, not a config-file DoS surface**: `MAX_CONFIG_DEPTH` and
 * `MAX_ENTITIES_PER_FILE` cap how far a JSON/TOML tree is walked and how many entities one file
 * can produce (discretion: "unbounded descent of a large lockfile is a real risk"), and
 * `MAX_ARRAY_ITEMS` caps how many elements of one array are visited. All three degrade the SAME
 * way `index-scan.ts`'s own bounds do — the walk simply stops, with one bounded diagnostic per
 * file noting that truncation happened, never a silent drop with no trace and never a thrown
 * error.
 *
 * **What "cross-file references from JSON/TOML" (task scope) means here, precisely**: recording
 * that a config file NAMES something (a verify command, a script, a branch) as an ordinary leaf
 * entity — never resolving that name to the file/symbol it points at, which the task's own
 * deferred list rules out explicitly ("resolving that command to a file entity is not [in
 * scope]"). `.noriq/project.toml`'s structure (`[verify]`, `[land]`, `[permissions.*]`,
 * `[index]`, …) and `package.json`'s `scripts` therefore need no special-cased extraction code at
 * all: they fall out of the same generic key-value walk every other JSON/TOML file gets, gated by
 * the same secret check as everything else — which is exactly how "`.noriq/project.toml`
 * structure ... without exposing denied values" is satisfied, rather than by a project.toml-
 * specific carve-out.
 *
 * **Every symbol/test/api entity in this file is `nodeType: 'symbol'`** (locked decision 1) — a
 * config leaf, a markdown heading, and a fenced code block are all repository-scoped declarations
 * a graph can point at, not test declarations or API surfaces, so `'test'`/`'api'` are never used
 * here even for a `package.json` `scripts.test` entry (that is a config VALUE naming a command,
 * not a test the way a `describe`/`it` block is one in `index-treesitter.ts`).
 */

const ADAPTER_VERSION = '1';

// ---------------------------------------------------------------------------
// Shared bounds
// ---------------------------------------------------------------------------

/** How many levels of nested object a JSON/TOML walk descends before it stops rather than
 *  producing an entity per key — generous for real config (`[permissions.build].write` is depth
 *  2; a workflow's `[stages.review]` is depth 2), stingy for a machine-generated tree that nests
 *  far deeper than any human-authored config does. */
const MAX_CONFIG_DEPTH = 6;

/** Per-file entity ceiling — a `package-lock.json`-shaped file with thousands of nested dependency
 *  records must not explode into thousands of graph entities. Generous for an ordinary
 *  `project.toml`/`package.json`/`tsconfig.json`. */
const MAX_ENTITIES_PER_FILE = 500;

/** Per-array element ceiling, independent of the whole-file cap above — an array of 20 items is
 *  already well past what a hand-authored config array (`languages = [...]`, `workspaces = [...]`)
 *  ever holds; beyond it the array is almost certainly generated data. */
const MAX_ARRAY_ITEMS = 20;

/** How long a single-line summary of a truncated primitive array may be before it is elided —
 *  purely a size bound (never a secret concern; see `arrayContent` below), matching this module's
 *  existing preference for a fixed, generous, stated cap over an unbounded string. */
const MAX_ARRAY_SUMMARY_CHARS = 500;

function boundsDiagnostic(reason: string): ParsedDiagnostic {
  return { message: `entity extraction stopped early: ${reason}`, severity: 'warning' };
}

// ---------------------------------------------------------------------------
// JSON / TOML: one shared recursive walker over a parsed value tree
// ---------------------------------------------------------------------------

interface WalkState {
  symbols: ParsedSymbol[];
  entityCount: number;
  hitDepthCap: boolean;
  hitEntityCap: boolean;
  hitArrayCap: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `String(value)` for a JSON/TOML primitive leaf — the readable, unquoted form ("8080", "true",
 *  "main"), not `JSON.stringify`'s quoted-string form, since this becomes an entity's searchable
 *  `content`, not a value a later step re-parses. `smol-toml` may hand back its own `TomlDate` for
 *  a TOML date/time literal; that class implements `toString()`, so this still produces a sensible
 *  reading rather than `[object Object]`. */
function primitiveToText(value: unknown): string {
  if (value === null) return 'null';
  return String(value);
}

/**
 * An empty or whitespace-only key names nothing, so it gets no entity AND no subtree (declines by
 * omission, the posture every adapter here takes). Found the hard way on the first real upload this
 * daemon ever attempted: npm's own lockfile v2/v3 format keys the ROOT package as the empty
 * string — `"packages": { "": {…}, "node_modules/foo": {…} }` — which produced one symbol with
 * `label: ""` out of 6454 rows, and the server rejected the whole BATCH (`409 staged node row
 * missing label`), failing the entire generation. `MemoryNode.label` in the vendored contract is
 * `z.string().min(1)`, so an empty label was never sendable; nothing local checked.
 *
 * The check belongs at the top of `walkConfigValue` — the one place a key ARRIVES — and not at the
 * emit sites, which is where the first version of this fix put it and was wrong three ways: the
 * primitive-array branch pushes a symbol directly without going through `pushLeaf`, and a declined
 * SECTION still recursed, so `{"": {"name": …}}` emitted a properly-labelled `name` whose
 * `symbolPath` carried the empty segment and whose `declares` edge pointed at a parent that was
 * never sent. Identity here IS the path, so an unnameable key makes its whole subtree
 * unaddressable — dropping it loses nothing that could have been cited. `indexer.ts` carries the
 * floor that catches any other adapter reaching the same shape: this is the root cause, that is the
 * backstop.
 */
function isNameableKey(key: string): boolean {
  return key.trim().length > 0;
}

function pushLeaf(state: WalkState, path: string[], key: string, value: unknown): void {
  if (state.entityCount >= MAX_ENTITIES_PER_FILE) {
    state.hitEntityCap = true;
    return;
  }
  const text = primitiveToText(value);
  const withheldReason = shouldWithholdValue(key, text);
  state.symbols.push({
    symbolPath: path,
    nodeType: 'symbol',
    label: key,
    content: withheldReason ? null : text,
  });
  state.entityCount += 1;
}

function pushSection(state: WalkState, path: string[], key: string): void {
  if (state.entityCount >= MAX_ENTITIES_PER_FILE) {
    state.hitEntityCap = true;
    return;
  }
  // A section (object) node carries no `content` of its own — stringifying the whole subtree
  // here would re-expose exactly what per-leaf withholding above exists to withhold, for any
  // secret nested underneath. The structure (this entity plus its children, joined by `declares`
  // edges in `indexer.ts`) is the useful fact; the aggregate text is not.
  state.symbols.push({ symbolPath: path, nodeType: 'symbol', label: key, content: null });
  state.entityCount += 1;
}

/** A bounded, all-or-nothing summary of an array of PRIMITIVES (never objects — those are walked
 *  as sections/leaves instead, see `walkConfigValue`). Withheld wholesale if ANY element looks
 *  secret-shaped (locked decision 3, applied to the array as one value) — a single tainted element
 *  must not be allowed to hide behind ninety-nine ordinary ones. */
function arrayContent(key: string, items: unknown[]): string | null {
  const texts = items.slice(0, MAX_ARRAY_ITEMS).map(primitiveToText);
  for (const text of texts) {
    if (shouldWithholdValue(key, text)) return null;
  }
  const joined = texts.join(', ');
  const truncatedByCount = items.length > MAX_ARRAY_ITEMS;
  const suffix = truncatedByCount ? `, … (${items.length} total)` : '';
  const full = `[${joined}${suffix}]`;
  return full.length > MAX_ARRAY_SUMMARY_CHARS ? `${full.slice(0, MAX_ARRAY_SUMMARY_CHARS - 1)}…` : full;
}

function walkConfigValue(state: WalkState, value: unknown, path: string[], key: string, depth: number): void {
  // Before any branch and before any recursion — see `isNameableKey`. This is the only place a key
  // arrives, so it is the only place that can decline one without leaving a route open.
  if (!isNameableKey(key)) return;
  if (state.entityCount >= MAX_ENTITIES_PER_FILE) {
    state.hitEntityCap = true;
    return;
  }

  if (Array.isArray(value)) {
    const objectItems = value.filter(isPlainObject);
    // An array of OBJECTS (TOML array-of-tables, a JSON list of records) is structurally
    // meaningful — descend into each element, index-suffixed, up to the array cap. An array of
    // primitives is not a declaration hierarchy; it is summarised as one leaf instead (below).
    if (objectItems.length > 0) {
      if (depth >= MAX_CONFIG_DEPTH) {
        state.hitDepthCap = true;
        return;
      }
      pushSection(state, path, key);
      const bounded = value.slice(0, MAX_ARRAY_ITEMS);
      if (value.length > MAX_ARRAY_ITEMS) state.hitArrayCap = true;
      bounded.forEach((item, i) => {
        const itemKey = `${key}[${i}]`;
        const itemPath = [...path.slice(0, -1), itemKey];
        if (isPlainObject(item)) {
          for (const [childKey, childValue] of Object.entries(item)) {
            walkConfigValue(state, childValue, [...itemPath, childKey], childKey, depth + 1);
          }
        }
      });
      return;
    }
    const content = arrayContent(key, value);
    if (state.entityCount >= MAX_ENTITIES_PER_FILE) {
      state.hitEntityCap = true;
      return;
    }
    state.symbols.push({ symbolPath: path, nodeType: 'symbol', label: key, content });
    state.entityCount += 1;
    return;
  }

  if (isPlainObject(value)) {
    if (depth >= MAX_CONFIG_DEPTH) {
      state.hitDepthCap = true;
      return;
    }
    pushSection(state, path, key);
    for (const [childKey, childValue] of Object.entries(value)) {
      walkConfigValue(state, childValue, [...path, childKey], childKey, depth + 1);
    }
    return;
  }

  pushLeaf(state, path, key, value);
}

/** The top-level entry: a config file's parsed value is normally an object, whose OWN keys become
 *  depth-1 entities (no synthetic root entity is minted — `indexer.ts` already mints the file's
 *  own entity, so a root config node here would be a redundant, path-only duplicate of it). A
 *  top-level non-object (a bare JSON array or scalar — unusual but legal JSON, impossible for
 *  TOML) is walked as a single anonymous entry instead of silently producing nothing. */
function walkConfigRoot(value: unknown): { symbols: ParsedSymbol[]; diagnostics: ParsedDiagnostic[] } {
  const state: WalkState = {
    symbols: [],
    entityCount: 0,
    hitDepthCap: false,
    hitEntityCap: false,
    hitArrayCap: false,
  };
  if (isPlainObject(value)) {
    for (const [key, childValue] of Object.entries(value)) {
      walkConfigValue(state, childValue, [key], key, 1);
    }
  } else {
    walkConfigValue(state, value, ['(root)'], '(root)', 1);
  }
  const diagnostics: ParsedDiagnostic[] = [];
  if (state.hitEntityCap) diagnostics.push(boundsDiagnostic(`more than ${MAX_ENTITIES_PER_FILE} entities`));
  if (state.hitDepthCap) diagnostics.push(boundsDiagnostic(`nesting deeper than ${MAX_CONFIG_DEPTH} levels`));
  if (state.hitArrayCap) diagnostics.push(boundsDiagnostic(`an array longer than ${MAX_ARRAY_ITEMS} items`));
  return { symbols: state.symbols, diagnostics };
}

// ---------------------------------------------------------------------------
// JSON adapter
// ---------------------------------------------------------------------------

function parseJson(content: string): AdapterParseResult {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    // Deliberately NOT `err.message` — see this module's doc: V8's JSON.parse error messages
    // embed a preview of the raw source text next to the complaint, which would leak exactly what
    // this task exists to withhold. A fixed, content-free diagnostic is the safe choice here;
    // there is no structured, content-free position API on a plain JSON SyntaxError to fall back
    // to the way `TomlError.line`/`.column` lets the TOML adapter do below.
    return { symbols: [], diagnostics: [{ message: 'invalid JSON', severity: 'error' }] };
  }
  return walkConfigRoot(value);
}

export function createJsonAdapter(): IndexParserAdapter {
  return {
    id: 'config-json',
    version: ADAPTER_VERSION,
    languages: ['json'],
    canParse: (path) => path.toLowerCase().endsWith('.json'),
    parse: async (input) => parseJson(input.content),
  };
}

// ---------------------------------------------------------------------------
// TOML adapter
// ---------------------------------------------------------------------------

function parseTomlFile(content: string): AdapterParseResult {
  let value: unknown;
  try {
    value = parseToml(content);
  } catch (err) {
    // Same reasoning as the JSON branch above, with one difference this adapter DOES use:
    // `TomlError` carries `line`/`column` as plain numbers (measured, not assumed — see this
    // module's doc), which point at the failure without ever quoting the document itself. Its
    // `.message`/`.codeblock` are avoided for the same leak reason as JSON's `err.message`.
    const position = err instanceof TomlError ? ` at line ${err.line}, column ${err.column}` : '';
    return { symbols: [], diagnostics: [{ message: `invalid TOML syntax${position}`, severity: 'error' }] };
  }
  return walkConfigRoot(value);
}

export function createTomlAdapter(): IndexParserAdapter {
  return {
    id: 'config-toml',
    version: ADAPTER_VERSION,
    languages: ['toml'],
    canParse: (path) => path.toLowerCase().endsWith('.toml'),
    parse: async (input) => parseTomlFile(input.content),
  };
}

// ---------------------------------------------------------------------------
// Markdown adapter
// ---------------------------------------------------------------------------

interface HeadingRecord {
  level: number;
  text: string;
  /** 1-based. */
  startLine: number;
  /** Outer-to-inner hierarchy INCLUDING this heading's own trimmed text. */
  path: string[];
}

/** An ATX heading (`#` through `######`) starting at column 0, with a required space after the
 *  hashes and an optional closing `#`-run stripped (CommonMark's ATX closing sequence) — the
 *  line-recognisable subset locked decision 6 asks for. An indented heading (inside a list item, a
 *  blockquote) is declined by this regex requiring the `#` in column 0; that is a real CommonMark
 *  case this adapter does not attempt, by omission rather than by a wrong guess. */
const ATX_HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

function parseHeadings(lines: string[]): HeadingRecord[] {
  const headings: HeadingRecord[] = [];
  const stack: { level: number; text: string }[] = [];
  lines.forEach((line, idx) => {
    const match = ATX_HEADING_RE.exec(line);
    const text = match?.[2]?.trim();
    if (!match || !text) return;
    const level = match[1]!.length;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
    stack.push({ level, text });
    headings.push({ level, text, startLine: idx + 1, path: stack.map((s) => s.text) });
  });
  return headings;
}

/** A section spans its own heading line through the line before the next heading of the SAME or
 *  SHALLOWER level, or EOF (locked decision 10) — 1-based, inclusive at both ends, matching
 *  `SymbolRange`'s own contract exactly. */
function computeSectionEndLines(headings: HeadingRecord[], totalLines: number): number[] {
  return headings.map((h, i) => {
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j]!.level <= h.level) return headings[j]!.startLine - 1;
    }
    return totalLines;
  });
}

/**
 * GitHub's heading-anchor slug algorithm, close enough for deterministic internal-link matching:
 * lowercase, strip everything but word characters/spaces/hyphens, collapse whitespace to a single
 * hyphen. Exported and unit-tested directly (this task's own acceptance: "heading anchors ... are
 * deterministic") — used internally only to recognise an in-document `#anchor` link as internal
 * (see `extractLinkTargets` below), never as a symbol's identity (locked decision 9: the heading
 * HIERARCHY by trimmed text is the identity; a slug that changed algorithms later must not rename
 * every heading entity, which is exactly what would happen if the slug were the identity instead
 * of a derived, disposable convenience).
 */
export function githubHeadingSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\- ]+/g, '')
    .replace(/\s+/g, '-');
}

/** Every anchor slug this document's own headings would answer to — GitHub's own dedup rule
 *  (`-1`, `-2`, … for a repeated slug) applied in document order, so two identically-titled
 *  headings still each get a distinct, correctly-ordered anchor to match against. */
function documentAnchorSlugs(headings: HeadingRecord[]): Set<string> {
  const counts = new Map<string, number>();
  const slugs = new Set<string>();
  for (const h of headings) {
    const base = githubHeadingSlug(h.text);
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    slugs.add(n === 0 ? base : `${base}-${n}`);
  }
  return slugs;
}

/** The heading hierarchy in effect at `lineNumber` (1-based) — the path of the last heading whose
 *  own line is at or before it, or `[]` before any heading. Used to nest fenced code blocks under
 *  their enclosing section the same way tree-sitter nests a method under its class. */
function enclosingHeadingPath(headings: HeadingRecord[], lineNumber: number): string[] {
  let path: string[] = [];
  for (const h of headings) {
    if (h.startLine > lineNumber) break;
    path = h.path;
  }
  return path;
}

const INLINE_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

/**
 * Inline `[text](url)` links only (locked decision, this module's doc: reference-style links are
 * declined). An in-document `#anchor` link matching this file's own computed anchor set is DROPPED
 * — it is navigation within the entity this parse already produced, not a reference to anything
 * else. Everything else (an external URL, a relative path to another file, an anchor this
 * document does NOT recognise) is a real reference and is turned into a `symbol` entity by
 * `parseMarkdown` below — see that function's own doc for why a `symbol` entity, not
 * `ParsedImport`, is what this extracts into.
 */
function extractLinkTargets(lines: string[], anchors: Set<string>): { lineNumber: number; target: string }[] {
  const targets: { lineNumber: number; target: string }[] = [];
  lines.forEach((line, idx) => {
    for (const match of line.matchAll(INLINE_LINK_RE)) {
      const rawUrl = match[2]!.trim();
      const url = (rawUrl.split(/\s+/)[0] ?? rawUrl).replace(/^<|>$/g, '');
      if (url.length === 0) continue;
      if (url.startsWith('#') && anchors.has(url.slice(1).toLowerCase())) continue;
      targets.push({ lineNumber: idx + 1, target: url });
    }
  });
  return targets;
}

/** An inline code span (`` `like/this.ts` ``) whose text looks like a repository path or
 *  filename — the "code references" the task names alongside links and fenced blocks. Scoped
 *  narrowly on purpose (discretion: "fewer well-defined kinds beats many vaguely-defined ones"):
 *  must contain a `.`-delimited extension and no whitespace, so an ordinary inline-code MENTION of
 *  a value (`` `true` ``, `` `null` ``, `` `--flag` ``) is declined rather than mis-recorded as a
 *  reference. Turned into a `symbol` entity by `parseMarkdown` below, same as a link target. */
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const PATH_LIKE_RE = /^[A-Za-z0-9_][\w.\-/]*\.[A-Za-z0-9]{1,8}$/;

function extractCodeReferenceTargets(lines: string[]): { lineNumber: number; target: string }[] {
  const targets: { lineNumber: number; target: string }[] = [];
  lines.forEach((line, idx) => {
    for (const match of line.matchAll(INLINE_CODE_RE)) {
      const text = match[1]!.trim();
      if (PATH_LIKE_RE.test(text)) targets.push({ lineNumber: idx + 1, target: text });
    }
  });
  return targets;
}

/**
 * Turn a link/code-reference target into a `symbol` entity, nested under its enclosing heading
 * (same nesting `parseFencedCodeBlocks`'s callers use) — see `parseMarkdown`'s own doc for why
 * this is a `symbol` entity rather than `ParsedImport`. `label` is a fixed, structural string
 * (`'link'`/`'code reference'`), never the target text itself — a label repeating the target would
 * be a third copy of it to keep in step with the two below, and the kind is the only thing a
 * reader needs the label for.
 *
 * **Identity is the TARGET, not a position** (`symbolPath: [...enclosing, target]`, corrected
 * after an earlier `reference-${ordinal}` version): a positional id shifts every later reference
 * under one heading whenever an unrelated link is inserted above it, so an ordinary edit to the
 * TOP of a guidance doc would read as every reference below it being deleted and recreated in the
 * next generation's diff — exactly the churn drift detection (this task's own acceptance) exists
 * to be immune to, and exactly what locked decision 5 rules out for a symbol generally ("identity
 * is never a position"). Two references to the same target under one heading collide on this
 * symbolPath; `dedupeSymbolPaths` (`index-entity.ts`) is the disambiguator built for precisely
 * that, so the collision is handled the same way any other repeated declaration in this indexer
 * is, rather than needing a second identity scheme here.
 *
 * **A secret-shaped target declines the WHOLE entity — never nulled content** (the same inversion
 * `index-redact.ts` documents, applied at a different layer here): a reference's target IS the
 * fact this entity exists to record, and here the target is also the entity's URI-bearing
 * identity, not a separate `content` field a caller can null out the way a JSON/TOML leaf's value
 * is nulled while its key entity survives. A URI cannot be withheld once minted — `index-entity.ts`
 * has no mechanism to redact part of an identity — so the only safe move is to never mint the
 * entity at all. Returns `null` for that case; a reference with nothing left worth recording is
 * not worth a node, unlike a config key (whose KEY remains a real fact independent of its value).
 */
function referenceSymbol(
  headings: HeadingRecord[],
  kind: 'link' | 'code reference',
  lineNumber: number,
  target: string,
): ParsedSymbol | null {
  if (scanTextForSecretShapedContent(target)) return null;
  const enclosing = enclosingHeadingPath(headings, lineNumber);
  return {
    symbolPath: [...enclosing, target],
    nodeType: 'symbol',
    label: kind,
    content: target,
    range: { startLine: lineNumber, endLine: lineNumber },
  };
}

interface FencedCodeBlock {
  language: string;
  startLine: number;
  endLine: number;
  content: string;
}

/** Fenced code blocks (``` or ~~~), closing fence must use the same character and be at least as
 *  long as the opener (CommonMark's own rule) — a block with NO declared language is declined
 *  entirely (discretion: only a block whose language is stated becomes an entity; an unlabelled
 *  fence is often prose-adjacent output, not a citable code artifact). An unterminated fence runs
 *  to EOF rather than being dropped — the same "declines by omission, never guesses a false
 *  boundary" posture, applied to "where does this block end" instead of "does this block exist". */
function parseFencedCodeBlocks(lines: string[]): FencedCodeBlock[] {
  const blocks: FencedCodeBlock[] = [];
  const OPEN_RE = /^(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
  const CLOSE_RE = /^(`{3,}|~{3,})\s*$/;
  let i = 0;
  while (i < lines.length) {
    const open = OPEN_RE.exec(lines[i]!);
    if (!open) {
      i += 1;
      continue;
    }
    const fenceChar = open[1]!.charAt(0);
    const fenceLen = open[1]!.length;
    const language = (open[2] ?? '').trim();
    const openIdx = i;
    let closeIdx = -1;
    for (let j = openIdx + 1; j < lines.length; j += 1) {
      const close = CLOSE_RE.exec(lines[j]!);
      if (close && close[1]!.charAt(0) === fenceChar && close[1]!.length >= fenceLen) {
        closeIdx = j;
        break;
      }
    }
    const contentEndIdx = closeIdx === -1 ? lines.length : closeIdx;
    if (language.length > 0) {
      blocks.push({
        language,
        startLine: openIdx + 1,
        endLine: closeIdx === -1 ? lines.length : closeIdx + 1,
        content: lines.slice(openIdx + 1, contentEndIdx).join('\n'),
      });
    }
    i = closeIdx === -1 ? lines.length : closeIdx + 1;
  }
  return blocks;
}

/**
 * Strip a trailing `#fragment` or `?query` before a target is handed to `indexer.ts`'s resolver
 * (RUN-257) — `resolveRelativeImport`'s specifier grammar has no notion of either (a real repo path
 * never contains an unescaped `#`/`?`; see `index-entity.ts`'s own percent-encoding of exactly
 * those characters), so `[decision](../CLAUDE.md#invariants)` would otherwise decline as "no
 * candidate matches" even though the file half resolves cleanly. Only the copy handed to the
 * resolver is trimmed — `referenceSymbol`'s own `content` keeps the untouched target text, because
 * the raw fragment is part of what the document actually says.
 */
function referenceResolutionTarget(target: string): string {
  const cut = target.search(/[#?]/);
  return cut === -1 ? target : target.slice(0, cut);
}

/**
 * Link/code-reference targets get BOTH a `symbol` entity (unchanged since RUN-218) AND, since
 * RUN-257, a `ParsedReference` — two different facts about the same mention, not one fact
 * recorded twice. The `symbol` entity is the durable, resolution-independent record: it survives
 * verbatim whether or not `target` currently names a real file, which is exactly what the task's
 * own acceptance wants ("a doc referencing a path that no longer exists" stays visible as a node —
 * a graph EDGE cannot point at a node the wire never sent, so a dangling reference could never be
 * an edge in the first place). The `ParsedReference` is the complementary, RESOLUTION-dependent
 * fact: when `target` does name a real file in this generation, `indexer.ts` now has somewhere to
 * put that as a typed, queryable `related_to` edge ("what relates to `worktree.ts`") — the
 * capability RUN-218's original version of this comment named as out of its own fence
 * ("`AdapterParseResult` can express exactly two relationship shapes ... `related_to` exists in
 * the wire's own vocabulary but nothing in the adapter interface can produce it"). `imports` is
 * still the wrong edge for either: it means a MODULE dependency — code that would not run without
 * the thing it names — and `[guide](./guide.md)` is not that; routing it through `imports` would
 * tell a consumer asking "what imports `worktree.ts`" that a documentation file does, which is
 * simply false. A secret-shaped target is declined from BOTH outputs identically (the `symbol`
 * branch already refuses to mint an entity whose identity is the secret; a target that unsafe is
 * not worth resolving into an edge either).
 */
function parseMarkdown(content: string): AdapterParseResult {
  const lines = content.split(/\r\n|\n|\r/);
  const headings = parseHeadings(lines);
  const endLines = computeSectionEndLines(headings, lines.length);
  const anchors = documentAnchorSlugs(headings);

  const symbols: ParsedSymbol[] = [];

  headings.forEach((h, i) => {
    const endLine = endLines[i]!;
    const sectionText = lines.slice(h.startLine - 1, endLine).join('\n');
    const withheldReason = scanTextForSecretShapedContent(sectionText);
    symbols.push({
      symbolPath: h.path,
      nodeType: 'symbol',
      label: h.text,
      content: withheldReason ? null : sectionText,
      range: { startLine: h.startLine, endLine },
    });
  });

  const codeBlocks = parseFencedCodeBlocks(lines);
  codeBlocks.forEach((block, i) => {
    const enclosing = enclosingHeadingPath(headings, block.startLine);
    const withheldReason = scanTextForSecretShapedContent(block.content);
    symbols.push({
      symbolPath: [...enclosing, `code-block-${i + 1}`],
      nodeType: 'symbol',
      label: `code block (${block.language})`,
      content: withheldReason ? null : block.content,
      range: { startLine: block.startLine, endLine: block.endLine },
    });
  });

  const references: { kind: 'link' | 'code reference'; lineNumber: number; target: string }[] = [
    ...extractLinkTargets(lines, anchors).map((r) => ({ kind: 'link' as const, ...r })),
    ...extractCodeReferenceTargets(lines).map((r) => ({ kind: 'code reference' as const, ...r })),
  ];
  const parsedReferences: ParsedReference[] = [];
  for (const { kind, lineNumber, target } of references) {
    const sym = referenceSymbol(headings, kind, lineNumber, target);
    if (sym) symbols.push(sym); // null = target was secret-shaped; declined outright, see doc above.
    if (sym) parsedReferences.push({ target: referenceResolutionTarget(target) });
  }

  return { symbols, diagnostics: [], references: parsedReferences };
}

/**
 * Which paths count as a "repository guidance surface" (discretion) — the daemon-facing/human-
 * facing instruction documents a drift-detection consumer would eventually compare against actual
 * behaviour (deferred; see this module's doc), versus an arbitrary markdown file that happens to
 * live in the repo. A pure path-shape check, covering: `CLAUDE.md`, `AGENTS.md`, `README.md`, and
 * `CONTRIBUTING.md` at any depth (a monorepo commonly has one per package, not only at the root);
 * everything under a `docs/` directory at any depth; and any markdown file directly under
 * `.noriq/`. Exported so a later consumer (drift detection itself, or a debug CLI) can reuse this
 * exact predicate rather than re-deriving it — but it does NOT gate what `createMarkdownAdapter`
 * extracts: heading/link/code-block extraction runs identically for every markdown file regardless
 * of guidance status (discretion: "fewer well-defined kinds beats many vaguely-defined ones" —
 * withholding heading structure from an equally real but unlisted doc would be an arbitrary
 * coverage gap, not a feature). What makes a guidance surface "graphable for drift detection"
 * (this task's own acceptance) is exactly that uniform extraction: its heading structure, ranges,
 * and content land in the graph the same deterministic way any other markdown file's does, ready
 * for a later phase to diff against.
 */
export function isRepoGuidanceSurfacePath(path: string): boolean {
  const segments = path.split('/');
  const basename = segments[segments.length - 1] ?? '';
  const NAMED_BASENAMES = new Set(['CLAUDE.md', 'AGENTS.md', 'README.md', 'CONTRIBUTING.md']);
  if (NAMED_BASENAMES.has(basename)) return true;
  if (segments.includes('docs')) return true;
  if (segments.length === 2 && segments[0] === '.noriq' && basename.toLowerCase().endsWith('.md'))
    return true;
  return false;
}

export function createMarkdownAdapter(): IndexParserAdapter {
  return {
    id: 'config-markdown',
    version: ADAPTER_VERSION,
    languages: ['markdown'],
    canParse: (path) => {
      const lower = path.toLowerCase();
      return lower.endsWith('.md') || lower.endsWith('.markdown');
    },
    parse: async (input) => parseMarkdown(input.content),
  };
}
