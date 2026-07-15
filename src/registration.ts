import type { AgentTool, RunKind } from '@noriq-dev/shared';
import type { DiscoveredRepo } from './discovery';
import { VERSION } from './version';

export interface RegistrationParams {
  label: string;
  concurrency: number;
  tools: AgentTool[];
  /** Run kinds this runner accepts; defaults to all three. */
  kinds?: RunKind[];
  /** Present on re-registration (reconnect) so the server re-binds the same runner. */
  runnerId?: string;
}

/** The POST /api/runners body (matches the server's RegisterRunnerBody). The daemon
 *  sends the committed KEY per repo; the server resolves it to a projectId. */
export interface RunnerRegistration {
  runnerId?: string;
  label: string;
  /** The daemon's RELEASE version (RUN-36) — what code this box is running. Distinct from
   *  RUNNER_PROTOCOL_VERSION in the WS hello, which answers "can we talk at all". */
  version: string;
  tools: AgentTool[];
  kinds: RunKind[];
  maxConcurrency: number;
  repos: Array<{ id: string; projectKey: string; name: string; defaultBranch: string | null }>;
}

const DEFAULT_KINDS: RunKind[] = ['scope', 'build', 'verify'];

/** Build the registration payload from config + discovered repos. Pure. */
export function buildRegistration(
  params: RegistrationParams,
  discovered: DiscoveredRepo[],
): RunnerRegistration {
  return {
    ...(params.runnerId ? { runnerId: params.runnerId } : {}),
    label: params.label,
    // What code this box is running (RUN-36). Registration carried tools/kinds/concurrency and
    // no version, so the dashboard could not show one and the server could not warn about a
    // runner too old to trust. Distinct from RUNNER_PROTOCOL_VERSION in the WS hello: protocol
    // is "can we talk", this is "what code is this".
    version: VERSION,
    tools: params.tools,
    kinds: params.kinds ?? DEFAULT_KINDS,
    maxConcurrency: params.concurrency,
    repos: discovered.map((r) => ({
      id: r.id,
      projectKey: r.projectKey,
      name: r.name,
      defaultBranch: r.defaultBranch,
    })),
  };
}
