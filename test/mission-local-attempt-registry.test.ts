import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  MissionAttemptRecoveryRequest,
  MissionAttemptRegistryRequest,
} from '../src/mission/driver-runtime';
import type { MissionChildExecution, MissionChildResult } from '../src/mission/harness';
import { type LocalAttemptOwner, LocalAttemptSessionRegistry } from '../src/mission/local-attempt-registry';

const temporary: string[] = [];
const ownerA: LocalAttemptOwner = {
  pid: 101,
  hostname: 'runner-host',
  bootId: '11111111-1111-1111-1111-111111111111',
  startTimeTicks: '1001',
};
const ownerB: LocalAttemptOwner = {
  pid: 202,
  hostname: 'runner-host',
  bootId: ownerA.bootId,
  startTimeTicks: '2002',
};

async function directory(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'noriq-attempts-'));
  temporary.push(value);
  return value;
}

function request(overrides: Partial<MissionAttemptRegistryRequest> = {}): MissionAttemptRegistryRequest {
  return {
    missionId: 'mission-1',
    childId: 'child-1',
    attemptId: 'attempt-1',
    authorityFingerprint: 'a'.repeat(64),
    promptRendererVersion: 'renderer-v1',
    promptFingerprint: 'b'.repeat(64),
    workspace: '/worktree',
    workspaceRevisionId: 'revision-1',
    workspaceLeaseGeneration: 'lease-generation-1',
    projectMcpEffectiveFingerprint: null,
    onUsage: async () => 'continue',
    ...overrides,
  };
}

function recoveryRequest(
  overrides: Partial<MissionAttemptRecoveryRequest> = {},
): MissionAttemptRecoveryRequest {
  return {
    missionId: 'mission-1',
    childId: 'child-1',
    attemptId: 'attempt-1',
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function execution(result: Promise<MissionChildResult>): MissionChildExecution {
  return {
    attemptId: 'attempt-1',
    usageAtAttach: { tokens: 0, usd: 0, activeSeconds: 0 },
    cancel: async () => {},
    done: () => result,
  };
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

describe('LocalAttemptSessionRegistry', () => {
  it('atomically returns the one live execution for repeated same-authority claims', async () => {
    const root = await directory();
    const registry = new LocalAttemptSessionRegistry({
      directory: root,
      processesDieWithOwner: true,
      currentOwner: async () => ownerA,
      ownerAlive: async () => true,
    });
    const first = await registry.claim(request());
    expect(first.status).toBe('start');
    if (first.status !== 'start') throw new Error('expected start');
    const terminal = deferred<MissionChildResult>();
    const running = execution(terminal.promise);
    await first.publish(running);

    const attached = await registry.claim(request());
    expect(attached.status).toBe('attached');
    if (attached.status !== 'attached') throw new Error('expected attached');
    expect(attached.execution).toBe(running);

    terminal.resolve({
      outcome: 'succeeded',
      summary: 'done',
      usage: { tokens: 12, usd: 0.25, activeSeconds: 3 },
    });
    await running.done();
  });

  it('persists a terminal result before a new registry replays it', async () => {
    const root = await directory();
    const firstRegistry = new LocalAttemptSessionRegistry({
      directory: root,
      processesDieWithOwner: true,
      currentOwner: async () => ownerA,
      ownerAlive: async () => false,
    });
    const claim = await firstRegistry.claim(request());
    if (claim.status !== 'start') throw new Error('expected start');
    const result: MissionChildResult = {
      outcome: 'succeeded',
      summary: 'durable result',
      usage: { tokens: 20, usd: 1, activeSeconds: 4 },
    };
    const running = execution(Promise.resolve(result));
    await claim.publish(running);
    await running.done();

    const restarted = new LocalAttemptSessionRegistry({
      directory: root,
      processesDieWithOwner: true,
      currentOwner: async () => ownerB,
      ownerAlive: async () => false,
    });
    const replay = await restarted.recover(recoveryRequest());
    expect(replay.status).toBe('attached');
    if (replay.status !== 'attached') throw new Error('expected attached');
    await expect(replay.execution.done()).resolves.toEqual(result);
    expect(replay.execution.usageAtAttach).toEqual(result.usage);
  });

  it('turns an owner-death start window into one durable lost result and never restarts it', async () => {
    const root = await directory();
    const firstRegistry = new LocalAttemptSessionRegistry({
      directory: root,
      processesDieWithOwner: true,
      currentOwner: async () => ownerA,
      ownerAlive: async () => false,
    });
    const claim = await firstRegistry.claim(request());
    expect(claim.status).toBe('start');

    const restarted = new LocalAttemptSessionRegistry({
      directory: root,
      processesDieWithOwner: true,
      currentOwner: async () => ownerB,
      ownerAlive: async () => false,
    });
    const recovered = await restarted.recover(recoveryRequest());
    expect(recovered.status).toBe('attached');
    if (recovered.status !== 'attached') throw new Error('expected attached');
    const lost = await recovered.execution.done();
    expect(lost.outcome).toBe('lost');
    expect(lost.usage).toEqual({
      tokens: null,
      usd: null,
      activeSeconds: null,
    });

    const again = await restarted.recover(recoveryRequest());
    expect(again.status).toBe('attached');
    if (again.status !== 'attached') throw new Error('expected attached');
    await expect(again.execution.done()).resolves.toEqual(lost);
  });

  it('keeps a live but locally unattachable recovered owner ambiguous', async () => {
    const root = await directory();
    const firstRegistry = new LocalAttemptSessionRegistry({
      directory: root,
      processesDieWithOwner: true,
      currentOwner: async () => ownerA,
      ownerAlive: async () => true,
    });
    expect((await firstRegistry.claim(request())).status).toBe('start');

    const restarted = new LocalAttemptSessionRegistry({
      directory: root,
      processesDieWithOwner: true,
      currentOwner: async () => ownerB,
      ownerAlive: async () => true,
    });
    await expect(restarted.recover(recoveryRequest())).resolves.toEqual({
      status: 'ambiguous',
      reason: expect.stringContaining('no attachable local execution'),
    });
  });

  it('never recovers an attempt record for a different durable mission or child', async () => {
    const root = await directory();
    const registry = new LocalAttemptSessionRegistry({
      directory: root,
      processesDieWithOwner: true,
      currentOwner: async () => ownerA,
      ownerAlive: async () => false,
    });
    expect((await registry.claim(request())).status).toBe('start');

    await expect(registry.recover(recoveryRequest({ missionId: 'mission-2' }))).resolves.toEqual({
      status: 'ambiguous',
      reason: 'attempt record belongs to a different durable mission or child',
    });
    await expect(registry.recover(recoveryRequest({ childId: 'child-2' }))).resolves.toEqual({
      status: 'ambiguous',
      reason: 'attempt record belongs to a different durable mission or child',
    });

    const exact = await registry.recover(recoveryRequest());
    expect(exact.status).toBe('attached');
    if (exact.status !== 'attached') throw new Error('expected attached');
    await expect(exact.execution.done()).resolves.toMatchObject({
      outcome: 'lost',
      usage: { tokens: null, usd: null, activeSeconds: null },
    });
  });

  it('refuses an attempt id reused under different prompt authority', async () => {
    const root = await directory();
    const registry = new LocalAttemptSessionRegistry({
      directory: root,
      processesDieWithOwner: true,
      currentOwner: async () => ownerA,
      ownerAlive: async () => true,
    });
    expect((await registry.claim(request())).status).toBe('start');

    const different = await registry.claim(request({ promptFingerprint: 'c'.repeat(64) }));
    expect(different).toEqual({
      status: 'ambiguous',
      reason: 'attempt id was claimed under different authority',
    });
  });

  it('refuses an attempt id reused at a different workspace revision or lease generation', async () => {
    const root = await directory();
    const registry = new LocalAttemptSessionRegistry({
      directory: root,
      processesDieWithOwner: true,
      currentOwner: async () => ownerA,
      ownerAlive: async () => true,
    });
    expect((await registry.claim(request())).status).toBe('start');

    await expect(registry.claim(request({ workspaceRevisionId: 'revision-2' }))).resolves.toEqual({
      status: 'ambiguous',
      reason: 'attempt id was claimed under different authority',
    });
    await expect(
      registry.claim(request({ workspaceLeaseGeneration: 'lease-generation-2' })),
    ).resolves.toEqual({
      status: 'ambiguous',
      reason: 'attempt id was claimed under different authority',
    });
  });
});
