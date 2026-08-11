/**
 * The SINGLE mapper from a `VcsBackend.changeStats` raw result (`vcs/types.ts`) to the vendored
 * `BackendChangeStats` envelope (RUN-244) — the only place in this codebase that writes
 * `provenance`/`source` for a change-stat metric. This is RUN-243's defect made structurally
 * impossible: that bug was one wrong provenance value, legal in `MetricProvenance` but absent from
 * the server's `DAEMON_PROVENANCE`, which passed typecheck, lint and 3068 tests and would have
 * discarded whole episode rows behind an HTTP 200. That allowlist was a hand-copied Set here when
 * this module was written; since RUN-284 it is VENDORED and imported, and
 * `test/daemon-provenance.test.ts` checks against the real thing — the copy had already drifted by
 * one value before it was replaced. Three backends each hand-building four envelopes is three places
 * to reintroduce it; one mapper is one place. Backends return RAW COUNTS through
 * `VcsBackend.changeStats` and never construct a `BackendChangeStats` themselves.
 *
 * Synchronous and digest-free by construction (RUN-246's measured lesson, restated in
 * `stage-timing.ts`'s own doc): this is pure arithmetic over numbers already in hand, so there is
 * no `await` here for a fake-timer test to stall on.
 */

import type { BackendChangeStats, IntelligenceIntegerMetric } from '@noriq-dev/shared';
import type { ChangeStatsResult } from './vcs/types';

const nowIso = (): string => new Date().toISOString();

/** `provenance` names the CHANNEL that observed a metric, never what it found — `stage-facts.ts`'s
 *  `metric()` restates the same rule for its own caller, and this restates it again independently
 *  rather than sharing the helper, so the two modules cannot drift into disagreeing about it. Every
 *  metric this file emits carries `source: 'vcs_backend'`, whether or not the backend answered. */
function observed(
  status: 'complete' | 'partial',
  value: number,
  provenance: 'backend_observed' | 'derived',
  reason: string | null,
): IntelligenceIntegerMetric {
  return {
    status,
    value,
    provenance,
    source: 'vcs_backend',
    sourceId: null,
    observedAt: nowIso(),
    // Never stamped here: `acceptedAt` means the SERVER accepted the observation (PLNR-417's
    // `acceptMetric`), which this process cannot know — `stage-timing.ts`/`stage-facts.ts`'s own rule.
    acceptedAt: null,
    reason,
  };
}

/**
 * The vendored envelope's own numeric domain (`IntelligenceIntegerMetric` is
 * `z.number().int().nonnegative()`), enforced HERE rather than trusted from a backend — measured,
 * not assumed: `NaN`, `1.5` and `-3` all satisfy `ChangeStats`'s plain `number` fields and all fail
 * `BackendChangeStats.safeParse`, and a failed refine at the ingest discards the WHOLE episode row
 * behind an HTTP 200 (`test/daemon-provenance.test.ts`'s doc carries that mechanism). That is
 * RUN-243's defect one grain down — a value TypeScript accepts and the wire rejects — and the live
 * path is not hypothetical: `git diff --numstat` prints `-` for a binary file's counts and
 * `Number('-')` is `NaN`, so RUN-245's own parser is one missing branch away from silently costing
 * every episode it touches.
 *
 * A value outside the domain degrades its metric to `unavailable`, never to a repaired number:
 * may-miss-never-invent, the order of harms this codebase already prices everywhere else. A missing
 * stat is a visible gap with a reason attached; a clamped one is a fabricated measurement, and
 * shipping the raw value is the whole-episode loss.
 */
const uploadable = (v: number): boolean => Number.isSafeInteger(v) && v >= 0;

const outOfDomain = (field: string, v: number): string =>
  `the backend reported a ${field} of ${v}, which is not a non-negative integer the metric envelope can carry`;

function unavailable(provenance: 'backend_observed' | 'derived', reason: string): IntelligenceIntegerMetric {
  return {
    status: 'unavailable',
    value: null,
    provenance,
    source: 'vcs_backend',
    sourceId: null,
    observedAt: null,
    acceptedAt: null,
    reason,
  };
}

/** `unavailable`'s exact shape, `not_applicable` instead — the third status this file's metrics can
 *  carry, and the ONLY one of the three that is true of a non-producing workflow's diff. */
function notApplicable(
  provenance: 'backend_observed' | 'derived',
  reason: string,
): IntelligenceIntegerMetric {
  return {
    status: 'not_applicable',
    value: null,
    provenance,
    source: 'vcs_backend',
    sourceId: null,
    observedAt: null,
    acceptedAt: null,
    reason,
  };
}

/**
 * The not-applicable arm (RUN-245): a non-producing workflow (`Workflow.produces` false — scope and
 * verify both) cannot have changed anything BY CONSTRUCTION, since `clampPermissionToWorkflow`
 * forces its worktree read-only. `settle` calls this DIRECTLY, never asking the backend at all
 * (RUN-244's own deferred note: "the CALLER at settle, with knowledge of the workflow, not the
 * backend") — a measured zero would assert something was measured, and an omission would read as
 * "we did not look"; `not_applicable` is the only one of the three that is honest here.
 *
 * `backend` is informational only (never a metric, never provenance-checked) — `settle` passes the
 * workspace's own `vcs.kind` so a human reading the episode later still knows which backend this
 * WOULD have measured, even though nothing asked it to.
 */
export function notApplicableChangeStats(backend: string | null, reason: string): BackendChangeStats {
  return {
    backend,
    changedFiles: notApplicable('backend_observed', reason),
    additions: notApplicable('backend_observed', reason),
    deletions: notApplicable('backend_observed', reason),
    churn: notApplicable('derived', reason),
  };
}

/**
 * Map one backend's `ChangeStatsResult` to the vendored `BackendChangeStats`. `backend` is the
 * `VcsBackend.kind` the caller already holds — `ChangeStats` itself carries no backend name (locked
 * decision, RUN-244: a VCS backend's own raw counts have no business knowing the analytics shape),
 * so it rides in as a parameter instead of a field.
 *
 * `churn` is DERIVED here as `additions + deletions` from the SAME two numbers this function also
 * reports, never asserted independently by a backend — `foldSnapshot`/`finalizeMix`'s exact
 * discipline (`src/supervisor.ts`, RUN-243) restated for a new pair of numbers: two components and
 * their sum coming out of one addition can never disagree with each other. Its `provenance` is
 * always `'derived'`, never `'backend_observed'`, whether or not the number is available — nothing
 * ever OBSERVES churn, only computes it, so the channel label does not change with the outcome.
 *
 * A count outside the metric envelope's own numeric domain degrades that metric to `unavailable`
 * rather than being shipped or repaired — see `uploadable` above for the measurement behind that.
 *
 * Three distinct raw shapes collapse to the SAME four-metric `unavailable` output, deliberately:
 * a whole-result refusal, a result with `stats.lines === null`, and a result where every counted
 * file is also uncountable (`uncountableFiles >= changedFiles`) all mean "no line signal exists" —
 * a backend could spell that last one either way (`lines: null`, or `lines` present with nothing
 * countable in it) and get an identical answer here, so the encoding at the seam is redundant but
 * never ambiguous.
 */
export function backendChangeStats(backend: string, result: ChangeStatsResult): BackendChangeStats {
  if (!result.ok) {
    return {
      backend,
      changedFiles: unavailable('backend_observed', result.detail),
      additions: unavailable('backend_observed', result.detail),
      deletions: unavailable('backend_observed', result.detail),
      churn: unavailable('derived', result.detail),
    };
  }

  const { stats } = result;
  // A zero the backend actually counted is a real, distinct answer — `status: 'complete'`, never
  // folded into the same shape a refusal produces (locked decision, RUN-244: "a zero never means
  // unknown").
  const changedFiles = uploadable(stats.changedFiles)
    ? observed('complete', stats.changedFiles, 'backend_observed', null)
    : unavailable('backend_observed', outOfDomain('changed-file count', stats.changedFiles));

  // A line block whose own `uncountableFiles` is out of domain is unusable WHOLE, not per-field:
  // that number is what says how much of the measurement to trust, so without it `additions` cannot
  // be called complete or partial — the two available statuses are exactly the claim it underwrites.
  if (stats.lines != null && !uploadable(stats.lines.uncountableFiles)) {
    const reason = outOfDomain('uncountable-file count', stats.lines.uncountableFiles);
    return {
      backend,
      changedFiles,
      additions: unavailable('backend_observed', reason),
      deletions: unavailable('backend_observed', reason),
      churn: unavailable('derived', reason),
    };
  }

  if (stats.lines == null) {
    const reason = 'backend counted changed files but has no primitive for line-level changes';
    return {
      backend,
      changedFiles,
      additions: unavailable('backend_observed', reason),
      deletions: unavailable('backend_observed', reason),
      churn: unavailable('derived', reason),
    };
  }

  const { additions, deletions, uncountableFiles } = stats.lines;
  if (stats.changedFiles > 0 && uncountableFiles >= stats.changedFiles) {
    // Every counted file was also uncountable for lines — the other spelling of "no primitive",
    // see this function's own doc. Collapsing here is what keeps the two spellings from disagreeing.
    const reason = `all ${stats.changedFiles} changed file(s) were uncountable for line changes`;
    return {
      backend,
      changedFiles,
      additions: unavailable('backend_observed', reason),
      deletions: unavailable('backend_observed', reason),
      churn: unavailable('derived', reason),
    };
  }

  const partial = uncountableFiles > 0;
  // additions/deletions share ONE status: they are counted (or not) together, from the same per-file
  // pass. Only the domain guard can separate them, which is why churn's "never stronger than the
  // weaker of the two" is a rule this function performs below rather than one it gets for free.
  const status = partial ? 'partial' : 'complete';
  const reason = partial
    ? `${uncountableFiles} of ${stats.changedFiles} changed file(s) could not be measured for line changes`
    : null;

  const additionsMetric = uploadable(additions)
    ? observed(status, additions, 'backend_observed', reason)
    : unavailable('backend_observed', outOfDomain('addition count', additions));
  const deletionsMetric = uploadable(deletions)
    ? observed(status, deletions, 'backend_observed', reason)
    : unavailable('backend_observed', outOfDomain('deletion count', deletions));

  return {
    backend,
    changedFiles,
    additions: additionsMetric,
    deletions: deletionsMetric,
    // Churn is a sum, so it is available only when BOTH components are — a sum over one known and
    // one unknown addend is not a partial measurement of churn, it is a different quantity wearing
    // churn's name. This is the one place the "never stronger than the weaker" rule has real work to
    // do, since the domain guard is what lets the two components' strengths diverge at all.
    churn:
      additionsMetric.status === 'unavailable' || deletionsMetric.status === 'unavailable'
        ? unavailable('derived', 'churn needs both an addition and a deletion count; one was not uploadable')
        : observed(status, additions + deletions, 'derived', reason),
  };
}
