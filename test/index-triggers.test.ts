import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexCoordinator, IndexTarget } from '../src/index-coordinator';
import type { ResolvedIndexConfig } from '../src/index-policy';
import { DEFAULT_DEBOUNCE_MS, IndexTriggerHub } from '../src/index-triggers';
import type { IndexTriggerHubDeps, IndexTriggerRepo } from '../src/index-triggers';
import type { CurrentBaseResult, VcsBackend } from '../src/vcs/types';

// RUN-222. This suite proves what THIS layer owns: debouncing/coalescing triggers into calls to
// `IndexCoordinator.trigger`, computing `currentBaseId` cheaply via `VcsBackend.currentBase`, the
// enabled/off gate short-circuiting before any VCS call, and the shared poll ticker's bound. What
// `reconcile` decides once triggered (unchanged/incremental/full) is index-coordinator.test.ts's
// job, not this file's — a fake coordinator here just records what it was asked.

const CONFIG: ResolvedIndexConfig = {
  languages: ['typescript'],
  contentMode: 'full',
  maxFiles: 100,
  maxFileBytes: 1_000_000,
  maxTotalBytes: 10_000_000,
  readDeadlineMs: 60_000,
  pollIntervalMinutes: 60,
  include: [],
  exclude: [],
};

const REPO = (over: Partial<IndexTriggerRepo> = {}): IndexTriggerRepo => ({
  repoRoot: '/repo/a',
  repositoryKey: 'my-repo',
  checkoutId: 'repo_a',
  projectId: 'prj_1',
  projectKey: 'RUN',
  defaultBranch: 'main',
  ...over,
});

function fakeCoordinator() {
  const calls: IndexTarget[] = [];
  const coordinator: Pick<IndexCoordinator, 'trigger'> = {
    trigger: async (target) => {
      calls.push(target);
    },
  };
  return { coordinator, calls };
}

function fakeVcs(
  opts: {
    currentBase?: (repoRoot: string, branch?: string) => CurrentBaseResult | Promise<CurrentBaseResult>;
  } = {},
) {
  const calls: Array<{ repoRoot: string; branch?: string }> = [];
  const vcs: Pick<VcsBackend, 'currentBase'> = {
    currentBase: async (repoRoot, branch) => {
      calls.push({ repoRoot, branch });
      return opts.currentBase ? opts.currentBase(repoRoot, branch) : { ok: true, baseId: 'base-1' };
    },
  };
  return { vcs, calls };
}

const quiet = { info() {}, warn() {}, error() {}, debug() {} } as unknown as IndexTriggerHubDeps['logger'];

function makeHub(over: {
  repos?: IndexTriggerRepo[];
  configFor?: (repoRoot: string) => ResolvedIndexConfig | null;
  vcs?: ReturnType<typeof fakeVcs>;
  coordinator?: ReturnType<typeof fakeCoordinator>;
  debounceMs?: number;
  pollTickMs?: number;
}) {
  const repos = over.repos ?? [REPO()];
  const configFor = over.configFor ?? (() => CONFIG);
  const vcs = over.vcs ?? fakeVcs();
  const coordinator = over.coordinator ?? fakeCoordinator();
  const hub = new IndexTriggerHub({
    server: 'https://noriq.test',
    coordinator: coordinator.coordinator,
    vcsFor: () => vcs.vcs,
    resolveConfig: async (root) => configFor(root),
    repos,
    debounceMs: over.debounceMs,
    pollTickMs: over.pollTickMs,
    logger: quiet,
  });
  return { hub, vcs, coordinator, repos };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('reconcileOnStartup', () => {
  it('reconciles every enabled repo once, with a cheap currentBase check and no lease', async () => {
    const { hub, vcs, coordinator } = makeHub({});
    await hub.reconcileOnStartup();
    expect(vcs.calls).toEqual([{ repoRoot: '/repo/a', branch: 'main' }]);
    // Debounced like every other trigger (discretion: startup is not exempt from the same quiet
    // window) — the coordinator sees it once the window elapses.
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    expect(coordinator.calls).toHaveLength(1);
    expect(coordinator.calls[0]).toMatchObject({
      server: 'https://noriq.test',
      projectId: 'prj_1',
      repositoryKey: 'my-repo',
      checkoutId: 'repo_a',
      projectKey: 'RUN',
      repoRoot: '/repo/a',
      currentBaseId: 'base-1',
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    expect(coordinator.calls).toHaveLength(1); // no duplicate fires
  });

  it('a repo with indexing off costs neither a currentBase call nor a coordinator trigger', async () => {
    const { hub, vcs, coordinator } = makeHub({ configFor: () => null });
    await hub.reconcileOnStartup();
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    expect(vcs.calls).toEqual([]);
    expect(coordinator.calls).toEqual([]);
  });

  it('an unknown current base fires no trigger for that repo — never a fabricated one', async () => {
    const { hub, coordinator } = makeHub({
      vcs: fakeVcs({ currentBase: () => ({ ok: false, reason: 'unknown', detail: 'no commits yet' }) }),
    });
    await hub.reconcileOnStartup();
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    expect(coordinator.calls).toEqual([]);
  });
});

describe('debounce (locked decision 9): a burst of triggers within the window produces ONE job, against the LATEST base', () => {
  it('three landings ten seconds apart (inside a 15s window) produce one coordinator.trigger call', async () => {
    const { hub, coordinator } = makeHub({});
    await hub.onLanded('/repo/a', 'main', 'sha-1');
    await vi.advanceTimersByTimeAsync(5_000);
    await hub.onLanded('/repo/a', 'main', 'sha-2');
    await vi.advanceTimersByTimeAsync(5_000);
    await hub.onLanded('/repo/a', 'main', 'sha-3');
    // Not yet fired — each new request resets the quiet window.
    expect(coordinator.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    expect(coordinator.calls).toHaveLength(1);
    expect(coordinator.calls[0]?.currentBaseId).toBe('sha-3'); // the LATEST base, not the first
  });

  it('two DIFFERENT repositories debounce independently — one job key each', async () => {
    const repos = [
      REPO({ repoRoot: '/repo/a', repositoryKey: 'repo-a' }),
      REPO({ repoRoot: '/repo/b', repositoryKey: 'repo-b', defaultBranch: 'main' }),
    ];
    const { hub, coordinator } = makeHub({ repos });
    await hub.onLanded('/repo/a', 'main', 'sha-a');
    await hub.onLanded('/repo/b', 'main', 'sha-b');
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    expect(coordinator.calls.map((c) => c.repositoryKey).sort()).toEqual(['repo-a', 'repo-b']);
  });
});

describe('onLanded (RUN-222 discretion): the landed sha is used directly on the default branch, never elsewhere', () => {
  it('uses land.ts’s own sha directly when the landed branch IS the repo’s defaultBranch — no currentBase call', async () => {
    const { hub, vcs, coordinator } = makeHub({});
    await hub.onLanded('/repo/a', 'main', 'landed-sha');
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    expect(vcs.calls).toEqual([]); // the sha was free — no VCS round trip needed
    expect(coordinator.calls[0]?.currentBaseId).toBe('landed-sha');
  });

  it('asks the cheap seam for the ACTUAL current base when the landed branch is NOT the default', async () => {
    const { hub, vcs, coordinator } = makeHub({
      vcs: fakeVcs({ currentBase: () => ({ ok: true, baseId: 'real-default-head' }) }),
    });
    await hub.onLanded('/repo/a', 'noriq/plan-x', 'plan-branch-sha');
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    expect(vcs.calls).toEqual([{ repoRoot: '/repo/a', branch: 'main' }]);
    expect(coordinator.calls[0]?.currentBaseId).toBe('real-default-head');
  });

  it('a landing for a repo this hub does not know about is silently ignored', async () => {
    const { hub, coordinator } = makeHub({});
    await hub.onLanded('/unknown/repo', 'main', 'sha');
    expect(coordinator.calls).toEqual([]);
  });

  it('an off repo landing triggers nothing', async () => {
    const { hub, vcs, coordinator } = makeHub({ configFor: () => null });
    await hub.onLanded('/repo/a', 'main', 'sha');
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    expect(vcs.calls).toEqual([]);
    expect(coordinator.calls).toEqual([]);
  });

  it('never throws even when the coordinator itself rejects — fire and forget', async () => {
    const coordinator: Pick<IndexCoordinator, 'trigger'> = {
      trigger: async () => {
        throw new Error('boom');
      },
    };
    const { hub } = makeHub({ coordinator: { coordinator, calls: [] } });
    await expect(hub.onLanded('/repo/a', 'main', 'sha')).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
  });
});

describe('requestManualReindex (discretion: RUN-223’s hook)', () => {
  it('bypasses the debounce window — fires immediately', async () => {
    const { hub, coordinator } = makeHub({});
    await hub.requestManualReindex('/repo/a');
    expect(coordinator.calls).toHaveLength(1); // no advanceTimers needed
  });

  it('cancels a pending debounced trigger and fires immediately in its place', async () => {
    const { hub, coordinator } = makeHub({});
    await hub.onLanded('/repo/a', 'main', 'debounced-sha');
    await hub.requestManualReindex('/repo/a');
    expect(coordinator.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    expect(coordinator.calls).toHaveLength(1); // the debounced one never separately fires
  });
});

describe('polling: bounded aggregate, one shared ticker', () => {
  it('one setInterval regardless of repo count', async () => {
    const spy = vi.spyOn(global, 'setInterval');
    const repos = Array.from({ length: 20 }, (_, i) =>
      REPO({ repoRoot: `/repo/${i}`, repositoryKey: `repo-${i}` }),
    );
    const { hub } = makeHub({ repos });
    hub.startPolling();
    expect(spy).toHaveBeenCalledTimes(1);
    hub.stop();
  });

  it('honours each repo’s own pollIntervalMinutes — a 1-minute repo fires on the second tick, a 60-minute one does not', async () => {
    const oneMinute: ResolvedIndexConfig = { ...CONFIG, pollIntervalMinutes: 1 };
    const sixtyMinutes: ResolvedIndexConfig = { ...CONFIG, pollIntervalMinutes: 60 };
    const repos = [
      REPO({ repoRoot: '/repo/fast', repositoryKey: 'fast' }),
      REPO({ repoRoot: '/repo/slow', repositoryKey: 'slow' }),
    ];
    const { hub, coordinator } = makeHub({
      repos,
      configFor: (root) => (root === '/repo/fast' ? oneMinute : sixtyMinutes),
      pollTickMs: 60_000,
    });
    hub.startPolling();
    // Tick 1 (t=60s): neither has a due-time recorded yet, so BOTH are considered due — this is
    // what seeds pollDue going forward (fast: +1min from here, slow: +60min from here).
    await vi.advanceTimersByTimeAsync(60_000 + DEFAULT_DEBOUNCE_MS);
    expect(coordinator.calls.map((c) => c.repositoryKey).sort()).toEqual(['fast', 'slow']);
    coordinator.calls.length = 0;
    // Tick 2 (t=120s): the 1-minute repo is due again (seeded at 60s + 1min = 120s); the
    // 60-minute one is not (seeded at 60s + 60min).
    await vi.advanceTimersByTimeAsync(60_000 + DEFAULT_DEBOUNCE_MS);
    expect(coordinator.calls.map((c) => c.repositoryKey)).toEqual(['fast']);
    hub.stop();
  });

  it('an off repo is never polled at all — no due-time bookkeeping, no currentBase call', async () => {
    const { hub, vcs, coordinator } = makeHub({ configFor: () => null, pollTickMs: 60_000 });
    hub.startPolling();
    await vi.advanceTimersByTimeAsync(60_000 * 5);
    expect(vcs.calls).toEqual([]);
    expect(coordinator.calls).toEqual([]);
    hub.stop();
  });
});

describe('stop()', () => {
  it('clears every PENDING debounce timer without firing it', async () => {
    const { hub, coordinator } = makeHub({});
    await hub.onLanded('/repo/a', 'main', 'sha');
    hub.stop();
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS * 2);
    expect(coordinator.calls).toEqual([]);
  });

  it('stops the poll ticker', async () => {
    const { hub, coordinator } = makeHub({ pollTickMs: 1_000 });
    hub.startPolling();
    hub.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(coordinator.calls).toEqual([]);
  });
});

describe('status accessors (discretion: in-memory only, no CLI/wire surface)', () => {
  it('records lastRequestedAt/lastRequestedReason and lastTriggeredAt once the debounce fires', async () => {
    const { hub } = makeHub({});
    expect(hub.statusOf('my-repo')).toBeUndefined();
    await hub.onLanded('/repo/a', 'main', 'sha');
    const mid = hub.statusOf('my-repo');
    expect(mid?.lastRequestedReason).toBe('landed');
    expect(mid?.lastRequestedAt).not.toBeNull();
    expect(mid?.lastTriggeredAt).toBeNull(); // debounce has not elapsed yet
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    expect(hub.statusOf('my-repo')?.lastTriggeredAt).not.toBeNull();
  });

  it('allStatuses lists every repository this hub has ever been asked about', async () => {
    const { hub } = makeHub({});
    await hub.reconcileOnStartup();
    expect(hub.allStatuses().map((s) => s.repositoryKey)).toEqual(['my-repo']);
  });
});
