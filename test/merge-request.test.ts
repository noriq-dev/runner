// RUN-28: a completed plan becomes one merge request.
import { describe, expect, it } from 'vitest';
import { resolveLandBranch } from '../src/land';
import { mergeRequestBody, openMergeRequest } from '../src/merge-request';

describe('resolveLandBranch (RUN-28)', () => {
  it('gives each plan its own working branch', () => {
    // The whole point of the task: a human reviews one coherent plan's worth of work, so the
    // plan needs a branch of its own for the MR to mean anything.
    expect(resolveLandBranch('noriq/plan-<planKey>', 'runner-v2-15015o')).toBe('noriq/plan-runner-v2-15015o');
  });

  it('a one-off dispatch does NOT land on a branch named after the template', () => {
    // A run with no plan is normal (a one-off). Landing it on a branch literally called
    // "noriq/plan-<planKey>" would be absurd, and "noriq/plan-" is a git-legal branch that
    // nobody meant either — so the placeholder AND its trailing separator go.
    expect(resolveLandBranch('noriq/plan-<planKey>', null)).toBe('noriq/plan');
    expect(resolveLandBranch('noriq/plan/<planKey>', null)).toBe('noriq/plan');
  });

  it('leaves a static branch exactly alone', () => {
    // Every repo already using [land] has one of these. It must not change under them.
    expect(resolveLandBranch('noriq/integration', null)).toBe('noriq/integration');
    expect(resolveLandBranch('noriq/integration', 'some-plan-abc123')).toBe('noriq/integration');
  });

  it('substitutes every occurrence', () => {
    expect(resolveLandBranch('<planKey>/work/<planKey>', 'p1')).toBe('p1/work/p1');
  });
});

describe('openMergeRequest (RUN-28)', () => {
  const input = {
    repoRoot: '/repo',
    head: 'noriq/plan-alpha-abc123',
    base: 'main',
    planTitle: 'Runner v2',
    planKey: 'alpha-abc123',
  };

  it('opens the PR from the working branch to the repo-named target', async () => {
    let seen: string[] = [];
    const res = await openMergeRequest(input, async (args) => {
      seen = args;
      return { stdout: 'https://github.com/noriq-dev/runner/pull/7\n' };
    });
    expect(res.ok).toBe(true);
    expect(res.url).toBe('https://github.com/noriq-dev/runner/pull/7');
    expect(seen.slice(0, 6)).toEqual(['pr', 'create', '--base', 'main', '--head', 'noriq/plan-alpha-abc123']);
  });

  it('an already-open PR is success, not failure', async () => {
    // The desired end state is "this plan has a PR". If one is already open, that is met — and
    // reporting failure would have the daemon retry on every reconnect, forever.
    const res = await openMergeRequest(input, async () => {
      throw new Error('a pull request for branch "noriq/plan-alpha-abc123" already exists');
    });
    expect(res.ok).toBe(true);
  });

  it('hands a human the exact command when gh cannot do it', async () => {
    // gh missing, unauthed, no remote — the plan's work is landed AND pushed either way, so this
    // is news, not a lost diff. Naming the command beats a stack trace.
    const res = await openMergeRequest(input, async () => {
      throw new Error('gh: command not found');
    });
    expect(res.ok).toBe(false);
    expect(res.command).toContain('gh pr create');
    expect(res.command).toContain('--base main');
    expect(res.detail).toContain('command not found');
  });

  it('the body explains what was reviewed and how it got there', async () => {
    const body = mergeRequestBody(input);
    expect(body).toContain('Runner v2');
    expect(body).toContain('noriq/plan-alpha-abc123');
    expect(body).toMatch(/verified there|rebased onto/);
  });
});
