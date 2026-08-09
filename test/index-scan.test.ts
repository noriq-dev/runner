import { execFile as execFileCb } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedIndexConfig } from '../src/index-policy';
import { INDEX_LANGUAGES } from '../src/index-policy';
import { type IndexScanResult, MAX_STATUS_RECORDS, scanRepoForIndex } from '../src/index-scan';
import * as repoContext from '../src/repo-context';

const execFile = promisify(execFileCb);

/** A fully-populated `ResolvedIndexConfig`, generous bounds by default so a test that cares about
 *  one specific bound can override just that field without re-stating every other one. */
const cfg = (over: Partial<ResolvedIndexConfig> = {}): ResolvedIndexConfig => ({
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

let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'noriq-scan-'));
  outside = await mkdtemp(path.join(tmpdir(), 'noriq-scan-out-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const byPath = (r: IndexScanResult, p: string) => r.candidates.find((c) => c.path === p);
const statusFor = (r: IndexScanResult, p: string) => r.statuses.find((s) => s.path === p);

describe('scanRepoForIndex — ordinary files', () => {
  it('reads matching files and reports identity, content, and a stable hash', async () => {
    await writeFile(path.join(root, 'a.ts'), 'export const x = 1;\n');
    const r = await scanRepoForIndex(root, cfg());
    const c = byPath(r, 'a.ts');
    expect(c?.content).toBe('export const x = 1;\n');
    expect(c?.contentMode).toBe('full');
    expect(c?.bytes).toBe(Buffer.byteLength('export const x = 1;\n'));
    // sha256('export const x = 1;\n')
    expect(c?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const again = await scanRepoForIndex(root, cfg());
    expect(byPath(again, 'a.ts')?.contentHash).toBe(c?.contentHash); // stable across runs
  });

  it('walks nested directories, reporting POSIX-separated repo-relative paths', async () => {
    await mkdir(path.join(root, 'src', 'lib'), { recursive: true });
    await writeFile(path.join(root, 'src', 'lib', 'util.ts'), 'export {};');
    const r = await scanRepoForIndex(root, cfg());
    expect(byPath(r, 'src/lib/util.ts')).toBeDefined();
  });

  it('returns nothing and opens nothing when [index] is off (config is null)', async () => {
    await writeFile(path.join(root, 'a.ts'), 'x');
    // `node:fs/promises` is a built-in module whose exports vitest cannot spy on directly (its
    // namespace is non-configurable in ESM), so the proof here is behavioural: `openConfined` —
    // the ONLY thing in this module that ever reads a byte — is never called, and the result is
    // the same empty, zeroed shape a caller gets for a repo indexing was never turned on for.
    const spy = vi.spyOn(repoContext, 'openConfined');
    const r = await scanRepoForIndex(root, null);
    expect(r).toEqual({
      candidates: [],
      statuses: [],
      statusOverflow: 0,
      filesOpened: 0,
      totalBytesRead: 0,
      stoppedEarly: false,
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// RUN-209 follow-up (closing the RUN-210 finding): `contentMode` is honoured at the scan
// boundary rather than parsed-but-ignored.
describe('scanRepoForIndex — contentMode', () => {
  it('withholds raw content in metadata mode where full mode returns it, for the same file', async () => {
    await writeFile(path.join(root, 'a.ts'), 'export const x = 1;\n');
    const full = await scanRepoForIndex(root, cfg({ contentMode: 'full' }));
    const metadata = await scanRepoForIndex(root, cfg({ contentMode: 'metadata' }));
    expect(byPath(full, 'a.ts')?.content).toBe('export const x = 1;\n');
    expect(byPath(full, 'a.ts')?.contentMode).toBe('full');
    expect(byPath(metadata, 'a.ts')?.content).toBeNull();
    expect(byPath(metadata, 'a.ts')?.contentMode).toBe('metadata');
    // Never merely absent from the object — actually the string, never present anywhere in the
    // serialized result, the same "prove the byte isn't there" standard the symlink tests use.
    expect(JSON.stringify(metadata)).not.toContain('export const x = 1');
  });

  it('still produces an identical hash and size in metadata mode as in full mode', async () => {
    await writeFile(path.join(root, 'a.ts'), 'export const x = 1;\n');
    const full = await scanRepoForIndex(root, cfg({ contentMode: 'full' }));
    const metadata = await scanRepoForIndex(root, cfg({ contentMode: 'metadata' }));
    const fc = byPath(full, 'a.ts');
    const mc = byPath(metadata, 'a.ts');
    expect(mc?.contentHash).toBe(fc?.contentHash);
    expect(mc?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(mc?.bytes).toBe(fc?.bytes);
  });

  it('still opens and confines reads in metadata mode — binary detection and deny/bounds unchanged', async () => {
    // Binary detection: a NUL byte is still refused as `binary`, never silently admitted because
    // no content was going to be kept anyway.
    await writeFile(path.join(root, 'blob.ts'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
    // Deny list: still non-overridable, even though nothing would leak into `content`.
    await writeFile(path.join(root, '.env'), 'SECRET=1');
    // Per-file bound: still enforced.
    await writeFile(path.join(root, 'big.ts'), 'x'.repeat(1000));
    const spy = vi.spyOn(repoContext, 'openConfined');
    const r = await scanRepoForIndex(root, cfg({ contentMode: 'metadata', maxFileBytes: 10 }));
    expect(statusFor(r, 'blob.ts')?.reason).toBe('binary');
    expect(statusFor(r, '.env')?.reason).toBe('denied');
    expect(statusFor(r, 'big.ts')?.reason).toBe('too-large');
    expect(spy).toHaveBeenCalledWith(path.join(root, 'blob.ts'), root);
    spy.mockRestore();
  });

  it('leaves full mode byte-identical to today (default cfg() is full)', async () => {
    await writeFile(path.join(root, 'a.ts'), 'export const x = 1;\n');
    const r = await scanRepoForIndex(root, cfg());
    const c = byPath(r, 'a.ts');
    expect(c?.contentMode).toBe('full');
    expect(c?.content).toBe('export const x = 1;\n');
  });
});

describe('scanRepoForIndex — every read goes through openConfined', () => {
  it('routes every admitted candidate through the shared confined opener, never a bare readFile', async () => {
    await writeFile(path.join(root, 'a.ts'), 'a');
    await writeFile(path.join(root, 'b.ts'), 'b');
    const spy = vi.spyOn(repoContext, 'openConfined');
    const r = await scanRepoForIndex(root, cfg());
    expect(r.candidates.map((c) => c.path).sort()).toEqual(['a.ts', 'b.ts']);
    expect(spy).toHaveBeenCalledWith(path.join(root, 'a.ts'), root);
    expect(spy).toHaveBeenCalledWith(path.join(root, 'b.ts'), root);
    spy.mockRestore();
  });
});

// The adversarial core: every path a committed [index].include/.exclude could point at, refused.
describe('scanRepoForIndex — symlinks, traversal, and the deny list', () => {
  it('refuses an in-repo symlink whose target resolves outside the root, and never reads it', async () => {
    await writeFile(path.join(outside, 'secret.txt'), 'TOP SECRET');
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'leak.ts'));
    const r = await scanRepoForIndex(root, cfg());
    expect(byPath(r, 'leak.ts')).toBeUndefined();
    expect(statusFor(r, 'leak.ts')).toEqual({
      path: 'leak.ts',
      reason: 'outside-root',
      detail: expect.stringContaining('outside the repo'),
    });
    expect(JSON.stringify(r)).not.toContain('TOP SECRET');
  });

  // The parent-directory case, not merely the leaf: a directory symlink is never followed during
  // enumeration at all (locked decision 8), so a file reached only through one is never even
  // discovered as a candidate — its bytes are refused by construction, not merely by policy.
  it('refuses a file reached through a parent directory that is a symlink out of the root', async () => {
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'secret.txt'), 'TOP SECRET');
    await symlink(outside, path.join(root, 'outdir'));
    // An include glob that would match the file if the walk ever reached it — proving the walk
    // never reaches it, not merely that this one glob failed to ask for it.
    const r = await scanRepoForIndex(root, cfg({ include: ['**/*'] }));
    expect(byPath(r, 'outdir/secret.txt')).toBeUndefined();
    expect(r.candidates.some((c) => c.content?.includes('TOP SECRET'))).toBe(false);
    expect(JSON.stringify(r)).not.toContain('TOP SECRET');
  });

  it('follows an in-repo symlink to an in-repo file — that is ordinary repo layout', async () => {
    await writeFile(path.join(root, 'real.ts'), 'export const real = 1;');
    await symlink(path.join(root, 'real.ts'), path.join(root, 'alias.ts'));
    const r = await scanRepoForIndex(root, cfg());
    expect(byPath(r, 'alias.ts')?.content).toBe('export const real = 1;');
  });

  // The swap-race proof: rather than re-deriving `openConfined`'s own race-timing test (that
  // property is `repo-context.test.ts`'s job, proven there against the real fd/inode identity
  // check), this proves the property that actually matters HERE — every read this module performs
  // is routed through that exact function, never a second, weaker confinement check of its own.
  it('cannot bypass the swap-race guard: the reader has no read path except openConfined', async () => {
    const spy = vi.spyOn(repoContext, 'openConfined');
    await writeFile(path.join(root, 'x.ts'), 'x');
    await scanRepoForIndex(root, cfg());
    expect(spy).toHaveBeenCalled();
    // Simulate the guard actually catching a swapped file, and confirm the scanner reports it as
    // a bounded refusal rather than propagating a raw throw or crashing the walk.
    spy.mockRejectedValueOnce(new Error('path changed while opening it: /whatever'));
    const r = await scanRepoForIndex(root, cfg());
    expect(statusFor(r, 'x.ts')?.reason).toBe('outside-root');
    spy.mockRestore();
  });

  it('an absolute-path include glob matches nothing outside the root', async () => {
    await writeFile(path.join(root, 'a.ts'), 'a');
    const r = await scanRepoForIndex(root, cfg({ include: ['/etc/passwd'] }));
    expect(r.candidates).toEqual([]);
    expect(statusFor(r, 'a.ts')?.reason).toBe('not-included');
  });

  it('a traversal include glob ("..") matches nothing outside the root', async () => {
    await writeFile(path.join(root, 'a.ts'), 'a');
    const r = await scanRepoForIndex(root, cfg({ include: ['../../etc/**'] }));
    expect(r.candidates).toEqual([]);
    expect(statusFor(r, 'a.ts')?.reason).toBe('not-included');
  });

  it('a manifest cannot re-include a hard-denied path with a wide include glob', async () => {
    await writeFile(path.join(root, '.env'), 'SECRET=1');
    await writeFile(path.join(root, 'ok.ts'), 'export {};');
    const r = await scanRepoForIndex(root, cfg({ include: ['**/.env*'] }));
    expect(byPath(r, '.env')).toBeUndefined();
    expect(statusFor(r, '.env')).toEqual({
      path: '.env',
      reason: 'denied',
      detail: expect.any(String),
    });
    // The include glob narrowed everything else out — ok.ts never matched it — proving the deny
    // status is not merely "excluded by a narrow include" wearing the wrong label.
    expect(statusFor(r, 'ok.ts')?.reason).toBe('not-included');
  });

  it('a manifest cannot re-include a hard-denied path even with "**/*"', async () => {
    await writeFile(path.join(root, '.env'), 'SECRET=1');
    const r = await scanRepoForIndex(root, cfg({ include: ['**/*'] }));
    expect(byPath(r, '.env')).toBeUndefined();
    expect(statusFor(r, '.env')?.reason).toBe('denied');
  });

  it('prunes a whole denied directory in one status record, not one per file inside it', async () => {
    await mkdir(path.join(root, '.git', 'objects'), { recursive: true });
    await writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main');
    await writeFile(path.join(root, '.git', 'objects', 'pack'), 'binary-ish');
    const r = await scanRepoForIndex(root, cfg());
    expect(r.statuses.filter((s) => s.path.startsWith('.git'))).toEqual([
      { path: '.git', reason: 'denied', detail: expect.any(String) },
    ]);
  });
});

describe('scanRepoForIndex — not-a-file and unreadable', () => {
  it.skipIf(process.platform === 'win32')(
    'refuses a committed FIFO as not-a-file and keeps scanning the rest',
    async () => {
      const fifo = path.join(root, 'pipe.ts');
      try {
        await execFile('mkfifo', [fifo]);
      } catch {
        return; // no mkfifo on this box — nothing to assert
      }
      await writeFile(path.join(root, 'ok.ts'), 'export {};');
      const r = await scanRepoForIndex(root, cfg());
      expect(statusFor(r, 'pipe.ts')?.reason).toBe('not-a-file');
      expect(byPath(r, 'ok.ts')).toBeDefined();
    },
  );

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'reports an EACCES file as unreadable and keeps scanning the rest',
    async () => {
      const denied = path.join(root, 'locked.ts');
      await writeFile(denied, 'export {};');
      await chmod(denied, 0o000);
      await writeFile(path.join(root, 'ok.ts'), 'export {};');
      try {
        const r = await scanRepoForIndex(root, cfg());
        expect(statusFor(r, 'locked.ts')?.reason).toBe('unreadable');
        expect(byPath(r, 'ok.ts')).toBeDefined();
      } finally {
        await chmod(denied, 0o644).catch(() => {});
      }
    },
  );

  it('reports an unreadable directory without failing the whole scan', async () => {
    await mkdir(path.join(root, 'locked-dir'));
    await writeFile(path.join(root, 'ok.ts'), 'export {};');
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root ignores perms
    await chmod(path.join(root, 'locked-dir'), 0o000);
    try {
      const r = await scanRepoForIndex(root, cfg());
      expect(statusFor(r, 'locked-dir')?.reason).toBe('unreadable');
      expect(byPath(r, 'ok.ts')).toBeDefined();
    } finally {
      await chmod(path.join(root, 'locked-dir'), 0o755).catch(() => {});
    }
  });
});

describe('scanRepoForIndex — binary detection is content-based', () => {
  it('reports a binary file by its bytes, not its extension', async () => {
    // A NUL byte, wearing a source-code extension.
    await writeFile(path.join(root, 'blob.ts'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
    const r = await scanRepoForIndex(root, cfg());
    expect(byPath(r, 'blob.ts')).toBeUndefined();
    expect(statusFor(r, 'blob.ts')?.reason).toBe('binary');
  });

  it('does not misreport a legitimate multi-byte-UTF-8 text file as binary', async () => {
    await writeFile(path.join(root, 'unicode.md'), '# 日本語のドキュメント — em dash — 🔒'.repeat(50));
    const r = await scanRepoForIndex(root, cfg());
    expect(statusFor(r, 'unicode.md')).toBeUndefined();
    expect(byPath(r, 'unicode.md')).toBeDefined();
  });
});

describe('scanRepoForIndex — bounds', () => {
  it('refuses a file over the per-file byte bound with no content', async () => {
    await writeFile(path.join(root, 'big.ts'), 'x'.repeat(1000));
    const r = await scanRepoForIndex(root, cfg({ maxFileBytes: 10 }));
    expect(byPath(r, 'big.ts')).toBeUndefined();
    expect(statusFor(r, 'big.ts')).toEqual({
      path: 'big.ts',
      reason: 'too-large',
      detail: expect.any(String),
    });
  });

  it('stops the walk at maxFiles and reports budget-exhausted, marking the result partial', async () => {
    await writeFile(path.join(root, 'a.ts'), 'a');
    await writeFile(path.join(root, 'b.ts'), 'b');
    const r = await scanRepoForIndex(root, cfg({ maxFiles: 1 }));
    expect(r.candidates).toHaveLength(1);
    expect(r.stoppedEarly).toBe(true);
    expect(r.statuses.some((s) => s.reason === 'budget-exhausted')).toBe(true);
  });

  it('stops the walk at maxTotalBytes and reports budget-exhausted', async () => {
    await writeFile(path.join(root, 'a.ts'), 'x'.repeat(50));
    await writeFile(path.join(root, 'b.ts'), 'x'.repeat(50));
    const r = await scanRepoForIndex(root, cfg({ maxFileBytes: 1000, maxTotalBytes: 50 }));
    expect(r.candidates).toHaveLength(1);
    expect(r.stoppedEarly).toBe(true);
    expect(r.statuses.some((s) => s.reason === 'budget-exhausted')).toBe(true);
  });

  it('stops the walk once the deadline passes and reports deadline-exceeded', async () => {
    await writeFile(path.join(root, 'a.ts'), 'a');
    await writeFile(path.join(root, 'b.ts'), 'b');
    let calls = 0;
    // First call is the start timestamp; every call after reports well past the deadline.
    const now = () => (calls++ === 0 ? 0 : 1_000_000);
    const r = await scanRepoForIndex(root, cfg({ readDeadlineMs: 10 }), { now });
    expect(r.stoppedEarly).toBe(true);
    expect(r.statuses.some((s) => s.reason === 'deadline-exceeded')).toBe(true);
  });
});

describe('scanRepoForIndex — status records are themselves bounded', () => {
  it('caps retained status records and carries an overflow count for the rest', async () => {
    const total = MAX_STATUS_RECORDS + 25;
    await Promise.all(
      Array.from({ length: total }, (_, i) => writeFile(path.join(root, `secrets${i}.json`), '{}')),
    );
    const r = await scanRepoForIndex(root, cfg());
    expect(r.statuses).toHaveLength(MAX_STATUS_RECORDS);
    expect(r.statusOverflow).toBe(total - MAX_STATUS_RECORDS);
    expect(r.statuses.every((s) => s.reason === 'denied')).toBe(true);
  });
});

describe('scanRepoForIndex — include/exclude', () => {
  it('excludes what the glob names, and reports why', async () => {
    await writeFile(path.join(root, 'a.ts'), 'a');
    await writeFile(path.join(root, 'a.test.ts'), 'a-test');
    const r = await scanRepoForIndex(root, cfg({ exclude: ['**/*.test.ts'] }));
    expect(byPath(r, 'a.ts')).toBeDefined();
    expect(byPath(r, 'a.test.ts')).toBeUndefined();
    expect(statusFor(r, 'a.test.ts')?.reason).toBe('excluded');
  });

  it('admits only what an include glob matches, marking the rest not-included', async () => {
    await writeFile(path.join(root, 'a.ts'), 'a');
    await writeFile(path.join(root, 'b.md'), 'b');
    const r = await scanRepoForIndex(root, cfg({ include: ['**/*.ts'] }));
    expect(byPath(r, 'a.ts')).toBeDefined();
    expect(byPath(r, 'b.md')).toBeUndefined();
    expect(statusFor(r, 'b.md')?.reason).toBe('not-included');
  });
});

/**
 * The ordering contract `index-scan.ts` refuses on, exercised against the shape that actually
 * broke it (RUN-219). `walkFs` sorted sibling NAMES and recursed inline, which is deterministic but
 * is not ascending full-path order: a directory contributes a `/` exactly where a sibling
 * contributes its own next character, and both `-` (0x2D) and `.` (0x2E) sort below `/` (0x2F).
 * Every fixture-sized tree in this suite happened to avoid the collision, so the violation survived
 * until a real repository was walked — any `node_modules` holding a `pkg` beside a `pkg-linux-x64`,
 * or any `foo/` beside a `foo.ts`, trips it.
 */
describe('FilesystemIndexSource honours ascending full-path order, not merely name order', () => {
  it('interleaves a directory with siblings whose names extend it below the separator', async () => {
    await mkdir(path.join(root, 'a'));
    await mkdir(path.join(root, 'a-b'));
    await writeFile(path.join(root, 'a', 'x.ts'), 'export const x = 1;\n');
    await writeFile(path.join(root, 'a-b', 'y.ts'), 'export const y = 1;\n');
    await writeFile(path.join(root, 'a.ts'), 'export const z = 1;\n');

    // Reaching a result at all is most of the assertion: `scanIndexSource` REFUSES loudly on an
    // out-of-order source rather than repairing it, so a regression here throws rather than
    // returning something subtly wrong.
    const r = await scanRepoForIndex(root, cfg());
    const paths = r.candidates.map((c) => c.path);
    expect(paths).toEqual(['a-b/y.ts', 'a.ts', 'a/x.ts']);
    expect(paths).toEqual([...paths].sort());
  });

  it('orders a directory before a sibling file only when the separator says so', async () => {
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    await writeFile(path.join(root, 'srcz.ts'), 'export const b = 1;\n');

    // `/` (0x2F) sorts below `z` (0x7A), so here the directory really does come first — the fix is
    // a separator-aware key, not a blanket "files before directories" rule.
    const r = await scanRepoForIndex(root, cfg());
    expect(r.candidates.map((c) => c.path)).toEqual(['src/a.ts', 'srcz.ts']);
  });
});
