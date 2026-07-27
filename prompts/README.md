# Prompt templates

Every static prompt the daemon hands an agent lives here, one markdown file per voice. Edit the
words here; the code (each template's single `renderPrompt` call site) decides which template
fires and supplies the facts. Design rationale for a template's wording stays as comments on its
call site — these files are the literal text an agent reads, so they cannot carry comments.

| Template | Rendered by | Read by |
| --- | --- | --- |
| `identity.md` | `supervisor.ts` `assemblePrompt` | every scope/build agent (shared header) |
| `scope.md` | `supervisor.ts` `assemblePrompt` | a scope run (read-only planner) |
| `build.md` | `supervisor.ts` `assemblePrompt` | a build run (read-write worker) |
| `planner.md` | `supervisor.ts` `assemblePrompt` (shape override) | the `plan` stage's fresh read-only planner (RUN-140) |
| `plan-checker.md` | `supervisor.ts` `assemblePrompt` (shape override) | the plan checker — judges a SPEC, not a diff (RUN-141) |
| `plan-revision.md` | `stages/plan-check.ts` | handed back to the planner when its plan was refused |
| `verify-agent.md` | `verify-agent.ts` `assembleVerifyPrompt` | a dispatched verify run (RUN-20) |
| `reviewer.md` | `verify-reviewer.ts` `assembleReviewerPrompt` | the inline reviewer (RUN-61) |
| `reviewer-feedback.md` | `verify-reviewer.ts` `reviewerFeedbackPrompt` | the builder, after a reviewer FAIL |
| `verify-feedback.md` | `verify.ts` `verifyFeedbackPrompt` | the builder, after the verify cmd failed |
| `conflict.md` | `land.ts` `assembleConflictPrompt` | the builder, mid-rebase conflict |
| `resume.md` | `parked.ts` `resumePrompt` | a parked agent being resumed (RUN-30) |

## Syntax

A tiny mustache subset (`src/prompts.ts`), three forms, no nesting:

- `{{name}}` — interpolate. `null` renders as nothing; a key the call site didn't pass throws.
- `{{#name}}…{{/name}}` — keep the body iff the value is truthy (not `null`/`false`/`''`).
- `{{^name}}…{{/name}}` — the inverse.

Rendering is **literal text substitution** — no whitespace trimming around tags, so the file shows
exactly what the agent reads. Keep section tags inside lines: a conditional sentence carries its
own leading newline (see `build.md`). The file's trailing newline is stripped; everything else is
verbatim.

`{{context}}` is the repo's own orientation block (`[context]` in `.noriq/project.toml`, RUN-128),
resolved by `src/repo-context.ts` from the **run's workspace** — not the discovered checkout, which
may be on a different branch. It carries its own leading blank line, so inline the tag
(`…problems.{{context}}`) and place it **before** the brief: ground rules land better read ahead of
the ask than after it. It renders to nothing only when the repo declares no `[context]` **and**
carries no `CLAUDE.md` / `AGENTS.md` — those are inlined by default (RUN-129).

`scope.md` and `build.md` carry it. A custom workflow's prompt is passed the same variable but must
place the tag itself.

`{{spec}}` is the anchor TASK's execution spec (RUN-134…139), checked against the run's workspace by
`src/execution-spec.ts` and rendered there. It sits **after** the brief and anchor, for the mirror
of the reason `{{context}}` sits before them: `{{context}}` is what is true of the repo whatever the
task, so it is reference read ahead of the ask; the spec is what is true of THIS task, so it reads
as the ask's own detail. It carries its own leading blank line and renders to nothing when the task
has no spec — which is most tasks, and not a defect.

The last thing in the block is any finding the deterministic check produced (a `modify` whose file
is gone, a `create` whose file is already there). Those come last on purpose: they contradict what
the spec just said, and an agent that reads the contradiction first has nothing to attach it to.

`scope.md` and `build.md` carry it; a custom workflow's prompt is passed it and must place the tag,
and one written before this existed simply renders without it — extra variables are ignored, so
nothing throws and nothing is injected into a template the daemon does not control.

The verify family gets a **narrower** rendering of the same spec: the acceptance criteria alone,
placed with the intent. Withholding it entirely was the first cut and it was wrong — a gate that has
not been told what the work was commissioned to achieve is not independent, it is under-informed,
and it can pass a build that skipped a stated criterion or fail one for omitting something the spec
explicitly deferred. What it does not get is the author's working notes (which files, what was
decided, what is deferred), for the same reason its `[context]` is trimmed.

`verify-agent.md` and `reviewer.md` carry it too since RUN-154, in a **names-only** rendering: the
same entry points, conventions, and required-reading NAMES, with no file contents inlined. A
reviewer judging whether a diff looks like this repo's code is where conventions matter most, and it
was the one actor told nothing about them — but its context already carries the diff, and a 16k
block of inlined documents on top crowds out the subject. The conventions are prose in the manifest,
so they arrive verbatim either way; what a reviewer loses is file contents it can simply read, being
read-only by definition and now told which files hold the rules. These two place the tag **after**
the verdict instructions and before the intent, which is the same "reference first, the ask last"
rule stated above.

## Stay agnostic

These prompts run under any driver (Claude, Codex, …), any model, and any VCS backend, so keep them
neutral to all three:

- **VCS** — speak in outcomes, not git verbs. `integrate`/`publish`/`checkpoint` (see
  `src/vcs/types.ts`) hold across git, Perforce, and Diversion; `rebase`, `git commit`, and
  `worktree` do not. Say "workspace", not "worktree"; "the daemon captures your changes", not "the
  daemon commits". Anything genuinely git-shaped (a `git diff` range) is passed in by the call site
  as a variable with a `{{^var}}` fallback for backends that have no such command — never hardcoded.
  The diff3 conflict markers (`<<<<<<<` / `=======` / `>>>>>>>`) are the exception: they are
  universal, so `conflict.md` keeps them literal.
- **Driver/model** — no model names, and no driver-specific features (e.g. a Claude Code `/skill`).
  Noriq MCP tool names (`request_input`, `raise_alert`, `create_plan`, …) are fine: both drivers
  reach Noriq the same way, over MCP.

## How they ship

`scripts/build.mjs` inlines every file here into the bundle via esbuild `define`
(`__RUNNER_PROMPTS__`, the `__RUNNER_VERSION__` pattern), so `dist/cli.js` stays self-contained.
Under tsx/vitest the files are read from disk — edit and rerun, no build step. Adding a template
is just adding a file; nothing to register.
