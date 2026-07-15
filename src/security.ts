// Security hardening for the "autonomous agent with a shell on a user machine"
// surface (RUN-24). The load-bearing defenses live elsewhere — per-kind permission
// profiles (drivers/claude mapPermission, drivers/codex mapSandbox), one throwaway
// worktree per Run with scope read-only (worktree.ts), daemon-enforced budgets
// (drivers/budget), and output landing as a review diff a human merges (no push).
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
