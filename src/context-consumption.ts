import type {
  ContextConsumptionSectionFact,
  ContextConsumptionSnapshot,
  IntelligenceContextConsumptionMetric,
} from '@noriq-dev/shared';
import { type VerifiedContextPack, summarizeCitationVerification } from './citation-verify';
import type { ContextPackOmission, ContextPackRetrieval } from './context-pack';
import type { RenderedMemoryEvidence } from './memory-render';

/**
 * RUN-247: the status ladder and the map from a rendered pack + its retrieval into
 * `IntelligenceContextConsumptionMetric` (PLNR-433's own contract, `vendor/noriq-shared/src/
 * intelligence.ts`) — the daemon's one assertion about what a run actually READ, as distinct from
 * what it was told to do (`preExecution`) or what it did (`execution`).
 *
 * **Called from the RENDER point** (`stages/brief.ts`, where `renderMemoryEvidence` runs), never
 * from retrieval (`stages/prepare.ts`). That is what makes "requested but never rendered"
 * distinguishable from "rendered, possibly bounded" — a fact captured at retrieval time cannot draw
 * that line, because a run can retrieve a pack and still fail before it ever reaches a prompt.
 *
 * **The status ladder** (PLNR-433's own comment, restated here rather than reinvented):
 *   - `not_applicable` (value: null) — never asked: no task anchor, no repository key.
 *   - `unavailable` (value: null) — asked, and either nothing came back (timeout, no fetcher, a
 *     server error) or something came back but nothing survived to be verified and rendered (a
 *     citation-verification crash, say). Both collapse to one status because the episode record
 *     only needs to know "nothing was consumed", not which of several daemon-side failures caused
 *     it — `ContextPackOmission` already names the daemon's own reason for its own diagnostics.
 *   - `complete` (mode: 'semantic', no section notice, the renderer did not cut) — rendered whole.
 *   - `partial` (mode: 'keyword', and/or a section `truncated`/`unanswerable`, and/or the renderer
 *     itself cut to its own budget) — rendered, but bounded or degraded. Real, not a failure.
 *
 * `not_applicable` and `unavailable` are told apart ONLY by `status`, never by a zero — matching
 * every other metric envelope in this contract.
 *
 * **`retrieval: undefined` is its own case, not folded into `not_applicable`.** A resumed run never
 * re-retrieves (`resume` has no `prepare` — `RunPipeline.contextPack`'s own doc), so this process
 * genuinely does not know whether an earlier sitting asked. Reporting `not_applicable` there would
 * assert "never asked", which may be false; reporting `unavailable` would assert "asked and got
 * nothing", which may also be false. Returning `null` — no assertion at all — is the only honest
 * answer, and it costs nothing: `IntelligenceContextConsumptionMetric` is optional on the episode,
 * exactly for facts a given daemon upload has nothing to say about (PLNR-433's own doc on why the
 * server-built skeleton leaves the key unset rather than defaulting it).
 *
 * **`staleCitationsCount` counts THIS runner's own citation-verification failures**
 * (`verification.state !== 'valid'`, via `citation-verify.ts`'s `summarizeCitationVerification`),
 * never `pack.staleWarnings.length` — a locked decision, because `staleWarnings` is the server's own
 * view, which the server already holds; re-asserting it here would duplicate a fact this process has
 * no more insight into than the sender. What THIS runner is uniquely positioned to report is RUN-229's
 * verification of the pack's citations against this run's own leased worktree — a citation the
 * server believed current that does not survive contact with the actual tree, which is
 * `runner_observed` in a way `staleWarnings` never is.
 *
 * **Only the author's rendering counts** (locked decision): `rendered` must be the AUTHOR-audience
 * `RenderedMemoryEvidence`, never the reviewer's smaller frame. One `contextConsumption` per
 * episode, and the analytics question behind it — did context change the WORK — is the author's.
 *
 * **Counts, enums, and booleans only** (structural on the contract side already, restated on this
 * side because it is the rule this module exists to honor): nothing here reads an excerpt's
 * statement, a citation's path, or a notice's `reason` string. `omissionReason` below returns a
 * DAEMON fact about its own measurement (which of a fixed, closed set of retrieval outcomes
 * happened) — never pack content — which is exactly what the envelope's own `reason` field is for.
 */

/** A closed, daemon-authored sentence per `ContextPackOmission` reason — never pack content, since
 *  every `ContextPackOmission` variant is this process's own bookkeeping about its own request. */
function omissionReason(omission: ContextPackOmission | null): string | null {
  if (!omission) return null;
  switch (omission.reason) {
    case 'timeout':
      return `context pack retrieval timed out after ${omission.afterMs}ms`;
    case 'no-repository-key':
      return 'this repo has no repositoryKey configured to assemble a pack against';
    case 'no-task':
      return 'this run has no anchor task to assemble a pack against';
    case 'no-fetcher':
      return 'context pack retrieval is not wired on this daemon';
    case 'unavailable':
      return 'the server returned nothing usable (old server, memory disabled, or a request error)';
    default:
      return null;
  }
}

const nowIso = (): string => new Date().toISOString();

const observation = (reason: string | null) => ({
  provenance: 'runner_observed' as const,
  source: 'runner' as const,
  sourceId: null,
  observedAt: nowIso(),
  // NOT stamped here, same as every other daemon-built envelope in this codebase
  // (`stage-timing.ts`'s own `observation`): `acceptedAt` means the SERVER accepted this
  // observation, which this process cannot know.
  acceptedAt: null,
  reason,
});

export interface ContextConsumptionInput {
  /** `PreparedRun.contextPack` / `BriefInputs.contextPack` — undefined when this sitting never
   *  retrieved one at all (a RESUMED run). See this module's own doc on why that reads as "no
   *  assertion", never as `not_applicable`. */
  retrieval: ContextPackRetrieval | undefined;
  /** `citation-verify.ts`'s verdicts over that retrieval — null when there was nothing to verify or
   *  verification itself failed; both read as "asked, but nothing survived to render". */
  verifiedContextPack: VerifiedContextPack | null | undefined;
  /** The AUTHOR-audience `RenderedMemoryEvidence` — never the reviewer's (locked decision above). */
  rendered: RenderedMemoryEvidence;
}

/**
 * Build this sitting's `contextConsumption` metric, or `null` when this daemon has no assertion to
 * make (`retrieval` absent — see module doc). Never throws: every branch is a closed switch over
 * counts and enums already in hand, and a caller that gets `null` back simply omits the field,
 * exactly as it would for any other unassembled metric.
 */
export function buildContextConsumption(
  input: ContextConsumptionInput,
): IntelligenceContextConsumptionMetric | null {
  const { retrieval, verifiedContextPack, rendered } = input;
  if (!retrieval) return null;

  if (!retrieval.attempted) {
    return { status: 'not_applicable', value: null, ...observation(omissionReason(retrieval.omission)) };
  }

  // Asked, but nothing survived to be verified and rendered — a timeout/server-error omission, OR a
  // pack that came back and then failed downstream (citation verification threw, `prepare.ts`'s own
  // best-effort posture). Both collapse to `unavailable`: this metric only needs to say "nothing was
  // consumed", not which daemon-side failure caused it.
  if (!verifiedContextPack) {
    return {
      status: 'unavailable',
      value: null,
      ...observation(
        omissionReason(retrieval.omission) ??
          'a context pack was retrieved but nothing survived to be verified and rendered',
      ),
    };
  }

  const pack = verifiedContextPack;
  const sections: ContextConsumptionSectionFact[] = pack.sections.map((s) => ({
    id: s.id,
    excerptCount: s.excerpts.length,
    graphEntityCount: s.graphEntities.length,
    truncated: s.notice?.kind === 'truncated',
    unanswerable: s.notice?.kind === 'unanswerable',
  }));
  // `summarizeCitationVerification`'s own closed, five-value breakdown — never a per-citation line
  // (see that function's own doc). `total - byState.valid` is every verdict THIS daemon did not
  // independently confirm: `moved`/`changed`/`missing`/`unverifiable`, the locked-decision reading
  // of "stale" — deliberately never `pack.staleWarnings.length` (module doc above).
  const verification = summarizeCitationVerification(pack);

  const snapshot: ContextConsumptionSnapshot = {
    mode: pack.mode,
    role: pack.role,
    charBudget: pack.charBudget,
    charsUsed: pack.charsUsed,
    sections,
    similarEpisodesConsidered: pack.similarEpisodes.length,
    staleCitationsCount: verification.total - verification.byState.valid,
    noticesCount: pack.notices.length,
    // ROUNDED, and this is not optional (RUN-286, found on the first live run): the contract's
    // `retrievalTookMs` is `z.number().int()`, while `ContextPackRetrieval.tookMs` comes from
    // `elapsedMs` → `performance.now()` deltas, which are FRACTIONAL by construction. So this field
    // could never validate, and because a refine failure drops the WHOLE `intelligence` payload it
    // took every other analytics fact down with it — stages, clocks and change stats included. The
    // live episode logged exactly that: `issuePath: contextConsumption.value.retrievalTookMs,
    // "expected int, received number"`.
    //
    // Rounding here is NOT the "never repair a number" rule (RUN-244) being broken. That rule is
    // about garbage — a NaN or a negative, where any repair fabricates a measurement that was never
    // taken. This is a real measurement in a FINER unit than the contract carries, and converting it
    // to the contract's own unit loses sub-millisecond precision nobody asked for. Every unit test
    // missed it because they all built snapshots from hand-written integers; only the real retrieval
    // path produces a float.
    retrievalTookMs: Math.round(retrieval.tookMs),
  };

  // `complete` requires ALL of: semantic mode, no section notice, and the renderer itself did not
  // cut to its own budget (RUN-247's own acceptance: a runner-performed truncation must be visible
  // even when the pack itself reported nothing wrong). Any one of the three makes it `partial` —
  // real, but bounded or degraded, never a failure (the keyword-mode acceptance criterion by name).
  const degraded =
    pack.mode === 'keyword' || sections.some((s) => s.truncated || s.unanswerable) || rendered.truncated;

  return { status: degraded ? 'partial' : 'complete', value: snapshot, ...observation(null) };
}
