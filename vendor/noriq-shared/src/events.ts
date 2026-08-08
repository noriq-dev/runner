import { z } from 'zod';
import { ActorKind } from './model';

// ---------------------------------------------------------------------------
// Append-only event log (ROADMAP §4). Every mutation emits one of these; the
// ProjectRoom DO persists it to D1 and fans it out over WebSocket to the UI
// and subscribed agents.
// ---------------------------------------------------------------------------

export const EventVerb = z.enum([
  'project.created',
  'project.updated',
  'milestone.created',
  'milestone.updated',
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
  'task.claim_expired',
  'task.requeued',
  'dependency.added',
  'dependency.removed',
  // A task's LAST unfinished blocker settled from another project (PLNR-241). Same-project
  // unblocking is already visible as the blocker's own task.status_changed in this room's
  // feed; a cross-project blocker settles in a different room, so the dependent's project
  // needs its own event or its board never hears.
  'dependency.unblocked',
  'comment.posted',
  'comment.acknowledged',
  'comment.resolved',
  'message.sent',
  'agent.registered',
  'agent.online',
  'agent.offline',
  // Run lifecycle (execution plane) — authoritative in ProjectRoom (RUN-6).
  'run.created',
  'run.dispatched',
  'run.status_changed',
  // ProjectMemory's outbox delivered a canonical mutation into this project's event stream
  // (PLNR-247). One compact verb for every memory change — kind/authority/etc. ride the
  // payload's summary, never the memory body itself (§3/§4: D1 never holds memory content).
  // Delivered as actorKind 'system', not 'agent' — it must never renew a claim or presence.
  'memory.changed',
]);
export type EventVerb = z.infer<typeof EventVerb>;

export const NoriqEvent = z.object({
  id: z.string(),
  projectId: z.string(),
  seq: z.number().int(), // monotonic per project — ordering + resume cursor
  actorKind: ActorKind,
  actorId: z.string(),
  verb: EventVerb,
  subjectType: z.enum(['project', 'milestone', 'task', 'comment', 'message', 'agent', 'run', 'memory']),
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
