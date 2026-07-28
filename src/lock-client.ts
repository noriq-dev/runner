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

/**
 * The server's answer when this identity was never granted the tool — the run-agent floor (RUN-47)
 * does not list it, so it is not in the catalogue.
 *
 * On the RELEASE path this is the EXPECTED answer, not an edge case: no kind is granted
 * `release_lock` or `list_locks`, because the agent shares the run's identity and would then be
 * able to drop the daemon's own hard-floor locks (see `security.ts`). The server releases a
 * task-anchored run's locks when the run settles, so the daemon's release was only ever
 * promptness — the no-op is the design, and warning on every run would train people to ignore
 * the log.
 *
 * Deliberately NOT honoured on acquire, where a missing tool means the floor never ran. Reading
 * that as "no locks needed" would turn a misconfiguration into a silent fail-open over exactly
 * the paths the floor exists to guard, so the run gates instead, loudly.
 *
 * Matched against the SPECIFIC tool being called rather than any "tool … not found" prose: the
 * server echoes paths and titles in error text, and a lock path is attacker-adjacent input.
 */
const toolMissing = (name: string, text: string): boolean =>
  new RegExp(`tool\\s+${name}\\s+not found`, 'i').test(text);

export class LockClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  /**
   * The MCP session per token — or `null` for a token that needs none (RUN-177).
   *
   * A runner's per-run token is BOUND to one agent server-side, and the server deliberately
   * issues no session id for one: the identity comes from the token and "no session id can move
   * it". So `null` is a real, successful outcome here, not a missing value — which is why this
   * map is probed with `has()` rather than `??`, or every call would re-handshake.
   */
  private readonly sessions = new Map<string, string | null>();

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
      if (NOT_ENABLED.test(reply.text) || toolMissing('release_lock', reply.text)) return { released: [] };
      throw new Error(`release_lock: ${reply.text.slice(0, 300)}`);
    }
    const body = reply.body as { released?: string[] };
    return { released: body?.released ?? [] };
  }

  /**
   * Release EVERY lock this token holds (RUN-104): list its own, then release those ids. The
   * prompt terminal cleanup — for a task-anchored run the server also auto-releases on task
   * settle, and TTL covers a crash, so this is promptness, not correctness. No-op when the
   * project has locking off or the run held nothing.
   */
  async releaseAllMine(token: string, projectId: string): Promise<{ released: string[] }> {
    const reply = await this.callTool(token, 'list_locks', { projectId, mine: true });
    if (reply.isError) {
      if (NOT_ENABLED.test(reply.text) || toolMissing('list_locks', reply.text)) return { released: [] };
      throw new Error(`list_locks: ${reply.text.slice(0, 300)}`);
    }
    const body = reply.body as { enabled?: boolean; locks?: Array<{ id: string }> };
    const ids = (body?.locks ?? []).map((l) => l.id).filter(Boolean);
    if (!ids.length) return { released: [] };
    return this.release(token, projectId, { lockIds: ids });
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
    const attempt = async (sid: string | null) => {
      const res = await this.fetchImpl(`${this.base}/mcp`, {
        method: 'POST',
        headers: { ...this.headers(token), ...(sid ? { 'mcp-session-id': sid } : {}) },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      return { res, raw: await res.text() };
    };
    let sid = this.sessions.has(token) ? (this.sessions.get(token) ?? null) : await this.initialize(token);
    let { res, raw } = await attempt(sid);
    // Only a SESSION can go stale. Under a bound token there is none, so a 400/404 is the server's
    // real answer about this call — re-handshaking would neither help nor change it, and would
    // replace the tool's own error with a handshake error if the second initialize failed.
    if (sid !== null && (res.status === 400 || res.status === 404)) {
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

  /**
   * Handshake. Cached per token, and `null` is a valid result.
   *
   * The server rejects sessionless tool calls as unattributable ONLY when it cannot otherwise tell
   * who is calling. A bound run-agent token already answers that, so the server returns a 200 with
   * no `mcp-session-id` header and resolves the agent from the token on every later call.
   * Requiring the header here is what failed the first two live dispatches (RUN-177): the floor
   * never got to ask, so a project with locking OFF — which would have answered `enabled:false`
   * and cost nothing — gated two finished builds instead.
   *
   * Only `!res.ok` is fatal. A missing session id is an answer, not a failure.
   */
  private async initialize(token: string): Promise<string | null> {
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
    if (!res.ok) {
      throw new Error(`lock mcp initialize → ${res.status}: ${raw.slice(0, 200)}`);
    }
    await this.fetchImpl(`${this.base}/mcp`, {
      method: 'POST',
      headers: { ...headers, ...(sid ? { 'mcp-session-id': sid } : {}) },
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
