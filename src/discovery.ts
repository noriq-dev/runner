import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadProjectConfig, type ProjectConfig } from "./config.js";
import { discoverRepository } from "./git.js";

export interface DiscoveredProject {
  repository: string;
  configPath: string;
  config: ProjectConfig;
}

async function candidates(root: string): Promise<string[]> {
  const paths: string[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    for (const name of ["project.toml", join(".noriq", "project.toml")]) {
      const path = join(directory, name);
      try {
        if ((await stat(path)).isFile()) paths.push(path);
      } catch {}
    }
    if (paths.some((path) => path.startsWith(`${directory}/`))) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        entry.name === ".git" ||
        entry.name === "node_modules" ||
        entry.name.startsWith(".")
      )
        continue;
      await walk(join(directory, entry.name), depth + 1);
    }
  };
  await walk(await realpath(root), 0);
  return paths;
}

export async function discoverProjects(
  scanRoots: string[],
): Promise<DiscoveredProject[]> {
  const projects = new Map<string, DiscoveredProject>();
  for (const root of scanRoots) {
    for (const configPath of await candidates(root)) {
      const repository = await discoverRepository(dirname(configPath));
      const config = await loadProjectConfig(configPath);
      const prior = projects.get(config.repositoryKey);
      if (prior && prior.repository !== repository)
        throw new Error(
          `repositoryKey ${config.repositoryKey} is duplicated by ${prior.repository} and ${repository}`,
        );
      projects.set(config.repositoryKey, { repository, configPath, config });
    }
  }
  return [...projects.values()];
}
