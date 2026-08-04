import type { ModelDefault, PermissionProfile, ProjectManifest, Run, RunBudget } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import type { RunAgent } from '../src/client';
import type { AgentDriver, DriverCapabilities, DriverSession } from '../src/drivers/types';
import type { LockConflict } from '../src/lock-client';
import { type PrepareHost, prepareRun } from '../src/stages';
import type { ResolvedRepo, RunReport } from '../src/supervisor';
import type { LockContext, LockOutcome, Workspace } from '../src/vcs/types';

// RUN-131. `supervise` used to resolve, lease, identify, lock and brief a run inline, so the ONLY
// way to ask "what does a dispatch refusal do" was to drive a whole supervisor and read the report
// it emitted. Preparation is a function now, and these are the questions that became askable:
// which refusals happen BEFORE anything is leased, what each one unwinds, and what the resulting
// start options deliberately do NOT carry.

const perm = (write: boolean): PermissionProfile => ({
  write,
  allow: [],
  deny: [],
  auto: false,
});
const noModel = (): ModelDefault => ({ agent: null, model: null, effort: null });
const manifest = (over: Partial<ProjectManifest> = {}): ProjectManifest => ({
  key: 'PROJ',
  board: null,
  verify: { cmd: 'npm test', timeoutSeconds: null, shell: null, maxRounds: 2, agent: null },
  context: { requiredReading: [], entryPoints: [], conventions: [], agentInstructions: 'inline' as const },
  tool: null,
  defaultBranch: null,
  land: null,
  setup: null,
  permissions: { scope: perm(false), build: perm(true), verify: perm(false) },
  defaults: { scope: noModel(), build: noModel(), verify: noModel() },
  workflows: {},
  ...over,
});

const makeRun = (over: Partial<Run> = {}): Run => ({
  id: 'run_1',
  projectId: 'prj_p',
  runnerId: 'rnr_1',
  agentId: null,
  planKey: null,
  targetBranch: null,
  kind: 'build',
  anchor: null,
  verifiesRunId: null,
  brief: 'ship the thing',
  repoRef: 'repo_a',
  agentTool: 'claude',
  agent: null,
  workflow: null,
  model: null,
  effort: null,
  budget: { maxTokens: null, maxUsd: null, maxDurationSeconds: null, maxRounds: null },
  status: 'dispatched',
  phase: null,
  exit: null,
  worktreePath: null,
  modelUsage: null,
  createdBy: 'usr_1',
  createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
  dispatchedAt: '2026-07-14T00:00:00.000Z',
  startedAt: null,
  ...over,
});

const CAPS: DriverCapabilities = {
  toolHooks: true,
  steer: true,
  interrupt: true,
  resumableSession: true,
  perModelTelemetry: true,
};
const driver: AgentDriver = {
  tool: 'claude',
  capabilities: CAPS,
  catalog: { models: [], efforts: [] },
  start: () => ({}) as DriverSession,
};

const ws = (over: Partial<Workspace> = {}): Workspace => ({
  runId: 'run_1',
  localPath: '/wt/run_1',
  readOnly: false,
  workRef: 'noriq/run/run_1',
  baseId: 'basesha',
  location: { branch: 'noriq/run/run_1' },
  ...over,
});

/** Everything the fake host recorded, so a test can assert on ORDER of effects, not just the
 *  returned outcome — "refused before the lease" is the whole point of half these paths. */
interface Recorder {
  leases: number;
  disposals: string[];
  reports: RunReport[];
  comments: string[];
  identities: number;
  lockCalls: Array<{ paths: string[]; ctx: LockContext }>;
}

function harness(
  over: {
    repo?: ResolvedRepo | null;
    driver?: AgentDriver | undefined;
    claimGate?: { claimable: boolean; reason: string | null } | null;
    claimThrows?: boolean;
    leaseThrows?: string;
    identity?: 'ok' | 'absent' | 'throws';
    lockScope?: string[];
    lockConflicts?: LockConflict[];
    /** git-shaped by default: a live backend's dispose preserves the work itself (RUN-52). */
    disposePreservesWork?: boolean;
    hasWork?: boolean | 'throws';
    /** The run's ceiling (RUN-133). Absent = unbounded, which is every other test here. */
    ceiling?: RunBudget;
  } = {},
) {
  const rec: Recorder = {
    leases: 0,
    disposals: [],
    reports: [],
    comments: [],
    identities: 0,
    lockCalls: [],
  };
  const repo: ResolvedRepo | null =
    over.repo === undefined ? { root: '/repo', manifest: manifest() } : over.repo;

  const vcs = {
    kind: 'git' as const,
    ...(over.disposePreservesWork ? { disposePreservesWork: true } : {}),
    lease: async (): Promise<Workspace> => {
      rec.leases += 1;
      if (over.leaseThrows) throw new Error(over.leaseThrows);
      return ws();
    },
    dispose: async (w: Workspace): Promise<void> => {
      rec.disposals.push(w.localPath);
    },
    hasWork: async (): Promise<boolean> => {
      if (over.hasWork === 'throws') throw new Error('git exploded');
      return over.hasWork ?? false;
    },
    ...(over.lockScope
      ? {
          lock: async (_w: Workspace, paths: string[], ctx: LockContext): Promise<LockOutcome> => {
            rec.lockCalls.push({ paths, ctx });
            return over.lockConflicts?.length
              ? { ok: false, conflicts: over.lockConflicts }
              : { ok: true, enabled: true, locks: paths.map((p) => ({ id: p, path: p })) };
          },
        }
      : {}),
  };

  const host: PrepareHost = {
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    report: (_id, frame) => rec.reports.push(frame),
    postComment: (_p, _t, body) => rec.comments.push(body),
    transcript: () => ({ milestone: () => {}, text: () => {} }) as never,
    server: 'https://noriq.test',
    resolveRepo: async () => repo,
    // `Object.hasOwn`, not a `?? driver` default: the point of the "no driver" test is passing an
    // explicit undefined, which a default would quietly turn back into a driver.
    driverFor: () => (Object.hasOwn(over, 'driver') ? over.driver : driver),
    vcsFor: () => vcs as never,
    ...(over.claimGate !== undefined || over.claimThrows
      ? {
          checkClaimable: async () => {
            if (over.claimThrows) throw new Error('server down');
            return over.claimGate ?? null;
          },
        }
      : {}),
    planBase: async () => null,
    ...(over.identity === 'absent'
      ? {}
      : {
          createRunAgent: async (): Promise<RunAgent> => {
            rec.identities += 1;
            if (over.identity === 'throws') throw new Error('agent service down');
            return {
              agentId: 'agt_1',
              label: 'build-abc',
              token: 'tok_run',
              projectId: 'prj_p',
              expiresIn: 3600,
            };
          },
        }),
    resolveAnchorTask: async () => null,
    ...(over.lockScope ? { resolveLockScope: () => over.lockScope ?? [] } : {}),
    lockScopeBranch: () => 'main',
    lockEnforcerFor: () => undefined,
    runBudget: () => over.ceiling ?? null,
    // No disk: the `[context]` seams are injected, so preparation reads nothing real. Every
    // declared path is "missing", which is the shape a repo with no `[context]` already has.
    context: { probe: async () => false, read: async () => '' },
  };
  return { host, rec };
}

describe('prepare refuses a dispatch, and says so instead of throwing', () => {
  it('an unresolvable repo — before a driver is even looked up', async () => {
    const { host, rec } = harness({ repo: null });
    const out = await prepareRun(host, makeRun());
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toMatch(/repo not found for repoRef repo_a/);
    expect(rec.leases).toBe(0);
  });

  it('a tool with no driver', async () => {
    const { host, rec } = harness({ driver: undefined });
    const out = await prepareRun(host, makeRun());
    expect(out.ok === false && out.reason).toMatch(/no driver for tool claude/);
    expect(rec.leases).toBe(0);
  });

  // The ordering RUN-81 depends on: the phase gate is consulted BEFORE the lease, so a run the
  // server should not have offered leaves no workspace behind to reap.
  it('a task whose plan phase is not unlocked — and leases nothing on the way out', async () => {
    const { host, rec } = harness({ claimGate: { claimable: false, reason: 'phase 1 in review' } });
    const out = await prepareRun(host, makeRun({ anchor: { type: 'task', taskId: 'task_9' } }));
    expect(out.ok === false && out.reason).toMatch(/not claimable yet.*phase 1 in review/s);
    expect(rec.leases).toBe(0);
    expect(rec.identities).toBe(0);
  });

  it('but a probe that FAILS spawns anyway — the gate is defense in depth, not the authority', async () => {
    const { host, rec } = harness({ claimThrows: true });
    const out = await prepareRun(host, makeRun({ anchor: { type: 'task', taskId: 'task_9' } }));
    expect(out.ok).toBe(true);
    expect(rec.leases).toBe(1);
  });

  it('a verify run whose build is gone names the build, not just the git error', async () => {
    const { host } = harness({ leaseThrows: 'no such ref' });
    const out = await prepareRun(host, makeRun({ kind: 'verify', verifiesRunId: 'run_0' }));
    expect(out.ok === false && out.reason).toMatch(/cannot verify run_0: its work is not in this repo/);
  });

  it('a lease failure with nothing to verify reports the setup failure plainly', async () => {
    const { host } = harness({ leaseThrows: 'disk full' });
    const out = await prepareRun(host, makeRun());
    expect(out.ok === false && out.reason).toMatch(/workspace setup failed: disk full/);
  });
});

describe('a refusal after the lease unwinds what it took', () => {
  it('no identity dep at all — disposes the workspace it just leased', async () => {
    const { host, rec } = harness({ identity: 'absent' });
    const out = await prepareRun(host, makeRun());
    expect(out.ok === false && out.reason).toMatch(/no Noriq identity for this run/);
    expect(rec.disposals).toEqual(['/wt/run_1']);
  });

  it('an identity service that fails — same unwind, different reason', async () => {
    const { host, rec } = harness({ identity: 'throws' });
    const out = await prepareRun(host, makeRun());
    expect(out.ok === false && out.reason).toMatch(/could not create the Noriq agent.*agent service down/);
    expect(rec.disposals).toEqual(['/wt/run_1']);
  });
});

describe('the predictive lock refusal (RUN-103/130)', () => {
  const held: LockConflict[] = [{ path: 'src/a.ts', holder: 'agt_other', holderName: 'peer' }];

  it('refuses the dispatch, comments on the anchor task, and disposes an EMPTY workspace', async () => {
    const { host, rec } = harness({ lockScope: ['src/a.ts'], lockConflicts: held, hasWork: false });
    const out = await prepareRun(host, makeRun({ anchor: { type: 'task', taskId: 'task_9' } }));
    expect(out.ok === false && out.reason).toMatch(/declared file scope is locked by another run/);
    expect(rec.comments).toHaveLength(1);
    expect(rec.disposals).toEqual(['/wt/run_1']);
  });

  // RUN-130: a continuation is precisely what declares a scope today, so this refusal fires
  // exactly where the workspace carries the prior sitting's committed diff.
  it('KEEPS a workspace that holds work — dispose would destroy a diff that exists nowhere else', async () => {
    const { host, rec } = harness({ lockScope: ['src/a.ts'], lockConflicts: held, hasWork: true });
    const out = await prepareRun(host, makeRun());
    expect(out.ok).toBe(false);
    expect(rec.disposals).toEqual([]);
  });

  // RUN-152: "could not tell" is not "no work".
  it('keeps it when the probe REJECTS, rather than reading the failure as an empty tree', async () => {
    const { host, rec } = harness({ lockScope: ['src/a.ts'], lockConflicts: held, hasWork: 'throws' });
    await prepareRun(host, makeRun());
    expect(rec.disposals).toEqual([]);
  });

  // RUN-52: on a live backend dispose IS how the work is preserved and the lease returns to the
  // pool, so skipping it there preserves nothing and wedges the next run on this repo.
  it('still disposes on a backend whose dispose preserves the work itself', async () => {
    const { host, rec } = harness({
      lockScope: ['src/a.ts'],
      lockConflicts: held,
      hasWork: true,
      disposePreservesWork: true,
    });
    await prepareRun(host, makeRun());
    expect(rec.disposals).toEqual(['/wt/run_1']);
  });
});

describe('what preparation hands to execute', () => {
  it('resolves the start options but owns neither the env nor the handlers', async () => {
    const { host } = harness();
    const out = await prepareRun(host, makeRun());
    if (!out.ok) throw new Error(out.reason);
    // `env` is the supervisor's single sanitization point (RUN-109) and `handlers` are how execute
    // accumulates the verdict text — a prepare that set either would move a trust boundary or
    // silently disconnect the dashboard.
    expect(out.start).not.toHaveProperty('env');
    expect(out.start).not.toHaveProperty('handlers');
    expect(out.start.runId).toBe('run_1');
    expect(out.start.cwd).toBe('/wt/run_1');
    expect(out.start.prompt.length).toBeGreaterThan(0);
  });

  it('a build with a verify command keeps its session open for the hand-back loop (RUN-29)', async () => {
    const { host } = harness();
    const out = await prepareRun(host, makeRun());
    expect(out.ok && out.start.multiTurn).toBe(true);
  });

  it('a scope run does not — nothing can hand work back to it', async () => {
    const { host } = harness();
    const out = await prepareRun(host, makeRun({ kind: 'scope' }));
    expect(out.ok && out.start.multiTurn).toBe(false);
  });

  it('reports the workspace and the identity as soon as each is known', async () => {
    const { host, rec } = harness();
    await prepareRun(host, makeRun());
    expect(rec.reports[0]).toMatchObject({ status: 'running', worktreePath: '/wt/run_1', phase: 'agent' });
    expect(rec.reports[1]).toMatchObject({ status: 'running', agentId: 'agt_1' });
  });

  it('starts an empty tally when there is nothing to continue', async () => {
    const { host } = harness();
    const out = await prepareRun(host, makeRun());
    expect(out.ok && out.continued).toBeNull();
    expect(out.ok && out.tally.total().outputTokens).toBe(0);
  });

  // RUN-92/59: a continue must report CUMULATIVE spend, or the server's totals get overwritten
  // with only what this sitting cost.
  it('seeds the tally from a prior sitting so the run keeps summing', async () => {
    const { host } = harness();
    const seeded: PrepareHost = {
      ...host,
      continuable: {
        get: async () => ({
          runId: 'run_1',
          spent: { tokens: 900, usd: 1.5 },
          ledger: [],
          failedAt: '2026-07-20T00:00:00.000Z',
        }),
      },
    };
    const out = await prepareRun(seeded, makeRun());
    if (!out.ok) throw new Error(out.reason);
    expect(out.continued?.spent.tokens).toBe(900);
    expect(out.tally.total().costUsd).toBe(1.5);
  });
});
