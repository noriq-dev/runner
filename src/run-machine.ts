/**
 * The run pipeline, as an explicit ordered sequence instead of an implicit one (RUN-131).
 *
 * Until now the pipeline existed only as control flow: `supervise` ran ~400 lines of setup and a
 * driver, `afterDriver` ran ~400 more of gates and cleanup, and the ORDER of the stages — and which
 * of them a given workflow runs at all — could only be learned by reading both in full. Nothing
 * could assert over the sequence, and nothing could add to it without editing the middle of the
 * file that also holds the security-critical lifecycle.
 *
 * This module is the sequence as DATA. Each stage declares what it needs, what it produces, the
 * posture the actor it spawns runs under, whether it may spend the run's budget, how it retries,
 * and which terminal reasons it can set. The declarations are not decoration: RUN-132 has a
 * workflow declare its own stage list, and the pre-execution stages (RUN-140/141/144) are added by
 * appending descriptors rather than by growing `supervise`.
 *
 * **This file decides ORDER and APPLICABILITY. It never decides POSTURE.** A stage descriptor
 * *reports* the posture its actor runs under so the sequence can be read at a glance and asserted
 * over; the posture itself is still computed by `clampPermissionToWorkflow` at the point of spawn,
 * exactly as before. A stage is a role and a budget, never a permission escalation — so a
 * descriptor that claimed a wider posture than the clamp allows would change nothing, which is the
 * property that keeps this file out of the trust boundary.
 */

import type { Workflow } from './workflow';

/**
 * The stages, in pipeline order.
 *
 * `publish` is deliberately NOT one of them, though the plan names it. Sharing a landed branch is
 * the tail of a successful integration — it happens only when `[land].autoPush` is on, only for the
 * branch that just landed, and it has no gate of its own. It is a `VcsBackend` verb inside
 * `integrate`, and promoting it to a run stage would invent a boundary the security model does not
 * have. `settle` is the reverse case: not in the plan's list, but unmistakably a stage — it is
 * where the terminal report, the continuation record, the lock release, and the workspace decision
 * live, and it is the only stage that runs no matter how the run got there.
 */
export type StageName = 'prepare' | 'execute' | 'verify' | 'review' | 'integrate' | 'settle';

/** Which actor a stage spawns, in the vocabulary the permission floor already uses. */
export type StageActor =
  /** Spawns nothing — the daemon does the work itself, at no posture. */
  | 'none'
  /** The run's own agent, at the workflow's clamped profile. */
  | 'run'
  /** A FRESH judging actor: read-only, never the author (`clampPermissionToWorkflow` forces this). */
  | 'verify';

/** Whether a stage can spend the run's ceiling. `none` means zero tokens by construction. */
export type StageBudget = 'none' | 'run';

/** What a stage does with a failure before it gives up. */
export type StageRetry =
  /** One attempt. A failure is the stage's verdict. */
  | { kind: 'none' }
  /** Hands the failure BACK to the live session and looks again, bounded by `boundedBy`. */
  | { kind: 'feedback'; boundedBy: string };

export interface RunStage {
  name: StageName;
  /** One line: what this stage is FOR. */
  purpose: string;
  /** What must already be on the run context for this stage to run. */
  inputs: readonly string[];
  /** What it puts there. */
  outputs: readonly string[];
  actor: StageActor;
  budget: StageBudget;
  retry: StageRetry;
  /**
   * Every `exit.reason` this stage can produce. Empty = it cannot gate the run, only enrich it.
   * The union of these across the list is the complete set of ways a run fails, which is a fact
   * that previously existed nowhere.
   */
  terminal: readonly string[];
  /**
   * Whether this stage runs for a given workflow — the flag test, never a `kind` comparison
   * (RUN-116/117). A stage that applies may still no-op on a manifest that configures nothing;
   * that is the stage's own business, not the sequence's.
   */
  appliesTo: (wf: Workflow) => boolean;
}

const always = () => true;

export const RUN_STAGES: readonly RunStage[] = [
  {
    name: 'prepare',
    purpose: 'Turn a dispatch into a workspace, an identity, and a brief — or refuse it.',
    inputs: ['run'],
    outputs: [
      'repo',
      'driver',
      'workflow',
      'permission',
      'worktree',
      'runAgent',
      'task',
      'prompt',
      'tally',
      'continued',
    ],
    actor: 'none',
    budget: 'none',
    retry: { kind: 'none' },
    // Everything that can refuse a dispatch before a single token is spent. The claimability probe
    // (RUN-81) and the predictive lock (RUN-103) both live here for that reason.
    terminal: [
      'repo not found',
      'no driver',
      'not claimable',
      'workspace setup failed',
      'no identity',
      'lock scope refused',
    ],
    appliesTo: always,
  },
  {
    name: 'execute',
    purpose: 'Run the agent under the budget, steerable, until it stops talking — or parks.',
    inputs: ['prompt', 'worktree', 'permission', 'runAgent', 'tally'],
    outputs: ['exit', 'session', 'sessionText', 'tail'],
    actor: 'run',
    budget: 'run',
    retry: { kind: 'none' },
    terminal: ['failed', 'budget', 'cancelled'],
    appliesTo: always,
  },
  {
    name: 'verify',
    purpose: 'Make the diff durable, then put it through the checks that need no judgment.',
    inputs: ['exit', 'worktree'],
    outputs: ['exit'],
    // The deterministic floor is a COMMAND, not an agent — zero tokens, which is the whole reason
    // it runs before the reviewer (RUN-61).
    actor: 'none',
    budget: 'none',
    retry: { kind: 'feedback', boundedBy: 'MAX_VERIFY_FIXES' },
    terminal: ['no_changes', 'lock', 'lock:unchecked', 'verify'],
    appliesTo: always,
  },
  {
    name: 'review',
    purpose: 'A fresh adversarial actor judges the diff against the intent — what a suite cannot ask.',
    inputs: ['exit', 'worktree', 'session'],
    outputs: ['exit', 'ledger'],
    actor: 'verify',
    budget: 'run',
    retry: { kind: 'feedback', boundedBy: '[verify.agent].maxRounds' },
    terminal: ['review', 'review:no-verdict'],
    // Only a producing workflow has a diff to review. A verify run IS the reviewer.
    appliesTo: (wf) => wf.produces,
  },
  {
    name: 'integrate',
    purpose: 'Rebase onto the landing branch, re-verify THERE, fast-forward in — under the repo lock.',
    inputs: ['exit', 'worktree'],
    outputs: ['exit', 'landed'],
    // Spawns an actor only to resolve a mechanical rebase conflict, and only when the manifest
    // opted in — it is the build's own session, continued.
    actor: 'run',
    budget: 'run',
    retry: { kind: 'none' },
    terminal: ['land:conflict', 'land:verify', 'land:error'],
    appliesTo: (wf) => wf.produces,
  },
  {
    name: 'settle',
    purpose: 'Report the terminal truth, record what a continuation needs, release, and clean up.',
    inputs: ['exit', 'tally'],
    outputs: [],
    actor: 'none',
    budget: 'none',
    retry: { kind: 'none' },
    // Settling carries exactly ONE gate, and only for a workflow that is itself the verify actor:
    // its own output is the verdict, and that output is only final once the session that wrote it
    // is closed — which is the first thing this stage does. Every other gate has run by now.
    terminal: ['verify_agent'],
    appliesTo: always,
  },
] as const;

/** The stages a workflow actually runs, in order. The list is the pipeline (RUN-132 will let a
 *  repo-defined workflow name its own). */
export function stagesFor(wf: Workflow): readonly RunStage[] {
  return RUN_STAGES.filter((s) => s.appliesTo(wf));
}

/** Look one up by name — for the supervisor, which reports the stage it is entering. */
export function stage(name: StageName): RunStage {
  const found = RUN_STAGES.find((s) => s.name === name);
  if (!found) throw new Error(`no such run stage: ${name}`); // unreachable: StageName is the domain
  return found;
}

/** Every terminal reason the pipeline can produce, deduped. A run that fails for a reason outside
 *  this set means a stage grew one without declaring it. */
export function declaredTerminals(): readonly string[] {
  return [...new Set(RUN_STAGES.flatMap((s) => s.terminal))];
}
