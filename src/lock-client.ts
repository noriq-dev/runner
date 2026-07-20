import { VERSION } from './version';

/**
 * A minimal MCP-over-HTTP client for Noriq's four file-lock tools (RUN-98).
 *
 * Separate from `NoriqClient.mcpCall`, and deliberately: that call is bound to the DAEMON's own
 * OAuth token, but a lock's holder is the authenticated actor, and we want the holder to be the
 * RUN's bound agent (RUN-97 §2) — so the daemon's predictive acquire and the in-agent hook's
 * reactive acquire land on ONE holder and never fight each other, and the server's
 * auto-release-on-task-settle covers cleanup. Hence the token is per CALL, not per client.
 *
 * The lock contract is MCP-only (no REST) and is NOT in `packages/shared`, so the request/reply
 * shapes below are defined here against the tool JSON (mirrors `apps/api/src/mcp.ts`).
 */

export interface LockGrant {
  /** The lock id, for a targeted release. */
  id: string;
  /** The canonical (normalized, repo-relative POSIX) path this grant covers. */
  path: string;
}

export interface LockConflict {
  /** The path we asked for that collided. */
  path: string;
  /** The agent id holding the colliding lock. */
  holder: string;
  /** The holder's display name, when the server joined it. */
  holderName?: string | null;
  /** The task the holder is working, if any — the coordination handle. */
  taskKey?: string | null;
  branch?: string | null;
  /** When the holder's lock expires (ISO) — how long a wait would be. */
  expiresAt?: string | null;
}

export type AcquireResult =
  /** `enabled:false` = the project has file locking OFF; the caller proceeds unlocked (a no-op
   *  grant), which is why it is an `ok:true` shape and not an error. */
  | { ok: true; enabled: boolean; locks: LockGrant[]; expiresAt?: string | null }
  | { ok: false; conflicts: LockConflict[] };

export interface CheckResult {
  enabled: boolean;
  conflicts: LockConflict[];
  /** The subset already held by the querying identity. */
  mine: LockGrant[];
}

export interface AcquireInput {
  projectId: string;
  paths: string[];
  /** Scope branch = the run's landing target (RUN-97 §5). null/undefined → all branches. */
  branch?: string | null;
  taskId?: string | null;
}

export interface LockClientOptions {
  server: string;
  fetchImpl?: typeof fetch;
}

/** What the raw MCP tool call yields, before we shape it into the results above. */
interface ToolReply {
  isError: boolean;
  text: string;
  body: unknown;
}

const NOT_ENABLED = /not enabled|locking (is )?off|locking disabled/i;

export class LockClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  /** One server-assigned MCP session per token (the run's agent). Re-initialized on a stale
   *  session, exactly like NoriqClient.mcpCall — worker isolates recycle sessions at will. */
  private readonly sessions = new Map<string, string>();

  constructor(opts: LockClientOptions) {
    this.base = opts.server.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Acquire exclusive locks over `paths`, all-or-nothing, as `token`'s identity. A disabled
   *  project yields `{ ok:true, enabled:false }` — a no-op the caller proceeds past. */
  async acquire(token: string, input: AcquireInput): Promise<AcquireResult> {
    const reply = await this.callTool(token, 'acquire_lock', this.acquireArgs(input));
    if (reply.isError) {
      if (NOT_ENABLED.test(reply.text)) return { ok: true, enabled: false, locks: [] };
      throw new Error(`acquire_lock: ${reply.text.slice(0, 300)}`);
    }
    const body = reply.body as {
      ok?: boolean;
      locks?: Array<{ id: string; path: string }>;
      expiresAt?: string | null;
      conflicts?: RawConflict[];
    };
    if (body?.ok === false) return { ok: false, conflicts: (body.conflicts ?? []).map(shapeConflict) };
    return {
      ok: true,
      enabled: true,
      locks: (body?.locks ?? []).map((l) => ({ id: l.id, path: l.path })),
      expiresAt: body?.expiresAt ?? null,
    };
  }

  /** Release locks by id or by the exact paths taken. Best-effort: a release that finds nothing
   *  (already auto-released on task settle, or expired) is success, not an error. */
  async release(
    token: string,
    projectId: string,
    sel: { lockIds?: string[]; paths?: string[] },
  ): Promise<{ released: string[] }> {
    const reply = await this.callTool(token, 'release_lock', {
      projectId,
      ...(sel.lockIds?.length ? { lockIds: sel.lockIds } : {}),
      ...(sel.paths?.length ? { paths: sel.paths } : {}),
    });
    if (reply.isError) {
      if (NOT_ENABLED.test(reply.text)) return { released: [] };
      throw new Error(`release_lock: ${reply.text.slice(0, 300)}`);
    }
    const body = reply.body as { released?: string[] };
    return { released: body?.released ?? [] };
  }

  /** Look without taking (read-only): who holds locks colliding with `paths` on the scope
   *  branch, and which are already the caller's. The dispatch-time precheck (RUN-103). */
  async check(token: string, input: AcquireInput): Promise<CheckResult> {
    const reply = await this.callTool(token, 'check_locks', this.acquireArgs(input));
    if (reply.isError) {
      if (NOT_ENABLED.test(reply.text)) return { enabled: false, conflicts: [], mine: [] };
      throw new Error(`check_locks: ${reply.text.slice(0, 300)}`);
    }
    const body = reply.body as { enabled?: boolean; conflicts?: RawConflict[]; yours?: RawConflict[] };
    if (body?.enabled === false) return { enabled: false, conflicts: [], mine: [] };
    return {
      enabled: true,
      conflicts: (body?.conflicts ?? []).map(shapeConflict),
      mine: (body?.yours ?? []).map((c) => ({ id: c.lockId ?? '', path: c.path })),
    };
  }

  /** Shared arg shape for acquire/check: an explicit branch scopes conflicts to it; its absence
   *  means all-branches (the server's own fallback), which we make explicit. */
  private acquireArgs(input: AcquireInput): Record<string, unknown> {
    const branch = input.branch?.trim();
    return {
      projectId: input.projectId,
      paths: input.paths,
      ...(branch ? { branch } : { allBranches: true }),
      ...(input.taskId ? { taskId: input.taskId } : {}),
    };
  }

  /**
   * One MCP `tools/call`, returning the tool's error flag + text + parsed body. Initializes a
   * session for `token` lazily and re-initializes ONCE on a session the server has forgotten.
   */
  private async callTool(token: string, name: string, args: Record<string, unknown>): Promise<ToolReply> {
    const attempt = async (sid: string) => {
      const res = await this.fetchImpl(`${this.base}/mcp`, {
        method: 'POST',
        headers: { ...this.headers(token), 'mcp-session-id': sid },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      return { res, raw: await res.text() };
    };
    let sid = this.sessions.get(token) ?? (await this.initialize(token));
    let { res, raw } = await attempt(sid);
    if (res.status === 400 || res.status === 404) {
      this.sessions.delete(token);
      sid = await this.initialize(token);
      ({ res, raw } = await attempt(sid));
    }
    if (!res.ok) throw new Error(`${name} → ${res.status}: ${raw.slice(0, 300)}`);
    return parseToolReply(raw);
  }

  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
  }

  /** Handshake for a server-assigned session (the server rejects sessionless tool calls as
   *  unattributable — see NoriqClient.mcpInitialize). Cached per token. */
  private async initialize(token: string): Promise<string> {
    const headers = this.headers(token);
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
        `lock mcp initialize → ${res.status}${sid ? '' : ' (no mcp-session-id header)'}: ${raw.slice(0, 200)}`,
      );
    }
    await this.fetchImpl(`${this.base}/mcp`, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }).catch(() => {
      /* best-effort — the tool call is the real probe */
    });
    this.sessions.set(token, sid);
    return sid;
  }
}

interface RawConflict {
  requestedPath?: string;
  path: string;
  lockId?: string;
  holderAgentId?: string;
  holderName?: string | null;
  taskKey?: string | null;
  branch?: string | null;
  expiresAt?: string | null;
}

function shapeConflict(c: RawConflict): LockConflict {
  return {
    path: c.requestedPath ?? c.path,
    holder: c.holderAgentId ?? '',
    holderName: c.holderName ?? null,
    taskKey: c.taskKey ?? null,
    branch: c.branch ?? null,
    expiresAt: c.expiresAt ?? null,
  };
}

/**
 * Pull the JSON-RPC envelope out of an MCP reply — SSE frames (`data: {…}`) or bare JSON — and
 * expose the tool's `isError` (which `parseMcpText` discards) so a "locking not enabled" reply
 * can be told from a real failure. Mirrors the shipped hook's `callTool`.
 */
export function parseToolReply(raw: string): ToolReply {
  const line = raw.split('\n').find((l) => l.startsWith('data:'));
  const envelope = JSON.parse(line ? line.replace(/^data:\s*/, '') : raw) as {
    result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    error?: { message?: string };
  };
  if (envelope.error) throw new Error(envelope.error.message ?? 'mcp error');
  const text = envelope.result?.content?.find((c) => c.type === 'text')?.text ?? '';
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text; // a tool that answered in prose (usually an error string)
  }
  return { isError: envelope.result?.isError === true, text, body };
}
