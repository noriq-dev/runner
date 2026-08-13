import { type MissionDecisionRefused, decideMission } from './decide';
import { type MissionState, initialMissionState } from './model';
import type { MissionActionEnvelope, MissionCommitReceipt } from './protocol';
import { reduceMissionFrom } from './reducer';
import {
  type MissionHistoryDelta,
  type MissionStore,
  MissionStoreConflictError,
  admitMissionActionAtHead,
  cloneMissionReceipt,
  normalizeMissionActionEnvelope,
} from './store';

export interface MissionDispatchAccepted {
  accepted: true;
  /** True only when the action was already durable and no events were appended. */
  replayed: boolean;
  receipt: MissionCommitReceipt;
  state: MissionState;
}

export interface MissionDispatchRefused extends MissionDecisionRefused {
  state: MissionState;
}

export type MissionDispatchResult = MissionDispatchAccepted | MissionDispatchRefused;

interface MissionKernelCache {
  state: MissionState;
  receipts: Map<string, MissionCommitReceipt>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * The model-free authority around one journal. Models never call the store directly: this layer
 * performs duplicate admission before state-dependent validation, decides facts, then relies on
 * the store's compare-and-swap to close the concurrent-writer race.
 */
export class MissionKernel {
  private readonly cache = new Map<string, MissionKernelCache>();

  constructor(private readonly store: MissionStore) {}

  async inspect(missionId: string): Promise<MissionState> {
    return (await this.synchronize(missionId)).state;
  }

  private applyDelta(current: MissionKernelCache, delta: MissionHistoryDelta): MissionKernelCache {
    if (delta.previousRevision !== current.state.revision) {
      throw new MissionStoreConflictError(
        'revision',
        delta.missionId,
        `kernel cache expected delta after revision ${current.state.revision}, got ${delta.previousRevision}`,
        current.state.revision,
        delta.previousRevision,
      );
    }
    for (const action of delta.actions) {
      current.receipts.set(action.receipt.actionId, action.receipt);
    }
    const state = deepFreeze(reduceMissionFrom(current.state, delta.events));
    if (state.revision !== delta.revision) {
      throw new Error(
        `mission ${delta.missionId} delta ended at revision ${delta.revision}, derived ${state.revision}`,
      );
    }
    const updated = { state, receipts: current.receipts };
    this.cache.set(delta.missionId, updated);
    return updated;
  }

  private async synchronize(missionId: string): Promise<MissionKernelCache> {
    const current =
      this.cache.get(missionId) ??
      ({
        state: deepFreeze(initialMissionState(missionId)),
        receipts: new Map(),
      } satisfies MissionKernelCache);
    const delta = await this.store.loadSince(missionId, current.state.revision);
    return this.applyDelta(current, delta);
  }

  async dispatch(envelope: MissionActionEnvelope): Promise<MissionDispatchResult> {
    const normalized = normalizeMissionActionEnvelope(envelope);
    const admittedEnvelope = normalized.envelope;
    const fingerprint = normalized.fingerprint;
    const current = await this.synchronize(admittedEnvelope.missionId);

    // This ordering is part of the public retry contract: an action that committed before a
    // response was lost succeeds again even when its expected revision is now stale.
    const duplicate = admitMissionActionAtHead(
      admittedEnvelope.missionId,
      current.state.revision,
      current.receipts.get(admittedEnvelope.actionId),
      admittedEnvelope,
      fingerprint,
    );
    if (duplicate) {
      return {
        accepted: true,
        replayed: true,
        receipt: cloneMissionReceipt(duplicate),
        state: current.state,
      };
    }

    const before = current.state;
    const decision = decideMission(before, admittedEnvelope.action);
    if (!decision.accepted) return { ...decision, state: before };

    const committed = await this.store.commitAndLoadSince(admittedEnvelope, decision.events, before.revision);
    const updated = this.applyDelta(current, committed.delta);
    return {
      accepted: true,
      replayed: committed.replayed,
      receipt: committed.receipt,
      state: updated.state,
    };
  }
}
