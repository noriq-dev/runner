# @noriq-dev/runner

The **Noriq Runner** — a per-user local daemon that turns Noriq's coordination
plane into an execution plane. It connects to a Noriq server, discovers your
repos, spawns and supervises coding-agent processes (Claude / Codex) inside
isolated git worktrees, and streams status back so you can dispatch, watch,
steer, and approve work entirely from the dashboard.

This is a **standalone repo** (separate runtime/trust/distribution boundary from
the Noriq server). It imports only the runtime-neutral slice of `@noriq-dev/shared`
(pure zod, the wire contract), currently **vendored** under `vendor/noriq-shared`
until that contract freezes — see `vendor/noriq-shared/README.md`.

## Install & set up

```bash
npm install -g @noriq-dev/runner
noriq-runner init
```

**`init` is the whole setup.** It asks four questions (a label for this machine, your Noriq
server, where your repos live, how many runs may share the box), then authorizes you and shows
you what it found:

```
  Noriq Runner setup
  ──────────────────

  Label for this machine [my-laptop]:
  Noriq server URL [https://noriq.example]:

  Checking https://noriq.example …
  ✓ reachable, and it speaks OAuth

  Where are your repos? (comma-separated) [/home/you/code]:
  Max concurrent runs [2]:

  ✓ wrote /home/you/.noriq/runner.toml

  Authorizing this runner…
  You will be asked which projects it may reach — it will not see the others.

  ✓ authorized — credentials in /home/you/.noriq/credentials.json

  Found 2 repos:
    planar → PLNR   (/home/you/code/planar)
    runner → RUN    (/home/you/code/runner)

  Drivers detected: claude, codex

  Ready. Start it with:  noriq-runner start
```

Three things it does deliberately, because each one is a cliff someone already fell off:

- **It checks the server before writing anything.** One round-trip turns "auth mysteriously
  failed" into "that URL isn't a Noriq server", and nothing lands on disk if it isn't.
- **It makes you choose which projects the token may reach.** Not an option you can skip — the
  runner should not be able to see your whole account because setup was in a hurry.
- **It lists the repos and drivers it found.** This is where you learn your scan roots are wrong
  — now, rather than after a dispatch and a dashboard that shows nothing.

It never clobbers an existing config without asking, so re-running it is safe.

```bash
noriq-runner start        # then this, and leave it running
```

`init` needs a terminal (it's interactive by construction). On a headless box — SSH, container,
CI — configure by hand instead: copy [`runner.toml.example`](runner.toml.example) to
`~/.noriq/runner.toml` and run `noriq-runner auth`, whose device flow works without a browser.

**Drivers are a separate install.** The Claude driver needs the `claude` CLI on PATH
(`npm i -g @anthropic-ai/claude-code`); the Codex driver needs `codex`. `init` tells you which it
can see. From a checkout, skip the build with `npm run dev -- <command>` (runs `src/cli.ts` via
tsx); `npm run build` bundles to `dist/cli.js`.

**Platforms:** Linux, macOS, and **native Windows** — no WSL required. Windows is a CI matrix
leg, not a best-effort claim. Node ≥20 and `git` on PATH everywhere.

One Windows-specific thing to know, because this file is committed and your teammates may not
share your OS: your repo's `[verify] cmd` runs under **cmd.exe** there, and under `sh`
elsewhere. `&&` works in both, so the usual `npm run typecheck && npm test` is fine — but env
prefixes (`FOO=1 npm test`), `2>&1`, `$VAR`, and shell globbing are not. Pin
`[verify] shell = "bash"` if you need them; see [project.toml.example](project.toml.example).

## Authenticate

**`init` already did this** — read on only if you need to re-authorize, point at a second
server, or you configured by hand.

The daemon dials the Noriq server with **your OAuth token** — the only secret that
crosses the wire (model + git credentials never leave the box). One command gets one:

```bash
noriq-runner auth        # opens your browser, approve, done
```

That's the whole flow on a desktop: it runs OAuth 2.1 authorization-code + PKCE against
a loopback listener, so the token is minted straight into `~/.noriq/credentials.json`
(0600) and nothing is ever copy-pasted.

**On a box with no browser** — a runner over SSH, in a container, on CI — `auth`
detects that and falls back to the **device flow** (RFC 8628): it prints a short code,
you approve it at that URL from your laptop or phone, and the daemon picks the token up
by polling. Force either path with `--browser` / `--device`.

```
  Open:  https://noriq.example/oauth/device?user_code=BCDF-GHJK
  Code:  BCDF-GHJK

Waiting for approval…
```

Access tokens last 7 days and the daemon refreshes itself with the stored refresh token
(90 days, rotated on each use), so `start` keeps working without re-authing. When the
refresh token finally lapses — or you revoke the connection from *Settings → Agent
connections* — the daemon says so and `noriq-runner auth` reconnects it.

`NORIQ_TOKEN=…` still overrides everything (CI, short-lived containers); the legacy
`~/.noriq/token` file is still read too. Neither can refresh — they're static by nature.

The token is a local secret: never commit it, and it is stripped from every spawned
agent's shell env — the agent reaches Noriq over its own MCP connection, not through the
environment.

## Configure

Two files, and they are split by **who they belong to**:

- `~/.noriq/runner.toml` — **machine-local**: label, server, scan roots, concurrency, budget.
  Never committed; it's about your box, not the project. **`init` writes this for you** — reach
  for [`runner.toml.example`](runner.toml.example) only to hand-edit or to set up headless.
- `.noriq/project.toml` — **committed** per-repo marker: the project KEY, verify command, tool,
  `[land]`, and per-kind permission profiles. Travels with the repo, so your teammates' runners
  agree with yours about what's allowed. **`init-project` writes this one** — run it from the
  repo root:

```bash
cd ~/code/acme
noriq-runner init-project     # a few questions, then commit the result
git add .noriq/project.toml && git commit -m "Add Noriq marker"
```

It suggests a verify command from what the repo is built with, and — because bare `Bash` is
never granted to an agent — gives the build profile the allowlist it needs to actually *run*
that command. It also tells you whether the repo sits under one of your scan roots, which is
the one thing you can't easily check yourself: a perfect marker outside them is never
discovered, never dispatchable, and reports no error anywhere.

Auto-landing stays off unless you name a branch, and it never guesses one.
[`project.toml.example`](project.toml.example) is the annotated reference for everything
`init-project` doesn't ask about.

A repo opts in *only* by committing that marker — there's no central list to add yourself to, and
a runner ignores everything else under your scan roots. `ManifestStore` re-reads it per Run, so
editing it takes effect on the next dispatch with no restart.

Validate the machine config and see what the daemon discovered:

```bash
noriq-runner config      # load + validate ~/.noriq/runner.toml
noriq-runner discover    # list the repos found under your scan roots
```

The KEY in `.noriq/project.toml` is resolved to a `prj_…` id per configured server
at registration, so a checkout stays portable across instances and forks.

## Commands

| Command            | What it does                                             |
| ------------------ | -------------------------------------------------------- |
| `noriq-runner init`    | **Start here.** Guided setup: config + authorization, then shows what it found |
| `noriq-runner init-project` | Guided `.noriq/project.toml` for the repo you're in (then commit it) |
| `noriq-runner start`   | Connect to Noriq and supervise dispatched runs            |
| `noriq-runner auth`    | Authorize this machine and store its token (`--browser` / `--device`) |
| `noriq-runner discover`| List repos discovered under the config's scan roots       |
| `noriq-runner config`  | Load, validate, and print the resolved machine config     |
| `noriq-runner update`  | Check whether this runner is behind (it will not replace itself) |
| `noriq-runner version` | Print the version                                         |
| `noriq-runner help`    | Print help                                                |

Global options: `--config <path>` (default `~/.noriq/runner.toml`) and `--log-level
debug|info|warn|error`. `auth` takes the server from the config; pass `--server <url>` to
authorize before that file exists, or to point at another instance.

**`update` only tells you** — it never replaces itself, and there is no auto-update setting. A
daemon that silently upgrades itself and then spawns agents with file access is a supply-chain
path into every repo on the machine, so deciding when to take a new version stays yours.

## Develop

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # biome
npm run test        # vitest
npm run check       # all three
```

## Agent drivers

A driver turns a Run into a live, steerable agent process behind one interface
(`AgentDriver`). The **Claude driver** uses the Claude Agent SDK's streaming-input
`query()` (not one-shot `claude -p`) so the session stays steerable — push user
turns mid-run + `interrupt()` — applies the per-kind permission profile, and
parses stream-json telemetry (tokens / USD) back to the Run.

The Claude Agent SDK is a **normal dependency** (RUN-26 moved the whole repo — and
the vendored `@noriq-dev/shared` wire contract — to `zod@4`, satisfying the SDK's
`zod@^4` peer, so it installs with no `ERESOLVE`). It's imported directly; the
`claude` CLI binary it drives is a separate install (`npm i -g @anthropic-ai/claude-code`).
Tests inject a fake `queryFn` and never touch the real SDK. The bundle keeps the
SDK **external** (it spawns a binary and carries its own subtree), so it's resolved
from `node_modules` at runtime rather than inlined. (The Codex driver is in RUN-13.)

## The verify stage is a choice

What gates a build after its agent exits clean is decided per repo, by what `[verify]`
contains:

```toml
[verify]
cmd = "npm run typecheck && npm test"   # the deterministic floor: zero tokens, daemon-run

[verify.agent]                # optional: an inline reviewer — a FRESH agent (never the
tool = "codex"                # builder) reviews the diff read-only against the task intent;
model = "gpt-5.6-sol"         # a FAIL report goes back to the builder to fix, bounded, then
maxRounds = 2                 # a fresh reviewer looks again
```

Either half alone works; both means floor-then-reviewer; omit `[verify]` entirely and
there's no verify stage at all — the diff still lands as a review diff, and you are the
gate. The reviewer is where a **stronger model than the builder's** earns its cost — or a
**different vendor's** entirely (`tool` runs the reviewer on the other driver, so claude's
work can be judged by codex and vice versa). It holds no Noriq credential: its whole output
is its report, so it can judge work but never move it. A failure of either gate comes back
to the *live* build session with the output in context — no re-dispatch, no fresh agent
re-deriving what the daemon already knows.

## Landing the work

The point isn't to generate diffs — it's to land them. Add `[land]` to a repo's
`.noriq/project.toml` and a build that passes the gate lands itself:

```toml
[land]
branch = "noriq/integration"   # no default; never inferred; never silently `main`
```

The daemon rebases the run onto that branch, **re-runs the verify command on the
rebased result**, fast-forwards it in, and reaps the run's worktree and branch. Work
accumulates on one integration branch that you merge onward into `main` when you like —
a batch to review instead of a click per run, and no graveyard of per-run branches.

Verify runs *after* the rebase deliberately: two runs can each be green at their own fork
point and broken together, and a gate that never sees the combination can't catch it. On
a rebase conflict the build agent gets one bounded turn to fix it — but only if the fix is
mechanical; anything needing a *decision* (competing designs, a refactor underneath it, a
changed contract) bails to a human, and an ambiguous answer counts as bailing.

**The daemon never merges into your protected branch — it asks.** By default it also never
pushes: work reaches your disk and nowhere else. Add `[land].autoPush` and it publishes the
one working branch `branch` names — nothing else — and opens a merge request there. The human
boundary is *approving the merge*, not `git push`; moving it there is the point, not an
oversight. Point `branch` at something auto-deploying and you've given that up; see the table
in [`THREAT-MODEL.md`](THREAT-MODEL.md). Omit `[land]` and nothing auto-lands: every diff
waits on its own branch, as before.

## Security model

One git worktree per Run on a throwaway branch; scope runs read-only; per-kind
permission profiles (including which Noriq MCP tools each kind may call); daemon-enforced
budgets (SIGTERM on breach); **no push credentials for any agent, ever, and the daemon
publishes only where the repo opted it in — never merging into the protected branch**;
secrets stay local (only the OAuth token crosses the wire, injected into the agent's MCP
transport rather than its shell). A repo that trusts its agents can opt a kind out of the
command allowlist into the driver's own auto mode (`[permissions.<kind>] auto = true`) —
read-only stays read-only and the Noriq tool floor holds regardless, but the bash
allowlist is the price. Full threat model — and the explicit trades auto-landing and
`auto` make — in [`THREAT-MODEL.md`](THREAT-MODEL.md).

## Try it end-to-end

[`DOGFOOD.md`](DOGFOOD.md) is the v1 acceptance runbook: register this machine,
mark a repo with `.noriq/project.toml`, then dispatch a scope brief → approve the
proposed plan → run a build → watch verify gate it → steer it live — the full loop
from the dashboard, both drivers.
