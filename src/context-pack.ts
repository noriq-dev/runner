import type { ContextPack, ContextPackRole } from './memory-contract';

/**
 * RUN-228's task context pack retrieval: fetch, bound, and RECORD ONLY.
 *
 * `ContextPack` is untrusted server text until RUN-229 verifies its citations against the
 * worktree and RUN-230/231 render it through a bounded quoted-evidence renderer. Nothing in this
 * file, or in `prepare.ts`'s call site, may fold `.pack` into a prompt — that is next task's gate
 * to open, not this one's. What this module owns is the seam those tasks attach to: a bounded,
 * always-degrading fetch, and a typed record of what happened, so a run whose retrieval degraded
 * is distinguishable from one that never asked at all.
 */

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/** The wire shape `NoriqClient.getContextPack` sends — every identity field the server uses to
 *  scope and weight the pack (this task's locked decision). */
export interface ContextPackRequest {
  projectId: string;
  taskId: string;
  repositoryKey: string;
  baseId: string | null;
  branch: string | null;
  role: ContextPackRole;
  budgetTokens?: number;
}

/** What preparation actually has in hand when it asks — narrower than `ContextPackRequest`
 *  because two of its fields are only sometimes present, and THIS module decides what an absent
 *  one means (skip vs. send null), not the caller. */
export interface ContextPackInquiry {
  projectId: string;
  /** Null on a pure-brief dispatch with no task anchor — `RunAnchor`'s own contract (`anchor`
   *  stays the task; a brief-only run has none). Retrieval has nothing to ask the server about. */
  taskId: string | null;
  /** `repo.manifest.repositoryKey` — the canonical identity, never the local `repo_<sha>`
   *  checkout id (locked decision). Null on a repo that has not declared one, which is most repos
   *  today. */
  repositoryKey: string | null;
  /** The leased worktree's own base (`Workspace.baseId`) — the opaque revision id in the backend's
   *  own id-space, the same one indexing itself was taken from. */
  baseId: string | null;
  /**
   * The repo's target/integration branch (`repo.manifest.defaultBranch`) — deliberately NEVER
   * `Workspace.workRef`, the run's own throwaway `noriq/run/<id>` branch: that field's own
   * contract (`vcs/types.ts`) is "display only, and the moment this becomes an operand it is
   * `location` smuggled past the type system", and the server has never indexed a run's private
   * branch anyway — sending it as `branch` would not skip scoping, it would silently mis-scope
   * every citation's freshness check against a branch that can never match.
   */
  branch: string | null;
  role: ContextPackRole;
  budgetTokens?: number;
}

/** Injected fetch — the `queryFn`/`GitRunner`/`VerifyExec` convention: this module never touches
 *  the real network, and a test fakes exactly this function. Bound to `NoriqClient.getContextPack`
 *  in production. Contract: never throws (mirrors `getIndexCursor`'s own — every failure already
 *  collapses to `null` on that side of the wire), but `retrieveContextPack` does not trust that
 *  and wraps the call anyway. */
export type ContextPackFetcher = (input: ContextPackRequest) => Promise<ContextPack | null>;

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

/**
 * Why retrieval did not produce a pack. Three of the acceptance's five degradation paths — an
 * HTTP error, an old server missing the route (404), and a body that fails the vendored schema —
 * collapse to `unavailable`: `NoriqClient.getContextPack` runs the ONE parser over the response
 * and returns `null` on any of them, the same locked-decision shape `getIndexCursor` already
 * uses (client.ts) precisely so this caller does not have to keep three failure modes in sync
 * with a server that can fail in new ways this daemon has never seen. The other two —
 * `no-repository-key` and `no-task` — are decided here, before any request leaves the box.
 */
export type ContextPackOmission =
  | { reason: 'no-repository-key' }
  | { reason: 'no-task' }
  | { reason: 'no-fetcher' }
  | { reason: 'timeout'; afterMs: number }
  | { reason: 'unavailable' };

export interface ContextPackRetrieval {
  /** True the instant a request actually left the box — false for every omission decided before
   *  that point (`no-repository-key`, `no-task`, `no-fetcher`). A `timeout`/`unavailable` still
   *  set this true: something WAS attempted and did not come back, which is a different fact from
   *  never having asked (this task's own acceptance: "a silently-absent context pack is
   *  indistinguishable from an empty one"). */
  attempted: boolean;
  pack: ContextPack | null;
  omission: ContextPackOmission | null;
  tookMs: number;
}

/** One bounded network call to the Noriq server, same order as `TASK_LOOKUP_TIMEOUT_MS`
 *  (supervisor.ts's own precedent for "must never hang a run on one MCP round trip") — long
 *  enough that an ordinary retrieval never trips it, short enough that a stalled server costs a
 *  run seconds, never the run itself. */
export const CONTEXT_PACK_TIMEOUT_MS = 10_000;

const notAttempted = (reason: 'no-repository-key' | 'no-task' | 'no-fetcher'): ContextPackRetrieval => ({
  attempted: false,
  pack: null,
  omission: { reason },
  tookMs: 0,
});

/**
 * Fetch a task context pack, bounded and always-degrading (this task's locked decision): a
 * timeout, a fetcher that rejects, or one that resolves `null` all land on exactly the same
 * `ContextPackRetrieval` shape preparation already knows how to carry forward — none of them
 * throw, so a caller never needs its own try/catch around this call.
 *
 * `repositoryKey`/`taskId` are checked here rather than left to the fetcher: they are the two
 * fields this daemon can judge WITHOUT a network round trip (locked decision: a missing
 * `repositoryKey` skips retrieval rather than sending a partial request the server would have to
 * refuse itself), so a run that cannot possibly succeed never spends the timeout window finding
 * that out.
 */
export async function retrieveContextPack(
  fetcher: ContextPackFetcher | undefined,
  input: ContextPackInquiry,
  timeoutMs = CONTEXT_PACK_TIMEOUT_MS,
): Promise<ContextPackRetrieval> {
  if (!fetcher) return notAttempted('no-fetcher');
  if (!input.repositoryKey) return notAttempted('no-repository-key');
  if (!input.taskId) return notAttempted('no-task');

  const request: ContextPackRequest = {
    projectId: input.projectId,
    taskId: input.taskId,
    repositoryKey: input.repositoryKey,
    baseId: input.baseId,
    branch: input.branch,
    role: input.role,
    ...(input.budgetTokens !== undefined ? { budgetTokens: input.budgetTokens } : {}),
  };

  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref?.();
  });
  try {
    // The fetcher's own contract says it never throws (client.ts collapses every wire failure to
    // `null`), but this is the boundary between an injected dependency and this daemon's own
    // control flow — trusting that contract without a fallback would let one broken test double,
    // or a future fetcher that does not honour it, turn a run's preparation into an unhandled
    // rejection instead of the degradation this whole module exists to guarantee.
    const settled = await Promise.race([fetcher(request).catch(() => null), timedOut]);
    const tookMs = Date.now() - started;
    if (settled === 'timeout') {
      return { attempted: true, pack: null, omission: { reason: 'timeout', afterMs: timeoutMs }, tookMs };
    }
    if (settled === null) {
      return { attempted: true, pack: null, omission: { reason: 'unavailable' }, tookMs };
    }
    return { attempted: true, pack: settled, omission: null, tookMs };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The transcript record
// ---------------------------------------------------------------------------

/**
 * Bounded, section-shape-only summary for the run's transcript — this task's acceptance: "records
 * what was retrieved AND what was omitted or failed... without excerpt text". Never touches an
 * excerpt's own `statement`/`whatWasAttempted`/support text: that IS the untrusted content
 * RUN-229/230 exist to verify and render, and a summary line is still a line this daemon writes
 * into a human-facing stream on the strength of what the server said, not what it proved.
 *
 * Only called for an ATTEMPTED retrieval (see `prepareRun`'s call site) — the common case today is
 * a repo with no `repositoryKey` at all, and a transcript line on every single one of those runs
 * would be noise with no information content, the same "no note on nothing to bootstrap" posture
 * `setupBriefNote` already takes.
 */
export function summarizeContextPackRetrieval(r: ContextPackRetrieval): string {
  if (r.omission?.reason === 'timeout') {
    return `context pack: retrieval timed out after ${r.omission.afterMs}ms — proceeding without it`;
  }
  if (r.omission?.reason === 'unavailable') {
    return 'context pack: unavailable (old server, memory disabled, or a request error) — proceeding without it';
  }
  const pack = r.pack;
  if (!pack) return `context pack: retrieval attempted in ${r.tookMs}ms and produced nothing`;
  const sectionsWithContent = pack.sections.filter(
    (s) => s.excerpts.length || s.graphEntities.length || s.items.length,
  ).length;
  const excerptCount = pack.sections.reduce((n, s) => n + s.excerpts.length, 0);
  const noticeCount = pack.notices.length + pack.sections.filter((s) => s.notice).length;
  return `context pack retrieved in ${r.tookMs}ms: ${pack.sections.length} section(s), ${sectionsWithContent} with content, ${excerptCount} excerpt(s), ${noticeCount} notice(s) — held for verification, not yet in any prompt`;
}
