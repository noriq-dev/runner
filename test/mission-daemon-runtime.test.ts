import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDaemonMissionProfileRegistry } from '../src/mission/daemon-runtime';
import type { LocalMissionRuntime, LocalMissionRuntimeOptions } from '../src/mission/local-runtime';
import { snapshotMissionProfileCatalog } from '../src/mission/profile-catalog';
import type { AgentProcessContainment } from '../src/process-containment';
import { composeMcpBundles, loadProjectMcpBundle } from '../src/project-mcp';
import { GitBackend } from '../src/vcs/git';
import { WorktreeManager } from '../src/worktree';

const roots: string[] = [];
const executionBoundary: AgentProcessContainment = {
  capabilities: {
    processTreeTermination: true,
    ownerDeathTermination: true,
    workspaceIsolation: true,
    protectedWorkspaceSubpaths: true,
    projectMcpProcessContainment: true,
    providerCredentialIsolation: true,
    hostResourceIsolation: true,
    networkEgressIsolation: true,
    immutableRuntimeAuthority: true,
  },
  authorityFingerprint: `sha256:${'f'.repeat(64)}`,
  assertAuthority: async () => undefined,
  probe: async () => undefined,
  spawn: () => {
    throw new Error('test execution boundary must not launch');
  },
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await makeRemovable(root);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

async function makeRemovable(candidate: string): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    await chmod(candidate, 0o600);
    return;
  }
  await chmod(candidate, 0o700);
  await Promise.all((await readdir(candidate)).map((entry) => makeRemovable(path.join(candidate, entry))));
}

const budget = { tokens: 1_000, usd: null, activeSeconds: 60 } as const;
const catalog = {
  guide: {
    profileId: 'guide',
    agent: { driver: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
    budget,
    turnLimit: 4,
  },
  profiles: [
    {
      profileId: 'reader',
      role: 'reader',
      permission: 'read',
      agent: { driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium' },
      assurance: { rank: 1, independenceClass: 'reader' },
      driverPosture: {
        kind: 'scope',
        permission: { write: false, allow: ['Read'], deny: ['Edit'], auto: false },
        lineageRole: 'worker',
      },
      budget,
      resources: { workspace: 1 },
      projectMcp: [],
    },
  ],
  validationPolicy: { kind: 'none', policyId: 'none-v1', reason: 'read-only fixture' },
} as const;

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noriq-daemon-mission-runtime-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, '.noriq', 'execution-profiles'), { recursive: true });
  await mkdir(path.join(repo, '.git'));
  await writeFile(
    path.join(repo, '.noriq', 'execution-profiles', 'default.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'default',
      generation: 1,
      maxConcurrency: 1,
      missionBudget: { tokens: 10_000, usd: null, activeSeconds: 600 },
      externalResourceCapacities: {},
      catalog,
    }),
  );
  return { root, repo };
}

async function fakeRuntime(options: LocalMissionRuntimeOptions): Promise<LocalMissionRuntime> {
  const bundles = await Promise.all(
    (options.mcpDeclarations ?? []).map(({ declarationRoot, load }) =>
      loadProjectMcpBundle(declarationRoot, load),
    ),
  );
  const projectMcp = bundles.length > 0 ? composeMcpBundles(bundles) : null;
  return {
    catalog: snapshotMissionProfileCatalog(options.catalog, projectMcp ?? undefined),
    projectMcp,
    stateDirectory: options.stateDirectory,
    executionBoundaryFingerprint: options.containment!.authorityFingerprint!,
    containment: options.containment!,
    drivers: {},
    resources: { workspace: 1 },
    cleanupPlan: [],
  } as unknown as LocalMissionRuntime;
}

describe('daemon mission execution-profile activation', () => {
  it('loads a project MCP generically only through an injected runtime-closure policy', async () => {
    const { root, repo } = await fixture();
    const bin = path.join(root, 'machine-bin');
    const executable = path.join(bin, 'example-project-mcp');
    await mkdir(bin);
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o755);
    await writeFile(
      path.join(repo, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          editor: { command: 'example-project-mcp', args: ['${workspace}'] },
        },
      }),
    );
    const subject = createDaemonMissionProfileRegistry({
      repo: { id: 'repo_1', root: repo, repositoryKey: 'project-repo' },
      backend: new GitBackend(new WorktreeManager({ baseDir: path.join(root, 'worktrees') })),
      privateRoot: path.join(root, 'private'),
      globalResourceDirectory: path.join(root, 'resources'),
      executionBoundary,
      env: { ...process.env, PATH: bin },
      mcpLauncherPolicy: {
        policyId: 'test-sealed-project-mcp-v1',
        authorize: ({ command, argvIdentity }) =>
          command === 'example-project-mcp'
            ? {
                policyId: 'test-sealed-project-mcp-v1',
                executableIdentity: 'sha256:test-project-mcp-entrypoint',
                runtimeClosureIdentity: 'test:sealed-project-mcp-runtime-v1',
                authorizedArgvIdentity: argvIdentity,
                resolvedCommand: executable,
                readOnlyRoots: [],
              }
            : null,
      },
      createRuntime: fakeRuntime,
      attestExecutable: async (command) => `sha256:${command.padEnd(64, '0').slice(0, 64)}`,
    });

    const [offer] = await subject.refresh();

    expect(offer).toMatchObject({
      id: 'default',
      resolution: 'resolved',
      health: 'healthy',
      attestationCapable: true,
      capacity: { maxConcurrency: 1, freeSlots: 1 },
    });
    expect(offer?.effectiveFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('denies an installed direct MCP command when no runtime-closure policy is configured', async () => {
    const { root, repo } = await fixture();
    const bin = path.join(root, 'machine-bin');
    const executable = path.join(bin, 'example-project-mcp');
    await mkdir(bin);
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o755);
    await writeFile(
      path.join(repo, '.mcp.json'),
      JSON.stringify({ mcpServers: { editor: { command: 'example-project-mcp', args: [] } } }),
    );
    const subject = createDaemonMissionProfileRegistry({
      repo: { id: 'repo_1', root: repo, repositoryKey: 'project-repo' },
      backend: new GitBackend(new WorktreeManager({ baseDir: path.join(root, 'worktrees') })),
      privateRoot: path.join(root, 'private'),
      globalResourceDirectory: path.join(root, 'resources'),
      executionBoundary,
      env: { ...process.env, PATH: bin },
      createRuntime: fakeRuntime,
      attestExecutable: async () => `sha256:${'a'.repeat(64)}`,
    });

    expect(await subject.refresh()).toEqual([
      expect.objectContaining({
        id: 'default',
        resolution: 'unresolved',
        health: 'unavailable',
        attestationCapable: false,
        effectiveFingerprint: null,
      }),
    ]);
  });

  it.each(['example-mcp@1.2.3', 'example-mcp@latest'])(
    'keeps npx package selection %s unavailable without a separate package-artifact policy',
    async (coordinate) => {
      const { root, repo } = await fixture();
      await writeFile(
        path.join(repo, '.mcp.json'),
        JSON.stringify({ mcpServers: { editor: { command: 'npx', args: ['-y', coordinate] } } }),
      );
      const subject = createDaemonMissionProfileRegistry({
        repo: { id: 'repo_1', root: repo, repositoryKey: 'project-repo' },
        backend: new GitBackend(new WorktreeManager({ baseDir: path.join(root, 'worktrees') })),
        privateRoot: path.join(root, 'private'),
        globalResourceDirectory: path.join(root, 'resources'),
        executionBoundary,
        createRuntime: fakeRuntime,
        attestExecutable: async () => `sha256:${'a'.repeat(64)}`,
      });

      expect(await subject.refresh()).toEqual([
        expect.objectContaining({
          id: 'default',
          resolution: 'unresolved',
          health: 'unavailable',
          attestationCapable: false,
          effectiveFingerprint: null,
          capacity: { maxConcurrency: 1, freeSlots: 0 },
        }),
      ]);
    },
  );

  it('admits an exact npx coordinate only through a separately injected package-artifact policy', async () => {
    const { root, repo } = await fixture();
    await writeFile(
      path.join(repo, '.mcp.json'),
      JSON.stringify({ mcpServers: { editor: { command: 'npx', args: ['-y', 'example-mcp@1.2.3'] } } }),
    );
    let receivedFailClosedDefault = false;
    const subject = createDaemonMissionProfileRegistry({
      repo: { id: 'repo_1', root: repo, repositoryKey: 'project-repo' },
      backend: new GitBackend(new WorktreeManager({ baseDir: path.join(root, 'worktrees') })),
      privateRoot: path.join(root, 'private'),
      globalResourceDirectory: path.join(root, 'resources'),
      executionBoundary,
      mcpLoadOptions: (_declarationRoot, configuredDefault) => {
        receivedFailClosedDefault = configuredDefault === undefined;
        return {
          launcherPolicy: {
            policyId: 'test-package-artifacts-v1',
            authorize: ({ command, args, argvIdentity }) =>
              command === 'npx' && args.includes('example-mcp@1.2.3')
                ? {
                    policyId: 'test-package-artifacts-v1',
                    executableIdentity: 'npm:example-mcp@1.2.3;test-artifact-sha256:fixed',
                    runtimeClosureIdentity: 'test:sealed-package-cache-v1',
                    authorizedArgvIdentity: argvIdentity,
                    resolvedCommand: process.execPath,
                    readOnlyRoots: [],
                  }
                : null,
          },
        };
      },
      createRuntime: fakeRuntime,
      attestExecutable: async () => `sha256:${'a'.repeat(64)}`,
    });

    expect(await subject.refresh()).toEqual([
      expect.objectContaining({ id: 'default', health: 'healthy', attestationCapable: true }),
    ]);
    expect(receivedFailClosedDefault).toBe(true);
  });

  it('does not retarget an agent-home relative MCP path into the leased repository', async () => {
    const { root, repo } = await fixture();
    const codexHome = path.join(root, 'codex-home');
    await mkdir(codexHome, { mode: 0o700 });
    await writeFile(
      path.join(codexHome, '.mcp.json'),
      JSON.stringify({
        mcpServers: { environment: { command: 'custom', args: ['./trusted-config.json'] } },
      }),
    );
    const subject = createDaemonMissionProfileRegistry({
      repo: { id: 'repo_1', root: repo, repositoryKey: 'project-repo' },
      backend: new GitBackend(new WorktreeManager({ baseDir: path.join(root, 'worktrees') })),
      privateRoot: path.join(root, 'private'),
      globalResourceDirectory: path.join(root, 'resources'),
      executionBoundary,
      codexHome,
      mcpLauncherPolicy: {
        policyId: 'test-agent-environment-policy-v1',
        authorize: ({ args, argumentBinding, argvIdentity }) =>
          argumentBinding === 'policy' && args.includes('./trusted-config.json')
            ? null
            : {
                policyId: 'test-agent-environment-policy-v1',
                executableIdentity: 'test:agent-environment-entrypoint-v1',
                runtimeClosureIdentity: 'test:agent-environment-runtime-v1',
                authorizedArgvIdentity: argvIdentity,
                resolvedCommand: process.execPath,
                readOnlyRoots: [],
              },
      },
      createRuntime: fakeRuntime,
      attestExecutable: async () => `sha256:${'a'.repeat(64)}`,
    });

    expect(await subject.refresh()).toEqual([
      expect.objectContaining({ id: 'default', resolution: 'unresolved', health: 'unavailable' }),
    ]);
  });

  it('does not substitute Git evidence when no published adapter matches the detected backend', async () => {
    const { root, repo } = await fixture();
    const subject = createDaemonMissionProfileRegistry({
      repo: { id: 'repo_1', root: repo, repositoryKey: 'project-repo' },
      backend: null,
      privateRoot: path.join(root, 'private'),
      globalResourceDirectory: path.join(root, 'resources'),
      executionBoundary,
      createRuntime: fakeRuntime,
      attestExecutable: async () => `sha256:${'a'.repeat(64)}`,
    });

    expect(await subject.refresh()).toEqual([
      expect.objectContaining({ health: 'unavailable', effectiveFingerprint: null }),
    ]);
  });
});
