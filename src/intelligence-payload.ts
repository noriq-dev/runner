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
 *
 * NOT assembled here, on purpose, because each has its own reason to wait: `preExecution.configuration`
 * already ships over the `RunReport` telemetry frame (RUN-241) and sending it again here would be a
 * second assertion of one fact; `execution.changes` is RUN-245's to attach; `execution.observedModelUsage`
 * is accepted by the contract but nothing in this daemon assembles it yet, and inventing a value here
 * would be exactly the guessed field this plan's locked decisions forbid.
 *
 * Validation is NOT this module's job — `episode-upload.ts`'s `toEnrichmentPayload` is the one place
 * that `safeParse`s the assembled payload, immediately before it leaves the box, on every send
 * including every retry. This module only decides what the payload SAYS; that module decides whether
 * it may be SENT.
 */

import type {
  EpisodeStageFact,
  IntelligenceDurationMs,
  UploadedEpisodeIntelligence as UploadedEpisodeIntelligenceType,
} from '@noriq-dev/shared';
import { type DurationSource, completeDuration, partialDuration, unavailableDuration } from './stage-timing';

export interface BuildUploadedIntelligenceInput {
  /** `RunTally.stageFacts().stages` for this run — carried straight through, never re-derived. */
  stages: EpisodeStageFact[];
  /** `RunTally.verifyDurations()` for this run — every verify-duration envelope actually observed,
   *  in observation order (one per `timedVerify` call this sitting made, or the single
   *  `not_applicable` envelope when the repo configured no `[verify].cmd`). */
  verifyDurations: readonly IntelligenceDurationMs[];
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
 * Assemble this sitting's narrow `UploadedEpisodeIntelligence`. `undefined` when nothing observed
 * (no stages recorded and verify never reached this sitting) — the caller must then send no
 * `intelligence` field at all rather than an empty object, the same omission-is-meaningful rule
 * every other field in this payload follows.
 */
export function buildUploadedIntelligence(
  input: BuildUploadedIntelligenceInput,
): UploadedEpisodeIntelligenceType | undefined {
  const execution: NonNullable<UploadedEpisodeIntelligenceType['execution']> = {};
  if (input.stages.length > 0) execution.stages = input.stages;
  const verifyDurationMs = foldVerifyDurations(input.verifyDurations);
  if (verifyDurationMs) execution.clocks = { verifyDurationMs };
  return Object.keys(execution).length > 0 ? { execution } : undefined;
}
