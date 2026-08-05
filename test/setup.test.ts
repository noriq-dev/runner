import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SetupSpec } from '@noriq-dev/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearSetupMarker, runSetup, setupBriefNote, setupMilestone } from '../src/setup';
import type { VerifyExec } from '../src/verify';

// RUN-202. A fresh worktree has no node_modules, so every agent used to open by discovering that —
// builders spending turns on `npm ci`, and one read-only reviewer burning its turns watching `npx`
// die EAI_AGAIN and writing a paragraph about it instead of judging the diff. The daemon does it
// first, for free. Preparation, never a gate.

const spec = (over: Partial<SetupSpec> = {}) => SetupSpec.parse(over);

/** An exec that records what it was asked to run and answers from a script. */
const execOver = (results: Array<{ exitCode: number | null; timedOut?: boolean; output?: string }>) => {
  const calls: Array<{ cmd: string; cwd: string; timeoutMs: number }> = [];
  let i = 0;
  const exec: VerifyExec = async (cmd, cwd, timeoutMs) => {
    calls.push({ cmd, cwd, timeoutMs });
    const r = results[i++] ?? { exitCode: 0 };
    return { exitCode: r.exitCode, output: r.output ?? '', timedOut: r.timedOut ?? false };
  };
  return { exec, calls };
};

describe('running a workspace bootstrap', () => {
  let cwd: string;
  let markers: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'noriq-setup-'));
    markers = await mkdtemp(path.join(tmpdir(), 'noriq-markers-'));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(markers, { recursive: true, force: true });
  });

  it('says nothing at all when the repo declares no setup', async () => {
    const { exec, calls } = execOver([]);
    expect(await runSetup(null, cwd, exec, undefined, markers)).toBeNull();
    expect(await runSetup(spec(), cwd, exec, undefined, markers)).toBeNull(); // an empty list is the same as absent
    expect(calls).toEqual([]);
  });

  it('runs the commands IN ORDER, in the workspace, under the manifest timeout', async () => {
    const { exec, calls } = execOver([{ exitCode: 0 }, { exitCode: 0 }]);
    const r = await runSetup(
      spec({ cmds: ['npm ci', 'npm run codegen'], timeoutSeconds: 90 }),
      cwd,
      exec,
      undefined,
      markers,
    );
    expect(r?.ok).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual(['npm ci', 'npm run codegen']);
    expect(calls.every((c) => c.cwd === cwd)).toBe(true);
    expect(calls[0]?.timeoutMs).toBe(90_000);
  });

  // Ordered steps: a codegen that needs `npm ci` fails for a reason the first failure already
  // explains, so a second report would be the first one's shadow.
  it('stops at the first failure rather than running the rest', async () => {
    const { exec, calls } = execOver([{ exitCode: 1, output: 'ENOENT' }, { exitCode: 0 }]);
    const r = await runSetup(spec({ cmds: ['npm ci', 'npm run codegen'] }), cwd, exec, undefined, markers);
    expect(r?.ok).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual(['npm ci']);
    expect(r?.ran.at(-1)?.output).toContain('ENOENT'); // the diagnostic is kept for the brief
  });

  it('a timeout is reported as a timeout, not as an exit code', async () => {
    const { exec } = execOver([{ exitCode: null, timedOut: true }]);
    const r = await runSetup(spec({ cmds: ['npm ci'] }), cwd, exec, undefined, markers);
    expect(r?.ran.at(-1)).toMatchObject({ ok: false, timedOut: true });
    expect(setupMilestone(r)).toContain('timed out');
  });

  // The case that actually matters: a continuation or a resumed park re-enters a workspace that is
  // already bootstrapped, and re-running `npm ci` there spends a minute to arrive where it started.
  it('skips a workspace already bootstrapped with the SAME spec', async () => {
    const s = spec({ cmds: ['npm ci'] });
    const first = execOver([{ exitCode: 0 }]);
    await runSetup(s, cwd, first.exec, undefined, markers);
    expect(first.calls).toHaveLength(1);

    const second = execOver([{ exitCode: 0 }]);
    const r = await runSetup(s, cwd, second.exec, undefined, markers);
    expect(r).toMatchObject({ ok: true, skipped: true });
    expect(second.calls).toEqual([]); // nothing re-run
    expect(setupMilestone(r)).toBeNull(); // and nothing said about it
  });

  // Editing [setup] must re-run it — otherwise a repo that adds a codegen step keeps resuming into
  // workspaces that never ran it and debugs a phantom.
  it('re-runs when the commands changed since the marker was written', async () => {
    await runSetup(spec({ cmds: ['npm ci'] }), cwd, execOver([{ exitCode: 0 }]).exec, undefined, markers);
    const next = execOver([{ exitCode: 0 }, { exitCode: 0 }]);
    const r = await runSetup(
      spec({ cmds: ['npm ci', 'npm run codegen'] }),
      cwd,
      next.exec,
      undefined,
      markers,
    );
    expect(r?.skipped).toBe(false);
    expect(next.calls).toHaveLength(2);
  });

  it('does not mark a workspace whose bootstrap FAILED — the next sitting tries again', async () => {
    await runSetup(spec({ cmds: ['npm ci'] }), cwd, execOver([{ exitCode: 1 }]).exec, undefined, markers);
    const retry = execOver([{ exitCode: 0 }]);
    const again = await runSetup(spec({ cmds: ['npm ci'] }), cwd, retry.exec, undefined, markers);
    expect(again?.skipped).toBe(false);
    expect(retry.calls).toHaveLength(1);
  });

  // The marker must never live in the tree: `checkpoint` stages with `git add -A`, so a dotfile
  // there would ride into the run's own commit and out through the reviewer's diff — and a run
  // that changed nothing would report work. The workspace holds what the AGENT put there.
  it('leaves NOTHING in the workspace — the marker lives in the daemon’s own directory', async () => {
    await runSetup(spec({ cmds: ['npm ci'] }), cwd, execOver([{ exitCode: 0 }]).exec, undefined, markers);
    expect(await readdir(cwd)).toEqual([]);
    expect((await readdir(markers)).length).toBe(1);
  });

  // Disposing a workspace forgets its bootstrap: a backend that later leases the same directory
  // must install into a tree that no longer holds what the last run installed.
  it('clearSetupMarker makes the next lease at that path bootstrap again', async () => {
    const s = spec({ cmds: ['npm ci'] });
    await runSetup(s, cwd, execOver([{ exitCode: 0 }]).exec, undefined, markers);
    await clearSetupMarker(cwd, markers);
    const after = execOver([{ exitCode: 0 }]);
    const r = await runSetup(s, cwd, after.exec, undefined, markers);
    expect(r?.skipped).toBe(false);
    expect(after.calls).toHaveLength(1);
  });

  // Fail-open is the whole posture: `runSetup` is called inside prepare, and a throw there would
  // refuse a dispatch over a bootstrap that is preparation, not a gate.
  it('never throws, even when the exec seam rejects', async () => {
    const exploding: VerifyExec = async () => {
      throw new Error('spawn EACCES');
    };
    const r = await runSetup(spec({ cmds: ['npm ci'] }), cwd, exploding, undefined, markers);
    expect(r?.ok).toBe(false);
    expect(r?.ran.at(-1)?.output).toContain('EACCES');
  });
});

describe('what the run is told about its bootstrap', () => {
  it('a healthy bootstrap gets a milestone and NOTHING in the brief', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'noriq-setup-'));
    try {
      const markers = await mkdtemp(path.join(tmpdir(), 'noriq-markers-'));
      const r = await runSetup(
        SetupSpec.parse({ cmds: ['npm ci'] }),
        cwd,
        (async () => ({ exitCode: 0, output: '', timedOut: false })) as VerifyExec,
        undefined,
        markers,
      );
      expect(setupMilestone(r)).toMatch(/workspace setup: npm ci — ok/);
      // Telling an agent its tools are installed spends context to describe the normal case.
      expect(setupBriefNote(r)).toBe('');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('a failed one tells the agent it is not their fault, and hands over the output', () => {
    const note = setupBriefNote({
      ok: false,
      skipped: false,
      ran: [{ cmd: 'npm ci', ok: false, exitCode: 1, timedOut: false, seconds: 3, output: 'EAI_AGAIN' }],
    });
    expect(note).toContain('WORKSPACE SETUP FAILED');
    expect(note).toContain('npm ci');
    expect(note).toContain('EAI_AGAIN');
    // The live failure this exists for: a reviewer that read a missing toolchain as its own problem.
    expect(note).toContain('not your mistake');
  });
});
