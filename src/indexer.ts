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
 */

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
  let inferredEdgesOmitted = 0;

  for (const candidate of scanResult.candidates) {
    const path = normalizeRepoPath(candidate.path);
    currentPaths.push(path);

    const fileUri = buildFileEntityUri(scope, path);
    records.push({
      kind: 'node',
      uri: fileUri,
      type: 'file',
      label: path.split('/').pop() || path,
      content: candidate.contentMode === 'full' ? candidate.content : null,
    });

    // Adapters need decoded source text — a 'metadata'-mode candidate contributes only the file
    // entity above (see this module's doc).
    if (candidate.contentMode !== 'full') continue;

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
      const symbolPath = dedupedPaths[i] ?? symbol.symbolPath;
      const symbolUri = buildSymbolEntityUri(scope, path, symbolPath, symbol.nodeType);
      uriByRawSymbolPath.set(JSON.stringify(symbol.symbolPath), symbolUri);
      records.push({
        kind: 'node',
        uri: symbolUri,
        type: symbol.nodeType,
        label: symbol.label,
        content: symbol.content,
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

    for (const diagnostic of parsed.diagnostics) {
      diagnostics.push({
        path,
        message: diagnostic.message,
        severity: diagnostic.severity,
        source: `${adapter.id}@${adapter.version}`,
      });
    }
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
    diagnostics: diagnostics.diagnostics,
    diagnosticsOverflow: diagnostics.overflow,
    scanStatuses: scanResult.statuses,
    scanStatusOverflow: scanResult.statusOverflow,
    stoppedEarly: scanResult.stoppedEarly,
    parserVersions,
    inferredEdgesOmitted,
  };
}
