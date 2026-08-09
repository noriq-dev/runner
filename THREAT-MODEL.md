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
- ~~The only secret that crosses the wire is the Noriq OAuth token.~~ Narrower now, and still
  absolute for what it protected: **model credentials (Anthropic/OpenAI), git/forge credentials,
  and unrelated machine secrets never leave the box** — `sanitizedAgentEnv` strips the agent's env,
  and the index deny list (below) is a second, independent reason none of those specifically are
  ever read for this purpose. What changed: on a repo's own explicit, committed
  `[index].enabled = true`, this daemon reads a bounded, deny-filtered, confined slice of that
  repo's **source** — never a credential — and Project Memory's design ships it to the server.
  As of RUN-222 that upload is no longer only reachable by an operator typing `index-repo`: the
  daemon itself now reconciles every opted-in repo at startup, after a landing/publish, and on a
  bounded poll, and drives real generations through the ingest transport (`ingest-client.ts`,
  RUN-220) on its own, unattended. See "Repository intelligence upload (`[index]`)" below for
  what that means precisely, what is enforced today versus merely designed, and the residual risk.
  The v1 sentence is quoted elsewhere (README, CLAUDE.md) and worth keeping visible rather than
  silently rewritten — RUN-210.

## Threats & defenses

| Threat | Defense | Where |
|---|---|---|
| Agent edits/deletes files outside its task | **One git worktree per unit of concurrent work** on a throwaway branch `noriq/run/<id>`; never two RUNS in one checkout | `worktree.ts` |
| A scope (read-only) agent writes anything | **Per-kind permission profile**: scope gets read-only tools (Claude `dontAsk` + read-only allowlist) / `read-only` sandbox (Codex); **plus** the scope worktree is physically `chmod`'d read-only (defense in depth) | `drivers/claude.ts` `mapPermission`, `drivers/codex.ts` `mapSandbox`, `worktree.ts` `setReadOnly` |
| The verify agent "fixes" the code it is judging | **Execute, never edit.** Verify's profile is `write = false`, so Edit/Write/MultiEdit are denied (Claude) and the workspace sandbox is `read-only` (Codex), and its bash rules are enumerated (install + run + `git diff`). Its worktree is deliberately **not** `chmod`'d read-only (unlike scope): a verifier that cannot run the suite can only review by eye, which is the weakest form of this gate. The separation that matters is authorship, and that is enforced by the profile. **Since RUN-118 this floor is workflow-independent code, not a manifest's honor system**: `clampPermissionToWorkflow` forces `write = false` for any non-producing workflow (scope, verify, and any future custom read-only workflow) — so a manifest that sets `[permissions.verify].write = true`, by mistake or malice, still yields a read-only run. Since RUN-158 the clamp is applied inside `startAgent`, the single spawn chokepoint, *as well as* at each call site, because "we audited every caller" is a property that decays with the next caller — and it had decayed: the *inline reviewer*, the gate that fires on every build (the dispatched verify run is opt-in), was handed `[permissions.verify]` raw and could edit the diff it was judging. **Where this stops, precisely:** it denies the structured edit tools and the Codex write sandbox. It does **not** make a Claude verifier unable to touch a file — `auto = true` (RUN-68) gives `bypassPermissions` with Bash deliberately unrestricted, and an `allow` rule such as `Bash(npm test:*)` runs a repo-controlled script in a writable tree. Those are the same knowingly-moved boundaries as `autoPush`, and the honest statement is "a verify posture cannot be granted *edit tools*", not "cannot alter a line". A repo that wants the stronger property leaves `auto` off and keeps its verify allowlist to commands it has read | `workflow.ts` `clampPermissionToWorkflow`, `supervisor.ts` `startAgent` + `runReviewer`, `drivers/claude.ts` `mapPermission`, `drivers/codex.ts` `mapSandbox`, `.noriq/project.toml` `[permissions.verify]` |
| A build agent runs arbitrary shell | Build gets edit tools + a **bash allowlist** only (the manifest's `allow` rules, e.g. `Bash(npm test:*)`) — **bare `Bash` is never granted by default**; Codex confines writes to `workspace-write`. A repo's committed manifest may opt a kind out of the allowlist entirely with `[permissions.<kind>] auto = true` (RUN-68): Claude bypass-permissions / codex `danger-full-access` (write kinds only). `write`, `deny`, credential stripping, and the server-side Noriq floor survive auto — the allowlist and (for a write kind) worktree confinement of writes do not. See "What the daemon never does" | `drivers/claude.ts` `mapPermission`, `drivers/codex.ts` `mapSandbox` |
| Agent pushes to the remote / merges | **No agent ever gets push credentials**, and this half is absolute: the spawned process runs under `sanitizedAgentEnv` — `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=/bin/false`, credential helper disabled via `GIT_CONFIG_*` — so even `git push` inside the allowlist has no credentials and no way to prompt for them. The **daemon** is a separate question: with `[land].autoPush` (opt-in, default off) it pushes the working branch `[land].branch` names, and never anything else | `security.ts`, `supervisor.ts` |
| The daemon merges its own work into main | **It doesn't — it asks.** A completed plan's working branch becomes a **merge request** (RUN-28, `gh pr create`); a human merges it. The daemon only ever fast-forwards `[land].branch` itself, and only with a diff that passed the gate *rebased onto it*. A dispatch may steer the target only within `[land].allowedBranches` (RUN-41), which is empty by default — so a repo saying `branch = "agents"` can never be written anywhere else. **What backs this is the daemon's own code plus the forge's branch protection, NOT the absence of a credential**: once autoPush is on, the same token that pushes a working branch could push `main`, and what stops it is that the daemon does not try | `land.ts`, `merge-request.ts`, `worktree.ts` `pushBranch` |
| Agent exfiltrates secrets from the environment | `sanitizedAgentEnv` **strips** `NORIQ_TOKEN` and common cloud/git tokens from the child's shell env. The agent reaches Noriq via its **MCP** connection (credential injected at the transport), so `bash` never sees the token | `security.ts` |
| An agent reaches Noriq authority beyond its kind (verify claims work, scope releases tasks) | **One per-kind Noriq tool floor, enforced three times from one list** (`noriqToolNamesFor`): the Claude `dontAsk` allowlist, Codex's `mcp_servers.noriq.enabled_tools`, and — since RUN-47 — the **server's own advertisement**: the daemon declares the floor when it mints the run agent, and the MCP server registers only those tools for that credential. The third is the one that holds even if a driver's enforcement is bypassed or a future driver forgets to translate the list; it also stops the server telling the model a capability exists that the profile then denies | `security.ts` `noriqToolNamesFor`, `supervisor.ts` (declared at `createRunAgent`), server `mcp.ts` |
| A build agent voids the lock floor it runs under | The daemon takes file locks **as the run's agent** — one identity, shared — and since RUN-47 the declared floor *is* the advertised catalogue, so any tool the daemon may call, the agent may call. The floor therefore grants `acquire_lock` and **withholds `release_lock` and `list_locks` from every kind** (RUN-177). Acquire has to be there or the daemon is refused by a floor it declared itself; release must not be, because RUN-105 holds a build's locks *through* the rebase→verify→fast-forward so a peer cannot take a file mid-merge, and an agent able to release them makes that guarantee opt-out. Nothing is lost: the server releases a task-anchored run's locks on settle, on any status change off `in_progress`, and on claim TTL — the daemon's own release was always documented as promptness, not correctness, and now no-ops. **What is still granted is broad acquisition**: an over-broad or injected agent can lock `**` and block cooperating peers for the run's life. That is unavoidable while daemon and agent share one identity; it is bounded by run-settle and TTL, not indefinite, and it denies peers rather than reaching anything of theirs. A **brief-only run** (no anchor task) has no settle hook, so its locks live until TTL | `security.ts` `NORIQ_TOOLS.build`, `lock-client.ts` `toolMissing`, server `ProjectRoom.releaseLocksForTask` |
| An agent mints work no human approved, or spins off tasks to dodge findings | `spin_off_task` (RUN-188) sits on the build and verify floors, and since RUN-47 the floor IS the advertised catalogue — so it is advertised to a prompt-injected builder by design. What makes that safe to advertise is that the **product is inert**: a spin-off arrives **proposed** — visible on the board, carrying provenance (source task, source run, the finding text) — and is not claimable and not pumpable until a human accepts it, the same RUN-23 gate a scope run's plan sits behind. RUN-69's exclusion **stands unchanged**: `create_task`/`decompose_task` (which mint claimable work) remain off every floor, and the spin-off is a new tool with a gated product, not `create_task` by another name. The residual is volume: ten spin-offs to dodge ten findings is ten inert board entries plus ten pointers the gate adjudicates — a spin-off offered against a finding clears nothing by itself, and a criterion the diff owed cannot be spun off (the reviewer's evasion test). The daemon gains no new authority: the tool, the ungated task state, and the approval surface are all server-side | `security.ts` `NORIQ_TOOLS.build`/`.verify`, server task state, `prompts/reviewer.md` (evasion test) |
| A committed `[setup]` turns the daemon into an exec primitive | **It runs at the agent's posture, not the daemon's.** The bootstrap commands a marker declares (RUN-202) execute under `sanitizedAgentEnv` in the run's own workspace — the same stripped env, the same process-group kill and output cap as `verify.cmd`, which is the boundary a committed file already crossed. Cloning a marked repo and running its runner executes its `[setup]`, exactly as it executes its verify command: no wider, and the same thing to check before trusting a repo. Fail-OPEN by design — a failed bootstrap is reported to the agent and the run proceeds, so this can never gate work either | `setup.ts`, `stages/prepare.ts` |
| Agent reads the stored credential off disk | `~/.noriq/credentials.json` is written `0600` under a `0700` dir, and no agent is granted bare `Bash` or unrestricted reads outside its worktree. **Not a hard boundary**: the file is readable by the uid the daemon and the agents share, so this rests on the permission profiles, not on the filesystem. **The mode bits are POSIX-only** — Node ignores `mode` on Windows apart from the read-only flag, so on Windows this file is protected by whatever ACL `%USERPROFILE%` carries (by default: that user, SYSTEM, and Administrators) and *not* by anything this daemon sets. The permission profiles are load-bearing on every platform; on Windows they are the only thing here. It holds a **90-day refresh token** — a longer-lived secret than the 7-day access token — so revoke the connection (*Settings → Agent connections*) if a box is suspect; rotation makes the stolen pair single-use but does not by itself evict a thief | `credentials.ts`, `token.ts` |
| Committed context or workflow config turns the daemon into an arbitrary-file-read primitive | `[context]` (RUN-128/129) and workflow `prompt = { file = "..." }` (RUN-192) inline file **contents** into a prompt, while `.noriq/project.toml` and `.noriq/workflows/*.toml` travel with the repo — so every path in them is untrusted input read on the operator's box. **Confinement binds the OPEN, not a name** (RUN-151): the shared reader opens first, then requires the re-resolved path to sit inside the re-resolved root *and* to be the same inode (`dev`/`ino`) as the descriptor it holds — then reads from that descriptor and never consults the path again. Project workflow reads are rooted at the repo; machine-local workflow reads at `~/.noriq/workflows`, never the wider home. A symlink out, a symlinked parent directory, or a swap racing the check is refused. Reads are bounded and the open is `O_NONBLOCK`, so hostile config can neither OOM nor hang prompt assembly. **Where it stops**: an attacker who can already write to the checkout as the operator can hardlink or bind-mount an outside file to a genuinely in-repo path — the inodes match because it is the same file, and no fd check distinguishes that from ordinary repo content. That attacker is inside the boundary already. What is defended is committed config on a box the daemon trusts. | `repo-context.ts` `openConfined`, `defaultDocReader`; `workflow-store.ts` |
| A committed `[index]` turns the daemon into a source-exfiltration primitive | **Opt-in only, and off by construction until a repo says otherwise.** `[index].enabled` must be explicitly `true` — no inference, no default-on; an `[index]` table present with the key merely unset is still OFF. Every discovered path passes a **non-overridable deny list** as the LAST filter stage, strictly after `include`/`exclude`, so no glob can re-admit a denied path; every byte is read through the same confined-open gate `[context]` already uses (RUN-151), never a second, weaker check; file count, per-file bytes, aggregate bytes, and wall-clock are all bounded, and every refusal is a visible, bounded status record. **As of Phase 3 the read half is complete and the write half has no caller**: the scanner, the entity/edge extraction, the deterministic batching, and an ingest client all exist, and `index-repo` runs the whole chain locally — but nothing in `daemon.ts` or `supervisor.ts` invokes any of it, on a schedule or otherwise, and `index-repo` cannot upload by construction (neither `client.ts` nor `ingest-client.ts` is reachable from its import graph, asserted by test). RUN-221/222/223 are what would close that gap. See "Repository intelligence upload" below for the full trade and what remains designed rather than built | `src/index-policy.ts` `resolveIndexConfig`, `src/index-deny.ts` `isDeniedIndexPath`, `src/index-scan.ts` `scanRepoForIndex`, `src/index-redact.ts` `shouldWithholdValue`, `repo-context.ts` `openConfined` |
| A repo's committed manifest or workflow prompt talks its own gate into a PASS | Since RUN-154 the repo's `[context]` reaches the **verify actor and inline reviewer**, and RUN-192 lets a verify-based custom workflow add prompt text. Both are deliberate and both stay **quoted evidence, not instructions**: they say they cannot change review rules, scope, acceptance handling, or verdict; an attempt to do so is itself a finding; and daemon-owned verdict instructions remain after them. A custom verify template is rendered first and inserted into `verify-agent.md` rather than replacing that frame. Context remains bounded and names-only. A prompt frame is not isolation and is not claimed as one: the real floors are unchanged (`clampPermissionToWorkflow` keeps the actor read-only, the reviewer holds no Noriq credential, and a gate's verdict still only gates — it never merges). | `repo-context.ts` `renderRepoContext` (reviewer audience), `supervisor.ts` `assemblePrompt`, `prompts/verify-agent.md`, `prompts/reviewer.md` |
| A runaway agent burns unbounded tokens/$$ | **Daemon-enforced budget**: token / USD / wall-clock ceilings watched from the telemetry stream; breach → SIGTERM → `failed{budget}`. A Run with a budget can never run unbounded | `drivers/budget.ts` |
| A run buys a fresh budget by asking a question | A resumed park (RUN-30) inherits the **remainder**, never a new ceiling: token/USD spend carries across sittings, and only a run that exited **cleanly** may park at all — a budget breach is terminal, so it cannot resume its way past the limit it just hit. Wall-clock is the deliberate exception: it counts **active** seconds only, because charging a run for the hours a human took to answer would make every overnight answer arrive to a dead run | `parked.ts` `remainingBudget`, `supervisor.ts` `parkIfBlocked` |
| A parked run's token is read off disk | `~/.noriq/parked-runs.json` holds each parked run's **bound agent token** so the resumed process can still reach Noriq — it cannot be re-minted, because one run gets one non-reissuable credential (RUN-43). Same **uid boundary caveat** as `credentials.json` above: this rests on the permission profiles, not the filesystem. Strictly **less** exposure than what already sits beside it — this token can act as one agent in one project, while the daemon's own can register runners and reach every project its human can. Parks expire at **72h**, well inside the token's 7-day life, so a stale park cannot leave a live credential lying around indefinitely | `parked.ts`, `supervisor.ts` `resume` |
| The **planner** edits the tree it was only meant to read (RUN-140) | The `plan` stage spawns a fresh actor inside a BUILD's worktree, which is physically writable — so the usual read-only clamp is not enough on its own. Three narrowings, each closing something the clamp does not. (1) `clampPermissionToWorkflow` at the verify posture forces `write = false`, denying the edit tools. (2) **`auto` is dropped**, which the clamp deliberately preserves (RUN-68): on Claude `auto` means `bypassPermissions` with Bash unrestricted, so a repo running `[permissions.build] auto = true` would otherwise have handed a "read-only" planner a shell in a writable tree. The clamp's behaviour is a boundary a repo opts into **for its own agents**; the planner is an actor the repo opted nothing into, and it has no use for a shell. (3) It is given **no `noriqMcp` at all** — a filesystem clamp says nothing about the control plane, and the run agent's connection would have let it call `update_task`, `claim_task`, `post_comment`. It reports nothing; the DAEMON writes its spec back, under the daemon's own token and behind a re-read that refuses to overwrite a human's edit. It is also budget-capped (a quarter of the run's remainder) and registered with steering, so it is cancellable like any other session | `supervisor.ts` `plannerPermission` + `planIfUnplanned`, `stages/plan.ts`, `prompts/planner.md` |
| Agent games the gate (weakens/deletes a test) | Two-stage verify: a **deterministic floor** (zero-token manifest verify cmd) then an **independent adversarial verify agent** (a fresh actor, never the author) — plus **bounded retries (K=2)** then human escalation. Since RUN-61 the inline stage is a per-repo CHOICE (`[verify]`: cmd, `[verify.agent]` reviewer, both, or none) — the **inline reviewer** is a fresh session under the read-only verify profile whose Noriq reach is narrowed to the **escalation pair alone** — `raise_alert` and `request_input`, which notify and pause but move no work (RUN-190; it held no credential at all before that, and the run's one non-reissuable identity is still all there is, RUN-43): its output is parsed for a verdict and the daemon posts the findings, so it can judge work, ask about it, but never move it. Choosing NO verify stage narrows nothing structural: the diff still lands as a review diff a human merges | `verify.ts`, `verify-agent.ts`, `verify-reviewer.ts`, phase gate (server) |
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
- Never lets an agent mint **claimable** work. `create_task`/`decompose_task` stay off every
  floor (RUN-69), and `spin_off_task` (RUN-188) is not the exception it looks like: its product
  arrives **proposed** — not claimable, not pumpable — until a human accepts it, the same RUN-23
  gate a scope run's plan sits behind. This boundary did not move; the tool exists so work an
  agent finds but may not do has somewhere durable to go besides scope creep, prose, or a FAIL.
- Never runs an agent outside its per-Run worktree.
- Never runs an agent with unrestricted `Bash` or a `danger-full-access` sandbox
  **unless the repo's committed manifest opted that kind in** (`[permissions.<kind>]
  auto = true`, RUN-68). Without auto the mapping only ever emits `dontAsk` (Claude)
  and `read-only` / `workspace-write` (Codex) — that is still every repo's default.
  With auto, Claude runs bypass-permissions and codex build runs unsandboxed; what
  survives auto by construction: `write` (read-only kinds keep edit denials / the
  read-only sandbox), `deny` rules, the env-level credential stripping, and the
  server-enforced Noriq tool floor (RUN-47). Same shape as autoPush: a boundary
  that used to be absolute is now a committed, per-repo choice — because "never,
  for everyone" was pricing one trust level for all repos.
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

**The one thing that genuinely does not port is the OFF switch — and we accept that rather than
fight it** (RUN-48). With `[land]` unconfigured — the default — a git runner writes nothing to any
server, ever. Perforce has no such setting at any configuration, because `p4 shelve` *is* its
checkpoint primitive: isolating a run and making its work durable are themselves depot writes.
"Nothing an agent writes leaves this machine" is true of a default git install and unreachable on
Perforce at any setting.

That is not a defect to mitigate. Perforce and Diversion **work live** — that is what they are for,
and a daemon has no standing to pretend otherwise. So the honest statement to an operator of one is:
**a live-VCS runner has no dry-run.** You are trusting the boundary from the first run, because the
first run already wrote to the depot. Everything else in this document still holds there; only the
try-it-safely position is gone, and it is gone for reasons that predate us. If explicit isolation is
ever wanted on those backends it comes from **containers**, at a layer below the VCS — not from
pretending a server-backed system is local. See [VCS-SPIKE.md](VCS-SPIKE.md) §5 (RUN-44).

### The Diversion backend, specifically (RUN-51 — measured, not assumed)

Every claim here was measured against a real server (VCS-SPIKE.md §9) and is what the shipped
backend actually does:

| | git | Diversion |
|---|---|---|
| **What leaves the machine, when** | nothing, until the repo opts into `autoPush` | **every write, within seconds, continuously** — before any commit, any gate, any verify. The verify gate gates what *lands*; nothing can gate what *leaks*. A scope run that somehow writes has already leaked. |
| **"Verify ran on exactly the tree that lands"** | commit-level (`--ff-only` is atomic) | **tree-level, with a window**: Diversion never fast-forwards and its own merge silently absorbs races, so the backend carries the compare-and-swap itself — re-merge target→branch ("already current" = proof of no movement), then land. A commit to the target **between those two calls** lands unverified. Small, real, and unlike git, not zero. |
| **Conflicts** | files an agent may mechanically resolve in its own worktree | **server-side objects with no API resolve surface** — every conflict is a human conflict; the run fails with the app URL where a person resolves it. |
| **Authorship** | the daemon commits as "Noriq Runner" | the CLI signs everything **as the operator's account** — runner-vs-human is a message convention. (The API's `commit-on-behalf` could fix this, but requires repo Admin; not used.) |
| **Crash recovery** | reaper keeps local litter and warns | **nothing to lose** — uncommitted edits included, the work is already on the server. Leftover run branches are durable, team-visible history; the daemon reports them and deletes nothing. |
| **Isolation** | one worktree per unit of concurrent work, minted freely | **pool-of-1 lease on the repo's workspace, in-process**: runs take turns. Two daemons on one workspace are not defended against — one daemon per machine is the operating assumption (one `dv` sync agent per machine enforces the same). |
| **Load-bearing infrastructure** | the `git` binary | the **`dv` sync agent** (a background process the daemon does not own) plus the operator's stored OAuth token, which is one credential for *everything* — workspace, commit, merge, review, delete. There is nothing to withhold. |

### The Perforce backend, specifically (RUN-52 — mappings measured in RUN-55)

The inverse of Diversion on the mechanics, the same on the model:

| | |
|---|---|
| **The CAS is the server's own** | `p4 submit` refuses a moved line atomically ("Out of date files must be resolved or reverted", per file) — no backend-carried guard, no window. Equal to git's `--ff-only`, better than Diversion. |
| **What leaves the machine, when** | `checkpoint` **shelves — a depot write, before any gate** (RUN-48's accepted trade). Between dispose-shelve and a later submit the work is server-visible to anyone who can unshelve. There is no dry-run. |
| **`[land].branch` selects nothing** | there are no branches: landing is `p4 submit` to the line the client workspace VIEWS, chosen when the operator configured the client. Point the client's view at something production-adjacent and you have handed agents production — the same sharp edge as `[land].branch`, moved into the client spec. `createTarget` refuses loudly; streams vs branch specs stays open until a real depot decides it. |
| **Conflicts** | fully agent-resolvable, headless (measured): `merge3` markers are written into the files, the agent edits, `resolve -ay` accepts, submit retries. Same shape as git. |
| **Read-only scope runs** | the floor is the driver permission profile, same as everywhere. The first writable lease migrates the client to `allwrite`, once (agents write files; they do not `p4 edit`) — and measured live, that flip is NOT retroactive, so it comes with a one-time `sync -f`. After it, `noallwrite`'s free OS enforcement is gone for good; per-lease flipping would force-resync a deliberately large repo on every scope/build alternation. |
| **Authorship** | the daemon's own `P4USER` — changes read `noriq@<client>`, distinguishable from the human's. Better than Diversion. |
| **Crash recovery / kept work** | §5's shelve-then-clean, literally: dispose and the reaper shelve any opened noriq changelist (recoverable from another machine, byte-for-byte — measured) before reverting. `disposePreservesWork` — the supervisor always disposes here, because on a pool-of-1 backend "skip dispose to keep the work" holds the lease forever. |
| **Isolation** | pool-of-1 lease on the repo's client workspace, in process, one daemon per machine — same as Diversion, same RUN-48 reasoning. |

## Auto-landing (`[land]`) — an explicit trade

Earlier this document said the daemon "never merges". It now merges — *locally*, into
one opt-in branch — because a human clicking approve on every run is the cost this
system exists to remove. The trade, stated plainly:

| | |
|---|---|
| **What changed** | A build that passes the gate is rebased onto `[land].branch`, **re-verified there**, and fast-forwarded in. No human per run. |
| **What did NOT change** | The daemon **never merges into the protected branch** — a human still decides what reaches `main`. Without `[land].autoPush` (RUN-27) it also never pushes at all; with it, it publishes only the branch `[land].branch` names and opens a merge request (RUN-28; on a server-backed VCS it opens nothing and records where review happens instead — RUN-85). The boundary moved from `git push` to *approving the merge*, deliberately. |
| **What is now load-bearing** | The verify gate is the only thing between an agent and that branch. Its quality *is* the security boundary. |
| **The sharp edge** | Point `[land].branch` at anything push-triggered, auto-deploying, or watched by CI and you have handed agents production. `branch` has **no default** and is never inferred — auto-landing is opt-in per repo, and pointing it at `main` is a choice you make explicitly. |
| **Why rebase-then-verify** | Two runs can each be green at their own fork point and broken together. A gate that never sees the combination cannot catch it, so the gate runs on the rebased result — the exact thing that will land. |
| **Why "per unit of concurrent work", not "per Run"** | RUN-149 lets one run's independent STEPS overlap, each in its own workspace. The rule carrying the isolation is *never two runs in one checkout*, and that is untouched: concurrent steps are one run's sessions, under one identity, one credential, one budget and one lock scope, so nothing crosses a trust boundary that was not already crossed. What earns them separate workspaces is not the plan's word — `anticipatedFiles` is briefed as "a starting point, not a fence", so two steps in a wave can reach for the same file despite declaring otherwise. A sequential chain still shares one workspace, because steps that cannot race need no isolating. |
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
| **Whose credentials** | The operator's `gh`, already on the box and already authed — same choice as `autoPush` reusing their git credentials. The alternative was a GitHub token in `runner.toml`: a genuinely new secret on the machine, a new thing to leak, and a second auth path to keep alive. The agent gets none of it; this runs in the daemon, after the gate. Since RUN-85 `gh` is GIT'S implementation of the backend-neutral `openReview` seam (`VcsBackend`, routed by detection like everything else) — the boundary is unchanged: daemon, operator's `gh`, after the gate. |
| **Requires** | `autoPush`. A merge request cannot exist without the branch reaching the remote. |
| **Who names the target** | The REPO, via `[land].mergeTarget`. Never inferred, never chosen by whoever dispatched — the protected branch is the repo owner's decision. Omit it and no merge request is ever opened. |
| **What it never does** | Rebase the working branch to make the PR openable. That branch is already pushed, so rebasing means rewriting published history and force-pushing — which `pushBranch` refuses. If main moved, the forge shows the conflict in the PR, where a human resolves it with full context. |
| **If it fails** | Nothing is lost: the work is landed AND pushed. The daemon records why and, on git, hands over the exact `gh pr create` command. |
| **Server-backed VCS (Diversion/Perforce)** | The daemon opens nothing: `gh` is not the review surface there, and no Diversion pending-merge or Perforce/Swarm review API has been measured, so none is called (RUN-85). A hand-written `[land].mergeTarget` on such a repo gets an explicit warning and a recorded failure naming the backend and where review actually happens (the Diversion app; Perforce's own tooling) — never the silent nothing it used to get. No new credential appears: refusing to act needs none. |
| **Durability** | Completion is recorded server-side, not just pushed down a socket. A plan can finish while the box is off, the runner is offboarded, or the socket is reconnecting — a fire-and-forget notification would drop the merge request silently, forever. The daemon asks on startup and on every reconnect; the record makes it idempotent, so re-asking cannot open a second PR. |

## Repository intelligence upload (`[index]`) — an explicit trade, mostly not yet built

Every other section in this document is about an *agent's* reach. This one is different in kind:
indexing is **daemon work**. No agent runs, no model credential is spent, no token is charged —
`[index]` never touches a driver, a worktree write, or a run's budget at all. Say that explicitly
because it is the reason none of the agent-facing boundaries above change: the write floor, the
push-credential absence, the verify-agent separation, the Noriq tool floor — every one of those is
about what a spawned agent may do, and this feature never spawns one.

What it is: on a committed `[index].enabled = true`, this daemon reads repository **source** —
file paths, file content, and content hashes, under `[index].include`/`.exclude` — off disk. It is
never model output, never a credential, never a diff an agent produced. Project Memory's design ships that source to the Noriq server as
staged index generations and batches (the vendored contract's own §7/§8) so later retrieval can
cite it; RUN-207…209 land the runner-side identity, config, and the confined, deny-filtered read
path. **They do not land a caller for it or a transport.**

| | |
|---|---|
| **What crosses, and what categorically does not** | Source structure and file content/hashes from an opted-in repo. Model credentials (Anthropic/OpenAI), git/forge credentials, and unrelated machine secrets never leave the box regardless — `sanitizedAgentEnv` and the deny list below are two independent reasons, not one relying on the other |
| **The opt-in** | `[index].enabled`, checked first, refusing to proceed on anything else: absent, `false`, or an unparseable `[index]` table all mean OFF, logged and named, never silently narrowed | `src/index-policy.ts` `resolveIndexConfig` (`if (!manifestIndex?.enabled) return null`) |
| **Scope** | `include`/`exclude` globs, confined to the repo root at config load — an absolute path or a `..`-escaping glob refuses INDEXING for the whole repo (named in the log) rather than silently dropping just that glob | `src/index-policy.ts` `refuseIndexGlob` |
| **The non-overridable deny list** | Runs strictly AFTER include/exclude and takes no override input at all, matched against every path segment (`foo/.ssh/id_rsa` denies exactly like `.ssh/id_rsa`), case-insensitively. Covers `.env*`, SSH/TLS/PKCS key material, VCS-internal directories, cloud-credential directories (`.aws`, `.azure`, `.gcloud`, `.kube`, `.ssh`), shell/package-manager credential files (`.netrc`, `.npmrc`, `.pypirc`), and this daemon's own state (`credentials*.json`, `.docker/config.json`, `.noriq/parked-runs.json`). A FLOOR: extended when a new category turns up, never narrowed by a repo's own config | `src/index-deny.ts` `isDeniedIndexPath` |
| **Confinement** | Every read goes through the identical open-then-verify-identity gate `[context]` already uses (RUN-151) — open first, then require the re-resolved path inside the re-resolved root and the SAME inode as the held descriptor. No second, weaker confinement mechanism exists for indexed reads | `repo-context.ts` `openConfined` |
| **Bounds** | Per-file bytes, aggregate bytes, file count, and wall-clock all cap one scan; hitting any of them stops the whole walk rather than degrading silently. Committed execution knobs, trusted at the same level `[verify].cmd` already is — nothing clamps an operator's own absurd value from above beyond ordinary positive-number validation | `src/index-policy.ts` `IndexPolicy`, `src/index-scan.ts` (`state.filesOpened >= config.maxFiles`, `deadlinePassed`) |
| **Visibility (status records)** | A repo that turns this on can see exactly what was read, what was refused, and why: `IndexStatusReason` is a closed, named list (`denied`, `excluded`, `too-large`, `binary`, `budget-exhausted`, …) — nothing is silently dropped. The record list is itself bounded (1000) with a visible overflow COUNT rather than growing without limit — the same "bounded, and honestly so" shape as the byte bounds above, one level up | `src/index-scan.ts` `IndexStatusRecord`, `MAX_STATUS_RECORDS`, `pushStatus` |
| **Content mode** | `[index].contentMode`: `'full'` (default) retains the decoded text on every candidate; `'metadata'` withholds it — the candidate's `content` is `null`, typed that way rather than left as a bare nullable field a reader would have to know the config to interpret. Both modes open the same file through the same confined read, run the same binary sniff, and hash the same bytes: the hash and size are facts about bytes, not source text, so citation verification still has what it needs even when the text itself was withheld | `src/index-scan.ts` `evaluateCandidate`, `IndexFileCandidateFull`/`IndexFileCandidateMetadata` |
| **The value floor (RUN-218)** | A second, independent floor under the deny list, answering a different question: the deny list decides whether a PATH may be read, this decides whether a VALUE may become searchable entity text. Two independent triggers, either one withholding — a sensitive-looking KEY name (`token`, `password`, `bearer`, …) and the value's own SHAPE (PEM header, JWT, known issuer prefixes, a bounded high-entropy heuristic) — because neither subsumes the other: `[auth] a = "ghp_…"` has an innocuous key, and `password = "hunter2"` has a shape no entropy test will ever flag. Withholding is ALL-OR-NOTHING (a masked prefix is what identifies a credential's issuer, so a partial reveal is a leak with a fig leaf), and this is the ONE place in the indexer where the direction of caution inverts: everywhere else a miss costs coverage, here a miss leaks, so unsure means withhold | `src/index-redact.ts` `shouldWithholdValue`, `scanTextForSecretShapedContent` |
| **What invokes it, when, and what bounds it (RUN-222)** | The daemon now indexes unattended. `daemon.ts` builds one `IndexCoordinator` (RUN-214) wired to the real work step (`index-work.ts`): a leased snapshot's `source` → `runIndexer` → `uploadGeneration`, closing over the SAME backend's `releaseIndexSnapshot` so a pool-of-1 backend's lease is gone before the first network call whenever the generation fits the local staging bound. A separate trigger layer (`index-triggers.ts`, `IndexTriggerHub`) decides WHEN to ask for one: once per `[index].enabled` repo at daemon startup, again after every successful landing/publish (`stages/integrate.ts`'s `onLanded` hook, fire-and-forget — a thrown or rejected index trigger never reaches the run whose landing fired it), and on one shared, bounded poll ticker — a single timer for the whole fleet, each repo checked against its own `[index].pollIntervalMinutes`. Every trigger first asks the seam's own cheap `VcsBackend.currentBase` (never a lease, never a scan) for the repo's current base; an unchanged base costs exactly that one check, and an UNKNOWN answer (a backend that genuinely cannot tell — no commits yet, a network error) fires no trigger at all rather than guessing one. A Diversion repo with no committed `defaultBranch` is NOT such a case: that backend resolves its own default branch itself (the same `GET /repos` call `leaseIndexSnapshot` already makes, never the local `dv` CLI — this backend's shared pool-of-1 workspace is re-checked-out per lease, so a CLI read of "what is this workspace showing" would answer with whichever run last held it, not the repo's default), so it still indexes without one. A burst of triggers (three landings ten seconds apart) debounces into one job against the LATEST base; the coordinator's own coalescing (RUN-214) still collapses any concurrent trigger for one job key into one active job plus at most one pending re-run. `sweepOrphanedStaging` (RUN-221) runs exactly once, at startup, never on a timer — a periodic sweep could delete a live job's staged bytes mid-upload | `src/daemon.ts`, `src/index-triggers.ts`, `src/index-work.ts`, `src/vcs/types.ts` `VcsBackend.currentBase` |
| **Operator status and controls (RUN-223)** | Seeing or forcing any of the above from outside the daemon's own log lines. The status vocabulary is nine states — `no-opt-in`, `unchanged`, `queued`, `parsing`, `uploading`, `server-validating`, `active`, `failed`, `association-conflict` — each one a fold of machinery that already exists (`reconcileOperatorState`'s exhaustive switch over `IndexReconcileOutcome`, never a parallel taxonomy) and NEVER synthesized: `parsing`/`uploading`/`server-validating` come from the work step's own progress callback, and the CLI labels a stale read by its own `stateSince` timestamp rather than presenting it in the present tense. A `failed` from `incompatible-version` also carries `requiresUpgrade: true` and an unmistakable `UPGRADE REQUIRED —` detail prefix — every OTHER `failed` invites a retry, this one means retrying is pointless until the daemon itself is upgraded, and a status that invited a pointless retry loop would be a mild form of "a status that lies". The daemon↔CLI channel is a loopback HTTP server bound to 127.0.0.1 (`index-control.ts`, the same shape `auth-loopback.ts` already uses), discovered through a small `~/.noriq/index-control.json` file (`{pid, port, startedAt, token}`, mode 0600) — **and it IS authenticated, by a random 32-byte bearer token minted per `start()` and required on every request via a custom header (`x-noriq-index-control`), rejected with a bare 401 on any mismatch.** Loopback alone was tried first and correctly rejected: this server lives as long as the daemon (unlike `auth-loopback.ts`'s seconds-long, PKCE-`state`-checked callback listener) and, unauthenticated, would accept any request from any local process for its whole lifetime — including a spawned BUILD AGENT, which this repo's own `[permissions.build]` grants `Bash(node:*)`, more than enough to enumerate loopback ports and act on this daemon's behalf. That is exactly the process class "the user's machine is trusted; the agent is not" (this document's own first bullet) excludes from a daemon control plane. A custom header also closes the narrower browser vector (a page the user visits issuing a cross-origin "simple" POST to a guessed port): a browser will not attach a custom header to a simple request, so there is no CORS preflight to bypass. The token is not a second AUTHORIZATION boundary — every route is still a thin ask onto `IndexCoordinator`/`IndexTriggerHub`, which enforce `[index].enabled` themselves, unchanged — it is authentication that the caller is the user, the same thing mode 0600 already implies for every other file under `~/.noriq`; a control reaching no daemon (or the wrong one, via a stale token) says so plainly rather than failing obscurely. `/status`'s payload carries no withheld content and no credential-shaped detail — traced, not assumed: every free-text field originates from this daemon's own computed base/version facts, server-described cursor prose, or `ingest-client.ts`'s `IngestError.message`, which is token-redacted at every one of its construction sites that could embed the capability URL. `index-status`/`-reindex`/`-retry`/`-cancel` never upload or mint a capability (asserted by import graph, `index-control.ts` never reaches `client.ts`/`ingest-client.ts`, the same proof `index-repo`'s own import-graph test uses); `-reindex`/`-retry` are the identical call under two names (`requestManualReindex`), idempotent through the SAME machinery RUN-221/222 already built (`deriveGenerationId`'s determinism, `uploadGeneration`'s resume-from-server-status), never a second upload path. `index-forget-journal` is LOCAL ONLY and its own output says so: it clears this machine's journal entry and staged bytes for the resolved (server, repositoryKey) and NOTHING else — its signature carries no client/fetch dependency at all, so it structurally cannot reach the server, and it cannot undo what "deletion does not unsend" already names below | `src/index-status.ts`, `src/index-control.ts`, `src/index-stage.ts` `forgetMatchingGenerations`, `src/cli.ts` |
| **PARTLY IMPLEMENTED — capability revocation is the one designed-but-missing piece left** | Short-lived, single-purpose ingest capability tokens scoped to one generation's upload — never the operator's own OAuth token, never long-lived — exist as client code AND are now actually spent by the daemon's own unattended uploads (RUN-220/221/222): `mintIngestCapability` requests one and `openIngestUpload` spends it, with the token carried in the URL path rather than a header (the server's choice) and a closed refusal vocabulary (`expired`, `wrong-scope`, `disabled`, …) so a rejection is named rather than guessed. Staging batches locally under the configured bound, with a resumable per-batch progress record and the snapshot lease released before the first network call when a generation fits (RUN-221, driven for real by RUN-222's work step) also now runs, not merely exists as a design. Still only DESIGNED, with no `Where` because the code does not exist: staging uploaded batches in object storage SERVER-SIDE before one atomic activation transaction selects a generation as active, only once its counts/hashes/deletions validate (`IndexGenerationManifest` stays queryable as "pending" until then) — this runner has no visibility into that half regardless; and **capability revocation, so a compromised or stale ingest token can be cut off independent of the operator's own credential — this does not exist in any form, and a minted capability's 15-minute TTL is currently the only thing that ends it** | `src/ingest-client.ts` `openIngestUpload`, `src/client.ts` `mintIngestCapability`, `src/index-work.ts`, `src/index-stage.ts`, `src/index-journal.ts` |
| **Prompt injection** | Indexed content is source TEXT, never instructions to an agent, and nothing in RUN-207…209 renders scanned content into any prompt — that is a context-pack concern (episodes/retrieval, PLNR-264/267/270), itself unbuilt in this tree. The intended treatment, once retrieval does render indexed content back into a brief, is the same quoted-evidence framing `renderRepoContext`'s reviewer audience already applies to `[context]`: evidence about the codebase, explicitly marked as unable to change review rules or a verdict, never instructions the reading agent should follow | `repo-context.ts` `renderRepoContext` (the existing pattern the future renderer is expected to reuse) |
| **Residual risk — a secret pasted into an ordinary file** | The deny list covers known secret-bearing PATHS (`.env`, `id_rsa`, …), never file CONTENT. RUN-218's value floor narrows this to a secret-shaped VALUE an adapter extracted from JSON/TOML/markdown, so `token = "ghp_…"` in a committed `config.toml` is withheld — but until RUN-258, a `full`-mode file entity carried the file's RAW decoded text with no redaction pass at all, so the same token hardcoded into `src/config.ts` shipped in the payload exactly as before (measured, not assumed — RUN-219). RUN-258 closes that specific gap for **unambiguous credential markers only** — PEM headers, JWTs, known issuer prefixes (`ghp_`, `sk-`, `AKIA`, …) — checked over the whole file, all-or-nothing: `indexer.ts` withholds that file's `content` (`null`, never masked) and skips symbol extraction for it, so a token hardcoded into `src/foo.ts` is withheld exactly as one already was inside `config.toml`. Deliberately NOT composed from RUN-218's full value heuristic: an entropy scan and key-name vocabulary tuned for a short isolated value over-redact a whole source file — measured directly against this repo (`src/acceptance.ts` trips the entropy test on a regex literal) — and even the marker check needed a token-boundary fix past naive substring matching, since `sk-` as a bare substring matches inside ordinary English (`src/adjudication.ts`'s own repeated `task-`). **The residual risk NARROWS, it does not close**: an UNMARKED secret — a plain password, a bare hex key, anything with no recognizable issuer shape — carries no marker for this check to find, and remains in the payload precisely because the entropy/key-name heuristics that might catch it are the ones just ruled out for whole-file use. `index-repo`'s own display floor is separate and applies only to what it prints, never to what a payload would contain. **Phase 4 wires the upload: this narrower residual risk is what it inherits, not a closed one** | `src/index-redact.ts` `scanTextForCredentialMarkers`, `src/indexer.ts` |
| **Residual risk — business sensitivity, not only security** | Source structure and excerpts are proprietary even when they hold no credential at all. The opt-in is a data-classification decision as much as a security one, which is why `[index]`'s default is OFF — the same posture as `autoPush`, for a different reason |
| **Residual risk — the hardlink/bind-mount case** | An attacker who can already write to the checkout as the operator can hardlink or bind-mount an outside file onto a path that is genuinely inside the repo; the inodes then match because it really is the same file, and no fd check can tell that from ordinary repo content. `openConfined`'s own comment names this limit and it applies here unchanged: that attacker is already inside the boundary this defends | `repo-context.ts` `openConfined` (doc comment, "What this does NOT cover") |
| **Residual risk — deletion does not unsend** | RUN-222 made this live, not hypothetical: once content has actually shipped, deleting the local `.noriq` state or unsetting `[index].enabled` does not retract what already reached the server. This daemon has no delete-on-the-server story to point at here — turning indexing off stops the NEXT trigger from ever firing again, it does not reach back for what a prior one already sent |

**What this pass measured but does not (yet) cover — reported by the RUN-209 implementer, not hidden:**

- **Directory-symlink pruning rests on one signal.** The walk never recurses into a symlinked
  directory because `Dirent.isDirectory()` reports the entry's OWN type, never a symlink target's —
  correct Node behaviour today, but there is no second, independent check confirming it. If that
  ever changed, "never even discovered" would degrade to "discovered but refused" — `openConfined`
  still holds either way, so no leak, only a difference in which layer catches it.
- **No implicit exclude list.** Unlike `discovery.ts`'s own repo-marker walk, the indexer has no
  built-in `node_modules`/`dist`/`.git`-shaped exclusions beyond the hard deny list — a repo that
  enables indexing without writing `[index].exclude` itself walks everything, bounded only by the
  size/count/time caps and not by any sensible default. This is a real sharp edge for a first
  opt-in and is called out in the README. **Measured, and smaller than it first looked (RUN-219,
  corrected):** `index-repo --path .` against a live working directory reaches 6943 files and 103487
  entities, almost all of it `node_modules` — but that is the operator DEBUG path, not the daemon's.
  The daemon leases an index snapshot, and all three backends are tracked-only by construction: git
  mints a DETACHED WORKTREE (tracked files at that commit — 243 files and 8110 entities on this
  repo), Perforce reads the depot, Diversion its API. None of them can see an untracked or ignored
  file at all. So what remains is narrower and is NOT addressed by any ignore rule, because these
  files are not ignored — they are committed: a vendored dependency, a checked-in `dist/`, a
  lockfile, a generated client. That is a policy-defaults decision (a wrong default silently drops
  files a repo wanted indexed) rather than a bug to patch quietly — RUN-256.
- **Binary sniffing reads a bounded 8000-byte prefix.** A file that only turns binary after that
  point (rare, but possible for a text format with a late-appended binary trailer) is classified as
  text and its full content is read as a candidate.

Leave `[index]` out entirely (the default) and none of this applies: no path outside the ordinary
run pipeline is ever opened for this purpose.

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
- **Network egress is NOT controlled. An agent has whatever network this daemon has.**
  There is no knob, and that is the honest state rather than an oversight: a
  `permissions.*.network` key (`none | restricted | full`) sat in the manifest schema for a
  year, defaulted to `restricted`, and was read by nothing (RUN-88 removed it). This entry
  used to say egress was "`restricted` by profile intent but ultimately governed by the agent
  CLI's own sandbox — the Runner sets the policy, the CLI enforces it." No policy was ever set
  and no CLI ever enforced one; the sentence described a mechanism that did not exist, which is
  worse than the gap it was describing. The Claude Agent SDK exposes no egress control at all
  (denying WebFetch/WebSearch gates *tools*, not the network — an allowlisted `curl` still
  egresses); codex's sandbox implies coarse egress but cannot express the three levels.
  Real control needs the container boundary — see RUN-53, which is where the permission model
  relocates anyway; the key returns there, enforced, or not at all. Until then: if a run must
  not reach the network, isolate the box. Do not re-add a declared-only key (see the
  `apply`-key note above — this is the same mistake, and we made it twice).
- **The MCP-server credential wiring** (how the agent gets Noriq access without the
  token in its shell env) is finalized at the dogfood; `sanitizedAgentEnv` already
  assumes the token reaches the agent over MCP, not the environment.
- **Repository intelligence (`[index]`) is a second, narrower category of thing that leaves the
  box, opt-in per repo.** Its own residual risks — a secret pasted into an ordinary source file,
  business sensitivity distinct from security, the hardlink/bind-mount case, and deletion not
  unsending an upload — are catalogued in "Repository intelligence upload (`[index]`)" above,
  rather than repeated here.

Report security issues privately to the maintainers rather than opening a public issue.
