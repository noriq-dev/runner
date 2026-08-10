import type { RunnerCheckoutAssociationState, RunnerIndexCursor } from './memory-contract';
import type { ChangesBetweenResult } from './vcs/types';

/**
 * Index cursor reconciliation (RUN-213): decide what a repository's background indexer should do
 * next, against the server's own view of what it has already indexed. PLNR-306 finally gave this
 * daemon a reachable route (`POST /api/runner-memory/index-cursor`, `client.ts`'s
 * `getIndexCursor`) — every earlier attempt at this task was blocked because the human-facing
 * read lives under `/api/projects/:pid/*`, which runs `userAuth` before any route-level auth and
 * a Bearer-only daemon can never pass.
 *
 * **`reconcile` is the pure decision only** (locked decision 4): `(cursor, currentBaseId,
 * indexerVersion, changesBetween) -> outcome`, no spawning, locking, writing, or mutation of any
 * kind. Fetching the cursor is `client.ts`'s job; relating two bases is `VcsBackend.changesBetween`
 * (RUN-212) — already measured against real backend uncertainty (unrelated histories, an
 * unresolvable base, a query that errors, a rename, an over-cap change set) and this file must not
 * re-derive any of that, only consume its `ChangesBetweenResult` outcome. Starting/coordinating an
 * actual index job is RUN-214's; this module hands it a verdict, nothing else.
 *
 * **No local job state at all** — deliberately, not by omission. Decision 11 requires local job
 * state to be DISPOSABLE, keyed by (server, repositoryKey, baseId, indexerVersion), with a key
 * mismatch always a MISS and never a partial reuse — `repo-intel.ts`'s contract verbatim. The
 * simplest way to satisfy that contract is to hold nothing this module could serve stale: every
 * call fetches the cursor fresh (never cached across triggers) and `reconcile` closes over nothing
 * between calls, so "idempotent across daemon restart" and "reconciling twice gives the same
 * outcome" are true of the function's shape, not of bookkeeping this file has to get right. A
 * future job coordinator (RUN-214) that persists upload progress must key it the same way and
 * treat a mismatch the same way — this file's job is to not tempt it toward a shortcut.
 */

/**
 * The indexer's own output-format version — bump this the moment Phase 3 changes how a file's
 * content becomes index facts (parser swap, symbol-extraction change, batch encoding): an
 * OLDER active generation is then unconditionally superseded (decision 7's `full`), because a
 * parser change means this daemon's output for UNCHANGED files also changed, and an incremental
 * pass would leave a tree half-described by two parsers with nothing recording it. Kept as a
 * small integer string (compared numerically below) rather than semver — there is exactly one
 * axis that matters here (can this daemon's parsers reproduce what is already indexed?), and an
 * integer makes "did this move at all" a one-line diff in the PR that bumps it.
 *
 * RUN-239 bumped this to `'2'`: a C++ adapter, an ini adapter, and the JSON adapter's widened
 * `canParse` (`.uproject`/`.uplugin`) all change this daemon's output for files that were
 * previously untouched or NOOP-only — exactly the "output for unchanged files also changed" case
 * this comment already names as mandatory, not optional. What this buys, precisely, and what it
 * does NOT: every repo's next reconcile is `full` regardless of whether it has a single C++ file —
 * `deriveGenerationId` (this module's own doc) is keyed on `indexerVersion`, not on which
 * languages a repo actually contains, so there is no cheaper, PER-LANGUAGE reindex this daemon can
 * offer today. `IndexGenerationManifest` (`vendor/noriq-shared/src/memory.ts`) carries only this
 * one whole-daemon `indexerVersion` field — no per-parser version reaches the wire — and the
 * vendored contract must land planar-side FIRST (`VENDORED-CONTRACT.md`); a targeted reindex needs
 * a schema change this task does not make. `parserVersions` (`indexer.ts`'s own `IndexerResult`)
 * IS recorded per adapter, but locally only, and nothing branches on it — see
 * `INDEX-OPERATIONS.md`'s "Adapter roadmap" section for this stated as a blocked acceptance line
 * rather than quietly declared met.
 */
export const INDEXER_VERSION = '2';

/**
 * ~~A validated staged generation at the base/version this reconciliation is about~~ — REMOVED
 * (RUN-275). It was computed on every `incremental`/`full` outcome, threaded onward, and read by
 * nothing, in the belief that RUN-214 would resume onto it. Two things settled it instead of a
 * consumer:
 *
 *   - resume already works, by a different route. `uploadGeneration` asks the server's own
 *     `status()` and picks up from what it already holds (RUN-221), which is what made the first
 *     live 409 resume the same generation rather than duplicate it.
 *   - the candidate could not soundly justify SKIPPING work either, which is the only other thing
 *     it was good for. It matched on base and indexer version — and `deriveGenerationId` is built
 *     from (project, repository, branch, base, indexerVersion) with the MANIFEST deliberately
 *     outside it, so the same id can hold content built under different include/exclude globs.
 *     RUN-262 made that concrete by adding default excludes: every repo's content changed with no
 *     base change. Skipping on a base+version match would then leave the old content staged and
 *     never build the new.
 *
 * Deleted rather than given a reader, because a consumer added to justify a producer would have
 * left two resume paths that can disagree about the same generation.
 */

/**
 * The six outcomes (locked decision 5), each carrying exactly what the next stage needs. A
 * discriminated union on `outcome`, not a bag of optionals — a caller narrows once and every
 * field it reads afterward is guaranteed present for that branch.
 */
export type IndexReconcileOutcome =
  | { outcome: 'unchanged' }
  | {
      outcome: 'incremental';
      /** The server's active generation's own base — where to diff FROM. */
      fromBase: string;
      /** This checkout's current base — where to diff TO. */
      toBase: string;
    }
  | {
      outcome: 'full';
      /** Why a full pass was chosen — an older indexer version, no active generation at all, an
       *  unrelated/unresolvable base, or a `changesBetween` the caller never supplied. Free text
       *  for the operator log, never branched on. */
      reason: string;
    }
  | {
      outcome: 'incompatible-version';
      /** The server's active generation was built by parsers newer than this daemon's — schedule
       *  nothing, or a stale daemon would silently DOWNGRADE the project's index (decision 7). */
      activeIndexerVersion: string;
      ourIndexerVersion: string;
    }
  | {
      outcome: 'association-conflict';
      /** The DIFFERENT canonical repository this checkout is actually bound to — never this
       *  reconciliation's own repositoryKey, which is the one it was refused. */
      projectRepositoryId: string;
      reason: string;
    }
  | {
      outcome: 'unavailable';
      /** Never blank — always says why nothing could be decided (fetch failed, unresolved
       *  project, unparseable body). Schedules nothing (decision 6): a blip must cost a retry,
       *  never a full reindex of a monorepo. */
      reason: string;
    };

export interface ReconcileInput {
  /**
   * The fetched cursor, or `null` for EVERY failure mode `client.ts`'s `getIndexCursor` can
   * produce — a network error, a non-2xx, an unparseable/unvalidatable body, AND an unresolved
   * project on this server (discretion: there is no cursor to hold an opinion about association
   * without a project to ask it of — that is a precondition failure, not a verdict, and reads as
   * `unavailable` rather than `association-conflict`, which requires the server to have actually
   * compared this checkout against a resolved canonical repository).
   */
  cursor: RunnerIndexCursor | null;
  /** This checkout's current base, in the repo's own VCS backend id-space — opaque, `===`-only,
   *  `Workspace.baseId`'s exact contract. */
  currentBaseId: string;
  /** This daemon's `INDEXER_VERSION`, threaded as a parameter (not read from the constant above)
   *  so tests can vary skew in both directions without faking the module's own export. */
  indexerVersion: string;
  /**
   * The outcome of `VcsBackend.changesBetween(activeGeneration.baseId, currentBaseId)` — supplied
   * by the caller, who alone may perform I/O (decision 4). `undefined` when the caller has not
   * computed one (e.g. it short-circuited because the base has not moved) — treated exactly like
   * `{ok:false}`: a moved base with no usable diff answer is the same "could not tell" RUN-212
   * already routes to a full pass, and this file does not re-derive that judgement, only defers
   * to it.
   */
  changesBetween?: ChangesBetweenResult;
}

/** `INDEXER_VERSION`'s ordering: a small integer. `null` when a version string does not parse as
 *  one — a server or daemon on some future scheme this comparison cannot read. */
function parseVersionOrdinal(v: string): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * `true` when `active` is strictly newer than `ours` — and, crucially, whenever the ordering
 * cannot be established at all. Decision 7 makes the two skew directions asymmetric in their
 * SAFETY, not just their outcome: treating an active generation as "newer" schedules nothing,
 * while treating it as "older" triggers a destructive full reindex. An ordinal this function
 * cannot parse is exactly the case it cannot tell `full` from `incompatible-version` for — and
 * guessing `older` on a comparison it could not make is the one guess that overwrites real data.
 * So "cannot tell" fails toward the side that touches nothing.
 */
function isNewerOrUnknown(active: string, ours: string): boolean {
  const a = parseVersionOrdinal(active);
  const o = parseVersionOrdinal(ours);
  if (a === null || o === null) return true;
  return a > o;
}

/**
 * The pure reconciliation decision (locked decision 4). See the module doc for the no-I/O and
 * no-local-state contracts; see `IndexReconcileOutcome` for what each branch carries.
 */
export function reconcile(input: ReconcileInput): IndexReconcileOutcome {
  const { cursor, currentBaseId, indexerVersion, changesBetween } = input;

  // Decision 6: a cursor this daemon could not obtain — for any reason — schedules nothing.
  if (!cursor) {
    return {
      outcome: 'unavailable',
      reason:
        'index cursor unavailable — the fetch failed, returned an unparseable body, or this ' +
        'checkout has no resolved project on this server yet',
    };
  }

  // Decision 8: a conflicting association blocks INDEXING ONLY, checked before anything else —
  // whatever this checkout's baseId or indexer version look like, uploading under this
  // repositoryKey would attribute one repository's evidence to another.
  if (cursor.association.state === 'conflict') {
    return {
      outcome: 'association-conflict',
      projectRepositoryId: cursor.association.projectRepositoryId,
      reason: cursor.association.reason,
    };
  }
  // `not-associated` (decision 8) and `associated` both fall through to the ordinary decision
  // below — an association that has simply not been created yet (a registration race, or a key
  // new to this server) must not silently stop indexing the way a real conflict does.

  const active = cursor.activeGeneration;

  if (!active) {
    return {
      outcome: 'full',
      reason: 'no active generation on the server for this repository',
    };
  }

  if (active.indexerVersion !== indexerVersion) {
    if (isNewerOrUnknown(active.indexerVersion, indexerVersion)) {
      return {
        outcome: 'incompatible-version',
        activeIndexerVersion: active.indexerVersion,
        ourIndexerVersion: indexerVersion,
      };
    }
    return {
      outcome: 'full',
      reason:
        `active generation was built by indexer version ${active.indexerVersion}, older than this ` +
        `daemon's ${indexerVersion} — a parser change also changes output for unchanged files`,
    };
  }

  // Decision 9: all three — same base, same version (checked above), and the server's OWN
  // `stale` bit, computed from `latestObservedBase`, which may know about movement this
  // checkout has not observed itself.
  if (active.baseId === currentBaseId && !cursor.stale) {
    return { outcome: 'unchanged' };
  }

  // The base moved (or the server considers it stale regardless) — decision 10: incremental ONLY
  // on a confident `changesBetween`; every `full-index-required`, and every case the caller never
  // asked, becomes `full`.
  if (changesBetween?.ok) {
    return { outcome: 'incremental', fromBase: active.baseId, toBase: currentBaseId };
  }
  return {
    outcome: 'full',
    reason: !changesBetween ? 'base moved and no changesBetween result was supplied' : changesBetween.detail,
  };
}

/**
 * The operator-log line for this checkout's ASSOCIATION state, independent of `reconcile`'s own
 * outcome — kept as a separate pure function rather than folded into `IndexReconcileOutcome` so
 * `reconcile`'s return type stays exactly the six outcomes decision 5 names, none of them wrapped.
 * `conflict` also appears inside the outcome itself (`association-conflict`'s own `reason`); this
 * exists so a caller can log at the right level without re-deriving the reason text, and so
 * `not-associated` — which never changes the outcome — is still visible to the operator.
 *
 * `null` for `associated`: the ordinary, uninteresting state, worth no log line at all.
 */
export function associationNotice(
  association: RunnerCheckoutAssociationState,
): { level: 'error' | 'warn'; message: string } | null {
  switch (association.state) {
    case 'conflict':
      return {
        level: 'error',
        message: `repository association conflict: this checkout is already bound to a different canonical repository (${association.projectRepositoryId}) — ${association.reason}. Indexing is blocked for this repository; ordinary runs are unaffected.`,
      };
    case 'not-associated':
      return {
        level: 'warn',
        message:
          'this checkout is not yet associated with a canonical repository on this server — ' +
          'proceeding; the association may simply lag registration.',
      };
    case 'associated':
      return null;
  }
}
