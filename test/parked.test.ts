import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  // The whole Workspace, location included (RUN-50) — a resume must hand the backend exactly
  // what its lease() minted, and the park file is the one place that round-trips it as JSON.
  workspace: {
    runId: 'run_1',
    localPath: '/wt/run_1',
    readOnly: false,
    baseId: 'base0000',
    workRef: 'noriq/run/run_1',
    location: { repoRoot: '/repos/repo_a', branch: 'noriq/run/run_1' },
  },
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
    const ws = (await reborn.get('run_1'))?.workspace;
    expect(ws?.localPath).toBe('/wt/run_1');
    // The opaque location must survive the JSON round-trip intact — it is what the backend
    // reads back on resume, and a park that mangled it would strand the run.
    expect(ws?.location).toEqual({ repoRoot: '/repos/repo_a', branch: 'noriq/run/run_1' });
  });

  it('round-trips the dispatch workflow snapshot across a daemon restart (RUN-192)', async () => {
    const f = file();
    await new ParkedStore(f).park(
      entry({
        workflowCatalog: {
          definitions: {
            audit: {
              base: 'verify',
              prompt: 'Audit {{brief}}',
              promptSource: '/repo/.noriq/workflows/audit.md',
              stages: null,
              description: null,
              source: '/repo/.noriq/workflows/audit.toml',
              tier: 'project-file',
            },
          },
        },
      }),
    );

    const restored = await new ParkedStore(f).get('run_1');
    expect(restored?.workflowCatalog?.definitions.audit).toMatchObject({
      base: 'verify',
      prompt: 'Audit {{brief}}',
    });
  });

  it('drops a pre-RUN-50 park (no workspace) instead of resuming what it cannot read', async () => {
    const f = file();
    // The old loose fields, and no workspace — what a pre-RUN-50 daemon wrote.
    const { workspace: _dropped, ...stale } = { ...entry(), worktreePath: '/wt/run_1' };
    await writeFile(f, `${JSON.stringify({ parked: [stale] }, null, 2)}\n`);
    // Forgotten park, surviving worktree — the same trade the corrupt-file case makes.
    expect(await new ParkedStore(f).list()).toEqual([]);
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
  it('does not retain an in-memory park when its durable flush fails', async () => {
    const blocker = path.join(dir, `${Math.random().toString(36).slice(2)}-not-a-directory`);
    await writeFile(blocker, 'not a directory');
    const store = new ParkedStore(path.join(blocker, 'parked.json'));

    await expect(store.park(entry())).rejects.toThrow();
    // A lifecycle snapshot reads this cache before the process exits, so an entry whose write
    // failed must not reserve an execution locally while its caller follows the terminal path.
    expect(await store.list()).toEqual([]);
  });

  it('keeps cache and disk on the committed park when an unpark flush fails', async () => {
    const f = file();
    const store = new ParkedStore(f);
    await store.park(entry());
    // Blocking the write-then-rename temporary path fails the next flush without touching the
    // already-committed file, modelling the exact split-brain boundary this store must absorb.
    await mkdir(`${f}.tmp`);

    await expect(store.unpark('run_1')).rejects.toThrow();
    expect((await store.get('run_1'))?.sessionId).toBe('sess-abc');
    expect((await new ParkedStore(f).get('run_1'))?.sessionId).toBe('sess-abc');

    await rm(`${f}.tmp`, { recursive: true });
    expect((await store.unpark('run_1'))?.run.id).toBe('run_1');
    expect(await new ParkedStore(f).list()).toEqual([]);
  });

  it('serializes concurrent mutations of the shared parked file', async () => {
    const f = file();
    const store = new ParkedStore(f);
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.park(entry({ run: run(`run_${i}`), sessionId: `sess-${i}` })),
      ),
    );

    const removed = await Promise.all(Array.from({ length: 6 }, (_, i) => store.unpark(`run_${i}`)));
    expect(removed.every(Boolean)).toBe(true);
    expect((await new ParkedStore(f).list()).map((p) => p.run.id)).toEqual([
      'run_6',
      'run_7',
      'run_8',
      'run_9',
      'run_10',
      'run_11',
    ]);
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

// RUN-164. A park can last up to 72 hours. A human answering the question may have corrected the
// task's execution spec at the same time — the dashboard exists so they can — and another run may
// have landed under this one. A resume that says nothing about either carries on against a premise
// nobody re-checked.
describe('what a resumed session is told changed while it waited', () => {
  it('says nothing when nothing moved, so a resume stays as cheap as it was', () => {
    const p = resumePrompt('may I use zod?', 'yes');
    expect(p).toContain('yes');
    expect(p).not.toMatch(/REPLACES what you were told/);
  });

  // The session already holds the brief; what it does NOT hold is the fact that its contract moved.
  it('marks the new plan as replacing what the session was told before', () => {
    const p = resumePrompt('may I use zod?', 'yes', '\n\nEXECUTION SPEC — the corrected one');
    expect(p).toMatch(/REPLACES what you were told before it/);
    expect(p).toMatch(/where the two disagree, this is the one that counts/);
    expect(p).toContain('the corrected one');
  });

  it('still carries the answer and the question alongside it', () => {
    const p = resumePrompt('may I use zod?', 'yes', 'the new plan');
    expect(p).toContain('may I use zod?');
    expect(p).toContain('yes');
    expect(p).toContain('Carry on from where you stopped.');
  });
});
