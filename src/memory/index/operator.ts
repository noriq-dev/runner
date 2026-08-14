import type { MachineConfig } from "../../config.js";
import { scanRepositories } from "../../repositories/scanner.js";
import { encodeBatches } from "./batch.js";
import { scanIndex } from "./scan.js";
import { createIndexSource } from "./source.js";
import { readIndexStatus, writeIndexRequest } from "./state.js";

export async function runIndexCommand(
  command: string,
  options: {
    config: MachineConfig;
    path: string;
    json: boolean;
    checkDeterminism: boolean;
  },
): Promise<void> {
  const scanned = await scanRepositories(
    [options.path],
    options.config.discovery.maxDepth,
  );
  const checkout = scanned.checkouts[0];
  if (!checkout)
    throw new Error(`no configured repository found under ${options.path}`);
  if (command === "index-status") {
    const status = await readIndexStatus(
      options.config.runner.stateDirectory,
      checkout.checkoutId,
    );
    process.stdout.write(
      `${JSON.stringify(status ?? { checkoutId: checkout.checkoutId, phase: "idle" }, null, 2)}\n`,
    );
    return;
  }
  if (command === "index-reindex" || command === "index-cancel") {
    if (command === "index-reindex" && !checkout.config.index.enabled)
      throw new Error(
        "repository indexing is disabled; set [index] enabled = true first",
      );
    await writeIndexRequest(
      options.config.runner.stateDirectory,
      checkout.checkoutId,
      command === "index-reindex" ? "reindex" : "cancel",
    );
    process.stdout.write(
      `${command === "index-reindex" ? "reindex requested" : "cancellation requested"}\n`,
    );
    return;
  }
  const gitCommand = Object.values(options.config.backends).find(
    (backend) => backend.adapter === "git",
  )?.command;
  const perforceCommand = Object.values(options.config.backends).find(
    (backend) => backend.adapter === "perforce",
  )?.command;
  const source = createIndexSource(
    checkout.vcs,
    checkout.repository,
    {
      ...(gitCommand ? { git: gitCommand } : {}),
      ...(perforceCommand ? { perforce: perforceCommand } : {}),
    },
    checkout.config.sourceControl.base,
  );
  const scan = () =>
    scanIndex({
      source,
      project: checkout.config,
      limits: options.config.memory.indexer,
    });
  const first = await scan();
  const batches = encodeBatches(first.rows);
  if (options.checkDeterminism) {
    const second = await scan();
    const secondBatches = encodeBatches(second.rows);
    if (
      first.contentHash !== second.contentHash ||
      JSON.stringify(batches.map((batch) => batch.hash)) !==
        JSON.stringify(secondBatches.map((batch) => batch.hash))
    )
      throw new Error("index output is not deterministic");
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        checkoutId: checkout.checkoutId,
        repositoryKey: checkout.config.repositoryKey,
        enabled: checkout.config.index.enabled,
        source: source.kind,
        fileCount: first.fileCount,
        totalBytes: first.totalBytes,
        batchCount: batches.length,
        contentHash: first.contentHash,
        skipped: first.skipped,
        deterministic: options.checkDeterminism ? true : null,
      },
      null,
      2,
    )}\n`,
  );
}
