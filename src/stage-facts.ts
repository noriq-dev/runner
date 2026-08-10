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
 * Two things this module does NOT do, on purpose: it does not populate `EffortEpisode.intelligence`
 * or widen any upload surface (the server strips it — RUN-241's comment in `episode-upload.ts`;
 * PLNR-417 gates that end), and it does not synthesize `executionId` (RUN-265..272's lineage plan
 * owns execution ids; a guessed one here would wear an identity field's clothes). Both are left for
 * whoever wires this into an actual upload.
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
      // ('runner_observed' | 'driver_reported' | 'backend_observed' | 'derived'), and a refine
      // failure skips the WHOLE episode row rather than the one metric — so a `provenance:
      // 'unavailable'` here (legal in MetricProvenance, reserved for the server's own
      // nobody-observed-this case) would have silently discarded every episode carrying a Codex
      // cost, which is the common case this module exists to describe. `stage-timing.ts` already
      // had this right: one constant provenance per channel, availability in `status` alone.
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

  const tokens = metric(spent, totalTokens(t), slot, NO_TELEMETRY) as IntelligenceIntegerMetric;
  const costUSD = metric(
    spent && costReported,
    t.costUsd,
    slot,
    spent ? COST_NOT_REPORTED : NO_TELEMETRY,
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
