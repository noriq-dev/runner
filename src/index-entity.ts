import type { MemoryEdgeType, MemoryNodeType } from '@noriq-dev/shared';
import { buildEntityUri } from '@noriq-dev/shared';
import type { SymbolRange } from './index-adapters';
import { comparePaths } from './index-source';

/**
 * Stable entity identity for Project Memory's indexer (RUN-215): the durable URI a file/symbol
 * keeps across unrelated churn, the record shapes those entities and their edges take before
 * batch encoding (`index-batch.ts`), deletion records, and bounded parse diagnostics.
 *
 * **Reuses the vendored URI scheme rather than inventing one** (`@noriq-dev/shared`'s
 * `buildEntityUri`/`EntityRef`, `vendor/noriq-shared/src/memory.ts`) — that scheme is already the
 * wire contract a `MemoryNode.uri` must satisfy server-side, already carries the
 * `noriq://{kind}/{projectKey}/{repositoryKey}/{path}[#{name}]` shape locked decision 5 asks for
 * (no line number, no content hash, no batch index), and a second, parallel URI grammar for the
 * same entities would be the exact drift RUN-158/PLNR-278 keep having to close. What THIS file
 * adds on top: percent-encoding so a real repository path/symbol name containing `#` or `?` can
 * never be confused with the scheme's own fragment delimiter (discretion: "unambiguous
 * round-tripping"), and the symbol-path-to-`name` convention `buildEntityUri` itself is silent on.
 *
 * **A symbol's identity is (repo-relative path, nested declaration path) — never a line number, a
 * byte offset, or an index generation** (locked decision 5). `encodeSymbolPath` joins nested
 * declaration segments (outer to inner — `['Outer', 'method']`) with `.` into the `name` half of
 * a `symbol`/`test`/`api` URI; two same-named symbols in one file (overloads, a nested class
 * reusing an outer name) are disambiguated by `dedupeSymbolPaths` using the ADAPTER's own emission
 * order — deterministic because `IndexParserAdapter.parse` (`index-adapters.ts`) is required to
 * yield symbols in a stable order for the same file, never because either function inspects a line
 * number.
 *
 * **Chunks are never entities** (locked decision 8, restated here for the module that mints every
 * entity URI this daemon will ever produce): there is no `buildChunkEntityUri` and there never
 * should be one. A file or symbol's `content` field on its own node record IS the derived payload
 * a later phase re-chunks for embedding; the chunk itself carries no identity anything may cite,
 * so re-chunking (a chunker version bump, a different chunk size) can never invalidate a stored
 * citation the way changing a chunk's own URI would.
 *
 * **Deletions are paths, not URIs** (`IndexDeletion`) — the server's own
 * `IndexGenerationManifest.deletions` field is `RepoPath[]`, and a path is sufficient identity for
 * "retire everything this daemon ever derived from this file": every URI this module built for
 * that path is a deterministic function of the path alone, so the server can re-derive what to
 * retire without this daemon enumerating each one.
 *
 * **Diagnostics are bounded the same way `index-scan.ts` bounds status records** (locked decision
 * 9): `DiagnosticsCollector` caps at `MAX_PARSE_DIAGNOSTICS` and counts the rest rather than
 * growing without limit or silently dropping the overflow uncounted. It is a SEPARATE collection
 * from the entity/edge records a caller accumulates alongside it — nothing in this file interleaves
 * the two or lets a diagnostic influence record order, which is what "cannot reorder successful
 * records nondeterministically" (the task's own acceptance line) requires structurally rather than
 * by convention.
 */

// ---------------------------------------------------------------------------
// Percent-encoding for the two characters the URI scheme itself treats specially (`#` as the
// fragment delimiter) or a future strict URL parser might (`?` as a query delimiter) — plus `%`
// itself, so the encoding is its own inverse. Never touches `/`: that stays the path separator
// vendor's own `entityRefCandidate` splits on.
// ---------------------------------------------------------------------------

function encodeUriChar(c: string): string {
  return `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
}

function decodeUriChar(_: string, hex: string): string {
  return String.fromCharCode(Number.parseInt(hex, 16));
}

const PATH_RESERVED = /[%#?]/g;

/** Percent-encode one path SEGMENT's `%`/`#`/`?` — never called on a whole path (that would also
 *  encode the `/` separators vendor's own URI grammar depends on). */
function encodePathSegment(segment: string): string {
  return segment.replace(PATH_RESERVED, encodeUriChar);
}

function decodePathSegment(segment: string): string {
  return segment.replace(/%([0-9A-Fa-f]{2})/g, decodeUriChar);
}

/**
 * Encode a repository-relative, forward-slash path for embedding as an entity URI's `path`
 * segment — round-trips via `decodeUriPath`. Every segment is encoded independently so `/` stays
 * the directory separator vendor's `entityRefCandidate` parses on.
 */
export function encodeUriPath(path: string): string {
  return path.split('/').map(encodePathSegment).join('/');
}

/** The inverse of `encodeUriPath`. */
export function decodeUriPath(encoded: string): string {
  return encoded.split('/').map(decodePathSegment).join('/');
}

// `.` joins symbol-path segments into one `name` string, so a literal `.` inside a segment is
// ALSO escaped here (on top of `%`/`#`/`?`) — otherwise the separator itself would be ambiguous
// with a symbol whose own name contains a dot (a namespaced constant, a nested-class shorthand a
// future adapter might emit verbatim).
const SYMBOL_RESERVED = /[%.#?]/g;

function encodeSymbolSegment(segment: string): string {
  return segment.replace(SYMBOL_RESERVED, encodeUriChar);
}

function decodeSymbolSegment(segment: string): string {
  return segment.replace(/%([0-9A-Fa-f]{2})/g, decodeUriChar);
}

/**
 * Join nested declaration segments (outer to inner) into the `name` half of a symbol/test/api
 * URI. Round-trips via `decodeSymbolPath` — the discretion this file settles: "unambiguous
 * round-tripping for a path containing `#` or `?`" extends to the symbol name too, since a real
 * language can produce identifiers containing any of `.`/`#`/`?` (Ruby's `?`/`!` suffix,
 * Perl/Raku's `::`-free `?` predicate convention) that would otherwise collide with this
 * function's own `.` separator or the URI scheme's `#`.
 */
export function encodeSymbolPath(segments: readonly string[]): string {
  if (segments.length === 0) throw new Error('a symbol path must have at least one segment');
  return segments.map(encodeSymbolSegment).join('.');
}

/** The inverse of `encodeSymbolPath`. */
export function decodeSymbolPath(encoded: string): string[] {
  return encoded.split('.').map(decodeSymbolSegment);
}

/**
 * Normalize a candidate path to forward slashes before it is used to mint a permanent identity.
 * `IndexSource.list()`'s own contract already guarantees forward-slash, POSIX-separated paths
 * (`index-source.ts`'s module doc, `walkFs`'s "built by hand with `/`" comment) — this is a second,
 * defensive pass at the one place a path becomes a URI a citation will reference forever, so a
 * hypothetical future source that violated the contract on Windows produces the SAME identity
 * instead of a platform-specific one (the acceptance line names Windows specifically).
 */
export function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// URI builders
// ---------------------------------------------------------------------------

export interface UriScope {
  /** The committed project key (`.noriq/project.toml`'s `key`, ≤8 chars) — NOT the server-resolved
   *  `projectId` `IndexTarget`/`IndexRunTarget` carry; the vendored URI scheme embeds the former. */
  projectKey: string;
  repositoryKey: string;
}

/** A durable `file` entity's URI — path only, no content hash, no generation. */
export function buildFileEntityUri(scope: UriScope, path: string): string {
  return buildEntityUri({
    kind: 'file',
    projectKey: scope.projectKey,
    repositoryKey: scope.repositoryKey,
    path: encodeUriPath(normalizeRepoPath(path)),
  });
}

export type SymbolLikeKind = 'symbol' | 'test' | 'api';

/** A `symbol`/`test`/`api` entity's URI — the file's path plus a nested declaration path, never a
 *  line number (locked decision 5). `symbolPath` should already be the DEDUPED path
 *  (`dedupeSymbolPaths`) when two same-named symbols share a file. */
export function buildSymbolEntityUri(
  scope: UriScope,
  path: string,
  symbolPath: readonly string[],
  kind: SymbolLikeKind = 'symbol',
): string {
  return buildEntityUri({
    kind,
    projectKey: scope.projectKey,
    repositoryKey: scope.repositoryKey,
    path: encodeUriPath(normalizeRepoPath(path)),
    name: encodeSymbolPath(symbolPath),
  });
}

/**
 * Disambiguate repeated symbol paths within ONE file's adapter output, in the adapter's own
 * emission order (discretion: "what happens for two same-named symbols in one file — deterministic
 * and documented"). The first occurrence of a given path is untouched; the Nth repeat appends
 * `$N` to its LAST segment (`['Foo','bar']` collides once more `['Foo','bar$2']`) — a suffix
 * chosen because `$` cannot appear in any segment this function itself produces (only `.`s from
 * joining, and callers percent-encode `.`/`#`/`?`/`%` before this ever runs, so `$` is free).
 * Deterministic PROVIDED the adapter itself yields symbols in a stable order for a given file —
 * `IndexParserAdapter.parse`'s own contract (`index-adapters.ts`).
 */
export function dedupeSymbolPaths(paths: ReadonlyArray<readonly string[]>): string[][] {
  const seen = new Map<string, number>();
  const out: string[][] = [];
  for (const path of paths) {
    const key = path.join('\u0000');
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count === 1) {
      out.push([...path]);
    } else {
      const head = path.slice(0, -1);
      const last = path[path.length - 1] ?? '';
      out.push([...head, `${last}$${count}`]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entity/edge records — the pre-serialization shape `index-batch.ts` sorts and encodes onto the
// wire. Typed against the vendored `MemoryNodeType`/`MemoryEdgeType` vocabularies so a value this
// indexer produces can never silently drift from what the rest of Project Memory recognises.
// ---------------------------------------------------------------------------

export interface EntityRecord {
  kind: 'node';
  uri: string;
  type: MemoryNodeType;
  label: string;
  /** `null` in `contentMode: 'metadata'`, or for an entity kind that never carries source text —
   *  never a decision this file makes, only a value the caller (`indexer.ts`) passes through. */
  content: string | null;
  /** Carried straight through from `ParsedSymbol.range` (`index-adapters.ts`) when the adapter
   *  reported one — absent for a `file` entity (no line-span concept) or a symbol an adapter
   *  declined to place. **Inert on the wire by construction**: `index-batch.ts`'s `toStagedRow`
   *  builds a `StagedNodeRow` literal naming exactly `{kind,uri,type,label,content}`, so this field
   *  is never read into a hashed/uploaded row — adding it here cannot move `contentHash` or a
   *  batch's bytes by one bit. It exists purely for a caller that wants the record IN MEMORY, not
   *  round-tripped through the wire shape — RUN-219's debug CLI is the first (see
   *  `index-adapters.ts`'s own `SymbolRange` doc, which named this exact caller before it existed). */
  range?: SymbolRange;
}

export interface EdgeRecord {
  kind: 'edge';
  type: MemoryEdgeType;
  from: string;
  to: string;
}

export type IndexRecord = EntityRecord | EdgeRecord;

// ---------------------------------------------------------------------------
// Deletions
// ---------------------------------------------------------------------------

/**
 * Paths the previous generation indexed that this scan no longer sees. `previousPaths` is
 * optional and caller-supplied (`indexer.ts` never talks to a journal or the server itself — zero
 * network calls, locked decision 10): `undefined` means "no previous generation to diff against",
 * which is exactly the `full`-with-no-prior-generation reconcile outcome, and correctly yields no
 * deletions rather than treating an absent baseline as "everything was deleted".
 */
export function computeDeletions(
  currentPaths: Iterable<string>,
  previousPaths: Iterable<string> | undefined,
): string[] {
  if (previousPaths === undefined) return [];
  const current = new Set(currentPaths);
  const deleted: string[] = [];
  for (const path of previousPaths) {
    if (!current.has(path)) deleted.push(path);
  }
  // Plain code-unit sort (never locale-aware) — the same determinism rule every other sort in
  // this indexer follows (locked decision 6), reusing `index-source.ts`'s comparator so there is
  // exactly one definition of "ascending" for a path anywhere in this seam.
  return deleted.sort(comparePaths);
}

// ---------------------------------------------------------------------------
// Bounded parse diagnostics
// ---------------------------------------------------------------------------

export interface IndexDiagnostic {
  /** Repository-relative path the diagnostic is about. */
  path: string;
  message: string;
  severity: 'error' | 'warning';
  /** `${adapter.id}@${adapter.version}` — RUN-215 scope's "record indexer and parser versions",
   *  the per-diagnostic half (the manifest's own `indexerVersion` covers the daemon as a whole;
   *  this is what let a debug consumer tell which parser produced a specific complaint without
   *  cross-referencing anything else). */
  source: string;
}

/** Mirrors `index-scan.ts`'s `MAX_STATUS_RECORDS` reasoning exactly: an unbounded diagnostics
 *  list is the same OOM as an unbounded read, one layer up (locked decision 9). */
export const MAX_PARSE_DIAGNOSTICS = 1000;

/**
 * Accumulates diagnostics up to the cap and counts the rest — never silently drops the overflow
 * uncounted, never grows without bound. Deliberately a class (not a plain array + counter a caller
 * has to remember to check) so `indexer.ts` cannot forget the overflow half of the contract.
 */
export class DiagnosticsCollector {
  private readonly items: IndexDiagnostic[] = [];
  private overflowCount = 0;

  push(diagnostic: IndexDiagnostic): void {
    if (this.items.length < MAX_PARSE_DIAGNOSTICS) {
      this.items.push(diagnostic);
    } else {
      this.overflowCount += 1;
    }
  }

  get diagnostics(): readonly IndexDiagnostic[] {
    return this.items;
  }

  get overflow(): number {
    return this.overflowCount;
  }
}
