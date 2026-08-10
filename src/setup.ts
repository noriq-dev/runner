import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SetupSpec } from '@noriq-dev/shared';
import { defaultClock, elapsedMs } from './stage-timing';
import type { VerifyExec } from './verify';

/**
 * Mechanical workspace bootstrap (RUN-202): the commands the DAEMON runs to make a freshly leased
 * workspace ready, before any agent spends a token in it.
 *
 * The cost this removes is measured, not theoretical. A fresh worktree has no `node_modules`, so
 * every run opened with its agent discovering that: builders spent turns on `npm ci`, and one
 * reviewer — read-only by posture, under a restricted-network profile — burned its turns finding
 * no local vitest, watching `npx` die `EAI_AGAIN`, and writing a paragraph about it instead of
 * judging the diff. The daemon can do all of that for free, deterministically, before the run
 * begins. Mechanical setup is not agent work.
 *
 * Three properties make this safe to hand a COMMITTED manifest:
 *
 *   - It runs under `sanitizedAgentEnv`, exactly as `verify.cmd` does — the same posture an agent
 *     gets, no push credentials, no Noriq token. A marker file must not become a daemon-privileged
 *     exec primitive; this is the boundary `verify.cmd` already crosses and not one inch wider.
 *   - It is FAIL-OPEN. A failing command is reported loudly — a log line, a transcript milestone,
 *     and a line in the agent's brief — and the run proceeds with the environment it has. Setup is
 *     preparation, never a gate: the deterministic verify still judges whatever gets built, and a
 *     repo whose bootstrap broke should get a run that says so rather than no run at all.
 *   - It charges nothing agent-shaped. Setup seconds are not the run's wall-clock ceiling (RUN-30:
 *     that ceiling measures AGENT time), so a slow install cannot eat the budget for the work.
 */

/**
 * Where a completed bootstrap records itself — the DAEMON's own directory, never the workspace.
 *
 * The obvious place was a dotfile in the tree, and it is wrong: `checkpoint` stages with
 * `git add -A`, so the marker would ride into the run's own commit and out through the reviewer's
 * diff into the merge request — and `git status --porcelain` would report a run that changed
 * nothing as having work, defeating the `no_changes` gate. A workspace must contain exactly what
 * the agent put there. Keyed by the absolute workspace path, which is per-run by construction.
 */
export const SETUP_MARKER_DIR = path.join(os.homedir(), '.noriq', 'setup-markers');

const markerFor = (cwd: string, dir: string): string =>
  path.join(dir, `${createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16)}.json`);

/** What one command did. `timedOut` is separated from a non-zero exit because the remedies differ:
 *  one is a broken command, the other a ceiling that is too low for this repo. */
export interface SetupCommandResult {
  cmd: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  seconds: number;
  /** Tail of combined output — only kept for a FAILURE, where it is the whole diagnostic. */
  output?: string;
}

export interface SetupResult {
  /** False if any command failed — the caller tells the agent, and does not stop. */
  ok: boolean;
  ran: SetupCommandResult[];
  /** True when a completed marker already matched this spec, so nothing was run. */
  skipped: boolean;
}

/** How much failure output rides into the brief. The tail, like verify: the error is usually last. */
const OUTPUT_TAIL = 2_000;

/**
 * A stable identity for a spec, stored in the marker.
 *
 * Compared rather than merely existence-checked so that EDITING `[setup]` re-runs it: a repo that
 * adds a codegen step to its bootstrap would otherwise keep resuming into workspaces that never
 * ran it, and debug a phantom. The commands themselves are the identity — a timeout change alters
 * nothing about what the workspace contains.
 */
const specKey = (spec: SetupSpec): string => JSON.stringify(spec.cmds);

/**
 * Run a manifest's `[setup]` in a workspace. Never throws: every failure path is a reported result.
 *
 * `exec` is the same injected seam `verify` uses (the DI convention: tests never touch a real
 * shell), which also means setup inherits its process-group kill and its output cap for free.
 *
 * The marker makes this idempotent across SITTINGS, which is the case that matters: a continuation
 * or a resumed park re-enters a workspace that is already bootstrapped, and re-running `npm ci`
 * there would spend a minute to arrive where it started. A workspace the backend recreated has no
 * marker and gets a fresh bootstrap — the property is "this tree has run this spec", not "this run
 * has".
 */
export async function runSetup(
  spec: SetupSpec | null | undefined,
  cwd: string,
  exec: VerifyExec,
  log?: { info: (m: string, d?: unknown) => void; warn: (m: string, d?: unknown) => void },
  markerDir: string | undefined = SETUP_MARKER_DIR,
): Promise<SetupResult | null> {
  if (!spec?.cmds.length) return null; // no section, or an empty one — nothing to say

  const marker = markerFor(cwd, markerDir ?? SETUP_MARKER_DIR);
  const key = specKey(spec);
  if (existsSync(marker)) {
    // A marker we cannot read is treated as absent: re-running a bootstrap is idempotent by
    // construction (that is what these commands are), so the cost of being wrong here is time.
    const previous = await readFile(marker, 'utf8').catch(() => '');
    if (previous.trim() === key) return { ok: true, ran: [], skipped: true };
  }

  const timeoutMs = (spec.timeoutSeconds || 600) * 1_000;
  const ran: SetupCommandResult[] = [];
  for (const cmd of spec.cmds) {
    const startedAt = defaultClock();
    // `exec` is contracted never to reject; the catch is for a caller that injected one that does,
    // and turns it into the same reported failure rather than an exception out of `prepare`.
    const r = await exec(cmd, cwd, timeoutMs).catch((err: unknown) => ({
      exitCode: null,
      output: String(err),
      timedOut: false,
    }));
    // RUN-242: monotonic, because this figure is REPORTED to the agent in its brief — a
    // wall-clock step would put a wrong or negative duration in front of it.
    const seconds = Math.round(elapsedMs(startedAt) / 1000);
    const ok = r.exitCode === 0 && !r.timedOut;
    ran.push({
      cmd,
      ok,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      seconds,
      ...(ok ? {} : { output: r.output.slice(-OUTPUT_TAIL) }),
    });
    if (ok) {
      log?.info('workspace setup', { cmd, seconds });
      continue;
    }
    // STOP at the first failure. These are ordered steps — `npm ci` then a codegen that needs it —
    // so running the rest would report a second failure that is only the first one's shadow.
    log?.warn('workspace setup failed — the run proceeds with the environment it has', {
      cmd,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
    });
    return { ok: false, ran, skipped: false };
  }

  // Written only on a clean pass: a partial bootstrap must not look complete to the next sitting.
  // Best-effort — a marker that cannot be written costs a repeated bootstrap, never correctness.
  await mkdir(path.dirname(marker), { recursive: true }).catch(() => {});
  await writeFile(marker, key, 'utf8').catch(() => {});
  return { ok: true, ran, skipped: false };
}

/**
 * Forget a workspace's bootstrap. Called where the workspace is DISPOSED, so a later lease at the
 * same path (run ids are unique, but a backend may reuse a pooled directory) bootstraps a tree
 * that no longer contains what the last one installed. Best-effort by design: the failure mode of
 * a stale marker is a skipped install, and of a missing one a repeated install — one is worth
 * guarding against, neither is worth failing a run over.
 */
export async function clearSetupMarker(cwd: string, markerDir: string = SETUP_MARKER_DIR): Promise<void> {
  await rm(markerFor(cwd, markerDir), { force: true }).catch(() => {});
}

/** The one-line milestone for the transcript. Absent when there was nothing to do. */
export function setupMilestone(result: SetupResult | null): string | null {
  if (!result || result.skipped || !result.ran.length) return null;
  if (result.ok) {
    const total = result.ran.reduce((s, r) => s + r.seconds, 0);
    return `workspace setup: ${result.ran.map((r) => r.cmd).join(', ')} — ok, ${total}s`;
  }
  const failed = result.ran.at(-1);
  return `workspace setup FAILED: ${failed?.cmd} (${failed?.timedOut ? 'timed out' : `exit ${failed?.exitCode}`}) — the environment may be incomplete`;
}

/**
 * What the AGENT is told, and only when something went wrong.
 *
 * A successful bootstrap is deliberately silent: telling an agent its tools are installed spends
 * context to describe the normal case. A FAILED one is the opposite — an agent that does not know
 * its environment is broken reads every resulting error as its own fault and starts debugging the
 * repo, which is the exact turn-burning this feature exists to prevent.
 */
export function setupBriefNote(result: SetupResult | null): string {
  if (!result || result.ok) return '';
  const failed = result.ran.at(-1);
  if (!failed) return '';
  const how = failed.timedOut ? 'timed out' : `exited ${failed.exitCode}`;
  return `\n\nWORKSPACE SETUP FAILED before you started — the daemon ran this repo's bootstrap and \`${failed.cmd}\` ${how}. The environment may be incomplete (missing dependencies, no generated code), so a tool that is "not found" is probably this and not your mistake. You may retry the command yourself if your permissions allow it; if you cannot, say so plainly in your report rather than working around a broken toolchain silently.\n\nIts last output:\n${failed.output ?? '(no output captured)'}`;
}
