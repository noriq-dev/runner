import type { Run } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import type { RunAgent } from '../src/client';
import { zeroTelemetry } from '../src/drivers/types';
import type { AgentDriver, DriverExit, DriverSession, DriverTelemetry } from '../src/drivers/types';
import { integrateStage } from '../src/stages/integrate';
import { reviewStage } from '../src/stages/review';
import type { RunPipeline, StageHost } from '../src/stages/types';
import { verifyStage } from '../src/stages/verify';
import { type ResolvedRepo, RunTally } from '../src/supervisor';
import type { Workspace } from '../src/vcs/types';
import { BUILTIN_WORKFLOWS } from '../src/workflow';

// RUN-225: pins the WIRING these three stages add — that a deterministic command result crossing
// the `StageHost` boundary (`verifyWithFeedback`'s `attempts`, `reviewWithFeedback`'s
// `onCommandObserved`, `landRun`'s `commandObserved`) actually lands on `ctx.commandObservations`,
// tagged with the site that produced it. `episode.test.ts` covers the OTHER half — that
// `buildEpisode` renders `ctx.commandObservations` correctly — with hand-built fixtures, per
// CLAUDE.md's DI strategy. Full end-to-end (a real `supervise()` call producing a recorded
// episode) is not testable today: `recordEpisode` has no production sink until RUN-227 wires one
// (deferred, per this task's own locked decisions), so `test/supervisor.test.ts`'s harness has
// nothing to assert the episode against either.

const run = { id: 'run_1', projectId: 'prj_p', anchor: null } as Run;
const repo: ResolvedRepo = { root: '/repo', manifest: {} as never };
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
    session: { continueWith: undefined } as never,
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

function baseHost(over: Partial<StageHost> = {}): StageHost {
  return {
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    report: () => {},
    postComment: () => {},
    transcript: () => ({ text: () => {}, milestone: () => {} }) as never,
    endTranscript: () => 0,
    vcsFor: () => ({ hasWork: async () => true, checkpoint: async () => true }) as never,
    lockScopeBranch: () => null,
    withRepoLock: async (_root, fn) => fn(),
    enforceLockFloor: async () => ({ conflicts: [] }),
    verifyWithFeedback: async () => ({ passed: true, exitCode: 0, output: '', timedOut: false, attempts: 1 }),
    reviewWithFeedback: async () => ({
      verdict: 'pass',
      passed: true,
      findings: '',
      rounds: 0,
      ledger: [],
      looks: 1,
    }),
    landRun: async () => ({ landed: true, branch: 'main' }),
    runBudget: () => undefined,
    abandonOrphanedSignal: async () => {},
    ...over,
  };
}

describe('verifyStage — records the deterministic floor as a `verify`-site observation (RUN-225)', () => {
  it('a passing command is recorded with its attempt count', async () => {
    const ctx = baseCtx({
      workflow: { ...BUILTIN_WORKFLOWS.build },
      repo: { root: '/repo', manifest: { verify: { cmd: 'npm run check' } } as never },
    });
    const host = baseHost({
      verifyWithFeedback: async () => ({
        passed: true,
        exitCode: 0,
        output: '',
        timedOut: false,
        attempts: 2,
      }),
    });
    await verifyStage(host, ctx);
    expect(ctx.commandObservations).toEqual([
      { site: 'verify', cmd: 'npm run check', passed: true, exitCode: 0, timedOut: false, attempts: 2 },
    ]);
  });

  it('a FAILING command is still recorded — not only the passing case', async () => {
    const ctx = baseCtx({ repo: { root: '/repo', manifest: { verify: { cmd: 'npm run check' } } as never } });
    const host = baseHost({
      verifyWithFeedback: async () => ({
        passed: false,
        exitCode: 1,
        output: 'boom',
        timedOut: false,
        attempts: 3,
      }),
    });
    await verifyStage(host, ctx);
    expect(ctx.commandObservations).toHaveLength(1);
    expect(ctx.commandObservations[0]).toMatchObject({ site: 'verify', passed: false, attempts: 3 });
    expect(ctx.exit.outcome).toBe('failed'); // still gates the run, unaffected by the new recording
  });

  it('a landing run skips the standalone floor — no observation from this stage', async () => {
    // `verifyStage` computes `ctx.landPolicy` itself from `repo.manifest.land` (see its own doc on
    // why it snapshots rather than trusting a caller's value) — a manifest with a `[land]` section
    // is what actually routes this run onto the landing path, not an override on `ctx`.
    const ctx = baseCtx({
      repo: {
        root: '/repo',
        manifest: { verify: { cmd: 'npm run check' }, land: { branch: 'main' } } as never,
      },
    });
    const host = baseHost();
    await verifyStage(host, ctx);
    expect(ctx.landPolicy).not.toBeNull(); // confirms the fixture actually routed onto landing
    expect(ctx.commandObservations).toEqual([]);
  });
});

describe("reviewStage — carries the reviewer's exact evidence and any fix-round re-check (RUN-225)", () => {
  it('sets reviewEvidence from `looks`/`acceptance`, even on a first-look PASS (rounds: 0 today)', async () => {
    const ctx = baseCtx({ repo: { root: '/repo', manifest: { verify: { agent: {} } } as never } });
    const host = baseHost({
      reviewWithFeedback: async () => ({
        verdict: 'pass',
        passed: true,
        findings: '',
        rounds: 0,
        ledger: [],
        looks: 1,
      }),
    });
    await reviewStage(host, ctx);
    expect(ctx.reviewEvidence).toEqual({ rounds: 1, acceptance: undefined });
  });

  it("a fix round's internal floor re-check reaches ctx.commandObservations via onCommandObserved", async () => {
    const ctx = baseCtx({ repo: { root: '/repo', manifest: { verify: { agent: {} } } as never } });
    const host = baseHost({
      reviewWithFeedback: async (rc) => {
        rc.onCommandObserved?.({
          site: 'review-fix',
          cmd: 'npm run check',
          passed: true,
          exitCode: 0,
          timedOut: false,
          attempts: 1,
        });
        return { verdict: 'pass', passed: true, findings: '', rounds: 1, ledger: [], looks: 2 };
      },
    });
    await reviewStage(host, ctx);
    expect(ctx.commandObservations).toEqual([
      { site: 'review-fix', cmd: 'npm run check', passed: true, exitCode: 0, timedOut: false, attempts: 1 },
    ]);
    expect(ctx.reviewEvidence?.rounds).toBe(2);
  });

  it('reviewEvidence is set even on a FAIL — settle needs it whatever the verdict', async () => {
    const ctx = baseCtx({ repo: { root: '/repo', manifest: { verify: { agent: {} } } as never } });
    const host = baseHost({
      reviewWithFeedback: async () => ({
        verdict: 'fail',
        passed: false,
        findings: 'FINDING 1 [high] src/x.ts: bad',
        rounds: 0,
        ledger: [],
        looks: 1,
      }),
    });
    await reviewStage(host, ctx);
    expect(ctx.reviewEvidence).toEqual({ rounds: 1, acceptance: undefined });
    expect(ctx.exit.outcome).toBe('failed');
  });
});

describe("integrateStage — folds the landing rebase gate's observation in (RUN-225)", () => {
  it('a landing run that ran the rebase gate records a `landing`-site observation', async () => {
    const ctx = baseCtx({ landPolicy: { branch: 'main' } as never });
    const host = baseHost({
      landRun: async () => ({
        landed: true,
        branch: 'main',
        sha: 'abc123',
        commandObserved: {
          site: 'landing',
          cmd: 'npm run check',
          passed: true,
          exitCode: 0,
          timedOut: false,
          attempts: 1,
        },
      }),
    });
    await integrateStage(host, ctx);
    expect(ctx.commandObservations).toEqual([
      { site: 'landing', cmd: 'npm run check', passed: true, exitCode: 0, timedOut: false, attempts: 1 },
    ]);
  });

  it('a landing policy with no rebase gate (autoPush-only) records nothing — never invented', async () => {
    const ctx = baseCtx({ landPolicy: { branch: 'main' } as never });
    const host = baseHost({ landRun: async () => ({ landed: true, branch: 'main', sha: 'abc123' }) });
    await integrateStage(host, ctx);
    expect(ctx.commandObservations).toEqual([]);
  });

  it('a FAILED landing gate still records what it observed before rejecting the landing', async () => {
    const ctx = baseCtx({ landPolicy: { branch: 'main' } as never });
    const host = baseHost({
      landRun: async () => ({
        landed: false,
        branch: 'main',
        reason: 'verify',
        detail: 'boom',
        commandObserved: {
          site: 'landing',
          cmd: 'npm run check',
          passed: false,
          exitCode: 1,
          timedOut: false,
          attempts: 3,
        },
      }),
    });
    await integrateStage(host, ctx);
    expect(ctx.commandObservations).toHaveLength(1);
    expect(ctx.commandObservations[0]).toMatchObject({ site: 'landing', passed: false, attempts: 3 });
    expect(ctx.exit.outcome).toBe('failed');
  });
});
