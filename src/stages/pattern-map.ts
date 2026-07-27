/**
 * The pattern-mapper (RUN-144): for each file the plan anticipates, the closest existing analog in
 * this repo and what to copy from it.
 *
 * `prompts/build.md` has always asked for this in one sentence — "prefer the repo's existing
 * patterns over inventing new ones" — and given the agent no means to comply beyond reading the
 * whole repo on its own budget. This is the means. gsd-core's rule is the right one and it is the
 * only rule here: **name the file and the lines, never the idea.** "Follow the auth pattern" is
 * something a model already believes it is doing; "copy src/controllers/users.ts:12-25" is a thing
 * it can do.
 *
 * Read-only, budget-capped, and skippable: with no anticipated files there is nothing to find an
 * analog FOR, and a mapper asked to map nothing spends tokens to say so.
 *
 * It is also the first WRITER of the repo-intel cache (RUN-143). That pairing is deliberate — a
 * cache with a writer and no reader is dead weight, one with a reader and no writer is a permanent
 * miss — and it is why a cache HIT skips this stage entirely: the facts and the analogs were
 * derived from the same base, so if the facts are still current the analogs are too.
 */

import { RepoPath, type Run } from '@noriq-dev/shared';
import type { BudgetRun } from '../drivers/budget';
import type { AgentDriver, DriverSession, DriverStartOptions } from '../drivers/types';
import type { CheckedExecutionSpec } from '../execution-spec';
import type { logger as defaultLogger } from '../logger';
import { type RepoFacts, emptyFacts, hasFacts } from '../repo-intel';
import type { RunReport } from '../supervisor';
import type { RunTranscript } from '../transcript';

/** One concrete analog: a file, the lines, and what to take from them. */
export interface Analog {
  /** The anticipated path this is an analog FOR. */
  for: string;
  /** The existing file to copy from, repo-relative. */
  analog: string;
  /** Which lines. Free-form ("40-58", "the whole file") — a pointer for a human and an agent,
   *  never something the daemon parses. */
  lines: string;
  /** What to take, concretely. */
  copy: string;
}

export interface PatternMap {
  analogs: Analog[];
  facts: RepoFacts;
}

export interface PatternMapHost {
  readonly log: typeof defaultLogger;
  report(runId: string, frame: RunReport): void;
  transcript(runId: string): RunTranscript;
  startAgent(driver: AgentDriver, opts: DriverStartOptions): BudgetRun;
  steering?: {
    register: (runId: string, session: DriverSession, stop: () => Promise<void>) => void;
    unregister: (runId: string) => void;
  };
  record(slot: string, exit: Awaited<BudgetRun['done']>): void;
  charge(seconds: number): void;
}

export interface PatternMapInput {
  run: Run;
  driver: AgentDriver;
  /** The plan whose anticipated files need analogs. */
  checked: CheckedExecutionSpec;
  prompt: string;
  start: Omit<DriverStartOptions, 'handlers' | 'env' | 'prompt' | 'multiTurn'>;
}

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : []);

/** One line, bounded. The mapper's prose goes into an IMPERATIVE section of the builder's brief
 *  ("read these before writing"), and a repo file that talked the mapper into emitting newlines
 *  could write its own bullet points there. Free text stays free text. */
const str = (v: unknown, cap = 400): string =>
  typeof v === 'string'
    ? v
        .replace(/[\r\n]+/g, ' ')
        .trim()
        .slice(0, cap)
    : '';

/** An analog must point at a path INSIDE this repo. `RepoPath` is the contract's own check — the
 *  same one an execution spec's paths get — and it refuses absolute paths, drive letters,
 *  backslashes and `..`. The mapper reads repo-controlled files, so its output is not trusted for
 *  being ours: an analog is an instruction to the builder to go and read something. */
const confinedPath = (v: unknown): string => {
  const raw = str(v, 300);
  return raw && RepoPath.safeParse(raw).success ? raw : '';
};

/**
 * Pull the map out of a mapper's answer.
 *
 * The LAST fenced block, for the reason the planner's parser takes the last one: a model that
 * thinks aloud shows a draft and then its final answer. Everything is optional and everything is
 * dropped unless it is the right shape — a mapper that invents a field has said nothing, and an
 * analog with no file to point at is the "follow the pattern" answer this stage exists to refuse.
 */
export function parsePatternMap(text: string): PatternMap | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  const candidates = fenced.length ? fenced.reverse() : [text];
  for (const c of candidates) {
    let raw: unknown;
    try {
      raw = JSON.parse(c);
    } catch {
      continue;
    }
    if (typeof raw !== 'object' || raw === null) continue;
    const o = raw as { analogs?: unknown; facts?: Record<string, unknown> };
    const analogs = (Array.isArray(o.analogs) ? o.analogs : [])
      .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
      .map((a) => ({
        for: confinedPath(a.for),
        analog: confinedPath(a.analog),
        lines: str(a.lines, 40),
        copy: str(a.copy),
      }))
      // An analog with no file is the "follow the pattern" answer. Dropped, not softened: the
      // whole value of this stage is that a builder gets somewhere to look.
      .filter((a) => a.analog && a.copy);
    const f = o.facts ?? {};
    const facts: RepoFacts = {
      entryPoints: asStrings(f.entryPoints),
      layout: asStrings(f.layout),
      conventions: asStrings(f.conventions),
      testCommands: asStrings(f.testCommands),
    };
    if (analogs.length || hasFacts(facts)) return { analogs, facts };
  }
  return null;
}

/** Nothing to map. Exposed so the caller can skip the spawn rather than pay to be told. */
export const worthMapping = (checked: CheckedExecutionSpec | null): boolean =>
  (checked?.spec.anticipatedFiles.length ?? 0) > 0;

export const mapPatterns = async (
  host: PatternMapHost,
  input: PatternMapInput,
): Promise<PatternMap | null> => {
  host.report(input.run.id, { status: 'running', phase: 'agent' });
  let text = '';
  const startedAt = Date.now();
  const budgetRun = host.startAgent(input.driver, {
    ...input.start,
    prompt: input.prompt,
    handlers: {
      onText: (t) => {
        text = (text + t).slice(-64_000);
        host.transcript(input.run.id).text('agent', t);
      },
    },
  });
  host.steering?.register(input.run.id, budgetRun.session, budgetRun.stop);

  let exit: Awaited<BudgetRun['done']>;
  try {
    exit = await budgetRun.done;
    host.record('pattern-map', exit);
  } catch (err) {
    host.log.warn('the pattern mapper errored — the builder gets no analogs', {
      runId: input.run.id,
      err: String(err),
    });
    return null;
  } finally {
    host.steering?.unregister(input.run.id);
    await budgetRun.stop().catch(() => {});
    host.charge((Date.now() - startedAt) / 1000);
  }

  if (exit.outcome !== 'done') {
    host.log.warn('the pattern mapper did not finish — the builder gets no analogs', {
      runId: input.run.id,
      reason: exit.reason,
    });
    return null;
  }
  const map = parsePatternMap(text);
  if (!map) {
    host.transcript(input.run.id).milestone('the pattern mapper produced nothing usable');
    return null;
  }
  host
    .transcript(input.run.id)
    .milestone(
      `mapped ${map.analogs.length} analog(s) from this repo${hasFacts(map.facts) ? ', and learned its shape' : ''}`,
    );
  return map;
};

/**
 * Render the analogs into the builder's brief.
 *
 * Separate from the repo FACTS (`renderRepoFacts`), which are about the repo whatever the task is.
 * These are about THIS task's files, so they belong beside the plan rather than beside the
 * orientation — and they are stated as an instruction, because "here is a file that already does
 * this" is only useful if the builder is told to go and read it.
 */
export function renderAnalogs(analogs: readonly Analog[]): string {
  if (!analogs.length) return '';
  const lines = analogs.map(
    (a) => `- for ${a.for || 'this work'}: read ${a.analog}${a.lines ? `:${a.lines}` : ''} — ${a.copy}`,
  );
  return `\n\nWHERE THIS REPO ALREADY DOES THIS — read these before writing the corresponding file. They are the shape to match; a diff that invents a different one is a diff a reviewer will ask you to redo. If one of them turns out not to fit, say which and why rather than quietly departing from it.\n\n${lines.join('\n')}`;
}

/** The empty map — what a caller substitutes when the stage was skipped or produced nothing. */
export const emptyPatternMap = (): PatternMap => ({ analogs: [], facts: emptyFacts() });
