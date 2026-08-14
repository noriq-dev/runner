import { z } from 'zod';
import { ActorKind } from './model';

// ---------------------------------------------------------------------------
// Append-only event log (ROADMAP §4). Every mutation emits one of these; the
// ProjectRoom DO persists it to D1 and fans it out over WebSocket to the UI
// and subscribed agents.
// ---------------------------------------------------------------------------

// PLNR-318: this list is derived from ProjectRoom's actual `this.emit(...)` call sites, not
// curated — the enum is the contract `emit()` is typed against (see ProjectRoom.emit's `verb:
// EventVerb` parameter), so a verb that isn't emitted anywhere has no reason to be here. Five
// prior members were confirmed dead (nothing in the repo ever emits them) and were dropped
// rather than kept for cosmetic completeness: `project.created`, `task.claim_expired`,
// `agent.registered`, `agent.online`, `agent.offline`. `agent.registered` was already flagged
// unreachable in memory/projection.ts before this pass.
export const EventVerb = z.enum([
  'project.updated',
  'milestone.created',
  'milestone.updated',
  'milestone.deleted',
  'task.created',
  'task.updated',
  'task.status_changed',
  // The execution SPEC changed (RUN-162), distinguished from `task.updated` on purpose: a spec is
  // the contract a build is judged against, so "somebody edited this task" and "somebody moved the
  // goalposts" are different facts and a reviewer needs to be able to see the second one without
  // reading every edit. Carries a before/after summary, never the specs themselves — the event log
  // is a record of what happened, not a second copy of the data.
  'task.spec_changed',
  'task.claimed',
  'task.released',
  'task.requeued',
  'task.deleted',
  'task.moved',
  'task.moved_in',
  'task.handed_off',
  // Spin-offs (PLNR-230): a run filed adjacent work as its own PROPOSED task; a human then
  // accepts or rejects it.
  'task.spun_off',
  'task.spinoff_accepted',
  'task.spinoff_rejected',
  'task.proposed',
  'task.proposal_accepted',
  'task.proposal_rejected',
  'task.archived',
  'task.restored',
  'task.settle_skipped',
  'dependency.added',
  'dependency.removed',
  // A task's LAST unfinished blocker settled from another project (PLNR-241). Same-project
  // unblocking is already visible as the blocker's own task.status_changed in this room's
  // feed; a cross-project blocker settles in a different room, so the dependent's project
  // needs its own event or its board never hears.
  'dependency.unblocked',
  // Coordination edges the projector could not previously draw at all (PLNR-319): a
  // `plan.created`/`update_plan` event carries phase task COUNTS, not ids, and there was no
  // event at all for "this task joined/left a plan phase" or "this doc was attached to/detached
  // from a task" — `rebuildProjection`'s live D1 read was the only source of these `related_to`
  // edges. Both pairs carry a `links` ARRAY in one payload (never one event per link — a plan
  // created with forty tasks must not serialize forty of these) with both endpoint ids and,
  // where the writer already has them in hand, both labels.
  'plan.tasks_linked',
  'plan.tasks_unlinked',
  'task.docs_linked',
  'task.docs_unlinked',
  'comment.posted',
  'comment.acknowledged',
  'comment.resolved',
  'message.sent',
  // Run lifecycle (execution plane) — authoritative in ProjectRoom (RUN-6).
  'run.created',
  'run.dispatched',
  'run.status_changed',
  'run.handoff_preserved',
  'run.handoff_consumed',
  'runner_job.created',
  'runner_job.status_changed',
  // ProjectMemory's outbox delivered a canonical mutation into this project's event stream
  // (PLNR-247). One compact verb for every memory change — kind/authority/etc. ride the
  // payload's summary, never the memory body itself (§3/§4: D1 never holds memory content).
  // Delivered as actorKind 'system', not 'agent' — it must never renew a claim or presence.
  'memory.changed',
  'tag.created',
  'tag.deleted',
  'tag.merged',
  'lock.acquired',
  'lock.denied',
  'lock.released',
  'lock.renewed',
  'lock.force_released',
  'lock.expired',
  'signal.raised',
  'signal.answered',
  'signal.acknowledged',
  'board.created',
  'board.updated',
  'board.deleted',
  'doc.created',
  'doc.updated',
  'doc.deleted',
  'plan.created',
  'plan.updated',
  'plan.approved',
  'plan.rejected',
  'plan.completed',
  'plan.archived',
  'plan.restored',
  'plan.deleted',
  'plan_doc.created',
  'plan_doc.updated',
  'plan_doc.deleted',
  'plan_dispatch.created',
  'plan_dispatch.cancelled',
  'plan_dispatch.completed',
  'plan_dispatch.resumed',
  'plan_dispatch.stalled',
  'attachment.added',
  'attachment.removed',
  'ref.attached',
  // An explicit append-only downstream quality observation was recorded. The payload is a
  // compact identity summary, never an assertion of blame or a rewrite of an episode.
  'quality.event_recorded',
  'quality.event_rejected',
]);
export type EventVerb = z.infer<typeof EventVerb>;

// PLNR-318: widened alongside EventVerb — derived from the subjectType literal actually passed
// at each `this.emit(...)` call site. `agent` was dropped: it rode only the now-removed dead
// agent.* verbs, and nothing in the repo ever emits a subjectType of `agent`. `memory` covers
// ProjectMemory's outbox delivery (subjectType is always `'memory'` there — see
// ProjectRoom.receiveMemoryEvent).
export const EventSubjectType = z.enum([
  'project', 'milestone', 'task', 'comment', 'message', 'run', 'memory',
  'tag', 'lock', 'board', 'doc', 'plan', 'plan_dispatch', 'plan_doc', 'runner_job',
]);
export type EventSubjectType = z.infer<typeof EventSubjectType>;

export const NoriqEvent = z.object({
  id: z.string(),
  projectId: z.string(),
  seq: z.number().int(), // monotonic per project — ordering + resume cursor
  actorKind: ActorKind,
  actorId: z.string(),
  verb: EventVerb,
  subjectType: EventSubjectType,
  subjectId: z.string(),
  payload: z.record(z.string(), z.unknown()).default({}), // zod v4: record requires an explicit key type
  createdAt: z.string().datetime(),
});
export type NoriqEvent = z.infer<typeof NoriqEvent>;

// WebSocket protocol: client → server
export const WsClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), projectId: z.string(), sinceSeq: z.number().int().optional() }),
  z.object({ type: z.literal('ping') }),
]);
export type WsClientMessage = z.infer<typeof WsClientMessage>;

// WebSocket protocol: server → client
export const WsServerMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), event: NoriqEvent }),
  z.object({ type: z.literal('backlog'), events: z.array(NoriqEvent) }),
  z.object({ type: z.literal('pong') }),
]);
export type WsServerMessage = z.infer<typeof WsServerMessage>;
