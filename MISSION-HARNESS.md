# Agent-led mission harness

This document describes the additive v2 execution core. It is the intended replacement for the
stage/pipeline orchestration path, but the daemon does **not activate it for a fresh
`run.assigned`** at this revision. Its `mission.v2` wire path exists so an already-durable local root
can be inventoried, reconciled, and adopted after reconnect or restart. That recovery compatibility
is not permission to advertise an execution profile, accept a new commission, or route a legacy
assignment into the harness. The legacy route must keep its current wire semantics until Noriq can
commission a mission with all of the authority described below and Runner completes the separate
commissioning follow-up described under the cutover gates.

The implementation now contains the deterministic mission kernel, strict guide/planner/reviewer
protocols, bounded sequential plan scheduling and repair, catalog-enforced independent stronger
review for writable plan steps, durable journals, machine-wide resource leases, restart-aware local
child-attempt ownership, a commissioned execution-boundary contract, Linux process/mount
containment, generic MCP composition, a repository
execution-profile registry, a durable Noriq mission coordinator, a bounded startup-handler buffer,
and a concrete Git workspace/evidence adapter. A project-neutral Diversion prototype is retained
internally but is deliberately absent from the published mission surface. “Implemented” here means
the supported local library components and their authority boundaries exist; it does not mean the
daemon/Noriq cutover, landing, or Project NOD activation gates below have been satisfied.

## Shape of a mission

One Noriq task or approved plan becomes one durable mission, one leased workspace, and a sequence
of bounded agent attempts:

```text
Noriq commission
      |
      v
deterministic kernel <---- append-only, hash-chained mission journal
      |
      +-- bounded projection --> guide agent --> one JSON proposal
      |                              |
      |                 profile id + bounded intent only
      |                              v
      +---------------------- validate and journal
                                     |
                                     v
                            child driver attempt
                                     |
                           VCS checkpoint evidence
                                     |
                            exact-checkpoint review
                                     |
                      repair loop or proven completion
```

The guide controls the order of useful work. It does not own authority or truth. Planning children
emit strict sequential execution-plan artifacts and review children emit strict review artifacts.
The guide sees every field of a bounded pending plan and adopts its exact canonical fingerprint
once; the deterministic scheduler then dispatches its build and review
steps without paying for a fresh guide turn between each child. The guide returns only for a
replan, a blocking human decision, or final disposition. Plan artifacts are capped at 32 steps,
with aggregate-compatible text bounds below the 1 MiB child-result and journal-action ceilings;
schema-valid model output is therefore persistable instead of being discarded after inference.
The aggregate plan is capped at 48 KiB so the complete untruncated artifact always fits in the
bounded guide projection; no hidden tail of planner-authored instructions can be authorized by a
digest alone.
The planner's trusted frame includes the exact mission ceiling and usage, each eligible profile's
worst-case attempt ceiling, the two guide turns reserved for adoption and completion, and the
three-attempt build/review multiplier. The kernel recomputes that worst-case reservation when the
planner settles and again at adoption. A structurally valid but unaffordable plan therefore cannot
spend early build calls before failing on a later repair or review admission.
Each scheduled step receives an opaque identity derived from its mission and planner child, so a
replacement plan cannot inherit failed work merely by reusing a human step id. The kernel owns admission, state
transitions, profile resolution, budgets, resource reservations, checkpoint and review identity,
terminalization, and cleanup obligations.

The initial scheduler deliberately runs one child at a time in the mission workspace. That makes
write ownership and editor-like resources deterministic and avoids deadlock on scarce capacities.
The protocol already records opaque resource reservations so controlled parallel reads can be
added later without changing the authority model.

## Authority boundaries

| Component | May decide | Must not decide |
| --- | --- | --- |
| Noriq | approved objective, project, human answers, cancellation | local model credentials or project tool transport |
| trusted Runner profile catalog | driver, model, effort, permissions, budgets, resources, exact MCP grants, assurance rank and independence class | task-specific next action |
| guide agent | next child profile, bounded instruction, review/repair/completion proposal | vendor/model, permissions, MCP inventory, VCS truth, final acceptance |
| child agent | perform its bounded assignment using its granted tools | widen its profile, settle the mission, rewrite journal facts |
| kernel and evidence adapters | durable facts, budget/resource admission, exact checkpoint/review proof, completion | invent model conclusions or silently reinterpret a Noriq commission |

The guide runs in a private non-repository directory with no Noriq tools and no project MCPs. Its
input is a bounded current-state projection, not a transcript. Its output must be one strict JSON
envelope. Repository content and child summaries are untrusted evidence even when they appear in
that projection. Profile projections contain only semantic identifiers and capability hints;
vendor/model selection, permission rules, and exact tool grants remain kernel-side. Planner
children receive bounded budget ceilings only so they can construct an admissible plan; they cannot
change those ceilings. Child
prompts come from a required trusted role-aware renderer. Raw guide text is
only labelled untrusted evidence; the renderer/schema version and exact rendered-prompt digest are
part of attempt identity, so a deploy cannot attach under changed prompt authority.

Ordinary guide projections target 64 KiB of compact serialized characters. The single turn that
must inspect and adopt a complete execution plan targets 128 KiB so the at-most-48-KiB plan remains
untruncated. Old child/question evidence is removed first. Non-trimmable objective, profile,
checkpoint, and pending-plan authority may expand only as required beneath the absolute
192,000-character ceiling; it is never silently clipped to hit the economical target.

## Durable lifecycle

Every accepted action and the events it emits are one compare-and-swap journal record. Records are
canonical JSON, size-bounded, hash-chained, and replayed through strict action/event schemas. An
action id is idempotent only when its canonical action fingerprint also matches.

The bundled JSONL store is a single-host authority. Linux lock owners carry boot and process-start
identities so dead owners and PID reuse are distinguishable. Other supported Runner platforms use
portable PID liveness: normal locking and dead-owner recovery work, but a rare stale-owner PID reuse
fails closed and requires operator removal of that private lock generation rather than risking two
writers. Shared filesystems need a real distributed lease and fencing authority, not this store.

The harness journals a guide turn before invoking a model. For a fresh child it journals the
deterministic attempt id, claims the attempt, and durably publishes a dormant execution wrapper
before any provider/model activation. Only after the harness has registered that wrapper does it
re-attest the workspace and commissioned runtime and activate the provider. Resource, claim, and
publication operations have finite pre-launch deadlines; timeout leaves a dormant/ambiguous
reservation and never a detached model. A lost guide response records unknown token/cost telemetry;
finite budget axes therefore fail closed instead of being reset to zero.

A guide timeout aborts its signal and waits for bounded termination acknowledgement. If the guide
does not acknowledge termination, the durable turn remains running and the controller stops with
an ambiguity error; it never launches a replacement beside a possibly live guide. Likewise, a
reattached child with a finite active-time budget must receive registry-trusted cumulative usage
for the exact attempt, including time before reattach. Stored telemetry alone is not sufficient to
prove that no active time elapsed while Runner was unavailable.

Every mission driver must also advertise a provider-side hard token envelope implemented by the
commissioned boundary. Runner passes the smaller of the session allowance and remaining mission
allowance, covering input, cached input, reasoning, and output before spend. Post-hoc telemetry,
output truncation, SDK task-budget pacing, and cancellation do not satisfy that capability; a
profile backed by a driver/boundary without it fails activation. Claude mission sessions disable
native Agent/Task delegation because subagent usage is not available to live metering.

Driver telemetry still reaches the local budget supervisor on every tick for ledger updates, USD,
and defense in depth. Journal-facing usage is coalesced to at most one update per second plus a
forced terminal high-water report, bounding event overhead without weakening live enforcement.

`AgentDriver` cannot reattach to a process by itself. Child execution therefore goes through the
included durable local attempt-session registry, which atomically returns one of:

- this attempt is safe to start;
- this exact live attempt was attached; or
- its state is ambiguous, so Runner must not launch a duplicate.

Without that registry the driver adapter refuses to spawn. On this single machine, Linux
parent-death containment lets recovery classify an attempt whose Runner owner died as lost without
starting a duplicate; its final model usage remains unknown and finite budgets fail closed. A
multi-host deployment still needs a distributed, fenced attempt authority rather than sharing this
local registry.

Logical mission completion is separate from durable cleanup, so workspace/lease cleanup can be
retried after restart without erasing the terminal result. A cleanup executor owns any timeout and
cancellation handshake and its promise must not settle until the external operation has settled.
Runner holds the controller lease while awaiting that promise; it does not abandon a timed-out
cleanup and overlap it with a retry.

Guide-attempt ownership is still process-local. It prevents a timed-out live guide from being
replaced in the same daemon, but it cannot resume a guide response across Runner restart. The
parent-death boundary makes a surviving duplicate impossible on the supported local Linux runtime;
recovery must record the durable turn as lost with unknown usage and fail closed. Resumable guide
turns or multi-host control still require a fenced external guide registry.

Validation uses the same ownership rule instead of an unjournaled shell escape hatch. The kernel
records one exact validation id, checkpoint revision, and catalog policy before a command may
start. The command runs inside the retained PID/mount containment boundary with nested VCS locator
metadata mounted read-only. Its environment contains no provider or Noriq credentials. Timeout,
cancellation, and owner death terminate the contained process tree; the adapter then restores the
workspace to the durable revision before recording the outcome. On restart, an active nonterminal
attempt first restores that revision and may safely retry the same durable attempt; terminal
cancellation/failure performs recovery only and records an interrupted failure without rerunning
the command. A zero exit is still failure if the command changed tracked, untracked, or ignored
workspace content.

## VCS is evidence, not ceremony

A successful write child is not enough to complete a mission. The evidence adapter must create an
immutable backend-native checkpoint and record both a logical `checkpointId` and an immutable
`revisionId` (or content digest). A reviewer is an independent read-only child commissioned against
that exact checkpoint. Its verdict is admissible only if it reports the same immutable revision.

No later child may inherit unproved workspace residue. After a successful write child, the adapter
creates its immutable checkpoint and removes every remaining ignored artifact before proving the
workspace exactly clean. A dirty checkpoint, or any failed, cancelled, or lost write child,
requires a harness-only `record-workspace-reconciled` fact before later work can be reserved or
started. That fact names the exact latest checkpoint revision (or the mission base revision when no
checkpoint exists) and records whether residue was restored or the workspace was quarantined.
Missing evidence fails the active mission before another model launches; post-terminal workspace
removal remains a separately retryable cleanup obligation.

Review evidence also requires a successful `verify`-kind child with read-only driver posture and
`reviewer` or `verifier` lineage. The child result is one strictly parsed review artifact naming
the exact checkpoint and immutable revision. The evidence adapter may persist that artifact, but
cannot rewrite its verdict, severity, or summary into a rubber-stamp pass. A changes-requested
review governs that immutable revision until a genuinely new descendant revision is produced;
logical aliases of the same revision cannot clear it.

Review summaries are capped at 12,000 characters at the driver, action, event, and kernel
boundaries. A deterministic low/medium repair receives that complete validated summary directly;
there is no larger accepted tail that can be hidden by prompt truncation and no extra summarizer
turn merely to recover the reviewer's actionable evidence.

Every writable planner step must name a review profile whose trusted assurance rank is strictly
higher than the builder's and whose trusted independence class differs from the builder's. Plan
adoption rejects missing or insufficient review authority before scheduling work. These values are
immutable local catalog policy: Runner does not infer strength or independence from a model name,
vendor, price, or guide assertion. Catalog authors are responsible for assigning ranks and classes
that describe their actual review policy.

The concrete Git adapter implements this contract for a single repository. It durably binds the
mission to its immutable base, deterministic `noriq/run/<run-id>` branch, physical worktree, and lease
generation; creates hook-free checkpoint commits; gives contained agents a disposable private Git
metadata view while mounting the real `.git` locator read-only; reconciles or quarantines residue;
validates the exact clean revision under the catalog-owned command-or-explicit-none policy;
preserves the accepted revision while releasing the worktree; and re-proves the deterministic
branch before recording its handoff. The preserved branch is a handoff artifact, **not a landed
result**. This path does not rebase, merge, push, open a pull request, or report a forge landing.
Every authority-bearing Git batch is bracketed by re-attestation of the same commissioned runtime
fingerprint, including an extra check immediately before deterministic validation spawns. A
one-time digest of whichever `git` happened to be on `PATH` is not durable authority: the injected
boundary must keep the VCS/tool image immutable for the retained runtime.

The project-neutral Diversion work is an **internal, unexported, fail-closed prototype**, not a
production adapter. Its strict fake tests exercise the intended remote branch/workspace and
local-clone boundaries, but they do not certify backend semantics. Publication, profile selection,
or Project NOD use is blocked on all of the following:

- bounded deadlines and cancellation for both HTTP operations and every `dv` subprocess;
- durable registration cleanup, including crash-safe unregister-before-removal after a partial
  clone or retry;
- exact commit proof across lost responses, including the complete committed/failed path set and
  immutable resulting revision;
- backend path-lock and hard-lock authority that prevents a competing writer during the mission;
- pinned repository/authentication identity instead of whichever stored credential or workspace
  listing happens to answer first;
- an authorized, replay-safe consumed-handoff acknowledgement before retiring a branch or
  workspace reference; and
- sacrificial live mutation certification for create, commit, reset, cleanup, retirement, timeout,
  cancellation, and every relevant crash window.

Keeping this code project-neutral does not lower those gates, and the prototype contains no
Project NOD or Unreal condition.

Perforce still needs its own mission workspace/evidence adapter. A mutable label, changelist, or
shelf number must not be presented as immutable proof. Each project must explicitly choose which
backend is authoritative: if Diversion owns the project, a Git checkpoint cannot stand in for a
Diversion revision; if Git owns it, dispatch must prove that exact repository and base. That choice
belongs in a trusted workspace adapter and project execution profile, not in guide text or an
Unreal-specific Runner branch.

## Immutable execution profiles

A repository declares mission environments with strict JSON files in
`.noriq/execution-profiles/*.json`. The outer declaration contains exactly:

- `schemaVersion` (`1`), stable `id`, positive `generation`, and `maxConcurrency`;
- a finite `missionBudget` for tokens, USD (or `null`), and active seconds;
- machine-wide `externalResourceCapacities` using only `external:*` keys; and
- the complete trusted `catalog` of guide, child, review, validation, budget, resource, and exact
  MCP-tool authority.

The registry does not accept arbitrary MCP paths, driver command lines, or project-specific fields
in this outer shape. It confines every read to the repository, rejects duplicate profile ids and
malformed declarations, and privately snapshots the exact profile and selected `.mcp.json` bytes.
Its portable declaration fingerprint covers that complete input. Local activation adds a separate
effective fingerprint for resolved launcher, containment, and runtime attestations without sending
paths, credentials, or probe output to Noriq.

Noriq commissions a profile by exact id, generation, declaration fingerprint, effective
fingerprint, and attestation capability. Admission matches every field and consumes a local
concurrency slot; a current refresh, unhealthy activation, fingerprint drift, or exhausted capacity
fails closed. Existing leases retain their already-attested runtime. Restart recovery re-attests the
exact immutable private snapshot named by an unsettled commission, requires the recomputed effective
fingerprint to match, and shares the current profile id's conservative capacity ceiling.

This identity boundary is separate from the mission plan identity. The durable Noriq commission
binds the root lease, repository and base revision, ordered task briefs and dependencies, total
budget, resource capacities, catalog fingerprint, and commissioned execution profile into one
content digest. Each task then receives deterministic mission/attempt identities derived from that
digest. A changed task, dependency, profile, budget, base, or catalog is a different commission,
not an in-place retry.

## Generic project MCP declarations

Runner has no Unreal-specific worker type and no Unreal configuration. For each execution profile,
the registry selects the repository-root `.mcp.json` plus the `.mcp.json` from each referenced
Noriq-managed Codex or Claude environment. A Codex home is selected only when the catalog names a
Codex guide or child; the same rule applies to Claude. The exact selected bytes are copied into the
profile's immutable private snapshot before activation.

Every source then goes through the same confined `loadMcpBundle` validation path.
`composeMcpBundles` combines those validated portable bundles before workspace binding, rejects
server-name collisions instead of assigning override precedence, applies aggregate fan-out limits,
and produces one stable fingerprint over the exact merged transport authority. `bindMcpBundle`
then binds that composition once to each child's leased workspace.

There is deliberately no agent-CLI ambient inheritance, parent-directory discovery, profile-local
MCP path override, or domain-specific merge rule. Runner's trusted registry selects only the
repository and referenced Noriq agent-environment roots, and a malformed selected source fails
preparation rather than disappearing from the effective inventory. A trusted execution profile
separately grants an exact server/tool subset; merely declaring or composing a server grants the
model nothing. The merged declaration is bound to the leased workspace at launch and re-attested by
the selected driver before it receives a prompt.

Repository-declared relative paths are normalized to `${workspace}` so they follow the leased
checkout. Agent-environment declarations do not receive path-shape inference or an implicit rewrite.
Instead, the machine launcher policy receives the command, every exact argument, the source binding
mode, and an argv identity; Runner accepts the response only when policy echoes that complete
identity. Such a policy must reject unresolved cwd-relative filenames and assignments, or authorize
an absolute machine-owned artifact in its sealed closure. An environment may name the active checkout
only with an explicit confined `${workspace}` argument.

For example:

```json
{
  "mcpServers": {
    "project-editor": {
      "command": "example-project-mcp",
      "args": ["--project", "${workspace}"]
    }
  }
}
```

All declarations are transport candidates, not grants or executable trust. They may not shadow
Runner-reserved `noriq` or `codex_apps`, carry literal environment/header credentials, escape the
selected declaration root through local executable paths/traversal, or create ambiguous flattened MCP tool
addresses. Local stdio is denied unless the generic launcher policy authorizes an immutable
executable identity and its complete runtime-closure identity. The daemon has no permissive local
launcher default: finding a command on `PATH` and hashing its wrapper does not prove the interpreter,
package cache, modules, or libraries it will execute. Runner therefore provides no online `npx`
convenience policy. A deployment may inject a generic sealed-artifact policy or a policy-owned broker;
the declaration alone, even with an exact package version, does not authorize a launcher. No policy
may teach Runner what an individual MCP server does or add a domain-specific exception.

Authorization metadata is carried into launch enforcement. A supplied policy records one canonical
absolute launcher, its content identity, an explicit immutable runtime-closure or broker identity,
and the complete authorized argv identity; the driver executes that resolved path instead of
performing a later inherited-`PATH` lookup. The
portable declaration fingerprint excludes host-local paths and policy identities; a separate local
effective fingerprint binds them and the workspace-resolved arguments. Immediately before the
containing Codex/Claude process spawns, Runner re-resolves and rehashes every granted stdio executable
and revalidates its runtime-root identities. The machine-owned policy remains responsible for proving
that the wider closure is sealed or encapsulated by its broker.

Remote HTTP/SSE is denied by default. A trusted endpoint policy must authorize and resolve the
actual endpoint; its identity and resolved HTTPS URL enter the fingerprint. Cleartext,
credential-bearing, loopback, private, local, and link-local literal endpoints are refused. A
production endpoint policy must also defend against DNS rebinding when resolving hostnames.

Driver launch includes only granted servers. Model workspace confinement and project-MCP subprocess
confinement are separate required capabilities. Before model work, the effective connected-server
set and flattened tool set must each equal the exact profile grant: a missing **or unexpected**
server/tool makes the profile unavailable. An allowlist that merely hides an unexpected raw tool is
not sufficient inventory proof. Codex inventory paging has a bounded deadline and
page/cursor/result caps.

Project NOD will supply its tools in the repository declaration, its Noriq Codex/Claude environment
declaration, or the collision-free composition of both. It will not select an `unreal-worker`, name
an Unreal feature flag, or require an Unreal-aware Runner configuration. Project-owned stdio tools
must be sealed or brokered in a form accepted by the generic launcher policy, and paths into the
active checkout should use `${workspace}` so the same declaration binds to the leased workspace
rather than the source checkout.

Project NOD is **not runnable through the v2 harness yet**. Its current project configuration must
be replaced or amended with compatible sealed/brokered MCP commands and an immutable execution
profile whose catalog declares validation, model/tool grants, budgets, and editor-resource
authority. That is project configuration and generic MCP/session work, not a reason to add Unreal
behavior to Runner.

Unattended external-editor work still needs proof at the generic boundaries: the profile reserves
an opaque `external:*` resource, and the MCP/runtime authority attests that the tool session targets
the leased workspace and flushes durable changes before checkpoint or review. Those requirements
apply to any stateful external tool. Their implementation belongs in the project MCP or generic
tool-session broker, not a Project NOD or Unreal branch in Runner.

The local mission runtime distinguishes ordinary containment from a commissioned execution
boundary. Linux bubblewrap supplies useful PID/mount isolation, workspace posture, and complete
process-tree settlement, but its process and descendants share one credential-visible mount and a
host network and have no cgroup/storage ceiling. It therefore cannot activate a v2 profile by
itself. The default daemon supplies no stronger boundary, so profile activation fails closed.

A machine-owned commissioned boundary may be injected only through Runner's trusted construction
path. It must expose provider authentication to the vendor control process while masking it from
every model-selected shell, tool, hook, skill, and MCP descendant; enforce PID, memory, CPU, I/O,
temporary-storage, and workspace-storage ceilings below Runner; default-deny and broker egress,
including localhost; and bind vendor, tool, MCP, containment, and VCS execution to one immutable
image or broker fingerprint. For mission profiles it must additionally enforce the exact
per-launch total-token envelope before provider spend. Runner checks that fingerprint during activation and reasserts the
authority around VCS batches, before validation spawn, and before mission creation/control and
child launch. A project declaration, model response,
or Noriq assignment cannot provide this object or upgrade ordinary bubblewrap into it.

Runner still stages only the selected Codex `auth.json` or Claude `.credentials.json` into a unique
per-attempt vendor-control home, so settings, plugins, hooks, skills, MCP declarations, histories,
and caches cannot persist into a later child. Staging is cross-attempt isolation, not the secret
boundary; the commissioned provider is responsible for making the home unavailable to
model-selected descendants. Runner removes it only after complete process-tree settlement and
retains it on ambiguous exit.

## Noriq coordination and startup

`NoriqMissionCoordinator` is the deterministic authority above the local runtime. It stores the
immutable commission in its own append-only, hash-chained WAL, executes the commissioned tasks in
their validated dependency order, carries the accepted revision forward as the next task's base,
and accounts every task against the one mission budget. The planner, guide, builder, reviewer, and
repair children remain private implementation details of the one Noriq task attempt.

Before local mission creation, the coordinator durably records an exact begin report and requires a
matching accepted Noriq acknowledgement containing the task, claim, and execution identities. It
uses the same write-before-send and exact-ack rule for settlement. A timeout, refusal, malformed
acknowledgement, catalog/profile mismatch, missing accepted-revision handoff, or unknown budget
usage stops progress instead of creating a second source of truth.

Restart inventory is read-only and includes only begin-acknowledged attempts without an accepted
settlement. Adoption accepts only the exact next lease epoch for the same sitting and execution and
records the adopted lease before control resumes. A refused, skipped, stale, or non-consecutive
adoption cannot launch a model. An `unknown` result is uncertainty, not cancellation: the root,
profile reservation, and workspace remain quarantined and reserved until an exact adoption or an
explicit authoritative terminal disposition arrives.

The startup buffer supplies the other half of this invariant. The daemon opens the WebSocket
immediately after REST registration, so registration and mission reconciliation frames can be
handled while ordinary assignments, cancellations, steering, and legacy recovery frames wait in a
bounded FIFO. Overflow poisons the control generation; drain is ordered and exactly once after
legacy recovery. Mission controllers start only from an exact adopted result.

Every mission acknowledgement, reconciliation operation, status, and control callback is fenced to
the exact accepted WebSocket generation. Disconnect synchronously revokes that generation before
asynchronous quarantine begins; a delayed callback or send from an older socket cannot adopt,
resume, settle, or otherwise control a root on a newer connection. A rejected coordinator control
result abandons and restarts that socket generation so Noriq must reconcile a new lease epoch.

An irrecoverable mission control-plane error is fatal to the daemon, not merely to the WebSocket.
The daemon stops accepting work and runs its complete shutdown path instead of leaving a registered
zombie process. Shutdown begins mission quiescence before ordinary teardown and **joins** the
quiescence promise; it does not abandon it behind a timeout race, report offline, or exit while a
contained guide/child/tool tree may still be running. Quiescence writes no terminal mission outcome,
so durable roots remain available for next-process adoption.

Dedicated workflow TOML may opt in with:

```toml
base = "build"
capabilities = ["mission.v2"]
```

The loader accepts that declaration only for a build-posture workflow. Declaration is not proof of
fresh-dispatch availability. The protocol implementation may negotiate `mission.v2` to reconcile
an already-durable local root, while registration independently publishes an empty execution-profile
offer set and filters the capability from every workflow eligible for a new commission. The daemon
must never infer mission authority from a legacy workflow or silently fall back to the old pipeline
after accepting a mission lease.

## Noriq cutover gates

With a commissioned execution boundary, the local service can create, control, answer, cancel, and
sequentially reconcile durable missions,
and the coordinator implements the intended Noriq-side handshake. That library/runtime capability
does not make fresh dispatch active. Production commissioning remains withheld until these Noriq
contract and product gaps land:

- **PLNR-488 — consumed handoff.** A trusted consumer must acknowledge the exact accepted revision
  before Runner may retire its preserved VCS reference.
- **PLNR-489 — immutable plan commission.** A `single_root` assignment must include the exact bounded
  task briefs and dependency snapshot the coordinator will execute.
- **PLNR-490 — adoption timing.** The server must start its adoption deadline only after a
  capability-negotiated mission WebSocket is able to publish inventory and receive the result.
- **PLNR-491 — dispatch UI.** Plans must expose the `single_root` strategy instead of silently
  defaulting every operator dispatch to `per_task`.
- **PLNR-492 — individual-task durability.** A task dispatched as its own mission root needs the
  same durable lease, restart inventory, adoption, and settlement semantics as a plan root.
- **PLNR-493 — exact profile authority.** A `single_root` assignment must carry a non-null
  commissioned execution profile with exact generation and fingerprints.
- **PLNR-494 — cancellation.** Cancelling a plan must interrupt its live mission task attempts and
  release or terminalize their durable claims.
- **PLNR-495 — landed gate semantics.** `gate = "landed"` must recognize exact successful
  mission-task execution/consumption rather than only legacy task-anchored Runs.
- **PLNR-496 — human questions.** Noriq must durably publish and answer a mission question keyed to
  the exact root, task attempt, local question id, and lease epoch. Legacy `run.resume` lacks that
  identity and cannot be inferred safely.

The local attempt registry, historical execution-profile resolver, Linux containment provider,
daemon reconciliation bridge, mission-aware orphan reservations, and Git evidence adapter are
implemented. The Diversion prototype is withheld from the package surface as described above.
Landing PLNR-488 through PLNR-496 is necessary but not sufficient: Runner then needs an operational
commissioned credential/resource/network/runtime boundary plus a deliberate validation pass that
publishes only attested profile offers,
enables only eligible mission workflows, and routes the new immutable assignment into the
coordinator. Recovery negotiation must remain available without accidentally enabling that fresh
route. Other remaining Runner-side work is not permission to bypass those authorities:

- **Expose accepted-revision handoff.** After Git cleanup, the harness records the deterministic
  branch and immutable accepted revision only after re-proving both against the released durable
  lease. Daemon/Noriq settlement must expose that record to a human or a separate trusted landing
  operation, and must never report “landed” merely because the mission reached logical success.
  PLNR-488 owns the exact, authorized, replay-safe consumed acknowledgment required before a trusted
  backend adapter may retire that reference; elapsed time or disconnect is not acknowledgment.
- **Keep validation catalog-owned.** The execution profile's immutable catalog is the sole source
  of either a bounded deterministic command tied to the exact clean checkpoint or an explicit
  not-applicable policy. The mission daemon must not synthesize, overlay, or inherit validation
  from legacy `.noriq/project.toml` `[verify]`; `[land]` remains a separate trusted legacy operation.
- **Close or accept the guide recovery boundary.** Child attempts have durable local ownership;
  guide turns are not resumable across process restart. Local parent-death containment permits a
  fail-closed lost-turn result, while resumability or multi-host control requires fenced ownership.
- **Add a durable external-resource retirement protocol before operational scale.** The current
  machine-wide coordinator deliberately retains released allocation records. Those tombstones make
  repeated release idempotent and prevent a delayed acquire from reusing the same attempt, but the
  ledger has finite entry and byte ceilings. Deleting old records by age or count, rotating a Bloom
  filter, or replacing exact history with a digest would either permit old-attempt reuse or
  eventually reject every new attempt. Safe bounded compaction requires a resource epoch or lease
  generation to be journaled with the child attempt plus a fenced rollover handshake: active
  allocations from older epochs remain recoverable, missing allocations from retired epochs are
  rejected, and only released records from a proven-retired epoch may be removed. Until that
  protocol exists, ledger utilization is an activation and operational-scale gate; operators must
  monitor the ceiling and must not treat manual tombstone deletion as maintenance.

Mission launch uses a minimal allowlisted environment instead of the legacy run denylist, and the
Linux provider holds write/editor resources until the complete contained PID namespace exits. A
child cancellation cannot release those resources after merely sending a signal. The cutover must
remain an explicit capability-negotiated path: it must not infer a mission from legacy stage fields
or silently fall back to the old pipeline after accepting one.

## Git mission canary

The retained deterministic-agent canary exercises the real mission service, durable JSONL journal,
Git workspace adapter, exact checkpoints, independent review, one low-severity repair loop, cleanup,
and preserved accepted-revision handoff against disposable clones of one or more repositories:

```sh
npm run test:canary:git -- \
  runner=/absolute/path/to/runner \
  noriq=/absolute/path/to/noriq
```

The command emits a JSON result for every repository and removes its temporary clone. It does not
invoke Codex or Claude and therefore does not prove provider authentication, model quality, MCP
inventory, network isolation, or hard provider-token enforcement. Those require an operational
commissioned execution broker; the canary must never replace or weaken that activation gate.

## Code map

- `src/mission/protocol.ts`, `action-schema.ts`, `event-schema.ts` — durable wire-neutral model.
- `src/mission/decide.ts`, `reducer.ts`, `kernel.ts` — deterministic authority and state.
- `src/mission/jsonl-store.ts` — local durable journal and cross-process writer boundary.
- `src/mission/harness.ts`, `service.ts` — control loop and daemon-facing composition surface.
- `src/mission/profile-catalog.ts` — trusted immutable guide/child authority snapshot.
- `src/mission/execution-profile-registry.ts` — confined declarations, immutable snapshots,
  attested offers, exact commission matching, and capacity leases.
- `src/mission/noriq-coordinator.ts`, `noriq-coordinator-store.ts` — commissioned task sequencing,
  begin/settle authority, restart inventory/adoption, and the private coordinator WAL.
- `src/mission/driver-runtime.ts` — generic driver adapters and restart-safe attempt boundary.
- `src/mission/local-attempt-registry.ts` — durable single-machine child-attempt ownership.
- `src/mission/global-resource-coordinator.ts` — machine-wide opaque external-resource leases.
- `src/mission/local-runtime.ts` — preflight and trusted local composition boundary.
- `src/mission/git-workspace-adapter.ts` — concrete Git lease, evidence, and branch preservation.
- `src/mission/diversion-workspace-adapter.ts` — internal, unexported Diversion prototype.
- `src/project-mcp.ts` — confined, project-neutral MCP declaration loader and binder.
- `src/process-containment.ts` — generic commissioned-boundary contract plus the deliberately
  insufficient-for-v2 Linux PID/mount implementation used for legacy process-tree settlement.
- `src/workflow-store.ts`, `registration.ts` — declared-versus-activated workflow capability gate.
- `src/ws-handler-buffer.ts` — bounded, ordered startup barrier for ordinary WebSocket frames.
- `prompts/mission-guide.md` — strict guide instruction contract.
