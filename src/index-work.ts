import type { NoriqClient } from './client';
import type { IndexWorkContext, IndexWorkStep } from './index-coordinator';
import { buildIndexAdapterRegistry } from './index-registry';
import { type StagingStore, fileStagingStore } from './index-stage';
import { uploadGeneration } from './index-upload';
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
 * **Reads `snapshot.source`, never `snapshot.localPath`** (locked decision 6): `localPath` is
 * optional diagnostics — only git materializes a tree, and a step reaching for a filesystem path
 * would work on git and silently index nothing on Perforce or Diversion, whose snapshots never set
 * it. `runIndexer` already takes an `IndexSource`, so this is simply never reaching for the other
 * field.
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

  return async (ctx: IndexWorkContext): Promise<void> => {
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

    const { registry } = buildIndexAdapterRegistry(config);
    const indexed = await runIndexer(
      snapshot.source,
      config,
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
      { now: deps.now, adapters: registry },
    );

    const key = {
      server: target.server,
      repositoryKey: target.repositoryKey,
      baseId: snapshot.baseId,
      indexerVersion: indexed.manifest.indexerVersion,
      generationId: indexed.manifest.generationId,
    };

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
        signal,
        logger: log,
        maxStagedBytes: deps.maxStagedBytes,
        fetchImpl: deps.fetchImpl,
      },
    );

    if (!outcome.ok) {
      const detail =
        outcome.reason === 'validation'
          ? outcome.problems.join('; ')
          : outcome.reason === 'cancelled'
            ? 'cancelled'
            : outcome.detail;
      throw new Error(`index upload did not complete (${outcome.reason}): ${detail}`);
    }
  };
}
