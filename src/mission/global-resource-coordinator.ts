import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { JsonlMissionStore } from './jsonl-store';
import type { MissionChildState, MissionState } from './model';
import { canonicalMissionJson } from './store';

const LEDGER_VERSION = 2 as const;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const MAX_ALLOCATIONS = 16_384;
const RESOURCE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const EXTERNAL_RESOURCE_PREFIX = 'external:';
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

interface ResourceAllocation {
  allocationId: string;
  authorityDigest: string;
  missionId: string;
  childId: string;
  attemptId: string;
  scope: string;
  resources: Readonly<Record<string, number>>;
  status: 'active' | 'released';
  updatedAt: string;
}

interface ResourceLedger {
  version: typeof LEDGER_VERSION;
  revision: number;
  /** Binds every process using this ledger to one trusted capacity/scope interpretation. */
  policyDigest: string;
  allocations: Readonly<Record<string, ResourceAllocation>>;
}

export interface MissionExternalResourceCoordinator {
  /** Idempotently acquire all exact profile resources before any child process/MCP starts. */
  acquire(state: MissionState, child: MissionChildState, attemptId: string): Promise<void>;
  /** Idempotently release only after process settlement and required workspace/review evidence. */
  release(state: MissionState, child: MissionChildState): Promise<void>;
}

export interface GlobalMissionResourceCoordinatorOptions {
  directory: string;
  /** Trusted machine capacity catalog. Mission/model input can never widen it. */
  capacities: Readonly<Record<string, number>>;
  /**
   * Defaults to one machine-wide scope. A deployment may deliberately return a project/editor
   * pool identity, but repository identity is never an implicit weakening of a global fence.
   */
  scope?: (state: MissionState) => string;
  /** Required stable identity for a custom scope policy; defaults to `machine-v1`. */
  scopePolicyId?: string;
}

/** Explicit generic namespace: only these resources represent machine-wide external authority. */
export function isExternalMissionResourceKey(key: string): boolean {
  return key.startsWith(EXTERNAL_RESOURCE_PREFIX);
}

function externalResources(resources: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  return Object.fromEntries(Object.entries(resources).filter(([key]) => isExternalMissionResourceKey(key)));
}

function validUnits(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 1_000_000;
}

function normalizeCapacities(input: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  const result: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [key, value] of Object.entries(input).sort(([left], [right]) => left.localeCompare(right))) {
    if (!RESOURCE_KEY.test(key) || !isExternalMissionResourceKey(key) || !validUnits(value)) {
      throw new Error(`global resource capacity '${key}' must have a bounded safe positive integer value`);
    }
    result[key] = value;
  }
  return Object.freeze(result);
}

function allocationAuthority(
  state: MissionState,
  child: MissionChildState,
  attemptId: string,
  scope: string,
): unknown {
  return {
    missionId: state.missionId,
    childId: child.childId,
    attemptId,
    scope,
    resources: externalResources(child.resources),
    profileAuthorityDigest: digest({
      guide: state.guide,
      profiles: state.profiles,
      projectMcpDeclarationFingerprint: state.projectMcpDeclarationFingerprint,
    }),
  };
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalMissionJson(value), 'utf8').digest('hex');
}

function allocationId(attemptId: string): string {
  return createHash('sha256').update(attemptId, 'utf8').digest('hex');
}

function parseLedger(raw: string): ResourceLedger {
  if (Buffer.byteLength(raw, 'utf8') > MAX_LEDGER_BYTES) throw new Error('resource ledger is oversized');
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new Error('resource ledger is not valid JSON');
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('resource ledger root is invalid');
  }
  const ledger = candidate as Partial<ResourceLedger>;
  if (
    ledger.version !== LEDGER_VERSION ||
    !Number.isSafeInteger(ledger.revision) ||
    (ledger.revision ?? -1) < 0 ||
    typeof ledger.policyDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(ledger.policyDigest) ||
    !ledger.allocations ||
    typeof ledger.allocations !== 'object' ||
    Array.isArray(ledger.allocations) ||
    Object.keys(ledger.allocations).length > MAX_ALLOCATIONS
  ) {
    throw new Error('resource ledger fields are invalid');
  }
  for (const [id, allocation] of Object.entries(ledger.allocations)) {
    if (
      !/^[a-f0-9]{64}$/.test(id) ||
      allocation.allocationId !== id ||
      !/^[a-f0-9]{64}$/.test(allocation.authorityDigest) ||
      !['active', 'released'].includes(allocation.status) ||
      typeof allocation.scope !== 'string' ||
      allocation.scope.length < 1 ||
      allocation.scope.length > 1_024 ||
      allocation.scope.includes('\0') ||
      typeof allocation.attemptId !== 'string' ||
      allocation.attemptId.length < 1 ||
      Object.entries(allocation.resources).some(
        ([key, units]) => !RESOURCE_KEY.test(key) || !validUnits(units),
      )
    ) {
      throw new Error(`resource ledger allocation '${id}' is invalid`);
    }
  }
  return ledger as ResourceLedger;
}

/**
 * Durable cross-mission resource fencing. Logical mission resource admission remains a fast local
 * check; this ledger is the machine-wide authority for scarce external integrations such as an
 * editor session. Names stay opaque and project-neutral to Runner.
 */
export class GlobalMissionResourceCoordinator implements MissionExternalResourceCoordinator {
  private readonly directory: string;
  private readonly ledgerPath: string;
  private readonly capacities: Readonly<Record<string, number>>;
  private readonly policyDigest: string;
  private readonly scopeFor: (state: MissionState) => string;
  private readonly lockStore: JsonlMissionStore;

  constructor(options: GlobalMissionResourceCoordinatorOptions) {
    if (!path.isAbsolute(options.directory)) throw new Error('resource directory must be absolute');
    this.directory = options.directory;
    this.ledgerPath = path.join(options.directory, 'allocations.json');
    this.capacities = normalizeCapacities(options.capacities);
    if (options.scope && !options.scopePolicyId) {
      throw new Error('a custom global resource scope requires a stable scopePolicyId');
    }
    const scopePolicyId = options.scopePolicyId ?? 'machine-v1';
    if (!RESOURCE_KEY.test(scopePolicyId)) throw new Error('resource scopePolicyId is invalid');
    this.policyDigest = digest({ capacities: this.capacities, scopePolicyId });
    this.scopeFor = options.scope ?? (() => 'machine');
    this.lockStore = new JsonlMissionStore(path.join(options.directory, 'locks'), {
      controllerTimeoutMs: 30_000,
    });
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('resource directory must be a real directory');
    }
    if (
      process.platform !== 'win32' &&
      ((typeof process.getuid === 'function' && metadata.uid !== process.getuid()) ||
        (metadata.mode & 0o077) !== 0)
    ) {
      throw new Error('resource directory must be owned by Runner with mode 0700');
    }
    await realpath(this.directory);
  }

  private async readLedger(): Promise<ResourceLedger> {
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(this.ledgerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          version: LEDGER_VERSION,
          revision: 0,
          policyDigest: this.policyDigest,
          allocations: {},
        };
      }
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_LEDGER_BYTES) {
      throw new Error('resource ledger must be a bounded regular file');
    }
    if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
      throw new Error('resource ledger must have mode 0600');
    }
    const handle = await open(this.ledgerPath, constants.O_RDONLY | NO_FOLLOW);
    try {
      const opened = await handle.stat();
      if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
        throw new Error('resource ledger changed while opening');
      }
      const ledger = parseLedger(await handle.readFile('utf8'));
      if (ledger.policyDigest !== this.policyDigest) {
        throw new Error('resource ledger policy differs from this Runner capacity/scope policy');
      }
      return ledger;
    } finally {
      await handle.close();
    }
  }

  private async writeLedger(ledger: ResourceLedger): Promise<void> {
    const body = `${canonicalMissionJson(ledger)}\n`;
    if (Buffer.byteLength(body, 'utf8') > MAX_LEDGER_BYTES) throw new Error('resource ledger is full');
    const temporary = path.join(this.directory, `.allocations.${randomUUID()}.tmp`);
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
    await rename(temporary, this.ledgerPath);
    const directory = await open(this.directory, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private async locked<T>(operation: (ledger: ResourceLedger) => Promise<T>): Promise<T> {
    await this.ensureDirectory();
    const lease = await this.lockStore.acquireController('global-resource-ledger');
    try {
      return await operation(await this.readLedger());
    } finally {
      await lease.release();
    }
  }

  async acquire(state: MissionState, child: MissionChildState, attemptId: string): Promise<void> {
    const requested = externalResources(child.resources);
    if (Object.keys(requested).length === 0) return;
    const scope = this.scopeFor(state);
    if (!scope || scope.length > 1_024 || scope.includes('\0')) throw new Error('resource scope is invalid');
    for (const [key, units] of Object.entries(requested)) {
      const capacity = this.capacities[key];
      if (capacity === undefined || units > capacity) {
        throw new Error(`trusted global resource '${key}' has no capacity for ${units} units`);
      }
    }
    const authority = allocationAuthority(state, child, attemptId, scope);
    const authorityDigest = digest(authority);
    const id = allocationId(attemptId);
    await this.locked(async (ledger) => {
      const existing = ledger.allocations[id];
      if (existing) {
        if (existing.authorityDigest !== authorityDigest) {
          throw new Error('resource allocation attempt id was reused under different authority');
        }
        if (existing.status === 'released') {
          throw new Error('released resource allocation cannot be reacquired for the same attempt');
        }
        return;
      }
      if (Object.keys(ledger.allocations).length >= MAX_ALLOCATIONS) {
        throw new Error('resource allocation ledger reached its bounded entry limit');
      }
      for (const [key, units] of Object.entries(requested)) {
        const held = Object.values(ledger.allocations)
          .filter((allocation) => allocation.status === 'active' && allocation.scope === scope)
          .reduce((total, allocation) => total + (allocation.resources[key] ?? 0), 0);
        if (held + units > this.capacities[key]!) {
          throw new Error(`global resource '${key}' is exhausted in scope '${scope}'`);
        }
      }
      const allocation: ResourceAllocation = {
        allocationId: id,
        authorityDigest,
        missionId: state.missionId,
        childId: child.childId,
        attemptId,
        scope,
        resources: { ...requested },
        status: 'active',
        updatedAt: new Date().toISOString(),
      };
      await this.writeLedger({
        version: LEDGER_VERSION,
        revision: ledger.revision + 1,
        policyDigest: this.policyDigest,
        allocations: { ...ledger.allocations, [id]: allocation },
      });
    });
  }

  async release(state: MissionState, child: MissionChildState): Promise<void> {
    if (!Object.keys(child.resources).some(isExternalMissionResourceKey)) return;
    if (!child.attemptId) throw new Error(`resource-bearing child '${child.childId}' has no attempt id`);
    const scope = this.scopeFor(state);
    const authorityDigest = digest(allocationAuthority(state, child, child.attemptId, scope));
    const id = allocationId(child.attemptId);
    await this.locked(async (ledger) => {
      const existing = ledger.allocations[id];
      if (!existing) throw new Error(`resource allocation for '${child.childId}' is missing`);
      if (existing.authorityDigest !== authorityDigest) {
        throw new Error('resource release authority does not match the durable allocation');
      }
      if (existing.status === 'released') return;
      await this.writeLedger({
        version: LEDGER_VERSION,
        revision: ledger.revision + 1,
        policyDigest: this.policyDigest,
        allocations: {
          ...ledger.allocations,
          [id]: { ...existing, status: 'released', updatedAt: new Date().toISOString() },
        },
      });
    });
  }
}
