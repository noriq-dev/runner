import { execFile } from 'node:child_process';
import {
  appendFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlMissionStore, missionJournalFilename } from '../src/mission/jsonl-store';
import { MissionKernel } from '../src/mission/kernel';
import type { MissionAction, MissionActionEnvelope, MissionEvent } from '../src/mission/protocol';
import { MissionJournalCorruptionError } from '../src/mission/store';

const guide = {
  profileId: 'guide',
  agent: { driver: 'test-guide', model: 'guide-model' },
  budget: { tokens: 10, usd: 1, activeSeconds: 10 },
  turnLimit: 20,
} as const;
const profiles = [
  {
    profileId: 'worker',
    role: 'worker',
    permission: 'read',
    agent: { driver: 'test-worker', model: 'worker-model' },
    assurance: { rank: 1, independenceClass: 'test-review' },
    driverPosture: {
      kind: 'verify',
      permission: { write: false, allow: [], deny: [], auto: false },
      lineageRole: 'reviewer',
    },
    budget: { tokens: 10, usd: 1, activeSeconds: 10 },
    resources: {},
    projectMcp: [],
  },
] as const;
const validationPolicy = {
  kind: 'none',
  policyId: 'test-none-v1',
  reason: 'No deterministic validation in this unit fixture.',
} as const;
const units = (value: string): number => [...value].reduce((total, char) => total + char.charCodeAt(0), 0);
const action = (value: string): MissionAction => ({
  type: 'create-mission',
  projectMcpDeclarationFingerprint: null,
  budget: { tokens: units(value), usd: null, activeSeconds: null },
  resources: {},
  guide,
  profiles,
  validationPolicy,
});
const event = (value: string): MissionEvent => ({
  type: 'mission-created',
  projectMcpDeclarationFingerprint: null,
  budget: { tokens: units(value), usd: null, activeSeconds: null },
  resources: {},
  guide,
  profiles,
  validationPolicy,
});

const run = promisify(execFile);
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'noriq-mission-store-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const envelope = (expectedRevision: number, actionId: string, value: string): MissionActionEnvelope => ({
  missionId: 'mission-one',
  expectedRevision,
  actionId,
  action: action(value),
});

const commit = (store: JsonlMissionStore, expectedRevision: number, actionId: string, value: string) =>
  store.commit(envelope(expectedRevision, actionId, value), [event(value)]);

const dispatchAccepted = async (
  kernel: MissionKernel,
  missionId: string,
  actionId: string,
  missionAction: MissionAction,
) => {
  const state = await kernel.inspect(missionId);
  const result = await kernel.dispatch({
    missionId,
    expectedRevision: state.revision,
    actionId,
    action: missionAction,
  });
  if (!result.accepted) throw new Error(`${missionAction.type} was refused: ${result.reason}`);
  return result.state;
};

const createLifecycleMission = (kernel: MissionKernel, missionId: string, cleanup: readonly string[] = []) =>
  dispatchAccepted(kernel, missionId, 'create', {
    type: 'create-mission',
    projectMcpDeclarationFingerprint: null,
    budget: { tokens: 100, usd: null, activeSeconds: 100 },
    resources: {},
    guide,
    profiles,
    validationPolicy,
    ...(cleanup.length > 0 ? { cleanup } : {}),
  });

const journalPath = (missionId = 'mission-one') => path.join(directory, missionJournalFilename(missionId));
const DEAD_LOCK_TOKEN = '00000000-0000-4000-8000-000000000001';
const LIVE_LOCK_TOKEN = '00000000-0000-4000-8000-000000000002';
interface TestProcessIncarnation {
  kind: 'linux-proc';
  bootId: string;
  startTimeTicks: string;
}
const currentLinuxProcessIncarnation = async (): Promise<TestProcessIncarnation> => {
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim().toLowerCase();
  const rawStat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
  const commandEnd = rawStat.lastIndexOf(')');
  const startTimeTicks = rawStat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/)[19];
  if (!startTimeTicks) throw new Error('current process has no Linux proc start time');
  return { kind: 'linux-proc', bootId, startTimeTicks };
};
const lockOwner = (
  token: string,
  pid: number,
  options: {
    hostname?: string;
    processIncarnation?: TestProcessIncarnation | null;
  } = {},
) =>
  `${JSON.stringify({
    token,
    pid,
    hostname: options.hostname ?? os.hostname(),
    acquiredAt: '2026-08-12T12:00:00.000Z',
    ...(options.processIncarnation === undefined ? {} : { processIncarnation: options.processIncarnation }),
  })}\n`;
const ticketPath = (lock: string, ticket: number, token: string) =>
  `${lock}.ticket-${String(ticket).padStart(16, '0')}-${token}`;

describe('JsonlMissionStore', () => {
  it('reloads atomic action batches with one revision per physical line and an intact hash chain', async () => {
    const store = new JsonlMissionStore(directory, {
      now: () => new Date('2026-08-12T12:00:00.000Z'),
    });
    const first = await store.commit(envelope(0, 'action-one', 'first'), [
      event('first'),
      event('also first'),
    ]);
    const inode = (await stat(journalPath())).ino;
    const second = await commit(store, 1, 'action-two', 'second');
    const history = await store.load('mission-one');

    expect(first).toMatchObject({ previousRevision: 0, revision: 1, eventCount: 2 });
    expect(second).toMatchObject({ previousRevision: 1, revision: 2, eventCount: 1 });
    expect(history.actions[1]!.previousHash).toBe(history.actions[0]!.hash);
    expect((await stat(journalPath())).ino).toBe(inode);
    expect((await readFile(journalPath(), 'utf8')).trimEnd().split('\n')).toHaveLength(2);

    const reloaded = await new JsonlMissionStore(directory).load('mission-one');
    expect(reloaded).toMatchObject({ revision: 2, headHash: history.actions[1]!.hash });
    expect(await new JsonlMissionStore(directory).listMissionIds()).toEqual(['mission-one']);
    expect(reloaded.actions.map((stored) => stored.events.length)).toEqual([2, 1]);
    expect(reloaded.events.map(({ revision, ordinal }) => ({ revision, ordinal }))).toEqual([
      { revision: 1, ordinal: 0 },
      { revision: 1, ordinal: 1 },
      { revision: 2, ordinal: 0 },
    ]);
  });

  it('returns the original receipt for a stale idempotent retry after reload', async () => {
    const firstStore = new JsonlMissionStore(directory, {
      now: () => new Date('2026-08-12T12:00:00.000Z'),
    });
    const original = await commit(firstStore, 0, 'action-one', 'first');
    await commit(firstStore, 1, 'action-two', 'second');

    const restarted = new JsonlMissionStore(directory, {
      now: () => new Date('2030-01-01T00:00:00.000Z'),
    });
    await expect(
      restarted.commit(envelope(0, 'action-one', 'first'), [event('ignored retry output')]),
    ).resolves.toEqual(original);
    expect((await restarted.load('mission-one')).revision).toBe(2);
  });

  it('returns an idempotent receipt before rejecting a future expected revision', async () => {
    const store = new JsonlMissionStore(directory);
    const original = await commit(store, 0, 'action-one', 'first');

    await expect(
      store.commit(envelope(999, 'action-one', 'first'), [event('ignored retry output')]),
    ).resolves.toEqual(original);
  });

  it('returns only journal records after the requested derived-state revision', async () => {
    const store = new JsonlMissionStore(directory);
    await commit(store, 0, 'action-one', 'first');
    await commit(store, 1, 'action-two', 'second');

    const delta = await store.loadSince('mission-one', 1);
    expect(delta).toMatchObject({ previousRevision: 1, revision: 2 });
    expect(delta.actions.map((entry) => entry.receipt.actionId)).toEqual(['action-two']);
    expect(delta.events).toHaveLength(1);
  });

  it('admits one winner across independent stores sharing one expected revision', async () => {
    const first = new JsonlMissionStore(directory);
    const second = new JsonlMissionStore(directory);
    const outcomes = await Promise.allSettled([
      commit(first, 0, 'action-one', 'first'),
      commit(second, 0, 'action-two', 'second'),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({
      reason: { name: 'MissionStoreConflictError', kind: 'revision' },
    });
    expect((await first.load('mission-one')).revision).toBe(1);
  });

  it('admits one controller across independent stores and releases it safely', async () => {
    const first = new JsonlMissionStore(directory, { controllerTimeoutMs: 20, lockPollMs: 2 });
    const second = new JsonlMissionStore(directory, { controllerTimeoutMs: 20, lockPollMs: 2 });
    const lease = await first.acquireController('mission-one');

    await expect(second.acquireController('mission-one')).rejects.toMatchObject({
      name: 'MissionControllerBusyError',
      missionId: 'mission-one',
    });
    await lease.release();
    const successor = await second.acquireController('mission-one');
    await successor.release();
  });

  it('keeps a successor controller generation when an earlier release is repeated', async () => {
    const first = new JsonlMissionStore(directory, { controllerTimeoutMs: 20, lockPollMs: 2 });
    const second = new JsonlMissionStore(directory, { controllerTimeoutMs: 20, lockPollMs: 2 });
    const contender = new JsonlMissionStore(directory, { controllerTimeoutMs: 20, lockPollMs: 2 });
    const prior = await first.acquireController('mission-one');
    await prior.release();
    const successor = await second.acquireController('mission-one');

    await prior.release();
    await expect(contender.acquireController('mission-one')).rejects.toMatchObject({
      name: 'MissionControllerBusyError',
    });
    await successor.release();
  });

  it('uses the filesystem lock as a real cross-process CAS', async () => {
    const worker = `
      const { JsonlMissionStore } = await import('./src/mission/jsonl-store.ts');
      const store = new JsonlMissionStore(process.env.MISSION_DIRECTORY);
      const actionId = process.env.MISSION_ACTION_ID;
      try {
        const receipt = await store.commit(
          {
            missionId: 'mission-process',
            expectedRevision: 0,
            actionId,
            action: {
type: 'create-mission',
projectMcpDeclarationFingerprint: null,
              budget: { tokens: null, usd: null, activeSeconds: null },
              resources: {},
              guide: ${JSON.stringify(guide)},
              profiles: ${JSON.stringify(profiles)},
              validationPolicy: ${JSON.stringify(validationPolicy)},
            },
          },
          [{
type: 'mission-created',
projectMcpDeclarationFingerprint: null,
            budget: { tokens: null, usd: null, activeSeconds: null },
            resources: {},
            guide: ${JSON.stringify(guide)},
            profiles: ${JSON.stringify(profiles)},
            validationPolicy: ${JSON.stringify(validationPolicy)},
          }],
        );
        process.stdout.write('committed:' + receipt.revision);
      } catch (error) {
        process.stdout.write('rejected:' + error.name + ':' + (error.kind ?? 'unknown'));
      }
    `;
    const launch = (actionId: string) =>
      run(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', worker], {
        cwd: path.resolve('.'),
        env: { ...process.env, MISSION_DIRECTORY: directory, MISSION_ACTION_ID: actionId },
      });

    const results = await Promise.all([launch('process-one'), launch('process-two')]);
    const outputs = results.map((result) => result.stdout);
    expect(outputs.sort()).toEqual(['committed:1', 'rejected:MissionStoreConflictError:revision']);
    expect((await new JsonlMissionStore(directory).load('mission-process')).revision).toBe(1);
  });

  it.skipIf(process.platform !== 'linux')(
    'recovers a writer lock whose same-host owner process died',
    async () => {
      const incarnation = await currentLinuxProcessIncarnation();
      const lock = `${journalPath()}.lock`;
      await new JsonlMissionStore(directory).load('mission-one');
      const deadGeneration = ticketPath(lock, 1, DEAD_LOCK_TOKEN);
      await writeFile(
        deadGeneration,
        lockOwner(DEAD_LOCK_TOKEN, 2_000_000_000, { processIncarnation: incarnation }),
        { mode: 0o600 },
      );

      await expect(commit(new JsonlMissionStore(directory), 0, 'action-one', 'first')).resolves.toMatchObject(
        {
          revision: 1,
        },
      );
      await expect(stat(deadGeneration)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(lock)).resolves.toMatchObject({ mode: expect.any(Number) });
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'retires a stale generation when its live pid belongs to a different process incarnation',
    async () => {
      const current = await currentLinuxProcessIncarnation();
      const staleIncarnation = { ...current, startTimeTicks: '0' } satisfies TestProcessIncarnation;
      const lock = `${journalPath()}.lock`;
      await new JsonlMissionStore(directory).load('mission-one');
      const staleGeneration = ticketPath(lock, 1, DEAD_LOCK_TOKEN);
      await writeFile(
        staleGeneration,
        lockOwner(DEAD_LOCK_TOKEN, process.pid, { processIncarnation: staleIncarnation }),
        { mode: 0o600 },
      );

      await expect(commit(new JsonlMissionStore(directory), 0, 'action-one', 'first')).resolves.toMatchObject(
        { revision: 1 },
      );
      await expect(stat(staleGeneration)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'retires an older-format same-host generation only after its pid is proven absent',
    async () => {
      const lock = `${journalPath()}.lock`;
      await new JsonlMissionStore(directory).load('mission-one');
      const staleGeneration = ticketPath(lock, 1, DEAD_LOCK_TOKEN);
      await writeFile(staleGeneration, lockOwner(DEAD_LOCK_TOKEN, 2_000_000_000), { mode: 0o600 });

      await expect(commit(new JsonlMissionStore(directory), 0, 'action-one', 'first')).resolves.toMatchObject(
        { revision: 1 },
      );
      await expect(stat(staleGeneration)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each(['before', 'after'] as const)(
    'cleans every private contender generation when ticket rename fails %s publication',
    async (failurePoint) => {
      const store = new JsonlMissionStore(directory, {
        renameLockGeneration: async (source, destination) => {
          if (failurePoint === 'after') await rename(source, destination);
          throw new Error(`injected rename failure ${failurePoint} publication`);
        },
      });

      await expect(store.load('mission-one')).rejects.toThrow(
        `injected rename failure ${failurePoint} publication`,
      );
      const lockBase = `${missionJournalFilename('mission-one')}.lock`;
      expect(
        (await readdir(directory)).filter(
          (entry) => entry.startsWith(`${lockBase}.choosing-`) || entry.startsWith(`${lockBase}.ticket-`),
        ),
      ).toEqual([]);
      await expect(stat(path.join(directory, lockBase))).resolves.toMatchObject({
        mode: expect.any(Number),
      });
    },
  );

  it('fails closed on a foreign-host owner without leaking the local contender generation', async () => {
    const lock = `${journalPath()}.lock`;
    await new JsonlMissionStore(directory).load('mission-one');
    const foreignGeneration = ticketPath(lock, 1, LIVE_LOCK_TOKEN);
    await writeFile(
      foreignGeneration,
      lockOwner(LIVE_LOCK_TOKEN, process.pid, { hostname: 'another-runner-host.invalid' }),
      { mode: 0o600 },
    );

    await expect(new JsonlMissionStore(directory).load('mission-one')).rejects.toThrow(
      'the JSONL authority is single-host',
    );
    expect(
      (await readdir(directory)).filter(
        (entry) => entry.includes('.choosing-') || entry.includes('.ticket-'),
      ),
    ).toEqual([path.basename(foreignGeneration)]);
  });

  it('fails closed on an owner without incarnation evidence and cleans the local contender', async () => {
    const lock = `${journalPath()}.lock`;
    await new JsonlMissionStore(directory).load('mission-one');
    const unverifiableGeneration = ticketPath(lock, 1, LIVE_LOCK_TOKEN);
    await writeFile(unverifiableGeneration, lockOwner(LIVE_LOCK_TOKEN, process.pid), { mode: 0o600 });

    await expect(new JsonlMissionStore(directory).load('mission-one')).rejects.toThrow(
      'has no verifiable process incarnation',
    );
    expect(
      (await readdir(directory)).filter(
        (entry) => entry.includes('.choosing-') || entry.includes('.ticket-'),
      ),
    ).toEqual([path.basename(unverifiableGeneration)]);
  });

  it.skipIf(process.platform !== 'linux').each(['writer', 'controller'] as const)(
    'retires only an observed dead %s generation and never its live successor',
    async (kind) => {
      const incarnation = await currentLinuxProcessIncarnation();
      const store = new JsonlMissionStore(directory, {
        lockTimeoutMs: 20,
        controllerTimeoutMs: 20,
        lockPollMs: 2,
      });
      if (kind === 'writer') {
        await store.load('mission-one');
      } else {
        const lease = await store.acquireController('mission-one');
        await lease.release();
      }

      const lock = `${journalPath()}.${kind === 'writer' ? 'lock' : 'controller'}`;
      const deadGeneration = ticketPath(lock, 1, DEAD_LOCK_TOKEN);
      const successorGeneration = ticketPath(lock, 2, LIVE_LOCK_TOKEN);
      const successorOwner = lockOwner(LIVE_LOCK_TOKEN, process.pid, {
        processIncarnation: incarnation,
      });
      await writeFile(
        deadGeneration,
        lockOwner(DEAD_LOCK_TOKEN, 2_000_000_000, { processIncarnation: incarnation }),
        { mode: 0o600 },
      );
      await writeFile(successorGeneration, successorOwner, { mode: 0o600 });

      const contender = new JsonlMissionStore(directory, {
        lockTimeoutMs: 20,
        controllerTimeoutMs: 20,
        lockPollMs: 2,
      });
      if (kind === 'writer') {
        await expect(contender.load('mission-one')).rejects.toMatchObject({
          name: 'MissionStoreLockTimeoutError',
        });
      } else {
        await expect(contender.acquireController('mission-one')).rejects.toMatchObject({
          name: 'MissionControllerBusyError',
        });
      }

      await expect(stat(deadGeneration)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(successorGeneration, 'utf8')).toBe(successorOwner);
    },
  );

  it('ignores an incomplete tail on read and truncates it before the next append', async () => {
    const store = new JsonlMissionStore(directory);
    await commit(store, 0, 'action-one', 'first');
    await appendFile(journalPath(), '{"schemaVersion":1,"torn"', 'utf8');

    await expect(new JsonlMissionStore(directory).load('mission-one')).resolves.toMatchObject({
      revision: 1,
    });
    expect(await readFile(journalPath(), 'utf8')).not.toContain('"torn"');
    await commit(new JsonlMissionStore(directory), 1, 'action-two', 'second');

    const text = await readFile(journalPath(), 'utf8');
    expect(text).not.toContain('"torn"');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trimEnd().split('\n')).toHaveLength(2);
    expect((await store.load('mission-one')).revision).toBe(2);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a journal symlink without truncating its target during crash-tail recovery',
    async () => {
      const victim = path.join(directory, 'unrelated-user-file');
      const original = 'this file has no newline and must survive';
      await writeFile(victim, original, { mode: 0o600 });
      await symlink(victim, journalPath());

      await expect(new JsonlMissionStore(directory).load('mission-one')).rejects.toThrow();
      expect(await readFile(victim, 'utf8')).toBe(original);
    },
  );

  it.skipIf(process.platform === 'win32')('refuses multiply-linked journal files', async () => {
    const victim = path.join(directory, 'linked-user-file');
    await writeFile(victim, 'do not append here\n', { mode: 0o600 });
    await link(victim, journalPath());

    await expect(new JsonlMissionStore(directory).load('mission-one')).rejects.toThrow(
      'must have exactly one filesystem link',
    );
    expect(await readFile(victim, 'utf8')).toBe('do not append here\n');
  });

  it.skipIf(process.platform === 'win32')('refuses a symlinked authority directory', async () => {
    const target = path.join(directory, 'real-authority');
    const linkedDirectory = path.join(directory, 'linked-authority');
    await mkdir(target, { mode: 0o700 });
    await symlink(target, linkedDirectory);

    await expect(new JsonlMissionStore(linkedDirectory).load('mission-one')).rejects.toThrow(
      'must be a real directory',
    );
  });

  it('reserves journal slots for terminal authority after ordinary admission stops', async () => {
    const store = new JsonlMissionStore(directory, {
      maxJournalActions: 3,
      emergencyReserveActions: 2,
      emergencyReserveBytes: 0,
    });
    await commit(store, 0, 'action-one', 'first');
    await expect(commit(store, 1, 'action-two', 'second')).rejects.toMatchObject({
      name: 'MissionJournalLimitError',
      dimension: 'actions',
    });

    await expect(
      store.commit(
        {
          missionId: 'mission-one',
          expectedRevision: 1,
          actionId: 'terminal-action',
          action: {
            type: 'complete-mission',
            guideEpoch: 0,
            outcome: 'failed',
            reason: 'journal admission exhausted',
          },
        },
        [
          {
            type: 'mission-completed',
            guideEpoch: 0,
            outcome: 'failed',
            reason: 'journal admission exhausted',
          },
        ],
      ),
    ).resolves.toMatchObject({ revision: 2 });
  });

  it('preserves start, completion, and review evidence for an authorized reviewer at the exact boundary', async () => {
    const store = new JsonlMissionStore(path.join(directory, 'review-settlement'), {
      maxJournalActions: 8,
      emergencyReserveActions: 5,
      emergencyReserveBytes: 0,
    });
    const kernel = new MissionKernel(store);
    const missionId = 'review-settlement';
    const profile = profiles[0];
    await createLifecycleMission(kernel, missionId);
    let state = await dispatchAccepted(kernel, missionId, 'subject', {
      type: 'record-checkpoint',
      checkpointId: 'subject',
      revisionId: 'subject-revision',
      authorChildId: null,
      clean: true,
    });
    state = await dispatchAccepted(kernel, missionId, 'reserve-reviewer', {
      type: 'spawn-child',
      guideEpoch: state.guideEpoch,
      childId: 'reviewer',
      role: profile.role,
      instruction: 'Review the exact subject.',
      permission: profile.permission,
      agent: profile.agent,
      driverPosture: profile.driverPosture,
      profileId: profile.profileId,
      budget: profile.budget,
      resources: profile.resources,
      projectMcp: profile.projectMcp,
      subjectCheckpointId: 'subject',
    });
    await expect(
      kernel.dispatch({
        missionId,
        expectedRevision: state.revision,
        actionId: 'ordinary-work-is-blocked',
        action: { type: 'begin-guide-turn', guideEpoch: state.guideEpoch, turnId: 'too-late' },
      }),
    ).rejects.toMatchObject({ name: 'MissionJournalLimitError', dimension: 'actions' });

    state = await dispatchAccepted(kernel, missionId, 'start-reviewer', {
      type: 'start-child',
      childId: 'reviewer',
      attemptId: 'attempt-reviewer',
    });
    state = await dispatchAccepted(kernel, missionId, 'complete-reviewer', {
      type: 'complete-child',
      childId: 'reviewer',
      outcome: 'succeeded',
      summary: 'Review passed.',
      usage: { tokens: 1, usd: 0, activeSeconds: 1 },
      artifact: {
        type: 'review',
        checkpointId: 'subject',
        revisionId: 'subject-revision',
        verdict: 'passed',
        highestSeverity: 'none',
        summary: 'No findings.',
      },
    });
    state = await dispatchAccepted(kernel, missionId, 'record-review', {
      type: 'record-review',
      reviewId: 'review-evidence',
      reviewerChildId: 'reviewer',
      checkpointId: 'subject',
      revisionId: 'subject-revision',
      verdict: 'passed',
      highestSeverity: 'none',
      summary: 'No findings.',
    });

    expect(state).toMatchObject({
      revision: 6,
      children: { reviewer: { status: 'succeeded' } },
      reviews: { 'review-evidence': { reviewerChildId: 'reviewer' } },
    });
    expect(
      await new JsonlMissionStore(path.join(directory, 'review-settlement')).load(missionId),
    ).toMatchObject({
      revision: 6,
      actions: expect.any(Array),
    });
  });

  it('preserves a pending human answer at the exact boundary', async () => {
    const store = new JsonlMissionStore(path.join(directory, 'question-settlement'), {
      maxJournalActions: 5,
      emergencyReserveActions: 3,
      emergencyReserveBytes: 0,
    });
    const kernel = new MissionKernel(store);
    const missionId = 'question-settlement';
    let state = await createLifecycleMission(kernel, missionId);
    state = await dispatchAccepted(kernel, missionId, 'raise-question', {
      type: 'raise-question',
      guideEpoch: state.guideEpoch,
      questionId: 'question',
      prompt: 'Which approved behavior should be retained?',
    });

    expect(state.revision).toBe(2); // Exactly the ordinary class limit for this store.
    state = await dispatchAccepted(kernel, missionId, 'answer-question', {
      type: 'answer-question',
      questionId: 'question',
      answer: 'Retain the reviewed behavior.',
    });

    expect(state.questions.question).toMatchObject({
      status: 'answered',
      answer: 'Retain the reviewed behavior.',
    });
  });

  it('retains a final cleanup attempt after a failed cleanup consumes reserve', async () => {
    const store = new JsonlMissionStore(path.join(directory, 'cleanup-settlement'), {
      maxJournalActions: 4,
      emergencyReserveActions: 3,
      emergencyReserveBytes: 0,
    });
    const kernel = new MissionKernel(store);
    const missionId = 'cleanup-settlement';
    let state = await createLifecycleMission(kernel, missionId, ['workspace']);
    state = await dispatchAccepted(kernel, missionId, 'terminal', {
      type: 'complete-mission',
      guideEpoch: state.guideEpoch,
      outcome: 'failed',
      reason: 'Stop before cleanup.',
    });
    state = await dispatchAccepted(kernel, missionId, 'cleanup-failed', {
      type: 'fail-cleanup',
      cleanupId: 'workspace',
      error: 'Transient cleanup failure.',
    });
    state = await dispatchAccepted(kernel, missionId, 'cleanup-completed', {
      type: 'complete-cleanup',
      cleanupId: 'workspace',
    });

    expect(state).toMatchObject({
      revision: 4,
      terminal: { outcome: 'failed' },
      cleanup: { workspace: { status: 'completed', error: null } },
    });
  });

  it('leaves usable ordinary capacity with default options and rejects unsafe custom byte reserves', async () => {
    const defaults = new JsonlMissionStore(directory);
    await expect(commit(defaults, 0, 'default-create', 'default')).resolves.toMatchObject({
      revision: 1,
    });

    expect(
      () =>
        new JsonlMissionStore(path.join(directory, 'unsafe-small'), {
          maxJournalBytes: 4 * 1024 * 1024,
          emergencyReserveBytes: 3 * 1024 * 1024,
        }),
    ).toThrow('must leave at least');
  });

  it('admits checkpoint and workspace safety evidence from reserved near-capacity slots', async () => {
    const store = new JsonlMissionStore(directory, {
      maxJournalActions: 5,
      emergencyReserveActions: 4,
      emergencyReserveBytes: 0,
    });
    await commit(store, 0, 'ordinary-create', 'ordinary');
    await expect(commit(store, 1, 'ordinary-blocked', 'blocked')).rejects.toMatchObject({
      name: 'MissionJournalLimitError',
      dimension: 'actions',
    });

    await expect(
      store.commit(
        {
          missionId: 'mission-one',
          expectedRevision: 1,
          actionId: 'emergency-checkpoint',
          action: {
            type: 'record-checkpoint',
            checkpointId: 'terminal-checkpoint',
            revisionId: 'terminal-revision',
            authorChildId: null,
            clean: false,
          },
        },
        [
          {
            type: 'checkpoint-recorded',
            checkpointId: 'terminal-checkpoint',
            revisionId: 'terminal-revision',
            authorChildId: null,
            clean: false,
          },
        ],
      ),
    ).resolves.toMatchObject({ revision: 2 });
    await expect(
      store.commit(
        {
          missionId: 'mission-one',
          expectedRevision: 2,
          actionId: 'emergency-workspace-reconciliation',
          action: {
            type: 'record-workspace-reconciled',
            childId: 'terminal-writer',
            revisionId: 'terminal-revision',
            disposition: 'quarantined',
            summary: 'Quarantined terminal residue before workspace release.',
          },
        },
        [
          {
            type: 'workspace-reconciled',
            childId: 'terminal-writer',
            revisionId: 'terminal-revision',
            disposition: 'quarantined',
            summary: 'Quarantined terminal residue before workspace release.',
          },
        ],
      ),
    ).resolves.toMatchObject({ revision: 3 });
  });

  it('admits accepted revision handoff from the terminal reserve', async () => {
    const store = new JsonlMissionStore(directory, {
      maxJournalActions: 4,
      emergencyReserveActions: 3,
      emergencyReserveBytes: 0,
    });
    await commit(store, 0, 'ordinary-create', 'ordinary');
    await expect(commit(store, 1, 'ordinary-blocked', 'blocked')).rejects.toMatchObject({
      name: 'MissionJournalLimitError',
      dimension: 'actions',
    });

    await expect(
      store.commit(
        {
          missionId: 'mission-one',
          expectedRevision: 1,
          actionId: 'emergency-handoff',
          action: {
            type: 'record-accepted-revision-handoff',
            checkpointId: 'accepted-checkpoint',
            revisionId: 'accepted-revision',
            backend: 'git',
            repositoryKey: 'example/repository',
            reference: 'refs/heads/noriq/run/accepted',
            status: 'preserved',
          },
        },
        [
          {
            type: 'accepted-revision-handoff-recorded',
            checkpointId: 'accepted-checkpoint',
            revisionId: 'accepted-revision',
            backend: 'git',
            repositoryKey: 'example/repository',
            reference: 'refs/heads/noriq/run/accepted',
            status: 'preserved',
          },
        ],
      ),
    ).resolves.toMatchObject({ revision: 2 });
  });

  it('preserves validation result and terminal slots at the durable JSONL boundary', async () => {
    const commandPolicy = {
      kind: 'command' as const,
      policyId: 'tight-jsonl-validation-v1',
      command: 'true',
      timeoutSeconds: 10,
      shell: null,
    };
    const initialize = async (store: JsonlMissionStore, missionId: string) => {
      const kernel = new MissionKernel(store);
      await kernel.dispatch({
        missionId,
        expectedRevision: 0,
        actionId: 'create',
        action: {
          type: 'create-mission',
          projectMcpDeclarationFingerprint: null,
          budget: { tokens: 100, usd: null, activeSeconds: 100 },
          resources: {},
          guide,
          profiles,
          validationPolicy: commandPolicy,
        },
      });
      await kernel.dispatch({
        missionId,
        expectedRevision: 1,
        actionId: 'checkpoint',
        action: {
          type: 'record-checkpoint',
          checkpointId: 'checkpoint',
          revisionId: 'revision',
          authorChildId: null,
          clean: true,
        },
      });
      return kernel;
    };
    const begin = (kernel: MissionKernel, missionId: string) =>
      kernel.dispatch({
        missionId,
        expectedRevision: 2,
        actionId: 'begin-validation',
        action: {
          type: 'begin-validation',
          validationId: 'validation',
          checkpointId: 'checkpoint',
          revisionId: 'revision',
          policyId: commandPolicy.policyId,
        },
      });

    const tooTight = new JsonlMissionStore(path.join(directory, 'too-tight'), {
      maxJournalActions: 5,
      emergencyReserveActions: 1,
      emergencyReserveBytes: 0,
    });
    const tightKernel = await initialize(tooTight, 'tight-jsonl');
    await expect(begin(tightKernel, 'tight-jsonl')).rejects.toMatchObject({
      name: 'MissionJournalLimitError',
      dimension: 'actions',
    });

    const exactFit = new JsonlMissionStore(path.join(directory, 'exact-fit'), {
      maxJournalActions: 6,
      emergencyReserveActions: 1,
      emergencyReserveBytes: 0,
    });
    const exactKernel = await initialize(exactFit, 'exact-jsonl');
    await expect(begin(exactKernel, 'exact-jsonl')).resolves.toMatchObject({ accepted: true });
    await expect(
      exactKernel.dispatch({
        missionId: 'exact-jsonl',
        expectedRevision: 3,
        actionId: 'record-validation',
        action: {
          type: 'record-validation',
          validationId: 'validation',
          checkpointId: 'checkpoint',
          revisionId: 'revision',
          policyId: commandPolicy.policyId,
          disposition: 'failed',
          exitCode: 1,
          timedOut: false,
          workspaceChanged: false,
          outputTail: 'failed',
        },
      }),
    ).resolves.toMatchObject({ accepted: true });
    await expect(
      exactKernel.dispatch({
        missionId: 'exact-jsonl',
        expectedRevision: 4,
        actionId: 'terminal',
        action: {
          type: 'complete-mission',
          guideEpoch: 0,
          outcome: 'failed',
          reason: 'validation failed',
        },
      }),
    ).resolves.toMatchObject({ accepted: true, state: { status: 'failed' } });
  });

  it('fails closed when a complete record is valid JSON but its event no longer matches its hash', async () => {
    const store = new JsonlMissionStore(directory);
    await commit(store, 0, 'action-one', 'first');
    const record = JSON.parse(await readFile(journalPath(), 'utf8')) as {
      events: Array<{ event: { budget: { tokens: number | null } } }>;
    };
    record.events[0]!.event.budget.tokens = 999_999;
    await writeFile(journalPath(), `${JSON.stringify(record)}\n`, 'utf8');

    await expect(new JsonlMissionStore(directory).load('mission-one')).rejects.toBeInstanceOf(
      MissionJournalCorruptionError,
    );
  });

  it('fails closed on malformed complete JSON instead of treating it as a crash tail', async () => {
    const store = new JsonlMissionStore(directory);
    await commit(store, 0, 'action-one', 'first');
    await appendFile(journalPath(), '{not-json}\n', 'utf8');

    await expect(store.load('mission-one')).rejects.toMatchObject({
      name: 'MissionJournalCorruptionError',
      line: 2,
    });
  });

  it('enumerates corrupt journals as isolated failures while retaining healthy missions', async () => {
    const store = new JsonlMissionStore(directory);
    await commit(store, 0, 'action-one', 'first');
    const corruptFilename = missionJournalFilename('mission-corrupt');
    await writeFile(path.join(directory, corruptFilename), '{not-json}\n', {
      encoding: 'utf8',
      mode: 0o600,
    });

    const entries = await new JsonlMissionStore(directory).listMissionEntries();

    expect(entries).toContainEqual({ missionId: 'mission-one' });
    expect(entries).toContainEqual({
      missionId: `journal:${corruptFilename}`,
      error: expect.stringContaining(`cannot enumerate corrupt mission journal '${corruptFilename}'`),
    });
    await expect(new JsonlMissionStore(directory).listMissionIds()).rejects.toThrow(
      `cannot enumerate corrupt mission journal '${corruptFilename}'`,
    );
  });

  it('maps arbitrary mission ids to a confined opaque filename', () => {
    const filename = missionJournalFilename('../../Project NOD/safe');
    expect(filename).toMatch(/^mission-[a-f0-9]{64}\.jsonl$/);
    expect(filename).not.toContain('Project NOD');
    expect(path.dirname(path.join(directory, filename))).toBe(directory);
  });
});
