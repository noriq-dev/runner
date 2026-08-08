import type { IndexSpec } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import { IndexPolicy, refuseIndexGlob, resolveIndexConfig } from '../src/index-policy';

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
      languages: ['typescript', 'javascript', 'markdown', 'json', 'toml'],
      contentMode: 'full',
      maxFiles: 20_000,
      maxFileBytes: 1_000_000,
      maxTotalBytes: 500_000_000,
      readDeadlineMs: 120_000,
      pollIntervalMinutes: 60,
    });
  });

  it('accepts every settled language and refuses an unrecognized one', () => {
    expect(IndexPolicy.safeParse({ languages: ['typescript', 'toml'] }).success).toBe(true);
    expect(IndexPolicy.safeParse({ languages: ['python'] }).success).toBe(false);
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
      languages: ['typescript', 'javascript', 'markdown', 'json', 'toml'],
      contentMode: 'metadata',
      maxFiles: 10,
      maxFileBytes: 1_000_000,
      maxTotalBytes: 500_000_000,
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
