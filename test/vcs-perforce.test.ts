import { describe, expect, it } from 'vitest';
import { type P4Cli, PerforceBackend } from '../src/vcs/perforce';

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
