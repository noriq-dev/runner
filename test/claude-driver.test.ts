import { realpathSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PermissionProfile } from '@noriq-dev/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLAUDE_HOME } from '../src/agent-homes';
import { AsyncQueue } from '../src/async-queue';
import {
  ClaudeDriver,
  NORIQ_MCP_NAME,
  type QueryFn,
  type SdkMessage,
  type SdkQueryOptions,
  type SdkUserMessage,
  mapPermission,
  noriqToolsFor,
  resolveClaudeAgentSdkInstallation,
} from '../src/drivers/claude';
import type { DriverStartOptions, DriverTelemetry, ProjectMcpSession } from '../src/drivers/types';
import type {
  AgentProcessContainment,
  AgentProcessLaunch,
  ContainedAgentProcess,
} from '../src/process-containment';
import { type ProjectMcpBundle, bindProjectMcpBundle, loadProjectMcpBundle } from '../src/project-mcp';

// A controllable stand-in for the Agent SDK Query: captures the streamed input
// turns + options, lets the test push scripted stream-json messages, and records
// interrupt/close.
class FakeQuery {
  received: SdkUserMessage[] = [];
  interrupted = 0;
  closed = false;
  options: unknown;
  private readonly emit = new AsyncQueue<SdkMessage>();
  private streamFailure: Error | null = null;
  constructor(prompt: AsyncIterable<SdkUserMessage>, options: unknown) {
    this.options = options;
    void (async () => {
      for await (const m of prompt) this.received.push(m);
    })();
  }
  push(msg: SdkMessage): void {
    this.emit.push(msg);
  }
  endStream(): void {
    this.emit.close();
  }
  failStream(error: Error): void {
    this.streamFailure = error;
    this.emit.close();
  }
  async interrupt(): Promise<unknown> {
    this.interrupted += 1;
    return undefined;
  }
  close(): void {
    this.closed = true;
  }
  async initializationResult(): Promise<unknown> {
    return {};
  }
  async mcpServerStatus(): Promise<
    Array<{
      name: string;
      status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
      tools?: Array<{ name: string }>;
    }>
  > {
    const servers = (this.options as SdkQueryOptions | undefined)?.mcpServers ?? {};
    const allowed = (this.options as SdkQueryOptions | undefined)?.allowedTools ?? [];
    return Object.keys(servers).map((name) => ({
      name,
      status: 'connected',
      tools: allowed
        .filter((tool) => tool.startsWith(`mcp__${name}__`))
        .map((tool) => ({ name: tool.slice(`mcp__${name}__`.length) })),
    }));
  }
  async *[Symbol.asyncIterator](): AsyncIterator<SdkMessage> {
    yield* this.emit;
    if (this.streamFailure) throw this.streamFailure;
  }
}

const testClaudeDriver = (deps: ConstructorParameters<typeof ClaudeDriver>[0] = {}): ClaudeDriver =>
  new ClaudeDriver({
    reattestProjectMcpExecutables: () => Object.freeze([]),
    createAttemptHome: () => ({ home: '/tmp/noriq-test-claude-attempt', cleanup() {} }),
    ...deps,
  });

const profile = (over: Partial<PermissionProfile> = {}): PermissionProfile => ({
  write: false,
  allow: [],
  deny: [],
  auto: false,
  ...over,
});

const unusedTestContainment: AgentProcessContainment = {
  capabilities: {
    processTreeTermination: true,
    ownerDeathTermination: true,
    workspaceIsolation: true,
    protectedWorkspaceSubpaths: true,
    projectMcpProcessContainment: true,
  },
  async probe() {},
  spawn() {
    throw new Error('this settings-source test must not invoke the SDK process seam');
  },
};

const commissionedTokenContainment: AgentProcessContainment = {
  ...unusedTestContainment,
  capabilities: {
    ...unusedTestContainment.capabilities,
    providerCredentialIsolation: true,
    hostResourceIsolation: true,
    networkEgressIsolation: true,
    immutableRuntimeAuthority: true,
    providerTokenEnvelope: true,
  },
  authorityFingerprint: `sha256:${'b'.repeat(64)}`,
  assertAuthority: async () => undefined,
};

function harness(startOver: Partial<DriverStartOptions> = {}) {
  let fake!: FakeQuery;
  const queryFn: QueryFn = (args) => {
    fake = new FakeQuery(args.prompt, args.options);
    return fake;
  };
  const telemetry: DriverTelemetry[] = [];
  const texts: string[] = [];
  const driver = testClaudeDriver({ queryFn, prepareClaudeHome: () => {} });
  const session = driver.start({
    runId: 'run_1',
    kind: 'build',
    cwd: '/wt',
    prompt: 'do the thing',
    permission: profile({ write: true }),
    handlers: {
      onText: (t) => texts.push(t),
      onTelemetry: (t) => telemetry.push(t),
    },
    ...startOver,
  });
  return { session, telemetry, texts, getFake: () => fake };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
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

afterEach(() => vi.restoreAllMocks());

describe('driver capabilities (RUN-110)', () => {
  it('claude declares in-process hooks, steer, resume, and per-model telemetry', () => {
    const driver = testClaudeDriver({ queryFn: (() => undefined) as unknown as QueryFn });
    expect(driver.tool).toBe('claude');
    expect(driver.capabilities).toEqual({
      toolHooks: true,
      steer: true,
      interrupt: true,
      resumableSession: true,
      perModelTelemetry: true,
      toolFreeSession: true,
      workspaceIsolatedSession: false,
      projectMcpProcessContainment: false,
      terminationAcknowledgement: 'none',
    });
  });
});

describe('Runner-specific Claude home (RUN-291)', () => {
  it('prepares the isolated home and loads only its user settings source', () => {
    const prepared: string[] = [];
    let options: SdkQueryOptions | undefined;
    const driver = testClaudeDriver({
      claudeHome: '/runner/claude',
      prepareClaudeHome: (home) => prepared.push(home),
      queryFn: (args) => {
        options = args.options;
        return new FakeQuery(args.prompt, args.options);
      },
    });
    driver.start({
      runId: 'run_home',
      kind: 'scope',
      cwd: '/wt',
      prompt: 'inspect',
      permission: profile(),
      env: { CLAUDE_CONFIG_DIR: '/operator/claude' },
    });

    expect(prepared).toEqual(['/runner/claude']);
    expect(options?.env?.CLAUDE_CONFIG_DIR).toBe('/runner/claude');
    expect(options?.settingSources).toEqual(['user']);
    expect(options?.strictMcpConfig).toBe(true);
  });

  it('keeps resumed sessions inside the same Runner-specific home', () => {
    const h = harness({ resumeSessionId: 'session_parked' });
    const options = h.getFake().options as SdkQueryOptions;

    expect(options.resume).toBe('session_parked');
    expect(options.env?.CLAUDE_CONFIG_DIR).toBe(DEFAULT_CLAUDE_HOME);
    expect(options.settingSources).toEqual(['user']);
  });

  it('loads no mutable filesystem settings for a contained mission session', () => {
    let options: SdkQueryOptions | undefined;
    const driver = testClaudeDriver({
      claudeHome: '/runner/claude',
      prepareClaudeHome: () => undefined,
      containment: unusedTestContainment,
      queryFn: (args) => {
        options = args.options;
        return new FakeQuery(args.prompt, args.options);
      },
    });
    driver.start({
      runId: 'mission_home',
      kind: 'scope',
      cwd: '/wt',
      workspaceRoot: '/wt',
      prompt: 'inspect',
      permission: profile(),
    });

    expect(options?.settingSources).toEqual([]);
    expect(options?.strictMcpConfig).toBe(true);
    expect(options?.env?.HOME).toBe('/tmp/noriq-test-claude-attempt');
    expect(options?.env?.CLAUDE_CONFIG_DIR).toBe('/tmp/noriq-test-claude-attempt');
    expect(options?.env?.CLAUDE_CONFIG_DIR).not.toBe('/runner/claude');
    const installation = resolveClaudeAgentSdkInstallation();
    expect(options?.pathToClaudeCodeExecutable).toBe(installation.executablePath);
    expect(installation.nativePackageName).toContain(`-${process.platform}-${process.arch}`);
    expect(path.isAbsolute(installation.sdkEntryPath)).toBe(true);
  });

  it('mounts unique credential-only mission homes and cleans each only after tree exit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noriq-claude-attempt-home-'));
    const exits: Array<ReturnType<typeof deferred>> = [];
    const attemptHomes: string[] = [];
    try {
      const durableHome = path.join(root, 'durable');
      const workspace = path.join(root, 'workspace');
      await Promise.all([mkdir(path.join(durableHome, 'sessions'), { recursive: true }), mkdir(workspace)]);
      await Promise.all([
        writeFile(path.join(durableHome, '.credentials.json'), '{"token":"claude-secret"}', {
          mode: 0o600,
        }),
        writeFile(path.join(durableHome, '.claude.json'), '{"ambient":true}'),
        writeFile(path.join(durableHome, 'sessions', 'prior.jsonl'), 'prior session'),
      ]);

      const launches: AgentProcessLaunch[] = [];
      const children: Array<{ exitCode: number | null; signalCode: NodeJS.Signals | null }> = [];
      const containment: AgentProcessContainment = {
        ...commissionedTokenContainment,
        spawn(request): ContainedAgentProcess {
          launches.push(request);
          const exit = deferred();
          const child = {
            exitCode: null as number | null,
            signalCode: null as NodeJS.Signals | null,
            kill: vi.fn(() => true),
          };
          exits.push(exit);
          children.push(child);
          return {
            child: child as never,
            exited: exit.promise,
            terminate: () => {},
          };
        },
      };
      const queryFn: QueryFn = ({ prompt, options }) => {
        const query = new FakeQuery(prompt, options);
        if (!options?.spawnClaudeCodeProcess || !options.pathToClaudeCodeExecutable) {
          throw new Error('missing managed Claude process seam');
        }
        options.spawnClaudeCodeProcess({
          command: options.pathToClaudeCodeExecutable,
          args: [],
          cwd: workspace,
          env: options.env ?? {},
          signal: new AbortController().signal,
        });
        return query;
      };
      const driver = new ClaudeDriver({
        claudeHome: durableHome,
        containment,
        queryFn,
        reattestProjectMcpExecutables: () => Object.freeze([]),
      });

      for (const runId of ['claude-attempt-1', 'claude-attempt-2']) {
        driver.start({
          runId,
          kind: 'build',
          cwd: workspace,
          workspaceRoot: workspace,
          prompt: 'work',
          permission: profile({ write: true }),
          tokenEnvelope: { totalTokens: 1_024, maxTurns: 4 },
        });
      }

      expect(launches).toHaveLength(2);
      for (const [index, launch] of launches.entries()) {
        const attemptHome = launch.providerCredentialRoots?.[0];
        expect(attemptHome).toBeTruthy();
        attemptHomes.push(attemptHome as string);
        expect(launch.providerCredentialRoots).toEqual([attemptHome]);
        expect(launch.privateWriteRoots).toBeUndefined();
        expect(launch.providerTokenEnvelope).toEqual({ totalTokens: 1_024, maxTurns: 4 });
        expect(launch.providerCredentialRoots).not.toContain(durableHome);
        expect(launch.env.HOME).toBe(attemptHome);
        expect(launch.env.CLAUDE_CONFIG_DIR).toBe(attemptHome);
        expect(await readdir(attemptHome as string)).toEqual(['.credentials.json']);
        expect(await readFile(path.join(attemptHome as string, '.credentials.json'), 'utf8')).toBe(
          '{"token":"claude-secret"}',
        );

        // The direct vendor child may exit before the containment provider has reaped its tree.
        children[index]!.exitCode = 0;
        await expect(stat(attemptHome as string)).resolves.toBeTruthy();
      }
      expect(attemptHomes[0]).not.toBe(attemptHomes[1]);

      for (const exit of exits) exit.resolve();
      await tick();
      for (const attemptHome of attemptHomes) {
        await expect(stat(attemptHome)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      for (const exit of exits) exit.resolve();
      await tick();
      await Promise.all(attemptHomes.map((home) => rm(home, { recursive: true, force: true })));
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cleans an attempt seed when the SDK exits before launching a contained process', async () => {
    const cleanup = vi.fn();
    let fake!: FakeQuery;
    const driver = testClaudeDriver({
      containment: unusedTestContainment,
      createAttemptHome: () => ({ home: '/tmp/noriq-unused-claude-attempt', cleanup }),
      queryFn: ({ prompt, options }) => {
        fake = new FakeQuery(prompt, options);
        return fake;
      },
    });
    driver.start({
      runId: 'claude-no-process',
      kind: 'scope',
      cwd: '/wt',
      workspaceRoot: '/wt',
      prompt: 'inspect',
      permission: profile(),
    });

    fake.endStream();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
  });
});

describe('mapPermission', () => {
  it('scope (read-only) allows read tools, disallows Edit/Bash, dontAsk', () => {
    const p = mapPermission(profile({ write: false }), 'scope');
    expect(p.permissionMode).toBe('dontAsk');
    expect(p.allowedTools).toContain('Read');
    expect(p.allowedTools).not.toContain('Edit');
    expect(p.allowedTools).not.toContain('Bash');
    expect(p.disallowedTools).toContain('Edit');
    expect(p.disallowedTools).toContain('Bash');
  });

  it('build allows edit tools + the manifest bash allowlist, never bare Bash', () => {
    const p = mapPermission(profile({ write: true, allow: ['Bash(npm test:*)'] }), 'build');
    expect(p.allowedTools).toEqual(expect.arrayContaining(['Read', 'Edit', 'Write', 'Bash(npm test:*)']));
    expect(p.allowedTools).not.toContain('Bash'); // bare bash is never granted
    expect(p.disallowedTools).not.toContain('Edit');
  });
});

describe('ClaudeDriver', () => {
  it('enforces a tool-free inference turn for the mission guide', async () => {
    const h = harness({
      kind: 'scope',
      permission: profile(),
      toolAccess: 'none',
      noriqTools: [],
    });
    await tick();

    const options = h.getFake().options as SdkQueryOptions;
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual([]);
    expect(options.disallowedTools).toEqual(['mcp__*']);
    expect(options.mcpServers).toBeUndefined();
    expect(h.getFake().received.map((message) => message.message.content)).toEqual(['do the thing']);
  });

  it('passes a finite mission envelope to both the commissioned broker and SDK defenses', async () => {
    let options: SdkQueryOptions | undefined;
    let queries = 0;
    const productionCapabilityDriver = testClaudeDriver({
      containment: commissionedTokenContainment,
      prepareClaudeHome: () => undefined,
    });
    expect(productionCapabilityDriver.capabilities).toMatchObject({
      hardTokenEnvelope: true,
      commissionedExecutionBoundary: true,
    });
    const driver = testClaudeDriver({
      containment: commissionedTokenContainment,
      prepareClaudeHome: () => undefined,
      queryFn: ({ prompt, options: received }) => {
        queries += 1;
        options = received;
        const query = new FakeQuery(prompt, received);
        query.endStream();
        return query;
      },
    });
    expect(driver.capabilities.hardTokenEnvelope).toBeUndefined();
    driver.start({
      runId: 'mission-token-envelope',
      kind: 'build',
      cwd: '/wt',
      workspaceRoot: '/wt',
      prompt: 'bounded work',
      permission: profile({ write: true }),
      tokenEnvelope: { totalTokens: 1_024, maxTurns: 4 },
    });
    await tick();

    expect(queries).toBe(1);
    expect(options).toMatchObject({
      maxTurns: 4,
      taskBudget: { total: 1_024 },
      disallowedTools: expect.arrayContaining(['Agent', 'Task']),
    });

    expect(() =>
      driver.start({
        runId: 'mission-native-delegation',
        kind: 'build',
        cwd: '/wt',
        workspaceRoot: '/wt',
        prompt: 'must not launch',
        permission: profile({ write: true, allow: ['Agent'] }),
        tokenEnvelope: { totalTokens: 1_024, maxTurns: 4 },
      }),
    ).toThrow(/native delegation is unavailable/);
    expect(queries).toBe(1);
  });

  it('rejects MCP authority on a tool-free inference turn before querying the model', () => {
    expect(() =>
      harness({
        toolAccess: 'none',
        projectMcp: projectMcp(
          { simulator: { transport: 'stdio', command: 'sim', args: [], env: {} } },
          { simulator: ['inspect'] },
        ),
      }),
    ).toThrow('tool-free Claude sessions may not receive MCP authority');
  });

  it('refuses a requested mission workspace boundary it cannot attest', () => {
    expect(() => harness({ workspaceRoot: '/wt' })).toThrow('cannot attest mission workspace isolation');
  });

  it('refuses an SDK spawn command that differs from the forced native mission executable', () => {
    const containmentSpawn = vi.fn(() => {
      throw new Error('containment must not receive an unbound executable');
    });
    const installation = resolveClaudeAgentSdkInstallation();
    const driver = testClaudeDriver({
      containment: { ...unusedTestContainment, spawn: containmentSpawn },
      claudeCodeExecutable: installation.executablePath,
      prepareClaudeHome: () => undefined,
      queryFn: ({ options }) => {
        if (!options?.spawnClaudeCodeProcess) throw new Error('missing SDK process seam');
        options.spawnClaudeCodeProcess({
          command: process.execPath,
          args: [],
          cwd: '/wt',
          env: {},
          signal: new AbortController().signal,
        });
        throw new Error('unexpected SDK callback return');
      },
    });

    expect(() =>
      driver.start({
        runId: 'mission_wrong_claude',
        kind: 'scope',
        cwd: '/wt',
        workspaceRoot: '/wt',
        prompt: 'must not run',
        permission: profile(),
      }),
    ).toThrow('Claude SDK changed the attested mission executable before spawn');
    expect(containmentSpawn).not.toHaveBeenCalled();
  });

  it('rejects combining project and Noriq MCP authority before querying the model', () => {
    expect(() =>
      harness({
        noriqMcp: { url: 'https://noriq.test/mcp', token: 'token' },
        projectMcp: projectMcp(
          { simulator: { transport: 'stdio', command: 'sim', args: [], env: {} } },
          { simulator: ['inspect'] },
        ),
      }),
    ).toThrow('may not combine project MCP authority with Noriq MCP authority');
  });

  it('runs the brief, streams text, parses result telemetry, resolves done', async () => {
    const h = harness();
    const fake = h.getFake();
    fake.push({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'working…' }],
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    });
    fake.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 2,
      total_cost_usd: 0.0123,
      usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 500 },
    });
    const exit = await h.session.done();
    expect(exit.outcome).toBe('done');
    expect(exit.isError).toBe(false);
    expect(exit.telemetry).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 500,
      cacheCreationTokens: 0,
      costUsd: 0.0123,
      numTurns: 2,
    });
    expect(h.texts).toContain('working…');
    expect(fake.closed).toBe(true); // session closed on finish
  });

  it('streams raw text deltas byte-faithfully, keeping newlines the assembled message drops (RUN-77)', async () => {
    const h = harness();
    const fake = h.getFake();
    // The model's real bytes: a sentence, a newline, another sentence, then a bulleted list —
    // arriving as deltas, some split mid-word (as the SDK does). The newline between sentences
    // is its OWN emission, exactly where the assembled message used to lose it.
    const deltas = [
      'I’ll review the diff.',
      '\n',
      'The changed wizard now.',
      '\n- High — VCS detec',
      'tion contradicts it.',
    ];
    for (const text of deltas) {
      fake.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
      });
    }
    // A thinking delta must NOT reach the transcript as agent prose.
    fake.push({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', text: 'hmm, let me think' } },
    });
    // The assembled message follows (its content joins blocks with '' — the lossy path).
    // Because deltas streamed this turn, it contributes usage only, never re-emitted text.
    fake.push({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: 'I’ll review the diff.The changed wizard now.- High — VCS detection contradicts it.',
          },
        ],
        usage: { input_tokens: 10, output_tokens: 30 },
      },
    });
    fake.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      total_cost_usd: 0.001,
      usage: { input_tokens: 10, output_tokens: 30 },
    });

    await h.session.done();
    const joined = h.texts.join('');
    // Byte-faithful: every newline survives, so the bullet starts its own line.
    expect(joined).toBe(
      'I’ll review the diff.\nThe changed wizard now.\n- High — VCS detection contradicts it.',
    );
    expect(joined).not.toContain('diff.The'); // the clump the old assembled path produced
    expect(joined).not.toContain('let me think'); // thinking stays out of the transcript
  });

  it('separates distinct assistant turns with a paragraph break (RUN-80)', async () => {
    const h = harness();
    const fake = h.getFake();
    const delta = (text: string) =>
      fake.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
      });
    const turnEnd = (text: string) =>
      fake.push({
        type: 'assistant',
        message: { content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } },
      });

    // Turn 1 streams, ends; tool work happens; turn 2 streams, ends. The model emits no
    // newline between turns — the driver inserts the paragraph break chat UIs render.
    delta('Let me read the SDK behavior.');
    turnEnd('Let me read the SDK behavior.');
    delta('Now I have a complete picture.');
    turnEnd('Now I have a complete picture.');
    // A tool_use-only turn (no text) must not stack a second break.
    fake.push({
      type: 'assistant',
      message: { content: [{ type: 'tool_use' }], usage: { input_tokens: 1, output_tokens: 1 } },
    });
    delta('Now the wire frame:');
    turnEnd('Now the wire frame:');
    fake.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 3,
      total_cost_usd: 0,
      usage: { input_tokens: 3, output_tokens: 3 },
    });

    await h.session.done();
    expect(h.texts.join('')).toBe(
      'Let me read the SDK behavior.\n\nNow I have a complete picture.\n\nNow the wire frame:',
    );
  });

  it('separates turns on the no-deltas fallback path too (RUN-80)', async () => {
    const h = harness();
    const fake = h.getFake();
    const turn = (text: string) =>
      fake.push({
        type: 'assistant',
        message: { content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } },
      });
    turn('First turn.');
    turn('Second turn.');
    fake.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 2,
      total_cost_usd: 0,
      usage: { input_tokens: 2, output_tokens: 2 },
    });
    await h.session.done();
    expect(h.texts.join('')).toBe('First turn.\n\nSecond turn.');
  });

  it('falls back to the assembled message text when a turn streamed no deltas', async () => {
    const h = harness();
    const fake = h.getFake();
    fake.push({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'no-partials transport' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    fake.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await h.session.done();
    expect(h.texts.join('')).toBe('no-partials transport');
  });

  it('requests partial messages so the raw delta stream is available', async () => {
    const h = harness();
    h.getFake().push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 0,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    await h.session.done();
    expect((h.getFake().options as { includePartialMessages?: boolean }).includePartialMessages).toBe(true);
  });

  it('maps an error result to a failed outcome with the subtype as reason', async () => {
    const h = harness();
    h.getFake().push({
      type: 'result',
      subtype: 'error_max_budget_usd',
      is_error: true,
      num_turns: 5,
      total_cost_usd: 5,
      usage: { input_tokens: 9, output_tokens: 9 },
    });
    const exit = await h.session.done();
    expect(exit.outcome).toBe('failed');
    expect(exit.reason).toBe('error_max_budget_usd');
  });

  it('pushInput delivers a steer turn into the live input stream', async () => {
    const h = harness();
    const fake = h.getFake();
    h.session.pushInput('actually, focus on the auth module');
    await tick();
    const contents = fake.received.map((m) => m.message.content);
    expect(contents[0]).toBe('do the thing'); // initial brief
    expect(contents).toContain('actually, focus on the auth module'); // steer
    fake.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      total_cost_usd: 0,
      usage: {},
    });
    await h.session.done();
  });

  it('interrupt() calls the query interrupt', async () => {
    const h = harness();
    const fake = h.getFake();
    await h.session.interrupt();
    expect(fake.interrupted).toBe(1);
    fake.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      total_cost_usd: 0,
      usage: {},
    });
    await h.session.done();
  });

  it('stop() ends the run as failed(stopped)', async () => {
    const h = harness();
    await h.session.stop();
    const exit = await h.session.done();
    expect(exit).toMatchObject({ outcome: 'failed', reason: 'stopped' });
  });

  it('emits incremental telemetry from assistant usage', async () => {
    const h = harness();
    const fake = h.getFake();
    fake.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'a' }], usage: { input_tokens: 10, output_tokens: 3 } },
    });
    fake.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'b' }], usage: { input_tokens: 5, output_tokens: 2 } },
    });
    await tick();
    expect(h.telemetry.at(-1)).toMatchObject({ inputTokens: 15, outputTokens: 5, numTurns: 2 });
    fake.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 2,
      total_cost_usd: 0.001,
      usage: { input_tokens: 15, output_tokens: 5 },
    });
    await h.session.done();
  });

  it('a stream that ends without a result fails', async () => {
    const h = harness();
    h.getFake().endStream();
    const exit = await h.session.done();
    expect(exit).toMatchObject({ outcome: 'failed', reason: 'stream ended without a result' });
  });
});

// RUN-34: what a run actually spent, measured against the real SDK rather than assumed.
describe('terminal telemetry counts every model (RUN-34)', () => {
  it('sums modelUsage — `usage` silently omits sub-agent models', async () => {
    // Real numbers from a real 2-message run (see telemetryFromResult). `usage` reported
    // input 4 / output 79 while modelUsage showed a haiku sub-agent had ALSO burned 536 input
    // and 14 output. Reading `usage` makes whole models free.
    const h = harness();
    const fake = h.getFake();
    fake.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 2,
      total_cost_usd: 0.076198,
      usage: {
        input_tokens: 4,
        output_tokens: 79,
        cache_read_input_tokens: 40554,
        cache_creation_input_tokens: 5332,
      },
      modelUsage: {
        'claude-haiku-4-5-20251001': {
          inputTokens: 536,
          outputTokens: 14,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.000581,
        },
        'claude-opus-4-8[1m]': {
          inputTokens: 4,
          outputTokens: 79,
          cacheReadInputTokens: 40554,
          cacheCreationInputTokens: 5332,
          costUSD: 0.075617,
        },
      },
    });
    const exit = await h.session.done();
    expect(exit.telemetry.inputTokens).toBe(540); // 4 + 536 — NOT usage's 4
    expect(exit.telemetry.outputTokens).toBe(93); // 79 + 14
    expect(exit.telemetry.cacheReadTokens).toBe(40554);
    // total_cost_usd is the SDK's own sum of the per-model costs — it agreed to the last digit.
    expect(exit.telemetry.costUsd).toBe(0.076198);
  });

  it('reports the per-model mix, keyed by model, keys un-renamed (RUN-59)', async () => {
    // The KEYS of modelUsage are the model ids — Object.entries keeps them. The daemon stores the
    // literal per-model facts (all four token classes + cost) so the UI can render either a
    // by-tokens or by-cost percentage without a migration.
    const h = harness();
    h.getFake().push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 2,
      total_cost_usd: 0.076198,
      usage: { input_tokens: 4, output_tokens: 79 },
      modelUsage: {
        'claude-haiku-4-5-20251001': {
          inputTokens: 536,
          outputTokens: 14,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.000581,
        },
        'claude-opus-4-8[1m]': {
          inputTokens: 4,
          outputTokens: 79,
          cacheReadInputTokens: 40554,
          cacheCreationInputTokens: 5332,
          costUSD: 0.075617,
        },
      },
    });
    const exit = await h.session.done();
    const mix = exit.telemetry.modelUsage;
    expect(Object.keys(mix ?? {})).toEqual(['claude-haiku-4-5-20251001', 'claude-opus-4-8[1m]']);
    // The haiku sub-agent — a whole model the requested-model row would never mention.
    expect(mix?.['claude-haiku-4-5-20251001']).toEqual({
      inputTokens: 536,
      outputTokens: 14,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0.000581,
    });
    // Every model's token classes sum to the run totals — the "hover the models, land on the run
    // total" invariant, at the source.
    const sum = (f: 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens') =>
      Object.values(mix ?? {}).reduce((a, u) => a + u[f], 0);
    expect(sum('inputTokens')).toBe(exit.telemetry.inputTokens);
    expect(sum('outputTokens')).toBe(exit.telemetry.outputTokens);
    expect(sum('cacheReadInputTokens')).toBe(exit.telemetry.cacheReadTokens);
  });

  it('falls back to `usage` when modelUsage is absent — under-report rather than invent', async () => {
    // An older SDK, or a result shape we have not seen. Reporting zero would be worse than
    // reporting the part we can see.
    const h = harness();
    h.getFake().push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      total_cost_usd: 0.01,
      usage: { input_tokens: 11, output_tokens: 22 },
    });
    const exit = await h.session.done();
    expect(exit.telemetry.inputTokens).toBe(11);
    expect(exit.telemetry.outputTokens).toBe(22);
    // NO invented mix: absent reads as "not reported", a single-model mix would read as a lie.
    expect(exit.telemetry.modelUsage).toBeUndefined();
  });
});

describe('Noriq MCP wiring', () => {
  const opts = (h: ReturnType<typeof harness>) => h.getFake().options as SdkQueryOptions;
  const bareNoriqToolsFor = (kind: 'scope' | 'build' | 'verify') =>
    noriqToolsFor(kind).map((tool) => tool.replace(/^mcp__noriq__/, ''));

  it('injects the Noriq MCP server with the token on the transport, not the env', () => {
    const h = harness({ noriqMcp: { url: 'https://noriq.example/mcp', token: 'plnrt_secret' } });
    const server = opts(h).mcpServers?.[NORIQ_MCP_NAME];

    expect(server).toEqual({
      type: 'http',
      url: 'https://noriq.example/mcp',
      headers: { Authorization: 'Bearer plnrt_secret' },
    });
  });

  it('holds a Noriq-only first prompt until its effective server inventory is connected', async () => {
    let release!: () => void;
    const initialized = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fake!: FakeQuery;
    const driver = testClaudeDriver({
      prepareClaudeHome: () => {},
      queryFn: (args) => {
        fake = new FakeQuery(args.prompt, args.options);
        fake.initializationResult = () => initialized;
        return fake;
      },
    });
    const session = driver.start({
      runId: 'run_noriq_attest',
      kind: 'build',
      cwd: '/wt',
      prompt: 'do not spend before attestation',
      permission: profile({ write: true }),
      noriqMcp: { url: 'https://noriq.example/mcp', token: 'run-token' },
    });

    await tick();
    expect(fake.received).toEqual([]);
    release();
    await vi.waitFor(() =>
      expect(fake.received.map((message) => message.message.content)).toEqual([
        'do not spend before attestation',
      ]),
    );
    fake.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      total_cost_usd: 0,
      usage: {},
    });
    await session.done();
  });

  it('fails a Noriq-only session before the prompt when its effective tool inventory widens', async () => {
    let fake!: FakeQuery;
    const driver = testClaudeDriver({
      prepareClaudeHome: () => {},
      queryFn: (args) => {
        fake = new FakeQuery(args.prompt, args.options);
        fake.mcpServerStatus = async () => [
          {
            name: NORIQ_MCP_NAME,
            status: 'connected',
            tools: [...bareNoriqToolsFor('build'), 'ambient_admin'].map((name) => ({ name })),
          },
        ];
        return fake;
      },
    });
    const session = driver.start({
      runId: 'run_noriq_widened',
      kind: 'build',
      cwd: '/wt',
      prompt: 'must not run',
      permission: profile({ write: true }),
      noriqMcp: { url: 'https://noriq.example/mcp', token: 'run-token' },
    });

    const exit = await session.done();
    expect(exit.reason).toContain('noriq tool inventory differs from Runner authority');
    expect(fake.received).toEqual([]);
  });

  it('accepts a known shared Run catalogue for a narrowly granted stage actor', async () => {
    let fake!: FakeQuery;
    const driver = testClaudeDriver({
      prepareClaudeHome: () => {},
      queryFn: (args) => {
        fake = new FakeQuery(args.prompt, args.options);
        fake.mcpServerStatus = async () => [
          {
            name: NORIQ_MCP_NAME,
            status: 'connected',
            tools: bareNoriqToolsFor('build').map((name) => ({ name })),
          },
        ];
        return fake;
      },
    });
    const session = driver.start({
      runId: 'run_noriq_stage',
      kind: 'verify',
      cwd: '/wt',
      prompt: 'review the parent run',
      permission: profile({ write: false }),
      noriqMcp: { url: 'https://noriq.example/mcp', token: 'run-token' },
      noriqTools: ['raise_alert', 'request_input'],
    });

    await vi.waitFor(() => expect(fake.received).toHaveLength(1));
    fake.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      total_cost_usd: 0,
      usage: {},
    });
    await session.done();
  });

  it("ignores the operator's ambient MCP config", () => {
    // Without this a supervised agent silently inherits ~/.claude.json, .mcp.json and
    // plugins — the operator's personal connectors and credentials, none of them in
    // the project manifest.
    expect(opts(harness()).strictMcpConfig).toBe(true);
  });

  it('loads only Runner-specific user settings, never workspace project/local settings', () => {
    const options = opts(harness());
    expect(options.env?.CLAUDE_CONFIG_DIR).toBe(DEFAULT_CLAUDE_HOME);
    expect(options.settingSources).toEqual(['user']);
    expect(options.settingSources).not.toContain('project');
    expect(options.settingSources).not.toContain('local');
  });

  it('grants a build agent the Noriq tools it is told to use', () => {
    // The prompt orders the agent to register + claim + report through Noriq. Under
    // `dontAsk`, anything unlisted is denied — so without these the run is a no-op.
    const p = mapPermission(profile({ write: true }), 'build');
    expect(p.allowedTools).toEqual(
      expect.arrayContaining([
        'mcp__noriq__configure_agent',
        'mcp__noriq__get_task',
        'mcp__noriq__claim_task',
        'mcp__noriq__post_comment',
      ]),
    );
    // But NOT release_task (RUN-83): a build agent claims and works, but the RUN's terminal
    // outcome moves the task onward (gate passed → review, failed → failed), not the agent —
    // which is what stops a gate-failed task stranding in `review`.
    expect(p.allowedTools).not.toContain('mcp__noriq__release_task');
  });

  it('scopes Noriq access per kind, not blanket', () => {
    const scope = mapPermission(profile({ write: false }), 'scope').allowedTools;
    const build = mapPermission(profile({ write: true }), 'build').allowedTools;
    const verify = mapPermission(profile({ write: false }), 'verify').allowedTools;

    // A scope agent proposes plans and may maintain their dependency metadata, but cannot claim work.
    expect(scope).toContain('mcp__noriq__create_plan');
    expect(scope).not.toContain('mcp__noriq__claim_task');
    expect(scope).toContain('mcp__noriq__update_tasks');
    // A build agent claims and reports, but does not mint plans.
    expect(build).toContain('mcp__noriq__claim_task');
    expect(build).not.toContain('mcp__noriq__create_plan');
    // The adversarial verifier reads and comments; it never mutates.
    expect(verify).toContain('mcp__noriq__post_comment');
    expect(verify).not.toContain('mcp__noriq__claim_task');
    expect(verify).not.toContain('mcp__noriq__update_tasks');
    // Build and verify may SPIN OFF work they found but may not do (RUN-188) — the product is a
    // PROPOSED task a human gates, so this is not create_task by another name. Scope's product
    // IS a proposed plan, so it has no use for the tool.
    expect(build).toContain('mcp__noriq__create_tasks');
    expect(verify).toContain('mcp__noriq__create_tasks');
    expect(scope).not.toContain('mcp__noriq__create_tasks');
    expect(build).not.toContain('mcp__noriq__create_task');
  });

  it('lets EVERY kind reach a human (RUN-32)', () => {
    // The one capability that is not rationed. An agent that finds something alarming, or needs
    // a decision, could previously only comment on a task and hope — and a scope agent could not
    // even do that. Withholding the cheapest, most desirable action an agent can take is how you
    // get the behaviour the rest of this file exists to prevent: guessing.
    for (const kind of ['scope', 'build', 'verify'] as const) {
      const allowed = mapPermission(profile({ write: kind === 'build' }), kind).allowedTools;
      expect(allowed).toContain('mcp__noriq__raise_alert'); // "this looks wrong"
      expect(allowed).toContain('mcp__noriq__request_input'); // "I need a decision" → RUN-30
    }
  });

  it('reaching a human does not smuggle in authority (RUN-32)', () => {
    // The notification channel, not the floodgates: a scope agent still cannot claim work.
    const scope = mapPermission(profile({ write: false }), 'scope').allowedTools;
    expect(scope).not.toContain('mcp__noriq__claim_task');
    expect(scope).not.toContain('mcp__noriq__create_project');
    expect(scope).toContain('mcp__noriq__update_tasks');
  });

  it('never grants a wildcard Noriq rule', () => {
    for (const kind of ['scope', 'build', 'verify'] as const) {
      const allowed = mapPermission(profile({ write: kind === 'build' }), kind).allowedTools;
      expect(allowed).not.toContain('mcp__noriq__*');
      expect(allowed.filter((t) => t.startsWith('mcp__'))).toEqual(noriqToolsFor(kind));
    }
  });

  it('omits mcpServers entirely when no connection is supplied', () => {
    expect(opts(harness()).mcpServers).toBeUndefined();
  });
});

describe('project MCP wiring', () => {
  it('refuses a replaced project MCP executable before invoking the Claude SDK', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noriq-claude-mcp-attest-'));
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
            policyId: 'claude-test-launcher-v1',
            authorize: ({ argvIdentity }) => ({
              policyId: 'claude-test-launcher-v1',
              executableIdentity: 'claude-test-launcher/revision-1',
              runtimeClosureIdentity: 'claude-test-runtime/revision-1',
              authorizedArgvIdentity: argvIdentity,
              resolvedCommand: executable,
              readOnlyRoots: [],
            }),
          },
        }),
        root,
      );
      await writeFile(executable, '#!/bin/sh\nexit 9\n');
      const queryFn = vi.fn((() => undefined) as unknown as QueryFn);
      const driver = new ClaudeDriver({ queryFn, prepareClaudeHome: () => {} });

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
      expect(queryFn).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('re-attests again inside the SDK process callback before containment spawn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noriq-claude-mcp-late-attest-'));
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
            policyId: 'claude-late-launcher-v1',
            authorize: ({ argvIdentity }) => ({
              policyId: 'claude-late-launcher-v1',
              executableIdentity: 'claude-late-launcher/revision-1',
              runtimeClosureIdentity: 'claude-late-runtime/revision-1',
              authorizedArgvIdentity: argvIdentity,
              resolvedCommand: executable,
              readOnlyRoots: [],
            }),
          },
        }),
        root,
      );
      const containmentSpawn = vi.fn(() => {
        throw new Error('containment spawn must not be reached');
      });
      const containment: AgentProcessContainment = {
        capabilities: {
          processTreeTermination: true,
          ownerDeathTermination: true,
          workspaceIsolation: true,
          protectedWorkspaceSubpaths: true,
          projectMcpProcessContainment: true,
        },
        async probe() {},
        spawn: containmentSpawn,
      };
      const queryFn: QueryFn = ({ options }) => {
        writeFileSync(executable, '#!/bin/sh\nexit 9\n');
        if (!options?.spawnClaudeCodeProcess) throw new Error('SDK process callback was not configured');
        if (!options.pathToClaudeCodeExecutable) throw new Error('SDK native CLI path was not configured');
        options.spawnClaudeCodeProcess({
          command: options.pathToClaudeCodeExecutable,
          args: [],
          cwd: root,
          env: {},
          signal: new AbortController().signal,
        });
        throw new Error('SDK process callback unexpectedly returned');
      };
      const driver = new ClaudeDriver({
        queryFn,
        containment,
        prepareClaudeHome: () => {},
        createAttemptHome: () => ({ home: '/tmp/noriq-test-claude-attempt', cleanup() {} }),
      });

      expect(() =>
        driver.start({
          runId: 'late-mutated-project-mcp',
          kind: 'build',
          cwd: root,
          workspaceRoot: root,
          prompt: 'must never launch',
          permission: profile({ write: true }),
          projectMcp: { bundle, toolGrants: { project: ['inspect'] } },
        }),
      ).toThrow(/executable re-attestation failed: resolved command digest changed/);
      expect(containmentSpawn).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('maps a generic bundle explicitly and grants only exact profile tools', async () => {
    const h = harness({
      env: { PATH: '/bin', GIT_TERMINAL_PROMPT: '0' },
      projectMcp: projectMcp(
        {
          simulator: {
            transport: 'stdio',
            command: 'npx',
            args: ['sim-mcp'],
            env: { PROJECT: '/wt' },
          },
          docs: { transport: 'http', url: 'https://docs.test/mcp', headers: {} },
        },
        { simulator: ['inspect', 'mutate'], docs: ['search'] },
      ),
    });
    await tick();
    const options = h.getFake().options as SdkQueryOptions;

    expect(options.mcpServers?.simulator).toEqual({
      type: 'stdio',
      command: process.execPath,
      args: ['sim-mcp'],
      env: {
        PATH: realpathSync('/bin'),
        GIT_TERMINAL_PROMPT: '0',
        PROJECT: '/wt',
        GIT_ASKPASS: '/bin/false',
        SSH_ASKPASS: '/bin/false',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '',
        HOME: '/tmp/noriq-project-mcp',
        CODEX_HOME: '/tmp/noriq-project-mcp/codex-denied',
        CLAUDE_CONFIG_DIR: '/tmp/noriq-project-mcp/claude-denied',
        NORIQ_MCP_TOKEN: '',
      },
    });
    expect(options.mcpServers?.docs).toEqual({
      type: 'http',
      url: 'https://docs.test/mcp',
      headers: {},
    });
    expect(options.allowedTools).toEqual(
      expect.arrayContaining(['mcp__simulator__inspect', 'mcp__simulator__mutate', 'mcp__docs__search']),
    );
    expect(options.allowedTools).not.toEqual(expect.arrayContaining(['mcp__simulator__*', 'mcp__docs__*']));
    expect(h.getFake().received).toEqual([
      { type: 'user', message: { role: 'user', content: 'do the thing' }, parent_tool_use_id: null },
    ]);
  });

  it('holds the first prompt until the exact effective inventory is connected', async () => {
    let release!: () => void;
    const initialized = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fake!: FakeQuery;
    const driver = testClaudeDriver({
      prepareClaudeHome: () => {},
      queryFn: (args) => {
        fake = new FakeQuery(args.prompt, args.options);
        fake.initializationResult = () => initialized;
        return fake;
      },
    });
    driver.start({
      runId: 'run_attest',
      kind: 'build',
      cwd: '/wt',
      prompt: 'do not spend yet',
      permission: profile({ write: true }),
      projectMcp: projectMcp(
        { simulator: { transport: 'stdio', command: 'sim', args: [], env: {} } },
        { simulator: ['inspect'] },
      ),
    });

    await tick();
    expect(fake.received).toEqual([]);
    release();
    await tick();
    expect(fake.received.map((message) => message.message.content)).toEqual(['do not spend yet']);
  });

  it('polls a pending project server without loading its whole tool catalogue into turn one', async () => {
    let fake!: FakeQuery;
    let polls = 0;
    const driver = testClaudeDriver({
      prepareClaudeHome: () => {},
      queryFn: (args) => {
        fake = new FakeQuery(args.prompt, args.options);
        fake.mcpServerStatus = async () => {
          polls += 1;
          return [
            {
              name: 'simulator',
              status: polls === 1 ? 'pending' : 'connected',
              tools: [{ name: 'inspect' }],
            },
          ];
        };
        return fake;
      },
    });
    driver.start({
      runId: 'run_pending_mcp',
      kind: 'build',
      cwd: '/wt',
      prompt: 'wait for the server',
      permission: profile({ write: true }),
      projectMcp: projectMcp(
        { simulator: { transport: 'stdio', command: 'sim', args: [], env: {} } },
        { simulator: ['inspect'] },
      ),
    });

    await tick();
    expect(fake.received).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(fake.received.map((message) => message.message.content)).toEqual(['wait for the server']);
    expect((fake.options as SdkQueryOptions).mcpServers?.simulator).not.toHaveProperty('alwaysLoad');
  });

  it('fails before the prompt when the SDK reports an unexpected effective server', async () => {
    let fake!: FakeQuery;
    const driver = testClaudeDriver({
      prepareClaudeHome: () => {},
      queryFn: (args) => {
        fake = new FakeQuery(args.prompt, args.options);
        fake.mcpServerStatus = async () => [{ name: 'ambient', status: 'connected' }];
        return fake;
      },
    });
    const session = driver.start({
      runId: 'run_bad_inventory',
      kind: 'build',
      cwd: '/wt',
      prompt: 'must not run',
      permission: profile({ write: true }),
      projectMcp: projectMcp(
        { simulator: { transport: 'stdio', command: 'sim', args: [], env: {} } },
        { simulator: ['inspect'] },
      ),
    });

    const exit = await session.done();
    expect(exit.reason).toContain('expected servers [simulator], got [ambient]');
    expect(fake.received).toEqual([]);
  });

  it('forces dontAsk when an auto profile receives project MCP authority', async () => {
    const h = harness({
      permission: profile({ write: true, auto: true }),
      projectMcp: projectMcp(
        { simulator: { transport: 'stdio', command: 'sim', args: [], env: {} } },
        { simulator: ['inspect'] },
      ),
    });
    await tick();

    expect((h.getFake().options as SdkQueryOptions).permissionMode).toBe('dontAsk');
  });

  it('rejects a permission rule that would widen an exact project grant', () => {
    expect(() =>
      harness({
        permission: profile({ write: true, allow: ['mcp__simulator__*'] }),
        projectMcp: projectMcp(
          { simulator: { transport: 'stdio', command: 'sim', args: [], env: {} } },
          { simulator: ['inspect'] },
        ),
      }),
    ).toThrow('permission allowlist may not widen exact project MCP grants');
  });

  it('fails before the prompt when a granted tool is absent', async () => {
    let fake!: FakeQuery;
    const driver = testClaudeDriver({
      prepareClaudeHome: () => {},
      queryFn: (args) => {
        fake = new FakeQuery(args.prompt, args.options);
        fake.mcpServerStatus = async () => [
          { name: 'simulator', status: 'connected', tools: [{ name: 'inspect' }] },
        ];
        return fake;
      },
    });
    const session = driver.start({
      runId: 'run_missing_tool',
      kind: 'build',
      cwd: '/wt',
      prompt: 'must not run',
      permission: profile({ write: true }),
      projectMcp: projectMcp(
        { simulator: { transport: 'stdio', command: 'sim', args: [], env: {} } },
        { simulator: ['inspect', 'mutate'] },
      ),
    });

    const exit = await session.done();
    expect(exit.reason).toContain(
      'simulator tool inventory differs from its exact grant (missing [mutate], unexpected [], available [inspect])',
    );
    expect(fake.received).toEqual([]);
  });

  it('fails before the prompt when a server exposes tools outside the exact grant', async () => {
    let fake!: FakeQuery;
    const driver = testClaudeDriver({
      prepareClaudeHome: () => {},
      queryFn: (args) => {
        fake = new FakeQuery(args.prompt, args.options);
        fake.mcpServerStatus = async () => [
          {
            name: 'simulator',
            status: 'connected',
            tools: [{ name: 'inspect' }, { name: 'mutate' }, { name: 'shell' }],
          },
        ];
        return fake;
      },
    });
    const session = driver.start({
      runId: 'run_subset_tool_grant',
      kind: 'verify',
      cwd: '/wt',
      prompt: 'inspect only',
      permission: profile({ write: false }),
      projectMcp: projectMcp(
        { simulator: { transport: 'stdio', command: 'sim', args: [], env: {} } },
        { simulator: ['inspect'] },
      ),
    });

    const exit = await session.done();
    expect(exit.reason).toContain(
      'simulator tool inventory differs from its exact grant (missing [], unexpected [mutate, shell], available [inspect, mutate, shell])',
    );
    expect(fake.received).toEqual([]);
    const allowedTools = (fake.options as SdkQueryOptions).allowedTools ?? [];
    expect(allowedTools).toContain('mcp__simulator__inspect');
    expect(allowedTools).not.toContain('mcp__simulator__mutate');
    expect(allowedTools).not.toContain('mcp__simulator__shell');
  });

  it.each([
    ['empty', { simulator: [] }],
    ['mismatched', { other: ['inspect'] }],
  ])('rejects %s project tool grants before starting the SDK', (_case, toolGrants) => {
    expect(() =>
      harness({
        projectMcp: projectMcp(
          { simulator: { transport: 'stdio', command: 'sim', args: [], env: {} } },
          toolGrants,
        ),
      }),
    ).toThrow('invalid project MCP session');
  });

  it('launches only the project servers granted to this session', async () => {
    const { getFake, session } = harness({
      projectMcp: projectMcp(
        {
          editor: { transport: 'stdio', command: 'edit', args: [], env: {} },
          inspector: { transport: 'stdio', command: 'inspect', args: [], env: {} },
        },
        { inspector: ['read_state'] },
      ),
    });
    const fake = getFake();
    await vi.waitFor(() => expect(fake.received).toHaveLength(1));
    fake.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await session.done();
    expect(Object.keys((fake.options as SdkQueryOptions).mcpServers ?? {})).toEqual(['inspector']);
  });
});

describe('a read-only kind can execute without being able to edit', () => {
  it('honours an explicit bash allowlist on a read-only profile', () => {
    // Regression: `disallowedTools: ['Bash']` was added for EVERY non-write profile, and
    // deny outranks allow — so a verifier's `Bash(npm test:*)` sat in the manifest doing
    // nothing, and the adversarial gate could only ever review by eye.
    const p = mapPermission(profile({ write: false, allow: ['Bash(npm test:*)'] }), 'verify');
    expect(p.allowedTools).toContain('Bash(npm test:*)');
    expect(p.disallowedTools).not.toContain('Bash'); // would have killed the rule above
  });

  it('still denies edit tools to that same profile', () => {
    // Execute, never edit — a verifier must not be able to "fix" what it judges.
    const p = mapPermission(profile({ write: false, allow: ['Bash(npm test:*)'] }), 'verify');
    expect(p.disallowedTools).toEqual(expect.arrayContaining(['Edit', 'Write', 'MultiEdit']));
    expect(p.allowedTools).not.toContain('Edit');
  });

  it('still blanket-denies Bash when a read-only profile grants no bash rules', () => {
    const p = mapPermission(profile({ write: false, allow: [] }), 'scope');
    expect(p.disallowedTools).toContain('Bash');
  });

  it('never grants bare Bash, whatever the profile', () => {
    for (const [write, kind] of [
      [false, 'verify'],
      [true, 'build'],
    ] as const) {
      const p = mapPermission(profile({ write, allow: ['Bash(npm test:*)'] }), kind);
      expect(p.allowedTools).not.toContain('Bash');
      expect(p.permissionMode).toBe('dontAsk'); // never bypassPermissions
    }
  });
});

describe("the agent shell never sees the daemon's secrets", () => {
  it('passes a sanitized env to the SDK', () => {
    // Regression: the Claude driver — the DEFAULT tool — passed no `env` at all, so the
    // spawned `claude` inherited process.env verbatim. codex and verify always sanitized;
    // only this path made the security model's central claim false.
    const h = harness();
    const env = (h.getFake().options as SdkQueryOptions).env;

    expect(env).toBeDefined();
    expect(env?.NORIQ_TOKEN).toBeUndefined(); // the daemon's OAuth token
    expect(env?.GITHUB_TOKEN).toBeUndefined();
    expect(env?.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    // ...and git cannot prompt for, or reach, credentials.
    expect(env?.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env?.GIT_ASKPASS).toBe('/bin/false');
  });

  it('still hands over a usable PATH', () => {
    // Stripping secrets must not strip the ability to run anything.
    const env = (harness().getFake().options as SdkQueryOptions).env;
    expect(env?.PATH).toBeTruthy();
  });
});

// RUN-133. Stopping a multiTurn session mid-hand-back became reachable once the budget layer got a
// reason to do it (the run-level spend guard fires on a fix turn's telemetry tick). Before this,
// `stop()` closed the query and called the one-shot `finish()` — already consumed by the session's
// first result — and never touched `continueWith`'s own pending promise. The caller then awaited a
// turn that could never arrive: the process was gone, the stream was closed, and
// `verifyWithFeedback` / `reviewWithFeedback` hung the run and pinned its worktree forever.
describe('stopping a multiTurn session settles the turn in flight (RUN-133)', () => {
  const firstResult = (fake: ReturnType<ReturnType<typeof harness>['getFake']>) =>
    fake.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      total_cost_usd: 0,
      usage: { input_tokens: 10, output_tokens: 10 },
    });

  it('resolves the pending turn as failed{stopped} rather than hanging', async () => {
    const h = harness({ multiTurn: true });
    const fake = h.getFake();
    firstResult(fake);
    await h.session.done();

    // A hand-back turn is now in flight and nothing will answer it…
    const turn = h.session.continueWith!('fix the type error');
    await tick();
    // …until the budget layer stops the session, which is exactly what a run-level breach does.
    await h.session.stop();

    const exit = await Promise.race([turn, tick().then(() => 'HUNG' as const)]);
    expect(exit).not.toBe('HUNG');
    expect(exit).toMatchObject({ outcome: 'failed', reason: 'stopped' });
  });

  it('settles it exactly once — a second stop finds nothing pending', async () => {
    const h = harness({ multiTurn: true });
    firstResult(h.getFake());
    await h.session.done();
    const turn = h.session.continueWith!('fix it');
    await tick();
    await h.session.stop();
    await h.session.stop();
    await expect(turn).resolves.toMatchObject({ outcome: 'failed' });
  });

  it('stopping with NO turn in flight is unchanged — nothing to settle', async () => {
    const h = harness({ multiTurn: true });
    firstResult(h.getFake());
    await h.session.done();
    await expect(h.session.stop()).resolves.toBeUndefined();
  });
});

describe('losing a multiTurn SDK stream settles the turn in flight', () => {
  const beginHandBack = async () => {
    const h = harness({ multiTurn: true });
    const fake = h.getFake();
    fake.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      total_cost_usd: 0,
      usage: { input_tokens: 10, output_tokens: 10 },
    });
    await h.session.done();
    return { ...h, fake, turn: h.session.continueWith!('address the review finding') };
  };

  it('fails a pending hand-back when the SDK stream ends', async () => {
    const { fake, turn } = await beginHandBack();

    fake.endStream();

    await expect(turn).resolves.toMatchObject({
      outcome: 'failed',
      reason: 'stream ended without a result',
    });
  });

  it('fails a pending hand-back with the SDK stream error', async () => {
    const { fake, turn } = await beginHandBack();

    fake.failStream(new Error('SDK transport disconnected'));

    await expect(turn).resolves.toMatchObject({
      outcome: 'failed',
      reason: 'SDK transport disconnected',
    });
  });
});
