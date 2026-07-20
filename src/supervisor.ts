import type {
  AgentTool,
  LandPolicy,
  PermissionProfile,
  ProjectManifest,
  Run,
  RunBudget,
  RunEffort,
  RunKind,
  RunPhase,
} from '@noriq-dev/shared';
import { UNATTRIBUTED_MODEL_ID } from '@noriq-dev/shared';
import { type LedgerEntry, buildLedger, parseFindingResponses, parseFindings } from './adjudication';
import { type AgentCoordinate, coordinateFromParts, tryParseCoordinate } from './agent-coordinate';
import type { ParkState, RunAgent } from './client';
import type { ContinuableRun, ContinuableStore } from './continuable';
import { type BudgetRun, superviseBudget, totalTokens } from './drivers/budget';
import type {
  AgentDriver,
  DriverExit,
  DriverSession,
  DriverStartOptions,
  DriverTelemetry,
  ModelUsage,
  NoriqMcp,
} from './drivers/types';
import { zeroTelemetry } from './drivers/types';
import {
  type LandOutcome,
  assembleConflictPrompt,
  landFailureComment,
  parseResolution,
  rejectTargetBranch,
  resolveLandBranch,
} from './land';
import type { LockConflict } from './lock-client';
import { LockEnforcer, lockFloorComment } from './lock-hooks';
import { logger as defaultLogger } from './logger';
import { type ParkedRun, type ParkedStore, expiredParks, resumePrompt } from './parked';
import { renderPrompt } from './prompts';
import { noriqToolNamesFor, sanitizedAgentEnv } from './security';
import { type RunLogSegment, RunTranscript } from './transcript';
import type { LockContext, LockOutcome, VcsBackend, Workspace } from './vcs/types';
import {
  type VerifyExec,
  type VerifySpec,
  runVerify,
  verifyFailureComment,
  verifyFeedbackPrompt,
  verifyFixRounds,
} from './verify';
import { type VerifyVerdict, assembleVerifyPrompt, parseVerdict, verifyAgentComment } from './verify-agent';
import {
  assembleReviewerPrompt,
  reviewerFeedbackPrompt,
  reviewerNoVerdictComment,
  reviewerRejectionComment,
} from './verify-reviewer';
import { clampPermissionToWorkflow, workflowFor } from './workflow';

// Wires the two core run kinds through a real cycle: resolve the repo → prepare an
// isolated worktree (scope/verify read-only, build read-write) → assemble the
// kind-specific prompt → run the selected driver under the Run budget → stream
// status/telemetry back → clean up. Composes RUN-11 (worktree), RUN-12/13
// (drivers), RUN-14 (budget).
//
// The daemon creates each Run's Noriq identity up front and hands the process a token bound
// to it (RUN-43), so the agent reports its own work as an actor the daemon can name. It used
// to be the reverse: the prompt asked the model to register ITSELF via set_agent_identity, so
// attribution depended on the model complying and the daemon never learned who its own child
// was — run.status.agentId was null on every run ever reported.

/** The slice of a VcsBackend the supervisor drives — everything except reapOrphans, which is
 *  the daemon's (crash recovery is not a per-Run concern). */
export type SupervisorVcs = Pick<
  VcsBackend,
  | 'lease'
  | 'dispose'
  | 'hasWork'
  | 'checkpoint'
  | 'targetExists'
  | 'createTarget'
  | 'integrate'
  | 'resumeIntegrate'
  | 'abandonIntegrate'
  | 'publish'
  | 'share'
  | 'disposePreservesWork'
> &
  // Optional so every existing fake keeps compiling; absent reads as git, the machine default.
  // The reviewer (RUN-61) keys its diff instruction off this — `git diff` is a lie on Perforce.
  // lock/unlock/queryLocks are optional the same way (RUN-98): a fake or lock-less backend omits
  // them, and the supervisor treats absence as "no lock layer" (RUN-101/103).
  Partial<Pick<VcsBackend, 'kind' | 'lock' | 'unlock' | 'queryLocks' | 'changedPaths' | 'releaseRunLocks'>>;

export interface ResolvedRepo {
  root: string;
  manifest: ProjectManifest;
  /**
   * This repo's backend (RUN-60), when it is not the machine default — the daemon detects per
   * repo (git by `.git`, Diversion by the dv registry) and routes here. Omitted → `deps.vcs`,
   * which keeps every existing caller and test meaning exactly what it meant.
   */
  vcs?: SupervisorVcs;
}

export interface RunReport {
  /** `blocked` = parked on a human (RUN-30). Non-terminal and resumable → running. */
  status: 'running' | 'blocked' | 'done' | 'failed';
  worktreePath?: string | null;
  /** The agent working this Run. The wire has always carried this slot and it was always
   *  null, because the daemon never knew the identity its child invented for itself — the
   *  daemon creates it now (RUN-43), so it can finally say. */
  agentId?: string | null;
  /** What this Run is doing right now (RUN-31): the ~90s of verify + land used to report a
   *  blanket `running` with the spend frozen, which is indistinguishable from a hung agent.
   *  Rides the telemetry frame, not the status one — a phase change is not a transition. */
  phase?: RunPhase;
  telemetry?: DriverTelemetry;
  /** Rolling tail of the agent's output for the live dashboard (RUN-22), tail-capped. */
  logTail?: string;
  exit?: Record<string, unknown> | null;
}

/** How much of the agent's trailing output to stream as the live log tail. */
const LOG_TAIL_CAP = 4000;

export interface RunSupervisorDeps {
  /** One driver per tool (claude/codex). */
  drivers: Partial<Record<AgentTool, AgentDriver>>;
  /** The VCS seam (RUN-49). This Pick is the interface's origin story: its git-verb
   *  predecessor was how the nine outcomes were DISCOVERED — the supervisor already declared
   *  exactly what it needs, so the seam was renamed, not designed. This is the MACHINE DEFAULT;
   *  a repo may carry its own backend via ResolvedRepo.vcs (RUN-60). */
  vcs: SupervisorVcs;
  /** repoRef → local repo root + the manifest to run under. May be async: the daemon
   *  re-reads the committed marker per Run so a config edit needs no restart. */
  resolveRepo: (repoRef: string) => ResolvedRepo | null | Promise<ResolvedRepo | null>;
  /** Report a Run status transition upstream (→ WsClient.sendRunStatus). */
  report: (runId: string, report: RunReport) => void;
  /** Stream transcript segments upstream (RUN-74, → WsClient.sendRunLog). The role-labeled
   *  record of every voice in the run — the "why was it refused" surface. Optional and
   *  best-effort by construction: a transcript must never gate a run. */
  reportLog?: (runId: string, segments: RunLogSegment[]) => void;
  /**
   * Create this Run's Noriq agent and take its credential (→ NoriqClient.createRunAgent).
   *
   * The daemon owns the identity's lifecycle (RUN-43): it exists before the process does,
   * and the process is authenticated as it by a token bound to it alone. This replaces
   * `parentAgentId`, which was both wrong and inert — daemon.ts passed the RUNNER id into a
   * field documented as an agent id, and it only ever reached the model as prompt text
   * asking it to please register itself.
   *
   * Omitted → the agent gets no Noriq identity and no MCP access, which is a no-op run.
   */
  createRunAgent?: (runId: string, opts: { label?: string; allowedTools?: string[] }) => Promise<RunAgent>;
  /** The Noriq server the spawned agent reaches over direct MCP. */
  server: string;
  /**
   * Machine-local ceilings from runner.toml's `[budget]`, applied per-dimension to a
   * Run that doesn't carry its own. Without this a dispatch with no budget runs
   * completely unbounded — no token, USD, or wall-clock ceiling.
   */
  defaultBudget?: RunBudget | null;
  // `getToken` is gone (RUN-43): it injected the DAEMON's own OAuth token into every spawned
  // agent's MCP transport — the credential that can register runners and reach every project
  // its human can. Agents now get a per-run token bound to one identity, from createRunAgent.
  /** Resolve an anchor task's title/body so the prompt can inline it (→ NoriqClient.getTask). */
  resolveTask?: (taskId: string) => Promise<AnchorTask | null>;
  /**
   * Read-only phase/plan-gate probe (RUN-81, → NoriqClient.checkClaimable): is a task-anchored
   * run's task claimable RIGHT NOW? Consulted BEFORE spawning, as defense in depth — the server's
   * dispatch/claim gate is the primary authority, but a bug there (a phase-2 task offered while
   * phase 1 is only in review) must not spawn an agent on work that isn't unlocked yet.
   *
   * Omitted, or a null answer (probe unavailable / transient error), leaves the gate UNCONSULTED
   * — the daemon spawns exactly as before. Only an explicit `{ claimable: false }` declines.
   */
  checkClaimable?: (taskId: string) => Promise<{ claimable: boolean; reason: string | null } | null>;
  /**
   * Dispatch-time predictive locking (RUN-103): the DECLARED file scope of a run, if one is
   * known, so the daemon can take its locks before the agent starts and refuse a dispatch that
   * would clash — extending the RUN-81 phase-gate backstop from "is the task claimable" to "are
   * its files free".
   *
   * Honest by construction: no run carries a declared scope on the wire today, so this is a
   * PLUGGABLE resolver (a future dispatch field / task metadata), and when it is absent or yields
   * nothing the predictive layer no-ops — the reactive hook (RUN-101) and hard floor (RUN-102)
   * remain the guarantee. Paths are repo-relative.
   */
  resolveLockScope?: (run: Run) => Promise<string[] | null> | string[] | null;
  /**
   * Is this Run parked on a human, and have they answered? (→ NoriqClient.getParkState, RUN-30)
   *
   * The server is the authority: only it saw the `request_input`, because the agent reaches
   * Noriq over MCP directly and the daemon is not in that path. Omitted → parking is off and a
   * session that ends is simply finished, exactly as before RUN-30.
   */
  getParkState?: (runId: string) => Promise<ParkState>;
  /** Where parked runs are remembered across restarts (RUN-30). Omitted → parking is off. */
  parked?: Pick<ParkedStore, 'park' | 'get' | 'unpark' | 'list'>;
  /** Where a failed build's continuation state (spend + adjudication ledger) is kept, so a
   *  "continue a failed run" (RUN-91/92) re-seeds instead of resetting. Omitted → a continue still
   *  works off the kept worktree, but reports only its own sitting's spend and re-derives findings. */
  continuable?: Pick<ContinuableStore, 'get' | 'put' | 'remove'>;
  /** How long a park may sit before the daemon fails it (RUN-30). Default: DEFAULT_PARK_TTL_HOURS. */
  parkTtlHours?: number;
  /** Makes the live session steerable + cancellable while it runs (RUN-16/18). */
  steering?: {
    register: (runId: string, session: DriverSession, stop: () => Promise<void>) => void;
    unregister: (runId: string) => void;
  };
  /** Injectable command runner for the deterministic verify floor (RUN-19). */
  verifyExec?: VerifyExec;
  /** Post the verify failure output as a comment on the anchor task (the floor-gate surface). */
  postComment?: (projectId: string, taskId: string, body: string) => void;
  logger?: typeof defaultLogger;
}

/**
 * Resolve the ceilings a Run actually executes under: the Run's own budget wins
 * per-dimension, and runner.toml's `[budget]` fills each gap.
 *
 * Per-dimension (not whole-object) on purpose — a dispatch that sets only `maxTokens`
 * must still inherit the machine's USD and wall-clock ceilings, or the one field it
 * specified would silently disable the other two.
 *
 * These are DEFAULTS, not clamps: an explicit Run budget above the machine's is
 * honoured, matching what runner.toml.example documents.
 */
export function mergeBudget(runBudget?: RunBudget | null, fallback?: RunBudget | null): RunBudget | null {
  if (!runBudget && !fallback) return null;
  return {
    maxTokens: runBudget?.maxTokens ?? fallback?.maxTokens ?? null,
    maxUsd: runBudget?.maxUsd ?? fallback?.maxUsd ?? null,
    maxDurationSeconds: runBudget?.maxDurationSeconds ?? fallback?.maxDurationSeconds ?? null,
    // The reviewer-round override (PLNR-180/RUN-91) is the dispatch's alone — the machine fallback
    // never sets it — but it merges per-dimension like the rest so it survives to the supervisor.
    maxRounds: runBudget?.maxRounds ?? fallback?.maxRounds ?? null,
  };
}

/**
 * Which model + effort a Run actually executes with (RUN-33).
 *
 * Three layers, most specific first: the DISPATCH (a human chose, for this run), then the REPO's
 * per-kind `[defaults]` (a repo said "scope with something strong"), then nothing — the tool's own
 * default, which is what every run got before this existed.
 *
 * Per-field, not whole-object, for the same reason mergeBudget is: a dispatch that names only a
 * model must still inherit the repo's effort for that kind, or the one field it set would
 * silently erase the other.
 */
/**
 * The dispatch's effective coordinate (RUN-114): the `agent` string when present, else one
 * synthesized from the legacy `{agentTool, model, effort}` triple. A malformed wire coordinate
 * falls back to the triple rather than sinking the run — the triple is always well-formed (its
 * fields are wire-validated), so there is a safe answer. This is the ONE place the runner reconciles
 * new-form and legacy-form dispatches; everything downstream reads a coordinate.
 */
export function runCoordinate(run: Pick<Run, 'agent' | 'agentTool' | 'model' | 'effort'>): AgentCoordinate {
  const fromTriple = coordinateFromParts(run.agentTool, run.model, run.effort);
  if (!run.agent) return fromTriple;
  return tryParseCoordinate(run.agent) ?? fromTriple;
}

/** The driver a run selects — its coordinate's tool (RUN-114). Identical to `agentTool` for a
 *  legacy dispatch that carries no coordinate. */
export function resolveAgentTool(run: Pick<Run, 'agent' | 'agentTool' | 'model' | 'effort'>): string {
  return runCoordinate(run).tool;
}

export function resolveModel(
  run: Pick<Run, 'kind' | 'agent' | 'agentTool' | 'model' | 'effort'>,
  manifest: ProjectManifest,
): { model?: string; effort?: RunEffort } {
  const repo = manifest.defaults?.[run.kind as RunKind];
  // Precedence, most specific first: the dispatch coordinate (RUN-114, which already folds the
  // agent string OR the legacy triple) → the repo `[defaults.<kind>].agent` coordinate (RUN-113) →
  // the repo's legacy model/effort pair → the tool's own default (absence).
  const dispatch = runCoordinate(run);
  const repoCoord = repo?.agent ? tryParseCoordinate(repo.agent) : null;
  const model = dispatch.model ?? repoCoord?.model ?? repo?.model ?? null;
  const effort = dispatch.effort ?? repoCoord?.effort ?? repo?.effort ?? null;
  // Undefined rather than null: these become DriverStartOptions fields, and the drivers treat
  // "absent" as "don't pass it", which is what lets the tool apply its own default.
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

/**
 * What a resumed run may still spend (RUN-30).
 *
 * Tokens and USD carry over as plain remainders: a run that parks and resumes has one budget for
 * its whole life, not one per sitting. Wall-clock does NOT — `activeSeconds` counts only time the
 * agent was actually running, because the wait for a human is not the run's fault and charging it
 * would mean any question answered after a lunch break returns to a run that is already dead.
 *
 * Floors at 1 rather than 0: a remainder of exactly zero would read as "no limit" to the budget
 * supervisor, turning an exhausted run into an unlimited one — the precise inversion of intent.
 */
export function remainingBudget(budget: RunBudget | null, spent: ParkedRun): RunBudget | undefined {
  if (!budget) return undefined;
  const left = (max: number | null, used: number) => (max == null ? null : Math.max(1, max - used));
  return {
    maxTokens: left(budget.maxTokens, spent.spent.tokens),
    maxUsd: budget.maxUsd == null ? null : Math.max(0.01, budget.maxUsd - spent.spent.usd),
    maxDurationSeconds: left(budget.maxDurationSeconds, spent.activeSeconds),
    // A round count, not a spend remainder — carried over verbatim, never decremented by prior
    // tokens/time (PLNR-180/RUN-91).
    maxRounds: budget.maxRounds,
  };
}

/** Sum two model mixes model-by-model, field-by-field (RUN-59). Absent on both sides → absent. */
export const mergeModelUsage = (
  a?: Record<string, ModelUsage>,
  b?: Record<string, ModelUsage>,
): Record<string, ModelUsage> | undefined => {
  if (!a && !b) return undefined;
  const out: Record<string, ModelUsage> = {};
  for (const src of [a, b]) {
    if (!src) continue;
    for (const [id, u] of Object.entries(src)) {
      const cur = out[id];
      out[id] = cur
        ? {
            inputTokens: cur.inputTokens + u.inputTokens,
            outputTokens: cur.outputTokens + u.outputTokens,
            cacheReadInputTokens: cur.cacheReadInputTokens + u.cacheReadInputTokens,
            cacheCreationInputTokens: cur.cacheCreationInputTokens + u.cacheCreationInputTokens,
            costUSD: cur.costUSD + u.costUSD,
          }
        : { ...u };
    }
  }
  return out;
};

/**
 * Fold ONE session's aggregate telemetry into the unattributed bucket (RUN-86). Reads the four
 * token classes + cost off a `DriverTelemetry` (whose field names differ from `ModelUsage`'s:
 * `cacheReadTokens`→`cacheReadInputTokens`, `costUsd`→`costUSD`) and adds them in — so the bucket
 * carries exactly what this session contributed to the run totals, and the mix keeps summing.
 */
const addUnattributed = (acc: ModelUsage | undefined, t: DriverTelemetry): ModelUsage => ({
  inputTokens: (acc?.inputTokens ?? 0) + t.inputTokens,
  outputTokens: (acc?.outputTokens ?? 0) + t.outputTokens,
  cacheReadInputTokens: (acc?.cacheReadInputTokens ?? 0) + t.cacheReadTokens,
  cacheCreationInputTokens: (acc?.cacheCreationInputTokens ?? 0) + t.cacheCreationTokens,
  costUSD: (acc?.costUSD ?? 0) + t.costUsd,
});

/** A park's prior spend, rehydrated as a telemetry snapshot to SEED a resumed run's tally (RUN-59).
 *  Prior tokens land in inputTokens — the split across the four buckets is not recoverable from the
 *  park (it stores one total), and the figure that matters (and that the budget reads) is the sum.
 *  The prior MIX carries over whole, so a resumed run's breakdown keeps summing to its total. */
export const telemetryFromSpent = (spent: ParkedRun['spent']): DriverTelemetry => ({
  inputTokens: spent.tokens,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: spent.usd,
  numTurns: 0,
  ...(spent.modelUsage ? { modelUsage: spent.modelUsage } : {}),
});

/**
 * The run's spend, tallied across every SESSION that bills to it (RUN-59).
 *
 * A run is not one session: the primary agent (and its fix turns), each inline-reviewer round, the
 * conflict resolver, and a park's prior spend all cost real tokens on real — sometimes DIFFERENT —
 * models. Reporting only the primary's mix is the same half-truth as reporting only the dispatched
 * model. Each session records its latest snapshot under its own slot; the run's figure is the sum.
 *
 * Authority, not size: `record` is last-writer-wins per slot, NOT a max. Within one session each
 * result is that session's running cumulative aggregate and arrives AFTER its own live ticks, so the
 * latest snapshot is the authoritative one — picking "the largest" would let a live over-count (or a
 * mix-less interim tick) beat the result that supersedes it.
 *
 * The mix must SUM to the run total beside it — that is the one thing the tooltip must never break.
 * RUN-59 kept that by making the mix all-or-nothing: one un-attributed spending session (codex, the
 * claude usage-fallback, a pre-RUN-59 park) dropped the WHOLE mix. But that discarded a Claude
 * builder's perfectly good breakdown just because its reviewer was codex — the run showed "not
 * reported" beside real, attributable spend. RUN-86 keeps the sum without the loss: un-attributable
 * spend is folded into ONE reserved `(unattributed)` bucket carrying exactly what those sessions
 * contributed to `acc`, so attributed models + the bucket still land on the total. The bucket is a
 * real key the dashboard renders as "unattributed"; only a genuinely spend-less run has no mix.
 */
export class RunTally {
  private readonly slots = new Map<string, DriverTelemetry>();

  /** Record a session's latest snapshot. Last-writer-wins per slot (see class doc). */
  record(slot: string, t: DriverTelemetry): void {
    this.slots.set(slot, t);
  }

  /** Seed a slot only if empty — used for a park's prior spend, which must not clobber a live
   *  session that already recorded under the same slot. */
  seed(slot: string, t: DriverTelemetry): void {
    if (!this.slots.has(slot)) this.slots.set(slot, t);
  }

  total(): DriverTelemetry {
    const acc = zeroTelemetry();
    let mix: Record<string, ModelUsage> | undefined;
    // Spend from mix-less sessions, collected into the one reserved bucket (RUN-86) instead of
    // nuking the whole mix. Each such session adds its OWN aggregate — the same numbers it puts in
    // `acc` — so the bucket + the attributed models sum back to the total (codex lands here at $0,
    // matching that `acc.costUsd` already books it at $0).
    let unattributed: ModelUsage | undefined;
    for (const t of this.slots.values()) {
      acc.inputTokens += t.inputTokens;
      acc.outputTokens += t.outputTokens;
      acc.cacheReadTokens += t.cacheReadTokens;
      acc.cacheCreationTokens += t.cacheCreationTokens;
      acc.costUsd += t.costUsd;
      acc.numTurns += t.numTurns;
      const spent =
        t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreationTokens > 0 || t.costUsd > 0;
      if (t.modelUsage) mix = mergeModelUsage(mix, t.modelUsage);
      else if (spent) unattributed = addUnattributed(unattributed, t);
    }
    // A mix exists if ANYTHING was attributed or anything was unattributed; only a spend-less run
    // leaves both undefined (→ no mix, the daemon sends `{}` → the honest "not reported").
    if (mix || unattributed) {
      acc.modelUsage = { ...mix, ...(unattributed ? { [UNATTRIBUTED_MODEL_ID]: unattributed } : {}) };
    }
    return acc;
  }
}

/** The anchor task's human-readable content, inlined into the prompt. */
export interface AnchorTask {
  key: string;
  title: string;
  body: string | null;
}

/**
 * The RUNNABLE half of `[verify]` (RUN-61). Since the stage became a choice, `cmd` is
 * nullable — a reviewer-only section has no command — and every caller that shells out
 * narrows through here instead of trusting the field.
 */
export function cmdVerify(verify: ProjectManifest['verify']): VerifySpec | null {
  return verify?.cmd
    ? {
        cmd: verify.cmd,
        timeoutSeconds: verify.timeoutSeconds,
        shell: verify.shell,
        maxRounds: verify.maxRounds,
      }
    : null;
}

/**
 * Commit message for a run checkpoint (RUN-96): WHAT changed on the subject line, the runner's
 * attribution in the body. The old `noriq run <id>: <label>` order made every agent commit read
 * identically in one-line history — the id nobody scans pushed the task key/title everybody
 * scans off the right edge.
 */
export function runCommitMessage(runId: string, label: string): string {
  return `${label}\n\nnoriq run ${runId}`;
}

/** Render the anchor. A bare task id tells the agent nothing — inline the title/body
 *  the daemon already resolved so it starts knowing the job instead of spending its
 *  first turn (and possibly failing) on a get_task round-trip. */
function renderAnchor(run: Run, task?: AnchorTask | null): string {
  if (run.anchor?.type === 'task') {
    if (!task) return `\nApproved task: ${run.anchor.taskId}`;
    return `\nApproved task: ${task.key} (${run.anchor.taskId}) — ${task.title}${
      task.body ? `\n\n${task.body}` : ''
    }`;
  }
  return run.anchor?.type === 'plan' ? `\nPlan: ${run.anchor.planId}` : '';
}

/** Assemble the kind-specific prompt. Scope explores read-only and emits a
 *  PROPOSED plan; build implements an approved task into a review diff. The agent is
 *  TOLD who it is (RUN-43) rather than asked to introduce itself. */
export function assemblePrompt(
  run: Run,
  manifest: ProjectManifest,
  ctx: { agent: RunAgent; server: string; task?: AnchorTask | null; diffCmd?: string },
): string {
  const anchor = renderAnchor(run, ctx.task);
  // The daemon created this identity before the process existed and handed it a token that
  // can only be this agent, so there is nothing to register (RUN-43). The old prompt asked
  // the model to call set_agent_identity — which made attribution depend on it complying,
  // left the daemon unable to name its own child, and quietly produced anonymous agents
  // whenever the model skipped the step or (as with codex) had no MCP to call.
  // Every kind can reach a human, so the invitation belongs in the shared identity block
  // (RUN-32). The allowlist grants the tools; this is what stops them going unused. An agent
  // that hits an ambiguity with no invitation to ask does not stop — it picks, and hopes.
  // request_input is not a way to give up: the daemon ends the session, keeps the worktree,
  // and resumes THIS session with the answer (RUN-30), so asking costs the agent nothing.
  const identity = renderPrompt('identity', {
    label: ctx.agent.label,
    agentId: ctx.agent.agentId,
    kind: run.kind.toUpperCase(),
    projectKey: manifest.key,
    server: ctx.server,
  });

  const wf = workflowFor(run.kind as RunKind); // the prompt family is a workflow trait (RUN-117)
  if (wf.promptShape === 'scope') {
    return renderPrompt('scope', { identity, brief: run.brief, anchor });
  }
  if (wf.promptShape === 'build') {
    // The agent is NOT told to run the verify command (RUN-29). It used to be, and the daemon then
    // ran the SAME command itself as the actual gate — so the agent paid tokens and about a minute
    // to answer a question that got asked again, properly, right afterwards. Its run was advisory;
    // the daemon's is authoritative and free. Measured on run_mrlig93q5b574b502963: ~3m24s of agent
    // time including its own verify, then 62s of daemon verify.
    // Its allowlist still permits running tests — iterating on one file while working is cheap and
    // targeted. What it must not do is burn the full suite to grade itself.
    //
    // The reviewer sentence is fairness, not just information (RUN-61): a builder that learns of
    // the reviewer only from a rejection reads it as scope creep and argues; one told up front
    // writes for the review.
    return renderPrompt('build', {
      identity,
      verifyCmd: manifest.verify?.cmd ?? null,
      reviewer: Boolean(manifest.verify?.agent),
      brief: run.brief,
      anchor,
    });
  }
  // verify kind (RUN-20): a fresh, independent, adversarial reviewer.
  return assembleVerifyPrompt(`${run.brief}${anchor}`, {
    agent: ctx.agent,
    server: ctx.server,
    diffCmd: ctx.diffCmd,
  });
}

export class RunSupervisor {
  private readonly log: typeof defaultLogger;
  /** One landing at a time per repo — see withRepoLock. */
  private readonly repoLocks = new Map<string, Promise<unknown>>();

  /** One transcript per run (RUN-74), keyed so an in-process resume CONTINUES the seq
   *  stream — the server dedups on (runId, seq), and a restarted seq would collide with
   *  rows already written and be silently dropped. */
  private readonly transcripts = new Map<string, RunTranscript>();

  private transcript(runId: string): RunTranscript {
    let t = this.transcripts.get(runId);
    if (!t) {
      const sink = this.deps.reportLog;
      t = new RunTranscript(sink ? (segments) => sink(runId, segments) : () => {});
      this.transcripts.set(runId, t);
    }
    return t;
  }

  constructor(private readonly deps: RunSupervisorDeps) {
    this.log = deps.logger ?? defaultLogger;
  }

  /** The repo's own backend when the daemon routed one (RUN-60), else the machine default. */
  private vcsFor(repo: ResolvedRepo): SupervisorVcs {
    return repo.vcs ?? this.deps.vcs;
  }

  /**
   * The ONE way this supervisor starts a driver (RUN-109). Every agent spawn — main run, reviewer,
   * conflict turn, verify-fix — funnels through here so the sanitized child env is a supervisor
   * guarantee, not a per-driver habit. `env` is set BEFORE the caller's opts so an explicit
   * override still wins, but no caller sets it: they all inherit the stripped env by construction.
   */
  private startAgent(driver: AgentDriver, opts: DriverStartOptions): BudgetRun {
    return superviseBudget(driver, { env: sanitizedAgentEnv(), ...opts });
  }

  /**
   * The branch a run's file locks are scoped to (RUN-97 §5): the branch it will LAND on, where
   * two runs actually contend — not its throwaway `noriq/run/<id>` worktree branch (on which
   * they'd never collide). The `[land]` target when configured, else the dispatch's target, else
   * the repo default. null → all-branches, the safe fallback when nothing names a target.
   */
  private lockScopeBranch(repo: ResolvedRepo, run: Run): string | null {
    if (repo.manifest.land) return resolveLandBranch(repo.manifest.land.branch, run.planKey);
    return run.targetBranch ?? repo.manifest.defaultBranch ?? null;
  }

  /**
   * The reactive per-edit lock enforcer for a build (RUN-101), or undefined when there is no
   * lock layer to enforce through. Bound to the run's workspace + agent token + scope branch, so
   * the driver's PreToolUse hook locks each path the agent edits, as that run's holder. Only for
   * `build`: scope and verify never write, so they never take a write lock.
   */
  private lockEnforcerFor(
    repo: ResolvedRepo,
    run: Run,
    worktree: Workspace,
    kind: RunKind,
    token: string,
  ): LockEnforcer | undefined {
    const vcs = this.vcsFor(repo);
    if (!workflowFor(kind).produces || !vcs.lock || !vcs.unlock) return undefined;
    const ctx: LockContext = {
      projectId: run.projectId,
      token,
      branch: this.lockScopeBranch(repo, run),
      taskId: run.anchor?.type === 'task' ? run.anchor.taskId : null,
    };
    return new LockEnforcer({
      root: worktree.localPath,
      lock: (paths) => vcs.lock!(worktree, paths, ctx),
      release: (paths) => vcs.unlock!(worktree, { paths }, ctx).then(() => undefined),
      onDeny: (paths, conflicts) => {
        this.log.info('lock hook denied an edit to a peer-held path', {
          runId: run.id,
          paths,
          holders: conflicts.map((c) => c.holderName ?? c.holder),
        });
        // Surface it in the run view (RUN-106) via the transcript pipeline (RUN-74): the human
        // watching sees WHY an edit was blocked, and by whom.
        this.transcript(run.id).milestone(
          `🔒 lock hook blocked an edit to ${paths.join(', ')} — held by ${conflicts
            .map((c) => c.holderName ?? c.holder)
            .join(', ')}`,
        );
      },
    });
  }

  /**
   * The hard floor (RUN-102): before a build's diff is made durable, acquire locks over EVERY
   * path it changed, as the run's holder. For a Claude build this is an idempotent renew of what
   * the reactive hook already took; for a Codex build (no in-process hook) it is the FIRST
   * acquisition — and a conflict means the run edited a path a peer holds, so the run is gated
   * rather than allowed to clobber. Daemon-side, so no token ever reaches the agent's shell.
   *
   * Returns the blocking conflicts, or [] when the floor passed / doesn't apply (no lock layer,
   * no changed-path enumeration, an empty diff, or locking disabled).
   */
  private async enforceLockFloor(
    repo: ResolvedRepo,
    run: Run,
    worktree: Workspace,
    token: string,
  ): Promise<LockConflict[]> {
    const vcs = this.vcsFor(repo);
    if (!vcs.lock || !vcs.changedPaths) return [];
    const paths = await vcs.changedPaths(worktree).catch(() => [] as string[]);
    if (!paths.length) return [];
    const ctx: LockContext = {
      projectId: run.projectId,
      token,
      branch: this.lockScopeBranch(repo, run),
      taskId: run.anchor?.type === 'task' ? run.anchor.taskId : null,
    };
    // A lock-service error must not gate a finished build: the reactive hook and dispatch-time
    // check are the primary layers, and failing a done build over a Noriq blip is worse than a
    // missed floor. Treat an error as "no conflict" (fail open), same posture as the hook.
    const outcome = await vcs
      .lock(worktree, paths, ctx)
      .catch(() => ({ ok: true, enabled: false, locks: [] }) as LockOutcome);
    return outcome.ok ? [] : outcome.conflicts;
  }

  /**
   * The branch a run forks from — and is measured against — instead of HEAD (RUN-82): the
   * resolved `[land]` target, when it is configured AND already exists (a predecessor landed on
   * it). This is what lets a later task in a plan see its predecessors' work: they land on the
   * plan's working branch, so a run based there starts from that accumulation and its landing
   * rebase is a trivial fast-forward. Null when no `[land]`, or the target does not exist yet
   * (the first task in a plan) — the run forks from HEAD, exactly as before. The dispatch's
   * targetBranch override is deliberately NOT applied here: it is validated at land time, and
   * forking from the computed plan branch keeps lease-time free of that decision.
   */
  private async planBase(repo: ResolvedRepo, run: Run): Promise<string | null> {
    const land = repo.manifest.land;
    if (!land) return null;
    const target = resolveLandBranch(land.branch, run.planKey);
    const exists = await this.vcsFor(repo)
      .targetExists(repo.root, target)
      .catch(() => false);
    return exists ? target : null;
  }

  /**
   * Serialize work per repo. rebase → verify → fast-forward is a read-modify-write of
   * one branch: two concurrent runs would each rebase onto the same tip, each verify a
   * combination the other never saw, and the loser's fast-forward would fail (or worse,
   * succeed against a tip that moved). Queueing costs a verify's wall-clock on the second
   * run and buys a correct answer.
   */
  private withRepoLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.repoLocks.get(root) ?? Promise.resolve();
    // Run next regardless of how the previous one settled — a failed landing must not
    // wedge the queue for every later run.
    const next = prev.then(fn, fn);
    this.repoLocks.set(
      root,
      next.catch(() => {}),
    );
    return next;
  }

  /**
   * Land a passing build: rebase onto the integration branch, re-verify the result, and
   * fast-forward it in. Every failure path leaves the run's branch intact — the work is
   * never lost, it just waits for a human.
   */
  private async landRun(ctx: {
    run: Run;
    repo: ResolvedRepo;
    worktree: Workspace;
    policy: LandPolicy;
    task: AnchorTask | null;
    driver: AgentDriver;
    permission: PermissionProfile;
    noriqMcp?: NoriqMcp;
    budget?: RunBudget;
    /** The run's cross-session tally (RUN-59): a conflict-resolution turn spends real tokens, and
     *  resolveConflict records them into it. */
    tally: RunTally;
    /** The still-live build session, when the run was started multiTurn — so a gate failure on
     *  the rebased result can be handed back rather than ending the run (RUN-29). */
    session?: DriverSession;
  }): Promise<LandOutcome> {
    const { run, repo, worktree, policy } = ctx;
    // Per-plan working branch (RUN-28): `[land].branch` may template `<planKey>`, so each plan
    // accumulates on its own branch and its merge request is one coherent body of work. The plan
    // is resolved server-side and frozen on the Run at dispatch — the daemon cannot work it out,
    // since a task-anchored run only knows its task and plan membership lives in phase_tasks.
    const computed = resolveLandBranch(policy.branch, run.planKey);

    // A dispatch may steer its own landing branch (RUN-41) — but only inside the envelope the
    // REPO allows. The manifest is the authority: the repo owner and whoever clicked dispatch are
    // not always the same person, and `[land]` authorises landing *here*, not landing anywhere.
    //
    // A refused override FAILS the run rather than quietly landing on the default. Someone asked
    // for a specific branch; silently doing something else with an agent's diff is how work ends
    // up somewhere nobody looked.
    let branch = computed;
    if (run.targetBranch && run.targetBranch !== computed) {
      const refusal = rejectTargetBranch(run.targetBranch, policy);
      if (refusal) {
        this.log.warn('refusing the dispatch’s branch override', {
          runId: run.id,
          target: run.targetBranch,
          refusal,
        });
        return { landed: false, branch: computed, reason: 'error', detail: refusal };
      }
      branch = run.targetBranch;
    }
    const vcs = this.vcsFor(repo);

    // First landing into this branch: fork it from the repo's declared main so the
    // integration line starts somewhere sane rather than from this run's base.
    if (!(await vcs.targetExists(repo.root, branch))) {
      const from = repo.manifest.defaultBranch ?? worktree.baseId;
      await vcs.createTarget(repo.root, branch, from);
      this.log.info('created the landing branch', { branch, from });
    }

    let rebase = await vcs.integrate(worktree, branch);
    let resolvedByAgent: boolean | undefined;
    let agentSaid = '';

    if (!rebase.ok) {
      const conflicts = rebase.conflicts;
      // A backend whose conflicts live server-side (Diversion) names the page a human
      // resolves them on. Its presence also means agent resolution CANNOT work there — the
      // conflict is not in the files — so it routes straight to the human path.
      const resolveUrl = rebase.resolveUrl;
      if (!policy.resolveConflicts || resolveUrl) {
        await vcs.abandonIntegrate(worktree);
        return { landed: false, branch, reason: 'conflict', conflicts, detail: resolveUrl };
      }
      this.log.info('rebase conflict — asking the build agent whether it is mechanical', {
        runId: run.id,
        conflicts,
      });
      const attempt = await this.resolveConflict(ctx, conflicts);
      agentSaid = attempt.text;
      resolvedByAgent = attempt.resolved;
      if (!attempt.resolved) {
        // The agent judged it needs a human. That is the correct answer, not a failure —
        // picking a winner would silently discard someone's work.
        await vcs.abandonIntegrate(worktree);
        return {
          landed: false,
          branch,
          reason: 'conflict',
          conflicts,
          resolvedByAgent: false,
          detail: agentSaid,
        };
      }
      const cont = await vcs.resumeIntegrate(worktree);
      if (!cont.ok) {
        await vcs.abandonIntegrate(worktree);
        return {
          landed: false,
          branch,
          reason: 'conflict',
          conflicts: cont.conflicts,
          resolvedByAgent: false,
          detail: `the agent said RESOLVED: YES but conflict markers remained in: ${cont.conflicts.join(', ')}`,
        };
      }
      rebase = { ok: true };
    }

    // The gate, on the REBASED result — the thing that will actually land. A failure is handed
    // back to the live agent (RUN-29), which matters most HERE: this verify runs on the rebase, so
    // the break may be a collision with work that landed while this run was going. That is exactly
    // the failure an agent can fix in context and a human should not have to re-derive.
    //
    // The CMD half only (RUN-61): the reviewer already judged intent before landing began, and a
    // rebase does not change what the diff means — it changes whether the COMBINATION still works,
    // which is precisely the deterministic command's question. Re-running an agent review inside
    // the repo lock would serialize every other run behind a judgment call that cannot change.
    const rebaseGate = cmdVerify(repo.manifest.verify);
    if (policy.onlyWhenVerifyPasses && rebaseGate) {
      const result = ctx.session
        ? await this.verifyWithFeedback({
            run: ctx.run,
            spec: rebaseGate,
            cwd: worktree.localPath,
            session: ctx.session,
            phase: 'landing', // this verify IS the landing pipeline; don't rename it mid-flight
          })
        : await runVerify(rebaseGate, worktree.localPath, { exec: this.deps.verifyExec });
      if (!result.passed) {
        return { landed: false, branch, reason: 'verify', detail: result.output, resolvedByAgent };
      }
      this.log.info('verify passed on the rebased result', { runId: run.id, branch });
      // A fix the live agent made to pass THIS gate lives only in the working tree, but publish
      // fast-forwards the branch's committed HEAD — so without folding it in, the landed (and, under
      // autoPush, pushed) result would silently drop the fix and land the broken combination the
      // gate just rejected. Same working-tree-vs-committed split as the inline reviewer's. A clean
      // tree (gate passed first try, or the sessionless runVerify path) is a no-op checkpoint.
      await vcs.checkpoint(worktree, runCommitMessage(run.id, 'landing fix')).catch((err) => {
        this.log.warn('could not commit the landing fix — the branch may fast-forward without it', {
          runId: run.id,
          err: String(err),
        });
        return false;
      });
    }

    const ff = await vcs.publish(worktree, branch);
    if (!ff.ok) {
      // Distinguish "the branch moved" (retryable) from "git refused" (needs a human) —
      // collapsing both into 'race' sends everyone hunting a concurrency bug that isn't
      // there, which is exactly what happened the first time this ran against `main`.
      return { landed: false, branch, reason: ff.reason, detail: ff.detail, resolvedByAgent };
    }

    // The work is landed. Everything below is about whether it also LEAVES this machine —
    // opt-in, default false, because it crosses the boundary the rest of the model rests on
    // (RUN-27). A failure here must never fail the run: the diff is on the branch either way,
    // and reporting "failed" would send someone hunting for work that is right there.
    if (!ctx.policy.autoPush) return { landed: true, branch, sha: ff.sha, resolvedByAgent };
    const push = await vcs.share(ctx.repo.root, branch);
    if (!push.ok) {
      this.log.warn('landed, but the push failed — the work is on the branch locally', {
        runId: ctx.run.id,
        branch,
        detail: push.detail,
      });
    }
    return {
      landed: true,
      branch,
      sha: ff.sha,
      resolvedByAgent,
      pushed: push.ok,
      ...(push.ok ? {} : { pushDetail: push.detail }),
    };
  }

  /**
   * Run the gate, and hand a failure back to the LIVE agent to fix (RUN-29).
   *
   * The daemon owns the verdict — it always did, for free, on the real thing. What changes is what
   * happens next: a failing gate used to end the run, so a human re-dispatched and a fresh agent
   * re-derived a failure whose exact output the daemon already had. Now the same session gets the
   * command, the code and the output, fixes it, and the gate re-runs.
   *
   * Bounded (RUN-21's K=2, since RUN-94 the repo may commit its own `[verify] maxRounds`): an
   * agent that cannot fix it in a couple of tries will usually keep spending, so the default
   * stays tight. The budget still applies underneath, so a loop cannot outrun its ceiling.
   */
  /** The verify command's outcome, in the transcript (RUN-74): a pass is one system line, a
   *  failure also carries the output tail in the 'verify' voice — the part a human reads. */
  private recordVerifyOutcome(
    transcript: RunTranscript,
    cmd: string,
    result: { passed: boolean; exitCode: number | null; timedOut: boolean; output: string },
  ): void {
    if (result.passed) {
      transcript.milestone(`verify command passed (\`${cmd}\`)`);
      return;
    }
    transcript.milestone(
      `verify command FAILED (\`${cmd}\`${result.timedOut ? ', timed out' : `, exit ${result.exitCode}`})`,
    );
    transcript.text('verify', result.output.slice(-4000) || '(no output)');
    transcript.flush();
  }

  private async verifyWithFeedback(ctx: {
    run: Run;
    spec: VerifySpec;
    cwd: string;
    session: DriverSession;
    /** The phase to return to between fix turns — 'verifying' on the standalone gate,
     *  'landing' when this runs inside the landing pipeline (RUN-31). */
    phase: RunPhase;
  }) {
    const transcript = this.transcript(ctx.run.id);
    let result = await runVerify(ctx.spec, ctx.cwd, { exec: this.deps.verifyExec });
    this.recordVerifyOutcome(transcript, ctx.spec.cmd, result);
    // continueWith is absent unless the run was started multiTurn — a run with no live session to
    // talk to (or a driver that cannot) simply gets the verdict, exactly as before.
    if (result.passed || !ctx.session.continueWith) return result;

    // The repo's committed bound, else the daemon's K=2 (RUN-94). 0 = a pure gate: the verdict
    // stands and no fix turn is spent — the repo said so, in the commit.
    const rounds = verifyFixRounds(ctx.spec);
    for (let attempt = 1; attempt <= rounds; attempt++) {
      this.log.info('verify failed — handing it back to the live agent', {
        runId: ctx.run.id,
        attempt,
        exitCode: result.exitCode,
      });
      // Tokens burn again on a fix turn, so the phase has to say 'agent' or the spend appears
      // to climb during "verifying" — the same lie this task exists to stop telling (RUN-31).
      this.deps.report(ctx.run.id, { status: 'running', phase: 'agent' });
      const exit = await ctx.session
        .continueWith(verifyFeedbackPrompt(ctx.spec, result, attempt))
        .catch((err): DriverExit | null => {
          this.log.warn('could not hand the failure back', { runId: ctx.run.id, err: String(err) });
          return null;
        });
      // The agent died, errored, or breached its budget trying to fix it. Its last verdict stands;
      // pushing more turns at a session that just failed is how a loop becomes a spend.
      if (!exit || exit.outcome !== 'done') return result;
      this.deps.report(ctx.run.id, { status: 'running', phase: ctx.phase });
      result = await runVerify(ctx.spec, ctx.cwd, { exec: this.deps.verifyExec });
      this.recordVerifyOutcome(transcript, ctx.spec.cmd, result);
      if (result.passed) {
        this.log.info('verify passed after the agent fixed it', { runId: ctx.run.id, attempt });
        return result;
      }
    }
    return result;
  }

  /**
   * The inline reviewer loop (RUN-61): a FRESH agent judges the diff against the intent; a FAIL
   * report is handed to the LIVE builder to fix, then a fresh reviewer looks again. Bounded by
   * `[verify.agent] maxRounds` for the same reason verifyWithFeedback is bounded by K=2, and the
   * budget still applies underneath.
   *
   * Every round gets a NEW reviewer session — never a continuation. A reviewer that has already
   * said FAIL and then watches the fix arrive is grading its own instructions; a fresh one judges
   * the work as it stands, which is the property the gate exists for.
   */
  private async reviewWithFeedback(ctx: {
    run: Run;
    repo: ResolvedRepo;
    worktree: Workspace;
    driver: AgentDriver;
    /** The live build session — the feedback target, NOT the reviewer's. */
    session: DriverSession;
    task: AnchorTask | null;
    /** The run's cross-session tally (RUN-59): each reviewer round records its spend here so the
     *  run's mix includes the reviewer's model, which may be a different vendor entirely. */
    tally: RunTally;
    /** Live accessor for the builder session's output, so the fix turn's structured RESPONSE
     *  block can be captured and fed into the next reviewer's ledger (RUN-79). */
    getSessionText?: () => string;
    budget?: RunBudget;
    /** A prior attempt's adjudication ledger, on a "continue a failed run" (RUN-92): the first
     *  fresh reviewer starts from the findings the earlier sitting already settled instead of
     *  relitigating them. Empty/absent on a normal run. */
    priorLedger?: LedgerEntry[];
  }): Promise<VerifyVerdict & { rounds: number; ledger: LedgerEntry[] }> {
    const reviewer = ctx.repo.manifest.verify?.agent;
    // The repo's committed round budget is the ceiling; a dispatch may only spend UP TO it.
    const manifestRounds = reviewer?.maxRounds ?? 0;
    // A "continue a failed run" dispatch (PLNR-180) carries budget.maxRounds — a fresh reviewer-
    // round budget for the kept worktree. The manifest clamps it: the server never reads the repo
    // owner's [verify.agent].maxRounds, so it can't be widened past what the owner committed
    // (RUN-91). Null (a normal dispatch) → the manifest's own value, unchanged.
    const maxRounds =
      ctx.budget?.maxRounds != null ? Math.min(ctx.budget.maxRounds, manifestRounds) : manifestRounds;
    // The same intent a dispatched verify run would get: the anchor task's text, else the brief.
    const intent = ctx.task
      ? `${ctx.task.key} — ${ctx.task.title}${ctx.task.body ? `\n\n${ctx.task.body}` : ''}`
      : ctx.run.brief;
    const floorCmd = cmdVerify(ctx.repo.manifest.verify);

    const transcript = this.transcript(ctx.run.id);

    // runReviewer inspects `git diff baseId...HEAD` — a COMMITTED range. Anything the builder
    // left only in the working tree is invisible to it: the pre-review deterministic floor may
    // already have handed a fix turn back (afterDriver), and every fix round below adds more.
    // Fold the current tree into the branch before each look, or the fresh reviewer re-reads the
    // SAME commit and re-reports the SAME findings every round while the floor — which shells out
    // over the working tree — silently passes. This is the exact split that failed RUN-56: verify
    // green, review red, forever. Committing here is also what lets a post-review landing rebase
    // the fixes in rather than fast-forwarding past uncommitted work.
    const foldFixIntoBranch = (label: string) =>
      this.vcsFor(ctx.repo)
        .checkpoint(ctx.worktree, runCommitMessage(ctx.run.id, label))
        .catch((err) => {
          this.log.warn('could not commit before re-review — the reviewer may not see the fix', {
            runId: ctx.run.id,
            err: String(err),
          });
          return false;
        });

    // The cross-round adjudication ledger (RUN-79): findings raised in earlier rounds plus the
    // builder's structured rebuttal to each, carried to every fresh reviewer so a settled finding
    // is verified rather than relitigated. Seeded from a prior attempt on a continue (RUN-92);
    // empty on the first look of a normal run.
    let ledger: LedgerEntry[] = ctx.priorLedger ?? [];

    await foldFixIntoBranch('pre-review checkpoint');
    let verdict = await this.runReviewer({ ...ctx, intent, round: 1, ledger });
    transcript.milestone(reviewVerdictMilestone(verdict, 1));
    if (verdict.passed || !ctx.session.continueWith) return { ...verdict, rounds: 0, ledger };

    for (let round = 1; round <= maxRounds; round++) {
      // Only a clear FAIL is a refusal. 'unknown' means NO JUDGMENT — the reviewer was killed,
      // crashed, breached its ceiling, or never wrote a VERDICT line (RUN-72's dogfood: a human
      // killing a hung codex reviewer read as "reviewer refused the work"). There are no
      // findings to hand the builder, and a fix turn against a non-report is pure spend.
      if (verdict.verdict !== 'fail') return { ...verdict, rounds: round - 1, ledger };
      this.log.info('reviewer refused the work — handing the report to the live agent', {
        runId: ctx.run.id,
        round,
        verdict: verdict.verdict,
      });
      transcript.milestone(
        `handing the reviewer's report to the live agent (fix round ${round}/${maxRounds})`,
      );
      // This round's findings, for the ledger — parsed from the reviewer's OWN output (its
      // numbered FINDING lines), so the builder's response can be paired to them by number.
      const findings = parseFindings(verdict.findings);
      // Tokens burn on a fix turn — the phase must say so (RUN-31).
      this.deps.report(ctx.run.id, { status: 'running', phase: 'agent' });
      // Snapshot the builder's output length BEFORE the fix turn; the delta after is exactly the
      // fix turn's text, from which we parse the structured RESPONSE block (RUN-79). Captured here,
      // before the floor re-verify below can append its own turns.
      const textBefore = ctx.getSessionText?.().length ?? 0;
      const exit = await ctx.session
        .continueWith(reviewerFeedbackPrompt(verdict.findings, round, maxRounds))
        .catch((err): DriverExit | null => {
          this.log.warn('could not hand the report back', { runId: ctx.run.id, err: String(err) });
          return null;
        });
      const fixText = ctx.getSessionText?.().slice(textBefore) ?? '';
      // Fold this round's findings + the builder's rebuttal into the ledger the NEXT reviewer sees.
      ledger = buildLedger(ledger, findings, parseFindingResponses(fixText), round);
      // The builder died, errored, or breached its budget on the fix. The reviewer's verdict
      // stands; pushing more turns at a session that just failed is how a loop becomes a spend.
      if (!exit || exit.outcome !== 'done') return { ...verdict, rounds: round, ledger };
      this.deps.report(ctx.run.id, { status: 'running', phase: 'verifying' });
      // A fix that satisfies the reviewer but breaks the typecheck must not slip through: the
      // deterministic floor re-runs (with its own bounded feedback) before the re-review.
      if (floorCmd) {
        const floor = await this.verifyWithFeedback({
          run: ctx.run,
          spec: floorCmd,
          cwd: ctx.worktree.localPath,
          session: ctx.session,
          phase: 'verifying',
        });
        if (!floor.passed) {
          return {
            verdict: 'fail',
            passed: false,
            rounds: round,
            ledger,
            findings: `the fix for the reviewer's findings broke the deterministic check (\`${floorCmd.cmd}\`):\n${floor.output.slice(-4000)}`,
          };
        }
      }
      // Commit the builder's fix (and any floor-fix turn above) so the fresh reviewer's
      // `baseId...HEAD` actually advances to include it — without this the re-review is a no-op.
      await foldFixIntoBranch(`reviewer fix round ${round}`);
      verdict = await this.runReviewer({ ...ctx, intent, round: round + 1, ledger });
      transcript.milestone(reviewVerdictMilestone(verdict, round + 1));
      if (verdict.passed) return { ...verdict, rounds: round, ledger };
    }
    return { ...verdict, rounds: maxRounds, ledger };
  }

  /** One fresh reviewer session over the build's worktree. Read-only profile, no Noriq
   *  credential, verdict parsed from its output. */
  private async runReviewer(ctx: {
    run: Run;
    repo: ResolvedRepo;
    worktree: Workspace;
    driver: AgentDriver;
    intent: string;
    budget?: RunBudget;
    /** Which look this is (1 = the first review) — transcript attribution (RUN-74). */
    round: number;
    /** The run's cross-session tally (RUN-59): this reviewer's spend is recorded into it under a
     *  per-round slot, so the run's total + mix count the reviewer's model. */
    tally: RunTally;
    /** Findings adjudicated in earlier rounds (RUN-79) — empty on the first look. */
    ledger?: LedgerEntry[];
  }): Promise<VerifyVerdict> {
    const manifest = ctx.repo.manifest;
    const reviewer = manifest.verify?.agent;
    // The reviewer as a coordinate (RUN-113): `[verify.agent].agent = "codex.gpt-5_6-sol.high"`
    // names tool+model+effort in one string and WINS over the legacy tool/model/effort fields.
    const reviewerCoord = reviewer?.agent ? tryParseCoordinate(reviewer.agent) : null;
    const reviewerTool = reviewerCoord?.tool ?? reviewer?.tool ?? null;
    // The reviewer's driver (RUN-70): the repo may put a different VENDOR's model in judgment —
    // the strongest form of the reviewer's independence. Fail-closed when the named tool has no
    // driver here: silently reviewing with the builder's own vendor would defeat the choice, the
    // same reasoning that makes an absent `shell` pin fail the cmd gate outright (RUN-42).
    const driver = reviewerTool ? this.deps.drivers[reviewerTool as AgentTool] : ctx.driver;
    if (!driver) {
      return {
        verdict: 'unknown',
        passed: false,
        findings: `the manifest asks for a '${reviewerTool}' reviewer but this runner has no such driver — install the tool on this machine or change [verify.agent]`,
      };
    }
    // The reviewer's own model/effort, else the repo's verify defaults — the same ladder a
    // dispatched verify run climbs (RUN-33), because this is the same role inlined. EXCEPT when
    // the reviewer names its own tool: model names are vendor-specific and [defaults.verify]
    // may name the other vendor's, so the fallback is severed and the tool's own default holds.
    // Effort still falls through — it is tool-agnostic intent, mapped per driver.
    const model =
      reviewerCoord?.model ??
      reviewer?.model ??
      (reviewerTool ? null : (manifest.defaults?.verify?.model ?? null));
    const effort = reviewerCoord?.effort ?? reviewer?.effort ?? manifest.defaults?.verify?.effort ?? null;
    // The diff since the fork, for a git-shaped backend. checkpoint() has already committed the
    // work, so a bare `git diff` shows nothing — the range is the review. A live backend
    // (Perforce/Diversion) has no git to ask; the prompt points at the working tree instead.
    const diffCmd =
      (this.vcsFor(ctx.repo).kind ?? 'git') === 'git' ? `git diff ${ctx.worktree.baseId}...HEAD` : undefined;
    let text = '';
    const session = this.startAgent(driver, {
      runId: `${ctx.run.id}:review`,
      kind: 'verify', // the reviewer IS a verify actor: executes but never edits
      cwd: ctx.worktree.localPath,
      prompt: assembleReviewerPrompt({
        intent: ctx.intent,
        diffCmd,
        verifyCmd: cmdVerify(manifest.verify)?.cmd ?? null,
        ledger: ctx.ledger,
      }),
      permission: manifest.permissions.verify,
      // NO noriqMcp, deliberately: one run holds one non-reissuable credential (RUN-43), so a
      // second inline identity cannot exist — and need not. The reviewer's output IS its report;
      // the daemon parses the verdict and posts the findings itself. This is also what makes
      // authorship separation absolute: the reviewer cannot claim, move, or comment as anyone.
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      budget: ctx.budget,
      handlers: {
        onText: (t) => {
          text += t;
          this.transcript(ctx.run.id).text('reviewer', t, ctx.round);
        },
        // The reviewer's LIVE ticks are deliberately NOT folded into the run frame (RUN-59). Its
        // mix is only known at its result, so folding a live tick (tokens, no mix) would strand a
        // climbing total next to a stale primary-only mix under the server's COALESCE. Its spend
        // joins the run at its result instead — see the tally.record below, reported as one jump.
      },
    });
    // Killable while it reviews, same as the conflict resolver — and unregistered after, for the
    // same leak (see resolveConflict).
    this.deps.steering?.register(ctx.run.id, session.session, session.stop);
    try {
      const exit = await session.done;
      // Record the reviewer's whole spend regardless of verdict (RUN-59): the tokens burned whether
      // it PASSed, FAILed, or crashed, and this may be a different vendor's model than the build.
      // A fresh session per round → its exit is that round's own cumulative, so a per-round slot
      // sums rather than overwrites. Then publish the run total, mix and all, as one step.
      ctx.tally.record(`review:${ctx.round}`, exit.telemetry);
      this.deps.report(ctx.run.id, { status: 'running', telemetry: ctx.tally.total() });
      if (exit.outcome !== 'done') {
        // Adversarial default: a reviewer that crashed or breached its ceiling cleared nothing.
        return {
          verdict: 'unknown',
          passed: false,
          findings: text.trim() || `the reviewer exited ${exit.reason ?? 'without a report'}`,
        };
      }
      return parseVerdict(text);
    } finally {
      this.deps.steering?.unregister(ctx.run.id);
    }
  }

  /** Give the build agent one bounded turn to resolve its own conflict, in place. */
  private async resolveConflict(
    ctx: {
      run: Run;
      repo: ResolvedRepo;
      worktree: Workspace;
      policy: LandPolicy;
      task: AnchorTask | null;
      driver: AgentDriver;
      permission: PermissionProfile;
      noriqMcp?: NoriqMcp;
      budget?: RunBudget;
      /** The run's cross-session tally (RUN-59): the conflict turn's spend records into it. */
      tally: RunTally;
    },
    conflicts: string[],
  ): Promise<{ resolved: boolean; text: string }> {
    let text = '';
    const session = this.startAgent(ctx.driver, {
      runId: `${ctx.run.id}:conflict`,
      kind: 'build', // it is editing its own diff — the build floor, nothing wider
      cwd: ctx.worktree.localPath,
      prompt: assembleConflictPrompt({
        conflicts,
        landBranch: ctx.policy.branch,
        task: ctx.task,
        verifyCmd: ctx.repo.manifest.verify?.cmd ?? null,
      }),
      permission: ctx.permission,
      noriqMcp: ctx.noriqMcp,
      budget: ctx.budget,
      handlers: {
        onText: (t) => {
          text += t;
        },
        // Like the reviewer (RUN-59): live ticks are not folded (mix unknown until the result), so
        // the run frame never shows a total climbing past a stale mix. The conflict turn's whole
        // spend joins the run at its result — recorded below and reported as one step.
      },
    });
    // Still killable while it works — and unregistered when it stops. supervise()'s own
    // `finally` already ran for this runId before landing began, so nothing else will
    // clean this up: without the finally below, SteeringBridge would hold a dead session
    // forever (hasRun() answering true, a later cancel interrupting an exited process),
    // leaking one entry per conflicted landing for the daemon's whole life.
    this.deps.steering?.register(ctx.run.id, session.session, session.stop);
    try {
      const exit = await session.done;
      // The conflict turn's spend joins the run whether or not it resolved anything (RUN-59) — the
      // tokens burned either way, on the build's own model (kind:'build', ctx.driver).
      ctx.tally.record('conflict', exit.telemetry);
      this.deps.report(ctx.run.id, { status: 'running', telemetry: ctx.tally.total() });
      if (exit.outcome !== 'done') {
        return { resolved: false, text: text || `agent exited ${exit.reason ?? 'badly'}` };
      }
      return { resolved: parseResolution(text), text };
    } finally {
      this.deps.steering?.unregister(ctx.run.id);
    }
  }

  /** The anchor task's text, best-effort: a lookup failure degrades to the bare id (the prompt
   *  renders it) rather than sinking the run. */
  private async resolveAnchorTask(taskId: string): Promise<AnchorTask | null> {
    if (!this.deps.resolveTask) return null;
    return this.deps.resolveTask(taskId).catch((err) => {
      this.log.warn('anchor task lookup failed — prompting with the bare id', {
        taskId,
        err: String(err),
      });
      return null;
    });
  }

  /**
   * Park a run whose agent stopped to ask a human something (RUN-30) — or don't, and let the
   * caller finalize it. Returns the exit to report iff the run parked.
   *
   * The check is a server read, not a pushed frame, and that is the whole trick: `raiseSignal`
   * commits `status='blocked'` before the `request_input` MCP call returns to the agent, so by
   * the time the agent's turn can possibly end, the row already says so. A frame racing that same
   * instant would sometimes lose — and losing means finalizing the run and reaping the worktree,
   * which is the exact failure this task exists to fix, except intermittent.
   */
  private async parkIfBlocked(ctx: {
    run: Run;
    repo: ResolvedRepo;
    worktree: Workspace;
    exit: DriverExit;
    session: DriverSession;
    runAgent: RunAgent;
    activeSeconds: number;
    /** The run's spend tallied across every session so far (RUN-59) — what the park persists so a
     *  resume can keep summing, and what the blocked report carries. */
    tally: RunTally;
    /** The run's trailing output, so the park report carries the last thing it said — usually
     *  the question itself, which is what a human opening the dashboard wants to read. */
    tail: string;
  }): Promise<DriverExit | null> {
    const { run, exit } = ctx;
    if (!this.deps.parked || !this.deps.getParkState) return null;
    // A budget breach or a crash is terminal even if a question is open: resuming a run that was
    // killed for overspending would hand it a fresh ceiling, which is the loophole in reverse.
    if (exit.outcome !== 'done') return null;

    const state = await this.deps.getParkState(run.id).catch((err) => {
      // Can't tell → finalize, the pre-RUN-30 behaviour. Parking on a guess would strand a
      // finished run as blocked forever, waiting for an answer to a question nobody asked.
      this.log.warn('could not check whether the run parked — treating it as finished', {
        runId: run.id,
        err: String(err),
      });
      return null;
    });
    if (!state?.blocked) return null;

    const sessionId = ctx.session.sessionId ?? exit.sessionId ?? null;
    if (!sessionId) {
      // Nothing to resume: this run can be reported blocked but never brought back, so parking
      // it would be a promise the daemon cannot keep. Fail it loudly with its context intact.
      this.log.warn('run asked a human but its tool has no resumable session — cannot park', {
        runId: run.id,
        tool: run.agentTool,
      });
      return null;
    }

    // The RUN's spend, not just this sitting's (RUN-59): the tally already folds any prior park and
    // every session that billed. Persisting the mix keeps a resume's breakdown summing to its total.
    const runSpend = ctx.tally.total();
    await this.deps.parked.park({
      run,
      sessionId,
      agentId: ctx.runAgent.agentId,
      agentLabel: ctx.runAgent.label,
      mcpToken: ctx.runAgent.token,
      workspace: ctx.worktree,
      spent: {
        tokens: totalTokens(runSpend),
        usd: runSpend.costUsd,
        ...(runSpend.modelUsage ? { modelUsage: runSpend.modelUsage } : {}),
      },
      activeSeconds: ctx.activeSeconds,
      parkedAt: new Date().toISOString(),
      question: state.question,
    });
    // The server already moved the row to blocked when the agent asked; reporting it back is what
    // makes the daemon's view and the dashboard's agree, and it carries the final spend.
    this.deps.report(run.id, { status: 'blocked', telemetry: runSpend, logTail: ctx.tail });
    this.log.info('run parked on a human — session ended, worktree kept', {
      runId: run.id,
      question: state.question?.slice(0, 80) ?? null,
    });
    // NOT terminal, and the worktree is deliberately left alone: it holds the work, and the
    // resumed session expects to find it exactly where it was. Carry the RUN's spend (tally total),
    // not this sitting's first-result snapshot, so a caller reading the returned exit agrees with
    // what was reported and parked (RUN-59).
    return { ...exit, outcome: 'done', isError: false, reason: 'parked', sessionId, telemetry: runSpend };
  }

  /**
   * Bring a parked run back with the human's answer (RUN-30).
   *
   * The payoff of the whole feature is here: the agent returns with everything it had already
   * worked out still in context, rather than a fresh run re-reading the repo to re-derive it.
   * Same worktree, same session, same identity — only the answer is new.
   *
   * Idempotent by construction: unpark() removes the entry before anything else, so a duplicate
   * resume (the WS frame AND the reconnect sweep can both fire for one answer) finds nothing and
   * returns null rather than starting a second process in the same worktree.
   */
  async resume(runId: string, answer: string): Promise<DriverExit | null> {
    const entry = await this.deps.parked?.unpark(runId);
    if (!entry) return null;
    const { run } = entry;
    const kind = run.kind as RunKind;
    const wf = workflowFor(kind); // the run's workflow (RUN-117): read its flags, don't compare kind

    const fail = (reason: string): DriverExit => {
      this.deps.report(run.id, { status: 'failed', exit: { outcome: 'failed', reason } });
      this.log.warn('could not resume a parked run', { runId, reason });
      return { outcome: 'failed', isError: true, reason, telemetry: zeroTelemetry() };
    };

    const repo = await this.deps.resolveRepo(run.repoRef);
    if (!repo) return fail(`repo not found for repoRef ${run.repoRef}`);
    const tool = resolveAgentTool(run); // the coordinate's tool (RUN-114), else agentTool
    const driver = this.deps.drivers[tool as AgentTool];
    if (!driver) return fail(`no driver for tool ${tool}`);
    if (!entry.sessionId) return fail('parked run has no session to resume');

    // The workspace is REUSED, never re-leased: it holds the work the agent did before it
    // asked, and the session it is about to resume expects to find it exactly as it left it.
    // Restored WHOLE from the park (RUN-50) — before that, this code hand-assembled a git-shaped
    // object with `baseSha: ''`, a lie that only worked because git's hasWork tolerates it.
    const worktree = entry.workspace;
    const runAgent: RunAgent = {
      agentId: entry.agentId,
      label: entry.agentLabel,
      token: entry.mcpToken,
      projectId: run.projectId,
      // The park stores no expiry and nothing downstream reads one; what actually bounds this
      // token's usefulness is DEFAULT_PARK_TTL_HOURS, kept well inside its real 7-day life.
      expiresIn: 0,
    };
    const noriqMcp: NoriqMcp = {
      url: `${this.deps.server.replace(/\/+$/, '')}/mcp`,
      token: entry.mcpToken,
    };

    this.deps.report(run.id, { status: 'running', phase: 'agent' });
    this.log.info('resuming a parked run', { runId, agentId: entry.agentId, session: entry.sessionId });

    let verifyText = '';
    let tail = '';
    // The resumed run's tally (RUN-59), SEEDED with the park's prior spend + mix so this sitting's
    // figures accumulate onto — and keep summing with — everything spent before the park.
    const tally = new RunTally();
    tally.seed('__prior__', telemetryFromSpent(entry.spent));
    const startedAt = Date.now();
    const budgetRun = this.startAgent(driver, {
      runId: run.id,
      kind,
      cwd: worktree.localPath,
      // The answer IS the prompt. No brief, no task text, no repo tour: the session already has
      // all of it, and re-sending it would both waste the context and confuse a conversation
      // that is mid-thought.
      prompt: resumePrompt(entry.question, answer),
      resumeSessionId: entry.sessionId,
      permission: clampPermissionToWorkflow(repo.manifest.permissions[kind], wf),
      noriqMcp,
      multiTurn: wf.produces && Boolean(repo.manifest.verify),
      // The same model it was running before it parked (RUN-33): the session being resumed is
      // that model's conversation, and quietly finishing the job on a different one would make
      // "resumed with its context intact" only half true.
      ...resolveModel(run, repo.manifest),
      // The REMAINDER, never a fresh ceiling — otherwise "ask a question" is a way to buy more
      // budget, and a run could park its way past any limit.
      budget: remainingBudget(mergeBudget(run.budget, this.deps.defaultBudget), entry),
      handlers: {
        onTelemetry: (t) => {
          tally.record('primary', t);
          this.deps.report(run.id, { status: 'running', telemetry: tally.total(), logTail: tail });
        },
        onText: (t) => {
          verifyText += t;
          tail = (tail + t).slice(-LOG_TAIL_CAP);
          this.transcript(run.id).text('agent', t);
        },
      },
    });
    this.deps.steering?.register(run.id, budgetRun.session, budgetRun.stop);
    let exit: DriverExit;
    try {
      exit = await budgetRun.done;
    } finally {
      this.deps.steering?.unregister(run.id);
    }
    // Record this sitting's terminal result (captures a driver/fake that emits no separate tick),
    // then the run's spend is cumulative across the park — the tally already folds the seeded prior.
    tally.record('primary', exit.telemetry);
    exit = { ...exit, telemetry: tally.total() };

    // It can park AGAIN. An agent given an answer may well have a second question, and there is
    // no reason the second one is worth less than the first.
    const reparked = await this.parkIfBlocked({
      run,
      repo,
      worktree,
      exit,
      session: budgetRun.session,
      runAgent,
      activeSeconds: entry.activeSeconds + (Date.now() - startedAt) / 1000,
      tally,
      tail,
    });
    if (reparked) return reparked;

    return this.afterDriver({
      run,
      repo,
      worktree,
      driver,
      permission: clampPermissionToWorkflow(repo.manifest.permissions[kind], wf),
      noriqMcp,
      task: run.anchor?.type === 'task' ? await this.resolveAnchorTask(run.anchor.taskId) : null,
      runAgent,
      session: budgetRun.session,
      stopSession: budgetRun.stop,
      exit,
      tally,
      verifyText,
      getSessionText: () => verifyText,
      tail,
    });
  }

  /**
   * Fail the parks that have waited too long to be worth resuming (RUN-30).
   *
   * Called on daemon start. A park pins a worktree and a branch while the base moves on
   * underneath it, and its agent's token expires at 7 days — so a park that sits forever is a
   * run that will resume into a world it does not recognise, holding a credential that no longer
   * works. The worktree is deliberately NOT reaped: it holds work that exists nowhere else.
   */
  async expireStaleParks(now = new Date()): Promise<number> {
    const all = (await this.deps.parked?.list()) ?? [];
    const stale = expiredParks(all, now, this.deps.parkTtlHours);
    for (const p of stale) {
      await this.deps.parked?.unpark(p.run.id);
      this.deps.report(p.run.id, {
        status: 'failed',
        exit: { outcome: 'failed', reason: 'park_expired' },
      });
      this.log.warn('parked run expired — nobody answered in time; its worktree is kept', {
        runId: p.run.id,
        parkedAt: p.parkedAt,
        worktree: p.workspace.localPath,
      });
    }
    return stale.length;
  }

  /** Run one dispatched Run to completion. Never throws — failures are reported. */
  async supervise(run: Run): Promise<DriverExit> {
    const fail = (reason: string): DriverExit => {
      this.deps.report(run.id, { status: 'failed', exit: { outcome: 'failed', reason } });
      return {
        outcome: 'failed',
        isError: true,
        reason,
        telemetry: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0,
          numTurns: 0,
        },
      };
    };

    const repo = await this.deps.resolveRepo(run.repoRef);
    if (!repo) return fail(`repo not found for repoRef ${run.repoRef}`);
    const tool = resolveAgentTool(run); // the coordinate's tool (RUN-114), else agentTool
    const driver = this.deps.drivers[tool as AgentTool];
    if (!driver) return fail(`no driver for tool ${tool}`);

    // Defense in depth (RUN-81): the server decides what to dispatch, but a bug in its phase/plan
    // gate — the removal of plan-task dependency edges left claim_task to enforce phase order
    // itself — must not let the daemon spawn an agent on a task that isn't unlocked yet (a phase-2
    // task offered while phase 1 is only in review). The gate lives server-side (phase_tasks), so
    // ask before spawning. This runs BEFORE the worktree lease so a declined run costs nothing.
    // Fail OPEN: only a definite `{ claimable: false }` stops the spawn; an absent probe or a
    // transient error leaves a legitimately-dispatched run untouched.
    if (run.anchor?.type === 'task' && this.deps.checkClaimable) {
      const gate = await this.deps.checkClaimable(run.anchor.taskId).catch((err) => {
        this.log.warn('claimability probe failed — spawning anyway (fail open)', {
          runId: run.id,
          err: String(err),
        });
        return null;
      });
      if (gate && !gate.claimable) {
        this.log.warn('anchor task is not claimable yet — declining to spawn (phase gate)', {
          runId: run.id,
          taskId: run.anchor.taskId,
          reason: gate.reason,
        });
        return fail(
          `anchor task ${run.anchor.taskId} is not claimable yet — its plan phase is not unlocked${
            gate.reason ? ` (${gate.reason})` : ''
          }; not spawning`,
        );
      }
    }

    const kind = run.kind as RunKind;
    const wf = workflowFor(kind); // the run's workflow (RUN-117): read its flags, don't compare kind
    const permission = clampPermissionToWorkflow(repo.manifest.permissions[kind], wf);
    // Only SCOPE gets a physically read-only checkout. A VERIFY agent is told to run the
    // suite and exercise the behavior, which needs a writable tree (node_modules, test
    // temp files, .wrangler state) — chmod'ing it read-only makes that instruction
    // impossible and reduces the adversarial gate to reading by eye. Verify is still
    // barred from EDITING by its profile (no Edit/Write tools + an enumerated bash
    // allowlist), which is the property that actually matters: it must not be able to
    // "fix" the code it is judging.
    const readOnly = !wf.worktreeWritable;

    // A VERIFY run leases from the BUILD it judges, not from HEAD — otherwise it gets a
    // pristine checkout, the `git diff` its prompt orders is empty, and it renders a
    // verdict on code nobody changed. `verifiesRunId` is what carries that link. By run id,
    // not by ref (RUN-50): how a run's work is NAMED — a branch, a shelved change — is the
    // backend's own convention, and this file no longer knows it.
    const verifiesRunId = wf.verifyActor ? (run.verifiesRunId ?? null) : null;

    // The plan's working branch, when this run belongs to one and it exists (RUN-82). A build
    // FORKS from it (so it sees predecessors' landed work and lands as a fast-forward); a verify
    // run is MEASURED against it (below). A verify run still leases from the build it judges
    // (fromRunId), so `fromTarget` is only meaningful — and only passed — for a build.
    const planBase = wf.usesPlanBase ? await this.planBase(repo, run) : null;

    let worktree: Workspace;
    try {
      worktree = await this.vcsFor(repo).lease(repo.root, run.id, {
        readOnly,
        fromRunId: verifiesRunId ?? undefined,
        ...(wf.produces && planBase ? { fromTarget: planBase } : {}),
      });
    } catch (err) {
      // A verify run whose build is gone (reaped, or built on another machine) must fail
      // loudly: silently falling back to HEAD would hand back a confident PASS on an empty
      // diff, which is worse than no gate at all.
      if (verifiesRunId) {
        return fail(
          `cannot verify ${verifiesRunId}: its work is not in this repo — ${(err as Error).message}`,
        );
      }
      return fail(`workspace setup failed: ${(err as Error).message}`);
    }
    // dispatched → running, and the first phase (RUN-31). The status half is the real
    // transition; the phase half rides the telemetry frame the daemon splits this into.
    this.deps.report(run.id, { status: 'running', worktreePath: worktree.localPath, phase: 'agent' });
    this.log.info('run started', { runId: run.id, kind, tool: run.agentTool, worktree: worktree.localPath });

    // Resolve the anchor task's text so the agent starts knowing the job. Best-effort:
    // a lookup failure degrades to the bare id rather than sinking the run.
    const task: AnchorTask | null =
      run.anchor?.type === 'task' ? await this.resolveAnchorTask(run.anchor.taskId) : null;

    // The agent's identity AND its Noriq access, in one step (RUN-43). The daemon creates
    // the agent up front and receives a token bound to it: the process cannot be anyone
    // else, and we know who our own child is without scraping its output for an `agt_`.
    //
    // This token is per-run and least-privilege. It replaces handing every spawned process
    // the DAEMON's own token — the credential that can register runners and reach every
    // project its human can. The server revokes this one when the Run goes terminal.
    //
    // Without an identity the agent cannot claim or report, so fail loudly rather than
    // spawn something that can only no-op.
    let runAgent: RunAgent | undefined;
    let noriqMcp: NoriqMcp | undefined;
    if (this.deps.createRunAgent) {
      try {
        // Declare the kind's Noriq tool floor with the identity (RUN-47): the server then
        // advertises exactly what the driver will permit, so the model never sees a tool it
        // cannot call. Same list the driver enforces — one policy, two views.
        runAgent = await this.deps.createRunAgent(run.id, {
          label: `${run.kind}-${run.id.slice(-6)}`,
          allowedTools: noriqToolNamesFor(run.kind),
        });
        noriqMcp = { url: `${this.deps.server.replace(/\/+$/, '')}/mcp`, token: runAgent.token };
        // Say who is working this Run as soon as we know — which is now BEFORE the process
        // starts, rather than never.
        this.deps.report(run.id, { status: 'running', agentId: runAgent.agentId });
        this.log.info('run agent created', {
          runId: run.id,
          agentId: runAgent.agentId,
          label: runAgent.label,
        });
      } catch (err) {
        await this.vcsFor(repo)
          .dispose(worktree)
          .catch(() => {});
        return fail(`could not create the Noriq agent for this run: ${(err as Error).message}`);
      }
    }

    // Branching from the build's branch isn't enough on its own: that checkout is CLEAN,
    // so a bare `git diff` still shows nothing. Point the verifier at the range that is
    // actually under review — everything the build added since it forked. Three dots =
    // "since the merge base", so an unrelated main moving on doesn't pollute the review.
    // The base is the plan's working branch when the build forked from one (RUN-82) — else the
    // build measured against main would re-include every predecessor task's landed work — falling
    // back to the default branch. Only a git-shaped backend gets a diff command; a live backend
    // (Perforce/Diversion) has no `git diff` to run, so the prompt falls back to inspecting the
    // workspace's files (same gate the inline reviewer uses).
    const diffCmd =
      verifiesRunId && (this.vcsFor(repo).kind ?? 'git') === 'git'
        ? `git diff ${planBase ?? repo.manifest.defaultBranch ?? worktree.baseId}...HEAD`
        : undefined;

    // No identity → no prompt worth sending. assemblePrompt now TELLS the agent who it is,
    // which it can only do if the daemon actually made someone.
    if (!runAgent) {
      await this.vcsFor(repo)
        .dispose(worktree)
        .catch(() => {});
      return fail('no Noriq identity for this run — the daemon must create the agent before spawning it');
    }

    // Dispatch-time predictive locking (RUN-103): with a DECLARED scope, take its locks now — as
    // the run's holder, before the agent starts — and REFUSE a dispatch that clashes rather than
    // race two agents onto the same files. Runs here (not the RUN-81 pre-lease gate) because a
    // lock needs the run's agent token, which is only minted above; a refusal disposes the
    // just-leased worktree. No-op without a resolver / declared scope (the common case today), so
    // the reactive hook + hard floor stay the guarantee.
    if (wf.produces && this.deps.resolveLockScope && this.vcsFor(repo).lock) {
      const scope = (await this.deps.resolveLockScope(run)) ?? [];
      if (scope.length) {
        const ctx: LockContext = {
          projectId: run.projectId,
          token: runAgent.token,
          branch: this.lockScopeBranch(repo, run),
          taskId: run.anchor?.type === 'task' ? run.anchor.taskId : null,
        };
        const outcome = await this.vcsFor(repo).lock!(worktree, scope, ctx).catch(
          () => ({ ok: true, enabled: false, locks: [] }) as LockOutcome,
        );
        if (!outcome.ok) {
          this.log.warn('predictive lock refused the dispatch — its declared scope clashes', {
            runId: run.id,
            holders: outcome.conflicts.map((c) => c.holderName ?? c.holder),
          });
          this.transcript(run.id).milestone(
            `🔒 predictive lock refused this dispatch — its declared scope ${outcome.conflicts
              .map((c) => c.path)
              .join(', ')} is held by another run`,
          );
          if (run.anchor?.type === 'task') {
            this.deps.postComment?.(run.projectId, run.anchor.taskId, lockFloorComment(outcome.conflicts));
          }
          await this.vcsFor(repo)
            .dispose(worktree)
            .catch(() => {});
          return fail(
            `declared file scope is locked by another run (${outcome.conflicts
              .map((c) => c.path)
              .join(', ')}); not spawning`,
          );
        }
      }
    }

    const prompt = assemblePrompt(run, repo.manifest, {
      agent: runAgent,
      server: this.deps.server,
      task,
      diffCmd,
    });
    let verifyText = ''; // accumulated agent output — the verify verdict is parsed from it
    let tail = ''; // rolling tail of the same output, capped, for the live dashboard (RUN-22)
    // Every session that bills to this run records into one tally (RUN-59), so the run's spend AND
    // its model mix are the sum across sessions, always consistent with each other.
    const tally = new RunTally();
    // Continue a failed run (RUN-92). The lease above already ADOPTED the kept worktree (RUN-91);
    // this adds the two things git cannot carry across the fail→continue boundary: the prior spend
    // (re-seeded so this sitting's reported figures stay CUMULATIVE rather than overwriting the
    // server's totals with only what this sitting spends) and the adjudication ledger (handed to
    // the reviewer below so it does not relitigate what the earlier sitting settled).
    const continued = (await this.deps.continuable?.get(run.id)) ?? null;
    if (continued) {
      tally.seed('__prior__', telemetryFromSpent(continued.spent));
      this.log.info('continuing a failed run — re-seeded prior spend and ledger', {
        runId: run.id,
        priorTokens: continued.spent.tokens,
        ledgerEntries: continued.ledger.length,
      });
    }
    // Active time, for a park's wall-clock accounting (RUN-30): the wait for a human is not the
    // run's, so only the stretch from here to the session's end counts against maxDurationSeconds.
    const startedAt = Date.now();
    const budgetRun = this.startAgent(driver, {
      runId: run.id,
      kind,
      cwd: worktree.localPath,
      prompt,
      permission,
      noriqMcp,
      // Reactive file locking (RUN-101): a build agent's edits go through a PreToolUse hook that
      // locks each path as the run's holder and denies one a peer holds. Absent for scope/verify
      // (no writes) and for a backend with no lock layer — and only handed to a driver that can
      // actually wire it (RUN-110): a driver without in-process hooks (Codex) relies on the hard
      // floor instead, so passing it one it would silently drop is just a lie in the start opts.
      lockEnforcer: driver.capabilities.toolHooks
        ? this.lockEnforcerFor(repo, run, worktree, kind, runAgent.token)
        : undefined,
      // Keep the session alive past its first result ONLY when a feedback loop is possible: a
      // build, with a verify command to fail. Scope and verify runs want today's behaviour —
      // finish and close — and a session nobody closes hangs the daemon (see the finally below).
      multiTurn: wf.produces && Boolean(repo.manifest.verify),
      // Dispatch → repo [defaults] → the tool's own (RUN-33). The driver seam for `model` has
      // existed since RUN-12 and was dead: nothing ever set it, because Run had no field for it.
      ...resolveModel(run, repo.manifest),
      budget: mergeBudget(run.budget, this.deps.defaultBudget) ?? undefined,
      handlers: {
        // Each telemetry tick carries the current spend AND the latest log tail, so the dashboard
        // sees burn + output without a status transition per tick. The primary session — including
        // its fix turns, which stream through these same handlers — records into the tally, and the
        // reported figure is the RUN total (RUN-59). A live tick carries no mix (only a result
        // knows the split), so the mix appears when the result lands, not before.
        onTelemetry: (t) => {
          tally.record('primary', t);
          this.deps.report(run.id, { status: 'running', telemetry: tally.total(), logTail: tail });
        },
        onText: (t) => {
          verifyText += t;
          tail = (tail + t).slice(-LOG_TAIL_CAP);
          this.transcript(run.id).text('agent', t);
        },
      },
    });
    // Steerable + cancellable while it runs (RUN-16/18).
    this.deps.steering?.register(run.id, budgetRun.session, budgetRun.stop);

    let exit: DriverExit;
    try {
      exit = await budgetRun.done;
    } finally {
      this.deps.steering?.unregister(run.id);
    }
    // The terminal result, recorded authoritatively (RUN-59): a driver whose result carries a mix
    // but emits no separate onTelemetry tick (or a fake in tests) is captured here. Fix turns that
    // run later stream through the handler above and overwrite this with their fuller cumulative.
    tally.record('primary', exit.telemetry);

    // The session ending is ambiguous (RUN-30): an agent that asked a human a question ends its
    // turn exactly like one that finished. Only the server knows which, so ask it before treating
    // this as terminal — everything below destroys context that a parked run still needs.
    const parked = await this.parkIfBlocked({
      run,
      repo,
      worktree,
      exit,
      session: budgetRun.session,
      runAgent,
      activeSeconds: (Date.now() - startedAt) / 1000,
      tally,
      tail,
    });
    if (parked) return parked;

    return this.afterDriver({
      run,
      repo,
      worktree,
      driver,
      permission,
      noriqMcp,
      task,
      runAgent,
      session: budgetRun.session,
      stopSession: budgetRun.stop,
      exit,
      tally,
      verifyText,
      getSessionText: () => verifyText,
      tail,
      continued,
    });
  }

  /**
   * The pipeline AFTER the agent stops talking: commit → land → verify → report → reap.
   *
   * Its own method because a parked run re-enters here (RUN-30). `supervise` runs it once for a
   * run that finished in one sitting; `resume` runs it for one that stopped to ask a question and
   * came back — possibly days later, in a different daemon process. Both must gate identically:
   * a run that asked for help is not a run that gets to skip the gate.
   */
  private async afterDriver(ctx: {
    run: Run;
    repo: ResolvedRepo;
    worktree: Workspace;
    driver: AgentDriver;
    permission: PermissionProfile;
    noriqMcp?: NoriqMcp;
    task: AnchorTask | null;
    runAgent: RunAgent;
    session: DriverSession;
    stopSession: () => Promise<void>;
    exit: DriverExit;
    /** The run's cross-session spend tally (RUN-59) — the reviewer and conflict-resolver sessions
     *  this method spawns record into it, and the terminal report is its total. */
    tally: RunTally;
    verifyText: string;
    /** Live accessor for the session's accumulated output — NOT the `verifyText` snapshot, which
     *  froze when the driver's first turn ended. reviewWithFeedback reads it around each fix turn
     *  to capture the builder's structured response block (RUN-79). */
    getSessionText?: () => string;
    tail: string;
    /** The prior sitting's continuation state on a "continue a failed run" (RUN-92): its ledger
     *  seeds the reviewer, and it decides whether the terminal record is refreshed or dropped. */
    continued?: ContinuableRun | null;
  }): Promise<DriverExit> {
    const { run, repo, worktree, driver, permission, noriqMcp, task, runAgent, tally, verifyText, tail } =
      ctx;
    const continued = ctx.continued ?? null;
    const kind = run.kind as RunKind;
    const wf = workflowFor(kind); // the run's workflow (RUN-117): read its flags, don't compare kind
    // The ledger carried into the terminal continuable record (RUN-92): the reviewer's final one
    // when it runs, else whatever a prior sitting left — a pre-review failure adds nothing.
    let latestLedger: LedgerEntry[] = continued?.ledger ?? [];
    const budgetRun = { session: ctx.session, stop: ctx.stopSession };
    let exit = ctx.exit;
    // Whether the DRIVER succeeded — drives worktree retention (a build with a diff
    // is kept for the human even if verify then fails).
    let driverSucceeded = exit.outcome === 'done';
    // Whether the diff reached the integration branch. Once it has, the run's worktree
    // and throwaway branch are disposable — that is what stops them accumulating.
    let landed = false;

    // A build that changed NOTHING is not a success. An agent that bailed (blocked,
    // refused, or ran out of road) exits clean with a pristine worktree; verifying that
    // burns the full suite to re-test untouched HEAD, and a PASS would land the Run in
    // review as "done" with an empty diff — a silent no-op reported as success.
    if (wf.produces && driverSucceeded) {
      const changed = await this.vcsFor(repo)
        .hasWork(worktree)
        .catch(() => true); // can't tell → assume it worked and let verify decide
      if (!changed) {
        this.log.warn('build produced no changes — skipping verify, not a success', { runId: run.id });
        exit = { ...exit, outcome: 'failed', isError: true, reason: 'no_changes' };
        driverSucceeded = false;
      }
    }

    // Make the diff durable BEFORE anything else can touch the worktree. The agent may
    // not have (or use) git permissions, and loose files are destroyed by the next
    // `worktree remove --force` — including the crash-safe reap on the daemon's next
    // start. Committing here is what makes "a review diff on the branch" true.
    if (wf.produces && driverSucceeded) {
      const label = task ? `${task.key} ${task.title}` : (run.brief || run.id).slice(0, 60);
      await this.vcsFor(repo)
        .checkpoint(worktree, runCommitMessage(run.id, label))
        .then((committed) => {
          if (committed)
            this.log.info('committed the run diff to its branch', {
              runId: run.id,
              workRef: worktree.workRef,
            });
        })
        .catch((err) =>
          this.log.error('could not commit the run diff — it stays uncommitted', {
            runId: run.id,
            err: String(err),
          }),
        );

      // The hard floor (RUN-102), AFTER the checkpoint so the diff is preserved on the branch for
      // a human even when gated: acquire locks over everything this build changed. A conflict
      // means it touched a path a peer holds (the reactive hook missed it, or this is Codex) —
      // gate it, do not land it. Marking exit `failed{lock}` (while keeping driverSucceeded, so
      // the diff + worktree are kept like a verify failure) makes every gate below skip: they key
      // off `exit.outcome === 'done'`.
      const floorConflicts = await this.enforceLockFloor(repo, run, worktree, ctx.runAgent.token);
      if (floorConflicts.length) {
        this.log.warn('hard lock floor gated the build — it changed paths a peer holds', {
          runId: run.id,
          holders: floorConflicts.map((c) => c.holderName ?? c.holder),
        });
        this.transcript(run.id).milestone(
          `🔒 hard lock floor gated this build — it changed ${floorConflicts
            .map((c) => c.path)
            .join(', ')}, held by ${floorConflicts.map((c) => c.holderName ?? c.holder).join(', ')}`,
        );
        if (run.anchor?.type === 'task') {
          this.deps.postComment?.(run.projectId, run.anchor.taskId, lockFloorComment(floorConflicts));
        }
        // Failed, but driverSucceeded STAYS true — so the committed diff and its worktree are
        // kept for a human, exactly like a verify failure. The gates below all key off
        // `exit.outcome === 'done'`, so none of them run; landing is likewise skipped.
        exit = { ...exit, outcome: 'failed', isError: true, reason: 'lock' };
      }
    }

    // ── Landing (opt-in via the manifest's [land]) ────────────────────────────────
    // Rebase onto the integration tip → verify THERE → fast-forward in → reap. Verify
    // runs after the rebase on purpose: two runs can each be green at their own fork
    // point and broken together, and a gate that never sees the combination can't catch
    // it. Serialized per repo, because rebase→verify→land is a read-modify-write of one
    // branch and two runs interleaving would land untested combinations.
    const landPolicy = wf.produces && driverSucceeded ? (repo.manifest.land ?? null) : null;
    const floorCmd = cmdVerify(repo.manifest.verify);

    // Deterministic verify floor (RUN-19), when NOT landing — the landing pipeline verifies the
    // REBASED result instead, which is strictly the better question. Runs BEFORE the reviewer
    // (RUN-61): the command is cheap and deterministic, so it screens out work not worth an
    // agent's review — the same reason CI runs the linter before the humans arrive.
    if (wf.produces && driverSucceeded && exit.outcome === 'done' && !landPolicy && floorCmd) {
      // Same silence as landing, and the longer of the two in practice: the full suite with
      // no token burn to show for it (RUN-31). verifyWithFeedback can also hand work BACK to
      // the agent on a failure, which flips the phase to 'agent' again — see below.
      this.deps.report(run.id, { status: 'running', phase: 'verifying' });
      const result = await this.verifyWithFeedback({
        run,
        spec: floorCmd,
        cwd: worktree.localPath,
        session: budgetRun.session,
        phase: 'verifying',
      });
      if (result.passed) {
        this.log.info('deterministic verify passed', { runId: run.id });
      } else {
        this.log.warn('deterministic verify FAILED — run gated (not done)', {
          runId: run.id,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
        });
        if (run.anchor?.type === 'task') {
          this.deps.postComment?.(run.projectId, run.anchor.taskId, verifyFailureComment(floorCmd, result));
        }
        exit = { ...exit, outcome: 'failed', isError: true, reason: 'verify' };
      }
    }

    // Inline reviewer (RUN-61): a FRESH agent judges whether the diff satisfies the INTENT — the
    // question the command cannot ask. Before landing, deliberately: a rebase changes whether the
    // combination still builds (the command's question, asked post-rebase inside the lock), never
    // what the diff means — and an agent review inside the repo lock would serialize every other
    // run on this repo behind a judgment that cannot change.
    if (wf.produces && driverSucceeded && exit.outcome === 'done' && repo.manifest.verify?.agent) {
      this.deps.report(run.id, { status: 'running', phase: 'verifying' });
      const review = await this.reviewWithFeedback({
        run,
        repo,
        worktree,
        driver,
        session: budgetRun.session,
        task,
        tally,
        getSessionText: ctx.getSessionText,
        budget: mergeBudget(run.budget, this.deps.defaultBudget) ?? undefined,
        priorLedger: continued?.ledger,
      });
      latestLedger = review.ledger; // the freshest adjudication state, for the continuable record
      if (review.passed) {
        this.log.info('inline reviewer PASS', { runId: run.id, rounds: review.rounds });
      } else if (review.verdict === 'fail') {
        this.log.warn('inline reviewer refused the work — run gated (not done)', {
          runId: run.id,
          verdict: review.verdict,
          rounds: review.rounds,
        });
        if (run.anchor?.type === 'task') {
          this.deps.postComment?.(
            run.projectId,
            run.anchor.taskId,
            reviewerRejectionComment(review.findings, review.rounds),
          );
        }
        exit = { ...exit, outcome: 'failed', isError: true, reason: 'review' };
      } else {
        // 'unknown' = the gate never rendered a judgment (reviewer killed, crashed, budget
        // breach, missing driver, no VERDICT line). NOT a refusal — saying "the reviewer
        // found problems" about a reviewer somebody killed is a lie in both directions: it
        // maligns the diff and it hides the infrastructure failure. The run still cannot
        // pass — silence must not read as a gate that isn't there — but the reason and the
        // comment say what actually happened, and no fix rounds were burned on a non-report.
        this.log.warn('inline reviewer rendered NO verdict — run gated, not judged', {
          runId: run.id,
          rounds: review.rounds,
        });
        if (run.anchor?.type === 'task') {
          this.deps.postComment?.(
            run.projectId,
            run.anchor.taskId,
            reviewerNoVerdictComment(review.findings),
          );
        }
        exit = { ...exit, outcome: 'failed', isError: true, reason: 'review:no-verdict' };
      }
    }

    if (landPolicy && exit.outcome === 'done') {
      // The agent process is gone and the spend stops moving here, so without this the
      // dashboard shows "running" through a rebase → verify → fast-forward that can take a
      // minute — and a queue behind the repo lock makes it longer (RUN-31).
      this.deps.report(run.id, { status: 'running', phase: 'landing' });
      const outcome = await this.withRepoLock(repo.root, () =>
        this.landRun({
          run,
          repo,
          worktree,
          policy: landPolicy,
          session: budgetRun.session,
          task,
          driver,
          permission,
          noriqMcp,
          tally,
          budget: mergeBudget(run.budget, this.deps.defaultBudget) ?? undefined,
        }),
      ).catch(
        (err): LandOutcome => ({
          landed: false,
          branch: landPolicy.branch,
          reason: 'error',
          detail: String(err),
        }),
      );

      if (outcome.landed) {
        this.log.info('landed', {
          runId: run.id,
          branch: outcome.branch,
          sha: outcome.sha,
          resolvedByAgent: outcome.resolvedByAgent,
        });
      } else {
        this.log.warn('could not land — the diff stays on its branch', {
          runId: run.id,
          branch: outcome.branch,
          reason: outcome.reason,
        });
        if (run.anchor?.type === 'task') {
          this.deps.postComment?.(run.projectId, run.anchor.taskId, landFailureComment(outcome, run.id));
        }
        // The gate rejecting the COMBINATION is a real failure, same as rejecting the
        // change alone — the run does not reach done either way.
        // NB: deliberately does NOT clear driverSucceeded — that flag decides whether the
        // worktree survives, and an unlanded diff is exactly what a human still needs.
        exit = { ...exit, outcome: 'failed', isError: true, reason: `land:${outcome.reason}` };
      }
      landed = outcome.landed;
    }

    // Every gate that could hand work back has now run, so the session has no more work to do.
    // It MUST be closed explicitly: a multiTurn run deliberately does not self-close on its first
    // result (that is the whole point — RUN-29), so nothing else ever shuts the SDK query down,
    // and an open one keeps the daemon's event loop alive forever. Best-effort: a session that is
    // already gone is the normal case for every single-turn run.
    await budgetRun.stop().catch(() => {});

    // Independent verify agent (RUN-20): the run's own output IS the verdict. A
    // FAIL (or an ambiguous/absent verdict) gates the phase — the run does not
    // reach done and the findings are surfaced.
    if (wf.verifyActor && driverSucceeded) {
      const v = parseVerdict(verifyText);
      if (v.passed) {
        this.log.info('verify agent PASS', { runId: run.id });
      } else {
        this.log.warn('verify agent gate — phase not cleared', { runId: run.id, verdict: v.verdict });
        if (run.anchor?.type === 'task') {
          this.deps.postComment?.(run.projectId, run.anchor.taskId, verifyAgentComment(v));
        }
        exit = { ...exit, outcome: 'failed', isError: true, reason: 'verify_agent' };
      }
    }

    // The run's true spend + mix, summed across every session that billed (RUN-59): the primary
    // (with its fix turns), every reviewer round, the conflict resolver, and any prior park — all
    // recorded into the tally by now. This supersedes the primary session's own first-result
    // snapshot (`exit.telemetry`), which missed both the sub-sessions and the fix turns.
    exit = { ...exit, telemetry: tally.total() };
    this.deps.report(run.id, {
      status: exit.outcome,
      agentId: runAgent.agentId,
      telemetry: exit.telemetry,
      logTail: tail,
      exit: { outcome: exit.outcome, reason: exit.reason },
    });

    // Continue a failed run (RUN-92): a gate-failed build keeps its work (the same condition the
    // dispose below skips on), so record what a continue must inherit that git cannot carry —
    // the CUMULATIVE spend (tally.total already folds any prior sitting, so re-seeding the next
    // continue from it never double-counts: `put` replaces, never adds) and the reviewer's final
    // ledger. Any OTHER terminal — done, landed, a driver failure, a non-build — leaves nothing to
    // continue, so drop a record a prior failed sitting may have left (this continuation resolved it).
    if (this.deps.continuable) {
      if (wf.produces && exit.outcome === 'failed' && driverSucceeded && !landed) {
        const spent = exit.telemetry;
        await this.deps.continuable
          .put({
            runId: run.id,
            spent: {
              tokens: totalTokens(spent),
              usd: spent.costUsd,
              ...(spent.modelUsage ? { modelUsage: spent.modelUsage } : {}),
            },
            ledger: latestLedger,
            failedAt: new Date().toISOString(),
          })
          .catch((err) =>
            this.log.warn('could not persist continuation state', { runId: run.id, err: String(err) }),
          );
      } else {
        await this.deps.continuable.remove(run.id).catch(() => {});
      }
    }

    // Keep only what a human still has to act on: a build whose diff did NOT land. Once
    // it is on the integration branch the worktree and its throwaway branch are dead
    // weight — reaping them here is what keeps ~/.noriq/worktrees from growing one
    // directory per run forever. Scope/verify and driver failures are cleaned up as before.
    //
    // EXCEPT on a backend whose dispose preserves the work itself (RUN-52): there, skipping
    // dispose is not "keep the work", it is "hold the pool-of-1 lease forever" — the next run
    // on this repo would wait on a workspace nobody will ever hand back. Such a backend
    // shelves/keeps the work server-side inside dispose, so disposing IS keeping.
    const vcsOut = this.vcsFor(repo);
    // Release the run's locks on terminal (RUN-104), UNCONDITIONALLY — a kept-work build skips
    // dispose (below), but its locks must still free so a peer waiting on those files unblocks.
    // Placed AFTER landing on purpose (RUN-105): the locks are HELD THROUGH the rebase→verify→
    // fast-forward, so a second run in another worktree on this repo cannot grab a file mid-merge
    // and race it — locks live server-side, so runs across worktrees see each other's holds — and
    // they release only once the work is actually on the integration branch.
    // Best-effort: the server also auto-releases on task settle and via TTL, so a miss here (a
    // crash before this line, a transient error) costs promptness, never correctness — the same
    // reason a daemon RESTART needs no lock reconcile of its own: the existing orphaned-run
    // reconcile fails those runs, which settles their tasks, which releases their locks server-side.
    if (vcsOut.releaseRunLocks) {
      await vcsOut
        .releaseRunLocks(worktree, {
          projectId: run.projectId,
          token: ctx.runAgent.token,
          branch: this.lockScopeBranch(repo, run),
          taskId: run.anchor?.type === 'task' ? run.anchor.taskId : null,
        })
        .catch((err) =>
          this.log.warn('lock release on terminal failed', { runId: run.id, err: String(err) }),
        );
    }
    if (!(wf.produces && driverSucceeded && !landed) || vcsOut.disposePreservesWork) {
      await vcsOut
        .dispose(worktree)
        .catch((err) => this.log.warn('worktree cleanup failed', { err: String(err) }));
    }
    this.log.info('run finished', { runId: run.id, outcome: exit.outcome, reason: exit.reason });
    // Close the transcript with the outcome, so the stream a human reads actually ENDS (RUN-74).
    const transcript = this.transcripts.get(run.id);
    if (transcript) {
      transcript.milestone(`run finished: ${exit.outcome}${exit.reason ? ` — ${exit.reason}` : ''}`);
      transcript.end();
      this.transcripts.delete(run.id);
    }
    return exit;
  }
}

/** One line per reviewer look, in the transcript's system voice (RUN-74). */
function reviewVerdictMilestone(v: VerifyVerdict, round: number): string {
  if (v.passed) return `reviewer verdict: PASS (round ${round})`;
  if (v.verdict === 'fail') return `reviewer verdict: FAIL (round ${round})`;
  return `reviewer rendered NO verdict (round ${round}) — stopped, crashed, or wrote no VERDICT line`;
}
