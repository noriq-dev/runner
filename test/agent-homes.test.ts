import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type InteractiveSpawn, ensurePrivateAgentHome, loginClaude, loginCodex } from '../src/agent-homes';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'noriq-agent-home-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Runner-specific agent homes', () => {
  it.skipIf(process.platform === 'win32')(
    'creates a private directory and tightens an existing broad mode',
    async () => {
      const root = await tempDir();
      const home = path.join(root, 'codex');
      await mkdir(home, { mode: 0o755 });

      ensurePrivateAgentHome(home);

      expect((await stat(home)).mode & 0o777).toBe(0o700);
    },
  );

  it.skipIf(process.platform === 'win32')('rejects a direct symlink instead of following it', async () => {
    const root = await tempDir();
    const target = path.join(root, 'operator-codex');
    const home = path.join(root, 'runner-codex');
    await mkdir(target);
    await symlink(target, home);

    expect(() => ensurePrivateAgentHome(home)).toThrow(/must not be a symlink/);
  });

  it('runs codex login with only the Runner-specific CODEX_HOME selected', async () => {
    const root = await tempDir();
    const home = path.join(root, 'codex');
    let seen:
      | { command: string; args: string[]; options: { env: NodeJS.ProcessEnv; stdio: 'inherit' } }
      | undefined;
    const spawnFn: InteractiveSpawn = (command, args, options) => {
      seen = { command, args, options };
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child as unknown as ReturnType<InteractiveSpawn>;
    };

    await loginCodex({ home, env: { CODEX_HOME: '/operator/global' }, spawnFn });

    expect(seen).toEqual({
      command: 'codex',
      args: ['login'],
      options: { env: { CODEX_HOME: home }, stdio: 'inherit' },
    });
    if (process.platform !== 'win32') expect((await stat(home)).mode & 0o777).toBe(0o700);
  });

  it('runs claude auth login with only the Runner-specific CLAUDE_CONFIG_DIR selected', async () => {
    const root = await tempDir();
    const home = path.join(root, 'claude');
    let seen:
      | { command: string; args: string[]; options: { env: NodeJS.ProcessEnv; stdio: 'inherit' } }
      | undefined;
    const spawnFn: InteractiveSpawn = (command, args, options) => {
      seen = { command, args, options };
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child as unknown as ReturnType<InteractiveSpawn>;
    };

    await loginClaude({ home, env: { CLAUDE_CONFIG_DIR: '/operator/global' }, spawnFn });

    expect(seen).toEqual({
      command: 'claude',
      args: ['auth', 'login'],
      options: { env: { CLAUDE_CONFIG_DIR: home }, stdio: 'inherit' },
    });
    if (process.platform !== 'win32') expect((await stat(home)).mode & 0o777).toBe(0o700);
  });
});
