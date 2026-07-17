import { spawn } from 'node:child_process';
import { killProcessTree, treeSpawnOptions } from './proc';
import { renderPrompt } from './prompts';
import { sanitizedAgentEnv } from './security';

// The deterministic verify floor (RUN-19): after a build run's agent exits, the
// daemon shells out to the manifest `verify` command in the Run's worktree —
// zero tokens, no agent. A non-zero exit (or a timeout) gates the Run: it does
// NOT reach done, and the captured output is surfaced. tsc --noEmit belongs in
// this command because vitest/esbuild do NOT catch type errors.

export interface VerifySpec {
  cmd: string;
  timeoutSeconds?: number | null;
  /** Pin the shell `cmd` runs under. Undefined = the platform's own (sh on POSIX, cmd.exe on
   *  Windows) — see the manifest schema for why a committed manifest may want to pin one. */
  shell?: string | null;
}

export interface VerifyResult {
  passed: boolean;
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

/** Runs a command in a cwd, capturing combined stdout+stderr (tail-capped). */
export type VerifyExec = (
  cmd: string,
  cwd: string,
  timeoutMs: number,
  shell?: string,
) => Promise<{ exitCode: number | null; output: string; timedOut: boolean }>;

const MAX_OUTPUT = 16 * 1024; // keep the tail — the failing error is usually last

/** How long to wait for the process group to actually die before giving up on it. */
const KILL_GRACE_MS = 5_000;

const defaultExec: VerifyExec = (cmd, cwd, timeoutMs, shell) =>
  new Promise((resolve) => {
    // Sanitized env (RUN-24): the verify command runs repo code — no secrets, no push.
    // `detached` puts the shell and everything it spawns in one process group, so the
    // timeout can kill the WHOLE tree. Without it `child.kill()` signals only the
    // `/bin/sh -c …` wrapper: a hung `vitest` grandchild survives, keeps stdout/stderr
    // open, and 'close' — which fires only once all stdio are closed — never arrives.
    //
    // POSIX-only, though (RUN-42): on Windows `detached` means "new CONSOLE", not "new process
    // group" — so it does not buy the above, and it does pop a console window on a daemon that
    // should be invisible. Windows gets its tree killed by taskkill instead (see killTree).
    const child = spawn(cmd, {
      cwd,
      // A user-written shell one-liner from the COMMITTED manifest. On Windows `true` means
      // cmd.exe; `[verify] shell` lets a repo pin one instead — see the schema for the trade.
      shell: shell ?? true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizedAgentEnv(),
      ...treeSpawnOptions(),
    });
    let output = '';
    let timedOut = false;
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const capture = (d: Buffer) => {
      output += d.toString();
      if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    const settle = (r: { exitCode: number | null; output: string; timedOut: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      resolve(r);
    };

    /** Kill the shell AND everything it spawned — see proc.ts for why that differs per platform,
     *  and why signalling only the wrapper would hang this promise rather than merely leak. */
    const killTree = () => killProcessTree(child, { force: true });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      // Belt and braces. If the group kill still misses something holding the pipes,
      // 'close' never fires and this promise never settles — and because landRun awaits
      // runVerify inside withRepoLock, an unsettled verify wedges EVERY later run on that
      // repo for the daemon's life. A timeout must always produce an answer.
      grace = setTimeout(() => settle({ exitCode: null, output, timedOut: true }), KILL_GRACE_MS);
    }, timeoutMs);

    child.on('close', (code) => settle({ exitCode: code, output, timedOut }));
    child.on('error', (err) => settle({ exitCode: null, output: `${output}\n${String(err)}`, timedOut }));
  });

export const DEFAULT_VERIFY_TIMEOUT_SECONDS = 600;

/** Run the deterministic verify command. passed = clean exit within the timeout. */
export async function runVerify(
  spec: VerifySpec,
  cwd: string,
  deps: { exec?: VerifyExec } = {},
): Promise<VerifyResult> {
  const exec = deps.exec ?? defaultExec;
  const timeoutMs = (spec.timeoutSeconds ?? DEFAULT_VERIFY_TIMEOUT_SECONDS) * 1000;
  const { exitCode, output, timedOut } = await exec(spec.cmd, cwd, timeoutMs, spec.shell ?? undefined);
  return { passed: !timedOut && exitCode === 0, exitCode, output: output.trim(), timedOut };
}

/** Format a verify failure for a task comment (the floor-gate surface). */
export function verifyFailureComment(spec: VerifySpec, result: VerifyResult): string {
  const why = result.timedOut
    ? `timed out after ${spec.timeoutSeconds ?? DEFAULT_VERIFY_TIMEOUT_SECONDS}s`
    : `exited ${result.exitCode}`;
  const tail = result.output.slice(-4000);
  return `❌ Deterministic verify failed (${why}) — this build did not pass the floor gate and cannot reach done.\n\n\`${spec.cmd}\`\n\n\`\`\`\n${tail}\n\`\`\``;
}

/** How many times a failing gate is handed back to the live agent before a human is needed
 *  (RUN-29; RUN-21's K=2). Bounded because an agent that cannot fix it in two tries is not
 *  going to on the third — it is going to keep spending. */
export const MAX_VERIFY_FIXES = 2;

/**
 * What the agent is told when the gate refuses its work (RUN-29).
 *
 * The gate used to be a verdict: verify failed, the run failed, and a human re-dispatched — so
 * the agent re-derived a failure the daemon already had the exact output for. This makes it a
 * feedback loop instead: the same live session gets the command, the exit code, and the output,
 * in context, and fixes it.
 *
 * The tail, not the head: a failing suite's useful part is at the end (the assertion, the stack),
 * and the start is setup noise. Capped because this is a user turn — an unbounded dump would cost
 * more tokens than the fix.
 */
export function verifyFeedbackPrompt(spec: VerifySpec, result: VerifyResult, attempt: number): string {
  return renderPrompt('verify-feedback', {
    cmd: spec.cmd,
    timedOut: result.timedOut,
    timeoutSeconds: spec.timeoutSeconds ?? DEFAULT_VERIFY_TIMEOUT_SECONDS,
    // Stringified so a null exit code renders as "exited null" (killed, no code) rather
    // than vanishing — the agent should see the truth, odd as it reads.
    exitCode: String(result.exitCode),
    output: result.output.slice(-4000),
    last: attempt >= MAX_VERIFY_FIXES,
  });
}
