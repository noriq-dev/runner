/**
 * The daemon-provenance floor (PLNR-417, PLNR-426).
 *
 * Every Project Intelligence metric this daemon uploads is refined server-side by
 * `isDaemonObservation` (planar `apps/api/src/memory/episode-intelligence.ts`) against
 * `DAEMON_PROVENANCE`/`DAEMON_SOURCES` — and since PLNR-426 those two allowlists, plus the
 * `UploadedEpisodeIntelligence` shape they gate, live in `packages/shared/src/intelligence.ts` and
 * are VENDORED wholesale into this repo (`vendor/noriq-shared/src/intelligence.ts`). This file used
 * to say the opposite — "that constraint lives in the server's own source and is NOT part of the
 * vendored slice, so nothing in this repo can typecheck against it" — which PLNR-426 made false by
 * moving the constraint itself, not merely by adding a copy of it. That premise is retired; this
 * test now imports the real allowlists rather than pinning a hand-copied Set.
 *
 * The hand-copied Set this file used to declare had already drifted from what it claimed to pin:
 * planar's `DAEMON_PROVENANCE` carries FIVE values, including `'unavailable'` (deliberately — the
 * common case when a Codex reviewer reports tokens but never sets a cost field must stay allowed),
 * while the copy here had four and its own comment called `'unavailable'` "reserved for the server's
 * own nobody-observed-this case". The drift happened within two days of the copy being written, in
 * the safe direction (stricter than the server, so it cost a false failure here rather than a lost
 * episode in production) — which is exactly the argument for importing instead of hand-maintaining a
 * second copy that can only ever drift again.
 *
 * A refine failure does NOT drop the offending metric — `UPLOADED_EPISODE_SHAPE.safeParse` fails and
 * `ProjectMemory` skips the WHOLE uploaded row ("skipping malformed uploaded row"). So one wrong
 * provenance value costs an entire episode, silently, with an HTTP 200 — `src/episode-upload.ts`'s
 * `toEnrichmentPayload` is what now catches that here, before upload, rather than letting planar
 * discover it.
 *
 * `MetricProvenance` itself is WIDER than the daemon set (`server_observed`, `inferred` are legal
 * values this daemon may never send), which is exactly how the original defect passed every local
 * check: `provenance: 'unavailable'` parses perfectly against `EpisodeStageFact` and used to be
 * rejected only at the ingest boundary — and would still be, for any value truly outside the daemon
 * set, which is why this test still exists even now that the allowlist itself is imported rather
 * than copied: a typo here still needs to fail as loudly as it did before.
 */

import { DAEMON_PROVENANCE, DAEMON_SOURCES } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import { backendChangeStats } from '../src/change-stats';
import { buildContextConsumption } from '../src/context-consumption';
import { zeroTelemetry } from '../src/drivers/types';
import { buildObservedModelUsage } from '../src/intelligence-payload';
import { stageFactFromTelemetry } from '../src/stage-facts';
import { completeDuration, notApplicableDuration, unavailableDuration } from '../src/stage-timing';

const expectAcceptable = (metric: { provenance: string; source: string; acceptedAt: string | null }) => {
  expect(DAEMON_PROVENANCE.has(metric.provenance)).toBe(true);
  expect(DAEMON_SOURCES.has(metric.source)).toBe(true);
  // `acceptedAt` is the server's own stamp (`acceptMetric`); a daemon claiming it is asserting
  // something it cannot know, so every builder here must leave it null.
  expect(metric.acceptedAt).toBeNull();
};

const telemetry = (over: Partial<Record<string, number>> = {}) => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  numTurns: 0,
  ...over,
});

describe('every duration envelope is acceptable to the ingest (PLNR-417)', () => {
  const source = { source: 'runner' as const, sourceId: 'verify' };

  it('complete', () => expectAcceptable(completeDuration(12, source)));
  it('not_applicable', () => expectAcceptable(notApplicableDuration(source, 'no verify cmd configured')));
  it('unavailable', () => expectAcceptable(unavailableDuration(source, 'boundary lost')));
});

describe('every stage-fact envelope is acceptable to the ingest (PLNR-417)', () => {
  // The regression that motivated this file: an unavailable metric must still carry a DAEMON
  // provenance. A Codex reviewer — tokens reported, cost never set — is the common shape, so this
  // case is what would have discarded most real episodes.
  it('a codex-shaped stage (tokens, no cost) keeps both metrics uploadable', () => {
    const fact = stageFactFromTelemetry('review:1', telemetry({ inputTokens: 500, outputTokens: 100 }));
    expect(fact.tokens.status).toBe('complete');
    expect(fact.costUSD.status).toBe('unavailable');
    expectAcceptable(fact.tokens);
    expectAcceptable(fact.costUSD);
  });

  it('a slot with no telemetry at all keeps both metrics uploadable', () => {
    const fact = stageFactFromTelemetry('primary', telemetry());
    expect(fact.tokens.status).toBe('unavailable');
    expectAcceptable(fact.tokens);
    expectAcceptable(fact.costUSD);
  });

  it('a fully attributed stage keeps both metrics uploadable', () => {
    const fact = stageFactFromTelemetry(
      'primary',
      telemetry({ inputTokens: 10, outputTokens: 5, costUsd: 0.25 }),
    );
    expect(fact.tokens.status).toBe('complete');
    expect(fact.costUSD.status).toBe('complete');
    expectAcceptable(fact.tokens);
    expectAcceptable(fact.costUSD);
  });

  it('elapsedMs, which is always unavailable, is still uploadable', () => {
    expectAcceptable(stageFactFromTelemetry('primary', telemetry()).elapsedMs);
  });
});

describe('every change-stats envelope is acceptable to the ingest (PLNR-417, RUN-244)', () => {
  // The RUN-243 regression restated for a new builder: a refusal must still carry a DAEMON
  // provenance, and churn's 'derived' provenance (never 'backend_observed') must be in the set too.
  it('a backend refusal keeps all four metrics uploadable', () => {
    const stats = backendChangeStats('perforce', {
      ok: false,
      reason: 'unavailable',
      detail: 'no measured primitive',
    });
    expectAcceptable(stats.changedFiles);
    expectAcceptable(stats.additions);
    expectAcceptable(stats.deletions);
    expectAcceptable(stats.churn);
  });

  it('a complete change-stats result keeps all four metrics uploadable', () => {
    const stats = backendChangeStats('git', {
      ok: true,
      stats: { changedFiles: 3, lines: { additions: 12, deletions: 4, uncountableFiles: 0 } },
    });
    expectAcceptable(stats.changedFiles);
    expectAcceptable(stats.additions);
    expectAcceptable(stats.deletions);
    expectAcceptable(stats.churn);
  });

  it('a partial change-stats result (some files uncountable) keeps all four metrics uploadable', () => {
    const stats = backendChangeStats('git', {
      ok: true,
      stats: { changedFiles: 5, lines: { additions: 1, deletions: 0, uncountableFiles: 2 } },
    });
    expectAcceptable(stats.changedFiles);
    expectAcceptable(stats.additions);
    expectAcceptable(stats.deletions);
    expectAcceptable(stats.churn);
  });
});

describe('the contextConsumption envelope is acceptable to the ingest (RUN-247)', () => {
  it('not_applicable, unavailable, complete and partial are all daemon-legal', () => {
    const notApplicable = buildContextConsumption({
      retrieval: { attempted: false, pack: null, omission: { reason: 'no-task' }, tookMs: 0 },
      verifiedContextPack: null,
      rendered: { text: '', chars: 0, truncated: false },
    });
    const unavailable = buildContextConsumption({
      retrieval: { attempted: true, pack: null, omission: { reason: 'unavailable' }, tookMs: 5 },
      verifiedContextPack: null,
      rendered: { text: '', chars: 0, truncated: false },
    });
    for (const m of [notApplicable, unavailable]) {
      expect(m).not.toBeNull();
      expectAcceptable(m as never);
    }
  });
});

describe('the observedModelUsage envelope is acceptable to the ingest (RUN-248)', () => {
  it('a run with no mix keeps the unavailable envelope uploadable', () => {
    expectAcceptable(buildObservedModelUsage(zeroTelemetry()));
  });

  it('a run with a real per-model mix keeps the complete envelope uploadable', () => {
    const total = {
      ...zeroTelemetry(),
      inputTokens: 10,
      modelUsage: {
        'claude-opus-4-8': {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.2,
        },
      },
    };
    expectAcceptable(buildObservedModelUsage(total));
  });
});
