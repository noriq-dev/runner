import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { IndexStatusRecord, IndexStatusStore } from './index-status';
import type { IndexTriggerStatus } from './index-triggers';
import { logger as defaultLogger } from './logger';

/**
 * The daemon↔CLI channel for RUN-223's live controls (manual index, cancel, retry) plus a live
 * read of `/status`. `runner-state.json` holds nothing reachable today (no socket, no IPC) — a
 * loopback HTTP server bound to 127.0.0.1 is the same shape `auth-loopback.ts` already uses for
 * the browser callback, and it is the only one of the discretion's options that gives a real
 * request/response: "did this actually reach a live daemon" has an honest answer (a connection
 * either succeeds or it does not) rather than a command file the daemon polls on its own cadence,
 * which would turn "manual reindex now" back into "manual reindex sometime soon".
 *
 * **The bearer token is the actual authentication boundary — this is NOT redundant with loopback,
 * and must not be removed as such.** A first pass here reasoned "127.0.0.1 is the trust boundary,
 * matching `auth-loopback.ts`" and left the server open to any well-formed local request. That
 * reasoning does not transfer, for two reasons specific to THIS server rather than that one:
 *   1. `auth-loopback.ts`'s server lives for seconds, during one interactive login, and a forged
 *      callback fails the PKCE `state` check. This server lives as long as the daemon and, without
 *      a token, would accept any request from any local process for its entire lifetime.
 *   2. This codebase's OWN first trust boundary (THREAT-MODEL.md) is "the user's machine is
 *      trusted; the agent is not" — a spawned build agent has a shell and (this repo's own
 *      manifest, `[permissions.build]`) `Bash(node:*)`, which is more than enough to enumerate
 *      loopback ports and POST `/reindex`/`/cancel` or read `/status`. That is exactly the process
 *      class the threat model excludes reaching a daemon control plane, and `sanitizedAgentEnv`
 *      strips credentials from that same shell for the identical reason. There is also a browser
 *      vector: a page the user visits can issue a cross-origin SIMPLE POST (no preflight) to a
 *      guessed local port; it cannot read the response, but the side effect still lands.
 * A random 32-byte token minted at `start()` and required on every request closes both: an agent's
 * shell has no more access to it than to any other `~/.noriq` file (mode 0600, exactly like
 * `credentials.json`), and requiring a CUSTOM header (`x-noriq-index-control`, never a body field
 * or a query param) means a cross-origin "simple" request literally cannot carry it — no CORS
 * preflight exists to bypass, because the browser will not attach a custom header to a simple
 * request in the first place. A missing or wrong token is a bare 401 with no body: the failure
 * must not become an oracle for probing which routes or repositories exist.
 *
 * **The port is ephemeral and discovered through a small info file**, `~/.noriq/index-control.json`
 * (`{pid, port, startedAt, token}`), the same `~/.noriq` discipline as every other store in this
 * codebase: mode 0600, temp-and-rename, and — on the CLI's read side — a missing or corrupt file
 * reads exactly like "no daemon", never a thrown error. A stale file naming a port nothing listens
 * on anymore (a daemon that crashed without cleaning up) reads the same way: the connection simply
 * fails, and the CLI reports "no daemon" rather than surfacing a raw ECONNREFUSED. The token rides
 * this SAME file — no second discovery mechanism, and no new failure mode: a corrupt or missing
 * file is still just "no daemon", now for either reason at once.
 *
 * **`/status`'s payload carries no withheld content and no credential-shaped detail** — asserted,
 * not merely assumed. It surfaces exactly `IndexStatusRecord`/`IndexTriggerStatus`: state labels,
 * timestamps, base ids, generation ids, batch counts, and free-text `detail`/`lastError` strings.
 * Those strings originate from three places, and none of them can carry indexed source text or a
 * credential: `reconcileDetail` (index-status.ts) is built entirely from base ids and version
 * strings this daemon itself computed; `IndexReconcileOutcome.reason` (`unavailable`,
 * `association-conflict`) is static/server-described prose about cursor state, never file content;
 * and an upload failure's detail traces back to `ingest-client.ts`'s `IngestError.message`, which
 * is documented and enforced TOKEN-FREE by construction (`redactToken` strips the capability token
 * from every message that could otherwise embed it via the request URL). Nothing in this whole
 * pipeline ever reads a scanned file's bytes back out — the indexer's own output is batched and
 * shipped to the server, never round-tripped through this daemon's local status store.
 */

export interface IndexControlInfo {
  pid: number;
  port: number;
  startedAt: string;
  /** RUN-223's authentication boundary — see the module doc's "the bearer token is the actual
   *  authentication boundary" section. Required on every request via the `x-noriq-index-control`
   *  header; never accepted as a body field or query param, which would ride along on a request a
   *  browser could still forge. */
  token: string;
}

export const DEFAULT_CONTROL_INFO_PATH = path.join(os.homedir(), '.noriq', 'index-control.json');

/**
 * Where a CLI-side caller looks for the discovery file when it was given no explicit path. Read at
 * CALL time, never captured at module load, so an override actually takes effect for a caller that
 * cannot pass `infoPath` through — which is every `cli.ts` command, by design: an operator types
 * `index-status`, not a file path.
 *
 * `NORIQ_INDEX_CONTROL_PATH` exists because without it this family of commands is not TESTABLE and
 * not isolable. The CLI tests run in-process and reached the operator's REAL `~/.noriq`, so two of
 * them ("no live daemon" cases) passed or failed depending on whether a daemon happened to be
 * running on the machine — they failed the moment this repo's own daemon was started for the first
 * live index, which is how this was found rather than by inspection. Same defect the RUN-222
 * journal/staging paths already had to fix, one file over; same fix, at the one boundary a CLI
 * command can actually be pointed somewhere else. Also genuinely useful outside tests: a second
 * daemon, or a non-default home.
 */
export function resolveControlInfoPath(explicit?: string): string {
  return explicit ?? process.env.NORIQ_INDEX_CONTROL_PATH ?? DEFAULT_CONTROL_INFO_PATH;
}

/** The header every request must carry the token in — never a body field or query param (both are
 *  things a cross-origin "simple" request, or a shell command with the URL in its own history/logs,
 *  can carry; a custom header is the one thing a browser will not attach without a CORS preflight
 *  this server never opts into). */
export const CONTROL_TOKEN_HEADER = 'x-noriq-index-control';

// ---------------------------------------------------------------------------
// Daemon side: the server.
// ---------------------------------------------------------------------------

export interface IndexControlDeps {
  statusStore: Pick<IndexStatusStore, 'snapshot'>;
  /** `IndexTriggerHub.allStatuses` — the trigger-timing half of the picture (`lastRequestedAt`,
   *  `nextPollAt`, …) `IndexStatusStore` does not itself carry, merged into `/status` alongside it. */
  triggerStatuses: () => IndexTriggerStatus[];
  /** Resolve a `repositoryKey` to the local checkout root a control needs to act on — the same
   *  identity `IndexTriggerHub`/`IndexCoordinator` already key off; unknown keys 404. */
  repoRootFor: (repositoryKey: string) => string | undefined;
  /** RUN-222's own hook (`IndexTriggerHub.requestManualReindex`), reused verbatim for BOTH
   *  `/reindex` and `/retry` (locked decision 7: retry is a trigger, not a new upload path — the
   *  same function proves it, since there is only one function to call). */
  requestManualReindex: (repoRoot: string) => Promise<void>;
  /** `IndexCoordinator.cancelRepo` — optional so a test double may omit it; production always
   *  supplies it. Undefined reads as "not supported" to a caller, never a silent no-op that looks
   *  like success. */
  cancelRepo?: (repositoryKey: string) => boolean;
  controlInfoPath?: string;
  logger?: typeof defaultLogger;
}

export interface StatusResponseBody {
  records: IndexStatusRecord[];
  triggers: IndexTriggerStatus[];
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(text);
}

export class IndexControlServer {
  private server?: Server;
  private readonly infoPath: string;
  private readonly log: typeof defaultLogger;
  /** Minted fresh in `start()` — never persisted anywhere but the discovery file, never logged,
   *  never echoed back in any response. */
  private token = '';

  constructor(private readonly deps: IndexControlDeps) {
    this.infoPath = deps.controlInfoPath ?? DEFAULT_CONTROL_INFO_PATH;
    this.log = deps.logger ?? defaultLogger;
  }

  /** Bind an ephemeral loopback port, mint this run's bearer token, and write the discovery file.
   *  Idempotent guard is the caller's job (`daemon.ts` calls this exactly once); calling twice
   *  would bind twice and mint a second token the first caller never learns. */
  async start(): Promise<{ port: number }> {
    this.token = randomBytes(32).toString('hex');
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        this.log.warn('index control request failed', { err: String(err) });
        if (!res.headersSent) sendJson(res, 500, { ok: false, reason: 'internal-error' });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    this.server = server;
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await mkdir(path.dirname(this.infoPath), { recursive: true, mode: 0o700 });
    const info: IndexControlInfo = {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString(),
      token: this.token,
    };
    const tmp = `${this.infoPath}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.infoPath);
    return { port };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.token = '';
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    // Best-effort: a removal failure costs a stale file the next CLI call reads as "no daemon"
    // (the connection to its named port fails) rather than anything worse.
    await rm(this.infoPath, { force: true }).catch(() => {});
  }

  /** Constant-time compare against a header a caller supplied — `timingSafeEqual` throws on a
   *  length mismatch rather than returning false, so that is checked first (leaking the LENGTH of
   *  a 32-byte-hex token is not the thing this check exists to hide; a byte-by-byte timing leak of
   *  its VALUE is). */
  private authorized(req: IncomingMessage): boolean {
    const supplied = req.headers[CONTROL_TOKEN_HEADER];
    if (typeof supplied !== 'string' || !supplied) return false;
    const expected = Buffer.from(this.token, 'utf8');
    const got = Buffer.from(supplied, 'utf8');
    if (expected.length !== got.length) return false;
    return timingSafeEqual(expected, got);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Checked BEFORE any routing, for every method and every path — including a route that does
    // not exist, so a 404 vs. a 401 never tells an unauthenticated caller which routes are real.
    if (!this.authorized(req)) {
      res.writeHead(401).end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/status') {
      const body: StatusResponseBody = {
        records: this.deps.statusStore.snapshot(),
        triggers: this.deps.triggerStatuses(),
      };
      sendJson(res, 200, body);
      return;
    }

    if (method === 'POST' && (url.pathname === '/reindex' || url.pathname === '/retry')) {
      const parsed = await readJsonBody(req);
      const repositoryKey = (parsed as { repositoryKey?: unknown }).repositoryKey;
      if (typeof repositoryKey !== 'string' || !repositoryKey) {
        sendJson(res, 400, { ok: false, reason: 'repositoryKey is required' });
        return;
      }
      const repoRoot = this.deps.repoRootFor(repositoryKey);
      if (!repoRoot) {
        sendJson(res, 404, { ok: false, reason: 'unknown-repository' });
        return;
      }
      // The exact same call for /reindex and /retry (locked decision 7) — `requestManualReindex`
      // bypasses the debounce window and hands the request straight to `IndexCoordinator.trigger`,
      // which coalesces with whatever is already active and re-reconciles from scratch, so a
      // second call while a job is running or just finished converges rather than duplicating.
      await this.deps.requestManualReindex(repoRoot);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'POST' && url.pathname === '/cancel') {
      const parsed = await readJsonBody(req);
      const repositoryKey = (parsed as { repositoryKey?: unknown }).repositoryKey;
      if (typeof repositoryKey !== 'string' || !repositoryKey) {
        sendJson(res, 400, { ok: false, reason: 'repositoryKey is required' });
        return;
      }
      if (!this.deps.cancelRepo) {
        sendJson(res, 501, { ok: false, reason: 'not-supported' });
        return;
      }
      const cancelled = this.deps.cancelRepo(repositoryKey);
      sendJson(res, 200, { ok: cancelled });
      return;
    }

    sendJson(res, 404, { ok: false, reason: 'no such route' });
  }
}

// ---------------------------------------------------------------------------
// CLI side: the client. Every function here returns a typed result rather than throwing — a
// missing or stale control-info file, a refused connection, and an ordinary HTTP error all read
// as "no daemon" or a named reason, never a stack trace (the acceptance line: "a daemon-requiring
// control with no daemon running says so plainly").
// ---------------------------------------------------------------------------

export async function readControlInfo(infoPath?: string): Promise<IndexControlInfo | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(resolveControlInfoPath(infoPath), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { pid, port, startedAt, token } = parsed as Partial<IndexControlInfo>;
    if (
      typeof pid !== 'number' ||
      typeof port !== 'number' ||
      typeof startedAt !== 'string' ||
      typeof token !== 'string' ||
      !token
    ) {
      return null; // no token to authenticate with reads exactly like no daemon — see module doc
    }
    return { pid, port, startedAt, token };
  } catch {
    return null;
  }
}

export type ControlResult<T> = { ok: true; data: T } | { ok: false; reason: string };

export interface ControlCallOptions {
  infoPath?: string;
  fetchImpl?: typeof fetch;
}

async function callControl<T>(
  method: string,
  pathname: string,
  body: unknown,
  opts: ControlCallOptions = {},
): Promise<ControlResult<T>> {
  const info = await readControlInfo(opts.infoPath);
  if (!info) return { ok: false, reason: 'no-daemon' };
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`http://127.0.0.1:${info.port}${pathname}`, {
      method,
      headers: {
        [CONTROL_TOKEN_HEADER]: info.token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // 401 means the info file's token no longer matches the live daemon (stale across a restart
    // that raced this read) — reads as "no daemon" rather than a bare unexplained failure, since
    // from here the two are indistinguishable in every way that matters: there is nobody THIS
    // token can reach.
    if (res.status === 401) return { ok: false, reason: 'no-daemon' };
    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const reason = (parsed as { reason?: string } | null)?.reason;
      return { ok: false, reason: reason ?? `daemon returned ${res.status}` };
    }
    return { ok: true, data: parsed as T };
  } catch {
    // A control-info file naming a port nothing answers on anymore (a daemon that crashed without
    // cleaning up its own file) is indistinguishable, from here, from no daemon at all — both mean
    // there is nobody to ask, which is exactly what this reason says.
    return { ok: false, reason: 'no-daemon' };
  }
}

export function requestIndexStatus(opts?: ControlCallOptions): Promise<ControlResult<StatusResponseBody>> {
  return callControl('GET', '/status', undefined, opts);
}

export function requestIndexReindex(
  repositoryKey: string,
  opts?: ControlCallOptions,
): Promise<ControlResult<{ ok: true }>> {
  return callControl('POST', '/reindex', { repositoryKey }, opts);
}

export function requestIndexRetry(
  repositoryKey: string,
  opts?: ControlCallOptions,
): Promise<ControlResult<{ ok: true }>> {
  return callControl('POST', '/retry', { repositoryKey }, opts);
}

export function requestIndexCancel(
  repositoryKey: string,
  opts?: ControlCallOptions,
): Promise<ControlResult<{ ok: boolean }>> {
  return callControl('POST', '/cancel', { repositoryKey }, opts);
}
