/**
 * The optional final agent self-summary (RUN-226) — request, bound, validate, discard.
 *
 * `EffortEpisode.selfSummary` is the one field on the episode that is not a daemon observation: it
 * is the agent's own prose about its own work, and the only field the server MERGES rather than
 * replaces on an upsert (doc_msgy182g253w1r02596q §14) — a later write can never destroy it, which
 * is exactly why a bad one must never leave this process (see the strict-validation note below).
 *
 * Kept out of `episode.ts` deliberately: that module is a PURE function of a settled `RunPipeline`
 * — no I/O, no token spend, no clock. This module is the opposite of that on every axis (it talks
 * to a live session, spends budget, and races a timer), so keeping the two apart means the pure
 * assembler stays trivially testable and this is the only place in the episode pipeline that can
 * spend anything.
 */

import type { EpisodeSelfSummary } from '@noriq-dev/shared';
import { EpisodeSelfSummary as EpisodeSelfSummarySchema } from '@noriq-dev/shared';
import { monotonicMs } from './drivers/budget';
import type { DriverExit, DriverSession } from './drivers/types';
import { renderPrompt } from './prompts';
import type { RunTally } from './supervisor';

/**
 * How long settle waits for the summary turn before giving up on it.
 *
 * This module enforces its OWN deadline rather than leaning on the run's `budget.maxDurationSeconds`
 * (via `clockGuard`, already wired onto `continueWith` by `superviseBudget`): a run dispatched with
 * no wall-clock ceiling at all arms no timer there — `startClock` sees an unbounded remainder and
 * returns a no-op disarm. Settle must never be blockable (the same asymmetry `LOCK_RELEASE_TIMEOUT_MS`
 * is chosen from in `stages/settle.ts`), so the bound has to hold even when the run's own ceiling
 * does not.
 *
 * The race does NOT cancel the underlying turn — `DriverSession.continueWith` returns a bare
 * Promise with no abort handle, so a timed-out turn keeps running in the background: it can still
 * spend tokens (charged to the tally the moment its `onTelemetry` ticks, same as any other turn) and
 * still stream text into the transcript (the session's `onText` handler, wired once at the session's
 * own start, is untouched by this timeout). What actually bounds the exposure is the very next line
 * in `settle.ts`: `ctx.stopSession()` runs unconditionally right after this call returns, and
 * `DriverSession.stop()` (claude.ts) explicitly settles any turn still in flight rather than leaving
 * it to hang — so the abandoned turn's lifetime is this timeout plus teardown, never unbounded.
 */
export const SELF_SUMMARY_TIMEOUT_MS = 2 * 60_000;

/**
 * The largest reply this module will attempt to parse, in characters of the TURN'S OWN text (after
 * isolating it from everything the session said before — see `getSessionText`'s slice below).
 *
 * Rejected outright rather than truncated-then-parsed: the prompt asks for one small fenced JSON
 * block, so a reply past this bound is not a slightly-too-long summary, it is the wrong shape
 * entirely (the model rambling, or echoing part of its own prior context) — and slicing a JSON
 * object at an arbitrary character offset produces something that fails to parse anyway. Rejecting
 * immediately says why in one place instead of failing the same reply twice for two reasons.
 */
export const SELF_SUMMARY_OUTPUT_CAP = 8_000;

/** What `requestSelfSummary` needs — narrow, and only what settle already has in hand (CLAUDE.md's
 *  DI testing strategy: no supervisor, no SDK, no clock the test cannot fake). */
export interface SelfSummaryContext {
  /** The live session. Absent `continueWith` (a single-turn run, or a driver whose runtime cannot
   *  hand work back — codex has none) means no summary, and that is not a failure: RUN-226's own
   *  locked decision names the check as the capability, not the driver's name. */
  session: Pick<DriverSession, 'continueWith'>;
  /** Live accessor for the session's accumulated output (RUN-79's pattern, `reviewWithFeedback`'s
   *  own trick): a length snapshot taken before the turn and sliced off after isolates exactly
   *  what THIS turn said, from everything review/verify hand-back turns already added ahead of it.
   *  Absent (a test, or a driver capability gap) reads as nothing recovered, not an error. */
  getSessionText?: () => string;
  /** The run's cross-session ceiling (RUN-133): `reserve()` says whether anything is left BEFORE
   *  this turn is asked for at all — declining rather than spending the run's last tokens on
   *  enrichment — and `chargeTime()` bills the turn's wall-clock the same way every other hand-back
   *  turn does (`verifyWithFeedback`/`reviewWithFeedback` in supervisor.ts). Tokens/USD need no
   *  matching call here: they arrive through the session's own `onTelemetry` handler, wired once at
   *  the session's start and untouched by this turn, so the tally already sees this turn's spend by
   *  the time `settle` reads `ctx.tally.total()` afterwards. */
  tally: Pick<RunTally, 'reserve' | 'chargeTime'>;
  /** The turn WILL stream into the human-visible transcript (it runs through the session's own
   *  `onText` handler like any other turn) — labelled here so a reader is not surprised by JSON
   *  appearing after the agent's work looked finished (the same reason reviewer rounds are labelled,
   *  RUN-74/150). */
  milestone: (text: string) => void;
  /** Best-effort diagnostics for a discard an operator might want to see. Never required for
   *  correctness — every discard already leaves the episode exactly as if this had not run. */
  warn?: (message: string, details?: Record<string, unknown>) => void;
}

/** The last fenced ```json block, or a bare `{...}` when the model dropped the fence — the same
 *  two-step fallback `stages/plan.ts`'s `parsePlannedSpecDetailed` uses, for the same reason: the
 *  instruction asks for a fence, and refusing an otherwise-parseable answer over punctuation would
 *  throw away a turn that already cost real tokens. Not shared code with `plan.ts` on purpose — that
 *  parser's job is picking the LAST of several candidate drafts, which this single small reply never
 *  produces enough of to need. */
function extractJsonBlock(text: string): string | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  if (fenced.length) return fenced[fenced.length - 1] ?? null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

/**
 * Ask the live session, once, for a bounded structured account of its own work.
 *
 * Every exit is `null` except the one success path: no `continueWith`, no budget left, a timeout, a
 * driver error, an oversized reply, unparseable JSON, or a reply the schema refuses all discard the
 * same way and leave the caller nothing to distinguish — `buildEpisode`'s `selfSummary` is null in
 * every one of those cases, exactly as if this had never been called (RUN-226's acceptance: the
 * deterministic episode is unaffected by skip, timeout, or validation failure alike).
 *
 * Discarded WHOLE on any validation failure, never partially kept: `EpisodeSelfSummary.safeParse`
 * fails on the first field with the wrong shape, and a summary missing (or wrong about) one field is
 * not a summary worth three-quarters trusting — the same reason a `FAILED` acceptance criterion is
 * taken as the FAIL it contains rather than negotiated field by field (RUN-145).
 */
export async function requestSelfSummary(ctx: SelfSummaryContext): Promise<EpisodeSelfSummary | null> {
  const turn = ctx.session.continueWith;
  if (!turn) return null;

  // Decline rather than spend the run's last tokens on enrichment (RUN-133's own rule for a stage
  // with nothing left: this is not a NEW session, but the principle is the same — asking is itself a
  // choice to spend, and a run already over its ceiling should not spend more of it on a summary).
  if (!ctx.tally.reserve().ok) {
    ctx.warn?.('self-summary declined — no run budget remains');
    return null;
  }

  ctx.milestone(
    'settle: asking the agent for a brief self-summary of its own work (enrichment only — agent-authored, unverified)',
  );

  const textBefore = ctx.getSessionText?.().length ?? 0;
  const startedAt = monotonicMs();
  let exit: DriverExit | null;
  try {
    exit = await Promise.race([
      turn(renderPrompt('self-summary')).catch((err) => {
        ctx.warn?.('self-summary turn errored', { err: String(err) });
        return null;
      }),
      new Promise<null>((resolve) => {
        const timer = setTimeout(resolve, SELF_SUMMARY_TIMEOUT_MS, null);
        // Never the reason the daemon outlives its work (the same guard `budget.ts`'s own deadline
        // takes) — this timer's only job is to stop THIS function from waiting, not to hold the
        // event loop open for the two minutes it measures.
        timer.unref?.();
      }),
    ]);
  } finally {
    // Charged unconditionally, success or timeout: the run's wall-clock ledger has to reflect the
    // stretch this turn actually held the session for, the same accounting `verifyWithFeedback`'s
    // and `reviewWithFeedback`'s own fix-turn loops use (supervisor.ts).
    ctx.tally.chargeTime((monotonicMs() - startedAt) / 1000);
  }

  if (!exit || exit.outcome !== 'done') {
    if (exit?.reason) ctx.warn?.('self-summary turn did not finish', { reason: exit.reason });
    return null;
  }

  const turnText = ctx.getSessionText?.().slice(textBefore) ?? '';
  if (!turnText) return null;
  if (turnText.length > SELF_SUMMARY_OUTPUT_CAP) {
    ctx.warn?.('self-summary turn exceeded the accepted size — discarded', { chars: turnText.length });
    return null;
  }

  const raw = extractJsonBlock(turnText);
  if (!raw) {
    ctx.warn?.('self-summary turn produced no parseable JSON — discarded');
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    ctx.warn?.('self-summary JSON did not parse — discarded', { err: String(err) });
    return null;
  }
  const result = EpisodeSelfSummarySchema.safeParse(parsed);
  if (!result.success) {
    ctx.warn?.('self-summary failed strict validation — discarded', {
      issues: result.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    });
    return null;
  }
  return result.data;
}
