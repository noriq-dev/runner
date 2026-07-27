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
import type { ExecutionSpec } from '@noriq-dev/shared';
import { UNATTRIBUTED_MODEL_ID } from '@noriq-dev/shared';
import { type LedgerEntry, buildLedger, parseFindingResponses, parseFindings } from './adjudication';
import { type AgentCoordinate, coordinateFromParts, tryParseCoordinate } from './agent-coordinate';
import type { ParkState, RunAgent } from './client';
import type { ContinuableRun, ContinuableStore } from './continuable';
import { type BudgetRun, monotonicMs, superviseBudget, totalTokens } from './drivers/budget';
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
import { type SpecPathProbe, checkExecutionSpec } from './execution-spec';
import {
  type LandOutcome,
  assembleConflictPrompt,
  parseResolution,
  rejectTargetBranch,
  resolveLandBranch,
} from './land';
import type { LockConflict } from './lock-client';
import { LockEnforcer } from './lock-hooks';
import { logger as defaultLogger } from './logger';
import { type ParkedRun, type ParkedStore, expiredParks, resumePrompt } from './parked';
import { renderPrompt, renderTemplate } from './prompts';
import { type DocReader, type PathProbe, loadRepoContextBrief } from './repo-context';
import { type BudgetReservation, exceedsRun, reserveFromRun } from './run-budget';
import { type StageName, stagesFor } from './run-machine';
import { sanitizedAgentEnv } from './security';
import {
  type ExecuteHost,
  type PlanHost,
  type PrepareHost,
  type PreparedRun,
  type RunPipeline,
  type StageHost,
  type StageImpl,
  executeRun,
  integrateStage,
  planRun,
  prepareRun,
  reviewStage,
  settleStage,
  verifyStage,
} from './stages';
import { type RunLogSegment, RunTranscript } from './transcript';
import type { LockContext, LockOutcome, VcsBackend, Workspace } from './vcs/types';
import { type VerifyExec, type VerifySpec, runVerify, verifyFeedbackPrompt, verifyFixRounds } from './verify';
import { type VerifyVerdict, assembleVerifyPrompt, parseVerdict } from './verify-agent';
import { assembleReviewerPrompt, reviewerFeedbackPrompt } from './verify-reviewer';
import {
  BUILTIN_WORKFLOWS,
  type Workflow,
  clampPermissionToWorkflow,
  resolveWorkflow,
  runWorkflow,
  workflowFor,
} from './workflow';

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
  /** How `[context]` paths are checked to exist and stay inside the repo (RUN-128). Injected so
   *  tests never touch a real tree; omitted → the real fs probe. */
  pathProbe?: PathProbe;
  /** How an execution spec's paths are checked (RUN-139). A separate seam from `pathProbe`
   *  because it answers a richer question — file vs directory, gone vs could-not-look — that
   *  `[context]` deliberately collapses. Omitted → the real fs probe. */
  specPathProbe?: SpecPathProbe;
  /** Write a planned spec back onto the anchor task (RUN-140). Omitted → the spec is used for this
   *  run and not persisted, which costs reusability and a human's chance to correct it. */
  saveExecutionSpec?: (projectId: string, taskId: string, spec: ExecutionSpec) => Promise<boolean>;
  /** How required-reading files are read for inlining (RUN-129). Injected for the same reason;
   *  omitted → the real fs. */
  readDoc?: DocReader;
  /** Characters of inlined documentation allowed into one brief (RUN-129). Omitted →
   *  `CONTEXT_BUDGET_CHARS`. Present for tests and for a future per-repo knob, if one earns itself. */
  contextBudget?: number;
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

/**
 * The kind whose POSTURE a run actually runs under (RUN-126) — the daemon's authoritative answer,
 * not the dispatcher's. When a run selects a custom `workflow`, its posture IS that workflow's base
 * (a `docs` workflow based on `scope` is read-only), so the base wins over whatever `kind` the
 * dispatch carried. This closes the footgun where a UI (or any client) selects a read-only workflow
 * but leaves `kind = build`: the daemon holds the manifest and decides, so a mismatched dispatched
 * kind can never escalate write. No workflow (or an unknown name) → the dispatched `kind` stands.
 *
 * `promptShape` is the base kind by construction — a built-in's is its own id, a custom's is
 * inherited from its base — so it doubles as the posture kind.
 */
export function effectiveKind(
  run: Pick<Run, 'kind' | 'workflow'>,
  manifest: Pick<ProjectManifest, 'workflows'>,
): RunKind {
  const wf = run.workflow ? resolveWorkflow(run.workflow, manifest) : undefined;
  const kind = (wf?.promptShape ?? run.kind) as RunKind;
  // A kind outside the union degrades to SCOPE rather than being passed through. Everything
  // downstream indexes a fixed-key record with this — `manifest.permissions[kind]`,
  // `manifest.defaults[kind]`, `noriqToolNamesFor(kind)` — and an unrecognised key yields
  // `undefined`, which the write clamp then throws on. A WS dispatch is schema-validated, but a
  // PARKED run is rehydrated from JSON on disk without revalidation, so this is reachable. Scope
  // because a fallback that guessed `build` would answer "I don't recognise this" with "then you
  // may write and land".
  // `Object.hasOwn`, not `in` — see the note on `isBuiltinId`: `'toString' in BUILTIN_WORKFLOWS` is
  // true, which would wave through the exact keys this guard exists to catch.
  return Object.hasOwn(BUILTIN_WORKFLOWS, kind) ? kind : 'scope';
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
  /** Agent-active seconds charged to this run so far — the wall-clock dimension's spend. Separate
   *  from the slots because time is not telemetry: it accumulates, it is never last-writer-wins. */
  private active = 0;

  /**
   * The run's ONE ceiling (RUN-133). Held here because the tally is already the run's cumulative
   * spend and is already threaded to every place a session starts — so "what is left" is a
   * subtraction on numbers this object has, rather than a second object following it everywhere.
   * The POLICY is still `reserveFromRun`'s; this only carries the inputs.
   *
   * Null/absent = unbounded, which is what every existing caller and test means by omitting it.
   */
  constructor(
    private readonly ceiling: RunBudget | null = null,
    priorActiveSeconds = 0,
  ) {
    this.active = priorActiveSeconds;
  }

  /** Record a session's latest snapshot. Last-writer-wins per slot (see class doc). */
  record(slot: string, t: DriverTelemetry): void {
    this.slots.set(slot, t);
  }

  /** Charge a finished session's active stretch to the run. Sessions are strictly sequential in
   *  this daemon — builder, then reviewer, then conflict turn — so these sum rather than overlap. */
  chargeTime(seconds: number): void {
    this.active += Math.max(0, seconds);
  }

  /** Agent-active seconds burned so far, including any prior sitting's. */
  activeSeconds(): number {
    return this.active;
  }

  /**
   * What the NEXT session may spend: the run's ceiling minus everything already spent (RUN-133).
   *
   * Every `startAgent` goes through this instead of taking a fresh copy of the ceiling, which is
   * what makes a run's total spend bounded rather than bounded-per-session. `{ ok: false }` means
   * the caller must not spawn at all — see `reserveFromRun` for why that is a result and not a
   * one-token budget.
   */
  reserve(): BudgetReservation {
    return reserveFromRun(this.ceiling, { telemetry: this.total(), activeSeconds: this.active });
  }

  /**
   * A LIVE spend check for one session, for `DriverStartOptions.spendGuard` (RUN-133).
   *
   * A reservation is a snapshot, and a session can outlive it: the builder's is computed before it
   * starts, then the reviewer spends from the same ceiling, and the builder is handed work back.
   * Checking its own cumulative against that stale allowance lets the RUN exceed its budget while
   * no session ever breaches. This folds the live tick into the run's view under `slot` — the same
   * last-writer-wins slot the session's result will land in — and asks the allocator.
   *
   * Recording rather than probing a copy is deliberate: the write is idempotent (a later tick and
   * finally the authoritative result overwrite it), and it keeps ONE definition of the run's spend.
   * It does not report anything; who publishes a frame is still each call site's decision (RUN-59).
   */
  guard(slot: string): (t: DriverTelemetry) => string | null {
    return (t) => {
      // A PROBE, never a write. Recording the live tick looked equivalent — same slot, and the
      // authoritative result overwrites it moments later — but `stop()` fires an exit carrying ZERO
      // telemetry, and last-writer-wins then erased the session's real spend from the run's total.
      // A read-only check also keeps RUN-59's reporting contract exactly: a reviewer's live ticks
      // still never enter the tally, so no frame can show a total climbing past a stale mix.
      const probe = new Map(this.slots);
      probe.set(slot, t);
      // `exceedsRun`, NOT `reserve()`: a running session is over only when the run is strictly OVER
      // its ceiling. `reserve()` answers "may I start another one", where landing exactly on the
      // number is a no — using it here killed a session that spent precisely what it was allowed.
      return exceedsRun(this.ceiling, { telemetry: this.sum(probe.values()), activeSeconds: this.active });
    };
  }

  /**
   * The wall-clock counterpart of `guard`, for `DriverStartOptions.clockGuard` (RUN-159): seconds
   * left on the run, right now.
   *
   * Reads `active` rather than probing like `guard` does, because time is not telemetry — a
   * session's stretch is charged once, when it ends, so there is no in-flight figure to swap in.
   * That also means the answer EXCLUDES the caller's own running stretch, which is correct: the
   * session's own budget already covers that half, and the arming side takes the tighter of the two.
   */
  clockGuard(): () => number | null {
    return () => {
      const max = this.ceiling?.maxDurationSeconds;
      return max == null ? null : Math.max(0, max - this.active);
    };
  }

  /* `active` is only as good as the clock its callers time with, which is why every one of them
   * uses `monotonicMs` — a wall-clock step would otherwise hand this ledger seconds nobody spent
   * (or credit back seconds that were), and the budget layer would enforce against the drift. */

  /** Seed a slot only if empty — used for a park's prior spend, which must not clobber a live
   *  session that already recorded under the same slot. */
  seed(slot: string, t: DriverTelemetry): void {
    if (!this.slots.has(slot)) this.slots.set(slot, t);
  }

  total(): DriverTelemetry {
    return this.sum(this.slots.values());
  }

  /** Sum an arbitrary set of slot snapshots. Split out so `guard` can total a PROBE — the live
   *  slots with one session's in-flight tick swapped in — without writing that tick anywhere. */
  private sum(snapshots: Iterable<DriverTelemetry>): DriverTelemetry {
    const acc = zeroTelemetry();
    let mix: Record<string, ModelUsage> | undefined;
    // Spend from mix-less sessions, collected into the one reserved bucket (RUN-86) instead of
    // nuking the whole mix. Each such session adds its OWN aggregate — the same numbers it puts in
    // `acc` — so the bucket + the attributed models sum back to the total (codex lands here at $0,
    // matching that `acc.costUsd` already books it at $0).
    let unattributed: ModelUsage | undefined;
    for (const t of snapshots) {
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
/**
 * What the hard lock floor (RUN-102) concluded. `conflicts` is what it FOUND; `unknownScope` is
 * the case it could not look at all (RUN-156) — kept apart because an empty `conflicts` used to
 * mean both, and one of those is a pass while the other is a floor that never ran.
 */
export interface LockFloorOutcome {
  conflicts: LockConflict[];
  /** Set when the floor could not COMPLETE its check — the scope could not be enumerated, or the
   *  lock service did not answer. Carries the underlying reason for the log and the comment. */
  unchecked?: string;
}

export interface AnchorTask {
  key: string;
  title: string;
  body: string | null;
  /** What this task was commissioned with (RUN-139). Null = nobody wrote one. */
  executionSpec?: ExecutionSpec | null;
  /** The SERVER holds a spec it could not read (RUN-135) — not the same as having none. */
  executionSpecUnreadable?: boolean;
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
  ctx: {
    agent: RunAgent;
    server: string;
    task?: AnchorTask | null;
    diffCmd?: string;
    /** The resolved workflow (RUN-121). Default: the built-in for run.kind. A custom workflow with
     *  a `promptRef` supplies its own brief; its inherited posture still drives everything else. */
    workflow?: Workflow;
    /** The repo's own orientation block, already resolved off disk (RUN-128). Optional: a marker
     *  with neither a `[context]` nor a CLAUDE.md/AGENTS.md renders as it did before RUN-128. */
    repoContext?: string;
    /** The same facts with no inlined documents, for the verify family (RUN-154). */
    repoContextBrief?: string;
    /**
     * The anchor task's execution spec, already checked against the checkout and rendered
     * (RUN-139). A string for the same reason `repoContext` is: checking touches the disk, and
     * prompt assembly stays synchronous and pure.
     *
     * Empty for a task with no spec, which stays the common case — every task filed before the
     * contract grew one, and plenty since. The verify family does NOT receive it: a reviewer
     * judging a diff against acceptance criteria is RUN-145's design, not a free extra here.
     */
    executionSpec?: string;
    /** The same spec's ACCEPTANCE CRITERIA alone, for the verify family (RUN-139) — the shape
     *  RUN-154 gave its context, and for the same reason: an actor that judges needs the standard
     *  it is judging against, not the author's working notes. */
    executionSpecForVerify?: string;
    /**
     * Render the PLANNER's brief instead of this workflow's own (RUN-140).
     *
     * A shape override rather than a workflow of its own: planning is a stage inside a build, not
     * a different run — same repo, same task, same identity, same budget ledger. Giving it a
     * `Workflow` would have made it declarable in a manifest, and a repo able to declare its own
     * planner posture is exactly the widening `clampPermissionToWorkflow` exists to stop.
     */
    promptShapeOverride?: 'planner';
  },
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
    // The PLANNER announces itself as a planner (RUN-140). It ran as "BUILD agent … MODE: PLAN",
    // which is a contradiction in the first two lines of a prompt, and the half of it that was
    // wrong was the half describing what the agent may do.
    kind: ctx.promptShapeOverride === 'planner' ? 'PLAN' : run.kind.toUpperCase(),
    projectKey: manifest.key,
    server: ctx.server,
  });

  // The repo's `[context]` block (RUN-128), rendered ahead of the brief for the scope and build
  // families. A custom workflow's own prompt receives it as `{{context}}` but must PLACE that tag
  // to get it — a template we do not control cannot have text injected into it. The verify family
  // gets the NAMES-ONLY rendering instead (RUN-154), for the reason below.
  const wf = ctx.workflow ?? workflowFor(run.kind as RunKind); // the prompt family is a workflow trait
  // Which rendering an actor gets follows what it IS, not which template it uses. `verifyActor` is
  // the flag that means "this one judges" — so a repo-defined workflow based on `verify` (RUN-119)
  // gets the bounded, explicitly-untrusted block through its own `{{context}}` too, instead of 16k
  // of inlined documents. Note it is NOT `produces`: scope produces a plan rather than a diff, but
  // it is an author reading the repo, not a gate deciding on it.
  const repoContext = (wf.verifyActor ? ctx.repoContextBrief : ctx.repoContext) ?? '';
  // The verify family gets the ACCEPTANCE CRITERIA only — the same trim its context gets
  // (RUN-154), for the same reason: what it needs is the standard, not the author's working
  // notes about which files to touch and what was deferred. Withholding the whole spec was the
  // first cut and it was wrong: a gate that has not been told what "done" means is not
  // independent, it is under-informed, and it can pass a build that skipped a stated criterion.
  const executionSpec = wf.verifyActor ? (ctx.executionSpecForVerify ?? '') : (ctx.executionSpec ?? '');

  // The planner (RUN-140) reads the same facts as the run it briefs and asks for a spec instead of
  // the work. Checked BEFORE `promptRef` so a custom workflow cannot shadow it: a repo shaping its
  // build's brief must not silently reshape the planner that writes that build's spec.
  if (ctx.promptShapeOverride === 'planner') {
    return renderPrompt('planner', { identity, brief: run.brief, anchor, context: repoContext });
  }
  if (wf.promptRef) {
    // A repo-defined workflow's own brief (RUN-121), rendered with the SAME vars the built-in
    // templates get — an author places {{identity}} / {{brief}} / {{anchor}} as they need. The
    // workflow's inherited posture (write floor, gates) still governs everything else.
    return renderTemplate(wf.promptRef, {
      identity,
      server: ctx.server,
      brief: run.brief,
      anchor,
      context: repoContext,
      spec: executionSpec,
      verifyCmd: manifest.verify?.cmd ?? '',
      reviewer: manifest.verify?.agent ? 'true' : '',
    });
  }
  if (wf.promptShape === 'scope') {
    return renderPrompt('scope', {
      identity,
      brief: run.brief,
      anchor,
      context: repoContext,
      spec: executionSpec,
    });
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
      context: repoContext,
      spec: executionSpec,
    });
  }
  // verify kind (RUN-20): a fresh, independent, adversarial reviewer. It receives the repo's
  // orientation by NAME only (RUN-154) — it is the actor asked whether a diff looks like this
  // repo's code, so telling it nothing about this repo was backwards, but its context is already
  // carrying the diff and inlining documents on top would crowd out the subject.
  return assembleVerifyPrompt(`${run.brief}${anchor}${executionSpec}`, {
    agent: ctx.agent,
    server: ctx.server,
    diffCmd: ctx.diffCmd,
    repoContext,
  });
}

/**
 * What fraction of a run's remaining ceiling planning may take (RUN-140).
 *
 * A planner handed the whole remainder can spend it and leave the build it was meant to brief with
 * nothing — a run that produced a perfect plan and no work. A quarter is a judgement, not a
 * measurement: enough to read a repo and write a spec, and small enough that losing all of it
 * still leaves a build worth starting.
 */
const PLAN_BUDGET_SHARE = 0.25;

/** A budget nothing can be spent under. Handed to a builder whose run has nothing left, so the
 *  spawn declines by the same rule every other stage does rather than by a special case. */
const EXHAUSTED_BUDGET = { maxTokens: 0, maxUsd: 0, maxDurationSeconds: 1, maxRounds: null } as const;

/** The planner's share of what the run has left. Null dimensions stay null: an unbounded run does
 *  not acquire a planning ceiling nobody asked for. */
function plannerBudget(remaining: RunBudget): RunBudget {
  const share = (v: number | null) => (v == null ? null : Math.max(1, Math.floor(v * PLAN_BUDGET_SHARE)));
  return {
    maxTokens: share(remaining.maxTokens),
    maxUsd: remaining.maxUsd == null ? null : Math.max(0.01, remaining.maxUsd * PLAN_BUDGET_SHARE),
    maxDurationSeconds: share(remaining.maxDurationSeconds),
    maxRounds: remaining.maxRounds,
  };
}

/**
 * The planner's permission profile (RUN-140).
 *
 * `clampPermissionToWorkflow` at the verify posture forces `write = false`, which is the floor
 * every judging actor gets — but `auto` deliberately SURVIVES that clamp (RUN-68, and CLAUDE.md
 * says so), and `auto` on Claude means bypass-permissions with unrestricted Bash. The planner runs
 * inside a BUILD's worktree, which is physically writable, so a repo with `[permissions.build]
 * auto = true` would have handed a "read-only" planner a shell in a writable tree.
 *
 * So it is dropped here rather than in the clamp. The clamp's behaviour is a documented, deliberate
 * boundary a repo opts into for its own agents; this is a NEW actor the repo never opted anything
 * into, and it has no use for a shell — it reads files and emits JSON.
 */
export function plannerPermission(base: PermissionProfile): PermissionProfile {
  return { ...clampPermissionToWorkflow(base, BUILTIN_WORKFLOWS.verify), auto: false };
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

  /**
   * The surface the pipeline's stages reach (RUN-131), built as an explicit object rather than by
   * handing the stages `this`.
   *
   * Deliberate: satisfying `StageHost` structurally would mean making `landRun`, `enforceLockFloor`
   * and the rest PUBLIC on an exported class, and a typed caller could then invoke `landRun` with
   * its own policy — skipping the no-changes gate, the checkpoint, the lock floor, the deterministic
   * floor and the review that landing is only ever supposed to happen after. A refactor that
   * publishes a way around the gates it is refactoring has changed the security surface, whatever it
   * did to the control flow. Closures keep every one of them private.
   */
  private stageHost(): StageHost {
    return {
      log: this.log,
      report: (runId, frame) => this.deps.report(runId, frame),
      // A no-op without a comment sink, which is exactly how every call site already treated it.
      postComment: (projectId, taskId, body) => this.deps.postComment?.(projectId, taskId, body),
      transcript: (runId) => this.transcript(runId),
      // Close the transcript with its outcome and forget it — the stream a human reads has to END
      // (RUN-74), and a map that only ever grows is a leak with a nicer name.
      endTranscript: (runId, outcome) => {
        const t = this.transcripts.get(runId);
        if (!t) return;
        t.milestone(`run finished: ${outcome}`);
        t.end();
        this.transcripts.delete(runId);
      },
      vcsFor: (repo) => this.vcsFor(repo),
      lockScopeBranch: (repo, run) => this.lockScopeBranch(repo, run),
      withRepoLock: (root, fn) => this.withRepoLock(root, fn),
      enforceLockFloor: (repo, run, ws, token) => this.enforceLockFloor(repo, run, ws, token),
      verifyWithFeedback: (ctx) => this.verifyWithFeedback(ctx),
      reviewWithFeedback: (ctx) => this.reviewWithFeedback(ctx),
      landRun: (ctx) => this.landRun(ctx),
      // The run's effective ceiling: the dispatch's, else the machine default (RUN-14). Only
      // `prepare` reads this — every LATER session reserves from the tally instead (RUN-133), so
      // that the run's sessions divide one ceiling rather than each receiving a copy of it.
      runBudget: (run) => mergeBudget(run.budget, this.deps.defaultBudget) ?? undefined,
      ...(this.deps.continuable ? { continuable: this.deps.continuable } : {}),
    };
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
   *
   * The write floor is enforced here too (RUN-158), AFTER the caller's opts so nothing can spread
   * past it. Every call site already clamps and should keep doing so — the clamp at the site is
   * where the intent is legible — but "we audited every caller" is a property that decays with the
   * next caller, and it had already decayed once: `runReviewer` handed `[permissions.verify]` over
   * raw, so a repo asking for a writable verify posture got a reviewer holding Edit/Write on the
   * diff it was judging. `opts.kind` is the posture kind at every site (a custom workflow resolves
   * to its base via `effectiveKind`), so clamping by it here is exactly what the sites compute —
   * idempotent where they got it right, and the floor where a future one forgets.
   */
  private startAgent(driver: AgentDriver, opts: DriverStartOptions): BudgetRun {
    return superviseBudget(driver, {
      env: sanitizedAgentEnv(),
      ...opts,
      permission: clampPermissionToWorkflow(opts.permission, workflowFor(opts.kind)),
    });
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
   * Three outcomes, and the third is the one RUN-156 added: the floor could not COMPLETE its check.
   * That used to arrive as a pass, by two different routes — a failed enumeration became an empty
   * path set (nothing to lock), and a failed lock call became `{ ok: true }`. Both reported success
   * for a check that never happened.
   *
   * Both now fail CLOSED, and the earlier draft of this fix got that wrong. It kept the lock call
   * failing OPEN on the grounds that "the reactive hook and the dispatch-time check are still
   * standing" — which is false in exactly the case this floor exists for. A Codex build has no
   * in-process hook, and a first sitting declares no predictive scope, so for that run this call IS
   * the only acquisition and its failure means nothing was checked at all.
   *
   * What gating costs is bounded and what it prevents is not: the diff is checkpointed just above,
   * `driverSucceeded` stays true so the workspace is kept, and the run is recorded continuable — so
   * a Noriq blip costs a re-dispatch, while the alternative is landing over a peer's held file with
   * no line anywhere saying the check was skipped.
   *
   * A project with locking genuinely DISABLED still passes: that is a service saying `enabled:
   * false`, which is an answer.
   */
  private async enforceLockFloor(
    repo: ResolvedRepo,
    run: Run,
    worktree: Workspace,
    token: string,
  ): Promise<LockFloorOutcome> {
    const vcs = this.vcsFor(repo);
    if (!vcs.lock || !vcs.changedPaths) return { conflicts: [] };
    let paths: string[];
    try {
      paths = await vcs.changedPaths(worktree);
    } catch (err) {
      return { conflicts: [], unchecked: `could not read what this run changed: ${err}` };
    }
    if (!paths.length) return { conflicts: [] };
    const ctx: LockContext = {
      projectId: run.projectId,
      token,
      branch: this.lockScopeBranch(repo, run),
      taskId: run.anchor?.type === 'task' ? run.anchor.taskId : null,
    };
    let outcome: LockOutcome;
    try {
      outcome = await vcs.lock(worktree, paths, ctx);
    } catch (err) {
      return { conflicts: [], unchecked: `the lock service did not answer: ${err}` };
    }
    return { conflicts: outcome.ok ? [] : outcome.conflicts };
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
            tally: ctx.tally,
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
    /** The run's cross-session tally (RUN-133): a hand-back turn's active seconds are charged to
     *  it when the turn ends, which is what a later session's reservation — and the live
     *  `clockGuard` re-arming this session's own deadline (RUN-159) — is short by. */
    tally: RunTally;
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
      // A hand-back is more agent time on the run's clock (RUN-133). Its TOKENS are policed live by
      // the session's spendGuard and its SECONDS by the deadline re-armed around this turn
      // (RUN-159) — but the deadline is enforcement, not accounting: charging the stretch here is
      // what makes the next session's reservation, and the next turn's own deadline, short by it.
      const fixStartedAt = monotonicMs();
      const exit = await ctx.session
        .continueWith(verifyFeedbackPrompt(ctx.spec, result, attempt))
        .catch((err): DriverExit | null => {
          this.log.warn('could not hand the failure back', { runId: ctx.run.id, err: String(err) });
          return null;
        })
        .finally(() => ctx.tally.chargeTime((monotonicMs() - fixStartedAt) / 1000));
      // The agent died, errored, or breached its budget trying to fix it. Its last verdict stands;
      // pushing more turns at a session that just failed is how a loop becomes a spend. The RUN's
      // reason stays the gate's, deliberately — the failing verify is what a human must act on —
      // so the turn's own reason is logged here or it is lost (RUN-159).
      if (!exit || exit.outcome !== 'done') {
        if (exit?.reason)
          this.log.info('the fix turn ended early', { runId: ctx.run.id, reason: exit.reason });
        return result;
      }
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
      // Same as the deterministic floor's hand-back: the seconds are charged here (RUN-133).
      const fixStartedAt = monotonicMs();
      const exit = await ctx.session
        .continueWith(reviewerFeedbackPrompt(verdict.findings, round, maxRounds))
        .catch((err): DriverExit | null => {
          this.log.warn('could not hand the report back', { runId: ctx.run.id, err: String(err) });
          return null;
        })
        .finally(() => ctx.tally.chargeTime((monotonicMs() - fixStartedAt) / 1000));
      const fixText = ctx.getSessionText?.().slice(textBefore) ?? '';
      // Fold this round's findings + the builder's rebuttal into the ledger the NEXT reviewer sees.
      ledger = buildLedger(ledger, findings, parseFindingResponses(fixText), round);
      // The builder died, errored, or breached its budget on the fix. The reviewer's verdict
      // stands; pushing more turns at a session that just failed is how a loop becomes a spend.
      // Same as the floor's hand-back: the run keeps the reviewer's reason, so the turn's own
      // reason is logged here or nobody ever learns the session ran out (RUN-159).
      if (!exit || exit.outcome !== 'done') {
        if (exit?.reason)
          this.log.info('the fix turn ended early', { runId: ctx.run.id, reason: exit.reason });
        return { ...verdict, rounds: round, ledger };
      }
      this.deps.report(ctx.run.id, { status: 'running', phase: 'verifying' });
      // A fix that satisfies the reviewer but breaks the typecheck must not slip through: the
      // deterministic floor re-runs (with its own bounded feedback) before the re-review.
      if (floorCmd) {
        const floor = await this.verifyWithFeedback({
          run: ctx.run,
          spec: floorCmd,
          cwd: ctx.worktree.localPath,
          session: ctx.session,
          tally: ctx.tally,
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

  /**
   * The repo's orientation for a judging actor (RUN-154), resolved HERE rather than threaded from
   * the run's own context. The inline reviewer is reached by two entry paths — a run that finished
   * in one sitting and one resumed days later in a different process (RUN-30) — and only the first
   * ever assembled a prompt, so only the first has a resolved context to pass down. Resolving at
   * the point of use is what makes both paths behave the same, and it is names-only, so it costs
   * a handful of stats and reads no files.
   *
   * Never fatal: a reviewer with no orientation is exactly the reviewer we had before this, so a
   * broken `[context]` degrades the review rather than failing the gate.
   */
  private async reviewerContext(repo: ResolvedRepo, ws: Workspace): Promise<string> {
    return loadRepoContextBrief(ws.localPath, repo.manifest.context, { probe: this.deps.pathProbe })
      .then((c) => c.rendered)
      .catch((err) => {
        this.log.warn('could not resolve [context] for the reviewer — reviewing without it', {
          repo: repo.manifest.key,
          err: String(err),
        });
        return '';
      });
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
    //
    // RUN-132 gives the workflow's `review` stage a coordinate slot of its own, which belongs in
    // this ladder above `[verify.agent]` — a workflow whose point is a harder look ("audit") should
    // say so on the stage rather than by moving the one setting every other workflow shares. It is
    // NOT wired here, and deliberately: `WorkflowDef` is the VENDORED wire contract and carries
    // `base` + `prompt` only, so nothing can set a stage coordinate and the branch would be
    // unreachable. When the phase-3 vendor refresh grows the field this method needs the run's
    // workflow threaded in (it has `ctx.run` + the manifest but does not resolve one today) and
    // `stageOf(wf, 'review')?.agent` folded in ahead of `reviewer?.agent` — which means it also
    // has to enter the tool/model/effort precedence below, not just the coordinate parse.
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
    // The reviewer spends from the RUN's remaining ceiling, not a fresh copy of it (RUN-133). A
    // build with a reviewer and a conflict turn used to be handed the dispatched budget three times
    // over, and no single per-session check could ever notice.
    const reservation = ctx.tally.reserve();
    if (!reservation.ok) {
      // Adversarial default, same as a reviewer that crashed: a gate that could not run is not a
      // gate that passed. `review.ts` turns an `unknown` verdict into `review:no-verdict`, so the
      // run is gated with its diff kept — and no process was spawned to be killed a moment later.
      this.log.warn('no budget left for the reviewer — gating rather than reviewing unfunded', {
        runId: ctx.run.id,
        breach: reservation.breach,
      });
      return {
        verdict: 'unknown',
        passed: false,
        findings: `the reviewer could not run: ${reservation.detail}. The diff is kept on its branch; re-dispatch with a larger budget to have it judged.`,
      };
    }

    let text = '';
    // Resolved BEFORE the clock starts. The wall-clock dimension bounds AGENT time (RUN-30's
    // accounting), so charging a slow `[context]` probe to it would spend a run's duration ceiling
    // on work no agent did — and since RUN-133 that number is subtracted from what the next session
    // may spend and persisted into a continuation, so the error would compound rather than pass.
    const reviewerContext = await this.reviewerContext(ctx.repo, ctx.worktree);
    const startedAt = monotonicMs();
    const session = this.startAgent(driver, {
      runId: `${ctx.run.id}:review`,
      kind: 'verify', // the reviewer IS a verify actor: executes but never edits
      cwd: ctx.worktree.localPath,
      prompt: assembleReviewerPrompt({
        intent: ctx.intent,
        diffCmd,
        verifyCmd: cmdVerify(manifest.verify)?.cmd ?? null,
        ledger: ctx.ledger,
        repoContext: reviewerContext,
      }),
      // CLAMPED, not raw (RUN-158). The line above says this actor executes but never edits, and
      // until now that was the only thing enforcing it here: `[permissions.verify] write = true` in
      // a committed manifest handed the reviewer Edit/Write over the very diff it is judging, which
      // it could then "fix" and PASS. RUN-118's floor was described as applying at every permission
      // site; this was the site it missed — and the one that matters most, because a dispatched
      // verify run is opt-in while the inline reviewer gates every build that configures one.
      permission: clampPermissionToWorkflow(manifest.permissions.verify, BUILTIN_WORKFLOWS.verify),
      // NO noriqMcp, deliberately: one run holds one non-reissuable credential (RUN-43), so a
      // second inline identity cannot exist — and need not. The reviewer's output IS its report;
      // the daemon parses the verdict and posts the findings itself. This is also what makes
      // authorship separation absolute: the reviewer cannot claim, move, or comment as anyone.
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      budget: reservation.budget,
      // …and the live check, so a reviewer cannot outspend the RUN even inside its own allowance.
      spendGuard: ctx.tally.guard(`review:${ctx.round}`),
      clockGuard: ctx.tally.clockGuard(),
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
      // …and its wall-clock too (RUN-133), so the next session's reservation is short by what this
      // one took. Sessions are strictly sequential here, so these sum rather than overlap.
      ctx.tally.chargeTime((monotonicMs() - startedAt) / 1000);
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
    // The last session a run spawns, and the one most likely to find the ceiling already gone
    // (RUN-133). Unresolved is the honest answer: the caller aborts the rebase and the diff waits on
    // its branch for a human — which is exactly what an unfixable conflict does anyway.
    const reservation = ctx.tally.reserve();
    if (!reservation.ok) {
      this.log.warn('no budget left for the conflict turn — leaving the rebase unresolved', {
        runId: ctx.run.id,
        breach: reservation.breach,
      });
      return { resolved: false, text: `no budget left to attempt a resolution: ${reservation.detail}` };
    }

    let text = '';
    const startedAt = monotonicMs();
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
      budget: reservation.budget,
      spendGuard: ctx.tally.guard('conflict'),
      clockGuard: ctx.tally.clockGuard(),
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
      ctx.tally.chargeTime((monotonicMs() - startedAt) / 1000);
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

    const fail = (reason: string): DriverExit => {
      this.deps.report(run.id, { status: 'failed', exit: { outcome: 'failed', reason } });
      this.log.warn('could not resume a parked run', { runId, reason });
      return { outcome: 'failed', isError: true, reason, telemetry: zeroTelemetry() };
    };

    const repo = await this.deps.resolveRepo(run.repoRef);
    if (!repo) return fail(`repo not found for repoRef ${run.repoRef}`);
    const kind = effectiveKind(run, repo.manifest); // RUN-126: a workflow's base posture is authoritative
    // The run's workflow (RUN-117), the NAMED one when the repo defines it (RUN-132) — same
    // posture either way; what the named one adds is its declared stage list.
    const wf = runWorkflow(run, repo.manifest);
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

    // The resumed run's tally (RUN-59), SEEDED with the park's prior spend + mix so this sitting's
    // figures accumulate onto — and keep summing with — everything spent before the park. It also
    // carries the run's ceiling and the park's active seconds (RUN-133), which is what makes the
    // reservation below the REMAINDER rather than a fresh budget: otherwise "ask a question" is a
    // way to buy more, and a run could park its way past any limit.
    const tally = new RunTally(mergeBudget(run.budget, this.deps.defaultBudget), entry.activeSeconds);
    tally.seed('__prior__', telemetryFromSpent(entry.spent));
    const reservation = tally.reserve();
    if (!reservation.ok) {
      // The park outlived its budget. Fail it rather than spawn a session with nothing to spend —
      // the worktree is kept either way, so the work is not lost.
      return fail(`${reservation.breach}: ${reservation.detail}; not resuming`);
    }

    // The SAME execute stage `supervise` runs (RUN-131) — including its re-park check, because an
    // agent given an answer may well have a second question and there is no reason the second one
    // is worth less than the first. Everything that differs about a resume is resolved here, in
    // `start`, rather than by a second copy of the spawn-and-await loop.
    const executed = await executeRun(this.executeHost(), {
      run,
      repo,
      worktree,
      driver,
      runAgent,
      tally,
      priorActiveSeconds: entry.activeSeconds,
      start: {
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
        // The REMAINDER, reserved from the tally above (RUN-133) — one allocator for every session
        // a run spawns, rather than a resume-only helper beside a reviewer that had none.
        budget: reservation.budget,
        spendGuard: tally.guard('primary'),
        clockGuard: tally.clockGuard(),
      },
    });
    if (executed.parked) return executed.parked;

    return this.afterDriver({
      run,
      repo,
      worktree,
      driver,
      permission: clampPermissionToWorkflow(repo.manifest.permissions[kind], wf),
      noriqMcp,
      task: run.anchor?.type === 'task' ? await this.resolveAnchorTask(run.anchor.taskId) : null,
      runAgent,
      session: executed.session,
      stopSession: executed.stopSession,
      exit: executed.exit,
      tally,
      verifyText: executed.sessionText,
      getSessionText: executed.getSessionText,
      tail: executed.tail,
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

  /**
   * Run one dispatched Run to completion. Never throws — failures are reported.
   *
   * Three lines of pipeline (RUN-131): prepare it, execute it, then walk the post-driver stages.
   * The ~260 lines of setup that used to sit here are `stages/prepare.ts`, and the ~60 that spawned
   * and awaited the agent are `stages/execute.ts` — which `resume` now shares rather than repeats.
   */
  async supervise(run: Run): Promise<DriverExit> {
    const fail = (reason: string): DriverExit => {
      this.deps.report(run.id, { status: 'failed', exit: { outcome: 'failed', reason } });
      return { outcome: 'failed', isError: true, reason, telemetry: zeroTelemetry() };
    };

    const prepared = await prepareRun(this.prepareHost(), run);
    if (!prepared.ok) return fail(prepared.reason);

    // `plan` (RUN-140), between prepare and execute because a spec written after the build has
    // started is a spec nobody read. It no-ops unless the workflow produces, the run has a task,
    // and that task arrived unplanned — and it can only ever ENRICH the prompt: a planner that
    // fails leaves `start` exactly as prepare built it.
    const start = await this.planIfUnplanned(run, prepared);

    const executed = await executeRun(this.executeHost(), {
      run,
      repo: prepared.repo,
      worktree: prepared.worktree,
      driver: prepared.driver,
      runAgent: prepared.runAgent,
      tally: prepared.tally,
      start,
      priorActiveSeconds: 0,
    });
    if (executed.parked) return executed.parked;

    return this.afterDriver({
      run,
      repo: prepared.repo,
      worktree: prepared.worktree,
      driver: prepared.driver,
      permission: prepared.permission,
      ...(prepared.noriqMcp ? { noriqMcp: prepared.noriqMcp } : {}),
      task: prepared.task,
      runAgent: prepared.runAgent,
      session: executed.session,
      stopSession: executed.stopSession,
      exit: executed.exit,
      tally: prepared.tally,
      verifyText: executed.sessionText,
      getSessionText: executed.getSessionText,
      tail: executed.tail,
      continued: prepared.continued,
    });
  }

  /**
   * Run the `plan` stage when it applies, and fold its result into the builder's brief (RUN-140).
   *
   * Returns `prepared.start` untouched whenever planning does not apply or does not work, which is
   * what makes this stage unable to cost a run: every failure path here is "the run proceeds
   * exactly as it would have without me".
   */
  private async planIfUnplanned(run: Run, prepared: PreparedRun): Promise<PreparedRun['start']> {
    if (!stagesFor(prepared.workflow).some((s) => s.name === 'plan')) return prepared.start;
    if (!prepared.plannedTask) return prepared.start;

    // The planner spends the RUN's remaining ceiling like any other session (RUN-133) — a run with
    // nothing left declines to plan rather than starting a process to kill.
    const reservation = prepared.tally.reserve();
    if (!reservation.ok) {
      this.log.warn('no budget left to plan this run — proceeding unplanned', {
        runId: run.id,
        breach: reservation.breach,
      });
      return prepared.start;
    }

    const checked = await planRun(this.planHost(), {
      run,
      repo: prepared.repo,
      worktree: prepared.worktree,
      driver: prepared.driver,
      runAgent: prepared.runAgent,
      tally: prepared.tally,
      prompt: prepared.plannerPrompt,
      start: {
        ...prepared.start,
        permission: plannerPermission(prepared.permission),
        // NO MCP. Every other actor gets Noriq because it has to report what it did; the planner
        // reports nothing — the DAEMON writes its spec back, under the daemon's own token and
        // behind a re-read that will not clobber a human. Handing it the run agent's connection
        // would have given a "read-only" actor `update_task`, `claim_task` and `post_comment`,
        // which are writes the filesystem clamp says nothing about, and the server explicitly
        // permits a run agent to rewrite an execution spec (RUN-160). The narrowest thing that
        // can do the job is the thing to hand it.
        noriqMcp: undefined,
        ...(reservation.budget ? { budget: plannerBudget(reservation.budget) } : {}),
        spendGuard: prepared.tally.guard('plan'),
        clockGuard: prepared.tally.clockGuard(),
      },
    }).catch((err) => {
      // A stage that cannot gate the run must not throw out of it either.
      this.log.warn('the plan stage failed — proceeding unplanned', { runId: run.id, err: String(err) });
      return null;
    });
    if (!checked) return prepared.start;

    // RE-RESERVE. `prepared.start.budget` was computed before planning, so handing it to the
    // builder unchanged would let a run spend its ceiling twice — exactly the per-session-copy bug
    // RUN-133 removed. A build with nothing left declines to spawn rather than starting a process
    // to kill, and the run fails having at least produced a spec somebody can act on.
    const rest = prepared.tally.reserve();
    if (!rest.ok) {
      this.log.warn('planning used what was left of this run', { runId: run.id, breach: rest.breach });
      this.transcript(run.id).milestone(
        `planning used the run's remaining budget (${rest.breach}) — nothing left to build with`,
      );
    }
    return {
      ...prepared.start,
      prompt: prepared.rebuildPrompt(checked),
      ...(rest.ok ? (rest.budget ? { budget: rest.budget } : {}) : { budget: EXHAUSTED_BUDGET }),
    };
  }

  private planHost(): PlanHost {
    return {
      log: this.log,
      report: (runId, frame) => this.deps.report(runId, frame),
      transcript: (runId) => this.transcript(runId),
      startAgent: (driver, opts) => this.startAgent(driver, opts),
      // The planner is a live session like any other: cancellable, and stopped by shutdown. It
      // used to be outside this, so `run.cancel` during planning found no target and answered
      // false while the planner — and then the build — carried on.
      ...(this.deps.steering
        ? {
            steering: {
              register: (runId: string, session: DriverSession, stop: () => Promise<void>) =>
                this.deps.steering?.register(runId, session, stop),
              unregister: (runId: string) => this.deps.steering?.unregister(runId),
            },
          }
        : {}),
      checkSpec: (spec, root) =>
        checkExecutionSpec(spec, root, {
          ...(this.deps.specPathProbe ? { probe: this.deps.specPathProbe } : {}),
          produces: true,
        }),
      ...(this.deps.saveExecutionSpec ? { saveSpec: this.deps.saveExecutionSpec } : {}),
    };
  }

  /**
   * The surface `prepare` reaches — see `stageHost` for why this is closures, not `this`.
   *
   * Every optional dep is re-wrapped in an arrow rather than copied by reference, and that is not
   * ceremony: `this.deps.checkClaimable(id)` calls with `deps` as the receiver, and handing the bare
   * function over would silently call it with the HOST as the receiver instead. A dep written as a
   * method (`checkClaimable() { return this.client... }`) satisfies the declared type and would
   * start throwing — which the claimability probe swallows as a transient failure and fails OPEN,
   * spawning a run the phase gate meant to decline. The daemon passes arrows today; the contract is
   * public, so it must not depend on that.
   */
  private prepareHost(): PrepareHost {
    return {
      log: this.log,
      report: (runId, frame) => this.deps.report(runId, frame),
      postComment: (projectId, taskId, body) => this.deps.postComment?.(projectId, taskId, body),
      transcript: (runId) => this.transcript(runId),
      server: this.deps.server,
      resolveRepo: (repoRef) => this.deps.resolveRepo(repoRef),
      driverFor: (tool) => this.deps.drivers[tool as AgentTool],
      vcsFor: (repo) => this.vcsFor(repo),
      ...(this.deps.checkClaimable
        ? { checkClaimable: (taskId: string) => this.deps.checkClaimable!(taskId) }
        : {}),
      planBase: (repo, run) => this.planBase(repo, run),
      ...(this.deps.createRunAgent
        ? {
            createRunAgent: (runId: string, opts: { label?: string; allowedTools?: string[] }) =>
              this.deps.createRunAgent!(runId, opts),
          }
        : {}),
      resolveAnchorTask: (taskId) => this.resolveAnchorTask(taskId),
      ...(this.deps.resolveLockScope
        ? { resolveLockScope: (run: Run) => this.deps.resolveLockScope!(run) }
        : {}),
      lockScopeBranch: (repo, run) => this.lockScopeBranch(repo, run),
      lockEnforcerFor: (repo, run, worktree, kind, token) =>
        this.lockEnforcerFor(repo, run, worktree, kind, token),
      runBudget: (run) => mergeBudget(run.budget, this.deps.defaultBudget) ?? null,
      context: {
        ...(this.deps.pathProbe ? { probe: this.deps.pathProbe } : {}),
        ...(this.deps.specPathProbe ? { specProbe: this.deps.specPathProbe } : {}),
        ...(this.deps.readDoc ? { read: this.deps.readDoc } : {}),
        ...(this.deps.contextBudget !== undefined ? { budget: this.deps.contextBudget } : {}),
      },
      ...(this.deps.continuable ? { continuable: this.deps.continuable } : {}),
    };
  }

  /** The surface `execute` reaches. `startAgent` is here — and nowhere wider — because it is the
   *  one place the sanitized child env is applied (RUN-109). */
  private executeHost(): ExecuteHost {
    return {
      log: this.log,
      report: (runId, frame) => this.deps.report(runId, frame),
      transcript: (runId) => this.transcript(runId),
      startAgent: (driver, opts) => this.startAgent(driver, opts),
      ...(this.deps.steering ? { steering: this.deps.steering } : {}),
      parkIfBlocked: (ctx) => this.parkIfBlocked(ctx),
    };
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
    const { run, repo, worktree, driver, permission, task, runAgent, tally, verifyText, tail } = ctx;
    const continued = ctx.continued ?? null;
    // The run's workflow (RUN-117), the NAMED one when the repo defines it (RUN-132) — same
    // posture either way; what the named one adds is its declared stage list.
    const wf = runWorkflow(run, repo.manifest);

    // The pipeline as an explicit SEQUENCE (RUN-131). What used to be ~390 lines of gates in one
    // method is now `stagesFor(wf)` — a declared, ordered list this loop walks, so the two flag
    // tests that used to be repeated in every gate (`wf.produces`, `wf.verifyActor`) are stated
    // once, where the sequence is. Which stages come back is `(mandatory ∪ the workflow's
    // declaration) ∩ appliesTo` (RUN-132): the workflow chooses among the optional ones, and the
    // machine decides what may be chosen and in what order.
    const pipeline: RunPipeline = {
      run,
      repo,
      worktree,
      driver,
      permission,
      ...(ctx.noriqMcp ? { noriqMcp: ctx.noriqMcp } : {}),
      task,
      runAgent,
      session: ctx.session,
      stopSession: ctx.stopSession,
      tally,
      sessionText: verifyText,
      ...(ctx.getSessionText ? { getSessionText: ctx.getSessionText } : {}),
      tail,
      continued,
      workflow: wf,
      exit: ctx.exit,
      // Whether the DRIVER succeeded — drives worktree retention (a build with a diff is kept for
      // the human even if verify then fails).
      driverSucceeded: ctx.exit.outcome === 'done',
      // Whether the diff reached the integration branch. Once it has, the run's worktree and
      // throwaway branch are disposable — that is what stops them accumulating.
      landed: false,
      // The ledger carried into the terminal continuable record (RUN-92): the reviewer's final one
      // when it runs, else whatever a prior sitting left — a pre-review failure adds nothing.
      ledger: continued?.ledger ?? [],
      // Decided by `verify`, once, at the point the pipeline always decided it.
      landPolicy: null,
    };

    const host = this.stageHost();
    for (const s of stagesFor(wf)) {
      const impl = POST_DRIVER_STAGES[s.name];
      if (impl) await impl(host, pipeline);
    }
    return pipeline.exit;
  }
}

/**
 * The stages this method runs. `prepare` and `execute` are absent by construction, not by omission:
 * they happen BEFORE the pipeline object exists — they are what BUILDS it — so they take a run and
 * return one rather than narrowing a context they were handed, and `supervise` calls them directly.
 * A stage with no entry here is simply not part of the post-driver walk.
 */
const POST_DRIVER_STAGES: Partial<Record<StageName, StageImpl>> = {
  verify: verifyStage,
  review: reviewStage,
  integrate: integrateStage,
  settle: settleStage,
};

/** One line per reviewer look, in the transcript's system voice (RUN-74). */
function reviewVerdictMilestone(v: VerifyVerdict, round: number): string {
  if (v.passed) return `reviewer verdict: PASS (round ${round})`;
  if (v.verdict === 'fail') return `reviewer verdict: FAIL (round ${round})`;
  return `reviewer rendered NO verdict (round ${round}) — stopped, crashed, or wrote no VERDICT line`;
}
