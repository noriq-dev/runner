import {
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
  spawn,
} from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * A vendor-neutral process boundary for unattended agent sessions.
 *
 * The mission harness consumes the capability, not the implementation name. LinuxBubblewrap is
 * one local implementation; a VM/container/broker can implement the same contract on another
 * host without teaching the harness about Claude, Codex, Unreal, or any project MCP.
 */
export interface AgentProcessContainmentCapabilities {
  readonly processTreeTermination: true;
  /** The complete contained process tree dies when its owning Runner process exits. */
  readonly ownerDeathTermination: true;
  readonly workspaceIsolation: true;
  /** Backend-owned paths nested beneath a writable workspace can be remounted read-only. */
  readonly protectedWorkspaceSubpaths: true;
  readonly projectMcpProcessContainment: true;
  /**
   * Provider authentication is visible to the vendor control process only. Model-selected tools,
   * shells, hooks, skills, and MCP descendants run under a different principal/mount boundary and
   * cannot read the credential through the filesystem, environment, or `/proc`.
   */
  readonly providerCredentialIsolation?: true;
  /** PID, memory, CPU, I/O, temporary-storage, and workspace-storage ceilings are enforced below
   * the Runner process rather than inferred from model telemetry. */
  readonly hostResourceIsolation?: true;
  /** Egress, including localhost, is default-denied and released only through a machine-owned
   * allowlist/broker for the selected provider and exact project-tool authority. */
  readonly networkEgressIsolation?: true;
  /** Vendor, tool, MCP, containment, and VCS execution is bound to an immutable image or broker
   * identity for the lifetime of a commissioned runtime. */
  readonly immutableRuntimeAuthority?: true;
  /**
   * The provider/broker accepts a per-launch total-token envelope and prevents provider spend
   * beyond it. CLI telemetry or best-effort cancellation does not satisfy this capability.
   */
  readonly providerTokenEnvelope?: true;
}

export interface AgentProcessLaunch {
  /** Durable run/attempt identifier, used only for diagnostics. */
  runId: string;
  command: string;
  args: readonly string[];
  cwd: string;
  workspaceRoot: string;
  workspaceWrite: boolean;
  env: NodeJS.ProcessEnv;
  /** Exact pre-spend quota owned by the commissioned provider/broker. */
  providerTokenEnvelope?: {
    totalTokens: number;
    maxTurns: number;
  };
  /** Driver-owned state such as CODEX_HOME/CLAUDE_CONFIG_DIR. */
  privateWriteRoots?: readonly string[];
  /**
   * Provider-control state containing authentication. A commissioned boundary must expose these
   * roots to the vendor controller while masking them from every model-selected descendant. This
   * is intentionally distinct from an ordinary private writable cache.
   */
  providerCredentialRoots?: readonly string[];
  /** Trusted host integrations selected by local execution policy, never by model output. */
  additionalReadOnlyRoots?: readonly string[];
  /**
   * Existing workspace-relative files/directories owned by the trusted workspace adapter. These
   * are remounted read-only after the workspace bind, so a write-capable agent cannot alter VCS
   * locators or other control metadata nested in its otherwise writable lease.
   */
  protectedWorkspaceReadOnlyPaths?: readonly string[];
  /** Trusted host integrations selected by local execution policy, never by model output. */
  additionalWriteRoots?: readonly string[];
}

export interface ContainedAgentProcess {
  /** Compatible with both Codex's stdio transport and Claude SDK's custom process seam. */
  child: ChildProcessWithoutNullStreams;
  /** Resolves only after the containment process exits, which tears down its PID namespace. */
  exited: Promise<void>;
  /** Signal the containment supervisor; its PID namespace owns descendant teardown. */
  terminate(signal?: NodeJS.Signals): void;
}

export interface CommissionedRuntimeAuthority {
  /** Stable identity of the complete immutable image/broker and resource/network policy. */
  readonly authorityFingerprint?: `sha256:${string}`;
  /** Re-prove that the commissioned boundary still names the same live authority. */
  assertAuthority?(): Promise<void>;
}

export interface AgentProcessContainment extends CommissionedRuntimeAuthority {
  readonly capabilities: AgentProcessContainmentCapabilities;
  /**
   * Costless operational proof owned by the provider. A generic caller cannot guess which
   * executable/runtime closure is valid inside an arbitrary VM, container, or namespace.
   */
  probe(workspace: string, env: NodeJS.ProcessEnv): Promise<void>;
  spawn(request: AgentProcessLaunch): ContainedAgentProcess;
}

const EXECUTION_AUTHORITY_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;

/** Static capability admission for a mission-facing commissioned execution boundary. */
export function isCommissionedAgentProcessContainment(
  containment: AgentProcessContainment | undefined,
): containment is AgentProcessContainment & Required<CommissionedRuntimeAuthority> {
  return (
    containment !== undefined &&
    containment.capabilities.processTreeTermination === true &&
    containment.capabilities.ownerDeathTermination === true &&
    containment.capabilities.workspaceIsolation === true &&
    containment.capabilities.protectedWorkspaceSubpaths === true &&
    containment.capabilities.projectMcpProcessContainment === true &&
    containment.capabilities.providerCredentialIsolation === true &&
    containment.capabilities.hostResourceIsolation === true &&
    containment.capabilities.networkEgressIsolation === true &&
    containment.capabilities.immutableRuntimeAuthority === true &&
    typeof containment.authorityFingerprint === 'string' &&
    EXECUTION_AUTHORITY_FINGERPRINT.test(containment.authorityFingerprint) &&
    typeof containment.assertAuthority === 'function'
  );
}

/** Reassert one already-commissioned boundary without allowing its identity to rotate in place. */
export async function assertAgentProcessAuthority(
  containment: CommissionedRuntimeAuthority,
  expectedFingerprint: string,
): Promise<void> {
  if (
    !EXECUTION_AUTHORITY_FINGERPRINT.test(expectedFingerprint) ||
    containment.authorityFingerprint !== expectedFingerprint ||
    typeof containment.assertAuthority !== 'function'
  ) {
    throw new Error('commissioned execution-boundary identity changed or is unavailable');
  }
  await containment.assertAuthority();
  if (containment.authorityFingerprint !== expectedFingerprint) {
    throw new Error('commissioned execution-boundary identity changed during re-attestation');
  }
}

export interface LinuxBubblewrapOptions {
  /** Defaults to /usr/bin/bwrap and is resolved once at construction. */
  bubblewrapPath?: string;
  /** Machine-managed toolchains visible read-only to every contained agent. */
  readOnlyToolRoots?: readonly string[];
  /** Optional machine-managed integration state visible read/write to every session. */
  sharedWriteRoots?: readonly string[];
  /** Injectable only for deterministic transport tests. */
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio & { stdio: ['pipe', 'pipe', 'pipe'] },
  ) => ChildProcessWithoutNullStreams;
}

const ROOT = path.parse(process.cwd()).root;
const REQUIRED_BASE_ROOTS = ['/usr', '/etc'] as const;
const OPTIONAL_BASE_ROOTS = ['/run/systemd/resolve'] as const;
const ROOT_SYMLINKS = [
  ['usr/bin', '/bin'],
  ['usr/sbin', '/sbin'],
  ['usr/lib', '/lib'],
  ['usr/lib64', '/lib64'],
] as const;

/**
 * Some immutable toolchains embed their host's root-level home alias in an ELF interpreter or
 * shebang (Bazzite commonly has /home -> /var/home). Mounts are canonicalized to the target, so
 * recreate only that verified root symlink inside the otherwise empty namespace. This aliases
 * the objects Runner explicitly mounted under the canonical target; it does not bind host /home.
 */
function hostRootSymlinks(): ReadonlyArray<readonly [string, string]> {
  try {
    const canonicalHome = realpathSync('/home');
    if (canonicalHome !== '/home' && canonicalHome !== ROOT && path.isAbsolute(canonicalHome)) {
      return [[canonicalHome.slice(1), '/home']];
    }
  } catch {
    // A host without /home needs no compatibility alias.
  }
  return [];
}

function canonicalExistingPath(candidate: string, label: string): string {
  if (!path.isAbsolute(candidate)) throw new Error(`${label} must be absolute`);
  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch (error) {
    throw new Error(`${label} cannot be resolved: ${String(error)}`);
  }
  if (resolved === ROOT) throw new Error(`${label} may not expose the filesystem root`);
  return resolved;
}

function canonicalDirectory(candidate: string, label: string): string {
  const resolved = canonicalExistingPath(candidate, label);
  if (!statSync(resolved).isDirectory()) throw new Error(`${label} must be a directory`);
  return resolved;
}

function canonicalExecutable(candidate: string, env: NodeJS.ProcessEnv): string {
  if (candidate.includes('/') || candidate.includes('\\')) {
    return canonicalExistingPath(candidate, 'agent command');
  }
  const search = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const directory of search) {
    const resolvedDirectory = path.isAbsolute(directory) ? directory : path.resolve(directory);
    const executable = path.join(resolvedDirectory, candidate);
    if (existsSync(executable)) return canonicalExistingPath(executable, 'agent command');
  }
  throw new Error(`agent command '${candidate}' is not resolvable from the contained PATH`);
}

const PATH_ENVIRONMENT_KEYS = new Set([
  'HOME',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'TMPDIR',
  'TEMP',
  'TMP',
]);

/** Preserve the selected object while removing host-only symlink spellings such as /home -> /var/home. */
function canonicalizeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env };
  if (result.PATH !== undefined) {
    result.PATH = result.PATH.split(path.delimiter)
      .filter(Boolean)
      .map((entry) => {
        const absolute = path.isAbsolute(entry) ? entry : path.resolve(entry);
        try {
          return realpathSync(absolute);
        } catch {
          return absolute;
        }
      })
      .join(path.delimiter);
  }
  for (const key of PATH_ENVIRONMENT_KEYS) {
    const value = result[key];
    if (!value || !path.isAbsolute(value)) continue;
    try {
      result[key] = realpathSync(value);
    } catch {
      // Some intentionally absent paths (for example an MCP credential sink) must stay absent.
      result[key] = path.resolve(value);
    }
  }
  return result;
}

function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function orderedUnique(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort((left, right) => {
    const depth = (value: string) => value.split(path.sep).filter(Boolean).length;
    return depth(left) - depth(right) || left.localeCompare(right);
  });
}

function parentDirectories(targets: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const target of targets) {
    let current = path.dirname(target);
    while (current !== ROOT && !REQUIRED_BASE_ROOTS.some((root) => isInside(current, root))) {
      directories.add(current);
      current = path.dirname(current);
    }
  }
  return orderedUnique([...directories]);
}

function assertNoConflictingWriteRoots(readOnly: readonly string[], writable: readonly string[]): void {
  for (const left of writable) {
    for (const right of writable) {
      if (left !== right && isInside(left, right)) {
        throw new Error(`writable containment roots overlap: '${left}' is inside '${right}'`);
      }
    }
    // Either overlap lets the later writable bind hide or widen an immutable tool mount.
    for (const readRoot of readOnly) {
      if (isInside(left, readRoot) || isInside(readRoot, left)) {
        throw new Error(`writable containment root '${left}' overlaps read-only root '${readRoot}'`);
      }
    }
  }
}

function protectedWorkspacePaths(workspace: string, paths: readonly string[]): string[] {
  const resolved: string[] = [];
  for (const [index, relative] of paths.entries()) {
    if (
      typeof relative !== 'string' ||
      relative.length === 0 ||
      relative.length > 4_096 ||
      relative.includes('\0') ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`protected workspace path ${index} must be a bounded relative path`);
    }
    const normalized = path.normalize(relative);
    if (
      normalized === '.' ||
      normalized === '..' ||
      normalized.startsWith(`..${path.sep}`) ||
      normalized.split(path.sep).includes('..')
    ) {
      throw new Error(`protected workspace path ${index} escapes or names the workspace root`);
    }
    const candidate = path.join(workspace, normalized);
    const canonical = canonicalExistingPath(candidate, `protected workspace path ${index}`);
    if (!isInside(canonical, workspace) || canonical === workspace) {
      throw new Error(`protected workspace path ${index} escapes or names the workspace root`);
    }
    // A mutable symlink in the writable parent would let the agent redirect later VCS operations
    // even though the target object itself was mounted read-only. Require the complete selected
    // spelling beneath the already-canonical workspace to be a real, stable path.
    if (canonical !== candidate) {
      throw new Error(`protected workspace path ${index} may not traverse a symbolic link`);
    }
    resolved.push(canonical);
  }
  const unique = orderedUnique(resolved);
  for (const [index, candidate] of unique.entries()) {
    if (unique.slice(0, index).some((parent) => isInside(candidate, parent))) {
      throw new Error(`protected workspace paths overlap at '${candidate}'`);
    }
  }
  return unique;
}

/** Exported to make the actual isolation policy reviewable and exhaustively testable. */
export function buildLinuxBubblewrapArgs(
  request: AgentProcessLaunch,
  configuredReadOnlyRoots: readonly string[] = [],
  configuredWriteRoots: readonly string[] = [],
): { args: string[]; command: string; cwd: string; env: NodeJS.ProcessEnv } {
  if (!request.runId || request.runId.length > 512 || request.runId.includes('\0')) {
    throw new Error('contained run id must be a bounded non-empty string');
  }
  if ((request.providerCredentialRoots?.length ?? 0) > 0) {
    throw new Error(
      'Linux bubblewrap cannot isolate provider credentials from model-selected descendants; use a commissioned broker boundary',
    );
  }
  if (request.providerTokenEnvelope) {
    throw new Error(
      'Linux bubblewrap cannot enforce provider token spend; use a commissioned broker boundary',
    );
  }
  const workspace = canonicalDirectory(request.workspaceRoot, 'workspace root');
  const cwd = canonicalDirectory(request.cwd, 'agent cwd');
  if (!isInside(cwd, workspace)) throw new Error('agent cwd must be inside its workspace root');

  const env = canonicalizeEnvironment(request.env);
  const command = canonicalExecutable(request.command, env);
  const requiredReadOnly = REQUIRED_BASE_ROOTS.map((root) => canonicalDirectory(root, root));
  const optionalReadOnly = OPTIONAL_BASE_ROOTS.filter(existsSync).map((root) =>
    canonicalDirectory(root, root),
  );
  const readOnly = orderedUnique(
    [
      ...requiredReadOnly,
      ...optionalReadOnly,
      ...configuredReadOnlyRoots.map((root, index) =>
        canonicalExistingPath(root, `configured read-only root ${index}`),
      ),
      ...(request.additionalReadOnlyRoots ?? []).map((root, index) =>
        canonicalExistingPath(root, `additional read-only root ${index}`),
      ),
      // An SDK may resolve its bundled native executable outside the configured tool roots.
      // Bind only that exact file, not its repository or the caller's home.
      command,
    ].filter((candidate) => !isInside(candidate, workspace)),
  );
  const writable = orderedUnique([
    ...(request.privateWriteRoots ?? []).map((root, index) =>
      canonicalDirectory(root, `private write root ${index}`),
    ),
    ...configuredWriteRoots.map((root, index) => canonicalDirectory(root, `configured write root ${index}`)),
    ...(request.additionalWriteRoots ?? []).map((root, index) =>
      canonicalDirectory(root, `additional write root ${index}`),
    ),
  ]);
  if (writable.some((root) => root === workspace || isInside(workspace, root))) {
    throw new Error('workspace authority must not be widened by a containing writable root');
  }
  const protectedReadOnly = protectedWorkspacePaths(workspace, request.protectedWorkspaceReadOnlyPaths ?? []);
  assertNoConflictingWriteRoots([...readOnly, ...protectedReadOnly], writable);

  const mounts = [...readOnly, ...writable, workspace, ...protectedReadOnly];
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    ...[...ROOT_SYMLINKS, ...hostRootSymlinks()].flatMap(([target, link]) => ['--symlink', target, link]),
    ...parentDirectories(mounts).flatMap((directory) => ['--dir', directory]),
    ...readOnly.flatMap((root) => ['--ro-bind', root, root]),
    ...writable.flatMap((root) => ['--bind', root, root]),
    request.workspaceWrite ? '--bind' : '--ro-bind',
    workspace,
    workspace,
    // Bind order is authority: these masks must come after the writable workspace.
    ...protectedReadOnly.flatMap((root) => ['--ro-bind', root, root]),
    '--chdir',
    cwd,
    '--',
    command,
    ...request.args,
  ];
  return { args, command, cwd, env };
}

/**
 * Linux process-tree and mount-namespace containment. Network is intentionally shared so vendor
 * APIs and project-declared HTTP/MCP endpoints remain reachable; filesystem and PID authority are
 * isolated. Hosts without this primitive fail during construction instead of degrading quietly.
 */
export class LinuxBubblewrapContainment implements AgentProcessContainment {
  readonly capabilities: AgentProcessContainmentCapabilities = Object.freeze({
    processTreeTermination: true,
    ownerDeathTermination: true,
    workspaceIsolation: true,
    protectedWorkspaceSubpaths: true,
    projectMcpProcessContainment: true,
  });
  private readonly bubblewrapPath: string;
  private readonly readOnlyRoots: readonly string[];
  private readonly writeRoots: readonly string[];
  private readonly spawnProcess: NonNullable<LinuxBubblewrapOptions['spawnProcess']>;

  constructor(options: LinuxBubblewrapOptions = {}) {
    if (process.platform !== 'linux') {
      throw new Error('Linux bubblewrap containment is unavailable on this host');
    }
    this.bubblewrapPath = canonicalExistingPath(
      options.bubblewrapPath ?? '/usr/bin/bwrap',
      'bubblewrap executable',
    );
    if (!statSync(this.bubblewrapPath).isFile()) throw new Error('bubblewrap executable must be a file');
    this.readOnlyRoots = Object.freeze([...(options.readOnlyToolRoots ?? [])]);
    this.writeRoots = Object.freeze([...(options.sharedWriteRoots ?? [])]);
    this.spawnProcess =
      options.spawnProcess ??
      ((command, args, spawnOptions) =>
        spawn(command, [...args], spawnOptions) as ChildProcessWithoutNullStreams);
  }

  async probe(workspace: string, env: NodeJS.ProcessEnv): Promise<void> {
    const launched = this.spawn({
      runId: 'linux-bubblewrap-preflight',
      // /usr is a mandatory base mount of this provider, so this probes the provider itself
      // without assuming Runner's Node/vendor runtime closure is already configured.
      command: '/usr/bin/true',
      args: [],
      cwd: workspace,
      workspaceRoot: workspace,
      workspaceWrite: false,
      env,
    });
    await launched.exited;
    if (launched.child.exitCode !== 0) {
      throw new Error(
        `bubblewrap probe did not exit successfully (code ${String(launched.child.exitCode)}, signal ${String(launched.child.signalCode)})`,
      );
    }
  }

  spawn(request: AgentProcessLaunch): ContainedAgentProcess {
    const launch = buildLinuxBubblewrapArgs(request, this.readOnlyRoots, this.writeRoots);
    const child = this.spawnProcess(this.bubblewrapPath, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const exited = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      child.once('exit', () => finish());
      child.once('error', (error) => finish(error));
      if (child.exitCode !== null || child.signalCode !== null) finish();
    });
    // Consumers may observe this later; prevent an early failed spawn from becoming an unhandled
    // rejection while preserving the rejection for the eventual authority boundary.
    void exited.catch(() => undefined);
    return {
      child,
      exited,
      terminate: (signal = 'SIGKILL') => {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      },
    };
  }
}
