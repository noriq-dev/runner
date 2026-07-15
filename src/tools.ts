import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AgentTool } from '@noriq-dev/shared';

const KNOWN: AgentTool[] = ['claude', 'codex'];

/** Detect installed agent drivers by looking for their executables on PATH.
 *  Used when runner.toml doesn't pin `tools`. */
export function detectTools(env: NodeJS.ProcessEnv = process.env): AgentTool[] {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return KNOWN.filter((cmd) =>
    dirs.some((d) => existsSync(path.join(d, cmd)) || existsSync(path.join(d, `${cmd}.exe`))),
  );
}
