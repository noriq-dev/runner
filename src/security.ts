import type { RunKind } from '@noriq-dev/shared';

// Security hardening for the "autonomous agent with a shell on a user machine"
// surface (RUN-24). The load-bearing defenses live elsewhere — per-kind permission
// profiles (drivers/claude mapPermission, drivers/codex mapSandbox), one throwaway
// worktree per Run with scope read-only (worktree.ts), daemon-enforced budgets
// (drivers/budget), and output landing as a review diff a human merges. Note the daemon
// may push the working branch when a repo opts in (RUN-27) — the agent never can, which
// is this module's job: the credential is absent from the child env, not merely unused.
// This module hardens the PROCESS ENVIRONMENT the spawned agent inherits.

// Env vars that must never reach the agent's shell — the agent reaches Noriq via
// its MCP connection (credential injected at the transport, not the shell), so the
// raw token has no business in the environment where `bash` can read it.
const STRIPPED_ENV = [
  'NORIQ_TOKEN', // the daemon's OAuth token — MCP supplies Noriq access, not the shell
  'NORIQ_MCP_TOKEN', // see agentEnvWithMcpToken: only the codex driver may re-add this
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITLAB_TOKEN',
  'NPM_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
];

/** The env var codex reads its MCP bearer token from (`bearer_token_env_var`). */
export const CODEX_MCP_TOKEN_ENV = 'NORIQ_MCP_TOKEN';

/**
 * Build the environment a spawned agent process runs under. Strips known secrets
 * and neutralizes git's ability to push or prompt for credentials — so even if a
 * build agent runs `git push` inside its allowlist, it has no credentials and no
 * way to acquire them. Model/git creds stay on the box; only the Noriq OAuth token
 * crosses the wire (over MCP), never into the agent's shell.
 */
export function sanitizedAgentEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of STRIPPED_ENV) delete env[key];

  // No interactive credential prompt, no askpass fallback.
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ASKPASS = '/bin/false';
  env.SSH_ASKPASS = '/bin/false';
  // Disable any configured credential helper for this process via git's env-config
  // channel (GIT_CONFIG_* overrides ~/.gitconfig for the child only).
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = 'credential.helper';
  env.GIT_CONFIG_VALUE_0 = '';
  return env;
}

/**
 * Why codex re-adds ONE token to the sanitized env, deliberately (the exception the codex driver
 * makes on top of `sanitizedAgentEnv`).
 *
 * This bends the rule above and it is worth being honest about why. The Claude driver puts
 * the credential on the MCP transport's Authorization header, so it never touches the shell.
 * Codex offers no such option: `codex mcp add` exposes only `--bearer-token-env-var`, so a
 * streamable-HTTP MCP server's token is read from the process environment or codex cannot
 * authenticate at all. There is no third choice short of a local proxy.
 *
 * What makes the trade acceptable is WHICH token this is (RUN-43). It is minted per Run,
 * bound to exactly one agent in one project, and revoked by the server the moment the Run
 * goes terminal — so a build agent that reads it out of its own env gains the ability to act
 * as itself, in the project it is already working, until its run ends. Before this, codex got
 * no MCP config at all: every codex agent was anonymous and could not report its work, which
 * is a worse failure and a silent one. The alternative — passing the DAEMON's token, which
 * can register runners and reach every project its human can — is the thing this replaces.
 *
 * Since RUN-109 the codex driver composes `{ ...opts.env, [CODEX_MCP_TOKEN_ENV]: token }` on the
 * supervisor-sanitized base rather than re-sanitizing here. If codex ever grows header support,
 * drop the re-add entirely.
 */

/**
 * Reaching a human — available to EVERY kind (RUN-32).
 *
 * Deliberately outside the per-kind curation below, because it is not the same sort of thing.
 * The rest of that list rations *authority* (who may claim work, who may mint a plan); this
 * rations nothing. Notifying a human is the cheapest action an agent can take, it is exactly
 * what we want an uncertain agent to do, and withholding it pushes agents toward guessing —
 * the one behaviour the whole security model exists to prevent. An agent with a permission
 * question and no way to ask does not stop; it decides.
 *
 * - raise_alert    — "this looks wrong and a human should know" (non-blocking; keep working)
 * - request_input  — "I need a decision to continue" → the entry point for RUN-30's park/resume
 */
const REACH_A_HUMAN = ['raise_alert', 'request_input'];

/**
 * Staying alive — also every kind (RUN-47's "also"). Every Noriq call renews a claim, so
 * heartbeat looks redundant; but a build agent that works 40 minutes without touching Noriq
 * loses its claim and nothing tells it. Denying the one tool whose whole job is "I am still
 * here" rations nothing and creates exactly that silent expiry.
 */
const STAY_ALIVE = ['heartbeat'];

/**
 * The Noriq tools each kind may call, curated to its job — the per-kind floor extended to
 * Noriq itself, not just the filesystem. A scope agent can propose a plan but not claim work;
 * a build agent can claim/report but not mint plans; verify can read and comment but never
 * mutate — that last one is the point of the adversarial gate: the reviewer must not be able
 * to MOVE the work it is judging.
 *
 * This lives HERE and not in a driver (RUN-46), because it is a policy about what a run kind
 * may reach, and the first year it lived in drivers/claude.ts it was quietly a property of one
 * driver: the same verify run on codex had all 28 tools, claim_task included. Each driver
 * translates these names into its own enforcement (Claude: the dontAsk allowlist; Codex: the
 * MCP server's enabled_tools) — neither driver decides the list.
 *
 * Since RUN-47 this list is also what the agent SEES: the daemon declares it at run-agent
 * creation and the server advertises exactly these tools over MCP, so the catalogue and the
 * allowlist are two views of one policy instead of two policies that disagree. That raises
 * the stakes of an omission — before, a missing tool was advertised-then-denied (a wasted
 * turn); now it does not exist for the agent at all. Which is why verify has get_briefing:
 * the server's own contract opens with "call get_briefing first", and a read that orients
 * the reviewer mutates nothing.
 */
const NORIQ_TOOLS: Record<RunKind, string[]> = {
  // Scope can TEND the plan it mints, not just mint it (RUN-69): update_plan is what the
  // server's own playbook instructs, and the dependency pair prunes the artifact edges that
  // enforced phase ordering creates — a live scope run had to raise_alert and hand a human
  // five edges to cut because this floor said no. Safe because the RUN-23 gate still holds:
  // plans arrive PROPOSED and a human approves them after the tidying. Still excluded, on
  // purpose: create_task/decompose_task (mint claimable work outside the proposed-plan gate)
  // and claim/release (scope plans, never executes).
  scope: [
    'set_agent_identity',
    'get_briefing',
    'get_task',
    'get_plans',
    'create_plan',
    'update_plan',
    'add_dependency',
    'remove_dependency',
  ],
  // No release_task (RUN-83): a build agent claims its anchor task (→ in_progress) and works,
  // but it does NOT move the task onward — the RUN's terminal outcome does, server-side. The
  // agent used to call release_task(review) when it finished, which happened BEFORE the daemon's
  // verify/reviewer gate ran; a gate FAILURE then left the task stranded in `review`,
  // indistinguishable from work genuinely awaiting a human. Now the task stays in_progress
  // through the gate and transitionRun sets it: gate passed → review, gate failed → failed.
  build: [
    'set_agent_identity',
    'get_briefing',
    'get_task',
    'claim_task',
    'post_comment',
    'read_open_comments',
    'resolve_comment',
    'attach_ref',
    'update_task',
  ],
  verify: [
    'set_agent_identity',
    'get_briefing',
    'get_task',
    'get_plans',
    'post_comment',
    'read_open_comments',
  ],
};

/** The BARE Noriq tool names a kind may call — its curated job, the ability to reach a human,
 *  and the ability to stay alive. Drivers add their own prefixes/config shape, and the daemon
 *  declares this same list to the server at run-agent creation (RUN-47); the policy is
 *  driver-neutral. */
export const noriqToolNamesFor = (kind: RunKind): string[] => [
  ...new Set([...(NORIQ_TOOLS[kind] ?? []), ...REACH_A_HUMAN, ...STAY_ALIVE]),
];
