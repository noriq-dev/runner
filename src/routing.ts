import type { ProjectConfig } from "./config.js";
import type { RunnerJobAgentRoute, RunnerTaskSnapshot } from "./contracts.js";
import { hasExecutionSpec } from "./contracts.js";
import type { AgentRole } from "./drivers/types.js";

export const ROUTING_POLICY_VERSION = "task-routing-v1";

export type TaskSize = "tiny" | "small" | "standard" | "large";
export type TaskRisk = "normal" | "elevated" | "critical";
export type SpecCoverage = "empty" | "partial" | "build_ready" | "decomposed";
export type AgentProfileTier = "economy" | "balanced" | "strong";

export type RoutingReason =
  | "empty_spec"
  | "partial_spec"
  | "build_ready_spec"
  | "decomposed_spec"
  | "large_file_count"
  | "large_acceptance_count"
  | "large_reading_count"
  | "large_dependency_degree"
  | "large_task_payload"
  | "standard_file_count"
  | "standard_acceptance_count"
  | "standard_reading_count"
  | "standard_dependency_degree"
  | "standard_task_payload"
  | "delete_change"
  | "direct_workspace"
  | "missing_checks"
  | "elevated_path"
  | "critical_path"
  | "actual_diff_standard"
  | "actual_diff_large"
  | "scope_drift"
  | "failed_checks"
  | "repair_escalation";

export interface RoutingCounts {
  anticipatedFiles: number;
  acceptanceItems: number;
  requiredReading: number;
  dependencyDegree: number;
  taskBytes: number;
  changedPaths: number;
  diffBytes: number;
}

export interface TaskClassification {
  policyVersion: typeof ROUTING_POLICY_VERSION;
  size: TaskSize;
  risk: TaskRisk;
  specCoverage: SpecCoverage;
  reasons: RoutingReason[];
  counts: RoutingCounts;
}

export interface ConfiguredAgentProfile {
  driver: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
}

export interface ResolvedRoute {
  tier: AgentProfileTier;
  profile: ConfiguredAgentProfile;
}

const wireReason: Record<RoutingReason, string> = {
  empty_spec: "spec.none",
  partial_spec: "spec.partial",
  build_ready_spec: "spec.complete",
  decomposed_spec: "spec.decomposed",
  large_file_count: "size.files.large",
  large_acceptance_count: "size.acceptance.large",
  large_reading_count: "size.reading.large",
  large_dependency_degree: "size.dependencies.large",
  large_task_payload: "size.payload.large",
  standard_file_count: "size.files.medium",
  standard_acceptance_count: "size.acceptance.medium",
  standard_reading_count: "size.reading.medium",
  standard_dependency_degree: "size.dependencies.medium",
  standard_task_payload: "size.payload.medium",
  delete_change: "risk.delete",
  direct_workspace: "risk.direct",
  missing_checks: "risk.checks_missing",
  elevated_path: "risk.path_elevated",
  critical_path: "risk.path_critical",
  actual_diff_standard: "actual.diff_medium",
  actual_diff_large: "actual.diff_large",
  scope_drift: "actual.scope_drift",
  failed_checks: "actual.check_failed",
  repair_escalation: "repair.escalated",
};

export function wireRouteClassification(
  classification: TaskClassification,
): Pick<RunnerJobAgentRoute, "size" | "risk" | "specCoverage" | "reasons"> {
  if (classification.specCoverage === "decomposed")
    throw new Error(
      "decomposed specifications cannot be emitted as agent routes",
    );
  return {
    size:
      classification.size === "large"
        ? "large"
        : classification.size === "standard"
          ? "medium"
          : classification.size,
    risk:
      classification.risk === "critical"
        ? "high"
        : classification.risk === "elevated"
          ? "medium"
          : "low",
    specCoverage:
      classification.specCoverage === "build_ready"
        ? "complete"
        : classification.specCoverage === "partial"
          ? "partial"
          : "none",
    reasons: [
      ...new Set(classification.reasons.map((reason) => wireReason[reason])),
    ].slice(0, 16),
  };
}

export interface ActualCandidateFacts {
  changedPaths: string[];
  diffBytes: number;
  failedChecks: boolean;
  priorRepair?: boolean;
}

function acceptanceCount(task: RunnerTaskSnapshot): number {
  const acceptance = task.executionSpec?.acceptance;
  return acceptance
    ? acceptance.observableTruths.length +
        acceptance.artifacts.length +
        acceptance.links.length
    : 0;
}

export function executionSpecCoverage(task: RunnerTaskSnapshot): SpecCoverage {
  const spec = task.executionSpec;
  if (spec?.steps.length) return "decomposed";
  if (!hasExecutionSpec(spec)) return "empty";
  if ((spec?.anticipatedFiles.length ?? 0) > 0 && acceptanceCount(task) > 0)
    return "build_ready";
  return "partial";
}

function pathMatchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function anyPrefix(paths: string[], prefixes: string[]): boolean {
  return paths.some((path) =>
    prefixes.some((prefix) => pathMatchesPrefix(path, prefix)),
  );
}

function taskPayloadBytes(task: RunnerTaskSnapshot): number {
  return Buffer.byteLength(
    JSON.stringify({
      key: task.key,
      title: task.title,
      body: task.body,
      executionSpec: task.executionSpec,
    }),
  );
}

function uniqueReasons(reasons: RoutingReason[]): RoutingReason[] {
  return [...new Set(reasons)];
}

export function classifyTask(
  task: RunnerTaskSnapshot,
  config: ProjectConfig,
  dependencyDegree = 0,
  actual?: ActualCandidateFacts,
): TaskClassification {
  const specCoverage = executionSpecCoverage(task);
  const files = task.executionSpec?.anticipatedFiles ?? [];
  const anticipatedPaths = files.map((file) => file.path);
  const changedPaths = actual?.changedPaths ?? [];
  const paths = [...new Set([...anticipatedPaths, ...changedPaths])];
  const acceptanceItems = acceptanceCount(task);
  const requiredReading = task.executionSpec?.requiredReading.length ?? 0;
  const taskBytes = taskPayloadBytes(task);
  const counts: RoutingCounts = {
    anticipatedFiles: files.length,
    acceptanceItems,
    requiredReading,
    dependencyDegree,
    taskBytes,
    changedPaths: changedPaths.length,
    diffBytes: actual?.diffBytes ?? 0,
  };
  const reasons: RoutingReason[] = [
    specCoverage === "empty"
      ? "empty_spec"
      : specCoverage === "partial"
        ? "partial_spec"
        : specCoverage === "decomposed"
          ? "decomposed_spec"
          : "build_ready_spec",
  ];

  let size: TaskSize;
  if (
    files.length >= 8 ||
    acceptanceItems >= 8 ||
    requiredReading >= 6 ||
    dependencyDegree >= 4 ||
    taskBytes >= 24 * 1024
  ) {
    size = "large";
    if (files.length >= 8) reasons.push("large_file_count");
    if (acceptanceItems >= 8) reasons.push("large_acceptance_count");
    if (requiredReading >= 6) reasons.push("large_reading_count");
    if (dependencyDegree >= 4) reasons.push("large_dependency_degree");
    if (taskBytes >= 24 * 1024) reasons.push("large_task_payload");
  } else if (
    specCoverage === "empty" ||
    specCoverage === "partial" ||
    files.length >= 4 ||
    acceptanceItems >= 4 ||
    requiredReading >= 3 ||
    dependencyDegree >= 2 ||
    files.some((file) => file.change === "delete") ||
    taskBytes >= 8 * 1024
  ) {
    size = "standard";
    if (files.length >= 4) reasons.push("standard_file_count");
    if (acceptanceItems >= 4) reasons.push("standard_acceptance_count");
    if (requiredReading >= 3) reasons.push("standard_reading_count");
    if (dependencyDegree >= 2) reasons.push("standard_dependency_degree");
    if (taskBytes >= 8 * 1024) reasons.push("standard_task_payload");
  } else if (
    specCoverage === "build_ready" &&
    files.length === 1 &&
    acceptanceItems <= 2 &&
    (task.executionSpec?.acceptance.links.length ?? 0) === 0 &&
    dependencyDegree === 0 &&
    taskBytes < 4 * 1024
  ) {
    size = "tiny";
  } else {
    size = "small";
  }

  if (actual) {
    if (actual.changedPaths.length >= 8 || actual.diffBytes >= 80 * 1024) {
      size = "large";
      reasons.push("actual_diff_large");
    } else if (
      size !== "large" &&
      (actual.changedPaths.length >= 4 || actual.diffBytes >= 20 * 1024)
    ) {
      size = "standard";
      reasons.push("actual_diff_standard");
    }
    if (
      anticipatedPaths.length > 0 &&
      actual.changedPaths.some((path) => !anticipatedPaths.includes(path))
    )
      reasons.push("scope_drift");
    if (actual.failedChecks) reasons.push("failed_checks");
  }

  let risk: TaskRisk = "normal";
  if (anyPrefix(paths, config.routing.criticalPathPrefixes)) {
    risk = "critical";
    reasons.push("critical_path");
  } else if (
    anyPrefix(paths, config.routing.elevatedPathPrefixes) ||
    files.some((file) => file.change === "delete") ||
    config.sourceControl.mode === "direct" ||
    config.checks.commands.length === 0 ||
    reasons.includes("scope_drift") ||
    actual?.failedChecks
  ) {
    risk = "elevated";
    if (anyPrefix(paths, config.routing.elevatedPathPrefixes))
      reasons.push("elevated_path");
    if (files.some((file) => file.change === "delete"))
      reasons.push("delete_change");
    if (config.sourceControl.mode === "direct")
      reasons.push("direct_workspace");
    if (config.checks.commands.length === 0) reasons.push("missing_checks");
  }

  return {
    policyVersion: ROUTING_POLICY_VERSION,
    size,
    risk,
    specCoverage,
    reasons: uniqueReasons(reasons),
    counts,
  };
}

const tierRank: Record<AgentProfileTier, number> = {
  economy: 0,
  balanced: 1,
  strong: 2,
};
const ranks: AgentProfileTier[] = ["economy", "balanced", "strong"];

function atLeast(
  tier: AgentProfileTier,
  minimum: AgentProfileTier,
): AgentProfileTier {
  return tierRank[tier] < tierRank[minimum] ? minimum : tier;
}

export function resolveRoute(
  config: ProjectConfig,
  role: AgentRole,
  classification: TaskClassification,
  repairRound = 0,
): ResolvedRoute {
  let tier: AgentProfileTier =
    classification.size === "large"
      ? "strong"
      : classification.size === "standard"
        ? "balanced"
        : "economy";
  if (classification.risk === "critical") tier = "strong";
  else if (classification.risk === "elevated") {
    if (role === "reviewer") tier = "strong";
    else if (role !== "guide") tier = atLeast(tier, "balanced");
  }
  if (role === "repairer" && repairRound > 0)
    tier = ranks[Math.min(2, tierRank[tier] + repairRound)]!;
  return { tier, profile: config.agents[role][tier] };
}

function profileKey(profile: ConfiguredAgentProfile): string {
  return JSON.stringify([profile.driver, profile.model, profile.effort]);
}

export function routeCandidateCounts(
  config: ProjectConfig,
  role: AgentRole,
  minimumTier: AgentProfileTier,
  decision: "invoke" | "skip",
): Pick<RunnerJobAgentRoute, "candidateCount" | "eligibleCount"> {
  const profiles = config.agents[role];
  const candidateCount = new Set(
    ranks.map((tier) => profileKey(profiles[tier])),
  ).size;
  if (decision === "skip") return { candidateCount, eligibleCount: 0 };
  const eligibleCount = new Set(
    ranks
      .filter((tier) => tierRank[tier] >= tierRank[minimumTier])
      .map((tier) => profileKey(profiles[tier])),
  ).size;
  return { candidateCount, eligibleCount };
}

const sizeRank: Record<TaskSize, number> = {
  tiny: 0,
  small: 1,
  standard: 2,
  large: 3,
};

/**
 * The top-level path segments a task says it will MODIFY or DELETE. Those must
 * already exist; `create` entries are excluded because a new file legitimately
 * does not.
 */
export function anticipatedExistingRoots(task: RunnerTaskSnapshot): string[] {
  const roots = new Set<string>();
  for (const file of task.executionSpec?.anticipatedFiles ?? []) {
    if (file.change === "create") continue;
    // "." and ".." are not roots: a spec written as ./src/x.ts would otherwise
    // yield "." — which always exists — and quietly disable the check.
    const root = file.path
      .split("/")
      .filter((part) => part && part !== "." && part !== "..")[0];
    if (root) roots.add(root);
  }
  return [...roots];
}

/**
 * True when a task names files to modify and NOT ONE of their top-level
 * directories exists here — the signature of a task dispatched at the wrong
 * checkout. Deliberately conservative: one surviving root is enough to proceed,
 * because a stale path in an otherwise-correct spec is the agent's problem to
 * navigate, not grounds to refuse the run.
 *
 * Without this the mismatch costs a full builder invocation plus every repair
 * round to discover, and the run then fails on findings that describe the
 * dispatch rather than the work.
 */
export function dispatchedAtWrongCheckout(
  roots: string[],
  present: (root: string) => boolean,
): boolean {
  return roots.length > 0 && !roots.some(present);
}

export function classifyCandidate(
  base: TaskClassification,
  task: RunnerTaskSnapshot,
  config: ProjectConfig,
  actual: ActualCandidateFacts,
): TaskClassification {
  let size = base.size;
  const reasons = [...base.reasons];
  if (actual.changedPaths.length >= 8 || actual.diffBytes >= 80 * 1024) {
    size = "large";
    reasons.push("actual_diff_large");
  } else if (
    sizeRank[size] < sizeRank.standard &&
    (actual.changedPaths.length >= 4 || actual.diffBytes >= 20 * 1024)
  ) {
    size = "standard";
    reasons.push("actual_diff_standard");
  }
  const anticipated =
    task.executionSpec?.anticipatedFiles.map((file) => file.path) ?? [];
  const scopeDrift =
    anticipated.length > 0 &&
    actual.changedPaths.some((path) => !anticipated.includes(path));
  if (scopeDrift) reasons.push("scope_drift");
  if (actual.failedChecks) reasons.push("failed_checks");
  if (actual.priorRepair) reasons.push("repair_escalation");
  const paths = [...anticipated, ...actual.changedPaths];
  let risk = base.risk;
  if (anyPrefix(paths, config.routing.criticalPathPrefixes)) {
    risk = "critical";
    reasons.push("critical_path");
  } else if (
    risk !== "critical" &&
    (anyPrefix(paths, config.routing.elevatedPathPrefixes) ||
      scopeDrift ||
      actual.failedChecks ||
      actual.priorRepair)
  ) {
    risk = "elevated";
    if (anyPrefix(paths, config.routing.elevatedPathPrefixes))
      reasons.push("elevated_path");
  }
  return {
    ...base,
    size,
    risk,
    reasons: uniqueReasons(reasons),
    counts: {
      ...base.counts,
      changedPaths: actual.changedPaths.length,
      diffBytes: actual.diffBytes,
    },
  };
}
