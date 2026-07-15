import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Run } from '@noriq-dev/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ParkedRun, ParkedStore, expiredParks, resumePrompt } from '../src/parked';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'noriq-parked-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const file = () => path.join(dir, `${Math.random().toString(36).slice(2)}.json`);

const run = (id = 'run_1'): Run =>
  ({ id, projectId: 'prj_p', kind: 'build', agentTool: 'claude' }) as unknown as Run;

const entry = (over: Partial<ParkedRun> = {}): ParkedRun => ({
  run: run(),
  sessionId: 'sess-abc',
  agentId: 'agt_1',
  agentLabel: 'build-abc123',
  mcpToken: 'tok_secret',
  worktreePath: '/wt/run_1',
  worktreeBranch: 'noriq/run/run_1',
  repoRoot: '/repos/repo_a',
  spent: { tokens: 1000, usd: 0.5 },
  activeSeconds: 120,
  parkedAt: '2026-07-15T10:00:00.000Z',
  question: 'Should I use approach A or B?',
  ...over,
});

describe('ParkedStore survives the daemon (RUN-30)', () => {
  it('remembers a park across a fresh process', async () => {
    // The whole reason this is on disk: the answer may come tomorrow, and a park that only
    // lived in memory would strand the run AND the worktree holding its work.
    const f = file();
    await new ParkedStore(f).park(entry());
    const reborn = new ParkedStore(f); // a different daemon, cold
    expect((await reborn.get('run_1'))?.sessionId).toBe('sess-abc');
    expect((await reborn.get('run_1'))?.worktreePath).toBe('/wt/run_1');
  });

  it('unpark is exactly-once — the second caller gets nothing', async () => {
    // This is what makes resume idempotent: the WS frame and the reconnect sweep can BOTH fire
    // for one answer, and the loser must not start a rival process in the same worktree.
    const f = file();
    const store = new ParkedStore(f);
    await store.park(entry());
    expect((await store.unpark('run_1'))?.run.id).toBe('run_1');
    expect(await store.unpark('run_1')).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it('an unpark is durable, not just in-memory', async () => {
    const f = file();
    await new ParkedStore(f).park(entry());
    await new ParkedStore(f).unpark('run_1');
    expect(await new ParkedStore(f).list()).toEqual([]); // a restart must not resurrect it
  });

  it('holds several parks independently', async () => {
    const f = file();
    const store = new ParkedStore(f);
    await store.park(entry());
    await store.park(entry({ run: run('run_2'), sessionId: 'sess-2' }));
    await store.unpark('run_1');
    const left = await store.list();
    expect(left.map((p) => p.run.id)).toEqual(['run_2']);
  });

  it('starts empty rather than refusing to boot on a corrupt file', async () => {
    // The cost of tolerating it is a forgotten park, whose worktree still exists for the human.
    // The cost of throwing is a daemon that will not start at all.
    const f = file();
    await writeFile(f, '{ this is not json');
    expect(await new ParkedStore(f).list()).toEqual([]);
  });

  it('never leaves a half-written file behind', async () => {
    // A truncated file reads as "nothing was parked", which would silently abandon runs with
    // unmerged work. Hence write-then-rename.
    const f = file();
    const store = new ParkedStore(f);
    await store.park(entry());
    await store.park(entry({ run: run('run_2') }));
    const parsed = JSON.parse(await readFile(f, 'utf8'));
    expect(parsed.parked).toHaveLength(2);
  });
});

describe('expiredParks', () => {
  const at = (iso: string) => entry({ parkedAt: iso });
  const now = new Date('2026-07-15T12:00:00.000Z');

  it('leaves a park that is still within its window alone', () => {
    expect(expiredParks([at('2026-07-14T12:00:00.000Z')], now, 72)).toEqual([]);
  });

  it('gives up on one nobody answered in time', () => {
    // It pins a worktree and a branch while the base moves under it, and its agent's token
    // expires at 7 days — so a park that sits forever resumes into a world it cannot report to.
    expect(expiredParks([at('2026-07-11T11:00:00.000Z')], now, 72)).toHaveLength(1);
  });

  it('ignores a park with an unreadable timestamp instead of expiring it', () => {
    // Expiring on a parse failure would destroy a run's chance to come back over a typo.
    expect(expiredParks([at('not a date')], now, 72)).toEqual([]);
  });
});

describe('resumePrompt', () => {
  it('carries the answer AND the question back', () => {
    // The session has its own context; this is a reply, not a briefing. But a session resumed
    // after a night away should not have to infer what it asked from a bare answer.
    const p = resumePrompt('Approach A or B?', 'Use B.');
    expect(p).toContain('Approach A or B?');
    expect(p).toContain('Use B.');
    expect(p).toContain('Carry on');
    expect(p).not.toContain('undefined');
  });

  it('reads fine when the question was never captured', () => {
    expect(resumePrompt(null, 'Use B.')).toContain('Use B.');
    expect(resumePrompt(null, 'Use B.')).not.toContain('Your question');
  });
});
