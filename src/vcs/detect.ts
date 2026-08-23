import { access, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MachineConfig, ProjectConfig } from "../config.js";
import { withGitExecutable } from "../git.js";
import { DiversionSourceControlBackend } from "./diversion.js";
import { GitSourceControlBackend } from "./git.js";
import { PerforceSourceControlBackend } from "./perforce.js";
import type { SourceControlBackend } from "./types.js";

export type VcsKind = "git" | "diversion" | "perforce";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function detectRepository(path: string): Promise<{
  root: string;
  kind: VcsKind;
  reason: string;
}> {
  let candidate = await realpath(path);
  for (;;) {
    if (await exists(join(candidate, ".git")))
      return {
        root: candidate,
        kind: "git",
        reason: ".git at repository root",
      };
    if (await exists(join(candidate, ".p4config")))
      return {
        root: candidate,
        kind: "perforce",
        reason: ".p4config at workspace root",
      };
    if (await exists(join(candidate, ".diversion")))
      return {
        root: candidate,
        kind: "diversion",
        reason: ".diversion at workspace root",
      };
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error(`no supported source-control workspace contains ${path}`);
}

export function createBackendRegistry(
  config: MachineConfig,
): Record<string, SourceControlBackend> {
  return Object.fromEntries(
    Object.entries(config.backends).map(([id, backend]) => {
      if (backend.adapter === "git")
        return [
          id,
          new Proxy(new GitSourceControlBackend(id), {
            get(target, property, receiver) {
              const value = Reflect.get(target, property, receiver) as unknown;
              if (typeof value !== "function") return value;
              return (...args: unknown[]) =>
                withGitExecutable(
                  backend.command,
                  () => Reflect.apply(value, target, args) as Promise<unknown>,
                );
            },
          }),
        ];
      if (backend.adapter === "diversion")
        return [
          id,
          new DiversionSourceControlBackend(
            id,
            backend.command,
            undefined,
            backend.workspaces,
          ),
        ];
      return [id, new PerforceSourceControlBackend(id, backend.command)];
    }),
  );
}

export function selectBackend(
  registry: Record<string, SourceControlBackend>,
  project: ProjectConfig,
  detectedKind: VcsKind,
): SourceControlBackend {
  const configured = project.sourceControl.backend;
  const candidate =
    configured === "auto"
      ? Object.values(registry).find((backend) => backend.kind === detectedKind)
      : registry[configured];
  if (!candidate)
    throw new Error(
      configured === "auto"
        ? `no registered backend can handle detected ${detectedKind} source control`
        : `source-control backend ${configured} is not registered on this machine`,
    );
  if (candidate.kind !== detectedKind)
    throw new Error(
      `source-control backend ${candidate.id} handles ${candidate.kind}, but the project is ${detectedKind}`,
    );
  if (
    (project.sourceControl.mode === "isolated" &&
      !candidate.capabilities.isolatedMode) ||
    (project.sourceControl.mode === "direct" &&
      !candidate.capabilities.directMode)
  )
    throw new Error(
      `${candidate.id} does not support ${project.sourceControl.mode} mode`,
    );
  return candidate;
}
