import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { requiredMissionSettlementActions } from './journal-reserve';
import type { MissionActionEnvelope, MissionCommitReceipt, MissionEvent } from './protocol';
import { reduceMission, reduceMissionFrom } from './reducer';
import {
  DEFAULT_MAX_MISSION_JOURNAL_ACTIONS,
  DEFAULT_MAX_MISSION_JOURNAL_BYTES,
  MAX_MISSION_ACTION_BYTES,
  MAX_MISSION_EVENT_BATCH_BYTES,
  type MissionCommitDeltaResult,
  type MissionCommitResult,
  MissionControllerBusyError,
  type MissionControllerLease,
  type MissionHistory,
  type MissionHistoryDelta,
  MissionJournalCorruptionError,
  MissionJournalLimitError,
  type MissionStore,
  type MissionStoreEnumerationEntry,
  MissionStoreLockTimeoutError,
  admitMissionActionAtHead,
  canonicalMissionJson,
  cloneMissionReceipt,
  createStoredMissionAction,
  emptyMissionHistory,
  missionHistoryDelta,
  normalizeMissionActionEnvelope,
  replayMissionJournal,
  validateMissionId,
} from './store';

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_POLL_MS = 10;
const DEFAULT_STALE_LOCK_MS = 5 * 60_000;
const DEFAULT_CONTROLLER_TIMEOUT_MS = 250;
// Worst-case bounded terminalization includes child cancellation/settlement, a checkpoint plus
// reconciliation for every write child, terminal authority, and failed-then-completed cleanup.
const DEFAULT_EMERGENCY_RESERVE_BYTES = 64 * 1024 * 1024;
const DEFAULT_EMERGENCY_RESERVE_ACTIONS = 1_536;
const MIN_ORDINARY_JOURNAL_BYTES = MAX_MISSION_ACTION_BYTES + MAX_MISSION_EVENT_BATCH_BYTES + 256 * 1024;
const EMERGENCY_ACTIONS = new Set<MissionActionEnvelope['action']['type']>([
  'complete-guide-turn',
  'apply-guide-proposal',
  'replace-guide',
  'start-child',
  'request-child-cancel',
  'complete-child',
  'record-checkpoint',
  'record-workspace-reconciled',
  'record-review',
  'record-validation',
  'answer-question',
  'complete-mission',
  'complete-cleanup',
  'fail-cleanup',
  'record-accepted-revision-handoff',
]);

export interface JsonlMissionStoreOptions {
  now?: () => Date;
  lockTimeoutMs?: number;
  lockPollMs?: number;
  staleLockMs?: number;
  controllerTimeoutMs?: number;
  /** Hard stop pending an explicit compaction/archive operation. */
  maxJournalBytes?: number;
  /** Hard stop pending an explicit compaction/archive operation. */
  maxJournalActions?: number;
  /** Capacity held back from ordinary work for cancellation, terminal facts, and cleanup. */
  emergencyReserveBytes?: number;
  /** Action slots held back from ordinary work for cancellation, terminal facts, and cleanup. */
  emergencyReserveActions?: number;
  /** @internal Deterministic fault-injection seam for lock-generation rename tests. */
  renameLockGeneration?: (source: string, destination: string) => Promise<void>;
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

interface LoadedJournal {
  history: MissionHistory;
  /** Bytes through the last newline. Everything after this is an unacknowledged crash tail. */
  completeBytes: number;
  totalBytes: number;
}

interface CachedJournal extends LoadedJournal {
  identity: string;
  receipts: Map<string, MissionCommitReceipt>;
  durable: boolean;
}

function errno(err: unknown): string | null {
  return typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string'
    ? err.code
    : null;
}

function positiveFinite(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) throw new TypeError(`${name} must be positive`);
  return resolved;
}

function positiveSafeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function nonNegativeSafeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return resolved;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const LOCK_NAMESPACE_MARKER = 'noriq-mission-bakery-lock-v1\n';
const LOCK_TOKEN_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const LOCK_TICKET_DIGITS = 16;
const LINUX_BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
const LINUX_BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ProcessIncarnationProbe =
  | { status: 'alive'; incarnation: LinuxProcessIncarnation }
  | { status: 'dead' }
  | { status: 'unsupported'; reason: string };

function assertPrivateFileMetadata(metadata: Stats, filename: string): void {
  if (!metadata.isFile()) throw new Error(`mission journal '${filename}' is not a regular file`);
  if (metadata.nlink !== 1) {
    throw new Error(`mission journal '${filename}' must have exactly one filesystem link`);
  }
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      throw new Error(`mission journal '${filename}' is not owned by the Runner user`);
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error(`mission journal '${filename}' grants group or other permissions`);
    }
  }
}

const fileIdentity = (metadata: Stats): string =>
  `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;

async function openExistingJournal(filename: string, flags: number): Promise<FileHandle> {
  const pathMetadata = await lstat(filename);
  if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()) {
    throw new Error(`mission journal '${path.basename(filename)}' must be a real regular file`);
  }
  const handle = await open(filename, flags | NO_FOLLOW);
  try {
    const handleMetadata = await handle.stat();
    assertPrivateFileMetadata(handleMetadata, path.basename(filename));
    if (handleMetadata.dev !== pathMetadata.dev || handleMetadata.ino !== pathMetadata.ino) {
      throw new Error(`mission journal '${path.basename(filename)}' changed while it was opened`);
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function openOrCreateJournal(filename: string): Promise<FileHandle> {
  try {
    return await openExistingJournal(filename, constants.O_RDWR | constants.O_APPEND);
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error;
  }
  try {
    const handle = await open(
      filename,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_APPEND | NO_FOLLOW,
      0o600,
    );
    try {
      assertPrivateFileMetadata(await handle.stat(), path.basename(filename));
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    // Another process may have created the regular file after our ENOENT observation.
    if (errno(error) !== 'EEXIST') throw error;
    return openExistingJournal(filename, constants.O_RDWR | constants.O_APPEND);
  }
}

const MAX_FIRST_JOURNAL_LINE_BYTES = MAX_MISSION_ACTION_BYTES + MAX_MISSION_EVENT_BATCH_BYTES + 256 * 1024;

async function readFirstCompleteLine(filename: string): Promise<string | null> {
  const handle = await openExistingJournal(filename, constants.O_RDONLY);
  const chunks: Buffer[] = [];
  let position = 0;
  try {
    for (;;) {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) return null;
      const content = buffer.subarray(0, bytesRead);
      const newline = content.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(Buffer.from(content.subarray(0, newline)));
        return Buffer.concat(chunks).toString('utf8');
      }
      chunks.push(Buffer.from(content));
      position += bytesRead;
      if (position > MAX_FIRST_JOURNAL_LINE_BYTES) {
        throw new Error(`mission journal '${path.basename(filename)}' has an oversized first record`);
      }
    }
  } finally {
    await handle.close();
  }
}

/** The raw mission id never enters a path. The full digest also avoids truncation collisions. */
export function missionJournalFilename(missionId: string): string {
  validateMissionId(missionId);
  const digest = createHash('sha256').update(missionId, 'utf8').digest('hex');
  return `mission-${digest}.jsonl`;
}

function parseOwner(raw: string): LockOwner | null {
  try {
    const value = JSON.parse(raw) as Partial<LockOwner>;
    if (
      typeof value.token !== 'string' ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.hostname !== 'string' ||
      typeof value.acquiredAt !== 'string'
    ) {
      return null;
    }
    const processIncarnation = value.processIncarnation;
    if (
      processIncarnation !== undefined &&
      processIncarnation !== null &&
      (processIncarnation.kind !== 'linux-proc' ||
        typeof processIncarnation.bootId !== 'string' ||
        !LINUX_BOOT_ID_PATTERN.test(processIncarnation.bootId) ||
        typeof processIncarnation.startTimeTicks !== 'string' ||
        !/^\d+$/.test(processIncarnation.startTimeTicks))
    ) {
      return null;
    }
    return {
      token: value.token,
      pid: value.pid,
      hostname: value.hostname,
      acquiredAt: value.acquiredAt,
      // Owners written before process-incarnation fencing are readable for release, but cannot be
      // automatically reaped: a live pid may be an unrelated process that reused the number.
      processIncarnation:
        processIncarnation === undefined || processIncarnation === null
          ? null
          : { ...processIncarnation, bootId: processIncarnation.bootId.toLowerCase() },
    } as LockOwner;
  } catch {
    return null;
  }
}

function linuxStartTimeTicks(rawStat: string): string | null {
  // comm (field 2) is parenthesized and may itself contain spaces or ')' characters. The final ')'
  // is the only reliable boundary before state (field 3). starttime is field 22, hence index 19 in
  // the suffix beginning at field 3.
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

/** Portable fallback used only where the host cannot attest a process start identity. */
function probeProcessLiveness(pid: number): 'alive' | 'dead' | 'unverifiable' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    if (errno(error) === 'ESRCH') return 'dead';
    // EPERM still proves a process owns the pid; unknown platform errors cannot safely reap it.
    if (errno(error) === 'EPERM') return 'alive';
    return 'unverifiable';
  }
}

/**
 * Append-only, per-mission JSONL authority. Writers use a filesystem bakery election whose
 * generation paths are never reused. Every writer replays the journal while holding the elected
 * lease, making expectedRevision a cross-process CAS rather than an in-memory guess.
 */
export class JsonlMissionStore implements MissionStore {
  private readonly now: () => Date;
  private readonly lockTimeoutMs: number;
  private readonly lockPollMs: number;
  private readonly staleLockMs: number;
  private readonly controllerTimeoutMs: number;
  private readonly maxJournalBytes: number;
  private readonly maxJournalActions: number;
  private readonly emergencyReserveBytes: number;
  private readonly emergencyReserveActions: number;
  private readonly renameLockGeneration: (source: string, destination: string) => Promise<void>;
  private readonly cache = new Map<string, CachedJournal>();

  constructor(
    private readonly directory: string,
    options: JsonlMissionStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.lockTimeoutMs = positiveFinite(options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS, 'lockTimeoutMs');
    this.lockPollMs = positiveFinite(options.lockPollMs, DEFAULT_LOCK_POLL_MS, 'lockPollMs');
    this.staleLockMs = positiveFinite(options.staleLockMs, DEFAULT_STALE_LOCK_MS, 'staleLockMs');
    this.controllerTimeoutMs = positiveFinite(
      options.controllerTimeoutMs,
      DEFAULT_CONTROLLER_TIMEOUT_MS,
      'controllerTimeoutMs',
    );
    this.maxJournalBytes = positiveSafeInteger(
      options.maxJournalBytes,
      DEFAULT_MAX_MISSION_JOURNAL_BYTES,
      'maxJournalBytes',
    );
    this.maxJournalActions = positiveSafeInteger(
      options.maxJournalActions,
      DEFAULT_MAX_MISSION_JOURNAL_ACTIONS,
      'maxJournalActions',
    );
    this.emergencyReserveBytes = Math.min(
      nonNegativeSafeInteger(
        options.emergencyReserveBytes,
        DEFAULT_EMERGENCY_RESERVE_BYTES,
        'emergencyReserveBytes',
      ),
      Math.max(0, this.maxJournalBytes - 1),
    );
    if (this.maxJournalBytes - this.emergencyReserveBytes < MIN_ORDINARY_JOURNAL_BYTES) {
      throw new TypeError(
        `maxJournalBytes minus emergencyReserveBytes must leave at least ${MIN_ORDINARY_JOURNAL_BYTES} bytes for one ordinary action`,
      );
    }
    this.emergencyReserveActions = Math.min(
      nonNegativeSafeInteger(
        options.emergencyReserveActions,
        DEFAULT_EMERGENCY_RESERVE_ACTIONS,
        'emergencyReserveActions',
      ),
      Math.max(0, this.maxJournalActions - 1),
    );
    if (this.maxJournalActions - this.emergencyReserveActions < 1) {
      throw new TypeError(
        'maxJournalActions minus emergencyReserveActions must leave at least one ordinary action slot',
      );
    }
    this.renameLockGeneration = options.renameLockGeneration ?? rename;
  }

  private paths(missionId: string): {
    journal: string;
    lock: string;
    controller: string;
  } {
    const filename = missionJournalFilename(missionId);
    const lock = path.join(this.directory, `${filename}.lock`);
    const controller = path.join(this.directory, `${filename}.controller`);
    return {
      journal: path.join(this.directory, filename),
      lock,
      controller,
    };
  }

  private async ensurePrivateDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`mission journal directory '${this.directory}' must be a real directory`);
    }
    if (process.platform !== 'win32') {
      if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
        throw new Error(`mission journal directory '${this.directory}' is not owned by the Runner user`);
      }
      if ((metadata.mode & 0o077) !== 0) {
        throw new Error(`mission journal directory '${this.directory}' must have mode 0700`);
      }
    }
    // Resolve now so a disappearing or broken ancestor link fails before any authority file opens.
    await realpath(this.directory);
  }

  /**
   * Initialize a permanent namespace marker. Unlike the old lock directory, this path is never
   * retired or reused, so it cannot suffer a pathname replacement race.
   */
  private async ensureLockNamespace(lockPath: string): Promise<void> {
    let handle: FileHandle;
    let created = false;
    try {
      handle = await open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | NO_FOLLOW,
        0o600,
      );
      created = true;
    } catch (error) {
      if (errno(error) !== 'EEXIST') throw error;
      const pathMetadata = await lstat(lockPath);
      if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()) {
        throw new Error(`mission lock namespace '${lockPath}' is not a real regular file`);
      }
      handle = await open(lockPath, constants.O_RDWR | NO_FOLLOW);
      const handleMetadata = await handle.stat();
      if (handleMetadata.dev !== pathMetadata.dev || handleMetadata.ino !== pathMetadata.ino) {
        await handle.close();
        throw new Error(`mission lock namespace '${lockPath}' changed while it was opened`);
      }
    }
    try {
      const metadata = await handle.stat();
      assertPrivateFileMetadata(metadata, path.basename(lockPath));
      let marker = await handle.readFile('utf8');
      if (marker !== LOCK_NAMESPACE_MARKER) {
        // A second process can open the marker after O_EXCL succeeds but before the creator's
        // first write. Repair only that recognizable initialization window; fail closed on any
        // other content rather than treating an old or corrupt lock as this protocol.
        if (marker.length > 0 && !LOCK_NAMESPACE_MARKER.startsWith(marker)) {
          throw new Error(`mission lock namespace '${lockPath}' has an unsupported format`);
        }
        await handle.write(LOCK_NAMESPACE_MARKER, 0, 'utf8');
        await handle.truncate(Buffer.byteLength(LOCK_NAMESPACE_MARKER));
        await handle.sync();
        marker = LOCK_NAMESPACE_MARKER;
      }
      if (created) {
        await handle.sync();
        await this.syncDirectory();
      }
    } finally {
      await handle.close();
    }
  }

  private lockGenerationNames(lockPath: string, entries: readonly string[]): LockGeneration[] {
    const base = path.basename(lockPath);
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
        generations.push({ path: path.join(this.directory, entry), token: choosing[1]!, ticket: null });
        continue;
      }
      const ticket = ticketPattern.exec(entry);
      if (!ticket) throw new Error(`mission lock namespace '${lockPath}' has a malformed generation`);
      const ticketNumber = Number(ticket[1]);
      if (!Number.isSafeInteger(ticketNumber) || ticketNumber < 1) {
        throw new Error(`mission lock namespace '${lockPath}' has an invalid ticket`);
      }
      generations.push({
        path: path.join(this.directory, entry),
        token: ticket[2]!,
        ticket: ticketNumber,
      });
    }
    return generations;
  }

  private async listLockGenerations(lockPath: string): Promise<LockGeneration[]> {
    return this.lockGenerationNames(lockPath, await readdir(this.directory));
  }

  /**
   * Return whether a generation still participates in the election. A generation pathname embeds
   * a random token and is never reused, so unlink can only remove that observed generation and can
   * never retire a successor installed at a shared pathname.
   */
  private async generationBlocks(generation: LockGeneration): Promise<boolean> {
    let metadata: Stats;
    try {
      metadata = await lstat(generation.path);
    } catch (error) {
      if (errno(error) === 'ENOENT') return false;
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`mission lock generation '${generation.path}' is not a real regular file`);
    }
    assertPrivateFileMetadata(metadata, path.basename(generation.path));
    let owner: LockOwner | null = null;
    try {
      owner = parseOwner(await readFile(generation.path, 'utf8'));
    } catch (error) {
      if (errno(error) === 'ENOENT') return false;
      throw error;
    }
    if (owner?.token === generation.token) {
      const localHostname = os.hostname();
      if (owner.hostname !== localHostname) {
        throw new Error(
          `mission lock generation '${generation.path}' belongs to foreign host '${owner.hostname}'; the JSONL authority is single-host (local host '${localHostname}') unless a distributed lease and fencing authority is provided`,
        );
      }
      if (owner.processIncarnation === null) {
        const probe = await probeProcessIncarnation(owner.pid);
        if (probe.status === 'alive') {
          throw new Error(
            `mission lock generation '${generation.path}' has no verifiable process incarnation; automatic recovery is unsafe because its pid may have been reused`,
          );
        }
        if (probe.status === 'unsupported') {
          const liveness = probeProcessLiveness(owner.pid);
          if (liveness === 'alive') return true;
          if (liveness === 'unverifiable') {
            throw new Error(
              `mission lock generation '${generation.path}' cannot be recovered safely: ${probe.reason}; pid liveness is also unverifiable`,
            );
          }
        }
      } else {
        const probe = await probeProcessIncarnation(owner.pid);
        if (probe.status === 'unsupported') {
          throw new Error(
            `mission lock generation '${generation.path}' cannot be recovered safely: ${probe.reason}`,
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
    } else if (Date.now() - metadata.mtimeMs <= this.staleLockMs) {
      // writeFile exposes the choosing pathname before its bytes are complete. A recent malformed
      // owner is therefore a live doorway participant, never permission to enter the lock.
      return true;
    }
    try {
      await unlink(generation.path);
    } catch (error) {
      if (errno(error) !== 'ENOENT') throw error;
    }
    return false;
  }

  private async cleanFailedGenerationAttempt(
    choosing: LockGeneration,
    choosingCreated: boolean,
    ticketGeneration: LockGeneration | null,
    acquisitionError: unknown,
  ): Promise<never> {
    const generations = [ticketGeneration, choosingCreated ? choosing : null].filter(
      (generation): generation is LockGeneration => generation !== null,
    );
    const cleanup = await Promise.allSettled(
      generations.map(async (generation) => {
        try {
          // O_EXCL proved this token-unique generation pathname belonged to this attempt. Remove
          // it directly so cleanup also works after a partial owner write or a rename that took
          // effect but still reported an error.
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
        `mission lock acquisition failed and ${cleanupErrors.length} contender generation cleanup(s) failed`,
      );
    }
    throw acquisitionError;
  }

  private async releaseGeneration(generation: LockGeneration): Promise<void> {
    let owner: LockOwner | null;
    try {
      owner = parseOwner(await readFile(generation.path, 'utf8'));
    } catch (error) {
      if (errno(error) === 'ENOENT') return;
      throw error;
    }
    if (owner?.token !== generation.token) {
      throw new Error(`mission lock generation '${generation.path}' is not owned by this lease`);
    }
    try {
      await unlink(generation.path);
    } catch (error) {
      if (errno(error) !== 'ENOENT') throw error;
    }
  }

  private async acquireElectionLock(
    lock: string,
    timeoutMs: number,
    onTimeout: () => Error,
  ): Promise<() => Promise<void>> {
    await this.ensurePrivateDirectory();
    await this.ensureLockNamespace(lock);
    const startedAt = Date.now();
    const token = randomUUID();
    const incarnationProbe = await probeProcessIncarnation(process.pid);
    if (incarnationProbe.status === 'dead') {
      throw new Error(
        `mission lock '${lock}' cannot acquire a safely recoverable generation: the current Runner process disappeared during identity capture`,
      );
    }
    const owner: LockOwner = {
      token,
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: new Date().toISOString(),
      // Linux supplies boot plus process-start fencing. Other supported Runner platforms retain
      // safe mutual exclusion and dead-owner recovery via pid liveness; a rare pid-reuse collision
      // fails closed until an operator removes the stale private marker.
      processIncarnation: incarnationProbe.status === 'alive' ? incarnationProbe.incarnation : null,
    };
    const choosing: LockGeneration = {
      path: `${lock}.choosing-${token}`,
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
        assertPrivateFileMetadata(await choosingHandle.stat(), path.basename(choosing.path));
        await choosingHandle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
      } finally {
        await choosingHandle?.close();
      }
      const generations = await this.listLockGenerations(lock);
      let maxTicket = 0;
      for (const generation of generations) {
        if (generation.ticket === null || !(await this.generationBlocks(generation))) continue;
        maxTicket = Math.max(maxTicket, generation.ticket);
      }
      if (maxTicket >= Number.MAX_SAFE_INTEGER) {
        throw new Error(`mission lock namespace '${lock}' exhausted its safe ticket range`);
      }
      const ticket = maxTicket + 1;
      ticketGeneration = {
        path: `${lock}.ticket-${String(ticket).padStart(LOCK_TICKET_DIGITS, '0')}-${token}`,
        token,
        ticket,
      };
      await this.renameLockGeneration(choosing.path, ticketGeneration.path);

      for (;;) {
        const choosingSnapshot = await this.listLockGenerations(lock);
        let blocked = false;
        // A chooser that entered the doorway before this ticket was published may choose the same
        // ticket. Wait for it to publish so the stable (ticket, token) ordering can decide.
        for (const generation of choosingSnapshot) {
          if (generation.token === token || generation.ticket !== null) continue;
          if (await this.generationBlocks(generation)) {
            blocked = true;
            break;
          }
        }
        if (!blocked) {
          // A chooser from the first snapshot may have atomically renamed itself to a ticket while
          // we inspected its old pathname. Rescan here; using the stale snapshot would omit that
          // equal-ticket contender and violate the bakery ordering.
          const ticketSnapshot = await this.listLockGenerations(lock);
          for (const generation of ticketSnapshot) {
            if (generation.token === token || generation.ticket === null) continue;
            const precedes =
              generation.ticket < ticket || (generation.ticket === ticket && generation.token < token);
            if (precedes && (await this.generationBlocks(generation))) {
              blocked = true;
              break;
            }
          }
        }
        if (!blocked) {
          const acquired = ticketGeneration;
          let releasePromise: Promise<void> | null = null;
          return () => {
            releasePromise ??= this.releaseGeneration(acquired);
            return releasePromise;
          };
        }
        const elapsed = Date.now() - startedAt;
        if (elapsed >= timeoutMs) throw onTimeout();
        await delay(Math.min(this.lockPollMs, timeoutMs - elapsed));
      }
    } catch (error) {
      return this.cleanFailedGenerationAttempt(choosing, choosingCreated, ticketGeneration, error);
    }
  }

  private acquireLock(missionId: string): Promise<() => Promise<void>> {
    const { lock } = this.paths(missionId);
    return this.acquireElectionLock(
      lock,
      this.lockTimeoutMs,
      () => new MissionStoreLockTimeoutError(missionId, this.lockTimeoutMs),
    );
  }

  async acquireController(missionId: string): Promise<MissionControllerLease> {
    validateMissionId(missionId);
    const { controller } = this.paths(missionId);
    const release = await this.acquireElectionLock(
      controller,
      this.controllerTimeoutMs,
      () => new MissionControllerBusyError(missionId, this.controllerTimeoutMs),
    );
    return { release };
  }

  private async loadUnlocked(missionId: string, handle: FileHandle): Promise<CachedJournal> {
    const before = await handle.stat();
    assertPrivateFileMetadata(before, missionJournalFilename(missionId));
    if (before.size > this.maxJournalBytes) {
      throw new MissionJournalLimitError(missionId, 'bytes', before.size, this.maxJournalBytes);
    }
    const identity = fileIdentity(before);
    const cached = this.cache.get(missionId);
    if (cached?.identity === identity) return cached;

    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (fileIdentity(after) !== identity) {
      throw new Error(`mission journal ${missionId} changed while its writer lock was held`);
    }

    const lastNewline = bytes.lastIndexOf(0x0a);
    const completeBytes = lastNewline + 1;
    let completeText: string;
    try {
      completeText = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, completeBytes));
    } catch {
      throw new MissionJournalCorruptionError(missionId, 1, 'complete records are not valid UTF-8');
    }
    const lines = completeBytes === 0 ? [] : completeText.slice(0, -1).split('\n');
    if (lines.length > this.maxJournalActions) {
      throw new MissionJournalLimitError(missionId, 'actions', lines.length, this.maxJournalActions);
    }
    const history = replayMissionJournal(missionId, lines);
    const loaded: CachedJournal = {
      history,
      completeBytes,
      totalBytes: bytes.length,
      identity,
      receipts: new Map(history.actions.map((action) => [action.receipt.actionId, action.receipt])),
      // A newly parsed external head may be a complete line whose writer died before fsync.
      durable: false,
    };
    this.cache.set(missionId, loaded);
    return loaded;
  }

  private async recoverTail(missionId: string, handle: FileHandle, loaded: CachedJournal): Promise<void> {
    if (loaded.totalBytes === loaded.completeBytes) return;
    await handle.truncate(loaded.completeBytes);
    await handle.sync();
    const metadata = await handle.stat();
    this.cache.set(missionId, {
      history: loaded.history,
      completeBytes: loaded.completeBytes,
      totalBytes: loaded.completeBytes,
      identity: fileIdentity(metadata),
      receipts: loaded.receipts,
      durable: true,
    });
  }

  private async syncDirectory(): Promise<void> {
    let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      directoryHandle = await open(this.directory, constants.O_RDONLY);
      await directoryHandle.sync();
    } catch (err) {
      // Windows and a few filesystems do not expose directory fsync. File fsync remains mandatory;
      // only the platform's explicit "unsupported directory handle" errors degrade here.
      if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(errno(err) ?? '')) throw err;
    } finally {
      await directoryHandle?.close();
    }
  }

  async listMissionEntries(): Promise<readonly MissionStoreEnumerationEntry[]> {
    await this.ensurePrivateDirectory();
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch (error) {
      if (errno(error) === 'ENOENT') return [];
      throw error;
    }
    const missions: MissionStoreEnumerationEntry[] = [];
    for (const filename of entries.sort()) {
      if (!/^mission-[a-f0-9]{64}\.jsonl$/.test(filename)) continue;
      const diagnosticId = `journal:${filename}`;
      try {
        const line = await readFirstCompleteLine(path.join(this.directory, filename));
        // Empty or unterminated first writes are unacknowledged crash tails, not durable entries.
        if (line === null) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          throw new Error(`cannot enumerate corrupt mission journal '${filename}'`);
        }
        const missionId = (raw as { receipt?: { missionId?: unknown } })?.receipt?.missionId;
        if (typeof missionId !== 'string' || missionJournalFilename(missionId) !== filename) {
          throw new Error(`mission journal '${filename}' does not match its durable mission id`);
        }
        try {
          replayMissionJournal(missionId, [line]);
        } catch (error) {
          missions.push({ missionId, error: String(error) });
          continue;
        }
        missions.push({ missionId });
      } catch (error) {
        missions.push({ missionId: diagnosticId, error: String(error) });
      }
    }
    return missions;
  }

  async listMissionIds(): Promise<readonly string[]> {
    const entries = await this.listMissionEntries();
    const failed = entries.find((entry) => entry.error !== undefined);
    if (failed) throw new Error(failed.error);
    return entries.map((entry) => entry.missionId);
  }

  /**
   * A process may die after writing one complete, hash-valid line but before its fsync/receipt. A
   * retry is allowed to recover that action as committed, but must first make the recovered bytes
   * and their directory entry durable before returning the original receipt.
   */
  private async syncRecoveredAction(handle: FileHandle): Promise<void> {
    await handle.sync();
    await this.syncDirectory();
  }

  async load(missionId: string): Promise<MissionHistory> {
    const delta = await this.loadSince(missionId, 0);
    return {
      missionId,
      revision: delta.revision,
      headHash: delta.headHash,
      actions: delta.actions,
      events: delta.events,
    };
  }

  async loadSince(missionId: string, afterRevision: number): Promise<MissionHistoryDelta> {
    validateMissionId(missionId);
    const { journal } = this.paths(missionId);
    const release = await this.acquireLock(missionId);
    try {
      let handle: FileHandle;
      try {
        handle = await openExistingJournal(journal, constants.O_RDWR | constants.O_APPEND);
      } catch (error) {
        if (errno(error) === 'ENOENT') {
          this.cache.delete(missionId);
          return missionHistoryDelta(emptyMissionHistory(missionId), afterRevision);
        }
        throw error;
      }
      try {
        const loaded = await this.loadUnlocked(missionId, handle);
        await this.recoverTail(missionId, handle, loaded);
        // A prior writer may have died after appending a complete valid line but before fsync.
        // Reading that fact makes it authoritative, so close the durability window first.
        if (!loaded.durable) {
          await this.syncRecoveredAction(handle);
          loaded.durable = true;
        }
        return missionHistoryDelta(loaded.history, afterRevision);
      } finally {
        await handle.close();
      }
    } finally {
      await release();
    }
  }

  async commit(
    envelope: MissionActionEnvelope,
    events: readonly MissionEvent[],
  ): Promise<MissionCommitReceipt> {
    return (await this.commitAndLoadSince(envelope, events, 0)).receipt;
  }

  async commitAndLoad(
    envelope: MissionActionEnvelope,
    events: readonly MissionEvent[],
  ): Promise<MissionCommitResult> {
    const result = await this.commitAndLoadSince(envelope, events, 0);
    return {
      receipt: result.receipt,
      replayed: result.replayed,
      history: {
        missionId: envelope.missionId,
        revision: result.delta.revision,
        headHash: result.delta.headHash,
        actions: result.delta.actions,
        events: result.delta.events,
      },
    };
  }

  async commitAndLoadSince(
    envelope: MissionActionEnvelope,
    events: readonly MissionEvent[],
    afterRevision: number,
  ): Promise<MissionCommitDeltaResult> {
    const normalized = normalizeMissionActionEnvelope(envelope);
    const admittedEnvelope = normalized.envelope;
    const actionFingerprint = normalized.fingerprint;
    const { journal } = this.paths(admittedEnvelope.missionId);
    const release = await this.acquireLock(admittedEnvelope.missionId);
    try {
      const handle = await openOrCreateJournal(journal);
      try {
        const loaded = await this.loadUnlocked(admittedEnvelope.missionId, handle);
        await this.recoverTail(admittedEnvelope.missionId, handle, loaded);

        if (!loaded.durable) {
          await this.syncRecoveredAction(handle);
          loaded.durable = true;
        }

        // Duplicate admission MUST precede the revision CAS. A caller retrying revision N receives
        // its original receipt even when the mission has since advanced past N + 1.
        const duplicate = admitMissionActionAtHead(
          loaded.history.missionId,
          loaded.history.revision,
          loaded.receipts.get(admittedEnvelope.actionId),
          admittedEnvelope,
          actionFingerprint,
        );
        if (duplicate) {
          return {
            receipt: cloneMissionReceipt(duplicate),
            replayed: true,
            delta: missionHistoryDelta(loaded.history, afterRevision),
          };
        }
        const action = createStoredMissionAction(
          admittedEnvelope,
          events,
          loaded.history.revision + 1,
          loaded.history.headHash,
          this.now().toISOString(),
          actionFingerprint,
        );
        const prospectiveState = reduceMissionFrom(
          reduceMission(loaded.history.missionId, loaded.history.events),
          action.events,
        );
        const settlementLimit = this.maxJournalActions - requiredMissionSettlementActions(prospectiveState);
        const emergency = EMERGENCY_ACTIONS.has(admittedEnvelope.action.type);
        const classLimit = emergency
          ? this.maxJournalActions
          : this.maxJournalActions - this.emergencyReserveActions;
        const actionLimit = Math.min(classLimit, settlementLimit);
        if (loaded.history.actions.length >= actionLimit) {
          throw new MissionJournalLimitError(
            admittedEnvelope.missionId,
            'actions',
            loaded.history.actions.length + 1,
            actionLimit,
          );
        }
        const line = `${canonicalMissionJson(action)}\n`;
        const nextBytes = loaded.completeBytes + Buffer.byteLength(line, 'utf8');
        const byteLimit = emergency
          ? this.maxJournalBytes
          : this.maxJournalBytes - this.emergencyReserveBytes;
        if (nextBytes > byteLimit) {
          throw new MissionJournalLimitError(admittedEnvelope.missionId, 'bytes', nextBytes, byteLimit);
        }
        await handle.writeFile(line, 'utf8');
        // A successful return is the durability boundary. The lock is held through fsync, so a
        // losing process can neither observe nor base its CAS on an unacknowledged record.
        await handle.sync();

        // Always sync the directory before acknowledgement. This is cheap compared with the file
        // fsync already paid per action and closes the recovery case where the prior writer died
        // between its file fsync and its first directory fsync.
        await this.syncDirectory();
        const actions = loaded.history.actions as Array<(typeof loaded.history.actions)[number]>;
        const eventEnvelopes = loaded.history.events as Array<(typeof loaded.history.events)[number]>;
        actions.push(action);
        eventEnvelopes.push(...action.events);
        const history: MissionHistory = {
          missionId: admittedEnvelope.missionId,
          revision: action.receipt.revision,
          headHash: action.hash,
          actions,
          events: eventEnvelopes,
        };
        loaded.receipts.set(action.receipt.actionId, action.receipt);
        const metadata = await handle.stat();
        this.cache.set(admittedEnvelope.missionId, {
          history,
          completeBytes: nextBytes,
          totalBytes: nextBytes,
          identity: fileIdentity(metadata),
          receipts: loaded.receipts,
          durable: true,
        });
        return {
          receipt: cloneMissionReceipt(action.receipt),
          replayed: false,
          delta: missionHistoryDelta(history, afterRevision),
        };
      } finally {
        await handle.close();
      }
    } finally {
      await release();
    }
  }
}

/** Convenience default used by the eventual daemon composition root, not a global singleton. */
export const DEFAULT_MISSION_JOURNAL_DIRECTORY = path.join(os.homedir(), '.noriq', 'missions');
