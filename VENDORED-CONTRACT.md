# The vendored contract boundary

How the runner and planar share a wire contract, why the slice is vendored rather than published,
and what would change that.

Was `PLANAR-PORT.md`, a record of one crossing. It has now carried four, and per-crossing status
belongs in the git log and the ticket comments rather than in a document that goes stale between
them — so this is the standing explanation instead.

## The rule

`vendor/noriq-shared/` is **byte-identical to planar `packages/shared/src`**. `npm run
vendor:shared` copies it and must be a no-op on a clean tree. Never hand-edit a vendored file: the
edit survives until the next refresh silently reverts it, and the two repos then disagree about a
contract each believes it owns.

A contract change is therefore always at least two commits, in this order:

1. **Planar first** — change `packages/shared/src`, migrate, and land the server side. The server
   must accept the new shape before a runner can send it.
2. **Runner second** — `npm run vendor:shared`, then consume.

The ordering is not stylistic. A frame the server's schema rejects is dropped silently (`RunnerHub`
returns on a parse failure), and the daemon's telemetry and transcript frames are fire-and-forget,
so a runner deployed ahead of its server loses whatever the new field carried with nothing to
correct it. RUN-150's `step` label and RUN-166's executed-spec record are both in that shape.

## Why vendored, and what would end it

CLAUDE.md has said "vendored until the contract freezes" since the split. **It is not frozen**, and
this was checked rather than assumed: the contract changed four times in a single day of work —
`ExecutionStep` (RUN-148), `[context].agentInstructions` (RUN-155), the transcript's `step` label
(RUN-150), and `run.telemetry.executedSpec` (RUN-166). A published package would have meant four
releases, four version bumps, and four windows in which the two repos disagreed.

Vendoring buys exactly one thing and costs exactly one thing. It buys atomicity: the runner's
`vendor/` and planar's `packages/shared/src` are the same bytes at the same commit, so there is no
version skew to reason about. It costs the two-commit dance above and the discipline of never
hand-editing.

**The condition that would close it:** a stretch — call it a full release cycle — in which the
shared slice does not change. At that point the trade inverts: publishing costs one release and
buys ordinary dependency management, while vendoring keeps costing the dance for a contract nobody
is moving. Until then this is the cheaper side.

## What crosses, and what does not

**In the slice** (both repos, byte-identical): the wire frames (`ws.ts`), the run and runner model
(`runner.ts`), the project manifest (`manifest.ts`), the execution spec (`execution-spec.ts`), and
the model catalogue (`model.ts`).

**Planar-side only**: migrations, the Durable Object write paths, MCP tool definitions, and the
dashboard. These consume the slice; they are not in it.

**Runner-side only**: everything under `src/`. The daemon owns process, workspace and budget
authority, and none of that is a wire concern.

## The one design rule the boundary keeps producing

A field the daemon reads for POSTURE is authoritative on the daemon, never on the wire. `Run.kind`
is the standing example (RUN-126): a dispatch carries a kind, but `effectiveKind` resolves posture
from the manifest the daemon holds, so a client selecting a read-only workflow while leaving
`kind = build` cannot escalate write. The wire says what was ASKED FOR; the daemon decides what is
DONE. Every contract addition should be checked against that split — a new field that a client can
use to widen what an agent may do belongs on the daemon's side of it, or nowhere.
