import { z } from 'zod';

// ---------------------------------------------------------------------------
// Noriq Runner — the execution plane (RUN plan, Phase 1). Runtime-neutral zod:
// no Worker/CF or Node globals — this slice is imported by the Worker (server),
// the local daemon, AND the web UI, so it must stay pure. These two entities are
// the core of the wire contract; the /ws/runner channel + steering/dispatch/ack
// shapes live in ./ws, the on-disk manifests in ./manifest.
// ---------------------------------------------------------------------------

// A Run is one supervised agent process. Three kinds share one substrate,
// differing only by assembled prompt + repo permission:
//   scope  — orchestrator, read-only: brief → explores → emits a *proposed* plan
//   build  — worker, read-write worktree: approved task/plan → diff → review
//   verify — fresh adversarial actor: phase diff + specs → gate review→done
export const RunKind = z.enum(['scope', 'build', 'verify']);
export type RunKind = z.infer<typeof RunKind>;

// Which coding-agent CLI drives the process. One driver interface, two backends.
export const AgentTool = z.enum(['claude', 'codex']);
export type AgentTool = z.infer<typeof AgentTool>;

// Run lifecycle: queued → dispatched → running → (blocked ⇄ running) → terminal.
// terminal ∈ {done, failed, cancelled}. `blocked` = agent parked on request_input.
export const RunStatus = z.enum([
  'queued', // created server-side, not yet handed to a runner
  'dispatched', // sent to a runner over /ws/runner, process not yet up
  'running', // agent process live
  'blocked', // parked awaiting a human decision (request_input); resumable → running
  'done', // completed; artifact landed (proposed plan / review diff / verify verdict)
  'failed', // process error, budget breach, or verify gate rejection
  'cancelled', // killed by a human
]);
export type RunStatus = z.infer<typeof RunStatus>;

const TERMINAL_RUN_STATUSES = ['done', 'failed', 'cancelled'] as const;
export const isTerminalRunStatus = (s: RunStatus): boolean =>
  (TERMINAL_RUN_STATUSES as readonly string[]).includes(s);

// What the Run is anchored to. A pure-brief dispatch has no anchor (null) — the
// agent's first act may be to *emit* the tasks/plan a human then approves.
export const RunAnchor = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('task'), taskId: z.string() }),
    z.object({ type: z.literal('plan'), planId: z.string() }),
  ])
  .nullable();
export type RunAnchor = z.infer<typeof RunAnchor>;

// Daemon-enforced ceilings (SIGTERM on breach). All optional — an unset field
// means "no limit from the Run"; the machine config may still impose a floor.
export const RunBudget = z.object({
  maxTokens: z.number().int().positive().nullable().default(null),
  maxUsd: z.number().positive().nullable().default(null),
  maxDurationSeconds: z.number().int().positive().nullable().default(null),
});
export type RunBudget = z.infer<typeof RunBudget>;

// Terminal outcome detail, set when the Run reaches done|failed|cancelled.
export const RunExit = z.object({
  outcome: z.enum(['done', 'failed', 'cancelled']),
  code: z.number().int().nullable().default(null), // process exit code, if any
  signal: z.string().nullable().default(null), // e.g. "SIGTERM" on budget breach
  reason: z.string().nullable().default(null), // human-readable cause
  finishedAt: z.string().datetime(),
});
export type RunExit = z.infer<typeof RunExit>;

export const Run = z.object({
  id: z.string(),
  projectId: z.string(),
  runnerId: z.string().nullable().default(null), // which runner owns it; null while queued
  // The spawned agent is its own project-local Noriq actor (parentAgentId = the
  // daemon). Null until the process registers; the daemon supervises the
  // *process*, the agent reports its *work* via its own MCP calls.
  agentId: z.string().nullable().default(null),
  kind: RunKind,
  anchor: RunAnchor,
  // VERIFY runs only: the BUILD run whose diff this one judges. The daemon branches the
  // verifier's worktree from that run's branch — without it the verifier gets a pristine
  // HEAD checkout, the `git diff` its prompt tells it to inspect is empty, and its verdict
  // is about nothing. Distinct from `anchor`, which stays the TASK: that is where findings
  // are posted, so a verify run needs both.
  verifiesRunId: z.string().nullable().default(null),
  brief: z.string().default(''), // the dispatch intent; may be empty for anchored runs
  repoRef: z.string(), // id of a RunnerRepo advertised by the owning runner
  agentTool: AgentTool,
  budget: RunBudget,
  status: RunStatus,
  exit: RunExit.nullable().default(null),
  // The daemon's isolated git worktree for this Run (branch noriq/run/<id>),
  // reported once the process starts so the server/dashboard can see where the
  // work is happening (and the verify agent can reference the checkout). Machine-
  // local path; null until the daemon reports it.
  worktreePath: z.string().nullable().default(null),
  // Provenance + lifecycle timestamps.
  createdBy: z.string(), // actor id that dispatched the brief
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  dispatchedAt: z.string().datetime().nullable().default(null),
  startedAt: z.string().datetime().nullable().default(null),
});
export type Run = z.infer<typeof Run>;

// ---------------------------------------------------------------------------
// Runner — a registered local daemon. It discovers repos under its scan roots
// (no central list) and advertises them here; the server dispatches Runs to it.
// ---------------------------------------------------------------------------

/** `offboarded` is a human's decision, not a liveness state (RUN-35): a heartbeat cannot move a
 *  runner out of it, and its absence must not make it look merely crashed. "Someone stopped
 *  this" and "this went quiet" are different facts and the panel has to tell them apart. */
export const RunnerStatus = z.enum(['online', 'offline', 'draining', 'offboarded']);
export type RunnerStatus = z.infer<typeof RunnerStatus>;

// A repo the daemon discovered (has a .noriq/project.toml marker) and offers as
// a Run target. The committed KEY resolves to a projectId per configured server
// (see ./manifest for the resolution contract, RUN-3).
export const RunnerRepo = z.object({
  id: z.string(), // stable per (runner, repo), e.g. hash of the root path
  projectKey: z.string().min(1), // committed KEY from .noriq/project.toml
  projectId: z.string().nullable().default(null), // resolved against this server; null if unknown here
  name: z.string().default(''), // display name (repo dir basename)
  defaultBranch: z.string().nullable().default(null),
});
export type RunnerRepo = z.infer<typeof RunnerRepo>;

export const RunnerCapabilities = z.object({
  tools: z.array(AgentTool).default([]), // installed drivers
  kinds: z.array(RunKind).default([]), // run kinds this runner will accept
  maxConcurrency: z.number().int().nonnegative().default(1),
});
export type RunnerCapabilities = z.infer<typeof RunnerCapabilities>;

export const Runner = z.object({
  id: z.string(),
  projectId: z.string().nullable().default(null), // scoping project, if pinned; null = multi-project
  label: z.string().min(1), // human label from machine config, e.g. "my-laptop"
  status: RunnerStatus,
  capabilities: RunnerCapabilities,
  repos: z.array(RunnerRepo).default([]),
  freeSlots: z.number().int().nonnegative().default(0), // maxConcurrency − active runs
  lastHeartbeatAt: z.string().datetime().nullable().default(null),
  /** When a human cut this runner off (RUN-35). Non-null ⇒ status is 'offboarded' and its
   *  token has been revoked. */
  offboardedAt: z.string().datetime().nullable().default(null),
  createdAt: z.string().datetime(),
});
export type Runner = z.infer<typeof Runner>;
