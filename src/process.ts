import { spawn } from "node:child_process";

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export async function runProcess(options: {
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  stdin?: string;
}): Promise<ProcessResult> {
  const started = performance.now();
  const child = spawn(options.command, options.args ?? [], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const maximum = options.maxOutputBytes ?? 4 * 1024 * 1024;
  let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const collect = (
    current: Buffer<ArrayBufferLike>,
    chunk: Buffer<ArrayBufferLike>,
  ): Buffer<ArrayBufferLike> =>
    Buffer.concat([current, chunk]).subarray(-maximum);
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    stdout = collect(stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    stderr = collect(stderr, chunk);
  });
  if (options.stdin !== undefined) child.stdin.end(options.stdin);
  else child.stdin.end();

  let timedOut = false;
  let forcedTermination: NodeJS.Timeout | undefined;
  const terminate = () => {
    if (child.exitCode !== null) return;
    if (process.platform === "win32") child.kill("SIGTERM");
    else if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      forcedTermination ??= setTimeout(() => {
        if (child.exitCode !== null || child.pid === undefined) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }, 5_000);
      forcedTermination.unref();
    }
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, options.timeoutMs);
  const abort = () => terminate();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) terminate();
  const result = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  }).finally(() => {
    clearTimeout(timeout);
    if (forcedTermination) clearTimeout(forcedTermination);
    options.signal?.removeEventListener("abort", abort);
  });
  return {
    ...result,
    stdout: stdout.toString("utf8"),
    stderr: stderr.toString("utf8"),
    durationMs: Math.max(0, Math.round(performance.now() - started)),
    timedOut,
    stdoutTruncated: stdoutBytes > maximum,
    stderrTruncated: stderrBytes > maximum,
  };
}
