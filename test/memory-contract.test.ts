import { BaseId, ProjectManifest, RunnerRepo } from '@noriq-dev/shared';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { RepositoryKey, parseRepositoryKey } from '../src/memory-contract';

// Bidirectional compatibility (RUN-207 locked decision 7):
//   (a) a manifest or server response written BEFORE the Project Memory fields existed still
//       parses, with the new fields defaulting to null — never a parse failure.
//   (b) a payload the runner sends carrying a new field is safe against a server that does not
//       know it — zod's default unknown-key stripping, not exercised here since it needs no test
//       (it is zod's own behaviour, not something this file adds).

describe('ProjectManifest — old manifests parse with the new fields defaulted', () => {
  it('a TOML naming neither `repositoryKey` nor `[index]` yields both null, everything else unchanged', () => {
    const raw = parseToml('key = "AAA"\n');
    const parsed = ProjectManifest.parse(raw);
    expect(parsed.repositoryKey).toBeNull();
    expect(parsed.index).toBeNull();
    // The rest of a pre-memory manifest's defaults, untouched by this crossing.
    expect(parsed.key).toBe('AAA');
    expect(parsed.board).toBeNull();
    expect(parsed.verify).toBeNull();
    expect(parsed.setup).toBeNull();
    expect(parsed.land).toBeNull();
    expect(parsed.permissions.build.write).toBe(true);
    expect(parsed.permissions.scope.write).toBe(false);
    expect(parsed.workflows).toEqual({});
  });

  it('a manifest that DOES declare `repositoryKey` and `[index]` parses them', () => {
    const raw = parseToml('key = "AAA"\nrepositoryKey = "runner"\n\n[index]\nenabled = true\n');
    const parsed = ProjectManifest.parse(raw);
    expect(parsed.repositoryKey).toBe('runner');
    expect(parsed.index).toEqual({ enabled: true, include: [], exclude: [] });
  });
});

describe('RunnerRepo — a server response from before the crossing still parses', () => {
  it('omitting `repositoryKey` defaults it to null', () => {
    const wire = {
      id: 'repo_a',
      projectKey: 'AAA',
      board: null,
      name: 'a',
      defaultBranch: null,
      workflows: [],
    };
    const parsed = RunnerRepo.parse(wire);
    expect(parsed.repositoryKey).toBeNull();
  });
});

describe('RepositoryKey — the only validator for a canonical repository key (locked decision 8)', () => {
  it('accepts a plain slug', () => {
    expect(RepositoryKey.safeParse('runner').success).toBe(true);
  });

  it('rejects a `ckt_`-prefixed value — that is a runner-local checkout id, not a canonical key', () => {
    expect(RepositoryKey.safeParse('ckt_ab12cd34').success).toBe(false);
  });

  it('rejects a value starting with a digit', () => {
    expect(RepositoryKey.safeParse('1runner').success).toBe(false);
  });

  it('rejects a path-like value containing `/`', () => {
    expect(RepositoryKey.safeParse('noriq/runner').success).toBe(false);
  });

  it('rejects an over-64-char value', () => {
    expect(RepositoryKey.safeParse('a'.repeat(65)).success).toBe(false);
  });

  it('accepts a 64-char value at the boundary', () => {
    expect(RepositoryKey.safeParse('a'.repeat(64)).success).toBe(true);
  });
});

describe('parseRepositoryKey — the runner-facing helper (RUN-208 calls this on association failure)', () => {
  it('returns the parsed key on success', () => {
    expect(parseRepositoryKey('runner')).toEqual({ ok: true, key: 'runner' });
  });

  it('returns a readable reason a log line can carry on failure', () => {
    const result = parseRepositoryKey('ckt_ab12cd34');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure result');
    expect(result.reason).toContain('ckt_ab12cd34');
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe('BaseId stays opaque — no code path format-checks it (locked decision 6)', () => {
  it('accepts a Perforce changelist number', () => {
    expect(BaseId.safeParse('41827').success).toBe(true);
  });

  it('accepts an opaque Diversion commit id', () => {
    expect(BaseId.safeParse('dv_9f3a7c21e8b0').success).toBe(true);
  });

  it('accepts a Git SHA too — BaseId is backend-agnostic, not Git-shaped', () => {
    expect(BaseId.safeParse('a1b2c3d4e5f6').success).toBe(true);
  });
});
