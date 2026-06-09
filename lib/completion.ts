export const SHELLS = ["bash", "zsh", "fish"] as const;
export type Shell = (typeof SHELLS)[number];

export function isShell(value: string): value is Shell {
  return (SHELLS as readonly string[]).includes(value);
}

/** Long flags jj-pr accepts, completed as bare words. */
const FLAGS = ["--revision", "--dry-run", "--help"];

function bashCompletion(): string {
  const flags = FLAGS.join(" ");
  return `# bash completion for jj-pr
# install: jj-pr completion bash > /etc/bash_completion.d/jj-pr
#      or: jj-pr completion bash >> ~/.bashrc
_jj_pr() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=( $(compgen -W "${flags}" -- "\${cur}") )
  return 0
}
complete -F _jj_pr jj-pr
`;
}

function zshCompletion(): string {
  return `#compdef jj-pr
# zsh completion for jj-pr
# install: jj-pr completion zsh > "\${fpath[1]}/_jj-pr"  (then restart zsh)
_jj-pr() {
  _arguments \\
    '(-r --revision)'{-r,--revision}'[Revision to process]:revset:' \\
    '--dry-run[Preview changes without applying them]' \\
    '(-h --help)'{-h,--help}'[Show help message]'
}
_jj-pr "$@"
`;
}

function fishCompletion(): string {
  return `# fish completion for jj-pr
# install: jj-pr completion fish > ~/.config/fish/completions/jj-pr.fish
complete -c jj-pr -s r -l revision -d 'Revision to process' -r
complete -c jj-pr -l dry-run -d 'Preview changes without applying them'
complete -c jj-pr -s h -l help -d 'Show help message'
`;
}

export function completionScript(shell: Shell): string {
  switch (shell) {
    case "bash":
      return bashCompletion();
    case "zsh":
      return zshCompletion();
    case "fish":
      return fishCompletion();
  }
}
