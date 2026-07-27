import type { PermissionProfile, ProjectManifest, Run, RunKind } from '@noriq-dev/shared';
import { type StageActor, type StageName, clampStagesToWorkflow } from './run-machine';

/**
 * One stage as the WORKFLOW declares it (RUN-132).
 *
 * The division of labour with `RunStage` (run-machine.ts) is the whole design and is worth stating
 * plainly, because getting it backwards would put a manifest inside the trust boundary:
 *
 *   - the MACHINE owns what a stage IS — its order in the sequence, its inputs and outputs, the
 *     posture its actor runs under, which workflows may run it at all, and whether it may be
 *     declined;
 *   - the WORKFLOW owns only whether it runs an OPTIONAL one, and which model does the work.
 *
 * So a declaration here can narrow the pipeline and pick an agent, and nothing else. A `role` wider
 * than the machine's own `actor` is clamped down (`clampStagesToWorkflow`), and the posture that
 * actually reaches a spawn is still `clampPermissionToWorkflow`'s — a declaration is *reported*,
 * never granted.
 */
export interface WorkflowStage {
  name: StageName;
  /**
   * Which actor this stage runs, in the machine's own vocabulary. Reported, not granted: it may
   * never exceed the machine's `RunStage.actor`, and a declaration that tries is narrowed at
   * resolution — so `role` is a statement about the pipeline, never a lever on it.
   */
  role: StageActor;
  /**
   * The agent coordinate this stage's actor would run under (`claude.opus-4_8.high`, RUN-113).
   * Null = inherit, which is what every built-in says: the run's own coordinate for a `run` role,
   * the repo's `[verify.agent]` for a judging one.
   *
   * **Declared, not yet consumed.** Nothing can set it — `WorkflowDef` (the vendored contract)
   * carries `base` + `prompt` only — so no spawn reads it today, and `runReviewer` says where it
   * would go. It is carried through the clamp untouched because a coordinate chooses a MODEL and
   * never a posture: the write floor does not care which model is judging.
   */
  agent: string | null;
}

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
  /** A custom prompt (template name or inline text) overriding the base's default brief (RUN-119).
   *  Absent/null on a built-in → the promptShape's own template. Consumed by RUN-121. */
  promptRef?: string | null;
  /**
   * The stages this workflow runs (RUN-132) — the pipeline, declared rather than derived.
   *
   * It replaces reading `RunStage.appliesTo` as the ONLY answer, but not as the FLOOR. What
   * `stagesFor` actually runs is `(mandatory ∪ declared) ∩ appliesTo`, which bounds a declaration
   * from both ends: it can turn an OPTIONAL stage off, it can never turn one on that this posture
   * may not run, and it can never decline one the machine marks mandatory. Order is not declared
   * here either — it comes from `RUN_STAGES`, because "reviews before it integrates" is a security
   * ordering and not a preference.
   */
  stages: readonly WorkflowStage[];
}

/** A stage a built-in declares: the machine's own role, no coordinate — inherit whatever the run or
 *  the repo already names. Every built-in list is written this way, which is why RUN-132 changes no
 *  behaviour: the declarations restate exactly what `appliesTo` already computed. */
const declare = (name: StageName, role: StageActor): WorkflowStage => ({ name, role, agent: null });

/** The stages every workflow runs. Not a convention: `RunStage.optional` marks these mandatory and
 *  `stagesFor` unions them back in, so omitting one from a declaration changes nothing. Listing them
 *  here anyway keeps each built-in readable as its whole pipeline rather than as a delta. */
const SPINE: readonly WorkflowStage[] = [
  declare('prepare', 'none'),
  declare('execute', 'run'),
  declare('verify', 'none'),
];

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
    // Nothing to review and nothing to land: a scope run produces a plan, not a diff.
    stages: [...SPINE, declare('settle', 'none')],
  },
  build: {
    id: 'build',
    promptShape: 'build',
    worktreeWritable: true,
    produces: true,
    verifyActor: false,
    usesPlanBase: true,
    stages: [...SPINE, declare('review', 'verify'), declare('integrate', 'run'), declare('settle', 'none')],
  },
  verify: {
    id: 'verify',
    promptShape: 'verify',
    worktreeWritable: true,
    produces: false,
    verifyActor: true,
    usesPlanBase: true,
    // A verify run IS the reviewer — it does not spawn another one, and its own verdict is read in
    // `settle` once the session that wrote it is closed.
    stages: [...SPINE, declare('settle', 'none')],
  },
};

/**
 * Resolve a run's workflow (RUN-116). A legacy dispatch carries only a `kind`, which maps to its
 * matching built-in; a `workflow` id names a custom one (RUN-121) via `runWorkflow`.
 *
 * Falls back to SCOPE for a kind outside the union rather than returning undefined — this is what
 * `startAgent`'s write clamp calls (RUN-158), and `clampPermissionToWorkflow(profile, undefined)`
 * would throw on `wf.produces` at exactly the moment the floor is supposed to hold. Scope is the
 * narrowest posture, so the degenerate answer is also the fail-closed one.
 */
export function workflowFor(kind: RunKind): Workflow {
  return Object.hasOwn(BUILTIN_WORKFLOWS, kind) ? BUILTIN_WORKFLOWS[kind] : BUILTIN_WORKFLOWS.scope;
}

// `Object.hasOwn`, never `in`: `'toString' in BUILTIN_WORKFLOWS` is TRUE, and the lookup then hands
// back `Object.prototype.toString` cast to a Workflow. A dispatch naming `toString`/`constructor`/
// `__proto__` used to degrade quietly (`wf?.promptShape ?? run.kind` fell through on a function);
// once a caller reads `wf.stages` it throws instead. Same guard on the manifest's record below — a
// zod `z.record` is a plain object and carries the same prototype.
const isBuiltinId = (id: string): id is RunKind => Object.hasOwn(BUILTIN_WORKFLOWS, id);

/**
 * Resolve a workflow by id (RUN-119): a built-in kind name, or a repo-defined `[workflow.<name>]`.
 * A built-in id ALWAYS wins over a same-named custom one — a repo cannot redefine `build` and
 * quietly widen it. A custom workflow inherits its `base` built-in's posture verbatim (so the
 * write floor and every gate come from a known-safe foundation) and only carries its own id +
 * prompt override. An id that names neither returns `undefined`, so the caller can fall back to the
 * run's kind rather than guessing a posture.
 */
export function resolveWorkflow(
  id: string,
  manifest: Pick<ProjectManifest, 'workflows'>,
): Workflow | undefined {
  if (isBuiltinId(id)) return BUILTIN_WORKFLOWS[id];
  const defined = manifest.workflows;
  const custom = defined && Object.hasOwn(defined, id) ? defined[id] : undefined;
  if (!custom || !Object.hasOwn(BUILTIN_WORKFLOWS, custom.base)) return undefined;
  const base = BUILTIN_WORKFLOWS[custom.base];
  // The stage list a custom workflow runs (RUN-132). It inherits the base's verbatim today, which
  // is also all the committed marker can express: `WorkflowDef` carries `base` + `prompt` and no
  // stage list, and that schema is the VENDORED wire contract — it grows upstream, with the
  // phase-3 vendor refresh, not by hand-editing vendor/. What lands here is the mechanism and its
  // floor: swap the `base.stages` below for the manifest's declared list and the surface is wired,
  // already clamped, with the tests below already covering what a declaration may and may not do.
  const stages = clampStagesToWorkflow(base.stages, base);
  return { ...base, id, promptRef: custom.prompt, stages };
}

/**
 * The workflow a run actually executes (RUN-132): its named one when the repo defines it, else its
 * kind's built-in.
 *
 * The posture is identical either way — a custom workflow inherits its base's flags verbatim and
 * `effectiveKind` (RUN-126) keeps the daemon authoritative about which base that is — so this can
 * never be an escalation. What a named workflow adds is its prompt (RUN-121) and its stage list.
 */
export function runWorkflow(
  run: Pick<Run, 'kind' | 'workflow'>,
  manifest: Pick<ProjectManifest, 'workflows'>,
): Workflow {
  const named = run.workflow ? resolveWorkflow(run.workflow, manifest) : undefined;
  if (named) return named;
  // A `kind` the wire schema should have rejected falls back to SCOPE — the narrowest posture, not
  // the nearest one. Unreachable for a real dispatch, and the direction matters anyway: a fallback
  // that guessed `build` would answer "I don't recognise this" with "then you may write and land".
  return Object.hasOwn(BUILTIN_WORKFLOWS, run.kind)
    ? BUILTIN_WORKFLOWS[run.kind as RunKind]
    : BUILTIN_WORKFLOWS.scope;
}

/** What this workflow declared for one stage, or undefined when it does not run it. Already
 *  clamped — a caller reads a coordinate, never a permission. */
export function stageOf(wf: Workflow, name: StageName): WorkflowStage | undefined {
  return wf.stages.find((s) => s.name === name);
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
