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
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITLAB_TOKEN',
  'NPM_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
];

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
