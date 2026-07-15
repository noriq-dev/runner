# Multi-source-control: design spike (RUN-44)

**Status: a written spike, not a plan of record. No code. It exists to decide one thing before
anyone writes any: whether a pluggable VCS layer is a real abstraction or a git interface with
indirection — and what it costs.**

Top-level answer, up front:

> **The operation set generalises. The default-safe OFF switch does not.**
>
> Every git operation this daemon performs can be restated as an outcome that Perforce and
> Diversion can satisfy — including the one that matters most, *land on a working branch and ask
> a human to merge*, which maps onto Perforce's pre-commit review model closely.
>
> What does **not** port is the position where nothing leaves the machine. With `[land]`
> unconfigured — the default — a git runner writes to no server, ever. Perforce has no such
> setting at any configuration: `p4 shelve` *is* its checkpoint primitive, so isolating a run and
> making its work durable are themselves depot writes. That is the finding, and it is narrower
> than the one this document originally claimed.
>
> **Corrected after review.** The first draft argued that a server-backed VCS moves enforcement
> outside the daemon, from *cannot* to *is configured not to*. Montana pointed out that this
> compares Perforce against a guarantee we had already traded away: RUN-27's `autoPush` gave the
> daemon a push credential, and RUN-28 moved the human boundary from `git push` to *approving the
> merge* — on purpose, because freeing humans from per-run approval is the point of the product.
> Once autoPush is on, git's boundary is *already* the daemon's own code plus the forge's branch
> protection, and GitHub branch protection is exactly as external and untestable as Perforce's
> protections table. The dramatic version of §5 was measuring Perforce against v1.

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

- **No rebase.** Diversion documents 3-way merge with common-ancestor detection; rebase is not
  offered. `integrate` therefore becomes "merge the target into my branch", which still produces a
  tree containing target + my work — which is exactly what verify needs to see, and it leaves the
  target as an ancestor so `publish` can still be a fast-forward. **The outcome survives; the verb
  does not.** This is the single best vindication of naming operations as outcomes.
- **Branches are server-side and team-visible** — Diversion's docs put branch visibility at "all
  team members" and workspaces at "only you". So `noriq/run/<id>`, today a local throwaway nobody
  ever sees, becomes **a branch the whole team watches appear and disappear, once per run.** Git
  gives us disposable branches for free; Diversion charges social cost for them.
- **`checkpoint` reaches the cloud.** Same shape as Perforce's shelve, milder framing.

So Diversion breaks the model in the *same place* Perforce does, just more gently. That is the
strongest evidence that this is a real seam and not a Perforce quirk.

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

### The OFF switch — **does not survive, and this is the real finding**

With `[land]` unconfigured — **the default** — a git runner writes to no server at all. The work
lives in a local worktree on a local throwaway branch, and if the box dies, nothing anywhere else
ever knew. That position is reachable, it is the default, and it is what makes the runner safe to
try on a repo you care about.

**Perforce has no such position, at any setting.** `p4 shelve` *is* the checkpoint primitive — the
only way to make a run's work durable beyond the process — and it writes the depot, where other
users can read it. Isolation itself (a client workspace) is server-side state. There is no
configuration in which an agent's output stays on the machine.

So the honest statement is not "the security model collapses". It is: **a Perforce runner has no
safe default, and no dry-run.** Whatever the boundary, you are trusting it from the first run,
because the first run already wrote to the depot. That is a smaller claim than the first draft
made, and unlike that one, it is true.

### "One worktree per Run; never two runs in one checkout." — **survives, renamed**

Becomes "one workspace per Run". Real and cheap on all three. Cost: on Perforce the workspace is a
server-side object, so per-run isolation means per-run server writes, and a crashed daemon leaves
*server* litter rather than local litter.

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
2. **The blocker is smaller than the first draft said, and it is a product question, not a
   security one.** Not *"what enforces the boundary"* — the answer is the same as git's today, once
   autoPush is on. The real question is: **what does a Perforce runner do on the first run, given
   there is no configuration where its output stays on the machine?** git's `[land]`-unconfigured
   default is a dry-run mode Perforce cannot offer.
3. **Diversion second, Perforce third — or never.** Diversion is the cheap seam-finder: it breaks
   the model in the same place at a fraction of the setup cost, and it settles whether `checkpoint`
   crossing the network is survivable in practice before Perforce makes that question expensive.
4. **`share`/push stays git-only.** Do not generalise an operation that is a no-op on two of three
   backends; let the interface admit git has a publishing step the others don't need.
5. **Perforce's price is not the security model — it is the missing off switch, the server-side
   registry (`reapOrphans` needs connectivity), and team-visible per-run state.** All three are
   real, none is fatal, and none of them is what the first draft was alarmed about.

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

- **Whether Diversion's `commit` is local or reaches the cloud.** Its docs are explicit that
  branches are server-side and workspaces are private, but not about when a commit crosses. It
  changes how bad the §5 finding is for Diversion specifically. One evening with the CLI settles it;
  guessing does not.
- **Perforce streams vs branch specs** as the mapping for `createTarget`. Both plausibly work; the
  choice interacts with how a site already organises its depot, which we do not get to pick.
- **Whether anyone wants this.** The plan sequenced RUN-44 last precisely so this could be judged
  with the full git op set known. It now is — and the answer is that the abstraction is sound but
  its first backend costs the project its clearest security claim. That is worth a deliberate yes,
  not a default one.

---

Sources for the claims above, so nobody re-derives them:
[p4 shelve](https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/p4_shelve.html) ·
[Shelve changelists](https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/P4Guide/shelve-changelists.html) ·
[Diversion: branching & merging](https://docs.diversion.dev/core-concepts/branching-merging)
