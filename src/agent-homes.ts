import { type ChildProcess, spawn } from 'node:child_process';
import {
  constants,
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

export type AgentHomeVendor = 'codex' | 'claude';

/**
 * Authentication is the only durable vendor state a mission attempt may inherit. Configuration,
 * plugins, hooks, skills, MCP declarations, histories, and caches must start empty on every
 * attempt. Keep this list exact and deliberately boring.
 */
export const AGENT_HOME_CREDENTIAL_FILES: Readonly<Record<AgentHomeVendor, readonly string[]>> =
  Object.freeze({
    codex: Object.freeze(['auth.json']),
    claude: Object.freeze(['.credentials.json']),
  });

const MAX_AGENT_CREDENTIAL_BYTES = 1024 * 1024;

export interface EphemeralAgentHome {
  /** Unique vendor-control home exposed only through a commissioned credential boundary. */
  readonly home: string;
  /** Idempotent deletion of this exact home. Call only after process-tree exit is acknowledged. */
  cleanup(): void;
}

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

function readCredentialWithoutFollowingSymlinks(source: string): Buffer {
  let pathMetadata: ReturnType<typeof lstatSync>;
  try {
    pathMetadata = lstatSync(source);
  } catch (error) {
    throw new Error(`Runner agent credential is unavailable or unsafe: ${source}`, { cause: error });
  }
  if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()) {
    throw new Error(`Runner agent credential must be a non-symlink regular file: ${source}`);
  }
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  let descriptor: number;
  try {
    descriptor = openSync(source, constants.O_RDONLY | noFollow);
  } catch (error) {
    throw new Error(`Runner agent credential is unavailable or unsafe: ${source}`, { cause: error });
  }
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) {
      throw new Error(`Runner agent credential must be a regular file: ${source}`);
    }
    if (metadata.size < 1 || metadata.size > MAX_AGENT_CREDENTIAL_BYTES) {
      throw new Error(
        `Runner agent credential must contain 1-${MAX_AGENT_CREDENTIAL_BYTES} bytes: ${source}`,
      );
    }
    const bytes = readFileSync(descriptor);
    if (bytes.length < 1 || bytes.length > MAX_AGENT_CREDENTIAL_BYTES) {
      throw new Error(
        `Runner agent credential must contain 1-${MAX_AGENT_CREDENTIAL_BYTES} bytes: ${source}`,
      );
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Materialize a fresh, credential-only vendor-control home for one contained mission attempt.
 *
 * The durable Runner vendor home is read by the trusted daemon only; it is never returned as a
 * mount. A commissioned provider exposes it to the vendor controller while hiding it from every
 * model-selected descendant; an ordinary private mount is not sufficient. The vendor controller
 * can freely write its ephemeral home without persisting authority or configuration into another
 * attempt. Callers own the returned cleanup boundary and must wait for their complete containment
 * process tree to exit before invoking it.
 */
export function createEphemeralAgentHome(
  vendor: AgentHomeVendor,
  durableHome: string,
  temporaryRoot = os.tmpdir(),
): EphemeralAgentHome {
  if (!path.isAbsolute(durableHome) || !path.isAbsolute(temporaryRoot)) {
    throw new Error('Runner agent home paths must be absolute');
  }
  ensurePrivateAgentHome(durableHome);
  const canonicalDurableHome = realpathSync(durableHome);
  const canonicalTemporaryRoot = realpathSync(temporaryRoot);
  if (!lstatSync(canonicalTemporaryRoot).isDirectory()) {
    throw new Error(`Runner agent temporary root is not a directory: ${temporaryRoot}`);
  }
  const home = mkdtempSync(path.join(canonicalTemporaryRoot, `noriq-${vendor}-attempt-`));
  if (process.platform !== 'win32') chmodSync(home, 0o700);

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
    cleaned = true;
  };

  try {
    for (const filename of AGENT_HOME_CREDENTIAL_FILES[vendor]) {
      const source = path.join(canonicalDurableHome, filename);
      const bytes = readCredentialWithoutFollowingSymlinks(source);
      writeFileSync(path.join(home, filename), bytes, { flag: 'wx', mode: 0o600 });
    }
    return Object.freeze({ home, cleanup });
  } catch (error) {
    cleanup();
    throw error;
  }
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
