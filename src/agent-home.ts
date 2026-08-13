import {
  chmod,
  constants,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

export type BuiltinAgentVendor = "codex" | "claude";

const credentialFiles: Readonly<Record<BuiltinAgentVendor, readonly string[]>> =
  {
    codex: ["auth.json"],
    claude: [".credentials.json"],
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
): Promise<void> {
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
  } finally {
    await sourceHandle.close();
  }
}

export interface EphemeralAgentHome {
  path: string;
  cleanup(): Promise<void>;
}

/** Seed only the per-workspace trust/MCP choice Claude requires in print mode. */
export async function initializeClaudeProjectState(
  home: string,
  workspace: string,
  approveProjectMcp: boolean,
): Promise<void> {
  const project = await realpath(workspace);
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({
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
    { flag: "wx", mode: 0o600 },
  );
}

const runnerControlProjectServer = "noriq_runner";

/**
 * Create a fresh vendor home containing authentication only. Unattended jobs do
 * not inherit interactive MCPs, plugins, hooks, histories, or project choices.
 */
export async function createEphemeralAgentHome(
  vendor: BuiltinAgentVendor,
  durableHome: string,
  stateDirectory: string,
): Promise<EphemeralAgentHome> {
  const source = await privateDirectory(durableHome);
  const parent = await privateDirectory(join(stateDirectory, "agent-homes"));
  const path = await mkdtemp(join(parent, `${vendor}-`));
  if (process.platform !== "win32") await chmod(path, 0o700);
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await rm(path, { recursive: true, force: true, maxRetries: 3 });
  };
  try {
    for (const filename of credentialFiles[vendor])
      await copyCredential(join(source, filename), join(path, filename));
    if (!(await stat(path)).isDirectory())
      throw new Error(`ephemeral agent home disappeared: ${path}`);
    return { path, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
