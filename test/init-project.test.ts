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
    // key, tool, cmd, shell, timeout, reviewer?, land — the advanced knobs left blank
    const res = await run(['ACME', 'claude', 'npm test', '', '', '', 'noriq/integration']);
    const parsed = ProjectManifest.parse(parseToml(await readFile(res.manifestPath, 'utf8')));
    expect(parsed.land?.branch).toBe('noriq/integration');
    expect(parsed.land?.autoPush).toBe(false); // the daemon must not publish because a wizard ran
  });

  it('writes the inline reviewer when chosen, with its model (RUN-61)', async () => {
    // key, tool, cmd, shell, timeout, reviewer?, model, effort, rounds, land
    const res = await run(['ACME', 'claude', 'npm test', '', '', 'y', 'claude-opus-4-8', '', '', '']);
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
    // key, tool, cmd, shell, timeout, reviewer?, model, effort, rounds, land
    const res = await run(['ACME', 'claude', 'npm test', 'bash', '900', 'y', '', 'xhigh', '0', '']);
    const parsed = ProjectManifest.parse(parseToml(await readFile(res.manifestPath, 'utf8')));
    expect(parsed.verify?.shell).toBe('bash');
    expect(parsed.verify?.timeoutSeconds).toBe(900);
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
    const answers = asker(['ACME', 'claude', 'npm test', '', '', '', '']); // reviewer declined
    await run([], {
      ask: async (q, fallback) => {
        asked.push(q);
        return answers(q, fallback);
      },
    });
    expect(asked.some((q) => /shell/i.test(q))).toBe(true); // the cmd DID unlock its knobs
    expect(asked.some((q) => /effort/i.test(q))).toBe(false);
    expect(asked.some((q) => /rounds/i.test(q))).toBe(false);
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
      // key   tool      verify      shell/timeout  rev  land  s.model            s.eff   b.model/eff  v.model  v.eff
      ['ACME', 'claude', 'npm test', '', '', '', '', 'claude-opus-4-8', 'high', '', '', '', 'xhigh'],
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
