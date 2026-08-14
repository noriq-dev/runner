export const RUNNER_CATALOG_CAPABILITY = "runner.catalog.v1";
export const RUNNER_MEMORY_CONTEXT_CAPABILITY = "runner.memory-context.v1";
export const RUNNER_COORDINATION_CAPABILITY = "runner.coordination.v1";

export const REQUIRED_DYNAMIC_CAPABILITIES = [
  RUNNER_CATALOG_CAPABILITY,
  RUNNER_COORDINATION_CAPABILITY,
] as const;
