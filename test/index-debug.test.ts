import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEBUG_LIMIT,
  bounded,
  buildDebugReport,
  compareGenerations,
  displaySafeContent,
  renderDebugReport,
} from '../src/index-debug';
import { INDEX_LANGUAGES } from '../src/index-policy';
import type { ResolvedIndexConfig } from '../src/index-policy';
import { buildIndexAdapterRegistry } from '../src/index-registry';
import { FakeIndexSource } from '../src/index-source';
import { runIndexer } from '../src/indexer';
import type { IndexRunTarget } from '../src/indexer';

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

const target = (over: Partial<IndexRunTarget> = {}): IndexRunTarget => ({
  projectId: 'proj_1',
  projectKey: 'RUN',
  repositoryKey: 'runner',
  branch: 'main',
  baseId: 'sha_1',
  ...over,
});

describe('bounded()', () => {
  it('caps a list and reports the true total and how many were left out', () => {
    const result = bounded([1, 2, 3, 4, 5], 2);
    expect(result).toEqual({ shown: [1, 2], total: 5, omitted: 3 });
  });

  it('omitted is zero when the limit already covers everything', () => {
    expect(bounded([1, 2], 50)).toEqual({ shown: [1, 2], total: 2, omitted: 0 });
  });
});

describe('displaySafeContent — the debug tool’s OWN redaction floor', () => {
  it('withholds a value the tool itself recognises as secret-shaped, even though no adapter withheld it', () => {
    // A real GitHub PAT prefix — the exact issuer-prefix shape `index-redact.ts` matches. This is
    // never passed through `shouldWithholdValue` by `indexer.ts`'s own file-entity push (measured —
    // see this module's doc), so a correctly-behaving `--show-content` mode has to catch it itself.
    const secretShaped = 'const token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";';
    expect(displaySafeContent(secretShaped)).toBeNull();
  });

  it('passes ordinary content through, truncated past the preview bound', () => {
    expect(displaySafeContent('hello world')).toBe('hello world');
    const long = 'a'.repeat(1000);
    const preview = displaySafeContent(long);
    expect(preview).not.toBeNull();
    expect(preview!.length).toBeLessThan(long.length);
    expect(preview!.endsWith('…')).toBe(true);
  });

  it('null in, null out', () => {
    expect(displaySafeContent(null)).toBeNull();
  });
});

describe('buildDebugReport — over a real runIndexer result', () => {
  async function run(over: Partial<ResolvedIndexConfig> = {}) {
    const config = cfg(over);
    const { registry } = buildIndexAdapterRegistry(config);
    const source = new FakeIndexSource([
      { kind: 'file', path: 'src/a.ts', content: 'export function alpha(): number {\n  return 1;\n}\n' },
      {
        kind: 'file',
        path: 'src/b.ts',
        content: "import { alpha } from './a';\nexport function beta() { return alpha(); }\n",
      },
      { kind: 'file', path: 'README.md', content: '# Title\n\nSome text.\n' },
    ]);
    return runIndexer(source, config, target(), { adapters: registry });
  }

  it('counts entities and edges by type, and lists both bounded', async () => {
    const result = await run();
    const report = buildDebugReport(result, {
      root: '/repo',
      configSource: 'project.toml',
      config: cfg(),
      limit: 100,
    });
    expect(report.entityCounts.file).toBe(3);
    expect(report.entityCounts.symbol).toBeGreaterThanOrEqual(2); // alpha, beta at least
    expect(report.edgeCounts.declares).toBeGreaterThanOrEqual(2);
    expect(report.edgeCounts.imports).toBe(1); // b.ts imports a.ts
    expect(report.entities.omitted).toBe(0);
    expect(report.edges.omitted).toBe(0);
  });

  it('threads a symbol’s range through into the entity view, untouched by identity', async () => {
    const result = await run();
    const report = buildDebugReport(result, {
      root: '/repo',
      configSource: 'project.toml',
      config: cfg(),
      limit: 100,
    });
    const alpha = report.entities.shown.find((e) => e.label === 'alpha');
    expect(alpha?.range).toEqual({ startLine: 1, endLine: 3 });
  });

  it('omits content by default, even when the record itself carries it', async () => {
    const result = await run();
    const report = buildDebugReport(result, {
      root: '/repo',
      configSource: 'project.toml',
      config: cfg(),
      limit: 100,
    });
    for (const e of report.entities.shown) expect(e.content).toBeUndefined();
  });

  it('a credential-marker secret is withheld at the SOURCE (RUN-258) — the raw record already carries no content, before the report layer runs at all', async () => {
    const config = cfg();
    const { registry } = buildIndexAdapterRegistry(config);
    const secretToken = 'ghp_ThisLooksLikeARealGithubToken1234567890';
    const source = new FakeIndexSource([
      {
        kind: 'file',
        path: 'src/secret.ts',
        content: `export function withSecret() {\n  const token = "${secretToken}";\n  return token;\n}\n`,
      },
    ]);
    const result = await runIndexer(source, config, target(), { adapters: registry });
    // `indexer.ts` now withholds a `full`-mode file's content itself when it contains a
    // high-confidence credential marker (RUN-258) — a known issuer prefix is exactly that, so the
    // raw record is ALREADY redacted here, unlike the entropy-only case below. Symbol parsing is
    // skipped for the same file (same RUN-258 change), so there is no `withSecret` symbol entity
    // to carry the token back out through `node.text` either.
    const rawJson = JSON.stringify(result.records);
    expect(rawJson).not.toContain(secretToken);
    expect(result.records.some((r) => r.kind === 'node' && r.type === 'symbol')).toBe(false);

    const report = buildDebugReport(result, {
      root: '/repo',
      configSource: 'project.toml',
      config,
      limit: 100,
      showContent: true,
    });
    const reportJson = JSON.stringify(report);
    expect(reportJson).not.toContain(secretToken);
    const renderedText = renderDebugReport(report);
    expect(renderedText).not.toContain(secretToken);

    const fileEntity = report.entities.shown.find((e) => e.uri.endsWith('/secret.ts'));
    expect(fileEntity?.content).toBeNull();
  });

  it('a high-entropy secret with NO known marker is left alone by the indexer (RUN-258 is marker-only, not entropy) — the debug tool’s OWN redaction floor is what catches it, even under --show-content', async () => {
    const config = cfg();
    const { registry } = buildIndexAdapterRegistry(config);
    // High entropy (mixed case + digits, well over the length floor) but no PEM/JWT/issuer-prefix
    // shape — `index-redact.ts`'s `scanTextForCredentialMarkers` doc names this exact boundary: the
    // entropy heuristic does not transfer to whole-file scanning, so RUN-258 deliberately does not
    // apply it here. This is the case that proves the report layer's own floor still does real work.
    const secretToken = 'aB3xQ9zM2kLp7vN4wR8tYcJ6hGdFsE1u';
    const source = new FakeIndexSource([
      {
        kind: 'file',
        path: 'src/secret.ts',
        content: `export function withSecret() {\n  const token = "${secretToken}";\n  return token;\n}\n`,
      },
    ]);
    const result = await runIndexer(source, config, target(), { adapters: registry });
    // The raw record itself DOES carry the secret — measured, not assumed: this is what makes the
    // report-layer assertion below meaningful, rather than trivially true because nothing reached it.
    const rawJson = JSON.stringify(result.records);
    expect(rawJson).toContain(secretToken);

    const report = buildDebugReport(result, {
      root: '/repo',
      configSource: 'project.toml',
      config,
      limit: 100,
      showContent: true,
    });
    const reportJson = JSON.stringify(report);
    expect(reportJson).not.toContain(secretToken);
    const renderedText = renderDebugReport(report);
    expect(renderedText).not.toContain(secretToken);

    const withSecretEntity = report.entities.shown.find((e) => e.label === 'withSecret');
    expect(withSecretEntity?.content).toBeNull();
  });

  it('bounds the entity/edge listing and reports how many were omitted', async () => {
    const config = cfg();
    const { registry } = buildIndexAdapterRegistry(config);
    const items = Array.from({ length: 10 }, (_, i) => ({
      kind: 'file' as const,
      path: `src/f${i}.ts`,
      content: `export function fn${i}() { return ${i}; }\n`,
    }));
    const result = await runIndexer(new FakeIndexSource(items), config, target(), { adapters: registry });
    const report = buildDebugReport(result, {
      root: '/repo',
      configSource: 'project.toml',
      config,
      limit: 3,
    });
    expect(report.entities.shown.length).toBe(3);
    expect(report.entities.total).toBe(report.entities.shown.length + report.entities.omitted);
    expect(report.entities.omitted).toBeGreaterThan(0);
  });

  it('defaults to DEFAULT_DEBUG_LIMIT when no limit is given', async () => {
    const result = await run();
    const report = buildDebugReport(result, { root: '/repo', configSource: 'project.toml', config: cfg() });
    expect(report.entities.shown.length).toBeLessThanOrEqual(DEFAULT_DEBUG_LIMIT);
  });

  it('renders human text without throwing, and includes the omitted counts', async () => {
    const result = await run();
    const report = buildDebugReport(result, {
      root: '/repo',
      configSource: 'project.toml',
      config: cfg(),
      limit: 1,
    });
    const text = renderDebugReport(report);
    expect(text).toContain('index-repo');
    expect(text).toMatch(/entities \(showing 1 of \d+, \d+ omitted\)/);
  });
});

describe('compareGenerations — determinism check', () => {
  it('two identical runs compare equal, with no mismatches', async () => {
    const config = cfg();
    const { registry: r1 } = buildIndexAdapterRegistry(config);
    const { registry: r2 } = buildIndexAdapterRegistry(config);
    const items = [
      { kind: 'file' as const, path: 'src/a.ts', content: 'export function a() { return 1; }\n' },
    ];
    const first = await runIndexer(new FakeIndexSource(items), config, target(), { adapters: r1 });
    const second = await runIndexer(new FakeIndexSource(items), config, target(), { adapters: r2 });
    const check = compareGenerations(first, second);
    expect(check).toEqual({ ok: true, mismatches: [] });
  });

  it('detects a real content difference as a mismatch', async () => {
    const config = cfg();
    const { registry: r1 } = buildIndexAdapterRegistry(config);
    const { registry: r2 } = buildIndexAdapterRegistry(config);
    const first = await runIndexer(
      new FakeIndexSource([
        { kind: 'file', path: 'src/a.ts', content: 'export function a() { return 1; }\n' },
      ]),
      config,
      target(),
      { adapters: r1 },
    );
    const second = await runIndexer(
      new FakeIndexSource([
        { kind: 'file', path: 'src/a.ts', content: 'export function a() { return 2; }\n' },
      ]),
      config,
      target(),
      { adapters: r2 },
    );
    const check = compareGenerations(first, second);
    expect(check.ok).toBe(false);
    expect(check.mismatches.length).toBeGreaterThan(0);
  });

  it('ignores manifest.createdAt — two runs a clock-tick apart still compare equal', async () => {
    const config = cfg();
    const { registry: r1 } = buildIndexAdapterRegistry(config);
    const { registry: r2 } = buildIndexAdapterRegistry(config);
    const items = [
      { kind: 'file' as const, path: 'src/a.ts', content: 'export function a() { return 1; }\n' },
    ];
    const first = await runIndexer(new FakeIndexSource(items), config, target(), {
      adapters: r1,
      now: () => 1_000,
    });
    const second = await runIndexer(new FakeIndexSource(items), config, target(), {
      adapters: r2,
      now: () => 2_000,
    });
    expect(first.manifest.createdAt).not.toBe(second.manifest.createdAt);
    expect(compareGenerations(first, second)).toEqual({ ok: true, mismatches: [] });
  });
});
