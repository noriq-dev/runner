import { describe, expect, it } from 'vitest';
import { INDEX_LANGUAGES, type ResolvedIndexConfig } from '../src/index-policy';
import { scanIndexSource } from '../src/index-scan';
import { FakeIndexSource } from '../src/index-source';
import type { LockDelegate } from '../src/vcs/git';
import { type P4Cli, PerforceBackend } from '../src/vcs/perforce';
import { type P4RawCli, PerforceDepotIndexSource } from '../src/vcs/perforce-index-source';
import type { VcsBackend } from '../src/vcs/types';

/** A fully-populated `ResolvedIndexConfig`, mirroring `index-scan.test.ts`'s own helper — used
 *  only by the deny-list integration test below, which proves the hard deny list still binds
 *  when the bytes come from a depot read (RUN-254 acceptance truth), not by anything else here. */
const indexCfg = (over: Partial<ResolvedIndexConfig> = {}): ResolvedIndexConfig => ({
  languages: [...INDEX_LANGUAGES],
  contentMode: 'full',
  maxFiles: 10_000,
  maxFileBytes: 1_000_000,
  maxTotalBytes: 500_000_000,
  readDeadlineMs: 120_000,
  pollIntervalMinutes: 60,
  include: [],
  exclude: [],
  ...over,
});

/**
 * Verbatim `p4 -Ztag fstat -Ol //depot/...@2` output, captured from the p4d rig (RUN-253/254,
 * p4d 2026.1) — the fixture every RUN-254 unit test below is driven by, per the task's own
 * requirement that CI stay hermetic while the fixtures still match what a real server said.
 * `scripts/p4d-rig/measure.sh` re-produces this; see also `test/vcs-perforce-live.test.ts`, which
 * re-asserts it against a live rig when one is up.
 */
const FSTAT_AT_2 = `... depotFile //depot/config/.env
... headAction add
... headType text
... headTime 1786236019
... headRev 1
... headChange 1
... headModTime 1786236019
... fileSize 37
... digest D201650FF5B00A890392F0F1679CF825

... depotFile //depot/config/app.json
... headAction add
... headType text
... headTime 1786236019
... headRev 1
... headChange 1
... headModTime 1786236019
... fileSize 19
... digest 763063E8F517C405C3B5D56DEA039E61

... depotFile //depot/docs/NEW.md
... headAction add
... headType text
... headTime 1786236019
... headRev 1
... headChange 2
... headModTime 1786236019
... fileSize 12
... digest 59E3CFC1EBE6DE8FC3E9B44CE531E3A5

... depotFile //depot/docs/OLD.md
... headAction delete
... headType text
... headTime 1786236019
... headRev 2
... headChange 2
... headModTime 0

... depotFile //depot/docs/README.md
... headAction add
... headType text
... headTime 1786236019
... headRev 1
... headChange 1
... headModTime 1786236019
... fileSize 37
... digest 1EFBF2CAB2538A00A43A683F9C9210A4

... depotFile //depot/src/add.ts
... headAction edit
... headType text
... headTime 1786236019
... headRev 2
... headChange 2
... headModTime 1786236019
... fileSize 74
... digest C24DE970FC860A6C2E3CAB19C7605A35

... depotFile //depot/src/after.ts
... headAction move/add
... headType text
... headTime 1786236019
... headRev 1
... headChange 2
... headModTime 1786236019
... fileSize 14
... digest 13DA84E897C5487341147CBC4C8CB588

... depotFile //depot/src/before.ts
... headAction move/delete
... headType text
... headTime 1786236019
... headRev 2
... headChange 2
... headModTime 0

... depotFile //depot/src/blob.bin
... headAction add
... headType binary
... headTime 1786236019
... headRev 1
... headChange 1
... headModTime 1786236019
... fileSize 4096
... digest 606C60A90062D5E25E723E159667072F

... depotFile //depot/src/util/name.ts
... headAction add
... headType text
... headTime 1786236019
... headRev 1
... headChange 1
... headModTime 1786236019
... fileSize 30
... digest F2E1142E43EB5D1AB9538269B2BBBB1D
`;

/** Verbatim `p4 diff2 -q //depot/...@1 //depot/...@2` output, captured from the same rig session
 *  — the deleted arm's `===` (three) vs the other arms' `====` (four) is not a typo in this
 *  fixture; it is the exact trap RUN-254's parser is built to survive. */
const DIFF2_1_TO_2 = `==== <none> - //depot/docs/NEW.md#1 ====
==== //depot/docs/OLD.md#1 - <none> ===
==== //depot/src/add.ts#1 (text) - //depot/src/add.ts#2 (text) ==== content
==== <none> - //depot/src/after.ts#1 ====
==== //depot/src/before.ts#1 - <none> ===`;

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

/** `fakes()` never spawns anything real — a test that reaches this without configuring
 *  `over.p4Raw` explicitly is a test that forgot it needs one, not a test allowed to fall through
 *  to `realP4RawCli` (RUN-254: CI must stay hermetic, `npm run check` runs with no container). */
const throwingP4Raw: P4RawCli = async (args) => {
  throw new Error(
    `fakes(): no p4Raw configured — pass over.p4Raw for a test whose PerforceDepotIndexSource calls read()/digest() (attempted: p4 ${args.join(' ')})`,
  );
};

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
  /** `changes -m1 <spec>` answer (RUN-254: both `lease`'s `#have` probe and
   *  `leaseIndexSnapshot`'s depot-head probe share this condition) — defaults to '7', unchanged
   *  from before RUN-254 touched this file. */
  changeHead?: string;
  /** `-Ztag fstat -Ol <prefix>@<change>` answer, for the depot index source's enumeration. */
  fstat?: string;
  /** Changelist ids `describe -s` answers "no such changelist." for (RUN-254). */
  describeMissing?: Set<string>;
  /** Changelist ids `describe -s` answers with a nonzero-exit usage error for (RUN-254). */
  describeInvalid?: Set<string>;
  /** `diff2 -q` answer, for `changesBetween`. */
  diff2?: string;
  /** Buffer-safe runner for the depot source's content reads — see `throwingP4Raw`. */
  p4Raw?: P4RawCli;
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
      // The View line is what RUN-254's `resolveDepotPrefix` reads — added for every test, not
      // just the new ones, since a client spec with no View is not a shape any real `p4 client -o`
      // produces for a client that has ever been usable.
      return {
        stdout: 'Client: ws1\nOptions: noallwrite noclobber\nView:\n\t//depot/... //ws1/...\n',
        stderr: '',
      };
    if (args[0] === 'client' && args[1] === '-i') return { stdout: 'Client ws1 saved.\n', stderr: '' };
    if (args[0] === 'sync') return { stdout: '', stderr: '' };
    if (args[0] === '-Ztag' && args.includes('fstat')) return { stdout: over.fstat ?? '', stderr: '' };
    if (args[0] === 'describe' && args[1] === '-s') {
      const id = args[2] ?? '';
      if (over.describeInvalid?.has(id))
        throw new Error(`p4 describe exited 1: Invalid changelist number '${id}'.`);
      if (over.describeMissing?.has(id)) return { stdout: `${id} - no such changelist.\n`, stderr: '' };
      return { stdout: `Change ${id} by noriq@ws1 on 2026/08/09 00:00:00\n\n\tsample\n`, stderr: '' };
    }
    if (args[0] === 'diff2') return { stdout: over.diff2 ?? '', stderr: '' };
    if (args.includes('changes') && args.includes('-m1'))
      return { stdout: `${over.changeHead ?? '7'}\n`, stderr: '' };
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
    p4Raw: over.p4Raw ?? throwingP4Raw,
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

// RUN-254 replaces RUN-211's `unsupported` refusal with a real depot-backed snapshot: a depot
// read needs no client workspace at all (measured with P4CLIENT=no-such-client-at-all against the
// rig), so — unlike the old design's assumption — a snapshot never contends with this backend's
// own pool-of-1 run lease. `changeHead: '2'` below is what makes `resolveDepotPrefix` + the head
// probe answer deterministically across these tests.
describe('PerforceBackend — leaseIndexSnapshot / releaseIndexSnapshot (RUN-254): real depot reads', () => {
  it('mints a real snapshot: no localPath, no client/sync calls, baseId is the depot head', async () => {
    const { backend, calls } = fakes({ changeHead: '2', fstat: FSTAT_AT_2 });
    const res = await backend.leaseIndexSnapshot('/ws1');
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok:true');
    expect(res.snapshot.baseId).toBe('2');
    expect(res.snapshot.readOnly).toBe(true);
    expect(res.snapshot.localPath).toBeUndefined(); // materializes nothing — locked decision 1
    expect(res.snapshot.branch).toBeUndefined();
    expect(res.snapshot.source.kind).toBe('perforce-depot');
    // No client mint, no sync, no changelist creation — the acceptance truth that indexing never
    // touches the workspace.
    expect(calls.some((c) => c.what.startsWith('p4 client -i'))).toBe(false);
    expect(calls.some((c) => c.what.startsWith('p4 sync'))).toBe(false);
    expect(calls.some((c) => c.what.startsWith('p4 change -i'))).toBe(false);
  });

  it('mints a real snapshot even while a run lease is held — no pool contention (RUN-254)', async () => {
    const { backend } = fakes({ changeHead: '2', fstat: FSTAT_AT_2 });
    const ws = await backend.lease('/ws1', 'run_1'); // holds the pool; never disposed until below
    const res = await backend.leaseIndexSnapshot('/ws1');
    expect(res.ok).toBe(true);
    await backend.dispose(ws);
  });

  it('answers unsupported when the depot prefix has no submitted changelist at all', async () => {
    const { backend } = fakes({ changeHead: '' });
    expect(await backend.leaseIndexSnapshot('/ws1')).toEqual({
      ok: false,
      reason: 'unsupported',
      detail: expect.stringContaining('//depot/...'),
    });
  });

  it('rejects (an infra fault, not a routine negative) when the client spec has no View mapping', async () => {
    const p4: P4Cli = async (args) => {
      if (args.includes('info')) return { stdout: 'ws1\n', stderr: '' };
      if (args[0] === 'client' && args[1] === '-o')
        return { stdout: 'Client: ws1\nOptions: noallwrite\n', stderr: '' };
      throw new Error(`unexpected: ${args.join(' ')}`);
    };
    const backend = new PerforceBackend({ p4 });
    await expect(backend.leaseIndexSnapshot('/ws1')).rejects.toThrow(/View mapping/);
  });

  it('releases a real snapshot idempotently (nothing was materialized, so nothing to remove)', async () => {
    const { backend } = fakes({ changeHead: '2', fstat: FSTAT_AT_2 });
    const res = await backend.leaseIndexSnapshot('/ws1');
    if (!res.ok) throw new Error('expected ok:true');
    await backend.releaseIndexSnapshot(res.snapshot);
    await backend.releaseIndexSnapshot(res.snapshot); // second call — idempotent
  });

  it('refuses to release a foreign run Workspace (no `perforce-index-snapshot` tag)', async () => {
    const { backend } = fakes({});
    await expect(
      backend.releaseIndexSnapshot({
        source: new FakeIndexSource([]),
        localPath: '/ws1',
        baseId: '7',
        readOnly: true,
        location: { client: 'ws1', change: '42' }, // a run's own P4Location shape
      }),
    ).rejects.toThrow(/did not mint/);
  });

  it('refuses to release a git-shaped index snapshot (a different backend`s discriminant)', async () => {
    const { backend } = fakes({});
    await expect(
      backend.releaseIndexSnapshot({
        source: new FakeIndexSource([]),
        baseId: 'deadbeef',
        readOnly: true,
        location: { repoRoot: '/repo', kind: 'index-snapshot' },
      }),
    ).rejects.toThrow(/did not mint/);
  });
});

// RUN-222: exactly `leaseIndexSnapshot`'s own `baseId` derivation, MEASURED against the real p4d
// rig (2026-08-09, `noriq-p4d:2026.1`) at 4ms with no client sync — see this method's own doc.
describe('PerforceBackend — currentBase (RUN-222)', () => {
  it('answers the depot head under this client’s view — no client mint, no sync', async () => {
    const { backend, calls } = fakes({ changeHead: '2' });
    expect(await backend.currentBase('/ws1')).toEqual({ ok: true, baseId: '2' });
    expect(calls.some((c) => c.what.startsWith('p4 client -i'))).toBe(false);
    expect(calls.some((c) => c.what.startsWith('p4 sync'))).toBe(false);
  });

  it('ignores a branch argument — Perforce has no branch concept', async () => {
    const { backend } = fakes({ changeHead: '2' });
    expect(await backend.currentBase('/ws1', 'main')).toEqual({ ok: true, baseId: '2' });
  });

  it('answers unknown when the depot prefix has no submitted changelist at all', async () => {
    const { backend } = fakes({ changeHead: '' });
    expect(await backend.currentBase('/ws1')).toMatchObject({ ok: false, reason: 'unknown' });
  });

  it('answers unknown, never throws, when the client spec has no View mapping', async () => {
    const p4: P4Cli = async (args) => {
      if (args.includes('info')) return { stdout: 'ws1\n', stderr: '' };
      if (args[0] === 'client' && args[1] === '-o')
        return { stdout: 'Client: ws1\nOptions: noallwrite\n', stderr: '' };
      throw new Error(`unexpected: ${args.join(' ')}`);
    };
    const backend = new PerforceBackend({ p4 });
    const res = await backend.currentBase('/ws1');
    expect(res).toMatchObject({ ok: false, reason: 'unknown' });
  });

  it('never touches the pool-of-1 lease — held WHILE this is asked, same as leaseIndexSnapshot', async () => {
    const { backend } = fakes({ changeHead: '2' });
    const ws = await backend.lease('/ws1', 'run_1');
    expect(await backend.currentBase('/ws1')).toEqual({ ok: true, baseId: '2' });
    await backend.dispose(ws);
  });
});

// RUN-254 replaces RUN-212's unconditional `full-index-required` with a real `p4 diff2 -q`-backed
// answer. `changeHead`/`fstat` are irrelevant here — `changesBetween` never lists a tree, only
// `resolveDepotPrefix` (client -o) and `describe`/`diff2` matter.
describe('PerforceBackend — changesBetween (RUN-254): p4 diff2 -q, measured', () => {
  it('decomposes add/delete/modify/move exactly as the rig reported them, deletions included', async () => {
    const { backend } = fakes({ diff2: DIFF2_1_TO_2 });
    const res = await backend.changesBetween('/ws1', '1', '2');
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok:true');
    expect(new Set(res.changed)).toEqual(new Set(['docs/NEW.md', 'src/add.ts', 'src/after.ts']));
    expect(new Set(res.deleted)).toEqual(new Set(['docs/OLD.md', 'src/before.ts']));
  });

  it('reports two identical bases as a REAL empty diff, not full-index-required (locked decision 2)', async () => {
    const { backend } = fakes({ diff2: '//depot/...@1 - no differing files.\n' });
    expect(await backend.changesBetween('/ws1', '1', '1')).toEqual({ ok: true, changed: [], deleted: [] });
  });

  it('escalates on an unknown changelist — diff2 itself would silently clamp to head instead', async () => {
    const { backend } = fakes({ describeMissing: new Set(['999999']), diff2: DIFF2_1_TO_2 });
    const res = await backend.changesBetween('/ws1', '1', '999999');
    expect(res).toMatchObject({ ok: false, reason: 'full-index-required' });
    if (res.ok) throw new Error('expected ok:false');
    expect(res.detail).toContain('999999');
  });

  it('escalates on a syntactically invalid changelist id', async () => {
    const { backend } = fakes({ describeInvalid: new Set(['abc']) });
    const res = await backend.changesBetween('/ws1', 'abc', '2');
    expect(res).toMatchObject({ ok: false, reason: 'full-index-required' });
  });

  it('escalates when the diff2 query itself fails', async () => {
    const p4: P4Cli = async (args) => {
      if (args.includes('info')) return { stdout: 'ws1\n', stderr: '' };
      if (args[0] === 'client' && args[1] === '-o')
        return { stdout: 'Client: ws1\nView:\n\t//depot/... //ws1/...\n', stderr: '' };
      if (args[0] === 'describe') return { stdout: 'Change 1 by noriq@ws1\n\n\tx\n', stderr: '' };
      if (args[0] === 'diff2') throw new Error('Connect to server failed; check $P4PORT.');
      throw new Error(`unexpected: ${args.join(' ')}`);
    };
    const res = await new PerforceBackend({ p4 }).changesBetween('/ws1', '1', '2');
    expect(res).toMatchObject({ ok: false, reason: 'full-index-required' });
  });

  it('escalates on an unparseable diff2 header rather than guessing', async () => {
    const { backend } = fakes({ diff2: 'this is not a diff2 header at all' });
    const res = await backend.changesBetween('/ws1', '1', '2');
    expect(res).toMatchObject({ ok: false, reason: 'full-index-required' });
  });

  it('escalates past the changed+deleted path cap rather than returning a huge list', async () => {
    const lines = Array.from(
      { length: 10_001 },
      (_, i) => `==== <none> - //depot/src/file${i}.ts#1 ====`,
    ).join('\n');
    const { backend } = fakes({ diff2: lines });
    const res = await backend.changesBetween('/ws1', '1', '2');
    expect(res).toMatchObject({ ok: false, reason: 'full-index-required' });
    if (res.ok) throw new Error('expected ok:false');
    expect(res.detail).toContain('10001');
  });

  it('escalates (never throws) when the depot prefix cannot be resolved', async () => {
    const p4: P4Cli = async (args) => {
      if (args.includes('info')) return { stdout: 'ws1\n', stderr: '' };
      if (args[0] === 'client' && args[1] === '-o')
        return { stdout: 'Client: ws1\nOptions: noallwrite\n', stderr: '' };
      throw new Error(`unexpected: ${args.join(' ')}`);
    };
    const res = await new PerforceBackend({ p4 }).changesBetween('/ws1', '1', '2');
    expect(res).toMatchObject({ ok: false, reason: 'full-index-required' });
  });
});

// RUN-256: `p4 ignores -i`, measured against a real p4d rig — see perforce.ts's own doc for what
// was found (purely local, no client/server needed; exit 0 regardless of match; output echoes
// ABSOLUTIZED paths suffixed ` ignored`, one line per match, nothing for a non-match).
describe('PerforceBackend — queryIgnored (RUN-256): p4 ignores -i, measured shape', () => {
  it('a mix of ignored and not-ignored paths: absolutized output relativized back, suffix stripped', async () => {
    const p4: P4Cli = async (args, cwd) => {
      expect(args[0]).toBe('ignores');
      expect(args[1]).toBe('-i');
      expect(args.slice(2)).toEqual(['node_modules', 'src/add.ts', 'debug.log']);
      expect(cwd).toBe('/ws1');
      return {
        stdout: `${cwd}/node_modules ignored\n${cwd}/debug.log ignored\n`,
        stderr: '',
      };
    };
    const res = await new PerforceBackend({ p4 }).queryIgnored('/ws1', [
      'node_modules',
      'src/add.ts',
      'debug.log',
    ]);
    expect(res).toEqual({ ok: true, ignored: new Set(['node_modules', 'debug.log']) });
  });

  it('nothing ignored: real answer, empty set (p4 exits 0 either way — never inferred from exit code)', async () => {
    const p4: P4Cli = async () => ({ stdout: '', stderr: '' });
    const res = await new PerforceBackend({ p4 }).queryIgnored('/ws1', ['src/add.ts']);
    expect(res).toEqual({ ok: true, ignored: new Set() });
  });

  it('an empty path list never shells out at all', async () => {
    const p4: P4Cli = async () => {
      throw new Error('p4 must never be invoked for an empty path list');
    };
    expect(await new PerforceBackend({ p4 }).queryIgnored('/ws1', [])).toEqual({
      ok: true,
      ignored: new Set(),
    });
  });

  it('a real p4 failure answers unknown, never throws (RUN-256 locked decision 3)', async () => {
    const p4: P4Cli = async () => {
      throw new Error('Connect to server failed; check $P4PORT.');
    };
    const res = await new PerforceBackend({ p4 }).queryIgnored('/ws1', ['a.ts']);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('unknown');
      expect(res.detail).toContain('Connect to server failed');
    }
  });
});

describe('PerforceDepotIndexSource (RUN-254): list/read/digest against the rig fixture', () => {
  const src = (over: { fstat?: string; p4Raw?: P4RawCli } = {}) => {
    const p4: P4Cli = async (args) => {
      if (args[0] === '-Ztag' && args.includes('fstat'))
        return { stdout: over.fstat ?? FSTAT_AT_2, stderr: '' };
      throw new Error(`unexpected p4 call: ${args.join(' ')}`);
    };
    return new PerforceDepotIndexSource({
      p4,
      p4Raw: over.p4Raw ?? throwingP4Raw,
      cwd: '/ws1',
      prefix: '//depot/...',
      change: '2',
    });
  };

  async function drain(source: PerforceDepotIndexSource) {
    const items: Array<{ kind: string; path: string; size?: number }> = [];
    for await (const item of source.list()) {
      items.push(
        item.kind === 'file'
          ? { kind: 'file', path: item.entry.path, size: item.entry.size }
          : { kind: 'refused', path: item.path },
      );
    }
    return items;
  }

  it('lists present files only, path-sorted, dropping delete/move-delete records', async () => {
    const items = await drain(src());
    expect(items.map((i) => i.path)).toEqual([
      'config/.env',
      'config/app.json',
      'docs/NEW.md',
      'docs/README.md',
      'src/add.ts',
      'src/after.ts',
      'src/blob.bin',
      'src/util/name.ts',
    ]);
    // docs/OLD.md (delete) and src/before.ts (move/delete) never appear — locked decision 4.
    expect(items.some((i) => i.path === 'docs/OLD.md' || i.path === 'src/before.ts')).toBe(false);
    expect(items.find((i) => i.path === 'src/add.ts')?.size).toBe(74);
  });

  it('surfaces a refusal (never throws) when the fstat call itself fails', async () => {
    const source = new PerforceDepotIndexSource({
      p4: async () => {
        throw new Error('Connect to server failed; check $P4PORT.');
      },
      p4Raw: throwingP4Raw,
      cwd: '/ws1',
      prefix: '//depot/...',
      change: '2',
    });
    const items = await drain(source);
    expect(items).toEqual([{ kind: 'refused', path: '.' }]);
  });

  it('reads a text file byte-for-byte', async () => {
    const calls: string[] = [];
    const p4Raw: P4RawCli = async (args) => {
      calls.push(args.join(' '));
      return {
        stdout: Buffer.from('export function add(a, b) {\n  return a + b;\n}\n'),
        stderr: Buffer.alloc(0),
        code: 0,
      };
    };
    const source = src({ p4Raw });
    const res = await source.read('src/add.ts', 1_000_000);
    expect(res).toEqual({
      ok: true,
      bytes: Buffer.from('export function add(a, b) {\n  return a + b;\n}\n'),
      overLimit: false,
    });
    expect(calls).toEqual(['print -q //depot/src/add.ts@2']);
  });

  it('reads a binary file byte-for-byte — the whole reason P4RawCli is Buffer-only, never string', async () => {
    // Bytes chosen to be INVALID UTF-8 (a lone continuation byte, then a truncated multi-byte
    // lead) — a string round trip through `Buffer += data` would replace these with U+FFFD and
    // re-encode to a DIFFERENT byte sequence. If this source used `P4Cli` for `print`, this
    // assertion would fail.
    const binary = Buffer.from([0x00, 0x80, 0xff, 0xfe, 0xc3, 0x28, 0x01, 0x02]);
    const p4Raw: P4RawCli = async () => ({ stdout: binary, stderr: Buffer.alloc(0), code: 0 });
    const res = await src({ p4Raw }).read('src/blob.bin', 1_000_000);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok:true');
    expect(Buffer.compare(res.bytes, binary)).toBe(0);
  });

  it('truncates at maxBytes and reports overLimit — the mechanical stop, never a source decision', async () => {
    const full = Buffer.from('0123456789');
    const p4Raw: P4RawCli = async () => ({ stdout: full, stderr: Buffer.alloc(0), code: 0 });
    const res = await src({ p4Raw }).read('src/add.ts', 4);
    expect(res).toEqual({ ok: true, bytes: Buffer.from('0123'), overLimit: true });
  });

  it('maps both measured "absent" stderr messages to not-found', async () => {
    for (const stderr of [
      '//depot/x.ts@2 - no such file(s).',
      '//depot/x.ts@1 - no file(s) at that changelist number.',
    ]) {
      const p4Raw: P4RawCli = async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.from(stderr), code: 0 });
      const res = await src({ p4Raw }).read('does/not/exist.ts', 1000);
      expect(res).toMatchObject({ ok: false, reason: 'not-found' });
    }
  });

  // Measured, documented limitation (see the module doc): a path deleted AT this exact revision
  // prints silently empty through `print -q` — no message on either stream. This pins that
  // exact, known trap rather than letting it drift unnoticed; the reason it is safe in practice
  // is that `list()`'s own headAction filter never hands such a path to `read()` in the first place.
  it('a path deleted at this revision reads as an empty (not refused) file — the documented trap', async () => {
    const p4Raw: P4RawCli = async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 });
    const res = await src({ p4Raw }).read('docs/OLD.md', 1000);
    expect(res).toEqual({ ok: true, bytes: Buffer.alloc(0), overLimit: false });
  });

  it('refuses a relPath trying to escape the depot prefix before ever building an argument', async () => {
    const calls: string[] = [];
    const p4Raw: P4RawCli = async (args) => {
      calls.push(args.join(' '));
      throw new Error('should never be called');
    };
    const source = src({ p4Raw });
    for (const bad of ['../secret.txt', '/etc/passwd', 'a/../../b.ts', 'a/./b.ts']) {
      const res = await source.read(bad, 1000);
      expect(res).toMatchObject({ ok: false, reason: 'outside-root' });
    }
    expect(calls).toEqual([]);
  });

  it('digest() serves list()`s cache without a second p4 call', async () => {
    const calls: string[] = [];
    const p4: P4Cli = async (args) => {
      calls.push(args.join(' '));
      if (args[0] === '-Ztag' && args.includes('fstat')) return { stdout: FSTAT_AT_2, stderr: '' };
      throw new Error(`unexpected: ${args.join(' ')}`);
    };
    const source = new PerforceDepotIndexSource({
      p4,
      p4Raw: throwingP4Raw,
      cwd: '/ws1',
      prefix: '//depot/...',
      change: '2',
    });
    await drain(source); // populates the cache
    calls.length = 0;
    expect(await source.digest('src/add.ts')).toBe('C24DE970FC860A6C2E3CAB19C7605A35');
    expect(calls).toEqual([]); // served from cache, no fresh fstat
  });

  it('digest() falls back to a fresh single-path fstat when not cached', async () => {
    const calls: string[] = [];
    const p4: P4Cli = async (args) => {
      calls.push(args.join(' '));
      return {
        stdout:
          '... depotFile //depot/src/util/name.ts\n... headAction add\n... headType text\n... fileSize 30\n... digest F2E1142E43EB5D1AB9538269B2BBBB1D\n',
        stderr: '',
      };
    };
    const source = new PerforceDepotIndexSource({
      p4,
      p4Raw: throwingP4Raw,
      cwd: '/ws1',
      prefix: '//depot/...',
      change: '2',
    });
    expect(await source.digest('src/util/name.ts')).toBe('F2E1142E43EB5D1AB9538269B2BBBB1D');
    expect(calls).toEqual(['-Ztag fstat -Ol //depot/src/util/name.ts@2']);
  });
});

// RUN-254 acceptance truth: "A hard-denied depot path (config/.env) yields a `denied` status and
// its content is never read — asserted on the depot source specifically." The deny list itself
// lives entirely in `index-scan.ts` (locked decision 8) — this proves the INTEGRATION, not a
// second copy of the rule.
describe('PerforceDepotIndexSource + index-scan.ts (RUN-254): the deny list still binds', () => {
  it('config/.env is denied and its bytes are never read, driven through the real scan pipeline', async () => {
    const readCalls: string[] = [];
    const p4: P4Cli = async (args) => {
      if (args[0] === '-Ztag' && args.includes('fstat')) return { stdout: FSTAT_AT_2, stderr: '' };
      throw new Error(`unexpected p4 call: ${args.join(' ')}`);
    };
    const p4Raw: P4RawCli = async (args) => {
      readCalls.push(args[args.length - 1] ?? '');
      return { stdout: Buffer.from('irrelevant'), stderr: Buffer.alloc(0), code: 0 };
    };
    const source = new PerforceDepotIndexSource({
      p4,
      p4Raw,
      cwd: '/ws1',
      prefix: '//depot/...',
      change: '2',
    });
    const result = await scanIndexSource(source, indexCfg());
    const denied = result.statuses.find((s) => s.path === 'config/.env');
    expect(denied?.reason).toBe('denied');
    expect(readCalls.some((spec) => spec.includes('.env'))).toBe(false);
    expect(result.candidates.some((c) => c.path === 'config/.env')).toBe(false);
  });

  it('the content hash for a depot-sourced file matches a filesystem source hashing the same bytes', async () => {
    const content = 'export function add(a, b) {\n  return a + b;\n}\n';
    const p4: P4Cli = async (args) => {
      if (args[0] === '-Ztag' && args.includes('fstat'))
        return {
          stdout:
            '... depotFile //depot/src/add.ts\n... headAction edit\n... headType text\n... fileSize 47\n',
          stderr: '',
        };
      throw new Error(`unexpected: ${args.join(' ')}`);
    };
    const p4Raw: P4RawCli = async () => ({ stdout: Buffer.from(content), stderr: Buffer.alloc(0), code: 0 });
    const source = new PerforceDepotIndexSource({
      p4,
      p4Raw,
      cwd: '/ws1',
      prefix: '//depot/...',
      change: '2',
    });
    const result = await scanIndexSource(source, indexCfg());
    const candidate = result.candidates.find((c) => c.path === 'src/add.ts');
    expect(candidate?.contentMode).toBe('full');
    expect(candidate?.content).toBe(content);
    // The scanner's own SHA-256, not Perforce's MD5 `digest` — asserted against a fresh source
    // instance built over an in-memory fixture with the SAME bytes.
    const fsEquivalent = await scanIndexSource(
      new FakeIndexSource([{ kind: 'file', path: 'src/add.ts', content }]),
      indexCfg(),
    );
    expect(candidate?.contentHash).toBe(
      fsEquivalent.candidates.find((c) => c.path === 'src/add.ts')?.contentHash,
    );
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
