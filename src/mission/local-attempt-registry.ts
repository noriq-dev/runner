import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  MissionAttemptRecoveryRequest,
  MissionAttemptRegistryClaim,
  MissionAttemptRegistryRecovery,
  MissionAttemptRegistryRequest,
  MissionAttemptSessionRegistry,
} from './driver-runtime';
import type { MissionChildExecution, MissionChildResult } from './harness';
import { JsonlMissionStore } from './jsonl-store';
import { canonicalMissionJson } from './store';

const RECORD_VERSION = 1 as const;
const MAX_RECORD_BYTES = 256 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const SHA256 = /^[a-f0-9]{64}$/;
const OWNER_ID = /^[A-Za-z0-9._:-]{1,512}$/;
const ATTEMPT_ID = /^[A-Za-z0-9._:-]{1,512}$/;

export interface LocalAttemptOwner {
  pid: number;
  hostname: string;
  bootId: string;
  startTimeTicks: string;
}

interface AttemptAuthority {
  missionId: string;
  childId: string;
  attemptId: string;
  authorityFingerprint: string;
  promptRendererVersion: string;
  promptFingerprint: string;
  workspace: string;
  workspaceRevisionId: string;
  workspaceLeaseGeneration: string;
  projectMcpEffectiveFingerprint: string | null;
}

type AttemptRecord = {
  version: typeof RECORD_VERSION;
  authority: AttemptAuthority;
  authorityDigest: string;
  owner: LocalAttemptOwner;
  status: 'reserved' | 'running' | 'terminal' | 'ambiguous';
  updatedAt: string;
  result?: MissionChildResult;
  reason?: string;
};

export interface LocalAttemptSessionRegistryOptions {
  directory: string;
  /**
   * Required explicit safety assertion. The associated commissioned process backend must kill the
   * complete child tree when this Runner process dies. This assertion is necessary but does not
   * replace credential, resource, network, or immutable-runtime commissioning checks.
   */
  processesDieWithOwner: true;
  /** Test seams for deterministic owner-loss recovery. */
  currentOwner?: () => Promise<LocalAttemptOwner>;
  ownerAlive?: (owner: LocalAttemptOwner) => Promise<boolean>;
}

function recordFilename(attemptId: string): string {
  const digest = createHash('sha256').update(attemptId, 'utf8').digest('hex');
  return `attempt-${digest}.json`;
}

function authorityFrom(request: MissionAttemptRegistryRequest): AttemptAuthority {
  return {
    missionId: request.missionId,
    childId: request.childId,
    attemptId: request.attemptId,
    authorityFingerprint: request.authorityFingerprint,
    promptRendererVersion: request.promptRendererVersion,
    promptFingerprint: request.promptFingerprint,
    workspace: request.workspace,
    workspaceRevisionId: request.workspaceRevisionId,
    workspaceLeaseGeneration: request.workspaceLeaseGeneration,
    projectMcpEffectiveFingerprint: request.projectMcpEffectiveFingerprint,
  };
}

function authorityDigest(authority: AttemptAuthority): string {
  return createHash('sha256').update(canonicalMissionJson(authority), 'utf8').digest('hex');
}

function sameDurableAttempt(record: AttemptRecord, request: MissionAttemptRecoveryRequest): boolean {
  return (
    record.authority.missionId === request.missionId &&
    record.authority.childId === request.childId &&
    record.authority.attemptId === request.attemptId
  );
}

function validAuthority(authority: AttemptAuthority, expectedAttemptId: string): boolean {
  return (
    typeof authority.missionId === 'string' &&
    ATTEMPT_ID.test(authority.missionId) &&
    typeof authority.childId === 'string' &&
    ATTEMPT_ID.test(authority.childId) &&
    authority.attemptId === expectedAttemptId &&
    ATTEMPT_ID.test(authority.attemptId) &&
    SHA256.test(authority.authorityFingerprint) &&
    typeof authority.promptRendererVersion === 'string' &&
    OWNER_ID.test(authority.promptRendererVersion) &&
    SHA256.test(authority.promptFingerprint) &&
    typeof authority.workspace === 'string' &&
    path.isAbsolute(authority.workspace) &&
    typeof authority.workspaceRevisionId === 'string' &&
    authority.workspaceRevisionId.length >= 1 &&
    authority.workspaceRevisionId.length <= 512 &&
    typeof authority.workspaceLeaseGeneration === 'string' &&
    authority.workspaceLeaseGeneration.length >= 1 &&
    authority.workspaceLeaseGeneration.length <= 512 &&
    (authority.projectMcpEffectiveFingerprint === null ||
      SHA256.test(authority.projectMcpEffectiveFingerprint))
  );
}

function validUsage(result: MissionChildResult): boolean {
  const { usage } = result;
  return (
    (usage.tokens === null || (Number.isSafeInteger(usage.tokens) && usage.tokens >= 0)) &&
    (usage.usd === null || (Number.isFinite(usage.usd) && usage.usd >= 0)) &&
    (usage.activeSeconds === null || (Number.isFinite(usage.activeSeconds) && usage.activeSeconds >= 0))
  );
}

function parseRecord(raw: string, expectedAttemptId: string): AttemptRecord {
  if (Buffer.byteLength(raw, 'utf8') > MAX_RECORD_BYTES) throw new Error('attempt record is oversized');
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new Error('attempt record is not valid JSON');
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('attempt record root is invalid');
  }
  const record = candidate as Partial<AttemptRecord>;
  if (
    record.version !== RECORD_VERSION ||
    !record.authority ||
    !validAuthority(record.authority, expectedAttemptId) ||
    typeof record.authorityDigest !== 'string' ||
    !SHA256.test(record.authorityDigest) ||
    authorityDigest(record.authority) !== record.authorityDigest ||
    !record.owner ||
    !Number.isSafeInteger(record.owner.pid) ||
    record.owner.pid < 1 ||
    !OWNER_ID.test(record.owner.hostname) ||
    !OWNER_ID.test(record.owner.bootId) ||
    !/^\d+$/.test(record.owner.startTimeTicks) ||
    !['reserved', 'running', 'terminal', 'ambiguous'].includes(record.status ?? '') ||
    typeof record.updatedAt !== 'string'
  ) {
    throw new Error('attempt record fields are invalid');
  }
  if (record.status === 'terminal') {
    if (
      !record.result ||
      !['succeeded', 'failed', 'cancelled', 'lost'].includes(record.result.outcome) ||
      typeof record.result.summary !== 'string' ||
      record.result.summary.length < 1 ||
      record.result.summary.length > 64_000 ||
      !validUsage(record.result)
    ) {
      throw new Error('terminal attempt record has an invalid result');
    }
  } else if (record.result !== undefined) {
    throw new Error('non-terminal attempt record may not carry a result');
  }
  if (record.reason !== undefined && (typeof record.reason !== 'string' || record.reason.length > 16_384)) {
    throw new Error('attempt record reason is invalid');
  }
  return record as AttemptRecord;
}

async function linuxOwner(): Promise<LocalAttemptOwner> {
  if (process.platform !== 'linux') {
    throw new Error('local durable attempt ownership currently requires Linux process incarnation data');
  }
  const [bootId, rawStat] = await Promise.all([
    readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    readFile(`/proc/${process.pid}/stat`, 'utf8'),
  ]);
  const commandEnd = rawStat.lastIndexOf(')');
  const fields =
    commandEnd < 0
      ? []
      : rawStat
          .slice(commandEnd + 1)
          .trim()
          .split(/\s+/);
  const startTimeTicks = fields[19];
  const normalizedBootId = bootId.trim().toLowerCase();
  if (!/^[a-f0-9-]{36}$/.test(normalizedBootId) || !startTimeTicks || !/^\d+$/.test(startTimeTicks)) {
    throw new Error('Linux process incarnation data is malformed');
  }
  return {
    pid: process.pid,
    hostname: os.hostname(),
    bootId: normalizedBootId,
    startTimeTicks,
  };
}

async function linuxOwnerAlive(owner: LocalAttemptOwner): Promise<boolean> {
  if (process.platform !== 'linux' || owner.hostname !== os.hostname()) return false;
  let currentBoot: string;
  let rawStat: string;
  try {
    [currentBoot, rawStat] = await Promise.all([
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      readFile(`/proc/${owner.pid}/stat`, 'utf8'),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const commandEnd = rawStat.lastIndexOf(')');
  const fields =
    commandEnd < 0
      ? []
      : rawStat
          .slice(commandEnd + 1)
          .trim()
          .split(/\s+/);
  return currentBoot.trim().toLowerCase() === owner.bootId && fields[19] === owner.startTimeTicks;
}

function replayExecution(attemptId: string, result: MissionChildResult): MissionChildExecution {
  return {
    attemptId,
    usageAtAttach: { ...result.usage },
    sessionId: null,
    cancel: async () => {},
    done: async () => ({ ...result, usage: { ...result.usage } }),
  };
}

function lostAfterOwnerDeath(record: AttemptRecord): MissionChildResult {
  return {
    outcome: 'lost',
    summary: `Runner owner died while attempt '${record.authority.attemptId}' was ${record.status}; parent-death containment prevents a duplicate, but final model usage is unknown.`,
    usage: { tokens: null, usd: null, activeSeconds: null },
  };
}

/**
 * Single-host durable child-attempt authority for parent-death-contained processes.
 *
 * It deliberately does not pretend to reattach stdio after restart. A live owner returns the
 * in-memory execution; a dead owner is converted once into a durable lost result with unknown
 * usage, which lets the mission fail/replan safely without ever launching the same attempt twice.
 */
export class LocalAttemptSessionRegistry implements MissionAttemptSessionRegistry {
  private readonly directory: string;
  private readonly lockStore: JsonlMissionStore;
  private readonly currentOwner: () => Promise<LocalAttemptOwner>;
  private readonly ownerAlive: (owner: LocalAttemptOwner) => Promise<boolean>;
  private readonly live = new Map<string, MissionChildExecution>();

  constructor(options: LocalAttemptSessionRegistryOptions) {
    if (!path.isAbsolute(options.directory)) throw new Error('attempt registry directory must be absolute');
    if (options.processesDieWithOwner !== true) {
      throw new Error('local attempt registry requires explicit parent-death process containment');
    }
    this.directory = options.directory;
    this.lockStore = new JsonlMissionStore(path.join(options.directory, 'locks'));
    this.currentOwner = options.currentOwner ?? linuxOwner;
    this.ownerAlive = options.ownerAlive ?? linuxOwnerAlive;
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('attempt registry directory must be a real directory');
    }
    if (
      process.platform !== 'win32' &&
      ((typeof process.getuid === 'function' && metadata.uid !== process.getuid()) ||
        (metadata.mode & 0o077) !== 0)
    ) {
      throw new Error('attempt registry directory must be owned by Runner with mode 0700');
    }
    await realpath(this.directory);
  }

  private recordPath(attemptId: string): string {
    return path.join(this.directory, recordFilename(attemptId));
  }

  private async readRecord(attemptId: string): Promise<AttemptRecord | null> {
    const filename = this.recordPath(attemptId);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_RECORD_BYTES) {
      throw new Error(`attempt record '${filename}' is not a bounded regular file`);
    }
    if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
      throw new Error(`attempt record '${filename}' is not private`);
    }
    const handle = await open(filename, constants.O_RDONLY | NO_FOLLOW);
    try {
      const opened = await handle.stat();
      if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
        throw new Error(`attempt record '${filename}' changed while opening`);
      }
      return parseRecord(await handle.readFile('utf8'), attemptId);
    } finally {
      await handle.close();
    }
  }

  private async writeRecord(record: AttemptRecord): Promise<void> {
    const body = `${canonicalMissionJson(record)}\n`;
    if (Buffer.byteLength(body, 'utf8') > MAX_RECORD_BYTES) throw new Error('attempt record is oversized');
    const destination = this.recordPath(record.authority.attemptId);
    const temporary = path.join(this.directory, `.${path.basename(destination)}.${randomUUID()}.tmp`);
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
    await rename(temporary, destination);
    const directory = await open(this.directory, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private async withAttemptLock<T>(attemptId: string, operation: () => Promise<T>): Promise<T> {
    await this.ensureDirectory();
    const lease = await this.lockStore.acquireController(`attempt:${attemptId}`);
    try {
      return await operation();
    } finally {
      await lease.release();
    }
  }

  async recover(request: MissionAttemptRecoveryRequest): Promise<MissionAttemptRegistryRecovery> {
    if (
      !ATTEMPT_ID.test(request.missionId) ||
      !ATTEMPT_ID.test(request.childId) ||
      !ATTEMPT_ID.test(request.attemptId)
    ) {
      throw new Error('attempt recovery identity is invalid');
    }
    return this.withAttemptLock(request.attemptId, async () => {
      const record = await this.readRecord(request.attemptId);
      if (!record) return { status: 'absent' as const };
      if (!sameDurableAttempt(record, request)) {
        return {
          status: 'ambiguous' as const,
          reason: 'attempt record belongs to a different durable mission or child',
        };
      }
      if (record.status === 'terminal' && record.result) {
        return {
          status: 'attached' as const,
          execution: replayExecution(request.attemptId, record.result),
        };
      }
      const live = this.live.get(request.attemptId);
      if (live) return { status: 'attached' as const, execution: live };
      if (await this.ownerAlive(record.owner)) {
        return {
          status: 'ambiguous' as const,
          reason: `attempt is owned by live Runner pid ${record.owner.pid} but no attachable local execution is available`,
        };
      }

      const result = lostAfterOwnerDeath(record);
      await this.writeRecord({
        version: record.version,
        authority: record.authority,
        authorityDigest: record.authorityDigest,
        owner: record.owner,
        status: 'terminal',
        result,
        updatedAt: new Date().toISOString(),
      });
      return {
        status: 'attached' as const,
        execution: replayExecution(request.attemptId, result),
      };
    });
  }

  async claim(request: MissionAttemptRegistryRequest): Promise<MissionAttemptRegistryClaim> {
    const authority = authorityFrom(request);
    const digest = authorityDigest(authority);
    const owner = await this.currentOwner();
    return this.withAttemptLock(request.attemptId, async () => {
      const record = await this.readRecord(request.attemptId);
      if (!record) {
        const reserved: AttemptRecord = {
          version: RECORD_VERSION,
          authority,
          authorityDigest: digest,
          owner,
          status: 'reserved',
          updatedAt: new Date().toISOString(),
        };
        await this.writeRecord(reserved);
        let settled = false;
        return {
          status: 'start' as const,
          publish: async (execution: MissionChildExecution): Promise<void> => {
            if (settled) throw new Error('attempt reservation is already settled');
            if (execution.attemptId !== request.attemptId) {
              throw new Error('published execution has the wrong attempt id');
            }
            await this.withAttemptLock(request.attemptId, async () => {
              const current = await this.readRecord(request.attemptId);
              if (
                !current ||
                current.status !== 'reserved' ||
                current.authorityDigest !== digest ||
                canonicalMissionJson(current.owner) !== canonicalMissionJson(owner)
              ) {
                throw new Error('attempt reservation changed before publish');
              }
              const originalDone = execution.done.bind(execution);
              let persistedDone: Promise<MissionChildResult> | null = null;
              execution.done = () => {
                persistedDone ??= (async () => {
                  const result = await originalDone();
                  if (!validUsage(result)) throw new Error('attempt returned invalid terminal usage');
                  await this.withAttemptLock(request.attemptId, async () => {
                    const latest = await this.readRecord(request.attemptId);
                    if (!latest || latest.authorityDigest !== digest) {
                      throw new Error('attempt authority changed before terminal persistence');
                    }
                    if (latest.status === 'terminal') return;
                    await this.writeRecord({
                      ...latest,
                      status: 'terminal',
                      result,
                      updatedAt: new Date().toISOString(),
                    });
                  });
                  this.live.delete(request.attemptId);
                  return result;
                })();
                return persistedDone;
              };
              this.live.set(request.attemptId, execution);
              await this.writeRecord({
                ...current,
                status: 'running',
                updatedAt: new Date().toISOString(),
              });
              // Start terminal persistence even if a controller crashes before it calls done().
              void execution.done().catch(() => undefined);
            });
            settled = true;
          },
          markAmbiguous: async (reason: string): Promise<void> => {
            if (settled) return;
            await this.withAttemptLock(request.attemptId, async () => {
              const current = await this.readRecord(request.attemptId);
              if (!current || current.authorityDigest !== digest || current.status === 'terminal') return;
              await this.writeRecord({
                ...current,
                status: 'ambiguous',
                reason: reason.slice(0, 16_384),
                updatedAt: new Date().toISOString(),
              });
            });
            settled = true;
          },
        };
      }

      if (record.authorityDigest !== digest) {
        return {
          status: 'ambiguous' as const,
          reason: 'attempt id was claimed under different authority',
        };
      }
      if (record.status === 'terminal' && record.result) {
        return {
          status: 'attached' as const,
          execution: replayExecution(request.attemptId, record.result),
        };
      }
      const live = this.live.get(request.attemptId);
      if (live) return { status: 'attached' as const, execution: live };
      if (await this.ownerAlive(record.owner)) {
        return {
          status: 'ambiguous' as const,
          reason: `attempt is owned by live Runner pid ${record.owner.pid} but no attachable local execution is available`,
        };
      }

      const result = lostAfterOwnerDeath(record);
      const terminal: AttemptRecord = {
        version: record.version,
        authority: record.authority,
        authorityDigest: record.authorityDigest,
        owner: record.owner,
        status: 'terminal',
        result,
        updatedAt: new Date().toISOString(),
      };
      await this.writeRecord(terminal);
      return {
        status: 'attached' as const,
        execution: replayExecution(request.attemptId, result),
      };
    });
  }
}
