/**
 * The `prepare` stage (RUN-131): turn a dispatch into a workspace, an identity and a brief — or
 * refuse it before a single token is spent.
 *
 * Shaped differently from the post-driver stages, and the difference is real rather than stylistic:
 * those mutate a `RunPipeline` that already exists, whereas this one is what BUILDS it. So it
 * returns a discriminated result — a refusal with a reason, or everything the run needs to start —
 * instead of narrowing a context it was handed.
 *
 * Six things can refuse a dispatch here, and they are ordered by what each one costs:
 *
 *   1. the repo, and 2. the driver — pure lookups, so they run first;
 *   3. claimability (RUN-81) — one server read, deliberately BEFORE the lease so a declined run
 *      leaves nothing behind;
 *   4. the workspace lease;
 *   5. the Noriq identity — no identity, no prompt worth sending;
 *   6. the predictive lock (RUN-103) — last, because it needs the identity's token.
 *
 * Everything from 4 on has something to unwind, and each of those paths says so where it happens.
 *
 * `resume` has no prepare: a parked run RESTORES its repo, workspace, identity and session from the
 * park record rather than resolving them again, which is the whole point of parking.
 */

import type { AgentTool, PermissionProfile, Run, RunBudget, RunKind } from '@noriq-dev/shared';
import type { RunAgent } from '../client';
import type { ContinuableRun, ContinuableStore } from '../continuable';
import type { AgentDriver, DriverStartOptions, NoriqMcp } from '../drivers/types';
import { type LockEnforcer, lockFloorComment } from '../lock-hooks';
import type { logger as defaultLogger } from '../logger';
import { type DocReader, type PathProbe, loadRepoContext, renderRepoContext } from '../repo-context';
import { noriqToolNamesFor } from '../security';
import {
  type AnchorTask,
  type ResolvedRepo,
  type RunReport,
  RunTally,
  type SupervisorVcs,
  assemblePrompt,
  effectiveKind,
  resolveAgentTool,
  resolveModel,
  telemetryFromSpent,
} from '../supervisor';
import type { RunTranscript } from '../transcript';
import type { LockContext, LockOutcome, Workspace } from '../vcs/types';
import { type Workflow, clampPermissionToWorkflow, resolveWorkflow, workflowFor } from '../workflow';

/**
 * What preparation may reach.
 *
 * Wider than the post-driver `StageHost` — about twice the members — and that is the honest answer
 * rather than a smell: preparing a run genuinely touches the repo, the driver table, the server, the
 * VCS backend, the lock layer and the context loader. The value of writing it down is that the list
 * exists at all; before this it was implicit in 260 lines of method body.
 */
export interface PrepareHost {
  readonly log: typeof defaultLogger;
  report(runId: string, frame: RunReport): void;
  postComment(projectId: string, taskId: string, body: string): void;
  transcript(runId: string): RunTranscript;
  /** The Noriq server the spawned agent reaches over direct MCP. */
  readonly server: string;
  resolveRepo(repoRef: string): ResolvedRepo | null | Promise<ResolvedRepo | null>;
  driverFor(tool: string): AgentDriver | undefined;
  vcsFor(repo: ResolvedRepo): SupervisorVcs;
  /** RUN-81's read-only phase-gate probe. Absent → the gate is simply not consulted. */
  checkClaimable?: (taskId: string) => Promise<{ claimable: boolean; reason: string | null } | null>;
  /** The plan's working branch a build forks from (RUN-82), when this run belongs to one. */
  planBase(repo: ResolvedRepo, run: Run): Promise<string | null>;
  /** The run's Noriq identity + its per-run token (RUN-43). Absent → the run cannot start. */
  createRunAgent?: (runId: string, opts: { label?: string; allowedTools?: string[] }) => Promise<RunAgent>;
  resolveAnchorTask(taskId: string): Promise<AnchorTask | null>;
  /** RUN-103's declared scope resolver. Absent → the predictive layer no-ops. */
  resolveLockScope?: (run: Run) => Promise<string[] | null> | string[] | null;
  lockScopeBranch(repo: ResolvedRepo, run: Run): string | null;
  /** The reactive per-edit enforcer (RUN-101), or undefined when there is no lock layer. */
  lockEnforcerFor(
    repo: ResolvedRepo,
    run: Run,
    worktree: Workspace,
    kind: RunKind,
    token: string,
  ): LockEnforcer | undefined;
  /** The run's effective ceiling: the dispatch's, else the machine default. */
  runBudget(run: Run): RunBudget | undefined;
  /** How `[context]` paths are probed and read (RUN-128/129) — injected so tests touch no disk. */
  readonly context: { probe?: PathProbe; read?: DocReader; budget?: number };
  readonly continuable?: Pick<ContinuableStore, 'get'>;
}

/** Everything `execute` needs, or the reason this dispatch was refused. */
export type PrepareOutcome = { ok: false; reason: string } | ({ ok: true } & PreparedRun);

export interface PreparedRun {
  repo: ResolvedRepo;
  driver: AgentDriver;
  workflow: Workflow;
  permission: PermissionProfile;
  noriqMcp?: NoriqMcp;
  worktree: Workspace;
  runAgent: RunAgent;
  task: AnchorTask | null;
  /** The prior sitting's state on a "continue a failed run" (RUN-92). */
  continued: ContinuableRun | null;
  /** Seeded with any prior spend, so this sitting's figures stay CUMULATIVE (RUN-59). */
  tally: RunTally;
  /**
   * The driver options, fully resolved — minus the two things preparation cannot own: `handlers`
   * (execute accumulates the output) and `env` (the supervisor's single sanitization point, applied
   * at spawn so the trust boundary holds no matter who calls).
   */
  start: Omit<DriverStartOptions, 'handlers' | 'env'>;
}

export const prepareRun = async (host: PrepareHost, run: Run): Promise<PrepareOutcome> => {
  const refuse = (reason: string): PrepareOutcome => ({ ok: false, reason });

  const repo = await host.resolveRepo(run.repoRef);
  if (!repo) return refuse(`repo not found for repoRef ${run.repoRef}`);
  const tool = resolveAgentTool(run); // the coordinate's tool (RUN-114), else agentTool
  const driver = host.driverFor(tool as AgentTool);
  if (!driver) return refuse(`no driver for tool ${tool}`);

  // Defense in depth (RUN-81): the server decides what to dispatch, but a bug in its phase/plan
  // gate — the removal of plan-task dependency edges left claim_task to enforce phase order
  // itself — must not let the daemon spawn an agent on a task that isn't unlocked yet (a phase-2
  // task offered while phase 1 is only in review). The gate lives server-side (phase_tasks), so
  // ask before spawning. This runs BEFORE the worktree lease so a declined run costs nothing.
  // Fail OPEN: only a definite `{ claimable: false }` stops the spawn; an absent probe or a
  // transient error leaves a legitimately-dispatched run untouched.
  if (run.anchor?.type === 'task' && host.checkClaimable) {
    const gate = await host.checkClaimable(run.anchor.taskId).catch((err) => {
      host.log.warn('claimability probe failed — spawning anyway (fail open)', {
        runId: run.id,
        err: String(err),
      });
      return null;
    });
    if (gate && !gate.claimable) {
      host.log.warn('anchor task is not claimable yet — declining to spawn (phase gate)', {
        runId: run.id,
        taskId: run.anchor.taskId,
        reason: gate.reason,
      });
      return refuse(
        `anchor task ${run.anchor.taskId} is not claimable yet — its plan phase is not unlocked${
          gate.reason ? ` (${gate.reason})` : ''
        }; not spawning`,
      );
    }
  }

  const kind = effectiveKind(run, repo.manifest); // RUN-126: a workflow's base posture is authoritative
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
  const planBase = wf.usesPlanBase ? await host.planBase(repo, run) : null;

  let worktree: Workspace;
  try {
    worktree = await host.vcsFor(repo).lease(repo.root, run.id, {
      readOnly,
      fromRunId: verifiesRunId ?? undefined,
      ...(wf.produces && planBase ? { fromTarget: planBase } : {}),
    });
  } catch (err) {
    // A verify run whose build is gone (reaped, or built on another machine) must fail
    // loudly: silently falling back to HEAD would hand back a confident PASS on an empty
    // diff, which is worse than no gate at all.
    if (verifiesRunId) {
      return refuse(
        `cannot verify ${verifiesRunId}: its work is not in this repo — ${(err as Error).message}`,
      );
    }
    return refuse(`workspace setup failed: ${(err as Error).message}`);
  }
  // dispatched → running, and the first phase (RUN-31). The status half is the real
  // transition; the phase half rides the telemetry frame the daemon splits this into.
  host.report(run.id, { status: 'running', worktreePath: worktree.localPath, phase: 'agent' });
  host.log.info('run started', { runId: run.id, kind, tool: run.agentTool, worktree: worktree.localPath });

  // Resolve the anchor task's text so the agent starts knowing the job. Best-effort:
  // a lookup failure degrades to the bare id rather than sinking the run.
  const task: AnchorTask | null =
    run.anchor?.type === 'task' ? await host.resolveAnchorTask(run.anchor.taskId) : null;

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
  if (host.createRunAgent) {
    try {
      // Declare the kind's Noriq tool floor with the identity (RUN-47): the server then
      // advertises exactly what the driver will permit, so the model never sees a tool it
      // cannot call. Same list the driver enforces — one policy, two views.
      runAgent = await host.createRunAgent(run.id, {
        label: `${run.kind}-${run.id.slice(-6)}`,
        allowedTools: noriqToolNamesFor(kind), // the EFFECTIVE kind (RUN-126), not the dispatched one
      });
      noriqMcp = { url: `${host.server.replace(/\/+$/, '')}/mcp`, token: runAgent.token };
      // Say who is working this Run as soon as we know — which is now BEFORE the process
      // starts, rather than never.
      host.report(run.id, { status: 'running', agentId: runAgent.agentId });
      host.log.info('run agent created', {
        runId: run.id,
        agentId: runAgent.agentId,
        label: runAgent.label,
      });
    } catch (err) {
      await host
        .vcsFor(repo)
        .dispose(worktree)
        .catch(() => {});
      return refuse(`could not create the Noriq agent for this run: ${(err as Error).message}`);
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
    verifiesRunId && (host.vcsFor(repo).kind ?? 'git') === 'git'
      ? `git diff ${planBase ?? repo.manifest.defaultBranch ?? worktree.baseId}...HEAD`
      : undefined;

  // No identity → no prompt worth sending. assemblePrompt now TELLS the agent who it is,
  // which it can only do if the daemon actually made someone.
  if (!runAgent) {
    await host
      .vcsFor(repo)
      .dispose(worktree)
      .catch(() => {});
    return refuse('no Noriq identity for this run — the daemon must create the agent before spawning it');
  }

  // Dispatch-time predictive locking (RUN-103): with a DECLARED scope, take its locks now — as
  // the run's holder, before the agent starts — and REFUSE a dispatch that clashes rather than
  // race two agents onto the same files. Runs here (not the RUN-81 pre-lease gate) because a
  // lock needs the run's agent token, which is only minted above; a refusal disposes the
  // just-leased worktree ONLY when it holds nothing (see below — a continuation's does).
  // No-op without a resolver / declared scope, so the reactive hook + hard floor stay the
  // guarantee.
  if (wf.produces && host.resolveLockScope && host.vcsFor(repo).lock) {
    const scope = (await host.resolveLockScope(run)) ?? [];
    if (scope.length) {
      const lockCtx: LockContext = {
        projectId: run.projectId,
        token: runAgent.token,
        branch: host.lockScopeBranch(repo, run),
        taskId: run.anchor?.type === 'task' ? run.anchor.taskId : null,
      };
      const outcome = await host.vcsFor(repo).lock!(worktree, scope, lockCtx).catch(
        () => ({ ok: true, enabled: false, locks: [] }) as LockOutcome,
      );
      if (!outcome.ok) {
        host.log.warn('predictive lock refused the dispatch — its declared scope clashes', {
          runId: run.id,
          holders: outcome.conflicts.map((c) => c.holderName ?? c.holder),
        });
        host
          .transcript(run.id)
          .milestone(
            `🔒 predictive lock refused this dispatch — its declared scope ${outcome.conflicts
              .map((c) => c.path)
              .join(', ')} is held by another run`,
          );
        if (run.anchor?.type === 'task') {
          host.postComment(run.projectId, run.anchor.taskId, lockFloorComment(outcome.conflicts));
        }
        // NEVER dispose a workspace that already holds work (RUN-130). A CONTINUATION adopts
        // its kept worktree and branch (RUN-91) — and a continuation is precisely what declares
        // a scope today, so this refusal fires exactly where the workspace carries the prior
        // sitting's committed diff. `dispose` force-removes the worktree and `-D`s its
        // never-pushed branch, which would destroy work that exists nowhere else. The comment
        // above used to say "a refusal disposes the just-leased worktree"; that was only true
        // while nothing was ever bound to declare a scope.
        //
        // Only GIT's dispose is destructive. A live backend sets `disposePreservesWork` and its
        // dispose is how the exclusive lease returns to the pool — skipping it there preserves
        // nothing and wedges every later run on the repo until the daemon restarts. The terminal
        // path in `settle` already draws exactly this distinction; this one has to as well.
        const vcsRef = host.vcsFor(repo);
        // "Could not tell" counts as work (RUN-152). This guard was always written that way; what
        // was missing is that `hasWork` used to answer `false` on a failed probe, so it never
        // fired. The backend rejects now, and the choice is made here where it is visible.
        const wouldDestroy =
          !vcsRef.disposePreservesWork &&
          (await vcsRef.hasWork(worktree).catch((err) => {
            host.log.warn('could not tell whether the workspace holds work — keeping it', {
              runId: run.id,
              err: String(err),
            });
            return true;
          }));
        if (wouldDestroy) {
          host.log.warn('lock refusal kept a workspace that holds work — not disposing', {
            runId: run.id,
          });
        } else {
          await vcsRef.dispose(worktree).catch(() => {});
        }
        return refuse(
          `declared file scope is locked by another run (${outcome.conflicts
            .map((c) => c.path)
            .join(', ')}); not spawning`,
        );
      }
    }
  }

  // The repo's `[context]` (RUN-128), resolved against its root and inlined under a budget
  // (RUN-129). A path that does not resolve is WARNED about rather than dropped in silence: a
  // required-reading list that quietly shrinks to nothing leaves the repo believing its agents
  // are oriented when they are not.
  // Read the context out of the RUN'S WORKSPACE, not the discovered checkout (RUN-128/129).
  // They are different trees: a build forks from the plan base, a continuation adopts a branch
  // with its own edits, and a verify run leases the build's branch. Inlining the checkout's
  // CLAUDE.md and then telling the agent not to re-read it would hand it instructions that do
  // not describe the tree it is standing in. `localPath` is where the agent actually runs.
  const repoCtx = await loadRepoContext(worktree.localPath, repo.manifest.context, {
    probe: host.context.probe,
    read: host.context.read,
    budget: host.context.budget,
  });
  for (const u of repoCtx.resolved.unresolved) {
    host.log.warn(
      `[context] ${u.declared} in ${repo.manifest.key} is ${
        u.reason === 'outside-repo' ? 'outside the repo — refused' : 'missing'
      }; not included in the brief`,
    );
  }
  if (repoCtx.loaded.skipped.length) {
    host.log.warn(
      `[context] budget spent before ${repoCtx.loaded.skipped.join(', ')} — named in the brief, not inlined`,
    );
  }

  const prompt = assemblePrompt(run, repo.manifest, {
    agent: runAgent,
    server: host.server,
    task,
    diffCmd,
    repoContext: repoCtx.rendered,
    // Rendered from the SAME resolved facts, not a second walk of the disk — only the inlined
    // documents differ (RUN-154).
    repoContextBrief: renderRepoContext(repoCtx.resolved, undefined, { audience: 'reviewer' }),
    // A repo-defined workflow (RUN-121) supplies its own prompt; its posture is still `kind`'s.
    // An unknown name resolves to undefined → assemblePrompt uses the built-in for run.kind.
    workflow: run.workflow ? resolveWorkflow(run.workflow, repo.manifest) : undefined,
  });

  // Every session that bills to this run records into one tally (RUN-59), so the run's spend AND
  // its model mix are the sum across sessions, always consistent with each other.
  const tally = new RunTally();
  // Continue a failed run (RUN-92). The lease above already ADOPTED the kept worktree (RUN-91);
  // this adds the two things git cannot carry across the fail→continue boundary: the prior spend
  // (re-seeded so this sitting's reported figures stay CUMULATIVE rather than overwriting the
  // server's totals with only what this sitting spends) and the adjudication ledger (handed to
  // the reviewer later so it does not relitigate what the earlier sitting settled).
  const continued = (await host.continuable?.get(run.id)) ?? null;
  if (continued) {
    tally.seed('__prior__', telemetryFromSpent(continued.spent));
    host.log.info('continuing a failed run — re-seeded prior spend and ledger', {
      runId: run.id,
      priorTokens: continued.spent.tokens,
      ledgerEntries: continued.ledger.length,
    });
  }

  return {
    ok: true,
    repo,
    driver,
    workflow: wf,
    permission,
    ...(noriqMcp ? { noriqMcp } : {}),
    worktree,
    runAgent,
    task,
    continued,
    tally,
    start: {
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
        ? host.lockEnforcerFor(repo, run, worktree, kind, runAgent.token)
        : undefined,
      // Keep the session alive past its first result ONLY when a feedback loop is possible: a
      // build, with a verify command to fail. Scope and verify runs want today's behaviour —
      // finish and close — and a session nobody closes hangs the daemon.
      multiTurn: wf.produces && Boolean(repo.manifest.verify),
      // Dispatch → repo [defaults] → the tool's own (RUN-33). The driver seam for `model` has
      // existed since RUN-12 and was dead: nothing ever set it, because Run had no field for it.
      ...resolveModel(run, repo.manifest),
      budget: host.runBudget(run),
    },
  };
};
