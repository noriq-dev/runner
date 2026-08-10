import type { EpisodeStageFact, IntelligenceDurationMs } from '@noriq-dev/shared';
import { UploadedEpisodeIntelligence } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import { buildUploadedIntelligence } from '../src/intelligence-payload';
import { stageFactFromTelemetry } from '../src/stage-facts';
import { completeDuration, notApplicableDuration, unavailableDuration } from '../src/stage-timing';

// RUN-284: `buildUploadedIntelligence` is the one place `RunTally.stageFacts()` and
// `RunTally.verifyDurations()` become the narrow wire payload — round-tripped here against the
// VENDORED `UploadedEpisodeIntelligence` schema (never a hand-typed shape) so a future planar
// narrowing fails HERE rather than in production. `test/supervisor.test.ts`'s "episode intelligence
// delivery" describe block covers the other half: that a real run's tally actually feeds this.

const SOURCE = { source: 'runner' as const, sourceId: 'verify' };

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

describe('buildUploadedIntelligence — omission (RUN-284)', () => {
  it('nothing observed at all → undefined, never an empty object', () => {
    const payload = buildUploadedIntelligence({ stages: [], verifyDurations: [] });
    expect(payload).toBeUndefined();
  });

  it('stages observed, verify never reached → execution.stages present, no clocks key at all', () => {
    const payload = buildUploadedIntelligence({ stages: [stage()], verifyDurations: [] });
    expect(payload?.execution?.stages).toHaveLength(1);
    expect(payload?.execution).not.toHaveProperty('clocks');
  });

  it('verify observed, no stages → execution.clocks present, no stages key at all', () => {
    const payload = buildUploadedIntelligence({
      stages: [],
      verifyDurations: [completeDuration(12, SOURCE)],
    });
    expect(payload?.execution?.clocks?.verifyDurationMs).toMatchObject({ status: 'complete', value: 12 });
    expect(payload?.execution).not.toHaveProperty('stages');
  });

  it('never sends preExecution, changes, or observedModelUsage — this task assembles none of them', () => {
    const payload = buildUploadedIntelligence({
      stages: [stage()],
      verifyDurations: [completeDuration(1, SOURCE)],
    });
    expect(payload).not.toHaveProperty('preExecution');
    expect(payload?.execution).not.toHaveProperty('changes');
    expect(payload?.execution).not.toHaveProperty('observedModelUsage');
  });
});

describe('buildUploadedIntelligence — verifyDurationMs sum semantics (RUN-284 locked decision)', () => {
  it('a run that never reached verify omits the clock entirely (undefined field, not zero)', () => {
    const payload = buildUploadedIntelligence({ stages: [stage()], verifyDurations: [] });
    expect(payload?.execution?.clocks).toBeUndefined();
  });

  it('a repo with no [verify].cmd sends the single not_applicable envelope as-is', () => {
    const na = notApplicableDuration(SOURCE, 'no [verify].cmd configured for this repo');
    const payload = buildUploadedIntelligence({ stages: [], verifyDurations: [na] });
    expect(payload?.execution?.clocks?.verifyDurationMs).toEqual(na);
  });

  it('every attempt timed → complete, summing all attempts', () => {
    const payload = buildUploadedIntelligence({
      stages: [],
      verifyDurations: [completeDuration(10, SOURCE), completeDuration(25, SOURCE)],
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
      const d = buildUploadedIntelligence({ stages: [], verifyDurations: events })?.execution?.clocks
        ?.verifyDurationMs;
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
    })?.execution?.clocks?.verifyDurationMs;
    expect(d).toMatchObject({ status: 'not_applicable', value: null });
  });

  it('the three named statuses are pairwise distinct, not just differently worded', () => {
    const omitted = buildUploadedIntelligence({ stages: [], verifyDurations: [] });
    const notApplicable = buildUploadedIntelligence({
      stages: [],
      verifyDurations: [notApplicableDuration(SOURCE, 'no cmd')],
    });
    const complete = buildUploadedIntelligence({
      stages: [],
      verifyDurations: [completeDuration(5, SOURCE)],
    });
    expect(omitted?.execution?.clocks).toBeUndefined();
    expect(notApplicable?.execution?.clocks?.verifyDurationMs?.status).toBe('not_applicable');
    expect(complete?.execution?.clocks?.verifyDurationMs?.status).toBe('complete');
  });
});

describe('buildUploadedIntelligence — round-trips against the VENDORED schema (RUN-284)', () => {
  it('a realistic assembled payload parses clean against UploadedEpisodeIntelligence', () => {
    const payload = buildUploadedIntelligence({
      stages: [
        stage(),
        stageFactFromTelemetry('review:1', {
          inputTokens: 30,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0,
          numTurns: 1,
        } as never), // codex-shaped: tokens reported, cost never set — the PLNR-417 regression case
      ],
      verifyDurations: [completeDuration(10, SOURCE), completeDuration(5, SOURCE)],
    });
    const parsed = UploadedEpisodeIntelligence.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(payload);
  });

  it('an all-omitted payload (undefined) is not itself a thing to validate — the caller sends no field', () => {
    const payload = buildUploadedIntelligence({ stages: [], verifyDurations: [] });
    expect(payload).toBeUndefined();
    // Still legal against the schema if a caller mistakenly parsed `{}` — every field is optional —
    // but this module never produces that shape; the omission happens one level up.
    expect(UploadedEpisodeIntelligence.safeParse({}).success).toBe(true);
  });

  it('a mutated payload carrying a non-daemon provenance FAILS safeParse — the exact trap this contract exists to catch', () => {
    const payload = buildUploadedIntelligence({
      stages: [stage()],
      verifyDurations: [completeDuration(10, SOURCE)],
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

// A type-level sanity check that `IntelligenceDurationMs` is actually the envelope shape these
// tests assume — if the vendor ever changes the discriminant, this file should fail to compile
// before it fails at runtime.
const _typeCheck: IntelligenceDurationMs = completeDuration(0, SOURCE);
void _typeCheck;
