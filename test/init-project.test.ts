import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectManifest } from '@noriq-dev/shared';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Ecosystem,
  defaultKey,
  detectEcosystem,
  renderProjectManifest,
  runInitProject,
  scanRootWarning,
} from '../src/init-project';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'noriq-initproj-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const NPM: Ecosystem = { name: 'npm', verifyCmd: 'npm run check', allow: ['Bash(npm test:*)'] };

/** Drive the prompts with canned answers, in order. */
const asker = (answers: string[]) => {
  let i = 0;
  return async (_q: string, fallback?: string) => answers[i++] ?? fallback ?? '';
};

const run = (answers: string[], over: Parameters<typeof runInitProject>[0] = {}) =>
  runInitProject({
    cwd: dir,
    ask: asker(answers),
    out: () => {},
    detect: async () => NPM,
    scanRoots: async () => [dir],
    detectVcsFor: async () => undefined, // no dv spawns from tests
    // Pinned, NOT detected: the canned answers below are positional, so whether the driver
    // question exists must not depend on which CLIs the host happens to have. Un-pinned, this
    // suite was green on dev machines (claude installed → question asked) and red on every
    // GitHub runner (no CLIs → question skipped, every answer shifted one slot).
    installedTools: () => ['claude'],
    ...over,
  });

describe('renderProjectManifest → a manifest the daemon actually accepts', () => {
  // The point of the whole command. A wizard that emits TOML the schema rejects is worse than
  // no wizard, because the failure surfaces at dispatch rather than at setup.
  it('produces TOML that parses as a valid ProjectManifest', () => {
    const toml = renderProjectManifest({
      key: 'ACME',
      tool: 'claude',
      verifyCmd: 'npm run check',
      landBranch: 'noriq/integration',
      allow: ['Bash(npm test:*)'],
    });
    const parsed = ProjectManifest.parse(parseToml(toml));
    expect(parsed.key).toBe('ACME');
    expect(parsed.tool).toBe('claude');
    expect(parsed.verify?.cmd).toBe('npm run check');
    expect(parsed.land?.branch).toBe('noriq/integration');
    expect(parsed.permissions.build.allow).toContain('Bash(npm test:*)');
  });

  it('is valid at its most minimal — no tool, no verify, no land', () => {
    const parsed = ProjectManifest.parse(
      parseToml(
        renderProjectManifest({ key: 'X', tool: null, verifyCmd: null, landBranch: null, allow: [] }),
      ),
    );
    expect(parsed.key).toBe('X');
    expect(parsed.verify).toBeNull();
    expect(parsed.land).toBeNull(); // omitting [land] must mean OFF, never an inferred branch
  });

  it('keeps the safe permission floor: scope and verify read-only, build writes', () => {
    const parsed = ProjectManifest.parse(
      parseToml(
        renderProjectManifest({ key: 'X', tool: null, verifyCmd: null, landBranch: null, allow: [] }),
      ),
    );
    expect(parsed.permissions.scope.write).toBe(false);
    expect(parsed.permissions.verify.write).toBe(false);
    expect(parsed.permissions.build.write).toBe(true);
  });

  it('escapes a Windows-shaped verify command rather than emitting broken TOML', () => {
    // RUN-42's lesson: backslash introduces an escape in a TOML basic string, so C:\… is not a
    // string literal you can just interpolate.
    const toml = renderProjectManifest({
      key: 'X',
      tool: null,
      verifyCmd: String.raw`C:\tools\verify.bat && echo "ok"`,
      landBranch: null,
      allow: [],
    });
    expect(ProjectManifest.parse(parseToml(toml)).verify?.cmd).toBe(
      String.raw`C:\tools\verify.bat && echo "ok"`,
    );
  });
});

describe('scanRootWarning — the cliff only this command can see', () => {
  it('warns when the repo is outside every scanRoot', () => {
    expect(scanRootWarning('/home/me/elsewhere/acme', ['/home/me/code'])).toMatch(/not under any/);
  });

  it('is quiet when the repo is under a scanRoot', () => {
    expect(scanRootWarning('/home/me/code/acme', ['/home/me/code'])).toBeNull();
  });

  it('is quiet when the repo IS the scanRoot', () => {
    expect(scanRootWarning('/home/me/code', ['/home/me/code'])).toBeNull();
  });

  it('does not treat a sibling with a shared prefix as covered', () => {
    // A plain startsWith() says /home/me/code-old is inside /home/me/code. It is not.
    expect(scanRootWarning('/home/me/code-old/acme', ['/home/me/code'])).toMatch(/not under any/);
  });

  it("stays quiet with no config — that is `init`'s error to report, not this one's", () => {
    expect(scanRootWarning('/anywhere', null)).toBeNull();
    expect(scanRootWarning('/anywhere', [])).toBeNull();
  });
});

describe('detectEcosystem', () => {
  it('prefers a `check` script — the one the humans already run', async () => {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { check: 'x', test: 'y' } }));
    expect((await detectEcosystem(dir)).verifyCmd).toBe('npm run check');
  });

  it('falls back to typecheck && test, because vitest does not catch type errors', async () => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'x', test: 'y' } }),
    );
    expect((await detectEcosystem(dir)).verifyCmd).toBe('npm run typecheck && npm test');
  });

  it('still returns an allowlist when it cannot suggest a command', async () => {
    // Otherwise a build agent gets a manifest with no rules and cannot run anything at all.
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    const eco = await detectEcosystem(dir);
    expect(eco.verifyCmd).toBeNull();
    expect(eco.allow.length).toBeGreaterThan(0);
  });

  it('survives an unparseable package.json during setup', async () => {
    await writeFile(path.join(dir, 'package.json'), '{ not json');
    await expect(detectEcosystem(dir)).resolves.toMatchObject({ name: 'npm' });
  });

  it('detects cargo and go', async () => {
    await writeFile(path.join(dir, 'Cargo.toml'), '');
    expect((await detectEcosystem(dir)).name).toBe('cargo');
    await rm(path.join(dir, 'Cargo.toml'));
    await writeFile(path.join(dir, 'go.mod'), '');
    expect((await detectEcosystem(dir)).name).toBe('go');
  });

  it('returns unknown, with no rules, for a bare directory', async () => {
    expect(await detectEcosystem(dir)).toMatchObject({ name: 'unknown', verifyCmd: null, allow: [] });
  });
});

describe('defaultKey', () => {
  it('shouts the directory name', () => expect(defaultKey('/home/me/acme')).toBe('ACME'));
  it('strips punctuation and truncates to the 8-char limit', () =>
    expect(defaultKey('/home/me/my-very-long-repo')).toBe('MYVERYLO'));
  it('never returns empty for a punctuation-only name', () =>
    expect(defaultKey('/home/me/___')).toBe('PROJ'));
});

describe('runInitProject', () => {
  it('writes a marker the schema accepts', async () => {
    const res = await run(['ACME', 'claude', 'npm run check', '']);
    expect(res.wrote).toBe(true);
    expect(res.key).toBe('ACME');
    const parsed = ProjectManifest.parse(parseToml(await readFile(res.manifestPath, 'utf8')));
    expect(parsed.key).toBe('ACME');
    expect(parsed.land).toBeNull(); // blank land answer must mean OFF
  });

  it('re-asks on a bad key instead of writing an unresolvable one', async () => {
    const res = await run(['no spaces!', 'way-too-long-key', 'OK', 'claude', '', '']);
    expect(res.key).toBe('OK');
  });

  it('uppercases a lowercase key', async () => {
    expect((await run(['acme', 'claude', '', ''])).key).toBe('ACME');
  });

  it('never clobbers an existing marker without a yes', async () => {
    await run(['ACME', 'claude', '', '']);
    const before = await readFile(path.join(dir, '.noriq', 'project.toml'), 'utf8');

    const res = await run(['N', 'OTHER', 'claude', '', '']);
    expect(res.wrote).toBe(false);
    expect(await readFile(path.join(dir, '.noriq', 'project.toml'), 'utf8')).toBe(before);
  });

  it('overwrites when told to', async () => {
    await run(['ACME', 'claude', '', '']);
    const res = await run(['y', 'NEW', 'claude', '', '']);
    expect(res.wrote).toBe(true);
    expect(res.key).toBe('NEW');
  });

  it('takes the land branch only when one is typed', async () => {
    const res = await run(['ACME', 'claude', 'npm test', '', 'noriq/integration']);
    const parsed = ProjectManifest.parse(parseToml(await readFile(res.manifestPath, 'utf8')));
    expect(parsed.land?.branch).toBe('noriq/integration');
    expect(parsed.land?.autoPush).toBe(false); // the daemon must not publish because a wizard ran
  });

  it('writes the inline reviewer when chosen, with its model (RUN-61)', async () => {
    const res = await run(['ACME', 'claude', 'npm test', 'y', 'claude-opus-4-8', '']);
    const parsed = ProjectManifest.parse(parseToml(await readFile(res.manifestPath, 'utf8')));
    expect(parsed.verify?.cmd).toBe('npm test');
    expect(parsed.verify?.agent?.model).toBe('claude-opus-4-8');
    expect(parsed.verify?.agent?.maxRounds).toBe(2); // schema default rides through
  });

  it('reviewer-only is a valid verify stage — no cmd required (RUN-61)', async () => {
    const res = await run(['ACME', 'claude', '', 'y', '', '']);
    const parsed = ProjectManifest.parse(parseToml(await readFile(res.manifestPath, 'utf8')));
    expect(parsed.verify?.cmd).toBeNull();
    expect(parsed.verify?.agent).not.toBeNull();
    expect(parsed.verify?.agent?.model).toBeNull(); // blank = the driver's default
  });

  it('carries the ecosystem allowlist through, so a build agent can run the verify it suggested', async () => {
    const res = await run(['ACME', 'claude', 'npm run check', '']);
    const parsed = ProjectManifest.parse(parseToml(await readFile(res.manifestPath, 'utf8')));
    expect(parsed.permissions.build.allow).toEqual(['Bash(npm test:*)']);
  });

  it('warns a Diversion operator BEFORE the marker is committed: there is no dry-run (RUN-60)', async () => {
    const lines: string[] = [];
    await run(['ACME', 'claude', '', ''], {
      out: (l) => lines.push(l),
      detectVcsFor: async () => ({ kind: 'diversion', repoId: 'dv.repo.x', reason: 'registry' }),
    });
    expect(lines.join('\n')).toMatch(/no dry-run/);
    expect(lines.join('\n')).toMatch(/syncs to the cloud/);
  });
});
