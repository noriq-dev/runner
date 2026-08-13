import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  type FileHandle,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CommissionedExecutionProfile as CommissionedExecutionProfileSchema,
  MissionLeaseRef as MissionLeaseRefSchema,
  MissionTaskAck as MissionTaskAckSchema,
  MissionTaskBeginReport as MissionTaskBeginReportSchema,
  MissionTaskSettleReport as MissionTaskSettleReportSchema,
} from '@noriq-dev/shared';
import type {
  CommissionedExecutionProfile,
  MissionLeaseRef,
  MissionTaskAck,
  MissionTaskBeginReport,
  MissionTaskSettleReport,
} from '@noriq-dev/shared';
import { z } from 'zod';
import type { MissionAcceptedRevisionHandoffState } from './model';
import type { MissionBudget, MissionUsage } from './protocol';
import { canonicalMissionJson } from './store';

export const NORIQ_MISSION_COMMISSION_SCHEMA_VERSION = 1 as const;
export const NORIQ_COORDINATOR_WAL_SCHEMA_VERSION = 1 as const;
export const MAX_NORIQ_COMMISSION_TASKS = 256;
export const MAX_NORIQ_TASK_BRIEF_CHARS = 64_000;
export const MAX_NORIQ_TASK_DEPENDENCIES = 256;
export const MAX_NORIQ_COMMISSION_BYTES = 2 * 1024 * 1024;
export const MAX_NORIQ_COORDINATOR_ACTION_BYTES = 2 * 1024 * 1024 + 64 * 1024;
export const MAX_NORIQ_COORDINATOR_WAL_BYTES = 32 * 1024 * 1024;
export const MAX_NORIQ_COORDINATOR_WAL_ACTIONS = 8_192;
export const MAX_NORIQ_COORDINATOR_ROOTS = 4_096;

const IDENTIFIER_MAX = 1_024;
const CHILD_KEY_MAX = 160;
const REASON_MAX = 2_000;
const ANSWER_MAX = 50_000;
const QUESTION_MAX = 20_000;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const DEFAULT_LOCK_POLL_MS = 10;
const DEFAULT_STALE_LOCK_MS = 5 * 60_000;
const LOCK_NAMESPACE_MARKER = 'noriq-coordinator-bakery-lock-v1\n';
const LOCK_TOKEN_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const LOCK_TICKET_DIGITS = 16;
const LINUX_BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
const LINUX_BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const Identifier = z
  .string()
  .min(1)
  .max(IDENTIFIER_MAX)
  .refine((value) => !value.includes('\0'));
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const BudgetValue = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const MissionBudgetSchema = z
  .object({
    tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    usd: BudgetValue,
    activeSeconds: z.number().positive().finite().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const MissionUsageSchema = z
  .object({
    tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    usd: BudgetValue,
    activeSeconds: z.number().nonnegative().finite().max(Number.MAX_SAFE_INTEGER).nullable(),
  })
  .strict();
const ResourcesSchema = z
  .record(z.string().min(1).max(160), z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
  .refine((value) => Object.keys(value).length <= 128, 'resources must contain at most 128 keys');

export interface NoriqMissionTaskSnapshot {
  taskId: string;
  childKey: string;
  brief: string;
  dependencyIds: readonly string[];
}

export interface NoriqMissionCommission {
  schemaVersion: typeof NORIQ_MISSION_COMMISSION_SCHEMA_VERSION;
  rootRunId: string;
  lease: MissionLeaseRef;
  commissionDigest: string;
  /** Exact digest Noriq computed over its immutable task/plan snapshot. */
  serverCommissionDigest: string;
  /** Plan roots publish their accepted revision; explicit task roots intentionally do not. */
  publishHandoff: boolean;
  executionProfile: CommissionedExecutionProfile;
  repositoryKey: string;
  baseRevision: string;
  tasks: readonly NoriqMissionTaskSnapshot[];
  budget: MissionBudget;
  catalogFingerprint: string;
  resources: Readonly<Record<string, number>>;
}

const NoriqMissionTaskSnapshotSchema = z
  .object({
    taskId: Identifier,
    childKey: z
      .string()
      .min(1)
      .max(CHILD_KEY_MAX)
      .refine((value) => !value.includes('\0')),
    brief: z
      .string()
      .min(1)
      .max(MAX_NORIQ_TASK_BRIEF_CHARS)
      .refine((value) => !value.includes('\0')),
    dependencyIds: z.array(Identifier).max(MAX_NORIQ_TASK_DEPENDENCIES),
  })
  .strict();

const NoriqMissionCommissionSchema = z
  .object({
    schemaVersion: z.literal(NORIQ_MISSION_COMMISSION_SCHEMA_VERSION),
    rootRunId: Identifier,
    lease: MissionLeaseRefSchema,
    commissionDigest: Digest,
    serverCommissionDigest: Digest,
    publishHandoff: z.boolean(),
    executionProfile: CommissionedExecutionProfileSchema,
    repositoryKey: Identifier,
    baseRevision: Identifier,
    tasks: z.array(NoriqMissionTaskSnapshotSchema).min(1).max(MAX_NORIQ_COMMISSION_TASKS),
    budget: MissionBudgetSchema,
    catalogFingerprint: Digest,
    resources: ResourcesSchema,
  })
  .strict();

const AcceptedRevisionHandoffSchema = z
  .object({
    backend: Identifier,
    repositoryKey: Identifier,
    checkpointId: Identifier,
    revisionId: Identifier,
    reference: Identifier,
    status: z.literal('preserved'),
  })
  .strict();

const ControlObservationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('human-question'),
      usage: MissionUsageSchema,
      questionId: Identifier,
      prompt: z.string().min(1).max(QUESTION_MAX),
    })
    .strict(),
  z
    .object({
      kind: z.literal('runtime-error'),
      usage: MissionUsageSchema,
      error: z.string().min(1).max(REASON_MAX),
    })
    .strict(),
  z
    .object({
      kind: z.literal('terminal'),
      usage: MissionUsageSchema,
      localOutcome: z.enum(['succeeded', 'failed', 'cancelled']),
      reason: z.string().min(1).max(REASON_MAX),
      handoff: AcceptedRevisionHandoffSchema.nullable(),
      settlementOutcome: z.enum(['done', 'failed', 'cancelled']),
      settlementReason: z.string().max(REASON_MAX).nullable(),
      cumulativeUsage: MissionUsageSchema,
    })
    .strict(),
]);
export type NoriqCoordinatorControlObservation = z.infer<typeof ControlObservationSchema>;

const CommissionedActionSchema = z
  .object({ type: z.literal('commissioned'), commission: NoriqMissionCommissionSchema })
  .strict();
const TaskPreparedActionSchema = z
  .object({
    type: z.literal('task-prepared'),
    taskIndex: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_NORIQ_COMMISSION_TASKS - 1),
    missionId: Identifier,
    attemptId: z.string().min(1).max(CHILD_KEY_MAX),
    baseRevision: Identifier,
    budget: MissionBudgetSchema,
    beginReport: MissionTaskBeginReportSchema,
  })
  .strict();
const TaskBeginAcknowledgedActionSchema = z
  .object({
    type: z.literal('task-begin-acknowledged'),
    taskIndex: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_NORIQ_COMMISSION_TASKS - 1),
    ack: MissionTaskAckSchema,
  })
  .strict();
const TaskMissionCreatedActionSchema = z
  .object({
    type: z.literal('task-mission-created'),
    taskIndex: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_NORIQ_COMMISSION_TASKS - 1),
  })
  .strict();
const TaskControlObservedActionSchema = z
  .object({
    type: z.literal('task-control-observed'),
    taskIndex: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_NORIQ_COMMISSION_TASKS - 1),
    observation: ControlObservationSchema,
  })
  .strict();
const QuestionPublicationAcceptedActionSchema = z
  .object({
    type: z.literal('question-publication-accepted'),
    taskIndex: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_NORIQ_COMMISSION_TASKS - 1),
    questionId: Identifier,
    reportId: Identifier,
    signalId: Identifier,
  })
  .strict();
const TaskAnswerPreparedActionSchema = z
  .object({
    type: z.literal('task-answer-prepared'),
    taskIndex: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_NORIQ_COMMISSION_TASKS - 1),
    questionId: Identifier,
    answer: z.string().min(1).max(ANSWER_MAX),
  })
  .strict();
const TaskSettlePreparedActionSchema = z
  .object({
    type: z.literal('task-settle-prepared'),
    taskIndex: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_NORIQ_COMMISSION_TASKS - 1),
    report: MissionTaskSettleReportSchema,
  })
  .strict();
const TaskSettleAcknowledgedActionSchema = z
  .object({
    type: z.literal('task-settle-acknowledged'),
    taskIndex: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_NORIQ_COMMISSION_TASKS - 1),
    ack: MissionTaskAckSchema,
  })
  .strict();
const LeaseAdoptedActionSchema = z
  .object({
    type: z.literal('lease-adopted'),
    previousLease: MissionLeaseRefSchema,
    lease: MissionLeaseRefSchema,
    liveAttemptIds: z.array(z.string().min(1).max(CHILD_KEY_MAX)).max(MAX_NORIQ_COMMISSION_TASKS),
  })
  .strict();
const ServerDispositionRecordedActionSchema = z
  .object({
    type: z.literal('server-disposition-recorded'),
    decision: z.enum(['already_terminal', 'cancel', 'unknown']),
    reason: z.string().max(REASON_MAX).nullable(),
  })
  .strict();
const CancelRequestedActionSchema = z
  .object({ type: z.literal('cancel-requested'), reason: z.string().min(1).max(REASON_MAX) })
  .strict();
const CoordinatorFailedActionSchema = z
  .object({ type: z.literal('coordinator-failed'), reason: z.string().min(1).max(REASON_MAX) })
  .strict();
const HandoffPublicationAcceptedActionSchema = z
  .object({
    type: z.literal('handoff-publication-accepted'),
    reportId: Identifier,
    handoffId: Identifier,
  })
  .strict();

export const NoriqCoordinatorActionSchema = z.discriminatedUnion('type', [
  CommissionedActionSchema,
  TaskPreparedActionSchema,
  TaskBeginAcknowledgedActionSchema,
  TaskMissionCreatedActionSchema,
  TaskControlObservedActionSchema,
  QuestionPublicationAcceptedActionSchema,
  TaskAnswerPreparedActionSchema,
  TaskSettlePreparedActionSchema,
  TaskSettleAcknowledgedActionSchema,
  LeaseAdoptedActionSchema,
  ServerDispositionRecordedActionSchema,
  CancelRequestedActionSchema,
  CoordinatorFailedActionSchema,
  HandoffPublicationAcceptedActionSchema,
]);
export type NoriqCoordinatorAction = z.infer<typeof NoriqCoordinatorActionSchema>;

interface NoriqCoordinatorWalRecordWithoutHash {
  schemaVersion: typeof NORIQ_COORDINATOR_WAL_SCHEMA_VERSION;
  rootRunId: string;
  revision: number;
  actionId: string;
  actionFingerprint: string;
  recordedAt: string;
  previousHash: string | null;
  action: NoriqCoordinatorAction;
}

const NoriqCoordinatorWalRecordSchema = z
  .object({
    schemaVersion: z.literal(NORIQ_COORDINATOR_WAL_SCHEMA_VERSION),
    rootRunId: Identifier,
    revision: z.number().int().positive(),
    actionId: Identifier,
    actionFingerprint: Digest,
    recordedAt: z.string().datetime(),
    previousHash: Digest.nullable(),
    action: NoriqCoordinatorActionSchema,
    hash: Digest,
  })
  .strict();

export type NoriqCoordinatorWalRecord = z.infer<typeof NoriqCoordinatorWalRecordSchema>;

export interface NoriqCoordinatorHistory {
  rootRunId: string;
  revision: number;
  headHash: string | null;
  records: readonly NoriqCoordinatorWalRecord[];
}

export interface NoriqCoordinatorAppendResult {
  history: NoriqCoordinatorHistory;
  replayed: boolean;
}

export interface NoriqCoordinatorControllerLease {
  release(): Promise<void>;
}

export class NoriqCoordinatorConflictError extends Error {
  override readonly name = 'NoriqCoordinatorConflictError';

  constructor(
    readonly kind: 'revision' | 'action',
    message: string,
  ) {
    super(message);
  }
}

export class NoriqCoordinatorCorruptionError extends Error {
  override readonly name = 'NoriqCoordinatorCorruptionError';

  constructor(rootRunId: string, line: number, message: string) {
    super(`Noriq mission coordinator WAL '${rootRunId}' is corrupt at line ${line}: ${message}`);
  }
}

export class NoriqCoordinatorBusyError extends Error {
  override readonly name = 'NoriqCoordinatorBusyError';
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function exactIso(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function commissionDigestInput(commission: Omit<NoriqMissionCommission, 'commissionDigest'>): string {
  return canonicalMissionJson(commission);
}

export function computeNoriqMissionCommissionDigest(
  commission: Omit<NoriqMissionCommission, 'commissionDigest'>,
): string {
  return sha256(commissionDigestInput(commission));
}

export function validateNoriqMissionCommission(value: unknown): NoriqMissionCommission {
  if (!isPlainJsonObject(value)) throw new TypeError('Noriq mission commission must be a plain object');
  const parsed = NoriqMissionCommissionSchema.parse(value) as NoriqMissionCommission;
  const seenTasks = new Set<string>();
  const seenChildren = new Set<string>();
  for (const [index, task] of parsed.tasks.entries()) {
    if (seenTasks.has(task.taskId)) throw new TypeError(`duplicate commissioned task '${task.taskId}'`);
    if (seenChildren.has(task.childKey)) {
      throw new TypeError(`duplicate commissioned child key '${task.childKey}'`);
    }
    const seenDependencies = new Set<string>();
    for (const dependencyId of task.dependencyIds) {
      if (seenDependencies.has(dependencyId)) {
        throw new TypeError(`task '${task.taskId}' repeats dependency '${dependencyId}'`);
      }
      seenDependencies.add(dependencyId);
      if (!seenTasks.has(dependencyId)) {
        throw new TypeError(
          `task '${task.taskId}' dependency '${dependencyId}' is absent or not earlier in commissioned order at index ${index}`,
        );
      }
    }
    seenTasks.add(task.taskId);
    seenChildren.add(task.childKey);
  }
  const { commissionDigest: suppliedDigest, ...digestInput } = parsed;
  const expectedDigest = computeNoriqMissionCommissionDigest(digestInput);
  if (suppliedDigest !== expectedDigest) {
    throw new TypeError(
      `commissionDigest mismatch: expected '${expectedDigest}', received '${suppliedDigest}'`,
    );
  }
  const canonical = canonicalMissionJson(parsed);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_NORIQ_COMMISSION_BYTES) {
    throw new TypeError(`Noriq mission commission exceeds ${MAX_NORIQ_COMMISSION_BYTES} bytes`);
  }
  return deepFreeze(parsed);
}

function validateFile(metadata: Stats, filename: string): void {
  if (!metadata.isFile()) throw new Error(`'${filename}' is not a regular file`);
  if (metadata.nlink !== 1) throw new Error(`'${filename}' must have exactly one filesystem link`);
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      throw new Error(`'${filename}' is not owned by the Runner user`);
    }
    if ((metadata.mode & 0o077) !== 0) throw new Error(`'${filename}' is not private`);
  }
}

async function ensurePrivateDirectory(directory: string): Promise<string> {
  const absolute = path.resolve(directory);
  const parent = path.dirname(absolute);
  if (parent === absolute) throw new Error('coordinator state directory cannot be a filesystem root');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  try {
    await mkdir(absolute, { mode: 0o700 });
  } catch (error) {
    if (errno(error) !== 'EEXIST') throw error;
  }
  const metadata = await lstat(absolute);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`coordinator state directory '${absolute}' must be a real directory`);
  }
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      throw new Error(`coordinator state directory '${absolute}' is not owned by the Runner user`);
    }
    if ((metadata.mode & 0o077) !== 0) await chmod(absolute, 0o700);
  }
  return absolute;
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

interface HeldFileLock {
  release(): Promise<void>;
}

interface LinuxProcessIncarnation {
  kind: 'linux-proc';
  bootId: string;
  startTimeTicks: string;
}

interface LockOwner {
  token: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
  processIncarnation: LinuxProcessIncarnation | null;
}

interface LockGeneration {
  path: string;
  token: string;
  ticket: number | null;
}

type ProcessIncarnationProbe =
  | { status: 'alive'; incarnation: LinuxProcessIncarnation }
  | { status: 'dead' }
  | { status: 'unsupported'; reason: string };

function errno(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : null;
}

function probeProcessLiveness(pid: number): 'alive' | 'dead' | 'unverifiable' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    if (errno(error) === 'ESRCH') return 'dead';
    if (errno(error) === 'EPERM') return 'alive';
    return 'unverifiable';
  }
}

function linuxStartTimeTicks(rawStat: string): string | null {
  const commandEnd = rawStat.lastIndexOf(')');
  if (commandEnd < 0) return null;
  const fields = rawStat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/);
  const startTimeTicks = fields[19];
  return startTimeTicks && /^\d+$/.test(startTimeTicks) ? startTimeTicks : null;
}

async function probeProcessIncarnation(pid: number): Promise<ProcessIncarnationProbe> {
  if (process.platform !== 'linux') {
    return {
      status: 'unsupported',
      reason: `platform '${process.platform}' does not expose Linux boot and process start identities`,
    };
  }

  let bootId: string;
  try {
    bootId = (await readFile(LINUX_BOOT_ID_PATH, 'utf8')).trim().toLowerCase();
  } catch (error) {
    return {
      status: 'unsupported',
      reason: `Linux boot identity is unavailable (${errno(error) ?? 'unknown error'})`,
    };
  }
  if (!LINUX_BOOT_ID_PATTERN.test(bootId)) {
    return { status: 'unsupported', reason: 'Linux boot identity has an unsupported format' };
  }

  let rawStat: string;
  try {
    rawStat = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    if (errno(error) === 'ENOENT' || errno(error) === 'ESRCH') return { status: 'dead' };
    return {
      status: 'unsupported',
      reason: `process start identity for pid ${pid} is unavailable (${errno(error) ?? 'unknown error'})`,
    };
  }
  const startTimeTicks = linuxStartTimeTicks(rawStat);
  if (startTimeTicks === null) {
    return { status: 'unsupported', reason: `process start identity for pid ${pid} is malformed` };
  }
  return {
    status: 'alive',
    incarnation: { kind: 'linux-proc', bootId, startTimeTicks },
  };
}

function parseLockOwner(raw: string): LockOwner | null {
  try {
    const value = JSON.parse(raw) as Partial<LockOwner>;
    if (
      typeof value.token !== 'string' ||
      !new RegExp(`^${LOCK_TOKEN_PATTERN}$`).test(value.token) ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.hostname !== 'string' ||
      value.hostname.length === 0 ||
      typeof value.acquiredAt !== 'string' ||
      !exactIso(value.acquiredAt)
    ) {
      return null;
    }
    const incarnation = value.processIncarnation;
    if (
      incarnation !== null &&
      (incarnation === undefined ||
        incarnation.kind !== 'linux-proc' ||
        typeof incarnation.bootId !== 'string' ||
        !LINUX_BOOT_ID_PATTERN.test(incarnation.bootId) ||
        typeof incarnation.startTimeTicks !== 'string' ||
        !/^\d+$/.test(incarnation.startTimeTicks))
    ) {
      return null;
    }
    return {
      token: value.token,
      pid: value.pid,
      hostname: value.hostname,
      acquiredAt: value.acquiredAt,
      processIncarnation:
        incarnation === null ? null : { ...incarnation, bootId: incarnation.bootId.toLowerCase() },
    } as LockOwner;
  } catch {
    return null;
  }
}

async function ensureLockNamespace(filename: string): Promise<void> {
  let handle: FileHandle;
  let created = false;
  try {
    handle = await open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | NO_FOLLOW, 0o600);
    created = true;
  } catch (error) {
    if (errno(error) !== 'EEXIST') throw error;
    const pathMetadata = await lstat(filename);
    if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()) {
      throw new Error(`coordinator lock namespace '${filename}' must be a real regular file`);
    }
    handle = await open(filename, constants.O_RDWR | NO_FOLLOW);
    const handleMetadata = await handle.stat();
    if (handleMetadata.dev !== pathMetadata.dev || handleMetadata.ino !== pathMetadata.ino) {
      await handle.close();
      throw new Error(`coordinator lock namespace '${filename}' changed while it was opened`);
    }
  }
  try {
    validateFile(await handle.stat(), filename);
    let marker = await handle.readFile('utf8');
    if (marker !== LOCK_NAMESPACE_MARKER) {
      if (marker.length > 0 && !LOCK_NAMESPACE_MARKER.startsWith(marker)) {
        throw new Error(`coordinator lock namespace '${filename}' has an unsupported format`);
      }
      await handle.write(LOCK_NAMESPACE_MARKER, 0, 'utf8');
      await handle.truncate(Buffer.byteLength(LOCK_NAMESPACE_MARKER));
      await handle.sync();
      marker = LOCK_NAMESPACE_MARKER;
    }
    if (created) await syncDirectory(path.dirname(filename));
  } finally {
    await handle.close();
  }
}

function lockGenerationNames(filename: string, entries: readonly string[]): LockGeneration[] {
  const base = path.basename(filename);
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const choosingPattern = new RegExp(`^${escapedBase}\\.choosing-(${LOCK_TOKEN_PATTERN})$`);
  const ticketPattern = new RegExp(
    `^${escapedBase}\\.ticket-([0-9]{${LOCK_TICKET_DIGITS}})-(${LOCK_TOKEN_PATTERN})$`,
  );
  const generations: LockGeneration[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(`${base}.choosing-`) && !entry.startsWith(`${base}.ticket-`)) continue;
    const choosing = choosingPattern.exec(entry);
    if (choosing) {
      generations.push({ path: path.join(path.dirname(filename), entry), token: choosing[1]!, ticket: null });
      continue;
    }
    const ticket = ticketPattern.exec(entry);
    if (!ticket) throw new Error(`coordinator lock namespace '${filename}' has a malformed generation`);
    const ticketNumber = Number(ticket[1]);
    if (!Number.isSafeInteger(ticketNumber) || ticketNumber < 1) {
      throw new Error(`coordinator lock namespace '${filename}' has an invalid ticket`);
    }
    generations.push({
      path: path.join(path.dirname(filename), entry),
      token: ticket[2]!,
      ticket: ticketNumber,
    });
  }
  return generations;
}

async function listLockGenerations(filename: string): Promise<LockGeneration[]> {
  return lockGenerationNames(filename, await readdir(path.dirname(filename)));
}

async function generationBlocks(generation: LockGeneration, staleLockMs: number): Promise<boolean> {
  let metadata: Stats;
  try {
    metadata = await lstat(generation.path);
  } catch (error) {
    if (errno(error) === 'ENOENT') return false;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`coordinator lock generation '${generation.path}' must be a real regular file`);
  }
  validateFile(metadata, generation.path);

  let owner: LockOwner | null;
  try {
    owner = parseLockOwner(await readFile(generation.path, 'utf8'));
  } catch (error) {
    if (errno(error) === 'ENOENT') return false;
    throw error;
  }
  if (owner?.token === generation.token) {
    const hostname = os.hostname();
    if (owner.hostname !== hostname) {
      throw new Error(
        `coordinator lock generation '${generation.path}' belongs to foreign host '${owner.hostname}'; local authority is single-host '${hostname}'`,
      );
    }
    if (owner.processIncarnation === null) {
      const probe = await probeProcessIncarnation(owner.pid);
      if (probe.status === 'alive') {
        throw new Error(
          `coordinator lock generation '${generation.path}' has no verifiable process incarnation; its live pid may have been reused`,
        );
      }
      if (probe.status === 'unsupported') {
        const liveness = probeProcessLiveness(owner.pid);
        if (liveness === 'alive') return true;
        if (liveness === 'unverifiable') {
          throw new Error(
            `coordinator lock generation '${generation.path}' cannot be recovered safely: ${probe.reason}`,
          );
        }
      }
    } else {
      const probe = await probeProcessIncarnation(owner.pid);
      if (probe.status === 'unsupported') {
        throw new Error(
          `coordinator lock generation '${generation.path}' cannot be recovered safely: ${probe.reason}`,
        );
      }
      if (
        probe.status === 'alive' &&
        probe.incarnation.bootId === owner.processIncarnation.bootId &&
        probe.incarnation.startTimeTicks === owner.processIncarnation.startTimeTicks
      ) {
        return true;
      }
    }
  } else if (Date.now() - metadata.mtimeMs <= staleLockMs) {
    // The choosing path is visible before its owner record is complete. It remains a contender
    // until the bounded stale window expires; its token-unique pathname is then safe to retire.
    return true;
  }

  try {
    await unlink(generation.path);
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error;
  }
  return false;
}

async function releaseLockGeneration(generation: LockGeneration): Promise<void> {
  let owner: LockOwner | null;
  try {
    owner = parseLockOwner(await readFile(generation.path, 'utf8'));
  } catch (error) {
    if (errno(error) === 'ENOENT') return;
    throw error;
  }
  if (owner?.token !== generation.token) {
    throw new Error(`coordinator lock generation '${generation.path}' is not owned by this lease`);
  }
  try {
    await unlink(generation.path);
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error;
  }
}

async function acquireFileLock(
  filename: string,
  timeoutMs: number,
  pollMs: number,
  staleLockMs: number,
): Promise<HeldFileLock> {
  await ensureLockNamespace(filename);
  const token = randomUUID();
  const startedAt = Date.now();
  const incarnationProbe = await probeProcessIncarnation(process.pid);
  if (incarnationProbe.status === 'dead') {
    throw new Error(`coordinator lock '${filename}' lost the current process during identity capture`);
  }
  const owner: LockOwner = {
    token,
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
    processIncarnation: incarnationProbe.status === 'alive' ? incarnationProbe.incarnation : null,
  };
  const choosing: LockGeneration = {
    path: `${filename}.choosing-${token}`,
    token,
    ticket: null,
  };
  let ticketGeneration: LockGeneration | null = null;
  let choosingCreated = false;
  try {
    let choosingHandle: FileHandle | null = null;
    try {
      choosingHandle = await open(
        choosing.path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
        0o600,
      );
      choosingCreated = true;
      validateFile(await choosingHandle.stat(), choosing.path);
      await choosingHandle.writeFile(`${canonicalMissionJson(owner)}\n`, 'utf8');
    } finally {
      await choosingHandle?.close();
    }

    const generations = await listLockGenerations(filename);
    let maxTicket = 0;
    for (const generation of generations) {
      if (generation.ticket === null || !(await generationBlocks(generation, staleLockMs))) continue;
      maxTicket = Math.max(maxTicket, generation.ticket);
    }
    if (maxTicket >= Number.MAX_SAFE_INTEGER) {
      throw new Error(`coordinator lock namespace '${filename}' exhausted its safe ticket range`);
    }
    const ticket = maxTicket + 1;
    ticketGeneration = {
      path: `${filename}.ticket-${String(ticket).padStart(LOCK_TICKET_DIGITS, '0')}-${token}`,
      token,
      ticket,
    };
    await rename(choosing.path, ticketGeneration.path);

    for (;;) {
      const choosingSnapshot = await listLockGenerations(filename);
      let blocked = false;
      for (const generation of choosingSnapshot) {
        if (generation.token === token || generation.ticket !== null) continue;
        if (await generationBlocks(generation, staleLockMs)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) {
        const ticketSnapshot = await listLockGenerations(filename);
        for (const generation of ticketSnapshot) {
          if (generation.token === token || generation.ticket === null) continue;
          const precedes =
            generation.ticket < ticket || (generation.ticket === ticket && generation.token < token);
          if (precedes && (await generationBlocks(generation, staleLockMs))) {
            blocked = true;
            break;
          }
        }
      }
      if (!blocked) {
        const acquired = ticketGeneration;
        let releasePromise: Promise<void> | null = null;
        return {
          release: () => {
            releasePromise ??= releaseLockGeneration(acquired);
            return releasePromise;
          },
        };
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutMs) throw new NoriqCoordinatorBusyError(`lock '${filename}' is busy`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, timeoutMs - elapsed)));
    }
  } catch (acquisitionError) {
    const generations = [ticketGeneration, choosingCreated ? choosing : null].filter(
      (generation): generation is LockGeneration => generation !== null,
    );
    const cleanup = await Promise.allSettled(
      generations.map(async (generation) => {
        try {
          await unlink(generation.path);
        } catch (error) {
          if (errno(error) !== 'ENOENT') throw error;
        }
      }),
    );
    const cleanupErrors = cleanup.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [acquisitionError, ...cleanupErrors],
        `coordinator lock acquisition failed and ${cleanupErrors.length} generation cleanup(s) failed`,
      );
    }
    throw acquisitionError;
  }
}

function emptyHistory(rootRunId: string): NoriqCoordinatorHistory {
  return { rootRunId, revision: 0, headHash: null, records: [] };
}

function recordHash(record: NoriqCoordinatorWalRecordWithoutHash): string {
  return sha256(canonicalMissionJson(record));
}

function parseWalLine(rootRunId: string, line: string, index: number): NoriqCoordinatorWalRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new NoriqCoordinatorCorruptionError(rootRunId, index + 1, `invalid JSON: ${String(error)}`);
  }
  const result = NoriqCoordinatorWalRecordSchema.safeParse(parsed);
  if (!result.success) {
    throw new NoriqCoordinatorCorruptionError(rootRunId, index + 1, result.error.message);
  }
  return result.data;
}

function replayWal(rootRunId: string, complete: string): NoriqCoordinatorHistory {
  if (complete.length === 0) return emptyHistory(rootRunId);
  const lines = complete.slice(0, -1).split('\n');
  const records: NoriqCoordinatorWalRecord[] = [];
  let previousHash: string | null = null;
  const actionIds = new Map<string, string>();
  for (const [index, line] of lines.entries()) {
    const record = parseWalLine(rootRunId, line, index);
    if (record.rootRunId !== rootRunId) {
      throw new NoriqCoordinatorCorruptionError(rootRunId, index + 1, 'rootRunId mismatch');
    }
    if (record.revision !== index + 1) {
      throw new NoriqCoordinatorCorruptionError(rootRunId, index + 1, 'revision is not contiguous');
    }
    if (record.previousHash !== previousHash) {
      throw new NoriqCoordinatorCorruptionError(rootRunId, index + 1, 'previousHash mismatch');
    }
    const { hash, ...withoutHash } = record;
    if (hash !== recordHash(withoutHash)) {
      throw new NoriqCoordinatorCorruptionError(rootRunId, index + 1, 'record hash mismatch');
    }
    const fingerprint = sha256(canonicalMissionJson(record.action));
    if (record.actionFingerprint !== fingerprint) {
      throw new NoriqCoordinatorCorruptionError(rootRunId, index + 1, 'action fingerprint mismatch');
    }
    const previousFingerprint = actionIds.get(record.actionId);
    if (previousFingerprint !== undefined) {
      throw new NoriqCoordinatorCorruptionError(rootRunId, index + 1, 'duplicate actionId record');
    }
    actionIds.set(record.actionId, fingerprint);
    records.push(record);
    previousHash = hash;
  }
  return { rootRunId, revision: records.length, headHash: previousHash, records };
}

export interface JsonlNoriqCoordinatorStoreOptions {
  lockTimeoutMs?: number;
  lockPollMs?: number;
  staleLockMs?: number;
  controllerTimeoutMs?: number;
  maxWalBytes?: number;
  maxWalActions?: number;
  now?: () => Date;
}

/** Private, append-only, hash-chained authority log for Noriq-to-local mission coordination. */
export class JsonlNoriqCoordinatorStore {
  readonly directory: string;
  private readonly lockTimeoutMs: number;
  private readonly lockPollMs: number;
  private readonly staleLockMs: number;
  private readonly controllerTimeoutMs: number;
  private readonly maxWalBytes: number;
  private readonly maxWalActions: number;
  private readonly now: () => Date;
  private ready: Promise<string>;

  constructor(directory: string, options: JsonlNoriqCoordinatorStoreOptions = {}) {
    this.directory = path.resolve(directory);
    this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
    this.lockPollMs = options.lockPollMs ?? DEFAULT_LOCK_POLL_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.controllerTimeoutMs = options.controllerTimeoutMs ?? 250;
    this.maxWalBytes = options.maxWalBytes ?? MAX_NORIQ_COORDINATOR_WAL_BYTES;
    this.maxWalActions = options.maxWalActions ?? MAX_NORIQ_COORDINATOR_WAL_ACTIONS;
    this.now = options.now ?? (() => new Date());
    if (!Number.isFinite(this.lockTimeoutMs) || this.lockTimeoutMs <= 0) {
      throw new TypeError('lockTimeoutMs must be positive');
    }
    if (!Number.isFinite(this.lockPollMs) || this.lockPollMs <= 0) {
      throw new TypeError('lockPollMs must be positive');
    }
    if (!Number.isFinite(this.staleLockMs) || this.staleLockMs <= 0) {
      throw new TypeError('staleLockMs must be positive');
    }
    if (!Number.isFinite(this.controllerTimeoutMs) || this.controllerTimeoutMs <= 0) {
      throw new TypeError('controllerTimeoutMs must be positive');
    }
    if (!Number.isSafeInteger(this.maxWalBytes) || this.maxWalBytes < MAX_NORIQ_COORDINATOR_ACTION_BYTES) {
      throw new TypeError(`maxWalBytes must be at least ${MAX_NORIQ_COORDINATOR_ACTION_BYTES}`);
    }
    if (!Number.isSafeInteger(this.maxWalActions) || this.maxWalActions < 1) {
      throw new TypeError('maxWalActions must be a positive safe integer');
    }
    this.ready = ensurePrivateDirectory(this.directory);
  }

  private key(rootRunId: string): string {
    if (typeof rootRunId !== 'string' || rootRunId.length === 0 || rootRunId.length > IDENTIFIER_MAX) {
      throw new TypeError('rootRunId must be a non-empty bounded string');
    }
    return sha256(rootRunId);
  }

  private async paths(rootRunId: string): Promise<{ wal: string; writer: string; controller: string }> {
    const directory = await this.ready;
    const key = this.key(rootRunId);
    return {
      wal: path.join(directory, `${key}.jsonl`),
      writer: path.join(directory, `${key}.write.lock`),
      controller: path.join(directory, `${key}.controller.lock`),
    };
  }

  private async readWalFile<T>(
    wal: string,
    repairTail: boolean,
    inspectComplete: (complete: string, completeBytes: number, totalBytes: number) => T,
  ): Promise<{ value: T; completeBytes: number; totalBytes: number; repairedTail: boolean } | null> {
    let handle: FileHandle | null = null;
    try {
      const pathMetadata = await lstat(wal);
      if (pathMetadata.isSymbolicLink()) throw new Error(`'${wal}' must not be a symbolic link`);
      validateFile(pathMetadata, wal);
      handle = await open(wal, (repairTail ? constants.O_RDWR : constants.O_RDONLY) | NO_FOLLOW);
      const before = await handle.stat();
      validateFile(before, wal);
      if (before.dev !== pathMetadata.dev || before.ino !== pathMetadata.ino) {
        throw new Error(`coordinator WAL '${wal}' changed while it was opened`);
      }
      if (before.size > this.maxWalBytes) throw new Error('coordinator WAL exceeds byte limit');
      const buffer = await handle.readFile();
      const after = await handle.stat();
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
        throw new Error(`coordinator WAL '${wal}' changed while its writer authority was held`);
      }
      const finalNewline = buffer.lastIndexOf(0x0a);
      const completeBytes = finalNewline < 0 ? 0 : finalNewline + 1;
      let complete: string;
      try {
        complete = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, completeBytes));
      } catch {
        throw new NoriqCoordinatorCorruptionError(
          path.basename(wal),
          1,
          'complete records are not valid UTF-8',
        );
      }

      // Validate every complete record before mutating anything. Only bytes after the final JSONL
      // delimiter are an uncommitted crash tail; a corrupt newline-terminated record is authority
      // corruption and must survive for diagnosis.
      const value = inspectComplete(complete, completeBytes, buffer.length);
      const repairedTail = repairTail && completeBytes !== buffer.length;
      if (repairedTail) {
        await handle.truncate(completeBytes);
        await handle.sync();
      }
      return { value, completeBytes, totalBytes: buffer.length, repairedTail };
    } catch (error) {
      if (errno(error) === 'ENOENT') return null;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  private async readCompleteWal(
    rootRunId: string,
    repairTail: boolean,
  ): Promise<{ history: NoriqCoordinatorHistory; completeBytes: number; totalBytes: number }> {
    const { wal } = await this.paths(rootRunId);
    const loaded = await this.readWalFile(wal, repairTail, (complete) => {
      const history = replayWal(rootRunId, complete);
      if (history.records.length > this.maxWalActions) {
        throw new Error('coordinator WAL exceeds action limit');
      }
      return history;
    });
    if (loaded === null) return { history: emptyHistory(rootRunId), completeBytes: 0, totalBytes: 0 };
    return {
      history: loaded.value,
      completeBytes: loaded.completeBytes,
      totalBytes: loaded.totalBytes,
    };
  }

  async load(rootRunId: string): Promise<NoriqCoordinatorHistory> {
    const { writer } = await this.paths(rootRunId);
    const lock = await acquireFileLock(writer, this.lockTimeoutMs, this.lockPollMs, this.staleLockMs);
    try {
      return (await this.readCompleteWal(rootRunId, true)).history;
    } finally {
      await lock.release();
    }
  }

  /**
   * Trusted restart enumeration. Each candidate is writer-locked, validated, and allowed to lose
   * only an unterminated crash suffix before it enters inventory. A corrupt complete record fails
   * the whole inventory rather than being mistaken for an empty/uncommissioned machine.
   */
  async listRootRunIds(): Promise<readonly string[]> {
    const directory = await this.ready;
    const names = (await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort();
    if (names.length > MAX_NORIQ_COORDINATOR_ROOTS) {
      throw new Error(`coordinator root inventory exceeds ${MAX_NORIQ_COORDINATOR_ROOTS} WALs`);
    }
    const rootRunIds: string[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.jsonl$/.test(name)) {
        throw new Error(`unexpected coordinator WAL filename '${name}'`);
      }
      const filename = path.join(directory, name);
      const writer = path.join(directory, `${name.slice(0, -'.jsonl'.length)}.write.lock`);
      const lock = await acquireFileLock(writer, this.lockTimeoutMs, this.lockPollMs, this.staleLockMs);
      try {
        const loaded = await this.readWalFile(filename, true, (complete, completeBytes, totalBytes) => {
          if (completeBytes === 0) {
            if (totalBytes === 0) {
              throw new NoriqCoordinatorCorruptionError(
                name,
                1,
                'empty WAL has no commissioned root identity',
              );
            }
            // A process can die between exclusive file creation and the first newline. With no
            // complete record there is no commissioned authority to inventory; the whole file is
            // an uncommitted tail and can be retired after the writer-locked truncation is synced.
            return null;
          }
          const firstLine = complete.slice(0, complete.indexOf('\n'));
          let rootRunId: string;
          try {
            const first = NoriqCoordinatorWalRecordSchema.parse(JSON.parse(firstLine));
            rootRunId = first.rootRunId;
          } catch (error) {
            throw new NoriqCoordinatorCorruptionError(name, 1, `invalid first record: ${String(error)}`);
          }
          if (`${this.key(rootRunId)}.jsonl` !== name) {
            throw new NoriqCoordinatorCorruptionError(rootRunId, 1, 'WAL filename does not match rootRunId');
          }
          const history = replayWal(rootRunId, complete);
          if (history.records.length > this.maxWalActions) {
            throw new Error(`coordinator WAL '${rootRunId}' exceeds action limit`);
          }
          if (history.records[0]?.action.type !== 'commissioned') {
            throw new NoriqCoordinatorCorruptionError(rootRunId, 1, 'first WAL action is not a commission');
          }
          return rootRunId;
        });
        if (loaded === null) continue;
        if (loaded.value === null) {
          await unlink(filename);
          await syncDirectory(directory);
          continue;
        }
        const rootRunId = loaded.value;
        if (seen.has(rootRunId)) {
          throw new NoriqCoordinatorCorruptionError(rootRunId, 1, 'duplicate root WAL identity');
        }
        seen.add(rootRunId);
        rootRunIds.push(rootRunId);
      } finally {
        await lock.release();
      }
    }
    return Object.freeze(rootRunIds);
  }

  async append(
    rootRunId: string,
    expectedRevision: number,
    actionId: string,
    input: NoriqCoordinatorAction,
  ): Promise<NoriqCoordinatorAppendResult> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError('expectedRevision must be a non-negative safe integer');
    }
    if (typeof actionId !== 'string' || actionId.length === 0 || actionId.length > IDENTIFIER_MAX) {
      throw new TypeError('actionId must be a non-empty bounded string');
    }
    const action = NoriqCoordinatorActionSchema.parse(input);
    const actionCanonical = canonicalMissionJson(action);
    if (Buffer.byteLength(actionCanonical, 'utf8') > MAX_NORIQ_COORDINATOR_ACTION_BYTES) {
      throw new TypeError(`coordinator action exceeds ${MAX_NORIQ_COORDINATOR_ACTION_BYTES} bytes`);
    }
    const actionFingerprint = sha256(actionCanonical);
    const paths = await this.paths(rootRunId);
    const lock = await acquireFileLock(paths.writer, this.lockTimeoutMs, this.lockPollMs, this.staleLockMs);
    try {
      const loaded = await this.readCompleteWal(rootRunId, true);
      const duplicate = loaded.history.records.find((record) => record.actionId === actionId);
      if (duplicate) {
        if (duplicate.actionFingerprint !== actionFingerprint) {
          throw new NoriqCoordinatorConflictError(
            'action',
            `actionId '${actionId}' conflicts with its durable fingerprint`,
          );
        }
        return { history: loaded.history, replayed: true };
      }
      if (loaded.history.revision !== expectedRevision) {
        throw new NoriqCoordinatorConflictError(
          'revision',
          `expected coordinator revision ${expectedRevision}, found ${loaded.history.revision}`,
        );
      }
      if (loaded.history.revision >= this.maxWalActions) {
        throw new Error('coordinator WAL action capacity exhausted');
      }
      const withoutHash: NoriqCoordinatorWalRecordWithoutHash = {
        schemaVersion: NORIQ_COORDINATOR_WAL_SCHEMA_VERSION,
        rootRunId,
        revision: loaded.history.revision + 1,
        actionId,
        actionFingerprint,
        recordedAt: this.now().toISOString(),
        previousHash: loaded.history.headHash,
        action,
      };
      const record: NoriqCoordinatorWalRecord = {
        ...withoutHash,
        hash: recordHash(withoutHash),
      };
      const line = `${canonicalMissionJson(record)}\n`;
      if (loaded.completeBytes + Buffer.byteLength(line, 'utf8') > this.maxWalBytes) {
        throw new Error('coordinator WAL byte capacity exhausted');
      }
      const handle = await open(
        paths.wal,
        constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | NO_FOLLOW,
        0o600,
      );
      try {
        const metadata = await handle.stat();
        validateFile(metadata, paths.wal);
        await handle.writeFile(line, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (loaded.history.revision === 0) await syncDirectory(path.dirname(paths.wal));
      const history: NoriqCoordinatorHistory = {
        rootRunId,
        revision: record.revision,
        headHash: record.hash,
        records: [...loaded.history.records, record],
      };
      return { history, replayed: false };
    } finally {
      await lock.release();
    }
  }

  async acquireController(rootRunId: string): Promise<NoriqCoordinatorControllerLease> {
    const { controller } = await this.paths(rootRunId);
    const lock = await acquireFileLock(
      controller,
      this.controllerTimeoutMs,
      this.lockPollMs,
      this.staleLockMs,
    );
    return { release: lock.release };
  }

  /** Test/diagnostic only: verifies the configured state path remains a private directory. */
  async verifyPrivateState(): Promise<void> {
    const directory = await this.ready;
    const metadata = await stat(directory);
    if (!metadata.isDirectory()) throw new Error(`'${directory}' is not a directory`);
    if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
      throw new Error(`'${directory}' is not private`);
    }
  }
}

export type {
  CommissionedExecutionProfile,
  MissionAcceptedRevisionHandoffState,
  MissionBudget,
  MissionLeaseRef,
  MissionTaskAck,
  MissionTaskBeginReport,
  MissionTaskSettleReport,
  MissionUsage,
};
