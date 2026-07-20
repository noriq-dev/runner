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
   `drivers/budget.ts` wraps a session to enforce token/USD/wall-clock ceilings (breach → SIGTERM).
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
