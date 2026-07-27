import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProjectContext } from '@noriq-dev/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type DocReader,
  type PathProbe,
  defaultDocReader,
  defaultPathProbe,
  discoverAgentInstructions,
  loadRepoContext,
  loadRepoDocs,
  renderRepoContext,
  resolveRepoContext,
} from '../src/repo-context';

const ctx = (over: Partial<ProjectContext> = {}): ProjectContext => ({
  requiredReading: [],
  entryPoints: [],
  conventions: [],
  ...over,
});

/** Everything declared exists — isolates path POLICY from the filesystem. */
const allExist: PathProbe = async () => true;

describe('resolveRepoContext', () => {
  it('keeps declared paths that resolve inside the repo, repo-relative', async () => {
    const r = await resolveRepoContext(
      '/repo',
      ctx({ requiredReading: ['docs/ARCHITECTURE.md'], entryPoints: ['src/daemon.ts'] }),
      allExist,
    );
    expect(r.requiredReading).toEqual(['docs/ARCHITECTURE.md']);
    expect(r.entryPoints).toEqual(['src/daemon.ts']);
    expect(r.unresolved).toEqual([]);
  });

  it('preserves manifest order — the list encodes priority', async () => {
    const r = await resolveRepoContext('/repo', ctx({ requiredReading: ['z.md', 'a.md', 'm.md'] }), allExist);
    expect(r.requiredReading).toEqual(['z.md', 'a.md', 'm.md']);
  });

  // The boundary: .noriq/project.toml is COMMITTED, so a path in it is untrusted input that the
  // daemon would otherwise read on the operator's box.
  it('refuses a path escaping the repo root, and says why', async () => {
    const r = await resolveRepoContext('/repo', ctx({ requiredReading: ['../../.ssh/id_rsa'] }), allExist);
    expect(r.requiredReading).toEqual([]);
    expect(r.unresolved).toEqual([{ declared: '../../.ssh/id_rsa', reason: 'outside-repo' }]);
  });

  it('refuses an absolute path outside the repo', async () => {
    const r = await resolveRepoContext('/repo', ctx({ entryPoints: ['/etc/passwd'] }), allExist);
    expect(r.entryPoints).toEqual([]);
    expect(r.unresolved[0]).toEqual({ declared: '/etc/passwd', reason: 'outside-repo' });
  });

  it('refuses a path that normalizes back out of the repo', async () => {
    const r = await resolveRepoContext('/repo', ctx({ entryPoints: ['src/../../elsewhere'] }), allExist);
    expect(r.unresolved[0]?.reason).toBe('outside-repo');
  });

  it('reports a missing path rather than dropping it silently', async () => {
    const probe: PathProbe = async (abs) => !abs.endsWith('gone.md');
    const r = await resolveRepoContext('/repo', ctx({ requiredReading: ['here.md', 'gone.md'] }), probe);
    expect(r.requiredReading).toEqual(['here.md']);
    expect(r.unresolved).toEqual([{ declared: 'gone.md', reason: 'missing' }]);
  });

  it('passes conventions through and drops blank ones', async () => {
    const r = await resolveRepoContext(
      '/repo',
      ctx({ conventions: ['ESM only', '   ', 'no barrel files'] }),
      allExist,
    );
    expect(r.conventions).toEqual(['ESM only', 'no barrel files']);
  });

  it('a manifest without [context] resolves to nothing and never throws', async () => {
    for (const empty of [null, undefined]) {
      const r = await resolveRepoContext('/repo', empty, allExist);
      expect(r).toEqual({
        requiredReading: [],
        entryPoints: [],
        conventions: [],
        unresolved: [],
      });
    }
  });
});

describe('defaultPathProbe', () => {
  let root: string;
  let outside: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'noriq-ctx-'));
    outside = await mkdtemp(path.join(tmpdir(), 'noriq-out-'));
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await writeFile(path.join(root, 'docs', 'ARCH.md'), '# arch');
    await writeFile(path.join(outside, 'secret'), 'shh');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('accepts a real file inside the repo', async () => {
    expect(await defaultPathProbe(path.join(root, 'docs', 'ARCH.md'), root)).toBe(true);
  });

  it('accepts a directory', async () => {
    expect(await defaultPathProbe(path.join(root, 'docs'), root)).toBe(true);
  });

  it('reports a nonexistent file as missing', async () => {
    expect(await defaultPathProbe(path.join(root, 'nope.md'), root)).toBe('missing');
  });

  // A symlink is the containment check wearing a hat: the path IS inside the repo, its target
  // is not. Following it without re-checking would reopen the escape the string check closed.
  it('refuses an in-repo symlink whose target is outside the repo', async () => {
    const link = path.join(root, 'leak');
    await symlink(path.join(outside, 'secret'), link);
    expect(await defaultPathProbe(link, root)).toBe('outside-repo');
  });
});

// Against the REAL reader and real files, because the bug these cover is invisible to a fake: a
// byte-limited read compared against a character count reports a truncated non-ASCII file as
// complete, and the prompt then tells the agent it holds the whole document.
describe('defaultDocReader', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'noriq-read-'));
    await writeFile(path.join(root, 'ascii.md'), 'x'.repeat(500));
    await writeFile(path.join(root, 'dashes.md'), '—'.repeat(500)); // 3 bytes each in UTF-8
    await writeFile(path.join(root, 'small.md'), 'tiny');
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const read = async (name: string, limit: number) =>
    loadRepoDocs(root, [name], undefined, limit).then((r) => r.docs[0]);

  it('detects the cut in a pure-ASCII file', async () => {
    const d = await read('ascii.md', 100);
    expect(d?.truncated).toBe(true);
    expect(d?.text).toHaveLength(100);
  });

  // The regression: 101 characters of em dash is 303 bytes. A byte-sized window decodes to fewer
  // characters than the limit and the file reads as complete.
  it('detects the cut in a multi-byte file — bytes are not characters', async () => {
    const d = await read('dashes.md', 100);
    expect(d?.truncated).toBe(true);
    expect(d?.text).toHaveLength(100);
    expect(d?.text).toBe('—'.repeat(100));
  });

  it('does not claim a cut on a file that fits', async () => {
    const d = await read('small.md', 100);
    expect(d?.truncated).toBeUndefined();
    expect(d?.text).toBe('tiny');
  });

  it('does not claim a cut on a file that exactly fills the budget', async () => {
    const d = await read('small.md', 4);
    expect(d?.truncated).toBeUndefined();
    expect(d?.text).toBe('tiny');
  });

  // The BOUNDED-I/O contract, pinned on the reader itself. Every other test here slices to the
  // budget afterwards, so they pass just as happily against a whole-file `readFile` — which is the
  // OOM this bound exists to prevent. Observing the raw return is the only way to see the window.
  it('reads a bounded window, not the whole file', async () => {
    const big = path.join(root, 'huge.md');
    await writeFile(big, 'x'.repeat(200_000));
    const raw = await defaultDocReader(big, 10);
    expect(raw.length).toBeLessThanOrEqual((10 + 1) * 4);
    expect(raw.length).toBeGreaterThan(10); // still enough to detect the cut
  });

  // 4-byte characters are TWO UTF-16 units, so an odd cut lands between a surrogate pair and emits
  // a lone surrogate — a malformed character in the prompt rather than a shortened one.
  it('never severs a surrogate pair when cutting', async () => {
    await writeFile(path.join(root, 'emoji.md'), '🔒'.repeat(50));
    const d = await read('emoji.md', 5); // odd limit → the cut falls mid-pair
    expect(d?.truncated).toBe(true);
    expect(d?.text).toBe('🔒🔒'); // 4 units kept, the split pair dropped whole
    expect(/[\uD800-\uDBFF]$/.test(d?.text ?? '')).toBe(false);
  });
});

describe('renderRepoContext', () => {
  const resolved = (over = {}) => ({
    requiredReading: [],
    entryPoints: [],
    conventions: [],
    unresolved: [],
    ...over,
  });

  // The no-op guarantee: a repo with no [context] must produce the prompt it produced before
  // RUN-128 existed, byte for byte.
  it('renders nothing when the repo declared nothing', () => {
    expect(renderRepoContext(resolved())).toBe('');
  });

  it('renders nothing when only unresolved paths remain', () => {
    const r = resolved({ unresolved: [{ declared: 'gone.md', reason: 'missing' as const }] });
    expect(renderRepoContext(r)).toBe('');
  });

  it('renders each declared kind under one attributed block', () => {
    const out = renderRepoContext(
      resolved({
        entryPoints: ['src/daemon.ts', 'src/supervisor.ts'],
        conventions: ['ESM only', 'no barrel files'],
        requiredReading: ['docs/ARCH.md'],
      }),
    );
    expect(out).toContain('This repo says of itself:');
    expect(out).toContain('- Start here: src/daemon.ts, src/supervisor.ts');
    expect(out).toContain('- Conventions (non-negotiable): ESM only; no barrel files');
    expect(out).toContain('- Read before changing anything: docs/ARCH.md');
  });

  it('omits the kinds the repo left empty', () => {
    const out = renderRepoContext(resolved({ conventions: ['ESM only'] }));
    expect(out).toContain('Conventions');
    expect(out).not.toContain('Start here');
    expect(out).not.toContain('Read before changing anything');
  });

  it('carries its own leading blank line so templates can inline the tag', () => {
    expect(renderRepoContext(resolved({ conventions: ['x'] }))).toMatch(/^\n\n/);
  });
});

// ---------------------------------------------------------------------------
// RUN-129 — inlining the required reading
// ---------------------------------------------------------------------------

/** Honours `limit` exactly as the real reader must — a fake that returned whole files would let a
 *  regression to unbounded reads pass unnoticed, which is the bug this contract exists to stop. */
const reader = (files: Record<string, string>): DocReader => {
  const fn: DocReader = async (abs, limit) => {
    const key = path.basename(abs);
    const hit = files[key] ?? files[abs];
    if (hit === undefined) throw new Error(`ENOENT ${abs}`);
    reads.push({ path: abs, limit });
    return hit.slice(0, limit + 1);
  };
  return fn;
};
/** Every read the fake served, so a test can assert the daemon never asked for more than budget. */
let reads: Array<{ path: string; limit: number }> = [];
beforeEach(() => {
  reads = [];
});

describe('discoverAgentInstructions', () => {
  it('finds the conventional instruction files a repo actually has', async () => {
    const probe: PathProbe = async (abs) => abs.endsWith('CLAUDE.md');
    expect(await discoverAgentInstructions('/repo', probe)).toEqual(['CLAUDE.md']);
  });

  it('finds both, in a stable order', async () => {
    expect(await discoverAgentInstructions('/repo', allExist)).toEqual(['CLAUDE.md', 'AGENTS.md']);
  });

  it('finds nothing in a repo that carries neither', async () => {
    expect(await discoverAgentInstructions('/repo', async () => 'missing')).toEqual([]);
  });
});

describe('loadRepoDocs', () => {
  it('inlines files whole while the budget holds', async () => {
    const r = await loadRepoDocs('/repo', ['a.md', 'b.md'], reader({ 'a.md': 'AAA', 'b.md': 'BB' }), 100);
    expect(r.docs).toEqual([
      { path: 'a.md', text: 'AAA' },
      { path: 'b.md', text: 'BB' },
    ]);
    expect(r.skipped).toEqual([]);
  });

  // Silence is the failure mode being prevented: an agent that believes it read a document it
  // only got half of will confidently apply half a rule.
  it('truncates the file that crosses the budget and records the original size', async () => {
    const r = await loadRepoDocs('/repo', ['big.md'], reader({ 'big.md': 'x'.repeat(50) }), 10);
    expect(r.docs[0]?.text).toBe('x'.repeat(10));
    expect(r.docs[0]?.truncated).toBe(true);
  });

  // The budget must bound the READ, not just the kept slice. Reading whole files and trimming
  // afterwards lets a committed marker point at a huge in-repo file and stall or OOM the daemon.
  it('never asks the reader for more than the remaining budget', async () => {
    await loadRepoDocs('/repo', ['big.md'], reader({ 'big.md': 'x'.repeat(10_000) }), 10);
    expect(reads).toEqual([{ path: path.resolve('/repo', 'big.md'), limit: 10 }]);
  });

  it('shrinks the ask as the budget is consumed', async () => {
    const files = { 'a.md': 'AAA', 'b.md': 'BB' };
    await loadRepoDocs('/repo', ['a.md', 'b.md'], reader(files), 10);
    expect(reads.map((r) => r.limit)).toEqual([10, 7]);
  });

  // loadRepoDocs is exported, so it is a public entry point in its own right — it cannot lean on
  // resolveRepoContext having checked first.
  it('confines paths itself rather than trusting the caller', async () => {
    const r = await loadRepoDocs('/repo', ['../../etc/passwd'], reader({ passwd: 'root:x:0:0' }), 100);
    expect(r.docs).toEqual([]);
    expect(r.skipped).toEqual(['../../etc/passwd']);
    expect(reads).toEqual([]); // refused before any open
  });

  it('skips — and names — everything after the budget is spent', async () => {
    const files = { 'a.md': 'x'.repeat(10), 'b.md': 'B', 'c.md': 'C' };
    const r = await loadRepoDocs('/repo', ['a.md', 'b.md', 'c.md'], reader(files), 10);
    expect(r.docs.map((d) => d.path)).toEqual(['a.md']);
    expect(r.skipped).toEqual(['b.md', 'c.md']);
  });

  it('consumes in manifest order, so ordering the list is how a repo picks what survives', async () => {
    const files = { 'low.md': 'l'.repeat(10), 'high.md': 'h'.repeat(10) };
    const r = await loadRepoDocs('/repo', ['high.md', 'low.md'], reader(files), 10);
    expect(r.docs.map((d) => d.path)).toEqual(['high.md']);
    expect(r.skipped).toEqual(['low.md']);
  });

  it('an unreadable file is skipped, not fatal — a brief missing one document still works', async () => {
    const r = await loadRepoDocs('/repo', ['gone.md', 'ok.md'], reader({ 'ok.md': 'fine' }), 100);
    expect(r.docs.map((d) => d.path)).toEqual(['ok.md']);
    expect(r.skipped).toEqual(['gone.md']);
  });
});

describe('renderRepoContext with inlined docs', () => {
  const res = (over = {}) => ({
    requiredReading: [],
    entryPoints: [],
    conventions: [],
    unresolved: [],
    ...over,
  });

  it('reproduces the text and tells the agent not to re-read it', async () => {
    const loaded = await loadRepoDocs('/repo', ['CLAUDE.md'], reader({ 'CLAUDE.md': '# rules' }), 100);
    const out = renderRepoContext(res({ requiredReading: ['CLAUDE.md'] }), loaded);
    expect(out).toContain('----- CLAUDE.md -----');
    expect(out).toContain('# rules');
    expect(out).toContain('do not spend a turn re-reading them');
  });

  // Naming a file whose text follows it just invites a wasted tool call.
  it('does not also NAME a file it inlined', async () => {
    const loaded = await loadRepoDocs('/repo', ['CLAUDE.md'], reader({ 'CLAUDE.md': '# rules' }), 100);
    const out = renderRepoContext(res({ requiredReading: ['CLAUDE.md'] }), loaded);
    expect(out).not.toContain('Read before changing anything');
  });

  it('names what it could not inline, so absence is not read as nonexistence', async () => {
    const files = { 'a.md': 'x'.repeat(10), 'b.md': 'B' };
    const loaded = await loadRepoDocs('/repo', ['a.md', 'b.md'], reader(files), 10);
    const out = renderRepoContext(res({ requiredReading: ['a.md', 'b.md'] }), loaded);
    expect(out).toContain('Declared reading not included below: b.md');
  });

  it('marks a truncated file as a fragment, without claiming a size it never measured', async () => {
    const loaded = await loadRepoDocs('/repo', ['big.md'], reader({ 'big.md': 'x'.repeat(50) }), 10);
    const out = renderRepoContext(res({ requiredReading: ['big.md'] }), loaded);
    expect(out).toContain('----- big.md (FIRST 10 characters only — the rest was not read) -----');
  });

  // Telling an agent not to re-read a file it only half received is how a half-read rule gets
  // applied with confidence. A fragment must be BOTH named for reading and flagged in the closer.
  it('sends a truncated file back to be read rather than suppressing it', async () => {
    const loaded = await loadRepoDocs('/repo', ['big.md'], reader({ 'big.md': 'x'.repeat(50) }), 10);
    const out = renderRepoContext(res({ requiredReading: ['big.md'] }), loaded);
    expect(out).toContain('Read before changing anything: big.md');
    expect(out).toContain('read the rest yourself before relying on it');
    expect(out).not.toContain('do not spend a turn re-reading them.');
  });

  it('still renders nothing when the repo has no context and no docs', () => {
    expect(renderRepoContext(res(), { docs: [], skipped: [] })).toBe('');
  });
});

describe('loadRepoContext', () => {
  it('falls back to the conventional files when the manifest declares no reading', async () => {
    const r = await loadRepoContext('/repo', ctx({ conventions: ['ESM only'] }), {
      probe: async (abs) => abs.endsWith('CLAUDE.md'),
      read: reader({ 'CLAUDE.md': '# repo rules' }),
    });
    expect(r.resolved.requiredReading).toEqual(['CLAUDE.md']);
    expect(r.rendered).toContain('# repo rules');
    expect(r.rendered).toContain('ESM only');
  });

  // An explicit list is a decision; extending it silently would override that decision.
  it('does NOT add conventional files when the manifest declared its own reading', async () => {
    const r = await loadRepoContext('/repo', ctx({ requiredReading: ['docs/ARCH.md'] }), {
      probe: allExist,
      read: reader({ 'ARCH.md': '# arch' }),
    });
    expect(r.resolved.requiredReading).toEqual(['docs/ARCH.md']);
    expect(r.rendered).not.toContain('CLAUDE.md');
  });

  // The fallback keys off what was DECLARED, not what survived. A repo that typo'd its whole list
  // has still made a choice; substituting CLAUDE.md would show an oriented agent while the
  // operator never learns their list is broken.
  it('does not fall back when a declared list resolves to nothing', async () => {
    const r = await loadRepoContext('/repo', ctx({ requiredReading: ['docs/typo.md'] }), {
      probe: async (abs) => (abs.endsWith('typo.md') ? 'missing' : true),
      read: reader({ 'CLAUDE.md': '# repo rules' }),
    });
    expect(r.resolved.requiredReading).toEqual([]);
    expect(r.rendered).not.toContain('# repo rules');
    expect(r.resolved.unresolved).toEqual([{ declared: 'docs/typo.md', reason: 'missing' }]);
  });

  it('a repo with neither a [context] nor instruction files renders nothing', async () => {
    const r = await loadRepoContext('/repo', null, {
      probe: async () => 'missing',
      read: reader({}),
    });
    expect(r.rendered).toBe('');
  });

  it('confinement still holds on the fallback path', async () => {
    const r = await loadRepoContext('/repo', ctx({ requiredReading: ['../escape.md'] }), {
      probe: allExist,
      read: reader({ 'escape.md': 'secret' }),
    });
    expect(r.rendered).not.toContain('secret');
    expect(r.resolved.unresolved[0]?.reason).toBe('outside-repo');
  });
});
