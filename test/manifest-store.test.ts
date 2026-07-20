import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProjectManifest } from '@noriq-dev/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadManifest, manifestPath } from '../src/discovery';
import { ManifestStore, changedSections } from '../src/manifest-store';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'noriq-manifest-'));
  await mkdir(path.join(dir, '.noriq'), { recursive: true });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (toml: string) => writeFile(manifestPath(dir), toml);

const BASE = `
key = "PROJ"
[verify]
cmd = "npm test"
[permissions.scope]
write = false
[permissions.build]
write = true
allow = ["Bash(npm test:*)"]
[permissions.verify]
write = false
`;

/** Collects what the daemon would have logged. */
function spyLogger() {
  const lines: Array<{ level: string; msg: string; meta?: unknown }> = [];
  return {
    lines,
    logger: {
      debug: (msg: string, meta?: unknown) => lines.push({ level: 'debug', msg, meta }),
      info: (msg: string, meta?: unknown) => lines.push({ level: 'info', msg, meta }),
      warn: (msg: string, meta?: unknown) => lines.push({ level: 'warn', msg, meta }),
      error: (msg: string, meta?: unknown) => lines.push({ level: 'error', msg, meta }),
    },
  };
}

describe('the committed marker is re-read per run (no restart)', () => {
  it('picks up an edit without anything restarting', async () => {
    await write(BASE);
    const store = new ManifestStore();
    expect((await store.current(dir))?.verify?.cmd).toBe('npm test');

    // Edit the file the way a human (or a landed diff) would.
    await write(BASE.replace('cmd = "npm test"', 'cmd = "npm ci && npm test"'));
    expect((await store.current(dir))?.verify?.cmd).toBe('npm ci && npm test');
  });

  it('says which sections changed, so an edit is never silent', async () => {
    await write(BASE);
    const spy = spyLogger();
    const store = new ManifestStore({ logger: spy.logger });
    await store.current(dir);

    await write(BASE.replace('cmd = "npm test"', 'cmd = "npm run typecheck"'));
    await store.current(dir);

    const changed = spy.lines.find((l) => l.msg.includes('project.toml changed'));
    expect(changed?.meta).toMatchObject({ changed: ['verify'] });
  });

  it('WARNS when the change touches the security floor', async () => {
    await write(BASE);
    const spy = spyLogger();
    const store = new ManifestStore({ logger: spy.logger });
    await store.current(dir);

    // With [land] configured, an agent can land an edit to this very file — so a widened
    // permission taking effect on the next run must be said out loud, not buried.
    await write(BASE.replace('allow = ["Bash(npm test:*)"]', 'allow = ["Bash(npm test:*)", "Bash(curl:*)"]'));
    await store.current(dir);

    const warn = spy.lines.find((l) => l.level === 'warn');
    expect(warn?.msg).toContain('SECURITY floor');
    expect(warn?.meta).toMatchObject({ changed: ['permissions'] });
  });

  it('does not cry change on the first read after discovery seeded it', async () => {
    await write(BASE);
    const spy = spyLogger();
    const store = new ManifestStore({ logger: spy.logger });
    store.seed(dir, (await loadManifest(dir)) as ProjectManifest);
    await store.current(dir);
    expect(spy.lines.filter((l) => l.msg.includes('changed'))).toEqual([]);
  });

  it('keeps the last good config when the file goes invalid, and says so', async () => {
    await write(BASE);
    const spy = spyLogger();
    const store = new ManifestStore({ logger: spy.logger });
    await store.current(dir);

    await write('this is not { valid toml');
    const still = await store.current(dir);

    // A typo mid-session must not take every dispatch down — but it must not pass
    // unnoticed either.
    expect(still?.verify?.cmd).toBe('npm test');
    expect(spy.lines.find((l) => l.level === 'error')?.msg).toContain('last good config');
  });

  it('returns null when the marker was never valid to begin with', async () => {
    await write('nonsense');
    expect(await new ManifestStore().current(dir)).toBeNull();
  });

  it('survives the file being deleted out from under it', async () => {
    await write(BASE);
    const store = new ManifestStore();
    await store.current(dir);
    await rm(manifestPath(dir));
    expect((await store.current(dir))?.key).toBe('PROJ'); // last good
    await write(BASE);
  });
});

describe('changedSections', () => {
  const m = (over: Partial<ProjectManifest> = {}): ProjectManifest => ({
    key: 'PROJ',
    board: null,
    verify: { cmd: 'npm test', timeoutSeconds: null, shell: null, maxRounds: 2, agent: null },
    tool: null,
    defaultBranch: null,
    land: null,
    permissions: {
      scope: { write: false, network: 'restricted', allow: [], deny: [], auto: false },
      build: { write: true, network: 'restricted', allow: [], deny: [], auto: false },
      verify: { write: false, network: 'restricted', allow: [], deny: [], auto: false },
    },
    // No per-kind model/effort: this repo takes whatever the tool defaults to (RUN-33).
    defaults: {
      scope: { agent: null, model: null, effort: null },
      build: { agent: null, model: null, effort: null },
      verify: { agent: null, model: null, effort: null },
    },
    workflows: {},
    ...over,
  });

  it('is quiet when nothing moved', () => {
    expect(changedSections(m(), m())).toEqual([]);
  });

  it('names each section that actually differs', () => {
    expect(
      changedSections(
        m(),
        m({ verify: { cmd: 'npm ci', timeoutSeconds: null, shell: null, maxRounds: 2, agent: null } }),
      ),
    ).toEqual(['verify']);
    expect(
      changedSections(
        m(),
        m({
          land: {
            branch: 'main',
            mergeTarget: null,
            allowedBranches: [],
            onlyWhenVerifyPasses: true,
            resolveConflicts: true,
            autoPush: false,
          },
        }),
      ),
    ).toEqual(['land']);
  });
});
