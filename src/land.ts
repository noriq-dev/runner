import { renderPrompt } from './prompts';
import type { AnchorTask } from './supervisor';

/**
 * The landing step: a build that cleared the gate is rebased onto the integration
 * branch, re-verified THERE, and fast-forwarded in — no human per run.
 *
 * This module holds the pure bits (prompt + reporting text). The VCS work lives behind the
 * vcs/ seam (RUN-49; git's implementation is WorktreeManager) and the orchestration in
 * RunSupervisor.
 */

/** Why a run didn't land. Each maps to a distinct human action, so keep them distinct. */
export type LandFailure =
  | 'conflict' // a rebase collision no one resolved — a human must merge it
  | 'verify' // the rebased result failed the gate: green alone, broken combined
  | 'race' // the branch moved mid-landing; retry
  | 'error'; // git itself refused

/**
 * The branch this run lands on (RUN-28).
 *
 * `[land].branch` may contain `<planKey>` — "noriq/plan-<planKey>" — giving each plan its own
 * working branch. That is what makes a merge request mean anything: a human reviews one coherent
 * plan's worth of work, rather than a click per run or a surprise on main.
 *
 * A run with no plan (a one-off dispatch) must NOT land on a branch literally called
 * "noriq/plan-<planKey>", so the placeholder and any separator clinging to it are stripped. The
 * result is the sensible fallback — "noriq/plan-<planKey>" becomes "noriq/plan", one shared
 * branch for one-offs — rather than a branch named after a template.
 */
export function resolveLandBranch(template: string, planKey: string | null): string {
  if (!template.includes('<planKey>')) return template;
  if (planKey) return template.replaceAll('<planKey>', planKey);
  // Strip the placeholder AND a trailing separator, so "noriq/plan-<planKey>" → "noriq/plan"
  // rather than "noriq/plan-".
  return template.replaceAll('<planKey>', '').replace(/[-_/]+$/, '') || template;
}

/**
 * Does `branch` match one of the repo's allowed globs? (RUN-41)
 *
 * Supports the two shapes a human actually writes:
 *   "feature/**"  → feature/ and anything under it, at any depth
 *   "wip/*"       → one segment only: wip/foo, but NOT wip/foo/bar
 *   "exact-name"  → itself
 *
 * Hand-rolled rather than a glob dependency: the vocabulary is two wildcards, and the alternative
 * is pulling a package into a security decision. Escaping everything else means a branch called
 * `release.v1` cannot be matched by `release+v1` through regex accident.
 */
export function branchAllowed(branch: string, globs: string[]): boolean {
  return globs.some((glob) => {
    const rx = glob
      .split(/(\*\*|\*)/)
      .map((part) =>
        part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      )
      .join('');
    return new RegExp(`^${rx}$`).test(branch);
  });
}

/** Why a dispatch's branch override was refused (RUN-41). Null = allowed. */
export function rejectTargetBranch(
  target: string,
  policy: { branch: string; allowedBranches: string[] },
): string | null {
  // The computed target is always fine — that IS the repo's own choice, and a dispatch naming it
  // explicitly is asking for the default.
  if (target === policy.branch) return null;
  if (!policy.allowedBranches.length) {
    return 'this repo does not allow a dispatch to choose its landing branch — add [land].allowedBranches to opt in';
  }
  if (!branchAllowed(target, policy.allowedBranches)) {
    return `"${target}" is not in this repo's [land].allowedBranches (${policy.allowedBranches.join(', ')})`;
  }
  return null;
}

export interface LandOutcome {
  landed: boolean;
  branch: string;
  /** The integration branch's new tip, when something actually landed. */
  sha?: string;
  reason?: LandFailure;
  detail?: string;
  /** Files git could not merge, when reason = 'conflict'. */
  conflicts?: string[];
  /** Whether an agent was asked to resolve, and whether it did. */
  resolvedByAgent?: boolean;
  /**
   * `[land].autoPush` only (RUN-27). Undefined = not attempted (autoPush off, or nothing
   * landed). true = the branch reached its remote. false = it did not — and the run is still a
   * SUCCESS, because the work is landed locally; only its trip to the remote failed.
   */
  pushed?: boolean;
  /** Why the push failed, when pushed === false. */
  pushDetail?: string;
}

/**
 * Ask the build agent to resolve its own rebase conflict.
 *
 * The instruction is deliberately narrow. A conflict is only safe to auto-resolve when
 * the intent of both sides is obvious and preserved — two features appended to the same
 * list, an import block, a formatting collision. The moment resolving requires *deciding*
 * something (which of two competing designs wins, whether a refactor invalidates the
 * other side, whether a signature change is compatible), a human has to look. An agent
 * that resolves those by picking one is the failure mode this whole gate exists to stop:
 * it silently deletes someone's work and reports success.
 *
 * So the prompt makes bailing out the honourable, explicitly-blessed option — an agent
 * that isn't sure is told to say so, and told that saying so is correct behaviour rather
 * than failure. That asymmetry is the safety property.
 *
 * The wording speaks in the INTEGRATION outcome, not git verbs (no "rebase", no "git rebase
 * --continue") — the same outcome-not-verb contract vcs/types.ts is built on, so this prompt
 * holds on any backend whose conflicts are editable files. A backend whose conflicts live
 * server-side sets `IntegrateResult.resolveUrl` and never reaches an agent at all. The diff3
 * conflict markers (<<<<<<< / ======= / >>>>>>>) stay literal: they are universal, not git's.
 */
export function assembleConflictPrompt(opts: {
  conflicts: string[];
  landBranch: string;
  task?: AnchorTask | null;
  verifyCmd?: string | null;
}): string {
  return renderPrompt('conflict', {
    landBranch: opts.landBranch,
    task: opts.task ? `${opts.task.key} — ${opts.task.title}` : null,
    files: opts.conflicts.map((f) => `  - ${f}`).join('\n'),
    verifyCmd: opts.verifyCmd ?? null,
  });
}

/** Did the agent claim it resolved? Absent/ambiguous ⇒ NO (same posture as the verdict parser). */
export function parseResolution(text: string): boolean {
  const m = text.match(/^\s*RESOLVED:\s*(YES|NO)\s*$/gim);
  if (!m?.length) return false;
  return /YES/i.test(m[m.length - 1] as string);
}

/** The comment posted when a run's work could not be landed — the human's cue to act. */
export function landFailureComment(o: LandOutcome, runId: string): string {
  const head = `⚠️ Could not land onto \`${o.branch}\` — the diff is still on \`noriq/run/${runId}\` for you.`;
  if (o.reason === 'conflict') {
    const files = (o.conflicts ?? []).map((f) => `- \`${f}\``).join('\n');
    const agent =
      o.resolvedByAgent === false
        ? '\n\nThe build agent looked and judged it not mechanically resolvable:'
        : '';
    return `${head}\n\n**Rebase conflict** against \`${o.branch}\`:\n${files}${agent}\n\n${o.detail ?? ''}`.trim();
  }
  if (o.reason === 'verify') {
    return `${head}\n\n**It passed on its own base but fails on \`${o.branch}\`** — i.e. this change and something already landed are individually fine and broken together. That is exactly what rebase-then-verify is for.\n\n\`\`\`\n${o.detail ?? ''}\n\`\`\``;
  }
  if (o.reason === 'race') {
    return `${head}\n\n\`${o.branch}\` moved while this run was landing (another run won). Re-dispatching should pick up the new tip.\n\n${o.detail ?? ''}`;
  }
  return `${head}\n\n${o.detail ?? 'git refused the landing.'}`;
}
