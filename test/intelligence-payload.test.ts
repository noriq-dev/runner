import type { EpisodeStageFact, IntelligenceDurationMs } from '@noriq-dev/shared';
import {
  DAEMON_PROVENANCE,
  DAEMON_SOURCES,
  UNATTRIBUTED_MODEL_ID,
  UploadedEpisodeIntelligence,
} from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import type { DriverTelemetry, ModelUsage } from '../src/drivers/types';
import { zeroTelemetry } from '../src/drivers/types';
import { buildObservedModelUsage, buildUploadedIntelligence } from '../src/intelligence-payload';
import { stageFactFromTelemetry } from '../src/stage-facts';
import { completeDuration, notApplicableDuration, unavailableDuration } from '../src/stage-timing';
import { RunTally } from '../src/supervisor';

// RUN-284: `buildUploadedIntelligence` is the one place `RunTally.stageFacts()` and
// `RunTally.verifyDurations()` become the narrow wire payload — round-tripped here against the
// VENDORED `UploadedEpisodeIntelligence` schema (never a hand-typed shape) so a future planar
// narrowing fails HERE rather than in production. `test/supervisor.test.ts`'s "episode intelligence
// delivery" describe block covers the other half: that a real run's tally actually feeds this.

const SOURCE = { source: 'runner' as const, sourceId: 'verify' };

// `runTotal` is required on every call since RUN-248 (every real caller — `settle` — always has a
// tally). Tests that are not exercising `observedModelUsage` itself pass this spend-less snapshot,
// same as a fresh `RunTally` would report: `modelUsage` absent, everything else zero.
const NO_SPEND: DriverTelemetry = zeroTelemetry();

function stage(over: Partial<EpisodeStageFact> = {}): EpisodeStageFact {
  return stageFactFromTelemetry('primary', {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0.1,
    numTurns: 1,
    ...over,
  } as never);
}

describe('buildUploadedIntelligence — omission (RUN-284, revised RUN-248)', () => {
  it('nothing observed but a spend-less runTotal → still DEFINED, carrying only observedModelUsage:unavailable', () => {
    // Pre-RUN-248 this returned `undefined` (nothing at all to say). Since `observedModelUsage` is
    // now unconditional — a run's spend is either known or it is not, and "not" is itself an answer
    // — `execution` is never actually empty for a real caller. See this module's own doc.
    const payload = buildUploadedIntelligence({ stages: [], verifyDurations: [], runTotal: NO_SPEND });
    expect(payload).toBeDefined();
    expect(payload?.execution?.observedModelUsage).toMatchObject({ status: 'unavailable', value: null });
    expect(payload?.execution).not.toHaveProperty('stages');
    expect(payload?.execution).not.toHaveProperty('clocks');
    expect(payload?.execution).not.toHaveProperty('changes');
  });

  it('stages observed, verify never reached → execution.stages present, no clocks key at all', () => {
    const payload = buildUploadedIntelligence({ stages: [stage()], verifyDurations: [], runTotal: NO_SPEND });
    expect(payload?.execution?.stages).toHaveLength(1);
    expect(payload?.execution).not.toHaveProperty('clocks');
  });

  it('verify observed, no stages → execution.clocks present, no stages key at all', () => {
    const payload = buildUploadedIntelligence({
      stages: [],
      verifyDurations: [completeDuration(12, SOURCE)],
      runTotal: NO_SPEND,
    });
    expect(payload?.execution?.clocks?.verifyDurationMs).toMatchObject({ status: 'complete', value: 12 });
    expect(payload?.execution).not.toHaveProperty('stages');
  });

  it('never sends preExecution — still true (RUN-284); observedModelUsage IS sent now (RUN-248)', () => {
    const payload = buildUploadedIntelligence({
      stages: [stage()],
      verifyDurations: [completeDuration(1, SOURCE)],
      runTotal: NO_SPEND,
    });
    expect(payload).not.toHaveProperty('preExecution');
    expect(payload?.execution).toHaveProperty('observedModelUsage');
  });

  it('omits execution.changes when the caller supplies nothing (RUN-245) — the same omission rule as every other field', () => {
    const payload = buildUploadedIntelligence({
      stages: [stage()],
      verifyDurations: [completeDuration(1, SOURCE)],
      runTotal: NO_SPEND,
    });
    expect(payload?.execution).not.toHaveProperty('changes');
  });
});

// RUN-245: `execution.changes` — mapped through `change-stats.ts`'s one provenance-owning mapper,
// per `settle`'s own choice of which arm applies (measured vs. not_applicable). This file covers
// the WIRING (that `input.changes` reaches `execution.changes` in the right shape); the mapping
// logic itself — refusal/domain-guard/status-derivation — is `test/change-stats.test.ts`'s job.
describe('buildUploadedIntelligence — execution.changes (RUN-245)', () => {
  it('a measured, ok:true result maps through backendChangeStats into execution.changes', () => {
    const payload = buildUploadedIntelligence({
      stages: [],
      verifyDurations: [],
      runTotal: NO_SPEND,
      changes: {
        kind: 'measured',
        backend: 'git',
        result: {
          ok: true,
          stats: { changedFiles: 2, lines: { additions: 5, deletions: 1, uncountableFiles: 0 } },
        },
      },
    });
    expect(payload?.execution?.changes).toMatchObject({
      backend: 'git',
      changedFiles: { status: 'complete', value: 2 },
      additions: { status: 'complete', value: 5 },
      deletions: { status: 'complete', value: 1 },
      churn: { status: 'complete', value: 6 },
    });
  });

  it('a refusing backend still reaches execution.changes as unavailable, with its own detail as the reason', () => {
    const payload = buildUploadedIntelligence({
      stages: [],
      verifyDurations: [],
      runTotal: NO_SPEND,
      changes: {
        kind: 'measured',
        backend: 'perforce',
        result: { ok: false, reason: 'unavailable', detail: 'p4 diff2 -q reports per-path status only' },
      },
    });
    expect(payload?.execution?.changes).toMatchObject({
      backend: 'perforce',
      changedFiles: {
        status: 'unavailable',
        value: null,
        reason: 'p4 diff2 -q reports per-path status only',
      },
    });
  });

  it('not_applicable reports all four metrics not_applicable, naming the workflow', () => {
    const payload = buildUploadedIntelligence({
      stages: [],
      verifyDurations: [],
      runTotal: NO_SPEND,
      changes: {
        kind: 'not_applicable',
        backend: 'git',
        reason: "this run's workflow ('scope') does not produce changes",
      },
    });
    expect(payload?.execution?.changes).toMatchObject({
      backend: 'git',
      changedFiles: { status: 'not_applicable', value: null },
      additions: { status: 'not_applicable', value: null },
      deletions: { status: 'not_applicable', value: null },
      churn: { status: 'not_applicable', value: null },
    });
  });

  it('a payload carrying only changes (no stages, no verify) still parses against the vendored schema', () => {
    const payload = buildUploadedIntelligence({
      stages: [],
      verifyDurations: [],
      runTotal: NO_SPEND,
      changes: { kind: 'not_applicable', backend: null, reason: 'verify workflow' },
    });
    expect(payload).toBeDefined();
    const parsed = UploadedEpisodeIntelligence.safeParse(payload);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});

describe('buildUploadedIntelligence — verifyDurationMs sum semantics (RUN-284 locked decision)', () => {
  it('a run that never reached verify omits the clock entirely (undefined field, not zero)', () => {
    const payload = buildUploadedIntelligence({ stages: [stage()], verifyDurations: [], runTotal: NO_SPEND });
    expect(payload?.execution?.clocks).toBeUndefined();
  });

  it('a repo with no [verify].cmd sends the single not_applicable envelope as-is', () => {
    const na = notApplicableDuration(SOURCE, 'no [verify].cmd configured for this repo');
    const payload = buildUploadedIntelligence({ stages: [], verifyDurations: [na], runTotal: NO_SPEND });
    expect(payload?.execution?.clocks?.verifyDurationMs).toEqual(na);
  });

  it('every attempt timed → complete, summing all attempts', () => {
    const payload = buildUploadedIntelligence({
      stages: [],
      verifyDurations: [completeDuration(10, SOURCE), completeDuration(25, SOURCE)],
      runTotal: NO_SPEND,
    });
    expect(payload?.execution?.clocks?.verifyDurationMs).toMatchObject({ status: 'complete', value: 35 });
  });

  it('one attempt lost to a boundary crash → partial, summing only what WAS timed, reason names the gap', () => {
    const payload = buildUploadedIntelligence({
      stages: [],
      verifyDurations: [
        completeDuration(10, SOURCE),
        unavailableDuration(SOURCE, 'the verify command errored before it settled'),
        completeDuration(15, SOURCE),
      ],
      runTotal: NO_SPEND,
    });
    const d = payload?.execution?.clocks?.verifyDurationMs;
    expect(d).toMatchObject({ status: 'partial', value: 25 });
    expect((d as { reason: string }).reason).toMatch(/1 of 3/);
  });

  it('attempts that ran but were never timed report `unavailable`, never a summed zero', () => {
    // The fold's one genuinely wrong-looking-right arm. Summing zero measured terms yields
    // `partial` with `value: 0`, which asserts verify took no time rather than admitting nothing
    // was measured — RUN-244's "a zero never means unknown", one metric over. Reachable, not
    // hypothetical: `verify.ts` emits `unavailableDuration` whenever the start/finish boundary is
    // lost, so a single-attempt run that loses it lands exactly here.
    for (const events of [
      [unavailableDuration(SOURCE, 'boundary lost')],
      [unavailableDuration(SOURCE, 'boundary lost'), unavailableDuration(SOURCE, 'and again')],
    ]) {
      const d = buildUploadedIntelligence({
        stages: [],
        verifyDurations: events,
        runTotal: NO_SPEND,
      })?.execution?.clocks?.verifyDurationMs;
      expect(d).toMatchObject({ status: 'unavailable', value: null });
      expect((d as { reason: string }).reason).toMatch(/none could be timed/);
    }
  });

  it('a not_applicable alongside untimed attempts still reports not_applicable, not unavailable', () => {
    // Contradictory input (no verify command configured, yet something ran) — it should not be
    // reachable, but the two arms must not be decided by array position if it ever is.
    const d = buildUploadedIntelligence({
      stages: [],
      verifyDurations: [
        unavailableDuration(SOURCE, 'boundary lost'),
        notApplicableDuration(SOURCE, 'no [verify].cmd configured for this repo'),
      ],
      runTotal: NO_SPEND,
    })?.execution?.clocks?.verifyDurationMs;
    expect(d).toMatchObject({ status: 'not_applicable', value: null });
  });

  it('the three named statuses are pairwise distinct, not just differently worded', () => {
    const omitted = buildUploadedIntelligence({ stages: [], verifyDurations: [], runTotal: NO_SPEND });
    const notApplicable = buildUploadedIntelligence({
      stages: [],
      verifyDurations: [notApplicableDuration(SOURCE, 'no cmd')],
      runTotal: NO_SPEND,
    });
    const complete = buildUploadedIntelligence({
      stages: [],
      verifyDurations: [completeDuration(5, SOURCE)],
      runTotal: NO_SPEND,
    });
    expect(omitted?.execution?.clocks).toBeUndefined();
    expect(notApplicable?.execution?.clocks?.verifyDurationMs?.status).toBe('not_applicable');
    expect(complete?.execution?.clocks?.verifyDurationMs?.status).toBe('complete');
  });
});

describe('buildUploadedIntelligence — round-trips against the VENDORED schema (RUN-284)', () => {
  it('a realistic assembled payload — including a real model mix — parses clean against UploadedEpisodeIntelligence', () => {
    const t = new RunTally();
    t.record('primary', {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.1,
      numTurns: 1,
      modelUsage: {
        'claude-opus-4-8': {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.1,
        },
      },
    });
    t.record('review:1', {
      inputTokens: 30,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      numTurns: 1,
    }); // codex-shaped: tokens reported, cost never set — the PLNR-417 regression case
    const { stages, total } = t.stageFacts();
    const payload = buildUploadedIntelligence({
      stages,
      verifyDurations: [completeDuration(10, SOURCE), completeDuration(5, SOURCE)],
      runTotal: total,
    });
    const parsed = UploadedEpisodeIntelligence.safeParse(payload);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error?.issues)).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(payload);
    expect(payload?.execution?.observedModelUsage).toMatchObject({ status: 'complete' });
  });

  it('a payload with a spend-less runTotal is DEFINED (not undefined) and still parses clean', () => {
    // Pre-RUN-248 this scenario (no stages, no verify, no changes) produced `undefined` — the
    // caller's cue to send no `intelligence` field at all. Since `observedModelUsage` is now always
    // answered, that all-empty state is no longer reachable from a real `runTotal`.
    const payload = buildUploadedIntelligence({ stages: [], verifyDurations: [], runTotal: NO_SPEND });
    expect(payload).toBeDefined();
    expect(payload?.execution?.observedModelUsage).toMatchObject({ status: 'unavailable', value: null });
    // `{}` is still legal against the schema (every field optional) — a caller mistakenly parsing it
    // would not be rejected — but this module itself now never produces that particular empty shape.
    expect(UploadedEpisodeIntelligence.safeParse({}).success).toBe(true);
    const parsed = UploadedEpisodeIntelligence.safeParse(payload);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('a mutated payload carrying a non-daemon provenance FAILS safeParse — the exact trap this contract exists to catch', () => {
    const payload = buildUploadedIntelligence({
      stages: [stage()],
      verifyDurations: [completeDuration(10, SOURCE)],
      runTotal: NO_SPEND,
    });
    const mutated = structuredClone(payload) as {
      execution: { stages: Array<{ tokens: { provenance: string } }> };
    };
    // 'server_observed' is legal MetricProvenance but NOT a daemon-legal one (DAEMON_PROVENANCE) —
    // a daemon asserting it would be forging a fact only the server can know.
    mutated.execution.stages[0]!.tokens.provenance = 'server_observed';
    const parsed = UploadedEpisodeIntelligence.safeParse(mutated);
    expect(parsed.success).toBe(false);
  });
});

// RUN-248: `execution.observedModelUsage` — `RunTally.total()`'s (equivalently `stageFacts().total`'s)
// own model mix, the run's AUTHORITATIVE figure. `test/daemon-provenance.test.ts` covers the ingest
// floor for this builder too; this file covers the fold semantics `buildObservedModelUsage` itself
// owns — complete/unavailable, never `{}`/a zeroed mix, and never `partial`.
describe('buildUploadedIntelligence — execution.observedModelUsage (RUN-248)', () => {
  const mix = (over: Partial<ModelUsage> = {}): ModelUsage => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUSD: 0,
    ...over,
  });
  const tel = (over: Partial<DriverTelemetry> = {}): DriverTelemetry => ({ ...zeroTelemetry(), ...over });

  describe('buildObservedModelUsage in isolation', () => {
    it('no mix → unavailable, value null, never {} — provenance/source still daemon-legal', () => {
      const m = buildObservedModelUsage(NO_SPEND);
      expect(m).toMatchObject({
        status: 'unavailable',
        value: null,
        provenance: 'driver_reported',
        source: 'driver',
      });
      expect(m.reason).toBeTruthy();
      expect(DAEMON_PROVENANCE.has(m.provenance)).toBe(true);
      expect(DAEMON_SOURCES.has(m.source)).toBe(true);
      expect(m.acceptedAt).toBeNull(); // the server's stamp (`acceptMetric`), never ours
    });

    it('a mix present → complete, carrying the mix verbatim, provenance driver_reported not derived', () => {
      const total = tel({
        inputTokens: 10,
        modelUsage: { 'claude-opus-4-8': mix({ inputTokens: 10, costUSD: 0.2 }) },
      });
      const m = buildObservedModelUsage(total);
      expect(m).toMatchObject({
        status: 'complete',
        value: { 'claude-opus-4-8': mix({ inputTokens: 10, costUSD: 0.2 }) },
        provenance: 'driver_reported',
        source: 'driver',
      });
      expect(m.reason).toBeNull();
      expect(DAEMON_PROVENANCE.has(m.provenance)).toBe(true);
      expect(DAEMON_SOURCES.has(m.source)).toBe(true);
    });

    it('an unattributed-only mix (a codex-only run, RUN-86) is still `complete`, never `partial` (discretion call)', () => {
      // The mix is complete AS A TOTAL regardless of how it splits across models — the RUN-86
      // `(unattributed)` bucket is part of the sum, not a hole in it. `RunModelMix`'s own doc states
      // the invariant this leans on: "every value's four token classes + cost sum … to the run's
      // displayed totals" — true here too. `'partial'` in this contract means a real but
      // UNDERCOUNTED figure (`stage-timing.ts`'s `partialDuration`: "known to be an undercount") —
      // this mix is never an undercount, only coarsely attributed. A metric envelope has no field
      // for "the total is right but the split is not", so stretching `partial` to mean that would
      // teach a consumer the status means two different things depending on context.
      const total = tel({
        inputTokens: 200,
        modelUsage: { [UNATTRIBUTED_MODEL_ID]: mix({ inputTokens: 200 }) },
      });
      expect(buildObservedModelUsage(total).status).toBe('complete');
    });

    it('an attributed model alongside the unattributed bucket is ALSO `complete`, not `partial`', () => {
      const total = tel({
        inputTokens: 220,
        modelUsage: {
          'claude-sonnet-4-5': mix({ inputTokens: 20 }),
          [UNATTRIBUTED_MODEL_ID]: mix({ inputTokens: 200 }),
        },
      });
      expect(buildObservedModelUsage(total).status).toBe('complete');
    });
  });

  it('asserted against a REAL RunTally, not a hand-built fixture', () => {
    const t = new RunTally();
    t.record(
      'primary',
      tel({ inputTokens: 100, modelUsage: { opus: mix({ inputTokens: 100, costUSD: 0.5 }) } }),
    );
    t.record(
      'review:1',
      tel({ inputTokens: 20, modelUsage: { sonnet: mix({ inputTokens: 20, costUSD: 0.1 }) } }),
    );
    const { stages, total } = t.stageFacts();
    const payload = buildUploadedIntelligence({ stages, verifyDurations: [], runTotal: total });
    expect(payload?.execution?.observedModelUsage).toMatchObject({ status: 'complete' });
    expect(payload?.execution?.observedModelUsage?.value).toEqual(total.modelUsage);
    // The tally's OWN accessor agrees too — `total()` and `stageFacts().total` are the same addition.
    expect(payload?.execution?.observedModelUsage?.value).toEqual(t.total().modelUsage);
  });

  it('a fresh tally with no recorded session sends unavailable — distinct from a run that reported a real mix', () => {
    const t = new RunTally();
    const { stages, total } = t.stageFacts();
    const payload = buildUploadedIntelligence({ stages, verifyDurations: [], runTotal: total });
    expect(payload?.execution?.observedModelUsage).toMatchObject({ status: 'unavailable', value: null });
  });

  it("summing the stage facts' token values equals observedModelUsage's token total — every stage reported telemetry", () => {
    const t = new RunTally();
    t.record(
      'primary',
      tel({
        inputTokens: 100,
        outputTokens: 10,
        modelUsage: { opus: mix({ inputTokens: 100, outputTokens: 10 }) },
      }),
    );
    t.record('review:1', tel({ inputTokens: 20, modelUsage: { sonnet: mix({ inputTokens: 20 }) } }));
    const { stages, total } = t.stageFacts();
    const payload = buildUploadedIntelligence({ stages, verifyDurations: [], runTotal: total });

    const stageTokenSum = stages.reduce(
      (a, s) => a + (s.tokens.status === 'complete' ? s.tokens.value : 0),
      0,
    );
    const mixValue = payload?.execution?.observedModelUsage?.value as Record<string, ModelUsage>;
    const mixTokenTotal = Object.values(mixValue).reduce(
      (a, u) => a + u.inputTokens + u.outputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens,
      0,
    );
    expect(stageTokenSum).toBe(mixTokenTotal);
    expect(stageTokenSum).toBe(130);
  });

  it('a telemetry-less stage contributes zero to BOTH views — the numbers agree, never diverge', () => {
    // RUN-248's own audit acceptance criterion describes a run with one telemetry-less stage where
    // "the summed stage values are LESS than observedModelUsage". That is not constructible: a
    // stage's `tokens` metric is `unavailable` EXACTLY when `hasSpend` is false (`stage-facts.ts`),
    // which is the SAME test `RunTally.foldSnapshot` uses to decide what a slot contributes to the
    // run total — so an unavailable-tokens stage adds ZERO to `observedModelUsage` too, by the same
    // structural guarantee `RunTally`'s own class doc gives the sibling claim ("stage facts sum to
    // the run total … structural, not two additions asserted to agree"). A telemetry-less stage can
    // never be the source of a strict numeric gap in this architecture. What it DOES demonstrate,
    // and what this test asserts instead: a per-stage `unavailable` entry sits beside a run-level
    // `observedModelUsage` that is still a confident, correct `complete` total — the stage's own
    // evidence is missing; the run's is not.
    const t = new RunTally();
    t.record('primary', tel({ inputTokens: 100, modelUsage: { opus: mix({ inputTokens: 100 }) } }));
    t.record('conflict', tel()); // a stopped session's zero-telemetry exit — no evidence at all
    const { stages, total } = t.stageFacts();
    const payload = buildUploadedIntelligence({ stages, verifyDurations: [], runTotal: total });

    const conflictStage = stages.find((s) => s.stage === 'conflict');
    expect(conflictStage?.tokens).toMatchObject({ status: 'unavailable', value: null });
    expect(payload?.execution?.observedModelUsage).toMatchObject({ status: 'complete' });

    const stageTokenSum = stages.reduce(
      (a, s) => a + (s.tokens.status === 'complete' ? s.tokens.value : 0),
      0,
    );
    const mixValue = payload?.execution?.observedModelUsage?.value as Record<string, ModelUsage>;
    const mixTokenTotal = Object.values(mixValue).reduce((a, u) => a + u.inputTokens, 0);
    expect(stageTokenSum).toBe(mixTokenTotal); // equal, not "less" — see the comment above
    expect(stageTokenSum).toBe(100);
  });
});

// A type-level sanity check that `IntelligenceDurationMs` is actually the envelope shape these
// tests assume — if the vendor ever changes the discriminant, this file should fail to compile
// before it fails at runtime.
const _typeCheck: IntelligenceDurationMs = completeDuration(0, SOURCE);
void _typeCheck;
