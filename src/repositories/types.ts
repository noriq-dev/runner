import type { ProjectConfig } from "../config.js";
import type { VcsKind } from "../vcs/detect.js";

export interface RepositoryCheckout {
  checkoutId: string;
  repository: string;
  vcs: VcsKind;
  vcsReason: string;
  configPath: string;
  config: ProjectConfig;
  configDigest: string;
}

export interface CatalogIssue {
  root: string;
  configPath: string | null;
  code: "scan_failed" | "invalid_config" | "duplicate_checkout";
  message: string;
}

export interface CatalogSnapshot {
  generation: number;
  digest: string;
  checkouts: readonly RepositoryCheckout[];
  issues: readonly CatalogIssue[];
  scannedAt: string;
  degraded: boolean;
}
