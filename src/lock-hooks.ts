import { isAbsolute, relative, resolve } from 'node:path';
import type { LockConflict } from './lock-client';

/** The all-or-nothing outcome of acquiring locks over a set of paths — the shape both the
 *  LockClient and the VcsBackend seam return (`enabled:false` = locking off → a no-op grant). */
export type LockAcquireOutcome =
  | { ok: true; enabled: boolean; locks: Array<{ id: string; path: string }> }
  | { ok: false; conflicts: LockConflict[] };

/**
 * The reactive per-edit enforcement layer (RUN-101), driver-agnostic.
 *
 * The runner's guarantee over the PLNR client hook is PRESENCE: the daemon injects this so it
 * cannot be skipped, unlike a hook a user has to install. For the Claude driver it runs
 * IN-PROCESS (the SDK's PreToolUse callback), which means the lock check happens in the daemon
 * with the run's agent token it already holds — the token never touches the agent's disk or
 * shell (the whole reason `sanitizedAgentEnv` strips it). Ported from the shipped
 * `hooks/lib.mjs` (PLNR-209) so the two stay behavior-compatible.
 */

/** The write set a tool is about to touch, as the tool gave them (made repo-relative by the
 *  caller). Bash is best-effort and fails OPEN (returns []) on anything it can't parse
 *  confidently — a false block on a shell command is worse than a missed lock. */
export function extractPaths(toolName: string, toolInput: Record<string, unknown> = {}): string[] {
  switch (toolName) {
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return typeof toolInput.file_path === 'string' ? [toolInput.file_path] : [];
    case 'NotebookEdit':
      return typeof toolInput.notebook_path === 'string' ? [toolInput.notebook_path] : [];
    case 'Bash':
      return parseBashTargets(typeof toolInput.command === 'string' ? toolInput.command : '');
    default:
      return [];
  }
}

/** Best-effort extraction of files a shell command WRITES. Conservative: bails to [] on any
 *  dynamic construct (command substitution, variables, globs, process-sub, unmatched quotes)
 *  rather than guess wrong. */
export function parseBashTargets(command: string): string[] {
  if (!command || /[$`*?[]|<\(/.test(command)) return []; // dynamic / glob / process-sub → don't guess
  const targets = new Set<string>();
  for (const segment of command.split(/&&|\|\||;|\n|\|/)) {
    const toks = tokenize(segment);
    if (!toks.length) continue;
    // Redirections write their target: `foo > out`, `>> out`, `>out`.
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if ((t === '>' || t === '>>') && toks[i + 1]) targets.add(toks[i + 1]!);
      else if (/^>>?[^>].*/.test(t)) targets.add(t.replace(/^>>?/, ''));
    }
    let cmd = toks[0]!;
    let rest = toks.slice(1);
    if (cmd === 'git') {
      cmd = `git ${rest[0] ?? ''}`.trim();
      rest = rest.slice(1);
    }
    const files = rest.filter((a) => a !== '--' && !a.startsWith('-') && a !== '>' && a !== '>>');
    switch (cmd) {
      case 'rm':
      case 'mv':
      case 'cp':
      case 'touch':
      case 'tee':
      case 'git rm':
      case 'git mv':
        for (const f of files) targets.add(f);
        break;
      case 'git checkout':
      case 'git restore': {
        // Only the pathspec after `--` is a write to the working tree; a bare branch checkout isn't.
        const dd = toks.indexOf('--');
        if (dd !== -1) for (const f of toks.slice(dd + 1)) if (f) targets.add(f);
        break;
      }
      default:
        break;
    }
  }
  return [...targets].filter(Boolean);
}

/** Minimal shell tokenizer: splits on whitespace, honoring simple single/double quotes. */
function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null = re.exec(s);
  while (m) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
    m = re.exec(s);
  }
  return out;
}

/** Make a tool-supplied path repo-relative POSIX, or null if it escapes the repo (don't lock it). */
export function toRepoRelative(p: string, root: string): string | null {
  const abs = isAbsolute(p) ? p : resolve(root, p);
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null; // outside the worktree
  return rel.split(/[\\/]/).join('/');
}

/** The repo-relative write set for a tool call, deduped and repo-scoped. */
export function lockPathsForTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  root: string,
): string[] {
  const raw = extractPaths(toolName, toolInput);
  return [...new Set(raw.map((p) => toRepoRelative(p, root)).filter((p): p is string => p !== null))];
}

/** The human-readable deny reason from a conflict list — the text handed back to the model. */
export function denyReason(conflicts: LockConflict[]): string {
  const lines = conflicts.map((c) => {
    const who = c.holderName || c.holder || 'another session';
    const forTask = c.taskKey ? ` for ${c.taskKey}` : '';
    const until = c.expiresAt ? ` until ${c.expiresAt}` : '';
    return `  • ${c.path} — locked by ${who}${forTask}${until}`;
  });
  return `Noriq file lock: another agent holds ${conflicts.length === 1 ? 'a file' : 'files'} you are about to edit.\n${lines.join('\n')}\nCoordinate (send_message / handoff_task) or wait, then retry.`;
}

/** The task-comment surface when the hard floor gates a build (RUN-102) — names the peer-held
 *  paths and how to proceed, the same voice as the reactive hook's deny. */
export function lockFloorComment(conflicts: LockConflict[]): string {
  const lines = conflicts.map((c) => {
    const who = c.holderName || c.holder || 'another session';
    const forTask = c.taskKey ? ` (${c.taskKey})` : '';
    return `  • ${c.path} — held by ${who}${forTask}`;
  });
  return `🔒 This build changed ${conflicts.length === 1 ? 'a file' : 'files'} another agent holds a lock on, so it was not landed:\n${lines.join('\n')}\n\nThe diff is on the run's branch for review. Coordinate with the holder (or wait for their lock to release), then re-dispatch.`;
}

export interface LockEnforcerDeps {
  /** Acquire locks over these repo-relative paths, all-or-nothing. Bound by the caller to the
   *  run's workspace + token + scope branch + task — usually `VcsBackend.lock`, so a live
   *  backend's native lock applies per-edit too, not just the Noriq view. */
  lock: (paths: string[]) => Promise<LockAcquireOutcome>;
  /** Release the given repo-relative paths (Stop cleanup). */
  release: (paths: string[]) => Promise<void>;
  /** The worktree root; tool paths are made relative to it. */
  root: string;
  /** Optional sink for a denied edit (telemetry/logs — RUN-106). */
  onDeny?: (paths: string[], conflicts: LockConflict[]) => void;
}

/**
 * The in-process reactive enforcer a driver's PreToolUse hook calls (RUN-101).
 *
 * FAIL-OPEN on infrastructure errors (a Noriq blip must not brick a run mid-edit): only a
 * CONFIRMED conflict (`ok:false`) denies. Presence is the guarantee here, not fail-closed —
 * the daemon's dispatch-time predictive lock and the hard floor (RUN-102) are the belt to this
 * hook's suspenders. A locking-disabled project is a silent allow.
 */
export class LockEnforcer {
  private readonly held = new Set<string>();

  constructor(private readonly deps: LockEnforcerDeps) {}

  /** PreToolUse guard: returns a deny reason to block the edit, or null to allow. */
  async guard(toolName: string, toolInput: Record<string, unknown>): Promise<string | null> {
    const paths = lockPathsForTool(toolName, toolInput, this.deps.root);
    if (!paths.length) return null; // nothing lockable (read, non-file, or an unparseable Bash)
    let result: LockAcquireOutcome;
    try {
      result = await this.deps.lock(paths);
    } catch {
      return null; // fail OPEN — a transient lock-service error must not wedge the edit
    }
    if (!result.ok) {
      this.deps.onDeny?.(paths, result.conflicts);
      return denyReason(result.conflicts);
    }
    if (result.enabled) for (const p of paths) this.held.add(p);
    return null;
  }

  /** Stop hook: drop what this session took. Best-effort — the daemon's terminal release and the
   *  server's auto-release-on-task-settle are the authoritative cleanup; this just frees peers
   *  sooner. */
  async releaseHeld(): Promise<void> {
    if (!this.held.size) return;
    const paths = [...this.held];
    this.held.clear();
    await this.deps.release(paths).catch(() => {});
  }

  /** The paths this session currently holds (telemetry — RUN-106). */
  heldPaths(): string[] {
    return [...this.held];
  }
}
