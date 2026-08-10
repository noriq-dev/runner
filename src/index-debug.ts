import type { SymbolRange } from './index-adapters';
import type { EdgeRecord, EntityRecord } from './index-entity';
import type { ResolvedIndexConfig } from './index-policy';
import { scanTextForSecretShapedContent } from './index-redact';
import type { IndexerResult } from './indexer';

/**
 * Pure report-building for `index-repo` (RUN-219) — turns an `IndexerResult` (already produced by
 * the REAL `runIndexer`, no fake shape of its own) into a bounded, redacted, JSON-and-text-render-
 * able summary. Deliberately holds no filesystem/process/child-process code: `index-repo.ts` is the
 * orchestrator that calls `runIndexer` and hands this module the result; this file only shapes what
 * comes out, so it is testable with nothing but an `IndexerResult` built over `FakeIndexSource`.
 *
 * **Bounded and redacted BY CONSTRUCTION, not by convention** (locked decisions 5 and the acceptance
 * line "no withheld value under any flag combination"). Two independent things are true here:
 *
 * 1. Every listing (`entities`, `edges`, `diagnostics.sample`) is capped at `limit` — the same
 *    "count and say how many were omitted" shape `DiagnosticsCollector`/`index-scan.ts`'s status
 *    cap already use elsewhere in this indexer, applied at the DISPLAY layer instead of the
 *    collection layer (a debug consumer asking to see 1,000,000 entities on a terminal is the
 *    unbounded-dump risk the acceptance line names, independent of whether the pipeline itself
 *    bounded anything upstream).
 * 2. `content` is OMITTED from every entity by default, and even under `--show-content` this
 *    module runs its OWN `scanTextForSecretShapedContent` pass (`index-redact.ts`) over every
 *    value before it is allowed into a rendered report — **measured, not assumed**: `indexer.ts`'s
 *    own `file`-entity push (`content: candidate.contentMode === 'full' ? candidate.content : null`)
 *    never calls the redactor at all. RUN-218's redaction only ever runs inside the JSON/TOML/
 *    markdown ADAPTERS, over the structured values *they* extract — a plain text/source file's raw
 *    `full`-mode content is never scanned for secret shape anywhere upstream of this file. That is
 *    an existing, out-of-scope-to-fix gap in the pipeline (flagged, not patched — see
 *    `index-repo.ts`'s and this task's own report), but it means a debug tool that just prints
 *    `record.content` verbatim under `--show-content` would be the first place in this whole
 *    pipeline a secret pasted into an ordinary file reaches a terminal. `displaySafeContent` below
 *    is this module's OWN floor against exactly that — independent of, and in addition to, whatever
 *    an adapter already withheld (the same "two independent floors, neither substitutes for the
 *    other" posture `index-redact.ts`'s own module doc states).
 *
 * Nothing here calls `runIndexer`, opens a file, or spawns a process — the whole reason this module
 * is testable with a hand-built `IndexerResult` and no real repository at all.
 */

export const DEFAULT_DEBUG_LIMIT = 50;

/** How much of one entity's content a `--show-content` listing may print — a size bound
 *  independent of the secret-shape check above (a long but ordinary docstring is not a secret and
 *  still should not flood a terminal). */
export const DEBUG_CONTENT_PREVIEW_CHARS = 400;

// ---------------------------------------------------------------------------
// Bounding
// ---------------------------------------------------------------------------

export interface BoundedList<T> {
  shown: T[];
  total: number;
  omitted: number;
}

/** Cap `items` at `limit`, reporting the true total and how many were left out — never a silent
 *  truncation a reader could mistake for the whole set. */
export function bounded<T>(items: readonly T[], limit: number): BoundedList<T> {
  const n = Math.max(0, Math.trunc(limit));
  const shown = items.slice(0, n);
  return { shown, total: items.length, omitted: Math.max(0, items.length - shown.length) };
}

// ---------------------------------------------------------------------------
// Display-time redaction (independent floor — see module doc)
// ---------------------------------------------------------------------------

/**
 * The value this report is allowed to SHOW for one entity's `content` — `null` when there is
 * nothing to show (absent, already withheld upstream) or when THIS module's own secret-shape scan
 * fires. All-or-nothing, never a masked prefix, matching `index-redact.ts`'s own posture: a prefix
 * is exactly what identifies a credential's type and issuer.
 */
export function displaySafeContent(content: string | null): string | null {
  if (content == null) return null;
  if (scanTextForSecretShapedContent(content)) return null;
  return content.length > DEBUG_CONTENT_PREVIEW_CHARS
    ? `${content.slice(0, DEBUG_CONTENT_PREVIEW_CHARS - 1)}…`
    : content;
}

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

export interface EntityView {
  uri: string;
  type: string;
  label: string;
  range?: SymbolRange;
  /** Present only when the caller asked to see content (`showContent`) — `null` means withheld
   *  (by an adapter, or by this module's own `displaySafeContent` floor), never a masked form. */
  content?: string | null;
}

export interface EdgeView {
  type: string;
  from: string;
  to: string;
}

export interface IndexDebugReport {
  root: string;
  configSource: 'project.toml' | 'forced-default';
  languages: string[];
  contentMode: string;
  generation: {
    generationId: string;
    contentHash: string;
    batchCount: number;
    fileCount: number;
    createdAt: string;
    deletionCount: number;
  };
  entityCounts: Record<string, number>;
  edgeCounts: Record<string, number>;
  diagnostics: { total: number; overflow: number; sample: SampleDiagnostic[] };
  scanStatuses: { total: number; overflow: number; byReason: Record<string, number> };
  parserVersions: Record<string, string>;
  inferredEdgesOmitted: number;
  unlabelledSymbolsDropped: number;
  /** RUN-280: see `IndexerResult.declinedModuleDependencies`'s own doc — surfaced here for the same
   *  reason `inferredEdgesOmitted` is: a debug report that hid a count `runIndexer` already computed
   *  would make the operator re-derive it from the raw edge listing instead of reading it. */
  declinedModuleDependencies: number;
  stoppedEarly: boolean;
  entities: BoundedList<EntityView>;
  edges: BoundedList<EdgeView>;
}

interface SampleDiagnostic {
  path: string;
  message: string;
  severity: 'error' | 'warning';
  source: string;
}

export interface BuildDebugReportOptions {
  root: string;
  configSource: 'project.toml' | 'forced-default';
  config: Pick<ResolvedIndexConfig, 'languages' | 'contentMode'>;
  limit?: number;
  showContent?: boolean;
}

function entityView(record: EntityRecord, showContent: boolean): EntityView {
  const view: EntityView = { uri: record.uri, type: record.type, label: record.label };
  if (record.range) view.range = record.range;
  if (showContent) view.content = displaySafeContent(record.content);
  return view;
}

function edgeView(record: EdgeRecord): EdgeView {
  return { type: record.type, from: record.from, to: record.to };
}

function countBy<T extends string>(items: readonly { type: T }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.type] = (counts[item.type] ?? 0) + 1;
  return counts;
}

/** Build the whole report from a completed `IndexerResult` — pure, no I/O. Bounds and redaction
 *  (see module doc) apply IDENTICALLY whether the caller renders this as text or serializes it as
 *  `--json`: both read off this one already-safe structure, so there is no second code path that
 *  could apply the floor inconsistently between the two output modes. */
export function buildDebugReport(result: IndexerResult, options: BuildDebugReportOptions): IndexDebugReport {
  const limit = options.limit ?? DEFAULT_DEBUG_LIMIT;
  const showContent = options.showContent ?? false;

  const nodes = result.records.filter((r): r is EntityRecord => r.kind === 'node');
  const edges = result.records.filter((r): r is EdgeRecord => r.kind === 'edge');

  const statusByReason: Record<string, number> = {};
  for (const status of result.scanStatuses) {
    statusByReason[status.reason] = (statusByReason[status.reason] ?? 0) + 1;
  }

  const boundedNodes = bounded(nodes, limit);
  const boundedEdges = bounded(edges, limit);
  const boundedDiagnostics = bounded(result.diagnostics, limit);

  return {
    root: options.root,
    configSource: options.configSource,
    languages: [...options.config.languages].sort(),
    contentMode: options.config.contentMode,
    generation: {
      generationId: result.manifest.generationId,
      contentHash: result.manifest.contentHash,
      batchCount: result.manifest.batchCount,
      fileCount: result.manifest.fileCount,
      createdAt: result.manifest.createdAt,
      deletionCount: result.manifest.deletions.length,
    },
    entityCounts: countBy(nodes),
    edgeCounts: countBy(edges),
    diagnostics: {
      total: result.diagnostics.length,
      overflow: result.diagnosticsOverflow,
      sample: boundedDiagnostics.shown.map((d) => ({
        path: d.path,
        message: d.message,
        severity: d.severity,
        source: d.source,
      })),
    },
    scanStatuses: {
      total: result.scanStatuses.length,
      overflow: result.scanStatusOverflow,
      byReason: statusByReason,
    },
    parserVersions: { ...result.parserVersions },
    inferredEdgesOmitted: result.inferredEdgesOmitted,
    unlabelledSymbolsDropped: result.unlabelledSymbolsDropped,
    declinedModuleDependencies: result.declinedModuleDependencies,
    stoppedEarly: result.stoppedEarly,
    entities: {
      shown: boundedNodes.shown.map((n) => entityView(n, showContent)),
      total: boundedNodes.total,
      omitted: boundedNodes.omitted,
    },
    edges: {
      shown: boundedEdges.shown.map(edgeView),
      total: boundedEdges.total,
      omitted: boundedEdges.omitted,
    },
  };
}

/** Human-readable rendering of `buildDebugReport`'s output — the default (`--json` is the other
 *  rendering of the exact same, already-bounded-and-redacted structure). */
export function renderDebugReport(report: IndexDebugReport): string {
  const lines: string[] = [];
  lines.push(`noriq-runner index-repo — ${report.root}`);
  lines.push(
    `config (${report.configSource}): languages=[${report.languages.join(', ')}] contentMode=${report.contentMode}`,
  );
  lines.push('');
  lines.push(`generation ${report.generation.generationId}`);
  lines.push(`  contentHash:  ${report.generation.contentHash}`);
  lines.push(
    `  files: ${report.generation.fileCount}  batches: ${report.generation.batchCount}  deletions: ${report.generation.deletionCount}`,
  );
  lines.push(`  createdAt: ${report.generation.createdAt}`);
  if (report.stoppedEarly) {
    lines.push(
      '  NOTE: the scan stopped early — this is a PREFIX of the repository (a bound or the deadline tripped)',
    );
  }
  lines.push('');
  lines.push(`entities: ${formatCounts(report.entityCounts)}`);
  // Only when non-zero, and worded as a defect rather than a statistic: an inferred edge omitted
  // from the wire is normal and expected, an unlabelled row is always an adapter emitting something
  // the contract cannot carry. A zero here would be noise on every healthy run.
  if (report.unlabelledSymbolsDropped > 0) {
    lines.push(
      `  NOTE: ${report.unlabelledSymbolsDropped} symbol(s) had an empty label and were dropped before the wire — an adapter emitted a row the contract cannot carry (label is min(1))`,
    );
  }
  lines.push(
    `edges: ${formatCounts(report.edgeCounts)} (inferred, omitted from the wire: ${report.inferredEdgesOmitted})`,
  );
  // RUN-280: only when non-zero — a repo with no UBT descriptors leaves this at 0, and printing it
  // there would be noise on every non-Unreal run. Worded as expected, not a defect: most UBT
  // dependencies are engine modules this generation never scanned (see this field's own doc).
  if (report.declinedModuleDependencies > 0) {
    lines.push(
      `  NOTE: ${report.declinedModuleDependencies} UBT module dependency name(s) resolved to no module this generation declared (engine modules, or an ambiguous duplicate name) — no edge emitted`,
    );
  }
  lines.push('');
  lines.push(
    `diagnostics: ${report.diagnostics.total}${report.diagnostics.overflow ? ` (+${report.diagnostics.overflow} beyond the collector's own cap)` : ''}`,
  );
  for (const d of report.diagnostics.sample)
    lines.push(`  [${d.severity}] ${d.path}: ${d.message} (${d.source})`);
  lines.push('');
  lines.push(
    `scan statuses: ${report.scanStatuses.total}${report.scanStatuses.overflow ? ` (+${report.scanStatuses.overflow} beyond the collector's own cap)` : ''}`,
  );
  for (const [reason, count] of Object.entries(report.scanStatuses.byReason).sort()) {
    lines.push(`  ${reason}: ${count}`);
  }
  lines.push('');
  const versions = Object.entries(report.parserVersions).sort();
  lines.push(
    `parser versions: ${versions.length ? versions.map(([id, v]) => `${id}@${v}`).join(', ') : '(none ran)'}`,
  );
  lines.push('');
  lines.push(
    `entities (showing ${report.entities.shown.length} of ${report.entities.total}, ${report.entities.omitted} omitted):`,
  );
  for (const e of report.entities.shown) {
    const range = e.range ? ` [lines ${e.range.startLine}-${e.range.endLine}]` : '';
    lines.push(`  [${e.type}] ${e.uri} — ${e.label}${range}`);
    if (e.content !== undefined) {
      lines.push(
        e.content === null
          ? '      (content withheld or empty)'
          : `      ${e.content.replace(/\n/g, '\n      ')}`,
      );
    }
  }
  lines.push('');
  lines.push(
    `edges (showing ${report.edges.shown.length} of ${report.edges.total}, ${report.edges.omitted} omitted):`,
  );
  for (const e of report.edges.shown) lines.push(`  ${e.type}  ${e.from}  ->  ${e.to}`);
  return lines.join('\n');
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort();
  return entries.length ? entries.map(([k, v]) => `${k}=${v}`).join(' ') : '(none)';
}

// ---------------------------------------------------------------------------
// Determinism check ("validate deterministic output" — task's own acceptance line)
// ---------------------------------------------------------------------------

export interface DeterminismCheck {
  ok: boolean;
  mismatches: string[];
}

/** Compare two `IndexerResult`s over what the wire actually treats as canonical — `generationId`,
 *  the manifest's `contentHash`, and every batch's hash AND raw compressed bytes (locked decision
 *  10's own "batch bytes" — hash equality alone would miss a same-hash collision, astronomically
 *  unlikely for SHA-256 but a real byte compare is free here and is what "byte-identical batches"
 *  in the acceptance line actually means). Deliberately does NOT compare `manifest.createdAt` —
 *  that is a timestamp, never part of `contentHash` or a batch (`index-batch.ts`'s own "the only
 *  timestamp in this whole pipeline ... is a MANIFEST field, never a row field"), so two runs
 *  legitimately disagree on it without the run being non-deterministic in any sense this check
 *  cares about. */
export function compareGenerations(a: IndexerResult, b: IndexerResult): DeterminismCheck {
  const mismatches: string[] = [];
  if (a.manifest.generationId !== b.manifest.generationId) mismatches.push('manifest.generationId differs');
  if (a.manifest.contentHash !== b.manifest.contentHash) mismatches.push('manifest.contentHash differs');
  if (a.manifest.fileCount !== b.manifest.fileCount) mismatches.push('manifest.fileCount differs');
  if (a.batches.length !== b.batches.length) {
    mismatches.push(`batch count differs (${a.batches.length} vs ${b.batches.length})`);
  } else {
    for (let i = 0; i < a.batches.length; i++) {
      const ba = a.batches[i]!;
      const bb = b.batches[i]!;
      if (ba.batchHash !== bb.batchHash) {
        mismatches.push(`batch ${i} batchHash differs`);
      } else if (!ba.compressed.equals(bb.compressed)) {
        mismatches.push(`batch ${i} compressed bytes differ despite an equal batchHash (hash collision?)`);
      }
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}
