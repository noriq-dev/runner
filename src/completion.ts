/**
 * Shell tab-completion for the `noriq-runner` CLI.
 *
 * The candidate logic (`completionCandidates`) is the single source of truth and lives here in TS,
 * next to the same command/flag vocabulary `cli.ts`'s hand-rolled `parseArgs` reads — a completion
 * script that lists commands is a second copy that silently rots the day someone adds a subcommand.
 * The emitted shell wrappers are deliberately dumb: they only marshal the shell's word array into an
 * `noriq-runner __complete <words…>` call and paste the reply back. So bash and zsh share one brain,
 * and the unit suite can exercise it directly without a shell.
 */

/** Every top-level command `cli.ts` dispatches (mirrors the switch in `run`). */
export const COMMANDS = [
  'init',
  'init-project',
  'update',
  'auth',
  'start',
  'discover',
  'config',
  'completion',
  'version',
  'help',
] as const;

/** Flags that consume the next argv token as their value — skipped when scanning for the command. */
const VALUE_FLAGS = new Set(['--config', '--log-level', '--server']);

/** Enum-valued flags: the shell should offer these completions after the flag. */
const FLAG_VALUES: Record<string, readonly string[]> = {
  '--log-level': ['debug', 'info', 'warn', 'error'],
};

/** Offered only before a command is chosen. */
const TOP_LEVEL_FLAGS = ['--help', '--version'];

/** Accepted by every command (parsed globally in `parseArgs`). */
const GLOBAL_FLAGS = ['--config', '--log-level'];

/** Flags meaningful only under a specific command. */
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  auth: ['--server', '--browser', '--device'],
  'init-project': ['--advanced'],
};

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
  if (prev === '--config') return [FILE_SENTINEL];
  if (prev === '--server') return []; // a URL — nothing we can offer

  const command = findCommand(prior);
  const candidates = command
    ? [...GLOBAL_FLAGS, ...(COMMAND_FLAGS[command] ?? [])]
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
