import type { IndexSpec } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDE_GLOBS, IndexPolicy, refuseIndexGlob, resolveIndexConfig } from '../src/index-policy';
import { scanIndexSource } from '../src/index-scan';
import { FakeIndexSource } from '../src/index-source';

function spyLogger() {
  const errors: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  return {
    errors,
    log: { error: (msg: string, fields?: Record<string, unknown>) => errors.push({ msg, fields }) },
  };
}

const spec = (over: Partial<IndexSpec> = {}): IndexSpec => ({
  enabled: true,
  include: [],
  exclude: [],
  ...over,
});

describe('IndexPolicy — the runner-owned execution knobs', () => {
  it('defaults every knob when the table is empty', () => {
    const parsed = IndexPolicy.parse({});
    expect(parsed).toEqual({
      languages: ['typescript', 'javascript', 'markdown', 'json', 'toml', 'cpp', 'ini'],
      contentMode: 'full',
      maxFiles: 20_000,
      maxFileBytes: 1_000_000,
      maxTotalBytes: 100_000_000,
      readDeadlineMs: 120_000,
      pollIntervalMinutes: 60,
    });
  });

  it('accepts every settled language and refuses an unrecognized one', () => {
    expect(IndexPolicy.safeParse({ languages: ['typescript', 'toml'] }).success).toBe(true);
    expect(IndexPolicy.safeParse({ languages: ['python'] }).success).toBe(false);
  });

  it('RUN-239: accepts cpp and ini — Go and Rust stay refused, zero measured demand', () => {
    expect(IndexPolicy.safeParse({ languages: ['cpp', 'ini'] }).success).toBe(true);
    expect(IndexPolicy.safeParse({ languages: ['go'] }).success).toBe(false);
    expect(IndexPolicy.safeParse({ languages: ['rust'] }).success).toBe(false);
  });

  it('refuses a negative or non-numeric bound', () => {
    expect(IndexPolicy.safeParse({ maxFileBytes: -1 }).success).toBe(false);
    expect(IndexPolicy.safeParse({ maxFileBytes: 0 }).success).toBe(false);
    expect(IndexPolicy.safeParse({ pollIntervalMinutes: 'hourly' }).success).toBe(false); // non-numeric cadence
  });

  it('refuses an unrecognized key — a typo must not silently vanish', () => {
    expect(IndexPolicy.safeParse({ maxFileByte: 5 }).success).toBe(false);
  });
});

describe('refuseIndexGlob', () => {
  it('allows an ordinary relative glob', () => {
    expect(refuseIndexGlob('src/**/*.ts')).toBeNull();
    expect(refuseIndexGlob('docs/**')).toBeNull();
  });

  it('refuses an absolute path, POSIX or Windows-drive-rooted', () => {
    expect(refuseIndexGlob('/etc/**')).toMatch(/absolute/);
    expect(refuseIndexGlob(String.raw`C:\secrets\**`)).toMatch(/absolute/);
  });

  it('refuses a glob that climbs above the repository root', () => {
    expect(refuseIndexGlob('../../.ssh/**')).toMatch(/escapes/);
    expect(refuseIndexGlob('a/../../b')).toMatch(/escapes/);
  });

  it('allows a glob that dips via ".." but never climbs above the root', () => {
    expect(refuseIndexGlob('src/../lib/**')).toBeNull();
  });
});

describe('resolveIndexConfig — decision 4/5: off unless enabled, invalid refuses indexing only', () => {
  it('is off when the vendored spec is null', () => {
    expect(resolveIndexConfig(null, {})).toBeNull();
  });

  it('is off when `[index]` is present but enabled is unset — present-but-empty is still off', () => {
    expect(resolveIndexConfig(spec({ enabled: false }), { include: ['src/**'] })).toBeNull();
  });

  it('merges the vendored scope with the daemon policy when enabled and valid', () => {
    const resolved = resolveIndexConfig(spec({ include: ['src/**'], exclude: ['**/*.gen.ts'] }), {
      enabled: true,
      include: ['src/**'],
      exclude: ['**/*.gen.ts'],
      contentMode: 'metadata',
      maxFiles: 10,
    });
    expect(resolved).toEqual({
      include: ['src/**'],
      exclude: ['**/*.gen.ts'],
      // RUN-262: the machine-wide default is layered on UNDER `exclude`, never merged into it —
      // `exclude` above is exactly what the repo declared, unchanged.
      defaultExclude: DEFAULT_EXCLUDE_GLOBS,
      languages: ['typescript', 'javascript', 'markdown', 'json', 'toml', 'cpp', 'ini'],
      contentMode: 'metadata',
      maxFiles: 10,
      maxFileBytes: 1_000_000,
      maxTotalBytes: 100_000_000,
      readDeadlineMs: 120_000,
      pollIntervalMinutes: 60,
    });
  });

  it('never redefines enabled/include/exclude — they pass through even absent from the raw table', () => {
    // The raw table can lag the parsed manifest (e.g. a caller building it by hand); the
    // vendored spec is still the source of truth for scope, read verbatim.
    const resolved = resolveIndexConfig(spec({ include: ['a/**'] }), { enabled: true });
    expect(resolved?.include).toEqual(['a/**']);
  });

  it('refuses indexing (not the repo) on an invalid bound — logs the offending key', () => {
    const { errors, log } = spyLogger();
    const resolved = resolveIndexConfig(spec(), { enabled: true, maxFileBytes: -1 }, log);
    expect(resolved).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.fields?.key).toBe('maxFileBytes');
  });

  it('refuses on an unknown key — a typo does not silently pass through', () => {
    const { errors, log } = spyLogger();
    const resolved = resolveIndexConfig(spec(), { enabled: true, maxFileByte: 5 }, log);
    expect(resolved).toBeNull();
    expect(errors).toHaveLength(1);
  });

  it('refuses on a non-numeric cadence', () => {
    const resolved = resolveIndexConfig(spec(), { enabled: true, pollIntervalMinutes: 'hourly' });
    expect(resolved).toBeNull();
  });

  it('refuses on an include/exclude glob that escapes the repository root, naming it', () => {
    const { errors, log } = spyLogger();
    const resolved = resolveIndexConfig(spec({ include: ['../../etc/**'] }), { enabled: true }, log);
    expect(resolved).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.fields?.glob).toBe('../../etc/**');
    expect(errors[0]?.fields?.field).toBe('include');
  });

  it('tolerates a missing/non-object raw table when enabled — resolves policy defaults', () => {
    expect(resolveIndexConfig(spec(), undefined)).toEqual(
      expect.objectContaining({ maxFiles: 20_000, pollIntervalMinutes: 60 }),
    );
  });
});

describe('resolveIndexConfig — RUN-262 default exclude for committed generated content', () => {
  it('applies the machine-wide default when the repo declares no excludeDefaults of its own', () => {
    const resolved = resolveIndexConfig(spec(), { enabled: true });
    expect(resolved?.defaultExclude).toEqual(DEFAULT_EXCLUDE_GLOBS);
  });

  it('a repo can turn the default off entirely — declaring intent to index a defaulted-out path', () => {
    const resolved = resolveIndexConfig(spec(), { enabled: true, excludeDefaults: false });
    expect(resolved?.defaultExclude).toEqual([]);
  });

  it('a repo’s own `exclude` is untouched by the default — no merging, no duplication', () => {
    const resolved = resolveIndexConfig(spec({ exclude: ['**/*.gen.ts'] }), {
      enabled: true,
      exclude: ['**/*.gen.ts'],
    });
    expect(resolved?.exclude).toEqual(['**/*.gen.ts']); // exactly what the repo wrote, nothing added
    expect(resolved?.defaultExclude).toEqual(DEFAULT_EXCLUDE_GLOBS); // the default still applies, separately
  });

  it('refuses on a non-boolean excludeDefaults — a typo/wrong type does not silently pass through', () => {
    const { errors, log } = spyLogger();
    const resolved = resolveIndexConfig(spec(), { enabled: true, excludeDefaults: 'nope' }, log);
    expect(resolved).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.fields?.key).toBe('excludeDefaults');
  });

  it('a genuine typo of the key (`excludeDefault`) refuses via the ordinary unknown-key path', () => {
    // `excludeDefault` (missing the trailing `s`) is NOT the stripped key, so it survives into
    // `policyRaw` and hits `IndexPolicy`'s own `.strict()` unrecognized-key refusal — the same
    // path a typo of any other execution knob takes (see the sibling test above this describe
    // block). zod reports an `unrecognized_keys` issue at the object root, not per-key, which is
    // why this asserts the same "(index table)" fallback the existing unknown-key test expects.
    const { errors, log } = spyLogger();
    const resolved = resolveIndexConfig(spec(), { enabled: true, excludeDefault: false }, log);
    expect(resolved).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.fields?.key).toBe('(index table)');
  });
});

describe('scanIndexSource — RUN-262 default exclude actually drops the file (not just the config field)', () => {
  it('drops a committed package-lock.json under the default, reporting `excluded-default`', async () => {
    const config = resolveIndexConfig(spec(), { enabled: true });
    const source = new FakeIndexSource([
      { kind: 'file', path: 'package-lock.json', content: '{"lockfileVersion": 3}\n' },
      { kind: 'file', path: 'src/a.ts', content: 'export const x = 1;\n' },
    ]);
    const result = await scanIndexSource(source, config);
    expect(result.candidates.map((c) => c.path)).toEqual(['src/a.ts']);
    expect(result.statuses).toContainEqual({ path: 'package-lock.json', reason: 'excluded-default' });
  });

  it('indexes package-lock.json once the repo declares `excludeDefaults = false`', async () => {
    const config = resolveIndexConfig(spec(), { enabled: true, excludeDefaults: false });
    const source = new FakeIndexSource([
      { kind: 'file', path: 'package-lock.json', content: '{"lockfileVersion": 3}\n' },
    ]);
    const result = await scanIndexSource(source, config);
    expect(result.candidates.map((c) => c.path)).toEqual(['package-lock.json']);
    expect(result.statuses).toEqual([]);
  });

  it('a repo’s own exclude still reports the pre-existing `excluded` reason, distinct from the default', async () => {
    const config = resolveIndexConfig(spec({ exclude: ['**/*.gen.ts'] }), {
      enabled: true,
      exclude: ['**/*.gen.ts'],
    });
    const source = new FakeIndexSource([
      { kind: 'file', path: 'foo.gen.ts', content: '// generated\n' },
      { kind: 'file', path: 'package-lock.json', content: '{}\n' },
    ]);
    const result = await scanIndexSource(source, config);
    expect(result.statuses).toContainEqual({ path: 'foo.gen.ts', reason: 'excluded' });
    expect(result.statuses).toContainEqual({ path: 'package-lock.json', reason: 'excluded-default' });
  });

  it('RUN-239: drops Unreal .uasset/.umap under the default, reporting `excluded-default` — never `binary`', async () => {
    // Binary bytes: were this NOT excluded first, `looksBinary` (a NUL in the first bytes) would
    // classify it `binary` instead — this proves the exclude check runs, and wins, BEFORE the read.
    const uassetBytes = Buffer.from([0x00, 0x01, 0x02, 0x03]).toString('latin1');
    const config = resolveIndexConfig(spec(), { enabled: true });
    const source = new FakeIndexSource([
      { kind: 'file', path: 'Content/Characters/Hero.uasset', content: uassetBytes },
      { kind: 'file', path: 'Content/Maps/Level01.umap', content: uassetBytes },
      { kind: 'file', path: 'Source/Survival/Survival.cpp', content: 'int main() { return 0; }\n' },
    ]);
    const result = await scanIndexSource(source, config);
    expect(result.candidates.map((c) => c.path)).toEqual(['Source/Survival/Survival.cpp']);
    expect(result.statuses).toContainEqual({
      path: 'Content/Characters/Hero.uasset',
      reason: 'excluded-default',
    });
    expect(result.statuses).toContainEqual({ path: 'Content/Maps/Level01.umap', reason: 'excluded-default' });
  });

  it('RUN-239: `excludeDefaults = false` still brings .uasset/.umap back, same escape hatch as the lockfile default', async () => {
    const config = resolveIndexConfig(spec(), { enabled: true, excludeDefaults: false });
    const source = new FakeIndexSource([{ kind: 'file', path: 'Content/Hero.uasset', content: '\x00\x01' }]);
    const result = await scanIndexSource(source, config);
    // Binary content, no default exclude to stop it before the read — the ordinary `binary` status
    // this file would always have gotten on its own bytes, proving the escape hatch does not
    // silently invent text content for something that never was any.
    expect(result.candidates).toEqual([]);
    expect(result.statuses).toEqual([{ path: 'Content/Hero.uasset', reason: 'binary' }]);
  });

  it('RUN-239: MAX_STATUS_RECORDS still bounds a tree with more excluded Unreal binaries than the cap — no crash, no hang', async () => {
    // Measured caveat (see index-policy.ts's own DEFAULT_EXCLUDE_GLOBS doc): the exclude/default-
    // exclude check has no directory-level pruning the way the hard deny list does, so each match
    // still costs one status-collector slot — this proves the EXISTING cap/overflow bookkeeping
    // still holds under that load, not that the collector stays small.
    const config = resolveIndexConfig(spec(), { enabled: true });
    const files = Array.from({ length: 1200 }, (_, i) => ({
      kind: 'file' as const,
      path: `Content/Asset${String(i).padStart(4, '0')}.uasset`,
      content: '\x00',
    }));
    const source = new FakeIndexSource(files);
    const result = await scanIndexSource(source, config);
    expect(result.candidates).toEqual([]);
    expect(result.statuses).toHaveLength(1000);
    expect(result.statusOverflow).toBe(200);
    expect(result.statuses.every((s) => s.reason === 'excluded-default')).toBe(true);
  });
});
