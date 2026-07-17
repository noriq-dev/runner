import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProjectManifest } from '@noriq-dev/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { legacyNetworkKinds, loadManifest, manifestPath } from '../src/discovery';
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

describe('a manifest written before RUN-88 still loads — and says so', () => {
  // `network` was in the schema — and written into EVERY manifest init-project generated — for a
  // year before RUN-88 removed it as unenforced. Those files are committed, in repos on disk, and
  // nobody is going to edit them because a runner upgraded.
  //
  // So this seam has to do TWO things, and the second is the whole point of the task. Accepting
  // the file keeps those repos dispatchable (zod strips unknowns rather than rejecting). But
  // accepting it SILENTLY would leave `network = "none"` sitting in a committed file, reading
  // like a firewall to everyone who opens it, while the daemon hands the agent full egress —
  // the exact false assurance RUN-88 exists to destroy, now with the schema's own denial of it
  // removed as evidence. Compatibility must not be quiet here.
  const LEGACY = `
key = "PROJ"
[verify]
cmd = "npm test"
[permissions.scope]
write = false
network = "none"
[permissions.build]
write = true
network = "restricted"
allow = ["Bash(npm test:*)"]
[permissions.verify]
write = false
network = "full"
`;

  it('ignores the removed `network` key instead of refusing the file (RUN-88)', async () => {
    await write(LEGACY);
    const spy = spyLogger();
    const loaded = await loadManifest(dir, spy.logger);
    expect(loaded?.key).toBe('PROJ');
    // The floor still means what it says, and the dead key is simply gone from the parsed value.
    expect(loaded?.permissions.scope.write).toBe(false);
    expect(loaded?.permissions.build.write).toBe(true);
    expect(loaded?.permissions.build.allow).toEqual(['Bash(npm test:*)']);
    expect(loaded?.permissions.scope).not.toHaveProperty('network');
    await write(BASE);
  });

  it('WARNS that the declared egress is ignored, naming every kind that declares it (RUN-88)', async () => {
    await write(LEGACY);
    const spy = spyLogger();
    await loadManifest(dir, spy.logger);
    const warned = spy.lines.find((l) => l.level === 'warn' && l.msg.includes('network'));
    // A repo whose file claims `none` must be TOLD the claim is void — not left to discover it by
    // grepping the drivers for a key that no longer exists.
    expect(warned).toBeDefined();
    expect(warned?.msg).toMatch(/REMOVED|ignored/);
    expect(warned?.msg).toMatch(/full network egress/i);
    // Every kind, not just the first: `full` is as much a lie as `none` once nothing reads it.
    expect(warned?.meta).toMatchObject({ kinds: ['scope', 'build', 'verify'] });
    await write(BASE);
  });

  it('stays quiet for a manifest that never had the key — no warning as background noise (RUN-88)', async () => {
    await write(BASE);
    const spy = spyLogger();
    await loadManifest(dir, spy.logger);
    // A warning that fires for everyone is a warning nobody reads, including the repos that
    // actually carry the dead key.
    expect(spy.lines.filter((l) => l.level === 'warn')).toEqual([]);
  });
});

describe('legacyNetworkKinds', () => {
  it('finds the dead key per kind, and nothing where there is none (RUN-88)', () => {
    expect(legacyNetworkKinds({ permissions: { scope: { write: false, network: 'none' } } })).toEqual([
      'scope',
    ]);
    expect(legacyNetworkKinds({ permissions: { build: { write: true } } })).toEqual([]);
    expect(legacyNetworkKinds({ key: 'PROJ' })).toEqual([]);
  });

  it('does not throw on shapes a hand-edited file can actually contain (RUN-88)', () => {
    // It runs against RAW toml, before the schema has vouched for anything — so every branch here
    // is reachable from a real typo, and a crash would take out discovery for the whole scan root.
    expect(legacyNetworkKinds(null)).toEqual([]);
    expect(legacyNetworkKinds(undefined)).toEqual([]);
    expect(legacyNetworkKinds({ permissions: 'nonsense' })).toEqual([]);
    expect(legacyNetworkKinds({ permissions: { scope: null } })).toEqual([]);
    expect(legacyNetworkKinds({ permissions: { scope: 'oops' } })).toEqual([]);
  });
});

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
    verify: { cmd: 'npm test', timeoutSeconds: null, shell: null, agent: null },
    tool: null,
    defaultBranch: null,
    land: null,
    permissions: {
      scope: { write: false, allow: [], deny: [], auto: false },
      build: { write: true, allow: [], deny: [], auto: false },
      verify: { write: false, allow: [], deny: [], auto: false },
    },
    // No per-kind model/effort: this repo takes whatever the tool defaults to (RUN-33).
    defaults: {
      scope: { model: null, effort: null },
      build: { model: null, effort: null },
      verify: { model: null, effort: null },
    },
    ...over,
  });

  it('is quiet when nothing moved', () => {
    expect(changedSections(m(), m())).toEqual([]);
  });

  it('names each section that actually differs', () => {
    expect(
      changedSections(m(), m({ verify: { cmd: 'npm ci', timeoutSeconds: null, shell: null, agent: null } })),
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
