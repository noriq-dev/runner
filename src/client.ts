import { ExecutionSpec, hasExecutionSpec } from '@noriq-dev/shared';
import { logger as defaultLogger } from './logger';
import { ContextPack, type ContextPackRole, RunnerIndexCursor } from './memory-contract';
import type { RunnerRegistration } from './registration';
import type { VerificationReportResult, VerificationReportWire } from './verification-report';
import { VERSION } from './version';

/** Where a spun-off task came from (RUN-188): the run and finding that spawned it. Runner-local,
 *  like TaskBrief itself — the server owns the wire shape (the planar side lands first), and this
 *  is only what the daemon's task-pointer check reads out of it, leniently. */
export interface SpinOffProvenance {
  sourceTaskId: string | null;
  sourceRunId: string | null;
  /** The finding text the task was filed against, when the server recorded one. */
  finding: string | null;
}

/** The slice of a task the daemon inlines into an agent's prompt. */
export interface TaskBrief {
  key: string;
  title: string;
  body: string | null;
  /**
   * What this task was commissioned with (RUN-134…139). Null = nobody wrote one, which is every
   * task before the contract grew this and plenty after.
   */
  executionSpec: ExecutionSpec | null;
  /**
   * The server holds a spec it could not parse (RUN-135). NOT the same as having none: absence
   * reads as "nobody planned this", and something that plans would then write over it. Carried so
   * the daemon can say so rather than brief an agent as if the task were unplanned.
   */
  executionSpecUnreadable: boolean;
  /**
   * Spin-off provenance (RUN-188), when the server records this task as spun off from a run.
   * Absent on every task that was not — and on any server that predates the field.
   */
  spinOff?: SpinOffProvenance;
}

/** Parse a wire spec at the boundary. Absent → no spec; present but unparseable → flagged, never
 *  silently absent (RUN-135's distinction, enforced on this side of the wire too). */
function readSpec(
  raw: unknown,
  serverSaidUnreadable: boolean,
): Pick<TaskBrief, 'executionSpec' | 'executionSpecUnreadable'> {
  if (serverSaidUnreadable) return { executionSpec: null, executionSpecUnreadable: true };
  if (raw == null) return { executionSpec: null, executionSpecUnreadable: false };
  const parsed = ExecutionSpec.safeParse(raw);
  return parsed.success
    ? { executionSpec: parsed.data, executionSpecUnreadable: false }
    : { executionSpec: null, executionSpecUnreadable: true };
}

/** Provenance at the boundary (RUN-188): absent or malformed reads as NONE — the task itself
 *  still resolves, because existence is the mechanical fact the daemon's check rests on and
 *  provenance only sharpens it. Field-lenient on purpose: this arrives from a server on its own
 *  release cadence, and a field this daemon does not recognise must not fail the lookup. */
function readSpinOff(raw: unknown): { spinOff?: SpinOffProvenance } {
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim().length > 0 ? v : null);
  return {
    spinOff: {
      sourceTaskId: str(r.sourceTaskId),
      sourceRunId: str(r.sourceRunId),
      finding: str(r.finding),
    },
  };
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
  // A TOOL-level failure is an HTTP 200 with `isError: true` and the message in the text block —
  // only a PROTOCOL failure lands in `envelope.error`. Reading the text and ignoring the flag made
  // every refusal (maintenance mode, an authorization refusal, a validation error) look like a
  // successful call that returned a string, so a write that never happened reported as done.
  const text = envelope.result?.content?.find((c) => c.type === 'text')?.text;
  if (envelope.result?.isError) throw new Error(text ?? 'mcp tool error');
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
  /**
   * Injectable for tests; defaults to the shared daemon logger. RUN-234: `getIndexCursor` and
   * `getContextPack` collapse EVERY failure mode to `null` by locked, unweakened contract
   * (`INDEX-OPERATIONS.md`'s own Troubleshooting section names why: a caller two layers away
   * must not have to keep three failure modes of a server that can fail in new ways in sync).
   * That contract is about what a CALLER receives, not about what an operator can ever know —
   * before this, nothing on this path logged even the HTTP status, so "server memory disabled"
   * and "a network blip" were genuinely indistinguishable from the daemon's own log. `logFetchFailure`
   * below logs the distinction at the one place it is still knowable, and returns nothing —
   * every call site still returns `null` exactly as before.
   */
  logger?: typeof defaultLogger;
}

/**
 * A non-2xx response from `request()`, carrying the real status/body rather than only a
 * formatted message. Added for RUN-220: `mintIngestCapability`'s caller (`ingest-client.ts`)
 * must tell a 503 (ingest not enabled — permanent, per this repo's own locked decision) apart
 * from a 404 (unresolvable repository key) apart from a 403 (runner outside this connection's
 * authorized projects) — a bare `Error` string would force it to regex the message. `.message`
 * keeps the exact pre-existing format (`${method} ${pathname} → ${status}: ${body}`), so this is
 * additive: every caller that only ever read `.message` is unaffected.
 */
export class NoriqHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'NoriqHttpError';
  }
}

/** A capability minted by `POST /api/runner-ingest/capability` (RUN-220, PLNR-260 §8) — the
 *  bearer for exactly the five `/api/memory-ingest/:token/*` calls `ingest-client.ts` makes for
 *  ONE (purpose, scopeId). `maxBytes` is the server's clamp, not this repo's guess at one (locked
 *  decision 4) — the caller must refuse an oversized batch locally against THIS number. */
export interface IngestCapabilityGrant {
  token: string;
  maxBytes: number;
  expiresAt: string;
}

/** The mint request body — one (purpose, scopeId) per capability (locked decision 7: never mint
 *  broad and reuse across generations). `scopeId` is an `IndexGenerationManifest.generationId`
 *  for `purpose: 'index'`, or a caller-chosen episode upload id for `purpose: 'episode'`. */
export interface MintIngestCapabilityInput {
  projectId: string;
  repositoryKey: string;
  purpose: 'index' | 'episode';
  scopeId: string;
  runnerId: string;
  /** Optional per-batch ceiling request — the server clamps it to its own `MAX_INGEST_BATCH_BYTES`
   *  regardless, so this only ever narrows, never widens, what the mint response allows. */
  maxBytes?: number;
}

/** Thin REST client for the Noriq control plane. The daemon authenticates with the
 *  user's OAuth token (the only secret that crosses the wire). */
export class NoriqClient {
  private readonly base: string;
  private readonly getToken: () => Promise<string>;
  private readonly onUnauthorized?: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly log: typeof defaultLogger;

  constructor(opts: NoriqClientOptions) {
    this.base = opts.server.replace(/\/+$/, '');
    const token = opts.token;
    this.getToken = typeof token === 'string' ? async () => token : token;
    this.onUnauthorized = opts.onUnauthorized;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.logger ?? defaultLogger;
  }

  /**
   * RUN-234: log WHY a null-collapsing fetch produced nothing, without changing what any caller
   * receives — both call sites below still return `null` on every branch. `fields` never carries
   * a path, a response body, or a token (locked decision 3): a non-2xx logs the STATUS CODE alone
   * (a bounded, single small integer, never `NoriqHttpError.body`, which can legitimately hold
   * server-echoed request content); a transport failure logs the error's own length-capped
   * message — defense in depth mirroring `ingest-client.ts`'s `redactToken`, since a `fetchImpl`'s
   * own thrown message can legitimately quote the URL it tried to reach (never a token: this
   * class sends its bearer in a header, never a path segment, unlike the ingest capability rail).
   */
  private logFetchFailure(what: string, fields: Record<string, unknown>, err: unknown): void {
    if (err instanceof NoriqHttpError) {
      this.log.warn(`${what} failed`, { ...fields, category: 'http', status: err.status });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    this.log.warn(`${what} failed`, { ...fields, category: 'transport', err: message.slice(0, 200) });
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
    if (!res.ok)
      throw new NoriqHttpError(
        `${method} ${pathname} → ${res.status}: ${text.slice(0, 500)}`,
        res.status,
        text,
      );
    return text ? JSON.parse(text) : {};
  }

  /** This client's server base URL, trailing slash trimmed — exposed for RUN-220's ingest client,
   *  which builds its own request URLs directly: the five `/api/memory-ingest/:token/*` calls are
   *  authorized by the TOKEN IN THE PATH, never by this client's Bearer header, so they cannot go
   *  through `request()` above. */
  get baseUrl(): string {
    return this.base;
  }

  /** This client's injected fetch — exposed for the same reason as `baseUrl`: RUN-220's ingest
   *  client is a separate, unauthenticated-by-header transport and needs its own fetch to fake in
   *  tests without re-plumbing a second `fetchImpl` through every call site that already has one
   *  of these. */
  get httpFetch(): typeof fetch {
    return this.fetchImpl;
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
   * Tell the server a run's open blocked question died with the run (RUN-199).
   *
   * When a run holding an open `request_input` terminates WITHOUT parking — a budget breach, a
   * crash, or (the anomaly) a resumable driver that produced no session — the row is left `blocked`
   * on a question nobody will ever answer into anything. This resolves the signal as abandoned so
   * the dashboard is not left showing a dead run waiting for input. Fire-and-forget from the
   * supervisor, which swallows a failure: an older server without this endpoint just leaves the
   * signal standing, the pre-RUN-199 behaviour a human clears by hand.
   */
  async abandonBlockedSignal(runId: string, signalId: string): Promise<void> {
    await this.request('POST', `/api/runs/${runId}/park/abandon`, { signalId });
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

  /**
   * The daemon's live MCP session id (RUN-73), and whether the handshake has happened at all.
   *
   * Two fields because they answer different questions (RUN-177): a BOUND token is issued no
   * session id, so `null` is a legitimate post-handshake state and cannot also mean "not yet
   * initialized" — collapsing them re-handshakes on every call. The daemon's own token is
   * unbound today and always gets an id; this holds the invariant for whoever passes a bound one.
   */
  private mcpSessionId: string | null = null;
  private mcpInitialized = false;

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
  private async mcpInitialize(): Promise<string | null> {
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
    // A missing session id is an ANSWER — the token is bound and needs none — so only a non-2xx
    // is fatal (RUN-177).
    if (!res.ok) {
      throw new Error(`mcp initialize → ${res.status}: ${raw.slice(0, 200)}`);
    }
    // The spec's follow-up; some transports won't serve requests until it arrives.
    await this.fetchImpl(`${this.base}/mcp`, {
      method: 'POST',
      headers: { ...headers, ...(sid ? { 'mcp-session-id': sid } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }).catch(() => {
      /* best-effort — the tool call below is the real probe */
    });
    this.mcpSessionId = sid;
    this.mcpInitialized = true;
    return sid;
  }

  /** Call an MCP tool as the daemon's actor, returning the tool's text payload parsed
   *  as JSON (Noriq tools answer with a single JSON text block). Initializes a session
   *  lazily and re-initializes ONCE on a session the server no longer knows — worker
   *  isolates recycle sessions at will, so the retry is load-bearing, not polish. */
  private async mcpCall(name: string, args: Record<string, unknown>): Promise<unknown> {
    const attempt = async (sid: string | null): Promise<{ res: Response; raw: string }> => {
      const res = await this.fetchImpl(`${this.base}/mcp`, {
        method: 'POST',
        headers: { ...(await this.mcpHeaders()), ...(sid ? { 'mcp-session-id': sid } : {}) },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      return { res, raw: await res.text() };
    };
    const sid = this.mcpInitialized ? this.mcpSessionId : await this.mcpInitialize();
    let { res, raw } = await attempt(sid);
    // Only a SESSION can go stale, so a bound token (no session id) skips the retry — a 400/404
    // there is the server's real answer, not a recycled isolate.
    if (sid !== null && (res.status === 400 || res.status === 404)) {
      // The session died with its isolate (or expired). One fresh handshake, one retry.
      this.mcpSessionId = null;
      this.mcpInitialized = false;
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
    const out = (await this.mcpCall('get_task', { taskId })) as {
      task?: Partial<TaskBrief> & {
        executionSpec?: unknown;
        executionSpecUnreadable?: unknown;
        spinOff?: unknown;
      };
    } | null;
    const t = out?.task;
    // TYPE-checked, not truthiness-checked (RUN-188): the cast above is a claim about the wire,
    // not a fact, and a truthy non-string key/title (`title: 42`) crossing this boundary throws
    // in whatever string-shaped code touches it next — on the adjudication path, that aborted a
    // fold a finding was meant to merely stand on. A malformed task is the same answer as none.
    if (typeof t?.key !== 'string' || !t.key || typeof t.title !== 'string' || !t.title) return null;
    return {
      key: t.key,
      title: t.title,
      body: typeof t.body === 'string' ? t.body : null,
      // Parsed through the contract rather than trusted: this arrives from a server the daemon
      // does not control, and the whole point of a vendored schema is that the wire is checked at
      // the boundary. A spec that does not parse is dropped to null and FLAGGED — a server on a
      // newer contract than this daemon is exactly the case where silently reporting "no spec"
      // would let a planner overwrite a real one.
      ...readSpec(t.executionSpec, t.executionSpecUnreadable === true),
      // Spin-off provenance (RUN-188) — the field the daemon's task-pointer check reads. Lenient
      // where the spec read above is strict, because the stakes invert: a spec that misparses
      // could be overwritten, while provenance only ever SHARPENS an existence check.
      ...readSpinOff(t.spinOff),
    };
  }

  /**
   * Write a synthesized execution spec back onto the task (RUN-140).
   *
   * The point of planning in a separate context is that the plan becomes an ARTIFACT — visible in
   * the dashboard, correctable by a human before the build acts on it, and reused by a retry
   * instead of re-derived. A spec that only ever existed inside one run's prompt would have cost
   * the tokens and bought none of that.
   *
   * Re-reads the task first and REFUSES to overwrite a spec that is there now. The decision to
   * plan was made before a model call that takes minutes, and a human editing the task in that
   * window is not a race worth losing — the dashboard exists so they can (RUN-137). Not atomic,
   * and it is not pretending to be: it closes the minutes-wide window, not the milliseconds-wide
   * one, and the server-side compare-and-set that would close both is a contract change.
   */
  async setExecutionSpec(projectId: string, taskId: string, spec: ExecutionSpec): Promise<boolean> {
    const current = await this.getTask(taskId).catch(() => null);
    if (current && (hasExecutionSpec(current.executionSpec) || current.executionSpecUnreadable)) return false;
    await this.mcpCall('update_task', { projectId, taskId, executionSpec: spec });
    return true;
  }

  /**
   * Read-only phase/plan-gate probe (RUN-81): is this task claimable RIGHT NOW, respecting the
   * plan's phase gates? The daemon consults it BEFORE spawning an agent for a task-anchored run —
   * a backstop for a server-side dispatch/claim bug (a phase-2 task offered while phase 1 is only
   * in review). The gate lives in phase_tasks server-side, so the daemon cannot compute it locally
   * and must ask. This must NOT carry the anchored-agent claim bypass — the whole point is to see
   * the gate the running agent's own claim would skip.
   *
   * Contract with the server: MCP tool `can_claim({ taskId }) → { claimable: boolean, reason? }`.
   *
   * Returns null when the probe is UNAVAILABLE — an older server without the tool, a malformed
   * answer, or any error. The gate then fails OPEN: the daemon behaves exactly as it did before
   * this existed, so a transient hiccup never strands a legitimately-dispatched run. Only a
   * definite `{ claimable: false }` stops a spawn.
   */
  async checkClaimable(taskId: string): Promise<{ claimable: boolean; reason: string | null } | null> {
    try {
      const out = (await this.mcpCall('can_claim', { taskId })) as {
        claimable?: unknown;
        reason?: unknown;
      } | null;
      if (out == null || typeof out.claimable !== 'boolean') return null;
      return { claimable: out.claimable, reason: typeof out.reason === 'string' ? out.reason : null };
    } catch {
      return null; // probe unavailable or errored → fail open, never strand a run
    }
  }

  /**
   * Fetch RUN-213's index cursor — the active generation's baseId/branch/indexerVersion, staged
   * generations, staleness, and this checkout's own repository association, in one round trip
   * (`POST /api/runner-memory/index-cursor`, PLNR-306's agentAuth read). Deliberately OUTSIDE
   * `/api/projects/:pid/*`: that subtree runs `userAuth` before any route-level auth, so a
   * Bearer-only daemon can never reach it (VENDORED-CONTRACT.md, this task's locked decision 2).
   *
   * `input.projectId` is `null` when this daemon has not resolved which Noriq project the repo's
   * key belongs to on this server yet (`RegisteredRunnerRepo.projectId`, set from registration) —
   * the route requires one, so that precondition is refused BEFORE any request is attempted. This
   * reads as `unavailable` to `index-reconcile.ts`'s `reconcile`, never as `association-conflict`:
   * that verdict requires the server to have actually compared this checkout against a *resolved*
   * canonical repository, which requires a projectId to ask it with in the first place.
   *
   * Returns `null` on every OTHER failure mode too — network error, non-2xx, or a body that does
   * not parse as the vendored `RunnerIndexCursor` (locked decision 3: this is the ONLY parser run
   * over the response, never a hand-rolled read off `unknown` — the server computes `stale` with
   * the exact function the human-facing dashboard route uses, so a second, independently-typed
   * reading of the same wire shape is exactly how the two would drift). `reconcile` treats every
   * `null` identically: schedule nothing, and let the next trigger retry (decision 6) — a fetch
   * hiccup must cost a retry, never a full reindex of a monorepo.
   */
  async getIndexCursor(
    runnerId: string,
    input: { projectId: string | null; repositoryKey: string; checkoutId: string },
  ): Promise<RunnerIndexCursor | null> {
    if (!input.projectId) {
      // A precondition this daemon can already see, not a fetch outcome — worth `debug` (routine
      // on a fresh registration), never `warn`, and distinct from every category below.
      this.log.debug('index cursor fetch skipped — no resolved project for this repository yet', {
        repositoryKey: input.repositoryKey,
      });
      return null;
    }
    try {
      const out = await this.request('POST', '/api/runner-memory/index-cursor', {
        projectId: input.projectId,
        repositoryKey: input.repositoryKey,
        runnerId,
        checkoutId: input.checkoutId,
      });
      const parsed = RunnerIndexCursor.safeParse(out);
      if (!parsed.success) {
        this.log.warn('index cursor fetch failed', {
          repositoryKey: input.repositoryKey,
          category: 'schema',
        });
        return null;
      }
      return parsed.data;
    } catch (err) {
      this.logFetchFailure('index cursor fetch', { repositoryKey: input.repositoryKey }, err);
      return null;
    }
  }

  /**
   * Fetch RUN-228's task context pack (`POST /api/runner-memory/context`, agentAuth) — the
   * agentAuth twin of the dashboard's userAuth `POST /api/projects/:pid/memory/context`: same
   * assembler, same shape, `role` defaulting server-side to 'build' rather than the browser
   * route's 'human' (a runner is never a browser, and 'human' would reweight section budgets
   * toward the wrong reader — this daemon's own caller always passes one explicitly anyway).
   *
   * Same locked-decision shape as `getIndexCursor` above, deliberately: ONE parser (the vendored
   * `ContextPack` schema, re-exported as a value by `memory-contract.ts` for exactly this), and
   * every failure — network error, non-2xx (including a 404 from an old server that has not
   * grown this route), or a body that fails the schema — collapses to `null` rather than three
   * call sites the daemon's caller (`context-pack.ts`) would otherwise have to keep in sync with
   * a server that can fail in new ways this repo has never seen. `context-pack.ts` is the layer
   * that adds a TIMEOUT around this call and decides what an omission means for a run; this
   * method stays an honest wire call.
   *
   * `repositoryKey`/`branch`/`baseId`/`role`/`budgetTokens` are all optional on the wire — this
   * method does not itself refuse a request missing one; `context-pack.ts` is what enforces "skip
   * without a repositoryKey" (locked decision) before this is ever called.
   */
  async getContextPack(
    runnerId: string,
    input: {
      projectId: string;
      taskId: string;
      repositoryKey?: string | null;
      branch?: string | null;
      baseId?: string | null;
      role?: ContextPackRole;
      budgetTokens?: number;
    },
  ): Promise<ContextPack | null> {
    try {
      const out = await this.request('POST', '/api/runner-memory/context', {
        projectId: input.projectId,
        runnerId,
        taskId: input.taskId,
        ...(input.repositoryKey ? { repositoryKey: input.repositoryKey } : {}),
        ...(input.branch ? { branch: input.branch } : {}),
        ...(input.baseId ? { baseId: input.baseId } : {}),
        ...(input.role ? { role: input.role } : {}),
        ...(input.budgetTokens !== undefined ? { budgetTokens: input.budgetTokens } : {}),
      });
      const parsed = ContextPack.safeParse(out);
      if (!parsed.success) {
        this.log.warn('context pack fetch failed', { taskId: input.taskId, category: 'schema' });
        return null;
      }
      return parsed.data;
    } catch (err) {
      this.logFetchFailure('context pack fetch', { taskId: input.taskId }, err);
      return null;
    }
  }

  /**
   * Mint a short-lived, single-purpose ingest capability (RUN-220, PLNR-260 §8) — under the
   * DAEMON's own OAuth identity, via this same authenticated client (locked decision 7), scoped
   * to exactly the one (purpose, scopeId) `input` names. This is the ONLY thing this client does
   * with the capability: it hands back the grant and never touches the five token-authorized
   * routes itself — those live in `ingest-client.ts`, which authorizes with the token alone (no
   * Bearer, no cookie), a different trust shape from every other call on this class.
   *
   * Throws `NoriqHttpError` on any non-2xx — notably 503 when this server has no
   * `ATTACHMENT_UPLOAD_SECRET`/`ADMIN_TOKEN` configured (ingest not enabled at all: a runner
   * ahead of its server must treat this as permanent, never retry it into a hot loop), 404 for a
   * repository key this project has not registered, and 403 when the runner is outside this
   * connection's authorized projects. `ingest-client.ts` classifies `.status` into the
   * caller-facing `IngestError` taxonomy; this method stays a thin, honest wire call.
   */
  async mintIngestCapability(input: MintIngestCapabilityInput): Promise<IngestCapabilityGrant> {
    return (await this.request('POST', '/api/runner-ingest/capability', input)) as IngestCapabilityGrant;
  }

  /**
   * Send RUN-230's verification report — `POST /api/runs/:runId/verification-report`, the
   * ordinary agentAuth run surface (planar's own locked decision: capability tokens are for BULK
   * payloads, this is small and belongs where every other run-scoped agent action already lives).
   *
   * Deliberately bypasses `request()`'s Authorization header: that always sends THIS client's own
   * token (the daemon's), but the server's gate here is `conn.boundAgent.id === run.agentId` —
   * only a token minted for the run's own agent identity (`RunAgent.token`, from
   * `createRunAgent`) can satisfy it. `agentToken` is the caller's, never this client's `getToken`.
   */
  async reportVerification(
    runId: string,
    agentToken: string,
    report: VerificationReportWire,
  ): Promise<VerificationReportResult> {
    const pathname = `/api/runs/${runId}/verification-report`;
    const res = await this.fetchImpl(`${this.base}${pathname}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    });
    const text = await res.text();
    if (!res.ok)
      throw new NoriqHttpError(`POST ${pathname} → ${res.status}: ${text.slice(0, 500)}`, res.status, text);
    return text
      ? (JSON.parse(text) as VerificationReportResult)
      : { applied: 0, skipped: 0, touchedMemoryIds: [] };
  }
}
