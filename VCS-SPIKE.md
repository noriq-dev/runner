# Multi-source-control: design spike (RUN-44)

**Status: a written spike, not a plan of record. No code. It exists to decide one thing before
anyone writes any: whether a pluggable VCS layer is a real abstraction or a git interface with
indirection — and what it costs.**

Top-level answer, up front:

> **The operation set generalises. The security model does not.**
>
> Every git operation this daemon performs can be restated as an outcome that Perforce and
> Diversion can satisfy. But "the daemon never pushes" — the load-bearing claim in
> [THREAT-MODEL.md](THREAT-MODEL.md), the one enforced by *withholding a credential* — has no
> equivalent on either. On both, the daemon needs write credentials to do the ordinary work of
> a run. The boundary stops being something the daemon **enforces** and becomes something the
> **VCS server is configured** to enforce, by someone else, outside this codebase.
>
> That is a category change in the security argument, from *cannot* to *is currently configured
> not to*. It is not a paragraph edit. **It is the decision this spike exists to surface, and it
> is a human's to make.**

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

An interface with a no-op on two of three backends is a tell. It is not fatal (`autoPush` is
opt-in and git-only in practice), but it is the first thread of the real finding below: the
local/remote boundary is in a **different place** on each backend, and this daemon's design is
built on where git puts it.

## 3. Perforce: the adversarial mapping

The task asked for this specifically — prove it on paper against the backend that breaks the
model, or admit we built a git interface.

| Outcome | Perforce | Survives? |
|---|---|---|
| `isolate` | a **client workspace** (client spec) + a pending changelist | ⚠️ the client spec is **server-side state** |
| `hasWork` | `p4 opened` / `p4 diff -f` | ✅ |
| `checkpoint` | `p4 shelve` | ❌ **writes to the depot; other users can unshelve it** |
| `createTarget` | a stream, or a branch spec + `p4 integrate` | ⚠️ server-side, team-visible |
| `integrate` | `p4 sync` + `p4 resolve` | ✅ different mechanics, same outcome |
| `resume/abandon` | continue resolving / `p4 revert` | ✅ |
| `publish` | `p4 submit` | ✅ **submit rejects when files are out of date → `{race}`** |
| `share` | — | ❌ nonsensical; submit already published |
| `dispose` | `p4 client -d` + revert | ⚠️ deletes server-side state |
| `reapOrphans` | list clients by name pattern | ⚠️ **needs the server**; git needed nothing |

Verified against the P4 docs rather than assumed — `p4 shelve` "stores files from a pending
changelist **in the depot** without submitting them… the shelved version of files is stored in the
server", and "other users can **unshelve** the shelved files into their own workspaces."

**Seven of nine survive.** The interface is not a git interface with indirection: the outcomes are
real, and `publish`'s compare-and-swap shape maps onto `submit` almost exactly. The task's
prediction — that `{ok:false, reason:'race'}` generalises — holds.

**The two that fail are the two the security model rests on.**

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

From CLAUDE.md, honestly assessed. This is the section that matters.

### "The daemon never pushes, and never gives an agent push credentials." — **does not survive**

Git's version is enforced by *absence*: `sanitizedAgentEnv` strips the tokens, the credential
helper is disabled, and `git push` therefore **cannot** succeed. Everything before publishing is
local, so withholding one credential cleanly partitions "work" from "publish".

Neither other backend has that partition. In Perforce the agent needs depot credentials to sync,
edit, and shelve — the *daily work* — and those same credentials submit. Diversion is the same in
substance.

The portable restatement is:

> **The daemon never publishes to a shared target.**

…but the *enforcement* changes owner:

| | git | Perforce / Diversion |
|---|---|---|
| enforced by | withholding a credential | the VCS server's own permission model |
| enforced where | in this daemon | in someone else's server config |
| failure mode if misconfigured | push fails | **the agent submits to main and nobody notices** |
| we can test it | yes | no — it is not our system |

**This is the finding.** It converts a guarantee into a deployment requirement. THREAT-MODEL.md's
central claim would become conditional: *true on git; on Perforce, true only if your admin denied
`submit` to the runner's user in the protections table.* A user who installs the runner and points
it at their depot with their own credentials gets **none** of the protection the document promises,
silently.

Consistent with how `autoPush` was handled (RUN-27), the honest shape is: **opt-in, per-repo,
loudly documented, and off by default** — a non-git backend should refuse to publish at all unless
the operator states in the committed manifest that the boundary is enforced server-side.

### "One worktree per Run; never two runs in one checkout." — **survives, renamed**

Becomes "one workspace per Run". Real, and cheap on all three. Note the cost: on Perforce the
workspace is a server-side object, so per-run isolation means per-run server writes, and a crashed
daemon leaves *server* litter rather than local litter.

### "Git is the registry" (`reapOrphans` needs no external state) — **does not survive**

Today crash recovery is beautiful: the run id is in the branch name, so a fresh daemon reconstructs
everything from the local repo with no database, no lockfile, nothing to get out of sync. On
Perforce the registry is the **server's client list** — so crash recovery now requires
connectivity, and an offline daemon cannot clean up after itself.

### "Never force-delete work that exists nowhere else" — **gets weaker, and that is fine**

This one *relaxes*. On git the worktree may hold the only copy, so the reaper refuses to touch it.
On Perforce/Diversion a checkpoint is already on the server, so the work is recoverable by
definition. The invariant stays (it costs nothing) but it stops being load-bearing.

### "Verify ran on exactly the tree that lands" — **survives on all three**

The merge-queue guarantee is the crown jewel and it is portable: git rebases then fast-forwards,
Diversion merges then fast-forwards, Perforce resolves then submits with an out-of-date check.
All three can be expressed as *integrate → verify → publish-iff-unmoved*, all three can lose the
race, and all three can report it honestly.

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

1. **The interface is viable — build it, and specify it as the nine outcomes above.** It is a real
   abstraction, not indirection: `integrate` covering rebase *and* 3-way merge, and `publish`
   covering ff *and* submit, are both genuine generalisations that hold on a backend with neither
   git verb.
2. **Do not start with Perforce, and do not start with the driver.** The first task is a
   THREAT-MODEL decision, not code. Until "what enforces the boundary on a server-backed VCS" has
   a human's answer, any implementation is building on a security claim that is currently false.
3. **Diversion second, Perforce third — or never.** Diversion is the cheap seam-finder (it breaks
   the model in the same place, at a fraction of the setup cost). Perforce is the one with a real
   market — game studios — and it is the one whose price is a weaker security story.
4. **`share`/push stays git-only.** Do not generalise an operation that is a no-op on two of three
   backends; let the interface admit that git has a publishing step others do not.

### Suggested implementation tasks (to be split *after* this is accepted)

| | task | why in this order |
|---|---|---|
| 1 | **Decide + document the boundary for server-backed VCS.** THREAT-MODEL.md gains the table from §5; the manifest gains an explicit opt-in. | Everything else is unsafe to ship without it |
| 2 | **Extract the nine outcomes behind `WorktreeManager`'s existing DI seam, git-only.** No behaviour change, no second backend. Pure refactor, fully testable. | Proves the interface against the backend we understand, at zero risk |
| 3 | **Split `Workspace` into local path + opaque backend location.** | The §6 trap, fixed before a second namespace exists to trip on |
| 4 | **Diversion backend.** | Finds the seams a git-only interface hides |
| 5 | **Perforce backend** — gated on (1) having been answered. | The one that pays, and the one that costs |

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
