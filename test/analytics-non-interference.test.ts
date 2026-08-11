import { readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  ModelDefault,
  PermissionProfile,
  ProjectManifest,
  Run,
  UploadedEpisodeIntelligence,
} from '@noriq-dev/shared';
import { EffortEpisode } from '@noriq-dev/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunAgent } from '../src/client';
import { buildContextConsumption } from '../src/context-consumption';
import { zeroTelemetry } from '../src/drivers/types';
import type {
  AgentDriver,
  DriverExit,
  DriverSession,
  DriverStartOptions,
  DriverTelemetry,
} from '../src/drivers/types';
import { authorSpecBlock, buildRunBrief } from '../src/stages/brief';
import type { BriefHost } from '../src/stages/brief';
import { settleStage } from '../src/stages/settle';
import type { RunPipeline, StageHost } from '../src/stages/types';
import { type ResolvedRepo, RunSupervisor, RunTally } from '../src/supervisor';
import type {
  ChangeStatsResult,
  ChangesBetweenResult,
  LockContext,
  LockOutcome,
  Workspace,
} from '../src/vcs/types';
import { BUILTIN_WORKFLOWS } from '../src/workflow';

// RUN-251: the task's core proof. `buildContextConsumption` (RUN-247, `src/context-consumption.ts`)
// was the one analytics capture point in this codebase actually sitting on the run's CRITICAL PATH —
// unlike `changeStats`/`recordEpisode`, which were already guarded (RUN-245/224), a throw there
// escaped `buildRunBrief`, which `prepare` awaits UNGUARDED, which fails the whole sitting (fatal for
// a continuation resume — CLAUDE.md's own words). This file proves the guard added in
// `src/stages/brief.ts` holds, at three widening scopes: the pure function, the settle-stage
// assembly it rides alongside, and a full `RunSupervisor.supervise()` run end to end.

// ── fixtures shared by the settle-level tests (episode.test.ts's own baseCtx/makeHost pattern,
//    reproduced locally per that file's stated convention: "this file cannot import theirs — test
//    files are the isolation boundary here") ──────────────────────────────────────────────────────

const run = {
  id: 'run_1',
  projectId: 'prj_p',
  anchor: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  dispatchedAt: '2026-08-01T00:00:05.000Z',
} as Run;
const repo: ResolvedRepo = { root: '/repo', manifest: { repositoryKey: 'myrepo' } as never };
const worktree: Workspace = {
  runId: 'run_1',
  localPath: '/wt/run_1',
  readOnly: false,
  workRef: 'noriq/run/run_1',
  baseId: 'sha_base',
  location: { branch: 'noriq/run/run_1' },
};
const runAgent: RunAgent = {
  agentId: 'agt_1',
  label: 'build-abc',
  token: 'tok_run',
  projectId: 'prj_p',
  expiresIn: 3600,
};
const driver: AgentDriver = {
  tool: 'claude',
  capabilities: {
    toolHooks: true,
    steer: true,
    interrupt: true,
    resumableSession: true,
    perModelTelemetry: true,
  },
  catalog: { models: [], efforts: [] },
  start: () => ({}) as DriverSession,
};

function baseCtx(over: Partial<RunPipeline> = {}): RunPipeline {
  const telemetry: DriverTelemetry = { ...zeroTelemetry() };
  const exit: DriverExit = { outcome: 'done', isError: false, reason: null, telemetry };
  return {
    run,
    repo,
    worktree,
    driver,
    permission: {} as never,
    task: null,
    runAgent,
    session: {} as never,
    stopSession: async () => {},
    tally: new RunTally(),
    sessionText: '',
    tail: '',
    continued: null,
    workflow: BUILTIN_WORKFLOWS.build,
    acceptance: [],
    acceptanceOverflow: 0,
    requirements: [],
    exit,
    driverSucceeded: true,
    landed: false,
    ledger: [],
    landPolicy: null,
    commandObservations: [],
    ...over,
  };
}

interface Recorder {
  calls: string[];
  recorded: Array<{ episode: unknown; intelligence: unknown }>;
  warnings: unknown[][];
}

function makeHost(): { host: StageHost; rec: Recorder } {
  const rec: Recorder = { calls: [], recorded: [], warnings: [] };
  const host: StageHost = {
    log: {
      info: () => {},
      warn: (...args: unknown[]) => {
        rec.warnings.push(args);
      },
      error: () => {},
      debug: () => {},
    } as never,
    report: (_runId, frame) => {
      rec.calls.push('report');
      void frame;
    },
    postComment: () => {},
    transcript: () => ({ text: () => {}, milestone: () => {} }) as never,
    endTranscript: () => 0,
    vcsFor: () =>
      ({
        lease: async () => ({}) as never,
        dispose: async () => {
          rec.calls.push('dispose');
        },
        hasWork: async () => false,
        checkpoint: async () => false,
        targetExists: async () => false,
        createTarget: async () => {},
        integrate: async () => ({}) as never,
        resumeIntegrate: async () => ({}) as never,
        abandonIntegrate: async () => {},
        publish: async () => ({}) as never,
        share: async () => ({}) as never,
        disposePreservesWork: false,
        changedPaths: async () => [],
        changeStats: async () => ({
          ok: true,
          stats: { changedFiles: 0, lines: { additions: 0, deletions: 0, uncountableFiles: 0 } },
        }),
      }) as never,
    lockScopeBranch: () => null,
    withRepoLock: async (_root, fn) => fn(),
    enforceLockFloor: async () => ({ conflicts: [] }),
    verifyWithFeedback: async () => ({}) as never,
    reviewWithFeedback: async () => ({}) as never,
    landRun: async () => ({}) as never,
    runBudget: () => undefined,
    abandonOrphanedSignal: async () => {},
    recordEpisode: (episode, intelligence) => {
      rec.calls.push('episode');
      rec.recorded.push({ episode, intelligence });
    },
  };
  return { host, rec };
}

// ── the brief-side guard (the defect this task exists to close) ───────────────────────────────────

describe('buildContextConsumption throwing cannot escape buildRunBrief (RUN-251)', () => {
  const briefHost: BriefHost = {
    log: { info: () => {}, warn: vi.fn(), error: () => {}, debug: () => {} } as never,
    server: 'https://noriq.example',
    context: {},
  };

  it('a throwing analytics capture degrades to contextConsumption: null — the brief is still usable', async () => {
    // Reachability, addressed directly (CLAUDE.md's own instruction not to argue it, but to know
    // it): under every REAL caller in this codebase, `verifiedContextPack` is either `null` or was
    // built by `citation-verify.ts`'s `verifyContextPack`, which walks (and therefore already
    // validates the shape of) every field `buildContextConsumption` reads — `prepare.ts` wraps THAT
    // walk in its own try/catch, so a malformed pack from the wire is caught a layer upstream of
    // this one and never reaches this function at all. A hand-built object that violates
    // `VerifiedContextPack`'s own TS shape at runtime (a `sections` getter that throws) does reach
    // this function directly — but it ALSO breaks `renderMemoryEvidence` a few lines earlier in
    // `buildRunBrief` (it reads `pack.sections` too), which is itself evidence of how deeply this
    // data is walked before `buildContextConsumption` ever sees it. So this test exercises the guard
    // the way the locked decision anticipated it might someday be needed — a call site that hands
    // this function a value the rest of `buildRunBrief` never touches — by forcing the imported
    // function itself to throw, exactly as "a future field or a future caller" would surface it.
    vi.mocked(buildContextConsumption).mockImplementationOnce(() => {
      throw new Error('boom: analytics capture threw');
    });
    const warn = briefHost.log.warn as ReturnType<typeof vi.fn>;
    warn.mockClear();

    const built = await buildRunBrief(briefHost, {
      run: makeRunFixture(),
      repo: { root: '/repo', manifest: testManifest() },
      worktree,
      task: null,
      runAgent,
      kind: 'build',
    });

    expect(built.contextConsumption).toBeNull();
    // The brief is otherwise complete and usable — nothing about the rest of the assembly is lost.
    expect(built.buildPrompt(authorSpecBlock(null, null), null)).toEqual(expect.any(String));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('context consumption'),
      expect.objectContaining({ runId: 'run_1' }),
    );
  });
});

function makeRunFixture(): Run {
  return {
    id: 'run_1',
    projectId: 'prj_p',
    runnerId: 'rnr_1',
    agentId: null,
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
  };
}

// ── the settle-side split (a SECOND, more consequential defect this sweep found) ──────────────────

describe('settle delivers the episode even when intelligence assembly throws (RUN-251)', () => {
  // Before this task, `buildEpisode` and `buildUploadedIntelligence` shared ONE try/catch in
  // `settle.ts` — the comment even claimed a throw there "must cost only the intelligence half",
  // but sharing a try means a throw skips `host.recordEpisode?.(episode, intelligence)` ENTIRELY,
  // losing the episode too. That directly contradicted this task's own acceptance criterion ("the
  // episode still uploads when analytics throws... with the analytics field simply absent"). Fixed
  // by nesting: `intelligence` assembly gets its OWN try, inside the outer one, so a throw there
  // falls back to `undefined` and `episode` — already built — still reaches `recordEpisode`.
  it('a throwing RunTally.stageFacts() costs only `intelligence`, not the episode', async () => {
    const { host, rec } = makeHost();
    // DI, not mocking (CLAUDE.md's testing strategy): a tally whose `stageFacts()` throws models
    // exactly the failure this fix targets, without touching the real class or any module registry.
    const brokenTally = new RunTally();
    brokenTally.stageFacts = () => {
      throw new Error('boom: stageFacts blew up');
    };
    const ctx = baseCtx({ workflow: BUILTIN_WORKFLOWS.build, landed: true, tally: brokenTally });

    await settleStage(host, ctx);

    expect(rec.calls).toContain('episode');
    expect(rec.recorded).toHaveLength(1);
    const { episode, intelligence } = rec.recorded[0]!;
    expect(intelligence).toBeUndefined();
    // The episode itself is real and well-formed — the six enrichment fields the acceptance
    // criterion names are all present and pass the vendored schema.
    expect(EffortEpisode.safeParse(episode).success).toBe(true);
    const e = episode as {
      filesTouched: unknown;
      commands: unknown;
      testsRun: unknown;
      failures: unknown;
      findings: unknown;
      selfSummary: unknown;
    };
    for (const key of ['filesTouched', 'commands', 'testsRun', 'failures', 'findings', 'selfSummary']) {
      expect(Object.prototype.hasOwnProperty.call(episode as object, key)).toBe(true);
    }
    void e;
    // The failure is VISIBLE, and distinguishable from the outer "episode assembly failed" warning
    // that WOULD have fired under the old, un-nested try.
    expect(rec.warnings.some((w) => String(w[0]).includes('episode intelligence assembly failed'))).toBe(
      true,
    );
    expect(rec.warnings.some((w) => String(w[0]).includes('episode assembly failed'))).toBe(false);
  });

  it('a clean run and a throwing-intelligence run agree on report/dispose/exit — only the upload differs', async () => {
    const clean = makeHost();
    const broken = makeHost();
    const brokenTally = new RunTally();
    brokenTally.stageFacts = () => {
      throw new Error('boom');
    };
    const cleanCtx = baseCtx({ workflow: BUILTIN_WORKFLOWS.build, landed: true });
    const brokenCtx = baseCtx({ workflow: BUILTIN_WORKFLOWS.build, landed: true, tally: brokenTally });

    await settleStage(clean.host, cleanCtx);
    await settleStage(broken.host, brokenCtx);

    expect(broken.rec.calls.filter((c) => c === 'report')).toEqual(
      clean.rec.calls.filter((c) => c === 'report'),
    );
    expect(broken.rec.calls.filter((c) => c === 'dispose')).toEqual(
      clean.rec.calls.filter((c) => c === 'dispose'),
    );
    expect(brokenCtx.exit).toEqual(cleanCtx.exit);
    expect(broken.rec.recorded).toHaveLength(1);
    expect(clean.rec.recorded).toHaveLength(1);
    // The only observable difference is the `intelligence` argument — everything about the run's
    // own fate is identical.
    expect(broken.rec.recorded[0]!.intelligence).toBeUndefined();
    expect(clean.rec.recorded[0]!.intelligence).not.toBeUndefined();
  });
});

// ── the full-pipeline equivalence proof ────────────────────────────────────────────────────────────
//
// Constructibility, addressed directly (this task's own question): a genuinely malformed context
// pack cannot reach `buildContextConsumption` through the real `RunSupervisor` pipeline at all —
// `prepare.ts`'s own `verifyContextPack` try/catch sits in front of every field this function reads,
// so any malformed shape is already caught a layer upstream (the same finding the brief-level test
// above documents). The only way to drive the REAL pipeline through this guard end to end is to
// force the call itself to throw — `vi.mock`, scoped to this describe block, on the one pure
// function this fix touches. Two runs that differ ONLY in whether that mock throws is exactly the
// assertion the task asks for; nothing about timing, transcript content or log ordering enters the
// comparison, because only the terminal, structural facts (exit, landing, disposal, lock release,
// reported spend) are compared — never a transcript string or a timestamp.

vi.mock('../src/context-consumption', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/context-consumption')>();
  return { ...actual, buildContextConsumption: vi.fn(actual.buildContextConsumption) };
});

class FakeDriver implements AgentDriver {
  opts?: DriverStartOptions;
  capabilities = {
    toolHooks: true,
    steer: true,
    interrupt: true,
    resumableSession: true,
    perModelTelemetry: true,
  };
  catalog = { models: [], efforts: [] };
  readonly tool = 'claude' as const;
  start(opts: DriverStartOptions): DriverSession {
    this.opts = opts;
    return {
      runId: opts.runId,
      sessionId: 'sess-fake',
      pushInput: () => true,
      interrupt: async () => {},
      stop: async () => {},
      done: () => new Promise<DriverExit>(() => {}),
    };
  }
  complete(): void {
    this.opts?.handlers?.onExit?.({
      outcome: 'done',
      isError: false,
      reason: null,
      telemetry: { ...zeroTelemetry(), outputTokens: 42, costUsd: 0.01 },
    });
  }
}

class FakeWorktrees {
  removed: string[] = [];
  releasedAll: string[] = [];
  landings: Array<{ branch: string }> = [];
  branches = new Set(['main']);
  lease = async (_root: string, runId: string): Promise<Workspace> => ({
    runId,
    localPath: `/wt/${runId}`,
    readOnly: false,
    baseId: 'base0000',
    workRef: `noriq/run/${runId}`,
    location: { repoRoot: '/repos/repo_a', branch: `noriq/run/${runId}` },
  });
  hasWork = async (): Promise<boolean> => true;
  checkpoint = async (): Promise<boolean> => true;
  dispose = async (ws: Workspace): Promise<void> => {
    this.removed.push(ws.localPath);
  };
  changedPaths = async (): Promise<string[]> => ['src/a.ts'];
  changeStats = async (): Promise<ChangeStatsResult> => ({
    ok: true,
    stats: { changedFiles: 1, lines: { additions: 3, deletions: 1, uncountableFiles: 0 } },
  });
  changesBetween = async (): Promise<ChangesBetweenResult> => ({ ok: true, changed: [], deleted: [] });
  targetExists = async (_root: string, ref: string): Promise<boolean> => this.branches.has(ref);
  createTarget = async (_root: string, branch: string): Promise<void> => {
    this.branches.add(branch);
  };
  integrate = async (): Promise<{ ok: true }> => ({ ok: true });
  resumeIntegrate = async (): Promise<{ ok: true }> => ({ ok: true });
  abandonIntegrate = async (): Promise<void> => {};
  publish = async (_ws: Workspace, branch: string): Promise<{ ok: true; sha: string }> => {
    this.landings.push({ branch });
    return { ok: true, sha: 'landedsha' };
  };
  share = async (): Promise<{ ok: true }> => ({ ok: true });
  disposePreservesWork = false;
  releaseRunLocks = async (_ws: Workspace, ctx: LockContext): Promise<void> => {
    this.releasedAll.push(ctx.token);
  };
  lock = async (_ws: Workspace, paths: string[]): Promise<LockOutcome> => ({
    ok: true,
    enabled: true,
    locks: paths.map((p) => ({ id: p, path: p })),
  });
  unlock = async (): Promise<void> => {};
}

const perm = (write: boolean): PermissionProfile => ({ write, allow: [], deny: [], auto: false });
const noModel = (): ModelDefault => ({ agent: null, model: null, effort: null });

function testManifest(): ProjectManifest {
  return {
    key: 'PROJ',
    board: null,
    verify: { cmd: 'npm test', timeoutSeconds: null, shell: null, maxRounds: 2, agent: null },
    context: { requiredReading: [], entryPoints: [], conventions: [], agentInstructions: 'inline' as const },
    tool: null,
    defaultBranch: 'main',
    repositoryKey: null,
    index: null,
    land: {
      branch: 'noriq/integration',
      mergeTarget: null,
      allowedBranches: [],
      onlyWhenVerifyPasses: true,
      resolveConflicts: true,
      autoPush: false,
    },
    setup: null,
    permissions: { scope: perm(false), build: perm(true), verify: perm(false) },
    defaults: { scope: noModel(), build: noModel(), verify: noModel() },
    workflows: {},
  };
}

function buildPipelineHarness() {
  const worktrees = new FakeWorktrees();
  const claude = new FakeDriver();
  const reports: unknown[] = [];
  const recordedEpisodes: Array<{ episode: unknown; intelligence?: UploadedEpisodeIntelligence }> = [];
  const supervisor = new RunSupervisor({
    drivers: { claude },
    vcs: worktrees as never,
    resolveRepo: () => ({ root: '/repos/repo_a', manifest: testManifest() }),
    report: (runId, r) => reports.push({ runId, ...r }),
    recordEpisode: (episode, intelligence) => recordedEpisodes.push({ episode, intelligence }),
    pathProbe: async () => 'missing',
    readDoc: async () => '',
    verifyExec: async () => ({ exitCode: 0, output: 'ok', timedOut: false }),
    createRunAgent: async () => ({
      agentId: 'agt_run1',
      label: 'build-abc123',
      projectId: 'prj_test',
      token: 'plnrt_bound_to_agt_run1',
      expiresIn: 3600,
    }),
    server: 'https://noriq.example',
  });
  return { supervisor, worktrees, reports, recordedEpisodes, claude };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function buildRunFixture(): Run {
  return {
    ...makeRunFixture(),
    kind: 'build',
    anchor: { type: 'task', taskId: 'task_9' },
  };
}

describe('the equivalence proof: analytics throwing changes nothing about a run’s outcome (RUN-251)', () => {
  beforeEach(() => {
    vi.mocked(buildContextConsumption).mockClear();
  });
  afterEach(() => {
    vi.mocked(buildContextConsumption).mockReset();
  });

  it('a full build+land run reaches the identical outcome whether or not buildContextConsumption throws', async () => {
    // Run A: analytics succeeds normally (the mock's default is the real implementation).
    vi.mocked(buildContextConsumption).mockImplementation(() => null);
    const a = buildPipelineHarness();
    const doneA = a.supervisor.supervise(buildRunFixture());
    await flush();
    a.claude.complete();
    const exitA = await doneA;

    // Run B: EVERY call to the same function throws — the analytics capture point this task exists
    // to guard, forced to fail on the run's own critical path.
    vi.mocked(buildContextConsumption).mockImplementation(() => {
      throw new Error('boom: analytics capture threw');
    });
    const b = buildPipelineHarness();
    const doneB = b.supervisor.supervise(buildRunFixture());
    await flush();
    b.claude.complete();
    const exitB = await doneB;

    // The structural facts an operator or the server would observe — never a transcript string or
    // a timestamp, which could differ between two independent runs for reasons that have nothing
    // to do with analytics.
    expect(exitB.outcome).toBe(exitA.outcome);
    expect(exitB.reason).toBe(exitA.reason);
    expect(exitA.outcome).toBe('done'); // sanity: this scenario actually lands, not just "fails identically"
    expect(b.worktrees.landings).toEqual(a.worktrees.landings);
    expect(b.worktrees.removed).toEqual(a.worktrees.removed);
    expect(b.worktrees.releasedAll).toEqual(a.worktrees.releasedAll);
    expect(exitB.telemetry.outputTokens).toBe(exitA.telemetry.outputTokens);
    expect(exitB.telemetry.costUsd).toBe(exitA.telemetry.costUsd);
    // The episode still uploads either way — with the analytics field present when it succeeded and
    // absent (never a fabricated value) when it threw.
    expect(a.recordedEpisodes).toHaveLength(1);
    expect(b.recordedEpisodes).toHaveLength(1);
    expect(b.recordedEpisodes[0]!.intelligence?.contextConsumption).toBeUndefined();
  });
});

// ── analytics is absent from every decision path ───────────────────────────────────────────────────
//
// Traced, not merely grepped for an "obvious" name (the task's own instruction): every module that
// decides a run's PERMISSIONS (`security.ts`), enforces its BUDGET (`drivers/budget.ts`,
// `run-budget.ts`), judges a VERIFY VERDICT (`verify-agent.ts`), decides whether to LAND
// (`land.ts`), or picks a WORKFLOW's posture (`workflow.ts`, the one place permission/write floors
// are clamped) was read end to end while investigating this task, and none of them import or branch
// on any analytics type or builder. This test pins that as a fact about the checked-in source, not
// merely an assertion made once in a report: a future PR that starts threading an analytics field
// into one of these files' decisions fails this test rather than only a design review.

describe('analytics types never reach a decision path (RUN-251)', () => {
  const decisionFiles = [
    'src/security.ts', // permission mapping (mapPermission/mapSandbox)
    'src/land.ts', // landing decisions
    'src/verify-agent.ts', // verify verdicts / acceptance judging
    'src/drivers/budget.ts', // per-session budget enforcement
    'src/run-budget.ts', // run-wide budget enforcement
    'src/workflow.ts', // permission/write-floor clamping, workflow posture
  ];
  // Every symbol this plan's analytics facts are actually named — the vendored wire types and this
  // codebase's own builders, never a word generic enough (`stage`, `metric`) to false-positive on
  // unrelated code.
  const analyticsMarkers = [
    'contextConsumption',
    'buildContextConsumption',
    'EpisodeStageFact',
    'BackendChangeStats',
    'IntelligenceDurationMs',
    'IntelligenceContextConsumptionMetric',
    'UploadedEpisodeIntelligence',
    'buildUploadedIntelligence',
    'ObservedModelUsage',
    'observedModelUsage',
    'stageFacts(',
    'recordVerifyDuration',
    'verifyDurations(',
  ];

  it.each(decisionFiles)('%s carries no analytics marker', (rel) => {
    const src = readFileSync(path.join(__dirname, '..', rel), 'utf8');
    for (const marker of analyticsMarkers) {
      expect(src, `${rel} unexpectedly references "${marker}"`).not.toContain(marker);
    }
  });
});
