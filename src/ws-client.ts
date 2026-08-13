import WebSocket from "ws";
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
  waiters: Array<{
    resolve: (seq: number) => void;
    reject: (error: Error) => void;
  }>;
}

export class RunnerSocket implements JobEventSink {
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, PendingEvent>();
  private heartbeat: NodeJS.Timeout | null = null;
  onMessage?: (message: ServerToRunner) => void;
  getHeartbeat?: () => { freeSlots: number; activeJobIds: string[] };

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly hello: RunnerToServer,
  ) {}

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    const socket = new WebSocket(this.url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    this.send(this.hello);
    for (const pending of this.pending.values()) this.send(pending.message);
    const heartbeat = setInterval(() => {
      const status = this.getHeartbeat?.() ?? {
        freeSlots: 0,
        activeJobIds: [],
      };
      this.send({ type: "heartbeat", ...status });
    }, 15_000);
    this.heartbeat = heartbeat;
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
    socket.once("close", () => {
      clearInterval(heartbeat);
      if (this.heartbeat === heartbeat) this.heartbeat = null;
      if (this.socket === socket) this.socket = null;
    });
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
      this.pending.set(key, { message, waiters: [{ resolve, reject }] });
      if (this.socket?.readyState === WebSocket.OPEN) this.send(message);
    });
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close(1000, "runner stopping");
    for (const pending of this.pending.values())
      for (const waiter of pending.waiters)
        waiter.reject(new Error("runner stopped"));
    this.pending.clear();
  }
}
