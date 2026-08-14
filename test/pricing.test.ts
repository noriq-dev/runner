import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunnerJobObservationUsage } from "../src/contracts.js";
import {
  attributeUsageCost,
  OpenAiPricingProvider,
  parseOpenAiPricingMarkdown,
} from "../src/pricing.js";

const sol = await readFile(
  new URL("./fixtures/openai-pricing/gpt-5.6-sol.md", import.meta.url),
  "utf8",
);
const terra = await readFile(
  new URL("./fixtures/openai-pricing/gpt-5.6-terra.md", import.meta.url),
  "utf8",
);
const luna = await readFile(
  new URL("./fixtures/openai-pricing/gpt-5.6-luna.md", import.meta.url),
  "utf8",
);

function response(body = sol, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/markdown", ...headers },
  });
}

function metric(value: number) {
  return {
    status: "complete" as const,
    value,
    provenance: "driver_reported" as const,
  };
}

function missing() {
  return {
    status: "unavailable" as const,
    value: null,
    provenance: "not_reported" as const,
  };
}

describe("OpenAI pricing", () => {
  it("strictly parses official model markdown and derives cache-write and long-context rates", () => {
    const quote = parseOpenAiPricingMarkdown(
      sol,
      "gpt-5.6-sol",
      new Date("2026-08-14T00:00:00.000Z"),
    );
    expect(quote.rates).toEqual({
      inputPerMillion: 5,
      cachedInputPerMillion: 0.5,
      cacheWritePerMillion: 6.25,
      outputPerMillion: 30,
      longContextThresholdTokens: 272_000,
      longContextInputMultiplier: 2,
      longContextOutputMultiplier: 1.5,
    });
    expect(quote.expiresAt).toBe("2026-08-15T00:00:00.000Z");
    expect(() => parseOpenAiPricingMarkdown(sol, "gpt-5.6-terra")).toThrow(
      /model mismatch/,
    );
    expect(
      parseOpenAiPricingMarkdown(terra, "gpt-5.6-terra").rates,
    ).toMatchObject({
      inputPerMillion: 2.5,
      cachedInputPerMillion: 0.25,
      outputPerMillion: 15,
    });
    expect(
      parseOpenAiPricingMarkdown(luna, "gpt-5.6-luna").rates,
    ).toMatchObject({
      inputPerMillion: 1,
      cachedInputPerMillion: 0.1,
      outputPerMillion: 6,
    });
    expect(() =>
      parseOpenAiPricingMarkdown(
        sol.replace(/Cache writes[^\n]+\n/, ""),
        "gpt-5.6-sol",
      ),
    ).toThrow(/cache-write multiplier/);
    expect(() =>
      parseOpenAiPricingMarkdown(
        sol.replace(/Prompts with[^\n]+\n/, ""),
        "gpt-5.6-sol",
      ),
    ).toThrow(/long-context rule/);
  });

  it("caches a quote for 24 hours and single-flights concurrent refreshes", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-pricing-cache-"));
    let now = new Date("2026-08-14T00:00:00.000Z");
    let calls = 0;
    const provider = new OpenAiPricingProvider({
      stateDirectory: root,
      enabled: true,
      maxStaleHours: 168,
      now: () => now,
      fetch: async () => {
        calls += 1;
        return response();
      },
    });
    const [first, concurrent] = await Promise.all([
      provider.quote("gpt-5.6-sol"),
      provider.quote("gpt-5.6-sol"),
    ]);
    expect(first.quote?.quoteDigest).toBe(concurrent.quote?.quoteDigest);
    expect(calls).toBe(1);
    const cachePath = join(
      root,
      "pricing",
      "openai",
      `${createHash("sha256").update("gpt-5.6-sol").digest("hex")}.json`,
    );
    expect(JSON.parse(await readFile(cachePath, "utf8"))).toMatchObject({
      schemaVersion: 1,
    });
    expect((await stat(join(root, "pricing", "openai"))).mode & 0o777).toBe(
      0o700,
    );
    expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
    now = new Date("2026-08-14T23:59:59.000Z");
    expect((await provider.quote("gpt-5.6-sol")).stale).toBe(false);
    expect(calls).toBe(1);
    now = new Date("2026-08-15T00:00:01.000Z");
    await provider.quote("gpt-5.6-sol");
    expect(calls).toBe(2);
  });

  it("uses conditional refresh and preserves the original quote digest on 304", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-pricing-conditional-"));
    let now = new Date("2026-08-14T00:00:00.000Z");
    const headers: Headers[] = [];
    let calls = 0;
    const provider = new OpenAiPricingProvider({
      stateDirectory: root,
      enabled: true,
      maxStaleHours: 168,
      now: () => now,
      fetch: async (_input, init) => {
        calls += 1;
        headers.push(new Headers(init?.headers));
        return calls === 1
          ? response(sol, 200, {
              etag: '"quote-one"',
              "last-modified": "Fri, 14 Aug 2026 00:00:00 GMT",
            })
          : new Response(null, {
              status: 304,
              headers: { etag: '"quote-one"' },
            });
      },
    });
    const first = await provider.quote("gpt-5.6-sol");
    now = new Date("2026-08-15T00:00:01.000Z");
    const refreshed = await provider.quote("gpt-5.6-sol");
    expect(headers[1]?.get("if-none-match")).toBe('"quote-one"');
    expect(headers[1]?.get("if-modified-since")).toBe(
      "Fri, 14 Aug 2026 00:00:00 GMT",
    );
    expect(refreshed.quote?.quoteDigest).toBe(first.quote?.quoteDigest);
    expect(refreshed.quote?.fetchedAt).toBe("2026-08-15T00:00:01.000Z");
  });

  it("fails closed on oversized responses and redirects outside the official model path", async () => {
    for (const fetcher of [
      async () =>
        response("x".repeat(256 * 1024 + 1), 200, {
          "content-length": String(256 * 1024 + 1),
        }),
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://example.test/prices" },
        }),
    ]) {
      const root = await mkdtemp(join(tmpdir(), "runner-pricing-reject-"));
      const provider = new OpenAiPricingProvider({
        stateDirectory: root,
        enabled: true,
        maxStaleHours: 168,
        fetch: fetcher,
      });
      const result = await provider.quote("gpt-5.6-sol");
      expect(result.quote).toBeNull();
      expect(result.warning).toContain("pricing unavailable");
    }
  });

  it("uses bounded stale rates after refresh failure, then makes cost unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-pricing-stale-"));
    let now = new Date("2026-08-14T00:00:00.000Z");
    let fail = false;
    const provider = new OpenAiPricingProvider({
      stateDirectory: root,
      enabled: true,
      maxStaleHours: 168,
      now: () => now,
      fetch: async () => {
        if (fail) throw new Error("offline");
        return response();
      },
    });
    await provider.quote("gpt-5.6-sol");
    fail = true;
    now = new Date("2026-08-15T01:00:00.000Z");
    const stale = await provider.quote("gpt-5.6-sol");
    expect(stale).toMatchObject({ stale: true });
    expect(stale.warning).toContain("using stale");
    expect((await provider.quote("gpt-5.6-sol")).warning).toBeNull();
    now = new Date("2026-08-22T01:00:00.000Z");
    expect(await provider.quote("gpt-5.6-sol")).toMatchObject({
      quote: null,
      stale: false,
    });
  });

  it("attributes a partial API-list estimate without replacing unavailable cache-write evidence", () => {
    const quote = parseOpenAiPricingMarkdown(
      sol,
      "gpt-5.6-sol",
      new Date("2026-08-14T00:00:00.000Z"),
    );
    const usage: RunnerJobObservationUsage = {
      inputTokens: metric(19_019),
      outputTokens: metric(1_103),
      cacheReadTokens: metric(0),
      cacheWriteTokens: missing(),
      calls: metric(1),
      costUsd: missing(),
    };
    const attributed = attributeUsageCost(
      usage,
      { quote, stale: false, warning: null },
      new Date("2026-08-14T01:00:00.000Z"),
    );
    expect(attributed.usage.costUsd).toMatchObject({
      status: "partial",
      provenance: "derived",
      value: 0.128185,
    });
    expect(attributed.usage.cacheWriteTokens).toEqual(missing());
    expect(attributed.costBasis).toMatchObject({
      kind: "api_list_estimate",
      priceSource: {
        provider: "openai",
        catalog: "official-api-list",
        fetchedAt: "2026-08-14T00:00:00.000Z",
        ageSeconds: 3_600,
        stale: false,
      },
    });
  });

  it("keeps a driver-reported zero distinct from unavailable cost", () => {
    const usage: RunnerJobObservationUsage = {
      inputTokens: metric(1),
      outputTokens: metric(1),
      cacheReadTokens: metric(0),
      cacheWriteTokens: metric(0),
      calls: metric(1),
      costUsd: metric(0),
    };
    expect(attributeUsageCost(usage, null)).toMatchObject({
      usage: { costUsd: { status: "complete", value: 0 } },
      costBasis: { kind: "driver_reported" },
    });
  });

  it("applies documented long-context multipliers across known token axes", () => {
    const quote = parseOpenAiPricingMarkdown(
      sol,
      "gpt-5.6-sol",
      new Date("2026-08-14T00:00:00.000Z"),
    );
    const usage: RunnerJobObservationUsage = {
      inputTokens: metric(200_000),
      outputTokens: metric(10_000),
      cacheReadTokens: metric(50_000),
      cacheWriteTokens: metric(30_000),
      calls: metric(1),
      costUsd: missing(),
    };
    expect(
      attributeUsageCost(usage, { quote, stale: false, warning: null }).usage
        .costUsd,
    ).toMatchObject({
      status: "partial",
      provenance: "derived",
      value: 2.875,
    });
  });
});
