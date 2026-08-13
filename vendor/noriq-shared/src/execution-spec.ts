import { z } from 'zod';

// ---------------------------------------------------------------------------
// The execution spec (RUN plan, Phase 3 — RUN-134).
//
// What a task tells a builder BEFORE it is allowed to spend anything: where the
// work goes, what to read, what has already been decided, where it may use its
// own judgement, and how anyone will know it is done. Adapted from gsd-core's
// PLAN.md frontmatter.
//
// It lives HERE, in the server contract, and not in the runner. Noriq is already
// the durable authority for requirements, plans, tasks and docs; a runner-local
// copy would be a second source of truth and a synchronisation dispute waiting
// to happen. The runner consumes this through the vendored slice.
//
// SCOPE OF THIS FILE: the schema and nothing else. Nothing carries a spec yet —
// attaching one to a task and a plan phase is RUN-135, the MCP surface is
// RUN-136, and the runner picks it up at the vendor refresh in RUN-138. So this
// is a shape that compiles and validates; it is not yet a field anyone can set.
//
// Two shape rules the rest of the plan leans on:
//
//   1. EVERY field is optional, and the field that holds it (RUN-135) is
//      nullable. A spec filled in halfway is valid; so is a task with none.
//
//      That is PERMANENT, not a deprecation window (settled by RUN-163, which
//      went looking for windows to close and found this one mislabelled). A task
//      nobody planned is a legitimate state, not a legacy one: it is what the
//      planner stage (RUN-140) exists to act on, and what `hasExecutionSpec`
//      exists to detect. Calling it a window invites someone to close it, and
//      closing it would make every unplanned dispatch invalid.
//   2. Absent and empty mean the same thing to a CONSUMER, which is why
//      `spec ?? emptyExecutionSpec()` is the right way to read one. They mean
//      different things to a PLANNER, which is what `hasExecutionSpec` answers.
//
// Nothing here is part of the security floor. A wrong spec costs an agent
// orientation and a run its aim; the write floor, env stripping, and the lock
// layer are enforced elsewhere and are not weakened by anything a task declares.
// ---------------------------------------------------------------------------

/**
 * A repo-relative path, in git's spelling: `/`-separated, no leading slash, no
 * `..` segment, no drive letter or UNC prefix.
 *
 * Well-formedness, NOT a boundary. The daemon resolves these against the
 * worktree root and verifies containment on the opened descriptor (RUN-151),
 * which is the check that actually holds because it sees the resolved path and
 * the symlinks it went through. This one rejects the shapes that could never be
 * right in a committed, cross-platform contract, so they do not get as far as
 * being stored — and it must never be cited as the reason a path is safe.
 *
 * Backslashes are refused outright rather than translated. A wire contract has
 * one spelling of a path or it has two, and POSIX treats `\` as an ordinary
 * filename character — so `src\a.ts` is a Windows-authored `src/a.ts` on one
 * machine and a single strangely-named file on another. Refusing is the only
 * answer that means the same thing everywhere. It also disposes of `\rooted`,
 * `\\server\share`, and `\\?\C:\x`, which are absolute paths a check that only
 * looked for a leading `/` would have waved through.
 *
 * Deliberately stricter than "normalizes to somewhere inside": `a/../b` is
 * rejected though it is harmless, because a planner emitting it is confused
 * about the path it means and the spec is the wrong place to find that out.
 */
export const RepoPath = z
  .string()
  .min(1)
  .refine((p) => p.trim().length > 0, { message: 'must not be blank' })
  .refine((p) => !p.includes('\\'), {
    message: 'must use `/` separators — a backslash means different things on different platforms',
  })
  .refine((p) => !p.startsWith('/') && !/^[a-zA-Z]:/.test(p), {
    message: 'must be relative to the repo root (no leading `/`, no drive letter)',
  })
  .refine((p) => !/(^|\/)\.\.(\/|$)/.test(p), { message: 'must not contain a `..` segment' });
export type RepoPath = z.infer<typeof RepoPath>;

/**
 * What the run expects to do to a file.
 *
 * ORIENTATION ONLY. Nothing branches on it today: the runner's lock scope is a
 * list of paths (`resolveLockScope`), and the brief reads it as prose. It is
 * declared because "create" and "delete" are things a builder needs to be told
 * and a plan-checker needs to judge, not because a consumer keys off it.
 *
 * No `rename`: a rename is two paths and this carries one. Say it as a `delete`
 * and a `create`, which is also what any consumer would have to expand it to.
 */
export const AnticipatedChange = z.enum(['create', 'modify', 'delete']);
export type AnticipatedChange = z.infer<typeof AnticipatedChange>;

/**
 * A file the run expects to touch.
 *
 * This is what finally gives predictive locking a scope on a FIRST sitting
 * (RUN-142). The layer is bound and working today, but only a continuation has
 * ever fed it one — it inherits the previous sitting's `changedPaths` (RUN-130),
 * which is by definition unavailable the first time a task is attempted.
 * An empty list keeps exactly that behaviour: no predictive hold, with the
 * reactive per-edit layer and the hard floor as the guards.
 */
export const AnticipatedFile = z.object({
  path: RepoPath,
  change: AnticipatedChange.default('modify'),
  /** Why this file is in scope, in a phrase. Orientation for the builder, and the
   *  thing a plan-checker (RUN-141) would read to judge whether the scope coheres. */
  why: z.string().default(''),
});
export type AnticipatedFile = z.infer<typeof AnticipatedFile>;

/**
 * Something already settled that the run must NOT relitigate.
 *
 * The point is to stop paying for the same argument every run. An agent handed a
 * task with no decision history re-derives the design, sometimes differently, and
 * the reviewer then argues with a choice that was made weeks ago in a doc.
 */
export const LockedDecision = z.object({
  decision: z.string().min(1),
  /** The reasoning, so the constraint is understood rather than merely obeyed —
   *  an agent that knows WHY can tell when a case genuinely falls outside it. */
  because: z.string().default(''),
  /** Where it was settled: a doc id, a task key, a URL. Free-form because it spans
   *  Noriq ids and things that are not Noriq's at all. */
  source: z.string().default(''),
});
export type LockedDecision = z.infer<typeof LockedDecision>;

/**
 * A file the run is expected to produce, and what it must offer once it exists.
 *
 * Goal-backward: the criterion is the artifact's OBLIGATIONS, not "write this
 * file". Where `exports` is declared, a build that creates the path and exports
 * none of them has not met it. An empty `exports` declares no public surface —
 * common and not a gap, since templates, configs and test files have none.
 */
export const ExpectedArtifact = z.object({
  path: RepoPath,
  /** What this artifact is FOR, in a phrase — the obligation, not the filename. */
  provides: z.string().default(''),
  exports: z.array(z.string().min(1)).default([]),
});
export type ExpectedArtifact = z.infer<typeof ExpectedArtifact>;

/**
 * The wiring between two artifacts — the criterion that catches the classic
 * half-done build: every file present, every export defined, nothing calling any
 * of it. gsd-core names these the "key links", and they are the reason its
 * verification is goal-backward rather than file-by-file.
 */
export const ArtifactLink = z.object({
  /** The dependent side: a path, or a symbol within one. */
  from: z.string().min(1),
  /** What it must reach. */
  to: z.string().min(1),
  /** How they are wired, when naming it is what makes the link checkable —
   *  "registered in BUILTIN_WORKFLOWS", "bound in daemon.ts", "imported by cli.ts". */
  via: z.string().default(''),
});
export type ArtifactLink = z.infer<typeof ArtifactLink>;

/**
 * How anyone will know the work is done, stated as things that will be TRUE
 * rather than as steps to perform.
 *
 * The distinction is the whole point (RUN-145 is where these become per-item
 * evidence): "tests pass" is a step and reports itself; "a dispatch with no spec
 * still runs" is a truth, and a run has to demonstrate it.
 */
export const AcceptanceCriteria = z.object({
  /** Statements that must hold when the work is done. The unit of evidence. */
  observableTruths: z.array(z.string().min(1)).default([]),
  artifacts: z.array(ExpectedArtifact).default([]),
  links: z.array(ArtifactLink).default([]),
});
export type AcceptanceCriteria = z.infer<typeof AcceptanceCriteria>;

/**
 * One step of a decomposed run (RUN-148).
 *
 * A run whose work does not fit one context becomes a parent over these, each
 * executed by its own daemon-created session in its own workspace. The shape is
 * spec-shaped on purpose: a child consumes a step the way any run consumes a
 * spec, so the whole pre-execution machine — checking against the checkout,
 * pattern mapping, predictive locking, the acceptance checklist — applies to a
 * child without a second implementation of any of it.
 *
 * Authored by the PLANNER, never derived by the daemon. Which files belong to
 * one coherent piece of work is a judgement about the work; grouping a spec's
 * `anticipatedFiles` by directory or by count splits one change across two steps
 * and merges two unrelated ones, and the actor already judging the work is the
 * planner.
 */
export const ExecutionStep = z.object({
  /** Stable within one spec — what `dependsOn` names and what a transcript
   *  segment is labelled with. Bounded to what the `run.log` frame accepts for
   *  that label: an id the wire refuses would pass validation here and then make
   *  the server silently drop every segment the step ever emitted, since
   *  transcript frames are fire-and-forget. An identifier, not prose. */
  id: z.string().min(1).max(64),
  /** One line a human reads in a nested run list. */
  title: z.string().min(1),
  /** What this step expects to touch. The child's lock scope is THIS, not the
   *  parent's union — which is what makes a later wave schedule (RUN-149)
   *  possible, and is the correct hold for a sequential child anyway. */
  anticipatedFiles: z.array(AnticipatedFile).default([]),
  /** Step ids that must finish first. Empty = nothing gates it. Sequential
   *  execution ignores this and runs in declared order; it is what a wave
   *  schedule reads. */
  dependsOn: z.array(z.string().min(1)).default([]),
  /** The part of the definition of done this step is answerable for. The parent
   *  still owns the gate — a criterion is a statement about the finished work,
   *  and a step that satisfies its own slice can leave the whole unmet. */
  acceptance: AcceptanceCriteria.prefault({}),
});
export type ExecutionStep = z.infer<typeof ExecutionStep>;

/**
 * The checked execution spec a run is compiled from.
 *
 * Every field defaults, so `ExecutionSpec.parse({})` is the empty spec and a
 * partially-filled one never fails validation for what it left out. That is
 * deliberate: a planner (RUN-140) fills what it can and a checker (RUN-141)
 * judges the result — rejecting an incomplete spec at the schema would move that
 * judgement into zod, where it cannot explain itself.
 */
export const ExecutionSpec = z.object({
  /** Requirement ids this run satisfies — Noriq task keys, or an external
   *  tracker's ids. Free-form strings: the point is traceability from a line of
   *  the diff back to why it exists, and that chain leaves Noriq often enough. */
  requirementIds: z.array(z.string().min(1)).default([]),
  anticipatedFiles: z.array(AnticipatedFile).default([]),
  /** Read these first. Repo paths or Noriq doc ids — deliberately NOT `RepoPath`,
   *  because a doc reference is not a path and constraining it would force every
   *  planner to choose one or the other. The daemon confines whatever it resolves
   *  as a path; a `doc_…` id it fetches through the contract instead. */
  requiredReading: z.array(z.string().min(1)).default([]),
  lockedDecisions: z.array(LockedDecision).default([]),
  /** Where the run may use its own judgement, said out loud. Without this an agent
   *  cannot tell "unspecified because you decide" from "unspecified because nobody
   *  thought about it", and it treats every gap as the second kind. */
  discretion: z.array(z.string().min(1)).default([]),
  /** Explicitly NOT this run's work. Deferring in writing is what stops a build
   *  growing to fill its budget, and it stops the reviewer flagging a known,
   *  accepted gap as an omission. */
  deferred: z.array(z.string().min(1)).default([]),
  acceptance: AcceptanceCriteria.prefault({}),
  /**
   * The decomposition, when the work does not fit one context (RUN-148).
   *
   * EMPTY IS THE COMMON CASE and means a single run, exactly as before — a
   * planner declares steps only when it judges the work too large for one
   * agent to hold at once. Nothing downstream may treat an empty `steps` as a
   * defect: most work is one step and saying so would be noise on every task.
   */
  steps: z.array(ExecutionStep).default([]),
});
/** A parsed spec: every field present, defaults applied. What a consumer holds. */
export type ExecutionSpec = z.infer<typeof ExecutionSpec>;
/**
 * What an AUTHOR may write — every field optional, nested objects partial.
 *
 * Exported because `z.infer` is the OUTPUT type: a planner or an MCP caller
 * building `{ requiredReading: ['README.md'] }` is writing a valid spec that
 * `ExecutionSpec` the type rejects, since defaults have populated the rest by
 * then. Annotate wire input with this and parse it into the other.
 */
export type ExecutionSpecInput = z.input<typeof ExecutionSpec>;

/** The empty spec — every field present and empty. What a task with no spec at
 *  all is equivalent to for a consumer, and what a planner starts from. */
export const emptyExecutionSpec = (): ExecutionSpec => ExecutionSpec.parse({});

/**
 * One predicate per field: is there anything in it?
 *
 * Written as a map keyed by `ExecutionSpec` rather than a chain of `||` so that a
 * field added to the schema and forgotten here is a TYPE ERROR rather than a
 * silent wrong answer. The drift it prevents is not hypothetical: a new field
 * would be the only thing a planner filled in, `hasExecutionSpec` would answer
 * false, and the planner stage would overwrite a spec someone had written.
 */
const populated = {
  requirementIds: (v) => v.length > 0,
  anticipatedFiles: (v) => v.length > 0,
  requiredReading: (v) => v.length > 0,
  lockedDecisions: (v) => v.length > 0,
  discretion: (v) => v.length > 0,
  deferred: (v) => v.length > 0,
  acceptance: (v) => v.observableTruths.length > 0 || v.artifacts.length > 0 || v.links.length > 0,
  steps: (v) => v.length > 0,
} satisfies { [K in keyof ExecutionSpec]: (value: ExecutionSpec[K]) => boolean };

/**
 * Did anyone actually say anything in this spec?
 *
 * A consumer does not need this — absent and empty are the same to it, so
 * `spec ?? emptyExecutionSpec()` reads either. A PLANNER does: a spec that exists
 * but declares nothing has to be indistinguishable from no spec, or the planner
 * stage (RUN-140) skips a task nobody planned, and predictive locking (RUN-142)
 * takes an empty hold believing a scope was declared.
 *
 * Null-safe because the field that will carry a spec (RUN-135) is nullable, so
 * every caller would otherwise write the same `?.` in front of it.
 */
export const hasExecutionSpec = (spec: ExecutionSpec | null | undefined): boolean => {
  if (!spec) return false;
  return Object.entries(populated).some(([key, isSet]) =>
    (isSet as (v: unknown) => boolean)(spec[key as keyof ExecutionSpec]),
  );
};
