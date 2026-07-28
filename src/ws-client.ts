import { RUNNER_PROTOCOL_VERSION, RunnerClientMessage, RunnerServerMessage } from '@noriq-dev/shared';
import type {
  AgentTool,
  ExecutionSpec,
  Run,
  RunKind,
  RunModelUsage,
  RunPhase,
  RunStatus,
} from '@noriq-dev/shared';
import { WebSocket } from 'ws';
import type { logger as Logger } from './logger';

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

export interface WsIdentity {
  label: string;
  tools: AgentTool[];
  kinds: RunKind[];
  maxConcurrency: number;
  repos: Array<{ id: string; projectKey: string; name: string; defaultBranch: string | null }>;
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
  onRegistered?: (msg: { runnerId: string; protocol: number }) => void;
  onAssigned?: (run: Run) => void;
  onCancel?: (msg: { runId: string; hard: boolean; reason: string | null }) => void;
  /** A human's steer to inject into the running process (RUN-16). */
  onSteer?: (steer: SteerMsg) => void;
  /** A plan finished — its working branch is ready to become a merge request (RUN-28). The FAST
   *  path only: the server also records it, and the daemon reconciles on connect, because a plan
   *  can complete while nothing is listening. */
  onPlanCompleted?: (msg: { planId: string; planKey: string; planTitle: string; projectId: string }) => void;
  /** A human answered the question a run parked on (RUN-30) — bring its agent back. The fast
   *  path only: the answer is durable server-side, and the daemon re-asks on reconnect, because
   *  a question answered while the box was off is the normal case rather than the edge one. */
  onResume?: (msg: { runId: string; signalId: string; question: string | null; answer: string }) => void;
  /** Fired on every reconnect (not the first connect) — a hook for supervision reconcile. */
  onReconnect?: () => void;
}

export interface WsClientOptions {
  server: string;
  runnerId: string;
  /** A literal token, or a provider resolved on every (re)connect so a long-lived
   *  socket picks up a refreshed token after the 7-day access TTL rolls over. */
  token: string | (() => Promise<string>);
  identity: WsIdentity;
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
  private stopped = false;
  private everConnected = false;
  private reconnectAttempt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  /** Heartbeat intervals since the last INBOUND frame (RUN-176). Reset by any received frame;
   *  crossing the deadline means the socket is half-open and gets terminated. */
  private silentBeats = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  // Runs the daemon believes are live (non-terminal) — re-asserted on reconnect.
  private readonly liveRuns = new Map<string, Record<string, unknown>>();

  constructor(options: WsClientOptions) {
    this.opts = {
      heartbeatMs: options.heartbeatMs ?? 30_000,
      reconnectBaseMs: options.reconnectBaseMs ?? 1_000,
      reconnectMaxMs: options.reconnectMaxMs ?? 30_000,
      ...options,
    };
    this.connect = options.connect ?? defaultConnect;
    this.log = options.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    try {
      this.sock?.close(1000, 'shutdown');
    } catch {
      /* already gone */
    }
    this.sock = undefined;
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
    } = {},
  ): void {
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
      at,
    };
    const terminal = status === 'done' || status === 'failed' || status === 'cancelled';
    // Send FIRST, then decide what to remember. Dropping the run from liveRuns before the
    // send meant a terminal frame emitted while the socket was down vanished: reconnect
    // re-asserts only liveRuns, which no longer held it, so the Run sat 'running' forever
    // — exactly the stranding this class exists to prevent.
    const sent = this.sendRaw(msg);
    if (terminal && sent) this.liveRuns.delete(runId);
    // A parked run must NOT be re-asserted (RUN-30). liveRuns exists to say "this box still has a
    // live process for this run" after a blip; a parked run has no process, and its durable record
    // is the parked store, which reconnect reconciles separately. Re-asserting it would be
    // actively wrong: if a human answered while the socket was down, the server has already moved
    // the run back to running, and running → blocked is a LEGAL transition — so the re-assert
    // would silently re-park a run that was just answered.
    else if (status === 'blocked') this.liveRuns.delete(runId);
    else this.liveRuns.set(runId, msg); // keep it: a reconnect must re-assert it
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
    },
  ): boolean {
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
      at: new Date().toISOString(),
    });
  }

  /** Stream transcript segments for a Run (RUN-74). Best-effort like telemetry: a batch the
   *  socket misses is simply gone — the server dedups on (runId, seq), so nothing double-writes,
   *  and logTail remains the fallback surface. */
  sendRunLog(
    runId: string,
    segments: Array<{ seq: number; role: string; round: number | null; text: string; at: string }>,
  ): void {
    if (!segments.length) return;
    this.sendRaw({ type: 'run.log', runId, segments });
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
    this.sock = sock;
    // Every handler is SCOPED to the socket that registered it (RUN-176). Sockets outlive their
    // tenure — a terminated one can still emit a late 'close', a slow one a late 'message' — and
    // an unscoped handler would let a dead socket stop the live one's heartbeat, clear its slot,
    // stack a second reconnect timer, or reset its liveness counter. A stale event now simply
    // finds it is not the current socket and does nothing.
    sock.on('open', () => {
      if (this.sock === sock) this.handleOpen();
    });
    sock.on('message', (data: unknown) => {
      if (this.sock === sock) this.handleMessage(data);
    });
    sock.on('close', () => this.handleClose(sock));
    sock.on('error', (err: unknown) => this.log.warn('ws error', { err: String(err) }));
  }

  private handleOpen(): void {
    const isReconnect = this.everConnected;
    this.everConnected = true;
    this.reconnectAttempt = 0;
    this.sendRaw({
      type: 'hello',
      protocol: RUNNER_PROTOCOL_VERSION,
      runnerId: this.opts.runnerId,
      label: this.opts.identity.label,
      tools: this.opts.identity.tools,
      kinds: this.opts.identity.kinds,
      maxConcurrency: this.opts.identity.maxConcurrency,
      repos: this.opts.identity.repos,
    });
    this.startHeartbeat();
    this.log.info(isReconnect ? 'ws reconnected' : 'ws connected', { runnerId: this.opts.runnerId });
    if (isReconnect) {
      this.opts.handlers?.onReconnect?.();
      // Re-assert everything the server may have missed. A TERMINAL frame in here is one
      // that failed to send while the socket was down; once it lands, forget it —-
      // otherwise it would replay on every future reconnect.
      for (const [runId, msg] of this.liveRuns) {
        const sent = this.sendRaw(msg);
        const status = String(msg.status ?? '');
        const terminal = status === 'done' || status === 'failed' || status === 'cancelled';
        if (sent && terminal) this.liveRuns.delete(runId);
      }
    }
  }

  private handleMessage(data: unknown): void {
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
        this.opts.handlers?.onRegistered?.({ runnerId: msg.runnerId, protocol: msg.protocol });
        return;
      case 'run.assigned':
        this.opts.handlers?.onAssigned?.(msg.run);
        return;
      case 'run.cancel':
        this.liveRuns.delete(msg.runId);
        this.opts.handlers?.onCancel?.({ runId: msg.runId, hard: msg.hard, reason: msg.reason });
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
  private handleClose(sock?: WsSocket): void {
    if (sock && this.sock !== sock) return; // a past life's echo — the current socket is not yours
    this.stopHeartbeat();
    this.sock = undefined;
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
    this.log.debug('ws reconnect scheduled', { delayMs: delay, attempt: this.reconnectAttempt });
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
          this.handleClose(sock);
        }
        return;
      }
      this.sendRaw({ type: 'heartbeat', freeSlots: this.opts.freeSlots() });
      // The probe the deadline depends on: the server answers `ping` with `pong` (deployed), so a
      // healthy connection hears SOMETHING every interval even when no runs are moving. The
      // heartbeat alone cannot serve — the server records it and deliberately says nothing back.
      this.sendRaw({ type: 'ping' });
    }, this.opts.heartbeatMs);
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
