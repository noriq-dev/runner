import type { AgentTool, RunKind, RunnerConfig } from '@noriq-dev/shared';
import { NoriqClient } from './client';
import { discoverRepos } from './discovery';
import { totalTokens } from './drivers/budget';
import { ClaudeDriver } from './drivers/claude';
import { CodexDriver } from './drivers/codex';
import { logger as defaultLogger } from './logger';
import { ManifestStore } from './manifest-store';
import { buildRegistration } from './registration';
import { loadState, saveState } from './state';
import { SteeringBridge } from './steering';
import { RunSupervisor } from './supervisor';
import { detectTools } from './tools';
import { DEFAULT_WORKTREES_DIR, WorktreeManager } from './worktree';
import { WsClient } from './ws-client';

/** How long shutdown waits for stopped runs to report a terminal status. */
const SHUTDOWN_DRAIN_MS = 5_000;

export interface DaemonHandle {
  runnerId: string;
  /** Stop live agents, let them report, then close the socket. Await it before exiting. */
  stop(): Promise<void>;
}

/**
 * Ties the pieces together: register over REST (RUN-9), then hold the long-lived
 * WS connection (RUN-10) that receives dispatches and makes idle-agent steering
 * possible. Actually spawning/supervising agent processes on run.assigned lands
 * in Phase 4 (RUN-12+); here we register the assignment and track capacity.
 */
export class Daemon {
  private readonly active = new Set<string>();
  private readonly log: typeof defaultLogger;
  private readonly getToken: () => Promise<string>;
  private readonly refreshToken?: () => Promise<string>;

  constructor(
    private readonly config: RunnerConfig,
    /** A literal token, or a TokenSource-shaped provider that keeps itself fresh. */
    token: string | { get(): Promise<string>; refresh(): Promise<string> },
    deps: { logger?: typeof defaultLogger } = {},
  ) {
    this.log = deps.logger ?? defaultLogger;
    this.getToken = typeof token === 'string' ? async () => token : () => token.get();
    this.refreshToken = typeof token === 'string' ? undefined : () => token.refresh();
  }

  async start(): Promise<DaemonHandle> {
    const client = new NoriqClient({
      server: this.config.server,
      token: () => this.getToken(),
      onUnauthorized: this.refreshToken,
    });
    const repos = await discoverRepos(this.config.scanRoots);
    this.log.info(`discovered ${repos.length} repo(s)`, {
      repos: repos.map((r) => `${r.name}:${r.projectKey}`),
    });

    // Crash-safe cleanup: a fresh start means every prior local process is gone,
    // so any leftover noriq/run/* worktree is orphaned — reap it before we begin.
    const worktrees = new WorktreeManager({ baseDir: DEFAULT_WORKTREES_DIR });
    let reaped = 0;
    const kept: string[] = [];
    for (const r of repos) {
      reaped += await worktrees.reapOrphans(r.root, { onSkip: (p) => kept.push(p) });
    }
    if (reaped) this.log.info(`reaped ${reaped} orphaned worktree(s) from a prior run`);
    // Never silently discard an agent's output: a worktree with unsaved work outlives
    // the reap, and the human is told where it is rather than left to find out later.
    if (kept.length) {
      this.log.warn(
        `kept ${kept.length} orphaned worktree(s) holding unsaved work — review or delete by hand`,
        {
          worktrees: kept,
        },
      );
    }

    const state = await loadState();
    const tools = this.config.tools ?? detectTools();
    const registration = buildRegistration(
      { label: this.config.label, concurrency: this.config.concurrency, tools, runnerId: state.runnerId },
      repos,
    );
    const runner = await client.registerRunner(registration);
    await saveState({ runnerId: runner.id });
    this.log.info('registered with Noriq', {
      runnerId: runner.id,
      status: runner.status,
      repos: runner.repos.map((r) => `${r.projectKey}→${r.projectId ?? 'unresolved'}`),
    });

    // Supervisor composes worktree + driver + budget per dispatched Run. The `held`
    // holder breaks the ws↔supervisor reference cycle (supervisor reports via ws;
    // ws's onAssigned drives the supervisor). parentAgentId = the runner (the
    // daemon's identity) — the spawned agent registers under it via direct MCP.
    const reposById = new Map(repos.map((r) => [r.id, r]));
    // The committed marker is re-read per Run, so editing .noriq/project.toml takes
    // effect on the next dispatch instead of waiting for someone to restart the daemon.
    const manifests = new ManifestStore({ logger: this.log });
    for (const r of repos) manifests.seed(r.root, r.manifest);
    const held: { ws?: WsClient } = {};
    // Dedup run.status: the supervisor re-reports status:'running' on every telemetry
    // tick, but the DO only wants genuine transitions. Telemetry rides its own frame.
    const lastRunStatus = new Map<string, string>();
    const steering = new SteeringBridge({ logger: this.log });
    const supervisor = new RunSupervisor({
      drivers: {
        claude: new ClaudeDriver({ logger: this.log }),
        codex: new CodexDriver({ logger: this.log }),
      },
      worktrees,
      resolveRepo: async (repoRef) => {
        const r = reposById.get(repoRef);
        if (!r) return null;
        const manifest = await manifests.current(r.root);
        return manifest ? { root: r.root, manifest } : null;
      },
      report: (runId, rep) => {
        // Spend + log tail stream on their own frame (RUN-22) — no transition minted.
        if (rep.telemetry) {
          held.ws?.sendTelemetry(runId, {
            tokensUsed: totalTokens(rep.telemetry),
            usdSpent: rep.telemetry.costUsd,
            logTail: rep.logTail ?? null,
          });
        }
        // Forward run.status only on a real change (or when it carries worktree/exit).
        const changed = lastRunStatus.get(runId) !== rep.status;
        if (changed || rep.worktreePath != null || rep.exit != null) {
          lastRunStatus.set(runId, rep.status);
          held.ws?.sendRunStatus(runId, rep.status, { worktreePath: rep.worktreePath, exit: rep.exit });
        }
        if (rep.status === 'done' || rep.status === 'failed') lastRunStatus.delete(runId);
      },
      postComment: (projectId, taskId, body) => {
        void client
          .postComment(projectId, taskId, body)
          .catch((err) => this.log.warn('verify comment post failed', { err: String(err) }));
      },
      parentAgentId: runner.id,
      server: this.config.server,
      // runner.toml's `[budget]` — the machine's own ceilings for dispatches that
      // arrive without one. Otherwise such a Run would burn unbounded.
      defaultBudget: this.config.budget,
      // The agent's Noriq access (injected into its MCP transport) and the anchor
      // task's text. Without these an agent cannot register, claim, or report.
      getToken: () => this.getToken(),
      resolveTask: (taskId) => client.getTask(taskId),
      steering,
      logger: this.log,
    });

    const ws = new WsClient({
      server: this.config.server,
      runnerId: runner.id,
      token: () => this.getToken(),
      identity: {
        label: this.config.label,
        tools: runner.capabilities.tools as AgentTool[],
        kinds: runner.capabilities.kinds as RunKind[],
        maxConcurrency: this.config.concurrency,
        repos: registration.repos,
      },
      freeSlots: () => Math.max(0, this.config.concurrency - this.active.size),
      handlers: {
        onRegistered: (m) => this.log.debug('ws registered', m),
        onAssigned: (run) => {
          this.active.add(run.id);
          void supervisor.supervise(run).finally(() => this.active.delete(run.id));
        },
        onCancel: (m) => {
          // Hard interrupt + SIGTERM + worktree teardown (the supervisor's finally
          // removes the worktree and clears the active slot).
          this.log.info('run cancel received', { runId: m.runId, reason: m.reason });
          void steering.cancelRun(m.runId);
        },
        onSteer: (steer) => {
          // Inject the steer into the live process, then ack so Noriq's notices
          // fallback doesn't double-deliver (dedup guard).
          void steering.applySteer(steer).then((result) => held.ws?.sendSteerAck(result));
        },
        onReconnect: () => this.log.info('ws reconnected — reconciling live runs'),
      },
      logger: this.log,
    });
    held.ws = ws;
    ws.start();

    const stop = async (): Promise<void> => {
      // SIGTERM live agents BEFORE the socket closes. A spawned claude/codex isn't in the
      // daemon's teardown path, so exiting first orphans it: still editing the worktree,
      // still spending, with its only ceiling (the budget enforcer) dead.
      const stopped = await steering.stopAll();
      if (stopped.length) this.log.info(`stopped ${stopped.length} live run(s)`, { runs: stopped });
      // Give the supervisors a beat to report terminal statuses while the socket is still
      // open — otherwise the server strands those Runs 'running' until the next reconcile.
      const deadline = Date.now() + SHUTDOWN_DRAIN_MS;
      while (this.active.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (this.active.size > 0) {
        this.log.warn('shutting down with runs still settling — the server will reconcile them', {
          runs: [...this.active],
        });
      }
      ws.stop();
    };
    return { runnerId: runner.id, stop };
  }
}
