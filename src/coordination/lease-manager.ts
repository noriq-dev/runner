import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeLeasePaths } from "./paths.js";
import type {
  CoordinationLease,
  CoordinationProvider,
  LeaseIdentity,
  LeaseScope,
} from "./types.js";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("coordination wait cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export class DurableLeaseManager {
  private lease: CoordinationLease | null = null;
  private renewTimer: NodeJS.Timeout | null = null;
  private renewal: Promise<void> | null = null;

  constructor(
    private readonly provider: CoordinationProvider,
    private readonly options: {
      stateDirectory: string;
      identity: LeaseIdentity;
      ttlSeconds?: number;
      renewSeconds?: number;
      onWaiting?: (attempt: number, delayMs: number) => void | Promise<void>;
      onAcquired?: (lease: CoordinationLease) => void | Promise<void>;
      onLost?: (error: unknown) => void | Promise<void>;
    },
  ) {}

  private get path(): string {
    const landingSuffix = this.options.identity.landingRequestId
      ? `-landing-${createHash("sha256")
          .update(this.options.identity.landingRequestId)
          .digest("hex")
          .slice(0, 16)}`
      : "";
    return join(
      this.options.stateDirectory,
      "coordination",
      `${this.options.identity.jobId}-${this.options.identity.taskId ?? "job"}${landingSuffix}.json`,
    );
  }

  current(): CoordinationLease | null {
    return this.lease;
  }

  async acquire(
    scope: LeaseScope,
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<CoordinationLease> {
    const normalized = {
      ...scope,
      paths: scope.kind === "paths" ? normalizeLeasePaths(scope.paths) : [],
    };
    if (normalized.kind === "paths" && normalized.paths.length === 0)
      throw new Error("path lease requires at least one path");
    let attempt = 0;
    for (;;) {
      if (signal?.aborted)
        throw signal.reason ?? new Error("coordination wait cancelled");
      const result = await this.provider.acquire({
        ...this.options.identity,
        ...normalized,
        ttlSeconds: this.options.ttlSeconds ?? 90,
        ...(this.lease
          ? { previousFencingToken: this.lease.fencingToken }
          : {}),
      });
      if (result.status === "acquired") {
        await this.accept(result.lease);
        return result.lease;
      }
      const delay = Math.min(
        30_000,
        Math.max(result.retryAfterMs, 2_000 * 2 ** Math.min(attempt, 4)),
      );
      if (deadlineAt && Date.now() + delay >= deadlineAt)
        throw new Error("coordination lease deadline exceeded while waiting");
      await this.options.onWaiting?.(attempt, delay);
      attempt += 1;
      await sleep(delay, signal);
    }
  }

  async exchange(
    scope: LeaseScope,
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<CoordinationLease> {
    if (!this.lease)
      throw new Error("cannot exchange an unowned coordination lease");
    const normalized = {
      ...scope,
      paths: scope.kind === "paths" ? normalizeLeasePaths(scope.paths) : [],
    };
    let attempt = 0;
    for (;;) {
      if (signal?.aborted)
        throw signal.reason ?? new Error("coordination wait cancelled");
      const result = await this.provider.exchange({
        lease: this.lease,
        scope: normalized,
        ttlSeconds: this.options.ttlSeconds ?? 90,
      });
      if (result.status === "acquired") {
        await this.accept(result.lease);
        return result.lease;
      }
      const delay = Math.min(
        30_000,
        Math.max(result.retryAfterMs, 2_000 * 2 ** Math.min(attempt, 4)),
      );
      if (deadlineAt && Date.now() + delay >= deadlineAt)
        throw new Error(
          "coordination lease deadline exceeded while exchanging",
        );
      await this.options.onWaiting?.(attempt, delay);
      attempt += 1;
      await sleep(delay, signal);
    }
  }

  async recover(): Promise<CoordinationLease | null> {
    let saved: CoordinationLease;
    try {
      saved = JSON.parse(
        await readFile(this.path, "utf8"),
      ) as CoordinationLease;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const result = await this.provider.recover(
      saved,
      this.options.ttlSeconds ?? 90,
    );
    if (result.status !== "acquired") return null;
    await this.accept(result.lease);
    return result.lease;
  }

  async release(): Promise<void> {
    const lease = this.lease;
    this.stopRenewal();
    this.lease = null;
    if (lease) await this.provider.release(lease);
    await unlink(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private async accept(lease: CoordinationLease): Promise<void> {
    if (this.lease && lease.fencingToken < this.lease.fencingToken)
      throw new Error(
        "coordination provider returned a decreasing fencing token",
      );
    const changed =
      !this.lease ||
      lease.fencingToken !== this.lease.fencingToken ||
      lease.kind !== this.lease.kind ||
      JSON.stringify(lease.paths) !== JSON.stringify(this.lease.paths);
    this.lease = lease;
    await this.persist(lease);
    this.startRenewal();
    if (changed) await this.options.onAcquired?.(lease);
  }

  private startRenewal(): void {
    this.stopRenewal();
    this.renewTimer = setInterval(
      () => {
        if (this.renewal || !this.lease) return;
        const current = this.lease;
        this.renewal = this.renewOrRecover(current)
          .then(() => undefined)
          .finally(() => {
            this.renewal = null;
          });
      },
      (this.options.renewSeconds ?? 30) * 1_000,
    );
    this.renewTimer.unref();
  }

  private async renewOrRecover(current: CoordinationLease): Promise<void> {
    try {
      await this.accept(
        await this.provider.renew(current, this.options.ttlSeconds ?? 90),
      );
      return;
    } catch (renewError) {
      const safetyDeadline = Date.parse(current.expiresAt) - 10_000;
      let lastError: unknown = renewError;
      while (Date.now() < safetyDeadline) {
        await sleep(Math.min(2_000, Math.max(1, safetyDeadline - Date.now())));
        try {
          const recovered = await this.provider.recover(
            current,
            this.options.ttlSeconds ?? 90,
          );
          if (recovered.status === "acquired") {
            await this.accept(recovered.lease);
            return;
          }
          lastError = new Error(
            `coordination recovery conflicts with ${recovered.conflictingKind}`,
          );
        } catch (error) {
          lastError = error;
        }
      }
      this.stopRenewal();
      await this.options.onLost?.(lastError);
    }
  }

  private stopRenewal(): void {
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = null;
  }

  private async persist(lease: CoordinationLease): Promise<void> {
    const directory = join(this.options.stateDirectory, "coordination");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}
