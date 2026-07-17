import type { PermissionProfile } from '@noriq-dev/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
} from '../src/drivers/claude';
import type { DriverStartOptions, DriverTelemetry } from '../src/drivers/types';

// A controllable stand-in for the Agent SDK Query: captures the streamed input
// turns + options, lets the test push scripted stream-json messages, and records
// interrupt/close.
class FakeQuery {
  received: SdkUserMessage[] = [];
  interrupted = 0;
  closed = false;
  options: unknown;
  private readonly emit = new AsyncQueue<SdkMessage>();
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
  async interrupt(): Promise<unknown> {
    this.interrupted += 1;
    return undefined;
  }
  close(): void {
    this.closed = true;
  }
  [Symbol.asyncIterator](): AsyncIterator<SdkMessage> {
    return this.emit[Symbol.asyncIterator]();
  }
}

const profile = (over: Partial<PermissionProfile> = {}): PermissionProfile => ({
  write: false,
  network: 'restricted',
  allow: [],
  deny: [],
  auto: false,
  ...over,
});

function harness(startOver: Partial<DriverStartOptions> = {}) {
  let fake!: FakeQuery;
  const queryFn: QueryFn = (args) => {
    fake = new FakeQuery(args.prompt, args.options);
    return fake;
  };
  const telemetry: DriverTelemetry[] = [];
  const texts: string[] = [];
  const driver = new ClaudeDriver({ queryFn });
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

afterEach(() => vi.restoreAllMocks());

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

  it('injects the Noriq MCP server with the token on the transport, not the env', () => {
    const h = harness({ noriqMcp: { url: 'https://noriq.example/mcp', token: 'plnrt_secret' } });
    const server = opts(h).mcpServers?.[NORIQ_MCP_NAME];

    expect(server).toEqual({
      type: 'http',
      url: 'https://noriq.example/mcp',
      headers: { Authorization: 'Bearer plnrt_secret' },
    });
  });

  it("ignores the operator's ambient MCP config", () => {
    // Without this a supervised agent silently inherits ~/.claude.json, .mcp.json and
    // plugins — the operator's personal connectors and credentials, none of them in
    // the project manifest.
    expect(opts(harness()).strictMcpConfig).toBe(true);
  });

  it('grants a build agent the Noriq tools it is told to use', () => {
    // The prompt orders the agent to register + claim + report through Noriq. Under
    // `dontAsk`, anything unlisted is denied — so without these the run is a no-op.
    const p = mapPermission(profile({ write: true }), 'build');
    expect(p.allowedTools).toEqual(
      expect.arrayContaining([
        'mcp__noriq__set_agent_identity',
        'mcp__noriq__get_task',
        'mcp__noriq__claim_task',
        'mcp__noriq__release_task',
        'mcp__noriq__post_comment',
      ]),
    );
  });

  it('scopes Noriq access per kind, not blanket', () => {
    const scope = mapPermission(profile({ write: false }), 'scope').allowedTools;
    const build = mapPermission(profile({ write: true }), 'build').allowedTools;
    const verify = mapPermission(profile({ write: false }), 'verify').allowedTools;

    // A read-only scope agent proposes plans but must not claim or mutate work.
    expect(scope).toContain('mcp__noriq__create_plan');
    expect(scope).not.toContain('mcp__noriq__claim_task');
    expect(scope).not.toContain('mcp__noriq__update_task');
    // A build agent claims and reports, but does not mint plans.
    expect(build).toContain('mcp__noriq__claim_task');
    expect(build).not.toContain('mcp__noriq__create_plan');
    // The adversarial verifier reads and comments; it never mutates.
    expect(verify).toContain('mcp__noriq__post_comment');
    expect(verify).not.toContain('mcp__noriq__claim_task');
    expect(verify).not.toContain('mcp__noriq__update_task');
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
    expect(scope).not.toContain('mcp__noriq__update_task');
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
