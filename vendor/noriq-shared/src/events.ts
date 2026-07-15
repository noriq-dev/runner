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
  'task.claimed',
  'task.released',
  'task.claim_expired',
  'task.requeued',
  'dependency.added',
  'dependency.removed',
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
]);
export type EventVerb = z.infer<typeof EventVerb>;

export const NoriqEvent = z.object({
  id: z.string(),
  projectId: z.string(),
  seq: z.number().int(), // monotonic per project — ordering + resume cursor
  actorKind: ActorKind,
  actorId: z.string(),
  verb: EventVerb,
  subjectType: z.enum(['project', 'milestone', 'task', 'comment', 'message', 'agent', 'run']),
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
