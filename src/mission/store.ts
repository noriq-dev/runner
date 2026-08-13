import { createHash } from 'node:crypto';
import { parseMissionAction } from './action-schema';
import { parseMissionEvent } from './event-schema';
import type {
  MissionAction,
  MissionActionEnvelope,
  MissionCommitReceipt,
  MissionEvent,
  MissionEventEnvelope,
} from './protocol';

/** One JSONL line is one atomic action batch, regardless of how many events the action emits. */
export const MISSION_JOURNAL_SCHEMA_VERSION = 1 as const;

/** Internal durable record. Public orchestration consumes its exact protocol envelopes/receipt. */
export interface StoredMissionAction {
  schemaVersion: typeof MISSION_JOURNAL_SCHEMA_VERSION;
  receipt: MissionCommitReceipt;
  recordedAt: string;
  previousHash: string | null;
  /** Retained so the action fingerprint remains independently verifiable after restart. */
  action: MissionAction;
  events: readonly MissionEventEnvelope[];
  /** Canonical SHA-256 over every preceding field, including `previousHash`. */
  hash: string;
}

export interface MissionHistory {
  missionId: string;
  revision: number;
  headHash: string | null;
  actions: readonly StoredMissionAction[];
  events: readonly MissionEventEnvelope[];
}

export interface MissionCommitResult {
  receipt: MissionCommitReceipt;
  /** True when this action id and fingerprint were already durable. */
  replayed: boolean;
  /** Exact history observed while holding the store's write/CAS boundary. */
  history: MissionHistory;
}

/** Bounded suffix used by the live kernel so one new fact never clones/reduces the whole journal. */
export interface MissionHistoryDelta {
  missionId: string;
  previousRevision: number;
  revision: number;
  headHash: string | null;
  actions: readonly StoredMissionAction[];
  events: readonly MissionEventEnvelope[];
}

export interface MissionCommitDeltaResult {
  receipt: MissionCommitReceipt;
  replayed: boolean;
  delta: MissionHistoryDelta;
}

export interface MissionControllerLease {
  release(): Promise<void>;
}

/** One durable journal candidate discovered during restart enumeration. */
export interface MissionStoreEnumerationEntry {
  /** Trusted durable mission id, or a stable diagnostic identity when the journal cannot yield one. */
  missionId: string;
  /** Candidate-local discovery/replay failure. Other candidates remain independently usable. */
  error?: string;
}

export interface MissionStore {
  /** Enumerate every durable candidate without allowing one corrupt journal to abort discovery. */
  listMissionEntries(): Promise<readonly MissionStoreEnumerationEntry[]>;
  /** Enumerate durable mission identities for restart reconciliation. */
  listMissionIds(): Promise<readonly string[]>;
  /** Acquire the one live control-loop lease for a mission. Writers remain independently usable. */
  acquireController(missionId: string): Promise<MissionControllerLease>;
  load(missionId: string): Promise<MissionHistory>;
  /** Return only records newer than `afterRevision`; the first call normally uses zero. */
  loadSince(missionId: string, afterRevision: number): Promise<MissionHistoryDelta>;
  commit(envelope: MissionActionEnvelope, events: readonly MissionEvent[]): Promise<MissionCommitReceipt>;
  /** Commit and return the authoritative post-CAS history without forcing a third journal replay. */
  commitAndLoad(
    envelope: MissionActionEnvelope,
    events: readonly MissionEvent[],
  ): Promise<MissionCommitResult>;
  /** Atomic commit/CAS plus the authoritative suffix since the caller's last derived state. */
  commitAndLoadSince(
    envelope: MissionActionEnvelope,
    events: readonly MissionEvent[],
    afterRevision: number,
  ): Promise<MissionCommitDeltaResult>;
}

export const MAX_MISSION_ACTION_BYTES = 1024 * 1024;
export const MAX_MISSION_EVENT_BATCH_BYTES = 2 * 1024 * 1024;
// A terminal mission may still need to settle 256 bounded child exits, record write-workspace
// safety evidence, and fulfill 128 cleanup obligations. Keep the hard cap above that emergency
// envelope so ordinary admission can reserve enough bytes for safe shutdown.
export const DEFAULT_MAX_MISSION_JOURNAL_BYTES = 128 * 1024 * 1024;
export const DEFAULT_MAX_MISSION_JOURNAL_ACTIONS = 50_000;

export type MissionConflictKind = 'revision' | 'action';

/** A normal optimistic-concurrency or idempotency refusal, never journal corruption. */
export class MissionStoreConflictError extends Error {
  constructor(
    readonly kind: MissionConflictKind,
    readonly missionId: string,
    message: string,
    readonly expectedRevision?: number,
    readonly actualRevision?: number,
    readonly actionId?: string,
  ) {
    super(message);
    this.name = 'MissionStoreConflictError';
  }
}

/** The caller supplied an action or event that has no stable JSON representation. */
export class InvalidMissionCommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMissionCommitError';
  }
}

/** A complete journal record was malformed or broke the revision/hash/idempotency chain. */
export class MissionJournalCorruptionError extends Error {
  constructor(
    readonly missionId: string,
    readonly line: number,
    message: string,
  ) {
    super(`mission journal ${missionId} is corrupt at line ${line}: ${message}`);
    this.name = 'MissionJournalCorruptionError';
  }
}

/** A healthy journal reached its configured operational bound and requires archival/compaction. */
export class MissionJournalLimitError extends Error {
  override readonly name = 'MissionJournalLimitError';

  constructor(
    readonly missionId: string,
    readonly dimension: 'bytes' | 'actions',
    readonly observed: number,
    readonly limit: number,
  ) {
    super(`mission journal ${missionId} reached its ${dimension} limit (${observed} > ${limit})`);
  }
}

/** Another process held the per-mission writer lock beyond this store's bounded wait. */
export class MissionStoreLockTimeoutError extends Error {
  constructor(
    readonly missionId: string,
    readonly timeoutMs: number,
  ) {
    super(`timed out after ${timeoutMs}ms waiting to write mission ${missionId}`);
    this.name = 'MissionStoreLockTimeoutError';
  }
}

/** Another live process already owns the long-lived control loop for this mission. */
export class MissionControllerBusyError extends Error {
  override readonly name = 'MissionControllerBusyError';

  constructor(
    readonly missionId: string,
    readonly timeoutMs: number,
  ) {
    super(`mission ${missionId} already has a live controller after ${timeoutMs}ms`);
  }
}

function invalidJson(path: string, reason: string): never {
  throw new InvalidMissionCommitError(`${path} ${reason}`);
}

/**
 * JSON with recursively sorted object keys and a deliberately strict input domain. Silent JSON
 * coercions (`undefined` disappearing, `NaN` becoming null, Date invoking `toJSON`) would allow
 * different actions to share one fingerprint, so they are rejected instead.
 */
export function canonicalMissionJson(value: unknown): string {
  const ancestors = new Set<object>();

  const render = (current: unknown, currentPath: string): string => {
    if (current === null) return 'null';
    if (typeof current === 'string' || typeof current === 'boolean') return JSON.stringify(current);
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return invalidJson(currentPath, 'must contain only finite numbers');
      return JSON.stringify(Object.is(current, -0) ? 0 : current);
    }
    if (typeof current !== 'object') {
      return invalidJson(currentPath, `contains unsupported ${typeof current}`);
    }
    if (ancestors.has(current)) return invalidJson(currentPath, 'contains a cycle');

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const values: string[] = [];
        for (let i = 0; i < current.length; i++) {
          if (!Object.hasOwn(current, i)) return invalidJson(`${currentPath}[${i}]`, 'is a sparse slot');
          values.push(render(current[i], `${currentPath}[${i}]`));
        }
        return `[${values.join(',')}]`;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        return invalidJson(currentPath, 'must contain only plain JSON objects');
      }
      if (Object.getOwnPropertySymbols(current).length > 0) {
        return invalidJson(currentPath, 'must not contain symbol keys');
      }

      const source = current as Record<string, unknown>;
      const entries = Object.keys(source)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${render(source[key], `${currentPath}.${key}`)}`);
      return `{${entries.join(',')}}`;
    } finally {
      ancestors.delete(current);
    }
  };

  return render(value, 'value');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** expectedRevision/actionId/missionId are excluded so transport retries fingerprint identically. */
export function missionActionFingerprint(action: MissionAction): string {
  const canonical = canonicalMissionJson(action);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_MISSION_ACTION_BYTES) {
    throw new InvalidMissionCommitError(
      `action exceeds the ${MAX_MISSION_ACTION_BYTES}-byte canonical limit`,
    );
  }
  return sha256(canonical);
}

function requireIdentifier(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024 || value.includes('\0')) {
    throw new InvalidMissionCommitError(`${name} must be a non-empty string of at most 1024 characters`);
  }
}

export function validateMissionId(missionId: string): void {
  requireIdentifier(missionId, 'missionId');
}

/** Validate only identity/action data needed for duplicate admission; events intentionally follow it. */
export function normalizeMissionActionEnvelope(envelope: MissionActionEnvelope): {
  envelope: MissionActionEnvelope;
  fingerprint: string;
} {
  validateMissionId(envelope.missionId);
  requireIdentifier(envelope.actionId, 'actionId');
  if (!Number.isSafeInteger(envelope.expectedRevision) || envelope.expectedRevision < 0) {
    throw new InvalidMissionCommitError('expectedRevision must be a non-negative safe integer');
  }
  const action = parseMissionAction(envelope.action);
  const normalized = {
    missionId: envelope.missionId,
    expectedRevision: envelope.expectedRevision,
    actionId: envelope.actionId,
    action,
  };
  return { envelope: normalized, fingerprint: missionActionFingerprint(action) };
}

export function validateMissionActionEnvelope(envelope: MissionActionEnvelope): string {
  return normalizeMissionActionEnvelope(envelope).fingerprint;
}

type StoredActionWithoutHash = Omit<StoredMissionAction, 'hash'>;

function storedActionHash(action: StoredActionWithoutHash): string {
  return sha256(canonicalMissionJson(action));
}

function validIsoDate(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

/** Build detached protocol envelopes and the exact shared receipt for one accepted action. */
export function createStoredMissionAction(
  envelope: MissionActionEnvelope,
  events: readonly MissionEvent[],
  revision: number,
  previousHash: string | null,
  recordedAt: string,
  actionFingerprint: string = validateMissionActionEnvelope(envelope),
): StoredMissionAction {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new InvalidMissionCommitError('revision must be a positive safe integer');
  }
  if (previousHash !== null && !/^[a-f0-9]{64}$/.test(previousHash)) {
    throw new InvalidMissionCommitError('previousHash must be null or a lowercase SHA-256 digest');
  }
  if (!/^[a-f0-9]{64}$/.test(actionFingerprint)) {
    throw new InvalidMissionCommitError('actionFingerprint must be a lowercase SHA-256 digest');
  }
  if (!validIsoDate(recordedAt)) throw new InvalidMissionCommitError('recordedAt must be an ISO date string');
  if (!Array.isArray(events) || events.length === 0) {
    throw new InvalidMissionCommitError('events must contain at least one event');
  }

  const action = JSON.parse(canonicalMissionJson(envelope.action)) as MissionAction;
  const canonicalEvents = canonicalMissionJson(events);
  if (Buffer.byteLength(canonicalEvents, 'utf8') > MAX_MISSION_EVENT_BATCH_BYTES) {
    throw new InvalidMissionCommitError(
      `event batch exceeds the ${MAX_MISSION_EVENT_BATCH_BYTES}-byte canonical limit`,
    );
  }
  const detachedEvents = (JSON.parse(canonicalEvents) as unknown[]).map((event, ordinal) => {
    try {
      return parseMissionEvent(event);
    } catch (error) {
      throw new InvalidMissionCommitError(
        `events[${ordinal}] is invalid: ${error instanceof Error ? error.message : 'schema mismatch'}`,
      );
    }
  });
  const eventEnvelopes: MissionEventEnvelope[] = detachedEvents.map((event, ordinal) => ({
    missionId: envelope.missionId,
    revision,
    ordinal,
    actionId: envelope.actionId,
    recordedAt,
    event,
  }));
  const receipt: MissionCommitReceipt = {
    missionId: envelope.missionId,
    actionId: envelope.actionId,
    actionFingerprint,
    previousRevision: revision - 1,
    revision,
    eventCount: eventEnvelopes.length,
  };
  const withoutHash: StoredActionWithoutHash = {
    schemaVersion: MISSION_JOURNAL_SCHEMA_VERSION,
    receipt,
    recordedAt,
    previousHash,
    action,
    events: eventEnvelopes,
  };
  return { ...withoutHash, hash: storedActionHash(withoutHash) };
}

function corrupt(missionId: string, line: number, message: string): never {
  throw new MissionJournalCorruptionError(missionId, line, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index])
  );
}

function validateReceipt(
  raw: unknown,
  missionId: string,
  line: number,
  expectedRevision: number,
): MissionCommitReceipt {
  if (!isRecord(raw)) return corrupt(missionId, line, 'receipt is not an object');
  if (
    !hasExactKeys(raw, [
      'missionId',
      'actionId',
      'actionFingerprint',
      'previousRevision',
      'revision',
      'eventCount',
    ])
  ) {
    return corrupt(missionId, line, 'receipt fields do not match schema version 1');
  }
  if (raw.missionId !== missionId) return corrupt(missionId, line, 'receipt missionId does not match file');
  if (
    typeof raw.actionId !== 'string' ||
    raw.actionId.length === 0 ||
    raw.actionId.length > 1_024 ||
    raw.actionId.includes('\0')
  ) {
    return corrupt(missionId, line, 'receipt actionId is invalid');
  }
  if (typeof raw.actionFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(raw.actionFingerprint)) {
    return corrupt(missionId, line, 'receipt actionFingerprint is invalid');
  }
  if (raw.previousRevision !== expectedRevision - 1 || raw.revision !== expectedRevision) {
    return corrupt(missionId, line, `expected revision ${expectedRevision}`);
  }
  if (!Number.isSafeInteger(raw.eventCount) || (raw.eventCount as number) < 1) {
    return corrupt(missionId, line, 'receipt eventCount is invalid');
  }
  return raw as unknown as MissionCommitReceipt;
}

function validateEventEnvelopes(
  raw: unknown,
  receipt: MissionCommitReceipt,
  recordedAt: string,
  missionId: string,
  line: number,
): MissionEventEnvelope[] {
  if (!Array.isArray(raw) || raw.length !== receipt.eventCount) {
    return corrupt(missionId, line, 'event count does not match receipt');
  }
  return raw.map((candidate, ordinal) => {
    if (!isRecord(candidate)) return corrupt(missionId, line, `event ${ordinal} is not an object`);
    if (!hasExactKeys(candidate, ['missionId', 'revision', 'ordinal', 'actionId', 'recordedAt', 'event'])) {
      return corrupt(missionId, line, `event ${ordinal} envelope fields do not match schema version 1`);
    }
    if (
      candidate.missionId !== missionId ||
      candidate.revision !== receipt.revision ||
      candidate.ordinal !== ordinal ||
      candidate.actionId !== receipt.actionId ||
      candidate.recordedAt !== recordedAt
    ) {
      return corrupt(missionId, line, `event ${ordinal} envelope does not match its action batch`);
    }
    let event: MissionEvent;
    try {
      event = parseMissionEvent(candidate.event);
    } catch (err) {
      return corrupt(
        missionId,
        line,
        `event ${ordinal} is invalid: ${err instanceof Error ? err.message : 'schema mismatch'}`,
      );
    }
    return { ...candidate, event } as unknown as MissionEventEnvelope;
  });
}

/** Validate one parsed JSONL record without trusting a TypeScript cast from disk. */
export function parseStoredMissionAction(
  raw: unknown,
  missionId: string,
  line: number,
  expectedRevision: number,
  expectedPreviousHash: string | null,
): StoredMissionAction {
  if (!isRecord(raw)) return corrupt(missionId, line, 'record is not an object');
  if (
    !hasExactKeys(raw, ['schemaVersion', 'receipt', 'recordedAt', 'previousHash', 'action', 'events', 'hash'])
  ) {
    return corrupt(missionId, line, 'record fields do not match schema version 1');
  }
  if (raw.schemaVersion !== MISSION_JOURNAL_SCHEMA_VERSION) {
    return corrupt(missionId, line, `unsupported schemaVersion ${String(raw.schemaVersion)}`);
  }
  if (raw.previousHash !== expectedPreviousHash) {
    return corrupt(missionId, line, 'previousHash does not match prior record');
  }
  if (
    raw.previousHash !== null &&
    (typeof raw.previousHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.previousHash))
  ) {
    return corrupt(missionId, line, 'previousHash is invalid');
  }
  if (typeof raw.recordedAt !== 'string' || !validIsoDate(raw.recordedAt)) {
    return corrupt(missionId, line, 'recordedAt is invalid');
  }
  if (typeof raw.hash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.hash)) {
    return corrupt(missionId, line, 'hash is invalid');
  }

  const receipt = validateReceipt(raw.receipt, missionId, line, expectedRevision);
  let action: MissionAction;
  try {
    action = parseMissionAction(raw.action);
  } catch (err) {
    return corrupt(missionId, line, err instanceof Error ? err.message : 'action is invalid');
  }
  let actualFingerprint: string;
  try {
    actualFingerprint = missionActionFingerprint(action);
  } catch (err) {
    return corrupt(missionId, line, err instanceof Error ? err.message : 'action is invalid');
  }
  if (receipt.actionFingerprint !== actualFingerprint) {
    return corrupt(missionId, line, 'actionFingerprint does not match action');
  }
  const events = validateEventEnvelopes(raw.events, receipt, raw.recordedAt, missionId, line);

  let actualHash: string;
  try {
    const { hash: _hash, ...withoutHash } = raw;
    actualHash = storedActionHash(withoutHash as StoredActionWithoutHash);
  } catch (err) {
    return corrupt(missionId, line, err instanceof Error ? err.message : 'record is not canonical JSON');
  }
  if (raw.hash !== actualHash) return corrupt(missionId, line, 'hash does not match record');
  return {
    schemaVersion: MISSION_JOURNAL_SCHEMA_VERSION,
    receipt,
    recordedAt: raw.recordedAt,
    previousHash: raw.previousHash as string | null,
    action,
    events,
    hash: raw.hash,
  };
}

export function emptyMissionHistory(missionId: string): MissionHistory {
  validateMissionId(missionId);
  return { missionId, revision: 0, headHash: null, actions: [], events: [] };
}

/** Replay complete JSONL lines; the file adapter excludes an unterminated crash tail first. */
export function replayMissionJournal(missionId: string, lines: readonly string[]): MissionHistory {
  validateMissionId(missionId);
  const actions: StoredMissionAction[] = [];
  const actionIds = new Set<string>();
  let previousHash: string | null = null;

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const text = lines[index]!;
    if (text.length === 0) corrupt(missionId, lineNumber, 'blank complete line');
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      corrupt(missionId, lineNumber, 'invalid JSON');
    }
    const action: StoredMissionAction = parseStoredMissionAction(
      raw,
      missionId,
      lineNumber,
      lineNumber,
      previousHash,
    );
    if (actionIds.has(action.receipt.actionId)) {
      corrupt(missionId, lineNumber, 'actionId appears more than once');
    }
    actionIds.add(action.receipt.actionId);
    actions.push(action);
    previousHash = action.hash;
  }

  return {
    missionId,
    revision: actions.length,
    headHash: previousHash,
    actions,
    events: actions.flatMap((action) => action.events),
  };
}

/** Duplicate lookup deliberately precedes expectedRevision, including changed-action conflicts. */
export function admitMissionAction(
  history: MissionHistory,
  envelope: MissionActionEnvelope,
  actionFingerprint: string = validateMissionActionEnvelope(envelope),
): MissionCommitReceipt | null {
  if (history.missionId !== envelope.missionId) {
    throw new InvalidMissionCommitError('action missionId does not match loaded history');
  }
  const prior = history.actions.find((action) => action.receipt.actionId === envelope.actionId)?.receipt;
  return admitMissionActionAtHead(history.missionId, history.revision, prior, envelope, actionFingerprint);
}

/** O(1) duplicate/CAS admission for stores and kernels that maintain an action-id receipt index. */
export function admitMissionActionAtHead(
  missionId: string,
  revision: number,
  prior: MissionCommitReceipt | undefined,
  envelope: MissionActionEnvelope,
  actionFingerprint: string = validateMissionActionEnvelope(envelope),
): MissionCommitReceipt | null {
  if (missionId !== envelope.missionId) {
    throw new InvalidMissionCommitError('action missionId does not match loaded history');
  }
  if (prior) {
    if (prior.actionFingerprint === actionFingerprint) return prior;
    throw new MissionStoreConflictError(
      'action',
      envelope.missionId,
      `action ${envelope.actionId} was already committed with a different fingerprint`,
      undefined,
      revision,
      envelope.actionId,
    );
  }
  if (envelope.expectedRevision !== revision) {
    throw new MissionStoreConflictError(
      'revision',
      envelope.missionId,
      `expected mission revision ${envelope.expectedRevision}, found ${revision}`,
      envelope.expectedRevision,
      revision,
      envelope.actionId,
    );
  }
  return null;
}

export function cloneMissionReceipt(receipt: MissionCommitReceipt): MissionCommitReceipt {
  return JSON.parse(canonicalMissionJson(receipt)) as MissionCommitReceipt;
}

export function cloneStoredMissionAction(action: StoredMissionAction): StoredMissionAction {
  return JSON.parse(canonicalMissionJson(action)) as StoredMissionAction;
}

export function cloneMissionHistory(history: MissionHistory): MissionHistory {
  const actions = history.actions.map(cloneStoredMissionAction);
  return {
    missionId: history.missionId,
    revision: history.revision,
    headHash: history.headHash,
    actions,
    events: actions.flatMap((action) => action.events),
  };
}

export function missionHistoryDelta(history: MissionHistory, afterRevision: number): MissionHistoryDelta {
  if (!Number.isSafeInteger(afterRevision) || afterRevision < 0 || afterRevision > history.revision) {
    throw new InvalidMissionCommitError(
      `afterRevision must be between zero and mission revision ${history.revision}`,
    );
  }
  const actions = history.actions.slice(afterRevision).map(cloneStoredMissionAction);
  return {
    missionId: history.missionId,
    previousRevision: afterRevision,
    revision: history.revision,
    headHash: history.headHash,
    actions,
    events: actions.flatMap((action) => action.events),
  };
}
