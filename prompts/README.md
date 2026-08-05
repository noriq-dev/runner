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
| `pattern-mapper.md` | `supervisor.ts` `assemblePrompt` (shape override) | analogs for the plan's anticipated files (RUN-144) |
| `verify-agent.md` | `verify-agent.ts` `assembleVerifyPrompt` | a dispatched verify run (RUN-20) |
| `reviewer.md` | `verify-reviewer.ts` `assembleReviewerPrompt` | the inline reviewer (RUN-61) |
| `reviewer-feedback.md` | `verify-reviewer.ts` `reviewerFeedbackPrompt` | the builder, after a reviewer FAIL |
| `reviewer-contest.md` | `verify-reviewer.ts` `reviewerContestPrompt` | the builder, after a TERMINAL reviewer FAIL — one contest turn, no code change (RUN-174) |
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

Bundled templates use strict rendering: a variable their call site omitted is a programming error
and throws. Workflow templates are operator/repo-authored, so they use lenient rendering instead:
an unknown interpolation becomes `''`, an unknown section is falsy, and the daemon logs one warning
per unknown name for that render. The warning names both the variable and the template file.

## Workflow templates

One workflow definition may live in any of these places, in precedence order:

1. `.noriq/workflows/<name>.toml` in the project;
2. `[workflow.<name>]` in `.noriq/project.toml`;
3. `~/.noriq/workflows/<name>.toml` on this machine;
4. the bundled `scope`, `build`, or `verify` workflow.

Dedicated files use the same `base` + `prompt` shape as the inline table, and add `[stages.<name>]`
to pick, per stage, the **agent coordinate** its actor runs under (RUN-193). The filename is the
workflow name, so the file carries its keys at the top level with no `[workflow.<name>]` wrapper:

```toml
base = "scope"
prompt = { file = "docs-plan.md" }
```

A worked two-file example — one repo expressing its own pipeline: plan on a cheap-but-careful model,
build on a second vendor, judge the build on a third. Copy these into `.noriq/workflows/` and
dispatch with `workflow = "plan"` / `workflow = "build"`:

```toml
# .noriq/workflows/plan.toml
base = "scope"                          # read-only; produces a plan, not a diff

[stages.plan]
agent = "claude.fable-5.high"           # the planner drafts the spec on Fable

[stages.plan-check]
agent = "codex.gpt-5_6-sol.high"        # a second vendor audits that spec
```

```toml
# .noriq/workflows/build.toml
base = "build"                          # writes, then verify + review + land

[stages.execute]
agent = "codex.gpt-5_6-sol.medium"      # the builder writes the diff on Codex

[stages.review]
agent = "claude.opus-4_8.high"          # Opus judges it — a third model
```

A coordinate escapes a dotted model version's dots as underscores (`opus-4_8` is opus-4.8,
`gpt-5_6-sol` is gpt-5.6-sol; a dashless id like `fable-5` is written verbatim), picks a MODEL and
never a posture, and degrades to a warning — never a gate — when it is malformed or names a key that
is not `plan` / `plan-check` / `pattern-map` / `execute` / `review`. `build.toml`'s `[stages.review]`
chooses which model reviews but does not enable reviewing: the inline reviewer runs only when the
repo's `.noriq/project.toml` also carries a `[verify.agent]` section, and the deterministic
`[verify] cmd` floor is a separate, always-on gate the coordinate does not replace.

An inline string remains valid (`prompt = "Survey {{brief}}"`). A prompt file is resolved beside
the TOML that names it. Project prompts are confined to the repository; machine-local prompts are
confined to `~/.noriq/workflows`, not the wider home directory. Both the definition and prompt are
re-read for each dispatch and then pinned for that run.

The dictionaries below are exact. `null` interpolates as empty and is falsy in a section; `''` is
also falsy. Extra supplied values are harmless. A misspelled name is not an alias for anything.

Common to `scope`, `build`, and `verify` custom prompts:

- `identity`: the rendered daemon-owned identity header;
- `label`, `agentId`, `kind`, `projectKey`, `projectId`, `server`: identity and project facts;
- `runId`, `repoRef`, `workflow`, `planId`: run/repository/workflow facts (`planId` is otherwise null);
- `taskId`, `taskKey`, `taskTitle`, `taskBody`: anchor task facts, or `null` without that fact;
- `brief`, `anchor`: the dispatched brief and rendered task/plan anchor;
- `context`: author context for scope/build; bounded names-only quoted context for verify.

`scope` adds `spec`, the rendered execution spec or `''`.

`build` adds:

- `spec`: the rendered execution spec or `''`;
- `verifyCmd`: the deterministic verify command or `null`;
- `reviewer`: boolean, true only when an inline reviewer is configured.

`verify` adds:

- `spec`: always `''`; judging actors do not receive the author's working spec;
- `specs`: the dispatched brief plus anchor, which the daemon later repeats as task intent;
- `diffCmd`: the backend's diff command or `null`;
- `acceptance`: the numbered acceptance checklist or `null`;
- `acceptanceOverflow`: how many criteria did not fit, normally `0`.

A verify-based custom template does not become the outer verifier prompt. Its rendered text is
quoted as repo/operator-controlled workflow guidance inside `verify-agent.md`; acceptance handling,
independent-review rules, and the daemon's verdict instructions remain after it.

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

The verify family does not get the spec at all. It gets the **acceptance criteria, numbered**
(`{{acceptance}}`, rendered by `src/acceptance.ts`), and answers them one line each. Withholding
them entirely was the first cut and it was wrong — a gate that has not been told what the work was
commissioned to achieve is not independent, it is under-informed, and it can pass a build that
skipped a stated criterion or fail one for omitting something the spec explicitly deferred. What it
still does not get is the author's working notes (which files, what was decided, what is deferred),
for the same reason its `[context]` is trimmed.

RUN-145 made that answer **structured**, and the form is the point. Prose hides the criterion nobody
checked: the code that would satisfy it is in the diff, so the report says PASS, and nothing
established that it DOES what the criterion claims. So a gate emits
`ACCEPTANCE <n>: <VERIFIED|FAILED|BEHAVIOUR-UNVERIFIED|HUMAN-NEEDED> <evidence>`, and three rules in
`acceptance.ts` keep it honest — a criterion the report never names comes back unverified rather than
passed, a `VERIFIED` pointing at nothing is demoted to unverified, and a `FAILED` criterion cannot
stand alongside `VERDICT: PASS` (the daemon takes the FAIL). An unverified criterion is recorded and
surfaced, never fatal: most specs are half-written, and failing every build over one would make the
field a tripwire. Both members of the family carry the block — the *inline reviewer* especially,
which had never been given the criteria in any form and gates every build that configures one, while
the dispatched verify run is opt-in.

There is deliberately no prose rendering of the criteria for these actors. Shown the same criteria
as a list and again as a paragraph, a model answers the paragraph and skips the list.

When a gate FAILS, `reviewer-feedback.md` leads with `{{repair}}` — the outstanding criteria as a
**specification** rather than a critique (RUN-146, `src/repair.ts`). A report is an argument; the
builder's question is "what must be true when I stop?", and it was reconstructing that from prose
every round while the daemon already held it as data. The block draws the distinction prose cannot:
a `failed` criterion means change the code, a `behaviour-unverified` one usually means nothing
*exercises* the code and the repair is a test rather than an edit — told only "not satisfied", a
builder rewrites correct code to satisfy a gate that merely could not see it. The findings still
follow in full: they carry detail a criterion never will, and the builder answers them by number for
the ledger. A run with no acceptance criteria gets no block at all.

`reviewer.md` also lists the task's `requirementIds` when it has any and asks a finding to name the
ones it threatens, in a second bracket after the severity (RUN-147). The bracket is optional, so a
reviewer that ignores it degrades to the previous behaviour rather than to an unparsed line — the
only acceptable failure mode for a format a model writes. The prompt gives the reason as well as the
shape: each round is a fresh reviewer that never saw the last one's wording, so a settled finding
comes back reworded and the ledger's prose key misses it. It also says not to stretch a finding to
fit a requirement, because a wrong association is worse than none.

A collapsed finding may enumerate its separately-answerable claims as lettered sub-claim lines —
`FINDING <n><letter>: <claim>`, lettered `a, b, c…` in order, under a FINDING line whose claim
ends with the completeness certificate `[sub-claims: <count>]` — and the RESPONSE side answers per
letter (RUN-180). The certificate is what makes the enumeration all-or-nothing against shapes no
net can see: the letters are kept only when exactly `<count>` well-formed lines parse, so a line
that mangles into anything — even plain English — subtracts from the count and voids the whole,
and a FINDING line without the certificate keeps no letters at all.
`reviewer-feedback.md` and `reviewer-contest.md` both carry the answer shape,
because a response is credited only for the sub-claims it names: an unaddressed sub-claim stands
rather than riding its siblings' answer, which is how a bundled finding once left a valid half
"answered" by the rebuttal of the other. A sub-claim's identity is its claim WORDING, not its
letter — letters are positional labels of the report in front of the responder, re-derived at
every render — which is why `reviewer.md` tells a re-raise to restate a standing sub-claim's
wording exactly, and why `reviewer-contest.md` takes `{{record}}`: the reconciled sub-claims of
the terminal findings with the letters that answer them, since a standing claim the terminal
report does not re-list has no letter the builder could otherwise know. Both sides are optional
and positionally additive, like the requirement bracket — a report or response written without
letters parses byte-identically, and malformed lettering degrades to the single-claim finding. The
prompt draws the line the parser cannot: instances of one root cause stay evidence inside one
claim, so the letters never become the instance-enumeration the collapse rule (RUN-89/90) bought
out.

A CONTESTED pointer may also name a TASK — `task:<key>`, "real, out of scope, tracked THERE"
(RUN-188). Deliberately not a parse change: the pointer was always free text, so the vocabulary is
taught in `reviewer-feedback.md` and `reviewer-contest.md` and read out by the daemon
(`taskRefsIn`), which looks each named task up itself — the judging reviewer holds no Noriq
credential (RUN-43) — and folds the result into the ledger as `→ daemon:` data lines beside the
answer. The judgment split follows the credential line: existence and provenance are the daemon's
mechanical facts; substance and the **evasion test** (a criterion the diff was commissioned to
meet cannot be spun off; newly-found adjacent work can) are the reviewer's, and that rule lives
solely in `reviewer.md` — the builder-facing templates carry only the pointer form, the RUN-89
one-place discipline again. A task the daemon could not verify never credits a contest
(may-miss-never-invent): it renders NOT verified, and at the terminal contest the finding stands
without a fresh adjudicator being spawned.

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
