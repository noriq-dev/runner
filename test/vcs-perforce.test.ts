import { describe, expect, it } from 'vitest';
import type { LockDelegate } from '../src/vcs/git';
import { type P4Cli, PerforceBackend } from '../src/vcs/perforce';
import type { VcsBackend } from '../src/vcs/types';

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
    releaseAllMine: async (token, projectId) => {
      calls.push({ method: 'releaseAllMine', token, args: { projectId } });
      return { released: [] };
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

  // Conflict paths are CONTRACT values: they are rendered into the agent's conflict prompt and into
  // the comment posted when landing fails, so they must read the same wherever the daemon runs. A
  // nested path is the case that catches a host separator — the single-component path above cannot.
  it('reports a nested conflict workspace-relative and `/`-spelled, on any host', async () => {
    const { backend } = fakes({ unresolved: ['/ws1/src/deep/shared.txt'] });
    const ws = await backend.lease('/ws1', 'run_1');
    expect(await backend.integrate(ws, 'ignored')).toEqual({
      ok: false,
      conflicts: ['src/deep/shared.txt'],
    });
  });

  // `startsWith` reads a SIBLING as a child: `/ws11/x` under `/ws1` was reported as the relative
  // path `1/x` — a file that does not exist, named as though it were in the workspace.
  it('hands back a path outside the workspace rather than inventing a relative one', async () => {
    const { backend } = fakes({ unresolved: ['/ws11/elsewhere.txt'] });
    const ws = await backend.lease('/ws1', 'run_1');
    expect(await backend.integrate(ws, 'ignored')).toEqual({
      ok: false,
      conflicts: ['/ws11/elsewhere.txt'],
    });
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

  it('openReview refuses honestly: review happens in Perforce, and no p4 verb is invented (RUN-85)', async () => {
    // No Swarm/review API was measured (§10 covers submit/resolve/shelve, nothing else), so the
    // contract is a refusal naming where a human reviews — with ZERO p4 calls.
    const { backend, calls } = fakes({});
    calls.length = 0;
    const res = await backend.openReview('/ws1', {
      head: 'noriq/plan-alpha',
      base: 'main',
      planTitle: 'Runner v2',
      planKey: 'alpha',
    });
    expect(res).toEqual({
      ok: false,
      detail:
        'review happens in Perforce: the plan is submitted as numbered changelists on the line ' +
        'the client views — review them in your Perforce tooling (Swarm, or p4 describe); the ' +
        'daemon opens no Swarm review',
    });
    expect(calls).toEqual([]);
  });
});

describe('PerforceBackend — run-addressed verbs decline honestly (RUN-170)', () => {
  // Pool-of-1: a wave's steps run sequentially in the parent's own workspace, so these verbs
  // never legitimately fire here — and there is no per-run LINE to land on anyway (submit goes
  // to the line the client views). A call reaching them is a scheduling bug; the refusal names
  // the backend, with ZERO p4 calls — stating a fact about Perforce must not act on it.
  it('leaves leasesOverlap unset — the conservative, sequential-wave reading', () => {
    // Read through the seam, as the wave scheduler will — the capability is interface surface.
    const vcs: VcsBackend = fakes({}).backend;
    expect(vcs.leasesOverlap).toBeUndefined();
  });

  it('integrateFromRun and publishToRun refuse by name, without touching p4', async () => {
    const { backend, calls } = fakes({});
    const ws = await backend.lease('/ws1', 'run_1');
    calls.length = 0;
    await expect(backend.integrateFromRun(ws, 'run_parent')).rejects.toThrow(/Perforce.*pool-of-1/);
    await expect(backend.publishToRun(ws, 'run_parent')).rejects.toThrow(/Perforce/);
    expect(calls).toEqual([]);
  });
});

// RUN-211: no live p4d to measure a real read-only snapshot against, so this backend only ever
// answers unsupported — but the pool-contention check is real and testable without a server,
// and is exactly what stands between a background indexer and the deadlock
// `leaseIndexSnapshot`'s doc warns about (waiting behind a run lease this same process holds).
describe('PerforceBackend — index snapshot (RUN-211): try-acquire only, never a real snapshot', () => {
  it('answers unsupported when the workspace is free — no measured snapshot path exists here', async () => {
    const { backend } = fakes({});
    expect(await backend.leaseIndexSnapshot('/ws1')).toEqual({
      ok: false,
      reason: 'unsupported',
      detail: expect.stringContaining('Perforce'),
    });
  });

  it('answers busy IMMEDIATELY while a run holds the workspace — never chains onto the lease queue', async () => {
    const { backend } = fakes({});
    const ws = await backend.lease('/ws1', 'run_1'); // holds the pool; never disposed here
    // A wrong implementation chaining onto `queue` would hang until `dispose`, which never runs
    // in this test — vitest's own timeout would fail it rather than this awaiting forever.
    expect(await backend.leaseIndexSnapshot('/ws1')).toEqual({ ok: false, reason: 'busy' });
    await backend.dispose(ws);
  });

  it('releaseIndexSnapshot refuses everything — this backend never mints a snapshot to release', async () => {
    const { backend } = fakes({});
    await expect(
      backend.releaseIndexSnapshot({ localPath: '/ws1', baseId: 'x', readOnly: true, location: {} }),
    ).rejects.toThrow(/never mints an index snapshot/);
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

  // RUN-153. Once this runs on a TIMER rather than only at startup, an owned changelist is one an
  // agent is writing into right now — and this reaper's cleanup is `shelve` then `revert`, which
  // would undo the working tree out from under it.
  it('leaves a changelist the daemon still owns alone — the sweep now runs mid-flight', async () => {
    const { backend, calls } = fakes({
      changesLong: 'Change 42 on 2026/07/16 by noriq@ws1 *pending*\n\n\tnoriq run run_live\n\n',
      opened: '//depot/a.txt#1 - edit change 42\n',
    });
    expect(await backend.reapOrphans('/ws1', { isOwned: (id) => id === 'run_live' })).toBe(0);
    expect(calls.some((c) => c.what.startsWith('p4 shelve'))).toBe(false);
    expect(calls.some((c) => c.what.startsWith('p4 revert'))).toBe(false);
  });

  it('ignores pending changelists that are not noriq runs — a human’s work is not ours to touch', async () => {
    const { backend, calls } = fakes({
      changesLong: 'Change 9 on 2026/07/16 by montana@ws1 *pending*\n\n\thand-written WIP\n\n',
    });
    expect(await backend.reapOrphans('/ws1')).toBe(0);
    expect(calls.some((c) => c.what.startsWith('p4 shelve'))).toBe(false);
  });
});

// RUN-152. The caller disposes a workspace on `false`, so "p4 could not be reached" must never
// wear the same answer as "the changelist is empty". Awkward rather than free here, because p4
// signals emptiness by exiting NONZERO — the fix is to absorb exactly those two messages.
describe('PerforceBackend — hasWork tells "nothing here" from "could not ask"', () => {
  /** A p4 that answers `info`, then fails `opened` and `reconcile` with their OWN messages — they
   *  are different sentences, and feeding one to both would leave the second probe unpinned. */
  const failing = (over: { opened?: string; reconcile?: string }) => {
    const p4: P4Cli = async (args) => {
      if (args.includes('info')) return { stdout: 'ws1\n', stderr: '' };
      const text = args[0] === 'opened' ? over.opened : over.reconcile;
      if (!text) return { stdout: '', stderr: '' }; // succeeds, empty — not the case under test
      throw new Error(`p4 ${args[0]} exited 1: ${text}`);
    };
    return new PerforceBackend({ p4 });
  };
  const EMPTY_OPENED = 'File(s) not opened on this client.';
  const EMPTY_RECONCILE = '/ws1/... - no file(s) to reconcile.';
  const ws = {
    runId: 'run_1',
    localPath: '/ws1',
    readOnly: false,
    baseId: '7',
    workRef: 'change 42 in client ws1',
    location: { client: 'ws1', change: '42' },
  };

  it("reads p4's own emptiness messages as an answer: no work", async () => {
    const backend = failing({ opened: EMPTY_OPENED, reconcile: EMPTY_RECONCILE });
    expect(await backend.hasWork(ws)).toBe(false);
  });

  it('rejects when p4 could not be asked at all', async () => {
    const backend = failing({ opened: 'Connect to server failed; check $P4PORT.' });
    await expect(backend.hasWork(ws)).rejects.toThrow(/Connect to server failed/);
  });

  it('rejects on an auth expiry rather than reporting the workspace empty', async () => {
    const backend = failing({ opened: 'Your session has expired, please login again.' });
    await expect(backend.hasWork(ws)).rejects.toThrow(/session has expired/);
  });

  // The SECOND probe is the one a single-message fake would leave untested: `opened` says nothing
  // is open (true of an allwrite workspace that has never been reconciled) and the reconcile
  // preview is then the only thing that can see the edits.
  it('rejects when the reconcile preview fails, even though nothing was opened', async () => {
    const backend = failing({ opened: EMPTY_OPENED, reconcile: 'Connect to server failed; check $P4PORT.' });
    await expect(backend.hasWork(ws)).rejects.toThrow(/Connect to server failed/);
  });
});

// RUN-157. Both of these acted on a swallowed probe: dispose DELETED a changelist it could not
// read, and checkpoint reported "nothing to save" for a p4 it could not reach. The second is the
// quieter one — the supervisor ignores checkpoint's boolean, so the run continued to its gates with
// no durable copy and nothing anywhere saying so.
describe('PerforceBackend — dispose and checkpoint stop acting on a swallowed probe', () => {
  const ws = {
    runId: 'run_1',
    localPath: '/ws1',
    readOnly: false,
    baseId: '7',
    workRef: 'change 42 in client ws1',
    location: { client: 'ws1', change: '42' },
  };
  /** A p4 that answers `info`, fails the named command with `text`, and succeeds at everything else. */
  const failing = (cmd: string, text: string) => {
    const calls: string[] = [];
    const p4: P4Cli = async (args) => {
      calls.push(args.join(' '));
      if (args.includes('info')) return { stdout: 'ws1\n', stderr: '' };
      if (args[0] === cmd) throw new Error(`p4 ${cmd} exited 1: ${text}`);
      return { stdout: '', stderr: '' };
    };
    return { backend: new PerforceBackend({ p4 }), calls };
  };

  it('dispose PRESERVES a changelist it could not read, rather than deleting it', async () => {
    // An allwrite workspace's edits are invisible to p4 until a reconcile, so "could not ask"
    // cannot be read as "there is nothing in here" — that work has never been shelved.
    const { backend, calls } = failing('opened', 'Connect to server failed; check $P4PORT.');
    await backend.dispose(ws);
    expect(calls.some((c) => c.startsWith('change -d'))).toBe(false); // never the destructive branch
    // RECONCILE first, and this is the whole point rather than a detail: `shelve` captures only
    // files already OPEN in the changelist, and on allwrite an agent's edits are not open until
    // something gathers them. A shelve without it preserves an empty changelist and calls it done.
    const order = calls.map((c) => c.split(' ')[0]);
    expect(order.indexOf('reconcile')).toBeGreaterThan(-1);
    expect(order.indexOf('reconcile')).toBeLessThan(order.indexOf('shelve'));
    expect(order.indexOf('shelve')).toBeLessThan(order.indexOf('revert'));
  });

  // Reverting after a shelf that did not land destroys the only copy to tidy a workspace.
  it('does NOT revert when the shelf failed — the local copy is all there is', async () => {
    const calls: string[] = [];
    const p4: P4Cli = async (args) => {
      calls.push(args.join(' '));
      if (args.includes('info')) return { stdout: 'ws1\n', stderr: '' };
      if (args[0] === 'opened') return { stdout: '//depot/a.txt#1 - edit change 42\n', stderr: '' };
      if (args[0] === 'shelve') throw new Error('p4 shelve exited 1: Connect to server failed.');
      return { stdout: '', stderr: '' };
    };
    await new PerforceBackend({ p4 }).dispose(ws);
    expect(calls.some((c) => c.startsWith('shelve'))).toBe(true); // it tried…
    expect(calls.some((c) => c.startsWith('revert'))).toBe(false); // …and stopped when it failed
  });

  it('dispose still deletes an empty changelist when p4 SAYS it is empty', async () => {
    const { backend, calls } = failing('opened', 'File(s) not opened on this client.');
    await backend.dispose(ws);
    expect(calls.some((c) => c.startsWith('change -d'))).toBe(true);
    expect(calls.some((c) => c.startsWith('shelve'))).toBe(false);
  });

  it('checkpoint rejects when p4 could not be reached, instead of reporting nothing to save', async () => {
    const { backend } = failing('reconcile', 'Connect to server failed; check $P4PORT.');
    await expect(backend.checkpoint(ws, 'msg')).rejects.toThrow(/Connect to server failed/);
  });

  // The SECOND probe, which a single-failure fake leaves untested: reconcile can succeed (it
  // gathered something) while `opened` is the call that cannot reach the server.
  it('checkpoint rejects when the second probe is the one that fails', async () => {
    const { backend } = failing('opened', 'Your session has expired, please login again.');
    await expect(backend.checkpoint(ws, 'msg')).rejects.toThrow(/session has expired/);
  });

  it('checkpoint still returns false when there was genuinely nothing to gather', async () => {
    const { backend } = failing('reconcile', '/ws1/... - no file(s) to reconcile.');
    expect(await backend.checkpoint(ws, 'msg')).toBe(false);
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
