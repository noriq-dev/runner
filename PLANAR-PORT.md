# Planar contract port (RUN-122)

The driver-seam generalization (RUN-109…121) added agent **coordinates** and **workflows** to the
wire/config contract. To ship the runner independently, those schema deltas were authored **in the
vendored copy first** (`vendor/noriq-shared/`) and are marked `PENDING PLANAR PORT`. This file is
the checklist to reconcile them into planar so a future `npm run vendor:shared` is a no-op.

**Do not run `npm run vendor:shared` until step 1 is done** — it overwrites the vendored tree from
planar and would delete every delta below.

## 1. Shared schema — port verbatim into `packages/shared/src`

These are additive, nullable/defaulted fields — no migration, no breaking change. A dispatcher or
server that ignores them behaves exactly as before.

**`packages/shared/src/manifest.ts`**
- `ModelDefault` gains `agent: z.string().nullable().default(null)` (the per-kind coordinate).
- `VerifyReviewer` gains `agent: z.string().nullable().default(null)` (the reviewer coordinate).
- new `WorkflowDef = z.object({ base: RunKind, prompt: z.string().nullable().default(null) })` + type.
- `ProjectManifest` gains `workflows: z.record(z.string(), WorkflowDef).default({})`.
- add `RunKind` to the `./runner` import.

**`packages/shared/src/runner.ts`**
- `Run` gains `agent: z.string().nullable().default(null)` (dispatch coordinate).
- `Run` gains `workflow: z.string().nullable().default(null)` (selected custom workflow).

Then `npm run vendor:shared -- /path/to/noriq` and confirm `git diff vendor/noriq-shared` is empty
except the removal of the `PENDING PLANAR PORT` markers.

## 2. Server — read the new registration fields (RUN-115/121)

The runner's registration POST body now carries (planar's zod currently strips these):
- `agents: Array<{ tool, models: string[], efforts: RunEffort[] }>` — the coordinate catalog per
  installed tool, for the dashboard's agent picker.
- `repos[].workflows: Array<{ name: string; base: RunKind }>` — each repo's custom workflows with
  the base kind the dashboard must set `Run.kind` to (RUN-125). Planar's `RunnerRepo.workflows` must
  carry the `base`, not just the name — else the picker can't derive the posture and a mismatched
  `kind` silently escalates write.

Persist/expose these so the dashboard can render pickers.

## 3. Dispatch — emit the coordinate + workflow (RUN-114/121)

- The dispatch UI should send `Run.agent` (e.g. `claude.opus-4_8.high`) instead of / in addition to
  the `agentTool`+`model`+`effort` triple. The runner accepts either (legacy triple still works),
  so this is a UI upgrade, not a hard cutover.
- When a repo advertises custom workflows, offer them on dispatch. Sending a custom workflow means:
  set `Run.workflow = "<name>"` **and** `Run.kind = <that workflow's base>` — the runner keys every
  permission/gate off `kind` (the workflow only overrides the prompt), so the base must be correct.
  The base now rides the registration (`repos[].workflows[].base`, RUN-125), so the dashboard
  auto-sets `kind = base` and should PREVENT a mismatched kind rather than only hinting it.

## 4. Dashboard — the pickers

- Agent picker: read `registration.agents` → `<tool>.<model>.<effort>` builder (model stays
  free-text — the catalog is a suggestion, not a whitelist; codex tops out at `high`).
- Workflow picker: the three built-ins (scope/build/verify) plus `repos[].workflows`.

## Deprecation window (RUN-124)

The runner accepts **both** forms for one window:
- selector: `Run.agent` coordinate **or** the legacy `{agentTool, model, effort}` triple;
- workflow: `Run.workflow` name **or** just `Run.kind`.

`runCoordinate` / `resolveWorkflow` normalize either, and `test/agent-coordinate.test.ts` pins the
legacy-triple ⟷ coordinate equivalence. **Removal target: the second minor release after the planar
port above ships** (i.e. once the dashboard emits coordinates + workflows, give it one release, then
drop the legacy triple from the Run schema and the `coordinateFromParts` fallback). Until then the
legacy path is load-bearing — do not remove it.

## Companion tickets

Filed in PLNR (see the runner plan "Generalize the driver seam"): the server-read (step 2),
dispatch-emit (step 3), and dashboard-pickers (step 4) work. The runner side is complete and
back-compatible; none of the above blocks the runner's own release.
