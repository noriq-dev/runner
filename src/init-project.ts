import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadRunnerConfig } from './config';
import { manifestPath } from './discovery';
import { tomlString } from './init';
import { detectTools } from './tools';
import { type VcsDetection, detectVcs } from './vcs/detect';

/**
 * `noriq-runner init-project` — the guided repo marker (RUN-56).
 *
 * RUN-40 removed the hand-written-TOML cliff for runner.toml and left the other half standing:
 * `init` set up the machine, then told you to copy project.toml.example and edit 130 lines of
 * commentary by hand. That is the same cliff, moved one step later.
 *
 * Follows RUN-40's three rules, because they earned their place — validate before writing, never
 * clobber, and show what it found. The third one is doing the most work here, but it means
 * something different than it did in `init`: see `scanRootWarning`.
 *
 * Deliberately NOT VCS-aware yet (Montana's call). RUN-49 owns that — this command becomes
 * VCS-aware when there is a backend interface to be aware OF, and RUN-54/55 have not reported.
 */

export interface InitProjectDeps {
  /** Injectable for tests — defaults to real prompting over stdin/stdout. */
  ask?: (question: string, fallback?: string) => Promise<string>;
  out?: (line: string) => void;
  /** The repo to mark. Defaults to the process's cwd. */
  cwd?: string;
  /** Injectable so tests don't need a fixture tree on disk. */
  detect?: (cwd: string) => Promise<Ecosystem>;
  /** Injectable so tests never read the real ~/.noriq/runner.toml. */
  scanRoots?: () => Promise<string[] | null>;
  /** Injectable VCS detection (RUN-60) — tests don't need a real dv registry. */
  detectVcsFor?: (root: string) => Promise<VcsDetection | undefined>;
  configPath?: string;
}

export interface InitProjectResult {
  manifestPath: string;
  wrote: boolean;
  key: string;
}

/**
 * What this repo is built with — enough to suggest a verify command and, more importantly, to
 * derive the build agent's allowlist.
 */
export interface Ecosystem {
  name: string;
  /** Suggested [verify] cmd, or null when we cannot honestly guess one. */
  verifyCmd: string | null;
  /** permissions.build.allow — see `detectEcosystem` for why this is not optional. */
  allow: string[];
}

const UNKNOWN: Ecosystem = { name: 'unknown', verifyCmd: null, allow: [] };

/**
 * Guess the ecosystem from what is on disk.
 *
 * The `allow` list is the part that matters, and it is the reason this returns rules rather than
 * just a command string. Bare `Bash` is NEVER granted (THREAT-MODEL.md), so a manifest written
 * with an empty allowlist produces a build agent that cannot run the very verify command this
 * function just suggested — correct, and useless. The allowlist has to arrive with the command.
 *
 * Rules are derived from the DETECTED ECOSYSTEM, never by parsing the verify string. Shell
 * parsing (quoting, `&&`, subshells, env prefixes) is a bug farm, and a wrong allow rule fails
 * closed in a way that looks like the agent being broken.
 */
export async function detectEcosystem(cwd: string): Promise<Ecosystem> {
  const has = (f: string) => existsSync(path.join(cwd, f));

  if (has('package.json')) {
    const npm: string[] = ['Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(npx tsc:*)'];
    try {
      const pkg = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      };
      const s = pkg.scripts ?? {};
      // Prefer a script the repo already treats as "everything" — it is what the humans run.
      if (s.check) return { name: 'npm', verifyCmd: 'npm run check', allow: npm };
      if (s.typecheck && s.test)
        return { name: 'npm', verifyCmd: 'npm run typecheck && npm test', allow: npm };
      if (s.test) return { name: 'npm', verifyCmd: 'npm test', allow: npm };
      return { name: 'npm', verifyCmd: null, allow: npm };
    } catch {
      // Unparseable package.json is still an npm repo — suggest nothing rather than crash on
      // someone's malformed JSON during setup.
      return { name: 'npm', verifyCmd: null, allow: npm };
    }
  }
  if (has('Cargo.toml'))
    return {
      name: 'cargo',
      verifyCmd: 'cargo test',
      allow: ['Bash(cargo test:*)', 'Bash(cargo build:*)', 'Bash(cargo check:*)'],
    };
  if (has('go.mod'))
    return {
      name: 'go',
      verifyCmd: 'go build ./... && go test ./...',
      allow: ['Bash(go build:*)', 'Bash(go test:*)', 'Bash(go vet:*)'],
    };
  if (has('pyproject.toml'))
    return {
      name: 'python',
      verifyCmd: 'pytest',
      allow: ['Bash(pytest:*)', 'Bash(python -m:*)'],
    };
  return UNKNOWN;
}

/** A KEY a human will recognise: this repo's directory, shouted, and short enough to be a key. */
export const defaultKey = (cwd: string): string =>
  path
    .basename(path.resolve(cwd))
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .slice(0, 8) || 'PROJ';

/**
 * The one thing this command knows that the user cannot: whether the daemon will ever SEE this
 * repo.
 *
 * Discovery walks runner.toml's scanRoots for markers. A perfect manifest in a repo outside those
 * roots is never discovered, never dispatchable, and reports NO ERROR anywhere — it simply does
 * not appear. That is RUN-40's "found 0 repos" cliff approached from the other end, and it is
 * worth more than every other line this command prints.
 *
 * Returns null when everything is fine, or when there is no config to check against (that is
 * `init`'s problem to report, not this one's — saying it twice would train people to ignore it).
 */
export function scanRootWarning(repo: string, roots: string[] | null): string | null {
  if (!roots?.length) return null;
  const r = path.resolve(repo);
  const covered = roots.some((root) => {
    const rel = path.relative(path.resolve(root), r);
    // Not covered if we had to climb OUT of the root (..) or cross to another drive (absolute).
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
  return covered ? null : 'this repo is not under any scanRoot — the runner will not find it';
}

export function renderProjectManifest(m: {
  key: string;
  tool: string | null;
  verifyCmd: string | null;
  /** The inline reviewer (RUN-61), when chosen. `model` null = the driver's own default. */
  reviewer?: { model: string | null } | null;
  landBranch: string | null;
  allow: string[];
}): string {
  const lines: string[] = [
    '# Noriq project marker — COMMITTED, so it travels with the repo and your team shares it.',
    '# Written by `noriq-runner init-project`. Carries no secrets.',
    '#',
    '# Every knob, with the reasoning behind it: project.toml.example in @noriq-dev/runner.',
    '',
    '# Portable project identifier. Resolved to a prj_… id per server, so this checkout works',
    '# against any Noriq instance that has a project under this key.',
    `key = ${tomlString(m.key)}`,
  ];

  if (m.tool) {
    lines.push('', '# Default agent driver for this repo.', `tool = ${tomlString(m.tool)}`);
  }

  if (m.verifyCmd) {
    lines.push(
      '',
      '# Deterministic verify floor: the daemon runs this (zero tokens) after a build agent exits',
      "# clean, in the run's worktree. Non-zero exit GATES the run — it cannot reach `done`.",
      '[verify]',
      `cmd = ${tomlString(m.verifyCmd)}`,
      '# shell = "bash"   # pin one if this command is not portable to cmd.exe (mixed-OS teams)',
    );
  } else if (!m.reviewer) {
    lines.push(
      '',
      '# No verify stage configured — every build lands as a review diff and a human is the',
      '# gate. Add the zero-token floor when the repo has a check worth running:',
      '# [verify]',
      '# cmd = "npm run typecheck && npm test"',
    );
  }

  if (m.reviewer) {
    lines.push(
      '',
      '# Inline reviewer: a FRESH agent (never the builder) judges each diff against the task',
      '# intent, read-only and holding no credential; its report goes back to the builder to fix.',
      '[verify.agent]',
      m.reviewer.model
        ? `model = ${tomlString(m.reviewer.model)}`
        : '# model = "claude-opus-4-8"   # blank = the driver\'s default (or [defaults.verify])',
      '# maxRounds = 2   # FAIL → fix → re-review rounds before a human picks it up',
    );
  }

  if (m.landBranch) {
    lines.push(
      '',
      '# Auto-landing: a build that passes the gate is rebased onto this branch, RE-VERIFIED',
      '# there, then fast-forwarded in. Work accumulates here for you to merge onward.',
      '[land]',
      `branch = ${tomlString(m.landBranch)}`,
      '# autoPush = false      # push this branch to its remote. Off = nothing an agent writes',
      '#                       # leaves this machine. See THREAT-MODEL.md before flipping it.',
      '# mergeTarget = "main"  # open a merge request when the run\'s PLAN completes (needs autoPush)',
    );
  } else {
    lines.push(
      '',
      "# Auto-landing is OFF: every run's diff waits on its own branch for you. Turn it on by",
      '# naming a branch — never `main`, and never anything watched by CI or a deploy:',
      '# [land]',
      '# branch = "noriq/integration"',
    );
  }

  lines.push(
    '',
    '# Per-kind security floor. These are the safe defaults: scope and verify are READ-ONLY,',
    '# build gets write in its own worktree. No agent ever gets push credentials — that is',
    '# enforced by the daemon and is not expressible here.',
    '[permissions.scope]',
    'write = false',
    'network = "restricted"',
    '',
    '[permissions.build]',
    'write = true',
    'network = "restricted"',
  );
  // Bare `Bash` is never granted, so without this a build agent cannot run the verify command
  // above. The empty case is left explicit rather than omitted: an empty allowlist is a real
  // state with real consequences, and a reader should see that it was a choice.
  lines.push(
    m.allow.length
      ? `allow = [${m.allow.map(tomlString).join(', ')}]`
      : '# allow = ["Bash(npm test:*)"]   # a build agent cannot run ANY command without rules here',
  );
  lines.push('', '[permissions.verify]', 'write = false', 'network = "restricted"', '');

  return lines.join('\n');
}

export async function runInitProject(deps: InitProjectDeps = {}): Promise<InitProjectResult> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const cwd = deps.cwd ?? process.cwd();
  const target = manifestPath(cwd);

  // Interactive by construction — same contract as `init`, and same reason: under CI or a pipe,
  // readline hits EOF, the pending question never settles, and node exits 0 having written
  // nothing. A setup command that silently succeeds is worse than one that fails.
  if (!deps.ask && !process.stdin.isTTY) {
    throw new Error(
      'init-project is interactive and needs a terminal — run it in a shell, or copy ' +
        'project.toml.example to .noriq/project.toml and edit it by hand.',
    );
  }

  const rl = deps.ask ? null : createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl?.once('close', () => {
    closed = true;
  });
  const ask =
    deps.ask ??
    (async (question: string, fallback?: string) => {
      const suffix = fallback ? ` [${fallback}]` : '';
      const answer = await rl!.question(`${question}${suffix}: `);
      if (closed && answer === undefined)
        throw new Error('input closed — setup aborted, nothing was written');
      return (answer ?? '').trim() || fallback || '';
    });

  try {
    out('');
    out('  Noriq project marker');
    out('  ────────────────────');
    out('');
    out(`  Writing ${path.relative(cwd, target) || target} — this file is COMMITTED, so it`);
    out('  travels to your teammates and their runners obey it too.');
    out('');

    // Rule 2, checked FIRST: finding out we would clobber after four questions wastes the human's
    // time and risks a "y" answered out of momentum.
    if (existsSync(target)) {
      out(`  A marker already exists at ${target}.`);
      const overwrite = (await ask('  Overwrite it? (y/N)', 'N')).toLowerCase();
      if (overwrite !== 'y' && overwrite !== 'yes') {
        out('  Keeping it. Nothing was written.');
        out('');
        return { manifestPath: target, wrote: false, key: '' };
      }
    }

    // Rule 1: validate before writing. The key is the one field with a shape, and a bad one is
    // silently unresolvable on the server rather than loudly wrong here.
    let key = '';
    while (!key) {
      const answer = await ask('  Project KEY (1–8 chars, as in the dashboard)', defaultKey(cwd));
      const candidate = answer.trim().toUpperCase();
      if (/^[A-Z0-9]{1,8}$/.test(candidate)) key = candidate;
      else out('  ✗ 1–8 letters or digits, e.g. ACME. It must match a project on your server.');
    }

    const installed = detectTools();
    const tool = installed.length ? await ask(`  Agent driver (${installed.join(' | ')})`, installed[0]) : '';
    if (!installed.length) out('  No drivers found on PATH — install `claude` or `codex` later.');

    const eco = await (deps.detect ?? detectEcosystem)(cwd);
    if (eco.name !== 'unknown') out(`  Detected a ${eco.name} project.`);

    // Which backend will work this repo (RUN-60) — and the one thing an operator of a live
    // backend must hear BEFORE committing the marker, not at the first dispatch: there is no
    // dry-run there (RUN-48, THREAT-MODEL.md).
    const vcsDet = await (deps.detectVcsFor ?? (async (r: string) => (await detectVcs([r])).get(r)))(cwd);
    if (vcsDet?.kind === 'diversion') {
      out('  This is a Diversion workspace. Know before you commit this marker:');
      out('  every write an agent makes here syncs to the cloud within seconds — before any');
      out('  verify gate, on every run, including failed ones. There is no dry-run mode.');
      out('  See THREAT-MODEL.md ("The Diversion backend, specifically").');
    }
    const verifyCmd = (await ask('  Verify command (blank for none)', eco.verifyCmd ?? undefined)) || null;

    // The other half of the verify choice (RUN-61). Both halves may be blank — no verify stage
    // is a legitimate configuration, not a misconfiguration, so neither question presumes.
    out('');
    out('  An independent reviewer agent can also judge each build against the task intent —');
    out('  a fresh read-only session (optionally a stronger model) whose report is handed back');
    out('  to the builder to fix.');
    const wantReviewer = (await ask('  Add the inline reviewer? (y/N)', 'N')).toLowerCase();
    const reviewer =
      wantReviewer === 'y' || wantReviewer === 'yes'
        ? { model: (await ask("  Reviewer model (blank = the driver's default)")) || null }
        : null;

    // No default, on purpose. `[land].branch` is never inferred and blank must stay the easy
    // answer — offering "noriq/integration" at a keystroke is the silent envelope-widening
    // RUN-41 refused. Someone who wants auto-landing can type a branch name.
    out('');
    out('  Auto-landing lands passing builds on a branch for you, with no click per run.');
    out('  Leave blank for none (every diff waits on its own branch).');
    const landBranch = (await ask('  Auto-land to which branch? (blank = none)')) || null;

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(
      target,
      renderProjectManifest({ key, tool: tool || null, verifyCmd, reviewer, landBranch, allow: eco.allow }),
      'utf8',
    );
    out('');
    out(`  ✓ wrote ${target}`);

    // Rule 3, and the only thing here the user could not have worked out themselves.
    const roots = await (
      deps.scanRoots ??
      (async () => {
        try {
          return (await loadRunnerConfig(deps.configPath)).config.scanRoots;
        } catch {
          return null; // no machine config yet — `init` reports that, not us
        }
      })
    )();
    const warning = scanRootWarning(cwd, roots);
    out('');
    if (warning) {
      out(`  ⚠️  ${warning}.`);
      out('     Discovery only walks the scanRoots in your runner.toml, so this marker would');
      out('     never be found and nothing here would be dispatchable — with no error anywhere.');
      out('     Add this path to scanRoots, or move the repo under one:');
      for (const r of roots ?? []) out(`       ${r}`);
    } else if (roots) {
      out('  ✓ this repo is under a scanRoot — the runner will find it.');
    }

    out('');
    out('  Next:');
    out(`    git add ${path.join('.noriq', 'project.toml')} && git commit -m "Add Noriq marker"`);
    out('    noriq-runner discover     # confirm this runner sees it');
    out('');
    return { manifestPath: target, wrote: true, key };
  } finally {
    rl?.close();
  }
}
