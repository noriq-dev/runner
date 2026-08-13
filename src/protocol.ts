import {
  RunnerJobRunnerMessage,
  RunnerJobServerMessage,
  type RunnerJobRunnerMessage as RunnerToServer,
  type RunnerJobServerMessage as ServerToRunner,
} from "@noriq-dev/shared";

/** Keep the effective wire schema identical to the vendored Noriq contract. */
export const runnerToServerSchema = RunnerJobRunnerMessage;
export const serverToRunnerSchema = RunnerJobServerMessage;
export type { RunnerToServer, ServerToRunner };
