import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildIndexRepoReport,
  checkIndexRepoDeterminism,
  resolveIndexRepoConfig,
  runIndexRepo,
} from '../src/index-repo';
import { buildIndexRepoFixture } from './fixtures/index-repo-fixtures';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'noriq-index-repo-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeManifest(root: string, extra = ''): Promise<void> {
  await mkdir(path.join(root, '.noriq'), { recursive: true });
  await writeFile(
    path.join(root, '.noriq', 'project.toml'),
    `key = "FIX"\n\n[index]\nenabled = true\n${extra}`,
  );
}

describe('resolveIndexRepoConfig — respects [index].enabled by default (locked decision 8)', () => {
  it('no manifest at all: refused without --force', async () => {
    expect(await resolveIndexRepoConfig(dir, false)).toBeNull();
  });

  it('no manifest at all: --force falls back to the schema default policy', async () => {
    const resolved = await resolveIndexRepoConfig(dir, true);
    expect(resolved?.source).toBe('forced-default');
    expect(resolved?.config.contentMode).toBe('full');
  });

  it('a manifest with [index].enabled = false is refused, even with a present [index] table', async () => {
    await mkdir(path.join(dir, '.noriq'), { recursive: true });
    await writeFile(path.join(dir, '.noriq', 'project.toml'), 'key = "FIX"\n\n[index]\nenabled = false\n');
    expect(await resolveIndexRepoConfig(dir, false)).toBeNull();
  });

  it('a manifest with [index].enabled = true is honoured as the real config source', async () => {
    await writeManifest(dir);
    const resolved = await resolveIndexRepoConfig(dir, false);
    expect(resolved?.source).toBe('project.toml');
  });
});

describe('runIndexRepo — end to end over a real filesystem fixture', () => {
  it('refuses (returns null) when indexing is off and --force is not given', async () => {
    await buildIndexRepoFixture(dir);
    expect(await runIndexRepo({ root: dir })).toBeNull();
  });

  it('indexes the monorepo layout: every package’s file AND symbol entities exist', async () => {
    const fixture = await buildIndexRepoFixture(dir);
    const run = await runIndexRepo({ root: dir, force: true });
    expect(run).not.toBeNull();
    const uris = run!.result.records
      .map((r) => (r.kind === 'node' ? r.uri : null))
      .filter(Boolean) as string[];
    for (const relPath of fixture.monorepo) {
      expect(uris.some((u) => u.includes(encodeURIComponent(relPath)) || u.includes(relPath))).toBe(true);
    }
    const labels = run!.result.records
      .filter((r) => r.kind === 'node' && r.type === 'symbol')
      .map((r) => (r as { label: string }).label);
    expect(labels).toContain('alphaGreet');
    expect(labels).toContain('betaGreet');
  });

  it('the generated tree (dist/) is indexed too — there is no default exclude list (a known, deferred gap)', async () => {
    await buildIndexRepoFixture(dir);
    const run = await runIndexRepo({ root: dir, force: true });
    const fileUris = run!.result.records.filter((r) => r.kind === 'node' && r.type === 'file');
    expect(fileUris.some((r) => (r as { uri: string }).uri.includes('dist'))).toBe(true);
    const symbolLabels = run!.result.records
      .filter((r) => r.kind === 'node' && r.type === 'symbol')
      .map((r) => (r as { label: string }).label);
    expect(symbolLabels).toContain('generatedEntry');
  });

  it('an oversize file is reported too-large, never silently dropped', async () => {
    await buildIndexRepoFixture(dir);
    const run = await runIndexRepo({ root: dir, force: true });
    const reasons = run!.result.scanStatuses.map((s) => s.reason);
    expect(reasons).toContain('too-large');
  });

  it('the symlink is handled exactly as index-scan/index-source already handle it (locked decision 12 — observed, not changed)', async () => {
    const fixture = await buildIndexRepoFixture(dir);
    const run = await runIndexRepo({ root: dir, force: true });
    const linkUri = run!.result.records.find(
      (r) =>
        r.kind === 'node' && r.type === 'file' && (r as { uri: string }).uri.includes(fixture.symlinkLink),
    );
    const linkStatus = run!.result.scanStatuses.find((s) => s.path === fixture.symlinkLink);
    // One of the two must be true: the symlink resolved to a real in-root file and got indexed
    // like any other leaf (`walkFs`'s own doc — a symlink is always a single leaf candidate, and
    // `openConfined` decides its fate at `read()`), or it was refused with a named, bounded status.
    // Either is the SCANNER's existing behaviour; this test only pins down which one it is today.
    expect(Boolean(linkUri) || Boolean(linkStatus)).toBe(true);
  });

  it('mixed line endings: a CRLF file and its LF twin declare the same symbol, and neither URI nor label carries a \\r', async () => {
    const fixture = await buildIndexRepoFixture(dir);
    const run = await runIndexRepo({ root: dir, force: true });
    const symbols = run!.result.records.filter((r) => r.kind === 'node' && r.type === 'symbol') as {
      uri: string;
      label: string;
    }[];
    const crlfSymbol = symbols.find((s) => s.uri.includes(fixture.crlfFile));
    const lfSymbol = symbols.find((s) => s.uri.includes(fixture.lfFile));
    expect(crlfSymbol).toBeDefined();
    expect(lfSymbol).toBeDefined();
    expect(crlfSymbol!.label).toBe('lineEndingProbe');
    expect(lfSymbol!.label).toBe('lineEndingProbe');
    // The `name` fragment (after `#`) is identical between the two — only the file path differs.
    const fragment = (uri: string) => uri.split('#')[1];
    expect(fragment(crlfSymbol!.uri)).toBe(fragment(lfSymbol!.uri));
    for (const s of [crlfSymbol!, lfSymbol!]) {
      expect(s.uri).not.toContain('\r');
      expect(s.label).not.toContain('\r');
    }
  });

  it('the [index].languages gate: markdown-only still yields the file entity for a .ts file but no symbols under it', async () => {
    await writeManifest(dir, 'languages = ["markdown"]\n');
    await buildIndexRepoFixture(dir);
    const run = await runIndexRepo({ root: dir });
    expect(run).not.toBeNull();
    const alphaPath = run!.result.records.filter((r) => r.kind === 'node');
    const fileEntity = alphaPath.find(
      (r) => r.type === 'file' && (r as { uri: string }).uri.includes('alpha'),
    );
    expect(fileEntity).toBeDefined();
    const alphaSymbol = alphaPath.find(
      (r) => r.type === 'symbol' && (r as { label: string }).label === 'alphaGreet',
    );
    expect(alphaSymbol).toBeUndefined();
    // Markdown itself IS still gated in — its own heading entity should exist.
    const markdownHeading = alphaPath.find(
      (r) => r.type === 'symbol' && (r as { label: string }).label === 'Notes',
    );
    expect(markdownHeading).toBeDefined();
  });

  it('the default languages set yields symbols for the same .ts file', async () => {
    await writeManifest(dir);
    await buildIndexRepoFixture(dir);
    const run = await runIndexRepo({ root: dir });
    const alphaSymbol = run!.result.records.find(
      (r) => r.kind === 'node' && r.type === 'symbol' && (r as { label: string }).label === 'alphaGreet',
    );
    expect(alphaSymbol).toBeDefined();
  });
});

describe('checkIndexRepoDeterminism — "validate deterministic output" (task acceptance)', () => {
  it('two runs over an unchanged fixture tree produce byte-identical canonical output', async () => {
    await buildIndexRepoFixture(dir);
    const check = await checkIndexRepoDeterminism({ root: dir, force: true });
    expect(check).toEqual({ ok: true, mismatches: [] });
  });

  it('returns null when indexing is refused (nothing to compare)', async () => {
    await buildIndexRepoFixture(dir);
    expect(await checkIndexRepoDeterminism({ root: dir })).toBeNull();
  });
});

describe('buildIndexRepoReport — the report over a real run', () => {
  it('produces a bounded, non-throwing report', async () => {
    await buildIndexRepoFixture(dir);
    const run = await runIndexRepo({ root: dir, force: true });
    const report = await buildIndexRepoReport(run!, { limit: 5 });
    expect(report.entities.shown.length).toBeLessThanOrEqual(5);
    expect(report.root).toBe(run!.root);
  });
});
