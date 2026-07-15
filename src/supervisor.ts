import type {
  AgentTool,
  LandPolicy,
  PermissionProfile,
  ProjectManifest,
  Run,
  RunBudget,
  RunKind,
  RunPhase,
} from '@noriq-dev/shared';
import type { ParkState, RunAgent } from './client';
import { superviseBudget, totalTokens } from './drivers/budget';
import type { AgentDriver, DriverExit, DriverSession, DriverTelemetry, NoriqMcp } from './drivers/types';
import { zeroTelemetry } from './drivers/types';
import {
  type LandOutcome,
  assembleConflictPrompt,
  landFailureComment,
  parseResolution,
  rejectTargetBranch,
  resolveLandBranch,
} from './land';
import { logger as defaultLogger } from './logger';
import { type ParkedRun, type ParkedStore, expiredParks, resumePrompt } from './parked';
import {
  MAX_VERIFY_FIXES,
  type VerifyExec,
  runVerify,
  verifyFailureComment,
  verifyFeedbackPrompt,
} from './verify';
import { assembleVerifyPrompt, parseVerdict, verifyAgentComment } from './verify-agent';
import { type WorktreeInfo, type WorktreeManager, runBranch } from './worktree';

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

export interface ResolvedRepo {
  root: string;
  manifest: ProjectManifest;
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
  worktrees: Pick<
    WorktreeManager,
    | 'create'
    | 'remove'
    | 'hasChanges'
    | 'commitWork'
    | 'refExists'
    | 'createBranch'
    | 'rebaseOnto'
    | 'continueRebase'
    | 'abortRebase'
    | 'landFastForward'
    | 'pushBranch'
  >;
  /** repoRef → local repo root + the manifest to run under. May be async: the daemon
   *  re-reads the committed marker per Run so a config edit needs no restart. */
  resolveRepo: (repoRef: string) => ResolvedRepo | null | Promise<ResolvedRepo | null>;
  /** Report a Run status transition upstream (→ WsClient.sendRunStatus). */
  report: (runId: string, report: RunReport) => void;
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
  createRunAgent?: (runId: string, opts: { label?: string }) => Promise<RunAgent>;
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
   * Is this Run parked on a human, and have they answered? (→ NoriqClient.getParkState, RUN-30)
   *
   * The server is the authority: only it saw the `request_input`, because the agent reaches
   * Noriq over MCP directly and the daemon is not in that path. Omitted → parking is off and a
   * session that ends is simply finished, exactly as before RUN-30.
   */
  getParkState?: (runId: string) => Promise<ParkState>;
  /** Where parked runs are remembered across restarts (RUN-30). Omitted → parking is off. */
  parked?: Pick<ParkedStore, 'park' | 'get' | 'unpark' | 'list'>;
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
  };
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
  };
}

/** Fold a park's prior spend into a live tick, so the dashboard shows the RUN's total. */
export const addSpent = (t: DriverTelemetry, spent: ParkedRun['spent']): DriverTelemetry => ({
  ...t,
  // Prior tokens land in inputTokens: the split across the four buckets is not recoverable from
  // the park (it stores one total), and the figure that matters — and that the budget reads — is
  // the sum. Better one honest total than four invented components.
  inputTokens: t.inputTokens + spent.tokens,
  costUsd: t.costUsd + spent.usd,
});

/** The anchor task's human-readable content, inlined into the prompt. */
export interface AnchorTask {
  key: string;
  title: string;
  body: string | null;
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
  const identity = `You are ${ctx.agent.label} (${ctx.agent.agentId}), a Noriq Runner ${run.kind.toUpperCase()} agent for project ${manifest.key}.
Your Noriq identity is already set up: the MCP server at ${ctx.server} authenticates you as this agent — do NOT call set_agent_identity. You report your own work through Noriq; the daemon supervises only your process.`;

  if (run.kind === 'scope') {
    return `${identity}

MODE: SCOPE (read-only orchestrator). Do NOT modify any files.
Explore the repo to understand the work, then emit a PROPOSED plan via create_plan with proposed:true (goals + ordered phases over tasks). proposed:true is REQUIRED — it gates the plan's tasks as un-claimable until a human approves it in the dashboard (the mandatory v1 gate). Success = a proposed plan is emitted; there is no diff.

Brief: ${run.brief}${anchor}`;
  }
  if (run.kind === 'build') {
    // The agent is NOT told to run the verify command (RUN-29). It used to be, and the daemon then
    // ran the SAME command itself as the actual gate — so the agent paid tokens and about a minute
    // to answer a question that got asked again, properly, right afterwards. Its run was advisory;
    // the daemon's is authoritative and free. Measured on run_mrlig93q5b574b502963: ~3m24s of agent
    // time including its own verify, then 62s of daemon verify.
    //
    // Its allowlist still permits running tests — iterating on one file while working is cheap and
    // targeted. What it must not do is burn the full suite to grade itself.
    const verify = manifest.verify
      ? `\nThe full check (\`${manifest.verify.cmd}\`) is run for you after you finish, and its output comes back to you if it fails — so don't spend a turn on it. Run individual tests while you work if they help.`
      : '';
    return `${identity}

MODE: BUILD (worker, read-write worktree). Implement the work and leave a review diff on this branch (a human merges it — never push).
You do NOT need to commit: the daemon commits whatever you leave in the worktree onto this Run's branch when you finish, so \`git commit\` being unavailable is expected, not a failure — don't report it as one. Just leave the work in place.${verify}

Brief: ${run.brief}${anchor}`;
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

  constructor(private readonly deps: RunSupervisorDeps) {
    this.log = deps.logger ?? defaultLogger;
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
    worktree: WorktreeInfo;
    policy: LandPolicy;
    task: AnchorTask | null;
    driver: AgentDriver;
    permission: PermissionProfile;
    noriqMcp?: NoriqMcp;
    budget?: RunBudget;
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
    const wt = this.deps.worktrees;

    // First landing into this branch: fork it from the repo's declared main so the
    // integration line starts somewhere sane rather than from this run's base.
    if (!(await wt.refExists(repo.root, branch))) {
      const from = repo.manifest.defaultBranch ?? worktree.baseSha;
      await wt.createBranch(repo.root, branch, from);
      this.log.info('created the landing branch', { branch, from });
    }

    let rebase = await wt.rebaseOnto(worktree, branch);
    let resolvedByAgent: boolean | undefined;
    let agentSaid = '';

    if (!rebase.ok) {
      const conflicts = rebase.conflicts;
      if (!policy.resolveConflicts) {
        await wt.abortRebase(worktree);
        return { landed: false, branch, reason: 'conflict', conflicts };
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
        await wt.abortRebase(worktree);
        return {
          landed: false,
          branch,
          reason: 'conflict',
          conflicts,
          resolvedByAgent: false,
          detail: agentSaid,
        };
      }
      const cont = await wt.continueRebase(worktree);
      if (!cont.ok) {
        await wt.abortRebase(worktree);
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
    if (policy.onlyWhenVerifyPasses && repo.manifest.verify) {
      const result = ctx.session
        ? await this.verifyWithFeedback({
            run: ctx.run,
            spec: repo.manifest.verify,
            cwd: worktree.path,
            session: ctx.session,
            phase: 'landing', // this verify IS the landing pipeline; don't rename it mid-flight
          })
        : await runVerify(repo.manifest.verify, worktree.path, { exec: this.deps.verifyExec });
      if (!result.passed) {
        return { landed: false, branch, reason: 'verify', detail: result.output, resolvedByAgent };
      }
      this.log.info('verify passed on the rebased result', { runId: run.id, branch });
    }

    const ff = await wt.landFastForward(repo.root, branch, worktree.branch);
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
    const push = await wt.pushBranch(ctx.repo.root, branch);
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
   * Bounded (RUN-21's K=2): an agent that cannot fix it in two tries will not on the third — it
   * will keep spending. The budget still applies underneath, so a loop cannot outrun its ceiling.
   */
  private async verifyWithFeedback(ctx: {
    run: Run;
    spec: NonNullable<ProjectManifest['verify']>;
    cwd: string;
    session: DriverSession;
    /** The phase to return to between fix turns — 'verifying' on the standalone gate,
     *  'landing' when this runs inside the landing pipeline (RUN-31). */
    phase: RunPhase;
  }) {
    let result = await runVerify(ctx.spec, ctx.cwd, { exec: this.deps.verifyExec });
    // continueWith is absent unless the run was started multiTurn — a run with no live session to
    // talk to (or a driver that cannot) simply gets the verdict, exactly as before.
    if (result.passed || !ctx.session.continueWith) return result;

    for (let attempt = 1; attempt <= MAX_VERIFY_FIXES; attempt++) {
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
      if (result.passed) {
        this.log.info('verify passed after the agent fixed it', { runId: ctx.run.id, attempt });
        return result;
      }
    }
    return result;
  }

  /** Give the build agent one bounded turn to resolve its own conflict, in place. */
  private async resolveConflict(
    ctx: {
      run: Run;
      repo: ResolvedRepo;
      worktree: WorktreeInfo;
      policy: LandPolicy;
      task: AnchorTask | null;
      driver: AgentDriver;
      permission: PermissionProfile;
      noriqMcp?: NoriqMcp;
      budget?: RunBudget;
    },
    conflicts: string[],
  ): Promise<{ resolved: boolean; text: string }> {
    let text = '';
    const session = superviseBudget(ctx.driver, {
      runId: `${ctx.run.id}:conflict`,
      kind: 'build', // it is editing its own diff — the build floor, nothing wider
      cwd: ctx.worktree.path,
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
        onTelemetry: (t) => this.deps.report(ctx.run.id, { status: 'running', telemetry: t }),
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
    worktree: WorktreeInfo;
    exit: DriverExit;
    session: DriverSession;
    runAgent: RunAgent;
    activeSeconds: number;
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

    await this.deps.parked.park({
      run,
      sessionId,
      agentId: ctx.runAgent.agentId,
      agentLabel: ctx.runAgent.label,
      mcpToken: ctx.runAgent.token,
      worktreePath: ctx.worktree.path,
      worktreeBranch: ctx.worktree.branch,
      repoRoot: ctx.repo.root,
      spent: { tokens: totalTokens(exit.telemetry), usd: exit.telemetry.costUsd },
      activeSeconds: ctx.activeSeconds,
      parkedAt: new Date().toISOString(),
      question: state.question,
    });
    // The server already moved the row to blocked when the agent asked; reporting it back is what
    // makes the daemon's view and the dashboard's agree, and it carries the final spend.
    this.deps.report(run.id, { status: 'blocked', telemetry: exit.telemetry, logTail: ctx.tail });
    this.log.info('run parked on a human — session ended, worktree kept', {
      runId: run.id,
      question: state.question?.slice(0, 80) ?? null,
    });
    // NOT terminal, and the worktree is deliberately left alone: it holds the work, and the
    // resumed session expects to find it exactly where it was.
    return { ...exit, outcome: 'done', isError: false, reason: 'parked', sessionId };
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

    const fail = (reason: string): DriverExit => {
      this.deps.report(run.id, { status: 'failed', exit: { outcome: 'failed', reason } });
      this.log.warn('could not resume a parked run', { runId, reason });
      return { outcome: 'failed', isError: true, reason, telemetry: zeroTelemetry() };
    };

    const repo = await this.deps.resolveRepo(run.repoRef);
    if (!repo) return fail(`repo not found for repoRef ${run.repoRef}`);
    const driver = this.deps.drivers[run.agentTool as AgentTool];
    if (!driver) return fail(`no driver for tool ${run.agentTool}`);
    if (!entry.sessionId) return fail('parked run has no session to resume');

    // The worktree is REUSED, never recreated: it holds the work the agent did before it asked,
    // and the session it is about to resume expects to find it exactly as it left it.
    const worktree: WorktreeInfo = {
      runId: run.id,
      repoRoot: entry.repoRoot,
      path: entry.worktreePath,
      branch: entry.worktreeBranch,
      readOnly: kind === 'scope',
      baseSha: '',
    };
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
    const startedAt = Date.now();
    const budgetRun = superviseBudget(driver, {
      runId: run.id,
      kind,
      cwd: worktree.path,
      // The answer IS the prompt. No brief, no task text, no repo tour: the session already has
      // all of it, and re-sending it would both waste the context and confuse a conversation
      // that is mid-thought.
      prompt: resumePrompt(entry.question, answer),
      resumeSessionId: entry.sessionId,
      permission: repo.manifest.permissions[kind],
      noriqMcp,
      multiTurn: kind === 'build' && Boolean(repo.manifest.verify),
      // The REMAINDER, never a fresh ceiling — otherwise "ask a question" is a way to buy more
      // budget, and a run could park its way past any limit.
      budget: remainingBudget(mergeBudget(run.budget, this.deps.defaultBudget), entry),
      handlers: {
        onTelemetry: (t) =>
          this.deps.report(run.id, { status: 'running', telemetry: addSpent(t, entry.spent), logTail: tail }),
        onText: (t) => {
          verifyText += t;
          tail = (tail + t).slice(-LOG_TAIL_CAP);
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
    // Spend is cumulative across the park — the run's totals are the run's, not this sitting's.
    exit = { ...exit, telemetry: addSpent(exit.telemetry, entry.spent) };

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
      tail,
    });
    if (reparked) return reparked;

    return this.afterDriver({
      run,
      repo,
      worktree,
      driver,
      permission: repo.manifest.permissions[kind],
      noriqMcp,
      task: run.anchor?.type === 'task' ? await this.resolveAnchorTask(run.anchor.taskId) : null,
      runAgent,
      session: budgetRun.session,
      stopSession: budgetRun.stop,
      exit,
      verifyText,
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
        worktree: p.worktreePath,
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
    const driver = this.deps.drivers[run.agentTool as AgentTool];
    if (!driver) return fail(`no driver for tool ${run.agentTool}`);

    const kind = run.kind as RunKind;
    const permission = repo.manifest.permissions[kind];
    // Only SCOPE gets a physically read-only checkout. A VERIFY agent is told to run the
    // suite and exercise the behavior, which needs a writable tree (node_modules, test
    // temp files, .wrangler state) — chmod'ing it read-only makes that instruction
    // impossible and reduces the adversarial gate to reading by eye. Verify is still
    // barred from EDITING by its profile (no Edit/Write tools + an enumerated bash
    // allowlist), which is the property that actually matters: it must not be able to
    // "fix" the code it is judging.
    const readOnly = kind === 'scope';

    // A VERIFY run branches from the BUILD it judges, not from HEAD — otherwise it gets a
    // pristine checkout, the `git diff` its prompt orders is empty, and it renders a
    // verdict on code nobody changed. `verifiesRunId` is what carries that link.
    const verifiesRunId = run.kind === 'verify' ? (run.verifiesRunId ?? null) : null;
    const baseRef = verifiesRunId ? runBranch(verifiesRunId) : undefined;

    let worktree: Awaited<ReturnType<WorktreeManager['create']>>;
    try {
      worktree = await this.deps.worktrees.create(repo.root, run.id, { readOnly, baseRef });
    } catch (err) {
      // A verify run whose target branch is gone (reaped, or built on another machine)
      // must fail loudly: silently falling back to HEAD would hand back a confident PASS
      // on an empty diff, which is worse than no gate at all.
      if (baseRef) {
        return fail(
          `cannot verify ${verifiesRunId}: its branch ${baseRef} is not in this repo — ` +
            `${(err as Error).message}`,
        );
      }
      return fail(`worktree setup failed: ${(err as Error).message}`);
    }
    // dispatched → running, and the first phase (RUN-31). The status half is the real
    // transition; the phase half rides the telemetry frame the daemon splits this into.
    this.deps.report(run.id, { status: 'running', worktreePath: worktree.path, phase: 'agent' });
    this.log.info('run started', { runId: run.id, kind, tool: run.agentTool, worktree: worktree.path });

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
        runAgent = await this.deps.createRunAgent(run.id, { label: `${run.kind}-${run.id.slice(-6)}` });
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
        await this.deps.worktrees.remove(worktree).catch(() => {});
        return fail(`could not create the Noriq agent for this run: ${(err as Error).message}`);
      }
    }

    // Branching from the build's branch isn't enough on its own: that checkout is CLEAN,
    // so a bare `git diff` still shows nothing. Point the verifier at the range that is
    // actually under review — everything the build added since it forked. Three dots =
    // "since the merge base", so an unrelated main moving on doesn't pollute the review.
    const diffCmd = verifiesRunId
      ? `git diff ${repo.manifest.defaultBranch ?? worktree.baseSha}...HEAD`
      : undefined;

    // No identity → no prompt worth sending. assemblePrompt now TELLS the agent who it is,
    // which it can only do if the daemon actually made someone.
    if (!runAgent) {
      await this.deps.worktrees.remove(worktree).catch(() => {});
      return fail('no Noriq identity for this run — the daemon must create the agent before spawning it');
    }
    const prompt = assemblePrompt(run, repo.manifest, {
      agent: runAgent,
      server: this.deps.server,
      task,
      diffCmd,
    });
    let verifyText = ''; // accumulated agent output — the verify verdict is parsed from it
    let tail = ''; // rolling tail of the same output, capped, for the live dashboard (RUN-22)
    // Active time, for a park's wall-clock accounting (RUN-30): the wait for a human is not the
    // run's, so only the stretch from here to the session's end counts against maxDurationSeconds.
    const startedAt = Date.now();
    const budgetRun = superviseBudget(driver, {
      runId: run.id,
      kind,
      cwd: worktree.path,
      prompt,
      permission,
      noriqMcp,
      // Keep the session alive past its first result ONLY when a feedback loop is possible: a
      // build, with a verify command to fail. Scope and verify runs want today's behaviour —
      // finish and close — and a session nobody closes hangs the daemon (see the finally below).
      multiTurn: kind === 'build' && Boolean(repo.manifest.verify),
      budget: mergeBudget(run.budget, this.deps.defaultBudget) ?? undefined,
      handlers: {
        // Each telemetry tick carries the current spend AND the latest log tail, so
        // the dashboard sees burn + output without a status transition per tick.
        onTelemetry: (t) => this.deps.report(run.id, { status: 'running', telemetry: t, logTail: tail }),
        onText: (t) => {
          verifyText += t;
          tail = (tail + t).slice(-LOG_TAIL_CAP);
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
      verifyText,
      tail,
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
    worktree: WorktreeInfo;
    driver: AgentDriver;
    permission: PermissionProfile;
    noriqMcp?: NoriqMcp;
    task: AnchorTask | null;
    runAgent: RunAgent;
    session: DriverSession;
    stopSession: () => Promise<void>;
    exit: DriverExit;
    verifyText: string;
    tail: string;
  }): Promise<DriverExit> {
    const { run, repo, worktree, driver, permission, noriqMcp, task, runAgent, verifyText, tail } = ctx;
    const kind = run.kind as RunKind;
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
    if (kind === 'build' && driverSucceeded) {
      const changed = await this.deps.worktrees.hasChanges(worktree).catch(() => true); // can't tell → assume it worked and let verify decide
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
    if (kind === 'build' && driverSucceeded) {
      const label = task ? `${task.key} ${task.title}` : (run.brief || run.id).slice(0, 60);
      await this.deps.worktrees
        .commitWork(worktree, `noriq run ${run.id}: ${label}`)
        .then((committed) => {
          if (committed)
            this.log.info('committed the run diff to its branch', { runId: run.id, branch: worktree.branch });
        })
        .catch((err) =>
          this.log.error('could not commit the run diff — it stays uncommitted', {
            runId: run.id,
            err: String(err),
          }),
        );
    }

    // ── Landing (opt-in via the manifest's [land]) ────────────────────────────────
    // Rebase onto the integration tip → verify THERE → fast-forward in → reap. Verify
    // runs after the rebase on purpose: two runs can each be green at their own fork
    // point and broken together, and a gate that never sees the combination can't catch
    // it. Serialized per repo, because rebase→verify→land is a read-modify-write of one
    // branch and two runs interleaving would land untested combinations.
    const landPolicy = kind === 'build' && driverSucceeded ? (repo.manifest.land ?? null) : null;
    if (landPolicy) {
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

    // Deterministic verify floor (RUN-19): a build whose agent exited clean must
    // still pass the manifest verify command (zero tokens) before reaching done.
    // Skipped when [land] is configured — the landing pipeline already verified the
    // REBASED result, which is strictly the better question to ask.
    if (kind === 'build' && driverSucceeded && !landPolicy && repo.manifest.verify) {
      // Same silence as landing, and the longer of the two in practice: the full suite with
      // no token burn to show for it (RUN-31). verifyWithFeedback can also hand work BACK to
      // the agent on a failure, which flips the phase to 'agent' again — see below.
      this.deps.report(run.id, { status: 'running', phase: 'verifying' });
      const result = await this.verifyWithFeedback({
        run,
        spec: repo.manifest.verify,
        cwd: worktree.path,
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
          this.deps.postComment?.(
            run.projectId,
            run.anchor.taskId,
            verifyFailureComment(repo.manifest.verify, result),
          );
        }
        exit = { ...exit, outcome: 'failed', isError: true, reason: 'verify' };
      }
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
    if (kind === 'verify' && driverSucceeded) {
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

    this.deps.report(run.id, {
      status: exit.outcome,
      agentId: runAgent.agentId,
      telemetry: exit.telemetry,
      logTail: tail,
      exit: { outcome: exit.outcome, reason: exit.reason },
    });

    // Keep only what a human still has to act on: a build whose diff did NOT land. Once
    // it is on the integration branch the worktree and its throwaway branch are dead
    // weight — reaping them here is what keeps ~/.noriq/worktrees from growing one
    // directory per run forever. Scope/verify and driver failures are cleaned up as before.
    if (!(kind === 'build' && driverSucceeded && !landed)) {
      await this.deps.worktrees
        .remove(worktree)
        .catch((err) => this.log.warn('worktree cleanup failed', { err: String(err) }));
    }
    this.log.info('run finished', { runId: run.id, outcome: exit.outcome, reason: exit.reason });
    return exit;
  }
}
