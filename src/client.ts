import type { RunnerRegistration } from './registration';

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

export interface HeartbeatInput {
  freeSlots: number;
  status?: 'online' | 'draining';
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

  /** Call an MCP tool as the daemon's actor, returning the tool's text payload parsed
   *  as JSON (Noriq tools answer with a single JSON text block). */
  private async mcpCall(name: string, args: Record<string, unknown>): Promise<unknown> {
    const res = await this.fetchImpl(`${this.base}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.getToken()}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    const raw = await res.text();
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
