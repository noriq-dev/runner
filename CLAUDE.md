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
4. **`worktree.ts`** gives each Run its own worktree on a throwaway `noriq/run/<id>` branch. Git is the
   registry: `reapOrphans` on daemon start cleans up post-crash, keeping (and warning about) any
   worktree with unsaved work.
5. **`drivers/`** — `AgentDriver` (`drivers/types.ts`) is one interface over `claude.ts` (Claude Agent
   SDK streaming `query()`, not one-shot `claude -p`, so the session stays steerable) and `codex.ts`.
   `drivers/budget.ts` wraps a session to enforce token/USD/wall-clock ceilings (breach → SIGTERM).
6. **`verify.ts`** (deterministic, zero-token manifest command) then **`verify-agent.ts`** (independent
   adversarial agent) gate a build; **`land.ts`** rebases + re-verifies + fast-forwards when `[land]`
   is configured.
7. **`steering.ts`** keeps live sessions steerable/cancellable; **`state.ts`**, **`credentials.ts`**,
   **`token.ts`**, **`oauth.ts`**, **`auth*.ts`** handle the OAuth 2.1 + PKCE / device-flow token
   lifecycle in `~/.noriq/`.

### Run kinds

`scope` (read-only, produces a plan), `build` (writes, then gated by verify/land), `verify` (executes
but never edits). The kind drives the permission profile, worktree writability, prompt assembly, and
steer mode — most branching in `supervisor.ts` keys off it.

### Two-file config

- `~/.noriq/runner.toml` — machine-local, never committed (`config.ts`; see `runner.toml.example`).
- `.noriq/project.toml` — committed per-repo marker: project KEY, verify cmd, tool, `[land]`,
  per-kind permission profiles (`discovery.ts` + `manifest-store.ts`; see `project.toml.example`).
  `ManifestStore` re-reads it per Run, so editing it takes effect on the next dispatch with no restart.

## Invariants (do not regress these)

These are the design, not incidental behavior — [THREAT-MODEL.md](THREAT-MODEL.md) is the authority
and should be updated alongside any change here.

- **The daemon never pushes and never gives an agent push credentials.** `git push` is the human
  boundary. `security.ts` `sanitizedAgentEnv` strips `NORIQ_TOKEN` and cloud/git tokens from the child
  env and disables the git credential helper/prompt. This is enforced by *absence* and therefore
  **only works because git keeps everything before publishing local** — see [VCS-SPIKE.md](VCS-SPIKE.md)
  §5 before adding a server-backed VCS, which would move enforcement outside this codebase.
- **Bare `Bash` and `danger-full-access` are never granted.** Permission mapping only ever emits
  `dontAsk` (Claude) / `read-only` | `workspace-write` (Codex) — see `mapPermission`, `mapSandbox`.
- **The agent reaches Noriq via MCP, not the shell** — the token rides the MCP transport's auth header.
- **The verify agent executes but never edits** — authorship separation is the point of the gate.
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
