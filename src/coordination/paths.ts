import { posix } from "node:path";
import type { LeaseScope } from "./types.js";

export function normalizeLeasePaths(paths: readonly string[]): string[] {
  return [
    ...new Set(
      paths.map((path) => {
        const normalized = posix
          .normalize(path.replaceAll("\\", "/"))
          .replace(/^\.\//, "");
        if (
          !normalized ||
          normalized === "." ||
          normalized.startsWith("/") ||
          normalized === ".." ||
          normalized.startsWith("../")
        )
          throw new Error(`invalid coordination path: ${path}`);
        return normalized;
      }),
    ),
  ].sort();
}

function overlaps(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

export function leaseScopesConflict(
  left: LeaseScope,
  right: LeaseScope,
): boolean {
  if (left.repositoryKey !== right.repositoryKey || left.lane !== right.lane)
    return false;
  if (left.kind === "repository" || right.kind === "repository") return true;
  if (left.kind === "landing" || right.kind === "landing")
    return left.kind === "landing" && right.kind === "landing";
  return left.paths.some((leftPath) =>
    right.paths.some((rightPath) => overlaps(leftPath, rightPath)),
  );
}
