import { stableDigest } from "./identity.js";
import { reloadCheckout, scanRepositories } from "./scanner.js";
import type { CatalogSnapshot, RepositoryCheckout } from "./types.js";

export class RepositoryCatalogService {
  private current: CatalogSnapshot = {
    generation: 0,
    digest: stableDigest([]),
    checkouts: [],
    issues: [],
    scannedAt: new Date(0).toISOString(),
    degraded: false,
  };
  private timer: NodeJS.Timeout | null = null;
  private refreshing: Promise<CatalogSnapshot> | null = null;
  private readonly sighup = () => this.triggerRefresh();
  onChange?: (snapshot: CatalogSnapshot) => void | Promise<void>;
  onScan?: (snapshot: CatalogSnapshot) => void | Promise<void>;
  onError?: (error: unknown) => void;

  constructor(
    private readonly options: {
      scanRoots: string[];
      maxDepth?: number;
      intervalSeconds?: number;
      scan?: typeof scanRepositories;
    },
  ) {}

  snapshot(): CatalogSnapshot {
    return this.current;
  }

  async refresh(): Promise<CatalogSnapshot> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<CatalogSnapshot> {
    const result = await (this.options.scan ?? scanRepositories)(
      this.options.scanRoots,
      this.options.maxDepth ?? 6,
    );
    const scanFailed = result.issues.some(
      (issue) => issue.code === "scan_failed",
    );
    const checkouts = scanFailed
      ? [...this.current.checkouts]
      : result.checkouts;
    const digest = stableDigest(
      checkouts.map((checkout) => ({
        checkoutId: checkout.checkoutId,
        repositoryKey: checkout.config.repositoryKey,
        configDigest: checkout.configDigest,
        repository: checkout.repository,
        vcs: checkout.vcs,
      })),
    );
    const changed =
      this.current.generation === 0 || digest !== this.current.digest;
    this.current = {
      generation: changed
        ? this.current.generation + 1
        : this.current.generation,
      digest,
      checkouts,
      issues: result.issues,
      scannedAt: new Date().toISOString(),
      degraded: result.issues.length > 0,
    };
    if (changed) await this.onChange?.(this.current);
    await this.onScan?.(this.current);
    return this.current;
  }

  private triggerRefresh(): void {
    void this.refresh().catch((error) => this.onError?.(error));
  }

  async admit(checkoutId: string): Promise<RepositoryCheckout> {
    const advertised = this.current.checkouts.find(
      (entry) => entry.checkoutId === checkoutId,
    );
    if (!advertised)
      throw new Error(
        `checkout ${checkoutId} is not in the acknowledged catalog`,
      );
    const reloaded = await reloadCheckout(advertised);
    if (reloaded.configDigest !== advertised.configDigest) {
      void this.refresh();
      throw new Error(
        `checkout ${checkoutId} configuration changed and awaits catalog acknowledgement`,
      );
    }
    return reloaded;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => this.triggerRefresh(),
      (this.options.intervalSeconds ?? 60) * 1_000,
    );
    this.timer.unref();
    if (process.platform !== "win32") process.on("SIGHUP", this.sighup);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (process.platform !== "win32") process.off("SIGHUP", this.sighup);
  }
}
