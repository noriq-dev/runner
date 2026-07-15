# Noriq Runner — Threat Model

> This is the **design**: the trust boundaries and the defenses that hold them.
> It is deliberately not `SECURITY.md` — GitHub reads that filename as a
> vulnerability-disclosure policy, and a threat model sitting there tells someone
> who found a hole what we built, not how to reach us.

The Runner runs **autonomous coding agents with a shell on the user's own
machine**. That is the whole point (it's the execution plane) and also the entire
risk. This document is the threat model for that surface and the layered defenses
that contain it. Security here is load-bearing, not polish.

## Trust boundaries

- **The user's machine is trusted; the agent is not.** The daemon is the user's
  process (their OAuth token, their repos). Each spawned agent is untrusted code
  driving untrusted model output through a shell.
- **The Noriq server is the control plane; the daemon is the muscle.** Only the
  daemon dials out (a WebSocket to `/ws/runner/:id`); the server never dials in.
- **The only secret that crosses the wire is the Noriq OAuth token.** Model
  credentials (Anthropic/OpenAI) and git credentials never leave the box.

## Threats & defenses

| Threat | Defense | Where |
|---|---|---|
| Agent edits/deletes files outside its task | **One git worktree per Run** on a throwaway branch `noriq/run/<id>`; never two runs in one checkout | `worktree.ts` |
| A scope (read-only) agent writes anything | **Per-kind permission profile**: scope gets read-only tools (Claude `dontAsk` + read-only allowlist) / `read-only` sandbox (Codex); **plus** the scope worktree is physically `chmod`'d read-only (defense in depth) | `drivers/claude.ts` `mapPermission`, `drivers/codex.ts` `mapSandbox`, `worktree.ts` `setReadOnly` |
| The verify agent "fixes" the code it is judging | **Execute, never edit.** Verify's profile is `write = false`, so Edit/Write/MultiEdit are denied and its bash rules are enumerated (install + run + `git diff`) — it can exercise the behavior but cannot alter a line of it, nor weaken a test to make its own verdict easy. Its worktree is deliberately **not** `chmod`'d read-only (unlike scope): a verifier that cannot run the suite can only review by eye, which is the weakest form of this gate. The separation that matters is authorship, and that is enforced by the profile | `drivers/claude.ts` `mapPermission`, `.noriq/project.toml` `[permissions.verify]` |
| A build agent runs arbitrary shell | Build gets edit tools + a **bash allowlist** only (the manifest's `allow` rules, e.g. `Bash(npm test:*)`) — **bare `Bash` is never granted**; Codex confines writes to `workspace-write` | `drivers/claude.ts`, `drivers/codex.ts` |
| Agent pushes to the remote / merges | **No agent ever gets push credentials**, and this half is absolute: the spawned process runs under `sanitizedAgentEnv` — `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=/bin/false`, credential helper disabled via `GIT_CONFIG_*` — so even `git push` inside the allowlist has no credentials and no way to prompt for them. The **daemon** is a separate question: with `[land].autoPush` (opt-in, default off) it pushes the working branch `[land].branch` names, and never anything else | `security.ts`, `supervisor.ts` |
| The daemon merges its own work into main | **It doesn't — it asks.** A completed plan's working branch becomes a **merge request** (RUN-28, `gh pr create`); a human merges it. The daemon only ever fast-forwards `[land].branch` itself, and only with a diff that passed the gate *rebased onto it*. A dispatch may steer the target only within `[land].allowedBranches` (RUN-41), which is empty by default — so a repo saying `branch = "agents"` can never be written anywhere else. **What backs this is the daemon's own code plus the forge's branch protection, NOT the absence of a credential**: once autoPush is on, the same token that pushes a working branch could push `main`, and what stops it is that the daemon does not try | `land.ts`, `merge-request.ts`, `worktree.ts` `pushBranch` |
| Agent exfiltrates secrets from the environment | `sanitizedAgentEnv` **strips** `NORIQ_TOKEN` and common cloud/git tokens from the child's shell env. The agent reaches Noriq via its **MCP** connection (credential injected at the transport), so `bash` never sees the token | `security.ts` |
| Agent reads the stored credential off disk | `~/.noriq/credentials.json` is written `0600` under a `0700` dir, and no agent is granted bare `Bash` or unrestricted reads outside its worktree. **Not a hard boundary**: the file is readable by the uid the daemon and the agents share, so this rests on the permission profiles, not on the filesystem. **The mode bits are POSIX-only** — Node ignores `mode` on Windows apart from the read-only flag, so on Windows this file is protected by whatever ACL `%USERPROFILE%` carries (by default: that user, SYSTEM, and Administrators) and *not* by anything this daemon sets. The permission profiles are load-bearing on every platform; on Windows they are the only thing here. It holds a **90-day refresh token** — a longer-lived secret than the 7-day access token — so revoke the connection (*Settings → Agent connections*) if a box is suspect; rotation makes the stolen pair single-use but does not by itself evict a thief | `credentials.ts`, `token.ts` |
| A runaway agent burns unbounded tokens/$$ | **Daemon-enforced budget**: token / USD / wall-clock ceilings watched from the telemetry stream; breach → SIGTERM → `failed{budget}`. A Run with a budget can never run unbounded | `drivers/budget.ts` |
| A run buys a fresh budget by asking a question | A resumed park (RUN-30) inherits the **remainder**, never a new ceiling: token/USD spend carries across sittings, and only a run that exited **cleanly** may park at all — a budget breach is terminal, so it cannot resume its way past the limit it just hit. Wall-clock is the deliberate exception: it counts **active** seconds only, because charging a run for the hours a human took to answer would make every overnight answer arrive to a dead run | `parked.ts` `remainingBudget`, `supervisor.ts` `parkIfBlocked` |
| A parked run's token is read off disk | `~/.noriq/parked-runs.json` holds each parked run's **bound agent token** so the resumed process can still reach Noriq — it cannot be re-minted, because one run gets one non-reissuable credential (RUN-43). Same **uid boundary caveat** as `credentials.json` above: this rests on the permission profiles, not the filesystem. Strictly **less** exposure than what already sits beside it — this token can act as one agent in one project, while the daemon's own can register runners and reach every project its human can. Parks expire at **72h**, well inside the token's 7-day life, so a stale park cannot leave a live credential lying around indefinitely | `parked.ts`, `supervisor.ts` `resume` |
| Agent games the gate (weakens/deletes a test) | Two-stage verify: a **deterministic floor** (zero-token manifest verify cmd) then an **independent adversarial verify agent** (a fresh actor, never the author) — plus **bounded retries (K=2)** then human escalation | `verify.ts`, `verify-agent.ts`, phase gate (server) |
| Crash leaves a live worktree/branch around | **Crash-safe reap**: a fresh daemon start reaps every orphaned `noriq/run/*` worktree (git is the registry; the run id is in the branch name) | `worktree.ts` `reapOrphans` |
| Stolen/replayed WS or steer | The WS upgrade is authenticated (owner's OAuth bearer) and the runner must belong to that user; steers are deduped by stable source id | server `/ws/runner`, `runtime_deliveries` |

## What the daemon never does

- **Never pushes unless a repo asked** (`[land].autoPush`, default false — see below).
  With it off, nothing an agent writes leaves this machine and `git push` remains the
  human boundary. This was once stated as an absolute, and the honest version is
  narrower: the daemon has a path across that boundary now, and a repo opens it.
- Never merges into any branch except the one `[land].branch` names, and only after
  that Run's diff passed the gate *rebased onto it* (see below).
- Never grants an agent's shell the Noriq token or cloud/git credentials.
- Never runs an agent outside its per-Run worktree.
- Never runs a build agent with unrestricted `Bash` or a `danger-full-access`
  sandbox — the permission mapping only ever emits `dontAsk` (Claude) and
  `read-only` / `workspace-write` (Codex).
- Never force-deletes a worktree holding work that exists nowhere else.

### What the boundary actually is, and where it moved

The v1 wording — *the daemon never pushes* — was true then and is false now. RUN-27 gave a repo a
way to opt the daemon into pushing, and RUN-28 made a completed plan open a merge request. That was
not a regression: **freeing humans from per-run approval is the point of the product**, and the
boundary moved deliberately, from `git push` to *approving the merge*.

So the honest invariant is not about pushing at all. It is:

> **The daemon publishes only where the repo said it may, and never merges into the protected
> branch — it asks.**

Note what backs that, because it is not what backed the v1 claim. With autoPush on, the daemon holds
a credential that *could* push `main`. What stops it is (1) its own code — `pushBranch` only ever
pushes `[land].branch`, and `allowedBranches` is empty by default — and (2) the forge's branch
protection, which is external to this daemon and untestable by it.

**That matters for VCS portability, and it makes the story smaller than it first looks.** A
server-backed VCS does not introduce external, untestable enforcement: we already have that the
moment autoPush is on, and GitHub's branch protection is exactly as far outside this codebase as
Perforce's protections table. Perforce even has a close analogue of RUN-28's shape — its
**pre-commit review model**: shelve the pending changelist, open a Swarm review, a human submits.

**The one thing that genuinely does not port is the OFF switch.** With `[land]` unconfigured — the
default — a git runner writes nothing to any server, ever. Perforce has no such setting at any
configuration, because `p4 shelve` *is* its checkpoint primitive: isolating a run and making its
work durable are themselves depot writes. "Nothing an agent writes leaves this machine" is true of a
default git install and unreachable on Perforce at any setting. See [VCS-SPIKE.md](VCS-SPIKE.md) §5
(RUN-44).

## Auto-landing (`[land]`) — an explicit trade

Earlier this document said the daemon "never merges". It now merges — *locally*, into
one opt-in branch — because a human clicking approve on every run is the cost this
system exists to remove. The trade, stated plainly:

| | |
|---|---|
| **What changed** | A build that passes the gate is rebased onto `[land].branch`, **re-verified there**, and fast-forwarded in. No human per run. |
| **What did NOT change** | The daemon still **never pushes**. Work reaches the operator's disk and nothing else; a human still decides what reaches `main`, a remote, or a deploy. |
| **What is now load-bearing** | The verify gate is the only thing between an agent and that branch. Its quality *is* the security boundary. |
| **The sharp edge** | Point `[land].branch` at anything push-triggered, auto-deploying, or watched by CI and you have handed agents production. `branch` has **no default** and is never inferred — auto-landing is opt-in per repo, and pointing it at `main` is a choice you make explicitly. |
| **Why rebase-then-verify** | Two runs can each be green at their own fork point and broken together. A gate that never sees the combination cannot catch it, so the gate runs on the rebased result — the exact thing that will land. |
| **Conflicts** | An agent may resolve only *mechanical* collisions, in its own worktree, under the build floor. Anything requiring a decision (competing designs, a refactor under it, a changed contract) must bail to a human — an ambiguous or absent verdict counts as bail. Picking a winner silently discards someone's work. |
| **Concurrency** | rebase → verify → fast-forward is serialized per repo. A non-fast-forward is reported as a race, never papered over with a merge commit. |

Omit `[land]` entirely and none of this happens: every run's diff waits on its own
branch for a human, exactly as before.

## Pushing (`[land].autoPush`) — the boundary this model rested on

`[land]` lands work on a local branch. `autoPush` sends that branch to its remote. **Default
false**, and unlike most defaults this one is the feature.

Read the section above: *"nothing an agent writes leaves this machine"* was the invariant the
rest of this document leaned on. Auto-landing was defensible **because** `git push` stayed human
— an agent could write to a branch on the operator's disk, and a person still decided what
reached a remote, CI, or production. `git log origin/main..main` was the operator's *"what did
the agents do while I wasn't looking?"* check. `autoPush` deletes that checkpoint.

That is a legitimate thing to want — it is the prerequisite for merge requests (RUN-28) — but it
has to be chosen, never inferred.

| | |
|---|---|
| **What it does** | After a landing succeeds, pushes exactly that branch: `git push origin <branch>:<branch>`. One refspec, named explicitly. |
| **What it never does** | `--force`, `--all`, `--tags`, or a bare `git push` that a `push.default` config could steer somewhere else. A non-fast-forward means the remote has commits this machine has not seen — that is a human's problem, and rewriting someone's history so a robot's push succeeds is not a trade the daemon makes. |
| **The sharp edge** | Point `[land].branch` at something CI watches and an agent's diff reaches CI; at something that deploys, and it reaches production. `autoPush` is the difference between "agents write to a branch on my laptop" and "agents publish". |
| **Whose credentials** | The DAEMON's, i.e. the operator's existing git setup. Deliberately not the agent's: `sanitizedAgentEnv` strips tokens and sets `GIT_ASKPASS=/bin/false` + an empty credential helper for every **spawned agent**, and it is not applied to the daemon's own git. So a build agent that runs `git push` inside its allowlist still has no credentials and no way to get them — the push happens in the daemon, after the gate, on the branch the gate passed. |
| **When it does NOT push** | The landing failed or raced; the verify gate refused the build; nothing landed. Nothing unverified reaches a remote. |
| **A failed push is not a failed run** | The work is landed locally either way. Failing the run would send someone hunting for a diff that is sitting on the branch. It is reported and left for a human to push. |

Leave `autoPush` out and none of this happens: landed work waits on the operator's disk, exactly
as before.

## Merge requests (`[land].mergeTarget`) — the daemon acts as you

`autoPush` publishes bytes. This opens a pull request **as the operator**, under their name, in
their org — a bigger step, and it earns its own row rather than sliding in as an implementation
detail of the one above.

| | |
|---|---|
| **When** | Every task in a plan is done (or cancelled). Completion is a SERVER fact — the daemon only sees Runs, never the plan's task graph. |
| **Whose credentials** | The operator's `gh`, already on the box and already authed — same choice as `autoPush` reusing their git credentials. The alternative was a GitHub token in `runner.toml`: a genuinely new secret on the machine, a new thing to leak, and a second auth path to keep alive. The agent gets none of it; this runs in the daemon, after the gate. |
| **Requires** | `autoPush`. A merge request cannot exist without the branch reaching the remote. |
| **Who names the target** | The REPO, via `[land].mergeTarget`. Never inferred, never chosen by whoever dispatched — the protected branch is the repo owner's decision. Omit it and no merge request is ever opened. |
| **What it never does** | Rebase the working branch to make the PR openable. That branch is already pushed, so rebasing means rewriting published history and force-pushing — which `pushBranch` refuses. If main moved, the forge shows the conflict in the PR, where a human resolves it with full context. |
| **If it fails** | Nothing is lost: the work is landed AND pushed. The daemon records why and hands over the exact `gh pr create` command. |
| **Durability** | Completion is recorded server-side, not just pushed down a socket. A plan can finish while the box is off, the runner is offboarded, or the socket is reconnecting — a fire-and-forget notification would drop the merge request silently, forever. The daemon asks on startup and on every reconnect; the record makes it idempotent, so re-asking cannot open a second PR. |

## Updating the daemon (`[update]`) — why it only checks

`[update]` tells this box to notice when it is behind. It does **not** replace anything, and the
absence is the design, not a gap waiting to be filled.

Consider what the daemon's own executable holds:

- the operator's Noriq OAuth token (`~/.noriq/credentials.json`, 90-day refresh),
- the power to spawn agents at whatever permission floor it chooses,
- with `[land]`, write access to the repo's branches,
- with `[land].autoPush`, the ability to push.

So self-update is not a convenience feature — it is a supply-chain decision. **Whoever controls
the version feed controls every one of those, on every opted-in box, unattended.** Auto-update
turns one compromised publish into a fleet-wide compromise with nobody present at the moment of
change; a human running `npm i -g` is exposed to the same artifact, but at a moment they chose.

| | |
|---|---|
| **What it does** | A public GET to `package.json` on the runner repo's `main`, on `checkIntervalHours`. Logs when behind. Nothing is downloaded. Noriq is not in this path — it neither builds nor publishes the runner, so it has no authority over the number. |
| **What it never does** | Replace its own executable, or download anything at all. |
| **Why not** | The package has npm's registry signatures — every package does, and they prove *"npm served this"*, not *"this was built from that repo"*. There is **no provenance attestation**. Nothing would verify that an update came from this repo's CI rather than someone's laptop or a hijacked account. |
| **The other blocker** | The daemon supervises live agents. Swapping under them strands worktrees and orphans runs, and it cannot exec itself cleanly while holding a WS and child processes — it would have to drain (`status: 'draining'` already exists as the hook), exit, and rely on something to restart it. Under `nohup` it would simply stop. |
| **What would make it defensible** | Publish with `--provenance` from CI so the artifact is verifiable; drain before swapping; keep the previous version and roll back if the new one won't register; report the swap as an event a human can see afterwards. A bad auto-update takes every opted-in runner offline at once. |
| **Deliberately absent** | There is no `apply`/`enabled` key that does nothing. A stored setting nothing consults reads as working and is worse than an absent one — the same trap RUN-38 had to undo with `oauth_tokens.scope`. |

`noriq-runner update` checks and names the command; a human runs it.

## Residual risks (accepted / follow-up)

- **Bash allowlist correctness is the manifest author's responsibility.** A
  manifest that allowlists `Bash(*)` or `git push` reopens the shell. The daemon
  enforces "no bare Bash by default" and strips push credentials, but a permissive
  `.noriq/project.toml` is a user choice. Review committed manifests in code review.
- **Read-only for scope is layered, not absolute.** `chmod` + the driver permission
  profile both enforce it; a sandbox escape in the agent CLI is out of the Runner's
  control (it's the CLI vendor's boundary).
- **Network egress** is `restricted` by profile intent but ultimately governed by
  the agent CLI's own sandbox — the Runner sets the policy, the CLI enforces it.
- **The MCP-server credential wiring** (how the agent gets Noriq access without the
  token in its shell env) is finalized at the dogfood; `sanitizedAgentEnv` already
  assumes the token reaches the agent over MCP, not the environment.

Report security issues privately to the maintainers rather than opening a public issue.
