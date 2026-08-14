import { scanRepositories } from "./repositories/scanner.js";
import type { RepositoryCheckout } from "./repositories/types.js";

/** @deprecated Import RepositoryCheckout from repositories/types instead. */
export type DiscoveredProject = Omit<
  RepositoryCheckout,
  "checkoutId" | "configDigest"
> & {
  checkoutId?: string;
  configDigest?: string;
};

export async function discoverProjects(
  scanRoots: string[],
  maxDepth = 6,
): Promise<RepositoryCheckout[]> {
  const result = await scanRepositories(scanRoots, maxDepth);
  const hardFailure = result.issues.find(
    (issue) => issue.code === "scan_failed",
  );
  if (hardFailure && result.checkouts.length === 0)
    throw new Error(
      `repository scan failed for ${hardFailure.root}: ${hardFailure.message}`,
    );
  return result.checkouts;
}
