import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { GitBackend } from '../src/vcs/git';
import { hasMissionVcsEvidence } from '../src/vcs/types';
import { type GitRunner, WorktreeManager } from '../src/worktree';

const execFileP = promisify(execFile);
const git = (args: string[], cwd: string) => execFileP('git', args, { cwd });

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noriq-mission-git-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  const worktrees = path.join(root, 'worktrees');
  await execFileP('git', ['init', '-q', '-b', 'main', repo]);
  await writeFile(path.join(repo, 'README.md'), '# exact evidence\n');
  await git(['-c', 'user.email=t@t', '-c', 'user.name=T', 'add', '.'], repo);
  await git(['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '-m', 'base'], repo);
  const backend = new GitBackend(new WorktreeManager({ baseDir: worktrees }));
  return { repo, backend };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Git mission VCS evidence (real Git)', () => {
  it('inspects exact HEAD and distinguishes dirty workspace state', async () => {
    const { repo, backend } = await fixture();
    expect(hasMissionVcsEvidence(backend)).toBe(true);
    const ws = await backend.lease(repo, 'inspect');

    expect(await backend.inspectWorkspace(ws)).toEqual({ revisionId: ws.baseId, clean: true });
    await writeFile(path.join(ws.localPath, 'feature.ts'), 'export const feature = true;\n');
    expect(await backend.inspectWorkspace(ws)).toEqual({ revisionId: ws.baseId, clean: false });

    await backend.dispose(ws);
  });

  it('returns coherent before/after evidence and a stable no-op checkpoint', async () => {
    const { repo, backend } = await fixture();
    const ws = await backend.lease(repo, 'checkpoint');
    await writeFile(path.join(ws.localPath, 'feature.ts'), 'export const feature = true;\n');

    const first = await backend.checkpointExact(ws, 'mission: save feature', {
      expectedParentRevisionId: ws.baseId,
    });
    expect(first).toMatchObject({
      beforeRevisionId: ws.baseId,
      changed: true,
      clean: true,
    });
    expect(first.revisionId).toMatch(/^[0-9a-f]{40}$/);
    expect(first.revisionId).not.toBe(first.beforeRevisionId);
    expect(await backend.inspectWorkspace(ws)).toEqual({ revisionId: first.revisionId, clean: true });

    expect(
      await backend.checkpointExact(ws, 'mission: no-op', {
        expectedParentRevisionId: first.revisionId,
      }),
    ).toEqual({
      beforeRevisionId: first.revisionId,
      revisionId: first.revisionId,
      changed: false,
      clean: true,
    });

    await backend.dispose(ws);
  });

  it('counts agent-created commits from the pinned parent and rejects rewound history', async () => {
    const { repo, backend } = await fixture();
    const ws = await backend.lease(repo, 'agent-commit');
    await writeFile(path.join(ws.localPath, 'agent.ts'), 'export const agent = true;\n');
    await git(['-c', 'user.email=a@a', '-c', 'user.name=Agent', 'add', '.'], ws.localPath);
    await git(
      ['-c', 'user.email=a@a', '-c', 'user.name=Agent', 'commit', '-q', '-m', 'agent commit'],
      ws.localPath,
    );
    const agentRevision = (await git(['rev-parse', 'HEAD'], ws.localPath)).stdout.trim();

    expect(
      await backend.checkpointExact(ws, 'runner sees agent commit', {
        expectedParentRevisionId: ws.baseId,
      }),
    ).toEqual({
      beforeRevisionId: agentRevision,
      revisionId: agentRevision,
      changed: true,
      clean: true,
    });

    await git(['reset', '--hard', ws.baseId], ws.localPath);
    await expect(
      backend.checkpointExact(ws, 'rewind must fail', {
        expectedParentRevisionId: agentRevision,
      }),
    ).rejects.toThrow(/not a proven ancestor/);
    await backend.dispose(ws);
  });

  it('rejects an unrelated replacement history even when its tree is clean', async () => {
    const { repo, backend } = await fixture();
    const ws = await backend.lease(repo, 'foreign-history');
    const tree = (await git(['rev-parse', 'HEAD^{tree}'], ws.localPath)).stdout.trim();
    const unrelated = (
      await git(
        ['-c', 'user.email=a@a', '-c', 'user.name=Agent', 'commit-tree', tree, '-m', 'unrelated'],
        ws.localPath,
      )
    ).stdout.trim();
    await git(['reset', '--hard', unrelated], ws.localPath);

    await expect(
      backend.checkpointExact(ws, 'unrelated must fail', {
        expectedParentRevisionId: ws.baseId,
      }),
    ).rejects.toThrow(/not a proven ancestor/);
    await backend.dispose(ws);
  });

  it('quarantines dirty and divergent residue before restoring a reusable workspace', async () => {
    const { repo, backend } = await fixture();
    const ws = await backend.lease(repo, 'reconcile');
    await writeFile(path.join(ws.localPath, 'committed.ts'), 'committed residue\n');
    const divergent = await backend.checkpointExact(ws, 'failed child commit', {
      expectedParentRevisionId: ws.baseId,
    });
    await writeFile(path.join(ws.localPath, 'loose.ts'), 'loose residue\n');

    const options = {
      expectedRevisionId: ws.baseId,
      quarantineId: 'attempt:failed:1',
      message: 'Quarantine failed child attempt 1.',
    };
    const reconciled = await backend.reconcileWorkspace(ws, options);
    expect(reconciled).toMatchObject({
      revisionId: ws.baseId,
      clean: true,
      disposition: 'quarantined',
    });
    if (reconciled.disposition !== 'quarantined') throw new Error('expected quarantine evidence');
    expect(reconciled.quarantineRef).toMatch(/^refs\/noriq\/quarantine\/[0-9a-f]{24}\/[0-9a-f]{32}$/);
    expect((await git(['show', `${reconciled.quarantineRef}:loose.ts`], repo)).stdout).toBe(
      'loose residue\n',
    );
    await expect(
      git(['merge-base', '--is-ancestor', divergent.revisionId, reconciled.quarantineRevisionId], repo),
    ).resolves.toBeDefined();
    expect(await backend.inspectWorkspace(ws)).toEqual({ revisionId: ws.baseId, clean: true });

    // A restart/retry with the same stable quarantine id returns the same durable evidence.
    expect(await backend.reconcileWorkspace(ws, options)).toEqual(reconciled);
    await backend.dispose(ws);
  });

  it('resumes restoration after owner death leaves a partial tree behind a durable quarantine', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noriq-mission-git-partial-restore-'));
    roots.push(root);
    const repo = path.join(root, 'repo');
    const worktrees = path.join(root, 'worktrees');
    await execFileP('git', ['init', '-q', '-b', 'main', repo]);
    await writeFile(path.join(repo, 'README.md'), '# exact evidence\n');
    await git(['-c', 'user.email=t@t', '-c', 'user.name=T', 'add', '.'], repo);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '-m', 'base'], repo);

    let injectOwnerDeath = true;
    const crashDuringRestore: GitRunner = async (args, cwd, stdin) => {
      if (stdin !== undefined) throw new Error('test Git runner did not expect stdin');
      const result = await execFileP('git', args, { cwd });
      if (injectOwnerDeath && args.includes('checkout') && args.includes('--force') && args.includes('-B')) {
        injectOwnerDeath = false;
        await writeFile(path.join(cwd, 'partial-restoration.txt'), 'left after checkout\n');
        throw new Error('injected owner death during restoration');
      }
      return result;
    };
    const backend = new GitBackend(new WorktreeManager({ baseDir: worktrees, git: crashDuringRestore }));
    const ws = await backend.lease(repo, 'partial-restore');
    await writeFile(path.join(ws.localPath, 'failed-work.ts'), 'preserve this residue\n');
    const options = {
      expectedRevisionId: ws.baseId,
      quarantineId: 'attempt:partial-restore:1',
      message: 'Quarantine before interrupted restoration.',
    };

    await expect(backend.reconcileWorkspace(ws, options)).rejects.toThrow(
      /injected owner death during restoration/,
    );
    expect(existsSync(path.join(ws.localPath, 'partial-restoration.txt'))).toBe(true);

    const reconciled = await backend.reconcileWorkspace(ws, options);
    expect(reconciled).toMatchObject({
      revisionId: ws.baseId,
      clean: true,
      disposition: 'quarantined',
    });
    if (reconciled.disposition !== 'quarantined') throw new Error('expected quarantine evidence');
    expect((await git(['show', `${reconciled.quarantineRef}:failed-work.ts`], repo)).stdout).toBe(
      'preserve this residue\n',
    );
    expect(existsSync(path.join(ws.localPath, 'partial-restoration.txt'))).toBe(false);
    expect(await backend.inspectWorkspace(ws)).toEqual({ revisionId: ws.baseId, clean: true });

    await backend.dispose(ws);
  });

  it('discards ignored residue from a failed writer instead of exposing it to the next child', async () => {
    const { repo, backend } = await fixture();
    const ws = await backend.lease(repo, 'ignored-residue');
    await writeFile(path.join(ws.localPath, '.gitignore'), 'generated-secret\n');
    const checkpoint = await backend.checkpointExact(ws, 'mission: record ignore policy', {
      expectedParentRevisionId: ws.baseId,
    });
    const ignoredPath = path.join(ws.localPath, 'generated-secret');
    await writeFile(ignoredPath, 'child-controlled residue\n');

    expect(existsSync(ignoredPath)).toBe(true);
    expect(
      await backend.reconcileWorkspace(ws, {
        expectedRevisionId: checkpoint.revisionId,
        quarantineId: 'attempt:ignored:1',
        message: 'Discard ignored failed-child residue.',
      }),
    ).toEqual({ revisionId: checkpoint.revisionId, clean: true, disposition: 'restored' });
    expect(existsSync(ignoredPath)).toBe(false);

    await backend.dispose(ws);
  });

  it('returns restored without manufacturing a quarantine for an unchanged clean workspace', async () => {
    const { repo, backend } = await fixture();
    const ws = await backend.lease(repo, 'already-clean');
    expect(
      await backend.reconcileWorkspace(ws, {
        expectedRevisionId: ws.baseId,
        quarantineId: 'attempt:clean:1',
        message: 'No residue expected.',
      }),
    ).toEqual({ revisionId: ws.baseId, clean: true, disposition: 'restored' });
    await backend.dispose(ws);
  });

  it('removes the checkout but preserves the accepted branch at the exact revision', async () => {
    const { repo, backend } = await fixture();
    const ws = await backend.lease(repo, 'accepted');
    await writeFile(path.join(ws.localPath, 'accepted.ts'), 'export const accepted = true;\n');
    const checkpoint = await backend.checkpointExact(ws, 'mission: accepted work', {
      expectedParentRevisionId: ws.baseId,
    });

    await backend.releaseWorkspace(ws, { preserveRevisionId: checkpoint.revisionId });
    expect(existsSync(ws.localPath)).toBe(false);
    const preserved = await git(['show-ref', '--verify', '--hash', `refs/heads/${ws.workRef}`], repo);
    expect(preserved.stdout.trim()).toBe(checkpoint.revisionId);

    // Idempotency is conditional on the durable evidence still being present and exact.
    await expect(
      backend.releaseWorkspace(ws, { preserveRevisionId: checkpoint.revisionId }),
    ).resolves.toBeUndefined();
  });

  it('fails closed on a wrong revision or dirty release and leaves the only worktree intact', async () => {
    const { repo, backend } = await fixture();
    const ws = await backend.lease(repo, 'refuse-release');

    await expect(backend.releaseWorkspace(ws, { preserveRevisionId: 'f'.repeat(40) })).rejects.toThrow(
      /expected preserved revision/,
    );
    expect(existsSync(ws.localPath)).toBe(true);

    await writeFile(path.join(ws.localPath, 'unsaved.ts'), 'not durable\n');
    await expect(backend.releaseWorkspace(ws, { preserveRevisionId: ws.baseId })).rejects.toThrow(
      /uncheckpointed changes/,
    );
    expect(existsSync(ws.localPath)).toBe(true);

    await backend.dispose(ws);
  });

  it('rejects a Git operation-in-progress instead of checkpointing an ambiguous merge', async () => {
    const { repo, backend } = await fixture();
    await git(['branch', 'side'], repo);
    await git(['checkout', '-q', 'side'], repo);
    await writeFile(path.join(repo, 'side.ts'), 'export const side = true;\n');
    await git(['-c', 'user.email=t@t', '-c', 'user.name=T', 'add', '.'], repo);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '-m', 'side'], repo);
    await git(['checkout', '-q', 'main'], repo);

    const ws = await backend.lease(repo, 'merge-state');
    await writeFile(path.join(ws.localPath, 'mission.ts'), 'export const mission = true;\n');
    const missionCheckpoint = await backend.checkpointExact(ws, 'mission: divergent commit', {
      expectedParentRevisionId: ws.baseId,
    });
    await git(['merge', '--no-commit', 'side'], ws.localPath);

    await expect(backend.inspectWorkspace(ws)).rejects.toThrow(/MERGE_HEAD/);
    await expect(
      backend.checkpointExact(ws, 'must not finish merge', {
        expectedParentRevisionId: missionCheckpoint.revisionId,
      }),
    ).rejects.toThrow(/MERGE_HEAD/);

    const reconciled = await backend.reconcileWorkspace(ws, {
      expectedRevisionId: missionCheckpoint.revisionId,
      quarantineId: 'attempt:merge:1',
      message: 'Quarantine interrupted merge.',
    });
    expect(reconciled).toMatchObject({
      revisionId: missionCheckpoint.revisionId,
      clean: true,
      disposition: 'quarantined',
    });
    expect(await backend.inspectWorkspace(ws)).toEqual({
      revisionId: missionCheckpoint.revisionId,
      clean: true,
    });
    await backend.dispose(ws);
  });

  it('requires the preserved branch to keep naming the accepted revision on every release', async () => {
    const { repo, backend } = await fixture();
    const ws = await backend.lease(repo, 'moved-after-release');
    await writeFile(path.join(ws.localPath, 'accepted.ts'), 'accepted\n');
    const checkpoint = await backend.checkpointExact(ws, 'mission: accepted', {
      expectedParentRevisionId: ws.baseId,
    });
    await backend.releaseWorkspace(ws, { preserveRevisionId: checkpoint.revisionId });

    await git(['branch', '--force', ws.workRef, 'main'], repo);
    await expect(backend.releaseWorkspace(ws, { preserveRevisionId: checkpoint.revisionId })).rejects.toThrow(
      /expected preserved revision/,
    );
  });
});
