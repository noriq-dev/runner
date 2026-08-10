import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { IndexGenerationManifest } from '@noriq-dev/shared';
import type { EdgeRecord, EntityRecord, IndexRecord } from './index-entity';
import { comparePaths } from './index-source';

/**
 * Deterministic sort, wire encoding, and batch splitting for Project Memory's indexer (RUN-215).
 *
 * **The wire row shape is defined in exactly ONE place: here** (locked decision 1). It mirrors the
 * server's `parseStagedRow` (`/var/home/mtuska/git/noriq/noriq/apps/api/src/memory/ingest.ts`,
 * read but never modified — that repo is a different trust/deploy boundary) field for field:
 *
 *   { kind: 'node', uri: string, type: string, label: string, content: string | null }
 *   { kind: 'edge', type: string, from: string, to: string }
 *
 * That server function throws naming what is missing rather than silently dropping a malformed
 * row, which is what makes it safe to proceed before the shape is promoted into
 * `packages/shared` (filed separately): a mismatch is loud, not silent — but it is still drift, so
 * it stays confined to `StagedNodeRow`/`StagedEdgeRow`/`toStagedRow` below rather than spreading
 * across every call site that happens to build a row-shaped object.
 *
 * **`batchHash` is the SHA-256 of the GZIPPED bytes, never the JSONL text** (locked decision 2,
 * verified against the server's own `verifyBatchChecksum`, which hashes the bytes it received
 * BEFORE calling `gunzip` — reject-before-decompress is deliberate there, so a hostile payload is
 * never decompressed at all). Hashing plaintext here would make every upload fail with
 * `verifyBatchChecksum`'s mismatch error, naming the wrong problem entirely.
 *
 * **A batch's COMPRESSED size stays under `MAX_INGEST_BATCH_BYTES` (8 MiB)** (locked decision 3).
 * `encodeBatches` never exploratorily compresses while accumulating rows: it bounds each batch's
 * UNCOMPRESSED byte count to `MAX_INGEST_BATCH_BYTES` minus a safety margin far larger than gzip's
 * true worst-case expansion (see `BATCH_SAFETY_MARGIN_BYTES`), so the compressed size is PROVEN
 * safe by construction and only needs to be measured once per finished batch, not probed row by
 * row. Packing decision (discretion): batches are packed GREEDILY toward that near-ceiling bound
 * rather than kept deliberately small, because RUN-214's per-batch idempotency key
 * (`generationId` + `batchNumber`, `IndexBatch`'s own doc) already isolates a failed upload to the
 * one batch that failed — bigger batches cut round trips with no matching retry-blast-radius cost,
 * since a retry never has to resend a batch that already landed.
 *
 * **Determinism is mechanical** (locked decision 6): `sortRecords` orders every record by (kind,
 * identity) with `comparePaths` — a plain code-unit comparison, imported rather than restated, so
 * this file and `index-source.ts` can never define "ascending" two different ways. `canonicalRow`
 * serializes with keys in SORTED order regardless of how the record's own fields were constructed,
 * so a future refactor of `EntityRecord`/`EdgeRecord`'s field order can never silently change a
 * byte of what gets uploaded. Nothing here calls `Date.now()` or `Math.random()` — the only
 * timestamp in this whole pipeline is `IndexGenerationManifest.createdAt`, injected via `deps.now`
 * exactly like `index-scan.ts`'s own clock injection, and it is a MANIFEST field, never a row
 * field.
 *
 * **`computeContentHash` and `encodeBatches` cooperatively yield (RUN-238)** — the measured defect
 * (`bench/index-load.mts`, an 8000-file/335920-record tree matching this repo's own shape) found a
 * single continuous 6.3s event-loop block covering the parse loop AND this file's own synchronous
 * tail: 382ms hashing plus 904ms encoding, back to back with no yield between them. Both functions
 * now walk `sortedRecords` one at a time (never a pre-built `.map()` array — the SAME per-record
 * work, just not all materialized before the first byte is hashed/packed) and yield to a REAL
 * macrotask (`setImmediate`, via `cooperativeCheckpoint` below) every `yieldEveryRecords` records —
 * never a microtask (`Promise.resolve()` or an already-resolved `await`), because that is exactly
 * what the measured defect already showed refills the microtask queue and starves timers/poll
 * (RUN-238's own anchor measurement pinned it to `await adapter.parse(...)` in `indexer.ts`'s
 * candidate loop; the same shape applies here). `sortRecords` deliberately does NOT chunk: it is
 * one native `Array.prototype.sort` call — 52ms on the same measured tree — and V8 gives no
 * mid-sort yield point to hook; splitting the INPUT into chunks would change comparison order (a
 * correctness risk) for a block already an order of magnitude below hash/encode's own. It still
 * takes `CooperativeDeps` and checks once before sorting, so an already-aborted/-busy pass never
 * pays for a sort whose result nothing will use.
 *
 * **The record order and every hashed/encoded byte are UNCHANGED by yielding** (locked decision,
 * RUN-238): a `setImmediate` between two loop iterations suspends and resumes the SAME loop over
 * the SAME array at the SAME index — it inserts a pause, never a reorder. `computeContentHash`
 * hashes incrementally (`hash.update` per record, a literal `'\n'` between records, none after the
 * last) rather than building the old `.map().join('\n')` string first — chosen so a huge repository
 * never holds a second copy of its own serialized content in memory just to hash it, and verified
 * byte-identical to the prior joined-string form by `index-batch.test.ts`. `bench/index-load.mts`
 * proves this on the real generated tree, not only in a fixture-sized unit test (RUN-238 acceptance:
 * "indexing the same tree twice produces the identical contentHash with yielding enabled").
 */

// ---------------------------------------------------------------------------
// Wire row shape (locked decision 1)
// ---------------------------------------------------------------------------

export interface StagedNodeRow {
  kind: 'node';
  uri: string;
  type: string;
  label: string;
  content: string | null;
}

export interface StagedEdgeRow {
  kind: 'edge';
  type: string;
  from: string;
  to: string;
}

export type StagedRow = StagedNodeRow | StagedEdgeRow;

// ---------------------------------------------------------------------------
// Cooperative yielding (RUN-238)
// ---------------------------------------------------------------------------

/** Why a pass stopped short of a manifest — mirrors `IngestError`'s own `reason`-carrying shape
 *  (`ingest-client.ts`) rather than a bare string, so a caller (a log line, a test) can branch on
 *  it without parsing `.message`. */
export type IndexInterruptReason = 'aborted' | 'busy';

/** Thrown from a cooperative checkpoint (never from anywhere else in this pipeline) when the
 *  pass must stop before it finishes. Deliberately a THROW, not a sentinel return: every caller
 *  between here and `runIndexer`'s own top level is plain synchronous-shaped orchestration with no
 *  outcome type of its own to carry a sentinel through, and `index-work.ts` already lets a thrown
 *  Error from `runIndexer` reach the coordinator's existing catch-all (`index work step failed`,
 *  logged and never rethrown) — the identical path `uploadGeneration`'s own `UploadCancelled`
 *  (`index-upload.ts`) already takes one phase later. Reusing that class here would be the wrong
 *  signal: an aborted PARSE never touched the journal, upload, or staging that class's name and
 *  doc are about — this is deliberately its own type, checked with `instanceof` where the reason
 *  matters (`test/index-yield.test.ts`) and just another `Error` everywhere else. */
export class IndexInterrupted extends Error {
  constructor(
    readonly reason: IndexInterruptReason,
    message: string,
  ) {
    super(message);
    this.name = 'IndexInterrupted';
  }
}

/** What every cooperative checkpoint in the indexer needs — `indexer.ts`'s candidate loop and this
 *  file's own hash/encode tails share this shape so a signal or a busy daemon is honoured
 *  identically wherever a pass can be interrupted, per RUN-238's locked decision to check both "at
 *  the same yield points." */
export interface CooperativeDeps {
  /** The coordinator's own `AbortSignal` (`IndexWorkContext.signal`), threaded all the way down —
   *  before RUN-238 this never reached `runIndexer` at all (only `uploadGeneration`, one phase
   *  later), so `cancelRepo`/`cancelAll` could not interrupt a parse in progress. */
  signal?: AbortSignal;
  /** `IndexWorkContext.isRunBusy` — re-checked HERE rather than trusted from `attempt()`'s one
   *  top-of-function check, because a run assigned mid-pass would otherwise share a starved loop
   *  for the whole remainder of an already-decided-to-be-lower-priority job. */
  isRunBusy?: () => boolean;
  /** Test-only override for how many units of work separate one checkpoint from the next —
   *  production leaves this unset and gets the measured default (see each call site). Mirrors
   *  `EncodeBatchesOptions.maxUncompressedBytes`'s own "test-only, production never passes this"
   *  convention: a fast test forces a checkpoint after every single item without needing thousands
   *  of fixture records to reach one. */
  yieldEveryRecords?: number;
}

/** Yield to the event loop via a REAL macrotask. Never `Promise.resolve()` or a bare `await` on an
 *  already-resolved promise — RUN-238's own anchor measurement is precisely that a microtask
 *  continuation (`await adapter.parse(...)`) refills the microtask queue every iteration and never
 *  lets a timer or the poll phase run, so a "yield" built the same way would look like a fix and
 *  change nothing. `setImmediate` is a Node-only macrotask, acceptable here because this whole
 *  pipeline already assumes a Node daemon (`node:crypto`, `node:zlib` above). */
function macrotaskYield(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** One cooperative checkpoint: check the signal, then the busy predicate, THEN yield — in that
 *  order, so an already-interrupted pass never pays for a macrotask hop it is about to throw past
 *  anyway. Exported so `indexer.ts`'s candidate loop (the parse-time half of the same measured
 *  block) shares this instead of a second, possibly-diverging implementation of "check both, yield
 *  once." Called at the START of every chunked function below (so even a fixture far smaller than
 *  `yieldEveryRecords` still observes an already-aborted/-busy signal) and then every
 *  `yieldEveryRecords` records thereafter. */
export async function cooperativeCheckpoint(deps: CooperativeDeps): Promise<void> {
  if (deps.signal?.aborted) throw new IndexInterrupted('aborted', 'indexing aborted');
  if (deps.isRunBusy?.()) {
    throw new IndexInterrupted('busy', 'indexing abandoned — the daemon became busy with a run');
  }
  await macrotaskYield();
}

/** Measured default (`bench/index-load.mts`, 335920 records): see `computeContentHash`'s own call
 *  site for the trade this trades off and the numbers behind the choice. */
const DEFAULT_YIELD_EVERY_RECORDS = 2_000;

export function toStagedRow(record: IndexRecord): StagedRow {
  return record.kind === 'node'
    ? { kind: 'node', uri: record.uri, type: record.type, label: record.label, content: record.content }
    : { kind: 'edge', type: record.type, from: record.from, to: record.to };
}

/** Serialize with SORTED object keys (locked decision 6) — independent of `StagedRow`'s own
 *  field-declaration order, so a struct-literal reshuffle in a future edit can never change a
 *  single byte of what two runs upload for identical input. */
function canonicalRowJson(row: StagedRow): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) {
    sorted[key] = (row as unknown as Record<string, unknown>)[key];
  }
  return JSON.stringify(sorted);
}

// ---------------------------------------------------------------------------
// Deterministic ordering (locked decision 6)
// ---------------------------------------------------------------------------

/** A node's identity is its `uri`; an edge has none of its own, so its identity is the tuple that
 *  actually distinguishes one edge from another — `comparePaths` (a plain code-unit compare,
 *  despite the name) is reused for whichever string this returns, never `localeCompare`. */
function recordIdentity(record: IndexRecord): string {
  return record.kind === 'node' ? record.uri : `${record.from}\u0000${record.type}\u0000${record.to}`;
}

/**
 * Sort every record by (kind, identity): nodes before edges (so a human skimming a raw batch sees
 * an entity before any edge that references it — the server does not care about this ordering,
 * only that it is the SAME ordering every run), then by `recordIdentity` within a kind. Plain
 * code-unit comparison throughout, never locale-aware — a locale-dependent sort would make the
 * SAME repository produce a different byte sequence on two machines with different ICU data,
 * defeating the idempotency key `IndexBatch`'s doc describes.
 */
export function sortRecords(records: readonly IndexRecord[]): IndexRecord[] {
  return [...records].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'node' ? -1 : 1;
    return comparePaths(recordIdentity(a), recordIdentity(b));
  });
}

// ---------------------------------------------------------------------------
// Content hash and generation id
// ---------------------------------------------------------------------------

/**
 * A single fingerprint over the WHOLE generation's content, independent of how it is later split
 * into batches — `IndexGenerationManifest.contentHash`. Computed over already-sorted, already-
 * canonicalized rows so re-running the same snapshot and versions reproduces it exactly.
 *
 * RUN-238: `async` and cooperatively yielding — measured at 382ms/335920 records on the anchor
 * tree, part of the 1.3s synchronous tail that used to run back to back with the parse loop's own
 * block with no yield anywhere. Hashes incrementally (one `hash.update` per record, a `'\n'`
 * between records and never after the last — byte-identical to the old `.map().join('\n')` form,
 * proven by `index-batch.test.ts`) rather than materializing the whole joined string first, so
 * this function's own peak memory does not grow with a second full-content copy on a huge repo.
 */
export async function computeContentHash(
  sortedRecords: readonly IndexRecord[],
  deps: CooperativeDeps = {},
): Promise<string> {
  const everyN = deps.yieldEveryRecords ?? DEFAULT_YIELD_EVERY_RECORDS;
  const hash = createHash('sha256');
  await cooperativeCheckpoint(deps); // guaranteed once, even for a fixture far under `everyN`.
  for (let i = 0; i < sortedRecords.length; i++) {
    if (i > 0) hash.update('\n', 'utf8');
    hash.update(canonicalRowJson(toStagedRow(sortedRecords[i]!)), 'utf8');
    if ((i + 1) % everyN === 0) await cooperativeCheckpoint(deps);
  }
  return hash.digest('hex');
}

export interface GenerationIdentity {
  projectId: string;
  repositoryKey: string;
  branch: string;
  baseId: string;
  indexerVersion: string;
}

/**
 * Derive `generationId` from exactly the five inputs locked decision 4 names — never random, never
 * time-based, so a post-crash re-run of the same (project, repository, branch, base, indexer
 * version) recognises itself as the SAME generation rather than starting a new one the server
 * cannot resume. `gen_` prefix only for readability in logs; nothing parses it back apart.
 */
export function deriveGenerationId(input: GenerationIdentity): string {
  const material = [
    input.projectId,
    input.repositoryKey,
    input.branch,
    input.baseId,
    input.indexerVersion,
  ].join('\u0000');
  return `gen_${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Batch encoding (locked decisions 2, 3)
// ---------------------------------------------------------------------------

/** Mirrors the server's own `MAX_INGEST_BATCH_BYTES` (`ingest.ts`) — redefined rather than
 *  imported because the row shape and this ceiling are today server-internal (see this file's
 *  module doc); a drift between the two numbers would surface immediately as `readBoundedBody`
 *  rejecting an upload, which is the same "loud, not silent" property locked decision 1 relies on. */
export const MAX_INGEST_BATCH_BYTES = 8 * 1024 * 1024;

/**
 * How far below the real ceiling a batch's UNCOMPRESSED size is capped, so its compressed size is
 * PROVABLY under `MAX_INGEST_BATCH_BYTES` without ever compressing while still accumulating rows.
 * DEFLATE's true worst case is a handful of bytes of framing overhead per 64 KiB "stored" block
 * (RFC 1951) plus an 18-byte gzip header/trailer — for an 8 MiB payload that is on the order of a
 * few hundred bytes. 512 KiB is over 100x that, generous enough to absorb it even if a future
 * change swaps compression strategies, while giving up only ~6% of the ceiling.
 */
const BATCH_SAFETY_MARGIN_BYTES = 512 * 1024;

const DEFAULT_MAX_BATCH_UNCOMPRESSED_BYTES = MAX_INGEST_BATCH_BYTES - BATCH_SAFETY_MARGIN_BYTES;

/** Fixed gzip options: determinism only needs a FIXED choice, not the fastest or smallest one —
 *  Node's `zlib.gzipSync` already zeroes the gzip header's MTIME field regardless of level (a
 *  fixed dependency-free fact, not a flag this file has to set), so the only thing choosing a
 *  level affects is upload size, and 9 buys the smallest payload for a job that never runs on a
 *  request's hot path. */
const GZIP_OPTIONS = { level: 9 } as const;

export function compressBatch(jsonl: string): Buffer {
  return gzipSync(Buffer.from(jsonl, 'utf8'), GZIP_OPTIONS);
}

export function computeBatchHash(compressed: Buffer): string {
  return createHash('sha256').update(compressed).digest('hex');
}

export interface EncodedBatch {
  generationId: string;
  batchNumber: number;
  batchHash: string;
  compressed: Buffer;
  rowCount: number;
}

export interface EncodeBatchesOptions extends CooperativeDeps {
  /** Test-only override for `DEFAULT_MAX_BATCH_UNCOMPRESSED_BYTES` — lets a test exercise
   *  multi-batch splitting without needing megabytes of fixture content. Production code never
   *  passes this. */
  maxUncompressedBytes?: number;
}

/**
 * Split `records` (already sorted — `sortRecords`) into one or more compressed, hashed batches.
 * Always produces AT LEAST ONE batch, even for zero records: `IndexGenerationManifest.batchCount`
 * is `positive` in the vendored schema, so an empty generation (everything excluded, denied, or
 * unreadable) still uploads one empty batch rather than being unrepresentable.
 *
 * RUN-238: `async` and cooperatively yielding — measured at 904ms/335920 records/11 batches on the
 * anchor tree, the largest single piece of the 1.3s synchronous tail (`gzipSync` at `level: 9`
 * dominates it; one call on the largest batch alone measured ~1ms, so the cost is the NUMBER of
 * `flush()` calls across a big generation, not any single one). Builds each line lazily off
 * `sortedRecords[i]` rather than a pre-built `lines` array, for the same peak-memory reasoning as
 * `computeContentHash`'s own doc.
 */
export async function encodeBatches(
  generationId: string,
  sortedRecords: readonly IndexRecord[],
  options: EncodeBatchesOptions = {},
): Promise<EncodedBatch[]> {
  const maxUncompressed = options.maxUncompressedBytes ?? DEFAULT_MAX_BATCH_UNCOMPRESSED_BYTES;
  const everyN = options.yieldEveryRecords ?? DEFAULT_YIELD_EVERY_RECORDS;

  const batches: EncodedBatch[] = [];
  let currentLines: string[] = [];
  let currentBytes = 0;

  const flush = (): void => {
    const jsonl = currentLines.length === 0 ? '' : `${currentLines.join('\n')}\n`;
    const compressed = compressBatch(jsonl);
    if (compressed.length > MAX_INGEST_BATCH_BYTES) {
      // Should be unreachable given the safety margin above (or an operator-configured
      // `maxFileBytes` bigger than one batch can ever safely hold — see this file's module doc's
      // note on that edge case). Refusing loudly here is the same "never silently degrade a
      // bound" posture `index-scan.ts` takes on its own bounds — an over-cap upload the server
      // would reject anyway must never be produced to begin with.
      throw new Error(
        `indexer batch ${batches.length} compressed to ${compressed.length} bytes, over the ${MAX_INGEST_BATCH_BYTES}-byte ceiling despite the safety margin — a single record's content is likely larger than one batch can ever safely hold; lower [index].maxFileBytes`,
      );
    }
    batches.push({
      generationId,
      batchNumber: batches.length,
      batchHash: computeBatchHash(compressed),
      compressed,
      rowCount: currentLines.length,
    });
    currentLines = [];
    currentBytes = 0;
  };

  await cooperativeCheckpoint(options); // guaranteed once, even for a fixture far under `everyN`.
  for (let i = 0; i < sortedRecords.length; i++) {
    const line = canonicalRowJson(toStagedRow(sortedRecords[i]!));
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // +1 for the newline joiner.
    if (currentLines.length > 0 && currentBytes + lineBytes > maxUncompressed) {
      flush();
    }
    currentLines.push(line);
    currentBytes += lineBytes;
    if ((i + 1) % everyN === 0) await cooperativeCheckpoint(options);
  }
  flush(); // Always runs — the one empty-generation batch, or the final partial one.

  return batches;
}

// ---------------------------------------------------------------------------
// Manifest assembly
// ---------------------------------------------------------------------------

export interface AssembleManifestInput {
  generationId: string;
  projectId: string;
  repositoryKey: string;
  branch: string;
  baseId: string;
  indexerVersion: string;
  batchCount: number;
  fileCount: number;
  contentHash: string;
  deletions: readonly string[];
  /** Injected clock (matches `index-scan.ts`'s `IndexScanDeps.now` convention) — the ONE place a
   *  timestamp is allowed in this whole pipeline (locked decision 6: "the manifest's own
   *  `createdAt` is a MANIFEST field — keep it there"). */
  now: () => number;
}

/** Build the vendored `IndexGenerationManifest` shape — kept here (discretion: "prefer here, so
 *  the manifest and the batches that must agree with it are produced together") rather than left
 *  for a coordinator work step to reassemble from parts that could drift out of sync with the
 *  batches actually encoded. */
export function assembleManifest(input: AssembleManifestInput): IndexGenerationManifest {
  return {
    generationId: input.generationId,
    projectId: input.projectId,
    repositoryKey: input.repositoryKey,
    branch: input.branch,
    baseId: input.baseId,
    indexerVersion: input.indexerVersion,
    batchCount: input.batchCount,
    fileCount: input.fileCount,
    contentHash: input.contentHash,
    deletions: [...input.deletions],
    createdAt: new Date(input.now()).toISOString(),
  };
}

// Re-exported so a caller building `EntityRecord`/`EdgeRecord` literals has a single import for
// both the record shapes and what this file does with them — avoids `index-entity.ts` and this
// file each becoming half of two different public surfaces for the same pipeline stage.
export type { EdgeRecord, EntityRecord, IndexRecord };
