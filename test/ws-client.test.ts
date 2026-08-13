import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { RunnerSocket } from "../src/ws-client.js";

describe("RunnerSocket", () => {
  let server: WebSocketServer | undefined;
  afterEach(async () => {
    if (server) {
      for (const client of server.clients) client.terminate();
      server.close();
      await once(server, "close");
      server = undefined;
    }
  });

  it("replays one unacknowledged sequence after reconnect and resolves duplicate waiters", async () => {
    server = new WebSocketServer({ port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("expected TCP server");
    let deliveries = 0;
    server.on("connection", (socket) => {
      socket.on("message", (bytes) => {
        const message = JSON.parse(bytes.toString()) as {
          type: string;
          seq?: number;
        };
        if (message.type !== "job.event") return;
        deliveries += 1;
        if (deliveries === 1) socket.close();
        else
          socket.send(
            JSON.stringify({
              type: "job.event.ack",
              jobId: "job",
              assignmentId: "assignment",
              seq: message.seq,
            }),
          );
      });
    });
    const client = new RunnerSocket(`ws://127.0.0.1:${address.port}`, "token", {
      type: "hello",
      protocolVersion: 2,
      runnerId: "runner",
      capacity: 1,
      repositories: [
        {
          repositoryKey: "repo",
          repoRef: "repo",
          vcs: "git",
          baseRevision: "a".repeat(40),
        },
      ],
    });
    await client.connect();
    const payload = {
      type: "warning" as const,
      at: new Date().toISOString(),
      code: "REPLAY",
      message: "replay me",
    };
    const first = client.publish("job", "assignment", 1, payload);
    const second = client.publish("job", "assignment", 1, payload);
    for (let attempt = 0; attempt < 100 && deliveries < 1; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await client.connect();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
    expect(deliveries).toBe(2);
    client.close();
  });

  it("rejects instead of hanging when the websocket handshake is refused", async () => {
    server = new WebSocketServer({
      port: 0,
      verifyClient: (_info, done) => done(false, 401, "unauthorized"),
    });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("expected TCP server");
    const client = new RunnerSocket(`ws://127.0.0.1:${address.port}`, "token", {
      type: "hello",
      protocolVersion: 2,
      runnerId: "runner",
      capacity: 1,
      repositories: [],
    });
    await expect(client.connect()).rejects.toThrow(/handshake rejected|401/);
    client.close();
  });
});
