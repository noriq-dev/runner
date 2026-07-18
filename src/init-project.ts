import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { AgentTool, NetworkPolicy, RunEffort, RunKind } from '@noriq-dev/shared';
import { loadRunnerConfig } from './config';
import { discoverRepos, manifestPath } from './discovery';
import { tomlString } from './init';
import { detectTools } from './tools';
import { type VcsDetection, detectVcs } from './vcs/detect';
import { type VcsVocab, vocabFor } from './vcs/vocab';
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
 * VCS-aware since RUN-84: detection (`detectVcs`) picks the backend, and its lexicon (`vocabFor`,
 * vcs/vocab.ts) picks the WORDS every source-control question and comment reads in — a Diversion
 * operator is never asked about a "rebase", a "push", or a "git commit" they do not have. The
 * manifest it writes stays backend-neutral; only the copy the operator reads changes.
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

/** Title-case a single word for a prompt label ("branch" → "Branch", "stream" → "Stream"). */
const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The largest timeout the daemon can actually honor. `runVerify` hands `timeoutSeconds * 1000`
 * to a Node timer, and Node clamps delays above 2³¹−1 ms to ~1 ms — so a bigger value here would
 * validate, then time the gate out the instant it starts. Refuse what cannot be delivered.
 */
const MAX_VERIFY_TIMEOUT_SECONDS = Math.floor((2 ** 31 - 1) / 1000);

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
 * The [land] envelope beyond `branch` (RUN-64), curated only when quick mode named a branch.
 * Null = never curated: every knob keeps its schema default and the rendered [land] block is
 * byte-for-byte what quick mode writes. A curated envelope writes only what differs from those
 * defaults — widening the envelope is typed, never defaulted, and the committed file shows
 * exactly what was chosen.
 */
export interface LandChoices {
  /** Default true. False = an unverified diff may reach the branch — permitted, never assumed. */
  onlyWhenVerifyPasses: boolean;
  /** Default true: the build agent may resolve MECHANICAL rebase conflicts in its own worktree. */
  resolveConflicts: boolean;
  /** Branch globs a DISPATCH may override `branch` with (RUN-41). EMPTY MEANS NO OVERRIDE. */
  allowedBranches: string[];
  /** Default false — flipping it crosses the one boundary the daemon otherwise has (RUN-27). */
  autoPush: boolean;
  /** Only offered once autoPush is on — the pair is validated before writing (RUN-28). */
  mergeTarget: string | null;
}

/**
 * The curatable slice of [permissions] (RUN-65). Null = never curated: every kind keeps the
 * floor quick mode writes.
 *
 * What is NOT here is the design. `write` is absent because scope/verify read-only and
 * build-writes-its-own-worktree is the floor, not a preference — a wizard that asks is a wizard
 * that suggests the answer could be no. `auto` is absent for the same reason one step out: a
 * repo that wants the driver's bypass mode is a repo whose owner has read THREAT-MODEL.md and
 * can type six words into the file it documents. This tier curates what a real repo hand-edits
 * in after its first failed run, and stops there.
 */
export interface PermissionChoices {
  /** EXTRA build allow rules, appended to the ecosystem-derived set — never replacing it. */
  buildAllow: string[];
  /** Per-kind deny rules. Deny outranks everything on Claude (disallowedTools), `auto`
   *  included; it binds NOTHING on codex, which gates by sandbox level rather than per
   *  command (see `mapSandbox`). The wizard says so before asking — a rule that silently
   *  stops nothing on half the drivers is exactly the false claim this tier must not write. */
  deny: Record<RunKind, string[]>;
  /**
   * Per-kind egress. Default 'restricted' — the floor quick mode writes.
   *
   * DECLARED, NOT ENFORCED: no driver reads `network` today, so an agent gets whatever egress
   * the daemon has whatever this says. The key is offered anyway — it is in the committed
   * schema, `restricted` is already written for every kind by quick mode, and a repo recording
   * the egress it INTENDS is what makes enforcement adoptable rather than a flag day. But the
   * wizard states the gap at the moment of choosing rather than letting someone walk away
   * believing `none` is a firewall. See the alert filed against this task.
   */
  network: Record<RunKind, NetworkPolicy>;
}

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
  /** Floor fix rounds (RUN-94) — same `!= null` rule as reviewer.maxRounds: 0 = a pure gate. */
  verifyMaxRounds?: number | null;
  /** The inline reviewer (RUN-61), when chosen. `model`/`effort` null = the driver's own
   *  default; `maxRounds` null = the schema default (2) — 0 is a real choice (a pure gate),
   *  which is why the renderer tests `!= null` and never truthiness. */
  reviewer?: { model: string | null; effort?: string | null; maxRounds?: number | null } | null;
  landBranch: string | null;
  allow: string[];
  /** Per-kind [defaults] (RUN-62). Null/absent = never curated → the commented guidance block. */
  defaults?: DefaultsChoice | null;
  /** The [land] envelope (RUN-64). Null/absent = never curated → quick mode's exact block. */
  land?: LandChoices | null;
  /**
   * The detected backend's setup lexicon (RUN-84). Absent = git's, the same fallback detection
   * itself makes — so a direct caller (and every pre-RUN-84 test) renders byte-for-byte as before.
   * The manifest stays backend-neutral; this only picks the words the rendered COMMENTS use.
   */
  vocab?: VcsVocab | null;
  /** The curatable [permissions] slice (RUN-65). Null/absent = the floor, unchanged. */
  permissions?: PermissionChoices | null;
  /** The repo's main line (RUN-65) — the one plain-identity field the quick flow never asks.
   *  Null/absent = the commented hint; the daemon falls back to the run's own base. */
  defaultBranch?: string | null;
}

export function renderProjectManifest(m: ManifestChoices): string {
  // Git's lexicon is the default (see `vocab` on ManifestChoices): a caller that never detected a
  // backend renders exactly as it did before RUN-84.
  const vocab = m.vocab ?? vocabFor(undefined);
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

  // The repo's main line: what a NEW landing target forks from, and what a run's diff is taken
  // against. Absent, both fall back to the run's own base — right until two runs disagree about
  // what "the base" was. The key is `defaultBranch` everywhere (the schema's name); only the
  // comment reads in the backend's own words (RUN-84).
  lines.push(
    '',
    ...(m.defaultBranch
      ? [
          `# This repo's main line: a new landing ${vocab.targetNoun} forks from here, and a run's`,
          '# diff is taken against it. Never written to by the daemon.',
          `defaultBranch = ${tomlString(m.defaultBranch)}`,
        ]
      : [
          `# defaultBranch = "main"   # the repo's main line: what a new landing ${vocab.targetNoun}`,
          "#                          # forks from, and what a run's diff is taken against. Blank =",
          "#                          # the run's own base commit.",
        ]),
  );

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
      m.verifyMaxRounds != null
        ? `maxRounds = ${m.verifyMaxRounds}`
        : '# maxRounds = 2   # failing-cmd → fix → re-verify rounds before a human picks it up (0 = pure gate)',
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
    const land = m.land ?? null;
    lines.push(
      '',
      `# Auto-landing: a build that passes the gate is ${vocab.integratedAdj} onto this ${vocab.targetNoun},`,
      '# RE-VERIFIED there, then landed on it. Work accumulates here for you to merge onward.',
      '[land]',
      `branch = ${tomlString(m.landBranch)}`,
    );
    // Every knob below is written ONLY when it was typed to a non-default value: an untouched
    // envelope renders byte-for-byte what quick mode writes, and the committed file shows what
    // was CHOSEN — never a default restated as if someone had chosen it (RUN-64).
    if (land && !land.onlyWhenVerifyPasses) {
      lines.push(
        '# CHOSEN: landing does not wait on the verify gate — an unverified diff reaches this',
        '# branch. Permitted, never assumed.',
        'onlyWhenVerifyPasses = false',
      );
    }
    if (land && !land.resolveConflicts) {
      lines.push(
        `# CHOSEN: ${vocab.conflictAdj} conflicts always fail out to a human — the build agent never resolves.`,
        'resolveConflicts = false',
      );
    }
    if (land?.allowedBranches.length) {
      lines.push(
        '# Branch globs a DISPATCH may override `branch` with (RUN-41). Absent = no override.',
        `allowedBranches = [${land.allowedBranches.map(tomlString).join(', ')}]`,
      );
    }
    if (vocab.landingReachesRemote) {
      lines.push(
        ...(land?.autoPush
          ? [
              `# CHOSEN: this ${vocab.targetNoun} leaves the machine after every landing — \`${vocab.auditHint}\``,
              '# no longer shows what the agents did. See THREAT-MODEL.md.',
              'autoPush = true',
            ]
          : [
              `# autoPush = false      # push this ${vocab.targetNoun} to its remote. Off = nothing an agent writes`,
              '#                       # leaves this machine. See THREAT-MODEL.md before flipping it.',
            ]),
        // The wizard only offers mergeTarget once autoPush is on; the renderer holds the same
        // line for direct callers — a merge request cannot exist without the branch reaching the
        // remote, so an invalid pair is dropped HERE rather than half-honoured at the next
        // dispatch (RUN-28).
        land?.autoPush && land.mergeTarget
          ? `mergeTarget = ${tomlString(land.mergeTarget)}`
          : '# mergeTarget = "main"  # open a merge request when the run\'s PLAN completes (needs autoPush)',
      );
    } else {
      // Server-backed VCS (RUN-84): `publish` already reached the server, so `share`/autoPush is a
      // no-op (diversion.ts / perforce.ts) — every write synced before the gate even ran, the fact
      // the top-of-flow warning states. There is no local-only landing to push, and the daemon's
      // merge-request flow is git+`gh` (merge-request.ts, daemon.ts). So the git-only push/MR knobs
      // are omitted rather than written as switches that would do nothing here.
      lines.push(
        `# On ${vocab.label}, a landing reaches the server directly — publishing is server-side, with`,
        '# no separate push, so the git-only autoPush / mergeTarget knobs are left off. Onward review',
        `# happens through ${vocab.label}, not a pushed ${vocab.targetNoun}.`,
      );
    }
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
    '#',
    '# What each key below is actually worth today — because a policy that reads as a control',
    '# and is only an intention is worse than no key at all:',
    '#   write   : ENFORCED. Claude withholds the edit tools; codex gets a read-only sandbox.',
    '#   allow   : ENFORCED on Claude (allowedTools). Codex gates by sandbox level, not per',
    '#             command, so these rules do not narrow a codex run.',
    '#   deny    : ENFORCED on Claude (disallowedTools, outranking `auto`). NOT on codex, for',
    '#             the same reason as `allow` — a denied command still runs there.',
    '#   network : DECLARED, NOT ENFORCED. No driver reads it: an agent gets whatever egress',
    '#             the daemon process has, whatever this says. It records intent until the',
    '#             runner can isolate a run at the network layer. Do not rely on it.',
  );
  const perms = m.permissions ?? null;
  // The write axis is rendered, never chosen: read-only scope/verify and a build that writes its
  // own worktree is the floor the whole model rests on, so the wizard has no question that could
  // move it (RUN-65). Everything else below is written only where it differs from that floor.
  RunKind.options.forEach((kind, i) => {
    if (i > 0) lines.push('');
    const network = perms?.network[kind] ?? 'restricted';
    lines.push(`[permissions.${kind}]`, `write = ${kind === 'build'}`);
    if (network === 'full') {
      lines.push(
        '# CHOSEN: unrestricted egress. Note this is the value that becomes a no-op the day the',
        '# key starts being enforced — the other two are the ones that will bite.',
      );
    }
    lines.push(`network = ${tomlString(network)}`);
    if (kind === 'build') {
      // Bare `Bash` is never granted, so without this a build agent cannot run the verify command
      // above. The empty case is left explicit rather than omitted: an empty allowlist is a real
      // state with real consequences, and a reader should see that it was a choice.
      const allow = [...new Set([...m.allow, ...(perms?.buildAllow ?? [])])];
      lines.push(
        allow.length
          ? `allow = [${allow.map(tomlString).join(', ')}]`
          : '# allow = ["Bash(npm test:*)"]   # a build agent cannot run ANY command without rules here',
      );
    }
    const deny = perms?.deny[kind] ?? [];
    if (deny.length) {
      lines.push(
        '# Deny outranks everything on Claude, including `auto` and the rules above. On codex it',
        '# binds nothing — see the key legend at the top of this section.',
        `deny = [${deny.map(tomlString).join(', ')}]`,
      );
    }
  });
  lines.push('');

  return lines.join('\n');
}

/** The prompting surface a section sees — the same injected `ask`/`out` as the quick flow, plus
 *  the detected backend's lexicon (RUN-84) so a section speaks the operator's actual VCS. */
interface AdvancedIo {
  ask: (question: string, fallback?: string) => Promise<string>;
  out: (line: string) => void;
  vocab: VcsVocab;
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
  /** Absent = always applies. A section with nothing to configure is skipped whole, title and
   *  all — [land] without a branch: nothing auto-lands, so there is nothing to walk (RUN-64). */
  applies?: (choices: ManifestChoices) => boolean;
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

/**
 * Section B: the rest of the [land] envelope (RUN-64) — only reachable when quick mode named a
 * branch, because with no branch nothing auto-lands and there is nothing to configure. Every
 * question defaults to what quick mode writes, so Enter all the way through changes nothing in
 * the file; each widening must be TYPED, and each prints what it means when it happens.
 */
const landSection: AdvancedSection = {
  title: 'Landing envelope — [land]',
  applies: (choices) => choices.landBranch !== null,
  async run({ ask, out, vocab }, choices) {
    const branch = choices.landBranch;
    if (!branch) return; // applies() gates this; belt-and-braces for direct callers
    const declined = (answer: string) => answer === 'n' || answer === 'no';

    out('  Every knob here defaults to exactly what quick mode writes — Enter all the way');
    out('  through changes nothing. Widening the envelope is typed, never defaulted.');
    out('');

    // Default true, and only a typed "n" turns the gate off — the same posture as the schema:
    // permitted, never assumed. The consequence is printed at the moment of choosing, not
    // buried in a doc the chooser has not read. "rebased"/"merged" per the backend (RUN-84).
    const gate = (
      await ask(`  Land only when verify passes on the ${vocab.integratedAdj} result? (Y/n)`, 'Y')
    ).toLowerCase();
    const onlyWhenVerifyPasses = !declined(gate);
    if (!onlyWhenVerifyPasses) {
      out(`  ⚠ Off means an UNVERIFIED diff reaches the ${vocab.targetNoun}: a build that failed the`);
      out('    gate — or never ran it — still lands there.');
    }

    // Agent conflict-resolution only exists where conflicts are editable files (git worktree,
    // p4 resolve). On Diversion they are server-side (a resolveUrl, not paths), so the agent
    // cannot take them — offering the choice would promise a job the backend cannot run (RUN-84).
    let resolveConflicts = true;
    if (vocab.agentResolvesConflicts) {
      const resolve = (
        await ask(`  Let the build agent resolve mechanical ${vocab.conflictAdj} conflicts? (Y/n)`, 'Y')
      ).toLowerCase();
      resolveConflicts = !declined(resolve);
    } else {
      out('');
      out(`  On ${vocab.label} a landing conflict is resolved server-side, not in the workspace, so`);
      out('  the build agent cannot take it — a conflict always waits on a human.');
    }

    // EMPTY MEANS NO OVERRIDE, and that default is load-bearing (RUN-41): defaulting to
    // "anywhere" would make every repo writable at `main` by anyone who can dispatch, and the
    // repo owner and the dispatcher are not always the same person. The repo opts in, typed.
    out('');
    out(`  A dispatch can never choose the landing ${vocab.targetNoun}: this repo lands only at ${branch}.`);
    out('  Globs here (e.g. feature/** wip/*) let a dispatch override that — blank keeps the');
    out('  envelope closed.');
    const allowedBranches = (
      await ask(`  ${capitalize(vocab.targetNoun)} globs a dispatch may land on (blank = no override)`)
    )
      .split(/[,\s]+/)
      .filter(Boolean);

    // The push/merge-request tail is git-only (RUN-84): on a server-backed VCS `publish` already
    // reached the server (`share` no-ops) and the merge-request flow is git+`gh`, so there is no
    // autoPush to opt into and nothing here to ask. Both knobs stay at their closed default.
    let autoPush = false;
    let mergeTarget: string | null = null;
    if (vocab.landingReachesRemote) {
      // Default false, and the default is the point (RUN-27): every other defence rests on
      // "nothing an agent writes leaves this machine".
      const push = (await ask(`  Push ${branch} to its remote after each landing? (y/N)`, 'N')).toLowerCase();
      autoPush = push === 'y' || push === 'yes';
      if (autoPush) {
        out('  ⚠ This crosses the one boundary the daemon otherwise has — agent work now leaves');
        out(`    this machine on its own, and \`${vocab.auditHint}\` stops being your "what did`);
        out('    the agents do?" check. See THREAT-MODEL.md before committing this.');
      }

      // Offered only once autoPush is on: a merge request cannot exist without the branch
      // reaching the remote. Validating the pair HERE (rule 1) beats writing a manifest whose
      // merge request can never open at the next dispatch.
      if (autoPush) {
        out('');
        out("  The daemon can open a merge request when a plan's work completes. A per-plan");
        out('  branch template — branch = "noriq/plan-<planKey>" — is what makes that MR mean');
        out("  something: one plan's worth of work per review (RUN-28).");
        for (;;) {
          const answer = (await ask('  Merge-request target branch (blank = no merge requests)')).trim();
          if (!answer) break;
          if (answer === branch) {
            out('  ✗ that is the landing branch itself — a merge request needs a different base.');
            continue;
          }
          mergeTarget = answer;
          break;
        }
      }
    } else {
      out('');
      out(`  On ${vocab.label}, this ${vocab.targetNoun} already reaches the server as work lands — there`);
      out('  is no separate push, and onward review runs there, not through a git remote.');
    }

    choices.land = { onlyWhenVerifyPasses, resolveConflicts, allowedBranches, autoPush, mergeTarget };
  },
};

/**
 * Why an allow rule is refused, or null when it is fine (RUN-65).
 *
 * `mapPermission`/`mapSandbox` would never EMIT either of these from a curated allowlist — so
 * this is not the enforcement, and it is not pretending to be. It is the committed file staying
 * honest: a marker travels to teammates' runners, and a rule that reads as "the allowlist grants
 * everything" is a claim about this repo that no reader should have to test against the driver's
 * source to disbelieve. The daemon being defensive is not the same as the manifest being true.
 *
 * Bare `Bash` — and its wildcard spellings — is unrestricted execution wearing an allowlist's
 * clothes. `danger-full-access` is codex's sandbox mode, not an allow rule at all: typed here it
 * does nothing, which is the worst outcome available (it reads as granted and is not).
 */
export function refuseAllowRule(rule: string): string | null {
  const trimmed = rule.trim();
  const bare = trimmed.replace(/\s+/g, '');
  // `Bash`, `Bash()`, `Bash(*)`, `Bash(:*)`, `Bash(*:*)` — every spelling of "any command".
  if (/^Bash(\((\*?(:\*)?|\*:\*)\))?$/i.test(bare)) {
    return 'bare `Bash` is unrestricted execution — the allowlist exists to be narrower than that. Name the commands (e.g. "Bash(npm test:*)"). See THREAT-MODEL.md; a repo that truly needs this opts the kind into `auto` by hand, having read what it costs.';
  }
  if (/danger-full-access/i.test(trimmed)) {
    return "`danger-full-access` is codex's sandbox mode, not an allow rule — written here it grants nothing while reading as if it grants everything. See THREAT-MODEL.md; `[permissions.build] auto = true` is the real knob, by hand.";
  }
  return null;
}

/**
 * Section C: the curatable [permissions] slice (RUN-65) — the extra build rules and the egress
 * policy a real repo hand-edits in after its first failed run, and nothing else. The floor
 * itself (`write`) is never asked, and `auto` is never offered: this section curates the
 * allowlist, it does not "configure your sandbox".
 */
const permissionsSection: AdvancedSection = {
  title: 'Build allowlist, deny rules & egress — [permissions]',
  async run({ ask, out }, choices) {
    out('  The floor is not a question here: scope and verify are READ-ONLY, build writes its');
    out('  own worktree, and no agent ever holds push credentials. What you can curate is what');
    out('  build may RUN, what no kind may run, and what egress you mean each kind to have.');
    out('');

    // Appended, never replacing: the derived set is what makes the suggested verify command
    // runnable at all (see detectEcosystem), and a wizard that let it be typed away would hand
    // back the "the agent is broken" failure this file exists to prevent.
    if (choices.allow.length) {
      out('  Detected build rules, already in the file:');
      for (const rule of choices.allow) out(`    ${rule}`);
    }
    out('  Add the rules this repo actually needs on top — the codegen or migration step your');
    out('  build agent will reach for and be denied. One per line, blank when done.');
    const buildAllow: string[] = [];
    for (;;) {
      const rule = (await ask('  Extra build allow rule (blank = done)')).trim();
      if (!rule) break;
      const refusal = refuseAllowRule(rule);
      if (refusal) {
        out(`  ✗ ${refusal}`);
        continue;
      }
      if (choices.allow.includes(rule) || buildAllow.includes(rule)) {
        out('  · already granted — skipping the duplicate.');
        continue;
      }
      buildAllow.push(rule);
    }

    const deny: Record<RunKind, string[]> = { scope: [], build: [], verify: [] };
    const network: Record<RunKind, NetworkPolicy> = {
      scope: 'restricted',
      build: 'restricted',
      verify: 'restricted',
    };
    out('');
    out('  Now per kind: egress, then anything to deny outright. Enter keeps the floor.');
    out('');
    // Say what each key is worth BEFORE it is chosen. A wizard that walks someone through
    // picking `network = "none"` while no driver reads the key has not configured anything —
    // it has talked them into believing something false, in a file their teammates inherit.
    // That is the failure RUN-65 exists to prevent, pointed at the wizard's own prose.
    out('  Before you choose: `deny` binds on Claude (it maps to disallowedTools and outranks');
    out('  everything). It does NOT bind on codex — codex gates by sandbox level, not per');
    out('  command — so a deny rule there records intent and stops nothing.');
    out('');
    out('  And `network` is DECLARED, NOT ENFORCED today: no driver reads it. An agent gets');
    out('  whatever egress this daemon has, whichever value you pick. It is worth recording');
    out('  what you INTEND — the key is in the schema and enforcement is a known gap — but do');
    out('  not leave here believing `none` firewalls anything. It does not, yet.');
    for (const kind of RunKind.options) {
      out('');
      for (;;) {
        const answer = (await ask(`  ${kind}: network — none | restricted`, 'restricted'))
          .trim()
          .toLowerCase();
        if (!answer) break; // Enter keeps the floor; `restricted` is already the initial value
        const parsed = NetworkPolicy.safeParse(answer);
        if (!parsed.success) {
          out('  ✗ none or restricted — or type `full` out to see what it means.');
          continue;
        }
        // `full` parses, and is deliberately absent from the question: of the three it is the
        // only one that can never become MORE restrictive later, so it is the only one whose
        // meaning changes the day enforcement lands. Offering it in the prompt would make it a
        // menu item; making it typed keeps it a decision.
        if (parsed.data === 'full') {
          out('  ⚠ `full` is not offered, only accepted. Not because it does something dangerous');
          out('    today — nothing reads this key, so it does nothing at all. Because it is the');
          out('    one value that will still be doing nothing once the runner CAN isolate a run:');
          out('    `none` and `restricted` start biting, `full` opts this kind out forever, and');
          out('    nobody will re-read this file to notice. See THREAT-MODEL.md.');
          const sure = (await ask(`  Really declare ${kind} unrestricted egress? (y/N)`, 'N')).toLowerCase();
          if (sure !== 'y' && sure !== 'yes') continue;
        }
        network[kind] = parsed.data;
        break;
      }
      for (;;) {
        const rule = (await ask(`  ${kind}: deny rule (blank = done)`)).trim();
        if (!rule) break;
        if (deny[kind].includes(rule)) {
          out('  · already denied — skipping the duplicate.');
          continue;
        }
        deny[kind].push(rule);
      }
    }

    choices.permissions = { buildAllow, deny, network };
  },
};

/**
 * Section D: `defaultBranch` (RUN-65) — the one plain-identity field the quick flow never asks,
 * because it is the only one with an honest fallback (the run's own base). It earns a question
 * here: the fallback stops being honest the moment two runs disagree about what the base was.
 */
const identitySection: AdvancedSection = {
  title: 'Repo identity — defaultBranch',
  // The KEY stays `defaultBranch` (the schema's name, and the title above says so), but the prose
  // reads in the detected backend's words — same split RUN-84 made in landSection, where the TOML
  // key is `branch` while a Perforce operator is asked about a stream.
  async run({ ask, out, vocab }, choices) {
    out(`  This repo's main line: what a NEW landing ${vocab.targetNoun} forks from, and what a`);
    out("  run's diff is taken against. The daemon never writes to it. Blank = the run's own base");
    out('  commit, which is fine until two runs disagree about what that was.');
    choices.defaultBranch =
      (await ask(`  Default ${vocab.targetNoun} (blank = the run's own base)`)).trim() || null;
  },
};

const ADVANCED_SECTIONS: AdvancedSection[] = [
  defaultsSection,
  landSection,
  permissionsSection,
  identitySection,
];

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
    // The detected backend's setup lexicon (RUN-84): every VCS-shaped question and comment below
    // reads in the operator's actual source control, not git-by-assumption. Undetected → git.
    const vocab = vocabFor(vcsDet?.kind);
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
    let verifyMaxRounds: number | null = null;
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
        if (Number.isInteger(n) && n > 0 && n <= MAX_VERIFY_TIMEOUT_SECONDS) {
          verifyTimeoutSeconds = n;
          break;
        }
        out(`  ✗ a whole number of seconds, 1–${MAX_VERIFY_TIMEOUT_SECONDS}, or blank for the default.`);
      }
      // The floor's fix loop (RUN-94) — same bounded-by-default shape as the reviewer's rounds
      // below, and 0 is likewise a real choice: a pure gate that never hands the failure back.
      for (;;) {
        const raw = await ask(
          '  Failing-cmd → fix → re-verify rounds, 0–5 (blank = 2; 0 = gate only, no hand-back)',
        );
        const answer = raw.trim();
        if (!answer) break;
        const n = Number(answer);
        if (Number.isInteger(n) && n >= 0 && n <= 5) {
          verifyMaxRounds = n;
          break;
        }
        out('  ✗ a whole number from 0 to 5, or blank for the default (2).');
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
      verifyMaxRounds,
      reviewer,
      landBranch,
      allow: eco.allow,
      defaults: null,
      land: null,
      vocab,
      permissions: null,
      defaultBranch: null,
    };

    // The fork (RUN-62). One trailing question, default N, so the tier is discoverable
    // without reading --help; the --advanced flag just pre-answers it. Every advanced
    // question runs BEFORE the write below — rule 1 covers the session, not each question.
    let advanced = deps.advanced ?? false;
    if (!advanced) {
      out('');
      out('  The quick questions are done. Advanced options (per-kind model/effort defaults,');
      out('  the [land] envelope when auto-landing is on, extra build allow/deny rules and');
      out('  egress, the default branch) can be curated now, or added to the file by hand');
      out('  later — it documents them all.');
      const curate = (await ask('  Curate advanced options? (y/N)', 'N')).toLowerCase();
      advanced = curate === 'y' || curate === 'yes';
    }
    if (advanced) {
      for (const section of ADVANCED_SECTIONS) {
        if (section.applies && !section.applies(choices)) continue;
        out('');
        out(`  ${section.title}`);
        out('');
        await section.run({ ask, out, vocab }, choices);
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
    // The marker is committed the detected backend's way (RUN-84) — a Diversion or Perforce
    // operator was never going to `git add` a repo git does not own.
    out(`    ${vocab.commitMarker(path.join('.noriq', 'project.toml'))}`);
    out('    noriq-runner discover     # confirm this runner sees it');
    out('');
    return { manifestPath: target, wrote: true, key };
  } finally {
    rl?.close();
  }
}
