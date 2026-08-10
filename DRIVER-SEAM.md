# Driver seam — what it takes to be a driver, and why GitHub Copilot is not one (RUN-282)

> Companion to [THREAT-MODEL.md](THREAT-MODEL.md) and [CLAUDE.md](CLAUDE.md)'s
> `drivers/` section. THREAT-MODEL is the authority on the boundaries; this file
> records what a *new vendor* must satisfy to sit behind `AgentDriver`, and the
> first assessment of a candidate that cannot (GitHub Copilot).

## The seam

`AgentDriver` (`src/drivers/types.ts`) is the ONE interface a vendor lives behind
(RUN-109…111). The supervisor reads a **capability**, never a driver's name — so a
new tool is a new implementation of this interface plus a rung on the wire enum, or
it is not support. `claude.ts` and `codex.ts` are the two implementations today;
`daemon.ts` wires them into `drivers: { claude, codex }`, keyed by `AgentTool`.

To adapt a vendor you must be able to answer all of the following in the vendor's
own runtime. These are not a wish-list; each maps to a line the supervisor already
depends on.

| Requirement | Where it bites | Claude | Codex |
|---|---|---|---|
| **Agent holds NO forge credential** — `sanitizedAgentEnv` strips it *above* the seam (`DriverStartOptions.env`), and the vendor must still authenticate | THREAT-MODEL invariant #1 (absolute for the agent half) | model creds only (Anthropic) | model creds only (OpenAI) |
| **Executes inside our trust boundary** — a local process we spawn and supervise, not someone else's runtime | CLAUDE.md "no third-party runtime adapter" | local `query()` | local `app-server` |
| **Token/USD telemetry stream** — `drivers/budget.ts` enforces ceilings by reading it live | "runaway agent burns unbounded tokens/$$" defense | yes (`modelUsage`) | tokens, no cost |
| **Steerable / interruptible session** — `pushInput`, `interrupt` | `steering.ts`, mid-run steer | yes | yes |
| **Reaches Noriq over MCP** — token on the transport, never the shell | RUN-43 | HTTP header | env bearer (the one deliberate exception) |
| **Reachable on the wire** — `AgentTool` enum carries the id | `vendor/noriq-shared` `runner.ts`; `drivers[tool as AgentTool]` | ✓ | ✓ |

`DriverCapabilities` (`toolHooks`, `steer`, `interrupt`, `resumableSession`,
`perModelTelemetry`) is where a driver declares honestly what it can and cannot do;
the supervisor branches on those, not on the tool string. A driver may decline a
capability — Codex declines three — but it may not **lie** about one, and it cannot
decline the two hard gates in bold above: they are the trust boundary, not a
feature.

## GitHub Copilot — assessment (RUN-282): NO

Evaluated the two runner-relevant surfaces. The verdict is over-determined; the auth
gate alone is dispositive, and three more axes fail independently.

### Surfaces considered

- **GitHub Copilot CLI** (`copilot`, GA Feb 2026) — a local agent with a shell,
  edit tools, MCP support, and `--model` selection. The only surface that even
  *looks* like a local driver, so this is where the evaluation went deep.
- **GitHub Copilot coding agent** — the async, cloud-hosted agent that runs on
  GitHub Actions and opens PRs. This is a **third-party runtime** (execution on
  GitHub's infra, not ours) and a server-side dispatch surface — excluded twice
  over: by CLAUDE.md's "no third-party runtime adapter" and by RUN-282's own
  out-of-scope line ("any dashboard or server-side work"). Not pursued further.

### Why the CLI cannot sit behind the seam

**1. Auth IS forge authority — the agent-half invariant cannot hold (dispositive).**
Copilot CLI resolves credentials in this order:
`COPILOT_GITHUB_TOKEN` → `GH_TOKEN` → `GITHUB_TOKEN` → OAuth token in the system
keychain (from `copilot login`) → `gh auth token`. Whichever wins, the child ends
up holding a **GitHub credential** — one that can `git push`, and that the CLI uses
to "create pull requests and manage issues" by design. That is exactly the authority
THREAT-MODEL invariant #1 forbids an agent to hold.

`sanitizedAgentEnv` is our only lever, and it does not reach far enough:
- It strips `GH_TOKEN` and `GITHUB_TOKEN` — but **not** `COPILOT_GITHUB_TOKEN`
  (a new name; a gap even for the env path), and env stripping does nothing about
  the keychain / `gh auth` fallbacks, which live on disk outside the environment.
- To deny the keychain path we would have to guarantee the box was never
  `copilot login`'d and has no `gh` auth — at which point the CLI **cannot
  authenticate and cannot run**.

So feasibility is binary: either the child can reach a forge credential (invariant
broken), or Copilot cannot start. This is precisely the case RUN-282's locked
decision anticipated: *"If a Copilot surface requires a GitHub token in the child
environment to function, that is a feasibility finding and very likely a NO."* The
contrast that makes Claude and Codex adaptable is that they carry **model-provider**
creds (Anthropic/OpenAI), which cannot push to a forge; Copilot's credential is the
forge itself. We would not weaken `sanitizedAgentEnv` to make this work — that is the
thing the invariant exists to prevent.

**2. Budget cannot be enforced.** The stable programmatic surface is
`copilot -p "<prompt>"` — run-to-exit, and it emits no token or USD telemetry.
`drivers/budget.ts` enforces ceilings by reading a live telemetry stream; with
nothing to read, a Copilot run could be bounded only by wall-clock, undercutting the
"runaway agent burns unbounded tokens/$$" defense. Codex reports tokens-without-cost
and that is already the weaker end of acceptable; Copilot `-p` reports neither.

**3. No honest capabilities on the stable surface.** `copilot -p` is one-shot: no
mid-run steer, no interrupt, no resumable local session (resume is a *cloud-sandbox*
feature, not the local CLI). A driver over it would have to declare
`steer:false, interrupt:false, resumableSession:false, perModelTelemetry:false,
toolHooks:false` — strictly weaker than Codex, and it degrades to exactly the
one-shot `claude -p` mode the Claude driver's own comment says it deliberately
avoids "so the session stays steerable."

**4. The structured surface was removed, and its replacement is unstable.** The
JSON-RPC-over-stdio interface (`--headless --stdio`, consumed by
`@github/copilot-sdk`) — the natural analogue of Codex's `app-server` — was removed
**without deprecation** in Feb 2026 (github/copilot-cli#1606) and now exits 1,
breaking every downstream integration. Its successor, `--acp --stdio` (Agent Client
Protocol), could in principle restore steer/interrupt/streaming, but (a) it is
new and churning — the codex driver already carries per-minor-release rename churn
(RUN-72), and Copilot has shown it will *remove* an interface with no notice — and
(b) none of it touches gate #1, which is dispositive on its own. Building on it now
would buy the maintenance burden the "if feasible" framing exists to refuse.

**5. Not reachable on the wire regardless.** `AgentTool` is
`z.enum(['claude', 'codex'])` in the vendored contract, and dispatch resolves
`drivers[tool as AgentTool]`. A `copilot` rung would require a
`vendor/noriq-shared` change, which lands **planar-first** and is explicitly out of
scope for this runner-local task — so even a working driver would be undispatchable
until the contract carries it. No coordinate rung or enum edit was made here for
that reason.

### What would change the answer

A local, spawn-and-supervise Copilot interface that (a) authenticates with a
credential that is **not** forge-push authority (a model-only entitlement token our
env-sanitization can withhold from the shell, or an MCP-style header injection), and
(b) exposes a steerable stream carrying token/cost telemetry — most plausibly a
stabilized `--acp --stdio`. Until (a) exists, no amount of protocol work matters:
the agent half of invariant #1 is absolute, and Copilot's credential is the forge.

## Sources (RUN-282 research, Aug 2026)

- GitHub Docs — Running Copilot CLI programmatically, About Copilot CLI,
  Authenticating / Troubleshooting Copilot CLI auth (credential resolution order).
- github/copilot-cli#1606 — `--headless --stdio` removed without deprecation;
  `@github/copilot-sdk` broken; `--acp --stdio` named as successor.
