# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@noriq-dev/runner` — a per-user local daemon that is Noriq's **execution plane**. It dials a Noriq
server over a WebSocket, discovers marked repos on disk, and spawns/supervises coding-agent processes
(Claude / Codex) inside isolated git worktrees, streaming status back to the dashboard.

This is a standalone repo, deliberately separate from the Noriq server (different runtime, trust, and
distribution boundary). It depends only on the runtime-neutral (pure zod) wire-contract slice of
`@noriq-dev/shared`, **vendored** under [vendor/noriq-shared/](vendor/noriq-shared/) until the contract
freezes. Do not hand-edit vendored files — refresh with `npm run vendor:shared`.

## Commands

```bash
npm run check          # typecheck + lint + test — run this before calling work done
npm run typecheck      # tsc --noEmit
npm run lint           # biome check .   (lint:fix to write)
npm run test           # vitest run      (test:watch for watch mode)
npm run build          # esbuild bundle → dist/cli.js
npm run dev -- <cmd>   # run src/cli.ts via tsx, no build

npx vitest run test/supervisor.test.ts            # one test file
npx vitest run -t 'merges budget per-dimension'   # one test by name
```

Vitest has no config file — defaults, `test/*.test.ts` mirroring `src/*.ts`.

## Architecture

`src/cli.ts` is the binary entry point; `src/index.ts` is the library surface (re-exports everything, so
new public symbols belong there). `src/daemon.ts` is the composition root and the best file to read
first — it wires every subsystem together and its comments explain the non-obvious couplings.

The dispatch path:

1. **`discovery.ts`** walks `scanRoots` for `.noriq/project.toml` markers → `DiscoveredRepo`s with a
   deterministic `repo_<sha>` id derived from the absolute root path.
2. **`client.ts`** (REST) registers the runner; **`ws-client.ts`** holds the long-lived socket to
   `/ws/runner/:id` — only the daemon dials out, the server never dials in. It reconnects with backoff
   and re-resolves the token on each connect.
3. **`ws-client.ts`** `onAssigned` → **`supervisor.ts`** `supervise(run)`, the real orchestrator:
   resolve repo → create worktree → assemble kind-specific prompt → run driver under budget →
   verify/land → clean up.
4. **`vcs/`** is the source-control seam (RUN-49): `VcsBackend` names the nine outcomes the daemon
   needs (lease/dispose, hasWork/checkpoint, integrate/publish/share, …) and the supervisor speaks
   only those. **`worktree.ts`** is git's implementation behind it (`GitBackend` delegates): each
   Run gets its own worktree on a throwaway `noriq/run/<id>` branch. Git is the registry:
   `reapOrphans` on daemon start cleans up post-crash, keeping (and warning about) any worktree
   with unsaved work.
5. **`drivers/`** — `AgentDriver` (`drivers/types.ts`) is one interface over `claude.ts` (Claude Agent
   SDK streaming `query()`, not one-shot `claude -p`, so the session stays steerable) and `codex.ts`.
   `drivers/budget.ts` wraps a session to enforce token/USD/wall-clock ceilings (breach → SIGTERM);
   `run-budget.ts` sits above it (RUN-133) so those sessions divide ONE run ceiling — every spawn
   reserves the remainder from `RunTally` rather than receiving a fresh copy of the budget, and a
   stage with nothing left declines to spawn instead of starting a process to kill.
   **This interface is the ONLY place a vendor's specifics live** (RUN-109…111): each driver declares
   its `capabilities` (in-process hooks, steer, resume, per-model telemetry) and `catalog`, so the
   supervisor reads a capability rather than comparing a driver's name; env sanitization is hoisted
   *above* the seam (`DriverStartOptions.env`, computed once in the supervisor's `startAgent`), so the
   trust boundary holds no matter who spawns. We deliberately keep executing **inside our own trust
   boundary** — no third-party runtime adapter — but the seam is clean enough to add one later.
6. **`verify.ts`** (deterministic, zero-token manifest command) then **`verify-agent.ts`** (independent
   adversarial agent) gate a build; **`land.ts`** rebases + re-verifies + fast-forwards when `[land]`
   is configured.
7. **`steering.ts`** keeps live sessions steerable/cancellable; **`state.ts`**, **`credentials.ts`**,
   **`token.ts`**, **`oauth.ts`**, **`auth*.ts`** handle the OAuth 2.1 + PKCE / device-flow token
   lifecycle in `~/.noriq/`.

A dispatched task may carry an **execution spec** (RUN-134…139) — anticipated files, required
reading, decisions already settled, what is explicitly deferred, and goal-backward acceptance
criteria. It is defined in the vendored contract (`execution-spec.ts`), stored server-side per task,
and consumed by `src/execution-spec.ts`, which CHECKS it against the run's own workspace before a
token is spent — a `modify` whose file is gone, a `create` whose file is already there, a path that
is a directory — and renders it into the brief as `{{spec}}`. The author gets the whole spec; the
verify family gets the acceptance criteria alone (a gate not told what done means is
under-informed, not independent). Findings reach the agent and, when they are contradictions rather
than gaps, the run transcript. They are never fatal: a spec is orientation, not part of the
security floor, so a stale path must not become a tripwire — and the rendered block says out loud
that a spec cannot change an agent's mode, permissions, or what it may publish, because every field
in it is free text from the server.

A task that arrives WITHOUT one gets the **`plan` stage** (RUN-140): a fresh read-only agent
(`src/stages/plan.ts`, `prompts/planner.md`) reads the repo, emits a spec, and the daemon writes it
back to the task — so the plan is an artifact a human can correct and a retry can reuse, rather than
a thought inside one build's context. Three things narrow it beyond the usual clamp, each closing
something the clamp does not: `auto` is dropped (it survives `clampPermissionToWorkflow` by design,
and on Claude it means unrestricted Bash in a worktree that is writable for the build); it gets **no
`noriqMcp`**, because a filesystem clamp says nothing about `update_task`; and it may take only a
quarter of the run's remaining ceiling — ONE envelope shared by the planner and every plan-check
round, not a fresh quarter each — after which the builder RE-RESERVES against a tally that now
includes every one of them. Planning can never cost
a run: every failure path leaves it exactly as unplanned as it arrived, which is still a first-class
state.

A repo with `[verify.agent]` also gets the **plan checker** (RUN-141, `src/stages/plan-check.ts`):
a fresh read-only actor judges the SPEC — missing requirement coverage, impossible ordering,
oversized scope, vague acceptance criteria, conflicting file ownership — and a FAIL goes back to
the planner's still-open session, bounded by the same `maxRounds` that bounds the builder's fix
turns, carrying the same adjudication ledger (`src/adjudication.ts`) so a settled point stays
settled. Same gate for both because a repo that wants an independent judgement on its WORK is the
one that wants it on its PLAN. It cannot gate the run either: a plan that never clears goes to the
builder **with the findings attached**, because refusing to work over a disagreement between two
advisors about work neither has done is worse than building a plan somebody criticised. The checker
sees the plan as EVIDENCE, never with the builder's "follow it" framing — it is the one actor whose
job is to disagree with the spec.

A spec's `anticipatedFiles` is also what **predictive locking** reserves (RUN-142). That layer has
been bound since RUN-130 but only ever had a continuation's `changedPaths` to work from — what a
previous sitting touched, which by definition does not exist the first time a task is attempted —
so it had never held a lock on a first dispatch. `continuationLockScope` now UNIONS the declared
scope with the touched one: a continued run must not land on what its own previous sitting changed,
and a spec written before that sitting cannot know about it. A spec the PLANNER synthesized arrives
after the lock has been taken, so it reserves nothing on that sitting — but it is persisted, so the
next dispatch of that task locks what it declared.

Every static prompt an agent is handed lives in [prompts/](prompts/) as a markdown template
(tiny mustache subset; `src/prompts.ts` renders, `prompts/README.md` documents the syntax and
maps templates to call sites). Edit the words there — code only decides which template fires and
with which facts. The build inlines them via esbuild `define` (`__RUNNER_PROMPTS__`, same rail as
`__RUNNER_VERSION__`), so `dist/cli.js` stays self-contained; tsx/vitest read the files directly.

### Workflows (formerly "run kinds")

`scope` (read-only, produces a plan), `build` (writes, then gated by verify/land), `verify` (executes
but never edits) are the three **built-in workflows** (`src/workflow.ts` `BUILTIN_WORKFLOWS`). Since
RUN-116/117 they are *data*, not a `switch`: a `Workflow` descriptor carries `promptShape`,
`worktreeWritable`, `produces`, `verifyActor`, `usesPlanBase`, and `supervisor.ts` reads those flags
— it no longer compares `run.kind`. A repo may define its own `[workflow.<name>]` (RUN-119): a named
variant of a built-in `base` that inherits the base's posture verbatim and only swaps in a prompt.

Since RUN-132 a `Workflow` also carries `stages` — its pipeline, declared rather than derived from
`RunStage.appliesTo`. The division of labour is the design and reversing it would put a manifest
inside the trust boundary: **the machine owns what a stage IS** (its place in the sequence, its
actor's posture, which workflows may run it); **the workflow owns only whether it runs one and which
model does the work**. `stagesFor` runs `(mandatory ∪ declared) ∩ appliesTo` — bounded from both
ends, so a declaration can switch an *optional* stage off, can never switch on one this posture may
not run, and can never decline one `RunStage.optional` marks mandatory (only `review` and
`integrate` are declinable). Order always comes from `RUN_STAGES` — landing before judging is
landing unreviewed — and `clampStagesToWorkflow` narrows a `role` wider than the machine's `actor`.
The TOML surface (`[workflow.<name>].stages`, and the per-stage agent coordinate) is **not wired**:
`WorkflowDef` is the vendored contract and carries `base` + `prompt` only, so a custom workflow
inherits its base's list until the phase-3 vendor refresh grows the field.

The **write floor is workflow-independent** (RUN-118): `clampPermissionToWorkflow` forces `write =
false` for any non-producing workflow at every permission site, so "verify executes but never edits"
is enforced in code, not by trusting the manifest — a custom workflow can never widen its posture.

### Agent coordinate (formerly tool + model + effort)

A dispatch/manifest names the agent as one dotted **coordinate** — `claude.opus-4_8.high` (`.` in a
model version is written `_`) — parsed by `src/agent-coordinate.ts`. It is canonical; the legacy
`{tool, model, effort}` triple is derived from it for one deprecation window (`runCoordinate` /
`resolveAgentTool` normalize either form, so a legacy dispatch resolves byte-identically).

### Two-file config

- `~/.noriq/runner.toml` — machine-local, never committed (`config.ts`; see `runner.toml.example`).
- `.noriq/project.toml` — committed per-repo marker: project KEY, verify cmd, tool, `[land]`,
  per-kind permission profiles (`discovery.ts` + `manifest-store.ts`; see `project.toml.example`).
  `ManifestStore` re-reads it per Run, so editing it takes effect on the next dispatch with no restart.

## Invariants (do not regress these)

These are the design, not incidental behavior — [THREAT-MODEL.md](THREAT-MODEL.md) is the authority
and should be updated alongside any change here.

- **No agent ever gets push credentials, and the daemon never merges into the protected branch.**
  `security.ts` `sanitizedAgentEnv` strips `NORIQ_TOKEN` and cloud/git tokens from the child env and
  disables the git credential helper/prompt — so the *agent* half is enforced by absence and is
  absolute.
  The *daemon* half is not, and has not been since RUN-27: with `[land].autoPush` a repo opts the
  daemon into pushing — but only the working branch `[land].branch` names, and RUN-28 then opens a
  **merge request** rather than merging. The human boundary moved from `git push` to *approving the
  merge*, deliberately: freeing humans from per-run clicks is the point of the product, and a
  boundary nobody can move is just a boundary nobody uses.
  ~~The daemon never pushes~~ was the v1 wording and is simply false now. Do not restore it.
- **Bare `Bash` and `danger-full-access` are never granted *uninvited*.** By default the mapping only
  emits `dontAsk` (Claude) / `read-only` | `workspace-write` (Codex). Since RUN-68 a repo's committed
  manifest may opt a kind into the driver's auto mode (`[permissions.<kind>] auto = true` → Claude
  bypass-permissions; codex `danger-full-access` for write kinds only) — the same deliberate
  boundary-move as autoPush above. What survives auto by construction: `write` (read-only stays
  read-only), `deny`, env credential stripping, and the server-enforced Noriq tool floor (RUN-47).
  ~~never granted~~ was the pre-RUN-68 wording; do not restore it — see `mapPermission`, `mapSandbox`.
- **The agent reaches Noriq via MCP, not the shell** — the token rides the MCP transport's auth header.
- **The verify agent executes but never edits** — authorship separation is the point of the gate.
  Since RUN-118 this is code, not an honor system: `clampPermissionToWorkflow` (workflow.ts) forces
  `write = false` for any non-producing workflow at every permission site, so no manifest — built-in
  kind or custom `[workflow.<name>]` — can hand a verify/scope posture the ability to edit.
  "Every site" only became true at RUN-158: the *inline* reviewer (`runReviewer`) was handed
  `[permissions.verify]` raw, which is the spawn that gates every build. The clamp now also runs
  inside `startAgent`, the single spawn chokepoint, so a new call site inherits the floor instead of
  having to remember it — clamp at the site anyway, for legibility.
  What the floor buys, precisely: the **edit tools** are denied (Claude) and the write sandbox is
  read-only (Codex). It is not "cannot alter a file" — `auto = true` grants unrestricted Bash in a
  writable tree, by the same deliberate opt-in as `autoPush`. THREAT-MODEL.md states the boundary;
  don't restate it more strongly than that.
- **One worktree per Run**; never two runs in one checkout; never force-delete work that exists nowhere
  else.
- Merging happens only into the branch `[land].branch` names, only after the gate passed *rebased onto
  it*, and only locally.

## Conventions

- ESM, `type: module`, Node ≥20, strict TS with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`
  (so `import type` for types). Biome: single quotes, 2-space, 110 cols.
- Imports are extensionless (`./worktree`) — the bundler resolves them; the package ships as one
  `dist/cli.js` with `@anthropic-ai/claude-agent-sdk` kept external (it spawns a binary and carries its
  own subtree).
- **Dependency injection is the testing strategy**: drivers take a `queryFn`, worktrees a `GitRunner`,
  verify a `VerifyExec`, ws-client a `WsFactory`. Tests never touch the real SDK, network, or git —
  keep new subsystems injectable the same way.
- Comments here carry design rationale and reference `RUN-xx` plan tickets. Match that register: state
  the constraint or the trade, not what the line does.
