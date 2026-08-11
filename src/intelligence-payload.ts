/**
 * Assembles the narrow, daemon-assertable Project Intelligence payload (RUN-284, PLNR-426) —
 * `UploadedEpisodeIntelligence`, vendored at `vendor/noriq-shared/src/intelligence.ts` — from facts
 * the run already holds by the time `settle` reaches it. One place, for RUN-244's own reason: every
 * caller that wants to know what this daemon may assert about a sitting's execution reads it here,
 * rather than each re-deriving its own subset of `RunTally`/`stage-timing.ts`.
 *
 * Deliberately narrow, matching `UploadedEpisodeIntelligence`'s own scope note (RUN-284's own
 * deferred list, restated so a future reader does not have to cross-reference the task):
 *
 *   - `execution.stages` — `RunTally.stageFacts().stages`, forwarded UNCHANGED (locked decision: no
 *     re-derivation, re-summing, or filtering — `stageFacts()` already shares its one addition with
 *     `total()`, and a second pass here would reintroduce the divergence that split exists to
 *     prevent).
 *   - `execution.clocks.verifyDurationMs` — folded from every verify-duration envelope `RunTally`
 *     accumulated (RUN-242's per-attempt observations, now actually kept — see
 *     `RunTally.recordVerifyDuration`), per this task's own locked decision on what the fold means.
 *   - `execution.observedModelUsage` (RUN-248) — `RunTally.total()`'s own model mix, ALWAYS present
 *     once a `runTotal` is supplied (never conditionally omitted the way `stages`/`clocks` are):
 *     the run's spend is either known or it is not, and "not" is itself an answer this module can
 *     give (`unavailable`, never `{}` — see `buildObservedModelUsage`'s own doc). RUN-284 deferred
 *     this field as "nothing in this daemon assembles it yet", which was true then and stopped being
 *     true the moment RUN-59 gave `RunTally.total()` a model mix to read; the third acceptance
 *     criterion this task closes — "stage metrics can be partial while run totals remain
 *     AUTHORITATIVE" — was unsatisfiable without it, because a consumer had only `stages` (whose
 *     per-metric statuses can be `unavailable`) and nothing to compare a summed breakdown against.
 *     `provenance: 'driver_reported'`, not `'derived'`: a run with sessions on different drivers (a
 *     stage coordinate can name a different tool per stage) folds their reports into one mix, but the
 *     fold ADDS what each driver already reported — it invents no quantity the way RUN-244's churn
 *     does (additions + deletions, a number nothing ever observed). Aggregation is not derivation;
 *     the field is named `observed`ModelUsage for exactly that reason.
 *
 * NOT assembled here, on purpose, because it has its own reason to wait: `preExecution.configuration`
 * already ships over the `RunReport` telemetry frame (RUN-241) and sending it again here would be a
 * second assertion of one fact.
 *
 * `contextConsumption` (RUN-247) rides as a TOP-LEVEL sibling of `execution`, never nested under it
 * — PLNR-433's own locked placement (`vendor/noriq-shared/src/intelligence.ts`): a disjoint key
 * makes "reporting context facts leaves `execution.stages`/`clocks`/`changes` untouched" true by
 * construction, rather than something this function has to work to preserve. Carried straight
 * through from `input.contextConsumption` — `context-consumption.ts` owns the status ladder and the
 * mapping; this module only decides WHERE it goes in the assembled payload.
 *
 * **The cross-sitting stage-fidelity limit** (RUN-248, measured during RUN-284/245): the server
 * replaces `execution.stages` wholesale rather than merging element-wise, and a continued run seeds
 * its prior spend as one collapsed `__prior__` slot (`supervisor.ts`'s `parkIfBlocked` /
 * `stages/prepare.ts`, both `tally.seed('__prior__', telemetryFromSpent(...))`). A second sitting's
 * upload therefore preserves the run's TOTAL spend (it rides on `observedModelUsage`, which sums
 * every slot including `__prior__`) but loses the first sitting's per-stage breakdown — `__prior__`
 * shows up in `execution.stages` as one row indistinguishable from a single stage's worth of work,
 * not as whatever mix of `primary`/`review:N`/etc. it actually was. This is not fixable here: the
 * daemon genuinely does not retain that breakdown across a park (RUN-59's tally design, one level
 * up), so a reader of either field should expect `__prior__` to mean "everything before this sitting,
 * collapsed" rather than a stage in its own right.
 *
 * `execution.changes` (RUN-245) IS assembled here, from `input.changes` — mapped through
 * `change-stats.ts`'s one provenance-owning mapper (`backendChangeStats` for a real measurement or a
 * refusal, `notApplicableChangeStats` for a non-producing workflow `settle` never even asked), never
 * re-derived in this file. Optional on the input, not on principle but on precedent: every field this
 * module assembles is omitted when the caller has nothing to report, and `settle` is the only caller
 * that exists — it always supplies one of the two arms.
 *
 * **Per-metric validation lives here; whole-payload validation still does not** (RUN-287). This block
 * used to say "validation is NOT this module's job" full stop, and pointed at
 * `episode-upload.ts`'s `toEnrichmentPayload` as the one place anything is checked. That division was
 * wrong in a way RUN-286 measured on a live run: `toEnrichmentPayload`'s check is whole-payload and
 * all-or-nothing, so ONE out-of-domain number failed the parse and dropped the ENTIRE `intelligence`
 * field — stages, verify clocks, change stats and context consumption together. Every episode this
 * daemon shipped between RUN-247 and RUN-286 carried zero analytics because of one fractional
 * millisecond.
 *
 * The line that actually holds is between ASSERTING and SENDING. A metric this module can see will
 * not survive the wire contract is not a metric this daemon can assert, so declining to assert it —
 * degrading it to `unavailable`, or omitting it — is an assembly decision and belongs here. Whether
 * the assembled payload may LEAVE THE BOX is still `toEnrichmentPayload`'s call, and its
 * all-or-nothing `safeParse` stays exactly as it is: the outer floor that catches anything this
 * module's per-field probes did not, on every send including every retry.
 *
 * The two guards compose in the direction that matters. With per-field degradation in front of it,
 * the outer parse should never fail; if it ever does, the episode still ships (RUN-251) and the log
 * names the path (RUN-284) — the same evidence trail that made RUN-286 diagnosable in one reading.
 */

import { UploadedEpisodeIntelligence } from '@noriq-dev/shared';
import type {
  EpisodeStageFact,
  IntelligenceContextConsumptionMetric,
  IntelligenceDurationMs,
  UploadedEpisodeIntelligence as UploadedEpisodeIntelligenceType,
} from '@noriq-dev/shared';
import { backendChangeStats, notApplicableChangeStats } from './change-stats';
import type { DriverTelemetry } from './drivers/types';
import { logger as defaultLogger } from './logger';
import { type DurationSource, completeDuration, partialDuration, unavailableDuration } from './stage-timing';
import type { ChangeStatsResult } from './vcs/types';

export interface BuildUploadedIntelligenceInput {
  /** `RunTally.stageFacts().stages` for this run — carried straight through, never re-derived. */
  stages: EpisodeStageFact[];
  /**
   * `RunTally.total()`'s snapshot for this run (RUN-248) — or, equivalently and preferably,
   * `RunTally.stageFacts().total`, since the two are the SAME addition (the class doc's own
   * "structural, not asserted to agree" claim) and a caller that already destructured `stageFacts()`
   * for `stages` should read `total` off the same call rather than asking the tally twice. Every run
   * has a tally by construction, so this is required rather than optional like `changes` below — the
   * caller always has an answer, even when that answer is "no mix" (`modelUsage` absent).
   */
  runTotal: DriverTelemetry;
  /** `RunTally.verifyDurations()` for this run — every verify-duration envelope actually observed,
   *  in observation order (one per `timedVerify` call this sitting made, or the single
   *  `not_applicable` envelope when the repo configured no `[verify].cmd`). */
  verifyDurations: readonly IntelligenceDurationMs[];
  /**
   * This sitting's change-stat measurement (RUN-245) — `settle`'s own choice of which of the two
   * arms applies, made BEFORE this function ever runs (this module owns provenance mapping, not the
   * workflow judgement that picks the arm):
   *
   *   - `measured`: a producing workflow asked its backend — `result` is the raw `ChangeStatsResult`
   *     (an `ok:true` measurement or an `ok:false` refusal, both legal, both mapped through
   *     `backendChangeStats`) and `backend` is the `VcsBackend.kind` that answered.
   *   - `not_applicable`: a non-producing workflow (scope/verify) never asked at all — it changed
   *     nothing BY CONSTRUCTION, and `reason` names the workflow for the episode.
   *
   * Optional, matching every other field here: absent means the caller has nothing to report, and
   * `execution.changes` is omitted entirely rather than sent as an empty or fabricated shape.
   */
  changes?:
    | { kind: 'measured'; backend: string; result: ChangeStatsResult }
    | { kind: 'not_applicable'; backend: string | null; reason: string };
  /**
   * RUN-247: `RunPipeline.contextConsumption`, carried straight through — never re-derived here,
   * same discipline `stages` above follows. Optional, matching every other field: absent means the
   * caller has nothing to report (no retrieval this sitting), and `contextConsumption` is omitted
   * from the payload entirely rather than sent as a fabricated `not_applicable`.
   */
  contextConsumption?: IntelligenceContextConsumptionMetric;
}

/**
 * Fold every verify-duration observation this sitting made into the ONE `verifyDurationMs` the wire
 * contract carries (RUN-284 locked decision): a SUM across attempts, because its sibling clock
 * fields on `EpisodeClockFacts` are all spans of the run and a retry loop plus a landing gate is
 * still one span of wall clock spent verifying, not a last-writer-wins reading of whichever attempt
 * happened to run last.
 *
 *   - no events at all → `undefined` (this sitting never reached verify — never sent as a duration
 *     of any kind, per the omission rule every metric here follows).
 *   - nothing timed, and at least one `not_applicable` → `not_applicable` (the repo configures no
 *     verify command).
 *   - nothing timed, and no `not_applicable` either → `unavailable`. This arm exists because the
 *     obvious fold is WRONG in a way RUN-244 already paid for: summing zero measured terms yields
 *     `partial` with `value: 0`, which asserts verify took no time as a measurement rather than
 *     admitting nothing was measured — "a zero never means unknown", one metric over. Reachable, not
 *     hypothetical: `verify.ts` emits `unavailableDuration` whenever the boundary between the start
 *     and finish marks is lost, so a single-attempt run that loses it lands exactly here.
 *   - at least one timed → `complete` when every event measured cleanly, else `partial` carrying the
 *     sum of the ones that did, with `reason` naming how many were missing — the envelope's own way
 *     of saying "real, but an undercount" (see `partialDuration`'s doc).
 *
 * `source`/`sourceId` are read off the first observation rather than re-declared: every event this
 * module ever sees was built by `stage-timing.ts`'s own envelope builders against the SAME constant
 * (`verify.ts`'s `VERIFY_DURATION_SOURCE`), so there is nothing to choose between — reusing it avoids
 * a second copy of a value this module has no independent opinion about.
 */
function foldVerifyDurations(events: readonly IntelligenceDurationMs[]): IntelligenceDurationMs | undefined {
  const [first] = events;
  if (!first) return undefined;

  const source: DurationSource = { source: first.source, sourceId: first.sourceId };
  const complete = events.filter(
    (e): e is Extract<IntelligenceDurationMs, { status: 'complete' }> => e.status === 'complete',
  );

  // Nothing measured: report what kind of nothing it was, never a sum over zero terms.
  if (complete.length === 0) {
    const notApplicable = events.find((e) => e.status === 'not_applicable');
    if (notApplicable) return notApplicable;
    return unavailableDuration(source, `${events.length} verify attempt(s) ran but none could be timed`);
  }

  const sum = complete.reduce((total, e) => total + e.value, 0);
  if (complete.length === events.length) return completeDuration(sum, source);

  const missing = events.length - complete.length;
  return partialDuration(sum, source, `${missing} of ${events.length} verify attempt(s) were not timed`);
}

/**
 * The vendored contract exports `IntelligenceModelUsageMetric` only as the zod SCHEMA (a value), not
 * a standalone type alias the way its siblings (`IntelligenceNumberMetric` etc.) are — so this reads
 * the type straight off the field it fills, `UploadedEpisodeIntelligence.execution.observedModelUsage`
 * (already `daemonMetric`-refined), rather than importing `zod` into this module just to `z.infer` a
 * second copy of it.
 */
type ObservedModelUsage = NonNullable<
  NonNullable<UploadedEpisodeIntelligenceType['execution']>['observedModelUsage']
>;

const NO_SPEND_REASON = 'no session in this run recorded any spend — the tally has no model mix to report';

/**
 * `execution.observedModelUsage` (RUN-248): the run's authoritative model mix, read straight off
 * `RunTally.total()`'s (or `stageFacts().total`'s — the same addition) `modelUsage`.
 *
 * What this field is FOR, stated because the obvious answer is wrong and was believed while this was
 * being specified: it is NOT here to correct an understatement by the per-stage breakdown. Measured
 * on a mixed run (a Codex builder reporting tokens and no cost, plus a Claude reviewer reporting
 * both), the summed stage values equal the run total for tokens AND for cost — because a stage's
 * metric is `unavailable` exactly when `hasSpend` is false, which is the same test `foldSnapshot`
 * uses to decide that slot's contribution to the total, so an unmeasured stage contributes zero to
 * both views. The reason this field is worth sending is that it carries what no stage fact does: the
 * PER-MODEL attribution. An `EpisodeStageFact` has tokens and cost but no model split, so without
 * this the wire has no answer to "which model did the run actually spend on" at all.
 *
 * `unavailable`, never `{}` or a zeroed mix, when the tally has none: the vendored doc's own words
 * are "Empty/absent = the run reported no spend at all (or a telemetry-less tick)" — two states it
 * cannot itself tell apart — so asserting either (an empty object IS a positive assertion under the
 * server's `provided ?? existing` merge) would be exactly the zero-means-unknown defect this metric
 * family has already paid for twice (RUN-243's provenance, RUN-284's summed-zero verify duration).
 *
 * Always `status: 'complete'` when a mix exists, NEVER `'partial'` — including when the mix carries
 * only the RUN-86 `(unattributed)` bucket, or the bucket alongside real per-model entries. `'partial'`
 * in this contract means a real but UNDERCOUNTED figure (`stage-timing.ts`'s `partialDuration`: "the
 * sum of the ones that did [measure], … known to be an undercount") — and this mix is never that.
 * `RunModelMix`'s own doc states the invariant this module leans on: "every value's four token
 * classes + cost sum, across all keys, to the run's displayed totals". The unattributed bucket is
 * part of that sum, not a hole in it — what is uncertain is which MODEL a slice of spend belongs to,
 * not whether the total itself is complete. A metric envelope has no field for "the total is right
 * but the split is not", so stretching `partial` to mean that would teach a consumer that `partial`
 * sometimes means undercounted and sometimes means fully-summed-but-coarsely-attributed — worse than
 * picking one reading and documenting it.
 */
export function buildObservedModelUsage(total: DriverTelemetry): ObservedModelUsage {
  if (!total.modelUsage) {
    return {
      status: 'unavailable',
      value: null,
      provenance: 'driver_reported',
      source: 'driver',
      // No slot to name: this is the RUN's total, not any one session's — unlike a stage fact
      // (`stage-facts.ts`'s `metric()`), which always has the slot that produced it.
      sourceId: null,
      observedAt: null,
      acceptedAt: null,
      reason: NO_SPEND_REASON,
    };
  }
  return {
    status: 'complete',
    value: total.modelUsage,
    provenance: 'driver_reported',
    source: 'driver',
    sourceId: null,
    observedAt: new Date().toISOString(),
    acceptedAt: null,
    reason: null,
  };
}

// ---------------------------------------------------------------------------
// RUN-287: per-field validation, so one bad number stops erasing every good one.
// ---------------------------------------------------------------------------

/**
 * Does a payload carrying ONE candidate field survive the vendored contract? Returns null when it
 * does, else `path: message` from zod's first issue.
 *
 * Probing a single-field payload against the EXPORTED top-level schema, rather than plucking the
 * per-field sub-schemas, is deliberate. `UploadedEpisodeStageFact` and `UploadedBackendChangeStats`
 * are module-private in the vendored contract (`const`, not `export const`), so reaching them means
 * either unwrapping `.shape.execution` through its `.optional()` — a shape-walk that breaks silently
 * the next time planar nests a field one level deeper — or asking planar to widen its exports for our
 * convenience. A single-field probe needs neither: it validates against the same symbol
 * `toEnrichmentPayload` validates against, so the two can never disagree about what is sendable, and
 * it keeps working through any restructuring the contract does internally.
 *
 * The fault string carries zod's path and message and NOTHING from the value — the path may name a
 * model id or a metric field, both daemon/driver bookkeeping, and no field in this payload holds
 * pack content, source, or a credential (see `context-consumption.ts`'s counts-enums-booleans-only
 * rule, which is structural on the contract side).
 */
function faultIn(candidate: UploadedEpisodeIntelligenceType): string | null {
  const parsed = UploadedEpisodeIntelligence.safeParse(candidate);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  const at = issue ? issue.path.join('.') || '(root)' : '(unknown)';
  return `${at}: ${issue?.message ?? 'failed the vendored wire contract'}`;
}

/**
 * Keep a metric, degrade it, or drop it — in that order of preference, which is the order of harms
 * this metric family prices everywhere (`stage-facts.ts`'s own may-miss-never-invent note).
 *
 * A degraded envelope is re-probed before it is trusted: if the ORIGINAL fault was in the envelope
 * itself rather than its value — a provenance this daemon should never have produced, say — then
 * flipping `status` to `unavailable` does not fix it, and quietly returning the still-invalid
 * envelope would hand the outer parse the same failure the degradation existed to prevent. When even
 * the fallback will not validate, the field is omitted, which the enrichment merge reads as "this
 * sitting has nothing to say" and therefore PRESERVES whatever the server already holds
 * (`toEnrichmentPayload`'s own `provided ?? existing` note) — never worse than not having assembled it.
 *
 * `degrade: null` is for the fields with no envelope to flip (`changes`, whose four metrics are
 * separately owned by `change-stats.ts`, and `stages`, handled per element by its caller): minting a
 * replacement here would put provenance authorship in the module that explicitly does not own it.
 */
function assertable<T>(
  value: T,
  wrap: (v: T) => UploadedEpisodeIntelligenceType,
  degrade: ((fault: string) => T) | null,
  field: string,
  log: Pick<typeof defaultLogger, 'warn'>,
): T | undefined {
  const fault = faultIn(wrap(value));
  if (!fault) return value;
  if (degrade) {
    const fallback = degrade(fault);
    if (!faultIn(wrap(fallback))) {
      log.warn('an intelligence metric failed the wire contract — degraded to unavailable', { field, fault });
      return fallback;
    }
  }
  log.warn('an intelligence metric failed the wire contract — omitted', { field, fault });
  return undefined;
}

const CONTRACT_FAULT = (fault: string): string =>
  `this daemon assembled a value the wire contract refuses (${fault}), so it asserts nothing here rather than a repaired number`;

/**
 * **The audit this task owes its successor (RUN-287): every value in this payload, what produces it,
 * and why it can or cannot leave its domain.** Recorded here rather than in a ticket because the
 * question a future reader asks is "is this field safe", and a closed list is the only answer that
 * saves them re-deriving it — or, as nearly happened while writing this, adding a guard for a case
 * that cannot occur.
 *
 * **The criterion that actually predicts risk is not "is the field `int`-refined".** It is *does this
 * daemon compute the value itself, downstream of the last parse boundary*. Everything upstream of a
 * `safeParse` is already in domain by the time this module sees it; everything the daemon computes
 * after one is only as good as its own arithmetic. `retrievalTookMs` (RUN-286) was the whole class:
 * a `performance.now()` delta, computed here, fractional by construction, against `int()`.
 *
 * Safe because something PARSES them upstream:
 *   - `contextConsumption.value.charBudget` / `.charsUsed` — server-supplied, and `ContextPack` carries
 *     the IDENTICAL `int().positive()` / `int().nonnegative()` refinements
 *     (`vendor/noriq-shared/src/memory.ts`). `client.ts`'s `getContextPack` `safeParse`s the response
 *     and returns null on failure, which `context-consumption.ts` reads as `unavailable`. A server
 *     sending `charBudget: 0` never reaches this module at all.
 *
 * Safe because a loop invariant makes them structural:
 *   - `contextConsumption.value.staleCitationsCount` — `verification.total - verification.byState.valid`
 *     looks like a subtraction that could go negative, and cannot:
 *     `summarizeCitationVerification` increments `total` and exactly one `byState[state]` per citation
 *     over a closed enum, so `byState.valid <= total` holds by construction.
 *   - `sections[].excerptCount` / `.graphEntityCount`, `similarEpisodesConsidered`, `noticesCount` —
 *     array lengths.
 *   - `mode` / `role` — pack enums, parsed upstream.
 *
 * Safe because a domain guard already stands over them:
 *   - `execution.stages[].tokens` / `.costUSD` — driver-reported, guarded per COMPONENT by
 *     `stage-facts.ts` (`uploadableInt` / `uploadableNumber`, RUN-251), which degrades the one metric.
 *   - `execution.changes.*` — backend-reported, guarded field-by-field by `change-stats.ts`
 *     (`uploadable`, RUN-244/245), churn included.
 *   - `execution.stages[].elapsedMs` — always `unavailable` by construction (no per-slot clock exists).
 *
 * Safe only because of the probe above — the asymmetry worth knowing about:
 *   - `execution.observedModelUsage.value` — `RunTally`'s folded `RunModelMix`, whose four token
 *     classes are `int().nonnegative()` and whose cost is `nonnegative()`. The SAME driver numbers
 *     `stage-facts.ts` guards per component are summed into this mix by `foldSnapshot` /
 *     `mergeModelUsage` / `addUnattributed` with no guard at all, and `buildObservedModelUsage` passes
 *     the result straight through. So a driver reporting a fractional or NaN token count is a metric
 *     failure here and was, before this probe, a total analytics loss — with the tell being that one
 *     reading of one number is guarded and the other is not. `stage-facts.ts`'s own doc explains why
 *     this is not hypothetical: that vendor's notification shape has already changed twice inside this
 *     repo's lifetime. Degraded whole rather than per model, deliberately: `RunModelUsage`'s documented
 *     contract is that every key's tokens and cost SUM to the run's displayed totals, so dropping one
 *     model's entry would leave a mix that silently breaks its own invariant.
 *   - `execution.clocks.verifyDurationMs` — a daemon-computed sum of `performance.now()` deltas, and
 *     the near-miss of the class: it survives only because `IntelligenceDurationMs` is
 *     `finite().nonnegative()` rather than `int()`, so fractional milliseconds are legal by design
 *     where the identical arithmetic one field over was fatal.
 */
/**
 * Assemble this sitting's narrow `UploadedEpisodeIntelligence`.
 *
 * `execution.observedModelUsage` is now unconditional (RUN-248) — it always has an answer, complete
 * or `unavailable` — so `execution` is never actually empty for a real caller (`settle` always has a
 * tally). `undefined` survives as this function's return for the synthetic case a direct caller can
 * still construct (no stages, no verify duration, no changes) — the same omission-is-meaningful rule
 * every OTHER field here follows, restated because a reader who remembers the pre-RUN-248 "nothing
 * observed → undefined" behaviour should know it is now unreachable from `settle`, not merely rare.
 */
export function buildUploadedIntelligence(
  input: BuildUploadedIntelligenceInput,
  log: Pick<typeof defaultLogger, 'warn'> = defaultLogger,
): UploadedEpisodeIntelligenceType | undefined {
  const execution: NonNullable<UploadedEpisodeIntelligenceType['execution']> = {};

  // Per ELEMENT, not per array (RUN-287): a stage fact is one slot's accounting, and losing five
  // sound stages to a sixth bad one is the very defect this probe exists to stop, one grain down.
  // The cost is real and bounded — `execution.stages` is replaced wholesale server-side, so a dropped
  // row makes the breakdown stop summing to `observedModelUsage`, which is why the warn names the
  // slots rather than only counting them. Structurally near-unreachable in the first place:
  // `stage-facts.ts` already guards every metric each row carries.
  if (input.stages.length > 0) {
    const dropped: string[] = [];
    const kept = input.stages.filter((stage) => {
      const fault = faultIn({ execution: { stages: [stage] } });
      if (fault) dropped.push(`${stage.stage} (${fault})`);
      return !fault;
    });
    if (dropped.length > 0) {
      log.warn('stage facts failed the wire contract — dropped, the rest still reported', {
        dropped,
        kept: kept.length,
      });
    }
    if (kept.length > 0) execution.stages = kept;
  }

  const folded = foldVerifyDurations(input.verifyDurations);
  if (folded) {
    const verifyDurationMs = assertable(
      folded,
      (v) => ({ execution: { clocks: { verifyDurationMs: v } } }),
      (fault) =>
        unavailableDuration({ source: folded.source, sourceId: folded.sourceId }, CONTRACT_FAULT(fault)),
      'execution.clocks.verifyDurationMs',
      log,
    );
    if (verifyDurationMs) execution.clocks = { verifyDurationMs };
  }

  if (input.changes) {
    const measured =
      input.changes.kind === 'measured'
        ? backendChangeStats(input.changes.backend, input.changes.result)
        : notApplicableChangeStats(input.changes.backend, input.changes.reason);
    // No degrade arm: the four metrics inside are `change-stats.ts`'s to author, provenance included,
    // and minting a replacement here would move that ownership (see `assertable`'s own doc).
    const changes = assertable(
      measured,
      (v) => ({ execution: { changes: v } }),
      null,
      'execution.changes',
      log,
    );
    if (changes) execution.changes = changes;
  }

  const usage = assertable(
    buildObservedModelUsage(input.runTotal),
    (v) => ({ execution: { observedModelUsage: v } }),
    // Degraded WHOLE, never per model: `RunModelUsage`'s documented contract is that every key sums to
    // the run's displayed totals, so a mix missing one model's entry breaks its own invariant silently.
    (fault) => ({
      status: 'unavailable' as const,
      value: null,
      provenance: 'driver_reported' as const,
      source: 'driver' as const,
      sourceId: null,
      observedAt: null,
      acceptedAt: null,
      reason: CONTRACT_FAULT(fault),
    }),
    'execution.observedModelUsage',
    log,
  );
  if (usage) execution.observedModelUsage = usage;

  const payload: UploadedEpisodeIntelligenceType = {};
  if (Object.keys(execution).length > 0) payload.execution = execution;
  // Top-level sibling (RUN-247 locked decision, restated in this module's own doc above) — never
  // folded into `execution`, and never asserted when the caller had nothing to report.
  if (input.contextConsumption) {
    const observed = input.contextConsumption;
    const contextConsumption = assertable(
      observed,
      (v) => ({ contextConsumption: v }),
      // Provenance/source/sourceId are carried from the observation rather than re-declared: they
      // describe WHO measured, which is unchanged by the value being unusable. Only the value's claim
      // is withdrawn.
      (fault) => ({
        status: 'unavailable' as const,
        value: null,
        provenance: observed.provenance,
        source: observed.source,
        sourceId: observed.sourceId,
        observedAt: observed.observedAt,
        acceptedAt: observed.acceptedAt,
        reason: CONTRACT_FAULT(fault),
      }),
      'contextConsumption',
      log,
    );
    if (contextConsumption) payload.contextConsumption = contextConsumption;
  }
  return Object.keys(payload).length > 0 ? payload : undefined;
}
