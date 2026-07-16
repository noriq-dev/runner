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
 * sanitizedAgentEnv + the one Noriq token codex needs, in the env, deliberately.
 *
 * This bends the rule above and it is worth being honest about why. The Claude driver puts
 * the credential on the MCP transport's Authorization header, so it never touches the shell.
 * Codex offers no such option: `codex mcp add` exposes only `--bearer-token-env-var`, so a
 * streamable-HTTP MCP server's token is read from the process environment or codex cannot
 * authenticate at all. There is no third choice short of a local proxy.
 *
 * What makes the trade acceptable is WHICH token this now is (RUN-43). It is minted per Run,
 * bound to exactly one agent in one project, and revoked by the server the moment the Run
 * goes terminal — so a build agent that reads it out of its own env gains the ability to act
 * as itself, in the project it is already working, until its run ends. Before this, codex got
 * no MCP config at all: every codex agent was anonymous and could not report its work, which
 * is a worse failure and a silent one. The alternative — passing the DAEMON's token, which
 * can register runners and reach every project its human can — is the thing this replaces.
 *
 * If codex ever grows header support, delete this and use it.
 */
export function agentEnvWithMcpToken(
  token: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...sanitizedAgentEnv(base), [CODEX_MCP_TOKEN_ENV]: token };
}

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
 */
const NORIQ_TOOLS: Record<RunKind, string[]> = {
  scope: ['set_agent_identity', 'get_briefing', 'get_task', 'get_plans', 'create_plan'],
  build: [
    'set_agent_identity',
    'get_briefing',
    'get_task',
    'claim_task',
    'release_task',
    'post_comment',
    'read_open_comments',
    'resolve_comment',
    'attach_ref',
    'update_task',
  ],
  verify: ['set_agent_identity', 'get_task', 'get_plans', 'post_comment', 'read_open_comments'],
};

/** The BARE Noriq tool names a kind may call — its curated job plus the ability to reach a
 *  human. Drivers add their own prefixes/config shape; the policy is driver-neutral. */
export const noriqToolNamesFor = (kind: RunKind): string[] => [
  ...new Set([...(NORIQ_TOOLS[kind] ?? []), ...REACH_A_HUMAN]),
];
