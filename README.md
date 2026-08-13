# Noriq Runner

Noriq Runner is a small, durable agent-guided harness. Noriq commissions one immutable task or plan snapshot. Runner owns planning, building, deterministic checks, independent review, bounded repair, source-control checkpoints, failed-work preservation, and restart recovery. It never pushes, merges into a human base, opens a review, or interprets project MCP commands and tool schemas.

## Runtime boundary

- Noriq chooses a registered Runner and repository. It retains coarse progress, questions, evidence, usage, opaque revisions/checkpoints, and the final retained location.
- Committed `project.toml` selects registered driver and backend IDs, models, limits, checks, and isolated or direct behavior. It cannot provide executable paths, homes, credentials, or secrets.
- Machine-local `runner.toml` registers trusted driver/backend adapters and contains commands, isolated vendor homes, credentials, scan roots, and machine capacity.
- Project-native agent configuration and MCP files remain vendor-owned. Runner injects only its confined `noriq_runner` control MCP and does not parse project MCP commands or tool schemas. For Claude builders and repairers, it reads the project `.mcp.json` server names only so the CLI can grant those project tools noninteractively.

## Start

```bash
npm ci
npm run check
npm run vendor:check
npm run build
node dist/cli.js validate --config /absolute/path/to/runner.toml
node dist/cli.js doctor --config /absolute/path/to/runner.toml
node dist/cli.js start --config /absolute/path/to/runner.toml
```

The daemon discovers `project.toml` or `.noriq/project.toml` below configured scan roots. It REST-registers those project/repository associations before opening the job WebSocket, persists a server-issued Runner ID under the state directory when `runner.id` is omitted, detects source control, selects either the project’s registered backend ID or a compatible `auto` adapter, advertises the exact configured base revision, and refuses a commissioned revision that has moved.

See [`examples/project.toml`](examples/project.toml) and [`examples/runner.toml`](examples/runner.toml). Legacy `[workspace]` and per-role `provider` project keys are normalized once with warning events.

`validate` parses the machine config without connecting. `doctor` additionally discovers repositories and runs backend/driver authentication and capability preflights without a model call or Noriq connection. `usage --state-directory <path> --job <id>` reports durable per-invocation and aggregate usage. Real-agent dogfood is deliberately opt-in: set `RUNNER_LIVE_AGENTS=yes-i-understand` and run `npm run dogfood:live-agents -- /path/to/git/repository`; it operates on a disposable clone.

## Source-control contract

Runner core persists only backend-tagged JSON handles, filesystem workspaces, opaque revisions, candidates, checkpoints, and retained locations. Foreign or incompatible handles fail closed.

- Git isolated jobs retain an output branch and use independent task workspaces. Only accepted candidates fast-forward the output. Failed candidates move to recovery refs. Direct jobs pin the target, commit only accepted work, and restore rejected work to a recovery ref without advancing the target.
- Diversion uses its existing checkout under an exclusive repository lease. Isolated tasks work on candidate branches and merge into the server-visible job output only after acceptance. Direct jobs pin the configured target. Failed work stays on a candidate branch or named shelf.
- Perforce validates the client mapping and requires `allwrite`. Each task owns a numbered changelist. Isolated tasks refresh cumulative shelves; accepted work is reopened into the next task’s changelist while earlier shelves remain review checkpoints. Direct tasks submit only after acceptance. Failed work is shelved before the client is reverted.

Git isolated task workspaces may build concurrently. Diversion, Perforce, and every direct job advertise a pool of one, so the supervisor clamps task execution to sequential operation. Repository lease files are scoped by backend registration plus repository identity and include crash-recovery ownership.

## Agent-driver contract

The supervisor selects drivers by capability, not vendor name. Guide and reviewer sessions require enforced read-only access; builder and repair sessions require workspace-write access. Runner owns schemas, receipts, usage aggregation, budgets, cancellation, and recovery. A driver owns only translation to its vendor protocol.

Codex and Claude are separate built-in drivers with explicit workspace access modes, structured output, Runner Control MCP injection, and project-native configuration discovery from the workspace. Each invocation receives a fresh vendor home seeded only with the files needed to authenticate and initialize that CLI; Claude's copied project state is replaced with the current workspace. Personal histories, plugins, hooks, account-level MCP choices, and unrelated project choices are not inherited. Builder and repairer roles can consume workspace-native MCP configuration; guide authority is limited to Runner Control and reviewer authority is tool-free. Claude uses a small role-specific system prompt to avoid unrelated coding-agent instructions while retaining authenticated project-native operation. Trusted machine-home MCP inheritance is not implemented yet.

When Noriq supplies a populated execution specification, Runner deterministically converts it into the builder contract and does not spend a separate guide call. Every completed invocation stores its own normalized usage in the durable journal; `usage` shows the per-role breakdown as well as the aggregate. Cache tokens can still grow quickly in an agentic CLI because every tool round rereads the fixed vendor, tool, and project prefix. Runner therefore asks workers to batch independent operations, disables unnecessary tools and personal extensions, and exposes the measurement rather than treating cached input as free. A truly small planning/review context will require a thin structured-inference driver instead of a full coding-agent CLI; `external-jsonl-v1` is the current seam for that addition.

`external-jsonl-v1` is the extension seam for future vendors. Runner writes one versioned preflight or invocation object to stdin. The executable writes normalized JSONL events followed by exactly one result/error terminal frame. Malformed frames, duplicate terminals, frames after terminal, and capability drift fail closed. Cancellation targets the managed process group and escalates to a hard kill.

## Durability

The checksummed journal under `runner.stateDirectory/jobs/<job>/events.jsonl` is authoritative. It stores opaque workspace/task handles and complete checkpoint records. Agent receipts prevent completed calls from being repeated after a crash; unacknowledged Noriq events replay with their original sequence numbers. Backend operations are designed to rediscover already-created branches, shelves, changelists, and recovery locations before mutating again.

## Deliberate limits

- No legacy Run/mission protocol, server-side plan pump, execution profiles, landing, pushing, review creation, indexing, or Project Memory ingestion.
- Only blocker/major findings or deterministic check failures consume a repair round.
- Token or cost caps fail preflight unless a driver can honestly enforce them. Measurement without hard enforcement is not presented as a ceiling.
- Machine config accepts either a literal `token` or a `tokenEnv`, but the daemon does not yet refresh Noriq OAuth credentials. A long-lived production service still needs the rotating credential source before deployment.
- Full agent logs remain local under the Runner state directory. Noriq receives compact evidence only.
- Runner does not create Perforce streams or interpret site-specific branch/stream policy.
