# Noriq Runner

Noriq Runner is a small, durable agent-guided harness. Noriq commissions one immutable task or plan snapshot. Runner owns planning, building, deterministic checks, independent review, bounded repair, source-control checkpoints, failed-work preservation, optional landing, and restart recovery. It never pushes, opens a pull request, or interprets project MCP commands and tool schemas.

## Runtime boundary

- Noriq chooses a registered Runner and repository. It retains coarse progress, questions, evidence, usage, opaque revisions/checkpoints, the retained location, and durable human landing intent/outcome.
- Committed `project.toml` selects registered driver and backend IDs, economy/balanced/strong role profiles, routing-sensitive path prefixes, limits, checks, and isolated or direct behavior. It cannot provide executable paths, homes, credentials, or secrets.
- Machine-local `runner.toml` registers trusted driver/backend adapters and contains commands, persistent Runner-owned vendor homes, credentials, scan roots, machine capacity, and the OpenAI pricing-cache policy.
- Project-native agent configuration and MCP files remain vendor-owned. Runner injects only its confined `noriq_runner` control MCP and does not parse project MCP commands or tool schemas. Noriq's copilot MCP catalog is a separate server surface; catalog revisions do not rename or expand this local harness control plane. For Claude builders and repairers, Runner reads the project `.mcp.json` server names only so the CLI can grant those project tools noninteractively.

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

See [`examples/project.toml`](examples/project.toml) and [`examples/runner.toml`](examples/runner.toml). Legacy `[workspace]`, per-role `provider`, and single-profile role shapes are normalized once with warning events. A tiered role may omit `economy` or `strong`, which then falls back to `balanced`; an omitted repairer role inherits all builder tiers.

`validate` parses the machine config without connecting. `doctor` additionally discovers repositories and runs backend/driver authentication and capability preflights without a model call or Noriq connection. `usage --state-directory <path> --job <id>` reports durable per-invocation and aggregate usage. Real-agent dogfood is deliberately opt-in: set `RUNNER_LIVE_AGENTS=yes-i-understand` and run `npm run dogfood:live-agents -- /path/to/git/repository`; it operates on a disposable clone.

## Source-control contract

Runner core persists only backend-tagged JSON handles, filesystem workspaces, opaque revisions, candidates, checkpoints, and retained locations. Foreign or incompatible handles fail closed.

- Git isolated jobs retain an output branch and use independent task workspaces. Only accepted candidates fast-forward the output. Failed candidates move to recovery refs. Direct jobs pin the target, commit only accepted work, and restore rejected work to a recovery ref without advancing the target.
- Diversion uses its existing checkout under an exclusive repository lease. Isolated tasks work on candidate branches and merge into the server-visible job output only after acceptance. Direct jobs pin the configured target. Failed work stays on a candidate branch or named shelf.
- Perforce validates the client mapping and requires `allwrite`. Each task owns a numbered changelist. Isolated tasks refresh cumulative shelves; accepted work is reopened into the next task’s changelist while earlier shelves remain review checkpoints. Direct tasks submit only after acceptance. Failed work is shelved before the client is reverted.

`sourceControl.landing` is `retain` by default. In isolated mode, `manual` keeps the reviewed output until a human chooses **Accept & land** in Noriq, while `auto` performs the same backend operation after every fully succeeded job. Both require an explicit `sourceControl.target`. Landing is journaled and idempotent across disconnects: Git fast-forwards the configured local branch, Diversion merges the retained branch, and Perforce submits the final cumulative shelf. A conflict leaves the output retained and reports a retryable failure. Direct mode is already landed as each task is accepted, so its landing policy remains `retain`.

Git isolated task workspaces may build concurrently. Diversion, Perforce, and every direct job advertise a pool of one, so the supervisor clamps task execution to sequential operation. Repository lease files are scoped by backend registration plus repository identity and include crash-recovery ownership.

## Agent-driver contract

The supervisor selects drivers by capability, not vendor name. Guide and reviewer sessions require enforced read-only access; builder and repair sessions require workspace-write access. Runner owns schemas, receipts, usage aggregation, budgets, cancellation, and recovery. A driver owns only translation to its vendor protocol.

Codex and Claude are separate built-in drivers with explicit workspace access modes, structured output, Runner Control MCP injection, and project-native configuration discovery from the workspace. Every invocation uses the persistent home registered for that driver, such as `~/.noriq/codex` or `~/.noriq/claude`; it never inherits the operator's ordinary personal home. That Runner-owned home is where an operator authenticates the CLI and deliberately installs Runner-wide settings, instructions, and MCP configuration. Repository-local `.codex`, `.claude`, and `.mcp.json` configuration is discovered from each task worktree through the vendor's normal project behavior. Runner's explicit model, access, output-schema, session-lifetime, feature, and role-specific tool restrictions still take precedence.

Invocations using one registered driver share its home concurrently, just as ordinary vendor CLI sessions do. Runner does not copy credentials, synthesize project trust records, or serialize Claude processes. This avoids independent OAuth snapshots racing one another and leaves concurrent credential/cache coordination to the vendor that owns those formats. Claude's supported unattended authentication options, including `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, are documented in the [Claude Code authentication guide](https://code.claude.com/docs/en/authentication); configure authentication in the Runner-owned home or the service environment, never in committed `project.toml`.

Builder and repairer roles can consume Runner-home and workspace-native MCP configuration; guide authority is limited to Runner Control and reviewer authority is tool-free. Claude builders and repairers receive repository read/write tools but no interactive shell: Runner owns setup and deterministic checks, preventing unattended permission-denial loops from burning context. Claude uses a small role-specific system prompt while retaining configured user and project settings.

Runner classifies each immutable task independently before agent spend. Build-ready tasks have anticipated scope and at least one acceptance condition and skip the guide; empty or partial specifications invoke it, while preserving all authored facts. Authored execution `steps` are rejected before workspace or agent effects because those steps must be dispatched as first-class plan tasks. Size chooses the base profile, elevated and critical paths apply role floors, actual candidate evidence can only upgrade review, and each repair round escalates one tier. Builder, reviewer, and repair prompts carry one normalized contract instead of repeating the raw task and specification.

Every completed invocation stores its normalized usage in the durable journal. For OpenAI-vendor drivers, Runner fetches only the official model Markdown page, strictly parses its API-list token rates, and caches an atomic mode-0600 quote for 24 hours. Refresh failure never blocks execution: a quote may remain usable and explicitly stale for the configured bounded window, otherwise cost is unavailable. Driver-reported cost takes precedence; derived Codex values remain partial API-list estimates, and incomplete aggregate cost remains null rather than becoming `$0.00` or a billing claim. Cache tokens can still grow quickly in an agentic CLI because every tool round rereads the fixed vendor, tool, configured-home, and project prefix. Runner exposes that measurement and asks workers to batch independent operations rather than treating cached input as free.

`external-jsonl-v1` is the extension seam for future vendors. Runner writes one versioned preflight or invocation object to stdin. The executable writes normalized JSONL events followed by exactly one result/error terminal frame. Malformed frames, duplicate terminals, frames after terminal, and capability drift fail closed. Cancellation targets the managed process group and escalates to a hard kill.

## Durability

The checksummed journal under `runner.stateDirectory/jobs/<job>/events.jsonl` is authoritative. It stores opaque workspace/task handles and complete checkpoint records. Agent receipts prevent completed calls from being repeated after a crash; unacknowledged Noriq events replay with their original sequence numbers. Backend operations are designed to rediscover already-created branches, shelves, changelists, and recovery locations before mutating again.

Queued `progress` events are also the canonical durable job phase. Task-scoped progress retains an independent task phase, and every terminal path enters `finalizing` before landing, terminal-output construction, and cleanup. The older `job.phase` journal record is accepted only when replaying legacy journals.

## Deliberate limits

- No legacy Run/mission protocol, server-side plan pump, execution profiles, pushing, review creation, indexing, or Project Memory ingestion.
- Only blocker/major findings or deterministic check failures consume a repair round.
- Token or cost caps fail preflight unless a driver can honestly enforce them. Measurement without hard enforcement is not presented as a ceiling.
- Machine config accepts either a literal `token` or a `tokenEnv`, but the daemon does not yet refresh Noriq OAuth credentials. A long-lived production service still needs the rotating credential source before deployment.
- Full agent logs remain local under the Runner state directory. Noriq receives compact evidence only.
- Runner does not create Perforce streams or interpret site-specific branch/stream policy.
