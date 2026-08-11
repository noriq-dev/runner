/**
 * The plan-checker loop (RUN-141): a fresh read-only actor judges the SPEC, not the diff.
 *
 * This is the phase's payoff. Every error a checker finds here — a requirement the acceptance
 * criteria would not demonstrate, an ordering that cannot happen, a scope that grew past the
 * brief — costs a paragraph to fix. The same error found after the build costs the build.
 *
 * Deliberately the same SHAPE as the verify reviewer (RUN-61/79), and for the same reasons rather
 * than for symmetry:
 *
 *   - a FRESH session each round, because a checker that watched its own criticism answered would
 *     be grading its own instructions;
 *   - bounded rounds, because a loop between two models with no ceiling is a budget;
 *   - and the ADJUDICATION LEDGER carried across them, because total amnesia is what let a
 *     reviewer re-raise a point the other side had already answered with evidence (RUN-56/59).
 *     A planner that cannot make a settled point stay settled will keep paying for it.
 *
 * What it cannot do: gate the run. A FAIL after the last round hands the builder the plan AS IT
 * STANDS, with the findings attached — because the alternative is failing a run over a
 * disagreement between two advisors about work neither of them has done. The gates that stop a
 * bad RESULT are unchanged and downstream.
 */

import type { ExecutionSpec, Run } from '@noriq-dev/shared';
import {
  type LedgerEntry,
  buildLedger,
  parseFindingResponses,
  parseFindings,
  renderLedger,
} from '../adjudication';
import type { BudgetRun } from '../drivers/budget';
import type { AgentDriver, DriverExit, DriverStartOptions } from '../drivers/types';
import type { CheckedExecutionSpec, SpecFinding } from '../execution-spec';
import type { logger as defaultLogger } from '../logger';
import { renderPrompt } from '../prompts';
import { type Clock, defaultClock, elapsedMs } from '../stage-timing';
import type { RunReport } from '../supervisor';
import type { RunTranscript } from '../transcript';
import { type Verdict, parseVerdict } from '../verify-agent';

export interface PlanCheckHost {
  readonly log: typeof defaultLogger;
  report(runId: string, frame: RunReport): void;
  transcript(runId: string): RunTranscript;
  startAgent(driver: AgentDriver, opts: DriverStartOptions, stage?: string): BudgetRun;
  /** The clock a checker round times its own wall-clock stretch against (RUN-242) — see
   *  `PlanHost.clock`'s doc; optional, defaults to `performance.now()`. */
  clock?: Clock;
  /** Ask the PLANNER to revise, in its still-open session. Returns the revised spec, or null when
   *  the turn failed or produced nothing usable — either of which ends the loop. */
  revise(feedback: string): Promise<{ checked: CheckedExecutionSpec; text: string } | null>;
  /** Budget for one checker round, or the reason there is none left. */
  reserve(): { ok: true; budget?: DriverStartOptions['budget'] } | { ok: false; breach: string };
  /** Live guards for a checker session, so its spend counts against the run (RUN-133/159). */
  guards(slot: string): Pick<DriverStartOptions, 'spendGuard' | 'clockGuard'>;
  /** Fold a finished checker round into the run's ledger. Without this a checker's tokens are
   *  invisible to every later reservation, and the run spends its ceiling once per stage instead
   *  of once — the bug RUN-133 exists to prevent, and the one this loop reintroduced. */
  record(slot: string, exit: DriverExit): void;
  /** Charge a checker round's wall clock to the run, the way every other session's is. */
  charge(seconds: number): void;
}

export interface PlanCheckInput {
  run: Run;
  driver: AgentDriver;
  /** The plan under review, as it stands. Replaced by each accepted revision. */
  checked: CheckedExecutionSpec;
  /** Build the checker's prompt for a round: the spec as it stands, plus the ledger so far. */
  prompt: (spec: ExecutionSpec, ledger: string) => string;
  /** Everything a checker spawn needs bar the prompt, handlers, env and budget. */
  start: Omit<DriverStartOptions, 'handlers' | 'env' | 'prompt' | 'budget' | 'multiTurn'>;
  /** How many revision rounds the plan may take. 0 = check once and report, never revise. */
  maxRounds: number;
}

export interface PlanCheckResult {
  /** The plan the builder should be handed — revised if the loop improved it, original if not. */
  checked: CheckedExecutionSpec;
  verdict: Verdict;
  /** Findings from the LAST round, verbatim, for the builder's brief. Empty on a clean pass. */
  findings: string;
  rounds: number;
  ledger: LedgerEntry[];
}

/** Run one checker session and return what it said. */
async function checkOnce(
  host: PlanCheckHost,
  input: PlanCheckInput,
  round: number,
  ledger: LedgerEntry[],
): Promise<{ verdict: Verdict; findings: string } | null> {
  const reservation = host.reserve();
  if (!reservation.ok) {
    host.log.warn('no budget left to check this plan', { runId: input.run.id, breach: reservation.breach });
    return null;
  }
  let text = '';
  const budgetRun = host.startAgent(
    input.driver,
    {
      ...input.start,
      prompt: input.prompt(input.checked.spec, renderLedger(ledger)),
      ...(reservation.budget ? { budget: reservation.budget } : {}),
      ...host.guards(`plan-check:${round}`),
      handlers: {
        onText: (t) => {
          text += t;
          host.transcript(input.run.id).text('agent', t);
        },
      },
    },
    `plan-check:${round}`,
  );
  // Monotonic (RUN-242), and consumed in `finally` below so a round that THROWS (budgetRun.done
  // rejecting) still charges the run for the stretch it actually ran, rather than losing it.
  const clock = host.clock ?? defaultClock;
  const startedAt = clock();
  const slot = `plan-check:${round}`;
  try {
    const exit = await budgetRun.done;
    host.record(slot, exit);
    if (exit.outcome !== 'done') {
      host.log.warn('the plan checker did not finish', { runId: input.run.id, reason: exit.reason });
      return null;
    }
  } finally {
    await budgetRun.stop().catch(() => {});
    host.charge(elapsedMs(startedAt, clock) / 1000);
  }
  const v = parseVerdict(text);
  return { verdict: v.verdict, findings: v.findings };
}

export const checkPlan = async (host: PlanCheckHost, input: PlanCheckInput): Promise<PlanCheckResult> => {
  let ledger: LedgerEntry[] = [];
  let current = input.checked;
  let rounds = 0;

  host.report(input.run.id, { status: 'running', phase: 'agent' });

  // Round 1 always happens; `maxRounds` bounds the REVISIONS after it, exactly as it bounds the
  // builder's fix turns rather than the reviewer's looks (RUN-61).
  const first = await checkOnce(host, { ...input, checked: current }, 1, ledger);
  if (!first) return { checked: current, verdict: 'unknown', findings: '', rounds: 0, ledger };
  let verdict = first.verdict;
  let findings = first.findings;
  host.transcript(input.run.id).milestone(`plan check: ${verdict.toUpperCase()}`);

  for (let round = 1; round <= input.maxRounds; round++) {
    // Only a clear FAIL is a refusal. `unknown` means the checker produced NO JUDGEMENT — it was
    // killed, crashed, or never wrote a VERDICT line — and there is nothing to revise against.
    // Spending a planning round answering a non-report is the mistake RUN-72 caught downstream.
    if (verdict !== 'fail') break;

    const revised = await host.revise(
      renderPrompt('plan-revision', { findings, round, maxRounds: input.maxRounds }),
    );
    // The planner's own answer to each finding, parsed from ITS output — the half of the ledger
    // that makes a point SETTLED rather than merely raised. A finding it answered with a pointer
    // reaches the next checker as an adjudication; one it fixed silently reaches it as
    // `unanswered`, which is honest rather than inventing agreement.
    ledger = buildLedger(ledger, parseFindings(findings), parseFindingResponses(revised?.text ?? ''), round);
    if (!revised) {
      host.log.warn('the planner could not revise — the plan stands as it was', { runId: input.run.id });
      break;
    }
    current = revised.checked;
    rounds = round;
    host.transcript(input.run.id).milestone(`plan revised (round ${round}/${input.maxRounds})`);

    const again = await checkOnce(host, { ...input, checked: current }, round + 1, ledger);
    if (!again) break;
    verdict = again.verdict;
    findings = again.findings;
    host.transcript(input.run.id).milestone(`plan check: ${verdict.toUpperCase()} (round ${round + 1})`);
    if (verdict !== 'fail') break;
  }

  // A plan that never cleared the checker still goes to the builder — WITH the findings. Failing
  // the run here would mean refusing to do work because two advisors disagreed about how, before
  // either had tried. The builder is the one that can settle it, and the gates that stop a bad
  // result are downstream and unchanged.
  if (verdict === 'fail') {
    host
      .transcript(input.run.id)
      .milestone('the plan did not clear its checker — the builder gets it with the findings attached');
  }
  return {
    checked: current,
    verdict,
    findings: verdict === 'fail' ? findings : '',
    rounds,
    ledger,
  };
};

/**
 * The checker's unresolved findings, as spec findings, so the builder reads them in the block it
 * already reads (RUN-139) rather than in a section of their own.
 *
 * A plan that failed its check still goes to the builder — so the builder has to be told WHY, or it
 * inherits a criticised plan looking like an approved one. Marked `note` and not `problem`: a
 * `problem` is the spec contradicting the CHECKOUT, which is a fact, and this is one advisor
 * disagreeing with another about work nobody has done yet.
 */
export function checkerFindings(findings: string): SpecFinding[] {
  const parsed = parseFindings(findings).map((f) => ({
    level: 'note' as const,
    where: f.location || 'the plan',
    message: `the plan checker refused this and it was not resolved: ${f.claim}`,
  }));
  if (parsed.length || !findings.trim()) return parsed;
  // A checker that wrote actionable prose and forgot the numbered format has still refused the
  // plan, and dropping its report because of the formatting would hand the builder a criticised
  // plan looking like an approved one — the exact outcome every comment here promises against.
  return [
    {
      level: 'note',
      where: 'the plan',
      message: `the plan checker refused this plan and the objection was not resolved: ${findings.trim().slice(0, 800)}`,
    },
  ];
}
