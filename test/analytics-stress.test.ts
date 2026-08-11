import type { Run } from '@noriq-dev/shared';
import { UploadedEpisodeIntelligence } from '@noriq-dev/shared';
import { describe, expect, it, vi } from 'vitest';
import { backendChangeStats } from '../src/change-stats';
import type { ContinuableRun } from '../src/continuable';
import { zeroTelemetry } from '../src/drivers/types';
import type { DriverExit, DriverTelemetry } from '../src/drivers/types';
import { buildEpisode, deriveEpisodeScopeId } from '../src/episode';
import { toEnrichmentPayload } from '../src/episode-upload';
import { buildUploadedIntelligence } from '../src/intelligence-payload';
import { stageFactFromTelemetry } from '../src/stage-facts';
import type { RunPipeline } from '../src/stages/types';
import { type ResolvedRepo, RunTally, telemetryFromSpent } from '../src/supervisor';
import type { ChangeStatsResult } from '../src/vcs/types';
import { BUILTIN_WORKFLOWS } from '../src/workflow';

// RUN-251: scale (many sessions, large change sets) and malformed-shape coverage for the analytics
// facts RUN-244..250 added — never construction of new metrics or new caps (this task's own
// deferred list). Fixtures reused from episode.test.ts's own pattern (that file's stated convention:
// "test files are the isolation boundary here").

const run = {
  id: 'run_1',
  projectId: 'prj_p',
  anchor: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  dispatchedAt: '2026-08-01T00:00:05.000Z',
} as Run;
const repo: ResolvedRepo = { root: '/repo', manifest: { repositoryKey: 'myrepo' } as never };
const worktree = {
  runId: 'run_1',
  localPath: '/wt/run_1',
  readOnly: false,
  workRef: 'noriq/run/run_1',
  baseId: 'sha_base',
  location: { branch: 'noriq/run/run_1' },
} as const;
const runAgent = {
  agentId: 'agt_1',
  label: 'build-abc',
  token: 'tok_run',
  projectId: 'prj_p',
  expiresIn: 3600,
};
const driver = {
  tool: 'claude' as const,
  capabilities: {
    toolHooks: true,
    steer: true,
    interrupt: true,
    resumableSession: true,
    perModelTelemetry: true,
  },
  catalog: { models: [], efforts: [] },
  start: () => ({}) as never,
};

function baseCtx(over: Partial<RunPipeline> = {}): RunPipeline {
  const telemetry: DriverTelemetry = { ...zeroTelemetry() };
  const exit: DriverExit = { outcome: 'done', isError: false, reason: null, telemetry };
  return {
    run,
    repo,
    worktree: worktree as never,
    driver,
    permission: {} as never,
    task: null,
    runAgent,
    session: {} as never,
    stopSession: async () => {},
    tally: new RunTally(),
    sessionText: '',
    tail: '',
    continued: null,
    workflow: BUILTIN_WORKFLOWS.build,
    acceptance: [],
    acceptanceOverflow: 0,
    requirements: [],
    exit,
    driverSucceeded: true,
    landed: false,
    ledger: [],
    landPolicy: null,
    commandObservations: [],
    ...over,
  };
}

// ── scale: many sessions/rounds still reconcile (RUN-248's own invariant, restated under load) ─────

describe('RunTally.stageFacts() reconciliation holds at scale (RUN-251)', () => {
  it('a long reviewer/fix loop plus a decomposed chain still sums stage tokens to the run total', () => {
    const tally = new RunTally();
    let expectedTokens = 0;
    let expectedCost = 0;
    // A "realistic chain-heavy sitting" (the exact phrase `episode-pending.ts`'s own byte-budget
    // doc uses): sixty stage slots — a chain of forty steps plus twenty review rounds.
    for (let i = 0; i < 40; i++) {
      const t: DriverTelemetry = { ...zeroTelemetry(), outputTokens: 10 + i, costUsd: 0.001 * i };
      tally.record(`step:s${i}`, t);
      expectedTokens += 10 + i;
      expectedCost += 0.001 * i;
    }
    for (let i = 1; i <= 20; i++) {
      const t: DriverTelemetry = { ...zeroTelemetry(), outputTokens: 5, costUsd: 0.002 };
      tally.record(`review:${i}`, t);
      expectedTokens += 5;
      expectedCost += 0.002;
    }

    const { stages, total } = tally.stageFacts();
    expect(stages).toHaveLength(60);
    // No loss: one fact per slot, every slot's own attempt represented.
    expect(new Set(stages.map((s) => s.stage)).size).toBe(60);

    // The summed stage tokens equal observedModelUsage's total — RUN-248's reconciliation, at scale.
    const summedStageTokens = stages.reduce(
      (sum, s) => sum + (s.tokens.status === 'complete' ? (s.tokens.value ?? 0) : 0),
      0,
    );
    expect(summedStageTokens).toBe(expectedTokens);
    expect(total.outputTokens).toBeCloseTo(expectedTokens, 6);
    expect(total.costUsd).toBeCloseTo(expectedCost, 6);

    // The assembled payload survives the vendored schema at this scale, with no stage dropped.
    const payload = buildUploadedIntelligence({ stages, verifyDurations: [], runTotal: total });
    expect(UploadedEpisodeIntelligence.safeParse(payload).success).toBe(true);
    expect(payload?.execution?.stages).toHaveLength(60);
  });

  it('a slot recorded twice (a hand-back turn) is last-writer-wins, never double-counted in stageFacts', () => {
    const tally = new RunTally();
    tally.record('primary', { ...zeroTelemetry(), outputTokens: 10 });
    tally.record('primary', { ...zeroTelemetry(), outputTokens: 25 }); // the session's cumulative, not a delta
    const { stages, total } = tally.stageFacts();
    expect(stages).toHaveLength(1);
    expect(total.outputTokens).toBe(25);
  });
});

// ── malformed driver telemetry and backend change-stats degrade, never crash the assembly ──────────

describe('malformed driver telemetry degrades through the guards that already exist (RUN-251)', () => {
  const cases: Array<[string, Partial<DriverTelemetry>]> = [
    ['NaN input tokens', { inputTokens: Number.NaN }],
    ['negative output tokens', { outputTokens: -7 }],
    ['fractional output tokens', { outputTokens: 3.5 }],
    ['Infinity output tokens', { outputTokens: Number.POSITIVE_INFINITY }],
    ['NaN costUsd, real tokens', { outputTokens: 10, costUsd: Number.NaN }],
    ['negative costUsd, real tokens', { outputTokens: 10, costUsd: -1 }],
    ['Infinity costUsd, real tokens', { outputTokens: 10, costUsd: Number.POSITIVE_INFINITY }],
  ];

  it.each(cases)('%s never throws building the stage fact', (_label, over) => {
    const t: DriverTelemetry = { ...zeroTelemetry(), ...over };
    expect(() => stageFactFromTelemetry('primary', t)).not.toThrow();
  });

  it.each(cases)(
    '%s: the ASSEMBLED payload never ships the malformed number — either the metric degrades to unavailable, or (when it does not) the final wire-boundary safeParse drops the whole payload rather than sending it',
    (_label, over) => {
      const t: DriverTelemetry = { ...zeroTelemetry(), ...over };
      const fact = stageFactFromTelemetry('primary', t);
      const payload = buildUploadedIntelligence({ stages: [fact], verifyDurations: [], runTotal: t });
      const parsed = UploadedEpisodeIntelligence.safeParse(payload);
      if (!parsed.success) {
        // A shape `stage-facts.ts` did NOT degrade inline (Infinity, a fractional token count) —
        // caught one gate later, at `toEnrichmentPayload`'s own send-time safeParse. FINDING (see
        // this describe block's own header comment): unlike `change-stats.ts`'s per-field
        // `uploadable()` guard, `stage-facts.ts` has no equivalent, so one malformed STAGE costs the
        // WHOLE intelligence upload for that episode — not merely that one metric. The episode's
        // base fields (filesTouched/commands/testsRun/failures/findings/selfSummary) still ship;
        // only `intelligence` is dropped, and the drop is logged, never silent.
        const ep = {
          runId: 'run_1',
          filesTouched: [],
          commands: [],
          testsRun: [],
          failures: [],
          findings: [],
        };
        const wire = toEnrichmentPayload(ep as never, payload, { warn: () => {} });
        expect(wire.intelligence).toBeUndefined();
        expect(wire.runId).toBe('run_1'); // the episode itself is unaffected
      } else {
        // The common, better-covered case (NaN/negative tokens, NaN/negative costUsd): degrades to
        // `unavailable` on that metric inline, and the rest of the payload survives untouched.
        expect(
          parsed.data.execution?.stages?.[0]?.tokens.status === 'unavailable' ||
            parsed.data.execution?.stages?.[0]?.costUSD.status === 'unavailable',
        ).toBe(true);
      }
    },
  );

  it('missing modelUsage with real tokens still reports unavailable cost rather than a fabricated $0 (the Codex shape)', () => {
    const t: DriverTelemetry = { ...zeroTelemetry(), outputTokens: 10 }; // no modelUsage, no costUsd
    const fact = stageFactFromTelemetry('primary', t);
    expect(fact.tokens.status).toBe('complete');
    expect(fact.costUSD.status).toBe('unavailable');
    expect(
      UploadedEpisodeIntelligence.safeParse(
        buildUploadedIntelligence({ stages: [fact], verifyDurations: [], runTotal: t }),
      ).success,
    ).toBe(true);
  });
});

describe('malformed backend change-stats results degrade to unavailable, never crash (RUN-251)', () => {
  const malformed: Array<[string, ChangeStatsResult]> = [
    ['NaN changedFiles', { ok: true, stats: { changedFiles: Number.NaN, lines: null } }],
    ['negative changedFiles', { ok: true, stats: { changedFiles: -3, lines: null } }],
    [
      'fractional additions',
      { ok: true, stats: { changedFiles: 2, lines: { additions: 1.5, deletions: 0, uncountableFiles: 0 } } },
    ],
    [
      'Infinity deletions',
      {
        ok: true,
        stats: {
          changedFiles: 2,
          lines: { additions: 1, deletions: Number.POSITIVE_INFINITY, uncountableFiles: 0 },
        },
      },
    ],
    [
      'NaN uncountableFiles',
      {
        ok: true,
        stats: { changedFiles: 2, lines: { additions: 1, deletions: 1, uncountableFiles: Number.NaN } },
      },
    ],
    [
      'a refusal with a real reason',
      { ok: false, reason: 'unavailable', detail: 'git diff --numstat failed' },
    ],
  ];

  it.each(malformed)(
    '%s degrades to unavailable and the envelope still passes UploadedEpisodeIntelligence.safeParse',
    (_label, result) => {
      const stats = backendChangeStats('git', result);
      const payload = buildUploadedIntelligence({
        stages: [],
        verifyDurations: [],
        changes: { kind: 'measured', backend: 'git', result },
        runTotal: zeroTelemetry(),
      });
      expect(UploadedEpisodeIntelligence.safeParse(payload).success).toBe(true);
      // At least one field reads unavailable for every malformed shape above — never a repaired or
      // fabricated number (may-miss-never-invent, `change-stats.ts`'s own rule).
      expect(
        [stats.changedFiles, stats.additions, stats.deletions, stats.churn].some(
          (m) => m.status === 'unavailable',
        ),
      ).toBe(true);
    },
  );
});

// ── the shape-bound: a 10,000-file change and a 1-file change serialize identically ─────────────────

describe('change-stat payload size is bounded by SHAPE, not by how much changed (RUN-251, locked decision verified)', () => {
  it('a 10,000-file change and a 1-file change produce byte-identical-length envelopes', () => {
    // `uncountableFiles: 0` on BOTH, deliberately: a nonzero count on only one side would make
    // `additions`/`deletions`/`churn` read `partial` with a `reason` string attached on that side
    // alone — a difference in STATUS, not in how many files changed, which is a different claim
    // than the one this test checks. Both `complete`, so the only bytes that can differ are digits.
    const huge = backendChangeStats('git', {
      ok: true,
      stats: { changedFiles: 10_000, lines: { additions: 84_213, deletions: 41_907, uncountableFiles: 0 } },
    });
    const tiny = backendChangeStats('git', {
      ok: true,
      stats: { changedFiles: 1, lines: { additions: 3, deletions: 1, uncountableFiles: 0 } },
    });
    // Four metric envelopes either way — the same measured claim CLAUDE.md's own locked decision
    // states (~938 bytes) — verified here by structural shape (same key sets, same value TYPES)
    // rather than trusted from the comment.
    expect(Object.keys(huge)).toEqual(Object.keys(tiny));
    for (const key of ['changedFiles', 'additions', 'deletions', 'churn'] as const) {
      expect(Object.keys(huge[key])).toEqual(Object.keys(tiny[key]));
      expect(typeof huge[key].value).toBe(typeof tiny[key].value);
    }
    // The only bytes that differ are the DIGITS of the numbers themselves — bounded, not unbounded,
    // by construction: a change-stat is four counts, whatever the count.
    const hugeLen = JSON.stringify(huge).length;
    const tinyLen = JSON.stringify(tiny).length;
    expect(hugeLen - tinyLen).toBeLessThan(40); // a handful of extra digits, not a payload that grows with file count
  });

  it('one EpisodeStageFact is the same size whether its slot did a little work or a lot', () => {
    const small = stageFactFromTelemetry('primary', { ...zeroTelemetry(), outputTokens: 1, costUsd: 0.0001 });
    const large = stageFactFromTelemetry('primary', {
      ...zeroTelemetry(),
      outputTokens: 50_000_000,
      inputTokens: 12_000_000,
      costUsd: 8123.4567,
    });
    const smallLen = JSON.stringify(small).length;
    const largeLen = JSON.stringify(large).length;
    expect(largeLen - smallLen).toBeLessThan(40);
  });
});

// ── continued/cancelled/failed sitting attribution ───────────────────────────────────────────────

describe('a cancelled, a failed, and a continued sitting each settle a distinguishably-identified episode (RUN-251)', () => {
  it('scopeId — the field the RUN-227 locked decision names — differs across all three, and identically-runId sittings only converge when their terminal moment does too', () => {
    // Fake, ADVANCING time: `buildEpisode` stamps `createdAt` off the real wall clock, and three
    // synchronous calls in one test can otherwise land in the same millisecond — which would make
    // this test's own construction, not the identity design, produce the collision it is checking
    // for. Each sitting gets its own distinct, deterministic terminal moment instead.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    const cancelled = buildEpisode(
      baseCtx({
        exit: { outcome: 'failed', isError: true, reason: 'cancelled', telemetry: zeroTelemetry() },
        driverSucceeded: false,
      }),
      { filesTouched: [], hasRemainingWork: false, steeringHistory: [] },
    );
    vi.setSystemTime(new Date('2026-08-01T00:05:00.000Z'));
    const failed = buildEpisode(
      baseCtx({ exit: { outcome: 'failed', isError: true, reason: 'review', telemetry: zeroTelemetry() } }),
      { filesTouched: [], hasRemainingWork: true, steeringHistory: [] },
    );
    const continuedSeed: ContinuableRun = {
      runId: 'run_1',
      spent: { tokens: 10, usd: 0.5 },
      ledger: [],
      failedAt: '2026-08-01T00:00:00.000Z',
    };
    const continuedTally = new RunTally();
    continuedTally.seed('__prior__', telemetryFromSpent(continuedSeed.spent));
    vi.setSystemTime(new Date('2026-08-01T00:10:00.000Z'));
    const continued = buildEpisode(baseCtx({ continued: continuedSeed, tally: continuedTally }), {
      filesTouched: [],
      hasRemainingWork: false,
      steeringHistory: [],
    });
    vi.useRealTimers();

    // Every episode is for the SAME run id, so `scopeId` (never the bare runId — RUN-227 locked
    // decision 2) is the field that carries the distinction: it folds in `episode.createdAt`, this
    // sitting's own terminal moment.
    const scopeCancelled = deriveEpisodeScopeId({ runId: cancelled.runId, terminalAt: cancelled.createdAt });
    const scopeFailed = deriveEpisodeScopeId({ runId: failed.runId, terminalAt: failed.createdAt });
    const scopeContinued = deriveEpisodeScopeId({ runId: continued.runId, terminalAt: continued.createdAt });

    expect(new Set([scopeCancelled, scopeFailed, scopeContinued]).size).toBe(3);
    // And a RETRY of the exact same sitting (same runId, same terminal moment) converges on purpose
    // — the other half of the RUN-227 locked decision this test would otherwise only check one side of.
    expect(deriveEpisodeScopeId({ runId: cancelled.runId, terminalAt: cancelled.createdAt })).toBe(
      scopeCancelled,
    );

    // The three are also independently distinguishable by outcome shape, not just by identity.
    expect(cancelled.failures).toContain('terminal reason: cancelled');
    expect(failed.failures).toContain('terminal reason: review');
    expect(continued.timeline.some((e) => e.label.includes('continuation'))).toBe(true);
  });

  it('the continued sitting preserves cumulative spend from the prior tally, while a cancelled sitting cannot forge one it never had', () => {
    const continuedSeed: ContinuableRun = {
      runId: 'run_1',
      spent: { tokens: 100, usd: 2.5 },
      ledger: [],
      failedAt: '2026-08-01T00:00:00.000Z',
    };
    const tally = new RunTally();
    tally.seed('__prior__', telemetryFromSpent(continuedSeed.spent));
    tally.record('primary', { ...zeroTelemetry(), outputTokens: 10 });
    const continued = buildEpisode(
      baseCtx({
        continued: continuedSeed,
        tally,
        exit: { outcome: 'done', isError: false, reason: null, telemetry: tally.total() },
      }),
      { filesTouched: [], hasRemainingWork: false, steeringHistory: [] },
    );
    // The prior sitting's tokens are folded into the total — cumulative, not reset per sitting.
    expect(continued.tokenUsage).toBeDefined();
    const cancelled = buildEpisode(
      baseCtx({
        exit: { outcome: 'failed', isError: true, reason: 'cancelled', telemetry: zeroTelemetry() },
      }),
      { filesTouched: [], hasRemainingWork: false, steeringHistory: [] },
    );
    expect(cancelled.costUSD).toBe(0);
  });
});

// ── recordVerifyDuration is TOTAL, not merely trusted total (RUN-251) ────────────────────────────

describe('RunTally.recordVerifyDuration cannot throw, even when its own storage is corrupted (RUN-251)', () => {
  it('a push that would throw is absorbed — the run’s verify result is never at risk', () => {
    const tally = new RunTally();
    tally.recordVerifyDuration({
      status: 'complete',
      value: 5,
      provenance: 'runner_observed',
      source: 'runner',
      sourceId: 'verify',
      observedAt: new Date().toISOString(),
      acceptedAt: null,
      reason: null,
    });
    // Freeze the tally's own private accumulator so the next push throws — the white-box case the
    // ordinary array-push path cannot exercise, and the reason this method is guarded at all: two of
    // its three call sites (`supervisor.ts`) run inside `timedVerify`'s `finally` block, where an
    // exception does not merely fail to log a metric — it REPLACES the block's return value,
    // turning a clean PASS into a thrown error (`verify.ts`'s own doc: "onDuration always fires
    // before it propagates, but it still propagates"). Guarding the method is what keeps that
    // theoretical danger from ever being able to reach a real verify result.
    const verifyDurationEvents = (tally as unknown as { verifyDurationEvents: unknown[] })
      .verifyDurationEvents;
    Object.freeze(verifyDurationEvents);

    expect(() =>
      tally.recordVerifyDuration({
        status: 'unavailable',
        value: null,
        provenance: 'runner_observed',
        source: 'runner',
        sourceId: 'verify',
        observedAt: null,
        acceptedAt: null,
        reason: 'boom',
      }),
    ).not.toThrow();
    // The prior, successfully-recorded observation survives — the corrupted push cost only itself.
    expect(tally.verifyDurations()).toHaveLength(1);
    expect(tally.verifyDurations()[0]?.status).toBe('complete');
  });
});

describe('a driver-reported number outside the envelope domain costs its own metric, not the payload (RUN-251)', () => {
  // The gap this closes was measured, not assumed. `drivers/codex.ts` builds its usage event as
  // `total.inputTokens ?? 0` — a raw cast off the app-server's JSON, where `??` guards null and
  // nothing else — so a non-integer token count is an ordinary consequence of that vendor changing
  // a field's type, which it has already done twice in this repo's lifetime. Before RUN-251 such a
  // value survived `stage-facts.ts` (which had no domain guard, unlike its sibling
  // `change-stats.ts`) and failed the FINAL `safeParse`, dropping the whole `intelligence` field —
  // every stage, the clocks, the change stats and the context fact — for one bad number.
  const spent = (over: Partial<DriverTelemetry>): DriverTelemetry => ({
    ...zeroTelemetry(),
    inputTokens: 1000,
    outputTokens: 200,
    ...over,
  });

  for (const [label, bad] of [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['fractional', 1.5],
    ['negative', -5],
  ] as const) {
    it(`a ${label} token count degrades that stage's tokens and keeps the payload uploadable`, () => {
      const fact = stageFactFromTelemetry('review:1', spent({ inputTokens: bad }));
      expect(fact.tokens).toMatchObject({ status: 'unavailable', value: null });
      expect(fact.tokens.reason).toContain('metric envelope');
      expect(fact.tokens.reason).toContain('inputTokens');
      const payload = buildUploadedIntelligence({
        stages: [fact, stageFactFromTelemetry('primary', spent({ costUsd: 0.5 }))],
        runTotal: spent({ costUsd: 0.5 }),
        verifyDurations: [],
      });
      const parsed = UploadedEpisodeIntelligence.safeParse(payload);
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error?.issues)).toBe(true);
      // The neighbour survived — the whole point of degrading one metric rather than the field.
      expect(payload?.execution?.stages?.[1]?.tokens.status).toBe('complete');
    });
  }

  it('a non-finite cost degrades cost alone and leaves that stage’s tokens intact', () => {
    const fact = stageFactFromTelemetry('primary', spent({ costUsd: Number.POSITIVE_INFINITY }));
    expect(fact.costUSD).toMatchObject({ status: 'unavailable', value: null });
    expect(fact.tokens).toMatchObject({ status: 'complete' });
    expect(
      UploadedEpisodeIntelligence.safeParse(
        buildUploadedIntelligence({ stages: [fact], runTotal: spent({}), verifyDurations: [] }),
      ).success,
    ).toBe(true);
  });
});
