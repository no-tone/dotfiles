# Options
setopt auto_cd
setopt auto_pushd
setopt pushd_ignore_dups
setopt extended_glob
setopt interactivecomments
setopt auto_list
setopt auto_menu
setopt auto_param_slash
setopt notify

# History
HISTSIZE=100000
SAVEHIST=100000
HISTFILE="$HOME/.zsh_history"
setopt share_history
setopt hist_ignore_all_dups
setopt hist_reduce_blanks
setopt hist_ignore_space
setopt hist_verify

# Plugins (lightweight, no framework)
source_if_exists() { [ -f "$1" ] && source "$1"; }

source_if_exists "$HOME/.zsh/aliases.zsh"

# --- Tools init ---

# Orbstack (macOS)
source_if_exists "$HOME/.orbstack/shell/init.zsh"

# zoxide
if command -v zoxide &>/dev/null; then
  # ponytail: substring excludes — keep noise out of the db, no matching magic
  export _ZO_EXCLUDE_DIRS="/tmp:/var:/proc:/sys:/node_modules:/.git"
  export _ZO_MAXAGE=365   # drop entries unused for a year
  eval "$(zoxide init zsh)"
fi

# fzf — drive traversal with fd (respects .gitignore, includes dotfiles) and
# give it a consistent look. FZF_DEFAULT_COMMAND powers Ctrl-T and ** completion.
if command -v fzf &>/dev/null; then
  if command -v fd &>/dev/null; then
    export FZF_DEFAULT_COMMAND='fd --type f --hidden --strip-cwd-prefix --exclude .git'
    export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"
    export FZF_ALT_C_COMMAND='fd --type d --hidden --strip-cwd-prefix --exclude .git'
  fi
  export FZF_DEFAULT_OPTS='--height 40% --layout=reverse --border --info=inline'
  # File preview (Ctrl-T): syntax-highlighted contents via bat.
  # Directory preview (Alt-C): a quick tree via eza, falling back to ls.
  if command -v bat &>/dev/null; then
    export FZF_CTRL_T_OPTS="--preview 'bat --color=always --style=numbers --line-range :100 {}'"
  fi
  if command -v eza &>/dev/null; then
    export FZF_ALT_C_OPTS="--preview 'eza --tree --level=2 --color=always {}'"
  else
    export FZF_ALT_C_OPTS="--preview 'ls -la {}'"
  fi
  eval "$(fzf --zsh)" 2>/dev/null || source <(fzf --zsh 2>/dev/null)
fi

# starship prompt
if command -v starship &>/dev/null; then
  eval "$(starship init zsh)"
fi

# --- Tool aliases ---

# eza (modern ls). --icons=auto (not bare --icons): eza >=0.19 requires an
# explicit value and errors out on any invocation with a path argument otherwise.
if command -v eza &>/dev/null; then
  alias ls='eza --icons=auto'
  alias ll='eza -la --icons=auto'
  alias la='eza -a --icons=auto'
  alias lt='eza -T --icons=auto'
  alias l1='eza -1 --icons=auto'
fi

# bat (modern cat)
if command -v bat &>/dev/null; then
  alias c='bat'
fi

# fd (modern find)
if command -v fd &>/dev/null; then
  alias fdi='fd --hidden --no-ignore'
fi

# ripgrep defaults (smart-case, etc.) live in ~/.config/ripgrep/config via
# RIPGREP_CONFIG_PATH (set in .zprofile), so they apply to every rg invocation
# — including calls from fzf, telescope, and scripts — on every platform.

# Git
alias gs='git status'
alias gc='git commit'
alias gp='git push'
alias gl='git log --oneline --graph'
alias gd='git diff'
alias ga='git add'

# --------------------------------------------------
# Better command-line editing
# --------------------------------------------------

bindkey -e

# Cursor style (bar/line, not block)
zle-line-init() { echo -ne '\e[5 q'; }
zle -N zle-line-init

# Word navigation
bindkey '^[f' forward-word
bindkey '^[b' backward-word

# Home / End
bindkey '^[[H' beginning-of-line
bindkey '^[[F' end-of-line

# macOS Terminal / Ghostty variants
bindkey '^[[1~' beginning-of-line
bindkey '^[[4~' end-of-line

# Delete word
bindkey '^H' backward-delete-char
bindkey '^[d' kill-word
bindkey '^[[3;5~' kill-word

# Ctrl+Left / Ctrl+Right
bindkey '^[[1;5D' backward-word
bindkey '^[[1;5C' forward-word
bindkey '^[[5D' backward-word
bindkey '^[[5C' forward-word

# Option+Left / Option+Right (macOS)
bindkey '^[^[[D' backward-word
bindkey '^[^[[C' forward-word

# Ctrl+A / Ctrl+E
bindkey '^A' beginning-of-line
bindkey '^E' end-of-line

# Ctrl+Backspace
bindkey '^?' backward-delete-char

# --------------------------------------------------
# Shift-select (plugin — handles all shift+arrow bindings)
# --------------------------------------------------
source_if_exists "$HOME/.zsh/plugins/zsh-shift-select/zsh-shift-select.plugin.zsh"

# Menu completion
zstyle ':completion:*' menu select

# compinit is the usual zsh startup-latency culprit — it security-scans and
# rebuilds the dump on every launch. Rebuild at most once a day; otherwise trust
# the cached dump (-C skips the scan).
autoload -Uz compinit
if [[ -n ${ZDOTDIR:-$HOME}/.zcompdump(#qN.mh+24) ]]; then
  compinit
else
  compinit -C
fi

# --- Plugins (Homebrew, no framework) ---
# fish-style autosuggestions + syntax highlighting. Sourced last so highlighting
# wraps every widget defined above. Paths cover Apple Silicon / Intel / Linux.
for _pfx in /opt/homebrew /usr/local /home/linuxbrew/.linuxbrew; do
  source_if_exists "$_pfx/share/zsh-autosuggestions/zsh-autosuggestions.zsh" && break
done
for _pfx in /opt/homebrew /usr/local /home/linuxbrew/.linuxbrew; do
  source_if_exists "$_pfx/share/zsh-fast-syntax-highlighting/fast-syntax-highlighting.plugin.zsh" && break
  source_if_exists "$_pfx/opt/zsh-fast-syntax-highlighting/share/zsh-fast-syntax-highlighting/fast-syntax-highlighting.plugin.zsh" && break
done
unset _pfx

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# bun completions
[ -s "$BUN_INSTALL/_bun" ] && source "$BUN_INSTALL/_bun"
