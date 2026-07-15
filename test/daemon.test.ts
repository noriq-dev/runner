import { describe, expect, it } from 'vitest';
import { shouldForwardRunStatus } from '../src/daemon';

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
