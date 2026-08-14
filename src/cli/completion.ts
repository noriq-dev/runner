import { FILE_SENTINEL } from "./registry.js";

export function bashCompletion(): string {
  return `# eval "$(noriq-runner completion bash)"
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
}
