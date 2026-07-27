# Planar contract port — RECONCILED

The record of what has crossed the runner↔planar boundary, and the design decisions that resolved
on the way. `vendor/noriq-shared/` is **byte-identical to planar `packages/shared/src`**
(`npm run vendor:shared` is a no-op); refresh it, never hand-edit it.

Two crossings so far: the driver-seam generalization (RUN-109…126, coordinates + workflows) and the
execution spec (RUN-134…138).

## Contract — agreed on both sides ✅

- **Coordinates:** `ModelDefault.agent`, `VerifyReviewer.agent`, `Run.agent`, and the registration
  catalog (`AdvertisedAgent` = `{tool, models[], efforts[]}`, `RunnerRegistration.agents`). The
  dashboard's `<tool>.<model>.<effort>` picker reads `agents`; `model` stays free-text.
- **Workflows:** `WorkflowDef {base, prompt}`, `ProjectManifest.workflows`, `Run.workflow`, and
  `RunnerRepo.workflows: string[]` (custom workflow **names**).

## The one resolved design decision — workflow posture authority (RUN-125 → RUN-126)

A custom workflow overrides only the PROMPT; its POSTURE is its `base` kind. So a dispatch must run
under the base's posture, or a read-only `docs` workflow left at `kind = build` would escalate write.

- **RUN-125** tried to close this by advertising the base (`RunnerRepo.workflows: {name, base}[]`) so
  the dashboard could set `kind = base`. That **collided** with planar (which types `workflows` as
  `string[]`) — `RegisterRunnerBody` would 400 the whole registration for any repo with a
  `[workflow.*]`. Reverted.
- **RUN-126** closes it the robust way instead: the **daemon** is authoritative. `effectiveKind`
  (supervisor.ts) resolves a run's `workflow` to its base and keys every permission/gate/tool-floor
  off THAT, ignoring a mismatched dispatched `kind`. The daemon holds the manifest, so the wire
  carries just the name and **no client — dashboard or otherwise — can escalate posture**.

Net: the wire is names-only (matches planar), and safety no longer depends on the dashboard setting
`kind` correctly. Planar's names-only picker is fine as-is; **no planar change is outstanding.**

## Deprecation window (RUN-124)

The runner still accepts BOTH the `Run.agent` coordinate and the legacy `{agentTool, model, effort}`
triple (and `Run.workflow` name or bare `Run.kind`). `test/agent-coordinate.test.ts` pins the
equivalence. Removal target: the second minor release after the dashboard emits coordinates by
default — then drop the legacy triple from `Run` and the `coordinateFromParts` fallback.

---

# The execution spec (RUN-134…138)

The runner is Noriq's orchestrator, not merely its executor, so what a builder is told before it
starts belongs in the server contract rather than in a runner-local file — Noriq is already the
durable authority for requirements, plans, tasks and docs, and a second copy would be a
synchronisation dispute. Direction settled in the *Runner as orchestrator* doc.

## Contract — agreed on both sides ✅

- **`ExecutionSpec`** (`packages/shared/src/execution-spec.ts`, RUN-134): `requirementIds`,
  `anticipatedFiles` ({path, change, why}), `requiredReading`, `lockedDecisions`
  ({decision, because, source}), `discretion`, `deferred`, and `acceptance`
  ({observableTruths, artifacts, links}). Every field defaults, so `parse({})` is the empty spec
  and a half-filled one is valid.
- **`RepoPath`** — repo-relative, `/`-separated, no `..`, no drive letter, no backslash.
  Well-formedness only: the daemon's descriptor-based confinement (RUN-151) is the boundary, and
  this must never be cited as the reason a path is safe.
- **`hasExecutionSpec(spec)`** — absent and empty are the same to a CONSUMER
  (`spec ?? emptyExecutionSpec()` reads either) and different to a PLANNER. Its field list is a
  `satisfies` map, so a field added to the schema and forgotten there is a type error.
- **`ExecutionSpecInput`** — `z.input`, because `z.infer` is the OUTPUT type and an author writing
  `{requiredReading: […]}` is writing a valid spec the parsed type rejects.
- **`Task.executionSpec`** (RUN-135) — nullable AND optional, admitting two different things: NULL
  is a fact about the task (nobody wrote one); ABSENT is a fact about the read, since only the
  detail surfaces carry it.
- **`Task.executionSpecUnreadable`** (RUN-135) — the stored value could not be parsed. It exists so
  `executionSpec: null` can be trusted: anything that plans reads null as "nobody planned this" and
  writes one, so corruption silently reported as null would be overwritten by the next planner run.

## Planar-side, landed and NOT part of the vendored slice

Migration `0061` (`tasks.execution_spec TEXT`, nullable, no backfill), the DO write paths, the two
detail reads, the MCP task tools + `create_plan`/`save_template`, the three agent-guidance surfaces,
and the dashboard panel. Runner-side consumption starts at RUN-139.

## Open on the planar side

- **RUN-160** — a run agent can rewrite the spec it is being held to. Needs the run's KIND at the
  `update_task` seam; a blanket agent ban is wrong because scope runs author specs.
- **RUN-161** — the dashboard's spec editor is a JSON textarea; a structured form is the end state.
- **RUN-162** — an approved spec does not freeze, and a change after approval leaves no before/after.

## What the runner still has to do

Nothing is consumed yet: `client.ts` rebuilds only `{key, title, body}` from a task, so a
dispatched build sees no spec. RUN-139 parses and renders one into the brief; RUN-142 draws the
predictive lock scope from `anticipatedFiles`, which is the first time the layer has a scope on a
FIRST sitting (a continuation already inherits `changedPaths`, RUN-130).
