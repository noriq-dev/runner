/**
 * Shell tab-completion for the `noriq-runner` CLI.
 *
 * **`COMMAND_TABLE` is the ONE list of commands in this codebase** (RUN-235, locked decision 1).
 * Before this, `cli.ts` carried the same command names three times over — the hand-written `HELP`
 * string, the `switch` in `run()`, and this file's own `COMMANDS` array — and only the switch was
 * ever exercised by a real dispatch, so the other two could rot silently: a completion list that
 * offers a command `HELP` never mentioned, or `HELP` text for a command completion never offers,
 * both read as "the tool knows about this" right up until it doesn't. `cli.ts`'s `HELP` constant
 * now renders its `Commands:` section FROM this table (`formatCommandTable`, below); `COMMANDS` and
 * `COMMAND_FLAGS` are the two views `completionCandidates` needs. The `switch` in `cli.ts` still
 * names each command literally — a dispatcher's own case labels are control flow, not a second
 * documentation list — but `test/cli.test.ts` asserts every name in this table actually appears in
 * the rendered help, which is the direction drift would first show.
 *
 * The candidate logic (`completionCandidates`) lives here in TS, next to the same command/flag
 * vocabulary `cli.ts`'s hand-rolled `parseArgs` reads. The emitted shell wrappers are deliberately
 * dumb: they only marshal the shell's word array into a `noriq-runner __complete <words…>` call and
 * paste the reply back. So bash and zsh share one brain, and the unit suite can exercise it directly
 * without a shell.
 */

export interface CommandSpec {
  name: string;
  /** One or more lines for `cli.ts`'s `HELP` `Commands:` section — an array so a description that
   *  needs to wrap (longer than fits beside a long command name) says so explicitly rather than
   *  `formatCommandTable` guessing where to break a single string. */
  summary: readonly [string, ...string[]];
  /** Flags this command accepts, beyond the always-on `GLOBAL_FLAGS` — the set
   *  `completionCandidates` offers once this command is the settled context. */
  flags?: readonly string[];
}

/** Every top-level command `cli.ts` dispatches (mirrors the switch in `run`), each with the prose
 *  and flags `cli.ts`'s `HELP` and this file's own completion vocabulary both read from — see the
 *  module doc for why this replaced three independently-maintained lists. */
export const COMMAND_TABLE: readonly CommandSpec[] = [
  { name: 'init', summary: ['Guided setup: config + authorization, then show what it found'] },
  {
    name: 'init-project',
    summary: ['Guided .noriq/project.toml for the repo you are in (commit it)'],
    flags: ['--advanced'],
  },
  { name: 'update', summary: ['Check whether this runner is behind (it will not replace itself)'] },
  {
    name: 'auth',
    summary: ['Authorize this machine with Noriq and store its token'],
    flags: ['--server', '--browser', '--device'],
  },
  {
    name: 'start',
    summary: ['Discover repos, register with Noriq, and supervise dispatched runs'],
  },
  { name: 'discover', summary: ['Scan roots for .noriq/project.toml markers and list found repos'] },
  {
    name: 'index-repo',
    summary: ['Index the current repo locally and print a summary — never uploads (see below)'],
    flags: ['--path', '--force', '--json', '--limit', '--show-content', '--check-determinism'],
  },
  {
    name: 'index-status',
    summary: ['Show background-indexing status for the repo at --path (see below)'],
    flags: ['--path', '--server', '--json'],
  },
  {
    name: 'index-reindex',
    summary: ['Ask a running daemon to reindex the repo at --path now'],
    flags: ['--path', '--server'],
  },
  {
    name: 'index-retry',
    summary: ['Same as index-reindex — retrying is just asking again (see below)'],
    flags: ['--path', '--server'],
  },
  {
    name: 'index-cancel',
    summary: ["Ask a running daemon to cancel the repo's active index job, if any"],
    flags: ['--path', '--server'],
  },
  {
    name: 'index-forget-journal',
    summary: [
      'Clear LOCAL index-upload bookkeeping for the repo at --path — never touches',
      'the server (see below)',
    ],
    flags: ['--path', '--server'],
  },
  {
    name: 'index-selftest',
    summary: ['Parse a snippet through every bundled tree-sitter grammar (packaging smoke test)'],
  },
  { name: 'config', summary: ['Load, validate, and print the resolved machine config'] },
  { name: 'completion', summary: ['Print a shell completion script (bash | zsh) — see below'] },
  { name: 'version', summary: ['Print the version'] },
  { name: 'help', summary: ['Print this help'] },
] as const;

/** Every top-level command name, in table order — the shape existing callers (`cli.test.ts`,
 *  `completion.test.ts`, `index.ts`'s re-export) already depend on. */
export const COMMANDS: readonly string[] = COMMAND_TABLE.map((c) => c.name);

/**
 * Render `COMMAND_TABLE` as `cli.ts`'s `HELP` `Commands:` block — the two-column layout that block
 * always had, now computed instead of hand-aligned so a name change can never leave the padding
 * wrong. A name that does not fit the column (only `index-forget-journal` today, at 21 chars) gets
 * its own line, description(s) wrapped to the continuation indent — the exact shape the original
 * hand-written block used for that one entry.
 */
export function formatCommandTable(table: readonly CommandSpec[] = COMMAND_TABLE): string {
  const NAME_COL = 17; // padEnd width; two-space left margin makes the description column start at 19
  const CONT_INDENT = ' '.repeat(2 + NAME_COL);
  const lines: string[] = [];
  for (const { name, summary } of table) {
    const [first, ...rest] = summary;
    lines.push(
      name.length < NAME_COL ? `  ${name.padEnd(NAME_COL)}${first}` : `  ${name}\n${CONT_INDENT}${first}`,
    );
    for (const line of rest) lines.push(`${CONT_INDENT}${line}`);
  }
  return lines.join('\n');
}

/** Flags that consume the next argv token as their value — skipped when scanning for the command. */
const VALUE_FLAGS = new Set(['--config', '--log-level', '--server', '--path', '--limit']);

/** Enum-valued flags: the shell should offer these completions after the flag. */
const FLAG_VALUES: Record<string, readonly string[]> = {
  '--log-level': ['debug', 'info', 'warn', 'error'],
};

/** Offered only before a command is chosen. */
const TOP_LEVEL_FLAGS = ['--help', '--version'];

/** Accepted by every command (parsed globally in `parseArgs`). */
const GLOBAL_FLAGS = ['--config', '--log-level'];

/** Flags meaningful only under a specific command, read off `COMMAND_TABLE` rather than a second
 *  hand-maintained map — see the module doc. */
const COMMAND_FLAGS: ReadonlyMap<string, readonly string[]> = new Map(
  COMMAND_TABLE.filter((c) => c.flags).map((c) => [c.name, c.flags as readonly string[]]),
);

/**
 * Sentinel the shell wrapper recognizes as "fall back to path completion" — used for `--config`,
 * whose value is a filesystem path we can't enumerate better than the shell can.
 */
export const FILE_SENTINEL = '__noriq_files__';

/**
 * Candidates for the word under the cursor.
 *
 * `words` is every token after the program name, up to and INCLUDING the current (possibly empty)
 * word — the wrapper always appends the current word last, even when it is `""` (trailing space),
 * so the final element is unambiguously what is being completed and the rest is settled context.
 */
export function completionCandidates(words: string[]): string[] {
  const current = words.length ? (words[words.length - 1] as string) : '';
  const prior = words.slice(0, -1);
  const prev = prior.length ? (prior[prior.length - 1] as string) : '';

  // A value-consuming flag immediately before the cursor: complete its value, not a new token.
  const enumValues = FLAG_VALUES[prev];
  if (enumValues) return filter(enumValues, current);
  if (prev === '--config' || prev === '--path') return [FILE_SENTINEL];
  if (prev === '--server') return []; // a URL — nothing we can offer
  if (prev === '--limit') return []; // a number — nothing we can offer

  const command = findCommand(prior);
  const candidates = command
    ? [...GLOBAL_FLAGS, ...(COMMAND_FLAGS.get(command) ?? [])]
    : [...COMMANDS, ...TOP_LEVEL_FLAGS, ...GLOBAL_FLAGS];
  return filter(candidates, current);
}

/** First positional token in the settled words = the chosen command (skipping flags + their values). */
function findCommand(prior: string[]): string | undefined {
  for (let i = 0; i < prior.length; i++) {
    const tok = prior[i] as string;
    if (VALUE_FLAGS.has(tok)) {
      i++; // its value is the next token, never the command
      continue;
    }
    if (tok.startsWith('-')) continue;
    return tok;
  }
  return undefined;
}

function filter(list: readonly string[], current: string): string[] {
  return current ? list.filter((c) => c.startsWith(current)) : [...list];
}

/**
 * A completion script for `shell`, meant to be sourced: `eval "$(noriq-runner completion bash)"`.
 *
 * Both wrappers push the settled words plus the current word into `__complete` and paste its
 * newline-separated reply back through the shell's own prefix matcher (`compgen`/`compadd`), so the
 * shell still owns final matching and menu display.
 */
export function completionScript(shell: 'bash' | 'zsh'): string {
  return shell === 'bash' ? BASH_SCRIPT : ZSH_SCRIPT;
}

const BASH_SCRIPT = `# noriq-runner bash completion — eval "$(noriq-runner completion bash)"
_noriq_runner_complete() {
  local cur reply
  cur="\${COMP_WORDS[COMP_CWORD]}"
  local -a prior
  prior=("\${COMP_WORDS[@]:1:$((COMP_CWORD - 1))}")
  reply="$(noriq-runner __complete "\${prior[@]}" "$cur" 2>/dev/null)"
  if [[ "$reply" == "${FILE_SENTINEL}" ]]; then
    COMPREPLY=( $(compgen -f -- "$cur") )
    return
  fi
  local IFS=$'\\n'
  COMPREPLY=( $(compgen -W "$reply" -- "$cur") )
}
complete -F _noriq_runner_complete noriq-runner
`;

const ZSH_SCRIPT = `# noriq-runner zsh completion — eval "$(noriq-runner completion zsh)"
_noriq_runner() {
  local cur
  local -a prior reply
  cur="\${words[CURRENT]}"
  prior=("\${words[2,CURRENT-1]}")
  reply=("\${(@f)$(noriq-runner __complete "\${prior[@]}" "$cur" 2>/dev/null)}")
  if [[ "\${reply[1]}" == "${FILE_SENTINEL}" ]]; then
    _files
    return
  fi
  compadd -- "\${reply[@]}"
}
compdef _noriq_runner noriq-runner
`;
