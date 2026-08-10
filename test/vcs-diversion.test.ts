import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentDriver, DriverExit, DriverStartOptions } from '../src/drivers/types';
import { zeroTelemetry } from '../src/drivers/types';
import { scanIndexSource } from '../src/index-scan';
import { FakeIndexSource } from '../src/index-source';
import { RunSupervisor } from '../src/supervisor';
import { DiversionBackend, type DvBlobHttp, type DvCli, type DvHttp, dvMergeUrl } from '../src/vcs/diversion';
import { DiversionIndexSource } from '../src/vcs/diversion-index-source';
import type { LockDelegate } from '../src/vcs/git';
import type { VcsBackend } from '../src/vcs/types';
import { CHANGES_BETWEEN_MAX_PATHS } from '../src/worktree';

/** A fake Noriq lock view (the authoritative coordination layer), recording calls. */
function fakeLocks(acquireResult: unknown = { ok: true, enabled: true, locks: [] }) {
  const calls: Array<{ method: string; token: string }> = [];
  const locks: LockDelegate = {
    acquire: async (token) => {
      calls.push({ method: 'acquire', token });
      return acquireResult as never;
    },
    release: async (token) => {
      calls.push({ method: 'release', token });
      return { released: [] };
    },
    check: async (token) => {
      calls.push({ method: 'check', token });
      return { enabled: true, conflicts: [], mine: [] };
    },
    releaseAllMine: async (token) => {
      calls.push({ method: 'releaseAllMine', token });
      return { released: [] };
    },
  };
  return { locks, calls };
}

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
  /** The Noriq lock view to inject (RUN-100). */
  locks?: LockDelegate;
  /** Model a non-Pro workspace: the soft-lock endpoint answers 402 (native degrades). */
  softLockUnavailable?: boolean;
  /** `GET /trees/{ref}` items for `queryIgnored` (RUN-256 correction) — file paths only; a
   *  directory-mode entry is never in this list, matching what the real endpoint would omit via
   *  `isDirectoryMode`. `undefined` (vs. `[]`) makes the fake 500 the tree endpoint, modelling a
   *  server that cannot answer at all. */
  tree?: string[];
  /** When true, the SECOND page of the tree fetch answers with a non-200 — models a fetch that
   *  starts fine and fails partway through. */
  treeFailsOnSecondPage?: boolean;
}) {
  const branches: Record<string, string> = over.branches ?? { main: 'dv.commit.10' };
  const mergeQueue = [...(over.mergeResponses ?? [])];
  const calls: Call[] = [];

  // A branch's fake ID, distinguishable from its name on purpose (`dv.branch.<name>`, never just
  // `<name>` — the POST /branches creation response below already reuses the name as a shorthand
  // id, and reusing THAT convention here would make it impossible for a test to tell "resolved
  // and looked up by id" apart from "looked up by name straight off `dv branch-name`", which is
  // exactly the distinction the live 500 (`GET /branches/{name}` fails, `GET /branches/{id}`
  // does not — measured 2026-08-09, every branch on a real account, not modeled by the plain
  // name-keyed arm below since dozens of pre-existing tests assume that arm succeeds) makes real.
  const branchId = (name: string) => `dv.branch.${name}`;

  const http: DvHttp = async (method, apiPath) => {
    calls.push({ kind: 'http', what: `${method} ${apiPath}` });
    const branchGet = apiPath.match(/\/branches\/([^/?]+)$/);
    if (method === 'GET' && branchGet) {
      const token = decodeURIComponent(branchGet[1] ?? '');
      if (!token.startsWith('dv.branch.')) {
        // RUN-259: reproduces the live 500 (measured 2026-08-09, every branch tried, whether or
        // not it exists) rather than the documented-shape 200/404 the old fake modeled — THAT
        // politeness is exactly why six call sites shipped broken while every test stayed green.
        // `branchHead` never sends this shape for a real lookup anymore — it resolves through
        // `GET /branches` (the list, below) first — so a test reaching this arm is exercising a
        // call this class must no longer make.
        return { status: 500, body: { error: 'simulated: GET /branches/{name} 500s live (RUN-259)' } };
      }
      const byId = Object.keys(branches).find((n) => branchId(n) === token);
      return byId ? { status: 200, body: { commit_id: branches[byId] } } : { status: 404, body: null };
    }
    if (method === 'GET' && apiPath.endsWith('/branches')) {
      return {
        status: 200,
        body: { items: Object.keys(branches).map((b) => ({ branch_name: b, branch_id: branchId(b) })) },
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
    if (apiPath.endsWith('/locks')) {
      // The native soft-lock endpoint (Pro-gated). realDvHttp resolves any non-2xx into a body,
      // never a throw — but the backend's nativeSoftLock ignores the outcome either way.
      return over.softLockUnavailable
        ? { status: 402, body: { error: 'Pro required' } }
        : { status: 200, body: {} };
    }
    const treeGet = method === 'GET' && apiPath.match(/\/trees\/[^?]+\?recurse=true&limit=(\d+)&skip=(\d+)/);
    if (treeGet) {
      if (over.tree === undefined) return { status: 500, body: { error: 'no tree fixture configured' } };
      const limit = Number(treeGet[1]);
      const skip = Number(treeGet[2]);
      if (over.treeFailsOnSecondPage && skip > 0) {
        return { status: 500, body: { error: 'simulated mid-fetch failure' } };
      }
      const page = over.tree.slice(skip, skip + limit);
      return { status: 200, body: { items: page.map((p) => ({ path: p, mode: 33188 })) } };
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

  const backend = new DiversionBackend({ repoId: 'dv.repo.test', http, cli, locks: over.locks });
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

  it('continue a failed run: adopts the run’s existing branch, never re-POSTs it (RUN-93)', async () => {
    // A kept prior attempt: the run's own branch already exists server-side with its work on it.
    const { backend, calls } = fakes({
      branches: { main: 'dv.commit.10', 'noriq/run/run_1': 'dv.commit.work' },
    });
    const ws = await backend.lease('/repo', 'run_1');
    expect(ws.workRef).toBe('noriq/run/run_1');
    // Base is the current line head, so hasWork sees the branch's own commit as work.
    expect(ws.baseId).toBe('dv.commit.10');
    expect(await backend.hasWork(ws)).toBe(true);
    // It checked the existing branch out and did NOT POST a fresh one (which would 409).
    expect(calls.some((c) => c.what === 'dv checkout noriq/run/run_1 --discard-changes --ignore-shelf')).toBe(
      true,
    );
    expect(calls.some((c) => c.what.startsWith('POST') && c.what.includes('/branches?'))).toBe(false);
    await backend.dispose(ws);
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

describe('DiversionBackend — run-addressed verbs (RUN-170): the branch convention stays in here', () => {
  // Pool-of-1 leases mean waves never overlap here today (leasesOverlap stays unset), but the
  // verbs are honestly answerable: this backend already names a run's line itself
  // (noriq/run/<id>), so the run id resolves to that branch IN HERE and the existing merge
  // machinery — integrate's server-side merge, publish's backend-carried CAS — does the rest.
  it('leaves leasesOverlap unset — the pool, not the verbs, is what stops overlap', () => {
    // Read through the seam, as the wave scheduler will — the capability is interface surface.
    const vcs: VcsBackend = fakes({}).backend;
    expect(vcs.leasesOverlap).toBeUndefined();
  });

  it('integrateFromRun merges noriq/run/<runId> INTO the workspace branch', async () => {
    const { backend, calls } = fakes({
      branches: { main: 'dv.commit.10', 'noriq/run/run_parent': 'dv.commit.20' },
      mergeResponses: [{ status: 201, id: 'dv.commit.30' }],
    });
    const ws = await backend.lease('/repo', 'run_child');
    calls.length = 0;
    expect(await backend.integrateFromRun(ws, 'run_parent')).toEqual({ ok: true });
    expect(calls.map((c) => c.what)).toEqual([
      'POST /repos/dv.repo.test/merges?base_id=noriq%2Frun%2Frun_child&other_id=noriq%2Frun%2Frun_parent',
      'dv update --conflict_resolution accept-incoming',
    ]);
  });

  it('publishToRun runs the CAS against noriq/run/<runId> — race and landing shapes verbatim', async () => {
    const { backend, calls } = fakes({
      branches: { main: 'dv.commit.10', 'noriq/run/run_parent': 'dv.commit.20' },
      mergeResponses: [
        { status: 200 }, // guard: parent line unmoved since the child integrated it
        { status: 201, id: 'dv.commit.50' }, // the landing merge
      ],
    });
    const ws = await backend.lease('/repo', 'run_child');
    calls.length = 0;
    expect(await backend.publishToRun(ws, 'run_parent')).toEqual({ ok: true, sha: 'dv.commit.50' });
    expect(calls.map((c) => c.what)).toEqual([
      'POST /repos/dv.repo.test/merges?base_id=noriq%2Frun%2Frun_child&other_id=noriq%2Frun%2Frun_parent',
      'POST /repos/dv.repo.test/merges?base_id=noriq%2Frun%2Frun_parent&other_id=noriq%2Frun%2Frun_child',
    ]);
  });

  it('publishToRun loses the race the same way publish does — the parent line moved', async () => {
    const { backend } = fakes({
      branches: { main: 'dv.commit.10', 'noriq/run/run_parent': 'dv.commit.20' },
      mergeResponses: [{ status: 201, id: 'dv.commit.60' }], // guard merged something → moved
    });
    const ws = await backend.lease('/repo', 'run_child');
    expect(await backend.publishToRun(ws, 'run_parent')).toMatchObject({ ok: false, reason: 'race' });
  });
});

describe('DiversionBackend — the rest of the surface', () => {
  it('share is a no-op success: publishing already reached the server', async () => {
    const { backend, calls } = fakes({});
    expect(await backend.share('/repo', 'main')).toEqual({ ok: true });
    expect(calls).toEqual([]); // not even a network call
  });

  it('openReview refuses honestly: review happens in Diversion, and nothing is invented (RUN-85)', async () => {
    // No pending-merge endpoint is measured, so the contract is a refusal that names where a
    // human reviews — and ZERO calls: stating that fact must not act on the server.
    const { backend, calls } = fakes({});
    const res = await backend.openReview('/repo', {
      head: 'noriq/plan-alpha',
      base: 'main',
      planTitle: 'Runner v2',
      planKey: 'alpha',
    });
    expect(res).toEqual({
      ok: false,
      detail:
        'review happens in Diversion: merge branch noriq/plan-alpha into main in the ' +
        'Diversion app (repo dv.repo.test) — the daemon cannot open a Diversion merge request',
    });
    expect(calls).toEqual([]); // no network call is part of the contract, not an accident
  });

  describe('queryIgnored (RUN-256, corrected)', () => {
    // Diversion has no per-directory check-ignore primitive (spot-checked against a live
    // `dv --help`, and `dv status <paths>` measured to discard the ignore signal entirely — see
    // the method's own doc) but DOES honour .dvignore/.gitignore, confirmed live: a matching path
    // is silently absent from `dv status`'s `New:` section while a sibling appears. These tests
    // model that via the two real primitives combined — the tracked tree and the status delta —
    // never via a hand-rolled ignore-file parser (the seam floor: no dialect logic outside the
    // per-VCS files).

    it('a tracked file is never ignored, even if a caller asks about a path outside status/tree', async () => {
      const { backend } = fakes({ tree: ['src/a.ts', 'src/b.ts'] });
      const res = await backend.queryIgnored('/repo', ['src/a.ts']);
      expect(res).toEqual({ ok: true, ignored: new Set() });
    });

    it('an untracked path Diversion would add (New:) is not ignored', async () => {
      const { backend } = fakes({ tree: [], status: 'New:\n\t src/new-file.ts\n' });
      const res = await backend.queryIgnored('/repo', ['src/new-file.ts']);
      expect(res).toEqual({ ok: true, ignored: new Set() });
    });

    it('a path absent from both the tree and New: is ignored', async () => {
      const { backend } = fakes({ tree: ['src/a.ts'], status: 'New:\n\t src/new-file.ts\n' });
      const res = await backend.queryIgnored('/repo', ['node_modules']);
      expect(res).toEqual({ ok: true, ignored: new Set(['node_modules']) });
    });

    it('a directory containing a tracked file is not ignored, via the precomputed dirPrefixes', async () => {
      const { backend } = fakes({ tree: ['Content/Base/Crow/ABP_Crow.uasset'] });
      const res = await backend.queryIgnored('/repo', ['Content', 'Content/Base', 'Content/Base/Crow']);
      expect(res).toEqual({ ok: true, ignored: new Set() });
    });

    it('a directory with nothing tracked or new under it is ignored (the debug walk prunes it)', async () => {
      const { backend } = fakes({ tree: ['src/a.ts'] });
      const res = await backend.queryIgnored('/repo', ['build']);
      expect(res).toEqual({ ok: true, ignored: new Set(['build']) });
    });

    it('the tree fetch is paginated and every page is consulted', async () => {
      const many = Array.from({ length: 5 }, (_, i) => `src/f${i}.ts`);
      const { backend } = fakes({ tree: many });
      const res = await backend.queryIgnored('/repo', ['src/f4.ts', 'src/ignored.ts']);
      expect(res).toEqual({ ok: true, ignored: new Set(['src/ignored.ts']) });
    });

    it('a mid-fetch tree failure is unknown, never a partial answer treated as complete', async () => {
      const many = Array.from({ length: 3000 }, (_, i) => `src/f${i}.ts`);
      const { backend } = fakes({ tree: many, treeFailsOnSecondPage: true });
      const res = await backend.queryIgnored('/repo', ['src/f0.ts']);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('unknown');
    });

    it('no tree fixture configured (a server that cannot answer at all) is unknown', async () => {
      const { backend } = fakes({});
      const res = await backend.queryIgnored('/repo', ['src/a.ts']);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('unknown');
    });

    it('is called ONCE per backend instance regardless of how many queryIgnored calls follow', async () => {
      const { backend, calls } = fakes({ tree: ['src/a.ts'] });
      await backend.queryIgnored('/repo', ['src/a.ts']);
      await backend.queryIgnored('/repo', ['src/b.ts']);
      await backend.queryIgnored('/repo', ['src/c.ts']);
      const treeCalls = calls.filter((c) => c.kind === 'http' && c.what.includes('/trees/'));
      const statusCalls = calls.filter((c) => c.kind === 'cli' && c.what === 'dv status --nowait --no-limit');
      expect(treeCalls).toHaveLength(1);
      expect(statusCalls).toHaveLength(1);
    });

    it('resolves the branch ID before looking up its head — never the bare name from `dv branch-name`', async () => {
      // Live-measured, 2026-08-09, against a real account: GET /branches/{name} 500s and
      // GET /branches/{id} 200s for the SAME branch, every branch tried. `branchHead` places its
      // argument straight into the URL with no resolution of its own, so calling it with a name
      // here would be exactly the defect this test exists to catch — see the filed follow-up for
      // every OTHER call site in this class still doing that.
      const { backend, calls } = fakes({ tree: ['src/a.ts'], currentBranch: 'main' });
      await backend.queryIgnored('/repo', ['src/a.ts']);
      const branchGets = calls.filter((c) => c.kind === 'http' && /\/branches\/[^/?]+$/.test(c.what));
      expect(branchGets).toEqual([{ kind: 'http', what: 'GET /repos/dv.repo.test/branches/dv.branch.main' }]);
    });
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

  // RUN-157. `branchHead` mapped BOTH a 404 and a 200-without-commit_id to null, and `hasWork`
  // maps null to false — so a response the backend could not read reported "no work", which the
  // caller acts on by disposing. A 404 is an ANSWER (a run that has committed nothing has no
  // branch yet); a branch the server says exists and then declines to describe is not.
  describe('hasWork tells "no commits yet" from "could not read the answer"', () => {
    const ws = {
      runId: 'run_1',
      localPath: '/repo',
      readOnly: false,
      baseId: 'dv.commit.1',
      workRef: 'noriq/run/run_1',
      location: { repoId: 'dv.repo.x', branch: 'noriq/run/run_1', baseBranch: 'main' },
    };
    /** A workspace with no uncommitted edits, so the answer turns entirely on the branch lookup. */
    const cleanCli: DvCli = async () => ({ stdout: '', stderr: '' });
    /** `hasWork` resolves `ws.location.branch` (a NAME) through `branchHead` (RUN-259), which
     *  first lists branches to find its id — this always answers that list with a fixed id for
     *  the workspace's own branch, so the test-configured `status`/`body` below still lands on
     *  exactly the id-shaped lookup these tests exist to exercise. */
    const withBranchGet = (body: unknown, status = 200) =>
      new DiversionBackend({
        repoId: 'dv.repo.x',
        cli: cleanCli,
        http: async (method, apiPath) => {
          if (method === 'GET' && apiPath.endsWith('/branches')) {
            return {
              status: 200,
              body: { items: [{ branch_name: ws.workRef, branch_id: 'dv.branch.noriq-run-run_1' }] },
            };
          }
          return { status, body } as never;
        },
      });

    it('a branch that does not exist yet is no work — the ordinary state of a fresh lease', async () => {
      expect(await withBranchGet(null, 404).hasWork(ws)).toBe(false);
    });

    it('rejects a branch the server says exists but will not describe', async () => {
      const backend = withBranchGet({ branch_id: 'noriq/run/run_1' }); // 200, no commit_id
      await expect(backend.hasWork(ws)).rejects.toThrow(/reported no commit/);
    });

    it('still reports work when the branch has moved past the base', async () => {
      expect(await withBranchGet({ commit_id: 'dv.commit.9' }).hasWork(ws)).toBe(true);
    });
  });

  // RUN-259. `GET /repos/{repo}/branches/{name}` measured a live 500 on a real Diversion account
  // (2026-08-09) — `main`, and a feature branch, every branch tried, not only the default one an
  // earlier fix here (`leaseIndexSnapshot`'s `default_branch_id`) scoped itself to. `GET
  // /branches/{id}` (the same endpoint, an id instead of a name) answered 200 every time. The fix
  // moved resolution INSIDE `branchHead`, once, rather than into each of the six callers that used
  // to hand it a bare name — these two tests are the acceptance gate for that: one proves no call
  // site still constructs the broken shape, the other proves a failed resolution is a throw, not a
  // silent "no such branch".
  it('RUN-259: no branchHead call site issues GET /branches/<a name> — every lookup is id-shaped', async () => {
    const { backend, calls } = fakes({
      branches: { main: 'dv.commit.10' },
      mergeResponses: [{ status: 200 }, { status: 200 }], // publish: nothing to land
    });
    const ws = await backend.lease('/repo', 'run_1'); // branchHead(name) x2 (no prior branch)
    await backend.hasWork(ws); // branchHead(loc.branch)
    await backend.targetExists('/repo', 'main'); // branchHead(target)
    await backend.createTarget('/repo', 'noriq/integration', 'main'); // branchHead(from)
    await backend.publish(ws, 'main'); // guard(200) + landing(200) → branchHead(target)

    const branchLookups = calls
      .filter((c) => c.kind === 'http' && /\/branches\/[^/?]+$/.test(c.what))
      .map((c) => c.what);
    expect(branchLookups.length).toBeGreaterThan(0); // the assertion below must have something to bite
    for (const call of branchLookups) {
      expect(call).toMatch(/\/branches\/dv\.branch\./); // never a bare name in that URL segment
    }
  });

  it('a failing GET /branches (the list, resolving a NAME) throws — never reported as "no such branch"', async () => {
    const http: DvHttp = async (method, apiPath) => {
      if (method === 'GET' && apiPath.endsWith('/branches')) return { status: 500, body: { error: 'boom' } };
      throw new Error(`unexpected call ${method} ${apiPath}`);
    };
    const backend = new DiversionBackend({
      repoId: 'dv.repo.test',
      http,
      cli: async () => ({ stdout: '', stderr: '' }),
    });
    // `targetExists` maps `branchHead`'s null (no such branch) to `false` — a thrown list failure
    // must not collapse into that same false, which is what "silent success" would look like here.
    await expect(backend.targetExists('/repo', 'main')).rejects.toThrow(/could not list branches/);
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
    readonly capabilities = {
      toolHooks: true,
      steer: true,
      interrupt: true,
      resumableSession: true,
      perModelTelemetry: true,
    };
    readonly catalog = { models: [], efforts: [] };
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
          board: null,
          verify: null, // no deterministic floor in this test — the landing flow is the subject
          context: {
            requiredReading: [],
            entryPoints: [],
            conventions: [],
            agentInstructions: 'inline' as const,
          },
          tool: null,
          defaultBranch: 'main',
          repositoryKey: null,
          index: null,
          setup: null,
          land: {
            branch: 'noriq/integration',
            mergeTarget: null,
            allowedBranches: [],
            onlyWhenVerifyPasses: true,
            resolveConflicts: true,
            autoPush: false,
          },
          permissions: {
            scope: { write: false, allow: [], deny: [], auto: false },
            build: { write: true, allow: [], deny: [], auto: false },
            verify: { write: false, allow: [], deny: [], auto: false },
          },
          defaults: {
            scope: { agent: null, model: null, effort: null },
            build: { agent: null, model: null, effort: null },
            verify: { agent: null, model: null, effort: null },
          },
          workflows: {},
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

// ---------------------------------------------------------------------------
// RUN-255: `leaseIndexSnapshot`/`changesBetween` measured live against a real Diversion account
// (2026-08-09, dv CLI v1.0.1017, repo `dv.repo.e821a7a1-382e-4466-a906-61a2b19694f1`, ~7259 files).
// Every fixture body below is copied VERBATIM from that capture (locked decision 11) — trimmed to
// the few items each test needs, never paraphrased or hand-invented, except where a comment says
// otherwise (a field this OWNER-access account never triggered live: `has_restricted_files: true`,
// `access_denied: true`, an unrecognized `status`, and the "no other_item" defensive branch —
// each of those is a documented schema shape exercised synthetically, not a captured response).
// ---------------------------------------------------------------------------

const REPO_ID = 'dv.repo.test';

/** Verbatim `GET /repos/{repo}` body (repo id/name swapped for the test double's `REPO_ID`). */
const REPO_META = {
  repo_id: REPO_ID,
  repo_name: 'Prototype',
  description: '',
  size_bytes: 10445915824,
  owner_user_id: 'dv.u.ef7919578bc5ec51',
  created_timestamp: 1783542398,
  digest_method: 'sha1',
  def_auto_forwarding_enabled: true,
  default_branch_id: 'dv.branch.1',
  default_branch_name: 'main',
  organization_id: 'dv.org.b98b1df5-fa30-4e40-9cbe-e801f50e600b',
};

/** Verbatim first 6 items of a live `GET /trees/{ref}?recurse=true` page — two real directories
 *  (`.noriq`, `.ue-mcp`, both mode 16877, no `blob`) interleaved with real files. */
const TREE_PAGE_SAMPLE = {
  items: [
    {
      path: '.dvignore',
      hash: '728102a860988f6697b4e80f59535a0f4b263ac2',
      status: 1,
      mode: 33188,
      mtime: '2026-07-23T01:21:32+00:00',
      blob: { storage_uri: `${REPO_ID}/de/7a/de7a666`, storage_backend: 1101, size: 1595, sha: 'de7a666' },
    },
    {
      path: '.ignore',
      hash: '683d5b42235d84c688e1cd1408576e0e1b7b636b',
      status: 1,
      mode: 33188,
      mtime: '2026-07-10T17:25:17+00:00',
      blob: { storage_uri: `${REPO_ID}/45/e5/45e5877`, storage_backend: 1101, size: 517, sha: 'c88b690' },
    },
    {
      path: '.noriq',
      hash: '1188d1a38462a673de6bb357f528113bc439cf9d',
      status: 1,
      mode: 16877,
      mtime: '2026-07-16T20:58:38+00:00',
    },
    {
      path: '.ue-mcp',
      hash: '1188d1a38462a673de6bb357f528113bc439cf9d',
      status: 1,
      mode: 16877,
      mtime: '2026-07-12T22:58:51+00:00',
    },
    {
      path: '.ue-mcp/native-modules.json',
      hash: '8a043549654338eb54b51d671e1359252fbc8354',
      status: 1,
      mode: 33188,
      mtime: '2026-07-12T23:00:24+00:00',
      blob: { storage_uri: `${REPO_ID}/ce/8d/ce8d3d5`, storage_backend: 1101, size: 2953, sha: '548a134' },
    },
    {
      path: 'AGENTS.md',
      hash: '48f7a164cb0472d4259384c5752cba01bfbd2c62',
      status: 1,
      mode: 33188,
      mtime: '2026-07-13T17:08:58+00:00',
      blob: { storage_uri: `${REPO_ID}/ba/d9/bad95db`, storage_backend: 1101, size: 16580, sha: 'bad95db' },
    },
  ],
};

/** Verbatim `dv.commit.472..473` compare item — a real MODIFIED file (top-level `status: 3`,
 *  matching `other_item.status: 3`; `base_item.status: 1` — the per-side field this backend never
 *  reads, see `decodeObjectStatus`'s doc). */
const COMPARE_MODIFY_ITEM = {
  status: 3,
  base_item: {
    path: 'Plugins/NodCharacterCreator/Source/NodCoreTechRuntime/Private/NodRuntimeGarmentFitEvaluator.cpp',
    hash: 'd8cdc4483d8f47d9a534143f5da238326034d82f',
    status: 1,
    mode: 33188,
    prev_path:
      'Plugins/NodCharacterCreator/Source/NodCoreTechRuntime/Private/NodRuntimeGarmentFitEvaluator.cpp',
    prev_hash: 'f915525785d6ff8de6077e5d2f28035ce4f08583',
    mtime: '2026-08-05T11:23:51+00:00',
    blob: { storage_uri: `${REPO_ID}/72/ad/72ad034`, storage_backend: 1101, size: 42951, sha: '188ebd8' },
  },
  other_item: {
    path: 'Plugins/NodCharacterCreator/Source/NodCoreTechRuntime/Private/NodRuntimeGarmentFitEvaluator.cpp',
    hash: '0c81932e934021acdd7ec3a33a5fdbfbabd5e147',
    status: 3,
    mode: 33188,
    prev_path:
      'Plugins/NodCharacterCreator/Source/NodCoreTechRuntime/Private/NodRuntimeGarmentFitEvaluator.cpp',
    prev_hash: 'd8cdc4483d8f47d9a534143f5da238326034d82f',
    mtime: '2026-08-05T22:30:34+00:00',
    blob: { storage_uri: `${REPO_ID}/87/1e/871e408`, storage_backend: 1101, size: 44459, sha: '871e408' },
  },
};

/** Verbatim `dv.commit.12..13` compare item — a plain DELETION: `other_item` is a TOMBSTONE (no
 *  `blob`, the canonical "deleted" hash `185135d1…`, `prev_path` equal to `path` since nothing
 *  moved), present alongside `base_item` in every one of 10,637 items measured — never absent. */
const COMPARE_DELETE_ITEM = {
  status: 4,
  base_item: {
    path: '.ignore',
    hash: '239395f36d8da53004020d8409a235de27c30a21',
    status: 1,
    mode: 33188,
    mtime: '2026-07-10T15:06:59+00:00',
    blob: { storage_uri: `${REPO_ID}/9c/0f/9c0f0cc`, storage_backend: 1101, size: 459, sha: '1beb1f9' },
  },
  other_item: {
    path: '.ignore',
    hash: '185135d170e228e5442e1b14b410cb58a1a87d3f',
    status: 4,
    mode: 33188,
    prev_path: '.ignore',
    prev_hash: '239395f36d8da53004020d8409a235de27c30a21',
    mtime: '2026-07-10T16:28:38+00:00',
  },
};

/** Verbatim `dv.commit.7..8` compare item — a real detected RENAME: no `base_item` at all, one
 *  `other_item` whose `prev_path` names the OLD path directly (locked decision 5) — the only
 *  rename Diversion's own move-detection surfaced across a 472-commit scan of this account. */
const COMPARE_RENAME_ITEM = {
  status: 3,
  other_item: {
    path: 'Plugins/NodEcs/Source/NodEcs/Public/Entity/EcsEntityHandle.h',
    hash: '5143ee7b03a3ea0cabaabfa4b515f4bfb2b9a264',
    status: 3,
    mode: 33188,
    prev_path: 'Plugins/NodEcs/Source/NodEcs/Public/Entity/EntityHandle.h',
    prev_hash: '17e4842404c0d28f69ae7740b3f74da6abaf044a',
    mtime: '2026-07-10T15:10:21+00:00',
    blob: { storage_uri: `${REPO_ID}/c6/c8/c6c8c55`, storage_backend: 1101, size: 1740, sha: 'ffe569c' },
  },
};

/** Verbatim `dv.commit.442..443` compare item — a directory ADD (mode 16877, no `blob`): the
 *  "Move authored wearables" commit's own tombstone/creation records for the directories
 *  themselves, alongside per-file records for everything inside (measured: 227 items, 75 of them
 *  directory-mode). */
const COMPARE_DIRECTORY_ADD_ITEM = {
  status: 2,
  other_item: {
    path: 'Config',
    hash: '1188d1a38462a673de6bb357f528113bc439cf9d',
    status: 1,
    mode: 16877,
    mtime: '2026-07-08T20:39:55+00:00',
  },
};

/** Verbatim 401 body from a request with a corrupted bearer token — the general shape every
 *  credential failure (including an expired one, per the task's own measurement note) answers
 *  with: `{status, title, detail}`, never a 2xx with an empty/partial body. */
const UNAUTHORIZED_BODY = {
  detail: "Invalid header string: 'utf-8' codec can't decode byte 0x81 in position 0: invalid start byte",
  status: 401,
  title: 'DecodeError',
  type: 'about:blank',
};

/** A dedicated fake transport for the indexing surface — deliberately separate from `fakes()`
 *  above (branches/merges/locks), because `/trees`, `/compare` and blob reads are a different
 *  shape of call than anything the run-lease surface makes. */
function indexFakes(opts: {
  repoStatus?: number;
  repoBody?: unknown;
  branches?: Record<string, string>;
  treePage?: (skip: number) => { status: number; body: unknown };
  compare?: { status: number; body: unknown };
  fileEntries?: Record<string, unknown>;
  blobs?: Record<string, { status: number; bytes?: Buffer; detail?: string }>;
}) {
  const httpCalls: string[] = [];
  const blobCalls: string[] = [];

  const branches: Record<string, string> = { ...opts.branches };

  const http: DvHttp = async (method, apiPath) => {
    httpCalls.push(`${method} ${apiPath}`);
    if (method === 'GET' && /^\/repos\/[^/?]+$/.test(apiPath)) {
      return { status: opts.repoStatus ?? 200, body: opts.repoBody ?? REPO_META };
    }
    const branchGet = apiPath.match(/\/branches\/([^/?]+)$/);
    if (method === 'GET' && branchGet) {
      const token = decodeURIComponent(branchGet[1] ?? '');
      const direct = branches[token];
      if (direct) return { status: 200, body: { commit_id: direct } };
      // A `dv.branch.<name>` id synthesized by the list handler below, for a name this fixture
      // never stored under that literal key — fall back to the underlying name.
      const byId = token.startsWith('dv.branch.') ? branches[token.slice('dv.branch.'.length)] : undefined;
      return byId ? { status: 200, body: { commit_id: byId } } : { status: 404, body: null };
    }
    if (method === 'GET' && apiPath.endsWith('/branches')) {
      // Only `lease()`'s NAME resolution (RUN-259) reaches this — every other call in this file's
      // index-surface tests already holds an id (`default_branch_id`, or one from `branches`
      // directly). Synthesizes `dv.branch.<name>` for whichever bare keys `branches` carries;
      // `branchGet` above resolves that exact shape back via its own `dv.branch.` fallback.
      const items = Object.keys(branches)
        .filter((k) => !k.startsWith('dv.branch.') && !k.startsWith('dv.commit.'))
        .map((name) => ({ branch_name: name, branch_id: `dv.branch.${name}` }));
      return { status: 200, body: { items } };
    }
    // `lease()` (exercised by the "held run lease" test) creates the run's own branch — not part
    // of the indexing surface, but needed so that test can hold a REAL lease alongside a snapshot.
    if (method === 'POST' && apiPath.includes('/branches?')) {
      const name = decodeURIComponent(apiPath.match(/branch_name=([^&]+)/)?.[1] ?? '');
      const commit = decodeURIComponent(apiPath.match(/commit_id=([^&]+)/)?.[1] ?? '');
      branches[name] = commit;
      return { status: 201, body: { branch_id: name } };
    }
    const treeMatch = apiPath.match(/\/trees\/[^/?]+\?(.+)$/);
    if (method === 'GET' && treeMatch) {
      const skip = Number(new URLSearchParams(treeMatch[1]).get('skip') ?? '0');
      return opts.treePage?.(skip) ?? { status: 200, body: { items: [] } };
    }
    if (method === 'GET' && apiPath.includes('/compare?')) {
      return opts.compare ?? { status: 200, body: { items: [] } };
    }
    const fileMatch = apiPath.match(/\/files\/[^/]+\/(.+)$/);
    if (method === 'GET' && fileMatch) {
      const p = decodeURIComponent(fileMatch[1] ?? '');
      const entry = opts.fileEntries?.[p];
      return entry ? { status: 200, body: entry } : { status: 404, body: null };
    }
    throw new Error(`index fake has no answer for ${method} ${apiPath}`);
  };

  const blobHttp: DvBlobHttp = async (_repoId, _refId, filePath) => {
    blobCalls.push(filePath);
    return opts.blobs?.[filePath] ?? { status: 404 };
  };

  return { http, blobHttp, httpCalls, blobCalls };
}

const dummyCli: DvCli = async (args) => ({ stdout: args[0] === 'branch-name' ? 'main\n' : '', stderr: '' });

describe('DiversionBackend — index snapshot (RUN-255): real, API-only, never busy', () => {
  it('mints a real snapshot pinned to the default branch head — WHILE a run lease is held (locked decision 1: no pool contention)', async () => {
    // `lease()` (called below) resolves `main` by NAME via the CLI's own `branch-name` output;
    // `leaseIndexSnapshot` resolves the default branch by ID (`dv.branch.1`) — see that method's
    // doc for why the two differ. Both keys point at the same live head.
    const { http, blobHttp } = indexFakes({
      branches: { main: 'dv.commit.473', 'dv.branch.1': 'dv.commit.473' },
    });
    const backend = new DiversionBackend({ repoId: REPO_ID, http, blobHttp, cli: dummyCli });

    // Hold the pool-of-1 run lease for the ENTIRE call — proving the old RUN-211 busy check
    // (removed under locked decision 1) is gone: this API-only snapshot never touches `held`.
    const runWs = await backend.lease('/repo', 'run_1');

    const res = await backend.leaseIndexSnapshot('/repo');
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.snapshot).toMatchObject({
      baseId: 'dv.commit.473',
      branch: 'main',
      readOnly: true,
      location: { kind: 'index-snapshot', repoId: REPO_ID },
    });
    expect(res.snapshot.source).toBeInstanceOf(DiversionIndexSource);
    expect(res.snapshot.source.kind).toBe('diversion');
    // RUN-281: `repoRoot` is now OFFERED as a verify-then-read candidate root (never trusted,
    // never a materialized tree — locked decision 1 above still holds: nothing was checked out to
    // produce this). Same string minted into the `DiversionIndexSource` constructor at the same
    // call site; see the "verify-then-read local fast path" describe block below for proof of the
    // actual read behaviour this offer enables.
    expect(res.snapshot.localPath).toBe('/repo');

    await backend.dispose(runWs);
  });

  it('verify-then-read succeeds with ZERO HTTP content calls WHILE a run lease is concurrently held over the SAME repoRoot (RUN-281: no lease needed, none taken)', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'noriq-dv-concurrent-'));
    try {
      const content = Buffer.from('export const z = 3;\n');
      const sha1 = createHash('sha1').update(content).digest('hex');
      await writeFile(path.join(localRoot, 'z.ts'), content);
      const page = { items: [{ path: 'z.ts', mode: 33188, blob: { size: content.length, sha: sha1 } }] };
      const { http, blobHttp, blobCalls } = indexFakes({
        branches: { main: 'dv.commit.473', 'dv.branch.1': 'dv.commit.473' },
        treePage: () => ({ status: 200, body: page }),
      });
      const backend = new DiversionBackend({ repoId: REPO_ID, http, blobHttp, cli: dummyCli });

      // A run holds the pool-of-1 lease over the exact same directory the whole time — the shared,
      // mutable workspace this scheme was built to read safely without waiting for.
      const runWs = await backend.lease(localRoot, 'run_1');
      const res = await backend.leaseIndexSnapshot(localRoot);
      if (!res.ok) throw new Error('unreachable');
      for await (const _ of res.snapshot.source.list()) {
        /* drain to populate the digest cache */
      }
      expect(await res.snapshot.source.read('z.ts', 1_000_000)).toEqual({
        ok: true,
        bytes: content,
        overLimit: false,
      });
      expect(blobCalls).toEqual([]); // no HTTP content call, no lease needed to get here.
      await backend.dispose(runWs);
    } finally {
      await rm(localRoot, { recursive: true, force: true });
    }
  });

  it('answers unsupported when the repo lookup itself fails', async () => {
    const { http, blobHttp } = indexFakes({ repoStatus: 500 });
    const backend = new DiversionBackend({ repoId: REPO_ID, http, blobHttp, cli: dummyCli });
    expect(await backend.leaseIndexSnapshot('/repo')).toEqual({
      ok: false,
      reason: 'unsupported',
      detail: expect.stringContaining('500'),
    });
  });

  it('answers unsupported when the repo reports no default branch', async () => {
    const { http, blobHttp } = indexFakes({ repoBody: { ...REPO_META, default_branch_name: undefined } });
    const backend = new DiversionBackend({ repoId: REPO_ID, http, blobHttp, cli: dummyCli });
    expect(await backend.leaseIndexSnapshot('/repo')).toMatchObject({ ok: false, reason: 'unsupported' });
  });

  it('answers unsupported when the default branch has no commits yet', async () => {
    const { http, blobHttp } = indexFakes({ branches: {} }); // main resolves to nothing
    const backend = new DiversionBackend({ repoId: REPO_ID, http, blobHttp, cli: dummyCli });
    expect(await backend.leaseIndexSnapshot('/repo')).toMatchObject({ ok: false, reason: 'unsupported' });
  });

  it('releaseIndexSnapshot is an idempotent no-op for a snapshot this backend minted', async () => {
    const { http, blobHttp } = indexFakes({ branches: { 'dv.branch.1': 'dv.commit.473' } });
    const backend = new DiversionBackend({ repoId: REPO_ID, http, blobHttp, cli: dummyCli });
    const res = await backend.leaseIndexSnapshot('/repo');
    if (!res.ok) throw new Error('unreachable');
    await expect(backend.releaseIndexSnapshot(res.snapshot)).resolves.toBeUndefined();
    await expect(backend.releaseIndexSnapshot(res.snapshot)).resolves.toBeUndefined(); // idempotent.
  });

  it('releaseIndexSnapshot refuses a snapshot it did not mint', async () => {
    const { http, blobHttp } = indexFakes({});
    const backend = new DiversionBackend({ repoId: REPO_ID, http, blobHttp, cli: dummyCli });
    await expect(
      backend.releaseIndexSnapshot({
        source: new FakeIndexSource([]),
        baseId: 'x',
        readOnly: true,
        location: { repoRoot: '/x', kind: 'git' }, // a foreign (git-shaped) location
      }),
    ).rejects.toThrow(/did not mint/);
  });

  it('wires `repoRoot` end to end (RUN-281): the minted source verify-reads from the SAME directory offered as localPath', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'noriq-dv-lease-'));
    try {
      const content = Buffer.from('export const y = 2;\n');
      const sha1 = createHash('sha1').update(content).digest('hex');
      await writeFile(path.join(localRoot, 'y.ts'), content);
      const page = { items: [{ path: 'y.ts', mode: 33188, blob: { size: content.length, sha: sha1 } }] };
      const { http, blobHttp, blobCalls } = indexFakes({
        branches: { 'dv.branch.1': 'dv.commit.473' },
        treePage: () => ({ status: 200, body: page }),
      });
      const backend = new DiversionBackend({ repoId: REPO_ID, http, blobHttp, cli: dummyCli });
      const res = await backend.leaseIndexSnapshot(localRoot);
      if (!res.ok) throw new Error('unreachable');
      expect(res.snapshot.localPath).toBe(localRoot);
      for await (const _ of res.snapshot.source.list()) {
        /* drain to populate the digest cache */
      }
      expect(await res.snapshot.source.read('y.ts', 1_000_000)).toEqual({
        ok: true,
        bytes: content,
        overLimit: false,
      });
      expect(blobCalls).toEqual([]); // never fetched over HTTP — the backend's own offer was used.
    } finally {
      await rm(localRoot, { recursive: true, force: true });
    }
  });
});

// RUN-222 locked decision 3: a three-line delegation to `branchHead`, which resolves a NAME
// itself since RUN-259 — no `GET /repos` round trip, no lease.
describe('DiversionBackend — currentBase (RUN-222)', () => {
  it('an EXPLICIT branch name resolves to its head, exactly as branchHead would — no GET /repos call', async () => {
    // `fakes()`'s http has no route for a bare `GET /repos/{repoId}` at all — if the explicit-
    // branch path ever made that call (rather than skipping straight to branchHead), this fake
    // would throw "no answer for GET …" instead of resolving, so a clean resolve IS the proof.
    const { backend } = fakes({ branches: { main: 'dv.commit.10' } });
    expect(await backend.currentBase('/repo', 'main')).toEqual({ ok: true, baseId: 'dv.commit.10' });
  });

  it('an EXPLICIT id-shaped branch too — branchHead skips name resolution for it', async () => {
    const { backend } = fakes({ branches: { main: 'dv.commit.10' } });
    expect(await backend.currentBase('/repo', 'dv.branch.main')).toEqual({
      ok: true,
      baseId: 'dv.commit.10',
    });
  });

  it('an EXPLICIT branch that does not resolve answers unknown, never throws', async () => {
    const { backend } = fakes({ branches: { main: 'dv.commit.10' } });
    expect(await backend.currentBase('/repo', 'no-such-branch')).toMatchObject({
      ok: false,
      reason: 'unknown',
    });
  });

  it('never touches the pool-of-1 lease — held WHILE this is asked, same as leaseIndexSnapshot', async () => {
    const { backend } = fakes({ branches: { main: 'dv.commit.10' } });
    const runWs = await backend.lease('/repo', 'run_1');
    expect(await backend.currentBase('/repo', 'main')).toEqual({ ok: true, baseId: 'dv.commit.10' });
    await backend.dispose(runWs);
  });

  // No branch given: resolves the repo's DEFAULT branch itself, via the same GET /repos call
  // `leaseIndexSnapshot` already makes — never `dv branch-name`. See this method's own doc for why:
  // the pool-of-1 shared workspace is re-checked-out per lease, so a CLI read answers "what is
  // showing right now," not "what is the default branch."
  describe('no branch given — resolves the DEFAULT branch via GET /repos, never dv branch-name', () => {
    it('resolves the default branch and its head, mirroring leaseIndexSnapshot', async () => {
      const { http, blobHttp } = indexFakes({ branches: { 'dv.branch.1': 'dv.commit.473' } });
      const backend = new DiversionBackend({ repoId: REPO_ID, http, blobHttp, cli: dummyCli });
      expect(await backend.currentBase('/repo')).toEqual({ ok: true, baseId: 'dv.commit.473' });
    });

    it('is UNAFFECTED by what the local CLI would report — proof it never consults dv branch-name', async () => {
      const { http, blobHttp } = indexFakes({ branches: { 'dv.branch.1': 'dv.commit.473' } });
      // Models the pool-of-1 workspace mid-checkout on some OTHER run's throwaway branch — the
      // exact state `dv branch-name` would report right after a landing, before dispose() runs.
      // If `currentBase` ever asked the CLI, this is what it would wrongly resolve instead.
      const cliCalls: string[][] = [];
      const misleadingCli: DvCli = async (args) => {
        cliCalls.push(args);
        if (args[0] === 'branch-name') return { stdout: 'noriq/run/some-other-run\n', stderr: '' };
        return { stdout: '', stderr: '' };
      };
      const backend = new DiversionBackend({ repoId: REPO_ID, http, blobHttp, cli: misleadingCli });
      expect(await backend.currentBase('/repo')).toEqual({ ok: true, baseId: 'dv.commit.473' });
      expect(cliCalls).toEqual([]); // the CLI was never called at all
    });

    it('a repo lookup failure (HTTP) answers unknown, never throws', async () => {
      const { http, blobHttp } = indexFakes({ repoStatus: 500 });
      const backend = new DiversionBackend({ repoId: REPO_ID, http, blobHttp, cli: dummyCli });
      expect(await backend.currentBase('/repo')).toEqual({
        ok: false,
        reason: 'unknown',
        detail: expect.stringContaining('500'),
      });
    });

    it('a repo that reports no default branch answers unknown, never throws', async () => {
      const { http, blobHttp } = indexFakes({ repoBody: { ...REPO_META, default_branch_id: undefined } });
      const backend = new DiversionBackend({ repoId: REPO_ID, http, blobHttp, cli: dummyCli });
      expect(await backend.currentBase('/repo')).toMatchObject({ ok: false, reason: 'unknown' });
    });

    it('never touches the pool-of-1 lease either — held WHILE this is asked', async () => {
      // `main` (a plain name) alongside the id form: `lease()`'s own baseBranch resolution goes
      // through `branchIdByName` (the LIST route), which only ever sees non-`dv.branch.`-prefixed
      // keys — `dv.branch.1` alone isn't enough to let a real `lease()` succeed here.
      const { http, blobHttp } = indexFakes({
        branches: { main: 'dv.commit.473', 'dv.branch.1': 'dv.commit.473' },
      });
      const backend = new DiversionBackend({ repoId: REPO_ID, http, blobHttp, cli: dummyCli });
      const runWs = await backend.lease('/repo', 'run_1');
      expect(await backend.currentBase('/repo')).toEqual({ ok: true, baseId: 'dv.commit.473' });
      await backend.dispose(runWs);
    });
  });
});

describe('DiversionIndexSource — list() (RUN-255): /trees, sorted, directories filtered', () => {
  it('yields file entries in the order the tree already reports, skipping both real directories', async () => {
    const { http, blobHttp } = indexFakes({ treePage: () => ({ status: 200, body: TREE_PAGE_SAMPLE }) });
    const source = new DiversionIndexSource(REPO_ID, 'dv.commit.473', http, blobHttp);
    const items = [];
    for await (const item of source.list()) items.push(item);
    expect(items).toEqual([
      { kind: 'file', entry: { path: '.dvignore', size: 1595 } },
      { kind: 'file', entry: { path: '.ignore', size: 517 } },
      // '.noriq' and '.ue-mcp' (mode 16877 — FileMode_TREE) never appear as candidates.
      { kind: 'file', entry: { path: '.ue-mcp/native-modules.json', size: 2953 } },
      { kind: 'file', entry: { path: 'AGENTS.md', size: 16580 } },
    ]);
  });

  it('honours shouldDescend — an ancestor the caller denies is pruned before it ever yields', async () => {
    const { http, blobHttp } = indexFakes({ treePage: () => ({ status: 200, body: TREE_PAGE_SAMPLE }) });
    const source = new DiversionIndexSource(REPO_ID, 'dv.commit.473', http, blobHttp);
    const items = [];
    for await (const item of source.list((dir) => dir !== '.ue-mcp')) items.push(item);
    expect(items.map((i) => (i.kind === 'file' ? i.entry.path : i.path))).toEqual([
      '.dvignore',
      '.ignore',
      'AGENTS.md',
    ]);
  });

  it('records an access_denied entry as a refused listing item, never as a silent drop', async () => {
    // Never observed `true` against the live (OWNER-access) account — the field and its meaning
    // come from the OpenAPI `FileEntry` schema (locked decision 8's per-entry sibling).
    const page = {
      items: [{ path: 'secret/plan.md', mode: 33188, access_denied: true, blob: { size: 10, sha: 'x' } }],
    };
    const { http, blobHttp } = indexFakes({ treePage: () => ({ status: 200, body: page }) });
    const source = new DiversionIndexSource(REPO_ID, 'dv.commit.473', http, blobHttp);
    const items = [];
    for await (const item of source.list()) items.push(item);
    expect(items).toEqual([
      {
        kind: 'refused',
        path: 'secret/plan.md',
        reason: 'unreadable',
        detail: expect.stringContaining('access-denied'),
      },
    ]);
  });

  it('a non-200 tree response refuses to enumerate — never reports an empty tree', async () => {
    const { http, blobHttp } = indexFakes({ treePage: () => ({ status: 401, body: UNAUTHORIZED_BODY }) });
    const source = new DiversionIndexSource(REPO_ID, 'dv.commit.473', http, blobHttp);
    const items = [];
    for await (const item of source.list()) items.push(item);
    expect(items).toEqual([
      { kind: 'refused', path: '.', reason: 'unreadable', detail: expect.stringContaining('401') },
    ]);
  });

  it('paginates via limit+skip and stops on a short page', async () => {
    // Synthetic — proving the CONTINUATION MECHANICS (skip advances, a short/empty page stops the
    // walk), not the API's content shape (that is what TREE_PAGE_SAMPLE proves). The page size is
    // an internal constant, so this drives the fake purely off the `skip` value it receives.
    const page1 = Array.from({ length: 2000 }, (_, i) => ({
      path: `f${String(i).padStart(4, '0')}`,
      mode: 33188,
      blob: { size: 1, sha: 'x' },
    }));
    const page2 = [{ path: 'zlast', mode: 33188, blob: { size: 1, sha: 'y' } }];
    const { http, blobHttp } = indexFakes({
      treePage: (skip) => ({ status: 200, body: { items: skip === 0 ? page1 : skip === 2000 ? page2 : [] } }),
    });
    const source = new DiversionIndexSource(REPO_ID, 'dv.commit.473', http, blobHttp);
    const paths = [];
    for await (const item of source.list()) if (item.kind === 'file') paths.push(item.entry.path);
    expect(paths.length).toBe(2001);
    expect(paths[0]).toBe('f0000');
    expect(paths.at(-1)).toBe('zlast');
  });

  it('through the shared policy pipeline: config/.env is denied and its content is NEVER fetched', async () => {
    // Locked decision 9, proved on THIS source specifically: the deny list lives only in
    // `index-scan.ts`, so this drives the REAL pipeline (`scanIndexSource`), not a hand-rolled
    // check, and asserts the blob transport was never called for the denied path.
    const page = { items: [{ path: 'config/.env', mode: 33188, blob: { size: 20, sha: 'x' } }] };
    const { http, blobHttp, blobCalls } = indexFakes({ treePage: () => ({ status: 200, body: page }) });
    const source = new DiversionIndexSource(REPO_ID, 'dv.commit.473', http, blobHttp);
    const result = await scanIndexSource(source, {
      include: [],
      exclude: [],
      languages: [],
      pollIntervalMinutes: 5,
      maxFiles: 1000,
      maxFileBytes: 1_000_000,
      maxTotalBytes: 10_000_000,
      readDeadlineMs: 60_000,
      contentMode: 'full',
    });
    expect(result.candidates).toEqual([]);
    expect(result.statuses).toEqual([{ path: 'config/.env', reason: 'denied', detail: expect.any(String) }]);
    expect(blobCalls).toEqual([]); // never read.
  });
});

describe('DiversionIndexSource — read() (RUN-255): /blobs?force_blob_embedding=true', () => {
  it('reads content within maxBytes', async () => {
    const { http, blobHttp } = indexFakes({
      blobs: { 'a.txt': { status: 200, bytes: Buffer.from('hello') } },
    });
    const source = new DiversionIndexSource(REPO_ID, 'dv.commit.473', http, blobHttp);
    expect(await source.read('a.txt', 100)).toEqual({
      ok: true,
      bytes: Buffer.from('hello'),
      overLimit: false,
    });
  });

  it('truncates and reports overLimit when the blob exceeds maxBytes (no measured byte-range read)', async () => {
    const { http, blobHttp } = indexFakes({
      blobs: { 'big.bin': { status: 200, bytes: Buffer.from('0123456789') } },
    });
    const source = new DiversionIndexSource(REPO_ID, 'dv.commit.473', http, blobHttp);
    expect(await source.read('big.bin', 4)).toEqual({
      ok: true,
      bytes: Buffer.from('0123'),
      overLimit: true,
    });
  });

  it('maps 404 to not-found', async () => {
    const { http, blobHttp } = indexFakes({ blobs: {} });
    const source = new DiversionIndexSource(REPO_ID, 'dv.commit.473', http, blobHttp);
    expect(await source.read('gone.txt', 100)).toMatchObject({ ok: false, reason: 'not-found' });
  });

  it('maps 410 (permanently unreachable — the on-demand fetch queue dead-lettered it) to not-found', async () => {
    const { http, blobHttp } = indexFakes({ blobs: { 'archived.bin': { status: 410 } } });
    const source = new DiversionIndexSource(REPO_ID, 'dv.commit.473', http, blobHttp);
    expect(await source.read('archived.bin', 100)).toMatchObject({ ok: false, reason: 'not-found' });
  });

  it('maps any other non-200 to unreadable', async () => {
    const { http, blobHttp } = indexFakes({ blobs: { 'bad.bin': { status: 500, detail: 'boom' } } });
    const source = new DiversionIndexSource(REPO_ID, 'dv.commit.473', http, blobHttp);
    expect(await source.read('bad.bin', 100)).toMatchObject({ ok: false, reason: 'unreadable' });
  });

  it("the scanner's own content hash is a fresh SHA-256 over the bytes, never the blob's sha (locked decision 6)", async () => {
    const content = Buffer.from('const x = 1;\n');
    const page = {
      items: [{ path: 'x.ts', mode: 33188, blob: { size: content.length, sha: 'not-the-hash' } }],
    };
    const { http, blobHttp } = indexFakes({
      treePage: () => ({ status: 200, body: page }),
      blobs: { 'x.ts': { status: 200, bytes: content } },
    });
    const source = new DiversionIndexSource(REPO_ID, 'dv.commit.473', http, blobHttp);
    const result = await scanIndexSource(source, {
      include: [],
      exclude: [],
      languages: [],
      pollIntervalMinutes: 5,
      maxFiles: 10,
      maxFileBytes: 1_000_000,
      maxTotalBytes: 1_000_000,
      readDeadlineMs: 60_000,
      contentMode: 'full',
    });
    expect(result.candidates).toHaveLength(1);
    const expectedHash = createHash('sha256').update(content).digest('hex');
    expect(result.candidates[0]!.contentHash).toBe(expectedHash);
    expect(result.candidates[0]!.contentHash).not.toBe('not-the-hash');
  });
});

describe('DiversionIndexSource — digest() (RUN-255): a free lookup off list(), never the index hash', () => {
  it('returns the sha cached during list() without a second round trip', async () => {
    const { http, blobHttp, httpCalls } = indexFakes({
      treePage: () => ({ status: 200, body: TREE_PAGE_SAMPLE }),
    });
    const source = new DiversionIndexSource(REPO_ID, 'dv.commit.473', http, blobHttp);
    for await (const _ of source.list()) {
      /* drain to populate the digest cache */
    }
    const before = httpCalls.length;
    expect(await source.digest('.dvignore')).toBe('de7a666');
    expect(httpCalls.length).toBe(before); // no new call.
  });

  it('falls back to a live files/{ref}/{path} lookup for an uncached path', async () => {
    const { http, blobHttp } = indexFakes({
      fileEntries: { 'a.txt': { path: 'a.txt', blob: { sha: 'abc123' } } },
    });
    const source = new DiversionIndexSource(REPO_ID, 'dv.commit.473', http, blobHttp);
    expect(await source.digest('a.txt')).toBe('abc123');
  });

  it('returns undefined for a path with no entry anywhere', async () => {
    const { http, blobHttp } = indexFakes({});
    const source = new DiversionIndexSource(REPO_ID, 'dv.commit.473', http, blobHttp);
    expect(await source.digest('nope.txt')).toBeUndefined();
  });
});

describe('DiversionIndexSource — verify-then-read local fast path (RUN-281)', () => {
  let localRoot: string;

  beforeEach(async () => {
    localRoot = await mkdtemp(path.join(tmpdir(), 'noriq-dv-verify-'));
  });

  afterEach(async () => {
    await rm(localRoot, { recursive: true, force: true });
  });

  /** A transport that FAILS the test outright if the fast path ever falls through to it — the
   *  acceptance line's own words: "proven by a fake transport that fails the test if called." */
  const failingBlobHttp: DvBlobHttp = async (_repoId, _refId, filePath) => {
    throw new Error(`the verify-then-read fast path must not fetch content over HTTP for ${filePath}`);
  };

  it('reads local bytes and matches the depot digest with ZERO content HTTP calls', async () => {
    const content = Buffer.from('export const x = 1;\n');
    const sha1 = createHash('sha1').update(content).digest('hex');
    await writeFile(path.join(localRoot, 'x.ts'), content);
    const page = { items: [{ path: 'x.ts', mode: 33188, blob: { size: content.length, sha: sha1 } }] };
    const { http } = indexFakes({ treePage: () => ({ status: 200, body: page }) });
    const source = new DiversionIndexSource(REPO_ID, 'dv.commit.473', http, failingBlobHttp, localRoot);
    for await (const _ of source.list()) {
      /* drain to populate the digest cache */
    }
    // Not a throw: `failingBlobHttp` above would already have failed this test had `read()`
    // fallen through to it.
    expect(await source.read('x.ts', 1_000_000)).toEqual({ ok: true, bytes: content, overLimit: false });
  });

  it('falls back to HTTP on a hash mismatch — the DEPOT bytes reach the record, never the tampered local ones', async () => {
    const depotContent = Buffer.from('export const x = 1;\n');
    const sha1 = createHash('sha1').update(depotContent).digest('hex');
    // A local file that exists, at the right path, but with DIFFERENT bytes — the exact case a
    // stale or dirty pool-of-1 checkout produces.
    await writeFile(path.join(localRoot, 'x.ts'), 'this is NOT what the depot has at this commit');
    const page = { items: [{ path: 'x.ts', mode: 33188, blob: { size: depotContent.length, sha: sha1 } }] };
    const { http, blobHttp, blobCalls } = indexFakes({
      treePage: () => ({ status: 200, body: page }),
      blobs: { 'x.ts': { status: 200, bytes: depotContent } },
    });
    const source = new DiversionIndexSource(REPO_ID, 'dv.commit.473', http, blobHttp, localRoot);
    for await (const _ of source.list()) {
      /* drain to populate the digest cache */
    }
    expect(await source.read('x.ts', 1_000_000)).toEqual({
      ok: true,
      bytes: depotContent,
      overLimit: false,
    });
    expect(blobCalls).toEqual(['x.ts']); // fell back exactly once, silently — no error surfaced.
  });

  it('a missing local file falls back to HTTP with no error surfaced to the caller', async () => {
    const content = Buffer.from('hello from the depot');
    const sha1 = createHash('sha1').update(content).digest('hex');
    // Nothing written under `localRoot` for this path at all.
    const page = { items: [{ path: 'missing.ts', mode: 33188, blob: { size: content.length, sha: sha1 } }] };
    const { http, blobHttp, blobCalls } = indexFakes({
      treePage: () => ({ status: 200, body: page }),
      blobs: { 'missing.ts': { status: 200, bytes: content } },
    });
    const source = new DiversionIndexSource(REPO_ID, 'dv.commit.473', http, blobHttp, localRoot);
    for await (const _ of source.list()) {
      /* drain to populate the digest cache */
    }
    expect(await source.read('missing.ts', 1_000_000)).toEqual({
      ok: true,
      bytes: content,
      overLimit: false,
    });
    expect(blobCalls).toEqual(['missing.ts']);
  });

  it('an unreadable local file (a directory at the candidate path) falls back to HTTP with no error', async () => {
    const content = Buffer.from('hello from the depot');
    const sha1 = createHash('sha1').update(content).digest('hex');
    await mkdir(path.join(localRoot, 'weird.ts')); // a directory, not a file, at the candidate path.
    const page = { items: [{ path: 'weird.ts', mode: 33188, blob: { size: content.length, sha: sha1 } }] };
    const { http, blobHttp, blobCalls } = indexFakes({
      treePage: () => ({ status: 200, body: page }),
      blobs: { 'weird.ts': { status: 200, bytes: content } },
    });
    const source = new DiversionIndexSource(REPO_ID, 'dv.commit.473', http, blobHttp, localRoot);
    for await (const _ of source.list()) {
      /* drain to populate the digest cache */
    }
    expect(await source.read('weird.ts', 1_000_000)).toEqual({ ok: true, bytes: content, overLimit: false });
    expect(blobCalls).toEqual(['weird.ts']);
  });

  it('the set of indexed PATHS is identical whether a local root is offered or not — list() never consults it', async () => {
    const { http, blobHttp } = indexFakes({ treePage: () => ({ status: 200, body: TREE_PAGE_SAMPLE }) });
    const withoutRoot = new DiversionIndexSource(REPO_ID, 'dv.commit.473', http, blobHttp);
    const withRoot = new DiversionIndexSource(REPO_ID, 'dv.commit.473', http, blobHttp, localRoot);
    const collect = async (source: DiversionIndexSource) => {
      const paths: string[] = [];
      for await (const item of source.list()) if (item.kind === 'file') paths.push(item.entry.path);
      return paths;
    };
    expect(await collect(withRoot)).toEqual(await collect(withoutRoot));
  });

  it('contentHash is IDENTICAL whether scanIndexSource read the file locally (verified) or over HTTP — the property that makes this admissible at all', async () => {
    const content = Buffer.from('const x: number = 42;\nexport default x;\n');
    const sha1 = createHash('sha1').update(content).digest('hex');
    await writeFile(path.join(localRoot, 'x.ts'), content);
    const page = { items: [{ path: 'x.ts', mode: 33188, blob: { size: content.length, sha: sha1 } }] };
    const scanCfg = {
      include: [],
      exclude: [],
      languages: [],
      pollIntervalMinutes: 5,
      maxFiles: 10,
      maxFileBytes: 1_000_000,
      maxTotalBytes: 1_000_000,
      readDeadlineMs: 60_000,
      contentMode: 'full' as const,
    };

    const local = indexFakes({ treePage: () => ({ status: 200, body: page }) });
    const localSource = new DiversionIndexSource(
      REPO_ID,
      'dv.commit.473',
      local.http,
      local.blobHttp,
      localRoot,
    );
    const localResult = await scanIndexSource(localSource, scanCfg);

    const remote = indexFakes({
      treePage: () => ({ status: 200, body: page }),
      blobs: { 'x.ts': { status: 200, bytes: content } },
    });
    const remoteSource = new DiversionIndexSource(REPO_ID, 'dv.commit.473', remote.http, remote.blobHttp);
    const remoteResult = await scanIndexSource(remoteSource, scanCfg);

    expect(local.blobCalls).toEqual([]); // proves the local pass never touched content HTTP.
    expect(remote.blobCalls).toEqual(['x.ts']); // proves the remote pass did — same content either way.
    expect(localResult.candidates).toHaveLength(1);
    expect(remoteResult.candidates).toHaveLength(1);
    expect(localResult.candidates[0]!.contentHash).toBe(remoteResult.candidates[0]!.contentHash);
    expect(localResult.candidates[0]!.contentHash).toBe(createHash('sha256').update(content).digest('hex'));
  });

  it('minReadDeadlineMs is declared on the source — the floor index-work.ts folds into readDeadlineMs', () => {
    const { http, blobHttp } = indexFakes({});
    const source = new DiversionIndexSource(REPO_ID, 'dv.commit.473', http, blobHttp);
    expect(source.minReadDeadlineMs).toBeGreaterThan(0);
    expect(source.minReadDeadlineMs).toBeGreaterThan(120_000); // above the filesystem-calibrated default.
  });
});

describe('DiversionBackend — changesBetween (RUN-255): real diff via /compare', () => {
  it('reports a real modification as changed', async () => {
    const { http, blobHttp } = indexFakes({
      compare: { status: 200, body: { items: [COMPARE_MODIFY_ITEM] } },
    });
    const backend = new DiversionBackend({ repoId: REPO_ID, http, blobHttp, cli: dummyCli });
    const res = await backend.changesBetween('/repo', 'dv.commit.472', 'dv.commit.473');
    expect(res).toEqual({
      ok: true,
      changed: [
        'Plugins/NodCharacterCreator/Source/NodCoreTechRuntime/Private/NodRuntimeGarmentFitEvaluator.cpp',
      ],
      deleted: [],
    });
  });

  it('reports a plain deletion as deleted, never as changed', async () => {
    const { http, blobHttp } = indexFakes({
      compare: { status: 200, body: { items: [COMPARE_DELETE_ITEM] } },
    });
    const backend = new DiversionBackend({ repoId: REPO_ID, http, blobHttp, cli: dummyCli });
    const res = await backend.changesBetween('/repo', 'dv.commit.12', 'dv.commit.13');
    expect(res).toEqual({ ok: true, changed: [], deleted: ['.ignore'] });
  });

  it('reports a rename as prev_path in deleted, current path in changed — no rename-specific shape', async () => {
    const { http, blobHttp } = indexFakes({
      compare: { status: 200, body: { items: [COMPARE_RENAME_ITEM] } },
    });
    const backend = new DiversionBackend({ repoId: REPO_ID, http, blobHttp, cli: dummyCli });
    const res = await backend.changesBetween('/repo', 'dv.commit.7', 'dv.commit.8');
    expect(res).toEqual({
      ok: true,
      changed: ['Plugins/NodEcs/Source/NodEcs/Public/Entity/EcsEntityHandle.h'],
      deleted: ['Plugins/NodEcs/Source/NodEcs/Public/Entity/EntityHandle.h'],
    });
  });

  it('filters directory-mode items out of both changed and deleted', async () => {
    const { http, blobHttp } = indexFakes({
      compare: { status: 200, body: { items: [COMPARE_DIRECTORY_ADD_ITEM, COMPARE_MODIFY_ITEM] } },
    });
    const backend = new DiversionBackend({ repoId: REPO_ID, http, blobHttp, cli: dummyCli });
    const res = await backend.changesBetween('/repo', 'dv.commit.442', 'dv.commit.443');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.changed).not.toContain('Config');
      expect(res.changed).toHaveLength(1); // only the file-mode item survived.
    }
  });

  it('escalates on has_restricted_files rather than treating the listing as complete (locked decision 8)', async () => {
    // Never measured `true` against the live (OWNER-access) account — the field and its meaning
    // come from the OpenAPI `ComparisonList` response schema.
    const { http, blobHttp } = indexFakes({
      compare: { status: 200, body: { items: [COMPARE_MODIFY_ITEM], has_restricted_files: true } },
    });
    const backend = new DiversionBackend({ repoId: REPO_ID, http, blobHttp, cli: dummyCli });
    const res = await backend.changesBetween('/repo', 'dv.commit.472', 'dv.commit.473');
    expect(res).toMatchObject({
      ok: false,
      reason: 'full-index-required',
      detail: expect.stringContaining('has_restricted_files'),
    });
  });

  it('escalates on an unrecognized status code rather than guessing (locked decision 4)', async () => {
    const bogus = { status: 99, other_item: { path: 'x.ts', mode: 33188 } };
    const { http, blobHttp } = indexFakes({ compare: { status: 200, body: { items: [bogus] } } });
    const backend = new DiversionBackend({ repoId: REPO_ID, http, blobHttp, cli: dummyCli });
    const res = await backend.changesBetween('/repo', 'dv.commit.1', 'dv.commit.2');
    expect(res).toMatchObject({
      ok: false,
      reason: 'full-index-required',
      detail: expect.stringContaining('99'),
    });
  });

  it('escalates when a compare item carries no other_item at all (defensive — never measured live)', async () => {
    const { http, blobHttp } = indexFakes({ compare: { status: 200, body: { items: [{ status: 4 }] } } });
    const backend = new DiversionBackend({ repoId: REPO_ID, http, blobHttp, cli: dummyCli });
    const res = await backend.changesBetween('/repo', 'dv.commit.1', 'dv.commit.2');
    expect(res).toMatchObject({ ok: false, reason: 'full-index-required' });
  });

  it('a non-200 compare response escalates to full-index-required, never an empty diff', async () => {
    const { http, blobHttp } = indexFakes({ compare: { status: 401, body: UNAUTHORIZED_BODY } });
    const backend = new DiversionBackend({ repoId: REPO_ID, http, blobHttp, cli: dummyCli });
    const res = await backend.changesBetween('/repo', 'dv.commit.1', 'dv.commit.2');
    expect(res).toMatchObject({
      ok: false,
      reason: 'full-index-required',
      detail: expect.stringContaining('401'),
    });
  });

  it(`exceeds ${CHANGES_BETWEEN_MAX_PATHS}-path cap → full-index-required`, async () => {
    const items = Array.from({ length: CHANGES_BETWEEN_MAX_PATHS + 1 }, (_, i) => ({
      status: 2,
      other_item: { path: `f${i}.ts`, mode: 33188 },
    }));
    const { http, blobHttp } = indexFakes({ compare: { status: 200, body: { items } } });
    const backend = new DiversionBackend({ repoId: REPO_ID, http, blobHttp, cli: dummyCli });
    const res = await backend.changesBetween('/repo', 'dv.commit.1', 'dv.commit.2');
    expect(res).toMatchObject({
      ok: false,
      reason: 'full-index-required',
      detail: expect.stringContaining('cap'),
    });
  });
});

describe('DiversionBackend — locking (RUN-100): Noriq view authoritative, soft lock degrades', () => {
  const ctx = { projectId: 'prj_x', token: 'run-token', branch: 'main', taskId: 'task_9' };

  it('acquires the Noriq view AND posts a native soft lock on a Pro workspace', async () => {
    const { locks, calls: lockCalls } = fakeLocks({
      ok: true,
      enabled: true,
      locks: [{ id: 'lk', path: 'a.ts' }],
    });
    const { backend, calls } = fakes({ locks });
    const ws = await backend.lease('/repo', 'run_1');
    const out = await backend.lock(ws, ['a.ts'], ctx);
    expect(out).toEqual({ ok: true, enabled: true, locks: [{ id: 'lk', path: 'a.ts' }] });
    expect(lockCalls[0]).toMatchObject({ method: 'acquire', token: 'run-token' });
    expect(calls.some((c) => c.what === 'POST /repos/dv.repo.test/locks')).toBe(true);
  });

  it('degrades to the Noriq layer alone when soft locks are unavailable (non-Pro) — grant still stands', async () => {
    const { locks } = fakeLocks({ ok: true, enabled: true, locks: [] });
    const { backend } = fakes({ locks, softLockUnavailable: true });
    const ws = await backend.lease('/repo', 'run_1');
    // The native 402 must not fail the grant the Noriq view made.
    expect(await backend.lock(ws, ['a.ts'], ctx)).toEqual({ ok: true, enabled: true, locks: [] });
  });

  it('a Noriq conflict is all-or-nothing — no native soft lock attempted', async () => {
    const { locks } = fakeLocks({ ok: false, conflicts: [{ path: 'a.ts', holder: 'agt_other' }] });
    const { backend, calls } = fakes({ locks });
    const ws = await backend.lease('/repo', 'run_1');
    expect(await backend.lock(ws, ['a.ts'], ctx)).toEqual({
      ok: false,
      conflicts: [{ path: 'a.ts', holder: 'agt_other' }],
    });
    expect(calls.some((c) => c.what.endsWith('/locks'))).toBe(false);
  });

  it('no lock view wired → disabled, no HTTP', async () => {
    const { backend, calls } = fakes({});
    const ws = await backend.lease('/repo', 'run_1');
    const before = calls.length;
    expect(await backend.lock(ws, ['a.ts'], ctx)).toEqual({ ok: true, enabled: false, locks: [] });
    expect(calls.slice(before).some((c) => c.what.endsWith('/locks'))).toBe(false);
  });
});
