# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@noriq-dev/runner` — a per-user local daemon that is Noriq's **execution plane**. It dials a Noriq
server over a WebSocket, discovers marked repos on disk, and spawns/supervises coding-agent processes
(Claude / Codex) inside isolated git worktrees, streaming status back to the dashboard.

This is a standalone repo, deliberately separate from the Noriq server (different runtime, trust, and
distribution boundary). It depends only on the runtime-neutral (pure zod) wire-contract slice of
`@noriq-dev/shared`, **vendored** under [vendor/noriq-shared/](vendor/noriq-shared/). Do not
hand-edit vendored files — refresh with `npm run vendor:shared`, and land the planar side FIRST: a
frame the server's schema rejects is dropped silently, and the daemon's telemetry and transcript
frames are fire-and-forget. [VENDORED-CONTRACT.md](VENDORED-CONTRACT.md) is the standing
explanation — including why the slice is still vendored rather than published, checked rather than
assumed (RUN-163), and the condition that would change it.

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
under-informed, not independent), and since RUN-145 gets them **numbered**, answering each with an
outcome and a piece of evidence rather than in prose (`src/acceptance.ts`). Prose is what hid the
criterion nobody checked: the code that would satisfy it is in the diff, so the report says PASS.
Three rules make the structure mean something — an unnamed criterion comes back
`behaviour-unverified` rather than passed, a `VERIFIED` pointing at nothing is demoted to it, and a
`FAILED` criterion cannot stand alongside `VERDICT: PASS` (the daemon takes the FAIL, because a
report that answers twice has passed nothing). Unverified is recorded and surfaced, never fatal:
most specs are half-written, and a gate that failed every one would make the field a tripwire.
This is also where the *inline* reviewer finally got the criteria at all — the same shape as
RUN-158, a rule described as holding for "the verify family" holding only for the dispatched member
while the one that gates every build had never been told what done means.
A gate that FAILS then hands the live builder a **specification** rather than a critique (RUN-146,
`src/repair.ts`): the outstanding criteria first, the report as the evidence behind them. It draws
the distinction prose cannot — `failed` means change the code, `behaviour-unverified` usually means
nothing *exercises* it and the repair is a test — so a builder told only "not satisfied" stops
rewriting correct code to satisfy a gate that could not see it. It never guesses which finding
threatens which criterion — RUN-147 makes that join real instead: a finding may name the
`requirementIds` it threatens in a second bracket, and the adjudication ledger matches a re-raise
on **a shared requirement at the same specific location** when the prose key misses. That is the
whole point of carrying the ids. Every round is judged by a FRESH reviewer that never saw the last one's
wording, so it paraphrases by construction — the prose key missed, the builder's evidence-backed
rebuttal was lost, and the round went on relitigating a settled point. A requirement id survives
rewording because it is not wording. The bracket is optional and sits after the severity, so every
finding written before it parses byte-identically. Matching may MISS but must never INVENT: merging
two real findings destroys one of them, where a missed match costs a duplicate row — so requirement
matching demands a specific location on both sides, which is what stops every cross-cutting finding
about one requirement collapsing into a single row. Findings enter the ledger when they are RAISED
rather than when a fix turn follows, because otherwise the terminal round's — the ones that failed
the run — never entered at all. The run then reports per requirement, and the wording is carefully
weak: "no finding was **recorded** against it", not "met" (nobody objecting is not the same as
anyone checking) and not "raised" (the ledger is bounded, so it can only speak for what survived).
On a PASS nothing is reported as standing: the gate read each finding and its rebuttal and cleared
the work anyway, so a summary still calling one open would contradict its own run.
A finding is also the unit the builder ANSWERS, and the reviewer's collapse rule (one numbered
finding per root cause, or a run is unconvergeable inside its round budget) made that unit
bundleable — so a finding carrying two separately-answerable claims was answerable in halves while
recorded as answered as a whole, and the first live terminal review lost a valid claim exactly
there: the builder rebutted the half it could refute and the other half rode the answer out.
RUN-180 prices that: a collapsed finding enumerates separately-answerable claims as lettered
sub-claim lines (`FINDING 1a: …`), a RESPONSE is credited only for the letters it names, and an
unaddressed sub-claim STANDS — visibly in the ledger and the per-requirement report, and decisively
in the terminal contest, where a finding whose sub-claims are only partly contested is no candidate
to clear and the run fails without spawning the re-adjudicating reviewer. A sub-claim's IDENTITY is
its normalized claim text, never its letter — the structural settlement this run's own gestation
forced, after eight review rounds each found another leak in letter-set reconciliation (cap-slice,
prefix aliasing, letterless re-raise, subset re-raise, markdown decoration): positional labels
assigned per-round by a memoryless reviewer cannot be identities, so the letter-repair machinery
(collision remapping, next-free-letter, kept letters) was deleted rather than extended. A letter
is pure position — the parse enforces `a, b, c…` in report order — read once at the fold boundary
to resolve a RESPONSE against the lines its writer was shown (this report's own, and past them the
record's positions), then discarded; every render re-derives letters from position, and the
contest turn is handed THE RECORD — each standing sub-claim with the letter that answers it here —
because without it a claim the terminal report does not re-list would be standing and unanswerable
at once, and its answers land on the record's positions ALONE (`applyContestResponses`): the one
turn that may add no claims never re-runs the union, because report-first resolution on the
overflow path — where the record is the held set and the report's enumeration is the thing that
was dropped — discarded answers to the very claims the record displayed as answerable.
Candidacy is judged on the RECONCILED ledger entry, never on the terminal round's own
parse: the fold preserves held claims when a re-raise drops the letters (a fresh reviewer
paraphrases by construction) — and when it repeats only SOME of them, unioning in the claims its
wording does not cover, because a narrowed re-raise replacing the set wholesale was the same
escape one fold up. Only a claim the re-raise abandoned AND the builder had rebutted is dropped —
settled by both sides — and the union never slices: past the entry's cap (twice one round's
enumeration cap) the held set stands whole and the new enumeration is the thing dropped,
all-or-nothing again, with this turn's answers still landed on it by wording. Carried answers
match a re-raised sub-claim by its WORDING, and a truncated (ellipsis-capped) claim never matches
— two distinct over-cap claims share it — the may-miss-never-invent order of harms, one level
down. The held record itself transfers across a re-raise only on a match that cannot be an
invention — the parent claim's full wording, or a shared requirement at a specific location: the
60-char prose prefix still names the ENTRY (legacy identity, unchanged) but cannot hand contested
letters to a claim that diverges past it, which is prefix aliasing at parent grain buying a fresh
look on contests nobody made. Instances of one root cause never become letters — they stay evidence inside one claim, or
the letters are the instance-enumeration the collapse rule bought out. The format is optional and
positionally additive like the requirement bracket, so everything written before it parses
byte-identically; a persisted ledger predating sub-claims loads as single-claim entries, and one
persisted by the letter-era shape loads claim-keyed with its stored letters ignored. The
enumeration invariant — no separately-answerable claim escapes its own answer — has exactly ONE
enforcement point, the parse-time classifier (RUN-90's chokepoint rule applied to the format
itself), and the rule validity RESTS on is the COMPLETENESS CERTIFICATE, not any shape: an
enumerating FINDING line ends its claim with `[sub-claims: <n>]`, and the letters are kept only
when exactly n strict in-sequence lines parse. Shape nets can only void what they can SEE, and a
mangled line can compose decoration, spacing and separator loss into plain English (`(b) FINDING
1 b — claim B` is invisible to any rule that spares prose — the composition class every rewrite
of the nets leaked at); the certificate voids by ABSENCE instead, since a line that mangles into
ANYTHING is simply not counted, and no certificate — or a mutated one, which fails to parse as
one — keeps no letters at all, the same safe degradation. What the certificate cannot see is a
STALE count — one that excludes a mangled sibling by fiat rather than by absence, a mundane slip
rather than incoherence — and POSITION closes that: the enumeration is a contiguous BLOCK
directly under the FINDING line, and the finding's ZONE — from the block's end to the next
structural line (the next numbered FINDING, ESCALATE/ACCEPTANCE/VERDICT, or the end of the
report) — must hold nothing but blank lines, so a sibling written into its own finding's
territory voids the whole whatever it mangled into, and a blank line cannot detach it. Within a
finding's territory every content line is recorded, structural, or a voider — there is nowhere
left for an unrecorded claim to sit — so narration lives above the findings or below the
structural lines, and prose that strays into a zone costs the enumeration (dull), never keeps a
subset. Claim identity also survives its own display cap: the display keeps the legacy
bare-ellipsis cap, byte-identical, and an over-cap claim stores its FULL normalized text in a
separate identity field beside it — whole at ANY length, never hashed, truncated, or bounded (a
truncated identity aliases every claim sharing its prefix, a 32-bit fingerprint is trivially
collided into merging two claims — this run's own terminal round mined the collision that killed
the fingerprint edition — and a length bound is a cliff where an exact letterless re-raise LOSES
its partly answered record, which the round after mined at bound+1; the count and display caps
are what keep the ledger distilled, and identity is the one field whose job is losslessness) —
so a verbatim re-raise of a long claim recognises its held record, two distinct long claims can
never alias, and only a record the bare-ellipsis era persisted still refuses to match: the
visible duplicate row it always was. The parse chokepoint also owns the LINE SHAPE it
classifies — line endings are normalized before any anchor runs, because a CRLF report's
findings still parsed while its every enumeration silently voided on the `\r` the anchors
refuse — and the persisted-record reader applies the same all-or-nothing grain at the other
boundary where sub-claim state is born: a malformed entry or an over-long list voids whole to
the single-claim entry, never to the well-formed subset a partial contest could clear around,
while fields inside a well-formed entry degrade toward STANDING, the direction that cannot
clear. What
remains around those rules is hygiene, not
the invariant: the HEAD net (any line whose first letters are `FINDING <n>` — markdown decoration
is a letterless prefix), the NEAR-COLON TOKEN net (`FINDING <n>…:` anywhere — decoration can wear
letters, and a colon hard by the number is label-intent where a colon further on is sentence
structure), the LABELLED TOKEN net (word-material glued to the number, colon or no colon,
voids everywhere but the finding's OWN block lines, the only places a lettered token is format
rather than mutation), and the SPACED LABEL net (a LONE letter adrift of its number across pure
punctuation — the composition that wears decoration, drops the colon and un-glues the letter all
at once, which is how a sibling written below a structural line sat outside every zone; a
following letter makes it an ordinary word, so mention survives, and the lone single-letter word
is the priced cost). A letter that survives only as line decoration (`(b) FINDING 1 — …`) is
attributable by nothing but position — it is byte-for-byte how narration quotes the record — so
inside a finding's territory it voids by zone and outside one it is the unattributable residual
the certificate also excluded from its count. There is deliberately no
in-range sparing left: a recorded letter can be WORN by a distinct unrecorded claim, and a stale
certificate that counts only the strict line then blesses the kept subset — so reports narrate a
sub-claim as `(a)`, the form every render uses, never as a bare `FINDING 1a` token. A
mid-sentence mention with no colon beside it and no label on the number stays harmless prose,
since reports narrate their findings by number and voiding on mention would kill every
enumeration in a report that explains itself. Fold, render, and candidacy consume the canonical
set and carry no shape detection or degradation rules of their own — the class dies where the
data is born, or it does not die. The terminal report's own shape is not a second gate either: candidacy asks the
reconciled entry — every sub-claim contested and visible, or the finding stands — and the
per-letter contests reach it through the contest application, so a letterless re-raise answered
through the record's letters clears without a bare response beside it.
Findings reach the agent and, when they are contradictions rather
than gaps, the run transcript. They are never fatal: a spec is orientation, not part of the
security floor, so a stale path must not become a tripwire — and the rendered block says out loud
that a spec cannot change an agent's mode, permissions, or what it may publish, because every field
in it is free text from the server.

A finding that is real but not THIS task's also has somewhere to go besides a fix round
(RUN-188): `spin_off_task`, on the build and verify floors, files it as its own task. The
distinction is drawn against `raise_alert` and the two must not merge: an alert is a concern that
is NOT work ("this smells wrong"); a spin-off is work that is not mine — RUN-186's landing run
contested with evidence and raised an alert carrying a full design sketch, and still FAILED,
because an alert is prose: it records the concern but creates no work a gate can point at, and a
human had to fold it into a task by hand. It does not reopen RUN-69: `create_task` stays off every
floor, and the spin-off's product is a PROPOSED task — visible, carrying provenance (source task,
source run, the finding) — not claimable and not pumpable until a human accepts it, the RUN-23
gate again. What makes it more than bookkeeping is the gate integration: a spun-off task is an
adjudicable object — a `CONTESTED` may point at it as checkable evidence ("real, out of scope,
tracked THERE"), the DAEMON verifies the pointer mechanically and hands the result to the
credential-less reviewer as data (RUN-43: the judge cannot move work, so it gets facts, not a
token), a failed or unavailable lookup never CREDITS the contest (may-miss-never-invent, again) —
and the reviewer can still REJECT a spin-off as evasion: a criterion the diff owed cannot be spun
off; newly-found adjacent work can.

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

A spec may also declare its own **decomposition** (RUN-148/168): `steps`, an ordered list the
PLANNER authors — which files are one coherent piece of work is a judgement about the work, and
grouping `anticipatedFiles` mechanically splits one change across two steps and merges two
unrelated ones. `src/steps.ts` is the daemon's half, and only the mechanical questions judgement
cannot answer: usable ids, a runnable order, an affordable count. Validation is all-or-nothing and
never gates — a decomposition it cannot run is DROPPED and the run proceeds as one, which is what
every run was before and is always a correct way to do the work. `src/stages/chain.ts` then runs
one session per step: fresh context each time, inheriting the previous step's *conclusions* rather
than its exploration, reserving from the same `RunTally` as everything else, checkpointing between
steps so the next session reads the work from the tree. It stops at the first step that does not
finish, because continuing would build on a foundation the run already knows is broken. The gate
stays at the PARENT — a criterion is a statement about the finished work, and a step that satisfies
its own slice can leave the whole unmet — and the fix turns hand back to the last step's session.
Each step's spend records into its OWN tally slot — the tally is last-writer-wins per slot, so a
chain sharing `primary` would report only its last step and guard against a figure nobody was
writing. A park records WHICH step it stopped on: without that a resume restored one session, ran
it, and reported the run done having silently skipped the rest of its plan. A resume then rebuilds
the RUN's brief and runs the steps that never got to (RUN-169): the resume prompt is deliberately
only the question and the answer, because the session it restores already holds everything else —
but a session opened AFTERWARDS holds nothing, so it gets a brief from the same assembler `prepare`
uses (`stages/brief.ts`, the half of preparation that acquires nothing). A resume that cannot
rebuild one finishes the parked step and reports what is left rather than briefing a fresh session
with an answer to a question it never asked. Because a park lasts up to 72 hours and the
spec may be corrected while it waits, a parked step gone from the recomputed chain fails the run
rather than guessing between redoing landed work and abandoning it. A transcript segment carries
WHICH step said it (RUN-150), alongside the reviewer round rather than instead of it — a chain's
step three can still be on its second round — and the label clears when the chain ends, because the
gates that follow are the parent's. Children are steps of one run, not runs of their own: the run
keeps one identity, one credential and one budget, and the dashboard breaks a block at a step
boundary even when the voice is unchanged, since two `agent` blocks from different steps are two
sessions with different context.

Then the **pattern mapper** (RUN-144, `src/stages/pattern-map.ts`), for each file the plan
anticipates: the closest existing file in this repo that does the same job, and what to copy from
it. gsd-core's rule is the only rule — *name the file and the lines, never the idea* — because
"follow the repo's error-handling pattern" is something a model already believes it is doing.
`build.md` has always asked for this in one sentence and given the agent no means to comply; this
is the means. It is also the only writer of `src/repo-intel.ts` (RUN-143), a `(server, repo, baseId)`
cache of entry points, layout, conventions and test commands — so a repo that has not moved is not
re-derived. A cache hit short-circuits the FACTS half and nothing else — analogs are per-task and are never
cached, so skipping the stage on a hit would make a warm cache produce a worse brief than a cold
one at the very thing it exists for. It is also skipped for a continued run, whose `baseId` is a
merge-base rather than the tree it is looking at. It is a
CACHE, not an authority: a corrupt read is a miss, deleting the file costs latency and nothing
else, and the rendered block says the code in front of you is the truth.

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

A **resumed** park re-fetches its anchor task and re-checks the spec against the workspace before
handing the answer over (RUN-164), and sends the DIFFERENCE when either moved — a park lasts up to
72 hours, so the human who answered may also have corrected the spec, and another run may have
landed under it. Silence when nothing changed: re-sending the brief would tell a session what it
already holds.

**Cancelling a run is a fact about the RUN, not about a session** (RUN-165). `SteeringBridge`
records it and `stopBefore` (run-machine.ts) is asked at every stage boundary, because the pipeline
is many sessions with gaps between them and every pre-execution stage is deliberately non-fatal —
so "stop whatever is registered right now" let a cancelled run go on to build, and a cancel landing
between stages found no target at all. `settle` always runs: refusing to enter it would leak the
terminal report, the locks and the workspace.

The **write floor is workflow-independent** (RUN-118): `clampPermissionToWorkflow` forces `write =
false` for any non-producing workflow at every permission site, so "verify executes but never edits"
is enforced in code, not by trusting the manifest — a custom workflow can never widen its posture.

### Agent coordinate (formerly tool + model + effort)

A dispatch/manifest names the agent as one dotted **coordinate** — `claude.opus-4_8.high` (`.` in a
model version is written `_`) — parsed by `src/agent-coordinate.ts`. It is canonical; the legacy
`{tool, model, effort}` triple is derived from it for a deprecation window that is still OPEN —
RUN-163 checked: the removal condition is "the second minor release after the dashboard emits
coordinates by default", and the dashboard sends `agent` only when a model or effort is pinned, so
the clock has not started (`runCoordinate` /
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
- **One worktree per unit of concurrent work**; never two RUNS in one checkout; never force-delete
  work that exists nowhere else.
  ~~One worktree per Run~~ was the wording until RUN-149, and the amendment is narrow: the rule that
  carries the isolation is *never two runs in one checkout*, and a run's own concurrent steps do not
  violate it — they are one run's sessions, under one identity, one budget and one lock scope.
  A SEQUENTIAL chain still shares the run's single workspace (RUN-168), because steps that cannot
  race need no isolating. Only steps a wave schedules to overlap take one each, and they take it for
  a reason the declaration cannot supply: `anticipatedFiles` is briefed as "a starting point, not a
  fence", so two steps in a wave *can* reach for the same file despite declaring otherwise. The
  overlap check decides what is worth running together; separate workspaces are what make running
  together safe.
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
