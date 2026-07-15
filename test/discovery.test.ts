import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverRepos, repoId } from '../src/discovery';

let root: string;

async function marker(dir: string, body: string) {
  await mkdir(path.join(dir, '.noriq'), { recursive: true });
  await writeFile(path.join(dir, '.noriq', 'project.toml'), body);
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'noriq-discovery-'));
  // repoA — valid, with a git HEAD → defaultBranch
  await marker(path.join(root, 'repoA'), 'key = "AAA"\n');
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
