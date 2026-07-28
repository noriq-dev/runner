import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectManifest } from '@noriq-dev/shared';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Ecosystem,
  type ManifestChoices,
  defaultKey,
  detectEcosystem,
  refuseAllowRule,
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

  it('emits real [defaults.*] sections for chosen kinds only (RUN-62)', () => {
    const toml = renderProjectManifest({
      key: 'ACME',
      tool: 'claude',
      verifyCmd: 'npm test',
      landBranch: null,
      allow: [],
      defaults: {
        scope: { model: 'claude-opus-4-8', effort: 'high' },
        build: { model: null, effort: null },
        verify: { model: null, effort: 'xhigh' },
      },
    });
    const parsed = ProjectManifest.parse(parseToml(toml));
    expect(parsed.defaults.scope.model).toBe('claude-opus-4-8');
    expect(parsed.defaults.scope.effort).toBe('high');
    expect(parsed.defaults.verify.effort).toBe('xhigh');
    expect(parsed.defaults.verify.model).toBeNull(); // effort without model — independent halves
    expect(parsed.defaults.build.model).toBeNull(); // nothing chosen = inherit
    expect(toml).not.toMatch(/\[defaults\.build\]/); // an all-blank kind gets no empty section
  });

  it('keeps the [defaults] guidance as comments when nothing was chosen', () => {
    // The manifest stays its own documentation: someone opening it later must still see the
    // knob exists, spelled correctly, without reading project.toml.example.
    const toml = renderProjectManifest({
      key: 'X',
      tool: null,
      verifyCmd: null,
      landBranch: null,
      allow: [],
    });
    expect(toml).toMatch(/# \[defaults\.scope\]/);
    const parsed = ProjectManifest.parse(parseToml(toml));
    expect(parsed.defaults.scope.model).toBeNull();
    expect(parsed.defaults.scope.effort).toBeNull();
  });

  it('an all-blank curated [defaults] renders the same as never curating', () => {
    const blank = { model: null, effort: null };
    const toml = renderProjectManifest({
      key: 'X',
      tool: null,
      verifyCmd: null,
      landBranch: null,
      allow: [],
      defaults: { scope: { ...blank }, build: { ...blank }, verify: { ...blank } },
    });
    expect(toml).toMatch(/# \[defaults\.scope\]/);
    expect(toml).not.toMatch(/^\[defaults\./m);
  });

  it('chosen advanced values replace the comment hints (RUN-63)', () => {
    const toml = renderProjectManifest({
      key: 'X',
      tool: null,
      verifyCmd: 'npm test',
      verifyShell: 'bash',
      verifyTimeoutSeconds: 900,
      // maxRounds: 0 on purpose — a real choice (pure gate, no hand-back), and the falsy value
      // a truthiness test in the renderer would silently swallow back into the comment hint.
      reviewer: { model: null, effort: 'high', maxRounds: 0 },
      landBranch: null,
      allow: [],
    });
    const parsed = ProjectManifest.parse(parseToml(toml));
    expect(parsed.verify?.shell).toBe('bash');
    expect(parsed.verify?.timeoutSeconds).toBe(900);
    expect(parsed.verify?.agent?.effort).toBe('high');
    expect(parsed.verify?.agent?.maxRounds).toBe(0);
  });

  it('unchosen advanced knobs stay commented, so the schema defaults ride through (RUN-63)', () => {
    const toml = renderProjectManifest({
      key: 'X',
      tool: null,
      verifyCmd: 'npm test',
      reviewer: { model: null },
      landBranch: null,
      allow: [],
    });
    const parsed = ProjectManifest.parse(parseToml(toml));
    expect(parsed.verify?.shell).toBeNull(); // the platform's own shell stays the default
    expect(parsed.verify?.timeoutSeconds).toBeNull(); // the built-in default
    expect(parsed.verify?.agent?.effort).toBeNull();
    expect(parsed.verify?.agent?.maxRounds).toBe(2); // schema default
  });

  it('an untouched [land] envelope renders byte-for-byte what quick mode writes (RUN-64)', () => {
    // The rule for the whole section: Enter all the way through changes NOTHING in the file.
    // A default restated as a value would read as if someone had chosen it.
    const base = { key: 'X', tool: null, verifyCmd: null, landBranch: 'agents', allow: [] };
    const quick = renderProjectManifest(base);
    const walked = renderProjectManifest({
      ...base,
      land: {
        onlyWhenVerifyPasses: true,
        resolveConflicts: true,
        allowedBranches: [],
        autoPush: false,
        mergeTarget: null,
      },
    });
    expect(walked).toBe(quick);
  });

  it('an untouched [permissions] slice renders byte-for-byte what quick mode writes (RUN-65)', () => {
    const base = { key: 'X', tool: null, verifyCmd: null, landBranch: null, allow: ['Bash(npm ci:*)'] };
    const walked = renderProjectManifest({
      ...base,
      defaultBranch: null,
      permissions: {
        buildAllow: [],
        deny: { scope: [], build: [], verify: [] },
      },
    });
    expect(walked).toBe(renderProjectManifest(base));
  });

  it('renders the curated [permissions] slice, and only where it differs from the floor (RUN-65)', () => {
    const toml = renderProjectManifest({
      key: 'X',
      tool: null,
      verifyCmd: 'npm run check',
      landBranch: null,
      allow: ['Bash(npm test:*)'],
      defaultBranch: 'main',
      permissions: {
        buildAllow: ['Bash(npx prisma migrate:*)'],
        deny: { scope: [], build: ['Bash(rm:*)'], verify: [] },
      },
    });
    const parsed = ProjectManifest.parse(parseToml(toml));
    expect(parsed.defaultBranch).toBe('main');
    expect(parsed.permissions.build.allow).toEqual(['Bash(npm test:*)', 'Bash(npx prisma migrate:*)']);
    expect(parsed.permissions.build.deny).toEqual(['Bash(rm:*)']);
    // The write axis is rendered, never chosen — it stays the floor no matter what was curated.
    expect(parsed.permissions.scope.write).toBe(false);
    expect(parsed.permissions.build.write).toBe(true);
    expect(parsed.permissions.verify.write).toBe(false);
    expect(parsed.permissions.scope.deny).toEqual([]); // no empty deny = [] noise at the floor
    expect(toml).not.toMatch(/deny = \[\]/);
  });

  it('typed [land] answers replace the comment hints and parse (RUN-64)', () => {
    const toml = renderProjectManifest({
      key: 'X',
      tool: null,
      verifyCmd: null,
      landBranch: 'noriq/plan-<planKey>',
      allow: [],
      land: {
        onlyWhenVerifyPasses: false,
        resolveConflicts: false,
        allowedBranches: ['feature/**', 'wip/*'],
        autoPush: true,
        mergeTarget: 'main',
      },
    });
    const parsed = ProjectManifest.parse(parseToml(toml));
    expect(parsed.land?.onlyWhenVerifyPasses).toBe(false);
    expect(parsed.land?.resolveConflicts).toBe(false);
    expect(parsed.land?.allowedBranches).toEqual(['feature/**', 'wip/*']);
    expect(parsed.land?.autoPush).toBe(true);
    expect(parsed.land?.mergeTarget).toBe('main');
  });

  it('drops a mergeTarget arriving without autoPush — the pair is validated before writing (RUN-64)', () => {
    // The wizard never produces this pair (the question is only offered once autoPush is on);
    // the renderer holds the same line for direct callers rather than writing a manifest whose
    // merge request can never exist.
    const toml = renderProjectManifest({
      key: 'X',
      tool: null,
      verifyCmd: null,
      landBranch: 'agents',
      allow: [],
      land: {
        onlyWhenVerifyPasses: true,
        resolveConflicts: true,
        allowedBranches: [],
        autoPush: false,
        mergeTarget: 'main',
      },
    });
    expect(ProjectManifest.parse(parseToml(toml)).land?.mergeTarget).toBeNull();
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

  it('grants the lockfile-pinned install so a fresh worktree can bootstrap its deps', async () => {
    // A fresh run worktree has no node_modules; without an install rule the derived gate exits 127.
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
    await writeFile(path.join(dir, 'package-lock.json'), '{}');
    const eco = await detectEcosystem(dir);
    expect(eco.allow).toContain('Bash(npm ci:*)');
    expect(eco.allow).not.toContain('Bash(npm install:*)'); // never the lockfile-rewriting form
  });

  it('accepts npm-shrinkwrap.json as the pinning lockfile too, not only package-lock.json', async () => {
    // `npm ci` honours a shrinkwrap (the published-package form); a shrinkwrap-only repo still needs
    // the install rule or its fresh worktree can never bootstrap.
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
    await writeFile(path.join(dir, 'npm-shrinkwrap.json'), '{}');
    expect((await detectEcosystem(dir)).allow).toContain('Bash(npm ci:*)');
  });

  it('omits the install rule when no lockfile pins it — one that always fails is worse than none', async () => {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
    const eco = await detectEcosystem(dir);
    expect(eco.allow).not.toContain('Bash(npm ci:*)');
    expect(eco.allow.length).toBeGreaterThan(0); // still authorizes the verify command itself
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

describe('refuseAllowRule (RUN-65)', () => {
  // mapPermission/mapSandbox would never EMIT these from a curated allowlist — the refusal is
  // about the COMMITTED file being honest, not about the driver being defensive.
  it.each(['Bash', 'bash', ' Bash ', 'Bash()', 'Bash(*)', 'Bash(:*)', 'Bash(*:*)', 'Bash( * )'])(
    'refuses %j — every spelling of "any command"',
    (rule) => {
      expect(refuseAllowRule(rule)).toMatch(/THREAT-MODEL/);
    },
  );

  it.each(['danger-full-access', 'Bash(codex --danger-full-access)'])('refuses %j', (rule) => {
    expect(refuseAllowRule(rule)).toMatch(/THREAT-MODEL/);
  });

  it.each([
    'Bash(npm test:*)',
    'Bash(npm ci:*)',
    'Bash(bash scripts/gen.sh:*)', // "bash" as an argument is not bare Bash
    'Read(//tmp/**)',
    'mcp__noriq__get_task',
  ])('allows the narrow rule %j', (rule) => {
    expect(refuseAllowRule(rule)).toBeNull();
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
    // key, tool, cmd, shell, timeout, rounds, reviewer?, land — the advanced knobs left blank
    const res = await run(['ACME', 'claude', 'npm test', '', '', '', '', 'noriq/integration']);
    const parsed = ProjectManifest.parse(parseToml(await readFile(res.manifestPath, 'utf8')));
    expect(parsed.land?.branch).toBe('noriq/integration');
    expect(parsed.land?.autoPush).toBe(false); // the daemon must not publish because a wizard ran
  });

  it('writes the inline reviewer when chosen, with its model (RUN-61)', async () => {
    // key, tool, cmd, shell, timeout, rounds, reviewer?, model, effort, rounds, land
    const res = await run(['ACME', 'claude', 'npm test', '', '', '', 'y', 'claude-opus-4-8', '', '', '']);
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

  it('writes the advanced verify knobs when answered (RUN-63)', async () => {
    // key, tool, cmd, shell, timeout, floor rounds, reviewer?, model, effort, rounds, land
    const res = await run(['ACME', 'claude', 'npm test', 'bash', '900', '3', 'y', '', 'xhigh', '0', '']);
    const parsed = ProjectManifest.parse(parseToml(await readFile(res.manifestPath, 'utf8')));
    expect(parsed.verify?.shell).toBe('bash');
    expect(parsed.verify?.timeoutSeconds).toBe(900);
    expect(parsed.verify?.maxRounds).toBe(3); // the floor's own bound (RUN-94)
    expect(parsed.verify?.agent?.effort).toBe('xhigh');
    expect(parsed.verify?.agent?.maxRounds).toBe(0); // 0 = a pure gate, not "unset"
  });

  it('no cmd → no shell or timeout question (RUN-63)', async () => {
    const asked: string[] = [];
    const answers = asker(['ACME', 'claude', '', '', '']); // key, tool, cmd(blank), reviewer, land
    await run([], {
      ask: async (q, fallback) => {
        asked.push(q);
        return answers(q, fallback);
      },
    });
    expect(asked.some((q) => /shell/i.test(q))).toBe(false);
    expect(asked.some((q) => /timeout/i.test(q))).toBe(false);
  });

  it('no reviewer → no effort or rounds question (RUN-63)', async () => {
    const asked: string[] = [];
    const answers = asker(['ACME', 'claude', 'npm test', '', '', '', '', '']); // reviewer declined
    await run([], {
      ask: async (q, fallback) => {
        asked.push(q);
        return answers(q, fallback);
      },
    });
    expect(asked.some((q) => /shell/i.test(q))).toBe(true); // the cmd DID unlock its knobs
    expect(asked.some((q) => /re-verify rounds/i.test(q))).toBe(true); // the floor's own (RUN-94)
    expect(asked.some((q) => /effort/i.test(q))).toBe(false);
    expect(asked.some((q) => /re-review rounds/i.test(q))).toBe(false); // the reviewer's stayed gated
  });

  it('re-asks on a bad timeout, effort, or rounds instead of writing an invalid manifest (RUN-63)', async () => {
    const res = await run([
      'ACME',
      'claude',
      'npm test',
      '', // no shell pin
      'nope', // timeout: not a number → re-ask
      '-5', // timeout: not positive → re-ask
      '2147484', // timeout: * 1000 overflows Node's 2³¹−1 ms timer (fires at ~1 ms) → re-ask
      '120',
      '9', // floor rounds: out of the 0–5 bound → re-ask (RUN-94)
      '1',
      'y', // reviewer
      '', // model: driver default
      'ultra', // effort: not in the enum → re-ask
      'HIGH', // case-insensitive on purpose — intent, not a magic string
      '7', // rounds: out of the 0–5 bound → re-ask
      '3',
      '', // land: none
    ]);
    const parsed = ProjectManifest.parse(parseToml(await readFile(res.manifestPath, 'utf8')));
    expect(parsed.verify?.timeoutSeconds).toBe(120);
    expect(parsed.verify?.maxRounds).toBe(1);
    expect(parsed.verify?.agent?.effort).toBe('high');
    expect(parsed.verify?.agent?.maxRounds).toBe(3);
  });

  it('carries the ecosystem allowlist through, so a build agent can run the verify it suggested', async () => {
    const res = await run(['ACME', 'claude', 'npm run check', '']);
    const parsed = ProjectManifest.parse(parseToml(await readFile(res.manifestPath, 'utf8')));
    expect(parsed.permissions.build.allow).toEqual(['Bash(npm test:*)']);
  });

  it('holds the driver to what is installed — re-asks a schema-invalid answer (RUN-56)', async () => {
    // `tool` is z.enum(['claude','codex']); discovery silently drops a manifest that fails the
    // schema, so a free-text typo would write a marker that passes the wizard yet never dispatches.
    const res = await run(['ACME', 'gpt', 'claude', '', '', '']);
    const parsed = ProjectManifest.parse(parseToml(await readFile(res.manifestPath, 'utf8')));
    expect(parsed.tool).toBe('claude');
  });

  it('re-asks a schema-valid driver that is not installed on this machine (RUN-56)', async () => {
    // `codex` parses, but only `claude` is on PATH here — a marker naming codex would pass the
    // wizard yet no run on this box could execute it, so the loop rejects it.
    const res = await run(['ACME', 'codex', 'claude', '', '', ''], { installedTools: () => ['claude'] });
    const parsed = ProjectManifest.parse(parseToml(await readFile(res.manifestPath, 'utf8')));
    expect(parsed.tool).toBe('claude');
  });

  it('a blank driver means the runner default (tool = null), not the first installed one', async () => {
    const res = await run(['ACME', '', '', '', '']);
    const parsed = ProjectManifest.parse(parseToml(await readFile(res.manifestPath, 'utf8')));
    expect(parsed.tool).toBeNull();
  });

  it("confirms the daemon's REAL discovery found the marker it just wrote", async () => {
    const lines: string[] = [];
    await run(['ACME', 'claude', '', ''], { out: (l) => lines.push(l) }); // scanRoots defaults to [dir]
    expect(lines.join('\n')).toMatch(/discovery found it/);
  });

  it('warns when the repo is outside every scanRoot — a perfect marker, never discovered', async () => {
    const lines: string[] = [];
    await run(['ACME', 'claude', '', ''], {
      out: (l) => lines.push(l),
      scanRoots: async () => ['/no/such/root'],
    });
    expect(lines.join('\n')).toMatch(/not under any/);
  });

  it('warns when runner.toml lists no scanRoots at all', async () => {
    const lines: string[] = [];
    await run(['ACME', 'claude', '', ''], { out: (l) => lines.push(l), scanRoots: async () => [] });
    expect(lines.join('\n')).toMatch(/no scanRoots|walks nothing/);
  });

  it('reports a missing/unreadable machine config instead of a bare ✓ (RUN-56)', async () => {
    const lines: string[] = [];
    await run(['ACME', 'claude', '', ''], { out: (l) => lines.push(l), scanRoots: async () => null });
    expect(lines.join('\n')).toMatch(/Could not read your machine config/);
  });

  // The advanced tier (RUN-62). Question order after the quick flow's five (key, tool,
  // verify cmd, reviewer y/N, land): the curate fork (skipped under --advanced), then per
  // kind — scope model, scope effort, build model, build effort, verify model, verify effort.

  it('--advanced skips the fork question and asks the six [defaults] questions', async () => {
    const res = await run(
      // key   tool      verify      shell/timeout/rounds  rev  land  s.model         s.eff   b.model/eff  v.model  v.eff
      ['ACME', 'claude', 'npm test', '', '', '', '', '', 'claude-opus-4-8', 'high', '', '', '', 'xhigh'],
      { advanced: true },
    );
    const parsed = ProjectManifest.parse(parseToml(await readFile(res.manifestPath, 'utf8')));
    expect(parsed.defaults.scope.model).toBe('claude-opus-4-8');
    expect(parsed.defaults.scope.effort).toBe('high');
    expect(parsed.defaults.build.model).toBeNull(); // blank = inherit
    expect(parsed.defaults.build.effort).toBeNull();
    expect(parsed.defaults.verify.model).toBeNull();
    expect(parsed.defaults.verify.effort).toBe('xhigh');
  });

  it('the trailing fork question reaches the same tier without the flag', async () => {
    const res = await run(['ACME', 'claude', '', '', '', 'y', '', 'medium', '', '', '', '']);
    const parsed = ProjectManifest.parse(parseToml(await readFile(res.manifestPath, 'utf8')));
    expect(parsed.defaults.scope.effort).toBe('medium');
  });

  it('the fork defaults to N — the quick flow never gains six surprise questions', async () => {
    // No answer for the curate question at all: the asker falls back to the 'N' default,
    // exactly what a user mashing Enter gets. The manifest keeps the commented guidance.
    const res = await run(['ACME', 'claude', '', '']);
    const toml = await readFile(res.manifestPath, 'utf8');
    expect(toml).toMatch(/# \[defaults\.scope\]/);
    expect(toml).not.toMatch(/^\[defaults\./m);
  });

  it('re-asks on a bad effort instead of writing one the schema refuses (rule 1)', async () => {
    const res = await run(['ACME', 'claude', '', '', '', '', 'ultra', 'XHigh'], { advanced: true });
    const parsed = ProjectManifest.parse(parseToml(await readFile(res.manifestPath, 'utf8')));
    // 'ultra' was refused and re-asked; the retry is accepted case-insensitively.
    expect(parsed.defaults.scope.effort).toBe('xhigh');
  });

  it('answering everything blank in the advanced tier still writes a valid manifest', async () => {
    const res = await run(['ACME', 'claude', '', ''], { advanced: true });
    expect(res.wrote).toBe(true);
    const parsed = ProjectManifest.parse(parseToml(await readFile(res.manifestPath, 'utf8')));
    expect(parsed.defaults.scope.model).toBeNull();
    expect(parsed.defaults.verify.effort).toBeNull();
  });

  // The [land] envelope (RUN-64). Question order inside its section: verify gate (Y/n),
  // conflict resolution (Y/n), branch globs, autoPush (y/N), then — only under autoPush —
  // the merge-request target.

  it('Enter all the way through the landing section writes byte-for-byte what quick mode writes (RUN-64)', async () => {
    const quickAnswers = ['ACME', 'claude', '', '', 'noriq/integration'];
    await run(quickAnswers); // the trailing fork question falls back to N
    const quick = await readFile(path.join(dir, '.noriq', 'project.toml'), 'utf8');

    // Same five answers, advanced tier on, every advanced question left at its default.
    await run(['y', ...quickAnswers], { advanced: true }); // 'y' overwrites the first file
    const walked = await readFile(path.join(dir, '.noriq', 'project.toml'), 'utf8');
    expect(walked).toBe(quick);
  });

  it('walks the [land] envelope: every widening is typed, and the pair rides together (RUN-64)', async () => {
    const res = await run(
      [
        'ACME',
        'claude',
        '', // verify cmd: none
        '', // reviewer: no
        'noriq/plan-<planKey>',
        ...['', '', '', '', '', ''], // the six [defaults] questions: all inherit
        'n', // onlyWhenVerifyPasses → false, consequence printed
        'n', // resolveConflicts → false
        'feature/** wip/*', // allowedBranches
        'y', // autoPush → true, THREAT-MODEL line printed
        'main', // mergeTarget — only offered because autoPush is on
      ],
      { advanced: true },
    );
    const parsed = ProjectManifest.parse(parseToml(await readFile(res.manifestPath, 'utf8')));
    expect(parsed.land?.branch).toBe('noriq/plan-<planKey>');
    expect(parsed.land?.onlyWhenVerifyPasses).toBe(false);
    expect(parsed.land?.resolveConflicts).toBe(false);
    expect(parsed.land?.allowedBranches).toEqual(['feature/**', 'wip/*']);
    expect(parsed.land?.autoPush).toBe(true);
    expect(parsed.land?.mergeTarget).toBe('main');
  });

  it('no land branch → the landing section never runs, title and all (RUN-64)', async () => {
    const asked: string[] = [];
    const lines: string[] = [];
    const answers = asker(['ACME', 'claude', '', '', '']); // land: blank
    await run([], {
      advanced: true,
      out: (l) => lines.push(l),
      ask: async (q, fallback) => {
        asked.push(q);
        return answers(q, fallback);
      },
    });
    expect(asked.some((q) => /verify passes|globs|push|merge-request/i.test(q))).toBe(false);
    expect(lines.join('\n')).not.toMatch(/Landing envelope/);
  });

  it('no autoPush → no mergeTarget question: the pair cannot be mistyped into existence (RUN-64)', async () => {
    const asked: string[] = [];
    // key, tool, cmd, reviewer, land, six defaults, gate, resolve, globs, autoPush(blank = N)
    const answers = asker(['ACME', 'claude', '', '', 'agents', '', '', '', '', '', '', '', '', '', '']);
    await run([], {
      advanced: true,
      ask: async (q, fallback) => {
        asked.push(q);
        return answers(q, fallback);
      },
    });
    expect(asked.some((q) => /push/i.test(q))).toBe(true); // the autoPush question was offered
    expect(asked.some((q) => /merge-request/i.test(q))).toBe(false); // its dependent was not
  });

  it('refuses a merge target equal to the landing branch — an MR needs a different base (RUN-64)', async () => {
    const res = await run(
      ['ACME', 'claude', '', '', 'agents', '', '', '', '', '', '', '', '', '', 'y', 'agents', 'main'],
      { advanced: true },
    );
    const parsed = ProjectManifest.parse(parseToml(await readFile(res.manifestPath, 'utf8')));
    // 'agents' (the branch itself) was refused and re-asked; 'main' is accepted.
    expect(parsed.land?.mergeTarget).toBe('main');
  });

  it('prints what each widening means: the unverified-diff and THREAT-MODEL lines (RUN-64)', async () => {
    const lines: string[] = [];
    await run(['ACME', 'claude', '', '', 'agents', '', '', '', '', '', '', 'n', '', '', 'y', ''], {
      advanced: true,
      out: (l) => lines.push(l),
    });
    const text = lines.join('\n');
    expect(text).toMatch(/UNVERIFIED diff/); // answering the gate off says what it means
    expect(text).toMatch(/THREAT-MODEL/); // flipping autoPush names the boundary it crosses
    expect(text).toMatch(/<planKey>/); // the MR ask teaches the per-plan branch template
  });

  // The [permissions] slice and defaultBranch (RUN-65). Question order inside the permissions
  // section: the extra-build-allow loop (blank ends it), then per kind that kind's deny loop
  // (blank ends it). Then the identity section's one question. The per-kind egress question that
  // used to precede each deny loop is gone with the key itself (RUN-88).

  const PERMS_PREFIX = ['ACME', 'claude', '', '', '', ...['', '', '', '', '', '']];
  // key, tool, cmd(blank), reviewer(N), land(blank = no landing section), six [defaults].

  it('appends extra build allow rules to the derived set — never replacing it (RUN-65)', async () => {
    const res = await run(
      [
        ...PERMS_PREFIX,
        'Bash(npx prisma migrate:*)', // the rule people hand-edit in after the first failed run
        'Bash(npm test:*)', // already derived — deduped, not duplicated
        '', // done adding
        ...['', '', ''], // scope/build/verify: deny loops, all at the floor
        '', // defaultBranch
      ],
      { advanced: true },
    );
    const parsed = ProjectManifest.parse(parseToml(await readFile(res.manifestPath, 'utf8')));
    // The derived rule survives (without it the suggested verify command is unrunnable), and
    // the typed one rides alongside it exactly once.
    expect(parsed.permissions.build.allow).toEqual(['Bash(npm test:*)', 'Bash(npx prisma migrate:*)']);
  });

  it('refuses bare `Bash` at INPUT, with the THREAT-MODEL pointer, and re-asks (RUN-65)', async () => {
    const lines: string[] = [];
    const res = await run([...PERMS_PREFIX, 'Bash', 'Bash(*)', 'Bash(npm ci:*)', '', ...['', '', ''], ''], {
      advanced: true,
      out: (l) => lines.push(l),
    });
    const parsed = ProjectManifest.parse(parseToml(await readFile(res.manifestPath, 'utf8')));
    // Neither spelling of "any command" reached the committed file; the narrower retry did.
    expect(parsed.permissions.build.allow).toEqual(['Bash(npm test:*)', 'Bash(npm ci:*)']);
    expect(lines.join('\n')).toMatch(/THREAT-MODEL/);
  });

  it('refuses `danger-full-access` — it grants nothing while reading as everything (RUN-65)', async () => {
    const lines: string[] = [];
    const res = await run([...PERMS_PREFIX, 'danger-full-access', '', ...['', '', ''], ''], {
      advanced: true,
      out: (l) => lines.push(l),
    });
    const toml = await readFile(res.manifestPath, 'utf8');
    expect(toml).not.toMatch(/danger-full-access/);
    expect(lines.join('\n')).toMatch(/THREAT-MODEL/);
    expect(ProjectManifest.parse(parseToml(toml)).permissions.build.allow).toEqual(['Bash(npm test:*)']);
  });

  it('takes per-kind deny rules (RUN-65)', async () => {
    const res = await run(
      [
        ...PERMS_PREFIX,
        '', // no extra build rules
        'Bash(curl:*)', // scope: deny
        '', // scope: done denying
        '', // build: no denies
        '', // verify: no denies
        '', // defaultBranch
      ],
      { advanced: true },
    );
    const parsed = ProjectManifest.parse(parseToml(await readFile(res.manifestPath, 'utf8')));
    expect(parsed.permissions.scope.deny).toEqual(['Bash(curl:*)']);
    expect(parsed.permissions.build.deny).toEqual([]);
  });

  // The wizard's own honesty (RUN-65). `mapSandbox` consumes only write/auto, so codex ignores
  // `deny`; the wizard writes the key anyway (it is in the committed schema and it binds on
  // Claude), so what it must never do is claim it bites everywhere.
  //
  // The egress question this section used to open with is gone (RUN-88). It was the sharper
  // version of the same failure: `network` was read by NO driver, so the wizard spent three
  // lines talking the answerer out of believing their own answer. The tests below now pin the
  // ABSENCE — a wizard question and a schema key are both promises, and neither may exist for
  // egress until something can keep it (RUN-53).

  it('never asks about egress, and never writes an egress key (RUN-88)', async () => {
    const asked: string[] = [];
    const answers = asker([...PERMS_PREFIX, '', '', '', '', '']);
    await run([], {
      advanced: true,
      ask: async (q, fallback) => {
        asked.push(q);
        return answers(q, fallback);
      },
    });
    // No question — the wizard cannot walk someone into configuring something inert.
    expect(asked.some((q) => /network|egress/i.test(q))).toBe(false);
    // No key in the committed file, under any curation path.
    const toml = await readFile(path.join(dir, '.noriq', 'project.toml'), 'utf8');
    expect(toml).not.toMatch(/^\s*network\s*=/m);
    // And the manifest still parses: the key's removal is not a hole, it is an absence.
    expect(ProjectManifest.parse(parseToml(toml)).permissions.build.write).toBe(true);
  });

  it('tells you `deny` does not bind on codex before asking for deny rules (RUN-65)', async () => {
    const lines: string[] = [];
    await run([...PERMS_PREFIX, '', 'Bash(curl:*)', '', '', ''], {
      advanced: true,
      out: (l) => lines.push(l),
    });
    expect(lines.join('\n')).toMatch(/does NOT bind on codex|not bind on codex/i);
  });

  it('the committed file carries the enforcement legend, not just the session (RUN-65)', async () => {
    // The manifest outlives the wizard session by years and travels to people who never ran it.
    // A caveat that exists only in scrollback is a caveat that does not exist.
    const res = await run(['ACME', 'claude', '', '']); // quick mode
    const toml = await readFile(res.manifestPath, 'utf8');
    expect(toml).toMatch(/deny.*ENFORCED on Claude[\s\S]*NOT on codex/);
    expect(toml).toMatch(/write.*: ENFORCED/);
    // The egress gap is stated as a gap in the file itself, not left for a reader to discover
    // by grepping the drivers for a key that isn't there (RUN-88).
    expect(toml).toMatch(/no egress key/i);
    // Still a valid manifest — the legend is comments, and the keys mean what the schema says.
    expect(ProjectManifest.parse(parseToml(toml)).permissions.build.write).toBe(true);
  });

  it('never asks the write flags — the floor is not a preference (RUN-65)', async () => {
    const asked: string[] = [];
    const answers = asker([...PERMS_PREFIX, '', '', '', '', '', '', '', '']);
    await run([], {
      advanced: true,
      ask: async (q, fallback) => {
        asked.push(q);
        return answers(q, fallback);
      },
    });
    // No question moves the write axis, and none offers the driver's auto/bypass mode: those
    // are hand-edits into a file that documents what they cost, not wizard keystrokes.
    expect(asked.some((q) => /\bwrite\b|bypass|sandbox|danger-full-access|auto mode/i.test(q))).toBe(false);
    const parsed = ProjectManifest.parse(
      parseToml(await readFile(path.join(dir, '.noriq', 'project.toml'), 'utf8')),
    );
    // Walked end to end at the floor: the security defaults are exactly what quick mode writes.
    expect(parsed.permissions.scope.write).toBe(false);
    expect(parsed.permissions.build.write).toBe(true);
    expect(parsed.permissions.verify.write).toBe(false);
    expect(parsed.permissions.build.auto).toBe(false);
  });

  it('takes defaultBranch — the one identity field the quick flow never asks (RUN-65)', async () => {
    // buildAllow loop + one deny loop per kind, all ended with a blank; then defaultBranch.
    const res = await run([...PERMS_PREFIX, '', '', '', '', 'main'], { advanced: true });
    const parsed = ProjectManifest.parse(parseToml(await readFile(res.manifestPath, 'utf8')));
    expect(parsed.defaultBranch).toBe('main');
  });

  it('quick mode never asks for a default branch, and never invents one (RUN-65)', async () => {
    const res = await run(['ACME', 'claude', '', '']);
    const parsed = ProjectManifest.parse(parseToml(await readFile(res.manifestPath, 'utf8')));
    expect(parsed.defaultBranch).toBeNull();
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

  // The setup copy speaks the detected backend, not git-by-assumption (RUN-84). These drive the
  // prompts by MATCHING the question text, not by position, because a server-backed VCS skips
  // whole questions (agent conflict-resolution, the push/merge-request tail) — a positional list
  // would silently answer the wrong prompt the moment the order changes.
  const askBy = (rules: Array<[RegExp, string]>) => async (q: string, fallback?: string) =>
    rules.find(([re]) => re.test(q))?.[1] ?? fallback ?? '';

  it('a Diversion repo lands in Diversion words: merged, no push, dv commit (RUN-84)', async () => {
    const asked: string[] = [];
    const lines: string[] = [];
    const res = await run([], {
      advanced: true,
      detectVcsFor: async () => ({ kind: 'diversion', repoId: 'dv.repo.x', reason: 'registry' }),
      ask: async (q, fallback) => {
        asked.push(q);
        return askBy([
          [/Project KEY/, 'ACME'],
          [/Agent driver/, 'claude'],
          [/Auto-land to which branch/, 'noriq/integration'],
        ])(q, fallback);
      },
      out: (l) => lines.push(l),
    });

    // The [land] gate reads "merged", never "rebased".
    expect(asked.some((q) => /verify passes on the merged result/i.test(q))).toBe(true);
    expect(asked.some((q) => /rebased/i.test(q))).toBe(false);
    // Agent conflict-resolution is not even offered — conflicts are server-side.
    expect(asked.some((q) => /resolve mechanical/i.test(q))).toBe(false);
    expect(lines.join('\n')).toMatch(/resolved server-side/);
    // The push / merge-request tail is git-only: neither question appears.
    expect(asked.some((q) => /push/i.test(q))).toBe(false);
    expect(asked.some((q) => /merge-request/i.test(q))).toBe(false);
    expect(lines.join('\n')).toMatch(/already reaches the server/);
    // The commit hint is `dv`, not `git add`.
    expect(lines.join('\n')).toMatch(/dv commit -a -m "Add Noriq marker"/);
    expect(lines.join('\n')).not.toMatch(/git add/);

    const parsed = ProjectManifest.parse(parseToml(await readFile(res.manifestPath, 'utf8')));
    expect(parsed.land?.branch).toBe('noriq/integration');
    expect(parsed.land?.autoPush).toBe(false); // server-backed: nothing to push, MR flow is git-only
    // The rendered [land] block explains the server-side landing instead of git push knobs.
    const toml = await readFile(res.manifestPath, 'utf8');
    expect(toml).toMatch(/reaches the server directly/);
    expect(toml).not.toMatch(/git log/);
  });

  it('a Perforce repo lands to a stream, resolves headless, and submits — never pushes (RUN-84)', async () => {
    const asked: string[] = [];
    const lines: string[] = [];
    await run([], {
      advanced: true,
      detectVcsFor: async () => ({ kind: 'perforce', reason: '.p4config' }),
      ask: async (q, fallback) => {
        asked.push(q);
        return askBy([
          [/Project KEY/, 'ACME'],
          [/Agent driver/, 'claude'],
          [/Auto-land to which branch/, 'main-stream'],
        ])(q, fallback);
      },
      out: (l) => lines.push(l),
    });

    expect(asked.some((q) => /verify passes on the merged result/i.test(q))).toBe(true);
    // p4 resolve runs headless, so the agent-resolution question IS offered — in merge words.
    expect(asked.some((q) => /resolve mechanical merge conflicts/i.test(q))).toBe(true);
    // The landing target is a stream, and the override question says so.
    expect(asked.some((q) => /Stream globs a dispatch may land on/i.test(q))).toBe(true);
    // Perforce submits to the depot — no separate remote to push.
    expect(asked.some((q) => /push/i.test(q))).toBe(false);
    expect(lines.join('\n')).toMatch(/p4 add .* && p4 submit -d "Add Noriq marker"/);
    // RUN-65's identity section speaks the backend too (the merge reconciliation): the TOML key
    // stays `defaultBranch`, but a Perforce operator is asked about a stream, never a branch.
    expect(asked.some((q) => /Default stream \(blank = the run's own base\)/i.test(q))).toBe(true);
    expect(asked.some((q) => /Default branch/i.test(q))).toBe(false);
  });
});

describe('RUN-67 round-trip matrix — everything the wizard can write, discovery parses back', () => {
  // The plan's exit gate as a test. Each cell is one shape of ManifestChoices the wizard can
  // accumulate (plus the direct-caller shapes the renderer must survive), and the assertion is
  // the daemon's OWN read path — parseToml + ProjectManifest, exactly discovery's readManifest —
  // landing on the values that were CHOSEN. Never parse-success alone: a renderer that silently
  // dropped a choice into a schema default would parse green and still be wrong.
  //
  // The oracle below derives every expected field from the choices themselves, encoding the
  // renderer's documented contract rather than its code: emit only what was chosen (RUN-64/65),
  // shell/timeout only alongside cmd (RUN-63), the mergeTarget/autoPush pair validated at write
  // (RUN-28/64), empty-means-no-override surviving a curated rewrite (RUN-41). One oracle for
  // all cells means no cell can under-assert.
  function expectRoundTrip(m: ManifestChoices): void {
    const toml = renderProjectManifest(m);
    const parsed = ProjectManifest.parse(parseToml(toml));

    expect(parsed.key).toBe(m.key);
    expect(parsed.tool).toBe(m.tool);
    expect(parsed.board).toBeNull(); // never asked, never rendered — the example documents it (RUN-71)
    expect(parsed.defaultBranch).toBe(m.defaultBranch ?? null);

    // [verify] exists iff a cmd or a reviewer was chosen. The emission condition IS VerifySpec's
    // refine, which is what makes the refine unreachable from wizard output by construction.
    if (m.verifyCmd || m.reviewer) {
      expect(parsed.verify?.cmd).toBe(m.verifyCmd);
      // shell/timeout are cmd's knobs (RUN-63): rendered only alongside it, dropped for a
      // direct caller who passes them without one.
      expect(parsed.verify?.shell).toBe(m.verifyCmd ? (m.verifyShell ?? null) : null);
      expect(parsed.verify?.timeoutSeconds).toBe(m.verifyCmd ? (m.verifyTimeoutSeconds ?? null) : null);
      if (m.reviewer) {
        expect(parsed.verify?.agent).not.toBeNull();
        expect(parsed.verify?.agent?.model).toBe(m.reviewer.model);
        expect(parsed.verify?.agent?.effort).toBe(m.reviewer.effort ?? null);
        expect(parsed.verify?.agent?.maxRounds).toBe(m.reviewer.maxRounds ?? 2); // schema default
        expect(parsed.verify?.agent?.tool).toBeNull(); // RUN-70's knob is a hand-edit, never rendered
      } else {
        expect(parsed.verify?.agent).toBeNull();
      }
    } else {
      expect(parsed.verify).toBeNull();
      expect(toml).not.toMatch(/^\[verify/m); // no table at all — nothing for the refine to refuse
    }

    // [land] exists iff a branch was named; an untouched envelope parses to the schema defaults.
    if (m.landBranch) {
      expect(parsed.land?.branch).toBe(m.landBranch);
      expect(parsed.land?.onlyWhenVerifyPasses).toBe(m.land?.onlyWhenVerifyPasses ?? true);
      expect(parsed.land?.resolveConflicts).toBe(m.land?.resolveConflicts ?? true);
      expect(parsed.land?.allowedBranches).toEqual(m.land?.allowedBranches ?? []);
      expect(parsed.land?.autoPush).toBe(m.land?.autoPush ?? false);
      // The invalid pair dies at render (RUN-28/64): mergeTarget without autoPush parses to null.
      expect(parsed.land?.mergeTarget).toBe((m.land?.autoPush && m.land.mergeTarget) || null);
      if (!m.land?.allowedBranches?.length) {
        // EMPTY MEANS NO OVERRIDE (RUN-41): no key in the file at all, [] out of the parse —
        // the load-bearing default survives a curated rewrite.
        expect(toml).not.toMatch(/allowedBranches/);
      }
    } else {
      expect(parsed.land).toBeNull();
    }

    // The permission floor is rendered, never chosen; only allow/deny move, and only when chosen.
    expect(parsed.permissions.scope.write).toBe(false);
    expect(parsed.permissions.build.write).toBe(true);
    expect(parsed.permissions.verify.write).toBe(false);
    const expectedAllow = [...new Set([...m.allow, ...(m.permissions?.buildAllow ?? [])])];
    expect(parsed.permissions.build.allow).toEqual(expectedAllow);
    if (!expectedAllow.length) {
      // An empty allowlist is a real state with real consequences: an explanatory comment,
      // never `allow = []` (RUN-65).
      expect(toml).not.toMatch(/^allow\s*=/m);
      expect(toml).toMatch(/# allow = \[/);
    }
    for (const kind of ['scope', 'build', 'verify'] as const) {
      expect(parsed.permissions[kind].deny).toEqual(m.permissions?.deny[kind] ?? []);
      expect(parsed.permissions[kind].auto).toBe(false); // the escape hatch is a hand-edit (RUN-68)
    }
    expect(toml).not.toMatch(/deny = \[\]/); // empty deny lists are floor noise, never rendered

    // Per-kind [defaults] (RUN-33/62): chosen kinds become sections, unchosen kinds inherit.
    for (const kind of ['scope', 'build', 'verify'] as const) {
      expect(parsed.defaults[kind].model).toBe(m.defaults?.[kind].model ?? null);
      expect(parsed.defaults[kind].effort).toBe(m.defaults?.[kind].effort ?? null);
    }
  }

  const CELLS: Array<[name: string, choices: ManifestChoices]> = [
    [
      'quick minimal — no tool, no verify, no land, empty allowlist',
      { key: 'X', tool: null, verifyCmd: null, landBranch: null, allow: [] },
    ],
    [
      'quick full — every quick answer given',
      {
        key: 'ACME',
        tool: 'claude',
        verifyCmd: 'npm run check',
        verifyShell: 'bash',
        verifyTimeoutSeconds: 900,
        reviewer: { model: 'claude-opus-4-8', effort: 'high', maxRounds: 1 },
        landBranch: 'noriq/integration',
        allow: ['Bash(npm ci:*)', 'Bash(npm test:*)'],
      },
    ],
    [
      'cmd without reviewer — the deterministic floor alone',
      { key: 'ACME', tool: null, verifyCmd: 'npm test', landBranch: null, allow: ['Bash(npm test:*)'] },
    ],
    [
      'reviewer without cmd — [verify.agent] alone satisfies the refine',
      { key: 'ACME', tool: null, verifyCmd: null, reviewer: { model: null }, landBranch: null, allow: [] },
    ],
    [
      'empty build allowlist alongside a real verify cmd — the state reads as a choice',
      { key: 'ACME', tool: 'codex', verifyCmd: 'make test', landBranch: null, allow: [] },
    ],
    [
      '[defaults] curated alone',
      {
        key: 'X',
        tool: null,
        verifyCmd: null,
        landBranch: null,
        allow: [],
        defaults: {
          scope: { model: 'claude-opus-4-8', effort: 'high' },
          build: { model: 'claude-sonnet-5', effort: null },
          verify: { model: null, effort: 'xhigh' },
        },
      },
    ],
    [
      '[land] without the envelope extras — a branch named, nothing curated',
      { key: 'X', tool: null, verifyCmd: null, landBranch: 'agents', allow: [] },
    ],
    [
      '[land] with the envelope fully widened',
      {
        key: 'X',
        tool: null,
        verifyCmd: null,
        landBranch: 'noriq/plan-<planKey>',
        allow: [],
        land: {
          onlyWhenVerifyPasses: false,
          resolveConflicts: false,
          allowedBranches: ['feature/**', 'wip/*'],
          autoPush: true,
          mergeTarget: 'main',
        },
      },
    ],
    [
      '[permissions] curated alone — appended allow (deduped at render too) and per-kind deny',
      {
        key: 'X',
        tool: null,
        verifyCmd: 'npm test',
        landBranch: null,
        allow: ['Bash(npm test:*)'],
        permissions: {
          // The duplicate proves the RENDERER dedupes for direct callers, not just the wizard's
          // input loop.
          buildAllow: ['Bash(npx prisma migrate:*)', 'Bash(npm test:*)'],
          deny: { scope: ['Bash(curl:*)'], build: ['Bash(rm:*)'], verify: [] },
        },
      },
    ],
    [
      'defaultBranch curated alone',
      { key: 'X', tool: null, verifyCmd: null, landBranch: null, allow: [], defaultBranch: 'main' },
    ],
    [
      'everything at once — full advanced over a full quick pass',
      {
        key: 'ACME',
        tool: 'claude',
        verifyCmd: 'npm run check',
        verifyShell: 'bash',
        verifyTimeoutSeconds: 120,
        reviewer: { model: 'claude-opus-4-8', effort: 'xhigh', maxRounds: 0 },
        landBranch: 'noriq/plan-<planKey>',
        allow: ['Bash(npm ci:*)', 'Bash(npm test:*)'],
        defaults: {
          scope: { model: 'claude-opus-4-8', effort: 'high' },
          build: { model: null, effort: 'low' },
          verify: { model: null, effort: 'xhigh' },
        },
        land: {
          onlyWhenVerifyPasses: false,
          resolveConflicts: true,
          allowedBranches: ['wip/*'],
          autoPush: true,
          mergeTarget: 'main',
        },
        permissions: {
          buildAllow: ['Bash(npx playwright:*)'],
          deny: { scope: ['Bash(curl:*)'], build: [], verify: [] },
        },
        defaultBranch: 'develop',
      },
    ],
    [
      'trap: mergeTarget without autoPush is dropped at render, never half-honoured later',
      {
        key: 'X',
        tool: null,
        verifyCmd: null,
        landBranch: 'agents',
        allow: [],
        land: {
          onlyWhenVerifyPasses: true,
          resolveConflicts: true,
          allowedBranches: [],
          autoPush: false,
          mergeTarget: 'main',
        },
      },
    ],
    [
      'trap: a curated rewrite with empty allowedBranches keeps the envelope closed',
      {
        key: 'X',
        tool: null,
        verifyCmd: null,
        landBranch: 'agents',
        allow: [],
        land: {
          onlyWhenVerifyPasses: false,
          resolveConflicts: true,
          allowedBranches: [],
          autoPush: true,
          mergeTarget: null,
        },
      },
    ],
  ];

  it.each(CELLS)('%s → parses back to the values chosen', (_name, choices) => {
    expectRoundTrip(choices);
  });

  // The acceptance's "edit-mode no-op rewrite". There is no re-read-and-edit mode yet (overwrite
  // starts blank), so the invariant it names is this one: an advanced walk that changes nothing —
  // EVERY section curated, all at their defaults — rewrites the file byte-for-byte. The
  // per-section variants live above (RUN-64/65); this is all sections at once.
  it('an all-defaults walk of every advanced section is byte-identical to quick mode', () => {
    const base: ManifestChoices = {
      key: 'ACME',
      tool: 'claude',
      verifyCmd: 'npm run check',
      landBranch: 'noriq/integration',
      allow: ['Bash(npm test:*)'],
    };
    const blank = { model: null, effort: null };
    const walked = renderProjectManifest({
      ...base,
      verifyShell: null,
      verifyTimeoutSeconds: null,
      defaults: { scope: { ...blank }, build: { ...blank }, verify: { ...blank } },
      land: {
        onlyWhenVerifyPasses: true,
        resolveConflicts: true,
        allowedBranches: [],
        autoPush: false,
        mergeTarget: null,
      },
      permissions: { buildAllow: [], deny: { scope: [], build: [], verify: [] } },
      defaultBranch: null,
    });
    expect(walked).toBe(renderProjectManifest(base));
  });

  // The same invariant driven through the REAL rewrite path, not the renderer: a marker already
  // on disk, the wizard re-run over it (overwrite confirmed), the advanced tier on, and Enter
  // for every question — the file must come out byte-identical. This is as close to "edit-mode
  // no-op rewrite" as exists: there is no re-read-into-choices edit mode yet (overwrite starts
  // blank, so the same answers must be given), and when one lands its cells belong beside it.
  // The land-section-only variant lives in the runInitProject describe; this walks all four.
  it('rewriting an existing marker through an all-defaults advanced session leaves it byte-identical', async () => {
    // Quick pass: key, tool, cmd, shell, timeout, reviewer(N), land; the trailing fork falls
    // back to N.
    const quickAnswers = ['ACME', 'claude', 'npm run check', '', '', '', 'noriq/integration'];
    await run(quickAnswers);
    const before = await readFile(path.join(dir, '.noriq', 'project.toml'), 'utf8');

    // Rewrite pass over the EXISTING file: overwrite(y), the same quick answers, then every
    // advanced question blank — [defaults] ×6, land envelope ×4 (autoPush stays N, so no
    // mergeTarget question), permissions ×4 (allow loop + three deny loops), defaultBranch.
    await run(['y', ...quickAnswers, ...Array(6).fill(''), ...Array(4).fill(''), ...Array(4).fill(''), ''], {
      advanced: true,
    });
    const after = await readFile(path.join(dir, '.noriq', 'project.toml'), 'utf8');
    expect(after).toBe(before);
  });

  // The glue over phase 2, driven end to end: ONE wizard session curating every section, its
  // file read back through the daemon's own path. Slot order: key, tool, verify cmd, shell,
  // timeout, reviewer? (y), model, effort, rounds, land branch; then [defaults] ×6 (model +
  // effort per kind), the landing envelope (gate, resolve, globs, autoPush, mergeTarget), the
  // permissions loops (extra-allow until blank, then a deny loop per kind), and defaultBranch.
  it('a full advanced wizard session round-trips every chosen value through the real file', async () => {
    const res = await run(
      [
        'ACME',
        'claude',
        'npm run check',
        'bash',
        '900',
        '3', // failing-cmd fix rounds (RUN-94) — a question main added after the branch forked
        'y',
        'claude-opus-4-8',
        'high',
        '1',
        'noriq/plan-<planKey>',
        ...['claude-opus-4-8', 'high', '', 'low', '', 'xhigh'], // [defaults]: scope, build, verify
        'n', // onlyWhenVerifyPasses → false
        'n', // resolveConflicts → false
        'feature/** wip/*', // allowedBranches
        'y', // autoPush → true
        'main', // mergeTarget — offered because autoPush is on
        'Bash(npx prisma migrate:*)', // extra build allow rule
        '', // done adding
        'Bash(curl:*)', // scope: deny
        '', // scope: done
        '', // build: no denies
        '', // verify: no denies
        'develop', // defaultBranch
      ],
      { advanced: true },
    );
    const parsed = ProjectManifest.parse(parseToml(await readFile(res.manifestPath, 'utf8')));
    expect(parsed.key).toBe('ACME');
    expect(parsed.tool).toBe('claude');
    expect(parsed.verify?.cmd).toBe('npm run check');
    expect(parsed.verify?.shell).toBe('bash');
    expect(parsed.verify?.timeoutSeconds).toBe(900);
    expect(parsed.verify?.maxRounds).toBe(3);
    expect(parsed.verify?.agent?.model).toBe('claude-opus-4-8');
    expect(parsed.verify?.agent?.effort).toBe('high');
    expect(parsed.verify?.agent?.maxRounds).toBe(1);
    // `agent: null` — the coordinate slot (RUN-113) grew onto ModelDefault after this branch
    // forked; the wizard does not ask for one, so it round-trips as its schema default.
    expect(parsed.defaults.scope).toEqual({ agent: null, model: 'claude-opus-4-8', effort: 'high' });
    expect(parsed.defaults.build).toEqual({ agent: null, model: null, effort: 'low' });
    expect(parsed.defaults.verify).toEqual({ agent: null, model: null, effort: 'xhigh' });
    expect(parsed.land?.branch).toBe('noriq/plan-<planKey>');
    expect(parsed.land?.onlyWhenVerifyPasses).toBe(false);
    expect(parsed.land?.resolveConflicts).toBe(false);
    expect(parsed.land?.allowedBranches).toEqual(['feature/**', 'wip/*']);
    expect(parsed.land?.autoPush).toBe(true);
    expect(parsed.land?.mergeTarget).toBe('main');
    expect(parsed.permissions.build.allow).toEqual(['Bash(npm test:*)', 'Bash(npx prisma migrate:*)']);
    expect(parsed.permissions.scope.deny).toEqual(['Bash(curl:*)']);
    expect(parsed.defaultBranch).toBe('develop');
  });
});
