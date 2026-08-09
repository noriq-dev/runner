import type { Run } from '@noriq-dev/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunAgent } from '../src/client';
import { type DriverExit, type DriverSession, zeroTelemetry } from '../src/drivers/types';
import { buildEpisode } from '../src/episode';
import {
  SELF_SUMMARY_OUTPUT_CAP,
  SELF_SUMMARY_TIMEOUT_MS,
  type SelfSummaryContext,
  requestSelfSummary,
} from '../src/episode-summary';
import { settleStage } from '../src/stages/settle';
import type { RunPipeline, StageHost } from '../src/stages/types';
import { type ResolvedRepo, RunTally } from '../src/supervisor';
import type { Workspace } from '../src/vcs/types';
import { BUILTIN_WORKFLOWS } from '../src/workflow';

// RUN-226: the optional final agent self-summary. `requestSelfSummary` is the ONLY place in the
// episode pipeline that talks to a live session, spends budget, or races a clock — so it is driven
// directly with fake sessions/tallies here (CLAUDE.md's DI testing strategy), never a real driver.

const doneExit = (telemetry = zeroTelemetry()): DriverExit => ({
  outcome: 'done',
  isError: false,
  reason: null,
  telemetry,
});

/** A `Pick<RunTally, 'reserve' | 'chargeTime'>` double that always says "spend freely". */
function okTally(): { reserve: () => { ok: true; budget: undefined }; chargeTime: (s: number) => void } {
  return { reserve: () => ({ ok: true, budget: undefined }), chargeTime: vi.fn() };
}

const fencedReply = (obj: Record<string, unknown>) =>
  `Here is my summary.\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\`\n`;

/**
 * A `getSessionText` double that behaves like the real thing: empty before the turn, the turn's
 * text after. `requestSelfSummary` reads it twice — once to snapshot `textBefore`, once to slice
 * the turn's own addition off — so a fixture that returns the same constant on both reads would
 * always slice to `''`, which is a fixture bug, not a real turn.
 */
function growingSessionText(reply: string): {
  continueWith: () => Promise<DriverExit>;
  getSessionText: () => string;
} {
  let text = '';
  return {
    continueWith: async () => {
      text += reply;
      return doneExit();
    },
    getSessionText: () => text,
  };
}

describe('requestSelfSummary — skip conditions never spend anything', () => {
  it('no continueWith (single-turn run, or a driver with no hand-back capability) — declines silently', async () => {
    const milestone = vi.fn();
    const tally = okTally();
    const reserveSpy = vi.spyOn(tally, 'reserve');
    const result = await requestSelfSummary({ session: {}, tally, milestone });
    expect(result).toBeNull();
    expect(milestone).not.toHaveBeenCalled();
    // The capability check comes first — asking the tally is itself a (tiny) commitment, and a
    // driver with nothing to ask should cost nothing at all, not even a reservation probe.
    expect(reserveSpy).not.toHaveBeenCalled();
  });

  it('no run budget left — declines before ever calling continueWith', async () => {
    const continueWith = vi.fn(async () => doneExit());
    const milestone = vi.fn();
    const warn = vi.fn();
    const result = await requestSelfSummary({
      session: { continueWith },
      tally: { reserve: () => ({ ok: false, breach: 'budget:tokens', detail: 'out' }), chargeTime: vi.fn() },
      milestone,
      warn,
    });
    expect(result).toBeNull();
    expect(continueWith).not.toHaveBeenCalled();
    expect(milestone).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('declined'));
  });
});

describe('requestSelfSummary — the turn is labelled before it is asked', () => {
  it('posts the milestone before calling continueWith', async () => {
    const order: string[] = [];
    const continueWith = vi.fn(async () => {
      order.push('continueWith');
      return doneExit();
    });
    const milestone = vi.fn(() => order.push('milestone'));
    await requestSelfSummary({
      session: { continueWith },
      tally: okTally(),
      milestone,
      getSessionText: () => fencedReply({}),
    });
    expect(order).toEqual(['milestone', 'continueWith']);
  });
});

describe('requestSelfSummary — bounded wall clock (this module’s own deadline)', () => {
  beforeEach(() =>
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
    }),
  );
  afterEach(() => vi.useRealTimers());

  it('gives up when the turn never resolves, rather than blocking settle forever', async () => {
    const continueWith = vi.fn(() => new Promise<DriverExit>(() => {})); // never resolves
    const chargeTime = vi.fn();
    const promise = requestSelfSummary({
      session: { continueWith },
      tally: { reserve: () => ({ ok: true, budget: undefined }), chargeTime },
      milestone: () => {},
    });
    // Does not resolve early — the race genuinely waits out the deadline.
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(SELF_SUMMARY_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await promise).toBeNull();
    // The wait is charged to the run's wall clock regardless of outcome (RUN-133's own accounting
    // for every other hand-back turn — `verifyWithFeedback`/`reviewWithFeedback` charge identically).
    expect(chargeTime).toHaveBeenCalledWith(expect.closeTo(SELF_SUMMARY_TIMEOUT_MS / 1000, 1));
  });

  it('does not throw an unhandled rejection when the abandoned turn eventually rejects', async () => {
    const pending: { reject: ((err: Error) => void) | null } = { reject: null };
    const continueWith = vi.fn(
      () =>
        new Promise<DriverExit>((_resolve, reject) => {
          pending.reject = reject;
        }),
    );
    const promise = requestSelfSummary({
      session: { continueWith },
      tally: okTally(),
      milestone: () => {},
    });
    await vi.advanceTimersByTimeAsync(SELF_SUMMARY_TIMEOUT_MS);
    expect(await promise).toBeNull();
    // The abandoned turn settles LATE (mirrors `DriverSession.stop()` resolving a pending
    // `continueWith` once settle's very next line closes the session) — must not crash the process.
    pending.reject?.(new Error('stopped'));
    await vi.runAllTimersAsync();
  });
});

describe('requestSelfSummary — a turn that did not finish cleanly is discarded', () => {
  it('a rejected continueWith call yields null', async () => {
    const result = await requestSelfSummary({
      session: { continueWith: async () => Promise.reject(new Error('boom')) },
      tally: okTally(),
      milestone: () => {},
    });
    expect(result).toBeNull();
  });

  it('an exit that is not "done" (budget:duration, stopped, ...) yields null', async () => {
    const result = await requestSelfSummary({
      session: {
        continueWith: async () => ({
          outcome: 'failed',
          isError: true,
          reason: 'budget:duration',
          telemetry: zeroTelemetry(),
        }),
      },
      tally: okTally(),
      milestone: () => {},
      getSessionText: () => fencedReply({ approachSummary: 'should never be read' }),
    });
    expect(result).toBeNull();
  });
});

describe('requestSelfSummary — strict validation discards malformed output whole', () => {
  // Real growth (empty before the turn, the reply after) — a constant `getSessionText` would slice
  // to `''` regardless of what the reply said, which would pass these tests for the wrong reason
  // (an empty turn, not a rejected one).
  const ctx = (reply: string): SelfSummaryContext => {
    const fake = growingSessionText(reply);
    return {
      session: { continueWith: fake.continueWith },
      tally: okTally(),
      milestone: () => {},
      getSessionText: fake.getSessionText,
    };
  };

  it('no fenced or bare JSON at all', async () => {
    expect(await requestSelfSummary(ctx('just some prose, no braces'))).toBeNull();
  });

  it('unparseable JSON inside the fence', async () => {
    expect(await requestSelfSummary(ctx('```json\n{ not: valid, json\n```'))).toBeNull();
  });

  it('valid JSON that fails the schema (wrong type on one field) discards the WHOLE reply', async () => {
    const bad = fencedReply({ approachSummary: 12345, rejectedHypotheses: [], durableLearnings: [] });
    expect(await requestSelfSummary(ctx(bad))).toBeNull();
  });

  it('an oversized reply is rejected outright, never truncated-and-stored', async () => {
    const huge = fencedReply({ approachSummary: 'x'.repeat(SELF_SUMMARY_OUTPUT_CAP + 1) });
    expect(huge.length).toBeGreaterThan(SELF_SUMMARY_OUTPUT_CAP);
    expect(await requestSelfSummary(ctx(huge))).toBeNull();
  });

  it('no getSessionText at all (a driver capability gap) reads as nothing recovered', async () => {
    expect(
      await requestSelfSummary({
        session: { continueWith: async () => doneExit() },
        tally: okTally(),
        milestone: () => {},
      }),
    ).toBeNull();
  });
});

describe('requestSelfSummary — the success path', () => {
  it('parses a well-formed fenced reply into the exact EpisodeSelfSummary shape', async () => {
    const body = {
      approachSummary: 'used the existing pattern in stages/plan.ts',
      rejectedHypotheses: ['tried a second session, but the acceptance forbids it'],
      durableLearnings: ['ctx.sessionText is a snapshot taken before settle, not live'],
      unresolvedQuestions: [],
    };
    const fake = growingSessionText(fencedReply(body));
    const result = await requestSelfSummary({
      session: { continueWith: fake.continueWith },
      tally: okTally(),
      milestone: () => {},
      getSessionText: fake.getSessionText,
    });
    expect(result).toEqual(body);
  });

  it('a bare object with no fence still parses (the model dropped the fence, not the content)', async () => {
    const body = {
      approachSummary: 'no fence this time',
      rejectedHypotheses: [],
      durableLearnings: [],
      unresolvedQuestions: [],
    };
    const fake = growingSessionText(`Sure — ${JSON.stringify(body)}`);
    const result = await requestSelfSummary({
      session: { continueWith: fake.continueWith },
      tally: okTally(),
      milestone: () => {},
      getSessionText: fake.getSessionText,
    });
    expect(result).toEqual(body);
  });

  it('missing fields take the schema’s own defaults rather than failing', async () => {
    const fake = growingSessionText(fencedReply({ approachSummary: 'short and sweet' }));
    const result = await requestSelfSummary({
      session: { continueWith: fake.continueWith },
      tally: okTally(),
      milestone: () => {},
      getSessionText: fake.getSessionText,
    });
    expect(result).toEqual({
      approachSummary: 'short and sweet',
      rejectedHypotheses: [],
      durableLearnings: [],
      unresolvedQuestions: [],
    });
  });

  it('isolates THIS turn’s text from everything the session said before it (RUN-79’s slice pattern)', async () => {
    const priorText = 'a whole review round of prior output '.repeat(50);
    const summaryBody = {
      approachSummary: 'only this part should be read',
      rejectedHypotheses: [],
      durableLearnings: [],
      unresolvedQuestions: [],
    };
    // The prior text itself contains something that would parse as JSON if the slice leaked —
    // proving the isolation actually matters, not just that it happens to work.
    let liveText = `${priorText}\n\`\`\`json\n{"approachSummary":"a decoy from before this turn"}\n\`\`\`\n`;
    const result = await requestSelfSummary({
      session: {
        continueWith: async () => {
          liveText += fencedReply(summaryBody);
          return doneExit();
        },
      },
      tally: okTally(),
      milestone: () => {},
      getSessionText: () => liveText,
    });
    expect(result?.approachSummary).toBe('only this part should be read');
  });

  it('charges the turn’s wall-clock to the run tally like every other hand-back turn', async () => {
    const chargeTime = vi.fn();
    await requestSelfSummary({
      session: { continueWith: async () => doneExit() },
      tally: { reserve: () => ({ ok: true, budget: undefined }), chargeTime },
      milestone: () => {},
      getSessionText: () => fencedReply({ approachSummary: 'x' }),
    });
    expect(chargeTime).toHaveBeenCalledTimes(1);
    expect(chargeTime.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// buildEpisode wiring: a validated summary reaches `selfSummary`; anything else (including simply
// not asking) leaves it exactly as RUN-224 left it — null, the one default `recordEpisode` never
// overwrites.
// ---------------------------------------------------------------------------

const run = { id: 'run_1', projectId: 'prj_p', anchor: null } as Run;
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

function baseCtx(session: DriverSession, over: Partial<RunPipeline> = {}): RunPipeline {
  const telemetry = zeroTelemetry();
  const exit: DriverExit = { outcome: 'done', isError: false, reason: null, telemetry };
  return {
    run,
    repo,
    worktree,
    driver: {
      tool: 'claude',
      capabilities: {
        toolHooks: true,
        steer: true,
        interrupt: true,
        resumableSession: true,
        perModelTelemetry: true,
      },
      catalog: { models: [], efforts: [] },
      start: () => session,
    },
    permission: {} as never,
    task: null,
    runAgent,
    session,
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
    landed: true, // never "kept" — keeps dispose out of these tests' way
    ledger: [],
    landPolicy: null,
    commandObservations: [],
    ...over,
  };
}

describe('buildEpisode — selfSummary (RUN-226)', () => {
  it('a validated summary reaches the episode verbatim', () => {
    const summary = {
      approachSummary: 'a',
      rejectedHypotheses: ['b'],
      durableLearnings: ['c'],
      unresolvedQuestions: ['d'],
    };
    const episode = buildEpisode(baseCtx({} as never), {
      filesTouched: [],
      hasRemainingWork: false,
      steeringHistory: [],
      selfSummary: summary,
    });
    expect(episode.selfSummary).toEqual(summary);
  });

  it('omitted (the pre-RUN-226 shape) and explicit null both leave the episode exactly as before', () => {
    const omitted = buildEpisode(baseCtx({} as never), {
      filesTouched: [],
      hasRemainingWork: false,
      steeringHistory: [],
    });
    const nulled = buildEpisode(baseCtx({} as never), {
      filesTouched: [],
      hasRemainingWork: false,
      steeringHistory: [],
      selfSummary: null,
    });
    expect(omitted.selfSummary).toBeNull();
    expect(nulled.selfSummary).toBeNull();
    // `id`/`createdAt` are freshly minted per call (randomUUID + `new Date()`) and expected to
    // differ — the property under test is everything ELSE being identical either way.
    expect({ ...omitted, id: '', createdAt: '' }).toEqual({ ...nulled, id: '', createdAt: '' });
  });
});

// ---------------------------------------------------------------------------
// settleStage integration: the ONE property that lives at the call site, not inside the pure
// request function above — the ordering the acceptance asks to be "pinned by a test rather than
// asserted in a comment".
// ---------------------------------------------------------------------------

function makeHost(): StageHost {
  return {
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    report: () => {},
    postComment: () => {},
    transcript: () => ({ text: () => {}, milestone: () => {} }) as never,
    endTranscript: () => 0,
    vcsFor: () =>
      ({
        lease: async () => ({}) as never,
        dispose: async () => {},
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
      }) as never,
    lockScopeBranch: () => null,
    withRepoLock: async (_root, fn) => fn(),
    enforceLockFloor: async () => ({ conflicts: [] }),
    verifyWithFeedback: async () => ({}) as never,
    reviewWithFeedback: async () => ({}) as never,
    landRun: async () => ({}) as never,
    runBudget: () => undefined,
    abandonOrphanedSignal: async () => {},
  };
}

describe('settleStage — the self-summary request runs before the session closes (RUN-226)', () => {
  it('calls continueWith before stopSession, and the summary is discarded if it never resolves in time', async () => {
    const order: string[] = [];
    const session: DriverSession = {
      runId: 'run_1',
      sessionId: null,
      pushInput: () => true,
      interrupt: async () => {},
      stop: async () => {
        order.push('stop');
      },
      done: async () => ({ outcome: 'done', isError: false, reason: null, telemetry: zeroTelemetry() }),
      continueWith: async (text: string) => {
        order.push('continueWith');
        expect(text.length).toBeGreaterThan(0); // the rendered prompts/self-summary.md, non-empty
        return { outcome: 'done', isError: false, reason: null, telemetry: zeroTelemetry() };
      },
    };
    const ctx = baseCtx(session, {
      stopSession: async () => {
        order.push('stopSession');
        await session.stop();
      },
      getSessionText: () => 'ignored — no fence, so the summary is discarded, not the point of this test',
    });
    await settleStage(makeHost(), ctx);
    expect(order.indexOf('continueWith')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('continueWith')).toBeLessThan(order.indexOf('stopSession'));
  });
});
