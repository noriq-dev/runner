import type {
  AuthorityLevel,
  BaseId,
  BranchRef,
  ContextPackCitation,
  ContextPackEpisodeExcerpt,
  ContextPackExcerpt,
  ContextPackMemoryExcerpt,
  ContextPackMode,
  ContextPackNotice,
  ContextPackRole,
  ContextPackSection,
  ContextPackTaskFacts,
  EffortEpisode,
  EpisodeFinding,
  EpisodeLandingOutcome,
  EpisodeSelfSummary,
  EpisodeTimelineEntry,
  EvidenceRef,
  IndexBatch,
  IndexGenerationManifest,
  MemoryItem,
  MemoryKind,
  RunnerCheckoutAssociationState,
  RunnerCheckoutId,
  RunnerIndexGeneration,
  RunnerStagedGeneration,
  VerificationState,
} from '@noriq-dev/shared';
import { ContextPack, RepositoryKey, RunnerIndexCursor } from '@noriq-dev/shared';

// ---------------------------------------------------------------------------
// The runner's single import surface for the Project Memory slice (RUN-207).
//
// Every OTHER runner module reaches the memory contract through THIS file, never through
// `@noriq-dev/shared` directly — one seam to widen when phases 4-6 (ingest, batching, episode
// assembly, context-pack rendering) land their own call sites, instead of the import scattering
// across every module that eventually needs a repository key or an episode shape.
//
// Re-exports and narrow edge-validation only, on purpose (locked decision): no ingest client, no
// episode assembler, no indexer, no context renderer. Those own real call sites against the
// runner's worktrees, tallies and transcripts, and belong to the phases that write them.
//
// The re-export set is deliberately NOT the whole slice — it is what canonical repository
// identity, index manifests/batches, episode payloads, evidence/verification, and context packs
// actually need on the runner side today. Widen it as a near phase needs a name, rather than
// pre-exporting the parts nothing calls.
// ---------------------------------------------------------------------------

// Repository and revision identity (§6, §16). `RepositoryKey` is re-exported as a VALUE (the zod
// schema, not just its inferred type) because it is the ONLY validator for a canonical repository
// key (locked decision) — no second regex belongs anywhere in `src/`.
export { RepositoryKey };
export type { RunnerCheckoutId, BaseId, BranchRef };

// Evidence and verification.
export type { EvidenceRef, VerificationState };

// The one kind-driven recording surface (§11) — the vocabulary episode/context-pack excerpts are
// expressed in.
export type { MemoryItem, MemoryKind, AuthorityLevel };

// Repository ingest — index generations and batches (§7, §8).
export type { IndexGenerationManifest, IndexBatch };

// The runner-reachable index cursor (RUN-213, PLNR-306) — `RunnerIndexCursor` is re-exported as a
// VALUE (the zod schema) for the same reason `RepositoryKey` is: it is the ONLY parser this
// daemon runs over `POST /api/runner-memory/index-cursor`'s response body (locked decision — see
// `client.ts`'s `getIndexCursor`). The server computes `stale`/`activeGeneration`/
// `stagedGenerations` with the exact function the human-facing dashboard route uses
// (`deriveRepositoryMemoryState`), so a hand-rolled type here would be a second, independently
// drifting opinion about the same wire shape.
export { RunnerIndexCursor };
export type { RunnerIndexGeneration, RunnerStagedGeneration, RunnerCheckoutAssociationState };

// Effort episodes (§14).
export type {
  EffortEpisode,
  EpisodeTimelineEntry,
  EpisodeFinding,
  EpisodeSelfSummary,
  EpisodeLandingOutcome,
};

// Context packs (§10). `ContextPack` is re-exported as a VALUE for the same reason
// `RepositoryKey`/`RunnerIndexCursor` are: it is the ONLY parser `client.ts`'s `getContextPack`
// runs over `POST /api/runner-memory/context`'s response body (RUN-228 locked decision — "validated
// against the vendored schema"), so no second, independently-typed reading of the same wire shape
// can drift from it.
export { ContextPack };
export type {
  ContextPackRole,
  ContextPackMode,
  ContextPackTaskFacts,
  ContextPackSection,
  ContextPackExcerpt,
  ContextPackMemoryExcerpt,
  ContextPackEpisodeExcerpt,
  ContextPackCitation,
  ContextPackNotice,
};

/**
 * `parseRepositoryKey`'s result. A discriminated object rather than a throw: the caller (RUN-208's
 * manifest ↔ server association) turns a bad key into an operator-facing log line, and a thrown
 * error would make every call site wrap this in its own try/catch to get the same readable reason
 * `safeParse`'s own `ZodError` already carries — badly, since zod's default message is written for
 * a form validator, not a log line naming which committed field was wrong.
 */
export type ParseRepositoryKeyResult = { ok: true; key: RepositoryKey } | { ok: false; reason: string };

/**
 * Validate a raw string as a canonical `RepositoryKey` — the one call site allowed to run
 * `RepositoryKey.safeParse` outside a test, so every caller gets the same reason text instead of
 * reaching for zod's raw issue array itself.
 *
 * NEVER used on a `BaseId`: a repository key is a short, human-chosen slug (§6); a baseId is an
 * opaque revision id in its own VCS backend's id space (a Perforce changelist number, a Diversion
 * commit id) and is compared with `===` only, everywhere in this codebase. Reach for this on the
 * former, never the latter.
 */
export function parseRepositoryKey(raw: string): ParseRepositoryKeyResult {
  const parsed = RepositoryKey.safeParse(raw);
  if (parsed.success) return { ok: true, key: parsed.data };
  const reason = parsed.error.issues[0]?.message ?? 'malformed repository key';
  return { ok: false, reason: `"${raw}" is not a valid repository key: ${reason}` };
}
