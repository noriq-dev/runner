# Multi-source-control: design spike (RUN-44)

**Status: a written spike, not a plan of record. No code. It exists to decide one thing before
anyone writes any: whether a pluggable VCS layer is a real abstraction or a git interface with
indirection — and what it costs.**

Top-level answer, up front:

> **The operation set generalises. The isolation model is the split.**
>
> Every git operation this daemon performs can be restated as an outcome that Perforce and
> Diversion can satisfy — including the one that matters most, *land on a working branch and ask
> a human to merge*, which maps onto Perforce's pre-commit review model closely.
>
> What does not port is **free isolation**. Git isolates in *space*: a worktree costs approximately
> nothing, so every Run gets its own. Perforce and Diversion cannot pay that — their repos are
> large by design (that is what they are *for*), and the workspace is server-side state, so
> minting one per Run is not on the table. They isolate in **time**: the working space is the
> working space, and runs take turns in it.
>
> The invariant survives *verbatim* — "one workspace per Run; never two runs in one checkout".
> What changes is the **pool**: git mints on demand and destroys; Perforce and Diversion lease
> from a fixed pool (default: one) and clean. Concurrency stops being a free lunch and becomes an
> operator's disk budget. That is the whole difference, and it is an honest one.
>
> **Two corrections, both from review, both narrowing this document.** (1) The first draft argued
> a server-backed VCS moves enforcement outside the daemon, from *cannot* to *is configured not
> to*. That compared Perforce against a guarantee we traded away at RUN-27: `autoPush` gave the
> daemon a push credential and RUN-28 moved the human boundary from `git push` to *approving the
> merge*, on purpose, because freeing humans from per-run approval is the point of the product.
> Once autoPush is on, git's boundary is already the daemon's own code plus the forge's branch
> protection — exactly as external and untestable as Perforce's protections table. (2) The
> surviving "no OFF switch" finding was then **accepted rather than solved** (RUN-48): these
> systems work live, that is what they are for, and there is nothing a daemon can do about it.
> It is a fact to document, not a risk to mitigate.

---

## 1. What is actually being abstracted

Not "git". The surface is already written down: `RunSupervisor` declares exactly what it needs
from `WorktreeManager` via a `Pick<>`, and the daemon adds one more. That list *is* the interface,
discovered rather than designed:

| # | Today (git verb) | Used by |
|---|---|---|
| 1 | `create` | supervisor — isolate a run |
| 2 | `hasChanges` | supervisor — did the agent produce anything |
| 3 | `commitWork` | supervisor — make the diff durable |
| 4 | `refExists` / `createBranch` | landing — does the target exist / make it |
| 5 | `rebaseOnto` | landing — put the work on the current target |
| 6 | `continueRebase` / `abortRebase` | landing — after the agent resolves, or gives up |
| 7 | `landFastForward` | landing — publish iff the target has not moved |
| 8 | `pushBranch` | landing (RUN-27), merge requests (RUN-28) |
| 9 | `remove` / `reapOrphans` | supervisor, daemon — dispose, and crash recovery |

Nine outcomes. That is the whole VCS surface of this daemon. It is small, and the DI seam it
travels through already exists — which is the single best argument that this abstraction is
tractable at all.

## 2. The interface, as outcomes

Deliberately not git verbs (per the task). Each is named for what the supervisor *wants*, so a
backend is free to satisfy it however it can.

```
isolate(runId, from) → Workspace          "a private place to do this run's work"
hasWork(ws) → boolean                     "did anything actually change"
checkpoint(ws, message) → boolean         "make the work durable enough to survive this process"
targetExists(t) / createTarget(t, from)   "is there somewhere to land, and make one if not"
integrate(ws, target)                     "produce a tree combining my work with the CURRENT
  → {ok} | {conflicts: path[]}             target, or tell me exactly how it conflicts"
resumeIntegrate(ws) / abandonIntegrate(ws) "the agent resolved it" / "give up cleanly"
publish(ws, target)                       "make my work the target, IFF the target has not moved
  → {ok, id} | {race} | {error}            under me"
share(target) → {ok} | {error}            "make the target visible to the rest of the team"
dispose(ws) / reapOrphans(repo)           "throw it away — unless it holds work nothing else has"
```

Two shapes are worth keeping verbatim from `worktree.ts`, because they already generalise and
were arrived at by being burned:

- **`{ok: false, reason: 'race'}`** — `publish` is compare-and-swap, not "write". Git does it with
  `merge --ff-only`; Perforce does it with `submit`'s out-of-date check; Diversion does it with a
  server-side merge. All three can *fail because someone else got there first*, and that is a
  normal outcome to handle, not an error to log.
- **`integrate` returning conflict paths, not a boolean.** RUN-27/28's `resolveConflict` hands
  those paths to the agent. A backend that can only say "it conflicted" makes the agent
  conflict-resolution path impossible, so the paths are part of the contract.

### The one operation that does not survive contact

**`share` (push) is meaningful only for git.**

For Perforce and Diversion, by the time you have published, the work is already on the server —
there is no second step, and no separate credential guarding it. `share` would be a no-op.

An interface with a no-op on two of three backends is a tell — but a milder one than the first
draft of this document claimed. It says the local/remote boundary sits in a different *place* per
backend, not that the boundary disappears. `share` is git's way of doing what shelve already did.

## 3. Perforce: the adversarial mapping

The task asked for this specifically — prove it on paper against the backend that breaks the
model, or admit we built a git interface.

| Outcome | Perforce | Survives? |
|---|---|---|
| `isolate` | a **client workspace** (client spec) + a pending changelist | ⚠️ the client spec is **server-side state** |
| `hasWork` | `p4 opened` / `p4 diff -f` | ✅ |
| `checkpoint` | `p4 shelve` | ⚠️ works, but **writes the depot** — there is no local-only checkpoint |
| `createTarget` | a stream, or a branch spec + `p4 integrate` | ⚠️ server-side, team-visible |
| `integrate` | `p4 sync` + `p4 resolve` | ✅ different mechanics, same outcome |
| `resume/abandon` | continue resolving / `p4 revert` | ✅ |
| `publish` (to the working target) | `p4 submit` **into the working stream** | ✅ submit rejects when files are out of date → `{race}` |
| *the human's merge* | `p4 submit` of the reviewed change **to mainline** | ✅ stays a human's action, as in git |
| `share` | — | ❌ no-op; the work is already on the server |
| `dispose` | `p4 client -d` + revert | ⚠️ deletes server-side state |
| `reapOrphans` | list clients by name pattern | ⚠️ **needs the server**; git needed nothing |

Verified against the P4 docs rather than assumed — `p4 shelve` "stores files from a pending
changelist **in the depot** without submitting them… the shelved version of files is stored in the
server", and "other users can **unshelve** the shelved files into their own workspaces."

**Eight of nine survive**, and `publish`'s compare-and-swap shape maps onto `submit` almost
exactly — the task's prediction that `{ok:false, reason:'race'}` generalises holds.

**RUN-28's shape survives too, which the first draft missed.** Perforce has a **pre-commit review
model** built precisely on shelving: shelve the pending changelist, put `#review` in its
description, and Swarm opens a review that a human ultimately submits. That is RUN-28's merge
request, in Perforce's vocabulary — *the daemon publishes to a working target and asks; a human
merges to mainline*. The invariant that actually matters is portable.

The one real casualty is `share`, and it is a no-op rather than a failure.

## 4. Diversion: the seam-finder

Useful precisely because it is *nearly* git, so it isolates which assumptions are about "git-like
CLIs" and which are about "distributed VCS".

**⚠️ This section was documentation-derived and RUN-54 has since tested it against a real
server — §9 is the ground truth and corrects two of the three claims below.** Kept as written so
the delta is visible.

- **No rebase.** Diversion documents 3-way merge with common-ancestor detection; rebase is not
  offered. `integrate` therefore becomes "merge the target into my branch", which still produces a
  tree containing target + my work — which is exactly what verify needs to see, and it leaves the
  target as an ancestor so `publish` can still be a fast-forward. **The outcome survives; the verb
  does not.** This is the single best vindication of naming operations as outcomes.
  *(§9: half right. The merged tree is real; the fast-forward is not — Diversion never
  fast-forwards, and worse, its merge does not lose the race.)*
- **Branches are server-side and team-visible** — Diversion's docs put branch visibility at "all
  team members" and workspaces at "only you". So `noriq/run/<id>`, today a local throwaway nobody
  ever sees, becomes **a branch the whole team watches appear and disappear, once per run.** Git
  gives us disposable branches for free; Diversion charges social cost for them.
  *(§9: confirmed — branch ids are globally-numbered server objects.)*
- **`checkpoint` reaches the cloud.** Same shape as Perforce's shelve, milder framing.
  *(§9: understated. EVERYTHING reaches the cloud, continuously, before any commit.)*

So Diversion breaks the model in the *same place* Perforce does, just more gently. That is the
strongest evidence that this is a real seam and not a Perforce quirk. *(§9: the "more gently" was
wrong in both directions at once — gentler on isolation cost, harsher on liveness.)*

## 5. The invariants, and what actually happens to them

From CLAUDE.md, honestly assessed. **This section was wrong in its first draft and is the reason
this spike went to review rather than done.**

### First, the correction — because the original argument compared Perforce to a runner we no longer ship

The first draft said: git enforces "never push" by *absence* (no credential in the environment, so
`git push` **cannot** succeed), and Perforce cannot, so the guarantee degrades to a deployment
requirement. That framing measured Perforce against **v1**.

It has not been true since RUN-27. `[land].autoPush` gives the daemon a real push credential, and
RUN-28 makes a completed plan open a merge request. Both were deliberate: **freeing humans from
per-run approval is the point of the product**, and the human boundary was moved on purpose, from
`git push` to *approving the merge*. THREAT-MODEL.md's prose said so; its summary table and
CLAUDE.md's invariant list still said "the daemon never pushes", and this document believed them.

So the comparison is not *absence-based enforcement vs. server config*. With autoPush on:

| | git + autoPush | Perforce |
|---|---|---|
| daemon holds a credential that could write the protected branch | **yes** | yes |
| what stops it | its own code (`pushBranch` only pushes `[land].branch`; `allowedBranches` empty by default) | its own code |
| backstop outside the daemon | the forge's **branch protection** | the **protections table** |
| can the daemon test that backstop | **no** | no |

**These are the same shape.** GitHub branch protection is exactly as external, as admin-owned, and
as untestable-from-here as Perforce's protections table. A server-backed VCS introduces nothing new
on this axis.

### "The daemon never publishes to a protected target — it asks." — **survives**

This is the invariant, correctly stated, and it ports. Git: land on `[land].branch` → push it →
`gh pr create` → a human merges. Perforce: submit into the working **stream** → shelve + a **Swarm
pre-commit review** → a human submits to mainline. Same shape, same boundary, same human.

### The OFF switch — **does not survive; accepted, not mitigated** (RUN-48)

With `[land]` unconfigured — **the default** — a git runner writes to no server at all. The work
lives in a local worktree on a local throwaway branch, and if the box dies, nothing anywhere else
ever knew. That position is reachable, it is the default, and it is what makes the runner safe to
try on a repo you care about.

**Perforce has no such position, at any setting.** `p4 shelve` *is* the checkpoint primitive — the
only way to make a run's work durable beyond the process — and it writes the depot, where other
users can read it. Isolation itself (a client workspace) is server-side state. There is no
configuration in which an agent's output stays on the machine.

**The decision (RUN-48) is to accept this and say so.** These systems work live; that is not a
deficiency to be engineered around, it is what they are *for*, and a daemon has no standing to
pretend otherwise. So a Perforce runner has no dry-run: you trust the boundary from the first run,
because the first run already wrote to the depot. We document that and stop there. Explicit
isolation, if it is ever wanted, comes from **containers** — a different layer, a future
endeavour, and notably *not* a VCS feature.

This is why the split belongs in the daemon rather than in a compatibility shim: git's local-first
model and Perforce's live model are answers to different questions, and flattening either into the
other produces a bad version of both.

### "One worktree per Run; never two runs in one checkout." — **survives verbatim; the pool changes**

This is the invariant the live model actually touches, and the interesting result is that its
*wording* needs no change at all.

Git isolates in **space** because it can: a worktree is cheap, so `create` mints one per Run and
`remove` destroys it. Perforce and Diversion cannot — the repos are large by design and the
workspace is server-side state, so per-Run duplication is exactly the thing not to do. They
isolate in **time**: runs take turns in the working space.

Both are the same operation under one honest name — **lease a workspace, exclusively, for this
Run**:

| | git | Perforce / Diversion |
|---|---|---|
| pool size | unbounded, minted on demand | fixed; **default 1** (the workspace that exists) |
| on acquire | create worktree + throwaway branch | wait for the lease, sync to target |
| on release | destroy | clean (revert unopened, delete the changelist) |
| concurrency per repo | as many as the operator's `maxConcurrent` | **the pool size** |

"Never two runs in one checkout" holds under both — it is what the exclusive lease *means*. What
the operator loses is the free lunch: on Perforce, a second concurrent run costs a second full
workspace, in disk, on a repo that is large on purpose. That is their call to make, not ours to
make for them, and the honest default is **1**.

Two consequences worth naming, because neither is obvious:

- **Serialization becomes load-bearing.** Today `maxConcurrent` is a throttle. On a pool-of-1
  backend it is the isolation mechanism, so the lease must be a real mutex with a real queue —
  including across daemon restarts, since the workspace outlives the process.
- **Read-only scope runs get *cheaper*, not dearer.** This one inverts. Git must `chmod` a whole
  tree (`setReadOnly`) to make a scope run read-only. Perforce's default (`noallwrite`) already
  makes unopened files read-only on disk and only `p4 edit` flips the write bit — so a scope run
  is read-only by *not doing anything*, enforced by the OS, on the backend we assumed would be
  hostile. ([P4 workspace file management](https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/P4Guide/configuration.workspace.manage-files.html))

### "Git is the registry" (`reapOrphans` needs no external state) — **does not survive**

Today crash recovery is beautiful: the run id is in the branch name, so a fresh daemon reconstructs
everything from the local repo — no database, no lockfile, nothing to get out of sync. On Perforce
the registry is the **server's client list**, so crash recovery needs connectivity and an offline
daemon cannot clean up after itself.

### "Never force-delete work that exists nowhere else" — **gets weaker, and that is fine**

This one *relaxes*. On git the worktree may hold the only copy, so the reaper refuses to touch it.
On Perforce a checkpoint is already on the server, so the work is recoverable by definition. The
invariant stays (it costs nothing) but stops being load-bearing — the mirror image of the OFF-switch
finding, and the one place where "everything is on the server" helps.

It helps more than that, and this is the payoff for accepting the live model. A pool-of-1 backend
cannot do what git's reaper does — *keep the litter and warn* — because the litter is sitting in
the one workspace the next Run needs. But it does not have to: the reaper **shelves** the orphaned
changelist and then cleans. The work becomes durable, reachable from another machine, and
attributable to its run id — strictly better than a worktree kept on a dead laptop's disk. The
primitive we spent the first draft calling the problem is the one that makes crash recovery good.

### "Verify ran on exactly the tree that lands" — **survives on all three**

The merge-queue guarantee is the crown jewel and it is portable: git rebases then fast-forwards,
Diversion merges then fast-forwards, Perforce resolves then submits with an out-of-date check. All
three are *integrate → verify → publish-iff-unmoved*; all three can lose the race and say so.

## 6. A concrete trap, courtesy of RUN-42

The task said to read RUN-42's findings before designing path handling, because "the VCS layer is
exactly where `startsWith('/')`-style assumptions get re-created". It is worse than that:

**Perforce has a second namespace.** Depot paths (`//depot/proj/file.c`) are not filesystem paths
at all — and `'//depot/…'.startsWith('/')` is **true**. RUN-42's exact bug, re-created, except now
`path.isAbsolute()` is *also* wrong, because a depot path is not a path in Node's sense.

So the interface must never type a location as `string` and hope. `Workspace` needs a local
filesystem path (where the agent works) and an opaque backend-owned location (where the VCS thinks
it is), and they are **different types**. Git happens to make them the same, which is exactly why
a git-first design would fuse them and Perforce would find out later.

## 7. Recommendation

1. **The interface is viable — build it, specified as the nine outcomes in §2.** It is a real
   abstraction, not indirection: `integrate` covering rebase *and* 3-way merge, and `publish`
   covering fast-forward *and* submit, are genuine generalisations that hold on a backend with
   neither git verb. **Do the git-only extraction first** — it proves the interface against the
   backend we understand, at zero risk, and it is the task with the best ratio here.
2. **There is no blocker. RUN-48 is decided: the live model is accepted.** Not *"what enforces the
   boundary"* — the answer is the same as git's today, once autoPush is on. And not "what replaces
   the dry-run" — nothing does, because Perforce and Diversion work live by design and a daemon
   does not get a vote. Document it; do not engineer around it. Explicit isolation, if wanted
   later, is **containers**, at a layer below the VCS.
3. **Model the split as isolation, not as VCS.** The abstraction that pays is `acquire`/`release`
   of an exclusively-leased workspace, with the **pool** as the backend's business: unbounded and
   minted-on-demand for git, fixed and default-1 for the live backends. Design that seam and the
   nine outcomes sit on top of it unchanged. Design nine VCS verbs *without* it and the first live
   backend rewrites the supervisor's concurrency model instead.
4. **Diversion second, Perforce third — or never.** Diversion is the cheap seam-finder: it breaks
   the model in the same place at a fraction of the setup cost, and it settles whether `checkpoint`
   crossing the network is survivable in practice before Perforce makes that question expensive.
5. **`share`/push stays git-only.** Do not generalise an operation that is a no-op on two of three
   backends; let the interface admit git has a publishing step the others don't need.
6. **Perforce's price, stated plainly: concurrency, not security.** A pool-of-1 default means one
   agent at a time per workspace, and a second costs a full second copy of a deliberately large
   repo. Add the server-side registry (`reapOrphans` needs connectivity), team-visible per-run
   state, and no dry-run. All four are real, all four are the price of a live system working as
   designed, and none of them is what the first draft was alarmed about.

### Suggested implementation tasks (to be split *after* this is accepted)

| | task | why in this order |
|---|---|---|
| 1 | **Extract the nine outcomes behind `WorktreeManager`'s existing DI seam, git-only.** No behaviour change, no second backend. | Proves the interface where we can't get hurt; unblocked today |
| 2 | **Split `Workspace` into local path + opaque backend location.** | The §6 trap, fixed while there is no second namespace to trip on |
| 3 | **Decide the safe default for a backend with no OFF switch.** Manifest + THREAT-MODEL. | Cheap to answer, and Perforce is unsafe to ship without it |
| 4 | **Diversion backend.** | Finds the seams a git-only interface hides |
| 5 | **Perforce backend** — gated on (3). | The one that pays, and the one that costs |

Note this ordering changed after review: the first draft gated *everything* on a
THREAT-MODEL decision. With the comparison corrected, (1) and (2) are plain refactors that are
safe and useful regardless of whether a second backend is ever built — so there is no reason to
hold them behind a decision.

## 8. What this spike did not settle

- ~~**Whether Diversion's `commit` is local or reaches the cloud.**~~ **Settled by RUN-54, and the
  question dissolved**: the working tree itself replicates continuously — an uncommitted file is
  on the server seconds after being written. See §9.
- **Perforce streams vs branch specs** as the mapping for `createTarget`. Both plausibly work; the
  choice interacts with how a site already organises its depot, which we do not get to pick.
  (Still open — RUN-55.)
- **Whether anyone wants this.** The plan sequenced RUN-44 last precisely so this could be judged
  with the full git op set known. It now is — and the answer is that the abstraction is sound but
  its first backend costs the project its clearest security claim. That is worth a deliberate yes,
  not a default one.

## 9. Addendum: Diversion, hands-on (RUN-54, 2026-07-16)

Everything in this section was measured against a real Diversion account (`dv` v1.0.624, Linux),
in a throwaway repo created for the purpose and deleted after. Where it contradicts §4, this
section wins.

### The headline: there is no local state. None.

The gating question was "does `commit` reach the cloud?" — the real answer makes the question
meaningless. **The working tree itself replicates continuously**: a freshly written, *uncommitted*
file reports `Synced` within seconds. A background agent (`dv --agent`, one per machine, serving
every workspace) ships every write as it happens. Perforce at least waits for an explicit
`p4 shelve`; Diversion waits for nothing.

Consequences the runner has to own:

- Every byte a build agent writes is server-visible **before any gate runs** — the verify gate
  gates what *lands*, and can never gate what *leaks*.
- A scope run that somehow writes (the read-only chmod is defense-in-depth, not a wall) leaks
  instantly. There is no "it never left the machine" tier on this backend, not even for failures.
- Crash recovery inverts from a problem into a gift: a dead machine loses **nothing** — the
  workspace, uncommitted edits included, survives on the server. `reapOrphans` becomes a server
  query (`dv workspace`), needing connectivity but protecting more than git's reaper ever could.
- The sync agent is load-bearing infrastructure the daemon doesn't own. If it dies mid-run,
  writes stop replicating and the backend's assumptions quietly fail — a Diversion backend must
  supervise or at least health-check it.

### The lease: the pool-of-1 assumption is WRONG here

A second workspace of the same repo cost **4.4 seconds**, coexists with the first, and checks out
its own branch — each workspace is a server-side object with its own id. **Diversion supports
space-isolation like git**: mint a workspace per Run, dispose after. What it charges instead of
time is *visibility* (every workspace is account-visible server state) and *placement* (`dv`
refuses to put workspaces in some locations — `/tmp` is forbidden outright — so the runner does
not get free choice of a worktrees dir). Open: the 4.4s was a toy repo; whether sync is lazy
enough to keep that flat on a large repo is unmeasured, and Diversion repos are large by design.

### `integrate` survives; `publish` needs the backend to carry the guarantee

- **No rebase — confirmed** (absent from the entire CLI surface, along with any `push`/`pull`;
  `update` is pull). Merging the target into the run branch produced exactly the combined tree
  the interface promises. The outcome holds.
- **Publish never fast-forwards.** Merging the run branch back into an unmoved target minted a
  NEW commit — but `dv diff` between the verified commit and the landed one: "No changes
  detected". **The merge-queue guarantee survives at TREE level, not commit level.** Acceptable,
  and worth stating exactly: what lands is the tree verify saw, under a commit id verify never
  saw.
- **Diversion's native merge papers over the race — measured, not feared.** With the target
  advanced behind the run's back, `dv merge --into main` answered "Merge succeeded", exit 0, and
  landed a combination no verify ever saw. No out-of-date check exists. So `publish`'s
  compare-and-swap **cannot be delegated to this backend** — a DiversionBackend must implement it
  advisorily (record the target head at integrate; re-check before merging; refuse on movement),
  which carries an honest TOCTOU window between check and merge. Git does not have that window
  (`--ff-only` is atomic at the ref); this backend does, and THREAT-MODEL.md must say so if
  RUN-51 proceeds. (Open: whether the REST API offers a precondition the CLI doesn't.)

### Conflicts: the CLI is a dead end, by design

A conflicted merge exits **0**, prints a web URL, and leaves the local workspace CLEAN — no
markers, no in-progress state, nothing to edit. The conflict lives server-side as a pending-merge
object (`dv.merge.<uuid>`) resolvable in the browser. `merge-preview` opens a browser too. There
are no conflict paths in any output, no `--json` anywhere except `tag`, and exit codes that don't
distinguish success from conflict.

So on this backend, **agent conflict resolution as the landing flow does it (edit the conflicted
paths in the worktree) does not exist via the CLI.** Two honest options for RUN-51:

1. **Target the REST API, not the CLI.** The CLI is visibly a thin client over an HTTP API plus
   the sync agent; the pending-merge object presumably exposes its file list and resolution
   endpoints there. This is the only route to `integrate` returning paths.
2. **Degrade to bail-with-URL.** "A human must resolve this" is already the interface's answer to
   non-mechanical conflicts — on Diversion the daemon would post the resolve URL into the task
   comment and every conflict becomes a human conflict. Honest, shippable, and strictly worse
   than git.

Either way: **the CLI is a human tool, not a driver surface.** Interactive prompts, browser
launches, exit-0-on-conflict, and string-parsing for outcomes — a backend scripted over it would
be an ordeal (the exact failure mode RUN-54's checklist item 8 asked about).

### The wins nobody predicted

- **`dv review` is RUN-28, native.** One CLI command from the run branch → a review URL. No forge
  credential, no `gh`, no push step — the merge-request boundary ports to Diversion *more*
  cleanly than to git, using the same account auth as everything else.
- Shelves exist with a full CLI (`shelf create/show/apply/delete`) — though continuous sync makes
  them nearly redundant for durability; their use is stashing, not safety.

### The cost nobody predicted

**Everything is authored as the account.** The daemon's commits landed as "Montana Tuska
<mtuska@frs.llc>" — there is no per-invocation identity like git's `-c user.name` AUTHOR trick,
and no second credential to withhold: one login is workspace, commit, merge, review, and delete.
Two things follow. History cannot distinguish the runner's commits from the human's except by
message convention — the authorship-separation the verify gate leans on ("the verify agent never
edits") is only *observable* on git. And the "no agent ever gets push credentials" invariant
degrades here to "the agent's machine holds a credential that can do everything the human can" —
sanitizedAgentEnv can strip it from the child env exactly as it does the git credential, but the
sync agent needs it to run at all, so the workspace's writes reach the server regardless of what
the child process may hold. That is RUN-48's accepted trade, now with its exact Diversion shape.

### Verdict for RUN-51

The nine outcomes survive, **but the implementation surface is the REST API, not the CLI** — that
is a scope change to RUN-51 and recorded there. Effort-wise: lease/dispose/hasWork/checkpoint/
targetExists/createTarget are straightforward; publish needs backend-carried CAS; integrate needs
either the API's pending-merge surface or the bail-with-URL degradation; share is a no-op; review
is a bonus primitive git doesn't have. Ordering within the plan stands: Diversion remains the
cheap seam-finder, and it has already found four seams the paper spike missed.

---

Sources for the claims above, so nobody re-derives them:
[p4 shelve](https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/p4_shelve.html) ·
[Shelve changelists](https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/P4Guide/shelve-changelists.html) ·
[Diversion: branching & merging](https://docs.diversion.dev/core-concepts/branching-merging)
