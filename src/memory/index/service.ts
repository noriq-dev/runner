import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { IndexGenerationManifest } from "@noriq-dev/shared";
import type { MachineConfig } from "../../config.js";
import type { RepositoryCheckout } from "../../repositories/types.js";
import type { SourceControlBackend } from "../../vcs/types.js";
import { type EncodedBatch, encodeBatches } from "./batch.js";
import type { NoriqIndexClient } from "./client.js";
import { scanIndex } from "./scan.js";
import { createIndexSource } from "./source.js";
import {
  clearIndexStaging,
  readIndexStaging,
  takeIndexRequest,
  writeIndexStaging,
  writeIndexStatus,
} from "./state.js";

export interface IndexTarget {
  checkout: RepositoryCheckout;
  projectId: string;
  backend: SourceControlBackend;
}

export class RepositoryIndexService {
  private chain: Promise<void> = Promise.resolve();
  private active = new Map<string, AbortController>();
  private timer: NodeJS.Timeout | null = null;
  private requestTimer: NodeJS.Timeout | null = null;
  private targets: readonly IndexTarget[] = [];

  constructor(
    private readonly config: MachineConfig,
    private readonly runnerId: string,
    private readonly client: NoriqIndexClient,
  ) {}

  start(targets: readonly IndexTarget[]): void {
    this.updateTargets(targets);
    this.timer = setInterval(() => {
      this.targets.forEach((target) => {
        this.trigger(target);
      });
    }, this.config.memory.indexer.pollMinutes * 60_000);
    this.timer.unref();
    this.requestTimer = setInterval(() => {
      for (const target of this.targets)
        void takeIndexRequest(
          this.config.runner.stateDirectory,
          target.checkout.checkoutId,
        )
          .then((action) => {
            if (action === "cancel") this.cancel(target.checkout.checkoutId);
            else if (action === "reindex") this.trigger(target, true);
          })
          .catch((error) =>
            process.stderr.write(`Index request failed: ${String(error)}\n`),
          );
    }, 2_000);
    this.requestTimer.unref();
  }

  updateTargets(targets: readonly IndexTarget[]): void {
    const retained = new Set(
      targets.map((target) => target.checkout.checkoutId),
    );
    for (const [checkoutId, controller] of this.active)
      if (!retained.has(checkoutId)) controller.abort();
    this.targets = [...targets];
    for (const target of this.targets) this.trigger(target);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.requestTimer) clearInterval(this.requestTimer);
    this.timer = null;
    this.requestTimer = null;
    for (const controller of this.active.values()) controller.abort();
  }

  trigger(target: IndexTarget, force = false): void {
    if (
      !target.checkout.config.index.enabled ||
      this.active.has(target.checkout.checkoutId)
    )
      return;
    const controller = new AbortController();
    this.active.set(target.checkout.checkoutId, controller);
    this.chain = this.chain
      .then(() => this.run(target, force, controller.signal))
      .catch((error) => {
        process.stderr.write(
          `Index ${target.checkout.checkoutId} failed: ${String(error)}\n`,
        );
      })
      .finally(() => this.active.delete(target.checkout.checkoutId));
  }

  cancel(checkoutId: string): void {
    this.active.get(checkoutId)?.abort();
  }

  private async run(
    target: IndexTarget,
    force: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const { checkout } = target;
    const status = async (
      phase:
        | "queued"
        | "scanning"
        | "uploading"
        | "complete"
        | "failed"
        | "cancelled",
      detail: Partial<{
        generationId: string;
        baseId: string;
        fileCount: number;
        batchCount: number;
        error: string;
      }> = {},
    ) =>
      writeIndexStatus(this.config.runner.stateDirectory, {
        checkoutId: checkout.checkoutId,
        repositoryKey: checkout.config.repositoryKey,
        phase,
        generationId: detail.generationId ?? null,
        baseId: detail.baseId ?? null,
        fileCount: detail.fileCount ?? 0,
        batchCount: detail.batchCount ?? 0,
        error: detail.error ?? null,
        updatedAt: new Date().toISOString(),
      });
    await status("queued");
    try {
      const baseId = await target.backend.revisionOf(
        checkout.repository,
        checkout.config.sourceControl.base,
      );
      const cursor = await this.client.cursor({
        projectId: target.projectId,
        repositoryKey: checkout.config.repositoryKey,
        runnerId: this.runnerId,
        checkoutId: checkout.checkoutId,
      });
      if (cursor.association.state !== "associated")
        throw new Error(`checkout association is ${cursor.association.state}`);
      if (
        !force &&
        cursor.activeGeneration?.baseId === baseId &&
        cursor.activeGeneration.indexerVersion === "runner-v1"
      ) {
        await clearIndexStaging(
          this.config.runner.stateDirectory,
          checkout.checkoutId,
        );
        await status("complete", {
          generationId: cursor.activeGeneration.id,
          baseId,
          fileCount: cursor.activeGeneration.fileCount,
          batchCount: cursor.activeGeneration.batchCount,
        });
        return;
      }
      await status("scanning", { baseId });
      const git = Object.values(this.config.backends).find(
        (backend) => backend.adapter === "git",
      )?.command;
      const perforce = Object.values(this.config.backends).find(
        (backend) => backend.adapter === "perforce",
      )?.command;
      const source = createIndexSource(
        checkout.vcs,
        checkout.repository,
        { ...(git ? { git } : {}), ...(perforce ? { perforce } : {}) },
        baseId,
      );
      const scan = await scanIndex({
        source,
        project: checkout.config,
        limits: this.config.memory.indexer,
        signal,
      });
      let batches = encodeBatches(scan.rows);
      if (batches.length === 0) {
        const bytes = gzipSync("");
        batches = [
          {
            number: 0,
            bytes,
            hash: createHash("sha256").update(bytes).digest("hex"),
            rowCount: 0,
          } satisfies EncodedBatch,
        ];
      }
      const generationId = `idx_${createHash("sha256")
        .update(
          `${target.projectId}\0${checkout.config.repositoryKey}\0${checkout.config.sourceControl.base}\0${baseId}\0runner-v1\0${scan.contentHash}\0${cursor.activeGeneration?.id ?? "none"}`,
        )
        .digest("hex")
        .slice(0, 40)}`;
      const priorStaging = await readIndexStaging(
        this.config.runner.stateDirectory,
        checkout.checkoutId,
      );
      const canResume =
        priorStaging?.configDigest === checkout.configDigest &&
        priorStaging.manifest.generationId === generationId &&
        priorStaging.manifest.baseId === baseId &&
        priorStaging.manifest.contentHash === scan.contentHash &&
        priorStaging.batches.length === batches.length &&
        priorStaging.batches.every((saved, index) => {
          const batch = batches[index];
          return (
            batch !== undefined &&
            saved.number === batch.number &&
            saved.hash === batch.hash &&
            saved.rowCount === batch.rowCount &&
            saved.compressedBytes === batch.bytes.length
          );
        });
      const manifest: IndexGenerationManifest = {
        generationId,
        projectId: target.projectId,
        repositoryKey: checkout.config.repositoryKey,
        branch: checkout.config.sourceControl.base,
        baseId,
        indexerVersion: "runner-v1",
        batchCount: batches.length,
        fileCount: scan.fileCount,
        contentHash: scan.contentHash,
        deletions: [],
        createdAt: canResume
          ? priorStaging.manifest.createdAt
          : new Date().toISOString(),
      };
      await writeIndexStaging(this.config.runner.stateDirectory, {
        checkoutId: checkout.checkoutId,
        configDigest: checkout.configDigest,
        manifest,
        batches: batches.map((batch) => ({
          number: batch.number,
          hash: batch.hash,
          rowCount: batch.rowCount,
          compressedBytes: batch.bytes.length,
        })),
        updatedAt: new Date().toISOString(),
      });
      await status("uploading", {
        generationId,
        baseId,
        fileCount: scan.fileCount,
        batchCount: batches.length,
      });
      await this.client.upload({ runnerId: this.runnerId, manifest, batches });
      await clearIndexStaging(
        this.config.runner.stateDirectory,
        checkout.checkoutId,
      );
      await status("complete", {
        generationId,
        baseId,
        fileCount: scan.fileCount,
        batchCount: batches.length,
      });
    } catch (error) {
      const cancelled = signal.aborted;
      await status(cancelled ? "cancelled" : "failed", {
        error:
          error instanceof Error
            ? error.message.slice(0, 500)
            : String(error).slice(0, 500),
      });
      if (!cancelled) throw error;
    }
  }
}
