import { BackendChangeStats } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import { backendChangeStats } from '../src/change-stats';
import type { ChangeStats, ChangeStatsResult } from '../src/vcs/types';

const ok = (stats: ChangeStats): ChangeStatsResult => ({ ok: true, stats });

describe('backendChangeStats — refusal (RUN-244)', () => {
  it('maps {ok:false} to all four metrics unavailable, with the backend detail as the reason', () => {
    const result: ChangeStatsResult = {
      ok: false,
      reason: 'unavailable',
      detail: 'perforce has no measured primitive for this',
    };
    const stats = backendChangeStats('perforce', result);

    expect(stats.backend).toBe('perforce');
    for (const m of [stats.changedFiles, stats.additions, stats.deletions, stats.churn]) {
      expect(m.status).toBe('unavailable');
      expect(m.value).toBeNull();
      expect(m.reason).toBe('perforce has no measured primitive for this');
    }
  });

  it("churn's provenance is 'derived' even on a refusal, never 'backend_observed'", () => {
    const stats = backendChangeStats('diversion', {
      ok: false,
      reason: 'unavailable',
      detail: 'no primitive',
    });
    expect(stats.churn.provenance).toBe('derived');
    expect(stats.changedFiles.provenance).toBe('backend_observed');
    expect(stats.additions.provenance).toBe('backend_observed');
    expect(stats.deletions.provenance).toBe('backend_observed');
  });
});

describe('backendChangeStats — status derivation (RUN-244)', () => {
  it('zero counted files is complete/0, never unavailable — a zero never means unknown', () => {
    const stats = backendChangeStats(
      'git',
      ok({ changedFiles: 0, lines: { additions: 0, deletions: 0, uncountableFiles: 0 } }),
    );
    expect(stats.changedFiles).toMatchObject({ status: 'complete', value: 0 });
    expect(stats.additions).toMatchObject({ status: 'complete', value: 0 });
    expect(stats.deletions).toMatchObject({ status: 'complete', value: 0 });
    expect(stats.churn).toMatchObject({ status: 'complete', value: 0 });
  });

  it('counted files but no line primitive at all: changedFiles complete, lines unavailable', () => {
    const stats = backendChangeStats('diversion', ok({ changedFiles: 3, lines: null }));
    expect(stats.changedFiles).toMatchObject({ status: 'complete', value: 3 });
    expect(stats.additions.status).toBe('unavailable');
    expect(stats.deletions.status).toBe('unavailable');
    expect(stats.churn.status).toBe('unavailable');
    expect(stats.additions.value).toBeNull();
  });

  it('every changed file also uncountable for lines collapses to the same unavailable shape as lines:null', () => {
    const viaNull = backendChangeStats('diversion', ok({ changedFiles: 4, lines: null }));
    const viaAllUncountable = backendChangeStats(
      'diversion',
      ok({ changedFiles: 4, lines: { additions: 0, deletions: 0, uncountableFiles: 4 } }),
    );
    expect(viaAllUncountable.additions.status).toBe('unavailable');
    expect(viaAllUncountable.deletions.status).toBe('unavailable');
    expect(viaAllUncountable.churn.status).toBe('unavailable');
    expect(viaNull.additions.status).toBe(viaAllUncountable.additions.status);
    expect(viaNull.churn.status).toBe(viaAllUncountable.churn.status);
  });

  it('counted some files, not others: line metrics partial, changedFiles stays complete', () => {
    const stats = backendChangeStats(
      'git',
      ok({ changedFiles: 7, lines: { additions: 10, deletions: 4, uncountableFiles: 2 } }),
    );
    expect(stats.changedFiles).toMatchObject({ status: 'complete', value: 7 });
    expect(stats.additions).toMatchObject({ status: 'partial', value: 10 });
    expect(stats.deletions).toMatchObject({ status: 'partial', value: 4 });
    expect(stats.churn).toMatchObject({ status: 'partial', value: 14 });
  });

  it('fully countable files: everything complete', () => {
    const stats = backendChangeStats(
      'git',
      ok({ changedFiles: 5, lines: { additions: 20, deletions: 3, uncountableFiles: 0 } }),
    );
    expect(stats.additions.status).toBe('complete');
    expect(stats.deletions.status).toBe('complete');
    expect(stats.churn.status).toBe('complete');
  });
});

describe('backendChangeStats — churn is derived, never asserted independently (RUN-244)', () => {
  it('churn always equals additions + deletions', () => {
    const stats = backendChangeStats(
      'git',
      ok({ changedFiles: 2, lines: { additions: 8, deletions: 5, uncountableFiles: 0 } }),
    );
    expect(stats.churn.value).toBe(stats.additions.value! + stats.deletions.value!);
    expect(stats.churn.provenance).toBe('derived');
    expect(stats.additions.provenance).toBe('backend_observed');
    expect(stats.deletions.provenance).toBe('backend_observed');
  });

  it('churn from a single addition and no deletions is exactly that addition', () => {
    const stats = backendChangeStats(
      'git',
      ok({ changedFiles: 1, lines: { additions: 1, deletions: 0, uncountableFiles: 0 } }),
    );
    expect(stats.churn).toMatchObject({ status: 'complete', value: 1 });
  });

  it("churn's status is never stronger than the weaker of additions/deletions — the partial case", () => {
    // additions and deletions share one uncountable-files count, so they are counted (or not)
    // together and are always the SAME strength — this pins that churn cannot come out 'complete'
    // when either component is 'partial'.
    const stats = backendChangeStats(
      'git',
      ok({ changedFiles: 5, lines: { additions: 0, deletions: 0, uncountableFiles: 2 } }),
    );
    expect(stats.additions.status).toBe('partial');
    expect(stats.deletions.status).toBe('partial');
    expect(stats.churn.status).toBe('partial');
    // The misleading edge this task's spec calls out by name: a partial 0 is not "no churn" — it
    // is "no churn among the files we could measure", which is why the status must stay 'partial'
    // rather than 'complete' even though the observed value alone looks identical to a real zero.
    expect(stats.churn.value).toBe(0);
  });
});

describe('backendChangeStats — the envelope’s numeric domain (RUN-244)', () => {
  // Measured, not assumed: NaN / fractional / negative all satisfy `ChangeStats`'s plain `number`
  // fields and all FAIL `BackendChangeStats.safeParse`, and a failed refine at the ingest discards
  // the whole episode row behind an HTTP 200. `git diff --numstat` prints `-` for a binary file's
  // counts and `Number('-')` is NaN, so this is RUN-245's parser one missing branch away.
  const badValues: Array<[string, number]> = [
    ['NaN', Number.NaN],
    ['fractional', 1.5],
    ['negative', -3],
    ['Infinity', Number.POSITIVE_INFINITY],
  ];

  for (const [label, bad] of badValues) {
    it(`an out-of-domain ${label} addition degrades to unavailable rather than shipping it`, () => {
      const stats = backendChangeStats(
        'git',
        ok({ changedFiles: 2, lines: { additions: bad, deletions: 4, uncountableFiles: 0 } }),
      );
      expect(stats.additions).toMatchObject({ status: 'unavailable', value: null });
      expect(stats.additions.reason).toContain(String(bad));
      // The deletion count was fine and is still reported — degradation is per-metric, not wholesale.
      expect(stats.deletions).toMatchObject({ status: 'complete', value: 4 });
      // But churn is a SUM: one unknown addend makes it a different quantity, not a partial one.
      expect(stats.churn).toMatchObject({ status: 'unavailable', value: null });
      expect(BackendChangeStats.safeParse(stats).success).toBe(true);
    });
  }

  it('an out-of-domain uncountable-file count voids the whole line block, not one field', () => {
    const stats = backendChangeStats(
      'git',
      ok({ changedFiles: 5, lines: { additions: 10, deletions: 2, uncountableFiles: Number.NaN } }),
    );
    // additions/deletions are individually in-domain, but nothing says how much of the measurement
    // to trust, and 'complete'/'partial' are exactly the claim that number underwrites.
    expect(stats.additions.status).toBe('unavailable');
    expect(stats.deletions.status).toBe('unavailable');
    expect(stats.churn.status).toBe('unavailable');
    expect(stats.changedFiles).toMatchObject({ status: 'complete', value: 5 });
  });

  it('an out-of-domain changed-file count degrades alone, leaving usable line counts intact', () => {
    const stats = backendChangeStats(
      'git',
      ok({ changedFiles: -1, lines: { additions: 3, deletions: 1, uncountableFiles: 0 } }),
    );
    expect(stats.changedFiles).toMatchObject({ status: 'unavailable', value: null });
    expect(stats.additions).toMatchObject({ status: 'complete', value: 3 });
    expect(stats.churn).toMatchObject({ status: 'complete', value: 4 });
    expect(BackendChangeStats.safeParse(stats).success).toBe(true);
  });
});

describe('backendChangeStats — output parses against the vendored contract (RUN-244)', () => {
  // The closest this repo can get to the real ingest: `BackendChangeStats` is the VENDORED schema,
  // imported not copied, so this catches a shape or domain violation for real rather than by pinning.
  // (The daemon-provenance ALLOWLIST is a different check and lives in its own file — see below.)
  const cases: ChangeStatsResult[] = [
    { ok: false, reason: 'unavailable', detail: 'no primitive' },
    ok({ changedFiles: 0, lines: { additions: 0, deletions: 0, uncountableFiles: 0 } }),
    ok({ changedFiles: 3, lines: null }),
    ok({ changedFiles: 4, lines: { additions: 0, deletions: 0, uncountableFiles: 4 } }),
    ok({ changedFiles: 7, lines: { additions: 10, deletions: 4, uncountableFiles: 2 } }),
    ok({ changedFiles: 5, lines: { additions: 20, deletions: 3, uncountableFiles: 0 } }),
  ];

  it.each(cases.map((c, i) => [i, c] as const))('case %i parses', (_i, result) => {
    const parsed = BackendChangeStats.safeParse(backendChangeStats('git', result));
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});

// The ingest floor (DAEMON_PROVENANCE/DAEMON_SOURCES/`acceptedAt === null`) is deliberately NOT
// re-checked here. `test/daemon-provenance.test.ts` holds the only copy of those allowlists in this
// repo and now covers this builder's refusal, complete and partial shapes — a second copy beside a
// second set of cases is exactly the silent drift that makes a pinned copy of a remote contract
// dangerous, so the floor stays in one file and this one tests the mapping.
