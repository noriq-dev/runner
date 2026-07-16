import { z } from 'zod';
import { Run, RunStatus, RunPhase, RunExit, AgentTool, RunKind, RunnerRepo } from './runner';

// ---------------------------------------------------------------------------
// The runtime channel (RUN plan, Phase 1) — a persistent WebSocket the daemon
// dials out to the server (self-hosted CI-runner pattern: control plane in the
// Worker, the daemon is the WS *client*). Endpoint: /ws/runner/:id.
//
// This complements, and does not replace, the MCP channel (agent↔Noriq notices).
// Because the daemon owns the process + this live socket, it can deliver a
// steer even to a thinking, non-tool-calling agent — the exact case stateless
// MCP push cannot serve. Noriq stays the source of truth; this is *delivery*,
// with an ack back so the same steer is not re-delivered via the notices block.
//
// Runtime-neutral zod only — imported by the Worker AND the Node daemon.
// ---------------------------------------------------------------------------

// Bump when the envelope shape changes incompatibly; sent in `hello` so the
// server can reject or adapt to an out-of-date daemon.
export const RUNNER_PROTOCOL_VERSION = 1;

// How a steer is injected into the live CLI session:
//   soft — queue as the next user turn (the agent finishes its current thought)
//   hard — interrupt the current inference immediately (ESC-equivalent), then inject
export const SteerMode = z.enum(['soft', 'hard']);
export type SteerMode = z.infer<typeof SteerMode>;

// Where a steer actually landed — reported back in the ack (see below).
//   runtime  — injected into the live process; the agent has it now
//   fallback — could not inject live (e.g. process between turns); the agent
//              will still pick it up from the MCP notices block
//   dropped  — the Run is gone/terminal; not delivered anywhere
export const SteerDelivery = z.enum(['runtime', 'fallback', 'dropped']);
export type SteerDelivery = z.infer<typeof SteerDelivery>;

// ---------------------------------------------------------------------------
// server → daemon
// ---------------------------------------------------------------------------
export const RunnerServerMessage = z.discriminatedUnion('type', [
  // Handshake result after the daemon's `hello`.
  z.object({
    type: z.literal('registered'),
    runnerId: z.string(),
    protocol: z.number().int(),
    serverTime: z.string().datetime(),
  }),

  // A Run has been dispatched to this runner. Carries the full server-authored
  // Run entity; the daemon prepares a worktree and spawns the agent process.
  z.object({ type: z.literal('run.assigned'), run: Run }),

  // A plan finished, so its working branch is ready to become a merge request (RUN-28).
  //
  // Completion is a SERVER fact — the daemon only ever sees Runs, never the plan's task graph —
  // so the server computes it and tells the runner that landed the work. This frame is the FAST
  // path only: the completion is also recorded (plan_landings), because a plan can finish while
  // no runner is listening (box off, runner offboarded, socket mid-reconnect) and a
  // fire-and-forget push would drop the MR silently, forever. The daemon re-asks on reconnect.
  z.object({
    type: z.literal('plan.completed'),
    planId: z.string(),
    planKey: z.string(),
    planTitle: z.string(),
    projectId: z.string(),
  }),

  // A human answered the question a Run parked on (RUN-30) — bring its agent back.
  //
  // Fast path only, exactly like plan.completed: the answer is durable in `signals`, and the
  // daemon re-asks (GET /api/runs/:id/park) for every run it has parked whenever it reconnects.
  // A question can easily be answered while the box is off — that is the normal case, not the
  // edge one — and a fire-and-forget resume would strand the run and the worktree holding its
  // work.
  z.object({
    type: z.literal('run.resume'),
    runId: z.string(),
    signalId: z.string(),
    question: z.string().nullable().default(null),
    answer: z.string(),
  }),

  // Kill a Run. hard=true → SIGTERM the process now; false → let it wind down.
  z.object({
    type: z.literal('run.cancel'),
    runId: z.string(),
    hard: z.boolean().default(true),
    reason: z.string().nullable().default(null),
  }),

  // Steer a live agent process (the runtime-channel delivery of a human's
  // comment/interrupt in the dashboard). `steerId` is echoed in the ack for
  // dedup; the source refs + noticeCursor let the server mark this delivered so
  // it is not double-delivered via MCP notices.
  z.object({
    type: z.literal('steer'),
    runId: z.string(),
    steerId: z.string(),
    mode: SteerMode,
    body: z.string().min(1), // the user turn / interrupt text to inject
    sourceCommentId: z.string().nullable().default(null),
    sourceMessageId: z.string().nullable().default(null),
    noticeCursor: z.number().int().nonnegative().nullable().default(null),
    issuedAt: z.string().datetime(),
  }),

  z.object({ type: z.literal('pong') }),
]);
export type RunnerServerMessage = z.infer<typeof RunnerServerMessage>;

// ---------------------------------------------------------------------------
// daemon → server
// ---------------------------------------------------------------------------

// Repo/capability announcement carried on the daemon's `hello`. Kept inline
// (not the full Runner entity) — the server owns id assignment and status.
export const RunnerHello = z.object({
  type: z.literal('hello'),
  protocol: z.number().int(),
  // Present on reconnect so the server re-binds to the existing Runner row.
  runnerId: z.string().nullable().default(null),
  label: z.string().min(1),
  tools: z.array(AgentTool).default([]),
  kinds: z.array(RunKind).default([]),
  maxConcurrency: z.number().int().nonnegative().default(1),
  repos: z.array(RunnerRepo).default([]),
});
export type RunnerHello = z.infer<typeof RunnerHello>;

export const RunnerClientMessage = z.discriminatedUnion('type', [
  RunnerHello,

  // Periodic liveness + capacity. repos optional — resend only when discovery
  // changed the set (reconcile).
  z.object({
    type: z.literal('heartbeat'),
    freeSlots: z.number().int().nonnegative(),
    repos: z.array(RunnerRepo).nullable().default(null),
  }),

  // A Run lifecycle transition the daemon drives (running → blocked ⇄ running →
  // terminal). Server-driven transitions (queued → dispatched) are not sent here.
  // `agentId` is reported once the spawned agent registers its own Noriq actor.
  z.object({
    type: z.literal('run.status'),
    runId: z.string(),
    status: RunStatus,
    agentId: z.string().nullable().default(null),
    exit: RunExit.nullable().default(null),
    // The Run's worktree path, reported once the daemon prepares the checkout —
    // gives the server/dashboard visibility into where the Run is executing.
    worktreePath: z.string().nullable().default(null),
    at: z.string().datetime(),
  }),

  // Live run telemetry (RUN-22): a high-frequency, non-transitional heartbeat of
  // spend + a rolling log tail, so the dashboard can show token/USD burn and the
  // latest output WITHOUT minting a status transition per tick. The daemon is the
  // only source of this (it owns the process); the server last-writer-wins persists
  // it on the run row. Distinct from run.status so telemetry never gates lifecycle.
  //
  // Every field is null-means-no-news, and the server patches only what is present
  // (COALESCE) — a tick that knows the phase but not the spend must not zero the spend.
  z.object({
    type: z.literal('run.telemetry'),
    runId: z.string(),
    tokensUsed: z.number().int().nonnegative().nullable().default(null),
    usdSpent: z.number().nonnegative().nullable().default(null),
    // Tail of the agent's combined output, tail-capped by the daemon (last wins).
    logTail: z.string().nullable().default(null),
    // What the Run is doing right now (RUN-31). It rides THIS frame, not run.status,
    // for the same reason spend does: a phase change is not a lifecycle transition.
    // run.status would be actively wrong here — the transition map has no running →
    // running edge, so the server would reject a phase report as an illegal transition.
    phase: RunPhase.nullable().default(null),
    at: z.string().datetime(),
  }),

  // Run TRANSCRIPT segments (RUN-74): an APPEND-ONLY, role-labeled stream of everything the
  // run said — the builder's turns, each inline reviewer round, the verify command's output,
  // and daemon milestones. Exists because logTail above is one last-writer-wins blob from the
  // core agent only: after a reviewer refusal, the one thing a human needs to read (WHY) never
  // reached the server. The daemon assigns monotonic seqs per run; the server INSERT OR
  // IGNOREs on (runId, seq), so redelivery is idempotent, like every daemon frame.
  z.object({
    type: z.literal('run.log'),
    runId: z.string(),
    segments: z
      .array(
        z.object({
          seq: z.number().int().nonnegative(),
          // agent = the run's own session (build/scope/verify kinds alike; fix turns ride the
          // same session, so attribution is automatic). reviewer = the inline reviewer, with
          // its round. verify = the deterministic cmd's output. system = daemon milestones.
          role: z.enum(['agent', 'reviewer', 'verify', 'system']),
          round: z.number().int().positive().nullable().default(null),
          text: z.string().max(16384),
          at: z.string().datetime(),
        }),
      )
      .max(64),
  }),

  // The ack contract: sent after the daemon attempts to inject a steer. Echoes
  // steerId (dedup), reports where it landed, and advances the server's per-Run
  // notice cursor so the same steer is not re-surfaced via the MCP notices block.
  z.object({
    type: z.literal('steer.ack'),
    runId: z.string(),
    steerId: z.string(),
    delivered: z.boolean(),
    via: SteerDelivery,
    noticeCursor: z.number().int().nonnegative().nullable().default(null),
    detail: z.string().nullable().default(null),
    ackedAt: z.string().datetime(),
  }),

  z.object({ type: z.literal('ping') }),
]);
export type RunnerClientMessage = z.infer<typeof RunnerClientMessage>;
