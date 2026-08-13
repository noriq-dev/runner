import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  type AgentProcessContainment,
  type CommissionedRuntimeAuthority,
  type ContainedAgentProcess,
  assertAgentProcessAuthority,
} from '../process-containment';
import { missionAgentEnv } from '../security';
import { GitBackend } from '../vcs/git';
import type { Workspace } from '../vcs/types';
import { type VerifyExec, runVerify } from '../verify';
import { WorktreeManager, runBranch } from '../worktree';
import type {
  MissionAcceptedRevisionHandoffRecorder,
  MissionCleanupExecutor,
  MissionEvidenceAction,
  MissionEvidenceRecorder,
  MissionValidationExecutor,
} from './harness';
import { JsonlMissionStore } from './jsonl-store';
import type {
  LocalMissionWorkspaceAdapter,
  LocalMissionWorkspaceAdapterCapabilities,
  LocalMissionWorkspaceResolution,
} from './local-runtime';
import {
  type MissionCheckpointState,
  type MissionChildState,
  type MissionState,
  latestCheckpoint,
  ownMissionValue,
} from './model';
import type {
  MissionObjective,
  MissionReviewArtifact,
  MissionValidationPolicy,
  RecordAcceptedRevisionHandoffAction,
  RecordCheckpointAction,
  RecordReviewAction,
  RecordValidationAction,
  RecordWorkspaceReconciledAction,
} from './protocol';
import { MAX_MISSION_VALIDATION_OUTPUT_BYTES } from './protocol';
import { canonicalMissionJson, validateMissionId } from './store';

const LEASE_RECORD_VERSION = 1 as const;
const MAX_LEASE_RECORD_BYTES = 128 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const execFileP = promisify(execFile);
const MAX_GIT_OBJECT_ROOTS = 16;
const MAX_VALIDATION_TIMEOUT_SECONDS = 86_400;
const GIT_REPOSITORY_OVERRIDE_ENV = Object.freeze([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_WORK_TREE',
]);

/** The sole cleanup obligation understood by {@link GitMissionWorkspaceAdapter}. */
export const GIT_MISSION_WORKSPACE_CLEANUP_ID = 'git-mission-workspace-v1';
export const GIT_MISSION_WORKSPACE_CLEANUP_PLAN: readonly string[] = Object.freeze([
  GIT_MISSION_WORKSPACE_CLEANUP_ID,
]);

export const GIT_MISSION_WORKSPACE_CAPABILITIES: LocalMissionWorkspaceAdapterCapabilities = Object.freeze({
  exactBaseRevision: true,
  exclusiveMissionLease: true,
  exactCheckpointRevision: true,
  exactRevisionValidation: true,
  restartReconciliation: true,
  preservesAcceptedRevision: true,
  preservedRevisionHandoff: true,
});

interface GitLeaseLocation {
  repoRoot: string;
  branch: string;
}

interface GitMissionLeaseRecord {
  version: typeof LEASE_RECORD_VERSION;
  missionId: string;
  repositoryKey: string;
  repositoryRoot: string;
  baseRevisionId: string;
  runId: string;
  branch: string;
  expectedLocalPath: string | null;
  leaseGeneration: string;
  workspace: Workspace | null;
  status: 'allocating' | 'active' | 'released';
  preservedRevisionId: string | null;
}

export interface GitMissionWorkspaceAdapterOptions {
  /** Canonical project identity expected in every mission objective. */
  repositoryKey: string;
  /** Repository in which the backend creates mission worktrees. */
  repositoryRoot: string;
  /** Private durable directory owned only by this adapter. */
  stateDirectory: string;
  /** A trusted Git backend with the exact mission-evidence capability. */
  backend: GitBackend;
  /**
   * Immutable machine authority covering every Git/VCS executable and the retained validation
   * boundary. This is asserted around each authority-bearing batch; a path or one-time hash is
   * not durable VCS authority.
   */
  runtimeAuthority: CommissionedRuntimeAuthority;
  /**
   * Canonical worktree root used by the backend, when Runner owns its construction. Supplying it
   * enables exact path authority and private/non-overlap preflight checks.
   */
  worktreeDirectory?: string;
  /** @internal Test seam used only when no containment provider has been bound. */
  validationExec?: VerifyExec;
  /** Optional environment inherited by child drivers after their own sanitization. */
  env?: NodeJS.ProcessEnv;
}

export interface LocalGitMissionWorkspaceAdapterOptions
  extends Omit<GitMissionWorkspaceAdapterOptions, 'backend'> {
  /** Private root under which Git materializes deterministic mission worktrees. */
  worktreeDirectory: string;
}

/** Standard local wiring; backend injection remains available for specialized trusted hosts. */
export function createGitMissionWorkspaceAdapter(
  options: LocalGitMissionWorkspaceAdapterOptions,
): GitMissionWorkspaceAdapter {
  if (!path.isAbsolute(options.worktreeDirectory)) {
    throw new Error('Git mission worktree directory must be absolute');
  }
  return new GitMissionWorkspaceAdapter({
    repositoryKey: options.repositoryKey,
    repositoryRoot: options.repositoryRoot,
    stateDirectory: options.stateDirectory,
    backend: new GitBackend(new WorktreeManager({ baseDir: options.worktreeDirectory })),
    runtimeAuthority: options.runtimeAuthority,
    worktreeDirectory: options.worktreeDirectory,
    ...(options.validationExec ? { validationExec: options.validationExec } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
}

interface AdapterConfiguration {
  repositoryRoot: string;
  stateDirectory: string;
  worktreeDirectory: string | null;
  agentGitRoot: string;
  objectRoots: readonly string[];
}

interface AgentGitView {
  viewDirectory: string;
  authorityPath: string;
  authorityDigest: string;
}

function errno(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalMissionJson(value), 'utf8').digest('hex');
}

async function gitOutput(args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
    GIT_TERMINAL_PROMPT: '0',
  };
  // Repository authority comes from the explicit cwd and command arguments. Ambient Git locator
  // variables can otherwise redirect even `rev-parse` to metadata outside the configured root.
  for (const key of GIT_REPOSITORY_OVERRIDE_ENV) delete childEnv[key];
  const result = await execFileP('git', [...args], {
    cwd,
    env: childEnv,
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
}

async function discoverGitObjectRoots(primary: string): Promise<readonly string[]> {
  const pending = [await realpath(primary)];
  const found = new Set<string>();
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (found.has(current)) continue;
    if (found.size >= MAX_GIT_OBJECT_ROOTS) {
      throw new Error(`Git object alternates exceed ${MAX_GIT_OBJECT_ROOTS} trusted roots`);
    }
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Git object root '${current}' must be a real directory`);
    }
    found.add(current);
    let alternates: string;
    try {
      alternates = await readFile(path.join(current, 'info', 'alternates'), 'utf8');
    } catch (error) {
      if (errno(error) === 'ENOENT') continue;
      throw error;
    }
    for (const line of alternates.split(/\r?\n/).filter(Boolean)) {
      if (line.includes('\0')) throw new Error('Git object alternate contains NUL');
      const candidate = path.isAbsolute(line) ? line : path.resolve(current, line);
      pending.push(await realpath(candidate));
    }
  }
  return Object.freeze([...found].sort());
}

function boundedText(value: string | null, fallback: string, max: number): string {
  const normalized = value?.trim() ?? '';
  return (normalized || fallback).slice(0, max);
}

function assertPrivateRegularFile(metadata: Stats, label: string): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${label} must be a real regular file with one link`);
  }
  if (
    process.platform !== 'win32' &&
    ((typeof process.getuid === 'function' && metadata.uid !== process.getuid()) ||
      (metadata.mode & 0o077) !== 0)
  ) {
    throw new Error(`${label} must be owned by Runner with mode 0600`);
  }
}

async function ensurePrivateDirectory(candidate: string, label: string): Promise<string> {
  await mkdir(candidate, { recursive: true, mode: 0o700 });
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  if (
    process.platform !== 'win32' &&
    ((typeof process.getuid === 'function' && metadata.uid !== process.getuid()) ||
      (metadata.mode & 0o077) !== 0)
  ) {
    throw new Error(`${label} must be owned by Runner with mode 0700`);
  }
  return realpath(candidate);
}

async function canonicalProspectivePath(candidate: string): Promise<string> {
  const suffix: string[] = [];
  let cursor = candidate;
  for (;;) {
    try {
      const existing = await realpath(cursor);
      return path.join(existing, ...suffix);
    } catch (error) {
      if (errno(error) !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function pathContains(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function assertNonOverlapping(left: string, right: string, labels: [string, string]): void {
  if (pathContains(left, right) || pathContains(right, left)) {
    throw new Error(`${labels[0]} and ${labels[1]} must not overlap`);
  }
}

function exactString(value: unknown, name: string, max = 1_024): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.includes('\0')) {
    throw new Error(`${name} must be a bounded non-empty string without NUL`);
  }
  return value;
}

function exactGitRevision(value: unknown, name: string): string {
  const revision = exactString(value, name, 64);
  if (!GIT_OBJECT_ID.test(revision)) throw new Error(`${name} must be a full lowercase Git object id`);
  return revision;
}

function utf8Tail(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength <= maxBytes) return value;
  let start = encoded.byteLength - maxBytes;
  while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) start += 1;
  return encoded.subarray(start).toString('utf8');
}

async function runContainedValidation(
  containment: AgentProcessContainment,
  request: {
    runId: string;
    command: string;
    shell: string | null;
    timeoutSeconds: number;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    readOnlyRoots: readonly string[];
    protectedWorkspaceReadOnlyPaths: readonly string[];
    signal: AbortSignal;
  },
): Promise<{
  passed: boolean;
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
}> {
  const shell = request.shell ?? '/bin/sh';
  const launched: ContainedAgentProcess = containment.spawn({
    runId: request.runId,
    command: shell,
    args: ['-c', request.command],
    cwd: request.cwd,
    workspaceRoot: request.cwd,
    workspaceWrite: true,
    env: missionAgentEnv(request.env),
    additionalReadOnlyRoots: request.readOnlyRoots,
    protectedWorkspaceReadOnlyPaths: request.protectedWorkspaceReadOnlyPaths,
  });
  let output = '';
  const capture = (chunk: Buffer | string) => {
    output = utf8Tail(`${output}${String(chunk)}`, MAX_MISSION_VALIDATION_OUTPUT_BYTES);
  };
  launched.child.stdout.on('data', capture);
  launched.child.stderr.on('data', capture);
  let timedOut = false;
  let aborted = request.signal.aborted;
  const terminate = () => launched.terminate('SIGKILL');
  const onAbort = () => {
    aborted = true;
    terminate();
  };
  request.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, request.timeoutSeconds * 1_000);
  timer.unref?.();
  try {
    await launched.exited;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', onAbort);
  }
  const exitCode = launched.child.exitCode;
  return {
    passed: !aborted && !timedOut && exitCode === 0,
    exitCode,
    output:
      `${output.trim()}${aborted ? '\n[Noriq] Validation was cancelled after process-tree settlement.' : ''}`.trim(),
    timedOut,
    aborted,
  };
}

function exactValidationPolicy(policy: MissionValidationPolicy): MissionValidationPolicy {
  const policyId = exactString(policy.policyId, 'mission validation policyId', 256);
  if (policy.kind === 'none') {
    return {
      kind: 'none',
      policyId,
      reason: exactString(policy.reason, 'mission validation none reason', 16_384),
    };
  }
  if (policy.kind !== 'command') throw new Error('mission validation policy kind is unsupported');
  if (
    !Number.isSafeInteger(policy.timeoutSeconds) ||
    policy.timeoutSeconds < 1 ||
    policy.timeoutSeconds > MAX_VALIDATION_TIMEOUT_SECONDS
  ) {
    throw new Error(
      `mission validation timeoutSeconds must be an integer from 1 to ${MAX_VALIDATION_TIMEOUT_SECONDS}`,
    );
  }
  return {
    kind: 'command',
    policyId,
    command: exactString(policy.command, 'mission validation command', 16_384),
    timeoutSeconds: policy.timeoutSeconds,
    shell: policy.shell === null ? null : exactString(policy.shell, 'mission validation shell', 512),
  };
}

function leaseRunId(repositoryRoot: string, repositoryKey: string, missionId: string): string {
  return `mission-${digest({ version: LEASE_RECORD_VERSION, repositoryRoot, repositoryKey, missionId }).slice(0, 48)}`;
}

function recordFilename(missionId: string): string {
  validateMissionId(missionId);
  return `lease-${createHash('sha256').update(missionId, 'utf8').digest('hex')}.json`;
}

function locationOf(workspace: Workspace): GitLeaseLocation {
  const value = workspace.location as Partial<GitLeaseLocation> | null | undefined;
  if (
    !value ||
    typeof value.repoRoot !== 'string' ||
    typeof value.branch !== 'string' ||
    Object.keys(value).some((key) => key !== 'repoRoot' && key !== 'branch')
  ) {
    throw new Error('durable mission workspace has an invalid Git location');
  }
  return { repoRoot: value.repoRoot, branch: value.branch };
}

function validateWorkspace(
  candidate: unknown,
  expected: {
    runId: string;
    repositoryRoot: string;
    baseRevisionId: string;
    expectedLocalPath?: string | null;
  },
): Workspace {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('durable mission workspace is invalid');
  }
  const workspace = candidate as Partial<Workspace>;
  const branch = runBranch(expected.runId);
  if (
    workspace.runId !== expected.runId ||
    typeof workspace.localPath !== 'string' ||
    !path.isAbsolute(workspace.localPath) ||
    workspace.localPath.includes('\0') ||
    (expected.expectedLocalPath != null && workspace.localPath !== expected.expectedLocalPath) ||
    workspace.readOnly !== false ||
    workspace.baseId !== expected.baseRevisionId ||
    workspace.workRef !== branch
  ) {
    throw new Error('durable mission workspace does not match its exact lease authority');
  }
  const location = locationOf(workspace as Workspace);
  if (location.repoRoot !== expected.repositoryRoot || location.branch !== branch) {
    throw new Error('durable mission workspace Git provenance does not match its lease authority');
  }
  return {
    runId: workspace.runId,
    localPath: workspace.localPath,
    readOnly: false,
    baseId: workspace.baseId,
    workRef: workspace.workRef,
    location,
  };
}

function parseRecord(
  raw: string,
  expected: {
    missionId: string;
    repositoryKey: string;
    repositoryRoot: string;
    baseRevisionId: string;
    runId: string;
    branch: string;
    expectedLocalPath: string | null;
  },
): GitMissionLeaseRecord {
  if (Buffer.byteLength(raw, 'utf8') > MAX_LEASE_RECORD_BYTES) {
    throw new Error('Git mission lease record is oversized');
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new Error('Git mission lease record is not valid JSON');
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('Git mission lease record root is invalid');
  }
  const record = candidate as Partial<GitMissionLeaseRecord>;
  if (
    record.version !== LEASE_RECORD_VERSION ||
    record.missionId !== expected.missionId ||
    record.repositoryKey !== expected.repositoryKey ||
    record.repositoryRoot !== expected.repositoryRoot ||
    record.baseRevisionId !== expected.baseRevisionId ||
    record.runId !== expected.runId ||
    record.branch !== expected.branch ||
    record.expectedLocalPath !== expected.expectedLocalPath ||
    typeof record.leaseGeneration !== 'string' ||
    !UUID_V4.test(record.leaseGeneration) ||
    (record.status !== 'allocating' && record.status !== 'active' && record.status !== 'released') ||
    (record.preservedRevisionId !== null && !GIT_OBJECT_ID.test(record.preservedRevisionId ?? ''))
  ) {
    throw new Error('Git mission lease record does not match its exact mission authority');
  }
  if (
    (record.status === 'allocating' && (record.workspace !== null || record.preservedRevisionId !== null)) ||
    (record.status === 'active' && (record.workspace == null || record.preservedRevisionId !== null)) ||
    (record.status === 'released' && record.preservedRevisionId === null)
  ) {
    throw new Error('Git mission lease record lifecycle is invalid');
  }
  const workspace =
    record.workspace == null
      ? null
      : validateWorkspace(record.workspace, {
          runId: expected.runId,
          repositoryRoot: expected.repositoryRoot,
          baseRevisionId: expected.baseRevisionId,
          expectedLocalPath: expected.expectedLocalPath,
        });
  return {
    version: LEASE_RECORD_VERSION,
    missionId: record.missionId,
    repositoryKey: record.repositoryKey,
    repositoryRoot: record.repositoryRoot,
    baseRevisionId: record.baseRevisionId,
    runId: record.runId,
    branch: record.branch,
    expectedLocalPath: record.expectedLocalPath,
    leaseGeneration: record.leaseGeneration,
    workspace,
    status: record.status,
    preservedRevisionId: record.preservedRevisionId as string | null,
  };
}

/**
 * Concrete single-repository Git workspace authority for the local mission runtime.
 *
 * One durable record binds a mission id, immutable base, deterministic run branch, physical
 * worktree, and random lease generation. All record transitions run beneath a recoverable
 * cross-process bakery lock. Git owns branch/worktree atomicity; this adapter owns the mission
 * binding and never calls destructive legacy `dispose`.
 */
export class GitMissionWorkspaceAdapter implements LocalMissionWorkspaceAdapter {
  readonly capabilities = GIT_MISSION_WORKSPACE_CAPABILITIES;
  readonly cleanupPlan = GIT_MISSION_WORKSPACE_CLEANUP_PLAN;
  readonly evidence: MissionEvidenceRecorder = this;
  readonly validation: MissionValidationExecutor = this;
  readonly cleanup: MissionCleanupExecutor = this;
  readonly acceptedRevisionHandoff: MissionAcceptedRevisionHandoffRecorder = this;

  private readonly repositoryKey: string;
  private readonly requestedRepositoryRoot: string;
  private readonly requestedStateDirectory: string;
  private readonly requestedWorktreeDirectory: string | null;
  private readonly backend: GitBackend;
  private readonly runtimeAuthority: CommissionedRuntimeAuthority;
  private readonly runtimeAuthorityFingerprint: `sha256:${string}`;
  private readonly validationExec?: VerifyExec;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly locks: JsonlMissionStore;
  private containment: AgentProcessContainment | null = null;
  private configuration: Promise<AdapterConfiguration> | null = null;

  constructor(options: GitMissionWorkspaceAdapterOptions) {
    this.repositoryKey = exactString(options.repositoryKey, 'repositoryKey');
    if (!path.isAbsolute(options.repositoryRoot)) throw new Error('Git repository root must be absolute');
    if (!path.isAbsolute(options.stateDirectory)) {
      throw new Error('Git mission workspace state directory must be absolute');
    }
    if (options.worktreeDirectory !== undefined && !path.isAbsolute(options.worktreeDirectory)) {
      throw new Error('Git mission worktree directory must be absolute');
    }
    this.requestedRepositoryRoot = options.repositoryRoot;
    this.requestedStateDirectory = options.stateDirectory;
    this.requestedWorktreeDirectory = options.worktreeDirectory ?? null;
    this.backend = options.backend;
    if (
      typeof options.runtimeAuthority.authorityFingerprint !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(options.runtimeAuthority.authorityFingerprint) ||
      typeof options.runtimeAuthority.assertAuthority !== 'function'
    ) {
      throw new Error('Git mission workspace requires one commissioned immutable runtime authority');
    }
    this.runtimeAuthority = options.runtimeAuthority;
    this.runtimeAuthorityFingerprint = options.runtimeAuthority.authorityFingerprint;
    this.validationExec = options.validationExec;
    this.env = options.env ? { ...options.env } : undefined;
    this.locks = new JsonlMissionStore(path.join(options.stateDirectory, 'locks'), {
      controllerTimeoutMs: 30_000,
    });
  }

  bindContainment(containment: AgentProcessContainment): void {
    if (this.containment && this.containment !== containment) {
      throw new Error('Git mission workspace adapter is already bound to another containment provider');
    }
    if (containment.authorityFingerprint !== this.runtimeAuthorityFingerprint) {
      throw new Error('Git mission containment does not match its commissioned VCS runtime authority');
    }
    this.containment = containment;
  }

  private assertRuntimeAuthority(): Promise<void> {
    return assertAgentProcessAuthority(this.runtimeAuthority, this.runtimeAuthorityFingerprint);
  }

  private async configure(): Promise<AdapterConfiguration> {
    this.configuration ??= (async () => {
      await this.assertRuntimeAuthority();
      const repositoryRoot = await realpath(this.requestedRepositoryRoot);
      const repositoryMetadata = await lstat(repositoryRoot);
      if (!repositoryMetadata.isDirectory()) throw new Error('Git repository root must be a directory');
      let markerMetadata: Stats;
      try {
        markerMetadata = await lstat(path.join(repositoryRoot, '.git'));
      } catch (error) {
        if (errno(error) === 'ENOENT') {
          throw new Error('Git mission repository root must itself contain an explicit .git marker');
        }
        throw error;
      }
      if (markerMetadata.isSymbolicLink() || (!markerMetadata.isDirectory() && !markerMetadata.isFile())) {
        throw new Error('Git mission repository root .git marker must be a real directory or file');
      }
      const topLevelText = (
        await gitOutput(['rev-parse', '--show-toplevel'], repositoryRoot, this.env)
      ).trim();
      if (!topLevelText || topLevelText.includes('\0') || !path.isAbsolute(topLevelText)) {
        throw new Error('Git did not report an absolute repository top-level path');
      }
      const topLevel = await realpath(topLevelText);
      if (topLevel !== repositoryRoot) {
        throw new Error(
          `Git repository top-level '${topLevel}' does not match configured mission root '${repositoryRoot}'`,
        );
      }
      const registeredWorktreeFields = (
        await gitOutput(['worktree', 'list', '--porcelain', '-z'], repositoryRoot, this.env)
      ).split('\0');
      let registeredAtExactRoot = false;
      for (const field of registeredWorktreeFields) {
        if (!field.startsWith('worktree ')) continue;
        const candidate = field.slice('worktree '.length);
        if (!path.isAbsolute(candidate)) continue;
        try {
          if ((await realpath(candidate)) === repositoryRoot) {
            registeredAtExactRoot = true;
            break;
          }
        } catch {
          // A stale registration is not authority for this configured root.
        }
      }
      if (!registeredAtExactRoot) {
        throw new Error('Git does not register the configured mission root as an exact worktree');
      }
      const prospectiveState = await canonicalProspectivePath(this.requestedStateDirectory);
      const prospectiveWorktrees = this.requestedWorktreeDirectory
        ? await canonicalProspectivePath(this.requestedWorktreeDirectory)
        : null;
      if (prospectiveWorktrees) {
        assertNonOverlapping(prospectiveWorktrees, repositoryRoot, [
          'Git mission worktree directory',
          'Git repository root',
        ]);
        assertNonOverlapping(prospectiveWorktrees, prospectiveState, [
          'Git mission worktree directory',
          'Git mission workspace state directory',
        ]);
      }
      const stateDirectory = await ensurePrivateDirectory(
        this.requestedStateDirectory,
        'Git mission workspace state directory',
      );
      const agentGitRoot = await ensurePrivateDirectory(
        path.join(stateDirectory, 'agent-git-views'),
        'Git mission agent-view directory',
      );
      const worktreeDirectory = this.requestedWorktreeDirectory
        ? await ensurePrivateDirectory(this.requestedWorktreeDirectory, 'Git mission worktree directory')
        : null;
      if (worktreeDirectory) {
        assertNonOverlapping(worktreeDirectory, repositoryRoot, [
          'Git mission worktree directory',
          'Git repository root',
        ]);
        assertNonOverlapping(worktreeDirectory, stateDirectory, [
          'Git mission worktree directory',
          'Git mission workspace state directory',
        ]);
      }
      const commonDirectoryText = (
        await gitOutput(['rev-parse', '--path-format=absolute', '--git-common-dir'], repositoryRoot, this.env)
      ).trim();
      if (!commonDirectoryText || commonDirectoryText.includes('\0')) {
        throw new Error('Git did not report a bounded common metadata directory');
      }
      const commonDirectory = await realpath(commonDirectoryText);
      const objectRoots = await discoverGitObjectRoots(path.join(commonDirectory, 'objects'));
      const configured = { repositoryRoot, stateDirectory, worktreeDirectory, agentGitRoot, objectRoots };
      await this.assertRuntimeAuthority();
      return configured;
    })();
    return this.configuration;
  }

  private stateAuthority(state: MissionState, config: AdapterConfiguration) {
    return this.objectiveAuthority(state.missionId, state.objective, config);
  }

  private objectiveAuthority(
    missionId: string,
    objective: MissionObjective | undefined | null,
    config: AdapterConfiguration,
  ) {
    validateMissionId(missionId);
    if (!objective) throw new Error(`mission '${missionId}' has no durable objective`);
    if (objective.repositoryKey !== this.repositoryKey) {
      throw new Error(`mission '${missionId}' repositoryKey does not match this trusted Git adapter`);
    }
    const baseRevisionId = exactGitRevision(objective.baseRevision, 'mission objective.baseRevision');
    const runId = leaseRunId(config.repositoryRoot, this.repositoryKey, missionId);
    const branch = runBranch(runId);
    return {
      missionId,
      repositoryKey: this.repositoryKey,
      repositoryRoot: config.repositoryRoot,
      baseRevisionId,
      runId,
      branch,
      expectedLocalPath: config.worktreeDirectory
        ? path.join(config.worktreeDirectory, `${path.basename(config.repositoryRoot)}-${runId}`)
        : null,
    };
  }

  private recordPath(config: AdapterConfiguration, missionId: string): string {
    return path.join(config.stateDirectory, recordFilename(missionId));
  }

  private async readRecord(
    config: AdapterConfiguration,
    authority: ReturnType<GitMissionWorkspaceAdapter['stateAuthority']>,
  ): Promise<GitMissionLeaseRecord | null> {
    const filename = this.recordPath(config, authority.missionId);
    let pathMetadata: Stats;
    try {
      pathMetadata = await lstat(filename);
    } catch (error) {
      if (errno(error) === 'ENOENT') return null;
      throw error;
    }
    assertPrivateRegularFile(pathMetadata, 'Git mission lease record');
    if (pathMetadata.size > MAX_LEASE_RECORD_BYTES) throw new Error('Git mission lease record is oversized');
    const handle = await open(filename, constants.O_RDONLY | NO_FOLLOW);
    try {
      const opened = await handle.stat();
      assertPrivateRegularFile(opened, 'Git mission lease record');
      if (opened.dev !== pathMetadata.dev || opened.ino !== pathMetadata.ino) {
        throw new Error('Git mission lease record changed while opening');
      }
      return parseRecord(await handle.readFile('utf8'), authority);
    } finally {
      await handle.close();
    }
  }

  private async writeRecord(config: AdapterConfiguration, record: GitMissionLeaseRecord): Promise<void> {
    const body = `${canonicalMissionJson(record)}\n`;
    if (Buffer.byteLength(body, 'utf8') > MAX_LEASE_RECORD_BYTES) {
      throw new Error('Git mission lease record is oversized');
    }
    const temporary = path.join(config.stateDirectory, `.lease-${randomUUID()}.tmp`);
    let renamed = false;
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(body, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.recordPath(config, record.missionId));
      renamed = true;
      const directory = await open(config.stateDirectory, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      if (!renamed) await unlink(temporary).catch(() => undefined);
    }
  }

  private async locked<T>(missionId: string, operation: () => Promise<T>): Promise<T> {
    await this.assertRuntimeAuthority();
    const lease = await this.locks.acquireController(`git-workspace:${digest(missionId)}`);
    try {
      await this.assertRuntimeAuthority();
      const result = await operation();
      await this.assertRuntimeAuthority();
      return result;
    } finally {
      await lease.release();
    }
  }

  /** Prove the canonical repository and backend can resolve an exact commit without mutation. */
  async preflight(): Promise<void> {
    await this.assertRuntimeAuthority();
    const config = await this.configure();
    if (this.backend.kind !== 'git') {
      throw new Error(`Git mission workspace adapter received backend kind '${this.backend.kind}'`);
    }
    const current = await this.backend.currentBase(config.repositoryRoot);
    if (!current.ok) {
      throw new Error(current.detail ?? `Git repository '${config.repositoryRoot}' has no resolvable HEAD`);
    }
    const revisionId = exactGitRevision(current.baseId, 'Git repository HEAD');
    if (!(await this.backend.targetExists(config.repositoryRoot, revisionId))) {
      throw new Error(`Git repository HEAD '${revisionId}' does not resolve to an exact commit`);
    }
    await this.assertRuntimeAuthority();
  }

  /**
   * Validate mission-specific VCS authority before any guide turn is paid. This is read-only over
   * the repository: the adapter lock protects its private record/branch comparison, while a lease
   * is created only later by `resolve` after a child attempt is durable.
   */
  async validateMissionAuthority(missionId: string, objective: MissionObjective | undefined): Promise<void> {
    await this.assertRuntimeAuthority();
    const config = await this.configure();
    const authority = this.objectiveAuthority(missionId, objective, config);
    if (!(await this.backend.targetExists(config.repositoryRoot, authority.baseRevisionId))) {
      throw new Error(
        `mission objective.baseRevision '${authority.baseRevisionId}' does not resolve to an exact Git commit`,
      );
    }
    await this.locked(missionId, async () => {
      const record = await this.readRecord(config, authority);
      const branchRevisionId = await this.optionalBranchRevision(authority);
      if (!record) {
        if (branchRevisionId !== null) {
          throw new Error(
            `refusing unrecorded Git mission branch '${authority.branch}'; lease creation may have become ambiguous`,
          );
        }
        return;
      }
      if (record.status === 'allocating') {
        if (branchRevisionId !== null && branchRevisionId !== authority.baseRevisionId) {
          throw new Error(
            `allocating Git mission branch '${authority.branch}' names ${branchRevisionId}, expected ${authority.baseRevisionId}`,
          );
        }
        return;
      }
      if (record.status === 'released' && record.workspace === null) {
        if (branchRevisionId !== null) {
          throw new Error(
            `released unmaterialized Git mission lease unexpectedly has branch '${authority.branch}'`,
          );
        }
        return;
      }
      const workspace = this.workspaceFor(record);
      if (workspace.runId !== authority.runId || workspace.workRef !== authority.branch) {
        throw new Error(
          `durable Git mission lease does not match deterministic branch '${authority.branch}'`,
        );
      }
      if (branchRevisionId === null) {
        throw new Error(`durable Git mission lease branch '${authority.branch}' is missing`);
      }
      if (record.status === 'released' && branchRevisionId !== record.preservedRevisionId) {
        throw new Error(
          `released Git mission branch '${authority.branch}' names ${branchRevisionId}, expected ${record.preservedRevisionId}`,
        );
      }
    });
  }

  private workspaceFor(record: GitMissionLeaseRecord): Workspace {
    if (record.workspace === null) {
      throw new Error(`Git mission lease '${record.missionId}' has no materialized workspace`);
    }
    return record.workspace;
  }

  private async validateMaterializedWorkspace(
    candidate: unknown,
    authority: ReturnType<GitMissionWorkspaceAdapter['stateAuthority']>,
  ): Promise<Workspace> {
    const raw = validateWorkspace(candidate, {
      runId: authority.runId,
      repositoryRoot: authority.repositoryRoot,
      baseRevisionId: authority.baseRevisionId,
    });
    const localPath = await realpath(raw.localPath);
    return validateWorkspace(
      { ...raw, localPath },
      {
        runId: authority.runId,
        repositoryRoot: authority.repositoryRoot,
        baseRevisionId: authority.baseRevisionId,
        expectedLocalPath: authority.expectedLocalPath,
      },
    );
  }

  private async optionalBranchRevision(
    authority: ReturnType<GitMissionWorkspaceAdapter['stateAuthority']>,
  ): Promise<string | null> {
    const result = await this.backend.currentBase(authority.repositoryRoot, `refs/heads/${authority.branch}`);
    return result.ok ? exactGitRevision(result.baseId, `Git mission branch '${authority.branch}'`) : null;
  }

  private expectedRevision(state: MissionState): string {
    return exactGitRevision(
      latestCheckpoint(state)?.revisionId ?? state.objective?.baseRevision,
      'mission expected workspace revision',
    );
  }

  private expectedChildRevision(state: MissionState, child: MissionChildState): string {
    if (!child.subjectCheckpointId) return this.expectedRevision(state);
    const subject = ownMissionValue(state.checkpoints, child.subjectCheckpointId);
    if (!subject) {
      throw new Error(
        `child '${child.childId}' references unknown checkpoint '${child.subjectCheckpointId}'`,
      );
    }
    return exactGitRevision(subject.revisionId, `child '${child.childId}' subject revision`);
  }

  private async inspectExact(record: GitMissionLeaseRecord, expectedRevisionId: string): Promise<void> {
    const inspection = await this.backend.inspectWorkspace(this.workspaceFor(record));
    if (!inspection.clean || inspection.revisionId !== expectedRevisionId) {
      throw new Error(
        `Git mission workspace is ${inspection.clean ? 'clean' : 'dirty'} at ${inspection.revisionId}; expected clean ${expectedRevisionId}`,
      );
    }
  }

  private async finishAllocation(
    record: GitMissionLeaseRecord,
    config: AdapterConfiguration,
    expectedRevisionId: string,
  ): Promise<GitMissionLeaseRecord> {
    if (record.status !== 'allocating') throw new Error('Git mission lease is not allocating');
    if (expectedRevisionId !== record.baseRevisionId) {
      throw new Error('an unfinished Git workspace allocation may only resume at its exact base revision');
    }
    let branchRevisionId = await this.optionalBranchRevision(record);
    if (branchRevisionId === null) {
      await this.backend.createTarget(record.repositoryRoot, record.branch, record.baseRevisionId);
      branchRevisionId = await this.optionalBranchRevision(record);
    }
    if (branchRevisionId !== record.baseRevisionId) {
      throw new Error(
        `allocating Git mission branch '${record.branch}' names ${String(branchRevisionId)}, expected ${record.baseRevisionId}`,
      );
    }
    const workspace = await this.validateMaterializedWorkspace(
      await this.backend.lease(record.repositoryRoot, record.runId, {
        fromTarget: record.baseRevisionId,
      }),
      record,
    );
    const active: GitMissionLeaseRecord = {
      ...record,
      workspace,
      status: 'active',
    };
    await this.inspectExact(active, expectedRevisionId);
    await this.writeRecord(config, active);
    return active;
  }

  private async ensureActiveRecord(
    state: MissionState,
    config: AdapterConfiguration,
    expectedRevisionId: string,
  ): Promise<GitMissionLeaseRecord> {
    const authority = this.stateAuthority(state, config);
    const existing = await this.readRecord(config, authority);
    if (existing?.status === 'released') {
      throw new Error(`Git mission workspace for '${state.missionId}' has already been released`);
    }
    if (existing?.status === 'allocating') {
      return this.finishAllocation(existing, config, expectedRevisionId);
    }
    if (existing?.status === 'active') {
      const existingWorkspace = this.workspaceFor(existing);
      try {
        await this.inspectExact(existing, expectedRevisionId);
        return existing;
      } catch (error) {
        let pathMissing = false;
        try {
          await lstat(existingWorkspace.localPath);
        } catch (pathError) {
          if (errno(pathError) === 'ENOENT') pathMissing = true;
          else throw pathError;
        }
        if (!pathMissing) throw error;
        if (!(await this.backend.targetExists(authority.repositoryRoot, existingWorkspace.workRef))) {
          throw new Error(
            `cannot adopt Git mission workspace '${existingWorkspace.workRef}': its durable branch is missing`,
          );
        }
        const adopted = await this.backend.lease(authority.repositoryRoot, existingWorkspace.runId, {
          fromTarget: authority.baseRevisionId,
        });
        const workspace = await this.validateMaterializedWorkspace(adopted, authority);
        const replacement: GitMissionLeaseRecord = {
          ...existing,
          leaseGeneration: randomUUID(),
          workspace,
        };
        await this.inspectExact(replacement, expectedRevisionId);
        await this.writeRecord(config, replacement);
        return replacement;
      }
    }

    if ((await this.optionalBranchRevision(authority)) !== null) {
      throw new Error(
        `refusing unrecorded Git mission branch '${authority.branch}'; lease creation may have become ambiguous`,
      );
    }
    const intent: GitMissionLeaseRecord = {
      version: LEASE_RECORD_VERSION,
      ...authority,
      leaseGeneration: randomUUID(),
      workspace: null,
      status: 'allocating',
      preservedRevisionId: null,
    };
    // This fsync is the authority boundary: no Git ref or worktree is created before the intent.
    await this.writeRecord(config, intent);
    return this.finishAllocation(intent, config, expectedRevisionId);
  }

  private async writePrivateJson(filename: string, value: unknown): Promise<void> {
    const body = `${canonicalMissionJson(value)}\n`;
    const temporary = `${filename}.${randomUUID()}.tmp`;
    let renamed = false;
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(body, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, filename);
      renamed = true;
      const directory = await open(path.dirname(filename), constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      if (!renamed) await unlink(temporary).catch(() => undefined);
    }
  }

  private async readGitViewAuthority(filename: string): Promise<unknown | null> {
    let metadata: Stats;
    try {
      metadata = await lstat(filename);
    } catch (error) {
      if (errno(error) === 'ENOENT') return null;
      throw error;
    }
    assertPrivateRegularFile(metadata, 'Git mission agent-view authority');
    const handle = await open(filename, constants.O_RDONLY | NO_FOLLOW);
    try {
      const body = await handle.readFile('utf8');
      if (Buffer.byteLength(body, 'utf8') > MAX_LEASE_RECORD_BYTES) {
        throw new Error('Git mission agent-view authority is oversized');
      }
      return JSON.parse(body) as unknown;
    } finally {
      await handle.close();
    }
  }

  private async ensureAgentGitView(
    state: MissionState,
    child: MissionChildState,
    config: AdapterConfiguration,
    workspace: Workspace,
    revisionId: string,
    leaseGeneration: string,
  ): Promise<AgentGitView> {
    if (!child.attemptId) throw new Error(`running child '${child.childId}' has no attempt id`);
    const missionRoot = await ensurePrivateDirectory(
      path.join(config.agentGitRoot, digest({ missionId: state.missionId })),
      'Git mission private agent-view root',
    );
    const viewId = digest({
      missionId: state.missionId,
      childId: child.childId,
      attemptId: child.attemptId,
      revisionId,
      leaseGeneration,
    });
    const viewDirectory = path.join(missionRoot, `view-${viewId}`);
    const authorityPath = path.join(missionRoot, `view-${viewId}.json`);
    const authority = {
      version: 1,
      missionId: state.missionId,
      childId: child.childId,
      attemptId: child.attemptId,
      workspace: workspace.localPath,
      revisionId,
      leaseGeneration,
      viewDirectory,
      objectRoots: config.objectRoots,
    };
    const authorityDigest = digest(authority);
    const existing = await this.readGitViewAuthority(authorityPath);
    if (existing !== null) {
      if (canonicalMissionJson(existing) !== canonicalMissionJson(authority)) {
        throw new Error('Git mission agent-view authority changed for an existing attempt');
      }
      const metadata = await lstat(viewDirectory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error('Git mission agent view is no longer a real directory');
      }
      return { viewDirectory, authorityPath, authorityDigest };
    }

    await rm(viewDirectory, { recursive: true, force: true });
    await mkdir(viewDirectory, { recursive: false, mode: 0o700 });
    const runGitView = async (args: readonly string[]): Promise<void> => {
      await gitOutput(['-c', 'core.hooksPath=/dev/null', ...args], workspace.localPath, {
        ...this.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      });
    };
    try {
      await runGitView(['init', '--bare', '--quiet', viewDirectory]);
      await runGitView(['--git-dir', viewDirectory, 'config', 'core.bare', 'false']);
      await runGitView(['--git-dir', viewDirectory, 'config', 'core.worktree', workspace.localPath]);
      await runGitView(['--git-dir', viewDirectory, 'config', 'core.hooksPath', '/dev/null']);
      const alternatesPath = path.join(viewDirectory, 'objects', 'info', 'alternates');
      const alternates = await open(
        alternatesPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
        0o600,
      );
      try {
        await alternates.writeFile(`${config.objectRoots.join('\n')}\n`, 'utf8');
        await alternates.sync();
      } finally {
        await alternates.close();
      }
      await runGitView([
        '--git-dir',
        viewDirectory,
        '--work-tree',
        workspace.localPath,
        'read-tree',
        revisionId,
      ]);
      await runGitView(['--git-dir', viewDirectory, 'update-ref', '--no-deref', 'HEAD', revisionId]);
      await this.writePrivateJson(authorityPath, authority);
      return { viewDirectory, authorityPath, authorityDigest };
    } catch (error) {
      await rm(viewDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async verifyAgentGitView(view: AgentGitView): Promise<void> {
    const authority = await this.readGitViewAuthority(view.authorityPath);
    if (authority === null || digest(authority) !== view.authorityDigest) {
      throw new Error('Git mission agent-view authority is missing or changed');
    }
    const metadata = await lstat(view.viewDirectory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('Git mission agent view disappeared before child launch');
    }
  }

  async resolve(state: MissionState, child: MissionChildState): Promise<LocalMissionWorkspaceResolution> {
    await this.assertRuntimeAuthority();
    const durableChild = ownMissionValue(state.children, child.childId);
    if (
      !durableChild ||
      durableChild.status !== 'running' ||
      canonicalMissionJson(durableChild) !== canonicalMissionJson(child)
    ) {
      throw new Error(`child '${child.childId}' does not own a durable running mission attempt`);
    }
    const config = await this.configure();
    const expectedRevisionId = this.expectedChildRevision(state, child);
    const record = await this.locked(state.missionId, () =>
      this.ensureActiveRecord(state, config, expectedRevisionId),
    );
    const generation = record.leaseGeneration;
    const workspace = this.workspaceFor(record);
    const gitView = await this.locked(state.missionId, () =>
      this.ensureAgentGitView(state, child, config, workspace, expectedRevisionId, generation),
    );
    return {
      cwd: workspace.localPath,
      revisionId: expectedRevisionId,
      leaseGeneration: generation,
      verifyLaunchAuthority: async () => {
        await this.locked(state.missionId, async () => {
          const authority = this.stateAuthority(state, config);
          const current = await this.readRecord(config, authority);
          if (!current || current.status !== 'active' || current.leaseGeneration !== generation) {
            throw new Error('Git mission workspace lease generation changed before child launch');
          }
          if (canonicalMissionJson(current.workspace) !== canonicalMissionJson(record.workspace)) {
            throw new Error('Git mission workspace identity changed before child launch');
          }
          await this.inspectExact(current, expectedRevisionId);
          await this.verifyAgentGitView(gitView);
        });
      },
      trustedEnv: {
        GIT_DIR: gitView.viewDirectory,
        GIT_WORK_TREE: workspace.localPath,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
      containmentReadOnlyRoots: config.objectRoots,
      // The child receives a private GIT_DIR, but the physical worktree still contains Git's
      // administrative locator at `.git`. A writable child must never be able to retarget that
      // locator at attacker-controlled metadata before post-child evidence is collected.
      protectedWorkspaceReadOnlyPaths: ['.git'],
      containmentWriteRoots: [gitView.viewDirectory],
      ...(this.env ? { env: { ...this.env } } : {}),
    };
  }

  private checkpointAction(
    state: MissionState,
    child: MissionChildState,
    evidence: Awaited<ReturnType<GitBackend['checkpointExact']>>,
  ): RecordCheckpointAction {
    const parent = latestCheckpoint(state);
    return {
      type: 'record-checkpoint',
      checkpointId: `git-checkpoint:${digest({
        missionId: state.missionId,
        childId: child.childId,
        attemptId: child.attemptId,
      })}`,
      revisionId: evidence.revisionId,
      authorChildId: child.childId,
      changed: evidence.changed,
      parentCheckpointId: parent?.checkpointId ?? null,
      clean: evidence.clean,
      description: boundedText(child.summary, `Git checkpoint for mission child '${child.childId}'.`, 16_384),
    };
  }

  private reviewAction(
    state: MissionState,
    child: MissionChildState,
    artifact: MissionReviewArtifact,
  ): RecordReviewAction {
    return {
      type: 'record-review',
      reviewId: `git-review:${digest({
        missionId: state.missionId,
        childId: child.childId,
        attemptId: child.attemptId,
        checkpointId: artifact.checkpointId,
        revisionId: artifact.revisionId,
      })}`,
      reviewerChildId: child.childId,
      checkpointId: artifact.checkpointId,
      revisionId: artifact.revisionId,
      verdict: artifact.verdict,
      highestSeverity: artifact.highestSeverity,
      summary: artifact.summary,
    };
  }

  async recordAfterChild(
    state: MissionState,
    child: MissionChildState,
  ): Promise<readonly MissionEvidenceAction[]> {
    await this.assertRuntimeAuthority();
    if (!['succeeded', 'failed', 'cancelled', 'lost'].includes(child.status)) {
      throw new Error(`cannot record Git evidence for non-terminal child '${child.childId}'`);
    }
    if (!child.attemptId) throw new Error(`terminal child '${child.childId}' has no durable attempt id`);
    const durableChild = ownMissionValue(state.children, child.childId);
    if (!durableChild || canonicalMissionJson(durableChild) !== canonicalMissionJson(child)) {
      throw new Error(`child '${child.childId}' does not match its durable mission authority`);
    }
    const config = await this.configure();
    return this.locked(state.missionId, async () => {
      const authority = this.stateAuthority(state, config);
      const record = await this.readRecord(config, authority);
      if (!record || record.status !== 'active') {
        throw new Error(`terminal child '${child.childId}' has no active durable Git workspace lease`);
      }
      const workspace = this.workspaceFor(record);
      const expectedRevisionId = this.expectedRevision(state);

      if (child.permission === 'write' && child.status === 'succeeded') {
        const evidence = await this.backend.checkpointExact(
          workspace,
          `Noriq mission checkpoint ${digest({ missionId: state.missionId, childId: child.childId, attemptId: child.attemptId })}`,
          { expectedParentRevisionId: expectedRevisionId },
        );
        return [this.checkpointAction(state, child, evidence)];
      }

      if (child.permission === 'write') {
        const reconciliation = await this.backend.reconcileWorkspace(workspace, {
          expectedRevisionId,
          quarantineId: `attempt-${digest({
            missionId: state.missionId,
            childId: child.childId,
            attemptId: child.attemptId,
          })}`,
          message: `Quarantine terminal Noriq mission attempt ${digest({ missionId: state.missionId, childId: child.childId, attemptId: child.attemptId })}.`,
        });
        const action: RecordWorkspaceReconciledAction = {
          type: 'record-workspace-reconciled',
          childId: child.childId,
          revisionId: reconciliation.revisionId,
          disposition: reconciliation.disposition,
          summary:
            reconciliation.disposition === 'quarantined'
              ? `Git residue retained at ${reconciliation.quarantineRef} (${reconciliation.quarantineRevisionId}).`
              : `Git workspace restored cleanly to ${reconciliation.revisionId}.`,
        };
        return [action];
      }

      if (!child.subjectCheckpointId) {
        await this.inspectExact(record, expectedRevisionId);
        return [];
      }
      if (child.status !== 'succeeded') {
        await this.inspectExact(record, this.expectedChildRevision(state, child));
        return [];
      }
      const checkpoint = ownMissionValue(state.checkpoints, child.subjectCheckpointId);
      const artifact = child.artifact?.type === 'review' ? child.artifact : null;
      if (
        !checkpoint ||
        !artifact ||
        artifact.checkpointId !== checkpoint.checkpointId ||
        artifact.revisionId !== checkpoint.revisionId
      ) {
        throw new Error(`review child '${child.childId}' lacks an exact artifact for its durable subject`);
      }
      await this.inspectExact(record, checkpoint.revisionId);
      return [this.reviewAction(state, child, artifact)];
    });
  }

  /**
   * Run the catalogue-owned deterministic gate while the exact Git lease is fenced. The command
   * never receives provider/Noriq credentials: the default verify executor sanitizes its
   * environment, starts one process group, and settles only after that complete process tree exits
   * or is killed at the durable timeout. Injection is a machine-trusted test/deployment seam.
   */
  async validate(
    state: MissionState,
    checkpoint: MissionCheckpointState,
    requestedPolicy: MissionValidationPolicy,
    signal: AbortSignal,
  ): Promise<RecordValidationAction> {
    await this.assertRuntimeAuthority();
    const durableCheckpoint = ownMissionValue(state.checkpoints, checkpoint.checkpointId);
    const latest = latestCheckpoint(state);
    if (
      !durableCheckpoint ||
      canonicalMissionJson(durableCheckpoint) !== canonicalMissionJson(checkpoint) ||
      latest?.checkpointId !== checkpoint.checkpointId ||
      !checkpoint.clean
    ) {
      throw new Error('Git mission validation requires the exact latest clean durable checkpoint');
    }
    const durablePolicy = state.validationPolicy;
    if (
      durablePolicy === null ||
      canonicalMissionJson(durablePolicy) !== canonicalMissionJson(requestedPolicy)
    ) {
      throw new Error('Git mission validation policy does not match durable mission authority');
    }
    const policy = exactValidationPolicy(requestedPolicy);
    const expectedRevisionId = exactGitRevision(checkpoint.revisionId, 'mission validation revision');
    if (policy.kind === 'command') {
      const attempt = state.activeValidation;
      if (
        !attempt ||
        attempt.checkpointId !== checkpoint.checkpointId ||
        attempt.revisionId !== expectedRevisionId ||
        attempt.policyId !== policy.policyId
      ) {
        throw new Error('Git mission validation lacks matching durable attempt authority');
      }
    }
    const config = await this.configure();
    return this.locked(state.missionId, async () => {
      const authority = this.stateAuthority(state, config);
      const record = await this.readRecord(config, authority);
      if (!record || record.status !== 'active') {
        throw new Error('Git mission validation requires an active durable workspace lease');
      }
      const validationId =
        policy.kind === 'command'
          ? state.activeValidation!.validationId
          : `git-validation:${digest({
              missionId: state.missionId,
              checkpointId: checkpoint.checkpointId,
              revisionId: expectedRevisionId,
              policyId: policy.policyId,
            })}`;

      if (policy.kind === 'none') {
        await this.inspectExact(record, expectedRevisionId);
        return {
          type: 'record-validation',
          validationId,
          checkpointId: checkpoint.checkpointId,
          revisionId: expectedRevisionId,
          policyId: policy.policyId,
          disposition: 'not-applicable',
          exitCode: null,
          timedOut: false,
          workspaceChanged: false,
          outputTail: utf8Tail(policy.reason, MAX_MISSION_VALIDATION_OUTPUT_BYTES),
        };
      }
      // A prior Runner may have died after launching this same durable attempt. Owner-death
      // containment proves its process tree is gone; restore first so restart never wedges on
      // residue or overlaps a surviving validator.
      await this.backend.restoreWorkspace(this.workspaceFor(record), expectedRevisionId);
      if (signal.aborted) throw new Error('deterministic validation was cancelled before launch');
      await this.assertRuntimeAuthority();
      const result = this.containment
        ? await runContainedValidation(this.containment, {
            runId: validationId,
            command: policy.command,
            shell: policy.shell,
            timeoutSeconds: policy.timeoutSeconds,
            cwd: this.workspaceFor(record).localPath,
            env: this.env,
            readOnlyRoots: config.objectRoots,
            protectedWorkspaceReadOnlyPaths: ['.git'],
            signal,
          })
        : this.validationExec
          ? {
              ...(await runVerify(
                {
                  cmd: policy.command,
                  timeoutSeconds: policy.timeoutSeconds,
                  shell: policy.shell,
                },
                this.workspaceFor(record).localPath,
                { exec: this.validationExec },
              )),
              aborted: false,
            }
          : (() => {
              throw new Error('Git mission validation requires bound owner-death containment');
            })();
      const restoration = await this.backend.restoreWorkspace(this.workspaceFor(record), expectedRevisionId);
      await this.inspectExact(record, expectedRevisionId);
      const workspaceChanged = restoration.changed;
      const reconciliationNote = workspaceChanged
        ? `\n\n[Noriq] Validation changed the exact workspace. Its side effects were discarded and ${expectedRevisionId} was restored.`
        : '';
      return {
        type: 'record-validation',
        validationId,
        checkpointId: checkpoint.checkpointId,
        revisionId: expectedRevisionId,
        policyId: policy.policyId,
        disposition: result.passed && !result.aborted && !workspaceChanged ? 'passed' : 'failed',
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        workspaceChanged,
        outputTail: utf8Tail(`${result.output}${reconciliationNote}`, MAX_MISSION_VALIDATION_OUTPUT_BYTES),
      };
    });
  }

  async recover(
    state: MissionState,
    checkpoint: MissionCheckpointState,
    requestedPolicy: Extract<MissionValidationPolicy, { kind: 'command' }>,
  ): Promise<RecordValidationAction> {
    await this.assertRuntimeAuthority();
    const policy = exactValidationPolicy(requestedPolicy);
    if (policy.kind !== 'command') throw new Error('Git validation recovery requires command policy');
    const attempt = state.activeValidation;
    if (
      !attempt ||
      attempt.checkpointId !== checkpoint.checkpointId ||
      attempt.revisionId !== checkpoint.revisionId ||
      attempt.policyId !== policy.policyId
    ) {
      throw new Error('Git validation recovery lacks exact durable attempt authority');
    }
    const expectedRevisionId = exactGitRevision(checkpoint.revisionId, 'validation recovery revision');
    const config = await this.configure();
    return this.locked(state.missionId, async () => {
      const record = await this.readRecord(config, this.stateAuthority(state, config));
      if (!record || record.status !== 'active') {
        throw new Error('Git validation recovery requires an active durable workspace lease');
      }
      const restoration = await this.backend.restoreWorkspace(this.workspaceFor(record), expectedRevisionId);
      await this.inspectExact(record, expectedRevisionId);
      return {
        type: 'record-validation',
        validationId: attempt.validationId,
        checkpointId: checkpoint.checkpointId,
        revisionId: expectedRevisionId,
        policyId: policy.policyId,
        disposition: 'failed',
        exitCode: null,
        timedOut: false,
        workspaceChanged: restoration.changed,
        outputTail: utf8Tail(
          `The validation attempt was interrupted before a durable result. Runner restored exact revision ${expectedRevisionId} without re-running the command.`,
          MAX_MISSION_VALIDATION_OUTPUT_BYTES,
        ),
      };
    });
  }

  async execute(state: MissionState, cleanupId: string): Promise<void> {
    await this.assertRuntimeAuthority();
    if (cleanupId !== GIT_MISSION_WORKSPACE_CLEANUP_ID) {
      throw new Error(`unsupported Git mission cleanup obligation '${cleanupId}'`);
    }
    if (!state.terminal || !['succeeded', 'failed', 'cancelled'].includes(state.status)) {
      throw new Error('Git mission workspace cleanup requires a terminal mission');
    }
    const config = await this.configure();
    const missionViews = path.join(config.agentGitRoot, digest({ missionId: state.missionId }));
    // Every agent/tool process is already settled when cleanup begins. The view contains only a
    // disposable index/config and pointers to read-only objects; accepted work lives in Git refs.
    await rm(missionViews, { recursive: true, force: true });
    await this.locked(state.missionId, async () => {
      const authority = this.stateAuthority(state, config);
      const record = await this.readRecord(config, authority);
      // A mission that terminated before its first child acquired a workspace has nothing to
      // release. In particular, cleanup must never call lease merely to manufacture work.
      if (!record) {
        if ((await this.optionalBranchRevision(authority)) !== null) {
          throw new Error(`cannot clean unrecorded Git mission branch '${authority.branch}'`);
        }
        return;
      }
      const preserveRevisionId = this.expectedRevision(state);
      if (record.status === 'released' && record.preservedRevisionId !== preserveRevisionId) {
        throw new Error(
          `released Git mission workspace preserves ${record.preservedRevisionId}, expected ${preserveRevisionId}`,
        );
      }
      if (record.status === 'released' && record.workspace === null) {
        if ((await this.optionalBranchRevision(authority)) !== null) {
          throw new Error('released unmaterialized Git mission lease unexpectedly has a branch');
        }
        return;
      }

      let releasable = record;
      if (record.status === 'allocating') {
        let branchRevisionId = await this.optionalBranchRevision(authority);
        if (branchRevisionId === null) {
          // Re-prove the repository immediately before treating the missing ref as authoritative.
          await this.preflight();
          branchRevisionId = await this.optionalBranchRevision(authority);
        }
        if (branchRevisionId === null) {
          await this.writeRecord(config, {
            ...record,
            status: 'released',
            preservedRevisionId: preserveRevisionId,
          });
          return;
        }
        if (branchRevisionId !== preserveRevisionId || preserveRevisionId !== record.baseRevisionId) {
          throw new Error(
            `cannot clean allocating Git mission branch '${record.branch}' at ${branchRevisionId}; expected ${preserveRevisionId}`,
          );
        }
        const workspace = await this.validateMaterializedWorkspace(
          await this.backend.lease(record.repositoryRoot, record.runId, {
            fromTarget: record.baseRevisionId,
          }),
          record,
        );
        releasable = { ...record, workspace, status: 'active' };
        await this.inspectExact(releasable, preserveRevisionId);
        // If release crashes, the next cleanup sees an ordinary active record and retries safely.
        await this.writeRecord(config, releasable);
      }

      await this.backend.releaseWorkspace(this.workspaceFor(releasable), { preserveRevisionId });
      if (releasable.status !== 'released') {
        await this.writeRecord(config, {
          ...releasable,
          status: 'released',
          preservedRevisionId: preserveRevisionId,
        });
      }
    });
  }

  /** Prove the released deterministic branch still names the mission's terminal accepted commit. */
  async record(state: MissionState): Promise<RecordAcceptedRevisionHandoffAction | null> {
    await this.assertRuntimeAuthority();
    if (state.terminal?.outcome !== 'succeeded') return null;
    const unfinishedCleanup = state.cleanupPlan.filter(
      (cleanupId) => state.cleanup[cleanupId]?.status !== 'completed',
    );
    if (unfinishedCleanup.length > 0) {
      throw new Error(
        `accepted-revision handoff requires completed cleanup: ${unfinishedCleanup.join(', ')}`,
      );
    }
    const checkpointId = state.terminal.checkpointId;
    if (checkpointId === null) {
      throw new Error('successful Git mission has no terminal accepted checkpoint');
    }
    const checkpoint = ownMissionValue(state.checkpoints, checkpointId);
    if (!checkpoint || !checkpoint.clean) {
      throw new Error(`terminal accepted Git checkpoint '${checkpointId}' is missing or dirty`);
    }
    const revisionId = exactGitRevision(checkpoint.revisionId, 'terminal accepted Git revision');
    const config = await this.configure();
    return this.locked(state.missionId, async () => {
      const authority = this.stateAuthority(state, config);
      const lease = await this.readRecord(config, authority);
      if (!lease || lease.status !== 'released') {
        throw new Error('accepted-revision handoff requires a released durable Git workspace lease');
      }
      if (lease.preservedRevisionId !== revisionId) {
        throw new Error(
          `released Git mission lease preserves ${String(lease.preservedRevisionId)}, expected ${revisionId}`,
        );
      }
      const branchRevisionId = await this.optionalBranchRevision(authority);
      if (branchRevisionId !== revisionId) {
        throw new Error(
          `preserved Git mission branch '${authority.branch}' names ${String(branchRevisionId)}, expected ${revisionId}`,
        );
      }
      return {
        type: 'record-accepted-revision-handoff',
        backend: 'git',
        repositoryKey: this.repositoryKey,
        checkpointId,
        revisionId,
        reference: authority.branch,
        status: 'preserved',
      };
    });
  }
}
