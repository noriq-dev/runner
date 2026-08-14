import { chmod, lstat, mkdir, realpath } from "node:fs/promises";

/**
 * Resolve one persistent Runner-owned vendor home.
 *
 * The configured home is the isolation boundary from the operator's personal
 * vendor configuration. Individual invocations share it just as normal vendor
 * CLI sessions share their user home; their repository worktrees and process
 * session flags provide per-job isolation.
 */
export async function prepareAgentHome(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory())
    throw new Error(`agent home must be a non-symlink directory: ${path}`);
  if (process.platform !== "win32") await chmod(path, 0o700);
  return realpath(path);
}
