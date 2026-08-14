import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveConfigPath(args: string[]): Promise<string> {
  const explicit = option(args, "--config") ?? process.env.NORIQ_RUNNER_CONFIG;
  if (explicit) return resolve(expandHome(explicit));
  const local = resolve("runner.toml");
  if (await exists(local)) return local;
  return join(homedir(), ".noriq", "runner.toml");
}

export function absolute(path: string): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}
