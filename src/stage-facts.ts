/**
 * Per-slot Project Intelligence facts, derived from a `RunTally`'s slots (RUN-243, PLNR-290).
 *
 * `RunTally` (`supervisor.ts`) already carries everything that billed to a run — see its own doc
 * comment for the RUN-59/RUN-86 mix invariant this module reads but must never disturb: the slot
 * vocabulary (`primary`, `plan`, `review:N`, `plan-check:N`, `pattern-map`, `conflict`, `step:<id>`)
 * is load-bearing beyond telemetry (round isolation, chain-step isolation) and is not this module's
 * to rename or merge. This is purely a READING of it, into the vendored `EpisodeStageFact` shape —
 * `ExecutionKind`/`ExecutionRole` are PLNR-290's authority and this module invents no vocabulary of
 * its own, only a mapping from ours to theirs.
 *
 * Two things this module does NOT do, on purpose. It does not populate `EffortEpisode.intelligence`
 * — that field stays server-owned and null on the local record (RUN-284 locked decision; the whole
 * point of `UploadedEpisodeIntelligence` is that a daemon never has to assemble that field). It also
 * does not synthesize `executionId` (RUN-265..272's lineage plan owns execution ids; a guessed one
 * here would wear an identity field's clothes). What it used to also defer — actually reaching an
 * upload at all — no longer applies: this module's output (`stageFactFromTelemetry`, read via
 * `RunTally.stageFacts()`) is what `src/intelligence-payload.ts` assembles into
 * `UploadedEpisodeIntelligence.execution.stages` and `src/episode-upload.ts` sends, since RUN-284.
 */

import type {
  EpisodeStageFact,
  IntelligenceIntegerMetric,
  IntelligenceNumberMetric,
} from '@noriq-dev/shared';
import { totalTokens } from './drivers/budget';
import type { DriverTelemetry } from './drivers/types';
import { unavailableDuration } from './stage-timing';

/** `ExecutionKind`/`ExecutionRole` (`orchestration.ts`) export only the zod schema, no standalone
 *  type alias — these are read straight off `EpisodeStageFact`'s own field types rather than
 *  importing the schema as a value just to type a local function, which would need `z.infer`
 *  and a `zod` import this module otherwise has no reason to carry. */
type Kind = EpisodeStageFact['kind'];
type Role = EpisodeStageFact['role'];

/**
 * slot → (kind, role). One place reading `RunTally`'s slot vocabulary, so a future slot shape
 * (a new stage) needs one rule added here rather than one at every consumer.
 *
 * `kind` reuses `RunnerExecutionDeclaration.kind`'s own narrower reading of `ExecutionKind`
 * (`orchestration.ts`): 'gate' for an actor that can send work back for another look (review,
 * plan-check), 'step' for a chain's own decomposition, 'stage' for everything else that just does
 * work. `role` is the harder judgement call for two of these:
 *
 *   - `plan-check:N` → `reviewer`. It judges the SPEC the same way the inline reviewer judges the
 *     diff (CLAUDE.md: "a repo that wants an independent judgement on its WORK is the one that
 *     wants it on its PLAN") — same posture, same adversarial stance, just a different artifact.
 *   - `pattern-map` → `system`. It ENRICHES the brief (analogs, repo facts) rather than judging
 *     anything — CLAUDE.md draws exactly this line ("the closest existing file... never the idea")
 *     for what the stage is FOR, and `system` is the vendored role for work that is neither
 *     authoring nor judging.
 *
 * Anything unrecognized falls to `{ kind: 'stage', role: 'worker' }` — the same bucket `primary`
 * gets — rather than throwing: a future slot this module has not been taught about should still
 * produce SOME fact, and the safest default is the one that assumes it is ordinary work.
 */
function classifySlot(slot: string): { kind: Kind; role: Role } {
  if (slot === 'plan') return { kind: 'stage', role: 'planner' };
  if (slot.startsWith('plan-check:')) return { kind: 'gate', role: 'reviewer' };
  if (slot.startsWith('review:')) return { kind: 'gate', role: 'reviewer' };
  if (slot === 'conflict') return { kind: 'stage', role: 'repair' };
  if (slot === 'pattern-map') return { kind: 'stage', role: 'system' };
  if (slot.startsWith('step:')) return { kind: 'step', role: 'worker' };
  return { kind: 'stage', role: 'worker' }; // 'primary', and the safe default for an unknown slot
}

/** The same "did this session spend anything" test `RunTally.sum` uses to decide attributed vs
 *  unattributed (RUN-86) — reused rather than redefined, so the two readings of one snapshot can
 *  never disagree about whether it spent. */
const hasSpend = (t: DriverTelemetry): boolean => totalTokens(t) > 0 || t.costUsd > 0;

/**
 * One metric envelope, shared by the token and cost readings below — both `IntelligenceIntegerMetric`
 * and `IntelligenceNumberMetric` are the same discriminated-union shape (PLNR-290's `metricEnvelope`
 * factory) differing only in the numeric refinement zod checks at parse time, never in the TS shape,
 * so one builder serves both rather than two copies that could drift on the observation fields.
 */
function metric(available: boolean, value: number, slot: string, unavailableReason: string) {
  if (!available) {
    return {
      status: 'unavailable' as const,
      value: null,
      // `provenance` names the CHANNEL that observed this, and `status` says what that channel
      // could tell us — they are different questions, and conflating them broke the upload.
      // PLNR-417's ingest refines every daemon metric through DAEMON_PROVENANCE
      // ('runner_observed' | 'driver_reported' | 'backend_observed' | 'derived' | 'unavailable'),
      // and a refine failure skips the WHOLE episode row rather than the one metric — so a
      // `provenance: 'unavailable'` here would have silently discarded every episode carrying a
      // Codex cost, which is the common case this module exists to describe. That was true when
      // this comment was first written; PLNR-426 then widened DAEMON_PROVENANCE to allow
      // 'unavailable' from a daemon too (it is no longer "reserved for the server's own
      // nobody-observed-this case"), which retires the reason this constant picks
      // `driver_reported` rather than `unavailable` — but not the constant itself: `provenance`
      // still names the CHANNEL, and a metric this module could not observe was still reported
      // over the driver channel, so `driver_reported` remains the correct value here regardless
      // of which provenance a daemon is now permitted to send. `stage-timing.ts` already had this
      // right: one constant provenance per channel, availability in `status` alone.
      provenance: 'driver_reported' as const,
      source: 'driver' as const,
      sourceId: slot,
      observedAt: null,
      // Never stamped here: `acceptedAt` means the SERVER accepted the observation, which this
      // process cannot know. PLNR-417's `acceptMetric` sets it on ingest.
      acceptedAt: null,
      reason: unavailableReason,
    };
  }
  const now = new Date().toISOString();
  return {
    status: 'complete' as const,
    value,
    provenance: 'driver_reported' as const,
    source: 'driver' as const,
    sourceId: slot,
    observedAt: now,
    // See the unavailable arm above: `acceptedAt` is the server's stamp, not ours.
    acceptedAt: null,
    reason: null,
  };
}

const NO_TELEMETRY = 'no telemetry was recorded for this stage';
/** The Codex signature (`drivers/codex.ts` never sets `costUsd`, so it always reads exactly 0) is
 *  indistinguishable, on the numbers alone, from a session that spent tokens and genuinely cost
 *  nothing. Reporting `unavailable` rather than a measured `0` is the conservative direction stated
 *  in the task: a `0` asserts the stage was free, `unavailable` admits the driver never said. */
const COST_NOT_REPORTED =
  'the driver reported tokens but no cost for this session — booking $0 would assert it was free';

/**
 * `costReported` (below) is an INFERENCE, not a read of a capability flag: it must agree with each
 * driver's declared `DriverCapabilities.perModelTelemetry` (`drivers/types.ts`) — a driver that
 * declares per-model telemetry but sometimes ships tokens with neither `modelUsage` nor a positive
 * `costUsd` would silently mis-book a real cost as `unavailable`, and the reverse (declaring it false
 * while still setting `costUsd`) would silently claim more than the driver promises.
 * `test/driver-asymmetry.test.ts` (RUN-248) is what holds this equivalence for both shipped drivers —
 * a future third driver whose declaration and telemetry disagree fails THERE rather than reporting a
 * wrong status here with nothing to catch it. Threading a capability through `RunTally.record`'s
 * seven call sites was considered and rejected (RUN-248 locked decision): the inference is correct
 * for both shipped drivers today, so that would be churn ahead of a need.
 *
 * One narrow, PRE-EXISTING gap the conformance test also pins rather than silently trusting: Claude's
 * own `telemetryFromResult` (`drivers/claude.ts`) has a fallback arm for a result with no `modelUsage`
 * at all (an older SDK, or a result shape not yet seen) that still reports `costUsd: total_cost_usd`
 * verbatim. If that fallback ever fired for a session that genuinely cost exactly $0 — real tokens,
 * a real reported cost of zero — `costReported` reads `false` (no `modelUsage`, `costUsd` not `> 0`)
 * and this function reports `unavailable`, the same as it would for Codex, even though Claude DID
 * report a cost. This is the one case RUN-248's audit flagged as "does not arise" and found does, in
 * this one fallback arm; it is not fixed here (the fallback is a defensive compatibility path the
 * current SDK does not take, per `telemetryFromResult`'s own comment, so there is nothing live to
 * repair), only named so a future SDK change that starts taking it does not resurrect a silently
 * wrong status.
 */

/**
 * The vendored envelopes' own numeric domains, enforced here for the reason `change-stats.ts`'s
 * identical `uploadable` guard exists (RUN-251): a value TypeScript accepts and the wire REJECTS.
 * `IntelligenceIntegerMetric` refines to `int().nonnegative()` and `IntelligenceNumberMetric` to
 * `finite().nonnegative()`, and a refine failure does not drop the offending metric — it fails
 * `UploadedEpisodeIntelligence`'s parse at `toEnrichmentPayload`, which drops the WHOLE
 * `intelligence` field: every stage, the verify clocks, the change stats and the context-consumption
 * fact, for one bad number on one slot.
 *
 * Live-reachable, measured rather than assumed, which is why this guard was added after RUN-248
 * deliberately declined to add one. `DriverTelemetry`'s token counts are not validated at their
 * source: `drivers/codex.ts` builds its `usage` event as `total.inputTokens ?? 0` — a raw cast off
 * the app-server's JSON notification, where `??` guards null and undefined and nothing else, so a
 * non-integer or a string coerced into arithmetic flows straight through. That vendor's notification
 * shape has already changed twice inside this repo's own lifetime (the 0.142.x/0.144.x split
 * `codex.ts` documents), so a field's TYPE changing is an ordinary event here, not a hypothetical.
 *
 * Degrade the one metric, never repair the number and never lose its neighbours:
 * may-miss-never-invent, the order of harms this metric family prices everywhere.
 */
const uploadableInt = (v: number): boolean => Number.isSafeInteger(v) && v >= 0;
const uploadableNumber = (v: number): boolean => Number.isFinite(v) && v >= 0;

/** The four token classes `totalTokens` sums — checked individually, per this guard's own doc. */
const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const;

const outOfDomain = (field: string, v: number): string =>
  `the driver reported a ${field} of ${v}, which is not a value the metric envelope can carry`;

/**
 * One slot's `DriverTelemetry`, read as an `EpisodeStageFact`.
 *
 * `elapsedMs` is always `unavailable`: `RunTally` charges active seconds to the RUN
 * (`RunTally.chargeTime`/`activeSeconds()`), never per slot, so there is no per-stage clock to read
 * — see the class doc's own distinction between telemetry (per-slot, last-writer-wins) and time
 * (run-wide, accumulating). `executionId` is always `null` — see this module's doc comment.
 * `numTurns` (on `DriverTelemetry`) has no field on `EpisodeStageFact` and is not carried.
 *
 * Cost is `complete` whenever the driver reported ONE: either attributed per model (`modelUsage`
 * present — RUN-59) or the Claude usage-fallback's own `total_cost_usd` (RUN-34's
 * `telemetryFromResult`, real even without a per-model split). It is `unavailable` exactly when
 * nothing was spent, OR when something was spent but no cost came with it — the Codex shape.
 */
export function stageFactFromTelemetry(slot: string, t: DriverTelemetry): EpisodeStageFact {
  const { kind, role } = classifySlot(slot);
  const spent = hasSpend(t);
  const costReported = t.modelUsage != null || t.costUsd > 0;

  // Checked per COMPONENT, never on the sum — measured, and the sum hides exactly what matters:
  // a NaN component makes `totalTokens` NaN, which `hasSpend`'s `> 0` reads as "did not spend" and
  // would report as `NO_TELEMETRY` ("the driver said nothing") when the driver in fact said
  // something unusable; and a NEGATIVE component is absorbed into a positive total that then passes
  // an integer check and books as `complete` — a wrong number wearing a measured one's clothes.
  // Same reason `change-stats.ts` guards each of its four fields rather than their churn.
  const badToken = TOKEN_FIELDS.find((f) => !uploadableInt(t[f]));
  const tokenTotal = totalTokens(t);
  const tokens = metric(
    badToken === undefined && spent,
    tokenTotal,
    slot,
    badToken !== undefined ? outOfDomain(badToken, t[badToken]) : NO_TELEMETRY,
  ) as IntelligenceIntegerMetric;
  const costUSD = metric(
    uploadableNumber(t.costUsd) && spent && costReported,
    t.costUsd,
    slot,
    !uploadableNumber(t.costUsd)
      ? outOfDomain('costUsd', t.costUsd)
      : spent && !costReported
        ? COST_NOT_REPORTED
        : NO_TELEMETRY,
  ) as IntelligenceNumberMetric;

  return {
    executionId: null,
    kind,
    role,
    stage: slot,
    elapsedMs: unavailableDuration(
      { source: 'runner', sourceId: slot },
      'RunTally charges active seconds to the run as a whole, not per slot (RUN-243)',
    ),
    tokens,
    costUSD,
  };
}
