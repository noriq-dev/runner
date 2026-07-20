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

/**
 * How hard the model should think (RUN-33) — INTENT, not a vendor knob.
 *
 * Tool-agnostic in the same way PermissionProfile is: each driver maps this to whatever its
 * backend calls the idea, and the mapping is the driver's problem. The values match the Claude
 * Agent SDK's `EffortLevel` because it is the finer-grained of the two we drive, so nothing is
 * lost in translation; Codex's `model_reasoning_effort` tops out at 'high' and its driver clamps.
 *
 * Null = don't ask for one; whatever the tool defaults to. Kinds genuinely differ — a scope run
 * is exploration and judgment, a conflict-resolution turn is mechanical — so one global default
 * is wrong for someone no matter which one you pick.
 */
export const RunEffort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * What a run ACTUALLY spent, per model (RUN-59). `runs.model` records what the dispatch
 * ASKED for; this records the reality — an "opus" run already spends real tokens on a haiku
 * sub-agent (RUN-34 measured it), and only keeping both makes "I asked for opus and got 30%
 * haiku" visible.
 *
 * The SDK's own field names, un-renamed and authoritative (it bills from these). ALL FOUR
 * token classes are kept, not just input/output: the run's displayed totals are computed
 * from all four, so a per-model breakdown that omitted cache tokens would not sum to the
 * number shown next to it — a user hovering each model and adding them up must land on the
 * run total.
 */
export const RunModelMix = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative(),
  costUSD: z.number().nonnegative(),
});
export type RunModelMix = z.infer<typeof RunModelMix>;

/**
 * The reserved key for spend that could NOT be attributed to a model (RUN-86). A codex session
 * reports tokens but no per-model split and no cost; the runner used to drop the WHOLE run's mix
 * over one such session (the all-or-nothing rule that made a Claude build show "not reported"
 * because its reviewer was codex). Instead it now folds that spend into this one bucket, so the
 * per-model parts still SUM to the run total — codex's tokens land here at $0 cost, matching that
 * the run total already books codex at $0. A model can never be named this (the parens make it a
 * non-id), so a consumer keys on it to render "unattributed" rather than a model.
 */
export const UNATTRIBUTED_MODEL_ID = '(unattributed)';

/**
 * The full mix, keyed by model id (e.g. "claude-opus-4-8"), plus possibly the reserved
 * `UNATTRIBUTED_MODEL_ID` bucket (RUN-86). Empty/absent = the run reported no spend at all (or a
 * telemetry-less tick) — THAT is the only "models not reported" case now; a run that spent
 * anything carries at least the unattributed bucket. Every value's four token classes + cost sum,
 * across all keys, to the run's displayed totals.
 */
export const RunModelUsage = z.record(z.string(), RunModelMix);
export type RunModelUsage = z.infer<typeof RunModelUsage>;
export type RunEffort = z.infer<typeof RunEffort>;

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

// What a `running` Run is CURRENTLY doing (RUN-31). A second axis on purpose, not a widened
// RunStatus — and the reason is not the repo's additive-migration rule:
//
// `verifying` and `landing` are sub-phases of running, not peers of `done`. Throughout them the
// Run holds its slot, is cancellable, and is not terminal. Every liveness query on the server
// asks `status IN ('dispatched','running','blocked')` — daemon reconciliation, owed-merges,
// request_input parking. Adding 'verifying' to the enum would silently drop a verifying Run out
// of all of them (reconcile would conclude the daemon lost it and fail a Run that is mid-gate),
// and every such site would have to be found by hand, forever, on each new value. A phase cannot
// cause that class of bug because nothing branches on it: it is a label a human reads.
//
// Null = nothing to say: a queued or terminal Run, or a daemon older than this field.
export const RunPhase = z.enum([
  'agent', // the coding-agent process is live and burning tokens
  'verifying', // process gone; the deterministic verify command / verify agent is the gate
  'landing', // gate passed; rebase → re-verify → fast-forward
]);
export type RunPhase = z.infer<typeof RunPhase>;

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
  // A per-dispatch override of the reviewer ROUND budget (PLNR-180/RUN-91) — not a SIGTERM
  // ceiling like the three above, but the same idea: a cap the run carries instead of leaving to
  // the daemon's default. Null = the daemon uses its committed manifest `[verify.agent].maxRounds`
  // (the server never reads that manifest — it stays the repo owner's authority, and clamps this).
  // Set on a "continue a failed run" dispatch to hand the kept worktree N more reviewer rounds.
  maxRounds: z.number().int().positive().nullable().default(null),
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
  // The plan this run serves, resolved SERVER-side at dispatch (RUN-28). The daemon cannot work
  // it out: a task-anchored run knows only its task, and plan membership lives in phase_tasks.
  // Null = a one-off dispatch belonging to no plan. Drives the per-plan working branch.
  planKey: z.string().nullable().default(null),
  // A per-dispatch override of the landing branch (RUN-41). Null = whatever [land] computes (the
  // per-plan working branch, or the static one). Only honoured if the repo's
  // [land].allowedBranches permits it — a dispatcher must not be able to widen the repo owner's
  // envelope, and the manifest is the authority.
  targetBranch: z.string().nullable().default(null),
  brief: z.string().default(''), // the dispatch intent; may be empty for anchored runs
  repoRef: z.string(), // id of a RunnerRepo advertised by the owning runner
  agentTool: AgentTool,
  // The dispatch's agent COORDINATE (RUN-114): `claude.opus-4_8.high` — the canonical selector,
  // naming tool+model+effort in one string. When set it WINS over agentTool/model/effort below (the
  // legacy triple, kept for one deprecation window); when null the runner synthesizes a coordinate
  // FROM that triple, so a dispatcher that never learned the coordinate keeps working unchanged.
  agent: z.string().nullable().default(null),
  // The repo-defined workflow this run selects (RUN-121), or null for a plain kind run. A custom
  // workflow is a NAMED variant of `kind` (its base): `kind` still carries the posture (so every
  // permission/gate stays kind-driven and floor-safe), and `workflow` only swaps in the workflow's
  // own prompt. Null / an unknown name → the built-in for `kind`, unchanged.
  workflow: z.string().nullable().default(null),
  // Per-dispatch model + effort (RUN-33). Null = fall through to the repo's [defaults] for this
  // kind, then to whatever the tool itself defaults to. Deliberately a free string, not an enum:
  // model names are the vendor's and they change weekly, so pinning them in a wire contract (or
  // a CHECK constraint) would mean a migration every time a model ships.
  model: z.string().nullable().default(null),
  effort: RunEffort.nullable().default(null),
  budget: RunBudget,
  status: RunStatus,
  // Sub-state of `running` (RUN-31) — see RunPhase. Cosmetic by construction: nothing
  // branches on it, so it can never make a liveness query wrong. Cleared on terminal.
  phase: RunPhase.nullable().default(null),
  exit: RunExit.nullable().default(null),
  // The daemon's isolated git worktree for this Run (branch noriq/run/<id>),
  // reported once the process starts so the server/dashboard can see where the
  // work is happening (and the verify agent can reference the checkout). Machine-
  // local path; null until the daemon reports it.
  worktreePath: z.string().nullable().default(null),
  // What the run actually spent per model (RUN-59) — the persisted runs.model_usage read
  // path. Null = "not reported" (codex, an old runner, or a driver that can't break spend
  // down by model). Never confuse with `model` above, which is only what was requested.
  modelUsage: RunModelUsage.nullable().default(null),
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
  // The board lock (RUN-71), riding the key's rails: `board` is the committed NAME from the
  // marker, `boardId` its per-server resolution. Null when the marker names none, the project
  // didn't resolve, or no board matches — unresolved is visible, never silently rebound.
  board: z.string().nullable().default(null),
  boardId: z.string().nullable().default(null),
  name: z.string().default(''), // display name (repo dir basename)
  defaultBranch: z.string().nullable().default(null),
  // This repo's custom workflow NAMES (RUN-121), advertised so the dashboard can offer them on
  // dispatch. The three built-ins (scope/build/verify) are always available and are NOT listed.
  // Names only: the base + prompt live in the committed manifest and stay the runner's authority —
  // the daemon resolves a selected name to its base+prompt locally (resolveWorkflow), so the wire
  // carries just the choice.
  workflows: z.array(z.string()).default([]),
});
export type RunnerRepo = z.infer<typeof RunnerRepo>;

/**
 * One installed driver's coordinate MENU (RUN-115): the model ids + efforts the dashboard renders
 * as an `<tool>.<model>.<effort>` picker. `models` is a SUGGESTION list, not a whitelist — model
 * names belong to the vendor and change weekly, so the dispatch model field stays free-text and a
 * name off this list still dispatches. `efforts` is the closed set this driver distinguishes (codex
 * collapses xhigh/max into its own 'high', so it advertises fewer).
 */
export const AdvertisedAgent = z.object({
  tool: AgentTool,
  models: z.array(z.string()).default([]),
  efforts: z.array(RunEffort).default([]),
});
export type AdvertisedAgent = z.infer<typeof AdvertisedAgent>;

export const RunnerCapabilities = z.object({
  tools: z.array(AgentTool).default([]), // installed drivers
  kinds: z.array(RunKind).default([]), // run kinds this runner will accept
  maxConcurrency: z.number().int().nonnegative().default(1),
  // The coordinate catalog per installed tool (RUN-115) — what the dashboard's agent picker reads.
  // Additive to `tools`; a runner too old to send it advertises an empty menu (free-text only).
  agents: z.array(AdvertisedAgent).default([]),
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
  /** The daemon's RELEASE version (RUN-36) — distinct from RUNNER_PROTOCOL_VERSION, which
   *  answers "can we talk". Null = registered before version reporting existed. */
  version: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
});
export type Runner = z.infer<typeof Runner>;
