# Planar contract port (RUN-122) — RECONCILED

The driver-seam generalization (RUN-109…126) added agent **coordinates** and **workflows** to the
wire/config contract. The planar half is landed and the runner's `vendor/noriq-shared/` is now
**byte-identical to planar `packages/shared/src`** (`npm run vendor:shared` is a no-op). This file
is kept as the record of what crossed the boundary and the one design decision that resolved.

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
