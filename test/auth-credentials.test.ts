import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadCredential, updateCredential } from "../src/auth/credentials.js";

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("OAuth credential store", () => {
  test("serializes concurrent rotations and keeps private permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-credentials-"));
    roots.push(root);
    const path = join(root, "nested", "credentials.json");
    const server = "https://noriq.example";
    const rotate = () =>
      updateCredential(
        server,
        async (current) => ({
          server: `${server}/`,
          clientId: "client",
          accessToken: `access-${(current?.generation ?? 0) + 1}`,
          refreshToken: "refresh",
          expiresAt: null,
          scope: null,
          generation: (current?.generation ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        }),
        path,
      );
    await Promise.all([rotate(), rotate(), rotate()]);
    expect((await loadCredential(server, path))?.generation).toBe(3);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, "nested"))).mode & 0o777).toBe(0o700);
    }
  });
});
