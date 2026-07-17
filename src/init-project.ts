import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { AgentTool, RunEffort, RunKind } from '@noriq-dev/shared';
import { loadRunnerConfig } from './config';
import { discoverRepos, manifestPath } from './discovery';
import { tomlString } from './init';
import { detectTools } from './tools';
import { type VcsDetection, detectVcs } from './vcs/detect';
import { DEFAULT_VERIFY_TIMEOUT_SECONDS } from './verify';

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
  /**
   * Injectable discovery, defaulting to the daemon's REAL walk. The post-write verdict has to be
   * the daemon's own answer to "will this repo be seen", not a lexical guess: the walk stops a few
   * levels deep and skips ignored dirs (node_modules, vendor, target), so a repo lexically "under"
   * a scanRoot can still be invisible. Tests inject to avoid a fixture tree.
   */
  discover?: (roots: string[]) => Promise<Array<{ root: string }>>;
  /**
   * Injectable so tests never depend on which CLIs the HOST has (defaults to the real
   * detectTools). Without this, the "Agent driver" question silently disappears on any box
   * without `claude`/`codex` on PATH — CI — and every positional test answer shifts one slot:
   * the suite was green on dev machines and red on every GitHub runner since it landed.
   */
  installedTools?: () => string[];
  /** Injectable VCS detection (RUN-60) — tests don't need a real dv registry. */
  detectVcsFor?: (root: string) => Promise<VcsDetection | undefined>;
  /**
   * `--advanced` (RUN-62): pre-answers the trailing "Curate advanced options?" question with
   * yes. The flag and the question are the same fork — the question exists so the tier is
   * discoverable without reading --help, the flag so the discovery is skippable next time.
   */
  advanced?: boolean;
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
    // A fresh worktree has no node_modules, so without a pinned install rule the derived gate can
    // never go green — `npm test` exits 127 (`tsc: command not found`). Grant the LOCKFILE-PINNED
    // install (`npm ci`: installs exactly the lockfile, never rewrites it) only when a lockfile
    // actually pins it: `npm ci` errors without one, and an install rule that always fails is worse
    // than none. Never `npm install` — it can add packages and rewrite the lockfile.
    // Either lockfile pins `npm ci`: package-lock.json is the common one, npm-shrinkwrap.json is
    // the published-package form — npm ci honours both, so a shrinkwrap-only repo must get the rule.
    const pinned = has('package-lock.json') || has('npm-shrinkwrap.json');
    const npm: string[] = [
      ...(pinned ? ['Bash(npm ci:*)'] : []),
      'Bash(npm test:*)',
      'Bash(npm run:*)',
      'Bash(npx tsc:*)',
    ];
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

/** One kind's [defaults] choice (RUN-33). Null = inherit — the manifest simply omits the key. */
export interface KindDefaultChoice {
  model: string | null;
  effort: RunEffort | null;
}

/** Per-kind [defaults], curated in the advanced tier. */
export type DefaultsChoice = Record<RunKind, KindDefaultChoice>;

/**
 * Everything the wizard chose, accumulated across the quick flow and any advanced sections,
 * rendered exactly ONCE at the end. RUN-40's rule 1 (validate before writing) applies to the
 * whole session, not per question — no section writes; sections only fill this in.
 */
export interface ManifestChoices {
  key: string;
  tool: string | null;
  verifyCmd: string | null;
  /** Advanced [verify] knobs (RUN-63) — meaningful only alongside `verifyCmd`. Null/absent =
   *  unchosen: the rendered file keeps the commented hint instead of a value. */
  verifyShell?: string | null;
  verifyTimeoutSeconds?: number | null;
  /** The inline reviewer (RUN-61), when chosen. `model`/`effort` null = the driver's own
   *  default; `maxRounds` null = the schema default (2) — 0 is a real choice (a pure gate),
   *  which is why the renderer tests `!= null` and never truthiness. */
  reviewer?: { model: string | null; effort?: string | null; maxRounds?: number | null } | null;
  landBranch: string | null;
  allow: string[];
  /** Per-kind [defaults] (RUN-62). Null/absent = never curated → the commented guidance block. */
  defaults?: DefaultsChoice | null;
}

export function renderProjectManifest(m: ManifestChoices): string {
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

  // Per-kind [defaults] (RUN-33). Chosen values become real sections; nothing chosen keeps the
  // guidance as comments, so the manifest stays its own documentation either way.
  const defs = m.defaults ?? null;
  const chosenKinds = defs ? RunKind.options.filter((k) => defs[k].model || defs[k].effort) : [];
  if (defs && chosenKinds.length) {
    lines.push(
      '',
      '# Per-kind model + reasoning effort (RUN-33). Precedence: the dispatch → these → the',
      "# tool's own default. `model` passes through unvalidated (a wrong name fails fast);",
      '# `effort` is tool-agnostic intent — codex clamps above its own high, never errors.',
    );
    chosenKinds.forEach((kind, i) => {
      const d = defs[kind];
      if (i > 0) lines.push('');
      lines.push(`[defaults.${kind}]`);
      if (d.model) lines.push(`model = ${tomlString(d.model)}`);
      if (d.effort) lines.push(`effort = ${tomlString(d.effort)}`);
    });
  } else {
    lines.push(
      '',
      '# Per-kind model + reasoning effort (RUN-33): say "scope with something strong, build',
      '# with something cheap" once, in the commit, instead of per dispatch. `model` is the',
      "# vendor's own name, deliberately unvalidated (a wrong one fails fast); `effort` is",
      `# ${RunEffort.options.join(' | ')} (codex clamps above its own high). Omitted = inherit:`,
      '# [defaults.scope]',
      '# model = "claude-opus-4-8"',
      '# effort = "high"',
    );
  }

  if (m.verifyCmd) {
    lines.push(
      '',
      '# Deterministic verify floor: the daemon runs this (zero tokens) after a build agent exits',
      "# clean, in the run's worktree. Non-zero exit GATES the run — it cannot reach `done`.",
      '[verify]',
      `cmd = ${tomlString(m.verifyCmd)}`,
      m.verifyShell
        ? `shell = ${tomlString(m.verifyShell)}`
        : '# shell = "bash"   # pin one if this command is not portable to cmd.exe (mixed-OS teams)',
      m.verifyTimeoutSeconds != null
        ? `timeoutSeconds = ${m.verifyTimeoutSeconds}`
        : `# timeoutSeconds = ${DEFAULT_VERIFY_TIMEOUT_SECONDS}   # blank = this built-in default; a timeout GATES the run`,
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
      m.reviewer.effort
        ? `effort = ${tomlString(m.reviewer.effort)}`
        : '# effort = "high"   # low | medium | high | xhigh | max — blank falls through like model',
      m.reviewer.maxRounds != null
        ? `maxRounds = ${m.reviewer.maxRounds}`
        : '# maxRounds = 2   # FAIL → fix → re-review rounds before a human picks it up',
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

/** The prompting surface a section sees — the same injected `ask`/`out` as the quick flow. */
interface AdvancedIo {
  ask: (question: string, fallback?: string) => Promise<string>;
  out: (line: string) => void;
}

/**
 * One advanced tier section: a titled group of questions that fills in `choices` and writes
 * NOTHING — the single write at the end of the session covers the quick and advanced answers
 * alike, so rule 1 holds for the whole session. This shape is the point of RUN-62 as much as
 * the first section is: the follow-ups (B–D) each append an entry to ADVANCED_SECTIONS; the
 * fork, the loop, and the ask-everything-then-write-once ordering are already here.
 */
interface AdvancedSection {
  title: string;
  run: (io: AdvancedIo, choices: ManifestChoices) => Promise<void>;
}

/** Section A: per-kind [defaults] model + effort (RUN-33). */
const defaultsSection: AdvancedSection = {
  title: 'Per-kind model & effort — [defaults]',
  async run({ ask, out }, choices) {
    out('  Pin a model and/or reasoning effort per run kind, in the commit: the dispatch');
    out("  overrides these, these override the tool's own default. Model names pass through");
    out('  unvalidated — they change constantly, and a stale allowlist here would reject one');
    out('  your CLI supports fine; a wrong name fails fast. Effort is one of');
    out(`  ${RunEffort.options.join(' | ')} — codex clamps anything above its own high rather`);
    out('  than erroring. Blank = inherit, on every question.');
    const blank = (): KindDefaultChoice => ({ model: null, effort: null });
    const defaults: DefaultsChoice = { scope: blank(), build: blank(), verify: blank() };
    for (const kind of RunKind.options) {
      const model = (await ask(`  ${kind}: model (blank = inherit)`)).trim() || null;
      // Effort is the one advanced field with a shape, so it re-asks here (rule 1) rather
      // than writing a manifest the schema will refuse at the next dispatch.
      let effort: RunEffort | null = null;
      for (;;) {
        const answer = (await ask(`  ${kind}: effort (blank = inherit)`)).trim().toLowerCase();
        if (!answer) break;
        const parsed = RunEffort.safeParse(answer);
        if (parsed.success) {
          effort = parsed.data;
          break;
        }
        out(`  ✗ one of ${RunEffort.options.join(' | ')}, or blank to inherit.`);
      }
      defaults[kind] = { model, effort };
    }
    choices.defaults = defaults;
  },
};

const ADVANCED_SECTIONS: AdvancedSection[] = [defaultsSection];

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
    // Shape is all we can check: there is no project-listing endpoint on the client, so a KEY that
    // is well-formed but names no project resolves to nothing on the server. Say so plainly.
    out(`  KEY ${key} must match a project key on your Noriq server (there's no way to check that`);
    out('  from here) — confirm it in the dashboard.');

    // Offer only the drivers actually on PATH, and HOLD the answer to them. `tool` is
    // z.enum(['claude','codex']) and discovery silently DROPS a manifest that fails the schema
    // (readManifest → null), so a free-text typo — or a schema-valid driver this machine lacks —
    // would write a marker that passes this wizard yet no run here could ever execute, with no error
    // anywhere: the exact cliff this command exists to remove. Blank always means "the runner's
    // default" (tool = null), so it carries NO fallback that would silently rewrite it.
    const installed: string[] = (deps.installedTools ?? detectTools)();
    let tool: string | null = null;
    if (installed.length) {
      for (;;) {
        const answer = (await ask(`  Agent driver (${installed.join(' | ')}; blank = runner default)`))
          .trim()
          .toLowerCase();
        if (!answer) break; // stays null — the runner's default
        if (AgentTool.safeParse(answer).success && installed.includes(answer)) {
          tool = answer;
          break;
        }
        out(`  ✗ pick one of: ${installed.join(', ')} — or leave blank for the runner default.`);
      }
    } else {
      out('  No drivers found on PATH — leaving the driver unset (install `claude`/`codex` later).');
    }

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

    // The advanced [verify] knobs (RUN-63), asked only when there is a cmd for them to govern —
    // a shell pin or a timeout with nothing to run is dead config.
    let verifyShell: string | null = null;
    let verifyTimeoutSeconds: number | null = null;
    if (verifyCmd) {
      out('');
      out('  This file is COMMITTED, so that command travels to teammates on other OSes: `&&` is');
      out('  portable to cmd.exe by luck; env prefixes, redirection, globs and $VAR are not —');
      out('  mixed-OS teams pin `bash` (Git for Windows ships one). An absent pin fails the gate');
      out("  outright, so blank (= the platform's own shell) stays the default.");
      verifyShell = (await ask('  Pin a shell for it? (blank = platform default)')) || null;
      for (;;) {
        const raw = await ask(`  Verify timeout in seconds (blank = ${DEFAULT_VERIFY_TIMEOUT_SECONDS})`);
        const answer = raw.trim();
        if (!answer) break;
        const n = Number(answer);
        if (Number.isInteger(n) && n > 0) {
          verifyTimeoutSeconds = n;
          break;
        }
        out('  ✗ a positive whole number of seconds, or blank for the default.');
      }
    }

    // The other half of the verify choice (RUN-61). Both halves may be blank — no verify stage
    // is a legitimate configuration, not a misconfiguration, so neither question presumes.
    out('');
    out('  An independent reviewer agent can also judge each build against the task intent —');
    out('  a fresh read-only session (optionally a stronger model) whose report is handed back');
    out('  to the builder to fix.');
    const wantReviewer = (await ask('  Add the inline reviewer? (y/N)', 'N')).toLowerCase();
    let reviewer: { model: string | null; effort: string | null; maxRounds: number | null } | null = null;
    if (wantReviewer === 'y' || wantReviewer === 'yes') {
      const model = (await ask("  Reviewer model (blank = the driver's default)")) || null;
      // Effort is tool-agnostic INTENT (RUN-33) — validated here because a typo'd effort would
      // otherwise surface as a schema refusal at the NEXT dispatch, not at setup.
      let effort: string | null = null;
      for (;;) {
        const raw = await ask(`  Reviewer effort (${RunEffort.options.join(' | ')}; blank = default)`);
        const answer = raw.trim().toLowerCase();
        if (!answer) break;
        if (RunEffort.safeParse(answer).success) {
          effort = answer;
          break;
        }
        out(`  ✗ one of ${RunEffort.options.join(' | ')}, or blank for the default.`);
      }
      // Bounded by default for RUN-21's reason: an agent that cannot satisfy the reviewer in
      // two rounds is not going to on the third — it is going to keep spending. 0 is a real
      // choice (one review, no hand-back — a pure gate), not an absence.
      let maxRounds: number | null = null;
      for (;;) {
        const raw = await ask(
          '  FAIL → fix → re-review rounds, 0–5 (blank = 2; 0 = review only, no hand-back)',
        );
        const answer = raw.trim();
        if (!answer) break;
        const n = Number(answer);
        if (Number.isInteger(n) && n >= 0 && n <= 5) {
          maxRounds = n;
          break;
        }
        out('  ✗ a whole number from 0 to 5, or blank for the default (2).');
      }
      reviewer = { model, effort, maxRounds };
    }

    // No default, on purpose. `[land].branch` is never inferred and blank must stay the easy
    // answer — offering "noriq/integration" at a keystroke is the silent envelope-widening
    // RUN-41 refused. Someone who wants auto-landing can type a branch name.
    out('');
    out('  Auto-landing lands passing builds on a branch for you, with no click per run.');
    out('  Leave blank for none (every diff waits on its own branch).');
    const landBranch = (await ask('  Auto-land to which branch? (blank = none)')) || null;

    const choices: ManifestChoices = {
      key,
      tool: tool || null,
      verifyCmd,
      verifyShell,
      verifyTimeoutSeconds,
      reviewer,
      landBranch,
      allow: eco.allow,
      defaults: null,
    };

    // The fork (RUN-62). One trailing question, default N, so the tier is discoverable
    // without reading --help; the --advanced flag just pre-answers it. Every advanced
    // question runs BEFORE the write below — rule 1 covers the session, not each question.
    let advanced = deps.advanced ?? false;
    if (!advanced) {
      out('');
      out('  The quick questions are done. Advanced options (per-kind model/effort defaults)');
      out('  can be curated now, or added to the file by hand later — it documents them all.');
      const curate = (await ask('  Curate advanced options? (y/N)', 'N')).toLowerCase();
      advanced = curate === 'y' || curate === 'yes';
    }
    if (advanced) {
      for (const section of ADVANCED_SECTIONS) {
        out('');
        out(`  ${section.title}`);
        out('');
        await section.run({ ask, out }, choices);
      }
    }

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, renderProjectManifest(choices), 'utf8');
    out('');
    out(`  ✓ wrote ${target}`);

    // Rule 3, and the only thing here the user could not have worked out themselves: does the
    // daemon's OWN discovery walk actually reach this marker? A lexical containment check lies —
    // the walk stops a few levels deep and skips ignored dirs — so we run the real walk and look
    // for this repo in its result. This is worth more than every other line the command prints.
    const roots = await (
      deps.scanRoots ??
      (async () => {
        try {
          return (await loadRunnerConfig(deps.configPath)).config.scanRoots;
        } catch {
          return null; // machine config missing/unreadable — reported below, not swallowed
        }
      })
    )();
    out('');
    if (roots === null) {
      // Without a readable runner.toml we cannot answer the one question only this command can, and
      // falling through to "commit it" would imply the runner is guaranteed to see the repo.
      out('  ⚠️  Could not read your machine config, so I cannot confirm the runner will see this');
      out('     repo. Run `noriq-runner init` to set it up, then `noriq-runner discover`.');
    } else if (roots.length === 0) {
      out('  ⚠️  Your runner.toml lists no scanRoots, so the runner walks nothing and will not find');
      out('     this repo. Add its path to scanRoots (`noriq-runner init` can do this):');
      out(`       ${path.resolve(cwd)}`);
    } else {
      const discover = deps.discover ?? ((r: string[]) => discoverRepos(r));
      const canon = (p: string) => {
        try {
          return realpathSync(p);
        } catch {
          return path.resolve(p);
        }
      };
      const me = canon(cwd);
      // Canonicalize both sides: a scanRoot reaching the repo through a symlink (Fedora Atomic's
      // /home → /var/home, macOS /var → /private/var) prints a different path string than cwd.
      const seen = (await discover(roots)).some((repo) => canon(repo.root) === me);
      const outside = scanRootWarning(cwd, roots);
      if (seen) {
        out('  ✓ this repo is under a scanRoot and discovery found it — the runner will see it.');
      } else if (outside) {
        // Lexically outside every root: the plain "not under any scanRoot" case.
        out(`  ⚠️  ${outside}.`);
        out('     Discovery only walks the scanRoots in your runner.toml, so this marker would');
        out('     never be found and nothing here would be dispatchable — with no error anywhere.');
        out('     Add this path to a scanRoot, or move the repo under one:');
        for (const r of roots) out(`       ${r}`);
      } else {
        // Under a scanRoot lexically, but the walk did not reach it — depth cap, or an ignored dir
        // (node_modules, vendor, target, a dot-dir) sits between the root and here.
        out('  ⚠️  This repo sits under a scanRoot but discovery did not reach it — the walk stops a');
        out('     few levels deep and skips dot- and build dirs (node_modules, vendor, target).');
        out("     Add the repo's own path to scanRoots so it is found directly:");
        out(`       ${path.resolve(cwd)}`);
      }
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
