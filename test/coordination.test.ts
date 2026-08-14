import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DurableLeaseManager } from "../src/coordination/lease-manager.js";
import {
  leaseScopesConflict,
  normalizeLeasePaths,
} from "../src/coordination/paths.js";
import type {
  AcquireResult,
  CoordinationLease,
  CoordinationProvider,
  LeaseScope,
} from "../src/coordination/types.js";

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true })),
  );
});
const scope = (kind: LeaseScope["kind"], paths: string[] = []): LeaseScope => ({
  repositoryKey: "repo",
  lane: "main",
  kind,
  paths,
});

describe("coordination", () => {
  test("implements the repository, path, and landing conflict matrix", () => {
    expect(
      leaseScopesConflict(scope("repository"), scope("paths", ["a"])),
    ).toBe(true);
    expect(leaseScopesConflict(scope("landing"), scope("paths", ["a"]))).toBe(
      false,
    );
    expect(leaseScopesConflict(scope("landing"), scope("landing"))).toBe(true);
    expect(
      leaseScopesConflict(
        scope("paths", ["src"]),
        scope("paths", ["src/a.ts"]),
      ),
    ).toBe(true);
    expect(
      leaseScopesConflict(
        scope("paths", ["src/a.ts"]),
        scope("paths", ["test/a.ts"]),
      ),
    ).toBe(false);
    expect(normalizeLeasePaths(["src\\a.ts", "src/a.ts"])).toEqual([
      "src/a.ts",
    ]);
    expect(() => normalizeLeasePaths(["../secret"])).toThrow(/invalid/);
  });

  test("waits without effects and records a fencing token before acquisition", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-lease-"));
    roots.push(root);
    let calls = 0;
    const lease: CoordinationLease = {
      leaseId: "lease-1",
      runnerId: "runner",
      checkoutId: "repo_1",
      projectId: "project",
      jobId: "job",
      assignmentId: "assignment",
      taskId: "task",
      idempotencyKey: "job:task",
      repositoryKey: "repo",
      lane: "main",
      kind: "paths",
      paths: ["src/a.ts"],
      fencingToken: 7,
      expiresAt: new Date(Date.now() + 90_000).toISOString(),
    };
    const provider: CoordinationProvider = {
      acquire: vi.fn(
        async (): Promise<AcquireResult> =>
          ++calls === 1
            ? { status: "conflict", retryAfterMs: 1, conflictingKind: "paths" }
            : { status: "acquired", lease },
      ),
      exchange: vi.fn(),
      renew: vi.fn(async () => lease),
      recover: vi.fn(),
      release: vi.fn(async () => {}),
    };
    const waiting = vi.fn();
    const manager = new DurableLeaseManager(provider, {
      stateDirectory: root,
      identity: {
        runnerId: "runner",
        checkoutId: "repo_1",
        projectId: "project",
        jobId: "job",
        assignmentId: "assignment",
        taskId: "task",
        idempotencyKey: "job:task",
      },
      onWaiting: waiting,
    });
    const acquired = await manager.acquire(scope("paths", ["src/a.ts"]));
    expect(acquired.fencingToken).toBe(7);
    expect(waiting).toHaveBeenCalledOnce();
    await manager.release();
    expect(provider.release).toHaveBeenCalledOnce();
  }, 5_000);
});
