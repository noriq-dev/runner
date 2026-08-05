import type { AgentTool, ProjectManifest, RunEffort, RunKind } from '@noriq-dev/shared';
import type { DiscoveredRepo } from './discovery';
import { CLAUDE_CATALOG } from './drivers/claude';
import { CODEX_CATALOG } from './drivers/codex';
import type { DriverCatalog } from './drivers/types';
import { VERSION } from './version';
import type { WorkflowCatalog } from './workflow-store';

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

/**
 * One workflow a repo advertises for dispatch (RUN-195; matches shared `AdvertisedWorkflow`).
 * Advertise-only metadata: `base` lets a dispatch surface default the run's kind to the workflow's
 * posture, `description` is the human line beside the name — neither is authority. Dispatch still
 * re-reads and pins its own WorkflowStore catalog and resolves posture locally (`effectiveKind`,
 * RUN-126), so a stale or hostile server-side record can never widen what an agent may do. Prompt
 * text and local source paths are daemon-local and never cross the wire.
 */
export interface AdvertisedWorkflowEntry {
  name: string;
  base: RunKind;
  /** Present only when the definition declares one — an absent line is omitted, not sent null. */
  description?: string;
}

/**
 * Reduce what dispatch can resolve to what the server may show (RUN-195): the three built-ins plus
 * the post-precedence custom catalog, each name exactly once. A custom definition shadowing a
 * bundled name replaces that entry's metadata — `resolveWorkflow` gives the loaded definition
 * precedence, and the advertised list must be exactly the list a dispatch resolves. Sorted by name
 * so re-advertisements are byte-stable. The manifest record is the catalog-less fallback, same as
 * `buildRegistration`'s: names a caller without a WorkflowStore snapshot can still advertise.
 */
export function advertisedWorkflows(
  catalog: WorkflowCatalog | undefined,
  manifestWorkflows?: ProjectManifest['workflows'],
): AdvertisedWorkflowEntry[] {
  const entries = new Map<string, AdvertisedWorkflowEntry>();
  for (const kind of DEFAULT_KINDS) entries.set(kind, { name: kind, base: kind });
  // Built-in descriptions are deliberately absent: `description` is optional and the repo has no
  // canonical text for them — the dashboard already knows what scope/build/verify are.
  const custom: Array<[string, { base: RunKind; description: string | null }]> = catalog
    ? Object.entries(catalog.definitions)
    : Object.entries(manifestWorkflows ?? {});
  for (const [name, def] of custom) {
    entries.set(name, {
      name,
      base: def.base,
      ...(def.description !== null && def.description !== '' ? { description: def.description } : {}),
    });
  }
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** One repo as the server hears about it — the same shape rides the registration body AND every
 *  WS hello's `repos` (RUN-195), so the two report paths cannot drift apart. */
export interface RepoReport {
  id: string;
  projectKey: string;
  /** The board lock (RUN-71): the marker's committed board NAME, riding the key's rails —
   *  the server resolves it to a boardId within the resolved project, and that board is
   *  where this repo's agents land the tasks they create. Null = the project default. */
  board: string | null;
  name: string;
  defaultBranch: string | null;
  /**
   * Every workflow a dispatch against this repo can resolve (RUN-195; matches the object arm of
   * shared `RunnerRepo.workflows`): the three built-ins plus the post-precedence custom catalog,
   * as `{name, base, description?}`. RUN-121 sent bare NAMES and RUN-125's base advertisement
   * was reverted because the wire had no way to say "metadata, not authority" — PLNR-240 draws
   * that line in the contract: `base`/`description` are the posted menu for the dispatch surface,
   * while the DAEMON still resolves a selected name to its posture locally (`effectiveKind`,
   * RUN-126), so a mismatched dispatched `kind` can never escalate write. Prompt bytes and local
   * source paths never cross.
   */
  workflows: AdvertisedWorkflowEntry[];
}

/** The one conversion from what the daemon knows to what the server may hear (RUN-195). Takes the
 *  manifest as its own argument rather than reading `repo.manifest`, because the manifest is
 *  read-at-use (ManifestStore) while `DiscoveredRepo` pins the startup snapshot — a reconnect
 *  report passes the CURRENT one, and the identity fields (id, key, name) are the stable half. */
export function repoReport(
  repo: Pick<DiscoveredRepo, 'id' | 'projectKey' | 'name' | 'defaultBranch'>,
  manifest: Pick<ProjectManifest, 'board' | 'workflows'>,
  catalog: WorkflowCatalog | undefined,
): RepoReport {
  return {
    id: repo.id,
    projectKey: repo.projectKey,
    board: manifest.board,
    name: repo.name,
    defaultBranch: repo.defaultBranch,
    // Built-ins + the merged custom catalog (RUN-195): exactly the list dispatch can resolve,
    // post-precedence — a definition shadowing a bundled name replaces that entry's metadata.
    workflows: advertisedWorkflows(catalog, manifest.workflows),
  };
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
  repos: RepoReport[];
}

const DEFAULT_KINDS: RunKind[] = ['scope', 'build', 'verify'];

/** Build the registration payload from config + discovered repos. Pure. */
export function buildRegistration(
  params: RegistrationParams,
  discovered: DiscoveredRepo[],
  workflowCatalogs: ReadonlyMap<string, WorkflowCatalog> = new Map(),
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
    repos: discovered.map((r) => repoReport(r, r.manifest, workflowCatalogs.get(r.root))),
  };
}
