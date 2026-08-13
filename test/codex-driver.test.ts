import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { PermissionProfile, RunEffort, RunKind } from '@noriq-dev/shared';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CODEX_HOME } from '../src/agent-homes';
import { AsyncQueue } from '../src/async-queue';
import { noriqToolsFor } from '../src/drivers/claude';
import {
  CODEX_FORCE_STOP_MS,
  CODEX_GRACEFUL_STOP_MS,
  CODEX_MCP_ATTESTATION_MAX_RESULTS,
  CODEX_MCP_ATTESTATION_TIMEOUT_MS,
  CODEX_SILENCE_TEARDOWN_MS,
  CodexDriver,
  type CodexEvent,
  type CodexTransport,
  type SpawnCodex,
  defaultSpawnCodex,
  mapEffort,
  mapSandbox,
  normalizeNotification,
} from '../src/drivers/codex';
import type { DriverStartOptions, DriverTelemetry, ProjectMcpSession } from '../src/drivers/types';
import type {
  AgentProcessContainment,
  AgentProcessLaunch,
  ContainedAgentProcess,
} from '../src/process-containment';
import { type ProjectMcpBundle, bindProjectMcpBundle, loadProjectMcpBundle } from '../src/project-mcp';

class FakeTransport implements CodexTransport {
  readonly events = new AsyncQueue<CodexEvent>();
  turns: string[] = [];
  steers: string[] = [];
  interrupted = 0;
  closed = false;
  sandbox = '';
  sendUserTurn(text: string): void {
    this.turns.push(text);
  }
  /** Mirrors the real transport: nothing to steer once the session is closed. */
  steer(text: string): boolean {
    if (this.closed) return false;
    this.steers.push(text);
    return true;
  }
  interrupt(): void {
    this.interrupted += 1;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.events.close();
  }
  push(ev: CodexEvent): void {
    this.events.push(ev);
  }
}

const testCodexDriver = (deps: ConstructorParameters<typeof CodexDriver>[0] = {}): CodexDriver =>
  new CodexDriver({
    reattestProjectMcpExecutables: () => Object.freeze([]),
    ...deps,
  });

const profile = (over: Partial<PermissionProfile> = {}): PermissionProfile => ({
  write: false,
  allow: [],
  deny: [],
  auto: false,
  ...over,
});

function harness(startOver: Partial<DriverStartOptions> = {}) {
  let fake!: FakeTransport;
  const spawnCodex: SpawnCodex = (opts) => {
    fake = new FakeTransport();
    fake.sandbox = opts.sandbox;
    return fake;
  };
  const telemetry: DriverTelemetry[] = [];
  const texts: string[] = [];
  const driver = testCodexDriver({ spawnCodex, prepareCodexHome: () => {} });
  const session = driver.start({
    runId: 'run_1',
    kind: 'build',
    cwd: '/wt',
    prompt: 'do the thing',
    permission: profile({ write: true }),
    handlers: { onText: (t) => texts.push(t), onTelemetry: (t) => telemetry.push(t) },
    ...startOver,
  });
  return { session, telemetry, texts, getFake: () => fake };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const projectMcp = (
  servers: ProjectMcpBundle['servers'],
  toolGrants: ProjectMcpSession['toolGrants'],
): ProjectMcpSession => ({
  bundle: {
    source: '/wt/.mcp.json',
    declarationFingerprint: 'declared',
    effectiveFingerprint: 'effective',
    launcherAuthorizations: Object.fromEntries(
      Object.entries(servers).flatMap(([name, server]) =>
        server.transport === 'stdio'
          ? [
              [
                name,
                {
                  policyId: 'test-policy',
                  executableIdentity: `test:${name}`,
                  runtimeClosureIdentity: `test:runtime:${name}`,
                  authorizedArgvIdentity: `sha256:${'a'.repeat(64)}`,
                  resolvedCommand: process.execPath,
                  readOnlyRoots: [],
                },
              ],
            ]
          : [],
      ),
    ),
    endpointAuthorizations: Object.fromEntries(
      Object.entries(servers).flatMap(([name, server]) =>
        server.transport !== 'stdio'
          ? [
              [
                name,
                {
                  policyId: 'test-endpoint-policy',
                  endpointIdentity: `test:${name}`,
                  resolvedUrl: server.url,
                },
              ],
            ]
          : [],
      ),
    ),
    servers,
  },
  toolGrants,
});

describe('mapSandbox', () => {
  it('maps write→workspace-write, read-only otherwise', () => {
    expect(mapSandbox(profile({ write: false }))).toBe('read-only');
    expect(mapSandbox(profile({ write: true }))).toBe('workspace-write');
  });
});

describe('driver capabilities (RUN-110)', () => {
  it('codex declares NO in-process hooks, no resume, no per-model telemetry', () => {
    const driver = testCodexDriver({ spawnCodex: (() => ({})) as never });
    expect(driver.tool).toBe('codex');
    expect(driver.capabilities).toEqual({
      toolHooks: false,
      steer: true,
      interrupt: true,
      resumableSession: false,
      perModelTelemetry: false,
      toolFreeSession: false,
      workspaceIsolatedSession: true,
      projectMcpProcessContainment: false,
      terminationAcknowledgement: 'main-process',
    });
  });
});

describe('Runner-specific Codex home (RUN-290)', () => {
  it('prepares the isolated home and passes it through the spawn boundary', () => {
    const prepared: string[] = [];
    let spawnedHome: string | undefined;
    const driver = testCodexDriver({
      codexHome: '/runner/codex',
      prepareCodexHome: (home) => prepared.push(home),
      spawnCodex: (opts) => {
        spawnedHome = opts.codexHome;
        return new FakeTransport();
      },
    });
    driver.start({
      runId: 'run_home',
      kind: 'scope',
      cwd: '/wt',
      prompt: 'inspect',
      permission: profile(),
    });

    expect(prepared).toEqual(['/runner/codex']);
    expect(spawnedHome).toBe('/runner/codex');
  });

  it('gives every contained mission a credential-only home and deletes it after tree exit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noriq-codex-attempt-home-'));
    const exits: Array<ReturnType<typeof deferred<void>>> = [];
    const attemptHomes: string[] = [];
    try {
      const durableHome = path.join(root, 'durable');
      const workspace = path.join(root, 'workspace');
      await Promise.all([mkdir(path.join(durableHome, 'sessions'), { recursive: true }), mkdir(workspace)]);
      await Promise.all([
        writeFile(path.join(durableHome, 'auth.json'), '{"token":"codex-secret"}', { mode: 0o600 }),
        writeFile(path.join(durableHome, 'config.toml'), 'model = "ambient"'),
        writeFile(path.join(durableHome, 'sessions', 'prior.jsonl'), 'prior session'),
      ]);

      const launches: AgentProcessLaunch[] = [];
      const children: ReturnType<typeof makeFakeChild>[] = [];
      const containment: AgentProcessContainment = {
        capabilities: {
          processTreeTermination: true,
          ownerDeathTermination: true,
          workspaceIsolation: true,
          protectedWorkspaceSubpaths: true,
          projectMcpProcessContainment: true,
          providerCredentialIsolation: true,
          hostResourceIsolation: true,
          networkEgressIsolation: true,
          immutableRuntimeAuthority: true,
          providerTokenEnvelope: true,
        },
        authorityFingerprint: `sha256:${'c'.repeat(64)}`,
        assertAuthority: async () => undefined,
        probe: async () => {},
        spawn(request): ContainedAgentProcess {
          launches.push(request);
          const child = makeFakeChild([]);
          const exit = deferred();
          children.push(child);
          exits.push(exit);
          return {
            child: child as never,
            exited: exit.promise,
            terminate: () => {},
          };
        },
      };

      for (const runId of ['mission-attempt-1', 'mission-attempt-2']) {
        defaultSpawnCodex({
          runId,
          cwd: workspace,
          workspaceRoot: workspace,
          workspaceWrite: true,
          sandbox: 'workspace-write',
          approvalPolicy: 'never',
          kind: 'build',
          codexHome: durableHome,
          containment,
          tokenEnvelope: { totalTokens: 2_048, maxTurns: 8 },
        });
      }

      const homes = launches.map((launch) => launch.providerCredentialRoots?.[0]);
      expect(homes).toHaveLength(2);
      expect(homes[0]).toBeTruthy();
      expect(homes[1]).toBeTruthy();
      expect(homes[0]).not.toBe(homes[1]);
      expect(launches.every((launch) => launch.privateWriteRoots === undefined)).toBe(true);
      for (const [index, launch] of launches.entries()) {
        const attemptHome = homes[index] as string;
        attemptHomes.push(attemptHome);
        expect(launch.providerCredentialRoots).toEqual([attemptHome]);
        expect(launch.providerCredentialRoots).not.toContain(durableHome);
        expect(launch.privateWriteRoots).toBeUndefined();
        expect(launch.providerTokenEnvelope).toEqual({ totalTokens: 2_048, maxTurns: 8 });
        expect(launch.env.HOME).toBe(attemptHome);
        expect(launch.env.CODEX_HOME).toBe(attemptHome);
        expect(await readdir(attemptHome)).toEqual(['auth.json']);
        expect(await readFile(path.join(attemptHome, 'auth.json'), 'utf8')).toBe('{"token":"codex-secret"}');

        // Direct-child death is not enough: cleanup is owned by the containment tree boundary.
        children[index]?.emitProcessExit();
        await expect(stat(attemptHome)).resolves.toBeTruthy();
      }

      for (const exit of exits) exit.resolve();
      await tick();
      for (const attemptHome of homes) {
        await expect(stat(attemptHome as string)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      for (const exit of exits) exit.resolve();
      await tick();
      await Promise.all(attemptHomes.map((home) => rm(home, { recursive: true, force: true })));
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('normalizeNotification (real app-server shapes)', () => {
  it('maps agentMessageDelta / tokenUsage / turn.completed / error', () => {
    expect(normalizeNotification('thread/agentMessageDelta', { delta: 'hi' })).toEqual({
      type: 'text',
      text: 'hi',
    });
    expect(
      normalizeNotification('thread/tokenUsageUpdated', {
        tokenUsage: { total: { inputTokens: 30, outputTokens: 12, cachedInputTokens: 4 } },
      }),
    ).toEqual({ type: 'usage', inputTokens: 30, outputTokens: 12, cacheReadTokens: 4 });
    expect(normalizeNotification('turn/completed', {})).toEqual({ type: 'turn_complete' });
    expect(normalizeNotification('thread/error', { error: { message: 'boom' } })).toEqual({
      type: 'error',
      message: 'boom',
    });
    expect(normalizeNotification('thread/unknown', {})).toBeNull();
  });

  it('accepts the 0.144.x names too — every notification was RENAMED between minors (RUN-72)', () => {
    // Verified live against codex-cli 0.144.5. The daemon cannot pick which codex a machine
    // has installed, so each concept answers to every name it has ever had.
    expect(normalizeNotification('item/agentMessage/delta', { delta: 'OK' })).toEqual({
      type: 'text',
      text: 'OK',
    });
    expect(
      normalizeNotification('thread/tokenUsage/updated', {
        tokenUsage: { total: { inputTokens: 12851, outputTokens: 12, cachedInputTokens: 0 } },
      }),
    ).toEqual({ type: 'usage', inputTokens: 12851, outputTokens: 12, cacheReadTokens: 0 });
    expect(normalizeNotification('error', { error: { message: 'invalid_request_error' } })).toEqual({
      type: 'error',
      message: 'invalid_request_error',
    });
  });

  it('a FAILED turn/completed is an error, not success — 0.144.x reports API failures there (RUN-72)', () => {
    // An API-level failure arrives as turn/completed{status:'failed'}; reading it as success
    // marked runs `done` whose agent never answered.
    expect(
      normalizeNotification('turn/completed', {
        turn: { status: 'failed', error: { message: 'model not supported' } },
      }),
    ).toEqual({ type: 'error', message: 'model not supported' });
    expect(normalizeNotification('turn/completed', { turn: { status: 'completed' } })).toEqual({
      type: 'turn_complete',
    });
    // 0.142.x sends no status at all — that generation's failures came as thread/error.
    expect(normalizeNotification('turn/completed', {})).toEqual({ type: 'turn_complete' });
  });
});

describe('CodexDriver', () => {
  it('refuses a tool-free turn before starting an app-server process', () => {
    let spawned = false;
    const driver = testCodexDriver({
      prepareCodexHome: () => {},
      spawnCodex: () => {
        spawned = true;
        return new FakeTransport();
      },
    });

    expect(() =>
      driver.start({
        runId: 'guide',
        kind: 'scope',
        cwd: '/private',
        prompt: 'choose one proposal',
        permission: profile(),
        toolAccess: 'none',
      }),
    ).toThrow('cannot attest a tool-free session');
    expect(spawned).toBe(false);
  });

  it('enforces an exact workspace root and refuses danger-full-access for mission children', () => {
    const driver = testCodexDriver({
      prepareCodexHome: () => {},
      spawnCodex: () => new FakeTransport(),
    });
    const base = {
      runId: 'child',
      kind: 'build' as const,
      cwd: '/leases/mission',
      workspaceRoot: '/leases/mission',
      prompt: 'work',
      permission: profile({ write: true }),
    };
    expect(() => driver.start({ ...base, cwd: '/leases/other' })).toThrow('must exactly match');
    expect(() => driver.start({ ...base, permission: profile({ write: true, auto: true }) })).toThrow(
      'danger-full-access cannot enforce',
    );
    expect(() => driver.start(base)).not.toThrow();
  });

  it('rejects combining project and Noriq MCP authority before spawning', () => {
    const driver = testCodexDriver({
      prepareCodexHome: () => {},
      spawnCodex: () => new FakeTransport(),
    });
    expect(() =>
      driver.start({
        runId: 'combined',
        kind: 'build',
        cwd: '/wt',
        prompt: 'work',
        permission: profile({ write: true }),
        noriqMcp: { url: 'https://noriq.test/mcp', token: 'token' },
        projectMcp: projectMcp(
          { simulator: { transport: 'stdio', command: 'sim', args: [], env: {} } },
          { simulator: ['inspect'] },
        ),
      }),
    ).toThrow('may not combine project MCP authority with Noriq MCP authority');
  });

  it('refuses a replaced project MCP executable before spawning Codex', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noriq-codex-mcp-attest-'));
    try {
      const executable = path.join(root, 'mcp-launcher');
      await writeFile(executable, '#!/bin/sh\nexit 0\n');
      await chmod(executable, 0o755);
      await writeFile(
        path.join(root, '.mcp.json'),
        `${JSON.stringify({ mcpServers: { project: { command: 'custom', args: [] } } })}\n`,
      );
      const bundle = bindProjectMcpBundle(
        await loadProjectMcpBundle(root, {
          launcherPolicy: {
            policyId: 'codex-test-launcher-v1',
            authorize: ({ argvIdentity }) => ({
              policyId: 'codex-test-launcher-v1',
              executableIdentity: 'codex-test-launcher/revision-1',
              runtimeClosureIdentity: 'codex-test-runtime/revision-1',
              authorizedArgvIdentity: argvIdentity,
              resolvedCommand: executable,
              readOnlyRoots: [],
            }),
          },
        }),
        root,
      );
      await writeFile(executable, '#!/bin/sh\nexit 9\n');
      const spawnCodex = vi.fn(() => new FakeTransport());
      const driver = new CodexDriver({ spawnCodex, prepareCodexHome: () => {} });

      expect(() =>
        driver.start({
          runId: 'mutated-project-mcp',
          kind: 'build',
          cwd: root,
          prompt: 'must never launch',
          permission: profile({ write: true }),
          projectMcp: { bundle, toolGrants: { project: ['inspect'] } },
        }),
      ).toThrow(/executable re-attestation failed: resolved command digest changed/);
      expect(spawnCodex).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // RUN-201: twice in one live evening a codex child died without its exit reaching the event
  // loop, and the run showed "running" for half an hour with no process behind it. Silence past
  // the deadline settles the session as an ordinary failure the continuation flow recovers.
  it('tears down a session that goes silent past the liveness deadline (RUN-201)', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const fake = h.getFake();
      fake.push({ type: 'text', text: 'working…' }); // one sign of life, then nothing
      await vi.advanceTimersByTimeAsync(CODEX_SILENCE_TEARDOWN_MS + 1);
      const exit = await h.session.done();
      expect(exit.outcome).toBe('failed');
      expect(exit.reason).toContain('silent');
      expect(fake.closed).toBe(true); // the tree was torn down, not abandoned
    } finally {
      vi.useRealTimers();
    }
  });

  it('an active session is never torn down — every event re-arms the deadline', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const fake = h.getFake();
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(CODEX_SILENCE_TEARDOWN_MS - 1000);
        fake.push({ type: 'usage', inputTokens: i, outputTokens: i, cacheReadTokens: 0 });
        await vi.advanceTimersByTimeAsync(0);
      }
      fake.push({ type: 'turn_complete' });
      await vi.advanceTimersByTimeAsync(0);
      const exit = await h.session.done();
      expect(exit.outcome).toBe('done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts a turn, streams text, sets cumulative telemetry, completes on turn_complete', async () => {
    const h = harness();
    const fake = h.getFake();
    expect(fake.sandbox).toBe('workspace-write'); // build → workspace-write
    expect(fake.turns).toEqual(['do the thing']); // initial prompt submitted as a turn
    fake.push({ type: 'text', text: 'patching…' });
    fake.push({ type: 'usage', inputTokens: 200, outputTokens: 50, cacheReadTokens: 10 });
    fake.push({ type: 'turn_complete' });
    const exit = await h.session.done();
    expect(exit.outcome).toBe('done');
    expect(exit.telemetry).toMatchObject({
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: 10,
      numTurns: 1,
    });
    expect(h.texts).toContain('patching…');
    expect(fake.closed).toBe(true);
  });

  it('streams agentMessageDelta text byte-faithfully, newlines intact (RUN-77 parity)', async () => {
    // Codex's only text source is the raw agentMessageDelta stream (no assembled-message
    // path), so concatenated deltas reproduce the model's bytes exactly — the newlines the
    // claude driver used to drop. Deltas split mid-word AND at the newline itself.
    const h = harness();
    const fake = h.getFake();
    for (const text of [
      'I’ll review the diff.',
      '\n',
      'The changed wizard now.',
      '\n- High — VCS detec',
      'tion.',
    ]) {
      fake.push({ type: 'text', text });
    }
    fake.push({ type: 'turn_complete' });
    await h.session.done();
    const joined = h.texts.join('');
    expect(joined).toBe('I’ll review the diff.\nThe changed wizard now.\n- High — VCS detection.');
    expect(joined).not.toContain('diff.The');
  });

  it('separates distinct agentMessage items with a paragraph break; id-less deltas never do (RUN-80)', async () => {
    const h = harness();
    const fake = h.getFake();
    fake.push({ type: 'text', text: 'First message.', itemId: 'item_a' });
    fake.push({ type: 'text', text: ' Continued.', itemId: 'item_a' });
    fake.push({ type: 'text', text: 'Second message.', itemId: 'item_b' });
    // 0.142.x sends no item id — the break-on-change must never fire on absence.
    fake.push({ type: 'text', text: ' trailing id-less delta' });
    fake.push({ type: 'turn_complete' });
    await h.session.done();
    expect(h.texts.join('')).toBe('First message. Continued.\n\nSecond message. trailing id-less delta');

    // normalizeNotification surfaces the id from either 0.144.x shape.
    expect(normalizeNotification('item/agentMessage/delta', { delta: 'x', itemId: 'i1' })).toEqual({
      type: 'text',
      text: 'x',
      itemId: 'i1',
    });
    expect(normalizeNotification('item/agentMessage/delta', { delta: 'x', item: { id: 'i2' } })).toEqual({
      type: 'text',
      text: 'x',
      itemId: 'i2',
    });
    expect(normalizeNotification('thread/agentMessageDelta', { delta: 'x' })).toEqual({
      type: 'text',
      text: 'x',
    });
  });

  it('maps an error event to a failed outcome', async () => {
    const h = harness();
    h.getFake().push({ type: 'error', message: 'sandbox denied write' });
    const exit = await h.session.done();
    expect(exit).toMatchObject({ outcome: 'failed', reason: 'sandbox denied write' });
  });

  it('pushInput steers the active turn', async () => {
    const h = harness();
    const fake = h.getFake();
    h.session.pushInput('also fix the tests');
    expect(fake.steers).toEqual(['also fix the tests']);
    fake.push({ type: 'turn_complete' });
    await h.session.done();
  });

  it('interrupt() interrupts the transport', async () => {
    const h = harness();
    const fake = h.getFake();
    await h.session.interrupt();
    expect(fake.interrupted).toBe(1);
    fake.push({ type: 'turn_complete' });
    await h.session.done();
  });

  it('stop() ends the run as failed(stopped)', async () => {
    const h = harness();
    await h.session.stop();
    expect(await h.session.done()).toMatchObject({ outcome: 'failed', reason: 'stopped' });
  });

  it('does not settle a completed run until transport process death is acknowledged', async () => {
    const fake = new FakeTransport();
    const closeStarted = deferred();
    const processExited = deferred();
    fake.close = async () => {
      fake.closed = true;
      closeStarted.resolve();
      await processExited.promise;
      fake.events.close();
    };
    const driver = testCodexDriver({ spawnCodex: () => fake, prepareCodexHome: () => {} });
    const session = driver.start({
      runId: 'run_exit_ack',
      kind: 'build',
      cwd: '/wt',
      prompt: 'do the thing',
      permission: profile({ write: true }),
    });
    fake.push({ type: 'turn_complete' });
    await closeStarted.promise;

    const beforeExit = await Promise.race([
      session.done().then(() => 'settled'),
      tick().then(() => 'pending'),
    ]);
    expect(beforeExit).toBe('pending');
    processExited.resolve();
    await expect(session.done()).resolves.toMatchObject({ outcome: 'done' });
  });

  it('does not resolve stop until transport process death is acknowledged', async () => {
    const fake = new FakeTransport();
    const closeStarted = deferred();
    const processExited = deferred();
    fake.close = async () => {
      fake.closed = true;
      closeStarted.resolve();
      await processExited.promise;
      fake.events.close();
    };
    const driver = testCodexDriver({ spawnCodex: () => fake, prepareCodexHome: () => {} });
    const session = driver.start({
      runId: 'run_stop_ack',
      kind: 'build',
      cwd: '/wt',
      prompt: 'do the thing',
      permission: profile({ write: true }),
    });
    const stopping = session.stop();
    await closeStarted.promise;

    const beforeExit = await Promise.race([stopping.then(() => 'settled'), tick().then(() => 'pending')]);
    expect(beforeExit).toBe('pending');
    processExited.resolve();
    await expect(stopping).resolves.toBeUndefined();
    await expect(session.done()).resolves.toMatchObject({ outcome: 'failed', reason: 'stopped' });
  });

  it('rejects stop at its bounded deadline but settles done after a later process exit', async () => {
    vi.useFakeTimers();
    try {
      const fakeChild = makeFakeChild([]);
      const driver = testCodexDriver({
        prepareCodexHome: () => {},
        spawnCodex: (opts) =>
          defaultSpawnCodex(
            opts,
            () => fakeChild as never,
            () => {
              // Simulate a process that ignores both graceful and forced tree termination, then
              // finally exits after stop() has already reported its bounded ambiguity.
            },
          ),
      });
      const session = driver.start({
        runId: 'run_late_exit_ack',
        kind: 'build',
        cwd: '/wt',
        prompt: 'do the thing',
        permission: profile({ write: true }),
      });

      const stopping = session.stop();
      const rejection = expect(stopping).rejects.toThrow(
        'codex process did not exit within 2000ms graceful plus 5000ms forced shutdown',
      );
      await vi.advanceTimersByTimeAsync(CODEX_GRACEFUL_STOP_MS + CODEX_FORCE_STOP_MS);
      await rejection;

      const beforeLateExit = await Promise.race([
        session.done().then(() => 'settled'),
        Promise.resolve('pending'),
      ]);
      expect(beforeLateExit).toBe('pending');

      fakeChild.emitProcessExit(null, 'SIGKILL');
      await expect(session.done()).resolves.toMatchObject({ outcome: 'failed', reason: 'stopped' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('sets cumulative usage (not accumulated) from repeated usage events', async () => {
    const h = harness();
    const fake = h.getFake();
    fake.push({ type: 'usage', inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 });
    fake.push({ type: 'usage', inputTokens: 25, outputTokens: 9, cacheReadTokens: 3 }); // cumulative, replaces
    await tick();
    expect(h.telemetry.at(-1)).toMatchObject({ inputTokens: 25, outputTokens: 9, cacheReadTokens: 3 });
    fake.push({ type: 'turn_complete' });
    await h.session.done();
  });

  it('a stream that ends without completing a turn fails', async () => {
    const h = harness();
    h.getFake().events.close();
    expect(await h.session.done()).toMatchObject({
      outcome: 'failed',
      reason: 'codex stream ended without completing a turn',
    });
  });
});

// RUN-200: a codex build's gate had no repair loop because the session died at turn one —
// `reviewWithFeedback` bails when `!ctx.session.continueWith`, and every codex session offered
// none. These pin the fix: multiTurn keeps the session (and the fake transport) alive past the
// first turn/completed, continueWith posts a second turn on the SAME live transport, and a
// non-multiTurn session is provably unchanged (the tests above already cover that; this block
// only adds the one new assertion — no continueWith — that distinguishes it).
describe('CodexDriver multiTurn / continueWith (RUN-200)', () => {
  it('a non-multiTurn session offers no continueWith — unchanged from before RUN-200', async () => {
    const h = harness();
    expect(h.session.continueWith).toBeUndefined();
    h.getFake().push({ type: 'turn_complete' });
    await h.session.done();
  });

  it('multiTurn exposes continueWith and survives its first turn/completed instead of tearing down', async () => {
    const h = harness({ multiTurn: true });
    const fake = h.getFake();
    expect(fake.turns).toEqual(['do the thing']);
    fake.push({ type: 'turn_complete' });
    const firstExit = await h.session.done();
    expect(firstExit.outcome).toBe('done');
    // The root cause this ticket fixes: finish() used to close the transport unconditionally on
    // the first turn/completed. Under multiTurn it must not — nothing else would ever be able to
    // post a second turn/start.
    expect(fake.closed).toBe(false);
    expect(h.session.continueWith).toBeInstanceOf(Function);
  });

  it('continueWith posts a second turn on the SAME live transport and resolves independently of done()', async () => {
    const h = harness({ multiTurn: true });
    const fake = h.getFake();
    fake.push({ type: 'turn_complete' });
    const firstExit = await h.session.done();

    const turn = h.session.continueWith?.('please fix the finding');
    // Sent immediately (synchronously) — the same transport instance, i.e. the same live thread,
    // not a fresh spawnCodex() call (there is only ever one `fake` per harness()).
    expect(fake.turns).toEqual(['do the thing', 'please fix the finding']);
    fake.push({ type: 'text', text: 'fixed it' });
    fake.push({ type: 'turn_complete' });
    const secondExit = await turn;
    expect(secondExit).toMatchObject({ outcome: 'done', isError: false });
    // done() is one-shot — it already settled on the FIRST turn and must not have been re-armed
    // or overwritten by the second.
    expect(await h.session.done()).toBe(firstExit);
    expect(h.texts).toContain('fixed it');

    // The caller owns teardown now (RUN-200's contract): nothing closes the process until stop().
    expect(fake.closed).toBe(false);
    await h.session.stop();
    expect(fake.closed).toBe(true);
  });

  it("does not double-count the first turn's cumulative usage into the second (RUN-200)", async () => {
    // The app-server's tokenUsage.total is cumulative for the whole THREAD, across every turn —
    // so a second turn's total already includes the first's, and the driver must go on setting
    // (not accumulating) or a fix round's spend would be double-counted against the run's budget.
    const h = harness({ multiTurn: true });
    const fake = h.getFake();
    fake.push({ type: 'usage', inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 });
    fake.push({ type: 'turn_complete' });
    await h.session.done();

    const turn = h.session.continueWith?.('fix it');
    // The thread's own cumulative total after the second turn — NOT 100+250.
    fake.push({ type: 'usage', inputTokens: 250, outputTokens: 60, cacheReadTokens: 5 });
    fake.push({ type: 'turn_complete' });
    const exit = await turn;
    expect(exit?.telemetry).toMatchObject({ inputTokens: 250, outputTokens: 60, cacheReadTokens: 5 });
    expect(h.telemetry.at(-1)).toMatchObject({ inputTokens: 250, outputTokens: 60, cacheReadTokens: 5 });
  });

  it('rejects an overlapping continueWith rather than losing one turn silently', async () => {
    const h = harness({ multiTurn: true });
    const fake = h.getFake();
    fake.push({ type: 'turn_complete' });
    await h.session.done();

    const first = h.session.continueWith?.('turn A');
    const second = h.session.continueWith?.('turn B');
    await expect(second).rejects.toThrow('already in flight');
    fake.push({ type: 'turn_complete' });
    await expect(first).resolves.toMatchObject({ outcome: 'done' });
  });

  it('an honest failure — never a fabricated success — when the process is already torn down', async () => {
    const h = harness({ multiTurn: true });
    const fake = h.getFake();
    fake.push({ type: 'turn_complete' });
    await h.session.done();
    await h.session.stop();
    expect(fake.closed).toBe(true);
    await expect(h.session.continueWith?.('too late')).rejects.toThrow();
  });

  it('an honest failure when the FIRST turn never actually completed', async () => {
    // multiTurn keeps the process alive even past a failed first turn (finish() only tears down
    // when !multiTurn) — so continueWith must recognize a thread with no successful foundation
    // rather than posting a turn/start and waiting forever for a turn/completed that a broken
    // thread will never send.
    const h = harness({ multiTurn: true });
    h.getFake().push({ type: 'error', message: 'sandbox denied write' });
    const firstExit = await h.session.done();
    expect(firstExit.outcome).toBe('failed');
    await expect(h.session.continueWith?.('try again')).rejects.toThrow('no live codex thread');
  });

  it('stop() mid hand-back fails the pending turn instead of hanging it forever', async () => {
    const h = harness({ multiTurn: true });
    const fake = h.getFake();
    fake.push({ type: 'turn_complete' });
    await h.session.done();

    const turn = h.session.continueWith?.('fix it');
    await h.session.stop();
    expect(fake.closed).toBe(true);
    await expect(turn).resolves.toMatchObject({ outcome: 'failed', reason: 'stopped' });
  });

  it('a stream that ends mid hand-back fails the pending turn, not done() again', async () => {
    const h = harness({ multiTurn: true });
    const fake = h.getFake();
    fake.push({ type: 'turn_complete' });
    const firstExit = await h.session.done();

    const turn = h.session.continueWith?.('fix it');
    fake.events.close(); // the process died mid-turn, with nobody having called stop()
    await expect(turn).resolves.toMatchObject({
      outcome: 'failed',
      reason: 'codex stream ended without completing a turn',
    });
    // done() is unaffected — still the first turn's exit.
    expect(await h.session.done()).toBe(firstExit);
  });

  it('a silent hang mid hand-back is torn down and fails the pending turn (RUN-201 x RUN-200)', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ multiTurn: true });
      const fake = h.getFake();
      fake.push({ type: 'turn_complete' });
      await h.session.done();

      const turn = h.session.continueWith?.('fix it');
      await vi.advanceTimersByTimeAsync(CODEX_SILENCE_TEARDOWN_MS + 1);
      expect(fake.closed).toBe(true);
      await expect(turn).resolves.toMatchObject({
        outcome: 'failed',
        reason: expect.stringContaining('silent'),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

/** A stand-in for the spawned `codex app-server` child: real streams (createInterface
 *  needs one), a recording stdin, and hand-fired lifecycle events. */
function makeFakeChild(writes: string[]) {
  const stdout = new PassThrough();
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdout,
    stderr: new PassThrough(),
    stdin: {
      write: (chunk: string) => {
        writes.push(chunk.trim());
        return true;
      },
      end: () => {},
    },
    on(event: string, cb: (...args: unknown[]) => void) {
      const listeners = handlers.get(event) ?? new Set();
      listeners.add(cb);
      handlers.set(event, listeners);
      return this;
    },
    kill: () => true,
    emitLine(line: string) {
      stdout.write(`${line}\n`);
    },
    emitError(err: Error) {
      for (const handler of handlers.get('error') ?? []) handler(err);
    },
    emitProcessExit(code: number | null = 0, signal: NodeJS.Signals | null = null) {
      this.exitCode = code;
      this.signalCode = signal;
      for (const handler of handlers.get('exit') ?? []) handler(code, signal);
    },
    emitExit(code: number | null = 0, signal: NodeJS.Signals | null = null) {
      this.emitProcessExit(code, signal);
      for (const handler of handlers.get('close') ?? []) handler(code, signal);
    },
  };
}

/** Complete RUN-290's effective-inventory gate after a fake thread/start response. */
async function answerMcpStatus(
  fakeChild: ReturnType<typeof makeFakeChild>,
  writes: string[],
  data: Array<{ name: string; tools: Record<string, unknown> }> = [],
  nextCursor: string | null = null,
): Promise<void> {
  await new Promise((r) => setImmediate(r));
  const request = writes
    .map((line) => JSON.parse(line))
    .findLast((frame) => frame.method === 'mcpServerStatus/list');
  expect(request).toBeTruthy();
  fakeChild.emitLine(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { data, nextCursor } }));
  await new Promise((r) => setImmediate(r));
}

describe('defaultSpawnCodex protocol handshake (regressions)', () => {
  // These cover the REAL transport, which every other codex test replaces with a fake —
  // which is exactly why both bugs below shipped.
  it('buffers the first turn until thread/start answers, instead of sending threadId: null', async () => {
    const { defaultSpawnCodex } = await import('../src/drivers/codex');
    const writes: string[] = [];
    const fakeChild = makeFakeChild(writes);
    const t = defaultSpawnCodex(
      { cwd: '/wt', sandbox: 'workspace-write', approvalPolicy: 'never', kind: 'build' },
      () => fakeChild as never,
    );

    // The driver calls this immediately, before any stdout has been read.
    t.sendUserTurn('do the work');
    const beforeThread = writes.filter((w) => w.includes('turn/start'));
    expect(beforeThread).toEqual([]); // must NOT have posted a null-threadId turn

    // thread/start's response finally arrives.
    fakeChild.emitLine(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { threadId: 'th_1' } }));
    await answerMcpStatus(fakeChild, writes);

    const turn = writes.find((w) => w.includes('turn/start'));
    expect(turn).toBeTruthy();
    expect(JSON.parse(turn as string).params.threadId).toBe('th_1'); // the real id
  });

  it('sends a VERSIONED clientInfo — codex 0.144.x rejects initialize without one (RUN-72)', async () => {
    const { defaultSpawnCodex } = await import('../src/drivers/codex');
    const { VERSION } = await import('../src/version');
    const writes: string[] = [];
    defaultSpawnCodex(
      { cwd: '/wt', sandbox: 'read-only', approvalPolicy: 'never', kind: 'verify' },
      () => makeFakeChild(writes) as never,
    );
    const init = JSON.parse(writes.find((w) => w.includes('"initialize"')) as string);
    expect(init.params.clientInfo.version).toBe(VERSION);
    expect(init.params.clientInfo.name).toBe('noriq-runner');
  });

  it('a JSON-RPC error RESPONSE fails the run instead of hanging it forever (RUN-72)', async () => {
    // The live failure: 0.144.5 rejected our initialize, thread/start then answered "Not
    // initialized" — and both rejections vanished, because an error response has neither
    // `result` nor `method`. threadId stayed null, the buffered turn never flushed, and the
    // reviewer sat at zero CPU for fifteen minutes while its run hung in `verifying`.
    const { defaultSpawnCodex } = await import('../src/drivers/codex');
    const fakeChild = makeFakeChild([]);
    const t = defaultSpawnCodex(
      { cwd: '/wt', sandbox: 'read-only', approvalPolicy: 'never', kind: 'verify' },
      () => fakeChild as never,
    );
    t.sendUserTurn('review the diff');
    fakeChild.emitLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32600, message: 'Invalid request: missing field `version`' },
      }),
    );
    for await (const ev of t.events) {
      expect(ev).toEqual({
        type: 'error',
        message: 'codex rejected a request: Invalid request: missing field `version`',
      });
      break;
    }
  });

  it('captures the 0.144.x thread/start shape ({thread:{id}}) and flushes the buffered turn (RUN-72)', async () => {
    const { defaultSpawnCodex } = await import('../src/drivers/codex');
    const writes: string[] = [];
    const fakeChild = makeFakeChild(writes);
    const t = defaultSpawnCodex(
      { cwd: '/wt', sandbox: 'workspace-write', approvalPolicy: 'never', kind: 'build' },
      () => fakeChild as never,
    );
    t.sendUserTurn('do the work');
    fakeChild.emitLine(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { thread: { id: 'th_144' } } }));
    await answerMcpStatus(fakeChild, writes);
    const turn = writes.find((w) => w.includes('turn/start'));
    expect(turn).toBeTruthy();
    expect(JSON.parse(turn as string).params.threadId).toBe('th_144');
  });

  it('a SECOND sendUserTurn — the continueWith mechanism (RUN-200) — posts turn/start on the SAME threadId', async () => {
    // The whole mechanism the fix rests on: `continueWith` is nothing but a second call to the
    // transport's `sendUserTurn` once the thread already exists, so it must post a real second
    // `turn/start` request against the SAME threadId — not a resume, not a fresh thread/start.
    const { defaultSpawnCodex } = await import('../src/drivers/codex');
    const writes: string[] = [];
    const fakeChild = makeFakeChild(writes);
    const t = defaultSpawnCodex(
      { cwd: '/wt', sandbox: 'workspace-write', approvalPolicy: 'never', kind: 'build' },
      () => fakeChild as never,
    );
    t.sendUserTurn('do the work');
    fakeChild.emitLine(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { threadId: 'th_live' } }));
    await answerMcpStatus(fakeChild, writes);
    const turnWrites = () => writes.filter((w) => w.includes('turn/start'));
    expect(turnWrites()).toHaveLength(1);

    fakeChild.emitLine(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: {} }));
    await new Promise((r) => setImmediate(r));

    t.sendUserTurn('fix the finding'); // continueWith's own call, once the fake driver awaits it
    expect(turnWrites()).toHaveLength(2);
    const [first, second] = turnWrites().map((w) => JSON.parse(w));
    expect(first.params.threadId).toBe('th_live');
    expect(second.params.threadId).toBe('th_live'); // the SAME live thread, the fix's whole point
    expect(second.params.input).toEqual([{ type: 'text', text: 'fix the finding' }]);
  });

  it('a rejected STEER is a shrug, not a verdict — the run keeps going (RUN-72)', async () => {
    // Steering has its own fallback (the notices channel re-delivers), so a steer the
    // app-server refuses must not fail the whole run the way a rejected handshake does.
    const { defaultSpawnCodex } = await import('../src/drivers/codex');
    const writes: string[] = [];
    const fakeChild = makeFakeChild(writes);
    const t = defaultSpawnCodex(
      { cwd: '/wt', sandbox: 'workspace-write', approvalPolicy: 'never', kind: 'build' },
      () => fakeChild as never,
    );
    fakeChild.emitLine(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { thread: { id: 'th_1' } } }));
    await answerMcpStatus(fakeChild, writes);
    expect(t.steer('also do X')).toBe(true);
    const steerId = JSON.parse(writes.find((w) => w.includes('turn/steer')) as string).id;
    fakeChild.emitLine(JSON.stringify({ jsonrpc: '2.0', id: steerId, error: { message: 'no active turn' } }));
    fakeChild.emitLine(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: {} }));
    for await (const ev of t.events) {
      expect(ev).toEqual({ type: 'turn_complete' }); // the steer rejection produced no event
      break;
    }
  });

  it('turns a missing codex binary into a run failure, not a daemon crash', async () => {
    const { defaultSpawnCodex } = await import('../src/drivers/codex');
    const fakeChild = makeFakeChild([]);
    const t = defaultSpawnCodex(
      { cwd: '/wt', sandbox: 'read-only', approvalPolicy: 'never', kind: 'verify' },
      () => fakeChild as never,
    );
    // spawn('codex') → ENOENT emits 'error'. With no listener Node rethrows it and the
    // WHOLE daemon dies, taking every concurrent Claude run with it.
    fakeChild.emitError(new Error('spawn codex ENOENT'));

    const seen: string[] = [];
    for await (const ev of t.events) if (ev.type === 'error') seen.push(ev.message);
    expect(seen[0]).toContain('ENOENT');
  });

  it('waits for direct process exit, escalating graceful tree stop to force', async () => {
    vi.useFakeTimers();
    try {
      const fakeChild = makeFakeChild([]);
      const forceCalls: boolean[] = [];
      const transport = defaultSpawnCodex(
        { cwd: '/wt', sandbox: 'read-only', approvalPolicy: 'never', kind: 'verify' },
        () => fakeChild as never,
        (_child, options) => {
          const force = options?.force ?? true;
          forceCalls.push(force);
          if (force) fakeChild.emitExit(null, 'SIGKILL');
        },
      );

      const closing = transport.close();
      expect(forceCalls).toEqual([false]);
      await vi.advanceTimersByTimeAsync(CODEX_GRACEFUL_STOP_MS);
      expect(forceCalls).toEqual([false, true]);
      await expect(closing).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects shutdown acknowledgement when the main process survives forced escalation', async () => {
    vi.useFakeTimers();
    try {
      const fakeChild = makeFakeChild([]);
      const forceCalls: boolean[] = [];
      const transport = defaultSpawnCodex(
        { cwd: '/wt', sandbox: 'read-only', approvalPolicy: 'never', kind: 'verify' },
        () => fakeChild as never,
        (_child, options) => forceCalls.push(options?.force ?? true),
      );

      const rejection = expect(transport.close()).rejects.toThrow(
        'codex process did not exit within 2000ms graceful plus 5000ms forced shutdown',
      );
      await vi.advanceTimersByTimeAsync(CODEX_GRACEFUL_STOP_MS + CODEX_FORCE_STOP_MS);
      await rejection;
      expect(forceCalls).toEqual([false, true]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not release the first turn until the effective MCP inventory is attested', async () => {
    const writes: string[] = [];
    const fakeChild = makeFakeChild(writes);
    const t = defaultSpawnCodex(
      {
        cwd: '/wt',
        sandbox: 'read-only',
        approvalPolicy: 'never',
        kind: 'verify',
        noriqMcp: { url: 'https://noriq.example/mcp', token: 'run-token' },
        noriqTools: ['get_task'],
      },
      () => fakeChild as never,
    );
    t.sendUserTurn('review');
    fakeChild.emitLine(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { thread: { id: 'th_gate' } } }));
    await new Promise((r) => setImmediate(r));
    expect(writes.some((line) => line.includes('turn/start'))).toBe(false);

    await answerMcpStatus(fakeChild, writes, [{ name: 'noriq', tools: { get_task: {} } }]);

    expect(writes.some((line) => line.includes('turn/start'))).toBe(true);
  });

  it('fails the MCP gate on a bounded deadline and never releases model work', async () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      const fakeChild = makeFakeChild(writes);
      const t = defaultSpawnCodex(
        { cwd: '/wt', sandbox: 'read-only', approvalPolicy: 'never', kind: 'scope' },
        () => fakeChild as never,
      );
      t.sendUserTurn('inspect');
      await vi.advanceTimersByTimeAsync(CODEX_MCP_ATTESTATION_TIMEOUT_MS);

      const seen: CodexEvent[] = [];
      for await (const event of t.events) seen.push(event);
      expect(seen.at(-1)).toEqual({
        type: 'error',
        message: expect.stringContaining('attestation exceeded'),
      });
      expect(writes.some((line) => line.includes('turn/start'))).toBe(false);
      t.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects repeated MCP cursors and oversized result sets', async () => {
    const cycleWrites: string[] = [];
    const cycleChild = makeFakeChild(cycleWrites);
    const cycle = defaultSpawnCodex(
      { cwd: '/wt', sandbox: 'read-only', approvalPolicy: 'never', kind: 'scope' },
      () => cycleChild as never,
    );
    cycle.sendUserTurn('inspect');
    cycleChild.emitLine(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { threadId: 'th_cycle' } }));
    await answerMcpStatus(cycleChild, cycleWrites, [], 'same');
    await answerMcpStatus(cycleChild, cycleWrites, [], 'same');
    const cycleEvents: CodexEvent[] = [];
    for await (const event of cycle.events) cycleEvents.push(event);
    expect(cycleEvents.at(-1)).toEqual({
      type: 'error',
      message: expect.stringContaining('repeated cursor'),
    });

    const resultWrites: string[] = [];
    const resultChild = makeFakeChild(resultWrites);
    const result = defaultSpawnCodex(
      { cwd: '/wt', sandbox: 'read-only', approvalPolicy: 'never', kind: 'scope' },
      () => resultChild as never,
    );
    result.sendUserTurn('inspect');
    resultChild.emitLine(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { threadId: 'th_many' } }));
    await answerMcpStatus(
      resultChild,
      resultWrites,
      Array.from({ length: CODEX_MCP_ATTESTATION_MAX_RESULTS + 1 }, (_, index) => ({
        name: `server-${index}`,
        tools: {},
      })),
    );
    const resultEvents: CodexEvent[] = [];
    for await (const event of result.events) resultEvents.push(event);
    expect(resultEvents.at(-1)).toEqual({
      type: 'error',
      message: expect.stringContaining('results'),
    });
  });

  it('fails closed when a project server exposes tools outside its exact grant', async () => {
    const writes: string[] = [];
    const fakeChild = makeFakeChild(writes);
    const t = defaultSpawnCodex(
      {
        cwd: '/wt',
        sandbox: 'workspace-write',
        approvalPolicy: 'never',
        kind: 'build',
        projectMcp: projectMcp(
          { simulator: { transport: 'stdio', command: 'sim', args: [], env: {} } },
          { simulator: ['inspect'] },
        ),
      },
      () => fakeChild as never,
    );
    t.sendUserTurn('build');
    fakeChild.emitLine(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { threadId: 'th_project_extra' } }));
    await answerMcpStatus(fakeChild, writes, [{ name: 'simulator', tools: { inspect: {}, mutate: {} } }]);

    const seen: CodexEvent[] = [];
    for await (const event of t.events) seen.push(event);
    expect(seen).toContainEqual({
      type: 'error',
      message:
        'codex MCP isolation failed: simulator tool inventory differs from its exact grant (expected [inspect], got [inspect, mutate])',
    });
    expect(writes.some((line) => line.includes('turn/start'))).toBe(false);
  });

  it('fails closed before turn/start when an inherited server appears', async () => {
    const writes: string[] = [];
    const fakeChild = makeFakeChild(writes);
    const t = defaultSpawnCodex(
      { cwd: '/wt', sandbox: 'read-only', approvalPolicy: 'never', kind: 'scope' },
      () => fakeChild as never,
    );
    t.sendUserTurn('inspect');
    fakeChild.emitLine(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { threadId: 'th_rogue' } }));
    await answerMcpStatus(fakeChild, writes, [{ name: 'codex_apps', tools: {} }]);

    const seen: CodexEvent[] = [];
    for await (const ev of t.events) seen.push(ev);
    expect(seen).toContainEqual({
      type: 'error',
      message: 'codex MCP isolation failed: expected servers [], got [codex_apps]',
    });
    expect(writes.some((line) => line.includes('turn/start'))).toBe(false);
  });

  it('fails closed when Noriq advertises anything outside the stage floor', async () => {
    const writes: string[] = [];
    const fakeChild = makeFakeChild(writes);
    const t = defaultSpawnCodex(
      {
        cwd: '/wt',
        sandbox: 'read-only',
        approvalPolicy: 'never',
        kind: 'verify',
        noriqMcp: { url: 'https://noriq.example/mcp', token: 'run-token' },
        noriqTools: ['get_task'],
      },
      () => fakeChild as never,
    );
    t.sendUserTurn('review');
    fakeChild.emitLine(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { threadId: 'th_tools' } }));
    await answerMcpStatus(fakeChild, writes, [{ name: 'noriq', tools: { get_task: {}, claim_task: {} } }]);

    const seen: CodexEvent[] = [];
    for await (const ev of t.events) seen.push(ev);
    expect(seen.at(-1)).toEqual({
      type: 'error',
      message:
        'codex MCP isolation failed: noriq tool inventory differs from the stage allowlist (expected 1, got 2)',
    });
    expect(writes.some((line) => line.includes('turn/start'))).toBe(false);
  });
});

describe('codex Noriq MCP wiring (RUN-43)', () => {
  // The bug this covers was invisible: the driver spawned codex with NO mcp config while the
  // prompt ordered it to register against a server it had no connection to. So every codex
  // agent was anonymous and un-attributable, and nothing errored. Every other codex test
  // swaps in a fake transport, which is exactly why it survived — so assert the real spawn.
  const spawnArgs = (
    noriqMcp?: { url: string; token: string },
    extra: { model?: string; effort?: RunEffort; kind?: RunKind } = {},
  ) => {
    let seen!: { cmd: string; args: string[]; opts: { env: NodeJS.ProcessEnv } };
    const spy = ((cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      seen = { cmd, args, opts };
      return makeFakeChild([]) as never;
    }) as never;
    defaultSpawnCodex(
      {
        cwd: '/wt',
        sandbox: 'workspace-write',
        approvalPolicy: 'never',
        kind: extra.kind ?? 'build',
        noriqMcp,
        ...extra,
      },
      spy,
    );
    return seen;
  };

  it('passes the MCP server as per-spawn -c overrides, never touching the user\u2019s config', () => {
    const { cmd, args } = spawnArgs({ url: 'https://noriq.example/mcp', token: 'plnrt_run_bound' });
    expect(cmd).toBe('codex');
    expect(args[0]).toBe('app-server');
    expect(args).toContain('mcp_servers.noriq.url="https://noriq.example/mcp"');
    expect(args).toContain('mcp_servers.noriq.bearer_token_env_var=NORIQ_MCP_TOKEN');
    // `codex mcp add` writes into the human's own ~/.codex/config.toml — the daemon must not
    // reconfigure their codex behind their back, so the wiring stays per-spawn.
    expect(args.join(' ')).not.toContain('mcp add');
  });

  it('gives codex its bearer token in the env, because codex offers no header option', () => {
    const { opts } = spawnArgs({ url: 'https://noriq.example/mcp', token: 'plnrt_run_bound' });
    expect(opts.env.NORIQ_MCP_TOKEN).toBe('plnrt_run_bound');
    // Still the hardened env: the DAEMON's own token and git creds stay out regardless. The
    // token here is per-run and dies with the run, which is what makes this trade payable.
    expect(opts.env.NORIQ_TOKEN).toBeUndefined();
    expect(opts.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(opts.env.CODEX_HOME).toBe(DEFAULT_CODEX_HOME);
  });

  it('overrides an inherited CODEX_HOME and disables ambient app/plugin capabilities', () => {
    let seen!: { args: string[]; env: NodeJS.ProcessEnv };
    defaultSpawnCodex(
      {
        cwd: '/wt',
        sandbox: 'read-only',
        approvalPolicy: 'never',
        kind: 'scope',
        codexHome: '/noriq/codex',
        env: { CODEX_HOME: '/operator/codex' },
      },
      ((_cmd: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        seen = { args, env: options.env };
        return makeFakeChild([]) as never;
      }) as never,
    );

    expect(seen.env.CODEX_HOME).toBe('/noriq/codex');
    for (const feature of ['apps', 'plugins', 'remote_plugin', 'skill_mcp_dependency_install']) {
      expect(seen.args).toContain(feature);
    }
  });

  it('leaks no Noriq token into the env when there is no MCP to wire', () => {
    const { args, opts } = spawnArgs(undefined);
    expect(args[0]).toBe('app-server');
    expect(args).toEqual(
      expect.arrayContaining([
        '--disable',
        'apps',
        'plugins',
        'remote_plugin',
        'skill_mcp_dependency_install',
      ]),
    );
    expect(opts.env.NORIQ_MCP_TOKEN).toBeUndefined();
  });

  it('passes model + effort as per-spawn -c overrides too (RUN-33)', () => {
    const { args } = spawnArgs(undefined, { model: 'gpt-5.3-codex', effort: 'low' });
    expect(args).toContain('model="gpt-5.3-codex"');
    expect(args).toContain('model_reasoning_effort=low');
    // Same reason as the MCP wiring above: writing these to ~/.codex/config.toml would
    // reconfigure the human's own codex behind their back.
    expect(args[0]).toBe('app-server');
  });

  it('TOML-quotes model and Noriq URL values instead of allowing config injection', () => {
    const { args } = spawnArgs(
      { url: 'https://noriq.example/mcp\nrequired=false', token: 'run-token' },
      { model: 'safe\nmodel="escape"' },
    );
    expect(args).toContain('mcp_servers.noriq.url="https://noriq.example/mcp\\nrequired=false"');
    expect(args).toContain('model="safe\\nmodel=\\"escape\\""');
    expect(args).not.toContain('model=safe\nmodel="escape"');
  });

  it('marks the injected Noriq server required so auth/startup failures stop the thread', () => {
    const { args } = spawnArgs({ url: 'https://noriq.example/mcp', token: 'run-token' });
    expect(args).toContain('mcp_servers.noriq.required=true');
  });

  it('translates generic project servers through safe per-spawn TOML values', () => {
    let seen!: { args: string[] };
    defaultSpawnCodex(
      {
        cwd: '/wt',
        sandbox: 'workspace-write',
        approvalPolicy: 'never',
        kind: 'build',
        projectMcp: projectMcp(
          {
            simulator: {
              transport: 'stdio',
              command: 'node',
              args: ['tool with space.js', 'quote"value'],
              env: { PROJECT_PATH: '/wt/a project' },
            },
            docs: {
              transport: 'http',
              url: 'https://docs.test/mcp?x=one two',
              headers: { 'X-Profile': 'project one' },
            },
          },
          { simulator: ['inspect', 'mutate'], docs: ['search'] },
        ),
      },
      ((_cmd: string, args: string[]) => {
        seen = { args };
        return makeFakeChild([]) as never;
      }) as never,
    );

    expect(seen.args).toContain(`mcp_servers.simulator.command=${JSON.stringify(process.execPath)}`);
    expect(seen.args).toContain('mcp_servers.simulator.args=["tool with space.js","quote\\"value"]');
    const projectEnv = seen.args.find((arg) => arg.startsWith('mcp_servers.simulator.env='));
    expect(projectEnv).toContain('"PROJECT_PATH"="/wt/a project"');
    expect(projectEnv).toContain('"HOME"="/tmp/noriq-project-mcp"');
    expect(projectEnv).toContain('"NORIQ_MCP_TOKEN"=""');
    expect(seen.args).toContain('mcp_servers.simulator.required=true');
    expect(seen.args).toContain('mcp_servers.simulator.enabled_tools=["inspect","mutate"]');
    expect(seen.args).toContain('mcp_servers.docs.url="https://docs.test/mcp?x=one two"');
    expect(seen.args).toContain('mcp_servers.docs.http_headers={"X-Profile"="project one"}');
    expect(seen.args).toContain('mcp_servers.docs.required=true');
    expect(seen.args).toContain('mcp_servers.docs.enabled_tools=["search"]');
  });

  it.each([
    ['empty', { simulator: [] }],
    ['mismatched', { other: ['inspect'] }],
  ])('rejects %s project tool grants before spawning codex', (_case, toolGrants) => {
    expect(() =>
      defaultSpawnCodex(
        {
          cwd: '/wt',
          sandbox: 'workspace-write',
          approvalPolicy: 'never',
          kind: 'build',
          projectMcp: projectMcp(
            { simulator: { transport: 'stdio', command: 'sim', args: [], env: {} } },
            toolGrants,
          ),
        },
        (() => {
          throw new Error('must not spawn');
        }) as never,
      ),
    ).toThrow('invalid project MCP session');
  });

  it('configures only the project servers granted to this codex session', () => {
    let seen: string[] = [];
    defaultSpawnCodex(
      {
        cwd: '/wt',
        sandbox: 'read-only',
        approvalPolicy: 'never',
        kind: 'verify',
        projectMcp: projectMcp(
          {
            editor: { transport: 'stdio', command: 'edit', args: [], env: {} },
            inspector: { transport: 'stdio', command: 'inspect', args: [], env: {} },
          },
          { inspector: ['read_state'] },
        ),
      },
      ((_cmd: string, args: string[]) => {
        seen = args;
        return makeFakeChild([]);
      }) as never,
    );
    expect(seen.some((arg) => arg.startsWith('mcp_servers.editor.'))).toBe(false);
    expect(seen).toContain('mcp_servers.inspector.enabled_tools=["read_state"]');
  });

  it('says nothing when nobody chose — codex keeps its own default (RUN-33)', () => {
    // The pre-RUN-33 behaviour, and the assertion that keeps it: an unset run must not be
    // silently pinned to whatever we would have guessed.
    const { args } = spawnArgs(undefined, {});
    expect(args.join(' ')).not.toContain('model=');
    expect(args.join(' ')).not.toContain('model_reasoning_effort');
  });

  it('clamps an effort codex cannot do, rather than passing it through (RUN-33)', () => {
    // codex-cli 0.142.4 accepts ANY value for this key at parse time — a bogus one does not
    // fail the spawn. So passing 'xhigh' through would not error here; it would surface as an
    // API failure mid-run, after the tokens were spent.
    const { args } = spawnArgs(undefined, { effort: 'xhigh' });
    expect(args).toContain('model_reasoning_effort=high');
    expect(args.join(' ')).not.toContain('xhigh');
  });
});

describe('mapEffort: intent → codex\u2019s own scale (RUN-33)', () => {
  it('passes through what codex shares with the SDK', () => {
    expect(mapEffort('low')).toBe('low');
    expect(mapEffort('medium')).toBe('medium');
    expect(mapEffort('high')).toBe('high');
  });

  it('clamps the two levels above codex\u2019s ceiling', () => {
    // "Think as hard as you can" is the honest reading of xhigh/max on a backend whose top is
    // high — and it is what the Claude SDK itself does for a model that cannot go that far.
    expect(mapEffort('xhigh')).toBe('high');
    expect(mapEffort('max')).toBe('high');
  });
});

describe('the per-kind Noriq tool floor reaches codex (RUN-46)', () => {
  // Before this, noriqToolsFor lived in drivers/claude.ts and NOTHING else read it — the
  // per-kind floor was quietly a property of one driver. A codex VERIFY agent had every tool
  // the server advertises, claim_task included: the reviewer could move the work it judges.
  const spawnFor = (kind: RunKind) => {
    let seen!: { args: string[] };
    const spy = ((_cmd: string, args: string[]) => {
      seen = { args };
      return makeFakeChild([]) as never;
    }) as never;
    defaultSpawnCodex(
      {
        cwd: '/wt',
        sandbox: 'read-only',
        approvalPolicy: 'never',
        kind,
        noriqMcp: { url: 'https://noriq.example/mcp', token: 't' },
      },
      spy,
    );
    return seen.args;
  };

  const enabledTools = (args: string[]): string[] => {
    const arg = args.find((a) => a.startsWith('mcp_servers.noriq.enabled_tools='));
    expect(arg).toBeTruthy();
    return JSON.parse((arg as string).slice('mcp_servers.noriq.enabled_tools='.length));
  };

  it('mirrors the claude floor exactly, per kind — one policy, two enforcements', () => {
    for (const kind of ['scope', 'build', 'verify'] as const) {
      // noriqToolsFor is claude-prefixed; strip the prefix to compare the POLICY.
      const claudeFloor = noriqToolsFor(kind).map((t) => t.replace(/^mcp__noriq__/, ''));
      expect(enabledTools(spawnFor(kind)).sort()).toEqual([...claudeFloor].sort());
    }
  });

  it('a verify agent cannot claim, release, or update — the gate it exists to hold', () => {
    const tools = enabledTools(spawnFor('verify'));
    for (const denied of ['claim_task', 'release_task', 'update_task', 'create_plan']) {
      expect(tools).not.toContain(denied);
    }
    // But it CAN reach a human (RUN-32) — rationing that pushes agents toward guessing.
    expect(tools).toContain('raise_alert');
    expect(tools).toContain('request_input');
    // And it CAN spin off work the diff surfaces that is not this task's (RUN-188) — inert
    // until a human accepts it, so the grant still cannot MOVE the work being judged. Not
    // create_task by another name: that one stays absent.
    expect(tools).toContain('spin_off_task');
    expect(tools).not.toContain('create_task');
  });

  it('no MCP config → no enabled_tools either (nothing to filter)', () => {
    let seen!: { args: string[] };
    const spy = ((_cmd: string, args: string[]) => {
      seen = { args };
      return makeFakeChild([]) as never;
    }) as never;
    defaultSpawnCodex({ cwd: '/wt', sandbox: 'read-only', approvalPolicy: 'never', kind: 'scope' }, spy);
    expect(seen.args.some((a) => a.includes('enabled_tools'))).toBe(false);
  });
});
