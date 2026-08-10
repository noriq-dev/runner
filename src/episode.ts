/**
 * The deterministic effort-episode assembler (RUN-224).
 *
 * The `settle` stage is the episode boundary (doc_msgy182g253w1r02596q §8): it is the one stage
 * every terminal sitting reaches — done, failed, cancelled, continued — and by the time it runs it
 * already owns true cumulative spend, the terminal verdict, the adjudication ledger, and the
 * workspace's fate. This module is the pure half of that: one function from a settled
 * `RunPipeline` (plus the handful of facts only `settle` itself can answer — see `EpisodeExtra`) to
 * one `EffortEpisode` payload. Assembly only: no upload, no transport, no capability mint — that is
 * `episode-upload.ts`/`episode-pending.ts` (RUN-227), which this module knows nothing about beyond
 * the `deriveEpisodeScopeId` identity helper below, kept here because it derives from the same
 * `EffortEpisode.createdAt` this module mints.
 *
 * `selfSummary` (RUN-226) is the one field this module does not derive from
 * `ctx` at all — requesting, bounding and validating it means talking to a live session, which is
 * exactly what this module's purity rules out, so `episode-summary.ts`'s `requestSelfSummary` does
 * that work and hands the settled value (or null) in through `extra`, same as everything else this
 * module cannot compute itself. RUN-225 closed the instrumentation gap this
 * comment used to name here — `commands`/`testsRun`/`steeringEvents` now source from daemon
 * OBSERVATIONS (`RunPipeline.commandObservations`, `EpisodeExtra.steeringHistory`), never from
 * configuration or agent prose, and `reviewRounds`/`acceptanceCoverage` read the reviewer's own
 * exact figures (`RunPipeline.reviewEvidence`) instead of re-deriving a lower bound. What it did
 * NOT close, for lack of a cheap observation: which files the agent merely EXAMINED (no driver
 * reports reads today), and the examined/modified/generated/verified distinction beyond the union
 * the wire can carry — see `EpisodeExtra.filesTouched`'s own doc.
 *
 * The server builds its OWN skeleton from its `runs` row on every terminal transition and is
 * authoritative for run identity — `outcome`, `runKind`, `agentId`, `startedAt`, `finishedAt`, and
 * `sitting` are deliberately never assembled here; a daemon-forged copy of those fields is exactly
 * the trust boundary the split exists to hold (planar `apps/api/src/memory/episodes.ts`).
 *
 * Everything else `EffortEpisode` carries is still assembled COMPLETE here — `buildEpisode` stays a
 * pure, total function of `RunPipeline`, and the full record remains this daemon's own local log
 * (see `timelineOf`'s own doc on why `timeline`/`agentStartedAt` are worth keeping even though they
 * never ship). What changed under PLNR-340 (planar `1af483d`, RUN-264) is what SHIPS, not what is
 * assembled: a daemon upload is now a PARTIAL enrichment —
 * `UPLOADED_EPISODE_SHAPE = EffortEpisode.pick({ runId, filesTouched, commands, testsRun, failures,
 * findings, selfSummary }).partial().extend({ runId })` (`apps/api/src/do/ProjectMemory.ts`) — and
 * every OTHER key, including `timeline`/`reviewRounds`/`tokenUsage`/`costUSD`/`acceptanceCoverage`/
 * `steeringEvents`/`landingOutcome`/`remainingWork`/`taskId`/`repositoryKey`/`baseId`, is STRIPPED
 * server-side. RUN-224's original rule — "a field left at its default ERASES what the server
 * already knew, so completeness is what this module is judged on" — is now FALSE for every stripped
 * field: none of them reach the server at all, so no value assembled here, default or otherwise,
 * can erase anything server-side. For the six fields still accepted, the rule is the INVERSE:
 * under `writeMode: 'enrichment'` the server merges as `provided ?? existing`, so OMITTING one of
 * them PRESERVES what is already stored while sending `[]` REPLACES it with empty — an empty array
 * is a positive assertion, not "nothing to report". That narrowing and omission happens at the
 * upload boundary (`src/episode-upload.ts`'s `toEnrichmentPayload`), never here: this module stays
 * the complete assembler and knows nothing about which subset crosses the wire.
 */

import { createHash, randomUUID } from 'node:crypto';
import type {
  EffortEpisode as EffortEpisodeType,
  EpisodeFinding,
  EpisodeLandingOutcome,
  EpisodeSelfSummary,
  EpisodeTimelineEntry,
} from '@noriq-dev/shared';
import { EffortEpisode } from '@noriq-dev/shared';
import { type AcceptanceReport, failedAcceptance, humanNeededAcceptance } from './acceptance';
import { type LedgerEntry, effectiveStatus } from './adjudication';
import type { RunPipeline } from './stages/types';
import type { DeliveredSteer } from './steering';
import type { CommandObservation } from './verify';

/** Facts `buildEpisode` needs that are not on `RunPipeline` itself, because they are `settle`'s own
 *  local computations rather than pipeline state — threading them through beats re-deriving them a
 *  second time (or, worse, guessing). */
export interface EpisodeExtra {
  /**
   * Paths this sitting's backend can say it touched (`VcsBackend.changedPaths`) — the same call
   * `settle` already makes for the continuation record, reused rather than re-run. Empty when the
   * backend cannot say (no capability, or the call failed) — never inferred from anything else.
   *
   * This is the WHOLE of what rides `EffortEpisode.filesTouched` (RUN-225 measured, did not close):
   * the acceptance criterion asks for examined/modified/generated/verified as distinct facts, and
   * the wire carries one flat `RepoPath[]`. What exists to populate it: `changedPaths` is a git
   * `status`+`diff` UNION with no per-path verb — `worktree.ts` builds a `Set<string>`, discarding
   * whatever A/M/D code git reported, and `VcsBackend` is deliberately VCS-neutral (Perforce and
   * Diversion have no equivalent codes to give), so recovering "modified vs newly generated" would
   * mean widening that interface across three backends — out of this task's scope, not a five-
   * minute fix skipped. EXAMINED has no signal at all: `drivers/types.ts`'s `DriverCapabilities`
   * carries no file-read report from any driver, and inventing one the SDK does not offer would be
   * exactly the guessed field this task's own locked decisions forbid. VERIFIED has no per-file
   * grain either — verify/review evidence is whole-diff and whole-command (`commands`/`testsRun`/
   * `reviewRounds` below), never scoped to one path. So `filesTouched` stays what RUN-224 already
   * made it: authoritative for the modified-or-added union, silent about everything else, on
   * purpose rather than by oversight.
   */
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
   * Undefined on a `build` run: the inline reviewer's OWN acceptance evidence does not travel
   * through here any more (RUN-225 closed that gap) — `buildEpisode` reads it off
   * `ctx.reviewEvidence.acceptance` instead, since it is state `review` produced, not `settle`. The
   * two are mutually exclusive by construction (`workflow.ts`: `verifyActor` and the `review` stage
   * both key off `wf.produces`, and no built-in workflow sets both), so `buildEpisode` merges them
   * with a plain `??` rather than choosing.
   */
  acceptanceEvidence?: AcceptanceReport;
  /**
   * This sitting's observed steer deliveries (RUN-225) — `host.steeringHistory?.(run.id) ?? []`,
   * drained once by `settle` (see `SteeringBridge.steeringHistory`'s own doc on why draining, not
   * merely reading, matters for a long-lived daemon). Empty for a run with no steering bridge wired
   * — indistinguishable from a wired bridge that saw nothing, both being "nothing observed".
   */
  steeringHistory: DeliveredSteer[];
  /**
   * The validated agent self-summary (RUN-226), or null when nothing was requested, budget ran out,
   * the turn timed out, or the reply failed strict validation — `episode-summary.ts`'s
   * `requestSelfSummary` collapses every one of those to the same null so this module never has to
   * tell them apart. Optional on the interface (a fixture, or a future caller with nothing to ask)
   * and reads as null when absent, exactly as "nothing to report" already means elsewhere here.
   */
  selfSummary?: EpisodeSelfSummary | null;
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

/** Which actor computed an `AcceptanceReport` this sitting — the inline reviewer or the dispatched
 *  verify actor, never both (see `EpisodeExtra.acceptanceEvidence`'s doc). Prefixed onto every
 *  acceptance-derived line below so "which stage produced this" (RUN-225's acceptance criterion)
 *  is answerable without cross-referencing `landingOutcome`/`reviewRounds` to guess. */
type AcceptanceSource = 'review' | 'verify';

/** What is still owed when this sitting ends: a kept workspace, any finding still standing (the
 *  same `passed`-aware settlement `findingsOf` uses), and any acceptance criterion the gate could
 *  not settle from a workspace at all. */
function remainingWorkOf(
  ctx: RunPipeline,
  hasRemainingWork: boolean,
  passed: boolean,
  acceptance: AcceptanceReport | undefined,
  acceptanceSource: AcceptanceSource | undefined,
): string[] {
  const out: string[] = [];
  if (hasRemainingWork) out.push('workspace kept — the diff has not reached the integration branch');
  for (const e of ctx.ledger) {
    if (passed || effectiveStatus(e) === 'fixed') continue;
    const where = e.location ? ` at ${e.location}` : '';
    out.push(
      `${effectiveStatus(e) === 'contested' ? 'contested' : 'unanswered'} finding${where}: ${e.claim}`,
    );
  }
  if (acceptance) {
    for (const item of humanNeededAcceptance(acceptance))
      out.push(`[${acceptanceSource}] human decision needed — acceptance #${item.id}: ${item.item.text}`);
  }
  return out;
}

/** Why this sitting did not simply succeed, from what `settle` already has: the terminal reason on
 *  `ctx.exit` (set by whichever gate narrowed it — the verify agent, the inline reviewer, a budget
 *  breach) and, when this sitting computed one, its own acceptance evidence's FAILED criteria. */
function failuresOf(
  ctx: RunPipeline,
  acceptance: AcceptanceReport | undefined,
  acceptanceSource: AcceptanceSource | undefined,
): string[] {
  const out: string[] = [];
  if (ctx.exit.reason) out.push(`terminal reason: ${ctx.exit.reason}`);
  if (acceptance) {
    for (const e of failedAcceptance(acceptance))
      out.push(
        `[${acceptanceSource}] acceptance #${e.id} failed: ${e.item.text}${e.evidence ? ` — ${e.evidence}` : ''}`,
      );
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

/**
 * The runner's own view of when this sitting's work happened.
 *
 * **It does not reach the server, and that is now correct rather than a gap.** This was built under
 * a contract where `recordEpisode` was last-writer-wins per field, so an uploaded `timeline`
 * REPLACED the skeleton's own four entries and the runner had to reproduce them or destroy them —
 * RUN-227 measured that, RUN-261 closed the one entry it could not supply. PLNR-340 then made the
 * daemon upload a PARTIAL enrichment: the server accepts `filesTouched`/`commands`/`testsRun`/
 * `failures`/`findings`/`selfSummary` and STRIPS every other key, because D1 owns identity,
 * lifecycle, cost and review evidence and a daemon must not be able to forge them. So the timeline
 * is now the server's alone, built from its own rows, and nothing assembled here can damage it.
 *
 * Kept because the assembled episode is also this daemon's own local record, and because
 * `agentStartedAt` is a real observation with a named future consumer — the Project Intelligence
 * plan's stage-timing work (RUN-242) needs exactly this moment, and it is cheaper to keep an
 * already-verified observation than to re-derive it. What must NOT happen is a reader concluding
 * from these entries that the server received them: it does not.
 */
function timelineOf(ctx: RunPipeline): EpisodeTimelineEntry[] {
  const out: EpisodeTimelineEntry[] = [];
  // Defensive `if`, not an assumption the wire schema is honoured: `createdAt` is required on
  // `Run` and `dispatchRun`/`createRun` (server-side) both re-read the row AFTER writing
  // `dispatched_at`, so a REAL dispatch carries both — but a hand-built fixture or a future wire
  // change must degrade to "fewer timeline entries", never to a thrown, unparseable datetime.
  if (ctx.run.createdAt) out.push({ at: ctx.run.createdAt, label: 'queued' });
  if (ctx.run.dispatchedAt) out.push({ at: ctx.run.dispatchedAt, label: 'dispatched to runner' });
  // The daemon's own "agent started" (RUN-261). The server has its own, from `runs.started_at`,
  // stamped when it processes this run's FIRST `running` status frame — this one is strictly more
  // accurate, being the moment the spawn actually happened rather than the moment a frame about it
  // was processed, which is why it is worth observing even though PLNR-340 means it never ships.
  // `ctx.agentStartedAt` is
  // the wall-clock moment `stages/execute.ts` observed immediately before `host.startAgent` spawned
  // the session, threaded through `RunPipeline` (via `afterDriver`'s `ctx` parameter, the same route
  // `contextPack`/`continued`/`executedSpec` already use to reach a pipeline built after the driver
  // ran). A CHAIN's entry is its FIRST step's, never a later one's — `chain.ts`'s `noteStarted`/
  // `withAllText` keep the earliest observed across every session the chain spawns, so a wave's
  // tail (spawned last but returned as the chain's own outcome) cannot make the run look like it
  // started later than it did. Absent — never a substituted value — when no session ever spawned
  // this sitting: a chain that fails before its first step (`supervisor.ts`'s
  // `sessionlessChainExit`) carries no `agentStartedAt` to begin with, and `new Date()` here would
  // be the settle moment wearing this label, which is exactly the lie this field exists to avoid.
  // The skeleton's fourth entry, its own "run <outcome>" moment, was never a gap — it is already
  // covered below by this sitting's own `settle:` entry, which is later and strictly more precise.
  if (ctx.agentStartedAt) out.push({ at: ctx.agentStartedAt, label: 'agent started' });
  if (ctx.continued) {
    out.push({ at: ctx.continued.failedAt, label: 'continuation: resumed from a kept worktree' });
  }
  out.push({ at: new Date().toISOString(), label: 'settle: transcript closed, locks released' });
  return out;
}

/**
 * A pure function of run identity plus this sitting's terminal moment (RUN-227 locked decision
 * 2) — never the bare `runId`. Two requirements pull against each other and this satisfies both:
 *
 *   - a RETRY of the same sitting must converge on the same `scopeId`, or the server accumulates
 *     orphaned in-flight uploads (RUN-221's `deriveGenerationId` is the precedent);
 *   - a SECOND SITTING of the same run id (RUN-182 reopens a failed build rather than minting a
 *     new run) must NOT reuse it: `beginIngestEpisode` throws "already complete — this purpose
 *     cannot be reopened" for a scope the server finished, so a reused scopeId would have the
 *     second sitting's enrichment silently refused.
 *
 * The wire `Run` carries no sitting number, so `terminalAt` — `episode.createdAt`, captured ONCE
 * when `buildEpisode` assembled this sitting's payload, and persisted verbatim from then on — is
 * the discriminator actually available. `epi_` mirrors `deriveGenerationId`'s `gen_` prefix:
 * readability only, nothing parses it back apart.
 */
export function deriveEpisodeScopeId(input: { runId: string; terminalAt: string }): string {
  const material = [input.runId, input.terminalAt].join('::');
  return `epi_${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}

/** How much of a command string is worth keeping (RUN-225) — the manifest's own committed text,
 *  not a secret, but nothing bounds how long a repo could write it. */
const MAX_CMD_CHARS = 200;

/**
 * Render one observed command as bounded evidence (RUN-225) — never its output. The transcript
 * already carries the failing tail (`recordVerifyOutcome`), and a verify command's stderr can echo
 * back a credential from the environment it ran against; the strictest bound that still answers
 * "did this run, and did it pass" is to carry NONE of it here. `site` is the stage attribution the
 * acceptance criterion asks for ("Test pass/fail... carry which stage produced them").
 */
export function describeCommandObservation(o: CommandObservation): string {
  const cmd = o.cmd.length > MAX_CMD_CHARS ? `${o.cmd.slice(0, MAX_CMD_CHARS)}…` : o.cmd;
  const outcome = o.passed ? 'passed' : o.timedOut ? 'timed out' : `failed (exit ${o.exitCode})`;
  const tries = o.attempts > 1 ? `, ${o.attempts} attempts` : '';
  return `[${o.site}] ${cmd} — ${outcome}${tries}`;
}

/**
 * Render one steer delivery observation (RUN-225) — the daemon's own DELIVERY outcome
 * (`SteeringBridge.applySteer`'s record), not merely that a steer arrived over the wire. `detail`
 * is bounded the same way command output is: it can carry an error's `.message`, which is
 * ordinarily short but not contractually so.
 */
const MAX_DETAIL_CHARS = 200;
export function describeSteeringEvent(d: DeliveredSteer): string {
  const detail =
    d.detail && d.detail.length > MAX_DETAIL_CHARS ? `${d.detail.slice(0, MAX_DETAIL_CHARS)}…` : d.detail;
  const outcome = d.delivered
    ? `delivered via ${d.via}`
    : `not delivered (${d.via}${detail ? `: ${detail}` : ''})`;
  return `steer ${d.steerId} (${d.mode}) — ${outcome}`;
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
  // The one acceptance report this sitting actually computed, whichever actor computed it (RUN-225:
  // mutually exclusive by construction — see `EpisodeExtra.acceptanceEvidence`'s doc). `ctx` wins
  // the `??` because `review` is a state `settle` has already moved past by the time this runs; a
  // simultaneous verify-actor report cannot exist for the same workflow.
  const acceptance = ctx.reviewEvidence?.acceptance ?? extra.acceptanceEvidence;
  const acceptanceSource: AcceptanceSource | undefined = ctx.reviewEvidence?.acceptance
    ? 'review'
    : extra.acceptanceEvidence
      ? 'verify'
      : undefined;
  // Every deterministic command this sitting watched exit (RUN-225), rendered once and shared by
  // BOTH wire fields: the daemon has exactly one opaque, manifest-declared command to observe
  // (`[verify].cmd`), and this repo's own convention names it "typecheck + lint + test" in one
  // breath (CLAUDE.md's `npm run check`) — there is no finer signal to split "ran" from "tested"
  // by. Duplicating the same true observation under both labels the schema offers is not a guess;
  // inventing a distinct value for either one would be.
  const commandStrings = ctx.commandObservations.map(describeCommandObservation);
  const candidate: EffortEpisodeType = {
    id: randomUUID(),
    projectId: ctx.run.projectId,
    runId: ctx.run.id,
    taskId: ctx.run.anchor?.type === 'task' ? ctx.run.anchor.taskId : null,
    repositoryKey: ctx.repo.manifest.repositoryKey ?? null,
    baseId: ctx.worktree.baseId,
    timeline: timelineOf(ctx),
    filesTouched: extra.filesTouched,
    commands: commandStrings,
    testsRun: commandStrings,
    failures: failuresOf(ctx, acceptance, acceptanceSource),
    findings: findingsOf(ctx.ledger, passed),
    // `reviewEvidence.rounds` (RUN-225) is `reviewWithFeedback`'s exact invocation count (`looks`),
    // set by `review` for every verdict including a clean first-look PASS — closing the ledger's
    // own undercount (a round that raises no NEW finding never touches an entry's `round`, so a
    // single-round clean PASS used to read 0, indistinguishable from "never reviewed"). The ledger
    // fallback stays exactly right for THAT case: no `[verify.agent]`, or a run that never reached
    // `done` going into `review` — 0 is the true count, not an undercount, when review never ran.
    reviewRounds: ctx.reviewEvidence?.rounds ?? ctx.ledger.reduce((max, e) => Math.max(max, e.round), 0),
    tokenUsage: ctx.exit.telemetry.modelUsage ?? {},
    costUSD: ctx.exit.telemetry.costUsd,
    acceptanceCoverage: acceptanceCoverageOf(acceptance),
    // The daemon's own delivery record (RUN-225), drained once by `settle` — see
    // `EpisodeExtra.steeringHistory`'s doc.
    steeringEvents: extra.steeringHistory.map(describeSteeringEvent),
    landingOutcome: landingOutcomeOf(ctx, extra.hasRemainingWork),
    remainingWork: remainingWorkOf(ctx, extra.hasRemainingWork, passed, acceptance, acceptanceSource),
    // `extra.selfSummary` (RUN-226), already requested/bounded/validated by the caller — this
    // module stays pure and never talks to the session itself. Null is the one default
    // `recordEpisode` does NOT overwrite (locked decision), so a sitting that could not get one —
    // no live session, no budget, a timeout, a malformed reply — leaves null here and cannot
    // destroy a self-summary a PRIOR sitting already stored.
    selfSummary: extra.selfSummary ?? null,
    createdAt: new Date().toISOString(),
  };
  // Validated, not merely typed: a schema mismatch (a malformed path, an out-of-range number) fails
  // LOUD here, inside the caller's try/catch, rather than as a silent server-side rejection later.
  return EffortEpisode.parse(candidate);
}
