import { z } from 'zod';
import { RepoPath, ExecutionSpec } from './execution-spec';
import { ProjectIntelligenceEpisode } from './intelligence';
import { RunModelUsage } from './runner';

// ---------------------------------------------------------------------------
// Project Memory — shared entities, stable URIs, and wire contracts (PLNR-244,
// Phase 1 of the Project Memory plan; see the "Project Memory — settled
// architecture decisions" doc, referenced below by section as "§n").
//
// SCOPE OF THIS FILE: runtime-neutral zod schemas + types + the entity-URI
// helpers every later phase builds on. No ProjectMemory Durable Object, no D1
// registry, no outbox, no MCP tool, no Vectorize wiring, no Runner code lives
// here — those are PLNR-245 through PLNR-277. This is the one wire shape both
// the server and the (future, vendoring) Runner agree on before either is
// built against it.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Repository and revision identity (§6, §16)
// ---------------------------------------------------------------------------

/**
 * The canonical, project-local repository identity — committed in
 * `.noriq/project.toml`. Stable across re-clones, machine changes, and
 * multiple checkouts of the same repo, which is exactly what a runner-local
 * checkout id is NOT (see `RunnerCheckoutId` below). A short slug, not a path.
 */
export const RepositoryKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9._-]*$/, {
    message: 'must be a short slug (letters, digits, `.`, `_`, `-`), starting with a letter',
  })
  .refine((k) => !k.startsWith('ckt_'), {
    message: 'looks like a runner-local checkout id (§6/§16), not a canonical repository key',
  });
export type RepositoryKey = z.infer<typeof RepositoryKey>;

/**
 * A runner-local checkout/machine identity (§6, §16) — RepoIntel's own key space.
 * Branded so passing one where a `RepositoryKey` is expected is a TYPE ERROR, not
 * a convention someone has to remember; the `ckt_` prefix also makes the two
 * distinguishable at runtime, so a checkout id handed to `RepositoryKey.parse`
 * fails loudly instead of silently validating as a canonical key.
 */
export const RunnerCheckoutId = z
  .string()
  .regex(/^ckt_[A-Za-z0-9]+$/, {
    message: 'a runner-local checkout id is opaque and prefixed `ckt_` — never a canonical repository key',
  })
  .brand('RunnerCheckoutId');
export type RunnerCheckoutId = z.infer<typeof RunnerCheckoutId>;

/**
 * A revision identity in its OWNING VCS backend's own id space (§6) — a Git SHA,
 * a Perforce changelist number, a Diversion commit id. Deliberately just a
 * non-empty string, compared only for equality: parsing this as a Git hash
 * would silently break every non-Git backend. No shared code may format-check,
 * shorten, or normalize a `baseId`.
 */
export const BaseId = z.string().min(1);
export type BaseId = z.infer<typeof BaseId>;

/**
 * A concrete branch name, or a symbolic branch class ("default", "integration")
 * when no single branch applies to the evidence being cited (§1). One field
 * because a consumer treats both the same way: a scope to validate `baseId`
 * freshness against.
 */
export const BranchRef = z.string().min(1);
export type BranchRef = z.infer<typeof BranchRef>;

// ---------------------------------------------------------------------------
// Evidence, authority, and validity (§1, §12, §15)
// ---------------------------------------------------------------------------

export const VerificationState = z.enum(['valid', 'moved', 'changed', 'missing', 'unverifiable']);
export type VerificationState = z.infer<typeof VerificationState>;

/**
 * A repository citation backing a memory (§1). Retrieval verifies this against
 * the best current source available before presenting the memory it belongs
 * to; an evidence set that fails verification demotes its memory to a lead,
 * never an instruction (§13).
 */
export const EvidenceRef = z.object({
  repositoryKey: RepositoryKey,
  branch: BranchRef,
  baseId: BaseId,
  path: RepoPath,
  symbol: z.string().min(1).nullable().default(null),
  contentHash: z.string().min(1).nullable().default(null),
  verificationState: VerificationState.default('unverifiable'),
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;

/** SHA-256 over JSON.stringify's exact UTF-8 bytes. Property insertion order is therefore part
 *  of this wire contract: callers that must reproduce an identity hash should use the shared
 *  higher-level helper rather than reconstructing its object locally. */
export async function canonicalHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type EvidenceIdentity = Pick<EvidenceRef, 'repositoryKey' | 'branch' | 'baseId' | 'path' | 'symbol'>;

/** Stable citation identity shared byte-for-byte by the server and Runner verification tier.
 *  Freshness fields are deliberately excluded: they describe the cited artifact, not the
 *  identity of the citation itself. */
export function evidenceHash(ref: EvidenceIdentity): Promise<string> {
  return canonicalHash({
    repositoryKey: ref.repositoryKey,
    branch: ref.branch,
    baseId: ref.baseId,
    path: ref.path,
    symbol: ref.symbol,
  });
}

/**
 * The five-level authority scale (§12). Higher is stronger; promotion between
 * levels is PLNR-253/266's job, not this schema's — this only fixes the wire
 * values every later phase transitions between.
 *
 *   5 — human-approved decision
 *   4 — verified against merged code or passing tests
 *   3 — repeated successful observation
 *   2 — single-agent observation
 *   1 — hypothesis or unverified inference
 */
export const AuthorityLevel = z.number().int().min(1).max(5);
export type AuthorityLevel = z.infer<typeof AuthorityLevel>;

export const AUTHORITY_HUMAN_APPROVED = 5;
export const AUTHORITY_VERIFIED_MERGED = 4;
export const AUTHORITY_REPEATED_OBSERVATION = 3;
export const AUTHORITY_SINGLE_OBSERVATION = 2;
export const AUTHORITY_HYPOTHESIS = 1;

// ---------------------------------------------------------------------------
// Memory — the one kind-driven recording surface (§11)
// ---------------------------------------------------------------------------

/**
 * What an agent (or a human) is recording. Feedback, correction, contradiction,
 * and supersession are OPERATIONS on a `MemoryItem` (see `supersedesMemoryId`
 * below), not separate kinds or record types — the agent-facing tool catalogue
 * must not multiply (§11, PLNR-252).
 */
export const MemoryKind = z.enum([
  'learning',
  'decision',
  'failed_approach',
  'procedure',
  'requirement',
  'hazard',
  'unknown',
]);
export type MemoryKind = z.infer<typeof MemoryKind>;

/**
 * A recorded memory candidate. `statement` is untrusted model output the
 * moment it is written by anyone but a human (§13) — every consumer renders it
 * inside a bounded quoted-evidence frame, never in instruction position.
 * Versioning is `supersedesMemoryId`: a new version links back rather than
 * overwriting, so history is never destructively erased (§12).
 */
export const MemoryItem = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: MemoryKind,
  statement: z.string().min(1),
  authority: AuthorityLevel.default(AUTHORITY_HYPOTHESIS),
  confidence: z.number().min(0).max(1).nullable().default(null),
  evidence: z.array(EvidenceRef).default([]),
  supersedesMemoryId: z.string().nullable().default(null),
  recordedByAgentId: z.string().nullable().default(null),
  recordedAt: z.string().datetime(),
});
export type MemoryItem = z.infer<typeof MemoryItem>;

// ---------------------------------------------------------------------------
// The project knowledge graph (§5)
// ---------------------------------------------------------------------------

/**
 * The fixed graph node vocabulary. Broader than the entity-URI kinds below —
 * it also covers internal graph-only nodes (branch, revision, agent, error,
 * API, database entity, project) that are not independently addressable
 * top-level entities.
 */
export const MemoryNodeType = z.enum([
  'project',
  'repository',
  'branch',
  'revision',
  'file',
  'symbol',
  'api',
  'database_entity',
  'test',
  'task',
  'plan',
  'run',
  'agent',
  'decision',
  'memory',
  'error',
  'requirement',
  'procedure',
  'episode',
  'artifact',
  'unknown',
]);
export type MemoryNodeType = z.infer<typeof MemoryNodeType>;

export const MemoryEdgeType = z.enum([
  'declares',
  'calls',
  'imports',
  'depends_on',
  'tests',
  'implements',
  'modifies',
  'observed_in',
  'decided_by',
  'supersedes',
  'contradicts',
  'blocks',
  'related_to',
  'failed_because',
  'validated_by',
  'owned_by',
  'commonly_changes_with',
  'derived_from',
]);
export type MemoryEdgeType = z.infer<typeof MemoryEdgeType>;

/**
 * A durable typed node (§5). `uri` is this node's stable entity URI
 * (`buildEntityUri`) — the `.refine` below rejects a malformed URI and a URI
 * whose own embedded project (for repository-scoped kinds) disagrees with
 * this node's `projectKey`, so a graph edge can never silently cross projects
 * through a bad reference.
 */
export const MemoryNode = z
  .object({
    id: z.string(),
    projectKey: z.string().min(1).max(8),
    type: MemoryNodeType,
    uri: z.string().min(1),
    label: z.string().min(1),
  })
  .refine(
    (node) => {
      const parsed = safeParseEntityUri(node.uri);
      if (!parsed) return false;
      if ('projectKey' in parsed && parsed.projectKey !== node.projectKey) return false;
      return true;
    },
    { message: 'uri must be a well-formed entity URI belonging to this node\'s project' },
  );
export type MemoryNode = z.infer<typeof MemoryNode>;

export const MemoryEdge = z.object({
  projectKey: z.string().min(1).max(8),
  type: MemoryEdgeType,
  fromNodeId: z.string(),
  toNodeId: z.string(),
});
export type MemoryEdge = z.infer<typeof MemoryEdge>;

// ---------------------------------------------------------------------------
// Effort episodes (§14)
// ---------------------------------------------------------------------------

export const EpisodeTimelineEntry = z.object({
  at: z.string().datetime(),
  label: z.string().min(1),
});
export type EpisodeTimelineEntry = z.infer<typeof EpisodeTimelineEntry>;

export const EpisodeFinding = z.object({
  summary: z.string().min(1),
  severity: z.enum(['info', 'low', 'medium', 'high']).default('info'),
});
export type EpisodeFinding = z.infer<typeof EpisodeFinding>;

/**
 * The optional final agent self-summary (§14) — enrichment only. Deliberately
 * NOT load-bearing: `EffortEpisode.selfSummary` below catches a malformed
 * value rather than rejecting the whole episode, because a model's own
 * summary can never be a validity dependency for telemetry the daemon and
 * server already captured deterministically.
 */
export const EpisodeSelfSummary = z.object({
  approachSummary: z.string().default(''),
  rejectedHypotheses: z.array(z.string()).default([]),
  durableLearnings: z.array(z.string()).default([]),
  unresolvedQuestions: z.array(z.string()).default([]),
});
export type EpisodeSelfSummary = z.infer<typeof EpisodeSelfSummary>;

export const EpisodeLandingOutcome = z.enum(['landed', 'not_landed', 'failed', 'pending']);
export type EpisodeLandingOutcome = z.infer<typeof EpisodeLandingOutcome>;

/**
 * Every terminal run produces one of these (§14). The skeleton
 * (everything but `selfSummary`) is REQUIRED and built entirely from
 * deterministic Runner/server telemetry — a failed run that disproves an
 * approach is useful project progress and remains retrievable.
 */
export const EffortEpisode = z.object({
  id: z.string(),
  projectId: z.string(),
  runId: z.string(),
  taskId: z.string().nullable().default(null),
  repositoryKey: RepositoryKey.nullable().default(null),
  baseId: BaseId.nullable().default(null),
  timeline: z.array(EpisodeTimelineEntry).default([]),
  filesTouched: z.array(RepoPath).default([]),
  commands: z.array(z.string()).default([]),
  testsRun: z.array(z.string()).default([]),
  failures: z.array(z.string()).default([]),
  findings: z.array(EpisodeFinding).default([]),
  reviewRounds: z.number().int().nonnegative().default(0),
  tokenUsage: RunModelUsage.default({}),
  costUSD: z.number().nonnegative().default(0),
  acceptanceCoverage: z.number().min(0).max(1).nullable().default(null),
  steeringEvents: z.array(z.string()).default([]),
  landingOutcome: EpisodeLandingOutcome.default('pending'),
  remainingWork: z.array(z.string()).default([]),
  // PLNR-290: additive analytics-grade facts. Absence is permanent backwards compatibility,
  // not a legacy error — old Runners/episodes remain valid and later extraction reports the
  // corresponding metrics as unavailable.
  intelligence: ProjectIntelligenceEpisode.nullable().optional(),
  // Absent OR malformed both leave the episode valid (§14) — `.catch(null)` swallows a bad
  // self-summary rather than failing the whole record's parse.
  selfSummary: EpisodeSelfSummary.nullable().default(null).catch(null),
  createdAt: z.string().datetime(),
});
export type EffortEpisode = z.infer<typeof EffortEpisode>;

// ---------------------------------------------------------------------------
// Repository ingest — index generations and batches (§7, §8)
// ---------------------------------------------------------------------------

/**
 * The manifest for one staged index generation (§8). Stays staged — queryable
 * only as "pending" — until its counts, hashes, and deletions validate; only
 * then does one atomic activation transaction select it as the project's
 * active generation for this repository.
 */
export const IndexGenerationManifest = z.object({
  generationId: z.string().min(1),
  projectId: z.string(),
  repositoryKey: RepositoryKey,
  branch: BranchRef,
  baseId: BaseId,
  indexerVersion: z.string().min(1),
  batchCount: z.number().int().positive(),
  fileCount: z.number().int().nonnegative(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256 hex digest'),
  deletions: z.array(RepoPath).default([]),
  createdAt: z.string().datetime(),
});
export type IndexGenerationManifest = z.infer<typeof IndexGenerationManifest>;

/**
 * One idempotent unit of a generation's ingest (§8) — idempotency key is
 * (project, repository, branch, baseId, indexer version, batch number), i.e.
 * `generationId` (which already encodes the first five) plus `batchNumber`.
 */
export const IndexBatch = z.object({
  generationId: z.string().min(1),
  batchNumber: z.number().int().nonnegative(),
  batchHash: z.string().min(1),
});
export type IndexBatch = z.infer<typeof IndexBatch>;

/**
 * One decoded JSONL row in an index batch. This is a vendored Runner/server wire contract for
 * the transport shape. Types remain non-empty strings here because staged generations retain
 * malformed entities for validation/projection diagnostics; MemoryNodeType/MemoryEdgeType are
 * enforced at that later boundary. `content` defaults to null so indexers may omit it for node
 * kinds without searchable text.
 */
export const StagedEntityRow = z.object({
  kind: z.literal('node'),
  uri: z.string().min(1),
  type: z.string().min(1),
  label: z.string().min(1),
  content: z.string().nullable().default(null),
});
export type StagedEntityRow = z.infer<typeof StagedEntityRow>;

export const StagedEdgeRow = z.object({
  kind: z.literal('edge'),
  type: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
});
export type StagedEdgeRow = z.infer<typeof StagedEdgeRow>;

export const StagedRow = z.discriminatedUnion('kind', [StagedEntityRow, StagedEdgeRow]);
export type StagedRow = z.infer<typeof StagedRow>;

// ---------------------------------------------------------------------------
// Runner-reachable index cursor + checkout association (§4/§6/§7, PLNR-306)
//
// The response shapes for POST /api/runner-memory/index-cursor — the agentAuth read a runner
// daemon uses for RUN-213's reconciliation (unchanged / incremental / full / incompatible-version
// / association-error) and, separately, whether ITS OWN checkout is associated with the canonical
// repository it resolved to. Mirrors the server's own `IndexGenerationSummary`
// (apps/api/src/do/ProjectMemory.ts) and `RepositoryMemoryState`/`CheckoutAssociationState`
// (apps/api/src/lib/project-memory.ts) field-for-field; this is the vendored slice the runner
// re-vendors against (server lands first, see VENDORED-CONTRACT.md), not an import of either.
// ---------------------------------------------------------------------------

/** One `index_generations` row as the runner needs it — same fields as the operator-facing
 *  `IndexGenerationSummary`. */
export const RunnerIndexGeneration = z.object({
  id: z.string(),
  branch: z.string(),
  baseId: z.string(),
  indexerVersion: z.string(),
  status: z.enum(['staged', 'active', 'superseded']),
  batchCount: z.number().int(),
  fileCount: z.number().int(),
  sealedAt: z.string().nullable(),
  validationProblems: z.array(z.string()),
  createdAt: z.string(),
  activatedAt: z.string().nullable(),
});
export type RunnerIndexGeneration = z.infer<typeof RunnerIndexGeneration>;

/** A staged generation plus whether it is safe to treat as a resume target — sealed with zero
 *  validation problems. */
export const RunnerStagedGeneration = RunnerIndexGeneration.extend({ validated: z.boolean() });
export type RunnerStagedGeneration = z.infer<typeof RunnerStagedGeneration>;

/**
 * Whether ONE runner-local checkout (`RunnerRepo.id`) is associated with the canonical repository
 * it resolved to (§4) — derived live from `repository_checkouts`, never a stored column. 'conflict'
 * is distinguishable from 'not-associated': a checkout bound to a DIFFERENT canonical repository is
 * a visible failure (§4's "ambiguous or conflicting associations are visible, never silently
 * rebound"), not the same as never having been associated at all.
 */
export const RunnerCheckoutAssociationState = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not-associated') }),
  z.object({ state: z.literal('associated'), projectRepositoryId: z.string() }),
  z.object({ state: z.literal('conflict'), projectRepositoryId: z.string(), reason: z.string() }),
]);
export type RunnerCheckoutAssociationState = z.infer<typeof RunnerCheckoutAssociationState>;

/** The response of POST /api/runner-memory/index-cursor — everything RUN-213's reconciliation
 *  needs for one (repositoryKey, checkout) in a single round trip: the active generation's
 *  baseId/branch/indexerVersion, staged generations for a resume decision, `stale` (computed by
 *  the SAME code the human-facing GET /api/projects/:pid/memory/repositories uses — never a
 *  second, independently-drifting copy), and the checkout's own association state. */
export const RunnerIndexCursor = z.object({
  repositoryKey: RepositoryKey,
  defaultBranch: z.string().nullable(),
  latestObservedBase: z.string().nullable(),
  activeGeneration: RunnerIndexGeneration.nullable(),
  stagedGenerations: z.array(RunnerStagedGeneration),
  stale: z.boolean(),
  failedIngest: z.boolean(),
  failedIngestProblems: z.array(z.string()),
  association: RunnerCheckoutAssociationState,
});
export type RunnerIndexCursor = z.infer<typeof RunnerIndexCursor>;

// ---------------------------------------------------------------------------
// Context packs (§10, PLNR-267)
// ---------------------------------------------------------------------------

/** Which run kind (or a human) the pack was assembled for (task's own locked decision: role only
 *  REWEIGHTS section budgets — authority is a property of the record (§12), never of who asked). */
export const ContextPackRole = z.enum(['scope', 'build', 'verify', 'human']);
export type ContextPackRole = z.infer<typeof ContextPackRole>;

/** Mirrors `searchProjectMemory`'s own `mode` (§20: "surface it rather than inventing a second
 *  signal") — 'keyword' names the degraded (no Vectorize/AI binding) path honestly. */
export const ContextPackMode = z.enum(['semantic', 'keyword']);
export type ContextPackMode = z.infer<typeof ContextPackMode>;

/**
 * Which retrieval stage produced a section's content. Shares its four retrieval-stage values
 * with `apps/api/src/memory/retrieval.ts`'s `RetrievalStage` BY CONVENTION, not by import —
 * shared has no dependency on the Worker's internal modules. `coordination` is a plain D1 read
 * (file locks, not memory retrieval); `similar-effort` is PLNR-264's own composed primitive;
 * `required` marks the task's own facts (never a retrieval result); `none` marks a section with
 * nothing to show because there was genuinely nothing to retrieve (NOT the same claim as a
 * `ContextPackNotice` of kind 'unanswerable' — see that type's own comment).
 */
export const ContextPackProvenance = z.enum([
  'exact', 'lexical', 'semantic', 'graph', 'coordination', 'similar-effort', 'required', 'none',
]);
export type ContextPackProvenance = z.infer<typeof ContextPackProvenance>;

/**
 * One evidence citation as rendered inside an excerpt (§1/§12/§13/§15, PLNR-265) — always read
 * live from the canonical `evidence` row at assembly time (never from vector metadata), and
 * always carrying the base/branch it was ACTUALLY last checked against, so `verifiedForCaller`
 * can never be confused with "verified somewhere, at some point" — the load-bearing distinction
 * the task's own acceptance names ("a memory whose citations were verified at a different base is
 * not presented as verified for the caller's base").
 */
export const ContextPackCitation = z.object({
  repositoryKey: z.string(),
  branch: z.string(),
  baseId: z.string(),
  path: z.string(),
  symbol: z.string().nullable(),
  verificationState: VerificationState,
  lastVerifiedAt: z.string().nullable(),
  lastVerifiedBaseId: z.string().nullable(),
  lastVerifiedBranch: z.string().nullable(),
  /** `memory/verification.ts`'s `verifiedForBase`, evaluated against THIS caller's own
   *  branch/baseId at assembly time — not merely `verificationState === 'valid'`. */
  verifiedForCaller: z.boolean(),
});
export type ContextPackCitation = z.infer<typeof ContextPackCitation>;

/**
 * A memory item as it appears inside a context pack. Self-contained by construction (locked
 * decision): authority, validity, and every citation's evidence travel WITH the excerpt, so a
 * consumer never has to cross-reference another section of the pack to judge whether to trust it.
 * `statement` is untrusted model output the moment it was written by anyone but a human (§13) —
 * PLNR-270 is the deferred quoted-evidence RENDERER that wraps this; this schema is only the
 * structured seam it wraps, deliberately not pre-flattened into prose.
 */
export const ContextPackMemoryExcerpt = z.object({
  excerptKind: z.literal('memory'),
  id: z.string(),
  memoryKind: MemoryKind,
  statement: z.string(),
  /** True only when a bounded presentation surface shortened the canonical statement. The
   * canonical memory row is untouched; consumers must present this as an excerpt. */
  statementTruncated: z.boolean().optional(),
  authority: AuthorityLevel,
  confidence: z.number().min(0).max(1).nullable(),
  validity: z.string(),
  isLead: z.boolean(),
  leadReasons: z.array(z.string()),
  evidence: z.array(ContextPackCitation),
  // Carried straight from the canonical row (never fabricated at assembly time) — determinism
  // (stated acceptance: "identical inputs produce a byte-identical pack") requires this, since a
  // freshly-minted timestamp on every call would make two assemblies of the SAME memory differ.
  recordedByAgentId: z.string().nullable(),
  recordedAt: z.string().datetime(),
  supersedesMemoryId: z.string().nullable(),
});
export type ContextPackMemoryExcerpt = z.infer<typeof ContextPackMemoryExcerpt>;

/**
 * An effort episode as it appears inside a context pack (§14, PLNR-264). `support` IS this
 * excerpt's evidence — `memory/similar-effort.ts`'s own contract is that every support entry
 * resolves back to a real, inspectable overlap — so an episode excerpt carries the same
 * self-contained property as a memory excerpt without being forced into memory's
 * authority/validity vocabulary, which episodes structurally do not have.
 */
export const ContextPackEpisodeExcerpt = z.object({
  excerptKind: z.literal('episode'),
  id: z.string(),
  runId: z.string(),
  taskId: z.string().nullable(),
  taskKey: z.string().nullable(),
  runKind: z.string(),
  outcome: z.string(),
  landingOutcome: EpisodeLandingOutcome,
  whatWasAttempted: z.string(),
  whatFailed: z.array(z.string()),
  whatRemainsUncertain: z.array(z.string()),
  support: z.array(z.object({ kind: z.string(), detail: z.string() })),
});
export type ContextPackEpisodeExcerpt = z.infer<typeof ContextPackEpisodeExcerpt>;

export const ContextPackExcerpt = z.discriminatedUnion('excerptKind', [ContextPackMemoryExcerpt, ContextPackEpisodeExcerpt]);
export type ContextPackExcerpt = z.infer<typeof ContextPackExcerpt>;

/** A graph entity as it appears inside a context pack — the same addressable shape
 *  `memory/graph-queries.ts`'s `RelatedEntity` already returns, re-declared here (shared has no
 *  dependency on apps/api) rather than imported. `edgePath` is the same raw `from>type>to;...`
 *  wire string `searchProjectMemory`'s hits already carry. */
export const ContextPackGraphEntity = z.object({
  uri: z.string(),
  type: z.string(),
  label: z.string(),
  depth: z.number().int().nonnegative(),
  edgePath: z.string(),
});
export type ContextPackGraphEntity = z.infer<typeof ContextPackGraphEntity>;

/** `memory/graph-queries.ts`'s own completeness marker (§2), re-declared for the same
 *  no-apps/api-dependency-from-shared reason as `ContextPackGraphEntity` above. `complete: false`
 *  means "this graph cannot fully answer that yet" — never conflate it with "nothing is related"
 *  (the same honesty rule every `ContextPackNotice` below also carries). */
export const ContextPackCoverage = z.object({
  complete: z.boolean(),
  reasons: z.array(z.string()),
  edgeTypesWithNoWriter: z.array(z.string()).optional(),
});
export type ContextPackCoverage = z.infer<typeof ContextPackCoverage>;

/**
 * The honesty layer every section carries (locked decision, and the same distinction
 * `explain_project_area`'s `coverage` field already enforces): a section with nothing in it
 * either genuinely found nothing (`notice: null` — an answerable question with an empty answer)
 * or could not be answered at all (`kind: 'unanswerable'` — the question itself could not be put
 * to this project, e.g. file locking is off, or the graph has no seed to expand from). `truncated`
 * fires whenever the section's character budget cut real, retrieved content, independent of
 * whether anything survived to be shown.
 */
/**
 * `required_facts_exceeded_budget` is a PACK-level notice, never a section one (locked decision:
 * required task facts are never displaced or truncated by budget) — distinguishable on purpose
 * from `truncated` (content was cut to fit) and `unanswerable` (a question could not be put to
 * this project at all): here nothing was cut and nothing was unanswerable — the mandatory floor
 * itself is simply bigger than what the caller asked for, and a consumer building a prompt
 * against a real token ceiling needs to know that distinction, not infer it by comparing
 * `charBudget` against `charsUsed`.
 */
export const ContextPackNoticeKind = z.enum(['truncated', 'unanswerable', 'required_facts_exceeded_budget']);
export type ContextPackNoticeKind = z.infer<typeof ContextPackNoticeKind>;
export const ContextPackNotice = z.object({ kind: ContextPackNoticeKind, reason: z.string() });
export type ContextPackNotice = z.infer<typeof ContextPackNotice>;

/** The fixed, priority-ordered section list (locked decision: "declared as data ... not implied
 *  by statement order in the code") — see `apps/api/src/memory/context-pack.ts`'s `SECTION_ORDER`
 *  for the actual fill order and per-section budget weights this vocabulary is filled against. */
export const ContextPackSectionId = z.enum([
  'active_decisions',
  'known_hazards',
  'failed_approaches',
  'relevant_memories',
  'similar_episodes',
  'graph_neighborhood',
  'affected_tests',
  'active_neighboring_work',
  'uncertainty',
  'source_excerpts',
]);
export type ContextPackSectionId = z.infer<typeof ContextPackSectionId>;

export const ContextPackSection = z.object({
  id: ContextPackSectionId,
  provenance: z.array(ContextPackProvenance),
  notice: ContextPackNotice.nullable(),
  charsAllotted: z.number().int().nonnegative(),
  charsUsed: z.number().int().nonnegative(),
  excerpts: z.array(ContextPackExcerpt).default([]),
  graphEntities: z.array(ContextPackGraphEntity).default([]),
  coverage: ContextPackCoverage.nullable().default(null),
  /** Structured content that fits neither `excerpts` nor `graphEntities` — currently only
   *  `active_neighboring_work`'s file-lock/task summaries. Kept as opaque JSON-safe records
   *  rather than growing the union for one ad hoc shape. */
  items: z.array(z.record(z.string(), z.unknown())).default([]),
});
export type ContextPackSection = z.infer<typeof ContextPackSection>;

/**
 * The task's own required facts (locked decision: allocated budget FIRST, from a reserved floor,
 * and never displaced or truncated by anything else in the pack). Deliberately NOT a
 * `ContextPackSection` and NOT a member of `ContextPack.sections` — so nothing that walks
 * `sections` to reason about remaining budget can accidentally treat this as compressible.
 */
export const ContextPackTaskFacts = z.object({
  taskId: z.string(),
  key: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  status: z.string(),
  priority: z.number().int(),
  claimedBy: z.string().nullable(),
  claimExpiresAt: z.string().nullable(),
  openComments: z.array(z.object({
    id: z.string(), kind: z.string(), body: z.string(),
    authorKind: z.string(), authorId: z.string().nullable(), createdAt: z.string(),
  })),
  executionSpec: ExecutionSpec.nullable(),
  executionSpecUnreadable: z.boolean(),
});
export type ContextPackTaskFacts = z.infer<typeof ContextPackTaskFacts>;

/**
 * The assembled result of `get_task_context(taskId, branch, baseId,
 * tokenBudget)` (§10) — bounded working memory for one task, not a bag of
 * disconnected vector chunks. Entities are referenced by their stable URIs so
 * a consumer can re-fetch or cite them.
 *
 * PLNR-267 is this schema's FIRST real consumer (it shipped in PLNR-244 unused) and extends it
 * additively per that task's locked decision: every pre-existing field name and shape below is
 * unchanged, now populated with real content, plus the FULL rich structure — provenance, honesty
 * notices, self-contained excerpts with live evidence, and the task's own required facts — in the
 * new fields beneath them. `verifiedDecisions`/`knownHazards` stay `MemoryItem[]` (that schema has
 * no `validity`/`isLead` of its own) as lightweight, pre-existing-shape pointers; the rich picture
 * (authority, validity, per-citation base-scoped verification, lead reasons) lives in `sections`.
 */
export const ContextPack = z.object({
  taskId: z.string(),
  projectId: z.string(),
  branch: BranchRef.nullable().default(null),
  baseId: BaseId.nullable().default(null),
  tokenBudget: z.number().int().positive().nullable().default(null),
  verifiedDecisions: z.array(MemoryItem).default([]),
  relevantEntities: z.array(z.string().min(1)).default([]), // entity URIs
  similarEpisodes: z.array(z.string().min(1)).default([]), // episode ids
  knownHazards: z.array(MemoryItem).default([]),
  affectedTests: z.array(z.string().min(1)).default([]), // entity URIs (kind: 'test')
  activeNeighboringWork: z.array(z.string().min(1)).default([]), // task ids
  staleWarnings: z.array(z.string().min(1)).default([]),
  generatedAt: z.string().datetime(),
  // --- PLNR-267 additive extension ------------------------------------------------------------
  role: ContextPackRole.default('human'),
  mode: ContextPackMode.default('keyword'),
  /** The enforced character budget this pack was assembled against — `tokenBudget * a named
   *  chars-per-token constant`, or a fixed default when the caller supplied no `tokenBudget` at
   *  all. See `apps/api/src/memory/context-pack.ts`'s `CHARS_PER_TOKEN` for why characters, never
   *  a real tokenizer (§20, locked decision: deterministic, no optional-binding dependency). */
  charBudget: z.number().int().positive(),
  charsUsed: z.number().int().nonnegative(),
  taskFacts: ContextPackTaskFacts,
  sections: z.array(ContextPackSection),
  /** Pack-level honesty notices — the same `notice` mechanism `sections[]` carries, at the whole-
   *  pack level. Today the only producer is `required_facts_exceeded_budget` (the required-facts
   *  floor is bigger than `charBudget`), but this is a list, not a single nullable field, so a
   *  later pack-level notice has somewhere to go without another additive schema change. */
  notices: z.array(ContextPackNotice).default([]),
});
export type ContextPack = z.infer<typeof ContextPack>;

// ---------------------------------------------------------------------------
// Briefing memory pulse (§1/§13/§20, PLNR-268)
//
// get_briefing is the FIRST call of every session — before any task is claimed, so there is no
// task to anchor a ContextPack to. This is a lighter, project-scoped sibling: not one task's
// working context, but "what's recently changed / active / unresolved in this project" — bounded
// the same way (fixed item caps + a fixed character budget, enforced before assembly, never
// trimmed after) and carrying the same authority/validity/citation shape (`ContextPackMemoryExcerpt`)
// so a memory item reads identically here and inside a `ContextPack`. See
// `apps/api/src/sync.ts`'s `assembleProjectMemoryPulse` for the assembler.
// ---------------------------------------------------------------------------

/** The fixed, priority-ordered section list for the briefing pulse — deliberately smaller than
 *  `ContextPackSectionId`'s ten: get_briefing has no task/query/branch to anchor a similarity or
 *  graph-neighborhood search to, so `similar_episodes`/`graph_neighborhood`/`affected_tests` are
 *  not attempted here at all (discretion: "fewer, genuinely useful sections beat all seven thin
 *  ones") — they remain fully available via `search_project_memory`/`get_task_context` once real
 *  work starts. */
export const ProjectMemoryPulseSectionId = z.enum([
  'active_decisions',
  'known_hazards',
  'unresolved_unknowns',
  'stale_warnings',
  'active_nearby_work',
  'recent_changes',
]);
export type ProjectMemoryPulseSectionId = z.infer<typeof ProjectMemoryPulseSectionId>;

/** One compact "something changed" line, read straight off a `memory.changed` outbox event's own
 *  payload (PLNR-247) — never a second query beyond the `events` row itself. Deliberately carries
 *  no `statement`/free text: this is the ONE briefing field close enough to plain status prose
 *  (rendered next to `notices`) that untrusted memory content must never ride it (§13) — the
 *  richer, clearly-evidence-framed excerpt lives in `activeDecisions`/`knownHazards`/
 *  `unresolvedUnknowns`/`staleWarnings` instead. */
export const ProjectMemoryChangeSummary = z.object({
  entityType: z.string(),
  kind: z.string().nullable(),
  memoryItemId: z.string().nullable(),
  at: z.string().datetime(),
});
export type ProjectMemoryChangeSummary = z.infer<typeof ProjectMemoryChangeSummary>;

/** A stale-memory warning, reported from the memory's own CANONICAL `validity` at read time —
 *  never a heuristic recomputed here (locked decision: PLNR-254/265 already own validity and
 *  verification). `reason` is the transition's own recorded reason when the outbox event carried
 *  one, `null` otherwise (e.g. an automatic low-authority decay has no per-item reason). */
export const ProjectMemoryStaleWarning = z.object({
  memoryItemId: z.string(),
  kind: MemoryKind.nullable(),
  statement: z.string().nullable(),
  statementTruncated: z.boolean().optional(),
  validity: z.string(),
  reason: z.string().nullable(),
  at: z.string().datetime(),
});
export type ProjectMemoryStaleWarning = z.infer<typeof ProjectMemoryStaleWarning>;

/** "Someone else is actively working near here" — a plain D1 coordination read (another agent's
 *  current claim in the same project), not memory retrieval at all. Assembled inside the SAME
 *  bounded block as the memory sections above (one predictable degrade-together unit) rather than
 *  as its own always-available field — see the assembler's own doc comment for why. */
export const ProjectMemoryNearbyWork = z.object({
  taskId: z.string(),
  taskKey: z.string(),
  title: z.string(),
  claimedByAgentId: z.string(),
  status: z.string(),
});
export type ProjectMemoryNearbyWork = z.infer<typeof ProjectMemoryNearbyWork>;

/**
 * The bounded block `get_briefing` additively carries under a new top-level `memory` key
 * (ADDITIVE — every pre-existing get_briefing field is untouched by this type's existence).
 * Supplemental evidence only (locked decision, §1): nothing in here ever changes a coordination
 * fact elsewhere in the response, and every memory item carries its own authority/validity/
 * evidence so a consumer never has to trust it blindly. `null` (not an error) is the honest
 * degraded state — the agent has no localized project to scope this to, or ProjectMemory itself
 * threw/was unreachable (§19/§20): get_briefing's OTHER fields are entirely unaffected either way.
 */
export const ProjectMemoryPulse = z.object({
  projectId: z.string(),
  generatedAt: z.string().datetime(),
  charBudget: z.number().int().positive(),
  charsUsed: z.number().int().nonnegative(),
  activeDecisions: z.array(ContextPackMemoryExcerpt).default([]),
  knownHazards: z.array(ContextPackMemoryExcerpt).default([]),
  unresolvedUnknowns: z.array(ContextPackMemoryExcerpt).default([]),
  staleWarnings: z.array(ProjectMemoryStaleWarning).default([]),
  activeNearbyWork: z.array(ProjectMemoryNearbyWork).default([]),
  recentChanges: z.array(ProjectMemoryChangeSummary).default([]),
  notices: z.array(ContextPackNotice).default([]),
});
export type ProjectMemoryPulse = z.infer<typeof ProjectMemoryPulse>;

// ---------------------------------------------------------------------------
// Backup manifests (§17)
// ---------------------------------------------------------------------------

/**
 * A portable logical snapshot's manifest (§17). Restore imports into a new
 * dataset generation, validates `tableCounts`/`checksums` against what was
 * actually imported, and only then atomically switches the active generation.
 */
export const MemoryBackupManifest = z.object({
  formatVersion: z.number().int().positive(),
  projectMemorySchemaVersion: z.number().int().positive(),
  projectId: z.string(),
  memoryRevision: z.number().int().nonnegative(),
  exportedAt: z.string().datetime(),
  // core = authored/historical memory, evidence, decisions, episodes, feedback, graph, cursors,
  // and the index-generation REGISTRY rows. full additionally includes active code-index
  // generation CONTENT (§17) — which does not exist before Phase 5, so `full` today carries
  // exactly what `core` does; the flag exists so the manifest format never has to change shape
  // when Phase 5 fills that tier in.
  tier: z.enum(['core', 'full']).default('core'),
  tableCounts: z.record(z.string(), z.number().int().nonnegative()),
  checksums: z.record(z.string(), z.string()),
  activeIndexGenerations: z
    .array(z.object({ repositoryKey: RepositoryKey, generationId: z.string().min(1) }))
    .default([]),
  r2EvidenceRefs: z.array(z.string().min(1)).default([]),
});
export type MemoryBackupManifest = z.infer<typeof MemoryBackupManifest>;

// ---------------------------------------------------------------------------
// Stable entity URIs (§18)
//
// Identity never embeds an index generation, a baseId, or a runner-local id —
// that is the scaling seam §18 reserves for moving large repository code
// intelligence to its own store without changing agent-facing identities.
// Two shapes:
//
//   noriq://{kind}/{id}                                        — global kinds,
//     for entities Noriq already mints a globally-unique id for.
//   noriq://{kind}/{projectKey}/{repositoryKey}[/{path}][#{name}] — repository-
//     scoped kinds, project-local by construction.
// ---------------------------------------------------------------------------

// A project key as it appears embedded in a URI. Deliberately re-declared here
// rather than imported from `./manifest` — manifest.ts imports `RepositoryKey`
// FROM this file (it hosts the committed `[index]`/`repositoryKey` fields), so
// importing manifest's `ProjectKey` back would be a cycle. Same shape as
// `ProjectKey` there (`z.string().min(1).max(8)`) by construction, not by import.
const EntityProjectKey = z.string().min(1).max(8);
const GlobalEntityId = z.string().min(1);

/**
 * Every addressable entity kind (§18, task body): 11 global kinds — Noriq
 * already mints a globally-unique id for each — plus 4 repository-scoped
 * kinds that are project-local by construction. One explicit literal per
 * kind, rather than building the union from an array, so the discriminated
 * union's per-branch typing stays exact with no cast.
 */
export const EntityRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), id: GlobalEntityId }),
  z.object({ kind: z.literal('plan'), id: GlobalEntityId }),
  z.object({ kind: z.literal('run'), id: GlobalEntityId }),
  z.object({ kind: z.literal('decision'), id: GlobalEntityId }),
  z.object({ kind: z.literal('memory'), id: GlobalEntityId }),
  z.object({ kind: z.literal('episode'), id: GlobalEntityId }),
  z.object({ kind: z.literal('requirement'), id: GlobalEntityId }),
  z.object({ kind: z.literal('procedure'), id: GlobalEntityId }),
  z.object({ kind: z.literal('hazard'), id: GlobalEntityId }),
  z.object({ kind: z.literal('artifact'), id: GlobalEntityId }),
  z.object({ kind: z.literal('unknown'), id: GlobalEntityId }),
  // agent (PLNR-263) — added so an episode's `owned_by` edge has an addressable target. Agent
  // ids are already globally unique (one row per MCP session/run, never project-scoped by
  // construction — see CLAUDE.md's identity model), so the GLOBAL shape is correct: no
  // projectKey/repositoryKey segment, exactly like task/run/decision above. `nodes.type`'s CHECK
  // constraint already permits 'agent' (0001), so — like PLNR-278's api/database_entity — this is
  // a pure widening with no migration. First stored URI locks the shape forever (buildEntityUri's
  // doc comment): never re-shape this arm after this change.
  z.object({ kind: z.literal('agent'), id: GlobalEntityId }),
  z.object({ kind: z.literal('repository'), projectKey: EntityProjectKey, repositoryKey: RepositoryKey }),
  z.object({
    kind: z.literal('file'),
    projectKey: EntityProjectKey,
    repositoryKey: RepositoryKey,
    path: RepoPath,
  }),
  z.object({
    kind: z.literal('symbol'),
    projectKey: EntityProjectKey,
    repositoryKey: RepositoryKey,
    path: RepoPath,
    name: z.string().min(1),
  }),
  z.object({
    kind: z.literal('test'),
    projectKey: EntityProjectKey,
    repositoryKey: RepositoryKey,
    path: RepoPath,
    name: z.string().min(1),
  }),
  // api/database_entity (PLNR-278) — added so PLNR-262 can project CodeEntityType's api and
  // database_entity kinds; `nodes.type`'s CHECK constraint already permits both (0001), so this
  // is a pure schema widening with no migration. An API endpoint is declared at a path like a
  // symbol, so it takes the same {path}#{name} shape; a database entity (a table, a schema
  // object) is not reliably one-file-one-entity, so it stays path-free — a repository-scoped
  // name only. The first stored URI locks the shape, so this is a deliberate choice, not a
  // placeholder: revisit only by adding a NEW kind, never by editing these arms once anything
  // has stored a URI built from them.
  z.object({
    kind: z.literal('api'),
    projectKey: EntityProjectKey,
    repositoryKey: RepositoryKey,
    path: RepoPath,
    name: z.string().min(1),
  }),
  z.object({
    kind: z.literal('database_entity'),
    projectKey: EntityProjectKey,
    repositoryKey: RepositoryKey,
    name: z.string().min(1),
  }),
]);
export type EntityRef = z.infer<typeof EntityRef>;

const GLOBAL_KIND_SET: ReadonlySet<string> = new Set([
  'task',
  'plan',
  'run',
  'decision',
  'memory',
  'episode',
  'requirement',
  'procedure',
  'hazard',
  'artifact',
  'unknown',
  'agent',
]);

/**
 * Build a stable entity URI from a ref. The inverse of `parseEntityUri`.
 *
 * Fragment convention (settled here for PLNR-262 to respect, PLNR-278): the FIRST `#` in the
 * rest-of-URI separates a repository-scoped kind's `path` from its `name` — `symbol`, `test`,
 * and now `api` all use it. This is a PRE-EXISTING collision the code index's chunk ids must
 * not make worse: `code-index.ts`'s `vecId` appends `#<n>` to a chunk-0-elided uri, so a
 * multi-chunk symbol/test/api entity's vector id already looks like `…#name#3`, and
 * `entityRefCandidate` (splitting on the FIRST `#`) reads that back as `name: "name#3"`. Fixing
 * that chunk-id/name collision is PLNR-262's job (it must use a separator its own chunk suffix
 * cannot produce, e.g. one that never appears in a `#name` fragment) — this file only fixes the
 * kind-segment regex so an UNDERSCORED kind can be parsed at all; it does not change what `#`
 * itself means.
 */
export function buildEntityUri(ref: EntityRef): string {
  switch (ref.kind) {
    case 'repository':
      return `noriq://repository/${ref.projectKey}/${ref.repositoryKey}`;
    case 'file':
      return `noriq://file/${ref.projectKey}/${ref.repositoryKey}/${ref.path}`;
    case 'symbol':
    case 'test':
    case 'api':
      return `noriq://${ref.kind}/${ref.projectKey}/${ref.repositoryKey}/${ref.path}#${ref.name}`;
    case 'database_entity':
      return `noriq://database_entity/${ref.projectKey}/${ref.repositoryKey}/${ref.name}`;
    default:
      return `noriq://${ref.kind}/${ref.id}`;
  }
}

// `[a-z_]+` (not `[a-z]+`) — the ORIGINAL blocker for `database_entity`: an arm alone is not
// enough, because this regex captured the kind segment and a non-matching URI silently became
// `{ kind: '__malformed__' }` rather than failing at the actual bug (a missing underscore).
const ENTITY_URI_RE = /^noriq:\/\/([a-z_]+)\/(.*)$/;

/**
 * Decompose a URI string into a candidate object for `EntityRef.parse` — never
 * throws, never validates; an unrecognized shape becomes `{ kind:
 * '__malformed__' }`, a discriminator no variant matches, so the one call site
 * that actually parses (`EntityRef.parse`/`.safeParse`) produces zod's own
 * "invalid discriminator" error instead of this function hand-rolling one.
 */
function entityRefCandidate(uri: string): unknown {
  const match = ENTITY_URI_RE.exec(uri);
  if (!match) return { kind: '__malformed__' };
  const kind = match[1] ?? '';
  const rest = match[2] ?? '';
  if (GLOBAL_KIND_SET.has(kind)) return { kind, id: rest };
  if (kind === 'repository') {
    const [projectKey, repositoryKey] = rest.split('/');
    return { kind, projectKey, repositoryKey };
  }
  if (kind === 'file') {
    const [projectKey, repositoryKey, ...pathParts] = rest.split('/');
    return { kind, projectKey, repositoryKey, path: pathParts.join('/') };
  }
  if (kind === 'symbol' || kind === 'test' || kind === 'api') {
    const hashIndex = rest.indexOf('#');
    const withoutName = hashIndex === -1 ? rest : rest.slice(0, hashIndex);
    const name = hashIndex === -1 ? undefined : rest.slice(hashIndex + 1);
    const [projectKey, repositoryKey, ...pathParts] = withoutName.split('/');
    return { kind, projectKey, repositoryKey, path: pathParts.join('/'), name };
  }
  if (kind === 'database_entity') {
    const [projectKey, repositoryKey, ...nameParts] = rest.split('/');
    return { kind, projectKey, repositoryKey, name: nameParts.join('/') };
  }
  return { kind: '__malformed__' };
}

/**
 * Parse a stable entity URI. Throws a `ZodError` on anything malformed —
 * wrong scheme, unknown kind, a repository-scoped URI missing a segment, a
 * symbol/test URI missing its `#name`.
 */
export function parseEntityUri(uri: string): EntityRef {
  return EntityRef.parse(entityRefCandidate(uri));
}

/** `parseEntityUri`, returning `null` instead of throwing — for refinements
 *  (see `MemoryNode` above) that need to react to a bad URI without a try/catch. */
function safeParseEntityUri(uri: string): EntityRef | null {
  const result = EntityRef.safeParse(entityRefCandidate(uri));
  return result.success ? result.data : null;
}

// ---------------------------------------------------------------------------
// MemoryNodeType <-> EntityRef drift guard (PLNR-278)
//
// The two vocabularies had silently diverged: MemoryNodeType had 21 values, EntityRef only 15
// arms, and `hazard` was an EntityRef kind that isn't a node type at all. A node type with
// neither an EntityRef arm nor a recorded exemption below now fails at MODULE LOAD (the first
// request on any server that imports this file), rather than being rediscovered as a bug later.
// ---------------------------------------------------------------------------

/**
 * Node types that are graph-only internal nodes with no addressable EntityRef arm YET.
 * Deliberately not designed speculatively: the first URI ever built from a new arm locks its
 * shape forever (byte-identical, no migration path — see `buildEntityUri`'s doc comment), so
 * each of these gets a shape only when a real writer exists to need one:
 *   - `error` — episodes (PLNR-263) keep `failures`/error strings in `body` rather than
 *     inventing an error node/edge for a free-form string (deferred — see the task's notes).
 *   - `branch`, `revision` — no writer anywhere in this codebase yet.
 *   - `project` — the project itself is addressed by its D1 id/key everywhere else in this
 *     system; nothing needs it as a graph-addressable entity today.
 * `agent` graduated out of this set in PLNR-263: episodes' `owned_by` edge is a real writer.
 * Adding an arm removes the exemption in the SAME change — do not carry both.
 */
export const EXEMPT_NODE_TYPES: ReadonlySet<MemoryNodeType> = new Set(['project', 'branch', 'revision', 'error']);

/**
 * The mirror-image asymmetry, recorded rather than "fixed": `hazard` is an EntityRef kind (a
 * `memory_items` row addressable as an entity) but deliberately NOT a MemoryNodeType — a hazard
 * is projected, if at all, as a `memory` graph node, not a distinct node type. Adding it to
 * MemoryNodeType would need a `nodes.type` CHECK migration for a node type nothing needs.
 */
const ENTITY_REF_KINDS: ReadonlySet<string> = new Set(EntityRef.options.map((option) => option.shape.kind.value));

for (const nodeType of MemoryNodeType.options) {
  if (!ENTITY_REF_KINDS.has(nodeType) && !EXEMPT_NODE_TYPES.has(nodeType)) {
    throw new Error(
      `MemoryNodeType "${nodeType}" has neither an EntityRef arm nor a recorded EXEMPT_NODE_TYPES entry — ` +
      'the entity-URI and graph-node vocabularies have drifted (PLNR-278)',
    );
  }
}
