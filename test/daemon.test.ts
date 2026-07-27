import type { Run } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import type { ContinuableRun } from '../src/continuable';
import { continuationLockScope, orphanSweep, shouldForwardRunStatus, telemetryFrame } from '../src/daemon';
import { zeroTelemetry } from '../src/drivers/types';

// The daemon's report→frame gate. Untested until now, which is how the same bug shipped
// twice: a frame carrying new facts under an UNCHANGED status gets silently dropped, and
// nothing anywhere errors — the dashboard just never learns the fact.
describe('shouldForwardRunStatus', () => {
  it('forwards a genuine transition', () => {
    expect(shouldForwardRunStatus('running', { status: 'done' })).toBe(true);
    expect(shouldForwardRunStatus(undefined, { status: 'running' })).toBe(true);
  });

  it('drops a pure repeat — telemetry re-reports running on every tick', () => {
    expect(shouldForwardRunStatus('running', { status: 'running' })).toBe(false);
  });

  it('forwards agentId even when the status did not change (RUN-43)', () => {
    // The supervisor reports `running` with the worktree, then `running` AGAIN once the
    // agent exists. On a change-only test the second frame vanishes and run.status.agentId
    // stays null forever — reintroducing, one layer down, the exact bug RUN-43 fixes.
    expect(shouldForwardRunStatus('running', { status: 'running', agentId: 'agt_1' })).toBe(true);
  });

  it('forwards the worktree path and the terminal exit under an unchanged status', () => {
    expect(shouldForwardRunStatus('running', { status: 'running', worktreePath: '/wt' })).toBe(true);
    expect(shouldForwardRunStatus('done', { status: 'done', exit: { outcome: 'done' } })).toBe(true);
  });
});

// The mix's null-vs-clear semantics (RUN-59): a stale mix must be retractable, so an unattributable
// telemetry frame sends {} (an explicit clear the server stores), NOT null (which COALESCE keeps).
describe('telemetryFrame', () => {
  const mix = {
    'claude-opus-4-8': {
      inputTokens: 100,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0.5,
    },
  };

  it('carries the mix when the telemetry attributes spend by model', () => {
    const f = telemetryFrame({
      telemetry: { ...zeroTelemetry(), inputTokens: 100, costUsd: 0.5, modelUsage: mix },
    });
    expect(f).toEqual({ tokensUsed: 100, usdSpent: 0.5, modelUsage: mix });
  });

  it('sends {} — an explicit clear — when telemetry has spend but NO mix, never null', () => {
    // The bug: a codex reviewer after a claude build spends tokens the mix cannot attribute. null
    // would COALESCE-keep the build's stale opus-only mix beside a climbing total; {} clears it.
    const f = telemetryFrame({ telemetry: { ...zeroTelemetry(), inputTokens: 220 } });
    expect(f.tokensUsed).toBe(220);
    expect(f.modelUsage).toEqual({}); // NOT null — the stored mix is retracted
    expect(f.modelUsage).not.toBeNull();
  });

  it('sends null (no news) only for a phase-only tick with no telemetry', () => {
    const f = telemetryFrame({ telemetry: undefined });
    expect(f).toEqual({ tokensUsed: null, usdSpent: null, modelUsage: null });
  });
});

// RUN-130. `resolveLockScope` shipped in RUN-103 and was never bound in daemon.ts — only tests
// ever supplied one, so the predictive layer never ran in production. These cover the source that
// closed it, for the reason this file exists: an untested lambda in the wiring is how that
// happened in the first place.
describe('continuationLockScope', () => {
  const run = (id: string) => ({ id }) as Run;
  const store = (entries: Record<string, ContinuableRun>) => ({
    get: async (runId: string) => entries[runId] ?? null,
  });
  const entry = (over: Partial<ContinuableRun> = {}): ContinuableRun => ({
    runId: 'run_1',
    spent: { tokens: 0, usd: 0 },
    ledger: [],
    failedAt: '2026-07-26T00:00:00.000Z',
    ...over,
  });

  it('declares the paths the failed sitting changed', async () => {
    const resolve = continuationLockScope(store({ run_1: entry({ changedPaths: ['src/a.ts'] }) }));
    expect(await resolve(run('run_1'))).toEqual(['src/a.ts']);
  });

  // A first sitting has no prior record — the layer must no-op, exactly as before it was bound.
  it('declares nothing for a run with no continuation record', async () => {
    expect(await continuationLockScope(store({}))(run('run_1'))).toBeNull();
  });

  it('declares nothing when the record carries no paths', async () => {
    const resolve = continuationLockScope(store({ run_1: entry() }));
    expect(await resolve(run('run_1'))).toBeNull();
  });

  it('treats an empty path list as no declaration, not an empty lock', async () => {
    const resolve = continuationLockScope(store({ run_1: entry({ changedPaths: [] }) }));
    expect(await resolve(run('run_1'))).toBeNull();
  });

  // A lock scope is an optimisation; a broken store must never gate a dispatch.
  it('degrades to no declaration when the store throws', async () => {
    const resolve = continuationLockScope({
      get: async () => {
        throw new Error('corrupt');
      },
    });
    expect(await resolve(run('run_1'))).toBeNull();
  });
});

// RUN-153. `reapOrphans` ran only at daemon START, so a workspace deliberately KEPT mid-flight —
// a lock refusal on one holding work (RUN-130), or one kept because its `hasWork` probe merely
// errored (RUN-152) — survived until a restart. The second has no continuation record, so nothing
// would ever adopt it. Extracted and tested for the same reason the two above are: this file's
// wiring is where a whole layer once shipped silently dead.
describe('orphanSweep', () => {
  const backend = (managed: string[]) => {
    const reaped: string[] = [];
    return {
      reaped,
      vcs: {
        reapOrphans: async (
          _root: string,
          opts?: { onSkip?: (p: string) => void; isOwned?: (runId: string) => boolean },
        ) => {
          for (const runId of managed) {
            if (opts?.isOwned?.(runId)) continue;
            reaped.push(runId);
          }
          return reaped.length;
        },
      },
    };
  };
  const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const none = async () => [];

  it('sweeps a leaked workspace no run will come back for', async () => {
    const b = backend(['run_leaked']);
    const sweep = orphanSweep({
      repos: [{ root: '/repo' }],
      vcsFor: () => b.vcs,
      isActive: () => false,
      reserved: none,
      logger: quiet as never,
    });
    expect((await sweep(true)).reaped).toBe(1);
    expect(b.reaped).toEqual(['run_leaked']);
  });

  // The one that matters on a timer: at startup every prior process is dead, so this question
  // never arises. Mid-flight, reaping a live run destroys the work it is in the middle of.
  it('never touches a workspace a live run is supervising', async () => {
    const b = backend(['run_live', 'run_leaked']);
    const active = new Set(['run_live']);
    const sweep = orphanSweep({
      repos: [{ root: '/repo' }],
      vcsFor: () => b.vcs,
      isActive: (id) => active.has(id),
      reserved: none,
      logger: quiet as never,
    });
    await sweep(true);
    expect(b.reaped).toEqual(['run_leaked']);
  });

  // The data loss this sweep would otherwise INTRODUCE. A parked run (RUN-30) and a continuable
  // failure (RUN-91) both hold a worktree while nothing supervises them — they are not in the
  // active set by definition, and the reap's work-bearing check cannot save them either: a park
  // can be pristine (a scope run that asked before writing) and a continuation kept after an
  // uncertain probe may hold no diff at all. Reaping one deletes the checkout its resume is
  // coming home to.
  it('never touches a workspace that is being HELD for a run nobody is supervising', async () => {
    const b = backend(['run_parked', 'run_continuable', 'run_leaked']);
    const sweep = orphanSweep({
      repos: [{ root: '/repo' }],
      vcsFor: () => b.vcs,
      isActive: () => false, // nothing running — the whole point
      reserved: async () => ['run_parked', 'run_continuable'],
      logger: quiet as never,
    });
    await sweep(true);
    expect(b.reaped).toEqual(['run_leaked']);
  });

  // Startup is where this bites hardest: `active` is necessarily empty, so without the held set
  // the very first sweep of a fresh daemon deletes every park it was restarted to honour.
  it('honours held runs on the STARTUP sweep too, where nothing is ever active', async () => {
    const b = backend(['run_parked']);
    const sweep = orphanSweep({
      repos: [{ root: '/repo' }],
      vcsFor: () => b.vcs,
      isActive: () => false,
      reserved: async () => ['run_parked'],
      logger: quiet as never,
    });
    await sweep(false);
    expect(b.reaped).toEqual([]);
  });

  // A store that will not read is not a store with nothing in it. Sweeping on that assumption is
  // how the reaper deletes the one worktree a parked run is waiting for.
  it('skips the sweep entirely when it cannot read what is being held', async () => {
    const b = backend(['run_leaked']);
    const sweep = orphanSweep({
      repos: [{ root: '/repo' }],
      vcsFor: () => b.vcs,
      isActive: () => false,
      reserved: async () => {
        throw new Error('EACCES: ~/.noriq/parked-runs.json');
      },
      logger: quiet as never,
    });
    expect(await sweep(true)).toEqual({ reaped: 0, kept: [] });
    expect(b.reaped).toEqual([]); // nothing touched, not even the genuine leak
  });

  it('sweeps every repo, and one repo failing does not skip the rest', async () => {
    const ok = backend(['run_leaked']);
    const sweep = orphanSweep({
      repos: [{ root: '/broken' }, { root: '/fine' }],
      vcsFor: (root) =>
        root === '/broken'
          ? {
              reapOrphans: async () => {
                throw new Error('fatal: not a git repository');
              },
            }
          : ok.vcs,
      isActive: () => false,
      reserved: none,
      logger: quiet as never,
    });
    expect((await sweep(true)).reaped).toBe(1); // the healthy repo was still swept
    expect(ok.reaped).toEqual(['run_leaked']);
  });

  // A kept workspace is reported ONCE, at startup. Repeating it every half hour turns the one
  // warning that means "your work is over there" into noise an operator learns to scroll past.
  it('reports work-bearing keeps at startup but not on every periodic sweep', async () => {
    const vcs = {
      reapOrphans: async (_root: string, opts?: { onSkip?: (p: string) => void }) => {
        opts?.onSkip?.('/wt/run_kept');
        return 0;
      },
    };
    const warned: string[] = [];
    const sweep = orphanSweep({
      repos: [{ root: '/repo' }],
      vcsFor: () => vcs,
      isActive: () => false,
      reserved: none,
      logger: { ...quiet, warn: (m: string) => warned.push(m) } as never,
    });

    expect((await sweep(false)).kept).toEqual(['/wt/run_kept']);
    expect(warned).toHaveLength(1);
    await sweep(true);
    expect(warned).toHaveLength(1); // still kept, still reported by the return — just not re-warned
  });
});
