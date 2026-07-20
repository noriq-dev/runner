import type { PermissionProfile, RunKind } from '@noriq-dev/shared';

/**
 * A workflow (RUN-116) is the SHAPE of a run — what it may touch, what it produces, and which gates
 * fire — lifted out of the hard-coded `scope`/`build`/`verify` switch that used to live inline in
 * the supervisor. Today three built-in workflows reproduce the three kinds byte-for-byte; RUN-117
 * makes the supervisor read these flags instead of comparing `kind`, and RUN-120 lets a repo define
 * its own. A workflow carries a POSTURE, not just a prompt: the safety floor (RUN-118) is enforced
 * regardless of what a workflow declares, so a custom one can move a boundary but never breach it.
 */
export interface Workflow {
  /** Stable id. The built-ins are exactly the three kinds; a custom workflow names its own. */
  id: string;
  /** Which prompt family assembles the brief. The built-ins map 1:1 to the `scope`/`build`/`verify`
   *  templates; a custom workflow (RUN-121) may name its own template. */
  promptShape: 'scope' | 'build' | 'verify';
  /**
   * May the run's WORKTREE be written? `scope` explores a read-only checkout; `build` and `verify`
   * both need a writable tree — verify runs the suite, which writes node_modules / build output.
   * This is NOT whether the AGENT may edit source: that is the permission profile, and a verify
   * agent is read-only THERE while its worktree is writable HERE.
   */
  worktreeWritable: boolean;
  /**
   * Does this run PRODUCE edits meant to land? Only `build`. Gates the entire tail —
   * checkpoint → deterministic verify floor → land → adversarial reviewer — plus the reactive and
   * predictive lock layers and continue-on-failure. `scope` plans; `verify` judges; neither lands.
   */
  produces: boolean;
  /**
   * Is this an adversarial verify ACTOR — executes but never edits, emits a verdict, and carries a
   * `verifiesRunId`? The dispatched-`verify` posture (distinct from the inline reviewer, which is
   * the same role inlined into a build's gate).
   */
  verifyActor: boolean;
  /** Fork from the plan's base (build/verify build ON approved work) rather than the repo default
   *  (scope explores from the tip). */
  usesPlanBase: boolean;
}

/** The three built-in workflows — the `scope`/`build`/`verify` kinds expressed as data, reproducing
 *  today's behavior exactly (RUN-116). Keyed by id for the kind→workflow back-compat map. */
export const BUILTIN_WORKFLOWS: Record<RunKind, Workflow> = {
  scope: {
    id: 'scope',
    promptShape: 'scope',
    worktreeWritable: false,
    produces: false,
    verifyActor: false,
    usesPlanBase: false,
  },
  build: {
    id: 'build',
    promptShape: 'build',
    worktreeWritable: true,
    produces: true,
    verifyActor: false,
    usesPlanBase: true,
  },
  verify: {
    id: 'verify',
    promptShape: 'verify',
    worktreeWritable: true,
    produces: false,
    verifyActor: true,
    usesPlanBase: true,
  },
};

/** Resolve a run's workflow (RUN-116). A legacy dispatch carries only a `kind`, which maps to its
 *  matching built-in; RUN-121 will let a `workflow` id name a custom one, falling back to this. */
export function workflowFor(kind: RunKind): Workflow {
  return BUILTIN_WORKFLOWS[kind];
}

/**
 * The permission FLOOR a workflow imposes, enforced regardless of what the manifest asked for
 * (RUN-118). A workflow that does not `produce` edits — scope explores, verify judges — can NEVER
 * be handed write, even if a (mis)configured or hostile manifest sets `[permissions.<kind>].write
 * = true`. This is the code half of the "verify executes but never edits" invariant: authorship
 * separation cannot be a manifest's to opt out of. A producing workflow keeps its declared profile
 * verbatim (its writes are the point, gated downstream by verify/land, not here).
 *
 * Applied at EVERY site that hands a run its permission, so the floor holds no matter which path
 * (fresh dispatch, resume, continue) reached the driver — and so a future CUSTOM workflow inherits
 * it for free. Deny/env-stripping/the Noriq tool floor are enforced elsewhere and are likewise
 * workflow-independent; this covers the one lever a workflow's posture governs.
 */
export function clampPermissionToWorkflow(profile: PermissionProfile, wf: Workflow): PermissionProfile {
  if (wf.produces || !profile.write) return profile;
  return { ...profile, write: false };
}
