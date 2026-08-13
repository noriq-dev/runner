import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { DiscoveredRepo } from '../discovery';
import { resolveClaudeAgentSdkInstallation } from '../drivers/claude';
import type { AgentProcessContainment } from '../process-containment';
import type { ProjectMcpLauncherPolicy, ProjectMcpLoadOptions } from '../project-mcp';
import type { GitBackend } from '../vcs/git';
import { DEFAULT_WORKTREES_DIR } from '../worktree';
import {
  type MissionExecutionProfileActivationFactory,
  MissionExecutionProfileRegistry,
} from './execution-profile-registry';
import {
  GIT_MISSION_WORKSPACE_CAPABILITIES,
  GIT_MISSION_WORKSPACE_CLEANUP_PLAN,
  GitMissionWorkspaceAdapter,
} from './git-workspace-adapter';
import {
  type LocalMissionRuntime,
  type LocalMissionRuntimeOptions,
  createLocalMissionRuntime,
} from './local-runtime';
import { canonicalMissionJson } from './store';

const PROFILE_STATE_SCHEMA = 'noriq-daemon-mission-runtime.v1';
const EFFECTIVE_ATTESTATION_SCHEMA = 'noriq-daemon-mission-effective.v1';

export interface DaemonMissionProfileRegistryOptions {
  repo: Pick<DiscoveredRepo, 'id' | 'root' | 'repositoryKey'>;
  /** Exact detected backend. Only Git is published as a production mission evidence adapter. */
  backend: GitBackend | null;
  /** Machine-private root; profile journals, snapshots and VCS lease records live below it. */
  privateRoot: string;
  globalResourceDirectory: string;
  worktreeDirectory?: string;
  codexHome?: string;
  claudeHome?: string;
  /**
   * Machine-owned commissioned boundary. Omission falls back to ordinary bubblewrap, which is
   * intentionally insufficient for fresh mission activation because it cannot separate provider
   * credentials, hard-limit host resources, broker egress, or bind an immutable runtime image.
   */
  executionBoundary?: AgentProcessContainment;
  env?: NodeJS.ProcessEnv;
  /**
   * Machine-owned stdio authority. Omission denies every local MCP declaration; Runner cannot
   * infer an immutable runtime closure merely because a command happens to be installed.
   */
  mcpLauncherPolicy?: ProjectMcpLauncherPolicy;
  /** Machine-trusted deployment seam. Remote endpoints remain denied by the default. */
  mcpLoadOptions?: (
    declarationRoot: string,
    configuredLauncherPolicy: ProjectMcpLauncherPolicy | undefined,
  ) => ProjectMcpLoadOptions;
  /** Test/deployment seam; production uses the fully preflighted local runtime. */
  createRuntime?: (options: LocalMissionRuntimeOptions) => Promise<LocalMissionRuntime>;
  /** Test/deployment seam for exact host executable identities. */
  attestExecutable?: (command: string, env: NodeJS.ProcessEnv) => Promise<string>;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function privateKey(value: unknown): string {
  return sha256(canonicalMissionJson(value));
}

async function hashFile(filename: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(filename);
    input.on('data', (chunk: Buffer | string) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', resolve);
  });
  return hash.digest('hex');
}

/** Resolve and hash the exact executable selected by the mission environment. */
export async function attestMissionExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const executable = await resolveInstalledExecutable(command, env);
  return `sha256:${await hashFile(executable)}`;
}

async function resolveInstalledExecutable(command: string, env: NodeJS.ProcessEnv): Promise<string> {
  const candidates = command.includes(path.sep)
    ? [command]
    : (env.PATH ?? '')
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.join(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const executable = await realpath(candidate);
      return executable;
    } catch {
      // Continue through the exact selected PATH.
    }
  }
  throw new Error(`mission executable '${command}' is unavailable from the selected PATH`);
}

function referencedDrivers(runtime: LocalMissionRuntime): readonly string[] {
  return [
    runtime.catalog.guide.agent.driver,
    ...runtime.catalog.profiles.map((profile) => profile.agent.driver),
  ]
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort();
}

function runtimeStateDirectory(
  privateRoot: string,
  repo: Pick<DiscoveredRepo, 'id' | 'root' | 'repositoryKey'>,
  profileId: string,
  declarationFingerprint: string,
): string {
  return path.join(
    privateRoot,
    'runtimes',
    privateKey({ schema: PROFILE_STATE_SCHEMA, repoId: repo.id, root: path.resolve(repo.root) }),
    privateKey({ profileId, declarationFingerprint }),
  );
}

/**
 * Generic Git-backed activation. Project/agent `.mcp.json` files are inputs, never special cases.
 * They do not authorize their own launchers: a machine-owned deployment policy must independently
 * trust local stdio identities, while remote endpoints remain denied by default. Runner never
 * learns what an MCP server (Unreal or otherwise) does.
 */
export function createDaemonMissionProfileRegistry(
  options: DaemonMissionProfileRegistryOptions,
): MissionExecutionProfileRegistry<LocalMissionRuntime> {
  const env = options.env ?? process.env;
  const createRuntime = options.createRuntime ?? createLocalMissionRuntime;
  const attestExecutable = options.attestExecutable ?? attestMissionExecutable;
  const configuredLauncherPolicy = options.mcpLauncherPolicy;
  const snapshotDirectory = path.join(
    options.privateRoot,
    'profile-snapshots',
    privateKey({ repoId: options.repo.id, root: path.resolve(options.repo.root) }),
  );

  const activationFactory: MissionExecutionProfileActivationFactory<LocalMissionRuntime> = async (
    request,
  ) => {
    if (!options.repo.repositoryKey) {
      throw new Error('mission activation requires the repository committed canonical repositoryKey');
    }
    if (!options.backend) {
      throw new Error('no published mission workspace/evidence adapter matches the detected VCS');
    }
    if (!options.executionBoundary) {
      throw new Error('no commissioned credential/resource/network/runtime boundary is configured');
    }
    const stateDirectory = runtimeStateDirectory(
      options.privateRoot,
      options.repo,
      request.declaration.id,
      request.declarationFingerprint,
    );
    const mcpDeclarations = request.mcpDeclarations.map((item) => ({
      declarationRoot: item.declarationRoot,
      load: {
        ...(options.mcpLoadOptions
          ? options.mcpLoadOptions(item.declarationRoot, configuredLauncherPolicy)
          : configuredLauncherPolicy
            ? { launcherPolicy: configuredLauncherPolicy }
            : {}),
        // Repository-owned paths deliberately follow the leased checkout. Managed vendor
        // environment argv is opaque to Runner and must be authorized as one complete vector by
        // machine policy; an explicit `${workspace}` token is the only generic project-path form.
        implicitPathBinding: item.sourceKind === 'project' ? ('workspace' as const) : ('policy' as const),
      },
    }));
    const workspace = new GitMissionWorkspaceAdapter({
      repositoryKey: options.repo.repositoryKey,
      repositoryRoot: request.repositoryRoot,
      stateDirectory: path.join(stateDirectory, 'git-workspace'),
      backend: options.backend,
      runtimeAuthority: options.executionBoundary,
      worktreeDirectory: options.worktreeDirectory ?? DEFAULT_WORKTREES_DIR,
      env,
    });
    const runtime = await createRuntime({
      stateDirectory,
      ...(options.codexHome ? { codexHome: options.codexHome } : {}),
      ...(options.claudeHome ? { claudeHome: options.claudeHome } : {}),
      containment: options.executionBoundary,
      catalog: request.declaration.catalog,
      mcpDeclarations,
      workspace,
      externalResourceCapacities: request.declaration.externalResourceCapacities,
      globalResourceDirectory: options.globalResourceDirectory,
      env,
    });

    const drivers = referencedDrivers(runtime);
    // The injected commissioned boundary replaces the stock bubblewrap implementation. Its own
    // immutable authority fingerprint is attested separately below, so requiring a host `bwrap`
    // executable here would reject valid VM/container/broker implementations that never execute
    // it. Git and the non-SDK provider entrypoints are still host-selected by this runtime.
    const commands = [...new Set(['git', ...drivers.filter((driver) => driver !== 'claude')])].sort();
    const executableIdentities = Object.fromEntries(
      await Promise.all(
        commands.map(async (command) => [command, await attestExecutable(command, env)] as const),
      ),
    );
    const claudeAgentSdk = drivers.includes('claude')
      ? (runtime.claudeAgentSdkInstallation ?? resolveClaudeAgentSdkInstallation())
      : null;
    const claudeAgentSdkIdentities = claudeAgentSdk
      ? {
          sdkEntry: `sha256:${await hashFile(claudeAgentSdk.sdkEntryPath)}`,
          sdkPackage: `sha256:${await hashFile(claudeAgentSdk.sdkPackageJsonPath)}`,
          nativePackage: `sha256:${await hashFile(claudeAgentSdk.nativePackageJsonPath)}`,
          nativeExecutable: `sha256:${await hashFile(claudeAgentSdk.executablePath)}`,
        }
      : null;
    const effectiveFingerprint = `sha256:${sha256(
      canonicalMissionJson({
        schema: EFFECTIVE_ATTESTATION_SCHEMA,
        declarationFingerprint: request.declarationFingerprint,
        catalogFingerprint: runtime.catalog.fingerprint,
        projectMcpEffectiveFingerprint: runtime.projectMcp?.effectiveFingerprint ?? null,
        resources: runtime.resources,
        workspace: {
          backend: 'git',
          capabilities: GIT_MISSION_WORKSPACE_CAPABILITIES,
          cleanup: GIT_MISSION_WORKSPACE_CLEANUP_PLAN,
        },
        containment: runtime.containment.capabilities,
        executionBoundaryFingerprint: runtime.executionBoundaryFingerprint,
        executableIdentities,
        claudeAgentSdk: claudeAgentSdk
          ? {
              nativePackageName: claudeAgentSdk.nativePackageName,
              identities: claudeAgentSdkIdentities,
            }
          : null,
      }),
    )}`;
    return { runtime, effectiveFingerprint };
  };

  return new MissionExecutionProfileRegistry({
    repoRoot: options.repo.root,
    snapshotDirectory,
    activationFactory,
    ...(options.codexHome ? { codexHome: options.codexHome } : {}),
    ...(options.claudeHome ? { claudeHome: options.claudeHome } : {}),
  });
}
