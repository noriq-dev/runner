import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { updateCredential } from "../src/auth/credentials.js";
import { discover } from "../src/auth/oauth.js";
import { OAuthTokenProvider } from "../src/auth/token-provider.js";
import type { TokenProvider } from "../src/auth/types.js";
import { NoriqHttpClient } from "../src/noriq/http.js";

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function credentialPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "runner-oauth-"));
  roots.push(root);
  const path = join(root, "credentials.json");
  await updateCredential(
    "https://noriq.example",
    () => ({
      server: "https://noriq.example",
      clientId: "client",
      accessToken: "old",
      refreshToken: "refresh",
      expiresAt: new Date(0).toISOString(),
      scope: null,
      generation: 1,
      updatedAt: new Date(0).toISOString(),
    }),
    path,
  );
  return path;
}

const metadata = {
  issuer: "https://noriq.example",
  authorization_endpoint: "https://noriq.example/oauth/authorize",
  token_endpoint: "https://noriq.example/oauth/token",
};

describe("Noriq OAuth transport", () => {
  test("rejects cross-origin authorization metadata", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            issuer: "https://noriq.example",
            authorization_endpoint: "https://attacker.example/authorize",
            token_endpoint: "https://noriq.example/oauth/token",
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    await expect(discover("https://noriq.example", fetchImpl)).rejects.toThrow(
      /configured Noriq server origin/,
    );
  });

  test("retries one 401 with one forced refresh", async () => {
    const calls: boolean[] = [];
    const provider: TokenProvider = {
      kind: "oauth",
      get: async (force = false) => {
        calls.push(force);
        return {
          accessToken: force ? "new" : "old",
          generation: force ? 2 : 1,
          kind: "oauth" as const,
          expiresAt: null,
        };
      },
      canRefresh: async () => true,
      status: async () => ({
        kind: "oauth" as const,
        authenticated: true,
        generation: 1,
        expiresAt: null,
        reauthRequired: false,
      }),
    };
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Response(null, {
          status:
            new Headers(init?.headers).get("Authorization") === "Bearer new"
              ? 204
              : 401,
        }),
    ) as unknown as typeof fetch;
    const response = await new NoriqHttpClient(
      "https://noriq.example",
      provider,
      fetchImpl,
    ).request("/api/test");
    expect(response.status).toBe(204);
    expect(calls).toEqual([false, true]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("deduplicates concurrent refresh and persists the rotated generation", async () => {
    const path = await credentialPath();
    let tokenCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/.well-known"))
        return Response.json(metadata);
      tokenCalls += 1;
      return Response.json({
        access_token: "new",
        refresh_token: "next-refresh",
        token_type: "Bearer",
        expires_in: 3_600,
      });
    }) as typeof fetch;
    const provider = new OAuthTokenProvider({
      server: "https://noriq.example",
      credentialsPath: path,
      fetchImpl,
      now: () => 1_000,
    });

    const tokens = await Promise.all([
      provider.get(),
      provider.get(),
      provider.get(),
    ]);

    expect(tokens.map((token) => token.accessToken)).toEqual([
      "new",
      "new",
      "new",
    ]);
    expect(tokens.every((token) => token.generation === 2)).toBe(true);
    expect(tokenCalls).toBe(1);
  });

  test("drains on invalid_grant and observes externally replaced credentials", async () => {
    const path = await credentialPath();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return url.pathname.startsWith("/.well-known")
        ? Response.json(metadata)
        : Response.json(
            { error: "invalid_grant", error_description: "revoked" },
            { status: 400 },
          );
    }) as typeof fetch;
    const provider = new OAuthTokenProvider({
      server: "https://noriq.example",
      credentialsPath: path,
      fetchImpl,
      now: () => 1_000,
    });

    await expect(provider.get()).rejects.toThrow(/authorization expired/i);
    expect((await provider.status()).reauthRequired).toBe(true);
    await updateCredential(
      "https://noriq.example",
      (current) => ({
        ...current!,
        accessToken: "replacement",
        expiresAt: new Date(10_000_000).toISOString(),
        generation: current!.generation + 1,
        updatedAt: new Date(1_000).toISOString(),
      }),
      path,
    );

    await expect(provider.get()).resolves.toMatchObject({
      accessToken: "replacement",
      generation: 2,
    });
    expect((await provider.status()).reauthRequired).toBe(false);
  });
});
