/**
 * The daemon-provenance floor (PLNR-417).
 *
 * Every Project Intelligence metric this daemon uploads is refined server-side by
 * `isDaemonObservation` (planar `apps/api/src/memory/episode-intelligence.ts`):
 *
 *   DAEMON_PROVENANCE = { runner_observed, driver_reported, backend_observed, derived }
 *   DAEMON_SOURCES    = { runner, driver, vcs_backend }
 *
 * A refine failure does NOT drop the offending metric — `UPLOADED_EPISODE_SHAPE.safeParse` fails and
 * `ProjectMemory` skips the WHOLE uploaded row ("skipping malformed uploaded row"). So one wrong
 * provenance value costs an entire episode, silently, with an HTTP 200.
 *
 * That constraint lives in the server's own source and is NOT part of the vendored slice, so nothing
 * in this repo can typecheck against it. This file is the substitute: the allowlists are duplicated
 * here deliberately, as a pinned copy of a remote contract, so a builder that drifts outside them
 * fails here rather than in production as a vanished episode. If planar widens or narrows those sets,
 * this test is the thing that should be updated — and the mismatch it reports is the point.
 *
 * `MetricProvenance` itself is WIDER than the daemon set (`server_observed`, `inferred` and
 * `unavailable` are all legal values this daemon may never send), which is exactly how the original
 * defect passed every local check: `provenance: 'unavailable'` parses perfectly against
 * `EpisodeStageFact` and is rejected only at the ingest boundary.
 */

import { describe, expect, it } from 'vitest';
import { backendChangeStats } from '../src/change-stats';
import { stageFactFromTelemetry } from '../src/stage-facts';
import { completeDuration, notApplicableDuration, unavailableDuration } from '../src/stage-timing';

const DAEMON_PROVENANCE = new Set(['runner_observed', 'driver_reported', 'backend_observed', 'derived']);
const DAEMON_SOURCES = new Set(['runner', 'driver', 'vcs_backend']);

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
