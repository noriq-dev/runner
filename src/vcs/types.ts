import type { ProjectConfig } from "../config.js";
import type { CheckResult } from "../contracts.js";

export type WorkspaceMode = "isolated" | "direct";
export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export interface BackendHandle {
  backend: string;
  version: 1;
  state: Record<string, JsonValue>;
}

export interface SourceControlCheckpoint {
  ref: string;
  label: string;
  url: string | null;
}
export type VcsCheckpoint = SourceControlCheckpoint;

export interface RetainedLocation {
  vcs: string;
  label: string;
  url: string | null;
}

export interface JobWorkspace {
  handle: BackendHandle;
  vcs: string;
  mode: WorkspaceMode;
  repositoryIdentity: string;
  path: string;
  baseRevision: string;
  currentRevision: string;
  retainedLocation: RetainedLocation;
}

export interface TaskWorkspace {
  handle: BackendHandle;
  path: string;
  baseRevision: string;
}

export interface SourceControlCapabilities {
  isolatedMode: boolean;
  directMode: boolean;
  parallelTaskWorkspaces: boolean;
  durableRecovery: boolean;
  automatedConflictRepair: boolean;
}

export interface ReadyCandidate {
  status: "ready";
  checkpoint: SourceControlCheckpoint;
  changedPaths: string[];
  backendState: BackendHandle;
}

export interface ConflictCandidate {
  status: "conflict";
  paths: string[];
  detail: string;
  backendState: BackendHandle;
}

export type StagedCandidateResult = ReadyCandidate | ConflictCandidate;

export interface WorkspaceInspection {
  revision: string;
  dirtyPaths: string[];
  retainedLocation: RetainedLocation;
}

export class IntegrationConflict extends Error {
  constructor(
    message: string,
    readonly detail: string,
    readonly paths: string[] = [],
  ) {
    super(message);
  }
}

export interface SourceControlBackend {
  readonly id: string;
  readonly kind: string;
  readonly capabilities: SourceControlCapabilities;
  discoverRepository(path: string): Promise<string>;
  repositoryIdentity(path: string): Promise<string>;
  revisionOf(path: string, reference: string): Promise<string>;
  openJob(options: {
    repository: string;
    stateDirectory: string;
    jobId: string;
    key: string;
    kind: "task" | "plan";
    expectedBaseRevision: string;
    config: ProjectConfig;
  }): Promise<JobWorkspace>;
  restoreJob(options: {
    repository: string;
    stateDirectory: string;
    jobId: string;
    handle: BackendHandle;
    mode: WorkspaceMode;
    baseRevision: string;
    currentRevision: string;
  }): Promise<JobWorkspace>;
  beginTask(workspace: JobWorkspace, taskKey: string): Promise<TaskWorkspace>;
  stageCandidate(options: {
    workspace: JobWorkspace;
    task: TaskWorkspace;
    taskKey: string;
    summary: string;
    refresh: boolean;
  }): Promise<StagedCandidateResult>;
  integrateLatest(
    workspace: JobWorkspace,
    task: TaskWorkspace,
  ): Promise<StagedCandidateResult | null>;
  continueConflict(task: TaskWorkspace): Promise<void>;
  abortConflict(task: TaskWorkspace): Promise<void>;
  reviewDiff(
    workspace: JobWorkspace,
    task: TaskWorkspace,
    candidate: SourceControlCheckpoint,
  ): Promise<string>;
  acceptCandidate(options: {
    workspace: JobWorkspace;
    task: TaskWorkspace;
    candidate: SourceControlCheckpoint;
    taskKey: string;
  }): Promise<SourceControlCheckpoint>;
  preserveFailedWork(options: {
    workspace: JobWorkspace;
    task: TaskWorkspace;
    taskKey: string;
    reason: string;
  }): Promise<RetainedLocation | null>;
  inspect(workspace: JobWorkspace): Promise<WorkspaceInspection>;
  inspectTask(task: TaskWorkspace): Promise<WorkspaceInspection>;
  releaseTask(workspace: JobWorkspace, task: TaskWorkspace): Promise<void>;
  release(workspace: JobWorkspace, jobId: string): Promise<void>;
  recoverOrphans(repository: string, stateDirectory: string): Promise<string[]>;
  runCommands(
    path: string,
    commands: string[],
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<CheckResult[]>;
}

export function assertBackendHandle(
  handle: BackendHandle,
  backend: string,
  context: string,
): void {
  if (
    !handle ||
    handle.backend !== backend ||
    handle.version !== 1 ||
    !handle.state ||
    typeof handle.state !== "object" ||
    Array.isArray(handle.state)
  )
    throw new Error(
      `${backend} refuses ${context}: handle was minted by another backend or protocol version`,
    );
}
