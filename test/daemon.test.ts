import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExecutionSpec, ProjectManifest, RunnerConfig } from '@noriq-dev/shared';
import type { Run } from '@noriq-dev/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContinuableStore } from '../src/continuable';
import type { ContinuableRun } from '../src/continuable';
import {
  Daemon,
  continuationLockScope,
  orphanSweep,
  owedMergeReconciler,
  shouldForwardRunStatus,
  telemetryFrame,
} from '../src/daemon';
import type { DaemonHandle } from '../src/daemon';
import { zeroTelemetry } from '../src/drivers/types';
import { ParkedStore } from '../src/parked';
import type { RunReport } from '../src/supervisor';
import type { WsFactory, WsSocket } from '../src/ws-client';

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
    expect(await resolve(run('run_1'), null)).toEqual(['src/a.ts']);
  });

  // A first sitting has no prior record — the layer must no-op, exactly as before it was bound.
  it('declares nothing for a run with no continuation record', async () => {
    expect(await continuationLockScope(store({}))(run('run_1'), null)).toBeNull();
  });

  it('declares nothing when the record carries no paths', async () => {
    const resolve = continuationLockScope(store({ run_1: entry() }));
    expect(await resolve(run('run_1'), null)).toBeNull();
  });

  it('treats an empty path list as no declaration, not an empty lock', async () => {
    const resolve = continuationLockScope(store({ run_1: entry({ changedPaths: [] }) }));
    expect(await resolve(run('run_1'), null)).toBeNull();
  });

  // A lock scope is an optimisation; a broken store must never gate a dispatch.
  it('degrades to no declaration when the store throws', async () => {
    const resolve = continuationLockScope({
      get: async () => {
        throw new Error('corrupt');
      },
    });
    expect(await resolve(run('run_1'), null)).toBeNull();
  });

  // RUN-142. The predictive layer's whole problem was that it only ever had a CONTINUATION's paths —
  // what a previous sitting touched — which by definition do not exist the first time a task is
  // attempted. A spec's `anticipatedFiles` is the first thing that declares, before any work, which
  // files a run intends to touch.
  describe('the lock scope a spec declares (RUN-142)', () => {
    const spec = (paths: string[]) =>
      ExecutionSpec.parse({ anticipatedFiles: paths.map((path) => ({ path })) });

    it('locks what a FIRST sitting declares, with no continuation record at all', async () => {
      const resolve = continuationLockScope(store({}));
      expect(await resolve(run('run_1'), spec(['src/a.ts', 'src/b.ts']))).toEqual(['src/a.ts', 'src/b.ts']);
    });

    // UNION, not preference: a continued run must not land on top of what its previous sitting
    // touched, and a spec written before that sitting cannot know about it.
    it('unions the declared scope with what the failed sitting changed', async () => {
      const resolve = continuationLockScope(store({ run_1: entry({ changedPaths: ['src/touched.ts'] }) }));
      expect(await resolve(run('run_1'), spec(['src/planned.ts']))).toEqual([
        'src/planned.ts',
        'src/touched.ts',
      ]);
    });

    it('does not double-lock a path both declared and touched', async () => {
      const resolve = continuationLockScope(store({ run_1: entry({ changedPaths: ['src/a.ts'] }) }));
      expect(await resolve(run('run_1'), spec(['src/a.ts']))).toEqual(['src/a.ts']);
    });

    it('still declares nothing when neither side has anything', async () => {
      expect(await continuationLockScope(store({}))(run('run_1'), spec([]))).toBeNull();
    });
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

// RUN-85. reconcileOwedMerges was untested wiring that reached `gh` directly — git-only, so a
// hand-written [land].mergeTarget on a Diversion/Perforce repo did NOTHING at plan completion,
// silently. Extracted (the orphanSweep treatment) and routed through the detected backend's
// openReview: the same fake-backend-plus-quiet-logger register as the sweep tests above.
describe('owedMergeReconciler (RUN-28/85)', () => {
  const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const plan = {
    planId: 'plan_1',
    planKey: 'alpha',
    planTitle: 'Runner v2',
    projectId: 'prj_run',
    repoRef: 'repo_1',
  };
  const manifest = ProjectManifest.parse({
    key: 'RUN',
    land: { branch: 'noriq/plan-<planKey>', mergeTarget: 'main', autoPush: true },
  });

  function fakeBackend(
    kind: string,
    over: {
      share?: { ok: true } | { ok: false; detail: string };
      review?: { ok: boolean; url?: string; detail?: string; command?: string };
    } = {},
  ) {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    return {
      calls,
      vcs: {
        kind,
        share: async (...args: unknown[]) => {
          calls.push({ method: 'share', args });
          return over.share ?? ({ ok: true } as const);
        },
        openReview: async (...args: unknown[]) => {
          calls.push({ method: 'openReview', args });
          return over.review ?? { ok: true, url: 'https://github.com/x/y/pull/7' };
        },
      },
    };
  }

  function harness(b: ReturnType<typeof fakeBackend>, over: { logger?: unknown } = {}) {
    const reports: unknown[] = [];
    const reconcile = owedMergeReconciler({
      owed: async () => [plan],
      repoFor: (ref) => (ref === 'repo_1' ? { root: '/repo' } : undefined),
      manifestFor: async () => manifest,
      vcsFor: () => b.vcs,
      report: async (r) => {
        reports.push(r);
      },
      logger: (over.logger ?? quiet) as never,
    });
    return { reconcile, reports };
  }

  it('git path: shares the resolved plan branch, opens review through the backend, reports the URL', async () => {
    const b = fakeBackend('git');
    const { reconcile, reports } = harness(b);
    await reconcile();
    expect(b.calls).toEqual([
      { method: 'share', args: ['/repo', 'noriq/plan-alpha'] },
      {
        method: 'openReview',
        args: ['/repo', { head: 'noriq/plan-alpha', base: 'main', planTitle: 'Runner v2', planKey: 'alpha' }],
      },
    ]);
    expect(reports).toEqual([{ planId: 'plan_1', url: 'https://github.com/x/y/pull/7', failed: null }]);
  });

  // The RUN-85 pin: the silent-nothing path no longer exists. A server-backed backend's honest
  // refusal is WARNED (naming the backend and, via its detail, where review happens) and
  // REPORTED as the failure detail — the plan does not stay owed invisibly.
  it('a non-git mergeTarget gets an explicit warn + reportMerge failure, never silence', async () => {
    const detail =
      'review happens in Diversion: merge branch noriq/plan-alpha into main in the ' +
      'Diversion app (repo dv.repo.test) — the daemon cannot open a Diversion merge request';
    const b = fakeBackend('diversion', { review: { ok: false, detail } });
    const warned: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    const { reconcile, reports } = harness(b, {
      logger: {
        ...quiet,
        warn: (msg: string, fields: Record<string, unknown>) => warned.push({ msg, fields }),
      },
    });
    await reconcile();
    // share still runs, unbranched — a server-backed share is a documented no-op {ok:true}.
    expect(b.calls.map((c) => c.method)).toEqual(['share', 'openReview']);
    expect(warned).toHaveLength(1);
    expect(warned[0]?.fields.backend).toBe('diversion');
    expect(warned[0]?.fields.detail).toBe(detail);
    expect(reports).toEqual([{ planId: 'plan_1', url: null, failed: detail }]);
  });

  it('a failed share reports and never reaches openReview — a PR against a stale remote is worse than none', async () => {
    const b = fakeBackend('git', { share: { ok: false, detail: 'offline' } });
    const { reconcile, reports } = harness(b);
    await reconcile();
    expect(b.calls.map((c) => c.method)).toEqual(['share']);
    expect(reports).toEqual([{ planId: 'plan_1', failed: 'push failed: offline' }]);
  });

  it('a repo that never asked for merge requests is skipped without touching the backend', async () => {
    const b = fakeBackend('git');
    const reports: unknown[] = [];
    const reconcile = owedMergeReconciler({
      owed: async () => [plan],
      repoFor: () => ({ root: '/repo' }),
      manifestFor: async () => ProjectManifest.parse({ key: 'RUN' }), // no [land] at all
      vcsFor: () => b.vcs,
      report: async (r) => {
        reports.push(r);
      },
      logger: quiet as never,
    });
    await reconcile();
    expect(b.calls).toEqual([]);
    expect(reports).toEqual([]);
  });

  it('an unreachable server yields an empty round, not a throw — the next reconnect asks again', async () => {
    const b = fakeBackend('git');
    const reconcile = owedMergeReconciler({
      owed: async () => {
        throw new Error('ECONNREFUSED');
      },
      repoFor: () => ({ root: '/repo' }),
      manifestFor: async () => manifest,
      vcsFor: () => b.vcs,
      report: async () => {},
      logger: quiet as never,
    });
    await expect(reconcile()).resolves.toBeUndefined();
    expect(b.calls).toEqual([]);
  });
});

// RUN-173. RUN-172 made the executed-spec record an append-only history and fixed its delivery, but
// its RETENTION half — that the daemon holds the record until a frame carrying it actually leaves
// the socket — lived in the `report` closure inside `daemon.start()` with no way to reach it. The
// property is delicate: a down socket still sets `held.ws`, so keying the clear on its presence
// (the pre-RUN-173 code) counted a dropped frame as a delivery and lost the record with nothing to
// correct it. These drive a real `start()` with a fake WsFactory and a fake fetch — no socket, no
// HTTP, no ~/.noriq — capture the wired-up `report`, and exercise the retention directly.
describe('daemon.start() executed-spec retention (RUN-173)', () => {
  // A socket that records what it is handed — or throws, modelling a down link, which is exactly how
  // `sendRaw` observes a frame that never left. `deliver` flips between frames to bring it up/down.
  class FakeDaemonSocket implements WsSocket {
    sent: string[] = [];
    deliver = true;
    private readonly listeners = new Map<string, Array<(...a: unknown[]) => void>>();
    constructor(
      readonly url: string,
      readonly headers: Record<string, string>,
    ) {}
    on(event: string, listener: (...a: unknown[]) => void): void {
      const arr = this.listeners.get(event) ?? [];
      arr.push(listener);
      this.listeners.set(event, arr);
    }
    send(data: string): void {
      if (!this.deliver) throw new Error('socket down'); // ws throws when it cannot queue — sendRaw catches → false
      this.sent.push(data);
    }
    close(): void {
      for (const cb of this.listeners.get('close') ?? []) cb();
    }
    telemetry(): Array<Record<string, unknown>> {
      return this.sent
        .map((s) => JSON.parse(s) as Record<string, unknown>)
        .filter((m) => m.type === 'run.telemetry');
    }
  }

  const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;
  const spec = ExecutionSpec.parse({ anticipatedFiles: [{ path: 'src/a.ts', action: 'modify' }] });
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  let tmp: string;
  const handles: DaemonHandle[] = [];
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'noriq-daemon-'));
  });
  afterEach(async () => {
    for (const h of handles.splice(0)) await h.stop().catch(() => {});
    await rm(tmp, { recursive: true, force: true });
  });

  // A config with NO scan roots: discovery is a no-op and the orphan sweep trivial, so start() never
  // touches a real repo. Built through the contract so budget/update carry their real defaults, then
  // the roots are emptied (the schema demands ≥1, which parse would reject).
  const config = (): RunnerConfig => ({
    ...RunnerConfig.parse({
      label: 'test',
      server: 'https://noriq.example',
      scanRoots: ['/unused'],
      tools: ['claude'],
      update: { check: false }, // no version-check fetch or timer
    }),
    scanRoots: [],
  });

  // A fetch that answers registration and owed-merges off-line — never a real host. Records the
  // paths it saw so a test can assert start() issued no request it did not fake.
  function fakeFetch(calls: string[]): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      let body: unknown = {};
      if (new URL(url).pathname === '/api/runners' && (init?.method ?? 'GET') === 'POST') {
        body = {
          runner: {
            id: 'rnr_test',
            projectId: null,
            label: 'test',
            status: 'online',
            capabilities: { tools: ['claude'], kinds: ['build'], maxConcurrency: 1 },
            repos: [],
            freeSlots: 1,
            lastHeartbeatAt: null,
            createdAt: '2026-07-28T00:00:00.000Z',
          },
        };
      } else if (url.includes('/owed-merges')) {
        body = { owed: [] };
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
  }

  // Drive start() with every seam faked, capturing the `report` callback the daemon wires into the
  // supervisor — the closure under test. The supervisor itself is a stub: no run is dispatched, so
  // supervise/resume never fire, but expireStaleParks runs at startup and must answer.
  async function harness() {
    const sockets: FakeDaemonSocket[] = [];
    const connect: WsFactory = (url, headers) => {
      const s = new FakeDaemonSocket(url, headers);
      sockets.push(s);
      return s;
    };
    const calls: string[] = [];
    let report!: (runId: string, rep: RunReport) => void;
    const daemon = new Daemon(config(), 'tok', {
      logger: quiet,
      connect,
      fetchImpl: fakeFetch(calls),
      parked: new ParkedStore(path.join(tmp, 'parked.json')),
      continuable: new ContinuableStore(path.join(tmp, 'continuable.json')),
      stateFile: path.join(tmp, 'state.json'),
      createSupervisor: (deps) => {
        report = deps.report;
        return { supervise: async () => ({}), resume: async () => null, expireStaleParks: async () => 0 };
      },
    });
    const handle = await daemon.start();
    handles.push(handle);
    await tick(); // let WsClient.open() resolve the token and set its socket
    return { handle, sockets, calls, report };
  }

  it('drives start() to completion with a fake WsFactory and no real socket or HTTP', async () => {
    const { handle, sockets, calls } = await harness();
    expect(handle.runnerId).toBe('rnr_test');
    // One fake socket, constructed by the injected factory — never a real ws dial.
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe('wss://noriq.example/ws/runner/rnr_test');
    // Registration went through the fake fetch; nothing hit a real endpoint.
    expect(calls).toContain('POST /api/runners');
    expect(
      calls.every(
        (c) => c.startsWith('POST /api/runners') || c.includes('/owed-merges') || c.includes('/heartbeat'),
      ),
    ).toBe(true);
  });

  it('retains the record when the frame does not leave, then delivers and clears it on a live send', async () => {
    const { sockets, report } = await harness();
    const s = sockets[0]!;

    // Socket down: the spec resolves, the report is made, but the telemetry frame throws on send.
    s.deliver = false;
    report('run_1', { status: 'running', executedSpec: spec });
    expect(s.telemetry()).toHaveLength(0); // nothing left the socket

    // Socket up: a later tick that itself carries NO spec must still deliver the HELD one.
    s.deliver = true;
    report('run_1', { status: 'running', telemetry: { ...zeroTelemetry(), inputTokens: 10 } });
    const delivered = s.telemetry();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.executedSpec).toMatchObject({ anticipatedFiles: [{ path: 'src/a.ts' }] });

    // Cleared: the next successful tick carries null, proving the daemon no longer holds it.
    report('run_1', { status: 'running', telemetry: { ...zeroTelemetry(), inputTokens: 20 } });
    expect(s.telemetry()).toHaveLength(2);
    expect(s.telemetry()[1]!.executedSpec).toBeNull();
  });

  it('drops the pending record on a terminal status even when it never delivered', async () => {
    const { sockets, report } = await harness();
    const s = sockets[0]!;

    // Retained (send fails), then the run fails while the socket is still down — never delivered.
    s.deliver = false;
    report('run_2', { status: 'running', executedSpec: spec });
    report('run_2', { status: 'failed' });
    expect(s.telemetry()).toHaveLength(0);

    // Socket restored: a subsequent live tick carries null — the terminal status dropped the record.
    s.deliver = true;
    report('run_2', { status: 'running', telemetry: { ...zeroTelemetry(), inputTokens: 5 } });
    const delivered = s.telemetry();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.executedSpec).toBeNull();
  });

  it('a delivered record is also gone once the run reaches a terminal status', async () => {
    const { sockets, report } = await harness();
    const s = sockets[0]!;

    // Delivered live (frame carries the spec, cleared on success), then the run completes.
    report('run_3', { status: 'running', executedSpec: spec });
    expect(s.telemetry()[0]!.executedSpec).toMatchObject({ anticipatedFiles: [{ path: 'src/a.ts' }] });
    report('run_3', { status: 'done', exit: { outcome: 'done' } });

    // A stray later tick for the same run carries null — nothing lingers past terminal.
    report('run_3', { status: 'running', telemetry: { ...zeroTelemetry(), inputTokens: 7 } });
    expect(s.telemetry().at(-1)!.executedSpec).toBeNull();
  });
});
