import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INDEX_LANGUAGES, type ResolvedIndexConfig } from '../src/index-policy';
import { scanIndexSource } from '../src/index-scan';
import type { P4Cli } from '../src/vcs/perforce';
import { PerforceBackend } from '../src/vcs/perforce';
import { type P4RawCli, PerforceDepotIndexSource } from '../src/vcs/perforce-index-source';

/**
 * The opt-in half of RUN-254's acceptance ("with the rig up, the opt-in live suite passes and
 * confirms the fixtures still match p4d's real output") — never wired into `npm run check`, CI,
 * or the build (the p4d-rig's own lockedDecisions #3, restated here): CI has no depot, and a test
 * suite that needs a container is a suite people learn to skip. This file SKIPS CLEANLY the
 * moment the rig is unreachable rather than failing the run — the same posture
 * `scripts/p4d-rig/README.md` documents for `measure.sh`.
 *
 * Deliberately READ-ONLY against the rig's sample depot (`scripts/p4d-rig/provision.sh`'s change
 * 1/2): this file never calls `lease()`/`checkpoint()`/`publish()` — those would submit into (or
 * leave a stray pending changelist against) the shared fixture tree every other RUN-254 fact in
 * this codebase, and `test/vcs-perforce.test.ts`'s own live-p4d session (measured 2026-08-09), was
 * measured against, so mutating it would make this repo's own comments stop matching the server.
 * `test/vcs-perforce.test.ts`'s fixture-driven unit suite is the one that exercises
 * lease/dispose/checkpoint against fakes; this file only re-proves that the FIXTURES those tests
 * pin (`FSTAT_AT_2`, `DIFF2_1_TO_2`) still match what the real server says today.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RIG_DIR = path.resolve(__dirname, '../scripts/p4d-rig');
const P4_BIN = path.join(RIG_DIR, '.bin', 'p4');
const P4_PORT = 'localhost:1666';
const P4_USER = 'noriq';
const P4_CLIENT = 'noriq-sample'; // provisioned by scripts/p4d-rig/provision.sh

function rigIsUp(): boolean {
  if (!existsSync(P4_BIN)) return false;
  try {
    execFileSync(P4_BIN, ['info'], {
      env: { ...process.env, P4PORT: P4_PORT, P4USER: P4_USER },
      timeout: 3_000,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

// Evaluated once, at collection time (top-level, synchronous) — `describe.skipIf` needs a
// boolean, not a promise, and a rig that is down must skip the whole suite rather than fail one
// test at a time with a connection error.
const UP = rigIsUp();
if (!UP) {
  console.warn(
    `vcs-perforce-live.test.ts: p4d rig not reachable at ${P4_PORT} (run scripts/p4d-rig/up.sh && scripts/p4d-rig/provision.sh) — skipping the live RUN-254 suite.`,
  );
}

/** Real `p4`, string-based — `perforce.ts`'s `realP4Cli` shape, but pinned at the rig's
 *  port/user/client EXPLICITLY via env rather than through `P4CONFIG` discovery: this file mints
 *  no client workspace of its own, so there is no directory to hang a `P4CONFIG` file off of. */
const liveP4: P4Cli = (args, cwd, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn(P4_BIN, args, {
      cwd,
      env: { ...process.env, PWD: cwd, P4PORT: P4_PORT, P4USER: P4_USER, P4CLIENT: P4_CLIENT },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`p4 ${args[0]} exited ${code}: ${stdout}${stderr}`));
    });
    child.stdin.end(stdin ?? '');
  });

/** Real `p4`, Buffer-safe — see `perforce-index-source.ts`'s module doc for why `print` needs
 *  this rather than `liveP4`. */
const liveP4Raw: P4RawCli = (args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(P4_BIN, args, {
      cwd,
      env: { ...process.env, PWD: cwd, P4PORT: P4_PORT, P4USER: P4_USER, P4CLIENT: P4_CLIENT },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => stdout.push(d));
    child.stderr.on('data', (d: Buffer) => stderr.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: code ?? -1 });
    });
  });

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

// `cwd` for every call below — P4PORT/P4USER/P4CLIENT are pinned directly in env (see `liveP4`
// above), so this only has to be SOME real directory; it is never synced or written to.
const CWD = RIG_DIR;

describe.skipIf(!UP)('PerforceBackend — leaseIndexSnapshot (RUN-254 live)', () => {
  it('mints a real snapshot at the depot head, materializing nothing', async () => {
    const backend = new PerforceBackend({ p4: liveP4, p4Raw: liveP4Raw });
    const res = await backend.leaseIndexSnapshot(CWD);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(`expected ok:true, got ${JSON.stringify(res)}`);
    expect(res.snapshot.localPath).toBeUndefined();
    expect(res.snapshot.branch).toBeUndefined();
    expect(res.snapshot.source.kind).toBe('perforce-depot');
    // The depot head is >= 2: provision.sh submits exactly two changelists, and a rig reused
    // across sessions may have accumulated more from repeated measurement runs.
    expect(Number(res.snapshot.baseId)).toBeGreaterThanOrEqual(2);
    await backend.releaseIndexSnapshot(res.snapshot);
  });

  it('touches no client and no sync while minting a snapshot', async () => {
    const calls: string[] = [];
    const recordingP4: P4Cli = (args, cwd, stdin) => {
      calls.push(args.join(' '));
      return liveP4(args, cwd, stdin);
    };
    const backend = new PerforceBackend({ p4: recordingP4, p4Raw: liveP4Raw });
    const res = await backend.leaseIndexSnapshot(CWD);
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.startsWith('client -i'))).toBe(false);
    expect(calls.some((c) => c.startsWith('sync'))).toBe(false);
    expect(calls.some((c) => c.startsWith('change -i'))).toBe(false);
  });
});

describe.skipIf(!UP)('PerforceDepotIndexSource — live rig fixture (RUN-254)', () => {
  const sourceAt = (change: string) =>
    new PerforceDepotIndexSource({ p4: liveP4, p4Raw: liveP4Raw, cwd: CWD, prefix: '//depot/...', change });

  async function drain(source: PerforceDepotIndexSource) {
    const paths: string[] = [];
    const sizes = new Map<string, number | undefined>();
    for await (const item of source.list()) {
      if (item.kind !== 'file') throw new Error(`unexpected refusal: ${JSON.stringify(item)}`);
      paths.push(item.entry.path);
      sizes.set(item.entry.path, item.entry.size);
    }
    return { paths, sizes };
  }

  it('lists exactly the sample tree`s present paths at change 2 — confirms the unit fixture still matches', async () => {
    const { paths, sizes } = await drain(sourceAt('2'));
    // The two deletions (docs/OLD.md, src/before.ts) must be absent — this is the fact the whole
    // headAction filter exists for.
    expect(paths).toEqual([
      'config/.env',
      'config/app.json',
      'docs/NEW.md',
      'docs/README.md',
      'src/add.ts',
      'src/after.ts',
      'src/blob.bin',
      'src/util/name.ts',
    ]);
    expect(sizes.get('src/add.ts')).toBe(74); // "// modified" edit, measured
    expect(sizes.get('src/blob.bin')).toBe(4096);
  });

  it('reads src/add.ts@2 byte-for-byte — the exact measured "// modified" edit', async () => {
    const res = await sourceAt('2').read('src/add.ts', 1_000_000);
    expect(res).toEqual({
      ok: true,
      bytes: Buffer.from('export function add(a: number, b: number) {\n  return a + b; // modified\n}\n'),
      overLimit: false,
    });
  });

  it('reads the binary fixture byte-for-byte, exactly 4096 bytes — the Buffer-safety claim, end to end', async () => {
    const res = await sourceAt('1').read('src/blob.bin', 1_000_000);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok:true');
    expect(res.bytes.length).toBe(4096);
  });

  it('a deleted-at-this-revision path reads back empty, not refused — the documented silent trap', async () => {
    const res = await sourceAt('2').read('docs/OLD.md', 1_000);
    expect(res).toEqual({ ok: true, bytes: Buffer.alloc(0), overLimit: false });
  });

  it('digest() answers Perforce`s real MD5, never `headDigest`s silent empty (RUN-254 locked decision 2)', async () => {
    const digest = await sourceAt('2').digest('src/add.ts');
    expect(digest).toBe('C24DE970FC860A6C2E3CAB19C7605A35');
  });
});

describe.skipIf(!UP)('PerforceBackend — changesBetween (RUN-254 live): confirms the diff2 fixture', () => {
  const backend = new PerforceBackend({ p4: liveP4, p4Raw: liveP4Raw });

  it('decomposes the real add/delete/modify/move between change 1 and 2', async () => {
    const res = await backend.changesBetween(CWD, '1', '2');
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(`expected ok:true, got ${JSON.stringify(res)}`);
    expect(new Set(res.changed)).toEqual(new Set(['docs/NEW.md', 'src/add.ts', 'src/after.ts']));
    expect(new Set(res.deleted)).toEqual(new Set(['docs/OLD.md', 'src/before.ts']));
  });

  it('reports two identical bases as a real empty diff', async () => {
    expect(await backend.changesBetween(CWD, '1', '1')).toEqual({ ok: true, changed: [], deleted: [] });
  });

  it('escalates on a changelist number that has never been submitted', async () => {
    const res = await backend.changesBetween(CWD, '1', '999999');
    expect(res).toMatchObject({ ok: false, reason: 'full-index-required' });
  });
});

describe.skipIf(!UP)('PerforceDepotIndexSource + index-scan.ts — live rig (RUN-254)', () => {
  it('config/.env is denied by the real scan pipeline and its bytes are never read', async () => {
    const reads: string[] = [];
    const recordingP4Raw: P4RawCli = (args, cwd) => {
      reads.push(args[args.length - 1] ?? '');
      return liveP4Raw(args, cwd);
    };
    const source = new PerforceDepotIndexSource({
      p4: liveP4,
      p4Raw: recordingP4Raw,
      cwd: CWD,
      prefix: '//depot/...',
      change: '2',
    });
    const result = await scanIndexSource(source, indexCfg());
    expect(result.statuses.find((s) => s.path === 'config/.env')?.reason).toBe('denied');
    expect(reads.some((spec) => spec.includes('.env'))).toBe(false);
    expect(result.candidates.some((c) => c.path === 'config/.env')).toBe(false);
  });
});
