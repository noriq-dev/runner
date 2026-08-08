import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverRepos, loadIndexConfig, repoId } from '../src/discovery';

let root: string;

async function marker(dir: string, body: string) {
  await mkdir(path.join(dir, '.noriq'), { recursive: true });
  await writeFile(path.join(dir, '.noriq', 'project.toml'), body);
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'noriq-discovery-'));
  // repoA — valid, with a git HEAD → defaultBranch, and a board lock (RUN-71)
  await marker(path.join(root, 'repoA'), 'key = "AAA"\nboard = "Runner"\n');
  await mkdir(path.join(root, 'repoA', '.git'), { recursive: true });
  await writeFile(path.join(root, 'repoA', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  // repoB — valid, nested one level deeper (monorepo-style discovery)
  await marker(path.join(root, 'nested', 'repoB'), 'key = "BBB"\n');
  // repoC — invalid manifest (key too long) → skipped
  await marker(path.join(root, 'repoC'), 'key = "TOOLONGKEY"\n');
  // node_modules — never descended into
  await marker(path.join(root, 'node_modules', 'pkg'), 'key = "NM"\n');
}, 30000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('discoverRepos', () => {
  it('finds valid markers (incl. nested), reads default branch, skips invalid + node_modules', async () => {
    const repos = await discoverRepos([root]);
    const byKey = Object.fromEntries(repos.map((r) => [r.projectKey, r]));
    expect(Object.keys(byKey).sort()).toEqual(['AAA', 'BBB']); // not TOOLONGKEY, not NM
    const aaa = byKey.AAA;
    const bbb = byKey.BBB;
    expect(aaa?.name).toBe('repoA');
    expect(aaa?.defaultBranch).toBe('main');
    expect(bbb?.defaultBranch).toBeNull(); // no .git
    expect(aaa?.root).toBe(path.join(root, 'repoA'));
    // The board lock rides the manifest verbatim (RUN-71): a committed NAME the server
    // resolves at registration; absent = null = the project's default board.
    expect(aaa?.manifest.board).toBe('Runner');
    expect(bbb?.manifest.board).toBeNull();
    // RUN-208: a marker naming neither `repositoryKey` nor `[index]` reports both as null —
    // byte-identical to every manifest written before either existed.
    expect(aaa?.repositoryKey).toBeNull();
    expect(aaa?.indexConfig).toBeNull();
    expect(bbb?.repositoryKey).toBeNull();
    expect(bbb?.indexConfig).toBeNull();
  });

  it('gives a stable id per root path', () => {
    expect(repoId('/a/b/c')).toBe(repoId('/a/b/c'));
    expect(repoId('/a/b/c')).not.toBe(repoId('/a/b/d'));
    expect(repoId('/a/b/c')).toMatch(/^repo_[0-9a-f]{12}$/);
  });

  it('respects maxDepth', async () => {
    const shallow = await discoverRepos([root], { maxDepth: 0 });
    expect(shallow).toHaveLength(0); // markers are at depth >= 1
  });
});

describe('DiscoveredRepo.repositoryKey (RUN-208)', () => {
  it('validates a well-formed committed key', async () => {
    const dir = path.join(root, 'repoKeyOk');
    await marker(dir, 'key = "RKO"\nrepositoryKey = "runner-repo-ok"\n');
    const [repo] = await discoverRepos([dir]);
    expect(repo?.repositoryKey).toBe('runner-repo-ok');
  });

  // decision 6: a malformed key is a visible association failure, never a silent fallback to
  // `key`, the directory name, or `repoId()`.
  it.each(['ckt_abc123', '1bad', 'a/b'])(
    'reports null (never a fallback) for a malformed key %j',
    async (bad) => {
      const dir = path.join(root, `repoKeyBad-${bad.replace(/[^a-z0-9]/gi, '_')}`);
      await marker(dir, `key = "RKB"\nrepositoryKey = "${bad}"\n`);
      const [repo] = await discoverRepos([dir]);
      expect(repo?.repositoryKey).toBeNull();
      expect(repo?.repositoryKey).not.toBe(repo?.projectKey);
      expect(repo?.repositoryKey).not.toBe(repo?.name);
      expect(repo?.repositoryKey).not.toBe(repo?.id);
    },
  );
});

describe('DiscoveredRepo.indexConfig / loadIndexConfig (RUN-208)', () => {
  it('is off when [index] is absent, and off when present with `enabled` unset', async () => {
    const offDir = path.join(root, 'repoIndexOff');
    await marker(offDir, 'key = "IOF"\n[index]\ninclude = ["src/**"]\n');
    const [repo] = await discoverRepos([offDir]);
    expect(repo?.indexConfig).toBeNull();
  });

  it('resolves a valid enabled policy, merging vendored scope with the daemon knobs', async () => {
    const dir = path.join(root, 'repoIndexOn');
    await marker(
      dir,
      [
        'key = "ION"',
        '[index]',
        'enabled = true',
        'include = ["src/**"]',
        'exclude = ["**/*.gen.ts"]',
        'languages = ["typescript", "markdown"]',
        'contentMode = "metadata"',
        'maxFiles = 500',
        'maxFileBytes = 2000',
        'maxTotalBytes = 90000',
        'readDeadlineMs = 5000',
        'pollIntervalMinutes = 15',
      ].join('\n'),
    );
    const [repo] = await discoverRepos([dir]);
    expect(repo?.indexConfig).toEqual({
      include: ['src/**'],
      exclude: ['**/*.gen.ts'],
      languages: ['typescript', 'markdown'],
      contentMode: 'metadata',
      maxFiles: 500,
      maxFileBytes: 2000,
      maxTotalBytes: 90000,
      readDeadlineMs: 5000,
      pollIntervalMinutes: 15,
    });
  });

  it('refuses (not the repo) on an invalid bound, an unknown key, and an escaping glob', async () => {
    const boundDir = path.join(root, 'repoIndexBadBound');
    await marker(boundDir, 'key = "IBB"\n[index]\nenabled = true\nmaxFileBytes = -1\n');
    const badBound = await discoverRepos([boundDir]);
    expect(badBound).toHaveLength(1); // still discovered and dispatchable
    expect(badBound[0]?.indexConfig).toBeNull();

    const typoDir = path.join(root, 'repoIndexTypo');
    await marker(typoDir, 'key = "ITY"\n[index]\nenabled = true\nmaxFileByte = 5\n'); // typo'd key
    const typo = await discoverRepos([typoDir]);
    expect(typo[0]?.indexConfig).toBeNull();

    const globDir = path.join(root, 'repoIndexGlob');
    await marker(globDir, 'key = "IGL"\n[index]\nenabled = true\ninclude = ["../../etc/**"]\n');
    const glob = await discoverRepos([globDir]);
    expect(glob[0]?.indexConfig).toBeNull();
  });

  it('re-reads fresh off disk, no restart needed', async () => {
    const dir = path.join(root, 'repoIndexReread');
    await marker(dir, 'key = "IRR"\n[index]\nenabled = true\n');
    expect((await loadIndexConfig(dir))?.pollIntervalMinutes).toBe(60); // schema default
    await marker(dir, 'key = "IRR"\n[index]\nenabled = true\npollIntervalMinutes = 5\n');
    expect((await loadIndexConfig(dir))?.pollIntervalMinutes).toBe(5); // the edit took effect
    await marker(dir, 'key = "IRR"\n[index]\nenabled = false\n');
    expect(await loadIndexConfig(dir)).toBeNull(); // turning it off takes effect too
  });
});
