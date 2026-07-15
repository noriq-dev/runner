import type { AnchorTask } from './supervisor';

/**
 * The landing step: a build that cleared the gate is rebased onto the integration
 * branch, re-verified THERE, and fast-forwarded in — no human per run.
 *
 * This module holds the pure bits (prompt + reporting text). The git work lives in
 * WorktreeManager and the orchestration in RunSupervisor.
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
 */
export function assembleConflictPrompt(opts: {
  conflicts: string[];
  landBranch: string;
  task?: AnchorTask | null;
  verifyCmd?: string | null;
}): string {
  const files = opts.conflicts.map((f) => `  - ${f}`).join('\n');
  const task = opts.task ? `${opts.task.key} — ${opts.task.title}` : 'the task you just implemented';
  const verify = opts.verifyCmd
    ? `\nWhen the files are resolved, run: ${opts.verifyCmd}\nIf it does not pass, do NOT force it — say so and stop.`
    : '';
  return `Your change is being rebased onto ${opts.landBranch} so it can land, and git could not merge it automatically.

You implemented: ${task}
Conflicted files:
${files}

The rebase is IN PROGRESS in this worktree. Resolve ONLY if the resolution is mechanical and preserves BOTH sides' intent — e.g. two additions to the same list/import block, or a formatting collision. Edit the files to remove every conflict marker (<<<<<<<, =======, >>>>>>>). Do NOT commit, do not run git rebase --continue — the daemon does that.${verify}

STOP and explain instead if resolving would mean DECIDING anything:
  - the two sides implement competing versions of the same behavior,
  - the other side refactored/renamed/moved what you changed,
  - a signature, schema, or contract changed under you,
  - you cannot tell what the other side intended.

Bailing out is the CORRECT answer in those cases, not a failure — a human will merge it. Picking a winner silently discards someone's work, which is far worse than waiting.

End your response with EXACTLY one line, on its own:
  RESOLVED: YES   — every conflict marker is gone and both intents are preserved
  RESOLVED: NO    — this needs a human (then explain what the collision actually is)`;
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
