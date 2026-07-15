import type {
  AgentTool,
  LandPolicy,
  PermissionProfile,
  ProjectManifest,
  Run,
  RunBudget,
  RunKind,
} from '@noriq-dev/shared';
import type { RunAgent } from './client';
import { superviseBudget } from './drivers/budget';
import type { AgentDriver, DriverExit, DriverSession, DriverTelemetry, NoriqMcp } from './drivers/types';
import { type LandOutcome, assembleConflictPrompt, landFailureComment, parseResolution } from './land';
import { logger as defaultLogger } from './logger';
import { type VerifyExec, runVerify, verifyFailureComment } from './verify';
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
  status: 'running' | 'done' | 'failed';
  worktreePath?: string | null;
  /** The agent working this Run. The wire has always carried this slot and it was always
   *  null, because the daemon never knew the identity its child invented for itself — the
   *  daemon creates it now (RUN-43), so it can finally say. */
  agentId?: string | null;
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
    const verify = manifest.verify
      ? `\nBefore finishing, run the verify command: ${manifest.verify.cmd}`
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
  }): Promise<LandOutcome> {
    const { run, repo, worktree, policy } = ctx;
    const branch = policy.branch;
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

    // The gate, on the REBASED result — the thing that will actually land.
    if (policy.onlyWhenVerifyPasses && repo.manifest.verify) {
      const result = await runVerify(repo.manifest.verify, worktree.path, { exec: this.deps.verifyExec });
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
    return { landed: true, branch, sha: ff.sha, resolvedByAgent };
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
    this.deps.report(run.id, { status: 'running', worktreePath: worktree.path });
    this.log.info('run started', { runId: run.id, kind, tool: run.agentTool, worktree: worktree.path });

    // Resolve the anchor task's text so the agent starts knowing the job. Best-effort:
    // a lookup failure degrades to the bare id rather than sinking the run.
    let task: AnchorTask | null = null;
    if (run.anchor?.type === 'task' && this.deps.resolveTask) {
      task = await this.deps.resolveTask(run.anchor.taskId).catch((err) => {
        this.log.warn('anchor task lookup failed — prompting with the bare id', {
          runId: run.id,
          taskId: run.anchor?.type === 'task' ? run.anchor.taskId : null,
          err: String(err),
        });
        return null;
      });
    }

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
    const budgetRun = superviseBudget(driver, {
      runId: run.id,
      kind,
      cwd: worktree.path,
      prompt,
      permission,
      noriqMcp,
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
      const outcome = await this.withRepoLock(repo.root, () =>
        this.landRun({
          run,
          repo,
          worktree,
          policy: landPolicy,
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
      const result = await runVerify(repo.manifest.verify, worktree.path, { exec: this.deps.verifyExec });
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
