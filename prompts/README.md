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
