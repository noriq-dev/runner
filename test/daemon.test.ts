import { describe, expect, it } from 'vitest';
import { shouldForwardRunStatus, telemetryFrame } from '../src/daemon';
import { zeroTelemetry } from '../src/drivers/types';

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
