import { z } from 'zod';

// ---------------------------------------------------------------------------
// Core entities (ROADMAP §4). These schemas are the single source of truth:
// they validate MCP tool inputs, REST bodies, and type the web app.
// ---------------------------------------------------------------------------

export const TaskStatus = z.enum([
  'todo',
  'claimed',
  'in_progress',
  'blocked',
  'review',
  'done',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const AgentRole = z.enum(['orchestrator', 'worker']);
export type AgentRole = z.infer<typeof AgentRole>;

export const AgentStatus = z.enum(['active', 'idle', 'offline', 'revoked']);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const CommentKind = z.enum(['comment', 'question', 'instruction', 'reply']);
export type CommentKind = z.infer<typeof CommentKind>;

export const CommentStatus = z.enum(['open', 'acknowledged', 'addressed', 'wont_do']);
export type CommentStatus = z.infer<typeof CommentStatus>;

export const ActorKind = z.enum(['agent', 'human', 'system']);
export type ActorKind = z.infer<typeof ActorKind>;

/** Which sort of agent (RUN-43 / migration 0026). Distinct from ActorKind above: that one
 *  answers "agent, human, or system?"; this one answers "which sort of agent?" for a row
 *  that is already an agent. */
export const AgentKind = z.enum(['copilot', 'agent']);
export type AgentKind = z.infer<typeof AgentKind>;

export const Agent = z.object({
  id: z.string(),
  name: z.string().min(1),
  /** copilot = a human's Claude Code / Codex session: self-created at MCP initialize, may
   *  hop projects, heartbeat is meaningless (a human is right there). agent = spawned by a
   *  runner for exactly one run: runner-owned, pinned to one project for life, heartbeat is
   *  the liveness signal that matters. */
  kind: AgentKind,
  role: AgentRole,
  status: AgentStatus,
  /** The runner that created it and owns its lifecycle. Non-null iff kind='agent' — the DB
   *  enforces that pairing with a CHECK, so it is not merely a convention here. */
  runnerId: z.string().nullable().default(null),
  lastSeenAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type Agent = z.infer<typeof Agent>;
// `scopes` lived here mirroring a column that took its '[]' default and was named in no
// query anywhere — retired with the column in 0026, alongside api_key_hash.

export const Project = z.object({
  id: z.string(),
  key: z.string().min(1).max(8), // short prefix for task keys, e.g. "PLN"
  name: z.string().min(1),
  description: z.string().default(''),
  status: z.enum(['active', 'archived']),
  repoUrl: z.string().url().nullable(),
  defaultBranch: z.string().nullable(),
  claimTtlSeconds: z.number().int().positive().default(300),
  heartbeatSeconds: z.number().int().positive().default(60),
  createdAt: z.string().datetime(),
});
export type Project = z.infer<typeof Project>;

export const Milestone = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string().min(1),
  dueAt: z.string().datetime().nullable(),
  order: z.number().int(),
  closedAt: z.string().datetime().nullable(),
});
export type Milestone = z.infer<typeof Milestone>;

export const Task = z.object({
  id: z.string(),
  projectId: z.string(),
  key: z.string(), // e.g. "PLN-142"
  milestoneId: z.string().nullable(),
  parentTaskId: z.string().nullable(),
  title: z.string().min(1),
  body: z.string().default(''),
  status: TaskStatus,
  priority: z.number().int().min(0).max(4).default(2),
  estimate: z.number().nullable(),
  claimedBy: z.string().nullable(),
  claimExpiresAt: z.string().datetime().nullable(),
  openComments: z.number().int().nonnegative().default(0),
  order: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Task = z.infer<typeof Task>;

export const Dependency = z.object({
  taskId: z.string(),
  dependsOnTaskId: z.string(),
});
export type Dependency = z.infer<typeof Dependency>;

export const Claim = z.object({
  id: z.string(),
  taskId: z.string(),
  agentId: z.string(),
  acquiredAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  releasedAt: z.string().datetime().nullable(),
});
export type Claim = z.infer<typeof Claim>;

export const Comment = z.object({
  id: z.string(),
  taskId: z.string(),
  authorKind: ActorKind,
  authorId: z.string(), // agent id, or user id for humans
  kind: CommentKind,
  body: z.string().min(1),
  status: CommentStatus,
  resolvedBy: z.string().nullable(),
  parentCommentId: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type Comment = z.infer<typeof Comment>;

export const Message = z.object({
  id: z.string(),
  projectId: z.string(),
  fromAgentId: z.string(),
  toAgentId: z.string().nullable(), // null = broadcast
  body: z.string().min(1),
  refTaskId: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type Message = z.infer<typeof Message>;
