import type { RunnerRegistration } from './registration';
import { VERSION } from './version';

/** The slice of a task the daemon inlines into an agent's prompt. */
export interface TaskBrief {
  key: string;
  title: string;
  body: string | null;
}

/**
 * MCP over Streamable HTTP answers as SSE frames (`event: message` / `data: {…}`), so
 * the JSON-RPC envelope has to be pulled out of the stream before it can be read. Falls
 * back to treating the body as bare JSON.
 */
export function parseMcpText(raw: string): unknown {
  const line = raw.split('\n').find((l) => l.startsWith('data:'));
  const envelope = JSON.parse(line ? line.replace(/^data:\s*/, '') : raw) as {
    result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    error?: { message?: string };
  };
  if (envelope.error) throw new Error(envelope.error.message ?? 'mcp error');
  const text = envelope.result?.content?.find((c) => c.type === 'text')?.text;
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text; // a tool that answers in prose (e.g. an error string)
  }
}

export interface RegisteredRunnerRepo {
  id: string;
  projectKey: string;
  projectId: string | null;
  /** The board lock (RUN-71): the committed name we sent, and the server's resolution of it.
   *  boardId null while board is set = the name didn't resolve on this server. */
  board: string | null;
  boardId: string | null;
  name: string;
  defaultBranch: string | null;
}

/** The server's Runner view returned from registration/heartbeat. */
export interface RegisteredRunner {
  id: string;
  projectId: string | null;
  label: string;
  status: string;
  capabilities: { tools: string[]; kinds: string[]; maxConcurrency: number };
  repos: RegisteredRunnerRepo[];
  freeSlots: number;
  lastHeartbeatAt: string | null;
  createdAt: string;
}

/** The identity a Run's agent works under, plus the credential that IS that identity. */
export interface RunAgent {
  /** The `agt_…` the daemon created — no longer something we hope the model announces. */
  agentId: string;
  /** Friendly per-project display name, shown in the dashboard. */
  label: string;
  projectId: string;
  /** Bound to `agentId` alone. Never the runner's own token — see createRunAgent. */
  token: string;
  expiresIn: number;
}

/**
 * Whether a Run is parked on a human, and what they said (RUN-30).
 *
 * The daemon cannot work this out locally: the agent calls `request_input` over its own MCP
 * transport, straight to the server, with the daemon nowhere in that path. The row is the only
 * place the truth exists.
 */
export interface ParkState {
  status: string;
  /** The run is waiting on a human right now. */
  blocked: boolean;
  signalId: string | null;
  question: string | null;
  /** Non-null only once a human actually responded — the cue to resume, and the text to send. */
  answer: string | null;
}

/** A plan that finished and still owes a merge request (RUN-28). */
export interface OwedMerge {
  planId: string;
  planKey: string | null;
  planTitle: string;
  projectId: string;
  /** The repo whose working branch holds the plan's work — this runner landed it. */
  repoRef: string | null;
}

export interface HeartbeatInput {
  freeSlots: number;
  /** 'offline' is the clean-shutdown goodbye (RUN-35) — see Daemon.stop. */
  status?: 'online' | 'draining' | 'offline';
}

export interface NoriqClientOptions {
  server: string;
  /** A literal token, or a provider called per request (TokenSource.get). */
  token: string | (() => Promise<string>);
  /** Called once on a 401 to force a refresh; the request is then retried once. */
  onUnauthorized?: () => Promise<string>;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Thin REST client for the Noriq control plane. The daemon authenticates with the
 *  user's OAuth token (the only secret that crosses the wire). */
export class NoriqClient {
  private readonly base: string;
  private readonly getToken: () => Promise<string>;
  private readonly onUnauthorized?: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: NoriqClientOptions) {
    this.base = opts.server.replace(/\/+$/, '');
    const token = opts.token;
    this.getToken = typeof token === 'string' ? async () => token : token;
    this.onUnauthorized = opts.onUnauthorized;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request(method: string, pathname: string, body?: unknown, retry = true): Promise<unknown> {
    const res = await this.fetchImpl(`${this.base}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${await this.getToken()}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // A 401 mid-daemon-life is usually just an access token that lapsed early (revoked
    // elsewhere, clock skew). Refresh once and retry before surfacing it.
    if (res.status === 401 && retry && this.onUnauthorized) {
      await this.onUnauthorized();
      return this.request(method, pathname, body, false);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${pathname} → ${res.status}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : {};
  }

  /** Register (or re-register, if reg.runnerId is set) this runner. */
  async registerRunner(reg: RunnerRegistration): Promise<RegisteredRunner> {
    const out = (await this.request('POST', '/api/runners', reg)) as { runner: RegisteredRunner };
    return out.runner;
  }

  /** Report liveness + free capacity. */
  async heartbeat(runnerId: string, input: HeartbeatInput): Promise<void> {
    await this.request('POST', `/api/runners/${runnerId}/heartbeat`, input);
  }

  /**
   * Create the Noriq agent for a Run and take its credential (RUN-43).
   *
   * The daemon creates the identity; the spawned process inherits it by holding a token that
   * can only be that agent. Previously the prompt asked the model, in English, to call
   * set_agent_identity — so identity hinged on the model complying, we never learned the
   * agt_ it chose, and codex (which had no MCP wiring at all) was silently anonymous.
   *
   * The returned token is per-run and least-privilege: unlike the runner's own token it
   * cannot register runners or reach other projects, and the server revokes it when the Run
   * reaches a terminal state.
   */
  async createRunAgent(
    runId: string,
    opts: { label?: string; role?: 'orchestrator' | 'worker'; allowedTools?: string[] } = {},
  ): Promise<RunAgent> {
    // allowedTools is the kind's Noriq tool floor (security.ts, RUN-47): the server advertises
    // exactly this list to the agent over MCP, so the catalogue the model sees and the
    // allowlist the daemon enforces are two views of one policy. Optional on the wire — an
    // older server ignores it and the agent sees the full catalogue, the pre-RUN-47 behavior.
    return (await this.request('POST', `/api/runs/${runId}/agent`, opts)) as RunAgent;
  }

  /**
   * Is this Run parked on a human, and have they answered? (RUN-30)
   *
   * Asked at two moments: when an agent's session ends (is this "finished" or "asked a question
   * and stopped"? — only the row knows, and it is already authoritative, since request_input
   * commits the park before returning to the agent), and on reconnect for every run this daemon
   * has parked (a human can answer while the box is off — the normal case, not the edge one).
   */
  async getParkState(runId: string): Promise<ParkState> {
    return (await this.request('GET', `/api/runs/${runId}/park`)) as ParkState;
  }

  /**
   * Merge requests this runner still owes (RUN-28).
   *
   * The durable half of plan completion: the WS `plan.completed` frame is only the fast path. A
   * plan can finish while this box is off, while the runner is offboarded, or while the socket is
   * reconnecting — and a fire-and-forget push would drop the merge request silently and forever.
   * So the daemon asks on connect and reconciles.
   */
  async owedMerges(runnerId: string): Promise<OwedMerge[]> {
    const out = (await this.request('GET', `/api/runners/${runnerId}/owed-merges`)) as { owed: OwedMerge[] };
    return out.owed ?? [];
  }

  /** Report what happened to an owed merge request — opened, or failed with a reason. Recorded
   *  either way: marking only successes leaves a failure invisible and the plan owed forever, so
   *  the daemon retries the same broken thing on every reconnect and nobody learns why. */
  async reportMerge(
    runnerId: string,
    report: { planId: string; url?: string | null; failed?: string | null },
  ): Promise<void> {
    await this.request('POST', `/api/runners/${runnerId}/owed-merges/report`, {
      planId: report.planId,
      url: report.url ?? null,
      failed: report.failed ?? null,
    });
  }

  /** The daemon's live MCP session id (RUN-73). Null until the first call initializes. */
  private mcpSessionId: string | null = null;

  private async mcpHeaders(): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${await this.getToken()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
  }

  /**
   * Open an MCP session (RUN-73). The server rejects sessionless tool calls outright —
   * "sessionless calls are not attributable" — and it is right to: without this handshake the
   * daemon's get_task/add_comment were refused, so anchor prompts degraded to bare ids and
   * every gate comment (verify failure, reviewer rejection, land failure) silently never
   * posted. The session id rides the `mcp-session-id` response header.
   */
  private async mcpInitialize(): Promise<string> {
    const headers = await this.mcpHeaders();
    const res = await this.fetchImpl(`${this.base}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'noriq-runner', version: VERSION },
        },
      }),
    });
    const sid = res.headers.get('mcp-session-id');
    const raw = await res.text();
    if (!res.ok || !sid) {
      throw new Error(
        `mcp initialize → ${res.status}${sid ? '' : ' (no mcp-session-id header)'}: ${raw.slice(0, 200)}`,
      );
    }
    // The spec's follow-up; some transports won't serve requests until it arrives.
    await this.fetchImpl(`${this.base}/mcp`, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }).catch(() => {
      /* best-effort — the tool call below is the real probe */
    });
    this.mcpSessionId = sid;
    return sid;
  }

  /** Call an MCP tool as the daemon's actor, returning the tool's text payload parsed
   *  as JSON (Noriq tools answer with a single JSON text block). Initializes a session
   *  lazily and re-initializes ONCE on a session the server no longer knows — worker
   *  isolates recycle sessions at will, so the retry is load-bearing, not polish. */
  private async mcpCall(name: string, args: Record<string, unknown>): Promise<unknown> {
    const attempt = async (sid: string): Promise<{ res: Response; raw: string }> => {
      const res = await this.fetchImpl(`${this.base}/mcp`, {
        method: 'POST',
        headers: { ...(await this.mcpHeaders()), 'mcp-session-id': sid },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      return { res, raw: await res.text() };
    };
    let { res, raw } = await attempt(this.mcpSessionId ?? (await this.mcpInitialize()));
    if (res.status === 400 || res.status === 404) {
      // The session died with its isolate (or expired). One fresh handshake, one retry.
      this.mcpSessionId = null;
      ({ res, raw } = await attempt(await this.mcpInitialize()));
    }
    if (!res.ok) throw new Error(`${name} → ${res.status}: ${raw.slice(0, 300)}`);
    return parseMcpText(raw);
  }

  /** Post a comment on a task via MCP add_comment (e.g. the deterministic-verify
   *  failure surface, RUN-19). Uses the daemon's OAuth token as an MCP actor. */
  async postComment(projectId: string, taskId: string, body: string): Promise<void> {
    await this.mcpCall('add_comment', { projectId, taskId, body });
  }

  /** An anchor task's human-readable content, so the prompt can inline it instead of
   *  handing the agent an opaque id it has to go look up. */
  async getTask(taskId: string): Promise<TaskBrief | null> {
    const out = (await this.mcpCall('get_task', { taskId })) as { task?: Partial<TaskBrief> } | null;
    const t = out?.task;
    if (!t?.key || !t?.title) return null;
    return { key: t.key, title: t.title, body: t.body ?? null };
  }
}
