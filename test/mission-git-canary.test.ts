import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { runGitMissionCanary } from '../scripts/git-mission-canary';

const execFileP = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('reviewed Git mission canary', () => {
  it('drives planning, build, review, bounded repair, cleanup, and accepted-ref handoff', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noriq-git-canary-test-'));
    roots.push(root);
    const repositoryRoot = path.join(root, 'source');
    await execFileP('git', ['init', '--quiet', '--initial-branch=main', repositoryRoot]);
    await writeFile(path.join(repositoryRoot, 'README.md'), '# canary fixture\n', 'utf8');
    await execFileP('git', ['-C', repositoryRoot, 'add', 'README.md']);
    await execFileP('git', [
      '-C',
      repositoryRoot,
      '-c',
      'user.name=Noriq Test',
      '-c',
      'user.email=test@noriq.local',
      'commit',
      '--quiet',
      '-m',
      'base',
    ]);

    const result = await runGitMissionCanary({
      repositoryKey: 'canary-fixture',
      repositoryRoot,
    });

    expect(result).toMatchObject({
      repositoryKey: 'canary-fixture',
      status: 'succeeded',
      guideTurns: 3,
      childRoles: ['planner', 'builder', 'reviewer', 'builder', 'reviewer'],
      reviewVerdicts: ['changes-requested:low', 'passed:none'],
      repairRounds: 1,
      usage: { tokens: 240, usd: 0, activeSeconds: expect.any(Number) },
      acceptedFile: 'status=accepted\nrepository=canary-fixture\nphase=repair',
    });
    expect(result.usage.activeSeconds).toBeGreaterThanOrEqual(0.12);
    expect(result.usage.activeSeconds).toBeLessThan(5);
    expect(result.acceptedRevision).toMatch(/^[a-f0-9]{40,64}$/);
    expect(result.acceptedReference).toMatch(/^noriq\/run\//);
  });
});
