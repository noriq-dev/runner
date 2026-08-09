/**
 * The deterministic effort-episode assembler (RUN-224).
 *
 * The `settle` stage is the episode boundary (doc_msgy182g253w1r02596q §8): it is the one stage
 * every terminal sitting reaches — done, failed, cancelled, continued — and by the time it runs it
 * already owns true cumulative spend, the terminal verdict, the adjudication ledger, and the
 * workspace's fate. This module is the pure half of that: one function from a settled
 * `RunPipeline` (plus the handful of facts only `settle` itself can answer — see `EpisodeExtra`) to
 * one `EffortEpisode` payload. Assembly only: no upload, no transport, no capability mint (RUN-227,
 * blocked on PLNR-340), no self-summary (RUN-226), no new instrumentation (RUN-225).
 *
 * The server builds its OWN skeleton from its `runs` row on every terminal transition and is
 * authoritative for run identity — `outcome`, `runKind`, `agentId`, `startedAt`, `finishedAt`, and
 * `sitting` are deliberately never assembled here; a daemon-forged copy of those fields is exactly
 * the trust boundary the split exists to hold (planar `apps/api/src/memory/episodes.ts`). Everything
 * ELSE `EffortEpisode` carries is assembled COMPLETE: `ProjectMemory.recordEpisode` is last-writer-
 * wins per field (except `selfSummary`/`id`/`createdAt`), so a default left in place here would
 * ERASE what the server already knew rather than leaving it alone — completeness is the property
 * this module is judged on, not the absence of wrong values.
 */

import { randomUUID } from 'node:crypto';
import type {
  EffortEpisode as EffortEpisodeType,
  EpisodeFinding,
  EpisodeLandingOutcome,
  EpisodeTimelineEntry,
} from '@noriq-dev/shared';
import { EffortEpisode } from '@noriq-dev/shared';
import { type AcceptanceReport, failedAcceptance, humanNeededAcceptance } from './acceptance';
import { type LedgerEntry, effectiveStatus } from './adjudication';
import type { RunPipeline } from './stages/types';

/** Facts `buildEpisode` needs that are not on `RunPipeline` itself, because they are `settle`'s own
 *  local computations rather than pipeline state — threading them through beats re-deriving them a
 *  second time (or, worse, guessing). */
export interface EpisodeExtra {
  /** Paths this sitting's backend can say it touched (`VcsBackend.changedPaths`) — the same call
   *  `settle` already makes for the continuation record, reused rather than re-run. Empty when the
   *  backend cannot say (no capability, or the call failed) — never inferred from anything else. */
  filesTouched: string[];
  /** Whether the workspace still holds unlanded work — `settle`'s own shared answer (the same
   *  boolean its dispose decision reads), so landing state and remaining work here cannot disagree
   *  with what the workspace's actual fate turned out to be. */
  hasRemainingWork: boolean;
  /**
   * The verify-agent gate's per-criterion evidence, when THIS sitting computed one — `settle`'s own
   * `judgeWithAcceptance` call, on a workflow that carries `verifyActor` (the dispatched `verify`
   * workflow). Threaded through because it is state `settle` already has in scope, not re-derived.
   *
   * Undefined on a `build` run — the overwhelming majority of runs: the inline reviewer
   * (`stages/review.ts`) computes its OWN `AcceptanceReport` but never carries it onto
   * `RunPipeline` (`RunPipeline`'s four mutable fields are `exit`/`driverSucceeded`/`landed`/
   * `ledger` only — see `stages/types.ts`'s own doc on why that set stays small). So
   * `acceptanceCoverage` and the acceptance-derived `failures`/`remainingWork` entries below are an
   * honest gap on every build run today, not a zero: closing it means either widening what
   * `RunPipeline` carries forward from `review`, or a fresh read at settle time, and either is a
   * REAL follow-up (RUN-225/247 territory) this task does not invent instrumentation to cover.
   */
  acceptanceEvidence?: AcceptanceReport;
}

/**
 * Reviewer severity is free text — whatever word the model wrote inside a `FINDING [<severity>]`
 * bracket, capped by `adjudication.ts`'s `SEVERITY_CAP` — while `EpisodeFinding.severity` is a
 * closed four-value enum. This is the ONE normalizer between them; everything downstream just
 * reads the enum.
 */
const SEVERITY_WORDS: Record<string, EpisodeFinding['severity']> = {
  info: 'info',
  informational: 'info',
  note: 'info',
  nit: 'info',
  nitpick: 'info',
  trivial: 'info',
  low: 'low',
  minor: 'low',
  warning: 'low',
  warn: 'low',
  medium: 'medium',
  moderate: 'medium',
  med: 'medium',
  high: 'high',
  major: 'high',
  critical: 'high',
  blocker: 'high',
  severe: 'high',
};

/** What an unrecognized severity word maps to. `medium` on purpose, not the schema's own `info`
 *  default: a word the normalizer does not recognize is evidence the reviewer thought something
 *  worth flagging, and rounding an unknown down to `info` would systematically understate whatever
 *  vocabulary this misses next. It is a guess either way; `medium` is the guess that costs least in
 *  both directions. */
const DEFAULT_SEVERITY: EpisodeFinding['severity'] = 'medium';

/**
 * Normalize a `LedgerEntry.severity` string into `EpisodeFinding`'s enum (RUN-224 locked decision).
 * Never drops the finding on an unrecognized word — dropping it to satisfy the enum would lose the
 * one piece of evidence the episode exists to carry; an unrecognized severity keeps its finding and
 * takes `DEFAULT_SEVERITY` instead.
 */
export function normalizeSeverity(raw: string): EpisodeFinding['severity'] {
  return SEVERITY_WORDS[raw.trim().toLowerCase()] ?? DEFAULT_SEVERITY;
}

/** Every ledger entry becomes a finding, whatever its adjudication — a fixed finding is still
 *  evidence that something was wrong and got fixed (doc_msgy182g253w1r02596q §14: "a failed run
 *  that disproves an approach is useful project progress"). The status rides inside `summary`
 *  (`EpisodeFinding` has no field for it) so a reader can tell settled from standing without a
 *  second lookup. `passed` mirrors `requirementOutcomes`' own rule (adjudication.ts): on a PASS
 *  nothing reads as standing, because the gate read every finding and its rebuttal and cleared the
 *  work anyway — reporting a contested finding as open would contradict the verdict of the run that
 *  produced it. */
function findingsOf(ledger: LedgerEntry[], passed: boolean): EpisodeFinding[] {
  return ledger.map((e) => {
    const status = passed || effectiveStatus(e) === 'fixed' ? 'resolved' : effectiveStatus(e);
    const where = e.location ? `${e.location}: ` : '';
    return { summary: `[${status}] ${where}${e.claim}`, severity: normalizeSeverity(e.severity) };
  });
}

/** What is still owed when this sitting ends: a kept workspace, any finding still standing (the
 *  same `passed`-aware settlement `findingsOf` uses), and any acceptance criterion the gate could
 *  not settle from a workspace at all. */
function remainingWorkOf(ctx: RunPipeline, extra: EpisodeExtra, passed: boolean): string[] {
  const out: string[] = [];
  if (extra.hasRemainingWork) out.push('workspace kept — the diff has not reached the integration branch');
  for (const e of ctx.ledger) {
    if (passed || effectiveStatus(e) === 'fixed') continue;
    const where = e.location ? ` at ${e.location}` : '';
    out.push(
      `${effectiveStatus(e) === 'contested' ? 'contested' : 'unanswered'} finding${where}: ${e.claim}`,
    );
  }
  if (extra.acceptanceEvidence) {
    for (const item of humanNeededAcceptance(extra.acceptanceEvidence))
      out.push(`human decision needed — acceptance #${item.id}: ${item.item.text}`);
  }
  return out;
}

/** Why this sitting did not simply succeed, from what `settle` already has: the terminal reason on
 *  `ctx.exit` (set by whichever gate narrowed it — the verify agent, the inline reviewer, a budget
 *  breach) and, when this sitting computed one, its own acceptance evidence's FAILED criteria. */
function failuresOf(ctx: RunPipeline, acceptance: AcceptanceReport | undefined): string[] {
  const out: string[] = [];
  if (ctx.exit.reason) out.push(`terminal reason: ${ctx.exit.reason}`);
  if (acceptance) {
    for (const e of failedAcceptance(acceptance))
      out.push(`acceptance #${e.id} failed: ${e.item.text}${e.evidence ? ` — ${e.evidence}` : ''}`);
  }
  return out;
}

/** The fraction of this sitting's acceptance criteria the gate could say VERIFIED. `null` — the
 *  schema's own default — when this sitting computed no evidence at all (see `EpisodeExtra`'s own
 *  comment on why that is most runs today), never a zero: zero would read as "checked, and none
 *  passed," which is a different and false claim from "nothing was checked." */
function acceptanceCoverageOf(report: AcceptanceReport | undefined): number | null {
  if (!report?.entries.length) return null;
  const verified = report.entries.filter((e) => e.outcome === 'verified').length;
  return verified / report.entries.length;
}

/** Landed, or never going to: `ctx.landed` and `ctx.landPolicy` are both already narrowed by the
 *  time `settle` runs (captured once by `verify`, per `RunPipeline`'s own doc). A workflow that
 *  never lands (`landPolicy` null — scope, verify, or a build with no `[land]` configured) reads
 *  `not_landed` rather than `pending`, because nothing here is EVER going to change that. A kept
 *  workspace on a landing-capable workflow reads `pending`: a future continuation may still land it,
 *  which is exactly the "continued sittings" case this task is required to cover. */
function landingOutcomeOf(ctx: RunPipeline, hasRemainingWork: boolean): EpisodeLandingOutcome {
  if (ctx.landed) return 'landed';
  if (!ctx.landPolicy) return 'not_landed';
  if (hasRemainingWork) return 'pending';
  return ctx.exit.outcome === 'done' ? 'not_landed' : 'failed';
}

/** The runner's own contribution to the timeline (discretion: the server independently knows
 *  dispatch/start/exit from its `runs` row, so this adds only what the runner sees that the server
 *  does not). Two entries, both sourced from state `settle` already holds, never a fresh
 *  instrumentation pass: a continuation's prior sitting boundary (`ContinuableRun.failedAt`, already
 *  persisted for exactly this purpose) and this sitting's own settle moment. */
function timelineOf(ctx: RunPipeline): EpisodeTimelineEntry[] {
  const out: EpisodeTimelineEntry[] = [];
  if (ctx.continued) {
    out.push({ at: ctx.continued.failedAt, label: 'continuation: resumed from a kept worktree' });
  }
  out.push({ at: new Date().toISOString(), label: 'settle: transcript closed, locks released' });
  return out;
}

/**
 * Assemble one `EffortEpisode` for this sitting.
 *
 * Pure and injectable (CLAUDE.md's testing strategy): everything it reads is either on `ctx` or
 * passed in via `extra`, so a test builds a `RunPipeline` fixture and never touches a supervisor,
 * the SDK, or git. The caller (`settle.ts`) is responsible for the "never gates settlement"
 * property — this function may throw (a malformed `filesTouched` entry fails `RepoPath`'s schema,
 * for instance) rather than silently emit a payload the server would reject, and the caller wraps
 * the call so a throw here costs only this sitting's episode, never the run's own outcome.
 */
export function buildEpisode(ctx: RunPipeline, extra: EpisodeExtra): EffortEpisodeType {
  const passed = ctx.exit.outcome === 'done';
  const candidate: EffortEpisodeType = {
    id: randomUUID(),
    projectId: ctx.run.projectId,
    runId: ctx.run.id,
    taskId: ctx.run.anchor?.type === 'task' ? ctx.run.anchor.taskId : null,
    repositoryKey: ctx.repo.manifest.repositoryKey ?? null,
    baseId: ctx.worktree.baseId,
    timeline: timelineOf(ctx),
    filesTouched: extra.filesTouched,
    // RUN-225: no command/test-execution log exists yet to source these from — an honest gap, not
    // a guess built from the repo's CONFIGURED verify command (which this sitting may never have
    // reached, or may have reached and failed early).
    commands: [],
    testsRun: [],
    failures: failuresOf(ctx, extra.acceptanceEvidence),
    findings: findingsOf(ctx.ledger, passed),
    // The highest round any ledger entry carries (RUN-224 locked decision) — a faithful but LOWER
    // BOUND on how many reviewer look-backs actually happened: a round that raised no NEW finding
    // never touches an entry's `round`, so a clean final pass (the common case on a run that
    // ultimately passes) undercounts by exactly that pass. `reviewWithFeedback`'s own `rounds`
    // return would be exact, but `RunPipeline` does not carry it (see `EpisodeExtra`'s comment on
    // why this module does not widen that set) — RUN-225 territory if the undercounting matters
    // more than the instrumentation it would take to close it.
    reviewRounds: ctx.ledger.reduce((max, e) => Math.max(max, e.round), 0),
    tokenUsage: ctx.exit.telemetry.modelUsage ?? {},
    costUSD: ctx.exit.telemetry.costUsd,
    acceptanceCoverage: acceptanceCoverageOf(extra.acceptanceEvidence),
    // RUN-225: no steering observation exists yet.
    steeringEvents: [],
    landingOutcome: landingOutcomeOf(ctx, extra.hasRemainingWork),
    remainingWork: remainingWorkOf(ctx, extra, passed),
    // RUN-226 owns the agent's own summary; null is the one default `recordEpisode` does NOT
    // overwrite (locked decision), so leaving it null here cannot destroy a later self-summary.
    selfSummary: null,
    createdAt: new Date().toISOString(),
  };
  // Validated, not merely typed: a schema mismatch (a malformed path, an out-of-range number) fails
  // LOUD here, inside the caller's try/catch, rather than as a silent server-side rejection later.
  return EffortEpisode.parse(candidate);
}
