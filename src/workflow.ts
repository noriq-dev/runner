import type { PermissionProfile, ProjectManifest, Run, RunKind, WorkflowStages } from '@noriq-dev/shared';
import { type AgentCoordinate, tryParseCoordinate } from './agent-coordinate';
import type { logger } from './logger';
import {
  type StageActor,
  type StageName,
  clampStagesToWorkflow,
  isStageName,
  stageActorFor,
} from './run-machine';
import type { LoadedWorkflowDefinition, WorkflowCatalog } from './workflow-store';

/** A stage coordinate key: a machine stage, or `plan-check` — the plan-checker's actor, which is a
 *  separately-addressable agent (RUN-193) but never a pipeline stage (it does not enter `stages`).
 *  There is deliberately no `verify-agent` key: the dispatched verify actor IS a verify-based
 *  workflow's own `execute` stage, so it is addressed there. */
export type StageCoordinateKey = StageName | 'plan-check';
const NON_PIPELINE_STAGE_KEYS: ReadonlySet<string> = new Set(['plan-check']);

/** Whether a declared `[stages.<key>]` key selects an agent — a pipeline stage or `plan-check`.
 *  Anything else is a typo, dropped (and warned about at load, WorkflowStore). */
export const isStageCoordinateKey = (key: string): key is StageCoordinateKey =>
  isStageName(key) || NON_PIPELINE_STAGE_KEYS.has(key);

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
   * The agent coordinate this stage's actor runs under (`claude.opus-4_8.high`, RUN-113).
   * Null = inherit, which is what every built-in says: the run's own coordinate for a `run` role,
   * the repo's `[verify.agent]` for a judging one.
   *
   * Consumed since RUN-193: `stageCoordinate(wf, name)` parses it and every spawn site folds it in
   * at the TOP of its ladder (`stageOf(wf,'execute')?.agent` → the builder; `'review'` → the inline
   * reviewer, above `[verify.agent]`). Carried through the clamp untouched because a coordinate
   * chooses a MODEL and never a posture — the write floor does not care which model is judging.
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
  /** File that supplied a custom prompt. Present only for user-authored templates, whose missing
   *  variables warn and degrade rather than throwing like bundled templates. */
  promptSource?: string | null;
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
  /**
   * Coordinates for actors that are NOT pipeline stages (RUN-193) — today only `plan-check`, the
   * plan-checker's own agent. Pipeline-stage coordinates live on their `WorkflowStage.agent` (read
   * via `stageOf`); this record is the home for a key `stages` cannot carry because it never enters
   * the pipeline. Absent on every built-in and on a workflow that declares none.
   */
  stageAgents?: Readonly<Record<string, string>>;
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
    // `plan` (RUN-140) sits where the machine runs it — between prepare and execute. The order
    // here is cosmetic: `stagesFor` returns `RUN_STAGES` order whatever a declaration says, which
    // is why planning cannot end up after the build it was meant to brief. Writing it in the real
    // order anyway keeps this list readable as the pipeline it describes.
    stages: [
      declare('prepare', 'none'),
      declare('plan', 'verify'),
      declare('pattern-map', 'verify'),
      declare('execute', 'run'),
      declare('verify', 'none'),
      declare('review', 'verify'),
      declare('integrate', 'run'),
      declare('settle', 'none'),
    ],
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
 * Resolve one bundled workflow posture (RUN-116). `runWorkflow` first gives a loaded definition
 * with the selected name the chance to inherit one of these postures, including when a legacy
 * dispatch selects the name through `kind` alone (RUN-192).
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
 * Resolve a workflow by id (RUN-119/192): a built-in kind name, or a loaded custom definition.
 * Project and user definitions are already merged by WorkflowStore; a matching definition wins
 * over the bundled name, while its declared `base` remains the sole source of posture. A custom
 * workflow inherits its `base` built-in's posture verbatim (so the write floor and every gate come
 * from a known-safe foundation) and only carries its own id + prompt override. An id that names
 * neither returns `undefined`, so the caller can fall back without guessing a posture.
 */
export function resolveWorkflow(
  id: string,
  source: Pick<ProjectManifest, 'workflows'> | WorkflowCatalog,
): Workflow | undefined {
  const custom = workflowDefinition(source, id);
  if (!custom && isBuiltinId(id)) return BUILTIN_WORKFLOWS[id];
  if (!custom || !Object.hasOwn(BUILTIN_WORKFLOWS, custom.base)) return undefined;
  const base = BUILTIN_WORKFLOWS[custom.base];
  // The stage list a custom workflow runs (RUN-132/193): the DECLARED list when the marker carries
  // one (`WorkflowDef.stages`, contract v2), else the base's verbatim. Either way it goes through
  // the same `clampStagesToWorkflow` — a declaration can decline an optional stage and pick an
  // agent, never enable one this posture may not run nor widen a role. `stagesFor` unions the
  // mandatory stages back in at the point of use, so a declared list that omits them changes
  // nothing (RUN-132's floor).
  const { stages, stageAgents } = custom.stages
    ? buildDeclaredStages(custom.stages, base)
    : { stages: clampStagesToWorkflow(base.stages, base), stageAgents: {} };
  return {
    ...base,
    id,
    promptRef: custom.prompt,
    promptSource: custom.promptSource,
    stages,
    ...(Object.keys(stageAgents).length ? { stageAgents } : {}),
  };
}

/**
 * Turn a declared `WorkflowStages` (array | record — the two spellings of one declaration, RUN-193)
 * into the clamped pipeline list plus the non-pipeline coordinates.
 *
 * The declared SET is the array's entries or the record's keys (locked decision: declaring only
 * `[stages.review]` declines the other optional stages). A key that names a machine stage becomes a
 * `WorkflowStage` — carrying its coordinate from the record form, none from the array form — and
 * flows through `clampStagesToWorkflow` exactly like a built-in's list. `plan-check` is kept aside
 * on `stageAgents` because it selects an agent but never runs as a pipeline stage. Any other key is
 * a typo and is dropped (warned about at load, WorkflowStore) — a declaration may narrow and steer
 * the pipeline, never invent a stage.
 */
function buildDeclaredStages(
  declared: WorkflowStages,
  base: Workflow,
): { stages: readonly WorkflowStage[]; stageAgents: Record<string, string> } {
  const entries: Array<[string, string | null]> = Array.isArray(declared)
    ? declared.map((name) => [name, null])
    : Object.entries(declared).map(([name, def]) => [name, def.agent]);
  const list: WorkflowStage[] = [];
  const stageAgents: Record<string, string> = {};
  for (const [name, agent] of entries) {
    if (isStageName(name)) {
      // `role` is a placeholder — `clampStagesToWorkflow` overwrites it with the machine's own
      // actor. Set it honestly anyway so a mid-pipeline read before the clamp is not misleading.
      list.push({ name, role: stageActorFor(name), agent });
    } else if (name === 'plan-check' && agent) {
      stageAgents[name] = agent;
    }
  }
  return { stages: clampStagesToWorkflow(list, base), stageAgents };
}

type DefinitionSource = Pick<ProjectManifest, 'workflows'> | WorkflowCatalog;

const workflowDefinition = (
  source: DefinitionSource,
  id: string,
): (LoadedWorkflowDefinition & { promptSource: string | null }) | undefined => {
  if ('definitions' in source) {
    return Object.hasOwn(source.definitions, id) ? source.definitions[id] : undefined;
  }
  const custom = source.workflows && Object.hasOwn(source.workflows, id) ? source.workflows[id] : undefined;
  if (!custom) return undefined;
  // Mirrors WorkflowStore's inline tier: the v2 contract allows `prompt = { file = ... }` here,
  // but file prompts are wired only for dedicated workflow files (RUN-192) — an inline one
  // degrades to the base prompt while the declared posture and description hold.
  const prompt = typeof custom.prompt === 'string' ? custom.prompt : null;
  return {
    base: custom.base,
    prompt,
    promptSource: prompt === null ? null : '.noriq/project.toml',
    // The inline tier's declared pipeline (RUN-193). Already `WorkflowStages | null` off the
    // zod-validated manifest, so it rides through unchanged — the file tiers, which parse raw TOML,
    // validate it in WorkflowStore instead.
    stages: custom.stages ?? null,
    description: custom.description,
    source: '.noriq/project.toml',
    tier: 'project-manifest',
  };
};

/**
 * The workflow a run actually executes (RUN-132/192): its explicit `workflow`, or otherwise its
 * `kind`, resolved through the per-dispatch catalog before falling back to the bundled posture.
 *
 * A custom definition may deliberately select a different bundled base, but it cannot invent a
 * posture: `effectiveKind` (RUN-126) and every machine-owned clamp derive from that selected base.
 * Loaded text therefore changes prompt content, never stage ordering or permission mechanics.
 */
export function runWorkflow(
  run: Pick<Run, 'kind' | 'workflow'>,
  source: Pick<ProjectManifest, 'workflows'> | WorkflowCatalog,
): Workflow {
  const id = run.workflow ?? run.kind;
  const named = resolveWorkflow(id, source);
  if (named) return named;
  // The id resolved nothing. On the DISPATCH path this is unreachable for a SELECTED name:
  // prepare's gate (RUN-196) refuses a dispatch whose explicit `workflow` does not resolve before
  // anything is acquired, rather than running a built-in prompt the operator did not choose. This
  // fallback stays as the FAIL-SAFE for the paths that never pass that gate — parked rehydration
  // from disk, `waveFor`, `startAgent`'s clamp — where degrading to a narrow posture is the
  // security property. A `kind` the wire schema should have rejected falls back to SCOPE — the
  // narrowest posture, not the nearest one, and the direction matters: a fallback that guessed
  // `build` would answer "I don't recognise this" with "then you may write and land".
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
 * The parsed coordinate a workflow declares for one stage's actor (RUN-193), or null when it names
 * none — the cue for every spawn to fall to the next rung of its ladder. THE one place the raw
 * string is parsed: it owns the `tryParse` + warn so a malformed coordinate degrades to the next
 * rung (never gates), and a caller reads an `AgentCoordinate`, not a hand-edited string.
 *
 * A pipeline-stage key reads through `stageOf`, so a stage this workflow does not run answers null
 * (declining `review` leaves nothing for the reviewer to run under). `plan-check` reads from
 * `stageAgents`, since it selects an agent without being a pipeline stage.
 */
export function stageCoordinate(
  wf: Workflow,
  key: StageCoordinateKey,
  log?: Pick<typeof logger, 'warn'>,
): AgentCoordinate | null {
  const raw =
    key === 'plan-check' ? (wf.stageAgents?.['plan-check'] ?? null) : (stageOf(wf, key)?.agent ?? null);
  if (!raw) return null;
  const parsed = tryParseCoordinate(raw);
  if (!parsed) {
    log?.warn('workflow stage names a malformed agent coordinate — inheriting the run’s instead', {
      workflow: wf.id,
      stage: key,
      agent: raw,
    });
    return null;
  }
  return parsed;
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
