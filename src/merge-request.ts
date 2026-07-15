import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Opening a merge request for a completed plan (RUN-28).
 *
 * ## Whose credentials, and why this one is bigger than autoPush
 *
 * The operator's `gh`, already on the box and already authed — the same shape as RUN-27, which
 * reuses their git credentials rather than introducing a token in `runner.toml`. A GitHub token
 * in config would be a genuinely new secret on the machine, a new thing to leak, and a second
 * auth path to keep working.
 *
 * But be honest that this IS a bigger step than autoPush: pushing a branch publishes bytes;
 * opening a PR acts **as the operator**, under their name, in their org. It goes in
 * THREAT-MODEL.md next to the autoPush table rather than sliding in as an implementation detail.
 *
 * The agent gets none of it: `sanitizedAgentEnv` strips credentials and this runs in the DAEMON,
 * after the gate, on a branch the gate passed.
 *
 * ## Why `gh` and not the REST API
 *
 * The API needs a token — the thing we are declining to introduce. `gh` already holds the
 * operator's auth in their keyring, handles enterprise hosts and SSO, and if it is missing we can
 * hand a human the exact command instead of failing. A forge that is not GitHub gets the same
 * treatment via RUN-44's abstraction; hardcoding an API client now would be the thing that has to
 * be undone then.
 */

export interface MergeRequestResult {
  ok: boolean;
  url?: string;
  /** Why it could not be opened. Never throws — a plan's work is landed and pushed either way. */
  detail?: string;
  /** The command a human can run, when we could not. */
  command?: string;
}

export interface MergeRequestInput {
  repoRoot: string;
  /** The plan's working branch — already pushed (autoPush is a hard prerequisite). */
  head: string;
  /** The protected branch, named by the repo's manifest. Never by a dispatch. */
  base: string;
  planTitle: string;
  planKey: string;
}

/** Injectable for tests; defaults to running the real `gh`. */
export type GhExec = (args: string[], cwd: string) => Promise<{ stdout: string }>;

const defaultGh: GhExec = (args, cwd) => exec('gh', args, { cwd });

export function mergeRequestBody(input: MergeRequestInput): string {
  return [
    `Opened by the Noriq Runner: every task in **${input.planTitle}** is done.`,
    '',
    `Each run in this plan landed on \`${input.head}\` and was verified there — rebased onto the`,
    'branch tip, gated, then fast-forwarded in. This request is the plan as a whole, which is the',
    'unit worth reviewing: one coherent body of work rather than a click per run.',
    '',
    `Plan: \`${input.planKey}\``,
  ].join('\n');
}

/**
 * Open the PR. Returns rather than throws: the work is landed AND pushed by the time this runs,
 * so a failure here is news, not a lost diff — and the caller records it so nobody retries a
 * broken thing forever without learning why.
 */
export async function openMergeRequest(
  input: MergeRequestInput,
  gh: GhExec = defaultGh,
): Promise<MergeRequestResult> {
  const args = [
    'pr',
    'create',
    '--base',
    input.base,
    '--head',
    input.head,
    '--title',
    `${input.planTitle} (plan complete)`,
    '--body',
    mergeRequestBody(input),
  ];
  const command = `gh ${args.map((a) => (a.includes(' ') || a.includes('\n') ? JSON.stringify(a) : a)).join(' ')}`;
  try {
    const { stdout } = await gh(args, input.repoRoot);
    // gh prints the PR URL on success.
    const url =
      stdout
        .trim()
        .split('\n')
        .find((l) => l.startsWith('http')) ?? undefined;
    return { ok: true, url };
  } catch (err) {
    const detail = (err as Error).message;
    // An existing PR is not a failure: the plan's branch already has one open, which is the
    // desired end state. Reporting it as failed would have the daemon retry forever.
    if (/already exists/i.test(detail)) return { ok: true, detail: 'a pull request is already open' };
    return { ok: false, detail, command };
  }
}
