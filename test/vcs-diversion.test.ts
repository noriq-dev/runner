import { describe, expect, it } from 'vitest';
import type { AgentDriver, DriverExit, DriverStartOptions } from '../src/drivers/types';
import { zeroTelemetry } from '../src/drivers/types';
import { RunSupervisor } from '../src/supervisor';
import { DiversionBackend, type DvCli, type DvHttp, dvMergeUrl } from '../src/vcs/diversion';

// The backend is orchestration over two injected transports — the API (merges, branches) and
// the CLI (anything that must materialize files, which is the sync agent's job). These tests
// pin the orchestration: the CAS in publish, the conflict shape in integrate, the pool-of-1
// lease. Server behaviour itself (202-on-conflict, races merged silently) was MEASURED against
// a real server in RUN-54 — VCS-SPIKE.md §9 — and the fakes model exactly what was measured.

interface Call {
  kind: 'http' | 'cli';
  what: string;
}

function fakes(over: {
  /** branch name → head commit id; mutated by merges. */
  branches?: Record<string, string>;
  /** Every POST /merges answers from this queue (status[, merge_id]); default: clean 201s. */
  mergeResponses?: Array<{ status: number; id?: string; merge_id?: string }>;
  /** GET /merges/{id} answers this. */
  mergeDetails?: unknown;
  /** What `dv status` prints. */
  status?: string;
  /** What `dv commit` prints (or an Error to throw). */
  commit?: string | Error;
  currentBranch?: string;
}) {
  const branches: Record<string, string> = over.branches ?? { main: 'dv.commit.10' };
  const mergeQueue = [...(over.mergeResponses ?? [])];
  const calls: Call[] = [];

  const http: DvHttp = async (method, apiPath) => {
    calls.push({ kind: 'http', what: `${method} ${apiPath}` });
    const branchGet = apiPath.match(/\/branches\/([^/?]+)$/);
    if (method === 'GET' && branchGet) {
      const name = decodeURIComponent(branchGet[1] ?? '');
      return branches[name]
        ? { status: 200, body: { commit_id: branches[name] } }
        : { status: 404, body: null };
    }
    if (method === 'GET' && apiPath.endsWith('/branches')) {
      return {
        status: 200,
        body: { items: Object.keys(branches).map((b) => ({ branch_name: b })) },
      };
    }
    if (method === 'POST' && apiPath.includes('/branches?')) {
      const name = decodeURIComponent(apiPath.match(/branch_name=([^&]+)/)?.[1] ?? '');
      const commit = decodeURIComponent(apiPath.match(/commit_id=([^&]+)/)?.[1] ?? '');
      branches[name] = commit;
      return { status: 201, body: { branch_id: name } };
    }
    if (method === 'POST' && apiPath.includes('/merges?')) {
      const next = mergeQueue.shift() ?? { status: 201, id: 'dv.commit.99' };
      if (next.status === 201) {
        // A real merge moves the base branch's head — model it so CAS re-checks see movement.
        const base = decodeURIComponent(apiPath.match(/base_id=([^&]+)/)?.[1] ?? '');
        branches[base] = next.id ?? 'dv.commit.99';
        return { status: 201, body: { id: next.id ?? 'dv.commit.99' } };
      }
      return { status: next.status, body: { merge_id: next.merge_id } };
    }
    if (method === 'GET' && apiPath.includes('/merges/')) {
      return { status: 200, body: over.mergeDetails ?? { conflicts: [] } };
    }
    throw new Error(`fake has no answer for ${method} ${apiPath}`);
  };

  const cli: DvCli = async (args) => {
    calls.push({ kind: 'cli', what: `dv ${args.join(' ')}` });
    if (args[0] === 'branch-name') return { stdout: `${over.currentBranch ?? 'main'}\n`, stderr: '' };
    if (args[0] === 'status')
      return { stdout: over.status ?? 'Your workspace has no changes.\n', stderr: '' };
    if (args[0] === 'commit') {
      if (over.commit instanceof Error) throw over.commit;
      return { stdout: over.commit ?? 'New commit ID: dv.commit.42\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  const backend = new DiversionBackend({ repoId: 'dv.repo.test', http, cli });
  return { backend, calls, branches };
}

describe('DiversionBackend — lease/dispose (the pool-of-1)', () => {
  it('leases: creates the run branch at the base head and checks it out locally', async () => {
    const { backend, calls } = fakes({});
    const ws = await backend.lease('/repo', 'run_1');
    expect(ws).toMatchObject({
      runId: 'run_1',
      localPath: '/repo',
      baseId: 'dv.commit.10',
      workRef: 'noriq/run/run_1',
      location: { repoId: 'dv.repo.test', branch: 'noriq/run/run_1', baseBranch: 'main' },
    });
    // The checkout is the sync agent's job — the API cannot materialize files.
    expect(calls.filter((c) => c.kind === 'cli').map((c) => c.what)).toContain(
      'dv checkout noriq/run/run_1 --discard-changes --ignore-shelf',
    );
  });

  it('a second lease WAITS until the first is disposed — one workspace, runs take turns', async () => {
    const { backend } = fakes({});
    const ws1 = await backend.lease('/repo', 'run_1');
    let secondLeased = false;
    const second = backend.lease('/repo', 'run_2').then((ws) => {
      secondLeased = true;
      return ws;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(secondLeased).toBe(false); // still held by run_1
    await backend.dispose(ws1);
    const ws2 = await second;
    expect(secondLeased).toBe(true);
    expect(ws2.workRef).toBe('noriq/run/run_2');
  });

  it('a lease that fails to set up releases the pool instead of wedging it', async () => {
    const { backend } = fakes({ branches: {} }); // no branches at all → lease throws
    await expect(backend.lease('/repo', 'run_1')).rejects.toThrow(/cannot lease from/);
    // The pool must not be poisoned by the failure:
    const { backend: ok } = fakes({});
    await expect(ok.lease('/repo', 'run_2')).resolves.toBeTruthy();
  });

  it('leases a verify run from the build run’s branch, by run id', async () => {
    const { backend } = fakes({
      branches: { main: 'dv.commit.10', 'noriq/run/run_build': 'dv.commit.20' },
    });
    const ws = await backend.lease('/repo', 'run_v', { fromRunId: 'run_build' });
    expect(ws.baseId).toBe('dv.commit.20');
  });

  it('dispose CLEANS and hands back — the run branch is deliberately left alive', async () => {
    const { backend, calls } = fakes({});
    const ws = await backend.lease('/repo', 'run_1');
    calls.length = 0;
    await backend.dispose(ws);
    expect(calls.map((c) => c.what)).toEqual(['dv checkout main --discard-changes --ignore-shelf']);
    // No DELETE /branches call: the branch is server-side, durable, team-visible history, and
    // may hold the only committed copy of unlanded work.
  });
});

describe('DiversionBackend — integrate (merge the target IN; no rebase exists)', () => {
  it('clean merge: ok, and the workspace is updated so verify sees the merged files', async () => {
    const { backend, calls } = fakes({ mergeResponses: [{ status: 201, id: 'dv.commit.30' }] });
    const ws = await backend.lease('/repo', 'run_1');
    calls.length = 0;
    expect(await backend.integrate(ws, 'main')).toEqual({ ok: true });
    expect(calls.map((c) => c.what)).toEqual([
      'POST /repos/dv.repo.test/merges?base_id=noriq%2Frun%2Frun_1&other_id=main',
      'dv update --conflict_resolution accept-incoming',
    ]);
  });

  it('conflict: paths from the merge object, plus the URL where a human resolves it', async () => {
    const { backend } = fakes({
      mergeResponses: [{ status: 202, merge_id: 'dv.merge.abc' }],
      mergeDetails: {
        conflicts: [
          { result: { path: 'src/a.ts' } },
          { other: { path: 'src/b.ts' } },
          { result: { path: 'src/a.ts' } }, // duplicates collapse
        ],
      },
    });
    const ws = await backend.lease('/repo', 'run_1');
    expect(await backend.integrate(ws, 'main')).toEqual({
      ok: false,
      conflicts: ['src/a.ts', 'src/b.ts'],
      resolveUrl: dvMergeUrl('dv.repo.test', 'dv.merge.abc'),
    });
  });

  it('resumeIntegrate NEVER succeeds — every Diversion conflict is a human conflict (§9)', async () => {
    const { backend } = fakes({
      mergeResponses: [{ status: 202, merge_id: 'dv.merge.abc' }],
      mergeDetails: { conflicts: [{ result: { path: 'src/a.ts' } }] },
    });
    const ws = await backend.lease('/repo', 'run_1');
    await backend.integrate(ws, 'main');
    const res = await backend.resumeIntegrate(ws);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.resolveUrl).toContain('dv.merge.abc');
  });
});

describe('DiversionBackend — publish carries the CAS the server does not have (§9)', () => {
  it('unmoved target: guard answers 200 (already current), then the landing merge runs', async () => {
    const { backend, calls } = fakes({
      mergeResponses: [
        { status: 200 }, // guard: run branch already contains target head → no movement
        { status: 201, id: 'dv.commit.50' }, // the landing merge
      ],
    });
    const ws = await backend.lease('/repo', 'run_1');
    calls.length = 0;
    expect(await backend.publish(ws, 'main')).toEqual({ ok: true, sha: 'dv.commit.50' });
    expect(calls.map((c) => c.what)).toEqual([
      'POST /repos/dv.repo.test/merges?base_id=noriq%2Frun%2Frun_1&other_id=main',
      'POST /repos/dv.repo.test/merges?base_id=main&other_id=noriq%2Frun%2Frun_1',
    ]);
  });

  it('moved target: guard answers 201 — the race Diversion itself would have merged silently', async () => {
    const { backend } = fakes({ mergeResponses: [{ status: 201, id: 'dv.commit.60' }] });
    const ws = await backend.lease('/repo', 'run_1');
    const res = await backend.publish(ws, 'main');
    expect(res).toMatchObject({ ok: false, reason: 'race' });
  });

  it('moved AND conflicting: an error naming the resolve URL, never a silent merge', async () => {
    const { backend } = fakes({ mergeResponses: [{ status: 202, merge_id: 'dv.merge.x' }] });
    const ws = await backend.lease('/repo', 'run_1');
    const res = await backend.publish(ws, 'main');
    expect(res).toMatchObject({ ok: false, reason: 'error' });
    if (!res.ok) expect(res.detail).toContain(dvMergeUrl('dv.repo.test', 'dv.merge.x'));
  });

  it('nothing to land: both sides already current → ok with the target head', async () => {
    const { backend } = fakes({ mergeResponses: [{ status: 200 }, { status: 200 }] });
    const ws = await backend.lease('/repo', 'run_1');
    expect(await backend.publish(ws, 'main')).toEqual({ ok: true, sha: 'dv.commit.10' });
  });
});

describe('DiversionBackend — the rest of the surface', () => {
  it('share is a no-op success: publishing already reached the server', async () => {
    const { backend, calls } = fakes({});
    expect(await backend.share('/repo', 'main')).toEqual({ ok: true });
    expect(calls).toEqual([]); // not even a network call
  });

  it('hasWork: uncommitted changes count, and so do commits past the lease base', async () => {
    const dirty = fakes({ status: 'Total modified paths: 1\nNew:\n\t a.txt\nModified:\n\t b.txt\n' });
    const ws1 = await dirty.backend.lease('/repo', 'run_1');
    expect(await dirty.backend.hasWork(ws1)).toBe(true);

    const clean = fakes({});
    const ws2 = await clean.backend.lease('/repo', 'run_1');
    expect(await clean.backend.hasWork(ws2)).toBe(false);
    clean.branches['noriq/run/run_1'] = 'dv.commit.77'; // agent committed → branch moved
    expect(await clean.backend.hasWork(ws2)).toBe(true);
  });

  it('checkpoint maps "nothing to commit" to false, not to a failure', async () => {
    const { backend } = fakes({ commit: new Error('No changes to commit') });
    const ws = await backend.lease('/repo', 'run_1');
    expect(await backend.checkpoint(ws, 'msg')).toBe(false);
  });

  it('reapOrphans destroys nothing — a dead run’s work is already durable server-side', async () => {
    const { backend } = fakes({
      branches: { main: 'dv.commit.10', 'noriq/run/run_dead': 'dv.commit.11' },
    });
    const kept: string[] = [];
    expect(await backend.reapOrphans('/repo', { onSkip: (p) => kept.push(p) })).toBe(0);
    expect(kept).toEqual(['noriq/run/run_dead']);
  });

  it('refuses a workspace whose location it did not mint', async () => {
    const { backend } = fakes({});
    const alien = {
      runId: 'run_9',
      localPath: '/x',
      readOnly: false,
      baseId: 'sha',
      workRef: 'b',
      location: { repoRoot: '/x', branch: 'b' }, // a GIT location
    };
    await expect(backend.publish(alien, 'main')).rejects.toThrow(/Diversion location/);
  });
});

// The exit gate (RUN-51): the REAL supervisor drives the REAL DiversionBackend through a full
// build-and-land cycle — the same orchestration the git seam carries, satisfied by a backend
// with no rebase, no fast-forward, and a server-side CAS the backend supplies itself. Only the
// transports are faked, and they answer with what RUN-54 measured a real server answering.
describe('RunSupervisor over DiversionBackend — the interface survives a live-model backend', () => {
  class InstantDriver implements AgentDriver {
    readonly tool = 'claude' as const;
    opts?: DriverStartOptions;
    start(opts: DriverStartOptions) {
      this.opts = opts;
      queueMicrotask(() =>
        opts.handlers?.onExit?.({
          outcome: 'done',
          isError: false,
          reason: null,
          telemetry: zeroTelemetry(),
        } as DriverExit),
      );
      return {
        runId: opts.runId,
        sessionId: 'sess-dv',
        pushInput: () => true,
        interrupt: async () => {},
        stop: async () => {},
        done: () => new Promise<DriverExit>(() => {}),
      };
    }
  }

  it('build → verify → integrate (merge-in) → CAS publish, landed on the target', async () => {
    const { backend, calls, branches } = fakes({
      status: 'Modified:\n\t src/x.ts\n', // the agent left work
      mergeResponses: [
        { status: 201, id: 'dv.commit.30' }, // integrate: target merged into the run branch
        { status: 200 }, // publish guard: target unmoved since integrate
        { status: 201, id: 'dv.commit.31' }, // publish: landed
      ],
    });

    const supervisor = new RunSupervisor({
      drivers: { claude: new InstantDriver() },
      vcs: backend,
      resolveRepo: () => ({
        root: '/repo',
        manifest: {
          key: 'DV',
          verify: null, // no deterministic floor in this test — the landing flow is the subject
          tool: null,
          defaultBranch: 'main',
          land: {
            branch: 'noriq/integration',
            mergeTarget: null,
            allowedBranches: [],
            onlyWhenVerifyPasses: true,
            resolveConflicts: true,
            autoPush: false,
          },
          permissions: {
            scope: { write: false, network: 'restricted', allow: [], deny: [] },
            build: { write: true, network: 'restricted', allow: [], deny: [] },
            verify: { write: false, network: 'restricted', allow: [], deny: [] },
          },
          defaults: {
            scope: { model: null, effort: null },
            build: { model: null, effort: null },
            verify: { model: null, effort: null },
          },
        },
      }),
      report: () => {},
      server: 'https://noriq.test',
      createRunAgent: async () => ({
        agentId: 'agt_dv',
        label: 'dv-test',
        token: 'tok',
        projectId: 'prj',
        expiresIn: 3600,
      }),
    });

    const exit = await supervisor.supervise({
      id: 'run_dv1',
      projectId: 'prj',
      runnerId: 'rnr',
      agentId: null,
      planKey: null,
      targetBranch: null,
      kind: 'build',
      anchor: null,
      verifiesRunId: null,
      brief: 'do the thing',
      repoRef: 'repo_dv',
      agentTool: 'claude',
      model: null,
      effort: null,
      budget: { maxTokens: null, maxUsd: null, maxDurationSeconds: null },
      status: 'dispatched',
      phase: null,
      exit: null,
      worktreePath: null,
      createdBy: 'usr',
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
      dispatchedAt: '2026-07-16T00:00:00.000Z',
      startedAt: null,
      // The Run wire type carries more optional fields than this composition test needs to
      // name — same pattern the supervisor tests use.
    } as unknown as Parameters<RunSupervisor['supervise']>[0]);

    expect(exit.outcome).toBe('done');
    // The landing target was created (it didn't exist), the run branch was merged INTO first
    // (integrate), the CAS guard ran, and the landing merge moved the target.
    const httpCalls = calls.filter((c) => c.kind === 'http').map((c) => c.what);
    expect(httpCalls).toContain(
      'POST /repos/dv.repo.test/merges?base_id=noriq%2Frun%2Frun_dv1&other_id=noriq%2Fintegration',
    );
    expect(httpCalls).toContain(
      'POST /repos/dv.repo.test/merges?base_id=noriq%2Fintegration&other_id=noriq%2Frun%2Frun_dv1',
    );
    expect(branches['noriq/integration']).toBe('dv.commit.31'); // the landed head
  });
});
