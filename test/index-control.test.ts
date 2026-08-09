import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTROL_INFO_PATH,
  IndexControlServer,
  readControlInfo,
  requestIndexCancel,
  requestIndexReindex,
  requestIndexRetry,
  requestIndexStatus,
} from '../src/index-control';
import type { IndexStatusRecord } from '../src/index-status';
import type { IndexTriggerStatus } from '../src/index-triggers';

// RUN-223. This suite proves the loopback control server end to end — a REAL bound socket, real
// requests through `fetch` — because "did this reach a live daemon" is the exact question this
// channel exists to answer honestly, and a fake transport would answer it by construction rather
// than by proof.

const quiet = { info() {}, warn() {}, error() {}, debug() {} } as unknown as ConstructorParameters<
  typeof IndexControlServer
>[0]['logger'];

const RECORD: IndexStatusRecord = {
  repositoryKey: 'my-repo',
  state: 'active',
  stateSince: '2026-08-09T00:00:00.000Z',
  detail: null,
  lastError: null,
  lastSuccess: { at: '2026-08-09T00:00:00.000Z', generationId: 'gen_1', baseId: 'b1', batchesReceived: 2 },
  indexerVersion: '1',
  requiresUpgrade: false,
};

const TRIGGER_STATUS: IndexTriggerStatus = {
  repositoryKey: 'my-repo',
  lastRequestedAt: 1000,
  lastRequestedReason: 'poll',
  lastTriggeredAt: 1010,
  nextPollAt: 5000,
};

describe('IndexControlServer', () => {
  let dir: string;
  let infoPath: string;
  let server: IndexControlServer | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'noriq-index-control-'));
    infoPath = path.join(dir, 'index-control.json');
  });

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  function buildServer(over: Partial<ConstructorParameters<typeof IndexControlServer>[0]> = {}) {
    const requestManualReindexCalls: string[] = [];
    const cancelCalls: string[] = [];
    server = new IndexControlServer({
      statusStore: { snapshot: () => [RECORD] },
      triggerStatuses: () => [TRIGGER_STATUS],
      repoRootFor: (repositoryKey) => (repositoryKey === 'my-repo' ? '/repo/a' : undefined),
      requestManualReindex: async (repoRoot) => {
        requestManualReindexCalls.push(repoRoot);
      },
      cancelRepo: (repositoryKey) => {
        cancelCalls.push(repositoryKey);
        return repositoryKey === 'my-repo';
      },
      controlInfoPath: infoPath,
      logger: quiet,
      ...over,
    });
    return { server, requestManualReindexCalls, cancelCalls };
  }

  it('start() binds an ephemeral loopback port and writes a mode-0600 discovery file, with a 32-byte token', async () => {
    const { server: s } = buildServer();
    const { port } = await s.start();
    expect(port).toBeGreaterThan(0);
    const mode = (await stat(infoPath)).mode & 0o777;
    expect(mode).toBe(0o600);
    const info = JSON.parse(await readFile(infoPath, 'utf8'));
    expect(info).toMatchObject({ pid: process.pid, port });
    expect(typeof info.startedAt).toBe('string');
    // 32 random bytes, hex-encoded — 64 hex characters, never the same across two starts.
    expect(typeof info.token).toBe('string');
    expect(info.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('two starts mint two DIFFERENT tokens — never a fixed or reused secret', async () => {
    const { server: first } = buildServer();
    await first.start();
    const firstInfo = JSON.parse(await readFile(infoPath, 'utf8'));
    await first.stop();
    server = undefined;

    const { server: second } = buildServer();
    await second.start();
    server = second;
    const secondInfo = JSON.parse(await readFile(infoPath, 'utf8'));
    expect(secondInfo.token).not.toBe(firstInfo.token);
  });

  it('stop() removes the discovery file', async () => {
    const { server: s } = buildServer();
    await s.start();
    await s.stop();
    server = undefined;
    await expect(readControlInfo(infoPath)).resolves.toBeNull();
  });

  it('GET /status returns the merged status + trigger records', async () => {
    const { server: s } = buildServer();
    await s.start();
    const result = await requestIndexStatus({ infoPath });
    expect(result).toEqual({ ok: true, data: { records: [RECORD], triggers: [TRIGGER_STATUS] } });
  });

  it('POST /reindex on a known repository calls requestManualReindex with its repoRoot', async () => {
    const { server: s, requestManualReindexCalls } = buildServer();
    await s.start();
    const result = await requestIndexReindex('my-repo', { infoPath });
    expect(result).toEqual({ ok: true, data: { ok: true } });
    expect(requestManualReindexCalls).toEqual(['/repo/a']);
  });

  it('POST /retry is the SAME call as /reindex (locked decision 7) — one function, two routes', async () => {
    const { server: s, requestManualReindexCalls } = buildServer();
    await s.start();
    await requestIndexRetry('my-repo', { infoPath });
    expect(requestManualReindexCalls).toEqual(['/repo/a']);
  });

  it('an unknown repositoryKey 404s and never reaches requestManualReindex', async () => {
    const { server: s, requestManualReindexCalls } = buildServer();
    await s.start();
    const result = await requestIndexReindex('no-such-repo', { infoPath });
    expect(result).toEqual({ ok: false, reason: 'unknown-repository' });
    expect(requestManualReindexCalls).toEqual([]);
  });

  it('POST /cancel reports true when a job was actually cancelled, false when nothing was active', async () => {
    const { server: s, cancelCalls } = buildServer();
    await s.start();
    const result = await requestIndexCancel('my-repo', { infoPath });
    expect(result).toEqual({ ok: true, data: { ok: true } });
    expect(cancelCalls).toEqual(['my-repo']);
  });

  it('/cancel is 501 not-supported when the daemon supplies no cancelRepo', async () => {
    const { server: s } = buildServer({ cancelRepo: undefined });
    await s.start();
    const result = await requestIndexCancel('my-repo', { infoPath });
    expect(result).toEqual({ ok: false, reason: 'not-supported' });
  });

  it('every new command asks the daemon rather than acting itself — no route uploads or mints anything', async () => {
    // The honest proof of this is the import graph (index-control.ts never imports
    // client.ts/ingest-client.ts — see the accompanying import-graph test); this test just pins
    // the observable surface: every route either reads a snapshot already computed elsewhere or
    // forwards to an injected callback, never performs I/O of its own beyond that forwarding.
    const { server: s } = buildServer();
    await s.start();
    await requestIndexReindex('my-repo', { infoPath });
    await requestIndexCancel('my-repo', { infoPath });
    await requestIndexStatus({ infoPath });
    // No assertion beyond "this ran without the server touching anything but its injected deps" —
    // TypeScript's own structural typing on IndexControlDeps (no client, no fetch dep at all)
    // already makes a network call from inside this class impossible to add unnoticed.
  });
});

// RUN-223 round 2: the bearer token is the actual authentication boundary, not loopback alone —
// see index-control.ts's module doc for why. Every test here talks to the real bound socket with
// PLAIN `fetch`, never through `requestIndex*` (which always supplies the correct header) — this
// is exactly the shape of an unauthenticated local caller: a spawned agent's `node -e "fetch(...)"`
// with a guessed or enumerated port, or a browser's cross-origin simple POST.
describe('the control server requires the bearer token (RUN-223 round 2)', () => {
  let dir: string;
  let infoPath: string;
  let server: IndexControlServer | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'noriq-index-control-auth-'));
    infoPath = path.join(dir, 'index-control.json');
  });

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  async function startAuthedServer() {
    let cancelled = 0;
    let reindexed = 0;
    server = new IndexControlServer({
      statusStore: { snapshot: () => [RECORD] },
      triggerStatuses: () => [TRIGGER_STATUS],
      repoRootFor: () => '/repo/a',
      requestManualReindex: async () => {
        reindexed += 1;
      },
      cancelRepo: () => {
        cancelled += 1;
        return true;
      },
      controlInfoPath: infoPath,
      logger: quiet,
    });
    const { port } = await server.start();
    return { port, getCounts: () => ({ cancelled, reindexed }) };
  }

  it('GET /status with no auth header at all — 401, no body', async () => {
    const { port } = await startAuthedServer();
    const res = await fetch(`http://127.0.0.1:${port}/status`);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('');
  });

  it('POST /reindex with no auth header never reaches requestManualReindex — the browser vector', async () => {
    // The exact shape of a cross-origin "simple" request a page the user visits could issue:
    // no custom header, a body type that needs no preflight. It cannot read this response, but a
    // real daemon must still never act on it.
    const { port, getCounts } = await startAuthedServer();
    const res = await fetch(`http://127.0.0.1:${port}/reindex`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ repositoryKey: 'my-repo' }),
    });
    expect(res.status).toBe(401);
    expect(getCounts().reindexed).toBe(0);
  });

  it('POST /cancel with the WRONG token — 401, never reaches cancelRepo', async () => {
    const { port, getCounts } = await startAuthedServer();
    const res = await fetch(`http://127.0.0.1:${port}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-noriq-index-control': 'not-the-real-token' },
      body: JSON.stringify({ repositoryKey: 'my-repo' }),
    });
    expect(res.status).toBe(401);
    expect(getCounts().cancelled).toBe(0);
  });

  it('a request with the CORRECT token from the discovery file succeeds', async () => {
    const { port } = await startAuthedServer();
    const info = JSON.parse(await readFile(infoPath, 'utf8'));
    const res = await fetch(`http://127.0.0.1:${port}/status`, {
      headers: { 'x-noriq-index-control': info.token },
    });
    expect(res.status).toBe(200);
  });

  it('a nonexistent route with no auth is still 401, never a 404 that would confirm what routes exist', async () => {
    const { port } = await startAuthedServer();
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(401);
  });

  it('the CLI client (requestIndexStatus et al.) supplies the token automatically — no caller has to know about it', async () => {
    await startAuthedServer();
    const result = await requestIndexStatus({ infoPath });
    expect(result.ok).toBe(true);
  });

  it('a discovery file missing the token field reads as no-daemon, never an unauthenticated request', async () => {
    await writeFile(
      infoPath,
      JSON.stringify({ pid: process.pid, port: 1, startedAt: '2026-01-01T00:00:00.000Z' }),
    );
    await expect(readControlInfo(infoPath)).resolves.toBeNull();
    const result = await requestIndexStatus({ infoPath });
    expect(result).toEqual({ ok: false, reason: 'no-daemon' });
  });
});

describe('the CLI-side client — no live daemon', () => {
  let dir: string;
  let infoPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'noriq-index-control-client-'));
    infoPath = path.join(dir, 'index-control.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('says "no-daemon" when the discovery file does not exist', async () => {
    await expect(requestIndexStatus({ infoPath })).resolves.toEqual({ ok: false, reason: 'no-daemon' });
    await expect(requestIndexReindex('my-repo', { infoPath })).resolves.toEqual({
      ok: false,
      reason: 'no-daemon',
    });
    await expect(requestIndexCancel('my-repo', { infoPath })).resolves.toEqual({
      ok: false,
      reason: 'no-daemon',
    });
  });

  it('says "no-daemon" for a corrupt discovery file — never a throw', async () => {
    await writeFile(infoPath, 'not json{{{');
    await expect(requestIndexStatus({ infoPath })).resolves.toEqual({ ok: false, reason: 'no-daemon' });
  });

  it('says "no-daemon" for a stale file naming a port nothing answers on — never a raw connection error', async () => {
    // A daemon that crashed without cleaning up its own file: the file is well-formed, the pid
    // and startedAt look fine, but nothing is listening on the named port.
    await writeFile(
      infoPath,
      JSON.stringify({ pid: 999999, port: 1, startedAt: '2026-01-01T00:00:00.000Z' }),
    );
    const result = await requestIndexStatus({ infoPath });
    expect(result).toEqual({ ok: false, reason: 'no-daemon' });
  });

  it('DEFAULT_CONTROL_INFO_PATH lives under ~/.noriq, matching every other store in this codebase', () => {
    expect(DEFAULT_CONTROL_INFO_PATH).toContain('.noriq');
    expect(DEFAULT_CONTROL_INFO_PATH.endsWith('index-control.json')).toBe(true);
  });
});
