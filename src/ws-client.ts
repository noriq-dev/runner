import {
  MISSION_CAPABILITY,
  MISSION_HANDOFF_CAPABILITY,
  RUNNER_PROTOCOL_CAPABILITIES,
  RUNNER_PROTOCOL_VERSION,
  RunnerClientMessage,
  RunnerServerMessage,
} from '@noriq-dev/shared';
import type {
  AgentTool,
  ExecutedConfigurationEvidence,
  ExecutionSpec,
  MissionAdoptionResult,
  MissionHandoffAck,
  MissionHandoffConsumed,
  MissionHandoffPublication,
  MissionInventoryItem,
  MissionLeaseRef,
  MissionQuestionAck,
  MissionQuestionAnswer,
  MissionQuestionPublication,
  MissionRootCommission,
  MissionTaskAck,
  MissionTaskBeginReport,
  MissionTaskSettleReport,
  Run,
  RunKind,
  RunModelUsage,
  RunPhase,
  RunStatus,
} from '@noriq-dev/shared';
import { WebSocket } from 'ws';
import type { logger as Logger } from './logger';
import type { RepoReport } from './registration';

// Minimal socket surface the client depends on — lets tests inject a fake without
// pulling in ws's full type. `ws` satisfies it.
export interface WsSocket {
  on(event: string, listener: (...args: unknown[]) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Destroy the socket without a closing handshake. A HALF-OPEN socket — the peer gone without a
   *  FIN, the suspend/resume case — will never complete `close()`'s handshake, so the liveness
   *  check (RUN-176) must be able to tear down unilaterally. Optional: `ws` provides it, a fake
   *  may rely on `close()` being used as the fallback. */
  terminate?(): void;
}
export type WsFactory = (url: string, headers: Record<string, string>) => WsSocket;

/** Monotonic, process-local identity for one concrete WebSocket connection. */
export type WsConnectionGeneration = number;

export interface WsIdentity {
  label: string;
  tools: AgentTool[];
  kinds: RunKind[];
  maxConcurrency: number;
  /** The repo reports the FIRST hello advertises, and the standing fallback when `refreshRepos`
   *  fails — the same shape registration sent, so the two report paths cannot drift (RUN-195). */
  repos: RepoReport[];
}

export interface SteerMsg {
  runId: string;
  steerId: string;
  mode: 'soft' | 'hard';
  body: string;
  sourceCommentId: string | null;
  sourceMessageId: string | null;
  noticeCursor: number | null;
}

export interface WsHandlers {
  onRegistered?: (
    msg: {
      runnerId: string;
      protocol: number;
      acceptedCapabilities: string[];
    },
    generation: WsConnectionGeneration,
  ) => void;
  onAssigned?: (
    run: Run,
    missionLease: MissionLeaseRef | null,
    missionCommission: MissionRootCommission | null,
    generation: WsConnectionGeneration,
  ) => void;
  /** Acknowledged task admission/settlement for a negotiated mission.v2 root. */
  onMissionTaskAck?: (ack: MissionTaskAck, generation: WsConnectionGeneration) => void;
  onMissionQuestionAck?: (
    runId: string,
    lease: MissionLeaseRef,
    ack: MissionQuestionAck,
    generation: WsConnectionGeneration,
  ) => void;
  onMissionQuestionAnswer?: (answer: MissionQuestionAnswer, generation: WsConnectionGeneration) => void;
  onMissionHandoffAck?: (ack: MissionHandoffAck, generation: WsConnectionGeneration) => void;
  onMissionHandoffConsumed?: (consumed: MissionHandoffConsumed, generation: WsConnectionGeneration) => void;
  /** Server-authored adoption request. Inventory construction must be read-only. */
  onMissionReconcileRequest?: (
    request: {
      deadline: string;
      items: readonly MissionInventoryItem[];
    },
    generation: WsConnectionGeneration,
  ) => void;
  /** Exact server decision after Runner submitted its durable local inventory. */
  onMissionReconcileResult?: (
    results: readonly MissionAdoptionResult[],
    generation: WsConnectionGeneration,
  ) => void;
  onCancel?: (
    msg: {
      runId: string;
      hard: boolean;
      reason: string | null;
    },
    generation: WsConnectionGeneration,
  ) => void;
  /** A human's steer to inject into the running process (RUN-16). */
  onSteer?: (steer: SteerMsg) => void;
  /** A plan finished — its working branch is ready to become a merge request (RUN-28). The FAST
   *  path only: the server also records it, and the daemon reconciles on connect, because a plan
   *  can complete while nothing is listening. */
  onPlanCompleted?: (msg: {
    planId: string;
    planKey: string;
    planTitle: string;
    projectId: string;
  }) => void;
  /** A human answered the question a run parked on (RUN-30) — bring its agent back. The fast
   *  path only: the answer is durable server-side, and the daemon re-asks on reconnect, because
   *  a question answered while the box was off is the normal case rather than the edge one. */
  onResume?: (msg: {
    runId: string;
    signalId: string;
    question: string | null;
    answer: string;
  }) => void;
  /** Fired on every reconnect (not the first connect) — a hook for supervision reconcile. */
  onReconnect?: (generation: WsConnectionGeneration) => void;
  /** The current socket generation ended. Authority-bearing work must stop until adoption. */
  onDisconnect?: (reason: string, generation: WsConnectionGeneration) => void;
}

export interface WsClientOptions {
  server: string;
  runnerId: string;
  /** A literal token, or a provider resolved on every (re)connect so a long-lived
   *  socket picks up a refreshed token after the 7-day access TTL rolls over. */
  token: string | (() => Promise<string>);
  identity: WsIdentity;
  /**
   * Re-resolved immediately after every socket opens and on heartbeats. The dial and hello use the
   * last successfully observed snapshot (initially the just-registered identity) so filesystem,
   * driver, or MCP attestation can never delay the control channel. A successful refresh follows
   * on a heartbeat frame; a failed one keeps the last good set.
   */
  refreshRepos?: () => Promise<RepoReport[]>;
  /** Current free capacity, sampled on each heartbeat. */
  freeSlots: () => number;
  heartbeatMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  handlers?: WsHandlers;
  logger?: Pick<typeof Logger, 'debug' | 'info' | 'warn' | 'error'>;
  /** Injectable socket factory (default: ws). */
  connect?: WsFactory;
}

const defaultConnect: WsFactory = (url, headers) => new WebSocket(url, { headers }) as unknown as WsSocket;

/**
 * Silent heartbeat intervals before a socket is declared half-open (RUN-176). Three at the default
 * 30s beat = ~90s to detection — generous against a pong that is merely slow, short enough that a
 * daemon back from suspend reconnects before a human wonders why the dashboard shows it offline.
 */
export const DEAD_AFTER_SILENT_BEATS = 3;

/** Convert an https/http server origin to the wss/ws /ws/runner/:id endpoint. */
export function runnerWsUrl(server: string, runnerId: string): string {
  const base = server.replace(/\/+$/, '').replace(/^http/, 'ws');
  return `${base}/ws/runner/${encodeURIComponent(runnerId)}`;
}

/**
 * Long-lived WS client to /ws/runner/:id — the standing connection that makes
 * idle-agent steering possible. Connects, says hello, heartbeats free capacity,
 * receives run.assigned/run.cancel, and reconnects with exponential backoff. On
 * reconnect it re-asserts the status of runs it still believes are live, so a
 * transient socket blip doesn't strand server-side Run state.
 */
export class WsClient {
  private readonly opts: Required<
    Pick<WsClientOptions, 'heartbeatMs' | 'reconnectBaseMs' | 'reconnectMaxMs'>
  > &
    WsClientOptions;
  private readonly connect: WsFactory;
  private readonly log: Pick<typeof Logger, 'debug' | 'info' | 'warn' | 'error'>;
  private sock: WsSocket | undefined;
  private sockGeneration: WsConnectionGeneration | null = null;
  private nextSockGeneration = 1;
  private stopped = false;
  private everConnected = false;
  private reconnectAttempt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  /** At most one filesystem/attestation refresh may run at a time. */
  private heartbeatRepoRefresh: Promise<void> | undefined;
  /** Heartbeat intervals since the last INBOUND frame (RUN-176). Reset by any received frame;
   *  crossing the deadline means the socket is half-open and gets terminated. */
  private silentBeats = 0;
  /** Accepted only for the current socket; cleared before any reconnect can dispatch work. */
  private acceptedCapabilities = new Set<string>();
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  // Runs the daemon believes are live (non-terminal) — re-asserted on reconnect.
  private readonly liveRuns = new Map<string, Record<string, unknown>>();
  /** The last good repo reports (RUN-195) — what the next hello advertises. Seeded from the
   *  identity, replaced by each successful `refreshRepos`, and deliberately KEPT on a failed
   *  one: a stale advertisement beats an empty one, and either beats not connecting. */
  private repos: RepoReport[];

  constructor(options: WsClientOptions) {
    this.opts = {
      heartbeatMs: options.heartbeatMs ?? 30_000,
      reconnectBaseMs: options.reconnectBaseMs ?? 1_000,
      reconnectMaxMs: options.reconnectMaxMs ?? 30_000,
      ...options,
    };
    this.connect = options.connect ?? defaultConnect;
    this.log = options.logger ?? {
      debug() {},
      info() {},
      warn() {},
      error() {},
    };
    this.repos = options.identity.repos;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.stopHeartbeat();
    this.acceptedCapabilities.clear();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    try {
      this.sock?.close(1000, 'shutdown');
    } catch {
      /* already gone */
    }
    this.sock = undefined;
    this.sockGeneration = null;
  }

  /**
   * Fail the current transport generation and enter the normal reconnect ladder. Durable mission
   * state remains outside this client; callers use this when an authority-bearing frame could not
   * be sent and continuing on the same generation would pretend the server observed it.
   */
  restartConnection(reason: string, expectedGeneration?: WsConnectionGeneration): void {
    if (this.stopped) return;
    if (expectedGeneration !== undefined && !this.isCurrentGeneration(expectedGeneration)) return;
    const sock = this.sock;
    const generation = this.sockGeneration;
    if (!sock || generation === null) return;
    this.log.warn('ws connection generation abandoned', { reason });
    // Publish revocation before asking the transport to close. Some WebSocket implementations
    // emit `close` synchronously, which would otherwise replace the authority-bearing reason with
    // a generic one before mission control can quiesce the generation.
    this.handleClose(sock, generation, reason);
    try {
      if (sock) (sock.terminate ?? sock.close).call(sock);
    } catch {
      /* the authoritative transition already happened above */
    }
  }

  /** Report a Run status transition upstream (the DO is the authority). Terminal
   *  statuses drop the run from the live set so it isn't re-asserted on reconnect. */
  sendRunStatus(
    runId: string,
    status: RunStatus,
    extra: {
      agentId?: string | null;
      exit?: Record<string, unknown> | null;
      worktreePath?: string | null;
      missionLease?: MissionLeaseRef | null;
      /** Required locally for mission-owned writes; never serialized onto the wire. */
      connectionGeneration?: WsConnectionGeneration;
    } = {},
  ): boolean {
    if (
      extra.missionLease &&
      (extra.connectionGeneration === undefined ||
        !this.hasAcceptedCapability(MISSION_CAPABILITY, extra.connectionGeneration))
    ) {
      this.liveRuns.delete(runId);
      return false;
    }
    const at = new Date().toISOString();
    // RunExit.finishedAt is REQUIRED by the wire contract and has no default. Callers
    // report the outcome, not the clock, so stamp it here — the server silently drops
    // any frame that fails its schema, which would strand the Run 'running' forever.
    const exit = extra.exit ? { ...extra.exit, finishedAt: extra.exit.finishedAt ?? at } : null;
    const msg: Record<string, unknown> = {
      type: 'run.status',
      runId,
      status,
      agentId: extra.agentId ?? null,
      exit,
      worktreePath: extra.worktreePath ?? null,
      missionLease: extra.missionLease ?? null,
      at,
    };
    const terminal = status === 'done' || status === 'gated' || status === 'failed' || status === 'cancelled';
    // Send FIRST, then decide what to remember. Dropping the run from liveRuns before the
    // send meant a terminal frame emitted while the socket was down vanished: reconnect
    // re-asserts only liveRuns, which no longer held it, so the Run sat 'running' forever
    // — exactly the stranding this class exists to prevent.
    const sent = this.sendRaw(msg);
    if (extra.missionLease) {
      // Mission replay belongs to the durable coordinator. Retaining this frame here would replay
      // its old lease immediately after reconnect, before server adoption advances the epoch.
      this.liveRuns.delete(runId);
      return sent;
    }
    if (terminal && sent) this.liveRuns.delete(runId);
    // A parked run must NOT be re-asserted (RUN-30). liveRuns exists to say "this box still has a
    // live process for this run" after a blip; a parked run has no process, and its durable record
    // is the parked store, which reconnect reconciles separately. Re-asserting it would be
    // actively wrong: if a human answered while the socket was down, the server has already moved
    // the run back to running, and running → blocked is a LEGAL transition — so the re-assert
    // would silently re-park a run that was just answered.
    else if (status === 'blocked') this.liveRuns.delete(runId);
    else this.liveRuns.set(runId, msg); // keep it: a reconnect must re-assert it
    return sent;
  }

  /** True only after this exact live socket negotiated the capability. */
  hasAcceptedCapability(capability: string, generation?: WsConnectionGeneration): boolean {
    return (
      (generation === undefined || this.isCurrentGeneration(generation)) &&
      this.acceptedCapabilities.has(capability)
    );
  }

  /** Exact current connection identity, or null while disconnected. */
  currentGeneration(): WsConnectionGeneration | null {
    return this.sockGeneration;
  }

  isCurrentGeneration(generation: WsConnectionGeneration): boolean {
    return this.sock !== undefined && this.sockGeneration === generation;
  }

  /** Report live spend + a log tail for a Run (RUN-22). Non-transitional: this is a
   *  best-effort telemetry tick, never re-asserted on reconnect (not in liveRuns).
   *
   *  @returns whether the frame actually reached the socket — the same signal `sendRunStatus`
   *  leans on. Telemetry is fire-and-forget, but the executed-spec record it can carry is owed
   *  exactly once (RUN-172), so the daemon uses this to hold that record until a frame carrying it
   *  leaves, rather than counting a down socket as a delivery (RUN-173). */
  sendTelemetry(
    runId: string,
    t: {
      tokensUsed?: number | null;
      usdSpent?: number | null;
      modelUsage?: RunModelUsage | null;
      logTail?: string | null;
      phase?: RunPhase | null;
      /** The spec this run was briefed with (RUN-166) — once, then null. */
      executedSpec?: ExecutionSpec | null;
      /** The coordinate this run actually resolved and started under (RUN-241) — once, then
       *  null. Mirrors `executedSpec` exactly; see `RunReport.executedConfiguration`'s doc. */
      executedConfiguration?: ExecutedConfigurationEvidence | null;
      /** Required by the server for every mission-owned lifecycle/telemetry write. */
      missionLease?: MissionLeaseRef | null;
      /** Required locally for mission-owned writes; never serialized onto the wire. */
      connectionGeneration?: WsConnectionGeneration;
    },
  ): boolean {
    if (
      t.missionLease &&
      (t.connectionGeneration === undefined ||
        !this.hasAcceptedCapability(MISSION_CAPABILITY, t.connectionGeneration))
    ) {
      return false;
    }
    return this.sendRaw({
      type: 'run.telemetry',
      runId,
      tokensUsed: t.tokensUsed ?? null,
      usdSpent: t.usdSpent ?? null,
      // The per-model mix (RUN-59), null-means-no-news like every field here: a tick that does not
      // yet know the split sends null and the server COALESCEs, so it never wipes a stored mix.
      modelUsage: t.modelUsage ?? null,
      logTail: t.logTail ?? null,
      // Null = no news, not "clear it" — the server COALESCEs every field on this frame.
      phase: t.phase ?? null,
      // Write-once server-side (RUN-166): what a run was briefed with is a fact about a moment
      // that has passed, so a redelivered frame must not replace it with a later view.
      executedSpec: t.executedSpec ?? null,
      // Write-once server-side too (RUN-241/PLNR-291): late Runner evidence about the resolved
      // configuration, not permission to rewrite the server's commissioning snapshot.
      executedConfiguration: t.executedConfiguration ?? null,
      missionLease: t.missionLease ?? null,
      at: new Date().toISOString(),
    });
  }

  /** Submit an idempotent server-authorized plan-task admission report. */
  sendMissionTaskBegin(
    runId: string,
    lease: MissionLeaseRef,
    begin: MissionTaskBeginReport,
    generation: WsConnectionGeneration,
  ): boolean {
    if (!this.hasAcceptedCapability(MISSION_CAPABILITY, generation)) return false;
    return this.sendRaw({ type: 'mission.task.begin', runId, lease, begin });
  }

  /** Submit an idempotent terminal plan-task settlement report. */
  sendMissionTaskSettle(
    runId: string,
    lease: MissionLeaseRef,
    settle: MissionTaskSettleReport,
    generation: WsConnectionGeneration,
  ): boolean {
    if (!this.hasAcceptedCapability(MISSION_CAPABILITY, generation)) return false;
    return this.sendRaw({ type: 'mission.task.settle', runId, lease, settle });
  }

  sendMissionQuestion(
    runId: string,
    lease: MissionLeaseRef,
    question: MissionQuestionPublication,
    generation: WsConnectionGeneration,
  ): boolean {
    if (!this.hasAcceptedCapability(MISSION_CAPABILITY, generation)) return false;
    return this.sendRaw({ type: 'mission.question.publish', runId, lease, question });
  }

  sendMissionHandoff(
    runId: string,
    lease: MissionLeaseRef,
    publication: MissionHandoffPublication,
    generation: WsConnectionGeneration,
  ): boolean {
    if (!this.hasAcceptedCapability(MISSION_HANDOFF_CAPABILITY, generation)) return false;
    return this.sendRaw({ type: 'mission.handoff.publish', runId, lease, publication });
  }

  /** Reply to reconciliation from a read-only snapshot of durable local mission state. */
  sendMissionReconciliation(
    inventory: readonly MissionInventoryItem[],
    generation: WsConnectionGeneration,
  ): boolean {
    if (!this.hasAcceptedCapability(MISSION_CAPABILITY, generation)) return false;
    return this.sendRaw({
      type: 'mission.reconcile',
      inventory: [...inventory],
      observedAt: new Date().toISOString(),
    });
  }

  /** Stream transcript segments for a Run (RUN-74). Best-effort like telemetry: a batch the
   *  socket misses is simply gone — the server dedups on (runId, seq), so nothing double-writes,
   *  and logTail remains the fallback surface. */
  sendRunLog(
    runId: string,
    segments: Array<{
      seq: number;
      role: string;
      round: number | null;
      text: string;
      at: string;
    }>,
  ): void {
    if (!segments.length) return;
    this.sendRaw({ type: 'run.log', runId, segments });
  }

  /** Push the current freeSlots advertisement NOW rather than at the next timed beat (RUN-170).
   *  The server is the admission authority — the daemon has never refused an assignment, so the
   *  only enforcement that reaches dispatch is what this box last advertised. A capacity change
   *  that waits out the heartbeat interval is therefore a window the server can dispatch into: a
   *  wave grant claims several slots the last beat still called free. Best-effort like the beat
   *  itself — a down socket drops the frame and the next beat re-asserts the same figure. No ping
   *  rides along and no silent-beat accounting moves: this is an advertisement, not a probe. */
  advertiseCapacity(): void {
    if (this.stopped) return;
    this.sendRaw({ type: 'heartbeat', freeSlots: this.opts.freeSlots() });
  }

  private open(): void {
    void this.openAsync();
  }

  private async openAsync(): Promise<void> {
    const url = runnerWsUrl(this.opts.server, this.opts.runnerId);
    let token: string;
    try {
      token = typeof this.opts.token === 'string' ? this.opts.token : await this.opts.token();
    } catch (err) {
      // A refresh can fail transiently (server down) — back off and retry rather than
      // kill the daemon; a permanently dead credential surfaces as a repeating warn.
      this.log.warn('ws token unavailable', { err: String(err) });
      this.scheduleReconnect();
      return;
    }
    // stop() may have landed while we were awaiting the token.
    if (this.stopped) return;
    let sock: WsSocket;
    try {
      sock = this.connect(url, { Authorization: `Bearer ${token}` });
    } catch (err) {
      this.log.warn('ws connect failed', { err: String(err) });
      this.scheduleReconnect();
      return;
    }
    // Negotiation belongs to one socket generation. Clear it before publishing the replacement
    // socket so even an accidental overlapping start cannot borrow the prior generation's grant.
    this.acceptedCapabilities.clear();
    const generation = this.nextSockGeneration;
    this.nextSockGeneration += 1;
    this.sock = sock;
    this.sockGeneration = generation;
    // Every handler is SCOPED to the socket that registered it (RUN-176). Sockets outlive their
    // tenure — a terminated one can still emit a late 'close', a slow one a late 'message' — and
    // an unscoped handler would let a dead socket stop the live one's heartbeat, clear its slot,
    // stack a second reconnect timer, or reset its liveness counter. A stale event now simply
    // finds it is not the current socket and does nothing.
    sock.on('open', () => {
      if (this.sock === sock && this.sockGeneration === generation) this.handleOpen(generation);
    });
    sock.on('message', (data: unknown) => {
      if (this.sock === sock && this.sockGeneration === generation) this.handleMessage(data, generation);
    });
    sock.on('close', () => this.handleClose(sock, generation, 'socket closed'));
    sock.on('error', (err: unknown) => {
      if (this.sock === sock && this.sockGeneration === generation) {
        this.log.warn('ws error', { err: String(err) });
      }
    });
  }

  private handleOpen(generation: WsConnectionGeneration): void {
    const isReconnect = this.everConnected;
    this.everConnected = true;
    this.reconnectAttempt = 0;
    this.sendRaw({
      type: 'hello',
      protocol: RUNNER_PROTOCOL_VERSION,
      protocolCapabilities: RUNNER_PROTOCOL_CAPABILITIES,
      runnerId: this.opts.runnerId,
      label: this.opts.identity.label,
      tools: this.opts.identity.tools,
      kinds: this.opts.identity.kinds,
      maxConcurrency: this.opts.identity.maxConcurrency,
      // The set the refresh above resolved for THIS connection — a reconnect after workflow or
      // manifest edits advertises the changed catalogs, same staleness contract as the rest of
      // the repo record (RUN-195).
      repos: this.repos,
    });
    this.startHeartbeat();
    // Registration has already produced a fresh initial snapshot. Re-attest after the control
    // channel is live so a slow project filesystem or vendor probe can never consume Noriq's
    // post-registration adoption window. The helper is single-flight and socket-scoped.
    this.refreshReposOnHeartbeat(this.sock, generation);
    this.log.info(isReconnect ? 'ws reconnected' : 'ws connected', {
      runnerId: this.opts.runnerId,
    });
    if (isReconnect) {
      this.opts.handlers?.onReconnect?.(generation);
      // Re-assert everything the server may have missed. A TERMINAL frame in here is one
      // that failed to send while the socket was down; once it lands, forget it —-
      // otherwise it would replay on every future reconnect.
      for (const [runId, msg] of this.liveRuns) {
        const sent = this.sendRaw(msg);
        const status = String(msg.status ?? '');
        const terminal =
          status === 'done' || status === 'gated' || status === 'failed' || status === 'cancelled';
        if (sent && terminal) this.liveRuns.delete(runId);
      }
    }
  }

  private handleMessage(data: unknown, generation: WsConnectionGeneration): void {
    // ANY inbound frame is proof of life (RUN-176) — before parsing, deliberately: a frame this
    // client's contract version cannot parse still travelled the wire, and liveness is a transport
    // question. Requiring a pong specifically would tear down a healthy connection busy with run
    // traffic whose pong is merely late.
    this.silentBeats = 0;
    let parsed: ReturnType<typeof RunnerServerMessage.safeParse>;
    try {
      parsed = RunnerServerMessage.safeParse(JSON.parse(String(data)));
    } catch {
      return;
    }
    if (!parsed.success) return;
    const msg = parsed.data;
    switch (msg.type) {
      case 'registered':
        this.acceptedCapabilities = new Set(msg.acceptedCapabilities);
        this.opts.handlers?.onRegistered?.(
          {
            runnerId: msg.runnerId,
            protocol: msg.protocol,
            acceptedCapabilities: msg.acceptedCapabilities,
          },
          generation,
        );
        return;
      case 'run.assigned':
        if (msg.missionLease && !this.acceptMissionFrame(msg.type)) return;
        this.opts.handlers?.onAssigned?.(msg.run, msg.missionLease, msg.missionCommission, generation);
        return;
      case 'mission.task.ack':
        if (!this.acceptMissionFrame(msg.type)) return;
        this.opts.handlers?.onMissionTaskAck?.(msg.ack, generation);
        return;
      case 'mission.question.ack':
        if (!this.acceptMissionFrame(msg.type)) return;
        this.opts.handlers?.onMissionQuestionAck?.(msg.runId, msg.lease, msg.ack, generation);
        return;
      case 'mission.question.answer':
        if (!this.acceptMissionFrame(msg.type)) return;
        this.opts.handlers?.onMissionQuestionAnswer?.(msg.answer, generation);
        return;
      case 'mission.handoff.ack':
        if (!this.acceptCapabilityFrame(MISSION_HANDOFF_CAPABILITY, msg.type)) return;
        this.opts.handlers?.onMissionHandoffAck?.(msg.ack, generation);
        return;
      case 'mission.handoff.consumed':
        if (!this.acceptCapabilityFrame(MISSION_HANDOFF_CAPABILITY, msg.type)) return;
        this.opts.handlers?.onMissionHandoffConsumed?.(msg.consumed, generation);
        return;
      case 'mission.reconcile.request':
        if (!this.acceptMissionFrame(msg.type)) return;
        this.opts.handlers?.onMissionReconcileRequest?.(
          {
            deadline: msg.deadline,
            items: msg.items,
          },
          generation,
        );
        return;
      case 'mission.reconcile.result':
        if (!this.acceptMissionFrame(msg.type)) return;
        this.opts.handlers?.onMissionReconcileResult?.(msg.results, generation);
        return;
      case 'run.cancel':
        this.liveRuns.delete(msg.runId);
        this.opts.handlers?.onCancel?.(
          {
            runId: msg.runId,
            hard: msg.hard,
            reason: msg.reason,
          },
          generation,
        );
        return;
      case 'plan.completed':
        this.opts.handlers?.onPlanCompleted?.({
          planId: msg.planId,
          planKey: msg.planKey,
          planTitle: msg.planTitle,
          projectId: msg.projectId,
        });
        return;
      case 'run.resume':
        this.opts.handlers?.onResume?.({
          runId: msg.runId,
          signalId: msg.signalId,
          question: msg.question,
          answer: msg.answer,
        });
        return;
      case 'steer':
        this.opts.handlers?.onSteer?.({
          runId: msg.runId,
          steerId: msg.steerId,
          mode: msg.mode,
          body: msg.body,
          sourceCommentId: msg.sourceCommentId,
          sourceMessageId: msg.sourceMessageId,
          noticeCursor: msg.noticeCursor,
        });
        return;
      case 'pong':
        return;
    }
  }

  /**
   * Mission authority is valid only after the current socket's `registered` frame explicitly
   * accepts mission.v2. Receiving an authority-bearing mission frame before that handshake (or
   * after a server declined the capability) is a protocol violation, not a message to ignore:
   * abandon the generation so no later frame on it can be mistaken for negotiated authority.
   */
  private acceptMissionFrame(type: string): boolean {
    return this.acceptCapabilityFrame(MISSION_CAPABILITY, type);
  }

  private acceptCapabilityFrame(capability: string, type: string): boolean {
    if (this.hasAcceptedCapability(capability)) return true;
    this.log.error('ws received an unnegotiated mission frame', {
      type,
      requiredCapability: capability,
    });
    this.restartConnection(`received ${type} without accepted ${capability}`);
    return false;
  }

  /** Ack a steer back to Noriq (dedup guard: `via='runtime'` suppresses the
   *  notices fallback so the same steer isn't double-delivered). */
  sendSteerAck(ack: {
    runId: string;
    steerId: string;
    delivered: boolean;
    via: 'runtime' | 'fallback' | 'dropped';
    noticeCursor?: number | null;
    detail?: string | null;
  }): void {
    this.sendRaw({
      type: 'steer.ack',
      runId: ack.runId,
      steerId: ack.steerId,
      delivered: ack.delivered,
      via: ack.via,
      noticeCursor: ack.noticeCursor ?? null,
      detail: ack.detail ?? null,
      ackedAt: new Date().toISOString(),
    });
  }

  /**
   * The one transition out of a socket's life, idempotent and scoped (RUN-176): only the CURRENT
   * socket's close moves the state, so the liveness teardown can call this directly (guaranteeing
   * the transition even on a transport whose close never completes) while the real 'close' event —
   * arriving later, or twice — finds the work already done and does nothing.
   */
  private handleClose(
    sock: WsSocket,
    generation: WsConnectionGeneration,
    reason = 'connection generation ended',
  ): void {
    if (this.sock !== sock || this.sockGeneration !== generation) return;
    this.stopHeartbeat();
    this.acceptedCapabilities.clear();
    this.sock = undefined;
    this.sockGeneration = null;
    this.opts.handlers?.onDisconnect?.(reason, generation);
    if (!this.stopped) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    // `stopped` re-checked HERE, not only at the call sites: the async token path can reject after
    // stop() ran, and rescheduling from that catch would keep a shut-down daemon dialling and
    // logging forever. One timer at a time, for the same shape of reason — a doubled close must
    // not stack a second ladder beside the first.
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(this.opts.reconnectBaseMs * 2 ** this.reconnectAttempt, this.opts.reconnectMaxMs);
    this.reconnectAttempt += 1;
    this.log.debug('ws reconnect scheduled', {
      delayMs: delay,
      attempt: this.reconnectAttempt,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.open();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.silentBeats = 0;
    this.heartbeatTimer = setInterval(() => {
      // The liveness deadline (RUN-176), counted in BEATS rather than wall-clock. The daemon used
      // to survive suspend/resume as a live process on a dead socket: writes into a half-open
      // socket succeed into the kernel buffer, no FIN ever arrives, so `close` never fires and the
      // reconnect ladder — which works on every real close — is simply never entered. The daemon
      // believed it was connected; the server had long dropped it; dispatches found nobody.
      //
      // Beats, not a timestamp, on purpose: after a resume, timers fire late and in a burst, and a
      // wall-clock deadline would also misfire across a paused process. Teardown lands on the
      // THIRD consecutive silent tick (~90s at the default beat): by then two pings and the hello
      // have all gone unanswered — with the server answering every ping (deployed behaviour), a
      // healthy idle connection never accumulates even two.
      this.silentBeats += 1;
      if (this.silentBeats >= DEAD_AFTER_SILENT_BEATS) {
        this.log.warn('ws heard nothing for the liveness deadline — assuming half-open, reconnecting', {
          silentBeats: this.silentBeats,
          heartbeatMs: this.opts.heartbeatMs,
        });
        const sock = this.sock;
        const generation = this.sockGeneration;
        // TERMINATE, not close: a half-open socket will never complete the closing handshake, and
        // a `close()` that waits for one would leave us exactly where we started. The transition
        // itself is GUARANTEED by the finally — handleClose is idempotent and socket-scoped, so
        // whichever of {the finally, ws's own 'close' event} arrives second finds the work done.
        // Without that, a terminate() that throws (already-destroyed socket) or a fallback close()
        // that never emits would re-create the exact hang this deadline exists to break.
        try {
          if (sock) (sock.terminate ?? sock.close).call(sock);
        } catch {
          /* the transition below is the part that matters */
        } finally {
          if (sock && generation !== null) {
            this.handleClose(sock, generation, 'socket liveness deadline exceeded');
          }
        }
        return;
      }
      this.sendRaw({ type: 'heartbeat', freeSlots: this.opts.freeSlots() });
      if (this.sockGeneration !== null) {
        this.refreshReposOnHeartbeat(this.sock, this.sockGeneration);
      }
      // The probe the deadline depends on: the server answers `ping` with `pong` (deployed), so a
      // healthy connection hears SOMETHING every interval even when no runs are moving. The
      // heartbeat alone cannot serve — the server records it and deliberately says nothing back.
      this.sendRaw({ type: 'ping' });
    }, this.opts.heartbeatMs);
  }

  /**
   * Execution-profile offers expire server-side, so a healthy long-lived socket must perform a
   * real bounded refresh and resend repo offers. Merely copying an old snapshot with a new clock
   * would turn stale local authority into a lie. The immediate heartbeat above preserves liveness;
   * this second frame carries only a successfully re-observed snapshot and never overlaps probes.
   */
  private refreshReposOnHeartbeat(sock: WsSocket | undefined, generation: WsConnectionGeneration): void {
    if (!sock || !this.opts.refreshRepos || this.heartbeatRepoRefresh) return;
    this.heartbeatRepoRefresh = this.opts
      .refreshRepos()
      .then((repos) => {
        if (this.stopped || this.sock !== sock || this.sockGeneration !== generation) return;
        this.repos = repos;
        this.sendRaw({
          type: 'heartbeat',
          freeSlots: this.opts.freeSlots(),
          repos,
        });
      })
      .catch((err) => {
        if (this.stopped || this.sock !== sock || this.sockGeneration !== generation) return;
        this.log.warn('could not refresh repo/profile attestations for heartbeat', {
          err: String(err),
        });
      })
      .finally(() => {
        this.heartbeatRepoRefresh = undefined;
      });
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  /** @returns whether the frame actually reached the socket. Callers that must not lose
   *  a frame (terminal statuses) use this to decide whether to keep it for re-assertion. */
  private sendRaw(msg: Record<string, unknown>): boolean {
    // The server does `safeParse(...); if (!parsed.success) return;` — an off-contract
    // frame is dropped without a word back, so a schema mismatch looks exactly like a
    // healthy daemon whose Runs never finish. Validate on the way OUT and say so loudly;
    // send anyway, since a false negative here shouldn't silence a valid report.
    const parsed = RunnerClientMessage.safeParse(msg);
    if (!parsed.success) {
      this.log.error('ws frame violates the wire contract — the server WILL drop it', {
        type: msg.type,
        runId: msg.runId,
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    // No socket (mid-reconnect) — `this.sock?.send()` would no-op in silence, which is how
    // a terminal status disappears without trace.
    if (!this.sock) return false;
    try {
      this.sock.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      // Also covers readyState CONNECTING, where ws throws rather than queueing.
      this.log.warn('ws send failed', { err: String(err) });
      return false;
    }
  }
}
