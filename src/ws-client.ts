import WebSocket from "ws";
import { StaticTokenProvider } from "./auth/token-provider.js";
import type { TokenProvider, TokenSnapshot } from "./auth/types.js";
import type { RunnerJobEventPayload } from "./contracts.js";
import {
  type RunnerToServer,
  runnerToServerSchema,
  type ServerToRunner,
  serverToRunnerSchema,
} from "./protocol.js";
import type { JobEventSink } from "./supervisor.js";

interface PendingEvent {
  message: RunnerToServer;
  retry: NodeJS.Timeout | null;
  waiters: Array<{
    resolve: (seq: number) => void;
    reject: (error: Error) => void;
  }>;
}

export class RunnerSocket implements JobEventSink {
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, PendingEvent>();
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly tokens: TokenProvider;
  onMessage?: (message: ServerToRunner) => void;
  onConnect?: () => void | Promise<void>;
  onDisconnect?: (code: number, reason: string) => void;
  onAuthenticationRequired?: (error: unknown) => void | Promise<void>;
  getHeartbeat?: () => { freeSlots: number; activeJobIds: string[] };

  constructor(
    private readonly url: string,
    tokens: TokenProvider | string,
    private readonly hello: RunnerToServer,
    private readonly acknowledgementTimeoutMs = 5_000,
    private boundGeneration = -1,
  ) {
    this.tokens =
      typeof tokens === "string" ? new StaticTokenProvider(tokens) : tokens;
  }

  onTokenGeneration?: (token: TokenSnapshot) => void | Promise<void>;

  connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private armPending(pending: PendingEvent): void {
    if (pending.retry) clearTimeout(pending.retry);
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      pending.retry = null;
      return;
    }
    this.send(pending.message);
    pending.retry = setTimeout(() => {
      pending.retry = null;
      this.armPending(pending);
    }, this.acknowledgementTimeoutMs);
  }

  async connect(): Promise<void> {
    let token: TokenSnapshot;
    try {
      token = await this.tokens.get();
    } catch (error) {
      await this.onAuthenticationRequired?.(error);
      this.socket?.close(4001, "runner authentication required");
      throw error;
    }
    if (
      this.socket?.readyState === WebSocket.OPEN &&
      token.generation === this.boundGeneration
    )
      return;
    if (this.socket) {
      const closing = this.socket;
      if (closing.readyState === WebSocket.CLOSED) {
        if (this.socket === closing) this.socket = null;
      } else
        await new Promise<void>((resolve) => {
          closing.once("close", () => resolve());
          if (closing.readyState !== WebSocket.CLOSING)
            closing.close(1000, "runner credential rotated");
        });
    }
    if (token.generation !== this.boundGeneration)
      await this.onTokenGeneration?.(token);
    const socket = new WebSocket(this.url, {
      headers: { Authorization: `Bearer ${token.accessToken}` },
    });
    this.socket = socket;
    this.boundGeneration = token.generation;
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          socket.off("open", opened);
          socket.off("error", failed);
          socket.off("close", closed);
          socket.off("unexpected-response", unexpected);
        };
        const opened = () => {
          cleanup();
          resolve();
        };
        const failed = (error: Error) => {
          cleanup();
          reject(error);
        };
        const closed = (code: number, reason: Buffer) => {
          cleanup();
          reject(
            new Error(
              `Runner socket closed during handshake (${code}): ${reason.toString() || "no reason"}`,
            ),
          );
        };
        const unexpected = (
          _request: import("node:http").ClientRequest,
          response: import("node:http").IncomingMessage,
        ) => {
          cleanup();
          response.resume();
          reject(
            new Error(
              `Runner socket handshake rejected with HTTP ${response.statusCode ?? "unknown"}`,
            ),
          );
        };
        socket.once("open", opened);
        socket.once("error", failed);
        socket.once("close", closed);
        socket.once("unexpected-response", unexpected);
      });
    } catch (error) {
      if (this.socket === socket) this.socket = null;
      throw error;
    }
    let heartbeat: NodeJS.Timeout | null = null;
    socket.on("message", (data) => {
      try {
        const message = serverToRunnerSchema.parse(JSON.parse(data.toString()));
        if (message.type === "job.event.ack") {
          for (const [key, pending] of this.pending) {
            const value = pending.message;
            if (
              value.type === "job.event" &&
              value.jobId === message.jobId &&
              value.assignmentId === message.assignmentId &&
              value.seq <= message.seq
            ) {
              this.pending.delete(key);
              if (pending.retry) clearTimeout(pending.retry);
              for (const waiter of pending.waiters) waiter.resolve(message.seq);
            }
          }
        }
        this.onMessage?.(message);
      } catch (error) {
        socket.close(
          1002,
          error instanceof Error
            ? error.message.slice(0, 120)
            : "invalid message",
        );
      }
    });
    socket.once("close", (code, reason) => {
      if (heartbeat) clearInterval(heartbeat);
      if (this.heartbeat === heartbeat) this.heartbeat = null;
      if (this.socket === socket) this.socket = null;
      for (const pending of this.pending.values()) {
        if (pending.retry) clearTimeout(pending.retry);
        pending.retry = null;
      }
      this.onDisconnect?.(code, reason.toString());
    });
    // Production Durable Objects can answer in the same turn as `send`. Install
    // every response/close handler before hello or replay so no assignment or
    // cumulative acknowledgement can arrive in an unobserved window.
    this.send(this.hello);
    for (const pending of this.pending.values()) this.armPending(pending);
    heartbeat = setInterval(() => {
      const status = this.getHeartbeat?.() ?? {
        freeSlots: 0,
        activeJobIds: [],
      };
      this.send({ type: "heartbeat", ...status });
    }, 15_000);
    this.heartbeat = heartbeat;
    try {
      await this.onConnect?.();
    } catch (error) {
      clearInterval(heartbeat);
      if (this.heartbeat === heartbeat) this.heartbeat = null;
      if (this.socket === socket) this.socket = null;
      socket.close(1011, "runner initialization failed");
      throw error;
    }
  }

  send(message: RunnerToServer): void {
    const parsed = runnerToServerSchema.parse(message);
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN)
      throw new Error("Runner socket is not connected");
    this.socket.send(JSON.stringify(parsed));
  }

  publish(
    jobId: string,
    assignmentId: string,
    seq: number,
    payload: RunnerJobEventPayload,
  ): Promise<number> {
    const key = `${jobId}:${assignmentId}:${seq}`;
    const existing = this.pending.get(key);
    if (existing)
      return new Promise((resolve, reject) =>
        existing.waiters.push({ resolve, reject }),
      );
    const message: RunnerToServer = {
      type: "job.event",
      jobId,
      assignmentId,
      seq,
      payload,
    };
    return new Promise((resolve, reject) => {
      const pending = {
        message,
        retry: null,
        waiters: [{ resolve, reject }],
      } satisfies PendingEvent;
      this.pending.set(key, pending);
      this.armPending(pending);
    });
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close(1000, "runner stopping");
    for (const pending of this.pending.values()) {
      if (pending.retry) clearTimeout(pending.retry);
      for (const waiter of pending.waiters)
        waiter.reject(new Error("runner stopped"));
    }
    this.pending.clear();
  }
}
