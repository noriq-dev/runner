import { requiredMissionSettlementActions } from './journal-reserve';
import type { MissionActionEnvelope, MissionCommitReceipt, MissionEvent } from './protocol';
import { reduceMission, reduceMissionFrom } from './reducer';
import {
  DEFAULT_MAX_MISSION_JOURNAL_ACTIONS,
  type MissionCommitDeltaResult,
  type MissionCommitResult,
  MissionControllerBusyError,
  type MissionControllerLease,
  type MissionHistory,
  type MissionHistoryDelta,
  MissionJournalLimitError,
  type MissionStore,
  type MissionStoreEnumerationEntry,
  admitMissionActionAtHead,
  cloneMissionHistory,
  cloneMissionReceipt,
  createStoredMissionAction,
  emptyMissionHistory,
  missionHistoryDelta,
  normalizeMissionActionEnvelope,
  validateMissionId,
} from './store';

export interface MemoryMissionStoreOptions {
  now?: () => Date;
  maxJournalActions?: number;
  emergencyReserveActions?: number;
}

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

/**
 * Model-free store used by kernel tests and embedders that do not need restart survival. It keeps
 * the exact admission ordering and detached-receipt semantics of JsonlMissionStore so swapping the
 * persistence adapter cannot change orchestration behaviour.
 */
export class MemoryMissionStore implements MissionStore {
  private readonly histories = new Map<string, MissionHistory>();
  private readonly receipts = new Map<string, Map<string, MissionCommitReceipt>>();
  private readonly controlled = new Set<string>();
  private readonly now: () => Date;
  private readonly maxJournalActions: number;
  private readonly emergencyReserveActions: number;

  constructor(options: MemoryMissionStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.maxJournalActions = options.maxJournalActions ?? DEFAULT_MAX_MISSION_JOURNAL_ACTIONS;
    if (!Number.isSafeInteger(this.maxJournalActions) || this.maxJournalActions < 1) {
      throw new TypeError('maxJournalActions must be a positive safe integer');
    }
    this.emergencyReserveActions = Math.min(
      options.emergencyReserveActions ?? 1_536,
      Math.max(0, this.maxJournalActions - 1),
    );
    if (!Number.isSafeInteger(this.emergencyReserveActions) || this.emergencyReserveActions < 0) {
      throw new TypeError('emergencyReserveActions must be a non-negative safe integer');
    }
  }

  async listMissionIds(): Promise<readonly string[]> {
    return [...this.histories.keys()].sort();
  }

  async listMissionEntries(): Promise<readonly MissionStoreEnumerationEntry[]> {
    return (await this.listMissionIds()).map((missionId) => ({ missionId }));
  }

  async acquireController(missionId: string): Promise<MissionControllerLease> {
    validateMissionId(missionId);
    if (this.controlled.has(missionId)) throw new MissionControllerBusyError(missionId, 0);
    this.controlled.add(missionId);
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        this.controlled.delete(missionId);
      },
    };
  }

  async load(missionId: string): Promise<MissionHistory> {
    return cloneMissionHistory(this.histories.get(missionId) ?? emptyMissionHistory(missionId));
  }

  async loadSince(missionId: string, afterRevision: number): Promise<MissionHistoryDelta> {
    return missionHistoryDelta(
      this.histories.get(missionId) ?? emptyMissionHistory(missionId),
      afterRevision,
    );
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
      history: await this.load(envelope.missionId),
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
    const history =
      this.histories.get(admittedEnvelope.missionId) ?? emptyMissionHistory(admittedEnvelope.missionId);
    const receiptIndex = this.receipts.get(admittedEnvelope.missionId) ?? new Map();
    const duplicate = admitMissionActionAtHead(
      history.missionId,
      history.revision,
      receiptIndex.get(admittedEnvelope.actionId),
      admittedEnvelope,
      actionFingerprint,
    );
    if (duplicate) {
      return {
        receipt: cloneMissionReceipt(duplicate),
        replayed: true,
        delta: missionHistoryDelta(history, afterRevision),
      };
    }
    const action = createStoredMissionAction(
      admittedEnvelope,
      events,
      history.revision + 1,
      history.headHash,
      this.now().toISOString(),
      actionFingerprint,
    );
    const prospectiveState = reduceMissionFrom(
      reduceMission(history.missionId, history.events),
      action.events,
    );
    const settlementLimit = this.maxJournalActions - requiredMissionSettlementActions(prospectiveState);
    const classLimit = EMERGENCY_ACTIONS.has(admittedEnvelope.action.type)
      ? this.maxJournalActions
      : this.maxJournalActions - this.emergencyReserveActions;
    const actionLimit = Math.min(classLimit, settlementLimit);
    if (history.actions.length >= actionLimit) {
      throw new MissionJournalLimitError(
        admittedEnvelope.missionId,
        'actions',
        history.actions.length + 1,
        actionLimit,
      );
    }

    const actions = history.actions as Array<(typeof history.actions)[number]>;
    const eventEnvelopes = history.events as Array<(typeof history.events)[number]>;
    actions.push(action);
    eventEnvelopes.push(...action.events);
    const nextHistory: MissionHistory = {
      missionId: admittedEnvelope.missionId,
      revision: action.receipt.revision,
      headHash: action.hash,
      actions,
      events: eventEnvelopes,
    };
    this.histories.set(admittedEnvelope.missionId, nextHistory);
    receiptIndex.set(action.receipt.actionId, action.receipt);
    this.receipts.set(admittedEnvelope.missionId, receiptIndex);
    return {
      receipt: cloneMissionReceipt(action.receipt),
      replayed: false,
      delta: missionHistoryDelta(nextHistory, afterRevision),
    };
  }
}
