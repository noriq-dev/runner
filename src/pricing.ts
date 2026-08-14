import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type {
  RunnerJobCostBasis,
  RunnerJobObservationUsage,
} from "./contracts.js";
import { observedMetric, unavailableMetric } from "./intelligence.js";

const CACHE_SCHEMA_VERSION = 1;
const PARSER_VERSION = "openai-model-markdown-v1";
const FRESH_MS = 24 * 60 * 60 * 1_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const OPENAI_MODEL_ORIGIN = "https://developers.openai.com";
const OPENAI_MODEL_PREFIX = "/api/docs/models/";
const modelIdPattern = /^[a-z0-9][a-z0-9.-]{0,199}$/;

const ratesSchema = z
  .object({
    inputPerMillion: z.number().nonnegative(),
    cachedInputPerMillion: z.number().nonnegative().nullable(),
    cacheWritePerMillion: z.number().nonnegative().nullable(),
    outputPerMillion: z.number().nonnegative(),
    longContextThresholdTokens: z.number().int().positive().nullable(),
    longContextInputMultiplier: z.number().positive().nullable(),
    longContextOutputMultiplier: z.number().positive().nullable(),
  })
  .strict();

export type PricingRates = z.infer<typeof ratesSchema>;

const quoteSchema = z
  .object({
    vendor: z.literal("openai"),
    model: z.string().regex(modelIdPattern),
    sourceUrl: z.string().url(),
    fetchedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    sourceDigest: z.string().regex(/^[0-9a-f]{64}$/),
    quoteDigest: z.string().regex(/^[0-9a-f]{64}$/),
    parserVersion: z.literal(PARSER_VERSION),
    rates: ratesSchema,
  })
  .strict();

export type PricingQuote = z.infer<typeof quoteSchema>;

const cacheRecordSchema = z
  .object({
    schemaVersion: z.literal(CACHE_SCHEMA_VERSION),
    model: z.string().regex(modelIdPattern),
    quote: quoteSchema.nullable(),
    etag: z.string().max(1_000).nullable(),
    lastModified: z.string().max(1_000).nullable(),
    lastAttemptAt: z.string().datetime().nullable(),
    nextRetryAt: z.string().datetime().nullable(),
    failureCount: z.number().int().nonnegative(),
    lastErrorCode: z.string().max(100).nullable(),
  })
  .strict();

type CacheRecord = z.infer<typeof cacheRecordSchema>;

export interface PricingResolution {
  quote: PricingQuote | null;
  stale: boolean;
  warning: string | null;
}

export interface PricingProvider {
  readonly vendor: string;
  quote(model: string, signal?: AbortSignal): Promise<PricingResolution>;
}

export interface PricingEstimate {
  usage: RunnerJobObservationUsage;
  costBasis?: RunnerJobCostBasis;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function number(value: string, label: string): number {
  const parsed = Number(value.replace(/[$,]/g, ""));
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`invalid ${label} price`);
  return parsed;
}

function exactlyOne(
  pattern: RegExp,
  input: string,
  label: string,
): RegExpMatchArray {
  const matches = [...input.matchAll(pattern)];
  if (matches.length !== 1)
    throw new Error(`expected exactly one ${label}, found ${matches.length}`);
  return matches[0]!;
}

export function parseOpenAiPricingMarkdown(
  markdown: string,
  expectedModel: string,
  fetchedAt = new Date(),
): PricingQuote {
  const model = exactlyOne(
    /^Model ID:\s*`([^`]+)`\s*$/gm,
    markdown,
    "model id",
  )[1]!;
  if (model !== expectedModel)
    throw new Error(
      `pricing model mismatch: expected ${expectedModel}, got ${model}`,
    );
  const pricingHeading = exactlyOne(
    /^## Pricing\s*$/gm,
    markdown,
    "pricing section",
  );
  const pricingStart = pricingHeading.index!;
  const pricingEnd = markdown.indexOf("\n## ", pricingStart + 4);
  const pricing = markdown.slice(
    pricingStart,
    pricingEnd < 0 ? markdown.length : pricingEnd,
  );
  exactlyOne(/^### Text tokens\s*$/gm, pricing, "text-token pricing section");

  const row = (metric: string, required: boolean): number | null => {
    const matches = [
      ...pricing.matchAll(
        new RegExp(
          `^\\|\\s*${metric}\\s*\\|\\s*\\$([0-9][0-9.,]*)\\s*\\|\\s*1M tokens\\s*\\|$`,
          "gim",
        ),
      ),
    ];
    if (matches.length === 0 && !required) return null;
    if (matches.length !== 1)
      throw new Error(
        `expected exactly one ${metric} price, found ${matches.length}`,
      );
    return number(matches[0]![1]!, metric);
  };

  const inputPerMillion = row("Input", true)!;
  const cachedInputPerMillion = row("Cached input", false);
  const outputPerMillion = row("Output", true)!;
  const cacheWriteMatch = [
    ...pricing.matchAll(
      /Cache writes are billed at\s*([0-9]+(?:\.[0-9]+)?)x\s*the uncached input token rate\./gi,
    ),
  ];
  if (cacheWriteMatch.length !== 1)
    throw new Error(
      `expected exactly one cache-write multiplier, found ${cacheWriteMatch.length}`,
    );
  const cacheWritePerMillion = inputPerMillion * Number(cacheWriteMatch[0]![1]);

  const longContextMatches = [
    ...pricing.matchAll(
      /Prompts with >([0-9]+)K input tokens are priced at\s*([0-9]+(?:\.[0-9]+)?)x input and\s*([0-9]+(?:\.[0-9]+)?)x output/gi,
    ),
  ];
  if (longContextMatches.length !== 1)
    throw new Error(
      `expected exactly one long-context rule, found ${longContextMatches.length}`,
    );
  const longContext = longContextMatches[0]!;
  const rates: PricingRates = {
    inputPerMillion,
    cachedInputPerMillion,
    cacheWritePerMillion,
    outputPerMillion,
    longContextThresholdTokens: Number(longContext[1]) * 1_000,
    longContextInputMultiplier: Number(longContext[2]),
    longContextOutputMultiplier: Number(longContext[3]),
  };
  ratesSchema.parse(rates);
  const sourceUrl = `${OPENAI_MODEL_ORIGIN}${OPENAI_MODEL_PREFIX}${encodeURIComponent(expectedModel)}.md`;
  const fetchedAtIso = fetchedAt.toISOString();
  const sourceDigest = sha256(markdown);
  const quoteDigest = sha256(
    JSON.stringify({ vendor: "openai", model, sourceUrl, rates, sourceDigest }),
  );
  return quoteSchema.parse({
    vendor: "openai",
    model,
    sourceUrl,
    fetchedAt: fetchedAtIso,
    expiresAt: new Date(fetchedAt.getTime() + FRESH_MS).toISOString(),
    sourceDigest,
    quoteDigest,
    parserVersion: PARSER_VERSION,
    rates,
  });
}

async function responseText(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_RESPONSE_BYTES)
    throw new Error("pricing response exceeds the size limit");
  if (!response.body) throw new Error("pricing response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("pricing response exceeds the size limit");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

function safeErrorCode(error: unknown): string {
  const raw =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : error instanceof Error
        ? error.name
        : "PRICING_FETCH_FAILED";
  return (
    raw.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 100) || "PRICING_FETCH_FAILED"
  );
}

export class OpenAiPricingProvider implements PricingProvider {
  readonly vendor = "openai";
  private readonly inflight = new Map<string, Promise<PricingResolution>>();
  private readonly emittedWarnings = new Set<string>();

  constructor(
    private readonly options: {
      stateDirectory: string;
      enabled: boolean;
      maxStaleHours: number;
      fetch?: typeof fetch;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private cachePath(model: string): string {
    return join(
      this.options.stateDirectory,
      "pricing",
      "openai",
      `${sha256(model)}.json`,
    );
  }

  private async read(model: string): Promise<CacheRecord | null> {
    try {
      const record = cacheRecordSchema.parse(
        JSON.parse(await readFile(this.cachePath(model), "utf8")),
      );
      return record.model === model ? record : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return null;
    }
  }

  private async write(record: CacheRecord): Promise<void> {
    const path = this.cachePath(record.model);
    const directory = join(this.options.stateDirectory, "pricing", "openai");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, path);
  }

  private usableStale(record: CacheRecord | null, now: Date): boolean {
    if (!record?.quote) return false;
    const oldest = now.getTime() - this.options.maxStaleHours * 60 * 60 * 1_000;
    return new Date(record.quote.fetchedAt).getTime() >= oldest;
  }

  private warningOnce(key: string, message: string): string | null {
    if (this.emittedWarnings.has(key)) return null;
    this.emittedWarnings.add(key);
    return message;
  }

  async quote(model: string, signal?: AbortSignal): Promise<PricingResolution> {
    if (!this.options.enabled)
      return { quote: null, stale: false, warning: null };
    if (!modelIdPattern.test(model))
      return {
        quote: null,
        stale: false,
        warning: `OpenAI pricing unavailable for invalid model id ${JSON.stringify(model)}`,
      };
    const existing = this.inflight.get(model);
    if (existing) return existing;
    const operation = this.resolve(model, signal).finally(() =>
      this.inflight.delete(model),
    );
    this.inflight.set(model, operation);
    return operation;
  }

  private async resolve(
    model: string,
    signal?: AbortSignal,
  ): Promise<PricingResolution> {
    const now = this.now();
    const record = await this.read(model);
    if (record?.quote && new Date(record.quote.expiresAt) > now)
      return { quote: record.quote, stale: false, warning: null };
    if (record?.nextRetryAt && new Date(record.nextRetryAt) > now) {
      if (this.usableStale(record, now))
        return {
          quote: record.quote,
          stale: true,
          warning: this.warningOnce(
            `${model}:${record.nextRetryAt}`,
            `OpenAI pricing refresh is backing off; using stale ${model} API-list rates`,
          ),
        };
      return { quote: null, stale: false, warning: null };
    }
    try {
      return await this.refresh(model, record, now, signal);
    } catch (error) {
      const failureCount = (record?.failureCount ?? 0) + 1;
      const backoffMs = Math.min(
        6 * 60 * 60 * 1_000,
        15 * 60 * 1_000 * 2 ** Math.min(5, failureCount - 1),
      );
      const failed: CacheRecord = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        model,
        quote: record?.quote ?? null,
        etag: record?.etag ?? null,
        lastModified: record?.lastModified ?? null,
        lastAttemptAt: now.toISOString(),
        nextRetryAt: new Date(now.getTime() + backoffMs).toISOString(),
        failureCount,
        lastErrorCode: safeErrorCode(error),
      };
      await this.write(failed).catch(() => {});
      if (this.usableStale(failed, now))
        return {
          quote: failed.quote,
          stale: true,
          warning: this.warningOnce(
            `${model}:${failed.nextRetryAt}`,
            `OpenAI pricing refresh failed; using stale ${model} API-list rates`,
          ),
        };
      return {
        quote: null,
        stale: false,
        warning: this.warningOnce(
          `${model}:${failed.nextRetryAt}`,
          `OpenAI pricing unavailable for ${model}: ${safeErrorCode(error)}`,
        ),
      };
    }
  }

  private async refresh(
    model: string,
    record: CacheRecord | null,
    now: Date,
    signal?: AbortSignal,
  ): Promise<PricingResolution> {
    const fetcher = this.options.fetch ?? fetch;
    let url = new URL(
      `${OPENAI_MODEL_ORIGIN}${OPENAI_MODEL_PREFIX}${encodeURIComponent(model)}.md`,
    );
    const headers = new Headers({ Accept: "text/markdown" });
    if (record?.etag) headers.set("If-None-Match", record.etag);
    if (record?.lastModified)
      headers.set("If-Modified-Since", record.lastModified);
    const timeout = AbortSignal.timeout(5_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response | null = null;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      response = await fetcher(url, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: combined,
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location) throw new Error("pricing redirect omitted location");
      const redirected = new URL(location, url);
      if (
        redirected.origin !== OPENAI_MODEL_ORIGIN ||
        !redirected.pathname.startsWith(OPENAI_MODEL_PREFIX)
      )
        throw new Error("pricing redirect escaped the official model path");
      url = redirected;
    }
    if (!response) throw new Error("pricing request produced no response");
    if (response.status === 304) {
      if (!record?.quote)
        throw new Error("pricing returned 304 without a quote");
      const quote = quoteSchema.parse({
        ...record.quote,
        fetchedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + FRESH_MS).toISOString(),
      });
      await this.write({
        schemaVersion: CACHE_SCHEMA_VERSION,
        model,
        quote,
        etag: response.headers.get("etag") ?? record.etag,
        lastModified:
          response.headers.get("last-modified") ?? record.lastModified,
        lastAttemptAt: now.toISOString(),
        nextRetryAt: null,
        failureCount: 0,
        lastErrorCode: null,
      });
      return { quote, stale: false, warning: null };
    }
    if (!response.ok)
      throw new Error(`pricing request failed with HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("text/markdown"))
      throw new Error(
        `pricing response has unsupported content type ${contentType}`,
      );
    const quote = parseOpenAiPricingMarkdown(
      await responseText(response),
      model,
      now,
    );
    await this.write({
      schemaVersion: CACHE_SCHEMA_VERSION,
      model,
      quote,
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      lastAttemptAt: now.toISOString(),
      nextRetryAt: null,
      failureCount: 0,
      lastErrorCode: null,
    });
    return { quote, stale: false, warning: null };
  }
}

function metricValue(
  metric: RunnerJobObservationUsage["inputTokens"],
): number | null {
  return metric.value;
}

export function attributeUsageCost(
  usage: RunnerJobObservationUsage,
  resolution: PricingResolution | null,
  attributedAt = new Date(),
): PricingEstimate {
  if (usage.costUsd.value !== null)
    return {
      usage,
      costBasis: { kind: "driver_reported" },
    };
  const quote = resolution?.quote;
  if (!quote) return { usage };
  const input = metricValue(usage.inputTokens);
  const cacheRead = metricValue(usage.cacheReadTokens);
  const cacheWrite = metricValue(usage.cacheWriteTokens);
  const output = metricValue(usage.outputTokens);
  if (
    input === null &&
    cacheRead === null &&
    cacheWrite === null &&
    output === null
  )
    return { usage };
  const totalKnownInput = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  const longContext =
    quote.rates.longContextThresholdTokens !== null &&
    totalKnownInput > quote.rates.longContextThresholdTokens;
  const inputMultiplier = longContext
    ? (quote.rates.longContextInputMultiplier ?? 1)
    : 1;
  const outputMultiplier = longContext
    ? (quote.rates.longContextOutputMultiplier ?? 1)
    : 1;
  const cost =
    (((input ?? 0) * quote.rates.inputPerMillion +
      (cacheRead ?? 0) * (quote.rates.cachedInputPerMillion ?? 0) +
      (cacheWrite ?? 0) * (quote.rates.cacheWritePerMillion ?? 0)) *
      inputMultiplier +
      (output ?? 0) * quote.rates.outputPerMillion * outputMultiplier) /
    1_000_000;
  const hasKnownCharge =
    input !== null ||
    output !== null ||
    (cacheRead !== null && quote.rates.cachedInputPerMillion !== null) ||
    (cacheWrite !== null && quote.rates.cacheWritePerMillion !== null);
  if (!hasKnownCharge)
    return { usage: { ...usage, costUsd: unavailableMetric() } };
  return {
    usage: {
      ...usage,
      costUsd: observedMetric(cost, "partial", "derived"),
    },
    costBasis: {
      kind: "api_list_estimate",
      priceSource: {
        provider: quote.vendor,
        catalog: "official-api-list",
        fetchedAt: quote.fetchedAt,
        ageSeconds: Math.min(
          31_536_000,
          Math.max(
            0,
            Math.floor(
              (attributedAt.getTime() - new Date(quote.fetchedAt).getTime()) /
                1_000,
            ),
          ),
        ),
        stale: resolution?.stale ?? false,
      },
    },
  };
}
