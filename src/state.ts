import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Small persisted daemon state — currently just the assigned runner id, so a
 *  restart re-registers as the SAME runner (triggering server-side reconcile). */
export const DEFAULT_STATE_PATH = path.join(os.homedir(), '.noriq', 'runner-state.json');

export interface RunnerState {
  runnerId?: string;
}

export async function loadState(statePath: string = DEFAULT_STATE_PATH): Promise<RunnerState> {
  if (!existsSync(statePath)) return {};
  try {
    return JSON.parse(await readFile(statePath, 'utf8')) as RunnerState;
  } catch {
    return {}; // corrupt state → start fresh
  }
}

export async function saveState(state: RunnerState, statePath: string = DEFAULT_STATE_PATH): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}
