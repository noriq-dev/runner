import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JsonlNoriqCoordinatorStore,
  type NoriqMissionCommission,
  computeNoriqMissionCommissionDigest,
} from '../src/mission/noriq-coordinator-store';

const roots: string[] = [];
const LOCK_TOKEN = '00000000-0000-4000-8000-000000000001';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'noriq-coordinator-store-'));
  roots.push(directory);
  return directory;
}

function commission() {
  const body = {
    schemaVersion: 1,
    rootRunId: 'run-root',
    lease: { sitting: 2, executionId: 'execution-root', epoch: 3 },
    executionProfile: {
      id: 'default',
      declarationFingerprint: 'declaration-v1',
      effectiveFingerprint: 'effective-v1',
      generation: 1,
      attestationCapable: true,
    },
    repositoryKey: 'repo-key',
    baseRevision: 'base-revision',
    tasks: [{ taskId: 'task-a', childKey: 'child-a', brief: 'Build A.', dependencyIds: [] }],
    budget: { tokens: 1_000, usd: null, activeSeconds: 100 },
    catalogFingerprint: 'a'.repeat(64),
    resources: {},
  } satisfies Omit<NoriqMissionCommission, 'commissionDigest'>;
  return { ...body, commissionDigest: computeNoriqMissionCommissionDigest(body) };
}

async function commissionedStore(directory: string): Promise<JsonlNoriqCoordinatorStore> {
  const store = new JsonlNoriqCoordinatorStore(directory);
  await store.append('run-root', 0, 'commission', {
    type: 'commissioned',
    commission: commission(),
  });
  return store;
}

const key = (rootRunId: string): string => createHash('sha256').update(rootRunId).digest('hex');
const walPath = (directory: string): string => path.join(directory, `${key('run-root')}.jsonl`);
const writerPath = (directory: string): string => path.join(directory, `${key('run-root')}.write.lock`);
const ticketPath = (writer: string, ticket: number, token = LOCK_TOKEN): string =>
  `${writer}.ticket-${String(ticket).padStart(16, '0')}-${token}`;

interface LinuxProcessIncarnation {
  kind: 'linux-proc';
  bootId: string;
  startTimeTicks: string;
}

async function currentLinuxProcessIncarnation(): Promise<LinuxProcessIncarnation> {
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim().toLowerCase();
  const rawStat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
  const commandEnd = rawStat.lastIndexOf(')');
  const startTimeTicks = rawStat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/)[19];
  if (!startTimeTicks) throw new Error('current process has no Linux start-time identity');
  return { kind: 'linux-proc', bootId, startTimeTicks };
}

const lockOwner = (incarnation: LinuxProcessIncarnation): string =>
  `${JSON.stringify({
    token: LOCK_TOKEN,
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
    processIncarnation: incarnation,
  })}\n`;

describe('JsonlNoriqCoordinatorStore recovery authority', () => {
  it.skipIf(process.platform !== 'linux')(
    'retires a stale process incarnation through a token-unique generation without replacing the namespace',
    async () => {
      const directory = await stateDirectory();
      const store = await commissionedStore(directory);
      const writer = writerPath(directory);
      const namespaceBefore = await stat(writer);
      const current = await currentLinuxProcessIncarnation();
      const stale = ticketPath(writer, 1);
      await writeFile(stale, lockOwner({ ...current, startTimeTicks: '0' }), { mode: 0o600 });

      await expect(store.load('run-root')).resolves.toMatchObject({ revision: 1 });
      await expect(stat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
      const namespaceAfter = await stat(writer);
      expect(namespaceAfter.ino).toBe(namespaceBefore.ino);
      await expect(readFile(writer, 'utf8')).resolves.toBe('noriq-coordinator-bakery-lock-v1\n');
      expect((await readdir(directory)).filter((name) => name.includes('.ticket-'))).toEqual([]);
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'does not repair an unterminated tail until it holds that root writer authority',
    async () => {
      const directory = await stateDirectory();
      await commissionedStore(directory);
      const wal = walPath(directory);
      const writer = writerPath(directory);
      const current = await currentLinuxProcessIncarnation();
      const live = ticketPath(writer, 1);
      await writeFile(live, lockOwner(current), { mode: 0o600 });
      await appendFile(wal, '{"partial":', 'utf8');

      const blocked = new JsonlNoriqCoordinatorStore(directory, {
        lockTimeoutMs: 25,
        lockPollMs: 5,
      });
      await expect(blocked.listRootRunIds()).rejects.toMatchObject({
        name: 'NoriqCoordinatorBusyError',
      });
      await expect(readFile(wal, 'utf8')).resolves.toContain('{"partial":');

      await unlink(live);
      await expect(blocked.listRootRunIds()).resolves.toEqual(['run-root']);
      const repaired = await readFile(wal, 'utf8');
      expect(repaired.endsWith('\n')).toBe(true);
      expect(repaired).not.toContain('{"partial":');
    },
  );

  it('repairs one final unterminated crash tail but preserves corrupt complete records', async () => {
    const directory = await stateDirectory();
    const store = await commissionedStore(directory);
    const wal = walPath(directory);
    await appendFile(wal, '{"uncommitted":true}', 'utf8');

    await expect(store.listRootRunIds()).resolves.toEqual(['run-root']);
    const repaired = await readFile(wal, 'utf8');
    expect(repaired.endsWith('\n')).toBe(true);
    expect(repaired).not.toContain('uncommitted');

    await appendFile(wal, '{"broken":true}\n{"later-tail":', 'utf8');
    await expect(store.listRootRunIds()).rejects.toThrow(/corrupt/);
    const retained = await readFile(wal, 'utf8');
    expect(retained).toContain('{"broken":true}\n');
    expect(retained).toContain('{"later-tail":');
  });

  it('retires a first-record crash tail but still rejects a pre-existing empty WAL', async () => {
    const directory = await stateDirectory();
    const orphan = path.join(directory, `${'b'.repeat(64)}.jsonl`);
    await writeFile(orphan, '{"partial-first-record":', { mode: 0o600 });
    const store = new JsonlNoriqCoordinatorStore(directory);

    await expect(store.listRootRunIds()).resolves.toEqual([]);
    await expect(stat(orphan)).rejects.toMatchObject({ code: 'ENOENT' });

    await writeFile(orphan, '', { mode: 0o600 });
    await expect(store.listRootRunIds()).rejects.toThrow(/empty WAL/);
  });
});
