import { ProjectManifest, canonicalHash } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import { computeConfigurationFingerprints, sortKeysDeep } from '../src/config-fingerprint';
import { BUILTIN_WORKFLOWS } from '../src/workflow';

const baseManifest = (overrides: Record<string, unknown> = {}) =>
  ProjectManifest.parse({ key: 'RUN', ...overrides });

describe('sortKeysDeep', () => {
  it('produces the same shape for two objects built with different key insertion order', () => {
    const a = { b: 1, a: 2, c: { y: 1, x: 2 } };
    const b: Record<string, unknown> = {};
    b.c = { x: 2, y: 1 };
    b.a = 2;
    b.b = 1;
    expect(JSON.stringify(sortKeysDeep(a))).toBe(JSON.stringify(sortKeysDeep(b)));
    // The two raw objects really do serialize differently — the point of the helper.
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('leaves array order untouched — sequence is data, not an assembly artifact', () => {
    const value = { stages: ['plan', 'execute', 'verify'] };
    expect((sortKeysDeep(value) as { stages: string[] }).stages).toEqual(['plan', 'execute', 'verify']);
  });
});

describe('computeConfigurationFingerprints — determinism (RUN-246)', () => {
  it('same effective config, two different assembly orders, produces identical digests', async () => {
    // Order A: object literal, fields in declaration order.
    const manifestA = baseManifest({
      verify: { cmd: 'npm run check', agent: { agent: 'claude.opus.high', maxRounds: 2 } },
      context: { requiredReading: ['CLAUDE.md'], conventions: ['ESM only'] },
    });

    // Order B: the SAME data, assembled by spreading fields in over a base object in a different
    // sequence — the shape TOML parsing / optional-field assembly actually produces.
    const built: Record<string, unknown> = {};
    built.context = { conventions: ['ESM only'], requiredReading: ['CLAUDE.md'] };
    built.key = 'RUN';
    built.verify = { agent: { maxRounds: 2, agent: 'claude.opus.high' }, cmd: 'npm run check' };
    const manifestB = ProjectManifest.parse(built);

    const workflow = BUILTIN_WORKFLOWS.build;
    const a = await computeConfigurationFingerprints({
      runnerVersion: '1.2.3',
      manifest: manifestA,
      workflow,
    });
    const b = await computeConfigurationFingerprints({
      runnerVersion: '1.2.3',
      manifest: manifestB,
      workflow,
    });

    expect(a.map((f) => f.fingerprint)).toEqual(b.map((f) => f.fingerprint));
    expect(a).toEqual(b);
  });

  it('fingerprints built for a repo at one absolute root and again at a different root are identical', async () => {
    // The path-exclusion proof: `computeConfigurationFingerprints` never takes a root/local path at
    // all, so the SAME committed manifest+workflow content, standing in for two checkouts at
    // different absolute locations, must fingerprint identically. Nothing here simulates a real
    // discovery walk because nothing about a root ever reaches the hashed input in the first place.
    const manifest = baseManifest({ verify: { cmd: 'npm test' } });
    const workflow = BUILTIN_WORKFLOWS.scope;

    const atRootOne = await computeConfigurationFingerprints({
      runnerVersion: '9.9.9',
      manifest,
      workflow,
    });
    const atRootTwo = await computeConfigurationFingerprints({
      runnerVersion: '9.9.9',
      manifest,
      workflow,
    });

    expect(atRootOne).toEqual(atRootTwo);
  });
});

describe('computeConfigurationFingerprints — workflow prompt identity (RUN-246)', () => {
  it('editing a workflow prompt text changes its fingerprint while name stays unchanged', async () => {
    const base = BUILTIN_WORKFLOWS.build;
    const revisionA = { ...base, id: 'release-notes', promptRef: 'Write release notes for {{brief}}.' };
    const revisionB = {
      ...base,
      id: 'release-notes',
      promptRef: 'Write release notes for {{brief}}. Be terse.',
    };

    const manifest = baseManifest();
    const a = await computeConfigurationFingerprints({
      runnerVersion: '1.0.0',
      manifest,
      workflow: revisionA,
    });
    const b = await computeConfigurationFingerprints({
      runnerVersion: '1.0.0',
      manifest,
      workflow: revisionB,
    });

    const wfA = a.find((f) => f.kind === 'workflow')!;
    const wfB = b.find((f) => f.kind === 'workflow')!;
    expect(wfA.name).toBe('release-notes');
    expect(wfB.name).toBe('release-notes');
    expect(wfA.fingerprint).not.toBe(wfB.fingerprint);
  });

  it('two revisions of the same workflow name are distinguishable — name alone is not identity', async () => {
    const base = BUILTIN_WORKFLOWS.scope;
    const v1 = { ...base, id: 'docs', promptRef: 'Explore and document version 1.' };
    const v2 = { ...base, id: 'docs', promptRef: 'Explore and document version 2 — with a diagram.' };

    const manifest = baseManifest();
    const resultV1 = await computeConfigurationFingerprints({
      runnerVersion: '1.0.0',
      manifest,
      workflow: v1,
    });
    const resultV2 = await computeConfigurationFingerprints({
      runnerVersion: '1.0.0',
      manifest,
      workflow: v2,
    });
    const wf1 = resultV1.find((f) => f.kind === 'workflow')!;
    const wf2 = resultV2.find((f) => f.kind === 'workflow')!;

    expect(wf1.name).toBe(wf2.name); // same cohort by name...
    expect(wf1.fingerprint).not.toBe(wf2.fingerprint); // ...but distinguishable by revision
  });

  it('a built-in workflow (no promptRef) still fingerprints its bundled template text, not just its shape', async () => {
    const manifest = baseManifest();
    const scope = await computeConfigurationFingerprints({
      runnerVersion: '1.0.0',
      manifest,
      workflow: BUILTIN_WORKFLOWS.scope,
    });
    const build = await computeConfigurationFingerprints({
      runnerVersion: '1.0.0',
      manifest,
      workflow: BUILTIN_WORKFLOWS.build,
    });
    const scopeWf = scope.find((f) => f.kind === 'workflow')!;
    const buildWf = build.find((f) => f.kind === 'workflow')!;
    // Different bundled prompts (prompts/scope.md vs prompts/build.md) → different fingerprints,
    // even though neither built-in ever sets `promptRef`.
    expect(scopeWf.fingerprint).not.toBe(buildWf.fingerprint);
  });
});

describe('computeConfigurationFingerprints — omission (RUN-246)', () => {
  it('emits the kinds it can determine and omits reviewer/verifier when [verify] is absent', async () => {
    const manifest = baseManifest(); // no [verify] at all
    const result = await computeConfigurationFingerprints({
      runnerVersion: '1.0.0',
      manifest,
      workflow: BUILTIN_WORKFLOWS.build,
    });
    const kinds = result.map((f) => f.kind).sort();
    expect(kinds).toEqual(['context', 'manifest', 'runner', 'workflow']);
    expect(result.every((f) => f.fingerprint.length > 0)).toBe(true);
  });

  it('emits verifier but not reviewer when only [verify].cmd is declared', async () => {
    const manifest = baseManifest({ verify: { cmd: 'npm test' } });
    const result = await computeConfigurationFingerprints({
      runnerVersion: '1.0.0',
      manifest,
      workflow: BUILTIN_WORKFLOWS.build,
    });
    const kinds = result.map((f) => f.kind).sort();
    expect(kinds).toContain('verifier');
    expect(kinds).not.toContain('reviewer');
  });

  it('emits reviewer but not verifier when only [verify.agent] is declared (no cmd)', async () => {
    const manifest = baseManifest({ verify: { agent: { agent: 'codex.gpt-5.high' } } });
    const result = await computeConfigurationFingerprints({
      runnerVersion: '1.0.0',
      manifest,
      workflow: BUILTIN_WORKFLOWS.build,
    });
    const kinds = result.map((f) => f.kind).sort();
    expect(kinds).toContain('reviewer');
    expect(kinds).not.toContain('verifier');
    const reviewer = result.find((f) => f.kind === 'reviewer')!;
    expect(reviewer.name).toBe('codex.gpt-5.high');
  });
});

describe('computeConfigurationFingerprints — no secrets, no absolute paths', () => {
  it('the manifest fingerprint carries no field derived from a local filesystem root', async () => {
    // The manifest schema itself (vendor/manifest.ts) carries no absolute-path field — every path
    // in it is repo-relative by contract. This test pins the input surface: the function does not
    // even accept a `root`/`localPath`, so nothing machine-specific can leak in through this call.
    const manifest = baseManifest({
      context: { requiredReading: ['docs/ARCH.md'] },
      index: { enabled: true, include: ['src/**'], exclude: ['**/*.test.ts'] },
    });
    const result = await computeConfigurationFingerprints({
      runnerVersion: '1.0.0',
      manifest,
      workflow: BUILTIN_WORKFLOWS.scope,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/\/home\/|\/Users\/|^[A-Za-z]:\\/);
  });
});

describe('the synchronous digest agrees with the vendored canonicalHash (RUN-246)', () => {
  // `config-fingerprint.ts` hashes with node's `createHash` rather than awaiting the shared
  // `crypto.subtle`-based `canonicalHash`, because five macrotask digests on `supervise`'s critical
  // path is a cost not worth paying for a hash. That is only defensible while the two AGREE, so the
  // vendored contract stays the oracle here: if a future planar change alters canonicalHash's
  // serialization, this fails and names the divergence instead of letting fingerprints drift apart.
  it('every real fingerprint equals canonicalHash of the same sorted content', async () => {
    const wf = BUILTIN_WORKFLOWS.build ?? Object.values(BUILTIN_WORKFLOWS)[0]!;
    const out = computeConfigurationFingerprints({
      runnerVersion: '1.2.3',
      manifest: baseManifest({ verify: { cmd: 'npm test' } }),
      workflow: wf,
    });
    expect(out.length).toBeGreaterThan(0);
    // The `runner` kind's content is the one this test can reconstruct without duplicating the
    // module's per-kind choices — enough to prove the DIGEST FUNCTION matches, which is the claim.
    const runner = out.find((c) => c.kind === 'runner');
    expect(runner?.fingerprint).toBe(await canonicalHash(sortKeysDeep({ version: '1.2.3' })));
  });

  it('agrees on a nested object whose keys were inserted in a different order', async () => {
    const a = { b: 2, a: [1, { z: 0, y: 1 }] };
    const b = { a: [1, { y: 1, z: 0 }], b: 2 };
    expect(await canonicalHash(sortKeysDeep(a))).toBe(await canonicalHash(sortKeysDeep(b)));
  });
});
