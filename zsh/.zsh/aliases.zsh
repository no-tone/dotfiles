# aliases.zsh — all aliases in one place

# --- File ops ---
alias cp='cp -iv'
alias mv='mv -iv'
alias rm='rm -i'
alias mkdir='mkdir -p'

# --- Navigation ---
alias ..='cd ..'
alias ...='cd ../..'
alias ~='cd ~'
alias -- -='cd -'

# --- Dotfiles ---
# Derive repo root from this file's real path if .zprofile didn't already set it.
: ${DOTFILES:="${${:-$HOME/.zsh/aliases.zsh}:A:h:h:h}"}
alias dot="cd $DOTFILES"
# No `doti` alias: it is a real binary on PATH now (installed to ~/.local/bin),
# and an alias here would shadow it. It used to point at scripts/install.sh,
# which no longer exists - so the alias survived the migration by one commit
# and broke the command it was meant to provide.
alias dotu="doti unlink"
# alias brewdump is gone — Brewfile is generated at install time from manifest.jsonc

# --- OpenCode ---
alias oc='opencode'
alias ocr='opencode run'

# --- Nvim ---
alias vim='nvim'

# --- Networking ---
alias myip='curl -s ifconfig.me'
alias ping='ping -c 5'

# --- Listing (eza handled in .zshrc) ---
if ! command -v eza &>/dev/null; then
  alias ll='ls -lah'
  alias la='ls -A'
  alias lt='ls -R'
  alias l1='ls -1'
fi

# --- System ---
alias df='df -h'
alias du='du -h -d 2'
alias free='vm_stat 2>/dev/null || free -h'
alias reload='exec zsh'
alias path='echo "$PATH" | tr : \\\n'
