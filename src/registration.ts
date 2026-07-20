import type { AgentTool, RunEffort, RunKind } from '@noriq-dev/shared';
import type { DiscoveredRepo } from './discovery';
import { CLAUDE_CATALOG } from './drivers/claude';
import { CODEX_CATALOG } from './drivers/codex';
import type { DriverCatalog } from './drivers/types';
import { VERSION } from './version';

/** The static per-tool coordinate menus (RUN-115), keyed by tool so registration can advertise the
 *  menu for each installed driver WITHOUT a live driver instance (registration precedes their
 *  construction). Mirrors each driver's own `catalog` field. */
const DRIVER_CATALOGS: Record<AgentTool, DriverCatalog> = {
  claude: CLAUDE_CATALOG,
  codex: CODEX_CATALOG,
};

/** One advertised driver: the coordinate menu the dashboard renders as `<tool>.<model>.<effort>`. */
export interface AdvertisedAgent {
  tool: AgentTool;
  models: string[];
  efforts: RunEffort[];
}

/** The coordinate catalog for the installed tools (RUN-115) — what the dashboard's agent picker
 *  reads. A tool with no known catalog still advertises itself with empty menus (free-form only). */
export function agentCatalog(tools: AgentTool[]): AdvertisedAgent[] {
  return tools.map((tool) => ({
    tool,
    models: DRIVER_CATALOGS[tool]?.models ?? [],
    efforts: DRIVER_CATALOGS[tool]?.efforts ?? [],
  }));
}

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
  /** The coordinate menu per installed tool (RUN-115) — models + efforts for the dashboard picker.
   *  Additive to `tools`; a server that does not yet read it simply ignores it. */
  agents: AdvertisedAgent[];
  kinds: RunKind[];
  maxConcurrency: number;
  repos: Array<{
    id: string;
    projectKey: string;
    /** The board lock (RUN-71): the marker's committed board NAME, riding the key's rails —
     *  the server resolves it to a boardId within the resolved project, and that board is
     *  where this repo's agents land the tasks they create. Null = the project default. */
    board: string | null;
    name: string;
    defaultBranch: string | null;
  }>;
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
    // The coordinate catalog for the installed tools (RUN-115) — what the dashboard picker reads.
    agents: agentCatalog(params.tools),
    kinds: params.kinds ?? DEFAULT_KINDS,
    maxConcurrency: params.concurrency,
    repos: discovered.map((r) => ({
      id: r.id,
      projectKey: r.projectKey,
      board: r.manifest.board,
      name: r.name,
      defaultBranch: r.defaultBranch,
    })),
  };
}
