/**
 * @internal Activation-gated prototype. This adapter is deliberately absent from the published
 * mission barrel until its live Diversion crash-recovery, transport-cancellation, partial-commit,
 * lock, and branch-retirement contracts are proven.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { AgentProcessContainment } from '../process-containment';
import { missionAgentEnv } from '../security';
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
const MAX_RECORD_BYTES = 128 * 1024;
const MAX_API_BODY_BYTES = 8 * 1024 * 1024;
const MAX_VALIDATION_TIMEOUT_SECONDS = 86_400;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DV_REPOSITORY_ID = /^dv\.repo\.[A-Za-z0-9_-]+$/;
const DV_BRANCH_ID = /^dv\.branch\.[A-Za-z0-9_-]+$/;
const DV_WORKSPACE_ID = /^dv\.ws\.[A-Za-z0-9_-]+$/;
const DV_COMMIT_ID = /^dv\.commit\.[A-Za-z0-9_-]+$/;

export const DIVERSION_MISSION_WORKSPACE_CLEANUP_ID = 'diversion-mission-workspace-v1';
export const DIVERSION_MISSION_WORKSPACE_CLEANUP_PLAN: readonly string[] = Object.freeze([
  DIVERSION_MISSION_WORKSPACE_CLEANUP_ID,
]);

export const DIVERSION_MISSION_WORKSPACE_CAPABILITIES: LocalMissionWorkspaceAdapterCapabilities =
  Object.freeze({
    exactBaseRevision: true,
    exclusiveMissionLease: true,
    exactCheckpointRevision: true,
    exactRevisionValidation: true,
    restartReconciliation: true,
    preservesAcceptedRevision: true,
    preservedRevisionHandoff: true,
  });

export interface DiversionMissionHttpResponse {
  status: number;
  body: unknown;
}

/** Machine-trusted authenticated transport. It receives full `/repos/...` API paths. */
export type DiversionMissionHttp = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  apiPath: string,
  body?: unknown,
) => Promise<DiversionMissionHttpResponse>;

/**
 * Machine-trusted `dv` transport. The adapter supplies non-interactive exact argument arrays; the
 * transport must reject non-zero exits and resolve only after the CLI process has fully settled.
 */
export type DiversionMissionCli = (
  args: string[],
  cwd: string,
) => Promise<{
  stdout: string;
  stderr: string;
  /** Required for `dv clean -f`: exact proof that ignored or untracked entries were removed. */
  removedWorkspaceEntries?: boolean;
}>;

export interface DiversionMissionWorkspaceAdapterOptions {
  repositoryKey: string;
  repoId: string;
  /** Private durable directory containing only adapter records and cross-process locks. */
  stateDirectory: string;
  /** Private absolute parent under which this adapter materializes mission-only clones. */
  workspaceDirectory: string;
  http: DiversionMissionHttp;
  cli: DiversionMissionCli;
}

type LeasePhase = 'allocating' | 'active' | 'releasing' | 'released';

interface DiversionMissionLeaseRecord {
  version: typeof LEASE_RECORD_VERSION;
  missionId: string;
  repositoryKey: string;
  repoId: string;
  baseRevisionId: string;
  branchName: string;
  workspaceName: string;
  localPath: string;
  leaseGeneration: string;
  branchId: string | null;
  workspaceId: string | null;
  phase: LeasePhase;
  materialized: boolean;
  localUnregistered: boolean;
  remoteWorkspaceDeleted: boolean;
  localRemoved: boolean;
  preservedRevisionId: string | null;
}

interface AdapterConfiguration {
  stateDirectory: string;
  workspaceDirectory: string;
}

interface DiversionMissionAuthority {
  missionId: string;
  repositoryKey: string;
  repoId: string;
  baseRevisionId: string;
  branchName: string;
  workspaceName: string;
  localPath: string;
}

interface BranchDetails {
  branchId: string;
  branchName: string;
  commitId: string;
  branchDescription: string | null;
}

interface WorkspaceDetails {
  workspaceId: string;
  repoId: string;
  name: string;
  branchId: string;
  baseCommitId: string;
}

interface WorkspaceStatus {
  clean: boolean;
}

interface CommitDetails {
  commitId: string;
  branchId: string;
  parents: readonly string[];
  message: string;
}

function errno(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalMissionJson(value), 'utf8').digest('hex');
}

function boundedString(value: unknown, name: string, max = 1_024): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) {
    throw new Error(`${name} must be a bounded string without NUL`);
  }
  return value;
}

function exactString(value: unknown, name: string, max = 1_024): string {
  const exact = boundedString(value, name, max);
  if (exact.length < 1) {
    throw new Error(`${name} must be a bounded non-empty string without NUL`);
  }
  return exact;
}

function exactIdentifier(value: unknown, name: string, pattern: RegExp): string {
  const identifier = exactString(value, name, 128);
  if (!pattern.test(identifier)) throw new Error(`${name} is not an exact Diversion identifier`);
  return identifier;
}

function exactRepositoryId(value: unknown, name = 'Diversion repository id'): string {
  return exactIdentifier(value, name, DV_REPOSITORY_ID);
}

function exactBranchId(value: unknown, name = 'Diversion branch id'): string {
  return exactIdentifier(value, name, DV_BRANCH_ID);
}

function exactWorkspaceId(value: unknown, name = 'Diversion workspace id'): string {
  return exactIdentifier(value, name, DV_WORKSPACE_ID);
}

function exactCommitId(value: unknown, name = 'Diversion commit id'): string {
  return exactIdentifier(value, name, DV_COMMIT_ID);
}

function exactObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value as number;
}

function boundedText(value: string | null, fallback: string, max: number): string {
  const normalized = value?.trim() ?? '';
  return (normalized || fallback).slice(0, max);
}

function utf8Tail(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength <= maxBytes) return value;
  let start = encoded.byteLength - maxBytes;
  while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) start += 1;
  return encoded.subarray(start).toString('utf8');
}

function pathContains(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function assertNonOverlapping(left: string, right: string, labels: readonly [string, string]): void {
  if (pathContains(left, right) || pathContains(right, left)) {
    throw new Error(`${labels[0]} and ${labels[1]} must not overlap`);
  }
}

async function canonicalProspectivePath(candidate: string): Promise<string> {
  const suffix: string[] = [];
  let cursor = candidate;
  for (;;) {
    try {
      return path.join(await realpath(cursor), ...suffix);
    } catch (error) {
      if (errno(error) !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
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

function recordFilename(missionId: string): string {
  validateMissionId(missionId);
  return `lease-${createHash('sha256').update(missionId, 'utf8').digest('hex')}.json`;
}

function deterministicNames(repoId: string, repositoryKey: string, missionId: string) {
  const token = digest({ version: LEASE_RECORD_VERSION, repoId, repositoryKey, missionId }).slice(0, 40);
  return {
    branchName: `noriq/mission/${token}`,
    workspaceName: `noriq-mission-${token}`,
    localName: `dv-mission-${token}`,
  };
}

function exactValidationPolicy(
  policy: Extract<MissionValidationPolicy, { kind: 'command' }>,
): Extract<MissionValidationPolicy, { kind: 'command' }> {
  const policyId = exactString(policy.policyId, 'mission validation policyId', 256);
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

function parseBranch(value: unknown, label: string): BranchDetails {
  const branch = exactObject(value, label);
  return {
    branchId: exactBranchId(branch.branch_id, `${label}.branch_id`),
    branchName: exactString(branch.branch_name, `${label}.branch_name`, 128),
    commitId: exactCommitId(branch.commit_id, `${label}.commit_id`),
    branchDescription:
      branch.branch_description === undefined || branch.branch_description === null
        ? null
        : boundedString(branch.branch_description, `${label}.branch_description`, 1_024),
  };
}

function parseWorkspace(value: unknown, label: string): WorkspaceDetails {
  const workspace = exactObject(value, label);
  return {
    workspaceId: exactWorkspaceId(workspace.workspace_id, `${label}.workspace_id`),
    repoId: exactRepositoryId(workspace.repo_id, `${label}.repo_id`),
    name: exactString(workspace.name, `${label}.name`, 128),
    branchId: exactBranchId(workspace.branch_id, `${label}.branch_id`),
    baseCommitId: exactCommitId(workspace.base_commit_id, `${label}.base_commit_id`),
  };
}

function parseCommit(value: unknown, label: string): CommitDetails {
  const commit = exactObject(value, label);
  if (!Array.isArray(commit.parents) || commit.parents.length > 32) {
    throw new Error(`${label}.parents must be a bounded array`);
  }
  return {
    commitId: exactCommitId(commit.commit_id, `${label}.commit_id`),
    branchId: exactBranchId(commit.branch_id, `${label}.branch_id`),
    parents: commit.parents.map((parent, index) => exactCommitId(parent, `${label}.parents[${index}]`)),
    message: boundedString(commit.commit_message, `${label}.commit_message`, 64_000),
  };
}

function parseWorkspaceStatus(value: unknown, label: string): WorkspaceStatus {
  const status = exactObject(value, label);
  const changedItems = exactInteger(status.changed_items_count, `${label}.changed_items_count`);
  const changedFiles = exactInteger(status.changed_files_count, `${label}.changed_files_count`);
  if (status.incomplete_result !== undefined && typeof status.incomplete_result !== 'boolean') {
    throw new Error(`${label}.incomplete_result must be boolean when present`);
  }
  if (status.incomplete_result === true) throw new Error(`${label} is incomplete`);
  if (status.conflicts !== null && status.conflicts !== undefined && !Array.isArray(status.conflicts)) {
    throw new Error(`${label}.conflicts must be an array or null`);
  }
  const conflicts = status.conflicts ?? [];
  if (!conflicts.every((entry) => typeof entry === 'string')) {
    throw new Error(`${label}.conflicts contains a non-string path`);
  }
  return { clean: changedItems === 0 && changedFiles === 0 && conflicts.length === 0 };
}

function parseRecord(raw: string, expected: DiversionMissionAuthority): DiversionMissionLeaseRecord {
  if (Buffer.byteLength(raw, 'utf8') > MAX_RECORD_BYTES) {
    throw new Error('Diversion mission lease record is oversized');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Diversion mission lease record is not valid JSON');
  }
  const record = exactObject(value, 'Diversion mission lease record');
  if (
    record.version !== LEASE_RECORD_VERSION ||
    record.missionId !== expected.missionId ||
    record.repositoryKey !== expected.repositoryKey ||
    record.repoId !== expected.repoId ||
    record.baseRevisionId !== expected.baseRevisionId ||
    record.branchName !== expected.branchName ||
    record.workspaceName !== expected.workspaceName ||
    record.localPath !== expected.localPath ||
    typeof record.leaseGeneration !== 'string' ||
    !UUID_V4.test(record.leaseGeneration) ||
    (record.branchId !== null && !DV_BRANCH_ID.test(String(record.branchId))) ||
    (record.workspaceId !== null && !DV_WORKSPACE_ID.test(String(record.workspaceId))) ||
    !['allocating', 'active', 'releasing', 'released'].includes(String(record.phase)) ||
    typeof record.materialized !== 'boolean' ||
    typeof record.localUnregistered !== 'boolean' ||
    typeof record.remoteWorkspaceDeleted !== 'boolean' ||
    typeof record.localRemoved !== 'boolean' ||
    (record.preservedRevisionId !== null && !DV_COMMIT_ID.test(String(record.preservedRevisionId)))
  ) {
    throw new Error('Diversion mission lease record does not match its exact mission authority');
  }
  const parsed = record as unknown as DiversionMissionLeaseRecord;
  if (
    (parsed.phase === 'active' &&
      (!parsed.branchId || !parsed.workspaceId || !parsed.materialized || parsed.preservedRevisionId)) ||
    (parsed.phase === 'allocating' &&
      (parsed.localUnregistered ||
        parsed.remoteWorkspaceDeleted ||
        parsed.localRemoved ||
        parsed.preservedRevisionId !== null)) ||
    (parsed.phase === 'released' &&
      (!parsed.localUnregistered ||
        !parsed.remoteWorkspaceDeleted ||
        !parsed.localRemoved ||
        parsed.preservedRevisionId === null ||
        (parsed.branchId === null && (parsed.workspaceId !== null || parsed.materialized)))) ||
    (parsed.remoteWorkspaceDeleted && !parsed.localUnregistered) ||
    (parsed.localRemoved && !parsed.remoteWorkspaceDeleted)
  ) {
    throw new Error('Diversion mission lease record lifecycle is invalid');
  }
  return { ...parsed };
}

/**
 * Mission-owned Diversion workspace authority.
 *
 * Remote branches and workspaces are addressed by deterministic names and rediscovered after a
 * crash before any create call is retried. The CLI is used only to materialize/synchronize the
 * already persisted workspace id and to unregister that exact local clone during cleanup.
 */
export class DiversionMissionWorkspaceAdapter implements LocalMissionWorkspaceAdapter {
  readonly capabilities = DIVERSION_MISSION_WORKSPACE_CAPABILITIES;
  readonly cleanupPlan = DIVERSION_MISSION_WORKSPACE_CLEANUP_PLAN;
  readonly evidence: MissionEvidenceRecorder = this;
  readonly validation: MissionValidationExecutor = this;
  readonly cleanup: MissionCleanupExecutor = this;
  readonly acceptedRevisionHandoff: MissionAcceptedRevisionHandoffRecorder = this;

  private readonly repositoryKey: string;
  private readonly repoId: string;
  private readonly requestedStateDirectory: string;
  private readonly requestedWorkspaceDirectory: string;
  private readonly http: DiversionMissionHttp;
  private readonly cli: DiversionMissionCli;
  private readonly locks: JsonlMissionStore;
  private containment: AgentProcessContainment | null = null;
  private configuration: Promise<AdapterConfiguration> | null = null;

  constructor(options: DiversionMissionWorkspaceAdapterOptions) {
    this.repositoryKey = exactString(options.repositoryKey, 'repositoryKey');
    this.repoId = exactRepositoryId(options.repoId);
    if (!path.isAbsolute(options.stateDirectory)) {
      throw new Error('Diversion mission workspace state directory must be absolute');
    }
    if (!path.isAbsolute(options.workspaceDirectory)) {
      throw new Error('Diversion mission workspace directory must be absolute');
    }
    if (typeof options.http !== 'function' || typeof options.cli !== 'function') {
      throw new Error('Diversion mission adapter requires injected HTTP and CLI transports');
    }
    this.requestedStateDirectory = options.stateDirectory;
    this.requestedWorkspaceDirectory = options.workspaceDirectory;
    this.http = options.http;
    this.cli = options.cli;
    this.locks = new JsonlMissionStore(path.join(options.stateDirectory, 'locks'), {
      controllerTimeoutMs: 30_000,
    });
  }

  /** Bind the runtime's proved containment provider before any command validation can execute. */
  bindContainment(containment: AgentProcessContainment): void {
    if (
      containment.capabilities.processTreeTermination !== true ||
      containment.capabilities.ownerDeathTermination !== true ||
      containment.capabilities.workspaceIsolation !== true ||
      containment.capabilities.protectedWorkspaceSubpaths !== true
    ) {
      throw new Error(
        'Diversion validation requires owner-death, process-tree, and protected-path containment',
      );
    }
    if (this.containment && this.containment !== containment) {
      throw new Error('Diversion mission adapter containment authority is immutable once bound');
    }
    this.containment = containment;
  }

  private async configure(): Promise<AdapterConfiguration> {
    this.configuration ??= (async () => {
      const prospectiveState = await canonicalProspectivePath(this.requestedStateDirectory);
      const prospectiveWorkspaces = await canonicalProspectivePath(this.requestedWorkspaceDirectory);
      assertNonOverlapping(prospectiveState, prospectiveWorkspaces, [
        'Diversion mission workspace state directory',
        'Diversion mission workspace directory',
      ]);
      const stateDirectory = await ensurePrivateDirectory(
        this.requestedStateDirectory,
        'Diversion mission workspace state directory',
      );
      const workspaceDirectory = await ensurePrivateDirectory(
        this.requestedWorkspaceDirectory,
        'Diversion mission workspace directory',
      );
      assertNonOverlapping(stateDirectory, workspaceDirectory, [
        'Diversion mission workspace state directory',
        'Diversion mission workspace directory',
      ]);
      return { stateDirectory, workspaceDirectory };
    })();
    return this.configuration;
  }

  private authorityFor(
    missionId: string,
    objective: MissionObjective | undefined | null,
    config: AdapterConfiguration,
  ): DiversionMissionAuthority {
    validateMissionId(missionId);
    if (!objective) throw new Error(`mission '${missionId}' has no durable objective`);
    if (objective.repositoryKey !== this.repositoryKey) {
      throw new Error(`mission '${missionId}' repositoryKey does not match this Diversion adapter`);
    }
    const baseRevisionId = exactCommitId(objective.baseRevision, 'mission objective.baseRevision');
    const names = deterministicNames(this.repoId, this.repositoryKey, missionId);
    return {
      missionId,
      repositoryKey: this.repositoryKey,
      repoId: this.repoId,
      baseRevisionId,
      branchName: names.branchName,
      workspaceName: names.workspaceName,
      localPath: path.join(config.workspaceDirectory, names.localName),
    };
  }

  private stateAuthority(state: MissionState, config: AdapterConfiguration): DiversionMissionAuthority {
    return this.authorityFor(state.missionId, state.objective, config);
  }

  private recordPath(config: AdapterConfiguration, missionId: string): string {
    return path.join(config.stateDirectory, recordFilename(missionId));
  }

  private async readRecord(
    config: AdapterConfiguration,
    authority: DiversionMissionAuthority,
  ): Promise<DiversionMissionLeaseRecord | null> {
    const filename = this.recordPath(config, authority.missionId);
    let pathMetadata: Stats;
    try {
      pathMetadata = await lstat(filename);
    } catch (error) {
      if (errno(error) === 'ENOENT') return null;
      throw error;
    }
    assertPrivateRegularFile(pathMetadata, 'Diversion mission lease record');
    if (pathMetadata.size > MAX_RECORD_BYTES) throw new Error('Diversion mission lease record is oversized');
    const handle = await open(filename, constants.O_RDONLY | NO_FOLLOW);
    try {
      const opened = await handle.stat();
      assertPrivateRegularFile(opened, 'Diversion mission lease record');
      if (opened.dev !== pathMetadata.dev || opened.ino !== pathMetadata.ino) {
        throw new Error('Diversion mission lease record changed while opening');
      }
      return parseRecord(await handle.readFile('utf8'), authority);
    } finally {
      await handle.close();
    }
  }

  private async writeRecord(config: AdapterConfiguration, record: DiversionMissionLeaseRecord) {
    const body = `${canonicalMissionJson(record)}\n`;
    if (Buffer.byteLength(body, 'utf8') > MAX_RECORD_BYTES) {
      throw new Error('Diversion mission lease record is oversized');
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
    const lease = await this.locks.acquireController(`diversion-workspace:${digest(missionId)}`);
    try {
      return await operation();
    } finally {
      await lease.release();
    }
  }

  private repoPath(suffix = ''): string {
    return `/repos/${encodeURIComponent(this.repoId)}${suffix}`;
  }

  private async api(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    suffix: string,
    body?: unknown,
  ): Promise<DiversionMissionHttpResponse> {
    const response = await this.http(method, this.repoPath(suffix), body);
    if (
      !response ||
      !Number.isSafeInteger(response.status) ||
      response.status < 100 ||
      response.status > 599
    ) {
      throw new Error(`Diversion ${method} ${suffix || '/'} returned an invalid HTTP response`);
    }
    let encoded: string;
    try {
      encoded = JSON.stringify(response.body) ?? '';
    } catch {
      throw new Error(`Diversion ${method} ${suffix || '/'} returned a non-serializable body`);
    }
    if (Buffer.byteLength(encoded, 'utf8') > MAX_API_BODY_BYTES) {
      throw new Error(`Diversion ${method} ${suffix || '/'} returned an oversized body`);
    }
    return response;
  }

  private async repository(): Promise<void> {
    const response = await this.api('GET', '');
    if (response.status !== 200) {
      throw new Error(`Diversion repository '${this.repoId}' lookup failed: HTTP ${response.status}`);
    }
    const repository = exactObject(response.body, 'Diversion repository response');
    if (exactRepositoryId(repository.repo_id, 'Diversion repository response.repo_id') !== this.repoId) {
      throw new Error('Diversion repository response does not match configured repository id');
    }
  }

  private async commitDetails(commitId: string): Promise<CommitDetails> {
    const exactId = exactCommitId(commitId);
    const response = await this.api('GET', `/commits/${encodeURIComponent(exactId)}`);
    if (response.status !== 200) {
      throw new Error(`Diversion commit '${exactId}' lookup failed: HTTP ${response.status}`);
    }
    const commit = parseCommit(response.body, `Diversion commit '${exactId}'`);
    if (commit.commitId !== exactId) throw new Error(`Diversion commit lookup returned '${commit.commitId}'`);
    return commit;
  }

  private async listBranches(): Promise<readonly BranchDetails[]> {
    const response = await this.api('GET', '/branches');
    if (response.status !== 200) throw new Error(`Diversion branch list failed: HTTP ${response.status}`);
    const body = exactObject(response.body, 'Diversion branch list');
    if (!Array.isArray(body.items)) throw new Error('Diversion branch list.items must be an array');
    return body.items.map((item, index) => parseBranch(item, `Diversion branch list.items[${index}]`));
  }

  private async branchByName(name: string): Promise<BranchDetails | null> {
    const matches = (await this.listBranches()).filter((branch) => branch.branchName === name);
    if (matches.length > 1) throw new Error(`Diversion branch name '${name}' is ambiguous`);
    return matches[0] ?? null;
  }

  private async branchById(branchId: string): Promise<BranchDetails | null> {
    const exactId = exactBranchId(branchId);
    const response = await this.api('GET', `/branches/${encodeURIComponent(exactId)}`);
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw new Error(`Diversion branch '${exactId}' lookup failed: HTTP ${response.status}`);
    }
    const branch = parseBranch(response.body, `Diversion branch '${exactId}'`);
    if (branch.branchId !== exactId) throw new Error(`Diversion branch lookup returned '${branch.branchId}'`);
    return branch;
  }

  private async listWorkspaces(): Promise<readonly WorkspaceDetails[]> {
    const response = await this.api('GET', '/workspaces');
    if (response.status !== 200) throw new Error(`Diversion workspace list failed: HTTP ${response.status}`);
    const body = exactObject(response.body, 'Diversion workspace list');
    if (!Array.isArray(body.items)) throw new Error('Diversion workspace list.items must be an array');
    return body.items.map((item, index) => parseWorkspace(item, `Diversion workspace list.items[${index}]`));
  }

  private async workspaceByName(name: string): Promise<WorkspaceDetails | null> {
    const matches = (await this.listWorkspaces()).filter((workspace) => workspace.name === name);
    if (matches.length > 1) throw new Error(`Diversion workspace name '${name}' is ambiguous`);
    return matches[0] ?? null;
  }

  private async workspaceById(workspaceId: string): Promise<WorkspaceDetails | null> {
    const exactId = exactWorkspaceId(workspaceId);
    const response = await this.api('GET', `/workspaces/${encodeURIComponent(exactId)}`);
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw new Error(`Diversion workspace '${exactId}' lookup failed: HTTP ${response.status}`);
    }
    const workspace = parseWorkspace(response.body, `Diversion workspace '${exactId}'`);
    if (workspace.workspaceId !== exactId) {
      throw new Error(`Diversion workspace lookup returned '${workspace.workspaceId}'`);
    }
    return workspace;
  }

  private async workspaceStatus(workspaceId: string): Promise<WorkspaceStatus> {
    const exactId = exactWorkspaceId(workspaceId);
    const response = await this.api(
      'GET',
      `/workspaces/${encodeURIComponent(exactId)}/status?detail_items=false&recurse=true`,
    );
    if (response.status !== 200) {
      throw new Error(`Diversion workspace '${exactId}' status failed: HTTP ${response.status}`);
    }
    return parseWorkspaceStatus(response.body, `Diversion workspace '${exactId}' status`);
  }

  private validateBranch(
    branch: BranchDetails,
    authority: DiversionMissionAuthority,
    record: DiversionMissionLeaseRecord,
    expectedRevisionId: string,
    expectedId?: string | null,
  ): void {
    this.validateBranchAuthority(branch, authority, record, expectedId);
    if (branch.commitId !== expectedRevisionId) {
      throw new Error(
        `Diversion mission branch authority mismatch: expected '${authority.branchName}' at ${expectedRevisionId}`,
      );
    }
  }

  private validateBranchAuthority(
    branch: BranchDetails,
    authority: DiversionMissionAuthority,
    record: DiversionMissionLeaseRecord,
    expectedId?: string | null,
  ): void {
    if (
      branch.branchName !== authority.branchName ||
      branch.branchDescription !== this.expectedBranchDescription(record) ||
      (expectedId && branch.branchId !== expectedId)
    ) {
      throw new Error(`Diversion mission branch identity mismatch for '${authority.branchName}'`);
    }
  }

  private expectedBranchDescription(record: DiversionMissionLeaseRecord): string {
    return `Noriq mission lease ${record.leaseGeneration}`;
  }

  private validateWorkspace(
    workspace: WorkspaceDetails,
    authority: DiversionMissionAuthority,
    branchId: string,
    expectedRevisionId: string,
    expectedId?: string | null,
  ): void {
    if (
      workspace.repoId !== this.repoId ||
      workspace.name !== authority.workspaceName ||
      workspace.branchId !== branchId ||
      workspace.baseCommitId !== expectedRevisionId ||
      (expectedId && workspace.workspaceId !== expectedId)
    ) {
      throw new Error(
        `Diversion mission workspace authority mismatch: expected '${authority.workspaceName}' at ${expectedRevisionId}`,
      );
    }
  }

  private async ensureBranch(
    authority: DiversionMissionAuthority,
    record: DiversionMissionLeaseRecord,
    expectedRevisionId: string,
  ): Promise<BranchDetails> {
    if (record.branchId) {
      const branch = await this.branchById(record.branchId);
      if (!branch) throw new Error(`durable Diversion mission branch '${record.branchId}' is missing`);
      this.validateBranch(branch, authority, record, expectedRevisionId, record.branchId);
      return branch;
    }
    let branch = await this.branchByName(authority.branchName);
    if (!branch) {
      let createdBranchId: string | null = null;
      const response = await this.api('POST', '/branches', {
        commit_id: authority.baseRevisionId,
        branch_name: authority.branchName,
        branch_description: this.expectedBranchDescription(record),
      });
      if (response.status !== 201 && response.status !== 409) {
        throw new Error(`Diversion mission branch creation failed: HTTP ${response.status}`);
      }
      if (response.status === 201) {
        const body = exactObject(response.body, 'Diversion branch creation response');
        createdBranchId = exactBranchId(body.id, 'Diversion branch creation response.id');
      }
      branch = await this.branchByName(authority.branchName);
      if (!branch) throw new Error('Diversion mission branch creation did not produce a named branch');
      if (createdBranchId && branch.branchId !== createdBranchId) {
        throw new Error('Diversion branch creation response does not match named branch authority');
      }
    }
    this.validateBranch(branch, authority, record, expectedRevisionId);
    return branch;
  }

  private async ensureWorkspace(
    authority: DiversionMissionAuthority,
    record: DiversionMissionLeaseRecord,
    branch: BranchDetails,
    expectedRevisionId: string,
  ): Promise<WorkspaceDetails> {
    if (record.workspaceId) {
      const workspace = await this.workspaceById(record.workspaceId);
      if (!workspace) throw new Error(`durable Diversion workspace '${record.workspaceId}' is missing`);
      this.validateWorkspace(workspace, authority, branch.branchId, expectedRevisionId, record.workspaceId);
      return workspace;
    }
    let workspace = await this.workspaceByName(authority.workspaceName);
    if (!workspace) {
      let createdWorkspaceId: string | null = null;
      const response = await this.api('POST', '/workspaces', {
        branch_id: branch.branchId,
        name: authority.workspaceName,
      });
      if (response.status !== 201 && response.status !== 409) {
        throw new Error(`Diversion mission workspace creation failed: HTTP ${response.status}`);
      }
      if (response.status === 201) {
        const body = exactObject(response.body, 'Diversion workspace creation response');
        createdWorkspaceId = exactWorkspaceId(body.id, 'Diversion workspace creation response.id');
      }
      workspace = await this.workspaceByName(authority.workspaceName);
      if (!workspace) throw new Error('Diversion mission workspace creation produced no named workspace');
      if (createdWorkspaceId && workspace.workspaceId !== createdWorkspaceId) {
        throw new Error('Diversion workspace creation response does not match named workspace authority');
      }
    }
    this.validateWorkspace(workspace, authority, branch.branchId, expectedRevisionId);
    return workspace;
  }

  private async disableAutoForwarding(workspaceId: string): Promise<void> {
    const response = await this.api(
      'POST',
      `/workspaces/${encodeURIComponent(exactWorkspaceId(workspaceId))}/set_auto_forwarding`,
      { ws_auto_forwarding_status: 'disabled' },
    );
    if (response.status !== 204) {
      throw new Error(`disabling Diversion workspace auto-forwarding failed: HTTP ${response.status}`);
    }
  }

  private async localPathExists(localPath: string): Promise<boolean> {
    try {
      await lstat(localPath);
      return true;
    } catch (error) {
      if (errno(error) === 'ENOENT') return false;
      throw error;
    }
  }

  private async assertRealLocalDirectory(localPath: string): Promise<void> {
    const metadata = await lstat(localPath);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('Diversion mission local workspace must be a real directory');
    }
    if ((await realpath(localPath)) !== localPath) {
      throw new Error('Diversion mission local workspace changed canonical path');
    }
  }

  private async validateLocator(
    authority: DiversionMissionAuthority,
    branch: BranchDetails,
    workspace: WorkspaceDetails,
    expectedRevisionId: string,
  ): Promise<void> {
    await this.assertRealLocalDirectory(authority.localPath);
    const metadataPath = path.join(authority.localPath, '.diversion');
    const metadata = await lstat(metadataPath);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('Diversion mission .diversion locator must be a real directory');
    }
    const entries = await readdir(metadataPath);
    if (entries.length !== 1 || entries[0] !== workspace.workspaceId) {
      throw new Error('Diversion mission .diversion locator is ambiguous');
    }
    const locatorPath = path.join(metadataPath, workspace.workspaceId);
    const locatorMetadata = await lstat(locatorPath);
    if (!locatorMetadata.isFile() || locatorMetadata.isSymbolicLink() || locatorMetadata.nlink !== 1) {
      throw new Error('Diversion mission locator must be a real regular file');
    }
    if (locatorMetadata.size > MAX_RECORD_BYTES) throw new Error('Diversion mission locator is oversized');
    const locator = exactObject(
      JSON.parse(await readFile(locatorPath, 'utf8')) as unknown,
      'Diversion mission locator',
    );
    if (
      locator.WorkspaceID !== workspace.workspaceId ||
      locator.RepoID !== this.repoId ||
      locator.Path !== authority.localPath ||
      locator.BranchID !== branch.branchId ||
      locator.BranchName !== authority.branchName ||
      locator.CommitID !== expectedRevisionId
    ) {
      throw new Error('Diversion mission locator does not match exact remote authority');
    }
  }

  private async waitForLocalRevision(localPath: string, expectedRevisionId: string): Promise<void> {
    const result = await this.cli(['status', '--commit-id-only'], localPath);
    if (result.stderr.trim() !== '') throw new Error('Diversion status emitted unexpected stderr');
    const output = result.stdout.trim();
    if (output !== expectedRevisionId || output.includes('\n')) {
      throw new Error(`Diversion local workspace reports '${output}', expected ${expectedRevisionId}`);
    }
  }

  private async inspectExact(
    authority: DiversionMissionAuthority,
    record: DiversionMissionLeaseRecord,
    expectedRevisionId: string,
  ): Promise<void> {
    if (!record.branchId || !record.workspaceId) {
      throw new Error('Diversion mission workspace has no persisted remote identities');
    }
    const branch = await this.branchById(record.branchId);
    if (!branch) throw new Error(`Diversion mission branch '${record.branchId}' is missing`);
    this.validateBranch(branch, authority, record, expectedRevisionId, record.branchId);
    const workspace = await this.workspaceById(record.workspaceId);
    if (!workspace) throw new Error(`Diversion mission workspace '${record.workspaceId}' is missing`);
    this.validateWorkspace(workspace, authority, branch.branchId, expectedRevisionId, record.workspaceId);
    await this.waitForLocalRevision(authority.localPath, expectedRevisionId);
    await this.validateLocator(authority, branch, workspace, expectedRevisionId);
    if (!(await this.workspaceStatus(workspace.workspaceId)).clean) {
      throw new Error(`Diversion mission workspace '${workspace.workspaceId}' is dirty`);
    }
  }

  private async removePartialMaterialization(authority: DiversionMissionAuthority): Promise<void> {
    if (!(await this.localPathExists(authority.localPath))) return;
    await this.assertRealLocalDirectory(authority.localPath);
    await rm(authority.localPath, { recursive: true, force: false });
  }

  private async materialize(
    config: AdapterConfiguration,
    authority: DiversionMissionAuthority,
    record: DiversionMissionLeaseRecord,
    branch: BranchDetails,
    workspace: WorkspaceDetails,
    expectedRevisionId: string,
  ): Promise<DiversionMissionLeaseRecord> {
    if (!record.branchId || !record.workspaceId) {
      throw new Error('Diversion mission workspace identities must be durable before materialization');
    }
    if (await this.localPathExists(authority.localPath)) {
      try {
        await this.waitForLocalRevision(authority.localPath, expectedRevisionId);
        await this.validateLocator(authority, branch, workspace, expectedRevisionId);
      } catch (error) {
        if (record.materialized) throw error;
        await this.removePartialMaterialization(authority);
      }
    }
    if (!(await this.localPathExists(authority.localPath))) {
      const result = await this.cli(
        [
          'clone',
          this.repoId,
          authority.localPath,
          '--workspace',
          workspace.workspaceId,
          '--ref',
          branch.branchId,
        ],
        config.workspaceDirectory,
      );
      if (result.stderr.trim() !== '') throw new Error('Diversion clone emitted unexpected stderr');
    }
    await this.waitForLocalRevision(authority.localPath, expectedRevisionId);
    await this.validateLocator(authority, branch, workspace, expectedRevisionId);
    await this.cleanIgnoredProducts(authority.localPath);
    if (!(await this.workspaceStatus(workspace.workspaceId)).clean) {
      throw new Error('newly materialized Diversion mission workspace is not clean');
    }
    const active: DiversionMissionLeaseRecord = {
      ...record,
      phase: 'active',
      materialized: true,
    };
    await this.writeRecord(config, active);
    return active;
  }

  private async finishAllocation(
    config: AdapterConfiguration,
    authority: DiversionMissionAuthority,
    initial: DiversionMissionLeaseRecord,
  ): Promise<DiversionMissionLeaseRecord> {
    if (initial.phase !== 'allocating') throw new Error('Diversion mission lease is not allocating');
    let record = initial;
    const branch = await this.ensureBranch(authority, record, authority.baseRevisionId);
    if (record.branchId === null) {
      record = { ...record, branchId: branch.branchId };
      await this.writeRecord(config, record);
    }
    const workspace = await this.ensureWorkspace(authority, record, branch, authority.baseRevisionId);
    if (record.workspaceId === null) {
      record = { ...record, workspaceId: workspace.workspaceId };
      await this.writeRecord(config, record);
    }
    await this.disableAutoForwarding(workspace.workspaceId);
    return this.materialize(config, authority, record, branch, workspace, authority.baseRevisionId);
  }

  private expectedRevision(state: MissionState): string {
    return exactCommitId(
      latestCheckpoint(state)?.revisionId ?? state.objective?.baseRevision,
      'mission expected Diversion revision',
    );
  }

  private expectedChildRevision(state: MissionState, child: MissionChildState): string {
    if (!child.subjectCheckpointId) return this.expectedRevision(state);
    const checkpoint = ownMissionValue(state.checkpoints, child.subjectCheckpointId);
    if (!checkpoint) {
      throw new Error(
        `child '${child.childId}' references unknown checkpoint '${child.subjectCheckpointId}'`,
      );
    }
    return exactCommitId(checkpoint.revisionId, `child '${child.childId}' subject revision`);
  }

  private async ensureActiveRecord(
    state: MissionState,
    config: AdapterConfiguration,
    expectedRevisionId: string,
  ): Promise<DiversionMissionLeaseRecord> {
    const authority = this.stateAuthority(state, config);
    let record = await this.readRecord(config, authority);
    if (!record) {
      if (
        (await this.branchByName(authority.branchName)) ||
        (await this.workspaceByName(authority.workspaceName))
      ) {
        throw new Error('refusing unrecorded Diversion mission remote authority');
      }
      if (await this.localPathExists(authority.localPath)) {
        throw new Error('refusing unrecorded Diversion mission local workspace');
      }
      record = {
        version: LEASE_RECORD_VERSION,
        ...authority,
        leaseGeneration: randomUUID(),
        branchId: null,
        workspaceId: null,
        phase: 'allocating',
        materialized: false,
        localUnregistered: false,
        remoteWorkspaceDeleted: false,
        localRemoved: false,
        preservedRevisionId: null,
      };
      // No remote or local effect occurs before this intent is fsynced.
      await this.writeRecord(config, record);
    }
    if (record.phase === 'allocating') record = await this.finishAllocation(config, authority, record);
    if (record.phase !== 'active') {
      throw new Error(`Diversion mission workspace is already ${record.phase}`);
    }
    await this.inspectExact(authority, record, expectedRevisionId);
    return record;
  }

  async preflight(): Promise<void> {
    const config = await this.configure();
    const version = await this.cli(['version'], config.workspaceDirectory);
    if (
      Buffer.byteLength(version.stdout, 'utf8') + Buffer.byteLength(version.stderr, 'utf8') >
      MAX_API_BODY_BYTES
    ) {
      throw new Error('Diversion version output was oversized');
    }
    await this.repository();
  }

  async validateMissionAuthority(missionId: string, objective: MissionObjective | undefined): Promise<void> {
    const config = await this.configure();
    const authority = this.authorityFor(missionId, objective, config);
    await this.commitDetails(authority.baseRevisionId);
    await this.locked(missionId, async () => {
      const record = await this.readRecord(config, authority);
      if (!record) {
        if (
          (await this.branchByName(authority.branchName)) ||
          (await this.workspaceByName(authority.workspaceName))
        ) {
          throw new Error('unrecorded deterministic Diversion mission authority already exists');
        }
        if (await this.localPathExists(authority.localPath)) {
          throw new Error('unrecorded deterministic Diversion mission path already exists');
        }
        return;
      }
      if (record.phase === 'released') {
        const branch = record.branchId ? await this.branchById(record.branchId) : null;
        if (branch) {
          this.validateBranch(branch, authority, record, record.preservedRevisionId!, record.branchId);
        } else if (
          record.branchId ||
          record.workspaceId ||
          record.materialized ||
          (await this.branchByName(authority.branchName)) ||
          (await this.workspaceByName(authority.workspaceName)) ||
          (await this.localPathExists(authority.localPath))
        ) {
          throw new Error('released Diversion mission authority no longer matches its durable record');
        }
        if (
          (record.workspaceId && (await this.workspaceById(record.workspaceId))) ||
          (await this.workspaceByName(authority.workspaceName)) ||
          (await this.localPathExists(authority.localPath))
        ) {
          throw new Error('released Diversion mission workspace still has live effects');
        }
      }
    });
  }

  async resolve(state: MissionState, child: MissionChildState): Promise<LocalMissionWorkspaceResolution> {
    const durableChild = ownMissionValue(state.children, child.childId);
    if (
      !durableChild ||
      durableChild.status !== 'running' ||
      canonicalMissionJson(durableChild) !== canonicalMissionJson(child)
    ) {
      throw new Error(`child '${child.childId}' does not own a durable running mission attempt`);
    }
    const config = await this.configure();
    const authority = this.stateAuthority(state, config);
    const expectedRevisionId = this.expectedChildRevision(state, child);
    const record = await this.locked(state.missionId, () =>
      this.ensureActiveRecord(state, config, expectedRevisionId),
    );
    const generation = record.leaseGeneration;
    return {
      cwd: authority.localPath,
      revisionId: expectedRevisionId,
      leaseGeneration: generation,
      protectedWorkspaceReadOnlyPaths: ['.diversion'],
      verifyLaunchAuthority: async () => {
        await this.locked(state.missionId, async () => {
          const current = await this.readRecord(config, authority);
          if (
            !current ||
            current.phase !== 'active' ||
            current.leaseGeneration !== generation ||
            current.branchId !== record.branchId ||
            current.workspaceId !== record.workspaceId
          ) {
            throw new Error('Diversion mission lease authority changed before child launch');
          }
          await this.inspectExact(authority, current, expectedRevisionId);
        });
      },
    };
  }

  private checkpointMessage(state: MissionState, child: MissionChildState): string {
    return `Noriq mission checkpoint ${digest({
      missionId: state.missionId,
      childId: child.childId,
      attemptId: child.attemptId,
    })}`;
  }

  private async validateRecoveredCommit(
    record: DiversionMissionLeaseRecord,
    revisionId: string,
    expectedParentRevisionId: string,
    message: string,
  ): Promise<void> {
    if (!record.branchId) throw new Error('Diversion mission branch id is missing');
    const commit = await this.commitDetails(revisionId);
    if (
      commit.branchId !== record.branchId ||
      commit.parents.length !== 1 ||
      commit.parents[0] !== expectedParentRevisionId ||
      commit.message !== message
    ) {
      throw new Error(`Diversion revision '${revisionId}' is not the exact deterministic checkpoint`);
    }
  }

  private checkpointAction(
    state: MissionState,
    child: MissionChildState,
    revisionId: string,
    changed: boolean,
  ): RecordCheckpointAction {
    const parent = latestCheckpoint(state);
    return {
      type: 'record-checkpoint',
      checkpointId: `diversion-checkpoint:${digest({
        missionId: state.missionId,
        childId: child.childId,
        attemptId: child.attemptId,
      })}`,
      revisionId,
      authorChildId: child.childId,
      changed,
      parentCheckpointId: parent?.checkpointId ?? null,
      clean: true,
      description: boundedText(
        child.summary,
        `Diversion checkpoint for mission child '${child.childId}'.`,
        16_384,
      ),
    };
  }

  private async checkpoint(
    state: MissionState,
    child: MissionChildState,
    authority: DiversionMissionAuthority,
    record: DiversionMissionLeaseRecord,
  ): Promise<RecordCheckpointAction> {
    if (!record.branchId || !record.workspaceId) {
      throw new Error('Diversion checkpoint requires durable remote identities');
    }
    const expectedRevisionId = this.expectedRevision(state);
    const message = this.checkpointMessage(state, child);
    let branch = await this.branchById(record.branchId);
    if (!branch) throw new Error('Diversion mission branch disappeared before checkpoint');
    this.validateBranchAuthority(branch, authority, record, record.branchId);
    if (branch.commitId !== expectedRevisionId) {
      await this.validateRecoveredCommit(record, branch.commitId, expectedRevisionId, message);
      await this.cleanIgnoredProducts(authority.localPath);
      await this.inspectExact(authority, record, branch.commitId);
      return this.checkpointAction(state, child, branch.commitId, true);
    }

    await this.waitForLocalRevision(authority.localPath, expectedRevisionId);
    const status = await this.workspaceStatus(record.workspaceId);
    if (status.clean) {
      await this.cleanIgnoredProducts(authority.localPath);
      await this.inspectExact(authority, record, expectedRevisionId);
      return this.checkpointAction(state, child, expectedRevisionId, false);
    }

    const response = await this.api('POST', `/workspaces/${encodeURIComponent(record.workspaceId)}/commit`, {
      commit_message: message,
      include_paths: null,
    });
    if (response.status !== 200 && response.status !== 201) {
      throw new Error(`Diversion mission checkpoint failed: HTTP ${response.status}`);
    }
    branch = await this.branchById(record.branchId);
    if (!branch) throw new Error('Diversion mission branch disappeared after checkpoint');
    if (branch.commitId === expectedRevisionId) {
      if (response.status !== 200 || !(await this.workspaceStatus(record.workspaceId)).clean) {
        throw new Error('Diversion checkpoint response did not advance or clean the workspace');
      }
      await this.inspectExact(authority, record, expectedRevisionId);
      return this.checkpointAction(state, child, expectedRevisionId, false);
    }
    if (response.status === 201) {
      const body = exactObject(response.body, 'Diversion checkpoint response');
      const responseId = exactCommitId(body.id, 'Diversion checkpoint response.id');
      if (responseId !== branch.commitId)
        throw new Error('Diversion checkpoint response id is not branch head');
      if (!Array.isArray(body.failed_paths) || body.failed_paths.length !== 0) {
        throw new Error('Diversion checkpoint reported failed paths');
      }
    }
    await this.validateRecoveredCommit(record, branch.commitId, expectedRevisionId, message);
    await this.cleanIgnoredProducts(authority.localPath);
    await this.inspectExact(authority, record, branch.commitId);
    return this.checkpointAction(state, child, branch.commitId, true);
  }

  private reviewAction(
    state: MissionState,
    child: MissionChildState,
    artifact: MissionReviewArtifact,
  ): RecordReviewAction {
    return {
      type: 'record-review',
      reviewId: `diversion-review:${digest({
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

  private async reconcile(
    state: MissionState,
    child: MissionChildState,
    authority: DiversionMissionAuthority,
    record: DiversionMissionLeaseRecord,
  ): Promise<RecordWorkspaceReconciledAction> {
    if (!record.branchId || !record.workspaceId) {
      throw new Error('Diversion reconciliation requires durable remote identities');
    }
    const expectedRevisionId = this.expectedRevision(state);
    const branch = await this.branchById(record.branchId);
    if (!branch) {
      throw new Error('Diversion refuses to discard an unexpected committed revision during reconciliation');
    }
    this.validateBranch(branch, authority, record, expectedRevisionId, record.branchId);
    await this.waitForLocalRevision(authority.localPath, expectedRevisionId);
    if (!(await this.workspaceStatus(record.workspaceId)).clean) {
      const response = await this.api('POST', `/workspaces/${encodeURIComponent(record.workspaceId)}/reset`, {
        all: true,
        paths: null,
        delete_added: true,
        write_to_journal: true,
      });
      if (response.status !== 200) {
        throw new Error(`Diversion workspace reset failed: HTTP ${response.status}`);
      }
      const body = exactObject(response.body, 'Diversion workspace reset response');
      if (!Array.isArray(body.success) || !Array.isArray(body.fail) || body.fail.length !== 0) {
        throw new Error('Diversion workspace reset response is incomplete or contains failed paths');
      }
    }
    await this.cleanIgnoredProducts(authority.localPath);
    await this.inspectExact(authority, record, expectedRevisionId);
    return {
      type: 'record-workspace-reconciled',
      childId: child.childId,
      revisionId: expectedRevisionId,
      disposition: 'restored',
      summary: `Diversion workspace restored cleanly to ${expectedRevisionId}.`,
    };
  }

  async recordAfterChild(
    state: MissionState,
    child: MissionChildState,
  ): Promise<readonly MissionEvidenceAction[]> {
    if (!['succeeded', 'failed', 'cancelled', 'lost'].includes(child.status)) {
      throw new Error(`cannot record Diversion evidence for non-terminal child '${child.childId}'`);
    }
    if (!child.attemptId) throw new Error(`terminal child '${child.childId}' has no durable attempt id`);
    const durableChild = ownMissionValue(state.children, child.childId);
    if (!durableChild || canonicalMissionJson(durableChild) !== canonicalMissionJson(child)) {
      throw new Error(`child '${child.childId}' does not match its durable mission authority`);
    }
    const config = await this.configure();
    const authority = this.stateAuthority(state, config);
    return this.locked(state.missionId, async () => {
      const record = await this.readRecord(config, authority);
      if (!record || record.phase !== 'active') {
        throw new Error(`terminal child '${child.childId}' has no active Diversion mission lease`);
      }
      if (child.permission === 'write' && child.status === 'succeeded') {
        return [await this.checkpoint(state, child, authority, record)];
      }
      if (child.permission === 'write') {
        return [await this.reconcile(state, child, authority, record)];
      }
      if (!child.subjectCheckpointId) {
        await this.inspectExact(authority, record, this.expectedRevision(state));
        return [];
      }
      if (child.status !== 'succeeded') {
        await this.inspectExact(authority, record, this.expectedChildRevision(state, child));
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
        throw new Error(`review child '${child.childId}' lacks an exact artifact for its subject`);
      }
      await this.inspectExact(authority, record, exactCommitId(checkpoint.revisionId));
      return [this.reviewAction(state, child, artifact)];
    });
  }

  async validate(
    state: MissionState,
    checkpoint: MissionCheckpointState,
    requestedPolicy: Extract<MissionValidationPolicy, { kind: 'command' }>,
    signal: AbortSignal,
  ): Promise<RecordValidationAction> {
    const durableCheckpoint = ownMissionValue(state.checkpoints, checkpoint.checkpointId);
    const latest = latestCheckpoint(state);
    if (
      !durableCheckpoint ||
      canonicalMissionJson(durableCheckpoint) !== canonicalMissionJson(checkpoint) ||
      latest?.checkpointId !== checkpoint.checkpointId ||
      !checkpoint.clean
    ) {
      throw new Error('Diversion validation requires the exact latest clean durable checkpoint');
    }
    if (
      state.validationPolicy?.kind !== 'command' ||
      canonicalMissionJson(state.validationPolicy) !== canonicalMissionJson(requestedPolicy)
    ) {
      throw new Error('Diversion validation policy does not match durable mission authority');
    }
    const policy = exactValidationPolicy(requestedPolicy);
    const revisionId = exactCommitId(checkpoint.revisionId);
    const activeValidation = state.activeValidation;
    if (
      !activeValidation ||
      activeValidation.checkpointId !== checkpoint.checkpointId ||
      activeValidation.revisionId !== revisionId ||
      activeValidation.policyId !== policy.policyId
    ) {
      throw new Error('Diversion validation has no matching durable active attempt');
    }
    const containment = this.containment;
    if (!containment) {
      throw new Error('Diversion command validation cannot run before containment is bound');
    }
    const config = await this.configure();
    const authority = this.stateAuthority(state, config);
    return this.locked(state.missionId, async () => {
      const record = await this.readRecord(config, authority);
      if (!record || record.phase !== 'active') {
        throw new Error('Diversion validation requires an active durable workspace lease');
      }
      const changedBefore = await this.restoreValidationWorkspace(authority, record, revisionId);
      const result = await this.runContainedValidation(
        containment,
        activeValidation.validationId,
        authority.localPath,
        policy,
        signal,
      );
      const changedAfter = await this.restoreValidationWorkspace(authority, record, revisionId);
      if (result.aborted) {
        throw new Error('Diversion validation aborted after contained process-tree termination');
      }
      const workspaceChanged = changedBefore || changedAfter;
      const note = workspaceChanged
        ? '\n\n[Noriq] Validation changed the exact Diversion workspace; all workspace-visible changes were discarded before the checkpoint was restored.'
        : '';
      return {
        type: 'record-validation',
        validationId: activeValidation.validationId,
        checkpointId: checkpoint.checkpointId,
        revisionId,
        policyId: policy.policyId,
        disposition: result.exitCode === 0 && !result.timedOut && !workspaceChanged ? 'passed' : 'failed',
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        workspaceChanged,
        outputTail: utf8Tail(`${result.output}${note}`, MAX_MISSION_VALIDATION_OUTPUT_BYTES),
      };
    });
  }

  async recover(
    state: MissionState,
    checkpoint: MissionCheckpointState,
    requestedPolicy: Extract<MissionValidationPolicy, { kind: 'command' }>,
  ): Promise<RecordValidationAction> {
    const policy = exactValidationPolicy(requestedPolicy);
    const attempt = state.activeValidation;
    if (
      !attempt ||
      attempt.checkpointId !== checkpoint.checkpointId ||
      attempt.revisionId !== checkpoint.revisionId ||
      attempt.policyId !== policy.policyId
    ) {
      throw new Error('Diversion validation recovery lacks exact durable attempt authority');
    }
    const revisionId = exactCommitId(checkpoint.revisionId, 'validation recovery revision');
    const config = await this.configure();
    const authority = this.stateAuthority(state, config);
    return this.locked(state.missionId, async () => {
      const record = await this.readRecord(config, authority);
      if (!record || record.phase !== 'active') {
        throw new Error('Diversion validation recovery requires an active durable workspace lease');
      }
      const workspaceChanged = await this.restoreValidationWorkspace(authority, record, revisionId);
      return {
        type: 'record-validation',
        validationId: attempt.validationId,
        checkpointId: checkpoint.checkpointId,
        revisionId,
        policyId: policy.policyId,
        disposition: 'failed',
        exitCode: null,
        timedOut: false,
        workspaceChanged,
        outputTail: utf8Tail(
          `The validation attempt was interrupted before a durable result. Runner restored exact Diversion revision ${revisionId} without re-running the command.`,
          MAX_MISSION_VALIDATION_OUTPUT_BYTES,
        ),
      };
    });
  }

  private async cleanIgnoredProducts(localPath: string): Promise<boolean> {
    const result = await this.cli(['clean', '-f'], localPath);
    if (result.stderr.trim() !== '') throw new Error('Diversion clean emitted unexpected stderr');
    if (Buffer.byteLength(result.stdout, 'utf8') > MAX_API_BODY_BYTES) {
      throw new Error('Diversion clean output was oversized');
    }
    if (typeof result.removedWorkspaceEntries !== 'boolean') {
      throw new Error('trusted Diversion CLI transport must attest whether clean removed workspace entries');
    }
    return result.removedWorkspaceEntries;
  }

  /** Restore a crashed or completed validation attempt to the named checkpoint before continuing. */
  private async restoreValidationWorkspace(
    authority: DiversionMissionAuthority,
    record: DiversionMissionLeaseRecord,
    revisionId: string,
  ): Promise<boolean> {
    if (!record.branchId || !record.workspaceId) {
      throw new Error('Diversion validation restoration requires durable remote identities');
    }
    const branch = await this.branchById(record.branchId);
    if (!branch) {
      throw new Error('Diversion validation refuses to restore across an unexpected committed revision');
    }
    this.validateBranch(branch, authority, record, revisionId, record.branchId);
    await this.waitForLocalRevision(authority.localPath, revisionId);
    const changed = !(await this.workspaceStatus(record.workspaceId)).clean;
    if (changed) {
      const response = await this.api('POST', `/workspaces/${encodeURIComponent(record.workspaceId)}/reset`, {
        all: true,
        paths: null,
        delete_added: true,
        write_to_journal: true,
      });
      if (response.status !== 200) {
        throw new Error(`Diversion validation reset failed: HTTP ${response.status}`);
      }
      const body = exactObject(response.body, 'Diversion validation reset response');
      if (!Array.isArray(body.success) || !Array.isArray(body.fail) || body.fail.length !== 0) {
        throw new Error('Diversion validation reset response contains failed or ambiguous paths');
      }
    }
    const removedWorkspaceEntries = await this.cleanIgnoredProducts(authority.localPath);
    await this.inspectExact(authority, record, revisionId);
    return changed || removedWorkspaceEntries;
  }

  private async runContainedValidation(
    containment: AgentProcessContainment,
    validationId: string,
    localPath: string,
    policy: Extract<MissionValidationPolicy, { kind: 'command' }>,
    signal: AbortSignal,
  ): Promise<{
    exitCode: number | null;
    output: string;
    timedOut: boolean;
    aborted: boolean;
  }> {
    const shell = policy.shell ?? '/bin/sh';
    const launched = containment.spawn({
      runId: validationId,
      command: shell,
      args: ['-c', policy.command],
      cwd: localPath,
      workspaceRoot: localPath,
      workspaceWrite: true,
      protectedWorkspaceReadOnlyPaths: ['.diversion'],
      env: missionAgentEnv(),
    });
    let output = Buffer.alloc(0);
    const capture = (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      output = Buffer.concat([output, value]);
      if (output.byteLength > MAX_MISSION_VALIDATION_OUTPUT_BYTES) {
        output = output.subarray(output.byteLength - MAX_MISSION_VALIDATION_OUTPUT_BYTES);
      }
    };
    launched.child.stdout.on('data', capture);
    launched.child.stderr.on('data', capture);
    let timedOut = false;
    let aborted = false;
    const stop = (reason: 'timeout' | 'abort') => {
      if (reason === 'timeout') timedOut = true;
      else aborted = true;
      launched.terminate('SIGKILL');
    };
    const timer = setTimeout(() => stop('timeout'), policy.timeoutSeconds * 1_000);
    timer.unref?.();
    const abort = () => stop('abort');
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    try {
      await launched.exited;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
    return {
      exitCode: launched.child.exitCode,
      output: utf8Tail(output.toString('utf8'), MAX_MISSION_VALIDATION_OUTPUT_BYTES),
      timedOut,
      aborted,
    };
  }

  private async locatorExists(localPath: string): Promise<boolean> {
    try {
      await lstat(path.join(localPath, '.diversion'));
      return true;
    } catch (error) {
      if (errno(error) === 'ENOENT') return false;
      throw error;
    }
  }

  private async unregisterLocal(authority: DiversionMissionAuthority): Promise<void> {
    if (!(await this.localPathExists(authority.localPath))) return;
    await this.assertRealLocalDirectory(authority.localPath);
    if (!(await this.locatorExists(authority.localPath))) return;
    const result = await this.cli(['unregister', '-f'], authority.localPath);
    if (result.stderr.trim() !== '') throw new Error('Diversion unregister emitted unexpected stderr');
    if (await this.locatorExists(authority.localPath)) {
      throw new Error('Diversion unregister returned but the local locator still exists');
    }
  }

  private async deleteRemoteWorkspace(workspaceId: string, workspaceName: string): Promise<void> {
    const response = await this.api('DELETE', `/workspaces/${encodeURIComponent(workspaceId)}`);
    if (response.status !== 204 && response.status !== 404) {
      throw new Error(`Diversion workspace deletion failed: HTTP ${response.status}`);
    }
    if (await this.workspaceById(workspaceId)) {
      throw new Error(`Diversion workspace '${workspaceId}' still exists after deletion`);
    }
    if (await this.workspaceByName(workspaceName)) {
      throw new Error(`Diversion workspace name '${workspaceName}' still exists after deletion`);
    }
  }

  private async removeLocalWorkspace(authority: DiversionMissionAuthority): Promise<void> {
    if (!(await this.localPathExists(authority.localPath))) return;
    await this.assertRealLocalDirectory(authority.localPath);
    if (await this.locatorExists(authority.localPath)) {
      throw new Error('refusing to remove a still-registered Diversion mission workspace');
    }
    await rm(authority.localPath, { recursive: true, force: false });
    const parent = await open(path.dirname(authority.localPath), constants.O_RDONLY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }

  async execute(state: MissionState, cleanupId: string): Promise<void> {
    if (cleanupId !== DIVERSION_MISSION_WORKSPACE_CLEANUP_ID) {
      throw new Error(`unsupported Diversion mission cleanup obligation '${cleanupId}'`);
    }
    const terminal = state.terminal;
    if (!terminal || !['succeeded', 'failed', 'cancelled'].includes(state.status)) {
      throw new Error('Diversion mission workspace cleanup requires a terminal mission');
    }
    const config = await this.configure();
    const authority = this.stateAuthority(state, config);
    const preserveRevisionId = this.expectedRevision(state);
    await this.locked(state.missionId, async () => {
      let record = await this.readRecord(config, authority);
      if (!record) {
        if (
          (await this.branchByName(authority.branchName)) ||
          (await this.workspaceByName(authority.workspaceName))
        ) {
          throw new Error('cannot clean unrecorded Diversion mission remote authority');
        }
        if (await this.localPathExists(authority.localPath)) {
          throw new Error('cannot clean unrecorded Diversion mission local workspace');
        }
        return;
      }
      if (record.phase === 'released') {
        if (record.preservedRevisionId !== preserveRevisionId) {
          throw new Error('released Diversion mission preserves a different revision');
        }
        if (record.branchId) {
          const branch = await this.branchById(record.branchId);
          if (!branch) {
            throw new Error('released Diversion mission branch no longer preserves its revision');
          }
          this.validateBranch(branch, authority, record, preserveRevisionId, record.branchId);
        } else if (
          terminal.outcome === 'succeeded' ||
          record.workspaceId ||
          record.materialized ||
          (await this.branchByName(authority.branchName)) ||
          (await this.workspaceByName(authority.workspaceName)) ||
          (await this.localPathExists(authority.localPath))
        ) {
          throw new Error('released effect-free Diversion lease no longer has exact authority');
        }
        if (
          (record.workspaceId && (await this.workspaceById(record.workspaceId))) ||
          (await this.workspaceByName(authority.workspaceName))
        ) {
          throw new Error('released Diversion mission workspace still exists remotely');
        }
        return;
      }

      let branch = record.branchId ? await this.branchById(record.branchId) : null;
      if (!branch) branch = await this.branchByName(authority.branchName);
      if (!branch) {
        if (
          record.branchId ||
          record.workspaceId ||
          record.materialized ||
          terminal.outcome === 'succeeded' ||
          (await this.workspaceByName(authority.workspaceName)) ||
          (await this.localPathExists(authority.localPath))
        ) {
          throw new Error('Diversion cleanup cannot classify a missing mission branch');
        }
        record = {
          ...record,
          phase: 'released',
          localUnregistered: true,
          remoteWorkspaceDeleted: true,
          localRemoved: true,
          preservedRevisionId: preserveRevisionId,
        };
        await this.writeRecord(config, record);
        return;
      }
      this.validateBranch(branch, authority, record, preserveRevisionId, record.branchId);
      if (record.branchId === null) {
        record = { ...record, branchId: branch.branchId };
        await this.writeRecord(config, record);
      }

      let workspace = record.workspaceId ? await this.workspaceById(record.workspaceId) : null;
      if (!workspace) workspace = await this.workspaceByName(authority.workspaceName);
      if (workspace) {
        if (record.remoteWorkspaceDeleted) {
          throw new Error('Diversion workspace exists after its durable deletion marker');
        }
        this.validateWorkspace(workspace, authority, branch.branchId, preserveRevisionId, record.workspaceId);
        if (record.workspaceId === null) {
          record = { ...record, workspaceId: workspace.workspaceId };
          await this.writeRecord(config, record);
        }
      } else if (record.workspaceId === null) {
        if (record.materialized || (await this.localPathExists(authority.localPath))) {
          throw new Error('Diversion cleanup found local effects without a durable workspace id');
        }
      } else if (!record.remoteWorkspaceDeleted && !record.localUnregistered) {
        throw new Error('Diversion cleanup cannot classify its missing remote workspace');
      }

      if (record.phase !== 'releasing') {
        record = { ...record, phase: 'releasing', preservedRevisionId: preserveRevisionId };
        await this.writeRecord(config, record);
      } else if (record.preservedRevisionId !== preserveRevisionId) {
        throw new Error('releasing Diversion mission preserves a different revision');
      }
      if (!record.localUnregistered) {
        if (workspace && !(await this.workspaceStatus(workspace.workspaceId)).clean) {
          throw new Error('refusing to clean a dirty terminal Diversion workspace');
        }
        await this.unregisterLocal(authority);
        record = { ...record, localUnregistered: true };
        await this.writeRecord(config, record);
      }
      if (!workspace && record.workspaceId && !record.remoteWorkspaceDeleted) {
        // The only adapter-owned route here is a successful delete followed by a record-write crash:
        // unregister was durable before deletion and both exact remote lookups now prove absence.
        record = { ...record, remoteWorkspaceDeleted: true };
        await this.writeRecord(config, record);
      }
      if (!record.remoteWorkspaceDeleted) {
        if (workspace) {
          await this.deleteRemoteWorkspace(workspace.workspaceId, authority.workspaceName);
        } else if (record.workspaceId) {
          throw new Error('Diversion cleanup lost its remote workspace authority');
        }
        record = { ...record, remoteWorkspaceDeleted: true };
        await this.writeRecord(config, record);
      }
      if (!record.localRemoved) {
        await this.removeLocalWorkspace(authority);
        record = { ...record, localRemoved: true };
        await this.writeRecord(config, record);
      }
      branch = record.branchId ? await this.branchById(record.branchId) : null;
      if (!branch) throw new Error('Diversion accepted branch changed during cleanup');
      this.validateBranch(branch, authority, record, preserveRevisionId, record.branchId);
      record = { ...record, phase: 'released', preservedRevisionId: preserveRevisionId };
      await this.writeRecord(config, record);
    });
  }

  async record(state: MissionState): Promise<RecordAcceptedRevisionHandoffAction | null> {
    if (state.terminal?.outcome !== 'succeeded') return null;
    const checkpointId = state.terminal.checkpointId;
    if (!checkpointId) throw new Error('successful Diversion mission has no accepted checkpoint');
    const checkpoint = ownMissionValue(state.checkpoints, checkpointId);
    if (!checkpoint || !checkpoint.clean) {
      throw new Error(`terminal accepted Diversion checkpoint '${checkpointId}' is missing or dirty`);
    }
    const revisionId = exactCommitId(checkpoint.revisionId);
    const config = await this.configure();
    const authority = this.stateAuthority(state, config);
    return this.locked(state.missionId, async () => {
      const lease = await this.readRecord(config, authority);
      if (!lease || lease.phase !== 'released' || lease.preservedRevisionId !== revisionId) {
        throw new Error('accepted Diversion handoff requires a released exact workspace lease');
      }
      const branch = lease.branchId ? await this.branchById(lease.branchId) : null;
      if (!branch) {
        throw new Error('preserved Diversion mission branch no longer names the accepted revision');
      }
      this.validateBranch(branch, authority, lease, revisionId, lease.branchId);
      return {
        type: 'record-accepted-revision-handoff',
        backend: 'diversion',
        repositoryKey: this.repositoryKey,
        checkpointId,
        revisionId,
        reference: authority.branchName,
        status: 'preserved',
      };
    });
  }
}
