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
  repositoryKey: null,
  index: null,
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
  // PLNR-366: orchestration assignment is additive and null on every run this repo's own
  // fixtures still dispatch without negotiating orchestration.v1.
  execution: null,
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
  executionProfile: null,
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
const codexDriver: AgentDriver = {
  tool: 'codex',
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
    /** A per-tool driver table (RUN-193): when present, `driverFor` keys by the requested tool, so
     *  a stage coordinate naming another vendor selects (or fails to find) the right driver. */
    drivers?: Record<string, AgentDriver | undefined>;
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
    executionRegistry?: Map<string, string>;
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
    driverFor: (tool: string) =>
      over.drivers ? over.drivers[tool] : Object.hasOwn(over, 'driver') ? over.driver : driver,
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
    ...(over.executionRegistry ? { executionRegistry: () => over.executionRegistry! } : {}),
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

  it('a legacy dispatch prepares unchanged and carries a local root lineage', async () => {
    const { host, rec } = harness();
    const out = await prepareRun(host, makeRun({ execution: null }));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.lineage).toEqual({ type: 'legacy-root', assignment: null });
    expect(rec.leases).toBe(1);
    expect(rec.identities).toBe(1);
  });

  it('a self-parenting execution assignment refuses before anything is acquired', async () => {
    const { host, rec } = harness();
    const out = await prepareRun(
      host,
      makeRun({
        execution: {
          schemaVersion: 1,
          orchestrationId: 'orc_1',
          executionId: 'exe_1',
          parentExecutionId: 'exe_1',
          role: 'worker',
          lineageStatus: 'complete',
        },
      }),
    );
    expect(out.ok === false && out.reason).toMatch(/names itself as its parent/);
    expect(rec.leases).toBe(0);
    expect(rec.identities).toBe(0);
  });

  it('an execution already bound to another live run refuses before anything is acquired', async () => {
    const { host, rec } = harness({ executionRegistry: new Map([['exe_1', 'run_live']]) });
    const out = await prepareRun(
      host,
      makeRun({
        execution: {
          schemaVersion: 1,
          orchestrationId: 'orc_1',
          executionId: 'exe_1',
          parentExecutionId: null,
          role: 'worker',
          lineageStatus: 'complete',
        },
      }),
    );
    expect(out.ok === false && out.reason).toMatch(/already bound to live run run_live/);
    expect(rec.leases).toBe(0);
    expect(rec.identities).toBe(0);
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

  // RUN-196: an operator SELECTED this name from the advertised menu, and it no longer resolves —
  // the definition file deleted between advertise and dispatch. Falling back to a built-in would
  // run a prompt nobody chose; refusing costs nothing, like the claim gate above.
  it('a selected workflow that no longer resolves — before anything is acquired (RUN-196)', async () => {
    const { host, rec } = harness();
    const out = await prepareRun(host, makeRun({ workflow: 'ghost' }));
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toMatch(/workflow 'ghost' no longer resolves.*not spawning/s);
    expect(rec.leases).toBe(0);
    expect(rec.identities).toBe(0);
    expect(rec.reports).toEqual([]);
  });

  it('but a workflow naming a built-in kind always resolves — never a stale selection', async () => {
    const { host, rec } = harness();
    const out = await prepareRun(host, makeRun({ workflow: 'build' }));
    expect(out.ok).toBe(true);
    expect(rec.leases).toBe(1);
  });

  // A broken definition file is NOT a stale name (RUN-196): WorkflowStore keeps a scope-posture
  // tombstone for it, which still RESOLVES — a refusal here would bypass the tombstone, whose
  // point is that falling through to a lower, wider tier turns a typo into a permission change.
  it('and a broken-file tombstone still resolves — the refusal must not bypass it', async () => {
    const { host } = harness({
      repo: {
        root: '/repo',
        manifest: manifest(),
        workflowCatalog: {
          definitions: {
            audit: {
              base: 'scope',
              prompt: null,
              promptSource: null,
              stages: null,
              description: null,
              source: '/repo/.noriq/workflows/audit.toml',
              tier: 'project-file',
            },
          },
        },
      },
    });
    const out = await prepareRun(host, makeRun({ workflow: 'audit' }));
    expect(out.ok).toBe(true);
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

// RUN-193: the workflow's `[stages.execute] agent` picks the BUILDER's driver + model, at the top
// of the ladder — above the dispatch coordinate and [defaults.<kind>]. The source is a declared
// TOML stage list carried on the catalog, not a hand-built Workflow. Chain steps and a dispatched
// verify actor inherit this by spreading the same `start`, so this is where it is exercised.
describe("the execute stage's coordinate picks the builder's agent (RUN-193)", () => {
  const definition = (
    base: 'scope' | 'build' | 'verify',
    stages: import('@noriq-dev/shared').WorkflowStages | null,
  ) => ({
    base,
    prompt: null,
    promptSource: null,
    stages,
    description: null,
    source: '/repo/.noriq/workflows/fast.toml',
    tier: 'project-file' as const,
  });
  const repoWith = (
    base: 'scope' | 'build' | 'verify',
    stages: import('@noriq-dev/shared').WorkflowStages | null,
    manifestOver: Partial<ProjectManifest> = {},
  ): ResolvedRepo => ({
    root: '/repo',
    manifest: manifest(manifestOver),
    workflowCatalog: { definitions: { fast: definition(base, stages) } },
  });

  it('wins over the dispatch coordinate AND [defaults.build], selecting that vendor’s driver', async () => {
    const { host } = harness({
      drivers: { claude: driver, codex: codexDriver },
      repo: repoWith(
        'build',
        { execute: { agent: 'codex.gpt-5_6-sol.high' } },
        {
          defaults: {
            scope: noModel(),
            build: { agent: 'claude.opus-4_8.low', model: null, effort: null },
            verify: noModel(),
          },
        },
      ),
    });
    const out = await prepareRun(host, makeRun({ workflow: 'fast', agent: 'claude.sonnet-4_5.medium' }));
    if (!out.ok) throw new Error(out.reason);
    expect(out.driver.tool).toBe('codex');
    expect(out.start.model).toBe('gpt-5.6-sol');
    expect(out.start.effort).toBe('high');
  });

  it('absent stage agent leaves resolution byte-identical — the dispatch coordinate wins as before', async () => {
    const { host } = harness({
      drivers: { claude: driver, codex: codexDriver },
      repo: repoWith('build', null),
    });
    const out = await prepareRun(host, makeRun({ workflow: 'fast', agent: 'claude.sonnet-4_5.medium' }));
    if (!out.ok) throw new Error(out.reason);
    expect(out.driver.tool).toBe('claude');
    expect(out.start.model).toBe('sonnet-4.5');
    expect(out.start.effort).toBe('medium');
  });

  // Execute is a MANDATORY stage: a coordinate naming an uninstalled vendor cannot silently fall
  // back to the run's driver (the builder IS the run). Fail-closed, exactly as an undriveable
  // dispatch tool does, and before the lease.
  it('a stage coordinate naming a driverless tool refuses the run before anything is acquired', async () => {
    const { host, rec } = harness({
      drivers: { claude: driver },
      repo: repoWith('build', { execute: { agent: 'codex.gpt-5_6-sol.high' } }),
    });
    const out = await prepareRun(host, makeRun({ workflow: 'fast' }));
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toMatch(/no driver for tool codex/);
    expect(rec.leases).toBe(0);
  });

  // A coordinate chooses a MODEL, never a posture: the write floor is workflow-independent
  // (RUN-118), so a scope-based workflow with an execute agent still gets a read-only posture.
  it('does not widen write — a scope-based workflow with an execute agent stays read-only', async () => {
    const { host } = harness({
      drivers: { claude: driver, codex: codexDriver },
      repo: repoWith('scope', { execute: { agent: 'codex.gpt-5_6-sol.high' } }),
    });
    const out = await prepareRun(host, makeRun({ kind: 'scope', workflow: 'fast', agent: 'claude' }));
    if (!out.ok) throw new Error(out.reason);
    expect(out.driver.tool).toBe('codex'); // the model was chosen…
    expect(out.permission.write).toBe(false); // …the posture was not
  });

  // Acceptance 4: the dispatched verify actor IS a verify-based workflow's own execute stage, so its
  // coordinate is selected through the SAME prepare path as the builder — nothing verify-specific.
  it('a verify-based workflow’s execute coordinate selects the verify actor’s driver + model', async () => {
    const { host } = harness({
      drivers: { claude: driver, codex: codexDriver },
      repo: repoWith('verify', { execute: { agent: 'codex.gpt-5_6-sol.high' } }),
    });
    const out = await prepareRun(host, makeRun({ kind: 'verify', workflow: 'fast', verifiesRunId: 'run_0' }));
    if (!out.ok) throw new Error(out.reason);
    expect(out.driver.tool).toBe('codex');
    expect(out.start.model).toBe('gpt-5.6-sol');
    expect(out.start.effort).toBe('high');
    expect(out.permission.write).toBe(false); // verify judges, never edits (RUN-118) — model only
  });
});

// RUN-234: citation verification's own bounded metric, wired end to end through `prepareRun` —
// `citation-verify.test.ts` proves `summarizeCitationVerification`'s own counting; this proves
// prepare.ts actually calls it and logs the result once a pack was retrieved and verified.
describe('citation verification is logged as a bounded metric (RUN-234)', () => {
  const CONTEXT_REPO = () => ({
    root: '/repo',
    manifest: manifest({ repositoryKey: 'acme/widgets', defaultBranch: 'main' }),
  });

  /** Two citations at the workspace's OWN base (`ws().baseId`) — `classifyCitation` then never
   *  needs `changesBetween` at all (bases-equal path), so the fake `vcs` needs no such method.
   *  Neither path exists on real disk under `/wt/run_1` — the default `readCitationFile` reads
   *  ENOENT for both, so both verify as `missing`, deterministically, with no temp directory. */
  const pack = (citations: Array<{ path: string; verificationState: string }>) =>
    ({
      taskId: 'task_9',
      projectId: 'prj_p',
      branch: null,
      baseId: null,
      tokenBudget: null,
      verifiedDecisions: [],
      relevantEntities: [],
      similarEpisodes: [],
      knownHazards: [],
      affectedTests: [],
      activeNeighboringWork: [],
      staleWarnings: [],
      generatedAt: '2026-08-01T00:00:00.000Z',
      role: 'build',
      mode: 'keyword',
      charBudget: 4000,
      charsUsed: 100,
      taskFacts: {
        taskId: 'task_9',
        key: 'RUN-9',
        title: 't',
        body: null,
        status: 'todo',
        priority: 2,
        claimedBy: null,
        claimExpiresAt: null,
        openComments: [],
        executionSpec: null,
        executionSpecUnreadable: false,
      },
      sections: [
        {
          id: 'active_decisions',
          provenance: ['exact'],
          notice: null,
          charsAllotted: 500,
          charsUsed: 100,
          excerpts: [
            {
              excerptKind: 'memory',
              id: 'mem_1',
              memoryKind: 'decision',
              statement: 's',
              authority: 3,
              confidence: null,
              validity: 'active',
              isLead: false,
              leadReasons: [],
              evidence: citations.map((c) => ({
                repositoryKey: 'acme/widgets',
                branch: 'main',
                baseId: 'basesha',
                path: c.path,
                symbol: null,
                verificationState: c.verificationState,
                lastVerifiedAt: null,
                lastVerifiedBaseId: null,
                lastVerifiedBranch: null,
                verifiedForCaller: false,
              })),
              recordedByAgentId: null,
              recordedAt: '2026-08-01T00:00:00.000Z',
              supersedesMemoryId: null,
            },
          ],
          graphEntities: [],
          coverage: null,
          items: [],
        },
      ],
      notices: [],
    }) as never;

  it('logs total/byState/serverMismatches once a pack is retrieved and verified', async () => {
    const lines: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const { host } = harness({ repo: CONTEXT_REPO() });
    const withContext: PrepareHost = {
      ...host,
      log: {
        ...host.log,
        info: (msg: string, fields?: Record<string, unknown>) => lines.push({ msg, fields }),
      } as never,
      getContextPack: async () =>
        pack([
          { path: 'src/a.ts', verificationState: 'missing' }, // agrees — real verdict is also missing
          { path: 'src/b.ts', verificationState: 'valid' }, // disagrees — real verdict is missing
        ]),
    };

    const out = await prepareRun(withContext, makeRun({ anchor: { type: 'task', taskId: 'task_9' } }));

    if (!out.ok) throw new Error(out.reason);
    const line = lines.find((l) => l.msg === 'context pack citations verified');
    expect(line).toBeDefined();
    expect(line?.fields).toMatchObject({
      runId: 'run_1',
      total: 2,
      states: { valid: 0, moved: 0, changed: 0, missing: 2, unverifiable: 0 },
      serverMismatches: 1,
    });
  });

  it('logs nothing when there is no pack to verify (the ordinary, unopted-in case)', async () => {
    const lines: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const { host } = harness({ repo: CONTEXT_REPO() });
    const withNoContext: PrepareHost = {
      ...host,
      log: {
        ...host.log,
        info: (msg: string, fields?: Record<string, unknown>) => lines.push({ msg, fields }),
      } as never,
      // getContextPack absent — the ordinary posture for most repos today.
    };
    const out = await prepareRun(withNoContext, makeRun({ anchor: { type: 'task', taskId: 'task_9' } }));
    if (!out.ok) throw new Error(out.reason);
    expect(lines.find((l) => l.msg === 'context pack citations verified')).toBeUndefined();
  });
});
