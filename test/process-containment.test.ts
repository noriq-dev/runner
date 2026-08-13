import { once } from 'node:events';
import { constants, accessSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AgentProcessLaunch,
  LinuxBubblewrapContainment,
  buildLinuxBubblewrapArgs,
} from '../src/process-containment';

const temporary: string[] = [];

async function fixture(): Promise<{ root: string; workspace: string; agentHome: string; outside: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noriq-containment-'));
  temporary.push(root);
  const workspace = path.join(root, 'workspace');
  const agentHome = path.join(root, 'agent-home');
  const outside = path.join(root, 'outside-secret');
  await Promise.all([mkdir(workspace), mkdir(agentHome), writeFile(outside, 'host-secret', { mode: 0o600 })]);
  return { root, workspace, agentHome, outside };
}

function launch(
  values: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<AgentProcessLaunch> = {},
): AgentProcessLaunch {
  return {
    runId: 'attempt-1',
    command: '/bin/sh',
    args: ['-c', 'true'],
    cwd: values.workspace,
    workspaceRoot: values.workspace,
    workspaceWrite: true,
    env: { PATH: '/usr/bin:/bin', HOME: values.agentHome },
    privateWriteRoots: [values.agentHome],
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Linux bubblewrap containment policy', () => {
  it('builds one PID namespace with only exact workspace/vendor/tool mounts', async () => {
    const values = await fixture();
    const built = buildLinuxBubblewrapArgs(launch(values));

    expect(built.args).toEqual(
      expect.arrayContaining(['--die-with-parent', '--unshare-pid', '--new-session']),
    );
    expect(built.args).toEqual(
      expect.arrayContaining(['--bind', values.workspace, values.workspace, '--chdir', values.workspace]),
    );
    expect(built.args).toEqual(expect.arrayContaining(['--bind', values.agentHome, values.agentHome]));
    expect(built.args.join('\0')).not.toContain(`--bind\0${values.root}\0${values.root}`);
    expect(built.args.join('\0')).not.toContain(`--ro-bind\0${values.root}\0${values.root}`);
    expect(built.command).toMatch(/^\/usr\//);
    const canonicalHome = realpathSync('/home');
    if (canonicalHome !== '/home') {
      expect(built.args).toEqual(expect.arrayContaining(['--symlink', canonicalHome.slice(1), '/home']));
    }
  });

  it('refuses a writable parent that would widen workspace authority', async () => {
    const values = await fixture();
    expect(() =>
      buildLinuxBubblewrapArgs(
        launch(values, { privateWriteRoots: [], additionalWriteRoots: [values.root] }),
      ),
    ).toThrow(/workspace authority must not be widened/);
  });

  it('refuses provider credentials because one bubblewrap namespace cannot hide them from tools', async () => {
    const values = await fixture();
    expect(() =>
      buildLinuxBubblewrapArgs(
        launch(values, {
          privateWriteRoots: [],
          providerCredentialRoots: [values.agentHome],
        }),
      ),
    ).toThrow(/cannot isolate provider credentials/);
  });

  it('refuses a provider token envelope because a mount namespace cannot enforce spend', async () => {
    const values = await fixture();
    expect(() =>
      buildLinuxBubblewrapArgs(
        launch(values, {
          privateWriteRoots: [],
          providerTokenEnvelope: { totalTokens: 1_024, maxTurns: 4 },
        }),
      ),
    ).toThrow(/cannot enforce provider token spend/);
  });

  it('refuses a writable parent that would hide a read-only tool root', async () => {
    const values = await fixture();
    const host = path.join(values.root, 'host-integrations');
    const tool = path.join(host, 'tool');
    await mkdir(tool, { recursive: true });
    expect(() =>
      buildLinuxBubblewrapArgs(
        launch(values, { privateWriteRoots: [], additionalReadOnlyRoots: [tool] }),
        [],
        [host],
      ),
    ).toThrow(/overlaps read-only root/);
  });

  it('mounts protected workspace metadata after the writable workspace bind', async () => {
    const values = await fixture();
    const metadata = path.join(values.workspace, '.backend');
    await mkdir(metadata);
    await writeFile(path.join(metadata, 'authority'), 'lease-1');

    const built = buildLinuxBubblewrapArgs(launch(values, { protectedWorkspaceReadOnlyPaths: ['.backend'] }));
    const workspaceBind = built.args.findIndex(
      (value, index) =>
        value === '--bind' &&
        built.args[index + 1] === values.workspace &&
        built.args[index + 2] === values.workspace,
    );
    const protectedBind = built.args.findIndex(
      (value, index) =>
        value === '--ro-bind' && built.args[index + 1] === metadata && built.args[index + 2] === metadata,
    );

    expect(workspaceBind).toBeGreaterThanOrEqual(0);
    expect(protectedBind).toBeGreaterThan(workspaceBind);
  });

  it('refuses escaping, symlinked, missing, and overlapping protected workspace paths', async () => {
    const values = await fixture();
    const metadata = path.join(values.workspace, '.backend');
    await mkdir(path.join(metadata, 'nested'), { recursive: true });
    await symlink(metadata, path.join(values.workspace, '.backend-link'), 'dir');

    expect(() =>
      buildLinuxBubblewrapArgs(launch(values, { protectedWorkspaceReadOnlyPaths: ['../outside-secret'] })),
    ).toThrow(/escapes/);
    expect(() =>
      buildLinuxBubblewrapArgs(launch(values, { protectedWorkspaceReadOnlyPaths: ['.backend-link'] })),
    ).toThrow(/symbolic link/);
    expect(() =>
      buildLinuxBubblewrapArgs(launch(values, { protectedWorkspaceReadOnlyPaths: ['missing'] })),
    ).toThrow(/cannot be resolved/);
    expect(() =>
      buildLinuxBubblewrapArgs(
        launch(values, { protectedWorkspaceReadOnlyPaths: ['.backend', '.backend/nested'] }),
      ),
    ).toThrow(/overlap/);
  });

  it('canonicalizes symlinked environment paths to the mounted object', async () => {
    const values = await fixture();
    const alias = path.join(values.root, 'alias-home');
    const { symlink } = await import('node:fs/promises');
    await symlink(values.agentHome, alias, 'dir');
    const built = buildLinuxBubblewrapArgs(
      launch(values, {
        env: { PATH: '/usr/bin:/bin', HOME: alias, CODEX_HOME: alias },
        privateWriteRoots: [alias],
      }),
    );
    expect(built.env.HOME).toBe(await import('node:fs/promises').then(({ realpath }) => realpath(alias)));
    expect(built.env.CODEX_HOME).toBe(built.env.HOME);
  });

  const bwrapAvailable =
    process.platform === 'linux' &&
    (() => {
      try {
        accessSync('/usr/bin/bwrap', constants.X_OK);
        return true;
      } catch {
        return false;
      }
    })();

  it.skipIf(!bwrapAvailable)(
    'proves host files are hidden while the selected workspace and managed home remain writable',
    async () => {
      const values = await fixture();
      const containment = new LinuxBubblewrapContainment();
      const handle = containment.spawn(
        launch(values, {
          args: [
            '-c',
            [
              'test ! -e "$OUTSIDE"',
              'printf workspace > workspace.txt',
              'printf cache > "$HOME/cache.txt"',
              'printf ok',
            ].join(' && '),
          ],
          env: { PATH: '/usr/bin:/bin', HOME: values.agentHome, OUTSIDE: values.outside },
        }),
      );
      let stdout = '';
      handle.child.stdout.setEncoding('utf8');
      handle.child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      const [code] = (await once(handle.child, 'exit')) as [number | null];
      await handle.exited;

      expect(code).toBe(0);
      expect(stdout).toBe('ok');
      expect(await readFile(path.join(values.workspace, 'workspace.txt'), 'utf8')).toBe('workspace');
      expect(await readFile(path.join(values.agentHome, 'cache.txt'), 'utf8')).toBe('cache');
      expect(await readFile(values.outside, 'utf8')).toBe('host-secret');
    },
  );

  it.skipIf(!bwrapAvailable)(
    'keeps selected backend metadata read-only inside an otherwise writable workspace',
    async () => {
      const values = await fixture();
      const metadata = path.join(values.workspace, '.backend');
      const authority = path.join(metadata, 'authority');
      await mkdir(metadata);
      await writeFile(authority, 'lease-1');
      const containment = new LinuxBubblewrapContainment();
      const handle = containment.spawn(
        launch(values, {
          protectedWorkspaceReadOnlyPaths: ['.backend'],
          args: [
            '-c',
            [
              'if printf compromised > .backend/authority 2>/dev/null; then exit 41; fi',
              'if rm -f .backend/authority 2>/dev/null; then exit 42; fi',
              'printf workspace > ordinary.txt',
            ].join(' && '),
          ],
        }),
      );
      const [code] = (await once(handle.child, 'exit')) as [number | null];
      await handle.exited;

      expect(code).toBe(0);
      expect(await readFile(authority, 'utf8')).toBe('lease-1');
      expect(await readFile(path.join(values.workspace, 'ordinary.txt'), 'utf8')).toBe('workspace');
    },
  );
});
