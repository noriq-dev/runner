import type { RunnerJobObservationUsage, Usage } from "./contracts.js";
import type { AgentDriverCapabilities } from "./drivers/types.js";

type Provenance =
  | "runner_reported"
  | "driver_reported"
  | "derived"
  | "server_measured"
  | "not_reported";
type NumericMetric = RunnerJobObservationUsage["inputTokens"];

export function observedMetric(
  value: number | null | undefined,
  status: "complete" | "partial" = "complete",
  provenance: Exclude<Provenance, "not_reported"> = "driver_reported",
): NumericMetric {
  return value === null || value === undefined
    ? { status: "unavailable", value: null, provenance: "not_reported" }
    : { status, value: Math.max(0, value), provenance };
}

export function unavailableMetric(): NumericMetric {
  return { status: "unavailable", value: null, provenance: "not_reported" };
}

export function notApplicableMetric(): NumericMetric {
  return {
    status: "not_applicable",
    value: null,
    provenance: "runner_reported",
  };
}

export function notApplicableUsage(): RunnerJobObservationUsage {
  return {
    inputTokens: notApplicableMetric(),
    outputTokens: notApplicableMetric(),
    cacheReadTokens: notApplicableMetric(),
    cacheWriteTokens: notApplicableMetric(),
    calls: notApplicableMetric(),
    costUsd: notApplicableMetric(),
  };
}

export function unavailableUsage(): RunnerJobObservationUsage {
  return {
    inputTokens: unavailableMetric(),
    outputTokens: unavailableMetric(),
    cacheReadTokens: unavailableMetric(),
    cacheWriteTokens: unavailableMetric(),
    calls: unavailableMetric(),
    costUsd: unavailableMetric(),
  };
}

export function observationUsageFromLegacy(
  usage: Usage,
  accuracy: AgentDriverCapabilities["usageAccuracy"],
): RunnerJobObservationUsage {
  if (accuracy === "none") return unavailableUsage();
  const status = accuracy === "exact" ? "complete" : "partial";
  return {
    inputTokens: observedMetric(usage.inputTokens, status),
    outputTokens: observedMetric(usage.outputTokens, status),
    // The legacy field combines cache reads and writes, so neither axis may be
    // presented as exact even when the driver's aggregate claim is exact.
    cacheReadTokens: observedMetric(usage.cachedTokens, "partial"),
    cacheWriteTokens: unavailableMetric(),
    calls: observedMetric(usage.calls, status),
    costUsd: observedMetric(usage.costUsd, status),
  };
}

function addMetric(left: NumericMetric, right: NumericMetric): NumericMetric {
  const applicable = [left, right].filter(
    (metric) => metric.status !== "not_applicable",
  );
  if (applicable.length === 0) return notApplicableMetric();
  const known = applicable.filter(
    (metric): metric is Extract<NumericMetric, { value: number }> =>
      metric.value !== null,
  );
  if (known.length === 0) return unavailableMetric();
  const value = known.reduce((sum, metric) => sum + metric.value, 0);
  const complete = applicable.every((metric) => metric.status === "complete");
  return {
    status: complete ? "complete" : "partial",
    value,
    provenance: "derived",
  };
}

export function addObservationUsage(
  left: RunnerJobObservationUsage,
  right: RunnerJobObservationUsage,
): RunnerJobObservationUsage {
  return {
    inputTokens: addMetric(left.inputTokens, right.inputTokens),
    outputTokens: addMetric(left.outputTokens, right.outputTokens),
    cacheReadTokens: addMetric(left.cacheReadTokens, right.cacheReadTokens),
    cacheWriteTokens: addMetric(left.cacheWriteTokens, right.cacheWriteTokens),
    calls: addMetric(left.calls, right.calls),
    costUsd: addMetric(left.costUsd, right.costUsd),
  };
}

export function aggregateUsageAsLegacy(
  usage: RunnerJobObservationUsage,
): Usage {
  const value = (metric: NumericMetric) => metric.value ?? 0;
  return {
    inputTokens: value(usage.inputTokens),
    outputTokens: value(usage.outputTokens),
    cachedTokens: value(usage.cacheReadTokens) + value(usage.cacheWriteTokens),
    costUsd: usage.costUsd.status === "complete" ? usage.costUsd.value : null,
    calls: value(usage.calls),
  };
}
