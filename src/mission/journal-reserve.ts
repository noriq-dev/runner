import {
  type MissionState,
  childIsTerminal,
  missionChildrenInOrder,
  workspaceReconciliationForChild,
} from './model';

/**
 * Conservative future journal capacity needed to settle every effect already authorized by
 * `state`, terminalize it, discharge each cleanup obligation once, and preserve a successful
 * handoff. Outcome-dependent child evidence reserves the largest supported settlement tail.
 *
 * This is deliberately state-derived rather than a shared "emergency" bucket. A start action may
 * not consume the slot needed for its result, and a failed cleanup retry may not consume the slot
 * needed for a later successful cleanup. The count does not promise unbounded retries; it preserves
 * one settlement for every currently durable obligation.
 */
export function requiredMissionSettlementActions(state: MissionState): number {
  if (state.status === 'uninitialized') return 0;

  // A running guide still owes its metered completion and then one deterministic follow-on:
  // either apply the durable proposal or replace the unusable turn. Once completion is durable,
  // the current proposed/failed turn still owes that follow-on. Older turns from a prior epoch
  // are historical facts and need no further action.
  let required = Object.values(state.guideTurns).filter((turn) => turn.status === 'running').length;
  const latestTurnId = state.guideTurnOrder.at(-1);
  const latestTurn = latestTurnId ? state.guideTurns[latestTurnId] : undefined;
  if (
    latestTurn?.guideEpoch === state.guideEpoch &&
    ['running', 'proposed', 'failed', 'cancelled', 'lost'].includes(latestTurn.status)
  ) {
    required += 1;
  }

  for (const child of missionChildrenInOrder(state)) {
    // Reserving a child authorizes its attempt. The durable start is therefore settlement of an
    // existing obligation, not optional new work, and must itself retain the later result/evidence
    // tail. A cancelling child may have been terminalized before start and does not owe this step.
    if (child.status === 'reserved') required += 1; // start-child

    if (!childIsTerminal(child.status)) {
      required += 1; // complete-child
      if (child.permission === 'write') {
        // A successful writer is checkpointed first. The protocol permits that checkpoint to be
        // dirty, in which case one further workspace-reconciled fact is mandatory. Failed,
        // cancelled, and lost writers use only the latter slot, but reserve the larger supported
        // success tail until the outcome is known.
        required += 2;
      } else if (child.subjectCheckpointId !== null) {
        // A successful review still owes its exact, independently attributed review fact.
        required += 1;
      }
      continue;
    }

    if (child.permission === 'write') {
      if (workspaceReconciliationForChild(state, child) !== null) continue;
      const authoredCheckpoint = Object.values(state.checkpoints).find(
        (checkpoint) => checkpoint.authorChildId === child.childId,
      );
      // A successful writer without its checkpoint may need both the checkpoint and the explicit
      // reconciliation that follows a dirty result. Other terminal writers reconcile directly.
      required += child.status === 'succeeded' && !authoredCheckpoint ? 2 : 1;
      continue;
    }

    if (
      child.status === 'succeeded' &&
      child.subjectCheckpointId !== null &&
      !Object.values(state.reviews).some(
        (review) =>
          review.reviewerChildId === child.childId && review.checkpointId === child.subjectCheckpointId,
      )
    ) {
      required += 1; // record-review
    }
  }

  if (state.activeValidation) required += 1;
  required += Object.values(state.questions).filter((question) => question.status === 'pending').length;
  if (!state.terminal) required += 1;

  required += state.cleanupPlan.filter(
    (cleanupId) => state.cleanup[cleanupId]?.status !== 'completed',
  ).length;

  if (state.terminal?.outcome === 'succeeded') {
    if (state.terminal.checkpointId !== null && state.acceptedRevisionHandoff === null) required += 1;
  } else if (!state.terminal) {
    // Preserve the ability to expose a revision if the still-active mission eventually succeeds.
    required += 1;
  }

  return required;
}
