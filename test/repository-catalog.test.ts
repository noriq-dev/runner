import { describe, expect, test, vi } from "vitest";
import type { ProjectConfig } from "../src/config.js";
import { RepositoryCatalogService } from "../src/repositories/catalog.js";
import type {
  CatalogIssue,
  RepositoryCheckout,
} from "../src/repositories/types.js";
import { runtimeCatalog } from "../src/runtime/daemon.js";
import type { SourceControlBackend } from "../src/vcs/types.js";

function checkout(configDigest = "config-a"): RepositoryCheckout {
  return {
    checkoutId: "repo_0123456789ab",
    repository: "/checkout",
    vcs: "git",
    vcsReason: "test",
    configPath: "/checkout/.noriq/project.toml",
    configDigest,
    config: {
      repositoryKey: "repository",
      sourceControl: { backend: "auto", base: "main", mode: "isolated" },
    } as ProjectConfig,
  };
}

const failure: CatalogIssue = {
  root: "/scan",
  configPath: null,
  code: "scan_failed",
  message: "temporary I/O failure",
};

describe("RepositoryCatalogService", () => {
  test("retains the acknowledged inventory across transient scan failures", async () => {
    const scans = [
      { checkouts: [checkout()], issues: [] },
      { checkouts: [], issues: [failure] },
      { checkouts: [], issues: [] },
    ];
    const onScan = vi.fn();
    const service = new RepositoryCatalogService({
      scanRoots: ["/scan"],
      scan: vi.fn(async () => scans.shift()!),
    });
    service.onScan = onScan;

    const initial = await service.refresh();
    const degraded = await service.refresh();
    const removed = await service.refresh();

    expect(initial.generation).toBe(1);
    expect(degraded.checkouts).toHaveLength(1);
    expect(degraded.degraded).toBe(true);
    expect(degraded.generation).toBe(1);
    expect(removed.checkouts).toEqual([]);
    expect(removed.generation).toBe(2);
    expect(onScan).toHaveBeenCalledTimes(3);
  });

  test("changes the wire digest when the live base revision moves", async () => {
    let revision = "a".repeat(40);
    const backend = {
      id: "git",
      kind: "git",
      capabilities: { isolatedMode: true, directMode: true },
      revisionOf: vi.fn(async () => revision),
    } as unknown as SourceControlBackend;
    const snapshot = {
      generation: 1,
      digest: "inventory",
      checkouts: [checkout()],
      issues: [],
      scannedAt: new Date().toISOString(),
      degraded: false,
    };

    const first = await runtimeCatalog(snapshot, { git: backend });
    revision = "b".repeat(40);
    const second = await runtimeCatalog(snapshot, { git: backend });

    expect(first.catalog.digest).not.toBe(second.catalog.digest);
    expect(second.repositories[0]?.baseRevision).toBe(revision);
  });
});
