import { describe, expect, it } from 'vitest';
import type { LockDelegate } from '../src/vcs/git';
import { type P4Cli, PerforceBackend } from '../src/vcs/perforce';

/** A fake Noriq lock view (the authoritative coordination layer) that records calls and returns
 *  a configurable acquire result. */
function fakeLocks(acquireResult: unknown = { ok: true, enabled: true, locks: [] }) {
  const calls: Array<{ method: string; token: string; args: unknown }> = [];
  const locks: LockDelegate = {
    acquire: async (token, input) => {
      calls.push({ method: 'acquire', token, args: input });
      return acquireResult as never;
    },
    release: async (token, projectId, sel) => {
      calls.push({ method: 'release', token, args: { projectId, sel } });
      return { released: [] };
    },
    check: async (token, input) => {
      calls.push({ method: 'check', token, args: input });
      return { enabled: true, conflicts: [], mine: [] };
    },
  };
  return { locks, calls };
}

// Orchestration tests over an injected p4 — the fake answers with the MEASURED outputs from
// RUN-55's real p4d session (VCS-SPIKE.md §10): the submit out-of-date refusal text, the
// resolve -n line shape, merge3's marker output, "Change N created". Server behaviour itself
// was proven there; these pin what the backend does with it.

interface Call {
  what: string;
  stdin?: string;
}

function fakes(over: {
  /** Lines `p4 opened -c N` prints; empty = nothing opened. */
  opened?: string;
  /** What reconcile -n previews. */
  reconcilePreview?: string;
  /** Unresolved files, as `p4 resolve -n` reports them. */
  unresolved?: string[];
  /** submit throws with this (the measured out-of-date text), or succeeds. */
  submitRefuses?: string;
  /** changes -l output (for the reaper / fromRunId lookup). */
  changesLong?: string;
  /** The Noriq lock view to inject (RUN-99). */
  locks?: LockDelegate;
}) {
  const calls: Call[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  let resolved = false; // resolve -ay flips the unresolved list to empty

  const p4: P4Cli = async (args, _cwd, stdin) => {
    calls.push({ what: `p4 ${args.join(' ')}`, ...(stdin ? { stdin } : {}) });
    const cmd = args.filter((a) => !a.startsWith('-') || a === '-n').join(' ');
    if (args.includes('info')) return { stdout: 'ws1\n', stderr: '' };
    if (args[0] === 'client' && args[1] === '-o')
      return { stdout: 'Client: ws1\nOptions: noallwrite noclobber\n', stderr: '' };
    if (args[0] === 'client' && args[1] === '-i') return { stdout: 'Client ws1 saved.\n', stderr: '' };
    if (args[0] === 'sync') return { stdout: '', stderr: '' };
    if (args.includes('changes') && args.includes('-m1')) return { stdout: '7\n', stderr: '' };
    if (args.includes('changes')) return { stdout: over.changesLong ?? '', stderr: '' };
    if (args.includes('change') && args.includes('-o')) {
      // --field applies the description into the emitted spec, exactly like the real p4.
      const field = args.find((a) => a.startsWith('Description='));
      const desc = field ? field.slice('Description='.length) : '<enter description here>';
      return {
        stdout: `Change: new\n\nClient: ws1\n\nDescription:\n\t${desc}\n`,
        stderr: '',
      };
    }
    if (args[0] === 'change' && args[1] === '-i') return { stdout: 'Change 42 created.\n', stderr: '' };
    if (args[0] === 'change' && args[1] === '-d') return { stdout: 'Change 42 deleted.\n', stderr: '' };
    if (args[0] === 'opened') return { stdout: over.opened ?? '', stderr: '' };
    if (args[0] === 'reconcile' && args.includes('-n'))
      return { stdout: over.reconcilePreview ?? '', stderr: '' };
    if (args[0] === 'reconcile') return { stdout: over.opened ?? '', stderr: '' };
    if (args[0] === 'shelve') return { stdout: 'Change 42 files shelved.\n', stderr: '' };
    if (args[0] === 'revert') return { stdout: '//depot/a.txt#1 - was edit, reverted\n', stderr: '' };
    if (args[0] === 'unshelve') return { stdout: '//depot/a.txt#1 - unshelved\n', stderr: '' };
    if (args[0] === 'resolve' && args.includes('-ay')) {
      resolved = true;
      return { stdout: '//ws1/shared.txt - ignored //depot/shared.txt\n', stderr: '' };
    }
    if (args[0] === 'resolve' && args.includes('-am'))
      return { stdout: 'Diff chunks: 0 yours + 0 theirs + 0 both + 1 conflicting\n', stderr: '' };
    if (args[0] === '-Ztag' && args.includes('resolve'))
      return { stdout: '//depot/shared.txt\t1\t2\n', stderr: '' };
    if (args[0] === 'resolve' && args.includes('-n')) {
      const files = resolved ? [] : (over.unresolved ?? []);
      return {
        stdout: files.map((f) => `${f} - merging //depot/shared.txt#2`).join('\n'),
        stderr: '',
      };
    }
    if (args[0] === 'lock' || args[0] === 'unlock') return { stdout: '', stderr: '' };
    if (args[0] === 'print') return { stdout: 'printed depot rev\n', stderr: '' };
    if (args[0] === 'merge3')
      return {
        stdout: '>>>> BASE CONFLICT\nline1\n>>>> L1 CONFLICT\ntheirs\n>>>> L2 CONFLICT\nyours\n',
        stderr: '',
      };
    if (args[0] === 'submit') {
      if (over.submitRefuses)
        throw new Error(
          `p4 submit exited 1: //depot/shared.txt - must resolve before submitting\n${over.submitRefuses}\nSubmit failed -- fix problems above then use 'p4 submit -c 42'.`,
        );
      return { stdout: 'Change 43 submitted.\n', stderr: '' };
    }
    throw new Error(`fake has no answer for: ${cmd}`);
  };

  const backend = new PerforceBackend({
    p4,
    writeFileFn: async (path, content) => {
      writes.push({ path, content });
    },
    locks: over.locks,
  });
  return { backend, calls, writes };
}

describe('PerforceBackend — lease/dispose', () => {
  it('leases: allwrite for a writable run, sync, and a changelist named after the run', async () => {
    const { backend, calls } = fakes({});
    const ws = await backend.lease('/ws1', 'run_1');
    expect(ws).toMatchObject({
      runId: 'run_1',
      localPath: '/ws1',
      baseId: '7',
      workRef: 'change 42 in client ws1',
      location: { client: 'ws1', change: '42' },
    });
    // The changelist spec carries the run id — it IS the crash-recovery record.
    expect(calls.find((c) => c.what === 'p4 change -i')?.stdin).toContain('noriq run run_1');
    // Writable lease flipped the client to allwrite (agents write; they don't p4 edit).
    expect(calls.find((c) => c.what === 'p4 client -i')?.stdin).toContain('allwrite');
  });

  it('continue a failed run: unshelves the prior attempt’s changelist into this sitting (RUN-93)', async () => {
    // A kept prior attempt at run_1 was shelved at dispose; its changelist still names the run.
    const { backend, calls } = fakes({
      changesLong: 'Change 30 on 2026/07/16 by noriq@ws1 *pending*\n\n\tnoriq run run_1\n\n',
    });
    const ws = await backend.lease('/ws1', 'run_1');
    expect(ws.location).toEqual({ client: 'ws1', change: '42' }); // this sitting's fresh changelist
    // The prior work is unshelved straight INTO changelist 42 (not the default, where reconcile -c
    // would skip it), then the stale shelf + changelist are dropped so they can't re-match.
    expect(calls.some((c) => c.what === 'p4 unshelve -s 30 -c 42')).toBe(true);
    expect(calls.some((c) => c.what === 'p4 shelve -d -c 30')).toBe(true);
    expect(calls.some((c) => c.what === 'p4 change -d 30')).toBe(true);
    await backend.dispose(ws);
  });

  it('a read-only lease keeps noallwrite — the OS enforces the scope floor for free', async () => {
    const { backend, calls } = fakes({});
    await backend.lease('/ws1', 'run_1', { readOnly: true });
    // Client already noallwrite → the spec is not touched at all.
    expect(calls.some((c) => c.what === 'p4 client -i')).toBe(false);
  });

  it('runs take turns: the pool-of-1 lease', async () => {
    const { backend } = fakes({});
    const ws1 = await backend.lease('/ws1', 'run_1');
    let leased2 = false;
    const second = backend.lease('/ws1', 'run_2').then((w) => {
      leased2 = true;
      return w;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(leased2).toBe(false);
    await backend.dispose(ws1);
    await second;
    expect(leased2).toBe(true);
  });

  it('dispose with opened files: shelve FIRST (durable), then revert — §5, measured', async () => {
    const { backend, calls } = fakes({ opened: '//depot/a.txt#1 - edit change 42\n' });
    const ws = await backend.lease('/ws1', 'run_1');
    calls.length = 0;
    await backend.dispose(ws);
    const order = calls.map((c) => c.what);
    expect(order.indexOf('p4 shelve -f -c 42')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('p4 shelve -f -c 42')).toBeLessThan(order.indexOf('p4 revert -c 42 //...'));
  });

  it('dispose with nothing opened deletes the empty changelist', async () => {
    const { backend, calls } = fakes({ opened: '' });
    const ws = await backend.lease('/ws1', 'run_1');
    calls.length = 0;
    await backend.dispose(ws);
    expect(calls.map((c) => c.what)).toContain('p4 change -d 42');
    expect(calls.some((c) => c.what.startsWith('p4 shelve'))).toBe(false);
  });

  it('declares disposePreservesWork — the pool-of-1 wedge guard', () => {
    expect(new PerforceBackend({ p4: async () => ({ stdout: '', stderr: '' }) }).disposePreservesWork).toBe(
      true,
    );
  });
});

describe('PerforceBackend — checkpoint (reconcile + shelve)', () => {
  it('reconciles the agent’s untracked writes into the changelist, then shelves', async () => {
    const { backend, calls } = fakes({ opened: '//depot/a.txt#1 - edit change 42\n' });
    const ws = await backend.lease('/ws1', 'run_1');
    calls.length = 0;
    expect(await backend.checkpoint(ws, 'msg')).toBe(true);
    expect(calls.map((c) => c.what)).toEqual(['p4 reconcile -c 42', 'p4 opened -c 42', 'p4 shelve -f -c 42']);
  });

  it('nothing to gather → false, and no shelve', async () => {
    const { backend, calls } = fakes({ opened: '' });
    const ws = await backend.lease('/ws1', 'run_1');
    calls.length = 0;
    expect(await backend.checkpoint(ws, 'msg')).toBe(false);
    expect(calls.some((c) => c.what.startsWith('p4 shelve'))).toBe(false);
  });
});

describe('PerforceBackend — integrate/resume (the measured headless loop)', () => {
  it('clean: sync + resolve -am, ok', async () => {
    const { backend } = fakes({ unresolved: [] });
    const ws = await backend.lease('/ws1', 'run_1');
    expect(await backend.integrate(ws, 'ignored')).toEqual({ ok: true });
  });

  it('conflict: merge3 markers are WRITTEN INTO the files so an agent can edit them', async () => {
    const { backend, writes } = fakes({ unresolved: ['/ws1/shared.txt'] });
    const ws = await backend.lease('/ws1', 'run_1');
    const res = await backend.integrate(ws, 'ignored');
    expect(res).toEqual({ ok: false, conflicts: ['shared.txt'] });
    // base+theirs go to temp files first (merge3 takes LOCAL files — measured the hard way);
    // the marker text lands in the CLIENT file, which is the one the agent edits.
    const markerWrite = writes.find((w) => w.path === '/ws1/shared.txt');
    expect(markerWrite?.content).toContain('CONFLICT'); // merge3's marker shape, measured
  });

  it('resume after the agent edited: resolve -ay accepts the edited result', async () => {
    const { backend, calls } = fakes({ unresolved: ['/ws1/shared.txt'] });
    const ws = await backend.lease('/ws1', 'run_1');
    await backend.integrate(ws, 'ignored');
    calls.length = 0;
    expect(await backend.resumeIntegrate(ws)).toEqual({ ok: true });
    expect(calls[0]?.what).toBe('p4 resolve -ay');
  });

  it('targetExists is always true and createTarget refuses loudly — branches do not exist here', async () => {
    const { backend } = fakes({});
    expect(await backend.targetExists('/ws1', 'anything')).toBe(true);
    await expect(backend.createTarget('/ws1', 'noriq/integration', 'main')).rejects.toThrow(
      /streams vs branch specs/,
    );
  });
});

describe('PerforceBackend — publish (submit IS the CAS, measured)', () => {
  it('drops the shelf, submits, reports the submitted change', async () => {
    const { backend, calls } = fakes({});
    const ws = await backend.lease('/ws1', 'run_1');
    calls.length = 0;
    expect(await backend.publish(ws, 'ignored')).toEqual({ ok: true, sha: 'change 43' });
    const order = calls.map((c) => c.what);
    expect(order.indexOf('p4 shelve -d -c 42')).toBeLessThan(order.indexOf('p4 submit -c 42'));
  });

  it('a moved line → {race}, from the server’s own refusal — the measured text', async () => {
    const { backend } = fakes({
      submitRefuses: 'Out of date files must be resolved or reverted.',
    });
    const ws = await backend.lease('/ws1', 'run_1');
    const res = await backend.publish(ws, 'ignored');
    expect(res).toMatchObject({ ok: false, reason: 'race' });
  });

  it('share is a no-op success — submit already published', async () => {
    const { backend, calls } = fakes({});
    calls.length = 0;
    expect(await backend.share('/ws1', 'x')).toEqual({ ok: true });
    expect(calls).toEqual([]);
  });
});

describe('PerforceBackend — the reaper (shelve, then clean — §5 measured)', () => {
  it('shelves an orphaned noriq changelist with opened files, reverts, and reports it', async () => {
    const { backend, calls } = fakes({
      changesLong: 'Change 42 on 2026/07/16 by noriq@ws1 *pending*\n\n\tnoriq run run_dead1\n\n',
      opened: '//depot/a.txt#1 - edit change 42\n',
    });
    const kept: string[] = [];
    expect(await backend.reapOrphans('/ws1', { onSkip: (p) => kept.push(p) })).toBe(1);
    const order = calls.map((c) => c.what);
    expect(order.indexOf('p4 shelve -f -c 42')).toBeLessThan(order.indexOf('p4 revert -c 42 //...'));
    expect(kept[0]).toContain('run_dead1');
    expect(kept[0]).toContain('shelved server-side');
  });

  it('ignores pending changelists that are not noriq runs — a human’s work is not ours to touch', async () => {
    const { backend, calls } = fakes({
      changesLong: 'Change 9 on 2026/07/16 by montana@ws1 *pending*\n\n\thand-written WIP\n\n',
    });
    expect(await backend.reapOrphans('/ws1')).toBe(0);
    expect(calls.some((c) => c.what.startsWith('p4 shelve'))).toBe(false);
  });
});

describe('PerforceBackend — location guard', () => {
  it('refuses a workspace whose location it did not mint', async () => {
    const { backend } = fakes({});
    const alien = {
      runId: 'run_9',
      localPath: '/x',
      readOnly: false,
      baseId: 'sha',
      workRef: 'b',
      location: { repoId: 'dv.repo.x', branch: 'b', baseBranch: 'main' }, // Diversion-shaped
    };
    await expect(backend.publish(alien, 'x')).rejects.toThrow(/Perforce location/);
  });
});

describe('PerforceBackend — locking (RUN-99): Noriq view authoritative, p4 lock as the native floor', () => {
  const ctx = { projectId: 'prj_x', token: 'run-token', branch: 'main', taskId: 'task_9' };

  it('acquires the Noriq view AND lays a native p4 lock on the run’s changelist', async () => {
    const { locks, calls: lockCalls } = fakeLocks({
      ok: true,
      enabled: true,
      locks: [{ id: 'lk', path: 'a.txt' }],
    });
    const { backend, calls } = fakes({ locks });
    const ws = await backend.lease('/ws1', 'run_1');
    const out = await backend.lock(ws, ['a.txt'], ctx);

    expect(out).toEqual({ ok: true, enabled: true, locks: [{ id: 'lk', path: 'a.txt' }] });
    // Noriq is the coordination truth, held as the RUN token…
    expect(lockCalls[0]).toMatchObject({ method: 'acquire', token: 'run-token' });
    // …and the native p4 lock names the run's changelist (42) as the enforcement floor.
    expect(calls.some((c) => c.what === 'p4 lock -c 42 a.txt')).toBe(true);
  });

  it('a Noriq conflict is all-or-nothing — no native p4 lock is attempted', async () => {
    const { locks } = fakeLocks({ ok: false, conflicts: [{ path: 'a.txt', holder: 'agt_other' }] });
    const { backend, calls } = fakes({ locks });
    const ws = await backend.lease('/ws1', 'run_1');
    const out = await backend.lock(ws, ['a.txt'], ctx);
    expect(out).toEqual({ ok: false, conflicts: [{ path: 'a.txt', holder: 'agt_other' }] });
    expect(calls.some((c) => c.what.startsWith('p4 lock'))).toBe(false);
  });

  it('a failing native p4 lock never fails the grant (best-effort floor)', async () => {
    const { locks } = fakeLocks({ ok: true, enabled: true, locks: [] });
    // p4 that throws on `lock` — the grant must still stand.
    const p4: P4Cli = async (args) => {
      if (args.includes('info')) return { stdout: 'ws1\n', stderr: '' };
      if (args[0] === 'client' && args[1] === '-o') return { stdout: 'Options: allwrite\n', stderr: '' };
      if (args[0] === 'sync') return { stdout: '', stderr: '' };
      if (args.includes('changes') && args.includes('-m1')) return { stdout: '7\n', stderr: '' };
      if (args.includes('changes')) return { stdout: '', stderr: '' };
      if (args.includes('change') && args.includes('-o'))
        return { stdout: 'Change: new\nDescription:\n\tnoriq run run_1\n', stderr: '' };
      if (args[0] === 'change' && args[1] === '-i') return { stdout: 'Change 42 created.\n', stderr: '' };
      if (args[0] === 'opened') return { stdout: '', stderr: '' };
      if (args[0] === 'lock') throw new Error('file(s) not opened on this client');
      return { stdout: '', stderr: '' };
    };
    const backend = new PerforceBackend({ p4, locks });
    const ws = await backend.lease('/ws1', 'run_1');
    expect(await backend.lock(ws, ['a.txt'], ctx)).toEqual({ ok: true, enabled: true, locks: [] });
  });

  it('with no lock view wired, locking reports disabled and touches no p4', async () => {
    const { backend, calls } = fakes({});
    const ws = await backend.lease('/ws1', 'run_1');
    const before = calls.length;
    expect(await backend.lock(ws, ['a.txt'], ctx)).toEqual({ ok: true, enabled: false, locks: [] });
    expect(calls.slice(before).some((c) => c.what.startsWith('p4 lock'))).toBe(false);
  });
});
