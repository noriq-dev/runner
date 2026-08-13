import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  type CommissionedExecutionProfile,
  CommissionedExecutionProfile as CommissionedExecutionProfileSchema,
  ExecutionProfileId,
  type ExecutionProfileOffer,
  ExecutionProfileOffer as ExecutionProfileOfferSchema,
} from '@noriq-dev/shared';
import { z } from 'zod';
import { DEFAULT_CLAUDE_HOME, DEFAULT_CODEX_HOME } from '../agent-homes';
import { openConfined } from '../repo-context';
import type { MissionBudget } from './protocol';
import { canonicalMissionJson } from './store';

const PROFILE_DIRECTORY = path.join('.noriq', 'execution-profiles');
const MAX_PROFILE_FILES = 64;
const MAX_PROFILE_SNAPSHOT_VARIANTS = 64;
const MAX_PROFILE_BYTES = 512 * 1024;
const MAX_MCP_BYTES = 256 * 1024;
const MAX_PROFILE_CONCURRENCY = 256;
const MAX_EXTERNAL_RESOURCES = 64;
const MAX_EXTERNAL_RESOURCE_UNITS = 256;
const SHA256_FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const EXTERNAL_RESOURCE = /^external:[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;

export type MissionExecutionProfileMcpSourceKind = 'project' | 'codex-home' | 'claude-home';

const missionBudgetSchema = z
  .object({
    tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    usd: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    activeSeconds: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

const externalResourceCapacitiesSchema = z
  .record(z.string(), z.number().int().positive().max(MAX_EXTERNAL_RESOURCE_UNITS))
  .superRefine((capacities, context) => {
    const keys = Object.keys(capacities);
    if (keys.length > MAX_EXTERNAL_RESOURCES) {
      context.addIssue({
        code: 'custom',
        message: `at most ${MAX_EXTERNAL_RESOURCES} external resource capacities are allowed`,
      });
    }
    for (const key of keys) {
      if (!EXTERNAL_RESOURCE.test(key)) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: "resource keys must use the bounded 'external:*' namespace",
        });
      }
    }
  });

const declarationSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: ExecutionProfileId,
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maxConcurrency: z.number().int().positive().max(MAX_PROFILE_CONCURRENCY),
    missionBudget: missionBudgetSchema,
    externalResourceCapacities: externalResourceCapacitiesSchema,
    catalog: z.unknown(),
  })
  .strict();

export interface MissionExecutionProfileDeclaration {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly generation: number;
  readonly maxConcurrency: number;
  readonly missionBudget: MissionBudget;
  readonly externalResourceCapacities: Readonly<Record<string, number>>;
  /** Validated by `createLocalMissionRuntime` inside the trusted activation factory. */
  readonly catalog: unknown;
}

export interface MissionExecutionProfileMcpDeclaration {
  readonly sourceKind: MissionExecutionProfileMcpSourceKind;
  /** Snapshot-owned root containing exactly one selected `.mcp.json`. */
  readonly declarationRoot: string;
}

/**
 * Complete local input for the trusted runtime factory. No original MCP path survives this seam:
 * activation reads only immutable snapshot roots containing the exact bytes that were fingerprinted.
 */
export interface MissionExecutionProfileActivationRequest {
  readonly repositoryRoot: string;
  readonly declaration: MissionExecutionProfileDeclaration;
  readonly declarationFingerprint: string;
  readonly declarationSnapshotPath: string;
  readonly snapshotRoot: string;
  readonly mcpDeclarations: readonly MissionExecutionProfileMcpDeclaration[];
}

export interface MissionExecutionProfileActivation<R> {
  readonly runtime: R;
  /** Opaque local attestation identity. Paths, credentials, and probe output are forbidden. */
  readonly effectiveFingerprint: string;
}

export type MissionExecutionProfileActivationFactory<R> = (
  request: MissionExecutionProfileActivationRequest,
) => Promise<MissionExecutionProfileActivation<R>>;

export interface MissionExecutionProfileMatch<R> {
  readonly runtime: R;
  readonly declaration: MissionExecutionProfileDeclaration;
  readonly declarationFingerprint: string;
  readonly effectiveFingerprint: string;
}

export interface MissionExecutionProfileLease<R> extends MissionExecutionProfileMatch<R> {
  release(): void;
}

export interface MissionExecutionProfileRegistryOptions<R> {
  repoRoot: string;
  /** Machine-private state outside the repository. */
  snapshotDirectory: string;
  activationFactory: MissionExecutionProfileActivationFactory<R>;
  codexHome?: string;
  claudeHome?: string;
  clock?: () => Date;
}

export class MissionExecutionProfileRegistryError extends Error {
  override readonly name = 'MissionExecutionProfileRegistryError';
}

interface SelectedMcpBytes {
  sourceKind: MissionExecutionProfileMcpSourceKind;
  bytes: Buffer;
}

interface DiscoveredDeclaration {
  declaration: MissionExecutionProfileDeclaration;
  bytes: Buffer;
  mcp: readonly SelectedMcpBytes[];
  declarationFingerprint: string;
}

interface ActivatedRecord<R> {
  request: MissionExecutionProfileActivationRequest;
  runtime: R;
  effectiveFingerprint: string;
  offer: ExecutionProfileOffer;
}

function commissionKey(commission: CommissionedExecutionProfile): string {
  return canonicalMissionJson({
    id: commission.id,
    generation: commission.generation,
    declarationFingerprint: commission.declarationFingerprint,
    effectiveFingerprint: commission.effectiveFingerprint,
    attestationCapable: commission.attestationCapable,
  });
}

function registryError(detail: string): MissionExecutionProfileRegistryError {
  return new MissionExecutionProfileRegistryError(`invalid mission execution profile registry: ${detail}`);
}

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fingerprint(value: unknown): string {
  return `sha256:${sha256(canonicalMissionJson(value))}`;
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function detachedDeclaration(value: z.infer<typeof declarationSchema>): MissionExecutionProfileDeclaration {
  return deepFreeze(JSON.parse(canonicalMissionJson(value)) as MissionExecutionProfileDeclaration);
}

function hasExactDeclarationKeys(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    canonicalMissionJson(keys) ===
    canonicalMissionJson(
      [
        'catalog',
        'externalResourceCapacities',
        'generation',
        'id',
        'maxConcurrency',
        'missionBudget',
        'schemaVersion',
      ].sort(),
    )
  );
}

async function readBoundedConfinedFile(root: string, filename: string, maxBytes: number): Promise<Buffer> {
  const handle = await openConfined(filename, root);
  try {
    const metadata = await handle.stat();
    if (metadata.size > maxBytes) throw registryError(`selected file exceeds ${maxBytes} bytes`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function optionalMcpBytes(
  root: string,
  sourceKind: MissionExecutionProfileMcpSourceKind,
): Promise<SelectedMcpBytes | null> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return {
      sourceKind,
      bytes: await readBoundedConfinedFile(
        canonicalRoot,
        path.join(canonicalRoot, '.mcp.json'),
        MAX_MCP_BYTES,
      ),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function referencedDrivers(catalog: unknown): ReadonlySet<string> {
  const drivers = new Set<string>();
  if (catalog === null || typeof catalog !== 'object' || Array.isArray(catalog)) return drivers;
  const root = catalog as Record<string, unknown>;
  const addAgent = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return;
    const agent = (candidate as Record<string, unknown>).agent;
    if (agent === null || typeof agent !== 'object' || Array.isArray(agent)) return;
    const driver = (agent as Record<string, unknown>).driver;
    if (typeof driver === 'string') drivers.add(driver);
  };
  addAgent(root.guide);
  if (Array.isArray(root.profiles)) {
    for (const profile of root.profiles) addAgent(profile);
  }
  return drivers;
}

async function selectedMcpBytes(
  declaration: MissionExecutionProfileDeclaration,
  repositoryRoot: string,
  codexHome: string,
  claudeHome: string,
): Promise<readonly SelectedMcpBytes[]> {
  const drivers = referencedDrivers(declaration.catalog);
  const selected = await Promise.all([
    optionalMcpBytes(repositoryRoot, 'project'),
    ...(drivers.has('codex') ? [optionalMcpBytes(codexHome, 'codex-home')] : []),
    ...(drivers.has('claude') ? [optionalMcpBytes(claudeHome, 'claude-home')] : []),
  ]);
  return selected.filter((item): item is SelectedMcpBytes => item !== null);
}

function portableDeclarationFingerprint(
  declaration: MissionExecutionProfileDeclaration,
  mcp: readonly SelectedMcpBytes[],
): string {
  return fingerprint({
    schema: 'noriq-mission-execution-profile.v1',
    declaration,
    mcp: [...mcp]
      .map((item) => ({
        sourceKind: item.sourceKind,
        bytes: item.bytes.byteLength,
        sha256: sha256(item.bytes),
      }))
      .sort((left, right) => left.sourceKind.localeCompare(right.sourceKind)),
  });
}

async function ensurePrivateDirectory(directory: string): Promise<string> {
  if (!path.isAbsolute(directory)) throw registryError('snapshotDirectory must be absolute');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw registryError('snapshotDirectory must be a real directory');
  }
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      throw registryError('snapshotDirectory must be owned by the Runner user');
    }
    await chmod(directory, 0o700);
  }
  return realpath(directory);
}

async function writeSnapshotFile(filename: string, bytes: Buffer): Promise<void> {
  await writeFile(filename, bytes, { flag: 'wx', mode: 0o400 });
  if (process.platform !== 'win32') await chmod(filename, 0o400);
}

async function verifySnapshot(
  snapshotRoot: string,
  profileBytes: Buffer,
  mcp: readonly SelectedMcpBytes[],
): Promise<void> {
  const profile = await readFile(path.join(snapshotRoot, 'profile.json'));
  if (!profile.equals(profileBytes)) throw registryError('immutable profile snapshot does not match');
  for (const item of mcp) {
    const bytes = await readFile(path.join(snapshotRoot, item.sourceKind, '.mcp.json'));
    if (!bytes.equals(item.bytes)) throw registryError('immutable MCP snapshot does not match');
  }
}

async function materializeSnapshot(
  snapshotDirectory: string,
  declarationFingerprint: string,
  profileBytes: Buffer,
  mcp: readonly SelectedMcpBytes[],
): Promise<{
  snapshotRoot: string;
  declarationSnapshotPath: string;
  mcpDeclarations: readonly MissionExecutionProfileMcpDeclaration[];
}> {
  const portableKey = declarationFingerprint.slice('sha256:'.length);
  const rawKey = sha256(profileBytes);
  const portableRoot = path.join(snapshotDirectory, portableKey);
  const snapshotRoot = path.join(portableRoot, rawKey);
  await mkdir(portableRoot, { recursive: true, mode: 0o700 });
  const portableMetadata = await lstat(portableRoot);
  if (portableMetadata.isSymbolicLink() || !portableMetadata.isDirectory()) {
    throw registryError('portable snapshot root must be a real directory');
  }
  let temporary: string | null = null;
  try {
    temporary = await mkdtemp(path.join(portableRoot, '.pending-'));
    await writeSnapshotFile(path.join(temporary, 'profile.json'), profileBytes);
    for (const item of mcp) {
      const root = path.join(temporary, item.sourceKind);
      await mkdir(root, { mode: 0o700 });
      await writeSnapshotFile(path.join(root, '.mcp.json'), item.bytes);
      if (process.platform !== 'win32') await chmod(root, 0o500);
    }
    if (process.platform !== 'win32') await chmod(temporary, 0o500);
    try {
      await rename(temporary, snapshotRoot);
      temporary = null;
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  } finally {
    if (temporary !== null) {
      if (process.platform !== 'win32') await chmod(temporary, 0o700).catch(() => undefined);
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  const canonicalSnapshotRoot = await realpath(snapshotRoot);
  if (!contains(snapshotDirectory, canonicalSnapshotRoot)) {
    throw registryError('immutable snapshot resolves outside the private snapshot directory');
  }
  const snapshotMetadata = await lstat(snapshotRoot);
  if (snapshotMetadata.isSymbolicLink() || !snapshotMetadata.isDirectory()) {
    throw registryError('immutable snapshot must be a real directory');
  }
  await verifySnapshot(snapshotRoot, profileBytes, mcp);
  return {
    snapshotRoot,
    declarationSnapshotPath: path.join(snapshotRoot, 'profile.json'),
    mcpDeclarations: mcp.map((item) => ({
      sourceKind: item.sourceKind,
      declarationRoot: path.join(snapshotRoot, item.sourceKind),
    })),
  };
}

async function discoverDeclarations(
  repositoryRoot: string,
  codexHome: string,
  claudeHome: string,
): Promise<readonly DiscoveredDeclaration[]> {
  const directory = path.join(repositoryRoot, PROFILE_DIRECTORY);
  let canonicalDirectory: string;
  try {
    canonicalDirectory = await realpath(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (!contains(repositoryRoot, canonicalDirectory)) {
    throw registryError('execution profile directory resolves outside the repository');
  }
  let entries: Dirent<string>[];
  try {
    entries = await readdir(canonicalDirectory, { withFileTypes: true, encoding: 'utf8' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files = entries
    .filter((entry) => entry.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (files.length > MAX_PROFILE_FILES) {
    throw registryError(`at most ${MAX_PROFILE_FILES} execution profile declarations are allowed`);
  }

  const discovered: DiscoveredDeclaration[] = [];
  const ids = new Set<string>();
  for (const entry of files) {
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      throw registryError(`execution profile '${entry.name}' must be a regular file`);
    }
    const filename = path.join(canonicalDirectory, entry.name);
    const bytes = await readBoundedConfinedFile(repositoryRoot, filename, MAX_PROFILE_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw registryError(`execution profile '${entry.name}' is not valid JSON`);
    }
    const result = hasExactDeclarationKeys(parsed)
      ? declarationSchema.safeParse(parsed)
      : { success: false as const };
    if (!result.success) {
      throw registryError(`execution profile '${entry.name}' does not match the strict schema`);
    }
    const declaration = detachedDeclaration(result.data);
    if (ids.has(declaration.id)) {
      throw registryError(`execution profile id '${declaration.id}' is declared more than once`);
    }
    ids.add(declaration.id);
    const mcp = await selectedMcpBytes(declaration, repositoryRoot, codexHome, claudeHome);
    discovered.push({
      declaration,
      bytes,
      mcp,
      declarationFingerprint: portableDeclarationFingerprint(declaration, mcp),
    });
  }
  return discovered;
}

function validObservedAt(clock: () => Date): string {
  const observed = clock();
  if (!(observed instanceof Date) || !Number.isFinite(observed.getTime())) {
    throw registryError('clock returned an invalid date');
  }
  return observed.toISOString();
}

function unavailableOffer(
  declaration: MissionExecutionProfileDeclaration,
  declarationFingerprint: string,
  observedAt: string,
): ExecutionProfileOffer {
  return ExecutionProfileOfferSchema.parse({
    id: declaration.id,
    declarationFingerprint,
    effectiveFingerprint: null,
    resolution: 'unresolved',
    health: 'unavailable',
    attestationCapable: false,
    observedAt,
    generation: declaration.generation,
    capacity: { maxConcurrency: declaration.maxConcurrency, freeSlots: 0 },
  });
}

function exactCommission(
  record: ActivatedRecord<unknown>,
  commission: CommissionedExecutionProfile,
): boolean {
  const offer = record.offer;
  return (
    offer.resolution === 'resolved' &&
    offer.health === 'healthy' &&
    offer.attestationCapable === true &&
    offer.effectiveFingerprint !== null &&
    commission.attestationCapable === true &&
    commission.id === offer.id &&
    commission.generation === offer.generation &&
    commission.declarationFingerprint === offer.declarationFingerprint &&
    commission.effectiveFingerprint === offer.effectiveFingerprint
  );
}

/**
 * Repository-local declaration discovery plus machine-local runtime attestation. The registry does
 * not know about Unreal, individual MCP servers, or vendor-specific tools; it selects only the
 * generic project and referenced Noriq agent-environment declaration roots.
 */
export class MissionExecutionProfileRegistry<R> {
  private readonly options: MissionExecutionProfileRegistryOptions<R>;
  private readonly clock: () => Date;
  private readonly activeById = new Map<string, number>();
  private current = new Map<string, ActivatedRecord<R>>();
  /** Immutable, no-longer-current snapshots re-attested for restart adoption. */
  private readonly historical = new Map<string, ActivatedRecord<R>>();
  private advertised = new Map<string, ExecutionProfileOffer>();
  private refreshPromise: Promise<readonly ExecutionProfileOffer[]> | null = null;
  private observing = false;

  constructor(options: MissionExecutionProfileRegistryOptions<R>) {
    this.options = options;
    this.clock = options.clock ?? (() => new Date());
  }

  /** Concurrent callers share one attestation pass; later observations always invoke the factory. */
  refresh(): Promise<readonly ExecutionProfileOffer[]> {
    if (this.refreshPromise) return this.refreshPromise;
    this.observing = true;
    const pending = this.refreshInternal().finally(() => {
      if (this.refreshPromise === pending) {
        this.refreshPromise = null;
        this.observing = false;
      }
    });
    this.refreshPromise = pending;
    return pending;
  }

  offers(): readonly ExecutionProfileOffer[] {
    return [...this.advertised.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((offer) => {
        const active = this.activeById.get(offer.id) ?? 0;
        const freeSlots =
          offer.health === 'healthy' && offer.resolution === 'resolved'
            ? Math.max(0, offer.capacity.maxConcurrency - active)
            : 0;
        return {
          ...offer,
          capacity: { ...offer.capacity, freeSlots },
        };
      });
  }

  match(commission: CommissionedExecutionProfile): MissionExecutionProfileMatch<R> | null {
    // Re-attestation is an admission gate, not a background timestamp refresh. Existing leases
    // retain their runtime, but no new commission may bind to the previous observation mid-pass.
    if (this.observing) return null;
    const parsed = CommissionedExecutionProfileSchema.safeParse(commission);
    if (!parsed.success) return null;
    const record = this.current.get(parsed.data.id);
    if (!record || !exactCommission(record, parsed.data)) return null;
    return {
      runtime: record.runtime,
      declaration: record.request.declaration,
      declarationFingerprint: record.request.declarationFingerprint,
      effectiveFingerprint: record.effectiveFingerprint,
    };
  }

  acquire(commission: CommissionedExecutionProfile): MissionExecutionProfileLease<R> | null {
    const matched = this.match(commission);
    if (!matched) return null;
    return this.acquireMatched(commission, matched);
  }

  private acquireMatched(
    commission: CommissionedExecutionProfile,
    matched: MissionExecutionProfileMatch<R>,
  ): MissionExecutionProfileLease<R> | null {
    const current = this.activeById.get(commission.id) ?? 0;
    const currentDeclarationLimit = this.current.get(commission.id)?.request.declaration.maxConcurrency;
    const limit = Math.min(
      matched.declaration.maxConcurrency,
      currentDeclarationLimit ?? matched.declaration.maxConcurrency,
    );
    if (current >= limit) return null;
    this.activeById.set(commission.id, current + 1);
    let released = false;
    return {
      ...matched,
      release: () => {
        if (released) return;
        released = true;
        const active = this.activeById.get(commission.id) ?? 0;
        if (active <= 1) this.activeById.delete(commission.id);
        else this.activeById.set(commission.id, active - 1);
      },
    };
  }

  /**
   * Re-attest an immutable private snapshot for an unsettled commission after the repository's
   * current declaration changed or disappeared. This is restart recovery only: discovery never
   * advertises a historical record, and every commissioned field plus the freshly recomputed
   * effective fingerprint must match exactly before capacity is consumed.
   */
  async acquireSnapshot(
    commissionInput: CommissionedExecutionProfile,
  ): Promise<MissionExecutionProfileLease<R> | null> {
    if (this.observing) return null;
    const parsed = CommissionedExecutionProfileSchema.safeParse(commissionInput);
    if (!parsed.success) return null;
    const commission = parsed.data;

    const current = this.match(commission);
    if (current) return this.acquireMatched(commission, current);

    const key = commissionKey(commission);
    const cached = this.historical.get(key);
    if (cached && exactCommission(cached, commission)) {
      return this.acquireMatched(commission, {
        runtime: cached.runtime,
        declaration: cached.request.declaration,
        declarationFingerprint: cached.request.declarationFingerprint,
        effectiveFingerprint: cached.effectiveFingerprint,
      });
    }

    let snapshotDirectory: string;
    let repositoryRoot: string;
    try {
      snapshotDirectory = await ensurePrivateDirectory(this.options.snapshotDirectory);
      repositoryRoot = await realpath(this.options.repoRoot);
    } catch {
      return null;
    }
    const fingerprintKey = commission.declarationFingerprint.replace(/^sha256:/, '');
    if (!/^[a-f0-9]{64}$/.test(fingerprintKey)) return null;
    const portableRoot = path.join(snapshotDirectory, fingerprintKey);
    let canonicalPortableRoot: string;
    let variants: Dirent<string>[];
    try {
      canonicalPortableRoot = await realpath(portableRoot);
      if (!contains(snapshotDirectory, canonicalPortableRoot)) return null;
      const metadata = await lstat(canonicalPortableRoot);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) return null;
      variants = (await readdir(canonicalPortableRoot, { withFileTypes: true, encoding: 'utf8' }))
        .filter((entry) => !entry.name.startsWith('.pending-'))
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      return null;
    }
    if (variants.length === 0 || variants.length > MAX_PROFILE_SNAPSHOT_VARIANTS) return null;

    for (const variant of variants) {
      if (!variant.isDirectory() || !/^[a-f0-9]{64}$/.test(variant.name)) return null;
      const candidate = path.join(canonicalPortableRoot, variant.name);
      try {
        const snapshotRoot = await realpath(candidate);
        if (!contains(canonicalPortableRoot, snapshotRoot)) return null;
        const metadata = await lstat(snapshotRoot);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) return null;

        const profileBytes = await readBoundedConfinedFile(
          snapshotRoot,
          path.join(snapshotRoot, 'profile.json'),
          MAX_PROFILE_BYTES,
        );
        if (sha256(profileBytes) !== variant.name) return null;
        const raw = JSON.parse(profileBytes.toString('utf8')) as unknown;
        if (!hasExactDeclarationKeys(raw)) return null;
        const declarationResult = declarationSchema.safeParse(raw);
        if (!declarationResult.success) return null;
        const declaration = detachedDeclaration(declarationResult.data);
        if (declaration.id !== commission.id || declaration.generation !== commission.generation) continue;

        const mcp: SelectedMcpBytes[] = [];
        for (const sourceKind of ['project', 'codex-home', 'claude-home'] as const) {
          const declarationRoot = path.join(snapshotRoot, sourceKind);
          try {
            const bytes = await readBoundedConfinedFile(
              snapshotRoot,
              path.join(declarationRoot, '.mcp.json'),
              MAX_MCP_BYTES,
            );
            mcp.push({ sourceKind, bytes });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        if (portableDeclarationFingerprint(declaration, mcp) !== commission.declarationFingerprint) {
          continue;
        }
        await verifySnapshot(snapshotRoot, profileBytes, mcp);
        const request = deepFreeze({
          repositoryRoot,
          declaration,
          declarationFingerprint: commission.declarationFingerprint,
          declarationSnapshotPath: path.join(snapshotRoot, 'profile.json'),
          snapshotRoot,
          mcpDeclarations: mcp.map((item) => ({
            sourceKind: item.sourceKind,
            declarationRoot: path.join(snapshotRoot, item.sourceKind),
          })),
        });
        const activation = await this.options.activationFactory(request);
        if (!SHA256_FINGERPRINT.test(activation.effectiveFingerprint)) continue;
        const offer = ExecutionProfileOfferSchema.parse({
          id: declaration.id,
          declarationFingerprint: commission.declarationFingerprint,
          effectiveFingerprint: activation.effectiveFingerprint,
          resolution: 'resolved',
          health: 'healthy',
          attestationCapable: true,
          observedAt: validObservedAt(this.clock),
          generation: declaration.generation,
          capacity: { maxConcurrency: declaration.maxConcurrency, freeSlots: declaration.maxConcurrency },
        });
        const record: ActivatedRecord<R> = {
          request,
          runtime: activation.runtime,
          effectiveFingerprint: activation.effectiveFingerprint,
          offer,
        };
        if (!exactCommission(record, commission)) continue;
        this.historical.set(key, record);
        return this.acquireMatched(commission, {
          runtime: record.runtime,
          declaration,
          declarationFingerprint: record.request.declarationFingerprint,
          effectiveFingerprint: record.effectiveFingerprint,
        });
      } catch {
        // A malformed or no-longer-attestable variant is not recovery authority. Try another raw
        // formatting variant only when its immutable portable identity is the same.
      }
    }
    return null;
  }

  private async refreshInternal(): Promise<readonly ExecutionProfileOffer[]> {
    let repositoryRoot: string;
    let snapshotDirectory: string;
    let discovered: readonly DiscoveredDeclaration[];
    try {
      repositoryRoot = await realpath(this.options.repoRoot);
      discovered = await discoverDeclarations(
        repositoryRoot,
        this.options.codexHome ?? DEFAULT_CODEX_HOME,
        this.options.claudeHome ?? DEFAULT_CLAUDE_HOME,
      );
      if (discovered.length === 0) {
        this.current.clear();
        this.advertised.clear();
        return [];
      }
      snapshotDirectory = await ensurePrivateDirectory(this.options.snapshotDirectory);
      if (contains(repositoryRoot, snapshotDirectory) || contains(snapshotDirectory, repositoryRoot)) {
        throw registryError('snapshotDirectory and repository must not overlap');
      }
    } catch (error) {
      this.current.clear();
      this.advertised.clear();
      throw error;
    }

    const nextCurrent = new Map<string, ActivatedRecord<R>>();
    const nextAdvertised = new Map<string, ExecutionProfileOffer>();
    for (const selected of discovered) {
      const observedAt = validObservedAt(this.clock);
      try {
        const snapshot = await materializeSnapshot(
          snapshotDirectory,
          selected.declarationFingerprint,
          selected.bytes,
          selected.mcp,
        );
        const request = deepFreeze({
          repositoryRoot,
          declaration: selected.declaration,
          declarationFingerprint: selected.declarationFingerprint,
          ...snapshot,
        });
        const activation = await this.options.activationFactory(request);
        if (!SHA256_FINGERPRINT.test(activation.effectiveFingerprint)) {
          throw registryError('activation returned an invalid effective fingerprint');
        }
        const offer = ExecutionProfileOfferSchema.parse({
          id: selected.declaration.id,
          declarationFingerprint: selected.declarationFingerprint,
          effectiveFingerprint: activation.effectiveFingerprint,
          resolution: 'resolved',
          health: 'healthy',
          attestationCapable: true,
          observedAt,
          generation: selected.declaration.generation,
          capacity: {
            maxConcurrency: selected.declaration.maxConcurrency,
            freeSlots: Math.max(
              0,
              selected.declaration.maxConcurrency - (this.activeById.get(selected.declaration.id) ?? 0),
            ),
          },
        });
        const record = {
          request,
          runtime: activation.runtime,
          effectiveFingerprint: activation.effectiveFingerprint,
          offer,
        };
        nextCurrent.set(selected.declaration.id, record);
        nextAdvertised.set(selected.declaration.id, offer);
      } catch {
        nextAdvertised.set(
          selected.declaration.id,
          unavailableOffer(selected.declaration, selected.declarationFingerprint, observedAt),
        );
      }
    }
    this.current = nextCurrent;
    this.advertised = nextAdvertised;
    return this.offers();
  }
}
