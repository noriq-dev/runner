import { type ChildProcess, spawn } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Vendor CLIs are user-configured applications, but a Runner child is not the user's interactive
 * session. Giving both processes the same home silently imports personal MCP servers, plugins,
 * hooks, credentials, and session state into an unattended run. These homes are deliberately
 * under Noriq's own state directory: still user-owned and configurable, but scoped to Runner.
 */
export const DEFAULT_CODEX_HOME = path.join(os.homedir(), '.noriq', 'codex');
export const DEFAULT_CLAUDE_HOME = path.join(os.homedir(), '.noriq', 'claude');

/** Create a credential-bearing agent home privately, and reject the direct symlink escape hatch. */
export function ensurePrivateAgentHome(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const stat = lstatSync(home);
  if (stat.isSymbolicLink()) {
    throw new Error(`Runner agent home must not be a symlink: ${home}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Runner agent home is not a directory: ${home}`);
  }
  // Apply it to an existing directory too: a home that may contain model credentials must not
  // keep an accidentally broad creation mode. Windows has no POSIX mode bits; its ACL belongs to
  // the user profile that owns ~/.noriq, and chmod may reject there rather than tightening it.
  if (process.platform !== 'win32') chmodSync(home, 0o700);
}

export type InteractiveSpawn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: 'inherit' },
) => Pick<ChildProcess, 'once'>;

export interface CodexLoginOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: InteractiveSpawn;
}

export interface ClaudeLoginOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: InteractiveSpawn;
}

async function waitForLogin(child: Pick<ChildProcess, 'once'>, tool: 'codex' | 'claude'): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once('error', (err: Error) => reject(new Error(`could not start ${tool} login: ${err.message}`)));
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) resolve();
      else reject(new Error(`${tool} login failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
    });
  });
}

/** Authenticate the Codex CLI inside Runner's isolated home, never the interactive global home. */
export async function loginCodex(options: CodexLoginOptions = {}): Promise<void> {
  const home = options.home ?? DEFAULT_CODEX_HOME;
  ensurePrivateAgentHome(home);
  const child = (options.spawnFn ?? (spawn as InteractiveSpawn))('codex', ['login'], {
    env: { ...(options.env ?? process.env), CODEX_HOME: home },
    stdio: 'inherit',
  });
  await waitForLogin(child, 'codex');
}

/** Authenticate Claude inside Runner's isolated home, never the interactive global home. */
export async function loginClaude(options: ClaudeLoginOptions = {}): Promise<void> {
  const home = options.home ?? DEFAULT_CLAUDE_HOME;
  ensurePrivateAgentHome(home);
  const child = (options.spawnFn ?? (spawn as InteractiveSpawn))('claude', ['auth', 'login'], {
    env: { ...(options.env ?? process.env), CLAUDE_CONFIG_DIR: home },
    stdio: 'inherit',
  });
  await waitForLogin(child, 'claude');
}
