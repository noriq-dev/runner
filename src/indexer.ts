import { posix as posixPath } from 'node:path';
import type { IndexGenerationManifest } from '@noriq-dev/shared';
import { type IndexAdapterRegistry, createDefaultAdapterRegistry } from './index-adapters';
import {
  type EncodedBatch,
  assembleManifest,
  computeContentHash,
  deriveGenerationId,
  encodeBatches,
  sortRecords,
} from './index-batch';
import {
  DiagnosticsCollector,
  type IndexDiagnostic,
  type IndexRecord,
  type UriScope,
  buildFileEntityUri,
  buildSymbolEntityUri,
  computeDeletions,
  dedupeSymbolPaths,
  normalizeRepoPath,
} from './index-entity';
import type { ResolvedIndexConfig } from './index-policy';
import { INDEXER_VERSION } from './index-reconcile';
import { scanTextForCredentialMarkers } from './index-redact';
import { scanIndexSource } from './index-scan';
import type { IndexScanDeps, IndexStatusRecord } from './index-scan';
import type { IndexSource } from './index-source';

/**
 * The indexer core (RUN-215): turn one `IndexSource` scan into a byte-deterministic manifest plus
 * a set of gzip'd, hashed, size-bounded batches, ready for RUN-220's ingest client to upload.
 *
 * **Owns orchestration only.** Every piece of real work is delegated to a module that already has
 * a single, auditable job: `scanIndexSource` (`index-scan.ts`) for discovery, filtering, and
 * content — this file never re-walks, re-hashes, or re-opens anything (locked decision 11);
 * `index-adapters.ts` for turning one file's text into symbols; `index-entity.ts` for stable URIs,
 * deduplication, deletions, and bounded diagnostics; `index-batch.ts` for sort order, wire
 * encoding, batch splitting, and the manifest shape. `runIndexer` below is the one function that
 * knows the ORDER those pieces run in and threads state (the running `parserVersions` map, the
 * list of paths seen this pass) between them — nothing here duplicates a decision any of those
 * modules already owns.
 *
 * **Zero model tokens, zero network calls** (locked decision 10): everything from `scanIndexSource`
 * down through `encodeBatches` is deterministic code over bytes already read from disk (or another
 * `IndexSource`). Nothing in this file's dependency graph performs I/O beyond what `source` itself
 * does inside `scanIndexSource` — `await adapter.parse(...)` below is RUN-216's one addition to
 * that shape (`index-adapters.ts`'s own note on why `parse` returns a `Promise` now: an
 * unavoidably-async in-process WASM compile, never a network round trip or a partial result).
 *
 * **A file entity exists whether or not any adapter recognises it** — this is the one thing
 * `runIndexer` does that no injected module does on its own: every scanned candidate becomes
 * exactly one `file` node (its `content` when `contentMode: 'full'`, `null` otherwise), and an
 * adapter only ever ADDS symbol/test/api entities plus `declares` edges on top of that. Shipping
 * no real language adapters yet (RUN-216/217/218 are deferred) therefore costs symbol coverage,
 * never file coverage — a repo indexed today already has every file addressable, citable, and
 * diffable against a later pass that adds real parsing.
 *
 * **Adapters never see a `'metadata'`-mode candidate** — there is no decoded text to hand one, so
 * such a candidate contributes only its file entity. This is the daemon's existing "withhold
 * source text, not the read" posture (`index-scan.ts`'s module doc) carrying through unchanged:
 * `contentMode: 'metadata'` costs symbol extraction the same way it costs the file's own stored
 * content, for the same reason.
 *
 * **A `'full'`-mode candidate whose content carries a high-confidence credential marker is treated
 * the same way** (RUN-258, closing the residual risk THREAT-MODEL.md's `[index]` section names: a
 * token hardcoded into ordinary source, not a value an adapter extracted from JSON/TOML/markdown —
 * `index-redact.ts`'s existing value floor never saw a whole file's raw text). Checked here, BEFORE
 * the file entity's `content` is even assigned — this is the one place that field is set, which
 * makes it the chokepoint (RUN-90's rule) — via `scanTextForCredentialMarkers`, the marker-only
 * sibling of `index-redact.ts`'s existing value-shape checks: PEM headers, JWTs, known issuer
 * prefixes, deliberately WITHOUT the entropy/key-name heuristics tuned for a short isolated value,
 * which over-fire on whole files of real code (that function's own doc has the measured cases). A
 * hit withholds the file entity's `content` (never masked, per locked decision 3) and skips adapter
 * parsing for that file exactly like `'metadata'` mode does above — a symbol's own `content` is
 * raw source text too (`index-treesitter.ts`'s `node.text`), so parsing a file whose content this
 * pass just decided not to trust would hand the same bytes back out through a different entity
 * kind. A bounded diagnostic records the file and the marker CLASS, never the matched bytes.
 *
 * **`imports` edges are resolved SNAPSHOT-LOCAL and TWO-PASS** (RUN-217 locked decision 2): an
 * adapter reports `ParsedImport.specifier` as a literal string with no idea what else this
 * generation indexed (`index-adapters.ts`'s own "one file at a time" constraint), so resolving it
 * to a real file entity cannot happen inside the candidate loop above — a file importing a sibling
 * that has not been scanned yet would resolve to nothing, purely by iteration order, which is
 * exactly the kind of order-dependent bug the rest of this indexer works hard NOT to have. Instead
 * every `(importerPath, specifier)` pair this loop sees is collected into `pendingImports` and
 * resolved in a SECOND pass once `currentPaths` — the loop's own running list — is complete, against
 * the exact same set of paths a `declares`/`calls` edge above was minted against. `resolveRelativeImport`
 * is the resolution function itself; see its own doc for the specifier grammar and the fixed
 * candidate order.
 */

/**
 * Extensions tried, in this fixed order, when a relative specifier names no extension (RUN-217
 * locked decision 3) — this repo's own convention (`./worktree` resolving to `src/worktree.ts`) is
 * exactly the case a resolver that only handled explicit extensions would miss on the very first
 * repository it runs against, while still passing every test written against explicit-extension
 * fixtures.
 */
const RELATIVE_IMPORT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;

/**
 * Resolve one `ParsedImport.specifier` (as reported by `importerPath`'s own adapter) against
 * `currentPaths` — the exact set of repo-relative paths THIS generation's scan actually produced,
 * never a filesystem stat and never Node's or TypeScript's own module-resolution algorithm (both
 * would happily resolve to a `node_modules` file this indexer never scanned, minting an edge to a
 * node that does not exist in this graph — locked decision 2's whole point).
 *
 * A specifier not starting with `.` is BARE (`react`, `@noriq-dev/shared`, `node:fs`) and declines
 * immediately, with no candidate generated at all: this indexer has no package registry or
 * `node_modules` resolution to consult, so a bare specifier resolves to no node in this graph by
 * definition, not by a failed lookup.
 *
 * A relative specifier is tried, in the fixed order locked decision 3 names, as: the literal
 * joined path, then each of `RELATIVE_IMPORT_EXTENSIONS` appended, then `/index` plus each of the
 * same list. If MORE THAN ONE of those candidates is present in `currentPaths`, the specifier is
 * ambiguous and declines — may-miss-never-invent: an edge naming one of two equally plausible
 * targets is worse than no edge. Joining and normalizing always use POSIX semantics (`path.posix`)
 * regardless of the host OS this daemon runs on: `importerPath` already arrives forward-slash
 * (`index-entity.ts`'s `normalizeRepoPath`), and joining with the platform separator would
 * silently misresolve on Windows the same way that function exists to prevent one layer up.
 */
export function resolveRelativeImport(
  importerPath: string,
  specifier: string,
  currentPaths: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith('.')) return null;

  const joined = posixPath.normalize(posixPath.join(posixPath.dirname(importerPath), specifier));

  const candidates = [joined];
  for (const ext of RELATIVE_IMPORT_EXTENSIONS) candidates.push(`${joined}${ext}`);
  for (const ext of RELATIVE_IMPORT_EXTENSIONS) candidates.push(`${joined}/index${ext}`);

  const present = new Set(candidates.filter((c) => currentPaths.has(c)));
  return present.size === 1 ? [...present].at(0)! : null;
}

export interface IndexRunTarget {
  /** The server-resolved Noriq project id — required here (unlike `IndexTarget.projectId` in
   *  `index-coordinator.ts`, which may be `null` before a project resolves): `generationId`
   *  cannot be derived without it, and a caller with no resolved project has nothing to index
   *  against yet (the same precondition `reconcile`'s `unavailable` outcome already encodes one
   *  layer up). */
  projectId: string;
  /** The committed project key (`.noriq/project.toml`'s `key`) — embedded in every entity URI
   *  (`UriScope`), distinct from `projectId` above. */
  projectKey: string;
  repositoryKey: string;
  branch: string;
  baseId: string;
  /** Defaults to `INDEXER_VERSION` — threaded rather than read from the module-level constant so
   *  a test can vary skew without faking that export, the same reasoning `ReconcileInput` and
   *  `IndexTarget` both give. */
  indexerVersion?: string;
}

export interface IndexerDeps {
  /** Injected clock — `index-scan.ts`'s `IndexScanDeps.now` convention, threaded to the manifest's
   *  `createdAt` and (if supplied) the scan's own deadline clock. */
  now?: () => number;
  /** Defaults to `createDefaultAdapterRegistry()` (the noop fallback only) — a caller wires in
   *  RUN-216/218's real adapters here once they exist. */
  adapters?: IndexAdapterRegistry;
  /** Forwarded to `scanIndexSource` verbatim. */
  scan?: IndexScanDeps;
  /**
   * Paths the PREVIOUS generation indexed, for deletion detection (`index-entity.ts`'s
   * `computeDeletions`). Optional and caller-supplied because this module makes zero network
   * calls and holds no local job state of its own (locked decision 10) — a coordinator wiring in
   * an incremental pass supplies the prior generation's file list; a full pass with nothing to
   * diff against simply omits it, which correctly yields no deletions rather than treating an
   * absent baseline as "everything was deleted".
   */
  previousFilePaths?: Iterable<string>;
}

export interface IndexerResult {
  manifest: IndexGenerationManifest;
  batches: EncodedBatch[];
  /** The exact records `batches` were encoded from, already in final sorted order
   *  (`sortRecords`) — informational, for a caller that wants entity/edge detail without
   *  decompressing `batches` back out (RUN-219's debug CLI is the first, and the reason this
   *  field exists at all: it has no server or network path of its own, only local inspection).
   *  Never an alternate source of truth for `manifest.contentHash` or a batch's own bytes — those
   *  are computed from `sorted` before this field is even assigned, so a caller that wants the
   *  CANONICAL fact reads `manifest`/`batches`, never re-derives it by re-hashing this array. */
  records: readonly IndexRecord[];
  diagnostics: readonly IndexDiagnostic[];
  diagnosticsOverflow: number;
  scanStatuses: readonly IndexStatusRecord[];
  scanStatusOverflow: number;
  /** True when the underlying scan stopped early (a bound or the deadline tripped) — the result
   *  is a PREFIX of the repository, forwarded verbatim from `IndexScanResult`. */
  stoppedEarly: boolean;
  /** `adapter.id -> adapter.version` for every adapter that parsed at least one file this run —
   *  RUN-215 scope's "record indexer and parser versions", the per-parser half (the manifest's
   *  own `indexerVersion` is the whole-daemon half). Informational only; nothing branches on it. */
  parserVersions: Record<string, string>;
  /** How many `'inferred'`-confidence call edges (`index-adapters.ts`'s `ParsedCall`) an adapter
   *  returned but this indexer did NOT place on the wire (RUN-216) — the current wire `EdgeRecord`
   *  shape mirrors the server row field-for-field (`index-batch.ts`'s own locked decision 1) and
   *  has no field to carry confidence, so upgrading an inferred call to an ordinary `calls` edge
   *  would make it indistinguishable from a resolved one on the wire — exactly what locked decision
   *  7 forbids. Counted rather than silently dropped so "an inferred edge is distinguishable from a
   *  resolved one" is an observable property of a run, not only of one adapter's own unit tests. */
  inferredEdgesOmitted: number;
  /** Symbols an adapter emitted with an empty/whitespace-only `label`, dropped before the wire
   *  because `MemoryNode.label` in the vendored contract is `z.string().min(1)` — see the comment
   *  at the drop site. Counted rather than silently discarded for the same reason
   *  `inferredEdgesOmitted` is: a row this daemon chose not to send is a fact about the generation,
   *  and one unlabelled row used to fail an ENTIRE generation with a server-side 409. Expected to
   *  be 0 on almost every repo; a non-zero value names an adapter worth looking at. */
  unlabelledSymbolsDropped: number;
}

/** Scan `source` under `config` and produce a complete, ready-to-upload generation. */
export async function runIndexer(
  source: IndexSource,
  config: ResolvedIndexConfig,
  target: IndexRunTarget,
  deps: IndexerDeps = {},
): Promise<IndexerResult> {
  const now = deps.now ?? Date.now;
  const registry = deps.adapters ?? createDefaultAdapterRegistry();
  const indexerVersion = target.indexerVersion ?? INDEXER_VERSION;
  const scope: UriScope = { projectKey: target.projectKey, repositoryKey: target.repositoryKey };

  const scanResult = await scanIndexSource(source, config, deps.scan);

  const records: IndexRecord[] = [];
  const diagnostics = new DiagnosticsCollector();
  const parserVersions: Record<string, string> = {};
  const currentPaths: string[] = [];
  // Collected during the loop, resolved AFTER it — see this module's own doc on why `imports`
  // cannot resolve inside the candidate loop itself (RUN-217 locked decision 2).
  const pendingImports: Array<{ importerPath: string; specifier: string }> = [];
  let inferredEdgesOmitted = 0;
  let unlabelledSymbolsDropped = 0;

  for (const candidate of scanResult.candidates) {
    const path = normalizeRepoPath(candidate.path);
    currentPaths.push(path);

    // RUN-258: a high-confidence credential marker in FULL-mode content withholds this file's
    // `content` the same way `contentMode: 'metadata'` does — see this module's doc for why the
    // check runs here, before the field is assigned, and why it forecloses adapter parsing below
    // rather than only nulling the file entity.
    const credentialMarker =
      candidate.contentMode === 'full' ? scanTextForCredentialMarkers(candidate.content) : null;
    if (credentialMarker) {
      diagnostics.push({
        path,
        message: `file content withheld: contains a credential marker (${credentialMarker})`,
        severity: 'warning',
        source: 'index-redact',
      });
    }

    const fileUri = buildFileEntityUri(scope, path);
    records.push({
      kind: 'node',
      uri: fileUri,
      type: 'file',
      label: path.split('/').pop() || path,
      content: candidate.contentMode === 'full' && !credentialMarker ? candidate.content : null,
    });

    // Adapters need decoded source text — a 'metadata'-mode candidate, or a 'full'-mode candidate
    // whose content was just withheld for a credential marker, contributes only the file entity
    // above (see this module's doc).
    if (candidate.contentMode !== 'full' || credentialMarker) continue;

    const adapter = registry.select(path);
    if (!adapter) continue;

    let parsed: Awaited<ReturnType<typeof adapter.parse>>;
    try {
      parsed = await adapter.parse({ path, content: candidate.content });
    } catch (err) {
      // RUN-216 locked decision 5: a parser adapter throwing (a WASM trap, an OOM, an internal
      // adapter bug) must cost this ONE file's symbol coverage, never the whole generation — the
      // file's own entity record is already pushed above, so it survives regardless. Tree-sitter
      // itself never throws for ordinary syntax errors (error-tolerant by design, measured), so
      // reaching here means something outside ordinary parsing went wrong; this is the seam-level
      // backstop that holds even for an adapter less careful than this daemon's own.
      diagnostics.push({
        path,
        message: `adapter '${adapter.id}' threw while parsing: ${err instanceof Error ? err.message : String(err)}`,
        severity: 'error',
        source: `${adapter.id}@${adapter.version}`,
      });
      parserVersions[adapter.id] = adapter.version;
      continue;
    }
    parserVersions[adapter.id] = adapter.version;

    const dedupedPaths = dedupeSymbolPaths(parsed.symbols.map((s) => s.symbolPath));
    // Raw (pre-dedup) symbolPath -> minted URI, so a same-file `calls` edge (below) can resolve a
    // `ParsedCall`'s `fromSymbolPath`/`toSymbolPath` — always the adapter's OWN raw paths, per
    // `index-adapters.ts`'s contract — back to the real entity this loop already minted for it.
    const uriByRawSymbolPath = new Map<string, string>();
    parsed.symbols.forEach((symbol, i) => {
      // The wire contract requires a non-empty label (`MemoryNode.label` is `z.string().min(1)` in
      // the vendored slice), and nothing local used to check it — so ONE unlabelled row out of 6454
      // made the server reject the whole BATCH (`409 staged node row missing label`) and fail the
      // entire generation, on the first real upload this daemon ever attempted. The adapter that
      // produced it now declines the shape at its source (`index-formats.ts`'s `isNameableKey`:
      // npm's lockfile keys its root package as `""`), and this is the BACKSTOP for every other
      // route to the same row — a node minted here reaches the wire, so this is the last place it
      // can be refused locally rather than 409'd after a round trip. Dropped, never relabelled: a
      // synthesized name would invent an identity the source never had. Counted so a silent drop is
      // still a visible one, and its `declares` edge is skipped with it — an edge to a node that
      // was never sent is an edge to nothing (`imports` resolution's own rule, one layer down).
      if (!symbol.label.trim()) {
        unlabelledSymbolsDropped += 1;
        return;
      }
      const symbolPath = dedupedPaths[i] ?? symbol.symbolPath;
      const symbolUri = buildSymbolEntityUri(scope, path, symbolPath, symbol.nodeType);
      uriByRawSymbolPath.set(JSON.stringify(symbol.symbolPath), symbolUri);
      records.push({
        kind: 'node',
        uri: symbolUri,
        type: symbol.nodeType,
        label: symbol.label,
        content: symbol.content,
        // Inert on the wire (`index-entity.ts`'s own doc on `EntityRecord.range`) — carried
        // through only so `IndexerResult.records` below has it for a caller that wants the range,
        // never so it can leak into `contentHash`/a batch's bytes.
        range: symbol.range,
      });
      records.push({ kind: 'edge', type: 'declares', from: fileUri, to: symbolUri });
    });

    for (const call of parsed.calls ?? []) {
      if (call.confidence === 'inferred') {
        // See `IndexerResult.inferredEdgesOmitted`'s own doc — the wire has nowhere to say
        // "unsure", so this is dropped rather than silently upgraded to a certain-looking edge.
        inferredEdgesOmitted += 1;
        continue;
      }
      const from = uriByRawSymbolPath.get(JSON.stringify(call.fromSymbolPath));
      const to = uriByRawSymbolPath.get(JSON.stringify(call.toSymbolPath));
      // May-miss-never-invent, one level down from the adapter: a `ParsedCall` naming a symbolPath
      // this same parse() didn't actually declare (an adapter bug, not a real scenario for a
      // well-behaved one) is dropped rather than trusted into an edge with a fabricated target.
      if (from && to) records.push({ kind: 'edge', type: 'calls', from, to });
    }

    for (const imp of parsed.imports ?? []) {
      pendingImports.push({ importerPath: path, specifier: imp.specifier });
    }

    for (const diagnostic of parsed.diagnostics) {
      diagnostics.push({
        path,
        message: diagnostic.message,
        severity: diagnostic.severity,
        source: `${adapter.id}@${adapter.version}`,
      });
    }
  }

  // Second pass (RUN-217 locked decision 2): resolve every pending import now that `currentPaths`
  // — the complete set this generation actually indexed — is finished, never against a
  // partially-built list a candidate loop order could make order-dependent. `imports` targets the
  // imported FILE entity, never a symbol inside it (locked decision 4); a URI is deterministic in
  // the resolved path alone (`buildFileEntityUri`), so no separate dedup key is minted here —
  // `seenImportEdges` collapses two specifiers from the same file resolving to the same target
  // (e.g. two separate `require()`/`import` statements naming the same sibling) into one edge.
  const currentPathSet = new Set(currentPaths);
  const seenImportEdges = new Set<string>();
  for (const { importerPath, specifier } of pendingImports) {
    const resolvedPath = resolveRelativeImport(importerPath, specifier, currentPathSet);
    if (!resolvedPath) continue; // bare, unresolved, or ambiguous — declined, never stubbed.
    const from = buildFileEntityUri(scope, importerPath);
    const to = buildFileEntityUri(scope, resolvedPath);
    const key = `${from}\u0000${to}`;
    if (seenImportEdges.has(key)) continue;
    seenImportEdges.add(key);
    records.push({ kind: 'edge', type: 'imports', from, to });
  }

  const deletions = computeDeletions(currentPaths, deps.previousFilePaths);
  const sorted = sortRecords(records);
  const contentHash = computeContentHash(sorted);
  const generationId = deriveGenerationId({
    projectId: target.projectId,
    repositoryKey: target.repositoryKey,
    branch: target.branch,
    baseId: target.baseId,
    indexerVersion,
  });
  const batches = encodeBatches(generationId, sorted);
  const manifest = assembleManifest({
    generationId,
    projectId: target.projectId,
    repositoryKey: target.repositoryKey,
    branch: target.branch,
    baseId: target.baseId,
    indexerVersion,
    batchCount: batches.length,
    fileCount: scanResult.candidates.length,
    contentHash,
    deletions,
    now,
  });

  return {
    manifest,
    batches,
    records: sorted,
    diagnostics: diagnostics.diagnostics,
    diagnosticsOverflow: diagnostics.overflow,
    scanStatuses: scanResult.statuses,
    scanStatusOverflow: scanResult.statusOverflow,
    stoppedEarly: scanResult.stoppedEarly,
    parserVersions,
    inferredEdgesOmitted,
    unlabelledSymbolsDropped,
  };
}
