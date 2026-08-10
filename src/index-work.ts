import type { NoriqClient } from './client';
import type { IndexWorkContext, IndexWorkResult, IndexWorkStep } from './index-coordinator';
import { buildIndexAdapterRegistry } from './index-registry';
import type { IndexStatusReason } from './index-scan';
import { type StagingStore, fileStagingStore } from './index-stage';
import { boundedValidationProblems, uploadGeneration } from './index-upload';
import { runIndexer } from './indexer';
import { logger as defaultLogger } from './logger';
import type { VcsBackend } from './vcs/types';

/**
 * The real `IndexWorkStep` (RUN-222 locked decision 5) — the middle `index-coordinator.ts`
 * deliberately left uninvented: a leased snapshot's `source` → `runIndexer` (RUN-215/216, with
 * `buildIndexAdapterRegistry` gating adapters by `config.languages`, RUN-219) → `uploadGeneration`
 * (RUN-221). Every piece already exists; this module's only job is the WIRING between them, never
 * a second copy of scanning, hashing, batching, or retry logic — that would be a second answer to
 * "what is this generation," and this codebase already has one.
 *
 * **Reads `snapshot.source`, never `snapshot.localPath`** (locked decision 6, restated after
 * RUN-281): a step reaching for a filesystem path off `localPath` and opening it ITSELF would work
 * on git (a trusted, exclusively-owned detached worktree) and silently read unverified,
 * possibly-stale bytes on Diversion, whose `localPath` is a CANDIDATE, never a trust guarantee
 * (`vcs/types.ts`'s own doc on `IndexSnapshot.localPath` carries the full split). This module still
 * never touches that field at all: `runIndexer` takes an `IndexSource`, and the verify-then-read
 * logic already lives entirely inside the source Diversion's own backend constructed — this is
 * simply never reaching for the other field, on either backend, for either reason.
 *
 * **Folds a source-declared deadline floor into `config` before scanning** (RUN-281): an
 * API-backed source's `read()` may cost a real network round trip per file (Diversion: measured
 * 161ms/file), and `readDeadlineMs`'s manifest default (120s) is calibrated for a filesystem walk —
 * unrelated to the fast path above, which only helps when a verified local candidate exists at
 * all. `Math.max(config.readDeadlineMs, snapshot.source.minReadDeadlineMs ?? 0)` is the ONE place
 * this floor is applied: `IndexSource.minReadDeadlineMs`'s own doc explains why it lives here
 * rather than inside `index-scan.ts`'s policy engine, which is deliberately blind to which source
 * it is scanning.
 *
 * **Closes over `releaseIndexSnapshot` and hands it to `uploadGeneration` as `release`** (locked
 * decision 7): `IndexWorkContext` carries no VCS access on purpose (`index-coordinator.ts`'s own
 * doc — the coordinator owns lifecycle, not content, and a work step reaching back into the VCS
 * seam on its own would blur that line). `vcsFor` is injected here instead, at construction time,
 * the same routing every other VCS-seam caller in `daemon.ts` uses
 * (`backendFor.get(root) ?? vcs`) — resolved per call against `target.repoRoot`, never cached,
 * because a repo's backend does not change between jobs but this module has no business assuming
 * that. `releaseIndexSnapshot` is documented idempotent, so the coordinator's own `finally`
 * releasing again once this function returns is free — this is the EARLY release RUN-221 built
 * (stage locally under the bound, release the lease BEFORE the first network call), not a
 * replacement for the coordinator's own unconditional one.
 *
 * **`runnerId` is a constant, injected once** (mirrors `daemon.ts`'s own `getCursor` closure,
 * which already captures `runner.id` the identical way) — never threaded through `IndexTarget`,
 * which has no business knowing the daemon's own registration identity.
 *
 * **A failed upload THROWS** rather than being swallowed here: `uploadGeneration` already returns
 * a typed, non-throwing outcome for every ORDINARY failure (a validation rejection, a terminal
 * ingest error, a cancellation) — this module turns a non-`ok` outcome into a thrown `Error` so the
 * coordinator's own existing catch (`index work step failed`, logged and never rethrown to the
 * trigger caller) is the ONE place that outcome is reported, rather than a second log line here
 * duplicating it. Nothing about that log reaches a landing, a publish, or a run — the coordinator's
 * `attempt()` already catches everything a work step throws (locked decision 11, restated at the
 * seam that actually calls this).
 */

export interface IndexWorkStepDeps {
  client: NoriqClient;
  /** This daemon's own registration id (`runner.id`) — the same identity `getIndexCursor` already
   *  carries, needed here to mint an ingest capability scoped to it. */
  runnerId: string;
  /** The same `backendFor.get(root) ?? vcs` routing every other VCS-seam caller uses — resolved
   *  per call against `target.repoRoot`, never assumed stable across jobs. */
  vcsFor: (repoRoot: string) => Pick<VcsBackend, 'releaseIndexSnapshot'>;
  /** Defaults to the real `~/.noriq/index-staging` store — injectable so a test never touches a
   *  real home directory. */
  staging?: StagingStore;
  logger?: typeof defaultLogger;
  /** Injected clock, threaded to `runIndexer`'s own `now` — test-only; production leaves it unset. */
  now?: () => number;
  /** Forwarded to `uploadGeneration` verbatim — test-only; production leaves it at the default. */
  maxStagedBytes?: number;
  /** The token-authorized ingest calls' own transport, forwarded to `uploadGeneration` verbatim
   *  (its own `fetchImpl`, distinct from the client's — `index-upload.ts`'s own doc on why mint
   *  and ingest are two separate transports). Test-only; production leaves it at global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Build the real work step. Called ONCE, at daemon construction (`daemon.ts`'s own
 *  `IndexCoordinator` wiring) — every job reuses the same closure, exactly like every other
 *  long-lived dep the coordinator holds. */
export function createIndexWorkStep(deps: IndexWorkStepDeps): IndexWorkStep {
  const staging = deps.staging ?? fileStagingStore();
  const log = deps.logger ?? defaultLogger;

  return async (ctx: IndexWorkContext): Promise<IndexWorkResult> => {
    const { target, snapshot, config, journal, signal } = ctx;

    // Defensive, not reachable in the ordinary path: `reconcile` never yields `incremental`/`full`
    // without a fetched cursor, and `getIndexCursor` treats a null projectId as a precondition
    // failure BEFORE that — see index-coordinator.ts's own doc on `IndexTarget.projectId`. A thrown
    // Error here reaches the coordinator's existing catch, logged and never rethrown.
    if (!target.projectId) {
      throw new Error(
        `index work step reached with no resolved projectId for repositoryKey=${target.repositoryKey} — reconcile should never have leased a snapshot for this target`,
      );
    }

    // RUN-223 locked decision 4: this is the only code that knows when parsing genuinely starts —
    // reporting it any earlier (say, from the coordinator, before the snapshot lease) would be a
    // guess about how long leasing takes rather than an observation of parsing itself.
    ctx.onProgress?.('parsing');
    const { registry } = buildIndexAdapterRegistry(config);
    // RUN-281: raise, never lower, the repo's own configured deadline when the leased snapshot's
    // source declares it needs more — see this module's own doc for why the fold happens HERE
    // rather than inside `index-scan.ts`'s source-blind policy engine.
    const effectiveConfig = {
      ...config,
      readDeadlineMs: Math.max(config.readDeadlineMs, snapshot.source.minReadDeadlineMs ?? 0),
    };
    const indexed = await runIndexer(
      snapshot.source,
      effectiveConfig,
      {
        projectId: target.projectId,
        projectKey: target.projectKey,
        repositoryKey: target.repositoryKey,
        // The scope reported for the manifest's `branch` field — a display fact, never an operand
        // (`vcs/types.ts`'s own doc on `IndexSnapshot.branch`, which names "default"/"integration"
        // as the symbolic class a `BranchRef` admits when no single branch applies). Git's snapshot
        // is detached by construction and carries no branch at all.
        branch: snapshot.branch ?? 'default',
        // The snapshot's OWN base, never `target.currentBaseId` — the snapshot is what was actually
        // scanned, and `currentBaseId` is only ever a trigger-time approximation `reconcile` used to
        // decide whether to lease at all (index-coordinator.ts's own module doc).
        baseId: snapshot.baseId,
        indexerVersion: target.indexerVersion,
      },
      // RUN-238: `ctx.signal`/`ctx.isRunBusy` reach the parse loop from here — before this they
      // were only ever forwarded to `uploadGeneration` below (a phase later), so `cancelRepo`
      // could not interrupt a parse in progress and a run assigned mid-pass shared a starved loop
      // with it for the rest of that pass's duration.
      { now: deps.now, adapters: registry, signal: ctx.signal, isRunBusy: ctx.isRunBusy },
    );

    const key = {
      server: target.server,
      repositoryKey: target.repositoryKey,
      baseId: snapshot.baseId,
      indexerVersion: indexed.manifest.indexerVersion,
      generationId: indexed.manifest.generationId,
    };

    // RUN-234: the ONLY place this daemon reports what `runIndexer` actually found for a
    // background job — before this, `indexed.diagnostics`/`.scanStatuses`/`.stoppedEarly` were
    // computed, bounded, and then dropped on the floor here; the sole way to see any of it was
    // `noriq-runner index-repo` run locally against the same checkout (`INDEX-OPERATIONS.md`'s
    // own Troubleshooting section: "This is invisible in `index-status`... The only way to see
    // it is `index-repo`"). Counts and a closed-vocabulary breakdown only (locked decision 2): a
    // `path` never appears here — `scanStatuses`/`diagnostics` are each already capped collectors
    // (`MAX_STATUS_RECORDS`/`MAX_PARSE_DIAGNOSTICS`) with their own overflow counters, so summing
    // by `reason`/`severity` (both closed enums, a handful of values) stays bounded regardless of
    // repository size — this line's own cost does not grow with the repo the way a per-file
    // listing would. `warn` only when there is something an operator would want to chase (a real
    // parse error, an overflowed collector, or a scan that stopped short of the whole tree);
    // otherwise `info`, the same "routine unless it isn't" split every other job-level line here
    // already uses.
    const diagnosticErrors = indexed.diagnostics.filter((d) => d.severity === 'error').length;
    const skippedByReason: Partial<Record<IndexStatusReason, number>> = {};
    for (const status of indexed.scanStatuses) {
      skippedByReason[status.reason] = (skippedByReason[status.reason] ?? 0) + 1;
    }
    const parseNoteworthy =
      diagnosticErrors > 0 ||
      indexed.diagnosticsOverflow > 0 ||
      indexed.scanStatusOverflow > 0 ||
      indexed.stoppedEarly ||
      // RUN-279: a duplicate node URI means two entities collided on one identity — a bug, unlike
      // `duplicateEdgesDropped`, which is an ordinary fact about any repo with repeated call sites
      // and deliberately does NOT promote this line.
      indexed.duplicateNodeUris.length > 0;
    log[parseNoteworthy ? 'warn' : 'info']('index parse complete', {
      repositoryKey: target.repositoryKey,
      files: indexed.manifest.fileCount,
      deletions: indexed.manifest.deletions.length,
      diagnostics: indexed.diagnostics.length,
      diagnosticErrors,
      diagnosticsOverflow: indexed.diagnosticsOverflow,
      skipped: indexed.scanStatuses.length,
      skippedOverflow: indexed.scanStatusOverflow,
      skippedByReason,
      stoppedEarly: indexed.stoppedEarly,
      inferredEdgesOmitted: indexed.inferredEdgesOmitted,
      unlabelledSymbolsDropped: indexed.unlabelledSymbolsDropped,
      // RUN-280: routine, not a defect — most UBT dependencies are engine modules this generation
      // never scanned, so this does not promote the line to `warn` (see the field's own doc).
      declinedModuleDependencies: indexed.declinedModuleDependencies,
      // RUN-279: a count, never the URIs — `duplicateEdgesDropped` is routinely in the thousands on a
      // real repo (N call sites, one edge) and carries no path. `duplicateNodeUris` DOES carry paths,
      // so only its length is logged here; a non-zero length is the signal, and `index-repo` is where
      // an operator reads which. It also promotes this line to `warn`, because unlike every other
      // counter here a duplicate node URI is a bug rather than a routine fact about the repository.
      duplicateEdgesDropped: indexed.duplicateEdgesDropped,
      duplicateNodeUris: indexed.duplicateNodeUris.length,
      parserVersions: indexed.parserVersions,
    });

    // RUN-223: batching/staging/network calls all live inside `uploadGeneration` below, so
    // "uploading" starts here, before that call — the only phase this module can time from the
    // outside (the finer `server-validating` moment lives INSIDE `uploadGeneration`, at its own
    // `complete()` call, which is why that function takes its own `onServerValidating` hook rather
    // than this module trying to time it from out here).
    ctx.onProgress?.('uploading', `${indexed.batches.length} batch(es)`);
    const vcs = deps.vcsFor(target.repoRoot);
    const outcome = await uploadGeneration(
      {
        key,
        mint: { projectId: target.projectId, repositoryKey: target.repositoryKey, runnerId: deps.runnerId },
        manifest: indexed.manifest,
        batches: indexed.batches,
      },
      {
        client: deps.client,
        journal,
        staging,
        // Locked decision 7, restated at its one call site: this is a closure over
        // `releaseIndexSnapshot`, bound to the snapshot THIS job leased, never a bare method
        // reference — `uploadGeneration` calls it with no arguments.
        release: () => vcs.releaseIndexSnapshot(snapshot),
        onServerValidating: () => ctx.onProgress?.('server-validating'),
        signal,
        logger: log,
        maxStagedBytes: deps.maxStagedBytes,
        fetchImpl: deps.fetchImpl,
      },
    );

    if (!outcome.ok) {
      // RUN-234: this Error's own `.message` is the SECOND place `completed.validation.problems`
      // could reach a log line — `index-coordinator.ts`'s catch-all logs `err: String(err)` and
      // persists `err.message` into `IndexStatusRecord.lastError` — so it gets the same bound
      // `index-upload.ts`'s own warn line does, never the raw `.join('; ')` a monorepo's worth of
      // per-entity problems would turn into an unbounded string here (locked decision 2, one hop
      // downstream of where the array itself is thrown away).
      const detail =
        outcome.reason === 'validation'
          ? (() => {
              const { count, sample } = boundedValidationProblems(outcome.problems);
              return `${count} problem(s): ${sample.join('; ')}${count > sample.length ? ', …' : ''}`;
            })()
          : outcome.reason === 'cancelled'
            ? 'cancelled'
            : outcome.detail;
      throw new Error(`index upload did not complete (${outcome.reason}): ${detail}`);
    }

    return {
      generationId: key.generationId,
      baseId: key.baseId,
      batchesReceived: outcome.batchesReceived,
      ...(outcome.activated ? { activated: outcome.activated } : {}),
    };
  };
}
