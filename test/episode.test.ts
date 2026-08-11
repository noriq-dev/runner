import type { Run } from '@noriq-dev/shared';
import { EffortEpisode, ExecutionSpec } from '@noriq-dev/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcceptanceItem, AcceptanceReport } from '../src/acceptance';
import type { LedgerEntry } from '../src/adjudication';
import type { RunAgent } from '../src/client';
import type { ContinuableRun } from '../src/continuable';
import type { BudgetRun } from '../src/drivers/budget';
import { zeroTelemetry } from '../src/drivers/types';
import type {
  AgentDriver,
  DriverExit,
  DriverSession,
  DriverStartOptions,
  DriverTelemetry,
} from '../src/drivers/types';
import { buildEpisode, normalizeSeverity } from '../src/episode';
import { type ChainPlan, type ExecuteHost, executeChain } from '../src/stages';
import { settleStage } from '../src/stages/settle';
import type { RunPipeline, StageHost } from '../src/stages/types';
import { type ResolvedRepo, RunTally } from '../src/supervisor';
import type { Workspace } from '../src/vcs/types';
import { BUILTIN_WORKFLOWS } from '../src/workflow';

// RUN-224: the deterministic effort-episode assembler. `buildEpisode` is a pure function of a
// settled `RunPipeline` (+ `EpisodeExtra`), so most of this file drives it directly with hand-built
// fixtures — no supervisor, no SDK, no git (CLAUDE.md's testing strategy). The `settleStage`
// integration tests at the bottom cover the two properties that live in the CALL SITE, not the
// assembler: where it runs relative to `report`/`dispose`, and that it can never gate settlement.

const run = {
  id: 'run_1',
  projectId: 'prj_p',
  anchor: null,
  // RUN-227: widens `timelineOf` with these two fields when present — set on the shared fixture so
  // every test below exercises the widened shape rather than the pre-RUN-227 one, matching a real
  // dispatch (`dispatchRun`/`createRun` both re-read the row after writing `dispatched_at`).
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

/** A minimal, complete `RunPipeline` — every field `buildEpisode`/`settleStage` could read is
 *  present with an inert default, and a test overrides only what it cares about. */
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

const finding = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id: 1,
  round: 1,
  severity: 'high',
  requirements: [],
  location: 'src/x.ts:10',
  claim: 'does the wrong thing',
  status: 'unanswered',
  pointer: null,
  reason: null,
  subclaims: [],
  ...over,
});

describe('buildEpisode — the excluded set (RUN-224 locked decision)', () => {
  it('never carries outcome/runKind/agentId/startedAt/finishedAt/sitting, and selfSummary is null', () => {
    const episode = buildEpisode(baseCtx(), {
      filesTouched: [],
      hasRemainingWork: false,
      steeringHistory: [],
    });
    const keys = new Set(Object.keys(episode));
    for (const excluded of ['outcome', 'runKind', 'agentId', 'startedAt', 'finishedAt', 'sitting']) {
      expect(keys.has(excluded)).toBe(false);
    }
    expect(episode.selfSummary).toBeNull();
  });
});

describe('buildEpisode — across every terminal path', () => {
  it('done: parses against the vendored schema and reports a landed/not_landed episode', () => {
    const episode = buildEpisode(baseCtx({ landed: true }), {
      filesTouched: ['a.ts'],
      hasRemainingWork: false,
      steeringHistory: [],
    });
    expect(EffortEpisode.safeParse(episode).success).toBe(true);
    expect(episode.landingOutcome).toBe('landed');
    expect(episode.failures).toEqual([]);
  });

  it('failed: the terminal reason rides `failures`, and standing findings ride `remainingWork`', () => {
    const ctx = baseCtx({
      exit: { outcome: 'failed', isError: true, reason: 'review', telemetry: zeroTelemetry() },
      ledger: [finding()],
      landPolicy: { branch: 'main' } as never,
    });
    const episode = buildEpisode(ctx, { filesTouched: [], hasRemainingWork: true, steeringHistory: [] });
    expect(EffortEpisode.safeParse(episode).success).toBe(true);
    expect(episode.failures).toContain('terminal reason: review');
    expect(episode.findings).toHaveLength(1);
    expect(episode.remainingWork.some((w) => w.includes('does the wrong thing'))).toBe(true);
    expect(episode.landingOutcome).toBe('pending'); // kept work on a landing-capable workflow
  });

  it('cancelled: DriverExit has no cancelled outcome of its own — it rides reason (CANCELLED_REASON)', () => {
    const ctx = baseCtx({
      exit: { outcome: 'failed', isError: true, reason: 'cancelled', telemetry: zeroTelemetry() },
      driverSucceeded: false,
    });
    const episode = buildEpisode(ctx, { filesTouched: [], hasRemainingWork: false, steeringHistory: [] });
    expect(EffortEpisode.safeParse(episode).success).toBe(true);
    expect(episode.failures).toContain('terminal reason: cancelled');
  });

  it('continued: the prior sitting boundary enters the timeline, never duplicated as a second finding', () => {
    const continued: ContinuableRun = {
      runId: 'run_1',
      spent: { tokens: 0, usd: 0 },
      ledger: [finding({ id: 2, claim: 'from the prior sitting' })],
      failedAt: '2026-08-01T00:00:00.000Z',
    };
    const ctx = baseCtx({
      continued,
      // The real pipeline seeds ctx.ledger from the continuation record (supervisor.ts) — this
      // fixture reproduces that rather than re-deriving it, since buildEpisode only ever reads
      // ctx.ledger, never ctx.continued.ledger.
      ledger: continued.ledger,
    });
    const episode = buildEpisode(ctx, { filesTouched: [], hasRemainingWork: false, steeringHistory: [] });
    expect(EffortEpisode.safeParse(episode).success).toBe(true);
    // queued, dispatched, the continuation boundary, settle — RUN-227 widened this from 2 to 4.
    expect(episode.timeline).toHaveLength(4);
    expect(episode.timeline[2]).toEqual({ at: continued.failedAt, label: expect.any(String) });
    // The continuation's finding appears once, from ctx.ledger — not duplicated by the timeline entry.
    expect(episode.findings).toHaveLength(1);
  });
});

describe('buildEpisode — timeline widened to cover the server’s own skeleton (RUN-227)', () => {
  it('queued/dispatched read straight off the dispatched Run, ahead of the settle entry', () => {
    const episode = buildEpisode(baseCtx(), {
      filesTouched: [],
      hasRemainingWork: false,
      steeringHistory: [],
    });
    expect(episode.timeline).toEqual([
      { at: run.createdAt, label: 'queued' },
      { at: run.dispatchedAt, label: 'dispatched to runner' },
      { at: expect.any(String), label: expect.stringContaining('settle:') },
    ]);
  });

  it('a Run with no dispatchedAt yet (defensive — a real dispatch always sets it) omits that entry', () => {
    const undispatched = { ...run, dispatchedAt: null } as Run;
    const episode = buildEpisode(baseCtx({ run: undispatched }), {
      filesTouched: [],
      hasRemainingWork: false,
      steeringHistory: [],
    });
    expect(episode.timeline.map((e) => e.label)).toEqual(['queued', expect.stringContaining('settle:')]);
  });
});

describe('buildEpisode — "agent started" closes the one gap RUN-227 left open (RUN-261)', () => {
  it('a non-chained run carries the observed moment, ahead of settle and after dispatch', () => {
    const episode = buildEpisode(baseCtx({ agentStartedAt: '2026-08-01T00:00:03.000Z' }), {
      filesTouched: [],
      hasRemainingWork: false,
      steeringHistory: [],
    });
    expect(episode.timeline).toEqual([
      { at: run.createdAt, label: 'queued' },
      { at: run.dispatchedAt, label: 'dispatched to runner' },
      { at: '2026-08-01T00:00:03.000Z', label: 'agent started' },
      { at: expect.any(String), label: expect.stringContaining('settle:') },
    ]);
  });

  it('never observed (no session spawned this sitting) emits no entry — never a substitute', () => {
    const episode = buildEpisode(baseCtx(), {
      filesTouched: [],
      hasRemainingWork: false,
      steeringHistory: [],
    });
    expect(episode.timeline.some((e) => e.label === 'agent started')).toBe(false);
  });
});

describe('executeChain — a decomposed run reports its FIRST step as "agent started" (RUN-261)', () => {
  // Only `Date` is faked — `until` below still needs REAL setTimeout ticks to pump the promise
  // chain `executeChain` drives internally (checkpoint, stopSession, the next step's spawn).
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A driver spawn settled BY HAND, mirroring `stages-execute.test.ts`/`stages-chain.test.ts`'s
   *  own fixture — this file cannot import theirs (test files are the isolation boundary here), so
   *  it is reproduced minimally rather than reached across. */
  class FakeSpawn {
    private settle!: (e: DriverExit) => void;
    readonly budgetRun: BudgetRun;
    constructor(opts: DriverStartOptions) {
      let settle!: (e: DriverExit) => void;
      const done = new Promise<DriverExit>((r) => {
        settle = r;
      });
      this.settle = settle;
      this.budgetRun = {
        session: { runId: opts.runId, sessionId: `sess-${opts.runId}` } as DriverSession,
        done,
        stop: async () => {},
      };
    }
    finish(exit: Partial<DriverExit> = {}): void {
      this.settle({ outcome: 'done', isError: false, reason: null, telemetry: zeroTelemetry(), ...exit });
    }
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await tick();
    expect(cond()).toBe(true);
  };

  it("a later step's later spawn never overrides the first step's earlier one", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));

    const spawns: FakeSpawn[] = [];
    const host: ExecuteHost = {
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
      report: () => {},
      transcript: () => ({ text: () => {}, milestone: () => {} }) as never,
      startAgent: (_d, opts) => {
        const s = new FakeSpawn(opts);
        spawns.push(s);
        return s.budgetRun;
      },
      parkIfBlocked: async () => null,
    };
    const steps = ExecutionSpec.parse({
      steps: [
        { id: 's1', title: 'first step' },
        { id: 's2', title: 'second step' },
      ],
    }).steps;
    const plan: ChainPlan = {
      run,
      repo,
      worktree,
      driver,
      runAgent,
      tally: new RunTally(),
      priorActiveSeconds: 0,
      start: {
        runId: run.id,
        kind: 'build',
        cwd: worktree.localPath,
        prompt: 'go',
        permission: {} as never,
      },
      steps,
      stepPrompt: () => 'go',
      checkpoint: async () => true,
    };

    const running = executeChain(host, plan);
    await until(() => spawns.length === 1);
    const firstStepStartedAt = new Date().toISOString(); // '2026-08-01T00:00:00.000Z'
    spawns[0]!.finish();
    // Advance the wall clock before the second step spawns — if the chain reported whichever step's
    // outcome it happens to return (the last, scheduled-sequentially-last step here), the entry
    // would read this later moment instead of the true one.
    vi.setSystemTime(new Date('2026-08-01T00:10:00.000Z'));
    await until(() => spawns.length === 2);
    spawns[1]!.finish();

    const outcome = await running;
    if ('chainFailed' in outcome || outcome.parked) throw new Error('expected a finished chain');
    expect(outcome.agentStartedAt).toBe(firstStepStartedAt);

    const episode = buildEpisode(baseCtx({ agentStartedAt: outcome.agentStartedAt }), {
      filesTouched: [],
      hasRemainingWork: false,
      steeringHistory: [],
    });
    expect(episode.timeline).toContainEqual({ at: firstStepStartedAt, label: 'agent started' });
  });
});

describe('buildEpisode — severity normalization', () => {
  it.each([
    ['High', 'high'],
    ['CRITICAL', 'high'],
    ['blocker', 'high'],
    ['low', 'low'],
    ['minor', 'low'],
    ['Medium', 'medium'],
    ['info', 'info'],
    ['nit', 'info'],
  ] as const)('recognizes %s as %s', (raw, expected) => {
    expect(normalizeSeverity(raw)).toBe(expected);
  });

  it('an unrecognized word does not drop the finding — it keeps a default severity', () => {
    const ctx = baseCtx({ ledger: [finding({ severity: 'apocalyptic' })] });
    const episode = buildEpisode(ctx, { filesTouched: [], hasRemainingWork: false, steeringHistory: [] });
    expect(episode.findings).toHaveLength(1);
    expect(['info', 'low', 'medium', 'high']).toContain(episode.findings[0]?.severity);
    expect(normalizeSeverity('apocalyptic')).toBe('medium');
  });
});

describe('buildEpisode — review rounds and findings settle with the run', () => {
  it('reviewRounds is the highest round any ledger entry carries', () => {
    const ctx = baseCtx({
      ledger: [finding({ id: 1, round: 1 }), finding({ id: 2, round: 3 })],
    });
    expect(
      buildEpisode(ctx, { filesTouched: [], hasRemainingWork: false, steeringHistory: [] }).reviewRounds,
    ).toBe(3);
  });

  it('zero ledger entries reads as zero rounds — the known undercount this decision names', () => {
    const episode = buildEpisode(baseCtx(), {
      filesTouched: [],
      hasRemainingWork: false,
      steeringHistory: [],
    });
    expect(episode.reviewRounds).toBe(0);
  });

  it('a PASSING run reports nothing as standing, even over a contested finding', () => {
    const ctx = baseCtx({ ledger: [finding({ status: 'contested' })] }); // exit.outcome defaults to 'done'
    const episode = buildEpisode(ctx, { filesTouched: [], hasRemainingWork: false, steeringHistory: [] });
    expect(episode.remainingWork.some((w) => w.includes('does the wrong thing'))).toBe(false);
    expect(episode.findings[0]?.summary).toMatch(/^\[resolved\]/);
  });

  it('a fixed finding on a failed run reads resolved; a contested one stands', () => {
    const ctx = baseCtx({
      exit: { outcome: 'failed', isError: true, reason: 'review', telemetry: zeroTelemetry() },
      ledger: [
        finding({ id: 1, status: 'fixed' }),
        finding({ id: 2, status: 'contested', claim: 'still wrong' }),
      ],
    });
    const episode = buildEpisode(ctx, { filesTouched: [], hasRemainingWork: true, steeringHistory: [] });
    expect(episode.findings.find((f) => f.summary.includes('does the wrong thing'))?.summary).toMatch(
      /^\[resolved\]/,
    );
    expect(episode.findings.find((f) => f.summary.includes('still wrong'))?.summary).toMatch(
      /^\[contested\]/,
    );
    expect(episode.remainingWork.some((w) => w.includes('still wrong'))).toBe(true);
  });
});

describe('buildEpisode — acceptance evidence, when settle computed one', () => {
  const items: AcceptanceItem[] = [
    { id: 1, kind: 'truth', text: 'does the thing' },
    { id: 2, kind: 'truth', text: 'does the other thing' },
  ];
  const report: AcceptanceReport = {
    entries: [
      { id: 1, outcome: 'verified', evidence: 'test.ts:5', item: items[0]! },
      { id: 2, outcome: 'failed', evidence: 'never called', item: items[1]! },
    ],
  };

  it('coverage is null when no evidence was computed this sitting (the build-workflow gap)', () => {
    const episode = buildEpisode(baseCtx(), {
      filesTouched: [],
      hasRemainingWork: false,
      steeringHistory: [],
    });
    expect(episode.acceptanceCoverage).toBeNull();
  });

  it('coverage, when evidence exists, is the fraction VERIFIED — and a FAILED item rides `failures`', () => {
    const ctx = baseCtx({
      exit: { outcome: 'failed', isError: true, reason: 'verify_agent', telemetry: zeroTelemetry() },
    });
    const episode = buildEpisode(ctx, {
      filesTouched: [],
      hasRemainingWork: false,
      acceptanceEvidence: report,
      steeringHistory: [],
    });
    expect(episode.acceptanceCoverage).toBe(0.5);
    expect(episode.failures.some((f) => f.includes('does the other thing'))).toBe(true);
  });

  it('a human-needed criterion rides `remainingWork`, not `failures`', () => {
    const humanReport: AcceptanceReport = {
      entries: [{ id: 1, outcome: 'human-needed', evidence: '', item: items[0]! }],
    };
    const episode = buildEpisode(baseCtx(), {
      filesTouched: [],
      hasRemainingWork: false,
      acceptanceEvidence: humanReport,
      steeringHistory: [],
    });
    expect(episode.remainingWork.some((w) => w.includes('does the thing'))).toBe(true);
    expect(episode.failures).toEqual([]);
  });
});

describe('buildEpisode — landing outcome', () => {
  it('landed wins outright', () => {
    const ctx = baseCtx({ landed: true, landPolicy: { branch: 'main' } as never });
    expect(
      buildEpisode(ctx, { filesTouched: [], hasRemainingWork: false, steeringHistory: [] }).landingOutcome,
    ).toBe('landed');
  });

  it('a workflow with no land policy never reads pending', () => {
    const ctx = baseCtx({ landPolicy: null });
    expect(
      buildEpisode(ctx, { filesTouched: [], hasRemainingWork: true, steeringHistory: [] }).landingOutcome,
    ).toBe('not_landed');
  });

  it('a landing-capable run that failed outright (no kept work) reads failed', () => {
    const ctx = baseCtx({
      landPolicy: { branch: 'main' } as never,
      exit: { outcome: 'failed', isError: true, reason: 'budget', telemetry: zeroTelemetry() },
    });
    expect(
      buildEpisode(ctx, { filesTouched: [], hasRemainingWork: false, steeringHistory: [] }).landingOutcome,
    ).toBe('failed');
  });
});

describe('buildEpisode — spend and files are read straight off state settle already has', () => {
  it('tokenUsage/costUSD come from ctx.exit.telemetry, cumulative across sittings by construction', () => {
    const telemetry: DriverTelemetry = {
      ...zeroTelemetry(),
      costUsd: 1.5,
      modelUsage: {
        'claude-opus': {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 1.5,
        },
      },
    };
    const ctx = baseCtx({ exit: { outcome: 'done', isError: false, reason: null, telemetry } });
    const episode = buildEpisode(ctx, { filesTouched: [], hasRemainingWork: false, steeringHistory: [] });
    expect(episode.costUSD).toBe(1.5);
    expect(episode.tokenUsage['claude-opus']?.outputTokens).toBe(20);
  });

  it('filesTouched is exactly what the backend reported — never guessed at when absent', () => {
    const episode = buildEpisode(baseCtx(), {
      filesTouched: ['a/b.ts', 'c.ts'],
      hasRemainingWork: false,
      steeringHistory: [],
    });
    expect(episode.filesTouched).toEqual(['a/b.ts', 'c.ts']);
  });

  it('commands/testsRun/steeringEvents are empty when this sitting observed none — never a guess', () => {
    const episode = buildEpisode(baseCtx(), {
      filesTouched: [],
      hasRemainingWork: false,
      steeringHistory: [],
    });
    expect(episode.commands).toEqual([]);
    expect(episode.testsRun).toEqual([]);
    expect(episode.steeringEvents).toEqual([]);
  });

  it('a file the agent only mentioned in its output is never labelled examined without an observation', () => {
    // `sessionText` carries whatever the agent said, including a file it merely discussed — the
    // acceptance criterion this pins: filesTouched comes ONLY from the backend's own report.
    const ctx = baseCtx({
      sessionText: 'I also looked at src/unrelated-mentioned-only.ts and left it alone.',
    });
    const episode = buildEpisode(ctx, {
      filesTouched: ['a/b.ts'],
      hasRemainingWork: false,
      steeringHistory: [],
    });
    expect(episode.filesTouched).toEqual(['a/b.ts']);
    expect(episode.filesTouched).not.toContain('src/unrelated-mentioned-only.ts');
  });
});

describe('buildEpisode — commands/testsRun from observed deterministic commands (RUN-225)', () => {
  it('a run whose sitting never reached the deterministic command records neither', () => {
    const ctx = baseCtx({ commandObservations: [] });
    const episode = buildEpisode(ctx, { filesTouched: [], hasRemainingWork: false, steeringHistory: [] });
    expect(episode.commands).toEqual([]);
    expect(episode.testsRun).toEqual([]);
  });

  it('an observed command populates BOTH commands and testsRun, tagged with the site that ran it', () => {
    const ctx = baseCtx({
      commandObservations: [
        { site: 'verify', cmd: 'npm run check', passed: true, exitCode: 0, timedOut: false, attempts: 1 },
      ],
    });
    const episode = buildEpisode(ctx, { filesTouched: [], hasRemainingWork: false, steeringHistory: [] });
    expect(episode.commands).toEqual(['[verify] npm run check — passed']);
    expect(episode.testsRun).toEqual(episode.commands);
  });

  it('a failing, retried command reports the final outcome and the attempt count, never the output', () => {
    const ctx = baseCtx({
      commandObservations: [
        {
          site: 'landing',
          cmd: 'npm run check',
          passed: false,
          exitCode: 1,
          timedOut: false,
          attempts: 3,
        },
      ],
    });
    const episode = buildEpisode(ctx, { filesTouched: [], hasRemainingWork: false, steeringHistory: [] });
    expect(episode.commands[0]).toBe('[landing] npm run check — failed (exit 1), 3 attempts');
  });

  it('a long command string is capped rather than carried whole', () => {
    const longCmd = `npm run check -- ${'x'.repeat(500)}`;
    const ctx = baseCtx({
      commandObservations: [
        { site: 'verify', cmd: longCmd, passed: true, exitCode: 0, timedOut: false, attempts: 1 },
      ],
    });
    const episode = buildEpisode(ctx, { filesTouched: [], hasRemainingWork: false, steeringHistory: [] });
    expect(episode.commands[0]!.length).toBeLessThan(longCmd.length);
    expect(episode.commands[0]).toContain('…');
  });

  it('a review fix round is a distinct entry from the standalone verify/landing sites', () => {
    const ctx = baseCtx({
      commandObservations: [
        { site: 'verify', cmd: 'npm run check', passed: false, exitCode: 1, timedOut: false, attempts: 1 },
        { site: 'review-fix', cmd: 'npm run check', passed: true, exitCode: 0, timedOut: false, attempts: 1 },
      ],
    });
    const episode = buildEpisode(ctx, { filesTouched: [], hasRemainingWork: false, steeringHistory: [] });
    expect(episode.commands).toHaveLength(2);
    expect(episode.commands.some((c) => c.startsWith('[review-fix]'))).toBe(true);
  });
});

describe("buildEpisode — reviewRounds from the reviewer's own exact count (RUN-225)", () => {
  it('a first-look clean PASS is distinguishable from a run that never reviewed', () => {
    const reviewed = baseCtx({ reviewEvidence: { rounds: 1 } });
    const neverReviewed = baseCtx();
    expect(
      buildEpisode(reviewed, { filesTouched: [], hasRemainingWork: false, steeringHistory: [] }).reviewRounds,
    ).toBe(1);
    expect(
      buildEpisode(neverReviewed, { filesTouched: [], hasRemainingWork: false, steeringHistory: [] })
        .reviewRounds,
    ).toBe(0);
  });

  it('reviewEvidence.rounds wins over the ledger-derived fallback when both are present', () => {
    const ctx = baseCtx({
      ledger: [finding({ id: 1, round: 1 })],
      reviewEvidence: { rounds: 4 },
    });
    expect(
      buildEpisode(ctx, { filesTouched: [], hasRemainingWork: false, steeringHistory: [] }).reviewRounds,
    ).toBe(4);
  });

  it("no reviewEvidence at all still falls back to the ledger's highest round (RUN-224 behaviour)", () => {
    const ctx = baseCtx({ ledger: [finding({ id: 1, round: 1 }), finding({ id: 2, round: 3 })] });
    expect(
      buildEpisode(ctx, { filesTouched: [], hasRemainingWork: false, steeringHistory: [] }).reviewRounds,
    ).toBe(3);
  });
});

describe('buildEpisode — acceptanceCoverage closes the build-path gap (RUN-225)', () => {
  const items: AcceptanceItem[] = [
    { id: 1, kind: 'truth', text: 'does the thing' },
    { id: 2, kind: 'truth', text: 'does the other thing' },
  ];
  const report: AcceptanceReport = {
    entries: [
      { id: 1, outcome: 'verified', evidence: 'test.ts:5', item: items[0]! },
      { id: 2, outcome: 'failed', evidence: 'never called', item: items[1]! },
    ],
  };

  it('is non-null on a BUILD run whose reviewer produced acceptance evidence', () => {
    const ctx = baseCtx({
      exit: { outcome: 'failed', isError: true, reason: 'review', telemetry: zeroTelemetry() },
      reviewEvidence: { rounds: 1, acceptance: report },
    });
    const episode = buildEpisode(ctx, { filesTouched: [], hasRemainingWork: false, steeringHistory: [] });
    expect(episode.acceptanceCoverage).toBe(0.5);
    expect(episode.failures.some((f) => f.startsWith('[review] acceptance #2 failed'))).toBe(true);
  });

  it('the verify-actor path still tags its acceptance lines [verify], not [review]', () => {
    const ctx = baseCtx({
      exit: { outcome: 'failed', isError: true, reason: 'verify_agent', telemetry: zeroTelemetry() },
    });
    const episode = buildEpisode(ctx, {
      filesTouched: [],
      hasRemainingWork: false,
      steeringHistory: [],
      acceptanceEvidence: report,
    });
    expect(episode.acceptanceCoverage).toBe(0.5);
    expect(episode.failures.some((f) => f.startsWith('[verify] acceptance #2 failed'))).toBe(true);
  });
});

describe("buildEpisode — steeringEvents from the daemon's own delivery record (RUN-225)", () => {
  it('a delivered steer and a dropped one are distinguishable', () => {
    const ctx = baseCtx();
    const episode = buildEpisode(ctx, {
      filesTouched: [],
      hasRemainingWork: false,
      steeringHistory: [
        {
          steerId: 's1',
          runId: 'run_1',
          delivered: true,
          via: 'runtime',
          noticeCursor: 1,
          detail: null,
          mode: 'soft',
        },
        {
          steerId: 's2',
          runId: 'run_1',
          delivered: false,
          via: 'dropped',
          noticeCursor: 2,
          detail: 'no live run for steer',
          mode: 'hard',
        },
      ],
    });
    expect(episode.steeringEvents).toHaveLength(2);
    expect(episode.steeringEvents[0]).toContain('delivered via runtime');
    expect(episode.steeringEvents[1]).toContain('not delivered');
    expect(episode.steeringEvents[1]).toContain('dropped');
  });

  it('a long delivery detail is capped', () => {
    const ctx = baseCtx();
    const episode = buildEpisode(ctx, {
      filesTouched: [],
      hasRemainingWork: false,
      steeringHistory: [
        {
          steerId: 's1',
          runId: 'run_1',
          delivered: false,
          via: 'fallback',
          noticeCursor: null,
          detail: 'x'.repeat(1000),
          mode: 'soft',
        },
      ],
    });
    expect(episode.steeringEvents[0]!.length).toBeLessThan(1000);
    expect(episode.steeringEvents[0]).toContain('…');
  });
});

// ---------------------------------------------------------------------------
// settleStage integration: the two properties that live at the CALL SITE, not inside the pure
// assembler above. No `test/settle.test.ts` exercises settleStage end-to-end today (it only covers
// `withTimeout`), so both the ordering pin and the never-gates property live here rather than there
// — the discretion note's own permission ("or say so").
// ---------------------------------------------------------------------------

interface Recorder {
  calls: string[];
  reportArgs: unknown[];
  disposeCount: number;
  warnings: unknown[][];
}

function makeHost(over: { recordEpisode?: (e: unknown) => void } = {}): { host: StageHost; rec: Recorder } {
  const rec: Recorder = { calls: [], reportArgs: [], disposeCount: 0, warnings: [] };
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
      rec.reportArgs.push(frame);
    },
    postComment: () => {},
    transcript: () => ({ text: () => {}, milestone: () => {} }) as never,
    endTranscript: () => 0,
    vcsFor: () =>
      ({
        lease: async () => ({}) as never,
        dispose: async () => {
          rec.calls.push('dispose');
          rec.disposeCount += 1;
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
    ...(over.recordEpisode
      ? {
          recordEpisode: (e: unknown) => {
            rec.calls.push('episode');
            over.recordEpisode?.(e);
          },
        }
      : {}),
  };
  return { host, rec };
}

describe('settleStage — episode assembly ordering (RUN-224)', () => {
  it('runs after the terminal report and before the workspace is disposed', async () => {
    const { host, rec } = makeHost({ recordEpisode: () => {} });
    const ctx = baseCtx({ workflow: BUILTIN_WORKFLOWS.build, landed: true }); // landed → never "kept"
    await settleStage(host, ctx);
    const reportAt = rec.calls.indexOf('report');
    const episodeAt = rec.calls.indexOf('episode');
    const disposeAt = rec.calls.indexOf('dispose');
    expect(reportAt).toBeGreaterThanOrEqual(0);
    expect(episodeAt).toBeGreaterThan(reportAt);
    expect(disposeAt).toBeGreaterThan(episodeAt);
  });
});

describe('settleStage — episode assembly never gates settlement (RUN-224)', () => {
  it('a throwing sink leaves the terminal report and the dispose decision unchanged', async () => {
    const clean = makeHost({ recordEpisode: () => {} });
    const broken = makeHost({
      recordEpisode: () => {
        throw new Error('boom');
      },
    });
    const cleanCtx = baseCtx({ workflow: BUILTIN_WORKFLOWS.build, landed: true });
    const brokenCtx = baseCtx({ workflow: BUILTIN_WORKFLOWS.build, landed: true });

    await settleStage(clean.host, cleanCtx);
    await settleStage(broken.host, brokenCtx);

    expect(broken.rec.reportArgs).toEqual(clean.rec.reportArgs);
    expect(broken.rec.disposeCount).toBe(clean.rec.disposeCount);
    expect(brokenCtx.exit).toEqual(cleanCtx.exit);
    // The failure is VISIBLE (a warn log), never silent.
    expect(broken.rec.warnings.some((w) => String(w[0]).includes('episode assembly failed'))).toBe(true);
    expect(clean.rec.warnings).toHaveLength(0);
  });

  it('a missing sink (no host.recordEpisode at all) settles exactly like a wired one', async () => {
    const wired = makeHost({ recordEpisode: () => {} });
    const unwired = makeHost();
    const wiredCtx = baseCtx({ workflow: BUILTIN_WORKFLOWS.build, landed: true });
    const unwiredCtx = baseCtx({ workflow: BUILTIN_WORKFLOWS.build, landed: true });

    await settleStage(wired.host, wiredCtx);
    await settleStage(unwired.host, unwiredCtx);

    expect(unwired.rec.reportArgs).toEqual(wired.rec.reportArgs);
    expect(unwired.rec.disposeCount).toBe(wired.rec.disposeCount);
    expect(unwiredCtx.exit).toEqual(wiredCtx.exit);
  });
});
