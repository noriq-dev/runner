# Noriq Runner

Noriq Runner is a small, durable job harness. Noriq commissions one immutable task or plan snapshot; Runner owns the local agent loop, dependency scheduling, checks, reviews, bounded repairs, Git checkpoints, and restart recovery. It never pushes, merges another branch, or opens a pull request.

## Runtime boundary

- Noriq selects only a Runner and repository and retains coarse progress, questions, evidence, usage, and the final Git result.
- Committed `project.toml` selects providers/models, limits, checks, and isolated or direct Git behavior.
- Machine-local `runner.toml` contains credentials, provider commands/homes, scan roots, and machine capacity.
- Project-native provider configuration and MCP files remain provider-owned. Runner injects only its confined `noriq_runner` control MCP into guide invocations and does not parse project MCP schemas.

## Start

```bash
npm ci
npm run check
npm run build
node dist/cli.js start --config /absolute/path/to/runner.toml
```

The daemon discovers `project.toml` or `.noriq/project.toml` within configured scan roots. It advertises the current configured base revision and refuses assignments whose immutable base no longer matches.

See [`examples/project.toml`](examples/project.toml) and [`examples/runner.toml`](examples/runner.toml). Provider homes must already contain valid authentication. Preflight checks the installed version, auth status, structured-output flags, and injected Runner Control MCP inventory before work begins.

## Git outcomes

Isolated task jobs retain `noriq/task/<key>-<job>`; plan jobs retain `noriq/plan/<key>-<job>`. Plan child worktrees build concurrently but enter a stable serialized rebase/check/review/integration lane. Direct mode requires a clean configured branch, pins its expected HEAD, takes an exclusive machine-local repository lock, and runs one task at a time.

The checksummed journal under `runner.stateDirectory/jobs/<job>/events.jsonl` is authoritative. Provider receipts prevent completed calls from being repeated after a crash; unacknowledged control-plane events replay with the same sequence numbers.

## Deliberate limits

- No legacy Run/mission protocol, server-side plan pump, execution profiles, landing, pushing, PR creation, indexing, or Project Memory ingestion.
- Reviewer invocations are read-only. Only blocker/major findings or deterministic check failures consume a repair round.
- Token or cost caps fail preflight unless an adapter can honestly enforce them. Measurement without enforcement is not presented as a hard ceiling.
- Full provider logs remain local under the Runner state directory. Noriq receives compact evidence only.
