import { readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DvBlobHttp } from '../src/vcs/diversion';
import { DiversionBackend, realDvBlobHttp, realDvHttp } from '../src/vcs/diversion';
import { DiversionIndexSource } from '../src/vcs/diversion-index-source';

/**
 * RUN-255's opt-in live suite: everything above (`test/vcs-diversion.test.ts`) drives the
 * INJECTED transports against fixtures captured verbatim from this exact account, so `npm run
 * check` stays hermetic. This file re-runs the same claims against the REAL API, to catch the
 * fixtures drifting out from under the live shape — it is not where the design gets proven.
 *
 * Skips (does not fail) with no credential present, per the task: a missing
 * `~/.diversion/credentials/dv.u.*` file is an ordinary state for CI and any machine that has
 * never run `dv login`, not a broken test. It does NOT handle an EXPIRED credential specially —
 * the task only asked for "skips without a credential"; a present-but-expired token fails loudly
 * instead (the failure message names the fix: run `dv repo` to restart the sync agent).
 *
 * The repo id below is the specific account this was measured against (2026-08-09, dv CLI
 * v1.0.1017, ~7259 files, default branch `main` at `dv.commit.473`) — hardcoded because a live
 * suite has to point SOMEWHERE, and this is the repo RUN-255's own instructions named as
 * available. It has no meaning outside that one account and skips harmlessly everywhere else.
 */

const REPO_ID = 'dv.repo.e821a7a1-382e-4466-a906-61a2b19694f1';

function hasStoredCredential(): boolean {
  try {
    const dir = path.join(os.homedir(), '.diversion', 'credentials');
    return readdirSync(dir).some((e) => e.startsWith('dv.u.'));
  } catch {
    return false;
  }
}

describe.skipIf(!hasStoredCredential())('DiversionBackend/DiversionIndexSource — live (RUN-255)', () => {
  const http = realDvHttp();
  const blobHttp = realDvBlobHttp();
  const backend = new DiversionBackend({ repoId: REPO_ID, http, blobHttp });

  it('leaseIndexSnapshot returns a real, usable snapshot — never unsupported', async () => {
    const res = await backend.leaseIndexSnapshot('/unused');
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(`expected ok, got refusal: ${res.reason} ${res.detail ?? ''}`);
    expect(res.snapshot.source.kind).toBe('diversion');
    expect(res.snapshot.readOnly).toBe(true);
    // RUN-281: `localPath` now echoes back whatever root was offered (never a materialized tree —
    // this backend still checks out nothing to produce it), the SAME string wired into the
    // `DiversionIndexSource` constructor as its verify-then-read candidate root.
    expect(res.snapshot.localPath).toBe('/unused');
    expect(res.snapshot.baseId).toMatch(/^dv\.commit\./);
    await backend.releaseIndexSnapshot(res.snapshot);
  }, 30_000);

  it('verify-then-read (RUN-281): local bytes matching the REAL depot digest are used with ZERO content HTTP calls', async () => {
    const res = await backend.leaseIndexSnapshot('/unused');
    if (!res.ok) throw new Error('snapshot unavailable');
    const localRoot = await mkdtemp(path.join(os.tmpdir(), 'noriq-dv-live-verify-'));
    try {
      // Seed a local file with the REAL bytes this real commit has at a known real path, fetched
      // once over the real API — the exact "already checked out, happens to be current" case the
      // fast path exists for.
      const outcome = await res.snapshot.source.read('.dvignore', 1_000_000);
      if (!outcome.ok) throw new Error('seed read failed');
      await writeFile(path.join(localRoot, '.dvignore'), outcome.bytes);

      // A transport that FAILS the test outright if the fast path falls through to it.
      const failingBlobHttp: DvBlobHttp = async (_repoId, _refId, filePath) => {
        throw new Error(`verify-then-read must not fetch content over HTTP for ${filePath}`);
      };
      const verifiedSource = new DiversionIndexSource(
        REPO_ID,
        res.snapshot.baseId,
        http,
        failingBlobHttp,
        localRoot,
      );
      for await (const item of verifiedSource.list()) {
        if (item.kind === 'file' && item.entry.path === '.dvignore') break; // digest cached now.
      }
      const verified = await verifiedSource.read('.dvignore', 1_000_000);
      expect(verified).toEqual({ ok: true, bytes: outcome.bytes, overLimit: false });
    } finally {
      await rm(localRoot, { recursive: true, force: true });
      await backend.releaseIndexSnapshot(res.snapshot);
    }
  }, 30_000);

  it('list() enumerates real files in ascending order, never a directory', async () => {
    const res = await backend.leaseIndexSnapshot('/unused');
    if (!res.ok) throw new Error('snapshot unavailable');
    try {
      const paths: string[] = [];
      let count = 0;
      for await (const item of res.snapshot.source.list()) {
        if (item.kind === 'file') paths.push(item.entry.path);
        count += 1;
        if (count >= 50) break; // a live smoke check, not a full-tree drain.
      }
      expect(paths.length).toBeGreaterThan(0);
      const sorted = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      expect(paths).toEqual(sorted);
      // A known real file from the measured tree (module doc / this task's own fixtures).
      expect(paths).toContain('.dvignore');
    } finally {
      await backend.releaseIndexSnapshot(res.snapshot);
    }
  }, 30_000);

  it('read() fetches real content matching the listed size', async () => {
    const source = new DiversionIndexSource(REPO_ID, 'dv.commit.473', http, blobHttp);
    const outcome = await source.read('.dvignore', 1_000_000);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('read failed');
    expect(outcome.overLimit).toBe(false);
    expect(outcome.bytes.length).toBeGreaterThan(0);
    expect(outcome.bytes.toString('utf8')).toContain(
      'Ignore files installed by popular game development frameworks',
    );
  }, 30_000);

  it('changesBetween reports a real, measured modification between two adjacent commits', async () => {
    const res = await backend.changesBetween('/unused', 'dv.commit.472', 'dv.commit.473');
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(`expected ok, got: ${res.reason} ${res.detail}`);
    expect(res.changed).toContain(
      'Plugins/NodCharacterCreator/Source/NodCoreTechRuntime/Private/NodRuntimeGarmentFitEvaluator.cpp',
    );
    expect(res.deleted).toEqual([]);
  }, 30_000);

  it('changesBetween decomposes a real detected rename: old path deleted, new path changed', async () => {
    const res = await backend.changesBetween('/unused', 'dv.commit.7', 'dv.commit.8');
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(`expected ok, got: ${res.reason} ${res.detail}`);
    expect(res.changed).toContain('Plugins/NodEcs/Source/NodEcs/Public/Entity/EcsEntityHandle.h');
    expect(res.deleted).toContain('Plugins/NodEcs/Source/NodEcs/Public/Entity/EntityHandle.h');
  }, 30_000);
});
