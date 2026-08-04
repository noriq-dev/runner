import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowStore } from '../src/workflow-store';

const roots: string[] = [];

async function fixture(): Promise<{ repo: string; user: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noriq-workflows-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  const user = path.join(root, 'user-workflows');
  await Promise.all([mkdir(path.join(repo, '.noriq', 'workflows'), { recursive: true }), mkdir(user)]);
  return { repo, user };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('WorkflowStore (RUN-192)', () => {
  it('loads filename-named TOML and resolves prompt files beside their definition', async () => {
    const { repo, user } = await fixture();
    const dir = path.join(repo, '.noriq', 'workflows');
    await writeFile(path.join(dir, 'docs.toml'), 'base = "scope"\nprompt = { file = "docs.md" }\n');
    await writeFile(path.join(dir, 'docs.md'), 'Survey {{projectKey}}: {{brief}}');

    const catalog = await new WorkflowStore({ userDir: user }).current(repo, { workflows: {} });
    expect(catalog.definitions.docs).toMatchObject({
      base: 'scope',
      prompt: 'Survey {{projectKey}}: {{brief}}',
      promptSource: path.join(dir, 'docs.md'),
      tier: 'project-file',
    });
  });

  it('merges project file > inline project.toml > user by workflow name', async () => {
    const { repo, user } = await fixture();
    await writeFile(path.join(user, 'docs.toml'), 'base = "build"\nprompt = "user"\n');
    await writeFile(
      path.join(repo, '.noriq', 'workflows', 'docs.toml'),
      'base = "verify"\nprompt = "project-file"\n',
    );
    const catalog = await new WorkflowStore({ userDir: user }).current(repo, {
      workflows: { docs: { base: 'scope', prompt: 'manifest', stages: null, description: null } },
    });
    expect(catalog.definitions.docs).toMatchObject({ base: 'verify', prompt: 'project-file' });

    const withoutFile = await new WorkflowStore({
      userDir: user,
      list: async (dir) => (dir === user ? ['docs.toml'] : []),
    }).current(repo, {
      workflows: { docs: { base: 'scope', prompt: 'manifest', stages: null, description: null } },
    });
    expect(withoutFile.definitions.docs).toMatchObject({ base: 'scope', prompt: 'manifest' });
  });

  it('retains a declared description per tier and lets precedence replace it (RUN-195)', async () => {
    const { repo, user } = await fixture();
    await writeFile(
      path.join(user, 'docs.toml'),
      'base = "scope"\nprompt = "user"\ndescription = "user line"\n',
    );
    const userOnly = await new WorkflowStore({ userDir: user }).current(repo, { workflows: {} });
    expect(userOnly.definitions.docs).toMatchObject({ base: 'scope', description: 'user line' });

    // The winning tier's description replaces the shadowed one even when it declares NONE —
    // carrying the loser's line would describe a definition dispatch will not resolve.
    await writeFile(path.join(repo, '.noriq', 'workflows', 'docs.toml'), 'base = "verify"\n');
    const merged = await new WorkflowStore({ userDir: user }).current(repo, {
      workflows: { docs: { base: 'build', prompt: null, stages: null, description: 'manifest line' } },
    });
    expect(merged.definitions.docs).toMatchObject({ base: 'verify', description: null });
  });

  it('the inline manifest tier carries its description and a non-string file one degrades', async () => {
    const { repo, user } = await fixture();
    const catalog = await new WorkflowStore({ userDir: user }).current(repo, {
      workflows: { docs: { base: 'scope', prompt: null, stages: null, description: 'survey only' } },
    });
    expect(catalog.definitions.docs).toMatchObject({ base: 'scope', description: 'survey only' });

    // Cosmetic field, cosmetic failure: a wrong TYPE costs the line, never the declared posture.
    await writeFile(path.join(user, 'odd.toml'), 'base = "build"\ndescription = 7\n');
    const odd = await new WorkflowStore({ userDir: user }).current(repo, { workflows: {} });
    expect(odd.definitions.odd).toMatchObject({ base: 'build', description: null });
  });

  it('re-reads definition and prompt bytes on every dispatch snapshot', async () => {
    const { repo, user } = await fixture();
    const dir = path.join(repo, '.noriq', 'workflows');
    await writeFile(path.join(dir, 'docs.toml'), 'base = "scope"\nprompt = { file = "docs.md" }\n');
    await writeFile(path.join(dir, 'docs.md'), 'first');
    const store = new WorkflowStore({ userDir: user });
    const first = await store.current(repo, { workflows: {} });
    await writeFile(path.join(dir, 'docs.md'), 'second');
    const second = await store.current(repo, { workflows: {} });
    expect(first.definitions.docs?.prompt).toBe('first');
    expect(second.definitions.docs?.prompt).toBe('second');
  });

  it.each([
    ['parent traversal', '../../outside.md'],
    ['absolute path', '/etc/passwd'],
  ])('refuses a project prompt using %s while retaining its declared posture', async (_, hostile) => {
    const { repo, user } = await fixture();
    await writeFile(
      path.join(repo, '.noriq', 'workflows', 'audit.toml'),
      `base = "verify"\nprompt = { file = ${JSON.stringify(hostile)} }\n`,
    );
    const catalog = await new WorkflowStore({ userDir: user }).current(repo, { workflows: {} });
    expect(catalog.definitions.audit).toMatchObject({ base: 'verify', prompt: null });
  });

  it('refuses a prompt symlink and a symlinked parent that leave the repo', async () => {
    const { repo, user } = await fixture();
    const outside = path.join(path.dirname(repo), 'secret.md');
    const dir = path.join(repo, '.noriq', 'workflows');
    await writeFile(outside, 'secret');
    await symlink(outside, path.join(dir, 'link.md'));
    await symlink(path.dirname(repo), path.join(dir, 'outside'));
    await writeFile(path.join(dir, 'link.toml'), 'base = "scope"\nprompt = { file = "link.md" }\n');
    await writeFile(
      path.join(dir, 'parent.toml'),
      'base = "scope"\nprompt = { file = "outside/secret.md" }\n',
    );
    const catalog = await new WorkflowStore({ userDir: user }).current(repo, { workflows: {} });
    expect(catalog.definitions.link?.prompt).toBeNull();
    expect(catalog.definitions.parent?.prompt).toBeNull();
  });

  it('confines user prompt files to the user workflow directory, not the wider home', async () => {
    const { repo, user } = await fixture();
    const outside = path.join(path.dirname(user), 'operator-secret.md');
    await writeFile(outside, 'secret');
    await writeFile(
      path.join(user, 'private.toml'),
      'base = "scope"\nprompt = { file = "../operator-secret.md" }\n',
    );
    const catalog = await new WorkflowStore({ userDir: user }).current(repo, { workflows: {} });
    expect(catalog.definitions.private).toMatchObject({ base: 'scope', prompt: null });
  });

  it('a broken higher-precedence definition shadows a wider lower tier with scope', async () => {
    const { repo, user } = await fixture();
    await writeFile(path.join(user, 'safe.toml'), 'base = "build"\nprompt = "user"\n');
    await writeFile(path.join(repo, '.noriq', 'workflows', 'safe.toml'), 'this is not toml =');
    const catalog = await new WorkflowStore({ userDir: user }).current(repo, { workflows: {} });
    expect(catalog.definitions.safe).toMatchObject({ base: 'scope', prompt: null });
  });

  it('treats prototype-shaped filenames as data without mutating the catalog object', async () => {
    const { repo, user } = await fixture();
    await writeFile(path.join(user, '__proto__.toml'), 'base = "scope"\nprompt = "safe"\n');
    const catalog = await new WorkflowStore({ userDir: user }).current(repo, { workflows: {} });
    expect(Object.getPrototypeOf(catalog.definitions)).toBeNull();
    expect(catalog.definitions.__proto__).toMatchObject({ base: 'scope', prompt: 'safe' });
  });
});
