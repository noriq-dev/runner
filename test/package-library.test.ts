import { execFile } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let temporaryDirectory: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'noriq-runner-package-'));
});

afterAll(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('published mission library', () => {
  it('is present in npm pack and importable from an install-shaped consumer without changing the CLI', async () => {
    await exec(process.execPath, ['scripts/build.mjs'], {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
    });

    const packed = await exec(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
    });
    const reports = JSON.parse(packed.stdout) as Array<{
      files: Array<{ path: string }>;
    }>;
    const packedFiles = reports[0]?.files.map((file) => file.path) ?? [];
    expect(packedFiles).toContain('dist/index.js');
    expect(packedFiles).toContain('dist/cli.js');
    expect(packedFiles).toContain('dist/types/src/mission-library.d.ts');
    expect(packedFiles).toContain('dist/types/vendor/noriq-shared/src/index.d.ts');
    expect(packedFiles).toContain('package.json');

    // Recreate only the package files Node needs under a consumer's node_modules. This exercises
    // package-name resolution and `exports`, while the pack manifest above proves those exact
    // files are what npm will publish. Not copying this repository's node_modules also catches an
    // accidentally unbundled runtime import.
    const consumer = path.join(temporaryDirectory, 'consumer');
    const installedPackage = path.join(consumer, 'node_modules', '@noriq-dev', 'runner');
    await mkdir(path.join(installedPackage, 'dist'), { recursive: true });
    await copyFile(path.join(root, 'package.json'), path.join(installedPackage, 'package.json'));
    await copyFile(path.join(root, 'dist', 'index.js'), path.join(installedPackage, 'dist', 'index.js'));
    await cp(path.join(root, 'dist', 'types'), path.join(installedPackage, 'dist', 'types'), {
      recursive: true,
    });
    // The Claude Agent SDK is an intentional published runtime dependency rather than an
    // accidentally unbundled private module. Reproduce the piece npm installs for the package;
    // its current sdk.mjs runtime is self-contained apart from Node built-ins.
    await mkdir(path.join(consumer, 'node_modules', '@anthropic-ai'), { recursive: true });
    await cp(
      path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'),
      path.join(consumer, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'),
      { recursive: true },
    );
    const consumerRepository = path.join(consumer, 'repository');
    await mkdir(consumerRepository, { recursive: true });
    await exec('git', ['init', '--quiet', consumerRepository]);
    await exec('git', ['config', 'user.name', 'Package Consumer'], { cwd: consumerRepository });
    await exec('git', ['config', 'user.email', 'consumer@example.invalid'], { cwd: consumerRepository });
    await writeFile(path.join(consumerRepository, 'README.md'), 'consumer fixture\n', 'utf8');
    await exec('git', ['add', 'README.md'], { cwd: consumerRepository });
    await exec('git', ['commit', '--quiet', '-m', 'initial'], { cwd: consumerRepository });
    const consumerState = path.join(consumer, 'state');
    const consumerWorktrees = path.join(consumer, 'worktrees');
    await writeFile(
      path.join(consumer, 'consumer.mjs'),
      [
        "import { MissionService, JsonlMissionStore, loadMcpBundle, GitBackend, WorktreeManager, createGitMissionWorkspaceAdapter, loginCodex, loginClaude } from '@noriq-dev/runner';",
        "import * as missionSurface from '@noriq-dev/runner/mission';",
        'const exported = { MissionService, JsonlMissionStore, loadMcpBundle, GitBackend, WorktreeManager, createGitMissionWorkspaceAdapter, loginCodex, loginClaude };',
        'for (const [name, value] of Object.entries(exported)) {',
        "  if (typeof value !== 'function') throw new Error(`${name} is not importable`);",
        '}',
        "if ('DiversionMissionWorkspaceAdapter' in missionSurface) throw new Error('activation-gated Diversion prototype was published');",
        `const store = new JsonlMissionStore(${JSON.stringify(path.join(consumerState, 'journals'))});`,
        `const adapter = createGitMissionWorkspaceAdapter({ repositoryKey: 'example/repo', repositoryRoot: ${JSON.stringify(consumerRepository)}, stateDirectory: ${JSON.stringify(path.join(consumerState, 'git'))}, worktreeDirectory: ${JSON.stringify(consumerWorktrees)}, runtimeAuthority: { authorityFingerprint: 'sha256:${'e'.repeat(64)}', assertAuthority: async () => undefined } });`,
        'await adapter.preflight();',
        'if ((await store.listMissionEntries()).length !== 0) throw new Error("fresh store is not empty");',
        "process.stdout.write(Object.keys(exported).join(','));",
      ].join('\n'),
      'utf8',
    );

    const imported = await exec(process.execPath, ['consumer.mjs'], { cwd: consumer });
    expect(imported.stdout).toBe(
      'MissionService,JsonlMissionStore,loadMcpBundle,GitBackend,WorktreeManager,createGitMissionWorkspaceAdapter,loginCodex,loginClaude',
    );

    // A real TypeScript consumer supplies its compiler and Node types as development tooling, and
    // npm installs Runner's declared zod dependency. Copy those existing installs into the
    // install-shaped fixture; deliberately do not provide the private @noriq-dev/shared file:
    // dependency, so any declaration that still refers to it fails closed here.
    await mkdir(path.join(consumer, 'node_modules', '@types'), { recursive: true });
    await cp(
      path.join(root, 'node_modules', '@types', 'node'),
      path.join(consumer, 'node_modules', '@types', 'node'),
      {
        recursive: true,
      },
    );
    await cp(
      path.join(root, 'node_modules', 'undici-types'),
      path.join(consumer, 'node_modules', 'undici-types'),
      {
        recursive: true,
      },
    );
    await cp(path.join(root, 'node_modules', 'zod'), path.join(consumer, 'node_modules', 'zod'), {
      recursive: true,
    });
    await writeFile(
      path.join(consumer, 'package.json'),
      JSON.stringify({ private: true, type: 'module' }),
      'utf8',
    );
    await writeFile(
      path.join(consumer, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: ['node'],
        },
        include: ['consumer.ts'],
      }),
      'utf8',
    );
    await writeFile(
      path.join(consumer, 'consumer.ts'),
      [
        "import { MissionService, JsonlMissionStore, loadMcpBundle, GitBackend, WorktreeManager, createGitMissionWorkspaceAdapter, loginCodex, loginClaude } from '@noriq-dev/runner';",
        "import * as missionSurface from '@noriq-dev/runner/mission';",
        'type IsAny<T> = 0 extends 1 & T ? true : false;',
        'type Assert<T extends true> = T;',
        'type MissionServiceIsTyped = Assert<IsAny<typeof MissionService> extends false ? true : false>;',
        'type JsonlMissionStoreIsTyped = Assert<IsAny<typeof JsonlMissionStore> extends false ? true : false>;',
        'type LoadMcpBundleIsTyped = Assert<IsAny<typeof loadMcpBundle> extends false ? true : false>;',
        'const manager = new WorktreeManager({ baseDir: "/tmp/noriq-consumer-worktrees" });',
        'const backend = new GitBackend(manager);',
        `const adapter = createGitMissionWorkspaceAdapter({ repositoryKey: "example/repo", repositoryRoot: "/tmp/example-repo", stateDirectory: "/tmp/noriq-consumer-state", worktreeDirectory: "/tmp/noriq-consumer-worktrees", runtimeAuthority: { authorityFingerprint: "sha256:${'e'.repeat(64)}", assertAuthority: async () => undefined } });`,
        'const constructors = { MissionService, JsonlMissionStore, loadMcpBundle, manager, backend, adapter, loginCodex, loginClaude };',
        'void constructors;',
        '// @ts-expect-error The activation-gated Diversion prototype is deliberately not public.',
        'void missionSurface.DiversionMissionWorkspaceAdapter;',
        'export type ConsumerProof = MissionServiceIsTyped | JsonlMissionStoreIsTyped | LoadMcpBundleIsTyped;',
      ].join('\n'),
      'utf8',
    );
    await exec(
      process.execPath,
      [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', 'tsconfig.json'],
      { cwd: consumer, maxBuffer: 16 * 1024 * 1024 },
    );

    const cli = await exec(process.execPath, ['dist/cli.js', 'version'], { cwd: root });
    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(cli.stdout.trim()).toBe(packageJson.version);
  }, 60_000);
});
