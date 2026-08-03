import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Run } from '@noriq-dev/shared';
import type { ModelUsage } from './drivers/types';
import { renderPrompt } from './prompts';
import type { StepSummary } from './stages/chain';
import type { Workspace } from './vcs/types';
import type { WorkflowCatalog } from './workflow-store';

/**
 * Runs parked on a human (RUN-30) — the daemon's side of `blocked`.
 *
 * On disk rather than in memory because that is the entire point: a run parked on a question is
 * waiting for a person, who may answer in ten minutes or tomorrow morning, and a daemon that
 * forgets across a restart would strand the run AND the worktree holding its work. `state.ts` is
 * the precedent; this is deliberately a separate file, because state.ts is one small record the
 * daemon rewrites wholesale and this is a growing set with independent lifetimes.
 *
 * The server is still the authority on WHETHER a run is blocked. This only remembers what the
 * server cannot know: which local session and worktree to bring back.
 */
export const DEFAULT_PARKED_PATH = path.join(os.homedir(), '.noriq', 'parked-runs.json');

export interface ParkedRun {
  run: Run;
  /**
   * The workflow definitions pinned when this run was dispatched (RUN-192).
   *
   * A park may survive both edits to workflow files and a daemon restart. Resuming against a
   * freshly loaded catalog would let those edits change the posture, prompt and pipeline of a run
   * that already started. Older parks omit this field and keep their pre-RUN-192 behaviour.
   */
  workflowCatalog?: WorkflowCatalog;
  /** What `resume` takes. Null on a driver with no resumable session — such a run can be
   *  reported blocked but not brought back, so we refuse to park it (see supervisor). */
  sessionId: string | null;
  /** The run's Noriq agent, which OUTLIVES the process: one identity per run, across parks. */
  agentId: string;
  agentLabel: string;
  /**
   * The agent's bound MCP token, kept so the resumed process can still reach Noriq.
   *
   * It has to be persisted rather than re-minted, because RUN-43 made the run→agent credential
   * deliberately not re-issuable: two live processes able to act as one identity is exactly the
   * ambiguity that invariant removes. A park is not a second process — it is the same one, later
   * — so it keeps the same credential.
   *
   * This is why DEFAULT_PARK_TTL_HOURS must stay comfortably inside the 7-day token TTL: a park
   * that outlives its token resumes an agent that cannot report anything it does.
   *
   * Disk exposure: strictly less than what ~/.noriq already holds. This token can be one agent
   * in one project; the daemon's own token next to it can register runners and reach every
   * project its human can.
   */
  mcpToken: string;
  /**
   * The Run's leased workspace, kept alive across the park: it holds work that exists nowhere
   * else. Persisted WHOLE (RUN-50) — including the backend-owned `location`, which is why that
   * field's contract is JSON-serializable — so a resume hands the backend exactly what its
   * `lease()` minted, instead of the supervisor rebuilding a git-shaped object from loose
   * fields (the old shape hand-assembled a WorktreeInfo with `baseSha: ''`, a lie that only
   * worked because git's hasChanges tolerates it).
   */
  workspace: Workspace;
  /**
   * Spend so far. A resumed run inherits the REMAINDER of its budget, never a fresh one —
   * otherwise park/resume is an unbounded-spend loophole: ask a question, get a new ceiling.
   *
   * `modelUsage` (RUN-59) is the per-model breakdown of that spend, carried so a resumed run's mix
   * keeps summing to its total across sittings. Absent when the pre-park sessions could not attribute
   * spend by model (codex, the claude usage-fallback) or the park predates RUN-59 — a resume then
   * reports NO mix rather than one that does not add up.
   */
  spent: { tokens: number; usd: number; modelUsage?: Record<string, ModelUsage> };
  /**
   * Seconds the run has actually been RUNNING, excluding time parked.
   *
   * Wall-clock budget must not count the wait. A run parked at 5pm and answered at 9am has
   * burned 16 hours of clock and zero of anything else; charging it that would mean every
   * overnight answer arrives to a run that is already dead — which would make the whole
   * feature a slower way to lose work.
   */
  activeSeconds: number;
  parkedAt: string;
  /** The question the agent asked, for the log and for the resume turn. */
  question: string | null;
  /**
   * Which STAGE ACTOR asked (RUN-190), or absent for the primary session's parks.
   *
   * A stage park is an IN-PROCESS wait: the planner, checker, mapper and reviewer run inside a
   * live `supervise` stack, so the daemon parks the run and holds the stage until the answer
   * arrives over ws, then re-runs the stage with the answer — no session to restore, `sessionId`
   * null. This record exists for the crash case: a daemon restart loses the waiting stack, and a
   * resume that finds a stage park with nobody waiting must say so rather than pretend — the
   * stage's work does not exist yet, so re-dispatching the run loses nothing.
   */
  stage?: 'plan' | 'plan-check' | 'pattern-map' | 'review' | null;
  /**
   * Which STEP of a decomposed run was speaking when it parked (RUN-168), or null/absent for an
   * undecomposed run and every park written before this existed.
   *
   * Without it a resume restores one session, runs it, and stops — so a chain that parked on step
   * two of five would come back, finish step two, and report the run DONE having silently skipped
   * the rest of its plan. That is a correctness bug rather than a missing feature, which is why it
   * is not deferrable to whenever chains grow their next capability.
   */
  stepId?: string | null;
  /**
   * What the steps BEFORE the parked one concluded (RUN-171) — the hand-off a resumed chain would
   * otherwise start without.
   *
   * `executeChain` gives every step the earlier steps' summaries, and that is the whole argument
   * for a chain of fresh contexts over one long one: each link starts clean but not ignorant. A
   * resume rebuilt that array empty, so a five-step run parked on step two came back and briefed
   * step three with step two's post-answer output alone — step one's conclusions gone, and step
   * three rediscovering what two steps had already established.
   *
   * Strictly the steps before it. The parked step's own summary is captured when it FINISHES,
   * after the resume, exactly as it would have been — its state at park time is a question, not a
   * conclusion, and recording that as a finding would hand the next step a half-thought.
   */
  priorSteps?: StepSummary[];
}

type ParkedFile = { parked: ParkedRun[] };

/**
 * How long a park may sit before the daemon gives up on it.
 *
 * Three days, not seven, and the ceiling is not arbitrary: the resumed agent carries the OAuth
 * token minted for it at dispatch, which lives 7 days. A park allowed to run to that edge would
 * resume an agent whose every Noriq call 401s — the work looks alive and reports nothing. 72h
 * keeps a wide margin, and a question nobody has answered in three days is not one a resumed
 * session still has the right context to act on anyway.
 */
export const DEFAULT_PARK_TTL_HOURS = 72;

export class ParkedStore {
  private readonly file: string;
  private cache: Map<string, ParkedRun> | null = null;

  constructor(file: string = DEFAULT_PARKED_PATH) {
    this.file = file;
  }

  private async load(): Promise<Map<string, ParkedRun>> {
    if (this.cache) return this.cache;
    if (!existsSync(this.file)) {
      this.cache = new Map();
      return this.cache;
    }
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as ParkedFile;
      // Drop entries from a pre-RUN-50 daemon (loose worktreePath fields, no workspace):
      // resuming one would hand the backend a workspace it cannot read. Same trade as the
      // corrupt-file case below — the park is forgotten, the worktree survives for the human.
      this.cache = new Map((parsed.parked ?? []).filter((p) => !!p.workspace).map((p) => [p.run.id, p]));
    } catch {
      // Corrupt file → start empty rather than refuse to boot. The cost is a forgotten park
      // (whose worktree still exists for the human); the cost of throwing is a dead daemon.
      this.cache = new Map();
    }
    return this.cache;
  }

  private async flush(): Promise<void> {
    const parked = [...(this.cache ?? new Map()).values()];
    await mkdir(path.dirname(this.file), { recursive: true });
    // Write-then-rename: a crash mid-write must not leave a truncated file that reads as
    // "nothing was parked" — that would silently abandon runs with unmerged work in them.
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ parked }, null, 2)}\n`);
    await rename(tmp, this.file);
  }

  async park(entry: ParkedRun): Promise<void> {
    (await this.load()).set(entry.run.id, entry);
    await this.flush();
  }

  async get(runId: string): Promise<ParkedRun | null> {
    return (await this.load()).get(runId) ?? null;
  }

  async list(): Promise<ParkedRun[]> {
    return [...(await this.load()).values()];
  }

  async unpark(runId: string): Promise<ParkedRun | null> {
    const map = await this.load();
    const found = map.get(runId) ?? null;
    if (found) {
      map.delete(runId);
      await this.flush();
    }
    return found;
  }
}

/**
 * Parks that have waited too long to be worth resuming.
 *
 * A parked run pins a worktree and a branch while the base moves on underneath it; resuming a
 * week-old session onto a base it no longer recognises produces a confident diff against a world
 * that is gone. Expiring says so out loud instead. The worktree is NOT reaped — it holds work
 * that exists nowhere else, which is the one thing the daemon never destroys.
 */
export const expiredParks = (
  parked: ParkedRun[],
  now: Date,
  ttlHours = DEFAULT_PARK_TTL_HOURS,
): ParkedRun[] =>
  parked.filter((p) => {
    const age = now.getTime() - new Date(p.parkedAt).getTime();
    return Number.isFinite(age) && age > ttlHours * 3600_000;
  });

/** The turn handed to a resumed agent. It has its own context; this is the answer, not a briefing. */
/**
 * What the resumed session is handed. The answer IS the prompt — the session already holds the
 * brief, the task and the repo tour, and re-sending them would waste the context and confuse a
 * conversation that is mid-thought.
 *
 * `changed` is the exception (RUN-164): a park can last up to 72 hours, and a human answering the
 * question may well have corrected the task's execution spec at the same time — the dashboard
 * exists so they can (RUN-137). Sending nothing when nothing moved keeps the resume as cheap as it
 * was; sending the DIFFERENCE when it did is the only way the session learns its own contract
 * changed under it.
 */
export const resumePrompt = (question: string | null, answer: string, changed = ''): string =>
  renderPrompt('resume', { question, answer, changed });
