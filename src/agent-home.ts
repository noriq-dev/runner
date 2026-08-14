import { randomUUID } from "node:crypto";
import {
  chmod,
  constants,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

export type BuiltinAgentVendor = "codex" | "claude";

const credentialFiles: Readonly<Record<BuiltinAgentVendor, readonly string[]>> =
  {
    codex: ["auth.json"],
    claude: [".credentials.json", ".claude.json"],
  };

const maximumCredentialBytes = 1024 * 1024;

async function privateDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory())
    throw new Error(`agent home must be a non-symlink directory: ${path}`);
  if (process.platform !== "win32") await chmod(path, 0o700);
  return realpath(path);
}

async function copyCredential(
  source: string,
  destination: string,
): Promise<Buffer> {
  const pathMetadata = await lstat(source).catch((error) => {
    throw new Error(`agent credential is unavailable: ${source}`, {
      cause: error,
    });
  });
  if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile())
    throw new Error(
      `agent credential must be a non-symlink regular file: ${source}`,
    );
  if (pathMetadata.size < 1 || pathMetadata.size > maximumCredentialBytes)
    throw new Error(
      `agent credential must contain 1-${maximumCredentialBytes} bytes: ${source}`,
    );

  const sourceHandle = await open(
    source,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const descriptorMetadata = await sourceHandle.stat();
    if (
      !descriptorMetadata.isFile() ||
      descriptorMetadata.size !== pathMetadata.size
    )
      throw new Error(`agent credential changed while being copied: ${source}`);
    const bytes = await sourceHandle.readFile();
    if (bytes.length !== descriptorMetadata.size)
      throw new Error(`agent credential changed while being copied: ${source}`);
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") await chmod(destination, 0o600);
    return bytes;
  } finally {
    await sourceHandle.close();
  }
}

async function readCredential(path: string): Promise<Buffer> {
  const pathMetadata = await lstat(path);
  if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile())
    throw new Error(
      `agent credential must be a non-symlink regular file: ${path}`,
    );
  if (pathMetadata.size < 1 || pathMetadata.size > maximumCredentialBytes)
    throw new Error(
      `agent credential must contain 1-${maximumCredentialBytes} bytes: ${path}`,
    );
  const handle = await open(
    path,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const descriptorMetadata = await handle.stat();
    if (
      !descriptorMetadata.isFile() ||
      descriptorMetadata.size !== pathMetadata.size
    )
      throw new Error(`agent credential changed while being read: ${path}`);
    const bytes = await handle.readFile();
    if (bytes.length !== descriptorMetadata.size)
      throw new Error(`agent credential changed while being read: ${path}`);
    return bytes;
  } finally {
    await handle.close();
  }
}

function validRotatedClaudeCredential(bytes: Buffer): boolean {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    const oauth = value.claudeAiOauth;
    if (!oauth || typeof oauth !== "object" || Array.isArray(oauth))
      return false;
    const fields = oauth as Record<string, unknown>;
    return (
      typeof fields.accessToken === "string" &&
      fields.accessToken.length > 0 &&
      typeof fields.refreshToken === "string" &&
      fields.refreshToken.length > 0 &&
      typeof fields.expiresAt === "number" &&
      Number.isFinite(fields.expiresAt) &&
      fields.expiresAt > 0
    );
  } catch {
    return false;
  }
}

async function atomicReplaceCredential(
  destination: string,
  bytes: Buffer,
): Promise<void> {
  const temporary = `${destination}.noriq-${process.pid}-${randomUUID()}`;
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * A successful Claude refresh rotates both tokens inside the copied home. Copy
 * that valid state forward while the per-home lease is still held. Invalid or
 * emptied CLI output is discarded, and an already-changed durable credential
 * wins over the stale snapshot this invocation started from.
 */
async function persistRotatedClaudeCredential(
  durableHome: string,
  ephemeralHome: string,
  original: Buffer,
): Promise<void> {
  const filename = ".credentials.json";
  let candidate: Buffer;
  try {
    candidate = await readCredential(join(ephemeralHome, filename));
  } catch {
    return;
  }
  if (candidate.equals(original) || !validRotatedClaudeCredential(candidate))
    return;

  let durable: Buffer;
  try {
    durable = await readCredential(join(durableHome, filename));
  } catch {
    return;
  }
  if (!durable.equals(original)) return;
  await atomicReplaceCredential(join(durableHome, filename), candidate);
}

export interface EphemeralAgentHome {
  path: string;
  cleanup(): Promise<void>;
}

export interface EphemeralAgentHomeOptions {
  signal?: AbortSignal;
}

const claudeCredentialTails = new Map<string, Promise<void>>();

/**
 * Claude subscription-login credentials rotate during refresh. Two copied
 * homes refreshing the same source concurrently can invalidate one another,
 * so keep the complete copied-home lifetime exclusive per canonical source.
 */
async function acquireClaudeCredentialLease(
  source: string,
  signal?: AbortSignal,
): Promise<() => void> {
  if (signal?.aborted) throw signal.reason;
  const predecessor = claudeCredentialTails.get(source) ?? Promise.resolve();
  let resolveCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    resolveCurrent = resolve;
  });
  const tail = predecessor.then(() => current);
  claudeCredentialTails.set(source, tail);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    resolveCurrent();
    void tail.then(() => {
      if (claudeCredentialTails.get(source) === tail)
        claudeCredentialTails.delete(source);
    });
  };

  if (!signal) {
    await predecessor;
    return release;
  }
  let removeAbortListener = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => {
      // Resolving this queue node does not let a successor pass the still-live
      // predecessor: tail remains predecessor.then(() => current).
      release();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    await Promise.race([predecessor, aborted]);
    if (signal.aborted) {
      release();
      throw signal.reason;
    }
    return release;
  } catch (error) {
    release();
    throw error;
  } finally {
    removeAbortListener();
  }
}

/** Seed only the per-workspace trust/MCP choice Claude requires in print mode. */
export async function initializeClaudeProjectState(
  home: string,
  workspace: string,
  approveProjectMcp: boolean,
): Promise<void> {
  const project = await realpath(workspace);
  const statePath = join(home, ".claude.json");
  const existing = JSON.parse(await readFile(statePath, "utf8")) as Record<
    string,
    unknown
  >;
  await writeFile(
    statePath,
    JSON.stringify({
      ...existing,
      projects: {
        [project]: {
          allowedTools: [],
          mcpContextUris: [],
          mcpServers: {},
          enabledMcpjsonServers: approveProjectMcp
            ? [runnerControlProjectServer]
            : [],
          disabledMcpjsonServers: [],
          enableAllProjectMcpServers: approveProjectMcp,
          hasTrustDialogAccepted: true,
          projectOnboardingSeenCount: 1,
          hasClaudeMdExternalIncludesApproved: false,
          hasClaudeMdExternalIncludesWarningShown: false,
          hasUnseenTeamArtifacts: false,
        },
      },
    }),
    { flag: "w", mode: 0o600 },
  );
}

const runnerControlProjectServer = "noriq_runner";

/**
 * Create a fresh vendor home containing only the files required to authenticate
 * and initialize the CLI. Claude's copied state is stripped to the current
 * project by initializeClaudeProjectState. Jobs do not inherit durable MCP
 * choices, plugins, hooks, histories, or caches stored in other files.
 */
export async function createEphemeralAgentHome(
  vendor: BuiltinAgentVendor,
  durableHome: string,
  stateDirectory: string,
  options: EphemeralAgentHomeOptions = {},
): Promise<EphemeralAgentHome> {
  const source = await privateDirectory(durableHome);
  const releaseCredentialLease =
    vendor === "claude"
      ? await acquireClaudeCredentialLease(source, options.signal)
      : (): void => {};
  let path: string | undefined;
  let originalClaudeCredential: Buffer | undefined;
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try {
      if (path && originalClaudeCredential)
        await persistRotatedClaudeCredential(
          source,
          path,
          originalClaudeCredential,
        );
    } finally {
      try {
        if (path)
          await rm(path, { recursive: true, force: true, maxRetries: 3 });
      } finally {
        releaseCredentialLease();
      }
    }
  };
  try {
    const parent = await privateDirectory(join(stateDirectory, "agent-homes"));
    path = await mkdtemp(join(parent, `${vendor}-`));
    if (process.platform !== "win32") await chmod(path, 0o700);
    for (const filename of credentialFiles[vendor]) {
      const bytes = await copyCredential(
        join(source, filename),
        join(path, filename),
      );
      if (vendor === "claude" && filename === ".credentials.json")
        originalClaudeCredential = bytes;
    }
    if (!(await stat(path)).isDirectory())
      throw new Error(`ephemeral agent home disappeared: ${path}`);
    return { path, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
